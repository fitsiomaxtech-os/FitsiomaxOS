from fastapi import Depends, Header, HTTPException
from typing import Dict, Optional
import re
from database import db, v2_col, v3_col
from schemas.v1 import AuthUser
from schemas.v2 import V2UserOut
from schemas.v3 import V3UserOut


async def get_current_user(authorization: str = Header(...)) -> AuthUser:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    token = authorization.split(" ", 1)[1].strip()
    session = await db.sessions.find_one({"token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Session expired. Please login again.")

    user_doc = await db.users.find_one(
        {"id": session["user_id"], "is_active": True},
        {"_id": 0, "password": 0},
    )
    if not user_doc:
        raise HTTPException(status_code=401, detail="User not found")

    return AuthUser(**user_doc)


def require_roles(*roles: str):
    async def checker(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="You do not have permission for this action")
        return user

    return checker


async def v2_current_user(authorization: str = Header(...)) -> V2UserOut:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1].strip()
    session = await v2_col("sessions").find_one({"token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    user = await v2_col("users").find_one({"id": session["user_id"], "is_active": True}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return V2UserOut(**user)


def v2_require_roles(*roles: str):
    async def checker(user: V2UserOut = Depends(v2_current_user)) -> V2UserOut:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Not allowed")
        return user

    return checker


async def v3_current_user(authorization: str = Header(...)) -> V3UserOut:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1].strip()
    session = await v3_col("sessions").find_one({"token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    user = await v3_col("users").find_one({"id": session["user_id"], "is_active": True}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return V3UserOut(**user)


# The two desks that read and work the whole company rather than one branch or one book:
# Super Admin, and the Business Development Executive, whose board mounts Super Admin's own
# boards as its tabs -- Operations among them, which is every other desk one designation at
# a time.
#
# This answers reach, not privilege, and the two are deliberately different questions. Where
# a rule is about who may act on a Super Admin's own account, or about which branch a
# figure is narrowed to, it stays on the literal. Where it is about "is this caller looking
# at one branch or at all of them" -- or "is this caller driving somebody else's board",
# which is what every `physio_id`/`coach_id`/`branch_id` supervisor parameter asks -- it
# belongs here, because the BD desk reaches those boards through the same tab Super Admin
# does and a literal left it looking at an empty one with nothing on screen to say why.
ORG_WIDE_ROLES = frozenset({"super_admin", "business_dev"})


def works_org_wide(role: str) -> bool:
    """Whether this role works every branch and every desk rather than one of each."""
    return (role or "").strip().lower() in ORG_WIDE_ROLES


# Roles that are a Branch Admin under another name. A branch is run by one of these whether
# it works in the room or online — the job is the same job, over one branch's leads,
# patients, calendars, store and accounts. So rather than a set of permissions each, this
# is Branch Admin's one set under a few slugs.
#
# It used to carry three more, naming the practice the branch sells rather than the arm it
# works in — Branch Admin (Physio), (Fitness), (Physio & Fitness). They were dropped: the
# permissions were identical, so all they did was make the pickers offer four spellings of
# one job. Which practice a branch runs is a fact about the branch and lives on the
# branch's own `vertical`, which is also where anything that should genuinely differ
# between them belongs — not in a fork of these permissions.
#
# Matched exactly, unlike the HR and Diet predicates below. Those match loosely because
# their roles are typed by hand and the wording varies. Doing that here would be dangerous:
# any rule matching a token like "physio", "fitness" or "online" would also catch the plain
# `physio` role and hand a treating physio the branch's finances. So the slugs are fixed,
# and they are in DEFAULT_ROLES instead, which puts them in the Create User and Designation
# dropdowns — nobody has to type one.
CURRENT_BRANCH_ADMIN_ROLES = frozenset({
    "branch_admin",
    "online_physio_admin",
    "online_fitness_admin",
})
# Retired: the three variants that named the practice a branch sells rather than the arm it
# works in. They were the same permissions as plain `branch_admin` under three more names,
# so collapsing them onto it changes nobody's access — migrate_branch_admin_roles() in
# seed.py rewrites the logins, and DEFAULT_ROLES no longer offers them.
#
# Still recognised here, exactly as LEGACY_CONSULTANT_ROLES stays in HEAD_PHYSIO_ROLES
# below: this set is read for the branch *scoping* checks as well as the gate, so dropping
# a slug the moment it stops being assignable would not merely fail closed for an account
# the migration has not reached — is_branch_admin_role returning False is what makes an
# endpoint skip narrowing its query to one branch, which would show that account every
# branch in the company.
LEGACY_BRANCH_ADMIN_ROLES = frozenset({
    "branch_admin_physio",
    "branch_admin_fitness",
    "branch_admin_physio_fitness",
})
BRANCH_ADMIN_ROLES = CURRENT_BRANCH_ADMIN_ROLES | LEGACY_BRANCH_ADMIN_ROLES


def is_branch_admin_role(role: str) -> bool:
    """Whether this role holds Branch Admin's authority over its own branch.

    Used for the branch *scoping* checks as well as the gate: an endpoint that narrows its
    query to user.branch_id for a branch_admin has to narrow it for these too. Missing one
    of those does not lock the role out — it does the opposite, and shows them every branch
    in the company.
    """
    return (role or "").strip().lower() in BRANCH_ADMIN_ROLES


def reads_lead_data(role: str) -> bool:
    """Whether this role may see the ad record behind a lead — see V3LeadData in schemas.

    Super Admin alone. Which ad, which adset and which campaign bought a patient is the
    org's own spend answering back; a branch or a desk works the lead in front of them
    without it. Lives here beside the other role predicates rather than inside one router,
    because every list of leads that leaves the building has to ask the same question.
    """
    return (role or "").strip().lower() == "super_admin"


def lead_as_read_by(row: dict, role: str) -> dict:
    """One lead document, as `role` is entitled to read it.

    Applied wherever a *list* of leads is built for a caller. Enforced on the wire and not
    only by hiding the tab that fills it, because a hidden tab is still a field in a
    response somebody can open a network panel on.
    """
    if reads_lead_data(role):
        return row
    return {**row, "lead_data": None}


# The two admins who run an arm rather than a place, and the practice each one runs.
#
# Every other Branch Admin is scoped by user.branch_id. These two are not scoped by
# anything: an online arm is not a branch record, its leads are created with no branch at
# all (see CreateLeadModal in the frontend, which offers the branch picker only for the two
# offline departments), and the branch a lead has is the only thing /branch-board filters
# on. So both of these boards asked for the leads of branch "" and were answered with
# nothing, for as long as the roles have existed.
#
# What an online lead does carry is its vertical, so that is what their board is scoped by.
ONLINE_ARM_PRACTICE = {
    "online_physio_admin": "physio",
    "online_fitness_admin": "fitness",
}

# What each practice is called in the wild. `vertical` is not a controlled field — a lead
# imported from a sheet carries whatever that sheet's column said, and this install already
# holds "Meta", "referral", "AD" and "whatsapp" in it alongside the real ones. So a set of
# tokens rather than a literal: "online_fitness" and "online_fitness_gym" are one arm, and
# "online_physiotherapy" and "online_physio" are the other.
PRACTICE_TOKENS = {
    "physio": frozenset({"physio", "physiotherapy"}),
    "fitness": frozenset({"fitness", "gym"}),
}


def online_arm_practice(role: str) -> Optional[str]:
    """Which online arm this role runs, or None for everybody else.

    None is the answer for a plain branch_admin too, and deliberately: they have a branch,
    and an arm-scoped board would show them every online lead in the company.
    """
    return ONLINE_ARM_PRACTICE.get((role or "").strip().lower())


def vertical_in_arm(vertical: str, practice: str) -> bool:
    """Whether a lead's `vertical` puts it in one online arm.

    Both halves have to say so. "online" alone cannot answer, because both arms are online
    and the fitness admin must not be handed the physio arm's patients; the practice token
    alone cannot either, because "offline_fitness" would then read as the online arm.

    Tokenised on whole words, like _names_the_online_arm in routers/v3_config.py, so a
    value merely containing the letters cannot pass for the arm.
    """
    tokens = set(re.split(r"[^a-z0-9]+", str(vertical or "").strip().lower()))
    return "online" in tokens and bool(tokens & PRACTICE_TOKENS.get(practice, frozenset()))


def names_the_online_arm(text) -> bool:
    """Whether a vertical, a role slug or a job title says "online".

    The loose half of the pair: `vertical_in_arm` above answers "which of the two online
    arms is this", and needs a practice token to tell physio from fitness. This one only
    answers "online or offline", which is the question a *branch* asks — a branch belongs
    to one arm or the other whatever practice it runs, and its own Branch Lead pipeline
    follows from that.

    Tokenised on whole words, not searched, so a value merely containing the letters
    cannot pass for the arm.
    """
    return "online" in re.split(r"[^a-z0-9]+", str(text or "").strip().lower())


def vertical_names_an_arm(vertical: str) -> bool:
    """Whether a vertical puts a lead on either online arm's board.

    For the callers that need to know a lead is arm-worked without caring which arm — the
    manual-lead endpoint, which has to give it the same opening stage that board's strip
    starts at.
    """
    return any(vertical_in_arm(vertical, practice) for practice in PRACTICE_TOKENS)


# Roles that are a Physio under another name, on the same footing as BRANCH_ADMIN_ROLES
# above. An Online Physio treats patients over video instead of on the floor; the board,
# the sessions, the reviews and the reach are identical, so it is the same permissions
# under a second slug rather than a parallel set that would drift.
#
# Exact match, for the same reason: a loose rule on the "physio" token would also catch
# the consultation desk and hand a treating physio the CONSULTANT's pipeline.
# The consultation desk. CONSULTANT is what this clinic calls the job and what HR's
# structure lists as the designation, so it is the role slug too — a designation is a role
# here. ONLINE CONSULTANT is the same desk over video: the same board, the same pipeline,
# the same org-wide reach, only the room differs, so it is an alias rather than a role of
# its own, exactly as online_physio is of physio.
#
# `head_physio`/`online_head_physio` are the slugs this desk used to carry. They are
# migrated to the two above by migrate_consultant_roles() in seed.py and are gone from
# DEFAULT_ROLES, so nobody can be given one again — they stay recognised here only so an
# account the migration has not reached yet keeps its board instead of logging in to a
# 403. Nothing new should be written against them.
#
# Note this is the ROLE, not the expert record's `profile_type`: every consultation query
# in the OS keys on profile_type "head_physio" and still does, whichever of these roles
# the person holds. See expert_profile_type in routers/v3_hr.py.
#
# Listed rather than matched loosely for the reason above: "sales_consultant" is a
# different job, and a rule on the bare "consultant" token would hand it the consultation
# pipeline.
CONSULTANT_ROLES = frozenset({"consultant", "online_consultant"})
LEGACY_CONSULTANT_ROLES = frozenset({"head_physio", "online_head_physio"})
# Somebody who takes consultations AND treats — Consultant + Physiotherapist. One login,
# both desks: it sits in HEAD_PHYSIO_ROLES and PHYSIO_ROLES alike, so every door that
# opens for either opens for them, and they hold an expert record of each kind (one
# branchless head_physio, one physio per branch). Each board resolves its own record by
# profile_type, so the two never mix. See COMBINED_EXPERT_ROLES in routers/v3_hr.py.
COMBINED_EXPERT_ROLES = frozenset({"consultant_physio"})
HEAD_PHYSIO_ROLES = CONSULTANT_ROLES | LEGACY_CONSULTANT_ROLES | COMBINED_EXPERT_ROLES


def is_head_physio_role(role: str) -> bool:
    """Whether a role takes consultations — in the room or over video."""
    return (role or "").strip().lower() in HEAD_PHYSIO_ROLES


def is_combined_expert_role(role: str) -> bool:
    """Whether a role works both the consultation desk and the Physio board."""
    return (role or "").strip().lower() in COMBINED_EXPERT_ROLES


PHYSIO_ROLES = frozenset({"physio", "online_physio"}) | COMBINED_EXPERT_ROLES


def is_physio_role(role: str) -> bool:
    """Whether this role treats patients as a Physio does.

    Like is_branch_admin_role, this is for the *scoping* checks as well as the gate: an
    endpoint that narrows to the logged-in physio's own patients has to narrow for these
    too. Missing one shows them every physio's book rather than locking them out.
    """
    return (role or "").strip().lower() in PHYSIO_ROLES


# Sales Head is Pre-Sales' own manager, not a separate desk: same pipeline, same leads,
# same board (PreSalesCRM on the frontend), just the org-wide Master View instead of one
# rep's own book. So it is Pre-Sales' authority under a second slug, on the same footing
# as BRANCH_ADMIN_ROLES/PHYSIO_ROLES above, rather than a parallel permission set that
# would drift from it.
PRE_SALES_ROLES = frozenset({"pre_sales", "sales_head"})


def is_pre_sales_role(role: str) -> bool:
    """Whether this role holds Pre-Sales' authority over leads.

    Like is_branch_admin_role, this is for the *scoping* checks as well as the gate:
    anywhere a query or action is opened up to "pre_sales", it has to be opened up to
    these too, or Sales Head is left able to see the Master View but not act on it.
    """
    return (role or "").strip().lower() in PRE_SALES_ROLES


def role_satisfies(role: str, roles) -> bool:
    """Whether `role` counts as one of `roles`, aliases included.

    Anywhere branch_admin, physio, head_physio, pre_sales or the diet desk is allowed, its
    aliases are allowed. Done in one predicate rather than at the 80-odd call sites so the
    next endpoint added is covered by default instead of being one someone remembered to
    list the second role on.

    The diet desk needs this more than the others, because the name the call sites list is
    not a role at all: they pass COACH from routers/v3_diet.py, which is "nutrition_coach",
    the expert record's PROFILE_TYPE. No login has ever held it — the role slug is
    "nutritionist" (see DEFAULT_ROLES in routers/v3_hr.py), and this install has reached it
    from "diet_manage" through migrate_designation_roles. So an exact match on that literal
    excluded the very desk the route was opened for: the Nutritionist could list her
    patients through the endpoints guarded by v3_require_diet, and was refused the four
    guarded by the literal — which is why a chart could be sent and then not opened by the
    person who sent it.

    is_diet_role is the same predicate v3_require_diet uses, so the two ways into that
    router answer the same question. None of this can widen anything on its own: an alias
    only applies where the route already listed the canonical role.

    Split out of v3_require_roles so a router doing its own second check — a rule finer
    than "which roles may reach this endpoint", like which KIND of document a role may
    file — asks the same question the door asked. A hand-rolled `role in WRITE_ROLES`
    beside a door that aliases is a gate that opens and a check behind it that does not:
    an Online Physio Branch Admin passed v3_require_roles as a branch_admin and was then
    refused by the literal, so the prescription upload 403'd for the desk that collects it.
    """
    if role in roles:
        return True
    return (
        ("branch_admin" in roles and is_branch_admin_role(role))
        or ("physio" in roles and is_physio_role(role))
        or ("head_physio" in roles and is_head_physio_role(role))
        or ("pre_sales" in roles and is_pre_sales_role(role))
        or (("nutrition_coach" in roles or "nutritionist" in roles) and is_diet_role(role))
    )


def v3_require_roles(*roles: str):
    async def checker(user: V3UserOut = Depends(v3_current_user)) -> V3UserOut:
        if not role_satisfies(user.role, roles):
            raise HTTPException(status_code=403, detail="Not allowed")
        return user

    return checker


def is_hr_role(role: str) -> bool:
    """Whether a role slug reads as Human Resources.

    The HR role is created by hand in Super Admin -> HR Admin, so its slug is whatever
    label was typed ("Human Resource" -> human_resource). Pinning one literal would leave
    the board 403ing for anyone who worded it differently, so the shape of the slug is
    matched instead — on whole underscore-separated tokens, so an unrelated future role
    can't slip through on a substring.

    Lives here rather than in a router so the recruitment endpoints and anything that gates
    on HR in future share one definition instead of drifting copies.

    business_dev answers True for the same reason super_admin does: the Business
    Development Executive's board mounts Super Admin's HR Admin panel in full, and
    Attendance, Payroll, Approvals and Quotes (routers/v3_hr_ops.py) gate on this
    predicate rather than on a role list. Without it that desk would reach four of HR
    Admin's eight tabs and be refused the other four.
    """
    r = (role or "").strip().lower()
    if r in ("super_admin", "business_dev"):
        return True
    if "human_resource" in r:
        return True
    return bool(set(r.split("_")) & {"hr", "recruiter", "recruitment", "talent"})


def is_diet_role(role: str) -> bool:
    """Whether a role slug reads as the Diet vertical.

    Same problem the HR predicate solves, arriving the same way: the role is created by
    hand in Roles & Credentials, so its slug is whatever label was typed — this install
    has `diet_manage`, not the `nutrition_coach` the Diet board was written against, and
    that user logged in to a blank screen. Pinning one literal leaves the board 403ing
    for anyone who worded it differently.

    Matched on whole underscore-separated tokens so an unrelated role can't slip through
    on a substring — "audit_manage" shares no token with this set.
    """
    r = (role or "").strip().lower()
    if r == "super_admin":
        return True
    if "nutrition_coach" in r:
        return True
    return bool(set(r.split("_")) & {"diet", "nutrition", "nutritionist", "dietician", "dietitian"})


def is_rehab_role(role: str) -> bool:
    """Whether a role slug reads as the Rehab desk.

    Same problem the Diet and Zumba predicates solve, arriving the same way: the role is
    created by hand in Roles & Credentials, so its slug is whatever was typed — "rehab",
    "rehab_therapist", "rehab_manage" all name the same desk.

    Matched on whole underscore-separated tokens so an unrelated role cannot slip through
    on a substring. Note this is the ROLE, not the store category of the same name: a
    rehab course on the shelf has nothing to do with who holds the rehab calendar.

    Super Admin is included for the same reason it is in is_diet_role — it may reach every
    board — and excluded again wherever the question is "does this person hold a calendar".
    """
    r = (role or "").strip().lower()
    if r == "super_admin":
        return True
    return bool(set(r.split("_")) & {"rehab", "rehabilitation"})


def is_zumba_role(role: str) -> bool:
    """Whether a role slug reads as the Zumba desk.

    Same problem the HR and Diet predicates solve, arriving the same way: the role is
    created by hand in Roles & Credentials, so its slug is whatever wording was typed --
    this install has "zumba", and a "Zumba Master" typed tomorrow would be "zumba_master".
    Pinning one literal leaves the board 403ing for the other.

    Matched on whole underscore-separated tokens so an unrelated role cannot slip through
    on a substring. Note this is the ROLE, not the store category of the same name: a
    Zumba package on the shelf has nothing to do with who may read the class roll.
    """
    r = (role or "").strip().lower()
    if r == "super_admin":
        return True
    return "zumba" in set(r.split("_"))


def v3_require_diet(user: V3UserOut = Depends(v3_current_user)) -> V3UserOut:
    if not is_diet_role(user.role):
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def super_admin_consults_at(user_doc: dict, branch_id: str, switches_on: bool = True) -> bool:
    """Whether a Super Admin login takes consultations at this branch.

    On everywhere by default; `consult_off_branch_ids` on the login lists the branches they
    have switched off on My Consultation. Kept on the login rather than the consultant
    record for the reason consultants_serving_branch gives: where a consultant is OFFERED
    is read off the account, and the record stays one branchless sheet of hours.

    `switches_on` is the developer setting (super_admin_branch_switches_enabled). With it
    off the switches are hidden, so the off-list is ignored rather than left stranding them
    Off at a branch with no screen to turn it back On.
    """
    return not switches_on or branch_id not in (user_doc.get("consult_off_branch_ids") or [])


# The Danger Zone row that shows or hides the Super Admin's branch On/Off on My Consultation.
SA_CONSULT_BRANCHES_SETTING_ID = "super_admin_consult_branches"


async def super_admin_branch_switches_enabled() -> bool:
    """Are the Super Admin's branch-wise On/Off switches offered? On unless a developer
    switched them off."""
    row = await v3_col("app_settings").find_one({"id": SA_CONSULT_BRANCHES_SETTING_ID}, {"_id": 0})
    return True if not row else bool(row.get("enabled", True))


async def consultants_serving_branch(rows: list, branch_id: str) -> list:
    """Keep the consultants posted to this branch, and every other desk untouched.

    A Consultant is branch-selective now. They were not: their record was branchless, every
    branch's query matched it, and consolidate_head_physio_doctors cleared their login's
    branches at every startup to keep it that way. Lifting that rule is what this filter is.

    Read off the LOGIN, not off the record. The record stays branchless on purpose — one
    person has one set of published hours, and splitting it per branch would let the same
    Consultant be booked into the same hour at two of them with nothing to catch it — so
    the record cannot carry the answer. The branches live in branch_ids on the account,
    which is where every other multi-branch desk already keeps them.

    An empty list means NOWHERE. That is the reversal, and it is the whole point: a
    Consultant nobody has posted yet is offered at no branch rather than at all of them.
    The one exception is a Super Admin taking consultations: nobody posts them anywhere
    because they run every branch, so their empty list means EVERYWHERE instead — less
    the branches they have switched off themselves.

    A record with no login is a profile-only entry from Fitsiomax Experts, which requires a
    branch when it is created, so its own branch_id is its posting and is read directly.
    One that is also branchless has no answer anywhere and is offered nowhere — the same
    result as an unposted Consultant, and recoverable the same way.

    Only consultants are touched. Every other desk is filtered by branch in the query that
    produced these rows, and re-deciding them here would be a second rule to keep in step
    with the first.

    Lives here rather than beside any one caller because there are three of them — the
    expert list, the booking popup's experts and its available dates — and a caller that
    forgets it offers a Consultant at a branch they do not work.
    """
    user_ids = [r.get("user_id") for r in rows if r.get("profile_type") == "head_physio" and r.get("user_id")]
    posted_by_user: Dict[str, list] = {}
    # A Super Admin taking consultations is the one consultant "posted nowhere" must not
    # apply to. Their account carries no branch list — they are not posted to branches,
    # they run all of them — so the rule above would offer them at none, which is the
    # opposite of what the role means. So they are offered everywhere EXCEPT the branches
    # they have switched off on My Consultation (super_admin_consults_at). An off-list
    # rather than an on-list, so a branch opened next month has them on without anybody
    # remembering to switch it.
    here: set = set()
    switches_on = await super_admin_branch_switches_enabled() if user_ids else True
    if user_ids:
        async for u in v3_col("users").find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "branch_id": 1, "branch_ids": 1, "role": 1, "consult_off_branch_ids": 1},
        ):
            if (u.get("role") or "").strip().lower() == "super_admin":
                if super_admin_consults_at(u, branch_id, switches_on):
                    here.add(u["id"])
                continue
            at = [b for b in (u.get("branch_ids") or []) if b]
            if not at and u.get("branch_id"):
                at = [u["branch_id"]]
            posted_by_user[u["id"]] = at

    kept = []
    for r in rows:
        if r.get("profile_type") != "head_physio":
            kept.append(r)
            continue
        uid = r.get("user_id")
        if uid:
            if uid in here or branch_id in posted_by_user.get(uid, []):
                kept.append(r)
        elif r.get("branch_id") == branch_id:
            kept.append(r)
    return kept


async def collapse_duplicate_experts(rows: list) -> list:
    """One row per person per desk per branch, not one per expert record.

    Assign Physio was offering the same physio three times over, three identical lines
    reading "Sowdraya" with nothing to tell them apart. Every one of them is a real
    `doctors` row: half a dozen paths mint these records, most of them without a user_id
    to dedupe against — 26 of the 29 physio records in the db_backup snapshot carry none —
    so the branch sync in HR cannot see what is already there and adds another beside it.
    The same install has been seen with twenty-one identical rows for one Nutritionist.

    Collapsed on the NAME within a branch and a desk, not on user_id, for the reason the
    Nutritionist picker in routers/v3_diet.py collapses the same way: the pair this exists
    to merge is exactly one linked row and one legacy row carrying no link, so keying on
    that id gives them different keys and merges nothing. Branch and profile_type stay in
    the key, so two different branches keep their own rows and a physio is never folded
    into a nutritionist of the same name.

    Two genuinely different physios sharing a name at one branch would merge. The pickers
    this feeds show the name and nothing else, so they are already indistinguishable in
    them; nothing legible is lost that was not already lost.

    The row kept is the one carrying the most published hours, then the one patients are
    actually booked against, then the one linked to a login, then the oldest, which is the
    one the others were duplicated from.

    Published hours lead for the same reason they lead in team_roster_experts, which
    answers this question for the calendars: the id that survives here is the id the picker
    opens a calendar on and then writes into `sessions.physio_id`, so keeping the empty
    twin offers a physio whose next screen has no date to pick. Ranking the two lists the
    same way is also what keeps them agreeing — a branch that publishes days onto one
    record and books against another has split one physio's diary in half.

    Bookings break the tie beneath that, where two rows are equally empty and only one
    holds the patients, so the sessions already filed stay with the record that survives.

    Nothing is merged or deleted. This is a read-side answer to records that already
    exist; collapsing them for real means moving bookings between records, which is not a
    repair a picker should be making on a page load.
    """
    groups: Dict[tuple, list] = {}
    order: list = []
    for row in rows:
        name = str(row.get("full_name") or "").strip().lower()
        # A row with no name is keyed on its own id, so blanks never collapse into
        # each other — they are unidentifiable, not the same person.
        key = (row.get("profile_type"), row.get("branch_id"), name or f"id:{row.get('id')}")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)

    contended = [r["id"] for key in order if len(groups[key]) > 1 for r in groups[key] if r.get("id")]
    busy: set = set()
    if contended:
        # Only the rows actually in contention, and only when there are any: the common
        # case is no duplicates at all, and it must not cost three extra queries.
        # Treatment days, rehab days and appointments each point at an expert record by a
        # different field name, and work on any of them is work.
        for col, field in (("appointments", "doctor_id"), ("sessions", "physio_id"), ("rehab_sessions", "physio_id")):
            busy |= set(await v3_col(col).distinct(field, {field: {"$in": contended}}))

    def rank(row: dict) -> tuple:
        return (
            # Negated because this sorts ascending: the fullest calendar first, so a row
            # with a day published beats one with an hour and both beat an empty twin.
            -len(row.get("slots") or []),
            0 if row.get("id") in busy else 1,
            0 if row.get("user_id") else 1,
            str(row.get("created_at") or ""),
        )

    return [sorted(groups[key], key=rank)[0] for key in order]
