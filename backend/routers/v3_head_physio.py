from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from database import v3_col
from utils import now_iso, normalize_slot_time, slot_capacity_of, MAX_PHYSIO_SLOT_CAPACITY
from shift_utils import day_windows_of, override_shift_ids, shift_ids_of, shift_map, window_of
from deps import v3_require_roles
from branch_calendar import is_leave
from schemas.v3 import (
    V3UserOut, V3DoctorOut,
    V3CalendarSlotsInput, V3RemoveSlotsInput,
)

router = APIRouter(prefix="/api/v3")


@router.get("/doctors/{doctor_id}/calendar")
async def get_doctor_calendar(doctor_id: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio"))):
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # Head Physios get booked from `appointments` (doctor_id); regular Physios get booked
    # treatment sessions from `sessions` (physio_id) — a different collection entirely, so
    # both need checking to correctly reflect either doctor kind's calendar. `lead_id` is
    # included so a caller re-assigning a lead to the same physio can tell "already booked
    # by this same lead" (fine to re-propose) apart from "booked by someone else".
    appt_rows = await v3_col("appointments").find(
        {"doctor_id": doctor_id, "status": "new_appointment"},
        {"_id": 0, "slot_time": 1, "lead_name": 1, "lead_id": 1, "id": 1},
    ).to_list(1000)
    session_rows = await v3_col("sessions").find(
        {"physio_id": doctor_id, "status": "upcoming"},
        {"_id": 0, "slot_time": 1, "lead_name": 1, "lead_id": 1, "id": 1, "session_number": 1},
    ).to_list(1000)
    # And a Nutrition Coach from `diet_sessions` (coach_id) — a third collection, keyed on
    # a third field, for the same reason the diet vertical keeps its own: nothing else
    # reads a coach's bookings, so without this their calendar comes back permanently
    # empty and the assign-diet picker offers a slot that is already taken.
    diet_rows = await v3_col("diet_sessions").find(
        {"coach_id": doctor_id, "status": "upcoming"},
        {"_id": 0, "slot_time": 1, "lead_name": 1, "lead_id": 1, "id": 1},
    ).to_list(1000)
    # And rehab days from `rehab_sessions` (physio_id) — a fourth collection, for the same
    # reason. A rehab day takes the same physio in the same room as a treatment day, so a
    # calendar that did not read it would keep offering a slot that is already spoken for
    # and let the picker double-book the hour.
    rehab_rows = await v3_col("rehab_sessions").find(
        {"physio_id": doctor_id, "status": "upcoming"},
        {"_id": 0, "slot_time": 1, "lead_name": 1, "lead_id": 1, "id": 1, "day_number": 1},
    ).to_list(1000)
    # A treatment day waiting on a date from the Branch Admin carries no slot_time. Left in,
    # it books the empty string — which then reads back as an occupied slot and can make the
    # picker refuse the very day it is being asked to place.
    #
    # Each row is tagged with the course it came from. An occupant's `lead_id` alone tells
    # the picker "this one is mine", which it uses to discount a lead's own bookings from
    # the seat count so re-confirming a patient onto the times they already hold isn't
    # refused as a clash with themselves. But a physio runs two courses off this one
    # calendar, and only the one being re-booked is actually being replaced: discounting a
    # patient's *treatment* days while booking their *rehab* course drew a free seat the
    # assign endpoint then counted and refused as "Full for this physio". `course` is what
    # lets the picker discount exactly the right rows — and see the rest for what they are.
    def tag(rows_in, course):
        for r in rows_in:
            r["course"] = course
        return rows_in

    rows = [r for r in (
        *tag(appt_rows, "consult"),
        *tag(session_rows, "session"),
        *tag(diet_rows, "diet"),
        *tag(rehab_rows, "rehab"),
    ) if (r.get("slot_time") or "").strip()]

    # `booked` keeps its old shape — one row per slot — because callers read it to answer
    # "is this slot mine or someone else's". It cannot answer "how full is this slot",
    # which is why `occupancy` exists alongside rather than replacing it.
    booked_map = {row["slot_time"]: row for row in rows}
    occupancy: dict = {}
    occupants: dict = {}
    for row in rows:
        st = row["slot_time"]
        occupancy[st] = occupancy.get(st, 0) + 1
        occupants.setdefault(st, []).append({
            # The booking's own id, alongside the course tag that says which collection it
            # came from. A caller that can only see "somebody is in this hour" can do
            # nothing about it; with these two together the branch can move that exact row
            # onto another slot or take it off this one, which is what the calendar's
            # per-slot edit does.
            "id": row.get("id"),
            "lead_id": row.get("lead_id"),
            "lead_name": row.get("lead_name", ""),
            "course": row.get("course", ""),
            # Which day of the course this is -- "day 3 of the treatment" is how the branch
            # names it back to the patient on the phone. Absent on a consultation, which is
            # one appointment and not a day of anything.
            "day_number": row.get("session_number") or row.get("day_number"),
        })

    # The hours this expert is rostered on (MANAGEMENT → TIME MANAGEMENT). The calendar cuts
    # its day across exactly this window, so an evening physio's day is offered 3 PM to 7 PM
    # rather than the whole clock. Unassigned falls back to the old fixed working day.
    #
    # `day_shifts` is the exceptions to it — the dates this expert worked something other
    # than their usual shift. Resolved in the same lookup because a month's overrides and
    # the default all point into the same small set of shifts.
    # A list, because a day can be cut into halves: the consultant who works 8 AM to 1 PM
    # and again 5 PM to 9 PM is rostered on two shifts, and the window below carries both
    # as `segments` so the grid skips the afternoon between them.
    own = shift_ids_of(doctor)
    shifts = await shift_map([*own, *override_shift_ids(doctor)])
    window = window_of([shifts.get(i) for i in own])
    day_shifts = day_windows_of(doctor, shifts)

    return {
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
        "specialization": doctor.get("specialization", ""),
        "slots": doctor.get("slots", []),
        "slot_details": doctor.get("slot_details", []),
        "booked": booked_map,
        "slot_capacity": slot_capacity_of(doctor),
        # This physio's own session length, set from the calendar header. None means they
        # follow the session item's duration in FITSIO STORE, as every physio used to.
        "slot_duration": doctor.get("slot_duration_minutes") or None,
        "occupancy": occupancy,
        "occupants": occupants,
        "shift": window,
        "day_shifts": day_shifts,
    }


class SlotCapacityInput(BaseModel):
    slot_capacity: int


@router.patch("/doctors/{doctor_id}/slot-capacity")
async def set_slot_capacity(
    doctor_id: str,
    payload: SlotCapacityInput,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """How many patients this physio takes at once. Two or three is the normal floor."""
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0, "id": 1, "profile_type": 1})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    if doctor.get("profile_type") != "physio":
        # Refused rather than silently ignored: storing a 3 on a Head Physio would sit in
        # the record looking effective while slot_capacity_of pins them to 1 forever.
        raise HTTPException(
            status_code=400,
            detail="Only a Physio can take more than one patient per slot — a consultation is one-to-one.",
        )
    if payload.slot_capacity < 1 or payload.slot_capacity > MAX_PHYSIO_SLOT_CAPACITY:
        raise HTTPException(
            status_code=400,
            detail=f"Slot capacity must be between 1 and {MAX_PHYSIO_SLOT_CAPACITY}",
        )
    await v3_col("doctors").update_one(
        {"id": doctor_id},
        {"$set": {"slot_capacity": payload.slot_capacity, "updated_at": now_iso()}},
    )
    return {"doctor_id": doctor_id, "slot_capacity": payload.slot_capacity}


SLOT_DURATION_MIN_MINUTES = 5
SLOT_DURATION_MAX_MINUTES = 480


class SlotDurationInput(BaseModel):
    # None clears the override, so the physio goes back to FITSIO STORE's session length.
    slot_duration_minutes: Optional[int] = None


@router.patch("/doctors/{doctor_id}/slot-duration")
async def set_slot_duration(
    doctor_id: str,
    payload: SlotDurationInput,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """How long one treatment session runs on this physio's calendar.

    Only the days opened from now on are cut at it; slots already published keep the
    length they were saved with.
    """
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0, "id": 1, "profile_type": 1})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    if doctor.get("profile_type") != "physio":
        # A consultation's length is the one Branch Leads → Appointment books against
        # (consultation_slot_minutes), so it stays with FITSIO STORE.
        raise HTTPException(status_code=400, detail="Only a Physio's treatment session length can be set here.")
    minutes = payload.slot_duration_minutes
    if minutes is not None and not (
        SLOT_DURATION_MIN_MINUTES <= minutes <= SLOT_DURATION_MAX_MINUTES and minutes % 5 == 0
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Session length must be {SLOT_DURATION_MIN_MINUTES}–{SLOT_DURATION_MAX_MINUTES} minutes, in steps of 5",
        )
    update = (
        {"$set": {"slot_duration_minutes": minutes, "updated_at": now_iso()}}
        if minutes is not None
        else {"$unset": {"slot_duration_minutes": ""}, "$set": {"updated_at": now_iso()}}
    )
    await v3_col("doctors").update_one({"id": doctor_id}, update)
    return {"doctor_id": doctor_id, "slot_duration": minutes}


@router.post("/doctors/{doctor_id}/calendar-slots")
async def add_calendar_slots(
    doctor_id: str,
    payload: V3CalendarSlotsInput,
    branch_id: Optional[str] = None,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # A day the branch is on leave (MANAGEMENT → CALENDAR → MONTHLY CALENDAR) takes no slots.
    # The branch is the one whose calendar is publishing — passed by the calendar, because a
    # Consultant's record is branchless — else the expert's own.
    leave_branch = branch_id or (doctor.get("branch_id") if doctor.get("profile_type") != "head_physio" else None)
    if leave_branch:
        branch = await v3_col("branches").find_one(
            {"id": leave_branch}, {"_id": 0, "holidays": 1, "working_overrides": 1, "weekly_hours": 1, "holiday_notes": 1},
        )
        if branch:
            closed = sorted({
                s.slot_time[:10] for s in payload.slots
                if len(s.slot_time or "") >= 10 and is_leave(branch, s.slot_time[:10])
            })
            if closed:
                raise HTTPException(
                    status_code=400,
                    detail=f"The branch is on leave on {', '.join(closed)} — mark the day Working in Monthly Calendar first",
                )

    existing_slots = set(doctor.get("slots", []))
    existing_details = doctor.get("slot_details", [])
    existing_detail_map = {d["slot_time"]: d for d in existing_details}

    new_slot_times = []
    for slot in payload.slots:
        normalized = normalize_slot_time(slot.slot_time)
        new_slot_times.append(normalized)
        existing_detail_map[normalized] = {
            "slot_time": normalized,
            "duration": slot.duration,
            "consultation_type": slot.consultation_type,
        }

    all_slots = sorted(existing_slots.union(set(new_slot_times)))
    all_details = sorted(existing_detail_map.values(), key=lambda x: x["slot_time"])

    await v3_col("doctors").update_one(
        {"id": doctor_id},
        {"$set": {"slots": all_slots, "slot_details": all_details}},
    )

    updated = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    return {
        "doctor_id": doctor_id,
        "slots_count": len(all_slots),
        "slots": updated.get("slots", []),
        "slot_details": updated.get("slot_details", []),
    }


@router.post("/doctors/{doctor_id}/remove-slots")
async def remove_calendar_slots(doctor_id: str, payload: V3RemoveSlotsInput, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    normalized_remove = {normalize_slot_time(s) for s in payload.slot_times}

    booked_appts = await v3_col("appointments").find(
        {"doctor_id": doctor_id, "status": "new_appointment", "slot_time": {"$in": list(normalized_remove)}},
        {"_id": 0, "slot_time": 1},
    ).to_list(100)
    booked_sessions = await v3_col("sessions").find(
        {"physio_id": doctor_id, "status": "upcoming", "slot_time": {"$in": list(normalized_remove)}},
        {"_id": 0, "slot_time": 1},
    ).to_list(100)
    # Diet check-ins guard the same way. Left out, a Nutrition Coach's published slot could
    # be deleted out from under a patient who is booked into it, and the check-in would
    # survive in `diet_sessions` pointing at a time the calendar no longer offers.
    booked_checkins = await v3_col("diet_sessions").find(
        {"coach_id": doctor_id, "status": "upcoming", "slot_time": {"$in": list(normalized_remove)}},
        {"_id": 0, "slot_time": 1},
    ).to_list(100)
    booked_rehab = await v3_col("rehab_sessions").find(
        {"physio_id": doctor_id, "status": "upcoming", "slot_time": {"$in": list(normalized_remove)}},
        {"_id": 0, "slot_time": 1},
    ).to_list(100)
    booked_times = {b["slot_time"] for b in [*booked_appts, *booked_sessions, *booked_checkins, *booked_rehab]}
    blocked = normalized_remove.intersection(booked_times)
    if blocked:
        raise HTTPException(status_code=400, detail=f"Cannot remove booked slots: {', '.join(sorted(blocked))}")

    remaining_slots = [s for s in doctor.get("slots", []) if s not in normalized_remove]
    remaining_details = [d for d in doctor.get("slot_details", []) if d["slot_time"] not in normalized_remove]

    await v3_col("doctors").update_one(
        {"id": doctor_id},
        {"$set": {"slots": remaining_slots, "slot_details": remaining_details}},
    )

    return {"doctor_id": doctor_id, "removed": len(normalized_remove - booked_times), "remaining_slots": len(remaining_slots)}
