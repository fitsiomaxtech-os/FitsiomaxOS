from fastapi import APIRouter, HTTPException, Depends, Header
from typing import List, Optional, Dict
from pydantic import BaseModel
from urllib.parse import unquote
import os
import re
import time
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time, derive_branch_code, active_doctor_query, live_branch_query
from security import hash_password, is_hashed, verify_password
from deps import (
    v3_current_user, v3_require_roles, is_branch_admin_role, is_head_physio_role,
    is_physio_role, is_diet_role, is_rehab_role, consultants_serving_branch,
    collapse_duplicate_experts, names_the_online_arm, super_admin_consults_at,
    super_admin_branch_switches_enabled, SA_CONSULT_BRANCHES_SETTING_ID,
)
from stage_utils import get_first_stage_name, realign_branch_stage_leads
from shift_utils import attach_shifts
import lead_control
import lead_purge
import store_branch_overrides
from seed import create_default_lead_source, sync_lead_source_branch_name
from routers.v3_finance import REVENUE_ACTIONS, EXPENSE_DELETE_SETTING_ID, expense_delete_enabled, BEFORE_VERIFY_DELETE_SETTING_ID, before_verify_delete_enabled
from routers.v3_inventory import _add_to_stock
from routers.v3_zumba import MASTER_SLOT_FIELD
from schemas.v3 import (
    V3UserOut, V3VerticalCreate, V3VerticalOut,
    V3BranchCreate, V3BranchOut, V3BranchUpdate,
    V3TeamMemberCreate, V3TeamMemberOut,
    V3DoctorCreate, V3DoctorSlotsInput, V3DoctorOut,
    V3TreatmentTypeCreate, V3TreatmentTypeUpdate, V3TreatmentTypeOut,
    V3PhysioTypeCreate, V3PhysioTypeOut, V3PhysioTypeUpdate, V3DoctorServiceInput,
    V3DoctorMeetLinkInput,
)

router = APIRouter(prefix="/api/v3")


@router.get("/verticals", response_model=List[V3VerticalOut])
async def v3_get_verticals(_: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("verticals").find({}, {"_id": 0}).to_list(100)
    return [V3VerticalOut(**row) for row in rows]


@router.post("/verticals", response_model=V3VerticalOut)
async def v3_add_vertical(payload: V3VerticalCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "active": payload.active,
        "created_at": now_iso(),
    }
    await v3_col("verticals").insert_one(doc.copy())
    return V3VerticalOut(**doc)


@router.delete("/verticals/{vertical_id}")
async def v3_delete_vertical(vertical_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Remove a service type.

    Refused while a branch still carries it. A branch's `vertical` holds the type's *name*,
    not its id, so deleting one in use would leave those branches pointing at a type that
    no longer exists — the branch form would then fail to show their current selection and
    silently offer to change it. Naming the branches lets the caller go and reassign them.
    """
    row = await v3_col("verticals").find_one({"id": vertical_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Service type not found")
    in_use = await v3_col("branches").find(
        live_branch_query({"vertical": row.get("name")}), {"_id": 0, "branch_name": 1}
    ).to_list(20)
    if in_use:
        names = ", ".join(b.get("branch_name", "?") for b in in_use)
        raise HTTPException(
            status_code=409,
            detail=f"{len(in_use)} branch(es) still use this service type: {names}",
        )
    await v3_col("verticals").delete_one({"id": vertical_id})
    return {"message": "Service type deleted"}


# ---- Treatment types ----------------------------------------------------------------
# The catalogue of treatments the clinic offers, by name — Super Admin > Treatment.
# Deliberately just a name and nothing else: it is a list to pick from, and every price,
# session count and duration already lives on a package in FITSIO STORE. Adding those
# fields here would create a second place to maintain them and a question about which
# one is right.


@router.get("/treatment-types", response_model=List[V3TreatmentTypeOut])
async def v3_get_treatment_types(_: V3UserOut = Depends(v3_current_user)):
    # Any signed-in user reads it: this is a picklist, and the people who would pick from
    # it are the ones treating patients, not the one maintaining the list.
    rows = await v3_col("treatment_types").find({}, {"_id": 0}).sort("name", 1).to_list(500)
    return [V3TreatmentTypeOut(**row) for row in rows]


@router.post("/treatment-types", response_model=V3TreatmentTypeOut)
async def v3_add_treatment_type(payload: V3TreatmentTypeCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Treatment name is required")
    # Case-insensitive: "Dry Needling" and "dry needling" are the same treatment, and a
    # picklist holding both is a picklist nobody trusts.
    clash = await v3_col("treatment_types").find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0, "name": 1}
    )
    if clash:
        raise HTTPException(status_code=409, detail=f"'{clash['name']}' already exists")
    doc = {"id": str(uuid.uuid4()), "name": name, "created_at": now_iso()}
    await v3_col("treatment_types").insert_one(doc.copy())
    return V3TreatmentTypeOut(**doc)


@router.patch("/treatment-types/{treatment_type_id}", response_model=V3TreatmentTypeOut)
async def v3_update_treatment_type(
    treatment_type_id: str,
    payload: V3TreatmentTypeUpdate,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Rename a treatment.

    A correction, not a re-pointing: a treatment typed as "Fozen Shoulder" is the same
    entry as the one spelled right, and the catalogue is a vocabulary that has to be
    correctable in place. Deleting and re-adding would work only because nothing holds an
    id yet, and it loses created_at along the way.

    Nothing is written through, unlike a service rename. What consumes this list is the
    Treatment Summary checklist, whose ticks are composed into the free text saved on a
    lead — clinical notes, written on a day, by a person. Rewriting a treatment's name
    inside notes already recorded would change what a Head Physio is on record as having
    written, so past summaries keep the words they were written with and only the picklist
    moves on.
    """
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Treatment name is required")
    existing = await v3_col("treatment_types").find_one({"id": treatment_type_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Treatment not found")
    # The same case-insensitive rule the create has, minus this row: fixing a treatment's
    # capitalisation is not a clash with itself.
    clash = await v3_col("treatment_types").find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}, "id": {"$ne": treatment_type_id}},
        {"_id": 0, "name": 1},
    )
    if clash:
        raise HTTPException(status_code=409, detail=f"'{clash['name']}' already exists")
    await v3_col("treatment_types").update_one({"id": treatment_type_id}, {"$set": {"name": name}})
    return V3TreatmentTypeOut(**{**existing, "name": name})


@router.delete("/treatment-types/{treatment_type_id}")
async def v3_delete_treatment_type(treatment_type_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Remove a treatment from the catalogue.

    No in-use check, unlike service types: nothing in the OS references a treatment type
    yet, so there is nothing to strand. The moment something does — a package, a session,
    a lead — this needs the same guard v3_delete_vertical has, refusing while it is
    referenced and naming what still holds it.
    """
    res = await v3_col("treatment_types").delete_one({"id": treatment_type_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Treatment not found")
    return {"message": "Treatment deleted"}


# Type of Physios — which kinds of physiotherapy the clinic offers.
#
# The same shape as treatment types above, and deliberately so: a name and nothing else,
# because the price, the session count and the duration belong to a package in FITSIO
# STORE. Two lists rather than one because they answer different questions — a treatment
# is what is wrong with the patient, a physio type is the service being sold.


@router.get("/physio-types", response_model=List[V3PhysioTypeOut])
async def v3_get_physio_types(_: V3UserOut = Depends(v3_current_user)):
    # Any signed-in user reads it, like the treatment list: this is a picklist, and the
    # people who pick from it are the ones seeing patients, not the one maintaining it.
    rows = await v3_col("physio_types").find({}, {"_id": 0}).sort("name", 1).to_list(500)
    return [V3PhysioTypeOut(**row) for row in rows]


@router.post("/physio-types", response_model=V3PhysioTypeOut)
async def v3_add_physio_type(payload: V3PhysioTypeCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Service name is required")
    # Case-insensitive: "Sports Physio" and "sports physio" are one service, and a picklist
    # holding both is a picklist nobody trusts.
    clash = await v3_col("physio_types").find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0, "name": 1}
    )
    if clash:
        raise HTTPException(status_code=409, detail=f"'{clash['name']}' already exists")
    doc = {"id": str(uuid.uuid4()), "name": name, "created_at": now_iso()}
    await v3_col("physio_types").insert_one(doc.copy())
    return V3PhysioTypeOut(**doc)


@router.patch("/physio-types/{physio_type_id}", response_model=V3PhysioTypeOut)
async def v3_update_physio_type(
    physio_type_id: str,
    payload: V3PhysioTypeUpdate,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Rename a service.

    The name is written through to every expert offered under the old one, because a
    doctors record holds the service as text rather than as an id — leaving them behind
    would strand experts under a name the picklist no longer offers.
    """
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Service name is required")
    existing = await v3_col("physio_types").find_one({"id": physio_type_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Service not found")
    # Same case-insensitive rule the create has, minus this row: renaming a service to
    # the case it already has is not a clash with itself.
    clash = await v3_col("physio_types").find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}, "id": {"$ne": physio_type_id}},
        {"_id": 0, "name": 1},
    )
    if clash:
        raise HTTPException(status_code=409, detail=f"'{clash['name']}' already exists")
    await v3_col("physio_types").update_one({"id": physio_type_id}, {"$set": {"name": name}})
    if existing.get("name") != name:
        await v3_col("doctors").update_many(
            {"service_type": existing.get("name")}, {"$set": {"service_type": name}}
        )
    return V3PhysioTypeOut(**{**existing, "name": name})


@router.patch("/doctors/{doctor_id}/service")
async def v3_set_doctor_service(
    doctor_id: str,
    payload: V3DoctorServiceInput,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Say which service an expert is offered under, from the Service picklist.

    Set where the calendar is published rather than where the expert is hired: the
    question is asked when a branch is opening this person's days, and that is the
    screen the answer is read back on.

    Checked against the picklist so the calendar can never print a service Super Admin
    does not offer — the same reason the list exists rather than a free-text field.
    """
    name = (payload.service_type or "").strip()
    if name:
        known = await v3_col("physio_types").find_one(
            {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0, "name": 1}
        )
        if not known:
            raise HTTPException(status_code=404, detail=f"'{name}' is not a service in Services and Products")
        # Stored as the picklist spells it, not as the caller typed it.
        name = known["name"]
    res = await v3_col("doctors").update_one({"id": doctor_id}, {"$set": {"service_type": name}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Expert not found")
    return {"message": "Service updated", "service_type": name}


def _clean_meet_link(raw) -> str:
    """A meeting link the OS is willing to put in front of a patient, or "" for none.

    Two jobs, and the second is the reason this is not a strip().

    Typed without a scheme, it is given https. A room is copied out of Google Calendar as
    often as out of the address bar, and "meet.google.com/abc-defg-hij" pasted into an href
    with no scheme is read as a path on our own domain — a link that looks right in the
    input, is sent to the patient, and opens nothing.

    Anything that is not then http(s) is refused outright. This string is rendered as an
    href on the booking screen and pasted into a WhatsApp message that goes out over the
    clinic's name, so the set of schemes allowed here is the set of things somebody can get
    a patient to click: javascript: and data: are refused rather than escaped, because
    there is no version of either that is a room anybody is meeting in.
    """
    link = str(raw or "").strip()
    if not link:
        return ""
    # A Meet room is about forty characters. This is not a limit anybody types their way
    # into by accident — it is there so a field that ends up in a patient's message cannot
    # be used to store a page of text, and so the calendar never has to render one.
    if len(link) > 500:
        raise HTTPException(status_code=400, detail="That meeting link is too long")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", link):
        link = f"https://{link}"
    if not re.match(r"^https?://[^\s/]+", link):
        raise HTTPException(status_code=400, detail="A meeting link must be an http:// or https:// address")
    return link


@router.patch("/doctors/{doctor_id}/meet-link")
async def v3_set_doctor_meet_link(
    doctor_id: str,
    payload: V3DoctorMeetLinkInput,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Record the video room this expert takes appointments in.

    Set from the calendar that publishes their days, beside the shift and the service,
    because it is the same kind of fact as those two: something true of the expert that
    every appointment booked out of this screen then carries.

    Written to every record this person holds, not only the one the calendar happened to
    open. An expert covering several branches holds one doctors record per branch by
    design, and the room is theirs rather than the branch's — one link, reusable by every
    patient, since the day is already divided by the slots they published. Left per-record
    it would be typed once and then be missing from the other branch's copy, which is the
    copy the booking popup may well read.

    Matched on the login behind the records, or failing that the employee they were hired
    as. Neither is guaranteed: a profile-only expert has no login, and the records Fitsiomax
    Experts creates carry no employee either, so a record with neither is updated alone —
    it is the only one that can be identified as this person with any certainty, and
    matching on a name would hand one person's room to their namesake.

    Open to the branch admins, the two online ones included: is_branch_admin_role admits
    them, and the online arm is the one this was asked for.
    """
    link = _clean_meet_link(payload.meet_link)
    row = await v3_col("doctors").find_one(
        {"id": doctor_id}, {"_id": 0, "id": 1, "user_id": 1, "employee_id": 1, "full_name": 1}
    )
    if not row:
        raise HTTPException(status_code=404, detail="Expert not found")
    if row.get("user_id"):
        query: Dict[str, object] = {"user_id": row["user_id"]}
    elif row.get("employee_id"):
        query = {"employee_id": row["employee_id"]}
    else:
        query = {"id": doctor_id}
    res = await v3_col("doctors").update_many(query, {"$set": {"meet_link": link}})
    return {
        "message": "Meeting link saved" if link else "Meeting link cleared",
        "meet_link": link,
        # How many of this person's records now carry it, so the caller can say "on all
        # three branches" rather than leaving the reader to wonder which one they edited.
        "records_updated": res.modified_count,
    }


@router.delete("/physio-types/{physio_type_id}")
async def v3_delete_physio_type(physio_type_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Remove a service from the Service list.

    Guarded now that experts are offered under one: deleting a service still held by a
    calendar would leave those experts printing a service the picklist no longer offers,
    which is the state this list exists to prevent. Refused and named, the way
    v3_delete_vertical refuses.
    """
    existing = await v3_col("physio_types").find_one({"id": physio_type_id}, {"_id": 0, "name": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Service not found")
    in_use = await v3_col("doctors").count_documents({"service_type": existing["name"]})
    if in_use > 0:
        raise HTTPException(
            status_code=409,
            detail=f"'{existing['name']}' is offered by {in_use} expert(s). Change theirs first.",
        )
    await v3_col("physio_types").delete_one({"id": physio_type_id})
    return {"message": "Service deleted"}

@router.get("/branches", response_model=List[V3BranchOut])
async def v3_get_branches(_: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("branches").find(live_branch_query(), {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [V3BranchOut(**row) for row in rows]


@router.get("/team-members", response_model=List[V3TeamMemberOut])
async def v3_get_team_members(team_type: Optional[str] = None, _: V3UserOut = Depends(v3_current_user)):
    query: Dict[str, str] = {}
    if team_type:
        query["team_type"] = team_type
    rows = await v3_col("team_members").find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [V3TeamMemberOut(**row) for row in rows]


@router.post("/team-members", response_model=V3TeamMemberOut)
async def v3_add_team_member(payload: V3TeamMemberCreate, _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    email = payload.email.lower().strip()
    exists = await v3_col("team_members").find_one({"email": email, "team_type": payload.team_type}, {"_id": 0})
    if exists:
        raise HTTPException(status_code=409, detail="Team member already exists")

    member = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name.strip(),
        "email": email,
        "team_type": payload.team_type,
        "created_at": now_iso(),
    }
    await v3_col("team_members").insert_one(member.copy())
    return V3TeamMemberOut(**member)


@router.post("/branches", response_model=V3BranchOut)
async def v3_create_branch(payload: V3BranchCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    branch_id = str(uuid.uuid4())
    admin_user_id = str(uuid.uuid4())
    await v3_col("users").insert_one(
        {
            "id": admin_user_id,
            "full_name": payload.admin_name,
            "email": payload.admin_email.lower(),
            "password": hash_password(payload.admin_password),
            "role": "branch_admin",
            "branch_id": branch_id,
            "is_active": True,
            "created_at": now_iso(),
        }
    )
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
        "admin_name": payload.admin_name,
        "admin_email": payload.admin_email.lower(),
        "admin_phone": payload.admin_phone,
        "vertical": payload.vertical,
        "lead_control": lead_control.normalize(payload.lead_control),
        "created_at": now_iso(),
    }
    await v3_col("branches").insert_one(branch.copy())

    await v3_col("users").update_many(
        {
            "email": {"$in": ["headphysio@fitsiomax.com", "physio@fitsiomax.com"]},
            "branch_id": None,
        },
        {"$set": {"branch_id": branch_id}},
    )

    # Every branch gets its own Lead Source card the moment it exists — see
    # seed.ensure_branch_lead_sources for why Marketing > Lead Sources no longer has its
    # own Add Source button.
    await create_default_lead_source(branch_id, payload.branch_name)

    return V3BranchOut(**branch)


@router.put("/branches/{branch_id}", response_model=V3BranchOut)
async def v3_update_branch(branch_id: str, payload: V3BranchUpdate, user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    existing = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Branch not found")
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "code" in updates:
        new_code = updates["code"].strip().upper()
        if not new_code:
            raise HTTPException(status_code=400, detail="Branch code cannot be empty")
        clash = await v3_col("branches").find_one({"code": new_code, "id": {"$ne": branch_id}}, {"_id": 0, "id": 1})
        if clash:
            raise HTTPException(status_code=409, detail=f"Branch code '{new_code}' is already used by another branch")
        updates["code"] = new_code
    if "lead_control" in updates:
        # Rejected rather than defaulted: a typo here silently hands every lead at the
        # branch to the wrong desk, and the caller would never see it.
        if updates["lead_control"] not in lead_control.VALID:
            raise HTTPException(status_code=400, detail=f"lead_control must be one of {list(lead_control.VALID)}")
    # Names a person, not a branch field — pulled out before the branch is written so it
    # does not end up stored on the document.
    assignee_id = updates.pop("lead_control_assignee_id", None)
    assignee = None
    if assignee_id and updates.get("lead_control") == lead_control.PRE_SALES:
        assignee = await v3_col("users").find_one(
            {"id": assignee_id, "role": "pre_sales", "branch_id": branch_id},
            {"_id": 0, "id": 1, "full_name": 1},
        )
        # Checked rather than trusted: this hands a branch's entire book to whoever is
        # named, so a stale or wrong id must fail loudly instead of assigning the leads
        # to nobody and looking like it worked.
        if not assignee:
            raise HTTPException(status_code=400, detail="That Pre-Sales member is not attached to this branch")
    await v3_col("branches").update_one({"id": branch_id}, {"$set": updates})
    # The branch's own Lead Source card is named after it, not editable on its own (see
    # update_source in v3_marketing) — so a rename here is the only way that name ever
    # changes, and it has to happen in the same request as the rename itself.
    if "branch_name" in updates:
        await sync_lead_source_branch_name(branch_id, updates["branch_name"])
    # The two modes open on different stages — Branch Assign + RNR for a branch running its
    # own leads, New Appointment for one fed by Pre-Sales. Leads already sitting on the old
    # mode's stages are rehomed now, in the same request as the flip, so the board the admin
    # lands on after switching is the full backlog rather than a board missing most of it.
    if "lead_control" in updates and updates["lead_control"] != lead_control.normalize(existing.get("lead_control")):
        await realign_branch_stage_leads(branch_id, updates["lead_control"])
        # A branch that ran its own leads had no Pre-Sales rep on any of them, so handing
        # the book back left every lead sitting in the Pre-Sales pipeline unowned. The rep
        # named on the switch takes them, which is the whole point of being asked.
        if assignee:
            await v3_col("leads").update_many(
                {"branch_id": branch_id},
                {"$set": {
                    "assigned_user_id": assignee["id"],
                    "assigned_user_name": assignee.get("full_name", ""),
                    "assigned_user_role": "pre_sales",
                    "updated_at": now_iso(),
                }},
            )
        # Every flip is recorded. The switch moves a whole branch's leads between two desks,
        # and the branch itself only ever carries the answer as it stands now — so without
        # this there is nothing to say when the handover happened or who called it.
        await v3_col("branch_lead_control_history").insert_one({
            "id": str(uuid.uuid4()),
            "branch_id": branch_id,
            "from_control": lead_control.normalize(existing.get("lead_control")),
            "to_control": updates["lead_control"],
            "changed_by": user.full_name,
            "changed_by_role": user.role,
            "assigned_to_id": assignee["id"] if assignee else None,
            "assigned_to_name": assignee.get("full_name", "") if assignee else None,
            "changed_at": now_iso(),
        })
    updated = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    return V3BranchOut(**updated)


@router.get("/branches/{branch_id}/pre-sales-members")
async def v3_branch_pre_sales_members(
    branch_id: str,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """The Pre-Sales reps attached to this branch, for the hand-back dropdown.

    Scoped to the branch rather than the whole Pre-Sales desk: returning a branch's book
    to Pre-Sales means handing it to someone who covers that branch. A branch with nobody
    attached comes back empty, and the dialog says so rather than offering a dead control —
    the fix for that is attaching a Pre-Sales user to the branch in HR Admin.
    """
    rows = await v3_col("users").find(
        {"role": "pre_sales", "branch_id": branch_id, "is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "full_name": 1, "email": 1},
    ).sort("full_name", 1).to_list(200)
    return rows


@router.get("/branches/{branch_id}/lead-control-history")
async def v3_lead_control_history(
    branch_id: str,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Every Lead Control switch this branch has been through, newest first.

    Empty for a branch that has never been switched, including every branch that existed
    before this was recorded — an empty table means "no flip seen", not "no flips ever".
    """
    return await v3_col("branch_lead_control_history").find(
        {"branch_id": branch_id}, {"_id": 0}
    ).sort("changed_at", -1).to_list(200)


@router.delete("/branches/{branch_id}")
async def v3_delete_branch(branch_id: str, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    existing = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Branch not found")
    await v3_col("branches").delete_one({"id": branch_id})
    if existing.get("admin_user_id"):
        await v3_col("users").delete_one({"id": existing["admin_user_id"]})
    # Don't leave leads/sources pointing at a branch that no longer exists — unassign them
    # back to "no branch" so they fall back to the normal Pre-Sales flow instead of silently
    # keeping a dead branch_id forever.
    await v3_col("leads").update_many(
        {"branch_id": branch_id},
        {"$set": {"branch_id": None, "branch_stage": None}},
    )
    await v3_col("marketing_sources").update_many(
        {"branch_id": branch_id},
        {"$set": {"branch_id": None}},
    )
    return {"message": "Branch deleted"}


# The desks whose records may legitimately carry no branch.
#
# For a Nutritionist that still means offered at every one: branchless is how this OS spells
# "All Branches" for them, and _coach_branch_ids in routers/v3_diet.py reads it that way.
#
# For a CONSULTANT it no longer means that. Their record is still branchless — one person
# has one set of hours, so the calendar is single and does not split per branch — but WHERE
# they are offered is now read off the branches on their login, by consultants_serving_branch
# in deps.py. They stay in this list because the record must survive the branch clause of the
# query to reach that filter at all; the filter is what narrows them.
#
# Every other desk is somewhere — a Physio treats at their own branch, and rehab is
# delivered where the patient comes — so a missing branch on one of those is a gap to fix
# rather than a reach to honour.
ORG_WIDE_PROFILES = ["head_physio", "nutrition_coach"]


def _names_the_online_arm(text) -> bool:
    """Whether a role slug or a job title says "online" — both are read the same way.

    A designation and a role are one thing to this clinic, so ONLINE CONSULTANT the title
    and online_consultant the slug are the same answer written twice, and splitting them
    into two rules is how they would come apart again.

    The reading itself lives in deps.names_the_online_arm now, because the Branch Lead
    pipelines ask the same question of a branch and two copies of this rule would be two
    ways to answer it.
    """
    return names_the_online_arm(text)


async def _consultants_for_vertical(rows: list, online: bool) -> list:
    """Keep the consultants who belong to an online branch, or the ones who do not.

    A consultation over video and one in the room are the same desk, so every consultant
    role is stamped profile_type "head_physio" and the expert records are indistinguishable.
    Which arm a consultant works is on the login behind the record, and on the job title HR
    gave them — and either saying "online" is enough.

    Both, because either alone is wrong on this install. The role is: three people are
    ONLINE CONSULTANT in the structure and were hired before an online consultant role
    existed to give them, so their logins still read head_physio and reading only that
    leaves the online branch with nobody. The title is: it is HR's word for the job, not a
    statement about permissions, and somebody deliberately given the online role must not
    be pulled back offline because their title was typed without it. Neither can veto the
    other, so a consultant counts as online when either says so, and that is a rule with no
    contradiction to resolve rather than a precedence order to remember.

    A consultant with neither — no login at all, as the profile-only records Fitsiomax
    Experts creates have, or a title with no online in it — counts as in the room. That is
    where every consultant sat before the online arm existed, so reading silence as "in the
    room" leaves those calendars exactly as they were rather than emptying them.

    Symmetric on purpose: an online consultant stops being offered by offline branches.

    Only consultants are touched. Every other desk belongs to a branch already and is
    filtered by it above.
    """
    consultants = [r for r in rows if r.get("profile_type") == "head_physio"]
    if not consultants:
        return list(rows)

    user_ids = [r["user_id"] for r in consultants if r.get("user_id")]
    role_by_user, emp_by_user = {}, {}
    if user_ids:
        async for u in v3_col("users").find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "role": 1, "employee_id": 1}
        ):
            role_by_user[u["id"]] = u.get("role")
            if u.get("employee_id"):
                emp_by_user[u["id"]] = u["employee_id"]

    # An expert reaches their employee record two ways — the login links one, and a record
    # created through Fitsiomax Experts carries the id itself — and neither is guaranteed,
    # since Create User's link to an employee is optional. Both are read, so a title is
    # found wherever it is written down.
    emp_ids = set(emp_by_user.values()) | {r["employee_id"] for r in consultants if r.get("employee_id")}
    designation_by_emp, title_by_name = {}, {}
    if emp_ids:
        async for e in v3_col("employees").find(
            {"id": {"$in": list(emp_ids)}}, {"_id": 0, "id": 1, "designation": 1}
        ):
            designation_by_emp[e["id"]] = e.get("designation")

    # Last resort, by name, for a consultant whose login was created without ticking the
    # employee link — the common case, since that field is optional and the two screens are
    # filled in months apart. The same fallback consolidate_head_physio_doctors already uses
    # to pair records that lost their user_id.
    #
    # Only where the name resolves to exactly one employee. A name shared by two people says
    # nothing about which desk this record is, so an ambiguous match is dropped rather than
    # guessed — and the consultant stays where they have always been, in the room.
    unlinked = [
        r for r in consultants
        if not r.get("employee_id") and not emp_by_user.get(r.get("user_id")) and r.get("full_name")
    ]
    if unlinked:
        wanted = {str(r["full_name"]).strip().lower() for r in unlinked}
        seen = {}
        async for e in v3_col("employees").find({}, {"_id": 0, "full_name": 1, "designation": 1}):
            key = str(e.get("full_name") or "").strip().lower()
            if key in wanted:
                seen[key] = None if key in seen else e.get("designation")
        title_by_name = {k: v for k, v in seen.items() if v}

    def title_for(r) -> str:
        emp_id = r.get("employee_id") or emp_by_user.get(r.get("user_id"))
        if emp_id:
            return designation_by_emp.get(emp_id) or ""
        return title_by_name.get(str(r.get("full_name") or "").strip().lower()) or ""

    kept = []
    for r in rows:
        if r.get("profile_type") != "head_physio":
            kept.append(r)
            continue
        is_online = _names_the_online_arm(role_by_user.get(r.get("user_id"))) or _names_the_online_arm(title_for(r))
        if is_online == online:
            kept.append(r)
    return kept


# Which Team desk fills each calendar. The predicates are the ones _desk_holds uses in
# routers/v3_branch_mgmt.py — imported from deps rather than restated, so a calendar and
# the Team tab that staffs it cannot come to disagree about whether a `diet_manage` is a
# Nutritionist or an Online Physio Admin is a Branch Admin.
#
# Rehab has no desk on the Team tab, and is here anyway: the rule is the same one, the
# predicate already exists, and leaving it out would make the Rehab Calendar the one that
# still answers a different question from the other three.
DESK_FOR_PROFILE = {
    "head_physio": is_head_physio_role,
    "physio": is_physio_role,
    # super_admin excluded on both, exactly as _desk_holds excludes it: these two predicates
    # answer "may this account reach that board", which Super Admin may, and standing them
    # on every branch's Diet and Rehab calendar is not what that means.
    "nutrition_coach": lambda r: r != "super_admin" and is_diet_role(r),
    "rehab": lambda r: r != "super_admin" and is_rehab_role(r),
}


async def team_roster_experts(branch_id: str, profile_type: str) -> list:
    """The expert records for everyone MANAGEMENT → MANAGER → TEAM lists at this desk.

    Team and the calendars had two different answers to one question. Team reads `users`:
    the logins posted to this branch, filtered by the role predicate for the desk. The
    calendars read `doctors`: the expert records, which are a separate collection written
    at hiring, at a Team posting, and by half a dozen other paths. A person on one and not
    the other is invisible to whichever list they are missing from — which is how an online
    branch came to show three Consultants on Team and an empty Consultant Calendar.

    So the roster is read Team's way, and the expert record is looked up per person rather
    than being the thing listed. Where somebody on the roster has no record, one is made
    here: the record is not the fact of employment, it is the sheet their published hours
    are written on, and there is no reason for a person Team already says works this desk
    to be missing one. Making it on read is what lets a calendar that was empty this
    morning simply work, without anybody being told to go and re-post staff who are
    already posted.

    A Consultant's record stays branchless and is found without one, because they hold a
    SINGLE calendar however many branches they take consultations at — two records would
    mean two independent clash checks and the same person booked into one hour twice. Every
    other desk holds a separate calendar per branch and is matched with the branch on it.

    Inactive logins are dropped, which is the one place this deliberately parts company
    with the Team tab. Team keeps them on purpose — it is the screen that switches somebody
    off, and a row that vanished on deactivation would be a one-way door. A calendar is for
    publishing hours somebody can be booked into, and a switched-off account is not
    somebody anyone should be booked with.
    """
    holds = DESK_FOR_PROFILE.get(profile_type)
    if not holds or not branch_id:
        return []
    # Both fields, the same query the Team tab runs: a desk that works several branches
    # carries the list and holds branch_id as no more than the first of them.
    rows = await v3_col("users").find(
        {"$or": [{"branch_id": branch_id}, {"branch_ids": branch_id}], "is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "full_name": 1, "role": 1, "employee_id": 1},
    ).to_list(500)
    members = [u for u in rows if holds((u.get("role") or "").strip().lower())]
    # The Super Admin on every branch's Consultant Calendar, unless they have switched this
    # branch off on My Consultation. They are posted nowhere — they run every branch — so
    # the Team query above never finds them, and without this a Branch Admin had no row to
    # open the days they agreed on the phone.
    if profile_type == "head_physio":
        seen_ids = {u["id"] for u in members}
        switches_on = await super_admin_branch_switches_enabled()
        async for u in v3_col("users").find(
            {"role": "super_admin", "is_active": {"$ne": False}},
            {"_id": 0, "id": 1, "full_name": 1, "role": 1, "employee_id": 1, "consult_off_branch_ids": 1},
        ):
            if u["id"] not in seen_ids and super_admin_consults_at(u, branch_id, switches_on):
                members.append(u)

    out = []
    for u in members:
        is_sa = (u.get("role") or "").strip().lower() == "super_admin"
        # head_physio is the one branchless record — see the docstring, and
        # holds_calendar_per_branch in routers/v3_hr.py, which draws the same line from the
        # role's side.
        query: Dict[str, object] = {"user_id": u["id"], "profile_type": profile_type}
        if profile_type != "head_physio":
            query["branch_id"] = branch_id
        # Every record, then the fullest — not find_one. One person can hold several: the
        # multi-branch model leaves them behind, and half a dozen paths can each add one.
        # This install has seen a Nutritionist with twenty-one identical rows. Picking
        # whichever Mongo returned first would open an empty calendar for somebody whose
        # published hours are sitting on the other record, and publishing into the empty one
        # would then split their day across two sheets that clash-check separately.
        found = await v3_col("doctors").find(query, {"_id": 0}).to_list(50)
        # Stood-down records dropped before the fullest is chosen, not after. Choosing first
        # and checking second would lose somebody whose richest record happens to be the
        # retired one while a live record of theirs sits right behind it.
        if not found and not is_sa:
            # Nothing under their login — but that is not the same as nothing at all. A
            # record can exist for this person carrying no user_id: the profile-only entries
            # Fitsiomax Experts creates have none, and several older paths wrote one without
            # linking the account. Creating a second beside it is the worst outcome
            # available, and it is the one this did until now: the appointments already
            # booked stay on the unlinked record while every "my own" screen resolves the
            # new empty one, so a consultant with patients opens a board with none.
            #
            # So it is adopted instead — the link written on, the record kept whole with its
            # slots and its bookings.
            #
            # Only on an unambiguous match, the same bar _consultant_login_without_a_link
            # in routers/v3_hr.py sets for the same kind of repair. The employee they were
            # hired as is proof; a name is not, so a name is accepted only when exactly one
            # unlinked record answers to it. A shared name is left alone rather than
            # guessed at, because the wrong guess hands one person's diary to their
            # namesake.
            orphan_query: Dict[str, object] = {"profile_type": profile_type, "user_id": {"$in": [None, ""]}}
            if profile_type != "head_physio":
                orphan_query["branch_id"] = branch_id
            orphans = await v3_col("doctors").find(orphan_query, {"_id": 0}).to_list(200)
            name = str(u.get("full_name") or "").strip().lower()
            mine = [d for d in orphans if u.get("employee_id") and d.get("employee_id") == u["employee_id"]]
            if not mine and name:
                mine = [d for d in orphans if str(d.get("full_name") or "").strip().lower() == name]
            if len(mine) == 1:
                found = mine
                await v3_col("doctors").update_one(
                    {"id": mine[0]["id"]},
                    {"$set": {"user_id": u["id"], **({"employee_id": u["employee_id"]} if u.get("employee_id") else {})}},
                )
                found[0]["user_id"] = u["id"]

        live = [d for d in found if d.get("is_active") is not False and d.get("branch_active") is not False]
        live.sort(key=lambda d: len(d.get("slots") or []), reverse=True)
        if not live and found:
            # Every record they have is stood down. Listed nowhere, and deliberately not
            # replaced: minting a fresh one for somebody who already has records is how a
            # person ends up with two calendars and a clash check that reads only one.
            continue
        row = live[0] if live else None
        if row is None:
            row = {
                "id": str(uuid.uuid4()),
                "full_name": u.get("full_name") or "",
                "profile_type": profile_type,
                "branch_id": None if profile_type == "head_physio" else branch_id,
                "specialization": "",
                "slots": [],
                "slot_details": [],
                "user_id": u["id"],
                "created_at": now_iso(),
            }
            if is_sa:
                row["is_super_admin"] = True
            await v3_col("doctors").insert_one(row.copy())
        elif is_sa and not row.get("is_super_admin"):
            # The same one-time stamp ensure_super_admin_consultant makes, so the tag is
            # there whichever of the two screens reached the record first.
            await v3_col("doctors").update_one({"id": row["id"]}, {"$set": {"is_super_admin": True}})
            row["is_super_admin"] = True
        out.append(row)
    return out


@router.get("/branches/{branch_id}/calendar-experts", response_model=List[V3DoctorOut])
async def v3_calendar_experts(
    branch_id: str,
    profile_type: str = "head_physio",
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Who a branch's calendar publishes days for — the Team roster for that desk.

    A separate endpoint rather than a change to /doctors, which has seven callers with
    seven different questions: the Operations picker, the Master Control list, Pre-Sales,
    the booking pickers. This one answers only "who does MANAGEMENT → MANAGER → TEAM say
    works this desk here", which is the question the four calendars are asking and the one
    they were getting a different answer to.

    A Branch Admin is held to their own branch, the same rule branch_detail applies to the
    Team tab this reads from. Only where they have one: an account posted nowhere is not
    narrowed to nowhere.
    """
    if is_branch_admin_role(user.role) and user.branch_id and user.branch_id != branch_id:
        raise HTTPException(status_code=403, detail="You can only open your own branch's calendar")
    rows = await team_roster_experts(branch_id, profile_type)
    # The rostered window each of them works, resolved from the shift rather than stored —
    # the same attach_shifts every other expert list goes through, so a calendar opened
    # from here cuts its day exactly as one opened from /doctors did.
    rows = await attach_shifts(rows)
    out = []
    for row in rows:
        try:
            out.append(V3DoctorOut(**row))
        except Exception:
            # One malformed legacy row shouldn't empty a whole calendar — the same guard,
            # and the same reasoning, as v3_get_doctors below.
            continue
    return out


@router.get("/doctors", response_model=List[V3DoctorOut])
async def v3_get_doctors(
    branch_id: Optional[str] = None,
    # "online" | "offline". Narrows the consultants to the ones who take that kind of
    # appointment; anything else is ignored, so an unset or misspelt value leaves the list
    # as it has always been rather than emptying a calendar.
    vertical: Optional[str] = None,
    # A House Visit patient can be treated by a physio from any branch, so the branch's
    # Assign Physio asks for another branch's physios by name. Honoured for the branch
    # admins only; every other desk stays held to its own branch.
    cross_branch: bool = False,
    user: V3UserOut = Depends(v3_current_user),
):
    query: Dict[str, object] = {}
    scope_branch = None
    # Off the predicates, not the literals. Two things were wrong with the list: the
    # consultation desk moved off `head_physio` onto `consultant`, and `online_physio` was
    # never in it — so both were left unscoped and shown every branch's experts.
    if cross_branch and branch_id and (is_branch_admin_role(user.role) or user.role in ("super_admin", "business_dev")):
        scope_branch = branch_id
    elif (is_branch_admin_role(user.role) or is_head_physio_role(user.role) or is_physio_role(user.role)) and user.branch_id:
        scope_branch = user.branch_id
    elif branch_id:
        scope_branch = branch_id
    if scope_branch:
        # An expert with no branch on their record belongs to all of them — but only where
        # that desk can genuinely hold none. A CONSULTANT is org-wide by definition, and a
        # Nutritionist here covers every branch; both are recorded branchless and must not
        # be filtered out, or those calendars come back empty at every branch.
        #
        # A Physio is not: they treat at the branch they belong to. A physio record with no
        # branch on it is a gap in the data, not a licence to appear on every calendar, and
        # reading it as one would put every physio in the organisation on every branch's
        # list. Rehab is the same, being delivered where the patient comes.
        query["$or"] = [
            {"branch_id": scope_branch},
            {"profile_type": {"$in": ORG_WIDE_PROFILES}, "branch_id": {"$in": [None, ""]}},
            # Every consultant record reaches the rows below whatever branch it carries,
            # and consultants_serving_branch then decides which of them belong to this branch.
            # Two steps rather than one clause because the answer is not on the record: it
            # is the branch list on the login behind it, which Mongo cannot join to here.
            {"profile_type": "head_physio"},
        ]
    rows = await v3_col("doctors").find(active_doctor_query(query), {"_id": 0}).sort("created_at", -1).to_list(1000)
    # Which consultants belong to this branch. After the query, because the answer lives on
    # the login rather than on the expert record — see _consultants_serving.
    if scope_branch:
        rows = await consultants_serving_branch(rows, scope_branch)
    # Their rostered working window, so a list that offers an expert also says which hours
    # that expert actually works. Resolved here rather than by each caller because every
    # calendar and picker reads this one endpoint.
    # Asked for outright, or read off the branch being listed for. Deriving it means a
    # caller that already names a branch does not have to know its vertical as well, and
    # the rule about which consultants belong to an online branch lives in one place
    # instead of at every calendar that asks.
    want = vertical if vertical in ("online", "offline") else None
    if want is None and scope_branch:
        b = await v3_col("branches").find_one({"id": scope_branch}, {"_id": 0, "vertical": 1})
        if b:
            # A branch recorded with no vertical says nothing either way, so the asker's own
            # role answers instead: an Online Physio Admin is asking about the online arm
            # whatever their branch record happens to be missing.
            want = "online" if _names_the_online_arm(b.get("vertical") or user.role) else "offline"
    if want:
        rows = await _consultants_for_vertical(rows, want == "online")
    # One line per person, not one per record. Every caller of this endpoint is a picker —
    # Assign Physio, the Operations and Pre-Sales pickers, the booking popup's experts —
    # and each of them was listing the same physio once per duplicate `doctors` row, three
    # identical names with nothing to choose between them. The calendars already got a
    # deduped answer through team_roster_experts; this is the same answer for the pickers.
    rows = await collapse_duplicate_experts(rows)
    rows = await attach_shifts(rows)
    out = []
    for row in rows:
        try:
            out.append(V3DoctorOut(**row))
        except Exception:
            # One malformed legacy row (e.g. missing a field a later schema change added)
            # shouldn't 500 the whole Experts list — skip it and keep going.
            continue
    return out


@router.post("/doctors", response_model=V3DoctorOut)
async def v3_add_doctor(payload: V3DoctorCreate, user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio"))):
    branch_id = payload.branch_id or user.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="Branch is required")
    doctor = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name,
        "profile_type": payload.profile_type,
        "branch_id": branch_id,
        "specialization": payload.specialization,
        "employee_id": payload.employee_id,
        "joining_date": payload.joining_date,
        "slots": [],
        "created_at": now_iso(),
    }
    await v3_col("doctors").insert_one(doctor.copy())
    return V3DoctorOut(**doctor)


@router.delete("/doctors/{doctor_id}")
async def v3_delete_doctor(doctor_id: str, user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin"))):
    """Remove an expert profile created via HR > Fitsiomax Experts (or Branch
    Admin's own Fitsiomax Experts tab). Only for profile-only entries with no
    linked login and no appointment/session history — those are real accounts
    or real patient history, not stray test/duplicate rows. Branch Admin can
    only delete an expert from their own branch."""
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Expert not found")
    if is_branch_admin_role(user.role) and doctor.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Expert not found")
    # Refused only while that login still exists. It used to be refused on the presence of
    # the field alone, which trapped anyone whose login had already been deleted: the record
    # was left pointing at nothing, the advice was to remove a login that was already gone,
    # and there was no way to clear it. A user_id that resolves to nobody is a dead
    # reference, not a live account to protect.
    if doctor.get("user_id"):
        owner = await v3_col("users").find_one({"id": doctor["user_id"]}, {"_id": 0, "id": 1})
        if owner:
            raise HTTPException(status_code=400, detail="This expert is linked to a login account — remove the login in Credentials instead")
    if await v3_col("appointments").find_one({"doctor_id": doctor_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=400, detail="This expert has appointment history and can't be deleted")
    if await v3_col("sessions").find_one({"physio_id": doctor_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=400, detail="This expert has session history and can't be deleted")
    await v3_col("doctors").delete_one({"id": doctor_id})
    return {"message": "Expert deleted"}


@router.post("/doctors/{doctor_id}/slots", response_model=V3DoctorOut)
async def v3_add_slots(doctor_id: str, payload: V3DoctorSlotsInput, _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio"))):
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    normalized_slots = [normalize_slot_time(slot) for slot in payload.slots]
    all_slots = sorted(set(doctor.get("slots", [])).union(set(normalized_slots)))
    await v3_col("doctors").update_one({"id": doctor_id}, {"$set": {"slots": all_slots}})
    updated = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    return V3DoctorOut(**updated)


@router.get("/doctors/available")
async def v3_available_doctors(branch_id: str, slot_time: str, _: V3UserOut = Depends(v3_current_user)):
    slot_key = normalize_slot_time(slot_time)
    doctors = await v3_col("doctors").find(active_doctor_query({"branch_id": branch_id}), {"_id": 0}).to_list(1000)
    booked = await v3_col("appointments").find({"branch_id": branch_id, "slot_time": slot_key, "status": "new_appointment"}, {"_id": 0, "doctor_id": 1}).to_list(200)
    booked_ids = {item["doctor_id"] for item in booked}
    available = [d for d in doctors if slot_key in d.get("slots", []) and d["id"] not in booked_ids]
    return {"available_doctors": available}


# ---------- Danger Zone: developer password ----------
#
# The three resets are for developers, not for whoever holds Super Admin. So the screen
# hides them behind a password, and every reset endpoint demands the same password itself --
# the screen's lock is manners, and anyone holding a Super Admin token can call the URL.
#
# Only a bcrypt hash is kept, in the server's own backend/.env (gitignored, so it never
# reaches the repo), and never in the frontend: this OS serves its frontend source publicly,
# so anything the page knows, anyone can read. Unset means locked for everybody, not open.
DANGER_ZONE_PASSWORD_ENV = "DANGER_ZONE_PASSWORD_HASH"
DANGER_ZONE_MAX_FAILURES = 5
DANGER_ZONE_LOCKOUT_SECONDS = 15 * 60
# Wrong attempts per Super Admin, in this process. Best-effort -- a restart forgets them --
# but it turns guessing from as-fast-as-bcrypt-allows into five tries a quarter hour.
_danger_zone_failures: Dict[str, List[float]] = {}


async def require_developer_password(
    x_developer_password: Optional[str] = Header(None),
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
) -> V3UserOut:
    """Super Admin (or the Business Development Executive, whose board mounts the same
    CI/CD ROOTS screen) AND the developer password, sent as X-Developer-Password.

    The role is the lesser half of this gate and always was -- see the note above: the
    screen's lock is manners, and the password is the control. Widening the role to the
    second desk that reaches this screen keeps the resets behind the same bcrypt hash in
    the server's own .env, which is the thing that actually decides who may call them.

    URI-encoded by the page and decoded here, because a header can only carry Latin-1 and a
    password is allowed to be anything.
    """
    stored = (os.environ.get(DANGER_ZONE_PASSWORD_ENV) or "").strip()
    # A bcrypt hash or nothing. verify_password would compare a non-hash as plain text, and a
    # plain password sitting in .env is exactly what this is meant not to need.
    if not is_hashed(stored):
        raise HTTPException(status_code=503, detail="The developer password has not been set on this server")

    now = time.monotonic()
    recent = [t for t in _danger_zone_failures.get(user.id, []) if now - t < DANGER_ZONE_LOCKOUT_SECONDS]
    if len(recent) >= DANGER_ZONE_MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many wrong attempts — try again in 15 minutes")

    typed = unquote(x_developer_password or "")
    if not typed or not verify_password(typed, stored):
        recent.append(now)
        _danger_zone_failures[user.id] = recent
        raise HTTPException(status_code=403, detail="Wrong developer password")
    _danger_zone_failures.pop(user.id, None)
    return user


@router.post("/admin/danger-zone/unlock")
async def v3_unlock_danger_zone(_: V3UserOut = Depends(require_developer_password)):
    """Checks the developer password so the screen can reveal the resets. Unlocks nothing on
    the server: each reset checks the password again on its own."""
    return {"unlocked": True}


# The Treatment Days popup offers Complete and Absent only on the date a day was booked for.
# In production that strands a day whose date went by unrecorded, so a developer can switch
# the date lock off here. The order lock (Day 2 after Day 1) is the server's and stays on.
PHYSIO_DAY_LOCK_ID = "physio_day_lock"


class PhysioDayLockInput(BaseModel):
    locked: bool


async def physio_day_lock_enabled() -> bool:
    """On unless a developer has switched it off -- a missing row is the old behaviour."""
    row = await v3_col("app_settings").find_one({"id": PHYSIO_DAY_LOCK_ID}, {"_id": 0})
    return True if not row else bool(row.get("locked", True))


@router.get("/admin/physio-day-lock")
async def v3_get_physio_day_lock(_: V3UserOut = Depends(require_developer_password)):
    return {"locked": await physio_day_lock_enabled()}


@router.put("/admin/physio-day-lock")
async def v3_set_physio_day_lock(
    payload: PhysioDayLockInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": PHYSIO_DAY_LOCK_ID},
        {"$set": {
            "id": PHYSIO_DAY_LOCK_ID,
            "locked": payload.locked,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"locked": payload.locked}


# Whether Branch Leads offers a delete at all. The delete it governs is total — the
# patient, their treatment slots, their collected payments and every other trail they
# left (see lead_purge) — which is what makes it the right tool for a mistake and the
# wrong thing to leave lying on a busy branch's screen by default in every install.
#
# A developer setting rather than a role, for the reason the Danger Zone exists: the
# question is whether this install wants the button, not whether a Branch Admin is
# senior enough to be trusted with it. Switching it off hides the bin icon and the
# select-many Delete bar, and the endpoint behind them refuses as well.


class LeadDeleteButtonInput(BaseModel):
    enabled: bool


@router.get("/admin/lead-delete-button")
async def v3_get_lead_delete_button(_: V3UserOut = Depends(require_developer_password)):
    return {"enabled": await lead_purge.delete_button_enabled()}


@router.put("/admin/lead-delete-button")
async def v3_set_lead_delete_button(
    payload: LeadDeleteButtonInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": lead_purge.DELETE_BUTTON_SETTING_ID},
        {"$set": {
            "id": lead_purge.DELETE_BUTTON_SETTING_ID,
            "enabled": payload.enabled,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"enabled": payload.enabled}


# Whether the accountant's Approvals offer a Delete bin -- Income Approval, Expenses
# Approval and the Expense tab -- and the Branch Admin's Accountant Manage one on their own
# branch's expenses. Off hides the icon and the delete endpoints refuse.
class ExpenseDeleteButtonInput(BaseModel):
    enabled: bool


@router.get("/admin/expense-delete-button")
async def v3_get_expense_delete_button(_: V3UserOut = Depends(require_developer_password)):
    return {"enabled": await expense_delete_enabled()}


@router.put("/admin/expense-delete-button")
async def v3_set_expense_delete_button(
    payload: ExpenseDeleteButtonInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": EXPENSE_DELETE_SETTING_ID},
        {"$set": {
            "id": EXPENSE_DELETE_SETTING_ID,
            "enabled": payload.enabled,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"enabled": payload.enabled}


# Before Verify Transactions: whether Branch Admin's Accountant Manage offers a bin on the
# payments still in To Verify (delete_unverified_transaction). Its own switch rather than the
# Approvals one above, because it hands the delete to the branch desk rather than to the
# accountant. Off hides the icon and the endpoint refuses.
@router.get("/admin/before-verify-delete-button")
async def v3_get_before_verify_delete_button(_: V3UserOut = Depends(require_developer_password)):
    return {"enabled": await before_verify_delete_enabled()}


@router.put("/admin/before-verify-delete-button")
async def v3_set_before_verify_delete_button(
    payload: ExpenseDeleteButtonInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": BEFORE_VERIFY_DELETE_SETTING_ID},
        {"$set": {
            "id": BEFORE_VERIFY_DELETE_SETTING_ID,
            "enabled": payload.enabled,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"enabled": payload.enabled}


# Whether a Super Admin's My Consultation offers the branch-wise On/Off switches. Off hides
# the icon and treats the Super Admin as On at every branch (see super_admin_consults_at),
# so switching the feature away never leaves a branch unable to book them.
class SaConsultBranchesInput(BaseModel):
    enabled: bool


@router.get("/admin/super-admin-consult-branches")
async def v3_get_sa_consult_branches(_: V3UserOut = Depends(require_developer_password)):
    return {"enabled": await super_admin_branch_switches_enabled()}


@router.put("/admin/super-admin-consult-branches")
async def v3_set_sa_consult_branches(
    payload: SaConsultBranchesInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": SA_CONSULT_BRANCHES_SETTING_ID},
        {"$set": {
            "id": SA_CONSULT_BRANCHES_SETTING_ID,
            "enabled": payload.enabled,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"enabled": payload.enabled}


# Whether each branch keeps its own Services and Products -- prices, Consultation Duration,
# session counts, names. On: a branch's edit is its own and its bookings are priced and
# timed off it. Off (the default): one catalogue for every branch, as it always was. The
# branch copies are kept either way, so switching back On restores them.
class StoreBranchOverridesInput(BaseModel):
    enabled: bool


@router.get("/admin/store-branch-overrides")
async def v3_get_store_branch_overrides(_: V3UserOut = Depends(require_developer_password)):
    return {"enabled": await store_branch_overrides.enabled()}


@router.put("/admin/store-branch-overrides")
async def v3_set_store_branch_overrides(
    payload: StoreBranchOverridesInput,
    user: V3UserOut = Depends(require_developer_password),
):
    await v3_col("app_settings").update_one(
        {"id": store_branch_overrides.SETTING_ID},
        {"$set": {
            "id": store_branch_overrides.SETTING_ID,
            "enabled": payload.enabled,
            "updated_by": user.full_name,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"enabled": payload.enabled}


# What a consultation's Zumba and Fitness referral leaves on a lead. Cleared with the rest of
# the pipeline, or a reset lead goes on being read as a live referral by both tabs.
LEAD_ZUMBA_FITNESS_RESET_FIELDS = {
    "zumba_recommended": False,
    "zumba_package_id": None,
    "zumba_package_name": None,
    "zumba_package_price": None,
    "zumba_package_sessions": None,
    "zumba_package_mode": None,
    "fitness_recommended": False,
}

# Diet, Diet Chart and Rehab, as the consultation and the branch leave them on a lead: the
# decision and referral flags, who was put on it, what was chosen, where it stands, and what
# the coach wrote. Left behind, a reset New Lead stayed in the Nutrition Coach's and the
# rehab physio's queues. Their fees go too, through LEAD_PAYMENT_RESET_FIELDS.
LEAD_DIET_REHAB_RESET_FIELDS = {
    "consultation_decision": None,
    "diet_recommended": False,
    "diet_consultation": False,
    "diet_chart": False,
    "diet_coach_id": None,
    "diet_coach_name": None,
    "diet_assigned_at": None,
    "diet_appointment_at": None,
    "diet_stage": None,
    "diet_package_id": None,
    "diet_package_name": None,
    "diet_package_price": None,
    "diet_package_mode": None,
    "diet_chart_package_id": None,
    "diet_chart_package_name": None,
    "diet_chart_package_price": None,
    "diet_chart_package_mode": None,
    "diet_chart_document_id": None,
    "diet_chart_sent_at": None,
    "diet_chart_sent_by": None,
    "diet_consultation_report": None,
    "diet_consultation_report_at": None,
    "diet_consultation_report_by": None,
    "rehab_referred": False,
    "rehab_package_id": None,
    "rehab_package_name": None,
    "rehab_package_price": None,
    "rehab_package_sessions": None,
    "rehab_package_mode": None,
    "rehab_physio_id": None,
    "rehab_physio_name": None,
    "rehab_assigned_at": None,
    "rehab_stage": None,
    # The histories go with the activity trail they sit beside: a lead with no branch and no
    # physio has no hand-overs or transfers to account for.
    "rehab_assignment_history": [],
    "physio_assignment_history": [],
    "branch_transfer_history": [],
}


@router.post("/admin/reset-all-leads")
async def v3_reset_all_leads(confirm: bool = False, _: V3UserOut = Depends(require_developer_password)):
    """Testing utility: resets every lead's pipeline progress back to a fresh,
    unassigned state at Pre-Sales' first stage — the lead record itself (name,
    phone, contact info, source) is kept as-is. Clears both the Consultation
    Package/fee and the Treatment Fee/Session Package/Partial Payment schedule,
    so no stale balance or due date survives into Accountant Manage after a
    reset. Also clears everything tied to leads that only makes sense
    mid-pipeline: sessions, weekly assessments, package recommendations,
    appointments, patient view tokens, and activity history. The VIP and Need Attention
    marks go too, so Dashboard > Clients starts empty.

    Every Review goes too, whichever tab it sits on (Send to Review, Pending Review, Review
    Complete). A review is a reading of treatment days this reset deletes, and one left
    behind would still hold its Head Physio slot and keep the Review tab counting patients
    who are back at New Leads.

    Zumba and Fitness go entirely: the referral flags and Zumba package on every lead, every
    registration on both tabs (walk-ins included), and every turned-away referral. So do
    Diet, Diet Chart and Rehab: the consultation decision, referrals, coach and rehab physio,
    packages, fees, stages, the coach's report and chart pointer, and every diet and rehab
    session day. Uploaded documents are left alone.

    The Management calendars start over as well: every slot published on a Consultant's,
    Physiotherapist's or Nutritionist's calendar, and the one-day shift changes made from
    them, and every Zumba master's class. Their bookings are the appointments and session
    days deleted above, and Missed Classes is read off those, so it empties with them. What
    an expert is set up as stays -- usual shift, patients per slot, service, meeting link.
    Irreversible — requires confirm=true. Super Admin plus the developer password."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Pass confirm=true to proceed — this cannot be undone.")

    first_stage = await get_first_stage_name("pre_sales", "New Leads")
    reset_fields = {
        "stage": first_stage,
        "branch_id": None,
        "branch_stage": None,
        "consultation_stage": None,
        "head_consultation_stage": None,
        "physio_stage": None,
        "consultation_fee": None,
        "consultation_item_name": None,
        "consultation_mode": None,
        "consultation_payment_mode": None,
        "package_amount": None,
        "package_weeks": None,
        "package_id": None,
        "package_name": None,
        "package_price": None,
        "package_paid": None,
        "package_payment_mode": None,
        "package_sessions": None,
        "package_duration_minutes": None,
        "package_mode": None,
        "treatment_fee_paid": None,
        "treatment_fee_payment_mode": None,
        "treatment_fee_payment_details": None,
        "session_package_id": None,
        "session_package_name": None,
        "session_package_price": None,
        "session_package_manual": None,
        "session_package_sessions": None,
        "session_package_mode": None,
        "diagnosis": None,
        "physio_diagnosis_report": None,
        "physio_diagnosis_locked": False,
        "treatment_summary": None,
        "treatment_summary_locked": False,
        "assigned_physio_id": None,
        "assigned_physio_name": None,
        "physio_assigned_at": None,
        "assigned_user_id": None,
        "assigned_user_name": None,
        "rnr_attempts": 0,
        "rnr_last_attempt_at": None,
        "follow_ups": [],
        "next_follow_up_at": None,
        "consultation_follow_ups": [],
        "next_consultation_follow_up_at": None,
        "appointment_mode": None,
        "appointment_department": None,
        "visit_type": None,
        "visit_package_id": None,
        "visit_package_name": None,
        "visit_package_price": None,
        "visit_package_visits": None,
        "appointment_date": None,
        "appointment_time": None,
        "appointment_datetime": None,
        # A reschedule is a mark on the appointment this reset deletes, so it goes with it.
        "appointment_rescheduled": False,
        "appointment_reschedule_count": 0,
        "appointment_rescheduled_at": None,
        "appointment_rescheduled_from": None,
        # The hand-put VIP and Need Attention marks. Dashboard > Clients lists leads by
        # these two alone, so left behind they kept a reset New Lead on both lists.
        "is_vip": False,
        "needs_attention": False,
        "portfolio_date": None,
        "portfolio_time": None,
        "portfolio_datetime": None,
        "expected_consultation_date": None,
        **LEAD_ZUMBA_FITNESS_RESET_FIELDS,
        **LEAD_DIET_REHAB_RESET_FIELDS,
        # Every fee field, Diet/Diet Chart/Rehab included -- the same set the payments reset
        # clears, so the two resets can never disagree about what counts as money on a lead.
        **LEAD_PAYMENT_RESET_FIELDS,
        "updated_at": now_iso(),
    }
    leads_result = await v3_col("leads").update_many({}, {"$set": reset_fields})

    # Treatment sessions only. The `sessions` collection also holds auth login tokens
    # ({token, user_id}), and an unfiltered delete here signed every user out of every
    # device — nothing to do with resetting leads. Treatment sessions are the ones
    # carrying lead_id; login tokens have none, so they can never match.
    sessions_deleted = (await v3_col("sessions").delete_many({"lead_id": {"$exists": True}})).deleted_count
    assessments_deleted = (await v3_col("weekly_assessments").delete_many({})).deleted_count
    reviews_deleted = (await v3_col("reviews").delete_many({})).deleted_count
    recs_deleted = (await v3_col("package_recommendations").delete_many({})).deleted_count
    appts_deleted = (await v3_col("appointments").delete_many({})).deleted_count
    tokens_deleted = (await v3_col("patient_tokens").delete_many({})).deleted_count
    activity_deleted = (await v3_col("lead_activity").delete_many({})).deleted_count
    zumba_deleted = (await v3_col("zumba_registrations").delete_many({})).deleted_count
    fitness_deleted = (await v3_col("fitness_registrations").delete_many({})).deleted_count
    # Old clients are people on the books the way a registration is (old_clients.py), and go
    # with their instalments for the same reason the payment rows in lead_activity go above.
    old_clients_deleted = (await v3_col("old_clients").delete_many({})).deleted_count
    await v3_col("old_client_payments").delete_many({})
    await v3_col("zumba_referral_dismissals").delete_many({})
    await v3_col("fitness_referral_dismissals").delete_many({})
    diet_days_deleted = (await v3_col("diet_sessions").delete_many({})).deleted_count
    rehab_days_deleted = (await v3_col("rehab_sessions").delete_many({})).deleted_count

    # Management's calendars. Only experts with something published are counted, so the
    # figure reads as calendars cleared rather than every doctor record on the install.
    calendars_result = await v3_col("doctors").update_many(
        {"$or": [
            {"slots.0": {"$exists": True}},
            {"slot_details.0": {"$exists": True}},
            {"shift_overrides": {"$nin": [None, {}]}},
        ]},
        {"$set": {"slots": [], "slot_details": [], "shift_overrides": {}, "updated_at": now_iso()}},
    )
    zumba_classes_result = await v3_col("users").update_many(
        {MASTER_SLOT_FIELD: {"$nin": ["", None]}},
        {"$set": {MASTER_SLOT_FIELD: ""}},
    )

    return {
        "message": "All leads reset to a fresh state",
        "calendars_cleared": calendars_result.modified_count,
        "zumba_classes_cleared": zumba_classes_result.modified_count,
        "diet_sessions_deleted": diet_days_deleted,
        "rehab_sessions_deleted": rehab_days_deleted,
        "zumba_registrations_deleted": zumba_deleted,
        "fitness_registrations_deleted": fitness_deleted,
        "old_clients_deleted": old_clients_deleted,
        "leads_reset": leads_result.modified_count,
        "sessions_deleted": sessions_deleted,
        "weekly_assessments_deleted": assessments_deleted,
        "reviews_deleted": reviews_deleted,
        "package_recommendations_deleted": recs_deleted,
        "appointments_deleted": appts_deleted,
        "patient_tokens_deleted": tokens_deleted,
        "lead_activity_deleted": activity_deleted,
    }


# Every field a fee collection writes onto a lead: what came in, how, and any schedule it
# left behind. The plan the money was for -- consultation package, session package, the
# rehab course, the diet item and their prices -- is deliberately not here, so a reset
# patient still owes the same fees and every Collect button finds them where it did.
#
# None rather than 0, because None is what "not collected" means to the code that reads
# these: the collect endpoints test `*_paid is not None` to tell a first collection from a
# correction, and the Treatment Summary unlocks on the same test.
LEAD_PAYMENT_RESET_FIELDS = {
    "consultation_fee": None,
    "consultation_payment_mode": None,
    # The legacy collect-fee endpoint's package figure — money taken, not a price.
    "package_amount": None,
    "package_paid": None,
    "package_payment_mode": None,
    "package_payment_details": None,
    "treatment_fee_paid": None,
    "treatment_fee_payment_mode": None,
    "treatment_fee_payment_details": None,
    "diet_fee_paid": None,
    "diet_fee_payment_mode": None,
    "diet_fee_payment_details": None,
    "diet_chart_fee_paid": None,
    "diet_chart_fee_payment_mode": None,
    "diet_chart_fee_payment_details": None,
    "rehab_fee_paid": None,
    "rehab_fee_payment_mode": None,
    "rehab_fee_payment_details": None,
    # Running totals of the above as they stood at each branch transfer. Left in place they
    # would credit the old branch with money that no longer exists anywhere else.
    "revenue_branch_splits": [],
}

# What approving or sending up a Zumba/Fitness payment stamps on the registration — the
# same fields unapprove_transaction and unrequest_transactions take off.
REGISTRATION_APPROVAL_UNSET = {
    "approved_by": "", "approved_at": "",
    "approval_confirmed_amount": "", "approval_transaction_ref": "", "approval_cheque_number": "",
    "income_requested_by": "", "income_requested_at": "",
}


@router.post("/admin/reset-all-payments")
async def v3_reset_all_payments(confirm: bool = False, _: V3UserOut = Depends(require_developer_password)):
    """Wipes every rupee recorded anywhere in the OS, leaving the people and plans it was
    recorded against. For clearing test money before go-live.

    Patients keep their stage, branch, packages and prices; only what was paid is cleared,
    so every fee reads as owed again. Zumba and Fitness registrations keep their fee and
    term with nothing paid against it, and old clients their course with no instalment taken
    on the OS. Store sales are deleted and their quantity is put
    back on the shelf, so a branch's stock count still agrees with its ledger of adds and
    transfers. The cash book (expenses, petty cash, handovers, adjustments including the
    opening cash, closing counts and closed books), payroll, and HR's advance and expense
    claims are deleted outright. Receipt numbering restarts.

    Leaves alone: leads, registrations, stock items, stock deliveries and transfers, and
    every activity entry that is not a payment. Irreversible — requires confirm=true.
    Super Admin plus the developer password."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Pass confirm=true to proceed — this cannot be undone.")

    leads_result = await v3_col("leads").update_many({}, {"$set": {**LEAD_PAYMENT_RESET_FIELDS, "updated_at": now_iso()}})
    # Payment rows only. Approval state lives on these rows too, so it goes with them; the
    # rest of each patient's history (stage moves, diagnoses, remarks) is kept.
    payments_deleted = (await v3_col("lead_activity").delete_many({"action": {"$in": REVENUE_ACTIONS}})).deleted_count

    registration_set = {"fee_paid": 0.0, "payment_mode": "", "payment_reference": "", "payment_lines": [], "approved": False, "income_requested": False}
    zumba_result = await v3_col("zumba_registrations").update_many(
        {}, {"$set": registration_set, "$unset": REGISTRATION_APPROVAL_UNSET}
    )
    # Each renewal keeps a copy of what was paid for that term. Rewritten row by row rather
    # than with `$[]`, which refuses any document where the array does not exist.
    renewed = await v3_col("zumba_registrations").find(
        {"renewals.0": {"$exists": True}}, {"_id": 0, "id": 1, "renewals": 1}
    ).to_list(None)
    for reg in renewed:
        renewals = [{**r, "fee_paid": 0.0, "lines": []} for r in reg["renewals"]]
        await v3_col("zumba_registrations").update_one({"id": reg["id"]}, {"$set": {"renewals": renewals}})
    fitness_result = await v3_col("fitness_registrations").update_many(
        {}, {"$set": {**registration_set, "payments": []}, "$unset": REGISTRATION_APPROVAL_UNSET}
    )
    # Old clients keep their course and what the old tracker says was paid on it; the
    # instalments taken on the OS go, so each balance reads as it did before any of them.
    old_client_payments_deleted = (await v3_col("old_client_payments").delete_many({})).deleted_count

    # Put sold stock back before the sales go, one increment per item per branch. Skipped for
    # an item since deleted from the catalogue: its stock rows went with it, and restoring
    # them would recreate a count for something no screen can show.
    sales = await v3_col("inventory_movements").find(
        {"kind": "sale"}, {"_id": 0, "item_id": 1, "branch_id": 1, "qty": 1}
    ).to_list(None)
    sold = {}
    for sale in sales:
        key = (sale.get("item_id"), sale.get("branch_id"))
        sold[key] = sold.get(key, 0) + int(sale.get("qty") or 0)
    live_items = {
        row["id"] for row in await v3_col("inventory_items").find(
            {"id": {"$in": list({item_id for item_id, _ in sold})}}, {"_id": 0, "id": 1}
        ).to_list(None)
    }
    for (item_id, branch_id), qty in sold.items():
        if item_id in live_items and branch_id and qty > 0:
            await _add_to_stock(item_id, branch_id, qty)
    store_sales_deleted = (await v3_col("inventory_movements").delete_many({"kind": "sale"})).deleted_count

    cash_book = ("expenses", "petty_cash_movements", "cash_handovers", "cash_adjustments", "closing_balances", "closed_books")
    cash_book_deleted = {name: (await v3_col(name).delete_many({})).deleted_count for name in cash_book}

    payslips_deleted = (await v3_col("payslips").delete_many({})).deleted_count
    payroll_runs_deleted = (await v3_col("payroll_runs").delete_many({})).deleted_count
    # Money claims only; leave, permission and comp-off requests share this collection.
    hr_claims_deleted = (await v3_col("approvals").delete_many({"kind": {"$in": ["advance", "expense"]}})).deleted_count

    # Receipt numbers are TXN-<branch>-<day>-<seq>, counted per branch per day. Patient
    # numbers share the collection under their own prefix and are not touched.
    await v3_col("counters").delete_many({"_id": {"$regex": "^transaction_id:"}})

    return {
        "message": "All payments reset to a fresh state",
        "leads_cleared": leads_result.modified_count,
        "payments_deleted": payments_deleted,
        "zumba_registrations_cleared": zumba_result.modified_count,
        "fitness_registrations_cleared": fitness_result.modified_count,
        "old_client_payments_deleted": old_client_payments_deleted,
        "store_sales_deleted": store_sales_deleted,
        "cash_book_deleted": cash_book_deleted,
        "payslips_deleted": payslips_deleted,
        "payroll_runs_deleted": payroll_runs_deleted,
        "hr_money_claims_deleted": hr_claims_deleted,
    }


# Every (collection, field) that books a patient against an expert profile. A profile named
# in any of them has history, and is switched off rather than deleted -- the same rule
# delete_user_permanent follows, for the same reason: removing the row orphans the record.
EXPERT_HISTORY_REFS = (
    ("appointments", "doctor_id"),
    ("sessions", "physio_id"),
    ("rehab_sessions", "physio_id"),
    ("diet_sessions", "coach_id"),
    ("weekly_assessments", "physio_id"),
    ("package_recommendations", "head_physio_id"),
    ("reviews", "head_physio_id"),
    ("reviews", "physio_id"),
)

# The lead fields that name an expert profile, each with the name stored beside it.
LEAD_EXPERT_FIELDS = (
    ("assigned_physio_id", "assigned_physio_name"),
    ("rehab_physio_id", "rehab_physio_name"),
    ("diet_coach_id", "diet_coach_name"),
)


@router.post("/admin/reset-all-users")
async def v3_reset_all_users(confirm: bool = False, _: V3UserOut = Depends(require_developer_password)):
    """Deletes every login except the Super Admins', and what belongs only to those people.
    For clearing test staff before go-live.

    With each deleted login go: its signed-in sessions, clock-in days, login history and
    password-reset requests; the HR employee record it is linked to, with that employee's
    attendance register and leave/permission requests; and its expert calendar profiles
    (matched by login or by employee). A profile nothing was ever booked against is
    deleted; one that appointments or sessions still point at is switched off instead.

    Whatever named those people is unassigned: leads' Pre-Sales, physio, rehab physio and
    diet coach; Zumba registrations' master; each branch's admin. Every Client Portal login
    and portal session is deleted too. Leads, branches and registrations themselves stay.

    A Super Admin's login, employee record and expert profile are never touched. Employees
    with no login at all are not users and are left alone. Irreversible — requires
    confirm=true. Super Admin plus the developer password."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Pass confirm=true to proceed — this cannot be undone.")

    doomed = await v3_col("users").find(
        {"role": {"$ne": "super_admin"}}, {"_id": 0, "id": 1, "employee_id": 1}
    ).to_list(None)
    user_ids = [u["id"] for u in doomed]
    kept_employee_ids = {
        u["employee_id"] for u in await v3_col("users").find(
            {"role": "super_admin"}, {"_id": 0, "employee_id": 1}
        ).to_list(None) if u.get("employee_id")
    }
    employee_ids = list({u["employee_id"] for u in doomed if u.get("employee_id")} - kept_employee_ids)
    kept_user_ids = [u["id"] for u in await v3_col("users").find({"role": "super_admin"}, {"_id": 0, "id": 1}).to_list(None)]

    # Their expert profiles, by either link, never one a Super Admin holds.
    expert_query = {
        "$or": [{"user_id": {"$in": user_ids}}, {"employee_id": {"$in": employee_ids}}],
        "user_id": {"$nin": kept_user_ids},
    }
    experts = await v3_col("doctors").find(expert_query, {"_id": 0, "id": 1}).to_list(None)
    expert_ids = [d["id"] for d in experts]
    booked = set()
    for collection, field in EXPERT_HISTORY_REFS:
        booked.update(await v3_col(collection).distinct(field, {field: {"$in": expert_ids}}))
    to_delete = [i for i in expert_ids if i not in booked]
    to_switch_off = [i for i in expert_ids if i in booked]
    experts_deleted = (await v3_col("doctors").delete_many({"id": {"$in": to_delete}})).deleted_count
    await v3_col("doctors").update_many(
        {"id": {"$in": to_switch_off}}, {"$set": {"is_active": False, "updated_at": now_iso()}}
    )

    # Unassign before the people go, while the ids still say who they were.
    lead_assignments_cleared = (await v3_col("leads").update_many(
        {"assigned_user_id": {"$in": user_ids}},
        {"$set": {"assigned_user_id": None, "assigned_user_name": None, "assigned_user_role": None, "updated_at": now_iso()}},
    )).modified_count
    for id_field, name_field in LEAD_EXPERT_FIELDS:
        lead_assignments_cleared += (await v3_col("leads").update_many(
            {id_field: {"$in": expert_ids}},
            {"$set": {id_field: None, name_field: None, "updated_at": now_iso()}},
        )).modified_count
    await v3_col("zumba_registrations").update_many(
        {"assigned_master_id": {"$in": user_ids}}, {"$set": {"assigned_master_id": "", "assigned_master_name": ""}}
    )
    # Empty strings, not None: V3BranchOut declares all three as plain str, and a None here
    # would fail every read of the branch list.
    branches_unlinked = (await v3_col("branches").update_many(
        {"admin_user_id": {"$in": user_ids}},
        {"$set": {"admin_user_id": "", "admin_name": "", "admin_email": "", "admin_phone": ""}},
    )).modified_count

    # Login tokens only: treatment sessions share this collection and carry no user_id.
    await v3_col("sessions").delete_many({"user_id": {"$in": user_ids}})
    await v3_col("clock_days").delete_many({"user_id": {"$in": user_ids}})
    await v3_col("login_history").delete_many({"user_id": {"$in": user_ids}})
    await v3_col("password_reset_requests").delete_many({"user_id": {"$in": user_ids}})

    employees_deleted = (await v3_col("employees").delete_many({"id": {"$in": employee_ids}})).deleted_count
    await v3_col("attendance").delete_many({"employee_id": {"$in": employee_ids}})
    await v3_col("approvals").delete_many({"employee_id": {"$in": employee_ids}})

    portal_accounts_deleted = (await v3_col("patient_portal_accounts").delete_many({})).deleted_count
    await v3_col("patient_portal_sessions").delete_many({})

    users_deleted = (await v3_col("users").delete_many({"id": {"$in": user_ids}})).deleted_count

    return {
        "message": "All users except Super Admin reset to a fresh state",
        "users_deleted": users_deleted,
        "employees_deleted": employees_deleted,
        "expert_profiles_deleted": experts_deleted,
        "expert_profiles_switched_off": len(to_switch_off),
        "lead_assignments_cleared": lead_assignments_cleared,
        "branches_unlinked": branches_unlinked,
        "portal_accounts_deleted": portal_accounts_deleted,
    }
