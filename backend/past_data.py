"""The clinic's register from before the OS, read into the Past Data tables.

Before the OS took over, the clinic kept its patients in one Excel workbook
(Max00data.xlsm): a Patient Master of people, an Enrollment Register of treatment courses,
a Payment Tracker of every installment, and a Prospect Pipeline of enquiries. This reads
that workbook and hands back rows for three collections of their own -- past_clients,
past_treatments and past_payments -- which tools/past_data_import.py writes.

Why their own collections and not `leads`. A lead is read by some forty org-wide queries --
the dashboards, the lead lists, the importers' duplicate-phone check -- and none of them
scope by branch. Nine hundred back-dated leads would have landed in every one of them: in
March's lead counts, in the Super Admin lead list, and in front of the duplicate check that
silently drops a returning patient's new enquiry. Kept apart, no existing query can see
this data, so importing it cannot move a single live figure.

What is done to the rows, and what is not. The workbook is imported as it was kept. Nothing
is merged, corrected or dropped on a guess: two rows that look like one person stay two
rows, and a payment written against the wrong patient stays where it was written. A doubtful
row is imported with a flag saying why, and the same finding goes into the report the tool
prints, so it can be fixed in the workbook and the import run again. The only things
skipped are rows nothing could be attached to -- a payment naming an enrollment that does
not exist has no course to sit under.

Nothing here touches a database -- the same arrangement as branch_routing.py, and for the
same reason: all of the reading, and all of the reasoning worth testing, runs without Mongo.
"""
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple


class PastDataError(ValueError):
    """The workbook is not the register this reads: a sheet or a column is missing."""


# ---------------------------------------------------------------------------- the sheets
#
# Each sheet by its tab name, and the columns read off it by their header text. Headers
# rather than column letters, so a column inserted into the workbook moves nothing; matched
# through squash() so "Total Fee (INR)" and "Total Fee(INR)" are one header.
#
# The first entry of each map is the sheet's own ID column. It is how the header row is
# found (the title sits above it, and the Payment Tracker has a row of status totals in
# between) and a row with nothing in it is not a record.

CLIENT_SHEET = "Patient Master"
TREATMENT_SHEET = "Enrollment Register"
PAYMENT_SHEET = "Payment Tracker"
ENQUIRY_SHEET = "Prospect Pipeline"

CLIENT_COLUMNS = {
    "excel_id": "Patient ID",
    "name": "Full Name",
    "age": "Age",
    "gender": "Gender",
    "phone": "Phone",
    "email": "Email",
    "enquiry_excel_id": "Prospect ID (if converted)",
    "registration_date": "Registration Date",
    "source": "Source / Referred By",
    "notes": "Notes",
}
TREATMENT_COLUMNS = {
    "excel_id": "Enrollment ID",
    "client_excel_id": "Patient ID",
    "name": "Patient Name",
    "service": "Service Type",
    "physio": "Assigned Physio",
    "start_date": "Enrollment Date",
    "status": "Status",
    "recommended_sessions": "Recommended Sessions",
    "fee": "Total Fee (INR)",
    "notes": "Treatment Notes",
}
PAYMENT_COLUMNS = {
    "excel_id": "Payment ID",
    "treatment_excel_id": "Enrollment ID",
    "client_excel_id": "Patient ID",
    "name": "Patient Name",
    "installment": "Installment #",
    "installments_total": "Total Installments",
    "amount_due": "Amount Due (INR)",
    "amount_paid": "Amount Paid (INR)",
    "balance": "Balance (INR)",
    "due_date": "Due Date",
    "paid_date": "Date Paid",
    "mode": "Payment Mode",
    "status": "Status",
    "notes": "Notes",
}
ENQUIRY_COLUMNS = {
    "excel_id": "Prospect ID",
    "name": "Full Name",
    "phone": "Phone",
    "enquiry_date": "Inquiry Date",
    "service_interest": "Service Interest",
    "referred_by": "Referred By",
    "status": "Status",
    "outcome": "Consultation Outcome",
    "package_recommended": "Package Recommended",
    "converted": "Converted? (Y/N)",
    "conversion_date": "Conversion date",
}

# Without these a sheet cannot be read at all. Every other column may be missing and reads
# as blank -- an older copy of the workbook without "Conversion date" is still the register.
REQUIRED = {
    CLIENT_SHEET: ("excel_id", "name", "phone"),
    TREATMENT_SHEET: ("excel_id", "client_excel_id"),
    PAYMENT_SHEET: ("excel_id", "treatment_excel_id"),
    ENQUIRY_SHEET: ("excel_id", "phone"),
}

# The columns that say a row is somebody even when its ID cell is empty. An ID is a formula
# in this workbook, so a row whose formula was never filled down still has a person in it
# -- and the rows below the last record carry formula residue (Days Since, a rank helper)
# that is not anyone. Only these are looked at, so the residue is not reported as a record.
IDENTITY_COLUMNS = {
    CLIENT_SHEET: ("name", "phone"),
    TREATMENT_SHEET: ("client_excel_id",),
    PAYMENT_SHEET: ("treatment_excel_id",),
    ENQUIRY_SHEET: ("name", "phone"),
}

HEADER_SEARCH_ROWS = 6


# ------------------------------------------------------------------------------ findings

# What each finding means, as the report prints it. A code is also the flag stored on the
# record it is about, so the Past Data screen can say the same thing beside the row.
FINDINGS = {
    "client_mismatch": "Payment written against a different patient than its enrollment",
    "shared_phone": "Several clients on one phone number (family, or one person twice)",
    "check_phone": "Phone is not a usable 10-digit mobile number",
    "name_differs": "Enrollment name differs from the Patient Master name",
    "no_service": "Enrollment has no Service Type",
    "check_mode": "Paid installment with no readable Payment Mode",
    "unknown_state": "Payment row with no status and no amount",
    "duplicate_id": "Same ID on two rows -- the second was NOT imported",
    "row_without_id": "Row has data but no ID -- NOT imported",
    "missing_client": "Enrollment names a Patient ID that is not in Patient Master -- NOT imported",
    "missing_treatment": "Payment names an Enrollment ID that is not in the register -- NOT imported",
    "enquiry_no_client": "Enquiry matches no client by phone -- NOT imported",
    "enquiry_ambiguous": "Enquiry matches several clients on one phone -- NOT imported",
    # A revenue sheet's own (see past_revenue.py).
    "no_date": "Payment row with no date",
    "no_name_row": "Row with no name or mobile (a total line, or a note) -- NOT imported",
    # The OS Data workbook's own (see past_os.py).
    "no_patient_id": "Leads row with no Patient ID -- its other rows are matched by phone and name",
    "unknown_stage": "Current Stage is not one of the OS stages -- placed at Leads",
    "no_client": "Row names nobody on the Leads tab -- NOT imported",
    "no_status": "Payment with an amount but no Paid / Pending Status, or no Paid Date or Due Date -- not counted as paid or owed",
    "no_payments": "Payments row with no Consultation Fee and no Instalment -- NOT imported",
    "payment_no_course": "Instalment with no course of its Service Type on the Physio tab -- kept under a course of its own",
    "session_no_course": "Session with no course of its Service Type on the Physio tab",
    "unknown_course": "Service Type is not Treatment, Rehab, Fitness, Diet or Zumba -- read as Treatment",
    "unknown_session_status": "Session Status is not Completed or Upcoming -- not put on the physio's board",
    "bad_session_date": "A date in Completed / Upcoming Dates that could not be read -- that session NOT imported",
    "bad_session_time": "Session Time that could not be read -- its sessions kept without a time",
    "repeated_session_date": "Same session date written twice in one Sessions row -- read once",
    "no_session_dates": "Sessions row with no Completed or Upcoming Dates -- NOT imported",
    "unknown_review_status": "Review Status is not Completed or Pending",
    "unknown_payment_for": "Payment For is not Consultation Fee or a service's fee (Treatment Fee, Rehab Fee...) -- filed under the course running on its date",
    "sample_row": "The template's sample row (a name starting \"Sample\") -- NOT imported",
    # A custom sheet's own (see past_custom.py).
    "merged_rows": "Same phone and name on more than one row -- read as one client",
}

# Findings where the row itself was left out, as opposed to imported with a flag.
NOT_IMPORTED = {
    "duplicate_id", "row_without_id", "missing_client", "missing_treatment",
    "enquiry_no_client", "enquiry_ambiguous", "no_name_row", "no_client", "sample_row",
    "no_session_dates", "bad_session_date", "no_payments",
}


@dataclass
class Finding:
    code: str
    sheet: str
    excel_id: str
    detail: str = ""


@dataclass
class PastData:
    clients: List[Dict[str, Any]] = field(default_factory=list)
    treatments: List[Dict[str, Any]] = field(default_factory=list)
    payments: List[Dict[str, Any]] = field(default_factory=list)
    enquiries_read: int = 0
    enquiries_attached: int = 0
    findings: List[Finding] = field(default_factory=list)
    # "register" -- the four-sheet workbook this module reads -- "revenue", a branch's
    # monthly revenue sheet (past_revenue.py), "os", the OS Data workbook laid out on the
    # OS's own fields (past_os.py), or "custom", any other list of people, read column by
    # column as picked on Auto Scan (past_custom.py); and, for the latter three, the tabs read.
    layout: str = "register"
    tabs: List[str] = field(default_factory=list)
    # The OS Data workbook's alone. What kinds of data it held -- "lead", "sessions" (its
    # courses, sessions and reviews), "revenue" (its payments) -- the rows read off each tab,
    # and the tabs it would have read that were not in the file.
    types: List[str] = field(default_factory=list)
    tab_rows: Dict[str, int] = field(default_factory=dict)
    tabs_missing: List[str] = field(default_factory=list)
    sessions_read: int = 0
    reviews_read: int = 0
    # Its Leads tab's Branch column, as written -> how many clients: one upload is one sheet
    # on one branch, so a file holding several says so before it is added.
    branches: Dict[str, int] = field(default_factory=dict)
    # The columns Auto Scan left on, tab by tab, when the sheet was read through them
    # (past_scan.read_picked): [{"tab", "columns": [{"header", "field"}]}]. Empty when the
    # whole workbook was read, as the terminal tool reads it.
    columns: List[Dict[str, Any]] = field(default_factory=list)

    def note(self, code: str, sheet: str, excel_id: str, detail: str = "") -> None:
        self.findings.append(Finding(code, sheet, excel_id, detail))


# ------------------------------------------------------------------------------ cleaners

def squash(value: Any) -> str:
    """A header as letters and digits alone, lowercased."""
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def text(value: Any) -> str:
    """A cell as trimmed text. Runs of spaces collapse to one, and a number typed into a text
    column reads the way it was typed ("9840250617", not "9840250617.0")."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Y" if value else "N"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, (datetime, date)):
        return day(value)
    return re.sub(r"\s+", " ", str(value)).strip()


DAY_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d %b %Y", "%d-%b-%y")


def day(value: Any) -> str:
    """A date cell as YYYY-MM-DD, or "" when it holds no date. The register's dates are real
    Excel dates, which is the case that matters; a date typed as text is read in the few
    shapes a person types one in, and anything else is left blank rather than guessed."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    written = text(value)
    for fmt in DAY_FORMATS:
        try:
            return datetime.strptime(written, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def amount(value: Any) -> Optional[float]:
    """A rupee cell as a number, or None when it is empty or not a figure. Whole rupees come
    back as int, so a stored fee reads 3000 rather than 3000.0."""
    if value is None or isinstance(value, bool) or isinstance(value, (datetime, date)):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        cleaned = re.sub(r"(?i)rs\.?|inr|[₹,\s]", "", str(value))
        if not re.fullmatch(r"-?\d+(\.\d+)?", cleaned):
            return None
        number = float(cleaned)
    return int(number) if number.is_integer() else round(number, 2)


def whole(value: Any) -> Optional[int]:
    number = amount(value)
    return int(number) if isinstance(number, (int, float)) and float(number).is_integer() else None


# The "-1" the desk types after a phone number to enter a second member of one family: the
# Patient Master would not take the same number twice, so the second person got "-1" on the
# end. It is the family's number all the same, and is looked up as that.
FAMILY_SUFFIX = re.compile(r"^(.*\d)\s*-\s*\d$")


def phone(value: Any) -> Tuple[str, str, List[str]]:
    """(the number as written, the ten digits it is looked up by, flags).

    The ten digits are only given for a number that is one: an Indian mobile, after a +91 or
    a leading 0 is taken off. A nine-digit number is missing a digit and an eleven-digit one
    has a digit too many, and neither can be repaired from here -- "the last ten" of a
    mistyped number is a stranger's number. So those keep their lookup key empty, the same
    rule the Client Portal applies to a sign-in phone.
    """
    written = text(value)
    if not written:
        return "", "", ["check_phone"]
    flags: List[str] = []
    body = written
    family = FAMILY_SUFFIX.match(written)
    if family and len(re.sub(r"\D", "", family.group(1))) >= 10:
        body = family.group(1)
        flags.append("family_phone")
    digits = re.sub(r"\D", "", body)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10 and digits[0] in "6789":
        return written, digits, flags
    return written, "", flags + ["check_phone"]


# Two spellings of one service, as the register holds them. The Service_Interest list on its
# Controls sheet says "Offline Group Fitness"; rows typed before that list existed say
# "Offline Fitness Group". Everything else is kept as written, trailing spaces aside.
SERVICE_ALIASES = {
    "offline fitness group": "Offline Group Fitness",
    "online fitness group": "Online Group Fitness",
}


def service(value: Any) -> Tuple[str, str]:
    """(the service, "online" | "offline"), or ("", "") when the cell is empty."""
    name = text(value)
    if not name:
        return "", ""
    name = SERVICE_ALIASES.get(name.lower(), name)
    return name, "online" if "online" in name.lower() else "offline"


def payment_mode(value: Any) -> str:
    """The register's Payment Mode as one of the OS's own mode names (frontend
    lib/paymentModes.js), or "" when it names none. "Card - Credit", "Card-credit" and
    "Credit-card" are one mode written three ways. Insurance has no mode of its own in the
    OS and reads as "unknown", the OS's "Other" -- the words are kept in mode_as_written."""
    if isinstance(value, (datetime, date)):
        return ""
    words = text(value).lower()
    if not words:
        return ""
    # And run together, so "G PAY" is GPay and "C CARD" a card.
    words = f"{words} {squash(words)}"
    for mode, cues in (
        ("upi", ("upi", "gpay", "phonepe", "paytm")),
        ("card", ("card", "credit", "debit")),
        ("cash", ("cash",)),
        ("account_transfer", ("bank", "neft", "imps", "rtgs", "transfer")),
        ("cheque", ("cheque", "check")),
        ("unknown", ("insurance",)),
    ):
        if any(cue in words for cue in cues):
            return mode
    return ""


def payment_state(status: str, paid: Optional[float], due: Optional[float]) -> str:
    """"paid" | "unpaid" | "cancelled" | "unknown".

    Overdue, Pending and Due Soon are one state here. The workbook worked them out against
    TODAY() on the day it was last saved, so they are a reading of that day rather than a
    fact about the installment; the due date is kept, and whoever reads it later can say
    how overdue it is by their own calendar.
    """
    label = status.lower()
    if label == "paid":
        return "paid"
    if label == "cancelled":
        return "cancelled"
    if label in ("overdue", "pending", "due soon"):
        return "unpaid"
    if paid:
        return "paid"
    if due:
        return "unpaid"
    return "unknown"


def name_key(value: Any) -> str:
    return squash(value)


def same_person(a: str, b: str) -> bool:
    """Whether two names could be one person's: equal once squashed, or one the start of the
    other ("Anita" and "Anita Arun")."""
    ka, kb = name_key(a), name_key(b)
    return bool(ka and kb) and (ka == kb or ka.startswith(kb) or kb.startswith(ka))


def match_key(value: Any) -> str:
    """The digits of a phone, family suffix off, for matching one sheet's row to another's.

    Wider than phone()'s lookup key on purpose. A number typed a digit short is no use for
    finding the patient later, but the desk copied it into the Patient Master and the Prospect
    Pipeline alike -- so between those two sheets it still says which row is which person.
    """
    written = text(value)
    family = FAMILY_SUFFIX.match(written)
    if family and len(re.sub(r"\D", "", family.group(1))) >= 10:
        written = family.group(1)
    digits = re.sub(r"\D", "", written)
    return digits[-10:] if len(digits) >= 10 else digits


def _days_apart(a: str, b: str) -> int:
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)
    except ValueError:
        return 10 ** 6


# ----------------------------------------------------------------------------- the sheets

def _read_sheet(workbook, sheet: str, columns: Dict[str, str], data: PastData) -> List[Dict[str, Any]]:
    """One sheet as a list of {field: cell} dicts, each with its sheet row number under _row.

    Rows without an ID are dropped here: below the last record the sheet is formula residue.
    A row that has no ID but does name somebody is reported, since that is a record the
    import is about to leave out.
    """
    if sheet not in workbook.sheetnames:
        raise PastDataError(f"The workbook has no '{sheet}' sheet")
    rows = list(workbook[sheet].iter_rows(values_only=True))

    id_header = squash(next(iter(columns.values())))
    header_at = next(
        (i for i, row in enumerate(rows[:HEADER_SEARCH_ROWS]) if id_header in {squash(c) for c in row}),
        None,
    )
    if header_at is None:
        raise PastDataError(f"'{sheet}': no '{next(iter(columns.values()))}' header in its first rows")

    position = {}
    for index, cell in enumerate(rows[header_at]):
        position.setdefault(squash(cell), index)
    where = {key: position.get(squash(header)) for key, header in columns.items()}
    missing = [columns[key] for key in REQUIRED[sheet] if where[key] is None]
    if missing:
        raise PastDataError(f"'{sheet}': missing column(s) {', '.join(missing)}")

    records = []
    for number, row in enumerate(rows[header_at + 1:], start=header_at + 2):
        record = {key: (row[i] if i is not None and i < len(row) else None) for key, i in where.items()}
        record["_row"] = number
        if text(record["excel_id"]):
            records.append(record)
        elif any(text(record[key]) for key in IDENTITY_COLUMNS[sheet]):
            who = " ".join(text(record[key]) for key in IDENTITY_COLUMNS[sheet] if text(record[key]))
            data.note("row_without_id", sheet, f"row {number}", who)
    return records


def _unique(records: List[Dict[str, Any]], sheet: str, data: PastData) -> List[Dict[str, Any]]:
    seen = set()
    kept = []
    for record in records:
        excel_id = text(record["excel_id"])
        if excel_id in seen:
            data.note("duplicate_id", sheet, excel_id, f"row {record['_row']}")
            continue
        seen.add(excel_id)
        kept.append(record)
    return kept


def _flag(record: Dict[str, Any], code: str) -> None:
    if code not in record["flags"]:
        record["flags"].append(code)


def read_workbook(source, columns: Optional[list] = None) -> PastData:
    """Read the register -- or, when the workbook has no Patient Master, the OS Data workbook
    (past_os.py), a branch's monthly revenue sheet (past_revenue.py), or else any list of
    people (past_custom.py), in that order. `source` is a path or an open binary file -- the
    latter so an upload can be read without being written to disk first.

    `columns` is what Auto Scan left on (past_scan.read_picked): only those tabs and columns
    are read. Left out, the whole workbook is, as the terminal tool reads it."""
    from openpyxl import load_workbook  # only the reader needs it; the cleaners above don't

    workbook = load_workbook(source, read_only=True, data_only=True, keep_vba=False)
    try:
        if columns is None:
            return read_open(workbook)
        import past_scan
        book = past_scan.grid(workbook)
    finally:
        workbook.close()
    return past_scan.read_picked(book, columns)


def read_open(workbook, layout: Optional[str] = None) -> PastData:
    """Read an open workbook as `layout` -- as detected here when not given, the order
    read_workbook says."""
    if layout is None and CLIENT_SHEET not in workbook.sheetnames:
        # Not the register. The OS Data workbook is asked about before the revenue sheet:
        # its Payments tab has NAME, PHONE and AMOUNT columns, which the revenue reader
        # would take for a month of payments and read alone, every other tab passed over.
        import past_os
        if past_os.detect(workbook):
            return past_os.read(workbook)
        import past_revenue
        try:
            return past_revenue.read(workbook)
        except PastDataError:
            layout = "custom"
    if layout == "os":
        import past_os
        return past_os.read(workbook)
    if layout == "revenue":
        import past_revenue
        return past_revenue.read(workbook)
    if layout == "custom":
        import past_custom
        import past_scan
        return past_custom.read(workbook if isinstance(workbook, past_scan.GridBook) else past_scan.grid(workbook))
    data = PastData()
    client_rows = _unique(_read_sheet(workbook, CLIENT_SHEET, CLIENT_COLUMNS, data), CLIENT_SHEET, data)
    treatment_rows = _unique(_read_sheet(workbook, TREATMENT_SHEET, TREATMENT_COLUMNS, data), TREATMENT_SHEET, data)
    payment_rows = _unique(_read_sheet(workbook, PAYMENT_SHEET, PAYMENT_COLUMNS, data), PAYMENT_SHEET, data)
    enquiry_rows = _unique(_read_sheet(workbook, ENQUIRY_SHEET, ENQUIRY_COLUMNS, data), ENQUIRY_SHEET, data)
    return build(client_rows, treatment_rows, payment_rows, enquiry_rows, data)


def build(client_rows, treatment_rows, payment_rows, enquiry_rows, data: Optional[PastData] = None) -> PastData:
    """The four sheets' rows, cleaned and linked. Separate from read_workbook so the linking
    can be tested on plain dicts."""
    data = data or PastData()

    # -- clients
    clients_by_excel: Dict[str, Dict[str, Any]] = {}
    for row in client_rows:
        written, looked_up, phone_flags = phone(row.get("phone"))
        client = {
            "id": str(uuid.uuid4()),
            "excel_id": text(row["excel_id"]),
            "name": text(row.get("name")),
            "gender": text(row.get("gender")),
            "age": whole(row.get("age")),
            "phone": written,
            "phone_normalized": looked_up,
            "email": text(row.get("email")),
            "registration_date": day(row.get("registration_date")),
            "source": text(row.get("source")),
            "notes": text(row.get("notes")),
            "enquiries": [],
            "flags": list(phone_flags),
            "shared_phone_with": [],
        }
        if "check_phone" in phone_flags:
            data.note("check_phone", CLIENT_SHEET, client["excel_id"], f"{client['name']}: {written or '(blank)'}")
        clients_by_excel[client["excel_id"]] = client
        data.clients.append(client)

    by_phone: Dict[str, List[Dict[str, Any]]] = {}
    for client in data.clients:
        if client["phone_normalized"]:
            by_phone.setdefault(client["phone_normalized"], []).append(client)
    for number, group in by_phone.items():
        if len(group) < 2:
            continue
        for client in group:
            _flag(client, "shared_phone")
            client["shared_phone_with"] = [c["excel_id"] for c in group if c is not client]
        data.note(
            "shared_phone", CLIENT_SHEET, ", ".join(c["excel_id"] for c in group),
            f"{number}: " + " / ".join(c["name"] for c in group),
        )

    # -- enquiries, onto the client they were. The Patient Master's own "Prospect ID" column
    # says so outright where it was filled in; everywhere else it is the phone number. Where
    # one number is several clients the name narrows it, and where that still leaves two --
    # one person entered twice under one name -- the client registered nearest the enquiry
    # is the visit it was about. Two equally near is a guess, and is reported instead.
    linked = {text(r.get("enquiry_excel_id")): clients_by_excel[text(r["excel_id"])]
              for r in client_rows
              if text(r.get("enquiry_excel_id")) and text(r["excel_id"]) in clients_by_excel}
    by_match_key: Dict[str, List[Dict[str, Any]]] = {}
    for row in client_rows:
        key = match_key(row.get("phone"))
        if key and text(row["excel_id"]) in clients_by_excel:
            by_match_key.setdefault(key, []).append(clients_by_excel[text(row["excel_id"])])
    for row in enquiry_rows:
        data.enquiries_read += 1
        excel_id = text(row["excel_id"])
        name = text(row.get("name"))
        client = linked.get(excel_id)
        if not client:
            key = match_key(row.get("phone"))
            candidates = by_match_key.get(key, []) if key else []
            if len(candidates) > 1:
                candidates = [c for c in candidates if same_person(c["name"], name)]
            if len(candidates) > 1:
                asked = day(row.get("enquiry_date"))
                nearest = min(_days_apart(c["registration_date"], asked) for c in candidates)
                candidates = [c for c in candidates if _days_apart(c["registration_date"], asked) == nearest]
            if len(candidates) > 1 or (not candidates and len(by_match_key.get(key, [])) > 1):
                data.note("enquiry_ambiguous", ENQUIRY_SHEET, excel_id, f"{name}: {text(row.get('phone'))}")
                continue
            if not candidates:
                data.note("enquiry_no_client", ENQUIRY_SHEET, excel_id, f"{name}: {text(row.get('phone'))} ({text(row.get('status'))})")
                continue
            client = candidates[0]
        converted = text(row.get("converted")).upper()
        client["enquiries"].append({
            "excel_id": excel_id,
            "enquiry_date": day(row.get("enquiry_date")),
            "service_interest": service(row.get("service_interest"))[0],
            "referred_by": text(row.get("referred_by")),
            "status": text(row.get("status")),
            "outcome": text(row.get("outcome")),
            "package_recommended": service(row.get("package_recommended"))[0],
            "converted": True if converted == "Y" else False if converted == "N" else None,
            "conversion_date": day(row.get("conversion_date")),
        })
        data.enquiries_attached += 1
    for client in data.clients:
        client["enquiries"].sort(key=lambda e: (e["enquiry_date"], e["excel_id"]))

    # -- treatments
    treatments_by_excel: Dict[str, Dict[str, Any]] = {}
    for row in treatment_rows:
        excel_id = text(row["excel_id"])
        client_excel_id = text(row.get("client_excel_id"))
        client = clients_by_excel.get(client_excel_id)
        if not client:
            data.note("missing_client", TREATMENT_SHEET, excel_id, f"Patient ID {client_excel_id or '(blank)'}")
            continue
        name, mode = service(row.get("service"))
        sessions = row.get("recommended_sessions")
        treatment = {
            "id": str(uuid.uuid4()),
            "excel_id": excel_id,
            "client_id": client["id"],
            "client_excel_id": client_excel_id,
            "name": text(row.get("name")) or client["name"],
            "service": name,
            "service_as_written": text(row.get("service")),
            "mode": mode,
            "physio": text(row.get("physio")),
            "start_date": day(row.get("start_date")),
            "status": text(row.get("status")),
            # A count where one was typed ("12"), and the words where it was not ("8w",
            # "3 months", "42 to 56") -- those are a plan, not a number anybody can add up.
            "recommended_sessions": whole(sessions),
            "recommended_sessions_text": "" if whole(sessions) is not None else text(sessions),
            "fee": amount(row.get("fee")),
            "notes": text(row.get("notes")),
            "flags": [],
        }
        if not name:
            _flag(treatment, "no_service")
            data.note("no_service", TREATMENT_SHEET, excel_id, f"{client['name']}, {treatment['status']}")
        if treatment["name"] and not same_person(treatment["name"], client["name"]):
            _flag(treatment, "name_differs")
            data.note("name_differs", TREATMENT_SHEET, excel_id, f"'{treatment['name']}' vs {client_excel_id} '{client['name']}'")
        treatments_by_excel[excel_id] = treatment
        data.treatments.append(treatment)

    # -- payments. The course is the enrollment the row names; the Patient ID beside it is a
    # formula-fed copy that can be out of step with it (rows pasted one line off), so it is
    # kept as written and flagged when it disagrees, but it never moves the payment.
    for row in payment_rows:
        excel_id = text(row["excel_id"])
        treatment_excel_id = text(row.get("treatment_excel_id"))
        treatment = treatments_by_excel.get(treatment_excel_id)
        if not treatment:
            data.note("missing_treatment", PAYMENT_SHEET, excel_id, f"Enrollment ID {treatment_excel_id or '(blank)'}")
            continue
        due, paid, balance = amount(row.get("amount_due")), amount(row.get("amount_paid")), amount(row.get("balance"))
        status = text(row.get("status"))
        state = payment_state(status, paid, due)
        payment = {
            "id": str(uuid.uuid4()),
            "excel_id": excel_id,
            "client_id": treatment["client_id"],
            "treatment_id": treatment["id"],
            "treatment_excel_id": treatment_excel_id,
            "client_excel_id": text(row.get("client_excel_id")),
            "name": text(row.get("name")),
            "installment": whole(row.get("installment")),
            "installments_total": whole(row.get("installments_total")),
            "amount_due": due,
            "amount_paid": paid,
            "balance": balance,
            # What this row still wants, on the one state that wants anything.
            "outstanding": (balance if balance is not None else max(0, (due or 0) - (paid or 0))) if state == "unpaid" else 0,
            "due_date": day(row.get("due_date")),
            "paid_date": day(row.get("paid_date")),
            "mode": payment_mode(row.get("mode")),
            "mode_as_written": text(row.get("mode")),
            "state": state,
            "status_as_written": status,
            "notes": text(row.get("notes")),
            "flags": [],
        }
        if payment["client_excel_id"] and payment["client_excel_id"] != treatment["client_excel_id"]:
            _flag(payment, "client_mismatch")
            data.note(
                "client_mismatch", PAYMENT_SHEET, excel_id,
                f"{treatment_excel_id} belongs to {treatment['client_excel_id']} {treatment['name']}; "
                f"row says {payment['client_excel_id']} {payment['name']}",
            )
        if state == "paid" and not payment["mode"]:
            _flag(payment, "check_mode")
            data.note("check_mode", PAYMENT_SHEET, excel_id, f"mode '{payment['mode_as_written'] or '(blank)'}'")
        if state == "unknown":
            _flag(payment, "unknown_state")
            data.note("unknown_state", PAYMENT_SHEET, excel_id, payment["notes"])
        data.payments.append(payment)

    _add_totals(data)
    return data


def _add_totals(data: PastData) -> None:
    """What each course and each client came to: what was paid, what was still owed.

    Summed off the installments rather than read off the register's "Total Fee", because the
    two disagree on a quarter of the courses: a renewal was usually entered as more payment
    rows on the same enrollment, so the fee says what the first package cost and the rows say
    what the patient actually paid. Both are kept -- `fee` as written, the totals as summed.
    """
    by_treatment: Dict[str, List[Dict[str, Any]]] = {}
    for payment in data.payments:
        by_treatment.setdefault(payment["treatment_id"], []).append(payment)
    for treatment in data.treatments:
        rows = [p for p in by_treatment.get(treatment["id"], []) if p["state"] != "cancelled"]
        treatment["paid_total"] = sum(p["amount_paid"] or 0 for p in rows if p["state"] == "paid")
        treatment["outstanding_total"] = sum(p["outstanding"] or 0 for p in rows)
        treatment["payments_count"] = len(rows)
        treatment["last_paid_date"] = max((p["paid_date"] for p in rows if p["paid_date"]), default="")

    by_client: Dict[str, List[Dict[str, Any]]] = {}
    for treatment in data.treatments:
        by_client.setdefault(treatment["client_id"], []).append(treatment)
    payment_flags: Dict[str, int] = {}
    for payment in data.payments:
        payment_flags[payment["client_id"]] = payment_flags.get(payment["client_id"], 0) + len(payment["flags"])
    for client in data.clients:
        courses = by_client.get(client["id"], [])
        dates = sorted(t["start_date"] for t in courses if t["start_date"])
        latest = max(courses, key=lambda t: (t["start_date"], t["excel_id"]), default=None)
        client["treatments_count"] = len(courses)
        client["services"] = sorted({t["service"] for t in courses if t["service"]})
        client["first_treatment_date"] = dates[0] if dates else ""
        client["last_treatment_date"] = dates[-1] if dates else ""
        # The register's word for the newest course, as written. Read with care: the register
        # left a consultation-only patient's course "Active", so it is what the sheet said,
        # not whether anybody is in treatment.
        client["latest_status"] = latest["status"] if latest else ""
        client["paid_total"] = sum(t["paid_total"] for t in courses)
        client["outstanding_total"] = sum(t["outstanding_total"] for t in courses)
        # Everything flagged on this person, their courses and their payments, so the Past
        # Data list can offer "Needs a look" as one indexed filter rather than a join.
        # family_phone is not counted: it says how the number was written, not that
        # anything about it is wrong.
        client["issue_count"] = (
            len([f for f in client["flags"] if f != "family_phone"])
            + sum(len(t["flags"]) for t in courses)
            + payment_flags.get(client["id"], 0)
        )


def summary(data: PastData) -> Dict[str, Any]:
    """The figures the import report leads with."""
    states: Dict[str, Dict[str, float]] = {}
    for payment in data.payments:
        bucket = states.setdefault(payment["state"], {"rows": 0, "amount": 0})
        bucket["rows"] += 1
        bucket["amount"] += (payment["amount_paid"] or 0) if payment["state"] == "paid" else (payment["outstanding"] or 0)
    counts: Dict[str, int] = {}
    for finding in data.findings:
        counts[finding.code] = counts.get(finding.code, 0) + 1
    return {
        "clients": len(data.clients),
        "treatments": len(data.treatments),
        "payments": len(data.payments),
        "enquiries_read": data.enquiries_read,
        "enquiries_attached": data.enquiries_attached,
        "layout": data.layout,
        "tabs": list(data.tabs),
        "types": list(data.types),
        "tab_rows": dict(data.tab_rows),
        "tabs_missing": list(data.tabs_missing),
        "sessions": data.sessions_read,
        "reviews": data.reviews_read,
        "branches": dict(data.branches),
        "payment_states": states,
        "findings": counts,
    }
