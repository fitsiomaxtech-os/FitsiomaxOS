"""Past Data: the clinic's books from before the OS, read-only.

Put in by uploading the Excel sheets the clinic kept before it moved onto the OS -- the
register (past_data.py) and the branches' monthly revenue sheets (past_revenue.py) -- one
sheet per upload, each one its own import (see "the import" below; tools/past_data_import.py
does the same from a terminal). Three collections of its own -- past_clients,
past_treatments, past_payments -- plus past_imports, one row per sheet.

Read-only on purpose, and apart from `leads` on purpose. These are courses that finished,
or were dropped, or were still running on the day the workbook was last saved, and the
money on them was collected into books that are already closed. Nothing here is a lead to
work, a session to book or a balance to collect: a patient from this register who comes
back arrives as a new enquiry like anybody else, and this is where their history is read.
Kept out of `leads` so that no board, dashboard or finance figure that reads leads -- and
none of them scope by branch -- can count a row of it.

Shown inside the branch it was imported into, and nowhere else: a Past Data tab on that
branch's own board (BranchAdminBoard.jsx), which appears only on a branch that holds an
import -- see /past-data/branches. So the reads below are all by branch. The two org-wide
desks may read any branch's, as they may open any branch's board; a Branch Admin reads
their own branch's, which is how the Past Data Entry login sees what it was made for, and
no other branch's.
"""
import asyncio
import hashlib
import io
import re
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

import past_data
import past_data_store
from database import v3_col
from deps import ORG_WIDE_ROLES, is_branch_admin_role, v3_current_user, v3_require_roles, works_org_wide
from past_data import match_key
from schemas.v3 import V3UserOut
from utils import live_branch_query

router = APIRouter(prefix="/api/v3")

PAST_DATA_ROLES = (*sorted(ORG_WIDE_ROLES), "branch_admin")

# Adding and disconnecting sheets: Super Admin, and the Past Data branch's own admin -- the
# login made to keep these books. Not the business desk, which reads them, and not any other
# branch's admin: see _may_manage.
SUPER_ADMIN = "super_admin"

# The register is under a megabyte. Ten times that is room for it to grow and still far
# short of anything a person would upload by mistake and expect to be read.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
EXAMPLES_PER_FINDING = 8
MAX_SHEETS = 200


def _is_super_admin(user: V3UserOut) -> bool:
    return (user.role or "").strip().lower() == SUPER_ADMIN


def _own_branches(user: V3UserOut) -> set:
    return {b for b in (user.branch_ids or []) if b} | ({user.branch_id} if user.branch_id else set())


async def _past_data_branch_ids() -> set:
    """Every branch that has ever held a sheet -- disconnected ones too, so a branch whose last
    sheet was taken out keeps its Past Data tab, to add the corrected one from."""
    return {b for b in await v3_col("past_imports").distinct("branch_id") if b}


async def _may_manage(user: V3UserOut, branch_id: Optional[str]) -> bool:
    """Whether this caller may add sheets to, and disconnect them from, this branch.

    Super Admin anywhere. A Branch Admin on their own branch, and only once it is the Past
    Data branch -- Super Admin's first import is what makes it one -- so no working branch's
    admin can start filling their branch with old books.
    """
    if not branch_id:
        return False
    if _is_super_admin(user):
        return True
    return (is_branch_admin_role(user.role) and branch_id in _own_branches(user)
            and branch_id in await _past_data_branch_ids())


def _branch_for(user: V3UserOut, branch_id: Optional[str]) -> Optional[str]:
    """The branch this caller may read past data for.

    An org-wide desk reads the branch it asked for, or every branch when it named none. A
    Branch Admin reads their own: naming another branch is refused rather than quietly
    swapped for theirs, since a screen that asked for one branch and was shown another
    would say so nowhere.
    """
    if works_org_wide(user.role):
        return branch_id or None
    own = _own_branches(user)
    if not is_branch_admin_role(user.role) or not own:
        raise HTTPException(status_code=403, detail="Not allowed")
    if branch_id and branch_id not in own:
        raise HTTPException(status_code=403, detail="Not your branch")
    return branch_id or user.branch_id

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


@router.get("/past-data/branches")
async def past_data_branches(user: V3UserOut = Depends(v3_current_user)):
    """Which branches hold past data -- the one question the branch board asks before it
    decides whether to show a Past Data tab. Open to any signed-in desk that mounts that
    board: it names branch ids and nothing about anybody in them. A branch that has held a
    sheet keeps the tab after its last one is disconnected, to add the next from.

    `importable_ids` answers the question before there is any past data: where Super Admin
    may put it. Once one branch holds an import, that branch and no other -- the old books
    are one clinic's history and belong in one place. Before that, every branch with nothing
    on it yet: no leads and no experts, which is the branch made for this and not one of the
    clinics. A branch already working patients never offers it.
    """
    holding = sorted(await _past_data_branch_ids())
    importable: list = []
    if _is_super_admin(user):
        live = sorted({b["branch_id"] for b in await _live_batches() if b.get("branch_id")})
        if live:
            importable = live
        elif holding:
            importable = holding
        else:
            for b in await v3_col("branches").find(live_branch_query(), {"_id": 0, "id": 1}).to_list(500):
                if (not await v3_col("leads").count_documents({"branch_id": b["id"]}, limit=1)
                        and not await v3_col("doctors").count_documents({"branch_id": b["id"]}, limit=1)):
                    importable.append(b["id"])
    return {"branch_ids": holding, "importable_ids": sorted(importable)}


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
    # Another branch's client reads as not found to a Branch Admin, same as one that does
    # not exist: which ids belong to which branch is not theirs to learn either.
    if not client or (not works_org_wide(user.role) and client.get("branch_id") not in _own_branches(user)):
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
        "source_file": batch.get("source_file", ""),
        "imported_at": batch.get("imported_at", ""),
        "imported_by": batch.get("imported_by", ""),
        "counts": batch.get("counts", {}),
        "paid_total": batch.get("paid_total", 0),
    }


async def _import_blocker(branch_id: str) -> str:
    """Why this branch may not take a sheet, or "" when it may: another branch holds the old
    books already. One clinic's history belongs in one place, and sheets spread over two
    branches would each show half of it."""
    others = [b for b in await past_data_store.live_imports(v3_col) if b.get("branch_id") != branch_id]
    if not others:
        return ""
    branch = await v3_col("branches").find_one({"id": others[0]["branch_id"]}, {"_id": 0, "branch_name": 1}) or {}
    return f"Past data is already imported into {branch.get('branch_name') or 'another branch'} -- it belongs on one branch only"


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
        raise HTTPException(status_code=403, detail="Only Super Admin or this branch's own admin adds past data sheets")
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
    existing = await past_data_store.live_imports(v3_col, branch_id)
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
    existing = await past_data_store.live_imports(v3_col, branch_id)
    replacing = None
    if replace_id:
        replacing = next((b for b in existing if b["id"] == replace_id), None)
        if not replacing:
            raise HTTPException(status_code=404, detail="The sheet to replace is not on this branch any more")
    same_file = next((b for b in existing if b.get("file_sha256") == sha), None)
    if same_file and same_file is not replacing:
        raise HTTPException(status_code=409, detail=f"This file is already here as {past_data_store.sheet_label(same_file)}")

    batch_id = await past_data_store.write_batch(
        v3_col, data, branch, file.filename or "", sha, imported_by=user.full_name, label=label,
    )
    removed = 0
    if replacing:
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
    was here and who took it out. Nothing live read these tables, so nothing live changes.
    """
    batch = await v3_col("past_imports").find_one({"id": batch_id, "removed_at": None}, {"_id": 0})
    if not batch:
        raise HTTPException(status_code=404, detail="That sheet is not connected any more")
    if not await _may_manage(user, batch.get("branch_id")):
        raise HTTPException(status_code=403, detail="Only Super Admin or this branch's own admin disconnects past data sheets")
    removed = await past_data_store.remove_batch(v3_col, batch_id, removed_by=user.full_name)
    return {"removed_batch": batch_id, "label": past_data_store.sheet_label(batch), "removed": removed}
