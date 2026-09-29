from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, Dict
from pydantic import BaseModel
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time, generate_patient_number, without_past_moves
from deps import (
    v3_current_user, v3_require_roles, is_branch_admin_role, is_head_physio_role, is_physio_role,
    vertical_names_an_arm, lead_as_read_by, works_org_wide,
)
from constants import V3_STAGES
from stage_utils import first_branch_stage_for, first_branch_stage_for_branch
import lead_control
import lead_purge
from schemas.v3 import (
    V3UserOut, V3LeadCreate, V3LeadUpdate, V3LeadOut,
    V3AssignBranchInput, V3BookAppointmentInput, V3AppointmentOut,
    V3RemarkCreate, V3FollowUpCreate, V3MoveStageInput,
)

router = APIRouter(prefix="/api/v3")


@router.get("/leads")
async def v3_get_leads(
    stage: Optional[str] = None,
    branch_id: Optional[str] = None,
    source_tab: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user: V3UserOut = Depends(v3_current_user),
):
    query: Dict[str, object] = {}
    if stage:
        query["stage"] = stage
    if source_tab:
        query["source_tab"] = source_tab

    # A Pre-Sales user only gets branch-scoped once a branch is actually assigned to
    # them (Super Admin > Roles & Credentials) — one left unassigned still sees every
    # branch's leads, same as before.
    # Off the predicates for the clinical two, not the literals: the consultation desk
    # moved off `head_physio` onto `consultant`, and `online_physio` was never listed — so
    # both fell through this branch filter and were shown every branch's leads. pre_sales
    # stays an exact match; Sales Head is deliberately org-wide and must not be scoped.
    if (is_branch_admin_role(user.role) or is_head_physio_role(user.role) or is_physio_role(user.role) or user.role == "pre_sales") and user.branch_id:
        query["branch_id"] = user.branch_id
    elif branch_id:
        query["branch_id"] = branch_id

    if start_date or end_date:
        created_query: Dict[str, str] = {}
        if start_date:
            created_query["$gte"] = start_date
        if end_date:
            created_query["$lte"] = end_date
        query["created_at"] = created_query

    # Past Data's trial clients are read on their own branch's board. Here only when the
    # list is that one branch's -- never in the every-branch list Super Admin and an
    # unassigned Pre-Sales desk read.
    if not query.get("branch_id"):
        query = without_past_moves(query)

    rows = await v3_col("leads").find(query, {"_id": 0}).sort("updated_at", -1).to_list(20000)
    # Lead Control is read from the branch here rather than stored on the lead, so a
    # branch switched to "branch_admin" hands over the leads it already has instead of
    # only the next import. One query for every branch, not one per lead.
    control_by_branch = await lead_control.branch_control_map()
    return [
        V3LeadOut(**lead_as_read_by({**row, "lead_control": lead_control.control_for_lead(row, control_by_branch)}, user.role))
        for row in rows
    ]


@router.post("/leads/manual", response_model=V3LeadOut)
async def v3_manual_lead(payload: V3LeadCreate, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "pre_sales", "branch_admin"))):
    # A lead created directly against a branch (e.g. a walk-in added by Super Admin/Branch
    # Admin) must land on the branch's own New Lead stage too, same as sheet/Meta-imported
    # leads — otherwise it has a branch_id but no branch_stage and never shows on that board.
    if payload.branch_id:
        branch_stage = await first_branch_stage_for_branch(payload.branch_id, "New Appointment")
    elif vertical_names_an_arm(payload.vertical):
        # An online arm's lead has no branch and never will — the arm is not a branch record
        # — but it is worked on a board with the same stage strip, so it needs the same
        # opening or it arrives counted under All Stages and under no stage at all. The
        # arm's board runs at Pre-Sales control (no branch of its own means nobody has said
        # otherwise — see _board_payload in routers/v3_branch_admin.py), so it opens where a
        # Pre-Sales-fed branch opens.
        branch_stage = await first_branch_stage_for(lead_control.PRE_SALES, "New Appointment")
    else:
        branch_stage = None
    patient_number = await generate_patient_number(payload.branch_id) if payload.branch_id else None
    lead = {
        "id": str(uuid.uuid4()),
        "patient_number": patient_number,
        "name": payload.name,
        "phone": payload.phone,
        "email": payload.email,
        "vertical": payload.vertical,
        "source_tab": payload.source_tab,
        "source_type": payload.source_type,
        "stage": "New Leads",
        "branch_id": payload.branch_id,
        "branch_stage": branch_stage,
        "notes": payload.notes,
        "extra_fields": payload.extra_fields or {},
        "alternative_phone": payload.alternative_phone or "",
        "address": payload.address or "",
        "city": payload.city or "",
        "state": payload.state or "",
        "location": payload.location or "",
        "department": payload.department or "",
        "condition": payload.condition or "",
        "months_of_pain": payload.months_of_pain,
        "age": payload.age,
        "gender": payload.gender or "",
        "occupation": payload.occupation or "",
        "expected_consultation_date": payload.expected_consultation_date or "",
        # Stored whoever sends it; only Super Admin's form offers the tab that fills it,
        # and only Super Admin reads it back — see lead_as_read_by in deps.py. Empty dict,
        # not None, so the field is shaped the same for anyone who does read it.
        "lead_data": payload.lead_data.model_dump() if payload.lead_data else {},
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await v3_col("leads").insert_one(lead.copy())
    return V3LeadOut(**lead)


@router.delete("/leads/{lead_id}")
async def v3_delete_lead(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Permanently delete a lead/patient and every record that points back at them —
    Branch Leads, the Consultant queue, Physio's board, Diet, Zumba, the client portal —
    so nothing is left showing a patient this just erased. The two org-wide desks only."""
    res = await v3_col("leads").delete_one({"id": lead_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Lead not found")
    await lead_purge.delete_lead_trail([lead_id])
    return {"message": "Lead deleted", "lead_id": lead_id}



class BulkDeleteLeadsInput(BaseModel):
    lead_ids: list[str]
    confirm: str
    # Delete the patient outright, treatment slots and collected payments included,
    # instead of refusing anyone who has them. The row's own bin icon in Branch Leads
    # sends this; the select-many bar does not. See the endpoint's docstring.
    purge: bool = False


# Paid-for history a lead can be carrying. Kept beside the endpoint that refuses to delete
# over it so the two cannot drift: these are the actions the finance board counts as
# revenue, and a lead holding one of them is a line in a figure someone has already
# reported.
_PAID_ACTIONS = [
    "consultation_paid", "package_sold", "package_payment_collected",
    "treatment_fee_collected", "diet_fee_collected", "diet_chart_fee_collected",
    "rehab_fee_collected", "fee_collected",
]

# Enough to clear a bad import in a few passes, small enough that one request cannot walk
# the whole branch. Refused rather than truncated: silently deleting the first 500 of 2000
# and reporting success is how someone deletes 1500 rows they never saw.
MAX_BULK_DELETE = 500


@router.post("/branch/leads/bulk-delete")
async def v3_bulk_delete_leads(
    payload: BulkDeleteLeadsInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "branch_admin")),
):
    """Delete leads from Branch Leads — a bad import cleared out, or one patient removed.

    Permanent, and the reason this is not simply the existing per-lead delete in a loop:

    A Branch Admin can only reach leads of their own branch. The list on their screen is
    already branch-scoped, but a request is not a screen, and an id typed by hand must not
    reach another branch's patient. Ids that fall outside are reported as such rather than
    silently ignored, so a wrong selection reads as wrong.

    The typed confirmation is required here too, not just in the dialog. A bulk delete that
    a stray request can fire is one accident away from a branch's whole lead list.

    Two strengths, and which one is asked for decides what survives:

    Without `purge` — the select-many bar — a lead carrying paid-for history is refused.
    Treatment sessions and collected payments point back at the lead, so deleting one
    empties a figure the finance board has already reported. Clearing junk from an import
    is what that is for, and junk has no history. Refusals come back named, so they are
    actionable rather than a silent short count.

    With `purge` — the bin icon on a single row — there is no such refusal: the patient
    goes, and so does everything of theirs, treatment slots and collected payments
    included. That is what it is for. A patient enrolled by mistake, a duplicate that has
    already been part-billed, a test record walked through a whole treatment plan: those
    cannot be cleaned up by a delete that steps around exactly the records that make them
    a mess. Branch scoping and the typed DELETE still hold, and so does the developer
    switch checked first — this is not a power an install has unless someone left it on.
    """
    # The Danger Zone switch. Checked on the server and not merely used to hide the icon:
    # a button that is only missing from the page is still a request anyone can send.
    if not await lead_purge.delete_button_enabled():
        raise HTTPException(
            status_code=403,
            detail="Deleting patients is switched off for this install",
        )
    if (payload.confirm or "").strip().upper() != "DELETE":
        raise HTTPException(status_code=400, detail="Type DELETE to confirm")

    ids = [i for i in dict.fromkeys(payload.lead_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="No patients selected")
    if len(ids) > MAX_BULK_DELETE:
        raise HTTPException(
            status_code=400,
            detail=f"Too many at once — select {MAX_BULK_DELETE} or fewer (you picked {len(ids)})",
        )

    rows = await v3_col("leads").find(
        {"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1, "branch_id": 1}
    ).to_list(MAX_BULK_DELETE)
    found = {r["id"]: r for r in rows}

    blocked: list = []
    deletable: list = []

    for lead_id in ids:
        lead = found.get(lead_id)
        if not lead:
            blocked.append({"lead_id": lead_id, "name": "", "reason": "No longer exists"})
            continue
        # The org-wide desks reach every branch; everyone else is held to their own.
        if not works_org_wide(user.role) and lead.get("branch_id") != user.branch_id:
            blocked.append({"lead_id": lead_id, "name": lead.get("name", ""), "reason": "Belongs to another branch"})
            continue
        # Everything below is the paid-for-history refusal, which a purge is asking us
        # not to make. Branch scoping above is not optional either way.
        if not payload.purge:
            if await v3_col("sessions").find_one({"lead_id": lead_id}, {"_id": 0, "id": 1}):
                blocked.append({"lead_id": lead_id, "name": lead.get("name", ""), "reason": "Has treatment sessions"})
                continue
            if await v3_col("lead_activity").find_one(
                {"lead_id": lead_id, "action": {"$in": _PAID_ACTIONS}}, {"_id": 0, "id": 1}
            ):
                blocked.append({"lead_id": lead_id, "name": lead.get("name", ""), "reason": "Has collected payments"})
                continue
        deletable.append(lead)

    deleted_ids = [l["id"] for l in deletable]
    if deleted_ids:
        await v3_col("leads").delete_many({"id": {"$in": deleted_ids}})
        # The same trail the single delete clears, so nothing is left pointing at a lead
        # that is gone.
        await lead_purge.delete_lead_trail(deleted_ids)

    return {
        "deleted": len(deleted_ids),
        "deleted_ids": deleted_ids,
        "blocked": blocked,
        "requested": len(ids),
        "purged": bool(payload.purge),
    }


class BulkHardDeleteLeadsInput(BaseModel):
    lead_ids: list[str]
    confirm: str


@router.post("/leads/bulk-hard-delete")
async def v3_bulk_hard_delete_leads(
    payload: BulkHardDeleteLeadsInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Same permanent, no-guard delete as the single-lead DELETE above — every fee,
    session and appointment on file included — for several patients picked at once, e.g.
    clearing everyone currently listed on one Consultations view. The two org-wide desks
    only: unlike the safer bulk-delete above (kept open to a Branch Admin precisely because
    it refuses anyone with paid-for history), this one has no such refusal to fall back on.
    """
    if (payload.confirm or "").strip().upper() != "DELETE":
        raise HTTPException(status_code=400, detail="Type DELETE to confirm")

    ids = [i for i in dict.fromkeys(payload.lead_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="No patients selected")
    if len(ids) > MAX_BULK_DELETE:
        raise HTTPException(
            status_code=400,
            detail=f"Too many at once — select {MAX_BULK_DELETE} or fewer (you picked {len(ids)})",
        )

    res = await v3_col("leads").delete_many({"id": {"$in": ids}})
    await lead_purge.delete_lead_trail(ids)
    return {"deleted": res.deleted_count, "lead_ids": ids}


@router.put("/leads/{lead_id}", response_model=V3LeadOut)
async def v3_edit_lead(
    lead_id: str,
    payload: V3LeadUpdate,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "pre_sales", "branch_admin")),
):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    updates["updated_at"] = now_iso()

    if "branch_id" in updates:
        branch = await v3_col("branches").find_one({"id": updates["branch_id"]}, {"_id": 0, "id": 1})
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

    existing = None
    if updates.get("stage") == "Appointment" or "branch_id" in updates:
        existing = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1, "branch_id": 1, "branch_stage": 1})

    # Hand-off bridge: when stage is set to "Appointment" via PUT, push lead into Branch Admin's
    # New Lead column (only if branch_stage isn't already set on the lead).
    if updates.get("stage") == "Appointment" and "branch_stage" not in updates and existing is not None and not existing.get("branch_stage"):
        updates["branch_stage"] = await first_branch_stage_for_branch(
            updates.get("branch_id") or existing.get("branch_id"), "New Appointment"
        )

    # Reassigning to a different branch must reset branch_stage — otherwise the lead silently
    # carries its old branch's pipeline position (e.g. "Portfolio") onto the new branch's board.
    if "branch_id" in updates and "branch_stage" not in updates and existing is not None and existing.get("branch_id") != updates["branch_id"]:
        updates["branch_stage"] = await first_branch_stage_for_branch(updates["branch_id"], "New Appointment")

    filter_query: Dict[str, object] = {"id": lead_id}
    if is_branch_admin_role(user.role) and user.branch_id:
        filter_query["branch_id"] = user.branch_id

    result = await v3_col("leads").update_one(filter_query, {"$set": updates})
    if result.matched_count == 0:
        exists = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1})
        if not exists:
            raise HTTPException(status_code=404, detail="Lead not found")
        raise HTTPException(status_code=403, detail="Lead not in your branch scope")

    if "phone" in updates:
        # Imported here, not at the top: the portal router pulls in several others, and
        # this is the only thing v3_leads needs from it.
        from routers.v3_patient_portal import sync_portal_login_phone
        await sync_portal_login_phone(lead_id, updates["phone"])

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**lead)


@router.post("/leads/{lead_id}/qualify", response_model=V3LeadOut)
async def v3_qualify_lead(lead_id: str, _: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin"))):
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"stage": "Follow Up", "updated_at": now_iso()}})
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return V3LeadOut(**lead)


@router.post("/leads/{lead_id}/assign-branch", response_model=V3LeadOut)
async def v3_assign_branch(lead_id: str, payload: V3AssignBranchInput, _: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin"))):
    branch = await v3_col("branches").find_one({"id": payload.branch_id}, {"_id": 0, "id": 1})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    existing_lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "patient_number": 1})
    if not existing_lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    new_branch_stage = await first_branch_stage_for_branch(payload.branch_id, "New Appointment")
    updates = {"branch_id": payload.branch_id, "stage": "Appointment", "branch_stage": new_branch_stage, "updated_at": now_iso()}
    # A lead created without a branch (e.g. straight from Pre-Sales) never got a Patient
    # Number — this is its first branch, so assign one now instead of leaving it blank forever.
    if not existing_lead.get("patient_number"):
        patient_number = await generate_patient_number(payload.branch_id)
        if patient_number:
            updates["patient_number"] = patient_number
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return V3LeadOut(**lead)


@router.post("/leads/{lead_id}/confirm", response_model=V3LeadOut)
async def v3_confirm_lead(lead_id: str, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    filter_query = {"id": lead_id}
    if is_branch_admin_role(user.role):
        filter_query["branch_id"] = user.branch_id

    # Read the lead's branch before writing: the entry stage it lands on depends on that
    # branch's Lead Control, and a branch_admin caller's own branch_id is not necessarily
    # the lead's when a Super Admin is the one confirming.
    target = await v3_col("leads").find_one(filter_query, {"_id": 0, "branch_id": 1})
    new_branch_stage = await first_branch_stage_for_branch((target or {}).get("branch_id"), "New Appointment")
    result = await v3_col("leads").update_one(filter_query, {"$set": {"stage": "Appointment", "branch_stage": new_branch_stage, "updated_at": now_iso()}})
    if result.matched_count == 0:
        exists = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1})
        if not exists:
            raise HTTPException(status_code=404, detail="Lead not found")
        raise HTTPException(status_code=403, detail="Lead not in your branch scope")

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return V3LeadOut(**lead)


@router.post("/leads/{lead_id}/book-appointment", response_model=V3AppointmentOut)
async def v3_book_appointment(lead_id: str, payload: V3BookAppointmentInput, user: V3UserOut = Depends(v3_require_roles("pre_sales", "branch_admin", "head_physio", "super_admin"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    slot_key = normalize_slot_time(payload.slot_time)
    doctor = await v3_col("doctors").find_one({"id": payload.doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    if slot_key not in doctor.get("slots", []):
        raise HTTPException(status_code=400, detail="Doctor slot unavailable")
    clash = await v3_col("appointments").find_one({"doctor_id": payload.doctor_id, "slot_time": slot_key, "status": "new_appointment"}, {"_id": 0})
    if clash:
        raise HTTPException(status_code=409, detail="Slot already booked")

    appointment = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "lead_name": lead["name"],
        "branch_id": lead.get("branch_id") or doctor["branch_id"],
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
        "slot_time": slot_key,
        "status": "new_appointment",
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("appointments").insert_one(appointment.copy())
    new_branch_stage = await first_branch_stage_for_branch(appointment["branch_id"], "New Appointment")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"stage": "Appointment", "branch_stage": new_branch_stage, "updated_at": now_iso()}})
    return V3AppointmentOut(**appointment)


@router.get("/leads/{lead_id}/remarks")
async def v3_get_remarks(lead_id: str, _: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("lead_remarks").find({"lead_id": lead_id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return rows


@router.post("/leads/{lead_id}/remarks")
async def v3_add_remark(lead_id: str, payload: V3RemarkCreate, user: V3UserOut = Depends(v3_current_user)):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    remark = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "text": payload.text,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_remarks").insert_one(remark.copy())
    return remark


@router.get("/leads/{lead_id}/follow-ups")
async def v3_get_follow_ups(lead_id: str, _: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("lead_followups").find({"lead_id": lead_id}, {"_id": 0}).sort("scheduled_date", 1).to_list(200)
    return rows


@router.post("/leads/{lead_id}/follow-ups")
async def v3_add_follow_up(lead_id: str, payload: V3FollowUpCreate, user: V3UserOut = Depends(v3_current_user)):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    followup = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "note": payload.note,
        "scheduled_date": payload.scheduled_date,
        "status": "pending",
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    await v3_col("lead_followups").insert_one(followup.copy())
    return followup


@router.post("/leads/{lead_id}/follow-ups/{followup_id}/complete")
async def v3_complete_follow_up(lead_id: str, followup_id: str, _: V3UserOut = Depends(v3_current_user)):
    result = await v3_col("lead_followups").update_one(
        {"id": followup_id, "lead_id": lead_id},
        {"$set": {"status": "completed"}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Follow-up not found")
    return {"message": "Follow-up completed"}


@router.get("/leads/{lead_id}/activity")
async def v3_get_activity(lead_id: str, _: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("lead_activity").find({"lead_id": lead_id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return rows


@router.post("/leads/{lead_id}/move-stage")
async def v3_move_stage(lead_id: str, payload: V3MoveStageInput, user: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin", "branch_admin"))):
    if payload.stage not in V3_STAGES:
        raise HTTPException(status_code=400, detail="Invalid stage")
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    old_stage = lead.get("stage", "Unknown")
    updates = {"stage": payload.stage, "updated_at": now_iso()}
    # Hand-off bridge: when pre-sales moves a lead into "Appointment", make it visible
    # in Branch Admin > Appointment > New Lead column (only if not already on a branch stage).
    if payload.stage == "Appointment" and not lead.get("branch_stage"):
        updates["branch_stage"] = await first_branch_stage_for_branch(lead.get("branch_id"), "New Appointment")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "stage_change",
        "details": f"Moved from '{old_stage}' to '{payload.stage}'",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class LeadFlagsInput(BaseModel):
    # Both optional and both nullable-by-omission: the row toggles one mark at a time, and
    # sending only the one that changed keeps a click on the star from also rewriting the
    # attention mark someone else set a second earlier.
    is_vip: Optional[bool] = None
    needs_attention: Optional[bool] = None


@router.patch("/leads/{lead_id}/flags", response_model=V3LeadOut)
async def v3_set_lead_flags(
    lead_id: str,
    payload: LeadFlagsInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "pre_sales", "business_dev")),
):
    """The two marks a branch puts on a patient by hand: VIP, and needs attention.

    Deliberately its own endpoint rather than a field on the lead update: this is a one-click
    toggle from a row in a list, and routing it through the full-record PUT would have a
    star press send every other field on the lead back with it — overwriting whatever anyone
    editing that patient had changed in the meantime.

    Neither flag touches a stage. They say something about how the branch is treating a
    patient, not where the patient is, so clearing one must never read as progress.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    changes = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not changes:
        raise HTTPException(status_code=400, detail="Nothing to change")
    changes["updated_at"] = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": changes})

    # Logged like any other hand-made decision on a patient, so "who marked this VIP" has an
    # answer. Both marks are visible to the whole branch, and an unexplained one invites the
    # next person to clear it.
    said = []
    if "is_vip" in changes:
        said.append("marked VIP" if changes["is_vip"] else "removed the VIP mark")
    if "needs_attention" in changes:
        said.append("flagged for attention" if changes["needs_attention"] else "cleared the attention flag")
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "lead_flagged",
        "details": " and ".join(said).capitalize(),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })

    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/rnr-attempt", response_model=V3LeadOut)
async def v3_rnr_attempt(lead_id: str, user: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin", "branch_admin"))):
    """Increment the 'rnr_attempts' counter on a lead (Ring-Not-Responded)."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    new_count = int(lead.get("rnr_attempts") or 0) + 1
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": {"rnr_attempts": new_count, "rnr_last_attempt_at": now_iso(), "updated_at": now_iso()}},
    )
    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "rnr_attempt",
        "details": f"Call attempt #{new_count} — client did not answer",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class V3FollowUpInput(BaseModel):
    date: str  # YYYY-MM-DD
    time: str  # HH:MM (24h)
    remarks: Optional[str] = ""


class V3AppointmentScheduleInput(BaseModel):
    mode: str  # "offline" | "online"
    department: str = "physio"  # "physio" | "fitness" — chosen first, before mode
    branch_id: Optional[str] = None  # omitted for offline => defaults to the Pre-Sales user's own branch
    diagnosis: Optional[str] = None  # basic diagnosis captured at Pre-Sales for the Physio/Offline path
    appointment_date: Optional[str] = None  # YYYY-MM-DD — Pre-Sales' requested slot
    appointment_time: Optional[str] = None  # HH:MM
    remarks: Optional[str] = None


@router.post("/leads/{lead_id}/schedule-appointment", response_model=V3LeadOut)
async def v3_schedule_appointment(lead_id: str, payload: V3AppointmentScheduleInput, user: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin", "branch_admin"))):
    """Move lead to Appointment stage with department (physio/fitness), mode (offline/online),
    and branch (offline only — defaults to the calling Pre-Sales user's own assigned branch when
    not given explicitly). Pre-Sales assigns the branch, a requested date/time, and remarks; the
    Branch Admin still assigns the Fitsiomax Expert, using this date/time as the starting point."""
    if payload.department not in ("physio", "fitness"):
        raise HTTPException(status_code=400, detail="department must be 'physio' or 'fitness'")
    if payload.mode not in ("offline", "online"):
        raise HTTPException(status_code=400, detail="mode must be 'offline' or 'online'")
    branch_id = payload.branch_id or (user.branch_id if payload.mode == "offline" else None)
    if payload.mode == "offline" and not branch_id:
        raise HTTPException(status_code=400, detail="Branch is required for offline appointments")
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    branch_name = None
    if branch_id:
        b = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "branch_name": 1, "name": 1})
        if not b:
            raise HTTPException(status_code=404, detail="Branch not found")
        branch_name = b.get("branch_name") or b.get("name")
    # Online appointments have no branch, so there's no branch board for them to sit in.
    new_branch_stage = await first_branch_stage_for_branch(branch_id, "New Appointment") if branch_id else None
    updates = {
        "stage": "Appointment",
        "appointment_mode": payload.mode,
        "appointment_department": payload.department,
        "branch_id": branch_id,
        "branch_stage": new_branch_stage,
        "updated_at": now_iso(),
    }
    if payload.diagnosis:
        updates["diagnosis"] = payload.diagnosis
    if payload.appointment_date:
        updates["appointment_date"] = payload.appointment_date
    if payload.appointment_time:
        updates["appointment_time"] = payload.appointment_time
    if payload.remarks:
        updates["notes"] = payload.remarks
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    details = f"Appointment scheduled · {payload.department} · mode={payload.mode}"
    if branch_name:
        details += f" · branch={branch_name}"
    if payload.appointment_date and payload.appointment_time:
        details += f" · requested {payload.appointment_date} {payload.appointment_time}"
    if payload.diagnosis:
        details += f" · diagnosis={payload.diagnosis}"
    if payload.remarks:
        details += f" · remarks={payload.remarks}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "appointment_scheduled",
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/follow-up", response_model=V3LeadOut)
async def v3_schedule_follow_up(lead_id: str, payload: V3FollowUpInput, user: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin", "branch_admin"))):
    """Schedule a follow-up for a lead. Appends to follow_ups[] and moves stage to 'Follow Up'."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": (payload.remarks or "").strip(),
        "status": "active",
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$push": {"follow_ups": entry}, "$set": {"stage": "Follow Up", "next_follow_up_at": f"{payload.date}T{payload.time}:00", "updated_at": now_iso()}},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "follow_up_scheduled",
        "details": f"Follow-up on {payload.date} at {payload.time} — {entry['remarks'] or 'no remarks'}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class V3FollowUpRescheduleInput(BaseModel):
    date: str  # YYYY-MM-DD
    time: str  # HH:MM (24h)
    reason: Optional[str] = ""


@router.post("/leads/{lead_id}/follow-up/{followup_id}/reschedule", response_model=V3LeadOut)
async def v3_reschedule_follow_up(lead_id: str, followup_id: str, payload: V3FollowUpRescheduleInput, user: V3UserOut = Depends(v3_require_roles("pre_sales", "business_dev", "super_admin", "branch_admin"))):
    """Mark an existing follow-up as rescheduled (with a reason) and add a new active one in its place."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    follow_ups = lead.get("follow_ups") or []
    old = next((f for f in follow_ups if f.get("id") == followup_id), None)
    if not old:
        raise HTTPException(status_code=404, detail="Follow-up not found")
    reason = (payload.reason or "").strip()
    for f in follow_ups:
        if f.get("id") == followup_id:
            f["status"] = "rescheduled"
            f["reschedule_reason"] = reason
    new_entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": old.get("remarks", ""),
        "status": "active",
        "rescheduled_from": followup_id,
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    follow_ups.append(new_entry)
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": {"follow_ups": follow_ups, "stage": "Follow Up", "next_follow_up_at": f"{payload.date}T{payload.time}:00", "updated_at": now_iso()}},
    )
    old_summary = f"{old.get('date')} at {old.get('time')}"
    details = f"Follow-up rescheduled from {old_summary} to {payload.date} at {payload.time}"
    if reason:
        details += f" — reason: {reason}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "follow_up_rescheduled",
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)
