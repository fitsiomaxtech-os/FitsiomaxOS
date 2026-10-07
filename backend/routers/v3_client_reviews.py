"""Client Reviews — the stars a client gives their Consultant and their Physio.

Kept apart from two things with a similar name:

  * routers/v3_reviews.py is the clinical Review pipeline, the Consultant's review of a
    patient's progress every 7 days of treatment. Nothing to do with what the client thought
    -- though a completed one is what the client's Consultant Review hangs off.
  * routers/v3_feedback.py is the client's conversation with their branch, consultant or
    head office ("Talk to Management"). That is words to be answered; this is a verdict.

Every review is its own row, with a `kind` (who is rated) and a `source` (what prompted it):

  * kind "physio", source "week" -- every 7 days of treatment (or rehab) the client rates
    their Physio: 1-5 stars and Treatment Feedback, one row per week. A week is due once
    every day in it is completed; the portal's Sessions tab then asks in a pop-up for each
    due week finished since PHYSIO_REVIEW_START. Not mandatory, and it holds nothing:
    Skip stops the asking for that week (SKIPS_COLLECTION), and the week's Review button
    still opens it whenever the client chooses. The Physio's Send to Review does not wait
    on any of it -- it did until 2026-09-22, and a review the client never gave stranded
    the patient there. The Physio reads the stars only -- never the words (see
    physio_star_ratings). Weekly reviews briefly also rated the Consultant; those rows
    stay readable but are no longer asked for.
  * source "anytime" -- from the Feedback tab. The Physio whenever the client wants; the
    Consultant and the Branch Admin once only (ONCE_KINDS), and never changed after.
  * kind "branch_admin", source "anytime" -- the client's stars for their branch desk, from
    the Feedback tab's Branch Admin card (Review, beside Chat). Rated against the branch,
    not one login: `branch_id` is who it is about, and HR Performance credits it to every
    Branch Admin posted there.
  * source "session" / "review" -- the earlier per-session Physio and per-clinical-Review
    Consultant rows. No longer written, still read by management.

Rows written by the first flow (one row per client with both ratings, no `kind`) are still
read by management: list_client_reviews splits each into its consultant and physio halves.

Read by management only: Super Admin and BDE across every branch, a Branch Admin for their
own branch. (The Branch Admin read every branch from 2026-09-21 to 2026-10-07; pinned back by
request, so their Client Reviews tab answers for their own Physios only.) BDE is admitted by
BDE_ROLES rather than the one slug: the Business Development
Executive is `business_dev`, but a login created before migrate_designation_roles ran still
holds the typed `business_development_executive` (see DEFAULT_ROLES in routers/v3_hr.py),
and that desk reads these figures for the company.
"""

import uuid
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from database import v3_col
from deps import v3_require_roles, is_branch_admin_role, is_head_physio_role
from physio_scope import consultant_of_lead, resolve_consultant_doctor
from routers.v3_feedback import _rating
from routers.v3_patient_portal import _current_patient_lead_id, _lead_or_404
from schemas.v3 import V3UserOut
from utils import clinic_day_of, now_iso

router = APIRouter(prefix="/api/v3")

COLLECTION = "client_reviews"
# Weeks whose review pop-up the client skipped: {lead_id, track, week_number, skipped_at}.
SKIPS_COLLECTION = "client_review_skips"
MAX_TEXT = 2000

KIND_PHYSIO = "physio"
KIND_CONSULTANT = "consultant"
KIND_BRANCH = "branch_admin"
ANYTIME_KINDS = (KIND_CONSULTANT, KIND_PHYSIO, KIND_BRANCH)
# Reviewed from the Feedback tab one time only per client.
ONCE_KINDS = (KIND_CONSULTANT, KIND_BRANCH)
SOURCE_WEEK = "week"
SOURCE_ANYTIME = "anytime"

TRACKS = ("treatment", "rehab")
DAYS_PER_WEEK = 7

# Weeks finished on or after this are the ones a client must rate.
PHYSIO_REVIEW_START = "2026-09-16"

BDE_ROLES = ("business_dev", "business_development_executive")


class WeekReviewIn(BaseModel):
    track: str = "treatment"
    week_number: int
    rating: Optional[int] = None
    comment: Optional[str] = ""


class AnytimeReviewIn(BaseModel):
    target: str
    rating: Optional[int] = None
    comment: Optional[str] = ""


def _text(value) -> str:
    return str(value or "").strip()[:MAX_TEXT]


def required_rating(value) -> int:
    rating = _rating(value)
    if rating is None:
        raise HTTPException(status_code=400, detail="Tap the stars to give a rating")
    return rating


def required_comment(value, who: str) -> str:
    text = _text(value)
    if not text:
        raise HTTPException(status_code=400, detail=f"Write a few words of feedback for your {who}")
    return text


def week_of(day: dict) -> int:
    """The review week a day sits in: every 7 days by number -- Days 1-7 are Week 1, 8-14
    Week 2 -- the same interval as the Consultant review (REVIEW_AFTER_DAYS). Not the
    booked `week_number`, which follows the calendar: a course starting mid-week split 14
    days into three weeks (1-6, 7-13, 14) and asked for a third review."""
    number = day.get("session_number") or day.get("day_number") or 1
    return (int(number) - 1) // DAYS_PER_WEEK + 1


def course_weeks(days: List[dict]) -> List[dict]:
    """Every week of both courses: its day range, whether every day is completed, when it
    finished, and the physio of its last completed day. `days` each carry `track`."""
    groups: Dict[tuple, List[dict]] = {}
    for d in days:
        track = d.get("track") or "treatment"
        groups.setdefault((track, week_of({**d, "track": track})), []).append(d)
    out = []
    for (track, week), rows in groups.items():
        done = [r for r in rows if r.get("status") == "completed"]
        complete = len(done) == len(rows)
        last = max(done, key=lambda r: str(r.get("completed_at") or r.get("slot_time") or "")) if done else {}
        numbers = [n for n in (r.get("session_number") or r.get("day_number") for r in rows) if n is not None]
        slots = [str(r.get("slot_time") or "") for r in rows if r.get("slot_time")]
        out.append({
            # The last day's date: the review opens once that day is done.
            "opens_on": max(slots)[:10] if slots else "",
            "track": track,
            "week_number": week,
            "first_number": min(numbers) if numbers else None,
            "last_number": max(numbers) if numbers else None,
            "days": len(rows),
            "completed_days": len(done),
            "complete": complete,
            "finished_at": str(last.get("completed_at") or last.get("slot_time") or "") if complete else "",
            "physio_id": _text(last.get("physio_id")),
            "physio_name": _text(last.get("physio_name") or last.get("completed_by")),
        })
    out.sort(key=lambda w: (TRACKS.index(w["track"]) if w["track"] in TRACKS else len(TRACKS), w["week_number"]))
    return out


def pending_weeks(weeks: List[dict], rows: List[dict],
                  skipped: Optional[set] = None, since: str = PHYSIO_REVIEW_START) -> List[dict]:
    """Completed weeks, finished since `since`, oldest first, with no Physio review yet and
    not skipped. Pass `skipped` as None to get every unreviewed week, skips included."""
    given = {(r.get("track"), r.get("week_number"))
             for r in rows if r.get("source") == SOURCE_WEEK and r.get("kind") == KIND_PHYSIO}
    skipped = skipped or set()
    out = []
    for w in weeks:
        key = (w["track"], w["week_number"])
        if not w["complete"] or w["finished_at"][:10] < since or key in skipped or key in given:
            continue
        out.append(w)
    out.sort(key=lambda w: w["finished_at"])
    return out


async def skipped_weeks(lead_id: str) -> set:
    """The weeks whose review pop-up this client skipped, as (track, week_number)."""
    rows = await v3_col(SKIPS_COLLECTION).find({"lead_id": lead_id}, {"_id": 0}).to_list(500)
    return {(s.get("track"), s.get("week_number")) for s in rows}


def star_key(track: str, week_number) -> str:
    return f"{track or 'treatment'}:{week_number}"


async def physio_star_ratings(lead_ids: List[str], physio_ids: List[str]) -> Dict[str, dict]:
    """What a Physio may see of their clients' reviews: the stars, per week and on average,
    for each lead. Never the words -- those are read by management and the Consultant
    (Client Reviews), and are left out of the projection so they cannot leak.

    `weeks` is the weekly reviews. `average` counts those and the star reviews of the
    Physio from the portal's Feedback tab (source "anytime") alike. Only reviews of this
    Physio; a row with no physio on it is counted for whoever is treating the client now."""
    if not lead_ids:
        return {}
    rows = await v3_col(COLLECTION).find(
        {"lead_id": {"$in": lead_ids}, "kind": KIND_PHYSIO, "source": {"$in": [SOURCE_WEEK, SOURCE_ANYTIME]},
         "skipped": {"$ne": True}, "person_id": {"$in": list(physio_ids) + ["", None]}},
        {"_id": 0, "lead_id": 1, "source": 1, "track": 1, "week_number": 1, "rating": 1},
    ).to_list(10000)
    out: Dict[str, dict] = {}
    for r in rows:
        if not r.get("rating"):
            continue
        entry = out.setdefault(r["lead_id"], {"weeks": {}, "values": []})
        if r.get("source") == SOURCE_WEEK:
            entry["weeks"][star_key(r.get("track"), r.get("week_number"))] = r["rating"]
        entry["values"].append(r["rating"])
    return {
        lid: {"weeks": e["weeks"], "average": _average(e["values"]), "count": len(e["values"])}
        for lid, e in out.items()
    }


async def session_star_ratings(lead_id: str, days: List[dict]) -> Dict[str, List[int]]:
    """The client's stars for their Physio, pinned to the treatment day each was given on,
    keyed by session id. Stars only, like physio_star_ratings -- never the words.

    A weekly review lands on the last day of the week it rates: that is the day whose
    completion opened it. A Feedback-tab (anytime) review lands on the day booked on the
    clinic date it was given, or failing that the latest day before it. Only reviews of the
    Physio on that day; a row with no physio on it counts for whoever treated that day."""
    if not days:
        return {}
    rows = await v3_col(COLLECTION).find(
        {"lead_id": lead_id, "kind": KIND_PHYSIO, "source": {"$in": [SOURCE_WEEK, SOURCE_ANYTIME]},
         "skipped": {"$ne": True}},
        {"_id": 0, "source": 1, "track": 1, "week_number": 1, "rating": 1, "person_id": 1,
         "created_at": 1, "updated_at": 1},
    ).to_list(1000)

    def number(d):
        return int(d.get("session_number") or d.get("day_number") or 0)

    last_of_week: Dict[str, dict] = {}
    for d in days:
        key = star_key(d.get("track") or "treatment", week_of(d))
        if key not in last_of_week or number(d) > number(last_of_week[key]):
            last_of_week[key] = d
    dated = sorted((d for d in days if d.get("slot_time")), key=lambda d: str(d["slot_time"]))

    out: Dict[str, List[int]] = {}
    for r in rows:
        if not r.get("rating"):
            continue
        if r.get("source") == SOURCE_WEEK:
            day = last_of_week.get(star_key(r.get("track"), r.get("week_number")))
        else:
            when = clinic_day_of(r.get("created_at") or r.get("updated_at"))
            before = [d for d in dated if when and str(d["slot_time"])[:10] <= when]
            same = [d for d in before if str(d["slot_time"])[:10] == when]
            day = (same or before or [None])[-1]
        if not day or not day.get("id"):
            continue
        person = _text(r.get("person_id"))
        if person and _text(day.get("physio_id")) and person != _text(day.get("physio_id")):
            continue
        out.setdefault(day["id"], []).append(r["rating"])
    return out


async def _course_days(lead_id: str) -> List[dict]:
    fields = {"_id": 0, "id": 1, "status": 1, "completed_at": 1, "slot_time": 1, "session_number": 1,
              "day_number": 1, "week_number": 1, "physio_id": 1, "physio_name": 1, "completed_by": 1}
    treatment = await v3_col("sessions").find({"lead_id": lead_id}, fields).to_list(500)
    rehab = await v3_col("rehab_sessions").find({"lead_id": lead_id}, fields).to_list(300)
    return [{**d, "track": "treatment"} for d in treatment] + [{**d, "track": "rehab"} for d in rehab]


async def care_team(lead: dict) -> Dict[str, Dict[str, str]]:
    """The consultant who saw this client and the physio treating them -- who an anytime
    review can be about. The physio is the one on the lead, else the newest session's."""
    consultant = await consultant_of_lead(lead)
    physio_id = _text(lead.get("assigned_physio_id"))
    physio_name = _text(lead.get("assigned_physio_name"))
    if not physio_name:
        session = await v3_col("sessions").find_one(
            {"lead_id": lead.get("id"), "physio_name": {"$nin": [None, ""]}},
            {"_id": 0, "physio_name": 1, "physio_id": 1},
            sort=[("slot_time", -1)],
        ) or {}
        physio_name = _text(session.get("physio_name"))
        physio_id = physio_id or _text(session.get("physio_id"))
    return {
        "consultant": {"id": consultant["id"], "name": consultant["name"]},
        "physio": {"id": physio_id, "name": physio_name},
    }


def _base_row(lead: dict, kind: str, source: str) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "source": source,
        "lead_id": lead.get("id"),
        "branch_id": lead.get("branch_id"),
        "patient_name": _text(lead.get("name")),
        "patient_phone": _text(lead.get("phone")),
        "patient_number": lead.get("patient_number"),
        "created_at": now_iso(),
    }


async def _upsert(lead: dict, kind: str, source: str, match: dict, fields: dict) -> dict:
    """One row per thing reviewed: saving the same week again changes it."""
    existing = await v3_col(COLLECTION).find_one({"lead_id": lead["id"], "kind": kind, **match}, {"_id": 0})
    if existing:
        changes = {**fields, "updated_at": now_iso()}
        await v3_col(COLLECTION).update_one({"id": existing["id"]}, {"$set": changes})
        return {**existing, **changes}
    row = {**_base_row(lead, kind, source), **match, **fields}
    await v3_col(COLLECTION).insert_one(dict(row))
    return row


def _average(values: List[int]) -> Optional[float]:
    return round(sum(values) / len(values), 1) if values else None


def split_legacy(row: dict) -> List[dict]:
    """An old one-row-per-client review, as the consultant and physio rows it now reads as."""
    if row.get("kind"):
        return [row]
    out = []
    when = row.get("updated_at") or row.get("created_at")
    common = {k: row.get(k) for k in ("lead_id", "branch_id", "patient_name", "patient_phone", "patient_number")}
    for kind in (KIND_CONSULTANT, KIND_PHYSIO):
        if row.get(f"{kind}_rating"):
            comment = row.get(f"{kind}_comment") or ""
            if row.get("summary"):
                comment = f"{comment}\n\nSummary: {row['summary']}".strip()
            out.append({
                **common, "id": f"{row.get('id')}-{kind}", "kind": kind, "source": SOURCE_ANYTIME, "legacy": True,
                "person_id": row.get(f"{kind}_id") or "", "person_name": row.get(f"{kind}_name") or "",
                "rating": row.get(f"{kind}_rating"), "comment": comment, "created_at": when,
            })
    return out


def summarise(rows: List[dict]) -> dict:
    """Headline figures and a per-person breakdown for one kind of review.

    Grouped by name rather than id: a consultant can hold twin expert records across
    branches (see resolve_consultant_doctor), and management reads a person, not a record.
    """
    rated = [r for r in rows if r.get("rating") and not r.get("skipped")]
    people: Dict[str, List[int]] = {}
    for r in rated:
        name = _text(r.get("person_name"))
        if name:
            people.setdefault(name, []).append(r["rating"])
    by_person = sorted(
        ({"name": n, "count": len(s), "average": _average(s)} for n, s in people.items()),
        key=lambda p: (-(p["average"] or 0), -p["count"], p["name"]),
    )
    return {
        "total": len(rated),
        "average": _average([r["rating"] for r in rated]),
        "low": sum(1 for r in rated if r["rating"] <= 2),
        "anytime": sum(1 for r in rated if r.get("source") == SOURCE_ANYTIME),
        "people": by_person,
    }


# ------------------------------------------------------------------ Client Portal side

@router.get("/patient-portal/review")
async def portal_my_review(lead_id: str = Depends(_current_patient_lead_id)):
    """Everything the Sessions tab's Review buttons, its pop-up and the Feedback tab draw from."""
    lead = await _lead_or_404(lead_id)
    rows = await v3_col(COLLECTION).find(
        {"lead_id": lead_id, "kind": {"$in": list(ANYTIME_KINDS)}, "skipped": {"$ne": True}}, {"_id": 0}
    ).sort("created_at", -1).to_list(1000)
    team = await care_team(lead)
    weeks = course_weeks(await _course_days(lead_id))
    week_rows = [r for r in rows if r.get("source") == SOURCE_WEEK]
    return {
        **team,
        "weeks": weeks,
        # What the pop-up asks for: unreviewed and not skipped.
        "weeks_pending": pending_weeks(weeks, week_rows, await skipped_weeks(lead_id)),
        # Skipped ones too: the week's own Review button keeps offering them afterwards.
        "weeks_unreviewed": pending_weeks(weeks, week_rows),
        "week_reviews": week_rows,
        "anytime_reviews": [r for r in rows if r.get("source") == SOURCE_ANYTIME],
    }


class WeekSkipIn(BaseModel):
    track: str = "treatment"
    week_number: int


@router.post("/patient-portal/review/week/skip")
async def portal_skip_week(payload: WeekSkipIn, lead_id: str = Depends(_current_patient_lead_id)):
    """The client closed a week's review pop-up with Skip. It stops asking for that week and
    releases the Physio's Send to Review; the week's Review button still opens it whenever
    they choose, and reviewing it then saves as normal."""
    if payload.track not in TRACKS:
        raise HTTPException(status_code=400, detail="Unknown course")
    await _lead_or_404(lead_id)
    match = {"lead_id": lead_id, "track": payload.track, "week_number": payload.week_number}
    await v3_col(SKIPS_COLLECTION).update_one({**match}, {"$set": {**match, "skipped_at": now_iso()}}, upsert=True)
    return {"message": "Skipped. You can review this week any time from Sessions."}


@router.post("/patient-portal/review/week")
async def portal_review_week(payload: WeekReviewIn, lead_id: str = Depends(_current_patient_lead_id)):
    """Stars and Treatment Feedback for the Physio on one completed week. Sending again
    changes it. Kept in Client Reviews only -- not filed to Patient Feedback, which is the
    client's conversation with the clinic rather than a verdict on a week."""
    if payload.track not in TRACKS:
        raise HTTPException(status_code=400, detail="Unknown course")
    lead = await _lead_or_404(lead_id)
    week = next((
        w for w in course_weeks(await _course_days(lead_id))
        if w["track"] == payload.track and w["week_number"] == payload.week_number
    ), None)
    if not week:
        raise HTTPException(status_code=404, detail="Week not found")
    if not week["complete"]:
        raise HTTPException(status_code=400, detail="You can review this week once all its sessions are completed")

    rating = required_rating(payload.rating)
    comment = required_comment(payload.comment, "physio")
    team = await care_team(lead)
    row = await _upsert(lead, KIND_PHYSIO, SOURCE_WEEK, {"track": week["track"], "week_number": week["week_number"]}, {
        "rating": rating,
        "comment": comment,
        "week_first_number": week["first_number"],
        "week_last_number": week["last_number"],
        "session_date": week["finished_at"],
        "person_id": week["physio_id"] or team["physio"]["id"],
        "person_name": week["physio_name"] or team["physio"]["name"],
        # The patient's consultant, so their Review tab can find it.
        "consultant_id": team["consultant"]["id"],
        "consultant_name": team["consultant"]["name"],
    })
    return {"message": f"Thank you for reviewing week {week['week_number']}.", "review": row}


@router.post("/patient-portal/review/anytime")
async def portal_review_anytime(payload: AnytimeReviewIn, lead_id: str = Depends(_current_patient_lead_id)):
    """A review of the Consultant, the Physio or the Branch Admin from the Feedback tab.
    The Physio as often as the client wants; the Consultant and Branch Admin once only."""
    if payload.target not in ANYTIME_KINDS:
        raise HTTPException(status_code=400, detail="Choose who you are reviewing")
    lead = await _lead_or_404(lead_id)
    if payload.target in ONCE_KINDS and await v3_col(COLLECTION).find_one(
        {"lead_id": lead_id, "kind": payload.target, "source": SOURCE_ANYTIME, "skipped": {"$ne": True}},
        {"_id": 0, "id": 1},
    ):
        who = "Branch Admin" if payload.target == KIND_BRANCH else "Consultant"
        raise HTTPException(status_code=409, detail=f"You have already reviewed your {who}. A review can be given only once.")
    rating = required_rating(payload.rating)
    if payload.target == KIND_BRANCH:
        person = await _branch_desk(lead)
    else:
        person = (await care_team(lead))[payload.target]
    if not person["name"]:
        raise HTTPException(status_code=400, detail=f"You do not have a {payload.target} yet")
    row = {
        **_base_row(lead, payload.target, SOURCE_ANYTIME),
        "rating": rating,
        "comment": _text(payload.comment),
        "person_id": person["id"],
        "person_name": person["name"],
    }
    await v3_col(COLLECTION).insert_one(dict(row))
    return {"message": "Thank you for your review.", "review": row}


async def _branch_desk(lead: dict) -> Dict[str, str]:
    """Who a Branch Admin review is about: the client's branch, by name."""
    branch_id = _text(lead.get("branch_id"))
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "branch_name": 1}) if branch_id else None
    name = _text((branch or {}).get("branch_name"))
    return {"id": branch_id, "name": f"{name} Branch Admin" if name else ("Branch Admin" if branch_id else "")}


# ------------------------------------------------------------------ Management side

async def _for_consultant(rows: List[dict], consultant_ids: set) -> List[dict]:
    """The rows about a consultant's own patients. Weekly reviews carry the consultant they
    were given under; older rows do not, so theirs is worked out from the lead, once per lead."""
    by_lead: Dict[str, str] = {}
    out = []
    for r in rows:
        cid = r.get("consultant_id")
        if not cid and r.get("kind") == KIND_CONSULTANT:
            cid = r.get("person_id")
        if not cid and r.get("lead_id"):
            if r["lead_id"] not in by_lead:
                lead = await v3_col("leads").find_one({"id": r["lead_id"]}, {"_id": 0})
                by_lead[r["lead_id"]] = (await consultant_of_lead(lead))["id"] if lead else ""
            cid = by_lead[r["lead_id"]]
        if cid in consultant_ids:
            out.append(r)
    return out


@router.get("/client-reviews")
async def list_client_reviews(
    branch_id: Optional[str] = Query(None),
    user: V3UserOut = Depends(v3_require_roles("super_admin", *BDE_ROLES, "branch_admin", "head_physio")),
):
    """Every review management may read, split into Consultant, Physio and Branch Admin Review.

    A Branch Admin is always held to their own branch, whatever they pass. Super Admin and
    BDE read every branch and may narrow to one. A Consultant reads their own patients'
    reviews, across branches -- never the Branch Admin ones, which are about the desk.
    """
    empty = summarise([])
    nothing = {"consultant": [], "physio": [], "branch_admin": [],
               "summary": {"consultant": empty, "physio": empty, "branch_admin": empty}}
    query: dict = {"skipped": {"$ne": True}}
    consultant_ids = None
    if is_head_physio_role(user.role):
        doctor = await resolve_consultant_doctor(user.id, user.role)
        consultant_ids = set((doctor or {}).get("consultant_ids") or [])
        if not consultant_ids:
            return nothing
        if branch_id:
            query["branch_id"] = branch_id
    elif is_branch_admin_role(user.role):
        if not user.branch_id:
            return nothing
        query["branch_id"] = user.branch_id
    elif branch_id:
        query["branch_id"] = branch_id

    raw = await v3_col(COLLECTION).find(query, {"_id": 0}).to_list(10000)
    if consultant_ids is not None:
        raw = await _for_consultant([r for r in raw if r.get("kind") != KIND_BRANCH], consultant_ids)
    rows = [r for row in raw for r in split_legacy(row)]
    rows.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or "", reverse=True)

    branch_ids = {r.get("branch_id") for r in rows if r.get("branch_id")}
    names = {
        b["id"]: b.get("branch_name") or ""
        for b in await v3_col("branches").find(
            {"id": {"$in": list(branch_ids)}}, {"_id": 0, "id": 1, "branch_name": 1}
        ).to_list(500)
    } if branch_ids else {}
    for r in rows:
        r["branch_name"] = names.get(r.get("branch_id"), "")

    consultant = [r for r in rows if r.get("kind") == KIND_CONSULTANT]
    physio = [r for r in rows if r.get("kind") == KIND_PHYSIO]
    branch = [r for r in rows if r.get("kind") == KIND_BRANCH]
    return {
        "consultant": consultant,
        "physio": physio,
        "branch_admin": branch,
        "summary": {"consultant": summarise(consultant), "physio": summarise(physio), "branch_admin": summarise(branch)},
    }
