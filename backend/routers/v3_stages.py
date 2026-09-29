from fastapi import APIRouter, Depends, HTTPException
from typing import Optional, List, Literal
from pydantic import BaseModel, Field
import uuid

from database import v3_col
from utils import now_iso, without_past_moves
from deps import v3_require_roles, v3_current_user, names_the_online_arm
from constants import (
    V3_STAGES, V3_BRANCH_STAGES, V3_CONSULTATION_STAGES, V3_HEAD_CONSULTATION_STAGES,
    SALES_ARM_OFFLINE, SALES_ARM_ONLINE, SALES_ARMS,
)
from schemas.v3 import V3UserOut


router = APIRouter(prefix="/api/v3/stages")


PRESALES_COLORS = ["#6366f1", "#ef4444", "#f97316", "#f59e0b", "#a855f7", "#22c55e", "#0ea5e9", "#64748b"]
SALES_COLORS = ["#0ea5e9", "#06b6d4", "#14b8a6", "#22c55e", "#84cc16", "#eab308", "#f59e0b", "#f97316",
                "#ef4444", "#ec4899", "#a855f7", "#6366f1"]
CONSULTATION_COLORS = ["#3b82f6", "#f43f5e", "#f97316", "#8b5cf6", "#14b8a6", "#22c55e", "#64748b"]
HEAD_CONSULTATION_COLORS = ["#3b82f6", "#0ea5e9", "#8b5cf6", "#a855f7"]

STAGE_TYPE_FIELD = {
    "pre_sales": "stage",
    "sales": "branch_stage",
    "consultation": "consultation_stage",
    "head_consultation": "head_consultation_stage",
}

# Recruitment is the one pipeline whose records don't live in `leads`: candidates are in
# their own collection and hold `stage_id` rather than the stage's name. That makes every
# name-based operation below a no-op for it — renaming needs no record rewrite at all —
# but the count and the in-use check still have to look somewhere, so they look there.
RECRUITMENT_TYPE = "recruitment"

# The Branch pipeline, which is two lists rather than one: the clinic runs an offline
# practice and an online one, each with its own stages and its own CI/CD ROOTS tab. Told
# apart by `arm` on the row -- see constants.SALES_ARMS.
SALES_TYPE = "sales"

# The second pipeline whose records aren't leads. A Zumba registration lives in
# zumba_registrations and holds the stage's name, so unlike recruitment a rename does
# have to be written through — it just has to be written to a different collection.
#
# Nothing is seeded for it. The other pipelines ship with the stages this clinic
# already ran; a Zumba class has no such received shape, and inventing one here would
# put words in the branch's mouth. The tab opens empty with Add Stage on it.
ZUMBA_TYPE = "zumba"
ZUMBA_COLLECTION = "zumba_registrations"
ZUMBA_FIELD = "stage"

StageType = Literal["pre_sales", "sales", "consultation", "head_consultation", "recruitment", "zumba"]

# What a role-bearing stage is for, in the words the refusal to delete it uses. The role
# itself lives on the stage row; see constants.SALES_STAGE_ROLES_BY_NAME.
ROLE_DESCRIPTIONS = {
    "appointment": "hold a booked appointment",
    "cancelled": "cancel an appointment and free the expert's slot",
    "rnr": "park a lead nobody could reach",
    "portfolio": "hold a patient booked through the Portfolio dialog",
    "follow_up": "offer Follow Up as an exit from a booked appointment",
}


# A stage's hover and selected colours, beside its ordinary one. Only CI/CD ROOTS'
# Pre-Sales tab offers them, but they are plain optional fields on every row -- a stage
# without them draws in its one colour everywhere, which is what every other pipeline does.
# "" clears one back to that fallback, so it is allowed alongside a #rrggbb.
STATE_COLOR = Field(default=None, pattern=r"^(#[0-9a-fA-F]{6})?$")


class StageCreate(BaseModel):
    name: str
    color: Optional[str] = "#64748b"
    hover_color: Optional[str] = STATE_COLOR
    selected_color: Optional[str] = STATE_COLOR
    type: StageType
    is_final: Optional[bool] = False
    # Which Branch arm the stage belongs to. Meaningless on every other pipeline, and
    # defaulted to offline rather than left unset so a stage created before this field
    # reached the client does not land in both arms at once.
    arm: Optional[str] = None


class StageUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    hover_color: Optional[str] = STATE_COLOR
    selected_color: Optional[str] = STATE_COLOR
    is_final: Optional[bool] = None


class StageReorder(BaseModel):
    items: List[dict]  # [{id, order}]


async def _ensure_seed() -> None:
    existing = await v3_col("pipeline_stages").count_documents({})
    if existing > 0:
        return
    docs = []
    for idx, name in enumerate(V3_STAGES):
        docs.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "color": PRESALES_COLORS[idx % len(PRESALES_COLORS)],
            "type": "pre_sales",
            "order": idx,
            "is_final": name in ("Completed",),
            "created_at": now_iso(),
        })
    for idx, name in enumerate(V3_BRANCH_STAGES):
        docs.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "color": SALES_COLORS[idx % len(SALES_COLORS)],
            "type": "sales",
            "order": idx,
            "is_final": name in ("Assigned Physio", "Cancelled"),
            # Stamped here as well as in seed.ensure_sales_arm_split, because this seed
            # fires on the first read rather than at startup: on a fresh install it can run
            # before the split has, and an unstamped row belongs to both arms at once --
            # which would show one list on both Branch tabs and edit them together.
            "arm": SALES_ARM_OFFLINE,
            "created_at": now_iso(),
        })
    for idx, name in enumerate(V3_CONSULTATION_STAGES):
        docs.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "color": CONSULTATION_COLORS[idx % len(CONSULTATION_COLORS)],
            "type": "consultation",
            "order": idx,
            "is_final": name in ("Treatment Fee", "Cancel"),
            "created_at": now_iso(),
        })
    for idx, name in enumerate(V3_HEAD_CONSULTATION_STAGES):
        docs.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "color": HEAD_CONSULTATION_COLORS[idx % len(HEAD_CONSULTATION_COLORS)],
            "type": "head_consultation",
            "order": idx,
            "is_final": name in ("Physio Assign",),
            "created_at": now_iso(),
        })
    if docs:
        await v3_col("pipeline_stages").insert_many(docs)


async def _arm_branch_ids(arm: str) -> List[str]:
    """The branches on one arm, for counting that arm's leads.

    Read as a token test on `vertical` rather than as an equality, the same way every other
    reading of the arm is -- `vertical` is not a controlled field on this install.
    """
    rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "vertical": 1}).to_list(1000)
    online = arm == SALES_ARM_ONLINE
    return [r["id"] for r in rows if names_the_online_arm(r.get("vertical")) == online]


@router.get("")
async def list_stages(
    type: Optional[StageType] = None,
    arm: Optional[str] = None,
    _: V3UserOut = Depends(v3_current_user),
):
    await _ensure_seed()
    if type == RECRUITMENT_TYPE:
        # Its own seed: _ensure_seed above only fires on a completely empty collection, so
        # in production a type added later would never appear.
        from routers.v3_recruitment import _ensure_recruitment_stages
        await _ensure_recruitment_stages()

    query = {"type": type} if type else {}
    # The Branch pipeline is two lists now, one per arm, each edited on its own CI/CD ROOTS
    # tab. A row with no `arm` predates the split and belongs to whichever arm is asked for,
    # so a database mid-upgrade shows its stages rather than an empty tab.
    if type == SALES_TYPE and arm:
        query["$or"] = [{"arm": arm}, {"arm": {"$exists": False}}, {"arm": None}]
    rows = await v3_col("pipeline_stages").find(query, {"_id": 0}).sort([("type", 1), ("order", 1)]).to_list(500)

    if type == RECRUITMENT_TYPE:
        by_stage_id = {}
        async for row in v3_col("candidates").aggregate([{"$group": {"_id": "$stage_id", "n": {"$sum": 1}}}]):
            by_stage_id[row["_id"]] = row["n"]
        for r in rows:
            r["lead_count"] = by_stage_id.get(r["id"], 0)
        return rows

    if type == ZUMBA_TYPE:
        # Seeded on read, the same way recruitment is above: _ensure_seed only fires on a
        # completely empty collection, so a pipeline added after this install existed would
        # otherwise never appear and this screen would say "No stages yet" for good.
        from routers.v3_zumba import ensure_zumba_stages
        await ensure_zumba_stages()
        rows = await v3_col("pipeline_stages").find(
            {"type": ZUMBA_TYPE}, {"_id": 0}
        ).sort("order", 1).to_list(500)
        by_stage = {}
        async for row in v3_col(ZUMBA_COLLECTION).aggregate([{"$group": {"_id": f"${ZUMBA_FIELD}", "n": {"$sum": 1}}}]):
            by_stage[row["_id"]] = row["n"]
        for r in rows:
            r["lead_count"] = by_stage.get(r["name"], 0)
        return rows

    counts = {}
    if type:
        field = STAGE_TYPE_FIELD[type]
        match = {}
        if type == SALES_TYPE and arm:
            # Counted against the branches on this arm only. Both pipelines start life as
            # copies of one another, so without this every stage on the online tab would
            # report the offline arm's leads as well as its own -- two tabs showing one
            # number and neither of them true.
            match = {"branch_id": {"$in": await _arm_branch_ids(arm)}}
        # Past Data's trial clients are left out of the count, as out of every org-wide one;
        # the delete below still counts them, so a stage they sit on cannot be deleted
        # out from under them.
        match = without_past_moves(match)
        leads_pipeline = [{"$match": match}] + [
            {"$group": {"_id": f"${field}", "n": {"$sum": 1}}}
        ]
        async for row in v3_col("leads").aggregate(leads_pipeline):
            counts[row["_id"]] = row["n"]
    for r in rows:
        r["lead_count"] = counts.get(r["name"], 0)
    return rows


@router.post("")
async def create_stage(payload: StageCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    await _ensure_seed()
    # Ordered within its own arm, not across both: the two Branch lists are independent, and
    # counting the offline arm's last stage would open every new online stage at an order no
    # pill on that board ever reaches.
    scope = {"type": payload.type}
    arm = None
    if payload.type == SALES_TYPE:
        arm = payload.arm if payload.arm in SALES_ARMS else SALES_ARM_OFFLINE
        scope["$or"] = [{"arm": arm}, {"arm": {"$exists": False}}, {"arm": None}]
    last = await v3_col("pipeline_stages").find(scope, {"_id": 0, "order": 1}).sort("order", -1).limit(1).to_list(1)
    next_order = (last[0]["order"] + 1) if last else 0
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "color": payload.color or "#64748b",
        "type": payload.type,
        "order": next_order,
        "is_final": bool(payload.is_final),
        "created_at": now_iso(),
    }
    for key in ("hover_color", "selected_color"):
        if getattr(payload, key):
            doc[key] = getattr(payload, key)
    if arm:
        doc["arm"] = arm
    await v3_col("pipeline_stages").insert_one(doc.copy())
    return doc


@router.patch("/{stage_id}")
async def update_stage(stage_id: str, payload: StageUpdate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    # If renaming, also rename references on existing leads. Recruitment is exempt:
    # candidates point at this stage by id, so there is nothing to rewrite.
    if "name" in updates:
        old = await v3_col("pipeline_stages").find_one(
            {"id": stage_id}, {"_id": 0, "name": 1, "type": 1, "arm": 1}
        )
        renaming = bool(old and old["name"] != updates["name"])
        if renaming and old["type"] == ZUMBA_TYPE:
            # Same rewrite the leads get, aimed at the collection registrations live in.
            await v3_col(ZUMBA_COLLECTION).update_many(
                {ZUMBA_FIELD: old["name"]}, {"$set": {ZUMBA_FIELD: updates["name"]}}
            )
        elif renaming and old["type"] != RECRUITMENT_TYPE:
            field = STAGE_TYPE_FIELD[old["type"]]
            carrying = {field: old["name"]}
            if old["type"] == SALES_TYPE and old.get("arm"):
                # This arm's leads only. The two Branch lists started as copies, so an
                # unscoped rewrite would drag every offline lead standing on the same stage
                # name along with the online rename -- onto a stage their own board has no
                # pill for, which is exactly the orphaning this rewrite exists to prevent.
                carrying["branch_id"] = {"$in": await _arm_branch_ids(old["arm"])}
            await v3_col("leads").update_many(carrying, {"$set": {field: updates["name"]}})
    res = await v3_col("pipeline_stages").update_one({"id": stage_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Stage not found")
    return await v3_col("pipeline_stages").find_one({"id": stage_id}, {"_id": 0})


@router.delete("/{stage_id}")
async def delete_stage(stage_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    stage = await v3_col("pipeline_stages").find_one({"id": stage_id}, {"_id": 0})
    if not stage:
        raise HTTPException(status_code=404, detail="Stage not found")
    # A stage carrying a role is one the branch boards act on -- it is where a booking
    # lands, or what frees the consultation slot. Renaming it is safe, which is what the
    # role is for; deleting it leaves the behaviour with nowhere to go, and the board finds
    # out at the moment somebody tries to book.
    if stage.get("role"):
        raise HTTPException(
            status_code=409,
            detail=f"'{stage['name']}' is what the branch boards use to {ROLE_DESCRIPTIONS.get(stage['role'], 'run part of the pipeline')}. "
                   "Rename it if you want it called something else — deleting it would stop that working.",
        )
    if stage["type"] == RECRUITMENT_TYPE:
        # Candidates would be orphaned exactly like leads are, just via a different key.
        in_use = await v3_col("candidates").count_documents({"stage_id": stage_id})
        if in_use > 0:
            raise HTTPException(status_code=409, detail=f"Stage in use by {in_use} candidate(s). Move them first.")
        if await v3_col("pipeline_stages").count_documents({"type": RECRUITMENT_TYPE}) <= 1:
            raise HTTPException(status_code=409, detail="A pipeline needs at least one stage")
        await v3_col("pipeline_stages").delete_one({"id": stage_id})
        return {"message": "Stage deleted"}
    if stage["type"] == ZUMBA_TYPE:
        in_use = await v3_col(ZUMBA_COLLECTION).count_documents({ZUMBA_FIELD: stage["name"]})
        if in_use > 0:
            raise HTTPException(status_code=409, detail=f"Stage in use by {in_use} registration(s). Move them first.")
        await v3_col("pipeline_stages").delete_one({"id": stage_id})
        return {"message": "Stage deleted"}
    field = STAGE_TYPE_FIELD[stage["type"]]
    used_by = {field: stage["name"]}
    if stage["type"] == SALES_TYPE and stage.get("arm"):
        # Only this arm's leads count against it. The two Branch lists began as copies of
        # one another, so an unscoped check would let the offline arm's leads block the
        # deletion of an identically named stage the online arm has finished with.
        used_by["branch_id"] = {"$in": await _arm_branch_ids(stage["arm"])}
    in_use = await v3_col("leads").count_documents(used_by)
    if in_use > 0:
        raise HTTPException(status_code=409, detail=f"Stage in use by {in_use} leads. Reassign first.")
    await v3_col("pipeline_stages").delete_one({"id": stage_id})
    return {"message": "Stage deleted"}


@router.post("/reorder")
async def reorder_stages(payload: StageReorder, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    for item in payload.items:
        if "id" not in item or "order" not in item:
            continue
        await v3_col("pipeline_stages").update_one({"id": item["id"]}, {"$set": {"order": int(item["order"])}})
    return {"message": "Reorder saved"}
