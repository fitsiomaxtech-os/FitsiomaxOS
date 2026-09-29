"""HR Admin > Staff > Performance -- how each person on the books did over a period.

Nothing here is typed in. Every figure is read off a record the OS already keeps, so the
list cannot drift from the screens those records live on:

    Attendance   the same day-by-day reading the register and payroll use
                 (SpanContext in routers/v3_hr_ops.py).
    Work done    what the role delivers, counted per role:
                   Physio         treatment and rehab days completed
                   Consultant     consultations completed + 7-day clinical Reviews completed
                   Branch Admin   clients at their branch who converted (dashboard's definition)
                   Pre-Sales      leads they were given that had a slot fixed
                 Every other role has no work figure yet, and is graded on what it does have.
    Rating       the stars clients gave them from the Client Portal (Physio, Consultant,
                 and Branch Admin -- the Feedback tab's Review of the branch desk, credited
                 to every Branch Admin posted at that branch).

The grade is 30% attendance, 50% work done, 20% rating. There are no targets, so work done
is scored against the best in the same role over the same period: the top Physio is 100,
a Physio with half their completed days is 50. A part a person has no figure for is left
out and the rest re-weighted, rather than counted as zero -- a Branch Admin whose clients
have not rated the branch is not marked down for it.

Super Admin only.
"""

from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from database import v3_col
from deps import (
    v3_require_roles, is_physio_role, is_head_physio_role, is_branch_admin_role, is_pre_sales_role,
)
from physio_scope import resolve_physio_doctor, resolve_consultant_doctor
from routers.v3_client_reviews import COLLECTION as REVIEWS, split_legacy
from routers.v3_dashboard import _is_converted
from routers.v3_hr import ALL_BRANCHES
from routers.v3_hr_ops import (
    ABSENT, HALF_DAY, LATE, LEAVE, PRESENT, _dates_between, _roster, _span_context,
)
from schemas.v3 import V3UserOut
from utils import clinic_today, without_past_moves

router = APIRouter(prefix="/api/v3/hr")

WEIGHTS = {"attendance": 0.3, "work": 0.5, "rating": 0.2}
PERIODS = ("week", "month", "quarter")

# Role groups, in the order the list reads them.
GROUP_PHYSIO, GROUP_CONSULTANT, GROUP_BRANCH, GROUP_PRE_SALES, GROUP_OTHER = (
    "physio", "consultant", "branch_admin", "pre_sales", "other",
)
GROUP_ORDER = [GROUP_PHYSIO, GROUP_CONSULTANT, GROUP_BRANCH, GROUP_PRE_SALES, GROUP_OTHER]
GROUP_LABELS = {
    GROUP_PHYSIO: "Physio", GROUP_CONSULTANT: "Consultant", GROUP_BRANCH: "Branch Admin",
    GROUP_PRE_SALES: "Pre-Sales", GROUP_OTHER: "",
}
WORK_LABELS = {
    GROUP_PHYSIO: "sessions", GROUP_CONSULTANT: "consultations", GROUP_BRANCH: "converted",
    GROUP_PRE_SALES: "slots fixed",
}


def period_span(period: str, anchor: str) -> Dict[str, str]:
    """The first and last day of the week, month or quarter holding `anchor`."""
    if period not in PERIODS:
        raise HTTPException(status_code=400, detail="period must be week, month or quarter")
    try:
        day = date.fromisoformat(anchor) if anchor else date.fromisoformat(clinic_today())
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    if period == "week":
        start = day - timedelta(days=day.weekday())
        end = start + timedelta(days=6)
        label = f"{start.strftime('%d %b')} – {end.strftime('%d %b %Y')}"
    elif period == "month":
        start = day.replace(day=1)
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        label = start.strftime("%B %Y")
    else:
        q = (day.month - 1) // 3
        start = date(day.year, q * 3 + 1, 1)
        end = (date(day.year + (q == 3), (q + 1) * 3 % 12 + 1, 1)) - timedelta(days=1)
        label = f"Q{q + 1} {day.year} ({start.strftime('%b')} – {end.strftime('%b')})"
    return {"start": start.isoformat(), "end": end.isoformat(), "label": label}


def role_group(role: str) -> str:
    if is_physio_role(role):
        return GROUP_PHYSIO
    if is_head_physio_role(role):
        return GROUP_CONSULTANT
    if is_branch_admin_role(role):
        return GROUP_BRANCH
    if is_pre_sales_role(role):
        return GROUP_PRE_SALES
    return GROUP_OTHER


def _in(value: Any, start: str, end: str) -> bool:
    day = str(value or "")[:10]
    return bool(day) and start <= day <= end


def attendance_percent(counts: Dict[str, int]) -> Optional[float]:
    """Days turned up for, out of the days they were expected.

    Leave, week offs and holidays are not expected days, so they are neither for nor
    against. A half day is half a day. None when nothing was expected at all.
    """
    expected = counts[PRESENT] + counts[LATE] + counts[HALF_DAY] + counts[ABSENT]
    if not expected:
        return None
    return round((counts[PRESENT] + counts[LATE] + 0.5 * counts[HALF_DAY]) / expected * 100, 1)


def grade_of(parts: Dict[str, Optional[float]]) -> Dict[str, Any]:
    """Weighted score of the parts that have a figure, and the letter it earns."""
    have = {k: v for k, v in parts.items() if v is not None}
    if not have:
        return {"score": None, "grade": None}
    weight = sum(WEIGHTS[k] for k in have)
    score = round(sum(WEIGHTS[k] * v for k, v in have.items()) / weight)
    return {"score": score, "grade": "A" if score >= 80 else "B" if score >= 60 else "C"}


async def _ratings(ids: List[str], name: str, start: str, end: str, raw: List[dict]) -> List[int]:
    """Client stars for one person in the period, matched by record id or by name.

    By name as well because a person can hold twin expert records (see physio_scope), and a
    review filed against the twin is still about them.
    """
    key = name.strip().lower()
    out = []
    for r in raw:
        if not r.get("rating") or r.get("skipped"):
            continue
        if not _in(r.get("updated_at") or r.get("created_at"), start, end):
            continue
        if r.get("person_id") in ids or (key and str(r.get("person_name") or "").strip().lower() == key):
            out.append(int(r["rating"]))
    return out


@router.get("/performance")
async def staff_performance(
    period: str = Query("month"),
    anchor: Optional[str] = Query(None, alias="date"),
    _: V3UserOut = Depends(v3_require_roles("super_admin")),
):
    span = period_span(period, anchor or "")
    start, end = span["start"], span["end"]
    today = clinic_today()

    roster = await _roster()
    emp_ids = [e["id"] for e in roster]
    accounts = await v3_col("users").find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "id": 1, "employee_id": 1, "role": 1, "full_name": 1, "branch_id": 1, "branch_ids": 1},
    ).to_list(2000)
    account_of = {a["employee_id"]: a for a in accounts}

    # Attendance, read exactly as the register reads it, and never past today.
    ctx = await _span_context(start, end, roster)
    days = [d for d in _dates_between(start, end) if d <= today]

    raw_reviews = [r for row in await v3_col(REVIEWS).find({}, {"_id": 0}).to_list(20000) for r in split_legacy(row)]

    rows: List[Dict[str, Any]] = []
    for e in roster:
        account = account_of.get(e["id"]) or {}
        group = role_group(account.get("role") or "")
        counts = {s: 0 for s in (PRESENT, LATE, HALF_DAY, ABSENT, LEAVE)}
        for iso in days:
            status = ctx.status(e, iso)["status"]
            if status in counts:
                counts[status] += 1

        work = None
        work_sub = ""
        ratings: List[int] = []
        user_id = account.get("id") or ""
        name = e.get("full_name") or account.get("full_name") or ""

        if group == GROUP_PHYSIO and user_id:
            doctor = await resolve_physio_doctor(user_id, account.get("role") or "")
            ids = (doctor or {}).get("physio_ids") or []
            work = 0
            for col in ("sessions", "rehab_sessions"):
                done = await v3_col(col).find(
                    {"physio_id": {"$in": ids}, "status": "completed"},
                    {"_id": 0, "completed_at": 1, "slot_time": 1},
                ).to_list(20000) if ids else []
                work += sum(1 for s in done if _in(s.get("completed_at") or s.get("slot_time"), start, end))
            ratings = await _ratings(ids, name, start, end, [r for r in raw_reviews if r.get("kind") == "physio"])

        elif group == GROUP_CONSULTANT and user_id:
            doctor = await resolve_consultant_doctor(user_id, account.get("role") or "")
            ids = (doctor or {}).get("consultant_ids") or []
            appts = await v3_col("appointments").find(
                {"doctor_id": {"$in": ids}, "status": "completed"}, {"_id": 0, "slot_time": 1},
            ).to_list(20000) if ids else []
            reviews = await v3_col("reviews").find(
                {"head_physio_id": {"$in": ids}, "status": "completed"},
                {"_id": 0, "completed_at": 1, "review_date": 1},
            ).to_list(20000) if ids else []
            consults = sum(1 for a in appts if _in(a.get("slot_time"), start, end))
            done_reviews = sum(1 for r in reviews if _in(r.get("completed_at") or r.get("review_date"), start, end))
            work = consults + done_reviews
            work_sub = f"{consults} consults · {done_reviews} reviews"
            ratings = await _ratings(ids, name, start, end, [r for r in raw_reviews if r.get("kind") == "consultant"])

        elif group == GROUP_BRANCH:
            branches = [b for b in [account.get("branch_id"), *(account.get("branch_ids") or []), e.get("branch_id")] if b]
            leads = await v3_col("leads").find(
                without_past_moves({"branch_id": {"$in": branches}, "created_at": {"$gte": start, "$lte": f"{end}T23:59:59.999999"}}),
                {"_id": 0, "treatment_fee_paid": 1, "session_package_id": 1, "diet_fee_paid": 1, "diet_chart_fee_paid": 1},
            ).to_list(20000) if branches else []
            work = sum(1 for lead in leads if _is_converted(lead))
            work_sub = f"of {len(leads)} leads"
            ratings = [
                int(r["rating"]) for r in raw_reviews
                if r.get("kind") == "branch_admin" and r.get("branch_id") in branches and r.get("rating")
                and _in(r.get("updated_at") or r.get("created_at"), start, end)
            ]

        elif group == GROUP_PRE_SALES and user_id:
            leads = await v3_col("leads").find(
                {"assigned_user_id": user_id, "created_at": {"$gte": start, "$lte": f"{end}T23:59:59.999999"}},
                {"_id": 0, "appointment_date": 1},
            ).to_list(20000)
            work = sum(1 for lead in leads if lead.get("appointment_date"))
            work_sub = f"of {len(leads)} leads"

        rows.append({
            "employee_id": e["id"],
            "full_name": name,
            "employee_code": e.get("employee_code") or "",
            "designation": e.get("designation") or "",
            "department": e.get("department") or "",
            "photo_url": e.get("photo_url") or "",
            "branch_name": e.get("branch_name") or "",
            # Every branch this person covers, for the Branch filter. The employee record and
            # the account can each hold some; a desk posted to all branches matches any of them.
            "branch_ids": list(dict.fromkeys(b for b in [
                e.get("branch_id"), *(e.get("branch_ids") or []),
                account.get("branch_id"), *(account.get("branch_ids") or []),
            ] if b and b != ALL_BRANCHES)),
            "all_branches": ALL_BRANCHES in (e.get("branch_id"), *(e.get("branch_ids") or [])),
            "group": group,
            "role_label": GROUP_LABELS[group] or e.get("designation") or "Staff",
            "attendance": attendance_percent(counts),
            "present_days": counts[PRESENT] + counts[LATE],
            "late_days": counts[LATE],
            "absent_days": counts[ABSENT],
            "leave_days": counts[LEAVE],
            "work": work,
            "work_label": WORK_LABELS.get(group, ""),
            "work_sub": work_sub,
            "rating": round(sum(ratings) / len(ratings), 1) if ratings else None,
            "rating_count": len(ratings),
        })

    # Work done against the best in the same role, then the grade.
    best = {}
    for r in rows:
        if r["work"] is not None:
            best[r["group"]] = max(best.get(r["group"], 0), r["work"])
    for r in rows:
        top = best.get(r["group"]) or 0
        work_score = None if r["work"] is None else (round(r["work"] / top * 100, 1) if top else 0.0)
        r["work_score"] = work_score
        r.update(grade_of({
            "attendance": r["attendance"],
            "work": work_score,
            "rating": None if r["rating"] is None else r["rating"] / 5 * 100,
        }))

    rows.sort(key=lambda r: (GROUP_ORDER.index(r["group"]), -(r["score"] if r["score"] is not None else -1), r["full_name"].lower()))
    return {"period": period, **span, "weights": WEIGHTS, "rows": rows}
