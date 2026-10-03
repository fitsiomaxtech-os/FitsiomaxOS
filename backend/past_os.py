"""The OS Data workbook (OSDATAX.xlsx), read into the Past Data tables.

The third kind of sheet Settings > Import/Export reads, beside the register (past_data.py)
and the branches' monthly revenue sheets (past_revenue.py). Where those two are books the
clinic kept before the OS, this one was laid out on the OS's own fields, for the clients
still being treated: one workbook, five tabs, read at the same time in one upload --

  Leads     one row per client: who they are, and where they stand (Current Stage, one of
            the OS's own fifteen stage names, and the date of each step on the way there)
  Physio    one row per course: Treatment or Rehab, the package, its sessions and its price
  Sessions  one row per course of a client's: the dates done and the dates to come, listed
            in two cells, at what time and by which physio (or, as the tab was first laid
            out and is still read, one row per session)
  Reviews   one row per review, by the Head Physio
  Payments  one row per client: the consultation fee, and each instalment of the treatment
            fee -- its amount, Paid Date or Due Date, and mode -- in columns of its own (or,
            as the tab was first laid out and is still read, one row per payment)

-- so one sheet on the Import/Export list holds three kinds of data at once, which its Type
column shows as Lead, Sessions (the Physio, Sessions and Reviews tabs) and Revenue (the
Payments tab). Every tab but Leads may be missing, or empty.

Rows are tied to their client by Patient ID and, where a row has none -- or the sheet has
no Patient ID at all, and ties its tabs together by Phone alone -- by phone, and by name as
well when several clients share the number, which is the register's own rule (same_person).
A row that names nobody on the Leads tab is left out and reported, never guessed onto
somebody.

Into the same three tables the other two readers write: a client per Leads row (sessions and
reviews carried on the client, since nothing in the OS reads them from here but the client's
own card), a treatment per Physio row -- plus one "Consultation" for the consultation fees
-- and a payment per Payments row. Status is read as written: a Pending payment is owed, not
paid, and a payment with no Status is neither, since a guess either way moves money.

Nothing here touches a database -- see past_data.py.
"""
import re
import uuid
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional, Tuple

from past_data import (
    HEADER_SEARCH_ROWS, PastData, PastDataError, _add_totals, _flag, amount, day, match_key,
    payment_mode, phone, same_person, squash, text, whole,
)

LEADS, PHYSIO, SESSIONS, REVIEWS, PAYMENTS = "Leads", "Physio", "Sessions", "Reviews", "Payments"
TAB_ORDER = (LEADS, PHYSIO, SESSIONS, REVIEWS, PAYMENTS)

# Each tab's columns by header text, as the template (OSDATAX.xlsx) writes them. Matched
# through squash(), so "Condition / Pain Area" and "Condition/Pain area" are one header.
COLUMNS = {
    LEADS: {
        "excel_id": "Patient ID",
        "branch": "Branch",
        "name": "Name",
        "phone": "Phone",
        "alternative_phone": "Alternative Phone",
        "email": "Email",
        "age": "Age",
        "gender": "Gender",
        "address": "Address",
        "city": "City",
        "state": "State",
        "department": "Department",
        "condition": "Condition / Pain Area",
        "months_of_pain": "Months of Pain",
        "occupation": "Occupation",
        "source": "Source",
        "lead_at": "Lead Date & Time",
        "current_stage": "Current Stage",
        "rnr_date": "RNR Date",
        "follow_up_at": "Follow Up Date & Time",
        "booked_on": "Booked On",
        "appointment_at": "Appointment Date & Time",
        "rescheduled_to": "Rescheduled To",
        "consultant": "Consultant Name",
        "consultation_visit_date": "Consultation Visit Date",
        "diet_consultation_date": "Diet Consultation Date",
        "diet_chart_date": "Diet Chart Date",
        "dropped_date": "Dropped Date",
        "dropped_reason": "Dropped Reason",
        "notes": "Notes",
    },
    PHYSIO: {
        "client_excel_id": "Patient ID",
        "phone": "Phone",
        "name": "Name",
        "course": "Course",
        "package": "Package Name",
        "sessions": "Sessions",
        "amount": "Package Amount",
        "start_date": "Physio Assign Date",
        "physio": "Physio Name",
        "completed_date": "Completed Date",
        "notes": "Notes",
    },
    SESSIONS: {
        "client_excel_id": "Patient ID",
        "phone": "Phone",
        "name": "Name",
        "course": "Course",
        "physio": "Physio Name",
        "time": "Session Time",
        "completed_dates": "Completed Dates",
        "upcoming_dates": "Upcoming Dates",
        # The tab's first layout, a row per session -- still read, so a workbook filled in
        # that way imports as it did.
        "session_no": "Session No",
        "at": "Date & Time",
        "status": "Status",
        "remarks": "Remarks",
    },
    REVIEWS: {
        "client_excel_id": "Patient ID",
        "phone": "Phone",
        "name": "Name",
        "review_no": "Review No",
        "at": "Review Date & Time",
        "head_physio": "Head Physio Name",
        "status": "Status",
        "physio_notes": "Physio Notes",
        "head_physio_notes": "Head Physio Notes",
    },
    PAYMENTS: {
        "client_excel_id": "Patient ID",
        "phone": "Phone",
        "name": "Name",
        # A row per client: the consultation fee, then the treatment fee's instalments, each
        # in four columns of its own -- see INSTALMENT_COLUMN.
        "consultation_fee": "Consultation Fee",
        "consultation_date": "Consultation Date",
        "consultation_mode": "Consultation Mode",
        # The tab's first layout, a row per payment -- still read, so a workbook filled in
        # that way imports as it did.
        "payment_for": "Payment For",
        "installment": "Instalment No",
        "status": "Status",
        "amount": "Amount",
        "paid_date": "Payment Date",
        "due_date": "Due Date",
        "mode": "Payment Mode",
        "reference_no": "Reference No",
        "bank": "Bank Name",
        "remarks": "Remarks",
    },
}

# The Payments tab's instalment columns, as many as a client's plan has: "Instalment 1
# Amount", "Instalment 1 Paid Date", "Instalment 1 Due Date", "Instalment 1 Mode", then 2...
# Read as instalment_<n>_<part>. "Installment" is the same header.
INSTALMENT_COLUMN = re.compile(r"^instal{1,2}ment(\d+)(amount|paiddate|duedate|mode)$")
INSTALMENT_PARTS = {"amount": "amount", "paiddate": "paid_date", "duedate": "due_date", "mode": "mode"}

# Without these a tab cannot be read. The other tabs also need a Patient ID or a Phone column
# to tie a row to its client -- checked on its own, since either one will do -- and a
# Payments tab laid out a row per payment its Status and Amount (see required()).
REQUIRED = {
    LEADS: ("name", "phone", "current_stage"),
    PHYSIO: (),
    SESSIONS: (),
    REVIEWS: (),
    PAYMENTS: (),
}

# The OS's stage names, in the order a client moves through them (the template's Listed
# Data > Current Stage). "Cancelled" is the Branch pipeline's -- the appointment called off
# -- and "Cancel" the consultation pipeline's; "Completed" is a finished course.
STAGES = (
    "Leads", "RNR", "Follow Up", "Portfolio", "Not a prospect", "Cancelled",
    "Consultation Booked", "Consultation Visit", "Fee Collected", "Physio Assign", "Rehab",
    "Diet Consultation", "Diet Chart", "Completed", "Cancel",
)
STAGE_BY_KEY = {squash(s): s for s in STAGES}

# The template's Department as the lead form's own values (DEPARTMENT_OPTIONS in
# frontend CreateLeadModal.jsx), so a moved lead's card reads its department back.
DEPARTMENTS = {
    "offlinephysio": "offline_physio",
    "onlinephysio": "online_physio",
    "offlinefitness": "offline_fitness",
    "onlinefitness": "online_fitness",
}
GENDERS = {"male": "Male", "female": "Female", "other": "Other"}
COURSES = {"treatment": "Treatment", "rehab": "Rehab"}
SESSION_STATUSES = {"completed": "Completed", "upcoming": "Upcoming"}
REVIEW_STATUSES = {"completed": "Completed", "pending": "Pending"}
# Payment For, the template's other value beside the consultation fee.
TREATMENT_FEE = {"treatmentfee", "treatment"}

# What a desk types into a cell to say "nothing here".
BLANKS = {"-", "--", "—", "–", "na", "n/a", "nil", "none"}

CONSULTATION = "Consultation"
SAMPLE = re.compile(r"(?i)^sample\s")

MOMENT_FORMATS = (
    "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M",
    "%d-%m-%Y %I:%M %p", "%d/%m/%Y %I:%M %p", "%Y-%m-%d %H:%M:%S",
)
CLOCK_FORMATS = ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H")
DAY_OF_MONTH = re.compile(r"^\d{1,2}$")


# ------------------------------------------------------------------------------ cleaners

def _blank(value: Any) -> Any:
    return None if isinstance(value, str) and value.strip().lower() in BLANKS else value


def moment(value: Any) -> str:
    """A date-and-time cell as "YYYY-MM-DD HH:MM", or as its date alone when it holds no
    time -- a date typed into a date-and-time column is a day, not midnight."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M") if (value.hour or value.minute) else value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    written = text(value)
    for fmt in MOMENT_FORMATS:
        try:
            return datetime.strptime(written, fmt).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            continue
    return day(value)


def clock(value: Any) -> str:
    """A time-of-day cell as "HH:MM", or "" when it holds none. Excel keeps a typed 10:00 as a
    time (or a fraction of a day); a time typed as text is read in the shapes people type."""
    if isinstance(value, datetime):
        value = value.time()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, float) and 0 < value < 1:
        minutes = min(round(value * 24 * 60), 24 * 60 - 1)
        return f"{minutes // 60:02d}:{minutes % 60:02d}"
    written = text(value).upper()
    for fmt in CLOCK_FORMATS:
        try:
            return datetime.strptime(written, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return ""


def dates(value: Any) -> Tuple[List[str], List[str]]:
    """A cell listing one date per session, as (the dates read, as moment() writes them; what
    could not be read, as written) -- or the single date Excel kept as a date.

    Commas, semicolons or line breaks between them, and a day of the month alone for a day
    whose month and year the next full date gives: "21, 22, 23-09-2026, 1, 2 - 10 - 2026" is
    21, 22 and 23 September and 1 and 2 October. A day with no full date after it has no
    month, and is not read."""
    if isinstance(value, (datetime, date)):
        return [moment(value)], []
    # Not through text(), which would fold the line breaks into spaces.
    written = value if isinstance(value, str) else text(value)
    read: List[str] = []
    unread: List[str] = []
    waiting: List[str] = []
    for piece in re.split(r"[,;\n]+", written):
        piece = re.sub(r"\s*([-/])\s*", r"\1", piece.strip())
        if not piece:
            continue
        if DAY_OF_MONTH.match(piece):
            waiting.append(piece)
            continue
        at = moment(piece)
        if not at:
            # Reported alone: the days before it still wait for the next full date.
            unread.append(piece)
            continue
        for d in waiting:
            try:
                read.append(date(int(at[:4]), int(at[5:7]), int(d)).isoformat())
            except ValueError:
                unread.append(f"{d}-{at[5:7]}-{at[:4]}")
        read.append(at)
        waiting = []
    unread += [f"{d} (no month and year after it)" for d in waiting]
    return read, unread


def _pick(table: Dict[str, str], value: Any) -> str:
    """A list value in the template's own spelling, or as written when it is not one."""
    written = text(value)
    return table.get(squash(written), written)


def _is_sample(record: dict) -> bool:
    return bool(SAMPLE.match(text(record.get("name"))))


def _course(data: PastData, tab: str, where: str, who: str, value: Any) -> str:
    """Treatment or Rehab. Anything else written in the cell ("Physio 1-on-1") is a
    treatment course by another name, read as one and reported, so its sessions and payments
    still find it."""
    written = text(value)
    course = COURSES.get(squash(written), "")
    if not course and written:
        data.note("unknown_course", tab, where, f"{who}: '{written}'")
    return course or "Treatment"


def _status(data: PastData, table: Dict[str, str], code: str, tab: str, where: str, who: str, value: Any) -> str:
    """A list value in the template's own spelling; one that is not on the list is kept as
    written and reported, since what it was meant to say is not ours to guess."""
    written = text(value)
    known = table.get(squash(written))
    if not known:
        data.note(code, tab, where, f"{who}: '{written or '(blank)'}'")
    return known or written


# ---------------------------------------------------------------------------- the tabs

def _tab(workbook, name: str):
    """The worksheet whose title is `name`, however it is cased or spaced ("Reviews ")."""
    return next((ws for ws in workbook.worksheets if squash(ws.title) == squash(name)), None)


def _header(rows, tab: str):
    """(the header row's index, field -> column) off the first row holding at least two of
    this tab's headers, or None. On Payments, every instalment column the row has as well."""
    columns = COLUMNS[tab]
    wanted = {squash(h) for h in columns.values()}
    for at, row in enumerate(rows[:HEADER_SEARCH_ROWS]):
        cells = [squash(c) for c in (row or ())]
        if len(wanted & set(cells)) >= 2:
            position: Dict[str, int] = {}
            for i, cell in enumerate(cells):
                position.setdefault(cell, i)
            where = {key: position.get(squash(header)) for key, header in columns.items()}
            if tab == PAYMENTS:
                for i, cell in enumerate(cells):
                    numbered = INSTALMENT_COLUMN.match(cell)
                    if numbered:
                        n, part = int(numbered.group(1)), INSTALMENT_PARTS[numbered.group(2)]
                        where.setdefault(f"instalment_{n}_{part}", i)
            return at, where
    return None


def _one_row_payments(where: Dict[str, Optional[int]]) -> bool:
    """Whether a Payments tab's headers lay it out a row per client."""
    return where.get("consultation_fee") is not None or any(
        i is not None for key, i in where.items() if key.startswith("instalment_"))


def required(tab: str, where: Dict[str, Optional[int]]) -> List[str]:
    """The fields a tab cannot be read without, as its header row lays it out: REQUIRED's,
    and on a Payments tab laid out a row per payment -- or with either of that layout's
    Status and Amount among its headers -- both of them."""
    need = list(REQUIRED[tab])
    first_layout = where.get("status") is not None or where.get("amount") is not None
    if tab == PAYMENTS and (first_layout or not _one_row_payments(where)):
        need += ["status", "amount"]
    return need


def detect(workbook) -> bool:
    """Whether this is the OS Data workbook: a Leads tab with Current Stage among its
    headers, and Patient ID or Phone -- whichever the sheet ties its tabs together by. Asked
    of every upload that is not the register."""
    ws = _tab(workbook, LEADS)
    if ws is None:
        return False
    for row in ws.iter_rows(min_row=1, max_row=HEADER_SEARCH_ROWS, values_only=True):
        headers = {squash(c) for c in (row or ())}
        if "currentstage" in headers and headers & {"patientid", "phone"}:
            return True
    return False


def _records(ws, tab: str) -> List[Dict[str, Any]]:
    """One tab's rows as {field: cell} dicts, each with its sheet row number under _row.
    Rows with nothing in them -- the template runs to row 1000 -- are passed over."""
    columns = COLUMNS[tab]
    rows = list(ws.iter_rows(values_only=True))
    found = _header(rows, tab)
    if not found:
        raise PastDataError(f"'{ws.title.strip()}': no header row in its first rows")
    at, where = found
    missing = [columns[key] for key in required(tab, where) if where[key] is None]
    if tab != LEADS and where.get("client_excel_id") is None and where.get("phone") is None:
        missing.append("Phone (or Patient ID)")
    if missing:
        raise PastDataError(f"'{ws.title.strip()}': missing column(s) {', '.join(missing)}")
    records = []
    for number, row in enumerate(rows[at + 1:], start=at + 2):
        row = row or ()
        record = {key: (_blank(row[i]) if i is not None and i < len(row) else None) for key, i in where.items()}
        if not any(text(v) for v in record.values()):
            continue
        record["_row"] = number
        records.append(record)
    return records


def read(workbook) -> PastData:
    """Every tab of an open OS Data workbook, as PastData. Raises PastDataError when a tab it
    reads lacks a column it cannot do without, or when there is nobody on the Leads tab."""
    data = PastData(layout="os")
    tabs: Dict[str, List[Dict[str, Any]]] = {}
    for name in TAB_ORDER:
        ws = _tab(workbook, name)
        if ws is None:
            if name == LEADS:
                raise PastDataError("the workbook has no 'Leads' tab")
            data.tabs_missing.append(name)
            continue
        tabs[name] = _records(ws, name)
        data.tabs.append(ws.title.strip())
    return build(tabs, data)


# ------------------------------------------------------------------------------ the rows

def build(tabs: Dict[str, List[Dict[str, Any]]], data: Optional[PastData] = None) -> PastData:
    """The five tabs' rows as clients, treatments and payments. Separate from read() so the
    linking can be tested on plain dicts: each record is {field: cell, "_row": n}."""
    data = data or PastData()
    data.layout = "os"
    data.tab_rows = {name: len(tabs.get(name) or []) for name in TAB_ORDER if name in tabs}

    # -- clients, off the Leads tab. A sheet with no Patient ID on any row ties its tabs
    # together by Phone alone, so a client without one is how it is laid out, not a slip.
    by_excel: Dict[str, Dict[str, Any]] = {}
    sample_ids, sample_keys = set(), set()
    ids_used = any(text(r.get("excel_id")) for r in tabs.get(LEADS, []))
    for record in tabs.get(LEADS, []):
        where = f"{LEADS} · row {record['_row']}"
        name = text(record.get("name"))
        excel_id = text(record.get("excel_id"))
        if not name and not text(record.get("phone")):
            # An ID typed down the column ahead of the people it is for is nobody yet.
            if any(text(v) for k, v in record.items() if k not in ("excel_id", "_row")):
                data.note("no_name_row", LEADS, excel_id or where, "no Name and no Phone")
            continue
        if SAMPLE.match(name):
            data.note("sample_row", LEADS, excel_id or where, name)
            if excel_id:
                sample_ids.add(excel_id)
            if match_key(record.get("phone")):
                sample_keys.add(match_key(record.get("phone")))
            continue
        if excel_id and excel_id in by_excel:
            data.note("duplicate_id", LEADS, excel_id, where)
            continue
        client = _client(record, excel_id or where, data)
        if not excel_id and ids_used:
            _flag(client, "no_patient_id")
            data.note("no_patient_id", LEADS, where, name)
        by_excel[client["excel_id"]] = client
        data.clients.append(client)
    if not data.clients:
        raise PastDataError(
            "the Leads tab has no clients" + (" -- only the template's sample row" if sample_ids or sample_keys else "")
        )
    for client in data.clients:
        written = client["branch_as_written"] or "(blank)"
        data.branches[written] = data.branches.get(written, 0) + 1
    _shared_phones(data)

    by_key: Dict[str, List[Dict[str, Any]]] = {}
    for client in data.clients:
        key = match_key(client["phone"])
        if key:
            by_key.setdefault(key, []).append(client)

    def owner(record: dict, tab: str, where: str) -> Optional[Dict[str, Any]]:
        """The client this row is about, or None -- reported -- when there is not exactly one."""
        if _is_sample(record):
            data.note("sample_row", tab, where, text(record.get("name")))
            return None
        pid = text(record.get("client_excel_id"))
        if pid in sample_ids:
            return None
        if pid:
            client = by_excel.get(pid)
            if not client:
                data.note("no_client", tab, where, f"Patient ID {pid}")
            return client
        key, name = match_key(record.get("phone")), text(record.get("name"))
        candidates = [c for c in by_key.get(key, []) if not name or same_person(c["name"], name)] if key else []
        if len(candidates) == 1:
            return candidates[0]
        if not candidates and key in sample_keys:
            return None
        data.note("no_client", tab, where, f"{name or '(no name)'}: {text(record.get('phone')) or '(no phone)'}"
                  + (" -- more than one client matches" if len(candidates) > 1 else ""))
        return None

    # -- courses, off the Physio tab
    courses: Dict[str, List[Dict[str, Any]]] = {}
    for record in tabs.get(PHYSIO, []):
        where = f"{PHYSIO} · row {record['_row']}"
        client = owner(record, PHYSIO, where)
        if not client:
            continue
        course = _course(data, PHYSIO, where, client["name"], record.get("course"))
        package = text(record.get("package"))
        completed = day(record.get("completed_date"))
        sessions = record.get("sessions")
        treatment = _treatment(
            client, where,
            # The course first, so the Accountant files a Rehab course's payments under
            # Rehab (past_data_live.category_for reads the service's words).
            service=" · ".join(p for p in (course, package) if p),
            course=course, package=package, physio=text(record.get("physio")),
            start_date=day(record.get("start_date")), end_date=completed,
            status="Completed" if completed else "Active",
            recommended_sessions=whole(sessions),
            recommended_sessions_text="" if whole(sessions) is not None else text(sessions),
            fee=amount(record.get("amount")), notes=text(record.get("notes")),
        )
        data.treatments.append(treatment)
        courses.setdefault(client["id"], []).append(treatment)

    # -- sessions and reviews, onto the client (and each session counted on its course)
    for record in tabs.get(SESSIONS, []):
        where = f"{SESSIONS} · row {record['_row']}"
        client = owner(record, SESSIONS, where)
        if not client:
            continue
        course = _course(data, SESSIONS, where, client["name"], record.get("course"))
        unplaced = False
        for session in _row_sessions(data, record, where, client["name"]):
            session.update(course=course, physio=text(record.get("physio")), row=where)
            treatment = _course_for(courses.get(client["id"], []), session["at"][:10], course)
            if treatment:
                session["treatment_excel_id"] = treatment["excel_id"]
                if session["status"] == "Completed":
                    treatment["sessions_completed"] += 1
                elif session["status"] == "Upcoming":
                    treatment["sessions_upcoming"] += 1
            else:
                unplaced = True
            client["sessions"].append(session)
            data.sessions_read += 1
        if unplaced:
            # Once for the row, however many of its dates had no course to go on.
            _flag(client, "session_no_course")
            data.note("session_no_course", SESSIONS, where, f"{client['name']}: {course}")

    for record in tabs.get(REVIEWS, []):
        where = f"{REVIEWS} · row {record['_row']}"
        client = owner(record, REVIEWS, where)
        if not client:
            continue
        client["reviews"].append({
            "review_no": whole(record.get("review_no")),
            "at": moment(record.get("at")),
            "head_physio": text(record.get("head_physio")),
            "status": _status(data, REVIEW_STATUSES, "unknown_review_status", REVIEWS, where,
                              client["name"], record.get("status")),
            "physio_notes": text(record.get("physio_notes")),
            "head_physio_notes": text(record.get("head_physio_notes")),
            "row": where,
        })
        data.reviews_read += 1

    # -- payments, each under the course it paid for
    consultations: Dict[str, Dict[str, Any]] = {}
    placeholders: Dict[str, Dict[str, Any]] = {}
    for record in tabs.get(PAYMENTS, []):
        where = f"{PAYMENTS} · row {record['_row']}"
        client = owner(record, PAYMENTS, where)
        if not client:
            continue
        found = _row_payments(record, where)
        if not found:
            data.note("no_payments", PAYMENTS, where, client["name"])
        for entry in found:
            at, payment_for, figure = entry["excel_id"], entry["payment_for"], entry["figure"]
            paid_day, due_day, state = entry["paid_day"], entry["due_day"], entry["state"]
            if not squash(payment_for).startswith("consult") and squash(payment_for) not in TREATMENT_FEE:
                data.note("unknown_payment_for", PAYMENTS, at, f"{client['name']}: '{payment_for or '(blank)'}'")

            if squash(payment_for).startswith("consult"):
                treatment = consultations.get(client["id"])
                if not treatment:
                    treatment = _treatment(
                        client, f"{client['excel_id']} · {CONSULTATION}", service=CONSULTATION,
                        course=CONSULTATION, physio=client["consultant"],
                        start_date=client["journey"].get("consultation_visit_date") or paid_day or due_day,
                    )
                    consultations[client["id"]] = treatment
                    data.treatments.append(treatment)
            else:
                treatment = _course_for(courses.get(client["id"], []), paid_day or due_day)
                if not treatment:
                    treatment = placeholders.get(client["id"])
                    if not treatment:
                        treatment = _treatment(
                            client, f"{client['excel_id']} · Treatment", service="Treatment", course="Treatment",
                            start_date=paid_day or due_day, status="",
                        )
                        _flag(treatment, "payment_no_course")
                        data.note("payment_no_course", PAYMENTS, at, client["name"])
                        placeholders[client["id"]] = treatment
                        data.treatments.append(treatment)

            payment = {
                "id": str(uuid.uuid4()),
                "excel_id": at,
                "client_id": client["id"],
                "treatment_id": treatment["id"],
                "treatment_excel_id": treatment["excel_id"],
                "client_excel_id": client["excel_id"],
                "name": text(record.get("name")) or client["name"],
                "installment": entry["installment"],
                "installments_total": None,
                "amount_due": figure,
                "amount_paid": figure if state == "paid" else None,
                "balance": None,
                "outstanding": (figure or 0) if state == "unpaid" else 0,
                "due_date": due_day,
                "paid_date": paid_day if state == "paid" else "",
                "mode": payment_mode(entry["mode"]),
                "mode_as_written": text(entry["mode"]),
                "state": state,
                "status_as_written": entry["status"],
                "payment_for": payment_for,
                "reference_no": entry["reference_no"],
                "bank": entry["bank"],
                "notes": entry["notes"],
                "tab": PAYMENTS,
                "flags": [],
            }
            if figure is None:
                _flag(payment, "unknown_state")
                data.note("unknown_state", PAYMENTS, at, f"{client['name']}: no Amount")
            elif state == "unknown":
                _flag(payment, "no_status")
                data.note("no_status", PAYMENTS, at, f"{client['name']}: Rs.{figure}, {entry['unread']}")
            if state == "paid" and not payment["mode"]:
                _flag(payment, "check_mode")
                data.note("check_mode", PAYMENTS, at, f"mode '{payment['mode_as_written'] or '(blank)'}'")
            if state == "paid" and not paid_day:
                _flag(payment, "no_date")
                data.note("no_date", PAYMENTS, at, client["name"])
            data.payments.append(payment)

    _add_totals(data)
    for client in data.clients:
        # _add_totals reads the newest course's status; this sheet says where the client stands.
        client["latest_status"] = client["current_stage"]
        client["sessions"].sort(key=lambda s: (s["course"], s["at"], s["session_no"] or 0))
        client["reviews"].sort(key=lambda r: (r["at"], r["review_no"] or 0))
        client["sessions_completed"] = sum(1 for s in client["sessions"] if s["status"] == "Completed")
        client["sessions_upcoming"] = sum(1 for s in client["sessions"] if s["status"] == "Upcoming")
        client["reviews_count"] = len(client["reviews"])
    data.types = ["lead"]
    if tabs.get(PHYSIO) or data.sessions_read or data.reviews_read:
        data.types.append("sessions")
    if data.payments:
        data.types.append("revenue")
    return data


def _client(record: dict, excel_id: str, data: PastData) -> Dict[str, Any]:
    written, looked_up, flags = phone(record.get("phone"))
    stage_written = text(record.get("current_stage"))
    stage = STAGE_BY_KEY.get(squash(stage_written), "")
    department = text(record.get("department"))
    journey = {
        key: reader(record.get(key))
        for key, reader in (
            ("lead_at", moment), ("rnr_date", day), ("follow_up_at", moment), ("booked_on", day),
            ("appointment_at", moment), ("rescheduled_to", moment), ("consultation_visit_date", day),
            ("diet_consultation_date", day), ("diet_chart_date", day), ("dropped_date", day),
        )
    }
    client = {
        "id": str(uuid.uuid4()),
        "excel_id": excel_id,
        "name": text(record.get("name")),
        "gender": _pick(GENDERS, record.get("gender")),
        "age": whole(record.get("age")),
        "phone": written,
        "phone_normalized": looked_up,
        "email": text(record.get("email")),
        "registration_date": day(record.get("lead_at")),
        "source": text(record.get("source")),
        "notes": text(record.get("notes")),
        "enquiries": [],
        "flags": list(flags),
        "shared_phone_with": [],
        # The OS lead's own fields, carried to the lead by Move to Live.
        "branch_as_written": text(record.get("branch")),
        "alternative_phone": text(record.get("alternative_phone")),
        "address": text(record.get("address")),
        "city": text(record.get("city")),
        "state": text(record.get("state")),
        "department": DEPARTMENTS.get(squash(department), ""),
        "department_as_written": department,
        "condition": text(record.get("condition")),
        "months_of_pain": whole(record.get("months_of_pain")),
        "occupation": text(record.get("occupation")),
        "current_stage": stage or "Leads",
        "current_stage_as_written": stage_written,
        "journey": {k: v for k, v in journey.items() if v},
        "consultant": text(record.get("consultant")),
        "dropped_reason": text(record.get("dropped_reason")),
        "sessions": [],
        "reviews": [],
    }
    if "check_phone" in flags:
        data.note("check_phone", LEADS, excel_id, f"{client['name']}: {written or '(blank)'}")
    if not stage:
        _flag(client, "unknown_stage")
        data.note("unknown_stage", LEADS, excel_id, f"{client['name']}: {stage_written or '(blank)'}")
    return client


def _shared_phones(data: PastData) -> None:
    """Several clients on one number -- a family, as in the register -- each flagged."""
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
        data.note("shared_phone", LEADS, ", ".join(c["excel_id"] for c in group),
                  f"{number}: " + " / ".join(c["name"] for c in group))


def _treatment(client: dict, excel_id: str, *, service: str, course: str, physio: str = "",
               start_date: str = "", end_date: str = "", status: str = "", package: str = "",
               recommended_sessions: Optional[int] = None, recommended_sessions_text: str = "",
               fee: Optional[float] = None, notes: str = "") -> Dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "excel_id": excel_id,
        "client_id": client["id"],
        "client_excel_id": client["excel_id"],
        "name": client["name"],
        "service": service,
        "service_as_written": package,
        "course": course,
        "mode": "online" if client["department"].startswith("online") else "offline",
        "physio": physio,
        "start_date": start_date,
        "end_date": end_date,
        "status": status,
        "recommended_sessions": recommended_sessions,
        "recommended_sessions_text": recommended_sessions_text,
        "fee": fee,
        "notes": notes,
        "sessions_completed": 0,
        "sessions_upcoming": 0,
        "flags": [],
    }


def _row_sessions(data: PastData, record: dict, where: str, who: str) -> List[Dict[str, Any]]:
    """The sessions one Sessions row holds, each {session_no, at, status, remarks}.

    A row is a client's course, one row however many days it ran: the days done listed in
    Completed Dates, the days still to come in Upcoming Dates (a day alone takes the month of
    the full date after it -- see dates()), each at the Session Time unless it was written
    with its own. Numbered later, in date order (past_data_live._days).
    A row laid out the first way -- Session No, Date & Time, Status -- is one session."""
    at_time = clock(record.get("time"))
    if text(record.get("time")) and not at_time:
        data.note("bad_session_time", SESSIONS, where, f"{who}: '{text(record.get('time'))}'")

    def timed(at: str) -> str:
        return f"{at} {at_time}" if at_time and len(at) == 10 else at

    found = []
    if any(text(record.get(k)) for k in ("session_no", "at", "status", "remarks")):
        found.append({
            "session_no": whole(record.get("session_no")),
            "at": timed(moment(record.get("at"))),
            "status": _status(data, SESSION_STATUSES, "unknown_session_status", SESSIONS, where,
                              who, record.get("status")),
            "remarks": text(record.get("remarks")),
        })
    seen = set()
    for key, status in (("completed_dates", "Completed"), ("upcoming_dates", "Upcoming")):
        read, unread = dates(record.get(key))
        for written in unread:
            data.note("bad_session_date", SESSIONS, where, f"{who}: '{written}'")
        for at in map(timed, read):
            # "6, 8, 6-10-2026": the full date is a session of its own, so a day written
            # before it as well is one session written twice.
            if at in seen:
                data.note("repeated_session_date", SESSIONS, where, f"{who}: {at}")
                continue
            seen.add(at)
            found.append({"session_no": None, "at": at, "status": status, "remarks": ""})
    if not found and not any(text(record.get(k)) for k in ("completed_dates", "upcoming_dates")):
        data.note("no_session_dates", SESSIONS, where, who)
    return found


def _row_payments(record: dict, where: str) -> List[Dict[str, Any]]:
    """The payments one Payments row holds, each with its own excel_id, what it was for, its
    amount (`figure`), its days, its mode, and `state` as _state reads it.

    A row is a client: the Consultation Fee, Paid on its Consultation Date, and each of the
    treatment fee's instalments -- Paid when it has a Paid Date, Pending when it has only a
    Due Date. One with no date is neither, and reported (`unread` says why), since a guess
    either way moves money. A row laid out the first way -- Payment For, Status, Amount --
    is one payment."""
    found = []
    if any(text(record.get(k)) for k in ("payment_for", "installment", "status", "amount", "paid_date",
                                           "due_date", "mode", "reference_no", "bank", "remarks")):
        status, figure = text(record.get("status")), amount(record.get("amount"))
        found.append({
            "excel_id": where, "payment_for": text(record.get("payment_for")),
            "installment": whole(record.get("installment")), "figure": figure,
            "paid_day": day(record.get("paid_date")), "due_day": day(record.get("due_date")),
            "mode": record.get("mode"), "state": _state(status, figure), "status": status,
            "unread": f"Status '{status or '(blank)'}'",
            "reference_no": text(record.get("reference_no")), "bank": text(record.get("bank")),
            "notes": text(record.get("remarks")),
        })
    parts = [(None, "consultation_fee", "consultation_date", None, "consultation_mode")]
    numbers = sorted({int(key.split("_")[1]) for key in record if key.startswith("instalment_")})
    parts += [(n, f"instalment_{n}_amount", f"instalment_{n}_paid_date", f"instalment_{n}_due_date",
               f"instalment_{n}_mode") for n in numbers]
    for n, fee, paid, due, mode in parts:
        cells = [record.get(key) if key else None for key in (fee, paid, due, mode)]
        if not any(text(c) for c in cells):
            continue
        paid_day, due_day = day(cells[1]), day(cells[2])
        state = "paid" if paid_day else "unpaid" if due_day else "unknown"
        label = "Consultation" if n is None else f"Instalment {n}"
        dates_written = " / ".join(text(c) for c in cells[1:3] if text(c))
        found.append({
            "excel_id": f"{where} · {label}",
            "payment_for": "Consultation Fee" if n is None else "Treatment Fee",
            "installment": n, "figure": amount(cells[0]), "paid_day": paid_day, "due_day": due_day,
            "mode": cells[3], "state": state, "status": {"paid": "Paid", "unpaid": "Pending"}.get(state, ""),
            "unread": f"{label}: no " + ("Consultation Date" if n is None else "Paid Date or Due Date")
                      + (f" that reads as a date ('{dates_written}')" if dates_written else ""),
            "reference_no": "", "bank": "", "notes": "",
        })
    return found


def _course_for(courses: List[Dict[str, Any]], when: str, kind: str = "") -> Optional[Dict[str, Any]]:
    """Which of a client's courses a session or a payment on `when` belongs to: of the
    courses of this kind (any, when `kind` is blank), the last to start on or before that
    day -- a renewal is a new Physio row, and what came after it is its -- or the first
    course when none had started by then, or the day is not known."""
    fitting = [t for t in courses if not kind or t["course"].lower() == kind.lower()]
    if not fitting:
        return None
    started = [t for t in fitting if t["start_date"] and when and t["start_date"] <= when]
    if started:
        return max(started, key=lambda t: t["start_date"])
    return min(fitting, key=lambda t: t["start_date"] or "9999-12-31")


def _state(status: str, figure: Optional[float]) -> str:
    """"paid" | "unpaid" | "cancelled" | "unknown", off Status alone. Unlike the register's
    payment_state, an amount with no Status is not taken to be paid: the template has the
    column for it, and a row left without says nothing either way."""
    label = squash(status)
    if label == "paid":
        return "paid"
    if label in ("pending", "unpaid", "due", "overdue", "duesoon", "partial"):
        return "unpaid"
    if label == "cancelled":
        return "cancelled"
    return "unknown"
