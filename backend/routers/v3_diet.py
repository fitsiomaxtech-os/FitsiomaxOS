"""Diet Consultation — the third service vertical, alongside Consultations and Sessions.

Shaped deliberately like the physio side, because it is the same pattern a third time:

    Head Physio  -> consultation      -> `appointments`
    Physio       -> treatment days    -> `sessions`
    Nutrition Coach -> check-in days  -> `diet_sessions`     <- this file

One Nutrition Coach does both halves — the diet consultation AND the check-in days that
follow it. That is the one place diet departs from physio, where a senior consults and a
junior delivers. It has a consequence: there is no senior above the coach, so there is no
review chain here, and none is faked.

WHY diet check-ins live in their own collection, not in `sessions` with a discriminator:

`sessions` is read in several places by physio_id or lead_id with no filter on what kind
of session a row is. The clearest is v3_reviews._treatment_days, which counts the days a
lead has attended on to decide when a physio is due a review — diet rows landing there
would put a check-in day towards a physio's review week. The
physio calendar, the treatment-day grid and the Physio Master View counts read it the same
way. Adding a `track` field would mean auditing every one of those and every query written
after today. A separate collection makes that mistake impossible rather than merely
avoided, which matters because v3_reviews' own module docstring records that this exact
class of mistake in this exact collection has already taken the OS down once.
"""

from fastapi import APIRouter, HTTPException, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import os
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time, slot_capacity_of, active_doctor_query, ACTIVE_DOCTOR
from security import hash_password
from deps import v3_require_roles, v3_require_diet, is_diet_role, works_org_wide
from routers.v3_lead_documents import (
    ALLOWED_EXTENSIONS,
    DIET_CHART,
    DOC_DIR,
    store_upload,
)
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3")

COACH = "nutrition_coach"


async def _resolve_coach(user: V3UserOut, coach_id: Optional[str] = None) -> Optional[dict]:
    """The doctors record for the logged-in Nutrition Coach.

    Same three-step resolution the physio board uses: a coach created here is linked by
    user_id, one hired through HR is linked only by employee_id, and a desk driving a
    specific coach's board from Operations passes the id outright — a branch can have
    several coaches, so branch_id alone would not disambiguate.

    If none of those find one, it creates it. That is a write in a read path and is
    deliberate: the record is derived — a calendar holder, not business data — and its
    absence is a setup gap the coach cannot fix from any screen they can reach. Anyone
    hired under a diet role before HR knew to create one logs in to a permanently empty
    board otherwise, which is exactly what happened to this install's diet_manage user.
    """
    if coach_id and works_org_wide(user.role):
        doctor = await v3_col("doctors").find_one({"id": coach_id, "profile_type": COACH}, {"_id": 0})
        if doctor:
            return doctor
    # A record for a branch they still work first, then any of them.
    #
    # A coach unticked from a branch keeps the record for it, stood down rather than
    # deleted, so the days already published there and the patients booked into them
    # survive (see _sync_expert_branches in routers/v3_hr.py). "Any" matched first before
    # that existed, which would have opened the coach's own board on whichever record came
    # back first — sometimes a branch they no longer work, whose calendar nobody can see.
    #
    # The unfiltered pass is still here and still second, and is what makes this safe to
    # narrow: it is the coach's OWN board, so returning a stood-down record is better than
    # returning nothing, and a coach posted nowhere still gets the calendar they had.
    for scope in (ACTIVE_DOCTOR, {}):
        doctor = await v3_col("doctors").find_one({"user_id": user.id, "profile_type": COACH, **scope}, {"_id": 0})
        if doctor:
            return doctor
    raw = await v3_col("users").find_one({"id": user.id}, {"_id": 0, "employee_id": 1, "branch_id": 1, "full_name": 1})
    if raw and raw.get("employee_id"):
        for scope in ({"is_active": {"$ne": False}}, {}):
            doctor = await v3_col("doctors").find_one(
                {"employee_id": raw["employee_id"], "profile_type": COACH, **scope}, {"_id": 0}
            )
            if doctor:
                return doctor

    if not is_diet_role(user.role) or user.role == "super_admin":
        return None
    doctor = {
        "id": str(uuid.uuid4()),
        "user_id": user.id,
        "full_name": user.full_name or (raw or {}).get("full_name", ""),
        "profile_type": COACH,
        "branch_id": user.branch_id or (raw or {}).get("branch_id"),
        "specialization": "",
        "slots": [],
        "slot_details": [],
        "created_at": now_iso(),
    }
    await v3_col("doctors").insert_one(doctor.copy())
    doctor.pop("_id", None)
    return doctor


async def _coach_branch_ids(coach: dict) -> list:
    """Every branch this coach covers, or an empty list meaning all of them.

    Read off the user rather than off the doctors record they were resolved through. A
    coach who covers several branches holds one `doctors` row per branch, and
    _resolve_coach returns whichever one it found first — so that row's branch_id is one
    of their branches arbitrarily, not the set of them. Filtering a queue on it showed an
    all-branches Nutritionist a single branch, and not reliably the same one.

    Empty means unrestricted, which is what a Nutritionist covering everything carries: no
    branch_ids to narrow by, so nothing is narrowed.
    """
    user_id = coach.get("user_id")
    if user_id:
        u = await v3_col("users").find_one({"id": user_id}, {"_id": 0, "branch_ids": 1, "branch_id": 1})
        if u:
            ids = [b for b in (u.get("branch_ids") or []) if b]
            if ids:
                return ids
            # Older accounts predate branch_ids and carry the single field only.
            if u.get("branch_id"):
                return [u["branch_id"]]
            return []
    return [coach["branch_id"]] if coach.get("branch_id") else []


async def _coach_record_ids(coach: dict) -> list:
    """Every `doctors` row this one person holds, not just the one they resolved through.

    A Nutritionist is several records. They hold one per branch since they became
    multi-branch, and a row created before the user link existed carries no user_id at all,
    so the HR branch sync cannot see it and adds another beside it — list_nutrition_coaches
    above exists entirely to fold those back into one name in the picker.

    Which record a patient is filed under is therefore decided by whoever assigned them:
    the picker hands the Branch Admin the row with the most published slots, and
    `diet_coach_id` is set to that. The coach's own board resolves a row separately, by
    find_one on user_id, which is whichever active row comes back first — and can never be
    a legacy row with no user_id at all.

    When those two disagree the patient vanishes. `diet_coach_id` is set, so they are not
    unassigned and the "nobody has taken this" arm does not catch them either; they are
    simply filed under a record their own coach's queue is not asking about. Assigning a
    patient made them disappear, which is the opposite of what assigning is for.

    So every read of "this coach's patients" asks about all of their records. Matched on
    the login and the employee link, and by name ONLY for rows carrying no login — that is
    exactly the legacy row this exists to catch, and it stops short of merging two
    genuinely different coaches who happen to share a name, which matching on name alone
    would do.
    """
    ors = []
    if coach.get("user_id"):
        ors.append({"user_id": coach["user_id"]})
    if coach.get("employee_id"):
        ors.append({"employee_id": coach["employee_id"]})
    name = (coach.get("full_name") or "").strip()
    if name:
        # A null match in Mongo also catches the field being absent, which is how the
        # oldest of these rows are written.
        ors.append({"full_name": name, "user_id": {"$in": [None, ""]}})
    if not ors:
        return [coach["id"]]
    rows = await v3_col("doctors").find(
        {"profile_type": COACH, "$or": ors}, {"_id": 0, "id": 1}
    ).to_list(200)
    # The resolved row is always in the answer, even if the query above somehow misses it:
    # a read that returned nothing for the coach standing in front of it would be a worse
    # failure than the one this fixes.
    return sorted({coach["id"], *(r["id"] for r in rows)})


# ============ Branch Admin: staffing ============

class CreateCoachInput(BaseModel):
    full_name: str
    email: str
    password: str
    specialization: Optional[str] = ""


@router.post("/branch/nutrition-coaches")
async def create_nutrition_coach(
    payload: CreateCoachInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin")),
):
    """A coach is two records that must both exist: a `users` row so they can log in, and a
    `doctors` row so they can hold a calendar. Created together and linked by user_id, so
    neither can be left orphaned by a half-finished setup."""
    branch_id = user.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="No branch assigned")

    email = payload.email.lower().strip()
    if await v3_col("users").find_one({"email": email}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="User with this email already exists")

    user_id = str(uuid.uuid4())
    doctor_id = str(uuid.uuid4())
    now = now_iso()

    await v3_col("users").insert_one({
        "id": user_id,
        "full_name": payload.full_name.strip(),
        "email": email,
        "password": hash_password(payload.password),
        "role": COACH,
        "branch_id": branch_id,
        "is_active": True,
        "created_at": now,
    })
    await v3_col("doctors").insert_one({
        "id": doctor_id,
        "user_id": user_id,
        "full_name": payload.full_name.strip(),
        "profile_type": COACH,
        "branch_id": branch_id,
        "specialization": (payload.specialization or "").strip(),
        "slots": [],
        "slot_details": [],
        "created_at": now,
    })
    return {"user_id": user_id, "doctor_id": doctor_id, "full_name": payload.full_name.strip()}


@router.get("/branch/nutrition-coaches")
async def list_nutrition_coaches(user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", COACH))):
    query = {"profile_type": COACH}
    if user.branch_id:
        # A Nutritionist set to All Branches is stored branchless — that is how this OS
        # spells "every branch" for a desk that may legitimately hold none, and both
        # ORG_WIDE_PROFILES in routers/v3_config.py and _coach_branch_ids above already
        # read it that way. This listing did not, so it filtered them out: HR would show
        # the coach on All Branches while every Branch Admin's Diet Appointment popup said
        # there was no Nutritionist at this branch at all, with nothing to explain the gap.
        #
        # Scoped to this profile_type only, so the reach stays where it is meant to be: a
        # branchless physio record is a gap in the data, not a licence to appear on every
        # branch, which is the same line v3_get_doctors draws.
        query["$or"] = [
            {"branch_id": user.branch_id},
            {"branch_id": {"$in": [None, ""]}},
        ]
    coaches = await v3_col("doctors").find(active_doctor_query(query), {"_id": 0}).sort("full_name", 1).to_list(200)

    # One row per person, not one per expert record.
    #
    # A coach can hold several `doctors` rows — one per branch since they became
    # multi-branch — and a row created before that link existed carries no user_id, so the
    # branch sync in HR cannot see it and adds another for the same branch. The picker then
    # offers the same name twice with no way to tell which is which.
    #
    # Collapsed on the name, not on user_id: the pair this exists to merge is exactly one
    # linked row and one legacy row without a user_id, so keying on that id gives them
    # different keys and merges nothing. The query above reaches one branch and the
    # branchless rows that cover every branch, which is a narrow enough set for a name to
    # be safe to key on — and it now also folds a coach who holds both kinds of row into
    # the single person they are, rather than offering them twice.
    #
    # Two genuinely different coaches sharing a name in one branch would merge — but this
    # picker shows the name and nothing else, so they are already indistinguishable in it;
    # nothing legible is lost that was not already lost.
    #
    # The row kept is the one carrying the most published slots, and a linked row wins a
    # tie: the other is the empty duplicate, and picking it books a patient onto a calendar
    # with nothing in it.
    def rank(c):
        return (len(c.get("slots") or []), 1 if c.get("user_id") else 0)

    best = {}
    for c in coaches:
        key = (c.get("full_name") or "").strip().lower() or c.get("id")
        seen = best.get(key)
        if not seen or rank(c) > rank(seen):
            best[key] = c
    return {"coaches": sorted(best.values(), key=lambda c: (c.get("full_name") or "").lower())}


# ============ Branch Admin: putting a patient on a diet plan ============


def _require_diet_fee(lead: dict) -> None:
    """Refuse to put a patient with a Nutritionist until the Diet Consultation Fee is in.

    The order the branch actually works in: the Consultant refers, the Branch Admin
    collects, and only then is a Nutritionist assigned. It was enforced in the Consultations
    panel alone, which offered the fee button first and the assign button after it — and a
    comment there stated that the server refused an unpaid patient, which it did not. Any
    other caller, and the panel itself the moment its own ordering was edited, could book a
    coach's day against a patient who had paid nothing for it.

    Read off diet_fee_paid rather than a stage, because the fee is the only record that
    money changed hands; diet_stage is set by this flow and would be circular.

    Note this is the Diet CONSULTATION fee and not the Diet Chart one. They buy different
    things: a consultation buys the coach's time, which is what is being booked here, and a
    chart buys a document. A patient who bought only a chart is never assigned a day, and
    gating this on the chart fee would refuse the one thing it does pay for.
    """
    if lead.get("diet_fee_paid") is None:
        raise HTTPException(
            status_code=400,
            detail="Collect the Diet Consultation Fee before assigning a Nutritionist",
        )


class AssignDietInput(BaseModel):
    lead_id: str
    coach_id: str
    slot_times: List[str]


@router.post("/branch/assign-diet")
async def assign_diet(
    payload: AssignDietInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin")),
):
    """Put a patient with a Nutrition Coach and book their check-in days.

    Mirrors assign-physio-sessions, including the two things that flow learned the hard
    way: this lead's own upcoming days are cleared first so a re-assignment doesn't clash
    with itself, and a slot is refused only once it is FULL rather than merely occupied.
    """
    lead = await v3_col("leads").find_one({"id": payload.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_diet_fee(lead)

    coach = await v3_col("doctors").find_one({"id": payload.coach_id, "profile_type": COACH}, {"_id": 0})
    if not coach:
        raise HTTPException(status_code=404, detail="Nutritionist not found")

    slots = sorted({normalize_slot_time(s) for s in payload.slot_times})
    if not slots:
        raise HTTPException(status_code=400, detail="Pick at least one check-in day")
    if len(slots) != len(payload.slot_times):
        raise HTTPException(status_code=400, detail="Duplicate check-in times were submitted")

    # Cleared before the conflict check, or this lead's own existing days would read as a
    # clash against themselves on a re-assignment.
    await v3_col("diet_sessions").delete_many({"lead_id": payload.lead_id, "status": "upcoming"})

    capacity = slot_capacity_of(coach)
    booked = await v3_col("diet_sessions").find(
        {"coach_id": payload.coach_id, "status": "upcoming", "slot_time": {"$in": slots}},
        {"_id": 0, "slot_time": 1},
    ).to_list(1000)
    taken: dict = {}
    for b in booked:
        taken[b["slot_time"]] = taken.get(b["slot_time"], 0) + 1
    full = sorted(s for s in slots if taken.get(s, 0) >= capacity)
    if full:
        raise HTTPException(
            status_code=400,
            detail=f"Full for this coach ({capacity} per slot): {', '.join(full)}",
        )

    now = now_iso()
    docs = [{
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "lead_name": lead.get("name", "Unknown"),
        "branch_id": lead.get("branch_id") or user.branch_id,
        "coach_id": coach["id"],
        "coach_name": coach["full_name"],
        "day_number": i + 1,
        "total_days": len(slots),
        "slot_time": slot_time,
        "status": "upcoming",
        "coach_remarks": "",
        "weight_kg": None,
        "created_at": now,
        "updated_at": now,
    } for i, slot_time in enumerate(slots)]
    await v3_col("diet_sessions").insert_many([d.copy() for d in docs])

    await v3_col("leads").update_one(
        {"id": payload.lead_id},
        {"$set": {
            "diet_coach_id": coach["id"],
            "diet_coach_name": coach["full_name"],
            "diet_assigned_at": now,
            "diet_stage": "Diet Plan Assigned",
            # Set here as well as by the Head Physio's decision, because /diet/consultations
            # reads this flag as "is in the diet vertical". A patient the branch books onto
            # a plan afterwards — asked for one later, or was referred by phone — would
            # otherwise hold check-in days with the coach while being absent from the very
            # queue that lists who those days belong to.
            "diet_recommended": True,
            "updated_at": now,
        }},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "action": "diet_coach_assigned",
        "details": f"{coach['full_name']} assigned with {len(slots)} check-in days",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"days_booked": len(docs), "coach_name": coach["full_name"]}


class DietAppointmentInput(BaseModel):
    lead_id: str
    coach_id: str
    slot_time: str  # "YYYY-MM-DDTHH:MM"


@router.post("/branch/diet-appointment")
async def book_diet_appointment(
    payload: DietAppointmentInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Book the Diet Consultation — one appointment on the coach's calendar.

    Diet is a consultation vertical, the same shape as a Head Physio consultation and not
    the same shape as a course of treatment: the Nutrition Coach sees the patient once to
    read them and set a plan. So this books ONE slot, and it lands in the shared
    `appointments` collection with appt_kind="diet", exactly the way
    v3_consult_appointments books a Head Physio's. That is what makes it show up on the
    coach's own calendar without a second mechanism to keep in step.

    Two rules this deliberately does not enforce, because the branch decides them:

    Diet normally follows treatment, but a patient can come for a diet consultation and
    nothing else — so this never requires a physio assignment or a treatment package.

    And it is never compulsory: nothing here reads or requires `diet_recommended`. The flag
    is set as a RESULT of booking, so the coach's queue agrees with the booking whether the
    Head Physio recommended diet on the day or the patient asked for it a week later.

    One rule it does enforce, and the only one: the Diet Consultation Fee has to be in
    first — see _require_diet_fee. That is not a rule about who referred the patient, which
    is why it sits beside the two above rather than contradicting them. It is a rule about
    what has been paid for, and booking a coach's hour against nothing is the mistake the
    branch cannot undo by editing a flag afterwards.

    What it must never do is touch `stage`, `branch_stage` or `consultation_stage`. The
    generic book-appointment endpoint resets a lead to the first sales stage, which for a
    patient already at Fee Collected would throw away their whole consultation. That is
    why this is its own endpoint rather than a reuse of that one.
    """
    lead = await v3_col("leads").find_one({"id": payload.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_diet_fee(lead)

    coach = await v3_col("doctors").find_one({"id": payload.coach_id, "profile_type": COACH}, {"_id": 0})
    if not coach:
        raise HTTPException(status_code=404, detail="Nutritionist not found")

    slot = normalize_slot_time(payload.slot_time)
    if slot not in (coach.get("slots") or []):
        raise HTTPException(
            status_code=400,
            detail="That time isn't published on this coach's calendar. Open it in MANAGEMENT > DIET CALENDAR first.",
        )

    # This lead's own earlier booking is cancelled before the clash check, or re-booking
    # them into the same slot would read as a clash against themselves.
    await v3_col("appointments").update_many(
        {"lead_id": payload.lead_id, "appt_kind": "diet", "status": "new_appointment"},
        {"$set": {"status": "cancelled", "updated_at": now_iso()}},
    )

    clash = await v3_col("appointments").find_one(
        {"doctor_id": payload.coach_id, "slot_time": slot, "status": "new_appointment"},
        {"_id": 0, "lead_name": 1},
    )
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"This coach is already booked at that time ({clash.get('lead_name') or 'another patient'})",
        )

    date_part, _, time_part = slot.partition("T")
    now = now_iso()
    appt = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "lead_name": lead.get("name", "Unknown"),
        "patient_name": lead.get("name", "Unknown"),
        "branch_id": lead.get("branch_id") or coach.get("branch_id") or user.branch_id,
        "doctor_id": coach["id"],
        "doctor_name": coach["full_name"],
        "appointment_date": date_part,
        "appointment_time": time_part,
        "slot_time": slot,
        "status": "new_appointment",
        "appt_kind": "diet",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
        "updated_at": now,
    }
    await v3_col("appointments").insert_one(appt.copy())

    await v3_col("leads").update_one(
        {"id": payload.lead_id},
        {"$set": {
            "diet_coach_id": coach["id"],
            "diet_coach_name": coach["full_name"],
            "diet_appointment_at": slot,
            "diet_stage": "Diet Consultation Booked",
            "diet_recommended": True,
            "updated_at": now,
        }},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "action": "diet_appointment_booked",
        "details": f"Diet Consultation with {coach['full_name']} on {date_part} at {time_part}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"appointment": appt, "coach_name": coach["full_name"], "slot_time": slot}


class DietReportInput(BaseModel):
    report: str


@router.post("/diet/consultation-report/{lead_id}")
async def save_diet_consultation_report(
    lead_id: str,
    payload: DietReportInput,
    user: V3UserOut = Depends(v3_require_diet),
):
    """What the Nutrition Coach concluded at the Diet Consultation.

    The diet vertical's counterpart to the Head Physio's diagnosis report: one piece of
    written advice per patient, replaced rather than appended to, because it is the current
    plan and not a log. The per-visit notes are `coach_remarks` on each check-in day.

    Written by the coach alone. Branch Admin books and collects; what the plan says is a
    clinical judgement and nobody else's to author.
    """
    text = (payload.report or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="The report cannot be empty")

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "id": 1, "name": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")

    now = now_iso()
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": {
            "diet_consultation_report": text,
            "diet_consultation_report_at": now,
            "diet_consultation_report_by": user.full_name,
            "updated_at": now,
        }},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "diet_consultation_report_saved",
        "details": "Diet Consultation report written",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"report": text, "saved_at": now, "saved_by": user.full_name}


# ============ The Diet Chart ============
#
# The second thing sold under the word "diet", and the only document in the OS a patient
# has to buy before they can see it.
#
# It is a file rather than a typed plan: a chart is a laid-out week of meals, prepared in
# whatever the coach already prepares it in, and asking them to retype it into a textarea
# would produce a worse chart more slowly. The bytes go through the same `lead_documents`
# storage every other client document uses — outside the static mount, reachable only
# through an authenticated route — rather than a second store with its own path handling to
# get wrong.
#
# Sending and showing are two different acts, deliberately. The coach may prepare and send
# a chart before the fee is collected, and it lands here complete; what the fee buys is the
# patient's sight of it. So nothing on this side asks about money, and the Client Portal
# asks about nothing else.


def _chart_out(lead: dict, doc: Optional[dict]) -> dict:
    """One shape for "where is this patient's chart", used by every staff-side reader.

    `visible_to_client` is computed here rather than stored, off the fee as it stands right
    now, so the coach's board and the patient's portal can never disagree about whether the
    chart has actually reached them.
    """
    paid = lead.get("diet_chart_fee_paid") is not None
    return {
        "sent": bool(doc),
        "document_id": (doc or {}).get("id"),
        "original_name": (doc or {}).get("original_name"),
        "content_type": (doc or {}).get("content_type"),
        "size_bytes": (doc or {}).get("size_bytes"),
        "sent_at": lead.get("diet_chart_sent_at"),
        "sent_by": lead.get("diet_chart_sent_by"),
        "fee_paid": paid,
        "fee_amount": lead.get("diet_chart_fee_paid"),
        "visible_to_client": bool(doc) and paid,
    }


async def _current_chart(lead_id: str) -> Optional[dict]:
    """The chart on file for this patient, or None.

    Found by kind rather than by the lead's diet_chart_document_id, so a chart uploaded
    before that pointer existed — or one whose pointer was lost — is still the chart. Newest
    wins, which is the same "one current plan" rule the consultation report follows.
    """
    return await v3_col("lead_documents").find_one(
        {"lead_id": lead_id, "kind": DIET_CHART}, {"_id": 0}, sort=[("created_at", -1)]
    )


@router.get("/diet/chart/{lead_id}")
async def get_diet_chart(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", COACH)),
):
    """Where this patient's chart stands — for the coach who writes it and the branch that
    sells it. Both, because the branch is the one asked "has it gone yet" at the desk."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")
    return _chart_out(lead, await _current_chart(lead_id))


@router.post("/diet/chart/{lead_id}/recommend")
async def recommend_diet_chart(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_diet),
):
    """The Nutrition Coach says this patient needs a Diet Chart.

    The step that was missing between the two halves of the diet vertical. A Diet Chart is
    a second product at a second price, and until now the Consultant ticked it -- at the
    consultation, before the patient had ever met a Nutritionist. That is a judgement made
    by the wrong person at the wrong time: the branch could take a Chart Fee for a chart
    the coach had not yet decided the patient needed, and the coach could be left owing a
    document somebody else had already sold.

    So the Consultant refers for the Nutritionist's consultation and nothing else, and this
    is where a chart enters the picture: after the patient has been seen, from the board of
    the person who saw them. Setting diet_chart is what puts the Diet Chart Package and the
    Diet Chart Fee in front of the branch -- every chart row in the Diet panel on
    ConsultationsBoard is held behind that flag.

    Written by the coach alone, the same as the report and the chart itself: Branch Admin
    books and collects, and what a patient clinically needs is nobody else's to decide.

    Held to a patient who is actually theirs -- but "theirs" has three answers, not two,
    and reading it as two is what told a coach that a patient sitting on their own board
    belonged to nobody. /diet/consultations lists unassigned referrals deliberately: a new
    referral belongs to no coach until one takes it, and hiding it until then would leave
    nobody able to pick it up. So the coach who opens such a patient and recommends a chart
    IS taking them, and this takes them -- assignment follows the clinical act rather than
    gating it. Refusing instead sent the coach off to get the patient assigned first, from
    a board that has no such button and through a flow that is Branch Admin's alone.

    What is refused is the third answer: a patient already filed under a DIFFERENT coach.
    That is the case the old check was reaching for, and the only one where the call really
    is somebody else's to make.

    Not held to a report having been written first: the recommendation is normally made in
    the same sitting, and demanding the write-up before it would only push coaches to save
    an empty one to get past the gate.

    One way. Nothing here un-recommends a chart: the branch simply does not collect a fee
    it was told about by mistake, and a chart already paid for or already sent cannot be
    taken back by a flag anyway.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")

    # Asked of every record this coach holds, for the reason in _coach_record_ids: a
    # patient filed under a sibling record is still this coach's, and matching only the
    # one resolved id would read their own patient as another coach's.
    #
    # A Super Admin driving this resolves to no coach record at all, which leaves `mine`
    # empty and both branches below inert: they can recommend for anyone, and nothing is
    # filed under them by accident.
    coach = await _resolve_coach(user)
    mine = await _coach_record_ids(coach) if coach else []
    holder = lead.get("diet_coach_id")
    if holder and mine and holder not in mine:
        raise HTTPException(
            status_code=400,
            detail=f"This patient is with {lead.get('diet_coach_name') or 'another Nutrition Coach'}",
        )

    if lead.get("diet_chart"):
        # Already recommended. Not an error -- two taps, or two coaches, should read the
        # same as one -- and the second must not overwrite who recommended it or when.
        return _chart_out(lead, await _current_chart(lead_id))

    now = now_iso()
    changes = {
        "diet_chart": True,
        "diet_chart_recommended_at": now,
        "diet_chart_recommended_by": user.full_name,
        # A patient can reach a Nutritionist without a Consultant's referral -- the branch
        # can book one directly -- and a chart recommended for them still makes them a diet
        # patient on every screen that asks.
        "diet_recommended": True,
        "updated_at": now,
    }
    if not holder and coach:
        # Taking the patient, and no more than that. diet_stage is left where it stands,
        # because that field belongs to the check-in plan and a plan is what assign-diet
        # builds -- days booked against published slots, Diet Fee collected. Writing
        # "Diet Plan Assigned" here would show the branch a plan nobody has sold.
        changes["diet_coach_id"] = coach["id"]
        changes["diet_coach_name"] = coach.get("full_name") or user.full_name
        changes["diet_assigned_at"] = now
    await v3_col("leads").update_one({"id": lead_id}, {"$set": changes})

    if changes.get("diet_coach_id"):
        # Logged under the name the branch already reads for this, and separately from the
        # recommendation: two things happened on one tap, and a log that mentioned only
        # the chart would leave the patient's coach appearing from nowhere.
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "action": "diet_coach_assigned",
            "details": f"{changes['diet_coach_name']} took this patient at the Diet Consultation",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
        })
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "diet_chart_recommended",
        # Says what happens next, because the person reading this log is the branch and the
        # fee is theirs to collect.
        "details": "Diet Chart recommended by the Nutrition Coach - the Diet Chart Fee can now be collected",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return _chart_out(updated, await _current_chart(lead_id))


@router.post("/diet/chart/{lead_id}")
async def send_diet_chart(
    lead_id: str,
    file: UploadFile = File(...),
    label: Optional[str] = Form(""),
    user: V3UserOut = Depends(v3_require_diet),
):
    """The Nutrition Coach sends a Diet Chart to the Client Portal.

    Written by the coach alone, the same as the consultation report: Branch Admin books and
    collects, and what the chart says is a clinical judgement and nobody else's to author.

    Never blocked on the fee. The coach prepares charts as their work reaches them, not as
    payments land, and a chart that could not be uploaded until the desk had collected would
    have the coach chasing the till to do their job. Sending is finished work; the fee
    decides only whether the patient can see it, and the portal decides that when asked.

    Replaces rather than appends. A chart is the current plan and not a log — the same rule
    the consultation report follows — so a new one supersedes the old, and the old row and
    its bytes go with it. Left behind, the documents screen would fill with every draft the
    coach ever sent and the patient's portal would have to guess which one was current.

    The old chart is deleted only after the new one is safely on disk. The other order
    leaves a patient with no chart at all when an upload is rejected.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="A Diet Chart must be a JPG, PNG, WEBP or PDF file")

    previous = await _current_chart(lead_id)

    doc_id = str(uuid.uuid4())
    stored_name, size = await store_upload(file, doc_id, ext)
    now = now_iso()
    doc = {
        "id": doc_id,
        "lead_id": lead_id,
        "stored_name": stored_name,
        "original_name": os.path.basename(file.filename or "diet-chart")[:200],
        "label": (label or "").strip()[:120] or "Diet Chart",
        "kind": DIET_CHART,
        # Written false and meant false. The generic sharing flag is not what shows a chart
        # to a patient — is_shared_with_patient refuses this kind outright — but a row
        # saying True beside a chart nobody has paid for is a lie waiting to be believed by
        # the next person to read the collection.
        "shared_with_patient": False,
        "content_type": file.content_type or "application/octet-stream",
        "size_bytes": size,
        "uploaded_by": user.full_name,
        "uploaded_by_role": user.role,
        "created_at": now,
    }
    await v3_col("lead_documents").insert_one(doc.copy())

    if previous:
        await v3_col("lead_documents").delete_one({"id": previous["id"]})
        old_path = os.path.join(DOC_DIR, previous.get("stored_name") or "")
        # Guarded the same way the download routes are: a stored_name is data, and data that
        # resolves outside the documents folder is not a file this may remove.
        if previous.get("stored_name") and os.path.dirname(os.path.abspath(old_path)) == os.path.abspath(DOC_DIR):
            try:
                os.remove(old_path)
            except OSError:
                # The row is already gone and the new chart is already in. A file that could
                # not be removed is litter on disk, not a reason to fail a send that
                # succeeded.
                pass

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "diet_chart_document_id": doc_id,
        "diet_chart_sent_at": now,
        "diet_chart_sent_by": user.full_name,
        # The chart being sent is itself the record that this patient was owed one, exactly
        # as the fee is. Set here so a patient the coach charted off their own judgement
        # still reads as a Diet Chart patient on every screen that asks.
        "diet_recommended": True,
        "diet_chart": True,
        "updated_at": now,
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "diet_chart_sent",
        # Says plainly whether the patient can actually see it, because "sent" on its own
        # would read to the branch as "the patient has it" — and unpaid, they do not.
        "details": (
            f"Diet Chart sent ({doc['original_name']})"
            + ("" if lead.get("diet_chart_fee_paid") is not None
               else " — held from the Client Portal until the Diet Chart Fee is collected")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })

    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return _chart_out(updated, doc)


@router.get("/diet/chart/{lead_id}/download")
async def download_diet_chart(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", COACH)),
):
    """The chart's bytes, for staff.

    Not gated on the fee. The gate exists so a patient cannot read a plan they have not paid
    for; the coach who wrote it and the branch selling it are exactly who should be able to
    open it before then, and refusing them would make an unpaid chart unreviewable by
    anyone, including its author.
    """
    doc = await _current_chart(lead_id)
    if not doc:
        raise HTTPException(status_code=404, detail="No Diet Chart on file")
    path = os.path.join(DOC_DIR, doc["stored_name"])
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(DOC_DIR) or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File is missing from storage")
    return FileResponse(path, media_type=doc.get("content_type"), filename=doc.get("original_name"))


@router.get("/branch/diet-patients")
async def branch_diet_patients(user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    """Everyone at this branch already on a diet plan, for the Branch Admin's own view."""
    query = {"diet_coach_id": {"$nin": [None, ""]}}
    if user.branch_id:
        query["branch_id"] = user.branch_id
    leads = await v3_col("leads").find(
        query, {"_id": 0, "id": 1, "name": 1, "phone": 1, "diet_coach_id": 1, "diet_coach_name": 1, "diet_stage": 1}
    ).sort("updated_at", -1).to_list(500)
    lead_ids = [l["id"] for l in leads]
    rows = await v3_col("diet_sessions").find({"lead_id": {"$in": lead_ids}}, {"_id": 0}).to_list(5000)
    by_lead: dict = {}
    for r in rows:
        by_lead.setdefault(r["lead_id"], []).append(r)
    for l in leads:
        days = by_lead.get(l["id"], [])
        l["total_days"] = len(days)
        l["completed_days"] = sum(1 for d in days if d.get("status") == "completed")
    return {"patients": leads}


# ============ The Nutrition Coach's own board ============

@router.get("/diet/consultations")
async def diet_consultations(coach_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_diet)):
    """Patients coming in for a Diet Consultation.

    Two things, and only two: the patients assigned to this coach, and the ones nobody has
    been assigned yet. `diet_recommended` IS the referral — it is set at the moment the
    Head Physio decides, and nothing else in the OS records the intention — so the waiting
    half is read off that flag and the taken half off `diet_coach_id`.

    It used to be every referral at the branch, which meant two coaches at one branch each
    saw the other's patients and neither could tell which were theirs. Scoped strictly to
    the coach it would be worse: a new referral belongs to nobody yet, so it would be
    invisible to everybody and there would be no way to pick one up.

    The branch half is every branch the coach covers, not the one branch of whichever
    doctors row they were resolved through — a Nutritionist here covers all of them, and
    that row names only one.

    Already-assigned patients stay in the list rather than disappearing, marked as such.
    A coach needs to see who they have seen as well as who is waiting, and a queue that
    empties itself gives no way to check the day's work.
    """
    coach = await _resolve_coach(user, coach_id)
    if not coach:
        return {"patients": []}

    query = {
        "diet_recommended": True,
        # Every record this coach holds, not the one they resolved through — see
        # _coach_record_ids. A patient filed under a sibling record is still this coach's
        # patient, and matching the single resolved id is what made assigning one to
        # themselves remove them from their own queue.
        #
        # Unassigned is written three ways across records of different ages — absent, null,
        # or empty — so all three count as "nobody has taken this one".
        "$or": [
            {"diet_coach_id": {"$in": await _coach_record_ids(coach)}},
            {"diet_coach_id": {"$in": [None, ""]}},
            {"diet_coach_id": {"$exists": False}},
        ],
    }
    branch_ids = await _coach_branch_ids(coach)
    if branch_ids:
        query["branch_id"] = {"$in": branch_ids}
    leads = await v3_col("leads").find(query, {"_id": 0}).sort("updated_at", -1).to_list(500)

    lead_ids = [l["id"] for l in leads]
    booked = await v3_col("diet_sessions").find(
        {"lead_id": {"$in": lead_ids}}, {"_id": 0, "lead_id": 1, "status": 1}
    ).to_list(5000)
    days_by_lead: dict = {}
    for d in booked:
        row = days_by_lead.setdefault(d["lead_id"], {"total": 0, "done": 0})
        row["total"] += 1
        if d.get("status") == "completed":
            row["done"] += 1

    # The DIET consultation's own appointment. The lead's appointment_date/_time are the
    # Head Physio's consultation — reading those here had the coach's queue showing every
    # patient at the time they saw the physio, which is not when the coach sees them.
    diet_appts = await v3_col("appointments").find(
        {"lead_id": {"$in": lead_ids}, "appt_kind": "diet", "status": {"$ne": "cancelled"}},
        {"_id": 0, "lead_id": 1, "slot_time": 1, "status": 1, "doctor_name": 1},
    ).sort("slot_time", 1).to_list(2000)
    appt_by_lead = {a["lead_id"]: a for a in diet_appts}

    # Every chart on this queue in one query rather than one per patient, the same way the
    # days and the appointments above are read. Oldest first so the newest overwrites it,
    # which leaves the current chart per lead — the rule _current_chart follows one at a
    # time.
    charts = await v3_col("lead_documents").find(
        {"lead_id": {"$in": lead_ids}, "kind": DIET_CHART}, {"_id": 0, "stored_name": 0}
    ).sort("created_at", 1).to_list(2000)
    chart_by_lead = {c["lead_id"]: c for c in charts}

    out = []
    for l in leads:
        days = days_by_lead.get(l["id"], {"total": 0, "done": 0})
        appt = appt_by_lead.get(l["id"])
        appt_date, _, appt_time = (appt or {}).get("slot_time", "").partition("T")
        out.append({
            "lead_id": l["id"],
            "lead_name": l.get("name", "Unknown"),
            "phone": l.get("phone", ""),
            "patient_number": l.get("patient_number", ""),
            "appointment_date": appt_date or None,
            "appointment_time": appt_time or None,
            "appointment_status": (appt or {}).get("status"),
            "booked": bool(appt),
            # What the Head Physio sent them here with, so the coach can see at a glance
            # whether this patient is also on a physio course.
            "consultation_decision": l.get("consultation_decision"),
            "diet_stage": l.get("diet_stage"),
            "diet_coach_name": l.get("diet_coach_name"),
            # So the coach's queue shows who has been written up and who has not.
            "diet_consultation_report": l.get("diet_consultation_report"),
            # Which of the two the Consultant actually referred them for, so the coach can
            # tell a patient who is here for an hour from one who is owed a document. Both
            # can be true; both false is the plain referral every older consultation carries.
            "diet_consultation": bool(l.get("diet_consultation")),
            "diet_chart": bool(l.get("diet_chart")),
            # Where the chart stands, including whether the patient can actually see it.
            # The coach needs the difference in front of them: a chart they sent last week
            # that is still invisible for want of a fee looks, from their side, exactly like
            # one that arrived — and they are the person the patient asks.
            "chart": _chart_out(l, chart_by_lead.get(l["id"])),
            "assigned": bool(l.get("diet_coach_id")),
            "total_days": days["total"],
            "completed_days": days["done"],
            "updated_at": l.get("updated_at"),
        })
    return {"patients": out}

@router.get("/diet/today")
async def diet_today(coach_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_diet)):
    coach = await _resolve_coach(user, coach_id)
    if not coach:
        return {"days": [], "coach_id": None, "coach_name": ""}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Across every record they hold, or a coach's own day is missing the check-ins booked
    # against a sibling record — see _coach_record_ids.
    days = await v3_col("diet_sessions").find(
        {"coach_id": {"$in": await _coach_record_ids(coach)}, "slot_time": {"$regex": f"^{today}"}}, {"_id": 0}
    ).sort("slot_time", 1).to_list(200)
    return {"days": days, "coach_id": coach["id"], "coach_name": coach["full_name"]}


@router.get("/diet/calendar")
async def diet_calendar(
    month: Optional[int] = None,
    year: Optional[int] = None,
    coach_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_diet),
):
    coach = await _resolve_coach(user, coach_id)
    if not coach:
        return {"days": [], "slots": [], "slot_details": []}
    now = datetime.now(timezone.utc)
    prefix = f"{year or now.year}-{str(month or now.month).zfill(2)}"
    days = await v3_col("diet_sessions").find(
        {"coach_id": {"$in": await _coach_record_ids(coach)}, "slot_time": {"$regex": f"^{prefix}"}}, {"_id": 0}
    ).sort("slot_time", 1).to_list(500)
    return {
        "days": days,
        "slots": coach.get("slots", []),
        "slot_details": coach.get("slot_details", []),
        "coach_id": coach["id"],
        "coach_name": coach["full_name"],
    }


@router.get("/diet/patients")
async def diet_patients(coach_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_diet)):
    """Every patient assigned to this coach, whether or not their days are booked yet —
    same reasoning as the physio board: a patient who has just been assigned should appear
    immediately rather than only once a plan exists."""
    coach = await _resolve_coach(user, coach_id)
    if not coach:
        return {"patients": []}
    # Every record they hold, for the reason in _coach_record_ids: a patient assigned
    # through a sibling record is this coach's patient and was missing from this list.
    record_ids = await _coach_record_ids(coach)
    leads = await v3_col("leads").find(
        {"diet_coach_id": {"$in": record_ids}}, {"_id": 0}
    ).sort("updated_at", -1).to_list(500)
    lead_ids = [l["id"] for l in leads]
    rows = await v3_col("diet_sessions").find(
        {"coach_id": {"$in": record_ids}, "lead_id": {"$in": lead_ids}}, {"_id": 0}
    ).sort("slot_time", 1).to_list(5000)
    by_lead: dict = {}
    for r in rows:
        by_lead.setdefault(r["lead_id"], []).append(r)

    patients = []
    for lead in leads:
        days = by_lead.get(lead["id"], [])
        completed = sum(1 for d in days if d.get("status") == "completed")
        patients.append({
            "lead_id": lead["id"],
            "lead_name": lead.get("name", "Unknown"),
            "phone": lead.get("phone", ""),
            # The branch's two hand-made marks, carried through so a treating
            # clinician sees the VIP star and the attention flag on the same
            # patient the branch marked. This row is a projection, so anything
            # not named here simply never leaves the backend.
            "is_vip": bool(lead.get("is_vip")),
            "needs_attention": bool(lead.get("needs_attention")),
            # Mark Online on the Physio Assign panel, so the Online tag follows the patient here.
            "session_package_mode": lead.get("session_package_mode"),
            "online_marked_at": lead.get("online_marked_at"),
            "total_days": len(days),
            "completed_days": completed,
            "remaining_days": len(days) - completed,
            "next_day": next((d for d in days if d.get("status") == "upcoming"), None),
            "diet_stage": lead.get("diet_stage"),
            "updated_at": lead.get("updated_at"),
        })
    return {"patients": patients}


@router.get("/diet/sessions/{lead_id}")
async def diet_sessions_for_lead(
    lead_id: str,
    _: V3UserOut = Depends(v3_require_roles(COACH, "branch_admin", "super_admin", "business_dev", "head_physio")),
):
    days = await v3_col("diet_sessions").find({"lead_id": lead_id}, {"_id": 0}).sort("slot_time", 1).to_list(500)
    return {"days": days}


class CompleteDayInput(BaseModel):
    coach_remarks: Optional[str] = ""
    weight_kg: Optional[float] = None


@router.post("/diet/sessions/{session_id}/complete")
async def complete_diet_day(
    session_id: str,
    payload: CompleteDayInput,
    user: V3UserOut = Depends(v3_require_diet),
):
    day = await v3_col("diet_sessions").find_one({"id": session_id}, {"_id": 0})
    if not day:
        raise HTTPException(status_code=404, detail="Check-in day not found")
    if day.get("status") == "completed":
        raise HTTPException(status_code=400, detail="This check-in is already completed")

    now = now_iso()
    await v3_col("diet_sessions").update_one(
        {"id": session_id},
        {"$set": {
            "status": "completed",
            "coach_remarks": (payload.coach_remarks or "").strip(),
            "weight_kg": payload.weight_kg,
            "completed_at": now,
            "updated_at": now,
        }},
    )
    remaining = await v3_col("diet_sessions").count_documents(
        {"lead_id": day["lead_id"], "status": "upcoming"}
    )
    # The plan closes itself on the last check-in rather than waiting for someone to
    # remember to close it — the same way a treatment course ends.
    if remaining == 0:
        await v3_col("leads").update_one(
            {"id": day["lead_id"]},
            {"$set": {"diet_stage": "Diet Completed", "updated_at": now}},
        )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": day["lead_id"],
        "action": "diet_checkin_completed",
        "details": f"Check-in day {day.get('day_number')} of {day.get('total_days')} completed"
                   + (f" · {payload.weight_kg} kg" if payload.weight_kg is not None else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"status": "completed", "remaining": remaining}
