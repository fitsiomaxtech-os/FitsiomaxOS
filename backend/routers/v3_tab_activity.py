"""The red dots on Branch Admin's tabs: which tabs have something waiting in them.

Two things per tab or sub-tab:

- `latest`: the newest record that tab lists. The browser lights the tab for anything
  added in the last 24 hours, and at once for a record that lands after it was opened.
- `pending`: how many of its records nobody has acted on yet -- a lead still on New
  Leads, a consultation still at its first stage, a referral not yet accepted, a review
  not yet sent. These keep the dot coming back however old they are, until somebody
  works them.

Opening a tab puts its dot out for a few minutes, and a refresh brings it back; that is
all held in the browser (see frontend ui/tab-dot.jsx), so opening a tab writes nothing.

Keys are the board's own: a top tab's `activeView` key, and `<tab>.<sub-tab>` for a sub-tab.
A top tab with sub-tabs is not answered for itself; the browser reads it off its sub-tabs.
Tabs with no "new record" to speak of -- the calendars, Manager, the Team lists, Accountant
Manage -- are left out rather than given a dot that means nothing.

A source that fails is dropped from the answer and logged, not allowed to 500 the rest:
a dot missing from one tab is a much smaller problem than every dot going dark.
"""
import logging
from typing import Dict, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException

from database import v3_col
from deps import v3_require_roles, is_branch_admin_role
from physio_scope import head_chief_doctor_ids, head_chief_lead_ids, user_branch_ids
from schemas.v3 import V3UserOut
from stage_utils import sales_arm_for

router = APIRouter(prefix="/api/v3")
log = logging.getLogger(__name__)

# (newest record's timestamp, how many are untouched)
Activity = Tuple[str, int]


async def _newest(collection: str, query: dict, field: str = "created_at") -> str:
    row = await v3_col(collection).find_one(
        {**query, field: {"$nin": [None, ""]}}, {"_id": 0, field: 1}, sort=[(field, -1)],
    )
    return (row or {}).get(field) or ""


def _latest(*stamps: Optional[str]) -> str:
    return max((s for s in stamps if s), default="")


async def _branch_leads(branch_id: str, role: str) -> Activity:
    # A lead reaches a branch by being created there, by Pre-Sales assigning it, or by a
    # transfer in. The last two stamp branch_assigned_at; leads from before that field
    # existed answer by created_at alone.
    latest = _latest(
        await _newest("leads", {"branch_id": branch_id}),
        await _newest("leads", {"branch_id": branch_id}, "branch_assigned_at"),
    )
    # Untouched: still on the New Leads pill -- the stage the branch has not moved them
    # off. Read the way the board's own pill reads it (see _board_payload).
    from routers.v3_branch_admin import _branch_stages
    stages = await _branch_stages(branch_id, await sales_arm_for(branch_id=branch_id, role=role))
    entry = {s.get("unmoved_branch_stage") for s in stages if s.get("mirrors_stage")} - {None, ""}
    if not entry and stages:
        entry = {stages[0]["name"]}
    pending = await v3_col("leads").count_documents(
        {"branch_id": branch_id, "branch_stage": {"$in": list(entry)}},
    ) if entry else 0
    return latest, pending


async def _bookings(branch_id: str, home: bool) -> Activity:
    # The appointment, not the lead: a booking is what puts a patient on Consultation or
    # House Visit, and a reschedule moves the same row rather than adding one.
    visit = {"visit_type": "home"} if home else {"visit_type": {"$ne": "home"}}
    latest = await _newest("appointments", {
        "branch_id": branch_id, "appt_kind": "consultation", "status": {"$ne": "cancelled"}, **visit,
    })
    # Untouched: still on the first Consultation stage (Consultation Booked).
    from routers.v3_branch_admin import _consultation_stage_names
    names = await _consultation_stage_names()
    pending = await v3_col("leads").count_documents(
        {"branch_id": branch_id, "consultation_stage": names[0], **visit},
    ) if names else 0
    return latest, pending


async def _referral_roll(collection: str, branch_id: str, rows: list) -> Activity:
    # Both rolls carry the Consultant's referrals beside their own rows, read live off the
    # consultation. A referral is the untouched kind: nobody has accepted it onto the roll.
    return (
        _latest(await _newest(collection, {"branch_id": branch_id}), *[r.get("created_at") for r in rows]),
        len(rows),
    )


async def _zumba(branch_id: str) -> Activity:
    from routers import v3_zumba
    entry_stage = v3_zumba._entry_stage(await v3_zumba._zumba_stages())
    return await _referral_roll(
        "zumba_registrations", branch_id, await v3_zumba._referred_rows(branch_id, entry_stage),
    )


async def _fitness(branch_id: str) -> Activity:
    from routers import v3_fitness
    return await _referral_roll("fitness_registrations", branch_id, await v3_fitness._referred_rows(branch_id))


async def _reviews(branch_id: str) -> Activity:
    from routers.v3_reviews import SEND_TO_REVIEW
    return (
        await _newest("reviews", {"branch_id": branch_id}),
        await v3_col("reviews").count_documents({"branch_id": branch_id, "status": SEND_TO_REVIEW}),
    )


async def _sumaiya(branch_id: str) -> Activity:
    ids = await head_chief_doctor_ids()
    if not ids:
        return "", 0
    latest = await _newest("appointments", {
        "branch_id": branch_id, "doctor_id": {"$in": ids}, "appt_kind": {"$ne": "diet"},
        "status": {"$ne": "cancelled"},
    })
    # Untouched: still on the Head Chief's first consultation stage.
    from routers.v3_branch_admin import _head_consultation_stage_names
    names = await _head_consultation_stage_names()
    pending = await v3_col("leads").count_documents({
        "branch_id": branch_id, "id": {"$in": await head_chief_lead_ids()},
        "head_consultation_stage": names[0],
    }) if names else 0
    return latest, pending


async def _transfers(branch_id: str) -> Activity:
    leads = await v3_col("leads").find(
        {"$or": [
            {"branch_transfer_history.from_branch_id": branch_id},
            {"branch_transfer_history.to_branch_id": branch_id},
        ]},
        {"_id": 0, "branch_transfer_history": 1},
    ).to_list(5000)
    return _latest(*[
        move.get("at")
        for lead in leads
        for move in (lead.get("branch_transfer_history") or [])
        if branch_id in (move.get("from_branch_id"), move.get("to_branch_id"))
    ]), 0


async def _just_latest(collection: str, query: dict) -> Activity:
    return await _newest(collection, query), 0


# Developer Access's switch for the dots, every branch at once. Off, the answer is empty,
# so every tab and sub-tab goes dark at the board's next poll; nothing is read or stored.
TAB_DOTS_SETTING_ID = "branch_tab_dots"


async def tab_dots_enabled() -> bool:
    """On unless a developer switched it off."""
    row = await v3_col("app_settings").find_one({"id": TAB_DOTS_SETTING_ID}, {"_id": 0})
    return True if not row else bool(row.get("enabled", True))


@router.get("/branch-admin/tab-activity/{branch_id}")
async def v3_branch_tab_activity(
    branch_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    if is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="Not your branch")
    if not await tab_dots_enabled():
        return {"enabled": False, "latest": {}, "pending": {}}

    sources = {
        "pipeline": lambda: _branch_leads(branch_id, user.role),
        "branch_consultation": lambda: _bookings(branch_id, home=False),
        "branch_home_visit": lambda: _bookings(branch_id, home=True),
        "activity_care.zumba": lambda: _zumba(branch_id),
        "activity_care.fitness": lambda: _fitness(branch_id),
        "activity_care.review": lambda: _reviews(branch_id),
        "consultations.physio_absence": lambda: _just_latest("physio_absences", {"branch_id": branch_id}),
        "sumaiya": lambda: _sumaiya(branch_id),
        # The catalogue is the organisation's, not the branch's: a new item is new everywhere.
        "store": lambda: _just_latest("store_items", {}),
        "records.branch_transfers": lambda: _transfers(branch_id),
    }
    latest: Dict[str, str] = {}
    pending: Dict[str, int] = {}
    for key, read in sources.items():
        try:
            stamp, count = await read()
        except Exception:
            log.exception("tab-activity: %s failed", key)
            continue
        if stamp:
            latest[key] = stamp
        if count:
            pending[key] = count
    return {"enabled": True, "latest": latest, "pending": pending}
