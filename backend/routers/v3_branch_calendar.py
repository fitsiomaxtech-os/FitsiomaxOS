"""MANAGEMENT → CALENDAR → MONTHLY CALENDAR — which days a branch works and which it is on leave.

Read by everyone posted to the branch (and Super Admin / BDE); changed only by the branch's own
Branch Admin, Super Admin and BDE.

Marking a day Leave does two things, because the day has to be closed everywhere a patient
could be booked into it:

  1. the date joins the branch's `holidays`, which consult bookings already refuse and the
     Consultant / Physio calendars now refuse to publish into;
  2. the open, UNBOOKED slots already published on that date for the branch's Physios and
     Consultants are taken off, so no picker built on doctors.slots can still offer them.

Marking a day Working opens it for every Consultant, Physiotherapist and Nutritionist on the
branch's Team, across their own shift — nobody has to open it on their calendars one person at
a time. See auto_availability, which also keeps the next two months open as days come round.

Booked slots are never touched — a patient's appointment does not vanish because the day
was closed; the response counts them so the branch knows who to call and move.

A Consultant posted to more than one branch keeps their slots: they hold one calendar for
every branch they work, and one branch's leave is not a day off at the others.
"""
import re
from calendar import monthrange
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import auto_availability
from branch_calendar import LEAVE, WORKING, day_key, day_status
from database import v3_col
from deps import is_branch_admin_role, v3_current_user, v3_require_roles, works_org_wide
from routers.v3_config import team_roster_experts
from schemas.v3 import V3UserOut
from utils import now_iso

router = APIRouter(prefix="/api/v3")

EDIT_ROLES = ("branch_admin", "super_admin", "business_dev")

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONTH = re.compile(r"^\d{4}-\d{2}$")


class DayStatusInput(BaseModel):
    dates: List[str]
    status: str  # "working" | "leave"
    note: Optional[str] = None


def _can_edit(user: V3UserOut, branch_id: str) -> bool:
    if works_org_wide(user.role):
        return True
    return is_branch_admin_role(user.role) and (not user.branch_id or user.branch_id == branch_id)


async def _branch(branch_id: str) -> dict:
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    return branch


@router.get("/branches/{branch_id}/month-calendar")
async def get_month_calendar(
    branch_id: str,
    month: str = Query(..., description="YYYY-MM"),
    user: V3UserOut = Depends(v3_current_user),
):
    if not _MONTH.match(month or ""):
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    # Read by everyone who works at the branch (the profile page's Monthly Calendar tab),
    # and by the org-wide desks for any branch. Nobody reads another branch's.
    if not works_org_wide(user.role):
        posted = {b for b in (user.branch_ids or []) if b} | ({user.branch_id} if user.branch_id else set())
        if branch_id not in posted:
            raise HTTPException(status_code=403, detail="You can only open your own branch's calendar")
    branch = await _branch(branch_id)
    y, m = (int(x) for x in month.split("-"))
    days = []
    for d in range(1, monthrange(y, m)[1] + 1):
        date_str = f"{y:04d}-{m:02d}-{d:02d}"
        days.append({"date": date_str, **day_status(branch, date_str)})
    return {
        "month": month,
        "branch_id": branch_id,
        "branch_name": branch.get("branch_name", ""),
        "can_edit": _can_edit(user, branch_id),
        "days": days,
    }


async def _clear_open_slots(branch_id: str, dates: List[str]) -> dict:
    """Take the unbooked slots on `dates` off this branch's Physio, Consultant and Nutritionist calendars."""
    prefixes = tuple(f"{d}T" for d in dates)
    experts = [
        *(await team_roster_experts(branch_id, "physio")),
        *(await team_roster_experts(branch_id, "head_physio")),
        *(await team_roster_experts(branch_id, "nutrition_coach")),
    ]

    # Which consultants work somewhere else as well — their calendar is shared across branches.
    consultant_users = [e.get("user_id") for e in experts if e.get("profile_type") == "head_physio" and e.get("user_id")]
    multi_branch = set()
    if consultant_users:
        async for u in v3_col("users").find(
            {"id": {"$in": consultant_users}}, {"_id": 0, "id": 1, "branch_id": 1, "branch_ids": 1, "role": 1},
        ):
            posted = {b for b in (u.get("branch_ids") or []) if b} or ({u["branch_id"]} if u.get("branch_id") else set())
            if (u.get("role") or "").strip().lower() == "super_admin" or posted - {branch_id}:
                multi_branch.add(u["id"])

    removed = kept_booked = 0
    seen = set()
    for e in experts:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        if e.get("profile_type") == "head_physio" and e.get("user_id") in multi_branch:
            continue
        on_days = [s for s in (e.get("slots") or []) if isinstance(s, str) and s.startswith(prefixes)]
        if not on_days:
            continue
        booked = set()
        for col, field, status in (
            ("appointments", "doctor_id", "new_appointment"),
            ("sessions", "physio_id", "upcoming"),
            ("rehab_sessions", "physio_id", "upcoming"),
            ("diet_sessions", "coach_id", "upcoming"),
        ):
            rows = await v3_col(col).find(
                {field: e["id"], "status": status, "slot_time": {"$in": on_days}}, {"_id": 0, "slot_time": 1},
            ).to_list(500)
            booked.update(r["slot_time"] for r in rows)
        drop = set(on_days) - booked
        kept_booked += len(booked)
        if not drop:
            continue
        await v3_col("doctors").update_one(
            {"id": e["id"]},
            {
                "$pull": {"slots": {"$in": list(drop)}, "slot_details": {"slot_time": {"$in": list(drop)}}},
                "$set": {"updated_at": now_iso()},
            },
        )
        removed += len(drop)
    return {"slots_removed": removed, "booked_slots_kept": kept_booked}


@router.put("/branches/{branch_id}/month-calendar")
async def set_day_status(
    branch_id: str,
    payload: DayStatusInput,
    user: V3UserOut = Depends(v3_require_roles(*EDIT_ROLES)),
):
    if not _can_edit(user, branch_id):
        raise HTTPException(status_code=403, detail="Only this branch's Branch Admin, Super Admin or BDE can change its calendar")
    if payload.status not in (WORKING, LEAVE):
        raise HTTPException(status_code=400, detail="status must be 'working' or 'leave'")
    dates = sorted({d for d in payload.dates if isinstance(d, str) and _DATE.match(d) and day_key(d)})
    if not dates:
        raise HTTPException(status_code=400, detail="Pick at least one valid date")

    branch = await _branch(branch_id)
    holidays = set(branch.get("holidays") or [])
    overrides = set(branch.get("working_overrides") or [])
    notes = dict(branch.get("holiday_notes") or {})
    weekly = branch.get("weekly_hours") or {}
    note = (payload.note or "").strip()[:120]

    for d in dates:
        if payload.status == LEAVE:
            holidays.add(d)
            overrides.discard(d)
            if note:
                notes[d] = note
            else:
                notes.pop(d, None)
        else:
            holidays.discard(d)
            notes.pop(d, None)
            # Opened on a weekday the branch normally closes: remembered, or the usual week
            # would close it straight back.
            if (weekly.get(day_key(d)) or {}).get("is_open") is False:
                overrides.add(d)
            else:
                overrides.discard(d)

    await v3_col("branches").update_one(
        {"id": branch_id},
        {"$set": {
            "holidays": sorted(holidays),
            "working_overrides": sorted(overrides),
            "holiday_notes": notes,
            "calendar_updated_at": now_iso(),
            "calendar_updated_by": user.full_name,
        }},
    )

    cleared = {"slots_removed": 0, "booked_slots_kept": 0}
    opened = {"experts": 0, "days_opened": 0}
    if payload.status == LEAVE:
        cleared = await _clear_open_slots(branch_id, dates)
    else:
        # Open straight away rather than on the next sweep, so the calendars and the booking
        # popups show the day the moment it is marked.
        opened = await auto_availability.safe_fill_branch(branch_id, dates=dates)
    return {
        "branch_id": branch_id,
        "status": payload.status,
        "dates": dates,
        **cleared,
        "experts_available": opened["experts"],
        "days_opened": opened["days_opened"],
    }
