from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from typing import Optional, List, Dict, Any
from pydantic import BaseModel
import os
import re
import uuid

from database import v3_col
from utils import now_iso, live_branch_query
from deps import v3_require_roles, is_diet_role, is_physio_role, is_rehab_role, is_head_physio_role, BRANCH_ADMIN_ROLES, HEAD_PHYSIO_ROLES, LEGACY_CONSULTANT_ROLES, LEGACY_BRANCH_ADMIN_ROLES
from security import hash_password
from email_utils import SmtpNotConfigured, send_email, smtp_status
from schemas.v3 import V3UserOut


router = APIRouter(prefix="/api/v3/hr")


DEFAULT_DEPARTMENTS = ["Pre-Sales", "Branch", "HR", "Accounts", "Operations", "Marketing", "Experts"]

# An employee posted to every branch rather than to one, held in branch_id where a real
# branch id would go. A sentinel rather than a second field: everything that reads an
# employee's branch already reads branch_id, and a parallel "covers everything" flag would
# have to be remembered at every one of those places to stay true.
#
# Underscored so it cannot collide with a uuid, and resolved to a name on the way out like
# any other branch, so a reader never has to know it is a sentinel at all.
ALL_BRANCHES = "__all__"
ALL_BRANCHES_LABEL = "All Branches"
# The branch_admin_* and online_*_admin entries are all Branch Admin, named for the practice
# the person runs — physio, fitness, both, or the online arm. They hold the same board and
# the same reach over one branch. See BRANCH_ADMIN_ROLES in deps.py for why these are fixed
# slugs listed here rather than custom roles: a role whose name is typed by hand cannot be
# aliased to branch_admin safely.
#
# "online_physio" is the same idea one rung down: a Physio who treats over video, on the
# Physio board with the Physio's reach. See PHYSIO_ROLES in deps.py.
#
# "consultant"/"online_consultant" are the consultation desk. They replaced
# "head_physio"/"online_head_physio", which are deliberately absent from this list: a
# designation is a role here and CONSULTANT is the title HR's structure actually carries,
# so those two slugs can no longer be assigned to anybody. Existing accounts on them are
# rewritten by migrate_consultant_roles() in seed.py and both slugs stay recognised in
# HEAD_PHYSIO_ROLES so nothing is locked out in the meantime.
#
# "sales_head" is Pre-Sales' own manager: the same board and the same leads, just the
# org-wide Master View instead of one rep's own book. See PRE_SALES_ROLES in deps.py.
#
# Branch Admin is one entry, not four. The three variants naming a practice —
# branch_admin_physio, _fitness, _physio_fitness — held exactly plain branch_admin's
# permissions, so all four spellings did was ask whoever was filling this form to pick
# between names that behaved identically. Existing accounts are rewritten by
# migrate_branch_admin_roles() in seed.py and the slugs stay recognised in
# BRANCH_ADMIN_ROLES so nothing is locked out in the meantime. The two online admins stay:
# those name the arm, and the online branches are a genuinely separate vertical.
#
# Ordered next to the role each is an alias of, because this list is what the Designation
# and Create User dropdowns render, and a reader picking between them wants the family
# together.
# "hr_admin", "nutritionist" and "zumba" are fixed slugs here rather than roles somebody
# types. All three were created by hand in Credentials, which meant the OS had to guess at
# the wording — is_hr_role, is_diet_role and is_zumba_role in deps.py each match a bag of
# tokens because of it, and this install still ended up with `diet_manage`, a slug the Diet
# board was never written against, whose user logged in to a blank screen. They are
# permanent desks in HR's structure, so they are named once here and matched exactly like
# every other desk. The loose predicates stay as the safety net for accounts the migration
# has not reached; migrate_designation_roles() in seed.py rewrites them.
#
# Ordered by the department each belongs to, because this list is what the Designation and
# Create User dropdowns render, and HR's own structure groups them the same way.
DEFAULT_ROLES = [
    # Management
    "super_admin", "super_admin_pro", "business_dev", "accountant", "hr_admin", "marketing_head",
    # Sales Department
    "sales_head", "pre_sales",
    # Admins
    "branch_admin", "online_physio_admin", "online_fitness_admin",
    # Doctors
    "consultant", "physio", "nutritionist", "online_consultant", "online_physio", "zumba",
]

# The structure HR works to: every department, and the designations under it. Seeded
# additively — a department already there is left exactly as it is, designations included,
# because employees reference their department by name and renaming one out from under
# them would strand the record. See ensure_structure_departments() in seed.py.
STRUCTURE = {
    "Management": [
        "Super Admin", "Super Admin Pro", "Business Development Executive",
        "Accountant", "HR Admin", "Marketing Head",
    ],
    "Admins": ["Branch Admin", "Online Physio Admin", "Online Fitness Admin"],
    "Sales Department": ["Sales Head", "Pre- Sales"],
    "Doctors ( Dr.'s )": [
        "Consultant", "Physiotherapist", "Nutritionist",
        "Online Consultant", "Online Physiotherapist", "Zumba",
    ],
}


def structure_key(name) -> str:
    """A department or designation name reduced to what makes it the same one.

    Compared with punctuation and spacing thrown away, because these names were typed by
    hand and the same department is "Doctors ( Dr.'s )" on one screen and "Doctors (Dr.'s)"
    in a constant. Matching them literally is how a second copy of a department that
    already exists gets created underneath the first.
    """
    return re.sub(r"[^a-z0-9]+", "", str(name or "").strip().lower())


def unique_designations(names) -> list:
    """A department's designation list with one entry per job, order kept.

    The stored list is the authority on order — it is what the Structure tab's drag handles
    write — so the first spelling of a repeated title stays where it is and the later one
    is dropped rather than the list being re-sorted.

    Read-side only, and deliberately: dedupe_department_designations() in seed.py is what
    repairs the stored list, and it also moves the employees carrying a dropped spelling.
    This is here so a list that has picked up a repeat since — or on an install that has not
    booted the migration yet — still reaches the Designation picker as one option per job
    instead of the same title rendered twice with no way to tell them apart.
    """
    seen = set()
    out = []
    for name in (names or []):
        if not isinstance(name, str) or not name.strip():
            continue
        key = structure_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


# Both consultant roles can be assigned to more than one branch (a linked `doctors`
# record is kept in sync per branch) — every other role stays pinned to a single branch.
# Physios are assigned to branches — they deliver treatment where they work, and may cover
# more than one. Head Physios are not: they take consultations across the whole
# organisation, so they get a single branchless expert record and are offered everywhere.
# A Nutrition Coach belongs to a branch and holds a calendar there, exactly like a Physio,
# so hiring one has to create the matching `doctors` record or they log in to a board with
# no calendar behind it and nothing explains why.
MULTI_BRANCH_ROLES = {"physio", "online_physio", "nutrition_coach"}
# Roles that hold ONE expert record, belonging to no branch.
#
# This is a statement about the shape of the record, and it used to be a statement about
# reach as well: a Consultant held one calendar AND was offered at every branch, with the
# second following from the first because a branchless record matched every branch's query.
# Those have come apart. A Consultant is now posted to chosen branches like anybody else —
# the branches live on their login, in branch_ids — while the calendar stays single and
# branchless, because one person has one set of hours and cannot be in two rooms at once.
# See consultants_serving_branch in deps.py, which is what reach is read off now.
#
# Taken from the family in deps.py rather than restated, so a role added there is hired
# correctly here without a second edit — restating it is how `consultant` came to be a role
# nobody could be hired into as one.
SINGLE_CALENDAR_ROLES = set(HEAD_PHYSIO_ROLES)


def holds_calendar_per_branch(role: str) -> bool:
    """Whether a role holds a SEPARATE calendar at each branch it works.

    A Nutritionist is one, exactly like a Physio: they work a branch and may cover more,
    and each branch's days are published on that branch's own record.

    A Consultant is deliberately NOT one, though they too can work several branches. Two
    records for one person means two independent clash checks, so the same Consultant could
    be booked into the same hour at two branches with nothing to catch it. They keep the
    single branchless record in SINGLE_CALENDAR_ROLES above; only where they are OFFERED
    narrows. Ask is_multi_branch_role for that question instead.

    Matched through is_diet_role rather than against the set above, because the slug is
    typed by hand in Roles & Credentials — this install has `diet_manage`, not the
    `nutrition_coach` literal, so the set never caught it and editing that user's branches
    created no calendar at the new one.

    Super Admin is excluded: is_diet_role answers "may this account reach the Diet board",
    which Super Admin may, not "is this person a coach who holds calendars", which they
    are not — hiring already draws that same line.
    """
    r = (role or "").strip().lower()
    if r in MULTI_BRANCH_ROLES:
        return True
    if r == "super_admin":
        return False
    # A rehab therapist holds a calendar at each branch they work, exactly as a
    # Nutritionist does — same reasoning, same shape.
    return is_diet_role(r) or is_rehab_role(r)


def is_multi_branch_role(role: str) -> bool:
    """Whether a role can be posted to more than one branch at a time.

    The wider of the two questions, and the one that drives branch_ids: everybody who holds
    a calendar per branch can, and so can a Consultant, who holds one calendar but may take
    consultations at several branches.

    It used to be the only question, because the two answers were the same for every role.
    They stopped being the same when a Consultant became branch-selective, and the pair that
    had to come apart is exactly this one — reach and record shape. Callers that create or
    stand down per-branch expert records want holds_calendar_per_branch; callers deciding
    whether a branch list is even meaningful want this.

    Kept in step with multiBranchLabel in frontend/src/components/hr/HRBoard.jsx.
    """
    r = (role or "").strip().lower()
    if r == "super_admin":
        return False
    return holds_calendar_per_branch(r) or is_head_physio_role(r)


def is_expert_role(role: str) -> bool:
    """Whether a role holds a `doctors` record at all — per branch, or one branchless."""
    return holds_calendar_per_branch(role) or (role or "").strip().lower() in SINGLE_CALENDAR_ROLES


def expert_profile_type(role: str) -> str:
    """The `doctors.profile_type` an expert record gets for a role.

    Usually the role slug itself, with two exceptions that both have to be. Every physio
    query in the OS — the board's own _resolve_doctor, session assignment, the finance
    scoping check — looks for profile_type "physio", and every diet query looks for
    "nutrition_coach" (COACH in routers/v3_diet.py). Stamping the role's own slug on the
    record instead would create an expert nothing can find, and the role would log in to
    an empty board with no error to explain it — which is what a differently-worded slug
    like `diet_manage` would otherwise get. Hiring writes "nutrition_coach" outright, so
    this keeps the records written on an edit and on a role change identical to those.
    """
    if is_physio_role(role):
        return "physio"
    # Every consultation query looks for profile_type "head_physio" — the Consultant
    # calendar lists on it, and the board resolves its own expert by it — so an Online
    # Consultant is stamped with the type, not with their own slug. Same reason
    # online_physio is stamped "physio".
    if is_head_physio_role(role):
        return "head_physio"
    if (role or "").strip().lower() == "super_admin":
        return role
    if is_diet_role(role):
        return "nutrition_coach"
    # Every rehab query looks for profile_type "rehab" — the Rehab Calendar lists on
    # it — so a differently-worded slug is stamped with the type, not with itself.
    if is_rehab_role(role):
        return "rehab"
    return role


# Three titles in STRUCTURE do not slugify to the role that already runs their desk:
# "Business Development Executive" is business_dev, and the two physiotherapist titles are
# physio and online_physio. Without this, minting a role per designation would create
# business_development_executive and physiotherapist beside them — a second, permissionless
# copy of a desk that already exists, offered in the same picker as the real one.
DESIGNATION_ROLE_ALIASES = {
    "business_development_executive": "business_dev",
    "physiotherapist": "physio",
    "online_physiotherapist": "online_physio",
}


def _slugify_role(label: str) -> str:
    """The role slug a designation names.

    A designation and a role are one thing here, so this is how a job title becomes the
    thing an account is gated on. Aliases are resolved on the way out — see
    DESIGNATION_ROLE_ALIASES for the three titles whose desk already has a shorter name.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return DESIGNATION_ROLE_ALIASES.get(slug, slug)


async def _custom_roles() -> list:
    return await v3_col("custom_roles").find({}, {"_id": 0}).sort("created_at", 1).to_list(200)


async def _all_role_names() -> list:
    """Every role that can be assigned, each one once.

    A custom role created under a name a built-in already uses came back twice — the same
    role listed as two, which is what put two ONLINE PHYSIO rows in the role filter with no
    way to tell them apart. Nothing broke, but a filter offering the same answer twice makes
    the reader look for a difference that is not there.

    Matched case- and space-insensitively, since a custom role is typed by hand and
    "Online Physio" is not a second role from "online_physio". The built-in spelling wins
    where both exist: it is the one the rest of the OS branches on.
    """
    # The built-ins first and in their own order, which is HR's structure read top to
    # bottom — Management, Sales, Admins, Doctors — because that is the order the person
    # reading this picker knows the roles in. Anything left over is a role somebody typed,
    # and those go after, alphabetically: they arrive in creation order otherwise, which is
    # no order at all to the reader and is why the picker looked shuffled.
    seen = set()
    builtin = []
    custom = []
    for name, is_builtin in (
        [(n, True) for n in DEFAULT_ROLES] + [(r["name"], False) for r in await _custom_roles()]
    ):
        key = str(name or "").strip().lower().replace(" ", "_")
        if not key or key in seen:
            continue
        seen.add(key)
        (builtin if is_builtin else custom).append(name)
    custom.sort(key=lambda n: str(n or "").strip().lower())
    return builtin + custom


async def ensure_roles_for_designations() -> None:
    """Every job title in the structure is also a role somebody can be given.

    A designation and a role are the same thing here — the title a person holds is what
    their login is — but they were stored in two places that only met when a user was
    created: Create User resolved a designation to a role and minted one if there was none.
    So a title nobody had been hired into yet existed on one screen and not the other, and
    the two lists drifted apart a title at a time.

    Runs at startup and is safe to repeat: it skips any slug that is already a role, whether
    built-in or custom, so a second pass writes nothing. It never removes or renames
    anything — a role that no designation matches is left alone, because roles like
    super_admin are access levels rather than job titles and belong to nobody's department.

    Creating the role grants no page access on its own, exactly as creating one by hand
    does not. It makes the title assignable, which is the thing that was missing.
    """
    departments = await v3_col("hr_departments").find({}, {"_id": 0, "designations": 1}).to_list(500)
    titles = []
    for d in departments:
        for name in (d.get("designations") or []):
            if isinstance(name, str) and name.strip():
                titles.append(name.strip())
    if not titles:
        return

    existing = {str(n).strip().lower() for n in await _all_role_names()}
    # The retired consultation slugs are never minted again, however a title is spelled.
    # A department still listing "Head Physio" would otherwise put head_physio back in the
    # Create User picker every boot, one pass behind migrate_consultant_roles renaming it
    # away — a role the OS has retired, reappearing in the one place it is handed out.
    existing |= set(LEGACY_CONSULTANT_ROLES)
    # And the retired Branch Admin variants, for the same reason. A department still
    # listing "Branch Admin ( Physio )" would otherwise mint branch_admin_physio again at
    # every boot, one pass behind migrate_branch_admin_roles collapsing it away.
    existing |= set(LEGACY_BRANCH_ADMIN_ROLES)
    now = now_iso()
    fresh = []
    for title in titles:
        slug = _slugify_role(title)
        # Checked against what has been added in this pass too, or two departments holding
        # the same title would each try to create it.
        if not slug or slug in existing:
            continue
        existing.add(slug)
        fresh.append({
            "id": str(uuid.uuid4()),
            "name": slug,
            "label": title.upper(),
            "color": "slate",
            "created_at": now,
        })
    if fresh:
        await v3_col("custom_roles").insert_many(fresh)


async def _seeded_departments() -> list:
    """The 7 departments this app already shipped with (previously a hardcoded
    constant, never a real collection) — seeded once so "Add Department" grows this
    list instead of replacing it, and existing employees' `department` values keep
    matching something. Designations are grouped into each department from here on,
    starting empty until a Super Admin assigns the existing designations manually."""
    if await v3_col("hr_departments").count_documents({}) == 0:
        now = now_iso()
        await v3_col("hr_departments").insert_many([
            {"id": str(uuid.uuid4()), "name": name, "designations": [], "created_at": now}
            for name in DEFAULT_DEPARTMENTS
        ])
    return await v3_col("hr_departments").find({}, {"_id": 0}).sort("created_at", 1).to_list(500)


# The hues the built-in roles already wear. A custom role picks from the same set rather
# than a free hex, so one added today can't arrive in a colour nothing else in the OS uses
# — and so the value can be checked here instead of trusting whatever the client sends.
ROLE_COLORS = [
    "purple", "indigo", "sky", "emerald", "amber",
    "cyan", "pink", "orange", "rose", "teal", "slate",
]


class CustomRoleCreate(BaseModel):
    label: str
    color: Optional[str] = None


class DepartmentCreate(BaseModel):
    name: str


class DesignationCreate(BaseModel):
    name: str


class DesignationRename(BaseModel):
    old_name: str
    new_name: str
    # Renaming onto a name the department already has is a merge, not a clash: the two are
    # the same job spelled twice — "Consultants" beside "CONSULTANT" — and what is wanted
    # is one of them holding everybody. Refused unless asked for, because it drops a
    # designation and moves people, and neither should happen from a typo.
    merge: bool = False


class DesignationReorder(BaseModel):
    designations: List[str]


class EmployeeCreate(BaseModel):
    full_name: str
    email: Optional[str] = ""
    phone: Optional[str] = ""
    dob: Optional[str] = ""
    gender: Optional[str] = ""
    blood_group: Optional[str] = ""
    marital_status: Optional[str] = ""
    father_name: Optional[str] = ""
    mother_name: Optional[str] = ""
    # Where the uploaded photo landed, as a path this app serves ("/api/v3/uploads/...").
    # The file itself goes up separately, before the record is saved — see upload-photo.
    photo_url: Optional[str] = ""
    department: Optional[str] = ""
    designation: Optional[str] = ""
    # Neither is required — an employee can be tagged Online/Offline with no specific
    # branch picked yet, or left unset entirely.
    # "both" is the same kind of answer it is for service below — not a third mode, but
    # the one that declines to narrow, so every branch of either mode is theirs.
    work_type: Optional[str] = ""  # "online" | "offline" | "both" | ""
    # Which practice this person works. A branch's vertical is the two answers together —
    # offline_physiotherapy is work_type "offline" and service "physio" — so this is the
    # second axis of the same question, and the Branch picker narrows on both. "both" is
    # somebody who covers the two practices and so is offered every branch of their mode.
    # Recorded on the employee only: what an account may reach still comes from its role,
    # which already carries the practice for admins (branch_admin_physio, _fitness).
    service: Optional[str] = ""  # "physio" | "fitness" | "both" | ""
    branch_id: Optional[str] = ""  # from Branches & Verticals — filtered client-side by work_type and service
    joining_date: Optional[str] = ""
    reporting_to: Optional[str] = ""
    employee_code: Optional[str] = ""
    pan: Optional[str] = ""
    aadhar: Optional[str] = ""
    address: Optional[str] = ""
    emergency_contact_name: Optional[str] = ""
    emergency_contact_phone: Optional[str] = ""
    net_salary: Optional[float] = 0
    gross_salary: Optional[float] = 0
    bank_name: Optional[str] = ""
    bank_account: Optional[str] = ""
    ifsc: Optional[str] = ""
    status: Optional[str] = "active"
    notes: Optional[str] = ""


class EmployeeUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    dob: Optional[str] = None
    gender: Optional[str] = None
    blood_group: Optional[str] = None
    marital_status: Optional[str] = None
    father_name: Optional[str] = None
    mother_name: Optional[str] = None
    # "" clears the photo; None (the default) leaves whatever is stored alone. update_employee
    # drops None values, so an empty string is the only way to say "remove it".
    photo_url: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    work_type: Optional[str] = None
    service: Optional[str] = None  # "physio" | "fitness" | "both" | ""
    branch_id: Optional[str] = None
    # Only meaningful for a role that holds a calendar at each of several branches — a
    # Nutritionist or a Physio. Sent instead of branch_id, never alongside it: update_employee
    # derives the single branch_id from this list so every single-branch filter in the OS
    # keeps reading the field it always has. An empty list is "no branch"; the one-element
    # list [ALL_BRANCHES] is "covers every branch", which is stored branchless downstream.
    branch_ids: Optional[List[str]] = None
    joining_date: Optional[str] = None
    reporting_to: Optional[str] = None
    employee_code: Optional[str] = None
    pan: Optional[str] = None
    aadhar: Optional[str] = None
    address: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    net_salary: Optional[float] = None
    gross_salary: Optional[float] = None
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    ifsc: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class UserAccountCreate(BaseModel):
    full_name: str
    email: str
    password: str
    # Not a Literal — the allowed set now includes custom roles added at runtime
    # via POST /hr/roles, so membership is checked in the handler instead.
    role: str
    employee_id: Optional[str] = None
    branch_id: Optional[str] = None
    # Only meaningful for the consultant and physio roles — lets one be assigned across
    # several branches. branch_id above stays the primary/first branch so every other
    # single-branch filter in the app keeps working unchanged.
    branch_ids: Optional[List[str]] = None
    mobile_number: Optional[str] = None
    aadhar_number: Optional[str] = None
    # No role normalisation here on purpose — see the note on V3UserOut in schemas/v3.py.
    # "consultant" used to be rewritten to "physio" on the way in, so creating a
    # CONSULTANT silently created a treating physio instead and the role could never
    # actually be held by anybody. It is now a real slug and must be stored as typed.


class UserAccountUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    employee_id: Optional[str] = None
    branch_id: Optional[str] = None
    branch_ids: Optional[List[str]] = None
    mobile_number: Optional[str] = None
    aadhar_number: Optional[str] = None


async def _next_emp_code() -> str:
    last = await v3_col("employees").find({"employee_code": {"$regex": "^EMP[0-9]+$"}}, {"_id": 0, "employee_code": 1}).sort("employee_code", -1).limit(1).to_list(1)
    if last:
        try:
            n = int(last[0]["employee_code"][3:]) + 1
        except Exception:
            n = (await v3_col("employees").count_documents({})) + 1
    else:
        n = 1
    return f"EMP{n:04d}"


# ---------- Dashboard ----------

@router.get("/dashboard")
async def hr_dashboard(_: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev"))):
    active_employees = await v3_col("employees").count_documents({"status": "active"})
    total_users = await v3_col("users").count_documents({"is_active": True})

    dept_pipeline = [{"$group": {"_id": "$department", "n": {"$sum": 1}}}]
    rows = await v3_col("employees").aggregate(dept_pipeline).to_list(50)
    by_dept: Dict[str, int] = {}
    for r in rows:
        key = r["_id"] or "Unassigned"
        by_dept[key] = r["n"]
    departments_count = len([k for k in by_dept.keys() if k != "Unassigned"])

    salary_pipeline = [{"$match": {"status": "active"}}, {"$group": {"_id": None, "total": {"$sum": "$net_salary"}}}]
    salary_rows = await v3_col("employees").aggregate(salary_pipeline).to_list(1)
    monthly_salary = salary_rows[0]["total"] if salary_rows else 0

    # Real figures now that HR keeps a register: see routers/v3_hr_ops.py, which owns the
    # marks these count and the statuses they are named after. Imported inside the handler
    # because that module imports resolve_employee_branches from this one at module scope,
    # so a top-level import here would close the loop and neither would load.
    from routers.v3_hr_ops import ABSENT, LATE, PENDING, PRESENT
    from utils import clinic_today

    today = clinic_today()
    # Late counts inside present, not against it. Somebody who arrived at 09:40 is at work,
    # so "Present Today" is both marks together and "Late Today" is the subset of it --
    # otherwise the two tiles would read as if the late ones never turned up at all.
    present_today = await v3_col("attendance").count_documents({"date": today, "status": {"$in": [PRESENT, LATE]}})
    late_today = await v3_col("attendance").count_documents({"date": today, "status": LATE})
    # Only people marked absent on today's register -- nobody is counted absent for simply
    # not having been marked yet, or the tile would read high every morning.
    absent_today = await v3_col("attendance").count_documents({"date": today, "status": ABSENT})
    pending_leaves = await v3_col("approvals").count_documents({"status": PENDING})

    return {
        "kpis": {
            "active_employees": active_employees,
            "total_users": total_users,
            "present_today": present_today,
            "late_today": late_today,
            "absent_today": absent_today,
            "pending_leaves": pending_leaves,
            "monthly_salary_budget": monthly_salary,
            "departments": departments_count,
        },
        "department_strength": [{"name": k, "count": v} for k, v in by_dept.items()],
    }


# ---------- Employees CRUD ----------

async def _next_emp_code_legacy() -> str:
    cnt = await v3_col("employees").count_documents({})
    return f"EMP{(cnt + 1):04d}"


async def resolve_employee_branches(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Put a readable branch on each employee row, in place, and hand them back.

    Shared because two screens ask this and the answer has to be the same one: the
    Employees tab lists it, and the attendance register filters by it (see _roster in
    routers/v3_hr_ops.py). A second implementation would have "Anna Nagar" on one screen
    and "No branch" on the other for the same person, and both would look right in
    isolation.

    branch_name is denormalized onto the response only -- the record itself keeps just
    branch_id, so a branch rename never needs a matching pass over every employee that
    points at it.
    """
    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    bmap = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    # Where the employee record carries no branch, the linked account is asked. The two
    # halves are one person, and the account is the half that decides what they can
    # actually see -- an employee row reading "No branch" above an account scoped to Anna
    # Nagar is the record disagreeing with itself, not a fact about the person.
    #
    # Read-time rather than a migration: the write-time cascades keep the two in step from
    # here on, and this covers everyone who was already out of step without rewriting
    # records to say something nobody typed.
    blank = [r["id"] for r in rows if not r.get("branch_id")]
    from_account: Dict[str, str] = {}
    if blank:
        accounts = await v3_col("users").find(
            {"employee_id": {"$in": blank}}, {"_id": 0, "employee_id": 1, "branch_id": 1, "branch_ids": 1},
        ).to_list(2000)
        for a in accounts:
            picked = a.get("branch_id") or next(iter(a.get("branch_ids") or []), "")
            if picked:
                from_account.setdefault(a["employee_id"], picked)

    for r in rows:
        bid = r.get("branch_id") or from_account.get(r["id"], "")
        # A multi-branch desk can hold several, and the row has one line to say so. Named
        # while there are two, counted past that: "Anna Nagar + T Nagar" is the answer
        # somebody wants and still fits, where five names do not and would be truncated to
        # something that reads like one branch.
        covered = [b for b in (r.get("branch_ids") or []) if b and b != ALL_BRANCHES]
        if bid == ALL_BRANCHES:
            r["branch_name"] = ALL_BRANCHES_LABEL
        elif len(covered) > 1:
            names = [bmap.get(b, "") for b in covered if bmap.get(b)]
            r["branch_name"] = " + ".join(names) if len(names) == 2 else f"{len(covered)} branches"
        else:
            r["branch_name"] = bmap.get(bid, "") if bid else ""
        # Reported as the branch it is, so the row and its Change control agree on what is
        # being changed. The stored record is left untouched.
        r["branch_id"] = bid
    return rows


@router.get("/employees")
async def list_employees(status: Optional[str] = None, _: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev"))):
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    rows = await v3_col("employees").find(q, {"_id": 0}).sort("created_at", -1).to_list(2000)
    return await resolve_employee_branches(rows)


# Employee photos live beside the store's item images, under the `uploads/` tree server.py
# already serves as static files. Deliberately not with the patient documents, which are
# kept out of that tree and streamed through an authenticated route instead: those are
# medical records, where a staff headshot is the same kind of thing as a product photo.
PHOTO_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads", "employees")
os.makedirs(PHOTO_DIR, exist_ok=True)

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_PHOTO_BYTES = 5 * 1024 * 1024


@router.post("/employees/upload-photo")
async def upload_employee_photo(
    file: UploadFile = File(...),
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Store one employee photo and answer with the path to it.

    Separate from saving the employee because the file has to exist before the record can
    point at it. The form only calls this when it is submitted, so abandoning the dialog
    leaves nothing behind, and a refused upload stops the save rather than writing an
    employee whose photo silently didn't take.

    Same gate as create/update employee: whoever may edit the record may set its picture.
    """
    return {"url": await save_photo(file)}


async def save_photo(file: UploadFile) -> str:
    """Check one uploaded headshot, write it under PHOTO_DIR, and answer with its served path.

    Shared with My Profile's own upload (routers/v3_me.py), so a photo somebody sets on
    themselves passes the same checks and lands in the same place as one HR sets for them.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only JPG, PNG or WEBP images are allowed")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="That file is empty")
    if len(contents) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="Photo must be under 5MB")
    # A fresh name every upload rather than one keyed on the employee: replacing a photo
    # must not leave browsers and this app's own <img> tags showing the old one from cache.
    filename = f"{uuid.uuid4()}{ext}"
    with open(os.path.join(PHOTO_DIR, filename), "wb") as f:
        f.write(contents)
    return f"/api/v3/uploads/employees/{filename}"


MODE_ONLINE = "online"
PRACTICE_BOTH = "both"

# Which practice a vertical names, read off its own tokens rather than matched whole.
# A vertical is mode and practice together — online_physiotherapy is mode "online" and
# practice "physio" — and this is the second half of it. Whole underscore-separated tokens,
# like the role predicates in deps.py, so a name added by hand cannot be caught on a
# substring. Kept in step with verticalPractice in frontend/src/components/hr/HRBoard.jsx.
VERTICAL_PRACTICES = {
    "physio": "physio",
    "physiotherapy": "physio",
    "fitness": "fitness",
    "gym": "fitness",
}


def _vertical_practice(vertical) -> Optional[str]:
    for token in str(vertical or "").lower().split("_"):
        if token in VERTICAL_PRACTICES:
            return VERTICAL_PRACTICES[token]
    return None


async def _online_arm_branch_ids(service: str) -> List[str]:
    """The branches of the online arm this Service names.

    Online is not one place. It is two arms sold separately, run by two admins and holding
    two calendars — Online Physiotherapy and Online Fitness — so an employee marked Online
    has not yet said where they work, and Service is the half of the answer that says it.
    Physio posts them to the physiotherapy arm, Fitness to the fitness one.

    "both" declines to narrow and takes both, which is what it means everywhere else on
    this record. So does a vertical this cannot read a practice from: an arm added by hand
    under an unrecognised name must stay reachable rather than quietly dropping its people,
    the same rule the branch picker on the Employment tab already follows.

    Offline is deliberately not answered here. A room has an address and somebody chooses
    it in the Branch picker; this exists because the online arms have no picker to choose
    from — the field is not asked for once Online is set, on the grounds that an online
    employee is not AT a branch, and that left them posted nowhere at all.
    """
    rows = await v3_col("branches").find(
        live_branch_query(), {"_id": 0, "id": 1, "vertical": 1},
    ).to_list(500)
    wanted = str(service or "").strip().lower()
    out = []
    for b in rows:
        vertical = b.get("vertical")
        if not str(vertical or "").startswith("online_"):
            continue
        practice = _vertical_practice(vertical)
        if wanted in ("", PRACTICE_BOTH) or practice is None or practice == wanted:
            out.append(b["id"])
    return out


async def _apply_online_arm(updates: dict, work_type, service) -> None:
    """Post an Online employee to their arm, in place on the update being written.

    Service is required for them and checked here rather than only in the form, because
    without it there is no answer to which arm — and until this existed, saving an Online
    employee did worse than leave the question open. The Employment tab clears the Branch
    field on the way to Online, which arrives as an empty branch_id, which the cascade below
    reads as "taken off their branch" and writes through to their login. An Online
    Consultant saved from HR was being un-posted from the arm they work, disappearing from
    its Team and from the Consultant Calendar that now reads it.

    Only where work_type is actually part of this save. A partial update that never mentions
    it is not a statement about the arm and must not repost anybody.
    """
    if str(work_type or "").strip().lower() != MODE_ONLINE:
        return
    if not str(service or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Service is required for an Online employee — it decides which arm they work",
        )
    arm = await _online_arm_branch_ids(service)
    updates["branch_ids"] = arm
    updates["branch_id"] = arm[0] if arm else ""


@router.post("/employees")
async def create_employee(payload: EmployeeCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    # Department and Designation are what every downstream view groups and colour-codes
    # employees by, so an employee without them is unusable — required at the API too,
    # not just in the form.
    if not (payload.department or "").strip():
        raise HTTPException(status_code=400, detail="Department is required")
    if not (payload.designation or "").strip():
        raise HTTPException(status_code=400, detail="Designation is required")
    doc = payload.model_dump()
    # Online is two arms, and Service says which. Posts them there in place of the Branch
    # the Employment tab stops asking for once Online is picked — see _apply_online_arm.
    await _apply_online_arm(doc, doc.get("work_type"), doc.get("service"))
    doc["id"] = str(uuid.uuid4())
    doc["employee_code"] = doc.get("employee_code") or await _next_emp_code()
    doc["status"] = doc.get("status") or "active"
    doc["created_at"] = now_iso()
    doc["updated_at"] = now_iso()
    await v3_col("employees").insert_one(doc.copy())
    return doc


async def _sync_expert_branches(user: dict, branch_ids: List[str]) -> None:
    """Make a multi-branch desk's expert records say exactly which branches they cover.

    Three things, because a branch list can change in three ways. A branch newly ticked
    gets a record, or the coach is offered at a branch whose Diet Calendar has nowhere to
    publish days. A branch still ticked is made active again, so re-ticking one restores
    the calendar that was there rather than starting an empty second one beside it.

    And a branch unticked is stood down, not deleted. The published slots and the
    appointments already sitting on them are real bookings that somebody made — an untick
    is a statement about where this person works from now on, not permission to throw those
    away — so the record stays and simply stops being offered, which every list already
    honours through active_doctor_query. Ticking the branch again brings it back intact.
    """
    profile = expert_profile_type(user["role"])
    existing = await v3_col("doctors").find(
        {"user_id": user["id"], "profile_type": profile}, {"_id": 0, "id": 1, "branch_id": 1},
    ).to_list(100)
    have = {d.get("branch_id") for d in existing}

    for b_id in branch_ids:
        if b_id not in have:
            await v3_col("doctors").insert_one({
                "id": str(uuid.uuid4()),
                "full_name": user.get("full_name") or "",
                "profile_type": profile,
                "branch_id": b_id,
                "specialization": "",
                "slots": [],
                "slot_details": [],
                "user_id": user["id"],
                "branch_active": True,
                "created_at": now_iso(),
            })

    # branch_active, not is_active: the second belongs to the login and is rewritten at
    # every startup by retire_experts_without_a_login, which would read a branch untick as
    # a mistakenly retired expert and put them back. See ACTIVE_DOCTOR in utils.py.
    keep = [d["id"] for d in existing if d.get("branch_id") in branch_ids]
    if keep:
        await v3_col("doctors").update_many(
            {"id": {"$in": keep}}, {"$set": {"branch_active": True, "updated_at": now_iso()}},
        )

    # Only records that name a branch. A branchless one belongs to a desk that covers
    # everything and is not this list's to stand down.
    drop = [
        d["id"] for d in existing
        if d.get("branch_id") and d["branch_id"] not in branch_ids
    ]
    if drop:
        await v3_col("doctors").update_many(
            {"id": {"$in": drop}}, {"$set": {"branch_active": False, "updated_at": now_iso()}},
        )


async def _consultant_login_without_a_link(emp_id: str) -> list:
    """The Consultant login belonging to an employee whose account carries no link to them.

    Create User's link to an employee is optional, and the two screens are filled in months
    apart, so a Consultant hired in HR and given a login later has an account with no
    employee_id on it. Every cascade in update_employee keys off that link. With it missing,
    posting such a person to a branch wrote their employee row and did nothing whatever to
    the account — HR printing "Parrys Branch" on the row while that branch's Consultant
    Calendar stayed empty, and neither screen saying why. The write reported success,
    because as far as it was concerned there was nothing to cascade to.

    Consultants only, exactly as backfill_consultant_branches_from_employees in seed.py is,
    and for the same reason: their branches live nowhere but this cascade. Every other desk
    carries a branch on its login from the moment Create User writes one, so no other desk
    is sitting waiting to be told.

    A name is accepted only when it resolves to exactly ONE active consultant login that is
    not already linked to somebody. A name shared by two accounts says nothing about which
    of them is this person; a namesake on another desk is not this person at all; and an
    account already linked to a different employee belongs to that employee, not this one.
    All three are dropped rather than guessed at, because the cost of guessing here is
    moving someone else's account to a branch they do not work.
    """
    emp = await v3_col("employees").find_one(
        {"id": emp_id}, {"_id": 0, "full_name": 1, "designation": 1},
    )
    if not emp:
        return []
    key = str(emp.get("full_name") or "").strip().lower()
    # The designation is what says this employee is on this desk at all. Read through
    # _slugify_role so "CONSULTANT" and consultant are the one answer they are everywhere
    # else, and checked against the same family the logins are selected on below.
    if not key or _slugify_role(str(emp.get("designation") or "")) not in HEAD_PHYSIO_ROLES:
        return []

    found = []
    async for u in v3_col("users").find(
        {"role": {"$in": sorted(HEAD_PHYSIO_ROLES)}, "is_active": True},
        {"_id": 0, "id": 1, "role": 1, "full_name": 1, "employee_id": 1},
    ):
        if u.get("employee_id"):
            continue
        if str(u.get("full_name") or "").strip().lower() == key:
            found.append(u)
    return found if len(found) == 1 else []


@router.patch("/employees/{emp_id}")
async def update_employee(emp_id: str, payload: EmployeeUpdate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No updates")
    # Omitting these on a partial update is fine; explicitly clearing them is not — an
    # existing employee must not be left without a department or designation.
    for field, label in (("department", "Department"), ("designation", "Designation")):
        if field in updates and not str(updates[field]).strip():
            raise HTTPException(status_code=400, detail=f"{label} is required")

    # Online is two arms, and Service says which. Before the branch block below rather than
    # instead of it: this decides the list, and that block is what reduces any list to the
    # primary branch_id every single-branch filter in the OS still reads.
    #
    # Only when work_type is part of this save. Service can be left out of it — a partial
    # update that moves somebody Online without restating a practice they already hold is a
    # normal edit — so the stored one answers where the payload is silent.
    if "work_type" in updates:
        service = updates.get("service")
        if service is None:
            stored = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0, "service": 1})
            service = (stored or {}).get("service")
        await _apply_online_arm(updates, updates["work_type"], service)

    # A Nutritionist or a Physio holds a calendar at each branch they work, so the branch
    # picker sends a list. Every other filter in the OS still reads the single branch_id,
    # so the list is reduced to a primary here and the two are written together — the
    # record can never hold a list its own branch_id disagrees with.
    #
    # ALL_BRANCHES swallows the rest of the selection rather than sitting alongside it:
    # "everywhere" and "these three" cannot both be true, and keeping the narrower ticks
    # underneath would suggest the wider answer was somehow limited by them.
    branch_ids = updates.get("branch_ids")
    if branch_ids is not None:
        branch_ids = [b for b in branch_ids if b]
        if ALL_BRANCHES in branch_ids:
            branch_ids = [ALL_BRANCHES]
        updates["branch_ids"] = branch_ids
        updates["branch_id"] = branch_ids[0] if branch_ids else ""
    elif "branch_id" in updates:
        # One branch posted on its own is the whole answer, so any list left over from when
        # this person held a multi-branch desk is cleared with it. Left behind, it would go
        # on driving the "two branches" the row prints while branch_id says one — the record
        # contradicting itself, which is the shape of bug this pair keeps producing.
        #
        # Only the employee record. `branch_ids` stays None on purpose, so the cascades
        # below still read this as the plain move it is: the account's own list is chosen
        # on the user form and is not this control's to empty.
        updates["branch_ids"] = []

    updates["updated_at"] = now_iso()
    res = await v3_col("employees").update_one({"id": emp_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Employee not found")
    # Both cascades want the same list, so it is fetched once and only when one of them
    # actually has something to do.
    # The role comes back with them: what a branch change has to do to the expert records
    # depends on whether this person is a desk that holds calendars, and if so which
    # profile_type those records carry.
    linked_users = (
        await v3_col("users").find(
            {"employee_id": emp_id}, {"_id": 0, "id": 1, "role": 1, "full_name": 1},
        ).to_list(20)
        if ("full_name" in updates or "branch_id" in updates)
        else []
    )
    linked_user_ids = [u["id"] for u in linked_users]

    # Where the link found nothing, the name is tried — for a branch change, and only for a
    # Consultant. See _consultant_login_without_a_link for why that is the one desk this
    # matters to and why the match has to be unambiguous.
    #
    # Deliberately NOT extended to the rename above. Matching an account by its name in
    # order to change that name is circular: the second rename would have nothing left to
    # match on, so the repair would work once and then silently stop.
    if not linked_user_ids and "branch_id" in updates:
        by_name = await _consultant_login_without_a_link(emp_id)
        if by_name:
            linked_users = by_name
            linked_user_ids = [u["id"] for u in by_name]
            # The link is written back FIRST, and not only to save the next save the same
            # search. Every cascade below filters on {"employee_id": emp_id} — without the
            # link on the account those filters match nothing, so this write is what makes
            # the rest of this function reach the login the name just found.
            await v3_col("users").update_many(
                {"id": {"$in": linked_user_ids}}, {"$set": {"employee_id": emp_id}},
            )

    if "full_name" in updates and linked_user_ids:
        # Cascade the rename to any linked User account, and from there to their doctors
        # record too — full_name is denormalized across employees/users/doctors.
        await v3_col("users").update_many({"employee_id": emp_id}, {"$set": {"full_name": updates["full_name"]}})
        await v3_col("doctors").update_many({"user_id": {"$in": linked_user_ids}}, {"$set": {"full_name": updates["full_name"]}})

    if "branch_id" in updates and linked_user_ids:
        # Moving an employee has to move the login with them, or the record says one branch
        # and the account they sign in with still scopes to another. The account is the half
        # that decides what they can actually see.
        #
        # ALL_BRANCHES has no equivalent on a user: covering everything is said there by
        # holding no branches at all, which list_users reads back as org-wide for the roles
        # that can be. So it clears, and so does an employee taken off their branch — an
        # account with no branch reads nothing rather than being handed somebody else's,
        # which is the safe direction for this to fail in.
        target = "" if updates["branch_id"] in (ALL_BRANCHES, "") else updates["branch_id"]
        account: Dict[str, Any] = {"branch_id": target}

        # branch_ids is written through only when a list was actually posted. A single
        # branch_id arriving on its own still leaves it alone, for the reason it always
        # has: a CONSULTANT or Physio can cover several branches, chosen on the user form,
        # and flattening that considered selection down to the one field an employee row
        # holds would lose what somebody set on purpose.
        #
        # A posted list is not that case — it IS the considered selection, made in the
        # branch picker rather than on the user form — so it is what the account should
        # read. ALL_BRANCHES has no equivalent on a user: covering everything is said
        # there by holding no branches at all, which is how list_users and the expert
        # queries both already read org-wide.
        if branch_ids is not None:
            account["branch_ids"] = [] if branch_ids == [ALL_BRANCHES] else branch_ids
        await v3_col("users").update_many({"employee_id": emp_id}, {"$set": account})

        # A selection of several branches is a different instruction to the expert records
        # than a move between two, so the two are handled apart rather than one being made
        # to stand in for the other. Sharing the move below is what would break here: it
        # rewrites every branch-carrying record to one branch, which for somebody holding a
        # calendar at three would collapse all three onto the first and leave two branches
        # with a Nutritionist that has no calendar there any more.
        if branch_ids is not None and branch_ids != [ALL_BRANCHES] and branch_ids:
            for u in linked_users:
                # holds_calendar_per_branch, not is_multi_branch_role. The two answered the
                # same for every role until a Consultant became branch-selective, and this
                # line was written while they still did: posting a Consultant to a branch
                # then minted a per-branch record beside the single branchless one they are
                # meant to have, and the calendar listed them twice — once per record —
                # while the booking popup offered the empty duplicate as a second choice.
                #
                # A Consultant is posted by branch_ids alone; their diary does not move.
                if not holds_calendar_per_branch(u.get("role")):
                    continue
                await _sync_expert_branches(u, branch_ids)
        else:
            # The expert record moves only if it was posted to a branch to begin with. A Head
            # Physio's is branchless by design (see consolidate_head_physio_doctors), and giving
            # it a branch would undo that and hide them from every other one.
            #
            # Branchless is also what ALL_BRANCHES resolves to, and for the desks that may hold
            # none — a CONSULTANT, a Nutritionist — that is not a record with a gap in it but
            # the way this OS spells "every branch": ORG_WIDE_PROFILES in routers/v3_config.py
            # and _coach_branch_ids in routers/v3_diet.py both read it that way.
            await v3_col("doctors").update_many(
                {"user_id": {"$in": linked_user_ids}, "branch_id": {"$nin": ["", None]}},
                {"$set": {"branch_id": target}},
            )
            # Somebody put back on every branch is offered at every branch again, including
            # the ones a narrower selection had earlier stood them down from. Only the
            # posting flag is lifted — a login that is switched off stays switched off, and
            # this is not the screen that decides that.
            if branch_ids == [ALL_BRANCHES]:
                await v3_col("doctors").update_many(
                    {"user_id": {"$in": linked_user_ids}, "branch_active": False},
                    {"$set": {"branch_active": True, "updated_at": now_iso()}},
                )

    return await v3_col("employees").find_one({"id": emp_id}, {"_id": 0})


@router.delete("/employees/{emp_id}")
async def delete_employee(emp_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("employees").delete_one({"id": emp_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Employee not found")
    # Unlink any users tied to this employee
    await v3_col("users").update_many({"employee_id": emp_id}, {"$set": {"employee_id": None}})
    return {"message": "Employee deleted"}


# ---------- Roles & Credentials ----------

@router.get("/users")
async def list_users(search: Optional[str] = None, role: Optional[str] = None, _: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev"))):
    q: Dict[str, Any] = {}
    if role and role != "all":
        # A comma-separated list asks for a family of roles at once. The consultation desk
        # is spread over four slugs — `consultant` and `online_consultant`, plus the two
        # legacy ones migrate_consultant_roles() has not necessarily reached — so a caller
        # that wants "the consultants" cannot name one and be right. HR's own role filter
        # still passes a single slug and still matches exactly.
        wanted = [r.strip() for r in str(role).split(",") if r.strip()]
        q["role"] = wanted[0] if len(wanted) == 1 else {"$in": wanted}
    if search:
        rgx = {"$regex": search, "$options": "i"}
        q["$or"] = [{"full_name": rgx}, {"email": rgx}]
    rows = await v3_col("users").find(q, {"_id": 0, "password": 0}).sort("created_at", -1).to_list(1000)
    # Enrich with linked employee
    emp_ids = [r.get("employee_id") for r in rows if r.get("employee_id")]
    emps = {}
    if emp_ids:
        async for emp in v3_col("employees").find({"id": {"$in": emp_ids}}, {"_id": 0}):
            emps[emp["id"]] = {
                "employee_code": emp.get("employee_code"),
                "designation": emp.get("designation"),
                "department": emp.get("department"),
                "full_name": emp.get("full_name"),
            }
    # Which branch each account belongs to. Three different answers are possible and the
    # column has to tell them apart, so the shape is a list plus a flag rather than one
    # string that would have to mean all of them:
    #
    #   org-wide      a CONSULTANT who has been given no branches covers every one. An
    #                 empty branch list on them means "all", not "none" — which is why it
    #                 is a flag rather than a dash.
    #   multi-branch  a CONSULTANT, Physio or Nutrition Coach can serve several, held in
    #                 branch_ids.
    #   single        everyone else, on branch_id.
    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    bmap = {b["id"]: b.get("branch_name", "") for b in branch_docs}
    for r in rows:
        r["linked_employee"] = emps.get(r.get("employee_id"))
        ids = r.get("branch_ids") or ([r["branch_id"]] if r.get("branch_id") else [])
        r["branches"] = [{"id": i, "name": bmap.get(i) or "Unknown branch"} for i in ids if i]
        # "and no branches" is the half that was missing. A CONSULTANT can now be given
        # specific branches, and flagging them org-wide on the role alone printed "All
        # branches" over a selection that said ECR — the column contradicting the form
        # that set it.
        # No role is org-wide any more. A Consultant was the last one, and is now posted
        # to chosen branches like everybody else — so an empty list means nobody has said
        # where they work yet, which is a gap to fill rather than a reach to report. Left
        # on the row so every reader keeps its shape.
        r["org_wide"] = False
    return rows


@router.post("/users")
async def create_user_account(payload: UserAccountCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    if payload.role == "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin accounts can only be created via the OTP-approved Super Admin creation page")
    if payload.role not in await _all_role_names():
        raise HTTPException(status_code=400, detail="Invalid role")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    existing = await v3_col("users").find_one({"email": payload.email}, {"_id": 0, "id": 1})
    if existing:
        raise HTTPException(status_code=409, detail="Email already in use")
    if payload.employee_id:
        emp = await v3_col("employees").find_one({"id": payload.employee_id}, {"_id": 0, "id": 1})
        if not emp:
            raise HTTPException(status_code=404, detail="Linked employee not found")
    user = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name,
        "email": payload.email,
        "password": hash_password(payload.password),
        "role": payload.role,
        "branch_id": payload.branch_id,
        "branch_ids": payload.branch_ids,
        "employee_id": payload.employee_id,
        "mobile_number": payload.mobile_number,
        "aadhar_number": payload.aadhar_number,
        "is_active": True,
        "created_at": now_iso(),
    }
    await v3_col("users").insert_one(user.copy())
    if payload.role != "super_admin" and (is_diet_role(payload.role) or is_rehab_role(payload.role)):
        # A diet or rehab role belongs to a branch and holds a calendar there, exactly
        # like a Physio. Both are stamped with their own profile_type by
        # expert_profile_type, so each lands on its own calendar and not the other's.
        for b_id in (payload.branch_ids or [payload.branch_id]):
            await v3_col("doctors").insert_one({
                "id": str(uuid.uuid4()),
                "full_name": payload.full_name,
                # Not the literal: a rehab hire reaching this branch would otherwise be
                # stamped as a coach and turn up on the Diet Calendar.
                "profile_type": expert_profile_type(payload.role),
                "branch_id": b_id,
                "specialization": "",
                "slots": [],
                "slot_details": [],
                "user_id": user["id"],
                "created_at": now_iso(),
            })
    elif payload.role in SINGLE_CALENDAR_ROLES:
        # One branchless record. Still branchless now that a Consultant is posted to chosen
        # branches, and deliberately so: the branches are on the login, and the record is
        # the calendar. One person has one set of hours, so splitting it per branch would
        # let the same Consultant be booked into the same hour at two of them.
        await v3_col("doctors").insert_one({
            "id": str(uuid.uuid4()),
            "full_name": payload.full_name,
            "profile_type": payload.role,
            "branch_id": None,
            "specialization": "",
            "slots": [],
            "slot_details": [],
            "user_id": user["id"],
            "created_at": now_iso(),
        })
    elif payload.role in MULTI_BRANCH_ROLES:
        # One doctors record per assigned branch (each branch's calendar/booking is
        # scoped to its own record) — plain single-branch case is just a list of one.
        for b_id in (payload.branch_ids or [payload.branch_id]):
            await v3_col("doctors").insert_one({
                "id": str(uuid.uuid4()),
                "full_name": payload.full_name,
                "profile_type": expert_profile_type(payload.role),
                "branch_id": b_id,
                "specialization": "",
                "slots": [],
                "slot_details": [],
                "user_id": user["id"],
                "created_at": now_iso(),
            })
    safe = {k: v for k, v in user.items() if k != "password"}
    return safe


async def _guard_super_admin_target(user_id: str, caller: V3UserOut) -> None:
    """Only a Super Admin may act on a Super Admin's account.

    HR now reaches these endpoints, and without this an HR user could deactivate, delete,
    rename or reset the password of the Super Admin who granted them the role — locking the
    owner out of their own OS. Creating or promoting *to* super_admin was already blocked
    elsewhere; this closes the other direction.
    """
    if caller.role == "super_admin":
        return
    target = await v3_col("users").find_one({"id": user_id}, {"_id": 0, "role": 1})
    if target and target.get("role") == "super_admin":
        raise HTTPException(status_code=403, detail="Only a Super Admin can change a Super Admin account")


@router.patch("/users/{user_id}")
async def update_user_account(user_id: str, payload: UserAccountUpdate, caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _guard_super_admin_target(user_id, caller)
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    if "email" in updates:
        existing = await v3_col("users").find_one({"email": updates["email"], "id": {"$ne": user_id}}, {"_id": 0, "id": 1})
        if existing:
            raise HTTPException(status_code=409, detail="Email already in use")
    if updates.get("employee_id"):
        emp = await v3_col("employees").find_one({"id": updates["employee_id"]}, {"_id": 0, "id": 1})
        if not emp:
            raise HTTPException(status_code=404, detail="Linked employee not found")

    branch_ids = updates.get("branch_ids")
    if branch_ids is not None:
        # branch_id stays in sync as the primary/first branch, since every other
        # single-branch filter in the app (leads, finance, sessions...) still reads it.
        updates["branch_id"] = branch_ids[0] if branch_ids else None

    res = await v3_col("users").update_one({"id": user_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    user = await v3_col("users").find_one({"id": user_id}, {"_id": 0, "password": 0})
    if "full_name" in updates:
        # Both `doctors` (Experts picker, calendars) and `employees` keep their own denormalized
        # copy of full_name — keep them in sync so a rename doesn't leave stale names elsewhere.
        await v3_col("doctors").update_many({"user_id": user_id}, {"$set": {"full_name": updates["full_name"]}})
        if user and user.get("employee_id"):
            await v3_col("employees").update_one({"id": user["employee_id"]}, {"$set": {"full_name": updates["full_name"], "updated_at": now_iso()}})

    # The account's branch, written through to the employee record. The reverse of this has
    # existed since an employee could be moved — update_employee moves the login with them —
    # but this half was missing, which is why an account carrying a branch could sit above an
    # employee row in New Structure reading "No branch". The two are one person and must not
    # disagree about where they work.
    #
    # An employee holds one branch where an account may hold several, so it takes the
    # primary: branch_ids[0], which is the same branch_id every single-branch filter in the
    # OS already reads. An account covering nothing clears it rather than being left on a
    # branch it no longer has — the same direction the reverse cascade fails in.
    if user and user.get("employee_id") and "branch_id" in updates:
        await v3_col("employees").update_one(
            {"id": user["employee_id"]},
            {"$set": {"branch_id": updates["branch_id"] or "", "updated_at": now_iso()}},
        )

    if branch_ids is not None and user and holds_calendar_per_branch(user.get("role")):
        # holds_calendar_per_branch, not is_multi_branch_role: a Consultant now carries a
        # branch list too, and running this for them would mint a second, third and fourth
        # expert record beside the single branchless one they are supposed to have — the
        # split calendars consolidate_head_physio_doctors exists to clean up, recreated on
        # every edit. Their reach comes off branch_ids alone; the record does not move.
        #
        # Add a doctors record for any newly-assigned branch that doesn't already have
        # one. Branches removed from the list are left as-is so their existing calendar
        # slots/appointments aren't destroyed by an accidental unassign.
        existing_docs = await v3_col("doctors").find(
            {"user_id": user_id, "profile_type": expert_profile_type(user["role"])}, {"_id": 0, "branch_id": 1}
        ).to_list(50)
        existing_branch_ids = {d.get("branch_id") for d in existing_docs}
        for b_id in branch_ids:
            if b_id not in existing_branch_ids:
                await v3_col("doctors").insert_one({
                    "id": str(uuid.uuid4()),
                    "full_name": user["full_name"],
                    "profile_type": expert_profile_type(user["role"]),
                    "branch_id": b_id,
                    "specialization": "",
                    "slots": [],
                    "slot_details": [],
                    "user_id": user_id,
                    "created_at": now_iso(),
                })
    return user


@router.patch("/users/{user_id}/role")
async def update_user_role(user_id: str, role: str, caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _guard_super_admin_target(user_id, caller)
    if role not in await _all_role_names():
        raise HTTPException(status_code=400, detail="Invalid role")
    if role == "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin accounts can only be created via the OTP-approved Super Admin creation page")
    res = await v3_col("users").update_one({"id": user_id}, {"$set": {"role": role}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    if is_expert_role(role):
        user = await v3_col("users").find_one({"id": user_id}, {"_id": 0})
        existing_docs = await v3_col("doctors").find(
            {"user_id": user_id, "profile_type": expert_profile_type(role)}, {"_id": 0, "branch_id": 1}
        ).to_list(50)
        existing_branch_ids = {d.get("branch_id") for d in existing_docs}
        # A CONSULTANT needs exactly one record and it belongs to no branch; a Physio
        # needs one per branch they cover.
        wanted = [None] if role in SINGLE_CALENDAR_ROLES else (user.get("branch_ids") or [user.get("branch_id")])
        for b_id in wanted:
            if b_id not in existing_branch_ids:
                await v3_col("doctors").insert_one({
                    "id": str(uuid.uuid4()),
                    "full_name": user["full_name"],
                    "profile_type": expert_profile_type(role),
                    "branch_id": b_id,
                    "specialization": "",
                    "slots": [],
                    "slot_details": [],
                    "user_id": user_id,
                    "created_at": now_iso(),
                })
    return {"message": "Role updated"}


# ---------- email delivery ----------
#
# Every code this OS sends — a sign-in code, a password reset link, a reset OTP — leaves
# through one SMTP account, configured by four environment variables and nothing else.
# When that account is wrong, the symptom reaches users as "we couldn't send it" and the
# cause is a line in a log on the VPS that nobody on this side of the screen can read.
#
# So: two endpoints, Super Admin only. One says what the server thinks it is configured
# with, the other proves it by sending a real message and hands back whatever SMTP said if
# it fails. Between them they turn "email is broken" into a specific sentence.


@router.get("/email/status")
async def email_status(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """What this backend is configured to send email with.

    The password is never returned, only whether one is set. The two questions an admin
    actually has are "did my .env get read" and "which account is it using", and neither
    needs the secret. Super Admin only even so — the sending address and host are not
    worth handing to every role.
    """
    status = smtp_status()
    return {
        **status,
        # Carried with the diagnosis rather than assembled in the browser, so the fix does
        # not have to be remembered by whoever happens to read the screen.
        "hint": (
            None
            if status["configured"]
            else (
                "Set SMTP_USER and SMTP_PASSWORD in backend/.env on the server, then restart "
                "the backend. For Gmail, SMTP_PASSWORD must be a 16-character App Password, "
                "not the account password."
            )
        ),
    }


@router.post("/email/test")
async def email_test(caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Send a real email to the caller's own address and report exactly what happened.

    To the caller's own address, never to one named in the request: an endpoint that mails
    arbitrary text to an arbitrary address is an open relay wearing a test button.

    The SMTP error comes back verbatim on failure, which is the whole point — "535
    Username and Password not accepted" is the sentence that fixes a Gmail App Password,
    and it is worth nothing in a log the person debugging cannot open. Super Admin only,
    and the text is the server's own error about the server's own account.
    """
    if not caller.email:
        raise HTTPException(status_code=400, detail="Your account has no email address to send to")

    body = "\n".join([
        f"Hi {caller.full_name},",
        "",
        "This is a test from FitsiomaxOS. If you are reading it, this server can send email,",
        "so sign-in codes and password resets will reach people.",
        "",
        "Sent because you pressed Send test email under HR - Credentials.",
    ])
    try:
        send_email(caller.email, "FitsiomaxOS — email test", body)
    except SmtpNotConfigured as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "No SMTP credentials on this server. Set SMTP_USER and SMTP_PASSWORD in "
                "backend/.env, then restart the backend."
            ),
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SMTP refused it: {exc}") from exc

    return {"message": f"Test email sent to {caller.email}. If it does not arrive, check the spam folder."}


@router.patch("/users/{user_id}/reset-password")
async def reset_password(user_id: str, password: str, caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Set somebody else's password — the reset, as opposed to the change they make themselves.

    No current password is asked for, which is the whole point: this is the path for
    somebody who has lost theirs, and the accountability is that only a Super Admin can
    walk it. A person changing their own goes through POST /me/security/password, which
    does demand the old one.

    The account's live sessions go with it, for the same reason the self-serve change ends
    them: a password is reset because somebody may have had it, and tokens minted under the
    old one keep working until they are deleted. That is also why the reset alone was not
    enough to lock out whoever it was called about.

    Two-factor is untouched. It belongs to the account holder and only they can switch it
    off (see backend/routers/v3_security.py) — so a reset password still lands on the code
    screen at the next sign-in, which is the correct answer for an account under suspicion.
    """
    await _guard_super_admin_target(user_id, caller)
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password too short (min 6)")
    res = await v3_col("users").update_one(
        {"id": user_id},
        {"$set": {"password": hash_password(password), "password_changed_at": now_iso()}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    ended = await v3_col("sessions").delete_many({"user_id": user_id})
    return {"message": "Password reset", "sessions_ended": ended.deleted_count}


async def _set_expert_active(user_id: str, active: bool) -> int:
    """Follow a login's active state through to the expert profile behind it.

    A Head Physio, Physio or Nutrition Coach is two records: the login in `users` and the
    bookable profile in `doctors`. Only the login was being switched off, so someone who
    could no longer sign in stayed in every consultant list and stayed bookable — patients
    could be given appointments with a person who had left.

    The profile is marked, never deleted: a patient's appointments and treatment sessions
    point at that row, and removing it would orphan their history.
    """
    res = await v3_col("doctors").update_many(
        {"user_id": user_id}, {"$set": {"is_active": active, "updated_at": now_iso()}}
    )
    return res.modified_count


@router.delete("/users/{user_id}")
async def deactivate_user(user_id: str, caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _guard_super_admin_target(user_id, caller)
    res = await v3_col("users").update_one({"id": user_id}, {"$set": {"is_active": False}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    await _set_expert_active(user_id, False)
    return {"message": "User deactivated"}


@router.patch("/users/{user_id}/activate")
async def activate_user(user_id: str, caller: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _guard_super_admin_target(user_id, caller)
    res = await v3_col("users").update_one({"id": user_id}, {"$set": {"is_active": True}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    # Reactivating puts them back in the lists they were taken out of, so switching someone
    # off by mistake is undone by switching them back on rather than by rebuilding them.
    await _set_expert_active(user_id, True)
    return {"message": "User activated"}


@router.delete("/users/{user_id}/permanent")
async def delete_user_permanent(user_id: str, current: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    if user_id == current.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    await _guard_super_admin_target(user_id, current)
    res = await v3_col("users").delete_one({"id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    # Their expert profile has to go with them. Deleting the login used to leave it behind
    # with a user_id pointing at nothing — still listed, still bookable, and no longer
    # removable, because deleting an expert is refused for anything holding a user_id.
    # That was a loop with no way out: the only advice was to delete the login, which is
    # what had already been done.
    await _set_expert_active(user_id, False)
    return {"message": "User permanently deleted"}


# ---------- Branch Admin Picker (for super-admin Branch creation flow) ----------

@router.get("/branch-admin-candidates")
async def branch_admin_candidates(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    # Every role that holds Branch Admin's authority (Physio-only, Fitness-only, both,
    # or either online arm) — not just the literal "branch_admin" slug. Same set the
    # backend's own scoping checks use (deps.BRANCH_ADMIN_ROLES), so a branch can be
    # handed to any of them, not only the plain one.
    rows = await v3_col("users").find({"role": {"$in": list(BRANCH_ADMIN_ROLES)}, "is_active": True}, {"_id": 0, "password": 0}).to_list(500)
    branches = {}
    async for b in v3_col("branches").find({}, {"_id": 0}):
        branches[b.get("admin_user_id")] = b
    out = []
    for u in rows:
        out.append({
            "id": u["id"],
            "full_name": u.get("full_name"),
            "email": u.get("email"),
            "role": u.get("role"),
            "branch_id": u.get("branch_id"),
            "assigned_branch": branches.get(u["id"], {}).get("branch_name") if branches.get(u["id"]) else None,
        })
    return out


@router.post("/roles")
async def add_custom_role(payload: CustomRoleCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Add a new selectable Role name (e.g. "Tech Manager" -> tech_manager) so it
    shows up in Create User Account going forward. This only registers the name —
    it has no page/permission access wired up on its own; that's a separate,
    later step once there's an actual screen or endpoint meant for it."""
    label = payload.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Role name is required")
    slug = _slugify_role(label)
    if not slug:
        raise HTTPException(status_code=400, detail="Role name must contain letters or numbers")
    if slug in await _all_role_names():
        raise HTTPException(status_code=409, detail="This role already exists")
    color = (payload.color or "").strip().lower()
    if color and color not in ROLE_COLORS:
        raise HTTPException(status_code=400, detail=f"Colour must be one of: {', '.join(ROLE_COLORS)}")
    # Falls to slate rather than to nothing: a role with no colour rendered as the same
    # grey as "unrecognised role", so a deliberate choice and a missing one looked alike.
    role = {
        "id": str(uuid.uuid4()),
        "name": slug,
        "label": label.upper(),
        "color": color or "slate",
        "created_at": now_iso(),
    }
    await v3_col("custom_roles").insert_one(role.copy())
    return role


@router.delete("/roles/{name}")
async def delete_custom_role(name: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Removes a custom role from the picker. Built-in roles (DEFAULT_ROLES) aren't
    stored in custom_roles and can't be removed this way — deleting one of those would
    break the exact-slug matching several boards depend on (BRANCH_ADMIN_ROLES,
    PHYSIO_ROLES, etc. in deps.py). A user still holding this role keeps it on their own
    account; they just won't see it as a pickable option going forward until reassigned."""
    if name in DEFAULT_ROLES:
        raise HTTPException(status_code=400, detail="Built-in roles can't be deleted")
    result = await v3_col("custom_roles").delete_one({"name": name})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Role not found")
    return {"message": "Role deleted"}


@router.get("/departments")
async def list_departments(_: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev"))):
    depts = await _seeded_departments()
    counts = {}
    for row in await v3_col("employees").aggregate([
        {"$group": {"_id": "$department", "n": {"$sum": 1}}},
    ]).to_list(500):
        counts[row["_id"]] = row["n"]
    return [
        {**d, "designations": unique_designations(d.get("designations")), "employee_count": counts.get(d["name"], 0)}
        for d in depts
    ]


@router.post("/departments")
async def create_department(payload: DepartmentCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Department name is required")
    existing = await _seeded_departments()
    if any(d["name"].lower() == name.lower() for d in existing):
        raise HTTPException(status_code=409, detail="This department already exists")
    dept = {"id": str(uuid.uuid4()), "name": name, "designations": [], "created_at": now_iso()}
    await v3_col("hr_departments").insert_one(dept.copy())
    return dept


@router.patch("/departments/{dept_id}")
async def rename_department(dept_id: str, payload: DepartmentCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Department name is required")
    dept = await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    if name.lower() != dept["name"].lower():
        clash = await v3_col("hr_departments").find_one(
            {"id": {"$ne": dept_id}, "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(status_code=409, detail="This department already exists")
    await v3_col("hr_departments").update_one({"id": dept_id}, {"$set": {"name": name}})
    # Every employee's `department` is a plain string, not a reference, so the rename has
    # to be pushed to them explicitly or they'd keep showing the old name and stop being
    # counted for the department they're actually still in.
    if name != dept["name"]:
        await v3_col("employees").update_many({"department": dept["name"]}, {"$set": {"department": name}})
    return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})


@router.delete("/departments/{dept_id}")
async def delete_department(dept_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("hr_departments").delete_one({"id": dept_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Department not found")
    return {"message": "Department deleted"}


@router.post("/departments/{dept_id}/designations")
async def add_designation(dept_id: str, payload: DesignationCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Designation name is required")
    dept = await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    # Matched through structure_key rather than a case-folded compare of the whole string,
    # which is what let "Online  Consultant" onto a list already holding "Online Consultant".
    # The two are one job to every reader, and to the Designation picker they were two
    # options rendering identically.
    key = structure_key(name)
    if any(structure_key(d) == key for d in dept.get("designations", [])):
        raise HTTPException(status_code=409, detail="This designation is already in this department")
    # A designation belongs to exactly one department — the picker disables options
    # already claimed elsewhere, but that's a UI-level guard; this is the real boundary.
    # Scanned in Python for the same reason: a regex can only compare the literal name.
    for other in await v3_col("hr_departments").find(
        {"id": {"$ne": dept_id}}, {"_id": 0, "name": 1, "designations": 1}
    ).to_list(500):
        if any(structure_key(d) == key for d in (other.get("designations") or [])):
            raise HTTPException(status_code=409, detail=f'"{name}" already belongs to {other["name"]}')
    await v3_col("hr_departments").update_one({"id": dept_id}, {"$push": {"designations": name}})
    return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})


@router.delete("/departments/{dept_id}/designations")
async def remove_designation(dept_id: str, name: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("hr_departments").update_one({"id": dept_id}, {"$pull": {"designations": name}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Department not found")
    return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})


@router.patch("/departments/{dept_id}/designations")
async def rename_designation(dept_id: str, payload: DesignationRename, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    old_name = payload.old_name.strip()
    new_name = payload.new_name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Designation name is required")
    dept = await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    if old_name not in dept.get("designations", []):
        raise HTTPException(status_code=404, detail="That designation isn't in this department")
    if new_name.lower() != old_name.lower():
        clash = await v3_col("hr_departments").find_one(
            {"designations": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}}, {"_id": 0, "id": 1, "name": 1},
        )
        if clash and clash["id"] != dept_id:
            # Across departments it is not a merge but a move, and the people carrying it
            # would end up with a designation belonging to a department they are not in.
            raise HTTPException(status_code=409, detail=f'"{new_name}" already belongs to {clash["name"]}')
        if clash and not payload.merge:
            raise HTTPException(
                status_code=409,
                detail=f'"{new_name}" is already a designation here. Merging would move everyone under "{old_name}" into it.',
            )
        if clash:
            # The spelling already on the list wins, so the survivor is the one every other
            # record already agrees on rather than whatever case was typed just now.
            kept = next(
                (d for d in dept.get("designations", []) if d.lower() == new_name.lower()),
                new_name,
            )
            await v3_col("employees").update_many(
                {"designation": old_name}, {"$set": {"designation": kept}}
            )
            remaining = [d for d in dept.get("designations", []) if d != old_name]
            await v3_col("hr_departments").update_one({"id": dept_id}, {"$set": {"designations": remaining}})
            return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})
    designations = [new_name if d == old_name else d for d in dept.get("designations", [])]
    await v3_col("hr_departments").update_one({"id": dept_id}, {"$set": {"designations": designations}})
    # Every employee's `designation` is a plain string, not a reference, so the rename has
    # to be pushed to them explicitly or they'd keep showing the old title.
    if new_name != old_name:
        await v3_col("employees").update_many({"designation": old_name}, {"$set": {"designation": new_name}})
    return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})


@router.put("/departments/{dept_id}/designations/order")
async def reorder_designations(dept_id: str, payload: DesignationReorder, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    dept = await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    # Reorders only — never adds, drops or repeats one, so a stale client can't silently
    # lose a designation someone else just added to this department, and a client that
    # sends the same title twice can't write a list holding it twice.
    #
    # Compared sorted rather than as sets, which is what this used to do: a set cannot see
    # a repeat, so ["Consultant", "Consultant", "Physiotherapist"] compared equal to
    # ["Consultant", "Physiotherapist"] and a reorder could duplicate a designation.
    if sorted(payload.designations) != sorted(dept.get("designations", [])):
        raise HTTPException(status_code=400, detail="Reordered list must contain exactly the designations already in this department")
    await v3_col("hr_departments").update_one({"id": dept_id}, {"$set": {"designations": payload.designations}})
    return await v3_col("hr_departments").find_one({"id": dept_id}, {"_id": 0})


@router.get("/meta")
async def hr_meta(_: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev"))):
    custom = await _custom_roles()
    depts = await _seeded_departments()
    return {
        "departments": [d["name"] for d in depts],
        "department_designations": {d["name"]: unique_designations(d.get("designations")) for d in depts},
        "roles": DEFAULT_ROLES + [r["name"] for r in custom],
        "custom_roles": custom,
    }
