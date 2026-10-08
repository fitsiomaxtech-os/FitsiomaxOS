from fastapi import APIRouter, Depends, HTTPException, Query
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from database import v3_col
from utils import CLINIC_UTC_OFFSET, clinic_day_of, clinic_today, live_branch_query, without_past_moves
from stage_utils import get_closing_stage_name
from deps import v3_current_user, v3_require_roles
from constants import V3_STAGES, V3_BRANCH_STAGES
from schemas.v3 import V3UserOut, V3LeadOut
from routers.v3_finance import REVENUE_ACTIONS, CONSULTATION_FEE_ACTIONS, _parse_rs_amount, _revenue_category, _lead_session_summary

router = APIRouter(prefix="/api/v3")

# The vertical names already used when creating leads/branches (see CRMPage.jsx's
# verticalDefaults / defaultBranch) — Physiotherapy gets its own branch-by-branch
# breakdown (2x2 cards); the other three are shown as one aggregate card each.
DASHBOARD_VERTICAL_LABELS = {
    "offline_fitness_gym": "Offline Fitness",
    "online_physiotherapy": "Online Physiotherapy",
    "online_fitness": "Online Fitness",
}


async def _stage_names(stage_type: str, fallback: list) -> list:
    """Live stage names from Super Admin > Pipeline Stage Management, falling back to the
    built-in defaults if none have been configured yet (mirrors v3_branch_admin.py)."""
    rows = await v3_col("pipeline_stages").find({"type": stage_type}, {"_id": 0, "name": 1}).sort("order", 1).to_list(200)
    names = [r["name"] for r in rows]
    return names or fallback


def _clinic_today_window() -> tuple:
    """Today on the clinic's clock, as the [start, end) pair of UTC stamps created_at is
    stored in. Shared by the Today's Leads card and the list it opens, so the two cannot
    come back different lengths.

    It used to be UTC midnight, which is 05:30 IST: at eleven in the morning "today" was
    five and a half hours old, and a sheet lead -- dated on the ad account's clock, see
    enquiry_created_at -- did not reach it until four in the afternoon. The card read 0 on
    mornings the desk had new leads.
    """
    today = clinic_today()
    return _clinic_day_start_utc(today), _clinic_day_start_utc(today, plus_days=1)


@router.get("/dashboard/bd-summary")
async def v3_bd_summary(
    branch_id: Optional[str] = Query(None),
    source_tab: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin")),
):
    # Filter toolbar support — every lead-derived metric below respects these, so switching
    # Branch/Lead Source/Status/Date Range re-scopes the whole dashboard, not just the table.
    # Past Data's trial clients are left out from the start, so every figure built off this
    # leaves them out too (see without_past_moves).
    lead_match: dict = without_past_moves()
    if branch_id:
        lead_match["branch_id"] = branch_id
    if source_tab:
        lead_match["source_tab"] = source_tab
    if stage:
        lead_match["stage"] = stage
    if start_date or end_date:
        created_range: dict = {}
        if start_date:
            created_range["$gte"] = start_date
        if end_date:
            created_range["$lte"] = end_date
        lead_match["created_at"] = created_range

    appt_match: dict = {}
    if branch_id:
        appt_match["branch_id"] = branch_id
    if start_date or end_date:
        appt_match["created_at"] = lead_match.get("created_at", {})

    def lead_filter(extra: Optional[dict] = None) -> dict:
        out = dict(lead_match)
        if extra:
            out.update(extra)
        return out

    total_leads = await v3_col("leads").count_documents(lead_filter())
    stage_counts = {}
    for s in await _stage_names("pre_sales", V3_STAGES):
        stage_counts[s] = await v3_col("leads").count_documents(lead_filter({"stage": s}))

    source_pipeline = [
        {"$match": lead_match},
        {"$group": {"_id": {"$ifNull": ["$source_tab", "$source_type"]}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    source_agg = await v3_col("leads").aggregate(source_pipeline).to_list(100)
    source_counts = {item["_id"]: item["count"] for item in source_agg if item["_id"]}

    branch_pipeline = [
        {"$match": lead_filter({"branch_id": {"$ne": None}})},
        {"$group": {"_id": "$branch_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    branch_agg = await v3_col("leads").aggregate(branch_pipeline).to_list(100)
    branches_all = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(1000)
    branch_map = {b["id"]: b["branch_name"] for b in branches_all}
    branch_counts = [
        {"branch_id": item["_id"], "branch_name": branch_map.get(item["_id"], "Unknown"), "count": item["count"]}
        for item in branch_agg
    ]

    total_appointments = await v3_col("appointments").count_documents(appt_match)
    completed_appointments = await v3_col("appointments").count_documents({**appt_match, "status": "completed"})
    total_branches = await v3_col("branches").count_documents(live_branch_query())
    # Lead Sources (marketing_sources) is where sheets are actually connected now. The old
    # sheet_connections collection is only written by the API test suite, so counting it
    # showed ~20 "connected sheets" against the 9 cards on Marketing > Lead Sources.
    total_connections = await v3_col("marketing_sources").count_documents(LIVE_SOURCE_QUERY)

    recent_leads = await v3_col("leads").find(lead_match, {"_id": 0}).sort("created_at", -1).to_list(10)
    recent_out = [V3LeadOut(**r) for r in recent_leads]

    # Time-bucketed lead volume — real, computed straight off created_at, no invented figures.
    # Every bucket is a clinic day (or a run of them), so today's trend bucket and the card
    # are the same window -- see _clinic_today_window.
    # Bounded above as well as below: a lead with a mistyped future created_at is not
    # today's, and without the upper bound it counted here while the week_trend bucket for
    # today (which is bounded) left it out -- the card and its trend line disagreed.
    today_start, today_end = _clinic_today_window()
    today_leads = await v3_col("leads").count_documents(lead_filter({
        "created_at": {"$gte": today_start, "$lt": today_end}
    }))

    today = date.fromisoformat(clinic_today())

    def opens(day: date) -> str:
        return _clinic_day_start_utc(day.isoformat())

    week_start = today - timedelta(days=6)
    prev_week_start = week_start - timedelta(days=7)
    leads_this_week = await v3_col("leads").count_documents(lead_filter({"created_at": {"$gte": opens(week_start)}}))
    leads_last_week = await v3_col("leads").count_documents(lead_filter({
        "created_at": {"$gte": opens(prev_week_start), "$lt": opens(week_start)}
    }))

    week_trend = []
    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        count = await v3_col("leads").count_documents(lead_filter({
            "created_at": {"$gte": opens(day), "$lt": opens(day + timedelta(days=1))}
        }))
        week_trend.append({"date": day.isoformat(), "count": count})

    month_trend = []
    month_cursor = today.replace(day=1)
    months = []
    for _ in range(6):
        months.append(month_cursor)
        month_cursor = (month_cursor - timedelta(days=1)).replace(day=1)
    for month_start in reversed(months):
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        count = await v3_col("leads").count_documents(lead_filter({
            "created_at": {"$gte": opens(month_start), "$lt": opens(next_month)}
        }))
        month_trend.append({"month": month_start.strftime("%Y-%m"), "count": count})

    # Revenue actually collected against leads (Consultation + Treatment Fee) — real ledger sum.
    revenue_pipeline = [
        {"$match": lead_match},
        {"$group": {
            "_id": None,
            "total": {"$sum": {"$add": [
                {"$ifNull": ["$package_paid", 0]},
                {"$ifNull": ["$treatment_fee_paid", 0]},
            ]}},
        }},
    ]
    revenue_agg = await v3_col("leads").aggregate(revenue_pipeline).to_list(1)
    revenue_generated = revenue_agg[0]["total"] if revenue_agg else 0

    conversion_rate = round((completed_appointments / total_leads) * 100, 1) if total_leads else 0.0

    return {
        "total_leads": total_leads,
        "stage_counts": stage_counts,
        "source_counts": source_counts,
        "branch_counts": branch_counts,
        "total_appointments": total_appointments,
        "completed_appointments": completed_appointments,
        "total_branches": total_branches,
        "total_connections": total_connections,
        "recent_leads": [r.model_dump() for r in recent_out],
        "today_leads": today_leads,
        "leads_this_week": leads_this_week,
        "leads_last_week": leads_last_week,
        "week_trend": week_trend,
        "month_trend": month_trend,
        "revenue_generated": revenue_generated,
        "conversion_rate": conversion_rate,
        "applied_filters": {"branch_id": branch_id, "source_tab": source_tab, "stage": stage, "start_date": start_date, "end_date": end_date},
    }


# Every card on the Business Development dashboard opens the rows it counted. The counts
# come from /dashboard/bd-summary above; these are the same collections under the same
# filters, so a card reading 2 cannot open a list of five. That is the whole reason this
# is an endpoint rather than a filter over the leads the board already holds: three of
# these nine metrics are not lead rows at all (two read `appointments`, one reads
# `sheet_connections`), and a client-side approximation of them would disagree with the
# number the person just clicked.
#
# `kind` tells the caller which shape came back -- one of "lead", "appointment", "branch"
# or "connection" -- because the four carry different columns. The caller owns the column
# set; this owns which rows belong to which card.
# A Lead Source card that is still on the Active tab of Marketing > Lead Sources.
LIVE_SOURCE_QUERY = {"is_archived": {"$ne": True}}

BD_ROW_METRICS = {
    "total", "today", "followup", "appointments",
    "converted", "revenue", "conversion", "branches", "sheets",
}

# The branch a lead has when it has none -- an online arm's leads carry no branch at all,
# and so do any whose branch has since been deleted. Spelled as a sentinel rather than as
# an empty string because every branch param in here is falsy-tested, so "" would read as
# "no filter" and quietly answer a question about one bucket with every lead there is.
#
# Returned by /dashboard/marketing-sources on a row keyed to that bucket, and understood
# by /dashboard/bd-summary/rows below, so a desk can click the row and get its leads. The
# two must agree on the spelling; they are the only two that use it.
UNASSIGNED_BRANCH = "__unassigned__"

# A cap, not a page. These lists are read to answer "which ones are they", and a desk
# scrolling past a few hundred rows has stopped reading and wants a filter instead. The
# total is returned alongside so the table can say what it is not showing rather than
# quietly ending.
BD_ROWS_LIMIT = 500


@router.get("/dashboard/bd-summary/rows")
async def v3_bd_summary_rows(
    metric: str = Query(..., description="Which card was opened: one of BD_ROW_METRICS"),
    branch_id: Optional[str] = Query(None),
    # A comma-separated set of branches, for a caller filtering by a *group* of them
    # rather than by one -- the Business Development desk's Offline/Online split, which
    # resolves to every branch on that side of the estate. `branch_id` still wins where
    # both arrive: one named branch is the narrower question of the two.
    branch_ids: Optional[str] = Query(None),
    source_tab: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin")),
):
    if metric not in BD_ROW_METRICS:
        raise HTTPException(status_code=400, detail=f"Unknown metric: {metric}")

    # Built exactly as /dashboard/bd-summary builds them. Kept as a copy of that shape
    # rather than a shared helper for now: the summary's version also feeds the appointment
    # and revenue aggregations there, and pulling one filter out of it while leaving those
    # behind is how the two drift apart.
    # One branch, or the set a group resolved to -- never both, and an empty set is not the
    # same as no filter. A group holding no branches (Online, before any exist) must come
    # back empty rather than falling through to every branch there is.
    branch_clause = (
        {"$in": [None, ""]} if branch_id == UNASSIGNED_BRANCH
        else branch_id if branch_id
        else {"$in": [b for b in branch_ids.split(",") if b]} if branch_ids is not None
        else None
    )

    lead_match: dict = without_past_moves()
    if branch_clause is not None:
        lead_match["branch_id"] = branch_clause
    if source_tab:
        lead_match["source_tab"] = source_tab
    if stage:
        lead_match["stage"] = stage
    if start_date or end_date:
        created_range: dict = {}
        if start_date:
            created_range["$gte"] = start_date
        if end_date:
            created_range["$lte"] = end_date
        lead_match["created_at"] = created_range

    appt_match: dict = {}
    if branch_clause is not None:
        appt_match["branch_id"] = branch_clause
    if start_date or end_date:
        appt_match["created_at"] = lead_match.get("created_at", {})

    # The same clinic-day window today_leads in /dashboard/bd-summary counts, from the same
    # helper, so the list is exactly the figure that was clicked.
    today_start, today_end = _clinic_today_window()

    # Which collection, and which query over it, per card. Named the same as the metric
    # keys the cards carry so the two can be read side by side.
    if metric in {"total", "today", "followup", "revenue"}:
        query = dict(lead_match)
        if metric == "today":
            query["created_at"] = {"$gte": today_start, "$lt": today_end}
        elif metric == "followup":
            query["stage"] = "Follow Up"
        elif metric == "revenue":
            # The leads the revenue figure is a sum over -- Consultation + Treatment Fee
            # actually collected. A lead that has paid neither contributes nothing to the
            # number, so it does not belong in the list behind it.
            query["$or"] = [
                {"package_paid": {"$gt": 0}},
                {"treatment_fee_paid": {"$gt": 0}},
            ]
        total = await v3_col("leads").count_documents(query)
        rows = await v3_col("leads").find(query, {"_id": 0}).sort("created_at", -1).to_list(BD_ROWS_LIMIT)
        return {
            "metric": metric,
            "kind": "lead",
            "total": total,
            "rows": [V3LeadOut(**r).model_dump() for r in rows],
        }

    if metric in {"appointments", "converted", "conversion"}:
        query = dict(appt_match)
        # Conversion Rate is completed_appointments over total_leads, so the rows worth
        # opening under it are the completed appointments -- its numerator. The
        # denominator is Total Leads, one card away.
        if metric in {"converted", "conversion"}:
            query["status"] = "completed"
        total = await v3_col("appointments").count_documents(query)
        rows = await v3_col("appointments").find(
            query,
            {"_id": 0, "id": 1, "lead_id": 1, "lead_name": 1, "branch_id": 1,
             "doctor_name": 1, "slot_time": 1, "status": 1, "created_at": 1},
        ).sort("created_at", -1).to_list(BD_ROWS_LIMIT)
        return {"metric": metric, "kind": "appointment", "total": total, "rows": rows}

    if metric == "branches":
        # live_branch_query(), the same as total_branches -- an archived branch is not one
        # of the eight the card is counting.
        query = live_branch_query()
        total = await v3_col("branches").count_documents(query)
        rows = await v3_col("branches").find(
            query,
            {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1, "address": 1,
             "admin_name": 1, "admin_email": 1, "admin_phone": 1, "created_at": 1},
        ).sort("created_at", -1).to_list(BD_ROWS_LIMIT)
        return {"metric": metric, "kind": "branch", "total": total, "rows": rows}

    # metric == "sheets"
    total = await v3_col("marketing_sources").count_documents(LIVE_SOURCE_QUERY)
    sources = await v3_col("marketing_sources").find(
        LIVE_SOURCE_QUERY,
        {"_id": 0, "id": 1, "name": 1, "spreadsheet_id": 1, "auto_sync_enabled": 1,
         "auto_sync_interval_minutes": 1, "last_synced": 1, "created_at": 1},
    ).sort("created_at", -1).to_list(BD_ROWS_LIMIT)
    # Same column keys the drill table already reads.
    rows = [
        {
            "id": s.get("id"),
            "connection_name": s.get("name"),
            "spreadsheet_id": s.get("spreadsheet_id"),
            "sync_interval_minutes": s.get("auto_sync_interval_minutes") if s.get("auto_sync_enabled") else None,
            "last_synced_at": s.get("last_synced"),
            "created_at": s.get("created_at"),
        }
        for s in sources
    ]
    return {"metric": metric, "kind": "connection", "total": total, "rows": rows}


@router.get("/lead-sources")
async def v3_lead_sources(_: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    pipeline = [
        {"$match": without_past_moves()},
        {"$group": {
            "_id": {"source_tab": {"$ifNull": ["$source_tab", "Manual"]}, "source_type": "$source_type"},
            "count": {"$sum": 1},
            "stages": {"$push": "$stage"},
        }},
        {"$sort": {"count": -1}},
    ]
    agg = await v3_col("leads").aggregate(pipeline).to_list(200)
    sources = []
    for item in agg:
        stage_breakdown = {}
        for s in item["stages"]:
            stage_breakdown[s] = stage_breakdown.get(s, 0) + 1
        sources.append({
            "source_tab": item["_id"]["source_tab"],
            "source_type": item["_id"]["source_type"],
            "total": item["count"],
            "stage_breakdown": stage_breakdown,
        })
    return sources


@router.get("/boards/master")
async def v3_master_board(_: V3UserOut = Depends(v3_current_user)):
    stage_counts = {}
    for stage in await _stage_names("pre_sales", V3_STAGES):
        stage_counts[stage] = await v3_col("leads").count_documents(without_past_moves({"stage": stage}))
    total = await v3_col("leads").count_documents(without_past_moves())
    return {"stage_counts": stage_counts, "total": total}


@router.get("/boards/branch-master")
async def v3_branch_master_board(_: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin", "head_physio"))):
    """Aggregated counts across all branches keyed by branch_stage (for Super Admin Master View)."""
    branch_stages = await _stage_names("sales", V3_BRANCH_STAGES)
    branch_stage_counts = {}
    for stage in branch_stages:
        branch_stage_counts[stage] = await v3_col("leads").count_documents(without_past_moves({"branch_stage": stage}))
    total = await v3_col("leads").count_documents(without_past_moves({"branch_stage": {"$in": branch_stages}}))
    return {"branch_stage_counts": branch_stage_counts, "total": total}


@router.get("/boards/branch/{branch_id}")
async def v3_branch_board(branch_id: str, _: V3UserOut = Depends(v3_current_user)):
    stage_counts = {}
    for stage in await _stage_names("pre_sales", V3_STAGES):
        stage_counts[stage] = await v3_col("leads").count_documents({"stage": stage, "branch_id": branch_id})
    return {"branch_id": branch_id, "stage_counts": stage_counts}


@router.get("/boards/master-control")
async def v3_master_control(
    branch_id: Optional[str] = Query(None),
    service_type: Optional[str] = Query(None),   # vertical name
    expert_id: Optional[str] = Query(None),      # assigned_physio_id
    time_range: Optional[str] = Query("current"),
    _: V3UserOut = Depends(v3_require_roles("super_admin")),
):
    """Aggregated metrics for the Super Admin Master Control Board (attention, today queue, sync, analytics).

    Filters applied across all aggregations (counts, journey, analytics):
    - branch_id, service_type, expert_id, time_range ("current" | "last_30" | "last_90" | "all")
    """
    leads = v3_col("leads")
    now = datetime.now(timezone.utc)
    today_iso = now.date().isoformat()

    # Time range bounds
    range_start_iso = None
    if time_range == "last_30":
        range_start_iso = (now - timedelta(days=30)).isoformat()
    elif time_range == "last_90":
        range_start_iso = (now - timedelta(days=90)).isoformat()
    elif time_range in (None, "", "current"):
        # Current Academic Year: 1 April of current FY → 31 March next year
        fy_start_year = now.year if now.month >= 4 else now.year - 1
        range_start_iso = datetime(fy_start_year, 4, 1, tzinfo=timezone.utc).isoformat()

    # Build a base filter to merge into every count_documents() call
    base = without_past_moves()
    if branch_id:
        base["branch_id"] = branch_id
    if service_type:
        base["vertical"] = service_type
    if expert_id:
        base["assigned_physio_id"] = expert_id
    if range_start_iso:
        base["created_at"] = {"$gte": range_start_iso}

    def merged(extra=None):
        out = dict(base)
        if extra:
            for k, v in extra.items():
                if k in out and isinstance(out[k], dict) and isinstance(v, dict):
                    out[k] = {**out[k], **v}
                else:
                    out[k] = v
        return out

    total_leads = await leads.count_documents(merged())
    first_branch_stage = (await _stage_names("sales", V3_BRANCH_STAGES))[0]
    # The Head Physio pipeline's closing stage — renamed since it shipped, so counting the
    # old literal here reported zero consultations however many there were.
    head_closing_stage = await get_closing_stage_name("head_consultation", "Consultation Visit")

    # Patient journey counts (label → count).
    # The displayed Journey Flow Map pills follow the real lifecycle
    # Branch → Head Physio → Branch → End (see MasterControlBoard JOURNEY_PILLS):
    #   New Appointment → Appointment Date & Time → Consultation → Fee Collected
    #   → Physio Assign → Patient.
    # The pre-sales (stage) and Portfolio counts are kept only to feed the Live
    # Analytics workflow split below; they are not rendered as journey pills.
    journey = {
        # Pre-sales + Portfolio — analytics only, not shown as pills
        "New Lead": await leads.count_documents(merged({"stage": "New Leads"})),
        "Follow Up": await leads.count_documents(merged({"stage": "Follow Up"})),
        "Appointment": await leads.count_documents(merged({"stage": "Appointment"})),
        "Portfolio": await leads.count_documents(merged({"branch_stage": "Portfolio"})),
        # Branch (leads) → Head Physio (consultation) → Branch (consultation) → End
        "New Appointment": await leads.count_documents(merged({"branch_stage": first_branch_stage})),
        "Appointment Date & Time": await leads.count_documents(merged({"branch_stage": "Appointment Date & Time"})),
        "Consultation": await leads.count_documents(merged({"head_consultation_stage": head_closing_stage})),
        "Fee Collected": await leads.count_documents(merged({"consultation_stage": "Fee Collected"})),
        "Physio Assign": await leads.count_documents(merged({"consultation_stage": "Physio Assign"})),
        "Patient": await leads.count_documents(merged({"consultation_stage": "Consultation Completed"})),
    }

    # Attention Required
    attention = {
        "follow_up_pending": await leads.count_documents(merged({"stage": "Follow Up"})),
        "date_time_pending": await leads.count_documents(merged({"branch_stage": "Portfolio"})),
        "branch_pending": await leads.count_documents(merged({"stage": "Appointment", "branch_id": None})),
        "expert_pending": await leads.count_documents(merged({"stage": "Appointment", "assigned_physio_id": None})),
        "sync_issue": 0,
    }

    # Today's Priority Queue
    todays_follow_ups = await leads.count_documents(merged({"stage": "Follow Up", "follow_up_date": today_iso}))
    appointments_today = await leads.count_documents(merged({"appointment_date": today_iso}))
    new_appointments = await leads.count_documents(merged({"branch_stage": first_branch_stage}))
    pending_branch_actions = attention["date_time_pending"] + attention["branch_pending"]
    today_queue = {
        "todays_follow_ups": todays_follow_ups,
        "appointments_today": appointments_today,
        "new_appointments": new_appointments,
        "pending_branch_actions": pending_branch_actions,
    }

    # Sync & System Health — read from marketing_sources (the actual production sheet ingestion collection)
    sources = await v3_col("marketing_sources").find({}, {"_id": 0}).to_list(1000)
    last_source = None
    latest_iso = None
    for src in sources:
        ls = src.get("last_synced") or src.get("last_synced_at")
        if ls and (latest_iso is None or ls > latest_iso):
            latest_iso = ls
            last_source = src

    connected_count = sum(1 for s in sources if s.get("oauth_connected") or s.get("last_synced") or s.get("last_synced_at"))
    new_rows_total = sum(int(s.get("last_sync_imported") or 0) for s in sources)
    duplicates_total = sum(int(s.get("last_sync_skipped_duplicate") or 0) for s in sources)

    # Mapping status — how many sources have column_mapping set vs total
    sources_with_mapping = sum(1 for s in sources if (s.get("column_mapping") or {}))
    if not sources:
        mapping_status = "—"
    elif sources_with_mapping == len(sources):
        mapping_status = "All Mapped"
    elif sources_with_mapping == 0:
        mapping_status = "Not Mapped"
    else:
        mapping_status = f"{sources_with_mapping}/{len(sources)} Mapped"

    sync_health = {
        "sheet_status": "Connected" if connected_count > 0 else ("Configured" if sources else "Not Connected"),
        "sources_total": len(sources),
        "sources_connected": connected_count,
        "last_sync": latest_iso,
        "last_sync_source": (last_source or {}).get("name") if last_source else None,
        "new_rows": new_rows_total,
        "duplicates_skipped": duplicates_total,
        "mapping_status": mapping_status,
    }

    # Live Analytics — Lead Workflow split (filter-aware via journey counts)
    workflow = [
        {"name": "New", "value": journey["New Lead"]},
        {"name": "In Review", "value": journey["Follow Up"]},
        {"name": "Confirmed", "value": journey["Appointment"] + journey["New Appointment"] + journey["Portfolio"] + journey["Appointment Date & Time"]},
        {"name": "Archived", "value": await leads.count_documents(merged({"branch_stage": "Cancelled"}))},
    ]

    # Patient Information Completion
    not_empty = {"$nin": [None, ""]}
    completed = await leads.count_documents(merged({"name": not_empty, "phone": not_empty, "email": not_empty}))
    patient_info = [
        {"name": "Completed", "value": completed},
        {"name": "Incomplete", "value": max(total_leads - completed, 0)},
    ]

    # Period comparison — current vs previous (always 30-day window regardless of time_range)
    cur_start = (now - timedelta(days=30)).isoformat()
    prev_start = (now - timedelta(days=60)).isoformat()
    base_no_time = {k: v for k, v in base.items() if k != "created_at"}

    def merged_no_time(extra=None):
        out = dict(base_no_time)
        if extra:
            out.update(extra)
        return out

    current_records = await leads.count_documents(merged_no_time({"created_at": {"$gte": cur_start}}))
    previous_records = await leads.count_documents(merged_no_time({"created_at": {"$gte": prev_start, "$lt": cur_start}}))

    def pct(n, d):
        return round((n / d) * 100, 2) if d else 0.0

    patient_profile = await leads.count_documents(merged({"name": not_empty, "phone": not_empty}))
    appointment_details = await leads.count_documents(merged({"appointment_date": {"$ne": None}}))
    expert_assignment = await leads.count_documents(merged({"assigned_physio_id": {"$ne": None}}))

    progress = {
        "patient_profile": {"completed": patient_profile, "total": total_leads, "percent": pct(patient_profile, total_leads)},
        "appointment_details": {"completed": appointment_details, "total": total_leads, "percent": pct(appointment_details, total_leads)},
        "expert_assignment": {"completed": expert_assignment, "total": total_leads, "percent": pct(expert_assignment, total_leads)},
    }

    return {
        "live_time": now.isoformat(),
        "applied_filters": {"branch_id": branch_id, "service_type": service_type, "expert_id": expert_id, "time_range": time_range},
        "journey": journey,
        "attention": attention,
        "today_queue": today_queue,
        "sync_health": sync_health,
        "analytics": {
            "workflow": workflow,
            "workflow_total": total_leads,
            "patient_info": patient_info,
            "patient_info_total": total_leads,
            "current_period": {"label": "Current Period", "records": current_records, "percent": pct(current_records, total_leads)},
            "previous_period": {"label": "Previous Period", "records": previous_records, "percent": pct(previous_records, total_leads)},
            "progress": progress,
            "total_records": total_leads,
        },
    }


# Two clocks, and a date filter has to know which of them it is reading.
#
# Every board here sends a plain calendar day -- "2026-09-03" -- and every one of them
# means the clinic's day: the day the branch worked and counts its figures against. What
# that day is worth as a query depends entirely on how the field being filtered was
# written, and the two kinds in this database do not answer to the same bound.
#
#   appointment_date   the day the branch picked, stored as typed  ("2026-09-03")
#   slot_time          a wall-clock slot the branch published      ("2026-09-03T10:00")
#       Local already. The day compares against them directly, and always did.
#
#   created_at         an instant, always UTC and always offset-stamped -- see now_iso()
#                      and enquiry_created_at(), which both end in "+00:00"
#       Midnight on the clinic's day is 18:30 UTC on the day BEFORE. Compared as written,
#       the window is the right length and five and a half hours late: it drops whatever
#       the clinic did between midnight and 05:30 and takes the small hours of the next
#       morning in exchange.
#
# One helper compared both kinds the same way, so a single row of cards was reading two
# different windows at once -- Sessions Total Booked counting the clinic's day off
# slot_time, while Leads, Consultations and every revenue figure beside it counted a UTC
# day off created_at. Hence a row that reported six sessions booked on a day it also
# reported nothing sold and nobody seen: not one window disagreeing with the data, but two
# windows disagreeing with each other.


def _local_date_range_query(field: str, start_date: Optional[str], end_date: Optional[str]) -> dict:
    """A clinic day, against a field already stored on the clinic's own clock."""
    if not start_date and not end_date:
        return {}
    rng: dict = {}
    if start_date:
        rng["$gte"] = start_date
    if end_date:
        # Sorts after every wall-clock stamp on that day, and after a bare date.
        rng["$lte"] = f"{end_date}T23:59:59"
    return {field: rng}


def _clinic_day_start_utc(day: str, plus_days: int = 0) -> Optional[str]:
    """Midnight opening a clinic day, written as the UTC stamp it is stored as.

    None for anything that is not a date, which leaves that end of the range unbounded --
    the same thing an absent start_date/end_date has always meant here. A filter that
    cannot be read should widen the window, not silently empty it.
    """
    try:
        d = date.fromisoformat(str(day)[:10])
    except (TypeError, ValueError):
        return None
    midnight = datetime(d.year, d.month, d.day) + timedelta(days=plus_days)
    return (midnight - CLINIC_UTC_OFFSET).isoformat()


def _utc_stamp_range_query(field: str, start_date: Optional[str], end_date: Optional[str]) -> dict:
    """A clinic day, against a field stored as a UTC instant.

    Half-open at the top -- `$lt` the midnight that opens the next day, rather than `$lte`
    some stamp inside this one. The stored values carry microseconds and a "+00:00" suffix,
    and a bound written to sit at the last second of a day is one a real stamp sorts past
    on the strength of that suffix alone. A boundary is cheaper to name than to approach.
    """
    lo = _clinic_day_start_utc(start_date) if start_date else None
    hi = _clinic_day_start_utc(end_date, plus_days=1) if end_date else None
    rng: dict = {}
    if lo:
        rng["$gte"] = lo
    if hi:
        rng["$lt"] = hi
    return {field: rng} if rng else {}


# clinic_day_of, imported above, is the counterpart to these two and the other half of the
# same mistake: they draw the WINDOW on the clinic's clock, it puts each row that came back
# on a DAY on the same clock. It lives in utils beside CLINIC_UTC_OFFSET, because which day
# something happened on is the clinic's definition and not this board's.


@router.get("/dashboard/overview")
async def v3_dashboard_overview(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    # Sales Head and Marketing Head read the same org-wide funnel from the Sales Master
    # View's Analytics pane — that board offers it to all three (isSuperAdminMasterView),
    # and while this admitted only Super Admin the other two were served a 403 that the
    # panel rendered as a row of zeros.
    #
    # Business Development Executive for the same reason: their board carries the
    # Marketing View and Sales View tabs, which are that same PreSalesCRM master view,
    # so leaving them out here would print the zeros on a fourth board.
    _: V3UserOut = Depends(v3_require_roles("super_admin", "sales_head", "marketing_head", "business_dev")),
):
    """Super Admin's new Dashboard (the default landing view), and the Branches &
    Verticals Overview tab — Leads / Appointments / Consultations / Treatments /
    Sessions Booked / Revenue / Pending Session Amount for a date range, each split into
    the Physiotherapy branches (one count per branch) plus one aggregate per other
    vertical. Revenue is built off the lead_activity payment trail like
    finance/revenue-overview — leads/appointments/sessions carry no payment date of
    their own, activity log entries do. Pending Session Amount is the one field that
    ignores start_date/end_date — see the comment at its bucket for why."""
    branches = await v3_col("branches").find(live_branch_query(), {"_id": 0, "id": 1, "branch_name": 1, "vertical": 1}).to_list(500)
    branch_by_id = {b["id"]: b for b in branches}
    physio_branches = [b for b in branches if b.get("vertical") == "offline_physiotherapy"]
    other_verticals = list(DASHBOARD_VERTICAL_LABELS.keys())

    def branch_vertical(branch_id):
        return (branch_by_id.get(branch_id) or {}).get("vertical")

    def new_bucket():
        return {
            "total": 0.0,
            "physio_branches": {b["id"]: 0.0 for b in physio_branches},
            "verticals": {v: 0.0 for v in other_verticals},
            # Every branch, offline or online — physio_branches/verticals above stay
            # exactly as they were (the main Dashboard's 2x2 layout depends on that split),
            # this is additive for callers (the Branches & Verticals Overview tab) that
            # need each branch on its own regardless of vertical, including an online
            # branch sharing a vertical with another online branch.
            "branches": {b["id"]: 0.0 for b in branches},
        }

    def add_to_bucket(bucket, branch_id, vertical, amount=1.0):
        bucket["total"] += amount
        if branch_id in bucket["physio_branches"]:
            bucket["physio_branches"][branch_id] += amount
        elif vertical in bucket["verticals"]:
            bucket["verticals"][vertical] += amount
        if branch_id in bucket["branches"]:
            bucket["branches"][branch_id] += amount

    def format_bucket(bucket, currency=False):
        rnd = (lambda v: round(v, 2)) if currency else int
        return {
            "total": rnd(bucket["total"]),
            "physio_branches": [
                {"branch_id": b["id"], "branch_name": b["branch_name"], "value": rnd(bucket["physio_branches"][b["id"]])}
                for b in physio_branches
            ],
            "verticals": [
                {"vertical": v, "label": DASHBOARD_VERTICAL_LABELS[v], "value": rnd(bucket["verticals"][v])}
                for v in other_verticals
            ],
            "branches": [
                {"branch_id": b["id"], "branch_name": b["branch_name"], "vertical": b.get("vertical"), "value": rnd(bucket["branches"][b["id"]])}
                for b in branches
            ],
        }

    leads_bucket = new_bucket()
    lead_rows = await v3_col("leads").find(
        without_past_moves(_utc_stamp_range_query("created_at", start_date, end_date)), {"_id": 0, "branch_id": 1, "vertical": 1}
    ).to_list(50000)
    for l in lead_rows:
        bid = l.get("branch_id")
        add_to_bucket(leads_bucket, bid, l.get("vertical") or branch_vertical(bid))

    # A lead that actually has an appointment, not merely one whose appointment_date falls
    # in range — with no dates the range clause is empty, and this counted every lead in the
    # system as booked. The date filter was doing the work of the existence check, which
    # held right up until a range with no dates in it was asked for.
    appt_bucket = new_bucket()
    appt_query = {"appointment_date": {"$nin": [None, ""]}}
    appt_query.update(_local_date_range_query("appointment_date", start_date, end_date))
    appt_rows = await v3_col("leads").find(
        appt_query, {"_id": 0, "branch_id": 1, "vertical": 1}
    ).to_list(50000)
    for l in appt_rows:
        bid = l.get("branch_id")
        add_to_bucket(appt_bucket, bid, l.get("vertical") or branch_vertical(bid))

    # One query, two buckets: `sessions_booked` is every session scheduled in range,
    # `treatments` is the subset actually completed — same as it was, just no longer a
    # second round trip to re-ask the same collection with one field's filter removed.
    treat_bucket = new_bucket()
    sessions_booked_bucket = new_bucket()
    # Treatment sessions only. Login tokens live in this same collection (see v3_auth), and
    # they are told apart by carrying no lead_id. Without this the unfiltered range — which
    # is what "All" asks for, and which makes the date clause an empty query — matched every
    # token ever issued and reported them as booked sessions. Any dated range hid the
    # problem, since a token has no slot_time to fall inside it.
    sess_query = {"lead_id": {"$exists": True}}
    sess_query.update(_local_date_range_query("slot_time", start_date, end_date))
    sess_rows = await v3_col("sessions").find(sess_query, {"_id": 0, "branch_id": 1, "status": 1}).to_list(50000)
    for s in sess_rows:
        bid = s.get("branch_id")
        vertical = branch_vertical(bid)
        add_to_bucket(sessions_booked_bucket, bid, vertical)
        if s.get("status") == "completed":
            add_to_bucket(treat_bucket, bid, vertical)

    revenue_bucket = new_bucket()
    consultations_bucket = new_bucket()
    # revenue_split below totals consultation/session/diet org-wide only — these two mirror
    # it per branch/vertical, for cards (Overview tab) that need "Consultations Revenue"
    # or "Session Amount Collected" for one branch rather than the whole business.
    consultation_revenue_bucket = new_bucket()
    session_revenue_bucket = new_bucket()
    # How many patients bought a treatment package, against session_revenue_bucket's how
    # much they paid for them — a count nothing reported until now: the session figures
    # were all money and slots, with no "how many signed up".
    #
    # One per patient, not one per payment. A package bought on a payment schedule logs a
    # treatment_fee_collected for every installment (see mark_installment_paid), so
    # counting the payments made a patient paying in three parts look like three
    # purchases — which is how this managed to exceed the consultation count.
    treatment_purchase_bucket = new_bucket()
    treatment_purchase_leads: set = set()
    # The same Consultation / Session split Accountant Manage reports, so the Dashboard's
    # headline figures and the Collections boards can't disagree about what a payment was
    # for. `action` and `created_at` have to be projected for this — the branch buckets
    # below never needed either.
    # Every category _revenue_category can return is seeded, because the increment below is
    # `+=` and a missing key raises. "rehab" arrived with the Rehab fee and was not added
    # here, which took the whole Super Admin dashboard down with a KeyError the first time
    # one was collected — the board went dark over a line item it did not know about.
    #
    # Seeded AND defaulted: the seeding keeps the reported lines explicit, and the default
    # means the next category added somewhere else costs a figure nobody labelled rather
    # than the entire board. A dashboard that cannot name a payment should still count it.
    revenue_split = {"consultation": 0.0, "session": 0.0, "diet": 0.0, "rehab": 0.0, "spot_joining": 0.0, "zumba": 0.0}
    zumba_query: dict = {}
    zumba_query.update(_utc_stamp_range_query("created_at", start_date, end_date))
    zumba_rows = await v3_col("zumba_registrations").find(
        zumba_query, {"_id": 0, "branch_id": 1, "fee_paid": 1},
    ).to_list(5000)
    for reg in zumba_rows:
        try:
            amount = float(reg.get("fee_paid") or 0)
        except (TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        bid = reg.get("branch_id")
        add_to_bucket(revenue_bucket, bid, branch_vertical(bid), amount)
        revenue_split["zumba"] += amount

    activity_query = {"action": {"$in": REVENUE_ACTIONS}}
    activity_query.update(_utc_stamp_range_query("created_at", start_date, end_date))
    activities = await v3_col("lead_activity").find(
        activity_query, {"_id": 0, "lead_id": 1, "details": 1, "action": 1, "created_at": 1}
    ).to_list(50000)
    activity_lead_ids = list({a["lead_id"] for a in activities if a.get("lead_id")})
    activity_leads = await v3_col("leads").find(
        {"id": {"$in": activity_lead_ids}}, {"_id": 0, "id": 1, "branch_id": 1, "vertical": 1}
    ).to_list(50000)
    activity_lead_map = {l["id"]: l for l in activity_leads}

    # Which days each patient paid a consultation fee on. Spot joining is a treatment fee
    # collected on one of those same days — the patient signed up on the spot rather than
    # going away to think about it.
    #
    # Reading this off the in-range activities alone is safe: the filter is whole days
    # either way, so a same-day pair is either both inside the range or both outside it.
    # A treatment fee whose consultation fell in some earlier range isn't spot joining
    # anyway.
    # Keyed on the Consultation Fee actions themselves, not on the "consultation" reporting
    # bucket — that bucket also holds the Diet Consultation Fee, and a diet fee taken on the
    # same day as a treatment fee would otherwise mark that treatment fee as spot joining.
    consult_days: dict[str, set] = {}
    for a in activities:
        if a.get("action", "") in CONSULTATION_FEE_ACTIONS:
            consult_days.setdefault(a.get("lead_id"), set()).add(str(a.get("created_at", ""))[:10])

    for a in activities:
        lead = activity_lead_map.get(a.get("lead_id"), {})
        bid = lead.get("branch_id")
        vertical = lead.get("vertical") or branch_vertical(bid)
        amount = _parse_rs_amount(a.get("details", ""))
        add_to_bucket(revenue_bucket, bid, vertical, amount)
        category = _revenue_category(a.get("action", ""))
        revenue_split[category] = revenue_split.get(category, 0.0) + amount
        if category == "consultation":
            add_to_bucket(consultation_revenue_bucket, bid, vertical, amount)
        elif category == "session":
            add_to_bucket(session_revenue_bucket, bid, vertical, amount)
            purchase_lead = a.get("lead_id")
            if purchase_lead and purchase_lead not in treatment_purchase_leads:
                treatment_purchase_leads.add(purchase_lead)
                add_to_bucket(treatment_purchase_bucket, bid, vertical)
        if category == "session" and str(a.get("created_at", ""))[:10] in consult_days.get(a.get("lead_id"), ()):
            revenue_split["spot_joining"] += amount
        # A consultation held, not just booked — counted off the same Consultation Fee
        # actions consult_days above already keys on, so this and Appointment Booked can
        # read differently on purpose: an appointment with no fee collected yet was
        # scheduled but hasn't happened.
        if a.get("action", "") in CONSULTATION_FEE_ACTIONS:
            add_to_bucket(consultations_bucket, bid, vertical)

    # An outstanding balance, not an event — what's owed right now on each patient's
    # session/treatment package. Deliberately not scoped to start_date/end_date: a
    # balance owed doesn't have a date the way a payment or a lead does, so filtering it
    # by the range above would make "pending" mean something different every time the
    # date filter changed.
    pending_bucket = new_bucket()
    pending_leads = await v3_col("leads").find(
        {},
        {
            "_id": 0, "branch_id": 1, "vertical": 1,
            "session_package_sessions": 1, "package_sessions": 1,
            "session_package_name": 1, "package_name": 1,
            "treatment_fee_payment_details": 1, "treatment_fee_paid": 1,
        },
    ).to_list(50000)
    for lead in pending_leads:
        due = _lead_session_summary(lead).get("due") or 0
        if due:
            bid = lead.get("branch_id")
            add_to_bucket(pending_bucket, bid, lead.get("vertical") or branch_vertical(bid), due)

    return {
        "applied_filters": {"start_date": start_date, "end_date": end_date},
        "leads": format_bucket(leads_bucket),
        "appointments": format_bucket(appt_bucket),
        "consultations": format_bucket(consultations_bucket),
        "treatments": format_bucket(treat_bucket),
        "sessions_booked": format_bucket(sessions_booked_bucket),
        "treatment_purchases": format_bucket(treatment_purchase_bucket),
        "consultation_revenue": format_bucket(consultation_revenue_bucket, currency=True),
        "session_revenue": format_bucket(session_revenue_bucket, currency=True),
        "pending_session_amount": format_bucket(pending_bucket, currency=True),
        # spot_joining is a slice of session, not money on top of it — total stays
        # consultation + session + diet.
        "revenue": {
            **format_bucket(revenue_bucket, currency=True),
            "consultation": round(revenue_split["consultation"], 2),
            "session": round(revenue_split["session"], 2),
            "diet": round(revenue_split["diet"], 2),
            "rehab": round(revenue_split["rehab"], 2),
            "zumba": round(revenue_split["zumba"], 2),
            "spot_joining": round(revenue_split["spot_joining"], 2),
        },
    }


_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Readable names for the vertical slugs stored on a lead. Anything unrecognised keeps its
# own value rather than being folded into "Other" — a vertical added later should show up
# named, not disappear.
_VERTICAL_LABELS = {
    "offline_physiotherapy": "Physiotherapy",
    "online_physiotherapy": "Online Physio",
    "offline_fitness_gym": "Fitness",
    "offline_fitness": "Fitness",
    "online_fitness": "Online Fitness",
}


def _vertical_label(vertical: Optional[str]) -> str:
    slug = str(vertical or "").strip()
    return _VERTICAL_LABELS.get(slug) or (slug.replace("_", " ").title() if slug else "Unspecified")


def _is_online_vertical(vertical: Optional[str]) -> bool:
    return str(vertical or "").startswith("online_")


def _weekday_of(created_at: Optional[str]) -> Optional[str]:
    """Mon..Sun for a lead's created_at, or None if it has no usable date.

    On the clinic's clock, like every other day this file counts: a lead taken at 02:00 on
    a Sunday is stored at 20:30 Saturday UTC, and "which days run hot" is a question about
    the day the desk worked, not the day Greenwich was having.
    """
    day = clinic_day_of(created_at)
    try:
        return _WEEKDAYS[date.fromisoformat(day).weekday()]
    except (ValueError, TypeError):
        return None


@router.get("/dashboard/leads-analytics")
async def v3_dashboard_leads_analytics(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    branch_ids: Optional[str] = Query(None, description="Comma-separated; omit for every branch"),
    # Same four as /dashboard/overview above, and for the same reason: this is what the
    # Marketing master view's Analytics pane charts, and the Business Development
    # Executive's board now mounts that view as one of its tabs.
    _: V3UserOut = Depends(v3_require_roles("super_admin", "sales_head", "marketing_head", "business_dev")),
):
    """Leads, four ways: over time, by pipeline stage, by source, by branch.

    Deliberately no money and no session/treatment counts. This answers the marketing
    question — how many leads arrived, where from, and how far they got — and mixing
    revenue into it invites reading a source's worth off a chart that never priced
    anything. /dashboard/overview is where the financial picture lives.

    Every figure counts the same leads over the same window, so the four charts are four
    readings of one set rather than four queries that can disagree. Branch scoping is a
    list rather than a single id because the board's filters are a group (Offline/Online)
    as often as one branch, and resolving that to ids is the client's job — it owns the
    pills that define it.
    """
    query: dict = without_past_moves(_utc_stamp_range_query("created_at", start_date, end_date))
    wanted_branches = [b for b in (branch_ids or "").split(",") if b.strip()]
    if wanted_branches:
        query["branch_id"] = {"$in": wanted_branches}
    leads = await v3_col("leads").find(
        query,
        {"_id": 0, "created_at": 1, "stage": 1, "branch_id": 1, "source_tab": 1, "source_type": 1,
         "vertical": 1, "appointment_date": 1, "assigned_user_name": 1},
    ).to_list(50000)

    branch_rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    branch_names = {b["id"]: b.get("branch_name") or "—" for b in branch_rows}

    # Day buckets for anything up to a quarter, months beyond it. A year plotted by day is
    # 365 points on a card this size; a week plotted by month is one.
    #
    # Split offline/online as it goes: the two are different businesses arriving through
    # different channels, and one line summing both hides a swing in either.
    #
    # Bucketed by the clinic's day, the same clock the window above was drawn on -- see
    # clinic_day_of. The first ten characters of the stored stamp are a UTC date, and
    # reading the day off those put the small hours on the day before.
    by_day: dict = {}
    for lead in leads:
        day = clinic_day_of(lead.get("created_at"))
        if not day:
            continue
        row = by_day.setdefault(day, {"offline": 0, "online": 0})
        row["online" if _is_online_vertical(lead.get("vertical")) else "offline"] += 1

    def _trend_rows(buckets: dict) -> list:
        return [
            {"period": k, "leads": v["offline"] + v["online"], "offline": v["offline"], "online": v["online"]}
            for k, v in sorted(buckets.items())
        ]

    if len(by_day) > 92:
        rolled: dict = {}
        for day, counts in by_day.items():
            row = rolled.setdefault(day[:7], {"offline": 0, "online": 0})
            row["offline"] += counts["offline"]
            row["online"] += counts["online"]
        trend = _trend_rows(rolled)
        grain = "month"
    else:
        trend = _trend_rows(by_day)
        grain = "day"

    # Stage order comes from the pipeline itself, not from counting — a funnel drawn in
    # descending order stops being a funnel, and an empty stage still has to hold its place
    # or the shape lies about where leads are dropping.
    stage_order = await _stage_names("pre_sales", V3_STAGES)
    stage_counts = {name: 0 for name in stage_order}
    # Leads whose stage is not one of the configured pre-sales stages -- renamed in
    # Pipeline Stage Management since they were filed, or left on a stage that has since
    # been removed. They used to be counted nowhere, so the funnel quietly stopped adding
    # up to the total above it; they are carried and reported below instead.
    off_pipeline = 0
    by_source: dict = {}
    by_branch: dict = {}
    by_vertical: dict = {}
    by_weekday = {name: 0 for name in _WEEKDAYS}
    by_owner: dict = {}
    # Leads and the subset that reached a booking, per source. Two counts rather than a
    # ready-made percentage: a rate on its own hides that it came off four leads, and the
    # card needs both to say whether a source is good or merely lucky.
    booked_by_source: dict = {}
    for lead in leads:
        stage = lead.get("stage")
        if stage in stage_counts:
            stage_counts[stage] += 1
        else:
            off_pipeline += 1
        source = _lead_source(lead)
        by_source[source] = by_source.get(source, 0) + 1
        if str(lead.get("appointment_date") or "").strip():
            booked_by_source[source] = booked_by_source.get(source, 0) + 1
        bid = lead.get("branch_id") or ""
        by_branch[bid] = by_branch.get(bid, 0) + 1
        by_vertical[_vertical_label(lead.get("vertical"))] = by_vertical.get(_vertical_label(lead.get("vertical")), 0) + 1
        weekday = _weekday_of(lead.get("created_at"))
        if weekday:
            by_weekday[weekday] += 1
        owner = (lead.get("assigned_user_name") or "").strip() or "Unassigned"
        by_owner[owner] = by_owner.get(owner, 0) + 1

    def _ranked(counts: dict, cap: int) -> list:
        """Biggest first, with everything past `cap` folded into one Other row. Past that
        many classes the labels stop being readable and the tail says less than "Other"."""
        ranked = sorted(counts.items(), key=lambda kv: -kv[1])
        rows = [{"name": k, "value": v} for k, v in ranked[:cap]]
        tail = sum(v for _k, v in ranked[cap:])
        if tail:
            rows.append({"name": "Other", "value": tail})
        return rows

    return {
        "applied_filters": {"start_date": start_date, "end_date": end_date, "branch_ids": wanted_branches},
        "total": len(leads),
        "booked": sum(booked_by_source.values()),
        "grain": grain,
        "trend": trend,
        # Pipeline order, plus a residual row only when there is one to show. Naming it
        # rather than dropping it keeps the funnel's bars summing to `total`; it is a
        # remainder, not a stage, and nothing is added to the pipeline to hold it.
        "by_stage": [{"name": name, "value": stage_counts[name]} for name in stage_order]
                    + ([{"name": "Not in the pipeline", "value": off_pipeline}] if off_pipeline else []),
        # Six plus Other: a part-to-whole read at a glance stops working past about six
        # slices, whatever the palette can hold.
        "by_source": _ranked(by_source, 6),
        "by_branch": _ranked(_named_branch_counts(by_branch, branch_names), 8),
        "by_vertical": _ranked(by_vertical, 6),
        # Calendar order, not ranked — the question is which days run hot, and a bar chart
        # sorted by volume can't be read as a week.
        "by_weekday": [{"name": name, "value": by_weekday[name]} for name in _WEEKDAYS],
        "by_owner": _ranked(by_owner, 8),
        "conversion_by_source": sorted(
            (
                {
                    "name": name,
                    "leads": total,
                    "booked": booked_by_source.get(name, 0),
                    "rate": round(booked_by_source.get(name, 0) / total * 100, 1) if total else 0.0,
                }
                # A rate off a handful of leads is noise, and it lands at the top of the
                # chart looking like the best channel there is.
                for name, total in by_source.items() if total >= 5
            ),
            key=lambda r: -r["rate"],
        )[:8],
    }


@router.get("/dashboard/leads-trend")
async def v3_dashboard_leads_trend(
    months: int = Query(6, ge=2, le=24),
    # business_dev beside super_admin: the Business Development desk now mounts Super
    # Admin's own Dashboard > Analytics tab, and the branch-by-branch growth chart at the
    # bottom of it reads this. Group-wide and read-only, like the rest of that tab.
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """Leads, Appointments, Treatments and Revenue per branch, by calendar month, most
    recent last. The route keeps its leads-trend name because callers and tests already
    use it; each branch now carries a `series` of all four alongside the original
    `values`, which stays the leads row.

    Every live branch, whatever its service type — the same list /dashboard/overview
    hands the Analytics tab's branch filter. This used to keep offline_physiotherapy
    branches only, so a branch on any other type (Anna Nagar) was offered in the filter
    above the chart and had no line on it: picking it faded every line there was and
    highlighted nothing.

    All four are counted exactly as /dashboard/overview counts them, field for field, so
    a headline card and the line drawn under it cannot disagree about what the metric is.

    Takes no date filter of its own. A trend answers "which way is this going", and a
    six-month line inside a one-day filter would be a single point — the board's range
    control narrows the figures above it, not the shape of the history behind them.

    Every branch gets a full-length row, zeros included. A branch that took no leads in
    March has a real value of 0 there, and dropping the point would draw a line straight
    from February to April as though the month never happened.
    """
    branches = await v3_col("branches").find(
        live_branch_query(), {"_id": 0, "id": 1, "branch_name": 1}
    ).to_list(500)
    if not branches:
        return {"months": [], "branches": []}

    now = datetime.now(timezone.utc)
    keys: list = []
    y, m = now.year, now.month
    for _i in range(months):
        keys.append(f"{y}-{str(m).zfill(2)}")
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    keys.reverse()

    branch_ids = [b["id"] for b in branches]
    floor = f"{keys[0]}-01"

    # One bucket per metric. Each is {branch_id: {month_key: number}}, and `key in bucket`
    # rather than a date comparison guards every add: the $gte bounds below are string
    # comparisons, so a malformed date can slip past one and would otherwise land in no
    # month at all — or worse, create one.
    def empty():
        return {bid: {k: 0.0 for k in keys} for bid in branch_ids}

    def add(bucket, branch_id, raw_date, amount=1.0):
        row = bucket.get(branch_id)
        key = str(raw_date or "")[:7]
        if row is not None and key in row:
            row[key] += amount

    # The four are counted exactly as /dashboard/overview counts them, field for field, so
    # a card and the line under it can never disagree about what a metric means: leads by
    # created_at, appointments by appointment_date, treatments as completed sessions by
    # slot_time, revenue off the lead_activity payment trail.
    leads_b, appts_b, treat_b, rev_b = empty(), empty(), empty(), empty()

    for r in await v3_col("leads").find(
        without_past_moves({"branch_id": {"$in": branch_ids}, "created_at": {"$gte": floor}}),
        {"_id": 0, "branch_id": 1, "created_at": 1},
    ).to_list(100000):
        add(leads_b, r.get("branch_id"), r.get("created_at"))

    for r in await v3_col("leads").find(
        {"branch_id": {"$in": branch_ids}, "appointment_date": {"$gte": floor}},
        {"_id": 0, "branch_id": 1, "appointment_date": 1},
    ).to_list(100000):
        add(appts_b, r.get("branch_id"), r.get("appointment_date"))

    for s in await v3_col("sessions").find(
        {"branch_id": {"$in": branch_ids}, "status": "completed", "slot_time": {"$gte": floor}},
        {"_id": 0, "branch_id": 1, "slot_time": 1},
    ).to_list(100000):
        add(treat_b, s.get("branch_id"), s.get("slot_time"))

    # Revenue has no branch on the activity itself, so each payment is attributed through
    # its lead — the same hop /dashboard/overview makes.
    activities = await v3_col("lead_activity").find(
        {"action": {"$in": REVENUE_ACTIONS}, "created_at": {"$gte": floor}},
        {"_id": 0, "lead_id": 1, "details": 1, "created_at": 1},
    ).to_list(100000)
    act_lead_ids = list({a["lead_id"] for a in activities if a.get("lead_id")})
    lead_branch = {
        l["id"]: l.get("branch_id")
        for l in await v3_col("leads").find({"id": {"$in": act_lead_ids}}, {"_id": 0, "id": 1, "branch_id": 1}).to_list(100000)
    }
    for a in activities:
        add(rev_b, lead_branch.get(a.get("lead_id")), a.get("created_at"), _parse_rs_amount(a.get("details", "")))

    def series(bucket, bid, currency=False):
        return [round(bucket[bid][k], 2) if currency else int(bucket[bid][k]) for k in keys]

    return {
        "months": keys,
        "branches": [
            {
                "branch_id": b["id"],
                "branch_name": b.get("branch_name", ""),
                # Kept as the leads series so any older caller reading `values` is unaffected.
                "values": series(leads_b, b["id"]),
                "series": {
                    "leads": series(leads_b, b["id"]),
                    "appointments": series(appts_b, b["id"]),
                    "treatments": series(treat_b, b["id"]),
                    "revenue": series(rev_b, b["id"], currency=True),
                },
            }
            for b in branches
        ],
    }


ROLE_LABELS = {
    "branch_admin": "Branch Admin",
    "pre_sales": "Pre-Sales",
    "super_admin": "Super Admin",
    "head_physio": "CONSULTANT",
    "physio": "Physio",
}


@router.get("/dashboard/branch-breakdown")
async def v3_dashboard_branch_breakdown(
    branch_id: str = Query(...),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    _: V3UserOut = Depends(v3_require_roles("super_admin")),
):
    """Who did the work behind one branch's Dashboard number, for the same date range.

    Four groups, each a total and a per-person count:

      Pre Sales           leads owned by a Pre-Sales agent  (leads.assigned_user_id)
      Branch Appointment  consultation appointments, by who booked them
                          (appointments.created_by — the only record of *who*; nothing
                          assigns an appointment to a person the way a lead is assigned)
      Head Physio         those same appointments, by the doctor seen
      Physio              leads with a physio assigned  (leads.assigned_physio_id)

    Every roster is drawn from the branch's own staff first, so someone who did nothing
    in the period still shows with 0 rather than vanishing — an empty week is a fact
    about that person, not an absence of one. Anyone who appears in the data but isn't
    on the roster (left the branch, moved role) is appended, so the member counts always
    add up to the group total.
    """
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1, "branch_name": 1})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    lead_rows = await v3_col("leads").find(
        {"branch_id": branch_id, **_utc_stamp_range_query("created_at", start_date, end_date)},
        {"_id": 0, "assigned_user_id": 1, "assigned_user_name": 1, "assigned_physio_id": 1, "assigned_physio_name": 1},
    ).to_list(50000)

    appt_rows = await v3_col("appointments").find(
        {"branch_id": branch_id, "appt_kind": "consultation", **_utc_stamp_range_query("created_at", start_date, end_date)},
        {"_id": 0, "doctor_id": 1, "doctor_name": 1, "created_by": 1, "created_by_role": 1},
    ).to_list(50000)

    users = await v3_col("users").find(
        {"$or": [{"branch_id": branch_id}, {"branch_ids": branch_id}]},
        {"_id": 0, "id": 1, "full_name": 1, "role": 1},
    ).to_list(500)
    doctors = await v3_col("doctors").find(
        {"branch_id": branch_id}, {"_id": 0, "id": 1, "full_name": 1, "profile_type": 1}
    ).to_list(500)

    def build(roster, rows, key_of, name_of, unassigned_as=None):
        """roster seeds the zeros; rows supply the counts. Keyed by id where there is
        one, otherwise by name — appointments record `created_by` as a name only.

        `unassigned_as` names a bucket for rows carrying nobody. Without it those rows
        are dropped, which is right for "how many leads has a physio" but wrong for a
        group whose total is meant to match a branch card: Pre Sales read 0 against a
        card of 2230 purely because none of those leads had ever been assigned to an
        agent. Dropped rows make that look like no data; a named bucket makes it look
        like what it is."""
        counts: dict = {}
        labels: dict = {}
        for r in roster:
            counts[r["key"]] = 0
            labels[r["key"]] = r["name"]
        total = 0
        for row in rows:
            k = key_of(row)
            if k:
                nm = name_of(row) or "Unknown"
            elif unassigned_as:
                k, nm = "__unassigned__", unassigned_as
            else:
                continue
            total += 1
            counts[k] = counts.get(k, 0) + 1
            labels.setdefault(k, nm)
        members = [
            {"key": k, "name": labels.get(k) or "Unknown", "count": counts[k]}
            for k in counts
        ]
        # Busiest first; the zeros settle at the bottom in name order.
        members.sort(key=lambda m: (-m["count"], m["name"].lower()))
        return {"total": total, "members": members}

    pre_sales_roster = [
        {"key": u["id"], "name": u.get("full_name") or "Unknown"} for u in users if u.get("role") == "pre_sales"
    ]
    # Keyed by name, to match what appointments store.
    booker_roster = [
        {"key": u.get("full_name") or "", "name": f"{u.get('full_name') or 'Unknown'} · {ROLE_LABELS.get(u.get('role'), u.get('role') or '')}".strip(" ·")}
        for u in users if u.get("role") == "branch_admin" and u.get("full_name")
    ]
    head_physio_roster = [
        {"key": d["id"], "name": d.get("full_name") or "Unknown"} for d in doctors if d.get("profile_type") == "head_physio"
    ]
    physio_roster = [
        {"key": d["id"], "name": d.get("full_name") or "Unknown"} for d in doctors if d.get("profile_type") == "physio"
    ]

    return {
        "branch_id": branch_id,
        "branch_name": branch.get("branch_name", ""),
        "applied_filters": {"start_date": start_date, "end_date": end_date},
        "groups": [
            {
                "key": "pre_sales",
                "label": "Pre Sales (Total Leads)",
                # Labelled "Total Leads", so its total has to be the branch's lead count
                # off the Dashboard card — including the ones no agent ever owned.
                **build(
                    pre_sales_roster, lead_rows,
                    lambda r: r.get("assigned_user_id"), lambda r: r.get("assigned_user_name"),
                    unassigned_as="No agent assigned",
                ),
            },
            {
                "key": "branch_appointment",
                "label": "Branch Appointment",
                **build(booker_roster, appt_rows, lambda r: r.get("created_by"), lambda r: r.get("created_by")),
            },
            {
                "key": "head_physio",
                "label": "CONSULTANT",
                **build(head_physio_roster, appt_rows, lambda r: r.get("doctor_id"), lambda r: r.get("doctor_name")),
            },
            {
                "key": "physio",
                "label": "Physio",
                **build(physio_roster, lead_rows, lambda r: r.get("assigned_physio_id"), lambda r: r.get("assigned_physio_name")),
            },
        ],
    }


# ---------------------------------------------------------------- Dashboard > Leads tab

# What "converted" means here, and why each line is drawn where it is. Every one of these
# is a judgement about the branch's funnel, not a fact the data states, so they are named
# once and read from here rather than being re-decided inside the loop.
#
#   Enquiries    every lead. The top of the funnel and the denominator for the rest.
#   Slot Fixed   an appointment date exists. A slot was actually fixed for them.
#   Consultation the Consultation Fee was collected — the consultation HAPPENED. Booked is
#                already counted by Slot Fixed, so counting booked here would print the
#                same number twice and hide every no-show.
#   Converted    they bought something beyond the consultation: a treatment package, or a
#                diet plan. That is the moment a lead becomes a customer of a service.


def _is_converted(lead: dict) -> bool:
    return (
        lead.get("treatment_fee_paid") is not None
        or bool(lead.get("session_package_id"))
        or lead.get("diet_fee_paid") is not None
        # A chart bought and taken home is a service sold, the same as a plan booked. Left
        # out, a patient whose only purchase was a Diet Chart would sit in the funnel as an
        # unconverted lead forever, having paid.
        or lead.get("diet_chart_fee_paid") is not None
    )


def _due_today(lead: dict, today: str) -> bool:
    return (
        str(lead.get("next_follow_up_at") or "").startswith(today)
        or str(lead.get("next_consultation_follow_up_at") or "").startswith(today)
    )


def _payment_due_today(lead: dict, today: str) -> bool:
    return any(
        not i.get("paid") and str(i.get("due_date") or "") == today
        for i in ((lead.get("treatment_fee_payment_details") or {}).get("installments") or [])
    )


# One predicate per metric, and the ONLY definition of each. The card's figure and the list
# of people behind it are both built from this, so a card can never show a number the drill
# -down then fails to account for — the commonest way a dashboard loses trust.
#
# `ranged` says whether the metric answers to the date filter. The two daily ones do not:
# a follow-up due today on a lead from March is still due today, so they read every lead
# and filter on the day instead.
METRIC_DEFS = {
    "day_follow_up_calls": {
        "label": "Day Follow Up Calls", "sub": "People due a follow-up call today",
        "ranged": False, "match": lambda l, today: _due_today(l, today),
    },
    "day_follow_up_payment": {
        "label": "Day Follow Up Payment", "sub": "Installments falling due today",
        "ranged": False, "match": lambda l, today: _payment_due_today(l, today),
        # A count says how many calls to make; the amount says how much is riding on them.
        # Carried on the card itself rather than as a separate tile, so the two figures
        # can never be read as describing different sets of people.
        "amount": lambda l, today: sum(
            float(i.get("amount") or 0)
            for i in ((l.get("treatment_fee_payment_details") or {}).get("installments") or [])
            if not i.get("paid") and str(i.get("due_date") or "") == today
        ),
    },
    "enquiries": {
        "label": "Number Of Enquiries", "sub": "Every lead that came in",
        "ranged": True, "match": lambda l, today: True,
    },
    "consultations": {
        "label": "Number Of Consultation", "sub": "Consultation Fee collected",
        "ranged": True, "match": lambda l, today: l.get("package_paid") is not None,
    },
    "converted": {
        "label": "Number Of Converted", "sub": "Took treatment or a diet plan",
        "ranged": True, "match": lambda l, today: _is_converted(l),
    },
    "assigned_follow_up": {
        "label": "Assign To Follow Up Person", "sub": "Leads with an owner",
        "ranged": True, "match": lambda l, today: bool(l.get("assigned_user_id")),
    },
    "slot_fixed": {
        "label": "Slot Fixed", "sub": "Appointment date fixed",
        "ranged": True, "match": lambda l, today: bool(l.get("appointment_date")),
    },
}
METRIC_ORDER = list(METRIC_DEFS.keys())




async def _physio_branches() -> list:
    rows = await v3_col("branches").find(live_branch_query(), {"_id": 0}).to_list(200)
    return [b for b in rows if b.get("vertical") == "offline_physiotherapy"]


def _named_branch_counts(by_branch_id: dict, branch_names: dict) -> dict:
    """Per-branch-id counts, re-keyed by branch name and SUMMED where names meet.

    Written as a dict comprehension this silently lost leads. Several ids land on one
    name -- every lead whose branch has since been deleted resolves to "Unassigned", and
    so does every lead never given a branch -- and a comprehension keeps only whichever
    of them Python happened to write last. "Leads by branch" then failed to add up to the
    total printed above it, which is exactly the sort of disagreement this board is read
    to catch.
    """
    counts: dict = {}
    for bid, value in by_branch_id.items():
        name = branch_names.get(bid, "Unassigned") if bid else "Unassigned"
        counts[name] = counts.get(name, 0) + value
    return counts


def _lead_source(lead: dict) -> str:
    return lead.get("source_tab") or lead.get("source_type") or "unknown"


@router.get("/dashboard/lead-metrics")
async def dashboard_lead_metrics(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin")),
):
    """The Pre Sales tab: one card per metric, each carrying its branch split.

    Two of the seven are daily by name and stay daily whatever the date filter says — a
    "Day Follow Up Calls" figure for a three-month range is not a thing anyone asked for.
    Each card states its own period so the difference is on screen, not in someone's head.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    branches = await _physio_branches()
    branch_ids = {b["id"] for b in branches}

    ranged = await v3_col("leads").find(
        without_past_moves(_utc_stamp_range_query("created_at", start_date, end_date)), {"_id": 0}
    ).to_list(50000)
    everyone = await v3_col("leads").find(without_past_moves(), {"_id": 0}).to_list(50000)

    cards = []
    for key in METRIC_ORDER:
        d = METRIC_DEFS[key]
        pool = ranged if d["ranged"] else everyone
        counts = {bid: 0 for bid in branch_ids}
        amount = 0.0
        for l in pool:
            bid = l.get("branch_id")
            if bid in counts and d["match"](l, today):
                counts[bid] += 1
                if d.get("amount"):
                    amount += d["amount"](l, today)
        cards.append({
            "key": key,
            "label": d["label"],
            "sub": d["sub"],
            "period": "range" if d["ranged"] else "today",
            "total": sum(counts.values()),
            # Only the metrics that carry money have one, so a card with nothing to say
            # about rupees says nothing rather than printing Rs.0.
            "amount": round(amount, 2) if d.get("amount") else None,
            "branches": [
                {"branch_id": b["id"], "branch_name": b.get("branch_name", ""), "value": counts[b["id"]]}
                for b in branches
            ],
        })

    return {
        "applied_filters": {"start_date": start_date, "end_date": end_date},
        "today": today,
        "branches": [{"branch_id": b["id"], "branch_name": b.get("branch_name", "")} for b in branches],
        "cards": cards,
    }


@router.get("/dashboard/lead-metric-detail")
async def dashboard_lead_metric_detail(
    metric: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[str] = None,
    source: Optional[str] = None,
    stage: Optional[str] = None,
    limit: int = 500,
    _: V3UserOut = Depends(v3_require_roles("super_admin", "branch_admin")),
):
    """The people behind one card.

    Built from the same METRIC_DEFS predicate the card counted with, so the drill-down can
    never fail to account for the figure that opened it.

    Its own filters narrow further and are reported separately: `total` is what the card
    said, `filtered` is what is left after the popup's own branch/source/stage narrowing.
    Collapsing the two into one number is how a filtered list starts looking like the whole
    truth about the metric.
    """
    d = METRIC_DEFS.get(metric)
    if not d:
        raise HTTPException(status_code=404, detail=f"Unknown metric '{metric}'")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    branches = await _physio_branches()
    branch_ids = {b["id"] for b in branches}
    branch_names = {b["id"]: b.get("branch_name", "") for b in branches}

    query = without_past_moves(_utc_stamp_range_query("created_at", start_date, end_date) if d["ranged"] else {})
    pool = await v3_col("leads").find(query, {"_id": 0}).to_list(50000)

    matched = [l for l in pool if l.get("branch_id") in branch_ids and d["match"](l, today)]

    # Every branch, source and stage present in the metric BEFORE the popup's own filters —
    # a dropdown that only lists what survives the current filter is one you can never use
    # to widen the selection again.
    by_branch: dict = {}
    by_source: dict = {}
    by_stage: dict = {}
    for l in matched:
        by_branch[l["branch_id"]] = by_branch.get(l["branch_id"], 0) + 1
        by_source[_lead_source(l)] = by_source.get(_lead_source(l), 0) + 1
        st = l.get("branch_stage") or l.get("stage") or "—"
        by_stage[st] = by_stage.get(st, 0) + 1

    rows = matched
    if branch_id:
        rows = [l for l in rows if l.get("branch_id") == branch_id]
    if source:
        rows = [l for l in rows if _lead_source(l) == source]
    if stage:
        rows = [l for l in rows if (l.get("branch_stage") or l.get("stage") or "—") == stage]

    rows.sort(key=lambda l: str(l.get("created_at") or ""), reverse=True)

    return {
        "metric": metric,
        "label": d["label"],
        "sub": d["sub"],
        "period": "range" if d["ranged"] else "today",
        "total": len(matched),
        "filtered": len(rows),
        "branches": [
            {"branch_id": b["id"], "branch_name": branch_names[b["id"]], "value": by_branch.get(b["id"], 0)}
            for b in branches
        ],
        "sources": sorted(
            ({"name": k, "value": v} for k, v in by_source.items()),
            key=lambda r: -r["value"],
        ),
        "stages": sorted(
            ({"name": k, "value": v} for k, v in by_stage.items()),
            key=lambda r: -r["value"],
        ),
        "leads": [
            {
                "id": l.get("id"),
                "name": l.get("name", "Unknown"),
                "phone": l.get("phone", ""),
                "branch_name": branch_names.get(l.get("branch_id"), ""),
                "source": _lead_source(l),
                "stage": l.get("branch_stage") or l.get("stage") or "—",
                "created_at": l.get("created_at"),
                "assigned_user_name": l.get("assigned_user_name"),
            }
            for l in rows[:limit]
        ],
    }

# --------------------------------------------------------------- Clients: the two flags a
# --------------------------------------------------------------- lead can carry

# What the two lists are, and the field behind each. Both are marks somebody put on a lead
# by hand -- a star for the ones to treat especially well, a flag for the ones something is
# wrong with -- and neither is derived from a stage. That is the point of them: a lead can
# be sitting in a perfectly ordinary stage and still be either.
CLIENT_FLAGS = {
    "premium": "is_vip",
    "attention": "needs_attention",
}


@router.get("/dashboard/clients")
async def dashboard_clients(
    branch_id: Optional[str] = Query(None),
    # business_dev beside the other two, for the same reason leads-trend names it: this
    # desk mounts Super Admin's Dashboard > Clients tab, which is this call and nothing
    # else. Read-only -- the marks themselves are put on from a lead, not from here.
    user: V3UserOut = Depends(v3_require_roles("super_admin", "marketing_head", "business_dev")),
):
    """The starred and the flagged, with what it takes to act on either.

    One request for both lists rather than one each: they are read side by side, their
    counts sit on cards above them, and two requests would let the numbers arrive a moment
    apart from the rows they count.

    Only the fields the table shows are asked for. A lead document carries a hundred of
    them, and pulling the whole thing across for seven columns is a cost paid on every row
    of both lists.
    """
    query: dict = {"$or": [{"is_vip": True}, {"needs_attention": True}]}
    if branch_id:
        query["branch_id"] = branch_id

    rows = await v3_col("leads").find(query, {
        "_id": 0, "id": 1, "name": 1, "phone": 1, "email": 1, "branch_id": 1,
        "stage": 1, "branch_stage": 1, "consultation_stage": 1,
        "assigned_physio_name": 1, "appointment_date": 1, "appointment_time": 1,
        "is_vip": 1, "needs_attention": 1, "updated_at": 1, "created_at": 1,
    }).sort("updated_at", -1).to_list(4000)

    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    names = {b["id"]: b.get("branch_name", "") for b in branches}

    def shape(lead: dict) -> dict:
        return {
            "id": lead.get("id"),
            "name": lead.get("name") or "",
            "phone": lead.get("phone") or "",
            "email": lead.get("email") or "",
            # The furthest stage this lead has reached. A patient in treatment is past the
            # sales pipeline, and printing where they entered it says nothing about them now.
            "stage": lead.get("consultation_stage") or lead.get("branch_stage") or lead.get("stage") or "",
            "assigned_physio_name": lead.get("assigned_physio_name") or "",
            "appointment_date": lead.get("appointment_date") or "",
            "appointment_time": lead.get("appointment_time") or "",
            "branch_name": names.get(lead.get("branch_id"), ""),
            # The id beside the name, for a caller that filters these rows by branch
            # rather than re-asking with ?branch_id -- the Business Development desk
            # scopes this tab from the branch popover on its Dashboard toolbar, and both
            # lists arrive here in one request it would otherwise have to repeat.
            "branch_id": lead.get("branch_id") or "",
            "updated_at": lead.get("updated_at") or lead.get("created_at") or "",
        }

    # A lead can carry both marks at once, and belongs on both lists when it does: a VIP
    # something is wrong with is exactly the row somebody wants to find under either.
    return {
        "premium": [shape(l) for l in rows if l.get("is_vip")],
        "attention": [shape(l) for l in rows if l.get("needs_attention")],
    }


# How a row's "Last Lead" is judged to have gone quiet. Seven days because every one of
# this estate's live sheets carries leads most weeks -- the smallest of them is running
# about one a day -- so a week of silence on a sheet that was arriving daily is a broken
# sync far more often than it is a dead channel. It is a hint and nothing else: the row
# still reads normally, the figure just gets a mark beside it.
MARKETING_QUIET_DAYS = 7

# What the Group by control offers, and what each one keys a row on. Both the Marketing
# and the Sales tab of the Business Development Dashboard read this endpoint; they differ
# only in which three of these five they offer.
#
#   source         -- one row per sheet or form, wherever its leads landed. Marketing's
#                     default: that is the marketing question, and a sheet is a thing
#                     somebody set up and can go and fix.
#   stage          -- one row per pre-sales stage. Sales' default: the funnel, as a table.
#   branch         -- one row per branch, whatever fed it. Either tab read from the other
#                     end, for "which place is actually converting".
#   source_branch  -- one row per pairing. The only one that can answer what a shared form
#                     did for one branch -- this estate's two biggest sources are
#                     all-branch forms, so under "source" alone their leads sit in two rows
#                     that name no branch at all.
#   stage_branch   -- the same pairing for the funnel: where each branch's leads are stuck.
BREAKDOWN_GROUPINGS = {"source", "stage", "branch", "source_branch", "stage_branch"}

# Which field a grouping's PRIMARY dimension reads, or None where the primary dimension is
# the branch itself. The secondary is always the branch, and only on the two pairings.
BREAKDOWN_DIMENSION = {
    "source": "source",
    "source_branch": "source",
    "stage": "stage",
    "stage_branch": "stage",
    "branch": None,
}


@router.get("/dashboard/marketing-sources")
async def v3_marketing_sources(
    group_by: str = Query("source", description="One of BREAKDOWN_GROUPINGS"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    branch_ids: Optional[str] = Query(None, description="Comma-separated; omit for every branch"),
    _: V3UserOut = Depends(v3_require_roles("super_admin", "sales_head", "marketing_head", "business_dev")),
):
    """Every lead source -- or stage, or branch -- in the window, as rows: leads, booked,
    conversion, and when each last carried anything.

    The same leads /dashboard/leads-analytics counts, over the same window, on the same
    clinic clock -- and `booked` is that endpoint's own definition (the lead has an
    appointment_date), so the total this returns is the Booked card's number and cannot
    drift from it.

    What this is NOT is `by_source`/`by_stage` from that endpoint. Those are ranked and
    capped at six plus an "Other" bucket, because they feed pie charts and a part-to-whole
    read stops working past about six slices. On this install that cap folds nine real
    sheets into one 653-lead row called "Other", which is fine for a chart and useless for
    a table: the desk reading this wants the sheet's name so it can go and look at the
    sheet. So every row is returned, named, however many there are.

    One row shape for all five groupings, and `label`/`sub_label` carry whatever the
    grouping put in them, so one table component draws all five rather than five components
    drifting apart. `source`, `stage` and `branch_id` are filled in only where the row names
    exactly one of each -- they are what the drill-down filters by, and a row spanning nine
    sheets must not be drilled as if it named one.

    No aggregation pipeline: one indexed range scan with a six-field projection, counted in
    Python, which is what the analytics endpoint beside it already does over the same rows.
    Grouping in Mongo would mean five pipelines to keep in step with each other and with
    that endpoint, to save an arithmetic pass over at most a few tens of thousands of small
    dicts.
    """
    if group_by not in BREAKDOWN_GROUPINGS:
        raise HTTPException(status_code=400, detail=f"Unknown grouping: {group_by}")

    dimension = BREAKDOWN_DIMENSION[group_by]
    pairs_branch = group_by.endswith("_branch")

    query: dict = without_past_moves(_utc_stamp_range_query("created_at", start_date, end_date))
    wanted_branches = [b for b in (branch_ids or "").split(",") if b.strip()]
    if wanted_branches:
        query["branch_id"] = {"$in": wanted_branches}
    leads = await v3_col("leads").find(
        query,
        {"_id": 0, "created_at": 1, "branch_id": 1, "source_tab": 1, "source_type": 1,
         "stage": 1, "appointment_date": 1},
    ).to_list(50000)

    branch_rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    branch_names = {b["id"]: b.get("branch_name") or "-" for b in branch_rows}

    rows: dict = {}
    for lead in leads:
        source = _lead_source(lead)
        stage = (lead.get("stage") or "").strip() or "No stage"
        bid = lead.get("branch_id") or ""
        primary = source if dimension == "source" else stage if dimension == "stage" else bid
        key = f"{primary}||{bid}" if pairs_branch else primary

        row = rows.get(key)
        if row is None:
            row = rows[key] = {
                "key": key,
                # What the row names, and what it names underneath. Filled here for every
                # grouping but "branch", whose two labels are only knowable once all its
                # leads have been seen -- see the finishing pass below.
                "label": branch_names.get(bid, "Unassigned") if dimension is None else primary,
                "sub_label": None,
                "source": source,
                "source_type": (lead.get("source_type") or "").strip() or None,
                "stage": stage,
                # The sentinel, not None, where the row IS the no-branch bucket: None is
                # reserved below for a row that spans several branches and must not be
                # filtered to one. The two are opposite instructions to the drill-down.
                "branch_id": bid or UNASSIGNED_BRANCH,
                "branch_name": branch_names.get(bid, "Unassigned") if bid else "Unassigned",
                "leads": 0,
                "booked": 0,
                "first_lead_at": None,
                "last_lead_at": None,
                # The sets behind the "how many of the other thing" counts below. Dropped
                # from the response before it goes out -- the count is the fact, and a row
                # for an all-branch form would otherwise carry every branch id.
                "_branches": set(),
                "_sources": set(),
                "_stages": set(),
            }

        row["leads"] += 1
        if str(lead.get("appointment_date") or "").strip():
            row["booked"] += 1
        row["_branches"].add(bid)
        row["_sources"].add(source)
        row["_stages"].add(stage)

        created = lead.get("created_at") or ""
        if created:
            if not row["first_lead_at"] or created < row["first_lead_at"]:
                row["first_lead_at"] = created
            if not row["last_lead_at"] or created > row["last_lead_at"]:
                row["last_lead_at"] = created

    today = clinic_day_of(datetime.now(timezone.utc).isoformat())
    out = []
    for row in rows.values():
        branches_seen = row.pop("_branches")
        sources_seen = row.pop("_sources")
        stages_seen = row.pop("_stages")
        row["branch_count"] = len(branches_seen)
        row["source_count"] = len(sources_seen)
        row["stage_count"] = len(stages_seen)

        # What sits under the row's name, and which of the three filters the drill-down may
        # actually use. A row spanning several of something has no single one to name, and
        # naming whichever it happened to meet first would be a lie the reader cannot see --
        # so it is said as a count, and the filter for it is cleared.
        if dimension is None:
            # Grouped by branch: the row is one branch, fed by however many sheets.
            row["sub_label"] = (
                next(iter(sources_seen)) if row["source_count"] == 1
                else f"{row['source_count']} sources"
            )
            if row["source_count"] > 1:
                row["source"] = None
                row["source_type"] = None
            if row["stage_count"] > 1:
                row["stage"] = None
        elif pairs_branch:
            # One row per pairing: both dimensions name exactly one thing by construction,
            # so both filters stand and the branch is what goes underneath.
            row["sub_label"] = row["branch_name"]
            if dimension == "source" and row["stage_count"] > 1:
                row["stage"] = None
            if dimension == "stage" and row["source_count"] > 1:
                row["source"] = None
        else:
            # Grouped by source or by stage, across whatever branches those leads landed in.
            if row["branch_count"] > 1:
                row["sub_label"] = f"All branches ({row['branch_count']})"
                row["branch_name"] = row["sub_label"]
                row["branch_id"] = None
            else:
                row["sub_label"] = row["branch_name"]
            if dimension == "source" and row["stage_count"] > 1:
                row["stage"] = None
            if dimension == "stage" and row["source_count"] > 1:
                row["source"] = None
                row["source_type"] = None

        # Rate is returned rather than left to the caller so every screen reading this
        # rounds it the same way, and so a zero-lead row (which cannot occur here, but the
        # shape has to be total) is never a division.
        row["conversion_rate"] = round(row["booked"] / row["leads"] * 100, 1) if row["leads"] else 0.0

        # Days since the last lead, on the clinic's clock -- not a timestamp difference.
        # "Yesterday" is a day old at one minute past midnight and at eleven at night, and
        # the desk asking whether a source has stopped is counting days, not hours.
        last_day = clinic_day_of(row["last_lead_at"])
        try:
            quiet = (date.fromisoformat(today) - date.fromisoformat(last_day)).days
        except (ValueError, TypeError):
            quiet = None
        row["quiet_days"] = quiet
        row["is_quiet"] = quiet is not None and quiet >= MARKETING_QUIET_DAYS
        out.append(row)

    out.sort(key=lambda r: -r["leads"])
    booked_total = sum(r["booked"] for r in out)
    return {
        "applied_filters": {"start_date": start_date, "end_date": end_date, "branch_ids": wanted_branches},
        "group_by": group_by,
        "rows": out,
        # The total row, summed off the same rows it is drawn beside rather than counted
        # again -- a total that can disagree with the column under it is worse than none.
        "totals": {
            "leads": len(leads),
            "booked": booked_total,
            "conversion_rate": round(booked_total / len(leads) * 100, 1) if leads else 0.0,
            "rows": len(out),
        },
    }
