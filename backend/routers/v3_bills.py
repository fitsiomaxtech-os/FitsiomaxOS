"""One payment's bill, by its transaction id.

Every screen that opens a bill asks here -- the collect popups, a patient's fee cards, Pre
Book, Accountant Manage, the Store, Zumba and Fitness -- so the patient is handed the same
paper whichever one it was. The sums are bills.py's; this finds the records behind the id.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

import bills
import old_clients
from database import v3_col
from deps import is_branch_admin_role, is_zumba_role, role_satisfies, v3_current_user
from schemas.v3 import V3UserOut
from routers.v3_finance import (
    FEE_SCHEDULES, PAYMENT_ACTION_LABELS, REVENUE_ACTIONS,
    _branch_at, _old_client_book, _parse_payment_mode, _parse_payment_reference,
    _parse_payment_split, _parse_rs_amount,
)
from routers.v3_pre_book import ADVANCE_ACTIONS, ADVANCE_FOR, CONSULTATION_ACTION

router = APIRouter(prefix="/api/v3", tags=["bills"])

# Who takes money and hands over the paper for it. Zumba's desk too, for its own class fees.
BILL_ROLES = ("branch_admin", "super_admin", "accountant", "business_dev")


async def require_bill_reader(user: V3UserOut = Depends(v3_current_user)) -> V3UserOut:
    if role_satisfies(user.role, BILL_ROLES) or is_zumba_role(user.role):
        return user
    raise HTTPException(status_code=403, detail="Not allowed")


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="This payment is no longer on record")


def _title(value) -> str:
    return str(value or "").strip().replace("_", " ").title()


def _activity_tenders(act: dict, amount: float) -> list:
    """How a payment came in, off its activity line alone."""
    pay = act.get("payment") or {}
    if pay.get("mode"):
        return bills.tenders(pay["mode"], pay, amount)
    text = act.get("details") or ""
    split = _parse_payment_split(text)
    if split:
        return [bills.tender(s["mode"], s["amount"]) for s in split]
    mode = _parse_payment_mode(text)
    return bills.tenders("" if mode == "unknown" else mode, _parse_payment_reference(text), amount)


def _pre_book_part(lead: dict, act: dict) -> Optional[dict]:
    rec = lead.get("pre_book") if isinstance(lead.get("pre_book"), dict) else {}
    txn = act.get("transaction_id")
    if act.get("action") == CONSULTATION_ACTION:
        consult = rec.get("consultation") or {}
        return bills.pre_book_consultation_part(consult, rec.get("date") or "") if consult.get("transaction_id") == txn else None
    if act.get("action") in ADVANCE_ACTIONS.values():
        advance = rec.get("advance") or {}
        return bills.pre_book_advance_part(advance, ADVANCE_FOR.get(advance.get("for"), "")) if advance.get("transaction_id") == txn else None
    return None


async def _lead_part(act: dict, lead: dict) -> dict:
    action, text = act.get("action") or "", act.get("details") or ""
    amount = act.get("collected_amount")
    amount = bills.money(amount) if amount is not None else bills.money(_parse_rs_amount(text))
    pays = _activity_tenders(act, amount)

    found = _pre_book_part(lead, act)
    if found:
        return found

    fee = next((key for key, cfg in FEE_SCHEDULES.items() if cfg["action"] == action), None)
    # A Past Data balance is logged under a fee's action but is not on that fee's schedule.
    if fee and not act.get("past_allocations"):
        cfg = FEE_SCHEDULES[fee]
        details = lead.get(cfg["details"]) or {}
        others = [r["transaction_id"] for r in details.get("installments") or [] if isinstance(r, dict) and r.get("transaction_id")]
        taken_at = {}
        if others:
            rows = await v3_col("lead_activity").find(
                {"lead_id": lead.get("id"), "transaction_id": {"$in": others}},
                {"_id": 0, "transaction_id": 1, "created_at": 1},
            ).to_list(500)
            taken_at = {row["transaction_id"]: row.get("created_at") or "" for row in rows}
        mode = _parse_payment_mode(text)
        if mode in ("", "unknown"):
            mode = lead.get(cfg["mode"]) or ""
        found = bills.fee_part(fee, details, lead, act, amount, mode, taken_at)
        if found:
            return found
        # A fee's own collection writes its balance on the line when it leaves one; an
        # installment's line never does, so there nothing is known.
        return bills.activity_part(bills.FEE_ITEMS[fee]["service"], act, amount, pays, "Installment" not in text)

    label = PAYMENT_ACTION_LABELS.get(action, "Payment")
    return bills.activity_part(label, act, amount, pays, action in ("consultation_paid", "package_sold", "fee_collected"))


async def _find(transaction_id: str, bill: dict) -> Optional[dict]:
    """The payment behind a transaction id, whichever book it is in, or None."""
    act = await v3_col("lead_activity").find_one(
        {"transaction_id": transaction_id, "action": {"$in": list({*REVENUE_ACTIONS, *PAYMENT_ACTION_LABELS})}}, {"_id": 0},
    )
    if act:
        lead = await v3_col("leads").find_one({"id": act.get("lead_id")}, {"_id": 0})
        if not lead:
            return None
        return {
            "part": await _lead_part(act, lead),
            "patient": {
                "name": lead.get("name") or "", "number": lead.get("patient_number") or "",
                "age": lead.get("age"), "sex": _title(lead.get("gender")), "phone": lead.get("phone") or "",
            },
            "at": act.get("created_at") or "", "by": act.get("created_by") or "",
            "branch_id": bill.get("branch_id") or _branch_at(lead, act.get("created_at") or ""),
            "branch_now": lead.get("branch_id") or "", "book": "lead",
        }

    sale = await v3_col("inventory_movements").find_one({"transaction_id": transaction_id, "kind": "sale"}, {"_id": 0})
    if sale:
        return {
            "part": bills.store_part(sale),
            "patient": {"name": (sale.get("customer_name") or "").strip() or "Counter sale", "number": "", "age": None, "sex": "", "phone": ""},
            "at": sale.get("created_at") or "", "by": sale.get("by_user_name") or "",
            "branch_id": sale.get("branch_id") or "", "branch_now": "", "book": "store",
        }

    pay = await v3_col("old_client_payments").find_one({"transaction_id": transaction_id}, {"_id": 0})
    if pay:
        client, history = (await _old_client_book([pay.get("old_client_id")])).get(pay.get("old_client_id")) or ({}, [pay])
        after = old_clients.balances_after(client, history).get(pay.get("id")) if client else None
        return {
            "part": bills.old_client_part(client, pay, history, after),
            "patient": {
                "name": old_clients.display_name(client) if client else "Old client",
                "number": client.get("old_patient_id") or "", "age": None, "sex": "", "phone": client.get("phone") or "",
            },
            "at": pay.get("created_at") or "", "by": pay.get("created_by") or "",
            "branch_id": pay.get("branch_id") or "", "branch_now": "", "book": "old_client",
        }

    if bill.get("registration_id") and not bill.get("void"):
        book = bill.get("source") or "zumba"
        reg = await v3_col(f"{book}_registrations").find_one({"id": bill["registration_id"]}, {"_id": 0})
        if reg:
            return {
                "part": bills.registration_part(bill),
                "patient": {
                    "name": reg.get("name") or "", "number": "", "age": reg.get("age"),
                    "sex": _title(reg.get("gender")), "phone": reg.get("phone") or "",
                },
                "at": bill.get("created_at") or "", "by": bill.get("collected_by") or "",
                "branch_id": bill.get("branch_id") or reg.get("branch_id") or "",
                "branch_now": reg.get("branch_id") or "", "book": book,
            }
    return None


def _may_read(user: V3UserOut, found: dict) -> bool:
    """A branch reads the bills it took and those of the patients now with it; the Zumba
    desk only its own classes'. Everyone else on the list works across branches."""
    if role_satisfies(user.role, BILL_ROLES) and not is_branch_admin_role(user.role):
        return True
    mine = bool(user.branch_id) and user.branch_id in (found["branch_id"], found["branch_now"])
    return mine and (is_branch_admin_role(user.role) or found["book"] == "zumba")


@router.get("/finance/bills/{transaction_id}")
async def get_bill(transaction_id: str, user: V3UserOut = Depends(require_bill_reader)):
    """The bill a payment is given, and the same bill whenever it is opened again."""
    bill = await v3_col("payment_bills").find_one({"transaction_id": transaction_id}, {"_id": 0}) or {}
    # The transactions on one bill, in the order they were taken. A payment from before the
    # bill book has no row and stands alone, without a Bill No.
    ids, by_id = [transaction_id], {transaction_id: bill}
    if bill.get("group"):
        rows = await v3_col("payment_bills").find({"group": bill["group"]}, {"_id": 0}).sort("created_at", 1).to_list(10)
        by_id.update({r["transaction_id"]: r for r in rows})
        ids = [r["transaction_id"] for r in rows] or ids

    found = []
    for i in ids:
        record = await _find(i, by_id.get(i) or {})
        if record:
            found.append((i, record))
    asked = next((f for i, f in found if i == transaction_id), None)
    if not asked or not _may_read(user, asked):
        raise _not_found()

    branch = await v3_col("branches").find_one(
        {"id": asked["branch_id"]}, {"_id": 0, "branch_name": 1, "address": 1, "phone": 1},
    ) if asked["branch_id"] else None
    branch = branch or {}
    return {
        "bill_no": bill.get("bill_no") or "",
        "transaction_ids": [i for i, _ in found],
        "date": asked["at"],
        "collected_by": asked["by"],
        "patient": asked["patient"],
        "branch": {
            "name": branch.get("branch_name") or "", "address": branch.get("address") or "", "phone": branch.get("phone") or "",
        },
        **bills.combine([f["part"] for _, f in found]),
    }
