"""Past Data: the clinic's books from before the OS, read-only.

Put in by uploading the Excel sheets the clinic kept before it moved onto the OS -- the
register (past_data.py), the branches' monthly revenue sheets (past_revenue.py), and the OS
Data workbook laid out on the OS's own fields, its Leads, Physio, Sessions, Reviews and
Payments tabs read in one go (past_os.py) -- one sheet per upload, each one its own import
(see "the import" below; tools/past_data_import.py does the same from a terminal). Three collections of its own -- past_clients,
past_treatments, past_payments -- plus past_imports, one row per sheet.

Read-only on purpose, and apart from `leads` on purpose. These are courses that finished,
or were dropped, or were still running on the day the workbook was last saved, and the
money on them was collected into books that are already closed. Nothing here is a lead to
work, a session to book or a balance to collect: a patient from this register who comes
back arrives as a new enquiry like anybody else, and this is where their history is read.
Kept out of `leads` so that no board, dashboard or finance figure that reads leads -- and
none of them scope by branch -- can count a row of it.

The one way out of these tables is Move to live, and it goes no further than the branch the
sheet sits on: a sheet's clients put on that branch's Branch Leads as live leads, to see how
the old books read as the OS's own, and taken back off again with one button. Those leads
carry the move's id and every org-wide read of `leads` leaves them out -- see
past_data_live.py.

Managed from one place, Super Admin's Settings > Import/Export (PastDataImportExport.jsx);
no branch board has a tab for it, and no Branch Admin reaches any of it. The two org-wide
desks may read any branch's sheets; only Super Admin adds, connects, moves and disconnects.
"""
import asyncio
import hashlib
import io
import re
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

import past_data
import past_data_live
import past_data_store
from database import v3_col
from deps import ORG_WIDE_ROLES, v3_require_roles
from past_data import match_key
from schemas.v3 import V3UserOut
from utils import live_branch_query

router = APIRouter(prefix="/api/v3")

PAST_DATA_ROLES = tuple(sorted(ORG_WIDE_ROLES))

# Adding and disconnecting sheets: Super Admin alone. Not the business desk, which reads
# them, and no Branch Admin -- the Past Data Entry login included: see _may_manage.
SUPER_ADMIN = "super_admin"

# The register is under a megabyte. Ten times that is room for it to grow and still far
# short of anything a person would upload by mistake and expect to be read.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
EXAMPLES_PER_FINDING = 8
MAX_SHEETS = 200


def _is_super_admin(user: V3UserOut) -> bool:
    return (user.role or "").strip().lower() == SUPER_ADMIN


async def _home_branch_id() -> Optional[str]:
    """Where sheets are added: the Past Data branch (see past_data_store.home_branch_id)."""
    return await past_data_store.home_branch_id(v3_col)


async def _may_manage(user: V3UserOut, branch_id: Optional[str]) -> bool:
    """Whether this caller may add sheets to, and disconnect them from, this branch: Super
    Admin, on a branch that exists. Once a Branch Admin of the Past Data branch did too, from
    a Past Data tab on that branch's board; the tab is gone, and the access with it."""
    return bool(branch_id) and _is_super_admin(user)


def _branch_for(user: V3UserOut, branch_id: Optional[str]) -> Optional[str]:
    """The branch to read past data for: the one asked for, or every branch when none was.
    Only the org-wide desks get this far (PAST_DATA_ROLES)."""
    return branch_id or None

PAGE_SIZE_MAX = 200

# What the list can be ordered by, and the (field, direction) pairs behind each. The
# client's own excel_id breaks every tie, so paging through a sort never shows one row twice.
SORTS = {
    "recent": [("last_treatment_date", -1), ("registration_date", -1), ("excel_id", 1)],
    "name": [("name", 1), ("excel_id", 1)],
    "owing": [("outstanding_total", -1), ("excel_id", 1)],
    "paid": [("paid_total", -1), ("excel_id", 1)],
    "id": [("excel_id", 1)],
}

LIST_FIELDS = {
    "_id": 0, "id": 1, "excel_id": 1, "name": 1, "phone": 1, "gender": 1, "age": 1,
    "registration_date": 1, "treatments_count": 1, "services": 1, "last_treatment_date": 1,
    "latest_status": 1, "paid_total": 1, "outstanding_total": 1, "issue_count": 1, "flags": 1,
    "branch_id": 1, "batch_id": 1,
}


async def _live_batches(branch_id: Optional[str] = None) -> list:
    """The imports that have not been taken back out, newest first -- one branch's, or
    every branch's when none is named.

    Every read below is scoped to these. --remove deletes a batch's rows outright, so this
    only matters for the moment between a --replace writing its new batch and removing the
    old one -- when both are on disk, and an unscoped list would show every client twice.
    A batch whose write failed half way never gets a log row, so it is never read either.
    """
    query = {"removed_at": None}
    if branch_id:
        query["branch_id"] = branch_id
    return await v3_col("past_imports").find(query, {"_id": 0}).sort("imported_at", -1).to_list(MAX_SHEETS)


PATIENT_ID = re.compile(r"(?i)^pat\s*-?\s*(\d+)$")
PHONE_ONLY = re.compile(r"^[\d\s+()-]+$")


def _search(q: str) -> dict:
    """A name, a phone number or a Patient ID, whichever was typed.

    A Patient ID finds that client and nobody else, however it is padded or cased -- "pat-123",
    "PAT-0123". Read as loose text, the "123" in it also matched every phone number holding
    those three digits, and the one client asked for sank under them.

    A box holding only a number searches phones: the number as written as well as its
    ten-digit key, so "98402" finds 9840250617 and one written "9578141888-1" is found by
    its own digits. Anything else searches names. All of it is matched as literal text -- a
    "(" typed into the box is a character to find, not regex syntax.
    """
    q = (q or "").strip()
    if not q:
        return {}
    as_id = PATIENT_ID.match(q)
    if as_id:
        return {"excel_id": {"$regex": f"^PAT-0*{int(as_id.group(1))}$", "$options": "i"}}
    # match_key: the digits, with a +91 or a family "-1" taken off the end the way the
    # import read them, so "9578141888-1" finds the family by the number they share.
    digits = match_key(q)
    if PHONE_ONLY.match(q) and len(digits) >= 3:
        return {"$or": [
            {"phone": {"$regex": re.escape(digits)}},
            {"phone_normalized": {"$regex": re.escape(digits)}},
        ]}
    return {"name": {"$regex": re.escape(q), "$options": "i"}}


@router.get("/past-data/summary")
async def past_data_summary(
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES)),
):
    """The figures the Past Data screen leads with, and where the data came from.

    Counted off the rows rather than read off the import log, so the tiles and the list
    under them can never disagree about how many clients there are.
    """
    scoped_branch = _branch_for(user, branch_id)
    batches = await _live_batches(scoped_branch)
    batch_ids = [b["id"] for b in batches]
    # Whether Add sheet and Disconnect belong on this screen (see _may_manage). Adding also
    # needs no other branch to hold the old books already (_import_blocker).
    can_manage = bool(scoped_branch and await _may_manage(user, scoped_branch))
    can_add = bool(can_manage and not await _import_blocker(scoped_branch))
    if not batch_ids:
        return {"imported": False, "can_manage": can_manage, "can_add": can_add, "imports": [], "clients": 0, "treatments": 0,
                "payments": 0, "paid_total": 0, "outstanding_total": 0, "owing_clients": 0,
                "needs_look_clients": 0, "services": [], "statuses": [], "first_date": "", "last_date": ""}

    scope = {"batch_id": {"$in": batch_ids}}
    clients = await v3_col("past_clients").find(
        scope, {"_id": 0, "paid_total": 1, "outstanding_total": 1, "issue_count": 1,
                "registration_date": 1, "latest_status": 1},
    ).to_list(100000)
    services: dict = {}
    for row in await v3_col("past_treatments").find(scope, {"_id": 0, "service": 1}).to_list(100000):
        name = row.get("service") or ""
        if name:
            services[name] = services.get(name, 0) + 1
    statuses: dict = {}
    for c in clients:
        label = c.get("latest_status") or ""
        if label:
            statuses[label] = statuses.get(label, 0) + 1
    dates = sorted(c["registration_date"] for c in clients if c.get("registration_date"))

    branch_ids = list({b.get("branch_id") for b in batches if b.get("branch_id")})
    names = {
        b["id"]: b.get("branch_name", "")
        for b in await v3_col("branches").find({"id": {"$in": branch_ids}}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(50)
    }
    return {
        "imported": True,
        "can_manage": can_manage,
        "can_add": can_add,
        # The sheets, newest first -- each shown with its own Disconnect.
        "imports": [{**_sheet(b), "branch_name": names.get(b.get("branch_id"), "")} for b in batches],
        "clients": len(clients),
        "treatments": await v3_col("past_treatments").count_documents(scope),
        "payments": await v3_col("past_payments").count_documents(scope),
        "paid_total": sum(c.get("paid_total") or 0 for c in clients),
        "outstanding_total": sum(c.get("outstanding_total") or 0 for c in clients),
        "owing_clients": sum(1 for c in clients if (c.get("outstanding_total") or 0) > 0),
        "needs_look_clients": sum(1 for c in clients if (c.get("issue_count") or 0) > 0),
        "services": sorted(({"name": k, "count": v} for k, v in services.items()), key=lambda s: -s["count"]),
        "statuses": sorted(({"name": k, "count": v} for k, v in statuses.items()), key=lambda s: -s["count"]),
        "first_date": dates[0] if dates else "",
        "last_date": dates[-1] if dates else "",
    }


@router.get("/past-data/clients")
async def past_data_clients(
    branch_id: Optional[str] = None,
    q: str = "",
    service: str = "",
    status: str = "",
    # "owing" | "needs_look" -- the two tiles above the list that act as its filter.
    show: str = "",
    # One sheet's clients only: an import id from summary's `imports`.
    sheet: str = "",
    sort: str = "recent",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=PAGE_SIZE_MAX),
    user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES)),
):
    batch_ids = [b["id"] for b in await _live_batches(_branch_for(user, branch_id))]
    if sheet:
        batch_ids = [b for b in batch_ids if b == sheet]
    if not batch_ids:
        return {"total": 0, "page": page, "page_size": page_size, "rows": []}

    query: dict = {"batch_id": {"$in": batch_ids}, **_search(q)}
    if service:
        query["services"] = service
    if status:
        query["latest_status"] = status
    if show == "owing":
        query["outstanding_total"] = {"$gt": 0}
    elif show == "needs_look":
        query["issue_count"] = {"$gt": 0}

    total = await v3_col("past_clients").count_documents(query)
    rows = await v3_col("past_clients").find(query, LIST_FIELDS).sort(
        SORTS.get(sort, SORTS["recent"])
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"total": total, "page": page, "page_size": page_size, "rows": rows}


@router.get("/past-data/clients/{client_id}")
async def past_data_client(client_id: str, user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES))):
    """One past client whole: who they were, what they enquired about, every course, and
    every installment under the course it was paid against."""
    client = await v3_col("past_clients").find_one({"id": client_id}, {"_id": 0})
    if not client:
        raise HTTPException(status_code=404, detail="Past client not found")

    treatments = await v3_col("past_treatments").find(
        {"client_id": client_id, "batch_id": client.get("batch_id")}, {"_id": 0},
    ).sort([("start_date", -1), ("excel_id", -1)]).to_list(200)
    payments = await v3_col("past_payments").find(
        {"client_id": client_id, "batch_id": client.get("batch_id")}, {"_id": 0},
    ).sort([("installment", 1), ("due_date", 1), ("excel_id", 1)]).to_list(2000)
    by_treatment: dict = {}
    for p in payments:
        by_treatment.setdefault(p["treatment_id"], []).append(p)
    for t in treatments:
        t["payments"] = by_treatment.get(t["id"], [])

    # The others on this phone number, by name, so the screen can say who and open them.
    shared = []
    if client.get("shared_phone_with"):
        shared = await v3_col("past_clients").find(
            {"excel_id": {"$in": client["shared_phone_with"]}, "batch_id": client.get("batch_id")},
            {"_id": 0, "id": 1, "excel_id": 1, "name": 1},
        ).to_list(20)

    branch = await v3_col("branches").find_one({"id": client.get("branch_id")}, {"_id": 0, "branch_name": 1}) or {}
    batch = await v3_col("past_imports").find_one({"id": client.get("batch_id")}, {"_id": 0}) or {}
    return {
        **client,
        "branch_name": branch.get("branch_name", ""),
        "sheet_label": past_data_store.sheet_label(batch) if batch else "",
        "shared_phone_clients": shared,
        "treatments": treatments,
    }


# --------------------------------------------------------------------------- the import
#
# The same import tools/past_data_import.py runs from a terminal, from a button: the server
# this runs on is reached only through a browser console that cannot take a file, so the
# workbook comes up the way every other upload in the OS does. Two steps, like the tool's
# dry run and --apply -- /preview reads the file and writes nothing, and /import writes it
# only once the person has read what /preview said. The file is read in memory and never
# stored: it is the clinic's patient list, and a copy left on disk is one more to lose.
#
# Each upload is a sheet of its own on the branch -- the register, a branch's revenue sheet,
# another branch's -- listed on the tab with its own Disconnect. Uploading one that is already
# there is caught at /preview: the very same file is refused, and one holding mostly the same
# people (the register saved again under another name) is offered as a replacement for the
# sheet it repeats rather than a second copy of everyone.


def _sheet(batch: dict) -> dict:
    """One import as the tab lists it."""
    return {
        "id": batch["id"],
        "branch_id": batch.get("branch_id"),
        "label": past_data_store.sheet_label(batch),
        "layout": batch.get("layout") or "register",
        "tabs": batch.get("tabs") or [],
        # An OS Data sheet's kinds of data -- "lead", "sessions", "revenue"; the other two
        # layouts are one kind each, read off `layout`.
        "types": batch.get("types") or [],
        "sessions_count": batch.get("sessions_count", 0),
        "reviews_count": batch.get("reviews_count", 0),
        "source_file": batch.get("source_file", ""),
        "imported_at": batch.get("imported_at", ""),
        "imported_by": batch.get("imported_by", ""),
        "counts": batch.get("counts", {}),
        "paid_total": batch.get("paid_total", 0),
        # Set while the sheet's clients are on the branch as live leads (Move to live).
        "live_move": batch.get("live_move") or None,
    }


async def _import_blocker(branch_id: str) -> str:
    """Why this branch may not take a sheet, or "" when it may: sheets are added on the Past
    Data branch only, and connected to other branches from Settings > Import/Export after."""
    home = await _home_branch_id()
    if not home or home == branch_id:
        return ""
    branch = await v3_col("branches").find_one({"id": home}, {"_id": 0, "branch_name": 1}) or {}
    return f"Past data sheets are added on {branch.get('branch_name') or 'the Past Data branch'}"


async def _read_upload(file: UploadFile):
    """The upload as (bytes, sha256, PastData), or a 400 saying plainly what is wrong."""
    name = (file.filename or "").lower()
    if not name.endswith((".xlsm", ".xlsx")):
        raise HTTPException(status_code=400, detail="Choose an Excel sheet (.xlsm or .xlsx)")
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That file is larger than 10 MB -- it is not one of the clinic's sheets")
    try:
        # openpyxl is a second of CPU for the real register; off the event loop so the rest of
        # the OS is not held up behind it.
        data = await asyncio.to_thread(past_data.read_workbook, io.BytesIO(raw))
    except past_data.PastDataError as e:
        raise HTTPException(status_code=400, detail=f"This sheet cannot be read: {e}")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read this file as an Excel workbook")
    return raw, hashlib.sha256(raw).hexdigest(), data


async def _manage_branch(user: V3UserOut, branch_id: str) -> dict:
    """The branch a sheet is being added to, once this caller may add one there."""
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1, "code": 1, "branch_name": 1})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    if not await _may_manage(user, branch_id):
        raise HTTPException(status_code=403, detail="Only Super Admin adds past data sheets")
    blocked = await _import_blocker(branch_id)
    if blocked:
        raise HTTPException(status_code=409, detail=blocked)
    return branch


async def _overlaps(data: past_data.PastData, existing: list) -> list:
    """The sheets already here that hold some of the same people, by phone number.

    `same_people` where it is most of them: the same book saved again, or an older copy of
    it -- which the screen offers to replace rather than add beside, since added it shows
    everyone twice. A few shared numbers is patients who came back, and is only said.
    """
    new = {c["phone_normalized"] for c in data.clients if c.get("phone_normalized")}
    found = []
    for batch in existing if new else []:
        old = {p for p in await v3_col("past_clients").distinct("phone_normalized", {"batch_id": batch["id"]}) if p}
        matched = len(new & old)
        if matched:
            found.append({**_sheet(batch), "matched": matched, "of": len(new), "same_people": matched * 2 >= len(new)})
    return sorted(found, key=lambda o: -o["matched"])


def _report(data: past_data.PastData) -> dict:
    """What the terminal tool prints, as data: the figures, then each finding with a few
    examples and the whole list for the CSV the screen offers."""
    s = past_data.summary(data)
    by_code: dict = {}
    for f in data.findings:
        by_code.setdefault(f.code, []).append(f)
    findings = [
        {
            "code": code,
            "meaning": past_data.FINDINGS[code],
            "imported": code not in past_data.NOT_IMPORTED,
            "count": len(by_code[code]),
            "examples": [{"sheet": f.sheet, "excel_id": f.excel_id, "detail": f.detail} for f in by_code[code][:EXAMPLES_PER_FINDING]],
        }
        for code in past_data.FINDINGS if code in by_code
    ]
    return {
        **s,
        "paid_total": sum(c["paid_total"] for c in data.clients),
        "outstanding_total": sum(c["outstanding_total"] for c in data.clients),
        "finding_groups": findings,
        "all_findings": [
            {"code": f.code, "meaning": past_data.FINDINGS.get(f.code, ""), "sheet": f.sheet,
             "excel_id": f.excel_id, "detail": f.detail, "imported": f.code not in past_data.NOT_IMPORTED}
            for f in data.findings
        ],
    }


@router.post("/past-data/import/preview")
async def past_data_import_preview(
    branch_id: str = Form(...),
    file: UploadFile = File(...),
    user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES)),
):
    """Read the sheet and say what adding it would do. Writes nothing."""
    branch = await _manage_branch(user, branch_id)
    _, sha, data = await _read_upload(file)
    # Every branch's sheets, not only this one's: a sheet connected elsewhere from Settings
    # is still the same file and the same people.
    existing = await past_data_store.live_imports(v3_col)
    same_file = next((b for b in existing if b.get("file_sha256") == sha), None)
    return {
        "file_name": file.filename,
        "sha256": sha,
        "suggested_label": past_data_store.file_label(file.filename or ""),
        "branch": {"id": branch["id"], "name": branch.get("branch_name", "")},
        "existing": [_sheet(b) for b in existing],
        # This very file is a sheet here already: adding it again would only show it twice.
        "same_file": _sheet(same_file) if same_file else None,
        "overlaps": await _overlaps(data, existing),
        "report": _report(data),
    }


@router.post("/past-data/import")
async def past_data_import(
    branch_id: str = Form(...),
    # The sha256 /preview returned. The file is sent again rather than held on the server
    # between the two calls, so this is what proves it is the file the person just read the
    # report for, and not another one picked in between.
    sha256: str = Form(...),
    # What the tab calls the sheet; the file's name when blank.
    label: str = Form(""),
    # A sheet on this branch to swap for this one -- taken out once this one is fully written,
    # never before. Blank adds this as a sheet of its own.
    replace_id: str = Form(""),
    file: UploadFile = File(...),
    user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES)),
):
    """Add the sheet to this branch's Past Data, or put it in place of one already there."""
    branch = await _manage_branch(user, branch_id)
    _, sha, data = await _read_upload(file)
    if sha != sha256:
        raise HTTPException(status_code=409, detail="This is not the file that was checked -- check it again before importing")
    existing = await past_data_store.live_imports(v3_col)
    replacing = None
    if replace_id:
        replacing = next((b for b in existing if b["id"] == replace_id), None)
        if not replacing:
            raise HTTPException(status_code=404, detail="The sheet to replace is not connected any more")
        if replacing.get("branch_id") != branch_id and not _is_super_admin(user):
            raise HTTPException(status_code=403, detail="Only Super Admin replaces a sheet on another branch")
    same_file = next((b for b in existing if b.get("file_sha256") == sha), None)
    if same_file and same_file is not replacing:
        raise HTTPException(status_code=409, detail=f"This file is already here as {past_data_store.sheet_label(same_file)}")

    batch_id = await past_data_store.write_batch(
        v3_col, data, branch, file.filename or "", sha, imported_by=user.full_name, label=label,
    )
    removed = 0
    if replacing:
        # The new copy takes the old one's branch, or its having none.
        if replacing.get("branch_id") != branch["id"]:
            target = None
            if replacing.get("branch_id"):
                target = await v3_col("branches").find_one(
                    {"id": replacing["branch_id"]}, {"_id": 0, "id": 1, "code": 1, "branch_name": 1})
            await past_data_store.set_branch(v3_col, batch_id, target)
        # Its live clients go with it: they are the old copy's, and the new one is moved
        # afresh once it has been read.
        if replacing.get("live_move"):
            await past_data_live.take_back(replacing, user.full_name)
        removed = sum((await past_data_store.remove_batch(v3_col, replacing["id"], removed_by=user.full_name)).values())
    return {
        "batch_id": batch_id,
        "counts": {"past_clients": len(data.clients), "past_treatments": len(data.treatments), "past_payments": len(data.payments)},
        "replaced": [replacing["id"]] if replacing else [],
        "removed_rows": removed,
    }


@router.delete("/past-data/imports/{batch_id}")
async def past_data_disconnect(batch_id: str, user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES))):
    """Disconnect one sheet: take it back out of its branch, rows and all -- the terminal
    tool's --remove, from a button. The branch's other sheets are not touched.

    The rows are deleted, not hidden: they are the clinic's patient list, and a copy the
    screen no longer shows is one more to lose. The Excel file is untouched, so adding it
    again puts it back. The log row stays, marked removed_at/removed_by, as the record that it
    was here and who took it out. Nothing live read these tables, so nothing live changes --
    except a sheet moved to live, whose clients on the branch's Branch Leads go with it.
    """
    batch = await v3_col("past_imports").find_one({"id": batch_id, "removed_at": None}, {"_id": 0})
    if not batch:
        raise HTTPException(status_code=404, detail="That sheet is not connected any more")
    if not (_is_super_admin(user) or await _may_manage(user, batch.get("branch_id"))):
        raise HTTPException(status_code=403, detail="Only Super Admin disconnects past data sheets")
    taken_back = await past_data_live.take_back(batch, user.full_name) if batch.get("live_move") else 0
    removed = await past_data_store.remove_batch(v3_col, batch_id, removed_by=user.full_name)
    return {"removed_batch": batch_id, "label": past_data_store.sheet_label(batch), "removed": removed, "removed_leads": taken_back}


# --------------------------------------------------------------------------- move to live
#
# A sheet's clients tried out as the OS's own: put on this branch's Branch Leads as live
# leads, to see how the old books read there before anything goes to a working branch. See
# past_data_live.py for what is written and why nothing outside this branch can count it.
# Asked the same way as the import -- GET says what it would do and writes nothing, POST
# does it -- and taken back with DELETE, which removes exactly those leads.


async def _managed_sheet(user: V3UserOut, batch_id: str) -> dict:
    batch = await v3_col("past_imports").find_one({"id": batch_id, "removed_at": None}, {"_id": 0})
    if not batch:
        raise HTTPException(status_code=404, detail="That sheet is not connected any more")
    if not batch.get("branch_id"):
        raise HTTPException(status_code=409, detail="Select a branch for this sheet first")
    if not await _may_manage(user, batch.get("branch_id")):
        raise HTTPException(status_code=403, detail="Only Super Admin moves past data to live")
    return batch


@router.get("/past-data/imports/{batch_id}/move")
async def past_data_move_preview(batch_id: str, user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES))):
    """What Move to live would do with this sheet. Writes nothing."""
    batch = await _managed_sheet(user, batch_id)
    branch = await v3_col("branches").find_one({"id": batch.get("branch_id")}, {"_id": 0, "branch_name": 1}) or {}
    out = {"sheet": _sheet(batch), "branch_name": branch.get("branch_name", "")}
    if batch.get("live_move"):
        return {**out, "moved": True}
    p = await past_data_live.plan(batch)
    return {
        **out,
        "moved": False,
        "clients": len(p["clients"]) + len(p["skipped"]),
        "adding": len(p["clients"]),
        "skipped": len(p["skipped"]),
        "skipped_names": [c.get("name") or c.get("excel_id") for c in p["skipped"][:EXAMPLES_PER_FINDING]],
        "live_elsewhere": p["live_elsewhere"],
        # Where they go: each stage the sheet puts people at, the pill it is read under, and
        # how many -- past_data_live.stage_for has the rules.
        "stage_counts": p["stage_counts"],
    }


@router.post("/past-data/imports/{batch_id}/move")
async def past_data_move(batch_id: str, user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES))):
    """Put this sheet's clients on its branch as live leads."""
    batch = await _managed_sheet(user, batch_id)
    if batch.get("live_move"):
        raise HTTPException(status_code=409, detail=f"{past_data_store.sheet_label(batch)} is live already")
    record = await past_data_live.move(batch, user.full_name, past_data_store.sheet_label(batch))
    if not record:
        raise HTTPException(status_code=409, detail="This sheet is being moved already")
    return {"live_move": record}


@router.delete("/past-data/imports/{batch_id}/move")
async def past_data_take_back(batch_id: str, user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES))):
    """Take this sheet's live clients back off the branch. The sheet stays in Past Data."""
    batch = await _managed_sheet(user, batch_id)
    if not batch.get("live_move"):
        raise HTTPException(status_code=404, detail="This sheet is not live")
    return {"removed_leads": await past_data_live.take_back(batch, user.full_name)}


# --------------------------------------------------------------------------- import/export
#
# Super Admin's Settings > Import/Export: every sheet on one list, whichever branch it is on,
# and each one connected to a branch -- or to none -- from there. A sheet on no branch shows on
# no branch's Past Data tab and cannot be moved to live until it is given one.


class SheetBranchIn(BaseModel):
    # None disconnects the sheet from its branch.
    branch_id: Optional[str] = None


@router.get("/past-data/sheets")
async def past_data_sheets(user: V3UserOut = Depends(v3_require_roles(*sorted(ORG_WIDE_ROLES)))):
    """Every sheet ever added, newest first: connected ones and the disconnected (archived)
    ones, which keep their log row after their data is deleted. Plus the branches a sheet can
    be connected to, and the Past Data branch that Add Sheet puts new ones on."""
    rows = await v3_col("past_imports").find({}, {"_id": 0}).sort("imported_at", -1).to_list(500)
    branches = await v3_col("branches").find(
        live_branch_query(), {"_id": 0, "id": 1, "branch_name": 1}).sort("branch_name", 1).to_list(500)
    names = {b["id"]: b.get("branch_name", "") for b in branches}
    missing = list({r.get("branch_id") for r in rows if r.get("branch_id") and r.get("branch_id") not in names})
    if missing:
        for b in await v3_col("branches").find({"id": {"$in": missing}}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500):
            names[b["id"]] = b.get("branch_name", "")
    home = await _home_branch_id()
    super_admin = _is_super_admin(user)
    return {
        "sheets": [
            {
                **_sheet(r),
                "branch_name": names.get(r.get("branch_id"), ""),
                "archived": bool(r.get("removed_at")),
                "removed_at": r.get("removed_at") or "",
                "removed_by": r.get("removed_by", ""),
            }
            for r in rows
        ],
        "branches": branches,
        "home_id": home,
        "can_manage": super_admin,
        "can_add": bool(super_admin and home),
    }


@router.post("/past-data/imports/{batch_id}/branch")
async def past_data_sheet_branch(batch_id: str, body: SheetBranchIn, user: V3UserOut = Depends(v3_require_roles(SUPER_ADMIN))):
    """Connect a sheet to another branch, or disconnect it from its branch. Its data stays; it
    only changes which branch's Past Data tab shows it and where Move to live would put it.
    A live sheet's clients are on its branch's Branch Leads, so it is returned back first."""
    batch = await v3_col("past_imports").find_one({"id": batch_id, "removed_at": None}, {"_id": 0})
    if not batch:
        raise HTTPException(status_code=404, detail="That sheet is not connected any more")
    if batch.get("live_move"):
        raise HTTPException(status_code=409, detail=f"{past_data_store.sheet_label(batch)} is live -- Return Back first")
    target = None
    if body.branch_id:
        target = await v3_col("branches").find_one(
            live_branch_query({"id": body.branch_id}), {"_id": 0, "id": 1, "code": 1, "branch_name": 1})
        if not target:
            raise HTTPException(status_code=404, detail="Branch not found")
    if (target or {}).get("id") != batch.get("branch_id"):
        await past_data_store.set_branch(v3_col, batch_id, target)
    return {"id": batch_id, "branch_id": (target or {}).get("id"), "branch_name": (target or {}).get("branch_name", "")}


@router.delete("/past-data/archived/{batch_id}")
async def past_data_delete_archived(batch_id: str, user: V3UserOut = Depends(v3_require_roles(SUPER_ADMIN))):
    """Delete an archived sheet -- one already disconnected -- from the list for good. Its data
    went at Disconnect; this takes the log row that recorded it was here, and any row of it a
    failed disconnect might have left behind. A connected sheet is refused: Disconnect first."""
    batch = await v3_col("past_imports").find_one({"id": batch_id}, {"_id": 0, "id": 1, "removed_at": 1, "label": 1, "source_file": 1})
    if not batch:
        raise HTTPException(status_code=404, detail="That sheet is not in the archive")
    if not batch.get("removed_at"):
        raise HTTPException(status_code=409, detail=f"{past_data_store.sheet_label(batch)} is still connected -- Disconnect it first")
    for name in past_data_store.COLLECTIONS:
        await v3_col(name).delete_many({"batch_id": batch_id})
    await v3_col("past_imports").delete_one({"id": batch_id, "removed_at": {"$ne": None}})
    return {"deleted": batch_id, "label": past_data_store.sheet_label(batch)}
