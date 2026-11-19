"""A physio who will not be in, and what happens to the patients booked with them.

Marking a *patient* absent is old news here (v3_physio_board.physio_mark_absent). This is
the other half: the physio is the one away. Their patients are still coming, still owed
the day they paid for, and the physio's calendar is the only place anybody would notice
that nobody will be in the room to see them.

So an absence is a date against a physio, and it comes with a worklist: every treatment
and rehab day booked with them on that date. Each one is settled one of two ways, both
of them with the patient on the phone first —

  * handed to another physio at the same branch who has published the same hour and
    still has a seat in it. The day's physio_id moves, so it lands on the covering
    physio's board, calendar and seat count exactly as any other booking would; where it
    came from is kept on the row (covered_for_*) so it is not mistaken for a transfer.
  * released, when the patient would rather wait for their own physio. The day loses its
    slot and joins the days waiting on a date — the queue Missed Classes already works —
    so the package is not shortened by a day the patient never refused.

Both desks can do all of it. The physio knows first that they will be off; the Branch
Admin is the one who hears it at 7am on the phone. A physio can only mark and settle
their own absences; a Branch Admin, any physio at their branch.
"""
from typing import Optional
import uuid

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from database import v3_col
from deps import v3_require_roles, is_physio_role, works_org_wide, collapse_duplicate_experts
from physio_scope import resolve_physio_doctor
from schemas.v3 import V3UserOut
from utils import now_iso, clinic_today, ACTIVE_DOCTOR, slot_capacity_of, physio_slot_load
from course_order import keep_days_in_date_order

router = APIRouter(prefix="/api/v3")

ROLES = ("physio", "branch_admin", "super_admin", "business_dev")

# The two courses a physio delivers, keyed by the tag the boards already stamp on a row.
COURSES = {
    "treatment": {"collection": "sessions", "num_field": "session_number", "total_field": "total_sessions", "noun": "Day"},
    "rehab": {"collection": "rehab_sessions", "num_field": "day_number", "total_field": "total_days", "noun": "Rehab day"},
}


class AbsenceCreate(BaseModel):
    date: str
    reason: str = ""
    # Ignored for a physio, who can only mark themselves; required of a Branch Admin.
    physio_id: Optional[str] = None


class ReassignInput(BaseModel):
    to_physio_id: str
    # The patient was rung and agreed to see somebody else. Refused when absent rather
    # than defaulted — see RescheduleBookingInput in v3_session_assign for why.
    patient_confirmed: bool = False
    note: str = ""


class ReleaseInput(BaseModel):
    reason: str = ""


def _valid_date(text: str) -> str:
    text = (text or "").strip()[:10]
    parts = text.split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts) or len(parts[0]) != 4:
        raise HTTPException(status_code=400, detail="Pick the date the physio is absent")
    return text


async def _my_physio(user: V3UserOut) -> dict:
    doctor = await resolve_physio_doctor(user.id, user.role)
    if not doctor:
        raise HTTPException(status_code=404, detail="No physio profile found for this login")
    return doctor


async def _physio_ids_of(doctor_id: str) -> list:
    """Every record id belonging to the same person as this one, at the same branch.

    One physio routinely holds several `doctors` rows (see resolve_physio_doctor), and a
    day booked against any of them is still a day this person will not be in for.
    """
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        return [doctor_id]
    name = (doctor.get("full_name") or "").strip()
    twins = await v3_col("doctors").find(
        {"profile_type": "physio", "branch_id": doctor.get("branch_id"), "full_name": name},
        {"_id": 0, "id": 1},
    ).to_list(50)
    return list(dict.fromkeys([doctor_id, *[t["id"] for t in twins]]))


async def _load_absence(absence_id: str, user: V3UserOut) -> dict:
    """One absence, refused unless this caller may act on it."""
    absence = await v3_col("physio_absences").find_one({"id": absence_id}, {"_id": 0})
    if not absence:
        raise HTTPException(status_code=404, detail="That absence is no longer on record")
    if works_org_wide(user.role):
        return absence
    if is_physio_role(user.role):
        me = await _my_physio(user)
        if not set(me.get("physio_ids") or [me["id"]]) & set(absence.get("physio_ids") or [absence["physio_id"]]):
            raise HTTPException(status_code=403, detail="You can only manage your own absences")
        return absence
    if user.branch_id and absence.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=403, detail="That physio is not at your branch")
    return absence


async def _branch_physios(branch_id: str) -> list:
    rows = await v3_col("doctors").find(
        {"profile_type": "physio", "branch_id": branch_id, **ACTIVE_DOCTOR}, {"_id": 0},
    ).to_list(200)
    return await collapse_duplicate_experts(rows)


async def _absent_ids_on(date: str, branch_id: str) -> set:
    rows = await v3_col("physio_absences").find(
        {"date": date, "branch_id": branch_id}, {"_id": 0, "physio_ids": 1, "physio_id": 1},
    ).to_list(200)
    out: set = set()
    for r in rows:
        out.update(r.get("physio_ids") or [r.get("physio_id")])
    return out


async def physio_absent_on(physio_id: str, slot_time: str) -> Optional[dict]:
    """The absence covering this physio on this slot's date, if there is one.

    For the booking endpoints: a day placed on a date its physio has said they will not be
    in is the exact problem this router exists to clear up, so it is refused at the door.
    """
    date = (slot_time or "")[:10]
    if not physio_id or len(date) != 10:
        return None
    return await v3_col("physio_absences").find_one(
        {"date": date, "physio_ids": physio_id}, {"_id": 0},
    )


async def refuse_if_physio_absent(physio_id: str, slots) -> None:
    """Refuse a booking that puts a patient on a physio's day off, naming the date."""
    for slot in slots or []:
        hit = await physio_absent_on(physio_id, slot)
        if hit:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{hit.get('physio_name') or 'This physio'} is marked absent on {hit['date']}"
                    " — pick another date or another physio"
                ),
            )


def _day_of(track: str, row: dict) -> dict:
    spec = COURSES[track]
    return {
        "id": row.get("id"),
        "track": track,
        "lead_id": row.get("lead_id"),
        "lead_name": row.get("lead_name") or "Unknown",
        "session_number": row.get(spec["num_field"]),
        "total_sessions": row.get(spec["total_field"]),
        "slot_time": row.get("slot_time") or "",
        "status": row.get("status"),
        "physio_id": row.get("physio_id"),
        "physio_name": row.get("physio_name") or "",
        "covered_for_physio_name": row.get("covered_for_physio_name") or "",
    }


async def _absence_days(absence: dict) -> list:
    """Every day this absence touches: still waiting, handed over, or released."""
    ids = absence.get("physio_ids") or [absence["physio_id"]]
    date = absence["date"]
    days = []
    for track, spec in COURSES.items():
        col = v3_col(spec["collection"])
        waiting = await col.find(
            {"physio_id": {"$in": ids}, "slot_time": {"$regex": f"^{date}"}}, {"_id": 0},
        ).to_list(500)
        for row in waiting:
            day = _day_of(track, row)
            day["state"] = "done" if row.get("status") == "completed" else "waiting"
            days.append(day)
        handled = await col.find({"absence_id": absence["id"]}, {"_id": 0}).to_list(500)
        for row in handled:
            if any(d["id"] == row.get("id") for d in days):
                continue
            day = _day_of(track, row)
            day["state"] = "released" if row.get("absence_action") == "released" else "reassigned"
            if day["state"] == "released":
                day["slot_time"] = row.get("absence_slot_time") or ""
            days.append(day)
    days.sort(key=lambda d: (d["slot_time"], d["lead_name"]))
    return days


async def _candidates(absence: dict, days: list) -> dict:
    """For each hour the absent physio was booked, who else at the branch could take it.

    Offered only when the other physio has published that very hour and still has a seat
    in it, and is not away themselves. Everyone else is listed too, with the reason, so a
    Branch Admin can see that opening an hour in PHYSIO CALENDAR is all it would take.
    """
    slots = sorted({d["slot_time"] for d in days if d["state"] in ("waiting", "reassigned") and d["slot_time"]})
    if not slots:
        return {}
    absent = await _absent_ids_on(absence["date"], absence["branch_id"])
    mine = set(absence.get("physio_ids") or [absence["physio_id"]])
    others = [p for p in await _branch_physios(absence["branch_id"]) if p["id"] not in mine]

    out: dict = {slot: [] for slot in slots}
    for p in others:
        capacity = slot_capacity_of(p)
        taken, _ = await physio_slot_load(p["id"], slots)
        published = set(p.get("slots") or [])
        for slot in slots:
            n = taken.get(slot, 0)
            if p["id"] in absent:
                why = "Absent too"
            elif slot not in published:
                why = "Hour not open"
            elif n >= capacity:
                why = f"Full ({n}/{capacity})"
            else:
                why = ""
            out[slot].append({
                "id": p["id"],
                "name": p.get("full_name") or "",
                "taken": n,
                "capacity": capacity,
                "available": not why,
                "reason": why,
            })
    for slot in out:
        out[slot].sort(key=lambda c: (not c["available"], c["taken"], c["name"]))
    return out


def _summary(absence: dict, days: list) -> dict:
    counts = {s: len([d for d in days if d["state"] == s]) for s in ("waiting", "reassigned", "released", "done")}
    return {**absence, "days_total": len(days), "counts": counts}


@router.get("/physio-absences")
async def list_absences(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """Absences from `date_from` (default today) on, with how many patients still need a plan.

    A Branch Admin also gets the branch's physios, so the Mark Absent form can name one.
    """
    start = _valid_date(date_from) if date_from else clinic_today()
    query: dict = {"date": {"$gte": start}}
    if date_to:
        query["date"]["$lte"] = _valid_date(date_to)

    physios: list = []
    me = None
    if is_physio_role(user.role):
        me = await _my_physio(user)
        query["physio_ids"] = {"$in": me.get("physio_ids") or [me["id"]]}
    else:
        # A login's own branch wins. The board's branch is taken only where the login has
        # none — Super Admin/BD driving a branch's board, or an admin whose account names
        # no branch — which would otherwise list no physios for the Mark Absent picker.
        scope = user.branch_id if (user.branch_id and not works_org_wide(user.role)) else branch_id
        if scope:
            query["branch_id"] = scope
            physios = [{"id": p["id"], "name": p.get("full_name") or ""} for p in await _branch_physios(scope)]
            physios.sort(key=lambda p: p["name"].lower())

    rows = await v3_col("physio_absences").find(query, {"_id": 0}).sort("date", 1).to_list(500)
    out = [_summary(a, await _absence_days(a)) for a in rows]
    return {
        "absences": out,
        "physios": physios,
        "today": clinic_today(),
        "me": {"id": me["id"], "name": me.get("full_name") or ""} if me else None,
    }


@router.post("/physio-absences")
async def mark_absent(payload: AbsenceCreate, user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    date = _valid_date(payload.date)
    if date < clinic_today():
        raise HTTPException(status_code=400, detail="That date has already gone — pick today or later")

    if is_physio_role(user.role):
        doctor = await _my_physio(user)
        ids = doctor.get("physio_ids") or [doctor["id"]]
    else:
        if not payload.physio_id:
            raise HTTPException(status_code=400, detail="Pick the physio who is absent")
        doctor = await v3_col("doctors").find_one({"id": payload.physio_id, "profile_type": "physio"}, {"_id": 0})
        if not doctor:
            raise HTTPException(status_code=404, detail="That physio is no longer on record")
        if not works_org_wide(user.role) and user.branch_id and doctor.get("branch_id") != user.branch_id:
            raise HTTPException(status_code=403, detail="That physio is not at your branch")
        ids = await _physio_ids_of(doctor["id"])

    clash = await v3_col("physio_absences").find_one({"date": date, "physio_ids": {"$in": ids}}, {"_id": 0})
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"{clash.get('physio_name') or 'This physio'} is already marked absent on {date}",
        )

    absence = {
        "id": str(uuid.uuid4()),
        "physio_id": doctor["id"],
        "physio_ids": ids,
        "physio_name": doctor.get("full_name") or "",
        "branch_id": doctor.get("branch_id") or user.branch_id or "",
        "date": date,
        "reason": (payload.reason or "").strip(),
        "marked_by": user.full_name,
        "marked_by_role": user.role,
        "marked_by_user_id": user.id,
        "created_at": now_iso(),
    }
    await v3_col("physio_absences").insert_one(absence.copy())
    days = await _absence_days(absence)
    return _summary(absence, days)


@router.get("/physio-absences/{absence_id}")
async def absence_detail(absence_id: str, user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """The absence's worklist: each patient's day, and who could take it instead."""
    absence = await _load_absence(absence_id, user)
    days = await _absence_days(absence)
    return {**_summary(absence, days), "days": days, "candidates": await _candidates(absence, days)}


@router.delete("/physio-absences/{absence_id}")
async def cancel_absence(absence_id: str, user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """The physio is coming in after all. Every day handed over that is not yet worked goes
    back to them, on the hour it was taken from — nobody else could have been booked into
    it while they were marked away. Released days stay in the Missed Classes queue: the
    patient was already told they would be given a new date, and that date is theirs to
    agree, not something to reverse from here.
    """
    absence = await _load_absence(absence_id, user)
    handed_back = 0
    for spec in COURSES.values():
        col = v3_col(spec["collection"])
        rows = await col.find(
            {"absence_id": absence_id, "absence_action": "reassigned", "status": {"$ne": "completed"}}, {"_id": 0},
        ).to_list(500)
        for row in rows:
            await col.update_one({"id": row["id"]}, {
                "$set": {
                    "physio_id": row.get("covered_for_physio_id") or absence["physio_id"],
                    "physio_name": row.get("covered_for_physio_name") or absence["physio_name"],
                    "updated_at": now_iso(),
                },
                "$unset": {f: "" for f in ("covered_for_physio_id", "covered_for_physio_name", "absence_id", "absence_action")},
            })
            await _log(row.get("lead_id"), user, "physio_cover_returned", (
                f"{absence['physio_name']} is back on {absence['date']} — the day handed to"
                f" {row.get('physio_name') or 'another physio'} is with them again."
            ))
            handed_back += 1
    await v3_col("physio_absences").delete_one({"id": absence_id})
    return {"deleted": True, "handed_back": handed_back}


async def _load_day(absence: dict, track: str, day_id: str):
    spec = COURSES.get(track)
    if not spec:
        raise HTTPException(status_code=400, detail="Unknown course")
    row = await v3_col(spec["collection"]).find_one({"id": day_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="That day is no longer on record")
    ids = absence.get("physio_ids") or [absence["physio_id"]]
    on_date = (row.get("slot_time") or "").startswith(absence["date"])
    ours = row.get("physio_id") in ids or row.get("absence_id") == absence["id"]
    if not (ours and on_date):
        raise HTTPException(status_code=400, detail="That day is not one of this absence's bookings")
    if row.get("status") == "completed":
        raise HTTPException(status_code=400, detail="That day has already been worked")
    return spec, row


async def _log(lead_id: str, user: V3UserOut, action: str, details: str):
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": action,
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })


@router.post("/physio-absences/{absence_id}/days/{track}/{day_id}/reassign")
async def reassign_day(
    absence_id: str,
    track: str,
    day_id: str,
    payload: ReassignInput,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """Hand one patient's day to another physio, same hour, with the patient's agreement."""
    absence = await _load_absence(absence_id, user)
    spec, row = await _load_day(absence, track, day_id)

    if not payload.patient_confirmed:
        raise HTTPException(
            status_code=400,
            detail=f"Confirm with {row.get('lead_name') or 'the patient'} that they are happy to see another physio",
        )
    if payload.to_physio_id in (absence.get("physio_ids") or [absence["physio_id"]]):
        raise HTTPException(status_code=400, detail="That is the physio who is absent — pick someone else")

    cover = await v3_col("doctors").find_one(
        {"id": payload.to_physio_id, "profile_type": "physio", **ACTIVE_DOCTOR}, {"_id": 0},
    )
    if not cover:
        raise HTTPException(status_code=404, detail="That physio is no longer on record")
    if cover.get("branch_id") != absence.get("branch_id"):
        raise HTTPException(status_code=400, detail="Pick a physio from the same branch")
    if payload.to_physio_id in await _absent_ids_on(absence["date"], absence["branch_id"]):
        raise HTTPException(status_code=409, detail=f"{cover.get('full_name')} is marked absent that day too")

    slot = row.get("slot_time") or ""
    if slot not in (cover.get("slots") or []):
        raise HTTPException(
            status_code=400,
            detail=f"{cover.get('full_name')} hasn't opened {slot.replace('T', ' at ')} — open it in MANAGEMENT → PHYSIO CALENDAR first",
        )
    if row.get("physio_id") == cover["id"]:
        raise HTTPException(status_code=400, detail=f"This day is already with {cover.get('full_name')}")
    taken, _ = await physio_slot_load(cover["id"], [slot])
    capacity = slot_capacity_of(cover)
    if taken.get(slot, 0) >= capacity:
        raise HTTPException(status_code=409, detail=f"{cover.get('full_name')} is full at that hour — {taken.get(slot, 0)} of {capacity}")

    note = (payload.note or "").strip()
    await v3_col(spec["collection"]).update_one({"id": day_id}, {"$set": {
        "physio_id": cover["id"],
        "physio_name": cover.get("full_name") or "",
        # Who the day really belongs to, kept through a second hand-over so cancelling the
        # absence can still send it home.
        "covered_for_physio_id": row.get("covered_for_physio_id") or row.get("physio_id"),
        "covered_for_physio_name": row.get("covered_for_physio_name") or row.get("physio_name"),
        "absence_id": absence_id,
        "absence_action": "reassigned",
        "cover_confirmed_with_patient": True,
        "cover_note": note,
        "updated_at": now_iso(),
    }})

    number = row.get(spec["num_field"])
    await _log(row.get("lead_id"), user, "physio_cover_assigned", (
        f"{absence['physio_name']} is absent on {absence['date']}. {spec['noun']} {number} at"
        f" {slot.replace('T', ' at ')} handed to {cover.get('full_name')}, confirmed with"
        f" {row.get('lead_name') or 'the patient'}." + (f" Note: {note}" if note else "")
    ))
    updated = await v3_col(spec["collection"]).find_one({"id": day_id}, {"_id": 0})
    return {"day": _day_of(track, updated)}


@router.post("/physio-absences/{absence_id}/days/{track}/{day_id}/release")
async def release_day(
    absence_id: str,
    track: str,
    day_id: str,
    payload: ReleaseInput,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """The patient would rather wait for their own physio: the day gives up its hour and
    joins the days waiting on a date, where Missed Classes books it again. Nothing is
    cancelled — it is a day they paid for."""
    absence = await _load_absence(absence_id, user)
    spec, row = await _load_day(absence, track, day_id)
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Say what the patient asked for, so the branch knows when to book them")

    slot = row.get("slot_time") or ""
    # A day already handed to a cover goes back to its own physio first — the patient is
    # waiting for them, not for the cover.
    home_id = row.get("covered_for_physio_id") or row.get("physio_id")
    home_name = row.get("covered_for_physio_name") or row.get("physio_name")
    await v3_col(spec["collection"]).update_one({"id": day_id}, {
        "$set": {
            "physio_id": home_id,
            "physio_name": home_name,
            "slot_time": "",
            "needs_assignment": True,
            "absence_id": absence_id,
            "absence_action": "released",
            "absence_slot_time": slot,
            "absence_release_reason": reason,
            "updated_at": now_iso(),
        },
        "$unset": {"covered_for_physio_id": "", "covered_for_physio_name": ""},
    })
    # The released day becomes the last of the course, so the days after it can still be
    # signed off in order while it waits for Missed Classes to book it.
    await keep_days_in_date_order(spec["collection"], spec["num_field"], row.get("lead_id"))

    number = row.get(spec["num_field"])
    await _log(row.get("lead_id"), user, "physio_absence_released", (
        f"{absence['physio_name']} is absent on {absence['date']}. {spec['noun']} {number}"
        f" ({slot.replace('T', ' at ')}) taken off the calendar and waiting on a new date."
        f" Reason: {reason}"
    ))
    updated = await v3_col(spec["collection"]).find_one({"id": day_id}, {"_id": 0})
    return {"day": _day_of(track, updated)}
