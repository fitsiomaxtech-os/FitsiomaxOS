"""Every Working day open for the branch's experts, without anybody opening it.

The Monthly Calendar (MANAGEMENT → CALENDAR, and the profile page's tab) is the one place a
Branch Admin says which days the branch works. It used to stop there: a Working day was
merely *allowed* on the Consultant, Physiotherapist and Nutritionists calendars, and was not
open for anybody until the Branch Admin went into each of the three, picked each person, picked
the days and saved. A branch with ten experts did that ten times a month, and a day somebody
forgot was a day nobody could be booked.

Now the server does it. On every Working day, each Consultant, Physiotherapist and Nutritionist
on the branch's Team is open across their own shift (TIME MANAGEMENT): the day's one-off shift
if it has one, else their usual one, else the branch's own hours for that day as the Monthly
Calendar shows them. A Leave day opens nobody — and marking one closes what was open, in
v3_branch_calendar.

The exception is per person and is made where it always was: on that person's calendar,
picking the day and taking it off (Mark not available / Unsave). That is remembered as one of
their `days_off`, and nothing here opens the day again until somebody re-opens it there.

What is written is exactly what a hand-opened day was — `slots` and `slot_details` on the
expert's `doctors` row — because every booking picker in the OS reads those. Two fields say how
each day got there:

    auto_days  {date: signature}  days this module opened, and the window and slot length it
                                  opened them across. A day whose signature no longer matches
                                  (shift changed, session length changed) is re-cut: the slots
                                  outside the new window go, unless a patient is booked into one.
    days_off   [date]             days the person was taken off by hand. Never filled.

A day with slots that is in neither is a day somebody opened or edited by hand, and is left
exactly as it is. Any hand edit on the calendar hands the day over to that — see the add and
remove endpoints in v3_head_physio.

A CONSULTANT who takes consultations at more than one branch, and the Super Admin, are not
filled. They hold one calendar for every branch they work, so "this branch works on Tuesday"
does not mean they are at this branch on Tuesday; their days are still opened by hand.
"""
import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Set

import store_branch_overrides
from branch_calendar import WORKING, day_status
from database import v3_col
from shift_utils import day_windows_of, override_shift_ids, parse_hhmm, shift_ids_of, shift_map, window_of
from utils import CLINIC_UTC_OFFSET, now_iso, now_utc

logger = logging.getLogger(__name__)

# The three calendars the Monthly Calendar now drives.
PROFILES = ("head_physio", "physio", "nutrition_coach")

# How far ahead days are kept open. Rolled forward by the loop below, so day 61 opens tomorrow.
HORIZON_DAYS = 60
# Days this module opened and that have since gone by this far are taken off again — the
# unbooked slots on them, which nobody can book any more. Without it every expert's row grows by
# a working day's slots every day, for ever, and every calendar that loads the row pays for it.
KEEP_PAST_DAYS = 31

FALLBACK_MINUTES = 30

# The same values the calendar's own Save writes, so a filled slot reads like a hand-opened one.
SLOT_TYPE = {"head_physio": "initial", "physio": "session", "nutrition_coach": "session"}
# Where each calendar's slot length comes from in FITSIO STORE (see HeadPhysioCalendar).
STORE_ITEM_TYPE = {"head_physio": "consultation", "physio": "session", "nutrition_coach": "session"}

# How often the loop goes round every branch.
SWEEP_SECONDS = 6 * 60 * 60
# Opening a calendar fills its branch, but not more often than this.
THROTTLE_SECONDS = 120

BOOKING_SOURCES = (
    ("appointments", "doctor_id", "new_appointment"),
    ("sessions", "physio_id", "upcoming"),
    ("rehab_sessions", "physio_id", "upcoming"),
    ("diet_sessions", "coach_id", "upcoming"),
)


def clinic_today() -> str:
    return (now_utc() + CLINIC_UTC_OFFSET).date().isoformat()


def _shift_date(date_str: str, days: int) -> str:
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)).date().isoformat()


async def store_minutes(item_type: str, branch_id: Optional[str]) -> Optional[int]:
    """FITSIO STORE's length for one kind of slot — the pick pickStoreMinutes makes in the browser.

    A physiotherapy item before any other shelf, then the one edited last, with the branch's own
    durations laid over the catalogue where it keeps them.
    """
    query = {"item_type": {"$in": ["consultation", None]}} if item_type == "consultation" else {"item_type": item_type}
    rows = await v3_col("store_items").find(
        query, {"_id": 0, "id": 1, "category": 1, "duration_minutes": 1, "updated_at": 1, "created_at": 1},
    ).to_list(500)
    rows = await store_branch_overrides.overlay(rows, branch_id)
    rows = [r for r in rows if (r.get("duration_minutes") or 0) > 0]
    if not rows:
        return None
    rows.sort(
        key=lambda r: (r.get("category") in (None, "", "physiotherapy"), r.get("updated_at") or r.get("created_at") or ""),
        reverse=True,
    )
    return int(rows[0]["duration_minutes"])


def segments_for(window: Optional[dict], status: dict) -> List[dict]:
    """The halves of the day to open: the shift's, or the branch's hours when there is no shift."""
    segs = [s for s in ((window or {}).get("segments") or []) if s.get("start_time") and s.get("end_time")]
    if segs:
        return segs
    if status.get("open") and status.get("close"):
        return [{"start_time": status["open"], "end_time": status["close"]}]
    return []


def grid_times(segments: Iterable[dict], step: int) -> List[str]:
    """Every slot start across the halves — gridTimesFor in the browser, to the minute."""
    step = step or FALLBACK_MINUTES
    times: Set[str] = set()
    for seg in segments:
        start, end = parse_hhmm(seg.get("start_time")), parse_hhmm(seg.get("end_time"))
        if start is None or end is None:
            continue
        m = start
        while m + step <= end:
            times.add(f"{m // 60:02d}:{m % 60:02d}")
            m += step
    return sorted(times)


def signature(segments: Iterable[dict], step: int) -> str:
    return f"{step}|" + ",".join(f"{s.get('start_time')}-{s.get('end_time')}" for s in segments)


async def booked_slot_times(expert_id: str, slot_times: Iterable[str]) -> Set[str]:
    """Which of these slots a patient is booked into, on any of the four kinds of booking."""
    wanted = sorted(set(slot_times))
    if not wanted:
        return set()
    booked: Set[str] = set()
    for col, field, status in BOOKING_SOURCES:
        rows = await v3_col(col).find(
            {field: expert_id, "status": status, "slot_time": {"$in": wanted}}, {"_id": 0, "slot_time": 1},
        ).to_list(5000)
        booked.update(r["slot_time"] for r in rows if r.get("slot_time"))
    return booked


async def multi_branch_consultants(user_ids: Iterable[str], branch_id: str) -> Set[str]:
    """The consultants among these logins whose calendar is shared with another branch."""
    ids = [u for u in user_ids if u]
    out: Set[str] = set()
    if not ids:
        return out
    async for u in v3_col("users").find(
        {"id": {"$in": ids}}, {"_id": 0, "id": 1, "branch_id": 1, "branch_ids": 1, "role": 1},
    ):
        posted = {b for b in (u.get("branch_ids") or []) if b} or ({u["branch_id"]} if u.get("branch_id") else set())
        if (u.get("role") or "").strip().lower() == "super_admin" or posted - {branch_id}:
            out.add(u["id"])
    return out


async def _fill_expert(doctor: dict, profile: str, working: Dict[str, dict], step: int, today: str) -> dict:
    """Open this expert's working days; re-cut the ones opened before across a window that has changed."""
    doc_id = doctor["id"]
    off = set(doctor.get("days_off") or [])
    auto = dict(doctor.get("auto_days") or {})
    by_date: Dict[str, Set[str]] = {}
    for s in doctor.get("slots") or []:
        if isinstance(s, str) and len(s) >= 16:
            by_date.setdefault(s[:10], set()).add(s)

    shifts = await shift_map([*shift_ids_of(doctor), *override_shift_ids(doctor)])
    usual = window_of([shifts.get(i) for i in shift_ids_of(doctor)])
    one_offs = day_windows_of(doctor, shifts)

    add: Set[str] = set()
    remove_candidates: Set[str] = set()
    new_sig: Dict[str, str] = {}
    opened = 0
    for date, status in sorted(working.items()):
        if date in off:
            continue
        segs = segments_for(one_offs.get(date) or usual, status)
        grid = {f"{date}T{t}" for t in grid_times(segs, step)}
        if not grid:
            continue
        sig = signature(segs, step)
        have = by_date.get(date, set())
        if date in auto:
            # Ours: topped back up (a Leave day that came back to Working left it empty) and,
            # when the window moved, cut back to it.
            add |= grid - have
            if auto[date] != sig:
                remove_candidates |= have - grid
                new_sig[date] = sig
        elif not have:
            add |= grid
            new_sig[date] = sig
            opened += 1
        elif have == grid:
            # Opened by hand before this existed, exactly as it would have been opened here:
            # taken on, so the next shift change moves it too.
            new_sig[date] = sig

    removed: Set[str] = set()
    if remove_candidates:
        booked = await booked_slot_times(doc_id, remove_candidates)
        removed = remove_candidates - booked
        if removed:
            await v3_col("doctors").update_one(
                {"id": doc_id},
                {"$pull": {"slots": {"$in": sorted(removed)}, "slot_details": {"slot_time": {"$in": sorted(removed)}}}},
            )

    # Days opened here that have gone by: their unbooked slots come off, so the row stops growing.
    cutoff = _shift_date(today, -KEEP_PAST_DAYS)
    stale_days = [d for d in auto if d < cutoff]
    if stale_days:
        stale_slots = [s for d in stale_days for s in by_date.get(d, set())]
        keep = await booked_slot_times(doc_id, stale_slots)
        drop = sorted(set(stale_slots) - keep)
        update: dict = {"$unset": {f"auto_days.{d}": "" for d in stale_days}}
        if drop:
            update["$pull"] = {"slots": {"$in": drop}, "slot_details": {"slot_time": {"$in": drop}}}
        await v3_col("doctors").update_one({"id": doc_id}, update)

    if add or new_sig:
        update = {"$set": {**{f"auto_days.{d}": s for d, s in new_sig.items()}, "updated_at": now_iso()}}
        query: dict = {"id": doc_id}
        if add:
            new = sorted(add)
            update["$push"] = {
                "slots": {"$each": new, "$sort": 1},
                "slot_details": {
                    "$each": [{"slot_time": s, "duration": step, "consultation_type": SLOT_TYPE[profile]} for s in new],
                    "$sort": {"slot_time": 1},
                },
            }
            # Two fills of the same row at once (the loop and a calendar being opened) must not
            # publish an hour twice: the second one finds the slots there and writes nothing.
            query["slots"] = {"$nin": new}
        await v3_col("doctors").update_one(query, update)

    return {"days_opened": opened, "slots_added": len(add), "slots_removed": len(removed)}


async def fill_branch(
    branch_id: str,
    dates: Optional[Iterable[str]] = None,
    profiles: Iterable[str] = PROFILES,
    doctor_ids: Optional[Iterable[str]] = None,
) -> dict:
    """Open the branch's Working days for its experts. Safe to run any number of times.

    `dates` narrows it to those days (the ones just marked Working) and lets a day past the
    horizon be opened when it is marked; `doctor_ids` narrows it to the experts whose shift or
    session length just changed.
    """
    totals = {"experts": 0, "days_opened": 0, "slots_added": 0, "slots_removed": 0}
    if not branch_id:
        return totals
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch or branch.get("is_active") is False:
        return totals

    today = clinic_today()
    if dates is None:
        wanted = [_shift_date(today, i) for i in range(HORIZON_DAYS)]
    else:
        wanted = sorted({d for d in dates if isinstance(d, str) and d >= today})
    working = {}
    for d in wanted:
        status = day_status(branch, d)
        if status["status"] == WORKING:
            working[d] = status

    # Imported here: v3_config imports this module, and the roster is what the calendars list.
    from routers.v3_config import team_roster_experts

    only = set(doctor_ids) if doctor_ids is not None else None
    minutes: Dict[str, Optional[int]] = {}
    seen: Set[str] = set()
    for profile in profiles:
        if profile not in PROFILES:
            continue
        experts = await team_roster_experts(branch_id, profile)
        if profile == "head_physio":
            shared = await multi_branch_consultants([e.get("user_id") for e in experts], branch_id)
            experts = [e for e in experts if e.get("user_id") not in shared and not e.get("is_super_admin")]
        item_type = STORE_ITEM_TYPE[profile]
        if item_type not in minutes:
            minutes[item_type] = await store_minutes(item_type, branch_id)
        for expert in experts:
            if expert["id"] in seen or (only is not None and expert["id"] not in only):
                continue
            seen.add(expert["id"])
            step = (expert.get("slot_duration_minutes") if profile == "physio" else None) or minutes[item_type] or FALLBACK_MINUTES
            try:
                result = await _fill_expert(expert, profile, working, int(step), today)
            except Exception:
                logger.exception("Auto availability: could not fill %s at branch %s", expert.get("id"), branch_id)
                continue
            totals["experts"] += 1
            for key in ("days_opened", "slots_added", "slots_removed"):
                totals[key] += result[key]
    return totals


async def auto_branch_of(doctor: Optional[dict]) -> Optional[str]:
    """The branch whose Working days open this expert, or None when nobody's do.

    A Physiotherapist's and a Nutritionist's record belongs to one branch. A Consultant's is
    branchless, and is opened only when they work exactly one branch and are not the Super
    Admin — see the module docstring.
    """
    doctor = doctor or {}
    profile = doctor.get("profile_type")
    if profile not in PROFILES:
        return None
    if profile != "head_physio":
        return doctor.get("branch_id") or None
    if doctor.get("is_super_admin") or not doctor.get("user_id"):
        return None
    user = await v3_col("users").find_one(
        {"id": doctor["user_id"]}, {"_id": 0, "branch_id": 1, "branch_ids": 1, "role": 1},
    )
    if not user or (user.get("role") or "").strip().lower() == "super_admin":
        return None
    posted = {b for b in (user.get("branch_ids") or []) if b} or ({user["branch_id"]} if user.get("branch_id") else set())
    return next(iter(posted)) if len(posted) == 1 else None


async def fill_for_doctor(doctor_id: str, dates: Optional[Iterable[str]] = None) -> None:
    """Re-open one expert's days after their shift, a day's shift or their session length changed."""
    doctor = await v3_col("doctors").find_one(
        {"id": doctor_id}, {"_id": 0, "id": 1, "profile_type": 1, "branch_id": 1, "user_id": 1, "is_super_admin": 1},
    )
    branch_id = await auto_branch_of(doctor)
    if branch_id:
        await fill_branch(branch_id, dates=dates, profiles=(doctor["profile_type"],), doctor_ids=[doctor_id])


async def safe_fill_for_doctor(doctor_id: str, dates: Optional[Iterable[str]] = None) -> None:
    """fill_for_doctor for the endpoints that change a shift: their own save has already landed,
    and a failure to re-open the days must not turn it into an error."""
    try:
        await fill_for_doctor(doctor_id, dates)
    except Exception:
        logger.exception("Auto availability: could not re-open the days of %s", doctor_id)


async def safe_fill_branch(branch_id: str, **kwargs) -> dict:
    try:
        return await fill_branch(branch_id, **kwargs)
    except Exception:
        logger.exception("Auto availability: could not fill branch %s", branch_id)
        return {"experts": 0, "days_opened": 0, "slots_added": 0, "slots_removed": 0}


_last_fill: Dict[tuple, float] = {}


async def fill_branch_throttled(branch_id: str, profile: str) -> None:
    """The fill a calendar asks for as it opens, so a person just added to the Team is open on it."""
    if profile not in PROFILES or not branch_id:
        return
    key = (branch_id, profile)
    now = time.monotonic()
    if now - _last_fill.get(key, 0) < THROTTLE_SECONDS:
        return
    _last_fill[key] = now
    await safe_fill_branch(branch_id, profiles=(profile,))


async def record_hand_edit(
    doctor_id: str,
    dates_added: Iterable[str] = (),
    dates_off: Iterable[str] = (),
    dates_edited: Iterable[str] = (),
) -> None:
    """Hand days over to whoever just edited them on the calendar.

    dates_added   re-opened (or added to) by hand: no longer off, no longer ours
    dates_off     taken off by hand: off, and never filled again until re-opened
    dates_edited  some of the day's slots taken off by hand: ours no more, so not topped back up
    """
    added, off, edited = set(dates_added), set(dates_off), set(dates_edited)
    reopened = added - off
    unset = {f"auto_days.{d}": "" for d in added | off | edited}
    first: dict = {}
    if unset:
        first["$unset"] = unset
    if off:
        first["$addToSet"] = {"days_off": {"$each": sorted(off)}}
    if first:
        await v3_col("doctors").update_one({"id": doctor_id}, first)
    # Its own update: a $pull and an $addToSet on days_off in one would be refused as a conflict.
    if reopened:
        await v3_col("doctors").update_one({"id": doctor_id}, {"$pull": {"days_off": {"$in": sorted(reopened)}}})


# ---------- The sweep ----------

_TASK: Optional[asyncio.Task] = None


async def fill_every_branch() -> None:
    async for b in v3_col("branches").find({"is_active": {"$ne": False}}, {"_id": 0, "id": 1}):
        if b.get("id"):
            await safe_fill_branch(b["id"])


async def _sweep_loop() -> None:
    # Not during startup, which already runs a long list of migrations against the database.
    await asyncio.sleep(90)
    while True:
        try:
            await fill_every_branch()
        except Exception:
            logger.exception("Auto availability sweep failed")
        await asyncio.sleep(SWEEP_SECONDS)


def start_auto_availability_scheduler() -> None:
    """Spawn the singleton sweep. Safe to call more than once."""
    global _TASK
    if _TASK is None or _TASK.done():
        _TASK = asyncio.get_event_loop().create_task(_sweep_loop())
