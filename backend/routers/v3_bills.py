"""One payment's bill, by its transaction id.

Every screen that opens a bill asks here -- the collect popups, a patient's fee cards, Pre
Book, Accountant Manage, the Store, Zumba and Fitness -- so the patient is handed the same
paper whichever one it was. The sums are bills.py's; this finds the records behind the id.
"""

import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

import bills
import old_clients
import staff_sign
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


async def _open(transaction_id: str, user: V3UserOut):
    """(the bill book's row, the payments on the bill, the one asked for), for a login that
    may read it. 404 for one that may not, as for a payment that is not there."""
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
    return bill, found, asked


@router.get("/finance/bills/{transaction_id}")
async def get_bill(transaction_id: str, user: V3UserOut = Depends(require_bill_reader)):
    """The bill a payment is given, and the same bill whenever it is opened again."""
    bill, found, asked = await _open(transaction_id, user)
    branch = await v3_col("branches").find_one(
        {"id": asked["branch_id"]}, {"_id": 0, "branch_name": 1, "address": 1, "phone": 1},
    ) if asked["branch_id"] else None
    branch = branch or {}
    return {
        "bill_no": bill.get("bill_no") or "",
        "transaction_ids": [i for i, _ in found],
        "date": asked["at"],
        "collected_by": asked["by"],
        # Their sign (Admin Setting > Digital Sign), for the Authorised Signature line.
        "signature": await staff_sign.collector_sign(asked["by"], asked["branch_id"], asked["at"]),
        "patient": asked["patient"],
        "branch": {
            "name": branch.get("branch_name") or "", "address": branch.get("address") or "", "phone": branch.get("phone") or "",
        },
        **bills.combine([f["part"] for _, f in found]),
    }


# ---- the PDF a bill is sent with --------------------------------------------------------
#
# A desk's WhatsApp opens the patient's chat with the message typed, and wa.me carries text
# only, so the PDF goes as a link in it -- what the appointment confirmation does
# (v3_branch_admin's APPT_PDF_DIR). The browser draws the PDF and leaves it here.
#
# A bill says what a person paid and for what treatment, so its link is held tighter: the
# token is random and belongs to nothing else, it stops working after BILL_LINK_DAYS or when
# the payment is undone, nothing may cache or index it, and the file is then deleted.
BILL_PDF_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "bill_pdfs")
BILL_PDF_MAX_BYTES = 5 * 1024 * 1024
BILL_LINK_DAYS = 30
_LINK_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


def _stamp(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat(timespec="seconds")


def _pdf_path(token: str) -> Optional[str]:
    return os.path.join(BILL_PDF_DIR, f"{token}.pdf") if _LINK_RE.match(token or "") else None


async def _drop_old_links() -> None:
    """Links past their day, and the files nobody has sent again since."""
    await v3_col("bill_links").delete_many({"expires_at": {"$lte": _stamp(datetime.now(timezone.utc))}})
    if not os.path.isdir(BILL_PDF_DIR):
        return
    oldest = time.time() - (BILL_LINK_DAYS + 1) * 86400
    for name in os.listdir(BILL_PDF_DIR):
        path = os.path.join(BILL_PDF_DIR, name)
        try:
            if os.path.getmtime(path) < oldest:
                os.remove(path)
        except OSError:
            continue


@router.post("/finance/bills/{transaction_id}/pdf")
async def share_bill_pdf(transaction_id: str, file: UploadFile = File(...), user: V3UserOut = Depends(require_bill_reader)):
    """Keep this bill's PDF behind a link, and say what it is. Sent again, the link is the
    same one with its days started over."""
    _, found, _ = await _open(transaction_id, user)
    data = await file.read(BILL_PDF_MAX_BYTES + 1)
    if len(data) > BILL_PDF_MAX_BYTES:
        raise HTTPException(status_code=413, detail="The PDF is too large")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="That is not a PDF")

    await _drop_old_links()
    # The bill's first transaction, so both halves of a Pre Book share one link.
    first = found[0][0]
    link = await v3_col("bill_links").find_one({"transaction_id": first}, {"_id": 0, "token": 1})
    token = link["token"] if link else secrets.token_urlsafe(16)
    path = _pdf_path(token)
    os.makedirs(BILL_PDF_DIR, exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)

    now = datetime.now(timezone.utc)
    expires = _stamp(now + timedelta(days=BILL_LINK_DAYS))
    await v3_col("bill_links").update_one(
        {"token": token},
        {"$set": {"token": token, "transaction_id": first, "expires_at": expires, "sent_at": _stamp(now), "sent_by": user.full_name}},
        upsert=True,
    )
    return {"token": token, "expires_at": expires}


def _link_gone() -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<meta name=robots content=noindex><title>FITSIO_MAX</title>"
        "<p style='font:16px/1.5 Arial,sans-serif;margin:15vh auto;max-width:26rem;padding:0 1.5rem;text-align:center'>"
        "This bill link is no longer available. Please ask your branch to send the bill again.</p>",
        status_code=410, headers={"Cache-Control": "no-store"},
    )


@router.get("/public/bill/{token}")
async def public_bill_pdf(token: str):
    """The bill's PDF behind its link. Unauthenticated: the token is the key, and the file
    holds only the bill the patient was sent."""
    path = _pdf_path(token)
    link = await v3_col("bill_links").find_one({"token": token}, {"_id": 0}) if path else None
    if not link or link.get("expires_at", "") <= _stamp(datetime.now(timezone.utc)) or not os.path.isfile(path):
        return _link_gone()
    txn = link["transaction_id"]
    bill = await v3_col("payment_bills").find_one({"transaction_id": txn}, {"_id": 0}) or {}
    # An undone payment's bill is not one anybody should still be shown.
    if not await _find(txn, bill):
        return _link_gone()
    return FileResponse(
        path, media_type="application/pdf", filename=f"Bill-{bill.get('bill_no') or txn}.pdf",
        # inline, so a tap in WhatsApp opens the bill rather than only saving it.
        content_disposition_type="inline",
        headers={
            "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        },
    )
