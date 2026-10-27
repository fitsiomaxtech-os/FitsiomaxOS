from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time
from security import hash_password
from deps import v3_require_roles
from schemas.v3 import (
    V3UserOut, V3CompleteSessionInput, V3AbsentSessionInput, V3JrPhysioWeeklyInput,
    V3CreateJrPhysioInput, V3LeadOut,
)
# The rule that actually governs when a review can be raised. Imported rather than
# redeclared so the Treatment Days popup marks its reviews where the reviews router
# agrees they are.
from routers.v3_reviews import (
    REVIEW_GAP_CHOICES, review_gap_of, review_numbers_for_lead, leads_awaiting_review,
    _review_eligibility, _completed_day_counts, _finished_course_ids,
)
# Which leads belong to a physio. In its own module because both this board and the
# reviews router need it, and this one already imports from that one — a helper living
# in either would close the loop.
from physio_scope import (
    physio_lead_ids, physio_owns_lead, resolve_physio_doctor, own_course_days, covering_lead_ids,
)
# The clients' weekly star ratings -- stars only; the Treatment Feedback is not for the
# Physio's eyes (see physio_star_ratings).
from routers.v3_client_reviews import physio_star_ratings, session_star_ratings
# A treatment day that uses up the last paid session tells the branch, the accountant and
# the physio — see v3_session_payment.
from routers.v3_session_payment import notify_after_session_complete, payment_hold_for_lead, payment_hold_message

router = APIRouter(prefix="/api/v3")


async def _resolve_doctor(user: V3UserOut, physio_id: Optional[str] = None) -> Optional[dict]:
    """The logged-in physio's own expert record, and every record they hold beside it.

    Lives in physio_scope now rather than here: the Review tab had a resolver of its own
    that was weaker still (user_id alone, no employee fallback), so one physio could be
    found by one tab and not by the next. This module already imports from v3_reviews, so
    a resolver kept here could not be shared back without closing the loop.

    Read it there — it explains why one person holds several of these records and why the
    reads below are scoped to all of them.
    """
    return await resolve_physio_doctor(user.id, user.role, physio_id)


def _ids_of(doctor: dict) -> list:
    """Every expert record id this physio holds, for scoping a read.

    The board asks for the work sitting against ANY of their records, not just the one it
    opened on: a duplicate row is still the same person, and the branch that booked
    against it was offered it as them. resolve_physio_doctor puts the set on the record it
    returns; the fallback keeps a caller that hands over a bare doctor row working.
    """
    return doctor.get("physio_ids") or [doctor["id"]]


@router.post("/branch/jr-physios")
async def create_jr_physio(payload: V3CreateJrPhysioInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    branch_id = user.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="No branch assigned")

    email = payload.email.lower().strip()
    exists = await v3_col("users").find_one({"email": email}, {"_id": 0})
    if exists:
        raise HTTPException(status_code=409, detail="User with this email already exists")

    user_id = str(uuid.uuid4())
    doctor_id = str(uuid.uuid4())

    await v3_col("users").insert_one({
        "id": user_id,
        "full_name": payload.full_name.strip(),
        "email": email,
        "password": hash_password(payload.password),
        "role": "physio",
        "branch_id": branch_id,
        "is_active": True,
        "created_at": now_iso(),
    })

    doctor = {
        "id": doctor_id,
        "full_name": payload.full_name.strip(),
        "profile_type": "physio",
        "branch_id": branch_id,
        "specialization": payload.specialization or "",
        "slots": [],
        "slot_details": [],
        "user_id": user_id,
        "created_at": now_iso(),
    }
    await v3_col("doctors").insert_one(doctor.copy())

    return {
        "doctor_id": doctor_id,
        "user_id": user_id,
        "full_name": payload.full_name.strip(),
        "email": email,
        "branch_id": branch_id,
    }


async def _rehab_rows(physio_ids, prefix: str) -> list:
    """This physio's rehab days whose date starts with `prefix`, shaped like a session row.

    `track: "rehab"` is what tells the board apart from a treatment day. Every row also
    carries day_number/total_days of its own *rehab course*, never of the session package —
    the two are separate courses that happen to share a physio and a calendar, and merging
    their counts is how "Day 3 of 7" starts lying. See v3_rehab for why they are separate
    collections in the first place.
    """
    rows = await v3_col("rehab_sessions").find(
        {"physio_id": {"$in": physio_ids}, "slot_time": {"$regex": f"^{prefix}"}},
        {"_id": 0},
    ).sort("slot_time", 1).to_list(500)
    for row in rows:
        row["track"] = "rehab"
        # Named the way the board already reads a session, so nothing downstream has to
        # learn a second shape to render the row.
        row["session_number"] = row.get("day_number")
        row["total_sessions"] = row.get("total_days")
    return rows


@router.get("/physio/today")
async def physio_today(physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin"))):
    doctor = await _resolve_doctor(user, physio_id)

    if not doctor:
        return {"sessions": [], "new_assigned": [], "date": datetime.now(timezone.utc).date().isoformat()}

    ids = _ids_of(doctor)
    today = datetime.now(timezone.utc).date().isoformat()
    sessions = await v3_col("sessions").find(
        {"physio_id": {"$in": ids}, "slot_time": {"$regex": f"^{today}"}},
        {"_id": 0},
    ).sort("slot_time", 1).to_list(100)
    # Rehab days sit on the same day, in the same room, for the same physio — so the day's
    # list has to hold them or the physio arrives to a patient their board never mentioned.
    # Merged in tagged rather than silently: a rehab day is not a day of the treatment
    # package, and reading as one would put the "Day 3 of 7" count out.
    sessions = sessions + await _rehab_rows(ids, today)
    sessions.sort(key=lambda r: r.get("slot_time") or "")

    new_assigned = await v3_col("leads").find(
        {"assigned_physio_id": {"$in": ids}, "physio_assigned_at": {"$regex": f"^{today}"}},
        {"_id": 0},
    ).sort("physio_assigned_at", -1).to_list(200)

    return {
        "sessions": sessions,
        "new_assigned": [V3LeadOut(**ld).model_dump() for ld in new_assigned],
        "date": today,
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
    }


@router.get("/physio/calendar")
async def physio_calendar(
    month: Optional[int] = None,
    year: Optional[int] = None,
    physio_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    doctor = await _resolve_doctor(user, physio_id)

    if not doctor:
        return {"sessions": [], "slots": [], "slot_details": []}

    now = datetime.now(timezone.utc)
    m = month or now.month
    y = year or now.year
    prefix = f"{y}-{str(m).zfill(2)}"

    ids = _ids_of(doctor)
    sessions = await v3_col("sessions").find(
        {"physio_id": {"$in": ids}, "slot_time": {"$regex": f"^{prefix}"}},
        {"_id": 0},
    ).sort("slot_time", 1).to_list(500)
    # Same reason as /physio/today: the month has to show the rehab days too, or the week
    # strip counts a day as free that the physio is already booked for.
    sessions = sessions + await _rehab_rows(ids, prefix)
    sessions.sort(key=lambda r: r.get("slot_time") or "")

    return {
        "sessions": sessions,
        "slots": doctor.get("slots", []),
        "slot_details": doctor.get("slot_details", []),
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
    }


@router.get("/physio/patients")
async def physio_patients(physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev"))):
    """Every lead ever assigned to this physio — not just ones with generated treatment
    sessions — so newly assigned/consulted patients show up here right away, with session
    stats layered on once a package is assigned and sessions exist."""
    doctor = await _resolve_doctor(user, physio_id)

    if not doctor:
        return {"patients": []}

    # Rehab patients included: they are this physio's too, and were missing from this list
    # entirely because the lead carries no assigned_physio_id for them.
    lead_ids = await physio_lead_ids(_ids_of(doctor))
    leads = await v3_col("leads").find(
        {"id": {"$in": lead_ids}}, {"_id": 0}
    ).sort("updated_at", -1).to_list(500)
    sessions = await v3_col("sessions").find(
        {**own_course_days(_ids_of(doctor)), "lead_id": {"$in": lead_ids}}, {"_id": 0}
    ).sort("slot_time", 1).to_list(2000)
    for row in sessions:
        row.setdefault("track", "treatment")
    # Rehab days counted here too. Listing the patient was only half of it: read off the
    # sessions collection alone, someone sent straight to rehab having never bought a
    # session package shows 0 of 0 on a course they are nine days into, with no next day.
    # Mapped onto the field names the rest of this projection already uses; rehab runs in
    # days and carries no week, so that one stays empty rather than inventing a Week 1.
    rehab = await v3_col("rehab_sessions").find(
        {**own_course_days(_ids_of(doctor)), "lead_id": {"$in": lead_ids}}, {"_id": 0}
    ).sort("slot_time", 1).to_list(2000)
    for row in rehab:
        row["track"] = "rehab"
        row["session_number"] = row.get("day_number")
        row["total_sessions"] = row.get("total_days")
        row.setdefault("week_number", None)
    sessions = sorted(sessions + rehab, key=lambda r: r.get("slot_time") or "")
    sessions_by_lead: dict = {}
    for s in sessions:
        sessions_by_lead.setdefault(s["lead_id"], []).append(s)

    # Where each week's review has got to: written up by this physio and waiting on the
    # Head Physio ("submitted"), or closed out by them ("reviewed").
    assessment_rows = await v3_col("weekly_assessments").find(
        {"lead_id": {"$in": lead_ids}}, {"_id": 0, "lead_id": 1, "status": 1}
    ).to_list(2000)
    reviews_by_lead: dict = {}
    for a in assessment_rows:
        r = reviews_by_lead.setdefault(a["lead_id"], {"submitted": 0, "reviewed": 0})
        if a.get("status") == "reviewed":
            r["reviewed"] += 1
        else:
            r["submitted"] += 1

    stars = await physio_star_ratings(lead_ids, _ids_of(doctor))

    patients = []
    for lead in leads:
        patient_sessions = sessions_by_lead.get(lead["id"], [])
        reviews = reviews_by_lead.get(lead["id"], {"submitted": 0, "reviewed": 0})
        rated = stars.get(lead["id"], {})
        completed = sum(1 for s in patient_sessions if s["status"] == "completed")
        total = len(patient_sessions)
        next_session = next((s for s in patient_sessions if s["status"] == "upcoming"), None)
        # Weeks the booked sessions actually span — package_weeks is only set when a Head
        # Physio recommended a package, so the Review tab falls back to this to know how
        # many weeks it can offer an assessment for.
        weeks = max((s.get("week_number") or 1) for s in patient_sessions) if patient_sessions else 0
        # Which course this patient is on, read off the days they actually have rather
        # than off a package field: rehab is booked without one, and a patient can be
        # running both at once — so this is a list, not a label.
        tracks = sorted({(s.get("track") or "treatment") for s in patient_sessions})

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
            "total_sessions": total,
            "completed_sessions": completed,
            "remaining_sessions": total - completed,
            "next_session": next_session,
            "package_weeks": lead.get("package_weeks"),
            "weeks": weeks,
            "tracks": tracks,
            "physio_stage": lead.get("physio_stage"),
            "consultation_stage": lead.get("consultation_stage"),
            "updated_at": lead.get("updated_at"),
            "reviews_submitted": reviews["submitted"],
            "reviews_reviewed": reviews["reviewed"],
            # The client's weekly star rating of this physio, averaged. No words.
            "star_average": rated.get("average"),
            "star_count": rated.get("count", 0),
        })

    return {"patients": patients}


@router.get("/physio/consultations")
async def physio_consultations(physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev"))):
    """Leads/appointments assigned to this consultant by a branch manager (pre-package consultation pipeline)."""
    doctor = await _resolve_doctor(user, physio_id)
    if not doctor:
        return {"leads": []}

    # The same set the Patients and Review tabs read. This is what the Treatment list
    # matches its day rows against, so a rehab patient missing here left the row drawn from
    # a name-and-id stub with no phone — and the list decides a row is clickable by asking
    # whether the lead has one. It was the third place reading the stamp alone.
    lead_ids = await physio_lead_ids(_ids_of(doctor))
    # Patients this physio is only covering a day for, while a colleague is absent. Sent so
    # the Treatment list can open them, flagged so they stay out of this physio's caseload.
    covering = [i for i in await covering_lead_ids(_ids_of(doctor)) if i not in lead_ids]
    leads = await v3_col("leads").find(
        {"id": {"$in": lead_ids + covering}},
        {"_id": 0},
    ).sort("appointment_datetime", -1).to_list(500)
    day_rows = await v3_col("sessions").find(
        {**own_course_days(_ids_of(doctor)), "lead_id": {"$in": lead_ids}},
        {"_id": 0, "lead_id": 1, "status": 1, "week_number": 1},
    ).to_list(5000)
    tallies: dict = {}
    for row in day_rows:
        t = tallies.setdefault(row["lead_id"], {"total": 0, "completed": 0, "weeks": 0})
        t["total"] += 1
        if row.get("status") == "completed":
            t["completed"] += 1
        # Weeks the plan spans — the highest week any of its days falls in.
        t["weeks"] = max(t["weeks"], row.get("week_number") or 1)

    # Whose closing review is still owed. The Treatment Completed tile was counting a
    # patient the moment their last day was ticked off, which is one step early: the course
    # ends at the Head Physio's review, not at the last day of it, and the tile was calling
    # a patient discharged while the popup behind it still read REVIEW DUE.
    awaiting_review = await leads_awaiting_review(lead_ids)
    stars = await physio_star_ratings(lead_ids, _ids_of(doctor))

    out = []
    for ld in leads:
        dumped = V3LeadOut(**ld).model_dump()
        t = tallies.get(ld["id"], {"total": 0, "completed": 0, "weeks": 0})
        dumped["total_sessions"] = t["total"]
        dumped["completed_sessions"] = t["completed"]
        dumped["weeks"] = t["weeks"]
        dumped["review_pending"] = ld["id"] in awaiting_review
        # The Treatment table's Star Rating column: the client's stars for each week,
        # keyed "treatment:2" / "rehab:1" (star_key), and their average. No words.
        rated = stars.get(ld["id"], {})
        dumped["star_weeks"] = rated.get("weeks", {})
        dumped["star_average"] = rated.get("average")
        dumped["star_count"] = rated.get("count", 0)
        dumped["covering"] = ld["id"] in covering
        out.append(dumped)

    return {
        "leads": out,
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
    }


@router.get("/physio/patient/{lead_id}")
async def physio_patient_detail(lead_id: str, physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev"))):
    """Full record for one of this physio's own assigned patients — backs the Patient
    Detail page's Treatment and Profile tabs (diagnosis, treatment plan, payment fields).
    physio_patients/physio_consultations only ever return a hand-picked subset; this is
    the one place a physio can read everything V3LeadOut carries for their own patient."""
    doctor = await _resolve_doctor(user, physio_id)
    if not doctor:
        raise HTTPException(status_code=404, detail="No physio profile found for this user")

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # Assignment is only one of the two ways a patient becomes this physio's — see
    # physio_owns_lead. Read off the field alone, this refused the record of a rehab
    # patient the physio's own Patients list had just offered them.
    if not await physio_owns_lead(_ids_of(doctor), lead_id):
        raise HTTPException(status_code=403, detail="This lead is not assigned to you")

    return V3LeadOut(**lead).model_dump()


@router.post("/physio/leads/{lead_id}/complete-consultation")
async def physio_complete_consultation(lead_id: str, physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev"))):
    """Physio marks their initial consultation review of an assigned lead as finished."""
    doctor = await _resolve_doctor(user, physio_id)
    if not doctor:
        raise HTTPException(status_code=404, detail="No physio profile found for this user")

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not await physio_owns_lead(_ids_of(doctor), lead_id):
        raise HTTPException(status_code=403, detail="This lead is not assigned to you")

    # Mark Treatment Complete is the one deliberate signal that closes a course -- every
    # board reads physio_stage "Complete" as finished, whatever the days say -- so it is
    # the one that must not run ahead of the Head Physio. Refused here as well as hidden in
    # the popup: the button is the only way in from the UI, but the stage it writes is what
    # the whole OS reads, and a guard that only lives in the popup is a guard the next
    # screen to call this endpoint will not have.
    #
    # Only bites where a review is actually owed. A patient with no treatment days has no
    # course to review and none of this applies to them -- see leads_awaiting_review.
    if lead_id in await leads_awaiting_review([lead_id]):
        raise HTTPException(
            status_code=400,
            detail="The CONSULTANT hasn't reviewed this patient yet — raise it from the Review tab and wait for the review to be written before closing the treatment",
        )

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "physio_stage": "Complete",
        "updated_at": now_iso(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "physio_consultation_completed",
        "details": f"Consultation marked complete by {user.full_name}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated).model_dump()


class ReviewGapInput(BaseModel):
    gap_days: int


@router.put("/physio/leads/{lead_id}/review-gap")
async def physio_set_review_gap(
    lead_id: str,
    payload: ReviewGapInput,
    physio_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    """How many treatment days apart this patient's reviews fall -- the treating physio's
    call, from REVIEW_GAP_CHOICES. Counted from the last review, so a change moves only the
    next one; reviews already raised keep the days they cover."""
    if payload.gap_days not in REVIEW_GAP_CHOICES:
        raise HTTPException(
            status_code=400,
            detail="Review gap must be " + " / ".join(str(g) for g in REVIEW_GAP_CHOICES) + " days",
        )
    doctor = await _resolve_doctor(user, physio_id)
    if not doctor:
        raise HTTPException(status_code=404, detail="No physio profile found for this user")
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not await physio_owns_lead(_ids_of(doctor), lead_id):
        raise HTTPException(status_code=403, detail="This lead is not assigned to you")

    was = review_gap_of(lead)
    now = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "review_gap_days": payload.gap_days,
        "updated_at": now,
    }})
    if was != payload.gap_days:
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "action": "review_gap_changed",
            "details": f"Review gap set to every {payload.gap_days} treatment days (was {was})",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now,
        })
    return {"review_gap_days": payload.gap_days}


@router.get("/physio/sessions/{lead_id}")
async def physio_lead_sessions(lead_id: str, physio_id: Optional[str] = None, user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev", "head_physio", "branch_admin"))):
    # A physio covering an absent colleague's patient (v3_physio_absence) sees only the
    # days handed to them. The whole course came back before, so a patient covered for one
    # date read as the cover's own, every later day of the package open to be worked.
    scope: dict = {}
    if user.role == "physio" or physio_id:
        doctor = await _resolve_doctor(user, physio_id)
        if doctor:
            ids = _ids_of(doctor)
            if lead_id not in await physio_lead_ids(ids):
                scope = {"physio_id": {"$in": ids}, "covered_for_physio_id": {"$exists": True}}
    sessions = await v3_col("sessions").find(
        {"lead_id": lead_id, **scope}, {"_id": 0}
    ).sort("slot_time", 1).to_list(500)
    for row in sessions:
        row.setdefault("track", "treatment")

    # A rehab patient's days live in their own collection, so this popup opened empty for
    # them — the row on the list said Day 1 of 26 and the days behind it were nowhere.
    # Merged in tagged, shaped the way the popup already reads a day, so the list needs no
    # second shape and a rehab day can still say what it is rather than passing as a day of
    # a treatment package the patient may not be on.
    rehab = await v3_col("rehab_sessions").find(
        {"lead_id": lead_id, **scope}, {"_id": 0}
    ).sort("slot_time", 1).to_list(500)
    for row in rehab:
        row["track"] = "rehab"
        row["session_number"] = row.get("day_number")
        row["total_sessions"] = row.get("total_days")
        # Rehab courses are not cut into weeks; leaving this unset would read as week 0.
        row.setdefault("week_number", None)
    sessions = sorted(sessions + rehab, key=lambda r: r.get("slot_time") or "")

    # The client's stars for their Physio, on the treatment day each one belongs to, so
    # the day list can show the rating beside the session it was given for. Stars only.
    stars = await session_star_ratings(lead_id, sessions)
    for row in sessions:
        row["star_ratings"] = stars.get(row.get("id"), [])

    assessments = await v3_col("weekly_assessments").find(
        {"lead_id": lead_id}, {"_id": 0}
    ).sort("week_number", 1).to_list(100)

    # What became of each review this patient's treatment has already earned. The Treatment
    # Days list marks its milestones off this: on its own the popup can only count to seven,
    # so it had to call every milestone "due" — including the ones a Head Physio had already
    # written up, and including the one currently sitting on the Branch Admin's desk.
    review_rows = await v3_col("reviews").find({"lead_id": lead_id}, {"_id": 0}).to_list(100)
    # Numbered across the lead's whole set rather than one row at a time, so the closing
    # review that covers the days a whole-week rule left over does not land on the same
    # milestone as the week before it — see review_numbers_for_lead.
    numbers = review_numbers_for_lead(review_rows)
    reviews = [
        {
            "id": r.get("id"),
            "status": r.get("status"),
            "treatment_days": r.get("treatment_days") or 0,
            # The first day it covers. Absent on reviews raised before the gap was the
            # physio's to pick; the popup then starts it the day after the one before.
            "covers_from_day": r.get("covers_from_day") or 0,
            "final": bool(r.get("final")),
            # Which review of the course this is -- 1st, 2nd, 3rd, in order.
            "review_number": numbers.get(r.get("id"), 1),
            "reason": r.get("reason") or "",
            "physio_notes": r.get("physio_notes") or "",
            "head_physio_name": r.get("head_physio_name") or "",
            # What the CONSULTANT actually wrote back. Sent so Overview can print the
            # week's review beside the rest of the patient's record instead of only its
            # status -- the write-up is the thing the whole review hand-off exists to
            # produce, and reading it meant leaving this popup for the Review tab.
            "head_physio_notes": r.get("head_physio_notes") or "",
            "head_physio_suggestions": r.get("head_physio_suggestions") or "",
            "review_date": r.get("review_date") or "",
            "completed_at": r.get("completed_at") or "",
        }
        for r in review_rows
    ]
    reviews.sort(key=lambda r: r["treatment_days"])

    # The review this patient is due next, if one can be raised now, and when the next one
    # falls due otherwise. Sent rather than re-derived in the popup: it is counted from the
    # last review on a count of distinct calendar dates across both courses, and a second
    # copy of that arithmetic in the browser is a second chance to call a review due that
    # the Review tab will not raise. It holds no day -- it is a reminder, not a gate.
    lead_row = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "review_gap_days": 1})
    gap = review_gap_of(lead_row)
    days_done = (await _completed_day_counts([lead_id])).get(lead_id, 0)
    finished = lead_id in await _finished_course_ids([lead_id])
    elig = _review_eligibility(review_rows, days_done, finished, gap)
    # Every paid session used with a balance owing and no extension from the Branch Admin
    # holds the next day. Treatment days only -- rehab is its own course and fee.
    pay_hold = await payment_hold_for_lead(lead_id)

    return {
        "sessions": sessions,
        "assessments": assessments,
        "reviews": reviews,
        # This patient's gap, and the ones the physio may pick from.
        "review_after_days": gap,
        "review_gap_choices": list(REVIEW_GAP_CHOICES),
        "next_review": {
            "eligible": elig["eligible"],
            "review_number": elig["review_number"],
            "first_day": elig["first_day"],
            "last_day": elig["milestone"],
            "due_at": elig["due_at"],
            "final": elig["final"],
        },
        "payment_hold": pay_hold,
        "payment_hold_message": payment_hold_message(pay_hold) if pay_hold else "",
        # Whether a day may be worked only on its booked date. Switched from the Danger Zone.
        "day_date_lock": await _physio_day_lock_enabled(),
        # A cover is shown only the days handed to them, so those days cannot say how far the
        # course has gone: one covered day, done, read as a finished course and put a final
        # review and Mark Complete on the cover's popup mid-course. The whole course's count
        # and whether it is over are sent beside them for the popup to read instead.
        "covering": bool(scope),
        "course_days_done": days_done if scope else None,
        "course_finished": finished if scope else None,
    }


async def _physio_day_lock_enabled() -> bool:
    """Read straight off the settings row rather than imported from v3_config, which pulls
    in half the routers. Same row and same default (locked) as the Danger Zone switch."""
    row = await v3_col("app_settings").find_one({"id": "physio_day_lock"}, {"_id": 0})
    return True if not row else bool(row.get("locked", True))


async def _resolve_physio_treatments(names) -> list:
    """The picked treatments, resolved to the catalogue's own spelling of each name.

    Super Admin > Services and Products > Physiotherapy Treatment is the only source, so a
    name that is not on it is refused rather than written through: the whole point of
    tagging a day is that the tags across every day are the same handful of words, and one
    typo'd "Ultrsound" would sit in the records forever looking like a treatment of its own.

    Matched case-insensitively and stored as the catalogue spells it, the way the catalogue
    itself de-duplicates on create — a client sending "ift" gets "IFT" back, not a second
    variant of the same treatment.

    Order follows the catalogue, not the order the boxes were ticked, so two days treated
    with the same three things read identically.
    """
    picked = [str(n or "").strip() for n in (names or [])]
    picked = [n for n in picked if n]
    if not picked:
        return []
    catalogue = await v3_col("physio_types").find({}, {"_id": 0, "name": 1}).sort("name", 1).to_list(500)
    by_lower = {(row.get("name") or "").strip().lower(): (row.get("name") or "").strip() for row in catalogue}
    unknown = [n for n in picked if n.lower() not in by_lower]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Not a Physiotherapy Treatment in Services and Products: {', '.join(unknown)}"
            ),
        )
    # Deduped as well as ordered: the same treatment ticked twice is one treatment.
    chosen = {by_lower[n.lower()] for n in picked}
    return [row["name"].strip() for row in catalogue if row.get("name", "").strip() in chosen]


async def _first_incomplete_before(session: dict):
    """The lowest day number before this one that is still not completed, or None.

    Ordered on session_number rather than on the date: a day that has been pushed by an
    absence carries a later date than the day after it until the shift is applied, and
    comparing dates would then call the sequence broken when it is not.
    """
    # Against the day's own course. A rehab course and a treatment package are separate
    # runs of days for the same patient, so judging one by the other has Rehab Day 2 blocked
    # by Treatment Day 1 — two courses that never had an order between them.
    rehab = session.get("track") == "rehab"
    collection = "rehab_sessions" if rehab else "sessions"
    field = "day_number" if rehab else "session_number"
    number = session.get(field) or session.get("session_number") or 0
    rows = await v3_col(collection).find(
        {"lead_id": session.get("lead_id"), "status": {"$ne": "completed"}},
        {"_id": 0, field: 1},
    ).to_list(1000)
    earlier = [r.get(field) or 0 for r in rows if (r.get(field) or 0) < number]
    return min(earlier) if earlier else None


@router.post("/physio/sessions/{session_id}/absent")
async def physio_mark_absent(
    session_id: str,
    payload: V3AbsentSessionInput,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    """The patient did not turn up, so the day moves rather than being lost.

    This day and every uncompleted day after it shift down one place: this day takes the
    next day's slot, that one takes the one after, and so on to the end of the course.
    Moving only the missed one would land it on top of the next day already booked, and the
    package is a count of days of treatment — skipping one would quietly shorten it.

    The days move into each other's slots rather than each sliding one calendar day, which
    is what this did before. Treatment dates are not a run of consecutive days: the Branch
    Admin picks every one of them off the physio's published calendar, so a package can be
    three days a week, and adding a day to each date walks the whole course onto days that
    physio never opened. Stepping along the slots already chosen keeps every remaining day
    on a time that exists.

    That leaves the last day with nowhere to go, so it is left unscheduled and handed back
    to the Branch Admin — the only role that can place a day on a published slot. This is
    the missed class: the patient is still owed all of their days, and the last one now
    needs a date choosing rather than one being invented for it.

    The absence itself is kept on the session and written to the lead's activity, because
    the branch needs to see that a day was missed and when; the schedule moving on its own
    would otherwise be the only trace, and that reads as an admin error rather than a
    patient who did not arrive.
    """
    # A rehab day is a day of its own course, in its own collection. The popup lists both
    # tracks together, so Complete is pressed on either — and this looked only in `sessions`
    # and answered "Session not found" for every rehab day on the board. Marking one absent
    # was the same story.
    session = await v3_col("sessions").find_one({"id": session_id}, {"_id": 0})
    collection = "sessions"
    if not session:
        session = await v3_col("rehab_sessions").find_one({"id": session_id}, {"_id": 0})
        if session:
            collection = "rehab_sessions"
            session["track"] = "rehab"
            # Named the way the rest of this function reads a day, so one body serves both.
            session["session_number"] = session.get("day_number")
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    is_rehab = collection == "rehab_sessions"
    if session["status"] == "completed":
        raise HTTPException(status_code=400, detail="This day is already completed")

    blocking = await _first_incomplete_before(session)
    if blocking is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Day {blocking} has not been completed yet — treatment days are worked in order",
        )

    missed_on = (session.get("slot_time") or "").split("T")[0]
    number = session.get("session_number") or 0

    # This day and everything after it that has not been done. Completed days keep the date
    # they actually happened on.
    # A rehab course numbers its days day_number, not session_number. Read under the wrong
    # name every row came back as day 0, nothing sorted after the missed day, and the
    # absence was recorded while the dates it was supposed to move stayed exactly as they
    # were — the quietest possible failure.
    num_field = "day_number" if is_rehab else "session_number"
    to_move = await v3_col(collection).find(
        {"lead_id": session["lead_id"], "status": {"$ne": "completed"}},
        {"_id": 0, "id": 1, num_field: 1, "slot_time": 1},
    ).to_list(1000)
    later = sorted(
        (r for r in to_move if (r.get(num_field) or 0) >= number),
        key=lambda r: r.get(num_field) or 0,
    )

    # Only the days that still hold a slot take part. A day already waiting on the Branch
    # Admin from an earlier absence has no slot to give away, and stepping through it would
    # hand its emptiness to the day in front — one absence would strand two days instead of
    # one. Those wait where they are; each absence leaves exactly one day to be re-dated.
    dated = [r for r in later if (r.get("slot_time") or "").strip()]

    moved = 0
    for i, row in enumerate(dated):
        next_slot = dated[i + 1]["slot_time"] if i + 1 < len(dated) else ""
        await v3_col(collection).update_one(
            {"id": row["id"]},
            {"$set": {
                "slot_time": next_slot,
                # True on the last one only — the day the course has run out of slots for.
                "needs_assignment": not next_slot,
                "updated_at": now_iso(),
            }},
        )
        moved += 1

    await v3_col(collection).update_one(
        {"id": session_id},
        {"$push": {"absences": {
            "date": missed_on,
            "marked_by": user.full_name,
            "marked_at": now_iso(),
            "remarks": (payload.remarks or "").strip(),
        }}},
    )

    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": session["lead_id"],
        "action": "session_absent",
        "details": (
            f"Day {number} marked absent on {missed_on or 'an unknown date'} by {user.full_name}."
            f" That day and {max(moved - 1, 0)} later day(s) moved down one slot."
            + (
                f" Day {dated[-1].get(num_field)} now needs a date from the Branch Admin."
                if dated else ""
            )
            + (f" Remarks: {payload.remarks.strip()}" if (payload.remarks or "").strip() else "")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })

    updated = await v3_col(collection).find_one({"id": session_id}, {"_id": 0})
    landed = ((updated or {}).get("slot_time") or "").split("T")[0]
    unscheduled_day = dated[-1].get(num_field) if dated else None
    return {
        "session": updated,
        "moved": moved,
        "unscheduled_session_number": unscheduled_day,
        "message": (
            f"Day {number} marked absent — moved to {landed}" if landed
            else f"Day {number} marked absent"
        ) + (
            f". Day {unscheduled_day} now needs a date from the Branch Admin."
            if unscheduled_day and unscheduled_day != number else ""
        ),
    }


@router.post("/physio/sessions/{session_id}/complete")
async def physio_complete_session(
    session_id: str,
    payload: V3CompleteSessionInput,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    # A rehab day is a day of its own course, in its own collection. The popup lists both
    # tracks together, so Complete is pressed on either — and this looked only in `sessions`
    # and answered "Session not found" for every rehab day on the board. Marking one absent
    # was the same story.
    session = await v3_col("sessions").find_one({"id": session_id}, {"_id": 0})
    collection = "sessions"
    if not session:
        session = await v3_col("rehab_sessions").find_one({"id": session_id}, {"_id": 0})
        if session:
            collection = "rehab_sessions"
            session["track"] = "rehab"
            # Named the way the rest of this function reads a day, so one body serves both.
            session["session_number"] = session.get("day_number")
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    is_rehab = collection == "rehab_sessions"
    if session["status"] == "completed":
        raise HTTPException(status_code=400, detail="Session already completed")

    # Treatment runs in order. Day 5 being ticked off while Day 4 is still open means either
    # the wrong row was pressed or a day went unrecorded, and both are worth stopping here:
    # the day count drives the review milestones, so a gap in it quietly moves them.
    blocking = await _first_incomplete_before(session)
    if blocking is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Day {blocking} has not been completed yet — days are completed in order",
        )

    # A review falling due holds no day: the physio raises it when they choose and the
    # course carries on (see _review_eligibility). Only closing the course waits for the
    # reviews to be written -- physio_complete_consultation.

    # The client has had every session they paid for and the balance is still owing. The
    # day waits until it is collected, or until the Branch Admin extends the due date.
    if not is_rehab:
        pay_hold = await payment_hold_for_lead(session["lead_id"])
        if pay_hold:
            raise HTTPException(status_code=400, detail=payment_hold_message(pay_hold))

    # The day's own note is the report. Checked here and not only in the popup: this is
    # what the day-report views read to tell a day that was written up from one that was
    # ticked off, and a session completed through the API with none would read as the latter.
    treatment_remarks = (payload.remarks or "").strip()
    rehab_remarks = (payload.rehab_remarks or "").strip()
    # Each track is required to fill in its own half and no other. A rehab day has no
    # treatment half to write about; a treatment day accepting the rehab note in place of
    # its own let a day be signed off with the one thing it exists to record left blank,
    # and filed under a course it does not belong to — the Head Physio's review and the
    # patient's portal both read the two fields apart.
    if is_rehab and not rehab_remarks:
        raise HTTPException(status_code=400, detail="Rehab Remarks is required")
    if not is_rehab and not treatment_remarks:
        raise HTTPException(status_code=400, detail="Treatment Remarks is required")

    # What was actually given on the day, off the Super Admin catalogue. Not required —
    # see the field's note on V3CompleteSessionInput — but checked against the catalogue
    # when it is sent, so the tags stay a fixed vocabulary rather than free text.
    physio_treatments = await _resolve_physio_treatments(payload.physio_treatments)

    await v3_col(collection).update_one(
        {"id": session_id},
        {"$set": {
            "status": "completed",
            "jr_physio_remarks": treatment_remarks,
            # Stored on both tracks. A rehab day is still a day of hands-on physiotherapy
            # and is worth the same record of what was done on it.
            "physio_treatments": physio_treatments,
            # Kept beside the treatment note rather than folded into it: the Consultant
            # reads the two for different reasons, and one field would make that a
            # matter of how the physio happened to punctuate.
            "rehab_remarks": rehab_remarks,
            # Who wrote the day's report. It was only ever in the activity log's prose,
            # which is not something the Head Physio's day-report view can read a name out
            # of. Rows completed before this stay blank rather than guessing.
            "completed_by": user.full_name,
            "completed_at": now_iso(),
            "updated_at": now_iso(),
        }},
    )

    # Only what was written gets a label in the log; an empty half would otherwise read
    # as "Rehab remarks:" with nothing after it.
    log_parts = []
    if physio_treatments:
        log_parts.append(f"Treatments: {', '.join(physio_treatments)}")
    if treatment_remarks:
        log_parts.append(f"Remarks: {treatment_remarks}")
    if rehab_remarks:
        log_parts.append(f"Rehab remarks: {rehab_remarks}")
    log_remarks = " · ".join(log_parts)

    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": session["lead_id"],
        "action": "session_completed",
        "details": (
            f"{'Rehab Day' if is_rehab else 'Session'} #{session.get('session_number', '?')}"
            f" completed by {user.full_name}. {log_remarks}"
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())

    updated = await v3_col(collection).find_one({"id": session_id}, {"_id": 0})
    # Rehab is its own course with its own fee; only a treatment day draws on the
    # Treatment Fee's paid sessions. Never lets a completed day fail on the way out.
    if not is_rehab and updated is not None:
        try:
            alert = await notify_after_session_complete(session["lead_id"], user.full_name, user.role)
        except Exception:
            alert = None
        if alert:
            updated["payment_alert"] = alert
    return updated


@router.post("/physio/weekly-assessment/{lead_id}/{week_number}")
async def physio_weekly_assessment(
    lead_id: str,
    week_number: int,
    payload: V3JrPhysioWeeklyInput,
    physio_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin")),
):
    existing = await v3_col("weekly_assessments").find_one(
        {"lead_id": lead_id, "week_number": week_number}, {"_id": 0}
    )

    if existing:
        await v3_col("weekly_assessments").update_one(
            {"lead_id": lead_id, "week_number": week_number},
            {"$set": {
                "jr_physio_notes": payload.jr_physio_notes,
                "status": "submitted",
                "submitted_by": user.full_name,
                "updated_at": now_iso(),
            }},
        )
    else:
        doctor = await _resolve_doctor(user, physio_id)
        rec = await v3_col("package_recommendations").find_one({"lead_id": lead_id}, {"_id": 0})
        await v3_col("weekly_assessments").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "branch_id": (doctor.get("branch_id") if doctor else None) or user.branch_id,
            "physio_id": doctor["id"] if doctor else "",
            "head_physio_id": rec.get("head_physio_id", "") if rec else "",
            "week_number": week_number,
            "jr_physio_notes": payload.jr_physio_notes,
            "head_physio_notes": "",
            "head_physio_suggestions": "",
            "status": "submitted",
            "submitted_by": user.full_name,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        })

    updated = await v3_col("weekly_assessments").find_one(
        {"lead_id": lead_id, "week_number": week_number}, {"_id": 0}
    )
    return updated
