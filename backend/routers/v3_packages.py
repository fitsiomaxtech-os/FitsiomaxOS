"""Packages module — Super Admin creates packages; Branch Admin sells them."""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import store_branch_overrides
from database import v3_col
from deps import v3_require_roles
from schemas.v3 import (
    V3UserOut, V3LeadOut, V3DiagnosisInput, V3SellStoreItemInput,
    V3CollectPackagePaymentInput, V3CollectTreatmentFeeInput, V3CollectDietFeeInput,
    V3CollectDietChartFeeInput,
    V3CollectRehabFeeInput,
    V3PhysioDiagnosisInput, V3TreatmentSummaryInput,
)
from utils import generate_transaction_id
from routers.v3_lead_documents import has_prescription_on_file

router = APIRouter(prefix="/api/v3", tags=["packages"])

# Said once, because both the save and the unlock below say it. The two refusals are the
# same refusal reached from either end of the same box, and a reader who has been told one
# wording on the way in should not meet a different one on the way back.
TREATMENT_FEE_COLLECTED_DETAIL = (
    "Treatment fee collected — the treatment summary can no longer be edited"
)


def _now():
    return datetime.now(timezone.utc).isoformat()


class PackageIn(BaseModel):
    name: str
    weeks: int = Field(ge=1, le=104)
    sessions_per_week: int = Field(ge=1, le=14, default=2)
    price: float = Field(ge=0)
    description: Optional[str] = ""
    services: List[str] = []
    active: bool = True


class PackageOut(PackageIn):
    id: str
    total_sessions: int
    created_at: str
    updated_at: str


@router.get("/packages", response_model=List[PackageOut])
async def list_packages(active_only: bool = False, _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio", "pre_sales", "business_dev"))):
    q = {"active": True} if active_only else {}
    docs = await v3_col("packages").find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs


@router.post("/packages", response_model=PackageOut)
async def create_package(payload: PackageIn, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    doc = payload.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["total_sessions"] = payload.weeks * payload.sessions_per_week
    doc["created_at"] = _now()
    doc["updated_at"] = _now()
    await v3_col("packages").insert_one(doc)
    return doc


@router.put("/packages/{package_id}", response_model=PackageOut)
async def update_package(package_id: str, payload: PackageIn, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    update = payload.model_dump()
    update["total_sessions"] = payload.weeks * payload.sessions_per_week
    update["updated_at"] = _now()
    res = await v3_col("packages").update_one({"id": package_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Package not found")
    doc = await v3_col("packages").find_one({"id": package_id}, {"_id": 0})
    return doc


@router.delete("/packages/{package_id}")
async def delete_package(package_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("packages").delete_one({"id": package_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Package not found")
    return {"message": "Package deleted"}


class SellPackageInput(BaseModel):
    package_id: str
    paid_amount: Optional[float] = None
    notes: Optional[str] = ""


@router.post("/leads/{lead_id}/sell-package", response_model=dict)
async def sell_package(lead_id: str, payload: SellPackageInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "head_physio", "business_dev"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    pkg = await v3_col("packages").find_one({"id": payload.package_id}, {"_id": 0})
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    paid = payload.paid_amount if payload.paid_amount is not None else pkg.get("price", 0)
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "package_id": pkg["id"],
        "package_name": pkg["name"],
        "package_weeks": pkg["weeks"],
        "package_price": pkg["price"],
        "package_paid": paid,
        "consultation_stage": "Treatment Fee",
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "package_sold",
        "details": f"Sold package: {pkg['name']} · {pkg['weeks']}w · ₹{paid}" + (f" · {payload.notes}" if payload.notes else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    return {"message": "Package sold", "lead_id": lead_id, "package": pkg, "paid": paid}


@router.post("/leads/{lead_id}/diagnosis", response_model=V3LeadOut)
async def save_diagnosis(lead_id: str, payload: V3DiagnosisInput, user: V3UserOut = Depends(v3_require_roles("head_physio", "branch_admin", "super_admin", "business_dev"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"diagnosis": payload.diagnosis, "updated_at": _now()}})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "diagnosis_recorded",
        "details": f"Diagnosis recorded by {user.full_name}: {payload.diagnosis}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/sell-store-item", response_model=dict)
async def sell_store_item(lead_id: str, payload: V3SellStoreItemInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin sells + collects payment for a consultation item, in one step."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    item = await store_branch_overrides.overlay_one(
        await v3_col("store_items").find_one({"id": payload.item_id}, {"_id": 0}), lead.get("branch_id")
    )
    if not item:
        raise HTTPException(status_code=404, detail="Store item not found")
    if item.get("item_type", "consultation") == "session":
        raise HTTPException(status_code=400, detail="Session packages are assigned by the consultant, then collected separately — use assign-package / collect-package-payment")

    price = item.get("price_online") if payload.mode == "online" else item.get("price_offline")
    paid = payload.paid_amount if payload.paid_amount is not None else price

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "consultation_fee": paid,
        "consultation_item_name": item["name"],
        "consultation_mode": payload.mode,
        "consultation_payment_mode": payload.payment_mode,
        "consultation_stage": "Consultation Visit",
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_paid",
        "details": f"Consultation '{item['name']}' ({payload.mode}) paid: Rs.{paid} via {payload.payment_mode}" + (f" · {payload.notes}" if payload.notes else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Sold", "lead_id": lead_id, "item": item, "mode": payload.mode, "paid": paid, "lead": V3LeadOut(**updated).model_dump()}


# How this branch takes money. One set, for every fee it collects.
#
# There used to be two. The Treatment Fee could be taken as Cash, UPI, Card, an Account
# Transfer, a Cheque or a Partial Payment schedule; the Consultation, Diet, Diet Chart and
# Rehab fees could only be taken as the first four. That is not a rule about those fees --
# nobody decided a rehab course may not be paid by cheque -- it is only the order the
# endpoints happened to be written in, with the later one learning things the earlier ones
# were never told. A desk that can take a cheque for one fee can take a cheque, and a
# patient who asks to spread a Rs.8000 treatment package over three dates will ask the same
# of a Rs.4000 rehab course.
#
# So the Treatment Fee's way is the way, and every fee is settled through
# settle_standard_payment below: the same six modes, the same splits, the same discount and
# balance rules, the same cash count, the same schedule. The two names remain as aliases
# because other modules import them; both now mean this.
STANDARD_PAYMENT_MODES = {"cash", "upi", "card", "account_transfer", "cheque", "partial"}
CONSULTATION_FEE_PAYMENT_MODES = STANDARD_PAYMENT_MODES
TREATMENT_FEE_PAYMENT_MODES = STANDARD_PAYMENT_MODES

# The modes where money lands in full, there and then: the amount is editable, a
# discount is tracked against it, and an explicit confirmation is required
# before it's accepted. Cheque and Partial Payment are promises of money rather than
# money, so they're deliberately outside this set.
SETTLED_NOW_MODES = ("cash", "upi", "card", "account_transfer")
# The above plus Cheque — every mode that can cover only part of a session package now
# and leave the rest as a scheduled balance. Partial Payment can't: it *is* the schedule.
PART_SESSION_MODES = ("cash", "upi", "card", "cheque", "account_transfer")

# The notes a branch desk takes, and the only ones a cash count may be entered in. Kept in
# step with DENOMINATIONS in frontend/src/components/ConsultationsBoard.jsx.
#
# Anything not listed here is dropped rather than guessed at, so a count in a note this
# desk does not hold cannot quietly become part of a total. A payment recorded before this
# keeps whatever it was counted in — the list governs what may be entered, not what has
# already happened.
DENOMINATIONS = (500, 200, 100, 50, 20, 10)


def settle_fee_money(
    *,
    list_price,
    amount,
    discount_in,
    balance_due_date,
    total_price=None,
    allow_discount=True,
    over_label="above listed fee",
    existing_installments=None,
):
    """The three facts one collection has to keep apart: the discount that was agreed,
    the money that came in, and whatever is still owed.

    Every fee in this file used to work the gap between the price and the amount out as a
    discount. That reads a part payment as a write-off: a desk taking Rs.750 of a Rs.1000
    fee cancelled the Rs.250 the patient was coming back with, and nothing was left on the
    record to collect. A discount is only ever `discount_in` — a figure somebody typed —
    and whatever the amount falls short of the price is a balance, returned here as an
    unpaid installment for the caller to store on the fee's own payment_details. That is
    the same shape a Partial Payment schedule uses, so Payment Schedules, Outstanding
    Amount and the client's own panel read it for free, and it can be collected later
    under any payment mode.

    Shared by all five collect endpoints rather than restated in each, because restating
    it in each is how the same mistake came to be in all five.

    `list_price` is what the discount comes off. `total_price` is the whole bill the
    balance is measured against, and defaults to `list_price` — they differ only for the
    Treatment Fee, where a collection can cover some of a package's sessions: the discount
    is measured against those sessions, the balance against the package.

    `allow_discount` is False for the modes that cannot negotiate one (Cheque and Partial
    Payment keep their locked price), which also stops a discount arriving on a payload
    that has no box to type it in.
    """
    discount = round(discount_in or 0, 2) if allow_discount else 0
    if discount < 0:
        raise HTTPException(status_code=400, detail="Discount cannot be negative")
    if discount > list_price:
        raise HTTPException(status_code=400, detail=f"Discount cannot be more than the Rs.{list_price:g} being collected for")
    net_payable = round(list_price - discount, 2)

    reason = None
    suffix = ""
    if discount > 0:
        reason = "Discount"
        suffix = f" · Actual Price Rs.{list_price}, Discount Rs.{discount}"
    elif allow_discount and amount > net_payable + 0.01:
        # Over the fee is recorded rather than refused — it is usually a rounding-up the
        # patient insisted on — and keeps the negative-discount convention the reports
        # already read, so nothing downstream has to learn a new sign.
        discount = -round(amount - net_payable, 2)
        reason = "Additional amount collected"
        suffix = f" · Actual Price Rs.{net_payable}, Rs.{abs(discount)} {over_label}"

    bill = list_price if total_price is None else total_price
    balance = round(bill - discount - amount, 2)
    installments = None
    carry = None
    balance_suffix = ""
    if balance > 0.009:
        if not balance_due_date:
            raise HTTPException(status_code=400, detail="A due date is required for the balance amount")
        installments = [
            {"amount": amount, "due_date": _now()[:10], "paid": True},
            {"amount": balance, "due_date": balance_due_date, "paid": False},
        ]
        balance_suffix = f" · balance Rs.{balance} due {balance_due_date}"
    elif existing_installments and all(i.get("paid") for i in existing_installments):
        # Nothing new is owed, but this fee has been collected in pieces before and every
        # piece is in. Those rows are the record of how the money actually arrived, and a
        # correction to the mode or the amount is no reason to erase it — dropping them
        # would take the earlier payments out of every schedule and outstanding figure
        # that reads them. Carried only when they are all settled: an unpaid row left over
        # from a balance this collection has now cleared would be a debt nobody owes.
        carry = existing_installments

    return {
        "discount": discount,
        "reason": reason,
        "suffix": suffix,
        "net_payable": net_payable,
        "balance": balance,
        "installments": installments,
        "carry": carry,
        "balance_suffix": balance_suffix,
    }


def _denomination_total(raw) -> tuple:
    """What a counted pile of notes comes to, and the tidied count behind it.

    Anything that is not a note this desk holds, or not a positive whole number of them, is
    dropped: a "3.5 x 500" is a typo, and reading it as 1750 would put a figure in the
    drawer nobody counted.

    Returns (0.0, {}) for a payment that was never counted, which is the same answer as one
    counted to nothing — the caller tells them apart by the empty dict, and only ever
    stores a count that has something in it.
    """
    if not isinstance(raw, dict):
        return 0.0, {}
    clean: dict = {}
    total = 0.0
    for note in DENOMINATIONS:
        for key in (str(note), note):
            if key in raw:
                try:
                    count = int(raw[key])
                except (TypeError, ValueError):
                    count = 0
                if count > 0:
                    clean[str(note)] = count
                    total += note * count
                break
    return round(total, 2), clean


def _settle_cash_count(raw, amount: float, where: str = "") -> dict:
    """The count to store against a cash payment of `amount`, or {} if none was taken.

    Counting is optional — a busy desk records the figure alone, as it always could. But a
    count that was taken has to agree with the money: notes short of the amount, or over
    it, mean one of the two numbers is wrong, and banking either would bank a figure nobody
    checked. So this refuses rather than choosing between them.
    """
    counted, clean = _denomination_total(raw)
    if not clean:
        return {}
    if abs(counted - float(amount)) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"The notes counted{where} come to Rs.{counted:g}, but the cash being collected is Rs.{float(amount):g}",
        )
    return clean


def _notes_label(clean: dict) -> str:
    """A stored count written out for an activity line: "2xRs.500 + 1xRs.200"."""
    return " + ".join(f"{clean[str(d)]}xRs.{d}" for d in DENOMINATIONS if clean.get(str(d)))


def build_payment_details(payload) -> tuple:
    """(details, human suffix) for whichever mode this payment used.

    The one place a mode's own fields are checked and written down, for every fee. The
    Consultation Fee and the Treatment Fee each used to keep their own copy of this beside
    the other three that shared it — three readings of the same rules, which is three
    places for them to drift apart. Both now come through here.

    Cash and Partial Payment are not here: neither has bank fields to check, and both need
    the amount to say anything at all (what the notes came to, what the installments add up
    to). They are settled in _standard_payment_record below, which has it.

    An Account Transfer persists only the last four digits of the account number; the
    full number is never stored, and that rule lives here so no future caller can forget it.
    Card keeps no account at all -- see below.
    """
    mode = payload.payment_mode
    if mode == "upi":
        # Transaction id alone: none of the Collect popups ask for a UTR any more, and a
        # field the form cannot supply would reject every UPI collection. A caller that
        # still sends one has it recorded.
        if not (payload.upi_transaction_id or "").strip():
            raise HTTPException(status_code=400, detail="UPI Transaction ID is required")
        txn = payload.upi_transaction_id.strip()
        utr = (payload.upi_utr or "").strip()
        # Which company UPI ID took the money, when the desk picked one off the list of
        # them. Recorded rather than required: a payment is a payment whether or not
        # anyone said where it landed, and every UPI collection taken before the picker
        # existed has no answer to give.
        details = {"upi_transaction_id": txn}
        suffix = f" · UPI txn {txn}"
        if utr:
            details["upi_utr"] = utr
            suffix += f", UTR {utr}"
        bank_upi = (getattr(payload, "upi_id", "") or "").strip()
        if bank_upi:
            details["upi_id"] = bank_upi
            suffix += f" to {bank_upi}"
        return details, suffix

    if mode == "card":
        # The terminal's transaction id, and nothing else. Card used to be held to an
        # Account Transfer's four bank fields, which the desk had no way of answering
        # truthfully: a card is swiped on a machine that prints one reference, and the
        # card in the patient's hand carries no account number and no IFSC. Whatever got
        # typed into those boxes to get past the check was invented, and a made-up account
        # on a payment record is worse than no account at all. The transaction id is the
        # one thing a disputed swipe is actually traced by.
        txn = (payload.card_transaction_id or "").strip()
        if not txn:
            raise HTTPException(status_code=400, detail="Card Transaction ID is required")
        return {"card_transaction_id": txn}, f" · Card txn {txn}"

    if mode == "account_transfer":
        required = [payload.account_number, payload.account_holder_name, payload.bank_name, payload.ifsc_code]
        if not all((f or "").strip() for f in required):
            raise HTTPException(status_code=400, detail="Account Number, Account Holder Name, Bank Name and IFSC Code are required")
        if not (payload.transfer_reference or "").strip():
            raise HTTPException(status_code=400, detail="Reference/UTR No. is required for an Account Transfer")
        last4 = "".join(ch for ch in payload.account_number if ch.isdigit())[-4:]
        holder = payload.account_holder_name.strip()
        bank = payload.bank_name.strip()
        ifsc = payload.ifsc_code.strip().upper()
        details = {
            "account_last4": last4,
            "account_holder_name": holder,
            "bank_name": bank,
            "ifsc_code": ifsc,
            "transfer_reference": payload.transfer_reference.strip(),
        }
        suffix = f" · A/C ****{last4}, {holder}, {bank} ({ifsc}) · Ref {details['transfer_reference']}"
        return details, suffix

    if mode == "cheque":
        # The bank it is drawn on and its number: between them, the two things anyone
        # chasing an uncleared cheque a fortnight later has to be able to quote.
        bank = (getattr(payload, "bank_name", None) or "").strip()
        number = (getattr(payload, "cheque_number", None) or "").strip()
        if not bank or not number:
            raise HTTPException(status_code=400, detail="Bank Name and Cheque Number are required")
        return {"bank_name": bank, "cheque_number": number}, f" · Cheque #{number}, {bank}"

    return {}, ""


PARTIAL_ORDINALS = ("First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth")


def _installment_label(idx: int) -> str:
    return PARTIAL_ORDINALS[idx] if idx < len(PARTIAL_ORDINALS) else f"#{idx + 1}"


def _standard_payment_record(payload, amount: float, lines: list, fee_label: str) -> tuple:
    """(details, human suffix) for one collection, whichever way the money arrived.

    Everything build_payment_details cannot settle on the fields alone, because it needs to
    know how much was being collected: a split's per-tender counts, a lone cash payment's
    count, and a Partial Payment schedule that has to add up to the fee.
    """
    mode = payload.payment_mode

    if lines:
        # Each cash tender counted against its own amount, not the whole fee: the cash
        # half of a Rs.8000 cash + Rs.4000 UPI split is Rs.8000, and checking those notes
        # against Rs.12000 would reject a correct count every time.
        line_notes = [
            _settle_cash_count(ln.denominations, ln.amount, f" for the Rs.{ln.amount:g} cash payment") if ln.mode == "cash" else {}
            for ln in lines
        ]
        # Each tender kept whole, in the order it was entered, so a receipt or a query
        # months later can still say which part of the fee came in which way -- and, for
        # cash, what it was counted out in.
        details = {"payment_lines": [
            {
                "mode": ln.mode,
                "amount": ln.amount,
                "reference": (ln.reference or "").strip(),
                "denominations": counted,
            }
            for ln, counted in zip(lines, line_notes)
        ]}
        suffix = " · Split: " + ", ".join(
            f"Rs.{ln.amount:g} {ln.mode}"
            + (f" ({ln.reference.strip()})" if (ln.reference or "").strip() else "")
            + (f" [{_notes_label(counted)}]" if counted else "")
            for ln, counted in zip(lines, line_notes)
        )
        return details, suffix

    if mode == "cash":
        # Cash has one thing to record: what the notes were, when somebody counted them.
        # Left empty when nobody did, so the record says "not counted" rather than
        # "counted, and it came to nothing".
        counted = _settle_cash_count(payload.denominations, amount)
        if counted:
            return {"denominations": counted}, f" · Counted {_notes_label(counted)}"
        return {}, ""

    if mode == "partial":
        installments = getattr(payload, "partial_installments", None) or []
        if len(installments) < 2:
            raise HTTPException(status_code=400, detail="At least two installments are required for Partial Payment")
        if any(inst.amount <= 0 or not inst.due_date for inst in installments):
            raise HTTPException(status_code=400, detail="Every installment needs an amount and a due date")
        if round(sum(inst.amount for inst in installments), 2) != round(amount, 2):
            raise HTTPException(status_code=400, detail=f"Installment amounts must add up to the {fee_label}")
        details = {
            # This call only schedules the plan -- every installment starts unpaid.
            # Collecting one (including one due today) is a separate, explicit action
            # (mark_installment_paid), not an automatic side effect of scheduling.
            "installments": [{"amount": inst.amount, "due_date": inst.due_date, "paid": False} for inst in installments],
        }
        parts = [f"{_installment_label(i)} Rs.{inst.amount} due {inst.due_date}" for i, inst in enumerate(installments)]
        return details, f" · {', '.join(parts)}"

    details, suffix = build_payment_details(payload)
    if mode == "cheque":
        # What the cheque is written for, kept with the cheque. The fee's own paid figure
        # is the same number today, but a later correction moves that and must not quietly
        # rewrite what the branch is holding in the drawer.
        details["amount"] = amount
    return details, suffix


async def settle_standard_payment(
    *,
    lead: dict,
    payload,
    fee_label: str,
    list_price: float,
    total_price: Optional[float] = None,
    existing_installments=None,
    over_label: str = "above listed fee",
) -> dict:
    """One fee collection, settled the one way this branch settles money.

    Every fee -- Consultation, Treatment, Diet, Diet Chart, Rehab -- is taken by the same
    six payment modes and put through here. Before, the Treatment Fee had a process and the
    other four had a smaller one: no cheque, no schedule, no splitting a fee across two
    tenders. Which fee it was decided what a patient was allowed to do with their money,
    and nobody ever set that rule -- it is only where the code had got to, the later
    endpoint having learnt things the earlier ones were never told.

    What is left to the caller is only what is genuinely particular to a fee: what it costs,
    which fields on the lead it is written to, and what its activity line says. Everything
    about the money itself is here.

    `list_price` is what the discount comes off and what a cheque is written for.
    `total_price` is the whole bill a balance is measured against, and defaults to
    `list_price` -- they differ only for the Treatment Fee, where one collection can cover
    some of a package's sessions and leave the rest owing.

    Returns the settled figures and the record to store: `amount`, `mode` (which reads
    "split" when the fee arrived in more than one tender), `details`, `transaction_id`
    (None for a schedule, since no money moved), the suffixes an activity line is written
    from, and `settled` -- settle_fee_money's own result, for the callers that need the
    balance it worked out.
    """
    mode = payload.payment_mode
    if mode not in STANDARD_PAYMENT_MODES:
        raise HTTPException(status_code=400, detail=f"{fee_label} only accepts: {sorted(STANDARD_PAYMENT_MODES)}")

    # A fee that arrived in more than one piece -- see V3PaymentLineInput. Every tender has
    # to be money that settles today: a cheque clears when it clears, and Partial Payment
    # is a plan for later, so neither can be half of what was taken now.
    lines = getattr(payload, "payment_lines", None) or []
    if lines:
        if mode not in SETTLED_NOW_MODES:
            raise HTTPException(status_code=400, detail="A split settles now -- Cheque and Partial Payment go in as a single payment")
        for line in lines:
            if line.mode not in SETTLED_NOW_MODES:
                raise HTTPException(status_code=400, detail=f"A split payment accepts: {sorted(SETTLED_NOW_MODES)}")
            if line.amount is None or line.amount <= 0:
                raise HTTPException(status_code=400, detail="Every payment in a split must be more than zero")

    # Only the modes that settle now can negotiate a discount or move the amount; the other
    # two keep the listed price, because there is nothing on the desk yet to haggle over.
    settles_now = mode in SETTLED_NOW_MODES
    net_payable = round(list_price - (round(payload.discount_amount or 0, 2) if settles_now else 0), 2)

    if settles_now:
        if lines:
            # Summed from the tenders rather than taken alongside them. Two numbers for one
            # sum is one too many: they can only ever disagree, and the parts are what was
            # actually handed over.
            amount = round(sum(line.amount for line in lines), 2)
            # Still checked against what the screen was collecting, so a total that drifted
            # from the fee on display is refused rather than quietly banked.
            if payload.amount is not None and abs(payload.amount - amount) > 0.01:
                raise HTTPException(
                    status_code=400,
                    detail=f"The payments add up to Rs.{amount:g}, but the fee being collected is Rs.{payload.amount:g}",
                )
        else:
            amount = payload.amount if payload.amount is not None else net_payable
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be greater than zero")
        if not payload.confirmed:
            raise HTTPException(status_code=400, detail="Please confirm the payment before submitting")
    elif mode == "cheque":
        amount = list_price
    else:
        # A schedule covers the whole bill, not the slice a part-session collection is for.
        amount = list_price if total_price is None else total_price
        # A plan with money already in it is not a plan any more. Re-planning writes a
        # fresh set of rows, every one of them unpaid, so an installment the patient has
        # already handed over would come back as still owing -- the collection erased, its
        # transaction id with it, and the branch chasing money it has.
        #
        # Refused here rather than left to the screens. The boards route a fee that has a
        # balance to the installment collector rather than back to the planner, so this is
        # not a button anybody can find; but a rule only the UI knows is a rule anyone
        # holding the URL can walk past, and this one is worth more than that.
        if any(inst.get("paid") for inst in (existing_installments or [])):
            raise HTTPException(
                status_code=400,
                detail="Part of this payment schedule has already been collected — collect the remaining installments rather than re-planning it",
            )

    # The discount that was agreed, and whatever is still owed once this money is in --
    # one rule, shared with every other fee.
    settled = settle_fee_money(
        list_price=list_price,
        total_price=total_price,
        amount=amount,
        discount_in=payload.discount_amount,
        balance_due_date=payload.balance_due_date,
        allow_discount=settles_now,
        over_label=over_label,
        existing_installments=existing_installments,
    )

    details, detail_suffix = _standard_payment_record(payload, amount, lines, fee_label)

    # Both go on the record, not only into the activity line: the discount so reopening the
    # popup reloads what was agreed instead of starting at zero, and the balance so every
    # panel that reads a schedule can show it and collect it later.
    if settled["discount"] > 0:
        details["discount_amount"] = settled["discount"]
    if not details.get("installments") and (settled["installments"] or settled["carry"]):
        # The new balance if this collection left one, otherwise whatever schedule the fee
        # already had -- see settle_fee_money: a correction must not erase how the money
        # came in. Never over a schedule Partial Payment has just written.
        details["installments"] = settled["installments"] or settled["carry"]

    # Partial Payment only schedules a plan -- no money moves, so it gets no transaction id.
    # Each installment is collected separately and earns its own.
    transaction_id = None
    if mode != "partial":
        transaction_id = await generate_transaction_id(lead.get("branch_id"))
        details["transaction_id"] = transaction_id

    return {
        "amount": amount,
        # "split" rather than one of the four, for the same reason the lines exist: naming
        # any one of them would make the record say something only part true. The breakdown
        # is in details and spelled out on the activity line.
        "mode": "split" if lines else mode,
        "details": details,
        "transaction_id": transaction_id,
        "detail_suffix": detail_suffix,
        "discount": settled["discount"],
        "discount_reason": settled["reason"],
        "discount_suffix": settled["suffix"],
        "balance_suffix": settled["balance_suffix"],
        "is_schedule": mode == "partial",
        "settles_now": settles_now,
        "settled": settled,
    }


# Which shelf each diet fee is collected against: one each, under Services and Products >
# Diet Details. The Diet Consultation Fee is priced under Diet Consultation (item_type
# "diet"), the Diet Chart Fee under Diet Chart ("diet_package").
#
# Both routes used to take an item off either shelf, from when the two products had no
# shelf of their own to be told apart by, and the screen picked between them by name — so
# a chart named anything else could be charged at the consultation's price. Now that each
# has its own sub-tab the shelf IS what says which fee a price belongs to, and the server
# holds a fee to it the same as the collect popup does.
DIET_CONSULTATION_ITEM_TYPE = "diet"
DIET_CHART_ITEM_TYPE = "diet_package"

# Aliases for the one standard set, kept only so a reader following a fee to its modes
# lands somewhere. Diet, Diet Chart and Rehab are collected exactly as the Treatment Fee
# is -- see STANDARD_PAYMENT_MODES.
DIET_FEE_PAYMENT_MODES = STANDARD_PAYMENT_MODES
REHAB_FEE_PAYMENT_MODES = STANDARD_PAYMENT_MODES


@router.post("/leads/{lead_id}/collect-diet-fee", response_model=dict)
async def collect_diet_fee(lead_id: str, payload: V3CollectDietFeeInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin collects the Diet Consultation Fee.

    Collected exactly as every other fee is -- see settle_standard_payment, which settles
    the money for all five. It used to be the smaller process: four payment modes, one
    tender, no cheque and no schedule. A diet consultation being a single visit at a single
    price is a fact about the product, not about how a patient is allowed to pay for it.

    The Diet Package is chosen HERE rather than upstream. The Head Physio picks a treatment
    package during their decision, but they never pick a diet one — diet is optional and
    often decided after the treatment is under way — so the item is named at the point the
    money is taken.

    Deliberately does not touch consultation_stage. Diet is a parallel vertical: taking
    this fee is not progress through the physio pipeline, and moving that stage as a side
    effect of a diet payment would misreport where the patient actually is.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # The Consultation Fee is the only prerequisite. Not the Treatment Fee: a patient can
    # come for a diet consultation and nothing else, and gating on treatment would shut
    # that door.
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Collect the Consultation Fee first")

    item = await store_branch_overrides.overlay_one(await v3_col("store_items").find_one(
        {"id": payload.item_id, "item_type": DIET_CONSULTATION_ITEM_TYPE}, {"_id": 0}
    ), lead.get("branch_id"))
    if not item:
        raise HTTPException(
            status_code=404,
            detail="Diet Consultation not found. Add one in Services and Products > Diet Details > Diet Consultation.",
        )

    original_price = item.get("price_online") if payload.mode == "online" else item.get("price_offline")
    if original_price is None:
        raise HTTPException(status_code=400, detail=f"This Diet Consultation has no {payload.mode} price set")

    taken = await settle_standard_payment(
        lead=lead,
        payload=payload,
        fee_label="Diet Consultation Fee",
        list_price=original_price,
        existing_installments=(lead.get("diet_fee_payment_details") or {}).get("installments"),
    )
    amount = taken["amount"]
    transaction_id = taken["transaction_id"]
    is_update = lead.get("diet_fee_paid") is not None

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "diet_package_id": item["id"],
        "diet_package_name": item["name"],
        "diet_package_price": original_price,
        "diet_package_mode": payload.mode,
        "diet_fee_paid": amount,
        "diet_fee_payment_mode": taken["mode"],
        "diet_fee_payment_details": taken["details"],
        # The fee IS the referral when nobody recommended one — same reasoning as
        # book_diet_appointment, so a paying patient reaches the coach's queue either way.
        "diet_recommended": True,
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "transaction_id": transaction_id,
        "lead_id": lead_id,
        "action": "diet_fee_collected",
        "details": (
            f"{'Updated' if is_update else 'Created'} Payment Schedule for Diet Consultation Fee Rs.{amount} for '{item['name']}' ({payload.mode})"
            f" across {len(taken['details']['installments'])} installments{taken['detail_suffix']}"
            if taken["is_schedule"] else
            f"{'Updated' if is_update else 'Collected'} Diet Consultation Fee Rs.{amount} for '{item['name']}' ({payload.mode}) via {taken['mode']}{taken['detail_suffix']}{taken['discount_suffix']}{taken['balance_suffix']} · Txn {transaction_id}"
        ),
        "original_amount": original_price if taken["settles_now"] else None,
        "collected_amount": amount if taken["settles_now"] else None,
        "discount_amount": taken["discount"] if taken["discount"] != 0 else None,
        "discount_reason": taken["discount_reason"],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Payment collected", "transaction_id": transaction_id, "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/collect-diet-chart-fee", response_model=dict)
async def collect_diet_chart_fee(lead_id: str, payload: V3CollectDietChartFeeInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin collects the Diet Chart Fee.

    The second of the two things sold under the word "diet", and the one that gates what
    the patient can see. A Diet Consultation buys time with a Nutrition Coach; a Diet Chart
    buys the written plan itself, and the Client Portal will not show that plan until this
    fee is in — see v3_patient_portal._build_portal_payload.

    Its own fields on the lead rather than a second write to diet_fee_paid, because a
    patient can be sold both on one visit. Sharing one pair of fields would make whichever
    fee was collected second erase the first, and the branch would have no way to say which
    of the two products the money on file was actually for.

    Collected by the same six payment modes as every other fee, through the same
    settle_standard_payment: a chart is one plan at one price, but what a patient may pay
    that price with is the branch's rule, not this product's.

    Collectable any time the Consultation Fee is in, on its own or beside the Diet
    Consultation Fee: the branch takes either of the two diet fees, in whichever order the
    patient buys them. It used to wait on the Diet Consultation Fee and on the Nutritionist
    recommending a chart, which left the desk one collect option where it sells two
    products. Collecting it is itself the referral for a chart (diet_chart below), so the
    coach's chart queue still finds the patient.

    Does not touch consultation_stage, for the same reason collect_diet_fee does not: diet
    is a parallel vertical, and moving the physio pipeline as a side effect of a diet
    payment would misreport where the patient actually is.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Collect the Consultation Fee first")

    item = await store_branch_overrides.overlay_one(await v3_col("store_items").find_one(
        {"id": payload.item_id, "item_type": DIET_CHART_ITEM_TYPE}, {"_id": 0}
    ), lead.get("branch_id"))
    if not item:
        raise HTTPException(
            status_code=404,
            detail="Diet Chart not found. Add one in Services and Products > Diet Details > Diet Chart.",
        )

    original_price = item.get("price_online") if payload.mode == "online" else item.get("price_offline")
    if original_price is None:
        raise HTTPException(status_code=400, detail=f"This Diet Chart has no {payload.mode} price set")

    taken = await settle_standard_payment(
        lead=lead,
        payload=payload,
        fee_label="Diet Chart Fee",
        list_price=original_price,
        existing_installments=(lead.get("diet_chart_fee_payment_details") or {}).get("installments"),
    )
    amount = taken["amount"]
    transaction_id = taken["transaction_id"]
    is_update = lead.get("diet_chart_fee_paid") is not None

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "diet_chart_package_id": item["id"],
        "diet_chart_package_name": item["name"],
        "diet_chart_package_price": original_price,
        "diet_chart_package_mode": payload.mode,
        "diet_chart_fee_paid": amount,
        "diet_chart_fee_payment_mode": taken["mode"],
        "diet_chart_fee_payment_details": taken["details"],
        # Paying for a chart IS the referral for one, exactly as the Diet Consultation Fee
        # is its own — both flags, because /diet/consultations reads diet_recommended to
        # decide who is in the vertical at all and the coach's chart queue reads
        # diet_chart to decide who is owed a chart. Without these a patient could pay for a
        # chart nobody was ever asked to write.
        "diet_recommended": True,
        "diet_chart": True,
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "transaction_id": transaction_id,
        "lead_id": lead_id,
        "action": "diet_chart_fee_collected",
        "details": (
            f"{'Updated' if is_update else 'Created'} Payment Schedule for Diet Chart Fee Rs.{amount} for '{item['name']}' ({payload.mode})"
            f" across {len(taken['details']['installments'])} installments{taken['detail_suffix']}"
            if taken["is_schedule"] else
            f"{'Updated' if is_update else 'Collected'} Diet Chart Fee Rs.{amount} for '{item['name']}' ({payload.mode}) via {taken['mode']}{taken['detail_suffix']}{taken['discount_suffix']}{taken['balance_suffix']} · Txn {transaction_id}"
        ),
        "original_amount": original_price if taken["settles_now"] else None,
        "collected_amount": amount if taken["settles_now"] else None,
        "discount_amount": taken["discount"] if taken["discount"] != 0 else None,
        "discount_reason": taken["discount_reason"],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Payment collected", "transaction_id": transaction_id, "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/collect-package-payment", response_model=dict)
async def collect_package_payment(lead_id: str, payload: V3CollectPackagePaymentInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin collects the Consultation Fee for the package the consultant
    already assigned.

    Taken through settle_standard_payment, like every other fee: the same six modes, and
    the same rules about what may be done with each. The amount defaults to package_price
    and Branch Admin can override it for the modes that settle now (discount, rounding,
    part payment), each of which requires an explicit `confirmed` acknowledgement — a
    deliberate double-check, not just clicking Collect once. Cheque and Partial Payment
    keep the assigned price, as they do everywhere.

    Callable while the lead is at 'Consultation Visit' (first collection) or already at
    'Fee Collected' (correcting/updating a payment already on file)."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("consultation_stage") not in ("Consultation Visit", "Fee Collected"):
        raise HTTPException(status_code=400, detail="Consultation Fee can only be collected once the CONSULTANT has completed the consultation")
    # Which package is being sold. Picked at the desk now: the consultation used to have
    # one price and nothing to choose, and the package was assigned silently when the
    # consultant filed their decision -- picking whichever consultation item the database
    # happened to return first, which was harmless while there was only one and arbitrary
    # the moment there were three. That auto-assign is gone (see v3_head_physio_board), so
    # the choice arrives here.
    #
    # The price is read off the item, never taken from the client: the amount the desk
    # sends is what was handed over, and what it was owed is not the same question.
    package_updates: dict = {}
    if payload.consultation_item_id:
        item = await store_branch_overrides.overlay_one(await v3_col("store_items").find_one(
            {"id": payload.consultation_item_id}, {"_id": 0}
        ), lead.get("branch_id"))
        if not item:
            raise HTTPException(status_code=404, detail="Consultation package not found")
        # A House Visit patient's consultation is sold off Home Visit > Consultant rather
        # than the Consultations shelf -- the consultant went to their home.
        home_pkg = item.get("category") == "home_visit_consultation" and lead.get("visit_type") == "home"
        if item.get("item_type") != "consultation" and not home_pkg:
            raise HTTPException(
                status_code=400,
                detail="Only a Consultation package can be sold as the Consultation Fee",
            )
        # Online and offline are priced separately, and which one applies is a fact about
        # the appointment rather than anything the desk chooses while taking the money.
        mode = lead.get("appointment_mode") or "offline"
        if home_pkg:
            # The package booked with the appointment costs what was agreed then --
            # including an amount the branch typed for a Distance visit. Any other Home
            # Visit package costs what the catalogue says; one with no catalogue price
            # can only be sold on the booking that typed it.
            if item["id"] == lead.get("visit_package_id") and lead.get("visit_package_price") is not None:
                price = lead["visit_package_price"]
            elif item.get("manual_price"):
                raise HTTPException(
                    status_code=400,
                    detail=f"'{item.get('name')}' is priced when the appointment is booked. Rebook the appointment on it to set the amount.",
                )
            else:
                rate = float(item.get("price_offline") or 0)
                visits = int(item.get("sessions_offline") or 0)
                price = round(rate if item.get("price_is_total") else rate * visits)
        else:
            price = item.get("price_online") if mode == "online" else item.get("price_offline")

        # Correcting a collection already taken for this same package keeps the price it
        # was taken at. This endpoint does first collections and corrections both, and the
        # screen re-sends the package either way -- so without this, reopening a months-old
        # payment to fix its payment mode would quietly re-price it at today's catalogue
        # rate, and the patient's receipt would stop matching what they actually paid.
        # Switching to a different package is a different sale and does re-price.
        if item["id"] == lead.get("package_id") and lead.get("package_price") is not None:
            price = lead["package_price"]

        if price is None:
            raise HTTPException(
                status_code=400,
                detail=f"'{item.get('name')}' has no {mode} price set. Add one in Services & Products.",
            )
        package_updates = {
            "package_id": item["id"],
            "package_name": item["name"],
            "package_price": price,
            "package_duration_minutes": item.get("duration_minutes"),
            "package_mode": mode,
            "consultation_package": item.get("consultation_package"),
        }
        lead = {**lead, **package_updates}

    if not lead.get("package_id") or lead.get("package_price") is None:
        raise HTTPException(status_code=400, detail="Select the consultation package being collected for")
    # Paperwork before money, enforced here and not only on the screen that asks for it.
    # The Consultation Visit panel locks its Collect tab until the prescription is filed,
    # but that lock is one screen's manners: the Collect button at the end of a row on the
    # list opened the popup straight off the lead, and any caller holding the URL reaches
    # this endpoint with no screen involved at all. A rule only the UI knows is a rule
    # anyone can walk past, so the fee is refused here until the page is actually on file.
    #
    # First collection only. Correcting or topping up a fee already taken is not the moment
    # to withhold a receipt over a page nobody filed at the time — and this endpoint is the
    # one that does both.
    if lead.get("package_paid") is None and not await has_prescription_on_file(lead_id):
        raise HTTPException(
            status_code=400,
            detail="Upload the patient's prescription before collecting the Consultation Fee",
        )

    original_price = lead["package_price"]

    taken = await settle_standard_payment(
        lead=lead,
        payload=payload,
        fee_label="Consultation Fee",
        list_price=original_price,
        over_label="above assigned fee",
        existing_installments=(lead.get("package_payment_details") or {}).get("installments"),
    )
    amount = taken["amount"]
    transaction_id = taken["transaction_id"]
    is_update = lead.get("package_paid") is not None

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        # The package goes on the lead in the same write as the money taken for it, so a
        # collection can never be filed against a package the lead is not recorded as
        # having been sold.
        **package_updates,
        "package_paid": amount,
        "package_payment_mode": taken["mode"],
        "package_payment_details": taken["details"],
        "consultation_stage": "Fee Collected",
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "transaction_id": transaction_id,
        "lead_id": lead_id,
        "action": "package_payment_collected",
        "details": (
            f"{'Updated' if is_update else 'Created'} Payment Schedule for Consultation Fee Rs.{amount} for package '{lead.get('package_name')}'"
            f" across {len(taken['details']['installments'])} installments{taken['detail_suffix']}"
            if taken["is_schedule"] else
            f"{'Updated' if is_update else 'Collected'} Consultation Fee Rs.{amount} for package '{lead.get('package_name')}' via {taken['mode']}{taken['detail_suffix']}{taken['discount_suffix']}{taken['balance_suffix']} · Txn {transaction_id}"
        ),
        "original_amount": original_price if taken["settles_now"] else None,
        "collected_amount": amount if taken["settles_now"] else None,
        "discount_amount": taken["discount"] if taken["discount"] != 0 else None,
        "discount_reason": taken["discount_reason"],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Payment collected", "transaction_id": transaction_id, "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/collect-rehab-fee", response_model=dict)
async def collect_rehab_fee(lead_id: str, payload: V3CollectRehabFeeInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin collects the Rehab course fee.

    The course was chosen by the Consultant at the consultation decision, so it is read
    off the lead rather than picked again here — the same way the Treatment Fee reads
    session_package_id. Collected through settle_standard_payment, like every other fee:
    the same six modes, and a Rs.9000 course can be spread over a schedule exactly as a
    treatment package can.

    Deliberately does not touch consultation_stage. Rehab is a parallel programme, and
    moving the physio pipeline as a side effect of a rehab payment would misreport
    where the patient actually is — the same reasoning collect_diet_fee gives.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # The Consultation Fee is the only prerequisite, as it is for diet: a patient can be
    # sent to rehab without ever buying a treatment package.
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Collect the Consultation Fee first")
    if not lead.get("rehab_package_id") or lead.get("rehab_package_price") is None:
        raise HTTPException(status_code=400, detail="No Rehab course was chosen at the consultation yet")

    original_price = lead["rehab_package_price"]

    taken = await settle_standard_payment(
        lead=lead,
        payload=payload,
        fee_label="Rehab Fee",
        list_price=original_price,
        existing_installments=(lead.get("rehab_fee_payment_details") or {}).get("installments"),
    )
    amount = taken["amount"]
    transaction_id = taken["transaction_id"]
    is_update = lead.get("rehab_fee_paid") is not None

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "rehab_fee_paid": amount,
        "rehab_fee_payment_mode": taken["mode"],
        "rehab_fee_payment_details": taken["details"],
        # The fee is the referral when nobody ticked one — same reasoning collect_diet_fee
        # gives, so a paying patient is on the rehab list either way.
        "rehab_referred": True,
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "transaction_id": transaction_id,
        "lead_id": lead_id,
        "action": "rehab_fee_collected",
        "details": (
            f"{'Updated' if is_update else 'Created'} Payment Schedule for Rehab Fee Rs.{amount} for '{lead.get('rehab_package_name', 'Rehab')}' ({lead.get('rehab_package_mode') or 'offline'})"
            f" across {len(taken['details']['installments'])} installments{taken['detail_suffix']}"
            if taken["is_schedule"] else
            f"{'Updated' if is_update else 'Collected'} Rehab Fee Rs.{amount} for '{lead.get('rehab_package_name', 'Rehab')}' ({lead.get('rehab_package_mode') or 'offline'}) via {taken['mode']}{taken['detail_suffix']}{taken['discount_suffix']}{taken['balance_suffix']} · Txn {transaction_id}"
        ),
        "original_amount": original_price if taken["settles_now"] else None,
        "collected_amount": amount if taken["settles_now"] else None,
        "discount_amount": taken["discount"] if taken["discount"] != 0 else None,
        "discount_reason": taken["discount_reason"],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Payment collected", "transaction_id": transaction_id, "lead": V3LeadOut(**updated).model_dump()}


class V3SessionPackageAmountInput(BaseModel):
    # The amount for ONE session. The package's price is this times its session count.
    per_session_amount: float


@router.post("/leads/{lead_id}/session-package-amount", response_model=dict)
async def set_session_package_amount(lead_id: str, payload: V3SessionPackageAmountInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """The Branch Admin prices a Treatment Package that has no catalogue price (a Home
    Visit > Physiotherapy Distance package). Only before the Treatment Fee is collected:
    after that the figure is a financial record."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # Read off the package as well as the lead, so a lead saved before the lead carried
    # the mark can still be priced.
    manual = bool(lead.get("session_package_manual"))
    if not manual and lead.get("session_package_id"):
        pkg = await store_branch_overrides.overlay_one(
            await v3_col("store_items").find_one({"id": lead["session_package_id"]}, {"_id": 0, "id": 1, "manual_price": 1}),
            lead.get("branch_id"),
        )
        manual = bool(pkg and pkg.get("manual_price"))
    if not manual:
        raise HTTPException(status_code=400, detail="This package has a fixed price")
    if lead.get("treatment_fee_paid") is not None:
        raise HTTPException(status_code=400, detail="The Treatment Fee has already been collected")
    if not payload.per_session_amount or payload.per_session_amount <= 0:
        raise HTTPException(status_code=400, detail="Enter an amount above 0")
    # The desk agrees a per-session figure; the package is that many sessions of it, and
    # the Treatment Fee is collected on the whole.
    per_session = round(float(payload.per_session_amount), 2)
    sessions = int(lead.get("session_package_sessions") or 0)
    amount = round(per_session * sessions, 2) if sessions > 0 else per_session
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"session_package_price": amount, "session_package_manual": True, "updated_at": _now()}})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "session_package_amount_set",
        "details": f"Treatment package amount set · {lead.get('session_package_name') or 'package'} · Rs.{per_session} x {sessions or 1} sessions = Rs.{amount}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Amount saved", "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/collect-treatment-fee", response_model=dict)
async def collect_treatment_fee(lead_id: str, payload: V3CollectTreatmentFeeInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch admin collects the Treatment Fee for the Session package the Head
    Physio already chose during the consultation decision (Consultation + Treatment).

    Settled by settle_standard_payment, which every fee now goes through — this endpoint's
    way of taking money is what that function was made out of. The package itself is locked
    in from session_package_id, so what is particular here is only the sessions: one
    collection can cover some of them (`sessions_now`) and leave the rest owing, which is
    why the discount is measured against what today's sessions cost while the balance is
    measured against the whole package.

    Both Consultation Fee and Treatment Fee are collected while the lead rests in the
    'Fee Collected' stage; it stays there after this call — moving on to Physio Assign is a
    separate, explicit action (assign-consultation-physio), not a side effect of payment."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("consultation_decision") != "consultation_treatment":
        raise HTTPException(status_code=400, detail="This patient's consultation was marked 'Consultation Only' — no Treatment Fee to collect")
    # The honest test for "has the Consultation Fee been collected" is the fee itself, not
    # the stage that collection usually leaves behind -- the same test collect_diet_fee and
    # collect_rehab_fee make, and the one this message has always described.
    #
    # The stage was never a safe proxy for it. Save & Move stamps the hand-off stage every
    # time it runs, so a Head Physio editing a decision already made -- correcting the
    # package, ticking Diet -- sent a lead the desk had already taken the Consultation Fee
    # from back to 'Consultation Visit'. The Treatment Fee card sits right there on that
    # panel, offered the moment the Consultation Fee is in, and pressing it was refused for
    # the rest of the patient's visit with a message about a fee that was already paid.
    # (hp_consultation_decision no longer marches a lead backwards either; this holds for
    # every lead already stranded by the ones that did.)
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Treatment Fee can only be collected after the Consultation Fee has been collected")
    # A House Visit is collected on a per-session fee typed at the desk. It prices the
    # package here, before anything else reads the price, and only while nothing has been
    # collected on it — after that the figure is a financial record.
    if (payload.per_session_fee is not None and lead.get("visit_type") == "home"
            and lead.get("session_package_id") and lead.get("treatment_fee_paid") is None):
        if payload.per_session_fee <= 0:
            raise HTTPException(status_code=400, detail="Enter a per session fee above 0")
        pkg_sessions = int(lead.get("session_package_sessions") or 0) or 1
        priced = round(float(payload.per_session_fee) * pkg_sessions, 2)
        if priced != lead.get("session_package_price"):
            await v3_col("leads").update_one({"id": lead_id}, {"$set": {"session_package_price": priced, "updated_at": _now()}})
            await v3_col("lead_activity").insert_one({
                "id": str(uuid.uuid4()),
                "lead_id": lead_id,
                "action": "session_package_amount_set",
                "details": f"House Visit treatment priced · Rs.{payload.per_session_fee}/session × {pkg_sessions} sessions = Rs.{priced}",
                "created_by": user.full_name,
                "created_by_role": user.role,
                "created_at": _now(),
            })
            lead["session_package_price"] = priced
    if lead.get("session_package_id") and lead.get("session_package_manual") and lead.get("session_package_price") is None:
        raise HTTPException(status_code=400, detail="Enter the amount for this treatment package first")
    if not lead.get("session_package_id") or lead.get("session_package_price") is None:
        raise HTTPException(status_code=400, detail="No treatment package was selected by the CONSULTANT yet")

    original_price = lead["session_package_price"]
    total_sessions = lead.get("session_package_sessions") or 0
    per_session_rate = (original_price / total_sessions) if total_sessions else 0

    # Cash/UPI/Card/Cheque can ALSO collect for only some of the package's sessions
    # right now (e.g. 5 of 10) — sessions_now defaults to every session (today's
    # full-collection behavior) when the caller doesn't specify it.
    sessions_now = total_sessions
    is_partial_sessions = False
    if payload.payment_mode in PART_SESSION_MODES and payload.sessions_now is not None:
        sessions_now = payload.sessions_now
        if total_sessions and (sessions_now <= 0 or sessions_now > total_sessions):
            raise HTTPException(status_code=400, detail="Sessions Covered Now must be between 1 and the package's total sessions")
        is_partial_sessions = total_sessions > 0 and sessions_now < total_sessions

    computed_amount = round(sessions_now * per_session_rate, 2) if total_sessions else original_price

    # What today's sessions cost is what the discount comes off and what a cheque is
    # written for; the whole package is what a balance is measured against. Everything
    # else about the money -- the modes, the splits, the confirmation, the cash count, the
    # schedule -- is the standard every fee is collected by.
    taken = await settle_standard_payment(
        lead=lead,
        payload=payload,
        fee_label="Treatment Fee",
        list_price=computed_amount,
        total_price=original_price,
        over_label="above assigned fee",
        existing_installments=(lead.get("treatment_fee_payment_details") or {}).get("installments"),
    )
    amount = taken["amount"]
    transaction_id = taken["transaction_id"]
    payment_details = taken["details"]
    settled = taken["settled"]

    # The balance the helper worked out, annotated with the sessions each half covers —
    # the one thing a treatment schedule carries that the other fees' don't, since theirs
    # are a single price paid once.
    balance_suffix = taken["balance_suffix"]
    if payload.payment_mode in PART_SESSION_MODES and settled["installments"]:
        remaining_sessions = total_sessions - sessions_now
        paid_now, owing = settled["installments"]
        payment_details["installments"] = [
            {**paid_now, "sessions": sessions_now},
            {**owing, "sessions": remaining_sessions},
        ]
        covered = f" · covers {sessions_now} of {total_sessions} sessions" if is_partial_sessions else ""
        sessions_label = f" ({remaining_sessions} sessions)" if remaining_sessions > 0 else ""
        balance_suffix = f"{covered} · balance Rs.{settled['balance']}{sessions_label} due {payload.balance_due_date}"

    is_update = lead.get("treatment_fee_paid") is not None
    # Rests at 'Fee Collected' on first collection — Physio Assign only happens via
    # the separate assign-consultation-physio action. If this is just a payment-mode
    # correction on a lead that's already past that (physio already assigned), leave
    # its stage where it is rather than moving it backward.
    stage_after = "Physio Assign" if lead.get("consultation_stage") == "Physio Assign" else "Fee Collected"
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "treatment_fee_paid": amount,
        "treatment_fee_payment_mode": taken["mode"],
        "treatment_fee_payment_details": payment_details or None,
        "consultation_stage": stage_after,
        "updated_at": _now(),
    }})
    # Partial Payment schedules nothing as collected yet — the log should say a
    # schedule was created, not that money came in, since collecting any one
    # installment (including one due today) is now its own separate action.
    if taken["is_schedule"]:
        details = f"{'Updated' if is_update else 'Created'} Payment Schedule for session package '{lead.get('session_package_name')}' ({lead.get('session_package_sessions')} sessions) · Rs.{amount} across {len(payment_details['installments'])} installments{taken['detail_suffix']}"
    else:
        details = f"{'Updated' if is_update else 'Collected'} Treatment Fee for session package '{lead.get('session_package_name')}' ({lead.get('session_package_sessions')} sessions) · Rs.{amount} via {taken['mode']}{taken['detail_suffix']}{taken['discount_suffix']}{balance_suffix} · Txn {transaction_id}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "transaction_id": transaction_id,
        "lead_id": lead_id,
        "action": "treatment_fee_collected",
        "details": details,
        "original_amount": computed_amount if taken["settles_now"] else None,
        "collected_amount": amount if taken["settles_now"] else None,
        "discount_amount": taken["discount"] if taken["discount"] != 0 else None,
        "discount_reason": taken["discount_reason"],
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Payment collected", "transaction_id": transaction_id, "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/mark-consultation-completed", response_model=dict)
async def mark_consultation_completed(lead_id: str, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Branch Admin closes out a 'Consultation Only' patient once the Consultation
    Fee has been collected — no Treatment Fee is ever collected on this path."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("consultation_decision") != "consultation_only":
        raise HTTPException(status_code=400, detail="Only a 'Consultation Only' patient can be marked completed here")
    # Same test, same reason as collect_treatment_fee above: the fee itself, not the stage
    # a Head Physio's re-saved decision may have undone. A Consultation Only patient who
    # had paid and then had their decision edited could not be closed out at all.
    if lead.get("package_paid") is None:
        raise HTTPException(status_code=400, detail="Consultation Fee must be collected before marking the consultation completed")

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "consultation_stage": "Consultation Completed",
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_completed",
        "details": "Consultation marked completed (Consultation Only — no treatment sessions)",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Consultation completed", "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/physio-diagnosis", response_model=V3LeadOut)
async def save_physio_diagnosis(lead_id: str, payload: V3PhysioDiagnosisInput, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev"))):
    """Head Physio's own diagnosis report — separate from Pre-Sales' basic
    `diagnosis` field, which stays read-only reference material here."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("physio_diagnosis_locked"):
        raise HTTPException(status_code=400, detail="Diagnosis report is locked — unlock it first to edit")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "physio_diagnosis_report": payload.report,
        "physio_diagnosis_locked": payload.locked,
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "physio_diagnosis_saved",
        "details": f"Diagnosis report {'saved & locked' if payload.locked else 'saved'} by {user.full_name}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.put("/leads/{lead_id}/physio-diagnosis/unlock", response_model=V3LeadOut)
async def unlock_physio_diagnosis(lead_id: str, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev"))):
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"physio_diagnosis_locked": False, "updated_at": _now()}})
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not updated:
        raise HTTPException(status_code=404, detail="Lead not found")
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/treatment-summary", response_model=V3LeadOut)
async def save_treatment_summary(lead_id: str, payload: V3TreatmentSummaryInput, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev"))):
    """Head Physio's treatment plan summary — what treatment to give the patient."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # Money in against this plan closes it. The Treatment Fee is collected for the course
    # this summary describes, and the patient is handed a copy of that plan at Move to
    # Admin — a summary rewritten afterwards leaves the branch delivering one thing,
    # holding a receipt for another, and nothing on file saying which was agreed.
    #
    # `is not None` rather than a positive figure, and ahead of the lock check below: a
    # Partial Payment schedule writes the full price the moment it is agreed, its first
    # installment is money already taken, and "unlock it first" is the wrong instruction
    # for a box that unlock can no longer open either (see unlock_treatment_summary).
    if lead.get("treatment_fee_paid") is not None:
        raise HTTPException(status_code=403, detail=TREATMENT_FEE_COLLECTED_DETAIL)
    if lead.get("treatment_summary_locked"):
        raise HTTPException(status_code=400, detail="Treatment summary is locked — unlock it first to edit")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "treatment_summary": payload.summary,
        "treatment_summary_locked": payload.locked,
        "updated_at": _now(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "treatment_summary_saved",
        "details": f"Treatment summary {'saved & locked' if payload.locked else 'saved'} by {user.full_name}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": _now(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.put("/leads/{lead_id}/treatment-summary/unlock", response_model=V3LeadOut)
async def unlock_treatment_summary(lead_id: str, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev"))):
    # The unlock is the way back into the box, so it shuts for the same reason the save
    # above does — see the note there. Refused at the door rather than by letting the
    # unlock succeed and the next save fail: a box that opens and then will not keep what
    # is typed into it is a worse account of what happened than being told it is closed.
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("treatment_fee_paid") is not None:
        raise HTTPException(status_code=403, detail=TREATMENT_FEE_COLLECTED_DETAIL)
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"treatment_summary_locked": False, "updated_at": _now()}})
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)
