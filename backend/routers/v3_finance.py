import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from typing import Optional

from database import v3_col
from constants import BRANCH_BLOCKED_EXPENSE_CATEGORIES
from physio_scope import physio_owns_lead, resolve_physio_doctor
from deps import v3_require_roles, is_branch_admin_role, is_physio_role
from schemas.v3 import V3UserOut, V3MarkInstallmentPaidInput
from stage_utils import entry_branch_stage_names
from utils import generate_transaction_id
# An installment is the Treatment Fee arriving in pieces, so it is counted under exactly
# the rules the fee itself is -- imported rather than copied. v3_fitness.py and
# v3_zumba.py already each carry their own copy of this counter; a fourth would be a
# fourth place for the note list and the must-agree rule to drift apart.
from routers.v3_packages import _notes_label, _settle_cash_count, _denomination_total


def _now():
    return datetime.now(timezone.utc).isoformat()


# Every default vertical is named "online_.../offline_..." — same helper as
# _is_online_vertical in v3_dashboard.py, read off the same prefix.
def _is_online_vertical(vertical) -> bool:
    return str(vertical or "").startswith("online_")


# What one tender in a split installment is allowed to be. The same four the Treatment
# Fee itself splits across in v3_packages.py: money that settles today, which a cheque
# does not.
SPLIT_TENDER_MODES = ("cash", "upi", "card", "account_transfer")


router = APIRouter(prefix="/api/v3")


def _revenue_by_branch(lead: dict) -> list:
    """One row per branch that has taken money from this patient, oldest first.

    A patient who has never moved yields exactly one row — their branch, their whole total
    — which is what every reader of this file saw before transfers existed. A transferred
    one yields the branch they left holding what it had taken by the day they left, and
    their current branch holding whatever has come in since.

    `revenue_branch_splits` records running totals as they stood at each transfer, not the
    amount that branch took, so each row is the difference from the one before it. Storing
    the running total is what makes it safe against a fee corrected after the fact: the
    next split still knows where the previous one ended.

    Clamped at zero because a refund or a correction can lower a total below what an
    earlier split recorded, and a negative row would quietly credit it to the wrong branch.
    """
    splits = lead.get("revenue_branch_splits") or []
    rows = []
    seen_consultation = 0.0
    seen_package = 0.0
    for split in splits:
        at_consultation = split.get("consultation_fee") or 0
        at_package = split.get("package_paid") or 0
        rows.append({
            "branch_id": split.get("branch_id"),
            "consultation_fee": max(0.0, at_consultation - seen_consultation),
            "package_paid": max(0.0, at_package - seen_package),
        })
        seen_consultation = at_consultation
        seen_package = at_package
    rows.append({
        "branch_id": lead.get("branch_id"),
        "consultation_fee": max(0.0, (lead.get("consultation_fee") or 0) - seen_consultation),
        "package_paid": max(0.0, (lead.get("package_paid") or 0) - seen_package),
    })
    return [r for r in rows if r["branch_id"]]


def _branch_at(lead: dict, when: str) -> str:
    """Which branch this patient was at on a given date.

    For putting a collection on the right branch's row in the transactions list. Walks the
    transfer history rather than reading branch_id, which only ever answers "now".
    """
    for move in (lead.get("branch_transfer_history") or []):
        if when and move.get("at") and when < move["at"]:
            return move.get("from_branch_id") or ""
    return lead.get("branch_id") or ""


@router.get("/branch/finance")
async def get_branch_finance(
    fee_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    search: Optional[str] = None,
    branch_id: Optional[str] = None,
    # "online" | "offline" — filtered off each lead's own vertical, same split as
    # Branches & Verticals' own mode pills. Accountant's Summary tab.
    mode: Optional[str] = None,
    # Approvals tab: pass False to see what still needs review, True for what's
    # cleared. Left unset for Summary, which shows every collection either way.
    approved: Optional[bool] = None,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "business_dev")),
):
    # Branch Admin is always locked to their own branch. Super Admin and Accountant can
    # optionally scope to one branch_id — or, if none is passed, see every branch
    # aggregated together (Accountant's default view: all branches' finance at once).
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
        if not branch_id:
            return {"summary": {}, "transactions": []}

    # A branch's book has to keep the patients it no longer has. Money is attributed to
    # the branch that collected it (see _revenue_by_branch), so a patient transferred away
    # still belongs in the accounts of the branch that treated and charged them — and a
    # query reading branch_id alone would have dropped them the moment they moved.
    base_query = {"$or": [
        {"branch_id": branch_id},
        {"revenue_branch_splits.branch_id": branch_id},
    ]} if branch_id else {}
    if mode in ("online", "offline"):
        base_query["vertical"] = {"$regex": f"^{mode}_"}

    all_branch_leads = await v3_col("leads").find(base_query, {"_id": 0}).to_list(2000)
    # Both modes' entry stages, since this list spans branches under either Lead Control —
    # a lead still sitting where it landed hasn't been worked yet and owes nothing.
    untouched_stages = {None} | await entry_branch_stage_names()
    # Current patients only. A patient this branch transferred away still owes it nothing
    # — whatever they have not paid is the receiving branch's to collect.
    here_now = [l for l in all_branch_leads if not branch_id or l.get("branch_id") == branch_id]
    leads_with_no_fee = [l for l in here_now if (l.get("consultation_fee") or 0) == 0 and l.get("branch_stage") not in untouched_stages]
    pending_count = len(leads_with_no_fee)

    # Per-branch breakdown — only meaningfully populated when viewing more than one
    # branch at once (Accountant's default, or Super Admin leaving branch_id unset),
    # but cheap to compute always since all_branch_leads is already in memory.
    # Every branch either holding one of these patients now or having taken money from
    # one of them before — both need a name for the rows below.
    lead_revenue = {l["id"]: _revenue_by_branch(l) for l in all_branch_leads}
    branch_ids = list(
        {l["branch_id"] for l in all_branch_leads if l.get("branch_id")}
        | {row["branch_id"] for rows in lead_revenue.values() for row in rows}
    )
    branch_docs = await v3_col("branches").find(
        {"id": {"$in": branch_ids}}, {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    by_branch_acc = {}

    def _acc(bid):
        return by_branch_acc.setdefault(bid, {
            "branch_id": bid,
            "branch_name": branch_name_map.get(bid, "Unknown"),
            "consultation_total": 0.0,
            "package_total": 0.0,
            "consultation_count": 0,
            "package_count": 0,
            "total_patients": 0,
        })

    for l in all_branch_leads:
        # Patients are counted where they are; money is counted where it was taken. The two
        # part company the moment somebody is transferred, and conflating them is how a
        # branch's revenue follows a patient out of the door.
        if l.get("branch_id"):
            _acc(l["branch_id"])["total_patients"] += 1
        for row in lead_revenue[l["id"]]:
            acc = _acc(row["branch_id"])
            acc["consultation_total"] += row["consultation_fee"]
            acc["package_total"] += row["package_paid"]
            if row["consultation_fee"] > 0:
                acc["consultation_count"] += 1
            if row["package_paid"] > 0:
                acc["package_count"] += 1
    by_branch = sorted(by_branch_acc.values(), key=lambda r: -(r["consultation_total"] + r["package_total"]))
    for r in by_branch:
        r["total_revenue"] = r["consultation_total"] + r["package_total"]

    # The cards at the top are this scope's own row, or every row added up when no branch
    # was asked for. Taken from the same accumulation as the breakdown rather than summed
    # separately, so the two can never disagree about what a branch earned.
    if branch_id:
        scope = by_branch_acc.get(branch_id) or _acc(branch_id)
        total_consultation = scope["consultation_total"]
        total_package = scope["package_total"]
        consultation_count = scope["consultation_count"]
        package_count = scope["package_count"]
    else:
        total_consultation = sum(r["consultation_total"] for r in by_branch)
        total_package = sum(r["package_total"] for r in by_branch)
        consultation_count = sum(r["consultation_count"] for r in by_branch)
        package_count = sum(r["package_count"] for r in by_branch)

    summary = {
        "total_revenue": total_consultation + total_package,
        "consultation_total": total_consultation,
        "consultation_count": consultation_count,
        "package_total": total_package,
        "package_count": package_count,
        "pending_count": pending_count,
        "total_patients": len(here_now),
        "by_branch": by_branch,
    }

    # package_sold (sell_package's own action, set the moment a package is assigned at a
    # negotiated price — no transaction_id or payment_mode, unlike package_payment_collected)
    # belongs in this list too: leads whose package_paid only ever came from that flow would
    # otherwise count in the cards above and never appear as a row below.
    activity_query = {"action": {"$in": ["consultation_paid", "package_payment_collected", "package_sold"]}}
    lead_ids = [l["id"] for l in all_branch_leads]
    # Applied whenever a branch or a mode was asked for, empty list included. Guarding this
    # on "if lead_ids" dropped the filter for a scope with nobody in it instead of matching
    # nothing -- so a branch with no leads reported every payment in the company as its own.
    # The guard existed to skip a needless $in over every lead when nothing was scoped,
    # which is the one case it should still skip.
    if base_query:
        activity_query["lead_id"] = {"$in": lead_ids}

    activities = await v3_col("lead_activity").find(activity_query, {"_id": 0}).sort("created_at", -1).to_list(2000)

    lead_map = {l["id"]: l for l in all_branch_leads}

    transactions = []
    for act in activities:
        lead = lead_map.get(act.get("lead_id"), {})
        details = act.get("details", "")

        # A transferred patient is in this list for the money they paid here, not for the
        # money they have paid since. Their later collections belong to the branch that
        # took them, and without this every branch a patient has ever passed through would
        # show every receipt they ever got.
        if branch_id and _branch_at(lead, act.get("created_at", "")) != branch_id:
            continue

        is_consultation = "consultation" in details.lower()
        is_package = "package" in details.lower()

        amount = _parse_rs_amount(details)
        weeks = None

        if "weeks" in details.lower():
            try:
                weeks_part = details.split("(")[1].split("weeks")[0].strip() if "(" in details else ""
                weeks = int(weeks_part)
            except (IndexError, ValueError):
                pass

        tx_type = "package" if is_package else "consultation"

        if fee_type and fee_type != "all" and tx_type != fee_type:
            continue

        if start_date and act.get("created_at", "") < start_date:
            continue
        if end_date and act.get("created_at", "") > end_date + "T23:59:59":
            continue

        if search:
            q = search.lower()
            name = lead.get("name", "").lower()
            phone = lead.get("phone", "").lower()
            if q not in name and q not in phone:
                continue

        is_approved = bool(act.get("approved"))
        if approved is not None and is_approved != approved:
            continue

        transactions.append({
            "id": act.get("id", ""),
            # The readable id printed on the patient's receipt. Empty on collections taken
            # before this existed, so every reader has to tolerate a blank.
            "transaction_id": act.get("transaction_id") or "",
            "lead_id": act.get("lead_id", ""),
            "patient_name": lead.get("name", "Unknown"),
            "patient_phone": lead.get("phone", ""),
            "fee_type": tx_type,
            "amount": amount,
            "package_weeks": weeks,
            # "cash" | "upi" | "card" | "cheque" | "account_transfer" | "unknown" — parsed
            # off the same "... via X" wording every collection flow writes into details.
            # package_sold carries none (see the comment on activity_query above), so it
            # reads back "unknown" like any other untagged row.
            "payment_mode": _parse_payment_mode(details),
            "collected_by": act.get("created_by", ""),
            "collected_at": act.get("created_at", ""),
            "branch_stage": lead.get("branch_stage", ""),
            # The branch this patient was at on the day the money came in, not the one
            # they are at now — a transferred patient's old receipts belong to the branch
            # that issued them.
            "branch_name": branch_name_map.get(_branch_at(lead, act.get("created_at", "")), ""),
            "vertical": lead.get("vertical", ""),
            # Whether the Accountant has cleared this collection — set only via
            # POST /finance/transactions/{id}/approve, never at collection time, so a
            # branch's own book never reads as pre-approved before anyone reviewed it.
            **_approval_state(act),
        })

    approved_total = sum(t["amount"] for t in transactions if t["approved"])
    pending_approval = [t for t in transactions if not t["approved"]]
    summary["approved_total"] = approved_total
    summary["pending_approval_total"] = sum(t["amount"] for t in pending_approval)
    summary["pending_approval_count"] = len(pending_approval)

    # Same window as the transactions list above (fee_type/date/search/approved already
    # applied), so the Income tab's Cash/Cheque/Bank/UPI tiles always add up to the total
    # it's showing rather than some wider, unfiltered figure.
    payment_modes = {}
    for t in transactions:
        payment_modes[t["payment_mode"]] = payment_modes.get(t["payment_mode"], 0.0) + t["amount"]
    summary["payment_modes"] = payment_modes

    return {"summary": summary, "transactions": transactions}


class ApproveTransactionInput(BaseModel):
    # What the Approve popup asks for is chosen by the row's own payment mode: Cash asks
    # to re-enter the amount, Bank Transfer/UPI ask for the transaction/UTR reference,
    # Cheque asks for the cheque number. Stored as typed — an independent, manual
    # re-check by whoever approves, not a re-parse of what the collector already
    # recorded. All optional: a row with no recognised payment mode (package_sold,
    # store sales with no mode) can still be approved with nothing to confirm against.
    confirmed_amount: Optional[float] = None
    transaction_ref: Optional[str] = None
    cheque_number: Optional[str] = None


# The four books a collection can be written in. Store sales carry no lead, and Zumba and
# Fitness keep their money on the registration -- so a payment has to be looked for in all
# four, in this order, by anything that writes to one. Named once here because approve,
# unapprove and the request step below each used to carry their own copy of the ladder,
# and a fifth desk taking money would have had to be remembered in three places.
TRANSACTION_COLLECTIONS = ("lead_activity", "inventory_movements", "zumba_registrations", "fitness_registrations")


async def _update_transaction_row(activity_id: str, update: dict) -> bool:
    """Apply one update to whichever book this payment is written in. False if none has it."""
    for name in TRANSACTION_COLLECTIONS:
        res = await v3_col(name).update_one({"id": activity_id}, update)
        if res.matched_count:
            return True
    return False


def _approval_state(row: dict) -> dict:
    """Where one collection stands between the desk that took it and the books.

    Three states, and the middle one is the point of this: a payment is *collected* the
    moment the money is handed over, *requested* when the branch sends it up to be signed
    off, and *approved* when the accountant signs it. Collected-but-not-sent used to be
    indistinguishable from sent-and-waiting, so the accountant's queue held every payment
    the moment it was taken and a branch had no way to say "this day is ready to check".

    Read off the record itself, like `approved` always was -- see approve_transaction.
    """
    return {
        "approved": bool(row.get("approved")),
        "approved_by": row.get("approved_by") or "",
        "approved_at": row.get("approved_at") or "",
        "income_requested": bool(row.get("income_requested")),
        "income_requested_by": row.get("income_requested_by") or "",
        "income_requested_at": row.get("income_requested_at") or "",
    }


class TransactionRequestInput(BaseModel):
    # The collections being sent up, by id. A list rather than one at a time because a
    # branch closes a day, not a payment -- sending forty of them one request each is
    # forty chances to send thirty-nine.
    activity_ids: list = []


@router.post("/finance/transactions/request")
async def request_transactions(
    payload: TransactionRequestInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "business_dev")),
):
    """Send collections up for approval.

    This is the step the branch owns. Approval is somebody else's -- see
    approve_transaction -- so raising and signing off stay two different endpoints with two
    different role lists, and a Branch Admin can reach only this one.

    An Accountant used to be on this list too, because the tab the button lives on
    (branch/AccountantManageTab.jsx) is the same component in all three chairs and the
    role list was widened to match rather than the button being hidden in one of them.
    That let the desk these collections are sent *to* send them to itself. The button is
    gone from the Accountant's copy now (canSend), and the role goes with it: an
    Accountant signs off, and does not raise what they then sign.

    Already-approved rows are left alone rather than refused: sending a day up again after
    adding one late payment to it should move the late payment, not fail on the thirty
    beside it that have already been through.
    """
    ids = [i for i in (payload.activity_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="Pick at least one collection to send")
    update = {"$set": {
        "income_requested": True,
        "income_requested_by": user.full_name,
        "income_requested_at": _now(),
    }}
    sent, missing = 0, 0
    for activity_id in ids:
        if await _update_transaction_row(activity_id, update):
            sent += 1
        else:
            missing += 1
    if not sent:
        raise HTTPException(status_code=404, detail="None of those collections could be found")
    return {
        "message": f"{sent} collection{'' if sent == 1 else 's'} sent to the accountant",
        "sent": sent,
        "not_found": missing,
    }


@router.post("/finance/transactions/unrequest")
async def unrequest_transactions(
    payload: TransactionRequestInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "business_dev")),
):
    """Pull a collection back before it has been signed off.

    Kept to the same role list as sending, Accountant's removal from it included, because
    it is the same act undone -- a branch that sent the wrong day up needs to be able to
    take it back without asking the person it was sent to. Rows already approved are not pulled back: that is an approval to
    undo, and unapprove_transaction is the endpoint that says so.
    """
    ids = [i for i in (payload.activity_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="Pick at least one collection to pull back")
    update = {"$set": {"income_requested": False}, "$unset": {"income_requested_by": "", "income_requested_at": ""}}
    pulled = 0
    for activity_id in ids:
        for name in TRANSACTION_COLLECTIONS:
            res = await v3_col(name).update_one({"id": activity_id, "approved": {"$ne": True}}, update)
            if res.matched_count:
                pulled += 1
                break
    return {
        "message": f"{pulled} collection{'' if pulled == 1 else 's'} pulled back",
        "pulled": pulled,
    }


@router.post("/finance/transactions/{activity_id}/approve")
async def approve_transaction(
    activity_id: str,
    payload: ApproveTransactionInput = ApproveTransactionInput(),
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Accountant's Approvals tab: marks one collected payment reviewed. Written onto
    the record itself (approved/approved_by/approved_at, plus whatever confirmation the
    popup collected) rather than a separate collection, since every reader — Summary
    (get_branch_finance), revenue_overview, /finance/approvals, this endpoint — already
    keys off its id and needs no second lookup to know a row's approval state. Tried
    against lead_activity first, then inventory_movements (Store sales carry no lead),
    since /finance/approvals lists rows from both. Branch Admin cannot approve:
    approval exists to have someone other than whoever collected it sign off.
    """
    update = {"approved": True, "approved_by": user.full_name, "approved_at": _now()}
    if payload.confirmed_amount is not None:
        update["approval_confirmed_amount"] = payload.confirmed_amount
    if payload.transaction_ref:
        update["approval_transaction_ref"] = payload.transaction_ref.strip()
    if payload.cheque_number:
        update["approval_cheque_number"] = payload.cheque_number.strip()

    if not await _update_transaction_row(activity_id, {"$set": update}):
        raise HTTPException(status_code=404, detail="Transaction not found")
    return {"message": "Approved"}


class BulkApproveInput(BaseModel):
    # The payments being signed off, by id. Separate from TransactionRequestInput despite
    # the identical shape: that one raises a day, this one signs it off, and the two are
    # deliberately different endpoints with different role lists -- see
    # request_transactions. A model shared between them would be one edit away from
    # sharing a role list too.
    activity_ids: list = []


@router.post("/finance/transactions/bulk-approve")
async def bulk_approve_transactions(
    payload: BulkApproveInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Sign off a whole selection at once, for a queue that arrives hundreds deep.

    WHAT THIS GIVES UP, stated plainly because it is the point of the endpoint: the
    one-at-a-time approve above asks the accountant to re-key something against the row's
    own payment mode -- the amount for cash, the UTR for a transfer, the number on the
    cheque -- and stores it as an independent second reading. Nothing here can ask that
    two hundred times, so these rows are approved carrying who and when and nothing to
    check against. It is a weaker signature than the popup's, and the caller should say so
    before it is used. Rows needing that check should go through approve_transaction.

    update_many per book rather than the per-id ladder request_transactions walks: that
    one is fine for a day's forty, but four hundred ids times four collections is sixteen
    hundred round trips for work Mongo will do in four.

    Already-approved rows are passed over rather than re-stamped, so an approval keeps the
    name and time of whoever actually gave it -- the same rule request_transactions
    follows for rows already sent up.
    """
    ids = [i for i in (payload.activity_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="Pick at least one payment to approve")
    # The ceiling /finance/approvals reads to, so nothing can be asked for here that the
    # tab it is driven from could not have listed in the first place.
    if len(ids) > 5000:
        raise HTTPException(status_code=400, detail="Too many payments in one go")

    update = {"$set": {"approved": True, "approved_by": user.full_name, "approved_at": _now()}}
    approved = 0
    for name in TRANSACTION_COLLECTIONS:
        res = await v3_col(name).update_many({"id": {"$in": ids}, "approved": {"$ne": True}}, update)
        approved += res.modified_count

    # Not a 404 when nothing moved: with every picked row already approved -- two
    # accountants on the same queue -- there is nothing wrong to report, only nothing
    # left to do.
    skipped = len(ids) - approved
    return {
        "message": f"{approved} payment{'' if approved == 1 else 's'} approved",
        "approved": approved,
        "skipped": skipped,
    }


@router.post("/finance/transactions/{activity_id}/unapprove")
async def unapprove_transaction(
    activity_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Undoes an approval taken by mistake. Clears who/when/confirmation rather than
    leaving them on a row that is, again, unreviewed. Same collections as approve, tried in
    the same order."""
    unset = {"approved_by": "", "approved_at": "", "approval_confirmed_amount": "", "approval_transaction_ref": "", "approval_cheque_number": ""}
    update = {"$set": {"approved": False}, "$unset": unset}
    if not await _update_transaction_row(activity_id, update):
        raise HTTPException(status_code=404, detail="Transaction not found")
    return {"message": "Approval removed"}


# The fields each lead payment action writes, so deleting the payment can take them off
# the lead again. The five scheduled fees come from FEE_SCHEDULES (defined further down,
# read at call time); these are the three that carry no schedule.
_UNSCHEDULED_PAYMENT_FIELDS = {
    "consultation_paid": ["consultation_fee", "consultation_payment_mode"],
    "package_sold": ["package_paid", "package_payment_mode", "package_payment_details"],
}


def _payment_fields(row: dict) -> list:
    action = row.get("action")
    for cfg in FEE_SCHEDULES.values():
        if cfg["action"] == action:
            return [cfg["paid"], cfg["mode"], cfg["details"]]
    if action == "fee_collected":
        # The old collect-fee endpoint: "Consultation fee collected" or "Package fee ...".
        return ["consultation_fee"] if (row.get("details") or "").lower().startswith("consultation") else ["package_amount"]
    return _UNSCHEDULED_PAYMENT_FIELDS.get(action, [])


async def _reverse_lead_payment(row: dict, user: V3UserOut) -> str:
    """Take one fee's payment off a patient, so Branch Admin sees it owed again.

    A fee is one set of fields on the lead (paid, mode, schedule), however many activity
    rows it took to get there -- a first collection, a correction, installments. So the
    fee is reset whole, and every payment row of that fee for this patient goes with it;
    leaving the others would list money the lead no longer says it has.

    The consultation stage steps back too when the fee it stood on is gone: Fee Collected
    needs a consultation or treatment fee paid, and Physio Assign a treatment fee.
    """
    lead_id, action = row.get("lead_id"), row.get("action")
    fields = _payment_fields(row)
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0}) if lead_id else None
    removed = await v3_col("lead_activity").delete_many({"lead_id": lead_id, "action": action}) if lead_id else None
    if not removed or not removed.deleted_count:
        await v3_col("lead_activity").delete_one({"id": row["id"]})
    if not lead:
        return "Payment deleted"

    update = {f: None for f in fields}
    after = {**lead, **update}
    stage = lead.get("consultation_stage")
    has_consult = after.get("package_paid") is not None
    has_treatment = after.get("treatment_fee_paid") is not None
    if stage == "Physio Assign" and not has_treatment:
        update["consultation_stage"] = "Fee Collected" if has_consult else "Consultation Visit"
    elif stage == "Fee Collected" and not has_consult and not has_treatment:
        update["consultation_stage"] = "Consultation Visit"
    update["updated_at"] = _now()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": update})

    label = PAYMENT_ACTION_LABELS.get(action, "Payment")
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "payment_deleted",
        "details": f"{label} payment deleted by {user.full_name} from the Accountant's Approvals -- the fee is owed again",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    return f"{label} deleted -- {lead.get('name') or 'the patient'} owes it again"


@router.delete("/finance/transactions/{activity_id}")
async def delete_transaction(
    activity_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Delete one collected payment from the Approvals tab, for clearing demo and testing
    money. Behind the same Developer Access switch as the expense bin.

    Undone at the source, not only hidden: a patient's fee reads owed again, a store sale's
    quantity goes back on the shelf, and a Zumba or Fitness registration keeps its fee and
    term with nothing paid against it -- the same reset reset-all-payments does, for one.
    """
    if not await expense_delete_enabled():
        raise HTTPException(status_code=403, detail="Delete is switched off in Developer Access")

    row = await v3_col("lead_activity").find_one({"id": activity_id, "action": {"$in": REVENUE_ACTIONS}}, {"_id": 0})
    if row:
        return {"message": await _reverse_lead_payment(row, user)}

    sale = await v3_col("inventory_movements").find_one({"id": activity_id, "kind": "sale"}, {"_id": 0})
    if sale:
        from routers.v3_inventory import _add_to_stock
        item = await v3_col("inventory_items").find_one({"id": sale.get("item_id")}, {"_id": 0, "id": 1})
        qty = int(sale.get("qty") or 0)
        if item and sale.get("branch_id") and qty > 0:
            await _add_to_stock(sale["item_id"], sale["branch_id"], qty)
        await v3_col("inventory_movements").delete_one({"id": activity_id})
        return {"message": "Store sale deleted -- the stock is back on the shelf"}

    unset = {
        "approved_by": "", "approved_at": "",
        "approval_confirmed_amount": "", "approval_transaction_ref": "", "approval_cheque_number": "",
        "income_requested_by": "", "income_requested_at": "",
    }
    cleared = {"fee_paid": 0.0, "payment_mode": "", "payment_reference": "", "payment_lines": [], "approved": False, "income_requested": False}
    res = await v3_col("zumba_registrations").update_one({"id": activity_id}, {"$set": cleared, "$unset": unset})
    if res.matched_count:
        return {"message": "Zumba payment deleted -- the fee is owed again"}
    res = await v3_col("fitness_registrations").update_one({"id": activity_id}, {"$set": {**cleared, "payments": []}, "$unset": unset})
    if res.matched_count:
        return {"message": "Fitness payment deleted -- the fee is owed again"}
    raise HTTPException(status_code=404, detail="Payment not found")


@router.get("/finance/approvals")
async def finance_approvals(
    branch_id: Optional[str] = None,
    mode: Optional[str] = None,  # "online" | "offline", off each lead's/branch's own vertical
    category: Optional[str] = None,  # "consultation" | "session" | "diet" | "store" | "other"
    # "cash" | "upi" | "card" | "account_transfer" | "cheque" — same set a Branch Admin
    # picks from when collecting a fee (V3MarkInstallmentPaidInput.payment_mode and its
    # siblings across v3_packages.py).
    payment_mode: Optional[str] = None,
    approved: Optional[bool] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "business_dev")),
):
    """Accountant's Approvals tab. Every kind of collection revenue_overview counts
    (REVENUE_ACTIONS, plus Store sales) rather than just get_branch_finance's narrower
    consultation/package set — "new income collected" means all of it, not only two of
    its five sources. A dedicated query rather than reusing revenue_overview's own
    transactions: that endpoint's list feeds Payment Paid/Unpaid and Outstanding too,
    and filtering it here by approval state would silently drop rows out of those.
    """
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id

    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1}).to_list(500)
    branch_map = {b["id"]: b for b in branch_docs}
    # Whose account a UPI payment landed in, for the rows that recorded one. Read once for
    # the whole list -- see _upi_account_map.
    upi_accounts = await _upi_account_map()

    def _reference_of(details: str) -> dict:
        """The row's payment reference, with the company account named rather than left as
        a handle. A desk checking a UPI collection is looking for "Kiruthika R · HDFC
        ****4321", not for "fitsio@okhdfc" on its own."""
        ref = _parse_payment_reference(details)
        account = upi_accounts.get((ref.get("receiver_upi_id") or "").lower())
        if account:
            ref.update(account)
        split = _parse_payment_split(details)
        if split:
            ref["split"] = split
        return ref

    mode_branch_ids = None
    if mode in ("online", "offline"):
        mode_branch_ids = {bid for bid, b in branch_map.items() if _is_online_vertical(b.get("vertical")) == (mode == "online")}
        if branch_id and branch_id not in mode_branch_ids:
            return {"transactions": [], "summary": {"pending_count": 0, "pending_total": 0.0, "approved_count": 0, "approved_total": 0.0}}

    lead_query = {"branch_id": branch_id} if branch_id else {}
    leads = await v3_col("leads").find(lead_query, {"_id": 0, "id": 1, "name": 1, "phone": 1, "branch_id": 1}).to_list(20000)
    if mode_branch_ids is not None:
        leads = [l for l in leads if l.get("branch_id") in mode_branch_ids]
    lead_ids = [l["id"] for l in leads]
    lead_map = {l["id"]: l for l in leads}

    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date + "T23:59:59"

    rows = []
    # Whether the caller narrowed to particular leads at all (a branch and/or a
    # vertical). Unscoped, activity_query has no lead_id clause and reads every lead's
    # activity. Scoped with zero matching leads, nothing can match either — skipped
    # rather than querying with an empty $in, which Mongo would (correctly) also match
    # nothing on, but only after the round trip.
    scoped = bool(branch_id) or mode_branch_ids is not None
    if not (scoped and not lead_ids):
        activity_query = {"action": {"$in": REVENUE_ACTIONS}}
        if scoped:
            activity_query["lead_id"] = {"$in": lead_ids}
        if date_query:
            activity_query["created_at"] = date_query
        activities = await v3_col("lead_activity").find(activity_query, {"_id": 0}).sort("created_at", -1).to_list(5000)

        for act in activities:
            lead = lead_map.get(act.get("lead_id"), {})
            cat = _revenue_category(act.get("action", ""))
            if category and category not in ("all", "") and cat != category:
                continue
            is_approved = bool(act.get("approved"))
            details = act.get("details", "")
            pm = _parse_payment_mode(details)
            if payment_mode and payment_mode not in ("all", "") and pm != payment_mode:
                continue
            rows.append({
                "id": act.get("id", ""),
                "lead_id": act.get("lead_id", ""),
                "patient_name": lead.get("name", "Unknown"),
                "patient_phone": lead.get("phone", ""),
                "branch_id": lead.get("branch_id"),
                "branch_name": branch_map.get(lead.get("branch_id"), {}).get("branch_name", ""),
                "category": cat,
                "amount": _parse_rs_amount(details),
                "payment_mode": pm,
                # What this payment can be checked against, beyond its mode. Cash carries
                # none and says so by being empty -- see _parse_payment_reference.
                "payment_ref": _reference_of(details),
                "collected_by": act.get("created_by", ""),
                "collected_at": act.get("created_at", ""),
                "approved": is_approved,
                "approved_by": act.get("approved_by") or "",
                "approved_at": act.get("approved_at") or "",
            })

    if category in (None, "", "all", "store"):
        store_query = {"kind": "sale"}
        if branch_id:
            store_query["branch_id"] = branch_id
        if date_query:
            store_query["created_at"] = date_query
        store_sales = await v3_col("inventory_movements").find(store_query, {"_id": 0}).to_list(5000)
        for sale in store_sales:
            bid = sale.get("branch_id")
            if mode_branch_ids is not None and bid not in mode_branch_ids:
                continue
            is_approved = bool(sale.get("approved"))
            pm = sale.get("payment_mode") or "unknown"
            if payment_mode and payment_mode not in ("all", "") and pm != payment_mode:
                continue
            rows.append({
                "id": sale.get("id", ""),
                "lead_id": "",
                "patient_name": (sale.get("customer_name") or "").strip() or "Counter sale",
                "patient_phone": "",
                "branch_id": bid,
                "branch_name": branch_map.get(bid, {}).get("branch_name", ""),
                "category": "store",
                "amount": float(sale.get("amount") or 0),
                "payment_mode": pm,
                # A counter sale records the tender and nothing to trace it by -- the sell
                # popup asks for no reference at all -- so this is empty rather than
                # pretending the row has one.
                "payment_ref": {},
                "collected_by": sale.get("by_user_name", ""),
                "collected_at": sale.get("created_at", ""),
                "approved": is_approved,
                "approved_by": sale.get("approved_by") or "",
                "approved_at": sale.get("approved_at") or "",
            })

    # Zumba class fees. Collected onto the registration rather than through the lead
    # fee machinery -- see revenue_overview's own zumba loop for why -- and this tab
    # reads lead_activity and store sales, so until now every rupee of class money was
    # counted as revenue that nobody could sign off: it appeared in the Total and in
    # no approval queue, approved or pending.
    if category in (None, "", "all", "zumba"):
        zumba_query = {}
        if branch_id:
            zumba_query["branch_id"] = branch_id
        if date_query:
            zumba_query["created_at"] = date_query
        regs = await v3_col("zumba_registrations").find(zumba_query, {"_id": 0}).to_list(5000)
        for reg in regs:
            bid = reg.get("branch_id")
            if mode_branch_ids is not None and bid not in mode_branch_ids:
                continue
            # fee_paid, not fee_amount, and nothing to review when it is zero: a
            # registration with no money on it yet is the Zumba tab's business, not
            # this one's. Same rule revenue_overview counts by.
            amount = float(reg.get("fee_paid") or 0)
            if amount <= 0:
                continue
            is_approved = bool(reg.get("approved"))
            pm = reg.get("payment_mode") or "unknown"
            if payment_mode and payment_mode not in ("all", "") and pm != payment_mode:
                continue
            rows.append({
                "id": reg.get("id", ""),
                # No lead behind a class fee -- the dancer is a registration, not a
                # patient -- so this stays empty rather than faked, the same way a
                # counter sale's does.
                "lead_id": "",
                "patient_name": (reg.get("name") or "").strip() or "Zumba registration",
                "patient_phone": reg.get("phone") or "",
                "branch_id": bid,
                "branch_name": branch_map.get(bid, {}).get("branch_name", ""),
                "category": "zumba",
                "amount": amount,
                "payment_mode": pm,
                # A registration keeps its reference as a field of its own rather than in
                # an activity line, and what that field holds depends on the mode -- the
                # payer's UPI ID for UPI, a transaction number for card and bank transfer
                # (REFERENCE_LABELS in v3_zumba.py / v3_fitness.py). Handed over as typed,
                # for the screen to label by the mode beside it.
                "payment_ref": _registration_reference(reg, pm),
                "collected_by": reg.get("created_by", ""),
                "collected_at": reg.get("created_at", ""),
                "approved": is_approved,
                "approved_by": reg.get("approved_by") or "",
                "approved_at": reg.get("approved_at") or "",
            })

    # Gym memberships, on the same footing as the class fees above: v3_fitness.py keeps the
    # money on the registration, so this tab — which reads the lead activity trail and store
    # sales — never saw a rupee of it. Same consequence as Zumba had: counted in the Total
    # and present in no approval queue, so nobody could sign it off or query it.
    if category in (None, "", "all", "fitness"):
        fitness_query = {}
        if branch_id:
            fitness_query["branch_id"] = branch_id
        if date_query:
            fitness_query["created_at"] = date_query
        regs = await v3_col("fitness_registrations").find(fitness_query, {"_id": 0}).to_list(5000)
        for reg in regs:
            bid = reg.get("branch_id")
            if mode_branch_ids is not None and bid not in mode_branch_ids:
                continue
            # fee_paid, not fee_amount, and nothing to review when it is zero: a
            # membership with no money on it yet is the Fitness tab's business, not
            # this one's. Same rule revenue_overview counts by.
            amount = float(reg.get("fee_paid") or 0)
            if amount <= 0:
                continue
            is_approved = bool(reg.get("approved"))
            pm = reg.get("payment_mode") or "unknown"
            if payment_mode and payment_mode not in ("all", "") and pm != payment_mode:
                continue
            rows.append({
                "id": reg.get("id", ""),
                # No lead behind a membership -- the member is a registration, not a
                # patient -- so this stays empty rather than faked, the same way a
                # counter sale's does.
                "lead_id": "",
                "patient_name": (reg.get("name") or "").strip() or "Fitness registration",
                "patient_phone": reg.get("phone") or "",
                "branch_id": bid,
                "branch_name": branch_map.get(bid, {}).get("branch_name", ""),
                "category": "fitness",
                "amount": amount,
                "payment_mode": pm,
                # A registration keeps its reference as a field of its own rather than in
                # an activity line, and what that field holds depends on the mode -- the
                # payer's UPI ID for UPI, a transaction number for card and bank transfer
                # (REFERENCE_LABELS in v3_zumba.py / v3_fitness.py). Handed over as typed,
                # for the screen to label by the mode beside it.
                "payment_ref": _registration_reference(reg, pm),
                "collected_by": reg.get("created_by", ""),
                "collected_at": reg.get("created_at", ""),
                "approved": is_approved,
                "approved_by": reg.get("approved_by") or "",
                "approved_at": reg.get("approved_at") or "",
            })

    rows.sort(key=lambda r: r["collected_at"], reverse=True)
    pending = [r for r in rows if not r["approved"]]
    approved_rows = [r for r in rows if r["approved"]]
    # `approved` cuts the list, not the summary. Every loop above used to skip the other
    # pile outright, which meant the summary was totalled over whichever side had been
    # asked for and the other read Rs.0 with 0 payments -- so the tab showed nothing
    # approved until Approved was picked, and then nothing pending. The two cards are
    # there to be compared, and a figure that only appears once you are looking at it is
    # not a comparison. Both piles are built now; only what is listed narrows.
    listed = rows if approved is None else (approved_rows if approved else pending)
    return {
        "delete_enabled": await expense_delete_enabled(),
        "transactions": listed[:1000],
        "summary": {
            "pending_count": len(pending),
            "pending_total": sum(r["amount"] for r in pending),
            "approved_count": len(approved_rows),
            "approved_total": sum(r["amount"] for r in approved_rows),
        },
    }


# ---------- Expenses (Accountant) ----------

class ExpenseCreate(BaseModel):
    category: str
    amount: float
    branch_id: Optional[str] = None  # blank = an org-wide expense, not one branch's own
    note: Optional[str] = ""
    expense_date: Optional[str] = None  # defaults to today if omitted
    # What the money was for and where it went. Asked because an expense somebody has to
    # sign off is a claim about a real payment, and "Rs.4,000, Maintenance" is not one an
    # accountant can check — they need to know who it went to and how it was paid.
    paid_to: Optional[str] = ""
    # The Vendor book row it was paid to, when it was one. paid_to is still written --
    # filled from the vendor's name -- so a row reads the same whichever way it was entered.
    vendor_id: Optional[str] = None
    payment_mode: Optional[str] = ""
    # What the payment can be traced by, whatever the tender calls it: a UPI id, a card
    # batch, a bank transaction number, a cheque number. One field rather than four
    # because it answers one question -- how would somebody find this payment again --
    # and the tender beside it already says which kind of answer it is.
    reference: Optional[str] = ""
    # Cash: the notes handed over, counted. Same two fields and same shape a closing
    # count carries (see ClosingBalanceInput), so a pile of cash is described one way
    # across the whole book. Anything not a note this desk holds is dropped by
    # _denomination_total rather than guessed at, and the coins field exists because the
    # ladder stops at ten and a payment of Rs.1,234 does not.
    cash_denominations: Optional[dict] = None
    cash_coins: Optional[float] = 0
    # Raised from a branch's drawer, whoever is holding the keyboard. The branch screen
    # sets it; the accountant's own expense form does not. Role alone cannot answer this:
    # a Super Admin standing in Branch > Accountant Manage is spending a branch's cash and
    # is no more able to approve their own spending there than the Branch Admin is, yet
    # the same account entering a central payment on the Finance board is the sign-off.
    # Without it their drawer expense was written approved and never reached the
    # accountant's queue at all.
    from_branch_drawer: Optional[bool] = False


class ExpenseDecision(BaseModel):
    # Why it was turned down, so the branch is told rather than left watching a row sit.
    reason: Optional[str] = ""


# An expense written before approval existed was entered by the accountant, and their
# entering it was the sign-off — there was no other hand it could pass through. So a row
# with no flag reads as approved rather than appearing in a queue nobody raised.
def _expense_approved(row: dict) -> bool:
    value = row.get("approved")
    return True if value is None else bool(value)


# ---- Expense delete: a bin on each expense, switched on and off in Developer Access ----
#
# Off unless a developer switches it on, the same shape as the Branch Leads delete button:
# for clearing demo and testing expenses. The endpoint refuses while it is off, not just
# the icon hiding. The toggle's own endpoints live in v3_config beside the others.
EXPENSE_DELETE_SETTING_ID = "expense_delete_button"


async def expense_delete_enabled() -> bool:
    row = await v3_col("app_settings").find_one({"id": EXPENSE_DELETE_SETTING_ID}, {"_id": 0})
    return bool(row and row.get("enabled"))


# When expenses started being written approved on save (commit 0da48efd). That was
# reversed: an expense waits for the accountant. Anything written in between was signed off
# by whoever entered it, and goes back to the accountant's queue.
_SELF_APPROVED_SINCE = "2026-09-26T13:00:00"


async def return_self_approved_expenses() -> None:
    """Put the expenses approved by their own author back into Pending. Idempotent: once
    a row is pending, or approved by somebody else, it no longer matches."""
    await v3_col("expenses").update_many(
        {
            "created_at": {"$gte": _SELF_APPROVED_SINCE},
            "approved": True,
            "$expr": {"$eq": ["$approved_by", "$created_by"]},
        },
        {"$set": {"approved": False, "approved_by": None, "approved_at": None}},
    )


async def _link_expense_vendors(rows: list) -> None:
    """Tie each expense to its Vendor book row, the old ones included.

    An expense written before the vendor picker carries only the typed paid_to. Where that
    text is a vendor's name (case and spacing aside) the row is read as paid to that
    vendor -- worked out on read rather than written back, so nothing is migrated and a
    vendor added tomorrow picks up last year's expenses to them the moment it exists. A
    row already booked against a vendor keeps it, and shows the vendor's current name.
    """
    vendors = await v3_col("vendors").find({}, {"_id": 0, "id": 1, "name": 1}).to_list(1000)
    by_id = {v["id"]: v.get("name", "") for v in vendors}
    by_name = {" ".join((v.get("name") or "").lower().split()): v["id"] for v in vendors}
    for r in rows:
        vid = r.get("vendor_id")
        if not vid or vid not in by_id:
            vid = by_name.get(" ".join((r.get("paid_to") or "").lower().split()))
        r["vendor_id"] = vid or None
        r["vendor_name"] = by_id.get(vid, "") if vid else ""


@router.get("/finance/expenses")
async def list_expenses(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[str] = None,
    mode: Optional[str] = None,  # "online" | "offline"
    vendor_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "business_dev")),
):
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
    query = {}
    if branch_id:
        query["branch_id"] = branch_id
    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date
    if date_query:
        query["expense_date"] = date_query
    rows = await v3_col("expenses").find(query, {"_id": 0}).sort("expense_date", -1).to_list(2000)
    await _link_expense_vendors(rows)
    if vendor_id:
        rows = [r for r in rows if r.get("vendor_id") == vendor_id]
    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1}).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}
    if mode in ("online", "offline"):
        online_ids = {b["id"] for b in branch_docs if _is_online_vertical(b.get("vertical"))}
        # An org-wide expense (no branch_id) isn't exclusively either — it counts under
        # both, the same way an untagged Lead Source shows under both Online and Offline.
        rows = [r for r in rows if not r.get("branch_id") or (r["branch_id"] in online_ids) == (mode == "online")]
    for r in rows:
        r["branch_name"] = branch_name_map.get(r.get("branch_id"), "") if r.get("branch_id") else "All Branches"
        r["approved"] = _expense_approved(r)
        r["rejected"] = bool(r.get("rejected"))
        # Worked out from the row rather than read off it, so one written before the tin
        # existed is described the same way as one written after it -- and so the flag can
        # never claim petty cash for an expense the tin holds no movement for. The
        # accountant reading the queue is told which of these came out of the tin, where
        # the reason typed by the branch is the only paper there is.
        r["petty_cash"] = _is_petty_cash_expense(
            r.get("amount") or 0, r.get("payment_mode") or "", r.get("branch_id"),
        )
    approved_rows = [r for r in rows if r["approved"]]
    pending_rows = [r for r in rows if not r["approved"] and not r["rejected"]]
    rejected_rows = [r for r in rows if not r["approved"] and r["rejected"]]
    # Same Cash/Cheque/Bank/UPI split Income's own summary carries (see get_branch_finance),
    # so the Expense tab's tiles read the same way and Overview can set the two side by
    # side. Blank on a row logged before payment_mode was asked for — reads back "unknown"
    # like an untagged Income row rather than crashing the count.
    payment_modes = {}
    for r in rows:
        pm = r.get("payment_mode") or "unknown"
        payment_modes[pm] = payment_modes.get(pm, 0.0) + (r.get("amount") or 0)
    # `total` stays what it always was — every row in the window — so nothing already
    # reading this endpoint changes meaning under it. The split is beside it.
    return {
        "expenses": rows,
        "total": sum(r.get("amount", 0) for r in rows),
        "approved_total": sum(r.get("amount", 0) for r in approved_rows),
        "approved_count": len(approved_rows),
        "pending_total": sum(r.get("amount", 0) for r in pending_rows),
        "pending_count": len(pending_rows),
        "rejected_total": sum(r.get("amount", 0) for r in rejected_rows),
        "rejected_count": len(rejected_rows),
        "payment_modes": payment_modes,
        "delete_enabled": await expense_delete_enabled(),
    }


@router.post("/finance/expenses")
async def create_expense(
    payload: ExpenseCreate,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Raise an expense. A branch raises a request; the accountant enters a fact.

    Same door for both, because it is the same record — what differs is who is standing
    at it. A branch cannot approve its own spending, so theirs arrives pending and waits.
    An accountant's is approved as it is written: approval exists to put a second pair of
    eyes on a payment, and holding their own entry in a queue for themselves to sign off
    is a queue of one person's work waiting on that person.

    Which of the two it is comes from the screen it was raised on (`from_branch_drawer`)
    as well as the role, not from the role alone. Cash out of a branch drawer is a
    request whoever typed it: Super Admin and Business Dev can both open Branch >
    Accountant Manage and spend a branch's cash there, and reading only the role wrote
    theirs approved on the spot, so it skipped the accountant's queue and landed in
    Expenses Approved with nobody having approved anything.

    A branch's expense is theirs whatever the form said. The org-wide option belongs to
    head office — a branch expense with no branch on it is one nobody's books carry.
    """
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")
    if not payload.category.strip():
        raise HTTPException(status_code=400, detail="Category is required")

    raised_by_branch = is_branch_admin_role(user.role)
    if raised_by_branch and not user.branch_id:
        raise HTTPException(status_code=400, detail="Your account is not attached to a branch")

    branch_id = user.branch_id if raised_by_branch else (payload.branch_id or None)
    reason = (payload.note or "").strip()

    # Money out of a branch drawer: a Branch Admin's expense always is, and anyone else's
    # is when it was raised on the branch screen. Everything below that a branch expense
    # is held to — cash only, a reason, no central categories, and no self-approval —
    # keys off this rather than off the role.
    from_drawer = raised_by_branch or bool(payload.from_branch_drawer)
    if from_drawer and not branch_id:
        raise HTTPException(
            status_code=400,
            detail="Pick the branch whose drawer this cash came out of",
        )

    # A branch spends cash and only cash. Everything else it might pay by — a transfer, a
    # card, a cheque — is a payment the accountant makes centrally against a bill, not one
    # a branch settles from the drawer. Pinned here rather than trusted from the form, so a
    # crafted request cannot log a branch card payment that the cash box would never see.
    payment_mode = "cash" if from_drawer else (payload.payment_mode or "").strip()

    # Rent, Salary and Electricity are head office's to pay — a branch has no float to
    # cover a month of any of them, and an accountant signing off a Rs.80,000 line a branch
    # typed is signing off a figure with nothing behind it. Blocked here as well as left
    # off the branch's category list, because a list is only a suggestion to anyone holding
    # the URL. See BRANCH_BLOCKED_EXPENSE_CATEGORIES.
    if from_drawer and payload.category.strip().lower() in BRANCH_BLOCKED_EXPENSE_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"{payload.category.strip()} is paid centrally by the accountant, not from a branch — pick another category",
        )

    # A branch expense is cash out of the drawer, and cash leaves no invoice, no reference
    # and no transfer behind it — only whoever took it and whatever they say it was for. So
    # that sentence is the whole of what the accountant has to sign off on, and it is
    # required of every branch expense rather than only the small ones. An accountant's own
    # entry arrives carrying a payee and a bill number and is left to say why or not.
    if from_drawer and not reason:
        raise HTTPException(
            status_code=400,
            detail="Say what the cash was spent on — it is what the accountant approves it on",
        )

    # Cash out of a drawer is counted out by note, and the count has to come to the amount
    # -- the same rule a cash fee is held to. It is what the expense is approved on now
    # that a branch's expense no longer waits for the accountant.
    if from_drawer:
        notes_total, _ = _denomination_total(payload.cash_denominations)
        counted = round(notes_total + float(payload.cash_coins or 0), 2)
        if abs(counted - round(float(payload.amount), 2)) >= 0.01:
            raise HTTPException(
                status_code=400,
                detail="Count the cash out by note -- the denominations must add up to the amount",
            )

    vendor = None
    if payload.vendor_id:
        vendor = await v3_col("vendors").find_one(
            {"id": payload.vendor_id}, {"_id": 0, "id": 1, "name": 1, "active": 1}
        )
        if not vendor:
            raise HTTPException(status_code=400, detail="That vendor no longer exists")
        if vendor.get("active") is False:
            raise HTTPException(status_code=400, detail=f"{vendor['name']} is switched off in the Vendor list")

    doc = {
        "id": str(uuid.uuid4()),
        "category": payload.category.strip(),
        "amount": payload.amount,
        "branch_id": branch_id,
        "note": reason,
        "paid_to": (payload.paid_to or "").strip() or (vendor or {}).get("name", ""),
        "vendor_id": (vendor or {}).get("id"),
        "vendor_name": (vendor or {}).get("name", ""),
        "payment_mode": payment_mode,
        "reference": (payload.reference or "").strip(),
        # Stored as sent, not required here. The accountant's own form asks for the count
        # and will not submit one that does not add up to the amount; a branch's form does
        # not ask at all, and refusing its expenses for a field it has no box for would
        # close the door this endpoint deliberately holds open for both.
        "cash_denominations": _denomination_total(payload.cash_denominations)[1],
        "cash_coins": round(float(payload.cash_coins or 0), 2),
        "expense_date": payload.expense_date or _now()[:10],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
        # Every expense waits for the accountant, wherever it was added -- a branch
        # drawer, a vendor's View, or the accountant's own form. It counts once the
        # accountant has opened it in Approvals and signed it off.
        "approved": False,
        "approved_by": None,
        "approved_at": None,
        "rejected": False,
        "rejection_reason": "",
    }
    await v3_col("expenses").insert_one(doc.copy())

    # Small cash spending comes out of the tin, so the tin is drawn down here rather than
    # by a second thing the branch has to remember to do. Written after the expense and
    # keyed to its id, so the movement and the expense it paid for can never disagree
    # about whether the money left -- and so deleting one takes the other with it.
    #
    # Deliberately not gated on approval. The notes are gone the moment they are handed
    # over; a tin that only falls once an accountant signs off would report a balance the
    # branch can see is wrong by looking into it.
    if _is_petty_cash_expense(doc["amount"], doc["payment_mode"], doc["branch_id"]):
        await _record_petty_cash_movement(
            # The reason, not the category. A tin's book reading "Travel, Travel, Travel"
            # down a month says nothing anyone can check; "Auto to the courier office" is
            # the line the branch wrote and the line the accountant approved it on, and it
            # is the same sentence in both places because it is the same claim.
            branch_id=doc["branch_id"], delta=-doc["amount"], kind="expense",
            on=doc["expense_date"], note=reason or doc["category"], user=user,
            expense_id=doc["id"],
        )
        doc["petty_cash"] = True
        doc["petty_cash_balance"] = await _petty_cash_balance(doc["branch_id"])
    return doc


@router.post("/finance/expenses/{expense_id}/approve")
async def approve_expense(
    expense_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Sign off one branch expense. Not open to Branch Admin, for the reason
    approve_transaction gives: approval is somebody other than whoever raised it saying
    the money went where the form says it went."""
    update = {
        "approved": True,
        "approved_by": user.full_name,
        "approved_at": _now(),
        "rejected": False,
        "rejection_reason": "",
    }
    res = await v3_col("expenses").update_one({"id": expense_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Expense not found")
    return {"message": "Approved"}


@router.post("/finance/expenses/{expense_id}/reject")
async def reject_expense(
    expense_id: str,
    payload: ExpenseDecision = ExpenseDecision(),
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Turn one down, with the reason. Kept rather than deleted: the branch that raised it
    is owed an answer, and a row that vanishes reads as one that was never sent."""
    update = {
        "approved": False,
        "rejected": True,
        "rejection_reason": (payload.reason or "").strip(),
        "approved_by": None,
        "approved_at": None,
        "rejected_by": user.full_name,
        "rejected_at": _now(),
    }
    res = await v3_col("expenses").update_one({"id": expense_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Expense not found")
    return {"message": "Rejected"}


@router.delete("/finance/expenses/{expense_id}")
async def delete_expense(expense_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev"))):
    if not await expense_delete_enabled():
        raise HTTPException(status_code=403, detail="Expense delete is switched off in Developer Access")
    res = await v3_col("expenses").delete_one({"id": expense_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Expense not found")
    # An expense that drew the tin down puts it back when it is deleted. Removing the
    # movement rather than writing an opposite one: the expense is gone entirely, so a
    # pair of cancelling lines in the tin's book would be two entries describing a payment
    # the branch no longer says happened.
    await v3_col("petty_cash_movements").delete_many({"expense_id": expense_id})
    return {"message": "Expense deleted"}


# ---------- Profit (Accountant) ----------

@router.get("/finance/profit")
async def finance_profit(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[str] = None,
    mode: Optional[str] = None,  # "online" | "offline"
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "business_dev")),
):
    """Revenue for the window (every collection — same total Accountant Manage's own
    Total Revenue tile shows, not only approved ones: approval is a review step, not a
    gate on whether money collected counts as revenue) minus Expenses logged against
    the same window and branch."""
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id

    online_ids = set()
    if mode in ("online", "offline"):
        branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "vertical": 1}).to_list(500)
        online_ids = {b["id"] for b in branch_docs if _is_online_vertical(b.get("vertical"))}

    lead_query = {"branch_id": branch_id} if branch_id else {}
    if mode in ("online", "offline"):
        lead_query["vertical"] = {"$regex": f"^{mode}_"}
    leads = await v3_col("leads").find(lead_query, {"_id": 0, "id": 1}).to_list(20000)
    lead_ids = [l["id"] for l in leads]

    activity_query = {"action": {"$in": REVENUE_ACTIONS}}
    # See get_branch_finance above: scoped means scoped, even to nobody.
    if lead_query:
        activity_query["lead_id"] = {"$in": lead_ids}
    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date + "T23:59:59"
    if date_query:
        activity_query["created_at"] = date_query
    activities = await v3_col("lead_activity").find(activity_query, {"_id": 0, "details": 1}).to_list(20000)
    revenue = sum(_parse_rs_amount(a.get("details", "")) for a in activities)

    store_query = {"kind": "sale"}
    if branch_id:
        store_query["branch_id"] = branch_id
    if date_query:
        store_query["created_at"] = date_query
    store_sales = await v3_col("inventory_movements").find(store_query, {"_id": 0, "amount": 1, "branch_id": 1}).to_list(5000)
    if mode in ("online", "offline"):
        store_sales = [s for s in store_sales if (s.get("branch_id") in online_ids) == (mode == "online")]
    revenue += sum(float(s.get("amount") or 0) for s in store_sales)

    expense_query = {"branch_id": branch_id} if branch_id else {}
    expense_date_query = {}
    if start_date:
        expense_date_query["$gte"] = start_date
    if end_date:
        expense_date_query["$lte"] = end_date
    if expense_date_query:
        expense_query["expense_date"] = expense_date_query
    expenses = await v3_col("expenses").find(
        expense_query, {"_id": 0, "amount": 1, "category": 1, "branch_id": 1, "approved": 1}
    ).to_list(2000)
    # Only what has been signed off. A request is somebody asking to spend, not money
    # gone — counting it would drop reported profit the moment a branch typed a number,
    # and put it back when the accountant said no.
    expenses = [e for e in expenses if _expense_approved(e)]
    if mode in ("online", "offline"):
        # Org-wide (no branch_id) counts under both — same as the Expense tab's own
        # mode filter, so the two stay in step for the same window.
        expenses = [e for e in expenses if not e.get("branch_id") or (e["branch_id"] in online_ids) == (mode == "online")]
    total_expense = sum(e.get("amount", 0) for e in expenses)

    by_category = {}
    for e in expenses:
        cat = e.get("category") or "Uncategorized"
        by_category[cat] = by_category.get(cat, 0) + (e.get("amount") or 0)

    return {
        "revenue": revenue,
        "expense": total_expense,
        "profit": revenue - total_expense,
        "expense_by_category": [{"category": k, "amount": v} for k, v in sorted(by_category.items(), key=lambda kv: -kv[1])],
    }


# ---------- AC Overview > Total Revenue (Super Admin / Accountant) ----------

# "session" = Treatment Fee (the multi-visit Session Package collected after Consultation
# Fee); everything else collected at/around the consultation itself is "consultation".
REVENUE_ACTIONS = ["consultation_paid", "package_sold", "package_payment_collected", "treatment_fee_collected", "diet_fee_collected", "diet_chart_fee_collected", "rehab_fee_collected", "fee_collected"]

# The Consultation Fee itself: the actions that mean "this patient paid to be seen today".
# Deliberately narrower than _revenue_category(...) == "consultation", which is a reporting
# bucket that also holds the Diet Consultation Fee. Spot joining keys off THIS set — a diet
# fee taken on the same day as a treatment fee is not evidence the patient signed up on the
# spot, and folding it in would inflate spot joining with unrelated same-day payments.
CONSULTATION_FEE_ACTIONS = {"consultation_paid", "package_sold", "package_payment_collected", "fee_collected"}


def _revenue_category(action: str) -> str:
    """Which revenue line a payment belongs to: consultation, session, diet or rehab.

    Diet has its own line rather than sitting inside consultation. It is a separate
    service sold at its own price by its own clinician, and a branch reporting on it
    cannot answer "how much did diet bring in" if it is folded into the consultation
    figure. Anything not named here is consultation, which keeps every older action
    reporting exactly where it always did.
    """
    if action == "treatment_fee_collected":
        return "session"
    # Both diet fees land on the one diet line. They are two products, but a branch
    # asking "how much did diet bring in" means the vertical, not the shelf, and splitting
    # them into two report lines would answer a question nobody asked while making the one
    # they did ask take two numbers to read.
    if action in ("diet_fee_collected", "diet_chart_fee_collected"):
        return "diet"
    if action == "rehab_fee_collected":
        return "rehab"
    return "consultation"


def _parse_rs_amount(details: str) -> float:
    """Most collection flows write "Rs.1200" into details; sell_package (action
    "package_sold") writes "₹1200" instead. Rs. is tried first since it's the far
    more common case; ₹ is a fallback, not a replacement, so nothing that already
    parsed correctly changes."""
    try:
        if "Rs." in details:
            amt_part = details.split("Rs.")[1]
        elif "₹" in details:
            amt_part = details.split("₹")[1]
        else:
            return 0.0
        amt_str = amt_part.split(" ")[0].split("(")[0].strip()
        return float(amt_str)
    except (IndexError, ValueError):
        return 0.0


def _parse_payment_mode(details: str) -> str:
    m = re.search(r"\bvia (\w+)", details, re.IGNORECASE)
    return m.group(1).lower() if m else "unknown"


# One tender inside a split, as _standard_payment_record wrote it onto the activity line:
#
#   " · Split: Rs.8000 cash [4xRs.2000], Rs.4000 upi (UTR123)"
#
# The mode word is required, and required to be one of the four a split can be paid in
# (SETTLED_NOW_MODES in v3_packages.py). That is what keeps a counted-notes label out of
# the reading: "4xRs.2000" is an amount with no mode after it, and matches nothing.
_SPLIT_TENDER_RE = re.compile(
    r"Rs\.?\s*([\d,]+(?:\.\d+)?)\s+(cash|upi|card|account_transfer)\b",
    re.IGNORECASE,
)


def _parse_payment_split(details: str) -> list:
    """The tenders behind a split collection: [{"mode", "amount"}], or [] for anything else.

    A split is one payment made in two or three ways at the counter -- half in cash, the
    rest by UPI -- and the record calls it "split" for the reason its own comment gives:
    naming any one of the modes would make it say something only part true. That answers
    what the payment WAS, and leaves every screen reading it unable to say what CAME IN:
    a Cash figure that quietly omits the cash half of every split is wrong, and a Cash
    filter that hides those payments is wrong in the other direction.

    So the breakdown is handed back alongside the mode. Read off the activity line rather
    than the details document because that is what these loops have in hand, and the line
    is written from the same tenders in the same order.
    """
    if not details:
        return []
    segment = re.search(r"·\s*Split:\s*([^·]+)", details)
    if not segment:
        return []
    out = []
    for amount, mode in _SPLIT_TENDER_RE.findall(segment.group(1)):
        try:
            out.append({"mode": mode.lower(), "amount": float(amount.replace(",", ""))})
        except ValueError:
            continue
    return out


def _lines_to_split(lines) -> list:
    """The same shape, for the records that keep their tenders as a field of their own.

    A Zumba or Fitness registration stores payment_lines rather than writing them into an
    activity line, so there is nothing to parse -- but every reader of this payload should
    get one shape whichever collection a row came out of.
    """
    out = []
    for ln in lines or []:
        mode = str((ln or {}).get("mode") or "").strip().lower()
        if not mode:
            continue
        try:
            out.append({"mode": mode, "amount": float((ln or {}).get("amount") or 0)})
        except (TypeError, ValueError):
            continue
    return out


# What one payment can be traced by, read back off the activity line it was written onto.
#
# The structured fields live on the lead's own payment_details document (build_payment_details
# in v3_packages.py writes both), but this tab reads lead_activity, where the same facts are
# only in the human line. Rather than fetching every lead's five fee documents to show one
# list, the line is read back with the same shapes that wrote it -- each pattern below sits
# directly under the f-string it undoes.

# " · UPI txn ABC123, UTR XYZ to fitsio@upi"  (UTR and receiver both optional)
_UPI_TXN_RE = re.compile(r"UPI txn\s+(.+?)(?=,\s*UTR\s|\s+to\s+\S+\s*(?:·|$)|\s*·|$)", re.IGNORECASE)
_UPI_UTR_RE = re.compile(r"UTR\s+(.+?)(?=\s+to\s+\S+\s*(?:·|$)|\s*·|$)", re.IGNORECASE)
_UPI_TO_RE = re.compile(r"UPI txn[^·]*?\sto\s+(\S+?)\s*(?:·|$)", re.IGNORECASE)
# " · Card txn 4455"
_CARD_TXN_RE = re.compile(r"Card txn\s+(.+?)(?=\s*·|$)", re.IGNORECASE)
# " · Cheque #000123, HDFC"
_CHEQUE_RE = re.compile(r"Cheque #(\S+?),\s*(.+?)(?=\s*·|$)", re.IGNORECASE)
# " · A/C ****1234, R Kumar, HDFC (HDFC0000123) · Ref UTR99"
_ACCOUNT_RE = re.compile(r"A/C \*+(\d+),\s*([^,]+),\s*([^(]+)\(([^)]+)\)")
_ACCOUNT_REF_RE = re.compile(r"·\s*Ref\s+(.+?)(?=\s*·|$)")


def _mask_account(number: str) -> str:
    """An account number, shown the way a statement shows one. The full number is never
    put on a screen anybody can read over a shoulder -- and for a fee collection it was
    never stored in the first place (see build_payment_details)."""
    digits = "".join(ch for ch in str(number or "") if ch.isdigit())
    return f"****{digits[-4:]}" if len(digits) >= 4 else (digits or "")


def _parse_payment_reference(details: str) -> dict:
    """Everything the payment line says about HOW the money arrived, beyond its mode.

    The Approvals desk is being asked to sign a payment off, and "Rs.11,200 · UPI" is not
    something anybody can check: a UPI collection is checked against the transaction id the
    patient quotes and the company account it landed in. So the reference travels with the
    row, and the screen shows whichever of these the mode actually has -- Cash has none,
    which is why it shows none rather than an empty box.
    """
    out = {}
    if not details:
        return out
    m = _UPI_TXN_RE.search(details)
    if m:
        out["upi_transaction_id"] = m.group(1).strip()
        # Only ever read as part of a UPI segment. On its own it would also match the
        # "Ref UTR..." an Account Transfer ends with, and hand back that transfer's
        # reference as though a UPI payment had carried it.
        m = _UPI_UTR_RE.search(details)
        if m:
            out["upi_utr"] = m.group(1).strip()
    m = _UPI_TO_RE.search(details)
    if m:
        out["receiver_upi_id"] = m.group(1).strip()
    m = _CARD_TXN_RE.search(details)
    if m:
        out["card_transaction_id"] = m.group(1).strip()
    m = _CHEQUE_RE.search(details)
    if m:
        out["cheque_number"] = m.group(1).strip()
        out["cheque_bank"] = m.group(2).strip()
    m = _ACCOUNT_RE.search(details)
    if m:
        out["account_number"] = f"****{m.group(1).strip()}"
        out["account_holder_name"] = m.group(2).strip()
        out["bank_name"] = m.group(3).strip()
        out["ifsc_code"] = m.group(4).strip()
        ref = _ACCOUNT_REF_RE.search(details)
        if ref:
            out["transfer_reference"] = ref.group(1).strip()
    return {k: v for k, v in out.items() if v}


def _registration_reference(reg: dict, mode: str) -> dict:
    """The reference on a Zumba or Fitness registration, in the shape the activity-line
    rows use. One typed field there rather than the several a fee collection writes, so a
    UPI registration carries the payer's UPI ID and the other two a transaction number."""
    ref = str(reg.get("payment_reference") or "").strip()
    out = {}
    if ref:
        if mode == "upi":
            out["payer_upi_id"] = ref
        elif mode in ("card", "account_transfer"):
            out["transfer_reference" if mode == "account_transfer" else "card_transaction_id"] = ref
        else:
            out["reference"] = ref
    split = _lines_to_split(reg.get("payment_lines"))
    if split:
        out["split"] = split
    return out


async def _upi_account_map() -> dict:
    """Company UPI IDs, keyed by the id itself, so a payment that names where it landed can
    say whose account that is. Read once per request rather than per row -- there are a
    handful of these accounts and thousands of payments into them.

    Switched-off accounts are included on purpose, unlike the collect picker's list: this
    reads payments already taken, and an account closed since is still the account that
    money went into.
    """
    rows = await v3_col("bank_accounts").find(
        {},
        {"_id": 0, "upi_id": 1, "holder_name": 1, "bank_name": 1, "account_number": 1, "ifsc_code": 1, "bank_branch_name": 1},
    ).to_list(500)
    out = {}
    for row in rows:
        upi = (row.get("upi_id") or "").strip()
        if not upi:
            continue
        out[upi.lower()] = {
            "receiver_name": row.get("holder_name") or "",
            "receiver_bank": row.get("bank_name") or "",
            "receiver_account": _mask_account(row.get("account_number")),
            "receiver_ifsc": (row.get("ifsc_code") or "").upper(),
        }
    return out


def _installment_status(inst: dict, today: str) -> str:
    if inst.get("paid"):
        return "paid"
    due = inst.get("due_date")
    if due and due < today:
        return "overdue"
    if due and due == today:
        return "due_today"
    return "upcoming"


# Every fee that can leave a balance behind, and the fields its schedule lives on.
#
# A balance is recorded identically for all five — one unpaid installment on that fee's
# own payment_details — so one map is enough to read any of them, collect against any of
# them, and report on any of them. Keyed by the name a caller passes; "treatment" is the
# default everywhere, since it was the only fee that could carry a schedule when this
# endpoint was written and every existing caller still sends nothing.
FEE_SCHEDULES = {
    "treatment": {
        "details": "treatment_fee_payment_details", "paid": "treatment_fee_paid",
        "mode": "treatment_fee_payment_mode", "package": "session_package_name",
        "label": "Treatment Fee", "action": "treatment_fee_collected",
    },
    "consultation": {
        "details": "package_payment_details", "paid": "package_paid",
        "mode": "package_payment_mode", "package": "package_name",
        "label": "Consultation Fee", "action": "package_payment_collected",
    },
    "rehab": {
        "details": "rehab_fee_payment_details", "paid": "rehab_fee_paid",
        "mode": "rehab_fee_payment_mode", "package": "rehab_package_name",
        "label": "Rehab Fee", "action": "rehab_fee_collected",
    },
    "diet": {
        "details": "diet_fee_payment_details", "paid": "diet_fee_paid",
        "mode": "diet_fee_payment_mode", "package": "diet_package_name",
        "label": "Diet Consultation Fee", "action": "diet_fee_collected",
    },
    "diet_chart": {
        "details": "diet_chart_fee_payment_details", "paid": "diet_chart_fee_paid",
        "mode": "diet_chart_fee_payment_mode", "package": "diet_chart_package_name",
        "label": "Diet Chart Fee", "action": "diet_chart_fee_collected",
    },
}


# Every action that records money arriving, mapped to what a receipt calls it.
#
# Derived from FEE_SCHEDULES rather than retyped, so a sixth fee added there appears in a
# patient's payment history without a second edit here — plus the three collections that
# carry no installment schedule and so have no row in that map.
PAYMENT_ACTION_LABELS = {
    **{cfg["action"]: cfg["label"] for cfg in FEE_SCHEDULES.values()},
    "consultation_paid": "Consultation Fee",
    "package_sold": "Package Sold",
    "fee_collected": "Fee Collected",
}


async def lead_payment_history(lead: dict) -> list:
    """Every payment this patient has made, newest first, each against the branch that took it.

    Wider than the Summary tab's transaction list above, which reports only the three
    collections the revenue cards are built from. This answers a different question — what
    has this person paid us, anywhere, ever — and is read before a branch transfer, where
    showing only some of the money would understate what the move leaves behind.

    The branch on each row is where the patient was on the day it was collected, walked off
    the transfer history by _branch_at, never the branch they sit at now: a patient moved
    twice has receipts belonging to three different books.
    """
    rows = await v3_col("lead_activity").find(
        {"lead_id": lead.get("id"), "action": {"$in": list(PAYMENT_ACTION_LABELS)}},
        {"_id": 0},
    ).sort("created_at", -1).to_list(500)

    branch_ids = {_branch_at(lead, r.get("created_at", "")) for r in rows}
    branch_ids.discard("")
    branch_names = {
        b["id"]: b.get("branch_name", "")
        for b in await v3_col("branches").find(
            {"id": {"$in": list(branch_ids)}}, {"_id": 0, "id": 1, "branch_name": 1}
        ).to_list(200)
    }

    history = []
    for row in rows:
        collected_at = row.get("created_at", "")
        branch_id = _branch_at(lead, collected_at)
        history.append({
            "id": row.get("id", ""),
            # Blank on collections taken before receipts carried one, same as the Summary
            # tab's rows — every reader of either list has to tolerate it.
            "transaction_id": row.get("transaction_id") or "",
            "action": row.get("action", ""),
            "label": PAYMENT_ACTION_LABELS.get(row.get("action", ""), "Payment"),
            "amount": _parse_rs_amount(row.get("details", "")),
            "payment_mode": _parse_payment_mode(row.get("details", "")),
            "collected_by": row.get("created_by", ""),
            "collected_at": collected_at,
            "branch_id": branch_id,
            "branch_name": branch_names.get(branch_id, ""),
        })
    return history


def _fee_installments(lead: dict, fee: str = "treatment") -> list:
    """One fee's installment schedule, whatever put it there. A schedule exists whenever
    the record has one — from choosing 'Partial Payment' outright, from collecting for
    only some of a package's sessions, or from a collection that came up short of what
    was payable. Keyed off the data shape rather than the stored payment_mode, so every
    path shares every downstream balance/schedule/status calculation for free."""
    return (lead.get(FEE_SCHEDULES[fee]["details"]) or {}).get("installments") or []


def _treatment_installments(lead: dict) -> list:
    """The Treatment Fee's schedule — the one most of this file means when it says
    "installments", kept as its own name because most of this file only wants that one."""
    return _fee_installments(lead, "treatment")


def _all_unpaid_installments(lead: dict) -> list:
    """Every balance still owed across all five fees, as (fee, index, installment).

    A patient can owe on more than one at once — a part-paid Consultation Fee and a
    part-paid Diet Fee are two separate debts on two separate schedules — so anything
    reporting what someone owes has to look at all of them, not only the treatment one."""
    out = []
    for fee in FEE_SCHEDULES:
        for idx, inst in enumerate(_fee_installments(lead, fee)):
            if not inst.get("paid"):
                out.append((fee, idx, inst))
    return sorted(out, key=lambda row: row[2].get("due_date") or "")


def _lead_outstanding_balance(lead: dict) -> float:
    """Total still owed by this client across everything on their record: the
    Consultation Fee's assigned price if it hasn't been collected yet at all,
    plus every Treatment Fee installment not yet marked paid. Once a Consultation
    Fee payment has been confirmed (even at a Branch-Admin-negotiated discount
    below the assigned price), it's settled in full — the discount is a
    deliberate decision, not money still owed."""
    balance = 0.0
    if lead.get("package_id") and lead.get("package_paid") is None:
        balance += lead.get("package_price") or 0
    # Every fee's unpaid rows, not only the Treatment Fee's. Any of the five can be part
    # collected now with the rest scheduled, and a Diet balance is owed exactly as much
    # as a treatment one — counting only treatment would drop it off what this says.
    balance += sum(inst.get("amount", 0) for _, _, inst in _all_unpaid_installments(lead))
    return round(balance, 2)


def _lead_payment_progress(lead: dict) -> Optional[dict]:
    """For a Partial Payment treatment fee — what Collections tables' Due Date /
    Due Amount / Paid Amount columns show: the next unpaid installment (its date
    and amount, whether it's overdue or just upcoming), plus the total already
    paid. None of the fields apply once every installment is settled."""
    installments = _treatment_installments(lead)
    if not installments:
        return None
    paid_amount = sum(i.get("amount", 0) for i in installments if i.get("paid"))
    unpaid = sorted((i for i in installments if not i.get("paid")), key=lambda i: i.get("due_date", ""))
    next_due = unpaid[0] if unpaid else None
    return {
        "paid_amount": round(paid_amount, 2),
        "due_date": next_due.get("due_date") if next_due else None,
        "due_amount": round(next_due["amount"], 2) if next_due else None,
    }


def _lead_outstanding_detail(lead: dict, today: str) -> dict:
    """Outstanding Amount table — full bill/paid/balance picture per client, plus
    the next due date (from whichever fee's schedule falls due first) and a status
    badge: overdue (past due date), due_soon (due within 3 days), or partial
    (owes money but nothing scheduled yet / due further out)."""
    # A fee settled in one payment is settled in full, even at a discount that was
    # negotiated down: its "bill" here is what was actually collected, since the
    # discount was a decision rather than money still owed. A fee with a schedule is a
    # different matter — the schedule is the bill, both halves of it, so what has been
    # collected and what has not are read off the rows rather than off *_paid.
    package_installments = _fee_installments(lead, "consultation")
    if package_installments:
        total_bill = sum(i.get("amount", 0) for i in package_installments)
        paid_amount = sum(i.get("amount", 0) for i in package_installments if i.get("paid"))
    else:
        package_paid = lead.get("package_paid")
        total_bill = package_paid if package_paid is not None else (lead.get("package_price") or 0)
        paid_amount = package_paid or 0

    installments = _treatment_installments(lead)
    if installments:
        total_bill += sum(i.get("amount", 0) for i in installments)
        paid_amount += sum(i.get("amount", 0) for i in installments if i.get("paid"))
    elif lead.get("treatment_fee_paid"):
        total_bill += lead.get("treatment_fee_paid") or 0
        paid_amount += lead.get("treatment_fee_paid") or 0

    # Rehab and Diet have never been part of this picture, and a fee collected in one
    # payment still isn't — adding them wholesale would restate every existing row.
    # A balance is different: it is money the branch is owed and has to chase, so a fee
    # that left one is counted here, both halves, the same way the two above are.
    for fee in ("rehab", "diet", "diet_chart"):
        rows = _fee_installments(lead, fee)
        if rows:
            total_bill += sum(i.get("amount", 0) for i in rows)
            paid_amount += sum(i.get("amount", 0) for i in rows if i.get("paid"))

    # The nearest thing owed across every fee, so the badge and the date describe what
    # actually falls due next rather than only what the Treatment Fee does.
    unpaid = _all_unpaid_installments(lead)
    due_date = None
    next_installment_number = None
    next_installment_fee = None
    next_installment_amount = None
    if unpaid:
        next_fee, next_idx, next_inst = unpaid[0]
        due_date = next_inst.get("due_date")
        # What a payment reminder names as owed on that date, as opposed to the balance.
        next_installment_amount = round(next_inst.get("amount", 0), 2)
        # 1-based, matching what the Payment Schedules table shows, and named by the fee
        # it belongs to — the quick-collect action posts both back, so a balance on any
        # fee can be taken from here rather than only a Treatment Fee one.
        next_installment_number = next_idx + 1
        next_installment_fee = next_fee

    balance = round(max(total_bill - paid_amount, 0), 2)
    due_soon_cutoff = (datetime.fromisoformat(today).date() + timedelta(days=3)).isoformat()

    if due_date and due_date < today:
        status = "overdue"
    elif due_date and due_date <= due_soon_cutoff:
        status = "due_soon"
    else:
        status = "partial"

    return {
        "total_bill": round(total_bill, 2),
        "paid_amount": round(paid_amount, 2),
        "balance": balance,
        "due_date": due_date,
        "status": status,
        "next_installment_number": next_installment_number,
        "next_installment_fee": next_installment_fee,
        "next_installment_amount": next_installment_amount,
    }


def _lead_session_summary(lead: dict) -> dict:
    """Session Collections — the Treatment Fee / session package side only (not
    the Consultation package): its label, total fee, what's been paid, what's
    still due, and a paid/partial/pending status badge."""
    sessions = lead.get("session_package_sessions") or lead.get("package_sessions")
    package_name = lead.get("session_package_name") or lead.get("package_name")
    label = f"{sessions} Sessions" if sessions else (package_name or "—")

    total = 0.0
    paid = 0.0
    next_installment_number = None
    installments = _treatment_installments(lead)
    if installments:
        total = sum(i.get("amount", 0) for i in installments)
        paid = sum(i.get("amount", 0) for i in installments if i.get("paid"))
        unpaid = sorted((i for i in installments if not i.get("paid")), key=lambda i: i.get("due_date", ""))
        if unpaid:
            next_installment_number = installments.index(unpaid[0]) + 1
    elif lead.get("treatment_fee_paid"):
        total = lead.get("treatment_fee_paid") or 0
        paid = total

    due = round(max(total - paid, 0), 2)
    if total > 0 and due <= 0:
        status = "paid"
    elif paid > 0:
        status = "partial"
    else:
        status = "pending"

    return {
        "package_label": label,
        "total": round(total, 2),
        "paid": round(paid, 2),
        "due": due,
        "status": status,
        "next_installment_number": next_installment_number,
    }


def _empty_day(day: str) -> dict:
    """One day's revenue row, with every line seeded. Both loops that build these use it,
    so a row can never be missing the key the other loop is about to add to."""
    return {"date": day, "consultation": 0.0, "session": 0.0, "diet": 0.0, "store": 0.0, "zumba": 0.0, "rehab": 0.0, "fitness": 0.0}


def _branch_label(bid, names: dict) -> str:
    """What to call a payment's branch when it has none to call.

    "Unknown" read as a lookup that failed. Two different things end up here and both
    are real: money on a lead that was never given a branch, and money pointing at a
    branch id nothing answers to any more -- a branch deleted and recreated leaves its
    clients behind on the old one. Neither can appear under any branch anybody can pick
    from the dropdown, so All Branches comes out larger than its branches add up to.
    Naming them is the difference between that gap being on the page and being a
    discrepancy somebody has to find by hand.
    """
    if bid in names:
        return names[bid]
    return "Unassigned" if bid in (None, "") else "Former branch"


def _empty_branch(bid, bname: str) -> dict:
    return {
        "branch_id": bid, "branch_name": bname,
        "consultation_total": 0.0, "session_total": 0.0, "diet_total": 0.0, "store_total": 0.0,
        "zumba_total": 0.0, "rehab_total": 0.0, "fitness_total": 0.0,
    }


@router.get("/finance/revenue-overview")
async def revenue_overview(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[str] = None,
    # "online" | "offline", off each lead's own vertical — named apart from the loop's
    # own `mode` (payment mode: cash/upi/card/...) below so the two can never collide.
    vertical_mode: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """AC Overview > Total Revenue, and Accountant Manage (Super Admin's per-branch
    view and Branch Admin's own read-only tab) — date-range + branch scoped, built
    from the lead_activity payment trail (the only place these collections carry a
    real timestamp) rather than summing lead fields, which have no date dimension."""
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
    today = datetime.now(timezone.utc).date().isoformat()
    lead_query = {"branch_id": branch_id} if branch_id else {}
    if vertical_mode in ("online", "offline"):
        lead_query["vertical"] = {"$regex": f"^{vertical_mode}_"}
    leads = await v3_col("leads").find(lead_query, {"_id": 0}).to_list(20000)
    lead_ids = [l["id"] for l in leads]
    lead_branch_map = {l["id"]: l.get("branch_id") for l in leads}
    lead_name_map = {l["id"]: l.get("name", "Unknown") for l in leads}
    lead_phone_map = {l["id"]: l.get("phone", "") for l in leads}
    # On the row so a receipt reissued from Accountant Manage can print it. The leads
    # are already loaded whole above, so this is a pass over a list in memory rather
    # than a query — and without it the one field a bill is filed under came out blank.
    lead_patient_no_map = {l["id"]: l.get("patient_number", "") for l in leads}
    lead_balance_map = {l["id"]: _lead_outstanding_balance(l) for l in leads}
    lead_progress_map = {l["id"]: _lead_payment_progress(l) for l in leads}
    lead_session_map = {l["id"]: _lead_session_summary(l) for l in leads}
    lead_first_installment_map = {
        l["id"]: ((l.get("treatment_fee_payment_details") or {}).get("installments") or [{}])[0].get("amount")
        for l in leads if l.get("treatment_fee_payment_mode") == "partial"
    }

    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1}).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}
    # Store sales carry no lead, so they can't be filtered by vertical_mode through the
    # lead_query above — resolved off their own branch's vertical instead, further down.
    online_branch_ids = {b["id"] for b in branch_docs if _is_online_vertical(b.get("vertical"))}

    activity_query = {"action": {"$in": REVENUE_ACTIONS}}
    # See get_branch_finance above: scoped means scoped, even to nobody.
    if lead_query:
        activity_query["lead_id"] = {"$in": lead_ids}
    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date + "T23:59:59"
    if date_query:
        activity_query["created_at"] = date_query

    activities = await v3_col("lead_activity").find(activity_query, {"_id": 0}).sort("created_at", 1).to_list(20000)

    consultation_total = 0.0
    session_total = 0.0
    diet_total = 0.0
    rehab_total = 0.0
    by_day = {}
    by_branch_acc = {}
    payment_modes = {}
    # The same split, kept per day. Closing Balance needs a day's takings by mode to say
    # what the drawer should hold that evening, and it reads a month at a time -- summing
    # `transactions` for that cannot work, because that list is cut to the most recent 500
    # below and a busy month would silently report its earliest days as quiet ones. This is
    # tallied off every collection, in the same pass, so it stays whole however long the
    # window is.
    by_day_modes = {}
    transactions = []

    def _tally_modes(mode: str, amount: float, split: list, day: str = "") -> None:
        """Add one collection to the Cash/UPI/Card/Transfer figures this payload reports.

        A split lands on each mode it was actually paid in, for its own share. Counted
        under "split" instead, these figures answered a question nobody asks -- how much
        came in awkwardly -- while the Cash figure quietly left out the cash half of every
        one of them. The sum over all modes is the same either way, which is the test.

        The per-day copy is written here rather than beside each call site, so a collection
        can never land in one of the two and not the other.
        """
        def add(bucket: dict, key: str, value: float) -> None:
            bucket[key] = bucket.get(key, 0.0) + value

        daily = by_day_modes.setdefault(day, {}) if day else None
        if split:
            for line in split:
                add(payment_modes, line["mode"], line["amount"])
                if daily is not None:
                    add(daily, line["mode"], line["amount"])
            return
        add(payment_modes, mode, amount)
        if daily is not None:
            add(daily, mode, amount)

    for act in activities:
        details = act.get("details", "")
        amount = _parse_rs_amount(details)
        category = _revenue_category(act.get("action", ""))
        mode = _parse_payment_mode(details)
        split = _parse_payment_split(details)
        if category == "session" and mode == "partial":
            # The activity log's Rs. figure is the Partial Payment schedule's total,
            # not what was actually collected at that moment — only the first
            # installment is ever collected here (later ones via mark-paid, which
            # logs no new activity), so the real amount lives on the lead itself.
            first_amount = lead_first_installment_map.get(act.get("lead_id"))
            if first_amount is not None:
                amount = first_amount
        day = (act.get("created_at") or "")[:10]
        bid = lead_branch_map.get(act.get("lead_id"))
        bname = _branch_label(bid, branch_name_map)

        if category == "session":
            session_total += amount
        elif category == "diet":
            diet_total += amount
        elif category == "rehab":
            rehab_total += amount
        else:
            consultation_total += amount

        # Every category is seeded on both of the setdefaults below, here and in the store
        # loop — `d[category] += amount` needs the key to exist whichever loop created the
        # day, and a day with only store sales in it would otherwise KeyError the moment an
        # activity row landed on it.
        d = by_day.setdefault(day, _empty_day(day))
        d[category] += amount

        b = by_branch_acc.setdefault(bid or "unknown", _empty_branch(bid, bname))
        b[f"{category}_total"] += amount

        _tally_modes(mode, amount, split, day)

        progress = lead_progress_map.get(act.get("lead_id"))
        session = lead_session_map.get(act.get("lead_id")) or {}
        # The listed price and what was taken off it, both written onto the activity by
        # v3_packages when the collection was confirmed. `discount` was hardcoded to zero
        # here, so nothing downstream could see a negotiated price at all.
        #
        # gross stays what was actually collected — every total, day, branch and payment
        # mode on this payload is summed from it — so the discount rides alongside rather
        # than redefining it. discount_amount is negative when more than the listed fee was
        # collected; it is passed through as-is and left to the caller to read.
        discount_amount = act.get("discount_amount")
        transactions.append({
            "id": act.get("id", ""),
            "transaction_id": act.get("transaction_id") or "",
            "date": act.get("created_at", ""),
            "branch_name": bname,
            "source": category,
            "gross": amount,
            "discount": float(discount_amount) if discount_amount is not None else 0.0,
            "original_amount": act.get("original_amount"),
            "discount_reason": act.get("discount_reason"),
            "tax": 0.0,
            "net": amount,
            "collected_by": act.get("created_by", ""),
            "lead_id": act.get("lead_id", ""),
            "client_name": lead_name_map.get(act.get("lead_id"), "Unknown"),
            "phone": lead_phone_map.get(act.get("lead_id"), ""),
            "patient_number": lead_patient_no_map.get(act.get("lead_id"), ""),
            "payment_mode": mode,
            # Empty unless this was a split. The mode above still says "split" -- it is
            # what the record says and what a receipt printed -- and this says what the
            # split was made of, so a reader can show the tenders and count each one
            # under its own mode.
            "payment_split": split,
            "client_balance": lead_balance_map.get(act.get("lead_id"), 0.0),
            "payment_paid_amount": progress["paid_amount"] if progress else None,
            "payment_due_amount": progress["due_amount"] if progress else None,
            "payment_due_date": progress["due_date"] if progress else None,
            "session_package_label": session.get("package_label"),
            "session_total": session.get("total"),
            "session_paid": session.get("paid"),
            "session_due": session.get("due"),
            "session_status": session.get("status"),
            # Set only via POST /finance/transactions/{id}/approve — see get_branch_finance
            # for why this lives on the activity record itself rather than a second table.
            **_approval_state(act),
        })

    # Fitsiomax Store counter sales — tablets, supplements and equipment handed over the
    # desk. They come from their own ledger rather than the lead activity trail because a
    # walk-in buying a strip of painkillers is not a lead, and inventing a lead to make the
    # money countable would put a patient record behind every sale. Same money either way,
    # so it belongs in the same total.
    store_query = {"kind": "sale"}
    if branch_id:
        store_query["branch_id"] = branch_id
    if date_query:
        store_query["created_at"] = date_query
    store_sales = await v3_col("inventory_movements").find(store_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    if vertical_mode in ("online", "offline"):
        store_sales = [s for s in store_sales if (s.get("branch_id") in online_branch_ids) == (vertical_mode == "online")]

    store_total = 0.0
    for sale in store_sales:
        amount = float(sale.get("amount") or 0)
        store_total += amount
        bid = sale.get("branch_id")
        bname = _branch_label(bid, branch_name_map)
        day = (sale.get("created_at") or "")[:10]
        mode = sale.get("payment_mode") or "unknown"

        d = by_day.setdefault(day, _empty_day(day))
        d["store"] = d.get("store", 0.0) + amount

        b = by_branch_acc.setdefault(bid or "unknown", _empty_branch(bid, bname))
        b["store_total"] = b.get("store_total", 0.0) + amount

        _tally_modes(mode, amount, [], day)

        transactions.append({
            "id": sale.get("id", ""),
            "transaction_id": sale.get("transaction_id") or "",
            "date": sale.get("created_at", ""),
            "branch_name": bname,
            "source": "store",
            # Which Store shelf it came off, and what was actually handed over. Nothing
            # else in this payload carries an item, so the Store Payment tab reads these
            # and every other tab ignores them.
            "store_category": sale.get("category", ""),
            "item_name": sale.get("item_name", ""),
            "qty": sale.get("qty", 0),
            "gross": amount,
            # Genuinely zero, not unset: a counter sale is rung up at the shelf price and
            # has no negotiated-fee concept. Carried anyway so both halves of this list
            # have one shape.
            "discount": 0.0,
            "original_amount": None,
            "discount_reason": None,
            "tax": 0.0,
            "net": amount,
            "collected_by": sale.get("by_user_name", ""),
            # No lead: a counter sale is to whoever was standing there. Left empty rather
            # than faked, so the client-history eye and the Payment Paid roll-up — both
            # keyed on a lead — skip these instead of opening on nothing.
            "lead_id": "",
            "client_name": (sale.get("customer_name") or "").strip() or "Counter sale",
            "phone": "",
            "payment_mode": mode,
            # Always empty: a counter sale takes one mode (see VALID_PAYMENT_MODES in
            # v3_inventory.py), so there is nothing to break down. Carried so every row
            # in this list is one shape and no reader has to test for the key.
            "payment_split": [],
            "client_balance": 0.0,
            # Store sales aren't reviewed here — see approve_transaction's docstring —
            # so this stays permanently false rather than left out, keeping every
            # transaction dict in this list the same shape.
            "approved": False,
            "approved_by": "",
            "approved_at": "",
            "income_requested": bool(sale.get("income_requested")),
            "income_requested_by": sale.get("income_requested_by") or "",
            "income_requested_at": sale.get("income_requested_at") or "",
        })

    # Zumba class fees. Like the store sales above, they come from their own collection
    # rather than the lead activity trail — v3_zumba.py keeps the money on the
    # registration because a class fee is flat, has no package or installments behind it,
    # and hanging it on the leads' fee machinery would have meant inventing a lead per
    # dancer. Same money either way, so it belongs in the same total.
    #
    # fee_paid, never fee_amount: what was agreed is not what is in the drawer, and every
    # other figure on this payload is money actually collected.
    zumba_query = {}
    if branch_id:
        zumba_query["branch_id"] = branch_id
    if date_query:
        zumba_query["created_at"] = date_query
    zumba_rows = await v3_col("zumba_registrations").find(zumba_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    if vertical_mode in ("online", "offline"):
        zumba_rows = [z for z in zumba_rows if (z.get("branch_id") in online_branch_ids) == (vertical_mode == "online")]

    zumba_total = 0.0
    for reg in zumba_rows:
        amount = float(reg.get("fee_paid") or 0)
        if amount <= 0:
            continue  # registered but not paid — counted by the Zumba tab, not by revenue
        zumba_total += amount
        bid = reg.get("branch_id")
        bname = _branch_label(bid, branch_name_map)
        day = (reg.get("created_at") or "")[:10]
        # Off the registration, which does record it: the single mode when the fee
        # arrived in one piece, "split" when it came in several. This was hardcoded to
        # "unknown", which put every rupee of class money in a bucket the Cash/UPI/Card
        # pills can never match -- so picking any mode dropped Zumba from the total
        # even though the mode was sitting on the record all along.
        mode = reg.get("payment_mode") or "unknown"
        # A class fee can be split across two tenders like any other -- the registration
        # keeps them as payment_lines, so there is nothing to parse.
        zumba_split = _lines_to_split(reg.get("payment_lines"))

        d = by_day.setdefault(day, _empty_day(day))
        d["zumba"] = d.get("zumba", 0.0) + amount

        b = by_branch_acc.setdefault(bid or "unknown", _empty_branch(bid, bname))
        b["zumba_total"] = b.get("zumba_total", 0.0) + amount

        _tally_modes(mode, amount, zumba_split, day)

        transactions.append({
            "id": reg.get("id", ""),
            "transaction_id": "",
            "date": reg.get("created_at", ""),
            "branch_name": bname,
            "source": "zumba",
            "gross": amount,
            # A class fee is the flat price; there is no listed-versus-collected concept
            # to discount against. Carried so every transaction in this list is one shape.
            "discount": 0.0,
            "original_amount": None,
            "discount_reason": None,
            "tax": 0.0,
            "net": amount,
            "collected_by": reg.get("created_by", ""),
            # No lead behind a dancer, same as a counter sale — left empty rather than
            # faked, so the client-history eye skips these instead of opening on nothing.
            "lead_id": "",
            "client_name": (reg.get("name") or "").strip() or "Zumba registration",
            "phone": reg.get("phone", ""),
            "payment_mode": mode,
            "payment_split": zumba_split,
            "client_balance": max(float(reg.get("fee_amount") or 0) - amount, 0.0),
            # Read off the registration now that a class fee can actually be approved.
            # Hardcoded False was true while the Approvals tab could not see Zumba at
            # all; leaving it would have shown every signed-off class fee as still
            # pending on this page, for good.
            **_approval_state(reg),
        })

    # Gym memberships, on exactly the terms Zumba's are above: v3_fitness.py keeps the
    # money on the registration because a membership is a flat fee with no package or
    # installments behind it, so there is no lead-fee trail for this loop to have found it
    # in. It was the one desk taking money that never reached this page — collected at the
    # branch, counted by the Fitness tab, and invisible to every figure an accountant looks
    # at.
    #
    # fee_paid, never fee_amount, like every other figure on this payload: what was agreed
    # is not what is in the drawer.
    fitness_query = {}
    if branch_id:
        fitness_query["branch_id"] = branch_id
    if date_query:
        fitness_query["created_at"] = date_query
    fitness_rows = await v3_col("fitness_registrations").find(fitness_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    if vertical_mode in ("online", "offline"):
        fitness_rows = [f for f in fitness_rows if (f.get("branch_id") in online_branch_ids) == (vertical_mode == "online")]

    fitness_total = 0.0
    for reg in fitness_rows:
        amount = float(reg.get("fee_paid") or 0)
        if amount <= 0:
            continue  # signed up but not paid — the Fitness tab's question, not revenue's
        fitness_total += amount
        bid = reg.get("branch_id")
        bname = _branch_label(bid, branch_name_map)
        day = (reg.get("created_at") or "")[:10]
        # Read off the record rather than hardcoded, so the Cash/UPI/Card pills can match
        # it — the mistake Zumba's loop above had to be corrected for.
        mode = reg.get("payment_mode") or "unknown"
        fitness_split = _lines_to_split(reg.get("payment_lines"))

        d = by_day.setdefault(day, _empty_day(day))
        d["fitness"] = d.get("fitness", 0.0) + amount

        b = by_branch_acc.setdefault(bid or "unknown", _empty_branch(bid, bname))
        b["fitness_total"] = b.get("fitness_total", 0.0) + amount

        _tally_modes(mode, amount, fitness_split, day)

        transactions.append({
            "id": reg.get("id", ""),
            "transaction_id": "",
            "date": reg.get("created_at", ""),
            "branch_name": bname,
            "source": "fitness",
            "gross": amount,
            # A membership is a flat price, so there is no listed-versus-collected gap to
            # discount against. Carried anyway so every row in this list is one shape.
            "discount": 0.0,
            "original_amount": None,
            "discount_reason": None,
            "tax": 0.0,
            "net": amount,
            "collected_by": reg.get("created_by", ""),
            # No lead behind a gym member, same as a counter sale — left empty rather than
            # faked, so the client-history eye skips these instead of opening on nothing.
            "lead_id": "",
            "client_name": (reg.get("name") or "").strip() or "Fitness registration",
            "phone": reg.get("phone", ""),
            "payment_mode": mode,
            "payment_split": fitness_split,
            "client_balance": max(float(reg.get("fee_amount") or 0) - amount, 0.0),
            **_approval_state(reg),
        })

    total_collected = consultation_total + session_total + diet_total + store_total + zumba_total + rehab_total + fitness_total
    trend = sorted(by_day.values(), key=lambda r: r["date"])
    for r in trend:
        r["total"] = r["consultation"] + r["session"] + r["diet"] + r["store"] + r.get("zumba", 0.0) + r.get("rehab", 0.0) + r.get("fitness", 0.0)
    for r in by_branch_acc.values():
        r["total_revenue"] = r["consultation_total"] + r["session_total"] + r["diet_total"] + r["store_total"] + r.get("zumba_total", 0.0) + r.get("rehab_total", 0.0) + r.get("fitness_total", 0.0)
    by_branch = sorted(by_branch_acc.values(), key=lambda r: -r["total_revenue"])

    untouched_stages = {None} | await entry_branch_stage_names()
    pending_leads_raw = [
        l for l in leads
        if not (l.get("consultation_fee") or l.get("package_paid") or l.get("treatment_fee_paid"))
        and l.get("branch_stage") not in untouched_stages
    ]
    pending_count = len(pending_leads_raw)
    pending_leads = [
        {
            "lead_id": l["id"],
            "client_name": l.get("name", "Unknown"),
            "phone": l.get("phone", ""),
            "branch_name": branch_name_map.get(l.get("branch_id"), ""),
            "stage": l.get("branch_stage") or "—",
        }
        for l in pending_leads_raw
    ]

    # Accountant Manage > Outstanding Amount — every client who still owes something,
    # and > Payment Schedules — every Partial Payment installment (paid or not), so
    # the accountant can see the whole schedule per client, not just what's due.
    outstanding_clients = []
    payment_schedule = []
    for l in leads:
        balance = lead_balance_map.get(l["id"], 0.0)
        if balance > 0:
            detail = _lead_outstanding_detail(l, today)
            outstanding_clients.append({
                "lead_id": l["id"],
                "client_name": l.get("name", "Unknown"),
                "phone": l.get("phone", ""),
                "email": l.get("email", ""),
                "branch_name": branch_name_map.get(l.get("branch_id"), ""),
                "balance": detail["balance"],
                "total_bill": detail["total_bill"],
                "paid_amount": detail["paid_amount"],
                "due_date": detail["due_date"],
                "status": detail["status"],
                "next_installment_number": detail["next_installment_number"],
                "next_installment_fee": detail["next_installment_fee"],
                "next_installment_amount": detail["next_installment_amount"],
                "next_installment_fee_label": FEE_SCHEDULES[detail["next_installment_fee"]]["label"] if detail["next_installment_fee"] else None,
            })
        # Every fee's schedule, not only the Treatment Fee's. A schedule is a schedule
        # whichever fee left it — a Consultation Fee part paid today with the rest due
        # Friday is exactly the thing this table exists to show — and each row carries
        # the fee it belongs to so a collect action knows which one to post against.
        for fee, cfg in FEE_SCHEDULES.items():
            installments = _fee_installments(l, fee)
            if not installments:
                continue
            installments_total = len(installments)
            installments_paid = len([i for i in installments if i.get("paid")])
            for idx, inst in enumerate(installments, start=1):
                payment_schedule.append({
                    "lead_id": l["id"],
                    "client_name": l.get("name", "Unknown"),
                    "phone": l.get("phone", ""),
                    "branch_name": branch_name_map.get(l.get("branch_id"), ""),
                    # "session" kept for the Treatment Fee so nothing reading this
                    # table by its old category has to change.
                    "category": "session" if fee == "treatment" else fee,
                    "fee": fee,
                    "fee_label": cfg["label"],
                    "installment_number": idx,
                    "amount": inst.get("amount", 0),
                    "due_date": inst.get("due_date", ""),
                    "status": _installment_status(inst, today),
                    "installments_total": installments_total,
                    "installments_paid": installments_paid,
                })
    outstanding_clients.sort(key=lambda r: -r["balance"])
    payment_schedule.sort(key=lambda r: r["due_date"])

    # Off the full list, not the 500-row slice returned below — a branch with more than
    # 500 collections in the window would otherwise under-count its own approved total.
    total_approved = sum(t["gross"] for t in transactions if t["approved"])

    return {
        "kpis": {
            "total_collected": total_collected,
            "pending_count": pending_count,
            "refunds": 0.0,  # not tracked yet — no refund flow exists in the system
            "net_revenue": total_collected,
            # Reviewed via the Accountant's own Approvals tab — see approve_transaction.
            # Store sales are never approvable, so this can never reach total_collected.
            "total_approved": total_approved,
            "total_pending_approval": total_collected - total_approved,
        },
        "breakdown": {
            "consultation_revenue": consultation_total,
            "session_revenue": session_total,
            "diet_revenue": diet_total,
            "store_revenue": store_total,
            "zumba_revenue": zumba_total,
            "rehab_revenue": rehab_total,
            "fitness_revenue": fitness_total,
            "consultation_pct": round(consultation_total / total_collected * 100, 1) if total_collected else 0,
            "session_pct": round(session_total / total_collected * 100, 1) if total_collected else 0,
            "diet_pct": round(diet_total / total_collected * 100, 1) if total_collected else 0,
            "store_pct": round(store_total / total_collected * 100, 1) if total_collected else 0,
            "zumba_pct": round(zumba_total / total_collected * 100, 1) if total_collected else 0,
            "fitness_pct": round(fitness_total / total_collected * 100, 1) if total_collected else 0,
            "rehab_pct": round(rehab_total / total_collected * 100, 1) if total_collected else 0,
        },
        "trend": trend,
        "by_branch": by_branch,
        "payment_modes": payment_modes,
        # Rounded on the way out: these are summed floats, and a drawer told it should hold
        # Rs.39,000.000000004 is a drawer that can never be made to balance.
        "by_day_modes": {
            day: {mode: round(amount, 2) for mode, amount in modes.items()}
            for day, modes in by_day_modes.items()
        },
        "transactions": sorted(transactions, key=lambda t: t["date"], reverse=True)[:500],
        "outstanding_clients": outstanding_clients,
        "payment_schedule": payment_schedule,
        "pending_leads": pending_leads,
    }


@router.get("/finance/client/{lead_id}")
async def client_transaction_history(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "physio", "business_dev")),
):
    """Transactions History > eye icon — one client's full profile, every payment
    they've made, their current outstanding balance, and their complete activity
    timeline (stage moves, follow-ups, diagnosis notes — not just payments).
    A physio only ever sees their own assigned patient's history here, read-only —
    used by the Patient Detail page's Payment History tab."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Client not found")
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Client not found")
    if is_physio_role(user.role):
        # Every record they hold, not the one row that happens to carry the login link.
        # Through find_one this was the fourth place reading a physio's identity its own
        # way, and here it denies rather than empties: a physio whose patient was booked
        # against a duplicate row of themselves was told, on their own patient's Payment
        # History tab, that the client did not exist. See resolve_physio_doctor.
        doctor = await resolve_physio_doctor(user.id, user.role)
        ids = (doctor or {}).get("physio_ids") or []
        # Rehab counts as theirs here too, for the reason physio_owns_lead sets out.
        if not ids or not await physio_owns_lead(ids, lead_id):
            raise HTTPException(status_code=404, detail="Client not found")

    branch_name = ""
    if lead.get("branch_id"):
        branch = await v3_col("branches").find_one({"id": lead["branch_id"]}, {"_id": 0, "branch_name": 1})
        branch_name = (branch or {}).get("branch_name", "")

    today = datetime.now(timezone.utc).date().isoformat()
    activity = await v3_col("lead_activity").find({"lead_id": lead_id}, {"_id": 0}).sort("created_at", -1).to_list(500)

    first_installment_amount = None
    if lead.get("treatment_fee_payment_mode") == "partial":
        lead_installments = (lead.get("treatment_fee_payment_details") or {}).get("installments") or []
        if lead_installments:
            first_installment_amount = lead_installments[0].get("amount")

    transactions = []
    for act in activity:
        if act.get("action") not in REVENUE_ACTIONS:
            continue
        details = act.get("details", "")
        category = _revenue_category(act.get("action", ""))
        mode = _parse_payment_mode(details)
        amount = _parse_rs_amount(details)
        if category == "session" and mode == "partial" and first_installment_amount is not None:
            # The logged Rs. figure is the Partial Payment schedule's total, not what
            # was actually collected at that moment — see revenue_overview for detail.
            amount = first_installment_amount
        transactions.append({
            "id": act.get("id", ""),
            "transaction_id": act.get("transaction_id") or "",
            "date": act.get("created_at", ""),
            "source": category,
            "amount": amount,
            "payment_mode": mode,
            "details": details,
            "collected_by": act.get("created_by", ""),
            # Who took it, in their role at the time — "Priya R. · Branch Admin" reads as
            # a record; the name alone doesn't say in what capacity.
            "collected_by_role": act.get("created_by_role", ""),
            "receipt_no": f"RCPT-{act.get('id', '')[-6:].upper()}" if act.get("id") else None,
            "original_amount": act.get("original_amount"),
            "discount_amount": act.get("discount_amount"),
            "discount_reason": act.get("discount_reason"),
        })

    balance = _lead_outstanding_balance(lead)
    outstanding_detail = _lead_outstanding_detail(lead, today)
    installments = (lead.get("treatment_fee_payment_details") or {}).get("installments") or []
    session = _lead_session_summary(lead)

    # A collected installment carries how it was paid and the reference that proves it
    # (UTR, cheque number, the account's last four). Those are written at collection
    # time but were never returned here, so the Client Details popup had no way to show
    # them -- the card number itself is never stored, only the last four digits.
    #
    # Every fee's schedule, each row saying which fee it belongs to: a client can owe on
    # more than one at a time (a part-paid Consultation Fee and a part-paid Diet Fee are
    # two debts, not one), and a row that did not name its fee could not be collected
    # against the right one. Numbers restart per fee, so "fee + number" is what
    # identifies a row here, not the number alone.
    schedule = [
        {
            "fee": fee,
            "fee_label": FEE_SCHEDULES[fee]["label"],
            "installment_number": idx,
            "amount": inst.get("amount", 0),
            "due_date": inst.get("due_date", ""),
            "status": _installment_status(inst, today),
            "payment_mode": inst.get("payment_mode"),
            "upi_transaction_id": inst.get("upi_transaction_id"),
            "upi_utr": inst.get("upi_utr"),
            "card_transaction_id": inst.get("card_transaction_id"),
            "account_last4": inst.get("account_last4"),
            "account_holder_name": inst.get("account_holder_name"),
            "bank_name": inst.get("bank_name"),
            "ifsc_code": inst.get("ifsc_code"),
            "cheque_number": inst.get("cheque_number"),
            "transfer_reference": inst.get("transfer_reference"),
            "transaction_id": inst.get("transaction_id"),
        }
        for fee in FEE_SCHEDULES
        for idx, inst in enumerate(_fee_installments(lead, fee), start=1)
    ]

    consultation_status = None
    if lead.get("package_id"):
        # A confirmed collection (even a negotiated discount below the assigned
        # price) counts as fully paid -- not still-pending -- since it's a
        # deliberate confirmed payment, not a partial/outstanding one.
        consultation_status = "paid" if lead.get("package_paid") is not None else "pending"

    return {
        "client": {
            "id": lead["id"],
            "name": lead.get("name", "Unknown"),
            "phone": lead.get("phone", ""),
            "email": lead.get("email", ""),
            "branch_name": branch_name,
            # Identity and provenance the Client Details header shows. All of it already
            # lives on the lead; it simply wasn't being returned here.
            "patient_number": lead.get("patient_number"),
            "first_seen": lead.get("created_at"),
            "source": lead.get("source_tab") or lead.get("source_type") or "",
            "assigned_physio_name": lead.get("assigned_physio_name") or "",
        },
        "balance": balance,
        "balance_status": outstanding_detail["status"] if balance > 0 else "paid",
        "status": "done" if balance <= 0 else "processing",
        "last_payment_date": transactions[0]["date"] if transactions else None,
        "next_due_date": outstanding_detail["due_date"],
        "payment_details": {
            "consultation_fee_total": lead.get("package_price"),
            "consultation_fee_paid": lead.get("package_paid"),
            "consultation_payment_mode": lead.get("package_payment_mode"),
            "consultation_status": consultation_status,
            "treatment_fee_paid": lead.get("treatment_fee_paid"),
            "treatment_payment_mode": lead.get("treatment_fee_payment_mode"),
            "installments_total": len(installments) if installments else None,
            "installments_paid": len([i for i in installments if i.get("paid")]) if installments else None,
            "session_package_label": session["package_label"],
            # The course as quoted by the consultant: how many sessions and at what price.
            # Distinct from session_total, which is only what has actually been scheduled
            # for collection — a quoted-but-unpurchased package has a price and no total.
            "session_package_sessions": lead.get("session_package_sessions"),
            "session_package_price": lead.get("session_package_price"),
            "session_total": session["total"],
            "session_paid": session["paid"],
            "session_due": session["due"],
            "session_status": session["status"],
            # The next thing owed on any fee, not only the Treatment Fee's schedule —
            # both halves of the answer, since the number alone no longer identifies a
            # row now that every fee can have one.
            "next_installment_number": outstanding_detail["next_installment_number"],
            "next_installment_fee": outstanding_detail["next_installment_fee"],
            "next_installment_label": (
                FEE_SCHEDULES[outstanding_detail["next_installment_fee"]]["label"]
                if outstanding_detail["next_installment_fee"] else None
            ),
        },
        "schedule": schedule,
        "transactions": transactions,
        "timeline": activity,
    }


@router.post("/finance/installment/{lead_id}/{installment_number}/mark-paid")
async def mark_installment_paid(
    lead_id: str,
    installment_number: int,
    payload: V3MarkInstallmentPaidInput = V3MarkInstallmentPaidInput(),
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "accountant", "business_dev")),
):
    """Payment Schedules — mark one installment as collected.
    installment_number is 1-based (matches what the Payment Schedules table shows).
    When payload.payment_mode is sent (the Branch Admin's per-row Collect popup),
    this records the same mode-specific details a fresh collection does and logs that
    fee's own activity entry, so it shows up in Session Collections / Accountant Manage
    exactly like one. Omitting payment_mode keeps the old bare "just flip paid" behavior
    (e.g. the Outstanding Amount panel's quick-collect action).

    payload.fee names which fee's schedule the row belongs to — any of the five can leave
    a balance behind, and a balance is collectable under any payment mode regardless of
    how the first part of the fee was paid. It defaults to the Treatment Fee, so callers
    written before the other four could carry a balance keep working unchanged."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Client not found")
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Client not found")

    cfg = FEE_SCHEDULES[payload.fee]
    details = lead.get(cfg["details"]) or {}
    installments = details.get("installments") or []
    idx = installment_number - 1
    if idx < 0 or idx >= len(installments):
        raise HTTPException(status_code=404, detail="Installment not found")
    if installments[idx].get("paid"):
        raise HTTPException(status_code=400, detail="This installment has already been collected")

    activity_details = None
    transaction_id = None
    if payload.payment_mode:
        mode = payload.payment_mode
        amount = payload.amount if payload.amount is not None else installments[idx].get("amount", 0)
        # One installment paid half in cash and half by UPI -- the same split the fee
        # itself can arrive in, and the same rules: every tender settles today, the
        # server sums them rather than trusting a total sent beside them, and the mode
        # on the record reads "split" because naming either half would be half a lie.
        lines = payload.payment_lines or []
        if lines:
            for line in lines:
                if line.mode not in SPLIT_TENDER_MODES:
                    raise HTTPException(status_code=400, detail=f"A split payment accepts: {sorted(SPLIT_TENDER_MODES)}")
                if line.amount is None or line.amount <= 0:
                    raise HTTPException(status_code=400, detail="Every payment in a split must be more than zero")
            lines_total = round(sum(line.amount for line in lines), 2)
            if payload.amount is not None and abs(payload.amount - lines_total) > 0.01:
                raise HTTPException(
                    status_code=400,
                    detail=f"The payments add up to Rs.{lines_total:g}, but the installment being collected is Rs.{payload.amount:g}",
                )
            amount = lines_total
            mode = "split"
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be greater than zero")

        mode_fields = {}
        detail_suffix = ""
        if lines:
            # Counted against the tender's own amount, never the installment total --
            # see the same zip in collect_treatment_fee.
            line_notes = [
                _settle_cash_count(ln.denominations, ln.amount, f" for the Rs.{ln.amount:g} cash payment") if ln.mode == "cash" else {}
                for ln in lines
            ]
            mode_fields = {"payment_lines": [
                {
                    "mode": ln.mode,
                    "amount": ln.amount,
                    "reference": (ln.reference or "").strip(),
                    "denominations": counted,
                }
                for ln, counted in zip(lines, line_notes)
            ]}
            detail_suffix = " · Split: " + ", ".join(
                f"Rs.{ln.amount:g} {ln.mode}"
                + (f" ({ln.reference.strip()})" if (ln.reference or "").strip() else "")
                + (f" [{_notes_label(counted)}]" if counted else "")
                for ln, counted in zip(lines, line_notes)
            )
        elif mode == "cash":
            # The installment's own notes. Optional, and refused when they disagree with
            # the money -- the fee's rule, applied to the piece of it being collected.
            counted = _settle_cash_count(payload.denominations, amount)
            if counted:
                mode_fields = {"denominations": counted}
                detail_suffix = f" · Counted {_notes_label(counted)}"
        elif mode == "upi":
            # UTR is named in the log only when there is one. The Collect popups stopped
            # asking for it, so the old unconditional line wrote "UTR " with nothing after
            # it onto every installment collected from here.
            txn = (payload.upi_transaction_id or "").strip()
            utr = (payload.upi_utr or "").strip()
            # The company UPI ID it landed in, when the desk picked one -- same rule as
            # the whole fee's, in build_payment_details (routers/v3_packages.py).
            bank_upi = (payload.upi_id or "").strip()
            mode_fields = {"upi_transaction_id": txn}
            if utr:
                mode_fields["upi_utr"] = utr
            if bank_upi:
                mode_fields["upi_id"] = bank_upi
            if txn or utr:
                detail_suffix = f" · UPI txn {txn}"
                if utr:
                    detail_suffix += f", UTR {utr}"
                if bank_upi:
                    detail_suffix += f" to {bank_upi}"
        elif mode == "card":
            # One field: the transaction id off the terminal. Same rule as a card payment
            # against the whole fee -- see build_payment_details in v3_packages.py, which
            # explains why the four bank fields were never the desk's to answer.
            txn = (payload.card_transaction_id or "").strip()
            if not txn:
                raise HTTPException(status_code=400, detail="Card Transaction ID is required")
            mode_fields = {"card_transaction_id": txn}
            detail_suffix = f" · Card txn {txn}"
        elif mode == "cheque":
            if not payload.bank_name or not payload.bank_name.strip() or not payload.cheque_number or not payload.cheque_number.strip():
                raise HTTPException(status_code=400, detail="Bank Name and Cheque Number are required")
            mode_fields = {"bank_name": payload.bank_name.strip(), "cheque_number": payload.cheque_number.strip()}
            detail_suffix = f" · Cheque #{payload.cheque_number.strip()}, {payload.bank_name.strip()}"
        elif mode == "account_transfer":
            if not all([payload.account_number and payload.account_number.strip(), payload.account_holder_name and payload.account_holder_name.strip(),
                        payload.bank_name and payload.bank_name.strip(), payload.ifsc_code and payload.ifsc_code.strip(),
                        payload.transfer_reference and payload.transfer_reference.strip()]):
                raise HTTPException(status_code=400, detail="Account Number, Account Holder Name, Bank Name, IFSC Code and Reference/UTR No. are required")
            last4 = "".join(ch for ch in payload.account_number if ch.isdigit())[-4:]
            mode_fields = {
                "account_last4": last4,
                "account_holder_name": payload.account_holder_name.strip(),
                "bank_name": payload.bank_name.strip(),
                "ifsc_code": payload.ifsc_code.strip().upper(),
                "transfer_reference": payload.transfer_reference.strip(),
            }
            detail_suffix = f" · A/C ****{last4}, {payload.account_holder_name.strip()}, {payload.bank_name.strip()} ({payload.ifsc_code.strip().upper()}) · Ref {payload.transfer_reference.strip()}"

        # Each installment is its own collection, so each earns its own transaction id --
        # the schedule they belong to has none, since scheduling moves no money.
        transaction_id = await generate_transaction_id(lead.get("branch_id"))
        installments[idx] = {**installments[idx], "paid": True, "amount": amount, "payment_mode": mode, "transaction_id": transaction_id, **mode_fields}
        activity_details = f"Collected {cfg['label']} Installment #{installment_number} for '{lead.get(cfg['package']) or cfg['label']}' · Rs.{amount} via {mode}{detail_suffix} · Txn {transaction_id}"
    else:
        installments[idx]["paid"] = True

    # Keep the fee's own *_paid field in step with the money that has actually arrived,
    # but only where it is tracking that. A Partial Payment plan books the whole price the
    # moment the schedule is created, so adding to it here would count the same money
    # twice. A schedule that exists because a collection came up short is the other case:
    # it books only what was handed over that day, so the balance has to be added as it
    # arrives or no revenue total ever sees it.
    #
    # Told apart by the fee's recorded mode, not by which fee it is. This used to also
    # require `payload.fee == "treatment"`, from when the Treatment Fee was the only one
    # that could be put on a Partial Payment plan at all. Every fee can now — they are all
    # collected the same way — and a Consultation or Rehab Fee scheduled that way would
    # otherwise have had each installment added on top of a price already booked in full.
    set_fields = {f"{cfg['details']}.installments": installments}
    if lead.get(cfg["mode"]) != "partial":
        collected = installments[idx].get("amount") or 0
        set_fields[cfg["paid"]] = round((lead.get(cfg["paid"]) or 0) + collected, 2)

    await v3_col("leads").update_one({"id": lead_id}, {"$set": set_fields})

    if activity_details:
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "transaction_id": transaction_id,
            "lead_id": lead_id,
            "action": cfg["action"],
            "details": activity_details,
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": _now(),
        })

    updated_details = {**details, "installments": installments}
    return {"message": "Installment marked as paid", "transaction_id": transaction_id, "balance": _lead_outstanding_balance({**lead, cfg["details"]: updated_details})}


# ---------------------------------------------------------------------------
# Closing Balance -- the day-end count, per branch per day.
# ---------------------------------------------------------------------------
#
# What the desk actually holds when it shuts, set against what the system says it took.
# Three modes are counted because three are what a branch settles in: cash sits in a
# drawer, UPI lands in an account, a card terminal batches out. Each is evidenced by the
# one thing a dispute is traced by, which is why they are not interchangeable fields:
# cash by the notes themselves, UPI by the id the money arrived on, card by the
# terminal's batch/transaction number.
#
# Only what was *counted* is stored. The day's income and expense are not copied in
# beside it: they are already computed, to the rupee, by revenue-overview and
# list_expenses, and a second stored copy is a second total to disagree with the first
# the moment a payment is back-dated. The screen sets the count against those live
# figures and shows the variance; this collection answers "what did the branch count",
# and nothing else.
#
# One record per branch per day, upserted. The count is a soft record by design -- a
# denomination miscounted at closing time is corrected by counting again, not by an
# unlock request to head office.


class ClosingBalanceInput(BaseModel):
    # The day being closed. Defaults to today; a branch counting up after midnight is
    # closing yesterday and says so rather than being told what day it is.
    on: Optional[str] = None
    # Ignored for a Branch Admin, who can only ever close their own branch -- the same
    # rule list_expenses and revenue_overview apply to every figure this sits against.
    branch_id: Optional[str] = None
    # Cash: the notes, counted. Keyed by the note's face value; anything not a note this
    # desk holds is dropped by _denomination_total rather than guessed at.
    cash_denominations: Optional[dict] = None
    # Coins and anything below the smallest note. Its own field because the note ladder
    # stops at ten and a drawer does not: without it a count ending in Rs.7 of change
    # could never be made to balance, and the difference would read as a shortfall.
    cash_coins: Optional[float] = 0
    upi_amount: Optional[float] = 0
    # The id the money arrived on. Required once there is UPI money to account for --
    # an amount with nothing to trace it to is a figure, not a reconciliation.
    upi_id: Optional[str] = ""
    card_amount: Optional[float] = 0
    # The terminal's batch or transaction number, on the same rule as upi_id above.
    card_transaction_id: Optional[str] = ""
    note: Optional[str] = ""


def _closing_balance_public(row: Optional[dict]) -> Optional[dict]:
    """One stored count, with its totals worked out rather than stored.

    cash_total and total are derived every time they are read. Storing them would be
    storing an answer that can fall out of step with the notes it was added up from --
    and the notes are the record here, not the sum.
    """
    if not row:
        return None
    counted_cash, notes = _denomination_total(row.get("cash_denominations"))
    coins = round(float(row.get("cash_coins") or 0), 2)
    cash_total = round(counted_cash + coins, 2)
    upi = round(float(row.get("upi_amount") or 0), 2)
    card = round(float(row.get("card_amount") or 0), 2)
    return {
        "on": row.get("on", ""),
        "branch_id": row.get("branch_id"),
        "cash_denominations": notes,
        "cash_notes_total": round(counted_cash, 2),
        "cash_coins": coins,
        "cash_total": cash_total,
        "upi_amount": upi,
        "upi_id": row.get("upi_id") or "",
        "card_amount": card,
        "card_transaction_id": row.get("card_transaction_id") or "",
        "total": round(cash_total + upi + card, 2),
        "note": row.get("note") or "",
        "counted_by": row.get("counted_by") or "",
        "counted_at": row.get("counted_at") or "",
        "updated_by": row.get("updated_by") or "",
        "updated_at": row.get("updated_at") or "",
    }


def _previous_day(on: str) -> str:
    return (datetime.fromisoformat(on).date() - timedelta(days=1)).isoformat()


# ---------------------------------------------------------------------------
# Closed Books -- the day signed off, and whether the money matched.
# ---------------------------------------------------------------------------
#
# A count and a closed book are two different statements, which is why they are two
# collections. The count says "this is what was in the drawer". The book says "I have
# looked at that against what the day says it took, and I am signing the day off" -- and
# it is that second statement, with a name and a time on it, that somebody is answerable
# for later.
#
# So this is the one place in this file that DOES store its totals. Everywhere else the
# figures are derived on read, because a stored copy can fall out of step with what it was
# copied from. Here that is exactly the point: a book is what was true at the moment it was
# signed. A payment back-dated into a closed day would otherwise turn a book that was
# closed as matched into one that reads short a week later, and nobody could tell whether
# the person who closed it was wrong or the ground moved under them. The count stays live
# and the book stays frozen, and the difference between them is the audit.
#
# Closing locks the count for that day -- see save_closing_balance, which refuses once a
# book is closed. Without that a close is a label rather than a close. Reopening is an
# accountant's to do, not the branch's, and it keeps the original signature: a book that
# was closed and reopened is a fact about the day, not something to be tidied away.


class CloseBookInput(BaseModel):
    on: Optional[str] = None
    # Ignored for a Branch Admin, who closes their own branch's book and nobody else's.
    branch_id: Optional[str] = None


class ReopenBookInput(BaseModel):
    on: Optional[str] = None
    branch_id: Optional[str] = None
    # Why it is being opened again. Required -- a book that was signed off and then
    # unsigned with no reason attached is the one row in a month an auditor will ask about.
    reason: Optional[str] = ""


def _closed_book_public(row: Optional[dict]) -> Optional[dict]:
    """One book as a screen reads it.

    `closed` is derived from the status rather than stored twice: a reopened book keeps
    everything it was closed with, and only the status says it is open again.
    """
    if not row:
        return None
    status = row.get("status") or "closed"
    return {
        "on": row.get("on", ""),
        "branch_id": row.get("branch_id"),
        "status": status,
        "closed": status == "closed",
        "matched": bool(row.get("matched")),
        "counted": row.get("counted") or {},
        "expected": row.get("expected") or {},
        "difference": round(float(row.get("difference") or 0), 2),
        # The explanation that stood at the moment of signing, snapshotted off the count.
        # Not a second note to type: whoever closes a short day has already said why on the
        # count itself, and asking twice gets the second one left blank.
        "note": row.get("note") or "",
        # Who counted the drawer, snapshotted beside who signed it off. Usually two
        # different people, and on a day that turns out to be short, which of the two is
        # being asked about matters.
        "counted_by": row.get("counted_by") or "",
        "closed_by": row.get("closed_by") or "",
        "closed_by_role": row.get("closed_by_role") or "",
        "closed_at": row.get("closed_at") or "",
        "reopened_by": row.get("reopened_by") or "",
        "reopened_at": row.get("reopened_at") or "",
        "reopen_reason": row.get("reopen_reason") or "",
    }


async def _day_figures(branch_id: Optional[str], day: str, user: V3UserOut) -> dict:
    """What one day should have left in the drawer, worked out the way the screen does.

    Read back through revenue-overview and list_expenses rather than re-summed here, so
    the book is signed against the same figures the branch was looking at when it signed.
    Both are called as plain functions -- their Depends defaults are only defaults -- and
    both re-apply their own branch scoping to `user`, so a Branch Admin cannot close
    somebody else's day by naming their branch.

    No mode carries overnight. Cash used to: the drawer was taken to open on whatever the
    night before had been counted into it, so a branch that took Rs.20,000 in cash on top
    of a Rs.41,000 close was asked to find Rs.61,000 in it. But the takings are banked or
    handed over each night, so the drawer opens each morning at nothing -- the same as UPI
    and a card batch, which settle to a bank. Every mode is now just the day's own takings
    less what was refunded or paid out by it.

    Cash now carries overnight again, but properly: once the accountant has set a branch's
    opening cash (see _branch_cash_figures), the cash the drawer should hold that evening
    is the running box balance as of that day — every rupee taken, less what was spent,
    less what has been handed over — not the day's takings alone. Until opening is set the
    old day-only figure stands, so a branch that has not been switched over is unaffected.

    UPI and a card batch still settle to a bank each night, so those two stay the day's
    own takings less what went out by them.
    """
    rev = await revenue_overview(start_date=day, end_date=day, branch_id=branch_id, user=user)
    exp = await list_expenses(start_date=day, end_date=day, branch_id=branch_id, user=user)
    income = rev.get("payment_modes") or {}
    spent = exp.get("payment_modes") or {}

    def mode(book: dict, key: str) -> float:
        return round(float(book.get(key) or 0), 2)

    day_cash = round(mode(income, "cash") - mode(spent, "cash"), 2)
    cash_expected = day_cash
    if branch_id:
        box = await _branch_cash_figures(branch_id, user, up_to=day)
        if box["opening_set"]:
            cash_expected = box["cash_in_hand"]

    expected = {
        "cash": cash_expected,
        "upi": round(mode(income, "upi") - mode(spent, "upi"), 2),
        "card": round(mode(income, "card") - mode(spent, "card"), 2),
    }
    expected["total"] = round(expected["cash"] + expected["upi"] + expected["card"], 2)
    return {"income": income, "expense": spent, "expected": expected}


async def _book_for(branch_id: Optional[str], day: str) -> Optional[dict]:
    return await v3_col("closed_books").find_one({"branch_id": branch_id, "on": day}, {"_id": 0})


@router.get("/finance/closing-balance")
async def get_closing_balance(
    on: Optional[str] = None,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """The day being closed, and the day before it.

    Yesterday comes back beside today because a closing balance is only meaningful next
    to the one before it -- a drawer that held Rs.12,400 last night and Rs.400 tonight is
    either a day of banking or a day of something wrong, and the count alone cannot say
    which. It is returned here rather than fetched separately so the two can never be
    read from different branches, or different days, by a screen that got its arguments
    wrong.
    """
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
    day = on or datetime.now(timezone.utc).date().isoformat()
    try:
        prev = _previous_day(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")
    # An explicit None matches the org-wide row rather than every branch's: a query with
    # the key left out would hand one branch's count back for another's screen.
    query = {"branch_id": branch_id if branch_id else None}
    today_row = await v3_col("closing_balances").find_one({**query, "on": day}, {"_id": 0})
    prev_row = await v3_col("closing_balances").find_one({**query, "on": prev}, {"_id": 0})
    # The figure each day is judged against, worked out here so the screen shows exactly
    # what close_book will compare the count to — the same _day_figures both call. For a
    # branch whose opening cash is set this is the running cash box as of that evening, not
    # the day's takings alone; see _day_figures.
    figures_today = await _day_figures(branch_id, day, user)
    figures_prev = await _day_figures(branch_id, prev, user)
    return {
        "on": day,
        "branch_id": branch_id,
        "today": _closing_balance_public(today_row),
        "yesterday": _closing_balance_public(prev_row),
        "expected": figures_today["expected"],
        "yesterday_expected": figures_prev["expected"],
        # Whether this day has been signed off, beside the count it was signed off on. Here
        # rather than behind its own request because the two are read together every time:
        # a screen that fetched the count first would offer a Close button on a day that is
        # already closed, for as long as the second request took.
        "book": _closed_book_public(await _book_for(branch_id, day)),
    }


@router.post("/finance/closing-balance")
async def save_closing_balance(
    payload: ClosingBalanceInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Record what the desk holds at the end of one day.

    An upsert on (branch, day) rather than an insert: counting again is how a miscount is
    fixed, and a second row for the same evening would leave two answers to a question
    that has one. Who first counted it is kept apart from who last touched it, so a
    correction is visible as a correction rather than overwriting the fact that one
    happened.
    """
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id
    else:
        branch_id = payload.branch_id or None

    day = payload.on or datetime.now(timezone.utc).date().isoformat()
    try:
        datetime.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")

    counted_cash, notes = _denomination_total(payload.cash_denominations)
    coins = round(float(payload.cash_coins or 0), 2)
    upi = round(float(payload.upi_amount or 0), 2)
    card = round(float(payload.card_amount or 0), 2)
    if coins < 0 or upi < 0 or card < 0:
        raise HTTPException(status_code=400, detail="A counted amount cannot be negative")
    # The reference is what makes the figure checkable, so it is required exactly when
    # there is money to check -- and not before. A branch that took nothing by card is
    # not made to invent a batch number to close its day.
    upi_id = (payload.upi_id or "").strip()
    card_ref = (payload.card_transaction_id or "").strip()
    if upi > 0 and not upi_id:
        raise HTTPException(status_code=400, detail="UPI ID is required for the UPI amount counted")
    if card > 0 and not card_ref:
        raise HTTPException(status_code=400, detail="Card Transaction ID is required for the card amount counted")

    # A closed book is closed. Counting again is how a miscount is fixed, but only up to
    # the moment somebody signs the day off -- after that the figure has been reported as
    # final, and changing what sits underneath a signature without touching the signature
    # is how two people end up holding different answers about the same evening. Reopening
    # is an accountant's call and leaves a mark; see reopen_book.
    book = await _book_for(branch_id, day)
    if book and (book.get("status") or "closed") == "closed":
        raise HTTPException(
            status_code=409,
            detail="The book for this day is closed — an accountant reopens it before the count can change",
        )

    now = _now()
    query = {"branch_id": branch_id, "on": day}
    existing = await v3_col("closing_balances").find_one(query, {"_id": 0})
    doc = {
        "branch_id": branch_id,
        "on": day,
        "cash_denominations": notes,
        "cash_coins": coins,
        "upi_amount": upi,
        "upi_id": upi_id,
        "card_amount": card,
        "card_transaction_id": card_ref,
        "note": (payload.note or "").strip(),
        "updated_by": user.full_name,
        "updated_at": now,
    }
    if existing:
        await v3_col("closing_balances").update_one(query, {"$set": doc})
    else:
        doc["id"] = str(uuid.uuid4())
        doc["counted_by"] = user.full_name
        doc["counted_at"] = now
        await v3_col("closing_balances").insert_one(doc.copy())

    saved = await v3_col("closing_balances").find_one(query, {"_id": 0})
    return {
        "message": "Closing balance updated" if existing else "Closing balance recorded",
        "closing_balance": _closing_balance_public(saved),
    }


@router.get("/finance/closing-balance/history")
async def closing_balance_history(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Every evening this branch counted inside a window, oldest first.

    The endpoint above answers the question a desk closing up asks -- what was counted
    tonight, and what was counted last night. This one answers the different question
    anybody reading back over a week or a month asks: which evenings were counted at all,
    and how each of them came out. They are two endpoints rather than one with a wider
    range because the day view has to reach outside its window for the previous night,
    and a history that quietly did the same would report a day nobody asked for.

    Only what was counted is returned, on the same rule as everything else here: the
    income and expense each day is judged against are live figures owned by
    revenue-overview and list_expenses, and a month of stored copies is a month of totals
    that can drift from them.

    `opening` is the last count made before the window -- the night its first day opens
    on. Without it, the first day of every month would read as a shortfall the size of
    whatever the branch was already holding when the month began.
    """
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
    for label, value in (("start_date", start_date), ("end_date", end_date)):
        if value:
            try:
                datetime.fromisoformat(value)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"{label} must be YYYY-MM-DD")
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=400, detail="The start date is after the end date")

    # An explicit None matches the org-wide row rather than every branch's -- the same
    # reason get_closing_balance spells out above.
    query = {"branch_id": branch_id if branch_id else None}
    window = {}
    if start_date:
        window["$gte"] = start_date
    if end_date:
        window["$lte"] = end_date
    if window:
        query["on"] = window
    rows = await v3_col("closing_balances").find(query, {"_id": 0}).sort("on", 1).to_list(2000)

    opening_row = None
    if start_date:
        opening_row = await v3_col("closing_balances").find_one(
            {"branch_id": branch_id if branch_id else None, "on": {"$lt": start_date}},
            {"_id": 0},
            sort=[("on", -1)],
        )
    # The books over the same window, as their own list rather than folded onto the counts.
    # A book belongs to a day, not to a count -- keeping them apart is what lets a day be
    # counted and not yet signed off, which is the state most evenings are in.
    book_rows = await v3_col("closed_books").find(query, {"_id": 0}).sort("on", 1).to_list(2000)
    books = [_closed_book_public(b) for b in book_rows]
    return {
        "branch_id": branch_id,
        "start_date": start_date or "",
        "end_date": end_date or "",
        "opening": _closing_balance_public(opening_row),
        "records": [_closing_balance_public(r) for r in rows],
        "counted_days": len(rows),
        "books": books,
        "closed_days": sum(1 for b in books if b["closed"]),
    }


@router.post("/finance/closing-balance/close-book")
async def close_book(
    payload: CloseBookInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Sign one day off: what was counted, what was expected, and whether they matched.

    The count has to exist first. A book closed over an uncounted evening would be a
    signature on an empty drawer -- it would record that the day matched, because nothing
    counted against nothing always does.

    Whether it matched is decided here rather than taken from the caller, and the figures
    are read back through the same endpoints the screen reads: a client that sent its own
    verdict could sign off a day as balanced by sending the same number twice. The branch
    sees the server's figures once the book comes back, so what is on screen after closing
    is what was actually written down.

    A book is closed on a difference as readily as on a match. A branch that cannot sign
    off a short evening either stops closing its books or makes the drawer say what the
    system wants -- and the second is the failure that matters. The shortfall is recorded,
    with the explanation that stood against the count, and it stays visible.
    """
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id
    else:
        branch_id = payload.branch_id or None

    day = payload.on or datetime.now(timezone.utc).date().isoformat()
    try:
        datetime.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")

    count_row = await v3_col("closing_balances").find_one({"branch_id": branch_id, "on": day}, {"_id": 0})
    if not count_row:
        raise HTTPException(status_code=400, detail="Count this day before closing its book")
    counted = _closing_balance_public(count_row)

    existing = await _book_for(branch_id, day)
    if existing and (existing.get("status") or "closed") == "closed":
        raise HTTPException(status_code=409, detail="This day's book is already closed")

    figures = await _day_figures(branch_id, day, user)
    expected = figures["expected"]
    difference = round(counted["total"] - expected["total"], 2)

    now = _now()
    doc = {
        "branch_id": branch_id,
        "on": day,
        "status": "closed",
        # A rupee either side is a match. The comparison is between two figures each
        # rounded to the paisa, and refusing to call Rs.0.004 a match would report a
        # difference nobody can find in a drawer that only holds coins.
        "matched": abs(difference) < 0.01,
        "counted": {
            "cash": counted["cash_total"],
            "upi": counted["upi_amount"],
            "card": counted["card_amount"],
            "total": counted["total"],
        },
        "expected": expected,
        "difference": difference,
        "note": counted["note"],
        "counted_by": counted["counted_by"],
        "closed_by": user.full_name,
        "closed_by_role": user.role,
        "closed_at": now,
        # Cleared rather than left standing: this row may be a book that was reopened and
        # is now being closed again, and a live book carrying the last reopening's reason
        # reads as one that is open.
        "reopened_by": "",
        "reopened_at": "",
        "reopen_reason": "",
    }
    if existing:
        await v3_col("closed_books").update_one({"branch_id": branch_id, "on": day}, {"$set": doc})
    else:
        doc["id"] = str(uuid.uuid4())
        # Who signed it the first time, kept apart from who signed it last -- the same rule
        # the count itself follows for counted_by and updated_by.
        doc["first_closed_by"] = user.full_name
        doc["first_closed_at"] = now
        await v3_col("closed_books").insert_one(doc.copy())

    saved = await _book_for(branch_id, day)
    return {
        "message": "Book closed — the day matched" if doc["matched"] else "Book closed with a difference",
        "book": _closed_book_public(saved),
    }


@router.post("/finance/closing-balance/reopen-book")
async def reopen_book(
    payload: ReopenBookInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Open a signed-off day again, with the reason on the record.

    Not open to the Branch Admin who closed it, for the reason approve_expense gives:
    signing a day off is a statement to somebody else, and a statement you can withdraw
    unilaterally is not one. The book keeps everything it was closed with -- who signed
    it, when, and what it said at the time -- so a day that was closed and reopened reads
    as exactly that rather than as a day that was never closed.
    """
    branch_id = payload.branch_id or None
    day = payload.on or datetime.now(timezone.utc).date().isoformat()
    try:
        datetime.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Say why the book is being reopened")

    existing = await _book_for(branch_id, day)
    if not existing:
        raise HTTPException(status_code=404, detail="No book has been closed for this day")
    if (existing.get("status") or "closed") != "closed":
        raise HTTPException(status_code=409, detail="This day's book is already open")

    await v3_col("closed_books").update_one(
        {"branch_id": branch_id, "on": day},
        {"$set": {
            "status": "reopened",
            "reopened_by": user.full_name,
            "reopened_at": _now(),
            "reopen_reason": reason,
        }},
    )
    return {
        "message": "Book reopened",
        "book": _closed_book_public(await _book_for(branch_id, day)),
    }


# ---------------------------------------------------------------------------
# Petty Cash -- the tin, and what is left in it.
# ---------------------------------------------------------------------------
#
# Small spending does not go through a bank, and pretending it does is how a branch ends
# up with a month of Rs.60 auto fares nobody can account for. So the tin is a real float
# with a real balance: it is topped up from the drawer, and every small cash expense draws
# it down.
#
# A top-up is an *internal* move -- notes going from the drawer into the tin. The branch
# holds exactly as much cash after it as before, which is why it is deliberately not a
# figure the Closing Balance knows about: the tin is part of the branch's cash, and the
# day-end count already counts every note in the building. Only the expense reduces cash,
# and Closing Balance already subtracts it as an expense. Adding a top-up there as well
# would take the same rupees out twice.
#
# Balance is summed from the movements rather than kept as a running field. A stored
# balance is a number that can drift from the rows that produced it, and here the rows are
# the record -- a tin that says Rs.2,000 with Rs.1,400 of movements behind it is a bug
# nobody can unpick after the fact.

# What counts as small enough to come out of the tin. An expense at or under this, paid in
# cash, is petty cash by definition -- above it is a payment somebody signs for.
PETTY_CASH_LIMIT = 1000.0


def _is_petty_cash_expense(amount: float, payment_mode: str, branch_id) -> bool:
    """Whether one expense comes out of the tin.

    Three things have to be true, and the second is the one worth stating: the tin holds
    notes, so an expense settled by UPI, card or transfer never came out of it however
    small it was. A Rs.400 subscription paid by card is a small expense, not petty cash,
    and drawing the float down for it would leave the tin's balance describing money that
    is still sitting in it.

    An org-wide expense has no tin to come out of -- petty cash belongs to a desk.
    """
    return bool(branch_id) and (payment_mode or "").strip().lower() == "cash" and 0 < amount <= PETTY_CASH_LIMIT


async def _petty_cash_balance(scope=None) -> float:
    """What the tin holds now: every movement ever made on it, added up.

    `delta` is signed at the point it is written -- a top-up is positive, an expense
    negative -- so the balance is one sum rather than a subtraction between two queries
    that could each be filtered slightly differently.

    `scope` is one branch id, a list of them, or None for every tin there is. The list and
    the None are what the Accountant's own Petty Cash tab reads, where the branch filter
    sits on "All Branches" by default and the honest answer is the sum of the tins rather
    than an error -- see get_petty_cash.
    """
    query = {}
    if isinstance(scope, str) and scope:
        query["branch_id"] = scope
    elif isinstance(scope, (list, tuple, set)):
        query["branch_id"] = {"$in": list(scope)}
    rows = await v3_col("petty_cash_movements").find(query, {"_id": 0, "delta": 1}).to_list(20000)
    return round(sum(float(r.get("delta") or 0) for r in rows), 2)


async def _record_petty_cash_movement(*, branch_id, delta, kind, on, note, user, expense_id=None):
    """One line in the tin's book. Written by the expense that caused it, so the two can
    never disagree about whether the money left."""
    doc = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        "on": on,
        "kind": kind,
        # The signed movement, and the plain amount beside it. Both, because the balance
        # wants the sign and every screen showing a row wants the figure without it.
        "delta": round(float(delta), 2),
        "amount": round(abs(float(delta)), 2),
        "expense_id": expense_id,
        "note": (note or "").strip(),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    }
    await v3_col("petty_cash_movements").insert_one(doc.copy())
    return doc


class PettyCashTopUp(BaseModel):
    # Ignored for a Branch Admin, who tops up their own tin and nobody else's.
    branch_id: Optional[str] = None
    amount: float
    on: Optional[str] = None
    note: Optional[str] = ""


@router.get("/finance/petty-cash")
async def get_petty_cash(
    branch_id: Optional[str] = None,
    mode: Optional[str] = None,  # "online" | "offline", off each branch's own vertical
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """The tin: what is in it, and what moved through it.

    `balance` is every movement ever, because that is what is physically in the tin today.
    The listed movements are the window asked for, which is a different question -- a
    branch looking at last month still needs to know what it holds now, or the page would
    tell it to top up a tin that is full.

    No branch means every tin, for the two roles that keep more than one: this reads
    alongside the expense list on the Accountant's own Expense page, whose branch filter
    sits on "All Branches" until somebody moves it, and refusing that with "pick one" made
    the tab open on an error every time. A Branch Admin still gets only their own -- their
    branch is not a filter they set, it is the one they have.

    Money is only ever counted per tin, so `balance` across several is their sum: what all
    of them hold between them, which is the figure a head office is actually asking for.
    """
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
        if not branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")

    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1}).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    # Which tins are in scope: one named branch, or the branches of one vertical, or all
    # of them. None means no branch clause at all rather than a list of every id.
    scope = None
    if branch_id:
        scope = branch_id
    elif mode in ("online", "offline"):
        scope = [b["id"] for b in branch_docs if _is_online_vertical(b.get("vertical")) == (mode == "online")]

    query = {}
    if isinstance(scope, str):
        query["branch_id"] = scope
    elif isinstance(scope, list):
        query["branch_id"] = {"$in": scope}
    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date
    if date_query:
        query["on"] = date_query
    rows = await v3_col("petty_cash_movements").find(query, {"_id": 0}).sort("created_at", -1).to_list(2000)
    # Named here rather than looked up by every reader: a movement carries the branch id it
    # belongs to, and a list covering several tins has to say which one each line came out
    # of or it is a column of figures with nothing to attach them to.
    for r in rows:
        r["branch_name"] = branch_name_map.get(r.get("branch_id"), "")
    return {
        "branch_id": branch_id,
        "limit": PETTY_CASH_LIMIT,
        "balance": await _petty_cash_balance(scope),
        "topped_up": round(sum(r["amount"] for r in rows if r.get("delta", 0) > 0), 2),
        "spent": round(sum(r["amount"] for r in rows if r.get("delta", 0) < 0), 2),
        "movements": rows,
    }


@router.post("/finance/petty-cash/topup")
async def top_up_petty_cash(
    payload: PettyCashTopUp,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Move notes from the drawer into the tin.

    Not an expense and never counted as one: nothing has been spent, and the branch holds
    the same cash it did a moment ago. It is here so the tin's balance has somewhere to
    come from other than an accountant editing a number.
    """
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id
    else:
        branch_id = payload.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="Petty cash belongs to a branch — pick one")
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    on = payload.on or _now()[:10]
    await _record_petty_cash_movement(
        branch_id=branch_id, delta=abs(float(payload.amount)), kind="topup",
        on=on, note=payload.note, user=user,
    )
    return {
        "message": "Petty cash topped up",
        "balance": await _petty_cash_balance(branch_id),
    }


# ---------------------------------------------------------------------------
# Branch Cash — one running box per branch: what it collected in cash, what it
# spent, what it handed over, and what should be left in the drawer right now.
# ---------------------------------------------------------------------------
#
# Derived, not stored. The cash a branch has taken is revenue-overview's own cash figure;
# what it has spent is the expense list's; and only the two things with no other home — a
# handover to the person who carries it to the accountant, and an accountant's correction
# after a count — are read from collections of their own. A stored running balance is a
# number that drifts from the rows that produced it, and here the rows are the record.
#
# The box only means anything once the accountant has set its opening figure: historical
# cash income was never handed over through this system, so before the opening count the
# derived balance is every rupee of cash ever taken less a handful of petty expenses —
# a wild number. `opening_set` gates every reader on that: no opening, no branch-cash
# expectation on the closing screen, and the panel prompts for the count instead.

# What a handover can be in. `pending` — raised by the branch, the carrier has the notes.
# `received` — the accountant has counted them in. `disputed` — counted in, but short or
# over what the branch said, and the difference written as a correction.
HANDOVER_STATUSES = ("pending", "received", "disputed")


class CashHandoverCreate(BaseModel):
    # Ignored for a Branch Admin, who hands over their own branch's cash and nobody else's.
    branch_id: Optional[str] = None
    amount: float
    # The notes handed over, counted — same shape a closing count carries.
    cash_denominations: Optional[dict] = None
    cash_coins: Optional[float] = 0
    # Who is physically carrying it to the accountant. Required — a handover with no
    # carrier named is a bag of cash nobody is answerable for on the road.
    handed_to: str
    on: Optional[str] = None
    note: Optional[str] = ""


class CashHandoverReceive(BaseModel):
    # What the accountant actually counted. Left unset means "exactly what the branch
    # said"; a figure that differs is recorded and the gap written as a correction.
    received_amount: Optional[float] = None
    received_denominations: Optional[dict] = None
    received_coins: Optional[float] = 0
    note: Optional[str] = ""


class CashAdjustmentCreate(BaseModel):
    # Ignored for nobody — only the accountant and Super Admin can reach this endpoint.
    branch_id: str
    # "opening" seeds the box: the accountant counts the branch's real cash and the box
    # is set to it, whatever the derived figure said. "correction" is a later nudge for a
    # miscount found afterwards.
    reason: str = "correction"
    # What the cash actually is. The stored adjustment is the difference between this and
    # the box's current derived balance, so the balance becomes exactly this figure.
    counted_amount: float
    note: Optional[str] = ""


async def _branch_cash_figures(
    branch_id: str, user: V3UserOut, up_to: Optional[str] = None, with_split: bool = False,
) -> dict:
    """Everything one branch's cash box holds and how it got there.

    `up_to` (YYYY-MM-DD, inclusive) freezes every figure at the end of that day, which is
    what Closing Balance needs to say what the drawer should have held that evening. Left
    off, it is the box as it stands now.

    `with_split` adds cash_approved / cash_awaiting — the same cash collected, cut by
    whether the accountant has signed it off — off /finance/approvals' own summary, so the
    branch can set the box against the two income pills it already reads. An extra pass over
    the collections, so only asked for where a screen shows it (the single-branch view).

    revenue_overview and list_expenses are called as plain functions — their Depends
    defaults are only defaults — and both re-apply their own branch scoping to `user`, so
    a Branch Admin cannot read another branch's box through this.
    """
    rev = await revenue_overview(start_date=None, end_date=up_to, branch_id=branch_id, user=user)
    collected_cash = round(float((rev.get("payment_modes") or {}).get("cash") or 0), 2)
    collected_total = round(float((rev.get("kpis") or {}).get("total_collected") or 0), 2)

    cash_approved = cash_awaiting = None
    if with_split:
        appr = await finance_approvals(branch_id=branch_id, payment_mode="cash", user=user)
        summ = appr.get("summary") or {}
        cash_approved = round(float(summ.get("approved_total") or 0), 2)
        cash_awaiting = round(float(summ.get("pending_total") or 0), 2)

    # Every branch expense is cash now, so this is all of them — approved or still waiting,
    # never a rejected one. The notes left the branch when it was spent, whatever the
    # accountant does with the row afterwards.
    exp_query = {"branch_id": branch_id, "payment_mode": "cash", "rejected": {"$ne": True}}
    if up_to:
        exp_query["expense_date"] = {"$lte": up_to}
    exp_rows = await v3_col("expenses").find(exp_query, {"_id": 0, "amount": 1}).to_list(20000)
    cash_spent = round(sum(float(r.get("amount") or 0) for r in exp_rows), 2)

    ho_query = {"branch_id": branch_id}
    if up_to:
        ho_query["on"] = {"$lte": up_to}
    ho_rows = await v3_col("cash_handovers").find(ho_query, {"_id": 0}).to_list(5000)
    in_transit = round(sum(
        float(h.get("amount") or 0) for h in ho_rows if h.get("status") == "pending"
    ), 2)
    handed_over = round(sum(
        float(h["received_amount"] if h.get("received_amount") is not None else h.get("amount") or 0)
        for h in ho_rows if h.get("status") in ("received", "disputed")
    ), 2)

    adj_query = {"branch_id": branch_id}
    if up_to:
        adj_query["on"] = {"$lte": up_to}
    adj_rows = await v3_col("cash_adjustments").find(adj_query, {"_id": 0}).to_list(5000)
    adjustments = round(sum(float(r.get("amount") or 0) for r in adj_rows), 2)
    opening_set = any(r.get("reason") == "opening" for r in adj_rows)

    # In the drawer now = the opening count and corrections, plus cash taken, less cash
    # spent, less everything that has left with a carrier (whether the accountant has
    # counted it in yet or not — the notes are gone from the branch either way).
    cash_in_hand = round(adjustments + collected_cash - cash_spent - handed_over - in_transit, 2)
    return {
        "branch_id": branch_id,
        "collected_total": collected_total,
        "collected_cash": collected_cash,
        "cash_approved": cash_approved,
        "cash_awaiting": cash_awaiting,
        "cash_spent": cash_spent,
        "handed_over": handed_over,
        "in_transit": in_transit,
        "adjustments": adjustments,
        "cash_in_hand": cash_in_hand,
        "opening_set": opening_set,
    }


def _handover_public(row: Optional[dict]) -> Optional[dict]:
    if not row:
        return None
    return {
        "id": row.get("id", ""),
        "branch_id": row.get("branch_id"),
        "branch_name": row.get("branch_name") or "",
        "amount": round(float(row.get("amount") or 0), 2),
        "cash_denominations": row.get("cash_denominations") or {},
        "cash_coins": round(float(row.get("cash_coins") or 0), 2),
        "status": row.get("status") or "pending",
        "handed_to": row.get("handed_to") or "",
        "on": row.get("on") or "",
        "note": row.get("note") or "",
        "raised_by": row.get("raised_by") or "",
        "raised_at": row.get("raised_at") or "",
        "received_amount": (
            round(float(row["received_amount"]), 2) if row.get("received_amount") is not None else None
        ),
        "received_by": row.get("received_by") or "",
        "received_at": row.get("received_at") or "",
        "variance": round(float(row.get("variance") or 0), 2),
    }


@router.get("/finance/branch-cash")
async def get_branch_cash(
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """One branch's cash box — the five figures, its recent handovers, and its adjustments.

    A Branch Admin gets their own and only their own. The accountant and Super Admin pass
    a branch_id; with none passed they get the roll-up across every branch, which is the
    figure a head office is actually asking for.
    """
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id

    branch_docs = await v3_col("branches").find(
        {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    if branch_id:
        figures = await _branch_cash_figures(branch_id, user, with_split=True)
        figures["branch_name"] = branch_name_map.get(branch_id, "")
        ho_rows = await v3_col("cash_handovers").find(
            {"branch_id": branch_id}, {"_id": 0}
        ).sort("raised_at", -1).to_list(200)
        adj_rows = await v3_col("cash_adjustments").find(
            {"branch_id": branch_id}, {"_id": 0}
        ).sort("created_at", -1).to_list(200)
        return {
            **figures,
            "handovers": [_handover_public(h) for h in ho_rows],
            "adjustments_log": adj_rows,
        }

    # Roll-up: every branch's box, summed, with a row each so a head office can see which
    # branch is holding what.
    rows = []
    for b in branch_docs:
        fig = await _branch_cash_figures(b["id"], user)
        fig["branch_name"] = b.get("branch_name", "")
        rows.append(fig)
    total = {
        "collected_total": round(sum(r["collected_total"] for r in rows), 2),
        "collected_cash": round(sum(r["collected_cash"] for r in rows), 2),
        "cash_spent": round(sum(r["cash_spent"] for r in rows), 2),
        "handed_over": round(sum(r["handed_over"] for r in rows), 2),
        "in_transit": round(sum(r["in_transit"] for r in rows), 2),
        "cash_in_hand": round(sum(r["cash_in_hand"] for r in rows), 2),
    }
    return {"branch_id": None, "total": total, "by_branch": sorted(rows, key=lambda r: -r["cash_in_hand"])}


# The cards on Branch Cash, each of which opens the rows it was summed from.
BRANCH_CASH_KINDS = ("collected", "collected_cash", "cash_spent", "handed_over", "in_transit", "cash_in_hand")


def _cash_share(t: dict) -> float:
    """The cash part of one collection: all of it for a cash payment, the cash lines of a
    split, nothing otherwise — the same cut _tally_modes makes for the Cash figure."""
    split = t.get("payment_split") or []
    if split:
        return round(sum(float(l.get("amount") or 0) for l in split if l.get("mode") == "cash"), 2)
    return round(float(t.get("gross") or 0), 2) if t.get("payment_mode") == "cash" else 0.0


@router.get("/finance/branch-cash/entries")
async def get_branch_cash_entries(
    kind: str,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """The rows behind one Branch Cash card, read off the same sources _branch_cash_figures
    sums, so a card and the list it opens agree.

    Every row is one shape — date, branch, type, party, detail, amount — so one table can
    show any card and filter it by `type`. For cash_in_hand it is the whole movement list
    the balance is made of: cash collected in, cash spent and handed over out (negative),
    and the opening count and corrections either way.
    """
    if kind not in BRANCH_CASH_KINDS:
        raise HTTPException(status_code=400, detail="Unknown card")
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id

    branch_docs = await v3_col("branches").find(
        {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    branch_name_map = {b["id"]: b.get("branch_name", "") for b in branch_docs}
    # The roll-up is summed over live branches only, so the list is too.
    branch_ids = [branch_id] if branch_id else list(branch_name_map)

    rows = []
    ledger = kind == "cash_in_hand"

    if kind in ("collected", "collected_cash") or ledger:
        for bid in branch_ids:
            rev = await revenue_overview(start_date=None, end_date=None, branch_id=bid, user=user)
            for t in rev.get("transactions") or []:
                amount = round(float(t.get("gross") or 0), 2) if kind == "collected" else _cash_share(t)
                if not amount:
                    continue
                mode = t.get("payment_mode") or ""
                if t.get("payment_split"):
                    mode = " + ".join(f"{l.get('mode')} {float(l.get('amount') or 0):g}" for l in t["payment_split"])
                rows.append({
                    "id": f"col-{t.get('id')}",
                    "date": (t.get("date") or "")[:10],
                    "branch_name": branch_name_map.get(bid, ""),
                    "type": "Cash in" if ledger else (t.get("source") or "other").title(),
                    "party": t.get("client_name") or "",
                    "detail": f"{(t.get('source') or '').title()} · {mode}" if ledger else mode,
                    "status": "Approved" if t.get("approved") else "Awaiting approval",
                    "amount": amount,
                })

    if kind == "cash_spent" or ledger:
        exp_query = {"payment_mode": "cash", "rejected": {"$ne": True}, "branch_id": {"$in": branch_ids}}
        for e in await v3_col("expenses").find(exp_query, {"_id": 0}).sort("expense_date", -1).to_list(20000):
            amount = round(float(e.get("amount") or 0), 2)
            rows.append({
                "id": f"exp-{e.get('id')}",
                "date": e.get("expense_date") or "",
                "branch_name": branch_name_map.get(e.get("branch_id"), ""),
                "type": "Spent" if ledger else (e.get("category") or "Uncategorized"),
                "party": e.get("paid_to") or "",
                "detail": (f"{e.get('category') or ''} · " if ledger else "") + (e.get("note") or ""),
                "status": "Approved" if _expense_approved(e) else "Awaiting approval",
                "amount": -amount if ledger else amount,
            })

    if kind in ("handed_over", "in_transit") or ledger:
        statuses = {"handed_over": ["received", "disputed"], "in_transit": ["pending"]}.get(kind, list(HANDOVER_STATUSES))
        ho_query = {"branch_id": {"$in": branch_ids}, "status": {"$in": statuses}}
        for h in await v3_col("cash_handovers").find(ho_query, {"_id": 0}).sort("raised_at", -1).to_list(5000):
            pending = h.get("status") == "pending"
            amount = round(float(
                (h.get("amount") if pending or h.get("received_amount") is None else h["received_amount"]) or 0
            ), 2)
            rows.append({
                "id": f"ho-{h.get('id')}",
                "date": h.get("on") or "",
                "branch_name": branch_name_map.get(h.get("branch_id"), ""),
                "type": ("In transit" if pending else "Handed over") if ledger else (h.get("status") or "pending").title(),
                "party": h.get("handed_to") or "",
                "detail": " · ".join(x for x in [
                    f"received by {h['received_by']}" if h.get("received_by") else "",
                    f"variance Rs.{float(h.get('variance') or 0):g}" if float(h.get("variance") or 0) else "",
                    h.get("note") or "",
                ] if x),
                "status": (h.get("status") or "pending").title(),
                "amount": -amount if ledger else amount,
            })

    if ledger:
        for a in await v3_col("cash_adjustments").find({"branch_id": {"$in": branch_ids}}, {"_id": 0}).to_list(5000):
            rows.append({
                "id": f"adj-{a.get('id')}",
                "date": a.get("on") or "",
                "branch_name": branch_name_map.get(a.get("branch_id"), ""),
                "type": "Opening" if a.get("reason") == "opening" else "Correction",
                "party": a.get("created_by") or "",
                "detail": a.get("note") or "",
                "status": "",
                "amount": round(float(a.get("amount") or 0), 2),
            })

    rows.sort(key=lambda r: r["date"], reverse=True)
    return {
        "kind": kind,
        "branch_id": branch_id or None,
        "rows": rows,
        "total": round(sum(r["amount"] for r in rows), 2),
    }


@router.post("/finance/branch-cash/adjustment")
async def create_cash_adjustment(
    payload: CashAdjustmentCreate,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """Set a branch's cash box to what was actually counted.

    Not open to the Branch Admin: the box is the branch's own figure to keep true by
    handing cash over and logging what it spends, and a branch that can also just type the
    balance it wants has a box that says nothing. The opening count especially is the
    accountant's — it is the moment the branch's cash becomes something head office is
    tracking.
    """
    branch_id = payload.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="Pick a branch")
    reason = (payload.reason or "correction").strip().lower()
    if reason not in ("opening", "correction"):
        reason = "correction"

    current = await _branch_cash_figures(branch_id, user)
    if reason == "opening" and current["opening_set"]:
        raise HTTPException(
            status_code=409,
            detail="This branch's opening cash is already set — use a correction to change the balance",
        )
    counted = round(float(payload.counted_amount), 2)
    delta = round(counted - current["cash_in_hand"], 2)

    doc = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        "reason": reason,
        "amount": delta,
        "counted_to": counted,
        "note": (payload.note or "").strip(),
        "on": _now()[:10],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    }
    await v3_col("cash_adjustments").insert_one(doc.copy())
    return {
        "message": "Opening cash set" if reason == "opening" else "Cash balance corrected",
        "branch_cash": await _branch_cash_figures(branch_id, user),
    }


@router.post("/finance/cash-handover")
async def create_cash_handover(
    payload: CashHandoverCreate,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """The branch settles cash to the person who carries it to the accountant.

    The notes leave the branch the moment this is raised, so the box drops by the amount
    straight away — `pending` until the accountant counts it in.

    The accountant may raise one too, asked for on 2026-09-21: Accountant Master View >
    Summary > Expenses > Cash In Hand works every branch's drawer, and the desk that reads
    them is often the one told over the phone that cash is on its way. This used to be
    refused, on the reasoning that a handover is the branch's own statement about money it
    is sending. That reasoning still holds for what the row MEANS, and the trade it makes
    is worth stating plainly: the accountant can also receive, so one person can now both
    send a branch's cash and count it in, which is the second pair of eyes the two steps
    existed to be. What stands in its place is the record — `raised_by` and
    `raised_by_role` are written on every handover, so one the accountant raised against a
    branch says so, and the branch reads it on its own Cash In Hand list.
    """
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your account is not attached to a branch")
        branch_id = user.branch_id
    else:
        branch_id = payload.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="Pick a branch")

    amount = round(float(payload.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")
    if not (payload.handed_to or "").strip():
        raise HTTPException(status_code=400, detail="Name who is carrying the cash")

    # A count is optional, but one that was taken has to agree with the amount — the same
    # rule a fee collection's cash count follows.
    counted_cash, notes = _denomination_total(payload.cash_denominations)
    coins = round(float(payload.cash_coins or 0), 2)
    if notes and abs((counted_cash + coins) - amount) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"The notes counted come to Rs.{counted_cash + coins:g}, but the handover is Rs.{amount:g}",
        )

    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "branch_name": 1})
    doc = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        "branch_name": (branch or {}).get("branch_name", ""),
        "amount": amount,
        "cash_denominations": notes,
        "cash_coins": coins,
        "handed_to": payload.handed_to.strip(),
        "on": payload.on or _now()[:10],
        "note": (payload.note or "").strip(),
        "status": "pending",
        "raised_by": user.full_name,
        "raised_by_role": user.role,
        "raised_at": _now(),
        "received_amount": None,
        "received_by": None,
        "received_at": None,
        "variance": 0.0,
    }
    await v3_col("cash_handovers").insert_one(doc.copy())
    return {
        "message": "Cash handed over — waiting for the accountant to receive it",
        "handover": _handover_public(doc),
        "branch_cash": await _branch_cash_figures(branch_id, user),
    }


@router.get("/finance/cash-handovers")
async def list_cash_handovers(
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "branch_admin", "business_dev")),
):
    """Handovers, newest first. A Branch Admin sees their own branch's; the accountant and
    Super Admin see every branch's, or one if they name it."""
    if is_branch_admin_role(user.role):
        branch_id = user.branch_id
    query = {}
    if branch_id:
        query["branch_id"] = branch_id
    if status in HANDOVER_STATUSES:
        query["status"] = status
    rows = await v3_col("cash_handovers").find(query, {"_id": 0}).sort("raised_at", -1).to_list(1000)
    listed = [_handover_public(r) for r in rows]
    return {
        "handovers": listed,
        "pending_total": round(sum(r["amount"] for r in listed if r["status"] == "pending"), 2),
        "pending_count": sum(1 for r in listed if r["status"] == "pending"),
    }


@router.post("/finance/cash-handover/{handover_id}/receive")
async def receive_cash_handover(
    handover_id: str,
    payload: CashHandoverReceive = CashHandoverReceive(),
    user: V3UserOut = Depends(v3_require_roles("super_admin", "accountant", "business_dev")),
):
    """The accountant counts a handover in. A figure that differs from what the branch
    said is recorded and the gap written straight onto the branch's box as a correction,
    so the branch's cash-in-hand reflects the count that actually happened."""
    row = await v3_col("cash_handovers").find_one({"id": handover_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Handover not found")
    if row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="This handover has already been received")

    stated = round(float(row.get("amount") or 0), 2)
    if payload.received_amount is not None:
        received = round(float(payload.received_amount), 2)
    else:
        counted_cash, _ = _denomination_total(payload.received_denominations)
        coins = round(float(payload.received_coins or 0), 2)
        received = round(counted_cash + coins, 2) if (counted_cash or coins) else stated
    if received < 0:
        raise HTTPException(status_code=400, detail="A counted amount cannot be negative")

    variance = round(received - stated, 2)
    now = _now()
    update = {
        "status": "disputed" if abs(variance) >= 0.01 else "received",
        "received_amount": received,
        "received_by": user.full_name,
        "received_at": now,
        "variance": variance,
        "receive_note": (payload.note or "").strip(),
    }
    await v3_col("cash_handovers").update_one({"id": handover_id}, {"$set": update})

    # The branch sent what it sent; if the accountant counted less, the branch is that
    # much shorter than its box says, so the box is corrected down (and up for an over).
    if abs(variance) >= 0.01:
        await v3_col("cash_adjustments").insert_one({
            "id": str(uuid.uuid4()),
            "branch_id": row.get("branch_id"),
            "reason": "correction",
            "amount": variance,
            "counted_to": None,
            "note": f"Handover {handover_id[:8]} counted Rs.{received:g} against Rs.{stated:g} stated"
                    + (f" — {payload.note.strip()}" if (payload.note or '').strip() else ""),
            "on": now[:10],
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
            "handover_id": handover_id,
        })

    saved = await v3_col("cash_handovers").find_one({"id": handover_id}, {"_id": 0})
    return {
        "message": "Handover received" if update["status"] == "received" else "Handover received with a difference",
        "handover": _handover_public(saved),
    }


@router.post("/finance/cash-handover/{handover_id}/cancel")
async def cancel_cash_handover(
    handover_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "business_dev")),
):
    """Pull a handover back before the accountant has received it — the notes never left,
    or left and came back. Only while pending: once received it is the accountant's record
    to unpick, not the branch's."""
    row = await v3_col("cash_handovers").find_one({"id": handover_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Handover not found")
    if is_branch_admin_role(user.role) and row.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=403, detail="That handover is not your branch's")
    if row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="This handover has already been received — it cannot be cancelled")
    await v3_col("cash_handovers").update_one(
        {"id": handover_id},
        {"$set": {"status": "cancelled", "cancelled_by": user.full_name, "cancelled_at": _now()}},
    )
    return {"message": "Handover cancelled"}


# ---------- UPI / Bank accounts (Super Admin, Finance > UPI) ----------

# Where a QR lands. Public once served, the same as a store item's photo: a QR code is
# meant to be held up to a patient at the counter, so serving it from behind the session
# would mean the one screen it exists for could not show it.
BANK_QR_UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads", "bank_qr")
os.makedirs(BANK_QR_UPLOAD_DIR, exist_ok=True)
BANK_QR_ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
BANK_QR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024

# The four a card cannot be saved without. IFSC and the bank's own branch name are left
# out on purpose: an account collects money by UPI whether or not anyone has typed the
# IFSC, and refusing the save over it would only get a placeholder typed in.
BANK_ACCOUNT_REQUIRED = {
    "bank_name": "Bank name",
    "account_number": "Account number",
    "upi_id": "UPI ID",
    "holder_name": "Holder name",
    "qr_image_url": "QR image",
}


class BankAccountSave(BaseModel):
    # Which branch's counter this account is collecting at. Unset means the group rather
    # than one branch, the same thing an expense saved from All Branches means. Read on
    # an edit as well as on create: a bank opened for one branch and then handed to
    # another moves by being edited, rather than by being deleted and retyped.
    branch_id: Optional[str] = None
    bank_name: Optional[str] = ""
    account_number: Optional[str] = ""
    ifsc_code: Optional[str] = ""
    upi_id: Optional[str] = ""
    holder_name: Optional[str] = ""
    bank_branch_name: Optional[str] = ""
    qr_image_url: Optional[str] = ""
    # Whether this account is still collecting. An account closed at the bank, or a QR
    # taken down off a counter, stops being offered without the card that records it
    # having to be thrown away -- the payments already taken against it are still read
    # back through it.
    is_active: Optional[bool] = True


class BankAccountStatus(BaseModel):
    is_active: bool


async def _resolve_branch_id(payload: BankAccountSave) -> Optional[str]:
    branch_id = (payload.branch_id or "").strip() or None
    if branch_id and not await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Branch not found")
    return branch_id


def _clean_bank_payload(payload: BankAccountSave) -> dict:
    fields = {
        "bank_name": (payload.bank_name or "").strip(),
        "account_number": (payload.account_number or "").strip(),
        # Upper-cased because an IFSC is one: typed in lower case it still matches the
        # bank's record, but two spellings of the same code read as two codes.
        "ifsc_code": (payload.ifsc_code or "").strip().upper(),
        "upi_id": (payload.upi_id or "").strip(),
        "holder_name": (payload.holder_name or "").strip(),
        "bank_branch_name": (payload.bank_branch_name or "").strip(),
        "qr_image_url": (payload.qr_image_url or "").strip(),
        "is_active": True if payload.is_active is None else bool(payload.is_active),
    }
    missing = [label for key, label in BANK_ACCOUNT_REQUIRED.items() if not fields[key]]
    if missing:
        raise HTTPException(status_code=400, detail=f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} required")
    return fields


@router.post("/finance/bank-accounts/upload-qr")
async def upload_bank_qr_image(
    file: UploadFile = File(...),
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """The QR image alone, uploaded ahead of Save — so the popup can show what was picked
    before anything is committed, and so a save that is then refused for a missing field
    does not cost the upload a second time."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in BANK_QR_ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only JPG, PNG, or WEBP images are allowed")
    contents = await file.read()
    if len(contents) > BANK_QR_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Image must be under 5MB")
    filename = f"{uuid.uuid4()}{ext}"
    with open(os.path.join(BANK_QR_UPLOAD_DIR, filename), "wb") as f:
        f.write(contents)
    return {"url": f"/api/v3/uploads/bank_qr/{filename}"}


@router.get("/finance/bank-accounts/upi-options")
async def list_upi_collect_options(
    _: V3UserOut = Depends(v3_require_roles(
        "branch_admin", "super_admin", "accountant", "business_dev", "physio", "head_physio", "nutritionist",
    )),
):
    """The UPI IDs a desk can take money into, for the picker on every Collect popup.

    Every branch's, not the caller's own. A patient standing at Parrys can be sent the QR
    of whichever account the group wants that payment in -- the money lands in one company
    account either way, and a desk that could only offer its own branch's ID had no way to
    record a payment taken into another. So the whole list, each entry naming the branch it
    belongs to, and the group's own accounts (saved against no branch) named as such.

    Switched-off accounts are left out: an account closed at the bank, or a QR taken down
    off a counter, is exactly the one nobody should be collecting into. The cards already
    saved against it are untouched -- this list is what is offered next, not what was.

    Separate from the board's own list_bank_accounts above because the two answer different
    questions: that one is the Finance desk's grid (one branch at a time, active or not,
    every field of the record), this one is a dropdown at a counter. Which is also why the
    role list is wide -- every desk that collects a fee needs it -- while what it returns is
    narrow: the account number and IFSC are nobody's business at the point of payment.
    """
    rows = await v3_col("bank_accounts").find(
        {}, {"_id": 0, "id": 1, "branch_id": 1, "bank_name": 1, "upi_id": 1, "holder_name": 1, "qr_image_url": 1, "is_active": 1},
    ).sort("created_at", 1).to_list(500)
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    names = {b["id"]: b.get("branch_name", "") for b in branches}
    out = [
        {
            "id": row.get("id"),
            "upi_id": row.get("upi_id") or "",
            "bank_name": row.get("bank_name") or "",
            "holder_name": row.get("holder_name") or "",
            "qr_image_url": row.get("qr_image_url") or "",
            "branch_id": row.get("branch_id") or "",
            # An account saved against no branch belongs to the group, and says so rather
            # than sitting in the list under a blank.
            "branch_name": names.get(row.get("branch_id") or "", "") or "All Branches",
        }
        for row in rows
        # Saved before the switch existed means collecting -- same reading as the board's.
        if row.get("is_active", True) and (row.get("upi_id") or "").strip()
    ]
    # Branch by branch, and by bank within a branch, so the desk scans the list the way the
    # counter thinks: whose account, then which bank.
    out.sort(key=lambda r: (r["branch_name"].lower(), r["bank_name"].lower()))
    return out


@router.get("/finance/bank-accounts")
async def list_bank_accounts(
    branch_id: Optional[str] = None,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Every account this desk has saved, oldest first so the grid does not reshuffle
    under an edit. Given a branch, only that branch's own — not that branch's plus the
    group's: the pill row above this board names one book at a time, and a card that
    appeared under every branch could not be told apart from one saved against this one."""
    query = {"branch_id": branch_id} if branch_id else {}
    rows = await v3_col("bank_accounts").find(query, {"_id": 0}).sort("created_at", 1).to_list(500)
    # The branch each card belongs to, named rather than left as an id — the All Branches
    # grid shows cards from every branch at once and has nothing else to tell them apart.
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    names = {b["id"]: b.get("branch_name", "") for b in branches}
    for row in rows:
        row["branch_name"] = names.get(row.get("branch_id") or "", "")
        # Cards saved before the switch existed were collecting, and read as such rather
        # than arriving switched off on the first load after this went out.
        row["is_active"] = row.get("is_active", True)
    return rows


@router.post("/finance/bank-accounts")
async def create_bank_account(
    payload: BankAccountSave,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Add a bank account the group collects into. More than one is the normal case —
    a branch can bank with two, and the group's own account is not a branch's."""
    fields = _clean_bank_payload(payload)
    branch_id = await _resolve_branch_id(payload)
    now = _now()
    row = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        **fields,
        "created_by": user.full_name,
        "created_at": now,
        "updated_by": user.full_name,
        "updated_at": now,
    }
    await v3_col("bank_accounts").insert_one(dict(row))
    return {"message": "Bank account saved", "account": row}


@router.put("/finance/bank-accounts/{account_id}")
async def update_bank_account(
    account_id: str,
    payload: BankAccountSave,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Correct a saved card. The same fields under the same rules as saving it — an
    account edited down to no UPI ID is refused exactly as one entered that way is."""
    existing = await v3_col("bank_accounts").find_one({"id": account_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Bank account not found")
    fields = _clean_bank_payload(payload)
    update = {
        **fields,
        "branch_id": await _resolve_branch_id(payload),
        "updated_by": user.full_name,
        "updated_at": _now(),
    }
    await v3_col("bank_accounts").update_one({"id": account_id}, {"$set": update})
    return {"message": "Bank account updated", "account": {**existing, **update}}


@router.post("/finance/bank-accounts/{account_id}/status")
async def set_bank_account_status(
    account_id: str,
    payload: BankAccountStatus,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Switch one account on or off from the grid, without reopening the whole card —
    the one thing about an account that changes on its own, a QR coming down off a
    counter, should not need every other field confirmed to record it."""
    existing = await v3_col("bank_accounts").find_one({"id": account_id}, {"_id": 0, "id": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Bank account not found")
    await v3_col("bank_accounts").update_one(
        {"id": account_id},
        {"$set": {"is_active": payload.is_active, "updated_by": user.full_name, "updated_at": _now()}},
    )
    return {"message": "Bank account activated" if payload.is_active else "Bank account deactivated", "is_active": payload.is_active}


@router.delete("/finance/bank-accounts/{account_id}")
async def delete_bank_account(
    account_id: str,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Remove a card entered by mistake — a duplicate, or an account that was never
    this group's. An account that simply stopped collecting is switched off instead,
    which is why this is the narrower of the two and sits behind its own confirmation:
    deleting keeps no record that the account was ever here.

    The QR file is left on disk. It is a few kilobytes, nothing else points at it, and
    unlinking it here would delete the image out from under a second card that was
    saved by picking the same upload.
    """
    existing = await v3_col("bank_accounts").find_one({"id": account_id}, {"_id": 0, "bank_name": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Bank account not found")
    await v3_col("bank_accounts").delete_one({"id": account_id})
    return {"message": f"{existing.get('bank_name') or 'Bank account'} removed"}
