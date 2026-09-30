"""Past Data's "Move to live": one sheet's past clients put on the Past Data branch as live
leads, to see how the old books read as the OS's own clients before any of it goes further.

A trial, and built as one. The leads land on the branch the sheet was imported into -- the
Past Data branch, which works no patients -- and nowhere else:

  - each carries the move's id in PAST_MOVE_FIELD, and every org-wide read of `leads` leaves
    those out (utils.without_past_moves): the dashboards, the lead lists, Pre-Sales' backlog
    and its Distribute button, and the importers' duplicate-phone check, which would
    otherwise drop a returning patient's new enquiry as already known;
  - no fee, package, installment, session or activity is written, so the payment trail, the
    approvals queue, the drawer, the payment reminders and every org-wide revenue figure have
    nothing to read, and nobody is messaged. The Excel payments are shown to this branch's
    Accountant tab by reading them off the sheet (see "the Accountant" below). Money the desk
    collects on a sheet's balance afterwards is the one exception, and a deliberate one: it
    is taken today, so it is recorded as any collection is (see collected_against);
  - vertical is offline physiotherapy and no physio is assigned, so neither the online arm's
    board nor any physio's picks them up;
  - they cannot be transferred to a working branch (_transfer_block_reason in
    routers/v3_branch_admin.py) -- that is the step after the trial, not part of it.

Each goes onto the stage the sheet last put them at -- see "where each one goes" -- and what
the sheet knew that a lead has no field for (the Excel ID, the courses, what was paid and
owed) goes into extra_fields, which the lead popup lists.

One person, one lead. A sheet does not repeat anybody (the parsers group their own rows), but
two sheets can hold the same person -- the register and a branch's revenue sheet -- so a
client already moved from another sheet, by phone and name, is not added twice: their row is
attached to the lead already there (`past_client_ids`), so their payments from both sheets
are read against the one person. People already live at a working branch are added all the
same: this is a copy to look at, and the card says where the real one is.

Take back removes exactly one move's leads, and whatever was done to them since, by the id
they carry. Disconnecting or replacing the sheet takes its move back with it.
"""
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional

import lead_purge
import past_os
from constants import (
    SALES_STAGE_ROLE_APPOINTMENT, SALES_STAGE_ROLE_CANCELLED, SALES_STAGE_ROLE_FALLBACKS,
    SALES_STAGE_ROLE_FOLLOW_UP, SALES_STAGE_ROLE_NOT_A_PROSPECT, SALES_STAGE_ROLE_PORTFOLIO,
    SALES_STAGE_ROLE_RNR, V3_CONSULTATION_STAGES,
)
from database import v3_col
from past_revenue import NO_NAME, _one_person
from stage_utils import branch_stage_names_for_branch, first_branch_stage_for_branch, sales_arm_for
from utils import PAST_MOVE_FIELD, generate_patient_number, without_past_moves

SOURCE_TAB = "Past Data"
SOURCE_TYPE = "past_data"
VERTICAL = "offline_physiotherapy"
# The fallback first_branch_stage_for_branch is handed, as v3_manual_lead hands it.
ENTRY_FALLBACK = "New Appointment"
# How many working-branch records one card names under "Also in the OS".
ELSEWHERE_SHOWN = 3
CHUNK = 500
# Who the Accountant tab says took an Excel payment: the sheet, not a person on the OS.
FROM_EXCEL = "Past Data (Excel)"

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _stamp(day: str) -> str:
    """A sheet's date as a lead's timestamp: noon in the clinic, so the day reads the same
    in UTC as it does in India and lands in the right bucket whichever clock reads it."""
    return f"{day}T06:30:00+00:00"


def _day(value: str) -> str:
    """"2026-03-02" as "02 Mar 2026" -- extra_fields is shown as written."""
    try:
        y, m, d = (int(p) for p in value.split("-"))
        return f"{d:02d} {MONTHS[m - 1]} {y}"
    except (ValueError, IndexError, AttributeError):
        return value or ""


def _when(value: str) -> str:
    """"2026-09-04 11:30" as "04 Sep 2026 11:30", and a date alone as _day writes it."""
    on, _, at = (value or "").partition(" ")
    return f"{_day(on)} {at}".strip() if on else ""


def _rs(amount) -> str:
    """Rupees grouped the Indian way, as the Past Data screen writes them: Rs.1,34,38,570."""
    value = round(float(amount or 0), 2)
    whole, _, paise = f"{abs(value):.2f}".partition(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    text = ",".join(groups + [tail]) if groups else tail
    return f"{'-' if value < 0 else ''}Rs.{text}{'' if paise == '00' else '.' + paise}"


def _same_person(a: dict, b: dict) -> bool:
    return (bool(a.get("phone_normalized")) and a.get("phone_normalized") == b.get("phone_normalized")
            and _one_person(a.get("name") or "", b.get("name") or ""))


# ------------------------------------------------------------------ where each one goes
#
# The stage a past client is put on, off what the sheet last said about them: their newest
# course's status in the register, or -- in a revenue sheet, which has no status column --
# what their newest payment was for. The first rule that fits:
#
#   Dropped                       -> Cancel
#   Completed                     -> Completed      the course closed, as a physio closes one
#   Referred Out                  -> Completed      seen, and sent elsewhere: nothing left here
#   On Hold                       -> Follow Up      a call to make
#   no course at all              -> Leads          registered, never enrolled
#   a consultation and no more    -> Fee Collected  paid to be seen, no course bought
#   any other course              -> Physio Assign  in treatment
#
# As the sheet read on the day it was last saved. The register left patients "Active" long
# after their last visit, so Physio Assign here says what the sheet said, not who is in the
# clinic this week -- the card's Last treatment row says which.
#
# An OS Data sheet (past_os.py) needs none of this: its Current Stage is already one of the
# OS's own stage names, and the client goes onto that stage, "os:" in front of it here so it
# cannot be taken for one of the register's words above (see _os_placement).

LEADS = "Leads"
FOLLOW_UP = "Follow Up"
FEE_COLLECTED = "Fee Collected"
IN_TREATMENT = "Physio Assign"
COMPLETED = "Completed"
REFERRED_OUT = "Referred Out"
CANCELLED = "Cancel"
# The pill each one is read under on the board, in the order a patient moves through them.
PILLS = {LEADS: LEADS, FOLLOW_UP: FOLLOW_UP, FEE_COLLECTED: FEE_COLLECTED, IN_TREATMENT: IN_TREATMENT,
         COMPLETED: COMPLETED, REFERRED_OUT: COMPLETED, CANCELLED: CANCELLED}
STAGE_ORDER = (LEADS, FOLLOW_UP, FEE_COLLECTED, IN_TREATMENT, COMPLETED, REFERRED_OUT, CANCELLED)

OS_PREFIX = "os:"
OS_STAGE_ORDER = tuple(OS_PREFIX + s for s in past_os.STAGES)
# The Branch-pipeline stages an OS Data client can stand on, by the role the stage carries --
# the name is Super Admin's to change (see constants.py, "Stage roles").
OS_BRANCH_ROLES = {
    "RNR": SALES_STAGE_ROLE_RNR,
    "Follow Up": SALES_STAGE_ROLE_FOLLOW_UP,
    "Portfolio": SALES_STAGE_ROLE_PORTFOLIO,
    "Not a prospect": SALES_STAGE_ROLE_NOT_A_PROSPECT,
    "Cancelled": SALES_STAGE_ROLE_CANCELLED,
}


def pill_for(stage: str) -> str:
    return stage[len(OS_PREFIX):] if stage.startswith(OS_PREFIX) else PILLS.get(stage, stage)

# A course that was a consultation and nothing else, however the desk wrote it: the
# register's "Consultation", "Diet Consultation" and "Diet Chart", and a revenue sheet's
# "Cons", "Adv-cons", "online diet cons". "Cons+physio session" is a course.
_CONSULT_ONLY = re.compile(r"^(online )?(diet )?(adv(ance)? ?-? ?)?cons(ultation)?$|^diet chart$")


def consultation_only(service: str) -> bool:
    return bool(_CONSULT_ONLY.match(" ".join((service or "").lower().split())))


def stage_for(client: dict, latest: Optional[dict]) -> str:
    """Which of the stages above this client goes onto. `latest` is their newest course."""
    if client.get("current_stage"):
        return OS_PREFIX + client["current_stage"]
    status = " ".join((client.get("latest_status") or "").lower().split())
    if status == "dropped":
        return CANCELLED
    if status == "completed":
        return COMPLETED
    if status == "referred out":
        return REFERRED_OUT
    if status == "on hold":
        return FOLLOW_UP
    if not latest:
        return LEADS
    if consultation_only(latest.get("service") or ""):
        return FEE_COLLECTED
    return IN_TREATMENT


async def stage_names(branch_id: str) -> dict:
    """What this branch's stages are called now. By role and off the live lists, since
    Pipeline Stage Management can rename any of them."""
    arm = await sales_arm_for(branch_id=branch_id)

    async def by_role(role: str) -> str:
        row = await v3_col("pipeline_stages").find_one(
            {"type": "sales", "role": role, "$or": [{"arm": arm}, {"arm": {"$exists": False}}, {"arm": None}]},
            {"_id": 0, "name": 1},
        )
        return row["name"] if row else SALES_STAGE_ROLE_FALLBACKS[role]

    consultation = {r["name"] for r in await v3_col("pipeline_stages").find(
        {"type": "consultation"}, {"_id": 0, "name": 1}).to_list(200)}

    # For an OS Data client: the stage carrying each role, only where this branch's board has
    # it. RNR, say, is a Branch-Admin-controlled branch's alone, and a lead put on a stage its
    # board does not show would be on no pill at all.
    visible = set(await branch_stage_names_for_branch(branch_id, []))
    roles = {}
    for role in OS_BRANCH_ROLES.values():
        rows = await v3_col("pipeline_stages").find({"type": "sales", "role": role}, {"_id": 0, "name": 1}).to_list(20)
        roles[role] = next((r["name"] for r in rows if r["name"] in visible), None)
    return {
        "entry": await first_branch_stage_for_branch(branch_id, ENTRY_FALLBACK),
        "follow_up": await by_role(SALES_STAGE_ROLE_FOLLOW_UP),
        "appointment": await by_role(SALES_STAGE_ROLE_APPOINTMENT),
        "cancelled": await by_role(SALES_STAGE_ROLE_CANCELLED),
        "consultation": consultation or set(V3_CONSULTATION_STAGES),
        "roles": roles,
    }


def placement(stage: str, names: dict) -> dict:
    """The fields a lead is read off to stand on `stage` -- the same ones the OS's own
    actions write on the way there.

    Past the Branch Leads half, a patient's booked appointment is behind them, so the Branch
    stage is the appointment one and the consultation pipeline says where they are. Completed
    is never written as a stage -- the boards read it off the lead (isCourseComplete in
    leadStage.js) -- so a closed course is Physio Assign with the physio's Complete on it,
    and a patient sent elsewhere is a closed consultation, as a Consultation Only one is.
    A consultation stage this install no longer has leaves the lead at Leads rather than on
    a stage no pill shows.
    """
    if stage.startswith(OS_PREFIX):
        return _os_placement(stage[len(OS_PREFIX):], names)
    at_entry = {"branch_stage": names["entry"], "consultation_stage": None, "physio_stage": None}
    consultation = names["consultation"]
    if stage == LEADS:
        return at_entry
    if stage == FOLLOW_UP:
        return {**at_entry, "branch_stage": names["follow_up"]}
    if stage == CANCELLED:
        return {"branch_stage": names["cancelled"], "physio_stage": None,
                "consultation_stage": CANCELLED if CANCELLED in consultation else None}
    if stage == REFERRED_OUT:
        return {"branch_stage": names["appointment"], "consultation_stage": "Consultation Completed", "physio_stage": None}
    written = FEE_COLLECTED if stage == FEE_COLLECTED else IN_TREATMENT
    if written not in consultation:
        return at_entry
    return {"branch_stage": names["appointment"], "consultation_stage": written,
            "physio_stage": "Complete" if stage == COMPLETED else None}


def _os_placement(name: str, names: dict) -> dict:
    """An OS Data client's Current Stage as the fields a lead stands on it by.

    Leads is the branch's opening stage. RNR, Follow Up, Portfolio, Not a prospect and
    Cancelled are Branch stages, found by role on this branch's own board. Every other name is
    a consultation stage -- Consultation Booked through Diet Chart, and Cancel -- with the
    booked appointment behind it, as a booking leaves a lead. Completed is a closed course,
    as the register's is. A stage this branch has no pill for leaves the client at Leads.
    """
    at_entry = {"branch_stage": names["entry"], "consultation_stage": None, "physio_stage": None}
    if name == LEADS:
        return at_entry
    if name in OS_BRANCH_ROLES:
        stage = names.get("roles", {}).get(OS_BRANCH_ROLES[name])
        return {**at_entry, "branch_stage": stage} if stage else at_entry
    if name == COMPLETED:
        return placement(COMPLETED, names)
    if name not in names["consultation"]:
        return at_entry
    return {"branch_stage": names["appointment"], "consultation_stage": name, "physio_stage": None}


def _latest(courses: List[dict]) -> Optional[dict]:
    return max(courses, key=lambda t: (t.get("start_date") or "", t.get("excel_id") or ""), default=None)


async def _courses_by_client(query: dict) -> Dict[str, List[dict]]:
    found: Dict[str, List[dict]] = {}
    for t in await v3_col("past_treatments").find(
        query, {"_id": 0, "client_id": 1, "service": 1, "start_date": 1, "excel_id": 1},
    ).to_list(100000):
        found.setdefault(t["client_id"], []).append(t)
    return found


# ------------------------------------------------------------------------ the lead itself

def past_fields(client: dict, sheet_label: str, elsewhere: List[str]) -> Dict[str, str]:
    """What the sheet said about this person, as the lead popup's rows. Blank ones left out.

    A custom sheet's columns kept as they were written (past_custom.py) come after the
    sheet's own rows, under their own headers -- Company, Country -- save where a header is
    one of the rows here already and that row has something to say."""
    services = ", ".join(client.get("services") or [])
    count = client.get("treatments_count") or 0
    journey = client.get("journey") or {}
    sessions = (client.get("sessions_completed") or 0, client.get("sessions_upcoming") or 0)
    fields = {
        "Past Data ID": client.get("excel_id") or "",
        "Past Data sheet": sheet_label,
        "Registered": _day(client.get("registration_date") or ""),
        "Treatments": f"{count}{' · ' + services if services else ''}" if count else "",
        "Last treatment": _day(client.get("last_treatment_date") or ""),
        "Latest status": client.get("latest_status") or "",
        # An OS Data sheet's own (past_os.py): what a lead has no field for.
        "Branch in Excel": client.get("branch_as_written") or "",
        "Consultant in Excel": client.get("consultant") or "",
        "Appointment": _when(journey.get("appointment_at") or ""),
        "Sessions": f"{sessions[0]} completed · {sessions[1]} upcoming" if any(sessions) else "",
        "Reviews": str(client["reviews_count"]) if client.get("reviews_count") else "",
        "Dropped reason": client.get("dropped_reason") or "",
        "Paid in Excel": _rs(client.get("paid_total")) if client.get("paid_total") else "",
        "Owed when saved": _rs(client.get("outstanding_total")) if client.get("outstanding_total") else "",
        "Source in Excel": client.get("source") or "",
        "Location": ", ".join(client.get("locations") or []),
        "Date of birth": _day(client.get("dob") or ""),
    }
    for label, value in (client.get("extra") or {}).items():
        if not fields.get(label):
            fields[label] = value
    fields.update({
        "Needs a look": (f"{client['issue_count']} flagged on import -- see Past Data"
                         if client.get("issue_count") else ""),
        "Also in the OS": "; ".join(elsewhere[:ELSEWHERE_SHOWN]) + (
            f" and {len(elsewhere) - ELSEWHERE_SHOWN} more" if len(elsewhere) > ELSEWHERE_SHOWN else ""),
    })
    return {k: v for k, v in fields.items() if v}


def lead_for(
    client: dict, *, sheet_label: str, branch_id: str, stage: str, stage_fields: dict,
    patient_number: Optional[str], move_id: str, batch_id: str, elsewhere: List[str], now_iso: str,
) -> dict:
    """One past client as a lead on the Past Data branch -- the shape v3_manual_lead writes,
    on the stage the sheet puts them at, plus the fields that tie it back to its move, its
    sheet and its Past Data rows."""
    first = client.get("registration_date") or client.get("first_treatment_date") or ""
    last = client.get("last_treatment_date") or first
    created = _stamp(first) if first else now_iso
    name = client.get("name") or ""
    return {
        "id": str(uuid.uuid4()),
        "patient_number": patient_number,
        "name": "" if name == NO_NAME else name,
        "phone": client.get("phone") or "",
        "phone_normalized": client.get("phone_normalized") or "",
        "email": client.get("email") or "",
        "vertical": VERTICAL,
        "source_tab": SOURCE_TAB,
        "source_type": SOURCE_TYPE,
        "stage": "New Leads",
        "branch_id": branch_id,
        **stage_fields,
        "notes": client.get("notes") or "",
        "extra_fields": past_fields(client, sheet_label, elsewhere),
        # Blank for the register and the revenue sheets, which have no such columns; an OS
        # Data sheet was laid out on these very fields, and a custom sheet's columns picked
        # onto them.
        "alternative_phone": client.get("alternative_phone") or "",
        "address": client.get("address") or "",
        "city": client.get("city") or "",
        "state": client.get("state") or "",
        "location": client.get("location") or "",
        "department": client.get("department") or "",
        "condition": client.get("condition") or "",
        "months_of_pain": client.get("months_of_pain"),
        "age": client.get("age"),
        "gender": client.get("gender") or "",
        "occupation": client.get("occupation") or "",
        "expected_consultation_date": "",
        "lead_data": {},
        # When they first came, and when they were last seen: the board lists by updated_at,
        # so the people the sheet saw most recently come first.
        "created_at": created,
        "updated_at": _stamp(last) if last else created,
        PAST_MOVE_FIELD: move_id,
        "past_batch_id": batch_id,
        "past_client_id": client.get("id"),
        # Every Past Data row that is this person -- this one, and the same person in another
        # sheet moved after it (_attach_twins). The Accountant reads their payments off these.
        "past_client_ids": [client.get("id")],
        # Where the sheet put them, kept so the placement can be told from a stage the branch
        # has moved them to since.
        "past_stage": stage,
    }


async def _elsewhere(clients: List[dict]) -> Dict[str, List[str]]:
    """Phone -> the working-branch records already on it, as "Branch · patient number"."""
    phones = sorted({c["phone_normalized"] for c in clients if c.get("phone_normalized")})
    rows: List[dict] = []
    for start in range(0, len(phones), 1000):
        rows += await v3_col("leads").find(
            without_past_moves({"phone_normalized": {"$in": phones[start:start + 1000]}}),
            {"_id": 0, "phone_normalized": 1, "branch_id": 1, "patient_number": 1, "name": 1},
        ).to_list(20000)
    names = {
        b["id"]: b.get("branch_name") or ""
        for b in await v3_col("branches").find(
            {"id": {"$in": list({r.get("branch_id") for r in rows if r.get("branch_id")})}},
            {"_id": 0, "id": 1, "branch_name": 1},
        ).to_list(500)
    }
    found: Dict[str, List[str]] = {}
    for r in rows:
        where = names.get(r.get("branch_id")) or "No branch"
        found.setdefault(r["phone_normalized"], []).append(
            " · ".join(p for p in (where, r.get("patient_number") or r.get("name") or "") if p))
    return found


async def _moved_on_branch(branch_id: str) -> Dict[str, List[dict]]:
    """Phone -> the trial leads on this branch holding it."""
    by_phone: Dict[str, List[dict]] = {}
    for lead in await v3_col("leads").find(
        {"branch_id": branch_id, PAST_MOVE_FIELD: {"$ne": None}},
        {"_id": 0, "id": 1, "name": 1, "phone_normalized": 1, "past_client_ids": 1},
    ).to_list(100000):
        if lead.get("phone_normalized"):
            by_phone.setdefault(lead["phone_normalized"], []).append(lead)
    return by_phone


async def plan(batch: dict) -> dict:
    """What moving this sheet would do, without doing it: who would be added and on which
    stage, who is skipped as already moved from another sheet, and how many are already live
    at a working branch."""
    clients = await v3_col("past_clients").find({"batch_id": batch["id"]}, {"_id": 0}).to_list(100000)
    by_phone = await _moved_on_branch(batch["branch_id"])
    adding, skipped = [], []
    for c in clients:
        twin = next((m for m in by_phone.get(c.get("phone_normalized") or "", []) if _same_person(c, m)), None)
        (skipped if twin else adding).append(c)
    courses = await _courses_by_client({"batch_id": batch["id"]})
    stages = {c["id"]: stage_for(c, _latest(courses.get(c["id"], []))) for c in adding}
    counts = {s: sum(1 for v in stages.values() if v == s) for s in STAGE_ORDER + OS_STAGE_ORDER}
    elsewhere = await _elsewhere(adding)
    return {
        "clients": adding,
        "skipped": skipped,
        "stages": stages,
        # `note` says what in the sheet put them there, where the dialog cannot work it out
        # from the stage (an OS Data sheet's Current Stage).
        "stage_counts": [
            {"stage": s, "pill": pill_for(s), "count": n,
             **({"note": "Current Stage in the sheet"} if s.startswith(OS_PREFIX) else {})}
            for s, n in counts.items() if n
        ],
        "elsewhere": elsewhere,
        "live_elsewhere": sum(1 for c in adding if elsewhere.get(c.get("phone_normalized") or "")),
        "names": await stage_names(batch["branch_id"]),
    }


async def _attach_twins(branch_id: str) -> int:
    """Hang every live sheet's client who was skipped as already moved onto the lead that is
    them, so both sheets' payments are read against one person. Asked after every move, since
    either sheet can be the one moved second. Returns how many were attached."""
    live = [b["id"] for b in await v3_col("past_imports").find(
        {"branch_id": branch_id, "removed_at": None, "live_move.status": "live"}, {"_id": 0, "id": 1}).to_list(200)]
    if not live:
        return 0
    by_phone = await _moved_on_branch(branch_id)
    attached_ids = {cid for leads in by_phone.values() for lead in leads for cid in (lead.get("past_client_ids") or [])}
    attached = 0
    for c in await v3_col("past_clients").find(
        {"batch_id": {"$in": live}, "phone_normalized": {"$in": list(by_phone)}},
        {"_id": 0, "id": 1, "name": 1, "phone_normalized": 1},
    ).to_list(100000):
        if c["id"] in attached_ids:
            continue
        twin = next((m for m in by_phone.get(c["phone_normalized"], []) if _same_person(c, m)), None)
        if twin:
            await v3_col("leads").update_one({"id": twin["id"]}, {"$addToSet": {"past_client_ids": c["id"]}})
            attached += 1
    return attached


async def move(batch: dict, moved_by: str, label: str) -> dict:
    """Put this sheet's clients on its branch as live leads. Returns the move's record.

    Claimed on the sheet's own row first, so two presses of the button cannot both run. Every
    lead is written before the record says done; a failure half way takes back whatever
    went in and frees the sheet to be moved again.
    """
    now = datetime.now(timezone.utc)
    move_id = "PDM-" + now.strftime("%y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    claimed = await v3_col("past_imports").update_one(
        {"id": batch["id"], "removed_at": None, "live_move": None},
        {"$set": {"live_move": {"id": move_id, "status": "moving", "moved_at": now.isoformat(), "moved_by": moved_by}}},
    )
    if not claimed.modified_count:
        return {}
    try:
        p = await plan(batch)
        leads = []
        for c in p["clients"]:
            first = c.get("registration_date") or c.get("first_treatment_date") or ""
            stage = p["stages"][c["id"]]
            leads.append(lead_for(
                c, sheet_label=label, branch_id=batch["branch_id"], stage=stage, stage_fields=placement(stage, p["names"]),
                # Numbered for the day they first came, as a backfill numbers them.
                patient_number=await generate_patient_number(batch["branch_id"], _stamp(first) if first else None),
                move_id=move_id, batch_id=batch["id"],
                elsewhere=p["elsewhere"].get(c.get("phone_normalized") or "", []), now_iso=now.isoformat(),
            ))
        for start in range(0, len(leads), CHUNK):
            await v3_col("leads").insert_many([dict(lead) for lead in leads[start:start + CHUNK]])
        record = {
            "id": move_id,
            "status": "live",
            "moved_at": now.isoformat(),
            "moved_by": moved_by,
            "leads": len(leads),
            "skipped": len(p["skipped"]),
            "live_elsewhere": p["live_elsewhere"],
            "stage_counts": p["stage_counts"],
        }
        await v3_col("past_imports").update_one({"id": batch["id"]}, {"$set": {"live_move": record}})
    except Exception:
        await v3_col("leads").delete_many({PAST_MOVE_FIELD: move_id})
        await v3_col("past_imports").update_one({"id": batch["id"], "live_move.id": move_id}, {"$set": {"live_move": None}})
        raise
    await _attach_twins(batch["branch_id"])
    return record


async def take_back(batch: dict, taken_back_by: str) -> int:
    """Remove this sheet's moved leads, and everything written against them since -- the
    stage moves, remarks and follow-ups of the trial. Its clients attached to another sheet's
    leads come off those too. Returns how many leads went. The sheet itself is untouched and
    can be moved again."""
    record = batch.get("live_move") or {}
    if not record.get("id"):
        return 0
    ids = await v3_col("leads").distinct("id", {PAST_MOVE_FIELD: record["id"]})
    result = await v3_col("leads").delete_many({PAST_MOVE_FIELD: record["id"]})
    await lead_purge.delete_lead_trail(ids)
    own = await v3_col("past_clients").distinct("id", {"batch_id": batch["id"]})
    if own:
        await v3_col("leads").update_many(
            {"branch_id": batch.get("branch_id"), "past_client_ids": {"$in": own}},
            {"$pull": {"past_client_ids": {"$in": own}}},
        )
    await v3_col("past_imports").update_one(
        {"id": batch["id"]},
        {"$set": {"live_move": None},
         "$push": {"live_move_history": {
             **record, "taken_back_at": datetime.now(timezone.utc).isoformat(), "taken_back_by": taken_back_by,
         }}},
    )
    return result.deleted_count


async def place_moved_leads() -> int:
    """Put the clients the first Move to live left at Leads onto the stage their sheet says.

    That first version put every one of them at the branch's opening stage. Run at startup,
    and does nothing once each lead carries its past_stage: only a lead without one is
    looked at, and of those only one still exactly where the move left it -- at the opening
    stage with no consultation stage -- is moved. One somebody has already moved on the
    board keeps where they put it. Returns how many were placed.
    """
    leads = await v3_col("leads").find(
        {PAST_MOVE_FIELD: {"$ne": None}, "past_stage": None},
        {"_id": 0, "id": 1, "branch_id": 1, "branch_stage": 1, "consultation_stage": 1, "past_client_id": 1},
    ).to_list(100000)
    if not leads:
        return 0
    client_ids = [lead["past_client_id"] for lead in leads if lead.get("past_client_id")]
    clients = {c["id"]: c for c in await v3_col("past_clients").find(
        {"id": {"$in": client_ids}}, {"_id": 0, "id": 1, "latest_status": 1}).to_list(100000)}
    courses = await _courses_by_client({"client_id": {"$in": client_ids}})
    names_by_branch: Dict[str, dict] = {}
    placed = 0
    for lead in leads:
        bid = lead.get("branch_id")
        if bid not in names_by_branch:
            names_by_branch[bid] = await stage_names(bid)
        names = names_by_branch[bid]
        client = clients.get(lead.get("past_client_id"))
        fields = {"past_client_ids": [lead["past_client_id"]] if lead.get("past_client_id") else []}
        untouched = lead.get("branch_stage") == names["entry"] and not lead.get("consultation_stage")
        if client and untouched:
            stage = stage_for(client, _latest(courses.get(client["id"], [])))
            fields.update(placement(stage, names), past_stage=stage)
            placed += 1
        else:
            # Worked on since, or its Past Data row is gone: left where it is, and marked so
            # it is not looked at again.
            fields["past_stage"] = ""
        await v3_col("leads").update_one({"id": lead["id"]}, {"$set": fields})
    for bid in names_by_branch:
        await _attach_twins(bid)
    return placed


# --------------------------------------------------------------------------- the Accountant
#
# The Excel payments of this branch's trial clients, as the Accountant tab's rows. Read off
# past_payments on every request rather than written into the payment trail: written, they
# would be ₹1.5 Cr of collections in the approvals queue, the drawer, the closing count and
# every org-wide revenue figure. Read, they reach exactly one place -- a finance read scoped
# to this branch (revenue_overview, client_transaction_history in routers/v3_finance.py) --
# and go when the move is taken back. Settled books: each one comes as already approved.

def category_for(service: str) -> str:
    """Which of the Accountant's piles an Excel payment belongs in, off the course it paid for."""
    s = " ".join((service or "").lower().split())
    if "diet" in s:
        return "diet"
    if "rehab" in s:
        return "rehab"
    if "zumba" in s:
        return "zumba"
    if any(w in s for w in ("fitness", "yoga", "hiit", "gym")):
        return "fitness"
    if consultation_only(s):
        return "consultation"
    return "session"


def owed_status(due: str, today: str) -> str:
    """The Outstanding Amount badge, on _lead_outstanding_detail's terms."""
    if due and due < today:
        return "overdue"
    try:
        soon = (date.fromisoformat(today) + timedelta(days=3)).isoformat()
    except ValueError:
        soon = today
    if due and due <= soon:
        return "due_soon"
    return "partial"


async def collected_against(lead_ids: List[str]) -> Dict[str, float]:
    """Excel payment row id -> what the desk has since collected against it on the OS.

    Read off the collections themselves (collect_past_balance in routers/v3_finance.py writes
    `past_allocations` on its activity line) rather than kept on the sheet's row, so there is
    one record of the money, and Return Back -- which deletes a trial lead's activity --
    gives the sheet its balance back without anything else to undo."""
    if not lead_ids:
        return {}
    taken: Dict[str, float] = {}
    lines = await v3_col("lead_activity").find(
        {"lead_id": {"$in": lead_ids}, "past_allocations": {"$exists": True}},
        {"_id": 0, "past_allocations": 1},
    ).to_list(100000)
    for line in lines:
        for a in line.get("past_allocations") or []:
            taken[a["past_payment_id"]] = taken.get(a["past_payment_id"], 0.0) + float(a.get("amount") or 0)
    return taken


async def ledger(lead_query: dict) -> dict:
    """The trial leads `lead_query` picks out (within the trial leads), with their Excel
    payments. `payments` are paid ones, `owed` the installments still unpaid when saved,
    less whatever has been collected against them on the OS since -- `outstanding` on an
    owed row is what is left, `os_collected` what came off it. `collected` is that money
    per lead."""
    leads = await v3_col("leads").find(
        {**lead_query, PAST_MOVE_FIELD: {"$ne": None}},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "email": 1, "patient_number": 1, "branch_id": 1,
         "past_client_ids": 1, "past_client_id": 1},
    ).to_list(100000)
    lead_by_client = {
        cid: lead for lead in leads
        for cid in (lead.get("past_client_ids") or [lead.get("past_client_id")]) if cid
    }
    if not lead_by_client:
        return {"leads": leads, "payments": [], "owed": [], "collected": {}}
    rows = await v3_col("past_payments").find({"client_id": {"$in": list(lead_by_client)}}, {"_id": 0}).to_list(200000)
    services = {t["id"]: t.get("service") or "" for t in await v3_col("past_treatments").find(
        {"client_id": {"$in": list(lead_by_client)}}, {"_id": 0, "id": 1, "service": 1}).to_list(200000)}
    taken = await collected_against([lead["id"] for lead in leads])
    payments, owed, collected = [], [], {}
    for p in rows:
        lead = lead_by_client[p["client_id"]]
        entry = {**p, "lead": lead, "service": services.get(p.get("treatment_id"), "")}
        if p.get("state") == "paid" and (p.get("amount_paid") or 0) > 0:
            payments.append(entry)
        if p.get("state") != "cancelled" and (p.get("outstanding") or 0) > 0:
            off = round(min(taken.get(p["id"], 0.0), float(p["outstanding"])), 2)
            if off:
                collected[lead["id"]] = round(collected.get(lead["id"], 0.0) + off, 2)
            left = round(float(p["outstanding"]) - off, 2)
            if left > 0:
                owed.append({**entry, "outstanding": left, "os_collected": off})
    return {"leads": leads, "payments": payments, "owed": owed, "collected": collected}


def payment_day(p: dict) -> str:
    return p.get("paid_date") or p.get("due_date") or ""


def transaction_row(p: dict, branch_name: str) -> dict:
    """One Excel payment in revenue_overview's transaction shape."""
    lead = p["lead"]
    amount = float(p.get("amount_paid") or 0)
    day = payment_day(p)
    return {
        "id": p["id"],
        "transaction_id": p.get("excel_id") or "",
        "date": _stamp(day) if day else "",
        "branch_name": branch_name,
        "source": category_for(p.get("service")),
        "gross": amount,
        "discount": 0.0,
        "original_amount": None,
        "discount_reason": None,
        "tax": 0.0,
        "net": amount,
        "collected_by": FROM_EXCEL,
        "lead_id": lead["id"],
        "client_name": lead.get("name") or "Unknown",
        "phone": lead.get("phone") or "",
        "patient_number": lead.get("patient_number") or "",
        "payment_mode": p.get("mode") or "unknown",
        "payment_split": [],
        "client_balance": 0.0,
        "payment_paid_amount": None,
        "payment_due_amount": None,
        "payment_due_date": None,
        "session_package_label": p.get("service") or None,
        "session_total": None,
        "session_paid": None,
        "session_due": None,
        "session_status": None,
        "approved": True,
        "approved_by": FROM_EXCEL,
        "approved_at": _stamp(day) if day else "",
        "income_requested": True,
        "income_requested_by": FROM_EXCEL,
        "income_requested_at": _stamp(day) if day else "",
        "past_data": True,
    }


def owed_by_lead(owed: List[dict], today: str) -> Dict[str, dict]:
    """Lead id -> what the sheet said they still owed: the balance and its first due date."""
    out: Dict[str, dict] = {}
    for p in owed:
        row = out.setdefault(p["lead"]["id"], {"lead": p["lead"], "balance": 0.0, "due_date": ""})
        row["balance"] += float(p.get("outstanding") or 0)
        due = p.get("due_date") or ""
        if due and (not row["due_date"] or due < row["due_date"]):
            row["due_date"] = due
    for row in out.values():
        row["balance"] = round(row["balance"], 2)
        row["status"] = owed_status(row["due_date"], today)
    return out
