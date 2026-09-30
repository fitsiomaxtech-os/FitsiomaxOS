"""Post-treatment Review pipeline.

A patient who has been in treatment for a week is due a Head Physio review. The chain
runs Physio -> Branch Admin -> Head Physio:

    send_to_review   the Physio has raised it; it is waiting on the Branch Admin
    sent             the Branch Admin has dispatched it to a named Head Physio for a date
    completed        that Head Physio has written the review

Each board reads the same records through its own lens: Branch Admin sees the whole
branch, a Head Physio sees only what was dispatched to them.

This lives in its own `reviews` collection rather than on `weekly_assessments`. That one
is keyed (lead_id, week_number) and already carries its own physio->head-physio flow with
no dispatch step; bolting a second state machine onto it would give one collection two
unrelated shapes — exactly what the `sessions` collection did before it took the OS down.
"""
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime, timedelta
import uuid

from database import v3_col
from utils import now_iso, active_doctor_query
from deps import v3_require_roles, works_org_wide
from schemas.v3 import V3UserOut

from physio_scope import physio_lead_ids, resolve_physio_doctor, covering_lead_ids, review_cover_holders

router = APIRouter(prefix="/api/v3")

# A patient becomes due a review once they've been in treatment this many days. Days on the
# calendar, not sessions attended -- see _completed_day_counts.
REVIEW_AFTER_DAYS = 7

SEND_TO_REVIEW = "send_to_review"
SENT = "sent"
COMPLETED = "completed"


class ReviewRaiseInput(BaseModel):
    reason: Optional[str] = ""
    physio_notes: Optional[str] = ""


class ReviewSendInput(BaseModel):
    head_physio_id: str
    review_date: str  # YYYY-MM-DD
    review_time: Optional[str] = None  # HH:MM, from the Head Physio's published slots
    review_duration: Optional[int] = None  # minutes, carried from that slot
    notes: Optional[str] = None  # branch's own note, on top of the physio's


class ReviewCompleteInput(BaseModel):
    head_physio_notes: str
    head_physio_suggestions: Optional[str] = ""


def _today() -> str:
    return date.today().isoformat()


async def _lead_or_404(lead_id: str) -> dict:
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead


async def _review_or_404(review_id: str) -> dict:
    rev = await v3_col("reviews").find_one({"id": review_id}, {"_id": 0})
    if not rev:
        raise HTTPException(status_code=404, detail="Review not found")
    return rev


async def _treatment_days(lead_id: str) -> int:
    """Distinct calendar days this patient has attended treatment on (the field is still
    named treatment_days for compatibility with what's already stored on review docs).

    Days, not sessions. A patient on a rehab course and a treatment package at once is
    booked twice on the same morning -- 8:00 for one, 8:30 for the other -- and counting
    completed rows called that two days of treatment. Four mornings read as eight, the
    week-one review came due on the patient's fourth day, and every milestone after it
    arrived at double speed. The review is about how long the patient has been under
    treatment, and that is a question about the calendar.

    Counted from completed days rather than from the assignment date -- a package booked
    three weeks out is not three weeks of treatment, and the review is about what the
    patient has been through, not how long ago they paid.

    One set across both courses rather than the larger of the two counts. Same-day double
    bookings collapse into one date on their own now, which is the double-counting the
    old max() was there to avoid; taking the union on top of that means a patient seen for
    rehab on Monday and treatment on Tuesday has had two days of treatment, which they
    have. It also lets a patient sent to rehab having never bought a session package reach
    a milestone at all: counting `sessions` alone left them on nought for ever, listed on
    the Review tab and never becoming due.
    """
    return (await _completed_day_counts([lead_id])).get(lead_id, 0)


async def _completed_day_counts(lead_ids: List[str]) -> dict:
    """Per patient, how many distinct calendar days of treatment are behind them.

    One read per collection for the whole list rather than a pair of counts per
    patient: the Review tab asks this of every patient a physio holds, and one at a time
    that is a round trip each.

    The date is the first ten characters of slot_time, which normalize_slot_time stores as
    YYYY-MM-DDTHH:MM -- the same slice _first_session_date takes. A day still waiting on a
    date from the Branch Admin has no slot_time and cannot be completed, but a falsy one is
    dropped rather than trusted to be absent: an empty string would otherwise count as a day
    of its own for every patient who had one.

    Dates fetched and counted here rather than folded into the $group with $substrBytes.
    That operator raises on a value that is not a string and would take the whole Review tab
    down with a 500 over one odd row, and nothing else in this codebase leans on an
    aggregation string operator to say what the deployed server supports. Two fields per
    completed day is little enough to carry.
    """
    lead_ids = [lid for lid in lead_ids if lid]
    if not lead_ids:
        return {}
    days: dict = {}
    for name in ("sessions", "rehab_sessions"):
        rows = await v3_col(name).find(
            {"lead_id": {"$in": lead_ids}, "status": "completed"},
            {"_id": 0, "lead_id": 1, "slot_time": 1},
        ).to_list(100000)
        for r in rows:
            day = str(r.get("slot_time") or "")[:10]
            if day:
                days.setdefault(r["lead_id"], set()).add(day)
    return {lid: len(d) for lid, d in days.items()}


async def _first_session_date(lead_id: str) -> Optional[str]:
    """The day this patient started, on whichever course began first."""
    dates = []
    for name in ("sessions", "rehab_sessions"):
        rows = await v3_col(name).find(
            {"lead_id": lead_id}, {"_id": 0, "slot_time": 1}
        ).sort("slot_time", 1).to_list(1)
        if rows and (rows[0].get("slot_time") or ""):
            dates.append(rows[0]["slot_time"][:10])
    return min(dates) if dates else None


async def _course_progress(lead_ids: List[str]) -> dict:
    """Per patient, per course, how many days are booked and how many are done.

    Two aggregations for the whole list rather than a pair of counts per patient. Both
    _finished_course_ids and leads_awaiting_review want the same numbers about the same
    people, and the Review tab asks it of every patient a physio holds -- counted one at a
    time that is a round trip each, twice over.

    Booked-against-done rows, which is what "has this course finished" is asking; how far
    through treatment the patient is, is a count of calendar days and lives in
    _completed_day_counts. Keyed by track because a course is finished only when BOTH
    tracks are -- see _course_finished.
    """
    lead_ids = [lid for lid in lead_ids if lid]
    if not lead_ids:
        return {}
    progress: dict = {}
    for name, track in (("sessions", "treatment"), ("rehab_sessions", "rehab")):
        rows = await v3_col(name).aggregate([
            {"$match": {"lead_id": {"$in": lead_ids}}},
            {"$group": {
                "_id": "$lead_id",
                "booked": {"$sum": 1},
                "completed": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
            }},
        ]).to_list(20000)
        for r in rows:
            progress.setdefault(r["_id"], {})[track] = {
                "booked": r["booked"], "completed": r["completed"],
            }
    return progress


def _course_finished(tracks: dict) -> bool:
    """Has this patient no day of treatment left to attend?

    Both tracks have to be done, not the further-along one: a patient whose treatment days
    are all completed while rehab days are still to come has not finished their course, and
    closing the book then would close one still being written in.

    At least one day has to have existed. A patient with none booked has not finished a
    course, they have not started one.
    """
    if not tracks:
        return False
    if sum(t["booked"] for t in tracks.values()) <= 0:
        return False
    return all(t["completed"] >= t["booked"] for t in tracks.values())


async def _finished_course_ids(lead_ids: List[str]) -> set:
    """Of these patients, the ones with no day of treatment left to attend."""
    progress = await _course_progress(lead_ids)
    return {lid for lid, tracks in progress.items() if _course_finished(tracks)}


async def leads_awaiting_review(lead_ids: List[str]) -> set:
    """Of these patients, the ones whose days are done but whose review is not.

    Finishing the last booked day is not finishing treatment. Every course earns a closing
    Head Physio review -- _review_eligibility raises one past the last whole week precisely
    so the days a seven-day rule leaves over still get read -- and until that review is
    written the patient is mid-hand-off, not discharged. The boards were calling them
    Completed on the day count alone, which put a patient into the finished column while
    the Head Physio still had them on their desk, and let the Physio Master View close the
    course out from under a review it had raised itself.

    Both an unraised milestone and one already in flight count as owed: `eligible` is the
    first, a review sitting on the Branch Admin's desk or with a Head Physio is the second.
    Neither is a review anybody has written.

    Only asked of finished courses. Mid-course days past the last milestone are days still
    being worked -- nothing calls those patients Completed, and treating a week not yet
    reached as an outstanding review would hold every patient in treatment.

    Returns ids, not a per-lead flag, so the callers that stamp this onto a board's leads
    all ask the same question of the same rules rather than each re-deriving it.
    """
    lead_ids = [lid for lid in lead_ids if lid]
    if not lead_ids:
        return set()
    progress = await _course_progress(lead_ids)
    finished = {lid: tracks for lid, tracks in progress.items() if _course_finished(tracks)}
    if not finished:
        return set()
    rows = await v3_col("reviews").find(
        {"lead_id": {"$in": list(finished)}}, {"_id": 0}
    ).to_list(20000)
    by_lead: dict = {}
    for r in rows:
        by_lead.setdefault(r["lead_id"], []).append(r)

    # Asked only of the finished courses, and in one go. The count has to come off the
    # calendar rather than off the booked/completed rows above: a patient booked twice on
    # one morning has done one day, not two, and reading it from the row counts is what
    # brought the closing review a week early.
    day_counts = await _completed_day_counts(list(finished))

    waiting = set()
    for lid in finished:
        elig = _review_eligibility(by_lead.get(lid, []), day_counts.get(lid, 0), True)
        if elig["eligible"]:
            waiting.add(lid)
        elif (elig["review"] or {}).get("status") in (SEND_TO_REVIEW, SENT):
            waiting.add(lid)
    return waiting


async def review_hold_for_lead(lead_id: str) -> Optional[dict]:
    """The written-up review this patient's NEXT day of treatment is waiting on, if any.

    A week of treatment is read before the next one is worked. Reaching REVIEW_AFTER_DAYS
    days is what makes a review raisable, and until a Head Physio has actually written that
    one up the week just finished has not been read by anybody -- so the days after it are
    held. Without this the milestone was only ever a banner: a physio could work day 8
    through day 14 with week one still sitting on the Review tab untouched, and the review
    that was supposed to shape those days arrived after they had all been given.

    Both an unraised milestone and one in flight hold: a review on the Branch Admin's desk
    or booked with a Head Physio is still a review nobody has written. Same test
    leads_awaiting_review makes of a finished course, asked mid-course instead -- which is
    why course_finished is False here. The closing review covers the days a whole-week rule
    leaves over, and there is no next day for it to hold.

    Returns None when nothing is owed -- fewer than seven days behind them, or the week
    already reviewed -- so the caller reads it as a plain "is the next day held".
    """
    days = await _treatment_days(lead_id)
    if days < REVIEW_AFTER_DAYS:
        return None
    existing = await v3_col("reviews").find({"lead_id": lead_id}, {"_id": 0}).to_list(200)
    elig = _review_eligibility(existing, days, False)
    if elig["milestone"] <= 0:
        return None
    status = (elig["review"] or {}).get("status")
    if not elig["eligible"] and status not in (SEND_TO_REVIEW, SENT):
        return None
    return {
        "review_number": elig["review_number"],
        # The span of days this review covers, so the message and the button can name the
        # week rather than telling a physio "a review" is due and leaving them to count.
        "first_day": elig["milestone"] - REVIEW_AFTER_DAYS + 1,
        "last_day": elig["milestone"],
        # None when it has not been raised at all; otherwise where in the chain it stands.
        "status": None if elig["eligible"] else status,
    }


def review_hold_message(hold: dict) -> str:
    """What to tell a physio whose next day is held, named for where the review stands.

    Three different things to do -- raise it, wait on the Branch Admin, wait on the
    CONSULTANT -- so one message for all three would send two thirds of them to a tab with
    nothing on it to press.
    """
    week = f"days {hold['first_day']}\u2013{hold['last_day']}"
    if hold["status"] == SENT:
        return (
            f"The CONSULTANT hasn't written the week {hold['review_number']} review ({week}) yet"
            " \u2014 the next day can be completed once it is written"
        )
    if hold["status"] == SEND_TO_REVIEW:
        return (
            f"The week {hold['review_number']} review ({week}) is raised and waiting on Branch Admin"
            " to schedule it \u2014 the next day can be completed once the CONSULTANT has written it"
        )
    return (
        f"The week {hold['review_number']} review ({week}) is due"
        " \u2014 raise it from the Review tab and wait for the CONSULTANT to write it"
        " before completing the next day"
    )


def _shape(rev: dict) -> dict:
    return {k: v for k, v in rev.items() if k != "_id"}


def review_numbers_for_lead(reviews: List[dict]) -> dict:
    """Which milestone each of a lead's reviews covers, keyed by review id.

    Taken from the day count stored when each was raised rather than from its position
    among the reviews, because raising is allowed any time after a milestone: a review
    raised on day 9 still covers day 7, and counting positions would name it the wrong week.

    That division alone cannot separate the closing review from the week before it. A
    ten-day course reaches one milestone at day 7 and then ends, so the review covering
    days 8-10 is raised carrying treatment_days 10 -- which divides down to the same 1 as
    the week before it. Both then claimed milestone 1, the day list found nothing for
    milestone 2, and a closing review a CONSULTANT had already written up went on reading
    "Review due" with nothing anyone could do to clear it.

    A remainder cannot be the test either, because the day-9 review has one too and is not
    a closing review. So a number an earlier review already holds moves to the next free
    one -- which is exactly where _review_eligibility puts the closing review when it
    raises it: one past the last whole week.

    Ordered by the day count first, so each week claims its own number before a later
    review goes looking for a free one, then by raised_at and id so the answer is stable
    for two raised at the same count.
    """
    out: dict = {}
    used: set = set()
    ordered = sorted(
        reviews,
        key=lambda r: ((r.get("treatment_days") or 0), r.get("raised_at") or "", r.get("id") or ""),
    )
    for r in ordered:
        number = max(1, (r.get("treatment_days") or 0) // REVIEW_AFTER_DAYS)
        while number in used:
            number += 1
        used.add(number)
        out[r.get("id")] = number
    return out


def _review_eligibility(existing_for_lead: List[dict], treatment_days: int, course_finished: bool = False) -> dict:
    """A new review becomes raisable every REVIEW_AFTER_DAYS treatment days — 7, 14, 21,
    28... not just "7 or more" — so a 28-day course gets exactly 4 review points, one per
    completed week of treatment, rather than staying permanently "due" past day 7.

    treatment_days is a count of calendar days the patient has attended on, from
    _completed_day_counts, not a count of completed rows: two courses running side by side
    put two rows on one morning and that is still one day of treatment.

    milestone: the highest 7-multiple reached so far (0 if none yet), or the final day
    count once the course is over and its last days fall short of another whole week.
    review_number: which review this is — 1st at day 7, 2nd at day 14, etc.
    eligible: whether a *new* review can be raised right now.
    review: the review relevant to explain the current (non-eligible) state — an open
    one in flight, or the most recent completed one still covering this milestone.
    None once a fresh milestone is eligible, since that old review is no longer "current".
    """
    milestone = (treatment_days // REVIEW_AFTER_DAYS) * REVIEW_AFTER_DAYS
    review_number = milestone // REVIEW_AFTER_DAYS if milestone else 0

    # The days a whole-week rule leaves out. A ten-day course reaches one milestone, at
    # day 7, and then ends: days 8, 9 and 10 belong to no week, nothing about them was
    # ever raisable, and the course closed with its last three days never looked at. A
    # course shorter than a week reached no milestone at all and was never reviewed once.
    #
    # Only once the course is over. Mid-course, days past the last milestone are days
    # still being worked, and the next whole week is the right moment to read them --
    # this is the closing review, not an early one.
    if course_finished and treatment_days > milestone:
        milestone = treatment_days
        review_number += 1

    open_review = next((r for r in existing_for_lead if r.get("status") in (SEND_TO_REVIEW, SENT)), None)
    if open_review:
        return {"milestone": milestone, "review_number": review_number, "eligible": False, "review": open_review}

    if milestone == 0:
        return {"milestone": 0, "review_number": 0, "eligible": False, "review": None}

    completed = [r for r in existing_for_lead if r.get("status") == COMPLETED]
    latest_completed = max(completed, key=lambda r: r.get("raised_at") or "", default=None)

    if latest_completed is None or milestone > (latest_completed.get("treatment_days") or 0):
        return {"milestone": milestone, "review_number": review_number, "eligible": True, "review": None}

    return {"milestone": milestone, "review_number": review_number, "eligible": False, "review": latest_completed}


# ---------------------------------------------------------------- Physio: raise a review

@router.get("/physio/reviews")
async def physio_reviews(
    physio_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    """This physio's patients, each with how far through treatment they are and whether a
    review has already been raised — so the Physio can see who is due one."""
    # The same resolver the Treatment and Patients tabs use. This tab had its own, weaker
    # one -- a find_one on user_id with no employee fallback at all -- so a physio whose
    # record carries no link was found by neither, and one whose link sits on a different
    # record of theirs could be found by the board and not by this. Three tabs of one board
    # disagreeing about who is logged in is the shape of the bug, not a detail of it.
    doctor = await resolve_physio_doctor(user.id, user.role, physio_id)
    if not doctor:
        return {"patients": [], "reviews": []}
    # Every record the physio holds, for the reads; the one the board opened on, for what
    # gets written and reported back. See resolve_physio_doctor.
    ids = doctor.get("physio_ids") or [doctor["id"]]
    pid = doctor["id"]

    # Off the shared helper, so a rehab patient is reviewable by the physio treating them.
    # This read the sessions collection alone, which holds treatment days and nothing else.
    lead_ids = await physio_lead_ids(ids)
    # While a colleague is absent, the review goes with the patient to whoever is covering
    # them: an absent physio is not in to raise it, and the cover is the one treating. So a
    # patient of theirs held by a cover leaves this list, and one this physio is covering
    # joins it. See review_cover_holders.
    covering = [i for i in await covering_lead_ids(ids) if i not in lead_ids]
    holders = await review_cover_holders(lead_ids + covering)
    lead_ids = [
        i for i in lead_ids + covering
        if (holders[i] in ids if i in holders else i not in covering)
    ]
    leads = await v3_col("leads").find({"id": {"$in": lead_ids}}, {"_id": 0}).to_list(500)
    # Every review on these patients, not only the ones this physio raised: a review raised
    # by the other physio still covers its week, and missing it would offer the week again.
    existing = await v3_col("reviews").find(
        {"$or": [{"physio_id": {"$in": ids}}, {"lead_id": {"$in": lead_ids}}]}, {"_id": 0},
    ).to_list(2000)
    by_lead: dict = {}
    for r in existing:
        by_lead.setdefault(r["lead_id"], []).append(r)

    finished = await _finished_course_ids(lead_ids)
    # One read for the whole list rather than a round trip per patient — see
    # _completed_day_counts, which is also what leads_awaiting_review reads.
    day_counts = await _completed_day_counts(lead_ids)
    patients = []
    for l in leads:
        days = day_counts.get(l["id"], 0)
        elig = _review_eligibility(by_lead.get(l["id"], []), days, l["id"] in finished)
        rev = elig["review"]
        patients.append({
            "lead_id": l["id"],
            "lead_name": l.get("name", "Unknown"),
            "patient_number": l.get("patient_number", ""),
            "phone": l.get("phone", ""),
            "treatment_days": days,
            "first_session_date": await _first_session_date(l["id"]),
            "milestone": elig["milestone"],
            "review_number": elig["review_number"],
            "due_for_review": elig["eligible"],
            "review_status": rev.get("status") if rev else None,
            "review_id": rev.get("id") if rev else None,
        })
    patients.sort(key=lambda p: (-p["treatment_days"], p["lead_name"]))
    return {"patients": patients, "reviews": [_shape(r) for r in existing], "review_after_days": REVIEW_AFTER_DAYS}


@router.post("/physio/reviews/raise/{lead_id}")
async def physio_raise_review(
    lead_id: str,
    payload: ReviewRaiseInput,
    physio_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("physio", "super_admin", "business_dev")),
):
    """Physio sends a patient up for review. Lands in Branch Admin > Review > Send to Review.
    Only raisable at a fresh 7-treatment-day milestone (7, 14, 21...), counted in calendar
    days attended rather than completed rows — mirrors the same _review_eligibility check
    /physio/reviews uses to decide who shows under New Review."""
    # Enforced here as well as in the form: the Head Physio writes their review off the
    # back of these notes, so a review raised without them cannot be acted on.
    if not (payload.physio_notes or "").strip():
        raise HTTPException(status_code=400, detail="Notes for the CONSULTANT are required")
    lead = await _lead_or_404(lead_id)
    existing_for_lead = await v3_col("reviews").find({"lead_id": lead_id}, {"_id": 0}).to_list(50)
    days = await _treatment_days(lead_id)
    elig = _review_eligibility(existing_for_lead, days, lead_id in await _finished_course_ids([lead_id]))
    if not elig["eligible"]:
        if elig["review"] and elig["review"].get("status") in (SEND_TO_REVIEW, SENT):
            raise HTTPException(status_code=409, detail="This patient already has a review in progress")
        raise HTTPException(status_code=400, detail=f"This patient hasn't reached a new review milestone yet (every {REVIEW_AFTER_DAYS} treatment days)")
    # The client's own star + Treatment Feedback review used to be required here. It no
    # longer is: rating a week is the client's to give or skip in the portal, and a review
    # they never gave held the Physio's hand-off to the Consultant indefinitely.

    doctor = await v3_col("doctors").find_one(
        {"user_id": user.id, "profile_type": "physio"}, {"_id": 0, "id": 1, "full_name": 1}
    )
    pid = physio_id or (doctor or {}).get("id") or ""
    now = now_iso()
    review = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "lead_name": lead.get("name", "Unknown"),
        "patient_number": lead.get("patient_number", ""),
        "phone": lead.get("phone", ""),
        "branch_id": lead.get("branch_id"),
        "physio_id": pid,
        "physio_name": (doctor or {}).get("full_name") or user.full_name,
        "head_physio_id": "",
        "head_physio_name": "",
        "reason": (payload.reason or "").strip(),
        "physio_notes": (payload.physio_notes or "").strip(),
        "treatment_days": days,
        "session_package_name": lead.get("session_package_name", ""),
        "review_date": "",
        "status": SEND_TO_REVIEW,
        "head_physio_notes": "",
        "head_physio_suggestions": "",
        "raised_at": now,
        "sent_at": "",
        "completed_at": "",
        "completed_by": "",
        "created_at": now,
        "updated_at": now,
    }
    await v3_col("reviews").insert_one(review.copy())
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "review_raised",
        "details": f"Physio raised a review after {review['treatment_days']} treatment days"
                   + (f" · {review['reason']}" if review["reason"] else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return _shape(review)


# ------------------------------------------------------- Branch Admin: dispatch a review

@router.get("/branch-admin/reviews/{branch_id}")
async def branch_reviews(
    branch_id: str,
    status: Optional[str] = Query(None, description="send_to_review | sent | completed"),
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Every review on this branch, plus the counts each sub-tab shows on its pill."""
    query: dict = {"branch_id": branch_id}
    if status:
        query["status"] = status
    rows = await v3_col("reviews").find(query, {"_id": 0}).sort("created_at", -1).to_list(2000)

    all_rows = rows if not status else await v3_col("reviews").find(
        {"branch_id": branch_id}, {"_id": 0, "status": 1}
    ).to_list(2000)
    counts = {SEND_TO_REVIEW: 0, SENT: 0, COMPLETED: 0}
    for r in all_rows:
        if r.get("status") in counts:
            counts[r["status"]] += 1

    # Head Physios are org-wide: they take consultations for every branch, so this
    # never narrows by branch_id.
    head_physios = await v3_col("doctors").find(
        active_doctor_query({"profile_type": "head_physio"}), {"_id": 0, "id": 1, "full_name": 1}
    ).to_list(200)

    # Which review of the patient's course each row is -- the table's Review Counts column.
    numbers = await _review_numbers(rows)

    return {
        "branch_id": branch_id,
        "reviews": [{**_shape(r), "review_number": numbers.get(r.get("id"))} for r in rows],
        "counts": counts,
        "head_physios": head_physios,
        "today": _today(),
    }


async def review_bookings(date_prefix: str, exclude_review_id: Optional[str] = None) -> List[dict]:
    """Reviews holding a Consultant's slot, shaped like the appointment rows they sit beside.

    A review sent for a time takes that hour off the Consultant's calendar the same way a
    consultation does. The pickers read taken hours off appointments alone, so the slot a
    review had just been given was still offered to the next review and to consultations.
    `date_prefix` is a date or a month ("2026-09-23" / "2026-09"); the review being
    reassigned is left out so its own slot stays selectable.
    """
    query: dict = {
        "status": {"$in": [SENT, COMPLETED]},
        "head_physio_id": {"$nin": ["", None]},
        "review_date": {"$regex": f"^{date_prefix}"},
        "review_time": {"$nin": ["", None]},
    }
    if exclude_review_id:
        query["id"] = {"$ne": exclude_review_id}
    rows = await v3_col("reviews").find(
        query,
        {"_id": 0, "id": 1, "head_physio_id": 1, "review_date": 1, "review_time": 1,
         "review_duration": 1, "lead_id": 1, "lead_name": 1},
    ).to_list(5000)
    return [
        {
            "doctor_id": r["head_physio_id"],
            "slot_time": f"{r['review_date']}T{r['review_time']}",
            "duration": r.get("review_duration"),
            "lead_id": r.get("lead_id"),
            "lead_name": r.get("lead_name"),
            "review_id": r.get("id"),
        }
        for r in rows
    ]


def _clock(hhmm: str) -> Optional[int]:
    try:
        h, m = (hhmm or "").split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


async def consultant_slot_clash(
    doctor_id: str, slot_time: str, duration: Optional[int] = None,
    exclude_review_id: Optional[str] = None, exclude_lead_id: Optional[str] = None,
    reviews_only: bool = False,
) -> Optional[dict]:
    """Whatever already holds this Consultant across `slot_time` — a consultation or a
    review — or None. Overlap rather than an exact start, so a 45-minute review at 10:15
    also blocks a booking at 10:30. `reviews_only` is for the consultation bookings, which
    already check appointments against each other their own way."""
    day, _, hhmm = (slot_time or "").partition("T")
    start = _clock(hhmm)
    if not day or start is None:
        return None
    length = int(duration or 30)
    appts = [] if reviews_only else await v3_col("appointments").find(
        {"doctor_id": doctor_id, "status": "new_appointment", "slot_time": {"$regex": f"^{day}T"}},
        {"_id": 0, "slot_time": 1, "duration": 1, "lead_id": 1, "lead_name": 1},
    ).to_list(500)
    held = [
        *[a for a in appts if not (exclude_lead_id and a.get("lead_id") == exclude_lead_id)],
        *[r for r in await review_bookings(day, exclude_review_id) if r["doctor_id"] == doctor_id],
    ]
    for row in held:
        t = _clock((row.get("slot_time") or "").split("T")[-1])
        if t is None:
            continue
        if start < t + int(row.get("duration") or 30) and t < start + length:
            return row
    return None


@router.post("/branch-admin/reviews/{review_id}/send")
async def branch_send_review(
    review_id: str,
    payload: ReviewSendInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Hand the review to a named Head Physio for a date."""
    rev = await _review_or_404(review_id)
    if rev.get("status") == COMPLETED:
        raise HTTPException(status_code=400, detail="This review is already completed")
    hp = await v3_col("doctors").find_one(
        {"id": payload.head_physio_id, "profile_type": "head_physio"}, {"_id": 0, "id": 1, "full_name": 1}
    )
    if not hp:
        raise HTTPException(status_code=404, detail="CONSULTANT not found")
    try:
        date.fromisoformat(payload.review_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="review_date must be YYYY-MM-DD") from exc

    # One patient per Consultant hour: a slot another review or a consultation already
    # holds is refused, not double-booked.
    if payload.review_time:
        clash = await consultant_slot_clash(
            hp["id"], f"{payload.review_date}T{payload.review_time}", payload.review_duration,
            exclude_review_id=review_id,
        )
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"{payload.review_time} is already booked with {hp['full_name']}"
                       + (f" for {clash.get('lead_name')}" if clash.get("lead_name") else ""),
            )

    now = now_iso()
    updates = {
        "head_physio_id": hp["id"],
        "head_physio_name": hp["full_name"],
        "review_date": payload.review_date,
        "status": SENT,
        "sent_at": now,
        "sent_by": user.full_name,
        "updated_at": now,
    }
    # The slot is picked from what the Head Physio actually published, so it's stored
    # alongside the date rather than leaving them to work the time out themselves.
    if payload.review_time:
        updates["review_time"] = payload.review_time
        updates["review_duration"] = payload.review_duration
    if payload.notes and payload.notes.strip():
        updates["branch_notes"] = payload.notes.strip()
    await v3_col("reviews").update_one({"id": review_id}, {"$set": updates})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": rev["lead_id"],
        "action": "review_sent",
        "details": f"Review sent to {hp['full_name']} for {payload.review_date}"
                   + (f" at {payload.review_time}" if payload.review_time else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return _shape(await _review_or_404(review_id))


# ------------------------------------------------------- Head Physio: complete a review

async def _review_numbers(rows: List[dict]) -> dict:
    """review_numbers_for_lead for every lead in `rows`, keyed by review id. Numbered
    against every review each lead has, not just the rows passed in, so a week reads the
    same on a filtered board as it does anywhere else."""
    lead_ids = list({r.get("lead_id") for r in rows if r.get("lead_id")})
    if not lead_ids:
        return {}
    every = await v3_col("reviews").find(
        {"lead_id": {"$in": lead_ids}},
        {"_id": 0, "id": 1, "lead_id": 1, "treatment_days": 1, "raised_at": 1},
    ).to_list(5000)
    by_lead: dict = {}
    for r in every:
        by_lead.setdefault(r["lead_id"], []).append(r)
    numbers: dict = {}
    for revs in by_lead.values():
        numbers.update(review_numbers_for_lead(revs))
    return numbers


async def _client_week_stars(rows: List[dict]) -> dict:
    """The client's stars for the week each review covers, keyed by review id -- the Star
    Rating column on the Consultant's Weekly Review table. Week N's review is matched to the
    portal's weekly Physio review for treatment week N (review_numbers_for_lead), stars only.
    Numbered against every review the lead has, not just the ones on this board, so a week
    reads the same here as it does anywhere else."""
    lead_ids = list({r.get("lead_id") for r in rows if r.get("lead_id")})
    if not lead_ids:
        return {}
    numbers = await _review_numbers(rows)
    rated = await v3_col("client_reviews").find(
        {"lead_id": {"$in": lead_ids}, "kind": "physio", "source": "week",
         "track": {"$in": ["treatment", None]}, "skipped": {"$ne": True}},
        {"_id": 0, "lead_id": 1, "week_number": 1, "rating": 1},
    ).to_list(10000)
    by_week = {(c["lead_id"], c.get("week_number")): c["rating"] for c in rated if c.get("rating")}
    return {
        r["id"]: by_week.get((r.get("lead_id"), numbers.get(r.get("id"))))
        for r in rows if r.get("id")
    }


@router.get("/head-physio/reviews")
async def hp_reviews(
    branch_id: Optional[str] = Query(
        None,
        description="Supervisor view: every Consultant's dispatched reviews on this branch. "
                    "The org-wide desks only; a Consultant always gets their own.",
    ),
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    """Reviews dispatched to this Head Physio, split into what's due and what's done.

    A Head Physio assigned to several branches has one doctors record per branch, so this
    matches on every record linked to their login rather than a single doctor id.

    `branch_id` switches that to the branch's whole Consultant queue, which is what a
    Super Admin driving somebody else's board in Operations > Consultant needs. Matching
    on the caller's own doctors records is right for a Consultant reading their own board
    and useless for a supervisor: a Super Admin has no consultant record, so the queue
    came back empty and a review a Branch Admin had just dispatched appeared nowhere —
    while the Consultations list beside it, which has always been branch-scoped, showed
    the same branch's work fine.

    Undispatched reviews are deliberately left out: `head_physio_id` is what makes a review
    somebody's to write, and the ones still waiting on a Branch Admin belong to Branch
    Admin > Review > Send to Review, not to a Consultant's queue.
    """
    docs = await v3_col("doctors").find(
        {"user_id": user.id, "profile_type": "head_physio"}, {"_id": 0, "id": 1}
    ).to_list(50)
    my_ids = [d["id"] for d in docs]

    supervising = bool(branch_id) and works_org_wide(user.role)
    if supervising:
        query: dict = {"head_physio_id": {"$nin": ["", None]}}
        # "all" is the My Consultation picker's every-branch answer, passed straight
        # through; as a branch_id it would match nothing.
        if branch_id != "all":
            query["branch_id"] = branch_id
    elif my_ids:
        query = {"head_physio_id": {"$in": my_ids}}
    else:
        return {"today": [], "upcoming": [], "overdue": [], "completed": [], "today_date": _today()}

    rows = await v3_col("reviews").find(query, {"_id": 0}).sort("review_date", 1).to_list(2000)
    stars = await _client_week_stars(rows)
    # Where the patient is seen, off their lead: the Consultant board splits House Visit
    # patients onto their own tab, reviews included, and a review row carries no visit
    # type of its own.
    lead_ids = list({r.get("lead_id") for r in rows if r.get("lead_id")})
    home_ids = set()
    if lead_ids:
        home = await v3_col("leads").find(
            {"id": {"$in": lead_ids}, "visit_type": "home"}, {"_id": 0, "id": 1}
        ).to_list(len(lead_ids))
        home_ids = {h["id"] for h in home}

    today = _today()
    out = {"today": [], "upcoming": [], "overdue": [], "completed": [], "today_date": today}
    for r in rows:
        r["client_rating"] = stars.get(r.get("id"))
        r["visit_type"] = "home" if r.get("lead_id") in home_ids else "branch"
        if r.get("status") == COMPLETED:
            out["completed"].append(_shape(r))
        elif (r.get("review_date") or "") == today:
            out["today"].append(_shape(r))
        elif (r.get("review_date") or "") < today:
            # Past its date and still not written — surfaced with Today's rather than
            # hidden in a list nobody opens.
            out["overdue"].append(_shape(r))
        else:
            out["upcoming"].append(_shape(r))
    out["completed"].sort(key=lambda r: r.get("completed_at") or "", reverse=True)
    return out


@router.get("/head-physio/reviews/lead/{lead_id}/weeks")
async def hp_lead_week_reviews(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    """Every week's review on one patient, for the Consultant's review popup: the
    clinical review for each week (whoever wrote it) and the client's weekly review form
    (stars and Treatment Feedback). The popup only carried the review it was opened on, so
    the weeks before it -- and what the client had said about each -- were on no screen
    the person writing the next one could reach."""
    revs = await v3_col("reviews").find({"lead_id": lead_id}, {"_id": 0}).to_list(500)
    numbers = review_numbers_for_lead(revs)
    reviews = sorted(
        [{**_shape(r), "review_number": numbers.get(r.get("id"))} for r in revs],
        key=lambda r: r.get("review_number") or 0,
    )
    client = await v3_col("client_reviews").find(
        {"lead_id": lead_id, "kind": "physio", "source": "week", "skipped": {"$ne": True}},
        {"_id": 0, "id": 1, "track": 1, "week_number": 1, "rating": 1, "comment": 1,
         "person_name": 1, "created_at": 1, "updated_at": 1},
    ).to_list(500)
    client.sort(key=lambda c: (c.get("week_number") or 0, c.get("track") or ""))
    return {"reviews": reviews, "client_weeks": client}


@router.post("/head-physio/reviews/{review_id}/complete")
async def hp_complete_review(
    review_id: str,
    payload: ReviewCompleteInput,
    user: V3UserOut = Depends(v3_require_roles("head_physio", "super_admin", "business_dev")),
):
    rev = await _review_or_404(review_id)
    if rev.get("status") == COMPLETED:
        raise HTTPException(status_code=400, detail="This review is already completed")
    if not payload.head_physio_notes.strip():
        raise HTTPException(status_code=400, detail="Review notes are required")

    now = now_iso()
    await v3_col("reviews").update_one({"id": review_id}, {"$set": {
        "head_physio_notes": payload.head_physio_notes.strip(),
        "head_physio_suggestions": (payload.head_physio_suggestions or "").strip(),
        "status": COMPLETED,
        "completed_at": now,
        "completed_by": user.full_name,
        "updated_at": now,
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": rev["lead_id"],
        "action": "review_completed",
        "details": f"CONSULTANT review completed by {user.full_name}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return _shape(await _review_or_404(review_id))
