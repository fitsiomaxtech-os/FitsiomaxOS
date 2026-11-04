from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time, slot_capacity_of
from deps import v3_require_roles
from schemas.v3 import V3UserOut, V3AssignSessionsInput
from stage_utils import refuse_if_branch_lost
from routers.v3_physio_absence import refuse_if_physio_absent

router = APIRouter(prefix="/api/v3")


@router.get("/branch/package-recommendations")
async def get_recommendations(user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    query = {}
    if user.branch_id:
        query["branch_id"] = user.branch_id

    recs = await v3_col("package_recommendations").find(query, {"_id": 0}).sort("created_at", -1).to_list(500)

    lead_ids = [r["lead_id"] for r in recs]
    leads = await v3_col("leads").find({"id": {"$in": lead_ids}}, {"_id": 0}).to_list(500)
    lead_map = {l["id"]: l for l in leads}

    for rec in recs:
        lead = lead_map.get(rec["lead_id"], {})
        rec["lead_phone"] = lead.get("phone", "")
        rec["lead_email"] = lead.get("email", "")
        rec["branch_stage"] = lead.get("branch_stage", "")
        rec["package_amount"] = lead.get("package_amount")

    return {"recommendations": recs}


@router.post("/branch/assign-sessions")
async def assign_sessions(
    payload: V3AssignSessionsInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    lead = await v3_col("leads").find_one({"id": payload.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    await refuse_if_branch_lost(lead)

    physio = await v3_col("doctors").find_one({"id": payload.physio_id}, {"_id": 0})
    if not physio:
        raise HTTPException(status_code=404, detail="Jr. Physio not found")

    await refuse_if_physio_absent(payload.physio_id, [normalize_slot_time(t) for t in payload.slot_times])

    rec = await v3_col("package_recommendations").find_one({"lead_id": payload.lead_id}, {"_id": 0})

    total = len(payload.slot_times)
    sessions_to_create = []

    for i, slot_time in enumerate(payload.slot_times):
        normalized = normalize_slot_time(slot_time)
        week_num = (i // (rec["sessions_per_week"] if rec else 3)) + 1

        session = {
            "id": str(uuid.uuid4()),
            "lead_id": payload.lead_id,
            "lead_name": lead.get("name", "Unknown"),
            "branch_id": lead.get("branch_id") or user.branch_id,
            "physio_id": payload.physio_id,
            "physio_name": physio["full_name"],
            "head_physio_id": rec.get("head_physio_id", "") if rec else "",
            "head_physio_name": rec.get("head_physio_name", "") if rec else "",
            "session_number": i + 1,
            "total_sessions": total,
            "week_number": week_num,
            "slot_time": normalized,
            "status": "upcoming",
            "jr_physio_remarks": "",
            "rehab_remarks": "",
            # Filled in when the physio signs the day off, from the Super Admin catalogue.
            "physio_treatments": [],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        sessions_to_create.append(session)

    if sessions_to_create:
        await v3_col("sessions").insert_many([s.copy() for s in sessions_to_create])

    await v3_col("leads").update_one(
        {"id": payload.lead_id},
        {"$set": {
            "assigned_physio_id": payload.physio_id,
            "assigned_physio_name": physio["full_name"],
            "physio_assigned_at": now_iso(),
            "branch_stage": "Assigned Physio",
            "updated_at": now_iso(),
        }},
    )

    if rec:
        await v3_col("package_recommendations").update_one(
            {"id": rec["id"]},
            {"$set": {"status": "assigned"}},
        )

    patient_token = str(uuid.uuid4())
    await v3_col("patient_tokens").update_one(
        {"lead_id": payload.lead_id},
        {"$set": {"lead_id": payload.lead_id, "token": patient_token, "created_at": now_iso()}},
        upsert=True,
    )

    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "action": "sessions_assigned",
        "details": f"{total} sessions assigned to {physio['full_name']}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())

    # The same automatic Client Portal login the Consultations board's booking makes — see
    # hp_assign_physio_with_sessions. Imported here: the portal router pulls in several others.
    from routers.v3_patient_portal import auto_portal_login_for_treatment
    portal = await auto_portal_login_for_treatment(payload.lead_id, user)

    return {
        "sessions_created": total,
        "physio_name": physio["full_name"],
        "patient_token": patient_token,
        "lead_id": payload.lead_id,
        "portal": portal,
    }


# ------------------------------------------- Treatment days left without a date by an absence
#
# Marking a patient absent steps every later day down into the slot in front of it, which
# leaves the last day of the course with nowhere to go. It is flagged needs_assignment and
# lands here: the Physio can move days along the slots already bought, but only the Branch
# Admin puts a day onto the physio's published calendar, which is where it came from in the
# first place. Until this is done the patient is a day short of the package they paid for.


# A physio runs two courses out of the same room, and each names the same two facts
# differently: a treatment day is session_number of total_sessions, a rehab day is
# day_number of total_days. Marking a patient absent already writes needs_assignment to
# whichever collection the day came from, but only `sessions` was ever read back — so a
# rehab day stranded by an absence was owed to the patient and shown to nobody, which is
# the one thing this queue exists to stop. Both are read here and flattened onto the
# treatment names once, at the read, so everything downstream sees a single shape.
_COURSES = (
    ("sessions", "treatment", "session_number", "total_sessions"),
    ("rehab_sessions", "rehab", "day_number", "total_days"),
)


def _order_bounds(siblings: list, number: int, num_field: str) -> tuple:
    """The window a dateless day's new date has to land in, as (after, before).

    Days are worked in number order — the physio is refused a day whose predecessors are
    not signed off — so the date has to sit where the number does: after every earlier day
    of the same course and before every later one. Either end is "" when nothing bounds it.
    """
    earlier = [
        (r.get("slot_time") or "").strip()
        for r in siblings
        if (r.get(num_field) or 0) < number and (r.get("slot_time") or "").strip()
    ]
    later = [
        (r.get("slot_time") or "").strip()
        for r in siblings
        if (r.get(num_field) or 0) > number and (r.get("slot_time") or "").strip()
    ]
    return (max(earlier, default=""), min(later, default=""))


class ScheduleSessionInput(BaseModel):
    slot_time: str


@router.get("/branch/sessions/unscheduled")
async def unscheduled_sessions(user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Treatment and rehab days waiting on a date, oldest patient first."""
    query: dict = {"needs_assignment": True, "status": {"$ne": "completed"}}
    if user.branch_id:
        query["branch_id"] = user.branch_id

    rows: list = []
    for collection, track, num_field, total_field in _COURSES:
        found = await v3_col(collection).find(query, {"_id": 0}).to_list(500)
        for s in found:
            s["track"] = track
            if track != "treatment":
                s["session_number"] = s.get(num_field)
                s["total_sessions"] = s.get(total_field)
        rows.extend(found)
    rows.sort(key=lambda s: (s.get("lead_name") or "", s.get("session_number") or 0))

    # The absence that caused this is what the Branch Admin needs to read to place the day —
    # who missed, when, and what the physio wrote. It sits on the session that was missed,
    # not on the one left dateless, so the two are matched up by lead here. Matched by
    # course as well: a patient can be running treatment and rehab at once, and the rehab
    # absence that stranded a rehab day says nothing about a stranded treatment day.
    #
    # The same pass reads back every day of the patient's course, which is what says where
    # the new date is allowed to go — see _order_bounds.
    latest_absence: dict = {}
    bounds: dict = {}
    for collection, track, num_field, _total in _COURSES:
        ids = list({s.get("lead_id") for s in rows if s.get("track") == track and s.get("lead_id")})
        if not ids:
            continue

        siblings = await v3_col(collection).find(
            {"lead_id": {"$in": ids}},
            {"_id": 0, "id": 1, "lead_id": 1, num_field: 1, "slot_time": 1, "absences": 1},
        ).to_list(2000)

        by_lead: dict = {}
        for row in siblings:
            by_lead.setdefault(row.get("lead_id"), []).append(row)

        for s in rows:
            if s.get("track") != track:
                continue
            others = [r for r in by_lead.get(s.get("lead_id"), []) if r.get("id") != s.get("id")]
            bounds[s["id"]] = _order_bounds(others, s.get("session_number") or 0, num_field)

        for row in siblings:
            for ab in row.get("absences") or []:
                key = (row.get("lead_id"), track)
                current = latest_absence.get(key)
                if not current or (ab.get("marked_at") or "") > (current.get("marked_at") or ""):
                    latest_absence[key] = {**ab, "session_number": row.get(num_field)}

    # A session carries the patient's name but not their patient number, and the number is
    # how the branch actually identifies someone on the phone.
    lead_ids = list({s.get("lead_id") for s in rows if s.get("lead_id")})
    leads = await v3_col("leads").find(
        {"id": {"$in": lead_ids}}, {"_id": 0, "id": 1, "patient_number": 1, "phone": 1},
    ).to_list(500)
    lead_map = {l["id"]: l for l in leads}

    for s in rows:
        s["last_absence"] = latest_absence.get((s.get("lead_id"), s.get("track")))
        lead = lead_map.get(s.get("lead_id"), {})
        s["patient_number"] = lead.get("patient_number", "")
        s["phone"] = lead.get("phone", "")
        after, before = bounds.get(s["id"], ("", ""))
        # Named for what the branch reads them as: the day the patient's booked days run
        # out, and — if an earlier absence stranded two days — the day that follows this
        # one. The picker offers only the gap between them, which is exactly what
        # schedule_session below will accept.
        s["course_end"] = after
        s["next_day_at"] = before

    return {"sessions": rows}


@router.post("/branch/sessions/{session_id}/schedule")
async def schedule_session(
    session_id: str,
    payload: ScheduleSessionInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Put a dateless treatment or rehab day onto one of its physio's published slots."""
    session = None
    for name, track_name, field, _total in _COURSES:
        found = await v3_col(name).find_one({"id": session_id}, {"_id": 0})
        if found:
            session, collection, track, num_field = found, name, track_name, field
            break
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.get("status") == "completed":
        raise HTTPException(status_code=400, detail="This day is already completed")

    slot = normalize_slot_time(payload.slot_time)
    if not slot:
        raise HTTPException(status_code=400, detail="Pick a date and time for this day")

    physio = await v3_col("doctors").find_one({"id": session.get("physio_id")}, {"_id": 0})
    if not physio:
        raise HTTPException(status_code=404, detail="This day's physio is no longer on record")

    # Refused rather than accepted quietly: a day placed on a time the physio never opened
    # shows on nobody's calendar, and the patient is turned away twice over the same absence.
    if slot not in (physio.get("slots") or []):
        raise HTTPException(
            status_code=400,
            detail="That time isn't published by this physio — open it in MANAGEMENT → PHYSIO CALENDAR first",
        )

    # Not onto a day this physio has said they will not be in — see v3_physio_absence.
    await refuse_if_physio_absent(session.get("physio_id"), [slot])

    # Where the number says the date has to sit. A slot earlier in the course is real, and
    # the physio is free on it, and the day still cannot be delivered when it comes round:
    # the board refuses a day whose predecessors are not signed off, so the patient is
    # turned away a second time over the same absence. Checked against the days themselves
    # rather than against today, because "the end of the course" is the only date that
    # moves as the rest of it does.
    number = session.get(num_field) or 0
    siblings = await v3_col(collection).find(
        {"lead_id": session.get("lead_id"), "id": {"$ne": session_id}},
        {"_id": 0, num_field: 1, "slot_time": 1},
    ).to_list(2000)
    after, before = _order_bounds(siblings, number, num_field)
    if after and slot <= after:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Day {number} is worked after the days already booked — pick a time after"
                f" {after.replace('T', ' at ')}, when this patient's slots run out"
            ),
        )
    if before and slot >= before:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Day {number} is worked before the next day already booked — pick a time"
                f" before {before.replace('T', ' at ')}"
            ),
        )

    # Both of the physio's courses count against the slot. A rehab day and a treatment day
    # take the same physio in the same half hour, so counting only one of them hands out a
    # seat the calendar has already drawn as taken.
    capacity = slot_capacity_of(physio)
    taken = 0
    for name, _track, _field, _total in _COURSES:
        taken += await v3_col(name).count_documents({
            "physio_id": session.get("physio_id"),
            "slot_time": slot,
            "status": {"$ne": "completed"},
            "id": {"$ne": session_id},
        })
    if taken >= capacity:
        raise HTTPException(status_code=409, detail=f"That slot is full — it already holds {taken} of {capacity}")

    await v3_col(collection).update_one(
        {"id": session_id},
        {"$set": {"slot_time": slot, "needs_assignment": False, "updated_at": now_iso()}},
    )

    day_word = "Rehab day" if track == "rehab" else "Day"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": session.get("lead_id"),
        "action": "session_rescheduled",
        "details": (
            f"{day_word} {number} was left without a date by an absence and has been"
            f" booked for {slot.replace('T', ' at ')} with {physio.get('full_name', 'the physio')}."
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })

    updated = await v3_col(collection).find_one({"id": session_id}, {"_id": 0})
    return {"session": updated}


# ---------------------------------------------------------------------------
# Managing one booking straight off the expert's calendar
# ---------------------------------------------------------------------------
# The slot picker draws every hour a physio has published and how full each one is. Until
# now that was all it could do: a branch looking at a taken hour could see the patient
# standing in it and had no way to act, so moving somebody off an hour meant finding their
# lead card, reopening their whole course and re-placing every day of it. These two
# endpoints give the calendar the two answers a desk actually needs about one booking —
# move it, or take it off this hour — without touching the rest of the course.
#
# An expert's calendar is booked out of four different collections, one per course, each
# keyed on its own expert field and each with its own word for "still to come". The course
# tag `get_doctor_calendar` stamps on every occupant is what says which one a booking came
# from, so that tag is what is passed back here rather than a collection name.
CALENDAR_COURSES = {
    "session": {
        "collection": "sessions", "expert_field": "physio_id", "live_status": "upcoming",
        "noun": "treatment day", "day_field": "session_number",
    },
    "rehab": {
        "collection": "rehab_sessions", "expert_field": "physio_id", "live_status": "upcoming",
        "noun": "rehab day", "day_field": "day_number",
    },
    "diet": {
        "collection": "diet_sessions", "expert_field": "coach_id", "live_status": "upcoming",
        "noun": "diet check-in", "day_field": "session_number",
    },
    "consult": {
        "collection": "appointments", "expert_field": "doctor_id", "live_status": "new_appointment",
        "noun": "consultation", "day_field": None,
    },
}

# Every expert the OS books — physios, consultants and nutrition coaches alike — lives in
# one collection, which is why a single lookup serves all four courses above.
EXPERT_COLLECTION = "doctors"


class RescheduleBookingInput(BaseModel):
    slot_time: str
    # An hour is not the branch's to move on its own: somebody is expected at it and has
    # arranged their day around it. The desk rings them, and this flag is the desk saying
    # it did. Refused when absent rather than defaulted to true — a move nobody told the
    # patient about is exactly the failure this exists to prevent, and a default would let
    # it through every time a caller simply left the field out.
    patient_confirmed: bool = False
    reason: str = ""


class DeclineBookingInput(BaseModel):
    reason: str = ""


async def _load_booking(course: str, booking_id: str):
    """One booking off a calendar, with the course rules that govern it."""
    spec = CALENDAR_COURSES.get(course)
    if not spec:
        raise HTTPException(status_code=400, detail="Unknown course for a calendar booking")
    booking = await v3_col(spec["collection"]).find_one({"id": booking_id}, {"_id": 0})
    if not booking:
        raise HTTPException(status_code=404, detail=f"That {spec['noun']} is no longer on record")
    if booking.get("status") != spec["live_status"]:
        raise HTTPException(
            status_code=400,
            detail=f"That {spec['noun']} is {booking.get('status') or 'not upcoming'} — only an upcoming one can be changed",
        )
    return spec, booking


def _booking_label(spec: dict, booking: dict) -> str:
    """How the log and the errors name a booking: 'Day 3 treatment day', or 'consultation'."""
    day = booking.get(spec["day_field"]) if spec["day_field"] else None
    return f"Day {day} {spec['noun']}" if day else spec["noun"]


@router.post("/branch/calendar-bookings/{course}/{booking_id}/reschedule")
async def reschedule_calendar_booking(
    course: str,
    booking_id: str,
    payload: RescheduleBookingInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Move one booking onto another hour the same expert has published."""
    spec, booking = await _load_booking(course, booking_id)

    if not payload.patient_confirmed:
        raise HTTPException(
            status_code=400,
            detail=f"Confirm the new time with {booking.get('lead_name') or 'the patient'} before moving it",
        )

    slot = normalize_slot_time(payload.slot_time)
    if not slot:
        raise HTTPException(status_code=400, detail="Pick a date and time to move this to")

    moved_from = booking.get("slot_time") or ""
    if slot == moved_from:
        raise HTTPException(status_code=400, detail="That is the time it already holds — pick another")

    expert_id = booking.get(spec["expert_field"])
    expert = await v3_col(EXPERT_COLLECTION).find_one({"id": expert_id}, {"_id": 0})
    if not expert:
        raise HTTPException(status_code=404, detail="This booking's expert is no longer on record")

    # The same refusal `schedule_session` makes, for the same reason: an hour the expert
    # never opened shows on nobody's calendar, and the patient who agreed to it on the
    # phone is turned away at the door.
    if slot not in (expert.get("slots") or []):
        raise HTTPException(
            status_code=400,
            detail="That time isn't published by this expert — open it in MANAGEMENT → PHYSIO CALENDAR first",
        )

    if course in ("session", "rehab"):
        await refuse_if_physio_absent(expert_id, [slot])

    # How full the destination already is, counted across every course the expert runs. One
    # expert, one room, one hour: a treatment day and a rehab day sitting in it take the
    # same two seats, so counting only the collection being moved would overfill the slot.
    capacity = slot_capacity_of(expert)
    taken = 0
    for tag, other in CALENDAR_COURSES.items():
        query = {
            other["expert_field"]: expert_id,
            "slot_time": slot,
            "status": other["live_status"],
        }
        if tag == course:
            query["id"] = {"$ne": booking_id}
        taken += await v3_col(other["collection"]).count_documents(query)
    if taken >= capacity:
        raise HTTPException(status_code=409, detail=f"That slot is full — it already holds {taken} of {capacity}")

    # And whether the patient is themselves already spoken for in that hour, on any course.
    # They cannot be on the treatment floor and in rehab at once, and the seat count above
    # cannot say so — the expert may well have a seat going spare.
    for tag, other in CALENDAR_COURSES.items():
        query = {
            "lead_id": booking.get("lead_id"),
            "slot_time": slot,
            "status": other["live_status"],
        }
        if tag == course:
            query["id"] = {"$ne": booking_id}
        clash = await v3_col(other["collection"]).find_one(query, {"_id": 0, "id": 1})
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"{booking.get('lead_name') or 'This patient'} already has a {other['noun']} at that time",
            )

    now = now_iso()
    reason = (payload.reason or "").strip()
    await v3_col(spec["collection"]).update_one(
        {"id": booking_id},
        {"$set": {
            "slot_time": slot,
            # A day left dateless by an absence or an earlier decline has just been given a
            # time, so it is no longer one of the days waiting on one.
            "needs_assignment": False,
            "rescheduled": True,
            "rescheduled_from": moved_from,
            "rescheduled_at": now,
            "reschedule_reason": reason,
            "reschedule_confirmed_with_patient": True,
            "updated_at": now,
        }},
    )

    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": booking.get("lead_id"),
        "action": "calendar_booking_rescheduled",
        "details": (
            f"{_booking_label(spec, booking)} with {expert.get('full_name', 'the expert')} moved from"
            f" {(moved_from or 'no date').replace('T', ' at ')} to {slot.replace('T', ' at ')},"
            f" confirmed with {booking.get('lead_name') or 'the patient'}."
            + (f" Reason: {reason}" if reason else "")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })

    updated = await v3_col(spec["collection"]).find_one({"id": booking_id}, {"_id": 0})
    return {"booking": updated, "course": course, "moved_from": moved_from, "slot_time": slot}


@router.post("/branch/calendar-bookings/{course}/{booking_id}/decline")
async def decline_calendar_booking(
    course: str,
    booking_id: str,
    payload: DeclineBookingInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Take one booking off the hour it is holding.

    What that means depends on what was bought. A treatment day and a rehab day were paid
    for, so declining one refuses *this hour* and not the day itself: the row keeps its
    place in the course and goes back to the days waiting on a date — the same state an
    absence leaves behind, read by `/branch/sessions/unscheduled` and by the Physio board.
    Cancelling it outright would quietly shorten a package the patient has already paid for.

    A consultation and a diet check-in are the appointment rather than a day of a course,
    so declining one cancels it — which is what every other screen that drops one does.
    """
    spec, booking = await _load_booking(course, booking_id)

    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Say why this booking is being declined")

    freed_from = booking.get("slot_time") or ""
    frees_the_day = course in ("session", "rehab")
    now = now_iso()

    fields = {
        "declined_at": now,
        "declined_by": user.full_name,
        "decline_reason": reason,
        "declined_from": freed_from,
        "updated_at": now,
    }
    if frees_the_day:
        fields["slot_time"] = ""
        fields["needs_assignment"] = True
    else:
        fields["status"] = "cancelled"

    await v3_col(spec["collection"]).update_one({"id": booking_id}, {"$set": fields})

    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": booking.get("lead_id"),
        "action": "calendar_booking_declined",
        "details": (
            f"{_booking_label(spec, booking)} declined off {(freed_from or 'its slot').replace('T', ' at ')}"
            + (" — it is back in the queue waiting on a new date." if frees_the_day else " and cancelled.")
            + f" Reason: {reason}"
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })

    updated = await v3_col(spec["collection"]).find_one({"id": booking_id}, {"_id": 0})
    return {"booking": updated, "course": course, "freed_from": freed_from, "awaiting_new_date": frees_the_day}
