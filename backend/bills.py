"""What one payment's bill says: the services, what was owed, what came in, what is left.

Pure -- no database. routers/v3_bills.py finds the records behind a transaction id and hands
them here, so every screen that opens a bill (the collect popups, the fee cards, Accountant
Manage) prints the same one, and the sums can be tested without a server.

Every part keeps one rule: the items add up to already paid + paid now + balance + discount.
Nothing on a bill is typed or inferred twice, so a bill cannot disagree with itself.

A bill reprinted later says what it said on the day. Payments and discounts that came after
it are put back as balance, rather than printing today's figures under an old date.
"""

import re
from typing import Dict, List, Optional

MODE_LABELS = {
    "cash": "Cash", "upi": "UPI", "card": "Card", "account_transfer": "Account Transfer",
    "cheque": "Cheque", "pre_book": "Pre Book", "split": "Split",
}

# What each fee's line reads as, and the lead fields that describe what was sold.
FEE_ITEMS = {
    "consultation": {"service": "Consultation", "price": "package_price", "name": "package_name", "mode": "package_mode"},
    "treatment": {
        "service": "Physiotherapy Session", "price": "session_package_price", "name": "session_package_name",
        "mode": "session_package_mode", "sessions": "session_package_sessions",
    },
    "rehab": {
        "service": "Rehab", "price": "rehab_package_price", "name": "rehab_package_name",
        "mode": "rehab_package_mode", "sessions": "rehab_package_sessions",
    },
    "diet": {"service": "Diet Consultation", "price": "diet_package_price", "name": "diet_package_name", "mode": "diet_package_mode"},
    "diet_chart": {"service": "Diet Chart", "price": "diet_chart_package_price", "name": "diet_chart_package_name", "mode": "diet_chart_package_mode"},
    "extra": {"service": "Extra Amount"},
}

# The old client book's revenue lines, as a bill names them.
CATEGORY_SERVICES = {
    "session": "Physiotherapy Session", "consultation": "Consultation", "rehab": "Rehab", "diet": "Diet",
}

REGISTRATION_SERVICES = {"zumba": "Zumba Membership", "fitness": "Fitness Membership"}

# How far two figures may sit apart and still be the same money.
NEAR = 0.01


def money(value) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def near(a, b) -> bool:
    return abs(money(a) - money(b)) <= NEAR


def join(*parts) -> str:
    return " · ".join(str(p).strip() for p in parts if str(p or "").strip())


def visit_mode(value) -> str:
    v = str(value or "").strip().lower()
    return {"online": "Online", "offline": "Offline"}.get(v, "")


def plural(n, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def item(service: str, detail: str, qty, price, amount) -> dict:
    return {"service": service, "detail": detail, "qty": qty, "price": money(price), "amount": money(amount)}


def counted(service: str, detail: str, qty, amount, unit: str = "") -> dict:
    """A line as qty x rate where the rate divides exactly, and as one lot where it does
    not -- Rs.1,000 over 3 sessions has no rate that multiplies back to it."""
    try:
        n = int(qty or 0)
    except (TypeError, ValueError):
        n = 0
    amount = money(amount)
    if n > 1:
        rate = money(amount / n)
        if money(rate * n) == amount:
            return item(service, detail, n, rate, amount)
        if unit:
            detail = join(detail, plural(n, unit))
    return item(service, detail, 1, amount, amount)


# ---- how the money arrived ---------------------------------------------------------------

def reference(mode: str, fields: dict) -> str:
    """Whatever identifies this payment with the bank."""
    f = fields or {}

    def v(key):
        return str(f.get(key) or "").strip()

    if mode == "upi":
        return join(v("upi_transaction_id") or v("reference"), f"UTR {v('upi_utr')}" if v("upi_utr") else "")
    if mode == "card":
        # Cards taken before the terminal's id was asked for kept the account's last four.
        last4 = re.sub(r"\D", "", v("account_last4"))[-4:]
        return v("card_transaction_id") or v("reference") or (f"Card ****{last4}" if last4 else "")
    if mode == "account_transfer":
        return join(v("transfer_reference") or v("reference"), v("bank_name"))
    if mode == "cheque":
        return join(f"No. {v('cheque_number')}" if v("cheque_number") else "", v("bank_name") or v("cheque_bank"))
    return v("reference")


def notes(denominations) -> str:
    """"2 x 500 + 1 x 200" -- what a cash payment was counted out in, when it was."""
    out = []
    for note, count in sorted(((denominations or {}).items()), key=lambda kv: -int(kv[0]) if str(kv[0]).isdigit() else 0):
        try:
            n = int(count)
        except (TypeError, ValueError):
            continue
        if n > 0:
            out.append(f"{n} x {note}")
    return " + ".join(out)


def tender(mode: str, amount, ref: str = "", counted_notes: str = "") -> dict:
    mode = str(mode or "").strip().lower()
    return {
        "mode": mode, "label": MODE_LABELS.get(mode) or mode.replace("_", " ").title() or "—",
        "amount": money(amount), "reference": ref or "", "notes": counted_notes or "",
    }


def tenders(mode: str, fields: dict, amount) -> List[dict]:
    """One line per way the money came in. A split names its parts: "Split" on its own is
    the one word a patient checking what they handed over cannot check."""
    lines = (fields or {}).get("payment_lines") or (fields or {}).get("lines") or []
    if lines:
        return [
            tender(ln.get("mode"), ln.get("amount"), str(ln.get("reference") or "").strip(), notes(ln.get("denominations")))
            for ln in lines
        ]
    mode = str(mode or "").strip().lower()
    return [tender(mode, amount, reference(mode, fields), notes((fields or {}).get("denominations")) if mode == "cash" else "")]


# ---- one part of a bill ------------------------------------------------------------------

def part(items, now, already=0, discount=0, balance: Optional[float] = 0, due="", tenders=None, installments=None) -> dict:
    """`balance` None means the record does not say what was left -- printed as nothing,
    never as a settled bill."""
    return {
        "items": items, "now": money(now), "already": money(already), "discount": money(discount),
        "balance": None if balance is None else money(balance), "due": due or "",
        "tenders": tenders or [], "installments": installments or [],
    }


def combine(parts: List[dict]) -> dict:
    """Parts paid together (a Pre Book's consultation and its advance) as one bill."""
    items = [i for p in parts for i in p["items"]]
    subtotal = money(sum(i["amount"] for i in items))
    discount = money(sum(p["discount"] for p in parts))
    now = money(sum(p["now"] for p in parts))
    already = money(sum(p["already"] for p in parts))
    known = [p["balance"] for p in parts if p["balance"] is not None]
    balance = money(sum(known)) if known else None
    if any(p["balance"] is None for p in parts) and not balance:
        balance = None
    dues = sorted(p["due"] for p in parts if p["due"] and (p["balance"] or 0) > NEAR)
    merged: Dict[tuple, dict] = {}
    for p in parts:
        for t in p["tenders"]:
            key = (t["mode"], t["reference"], t["notes"])
            if key in merged:
                merged[key]["amount"] = money(merged[key]["amount"] + t["amount"])
            else:
                merged[key] = dict(t)
    status = "" if balance is None else ("part_paid" if balance > NEAR else "paid")
    return {
        "items": items, "subtotal": subtotal, "discount": discount, "total": money(subtotal - discount),
        "already_paid": already, "paid_now": now, "balance": balance, "due_date": dues[0] if dues else "",
        "status": status, "payments": list(merged.values()),
        "installments": [i for p in parts for i in p["installments"]],
    }


# ---- a patient's fee ---------------------------------------------------------------------

def fee_items(fee: str, lead: dict, billed: float, note: str = "", paying: str = "") -> List[dict]:
    """The lines for a fee billed at `billed`. `paying` says what this payment covers."""
    cfg = FEE_ITEMS.get(fee) or {"service": "Payment"}
    service = cfg["service"]
    if lead.get("visit_type") == "home" and fee in ("consultation", "treatment"):
        service += " (House Visit)"
    name = lead.get(cfg.get("name", "")) or ""
    mode = visit_mode(lead.get(cfg.get("mode", "")))
    price = money(lead.get(cfg.get("price", "")))
    sessions = lead.get(cfg.get("sessions", "")) or 0
    if fee == "extra":
        return [item(service, join(note, paying), 1, billed, billed)]

    # More was taken than the fee is priced at: said as its own line, so the price the
    # patient was quoted is still on the bill.
    extra = money(billed - price) if price > 0 and billed > price + NEAR else 0
    base = money(billed - extra)
    out: List[dict] = []
    plan = [r for r in (lead.get("session_mode_plan") or []) if money(r.get("amount")) > 0] if fee == "treatment" else []
    if len(plan) > 1 and near(sum(money(r.get("amount")) for r in plan), base):
        # Mark Online split the course into runs at different rates: each prints its own.
        for n, r in enumerate(plan):
            detail = join(name, visit_mode(r.get("mode")), paying if n == 0 else "")
            out.append(counted(service, detail, r.get("days"), r.get("amount"), "session"))
    elif fee == "treatment":
        # A rate only where the bill is the package's own price; a bill for anything else
        # has no honest per-session figure.
        full = price <= 0 or near(base, price)
        detail = join(name, mode, paying)
        out.append(
            counted(service, detail, sessions, base, "session") if full
            else item(service, join(detail, plural(int(sessions), "session") if sessions else ""), 1, base, base)
        )
    else:
        out.append(item(service, join(name, plural(int(sessions), "session") if sessions else "", mode, paying), 1, base, base))
    if extra > 0:
        out.append(item("Additional amount", "", 1, extra, extra))
    return out


def _row_then(row: dict) -> float:
    """What a schedule row asked for before it was collected."""
    if not row.get("paid"):
        return money(row.get("amount"))
    if row.get("scheduled_amount") is not None:
        return money(row["scheduled_amount"])
    return money(money(row.get("amount")) + money(row.get("discount_amount")))


def _same_charge(a: dict, b: dict) -> bool:
    return (a.get("note") or "") == (b.get("note") or "") and (a.get("added_on") or "") == (b.get("added_on") or "")


def fee_part(fee: str, details: Optional[dict], lead: dict, act: dict, amount: float, mode: str, taken_at: Dict[str, str]) -> Optional[dict]:
    """One collection of a fee, or None when the fee no longer carries this transaction.

    `details` is the fee's payment_details, `act` the activity line the money was logged on
    (its amount and mode parsed by the caller), `taken_at` the moment each of the schedule's
    other transactions was taken.
    """
    details = details or {}
    rows = [r for r in (details.get("installments") or []) if isinstance(r, dict)]
    txn, at = act.get("transaction_id") or "", act.get("created_at") or ""
    own = next((i for i, r in enumerate(rows) if r.get("paid") and r.get("transaction_id") == txn), None)
    opening = own is None and bool(txn) and details.get("transaction_id") == txn
    if own is None and not opening:
        return None

    # An Extra Amount's rows are separate charges on one schedule; a bill is for its own.
    group = [i for i, r in enumerate(rows) if own is None or fee != "extra" or _same_charge(r, rows[own])]

    def before(r: dict) -> bool:
        if not r.get("paid"):
            return False
        other = r.get("transaction_id")
        if not other:
            return True  # the opening payment, or money from Pre Book
        when = taken_at.get(other)
        return (when < at) if when else str(r.get("paid_on") or "") < at[:10]

    earlier, later = [], []
    for i in group:
        r = rows[i]
        if i == own or (opening and r.get("paid") and not r.get("transaction_id") and not r.get("pre_book")):
            continue
        (earlier if before(r) else later).append((i, r))

    # A corrected fee (its first payment re-entered) takes in what was paid before it, so
    # nothing is counted as already paid on top.
    already = 0 if opening else money(sum(money(r.get("amount")) for _, r in earlier))
    balance = money(sum(_row_then(r) for _, r in later))
    due = min((str(r.get("due_date") or "") for _, r in later if r.get("due_date")), default="")
    if fee == "extra":
        discount = money(rows[own].get("discount_amount")) if own is not None else 0
        discount = money(discount + sum(money(r.get("discount_amount")) for _, r in earlier))
    else:
        agreed_since = sum(money(r.get("discount_amount")) for _, r in later if r.get("paid"))
        discount = money(max(0, money(details.get("discount_amount")) - agreed_since))

    row = rows[own] if own is not None else {}
    # The row's own figure over the one read back off the activity line.
    now = money(row.get("amount")) if own is not None else money(amount)
    sessions = row.get("sessions") if own is not None else next(
        (r.get("sessions") for r in rows if r.get("paid") and not r.get("transaction_id") and not r.get("pre_book")), None)
    number = 1 if opening else len(earlier) + 1
    paying = ""
    if already > 0 or balance > 0:
        total_sessions = lead.get("session_package_sessions") if fee == "treatment" else None
        covers = f"{sessions} of {plural(int(total_sessions), 'session')}" if sessions and total_sessions and int(sessions) < int(total_sessions) else ""
        paying = join(f"Payment {number}", covers)
    billed = money(already + now + balance + discount)
    plan = []
    if earlier or later:
        for i in group:
            r = rows[i]
            is_this = i == own or (opening and r.get("paid") and not r.get("transaction_id") and not r.get("pre_book"))
            is_earlier = any(i == j for j, _ in earlier)
            plan.append({
                "amount": money(r.get("amount")) if is_this or is_earlier else _row_then(r),
                "due_date": r.get("due_date") or "", "sessions": r.get("sessions") or None,
                "paid": is_this or is_earlier,
                "paid_on": (r.get("paid_on") or "") if is_this or is_earlier else "",
            })
    return part(
        fee_items(fee, lead, billed, note=row.get("note") or "", paying=paying),
        now, already, discount, balance, due,
        tenders(row.get("payment_mode") if own is not None and row.get("payment_mode") else mode, row if own is not None else details, now),
        plan,
    )


_BALANCE_RE = re.compile(r"balance Rs\.?\s*([\d.]+\d|\d)", re.IGNORECASE)
_DUE_RE = re.compile(r"\bdue (\d{4}-\d{2}-\d{2})")


def activity_part(label: str, act: dict, amount: float, pays: List[dict], balance_known: bool) -> dict:
    """A payment whose fee has moved on since -- re-collected, or never on a schedule. What
    the activity line itself says, and nothing more."""
    text = act.get("details") or ""
    discount = money(max(0, money(act.get("discount_amount"))))
    m = _BALANCE_RE.search(text)
    balance: Optional[float] = money(m.group(1)) if m else (0 if balance_known else None)
    due = _DUE_RE.search(text)
    billed = money(amount + discount + (balance or 0))
    return part([item(label, "", 1, billed, billed)], amount, 0, discount, balance, due.group(1) if due and m else "", pays)


# ---- Pre Book ----------------------------------------------------------------------------

def pre_book_consultation_part(rec: dict, visit_date: str = "") -> dict:
    paid, discount = money(rec.get("paid")), money(rec.get("discount"))
    price = max(money(rec.get("price")), money(paid + discount))
    balance = money(price - discount - paid)
    return part(
        [item("Consultation", join("Pre Book", rec.get("name"), visit_mode(rec.get("mode"))), 1, price, price)],
        paid, 0, discount, balance, visit_date, tenders(rec.get("payment_mode"), rec.get("payment_details"), paid),
    )


def pre_book_advance_part(rec: dict, label: str) -> dict:
    amount = money(rec.get("amount"))
    return part(
        [item("Advance", join("Pre Book", label, rec.get("note")), 1, amount, amount)],
        amount, tenders=tenders(rec.get("payment_mode"), rec.get("payment_details"), amount),
    )


# ---- the books with no patient lead behind them ------------------------------------------

def store_part(sale: dict) -> dict:
    amount = money(sale.get("amount"))
    qty = int(sale.get("qty") or 1)
    price = money(sale.get("unit_price"))
    line = (
        item(sale.get("item_name") or "Store item", "Fitsiomax Store", qty, price, amount) if near(price * qty, amount)
        else item(sale.get("item_name") or "Store item", join("Fitsiomax Store", f"Qty {qty}"), 1, amount, amount)
    )
    return part([line], amount, tenders=tenders(sale.get("payment_mode"), sale, amount))


def old_client_part(client: dict, pay: dict, history: List[dict], balance_after: Optional[float]) -> dict:
    now = money(pay.get("amount"))
    service = CATEGORY_SERVICES.get(client.get("category") or "session", "Physiotherapy Session")
    number = pay.get("instalment_number")
    detail = join(client.get("package"), visit_mode(client.get("mode")), f"Instalment {number}" if number else "")
    pays = tenders(pay.get("payment_mode"), pay, now)
    if balance_after is None:
        # The old course's total was never given, so there is nothing to bill against.
        return part([item(service, detail, 1, now, now)], now, balance=None, tenders=pays)
    before = money(client.get("paid_before")) + sum(
        money(p.get("amount")) for p in history
        if p.get("id") != pay.get("id") and (p.get("created_at") or "") < (pay.get("created_at") or "")
    )
    billed = money(before + now + balance_after)
    due = client.get("next_due_date") or "" if balance_after > NEAR else ""
    return part([item(service, detail, 1, billed, billed)], now, before, 0, balance_after, due, pays)


def registration_part(bill: dict) -> dict:
    """A Zumba or Fitness payment, off what was written down when it was taken -- the
    registration itself keeps only running totals."""
    service = REGISTRATION_SERVICES.get(bill.get("source"), "Membership")
    now, fee, already = money(bill.get("amount")), money(bill.get("fee_amount")), money(bill.get("already_paid"))
    owed_before = money(bill.get("previous_balance"))
    balance = money(max(0, fee + owed_before - already - now))
    sessions = bill.get("package_sessions")
    detail = join(bill.get("package_name"), plural(int(sessions), "session") if sessions else "", "Renewal" if bill.get("renewal") else "")
    items = [item(service, detail, 1, fee, fee)]
    if owed_before > 0:
        items.append(item("Previous balance", "", 1, owed_before, owed_before))
    billed = money(sum(i["amount"] for i in items))
    if not near(billed, already + now + balance):
        items = [item(service, detail, 1, money(already + now + balance), money(already + now + balance))]
    return part(items, now, already, 0, balance, "", tenders("", {"lines": bill.get("lines")}, now) if bill.get("lines") else [])
