"""Any other sheet: a list of people, read into Past Data column by column, as picked.

The fourth kind of sheet Settings > Import/Export reads. The register, a branch's revenue
sheet and the OS Data workbook are laid out the way their own readers expect; everything else
-- a camp's list, a corporate tie-up's, a sheet a branch made for itself -- is read here, after
Auto Scan (past_scan.py) has shown its tabs and headers and each column has been turned on or
off and given an OS field.

One row is one person. Their columns go onto the client by the field each was given -- Name,
Phone, City... -- and a column given none is kept as written, under its own header, as an
extra detail, which the lead popup lists once the sheet is moved to live. Nothing more is made
of the sheet: it has no courses and no payments, so neither has a client from it, and Move to
live puts them on the stage their Current Stage column names, or at Leads.

The same person on two rows -- two tabs of one file, or one tab twice -- is one client when
the phone numbers are one and the names one person's (past_revenue._one_person), the details
filled in from both. One number under two names is two people, flagged shared_phone, as in
the other sheets.

Nothing here touches a database -- see past_data.py.
"""
import uuid
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

import past_os
import past_scan
from past_data import PastData, PastDataError, _add_totals, _flag, day, phone, squash, text, whole
from past_revenue import _one_person

GENDERS = {"male": "Male", "m": "Male", "female": "Female", "f": "Female", "other": "Other"}
TEXT_FIELDS = ("email", "alternative_phone", "address", "location", "city", "state", "occupation",
               "condition", "source", "notes", "status")
# What a later row of the same person fills in where the first left it blank.
MERGED = TEXT_FIELDS + ("name", "gender", "age", "dob", "months_of_pain", "registration_date", "department",
                        "department_as_written", "current_stage", "current_stage_as_written")

NO_ONE = ("it is neither the register, the OS Data workbook nor a revenue sheet, and no tab has a "
          "Name or Phone column to read people from")


def read(book, picks: Optional[Dict[str, dict]] = None, today: Optional[date] = None) -> PastData:
    """The tabs picked, as PastData. `picks` is {tab: {"at": header row index, "fields":
    {column: field, or "" to keep it as an extra detail}}}; left out, every tab is read as
    Auto Scan first shows it (past_scan.suggested_picks) -- the terminal tool's way in."""
    if picks is None:
        picks = past_scan.suggested_picks(book)
    tabs = []
    for ws in book.worksheets:
        pick = picks.get(ws.title)
        if not pick:
            continue
        rows, at, fields = ws.rows, pick["at"], pick["fields"]
        header = rows[at]
        # Two columns under one header, both kept as extras, are told apart by their letter.
        labels: Dict[int, str] = {}
        for i in sorted(fields):
            if not fields[i]:
                label = past_scan.column_label(header, i)
                if label in labels.values():
                    label = f"{label} ({past_scan._letter(i)})"
                labels[i] = label
        records = []
        for number, row in enumerate(rows[at + 1:], start=at + 2):
            cells = {i: past_scan._cell(row, i) for i in fields}
            if not any(text(v) for v in cells.values()):
                continue
            records.append({
                "fields": {field: cells[i] for i, field in fields.items() if field},
                "extra": {labels[i]: cells[i] for i in labels},
                "_row": number,
            })
        tabs.append((ws.title, records))
    if not tabs:
        raise PastDataError(NO_ONE)
    return build(tabs, today=today)


def build(tabs: List[Tuple[str, List[Dict[str, Any]]]], data: Optional[PastData] = None,
          today: Optional[date] = None) -> PastData:
    """The tabs' rows as clients. Separate from read() so it can be tested on plain dicts:
    each record is {"fields": {field: cell}, "extra": {header: cell}, "_row": n}, with every
    field the tab gave a column in `fields`, blank or not."""
    data = data or PastData()
    data.layout = past_scan.CUSTOM
    data.types = ["lead"]
    data.tabs = [tab for tab, _ in tabs]
    data.tab_rows = {tab: len(records) for tab, records in tabs}
    today = today or date.today()
    by_number: Dict[str, List[Dict[str, Any]]] = {}

    for tab, records in tabs:
        for record in records:
            where = f"{tab} · row {record['_row']}"
            values = record["fields"]
            if not text(values.get("name")) and not text(values.get("phone")):
                shown = [text(v) for v in list(values.values()) + list(record["extra"].values()) if text(v)]
                data.note("no_name_row", tab, where, " · ".join(shown[:3]))
                continue
            client = _client(values, record["extra"], where, tab, data, today)
            key = client["phone_normalized"]
            twin = next(
                (c for c in by_number.get(key, [])
                 if not c["name"] or not client["name"] or _one_person(c["name"], client["name"])),
                None,
            ) if key else None
            if twin:
                _merge(twin, client)
                data.note("merged_rows", tab, twin["excel_id"], f"{twin['name'] or twin['phone']}: also {where}")
                continue
            if key:
                by_number.setdefault(key, []).append(client)
            data.clients.append(client)

    if not data.clients:
        raise PastDataError("no row in the tabs picked has a Name or a Phone")
    for number, group in by_number.items():
        if len(group) < 2:
            continue
        for client in group:
            _flag(client, "shared_phone")
            client["shared_phone_with"] = [c["excel_id"] for c in group if c is not client]
        data.note("shared_phone", group[0]["tab"], ", ".join(c["excel_id"] for c in group),
                  f"{number}: " + " / ".join(c["name"] for c in group))

    _add_totals(data)
    for client in data.clients:
        # No courses to read it off (_add_totals leaves it blank): the sheet's own Status.
        client["latest_status"] = client["status"]
    return data


def _age(born: str, today: date) -> Optional[int]:
    try:
        b = date.fromisoformat(born)
    except ValueError:
        return None
    years = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
    return years if 0 <= years < 120 else None


def _client(values: Dict[str, Any], extra: Dict[str, Any], where: str, tab: str, data: PastData,
            today: date) -> Dict[str, Any]:
    # A phone is only checked where the tab has a Phone column: a list of names and emails is
    # not a list of bad numbers.
    written, looked_up, flags = phone(values.get("phone")) if "phone" in values else ("", "", [])
    dob = day(values.get("dob"))
    age = whole(values.get("age"))
    gender = text(values.get("gender"))
    department = text(values.get("department"))
    stage_written = text(values.get("current_stage"))
    stage = past_os.STAGE_BY_KEY.get(squash(stage_written), "")
    client = {
        "id": str(uuid.uuid4()),
        "excel_id": where,
        "name": text(values.get("name")),
        "gender": GENDERS.get(squash(gender), gender),
        "age": age if age is not None else (_age(dob, today) if dob else None),
        "dob": dob,
        "phone": written,
        "phone_normalized": looked_up,
        "registration_date": day(values.get("registration_date")),
        "enquiries": [],
        "flags": list(flags),
        "shared_phone_with": [],
        **{key: text(values.get(key)) for key in TEXT_FIELDS},
        "months_of_pain": whole(values.get("months_of_pain")),
        "department": past_os.DEPARTMENTS.get(squash(department), ""),
        "department_as_written": department,
        # Blank unless the sheet names one of the OS's stages: Move to live then reads Status
        # the way it reads the register's, and puts everybody else at Leads.
        "current_stage": stage,
        "current_stage_as_written": stage_written,
        "extra": {label: text(value) for label, value in extra.items() if text(value)},
        "tab": tab,
    }
    if "check_phone" in flags:
        data.note("check_phone", tab, where, f"{client['name'] or '(no name)'}: {written or '(blank)'}")
    if stage_written and not stage:
        _flag(client, "unknown_stage")
        data.note("unknown_stage", tab, where, f"{client['name']}: {stage_written}")
    return client


def _merge(into: Dict[str, Any], other: Dict[str, Any]) -> None:
    for key in MERGED:
        if other.get(key) and not into.get(key):
            into[key] = other[key]
    if other["registration_date"] and other["registration_date"] < into["registration_date"]:
        into["registration_date"] = other["registration_date"]
    for label, value in other["extra"].items():
        into["extra"].setdefault(label, value)
    for code in other["flags"]:
        _flag(into, code)
