from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional, Dict, List, Any
from urllib.parse import urlparse
from pymongo import UpdateOne
import uuid
import re

from database import v3_col
from utils import now_iso, generate_patient_number, enquiry_created_at, find_enquiry_stamp, without_past_moves
from deps import v3_require_roles, v3_current_user
from constants import V3_STAGES
from security import hash_password
from schemas.v3 import V3UserOut
from stage_utils import first_branch_stage_for
# Which branch a row asks for, where the sheet asks the patient at all.
import branch_routing
import lead_control
# What a sheet column may be mapped onto, and how a mapped row is written. Shared with
# the importer so the dropdown cannot offer a field the import would ignore.
import lead_mapping
import lead_purge
from pydantic import BaseModel
from typing import Literal


router = APIRouter(prefix="/api/v3/marketing")


# ============ helpers ============

STANDARD_FIELDS = ["name", "phone", "email", "vertical", "condition", "age", "preferred_branch", "budget", "notes"]

# Header spellings a sheet column is recognised by, keyed by the field it is written to.
# The keys are lead_mapping's keys, so whatever is matched here reaches the field the
# Create Lead form shows -- see split_mapping.
#
# Order matters: auto_map_columns walks this top to bottom and the first field to claim a
# header keeps it, so a spelling two fields could both want belongs to the one listed
# first. That is why City sits above Preferred Branch rather than beside it.
FIELD_ALIASES = {
    # Spellings are compared squashed (see auto_map_columns), so one entry covers "Full
    # Name", "full_name" and "FullName". What still has to be listed is a different way of
    # asking: a form that says "Your Name" is not the "full name" spelling with the
    # punctuation taken out, and would otherwise go unmapped and land the patient as
    # "Unknown" on every board that lists them.
    "name": [
        "name", "lead name", "full name", "fullname", "customer name", "patient name",
        "your name", "your full name", "name of patient", "patient's name", "client name",
    ],
    "phone": [
        "phone", "phone number", "mobile", "mobile number", "contact", "contact number",
        "whatsapp", "whatsapp number", "phone no", "mobile no", "contact no",
        "your phone number", "your mobile number",
    ],
    "email": ["email", "email id", "email address", "mail"],
    "vertical": ["vertical", "service", "service type", "category", "product"],
    "condition": ["condition", "issue", "ailment", "problem", "concern"],
    "age": ["age", "patient age"],
    # A City column is the patient's own city and belongs on the lead's City field, which
    # is what the Create Lead form, the patient popup and Branch Leads' City column all
    # read. It used to be claimed by Preferred Branch below -- a legacy extra field -- so
    # every sheet with a City column filed "Coimbatore" or "salem" under a branch name
    # nobody had a branch by, and the lead's own City stayed empty. A sheet that really
    # does ask which branch somebody wants says so: "branch" and "preferred branch" are
    # still Preferred Branch's, and they are the honest spellings for that question.
    "city": ["city", "town", "city/town", "town/city", "city / town"],
    # The branch the patient asked for, and -- since this column is what decides which
    # branch a row is imported to (see branch_routing) -- the one spelling here it is worth
    # being generous about. A form asks this as a whole sentence, and the sentence is the
    # header: "Which is your preferred location?" squashes to nothing like "location", so
    # the question went unmapped, the answer was filed as extra detail nobody reads, and
    # every row of a form feeding four branches landed on one of them.
    "preferred_branch": [
        "branch", "preferred branch", "location", "preferred location",
        "which is your preferred location", "which is your preferred branch",
        "your preferred location", "your preferred branch", "which location",
        "which branch", "select your preferred location", "choose your preferred location",
        "preferred clinic", "nearest branch", "nearest location", "branch preference",
        "location preference",
    ],
    "budget": ["budget", "amount", "price range"],
    "notes": ["notes", "remarks", "comments", "message"],
}

SOURCE_TYPES = ["meta", "seo", "referral", "walk_in", "website", "csv_import", "google_sheets", "other"]


def squash_header(value: str) -> str:
    """A sheet header down to its letters and digits, for comparing spellings.

    "City / Town", "city_town" and "CityTown" are one column asked three ways, and a sheet
    is headed by whoever built the form.
    """
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


# The squashed spellings that mean the patient's own city. Used only to recognise a
# mapping saved against the old alias table (see normalize_source) -- new sheets are
# matched by FIELD_ALIASES above, which is the list that has to stay in step with the
# mapping dialog.
CITY_HEADERS = {squash_header(a) for a in FIELD_ALIASES["city"]}


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:] if len(digits) >= 10 else digits


def extract_spreadsheet_id(url: str) -> str:
    m = re.search(r"/d/([a-zA-Z0-9-_]+)", url or "")
    if m:
        return m.group(1)
    parsed = urlparse(url or "")
    return parsed.path.strip("/") or url


def auto_map_columns(headers: List[str]) -> Dict[str, str]:
    """A sheet's headers matched onto the fields above, by letters and digits alone.

    Compared through squash_header rather than on the lowercased header, because a form
    names its own columns and the two spellings of one question are not the same string.
    A Meta lead-ads export heads its columns "full_name" and "phone_number"; the aliases
    above say "full name" and "phone number". Matched exactly, neither one hit -- so every
    lead off such a sheet imported with its name unmapped and landed as "Unknown", and the
    phone fell through to the fallback below and took column A, which on that export is
    Meta's own lead id ("l:1773668330..."). Both columns were sitting right there in the
    sheet under a name one underscore away from the one being looked for.

    Still exact once squashed, never a substring: "city" inside "capacity" is the failure
    that costs more than a column occasionally left for the mapping dialog to set by hand.

    Where two headers squash the same the first one wins, matching the rule the alias
    table is ordered by -- the first field to claim a header keeps it.
    """
    squashed: Dict[str, str] = {}
    for header in headers:
        squashed.setdefault(squash_header(header), header)
    mapping: Dict[str, str] = {}
    used: set = set()
    for std, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            header = squashed.get(squash_header(alias))
            if header and header not in used:
                mapping[std] = header
                used.add(header)
                break
    return mapping


async def round_robin_assign(stage_type: str) -> Optional[Dict[str, str]]:
    settings = await v3_col("marketing_settings").find_one({"id": "_singleton_"}, {"_id": 0})
    if not settings or not settings.get("enabled"):
        return None
    if settings.get("distribution_type") != "round_robin":
        return None
    key = "pre_sales_team" if stage_type == "pre_sales" else "sales_team"
    idx_key = "pre_sales_current_index" if stage_type == "pre_sales" else "sales_current_index"
    team: List[str] = settings.get(key, []) or []
    if not team:
        return None
    idx = settings.get(idx_key, 0) % len(team)
    assigned_user_id = team[idx]
    new_idx = (idx + 1) % len(team)
    await v3_col("marketing_settings").update_one(
        {"id": "_singleton_"},
        {"$set": {idx_key: new_idx, "updated_at": now_iso()}},
    )
    user = await v3_col("users").find_one({"id": assigned_user_id}, {"_id": 0, "password": 0})
    if not user:
        return None
    return {"id": user["id"], "full_name": user.get("full_name", "")}


async def ensure_settings_doc() -> Dict[str, Any]:
    existing = await v3_col("marketing_settings").find_one({"id": "_singleton_"}, {"_id": 0})
    if existing:
        return existing
    doc = {
        "id": "_singleton_",
        "enabled": False,
        "distribution_type": "round_robin",
        "pre_sales_team": [],
        "sales_team": [],
        "pre_sales_current_index": 0,
        "sales_current_index": 0,
        "updated_at": now_iso(),
    }
    await v3_col("marketing_settings").insert_one(doc.copy())
    return doc


# ============ schemas (local) ============

class MarketingSourceCreate(BaseModel):
    name: str
    sheet_url: Optional[str] = ""
    sheet_name: Optional[str] = "Sheet1"
    sheet_names: Optional[List[str]] = None  # several tabs of the same spreadsheet, pulled together
    spreadsheet_id: Optional[str] = ""
    source_type: Literal["meta", "seo", "referral", "walk_in", "website", "csv_import", "google_sheets", "other"] = "google_sheets"
    headers: Optional[List[str]] = None
    # A mapping chosen by hand in the Edit Mapping dialog, which the popup can now do for
    # a sheet that does not exist yet. Without this the mapping would be detected from the
    # headers on create and the user's choices thrown away on the way in.
    column_mapping: Optional[Dict[str, str]] = None
    # Every lead pulled from this source auto-assigns to the branch when exactly one is
    # given. With zero or several, there's no single branch to route a row to, so they're
    # tags only (see _normalize_source / _internal_pull_source).
    branch_ids: Optional[List[str]] = None
    verticals: Optional[List[str]] = None


class MarketingSourceUpdate(BaseModel):
    name: Optional[str] = None
    source_type: Optional[Literal["meta", "seo", "referral", "walk_in", "website", "csv_import", "google_sheets", "other"]] = None
    sheet_url: Optional[str] = None
    spreadsheet_id: Optional[str] = None
    sheet_name: Optional[str] = None
    sheet_names: Optional[List[str]] = None
    headers: Optional[List[str]] = None
    branch_ids: Optional[List[str]] = None  # pass [] to clear back to "All Branches"
    verticals: Optional[List[str]] = None
    column_mapping: Optional[Dict[str, str]] = None
    custom_fields: Optional[List[str]] = None
    is_active: Optional[bool] = None
    is_archived: Optional[bool] = None
    auto_sync_enabled: Optional[bool] = None
    auto_sync_interval_minutes: Optional[int] = None


class MarketingSyncInput(BaseModel):
    rows: List[Dict[str, Any]]


class DistributionUpdate(BaseModel):
    enabled: Optional[bool] = None
    distribution_type: Optional[Literal["round_robin", "manual"]] = None
    pre_sales_team: Optional[List[str]] = None
    sales_team: Optional[List[str]] = None


class TeamMemberCreate(BaseModel):
    full_name: str
    email: str
    password: str
    team_type: Literal["pre_sales", "branch_admin"]
    branch_id: Optional[str] = None


class BulkDelete(BaseModel):
    lead_ids: List[str]


# ============ dashboard ============

@router.get("/dashboard")
async def marketing_dashboard(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    pre_sales_count = await v3_col("leads").count_documents(without_past_moves({"stage": {"$in": ["New Leads", "Follow Up"]}}))
    sales_count = await v3_col("leads").count_documents(without_past_moves({"stage": "Appointment"}))
    completed_count = await v3_col("leads").count_documents({"branch_stage": "Assigned Physio"})
    total_pre_sales_ever = pre_sales_count + sales_count + completed_count
    conv = (completed_count / total_pre_sales_ever * 100.0) if total_pre_sales_ever else 0.0

    sources = await v3_col("marketing_sources").count_documents({"is_active": True})

    pipeline = [
        {"$match": without_past_moves()},
        {"$group": {"_id": "$source_tab", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    by_source_raw = await v3_col("leads").aggregate(pipeline).to_list(50)
    by_source = [{"source": (row.get("_id") or "unknown"), "count": row["count"]} for row in by_source_raw]

    recent = await v3_col("leads").find(without_past_moves(), {"_id": 0}).sort("created_at", -1).to_list(20)
    return {
        "kpis": {
            "pre_sales_leads": pre_sales_count,
            "sales_leads": sales_count,
            "active_sources": sources,
            "conversion_rate": round(conv, 1),
        },
        "by_source": by_source,
        "recent_leads": recent,
    }


# ============ distribution settings ============

@router.get("/distribution-settings")
async def get_distribution_settings(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    return await ensure_settings_doc()


@router.patch("/distribution-settings")
async def patch_distribution_settings(payload: DistributionUpdate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await ensure_settings_doc()
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    updates["updated_at"] = now_iso()
    await v3_col("marketing_settings").update_one({"id": "_singleton_"}, {"$set": updates})
    return await v3_col("marketing_settings").find_one({"id": "_singleton_"}, {"_id": 0})


@router.post("/distribution-settings/refresh")
async def refresh_distribution_settings(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await ensure_settings_doc()
    pre_users = await v3_col("users").find({"role": "pre_sales", "is_active": True}, {"_id": 0, "password": 0}).to_list(500)
    sales_users = await v3_col("users").find({"role": "branch_admin", "is_active": True}, {"_id": 0, "password": 0}).to_list(500)
    pre_ids = [u["id"] for u in pre_users]
    sales_ids = [u["id"] for u in sales_users]
    await v3_col("marketing_settings").update_one(
        {"id": "_singleton_"},
        {"$set": {"pre_sales_team": pre_ids, "sales_team": sales_ids, "updated_at": now_iso()}},
    )
    return await v3_col("marketing_settings").find_one({"id": "_singleton_"}, {"_id": 0})


# A lead with no Pre-Sales owner. Three shapes mean the same thing depending on how the
# lead arrived: the field absent entirely (created before distribution existed), null
# (round_robin_assign returned None), or empty string.
UNOWNED_LEAD = {"$or": [
    {"assigned_user_id": {"$exists": False}},
    {"assigned_user_id": None},
    {"assigned_user_id": ""},
]}


async def unowned_pre_sales_query() -> Dict[str, Any]:
    """UNOWNED_LEAD, minus the branches that work their own leads.

    A branch on Branch Admin Lead Control gets no Pre-Sales agent by design, so its
    leads are unowned on purpose. Without this they would read as a backlog on the
    Team & Distribution tab and the Distribute button would hand them to Pre-Sales,
    quietly undoing the switch. Leads with no branch are still fair game — nobody
    else can work them.

    Past Data's trial clients are no one's backlog either: they sit on their own branch to
    be looked at, and Distribute would hand a sheet's worth of them to Pre-Sales.
    """
    controls = await lead_control.branch_control_map()
    skip = [bid for bid, c in controls.items() if c == lead_control.BRANCH_ADMIN]
    if not skip:
        return without_past_moves(UNOWNED_LEAD)
    return without_past_moves({"$and": [UNOWNED_LEAD, {"branch_id": {"$nin": skip}}]})


@router.get("/unassigned-count")
async def unassigned_lead_count(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """How many leads carry no Pre-Sales agent — the backlog the button below clears."""
    return {"count": await v3_col("leads").count_documents(await unowned_pre_sales_query())}


@router.post("/distribute-unassigned")
async def distribute_unassigned_leads(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Share out every lead that has no Pre-Sales agent, round-robin across the team.

    Round-robin only ever ran at the moment a lead arrived from a source sync, and only
    if distribution was already switched on with a non-empty team. Every lead that
    predates that — or arrived while the team list was empty — has no owner and no way to
    acquire one, which is why per-agent counts read zero however the leads were counted.
    Nothing else in the system can attribute those leads after the fact.

    Only untouched leads are moved: a lead already assigned keeps its agent, so running
    this twice does not reshuffle anyone's book.
    """
    settings = await ensure_settings_doc()
    team_ids: List[str] = settings.get("pre_sales_team") or []
    users = await v3_col("users").find(
        {"id": {"$in": team_ids}, "is_active": True}, {"_id": 0, "id": 1, "full_name": 1}
    ).to_list(500)
    by_id = {u["id"]: u for u in users}
    # Keep the configured order, minus anyone since deactivated or deleted.
    team = [t for t in team_ids if t in by_id]
    if not team:
        raise HTTPException(
            status_code=400,
            detail="No active Pre-Sales team is set. Use 'Refresh Team from Users' first.",
        )

    rows = await v3_col("leads").find(await unowned_pre_sales_query(), {"_id": 0, "id": 1}).to_list(100000)
    if not rows:
        return {"assigned": 0, "per_agent": {}, "message": "Every lead already has an agent."}

    # Continue from the stored index rather than restarting at the first agent, so a
    # second run doesn't pile the next batch onto whoever happens to be first.
    idx = int(settings.get("pre_sales_current_index", 0) or 0) % len(team)
    ops = []
    per_agent: Dict[str, int] = {}
    for r in rows:
        uid = team[idx]
        u = by_id[uid]
        ops.append(UpdateOne(
            {"id": r["id"]},
            {"$set": {
                "assigned_user_id": uid,
                "assigned_user_name": u.get("full_name", ""),
                "updated_at": now_iso(),
            }},
        ))
        per_agent[u.get("full_name", "")] = per_agent.get(u.get("full_name", ""), 0) + 1
        idx = (idx + 1) % len(team)

    # Chunked so one oversized command can't be rejected wholesale, leaving the backlog
    # half-assigned with no record of where it stopped.
    assigned = 0
    for i in range(0, len(ops), 1000):
        res = await v3_col("leads").bulk_write(ops[i:i + 1000], ordered=False)
        assigned += res.modified_count

    await v3_col("marketing_settings").update_one(
        {"id": "_singleton_"},
        {"$set": {"pre_sales_current_index": idx, "updated_at": now_iso()}},
    )
    return {"assigned": assigned, "per_agent": per_agent}


# ============ team members ============

@router.get("/team-members")
async def get_team_members(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    pre = await v3_col("users").find({"role": "pre_sales", "is_active": True}, {"_id": 0, "password": 0}).to_list(500)
    sales = await v3_col("users").find({"role": "branch_admin", "is_active": True}, {"_id": 0, "password": 0}).to_list(500)

    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    branch_names = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    async def enrich_pre_sales(users: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """A Pre-Sales agent owns leads by assignment, so every figure keys off
        assigned_user_id."""
        out = []
        for u in users:
            current_leads = await v3_col("leads").count_documents(
                {"assigned_user_id": u["id"], "stage": {"$in": ["New Leads", "Follow Up"]}}
            )
            total_assigned = await v3_col("leads").count_documents({"assigned_user_id": u["id"]})
            # Converted means the lead reached a physio. Read off assigned_physio_id
            # rather than a stage name: stages are renamed from Pipeline Stage
            # Management, and this used to test branch_stage == "Assigned Physio",
            # which is not a stage any pipeline has — so it counted zero for everyone,
            # forever, and looked like nobody had ever converted anything.
            closed = await v3_col("leads").count_documents(
                {"assigned_user_id": u["id"], "assigned_physio_id": {"$nin": [None, ""]}}
            )
            conv = (closed / total_assigned * 100.0) if total_assigned else 0.0
            out.append({
                "id": u["id"],
                "full_name": u.get("full_name", ""),
                "email": u.get("email", ""),
                "branch_id": u.get("branch_id"),
                "branch_name": branch_names.get(u.get("branch_id"), ""),
                "current_leads": current_leads,
                "deals_closed": closed,
                "total_assigned": total_assigned,
                "conversion_rate": round(conv, 1),
            })
        return out

    async def enrich_branch(users: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """A Branch Admin owns work by *branch*, not by assignment — nothing sets
        assigned_user_id to a Branch Admin, which is why every one of these read zero.

        Appointments and Deals Closed are deliberately measured over the same
        population: the patients booked in to this branch. Counting closures branch-wide
        while counting appointments per booking would let the rate exceed 100% whenever a
        patient reached a physio without a consultation appointment on record.
        """
        out = []
        for u in users:
            bid = u.get("branch_id")
            if not bid:
                out.append({
                    "id": u["id"], "full_name": u.get("full_name", ""), "email": u.get("email", ""),
                    "branch_id": None, "branch_name": "", "current_leads": 0,
                    "deals_closed": 0, "total_assigned": 0, "conversion_rate": 0.0,
                })
                continue
            appt_lead_ids = await v3_col("appointments").distinct(
                "lead_id", {"branch_id": bid, "appt_kind": "consultation"}
            )
            appt_lead_ids = [i for i in appt_lead_ids if i]
            appointments = len(appt_lead_ids)
            closed = await v3_col("leads").count_documents(
                {"id": {"$in": appt_lead_ids}, "assigned_physio_id": {"$nin": [None, ""]}}
            ) if appt_lead_ids else 0
            total_leads = await v3_col("leads").count_documents(without_past_moves({"branch_id": bid}))
            rate = (closed / appointments * 100.0) if appointments else 0.0
            out.append({
                "id": u["id"],
                "full_name": u.get("full_name", ""),
                "email": u.get("email", ""),
                "branch_id": bid,
                "branch_name": branch_names.get(bid, ""),
                "current_leads": appointments,
                "deals_closed": closed,
                "total_assigned": total_leads,
                "conversion_rate": round(rate, 1),
            })
        return out

    return {
        "pre_sales": await enrich_pre_sales(pre),
        "sales": await enrich_branch(sales),
    }


@router.post("/team-members")
async def create_team_member(payload: TeamMemberCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    existing = await v3_col("users").find_one({"email": payload.email}, {"_id": 0, "id": 1})
    if existing:
        raise HTTPException(status_code=409, detail="Email already in use")
    user = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name,
        "email": payload.email,
        "password": hash_password(payload.password),
        "role": payload.team_type,
        "branch_id": payload.branch_id,
        "is_active": True,
        "created_at": now_iso(),
    }
    await v3_col("users").insert_one(user.copy())
    safe = {k: v for k, v in user.items() if k != "password"}
    return safe


# ============ all leads ============

@router.get("/all-leads")
async def all_leads(
    stage_type: Optional[Literal["pre_sales", "sales", "all"]] = "all",
    source: Optional[str] = None,
    assigned_to: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    query: Dict[str, Any] = without_past_moves()
    if stage_type == "pre_sales":
        query["stage"] = {"$in": ["New Leads", "Follow Up"]}
    elif stage_type == "sales":
        query["stage"] = "Appointment"
    if source:
        query["source_tab"] = source
    if assigned_to:
        query["assigned_user_id"] = assigned_to
    if search:
        rgx = {"$regex": re.escape(search), "$options": "i"}
        query["$or"] = [{"name": rgx}, {"phone": rgx}, {"email": rgx}]

    total = await v3_col("leads").count_documents(query)
    rows = await v3_col("leads").find(query, {"_id": 0}).sort("created_at", -1).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"total": total, "page": page, "page_size": page_size, "rows": rows}


@router.post("/assign-lead/{lead_id}")
async def assign_lead(lead_id: str, assigned_to: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    user = await v3_col("users").find_one({"id": assigned_to, "is_active": True}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    res = await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": {
            "assigned_user_id": assigned_to,
            "assigned_user_name": user.get("full_name", ""),
            "assigned_user_role": user.get("role", ""),
            "updated_at": now_iso(),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Lead not found")
    return {"message": "Lead reassigned", "assigned_user_id": assigned_to}


@router.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("leads").delete_one({"id": lead_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Lead not found")
    # The whole patient, not just the row — see lead_purge. Without this their reviews,
    # treatment days and portal login outlived them on every other board.
    await lead_purge.delete_lead_trail([lead_id])
    return {"message": "Lead deleted"}


@router.post("/leads/bulk-delete")
async def bulk_delete_leads(payload: BulkDelete, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    if not payload.lead_ids:
        return {"deleted": 0}
    res = await v3_col("leads").delete_many({"id": {"$in": payload.lead_ids}})
    await lead_purge.delete_lead_trail(payload.lead_ids)
    return {"deleted": res.deleted_count}


# ============ sources ============

def normalize_source(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Backfills the branch_ids/verticals/is_archived shape onto a source document that may
    predate them. Applied on every read so old docs (still carrying only a singular
    `branch_id`) and new docs look identical to callers — no one-off migration needed."""
    if "branch_ids" not in doc:
        legacy = doc.get("branch_id")
        doc["branch_ids"] = [legacy] if legacy else []
    if "sheet_names" not in doc:
        legacy_tab = doc.get("sheet_name")
        doc["sheet_names"] = [legacy_tab] if legacy_tab else ["Sheet1"]
    doc.setdefault("verticals", [])
    doc.setdefault("is_archived", False)

    # A mapping saved while "city" was one of Preferred Branch's aliases still points the
    # sheet's City column there, and a stored mapping is reused ahead of auto_map_columns
    # -- so fixing the alias table alone would leave every source already configured
    # filing cities under a branch name nobody has a branch by, until somebody happened to
    # reopen the mapping dialog and save it again.
    #
    # Re-pointed on read, like the branch_ids backfill above, so the dropdown shows the
    # mapping the importer is actually going to use. Only where the header itself says
    # city: a sheet that asks "preferred branch" and means it keeps its mapping, and a
    # source that has been re-mapped onto City properly is left alone.
    mapping = doc.get("column_mapping")
    if isinstance(mapping, dict) and not mapping.get("city"):
        column = mapping.get("preferred_branch")
        if column and squash_header(column) in CITY_HEADERS:
            mapping = dict(mapping)
            mapping["city"] = mapping.pop("preferred_branch")
            doc["column_mapping"] = mapping
    return doc


async def _validate_targets(branch_ids: Optional[List[str]], verticals: Optional[List[str]]) -> None:
    for bid in (branch_ids or []):
        branch = await v3_col("branches").find_one({"id": bid}, {"_id": 0, "id": 1})
        if not branch:
            raise HTTPException(status_code=404, detail=f"Branch not found: {bid}")
    for name in (verticals or []):
        vertical = await v3_col("verticals").find_one({"name": name}, {"_id": 0, "name": 1})
        if not vertical:
            raise HTTPException(status_code=404, detail=f"Vertical not found: {name}")


@router.get("/lead-field-catalogue")
async def lead_field_catalogue(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """The fields a sheet column can be mapped onto, grouped as the Create Lead form is.

    Served rather than hard-coded in the popup so the dropdown and the importer are the
    same list: this is the list the import knows how to write, and the custom questions
    are read live so one added from the dialog is mappable in the same breath.
    """
    customs = await v3_col("custom_lead_fields").find({}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return {"groups": lead_mapping.catalogue(customs)}


@router.get("/sources")
async def list_sources(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    rows = await v3_col("marketing_sources").find({}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return [normalize_source(r) for r in rows]


@router.post("/sources")
async def create_source(payload: MarketingSourceCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _validate_targets(payload.branch_ids, payload.verticals)
    spreadsheet_id = payload.spreadsheet_id or (extract_spreadsheet_id(payload.sheet_url) if payload.sheet_url else "")
    # A hand-made mapping wins over detection; detection is the fallback for a source
    # created without anyone having opened the dialog.
    column_mapping = dict(payload.column_mapping or {}) or (auto_map_columns(payload.headers or []) if payload.headers else {})
    detected_custom = [h for h in (payload.headers or []) if h not in column_mapping.values()]
    source = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "source_type": payload.source_type,
        "sheet_url": payload.sheet_url or "",
        "spreadsheet_id": spreadsheet_id,
        "sheet_name": payload.sheet_name or "Sheet1",
        "sheet_names": payload.sheet_names or [payload.sheet_name or "Sheet1"],
        "column_mapping": column_mapping,
        "custom_fields": detected_custom,
        "headers_detected": payload.headers or [],
        "branch_ids": payload.branch_ids or [],
        "verticals": payload.verticals or [],
        "row_count": 0,
        "last_synced": None,
        "is_active": True,
        "is_archived": False,
        "created_at": now_iso(),
    }
    await v3_col("marketing_sources").insert_one(source.copy())
    return source


@router.patch("/sources/{source_id}")
async def update_source(source_id: str, payload: MarketingSourceUpdate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _validate_targets(payload.branch_ids, payload.verticals)
    # Name is never taken from here: a source's card is named after the branch it belongs
    # to (see seed.ensure_branch_lead_sources), and letting an edit rename it away from
    # that would put Lead Sources and Branch Manager out of step again — the whole thing
    # this endpoint used to allow. It reasserts on the next startup reconciliation anyway,
    # so a stray "name" in the payload is silently dropped rather than rejected.
    updates = {k: v for k, v in payload.model_dump().items() if v is not None and k not in ("headers", "name")}
    if payload.sheet_url and not payload.spreadsheet_id:
        extracted = extract_spreadsheet_id(payload.sheet_url)
        if extracted:
            updates["spreadsheet_id"] = extracted
    if payload.headers is not None:
        column_mapping = auto_map_columns(payload.headers) if payload.headers else {}
        updates["headers_detected"] = payload.headers
        updates["column_mapping"] = column_mapping
        updates["custom_fields"] = [h for h in payload.headers if h not in column_mapping.values()]
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    res = await v3_col("marketing_sources").update_one({"id": source_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Source not found")
    return normalize_source(await v3_col("marketing_sources").find_one({"id": source_id}, {"_id": 0}))


@router.delete("/sources/{source_id}")
async def delete_source(source_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("marketing_sources").delete_one({"id": source_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Source not found")
    return {"message": "Source deleted"}


@router.post("/sources/{source_id}/sync")
async def sync_source(source_id: str, payload: MarketingSyncInput, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    source = await v3_col("marketing_sources").find_one({"id": source_id}, {"_id": 0})
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    # Normalized here for the same reason the sheet pull does it: both buttons on a source
    # card have to read the source the same way, and the City re-point lives in there.
    source = normalize_source(source)
    mapping = dict(source.get("column_mapping", {}) or {})
    # If mapping is missing entries, auto-map from the FIRST row's keys
    if payload.rows and not all(k in mapping for k in ("name", "phone")):
        first_row_keys = list(payload.rows[0].keys())
        inferred = auto_map_columns(first_row_keys)
        for k, v in inferred.items():
            mapping.setdefault(k, v)

    if "phone" not in mapping:
        # Last-ditch fallback: treat row['phone'] as phone
        mapping["phone"] = "phone"

    phone_key = mapping["phone"]
    imported = 0
    skipped_no_phone = 0
    skipped_duplicate = 0
    sample_errors: List[str] = []
    # The branch this source is tagged to, read the same way the Sheets pull reads it: one
    # branch auto-assigns, zero or several are a tag only. This used to read the legacy
    # singular `branch_id`, which normalize_source backfills *from* rather than *to* — so a
    # source carrying only the modern branch_ids list imported every row with no branch at
    # all here, while Pull from Sheet on the same card filed them correctly.
    branch_ids = source.get("branch_ids") or []
    source_branch_id = branch_ids[0] if len(branch_ids) == 1 else None
    # A row naming its own branch overrides that — see branch_routing, and the Sheets pull,
    # which routes identically. Both buttons read one column_mapping and must agree.
    branch_router = await branch_routing.load()
    branch_entry: Dict[Optional[str], tuple] = {}
    routed_to: Dict[str, int] = {}

    async def _entry_for(branch_id: Optional[str]) -> tuple:
        """(lead control, entry branch stage) for one branch, looked up once."""
        if branch_id not in branch_entry:
            control = await lead_control.branch_lead_control(branch_id)
            branch_entry[branch_id] = (
                control, await first_branch_stage_for(control, "New Appointment"),
            )
        return branch_entry[branch_id]

    for idx, row in enumerate(payload.rows):
        phone_raw = str(row.get(phone_key, "") or "").strip()
        phone_norm = normalize_phone(phone_raw)
        if not phone_norm:
            skipped_no_phone += 1
            if len(sample_errors) < 3:
                sample_errors.append(f"row {idx + 1}: missing/invalid phone (looking in column '{phone_key}')")
            continue
        # Not against Past Data's trial clients: a returning patient's new enquiry is a new
        # lead, and one of those matching it would drop it here unseen.
        exists = await v3_col("leads").find_one(without_past_moves({"phone_normalized": phone_norm}), {"_id": 0, "id": 1})
        if exists:
            skipped_duplicate += 1
            if len(sample_errors) < 3:
                sample_errors.append(f"row {idx + 1}: duplicate phone {phone_raw}")
            continue

        # The same split the Google Sheets pull does, against the same stored mapping.
        # Both buttons on a source card read one column_mapping, so if only one of them
        # understood the whole catalogue, Manual Sync and Pull from Sheet would file the
        # same sheet two different ways.
        lead_columns, ad_record, mapped_extras = lead_mapping.split_mapping(row, mapping)
        std_payload: Dict[str, Any] = lead_columns
        custom_payload: Dict[str, Any] = dict(mapped_extras)
        mapped_values = set(mapping.values())
        for key, value in row.items():
            if key not in mapped_values and value not in (None, ""):
                custom_payload.setdefault(key, value)

        # Which branch this patient asked for, falling back to the source's own tag where
        # the row names no branch (or names one nobody has).
        row_branch_id = branch_routing.routed_branch_id(row, mapping, branch_router) or source_branch_id
        if row_branch_id and row_branch_id != source_branch_id:
            branch_name = branch_router.name_of(row_branch_id)
            routed_to[branch_name] = routed_to.get(branch_name, 0) + 1
        row_control, row_branch_stage = await _entry_for(row_branch_id)

        # No Pre-Sales rep on a lead the Pre-Sales desk will never see — read off the
        # branch the row is going to, not the source's.
        assigned = None if row_control == lead_control.BRANCH_ADMIN else await round_robin_assign("pre_sales")
        patient_number = await generate_patient_number(row_branch_id) if row_branch_id else None
        # Same as the Sheets importer: a lead is dated by when the patient enquired, not by
        # when this sync happened to reach them. See enquiry_created_at.
        enquired_at = enquiry_created_at(find_enquiry_stamp(ad_record, custom_payload))
        lead = {
            "id": str(uuid.uuid4()),
            "patient_number": patient_number,
            "name": (str(std_payload.get("name") or "")).strip() or "Unknown",
            "phone": phone_raw,
            "phone_normalized": phone_norm,
            "email": std_payload.get("email", ""),
            "vertical": std_payload.get("vertical") or "offline_physiotherapy",
            "source_tab": source["name"],
            "source_type": source.get("source_type", "google_sheets"),
            # Pre-Sales stage stays normal ("New Leads") regardless — a source tagged with a
            # branch only ADDS the branch assignment, landing the lead in that branch's New
            # Appointment column too, without pulling it out of the usual Pre-Sales workflow.
            "stage": "New Leads",
            "branch_id": row_branch_id,
            "branch_stage": row_branch_stage if row_branch_id else None,
            "notes": std_payload.get("notes", ""),
            **{k: v for k, v in std_payload.items() if k not in ("name", "email", "phone", "vertical", "notes")},
            "lead_data": ad_record,
            "extra_fields": custom_payload,
            "assigned_user_id": assigned["id"] if assigned else None,
            "assigned_user_name": assigned["full_name"] if assigned else None,
            "assigned_user_role": "pre_sales" if assigned else None,
            "marketing_source_id": source_id,
            "created_at": enquired_at or now_iso(),
            "updated_at": now_iso(),
        }
        await v3_col("leads").insert_one(lead.copy())
        imported += 1

    new_row_count = (source.get("row_count") or 0) + imported
    update = {"last_synced": now_iso(), "row_count": new_row_count}
    # Persist the inferred mapping so future syncs reuse it
    if mapping != (source.get("column_mapping") or {}):
        update["column_mapping"] = mapping
    await v3_col("marketing_sources").update_one({"id": source_id}, {"$set": update})

    skipped = skipped_no_phone + skipped_duplicate
    return {
        "imported": imported,
        "skipped": skipped,
        "skipped_no_phone": skipped_no_phone,
        "skipped_duplicate": skipped_duplicate,
        "rows_received": len(payload.rows),
        "phone_column_used": phone_key,
        "mapping_used": mapping,
        "branch_column_used": mapping.get(branch_routing.BRANCH_FIELD),
        "routed_to_branches": routed_to,
        "sample_errors": sample_errors,
    }


# ============ performance ============

@router.get("/performance")
async def performance(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    funnel = []
    for stage in V3_STAGES:
        count = await v3_col("leads").count_documents(without_past_moves({"stage": stage}))
        funnel.append({"stage": stage, "count": count})

    pre_pipeline = [
        {"$match": {"assigned_user_role": "pre_sales"}},
        {"$group": {"_id": {"id": "$assigned_user_id", "name": "$assigned_user_name"}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    sales_pipeline = [
        {"$match": {"assigned_user_role": "branch_admin", "stage": "Completed"}},
        {"$group": {"_id": {"id": "$assigned_user_id", "name": "$assigned_user_name"}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    pre_rows = await v3_col("leads").aggregate(pre_pipeline).to_list(50)
    sales_rows = await v3_col("leads").aggregate(sales_pipeline).to_list(50)

    return {
        "funnel": funnel,
        "leads_per_pre_sales": [{"name": r["_id"].get("name") or "Unassigned", "count": r["count"]} for r in pre_rows],
        "deals_per_sales": [{"name": r["_id"].get("name") or "Unassigned", "count": r["count"]} for r in sales_rows],
    }


# ------------------------------------------------------- one team member's own leads

def _lead_source_name(lead: Dict[str, Any]) -> str:
    return lead.get("source_tab") or lead.get("source_type") or "unknown"


def _lead_stage_name(lead: Dict[str, Any]) -> str:
    """The stage a lead is at, from whichever pipeline currently owns it.

    branch_stage first: once a lead is handed to a branch that is the live position, and
    `stage` is left holding wherever Pre-Sales last had it. Reading `stage` alone would
    report every converted patient as still sitting in Appointment.
    """
    return lead.get("branch_stage") or lead.get("stage") or "—"


@router.get("/team-members/{member_id}/leads")
async def team_member_leads(
    member_id: str,
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    limit: int = 500,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """The leads behind one team member's card.

    Which leads are "theirs" depends on the tier, and both readings are taken straight
    from get_team_members so the popup can never contradict the card that opened it:

      Pre-Sales   leads assigned to them (assigned_user_id). They own by assignment.
      Branch      leads belonging to their branch. Nothing sets assigned_user_id to a
                  Branch Admin, so ownership by assignment would report zero for every
                  one of them.

    The header figures are computed over the member's WHOLE book, never over the filtered
    list — `filtered` reports that separately. A Conversion Rate that moved when you
    picked a date range would be a different statistic wearing the same label.
    """
    user = await v3_col("users").find_one({"id": member_id}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Team member not found")

    role = user.get("role")
    if role == "pre_sales":
        owned = {"assigned_user_id": member_id}
    elif user.get("branch_id"):
        owned = {"branch_id": user["branch_id"]}
    else:
        owned = None

    leads = await v3_col("leads").find(owned, {"_id": 0}).sort("created_at", -1).to_list(20000) if owned else []

    # Headline figures, over the WHOLE book. Each line mirrors get_team_members, because
    # the popup opens off a card and the two showing different numbers for the same person
    # is the fault this drill-down exists to make impossible.
    total_leads = len(leads)

    if role == "pre_sales":
        # Owns by assignment; converted means the lead reached a physio, and the rate is
        # measured against everything handed to them.
        secondary = None
        converted = len([l for l in leads if l.get("assigned_physio_id")])
        denominator = total_leads
    else:
        # Owns by branch. Appointments and conversions are measured over the same
        # population — the patients booked in — or a patient who reached a physio without
        # a consultation on record would push the rate past 100%.
        appt_lead_ids = {
            i for i in (await v3_col("appointments").distinct(
                "lead_id", {"branch_id": user["branch_id"], "appt_kind": "consultation"}
            )) if i
        } if user.get("branch_id") else set()
        by_id = {l["id"]: l for l in leads}
        secondary = len(appt_lead_ids)
        converted = len([
            by_id[i] for i in appt_lead_ids
            if i in by_id and by_id[i].get("assigned_physio_id")
        ])
        denominator = secondary

    conversion_rate = round((converted / denominator * 100.0), 1) if denominator else 0.0

    # Built before the filters below, so a stage you filter to is still listed after you
    # pick it, and a source you filter away can still be chosen again.
    by_stage: Dict[str, int] = {}
    by_source: Dict[str, int] = {}
    for l in leads:
        by_stage[_lead_stage_name(l)] = by_stage.get(_lead_stage_name(l), 0) + 1
        by_source[_lead_source_name(l)] = by_source.get(_lead_source_name(l), 0) + 1

    rows = leads
    if from_date:
        rows = [l for l in rows if str(l.get("created_at") or "")[:10] >= from_date]
    if to_date:
        rows = [l for l in rows if str(l.get("created_at") or "")[:10] <= to_date]
    if source:
        rows = [l for l in rows if _lead_source_name(l) == source]
    if stage:
        rows = [l for l in rows if _lead_stage_name(l) == stage]

    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    branch_names = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    return {
        "member": {
            "id": user["id"],
            "full_name": user.get("full_name", ""),
            "email": user.get("email", ""),
            "role": role,
            "branch_name": branch_names.get(user.get("branch_id"), ""),
        },
        "total_leads": total_leads,
        # Appointments, and only for a branch — a Pre-Sales agent has no such figure, so
        # it comes back null rather than as a zero the popup would then have to print.
        "appointments": secondary,
        "converted": converted,
        "conversion_rate": conversion_rate,
        "filtered": len(rows),
        "stages": sorted(({"name": k, "value": v} for k, v in by_stage.items()), key=lambda r: -r["value"]),
        "sources": sorted(({"name": k, "value": v} for k, v in by_source.items()), key=lambda r: -r["value"]),
        "leads": [
            {
                "id": l.get("id"),
                "name": l.get("name", "Unknown"),
                "phone": l.get("phone", ""),
                "email": l.get("email", ""),
                "branch_name": branch_names.get(l.get("branch_id"), ""),
                "source": _lead_source_name(l),
                "stage": _lead_stage_name(l),
                "created_at": l.get("created_at"),
            }
            for l in rows[:limit]
        ],
    }
