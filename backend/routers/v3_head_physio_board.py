from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional
from pydantic import BaseModel
from datetime import date
import uuid

import store_branch_overrides
from database import v3_col
from utils import now_iso, physio_slot_load, slot_capacity_of, active_doctor_query, live_branch_query
from deps import (
    v3_current_user, v3_require_roles, consultants_serving_branch, super_admin_consults_at,
    super_admin_branch_switches_enabled,
)
from constants import V3_HEAD_CONSULTATION_STAGES
from stage_utils import get_closing_stage_name, get_stage_name_at
from schemas.v3 import (
    V3UserOut, V3PackageRecommendInput, V3HeadPhysioReviewInput, V3LeadOut,
    V3ConsultationDecisionInput, V3AssignPhysioSessionsInput,
)

router = APIRouter(prefix="/api/v3")


async def _head_consultation_stage_names() -> list:
    """Live Head Consultation stages as configured in Super Admin > Pipeline Stage
    Management, falling back to the built-in defaults if none have been configured yet."""
    rows = await v3_col("pipeline_stages").find(
        {"type": "head_consultation"}, {"_id": 0, "name": 1}
    ).sort("order", 1).to_list(50)
    names = [r["name"] for r in rows]
    return names or V3_HEAD_CONSULTATION_STAGES


async def _head_closing_stage() -> str:
    """Where a completed consultation lands on the Head Physio's own pipeline."""
    return await get_closing_stage_name("head_consultation", V3_HEAD_CONSULTATION_STAGES[-1])


async def _branch_consultation_visit_stage() -> str:
    """Where Branch Admin picks a finished consultation up — the named stage while it is
    still called that, otherwise the position it occupies in their pipeline."""
    rows = await v3_col("pipeline_stages").find(
        {"type": "consultation"}, {"_id": 0, "name": 1}
    ).sort("order", 1).to_list(50)
    names = [r["name"] for r in rows]
    if "Consultation Visit" in names:
        return "Consultation Visit"
    return await get_stage_name_at("consultation", 1, "Consultation Visit")


async def _branch_stage_after_decision(lead: dict) -> str:
    """Where Branch Admin should find this lead once the consultation is saved.

    Normally the hand-off stage itself. But Save & Move is also how a Head Physio corrects
    a decision already made, and by then the desk may have taken the Consultation Fee,
    taken the Treatment Fee, even assigned the treatment physio. Stamping the hand-off
    stage again marched those leads backwards: the Fee Collected panel vanished from under
    a Branch Admin mid-collection, and the Treatment Fee -- gated on a stage that had just
    been undone -- became uncollectable for the rest of the visit.

    So a lead that has already moved past the hand-off stays where it is. Only one still
    waiting at or before it is placed there.
    """
    handoff = await _branch_consultation_visit_stage()
    current = lead.get("consultation_stage")
    if not current or current == handoff:
        return handoff
    rows = await v3_col("pipeline_stages").find(
        {"type": "consultation"}, {"_id": 0, "name": 1}
    ).sort("order", 1).to_list(50)
    order = {r["name"]: i for i, r in enumerate(rows)}
    if current in order and handoff in order:
        return current if order[current] > order[handoff] else handoff
    # A stage with no row of its own -- "Consultation Completed" is still written to leads
    # long after its pill was retired. Money already taken is the evidence that the lead is
    # past the hand-off; anything else belongs at it.
    return current if lead.get("package_paid") is not None else handoff


async def ensure_super_admin_consultant(user: V3UserOut) -> Optional[dict]:
    """The Super Admin's own consultant record, created on first use if it isn't there.

    A Super Admin is hired as a Super Admin, so HR never mints them a `doctors` record —
    v3_hr skips one deliberately for that role. The consequence was a page called My
    Consultation that could not be about the reader: with nothing to match on, the board
    fell back to whichever consultant record Mongo happened to return first and showed a
    stranger's patients under the reader's own name.

    Creating it here rather than asking HR to is the point. The banner that used to sit on
    that page told the reader to go and get a record linked, which is a dead end for the
    one person in the building who outranks everybody who could do it. A Super Admin who
    takes a consultation is a consultant for that hour, and this is the record that says so.

    Branchless, exactly like a Consultant hired through HR (SINGLE_CALENDAR_ROLES) — one
    person keeps one set of published hours, so splitting the record per branch would let
    the same Super Admin be booked into the same hour at two of them with nothing to catch
    it. Where they are OFFERED is decided from the login, in consultants_serving_branch.

    `is_super_admin` is what every surface reads to tag the row. It lives on the record
    rather than being re-derived from the login at each call site, because the booking
    picker, the board column and the calendar all need the same answer and a rule kept in
    three places is a rule kept in none.
    """
    if user.role != "super_admin":
        return None
    mine = await v3_col("doctors").find_one(
        {"user_id": user.id, "profile_type": "head_physio"}, {"_id": 0},
    )
    if mine:
        # Older records minted before this existed carry no flag; stamp it once so the
        # tag is not missing on exactly the accounts that have been here longest.
        if not mine.get("is_super_admin"):
            await v3_col("doctors").update_one(
                {"id": mine["id"]}, {"$set": {"is_super_admin": True}},
            )
            mine["is_super_admin"] = True
        return mine
    doctor = {
        "id": str(uuid.uuid4()),
        "full_name": user.full_name,
        "profile_type": "head_physio",
        "branch_id": None,
        "specialization": "",
        "slots": [],
        "slot_details": [],
        "user_id": user.id,
        "is_super_admin": True,
        "created_at": now_iso(),
    }
    await v3_col("doctors").insert_one(doctor.copy())
    return doctor


async def _resolve_hp_doctor(user: V3UserOut, branch_id: Optional[str] = None) -> Optional[dict]:
    """Find the doctors record for the logged-in head physio/consultant.

    A Head Physio is SUPPOSED to have exactly one, branchless record — they cover the whole
    organisation — so their own user_id ought to resolve it outright. In practice they can
    end up with more than one: several paths mint these records, and consolidate_head_physio_doctors
    in seed.py exists because they have.

    find_one against that is a coin toss, and every screen a consultant has rides on the
    answer. Their patients are the appointments carrying this record's id and their calendar
    is its slots, so landing on the empty twin shows a consultant with a full book an empty
    board, and nothing on screen says why. That is not a hypothetical: it is what "I moved
    the patient to the consultant and the consultant cannot see them" looks like from the
    inside.

    So every record is read and the one holding the work is chosen: the one with
    appointments against it, else the one with published slots, else the oldest, which is
    the one the others were duplicated from. Read-only — nothing is merged or deleted here,
    because throwing away a record with bookings on it is not a repair a page load should
    be making.

    `branch_id` is only used by a Super Admin driving a specific branch's board, where there
    is no head-physio login to match on.
    """
    mine = await v3_col("doctors").find(
        {"user_id": user.id, "profile_type": "head_physio"}, {"_id": 0},
    ).to_list(50)
    if mine:
        if len(mine) == 1:
            return mine[0]
        ids = [d["id"] for d in mine]
        # Which of them anything is actually booked against. distinct rather than a count
        # per record: one query, and the question is only ever "does this one hold any".
        busy = set(await v3_col("appointments").distinct("doctor_id", {"doctor_id": {"$in": ids}}))
        mine.sort(key=lambda d: (
            0 if d["id"] in busy else 1,
            0 if (d.get("slots") or []) else 1,
            str(d.get("created_at") or ""),
        ))
        return mine[0]
    # Their own record, minted here the first time they need it. It used to be
    # `find_one({"profile_type": "head_physio"})` — no user, no sort, no branch, so the
    # answer was whichever record Mongo listed first and could change between deploys
    # without anything in the data changing.
    if user.role == "super_admin":
        return await ensure_super_admin_consultant(user)
    return None


@router.get("/head-physio/resolved")
async def hp_resolved_consultant(user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin"))):
    """Whose consultant book the board is about to show, and whether it is the caller's own.

    Called on My Consultation's mount, which is also where a Super Admin's own consultant
    record gets created if they haven't got one — see ensure_super_admin_consultant. So the
    answer for a Super Admin is now always "yours", and the page no longer has to explain
    that it is showing somebody else's work.

    `is_super_admin` comes back with it so the page can wear the tag beside the name, which
    is the whole point of a Super Admin taking a consultation being visible as such.
    """
    own = await v3_col("doctors").find_one(
        {"user_id": user.id, "profile_type": "head_physio"},
        {"_id": 0, "id": 1, "full_name": 1, "is_super_admin": 1},
    )
    if not own and user.role == "super_admin":
        own = await ensure_super_admin_consultant(user)
    if own:
        return {
            "consultant_id": own["id"],
            "consultant_name": own.get("full_name") or "",
            "is_super_admin": bool(own.get("is_super_admin")),
            "is_mine": True,
        }

    # Only a head_physio login can still land here — one hired without a record. There is
    # nothing to fall back to that would be theirs, so the page is told plainly.
    return {"consultant_id": "", "consultant_name": "", "is_super_admin": False, "is_mine": False}


async def _consult_branches_of(user_id: str) -> dict:
    """Every branch, each with whether this Super Admin takes consultations there, and
    whether a developer has the switches offered at all (Danger Zone)."""
    enabled = await super_admin_branch_switches_enabled()
    login = await v3_col("users").find_one(
        {"id": user_id}, {"_id": 0, "consult_off_branch_ids": 1},
    ) or {}
    rows = await v3_col("branches").find(live_branch_query(), {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    rows.sort(key=lambda b: (b.get("branch_name") or "").lower())
    return {
        "enabled": enabled,
        "branches": [
            {"branch_id": b["id"], "branch_name": b.get("branch_name") or "", "on": super_admin_consults_at(login, b["id"], enabled)}
            for b in rows if b.get("id")
        ],
    }


class ConsultBranchToggle(BaseModel):
    on: bool


@router.get("/head-physio/my-branches")
async def hp_my_consult_branches(user: V3UserOut = Depends(v3_require_roles("super_admin"))):
    """The branch-wise On/Off switches on a Super Admin's My Consultation.

    On is where they are offered: that branch's Consultant Calendar lists them, and its
    booking and reassign pickers can hand them a patient. Off takes them out of all of it
    at that branch only. Appointments already booked there are left where they are —
    switching off stops new bookings, it does not cancel anybody.
    """
    return await _consult_branches_of(user.id)


@router.put("/head-physio/my-branches/{branch_id}")
async def hp_set_consult_branch(
    branch_id: str,
    payload: ConsultBranchToggle,
    user: V3UserOut = Depends(v3_require_roles("super_admin")),
):
    if not await super_admin_branch_switches_enabled():
        raise HTTPException(status_code=403, detail="Branch On/Off is switched off in Developer settings")
    if not await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Branch not found")
    op = {"$pull": {"consult_off_branch_ids": branch_id}} if payload.on else {"$addToSet": {"consult_off_branch_ids": branch_id}}
    await v3_col("users").update_one({"id": user.id}, op)
    return await _consult_branches_of(user.id)


@router.get("/head-physio/my-calendar")
async def hp_my_calendar(branch_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev"))):
    """Read-only view of the logged-in consultant's own booked slots (branch admin manages slot availability)."""
    doctor = await _resolve_hp_doctor(user, branch_id)
    if not doctor:
        return {"slots": [], "slot_details": [], "booked": {}}

    # Two different things take a Head Physio's slot, and the calendar has to say which.
    # A review is dispatched into one of these published slots exactly as a consultation is
    # booked into it — it was simply never read here, so a slot held by a review showed as
    # "Available" and could be booked over.
    review_rows = await v3_col("reviews").find(
        {"head_physio_id": doctor["id"], "review_date": {"$nin": ["", None]}},
        {"_id": 0, "id": 1, "lead_name": 1, "review_date": 1, "review_time": 1, "status": 1, "physio_name": 1},
    ).to_list(1000)

    booked_map = {}
    for r in review_rows:
        # No time means it was never placed on the grid — it is on the Review list waiting
        # for one, and inventing a slot for it here would put it in an hour nobody chose.
        if not r.get("review_time"):
            continue
        slot = f"{r['review_date']}T{r['review_time']}"
        booked_map[slot] = {
            "id": r.get("id"),
            "slot_time": slot,
            "lead_name": r.get("lead_name", "Unknown"),
            "kind": "review",
            "kind_label": "Review",
            "status": r.get("status", ""),
            "with_name": r.get("physio_name", ""),
        }

    appt_rows = await v3_col("appointments").find(
        {"doctor_id": doctor["id"], "status": "new_appointment"},
        # `rescheduled` rides along so the grid can say this hour is not the one the
        # patient was first given. Read off the appointment rather than joined back to the
        # lead: this endpoint never loads leads, and the appointment is stamped with it at
        # the moment it is moved — see v3_schedule_branch_appointment.
        {"_id": 0, "slot_time": 1, "lead_name": 1, "id": 1, "rescheduled": 1, "rescheduled_from": 1},
    ).to_list(1000)
    for row in appt_rows:
        # Written second on purpose. If a slot somehow holds both, the consultation is the
        # one shown — it is the appointment the patient was given a time for. Two things in
        # one slot is a booking fault of its own, and hiding the harder one would be worse
        # than hiding the review.
        booked_map[row["slot_time"]] = {**row, "kind": "consultation", "kind_label": "Consultation"}

    # Surface booked slots even when the branch admin never pre-created an availability slot
    # for them — union booked times into the displayed slots.
    slots = sorted(set(doctor.get("slots", [])) | set(booked_map.keys()))

    return {
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
        "specialization": doctor.get("specialization", ""),
        "slots": slots,
        "slot_details": doctor.get("slot_details", []),
        "booked": booked_map,
    }


@router.get("/head-physio/my-patients")
async def hp_my_patients(branch_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin"))):
    doctor = await _resolve_hp_doctor(user, branch_id)
    if not doctor:
        return {"patients": []}

    appointments = await v3_col("appointments").find(
        {"doctor_id": doctor["id"]},
        {"_id": 0},
    ).sort("slot_time", -1).to_list(500)

    lead_ids = list({a["lead_id"] for a in appointments})
    leads = await v3_col("leads").find({"id": {"$in": lead_ids}}, {"_id": 0}).to_list(500)
    lead_map = {l["id"]: l for l in leads}

    recommendations = await v3_col("package_recommendations").find(
        {"lead_id": {"$in": lead_ids}}, {"_id": 0}
    ).to_list(500)
    rec_map = {r["lead_id"]: r for r in recommendations}

    patients = []
    for lead_id in lead_ids:
        lead = lead_map.get(lead_id, {})
        appts = [a for a in appointments if a["lead_id"] == lead_id]
        rec = rec_map.get(lead_id)
        patients.append({
            "lead_id": lead_id,
            "lead_name": lead.get("name", "Unknown"),
            "phone": lead.get("phone", ""),
            "email": lead.get("email", ""),
            "branch_stage": lead.get("branch_stage", ""),
            "consultation_fee": lead.get("consultation_fee"),
            "package_amount": lead.get("package_amount"),
            "appointments": appts,
            "recommendation": rec,
            "has_recommendation": rec is not None,
        })

    return {"patients": patients}


@router.post("/head-physio/recommend-package")
async def hp_recommend_package(
    payload: V3PackageRecommendInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    lead = await v3_col("leads").find_one({"id": payload.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    doctor = await _resolve_hp_doctor(user, lead.get("branch_id"))

    total_sessions = payload.recommended_weeks * payload.sessions_per_week

    rec = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "lead_name": lead.get("name", "Unknown"),
        "branch_id": lead.get("branch_id") or user.branch_id,
        "head_physio_id": doctor["id"] if doctor else "",
        "head_physio_name": doctor["full_name"] if doctor else user.full_name,
        "recommended_weeks": payload.recommended_weeks,
        "sessions_per_week": payload.sessions_per_week,
        "total_sessions": total_sessions,
        "notes": payload.notes or "",
        "status": "pending",
        "created_at": now_iso(),
    }
    await v3_col("package_recommendations").insert_one(rec.copy())

    await v3_col("leads").update_one(
        {"id": payload.lead_id},
        {"$set": {"branch_stage": "Follow Up", "updated_at": now_iso()}},
    )

    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "action": "package_recommended",
        "details": f"CONSULTANT recommended {payload.recommended_weeks} weeks, {payload.sessions_per_week} sessions/week ({total_sessions} total). Notes: {payload.notes}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())

    return rec


@router.get("/head-physio/sessions/{lead_id}")
async def hp_view_sessions(lead_id: str, _: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "branch_admin"))):
    sessions = await v3_col("sessions").find(
        {"lead_id": lead_id}, {"_id": 0}
    ).sort("slot_time", 1).to_list(500)
    return {"sessions": sessions}


@router.get("/head-physio/weekly-assessments/{lead_id}")
async def hp_get_assessments(lead_id: str, _: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin"))):
    assessments = await v3_col("weekly_assessments").find(
        {"lead_id": lead_id}, {"_id": 0}
    ).sort("week_number", 1).to_list(100)
    return {"assessments": assessments}


@router.post("/head-physio/weekly-review/{lead_id}/{week_number}")
async def hp_weekly_review(
    lead_id: str,
    week_number: int,
    payload: V3HeadPhysioReviewInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin")),
):
    existing = await v3_col("weekly_assessments").find_one(
        {"lead_id": lead_id, "week_number": week_number}, {"_id": 0}
    )

    if existing:
        await v3_col("weekly_assessments").update_one(
            {"lead_id": lead_id, "week_number": week_number},
            {"$set": {
                "head_physio_notes": payload.head_physio_notes,
                "head_physio_suggestions": payload.head_physio_suggestions,
                "status": "reviewed",
                "reviewed_by": user.full_name,
                "updated_at": now_iso(),
            }},
        )
    else:
        await v3_col("weekly_assessments").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "branch_id": user.branch_id,
            "week_number": week_number,
            "jr_physio_notes": "",
            "head_physio_notes": payload.head_physio_notes,
            "head_physio_suggestions": payload.head_physio_suggestions,
            "status": "reviewed",
            "reviewed_by": user.full_name,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        })

    updated = await v3_col("weekly_assessments").find_one(
        {"lead_id": lead_id, "week_number": week_number}, {"_id": 0}
    )
    return updated


class V3ConsultationPhysioAssignInput(BaseModel):
    physio_id: str


class V3HeadConsultationStageMoveInput(BaseModel):
    head_consultation_stage: str


@router.post("/leads/{lead_id}/move-head-consultation-stage", response_model=dict)
async def hp_move_head_consultation_stage(
    lead_id: str,
    payload: V3HeadConsultationStageMoveInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin")),
):
    """Move a lead through the Head Physio's own consultation pipeline
    (head_consultation_stage) — fully independent from Branch's consultation_stage."""
    stage_names = await _head_consultation_stage_names()
    if payload.head_consultation_stage not in stage_names:
        raise HTTPException(status_code=400, detail=f"Invalid head_consultation_stage. Allowed: {stage_names}")
    if payload.head_consultation_stage == await _head_closing_stage():
        raise HTTPException(
            status_code=403,
            detail="Use the consultation-decision endpoint (Save & Move) — it requires Diagnosis, Treatment Summary and a decision first.",
        )
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    previous = lead.get("head_consultation_stage") or "—"
    updates = {
        "head_consultation_stage": payload.head_consultation_stage,
        "updated_at": now_iso(),
    }
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "head_consultation_stage_moved",
        "details": f"Head Consultation: {previous} → {payload.head_consultation_stage}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Stage moved", "lead": V3LeadOut(**updated).model_dump()}


async def _rehab_package_fields(item_id: str, mode: str, branch_id: Optional[str] = None):
    """The Rehab course's fields on the lead, and the line the activity log says about it.

    Shared by Move to Admin and the Rehab consultation that follows a Treatment course, so
    a package chosen at either is priced the one way -- at the lead's branch's own figure
    where it keeps one (store_branch_overrides).
    """
    rehab_item = await store_branch_overrides.overlay_one(
        await v3_col("store_items").find_one({"id": item_id}, {"_id": 0}), branch_id
    )
    if not rehab_item:
        raise HTTPException(status_code=404, detail="Rehab package not found")
    if rehab_item.get("item_type") != "session" or rehab_item.get("category") != "rehab":
        raise HTTPException(status_code=400, detail="That item is not a Rehab package")
    r_amount = rehab_item.get("price_online") if mode == "online" else rehab_item.get("price_offline")
    r_sessions = rehab_item.get("sessions_online") if mode == "online" else rehab_item.get("sessions_offline")
    if rehab_item.get("price_is_total"):
        r_price = r_amount
    else:
        r_price = round(r_amount * r_sessions, 2) if r_amount is not None and r_sessions else r_amount
    fields = {
        "rehab_package_id": rehab_item["id"],
        "rehab_package_name": rehab_item["name"],
        "rehab_package_price": r_price,
        "rehab_package_sessions": r_sessions,
        "rehab_package_mode": mode,
    }
    return fields, f" · Rehab: {rehab_item['name']} ({r_sessions} sessions)"


# Home Visit > Physiotherapy (PackagesBoard's HOME_VISIT_SUBTABS): the per-visit rates a
# house-visit patient's treatment is charged at.
HOME_VISIT_PHYSIO_CATEGORY = "home_visit"


def _visit_kind(name: Optional[str]) -> Optional[str]:
    n = (name or "").lower()
    if "distance" in n:
        return "distance"
    if "standard" in n:
        return "standard"
    return None


async def _home_visit_rate_item(lead: dict) -> dict:
    """The Home Visit > Physiotherapy package a house-visit patient's treatment is priced
    off: the one of the same kind (Distance / Standard) as the Home Visit > Consultant
    package booked at the appointment. Matched by the word in the two names, since the
    two shelves are priced separately and share nothing else; failing that by whether
    both are priced by the branch; failing that the shelf's only package."""
    shelf = await v3_col("store_items").find(
        {"item_type": "session", "category": HOME_VISIT_PHYSIO_CATEGORY}, {"_id": 0}
    ).sort("created_at", 1).to_list(100)
    shelf = await store_branch_overrides.overlay(shelf, lead.get("branch_id"))
    if not shelf:
        raise HTTPException(status_code=400, detail="No Home Visit > Physiotherapy package is set up to price this House Visit")
    kind = _visit_kind(lead.get("visit_package_name"))
    if kind:
        same_kind = [i for i in shelf if _visit_kind(i.get("name")) == kind]
        if same_kind:
            return same_kind[0]
    booked = await store_branch_overrides.overlay_one(await v3_col("store_items").find_one(
        {"id": lead.get("visit_package_id")}, {"_id": 0, "id": 1, "manual_price": 1}
    ), lead.get("branch_id")) if lead.get("visit_package_id") else None
    if booked is not None:
        same_pricing = [i for i in shelf if bool(i.get("manual_price")) == bool(booked.get("manual_price"))]
        if len(same_pricing) == 1:
            return same_pricing[0]
    if len(shelf) == 1:
        return shelf[0]
    raise HTTPException(
        status_code=400,
        detail=f"No Home Visit > Physiotherapy package matches the booked House Visit package "
               f"'{lead.get('visit_package_name') or '—'}'. Name them alike (Distance / Standard).",
    )


@router.post("/leads/{lead_id}/consultation-decision", response_model=dict)
async def hp_consultation_decision(
    lead_id: str,
    payload: V3ConsultationDecisionInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    """Head Physio's 'Save & Move' — the single action that closes out the
    consultation: requires Diagnosis Report + Treatment Summary to already be
    written, records the Consultation Only / Consultation + Treatment decision
    (and, for the latter, the chosen Treatment/Session package — names only, no
    price shown here), then hands the lead to Branch Admin's 'Consultation Visit'
    column on both pipelines at once."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not (lead.get("physio_diagnosis_report") or "").strip():
        raise HTTPException(status_code=400, detail="Write the Diagnosis Report before Save & Move")
    if not (lead.get("treatment_summary") or "").strip():
        raise HTTPException(status_code=400, detail="Write the Treatment Summary before Save & Move")
    # Completing a consultation moves BOTH pipelines at once: the lead closes out on the
    # Head Physio's board and appears on Branch Admin's Consultation Visit column, which
    # is the one hand-off point between the two.
    updates = {
        "consultation_decision": payload.decision,
        "diet_recommended": bool(payload.diet_recommended),
        # A Diet referral IS a referral to the Nutritionist's consultation, so this follows
        # the flag rather than being asked for beside it.
        #
        # diet_chart is NOT written here, and not written back to False either. Whether the
        # patient needs a chart is the Nutritionist's judgement, made after seeing them and
        # recorded from their own board; clearing it here would take a chart the coach had
        # already recommended back off the branch's fee panel.
        "diet_consultation": bool(payload.diet_recommended),
        # Recorded rather than inferred. The Rehab card is derived from "has an appointment
        # with me and no package recommendation yet", which is true of a Consultation Only
        # patient too — without this flag there is no way to tell a patient deliberately
        # sent to rehab from one who simply has not been given a package.
        "rehab_referred": bool(payload.rehab_referred),
        # Rehab after Treatment: only alongside a Treatment package, and only while the
        # Rehab consultation has not happened yet. Once it has, the package it chose is
        # on rehab_referred, and a later edit of this decision keeps the mark rather than
        # sending the patient back to wait for a consultation they have already had.
        "rehab_after_treatment": bool(
            (payload.rehab_after_treatment and payload.decision == "consultation_treatment")
            or (lead.get("rehab_consulted_at") and payload.rehab_referred)
        ),
        "fitness_recommended": bool(payload.fitness_recommended),
        "zumba_recommended": bool(payload.zumba_recommended),
        "head_consultation_stage": await _head_closing_stage(),
        "consultation_stage": await _branch_stage_after_decision(lead),
        "updated_at": now_iso(),
    }
    # Named the way the Head Physio picked it, so the activity log reads back as the
    # choice that was made rather than as flags to recombine.
    chosen = "Consultation" if payload.decision == "consultation_only" else "Consultation + Treatment"
    if payload.rehab_referred:
        chosen += " + Rehab"
    elif payload.rehab_after_treatment and payload.decision == "consultation_treatment":
        chosen += " + Rehab after Treatment"
    if payload.diet_recommended:
        # Named as what it is: the one thing a Consultant can refer for on the diet side.
        # A chart, where the Nutritionist later recommends one, writes its own line.
        chosen += " + Diet Consultation"
    if payload.fitness_recommended:
        chosen += " + Fitness"
    if payload.zumba_recommended:
        chosen += " + Zumba"
    detail = f"Consultation decision: {chosen}"

    # Long Term. Only Rehab and Fitness run long term, and a service is marked by being
    # here at all -- the text is what was written about it, and a patient can be marked
    # long term with nothing written yet, so a blank one is kept rather than dropped.
    #
    # What is dropped is a note on a service that ended up unticked: an answer to a
    # question the form is no longer asking.
    ticked = {
        "rehab": bool(payload.rehab_referred) or bool(payload.rehab_after_treatment),
        "fitness": bool(payload.fitness_recommended),
    }
    long_term_notes = {
        k: (v or "").strip()
        for k, v in payload.long_term_notes.items()
        if ticked.get(k)
    }
    updates["long_term_notes"] = long_term_notes
    if long_term_notes:
        detail += f" · Long Term: {', '.join(k.title() for k in long_term_notes)}"

    # No consultation package is assigned here any more.
    #
    # This used to auto-assign one, on the premise that "Consultation Fee has a single
    # fixed price — there's nothing for the Head Physio to pick". That premise is gone:
    # the shelf now holds three packages at three prices (Only Consultation, Consultation
    # + 20 mins Physio, Consultation + 1 Session). What the code actually did was
    # find_one({"item_type": "consultation"}) with no sort and no category — whichever row
    # the database handed back first — which was harmless while every row was the same
    # price and became an arbitrary pick worth hundreds of rupees the moment it wasn't.
    #
    # The package is chosen at the desk instead, as the fee is collected, by the person
    # who knows what the patient agreed to buy. See collect_package_payment in
    # v3_packages.py, which now takes the choice and reads the price off the item.
    #
    # So a lead sits between the consultation and the collection with no package and no
    # package_price, where it previously carried a guess. Anything reading an expected
    # consultation fee before it is collected reads nothing rather than the wrong number,
    # which is the honest answer to "what does this patient owe" before anyone has said
    # what they are buying.

    if payload.decision == "consultation_treatment":
        if not payload.item_id:
            raise HTTPException(status_code=400, detail="Select a Treatment Package")
        item = await store_branch_overrides.overlay_one(
            await v3_col("store_items").find_one({"id": payload.item_id}, {"_id": 0}), lead.get("branch_id")
        )
        if not item:
            raise HTTPException(status_code=404, detail="Treatment package not found")
        if item.get("item_type") != "session":
            raise HTTPException(status_code=400, detail="Only Session packages can be chosen as the Treatment Package")
        # price_online/price_offline is a flat per-session rate (same across every
        # package size) — the total is just that rate × however many sessions this
        # patient is actually being charged for, never prorated against the package's
        # own default session count.
        base_price = item.get("price_online") if payload.mode == "online" else item.get("price_offline")
        base_sessions = item.get("sessions_online") if payload.mode == "online" else item.get("sessions_offline")
        sessions = payload.sessions_override if payload.sessions_override and payload.sessions_override > 0 else base_sessions
        # A House Visit patient picks the same treatment package as anyone else; only the
        # rate differs. It is the per-visit price of the Home Visit > Physiotherapy package
        # of the kind booked at the appointment (Distance or Standard), so the Consultant
        # is never asked that again.
        rate_item = item
        if lead.get("visit_type") == "home" and item.get("category") != HOME_VISIT_PHYSIO_CATEGORY:
            rate_item = await _home_visit_rate_item(lead)
            base_price = rate_item.get("price_offline")
        price = round(base_price * sessions, 2) if base_price is not None and sessions else base_price
        # A package Super Admin left unpriced (a Distance house visit) is priced by the
        # branch, on the Treatment Fee card. Re-saving the decision on the same package
        # keeps whatever the branch already typed.
        manual = bool(rate_item.get("manual_price"))
        if manual:
            same = lead.get("session_package_id") == item["id"] and lead.get("session_package_manual")
            price = lead.get("session_package_price") if same else None
        if rate_item is not item:
            detail += f" · House Visit rate: {rate_item.get('name')}"
        updates.update({
            "session_package_id": item["id"],
            "session_package_name": item["name"],
            "session_package_price": price,
            "session_package_sessions": sessions,
            "session_package_mode": payload.mode,
            "session_package_manual": manual,
        })
        detail += f" · Package: {item['name']} ({sessions} sessions)"

    # The Rehab course is priced by hand: the catalogue holds the whole course fee as it
    # was typed, and it is charged as it stands. Nothing is derived, so nothing can come
    # back a rupee off what was agreed.
    #
    # The rate x sessions path below it is for rows written before that, which still hold
    # the total divided down. Startup converts them (migrate_course_prices_to_totals) and
    # the flag says which is which; keeping both means the order of a deploy and a restart
    # cannot decide what a patient is charged.
    #
    # Only accepted alongside the referral — a rehab course on a patient who was never sent
    # to rehab is a fee nobody would know to collect.
    if payload.rehab_referred and payload.rehab_item_id:
        rehab_fields, rehab_detail = await _rehab_package_fields(payload.rehab_item_id, payload.mode, lead.get("branch_id"))
        updates.update(rehab_fields)
        detail += rehab_detail

    # The Zumba membership, priced the way rehab is — its plan amount is stored divided
    # down to a per-class rate, so rate x classes lands back on the figure the catalogue
    # was given. Only accepted alongside its own flag, for the same reason.
    if payload.zumba_recommended and payload.zumba_item_id:
        zumba_item = await store_branch_overrides.overlay_one(
            await v3_col("store_items").find_one({"id": payload.zumba_item_id}, {"_id": 0}), lead.get("branch_id")
        )
        if not zumba_item:
            raise HTTPException(status_code=404, detail="Zumba package not found")
        if zumba_item.get("item_type") != "session" or zumba_item.get("category") != "zumba":
            raise HTTPException(status_code=400, detail="That item is not a Zumba package")
        z_rate = zumba_item.get("price_online") if payload.mode == "online" else zumba_item.get("price_offline")
        z_sessions = zumba_item.get("sessions_online") if payload.mode == "online" else zumba_item.get("sessions_offline")
        z_price = round(z_rate * z_sessions, 2) if z_rate is not None and z_sessions else z_rate
        updates.update({
            "zumba_package_id": zumba_item["id"],
            "zumba_package_name": zumba_item["name"],
            "zumba_package_price": z_price,
            "zumba_package_sessions": z_sessions,
            "zumba_package_mode": payload.mode,
        })
        detail += f" · Zumba: {zumba_item['name']} ({z_sessions} classes)"

    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_decision_saved",
        "details": detail,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Saved & moved", "lead": V3LeadOut(**updated).model_dump()}


class V3RehabConsultBookInput(BaseModel):
    date: str  # YYYY-MM-DD
    time: str  # HH:MM (24h)
    remarks: Optional[str] = ""
    # The consultant to see the patient. Omitted means whoever took their first
    # consultation, which is who the Rehab consultation is normally with.
    physio_id: Optional[str] = None


class V3RehabConsultCompleteInput(BaseModel):
    rehab_item_id: str
    mode: Optional[str] = None


@router.post("/leads/{lead_id}/rehab-consultation/book", response_model=dict)
async def hp_book_rehab_consultation(
    lead_id: str,
    payload: V3RehabConsultBookInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Re-appoint a Rehab-after-Treatment patient with the Consultant, once treatment is done.

    Its own appointment row (appt_kind "rehab_consultation") rather than a move of the
    first consultation's: the consultation follow-up rebooks that row, re-dates the lead's
    appointment and writes the consultant over assigned_physio_id -- which, this far on, is
    the physio who delivered the treatment. None of that is true of a patient coming back
    for Rehab, so nothing here touches the pipeline stages or the first appointment.
    Booking again moves this booking, never adds a second.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not lead.get("rehab_after_treatment"):
        raise HTTPException(status_code=400, detail="This patient was not marked for Rehab after Treatment")
    if lead.get("rehab_consulted_at"):
        raise HTTPException(status_code=400, detail="The Rehab consultation has already been done")
    if not payload.date or not payload.time:
        raise HTTPException(status_code=400, detail="Pick a date and a time")

    doctor_id = payload.physio_id or lead.get("rehab_consult_doctor_id")
    if not doctor_id:
        first = await v3_col("appointments").find(
            {"lead_id": lead_id, "appt_kind": "consultation"}, {"_id": 0, "doctor_id": 1},
        ).sort("created_at", -1).to_list(1)
        doctor_id = first[0].get("doctor_id") if first else None
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0}) if doctor_id else None
    if not doctor:
        raise HTTPException(status_code=400, detail="No consultant found for this patient")

    slot_time = f"{payload.date}T{payload.time}"
    clash = await v3_col("appointments").find_one(
        {"doctor_id": doctor["id"], "slot_time": slot_time, "status": "new_appointment", "lead_id": {"$ne": lead_id}},
        {"_id": 0, "lead_name": 1},
    )
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"{payload.time} is already booked with {doctor['full_name']}"
                   + (f" for {clash.get('lead_name')}" if clash.get("lead_name") else ""),
        )

    now = now_iso()
    appt_fields = {
        "branch_id": lead.get("branch_id"),
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
        "lead_id": lead_id,
        "lead_name": lead.get("name"),
        "patient_name": lead.get("name"),
        "appointment_date": payload.date,
        "appointment_time": payload.time,
        "slot_time": slot_time,
        "duration": 30,
        "meet_link": (doctor.get("meet_link") or "").strip(),
        "status": "new_appointment",
        "appt_kind": "rehab_consultation",
        "updated_at": now,
    }
    existing = await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "rehab_consultation", "status": "new_appointment"}, {"_id": 0, "id": 1},
    )
    if existing:
        await v3_col("appointments").update_one({"id": existing["id"]}, {"$set": appt_fields})
    else:
        await v3_col("appointments").insert_one({
            **appt_fields,
            "id": str(uuid.uuid4()),
            "notes": "",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
        })

    moved = bool(lead.get("rehab_consult_date"))
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "rehab_consult_date": payload.date,
        "rehab_consult_time": payload.time,
        "rehab_consult_doctor_id": doctor["id"],
        "rehab_consult_doctor_name": doctor["full_name"],
        "rehab_consult_remarks": (payload.remarks or "").strip(),
        "rehab_consult_booked_at": now,
        "updated_at": now,
    }})
    verb = "moved to" if moved else "booked for"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "rehab_consultation_booked",
        "details": f"Rehab consultation {verb} {payload.date} at {payload.time} with {doctor['full_name']}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Rehab consultation booked", "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/rehab-consultation/complete", response_model=dict)
async def hp_complete_rehab_consultation(
    lead_id: str,
    payload: V3RehabConsultCompleteInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    """The Consultant's side of the Rehab consultation: the package, chosen now.

    This is what puts the patient on Rehab. rehab_referred and the package go on together,
    which is exactly the state Move to Admin leaves a patient referred to Rehab in -- so the
    branch's Rehab pill, the Rehab Fee and assign-rehab all take it from here unchanged.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not lead.get("rehab_after_treatment"):
        raise HTTPException(status_code=400, detail="This patient was not marked for Rehab after Treatment")
    if lead.get("rehab_consulted_at"):
        raise HTTPException(status_code=400, detail="The Rehab consultation has already been done")
    if not lead.get("rehab_consult_date"):
        raise HTTPException(status_code=400, detail="Book the Rehab consultation first")

    mode = payload.mode if payload.mode in ("online", "offline") else (lead.get("session_package_mode") or "offline")
    rehab_fields, rehab_detail = await _rehab_package_fields(payload.rehab_item_id, mode, lead.get("branch_id"))
    now = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        **rehab_fields,
        "rehab_referred": True,
        "rehab_consulted_at": now,
        "rehab_consulted_by": user.full_name,
        "updated_at": now,
    }})
    await v3_col("appointments").update_many(
        {"lead_id": lead_id, "appt_kind": "rehab_consultation", "status": "new_appointment"},
        {"$set": {"status": "completed", "updated_at": now}},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "rehab_consultation_completed",
        "details": f"Rehab consultation done{rehab_detail}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Rehab package chosen", "lead": V3LeadOut(**updated).model_dump()}


def _physio_handover(lead: dict, new_physio_id: str, user: V3UserOut, now: str) -> dict:
    """The `$push` that closes the outgoing physio's spell with this patient.

    A reassignment is not a correction — the physio being replaced ran real treatment days,
    and the card that shows the new one has to be able to show what the last one got
    through first. The days themselves stay in `sessions` under the physio_id of whoever
    ran them, so the progress is still derived; what cannot be derived is a physio replaced
    before completing anything, whose upcoming days are deleted on the way out. This entry
    is what keeps that spell on the record.

    Empty when nothing changed hands — a first assignment, or a re-book with the same
    physio, which is a reschedule rather than a handover.

    The stage is what says whether there was anything to hand over. assigned_physio_id is
    written when the consultation appointment is booked, long before anyone picks who will
    deliver the treatment, so on its own it would read every first assignment as a
    reassignment away from the physio who merely took the consultation. Only a lead already
    at Physio Assign has a treatment physio to replace — see the note on the Fee Collected
    panel's Assign Physio button, which draws its label off the same test.
    """
    if lead.get("consultation_stage") != "Physio Assign":
        return {}
    previous_id = lead.get("assigned_physio_id")
    if not previous_id or previous_id == new_physio_id:
        return {}
    return {"$push": {"physio_assignment_history": {
        "physio_id": previous_id,
        "physio_name": lead.get("assigned_physio_name") or "",
        "assigned_at": lead.get("physio_assigned_at"),
        "ended_at": now,
        "replaced_by_id": new_physio_id,
        "handed_over_by": user.full_name,
        "handed_over_by_role": user.role,
    }}}


@router.post("/leads/{lead_id}/assign-consultation-physio")
async def hp_assign_consultation_physio(
    lead_id: str,
    payload: V3ConsultationPhysioAssignInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin")),
):
    """Branch Admin picks the physio who will deliver the assigned package's
    treatment sessions — the last step in the Consultations pipeline. The lead
    rests at 'Fee Collected' once both fees are paid; this call is what actually
    advances it to 'Physio Assign'. Also callable while already at 'Physio Assign'
    for reassigning to a different physio."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("consultation_stage") not in ("Fee Collected", "Physio Assign") or lead.get("treatment_fee_paid") is None:
        raise HTTPException(status_code=400, detail="A physio can only be assigned after the Treatment Fee has been collected")
    physio = await v3_col("doctors").find_one(
        {"id": payload.physio_id, "profile_type": "physio"}, {"_id": 0}
    )
    if not physio:
        raise HTTPException(status_code=404, detail="Physio not found")

    now = now_iso()
    handover = _physio_handover(lead, physio["id"], user, now)
    await v3_col("leads").update_one({"id": lead_id}, {
        "$set": {
            "assigned_physio_id": physio["id"],
            "assigned_physio_name": physio["full_name"],
            "physio_assigned_at": now,
            "consultation_stage": "Physio Assign",
            "updated_at": now,
        },
        **handover,
    })
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_physio_assigned",
        "details": (
            f"Reassigned from {lead.get('assigned_physio_name')} to {physio['full_name']}"
            if handover else
            f"Assigned {physio['full_name']} to deliver treatment sessions"
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {"message": "Physio assigned", "lead": V3LeadOut(**updated).model_dump()}


@router.post("/leads/{lead_id}/assign-physio-sessions")
async def hp_assign_physio_with_sessions(
    lead_id: str,
    payload: V3AssignPhysioSessionsInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Branch Admin picks the physio AND books every one of the patient's paid
    session-package sessions against that physio's own calendar (Consultations >
    Physio Calendar), in one step — same eligibility guard as
    assign-consultation-physio, but this is what actually turns the paid session
    count into real, dated `sessions` records rather than just a label."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if lead.get("consultation_stage") not in ("Fee Collected", "Physio Assign") or lead.get("treatment_fee_paid") is None:
        raise HTTPException(status_code=400, detail="A physio can only be assigned after the Treatment Fee has been collected")

    total_sessions = lead.get("session_package_sessions")
    if not total_sessions:
        raise HTTPException(status_code=400, detail="This lead has no session package to schedule")

    # Days already worked are neither re-bookable nor gone. A mid-course reassignment has
    # only the rest of the course left to place: this asked for the whole package again
    # while the completed days stayed on file under the physio who ran them, so a
    # 12-session patient moved after day 5 came out of it holding 17 treatment days — and
    # the progress the boards read off those rows said "5 of 17".
    done = await v3_col("sessions").count_documents({"lead_id": lead_id, "status": "completed"})
    to_book = total_sessions - done
    if to_book <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"All {total_sessions} treatment days are already completed — there is nothing left to book",
        )

    sorted_slots = sorted(set(payload.slot_times))
    if len(sorted_slots) != len(payload.slot_times):
        raise HTTPException(status_code=400, detail="Duplicate session slot times were submitted")
    if len(sorted_slots) != to_book:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Pick exactly {to_book} session slots (got {len(sorted_slots)})"
                + (f" — {done} of {total_sessions} days are already completed" if done else "")
            ),
        )

    physio = await v3_col("doctors").find_one({"id": payload.physio_id, "profile_type": "physio"}, {"_id": 0})
    if not physio:
        raise HTTPException(status_code=404, detail="Physio not found")

    # A physio runs a floor — two or three patients share a slot — so a slot is only
    # unavailable once it is FULL. This used to reject on a single existing booking, which
    # made the second and third patient of every hour unbookable.
    #
    # Counted through the shared helper, which reads the physio's rehab days as well as
    # their treatment days. This side used to count `sessions` alone, so a physio's rehab
    # course was invisible here and a slot already holding three rehab patients still
    # accepted three more treatment ones — while the picker, reading both off
    # get_doctor_calendar, had drawn that same slot full.
    #
    # This lead's own sessions are discounted rather than deleted first. Deleting first
    # answered "a re-assignment must not clash with itself" by destroying the schedule
    # before anything had agreed to replace it: every refusal below returned 400 with the
    # patient's existing sessions already gone from the physio's calendar.
    # A day on a date the physio has said they will not be in is booked straight into the
    # problem v3_physio_absence exists to clear up.
    from routers.v3_physio_absence import refuse_if_physio_absent
    await refuse_if_physio_absent(payload.physio_id, sorted_slots)

    capacity = slot_capacity_of(physio)
    taken, lead_elsewhere = await physio_slot_load(
        payload.physio_id, sorted_slots, lead_id=lead_id, replacing="sessions",
    )

    # A rehab day of this patient's own is not a seat to book beside — it is this patient,
    # already spoken for at that hour. Named plainly, because "full" would send the branch
    # looking for someone else's booking that isn't there.
    clashing = sorted(s for s in sorted_slots if s in lead_elsewhere)
    if clashing:
        what = lead_elsewhere[clashing[0]]
        raise HTTPException(
            status_code=400,
            detail=f"{lead.get('name', 'This patient')} already has a {what} at: {', '.join(clashing)}",
        )

    full = sorted(s for s in sorted_slots if taken.get(s, 0) >= capacity)
    if full:
        raise HTTPException(
            status_code=400,
            detail=f"Full for this physio ({capacity} per slot): {', '.join(full)}",
        )

    # Past every refusal: the old set can go now, and the new one replaces it.
    await v3_col("sessions").delete_many({"lead_id": lead_id, "status": "upcoming"})

    # Where the course left off, so what is booked now carries on from it instead of
    # restarting. Day numbers drive the in-order completion guard and the "Day 3 of 9" the
    # physio's board reads; week numbers key the weekly assessments, and a second week 1
    # would land the new physio's first review on top of the old one's.
    prior_weeks = 0
    if done:
        last_done = await v3_col("sessions").find(
            {"lead_id": lead_id, "status": "completed"}, {"_id": 0, "week_number": 1},
        ).sort("week_number", -1).limit(1).to_list(1)
        prior_weeks = (last_done[0].get("week_number") or 0) if last_done else 0

    now = now_iso()
    first_date = date.fromisoformat(sorted_slots[0].split("T")[0])
    session_docs = []
    for i, slot_time in enumerate(sorted_slots):
        this_date = date.fromisoformat(slot_time.split("T")[0])
        session_docs.append({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "lead_name": lead.get("name", "Unknown"),
            "branch_id": lead.get("branch_id") or user.branch_id,
            "physio_id": physio["id"],
            # Written down, not only pointed at. The Physio Assign card lists every physio a
            # patient has been through, and a name resolved per row out of `doctors` is a
            # lookup per spell for something that cannot change after the day it was booked.
            "physio_name": physio["full_name"],
            "session_number": done + i + 1,
            "total_sessions": total_sessions,
            "week_number": prior_weeks + (this_date - first_date).days // 7 + 1,
            "slot_time": slot_time,
            "status": "upcoming",
            "created_at": now,
        })
    await v3_col("sessions").insert_many([d.copy() for d in session_docs])

    handover = _physio_handover(lead, physio["id"], user, now)
    await v3_col("leads").update_one({"id": lead_id}, {
        "$set": {
            "assigned_physio_id": physio["id"],
            "assigned_physio_name": physio["full_name"],
            "physio_assigned_at": now,
            "consultation_stage": "Physio Assign",
            "updated_at": now,
        },
        **handover,
    })
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_physio_assigned",
        "details": (
            f"Reassigned from {lead.get('assigned_physio_name')} to {physio['full_name']} — "
            f"{done} of {total_sessions} days already completed, {len(session_docs)} rebooked"
            if handover else
            "Assigned " + physio["full_name"] + " and booked " + (
                f"all {total_sessions} sessions" if not done
                else f"the remaining {len(session_docs)} of {total_sessions} sessions"
            )
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })

    # Treatment is booked, so the patient gets their Client Portal login now — made and
    # emailed on its own, and never able to fail the booking it follows. A patient who
    # already has one (a reassignment, a rebooking) is left exactly as they are.
    # Imported here rather than at the top: the portal router pulls in several others.
    from routers.v3_patient_portal import auto_portal_login_for_treatment
    portal = await auto_portal_login_for_treatment(lead_id, user)

    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {
        "message": "Physio assigned and sessions booked",
        "lead": V3LeadOut(**updated).model_dump(),
        "sessions_booked": len(session_docs),
        "sessions_already_completed": done,
        "portal": portal,
    }


def _blank_spell(physio_id: str) -> dict:
    """A spell nobody completed a day in. Zeroes rather than absence: the physio held the
    patient, they just have nothing to show for it, and a card that dropped them would tell
    the branch the handover never happened."""
    return {
        "physio_id": physio_id,
        "physio_name": "",
        "sessions_assigned": 0,
        "sessions_completed": 0,
        "sessions_upcoming": 0,
        "first_day": None,
        "last_day": None,
        "first_session_at": None,
        "last_session_at": None,
        "last_completed_at": None,
    }


@router.get("/leads/{lead_id}/physio-progress")
async def hp_lead_physio_progress(
    lead_id: str,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Every physio this patient's treatment has been through, and how far each one got.

    What the Physio Assign card reads. `previous` is oldest first and `current` is the
    physio the patient is with now, so the card shows the spell that ended before the spell
    that is running — a reassignment mid-course leaves real completed days behind it, and
    the branch has to see those before it reads the new physio's.

    The counts are derived from the days themselves rather than kept on the lead: a
    completed day keeps the physio_id of whoever ran it, so grouping the collection by that
    field is the honest answer to how many each of them did. `physio_assignment_history`
    supplies only the chronology, and the physios whose spell ended with nothing completed
    — their upcoming days are deleted on handover and would otherwise leave no trace.

    One row per physio, not per spell: a patient handed back to someone they were already
    with reads as one spell spanning both, because their completed days cannot be told
    apart afterwards anyway.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    rows = await v3_col("sessions").find(
        {"lead_id": lead_id},
        {"_id": 0, "physio_id": 1, "physio_name": 1, "session_number": 1, "slot_time": 1,
         "status": 1, "completed_at": 1, "week_number": 1},
    ).sort("session_number", 1).to_list(1000)

    by_physio: dict = {}
    for row in rows:
        physio_id = row.get("physio_id") or ""
        if not physio_id:
            continue
        spell = by_physio.get(physio_id) or _blank_spell(physio_id)
        by_physio[physio_id] = spell
        spell["physio_name"] = spell["physio_name"] or (row.get("physio_name") or "")
        spell["sessions_assigned"] += 1
        completed = row.get("status") == "completed"
        spell["sessions_completed" if completed else "sessions_upcoming"] += 1

        number = row.get("session_number")
        if number:
            spell["first_day"] = number if spell["first_day"] is None else min(spell["first_day"], number)
            spell["last_day"] = number if spell["last_day"] is None else max(spell["last_day"], number)
        # A day still waiting on a date from the Branch Admin carries no slot_time, and the
        # empty string would sort ahead of every real date as this spell's first day.
        slot = (row.get("slot_time") or "").strip()
        if slot:
            spell["first_session_at"] = slot if not spell["first_session_at"] else min(spell["first_session_at"], slot)
            spell["last_session_at"] = slot if not spell["last_session_at"] else max(spell["last_session_at"], slot)
        if completed and row.get("completed_at"):
            spell["last_completed_at"] = max(spell["last_completed_at"] or "", row["completed_at"])

    # The chronology, deduplicated to one entry per physio: earliest start, latest end.
    history_by_physio: dict = {}
    order: list = []
    for entry in (lead.get("physio_assignment_history") or []):
        physio_id = entry.get("physio_id")
        if not physio_id:
            continue
        held = history_by_physio.get(physio_id)
        if held is None:
            history_by_physio[physio_id] = dict(entry)
            order.append(physio_id)
            continue
        if (entry.get("assigned_at") or "") and (not held.get("assigned_at") or entry["assigned_at"] < held["assigned_at"]):
            held["assigned_at"] = entry["assigned_at"]
        if (entry.get("ended_at") or "") > (held.get("ended_at") or ""):
            held["ended_at"] = entry["ended_at"]
            held["handed_over_by"] = entry.get("handed_over_by") or held.get("handed_over_by")

    # Same test as the handover above: before Physio Assign, assigned_physio_id is the
    # physio who took the consultation, not one who owes this patient any treatment days.
    current_id = (lead.get("assigned_physio_id") or "") if lead.get("consultation_stage") == "Physio Assign" else ""
    # Days belonging to a physio the history never recorded — a lead assigned before this
    # was kept, or one whose sessions were written by the older branch assign path. They
    # come after the recorded spells and before the current physio, in day order.
    unrecorded = sorted(
        (pid for pid in by_physio if pid not in history_by_physio and pid != current_id),
        key=lambda pid: by_physio[pid]["first_day"] or 0,
    )

    previous = []
    for physio_id in [*order, *unrecorded]:
        if physio_id == current_id:
            continue
        entry = history_by_physio.get(physio_id, {})
        spell = by_physio.get(physio_id) or _blank_spell(physio_id)
        previous.append({
            **spell,
            "physio_name": spell["physio_name"] or entry.get("physio_name") or "",
            "assigned_at": entry.get("assigned_at"),
            "ended_at": entry.get("ended_at"),
            "handed_over_by": entry.get("handed_over_by") or "",
            "is_current": False,
        })

    current = None
    if current_id:
        spell = by_physio.get(current_id) or _blank_spell(current_id)
        current = {
            **spell,
            "physio_name": spell["physio_name"] or lead.get("assigned_physio_name") or "",
            "assigned_at": lead.get("physio_assigned_at"),
            "ended_at": None,
            "handed_over_by": "",
            "is_current": True,
        }

    # Rows booked before physio_name was written onto them have only an id. One lookup for
    # all of them rather than one per spell.
    nameless = [s["physio_id"] for s in [*previous, *([current] if current else [])] if not s["physio_name"]]
    if nameless:
        found = await v3_col("doctors").find(
            {"id": {"$in": nameless}}, {"_id": 0, "id": 1, "full_name": 1},
        ).to_list(50)
        names = {d["id"]: d.get("full_name") or "" for d in found}
        for spell in [*previous, *([current] if current else [])]:
            spell["physio_name"] = spell["physio_name"] or names.get(spell["physio_id"]) or "Unknown physio"

    completed_sessions = sum(1 for r in rows if r.get("status") == "completed")
    # The last week the patient actually worked, so a picker placing the rest of the course
    # can go on numbering from it rather than opening a second Week 1 beside the first.
    weeks_completed = max(
        (r.get("week_number") or 0 for r in rows if r.get("status") == "completed"),
        default=0,
    )
    # What was sold and what is on the calendar are two different numbers, and they only
    # agree while the course is intact. Both are returned rather than one reconciled guess:
    # a patient reassigned before this booked the rest of their course instead of all of it
    # can hold more days than the package sold, and the card has to be able to say so.
    package_sessions = lead.get("session_package_sessions") or 0
    return {
        "lead_id": lead_id,
        "package_name": lead.get("session_package_name") or "",
        "package_sessions": package_sessions,
        "booked_sessions": len(rows),
        "completed_sessions": completed_sessions,
        "weeks_completed": weeks_completed,
        "remaining_sessions": max(0, (package_sessions or len(rows)) - completed_sessions),
        "reassigned": len(previous) > 0,
        "current": current,
        "previous": previous,
    }


# ---------------------------------------------------------------------------
# Handing a consultation to somebody else
#
# A Super Admin can now take consultations (see ensure_super_admin_consultant), which
# raises the question the booking screens cannot answer: a patient is already booked with
# one consultant and should be seen by another. Rescheduling is the only existing way to
# change that, and it asks for a new date, a new time and a reason -- the whole
# appointment -- when the only thing actually changing is who takes it. A patient happy
# with their Tuesday 11:45 should not have to be moved off it to be seen by someone else.
# ---------------------------------------------------------------------------


class ReassignConsultantInput(BaseModel):
    lead_ids: List[str]
    # Left empty means "to me" -- the common case, and the one that must not require the
    # caller to first go and look up their own consultant id.
    consultant_id: Optional[str] = None
    reason: Optional[str] = ""


async def _live_consultation_appt(lead_id: str) -> Optional[dict]:
    """The consultation booking a lead is actually sitting on.

    Newest first: a rescheduled patient can have older rows behind them, and the one that
    matters is the one their consultant is about to work.
    """
    return await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "consultation", "status": "new_appointment"},
        {"_id": 0},
        sort=[("slot_time", -1)],
    )


@router.get("/consultations/{branch_id}/consultants")
async def list_branch_consultants(
    branch_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin")),
):
    """Who can be handed a consultation at this branch.

    Not available-experts: that one takes a date and drops anyone with no open slot on it,
    which is the right question when booking a NEW appointment and the wrong one here. A
    reassignment keeps the slot the patient already has, so what matters is who is allowed
    to work this branch, not who published hours on some particular day.

    The caller's own record is minted if they have none, so a Super Admin can hand a
    patient to themselves on the first try rather than on the second.
    """
    if user.role == "super_admin":
        await ensure_super_admin_consultant(user)
    rows = await v3_col("doctors").find(
        active_doctor_query({"profile_type": "head_physio"}),
        {"_id": 0, "id": 1, "full_name": 1, "user_id": 1, "profile_type": 1,
         "branch_id": 1, "is_super_admin": 1, "specialization": 1},
    ).to_list(500)
    rows = await consultants_serving_branch(rows, branch_id)
    # The Super Admin first, then everyone alphabetically. Whoever reads this list is
    # usually reaching for themselves, and a name that moves around as staff are hired is
    # a name that has to be hunted for every time.
    rows.sort(key=lambda d: (not d.get("is_super_admin"), (d.get("full_name") or "").lower()))
    return {
        "consultants": [
            {
                "id": d.get("id", ""),
                "full_name": d.get("full_name") or "",
                "specialization": d.get("specialization") or "",
                "is_super_admin": bool(d.get("is_super_admin")),
                "is_me": d.get("user_id") == user.id,
            }
            for d in rows
        ]
    }


@router.post("/consultations/reassign-consultant")
async def reassign_consultant(
    payload: ReassignConsultantInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin")),
):
    """Move the chosen patients onto another consultant, keeping the slot they are on.

    Super Admin only, and deliberately so: this overrides a booking somebody else made,
    across branches, in bulk. A Branch Admin moving a patient between consultants still
    goes through Reschedule, where the time is on the table too.

    The target does NOT have to have published the slot. Requiring it would make this
    useless for exactly the person it was built for -- a Super Admin publishes no hours --
    and a reassignment is an instruction from the top of the building, not a booking
    request. What is still refused is a genuine clash: a consultant already seeing another
    patient at that minute is not free, however senior the person asking. Those come back
    named rather than silently dropped, so the caller can see what did not move and why.

    `meet_link` moves with it. The room is copied onto the appointment at booking and
    frozen on purpose -- an expert changing rooms does not move meetings already arranged
    -- but this is the case that reasoning does not cover: the expert themselves changed,
    and leaving the old link would send the patient to a room where nobody expects them.
    """
    if not payload.lead_ids:
        raise HTTPException(status_code=400, detail="Pick at least one patient")

    if payload.consultant_id:
        target = await v3_col("doctors").find_one(
            {"id": payload.consultant_id, "profile_type": "head_physio"}, {"_id": 0},
        )
        if not target:
            raise HTTPException(status_code=404, detail="CONSULTANT not found")
    else:
        target = await ensure_super_admin_consultant(user)
        if not target:
            raise HTTPException(status_code=400, detail="No consultant record for this login")

    target_name = target.get("full_name") or ""
    capacity = slot_capacity_of(target)
    stamp = now_iso()
    moved, skipped = [], []

    for lead_id in payload.lead_ids:
        lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
        if not lead:
            skipped.append({"lead_id": lead_id, "name": "", "reason": "Patient not found"})
            continue
        name = lead.get("name") or ""
        appt = await _live_consultation_appt(lead_id)
        if not appt:
            skipped.append({"lead_id": lead_id, "name": name,
                            "reason": "No live consultation booking to move"})
            continue
        if appt.get("doctor_id") == target["id"]:
            skipped.append({"lead_id": lead_id, "name": name,
                            "reason": "Already with " + target_name})
            continue

        # Is the target already seeing somebody else at that minute? Counted rather than
        # merely looked for, because slot_capacity_of is what decides how many one desk
        # holds in a slot -- 1 for a consultation, which is a conversation, not a floor.
        clash = await v3_col("appointments").count_documents({
            "doctor_id": target["id"],
            "slot_time": appt.get("slot_time"),
            "appt_kind": "consultation",
            "status": "new_appointment",
            "lead_id": {"$ne": lead_id},
        })
        if clash >= capacity:
            when = appt.get("appointment_time") or appt.get("slot_time") or ""
            skipped.append({
                "lead_id": lead_id,
                "name": name,
                "reason": target_name + " is already booked at " + str(when),
            })
            continue

        await v3_col("appointments").update_one({"id": appt["id"]}, {"$set": {
            "doctor_id": target["id"],
            "doctor_name": target_name,
            "meet_link": (target.get("meet_link") or "").strip(),
            "updated_at": stamp,
        }})
        await v3_col("leads").update_one({"id": lead_id}, {"$set": {
            "assigned_physio_id": target["id"],
            "assigned_physio_name": target_name,
            "updated_at": stamp,
        }})
        was = appt.get("doctor_name") or "nobody"
        note = "Consultation moved from " + was + " to " + target_name
        if (payload.reason or "").strip():
            note += ". Reason: " + payload.reason.strip()
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "action": "consultant_reassigned",
            "details": note,
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": stamp,
        })
        moved.append({"lead_id": lead_id, "name": name, "from": was})

    return {
        "moved": moved,
        "skipped": skipped,
        "consultant": {
            "id": target["id"],
            "full_name": target_name,
            "is_super_admin": bool(target.get("is_super_admin")),
        },
    }
