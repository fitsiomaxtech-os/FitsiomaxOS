"""Pre Book: a client who will come later, and what they paid to hold the visit.

The lead is moved to the Pre Book stage in Branch Leads, which asks when the client plans to
come (see v3_move_branch_stage). From that stage the Branch Admin opens the Pre Book popup
and takes the money, in two parts that are collected and kept apart:

  consultation  a Consultation package off Services & Products -- usually Reconsultation --
                and what was paid on it: the whole price, or part of it (Rs.500 to confirm
                a booking, the rest on the day).
  advance       money towards something not priced yet: the Sessions the consultant will
                plan, or anything else the desk names.

Each part is a payment of its own -- its own transaction id and its own activity row, one of
finance's PRE_BOOK_ACTIONS -- so it reaches To Verify, the cash book and revenue the day it
is paid, exactly as any other collection does.

On the visit day the money is used on the real fee: the Consultation Fee once the consultant
has seen the patient, the Treatment Fee once a session package is chosen. Using it writes the
pre-paid amount onto that fee as its first, already-paid instalment and leaves whatever is
left as an ordinary balance, collected through the Payment Schedule like any other. It writes
no revenue row: the money was counted when it arrived, and counting it again here is the one
mistake this design exists to avoid.

Deleting a Pre Book payment from finance takes it back off the fee it was used on (see
_pre_book_unapply in v3_finance.py).
"""
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import store_branch_overrides
from database import v3_col
from deps import v3_require_roles
from schemas.v3 import V3UserOut, V3LeadOut
from utils import generate_transaction_id, clinic_today, now_iso
from routers.v3_lead_documents import has_prescription_on_file
from routers.v3_packages import build_payment_details, SETTLED_NOW_MODES, _settle_cash_count, _notes_label

router = APIRouter(prefix="/api/v3", tags=["pre-book"])

ADVANCE_FOR = {"sessions": "Sessions", "others": "Others"}

# The action each part's payment is logged under -- finance's PRE_BOOK_ACTIONS. An advance
# for sessions is filed apart from one for anything else because revenue reads it onto the
# session line rather than the consultation one.
CONSULTATION_ACTION = "pre_book_consultation_collected"
ADVANCE_ACTIONS = {"sessions": "pre_book_advance_collected", "others": "pre_book_other_advance_collected"}

# How a fee reads when it was settled from Pre Book money. A payment mode of its own, so the
# fee's screens can say where the money came from, and so _pre_book_unapply can tell a fee
# still standing on it from one re-collected some other way since.
PRE_BOOK_MODE = "pre_book"


class V3PreBookCollectInput(BaseModel):
    # The consultation part. The item is one of the Consultation packages; the amount is
    # what was handed over for it, the whole price when left out.
    consultation_item_id: Optional[str] = None
    consultation_amount: Optional[float] = None
    # The advance part.
    advance_for: Optional[Literal["sessions", "others"]] = None
    advance_note: Optional[str] = None
    advance_amount: Optional[float] = None
    # One payment for both parts: the client pays once, in one way.
    payment_mode: Literal["cash", "upi", "card", "account_transfer"] = "cash"
    confirmed: bool = False
    denominations: Optional[dict] = None
    upi_transaction_id: Optional[str] = None
    upi_utr: Optional[str] = None
    upi_id: Optional[str] = None
    card_transaction_id: Optional[str] = None
    account_number: Optional[str] = None
    account_holder_name: Optional[str] = None
    bank_name: Optional[str] = None
    ifsc_code: Optional[str] = None
    transfer_reference: Optional[str] = None
    # build_payment_details reads it for a cheque, which this popup does not take.
    cheque_number: Optional[str] = None


def _money(value: Optional[float]) -> float:
    return round(float(value or 0), 2)


def _rs(value: float) -> str:
    """An amount as an activity line writes it: 600, 4400.5 -- never 6e+05, which is what
    `:g` makes of a large figure and which finance's parser would read as 6."""
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


async def _lead_or_404(lead_id: str) -> dict:
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead


def _record(lead: dict) -> dict:
    """The lead's Pre Book record, refused when it has none -- the money is taken against a
    planned visit, and the move onto the stage is what records one."""
    rec = lead.get("pre_book")
    if not isinstance(rec, dict) or not rec.get("at"):
        raise HTTPException(status_code=400, detail="Move this lead to Pre Book first")
    return rec


@router.post("/leads/{lead_id}/pre-book/collect", response_model=dict)
async def collect_pre_book(
    lead_id: str,
    payload: V3PreBookCollectInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Take the Pre Book money: a consultation package, an advance, or both.

    Each part is collected once. Another payment on a part already paid would be a second
    consultation sold for one visit, or two advances nobody can tell apart on the day; a
    wrong one is deleted from finance and taken again.
    """
    lead = await _lead_or_404(lead_id)
    rec = _record(lead)

    if payload.payment_mode not in SETTLED_NOW_MODES:
        raise HTTPException(status_code=400, detail=f"Pre Book accepts: {sorted(SETTLED_NOW_MODES)}")
    if not payload.confirmed:
        raise HTTPException(status_code=400, detail="Please confirm the payment before submitting")

    consult = None
    if payload.consultation_item_id:
        if rec.get("consultation"):
            raise HTTPException(status_code=400, detail="The Pre Book consultation is already paid")
        # Not refused over a Consultation Fee already on the record: money handed over is
        # recorded whatever happens to it next. Using it on the day is what needs the fee
        # open, and apply_pre_book_consultation says so there.
        item =await store_branch_overrides.overlay_one(
            await v3_col("store_items").find_one({"id": payload.consultation_item_id}, {"_id": 0}),
            lead.get("branch_id"),
        )
        if not item:
            raise HTTPException(status_code=404, detail="Consultation package not found")
        # A row older than item_type is a consultation, as the store's own list reads it.
        if item.get("item_type") not in ("consultation", None):
            raise HTTPException(status_code=400, detail="Pick a Consultation package")
        # Online and offline are priced apart, and which applies is the appointment's mode
        # -- the same reading collect_package_payment makes on the day.
        mode = lead.get("appointment_mode") or "offline"
        price = item.get("price_online") if mode == "online" else item.get("price_offline")
        if price is None:
            raise HTTPException(status_code=400, detail=f"'{item.get('name')}' has no {mode} price set. Add one in Services & Products.")
        price = _money(price)
        amount = _money(payload.consultation_amount if payload.consultation_amount is not None else price)
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Enter the consultation amount")
        # More than the package costs is not a consultation payment; the rest is an advance
        # and belongs in that box, where the day it is used can find it.
        if amount > price + 0.009:
            raise HTTPException(status_code=400, detail=f"The consultation amount is more than '{item.get('name')}' costs (Rs.{_rs(price)}) — put the rest in the Advance")
        consult = {"item": item, "price": price, "amount": amount, "mode": mode}

    advance = None
    if payload.advance_amount:
        if rec.get("advance"):
            raise HTTPException(status_code=400, detail="The Pre Book advance is already collected")
        if payload.advance_for not in ADVANCE_FOR:
            raise HTTPException(status_code=400, detail="Choose what the advance is for")
        amount = _money(payload.advance_amount)
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Enter the advance amount")
        note = (payload.advance_note or "").strip()
        if payload.advance_for == "others" and not note:
            raise HTTPException(status_code=400, detail="Say what the advance is for")
        advance = {"for": payload.advance_for, "note": note or None, "amount": amount}

    if not consult and not advance:
        raise HTTPException(status_code=400, detail="Enter the consultation, the advance, or both")

    # One count of notes covers what was handed over for both parts, so it is checked
    # against their total, not against either alone.
    total = _money((consult or {}).get("amount", 0) + (advance or {}).get("amount", 0))
    counted = _settle_cash_count(payload.denominations, total) if payload.payment_mode == "cash" else {}
    mode_details, mode_suffix = build_payment_details(payload)
    if counted:
        mode_details = {**mode_details, "denominations": counted}
        mode_suffix += f" · Counted {_notes_label(counted)}"

    planned = rec.get("date") or ""
    planned_suffix = f" · planned visit {planned}" if planned else ""
    now = now_iso()
    updates = {"updated_at": now}
    rows = []
    receipts = {}

    if consult:
        txn = await generate_transaction_id(lead.get("branch_id"))
        item = consult["item"]
        part_of = f" (of Rs.{_rs(consult['price'])})" if consult["amount"] < consult["price"] else ""
        updates["pre_book.consultation"] = {
            "item_id": item["id"],
            "name": item.get("name"),
            "consultation_package": item.get("consultation_package"),
            "duration_minutes": item.get("duration_minutes"),
            "price": consult["price"],
            "mode": consult["mode"],
            "paid": consult["amount"],
            "payment_mode": payload.payment_mode,
            "payment_details": {**mode_details, "transaction_id": txn},
            "transaction_id": txn,
            "at": now,
            "by": user.full_name,
        }
        # "Rs." first: finance reads the amount off the first one on the line.
        rows.append({
            "id": str(uuid.uuid4()),
            "transaction_id": txn,
            "lead_id": lead_id,
            "action": CONSULTATION_ACTION,
            "details": f"Collected Pre Book Consultation Rs.{_rs(consult['amount'])}{part_of} for package '{item.get('name')}' via {payload.payment_mode}{mode_suffix}{planned_suffix} · Txn {txn}",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
        })
        receipts["consultation"] = txn

    if advance:
        txn = await generate_transaction_id(lead.get("branch_id"))
        label = ADVANCE_FOR[advance["for"]] + (f" — {advance['note']}" if advance["note"] else "")
        updates["pre_book.advance"] = {
            "for": advance["for"],
            "note": advance["note"],
            "amount": advance["amount"],
            "payment_mode": payload.payment_mode,
            "payment_details": {**mode_details, "transaction_id": txn},
            "transaction_id": txn,
            "at": now,
            "by": user.full_name,
        }
        rows.append({
            "id": str(uuid.uuid4()),
            "transaction_id": txn,
            "lead_id": lead_id,
            "action": ADVANCE_ACTIONS[advance["for"]],
            "details": f"Collected Pre Book Advance Rs.{_rs(advance['amount'])} for {label} via {payload.payment_mode}{mode_suffix}{planned_suffix} · Txn {txn}",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
        })
        receipts["advance"] = txn

    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    await v3_col("lead_activity").insert_many([r.copy() for r in rows])
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Pre Book payment collected", "transaction_ids": receipts, "lead": V3LeadOut(**updated).model_dump()}


def _applied_details(paid: float, price: float, txn: Optional[str]) -> dict:
    """The fee's payment_details when it is settled from Pre Book money.

    The pre-paid amount is the first instalment, already paid -- carrying `pre_book` and the
    Pre Book payment's id under its own key, not as `transaction_id`: that key is what ties an
    instalment to a Payment Schedule collection, and Undo there must never reach a payment
    taken at Pre Book. Whatever is left of the price is an ordinary unpaid instalment due
    today, which every balance screen already reads and collects.
    """
    today = clinic_today()
    balance = round(price - paid, 2)
    details = {"pre_book": True, "pre_book_transaction_id": txn}
    if balance > 0.009:
        details["installments"] = [
            {"amount": paid, "due_date": today, "paid": True, "paid_on": today,
             "payment_mode": PRE_BOOK_MODE, "pre_book": True, "pre_book_transaction_id": txn},
            {"amount": balance, "due_date": today, "paid": False},
        ]
    return details


@router.post("/leads/{lead_id}/pre-book/apply-consultation", response_model=dict)
async def apply_pre_book_consultation(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Use the Pre Book consultation as this visit's Consultation Fee.

    Held to what collecting the fee is held to: the consultant has seen the patient, and the
    prescription is on file. The package and price are the ones agreed at Pre Book, so a
    catalogue change since does not re-price what the client already paid for.
    """
    lead = await _lead_or_404(lead_id)
    rec = _record(lead)
    consult = rec.get("consultation") or {}
    if not consult.get("paid"):
        raise HTTPException(status_code=400, detail="No Pre Book consultation was paid for this patient")
    if consult.get("applied_at"):
        raise HTTPException(status_code=400, detail="The Pre Book consultation is already used")
    # A patient record carries one Consultation Fee. One already on it -- this visit's, or an
    # earlier visit's on a returning patient -- has nothing left for the Pre Book money to pay.
    if lead.get("package_paid") is not None:
        raise HTTPException(status_code=400, detail="This patient already has a Consultation Fee on record, so the Pre Book consultation cannot be used on it")
    if lead.get("consultation_stage") not in ("Consultation Visit", "Fee Collected"):
        raise HTTPException(status_code=400, detail="The Pre Book consultation can be used once the CONSULTANT has completed the consultation")
    if not await has_prescription_on_file(lead_id):
        raise HTTPException(status_code=400, detail="Upload the patient's prescription before collecting the Consultation Fee")

    paid, price = _money(consult["paid"]), _money(consult.get("price") or consult["paid"])
    now = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "package_id": consult.get("item_id"),
        "package_name": consult.get("name"),
        "package_price": price,
        "package_duration_minutes": consult.get("duration_minutes"),
        "package_mode": consult.get("mode"),
        "consultation_package": consult.get("consultation_package"),
        "package_paid": paid,
        "package_payment_mode": PRE_BOOK_MODE,
        "package_payment_details": _applied_details(paid, price, consult.get("transaction_id")),
        "consultation_stage": "Fee Collected",
        "pre_book.consultation.applied_at": now,
        "pre_book.consultation.applied_by": user.full_name,
        "updated_at": now,
    }})
    balance = round(price - paid, 2)
    # Not a payment action: the money is already counted under the Pre Book row.
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "pre_book_consultation_applied",
        "details": (
            f"Consultation Fee settled from Pre Book — {consult.get('name')}, paid {_rs(paid)} on {str(consult.get('at') or '')[:10]}"
            + (f" · balance {_rs(balance)} owed" if balance > 0.009 else "")
            + (f" · Pre Book Txn {consult.get('transaction_id')}" if consult.get("transaction_id") else "")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Consultation Fee settled from Pre Book", "balance": max(balance, 0), "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/pre-book/apply-advance", response_model=dict)
async def apply_pre_book_advance(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Use the Pre Book advance for Sessions on this patient's Treatment Fee.

    Held to what collecting the Treatment Fee is held to: a treatment plan, a priced session
    package, and the Consultation Fee in. Only before any Treatment Fee is collected -- after
    that the fee has a payment history the advance would have to be threaded into.

    An advance bigger than the package covers it whole, and the rest is reported as left
    over for the branch to return or carry, rather than turned into money owed back by a
    screen nobody is looking at.
    """
    lead = await _lead_or_404(lead_id)
    rec = _record(lead)
    adv = rec.get("advance") or {}
    if not adv.get("amount"):
        raise HTTPException(status_code=400, detail="No Pre Book advance was paid for this patient")
    if adv.get("for") != "sessions":
        raise HTTPException(status_code=400, detail="Only an advance taken for Sessions can be used on the Treatment Fee")
    if adv.get("applied_at"):
        raise HTTPException(status_code=400, detail="The Pre Book advance is already used")
    if lead.get("consultation_decision") != "consultation_treatment":
        raise HTTPException(status_code=400, detail="This patient has no Treatment Fee to use the advance on")
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Collect the Consultation Fee before the Treatment Fee")
    if not lead.get("session_package_id") or lead.get("session_package_price") is None:
        raise HTTPException(status_code=400, detail="No treatment package was selected by the CONSULTANT yet")
    if lead.get("treatment_fee_paid") is not None:
        raise HTTPException(status_code=400, detail="The Treatment Fee is already being collected — the advance can only be used before it starts")

    price = _money(lead["session_package_price"])
    amount = _money(adv["amount"])
    used = min(amount, price)
    left_over = round(amount - used, 2)
    now = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "treatment_fee_paid": used,
        "treatment_fee_payment_mode": PRE_BOOK_MODE,
        "treatment_fee_payment_details": _applied_details(used, price, adv.get("transaction_id")),
        # Same rule as collect_treatment_fee: rests at Fee Collected, unless a physio is
        # already assigned, in which case it does not move backwards.
        "consultation_stage": "Physio Assign" if lead.get("consultation_stage") == "Physio Assign" else "Fee Collected",
        "pre_book.advance.applied_at": now,
        "pre_book.advance.applied_by": user.full_name,
        "pre_book.advance.applied_amount": used,
        "pre_book.advance.left_over": left_over,
        "updated_at": now,
    }})
    balance = round(price - used, 2)
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "pre_book_advance_applied",
        "details": (
            f"Treatment Fee: Pre Book advance of {_rs(used)} used on '{lead.get('session_package_name')}' ({_rs(price)})"
            + (f" · balance {_rs(balance)} owed" if balance > 0.009 else "")
            + (f" · {_rs(left_over)} of the advance left over" if left_over > 0.009 else "")
            + (f" · Pre Book Txn {adv.get('transaction_id')}" if adv.get("transaction_id") else "")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Pre Book advance used on the Treatment Fee", "balance": max(balance, 0), "left_over": left_over, "lead": V3LeadOut(**updated).model_dump()}
