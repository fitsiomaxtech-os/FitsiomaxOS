"""Past Data: the clinic's register from before the OS, read-only.

Written once by tools/past_data_import.py from the Excel workbook the clinic kept before
it moved onto the OS (see past_data.py for how that is read), and never written by
anything here. Three collections of its own -- past_clients, past_treatments,
past_payments -- plus past_imports, one row per import.

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
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from database import v3_col
from deps import ORG_WIDE_ROLES, is_branch_admin_role, v3_current_user, v3_require_roles, works_org_wide
from past_data import match_key
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3")

PAST_DATA_ROLES = (*sorted(ORG_WIDE_ROLES), "branch_admin")


def _own_branches(user: V3UserOut) -> set:
    return {b for b in (user.branch_ids or []) if b} | ({user.branch_id} if user.branch_id else set())


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
    "branch_id": 1,
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
    return await v3_col("past_imports").find(query, {"_id": 0}).sort("imported_at", -1).to_list(50)


@router.get("/past-data/branches")
async def past_data_branches(_: V3UserOut = Depends(v3_current_user)):
    """Which branches hold past data -- the one question the branch board asks before it
    decides whether to show a Past Data tab. Open to any signed-in desk that mounts that
    board: it names branch ids and nothing about anybody in them."""
    batches = await _live_batches()
    return {"branch_ids": sorted({b["branch_id"] for b in batches if b.get("branch_id")})}


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
    batches = await _live_batches(_branch_for(user, branch_id))
    batch_ids = [b["id"] for b in batches]
    if not batch_ids:
        return {"imported": False, "imports": [], "clients": 0, "treatments": 0, "payments": 0,
                "paid_total": 0, "outstanding_total": 0, "owing_clients": 0, "needs_look_clients": 0,
                "services": [], "statuses": [], "first_date": "", "last_date": ""}

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
        "imports": [
            {
                "id": b["id"], "branch_id": b.get("branch_id"), "branch_name": names.get(b.get("branch_id"), ""),
                "source_file": b.get("source_file", ""), "imported_at": b.get("imported_at", ""),
                "counts": b.get("counts", {}),
            }
            for b in batches
        ],
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
    sort: str = "recent",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=PAGE_SIZE_MAX),
    user: V3UserOut = Depends(v3_require_roles(*PAST_DATA_ROLES)),
):
    batch_ids = [b["id"] for b in await _live_batches(_branch_for(user, branch_id))]
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
    return {
        **client,
        "branch_name": branch.get("branch_name", ""),
        "shared_phone_clients": shared,
        "treatments": treatments,
    }
