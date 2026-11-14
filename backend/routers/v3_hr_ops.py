"""HR's running month: attendance, approvals, payroll, and the quote board.

Four desks that share one set of records. They are written together because they are not
independent of each other -- an approved leave is an attendance mark, and attendance is
what payroll pro-rates a salary against -- and keeping them apart would have meant three
copies of the rule that decides whether a day is paid.

The chain runs one way, so each desk can be read without knowing the next:

    Approvals  ->  Attendance  ->  Payroll

An approved leave writes the days it covers into attendance as `leave`; attendance's
loss-of-pay days are what payroll deducts. Nothing runs backwards: deleting a payroll run
leaves attendance alone, and revoking an approval only clears the marks that approval put
there (see `_clear_marks`).

A permission -- hours off inside a working day rather than the day itself -- runs down the
same chain and stops one link short of pay. It lands on the register beside the day's
marks, saying which hours were agreed and why, and deliberately does not set a status: the
person came in, and a two-hour errand is not a deduction. See `_apply_permission_mark`.

Requests reach the first link by two roads. HR logs one on somebody's behalf, which is how
a phone call at seven in the morning gets recorded; or the person raises their own, from
their profile, which is routers/v3_me.py -- a different door onto this same
collection, with `build_request` here shaping the row for both.

One thing feeds in from outside that chain: the clock in the header, which every person
presses for themselves (routers/v3_clock.py). It writes the times and the breaks onto the
register's rows, so the In and Out columns are what people actually pressed rather than
somebody's recollection of when they arrived. The marks stay HR's -- a clocked-in day is
`present` only where nobody has said otherwise, and absent, half and leave are decisions
this file has always left to a person.

Lives beside routers/v3_hr.py rather than inside it. Same URL prefix -- these are all
/api/v3/hr to whoever is calling -- but that file is the org's *structure* (who exists,
what department they sit in, what they may log in to), which changes when the company
changes shape, and this one is the month, which changes every day.

Salary figures pass through here. Every endpoint is Super Admin or HR, the same two who
can already read `net_salary` off the employee record in the Employees tab.
"""

import calendar
import uuid
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from database import v3_col
from deps import v3_current_user, is_hr_role
from schemas.v3 import V3UserOut
from utils import clinic_today, now_iso
# How the OS reads a 24-hour HH:MM, borrowed from the module that already had to -- see
# shift_utils.py, where a shift's two ends are parsed the same way. A permission is two
# times on one day, and a second reading of "17:30" would eventually disagree with the
# first about what a bad one looks like.
from shift_utils import parse_hhmm

# The one thing this module takes from the org chart next door: how to read an employee's
# branch. That answer is not a lookup -- it falls back to the linked account, and a
# multi-branch desk holds several -- and two implementations of it would put "Anna Nagar"
# on the Employees tab and "No branch" on the register for the same person.
#
# This direction is the right way round: the register reads employee records, so it
# depends on the module that owns them. v3_hr.py's dashboard needs three constants back
# out of here, and imports them inside the handler precisely because of this line -- a
# top-level import there would close the loop.
from routers.v3_hr import resolve_employee_branches
# And one from the clock: how long a day adds up to. The board reports hours people
# pressed for themselves, so the arithmetic behind them belongs where the presses are
# handled -- see day_totals in routers/v3_clock.py. That module imports nothing from here.
from routers.v3_clock import day_totals
# What a day of attendance IS -- read off the clock against the branch's own working day
# rather than typed onto fifty rows by hand. Every screen below asks this module the same
# question over the rows it already has, which is what keeps the register, the board and
# payroll from disagreeing about the same Tuesday. See attendance_rules.py.
from attendance_rules import DEFAULTS as RULE_DEFAULTS, day_status, is_week_off, rules_of

router = APIRouter(prefix="/api/v3/hr")


# ---------- who may work these desks ----------

# Reading the month and marking it are the same job: an HR Admin who can see the register
# is the person who fills it in. Split gates would have meant an HR Admin watching a screen
# they cannot act on, which is not a permission, it is a tease.
#
# is_hr_role rather than a literal "hr_admin": this install's HR role was typed by hand in
# Credentials and its slug is whatever wording was used. That predicate already answers
# this question for the recruitment board -- see deps.py -- and it returns True for
# super_admin, so both desks are covered by the one call.
async def require_hr(user: V3UserOut = Depends(v3_current_user)) -> V3UserOut:
    if not is_hr_role(user.role):
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


# ---------- the day, and whether it is paid ----------

PRESENT = "present"
LATE = "late"
HALF_DAY = "half_day"
ABSENT = "absent"
LEAVE = "leave"
WEEK_OFF = "week_off"
HOLIDAY = "holiday"

ATTENDANCE_STATUSES = (PRESENT, LATE, HALF_DAY, ABSENT, LEAVE, WEEK_OFF, HOLIDAY)

# What each mark costs the person in pay, in days.
#
# Late is 0 on purpose. It is a punctuality fact, counted and shown on its own, not a pay
# cut -- docking someone for arriving at 09:12 is a decision a company makes deliberately,
# not one a default should make on its behalf. Leave is 0 too: an approved leave is paid
# leave here, and an unpaid one is marked `absent`, which is the honest name for it.
LOP_DAYS = {
    PRESENT: 0.0,
    LATE: 0.0,
    LEAVE: 0.0,
    WEEK_OFF: 0.0,
    HOLIDAY: 0.0,
    HALF_DAY: 0.5,
    ABSENT: 1.0,
}


def _valid_date(value: str, field: str = "date") -> str:
    """A YYYY-MM-DD that is a real calendar date, or a 400 naming the field."""
    try:
        return date.fromisoformat(str(value or "").strip()).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be a date, as YYYY-MM-DD")


def _valid_time(value: str, field: str) -> int:
    """A 24-hour HH:MM as minutes past midnight, or a 400 naming the field.

    Minutes rather than the string, because everything the caller does next is arithmetic
    -- how long the gap is, whether it runs backwards -- and _hhmm turns the answer back
    into the one spelling of it that gets stored.
    """
    minutes = parse_hhmm(str(value or "").strip())
    if minutes is None:
        raise HTTPException(status_code=400, detail=f"{field} must be a time, as HH:MM")
    return minutes


def _hhmm(minutes: int) -> str:
    """450 -> "07:30". One spelling stored, so "9:05" and "09:05" cannot both be on record."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _valid_month(value: str) -> str:
    """A YYYY-MM, or a 400. Blank means the month the clinic is in now."""
    text = str(value or "").strip()
    if not text:
        return clinic_today()[:7]
    _valid_date(f"{text}-01", "month")
    return text


def _month_span(month: str) -> tuple:
    """(first day, last day, number of days) for a YYYY-MM."""
    year, mon = int(month[:4]), int(month[5:7])
    days = calendar.monthrange(year, mon)[1]
    return f"{month}-01", f"{month}-{days:02d}", days


def _dates_between(start: str, end: str) -> List[str]:
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    return [(a + timedelta(days=n)).isoformat() for n in range((b - a).days + 1)]



# ---------- attendance ----------

class AttendanceMark(BaseModel):
    employee_id: str
    status: str
    check_in: Optional[str] = ""
    check_out: Optional[str] = ""
    note: Optional[str] = ""


class AttendanceDay(BaseModel):
    date: str
    entries: List[AttendanceMark]


async def _roster() -> List[Dict[str, Any]]:
    """The people a register is drawn for: everyone currently on the books.

    Inactive employees are left out rather than shown greyed. Someone who has left does
    not have days to mark, and a register that lists them invites a mark that would then
    have to be reasoned about at payroll time.

    Department, designation and branch come along because the register is filtered by all
    three -- fifty rows is more than anybody marks in one sitting, and the person filling
    it in is usually working one branch or one desk at a time.
    """
    fields = {
        "_id": 0, "id": 1, "full_name": 1, "employee_code": 1, "department": 1,
        "designation": 1, "photo_url": 1, "gross_salary": 1, "net_salary": 1,
        # Online vs offline is the only thing the OS records about WHERE somebody works,
        # so it is what the board's Work from Home figure is drawn from.
        "work_type": 1,
        # Both, because branch_id alone is not the whole answer: a multi-branch desk holds
        # branch_ids, and an employee with neither may still have one on their account.
        # resolve_employee_branches settles all three cases.
        "branch_id": 1, "branch_ids": 1,
    }
    rows = await v3_col("employees").find({"status": "active"}, fields).to_list(1000)
    await resolve_employee_branches(rows)
    return sorted(rows, key=lambda e: str(e.get("full_name") or "").lower())


def permission_of(mark: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The agreed hours off on one day's row, or None if there are none.

    None rather than an empty object: "no permission on this day" and "a permission of no
    hours" are different things, and a screen drawing the second would put an empty chip
    on every row in the register.

    Approvals are the only thing that writes these -- see _apply_permission_mark -- so a
    row carrying them is one HR signed off, and the id is on it to say which decision.
    """
    if not (mark or {}).get("permission_id"):
        return None
    return {
        "approval_id": mark.get("permission_id"),
        "from": mark.get("permission_from") or "",
        "to": mark.get("permission_to") or "",
        "minutes": int(mark.get("permission_minutes") or 0),
        "reason": mark.get("permission_reason") or "",
    }


# ---------- reading a span of days the same way everywhere ----------

async def _employee_by_user() -> Dict[str, str]:
    """user_id -> employee_id, for the accounts linked to one.

    The clock is keyed by the login and the register by the employee, because a person is
    both and neither list is the other. Somebody with no employee record clocks in for
    themselves and simply does not appear on this board -- which is a gap in Credentials,
    not something to invent a row for.
    """
    rows = await v3_col("users").find(
        {"employee_id": {"$nin": [None, ""]}}, {"_id": 0, "id": 1, "employee_id": 1}
    ).to_list(2000)
    return {r["id"]: r["employee_id"] for r in rows}


async def _employees_with_logins() -> set:
    """The employees who have an account, and so a way to clock at all.

    The one thing standing between this register and forty-eight wrong payslips. A day
    nobody clocked is read as absent, and absence costs pay -- but plenty of people on the
    books have never needed a login, and they cannot press a button they were never given.
    Their silence is not evidence, so they stay unmarked, exactly as they were before any
    of this. See has_login in attendance_rules.day_status.
    """
    rows = await v3_col("users").find(
        {"employee_id": {"$nin": [None, ""]}}, {"_id": 0, "employee_id": 1},
    ).to_list(2000)
    return {r["employee_id"] for r in rows}


async def _rules_by_branch() -> Dict[str, Dict[str, Any]]:
    """Every branch's working day, keyed by branch id. Read once per request, not per row."""
    rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "attendance_rules": 1}).to_list(500)
    return {r["id"]: rules_of(r) for r in rows}


def _rules_for(employee: Dict[str, Any], by_branch: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """The working day an employee is measured against.

    Their branch's, or the defaults where they have none -- a multi-branch desk is measured
    against the branch they are primarily on, which is the one resolve_employee_branches
    settled onto the row. Measuring somebody against several sets of hours at once has no
    answer, and picking the strictest would make being on two branches a punishment.
    """
    return by_branch.get(employee.get("branch_id") or "", RULE_DEFAULTS)


class SpanContext:
    """Everything needed to say what each employee's each day was, fetched once.

    Assembled per request rather than per row: a month of fifty people is fifteen hundred
    days, and asking the database for each one would be fifteen hundred queries to answer a
    question three collections already hold.
    """

    def __init__(self, marks, clocks, rules, logins, today, now_at):
        self.marks = marks
        self.clocks = clocks
        self.rules = rules
        self.logins = logins
        self.today = today
        self.now_at = now_at

    def clock(self, employee_id: str, iso: str) -> Optional[dict]:
        return self.clocks.get((employee_id, iso))

    def mark(self, employee_id: str, iso: str) -> dict:
        return self.marks.get((employee_id, iso)) or {}

    def totals(self, employee_id: str, iso: str) -> Dict[str, Any]:
        return day_totals(self.clock(employee_id, iso), self.now_at)

    def status(self, employee: Dict[str, Any], iso: str) -> Dict[str, Any]:
        """The day, and whether anybody chose it. One call, one answer, every screen."""
        emp_id = employee["id"]
        return day_status(
            self.rules.get(emp_id, RULE_DEFAULTS),
            iso,
            self.clock(emp_id, iso),
            self.totals(emp_id, iso),
            self.mark(emp_id, iso),
            self.today,
            emp_id in self.logins,
        )

    def rules_of_employee(self, employee: Dict[str, Any]) -> Dict[str, Any]:
        return self.rules.get(employee["id"], RULE_DEFAULTS)


async def _span_context(first: str, last: str, roster: List[Dict[str, Any]]) -> SpanContext:
    marks = await v3_col("attendance").find(
        {"date": {"$gte": first, "$lte": last}}, {"_id": 0},
    ).to_list(50000)
    clocks = await v3_col("clock_days").find(
        {"date": {"$gte": first, "$lte": last}}, {"_id": 0},
    ).to_list(50000)
    emp_of_user = await _employee_by_user()
    by_branch = await _rules_by_branch()
    logins = await _employees_with_logins()

    clocks_by: Dict[tuple, dict] = {}
    for c in clocks:
        emp = emp_of_user.get(c.get("user_id") or "")
        if emp:
            clocks_by[(emp, c["date"])] = c

    return SpanContext(
        marks={(m["employee_id"], m["date"]): m for m in marks},
        clocks=clocks_by,
        rules={e["id"]: _rules_for(e, by_branch) for e in roster},
        logins=logins,
        today=clinic_today(),
        now_at=now_iso(),
    )


@router.get("/attendance")
async def attendance_day(
    day: Optional[str] = Query(None, alias="date"),
    _: V3UserOut = Depends(require_hr),
):
    """The register for one day: every active employee, with their mark if they have one.

    Most of it is read rather than typed now. The status on each row comes from the clock
    measured against that person's branch working day (attendance_rules.py) -- present,
    late, half day, week off, or absent for a working day nobody clocked. A mark HR made by
    hand still beats all of it, and `auto` on each row says which of the two this is.

    Unmarked is still its own answer where nothing can be concluded: a day still running,
    or somebody with no login, who cannot clock and whose silence therefore says nothing.
    """
    on = _valid_date(day) if day else clinic_today()
    roster = await _roster()
    ctx = await _span_context(on, on, roster)
    by_emp = {e["id"]: ctx.mark(e["id"], on) for e in roster}

    rows = []
    summary = {s: 0 for s in ATTENDANCE_STATUSES}
    summary["unmarked"] = 0
    # How many of the day's rows are somebody's own record rather than a typed one. Worth
    # counting on its own: a register that is mostly clocked is one HR is checking, and a
    # register that is mostly typed is one they are still filling in by hand.
    summary["clocked"] = 0
    for e in roster:
        m = by_emp.get(e["id"]) or {}
        read = ctx.status(e, on)
        status = read["status"]
        if m.get("clocked"):
            summary["clocked"] += 1
        rows.append({
            "employee_id": e["id"],
            "full_name": e.get("full_name") or "",
            "employee_code": e.get("employee_code") or "",
            "department": e.get("department") or "",
            "designation": e.get("designation") or "",
            "branch_name": e.get("branch_name") or "",
            "photo_url": e.get("photo_url") or "",
            "status": status,
            # Whether this day was read off the clock or decided by a person. The screens
            # draw the difference because it is a real one: a reading moves when the rules
            # or the times do, a decision does not.
            "auto": read["auto"],
            "check_in": m.get("check_in") or "",
            "check_out": m.get("check_out") or "",
            "note": m.get("note") or "",
            # Marks an approval wrote are shown as locked, so nobody quietly overwrites a
            # leave that was signed off and then wonders why payroll disagrees with them.
            "locked": bool(m.get("approval_id")),
            "marked_by": m.get("marked_by") or "",
            # What this person's own clock recorded, where they used it. `clocked` is what
            # tells the register that the In and Out beside it were pressed rather than
            # typed, and the breaks are the account of the gap between them.
            "clocked": bool(m.get("clocked")),
            "breaks": m.get("breaks") or [],
            "break_minutes": int(m.get("break_minutes") or 0),
            # Hours off this person asked for and HR agreed to. Not a status -- they came
            # in -- but the reason a gap in the middle of their day is accounted for.
            "permission": permission_of(m),
        })
        summary[status if status in summary else "unmarked"] += 1

    return {"date": on, "today": clinic_today(), "rows": rows, "summary": summary}



# ---------- the attendance board ----------

# The four spans the board is read over. A day is the register; the other three are the
# same rows added up, which is a different question -- "who is in today" against "who has
# been in this month" -- and so a different set of columns.
PERIOD_DAY, PERIOD_RANGE, PERIOD_MONTH, PERIOD_YEAR = "day", "range", "month", "year"
PERIODS = (PERIOD_DAY, PERIOD_RANGE, PERIOD_MONTH, PERIOD_YEAR)

# What the board calls somebody who has pressed nothing and whom nobody has marked.
# Deliberately not "absent": absent is a decision with pay attached (see LOP_DAYS), and
# nine in the morning is too early to have made it.
YET_TO_LOGIN = "yet_to_login"

# The clock's own word for a day somebody has finished -- see _state in routers/v3_clock.py.
DONE_STATE = "done"

# The marks that mean somebody is not expected in. Counted apart from Yet to Login so the
# figure that says "chase these people" does not include the ones nobody is waiting for.
AWAY_STATUSES = (ABSENT, LEAVE)
NOT_EXPECTED = (ABSENT, LEAVE, WEEK_OFF, HOLIDAY)


def prettify_day(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%d %b %Y")


def prettify_month(month: str) -> str:
    return date.fromisoformat(month + "-01").strftime("%B %Y")


def _period_span(period: str, day, start, end, month, year) -> tuple:
    """(from, to, label) for whichever span was asked for."""
    if period == PERIOD_DAY:
        on = _valid_date(day) if day else clinic_today()
        return on, on, prettify_day(on)
    if period == PERIOD_RANGE:
        a = _valid_date(start, "from") if start else clinic_today()
        b = _valid_date(end, "to") if end else a
        if b < a:
            raise HTTPException(status_code=400, detail="The last day cannot be before the first")
        return a, b, prettify_day(a) + " - " + prettify_day(b)
    if period == PERIOD_MONTH:
        mon = _valid_month(month)
        first, last, _ = _month_span(mon)
        return first, last, prettify_month(mon)
    text = str(year or "").strip() or clinic_today()[:4]
    if not (text.isdigit() and len(text) == 4):
        raise HTTPException(status_code=400, detail="year must be four digits")
    return text + "-01-01", text + "-12-31", text


def _board_status(clock_state: str, read_status: str) -> str:
    """What the board calls a person's day: what is happening, else what the day amounts to.

    A clock still running wins. Somebody at their desk right now is Working, and somebody
    away from it is On break, whatever the day will add up to by six -- that is the point
    of this board, which reports the floor as it stands rather than the month as it will be
    counted.

    Once the clock is done or was never started, the day itself speaks: the status read off
    it against the branch's working day, or the mark HR made, whichever attendance_rules
    settled on. `done` is deliberately not shown any more -- "Present" and "Late" say
    everything "Done" said and one thing more.

    Only when there is nothing at all -- no clock, nothing concluded, a day still going --
    does it read Yet to Login.
    """
    if clock_state in ("working", "on_break"):
        return clock_state
    if read_status:
        return read_status
    # A finished day always reads as something -- present, late, half day -- so this is
    # reached only if the rules produced nothing at all for one. Better to say the day was
    # worked and ended than to file somebody who clocked out at six under Yet to Login.
    if clock_state == DONE_STATE:
        return DONE_STATE
    return YET_TO_LOGIN


@router.get("/attendance/overview")
async def attendance_overview(
    period: str = Query(PERIOD_DAY),
    day: Optional[str] = Query(None, alias="date"),
    start: Optional[str] = Query(None, alias="from"),
    end: Optional[str] = Query(None, alias="to"),
    month: Optional[str] = Query(None),
    year: Optional[str] = Query(None),
    _: V3UserOut = Depends(require_hr),
):
    """Who worked, and for how long -- over a day, a range, a month or a year.

    Reads the clock rather than the register's marks: the times are what people pressed,
    and the hours come from the stamps behind them through day_totals in
    routers/v3_clock.py, so this board and the header widget cannot disagree about how
    long somebody has been in.

    The register is still consulted, for the one thing a clock cannot say: that somebody
    is on approved leave, or was marked absent. See _board_status for which of the two
    speaks when.
    """
    if period not in PERIODS:
        raise HTTPException(status_code=400, detail="Unknown period: " + str(period))
    first, last, label = _period_span(period, day, start, end, month, year)
    span_days = _dates_between(first, last)

    roster = await _roster()
    # Both sides keyed the same way, so a row is assembled by employee and date without
    # rescanning either list per person -- and the branch rules each person is measured
    # against come down with them. See _span_context.
    ctx = await _span_context(first, last, roster)
    marks_by, clocks_by, now_at = ctx.marks, ctx.clocks, ctx.now_at
    single = first == last
    rows = []
    for e in roster:
        totals = {"login_minutes": 0, "worked_minutes": 0, "break_minutes": 0, "break_count": 0}
        present_days = 0
        away_days = 0
        permission_days = 0
        permission_minutes = 0
        off_days = 0
        for d in span_days:
            clock = clocks_by.get((e["id"], d))
            mark = marks_by.get((e["id"], d)) or {}
            t = day_totals(clock, now_at)
            for k in totals:
                totals[k] += t[k]
            read = ctx.status(e, d)
            if t["state"] != "out":
                present_days += 1
            elif read["status"] in AWAY_STATUSES:
                # Absent counts here whether HR typed it or the clock's silence produced
                # it -- a day nobody worked and nobody accounted for is the thing this
                # column exists to surface.
                away_days += 1
            elif read["status"] in (WEEK_OFF, HOLIDAY):
                off_days += 1
            # Counted on its own axis rather than folded into either of the two above: a
            # day with two hours' permission on it is a day the person was present for,
            # and adding it to "away" would say they were not.
            if mark.get("permission_id"):
                permission_days += 1
                permission_minutes += int(mark.get("permission_minutes") or 0)

        row = {
            "employee_id": e["id"],
            "full_name": e.get("full_name") or "",
            "employee_code": e.get("employee_code") or "",
            "department": e.get("department") or "",
            "designation": e.get("designation") or "",
            "branch_name": e.get("branch_name") or "",
            "photo_url": e.get("photo_url") or "",
            # Online is the only "not in a room" the OS records, so it is what the board
            # reports as working from home. It is a property of the person rather than of
            # the day -- nothing marks it per-day anywhere -- and the tile says so.
            "remote": str(e.get("work_type") or "").strip().lower() == "online",
            "present_days": present_days,
            "away_days": away_days,
            # Days nobody was expected in. Counted so the board can say a person is not
            # behind on a month that happened to hold five Sundays.
            "off_days": off_days,
            "permission_days": permission_days,
            "permission_minutes": permission_minutes,
        }
        row.update(totals)
        if single:
            clock = clocks_by.get((e["id"], first)) or {}
            mark = marks_by.get((e["id"], first)) or {}
            read = ctx.status(e, first)
            row.update({
                "status": _board_status(day_totals(clock, now_at)["state"], read["status"]),
                "auto": read["auto"],
                "check_in": clock.get("clock_in") or mark.get("check_in") or "",
                "check_out": clock.get("clock_out") or mark.get("check_out") or "",
                "note": mark.get("note") or "",
                "locked": bool(mark.get("approval_id")),
                "permission": permission_of(mark),
                # The account of the gap between in and out, for the row's detail panel.
                "breaks": [
                    {
                        "out": b.get("out") or "",
                        "in": b.get("in") or "",
                        "reason": b.get("reason") or "",
                    }
                    for b in (clock.get("breaks") or [])
                ],
            })
        rows.append(row)

    rows.sort(key=lambda r: str(r.get("full_name") or "").lower())

    # Counted off the assembled rows rather than queried again, so the tiles and the table
    # can never disagree about the same span.
    present = [r for r in rows if r["present_days"] > 0]
    kpis = {
        "total_employees": len(rows),
        "present_working": len(present),
        "work_from_home": len([r for r in present if r["remote"]]),
        "absent_leave": len([r for r in rows if r["away_days"] > 0]),
        # People with agreed hours off inside the span. Its own tile because it is the one
        # figure here that is neither present nor away -- they were both, on the same day.
        "on_permission": len([r for r in rows if r["permission_days"] > 0]),
        # Only meaningful for one day: over a month, somebody who came in on the 3rd is
        # not "yet to login". Sent as null for the longer spans so the screen can drop the
        # tile rather than print a figure that means nothing.
        "yet_to_login": None,
    }
    if single:
        # Read off the assembled status rather than the stored mark, so a week off the
        # branch set and an absence the clock's silence produced both drop out of the
        # chase-these-people figure -- one because nobody is waiting for them, the other
        # because the day has already been concluded.
        kpis["yet_to_login"] = len([
            r for r in rows
            if r["present_days"] == 0 and r.get("status") not in NOT_EXPECTED
        ])

    return {
        "period": period,
        "from": first,
        "to": last,
        "label": label,
        "single_day": single,
        "today": clinic_today(),
        "days_in_span": len(span_days),
        "kpis": kpis,
        "rows": rows,
    }

@router.post("/attendance")
async def mark_attendance(payload: AttendanceDay, user: V3UserOut = Depends(require_hr)):
    """Save a day's marks. One row per employee per day, replaced rather than appended.

    The whole day is posted at once because that is how it is filled in -- a register is
    worked down in one sitting -- and one call means the screen cannot end up half saved.
    Which is also why every status is checked before the first write: a bad one found
    half way down would otherwise leave the day part-written and the screen showing a
    failure over marks that had in fact been stored.
    """
    on = _valid_date(payload.date)
    if on > clinic_today():
        raise HTTPException(status_code=400, detail="That day hasn't happened yet")

    known = {e["id"] for e in await _roster()}
    # Marks an approval wrote are not HR's to edit here. Changing one would put the
    # register and the decision that produced it into disagreement, with payroll reading
    # whichever it found -- so the approval is the place to change it, and revoking there
    # removes the mark (see _clear_marks).
    locked = {
        r["employee_id"]
        for r in await v3_col("attendance").find(
            {"date": on, "approval_id": {"$nin": [None, ""]}}, {"_id": 0, "employee_id": 1}
        ).to_list(2000)
    }

    writable, skipped = [], 0
    for entry in payload.entries:
        if entry.employee_id not in known:
            continue
        if entry.employee_id in locked:
            skipped += 1
            continue
        status = (entry.status or "").strip()
        if status and status not in ATTENDANCE_STATUSES:
            raise HTTPException(status_code=400, detail=f"Unknown attendance status: {status}")
        writable.append((entry, status))

    saved, cleared = 0, 0
    for entry, status in writable:
        # Clearing a mark is a real action -- it is how a wrong entry is taken back -- so
        # an empty status deletes the row rather than storing "" as an eighth status.
        #
        # Unless the row is carrying an approved permission, which is not HR's mark and
        # not theirs to drop by clearing one. There the mark alone is taken off and the
        # row stays, still holding the hours somebody signed off.
        if not status:
            key = {"date": on, "employee_id": entry.employee_id}
            if await v3_col("attendance").find_one({**key, "permission_id": {"$nin": [None, ""]}}, {"_id": 1}):
                res = await v3_col("attendance").update_one(
                    key, {"$unset": {"status": "", "check_in": "", "check_out": "", "note": "", "marked_by": ""}}
                )
                cleared += res.modified_count
                continue
            res = await v3_col("attendance").delete_one(key)
            cleared += res.deleted_count
            continue
        await v3_col("attendance").update_one(
            {"date": on, "employee_id": entry.employee_id},
            {
                "$set": {
                    "status": status,
                    "check_in": (entry.check_in or "").strip(),
                    "check_out": (entry.check_out or "").strip(),
                    "note": (entry.note or "").strip(),
                    "marked_by": user.full_name,
                    "marked_at": now_iso(),
                },
                "$setOnInsert": {"id": str(uuid.uuid4()), "date": on, "employee_id": entry.employee_id},
            },
            upsert=True,
        )
        saved += 1

    return {"date": on, "saved": saved, "cleared": cleared, "locked_skipped": skipped}


async def _month_marks(month: str) -> Dict[str, Dict[str, float]]:
    """Per-employee counts of each status across a month, keyed by employee id.

    Counted over every day of the month for every person on the books, rather than over
    the rows somebody happened to type. This is what payroll pro-rates against, so it is
    the place the change of method actually reaches money: a working day nobody clocked is
    counted `absent` here and costs a day, where before it was silence and was paid.

    Two things keep that from being brutal. A day HR marked stands, whatever the clock did
    or did not record. And an employee with no login is never counted absent at all -- see
    _employees_with_logins -- because they have no way to clock and their silence is not
    evidence of anything.

    Days that have not happened yet are not counted. A month still running is measured to
    today, so a payroll preview on the 5th does not read the rest of the month as
    twenty-five absences.
    """
    start, end, _ = _month_span(month)
    roster = await _roster()
    ctx = await _span_context(start, end, roster)
    today = ctx.today

    tally: Dict[str, Dict[str, float]] = {}
    for e in roster:
        counts = {s: 0 for s in ATTENDANCE_STATUSES}
        for iso in _dates_between(start, end):
            if iso > today:
                break
            status = ctx.status(e, iso)["status"]
            if status in counts:
                counts[status] += 1
        tally[e["id"]] = counts
    return tally


@router.get("/attendance/month")
async def attendance_month(
    month: Optional[str] = Query(None),
    _: V3UserOut = Depends(require_hr),
):
    """The month at a glance: each employee's counts, and their days lost to pay."""
    mon = _valid_month(month)
    _, _, days = _month_span(mon)
    tally = await _month_marks(mon)
    roster = await _roster()
    rows = []
    for e in roster:
        counts = tally.get(e["id"]) or {s: 0 for s in ATTENDANCE_STATUSES}
        marked = sum(counts.values())
        rows.append({
            "employee_id": e["id"],
            "full_name": e.get("full_name") or "",
            "employee_code": e.get("employee_code") or "",
            "department": e.get("department") or "",
            **counts,
            "marked": marked,
            "unmarked": max(days - marked, 0),
            "lop_days": round(sum(counts[s] * LOP_DAYS[s] for s in ATTENDANCE_STATUSES), 2),
        })
    return {"month": mon, "days_in_month": days, "rows": rows}


# ---------- approvals ----------

LEAVE_KIND = "leave"
# Hours off inside a working day, not days off. Somebody who needs two hours at the bank
# is asking for something a leave cannot express -- a leave takes the whole day, and
# marking the day absent to cover a two-hour errand costs them a day's pay for it. So it
# is its own kind, with two times on it rather than two dates, and approving it does not
# mark the day at all: they still came in, and the register still says so.
PERMISSION_KIND = "permission"
KINDS = (LEAVE_KIND, PERMISSION_KIND, "comp_off", "advance", "expense", "other")

# The kinds a person may raise for themselves, from their own profile -- see
# routers/v3_me.py. The rest stay HR's to log: an advance and an expense claim are
# money, and a comp off is a day somebody else has to agree was worked.
SELF_SERVICE_KINDS = (LEAVE_KIND, PERMISSION_KIND)

# Who put the request on the list. HR logging one on somebody's behalf is still how a
# phone call at seven in the morning gets recorded, so both roads stay open and the row
# says which one it came down. Rows written before this existed carry neither field and
# read as HR's, which is what they were.
SOURCE_SELF, SOURCE_HR = "self", "hr"

# The shortest and longest a permission can be. The floor is there because a request for
# ten minutes is a break, and the clock already records those with a reason on them. The
# ceiling is there because four hours is half a day, and a half day is a mark with pay
# attached -- HR's decision to make on the register, not something a permission slip
# should quietly turn into.
MIN_PERMISSION_MINUTES = 15
MAX_PERMISSION_MINUTES = 240

# The three states a request is ever in. There is no "cancelled": a request withdrawn
# before anybody looked at it is deleted, and one already decided stays on the record.
PENDING, APPROVED, REJECTED = "pending", "approved", "rejected"


class ApprovalCreate(BaseModel):
    employee_id: str
    kind: str = LEAVE_KIND
    from_date: Optional[str] = ""
    to_date: Optional[str] = ""
    # Permission only: the hours of the day being asked for, as 24-hour HH:MM.
    from_time: Optional[str] = ""
    to_time: Optional[str] = ""
    amount: Optional[float] = 0
    reason: Optional[str] = ""


class ApprovalDecision(BaseModel):
    decision: str
    note: Optional[str] = ""


async def _employee_or_404(emp_id: str) -> Dict[str, Any]:
    emp = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    return emp


def build_request(
    emp: Dict[str, Any],
    kind: str,
    *,
    from_date: str = "",
    to_date: str = "",
    from_time: str = "",
    to_time: str = "",
    amount: float = 0,
    reason: str = "",
    requested_by: str = "",
    requested_by_user_id: str = "",
    source: str = SOURCE_HR,
) -> Dict[str, Any]:
    """One request, checked and ready to insert. The only place a row is shaped.

    Two screens raise these now -- HR logging one on somebody's behalf, and the person
    themselves from their profile (routers/v3_me.py) -- and the rules about what a
    leave or a permission has to carry are the same rules whichever door it came through.
    Written once here so a leave raised by its own subject cannot end up with a shape
    HR's list does not know how to read.

    Public, and returns the row rather than inserting it: the self-service side has one
    more thing to check first (whether the person already has this day booked off), and
    that check wants the dates this function settled on.
    """
    kind = (kind or LEAVE_KIND).strip()
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"Unknown request type: {kind}")

    row: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "employee_id": emp["id"],
        # Denormalised so the list reads without a second query per row, and so a request
        # decided last year still names the person as they were on the record then.
        "employee_name": emp.get("full_name") or "",
        "employee_code": emp.get("employee_code") or "",
        "department": emp.get("department") or "",
        "kind": kind,
        "from_date": "", "to_date": "", "days": 0,
        "from_time": "", "to_time": "", "minutes": 0,
        "amount": round(float(amount or 0), 2),
        "reason": (reason or "").strip(),
        "status": PENDING,
        "requested_by": requested_by,
        "requested_by_user_id": requested_by_user_id,
        "source": source,
        "requested_at": now_iso(),
        "decided_by": "", "decided_at": "", "decision_note": "",
    }

    if kind in (LEAVE_KIND, "comp_off"):
        if not from_date:
            raise HTTPException(status_code=400, detail="Pick the dates this covers")
        start = _valid_date(from_date, "from_date")
        end = _valid_date(to_date or from_date, "to_date")
        if end < start:
            raise HTTPException(status_code=400, detail="The last day can't be before the first")
        row.update({"from_date": start, "to_date": end, "days": len(_dates_between(start, end))})
    elif kind == PERMISSION_KIND:
        if not from_date:
            raise HTTPException(status_code=400, detail="Pick the day this is for")
        # One day, both ends. A permission that ran past midnight would be two days off
        # in the middle of two shifts, which is a leave with extra steps.
        day = _valid_date(from_date, "date")
        start = _valid_time(from_time, "from_time")
        end = _valid_time(to_time, "to_time")
        minutes = end - start
        if minutes <= 0:
            raise HTTPException(status_code=400, detail="The end time has to be after the start")
        if minutes < MIN_PERMISSION_MINUTES:
            raise HTTPException(
                status_code=400,
                detail=f"A permission is at least {MIN_PERMISSION_MINUTES} minutes -- anything shorter is a break",
            )
        if minutes > MAX_PERMISSION_MINUTES:
            raise HTTPException(
                status_code=400,
                detail=f"A permission tops out at {MAX_PERMISSION_MINUTES // 60} hours -- longer than that, ask for leave",
            )
        row.update({
            "from_date": day, "to_date": day,
            "from_time": _hhmm(start), "to_time": _hhmm(end),
            "minutes": minutes,
        })
    elif kind in ("advance", "expense") and row["amount"] <= 0:
        raise HTTPException(status_code=400, detail="Enter the amount being asked for")

    return row


async def _apply_leave_marks(row: dict, by: str) -> int:
    """Write an approved leave into the register, and say how many days it covered.

    An approval that does not reach attendance is a note in a drawer: payroll reads the
    register, so a leave signed off here has to land there or the person is paid as though
    nobody decided anything. The marks carry `approval_id`, which is what makes them
    locked on the register and removable again if the decision is taken back.

    A day already marked something else is left alone -- if HR wrote `present` for the
    12th, they were there on the 12th, and a leave approved afterwards does not undo that.
    It is the *mark* that blocks it, not the row: a day can already have a row on it
    carrying nothing but an approved permission, and that is not somebody saying what the
    day was.
    """
    if row.get("kind") != LEAVE_KIND or not row.get("from_date") or not row.get("to_date"):
        return 0
    written = 0
    for day in _dates_between(row["from_date"], row["to_date"]):
        existing = await v3_col("attendance").find_one(
            {"date": day, "employee_id": row["employee_id"]}, {"_id": 0, "status": 1}
        )
        if (existing or {}).get("status"):
            continue
        # Upsert rather than insert, for the day that already has a permission row on it:
        # a second document for the same person and date would leave the register reading
        # whichever of the two it found first.
        await v3_col("attendance").update_one(
            {"date": day, "employee_id": row["employee_id"]},
            {
                "$set": {
                    "status": LEAVE,
                    "check_in": "", "check_out": "",
                    "note": (row.get("reason") or "")[:200],
                    "approval_id": row["id"],
                    "marked_by": by,
                    "marked_at": now_iso(),
                },
                "$setOnInsert": {"id": str(uuid.uuid4()), "date": day, "employee_id": row["employee_id"]},
            },
            upsert=True,
        )
        written += 1
    return written


# The fields an approved permission puts on a day, and the only ones taking it back
# removes. Named once so the two halves cannot drift apart and leave a register showing
# hours off that no request stands behind.
PERMISSION_FIELDS = (
    "permission_id", "permission_from", "permission_to",
    "permission_minutes", "permission_reason", "permission_by",
)


async def _apply_permission_mark(row: dict, by: str) -> int:
    """Write an approved permission onto the day it covers, without marking that day.

    This is the difference between a permission and a leave, and it is the whole reason
    the kind exists: the person is coming in. Nothing here touches `status`, so the day
    stays whatever the register says it was -- present off their own clock, or unmarked
    until somebody says otherwise -- and payroll, which reads statuses, does not see two
    hours at the bank as a deduction.

    What it does leave is the record that those two hours were agreed: the times, the
    reason and the id of the request behind them, so the register can show the gap in
    somebody's day as accounted for rather than as unexplained.
    """
    if row.get("kind") != PERMISSION_KIND or not row.get("from_date"):
        return 0
    await v3_col("attendance").update_one(
        {"date": row["from_date"], "employee_id": row["employee_id"]},
        {
            "$set": {
                "permission_id": row["id"],
                "permission_from": row.get("from_time") or "",
                "permission_to": row.get("to_time") or "",
                "permission_minutes": int(row.get("minutes") or 0),
                "permission_reason": (row.get("reason") or "")[:200],
                "permission_by": by,
            },
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
                "date": row["from_date"],
                "employee_id": row["employee_id"],
            },
        },
        upsert=True,
    )
    return 1


async def _clear_marks(approval_id: str) -> int:
    """Take back every mark this approval wrote, whichever kind it was.

    Anything HR typed by hand stays. Two shapes to undo, because the two kinds write
    differently: a leave owns the whole row it created, and a permission is a few fields
    hung on a row that may well have been there first -- somebody's clocked day. So the
    permission's fields are unset and the row is only deleted when nothing is left on it
    to keep, which is the case exactly when the permission was what created it.
    """
    cleared = 0

    leaves = await v3_col("attendance").find(
        {"approval_id": approval_id}, {"_id": 0, "date": 1, "employee_id": 1, "permission_id": 1}
    ).to_list(2000)
    for r in leaves:
        key = {"date": r["date"], "employee_id": r["employee_id"]}
        if r.get("permission_id"):
            # A permission was approved for a day this leave also covered. The leave is
            # being taken back; the permission is somebody else's decision and stands.
            await v3_col("attendance").update_one(
                key, {"$unset": {"status": "", "approval_id": "", "note": "", "marked_by": ""}}
            )
        else:
            await v3_col("attendance").delete_one(key)
        cleared += 1

    permissions = await v3_col("attendance").find(
        {"permission_id": approval_id},
        {"_id": 0, "date": 1, "employee_id": 1, "status": 1, "clocked": 1, "approval_id": 1},
    ).to_list(2000)
    for r in permissions:
        key = {"date": r["date"], "employee_id": r["employee_id"]}
        if r.get("status") or r.get("clocked") or r.get("approval_id"):
            await v3_col("attendance").update_one(key, {"$unset": {f: "" for f in PERMISSION_FIELDS}})
        else:
            # Nothing on the row but the permission, so the permission was what put it
            # there. Left behind, it would show on the register as a blank day somebody
            # had bothered to open.
            await v3_col("attendance").delete_one(key)
        cleared += 1

    return cleared


@router.get("/approvals")
async def list_approvals(
    status: Optional[str] = Query(None),
    kind: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    _: V3UserOut = Depends(require_hr),
):
    """Every request, newest first, narrowed by whichever of the three filters was sent.

    `source` is the one that earns its place on the screen: people raise their own leave
    and permission now (routers/v3_me.py), and "what has come in that nobody has
    looked at" is a different question from "what did we log", answered by the same list.
    """
    query: Dict[str, Any] = {}
    if status in (PENDING, APPROVED, REJECTED):
        query["status"] = status
    if kind in KINDS:
        query["kind"] = kind
    if source == SOURCE_SELF:
        query["source"] = SOURCE_SELF
    elif source == SOURCE_HR:
        # Rows written before requests had a source were all HR's, and there is no
        # backfill: this asks the question the way the data answers it.
        query["source"] = {"$ne": SOURCE_SELF}
    rows = await v3_col("approvals").find(query, {"_id": 0}).sort("requested_at", -1).to_list(1000)
    counts = {s: await v3_col("approvals").count_documents({"status": s}) for s in (PENDING, APPROVED, REJECTED)}
    # Waiting on HR *and* raised by the person it is about -- the queue somebody outside
    # this room is actually waiting on an answer to.
    counts["pending_from_staff"] = await v3_col("approvals").count_documents(
        {"status": PENDING, "source": SOURCE_SELF}
    )
    return {"approvals": rows, "counts": counts}


@router.get("/staff-requests")
async def list_staff_requests(user: V3UserOut = Depends(require_hr)):
    """Leave and permission requests, each with the role and branch of the person asking.

    The Business Development Executive's Permission tab. The same rows as /approvals,
    narrowed to the two kinds staff raise, with the login's role and branch put beside
    each so the screen can group them by desk -- an approval row carries the employee,
    not the account. Decided through PATCH /approvals/{id} like every other request.
    """
    if (user.role or "").strip().lower() not in ("super_admin", "business_dev"):
        raise HTTPException(status_code=403, detail="Not allowed")

    rows = await v3_col("approvals").find(
        {"kind": {"$in": [LEAVE_KIND, PERMISSION_KIND]}}, {"_id": 0},
    ).sort("requested_at", -1).to_list(2000)

    emp_ids = list({r.get("employee_id") for r in rows if r.get("employee_id")})
    user_ids = list({r.get("requested_by_user_id") for r in rows
                     if r.get("source") == SOURCE_SELF and r.get("requested_by_user_id")})
    fields = {"_id": 0, "id": 1, "role": 1, "branch_id": 1, "employee_id": 1}
    accounts = await v3_col("users").find(
        {"$or": [{"employee_id": {"$in": emp_ids}}, {"id": {"$in": user_ids}}]}, fields,
    ).to_list(5000)
    by_user = {a["id"]: a for a in accounts}
    by_emp = {a["employee_id"]: a for a in accounts if a.get("employee_id")}

    emps = await v3_col("employees").find(
        {"id": {"$in": emp_ids}}, {"_id": 0, "id": 1, "branch_id": 1},
    ).to_list(5000)
    emp_branch = {e["id"]: e.get("branch_id") or "" for e in emps}
    branch_docs = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    bmap = {b["id"]: b.get("branch_name", "") for b in branch_docs}

    for r in rows:
        acct = (by_user.get(r.get("requested_by_user_id")) if r.get("source") == SOURCE_SELF else None) \
            or by_emp.get(r.get("employee_id")) or {}
        branch_id = acct.get("branch_id") or emp_branch.get(r.get("employee_id")) or ""
        r["role"] = acct.get("role") or ""
        r["branch_name"] = bmap.get(branch_id, "")
    return {"requests": rows}


@router.post("/approvals")
async def create_approval(payload: ApprovalCreate, user: V3UserOut = Depends(require_hr)):
    """HR logging a request on somebody's behalf -- the phone call at seven in the morning.

    The shape of the row is build_request's, the same one the person's own profile posts
    through, so a leave logged here and a leave raised there are the same record with a
    different name in `requested_by`.
    """
    emp = await _employee_or_404(payload.employee_id)
    row = build_request(
        emp,
        payload.kind or LEAVE_KIND,
        from_date=payload.from_date or "",
        to_date=payload.to_date or "",
        from_time=payload.from_time or "",
        to_time=payload.to_time or "",
        amount=payload.amount or 0,
        reason=payload.reason or "",
        requested_by=user.full_name,
        requested_by_user_id=user.id,
        source=SOURCE_HR,
    )
    await v3_col("approvals").insert_one(row.copy())
    row.pop("_id", None)
    return row


@router.patch("/approvals/{approval_id}")
async def decide_approval(
    approval_id: str,
    payload: ApprovalDecision,
    user: V3UserOut = Depends(require_hr),
):
    """Approve or reject, or send a decided request back to pending.

    Reversible on purpose. A leave approved onto the wrong person is caught on the
    register, not in the request list, and the fix has to undo the marks it wrote -- so
    every path through here settles the attendance side as well as the status.

    Both kinds that reach attendance are settled here, and they reach it differently: a
    leave writes the days it covers as `leave`, a permission hangs its hours on the day
    without marking it. Taking either back is the one undo -- see _clear_marks.
    """
    decision = (payload.decision or "").strip()
    if decision not in (APPROVED, REJECTED, PENDING):
        raise HTTPException(status_code=400, detail="Decision must be approved, rejected or pending")
    row = await v3_col("approvals").find_one({"id": approval_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Request not found")

    marks = 0
    if decision == APPROVED:
        marks = await _apply_leave_marks(row, user.full_name)
        marks += await _apply_permission_mark(row, user.full_name)
    else:
        marks = -(await _clear_marks(approval_id))

    await v3_col("approvals").update_one({"id": approval_id}, {"$set": {
        "status": decision,
        "decided_by": user.full_name if decision != PENDING else "",
        "decided_at": now_iso() if decision != PENDING else "",
        "decision_note": (payload.note or "").strip(),
    }})
    updated = await v3_col("approvals").find_one({"id": approval_id}, {"_id": 0})
    return {**updated, "attendance_days_changed": marks}


@router.delete("/approvals/{approval_id}")
async def delete_approval(approval_id: str, _: V3UserOut = Depends(require_hr)):
    cleared = await _clear_marks(approval_id)
    res = await v3_col("approvals").delete_one({"id": approval_id})
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"deleted": True, "attendance_days_cleared": cleared}


# ---------- payroll ----------

DRAFT, FINALISED, PAID = "draft", "finalised", "paid"
# One way only. A month that has been paid is a fact about money that left the account,
# so it does not go back to draft -- correcting it means an adjustment in the next run,
# the way an accountant would do it.
RUN_FLOW = {DRAFT: (FINALISED,), FINALISED: (DRAFT, PAID), PAID: ()}


class PayrollGenerate(BaseModel):
    month: Optional[str] = ""


class SlipAdjust(BaseModel):
    bonus: Optional[float] = None
    deduction: Optional[float] = None
    note: Optional[str] = None


class RunStatus(BaseModel):
    status: str


def _monthly_base(emp: dict) -> float:
    """What a full month pays this person.

    Gross first, net as the fallback. Most records here carry only one of the two, and a
    base of 0 would quietly print a payslip for nothing -- which reads as a bug in the
    payroll rather than as the missing salary figure it actually is. Which one was used
    is reported on the slip as `base_from`, so a surprising figure can be traced to the
    employee record it came from.
    """
    gross = float(emp.get("gross_salary") or 0)
    return gross if gross > 0 else float(emp.get("net_salary") or 0)


def _compute_slip(emp: dict, counts: Dict[str, float], days: int, bonus: float, deduction: float) -> dict:
    """One employee's line for the month.

    Pro-rated on calendar days, which is the method that makes a month's pay independent
    of how many Sundays fell in it: a day of loss of pay costs base/days, whether the
    month is 28 long or 31.

    Days nobody marked are paid. The alternative -- treating silence as absence -- would
    dock somebody's salary because HR was busy, so the count is carried onto the slip as
    `unmarked_days` for the run to show, and the money stays with the employee until
    somebody actually marks the day.
    """
    base = _monthly_base(emp)
    lop = round(sum(counts.get(s, 0) * LOP_DAYS[s] for s in ATTENDANCE_STATUSES), 2)
    payable_days = round(max(days - lop, 0), 2)
    earned = round(base * payable_days / days, 2) if days else 0.0
    marked = sum(counts.get(s, 0) for s in ATTENDANCE_STATUSES)
    return {
        "employee_id": emp["id"],
        "employee_name": emp.get("full_name") or "",
        "employee_code": emp.get("employee_code") or "",
        "department": emp.get("department") or "",
        "designation": emp.get("designation") or "",
        "base": round(base, 2),
        "base_from": "gross_salary" if float(emp.get("gross_salary") or 0) > 0 else "net_salary",
        "days_in_month": days,
        "present_days": counts.get(PRESENT, 0) + counts.get(LATE, 0),
        "leave_days": counts.get(LEAVE, 0),
        "absent_days": counts.get(ABSENT, 0),
        "half_days": counts.get(HALF_DAY, 0),
        "unmarked_days": max(days - marked, 0),
        "lop_days": lop,
        "payable_days": payable_days,
        "earned": earned,
        "bonus": round(bonus, 2),
        "deduction": round(deduction, 2),
        "net_payable": round(earned + bonus - deduction, 2),
    }


async def _run_or_none(month: str) -> Optional[dict]:
    return await v3_col("payroll_runs").find_one({"month": month}, {"_id": 0})


def _totals(slips: List[dict]) -> dict:
    return {
        "employees": len(slips),
        "gross": round(sum(s["earned"] for s in slips), 2),
        "bonus": round(sum(s["bonus"] for s in slips), 2),
        "deduction": round(sum(s["deduction"] for s in slips), 2),
        "net_payable": round(sum(s["net_payable"] for s in slips), 2),
        "lop_days": round(sum(s["lop_days"] for s in slips), 2),
        "unmarked_days": sum(s["unmarked_days"] for s in slips),
    }


@router.get("/payroll")
async def payroll_month(
    month: Optional[str] = Query(None),
    _: V3UserOut = Depends(require_hr),
):
    """A month's payroll: the saved run if there is one, a live preview if there isn't.

    A month nobody has generated still answers, computed from the register as it stands
    right now, and says so via `run: null`. That is what makes the screen useful before
    the month ends -- what payroll would come to today, if it ran today -- without a
    half-finished run sitting in the database claiming to be a record.
    """
    mon = _valid_month(month)
    run = await _run_or_none(mon)
    if run:
        slips = await v3_col("payslips").find({"month": mon}, {"_id": 0}).to_list(2000)
        slips.sort(key=lambda s: str(s.get("employee_name") or "").lower())
        return {"month": mon, "run": run, "slips": slips, "totals": _totals(slips), "preview": False}

    _, _, days = _month_span(mon)
    tally = await _month_marks(mon)
    slips = [_compute_slip(e, tally.get(e["id"]) or {}, days, 0.0, 0.0) for e in await _roster()]
    return {"month": mon, "run": None, "slips": slips, "totals": _totals(slips), "preview": True}


@router.post("/payroll/generate")
async def generate_payroll(payload: PayrollGenerate, user: V3UserOut = Depends(require_hr)):
    """Freeze the month into a run of payslips, or refresh a draft against the register.

    Regenerating a draft keeps the adjustments already typed onto it -- a bonus entered
    on Tuesday survives Wednesday's regeneration -- because the reason to regenerate is
    almost always that attendance moved, not that the adjustments were wrong.
    """
    mon = _valid_month(payload.month)
    run = await _run_or_none(mon)
    if run and run.get("status") != DRAFT:
        raise HTTPException(status_code=400, detail=f"{mon} is {run['status']} — reopen it before regenerating")

    existing = {s["employee_id"]: s for s in await v3_col("payslips").find({"month": mon}, {"_id": 0}).to_list(2000)}
    _, _, days = _month_span(mon)
    tally = await _month_marks(mon)
    roster = await _roster()

    slips = []
    for emp in roster:
        prior = existing.get(emp["id"]) or {}
        slip = _compute_slip(
            emp, tally.get(emp["id"]) or {}, days,
            float(prior.get("bonus") or 0), float(prior.get("deduction") or 0),
        )
        slip.update({
            "id": prior.get("id") or str(uuid.uuid4()),
            "month": mon,
            "note": prior.get("note") or "",
        })
        slips.append(slip)

    await v3_col("payslips").delete_many({"month": mon})
    if slips:
        await v3_col("payslips").insert_many([s.copy() for s in slips])

    row = {
        "id": (run or {}).get("id") or str(uuid.uuid4()),
        "month": mon,
        "status": DRAFT,
        "days_in_month": days,
        "totals": _totals(slips),
        "generated_by": user.full_name,
        "generated_at": now_iso(),
        "paid_at": (run or {}).get("paid_at") or "",
    }
    await v3_col("payroll_runs").update_one({"month": mon}, {"$set": row}, upsert=True)
    slips.sort(key=lambda s: str(s.get("employee_name") or "").lower())
    return {"month": mon, "run": row, "slips": slips, "totals": row["totals"], "preview": False}


@router.patch("/payroll/{month}/slips/{employee_id}")
async def adjust_slip(
    month: str,
    employee_id: str,
    payload: SlipAdjust,
    _: V3UserOut = Depends(require_hr),
):
    """A bonus, a deduction or a note against one person's line. Draft runs only."""
    mon = _valid_month(month)
    run = await _run_or_none(mon)
    if not run:
        raise HTTPException(status_code=404, detail=f"No payroll run for {mon} yet")
    if run.get("status") != DRAFT:
        raise HTTPException(status_code=400, detail=f"{mon} is {run['status']} — reopen it to make changes")
    slip = await v3_col("payslips").find_one({"month": mon, "employee_id": employee_id}, {"_id": 0})
    if not slip:
        raise HTTPException(status_code=404, detail="No payslip for that employee this month")

    bonus = float(slip.get("bonus") or 0) if payload.bonus is None else round(float(payload.bonus), 2)
    deduction = float(slip.get("deduction") or 0) if payload.deduction is None else round(float(payload.deduction), 2)
    if bonus < 0 or deduction < 0:
        raise HTTPException(status_code=400, detail="Amounts can't be negative — a negative bonus is a deduction")

    updates = {
        "bonus": bonus,
        "deduction": deduction,
        "net_payable": round(float(slip.get("earned") or 0) + bonus - deduction, 2),
    }
    if payload.note is not None:
        updates["note"] = payload.note.strip()
    await v3_col("payslips").update_one({"month": mon, "employee_id": employee_id}, {"$set": updates})

    slips = await v3_col("payslips").find({"month": mon}, {"_id": 0}).to_list(2000)
    totals = _totals(slips)
    await v3_col("payroll_runs").update_one({"month": mon}, {"$set": {"totals": totals}})
    return {"slip": {**slip, **updates}, "totals": totals}


@router.post("/payroll/{month}/status")
async def set_run_status(month: str, payload: RunStatus, user: V3UserOut = Depends(require_hr)):
    mon = _valid_month(month)
    run = await _run_or_none(mon)
    if not run:
        raise HTTPException(status_code=404, detail=f"No payroll run for {mon} yet")
    want = (payload.status or "").strip()
    if want not in RUN_FLOW:
        raise HTTPException(status_code=400, detail="Unknown payroll status")
    if want not in RUN_FLOW[run.get("status", DRAFT)]:
        raise HTTPException(status_code=400, detail=f"A {run.get('status')} run can't move to {want}")

    updates = {"status": want}
    if want == PAID:
        updates.update({"paid_at": now_iso(), "paid_by": user.full_name})
    await v3_col("payroll_runs").update_one({"month": mon}, {"$set": updates})
    return {**run, **updates}


# ---------- quotes ----------

MAX_QUOTE = 400


class QuoteInput(BaseModel):
    text: Optional[str] = None
    author: Optional[str] = None
    active: Optional[bool] = None
    pinned: Optional[bool] = None


def _pick_for_today(quotes: List[dict], on: str) -> Optional[dict]:
    """Which of the active quotes is today's.

    A pin wins. Otherwise the day picks one, by counting days since the epoch and taking
    that position in the list -- so it changes every morning on its own and shows the same
    quote to everyone who looks on the same day, with nobody having to post one. Sorted by
    id first so the rotation does not reshuffle when a quote is edited.
    """
    live = [q for q in quotes if q.get("active", True)]
    if not live:
        return None
    pinned = next((q for q in live if q.get("pinned")), None)
    if pinned:
        return pinned
    live.sort(key=lambda q: q["id"])
    return live[date.fromisoformat(on).toordinal() % len(live)]


@router.get("/quotes")
async def list_quotes(_: V3UserOut = Depends(require_hr)):
    quotes = await v3_col("hr_quotes").find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    today = clinic_today()
    return {"quotes": quotes, "today": _pick_for_today(quotes, today), "date": today}


@router.get("/quotes/today")
async def quote_of_the_day(_: V3UserOut = Depends(v3_current_user)):
    """Today's quote, for anybody logged in.

    Open to every role deliberately: a quote board that only HR can see is a noticeboard
    facing a wall. This is the endpoint any staff-facing screen reads to show it.
    """
    quotes = await v3_col("hr_quotes").find({"active": True}, {"_id": 0}).to_list(500)
    today = clinic_today()
    return {"date": today, "quote": _pick_for_today(quotes, today)}


@router.post("/quotes")
async def add_quote(payload: QuoteInput, user: V3UserOut = Depends(require_hr)):
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Write the quote first")
    if len(text) > MAX_QUOTE:
        raise HTTPException(status_code=400, detail=f"Keep it under {MAX_QUOTE} characters")
    if await v3_col("hr_quotes").find_one({"text": text}, {"_id": 0}):
        raise HTTPException(status_code=400, detail="That quote is already on the board")

    row = {
        "id": str(uuid.uuid4()),
        "text": text,
        "author": (payload.author or "").strip(),
        "active": True if payload.active is None else bool(payload.active),
        "pinned": False,
        "added_by": user.full_name,
        "created_at": now_iso(),
    }
    await v3_col("hr_quotes").insert_one(row.copy())
    row.pop("_id", None)
    return row


@router.patch("/quotes/{quote_id}")
async def update_quote(quote_id: str, payload: QuoteInput, _: V3UserOut = Depends(require_hr)):
    row = await v3_col("hr_quotes").find_one({"id": quote_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Quote not found")

    updates: Dict[str, Any] = {}
    if payload.text is not None:
        text = payload.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="A quote can't be empty")
        if len(text) > MAX_QUOTE:
            raise HTTPException(status_code=400, detail=f"Keep it under {MAX_QUOTE} characters")
        updates["text"] = text
    if payload.author is not None:
        updates["author"] = payload.author.strip()
    if payload.active is not None:
        updates["active"] = bool(payload.active)
        # An inactive quote can't be the pinned one -- that would pin the board to
        # something it has been told not to show, and today's quote would come back empty.
        if not updates["active"]:
            updates["pinned"] = False
    if payload.pinned is not None:
        updates["pinned"] = bool(payload.pinned)
        if updates["pinned"]:
            # One pin, so pinning is a choice of quote rather than a growing set of them.
            await v3_col("hr_quotes").update_many({"id": {"$ne": quote_id}}, {"$set": {"pinned": False}})
            updates["active"] = True

    if updates:
        await v3_col("hr_quotes").update_one({"id": quote_id}, {"$set": updates})
    return {**row, **updates}


@router.delete("/quotes/{quote_id}")
async def delete_quote(quote_id: str, _: V3UserOut = Depends(require_hr)):
    res = await v3_col("hr_quotes").delete_one({"id": quote_id})
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Quote not found")
    return {"deleted": True}

# ---------- what somebody is paid, and every figure they have been on ----------

# A salary is a timeline, not a number with an edit history. Each record says what somebody
# was put on and from when, so "what were they paid in March" has an answer that does not
# depend on replaying a log -- and the raise between two records is read off the pair
# rather than stored, which means it cannot disagree with the amounts either side of it.
#
# Held in the collection the change log already used. A row written before this carries
# `to_amount` and `changed_at` instead of `amount` and `effective_from`, and is read as the
# record it always was -- see _as_record. Cheaper than a migration and it cannot miss a row.
SALARY_RECORDS = "salary_history"

# The reasons a salary is set or moved. Seeded rather than hardcoded, because HR adds to
# these: the eight below are what the clinic runs on today and "+ Add new reason" writes a
# ninth beside them. A slug rather than the words, so renaming a label later does not
# orphan every record that used it.
DEFAULT_SALARY_REASONS = [
    {"key": "initial_salary", "label": "Initial Salary", "description": "Salary at joining", "tone": "slate"},
    {"key": "performance", "label": "Performance", "description": "Based on performance review", "tone": "emerald"},
    {"key": "job_confirmation", "label": "Job Confirmation", "description": "After probation completion", "tone": "violet"},
    {"key": "annual_increase", "label": "Annual Increase", "description": "Yearly increment", "tone": "amber"},
    {"key": "six_month_review", "label": "6 Month Review", "description": "6 month performance review", "tone": "purple"},
    {"key": "three_month_review", "label": "3 Month Review", "description": "3 month probation review", "tone": "pink"},
    {"key": "promotion", "label": "Promotion", "description": "Role promotion", "tone": "teal"},
    {"key": "market_adjustment", "label": "Market Adjustment", "description": "Salary market correction", "tone": "sky"},
]
# What a reason somebody adds is coloured. Cycled rather than chosen, so a new one looks
# like it belongs beside the eight without asking whoever typed it to pick a colour.
#
# A colour NAME, not the classes. Tailwind builds its stylesheet from what it can see in
# the source, and a class string assembled here would arrive at a browser that has never
# heard of it -- see REASON_TONES in HROpsTabs.jsx, which is where the literals live.
ADDED_REASON_TONES = ["indigo", "lime", "rose", "cyan", "orange"]

MAX_SALARY_NOTE = 300
# The reasons this clinic renamed away from, kept resolvable so a record written against
# one still reads as words rather than as a slug. Nothing offers them.
RETIRED_REASONS = {
    "annual_increment": "Annual Increase",
    "correction": "Correction",
    "other": "Other",
}


def _slugify_reason(label: str) -> str:
    slug = "".join(c if c.isalnum() else "_" for c in str(label or "").strip().lower())
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_")[:40]


async def _salary_reasons() -> List[dict]:
    """Every reason the dropdown may offer, the eight defaults included.

    Seeded on read rather than by a migration: the list is small, it is read whenever
    somebody opens a salary, and an install that has never opened one does not need rows
    sitting in it. insert_many with ordered=False would race two callers into a duplicate,
    so each is upserted on its key.
    """
    existing = {r["key"] for r in await v3_col("salary_reasons").find({}, {"_id": 0, "key": 1}).to_list(200)}
    missing = [r for r in DEFAULT_SALARY_REASONS if r["key"] not in existing]
    for order, row in enumerate(DEFAULT_SALARY_REASONS):
        if row["key"] in existing:
            continue
        await v3_col("salary_reasons").update_one(
            {"key": row["key"]},
            {"$setOnInsert": {**row, "id": str(uuid.uuid4()), "order": order, "built_in": True}},
            upsert=True,
        )
    rows = await v3_col("salary_reasons").find({}, {"_id": 0}).to_list(200)
    rows.sort(key=lambda r: (r.get("order", 999), str(r.get("label") or "")))
    return rows


def _month_key(value: Any) -> str:
    """A record's month, from whatever shape it was written in.

    Records carry `effective_from` as YYYY-MM. Rows written before they were a timeline
    carry a full `changed_at` timestamp, and the month it happened in is the month it took
    effect from -- there was no way to say otherwise at the time.
    """
    text = str(value or "").strip()
    return text[:7] if len(text) >= 7 else ""


def _as_record(row: dict) -> dict:
    """One stored row as a salary record, whichever shape it was written in."""
    amount = row.get("amount")
    if amount is None:
        amount = row.get("to_amount") or 0
    return {
        "id": row.get("id") or "",
        "effective_from": _month_key(row.get("effective_from") or row.get("changed_at")),
        "amount": round(float(amount or 0), 2),
        "reason": row.get("reason") or "",
        "note": row.get("note") or "",
        "created_by": row.get("created_by") or row.get("changed_by") or "",
        "created_at": row.get("created_at") or row.get("changed_at") or "",
    }


def _months_between(a: str, b: str) -> int:
    """Whole months from one YYYY-MM to another, never negative."""
    try:
        ay, am = int(a[:4]), int(a[5:7])
        by, bm = int(b[:4]), int(b[5:7])
    except (ValueError, IndexError):
        return 0
    return max((by - ay) * 12 + (bm - am), 0)


def _timeline(rows: List[dict], today_month: str) -> List[dict]:
    """The records oldest first, each carrying what it changed and how long it stood.

    The raise and the duration are worked out here rather than stored, so they cannot
    disagree with the amounts on either side of them -- deleting a record in the middle
    re-reads the two it sat between instead of leaving a hike nobody can account for.
    """
    records = sorted(
        (_as_record(r) for r in rows),
        key=lambda r: (r["effective_from"], r["created_at"]),
    )
    out = []
    for i, rec in enumerate(records):
        previous = records[i - 1]["amount"] if i else None
        nxt = records[i + 1]["effective_from"] if i + 1 < len(records) else ""
        change = None if previous is None else round(rec["amount"] - previous, 2)
        out.append({
            **rec,
            "number": i + 1,
            "from_amount": previous,
            "change": change,
            # A raise on nothing is not a percentage, it is the first figure somebody was
            # put on. Left null rather than shown as infinite.
            "percent": (
                round(change / previous * 100, 2)
                if previous not in (None, 0) and change is not None else None
            ),
            "months": _months_between(rec["effective_from"], nxt or today_month),
            "current": i + 1 == len(records),
        })
    return out


def _salary_field(emp: dict) -> str:
    """Which of the two figures to write, so that payroll reads back what was typed.

    _monthly_base prefers gross and falls back to net, so writing gross is what makes a
    number take effect -- except where the record carries only a net figure, which is how
    most of them were entered. Overwriting gross there would leave two salaries on one
    employee and the net one silently ignored, so the field that already means something
    is the field that gets edited.
    """
    if float(emp.get("gross_salary") or 0) > 0:
        return "gross_salary"
    if float(emp.get("net_salary") or 0) > 0:
        return "net_salary"
    # Nothing set at all. Gross, because that is what payroll reads first and a figure
    # typed here should be the figure that pays.
    return "gross_salary"


class SalaryRecordIn(BaseModel):
    amount: float
    reason: str
    # YYYY-MM. Left out means the month now, which is what somebody typing a raise today
    # almost always means.
    effective_from: Optional[str] = ""
    note: Optional[str] = ""


class SalaryReasonIn(BaseModel):
    label: str
    description: Optional[str] = ""


@router.get("/salary-reasons")
async def salary_reasons(_: V3UserOut = Depends(require_hr)):
    """Every reason a salary record may be filed under, and what each one means.

    The descriptions come back with them because the screen shows the list as a legend --
    "3 Month Review" says when, not why, and a dropdown of eight abbreviations is a
    vocabulary somebody has to be taught rather than one they can read.
    """
    return {"reasons": await _salary_reasons()}


@router.post("/salary-reasons")
async def add_salary_reason(payload: SalaryReasonIn, _: V3UserOut = Depends(require_hr)):
    """Add a ninth reason beside the eight.

    HR knows what this clinic gives raises for better than a hardcoded list does. Refused
    where the slug already exists rather than quietly making a second "Performance": two
    reasons of one name is a history that cannot be counted.
    """
    label = str(payload.label or "").strip()[:40]
    if not label:
        raise HTTPException(status_code=400, detail="Give the reason a name")
    key = _slugify_reason(label)
    if not key:
        raise HTTPException(status_code=400, detail="Give the reason a name")
    rows = await _salary_reasons()
    if any(r["key"] == key for r in rows):
        raise HTTPException(status_code=400, detail=f"{label} is already on the list")
    row = {
        "id": str(uuid.uuid4()),
        "key": key,
        "label": label,
        "description": str(payload.description or "").strip()[:120],
        "tone": ADDED_REASON_TONES[len(rows) % len(ADDED_REASON_TONES)],
        "order": 100 + len(rows),
        "built_in": False,
    }
    await v3_col("salary_reasons").insert_one(dict(row))
    return {"reason": row}


@router.get("/employees/{emp_id}/salary")
async def employee_salary(emp_id: str, _: V3UserOut = Depends(require_hr)):
    """What this person is paid, every figure they have been on, and every month they
    have been paid.

    Three answers to three different questions. The timeline is what somebody decided and
    when; the income is what each month actually came to once the register had its say;
    the totals across the top are the timeline read at a glance -- what they started on,
    what they are on, and how far that has moved.
    """
    emp = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0})
    if not emp:
        raise HTTPException(status_code=404, detail="No such employee")

    today_month = clinic_today()[:7]
    rows = await v3_col(SALARY_RECORDS).find({"employee_id": emp_id}, {"_id": 0}).to_list(400)
    timeline = _timeline(rows, today_month)

    # What they were actually paid, month by month, which is a different question from
    # what they are contracted at. A raise is a decision somebody made; a month short by
    # five days of loss of pay is the register doing arithmetic.
    slips = await v3_col("payslips").find({"employee_id": emp_id}, {"_id": 0}).sort("month", -1).to_list(60)
    statuses = {}
    if slips:
        statuses = {
            r["month"]: r.get("status") or ""
            for r in await v3_col("payroll_runs").find(
                {"month": {"$in": [s["month"] for s in slips]}}, {"_id": 0, "month": 1, "status": 1},
            ).to_list(60)
        }
    income = [{
        "month": s.get("month") or "",
        "status": statuses.get(s.get("month"), ""),
        "base": s.get("base") or 0,
        "earned": s.get("earned") or 0,
        "bonus": s.get("bonus") or 0,
        "deduction": s.get("deduction") or 0,
        "net_payable": s.get("net_payable") or 0,
        "lop_days": s.get("lop_days") or 0,
        "payable_days": s.get("payable_days") or 0,
        "days_in_month": s.get("days_in_month") or 0,
    } for s in slips]

    initial = timeline[0]["amount"] if timeline else 0
    current = _monthly_base(emp)
    return {
        "employee_id": emp_id,
        "employee_name": emp.get("full_name") or "",
        "employee_code": emp.get("employee_code") or "",
        "email": emp.get("email") or "",
        "department": emp.get("department") or "",
        "designation": emp.get("designation") or "",
        "amount": current,
        "field": _salary_field(emp),
        "reasons": await _salary_reasons(),
        "records": timeline,
        "income": income,
        "totals": {
            "current": current,
            "initial": initial,
            # The raises, not the records: the figure somebody joined on is not a hike.
            "hikes": sum(1 for r in timeline if r["change"] not in (None, 0)),
            "growth": round((current - initial) / initial * 100, 2) if initial else None,
        },
    }


@router.post("/employees/{emp_id}/salary")
async def add_salary_record(
    emp_id: str,
    payload: SalaryRecordIn,
    user: V3UserOut = Depends(require_hr),
):
    """Put somebody on a figure from a month, and say why.

    One door for the first salary and every raise after it, because they are the same
    thing: a record saying what somebody is on from when. The first one is not a hike and
    is not counted as one -- that falls out of it being first rather than out of a flag.

    Does NOT touch a payroll run that already exists. A generated run froze its figures on
    purpose, so a record added today changes what the next Regenerate produces and leaves a
    finalised month alone.
    """
    reasons = {r["key"] for r in await _salary_reasons()}
    reason = str(payload.reason or "").strip().lower()
    if reason not in reasons:
        raise HTTPException(status_code=400, detail="Pick a reason from the list")

    amount = float(payload.amount or 0)
    if amount < 0:
        raise HTTPException(status_code=400, detail="A salary cannot be negative")
    # Ten million a month is not a salary anybody here is on, and it is what a mistyped
    # figure looks like. Refused rather than clamped: quietly paying somebody a different
    # number from the one on screen is the worse failure.
    if amount > 10_000_000:
        raise HTTPException(status_code=400, detail="That figure looks wrong — check it")

    effective = _month_key(payload.effective_from) or clinic_today()[:7]
    if len(effective) != 7 or effective[4] != "-":
        raise HTTPException(status_code=400, detail="Effective from must be a month")

    emp = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0})
    if not emp:
        raise HTTPException(status_code=404, detail="No such employee")

    existing = await v3_col(SALARY_RECORDS).find({"employee_id": emp_id}, {"_id": 0}).to_list(400)
    if any(_as_record(r)["effective_from"] == effective for r in existing):
        raise HTTPException(
            status_code=400,
            detail="There is already a record from that month — delete it or pick another",
        )

    now = now_iso()
    record = {
        "id": str(uuid.uuid4()),
        "employee_id": emp_id,
        # Copied, not looked up on read. This is a thing somebody did on a day, and it
        # should still name who it was about after the employee record is gone.
        "employee_name": emp.get("full_name") or "",
        "employee_code": emp.get("employee_code") or "",
        "effective_from": effective,
        "amount": round(amount, 2),
        "reason": reason,
        "note": str(payload.note or "").strip()[:MAX_SALARY_NOTE],
        "created_by": user.full_name or user.email,
        "created_at": now,
    }
    await v3_col(SALARY_RECORDS).insert_one(dict(record))
    await _apply_current_salary(emp_id)
    return {"record": record}


@router.delete("/employees/{emp_id}/salary/{record_id}")
async def delete_salary_record(
    emp_id: str,
    record_id: str,
    _: V3UserOut = Depends(require_hr),
):
    """Take a record off the timeline.

    Deleted rather than voided, because the reason to reach for this is a record that
    should never have been written -- a wrong month, a typo, somebody else's raise. The
    hike and duration either side are read off the neighbours, so the two records it sat
    between close up rather than leaving a gap nobody can account for.
    """
    result = await v3_col(SALARY_RECORDS).delete_one({"id": record_id, "employee_id": emp_id})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="No such record")
    await _apply_current_salary(emp_id)
    return {"deleted": record_id}


async def _apply_current_salary(emp_id: str) -> None:
    """Write the newest record's figure onto the employee, which is what payroll reads.

    The timeline is the truth and the field on the employee is a copy of its last line,
    kept because forty other reads want a salary without knowing what a record is. Applied
    after every write and every delete, so removing the newest record puts the one before
    it back rather than leaving payroll on a figure that no longer exists anywhere.
    """
    emp = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0})
    if not emp:
        return
    rows = await v3_col(SALARY_RECORDS).find({"employee_id": emp_id}, {"_id": 0}).to_list(400)
    timeline = _timeline(rows, clinic_today()[:7])
    amount = timeline[-1]["amount"] if timeline else 0
    await v3_col("employees").update_one(
        {"id": emp_id},
        {"$set": {_salary_field(emp): round(amount, 2), "updated_at": now_iso()}},
    )
