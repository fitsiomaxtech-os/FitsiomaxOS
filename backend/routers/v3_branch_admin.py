from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import Dict, Optional
from datetime import date, datetime, timedelta, timezone
from calendar import monthrange
import logging
import uuid

from database import v3_col
from branch_calendar import is_leave
from utils import PAST_MOVE_FIELD, now_iso, active_doctor_query, without_past_moves
from deps import (
    v3_require_roles, v3_current_user, is_head_physio_role, consultants_serving_branch,
    online_arm_practice, vertical_in_arm, lead_as_read_by, is_branch_admin_role,
    works_org_wide,
)
import lead_control
import lead_purge
import store_branch_overrides
from constants import (
    V3_BRANCH_STAGES, V3_CONSULTATION_STAGES, V3_HEAD_CONSULTATION_STAGES,
    BRANCH_CANCELLED_STAGE, BRANCH_APPOINTMENT_STAGE, SALES_ARM_OFFLINE,
    SALES_STAGE_ROLE_APPOINTMENT, SALES_STAGE_ROLE_CANCELLED, SALES_STAGE_ROLE_FALLBACKS,
    SALES_STAGE_ROLE_NOT_A_PROSPECT,
)
from stage_utils import (
    branch_stage_names_for_branch, first_branch_stage_for_branch, get_first_stage_name,
    sales_arm_for,
)
from schemas.v3 import (
    V3UserOut, V3LeadOut,
    V3BranchStageInput, V3CollectFeeInput, V3AssignPhysioInput, V3ConsultationStageInput,
    V3PortfolioScheduleInput,
)
from routers.v3_lead_documents import leads_with_prescription
# Whose Head Physio review is still owed. Imported rather than re-derived: the rule for
# when a course is over lives with the reviews it is waiting on, and a second copy here
# is how the boards came to disagree about Completed in the first place.
from routers.v3_reviews import leads_awaiting_review, review_bookings, consultant_slot_clash
# What this patient has actually paid, and to which branch. Imported rather than re-derived
# for the same reason as the two above: parsing an amount out of an activity row and
# deciding which branch owns it are finance's rules, and a second copy here is how the
# transfer dialog and the finance board would come to disagree about what a patient paid.
from routers.v3_finance import lead_payment_history

router = APIRouter(prefix="/api/v3")

# The call-back delays offered when a lead is moved to Not a prospect, in days. The same
# four the lead card's dropdown lists; anything else is refused.
NOT_PROSPECT_REMINDER_DAYS = {15: "After 15 Days", 20: "After 20 Days", 30: "After 1 Month", 90: "After 3 Months"}


async def _branch_stage_names(branch_id: Optional[str] = None) -> list:
    """Live Branch Stages as configured in Super Admin > Pipeline Stage Management,
    falling back to the built-in defaults if none have been configured yet.

    Scoped to one branch when given: the opening stages differ by Lead Control, so a branch
    running its own leads gets Branch Assign + RNR where a Pre-Sales-fed one gets New
    Appointment. Passing no branch returns every mode's stages, which is what callers
    validating across the whole org (rather than against one board) want.
    """
    if branch_id:
        return await branch_stage_names_for_branch(branch_id, V3_BRANCH_STAGES)
    rows = await v3_col("pipeline_stages").find(
        {"type": "sales"}, {"_id": 0, "name": 1}
    ).sort("order", 1).to_list(400)
    # Both arms, deduped: with no branch to scope by, this is the "is that a real Branch
    # stage at all" question, and the two arms' lists overlap wherever neither has been
    # renamed.
    names = list(dict.fromkeys(r["name"] for r in rows))
    return names or V3_BRANCH_STAGES


async def _sales_stage_for_role(role: str, arm: str = SALES_ARM_OFFLINE) -> str:
    """The current name of the Branch stage carrying `role`, on one arm.

    The stage a behaviour belongs to is identified by its role, not by what it is called,
    so Super Admin can rename it in CI/CD ROOTS without the behaviour coming off it. Falls
    back to the name the role shipped under, for a database whose stages predate the
    stamping pass (seed.ensure_sales_stage_roles) or where the stage has been deleted.

    Scoped to an arm because the two Branch pipelines each carry their own stage for every
    role: unscoped, an online booking would land on whatever the offline arm calls its
    appointment stage.
    """
    row = await v3_col("pipeline_stages").find_one(
        {"type": "sales", "role": role,
         "$or": [{"arm": arm}, {"arm": {"$exists": False}}, {"arm": None}]},
        {"_id": 0, "name": 1},
    )
    return row["name"] if row else SALES_STAGE_ROLE_FALLBACKS[role]


async def _branch_stages(branch_id: Optional[str], arm: str = SALES_ARM_OFFLINE) -> list:
    """Full stage documents for one board — the client needs colours and order, not just
    names, and must not be handed the other Lead Control mode's or the other arm's stages.

    Two axes now: `applies_to` says which Lead Control mode a stage belongs to, `arm` says
    which practice. An online arm board handed the offline list would draw pills its own
    leads never stand on.
    """
    control = await lead_control.branch_lead_control(branch_id)
    rows = await v3_col("pipeline_stages").find({"type": "sales"}, {"_id": 0}).sort("order", 1).to_list(400)
    stages = [
        r for r in rows
        if (not r.get("applies_to") or r.get("applies_to") == control)
        and (not r.get("arm") or r.get("arm") == arm)
    ]
    if control == lead_control.BRANCH_ADMIN:
        # Read before inserting: the branch's own opening is whatever sits first here, and
        # the mirror needs its name to know which leads it has stopped applying to.
        entry = stages[0]["name"] if stages else V3_BRANCH_STAGES[0]
        stages.insert(0, await _presales_mirror_stage(entry))
    return stages


async def _presales_mirror_stage(entry_stage_name: str) -> dict:
    """The "Leads" pill: the branch's own Pre-Sales New Leads, shown on Branch Leads.

    A branch running its own leads works them on its embedded Pre-Sales board first, so the
    raw arrivals were only visible on that tab. This surfaces them on Branch Leads too,
    where the rest of the journey already lives.

    Deliberately not a pipeline_stages row. It reads the lead's Pre-Sales `stage` rather
    than its `branch_stage`, so a lead appears here without anything being written to it —
    the point being visibility, not a change of ownership. `mirrors_stage` is the client's
    signal to count and filter it against that other field, and because no such stage
    exists in the collection, /branch-stage rejects any attempt to move a lead onto it.

    It stops applying the moment the branch works the lead: `unmoved_branch_stage` is the
    match, so a lead is shown under Leads only while it is still sitting at the branch's
    own opening, and moving it anywhere takes it out of this pill and into that stage.

    That opening no longer draws a pill of its own — Branch Leads shows four, Leads / RNR /
    Follow Up / Appointment, and this one is the first of them. So the match is on
    `unmoved_branch_stage` alone; it used to also require the lead to be an unworked
    Pre-Sales New Lead (`mirrors_stage`), which is where the pill's name comes from, and
    that half had to go when the pill became the whole of the opening rather than a second
    reading of it. A branch switched off Pre-Sales control has leads rehomed onto Branch
    Assign still carrying whatever Pre-Sales stage they had reached, and the narrow match
    left every one of them in no pill at all. `mirrors_stage` is still sent: it is what
    tells the client this pill is a view rather than a move target.
    """
    return {
        "id": "presales-new-leads",
        "name": "Leads",
        "color": "#6366f1",
        "type": "sales",
        # Ahead of the real entry stage: it is the earlier step of the same journey.
        "order": -1,
        "is_final": False,
        "applies_to": lead_control.BRANCH_ADMIN,
        # Resolved live — Super Admin can rename the Pre-Sales entry stage.
        "mirrors_stage": await get_first_stage_name("pre_sales", "New Leads"),
        "unmoved_branch_stage": entry_stage_name,
    }


async def _consultation_stage_names() -> list:
    """Live Consultation Stages as configured in Super Admin > Pipeline Stage Management,
    falling back to the built-in defaults if none have been configured yet."""
    rows = await v3_col("pipeline_stages").find({"type": "consultation"}, {"_id": 0, "name": 1}).sort("order", 1).to_list(200)
    names = [r["name"] for r in rows]
    return names or V3_CONSULTATION_STAGES


async def _head_consultation_stage_names() -> list:
    """Live Head Consultation Stages as configured in Super Admin > Pipeline Stage Management,
    falling back to the built-in defaults if none have been configured yet."""
    rows = await v3_col("pipeline_stages").find({"type": "head_consultation"}, {"_id": 0, "name": 1}).sort("order", 1).to_list(200)
    names = [r["name"] for r in rows]
    return names or V3_HEAD_CONSULTATION_STAGES


# ---------------------------------------------- Public appointment confirmation page

LOGO_URL = ("https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707"
            "/artifacts/nozl77ti_Logo%20Icon.webp")


def _esc(s) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def _to12h(t: str) -> str:
    """'14:05' -> '2:05 PM'. Left as-is if it isn't a real HH:MM."""
    try:
        h, m = (t or "").split(":")[:2]
        h, m = int(h), int(m)
    except (ValueError, TypeError):
        return t or "—"
    suffix = "AM" if h < 12 else "PM"
    hour = h % 12 or 12
    return f"{hour}:{m:02d} {suffix}"


def _end12h(t: str, minutes: int) -> str:
    try:
        h, m = (t or "").split(":")[:2]
        total = int(h) * 60 + int(m) + int(minutes or 0)
    except (ValueError, TypeError):
        return "—"
    return _to12h(f"{(total // 60) % 24:02d}:{total % 60:02d}")


def _weekday_label(d: str) -> str:
    """"Friday, July 17, 2026" — the same wording the card image uses, so the page the
    link opens reads as the note the patient was already sent."""
    try:
        dt = date.fromisoformat(d)
    except (ValueError, TypeError):
        return d or "—"
    # Built by hand rather than with %-d/%#d, neither of which is portable across the
    # dev (Windows) and deploy (Linux) platforms.
    return f"{dt.strftime('%A, %B')} {dt.day}, {dt.year}"


_PAGE_CSS = """
*{box-sizing:border-box}
body{margin:0;padding:24px 12px;background:#f1f5f9;color:#0f172a;
     font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif}
.wrap{max-width:480px;margin:0 auto}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.10)}
.head{display:flex;align-items:center;gap:12px;padding:16px 20px;background:#0d9488;color:#fff}
.head.cancelled{background:#e11d48}
.logo{width:44px;height:44px;flex:none;border-radius:10px;background:rgba(255,255,255,.9);object-fit:contain;padding:4px}
.h-title{font-size:18px;font-weight:700}
.h-ref{font-size:12px;opacity:.85;margin-top:2px}
.body{padding:20px}
.hero{border:2px solid #99f6e4;background:#f0fdfa;border-radius:12px;padding:18px;text-align:center}
.hero.cancelled{border-color:#fecdd3;background:#fff1f2}
.hero-label{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#0d9488}
.hero.cancelled .hero-label{color:#e11d48}
.hero-date{font-size:24px;font-weight:800;color:#0f766e;margin-top:4px}
.hero-time{font-size:18px;font-weight:700;color:#0f766e}
.hero-with{font-size:14px;font-weight:600;color:#0d9488;margin-top:4px}
.hero.cancelled .hero-date,.hero.cancelled .hero-time,.hero.cancelled .hero-with{color:#be123c}
.banner{margin-top:14px;border:1px solid #fecdd3;background:#fff1f2;border-radius:8px;
        padding:10px 12px;font-size:12px;font-weight:600;color:#be123c}
.greet{margin-top:18px;font-size:17px;font-weight:700;color:#0f172a}
.say{margin-top:10px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:12px 14px}
.say p{margin:0;font-size:14px;line-height:1.7;color:#475569}
.sign{margin-top:8px;text-align:right;font-size:13px;font-weight:700;color:#0d9488}
.map{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:8px;background:#0d9488;
     color:#fff;font-size:13px;font-weight:600;text-decoration:none}
table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
td{padding:9px 0;border-bottom:1px solid #f1f5f9;vertical-align:top}
td.k{color:#64748b}
td.v{text-align:right;font-weight:600;color:#1e293b}
tr:last-child td{border-bottom:0}
.box{margin-top:14px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:12px}
.box-label{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#94a3b8}
.box p{margin:4px 0 0;font-size:13px;color:#475569;line-height:1.6;white-space:pre-wrap}
.note{margin-top:14px;border:1px solid #ccfbf1;background:rgba(240,253,250,.7);border-radius:8px;
      padding:12px;font-size:12px;line-height:1.7;color:#115e59}
.note p{margin:0}
.foot{margin-top:16px;text-align:center;font-size:12px;color:#94a3b8}
@media print{body{background:#fff;padding:0}.card{box-shadow:none}}
"""


def _appt_missing_html() -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Appointment not found — FITSIOMAX</title><style>{_PAGE_CSS}</style></head>
<body><div class="wrap"><div class="card">
<div class="head"><img class="logo" src="{LOGO_URL}" alt="FITSIOMAX"><div class="h-title">FITSIOMAX</div></div>
<div class="body"><p style="text-align:center;color:#64748b;font-size:14px;padding:24px 0">
This appointment link is not valid.<br>Please contact the branch for help.</p></div>
</div></div></body></html>"""


REASSURANCE = ("We understand the pain you are going through. Don't worry — our team is "
               "here to consult with you and see you through it.")


def _appt_card_html(a: dict) -> str:
    """The confirmation as a standalone page. Kept in step with the card image the branch
    sends (frontend/src/lib/apptCard.js) so the link opens to the same note the patient
    already has in their chat — a greeting, the day, the place, and the line telling them
    they are in hand, rather than a dump of every field on the record.

    The og:* tags are what WhatsApp, Signal and the rest read to draw their preview card
    above the message — without them a shared link is just a bare URL."""
    cancelled = bool(a["cancelled"])
    when = f"{_to12h(a['time'])} to {_end12h(a['time'], a['duration'])}"
    title = ("Appointment Cancelled" if cancelled else "Appointment Confirmed")
    og_desc = f"{_weekday_label(a['date'])} · {when}"
    if a["branch"]:
        og_desc += f" at {a['branch']}"

    # A house visit happens at the patient's home, so the branch's address and the
    # "arrive early" line would send them somewhere they are not expected.
    house_visit = bool(a.get("house_visit"))
    if house_visit:
        og_desc = f"{_weekday_label(a['date'])} · {when} · House Visit"

    rows = [("CONSULTANT", a["head_physio"])]
    if house_visit:
        rows.append(("Visit", "House Visit"))
        if a.get("package_name"):
            rows.append(("Package", a["package_name"]))
    if a["ref_no"]:
        rows.append(("Reference", a["ref_no"]))
    rows_html = "".join(
        f'<tr><td class="k">{_esc(k)}</td><td class="v">{_esc(v)}</td></tr>' for k, v in rows
    )

    # The map link is a plain anchor rather than an embed: an iframe would need a keyed
    # Maps API and would be blocked in the in-app browsers this page mostly opens in.
    map_html = ""
    if a["map_location"]:
        map_html = (f'<a class="map" href="{_esc(a["map_location"])}" target="_blank" '
                    f'rel="noopener noreferrer">Open in Maps</a>')

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(title)} — FITSIOMAX</title>
<meta name="theme-color" content="{'#e11d48' if cancelled else '#0d9488'}">
<meta name="description" content="{_esc(og_desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FITSIOMAX">
<meta property="og:title" content="{_esc(title)} — {_esc(a['patient'])}">
<meta property="og:description" content="{_esc(og_desc)}">
<meta property="og:image" content="{LOGO_URL}">
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex,nofollow">
<style>{_PAGE_CSS}</style></head>
<body><div class="wrap"><div class="card">
  <div class="head{' cancelled' if cancelled else ''}">
    <img class="logo" src="{LOGO_URL}" alt="FITSIOMAX">
    <div><div class="h-title">{_esc(title)}</div>
    <div class="h-ref">FITSIOMAX · Physiotherapy &amp; Rehabilitation</div></div>
  </div>
  <div class="body">
    <div class="hero{' cancelled' if cancelled else ''}">
      <div class="hero-label">Your Appointment</div>
      <div class="hero-date">{_esc(_weekday_label(a['date']))}</div>
      <div class="hero-time">{_esc(when)}</div>
      {'<div class="hero-with">House Visit — at your home</div>' if house_visit
       else f'<div class="hero-with">at {_esc(a["branch"])}</div>' if a["branch"] else ''}
    </div>
    <div class="greet">Hi {_esc(a['patient'])},</div>
    {'<div class="banner">This appointment has been cancelled. Please contact the branch to book another.</div>'
     if cancelled else
     f'<div class="say"><p>{_esc(REASSURANCE)}</p><div class="sign">— Team Fitsiomax</div></div>'}
    <table>{rows_html}</table>
    {f'<div class="box"><div class="box-label">Notes</div><p>{_esc(a["notes"])}</p></div>' if a["notes"] else ''}
    {f'<div class="box"><div class="box-label">Location</div><p>{_esc(a["branch_address"])}</p>{map_html}</div>'
     if (a["branch_address"] or map_html) and not house_visit else ''}
    {'' if cancelled else
     '<div class="note"><p>Our consultant will come to your home at this time.</p></div>' if house_visit else
     '<div class="note"><p>Please arrive 10 minutes early.</p></div>'}
  </div>
</div>
<p class="foot">FITSIOMAX · Physiotherapy &amp; Rehabilitation</p>
</div></body></html>"""


@router.get("/public/appointment/{share_token}", response_class=HTMLResponse)
async def v3_public_appointment(share_token: str):
    """The appointment confirmation behind its share link — what the patient opens.

    Server-rendered rather than a route in the SPA, for two reasons: WhatsApp and every
    other chat app fetch a shared link with a crawler that does not run JavaScript, so
    only real HTML gets the preview card; and the patient opening it on a phone gets the
    confirmation immediately instead of downloading an app bundle first.

    Deliberately unauthenticated: the patient has no login. The token is the only key, so
    it must stay unguessable (a CSPRNG value minted at booking), and only the fields
    already printed on the confirmation they were sent are rendered — holding a link
    reveals nothing further about the lead.
    """
    appt = await v3_col("appointments").find_one({"share_token": share_token}, {"_id": 0})
    if not appt:
        return HTMLResponse(_appt_missing_html(), status_code=404)

    lead = await v3_col("leads").find_one(
        {"id": appt.get("lead_id")}, {"_id": 0, "branch_id": 1}
    ) or {}
    branch = await v3_col("branches").find_one(
        {"id": appt.get("branch_id") or lead.get("branch_id")},
        {"_id": 0, "branch_name": 1, "address": 1, "map_location": 1},
    ) or {}

    return HTMLResponse(_appt_card_html({
        "ref_no": appt.get("ref_no") or "",
        "patient": appt.get("patient_name") or appt.get("lead_name") or "—",
        "date": appt.get("appointment_date") or "",
        "time": appt.get("appointment_time") or "",
        "duration": appt.get("duration") or 30,
        "head_physio": appt.get("doctor_name") or "—",
        "branch": branch.get("branch_name") or "",
        "branch_address": branch.get("address") or "",
        "map_location": branch.get("map_location") or "",
        "notes": appt.get("notes") or "",
        # A cancelled booking keeps its link working, but says so rather than showing a
        # confirmation for an appointment that is no longer happening.
        "cancelled": appt.get("status") == "cancelled",
        "house_visit": appt.get("visit_type") == "home",
        "package_name": appt.get("visit_package_name") or "",
    }))


async def _stamp_session_progress(leads: list) -> None:
    """Put each lead's treatment-day count on it: how many were booked, how many are done.

    Derived rather than stored. The days live in the sessions collection and are completed
    one at a time by whoever ran them, so a count kept on the lead would be a second copy
    of that to keep true — and the one that goes stale is the one the board reads.

    One aggregation for the whole branch rather than a query per lead: a branch with two
    thousand patients would otherwise open its board with two thousand round trips.

    Leads with no days booked are left without the fields entirely, which is not the same
    as zero: nobody has sold them treatment, so they are not partway through any.
    """
    ids = [lead["id"] for lead in leads if lead.get("id")]
    if not ids:
        return
    rows = await v3_col("sessions").aggregate([
        # lead_id is what a treatment day carries; an auth token in the same collection has
        # none, which is what this first stage keeps out.
        {"$match": {"lead_id": {"$in": ids}}},
        {"$group": {
            "_id": "$lead_id",
            "total": {"$sum": 1},
            "done": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
        }},
    ]).to_list(20000)
    progress = {r["_id"]: r for r in rows}
    # The last day of a course is not the end of it. Every course earns a closing Head
    # Physio review, and until that is written the patient is mid-hand-off rather than
    # discharged -- so the Completed stage, which is read off the two counts below, moved
    # them out of the pipeline while the Head Physio still had them on their desk. Stamped
    # beside the counts because it qualifies them: see isCourseComplete in leadStage.js,
    # the one rule every board reads this through.
    awaiting_review = await leads_awaiting_review(ids)
    for lead in leads:
        lead["review_pending"] = lead.get("id") in awaiting_review
        found = progress.get(lead.get("id"))
        if not found:
            continue
        lead["total_sessions"] = found["total"]
        lead["completed_sessions"] = found["done"]


async def _board_payload(leads: list, branch_id: Optional[str], role: str = "") -> dict:
    """The Branch Leads response, from a list of leads somebody else has already chosen.

    Split from the endpoint because there are two ways in now and they differ only in that
    choice: a branch's board asks for the leads at one branch, and an online arm's asks for
    the leads of one vertical, because an online arm is not a branch and its leads have
    none — see ONLINE_ARM_PRACTICE in deps.py. Everything after that is the same board and
    has to stay the same board, or the two would drift into disagreeing about what a stage
    count means.

    A None branch reads as Pre-Sales control throughout, which is what an arm wants and
    what branch_lead_control already returns for it: no branch of its own means nobody has
    said this desk runs its own leads.
    """
    await _stamp_session_progress(leads)
    stage_counts = {}
    # Resolved from the role first, then the branch: an online arm admin has no branch at
    # all, so asking the branch alone would hand every one of them the offline pipeline.
    arm = await sales_arm_for(branch_id=branch_id, role=role)
    branch_stages = await _branch_stages(branch_id, arm)
    for stage in branch_stages:
        # The Leads pill is the branch's opening: it counts everyone still sitting at
        # `unmoved_branch_stage` and lets go of them the moment the branch moves them on,
        # or a lead already dealt with would go on being counted here as well as in the
        # stage it was moved to. Every real branch stage counts on `branch_stage` too, so
        # the two differ only in which name they compare against.
        #
        # It also required `stage == mirrors_stage` — that the lead was an unworked
        # Pre-Sales New Lead, which is where the pill's name comes from. Dropped when the
        # branch's own entry stage stopped drawing a pill of its own and this one became
        # the whole of the opening; a branch switched off Pre-Sales control has leads
        # rehomed onto that stage carrying their old Pre-Sales stage, and they were being
        # counted under nothing at all.
        mirrors = stage.get("mirrors_stage")
        if mirrors:
            unmoved = stage.get("unmoved_branch_stage")
            matches = sum(1 for lead in leads if lead.get("branch_stage") == unmoved)
        else:
            matches = sum(1 for lead in leads if lead.get("branch_stage") == stage["name"])
        stage_counts[stage["name"]] = matches
    # One malformed lead document shouldn't 500 the whole board — skip it and keep
    # showing every other lead rather than failing the entire list.
    lead_list = []
    for lead in leads:
        try:
            # `role` decides whether the ad record rides along — see lead_as_read_by.
            lead_list.append(V3LeadOut(**lead_as_read_by(lead, role)))
        except Exception as e:
            logging.getLogger(__name__).error(f"branch-board: skipping unparseable lead {lead.get('id')}: {e}")
    # The board tells the client which desk owns this branch's leads, so the Pre Sales
    # tab appears and disappears on the same fetch as the leads it works on rather
    # than needing a second round trip to /branches to find out.
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "lead_control": 1}) if branch_id else None
    return {
        "leads": [lead.model_dump() for lead in lead_list],
        "stage_counts": stage_counts,
        "lead_control": lead_control.normalize((branch or {}).get("lead_control")),
        # Sent with the board rather than fetched separately from /stages, which has no
        # branch to scope by: the stage strip must match the Lead Control on the same
        # response, or a flipped branch briefly renders the other mode's stages.
        "stages": branch_stages,
        # The Danger Zone switch behind the Action column's bin icon. Rides along here
        # because the setting itself is readable only with the developer password, and
        # the board must not have to hold that to know whether to draw a button.
        "lead_delete_enabled": await lead_purge.delete_button_enabled(),
    }


@router.get("/branch-board/{branch_id}")
async def v3_branch_board_new(branch_id: str, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    try:
        leads = await v3_col("leads").find({"branch_id": branch_id}, {"_id": 0}).sort("updated_at", -1).to_list(20000)
        return await _board_payload(leads, branch_id, user.role)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("branch-board: failed to load")
        raise HTTPException(status_code=500, detail=f"branch-board error: {type(e).__name__}: {e}")


@router.get("/arm-board")
async def v3_arm_board(user: V3UserOut = Depends(v3_current_user)):
    """Branch Leads for an admin who runs an online arm rather than a branch.

    The arm is read off the caller's own role, not asked for in the URL. There are exactly
    two of these boards and each role runs exactly one of them, so a parameter would only
    be a way for the fitness admin to request the physio arm's patients.

    Scoped on the lead's `vertical`, which is what an online lead carries instead of a
    branch. Narrowed in the query on the "online" half and then decided properly in Python,
    because `vertical` is not a controlled field — this install already holds "Meta",
    "referral" and "whatsapp" in it — and a token test is the only honest reading of it.
    See vertical_in_arm in deps.py.
    """
    practice = online_arm_practice(user.role)
    if not practice:
        raise HTTPException(status_code=403, detail="Not allowed")
    try:
        rows = await v3_col("leads").find(
            {"vertical": {"$regex": "online", "$options": "i"}}, {"_id": 0},
        ).sort("updated_at", -1).to_list(20000)
        leads = [r for r in rows if vertical_in_arm(r.get("vertical"), practice)]
        return await _board_payload(leads, None, user.role)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("arm-board: failed to load")
        raise HTTPException(status_code=500, detail=f"arm-board error: {type(e).__name__}: {e}")


@router.post("/leads/{lead_id}/branch-stage")
async def v3_move_branch_stage(lead_id: str, payload: V3BranchStageInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # Validated against this lead's own branch, not the whole sales list: Branch Assign and
    # RNR only exist for a branch running its own leads, and moving a Pre-Sales-fed lead
    # onto one would strand it on a stage its board never draws.
    if payload.branch_stage not in await _branch_stage_names(lead.get("branch_id")):
        raise HTTPException(status_code=400, detail="Invalid branch stage")
    old_stage = lead.get("branch_stage", "Unknown")
    lead_arm = await sales_arm_for(branch_id=lead.get("branch_id"), vertical=lead.get("vertical"))

    # Not a prospect parks the lead rather than ending it: the desk picks when to ring the
    # patient back, and the board lists that date on the stage. Asked for on every move
    # here, so a lead cannot land on the stage with no call-back behind it.
    updates = {"branch_stage": payload.branch_stage, "updated_at": now_iso()}
    reminder_note = ""
    if payload.branch_stage == await _sales_stage_for_role(SALES_STAGE_ROLE_NOT_A_PROSPECT, lead_arm):
        if payload.reminder_days not in NOT_PROSPECT_REMINDER_DAYS:
            raise HTTPException(status_code=400, detail="Choose when to call this patient back")
        today_ist = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
        reminder_date = (today_ist + timedelta(days=payload.reminder_days)).isoformat()
        updates.update({
            "not_prospect_at": now_iso(),
            "not_prospect_by": user.full_name,
            "not_prospect_reminder_days": payload.reminder_days,
            "not_prospect_reminder_date": reminder_date,
            "not_prospect_remarks": (payload.reminder_remarks or "").strip() or None,
        })
        reminder_note = f" · reminder call {NOT_PROSPECT_REMINDER_DAYS[payload.reminder_days].lower()} ({reminder_date})"
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})

    # Cancelled is where a booked consultation goes to die, and the slot it was holding has
    # to go back on the calendar with it. Without this the lead read as cancelled on every
    # board while the expert's 10:30 stayed Booked -- an hour nobody could sell and nobody
    # was coming to.
    #
    # Done here rather than in a cancel endpoint of its own because the stage is the event:
    # however a lead reaches Cancelled -- this pill, a bulk move, a later screen -- the
    # appointment behind it is off. Idempotent, since a lead already cancelled has no rows
    # left in new_appointment to match.
    freed = 0
    if payload.branch_stage == await _sales_stage_for_role(SALES_STAGE_ROLE_CANCELLED, lead_arm):
        res = await v3_col("appointments").update_many(
            {"lead_id": lead_id, "status": "new_appointment"},
            {"$set": {"status": "cancelled", "updated_at": now_iso()}},
        )
        freed = res.modified_count

    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "branch_stage_change",
        "details": f"Branch stage: '{old_stage}' -> '{payload.branch_stage}'"
                   + (f" · {freed} appointment{'' if freed == 1 else 's'} cancelled, slot freed" if freed else "")
                   + reminder_note,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/schedule-portfolio", response_model=V3LeadOut)
async def v3_schedule_portfolio(lead_id: str, payload: V3PortfolioScheduleInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    """Move a lead to the 'Portfolio' branch stage with a Date + Time attached."""
    if "Portfolio" not in await _branch_stage_names():
        raise HTTPException(status_code=400, detail="'Portfolio' is not a configured branch stage")
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    old_stage = lead.get("branch_stage", "Unknown")
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "branch_stage": "Portfolio",
        "portfolio_date": payload.portfolio_date,
        "portfolio_time": payload.portfolio_time,
        "portfolio_datetime": f"{payload.portfolio_date}T{payload.portfolio_time}:00",
        "updated_at": now_iso(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portfolio_scheduled",
        "details": f"Branch stage: '{old_stage}' -> 'Portfolio' · {payload.portfolio_date} at {payload.portfolio_time}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/collect-fee")
async def v3_collect_fee(lead_id: str, payload: V3CollectFeeInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    updates = {"updated_at": now_iso()}
    if payload.fee_type == "consultation":
        updates["consultation_fee"] = payload.amount
    elif payload.fee_type == "package":
        updates["package_amount"] = payload.amount
        if payload.package_weeks:
            updates["package_weeks"] = payload.package_weeks
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})
    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "fee_collected",
        "details": f"{payload.fee_type.title()} fee collected: Rs.{payload.amount}" + (f" ({payload.package_weeks} weeks)" if payload.package_weeks else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/assign-physio")
async def v3_assign_physio(lead_id: str, payload: V3AssignPhysioInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin"))):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    physio = await v3_col("doctors").find_one({"id": payload.physio_id}, {"_id": 0})
    if not physio:
        raise HTTPException(status_code=404, detail="Physio not found")
    consultation_stage = lead.get("consultation_stage") or (await _consultation_stage_names())[0]
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "assigned_physio_id": payload.physio_id,
        "assigned_physio_name": physio["full_name"],
        "physio_assigned_at": now_iso(),
        "branch_stage": await _sales_stage_for_role(
            SALES_STAGE_ROLE_APPOINTMENT,
            await sales_arm_for(branch_id=lead.get("branch_id"), vertical=lead.get("vertical")),
        ),
        "consultation_stage": consultation_stage,
        "updated_at": now_iso(),
    }})
    activity = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "physio_assigned",
        "details": f"Jr. Physio assigned: {physio['full_name']}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    }
    await v3_col("lead_activity").insert_one(activity.copy())
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class V3BranchAppointmentInput(BaseModel):
    appointment_date: str   # YYYY-MM-DD
    appointment_time: str   # HH:MM
    physio_id: str
    notes: Optional[str] = ""
    # The two outcomes of the booking dialog, named by whatever Super Admin currently calls
    # the stages carrying the `appointment` and `cancelled` roles. The default is the name
    # the appointment stage shipped under; the endpoint accepts that spelling whatever the
    # stage has since been renamed to, so a browser holding a stale chunk keeps booking.
    final_stage: str = BRANCH_APPOINTMENT_STAGE
    # Length of the picked slot, carried from the expert's published calendar so the
    # Calendar tab can render the real end time (09:30–10:00) rather than assuming 30.
    duration: Optional[int] = None
    # The confirmation the patient is sent: `ref_no` is what's printed on it, and
    # `share_token` is the unguessable id its public link is keyed by. Both are minted
    # by the caller so the link can be built without a second round trip.
    ref_no: Optional[str] = None
    share_token: Optional[str] = None
    # "branch" | "home". Omitted by the calls that only move an existing booking (the
    # handover and the slot edit), which leaves whatever the lead already holds.
    visit_type: Optional[str] = None
    # The Home Visit > Consultant package the patient chose, required when visit_type is
    # "home". Only the id travels: the name and price are read off the catalogue here, so
    # the figure on the booking is the one the catalogue charges.
    visit_package_id: Optional[str] = None
    # Typed by the Branch Admin at booking, and only read for a package marked
    # manual_price (a Distance visit): the catalogue carries no figure for those.
    visit_package_amount: Optional[float] = None


# The catalogue shelf a house-visit consultation is sold from — PackagesBoard's
# HOME_VISIT_SUBTABS, Consultant sub-tab.
HOME_VISIT_CONSULTATION_CATEGORY = "home_visit_consultation"


def _visit_package_fields(item: Optional[dict], manual_amount: Optional[float] = None) -> dict:
    """The House Visit package as it is kept on the lead and its appointment, or the same
    keys emptied. Priced the way the catalogue prices it: a per-visit rate times the
    visits, unless the row already holds the whole fee."""
    if not item:
        return {"visit_package_id": None, "visit_package_name": None, "visit_package_price": None, "visit_package_visits": None}
    rate = float(item.get("price_offline") or 0)
    visits = int(item.get("sessions_offline") or 0)
    if item.get("manual_price"):
        price = round(float(manual_amount or 0))
    else:
        price = round(rate if item.get("price_is_total") else rate * visits)
    return {
        "visit_package_id": item.get("id"),
        "visit_package_name": item.get("name"),
        "visit_package_price": price,
        "visit_package_visits": visits,
    }


@router.post("/leads/{lead_id}/schedule-branch-appointment", response_model=V3LeadOut)
async def v3_schedule_branch_appointment(lead_id: str, payload: V3BranchAppointmentInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Schedule appointment date/time, assign physio, add notes, then move to final stage."""
    # Read before the stages are resolved: which of the two Branch pipelines this booking
    # answers to is the lead's own arm, and there is no meaningful appointment stage to
    # validate against until we know which practice the patient belongs to.
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    arm = await sales_arm_for(branch_id=lead.get("branch_id"), vertical=lead.get("vertical"))
    # Resolved from the pipeline rather than compared against literals: this check used to
    # read `not in ("Appointment Date & Time", "Cancelled")`, so renaming either stage in
    # CI/CD ROOTS made every booking a 400 — the board sent the stage's real name and the
    # endpoint only knew the one it shipped with.
    appointment_stage = await _sales_stage_for_role(SALES_STAGE_ROLE_APPOINTMENT, arm)
    cancelled_stage = await _sales_stage_for_role(SALES_STAGE_ROLE_CANCELLED, arm)
    # The shipped names stay accepted as aliases for their roles, so a browser still running
    # a chunk from before a rename books onto the renamed stage instead of being rejected.
    aliases = {
        BRANCH_APPOINTMENT_STAGE: appointment_stage,
        BRANCH_CANCELLED_STAGE: cancelled_stage,
    }
    final_stage = aliases.get(payload.final_stage, payload.final_stage)
    if final_stage not in (appointment_stage, cancelled_stage):
        raise HTTPException(
            status_code=400,
            detail=f"final_stage must be '{appointment_stage}' or '{cancelled_stage}'",
        )
    booking = final_stage == appointment_stage
    if payload.visit_type is not None and payload.visit_type not in ("branch", "home"):
        raise HTTPException(status_code=400, detail="visit_type must be 'branch' or 'home'")
    # A house visit is booked on a package or not at all: the consultant is going to the
    # patient's door, and what that visit costs is agreed before the day is.
    visit_package = None
    manual_amount = payload.visit_package_amount
    if booking and payload.visit_type == "home":
        if not payload.visit_package_id:
            raise HTTPException(status_code=400, detail="Pick a House Visit package")
        visit_package = await store_branch_overrides.overlay_one(await v3_col("store_items").find_one(
            {"id": payload.visit_package_id, "category": HOME_VISIT_CONSULTATION_CATEGORY}, {"_id": 0}
        ), lead.get("branch_id"))
        if not visit_package:
            raise HTTPException(status_code=404, detail="House Visit package not found")
        # Moving an existing booking to another slot does not ask for the amount again: the
        # figure already agreed for this same package stands.
        if not (manual_amount and manual_amount > 0) and lead.get("visit_package_id") == visit_package.get("id"):
            manual_amount = lead.get("visit_package_price")
        if visit_package.get("manual_price") and not (manual_amount and manual_amount > 0):
            raise HTTPException(status_code=400, detail=f"Enter the amount for {visit_package.get('name') or 'this package'}")
    package_fields = _visit_package_fields(visit_package, manual_amount)
    physio = await v3_col("doctors").find_one(
        {"id": payload.physio_id}, {"_id": 0, "full_name": 1, "slot_details": 1, "meet_link": 1}
    )
    if not physio:
        raise HTTPException(status_code=404, detail="Physio not found")

    slot_time = f"{payload.appointment_date}T{payload.appointment_time}"

    # The booking this lead already holds, read before anything is written so the slot it
    # is on can be compared with the one being asked for. Rescheduling is not a separate
    # endpoint -- rebooking IS the reschedule, and always has been, since the branch picks
    # a new slot on the same popup either way. What was missing is that nothing said so
    # afterwards.
    #
    # Derived here rather than taken from the caller: a flag on the payload would let a
    # notes edit claim to be a reschedule, and this is the field the Consultant reads to
    # know the patient has been moved once already.
    prior_appt = await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "consultation", "status": "new_appointment"},
        {"_id": 0, "id": 1, "slot_time": 1},
    )
    # Only a move counts. Re-picking the same slot is how the popup is used to edit notes
    # or hand the appointment to another expert, and calling that a reschedule would put
    # the tag on patients who were never moved at all.
    is_reschedule = bool(
        booking
        and prior_appt
        and prior_appt.get("slot_time")
        and prior_appt["slot_time"] != slot_time
    )

    # Someone else already holding this hour blocks the booking — the hour belongs to
    # whichever client took it. Re-picking it for the SAME lead is fine (that's a
    # reschedule onto itself / a notes edit), so this lead is excluded.
    #
    # Overlap, not an exact start. The hour is typed by hand on Branch Leads →
    # Appointment now — the Consultant Calendar publishes the day and the desk agrees the
    # minute — so two consultations can collide without sharing a start: a 45-minute 10:00
    # and a hand-entered 10:20 are the same stretch of the same consultant's day, and the
    # exact-match query this replaced read them as two free slots. consultant_slot_clash
    # compares the stretches, and reads consultations and reviews together, which is the
    # question actually being asked.
    if booking:
        clash = await consultant_slot_clash(
            payload.physio_id,
            slot_time,
            payload.duration or await consultation_slot_minutes(lead.get("branch_id")),
            exclude_lead_id=lead_id,
        )
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"{payload.appointment_time} is already booked with {physio['full_name']}"
                       + (f" for {clash.get('lead_name')}" if clash.get("lead_name") else ""),
            )

    updates = {
        "appointment_date": payload.appointment_date,
        "appointment_time": payload.appointment_time,
        "appointment_datetime": f"{payload.appointment_date}T{payload.appointment_time}:00",
        "assigned_physio_id": payload.physio_id,
        "assigned_physio_name": physio["full_name"],
        "physio_assigned_at": now_iso(),
        "branch_stage": final_stage,
        "updated_at": now_iso(),
    }
    if payload.visit_type is not None:
        updates["visit_type"] = payload.visit_type
        # Written whenever a visit type is stated, so moving a house visit back to the
        # branch drops its package rather than leaving it on the lead.
        updates.update(package_fields)
    # When the appointment is booked (not cancelled), hand the lead to BOTH consultation
    # pipelines at once:
    #   - Head Physio's own board -> its first stage ("New Appointment"), where they pick it up
    #   - Branch Admin's own board -> its first stage ("Consultation Booked"), which is
    #     the pill the Consultation tab opens on and where the booking is visible until
    #     the consultant sees the patient
    # Existing values are never overwritten, so a lead already further along stays put.
    if booking:
        updates["consultation_stage"] = lead.get("consultation_stage") or (await _consultation_stage_names())[0]
        updates["head_consultation_stage"] = lead.get("head_consultation_stage") or (await _head_consultation_stage_names())[0]
    if is_reschedule:
        # Counted rather than merely flagged: a patient moved three times is a different
        # conversation from one moved once, and the flag alone cannot tell them apart.
        updates["appointment_rescheduled"] = True
        updates["appointment_reschedule_count"] = int(lead.get("appointment_reschedule_count") or 0) + 1
        updates["appointment_rescheduled_at"] = now_iso()
        updates["appointment_rescheduled_from"] = prior_appt["slot_time"]
    if payload.notes and payload.notes.strip():
        existing_notes = (lead.get("notes") or "").strip()
        appended = f"[Appt {payload.appointment_date} {payload.appointment_time}] {payload.notes.strip()}"
        updates["notes"] = f"{existing_notes}\n{appended}" if existing_notes else appended
    await v3_col("leads").update_one({"id": lead_id}, {"$set": updates})

    # The lead fields above drive the Branch Leads table; the `appointments` record below
    # is what the Calendar tab renders and what marks the expert's slot as Booked on the
    # Consultant Calendar. Both must be written or the booking is invisible to scheduling.
    existing_appt = prior_appt
    if not booking:
        # Frees the slot again for everyone else.
        await v3_col("appointments").update_many(
            {"lead_id": lead_id, "status": "new_appointment"},
            {"$set": {"status": "cancelled", "updated_at": now_iso()}},
        )
    else:
        duration = payload.duration
        if not duration:
            # Fall back to whatever length the expert published this slot at.
            detail = next(
                (d for d in (physio.get("slot_details") or []) if d.get("slot_time") == slot_time),
                None,
            )
            duration = (detail or {}).get("duration") or 30
        appt_fields = {
            "branch_id": lead.get("branch_id"),
            "doctor_id": payload.physio_id,
            "doctor_name": physio["full_name"],
            "lead_id": lead_id,
            "lead_name": lead.get("name"),
            "patient_name": lead.get("name"),
            "appointment_date": payload.appointment_date,
            "appointment_time": payload.appointment_time,
            "slot_time": slot_time,
            "duration": duration,
            "notes": (payload.notes or "").strip(),
            # The room as it stood when this was booked, copied onto the appointment rather
            # than looked up through the expert whenever somebody opens it.
            #
            # Read off the expert's own record here, never off the payload: the link is
            # about to be sent to a patient over the clinic's name, and a booking screen
            # that could name the room would be a booking screen that could send a patient
            # anywhere. The screen shows what this record says; it does not get to say it.
            #
            # Frozen on purpose. An expert who changes their room next month has not
            # changed where the patients already told to join are going, and rewriting
            # every past appointment to the new address would move a meeting that has
            # already been arranged.
            "meet_link": (physio.get("meet_link") or "").strip(),
            "status": "new_appointment",
            "appt_kind": "consultation",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "updated_at": now_iso(),
        }
        if payload.visit_type is not None:
            appt_fields["visit_type"] = payload.visit_type
            appt_fields.update(package_fields)
        if payload.ref_no:
            appt_fields["ref_no"] = payload.ref_no
        if payload.share_token:
            appt_fields["share_token"] = payload.share_token
        if is_reschedule:
            # On the appointment as well as on the lead. The Head Physio calendar draws
            # slots straight out of this collection and never joins back to the lead, so
            # without this the one screen where a moved appointment matters most -- the
            # day the expert is about to work -- could not know it had moved.
            appt_fields["rescheduled"] = True
            appt_fields["rescheduled_from"] = prior_appt["slot_time"]
            appt_fields["rescheduled_at"] = now_iso()
        if existing_appt:
            # Rescheduling an existing booking — move it rather than leaving a stale row
            # holding the old slot.
            await v3_col("appointments").update_one({"id": existing_appt["id"]}, {"$set": appt_fields})
        else:
            await v3_col("appointments").insert_one({**appt_fields, "id": str(uuid.uuid4()), "created_at": now_iso()})

    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "branch_appointment_rescheduled" if is_reschedule else "branch_appointment_scheduled",
        "details": (
            (f"Appointment moved from {prior_appt['slot_time'].replace('T', ' ')} to "
             f"{payload.appointment_date} {payload.appointment_time} with {physio['full_name']}"
             if is_reschedule else
             f"Appointment {payload.appointment_date} {payload.appointment_time} with {physio['full_name']} → {final_stage}")
            + (f" · House Visit: {visit_package.get('name')}" if visit_package else "")
            + (f" · Notes: {payload.notes.strip()}" if payload.notes else "")
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


# ─── Trading two patients' appointments ───
#
# The third way out of a clash on the booking grid, beside handing the slot to another
# consultant and moving the patient to another time. Both of those leave the other patient
# where they are; this one is for when the two of them should change places -- the 11:45
# wants to be the 2:00 and the 2:00 wants to be the 11:45.
#
# It is deliberately an exchange and never a handover. Booking somebody into a taken slot
# is already refused by schedule-branch-appointment's clash check, and the only way round
# that check is to free the slot first -- which means somebody loses an appointment.
# Nobody does here: each side lands on the slot the other has just left, so the set of
# writes is closed and every patient in it still has a booking when it finishes.


async def _live_consultation_appt(lead_id: str) -> Optional[dict]:
    """The consultation this lead is holding right now, or None.

    The same query schedule-branch-appointment reads `prior_appt` with, so a lead this can
    swap is exactly a lead that endpoint could have rescheduled -- an older row without
    `appt_kind` is invisible to both rather than to one of them.
    """
    return await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "consultation", "status": "new_appointment"},
        {"_id": 0},
    )


@router.get("/branch-admin/swap-candidates/{branch_id}")
async def v3_swap_candidates(
    branch_id: str,
    lead_id: str = Query(..., description="The lead holding the slot being swapped out of"),
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Every other patient at this branch holding a consultation that could be traded for
    this one.

    Live bookings from today onwards only, because a swap has to give this patient
    something they can actually attend -- offering last Tuesday would let the branch move
    a patient into the past in one press.

    The whole branch rather than the one consultant or the one day: the reason to swap is
    usually that a patient rang about a time, and the slot that suits them is as likely to
    be on another expert's calendar as on this one's. Which pairing makes sense is the
    branch's call, and the row carries who and when so they can make it.
    """
    today = date.today().isoformat()
    rows = await v3_col("appointments").find(
        {
            "branch_id": branch_id,
            "appt_kind": "consultation",
            "status": "new_appointment",
            "lead_id": {"$ne": lead_id, "$exists": True},
            "slot_time": {"$gte": f"{today}T"},
        },
        {
            "_id": 0, "lead_id": 1, "lead_name": 1, "doctor_id": 1, "doctor_name": 1,
            "appointment_date": 1, "appointment_time": 1, "slot_time": 1, "duration": 1,
        },
    ).sort("slot_time", 1).to_list(500)
    return {
        "branch_id": branch_id,
        "lead_id": lead_id,
        "count": len(rows),
        "candidates": [r for r in rows if r.get("lead_id")],
    }


class V3BranchAppointmentSwapInput(BaseModel):
    # The other patient in the exchange, and the only thing the caller gets to say. Where
    # each of them ends up is read off the two live appointment rows, never off the
    # payload -- a swap that could name a time would be a booking screen able to put a
    # patient on a slot no consultant ever published.
    with_lead_id: str


def _swap_moving_fields(appt: dict) -> dict:
    """The half of an appointment row that changes hands: when it is, how long it runs,
    and whose calendar it sits on.

    The room travels with the consultant. It is frozen onto the appointment at booking
    time (see schedule-branch-appointment) so that an expert changing their room next
    month cannot move a meeting already arranged -- but this is not the expert changing
    anything, it is the patient being sent to a different expert, and carrying the old
    link across would send them to a room their new consultant never opens.

    Everything else on the row -- the patient's name, the notes taken about them, the
    reference number printed on the confirmation they were sent -- stays with the patient,
    because the row is their appointment and only its place in the day is being traded.
    """
    return {
        "doctor_id": appt.get("doctor_id"),
        "doctor_name": appt.get("doctor_name"),
        "slot_time": appt.get("slot_time"),
        "appointment_date": appt.get("appointment_date"),
        "appointment_time": appt.get("appointment_time"),
        "duration": appt.get("duration") or 30,
        "meet_link": (appt.get("meet_link") or "").strip(),
    }


@router.post("/leads/{lead_id}/swap-branch-appointment")
async def v3_swap_branch_appointment(
    lead_id: str,
    payload: V3BranchAppointmentSwapInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Exchange this lead's consultation with another lead's. Both keep an appointment."""
    if payload.with_lead_id == lead_id:
        raise HTTPException(status_code=400, detail="Pick a different patient to swap with")
    lead_a = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    lead_b = await v3_col("leads").find_one({"id": payload.with_lead_id}, {"_id": 0})
    if not lead_a or not lead_b:
        raise HTTPException(status_code=404, detail="Lead not found")
    # Branch Admin owns the calendars at their own branch and no others. Two patients at
    # different branches trading slots would move one of them to a building they were
    # never offered, so the pairing is refused rather than half-applied.
    if lead_a.get("branch_id") != lead_b.get("branch_id"):
        raise HTTPException(status_code=400, detail="Both patients must be at the same branch")

    appt_a = await _live_consultation_appt(lead_id)
    appt_b = await _live_consultation_appt(payload.with_lead_id)
    # Named in the refusal. "No appointment to swap" on a dialog showing two names is a
    # message the branch cannot act on without guessing which of them it means.
    if not appt_a:
        raise HTTPException(status_code=409, detail=f"{lead_a.get('name') or 'This patient'} has no live appointment to swap")
    if not appt_b:
        raise HTTPException(status_code=409, detail=f"{lead_b.get('name') or 'That patient'} has no live appointment to swap")
    if appt_a.get("slot_time") == appt_b.get("slot_time") and appt_a.get("doctor_id") == appt_b.get("doctor_id"):
        raise HTTPException(status_code=400, detail="Both appointments are already on the same slot")

    a_gets = _swap_moving_fields(appt_b)
    b_gets = _swap_moving_fields(appt_a)
    # Whether this counts as a reschedule, by the same rule the booking endpoint applies:
    # only a change of slot is a move. Two patients trading the same time between two
    # consultants have not been moved, and tagging them as rescheduled would tell their
    # consultants a story about the patient that never happened. One flag serves both
    # sides -- if either slot changed then both did, since each takes the other's.
    moved = appt_a.get("slot_time") != appt_b.get("slot_time")
    stamp = now_iso()

    def lead_updates(lead: dict, gets: dict, left: dict) -> dict:
        u = {
            "appointment_date": gets["appointment_date"],
            "appointment_time": gets["appointment_time"],
            "appointment_datetime": f"{gets['appointment_date']}T{gets['appointment_time']}:00",
            "assigned_physio_id": gets["doctor_id"],
            "assigned_physio_name": gets["doctor_name"],
            "physio_assigned_at": stamp,
            "updated_at": stamp,
        }
        if moved:
            # Counted rather than merely flagged, the same way the booking endpoint counts
            # it: a patient moved three times is a different conversation from one moved
            # once, and the flag alone cannot tell them apart.
            u["appointment_rescheduled"] = True
            u["appointment_reschedule_count"] = int(lead.get("appointment_reschedule_count") or 0) + 1
            u["appointment_rescheduled_at"] = stamp
            u["appointment_rescheduled_from"] = left.get("slot_time")
        return u

    def appt_updates(gets: dict, left: dict) -> dict:
        u = {**gets, "updated_at": stamp}
        if moved:
            # On the appointment row as well as on the lead: the Head Physio calendar
            # draws its day straight out of this collection and never joins back to the
            # lead, so without this the one screen where a moved appointment matters most
            # could not know it had moved.
            u["rescheduled"] = True
            u["rescheduled_from"] = left.get("slot_time")
            u["rescheduled_at"] = stamp
        return u

    # Four writes with no transaction behind them, in the order that fails safest. The
    # appointment rows go first, and A's before B's: between those two writes the pair
    # briefly reads as both holding B's old slot, which shows as a double-booking to a
    # calendar refreshed inside that window and corrects itself on the next refresh. The
    # other order leaves A's old slot held by nobody, which is worse -- a free slot is one
    # a second branch admin can book over, and that damage does not correct itself.
    await v3_col("appointments").update_one({"id": appt_a["id"]}, {"$set": appt_updates(a_gets, appt_a)})
    await v3_col("appointments").update_one({"id": appt_b["id"]}, {"$set": appt_updates(b_gets, appt_b)})
    await v3_col("leads").update_one({"id": lead_id}, {"$set": lead_updates(lead_a, a_gets, appt_a)})
    await v3_col("leads").update_one({"id": payload.with_lead_id}, {"$set": lead_updates(lead_b, b_gets, appt_b)})

    name_a = lead_a.get("name") or "Patient"
    name_b = lead_b.get("name") or "Patient"
    # One entry on each patient's own timeline, written from that patient's side. A single
    # shared line would read correctly on one card and backwards on the other.
    for lid, gets, left, other in (
        (lead_id, a_gets, appt_a, name_b),
        (payload.with_lead_id, b_gets, appt_b, name_a),
    ):
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lid,
            "action": "branch_appointment_swapped",
            "details": (
                f"Appointment swapped with {other} — "
                f"{(left.get('slot_time') or '').replace('T', ' ')} with {left.get('doctor_name') or 'their consultant'}"
                f" → {(gets.get('slot_time') or '').replace('T', ' ')} with {gets.get('doctor_name') or 'their consultant'}"
            ),
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": stamp,
        })

    return {
        "swapped": True,
        "moved": moved,
        "a": {"lead_id": lead_id, "name": name_a, **a_gets},
        "b": {"lead_id": payload.with_lead_id, "name": name_b, **b_gets},
    }





async def _expert_photos(experts: list) -> Dict[str, str]:
    """{ doctors.id: headshot URL } for the experts given, empty string where there is none.

    The picture is three documents away from the calendar record the booking popup lists:
    a `doctors` row names a login through user_id, the login names an employee through
    employee_id, and only the employee carries photo_url (see _employee_photo in
    v3_auth.py, which walks the last hop for the signed-in user).

    Two batched queries rather than a lookup per expert -- a branch with a dozen
    Consultants would otherwise pay two dozen round trips to draw one column of faces.
    An expert with no login, no employee behind the login, or no photo on the employee is
    simply absent from the result, which the avatar renders as their initial.
    """
    user_ids = [u for u in {e.get("user_id") for e in experts} if u]
    if not user_ids:
        return {}
    users = await v3_col("users").find(
        {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "employee_id": 1},
    ).to_list(len(user_ids))
    emp_by_user = {u["id"]: u.get("employee_id") for u in users if u.get("employee_id")}
    emp_ids = list({v for v in emp_by_user.values() if v})
    if not emp_ids:
        return {}
    employees = await v3_col("employees").find(
        {"id": {"$in": emp_ids}}, {"_id": 0, "id": 1, "photo_url": 1},
    ).to_list(len(emp_ids))
    photo_by_emp = {e["id"]: e.get("photo_url") or "" for e in employees}
    out = {}
    for e in experts:
        photo = photo_by_emp.get(emp_by_user.get(e.get("user_id")), "")
        if photo:
            out[e.get("id")] = photo
    return out


async def consultation_slot_minutes(branch_id: Optional[str] = None) -> Optional[int]:
    """The Consultation Duration set in FITSIO STORE, or None if none is set.

    Read on every request rather than frozen into the calendar: changing 60 mins to 30
    there has to change the times the booking popup offers straight away, without every
    Consultant re-publishing their days. A physiotherapy consultation wins over any other
    shelf's, and among those the one edited last — that is the edit being asked for.

    `branch_id` is whose calendar this is. Where that branch keeps its own durations
    (store_branch_overrides), its figures are the ones read.
    """
    rows = await v3_col("store_items").find(
        {"item_type": {"$in": ["consultation", None]}},
        {"_id": 0, "id": 1, "category": 1, "duration_minutes": 1, "updated_at": 1, "created_at": 1},
    ).to_list(500)
    rows = await store_branch_overrides.overlay(rows, branch_id)
    rows = [r for r in rows if (r.get("duration_minutes") or 0) > 0]
    if not rows:
        return None
    rows.sort(
        key=lambda r: (
            r.get("category") in (None, "", "physiotherapy"),
            r.get("updated_at") or r.get("created_at") or "",
        ),
        reverse=True,
    )
    return int(rows[0]["duration_minutes"])


def _clock_minutes(hhmm: str) -> Optional[int]:
    """"09:30" -> 570. None for anything that isn't HH:MM."""
    try:
        h, m = str(hhmm).split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, TypeError):
        return None


def _clock_text(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _consultant_day(expert: dict, date_str: str, bookings: list, slot_minutes: Optional[int], own: Optional[dict] = None) -> dict:
    """One Consultant's bookable day, cut at the store's Consultation Duration.

    What the Consultant published is when they are available, not a fixed grid: their
    slots are laid end to end into windows, and each window is cut again at slot_minutes.
    A 8:00–12:00 day published as 60-minute slots offers 8:00, 8:30 … 11:30 once the
    duration is 30 mins, and 8:00 and 10:00 once it is 2 hours. With no duration set in
    the store the published slots are offered as they are.

    `bookings` are this expert's live appointments on the date, other leads only; each
    blocks every slot it overlaps, so a 60-minute booking at 5:00 takes both 5:00 and
    5:30 off a 30-minute day. `own` is this lead's own appointment, kept selectable.
    """
    details = {x.get("slot_time"): x for x in (expert.get("slot_details") or [])}
    windows = []
    for s in expert.get("slots") or []:
        if not isinstance(s, str) or not s.startswith(f"{date_str}T"):
            continue
        start = _clock_minutes(s.split("T")[1])
        if start is None:
            continue
        length = int((details.get(s) or {}).get("duration") or 30)
        windows.append((start, start + length))
    windows.sort()

    # The published windows laid end to end — the consultant's shifts for the day
    # (e.g. Morning 7:00–14:00), independent of what is booked inside them.
    blocks: list = []
    for start, end in windows:
        if blocks and start <= blocks[-1][1]:
            blocks[-1][1] = max(blocks[-1][1], end)
        else:
            blocks.append([start, end])

    if slot_minutes:
        offered = []
        for start, end in blocks:
            t = start
            while t + slot_minutes <= end and t + slot_minutes <= 24 * 60:
                offered.append((t, slot_minutes))
                t += slot_minutes
    else:
        offered = [(start, end - start) for start, end in windows]

    taken = []
    for b in bookings:
        start = _clock_minutes((b.get("slot_time") or "").split("T")[-1])
        if start is None:
            continue
        taken.append((start, start + int(b.get("duration") or slot_minutes or 30), b))

    def overlaps(start: int, length: int) -> bool:
        return any(start < t_end and t_start < start + length for t_start, t_end, _ in taken)

    free = [(t, length) for t, length in offered if not overlaps(t, length)]
    if own:
        own_start = _clock_minutes((own.get("slot_time") or "").split("T")[-1])
        own_length = int(own.get("duration") or slot_minutes or 30)
        if own_start is not None and own_start not in {t for t, _ in free} and not overlaps(own_start, own_length):
            free.append((own_start, own_length))
    free.sort()

    return {
        "published_slot_count": len(offered),
        "day_blocks": [{"start": _clock_text(a), "end": _clock_text(min(b, 24 * 60 - 1))} for a, b in blocks],
        "free_slots": [
            {"slot_time": f"{date_str}T{_clock_text(t)}", "time": _clock_text(t), "duration": length}
            for t, length in free
        ],
        "booked_slots": [
            {
                "slot_time": f"{date_str}T{_clock_text(t_start)}",
                "time": _clock_text(t_start),
                "duration": t_end - t_start,
                "lead_name": b.get("lead_name"),
                "lead_id": b.get("lead_id"),
                # Set when the hour is held by a review rather than a consultation.
                "review_id": b.get("review_id"),
            }
            for t_start, t_end, b in sorted(taken, key=lambda x: x[0])
        ],
        "taken": taken,
    }


@router.get("/branch-admin/available-experts/{branch_id}")
async def v3_available_experts(
    branch_id: str,
    date: str,
    time: Optional[str] = None,
    lead_id: Optional[str] = None,
    review_id: Optional[str] = None,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Head Physios at this branch who can take a consultation on the given date
    (optionally narrowed to an exact time).

    Consultations are conducted by Consultants only — regular Physios run treatment
    sessions, which are booked separately once a package is sold — so this never offers
    a Physio.

    Only the Consultants posted to this branch. They used to be offered at every branch
    whatever anybody selected, which is the rule this booking popup existed on the wrong
    side of: a Branch Admin picking an expert was shown the whole organisation.
    """
    if not date:
        raise HTTPException(status_code=400, detail="date is required")
    # Nobody is offered on a day this branch is on leave (Monthly Calendar).
    leave_branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if leave_branch and is_leave(leave_branch, date):
        return {
            "date": date, "time": time, "slot_minutes": None, "branch_id": branch_id,
            "total_branch_experts": 0, "available_count": 0, "busy_count": 0, "experts": [],
            "branch_leave": True,
        }
    # Every consultant record, then narrowed to the ones posted here. Two steps because the
    # answer is not on the record — it is the branch list on the login behind it, and the
    # record itself stays branchless so one person keeps one calendar. See
    # consultants_serving_branch in deps.py.
    branch_experts = await v3_col("doctors").find(active_doctor_query({"profile_type": "head_physio"}), {"_id": 0}).to_list(500)
    branch_experts = await consultants_serving_branch(branch_experts, branch_id)

    # Availability is decided per slot, not per day: an expert with a 9:30 booking is
    # still free at 10:00. So a same-day booking no longer hides them — only being
    # genuinely full does (every slot they published for this date is taken). An expert
    # who published nothing stays listed, so the booking popup can say so and point at
    # the Consultant Calendar instead of silently offering no one.
    booked_rows = await v3_col("appointments").find(
        {"status": "new_appointment", "slot_time": {"$regex": f"^{date}T"}},
        {"_id": 0, "doctor_id": 1, "slot_time": 1, "lead_id": 1, "lead_name": 1, "duration": 1},
    ).to_list(2000)
    # Who holds each taken slot and for how long, so the picker can name them and a
    # booking blocks every slot it runs across. lead_id rides along because the grid's
    # pencil moves a taken slot with a POST against the lead holding it.
    bookings_by_doc: Dict[str, list] = {}
    own_by_doc: Dict[str, dict] = {}
    # Reviews sent to a Consultant hold their hour too. The review being reassigned
    # (review_id) is left out, so the slot it already sits in can be picked again.
    for r in await review_bookings(date, review_id):
        bookings_by_doc.setdefault(r["doctor_id"], []).append(r)
    for r in booked_rows:
        # A slot this same lead already holds isn't "taken" as far as they're concerned —
        # reopening their own booking has to keep offering the slot they're sitting in,
        # otherwise the popup can't show the current appointment or reschedule off it.
        if lead_id and r.get("lead_id") == lead_id:
            own_by_doc[r.get("doctor_id")] = r
            continue
        bookings_by_doc.setdefault(r.get("doctor_id"), []).append(r)

    # Slot length is this branch's Consultation Duration, fetched fresh on every open.
    slot_minutes = await consultation_slot_minutes(branch_id)

    # Faces for the picker's Consultant column, resolved once for the whole branch list
    # rather than per row. See _expert_photos.
    photo_by_expert = await _expert_photos(branch_experts)

    available = []
    for d in branch_experts:
        day = _consultant_day(
            d, date, bookings_by_doc.get(d.get("id"), []), slot_minutes, own_by_doc.get(d.get("id")),
        )
        if time:
            # Caller asked about one exact time — only offer experts free right then.
            start = _clock_minutes(time)
            length = slot_minutes or 30
            if start is not None and any(start < t_end and t_start < start + length for t_start, t_end, _ in day["taken"]):
                continue
        elif day["published_slot_count"] and not day["free_slots"]:
            continue  # fully booked for the day
        available.append({
            **d,
            # The expert's own headshot where HR has one on file, "" where they do not --
            # the picker draws their initial in the same circle either way, so this never
            # has to be present for the row to render.
            "photo_url": photo_by_expert.get(d.get("id"), ""),
            "free_slot_count": len(day["free_slots"]),
            "published_slot_count": day["published_slot_count"],
            # The free slots and the taken ones, so the booking popup can show the
            # expert's whole day rather than only the gaps. Both are cut at the store's
            # Consultation Duration — see _consultant_day.
            "free_slots": day["free_slots"],
            "booked_slots": day["booked_slots"],
            "day_blocks": day["day_blocks"],
        })
    return {
        "date": date,
        "time": time,
        "slot_minutes": slot_minutes,
        "branch_id": branch_id,
        "total_branch_experts": len(branch_experts),
        "available_count": len(available),
        "busy_count": len(branch_experts) - len(available),
        "experts": available,
    }



@router.get("/branch-admin/available-dates/{branch_id}")
async def v3_available_dates(
    branch_id: str,
    month: str = Query(..., description="YYYY-MM"),
    lead_id: Optional[str] = None,
    review_id: Optional[str] = None,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Every date in `month` that still has a free published Head Physio slot, and how many.

    Read from the same two places as available-experts — doctors.slots minus live
    appointments — so the booking calendar can only ever highlight a day its own expert
    and slot columns will actually be able to fill. (The older calendar-availability
    endpoint can't be used for this: it ignores the date when reading an expert's slots
    and falls back to a default 09:00-17:30 grid, so it reports every day as open.)
    """
    # Only the Consultants posted to this branch, the same narrowing available-experts
    # does — the two are read together by the booking calendar, and a day lit up here that
    # the expert column then cannot fill is worse than the day simply not being offered.
    # user_id is projected because that is what the narrowing reads.
    branch_experts = await v3_col("doctors").find(
        active_doctor_query({"profile_type": "head_physio"}),
        {"_id": 0, "id": 1, "slots": 1, "slot_details": 1, "user_id": 1, "profile_type": 1, "branch_id": 1},
    ).to_list(500)
    branch_experts = await consultants_serving_branch(branch_experts, branch_id)

    booked_rows = await v3_col("appointments").find(
        {"status": "new_appointment", "slot_time": {"$regex": f"^{month}-"}},
        {"_id": 0, "doctor_id": 1, "slot_time": 1, "lead_id": 1, "duration": 1},
    ).to_list(5000)
    # This lead's own bookings don't count against it — the day it already sits on has to
    # stay reachable so the appointment can be seen and moved.
    bookings: Dict[tuple, list] = {}
    # Reviews sent to a Consultant take their hour as well — see available-experts.
    for r in await review_bookings(month, review_id):
        bookings.setdefault((r["doctor_id"], r["slot_time"].split("T")[0]), []).append(r)
    for r in booked_rows:
        if lead_id and r.get("lead_id") == lead_id:
            continue
        key = (r.get("doctor_id"), (r.get("slot_time") or "").split("T")[0])
        bookings.setdefault(key, []).append(r)

    # Counted off the same cut as available-experts, so a day's number here is the number
    # of tiles its slot grid will draw.
    slot_minutes = await consultation_slot_minutes(branch_id)
    dates: Dict[str, int] = {}
    for d in branch_experts:
        days = {
            s.split("T")[0]
            for s in (d.get("slots") or [])
            if isinstance(s, str) and s.startswith(f"{month}-") and "T" in s
        }
        for day in days:
            free = len(_consultant_day(d, day, bookings.get((d["id"], day), []), slot_minutes)["free_slots"])
            if free:
                dates[day] = dates.get(day, 0) + free
    # A day this branch is on leave (Monthly Calendar) is not offered, even where a
    # Consultant shared with another branch still has hours published on it.
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if branch:
        dates = {day: n for day, n in dates.items() if not is_leave(branch, day)}
    return {"month": month, "branch_id": branch_id, "dates": dates}


@router.get("/branch-admin/consultations/{branch_id}/board")
async def v3_consultations_board(
    branch_id: str,
    pipeline: Optional[str] = None,
    mine: bool = False,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio")),
):
    """Return leads in the Consultations pipeline for a branch, grouped by the caller's own
    pipeline field. Head Physio has a fully independent pipeline (head_consultation_stage) from
    Branch Admin's own (consultation_stage) — filtering by the wrong field would show a Head
    Physio every branch lead that has merely entered the Branch's pipeline, not just the ones
    actually handed off to them, inflating "All Stages" beyond the sum of their own stage pills.
    Super Admin driving a branch's Head Physio board (Branch Management > Branch Control) can
    pass pipeline=head_consultation to see it the same way that branch's head physio would.

    branch_id="all" drops the branch filter. Head Physios cover every branch and so carry no
    branch of their own; without this their board would ask for a branch it doesn't have and
    come back empty.

    `mine=true` narrows it further, to the consultations booked to the CALLER. This board is
    branch-scoped and has never been person-scoped, which was right for Operations, where a
    supervisor is reading a branch, and wrong for My Consultation, where the page is named
    after the reader and was listing every consultant in the organisation under that title.

    Whose it is comes off `appointments.doctor_id`, not off `leads.assigned_physio_id`. Only
    the appointment records who actually took the consultation — `assigned_physio_id` is the
    treating physio, despite the booking copying a consultant onto it at times. See
    consultant_thread_target in physio_scope."""
    try:
        # Off the predicate, not the literal: the desk is `consultant`/`online_consultant`
        # now, and matching the retired slug exactly dropped every consultant onto the
        # Branch Admin's consultation pipeline instead of their own.
        is_hp = is_head_physio_role(user.role) or (works_org_wide(user.role) and pipeline == "head_consultation")
        field = "head_consultation_stage" if is_hp else "consultation_stage"
        query = {field: {"$ne": None}}
        if branch_id and branch_id != "all":
            query["branch_id"] = branch_id
        else:
            # Every branch at once: not the Past Data branch's trial clients, which are read
            # on that branch's own board (see utils.without_past_moves).
            query = without_past_moves(query)
        if mine:
            my_doctor_ids = await v3_col("doctors").distinct(
                "id", {"user_id": user.id, "profile_type": "head_physio"},
            )
            # An empty answer here has to stay empty rather than fall through to the whole
            # branch. A consultant with nothing booked yet reading an empty page is correct;
            # the same consultant reading everybody else's patients is the bug this fixes.
            # Not diet check-ins: those live in the same collection against a Nutrition
            # Coach record. A consultant id cannot currently collide with one, but the
            # narrowing this drives is "which consultations are mine", and a query that
            # answers it by accident is one rename away from answering it wrongly.
            my_lead_ids = await v3_col("appointments").distinct(
                "lead_id",
                {"doctor_id": {"$in": my_doctor_ids}, "appt_kind": {"$ne": "diet"}},
            ) if my_doctor_ids else []
            query["id"] = {"$in": my_lead_ids}
        leads_docs = await v3_col("leads").find(query, {"_id": 0}).sort("updated_at", -1).to_list(2000)
        stage_names = await _head_consultation_stage_names() if is_hp else await _consultation_stage_names()
        stage_counts = {}
        for stage in stage_names:
            stage_counts[stage] = sum(1 for ld in leads_docs if ld.get(field) == stage)
        # How far through their days each patient is. The branch-board next door has
        # always stamped this; here it was missing, so total_sessions and
        # completed_sessions arrived undefined and the Completed stage -- which is read
        # off exactly those two numbers -- could only ever find the Consultation Only
        # patients somebody had closed by hand. A patient who finished every day of a
        # course was not on it.
        await _stamp_session_progress(leads_docs)
        # One malformed lead document shouldn't 500 the whole board — skip it and keep
        # showing every other lead rather than failing the entire list.
        lead_list = []
        for ld in leads_docs:
            try:
                lead_list.append(V3LeadOut(**lead_as_read_by(ld, user.role)).model_dump())
            except Exception as e:
                logging.getLogger(__name__).error(f"consultations-board: skipping unparseable lead {ld.get('id')}: {e}")
        # Who has their prescription filed, as a list of ids beside the leads rather than a
        # field on each of them. The Consultation Fee is gated on that page, and the Collect
        # button at the end of a row has to know before it is pressed — a row that opens a
        # payment it will not take reads as broken.
        #
        # Kept off the lead deliberately. Every collect and every stage move replaces the
        # row it touched with the lead that endpoint returns, and a flag riding on the lead
        # would be dropped by every one of them — locking a row whose prescription is on
        # file. Answered once for the board, held beside it, and untouched by any of that.
        rx_ids = await leads_with_prescription([ld.get("id") for ld in leads_docs if ld.get("id")])
        # Which consultants on this board are a Super Admin taking consultations, so the
        # Consultant column can say so. Sent as a list of ids beside the leads rather than a
        # flag on each of them, for the same reason rx_lead_ids is: every collect and every
        # stage move replaces the row it touched with the lead that endpoint returns, and a
        # flag riding on the lead would be dropped by all of them — the tag would vanish off
        # a row the moment anybody worked on it.
        sa_consultant_ids = await v3_col("doctors").distinct(
            "id", {"profile_type": "head_physio", "is_super_admin": True},
        )
        return {
            "leads": lead_list,
            "stage_counts": stage_counts,
            "stages": stage_names,
            "rx_lead_ids": sorted(rx_ids),
            "super_admin_consultant_ids": sorted(sa_consultant_ids),
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("consultations-board: failed to load")
        raise HTTPException(status_code=500, detail=f"consultations-board error: {type(e).__name__}: {e}")


# Stages reachable only through their own dedicated, validated action endpoint —
# never through a plain manual move.
_CONSULTATION_STAGE_GATED = {
    "Consultation Visit",   # via consultation-decision (Head Physio's Save & Move)
    "Fee Collected",        # via collect-package-payment / collect-treatment-fee
    "Physio Assign",        # via assign-consultation-physio
    "Consultation Completed",  # via mark-consultation-completed
}


@router.post("/leads/{lead_id}/move-consultation-stage", response_model=V3LeadOut)
async def v3_move_consultation_stage(lead_id: str, payload: V3ConsultationStageInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio"))):
    stage_names = await _consultation_stage_names()
    if payload.consultation_stage not in stage_names:
        raise HTTPException(status_code=400, detail=f"Invalid consultation_stage. Allowed: {stage_names}")
    if payload.consultation_stage in _CONSULTATION_STAGE_GATED:
        raise HTTPException(
            status_code=403,
            detail=f"'{payload.consultation_stage}' can only be reached through its own action, not a manual stage move.",
        )

    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    previous = lead.get("consultation_stage") or "—"
    # Backward moves (to an earlier stage than the lead's current one) are never
    # allowed once a lead has moved forward — "Cancel" is a side-exit, not a
    # reorder, so it's exempt.
    if previous in stage_names and payload.consultation_stage != "Cancel":
        prev_idx = stage_names.index(previous)
        next_idx = stage_names.index(payload.consultation_stage)
        if next_idx < prev_idx:
            raise HTTPException(
                status_code=403,
                detail=f"'{previous}' has already moved forward — it can't be sent back to '{payload.consultation_stage}'.",
            )

    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "consultation_stage": payload.consultation_stage,
        "updated_at": now_iso(),
    }})
    # Cancel is also the Branch Leads card's Cancel pill, which reaches it straight off a
    # booked Appointment. The slot that booking holds goes back on the calendar, the way the
    # Branch pipeline's own Cancelled stage always released it (see v3_move_branch_stage).
    freed = 0
    if payload.consultation_stage == "Cancel":
        res = await v3_col("appointments").update_many(
            {"lead_id": lead_id, "status": "new_appointment"},
            {"$set": {"status": "cancelled", "updated_at": now_iso()}},
        )
        freed = res.modified_count
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_stage_moved",
        "details": f"Consultation: {previous} → {payload.consultation_stage}"
                   + (f" · {freed} appointment{'' if freed == 1 else 's'} cancelled, slot freed" if freed else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class V3BranchFollowUpInput(BaseModel):
    date: str  # YYYY-MM-DD
    time: str  # HH:MM (24h)
    remarks: Optional[str] = ""


class V3BranchFollowUpRescheduleInput(BaseModel):
    date: str
    time: str
    reason: Optional[str] = ""


@router.post("/leads/{lead_id}/branch-follow-up", response_model=V3LeadOut)
async def v3_schedule_branch_follow_up(lead_id: str, payload: V3BranchFollowUpInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Schedule a Branch Leads follow-up. Appends to follow_ups[] and moves branch_stage to 'Follow Up'.

    Distinct from Pre-Sales' /leads/{id}/follow-up, which instead moves the pre-sales `stage`
    field — Branch Admin's own pipeline is tracked via `branch_stage`, so it needs its own
    endpoint rather than overloading the pre-sales one."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": (payload.remarks or "").strip(),
        "status": "active",
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$push": {"follow_ups": entry}, "$set": {"branch_stage": "Follow Up", "next_follow_up_at": f"{payload.date}T{payload.time}:00", "updated_at": now_iso()}},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "branch_follow_up_scheduled",
        "details": f"Branch follow-up on {payload.date} at {payload.time} — {entry['remarks'] or 'no remarks'}",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/branch-follow-up/{followup_id}/reschedule", response_model=V3LeadOut)
async def v3_reschedule_branch_follow_up(lead_id: str, followup_id: str, payload: V3BranchFollowUpRescheduleInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Mark an existing branch follow-up as rescheduled (with a reason) and add a new active one in its place."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    follow_ups = lead.get("follow_ups") or []
    old = next((f for f in follow_ups if f.get("id") == followup_id), None)
    if not old:
        raise HTTPException(status_code=404, detail="Follow-up not found")
    reason = (payload.reason or "").strip()
    for f in follow_ups:
        if f.get("id") == followup_id:
            f["status"] = "rescheduled"
            f["reschedule_reason"] = reason
    new_entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": old.get("remarks", ""),
        "status": "active",
        "rescheduled_from": followup_id,
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    follow_ups.append(new_entry)
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": {"follow_ups": follow_ups, "branch_stage": "Follow Up", "next_follow_up_at": f"{payload.date}T{payload.time}:00", "updated_at": now_iso()}},
    )
    old_summary = f"{old.get('date')} at {old.get('time')}"
    details = f"Branch follow-up rescheduled from {old_summary} to {payload.date} at {payload.time}"
    if reason:
        details += f" — reason: {reason}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "branch_follow_up_rescheduled",
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


class V3ConsultationFollowUpInput(BaseModel):
    date: str  # YYYY-MM-DD
    time: str  # HH:MM (24h)
    remarks: Optional[str] = ""
    # Who is going to take it. Optional so an older client that only sends a date and a
    # time keeps working — the patient then stays with the consultant they already have.
    physio_id: Optional[str] = None
    duration: Optional[int] = None


class V3ConsultationFollowUpRescheduleInput(BaseModel):
    date: str
    time: str
    reason: Optional[str] = ""
    # A reschedule moves the hour, and the hour belongs to a person: the consultant who
    # could not take the patient on the old date is often not the one free on the new one.
    # Sent as the id of whoever the branch picked off the availability list; omitted means
    # keep the consultant already on the lead.
    physio_id: Optional[str] = None
    duration: Optional[int] = None


async def _rebook_consultation_slot(
    lead: dict,
    physio_id: Optional[str],
    date_str: str,
    time_str: str,
    duration: Optional[int],
    user: V3UserOut,
) -> Dict[str, object]:
    """Move this patient's consultation onto a new slot, and optionally a new consultant.

    Returns the fields to $set on the lead. The caller writes them alongside whatever else
    its own stage move needs, so the lead is touched once.

    The `appointments` row is what the Consultant Calendar draws and what marks a slot
    Booked, so moving only the lead's own appointment_date/appointment_time left the old
    hour held on the consultant's day and the new one looking free to the next patient who
    asked for it. Rebooking here is the same act v3_schedule_branch_appointment performs
    for a first booking, and deliberately reads the same two collections in the same
    order.

    Raises 404 if the consultant asked for does not exist, and 409 if somebody else
    already holds the slot with them.
    """
    lead_id = lead["id"]
    slot_time = f"{date_str}T{time_str}"
    fields: Dict[str, object] = {
        "appointment_date": date_str,
        "appointment_time": time_str,
        "appointment_datetime": f"{date_str}T{time_str}:00",
        "next_consultation_follow_up_at": f"{date_str}T{time_str}:00",
    }

    # Whoever the booking is going to. A reschedule that names nobody keeps the consultant
    # already on the lead, which is what an older client sending only a date and a time
    # means by it.
    target_id = physio_id or lead.get("assigned_physio_id")
    physio = None
    if target_id:
        physio = await v3_col("doctors").find_one(
            {"id": target_id}, {"_id": 0, "id": 1, "full_name": 1, "slot_details": 1, "meet_link": 1}
        )
        if not physio and physio_id:
            # Only an explicitly requested consultant is an error. A stale id already on
            # the lead is not something this reschedule introduced, and refusing over it
            # would strand the patient on a slot nobody can move.
            raise HTTPException(status_code=404, detail="Consultant not found")

    if not physio:
        # No consultant on the lead and none picked: the date and time still move, there is
        # simply no calendar to move them on.
        return fields

    # Somebody else's booking on this consultant at this hour blocks it — the hour belongs
    # to whichever patient took it. Checked for the consultant being kept as well as one
    # being changed to: this writes a row onto their calendar either way, and a move that
    # only changed the time would otherwise be able to put two patients in one hour.
    #
    # This lead's own row is excluded, so moving the time while keeping the consultant (or
    # the other way round) is never read as a clash with itself.
    #
    # Overlap, not an exact start — the same reason v3_schedule_branch_appointment reads
    # it this way. The new time is typed by hand on the Reschedule popup, so two
    # consultations can collide without sharing a start, and an exact-match query calls
    # a 45-minute 10:00 and a hand-entered 10:20 two free slots.
    clash = await consultant_slot_clash(
        physio["id"],
        slot_time,
        duration or await consultation_slot_minutes(lead.get("branch_id")),
        exclude_lead_id=lead_id,
    )
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"{time_str} is already booked with {physio['full_name']}"
                   + (f" for {clash.get('lead_name')}" if clash.get("lead_name") else ""),
        )
    if physio_id:
        fields["assigned_physio_id"] = physio["id"]
        fields["assigned_physio_name"] = physio["full_name"]
        fields["physio_assigned_at"] = now_iso()

    existing = await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "consultation", "status": "new_appointment"},
        {"_id": 0, "id": 1, "slot_time": 1, "duration": 1, "notes": 1, "ref_no": 1, "share_token": 1},
    )
    moved_from = (existing or {}).get("slot_time")
    if not duration:
        detail = next(
            (d for d in (physio.get("slot_details") or []) if d.get("slot_time") == slot_time),
            None,
        )
        duration = (detail or {}).get("duration") or (existing or {}).get("duration") or 30
    appt_fields = {
        "branch_id": lead.get("branch_id"),
        "doctor_id": physio["id"],
        "doctor_name": physio["full_name"],
        "lead_id": lead_id,
        "lead_name": lead.get("name"),
        "patient_name": lead.get("name"),
        "appointment_date": date_str,
        "appointment_time": time_str,
        "slot_time": slot_time,
        "duration": duration,
        "meet_link": (physio.get("meet_link") or "").strip(),
        "status": "new_appointment",
        "appt_kind": "consultation",
        "updated_at": now_iso(),
    }
    if moved_from and moved_from != slot_time:
        # Same three marks v3_schedule_branch_appointment writes. The Consultant Calendar
        # reads this collection and never joins back to the lead, so without them the one
        # screen where a moved appointment matters most cannot know it moved.
        appt_fields["rescheduled"] = True
        appt_fields["rescheduled_from"] = moved_from
        appt_fields["rescheduled_at"] = now_iso()
        fields["appointment_rescheduled"] = True
        fields["appointment_reschedule_count"] = int(lead.get("appointment_reschedule_count") or 0) + 1
        fields["appointment_rescheduled_at"] = now_iso()
        fields["appointment_rescheduled_from"] = moved_from
    if existing:
        await v3_col("appointments").update_one({"id": existing["id"]}, {"$set": appt_fields})
    else:
        # Nothing on the calendar to move: this patient was booked before the appointment
        # row existed, or arrived on the consultation board without one. Writing it now is
        # what puts them on the consultant's day at all.
        await v3_col("appointments").insert_one({
            **appt_fields,
            "id": str(uuid.uuid4()),
            "notes": "",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now_iso(),
        })
    return fields


@router.post("/leads/{lead_id}/consultation-follow-up", response_model=V3LeadOut)
async def v3_schedule_consultation_follow_up(lead_id: str, payload: V3ConsultationFollowUpInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio"))):
    """Schedule a consultation follow-up. Appends to consultation_follow_ups[] and moves consultation_stage to 'Consultation Booked'."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    # The confirmed Follow-Up date/time IS the patient's consultation appointment, so the
    # consultant's calendar moves with it — see _rebook_consultation_slot.
    booking = await _rebook_consultation_slot(lead, payload.physio_id, payload.date, payload.time, payload.duration, user)
    entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": (payload.remarks or "").strip(),
        "status": "active",
        "consultant_id": booking.get("assigned_physio_id") or lead.get("assigned_physio_id"),
        "consultant_name": booking.get("assigned_physio_name") or lead.get("assigned_physio_name"),
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    # Hand off to the Head Physio's own pipeline, seeding it only the first time so a
    # later reschedule never regresses progress the doctor has already made.
    set_fields = {
        **booking,
        "consultation_stage": "Consultation Booked",
        "updated_at": now_iso(),
    }
    if not lead.get("head_consultation_stage"):
        set_fields["head_consultation_stage"] = (await _head_consultation_stage_names())[0]
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$push": {"consultation_follow_ups": entry}, "$set": set_fields},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_follow_up_scheduled",
        "details": (f"Consultation follow-up on {payload.date} at {payload.time}"
                    + (f" with {entry['consultant_name']}" if entry.get("consultant_name") else "")
                    + f" — {entry['remarks'] or 'no remarks'}"),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


@router.post("/leads/{lead_id}/consultation-follow-up/{followup_id}/reschedule", response_model=V3LeadOut)
async def v3_reschedule_consultation_follow_up(lead_id: str, followup_id: str, payload: V3ConsultationFollowUpRescheduleInput, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio"))):
    """Mark an existing consultation follow-up as rescheduled (with a reason) and add a new active one in its place."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    follow_ups = lead.get("consultation_follow_ups") or []
    old = next((f for f in follow_ups if f.get("id") == followup_id), None)
    if not old:
        raise HTTPException(status_code=404, detail="Follow-up not found")
    reason = (payload.reason or "").strip()
    prev_consultant = old.get("consultant_name") or lead.get("assigned_physio_name")
    # The hour and the person who holds it move together. Done before the follow-up rows
    # are written so a clash — somebody else already on that consultant at that time —
    # refuses the whole reschedule rather than leaving the lead's history claiming a
    # booking the calendar never took.
    booking = await _rebook_consultation_slot(lead, payload.physio_id, payload.date, payload.time, payload.duration, user)
    consultant_name = booking.get("assigned_physio_name") or lead.get("assigned_physio_name")
    for f in follow_ups:
        if f.get("id") == followup_id:
            f["status"] = "rescheduled"
            f["reschedule_reason"] = reason
    new_entry = {
        "id": str(uuid.uuid4()),
        "date": payload.date,
        "time": payload.time,
        "remarks": old.get("remarks", ""),
        "status": "active",
        "rescheduled_from": followup_id,
        # Who the new slot is with. Stamped on the entry rather than read off the lead
        # later, because the lead only ever carries the current consultant and this is the
        # record of who each booking in the chain was actually made with.
        "consultant_id": booking.get("assigned_physio_id") or lead.get("assigned_physio_id"),
        "consultant_name": consultant_name,
        "created_by": user.full_name,
        "created_at": now_iso(),
    }
    follow_ups.append(new_entry)
    set_fields = {
        **booking,
        "consultation_follow_ups": follow_ups,
        "consultation_stage": "Consultation Booked",
        "updated_at": now_iso(),
    }
    if not lead.get("head_consultation_stage"):
        set_fields["head_consultation_stage"] = (await _head_consultation_stage_names())[0]
    await v3_col("leads").update_one(
        {"id": lead_id},
        {"$set": set_fields},
    )
    old_summary = f"{old.get('date')} at {old.get('time')}"
    details = f"Consultation follow-up rescheduled from {old_summary} to {payload.date} at {payload.time}"
    # Named both ways round when the consultant changed, because "moved to Tuesday" and
    # "moved to Tuesday with somebody else" are two different things to have done to a
    # patient, and the timeline is where anyone finds out which one happened.
    if consultant_name and prev_consultant and consultant_name != prev_consultant:
        details += f" — consultant changed from {prev_consultant} to {consultant_name}"
    elif consultant_name:
        details += f" with {consultant_name}"
    if reason:
        details += f" — reason: {reason}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "consultation_follow_up_rescheduled",
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return V3LeadOut(**updated)


# ---------- Smart Booking ----------

DEFAULT_SLOTS = [f"{h:02d}:{m:02d}" for h in range(9, 18) for m in (0, 30)]  # 09:00 → 17:30 every 30 min


async def _branch_experts(branch_id: str):
    rows = await v3_col("doctors").find(active_doctor_query({"branch_id": branch_id}), {"_id": 0}).to_list(500)
    return rows or await v3_col("doctors").find(active_doctor_query(), {"_id": 0}).to_list(500)


def _expert_slots(expert: dict):
    """Return the 30-min HH:MM slot list for an expert.

    Prefer slot_details filtered to consultation_type == "Initial Consultation"
    (because Smart Booking only books fresh appointments, not follow-ups/reviews).
    Falls back to the legacy `slots` list, then to the default 09:00-17:30 grid.
    """
    details = expert.get("slot_details") or []
    initial = [d.get("slot_time", "")[:5] for d in details
               if (d.get("consultation_type") or "Initial Consultation") == "Initial Consultation"
               and d.get("slot_time")]
    if initial:
        return sorted(set(initial))
    custom = expert.get("slots") or []
    norm = []
    for s in custom:
        if isinstance(s, str) and len(s) >= 5 and s[2] == ":":
            norm.append(s[:5])
    return norm if norm else DEFAULT_SLOTS


async def _booked_by_expert(branch_id: str, date_str: str):
    """Return {expert_id: set(HH:MM)} of already-booked slots for a branch on a date."""
    cursor = v3_col("leads").find(
        {"branch_id": branch_id, "appointment_date": date_str,
         "assigned_physio_id": {"$ne": None}, "branch_stage": {"$ne": "Cancelled"}},
        {"_id": 0, "assigned_physio_id": 1, "appointment_time": 1}
    )
    booked = {}
    async for ld in cursor:
        eid = ld.get("assigned_physio_id")
        t = (ld.get("appointment_time") or "")[:5]
        if not eid or not t:
            continue
        booked.setdefault(eid, set()).add(t)
    return booked


@router.get("/branch-admin/calendar-availability/{branch_id}")
async def v3_calendar_availability(
    branch_id: str,
    month: str = Query(..., description="YYYY-MM"),
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "head_physio")),
):
    """Return per-day availability for a branch in a given month."""
    try:
        y, m = month.split("-")
        y, m = int(y), int(m)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM") from exc
    _, last_day = monthrange(y, m)
    experts = await _branch_experts(branch_id)
    days = {}
    for d in range(1, last_day + 1):
        date_str = f"{y:04d}-{m:02d}-{d:02d}"
        booked = await _booked_by_expert(branch_id, date_str)
        # Count experts who have at least 1 free slot today
        free_experts = 0
        for e in experts:
            slots = set(_expert_slots(e))
            taken = booked.get(e.get("id"), set())
            if slots - taken:
                free_experts += 1
        days[date_str] = {
            "available_experts": free_experts,
            "total_experts": len(experts),
            "fully_booked": free_experts == 0 and len(experts) > 0,
        }
    return {"month": month, "branch_id": branch_id, "experts_total": len(experts), "days": days}


@router.get("/branch-admin/day-slots/{branch_id}")
async def v3_day_slots(
    branch_id: str,
    date: str = Query(..., description="YYYY-MM-DD"),
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "head_physio")),
):
    """Return 30-min slots for a given day with the list of available experts per slot."""
    experts = await _branch_experts(branch_id)
    booked = await _booked_by_expert(branch_id, date)
    # Union of all slots offered by any expert that day
    all_slots = set()
    for e in experts:
        all_slots.update(_expert_slots(e))
    out = []
    for t in sorted(all_slots):
        free_experts = []
        for e in experts:
            if t not in _expert_slots(e):
                continue
            if t in booked.get(e.get("id"), set()):
                continue
            free_experts.append({"id": e["id"], "full_name": e.get("full_name"), "specialization": e.get("specialization"), "profile_type": e.get("profile_type")})
        out.append({"time": t, "available_experts": free_experts, "available_count": len(free_experts)})
    return {"date": date, "branch_id": branch_id, "slots": out}


@router.get("/branch-admin/expert-calendar/{expert_id}")
async def v3_expert_calendar(
    expert_id: str,
    month: str = Query(..., description="YYYY-MM"),
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "head_physio")),
):
    """Return per-day availability for a single expert in a month + the slots they offer."""
    try:
        y, m = month.split("-")
        y, m = int(y), int(m)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM") from exc
    expert = await v3_col("doctors").find_one({"id": expert_id}, {"_id": 0})
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")
    slots = _expert_slots(expert)
    _, last_day = monthrange(y, m)
    days = {}
    branch_id = expert.get("branch_id")
    for d in range(1, last_day + 1):
        date_str = f"{y:04d}-{m:02d}-{d:02d}"
        if branch_id:
            booked = await _booked_by_expert(branch_id, date_str)
            taken = booked.get(expert_id, set())
        else:
            # Fallback: look at any lead assigned to this expert that day
            cursor = v3_col("leads").find(
                {"assigned_physio_id": expert_id, "appointment_date": date_str, "branch_stage": {"$ne": "Cancelled"}},
                {"_id": 0, "appointment_time": 1},
            )
            taken = set()
            async for ld in cursor:
                t = (ld.get("appointment_time") or "")[:5]
                if t:
                    taken.add(t)
        free_slots = [s for s in slots if s not in taken]
        days[date_str] = {"available_slots": free_slots, "total_slots": len(slots), "fully_booked": len(free_slots) == 0}
    return {"expert_id": expert_id, "expert_name": expert.get("full_name"), "month": month, "slots_per_day": slots, "days": days}



# ---------------------------------------------------------------- Branch Transfer
#
# Moving a patient from one branch to another, which is a different act at each end of
# their time with us and impossible in the middle of it.
#
# Two windows, and the gap between them is deliberate. Before a consultation is booked the
# lead is just a name and a phone number: nothing is on anyone's calendar, no money has
# been taken, and the move costs nothing but the stage they stand on. Once treatment is
# under way — Physio Assign — the move is real work but it is work with a shape: the days
# already delivered are finished, and the days still to come have to be released and
# rebooked wherever the patient is going.
#
# What is refused is everything between those two. A consultation booked but not yet held
# sits on a named Head Physio's calendar at this branch; a Treatment Fee part-collected
# sits on an installment plan that would end up split across two branches' books. Neither
# is impossible to move — both are things nobody has decided the rules for, and guessing
# at them in code is how a branch ends up with half a patient.
TRANSFERABLE_AT_PHYSIO_ASSIGN = "Physio Assign"


def _transfer_block_reason(lead: dict) -> Optional[str]:
    """Why this patient cannot be transferred right now, or None if they can.

    Phrased as the reason rather than a boolean because the answer is the useful half: a
    Super Admin told "no" wants to know whether to wait for the consultation to happen or
    to finish collecting the fee.
    """
    # A Past Data trial client is a copy on the Past Data branch, kept out of every org-wide
    # figure (see past_data_live.py). Sent to a working branch it would be a patient there
    # that no dashboard counts.
    if lead.get(PAST_MOVE_FIELD):
        return "This client was moved from Past Data to try it out on the Past Data branch. It stays there until the trial is done."
    stage = lead.get("consultation_stage")
    # No consultation pipeline at all means no consultation has ever been booked — the
    # lead is still purely in the branch's own sales pipeline, which is the first window.
    if stage is None:
        return None
    if stage == TRANSFERABLE_AT_PHYSIO_ASSIGN:
        return None
    if stage in (BRANCH_CANCELLED_STAGE, "Cancel"):
        return "This consultation was cancelled — there is nothing to transfer."
    if stage == "Consultation Completed":
        return "This patient's consultation is closed. Transferring a finished record would move its revenue without moving any work."
    return (
        f"A patient at '{stage}' cannot be transferred. "
        "A booked consultation is held on this branch's Head Physio calendar and a "
        "part-collected Treatment Fee would leave its installments split across two "
        "branches. Transfer before the consultation is booked, or once treatment has "
        "started at Physio Assign."
    )


@router.get("/leads/{lead_id}/appointment-card")
async def v3_lead_appointment_card(lead_id: str, _: V3UserOut = Depends(v3_current_user)):
    """The appointment confirmation for this lead, in the shape the card is drawn from.

    The confirmation used to exist for exactly as long as the dialog that raised it: the
    branch booked a slot, the card appeared, and dismissing it was the end of it. A patient
    who lost the WhatsApp message had nothing that could be sent again, and the branch's
    only recourse was to reschedule the appointment onto itself to make a new one.

    So the record answers for it instead. Every field the card prints is already on the
    appointment row -- it was written there at booking precisely so the share link could
    render it server-side (see _appt_card_html) -- and this returns the same set in the
    keys the React card reads.

    The live consultation booking only. A cancelled row keeps its share link working, and
    deliberately does not answer here: the branch reissuing a confirmation is handing a
    patient the sheet for an appointment that is still happening, and there is no such
    sheet for one that was called off.
    """
    lead = await v3_col("leads").find_one(
        {"id": lead_id}, {"_id": 0, "id": 1, "branch_id": 1, "name": 1, "patient_number": 1, "phone": 1},
    )
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    appt = await v3_col("appointments").find_one(
        {"lead_id": lead_id, "appt_kind": "consultation", "status": "new_appointment"},
        {"_id": 0},
        sort=[("updated_at", -1)],
    )
    if not appt:
        raise HTTPException(status_code=404, detail="No appointment is booked for this patient")

    branch = await v3_col("branches").find_one(
        {"id": appt.get("branch_id") or lead.get("branch_id")},
        {"_id": 0, "branch_name": 1, "address": 1, "map_location": 1,
         "admin_name": 1, "admin_phone": 1, "phone": 1},
    ) or {}

    return {
        # Bookings taken before ref_no existed carry none. The card prints "Ref —" rather
        # than refusing to open: the appointment is real and the reference is the one
        # thing on the sheet that is only ever quoted back to the branch itself.
        "refNo": appt.get("ref_no") or "—",
        "shareToken": appt.get("share_token") or "",
        # Off the lead, not off the appointment: the appointment's copy of the name was
        # frozen at booking, and a patient whose name was corrected since should be
        # handed a sheet with the corrected one on it.
        "patient": lead.get("name") or appt.get("patient_name") or "—",
        "patientNo": lead.get("patient_number") or "—",
        "phone": lead.get("phone") or "—",
        "branch": branch.get("branch_name") or "",
        "branchAddress": branch.get("address") or "",
        "mapLocation": branch.get("map_location") or "",
        "adminName": branch.get("admin_name") or "",
        "adminPhone": branch.get("admin_phone") or "",
        "branchPhone": branch.get("phone") or "",
        "date": appt.get("appointment_date") or "",
        "time": appt.get("appointment_time") or "",
        "duration": appt.get("duration") or 30,
        "headPhysio": appt.get("doctor_name") or "—",
        "meetLink": (appt.get("meet_link") or "").strip(),
        "notes": appt.get("notes") or "",
        "bookedBy": appt.get("created_by") or "Branch Admin",
        "houseVisit": appt.get("visit_type") == "home",
        "packageName": appt.get("visit_package_name") or "",
        "packagePrice": appt.get("visit_package_price"),
    }


class V3BranchTransferInput(BaseModel):
    to_branch_id: str
    reason: Optional[str] = ""


def _transfer_scope_error(lead: dict, user: V3UserOut) -> Optional[str]:
    """Why this user may not transfer this particular patient, or None if they may.

    Transfers were Super Admin's alone until branches asked to move their own patients
    themselves. What a Branch Admin has been given is authority over the branch they run,
    not over transfers in general — so they may move a patient out of their own branch, and
    may not reach into another branch's list to move one out of there. Super Admin keeps
    both, which is why this answers None for every role that is not a Branch Admin.

    Phrased as the reason rather than a boolean for the same purpose as
    _transfer_block_reason above: the half worth reading is which of the two it was.
    """
    if not is_branch_admin_role(user.role):
        return None
    if not user.branch_id:
        return "Your account is not attached to a branch yet, so there is nothing to transfer out of."
    if lead.get("branch_id") != user.branch_id:
        return "This patient is not at your branch. Only the branch a patient is at can transfer them out."
    return None


@router.get("/leads/{lead_id}/transfer-eligibility")
async def v3_transfer_eligibility(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "branch_admin")),
):
    """Whether this patient can be transferred, and what moving them would cost.

    Asked before the act rather than discovered during it: the days about to be released,
    the money about to stay behind, and every payment the patient has made are all things
    the person pressing the button should read first, not in the toast afterwards.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    out_of_scope = _transfer_scope_error(lead, user)
    if out_of_scope:
        raise HTTPException(status_code=403, detail=out_of_scope)

    reason = _transfer_block_reason(lead)
    completed = await v3_col("sessions").count_documents({"lead_id": lead_id, "status": "completed"})
    booked = await v3_col("sessions").count_documents({"lead_id": lead_id, "status": {"$ne": "completed"}})
    return {
        "lead_id": lead_id,
        "can_transfer": reason is None,
        "blocked_reason": reason,
        "consultation_stage": lead.get("consultation_stage"),
        "branch_id": lead.get("branch_id"),
        "patient_number": lead.get("patient_number"),
        # What the move would do, in the two currencies that matter.
        "sessions_completed": completed,
        "sessions_to_release": booked,
        "current_physio_name": lead.get("assigned_physio_name") or "",
        "revenue_staying_behind": round(
            (lead.get("consultation_fee") or 0) + (lead.get("package_paid") or 0), 2
        ),
        "transfers_so_far": len(lead.get("branch_transfer_history") or []),
        # Every receipt this patient holds, newest first, each against the branch that took
        # it. The figure above is a total and a total is what gets argued about after the
        # move — this is the itemised answer to "which of these are ours", readable before
        # it. A patient transferred before has rows here belonging to their old branch.
        "payment_history": await lead_payment_history(lead),
        # Where they have been, so the reader can see that a row attributed to another
        # branch is a previous transfer rather than an error.
        "transfer_history": lead.get("branch_transfer_history") or [],
    }


@router.get("/branch-admin/transfer-records/{branch_id}")
async def v3_branch_transfer_records(
    branch_id: str,
    _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Every branch transfer this branch was party to, newest first — the Records tab.

    One row per move rather than per patient: a patient sent out and later sent back is two
    things that happened, and the list is a record of transfers. Both directions are here,
    marked, because "who did we lose" and "who did we receive" are read off the same list.
    """
    leads = await v3_col("leads").find(
        {"$or": [
            {"branch_transfer_history.from_branch_id": branch_id},
            {"branch_transfer_history.to_branch_id": branch_id},
        ]},
        {"_id": 0},
    ).to_list(5000)

    current_ids = {l.get("branch_id") for l in leads if l.get("branch_id")}
    branch_names = {
        b["id"]: b.get("branch_name") or ""
        async for b in v3_col("branches").find({"id": {"$in": list(current_ids)}}, {"_id": 0, "id": 1, "branch_name": 1})
    }

    records = []
    for lead in leads:
        history = lead.get("branch_transfer_history") or []
        splits = lead.get("revenue_branch_splits") or []
        for index, move in enumerate(history):
            if branch_id not in (move.get("from_branch_id"), move.get("to_branch_id")):
                continue
            # The money pinned to the old branch is written in the same update as the move,
            # with the same timestamp, so that is how the two are paired back up.
            split = next((s for s in splits if s.get("until") == move.get("at")), {}) or {}
            records.append({
                "id": f"{lead.get('id')}:{index}",
                "direction": "outgoing" if move.get("from_branch_id") == branch_id else "incoming",
                **move,
                "collected_before_transfer": round(
                    (split.get("consultation_fee") or 0) + (split.get("package_paid") or 0), 2
                ),
                "lead": {
                    "id": lead.get("id"),
                    "patient_number": lead.get("patient_number") or "",
                    "name": lead.get("name") or "",
                    "phone": lead.get("phone") or "",
                    "email": lead.get("email") or "",
                    "vertical": lead.get("vertical") or "",
                    "source_type": lead.get("source_type") or "",
                    "stage": lead.get("stage") or "",
                    "branch_stage": lead.get("branch_stage") or "",
                    "consultation_stage": lead.get("consultation_stage") or "",
                    "current_branch_id": lead.get("branch_id") or "",
                    "current_branch_name": branch_names.get(lead.get("branch_id"), ""),
                    "assigned_physio_name": lead.get("assigned_physio_name") or "",
                    "consultation_fee": lead.get("consultation_fee") or 0,
                    "package_name": lead.get("package_name") or "",
                    "package_paid": lead.get("package_paid") or 0,
                    "treatment_fee_paid": lead.get("treatment_fee_paid") or 0,
                    "notes": lead.get("notes") or "",
                    "created_at": lead.get("created_at") or "",
                    "transfer_history": history,
                },
            })
    records.sort(key=lambda r: r.get("at") or "", reverse=True)
    return {"records": records}


@router.post("/leads/{lead_id}/transfer-branch")
async def v3_transfer_branch(
    lead_id: str,
    payload: V3BranchTransferInput,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "branch_admin")),
):
    """Move a patient to another branch.

    Super Admin anywhere; a Branch Admin only out of the branch they run (see
    _transfer_scope_error). The money already collected stays with the branch that took it
    whoever presses the button — which is what makes a Branch Admin pressing it safe, since
    moving a patient on cannot move that branch's own revenue with them. What it does do is
    put the record in front of the person who already knows why the patient is leaving.

    Three things happen, and only one of them is the branch_id:

    1. The money already collected is pinned to the branch that collected it. Finance reads
       revenue off the fee fields on the lead grouped by the lead's branch, so a bare
       branch_id flip would take every rupee this patient ever paid out of one branch's
       books and put it in another's — including months already reported on. The split
       recorded here is what keeps a closed month closed; see _branch_revenue_rows.

    2. Treatment days still to come are released. The physio delivering them works at the
       branch being left, so those days cannot survive the move. Days already completed
       stay exactly where they are, under the physio who ran them, and still count toward
       the course — the patient arrives at the new branch part-way through, at Physio
       Assign, with the rest of their course to book there.

    3. The lead lands on a stage that exists at the destination. A branch running its own
       leads opens at a different stage from one fed by Pre-Sales, so a lead moved without
       this can arrive at a stage its new board does not draw and vanish from both.

    The Patient Number does not change. It carries a branch code, so it stops describing
    where the patient is — but it is printed on every receipt already issued and is how
    the patient is looked up, and breaking that to keep a prefix honest is the worse trade.
    The transfer history is what says where they have been.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    out_of_scope = _transfer_scope_error(lead, user)
    if out_of_scope:
        raise HTTPException(status_code=403, detail=out_of_scope)

    from_branch_id = lead.get("branch_id")
    if not from_branch_id:
        raise HTTPException(status_code=400, detail="This lead does not belong to a branch yet")
    if payload.to_branch_id == from_branch_id:
        raise HTTPException(status_code=400, detail="This patient is already at that branch")

    destination = await v3_col("branches").find_one({"id": payload.to_branch_id}, {"_id": 0})
    if not destination:
        raise HTTPException(status_code=404, detail="Destination branch not found")
    origin = await v3_col("branches").find_one({"id": from_branch_id}, {"_id": 0}) or {}

    blocked = _transfer_block_reason(lead)
    if blocked:
        raise HTTPException(status_code=400, detail=blocked)

    now = now_iso()
    at_treatment = lead.get("consultation_stage") == TRANSFERABLE_AT_PHYSIO_ASSIGN

    # 1. Pin what this branch has already taken. Recorded even when it is zero: "nothing was
    #    collected here" is a fact the finance split needs as much as a number, and a lead
    #    transferred before any fee would otherwise leave a gap that reads as untransferred.
    split = {
        "branch_id": from_branch_id,
        "branch_name": origin.get("branch_name") or "",
        "consultation_fee": round(lead.get("consultation_fee") or 0, 2),
        "package_paid": round(lead.get("package_paid") or 0, 2),
        "until": now,
    }

    # 2. Release what has not been delivered. Completed days are untouched — they happened,
    #    at the old branch, under the physio who ran them, and the course counts them still.
    released = 0
    physio_updates: dict = {}
    handover: dict = {}
    if at_treatment:
        released = (await v3_col("sessions").delete_many(
            {"lead_id": lead_id, "status": {"$ne": "completed"}},
        )).deleted_count
        # The outgoing physio's spell closes here for the same reason a reassignment closes
        # one: their completed days stay on the record and the Physio Assign card at the new
        # branch has to be able to show where they left off. Written directly rather than
        # through _physio_handover, which lives on the other router and answers a slightly
        # different question — there is no incoming physio to name yet.
        if lead.get("assigned_physio_id"):
            handover = {"physio_assignment_history": {
                "physio_id": lead["assigned_physio_id"],
                "physio_name": lead.get("assigned_physio_name") or "",
                "assigned_at": lead.get("physio_assigned_at"),
                "ended_at": now,
                "replaced_by_id": "",
                "handed_over_by": user.full_name,
                "handed_over_by_role": user.role,
                "ended_by_branch_transfer": True,
            }}
        # Cleared, not carried. The patient arrives needing a physio at the branch they
        # arrived at, and a name left here would be a physio on another branch's floor.
        physio_updates = {
            "assigned_physio_id": None,
            "assigned_physio_name": None,
            "physio_assigned_at": None,
        }

    # 3. A stage the destination's board actually draws.
    updates = {
        "branch_id": payload.to_branch_id,
        "updated_at": now,
        **physio_updates,
    }
    if not at_treatment:
        updates["branch_stage"] = await first_branch_stage_for_branch(
            payload.to_branch_id, "New Appointment",
        )

    await v3_col("leads").update_one({"id": lead_id}, {
        "$set": updates,
        "$push": {
            "revenue_branch_splits": split,
            "branch_transfer_history": {
                "from_branch_id": from_branch_id,
                "from_branch_name": origin.get("branch_name") or "",
                "to_branch_id": payload.to_branch_id,
                "to_branch_name": destination.get("branch_name") or "",
                "at": now,
                "consultation_stage": lead.get("consultation_stage"),
                "sessions_released": released,
                "reason": (payload.reason or "").strip(),
                "transferred_by": user.full_name,
                "transferred_by_role": user.role,
            },
            **handover,
        },
    })

    detail = f"Transferred from {origin.get('branch_name') or 'branch'} to {destination.get('branch_name') or 'branch'}"
    if released:
        detail += f" · {released} booked treatment day{'s' if released != 1 else ''} released"
    if at_treatment and lead.get("assigned_physio_name"):
        detail += f" · left {lead['assigned_physio_name']}'s care"
    if (payload.reason or "").strip():
        detail += f" · {payload.reason.strip()}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "branch_transferred",
        "details": detail,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })

    updated = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    return {
        "message": f"Transferred to {destination.get('branch_name') or 'the destination branch'}",
        "lead": V3LeadOut(**updated).model_dump(),
        "sessions_released": released,
        "sessions_kept": await v3_col("sessions").count_documents({"lead_id": lead_id, "status": "completed"}),
        "revenue_left_behind": round(split["consultation_fee"] + split["package_paid"], 2),
    }
