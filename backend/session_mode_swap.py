"""Offline <-> Online swap of a Treatment Package part-way through the course.

The Consultant sells the package; the Branch Admin decides, at any point in it, that the
days still to come run in the other mode — a patient who has had the first week in the
room and carries on over video, or the reverse. Each day is charged at the rate of the mode
it is delivered in: the days already done keep what they cost, the days left are priced
at the new mode's catalogue rate.

The lead carries that as `session_mode_plan`, the course cut into runs of one mode each:

    [{"mode": "offline", "days": 7, "rate": 1200, "amount": 8400},
     {"mode": "online",  "days": 7, "rate": 1900, "amount": 13300}]

Absent until the first swap — a lead that is never swapped reads exactly as it always has,
one mode and one price. `amount` is held beside `rate` so the run the package was sold as
keeps its own figure to the paisa: its rate is only that price divided down, and
multiplying a rounded rate back up would move the bill on a swap that never touched it.

The difference the swap makes to the bill lands on the Treatment Fee's unpaid schedule,
since that is where every screen already reads what is still owed. Pure functions only;
the endpoint in routers/v3_head_physio_board.py reads and writes the lead.
"""
from typing import List, Optional

MODES = ("offline", "online")


def current_mode(lead: dict) -> str:
    """The mode the course is running in now. A lead from before modes were recorded ran
    in the room."""
    mode = lead.get("session_package_mode")
    return mode if mode in MODES else "offline"


def other_mode(mode: str) -> str:
    return "online" if mode == "offline" else "offline"


def _money(x) -> float:
    return round(float(x or 0), 2)


def plan_of(lead: dict) -> List[dict]:
    """The lead's plan, or the single run it was sold as when it has never been swapped."""
    plan = lead.get("session_mode_plan")
    if plan:
        return [dict(run) for run in plan]
    total = int(lead.get("session_package_sessions") or 0)
    price = _money(lead.get("session_package_price"))
    if total <= 0:
        return []
    return [{"mode": current_mode(lead), "days": total, "rate": round(price / total, 2), "amount": price}]


def plan_total(plan: List[dict]) -> float:
    return _money(sum(run.get("amount") or 0 for run in plan))


def _first_days(plan: List[dict], days: int) -> List[dict]:
    """The first `days` days of the plan. A run cut part-way keeps its share of its own
    amount, not rate x days, for the reason the module docstring gives."""
    kept, left = [], days
    for run in plan:
        if left <= 0:
            break
        n = int(run.get("days") or 0)
        if n <= 0:
            continue
        if n <= left:
            kept.append(dict(run))
            left -= n
        else:
            kept.append({**run, "days": left, "amount": _money((run.get("amount") or 0) * left / n)})
            left = 0
    return kept


def _merged(plan: List[dict]) -> List[dict]:
    """Neighbouring runs of the same mode at the same rate read as one."""
    out: List[dict] = []
    for run in plan:
        if out and out[-1]["mode"] == run["mode"] and _money(out[-1]["rate"]) == _money(run["rate"]):
            out[-1] = {**out[-1], "days": out[-1]["days"] + run["days"], "amount": _money(out[-1]["amount"] + run["amount"])}
        else:
            out.append(dict(run))
    return out


def swapped_plan(plan: List[dict], done: int, to_mode: str, to_rate: float) -> List[dict]:
    """The plan once every day after the first `done` runs in `to_mode` at `to_rate`."""
    total = sum(int(run.get("days") or 0) for run in plan)
    remaining = total - done
    if remaining <= 0:
        return [dict(run) for run in plan]
    rest = {"mode": to_mode, "days": remaining, "rate": _money(to_rate), "amount": _money(to_rate * remaining)}
    return _merged(_first_days(plan, done) + [rest])


def with_day_ranges(plan: List[dict]) -> List[dict]:
    """Each run with the course days it covers, for the screens: Day 1-7, Day 8-14."""
    out, day = [], 1
    for run in plan:
        n = int(run.get("days") or 0)
        out.append({**run, "from_day": day, "to_day": day + n - 1})
        day += n
    return out


def reschedule(
    installments: Optional[List[dict]],
    delta: float,
    excess: float = 0.0,
    due_date: Optional[str] = None,
    opening_paid: Optional[dict] = None,
) -> dict:
    """What a change of `delta` in the bill does to the Treatment Fee's schedule.

    Dearer: money the patient had already paid over the old bill (`excess`) is used first;
    whatever is left joins the last unpaid installment, or becomes a new one due on
    `due_date` when nothing is still owed. A fee taken in one go has no schedule yet, so it
    gets one: `opening_paid` (the collection that was made) followed by the new balance —
    the shape a short collection is stored in, which every schedule screen already reads.

    Cheaper: the unpaid installments shrink, last first, and any that reach nothing are
    dropped. Undo finds a collected installment by its transaction id, never by position,
    so dropping unpaid rows moves nothing it relies on. What they cannot absorb was paid
    over the new bill and is returned as `excess`, for the branch to refund or carry.

    Returns the new installments, the new excess, `booked` — how much of the delta is now
    in the schedule, which a Partial Payment plan's paid figure (booked whole up front) has
    to follow — and `needs_due_date`, True when a new installment had to be made and no
    date was given.
    """
    rows = [dict(i) for i in (installments or [])]
    delta = _money(delta)
    excess = _money(excess)
    booked = 0.0

    if delta > 0:
        from_excess = min(excess, delta)
        excess = _money(excess - from_excess)
        rest = _money(delta - from_excess)
        if rest > 0:
            unpaid = [i for i, row in enumerate(rows) if not row.get("paid")]
            if unpaid:
                last = rows[unpaid[-1]]
                rows[unpaid[-1]] = {**last, "amount": _money((last.get("amount") or 0) + rest)}
            else:
                if not due_date:
                    return {"installments": installments or [], "excess": excess, "booked": 0.0, "needs_due_date": True}
                if not rows and opening_paid:
                    rows.append(dict(opening_paid))
                rows.append({"amount": rest, "due_date": due_date, "paid": False})
            booked = rest
    elif delta < 0:
        need = -delta
        for i in range(len(rows) - 1, -1, -1):
            if need <= 0:
                break
            if rows[i].get("paid"):
                continue
            take = min(_money(rows[i].get("amount")), need)
            rows[i] = {**rows[i], "amount": _money((rows[i].get("amount") or 0) - take)}
            need = _money(need - take)
        rows = [row for row in rows if row.get("paid") or _money(row.get("amount")) > 0.009]
        booked = _money(delta + need)
        excess = _money(excess + need)

    return {"installments": rows, "excess": excess, "booked": booked, "needs_due_date": False}
