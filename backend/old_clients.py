"""Old clients: people whose course began on the old Physio Tracker, before the OS, and who
are still paying it off at the branch an instalment at a time.

Their history was never brought across, so the OS has no lead, no package and no schedule
for them -- and with none of those there was no Collect button, no transaction id and no
receipt for the second and third instalments the desk was being handed. Accountant Manage >
Payment Record > Old Client Instalment is the way in for that money.

A payments-only record, on purpose. An old client is not a lead: putting one on the branch
as a lead would land them in Branch Leads, in this month's lead counts and in front of the
importers' duplicate-phone check, none of which a returning patient paying off an old course
belongs in. So two collections of their own, read by the finance figures and nothing else:

  old_clients          one per client per old course: who they are, what the course was for,
                       its total fee, and what the tracker says was paid on it before the OS
  old_client_payments  one per instalment taken on the OS, with its own transaction id,
                       reaching revenue, approvals, the drawer and the closing count exactly
                       as any collection does (see revenue_overview in routers/v3_finance.py)

The balance is never stored. It is the course's total, less what the tracker says was paid,
less every instalment written here -- worked out on read, so deleting a payment gives the
balance back with nothing else to undo.

Nothing here touches a database -- the same arrangement as past_data.py, so the reasoning
worth testing runs without Mongo.
"""
import re
from datetime import date
from typing import Dict, List

# What an old course can have been for, by the revenue line the money lands on (the keys
# are revenue_overview's sources) and the word the desk knows it by. The four the old
# Physio Tracker sold; Zumba, Fitness and the Store were never on it.
CATEGORIES = {
    "session": "Treatment",
    "rehab": "Rehab",
    "consultation": "Consultation",
    "diet": "Diet",
}

# The stamp a back-dated instalment is written under: noon in the clinic, so the day reads
# the same in UTC as in India and lands in the right bucket whichever clock reads it. The
# same hour past_data_live._stamp gives an Excel date.
NOON_IST = "T06:30:00+00:00"


class OldClientError(ValueError):
    """A field the desk has to correct before the instalment can be written."""


def clean_phone(value) -> str:
    """The last ten digits -- "+91 93636 60871" and "9363660871" are one number."""
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[-10:]


def money(value) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def clean_client(fields: dict) -> dict:
    """The client half of the form, checked and tidied. Raises OldClientError on the first
    thing wrong, in the order the form asks for them."""
    name = " ".join(str(fields.get("name") or "").split())
    if not name:
        raise OldClientError("Enter the client's name")
    phone = clean_phone(fields.get("phone"))
    if len(phone) != 10:
        raise OldClientError("Enter the client's 10-digit phone number")
    category = fields.get("category") or ""
    if category not in CATEGORIES:
        raise OldClientError("Pick what the old course was for")
    total_fee = money(fields.get("total_fee"))
    if total_fee <= 0:
        raise OldClientError("Enter the course's total fee from the old tracker")
    paid_before = money(fields.get("paid_before"))
    if paid_before < 0:
        raise OldClientError("Paid in the old tracker cannot be less than zero")
    if paid_before >= total_fee:
        raise OldClientError("The old tracker already shows this course as fully paid")
    try:
        instalments_before = int(fields.get("instalments_before") or 0)
    except (TypeError, ValueError):
        instalments_before = 0
    # Something was paid there, so at least one instalment was -- otherwise the first one
    # taken here would be numbered #1 on a course that already had money on it.
    if paid_before > 0 and instalments_before < 1:
        instalments_before = 1
    if instalments_before < 0:
        instalments_before = 0
    next_due = str(fields.get("next_due_date") or "").strip()
    if next_due:
        try:
            date.fromisoformat(next_due)
        except ValueError:
            raise OldClientError("Next due date must be YYYY-MM-DD")
    return {
        "name": name,
        "phone": phone,
        "old_patient_id": " ".join(str(fields.get("old_patient_id") or "").split()),
        "category": category,
        "package": " ".join(str(fields.get("package") or "").split()),
        "total_fee": total_fee,
        "paid_before": paid_before,
        "instalments_before": instalments_before,
        "next_due_date": next_due,
    }


def paid_on_os(payments: List[dict]) -> float:
    return round(sum(money(p.get("amount")) for p in payments), 2)


def balance(client: dict, payments: List[dict]) -> float:
    """What is still owed on the course: its total, less the tracker's figure, less every
    instalment taken here. Never below zero."""
    left = money(client.get("total_fee")) - money(client.get("paid_before")) - paid_on_os(payments)
    return max(round(left, 2), 0.0)


def next_instalment(client: dict, payments: List[dict]) -> int:
    """The number the next instalment is written under: the ones paid on the tracker, the
    ones paid here, and this one."""
    return int(client.get("instalments_before") or 0) + len(payments) + 1


def check_day(day: str, today: str) -> str:
    """The day an instalment was paid on. Today unless the desk picks otherwise, and never a
    day still to come -- money cannot be received tomorrow."""
    day = (day or "").strip() or today
    try:
        date.fromisoformat(day)
    except ValueError:
        raise OldClientError("Paid on must be a date, YYYY-MM-DD")
    if day > today:
        raise OldClientError("Paid on cannot be a future date")
    return day


def stamp_for(day: str, today: str, now: str) -> str:
    """The created_at an instalment is filed under. Today's carries the moment it was
    taken, like every other collection; an earlier day's carries noon on that day, so it
    lands in that day's revenue, drawer and closing count."""
    return now if day == today else f"{day}{NOON_IST}"


def details_line(amount: float, mode: str, number: int, client: dict, detail_suffix: str, transaction_id: str) -> str:
    """The payment as one human line, in the shape the fee collections write theirs: the
    amount and the mode first (the finance readers take the first "Rs." and the first
    "via"), then what it was for, then the reference _tender put together."""
    what = client.get("package") or CATEGORIES.get(client.get("category"), "course")
    return (
        f"Collected Rs.{f'{amount:.2f}'.rstrip('0').rstrip('.')} via {mode}"
        f" · Old client instalment #{number} for '{what}'"
        + (f" (old ID {client['old_patient_id']})" if client.get("old_patient_id") else "")
        + f"{detail_suffix} · Txn {transaction_id}"
    )


def owed_status(due: str, today: str) -> str:
    """The Outstanding Amount badge, on the same terms a lead's balance gets one."""
    if due and due < today:
        return "overdue"
    try:
        soon = date.fromordinal(date.fromisoformat(today).toordinal() + 3).isoformat()
    except ValueError:
        soon = today
    if due and due <= soon:
        return "due_soon"
    return "partial"


def matches(client: dict, q: str) -> bool:
    """Whether a search box's text finds this client: by name, by any run of the phone's
    digits, or by the old tracker's patient ID."""
    q = (q or "").strip().lower()
    if not q:
        return True
    digits = re.sub(r"\D", "", q)
    if digits and len(digits) >= 3 and digits in (client.get("phone") or ""):
        return True
    if q in (client.get("name") or "").lower():
        return True
    return bool(client.get("old_patient_id")) and q in client["old_patient_id"].lower()


def summary(client: dict, payments: List[dict], today: str, branch_name: str = "") -> dict:
    """One client as the form and Payment Schedule read them."""
    ordered = sorted(payments, key=lambda p: p.get("created_at") or "")
    owed = balance(client, ordered)
    return {
        "id": client.get("id"),
        "branch_id": client.get("branch_id"),
        "branch_name": branch_name,
        "name": client.get("name") or "",
        "phone": client.get("phone") or "",
        "old_patient_id": client.get("old_patient_id") or "",
        "category": client.get("category") or "",
        "category_label": CATEGORIES.get(client.get("category"), ""),
        "package": client.get("package") or "",
        "total_fee": money(client.get("total_fee")),
        "paid_before": money(client.get("paid_before")),
        "instalments_before": int(client.get("instalments_before") or 0),
        "paid_on_os": paid_on_os(ordered),
        "balance": owed,
        "next_instalment_number": next_instalment(client, ordered),
        "next_due_date": client.get("next_due_date") or "",
        "status": owed_status(client.get("next_due_date") or "", today) if owed > 0 else "paid",
        "payments": [
            {
                "id": p.get("id"),
                "transaction_id": p.get("transaction_id") or "",
                "instalment_number": p.get("instalment_number"),
                "amount": money(p.get("amount")),
                "payment_mode": p.get("payment_mode") or "",
                "paid_on": p.get("paid_on") or (p.get("created_at") or "")[:10],
            }
            for p in ordered
        ],
    }


def balances_after(client: dict, payments: List[dict]) -> Dict[str, float]:
    """Payment id -> what was still owed once that instalment was in, oldest first. What a
    receipt prints as Balance Due: reissued a month later, it has to say what it said on
    the day, not what the client owes now."""
    left = money(client.get("total_fee")) - money(client.get("paid_before"))
    out: Dict[str, float] = {}
    for p in sorted(payments, key=lambda p: p.get("created_at") or ""):
        left -= money(p.get("amount"))
        out[p.get("id")] = max(round(left, 2), 0.0)
    return out


def same_course(a: dict, b: dict) -> bool:
    """Two records for one client's one course: same phone, same line, same package."""
    return (
        a.get("phone") == b.get("phone")
        and a.get("category") == b.get("category")
        and (a.get("package") or "").lower() == (b.get("package") or "").lower()
    )
