"""FITSIO STORE — consultation catalog items (name, description, image, online/offline)."""
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

import consultation_packages
import lead_package_pricing
import store_branch_overrides
from database import v3_col
from deps import role_satisfies, v3_require_roles
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3/store", tags=["store"])

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads", "store")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


def _now():
    return datetime.now(timezone.utc).isoformat()


# branch_admin because a Branch Admin may edit a package (see update_store_item), and
# the Edit dialog's Change image uploads through here before it saves.
@router.post("/upload-image")
async def upload_store_image(file: UploadFile = File(...), _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "branch_admin"))):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only JPG, PNG, or WEBP images are allowed")
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Image must be under 5MB")
    filename = f"{uuid.uuid4()}{ext}"
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(contents)
    return {"url": f"/api/v3/uploads/store/{filename}"}


VALID_DURATIONS_MINUTES = {15, 30, 45, 60, 120}

# A packaged consultation starts at its package's length, but Super Admin may set it to
# anything within a working day instead — the package is the default, not a lock.
PACKAGED_MIN_MINUTES = 5
PACKAGED_MAX_MINUTES = 480


def _check_packaged_minutes(payload: "StoreItemIn", packaged_minutes: Optional[int]) -> None:
    if packaged_minutes is None:
        return
    if not (PACKAGED_MIN_MINUTES <= payload.duration_minutes <= PACKAGED_MAX_MINUTES):
        raise HTTPException(
            status_code=400,
            detail=f"Duration must be between {PACKAGED_MIN_MINUTES} and {PACKAGED_MAX_MINUTES} minutes",
        )

def _packaged_duration(payload: "StoreItemIn") -> Optional[int]:
    """The duration this item's package fixes, or None where it names no package.

    The table itself lives in backend/consultation_packages.py, free of FastAPI and of the
    database, so the arithmetic deciding how much of a physio's day an appointment takes can
    be read and tested on its own. All this adds is turning its refusal into a 400.
    """
    try:
        return consultation_packages.duration_for(payload.consultation_package)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"consultation_package must be one of: {', '.join(consultation_packages.keys())}",
        )

# "diet" is the Diet Consultation package — priced and timed exactly like a physio
# consultation, which is why it validates against the same rules rather than getting its
# own. Sessions are the odd one out: they carry a session count instead of a duration.
#
# "diet_package" is the Diet Chart-style product Super Admin's top-level Diet Package tab
# now catalogs — a flat-priced item with no booking slot, split out from "diet" once the
# actual Diet Consultation booking moved to the Consultations tab. Not timed, same as
# "session": no duration to validate.
ITEM_TYPES = ("consultation", "session", "diet", "diet_package")

# Shelves whose price is the course, entered and kept exactly as typed with no arithmetic
# between the box and the bill. Rehab and Fitness are both sold as one programme at one
# agreed figure, so there is no rate to derive and no reason to derive one.
#
# A property of the shelf, not of the row: a new package on either is entered this way the
# moment it is created, without anyone remembering to mark it.
PRICE_IS_TOTAL_CATEGORIES = ("rehab", "fitness")
TIMED_ITEM_TYPES = ("consultation", "diet")


class StoreItemIn(BaseModel):
    item_type: str = "consultation"  # "consultation" | "session"
    category: str
    name: str
    description: Optional[str] = ""
    image_url: Optional[str] = None
    price_online: float = 1200
    price_offline: float = 800
    duration_minutes: int = 30  # one of VALID_DURATIONS_MINUTES; consultation items only
    # Which of the three fixed Physiotherapy consultation packages this is, if any. When
    # set, the form pre-fills duration_minutes from it and Super Admin may change it —
    # see CONSULTATION_PACKAGES. Absent on every item created before the packages existed,
    # and on the shelves that still name themselves (Fitness, Diet Consultations), which
    # go on picking a duration by hand.
    consultation_package: Optional[str] = None
    sessions_online: Optional[int] = None  # session items only
    sessions_offline: Optional[int] = None  # session items only
    # Whether price_online/price_offline is the whole course rather than a rate per
    # session. Set from the category on the way in, never accepted from the client — the
    # two must not be able to disagree about what the number on the row means.
    price_is_total: Optional[bool] = None
    # The amount is not set here but typed by the Branch Admin when the package is booked
    # (Home Visit > Consultant, e.g. a Distance visit, whose cost depends on how far the
    # trip is). The row's own price is then only a placeholder and is never charged.
    manual_price: Optional[bool] = False


class StoreItemOut(StoreItemIn):
    id: str
    created_at: str
    updated_at: str
    # True where the branch the list was read for keeps its own values for this package
    # (see store_branch_overrides). Absent on Super Admin's own catalogue.
    branch_override: Optional[bool] = None


# The two desks that oversee every branch. Anyone else reads the store as their own branch.
OFFICE_WIDE_ROLES = ("super_admin", "business_dev")


def _branch_for(user: V3UserOut, requested: Optional[str]) -> Optional[str]:
    """Which branch's Services and Products this request is about.

    Super Admin and Business Development name one (driving a branch's board), or none for
    the catalogue itself. A Branch Admin is always their own branch whatever is asked for;
    a Consultant posted to several may name any of theirs.
    """
    if role_satisfies(user.role, OFFICE_WIDE_ROLES):
        return requested or None
    if requested and (requested == user.branch_id or requested in (user.branch_ids or [])):
        return requested
    return user.branch_id


def _normalize_legacy_prices(doc: dict) -> dict:
    """Back-fill fields for items created before dual online/offline pricing existed."""
    if "price_online" not in doc or "price_offline" not in doc:
        legacy_price = doc.get("price")
        legacy_mode = doc.get("mode")
        if legacy_price is not None:
            if legacy_mode == "online":
                doc.setdefault("price_online", legacy_price)
            elif legacy_mode == "offline":
                doc.setdefault("price_offline", legacy_price)
    if "sessions_online" not in doc or "sessions_offline" not in doc:
        legacy_sessions = doc.get("sessions_count")
        if legacy_sessions is not None:
            doc.setdefault("sessions_online", legacy_sessions)
            doc.setdefault("sessions_offline", legacy_sessions)
    return doc


@router.post("/items", response_model=StoreItemOut)
async def create_store_item(payload: StoreItemIn, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if payload.price_online < 0 or payload.price_offline < 0:
        raise HTTPException(status_code=400, detail="Price cannot be negative")
    if payload.item_type not in ITEM_TYPES:
        raise HTTPException(status_code=400, detail=f"item_type must be one of: {', '.join(ITEM_TYPES)}")
    # A packaged consultation's length defaults to its package's but is editable, so the
    # hand-picked whitelist is checked only for the shelves that still pick off buttons.
    packaged_minutes = _packaged_duration(payload)
    _check_packaged_minutes(payload, packaged_minutes)
    if payload.item_type in TIMED_ITEM_TYPES and packaged_minutes is None and payload.duration_minutes not in VALID_DURATIONS_MINUTES:
        raise HTTPException(status_code=400, detail="Duration must be one of 15, 30, 45, 60, or 120 minutes")
    if payload.item_type == "session" and (not payload.sessions_online or payload.sessions_online < 1):
        raise HTTPException(status_code=400, detail="Online sessions count must be at least 1")
    if payload.item_type == "session" and (not payload.sessions_offline or payload.sessions_offline < 1):
        raise HTTPException(status_code=400, detail="Offline sessions count must be at least 1")
    doc = payload.model_dump()
    doc["price_is_total"] = payload.category in PRICE_IS_TOTAL_CATEGORIES
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = _now()
    doc["updated_at"] = _now()
    await v3_col("store_items").insert_one(doc.copy())
    return doc


# What a Branch Admin may edit from their own FITSIO STORE: every package shelf —
# consultations, session packages (Sessions, Rehab, Zumba, Workshop, Home Visit) and diet
# packages. None is a consultation created before item_type existed.
BRANCH_EDITABLE_ITEM_TYPES = (None, *ITEM_TYPES)


@router.put("/items/{item_id}", response_model=StoreItemOut)
async def update_store_item(
    item_id: str,
    payload: StoreItemIn,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "branch_admin")),
):
    # A Branch Admin edits an existing package — its name, description, image, duration or
    # session count and prices — but may not turn it into another kind of item or move it
    # to another shelf. Super Admin and Business Development keep the full edit, and alone
    # create and delete.
    #
    # Where it lands is the developer switch's call (store_branch_overrides). Off: the row
    # every branch books from. On: that branch's own copy of the values, leaving the default
    # and every other branch alone. Super Admin reaches a branch's copy by editing from
    # inside that branch's board, which sends its branch_id; from the catalogue itself it
    # is the default that changes.
    target_branch = _branch_for(user, branch_id)
    per_branch = bool(target_branch) and await store_branch_overrides.enabled()
    if not role_satisfies(user.role, OFFICE_WIDE_ROLES) or per_branch:
        existing = await v3_col("store_items").find_one({"id": item_id}, {"_id": 0, "item_type": 1, "category": 1})
        if not existing:
            raise HTTPException(status_code=404, detail="Item not found")
        existing_type = existing.get("item_type") or "consultation"
        if (
            existing.get("item_type") not in BRANCH_EDITABLE_ITEM_TYPES
            or payload.item_type != existing_type
            or payload.category != existing.get("category")
        ):
            raise HTTPException(status_code=403, detail="A branch cannot change a package's type or shelf")
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if payload.price_online < 0 or payload.price_offline < 0:
        raise HTTPException(status_code=400, detail="Price cannot be negative")
    if payload.item_type not in ITEM_TYPES:
        raise HTTPException(status_code=400, detail=f"item_type must be one of: {', '.join(ITEM_TYPES)}")
    packaged_minutes = _packaged_duration(payload)
    _check_packaged_minutes(payload, packaged_minutes)
    if payload.item_type in TIMED_ITEM_TYPES and packaged_minutes is None and payload.duration_minutes not in VALID_DURATIONS_MINUTES:
        raise HTTPException(status_code=400, detail="Duration must be one of 15, 30, 45, 60, or 120 minutes")
    if payload.item_type == "session" and (not payload.sessions_online or payload.sessions_online < 1):
        raise HTTPException(status_code=400, detail="Online sessions count must be at least 1")
    if payload.item_type == "session" and (not payload.sessions_offline or payload.sessions_offline < 1):
        raise HTTPException(status_code=400, detail="Offline sessions count must be at least 1")
    if per_branch:
        await store_branch_overrides.save(item_id, target_branch, payload.model_dump(), user.full_name)
        # A new rate reaches the patients already holding this package and not yet billed.
        await lead_package_pricing.reprice_unpaid_leads(item_id)
        doc = await v3_col("store_items").find_one({"id": item_id}, {"_id": 0})
        return _normalize_legacy_prices(await store_branch_overrides.overlay_one(doc, target_branch))
    update = payload.model_dump()
    update["price_is_total"] = payload.category in PRICE_IS_TOTAL_CATEGORIES
    update["updated_at"] = _now()
    res = await v3_col("store_items").update_one({"id": item_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    await lead_package_pricing.reprice_unpaid_leads(item_id)
    doc = await v3_col("store_items").find_one({"id": item_id}, {"_id": 0})
    return doc


@router.get("/items", response_model=List[StoreItemOut])
async def list_store_items(
    category: Optional[str] = None,
    item_type: Optional[str] = None,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio", "business_dev")),
):
    q = {}
    if category:
        q["category"] = category
    if item_type == "consultation":
        # items created before item_type existed are consultations by default
        q["item_type"] = {"$in": ["consultation", None]}
    elif item_type:
        q["item_type"] = item_type
    docs = await v3_col("store_items").find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    # Every branch-side picker (booking, fee collection, Zumba, Fitness) reads through here,
    # so this one overlay is what makes a branch see its own prices and durations everywhere.
    docs = await store_branch_overrides.overlay(docs, _branch_for(user, branch_id))
    return [_normalize_legacy_prices(d) for d in docs]


@router.delete("/items/{item_id}")
async def delete_store_item(item_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    res = await v3_col("store_items").delete_one({"id": item_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    await store_branch_overrides.forget_item(item_id)
    return {"message": "Item deleted"}


# Every lead_activity action that represents money changing hands for a Fitsio Store item —
# a consultation, session package, or its collection — as opposed to unrelated activity like
# stage moves or diagnosis notes.
STORE_HISTORY_ACTIONS = [
    "consultation_paid",
    "package_sold",
    "package_assigned",
    "package_payment_collected",
    "treatment_fee_collected",
    "diet_fee_collected",
    "diet_chart_fee_collected",
    "rehab_fee_collected",
    "fee_collected",
]

# Subset of the above that represents money actually collected — excludes package_assigned,
# which is just the Head Physio's inline package choice with no payment yet.
PAYMENT_HISTORY_ACTIONS = [
    "consultation_paid",
    "package_sold",
    "package_payment_collected",
    "treatment_fee_collected",
    "diet_fee_collected",
    "diet_chart_fee_collected",
    "rehab_fee_collected",
    "fee_collected",
]

# Every follow-up scheduled/rescheduled across Pre-Sales, Branch Leads, and Consultations.
FOLLOW_UP_HISTORY_ACTIONS = [
    "follow_up_scheduled",
    "follow_up_rescheduled",
    "branch_follow_up_scheduled",
    "branch_follow_up_rescheduled",
    "consultation_follow_up_scheduled",
    "consultation_follow_up_rescheduled",
]


async def _lead_activity_history(actions: list, limit: int) -> dict:
    """Shared lookup: lead_activity rows enriched with patient/branch names — backs all
    of the Super Admin FITSIO STORE > History sub-tabs that read off a lead's timeline."""
    rows = await v3_col("lead_activity").find(
        {"action": {"$in": actions}}, {"_id": 0}
    ).sort("created_at", -1).to_list(max(1, min(limit, 500)))

    lead_ids = list({r["lead_id"] for r in rows if r.get("lead_id")})
    leads = await v3_col("leads").find(
        {"id": {"$in": lead_ids}}, {"_id": 0, "id": 1, "name": 1, "phone": 1, "branch_id": 1}
    ).to_list(1000)
    lead_map = {l["id"]: l for l in leads}

    branch_ids = list({l["branch_id"] for l in leads if l.get("branch_id")})
    branches = await v3_col("branches").find(
        {"id": {"$in": branch_ids}}, {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    branch_map = {b["id"]: b.get("branch_name", "") for b in branches}

    history = []
    for r in rows:
        lead = lead_map.get(r.get("lead_id"), {})
        history.append({
            **r,
            "patient_name": lead.get("name", "Unknown"),
            "patient_phone": lead.get("phone", ""),
            "branch_name": branch_map.get(lead.get("branch_id"), ""),
        })
    return {"history": history}


@router.get("/history")
async def store_history(
    limit: int = 200,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio", "business_dev")),
):
    """Chronological listing of Fitsio Store sales/collections across the whole system —
    consultations sold, session packages assigned/collected — for the Super Admin
    FITSIO STORE > History > Transactions History sub-tab."""
    return await _lead_activity_history(STORE_HISTORY_ACTIONS, limit)


@router.get("/payment-history")
async def payment_history(
    limit: int = 200,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio", "business_dev")),
):
    """Money actually collected (excludes package assignment, which has no payment yet) —
    Super Admin FITSIO STORE > History > Payment History sub-tab."""
    return await _lead_activity_history(PAYMENT_HISTORY_ACTIONS, limit)


@router.get("/follow-up-history")
async def follow_up_history(
    limit: int = 200,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio", "business_dev")),
):
    """Every follow-up scheduled/rescheduled across Pre-Sales, Branch Leads, and
    Consultations — Super Admin FITSIO STORE > History > Follow Up History sub-tab."""
    return await _lead_activity_history(FOLLOW_UP_HISTORY_ACTIONS, limit)


@router.get("/login-history")
async def login_history(
    limit: int = 200,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Every successful login across the OS — Super Admin FITSIO STORE > History >
    Overall Login Tracker sub-tab. Super Admin only: user activity, not store data."""
    rows = await v3_col("login_history").find({}, {"_id": 0}).sort("created_at", -1).to_list(max(1, min(limit, 500)))

    branch_ids = list({r["branch_id"] for r in rows if r.get("branch_id")})
    branches = await v3_col("branches").find(
        {"id": {"$in": branch_ids}}, {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    branch_map = {b["id"]: b.get("branch_name", "") for b in branches}
    for r in rows:
        r["branch_name"] = branch_map.get(r.get("branch_id"), "")
    return {"history": rows}
