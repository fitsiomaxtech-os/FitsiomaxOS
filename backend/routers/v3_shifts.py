"""TIME MANAGEMENT — the shifts a branch runs, and who works which one.

Four windows come seeded (Morning, Evening, Online, Full Time) and every one of them is
editable, because clinic hours are a branch's own business. Assigning one to an expert is
what makes it real: from then on their CONSULTANT / PHYSIO / DIET calendar is only opened
across those hours.

See shift_utils for why assignment lives on the `doctors` row and why shifts are looked up
by id rather than by branch.

The same screen also sets the branch's WORKING DAY -- its hours, its grace, and which days
it is closed -- at the foot of this file. That is a different thing from a shift and the
two are easy to confuse: a shift is when patients may be booked with an expert, the working
day is when staff are expected in, and the second is what the attendance register reads to
decide whether somebody was late. See attendance_rules.py, which owns that reasoning.
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import auto_availability
from attendance_rules import DEFAULTS, WEEKDAY_NAMES, clean_rules, rules_of
from database import v3_col
from deps import is_branch_admin_role, v3_require_roles
from schemas.v3 import V3UserOut
from shift_utils import (
    DATE_RE,
    MAX_SHIFTS_PER_EXPERT,
    attach_shifts,
    day_windows_of,
    ensure_branch_shifts,
    override_shift_ids,
    overrides_of,
    parse_hhmm,
    public_shift,
    shift_ids_of,
    shift_map,
    window_of,
)
from utils import active_doctor_query, now_iso

router = APIRouter(prefix="/api/v3")

# Branch Admin runs their own branch's hours; the two org-wide desks can reach any
# branch's — Business Development opens the same branch board through Operations > Branch.
# HR Admin creates the experts but does not roster them — the calendars they are published
# onto belong to the branch.
MANAGE_ROLES = ("branch_admin", "super_admin", "business_dev")

MAX_NAME_LEN = 40

# The three calendars a shift can be rostered against — CONSULTANT, PHYSIO and DIET, by
# their `doctors.profile_type`. Anything else is a typo in a caller rather than an empty
# branch, so it is refused instead of answered with an empty list.
ROSTER_TYPES = ("head_physio", "physio", "nutrition_coach")


def _scoped_branch(user: V3UserOut, branch_id: str) -> str:
    """A Branch Admin only ever manages their own branch, whatever id is in the URL."""
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            raise HTTPException(status_code=400, detail="Your login is not attached to a branch")
        return user.branch_id
    if not branch_id:
        raise HTTPException(status_code=400, detail="Branch is required")
    return branch_id


def _clean_window(start: str, end: str) -> tuple:
    start_min, end_min = parse_hhmm(start), parse_hhmm(end)
    if start_min is None or end_min is None:
        raise HTTPException(status_code=400, detail="Times must be in 24-hour HH:MM form")
    if end_min <= start_min:
        # A window that ends before it starts would produce no slots at all, and a calendar
        # that silently opens nothing is read as broken rather than as misconfigured.
        raise HTTPException(status_code=400, detail="The shift must end after it starts")
    return start, end


def _clean_name(name: str) -> str:
    body = (name or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Give the shift a name")
    if len(body) > MAX_NAME_LEN:
        raise HTTPException(status_code=400, detail=f"Shift name must be under {MAX_NAME_LEN} characters")
    return body


async def _shift_for(user: V3UserOut, shift_id: str) -> dict:
    row = await v3_col("shifts").find_one({"id": shift_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Shift not found")
    if is_branch_admin_role(user.role) and row.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=403, detail="That shift belongs to another branch")
    return row


@router.get("/branches/{branch_id}/shifts")
async def list_shifts(branch_id: str, user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES))):
    rows = await ensure_branch_shifts(_scoped_branch(user, branch_id))
    return {"shifts": [public_shift(r) for r in rows]}


class ShiftInput(BaseModel):
    name: str
    start_time: str
    end_time: str


@router.post("/branches/{branch_id}/shifts")
async def create_shift(branch_id: str, payload: ShiftInput, user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES))):
    bid = _scoped_branch(user, branch_id)
    name = _clean_name(payload.name)
    start, end = _clean_window(payload.start_time, payload.end_time)
    existing = await ensure_branch_shifts(bid)
    row = {
        "id": str(uuid.uuid4()),
        "branch_id": bid,
        # No `key`: only the four seeded windows carry one, and it is what stops them being
        # re-seeded after a rename. A branch's own shift has nothing to be re-seeded from.
        "key": None,
        "name": name,
        "start_time": start,
        "end_time": end,
        "order": max([r.get("order", 0) for r in existing], default=-1) + 1,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await v3_col("shifts").insert_one(row.copy())
    return public_shift(row)


class ShiftUpdate(BaseModel):
    name: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


@router.patch("/shifts/{shift_id}")
async def update_shift(shift_id: str, payload: ShiftUpdate, user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES))):
    row = await _shift_for(user, shift_id)
    changes = {"updated_at": now_iso()}
    if payload.name is not None:
        changes["name"] = _clean_name(payload.name)
    # Both ends are validated against each other even when only one was sent, so a new
    # start cannot be pushed past the end that is already stored.
    start = payload.start_time if payload.start_time is not None else row.get("start_time")
    end = payload.end_time if payload.end_time is not None else row.get("end_time")
    if payload.start_time is not None or payload.end_time is not None:
        changes["start_time"], changes["end_time"] = _clean_window(start, end)
    await v3_col("shifts").update_one({"id": shift_id}, {"$set": changes})
    # Everyone on it here has their opened days re-cut across the new hours now, not on the
    # next sweep. A consultant on it at another branch is caught by that sweep.
    if "start_time" in changes:
        await auto_availability.safe_fill_branch(row.get("branch_id"))
    return public_shift({**row, **changes})


@router.delete("/shifts/{shift_id}")
async def delete_shift(shift_id: str, user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES))):
    row = await _shift_for(user, shift_id)
    await v3_col("shifts").delete_one({"id": shift_id})
    # Everyone on it comes off it rather than keeping a dangling id. Someone who worked
    # only this shift goes back to the default day — the honest reading of "this expert has
    # no roster", and recoverable by assigning another. Someone on a split day keeps the
    # other half: deleting Evening must not also close a consultant's mornings.
    released = 0
    async for doc in v3_col("doctors").find({"$or": [{"shift_id": shift_id}, {"shift_ids": shift_id}]}, {"_id": 0}):
        remaining = [s for s in shift_ids_of(doc) if s != shift_id]
        await v3_col("doctors").update_one(
            {"id": doc["id"]},
            {"$set": {
                "shift_ids": remaining,
                "shift_id": remaining[0] if remaining else None,
                "updated_at": now_iso(),
            }},
        )
        released += 1
    if released:
        await auto_availability.safe_fill_branch(row.get("branch_id"))
    return {"deleted": True, "unassigned": released}


async def _clean_assignment(user: V3UserOut, shift_ids: Optional[List[str]], shift_id: Optional[str]) -> List[str]:
    """The shifts an expert is being put on, checked and de-duplicated.

    Takes either field: `shift_ids` is what a split day sends, `shift_id` is the single
    value older callers still send, and both mean the same thing when there is one shift.
    Every id is checked against the caller's branch before any of them is stored, so a
    half-valid list never lands as a half-written roster.
    """
    wanted = shift_ids if shift_ids is not None else ([shift_id] if shift_id else [])
    seen, cleaned = set(), []
    for sid in wanted:
        if not sid or sid in seen:
            continue
        seen.add(sid)
        cleaned.append(sid)
    if len(cleaned) > MAX_SHIFTS_PER_EXPERT:
        raise HTTPException(
            status_code=400,
            detail=f"An expert can work at most {MAX_SHIFTS_PER_EXPERT} shifts in a day",
        )
    for sid in cleaned:
        await _shift_for(user, sid)
    return cleaned


class DoctorShiftInput(BaseModel):
    # An empty list — or a null shift_id — clears the assignment and the expert goes back
    # to the default working day.
    shift_id: Optional[str] = None
    # The split day: Morning 8–1 *and* Evening 5–9 on one person. Sent instead of shift_id
    # by anything that can roster more than one window.
    shift_ids: Optional[List[str]] = None


@router.patch("/doctors/{doctor_id}/shift")
async def set_doctor_shift(
    doctor_id: str,
    payload: DoctorShiftInput,
    user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES)),
):
    """Put an expert on one shift, or on several halves of a day.

    Several because a split day is ordinary here: the consultant who takes 8 AM to 1 PM and
    comes back 5 PM to 9 PM works two windows, not one long one, and publishing the single
    8-to-9 stretch would offer patients every afternoon hour nobody is there for.
    """
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Expert not found")
    assigned = await _clean_assignment(user, payload.shift_ids, payload.shift_id)
    await v3_col("doctors").update_one(
        {"id": doctor_id},
        {"$set": {
            "shift_ids": assigned,
            # Written alongside so every older reader of this row — and every query that
            # still matches on it — keeps seeing the first window rather than nothing.
            "shift_id": assigned[0] if assigned else None,
            "updated_at": now_iso(),
        }},
    )
    # The days the server opened for them move to the new hours straight away (booked slots
    # kept), so changing someone's shift is the whole of changing when they can be booked.
    await auto_availability.safe_fill_for_doctor(doctor_id)
    updated = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    return (await attach_shifts([updated]))[0]


class DayShiftInput(BaseModel):
    # The days being changed, "YYYY-MM-DD". A list because the calendar lets several days be
    # selected at once, and "these three Saturdays are evenings" is one decision, not three.
    dates: List[str]
    # None — or an empty list — puts the days back on the expert's usual shift.
    shift_id: Optional[str] = None
    # A one-off split day: "this Saturday she works both halves" is one answer, so the
    # exception takes a list for the same reason the usual roster does.
    shift_ids: Optional[List[str]] = None


@router.patch("/doctors/{doctor_id}/day-shift")
async def set_doctor_day_shift(
    doctor_id: str,
    payload: DayShiftInput,
    user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES)),
):
    """Work a different shift on particular days, without changing the usual one.

    A roster that can only state the usual pattern makes every exception a permanent edit
    that has to be remembered and undone — so the Morning physio who comes in full-time on
    Tuesday ends up either published wrong or left off the calendar. The exception is
    recorded against the date instead, and the expert stays on Morning.

    A day the server opened (auto_availability) is re-cut across the new window here and now,
    keeping any slot a patient is booked into. A day opened or edited by hand is left exactly as
    it is: this decides what the next day opened contains, and nothing else in the OS is allowed
    to drop a patient's slot as a side effect.
    """
    doctor = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Expert not found")
    dates = [d.strip() for d in (payload.dates or []) if isinstance(d, str) and DATE_RE.match(d.strip())]
    if not dates:
        raise HTTPException(status_code=400, detail="Pick at least one date")
    assigned = await _clean_assignment(user, payload.shift_ids, payload.shift_id)

    # Read-modify-write the whole map rather than $set-ing one dotted key at a time: the
    # dates come in as a batch and this keeps clearing (removing keys) and setting on the
    # one code path.
    overrides = dict(overrides_of(doctor))
    for date in dates:
        if assigned:
            overrides[date] = assigned
        else:
            overrides.pop(date, None)
    await v3_col("doctors").update_one(
        {"id": doctor_id},
        {"$set": {"shift_overrides": overrides, "updated_at": now_iso()}},
    )

    await auto_availability.safe_fill_for_doctor(doctor_id, dates=dates)

    stored = {"shift_overrides": overrides}
    shifts = await shift_map([*shift_ids_of(doctor), *override_shift_ids(stored)])
    return {
        "doctor_id": doctor_id,
        "dates": dates,
        "shift": window_of([shifts.get(i) for i in assigned]) if assigned else None,
        "day_shifts": day_windows_of(stored, shifts),
    }


@router.get("/branches/{branch_id}/shift-roster")
async def shift_roster(
    branch_id: str,
    profile_type: str = "head_physio",
    user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES)),
):
    """The experts of one calendar kind, each with the shift they are on.

    Lists the same people the matching calendar tab lists, and for the same reason:
    CONSULTANTs are org-wide (they take consultations at any branch off one record) while
    Physios and Nutrition Coaches belong to the branch they treat at. Rostering someone the
    calendar does not show — or missing someone it does — is the one way this tab can lie.
    """
    if profile_type not in ROSTER_TYPES:
        raise HTTPException(status_code=400, detail="Unknown calendar")
    bid = _scoped_branch(user, branch_id)
    if profile_type == "head_physio":
        query = {"profile_type": "head_physio"}
    else:
        query = {"profile_type": profile_type, "branch_id": bid}
    rows = await v3_col("doctors").find(active_doctor_query(query), {"_id": 0}).to_list(500)
    if profile_type == "head_physio":
        # The multi-branch model leaves one CONSULTANT with several `doctors` rows. The
        # calendar collapses them by login and keeps the row carrying the slots; this has
        # to collapse them the same way, or the shift gets written onto the row nobody's
        # calendar is published on and the rostered hours never take effect.
        best: dict = {}
        for row in rows:
            key = row.get("user_id") or row.get("full_name") or row["id"]
            seen = best.get(key)
            if not seen or len(row.get("slots") or []) > len(seen.get("slots") or []):
                best[key] = row
        rows = list(best.values())
    rows.sort(key=lambda r: (r.get("full_name") or "").lower())
    experts = await attach_shifts(rows)
    return {
        "profile_type": profile_type,
        "experts": [
            {
                "id": e["id"],
                "full_name": e.get("full_name", ""),
                "specialization": e.get("specialization", ""),
                "profile_type": e.get("profile_type"),
                "shift_id": e.get("shift_id"),
                "shift_ids": e.get("shift_ids") or [],
                "shift_name": e.get("shift_name", ""),
                "shift_start": e.get("shift_start"),
                "shift_end": e.get("shift_end"),
                # Each half of a split day with its own ends — the roster row states both,
                # because "8:00 AM – 9:00 PM" for a morning-and-evening consultant is a
                # working day they do not work.
                "shift_windows": e.get("shift_windows") or [],
                "slots_open": len(e.get("slots") or []),
            }
            for e in experts
        ],
    }


# ---------- the working week, and what it makes of a clocked day ----------

# Same two roles as the shifts above, and the same reasoning: the hours a branch keeps are
# the branch's own business, and Super Admin can reach any of them. HR Admin reads what
# comes out of these on their register but does not set them -- the Branch Admin is the
# person who knows which day their floor is closed.
#
# What is set here is not a calendar window. A shift decides when patients may be booked;
# this decides when staff are expected, which is a different question with pay behind it.
# They live on one screen because a Branch Admin thinks of both as "our hours", and in two
# sections because confusing them would put a physio's booking window on somebody's
# payslip.


class AttendanceRulesInput(BaseModel):
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    grace_minutes: Optional[int] = None
    half_day_minutes: Optional[int] = None
    # Monday is 0, Sunday is 6 -- date.weekday()'s numbering, so nothing anywhere has to
    # remember an offset.
    week_offs: Optional[List[int]] = None


def _rules_reply(branch_id: str, rules: dict) -> dict:
    return {
        "branch_id": branch_id,
        "rules": rules,
        # Sent rather than hardcoded in the browser, so a screen that says "Sunday by
        # default" says it because the server does.
        "defaults": DEFAULTS,
        "weekday_names": list(WEEKDAY_NAMES),
    }


@router.get("/branches/{branch_id}/attendance-rules")
async def get_attendance_rules(branch_id: str, user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES))):
    """The branch's working day. Answers with the defaults for a branch that has never set one."""
    bid = _scoped_branch(user, branch_id)
    branch = await v3_col("branches").find_one({"id": bid}, {"_id": 0, "attendance_rules": 1})
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found")
    return _rules_reply(bid, rules_of(branch))


@router.put("/branches/{branch_id}/attendance-rules")
async def set_attendance_rules(
    branch_id: str,
    payload: AttendanceRulesInput,
    user: V3UserOut = Depends(v3_require_roles(*MANAGE_ROLES)),
):
    """Set them. Takes effect on the register immediately, including for days already past.

    That is deliberate and worth being plain about: attendance is derived on read, not
    stored, so moving the week off to Tuesday re-reads every Tuesday this month as a week
    off -- and the Sundays back into working days. It is the honest behaviour for a rule
    that describes how the branch works rather than what happened on one day, and any day
    HR has marked by hand is untouched either way, because a mark somebody made always
    beats a reading.
    """
    bid = _scoped_branch(user, branch_id)
    branch = await v3_col("branches").find_one({"id": bid}, {"_id": 0, "attendance_rules": 1})
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found")
    # Merged onto what is stored rather than onto the bare defaults, so saving one section
    # of the screen cannot blank the other.
    merged = {**rules_of(branch), **{k: v for k, v in payload.model_dump().items() if v is not None}}
    try:
        rules = clean_rules(merged)
    except ValueError as bad:
        raise HTTPException(status_code=400, detail=str(bad))
    await v3_col("branches").update_one(
        {"id": bid}, {"$set": {"attendance_rules": rules, "updated_at": now_iso()}},
    )
    return _rules_reply(bid, rules)
