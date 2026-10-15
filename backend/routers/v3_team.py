"""Activity Care's Team Consultants and Team Physio tabs.

Every consultant, or every physio, in the organisation -- not only the branch's own -- with
the branches they work at, their phone, gender and HR status, so a Branch Admin can see who is
where and filter by branch or gender.

Three records answer it between them. The `doctors` row is the expert; its login (`users`)
holds a Consultant's branches, because a Consultant's record is branchless on purpose (see
consultants_serving_branch in deps.py); a Physio has one `doctors` row per branch instead, so
theirs are read off the rows. Phone, gender and status are on the HR record (`employees`),
reached through the login's employee_id or, for a profile-only expert with no login, the row's
own; the login's phone stands in where HR has none.
"""
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException

from database import v3_col
from deps import v3_require_roles
from schemas.v3 import V3UserOut
from utils import active_doctor_query, live_branch_query

router = APIRouter(prefix="/api/v3")

# The same desks that run Time Management; the Branch Admin family is read by
# v3_require_roles, as it is there.
TEAM_ROLES = ("branch_admin", "super_admin", "business_dev")

# Which `doctors.profile_type` each tab lists.
TEAM_KINDS = {"consultants": "head_physio", "physio": "physio"}

# A login posted to every branch carries this in branch_ids (see routers/v3_hr.py).
ALL_BRANCHES = "__all__"


def _gender(value) -> str:
    """'male', 'female', 'other' for anything else HR recorded, or '' when it recorded nothing."""
    g = str(value or "").strip().lower()
    if g in ("male", "m"):
        return "male"
    if g in ("female", "f"):
        return "female"
    return "other" if g else ""


@router.get("/team/{kind}")
async def team(kind: str, user: V3UserOut = Depends(v3_require_roles(*TEAM_ROLES))):
    profile = TEAM_KINDS.get(kind)
    if not profile:
        raise HTTPException(status_code=400, detail="Unknown team")

    rows = await v3_col("doctors").find(
        active_doctor_query({"profile_type": profile}),
        {"_id": 0, "id": 1, "full_name": 1, "branch_id": 1, "user_id": 1, "employee_id": 1},
    ).to_list(5000)

    user_ids = list({r["user_id"] for r in rows if r.get("user_id")})
    users: Dict[str, dict] = {}
    if user_ids:
        async for u in v3_col("users").find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "full_name": 1, "role": 1, "branch_id": 1, "branch_ids": 1,
             "employee_id": 1, "is_active": 1, "phone": 1},
        ):
            users[u["id"]] = u

    branches: Dict[str, str] = {}
    async for b in v3_col("branches").find(live_branch_query(), {"_id": 0, "id": 1, "branch_name": 1}):
        branches[b["id"]] = b.get("branch_name") or ""

    # One person, one row: a Physio at three branches has three `doctors` rows, and the
    # multi-branch model has left some Consultants with more than one too.
    people: Dict[str, dict] = {}
    for r in rows:
        login = users.get(r.get("user_id")) if r.get("user_id") else None
        if login is not None and login.get("is_active") is False:
            continue
        key = r.get("user_id") or r.get("employee_id") or r["id"]
        person = people.setdefault(key, {
            "id": key,
            # The login, which a row's Add posts to another branch. None for a profile-only
            # expert, who has no account to post.
            "user_id": r.get("user_id") or None,
            "full_name": (login or {}).get("full_name") or r.get("full_name") or "",
            "employee_id": (login or {}).get("employee_id") or r.get("employee_id"),
            "login_phone": (login or {}).get("phone") or "",
            # Where they belong, for Own Branch: the login's primary branch, or a
            # profile-only expert's own row. HR's record outranks both, below.
            "login_branch": (login or {}).get("branch_id") or (None if login else r.get("branch_id")),
            "branch_ids": set(),
            "all_branches": False,
        })
        if profile == "head_physio" and login is not None:
            posted = [b for b in (login.get("branch_ids") or []) if b] or (
                [login["branch_id"]] if login.get("branch_id") else []
            )
            # A Super Admin taking consultations runs every branch rather than being posted.
            if ALL_BRANCHES in posted or (login.get("role") or "").strip().lower() == "super_admin":
                person["all_branches"] = True
            person["branch_ids"].update(b for b in posted if b != ALL_BRANCHES)
        elif r.get("branch_id"):
            person["branch_ids"].add(r["branch_id"])

    employee_ids = list({p["employee_id"] for p in people.values() if p.get("employee_id")})
    hr: Dict[str, dict] = {}
    if employee_ids:
        async for e in v3_col("employees").find(
            {"id": {"$in": employee_ids}}, {"_id": 0, "id": 1, "gender": 1, "phone": 1, "status": 1, "branch_id": 1},
        ):
            hr[e["id"]] = e

    members: List[dict] = []
    for p in people.values():
        # Archived branches drop out, as they do from every other branch list.
        at = sorted(
            ({"id": b, "name": branches[b]} for b in p["branch_ids"] if b in branches),
            key=lambda b: b["name"].lower(),
        )
        e = hr.get(p.get("employee_id")) or {}
        # Own Branch is the one they were hired into; every other is a branch they
        # collaborate with. Only a branch they actually work counts, so a stale HR branch
        # falls through to the login's, and failing both, the first of theirs.
        own = next((b for b in at if b["id"] == e.get("branch_id")), None) \
            or next((b for b in at if b["id"] == p["login_branch"]), None) \
            or (at[0] if at else None)
        members.append({
            "id": p["id"],
            "user_id": p["user_id"],
            "full_name": p["full_name"],
            "phone": e.get("phone") or p["login_phone"],
            "gender": _gender(e.get("gender")),
            # HR's word for them; "active" where there is no HR record, since an inactive
            # login has already been left out above.
            "status": str(e.get("status") or "active").strip().lower(),
            "all_branches": p["all_branches"],
            "branches": at,
            "own_branch": own,
            "collab_branches": [b for b in at if own is None or b["id"] != own["id"]],
        })
    members.sort(key=lambda m: m["full_name"].lower())

    return {
        "kind": kind,
        "members": members,
        # Every live branch, for the filter -- including ones nobody on this team is at yet.
        "branches": sorted(({"id": i, "name": n} for i, n in branches.items()), key=lambda b: b["name"].lower()),
    }
