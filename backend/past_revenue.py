"""A branch's monthly revenue sheet, read into the Past Data tables.

Besides the register (past_data.py), the branches kept a simpler book: one tab a month
("May 26", "June 26", ...), one row per payment taken -- the date, who paid, their mobile,
where they live, how they heard of the clinic (SOR), what the money was for, the amount and
how it was paid. No patient IDs, no courses, no installment plan. This reads that book into
the same three tables as the register, so the Past Data tab shows both kinds side by side:

- a client per person. The mobile number is the only thing on the sheet that says two rows
  are one person, so two rows are one client when their numbers match and their names are
  one person's written two ways (_one_person: "Hakeem" and "Mohammed Hakeem", "Iqbal" and
  "Iqibal"). One number under two different names is two clients, flagged shared_phone --
  a family, as in the register. A row with no usable number is its own client: a name alone
  is too thin to join two rows on.
- a treatment per row -- what the payment was for (DESCRIPTION), with the sheet's suggested
  weeks, physio and remarks -- and under it
- one payment: the amount, the date, the mode.

What the sheet does not say is not made up. BALANCE and the NEXT PYMT DATE columns are
notes, not a ledger ("16800- 15th june-PAID", "no due", a balance beside a note that it was
since paid): they are kept word for word on the row, and nothing is counted as still owed.

Rows are found by header text, as in the register, so a tab with its columns in another
order -- another branch's copy of the sheet -- reads the same. A tab without a NAME, a
MOBILE and a PAYMENT column (a summary tab, a chart) is not a month and is passed over.
"""
import re
import uuid
from collections import Counter
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from past_data import (
    HEADER_SEARCH_ROWS, PastData, PastDataError, _add_totals, _flag, amount, day, match_key,
    payment_mode, phone, same_person, squash, text,
)

# Each field by the headers it goes by, squash()ed: "MOBILE NUMBER", "Mobile No." and
# "mobile" are one column. The first header in a row that matches wins.
COLUMNS = {
    "date": ("date",),
    "name": ("name", "patientname", "clientname"),
    "phone": ("mobilenumber", "mobile", "mobileno", "phone", "phonenumber", "contact", "contactnumber"),
    "location": ("location", "area"),
    "source": ("sor", "source", "referredby", "reference"),
    "suggested": ("suggestedweeks", "suggested", "weeks"),
    "description": ("description", "service", "treatment", "purpose"),
    "remarks": ("remarks", "remark", "notes"),
    "payment": ("payment", "amount", "amountpaid", "paid"),
    "balance": ("balance",),
    "mode": ("paymentmode", "mode", "modeofpayment"),
    "physio": ("physioname", "physio", "therapist"),
    "slot": ("slottiming", "slot", "timing"),
}
REQUIRED = ("name", "phone", "payment")
# "NEXT PYMT DATE-MAY", "Next Payment Date - June": however many a tab has.
NEXT_PAYMENT = re.compile(r"^next(pymt|payment|pay)")

NO_NAME = "(no name)"


def _header(rows) -> Optional[Tuple[int, Dict[str, Optional[int]], List[Tuple[int, str]]]]:
    """(the header's row index, field -> column, [(column, label) of each next-payment
    column]), or None when this tab is not a month of the revenue sheet."""
    for at, row in enumerate(rows[:HEADER_SEARCH_ROWS]):
        cells = [squash(c) for c in (row or ())]
        where = {key: next((i for i, c in enumerate(cells) if c in aliases), None) for key, aliases in COLUMNS.items()}
        if all(where[key] is not None for key in REQUIRED):
            nexts = [(i, text(row[i])) for i, c in enumerate(cells) if NEXT_PAYMENT.match(c)]
            return at, where, nexts
    return None


def read(workbook) -> PastData:
    """Every month tab of an open workbook, as PastData. Raises PastDataError when no tab
    reads as one -- the file is neither the register nor a revenue sheet."""
    tabs = []
    for sheet in workbook.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        found = _header(rows)
        if not found:
            continue
        at, where, nexts = found
        records = []
        for number, row in enumerate(rows[at + 1:], start=at + 2):
            row = row or ()

            def cell(i):
                return row[i] if i is not None and i < len(row) else None

            record = {key: cell(i) for key, i in where.items()}
            record["next"] = [(label, cell(i)) for i, label in nexts]
            record["_row"] = number
            records.append(record)
        tabs.append((sheet.title, records))
    if not tabs:
        raise PastDataError(
            "it is neither the register (no 'Patient Master' sheet) nor a revenue sheet "
            "(no tab with NAME, MOBILE NUMBER and PAYMENT columns)"
        )
    return build(tabs)


def _words(name: str) -> List[str]:
    return [w for w in re.split(r"[^a-z]+", name.lower()) if w]


def _one_person(a: str, b: str) -> bool:
    """Whether two names on one mobile number are one person's, written two ways.

    Three ways, and only these: the register's own rule (same_person -- equal, or one the
    start of the other); every word of the shorter name exactly a word of the longer
    ("Hakeem", "Mohammed Hakeem"); or a typo -- as many words, each word nearly the other's
    ("Syed Ibrahim", "Syed Ibhrahim"). Word by word, because two relatives share most of a
    name: "Shaik Hameed" and "Shaik Ahmed" are nine letters in eleven alike and two people.
    """
    if same_person(a, b):
        return True
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    short, longer = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    if len(short) < len(longer) and all(len(w) >= 3 and w in longer for w in short):
        return True
    return (
        len(wa) == len(wb)
        and all(x[0] == y[0] and SequenceMatcher(None, x, y).ratio() >= 0.8 for x, y in zip(wa, wb))
        and SequenceMatcher(None, "".join(wa), "".join(wb)).ratio() >= 0.88
    )


def _canonical(tabs) -> Dict[str, str]:
    """One spelling per service: "Cons", "cons" and "CONS" are one thing, written in
    whichever way the sheet wrote it most."""
    seen: Dict[str, Counter] = {}
    for _, records in tabs:
        for record in records:
            written = text(record.get("description"))
            if written:
                seen.setdefault(written.lower(), Counter())[written] += 1
    return {key: counts.most_common(1)[0][0] for key, counts in seen.items()}


def _weeks(value: Any) -> str:
    """SUGGESTED WEEKS as words: "6w" stays "6w", and a bare 6 reads "6 weeks" -- it is the
    column that says weeks, and "6" alone would read as sessions on the screen."""
    written = text(value)
    return f"{written} weeks" if re.fullmatch(r"\d+", written) else written


def _mode(value: Any) -> Tuple[str, bool]:
    """(the OS mode, whether the cell named two): "Cash & Gpay" was paid two ways, and is
    kept as written rather than filed under one of them."""
    words = text(value).lower()
    named = {m for part in re.split(r"&|\band\b|\+|/|,", words) if (m := payment_mode(part))}
    if len(named) > 1:
        return "", True
    return payment_mode(value), False


def build(tabs: List[Tuple[str, List[Dict[str, Any]]]], data: Optional[PastData] = None) -> PastData:
    """The month tabs' rows as clients, treatments and payments. Separate from read() so the
    grouping can be tested on plain dicts: each record is {field: cell, "next": [(label,
    cell)], "_row": n}."""
    data = data or PastData()
    data.layout = "revenue"
    data.tabs = [tab for tab, _ in tabs]
    services = _canonical(tabs)
    by_number: Dict[str, List[Dict[str, Any]]] = {}

    for tab, records in tabs:
        for record in records:
            where = f"{tab} · row {record['_row']}"
            name = text(record.get("name"))
            written_phone = text(record.get("phone"))
            paid = amount(record.get("payment"))
            if not name and not written_phone:
                # Below the last payment each tab has its month's total, and here and there a
                # note: an amount, or words, with nobody on them.
                other = [text(record.get(k)) for k in ("date", "description", "remarks") if text(record.get(k))]
                if paid is not None or other:
                    data.note("no_name_row", tab, where, " · ".join(([f"Rs.{paid}"] if paid is not None else []) + other))
                continue

            key = match_key(record.get("phone"))
            key = key if len(key) >= 8 else ""
            client = None
            if key:
                client = next(
                    (c for c in by_number.get(key, [])
                     if not name or c["name"] == NO_NAME or _one_person(c["name"], name)),
                    None,
                )
            if client is None:
                written, looked_up, flags = phone(record.get("phone"))
                client = {
                    "id": str(uuid.uuid4()),
                    # Where they first appear, so the row can be found in the sheet.
                    "excel_id": where,
                    "name": name or NO_NAME,
                    "gender": "",
                    "age": None,
                    "phone": written,
                    "phone_normalized": looked_up,
                    "email": "",
                    "registration_date": "",
                    "source": "",
                    "notes": "",
                    "locations": [],
                    "enquiries": [],
                    "flags": list(flags),
                    "shared_phone_with": [],
                }
                if "check_phone" in flags:
                    data.note("check_phone", tab, where, f"{client['name']}: {written or '(blank)'}")
                if key:
                    by_number.setdefault(key, []).append(client)
                data.clients.append(client)
            elif client["name"] == NO_NAME and name:
                client["name"] = name
            if not client["source"]:
                client["source"] = text(record.get("source"))
            location = text(record.get("location"))
            if location and location.lower() not in {l.lower() for l in client["locations"]}:
                client["locations"].append(location)

            description = text(record.get("description"))
            service = services.get(description.lower(), description)
            notes = [text(record.get("remarks"))]
            balance = record.get("balance")
            if text(balance) and amount(balance) != 0:
                notes.append(f"Balance: {text(balance)}")
            notes += [f"{label}: {text(value)}" for label, value in record["next"] if text(value)]
            if text(record.get("slot")):
                notes.append(f"Slot {text(record.get('slot'))}")
            when = day(record.get("date"))
            treatment = {
                "id": str(uuid.uuid4()),
                "excel_id": where,
                "client_id": client["id"],
                "client_excel_id": client["excel_id"],
                "name": name or client["name"],
                "service": service,
                "service_as_written": description,
                "mode": ("online" if "online" in service.lower() else "offline") if service else "",
                "physio": text(record.get("physio")),
                "start_date": when,
                "status": "",
                "recommended_sessions": None,
                "recommended_sessions_text": _weeks(record.get("suggested")),
                "fee": None,
                "notes": " · ".join(n for n in notes if n),
                "tab": tab,
                "flags": [],
            }
            data.treatments.append(treatment)

            mode, mixed = _mode(record.get("mode"))
            state = "paid" if paid else "unknown"
            payment = {
                "id": str(uuid.uuid4()),
                "excel_id": where,
                "client_id": client["id"],
                "treatment_id": treatment["id"],
                "treatment_excel_id": where,
                "client_excel_id": client["excel_id"],
                "name": name,
                "installment": None,
                "installments_total": None,
                "amount_due": None,
                "amount_paid": paid,
                "balance": amount(balance),
                "outstanding": 0,
                "due_date": "",
                "paid_date": when,
                "mode": mode,
                "mode_as_written": text(record.get("mode")),
                "state": state,
                "status_as_written": "",
                "notes": "",
                "tab": tab,
                "flags": [],
            }
            if state == "unknown":
                _flag(payment, "unknown_state")
                data.note("unknown_state", tab, where, f"{client['name']}: no amount")
            elif not mode and not mixed:
                _flag(payment, "check_mode")
                data.note("check_mode", tab, where, f"mode '{payment['mode_as_written'] or '(blank)'}'")
            if not when:
                _flag(payment, "no_date")
                data.note("no_date", tab, where, client["name"])
            data.payments.append(payment)

    for number, group in by_number.items():
        if len(group) < 2:
            continue
        for client in group:
            _flag(client, "shared_phone")
            client["shared_phone_with"] = [c["excel_id"] for c in group if c is not client]
        data.note("shared_phone", data.tabs[0] if data.tabs else "", ", ".join(c["excel_id"] for c in group),
                  f"{number}: " + " / ".join(c["name"] for c in group))

    first_seen: Dict[str, str] = {}
    for treatment in data.treatments:
        when = treatment["start_date"]
        if when and (treatment["client_id"] not in first_seen or when < first_seen[treatment["client_id"]]):
            first_seen[treatment["client_id"]] = when
    for client in data.clients:
        client["registration_date"] = first_seen.get(client["id"], "")
        if client["locations"]:
            client["notes"] = "Location: " + ", ".join(client["locations"])

    _add_totals(data)
    return data
