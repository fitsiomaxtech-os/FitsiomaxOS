from fastapi import APIRouter, Depends, HTTPException
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
import uuid

from database import v3_col
from utils import now_iso, derive_branch_code, active_doctor_query, live_branch_query
from deps import v3_require_roles, is_branch_admin_role, is_physio_role, is_head_physio_role, is_diet_role, is_pre_sales_role, is_zumba_role, consultants_serving_branch, PHYSIO_ROLES, HEAD_PHYSIO_ROLES
# The desks a Physio or Nutritionist can hold several of, and the doctors profile_type
# each role keeps its calendar under. Imported from HR rather than restated so posting
# somebody to a branch here builds the same record HR's own assign builds.
from routers.v3_hr import is_multi_branch_role, holds_calendar_per_branch, expert_profile_type
from security import verify_password
import lead_control
import past_data_store
from seed import create_default_lead_source
from schemas.v3 import V3UserOut


router = APIRouter(prefix="/api/v3/branch-mgmt")


class BranchAssignedCreate(BaseModel):
    branch_name: str
    address: Optional[str] = ""  # online-vertical branches have no physical address
    # Optional: a branch is created first and staffed after. Asking for its Branch Admin
    # on the create form meant the admin's HR record had to exist before the branch did,
    # which is backwards — the employee is hired into a branch. Left blank here, the
    # branch is created unassigned and PATCH /{branch_id}/admin fills the desk later.
    admin_user_id: Optional[str] = Field(None, description="Existing user with a Branch Admin role; blank to create the branch unassigned")
    admin_phone: Optional[str] = ""
    vertical: Optional[str] = "offline_physiotherapy"
    opened_date: Optional[str] = ""
    opening_hours: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    map_location: Optional[str] = ""
    weekly_hours: Optional[Dict[str, Any]] = None
    holidays: Optional[List[str]] = None
    code: Optional[str] = None  # short unique prefix for Patient Numbers, e.g. "ANN" — auto-derived if omitted
    lead_control: Optional[str] = None  # "pre_sales" | "branch_admin" — see backend/lead_control.py


class AssignAdmin(BaseModel):
    admin_user_id: str


class AssignHeadPhysio(BaseModel):
    doctor_id: str


class BranchArchiveInput(BaseModel):
    password: str = Field(..., description="Acting Super Admin's own login password")


@router.get("")
async def list_branches_full(archived: bool = False, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "marketing_head"))):
    q = {"archived": True} if archived else {"archived": {"$ne": True}}
    branches = await v3_col("branches").find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    # Enrich each branch with stats
    out = []
    for b in branches:
        bid = b["id"]
        leads_total = await v3_col("leads").count_documents({"branch_id": bid})
        leads_open = await v3_col("leads").count_documents({"branch_id": bid, "stage": {"$nin": ["Completed", "Lost"]}})
        leads_completed = await v3_col("leads").count_documents({"branch_id": bid, "stage": "Completed"})
        appointments = await v3_col("appointments").count_documents({"branch_id": bid})
        doctors = await v3_col("doctors").count_documents({"branch_id": bid})
        out.append({
            **b,
            "leads_total": leads_total,
            "leads_open": leads_open,
            "leads_completed": leads_completed,
            "appointments_count": appointments,
            "doctors_count": doctors,
        })
    return out


# business_dev on the six branch-management routes below (archive, restore,
# with-existing-admin, admin, head-physio-candidates, head-physio).
#
# The Business Development Executive's board mounts BranchManagementBoard as its own
# Branch Control tab, in full rather than as Operations' cut-down dialog, so the desk
# that opens branches can now run them: create one against an existing admin, reassign
# that admin, assign a CONSULTANT, and archive a branch that has closed.
#
# Deliberately NOT widened, and the reason this is a list of six rather than of every
# super_admin route in this file: /team-candidates and /team/{user_id}, and the HR account
# actions in v3_hr (activate, deactivate, delete-permanent). Those are staff accounts, not
# branch control,
# and BranchManagementBoard's drill-in is mounted `readOnly` for this role so none of
# them is reachable from the panel in the first place.
@router.post("/{branch_id}/archive")
async def archive_branch(branch_id: str, payload: BranchArchiveInput, user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    # Soft-delete: keeps the branch, its admin user, and its leads/appointments intact
    # (unlike DELETE /branches/{id}, which hard-deletes) — gated by the acting Super
    # Admin re-entering their own login password so archiving isn't a stray misclick.
    account = await v3_col("users").find_one({"id": user.id}, {"_id": 0, "password": 1})
    if not account or not verify_password(payload.password, account.get("password", "")):
        raise HTTPException(status_code=401, detail="Incorrect password")
    existing = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Branch not found")
    await v3_col("branches").update_one(
        {"id": branch_id},
        {"$set": {"archived": True, "archived_at": now_iso(), "archived_by": user.full_name}},
    )
    return {"message": "Branch archived"}


@router.post("/{branch_id}/restore")
async def restore_branch(branch_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("branches").update_one(
        {"id": branch_id},
        {"$set": {"archived": False}, "$unset": {"archived_at": "", "archived_by": ""}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Branch not found")
    return {"message": "Branch restored"}


@router.post("/{branch_id}/delete-permanent")
async def delete_archived_branch(branch_id: str, payload: BranchArchiveInput, user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Take an archived branch out for good, from Branch Manager > All Archives.

    Archived first, and only then deletable: archiving is the reversible step, and this is
    the one after it. Same password gate as archive, since nothing brings this back.

    Not DELETE /branches/{id} in v3_config, which also deletes the branch admin's login.
    That person is an employee HR manages, and may already run another branch; here they
    are only unlinked, and turn up as unassigned in HR's candidate list. Leads and lead
    sources go back to "no branch", as that route does, so they re-enter Pre-Sales rather
    than point at a branch nobody can open.
    """
    account = await v3_col("users").find_one({"id": user.id}, {"_id": 0, "password": 1})
    if not account or not verify_password(payload.password, account.get("password", "")):
        raise HTTPException(status_code=401, detail="Incorrect password")
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    if not branch.get("archived"):
        raise HTTPException(status_code=409, detail="Archive the branch before deleting it")
    # A connected sheet's rows carry this branch_id: deleting the branch would leave
    # Import/Export pointing at a branch that is not there.
    sheets = await past_data_store.live_imports(v3_col, branch_id)
    if sheets:
        raise HTTPException(status_code=409, detail=f"{len(sheets)} past data sheet(s) are connected to this branch — connect them elsewhere in Import/Export first")

    await v3_col("branches").delete_one({"id": branch_id})
    admin_id = branch.get("admin_user_id")
    if admin_id:
        # Only if they are still on this branch — they may have been given another since.
        await v3_col("users").update_one({"id": admin_id, "branch_id": branch_id}, {"$set": {"branch_id": None}})
    await v3_col("leads").update_many({"branch_id": branch_id}, {"$set": {"branch_id": None, "branch_stage": None}})
    await v3_col("marketing_sources").update_many({"branch_id": branch_id}, {"$set": {"branch_id": None}})
    return {"message": "Branch deleted"}


@router.post("/with-existing-admin")
async def create_branch_with_existing_admin(payload: BranchAssignedCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    # An admin is only looked up when one was named. Every check below still runs in that
    # case, so an admin passed by an older client (or by the reassign dialog's own path)
    # is validated exactly as before.
    admin_user_id = (payload.admin_user_id or "").strip()
    user = None
    if admin_user_id:
        user = await v3_col("users").find_one({"id": admin_user_id, "is_active": True}, {"_id": 0, "password": 0})
        if not user:
            raise HTTPException(status_code=404, detail="Branch admin user not found")
        if not is_branch_admin_role(user.get("role")):
            raise HTTPException(status_code=400, detail=f"User role is '{user.get('role')}', must be a Branch Admin role")
        # Soft check: warn if user already assigned to another branch
        already = await v3_col("branches").find_one({"admin_user_id": admin_user_id}, {"_id": 0, "id": 1, "branch_name": 1})
        if already:
            raise HTTPException(status_code=409, detail=f"User already assigned to branch '{already.get('branch_name')}'")

    branch_id = str(uuid.uuid4())
    existing_codes = set(await v3_col("branches").distinct("code"))
    code = (payload.code or "").strip().upper()
    if code:
        if code in existing_codes:
            raise HTTPException(status_code=409, detail=f"Branch code '{code}' is already in use")
    else:
        code = derive_branch_code(payload.branch_name, existing_codes)
    branch = {
        "id": branch_id,
        "code": code,
        "branch_name": payload.branch_name,
        "address": payload.address,
        "admin_user_id": admin_user_id,
        "admin_name": (user or {}).get("full_name", ""),
        "admin_email": (user or {}).get("email", ""),
        "admin_phone": payload.admin_phone or "",
        "vertical": payload.vertical or "offline_physiotherapy",
        "opened_date": payload.opened_date or "",
        "opening_hours": payload.opening_hours or "",
        "phone": payload.phone or "",
        "email": payload.email or "",
        "map_location": payload.map_location or "",
        "weekly_hours": payload.weekly_hours or {},
        "holidays": payload.holidays or [],
        "lead_control": lead_control.normalize(payload.lead_control),
        "created_at": now_iso(),
    }
    await v3_col("branches").insert_one(branch.copy())
    # Update user.branch_id
    if admin_user_id:
        await v3_col("users").update_one({"id": admin_user_id}, {"$set": {"branch_id": branch_id}})
    # Every branch gets its own Lead Source card the moment it exists — see
    # seed.ensure_branch_lead_sources for why Marketing > Lead Sources no longer has its
    # own Add Source button.
    await create_default_lead_source(branch_id, payload.branch_name)
    return branch


@router.patch("/{branch_id}/admin")
async def reassign_branch_admin(branch_id: str, payload: AssignAdmin, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    user = await v3_col("users").find_one({"id": payload.admin_user_id, "is_active": True}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not is_branch_admin_role(user.get("role")):
        raise HTTPException(status_code=400, detail=f"User role must be a Branch Admin role (current: {user.get('role')})")
    other = await v3_col("branches").find_one({"admin_user_id": payload.admin_user_id, "id": {"$ne": branch_id}}, {"_id": 0, "branch_name": 1})
    if other:
        raise HTTPException(status_code=409, detail=f"User already manages '{other.get('branch_name')}'")

    # Unlink previous admin (if any) from this branch
    prev_admin_id = branch.get("admin_user_id")
    if prev_admin_id and prev_admin_id != payload.admin_user_id:
        await v3_col("users").update_one({"id": prev_admin_id}, {"$set": {"branch_id": None}})

    await v3_col("branches").update_one(
        {"id": branch_id},
        {"$set": {
            "admin_user_id": payload.admin_user_id,
            "admin_name": user.get("full_name", ""),
            "admin_email": user.get("email", ""),
        }},
    )
    await v3_col("users").update_one({"id": payload.admin_user_id}, {"$set": {"branch_id": branch_id}})
    return await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})


@router.get("/head-physio-candidates")
async def head_physio_candidates(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    rows = await v3_col("doctors").find(active_doctor_query({"profile_type": "head_physio"}), {"_id": 0}).to_list(500)
    branches = {b["id"]: b.get("branch_name") for b in await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)}
    return [{**d, "assigned_branch": branches.get(d.get("branch_id")) if d.get("branch_id") else None} for d in rows]


@router.patch("/{branch_id}/head-physio")
async def assign_head_physio(branch_id: str, payload: AssignHeadPhysio, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    doctor = await v3_col("doctors").find_one({"id": payload.doctor_id, "profile_type": "head_physio"}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="CONSULTANT not found")

    # Assigns or moves this Head Physio to the given branch (overwrites any prior branch link).
    await v3_col("doctors").update_one({"id": payload.doctor_id}, {"$set": {"branch_id": branch_id}})
    if doctor.get("user_id"):
        await v3_col("users").update_one({"id": doctor["user_id"]}, {"$set": {"branch_id": branch_id}})
    return await v3_col("doctors").find_one({"id": payload.doctor_id}, {"_id": 0})


@router.get("/{branch_id}/performance")
async def branch_performance(branch_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "marketing_head"))):
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    leads_total = await v3_col("leads").count_documents({"branch_id": branch_id})
    leads_pipeline = [
        {"$match": {"branch_id": branch_id}},
        {"$group": {"_id": "$stage", "n": {"$sum": 1}}},
    ]
    stage_breakdown: Dict[str, int] = {}
    async for row in v3_col("leads").aggregate(leads_pipeline):
        stage_breakdown[row["_id"] or "Unknown"] = row["n"]

    appointments_total = await v3_col("appointments").count_documents({"branch_id": branch_id})
    appointments_completed = await v3_col("appointments").count_documents({"branch_id": branch_id, "status": "completed"})
    completed = stage_breakdown.get("Completed", 0)
    conversion = (completed / leads_total * 100.0) if leads_total else 0.0

    # Revenue: consultation_fee + package_amount on this branch's leads
    revenue_pipeline = [
        {"$match": {"branch_id": branch_id}},
        {"$group": {"_id": None,
                    "consultation_fees": {"$sum": {"$ifNull": ["$consultation_fee", 0]}},
                    "package_revenue": {"$sum": {"$ifNull": ["$package_amount", 0]}}}},
    ]
    rev_rows = await v3_col("leads").aggregate(revenue_pipeline).to_list(1)
    revenue = rev_rows[0] if rev_rows else {"consultation_fees": 0, "package_revenue": 0}

    doctors = await v3_col("doctors").count_documents({"branch_id": branch_id})
    # Both physio slugs — an Online Physio is one of the branch's physios, and counting
    # only the floor ones understates the team on every branch that runs online.
    physios = await v3_col("users").count_documents({"$or": [{"branch_id": branch_id}, {"branch_ids": branch_id}], "role": {"$in": list(PHYSIO_ROLES)}, "is_active": True})
    # Every consultant slug, for the same reason both physio slugs are counted above: an
    # Online Consultant is one of this branch's consultants, and the desk moved off
    # `head_physio` onto `consultant`, so the literal counted nobody at all.
    head_physios = await v3_col("users").count_documents({"$or": [{"branch_id": branch_id}, {"branch_ids": branch_id}], "role": {"$in": sorted(HEAD_PHYSIO_ROLES)}, "is_active": True})

    return {
        "branch": branch,
        "kpis": {
            "leads_total": leads_total,
            "leads_completed": completed,
            "conversion_rate": round(conversion, 1),
            "appointments_total": appointments_total,
            "appointments_completed": appointments_completed,
            "consultation_fees": revenue.get("consultation_fees", 0),
            "package_revenue": revenue.get("package_revenue", 0),
            "total_revenue": (revenue.get("consultation_fees", 0) or 0) + (revenue.get("package_revenue", 0) or 0),
            "doctors": doctors,
            "physios": physios,
            "head_physios": head_physios,
        },
        "stage_breakdown": [{"stage": k, "count": v} for k, v in stage_breakdown.items()],
    }


@router.get("/performance-summary")
async def performance_summary(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "marketing_head"))):
    branches = await v3_col("branches").find(live_branch_query(), {"_id": 0}).to_list(500)
    summary: List[Dict[str, Any]] = []
    for b in branches:
        bid = b["id"]
        leads_total = await v3_col("leads").count_documents({"branch_id": bid})
        completed = await v3_col("leads").count_documents({"branch_id": bid, "stage": "Completed"})
        conversion = (completed / leads_total * 100.0) if leads_total else 0.0
        rev_rows = await v3_col("leads").aggregate([
            {"$match": {"branch_id": bid}},
            {"$group": {"_id": None,
                        "consultation_fees": {"$sum": {"$ifNull": ["$consultation_fee", 0]}},
                        "package_revenue": {"$sum": {"$ifNull": ["$package_amount", 0]}}}},
        ]).to_list(1)
        rev = rev_rows[0] if rev_rows else {"consultation_fees": 0, "package_revenue": 0}
        total_rev = (rev.get("consultation_fees", 0) or 0) + (rev.get("package_revenue", 0) or 0)
        summary.append({
            "branch_id": bid,
            "branch_name": b.get("branch_name"),
            "admin_name": b.get("admin_name"),
            "address": b.get("address"),
            "leads_total": leads_total,
            "leads_completed": completed,
            "conversion_rate": round(conversion, 1),
            "total_revenue": total_rev,
        })
    return summary



@router.get("/{branch_id}/detail")
async def branch_detail(branch_id: str, user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "marketing_head", "branch_admin"))):
    # A Branch Admin may view their own branch's detail (read-only Manager view);
    # everyone else with a management role may view any branch.
    if is_branch_admin_role(user.role) and user.branch_id != branch_id:
        raise HTTPException(status_code=403, detail="You can only view your own branch")
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    admin_user = None
    if branch.get("admin_user_id"):
        admin_user = await v3_col("users").find_one({"id": branch["admin_user_id"]}, {"_id": 0, "password": 0})

    # Inactive staff included, unlike the counts above. Team is the screen that switches
    # someone off, and filtering them out here made that a one-way door: the row vanished
    # on deactivate with nothing left to switch back on. Each row carries is_active so the
    # list can say which is which. Only `staff` below reads these, so nothing else sees
    # an inactive person appear.
    # Either field, because a desk that works several branches carries the list and holds
    # branch_id as no more than the first of them. Matching only the primary showed such a
    # person on their first branch's Team and nowhere else — a Consultant posted to two
    # branches appearing on one of them, which is exactly what this tab is for saying.
    staff_rows = await v3_col("users").find(
        {"$or": [{"branch_id": branch_id}, {"branch_ids": branch_id}]}, {"_id": 0, "password": 0},
    ).to_list(500)
    head_physios = [u for u in staff_rows if is_head_physio_role(u.get("role"))]
    physios = [u for u in staff_rows if is_physio_role(u.get("role"))]
    # Off the predicate, not the literal: a Branch Admin (Physio), (Fitness) or an Online
    # Physio Admin runs this branch too, and matching "branch_admin" exactly left them out
    # of their own branch's Team list.
    branch_admins = [u for u in staff_rows if is_branch_admin_role(u.get("role"))]
    # The Diet desk had no group at all, so a branch's Nutritionist appeared nowhere on
    # Team even though they hold a calendar here like a Physio does.
    diet = [u for u in staff_rows if is_diet_role(u.get("role"))]
    # Same omission, same fix: a Zumba master is posted to a branch, teaches its class and
    # is assigned its students, and was on none of the desks that say who works here.
    #
    # Super Admin excluded for the reason the Diet line below it is: is_zumba_role answers
    # True for them so they can reach the Zumba board, which would otherwise stand them on
    # the Zumba desk of every branch in the company.
    zumba = [u for u in staff_rows if u.get("role") != "super_admin" and is_zumba_role(u.get("role"))]

    doctors = await v3_col("doctors").find(active_doctor_query({"branch_id": branch_id}), {"_id": 0}).to_list(500)
    # A Consultant's calendar is branchless — one person, one set of hours — so it never
    # matched the branch query above and this branch's Consultant Calendars card came back
    # empty. Fetched separately and narrowed to the Consultants actually posted here, which
    # is the same rule the booking popup and the expert list read.
    consultant_rows = await v3_col("doctors").find(
        active_doctor_query({"profile_type": "head_physio"}), {"_id": 0},
    ).to_list(500)
    serving = await consultants_serving_branch(consultant_rows, branch_id)
    seen = {d["id"] for d in doctors}
    doctors += [d for d in serving if d["id"] not in seen]

    appointments = await v3_col("appointments").find({"branch_id": branch_id}, {"_id": 0}).sort("appointment_time", -1).to_list(500)
    appt_completed = len([a for a in appointments if a.get("status") == "completed"])
    appt_scheduled = len([a for a in appointments if a.get("status") in ("scheduled", "confirmed")])
    appt_cancelled = len([a for a in appointments if a.get("status") == "cancelled"])

    leads = await v3_col("leads").find({"branch_id": branch_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    consultations = [ld for ld in leads if ld.get("consultation_fee") and ld.get("consultation_fee") > 0]
    packages = [ld for ld in leads if ld.get("package_amount") and ld.get("package_amount") > 0]
    consultation_total = sum((ld.get("consultation_fee") or 0) for ld in consultations)
    package_total = sum((ld.get("package_amount") or 0) for ld in packages)

    followups = []
    for ld in leads:
        for f in (ld.get("follow_ups") or []):
            followups.append({**f, "lead_id": ld["id"], "lead_name": ld.get("name", "")})
    followups_open = len([f for f in followups if not f.get("completed")])
    followups_done = len([f for f in followups if f.get("completed")])

    weekly_assessments = []
    for ld in leads:
        for w in (ld.get("head_physio_weekly_reviews") or []):
            weekly_assessments.append({**w, "lead_id": ld["id"], "lead_name": ld.get("name", "")})

    head_physio_calendars = [d for d in doctors if d.get("profile_type") == "head_physio"]
    physio_calendars = [d for d in doctors if d.get("profile_type") == "physio"]

    return {
        "branch": branch,
        "admin_user": admin_user,
        "staff": {
            "branch_admins": branch_admins,
            "head_physios": head_physios,
            "physios": physios,
            "diet": diet,
            "zumba": zumba,
            "doctors": doctors,
        },
        "performance": {
            "kpis": {
                "leads_total": len(leads),
                "leads_open": len([ld for ld in leads if ld.get("stage") not in ("Completed", "Lost")]),
                "leads_completed": len([ld for ld in leads if ld.get("stage") == "Completed"]),
            },
            "appointments": {
                "list": appointments[:50],
                "total": len(appointments),
                "completed": appt_completed,
                "scheduled": appt_scheduled,
                "cancelled": appt_cancelled,
            },
            "consultations": {
                "list": consultations[:50],
                "total_count": len(consultations),
                "total_amount": consultation_total,
            },
            "packages": {
                "list": packages[:50],
                "total_count": len(packages),
                "total_amount": package_total,
            },
            "follow_ups": {
                "list": followups[:100],
                "open": followups_open,
                "done": followups_done,
                "total": len(followups),
            },
        },
        "head_physio_section": {
            "calendars": head_physio_calendars,
            "physio_calendars": physio_calendars,
            "post_treatment_reviews": weekly_assessments[:100],
        },
    }


# --------------------------------------------------- Team: who is posted to this branch
#
# The Team tab lists a branch's staff desk by desk and can now move people on and off it.
# That is a change of posting, not of role: the person keeps the role they hold and only
# the branch they work at changes. Roles are changed in HR Admin, which is why nothing
# here writes one.


def _desk_holds(desk: str):
    """Which roles belong to a Team desk, as a predicate.

    A predicate rather than a set because Diet's slug is typed by hand -- this install has
    both nutrition_coach and diet_manage -- so the Diet desk has to match the way the Diet
    board itself matches, on the shape of the slug.

    super_admin is excluded explicitly: is_diet_role answers True for it so a Super Admin
    can reach every board, which would otherwise put them on the Diet desk of every branch.
    """
    if desk == "pre_sales":
        return lambda r: is_pre_sales_role(r)
    if desk == "branch_admins":
        return lambda r: is_branch_admin_role(r)
    if desk == "physios":
        return lambda r: is_physio_role(r)
    if desk == "head_physios":
        return lambda r: is_head_physio_role(r)
    if desk == "diet":
        return lambda r: r != "super_admin" and is_diet_role(r)
    if desk == "zumba":
        return lambda r: r != "super_admin" and is_zumba_role(r)
    return None


async def _team_desk_or_400(branch_id: str, desk: str):
    branch = await v3_col("branches").find_one(
        {"id": branch_id}, {"_id": 0, "id": 1, "branch_name": 1, "admin_user_id": 1}
    )
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    # The Consultants desk used to be refused here. It had to be: their branches were
    # cleared at every startup, so a posting made on this screen would have been accepted
    # and then quietly reverted by the next restart. That startup wipe is gone — see
    # consolidate_head_physio_doctors in seed.py — and a Consultant is now posted to chosen
    # branches like every other desk on this tab.
    holds = _desk_holds(desk)
    if holds is None:
        raise HTTPException(status_code=400, detail="Unknown team desk")
    return branch, holds


def _posted_to(user: dict) -> list:
    """The branches this account is posted to, whichever field carries them."""
    return user.get("branch_ids") or ([user["branch_id"]] if user.get("branch_id") else [])


@router.get("/{branch_id}/team-candidates")
async def team_candidates(branch_id: str, desk: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Everyone holding this desk's role who is not already at this branch.

    Org-wide rather than branch-scoped on purpose: the point of the picker is to bring in
    somebody who is elsewhere, so a list of only this branch's own people would be empty
    exactly when it is wanted. Where each one currently sits comes back with them, because
    for a single-branch role picking them moves them, and that is worth seeing beforehand.
    """
    branch, holds = await _team_desk_or_400(branch_id, desk)

    rows = await v3_col("users").find({"is_active": True}, {"_id": 0, "password": 0}).to_list(2000)
    branch_rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    names = {b["id"]: b.get("branch_name", "") for b in branch_rows}

    out = []
    for u in rows:
        if not holds(u.get("role")):
            continue
        at = _posted_to(u)
        if branch_id in at:
            continue  # already on this desk here
        out.append({
            "id": u["id"],
            "full_name": u.get("full_name", ""),
            "email": u.get("email", ""),
            "role": u.get("role", ""),
            "mobile_number": u.get("mobile_number", ""),
            "multi_branch": is_multi_branch_role(u.get("role")),
            # Named, not just counted: "currently at T Nagar Branch" is what tells someone
            # that picking this person takes them off it.
            "current_branches": [names[b] for b in at if names.get(b)],
        })
    out.sort(key=lambda r: (r["full_name"] or "").lower())
    return {"candidates": out, "desk": desk, "branch_name": branch.get("branch_name", "")}


@router.post("/{branch_id}/team/{user_id}")
async def team_add_member(branch_id: str, user_id: str, desk: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Post an existing account to this branch."""
    branch, holds = await _team_desk_or_400(branch_id, desk)
    user = await v3_col("users").find_one({"id": user_id, "is_active": True}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not holds(user.get("role")):
        raise HTTPException(status_code=400, detail=f"{user.get('full_name')} does not hold a role for this desk")

    moved_from = None
    if is_multi_branch_role(user.get("role")):
        # A Physio or Nutritionist can work several branches, so this branch is added to
        # the list rather than replacing it. branch_id stays the first of them, which is
        # what every single-branch filter in the OS still reads.
        at = list(dict.fromkeys(_posted_to(user) + [branch_id]))
        await v3_col("users").update_one({"id": user_id}, {"$set": {"branch_ids": at, "branch_id": at[0]}})
        # The calendar they hold at this branch. Without it they log in to a board with no
        # calendar behind it and nothing explains why.
        #
        # Not for a Consultant, who holds ONE branchless calendar however many branches they
        # are posted to — minting a second here is what would let the same person be booked
        # into the same hour at two of them, each record clash-checking only itself.
        profile = expert_profile_type(user["role"]) if holds_calendar_per_branch(user["role"]) else None
        if profile:
            exists = await v3_col("doctors").find_one(
                {"user_id": user_id, "profile_type": profile, "branch_id": branch_id}, {"_id": 0, "id": 1}
            )
            if not exists:
                await v3_col("doctors").insert_one({
                    "id": str(uuid.uuid4()), "full_name": user.get("full_name", ""),
                    "profile_type": profile, "branch_id": branch_id, "specialization": "",
                    "slots": [], "slot_details": [], "user_id": user_id, "created_at": now_iso(),
                })
    else:
        current = user.get("branch_id")
        moved_from = current if current and current != branch_id else None
        await v3_col("users").update_one(
            {"id": user_id}, {"$set": {"branch_id": branch_id, "branch_ids": [branch_id]}}
        )

    return {
        "message": f"{user.get('full_name')} added to {branch.get('branch_name')}",
        # Set only when a single-branch account was taken off somewhere else to come here,
        # so the UI can say so rather than leaving it to be noticed later.
        "moved_from_branch_id": moved_from,
    }


@router.delete("/{branch_id}/team/{user_id}")
async def team_remove_member(branch_id: str, user_id: str, desk: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Take an account off this branch. The account itself is untouched.

    Not a deletion and not a deactivation: they keep their login and their role and simply
    stop being posted here. Switching a person off is a different act, on their own row in
    Roles & Credentials.
    """
    branch, holds = await _team_desk_or_400(branch_id, desk)
    user = await v3_col("users").find_one({"id": user_id}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # The branch's manager of record is held on the branch as well as on the user, so
    # clearing one side would leave the branch still naming somebody who no longer works
    # there. Reassign Manager is the control that changes both together.
    if branch.get("admin_user_id") == user_id:
        raise HTTPException(
            status_code=400,
            detail=f"{user.get('full_name')} is this branch's manager of record. Use Reassign Manager on the Summary tab first.",
        )

    at = _posted_to(user)
    if branch_id not in at:
        raise HTTPException(status_code=400, detail=f"{user.get('full_name')} is not posted to this branch")

    remaining = [b for b in at if b != branch_id]
    await v3_col("users").update_one(
        {"id": user_id},
        {"$set": {"branch_ids": remaining, "branch_id": remaining[0] if remaining else None}},
    )
    # Their calendar at this branch is left alone, the same way HR's own unassign leaves it:
    # it carries published slots and booked appointments, and dropping it to undo a posting
    # would take real bookings with it.
    return {
        "message": f"{user.get('full_name')} removed from {branch.get('branch_name')}",
        "still_at": len(remaining),
    }
