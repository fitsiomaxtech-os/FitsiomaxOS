"""The red dots on Branch Admin's tabs: when each tab last had something new in it.

One timestamp per tab or sub-tab -- the newest record that tab lists -- and nothing else.
Whether the reader has seen it is the browser's business: it keeps the moment each tab was
last opened and lights a dot wherever this answer is later. Kept that way so the check is
one cheap read on a timer, and opening a tab costs no write at all.

Keys are the board's own: a top tab's `activeView` key, and `<tab>.<sub-tab>` for a sub-tab.
A top tab with sub-tabs is not answered for itself; the browser takes the newest of its
sub-tabs. Tabs with no "new record" to speak of -- the calendars, Manager, the Team lists,
Accountant Manage -- are left out rather than given a dot that means nothing.

A source that fails is dropped from the answer and logged, not allowed to 500 the rest:
a dot missing from one tab is a much smaller problem than every dot going dark.
"""
import logging
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from database import v3_col
from deps import v3_require_roles, is_branch_admin_role
from physio_scope import head_chief_doctor_ids, user_branch_ids
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3")
log = logging.getLogger(__name__)


async def _newest(collection: str, query: dict, field: str = "created_at") -> str:
    row = await v3_col(collection).find_one(
        {**query, field: {"$nin": [None, ""]}}, {"_id": 0, field: 1}, sort=[(field, -1)],
    )
    return (row or {}).get(field) or ""


def _latest(*stamps: Optional[str]) -> str:
    return max((s for s in stamps if s), default="")


async def _branch_leads(branch_id: str) -> str:
    # A lead reaches a branch by being created there, by Pre-Sales assigning it, or by a
    # transfer in. The last two stamp branch_assigned_at; leads from before that field
    # existed answer by created_at alone.
    return _latest(
        await _newest("leads", {"branch_id": branch_id}),
        await _newest("leads", {"branch_id": branch_id}, "branch_assigned_at"),
    )


async def _bookings(branch_id: str, home: bool) -> str:
    # The appointment, not the lead: a booking is what puts a patient on Consultation or
    # House Visit, and a reschedule moves the same row rather than adding one.
    visit = {"visit_type": "home"} if home else {"visit_type": {"$ne": "home"}}
    return await _newest("appointments", {
        "branch_id": branch_id, "appt_kind": "consultation", "status": {"$ne": "cancelled"}, **visit,
    })


async def _referral_roll(collection: str, branch_id: str, referred_rows) -> str:
    # Both rolls carry the Consultant's referrals beside their own rows, read live off the
    # consultation -- so the newest of either is the newest thing on the tab.
    rows = await referred_rows(branch_id)
    return _latest(
        await _newest(collection, {"branch_id": branch_id}),
        *[r.get("created_at") for r in rows],
    )


async def _zumba(branch_id: str) -> str:
    from routers import v3_zumba
    entry_stage = v3_zumba._entry_stage(await v3_zumba._zumba_stages())
    return await _referral_roll(
        "zumba_registrations", branch_id, lambda b: v3_zumba._referred_rows(b, entry_stage),
    )


async def _fitness(branch_id: str) -> str:
    from routers import v3_fitness
    return await _referral_roll("fitness_registrations", branch_id, v3_fitness._referred_rows)


async def _sumaiya(branch_id: str) -> str:
    ids = await head_chief_doctor_ids()
    if not ids:
        return ""
    return await _newest("appointments", {
        "branch_id": branch_id, "doctor_id": {"$in": ids}, "appt_kind": {"$ne": "diet"},
        "status": {"$ne": "cancelled"},
    })


async def _transfers(branch_id: str) -> str:
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
    ])


@router.get("/branch-admin/tab-activity/{branch_id}")
async def v3_branch_tab_activity(
    branch_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    if is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="Not your branch")

    sources = {
        "pipeline": lambda: _branch_leads(branch_id),
        "branch_consultation": lambda: _bookings(branch_id, home=False),
        "branch_home_visit": lambda: _bookings(branch_id, home=True),
        "activity_care.zumba": lambda: _zumba(branch_id),
        "activity_care.fitness": lambda: _fitness(branch_id),
        "activity_care.review": lambda: _newest("reviews", {"branch_id": branch_id}),
        "consultations.physio_absence": lambda: _newest("physio_absences", {"branch_id": branch_id}),
        "sumaiya": lambda: _sumaiya(branch_id),
        # The catalogue is the organisation's, not the branch's: a new item is new everywhere.
        "store": lambda: _newest("store_items", {}),
        "records.branch_transfers": lambda: _transfers(branch_id),
    }
    latest: Dict[str, str] = {}
    for key, read in sources.items():
        try:
            stamp = await read()
        except Exception:
            log.exception("tab-activity: %s failed", key)
            continue
        if stamp:
            latest[key] = stamp
    return {"latest": latest}
