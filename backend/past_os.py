"""The OS Data workbook (OSDATAX.xlsx), read into the Past Data tables.

The third kind of sheet Settings > Import/Export reads, beside the register (past_data.py)
and the branches' monthly revenue sheets (past_revenue.py). Where those two are books the
clinic kept before the OS, this one was laid out on the OS's own fields, for the clients
still being treated: one workbook, five tabs, read at the same time in one upload --

  Leads     one row per client: who they are, and where they stand (Current Stage, one of
            the OS's own fifteen stage names, and the date of each step on the way there)
  Physio    one row per course: Treatment or Rehab, the package, its sessions and its price
  Sessions  one row per session: when, Completed or Upcoming, by which physio
  Reviews   one row per review, by the Head Physio
  Payments  one row per payment: Consultation Fee or Treatment Fee, Paid or Pending

-- so one sheet on the Import/Export list holds three kinds of data at once, which its Type
column shows as Lead, Sessions (the Physio, Sessions and Reviews tabs) and Revenue (the
Payments tab). Every tab but Leads may be missing, or empty.

Rows are tied to their client by Patient ID -- the first column of every tab -- and, where a
row has none, by phone and name, which is the register's own rule (same_person). A row that
names nobody on the Leads tab is left out and reported, never guessed onto somebody.

Into the same three tables the other two readers write: a client per Leads row (sessions and
reviews carried on the client, since nothing in the OS reads them from here but the client's
own card), a treatment per Physio row -- plus one "Consultation" for the consultation fees
-- and a payment per Payments row. Status is read as written: a Pending payment is owed, not
paid, and a payment with no Status is neither, since a guess either way moves money.

Nothing here touches a database -- see past_data.py.
"""
import re
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Optional

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
        "session_no": "Session No",
        "at": "Date & Time",
        "status": "Status",
        "physio": "Physio Name",
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

# Without these a tab cannot be read. The other tabs also need a Patient ID or a Phone column
# to tie a row to its client -- checked on its own, since either one will do.
REQUIRED = {
    LEADS: ("name", "phone", "current_stage"),
    PHYSIO: (),
    SESSIONS: (),
    REVIEWS: (),
    PAYMENTS: ("status", "amount"),
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

# What a desk types into a cell to say "nothing here".
BLANKS = {"-", "--", "—", "–", "na", "n/a", "nil", "none"}

CONSULTATION = "Consultation"
SAMPLE = re.compile(r"(?i)^sample\s")

MOMENT_FORMATS = (
    "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M",
    "%d-%m-%Y %I:%M %p", "%d/%m/%Y %I:%M %p", "%Y-%m-%d %H:%M:%S",
)


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


def _pick(table: Dict[str, str], value: Any) -> str:
    """A list value in the template's own spelling, or as written when it is not one."""
    written = text(value)
    return table.get(squash(written), written)


def _is_sample(record: dict) -> bool:
    return bool(SAMPLE.match(text(record.get("name"))))


# ---------------------------------------------------------------------------- the tabs

def _tab(workbook, name: str):
    """The worksheet whose title is `name`, however it is cased or spaced ("Reviews ")."""
    return next((ws for ws in workbook.worksheets if squash(ws.title) == squash(name)), None)


def _header(rows, columns: Dict[str, str]):
    """(the header row's index, field -> column) off the first row holding at least two of
    this tab's headers, or None."""
    wanted = {squash(h) for h in columns.values()}
    for at, row in enumerate(rows[:HEADER_SEARCH_ROWS]):
        cells = [squash(c) for c in (row or ())]
        if len(wanted & set(cells)) >= 2:
            position: Dict[str, int] = {}
            for i, cell in enumerate(cells):
                position.setdefault(cell, i)
            return at, {key: position.get(squash(header)) for key, header in columns.items()}
    return None


def detect(workbook) -> bool:
    """Whether this is the OS Data workbook: a Leads tab with Patient ID and Current Stage
    among its headers. Asked of every upload that is not the register."""
    ws = _tab(workbook, LEADS)
    if ws is None:
        return False
    for row in ws.iter_rows(min_row=1, max_row=HEADER_SEARCH_ROWS, values_only=True):
        if {"patientid", "currentstage"} <= {squash(c) for c in (row or ())}:
            return True
    return False


def _records(ws, tab: str) -> List[Dict[str, Any]]:
    """One tab's rows as {field: cell} dicts, each with its sheet row number under _row.
    Rows with nothing in them -- the template runs to row 1000 -- are passed over."""
    columns = COLUMNS[tab]
    rows = list(ws.iter_rows(values_only=True))
    found = _header(rows, columns)
    if not found:
        raise PastDataError(f"'{ws.title.strip()}': no header row in its first rows")
    at, where = found
    missing = [columns[key] for key in REQUIRED[tab] if where[key] is None]
    if tab != LEADS and where.get("client_excel_id") is None and where.get("phone") is None:
        missing.append("Patient ID (or Phone)")
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

    # -- clients, off the Leads tab
    by_excel: Dict[str, Dict[str, Any]] = {}
    sample_ids = set()
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
            continue
        if excel_id and excel_id in by_excel:
            data.note("duplicate_id", LEADS, excel_id, where)
            continue
        client = _client(record, excel_id or where, data)
        if not excel_id:
            _flag(client, "no_patient_id")
            data.note("no_patient_id", LEADS, where, name)
        by_excel[client["excel_id"]] = client
        data.clients.append(client)
    if not data.clients:
        raise PastDataError(
            "the Leads tab has no clients" + (" -- only the template's sample row" if sample_ids else "")
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
        course = _pick(COURSES, record.get("course")) or "Treatment"
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
        course = _pick(COURSES, record.get("course")) or "Treatment"
        at = moment(record.get("at"))
        session = {
            "course": course,
            "session_no": whole(record.get("session_no")),
            "at": at,
            "status": _pick(SESSION_STATUSES, record.get("status")),
            "physio": text(record.get("physio")),
            "remarks": text(record.get("remarks")),
            "row": where,
        }
        treatment = _course_for(courses.get(client["id"], []), at[:10], course)
        if treatment:
            session["treatment_excel_id"] = treatment["excel_id"]
            if session["status"] == "Completed":
                treatment["sessions_completed"] += 1
            elif session["status"] == "Upcoming":
                treatment["sessions_upcoming"] += 1
        else:
            _flag(client, "session_no_course")
            data.note("session_no_course", SESSIONS, where, f"{client['name']}: {course}")
        client["sessions"].append(session)
        data.sessions_read += 1

    for record in tabs.get(REVIEWS, []):
        where = f"{REVIEWS} · row {record['_row']}"
        client = owner(record, REVIEWS, where)
        if not client:
            continue
        client["reviews"].append({
            "review_no": whole(record.get("review_no")),
            "at": moment(record.get("at")),
            "head_physio": text(record.get("head_physio")),
            "status": _pick(REVIEW_STATUSES, record.get("status")),
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
        payment_for = text(record.get("payment_for"))
        status = text(record.get("status"))
        figure = amount(record.get("amount"))
        paid_day, due_day = day(record.get("paid_date")), day(record.get("due_date"))
        state = _state(status, figure)

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
                    data.note("payment_no_course", PAYMENTS, where, client["name"])
                    placeholders[client["id"]] = treatment
                    data.treatments.append(treatment)

        payment = {
            "id": str(uuid.uuid4()),
            "excel_id": where,
            "client_id": client["id"],
            "treatment_id": treatment["id"],
            "treatment_excel_id": treatment["excel_id"],
            "client_excel_id": client["excel_id"],
            "name": text(record.get("name")) or client["name"],
            "installment": whole(record.get("installment")),
            "installments_total": None,
            "amount_due": figure,
            "amount_paid": figure if state == "paid" else None,
            "balance": None,
            "outstanding": (figure or 0) if state == "unpaid" else 0,
            "due_date": due_day,
            "paid_date": paid_day if state == "paid" else "",
            "mode": payment_mode(record.get("mode")),
            "mode_as_written": text(record.get("mode")),
            "state": state,
            "status_as_written": status,
            "payment_for": payment_for,
            "reference_no": text(record.get("reference_no")),
            "bank": text(record.get("bank")),
            "notes": text(record.get("remarks")),
            "tab": PAYMENTS,
            "flags": [],
        }
        if figure is None:
            _flag(payment, "unknown_state")
            data.note("unknown_state", PAYMENTS, where, f"{client['name']}: no Amount")
        elif state == "unknown":
            _flag(payment, "no_status")
            data.note("no_status", PAYMENTS, where, f"{client['name']}: Rs.{figure}, Status '{status or '(blank)'}'")
        if state == "paid" and not payment["mode"]:
            _flag(payment, "check_mode")
            data.note("check_mode", PAYMENTS, where, f"mode '{payment['mode_as_written'] or '(blank)'}'")
        if state == "paid" and not paid_day:
            _flag(payment, "no_date")
            data.note("no_date", PAYMENTS, where, client["name"])
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
