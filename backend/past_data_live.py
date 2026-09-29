"""Past Data's "Move to live": one sheet's past clients put on the Past Data branch as live
leads, to see how the old books read as the OS's own clients before any of it goes further.

A trial, and built as one. The leads land on the branch the sheet was imported into -- the
Past Data branch, which works no patients -- and nowhere else:

  - each carries the move's id in PAST_MOVE_FIELD, and every org-wide read of `leads` leaves
    those out (utils.without_past_moves): the dashboards, the lead lists, Pre-Sales' backlog
    and its Distribute button, and the importers' duplicate-phone check, which would
    otherwise drop a returning patient's new enquiry as already known;
  - no fee, package, installment, session or activity is written, so finance, the payment
    reminders and every revenue figure have nothing to read, and nobody is messaged;
  - vertical is offline physiotherapy and no physio is assigned, so neither the online arm's
    board nor any physio's picks them up;
  - they cannot be transferred to a working branch (_transfer_block_reason in
    routers/v3_branch_admin.py) -- that is the step after the trial, not part of it.

What the sheet knew about each person that a lead has no field for -- the Excel ID, the
courses, what was paid and owed -- goes into extra_fields, which the lead popup lists, so
the live card can be read against the Past Data row it came from.

One person, one lead. A sheet does not repeat anybody (the parsers group their own rows), but
two sheets can hold the same person -- the register and a branch's revenue sheet -- so a
client already moved from another sheet, by phone and name, is skipped rather than added
twice. People already live at a working branch are added all the same: this is a copy to
look at, and the card says where the real one is.

Take back removes exactly one move's leads, and whatever was done to them since, by the id
they carry. Disconnecting or replacing the sheet takes its move back with it.
"""
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

import lead_purge
from database import v3_col
from past_revenue import NO_NAME, _one_person
from stage_utils import first_branch_stage_for_branch
from utils import PAST_MOVE_FIELD, generate_patient_number, without_past_moves

SOURCE_TAB = "Past Data"
SOURCE_TYPE = "past_data"
VERTICAL = "offline_physiotherapy"
# The fallback first_branch_stage_for_branch is handed, as v3_manual_lead hands it.
ENTRY_FALLBACK = "New Appointment"
# How many working-branch records one card names under "Also in the OS".
ELSEWHERE_SHOWN = 3
CHUNK = 500

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


def past_fields(client: dict, sheet_label: str, elsewhere: List[str]) -> Dict[str, str]:
    """What the sheet said about this person, as the lead popup's rows. Blank ones left out."""
    services = ", ".join(client.get("services") or [])
    count = client.get("treatments_count") or 0
    fields = {
        "Past Data ID": client.get("excel_id") or "",
        "Past Data sheet": sheet_label,
        "Registered": _day(client.get("registration_date") or ""),
        "Treatments": f"{count}{' · ' + services if services else ''}" if count else "",
        "Last treatment": _day(client.get("last_treatment_date") or ""),
        "Latest status": client.get("latest_status") or "",
        "Paid in Excel": _rs(client.get("paid_total")) if client.get("paid_total") else "",
        "Owed when saved": _rs(client.get("outstanding_total")) if client.get("outstanding_total") else "",
        "Source in Excel": client.get("source") or "",
        "Location": ", ".join(client.get("locations") or []),
        "Needs a look": (f"{client['issue_count']} flagged on import -- see Past Data"
                         if client.get("issue_count") else ""),
        "Also in the OS": "; ".join(elsewhere[:ELSEWHERE_SHOWN]) + (
            f" and {len(elsewhere) - ELSEWHERE_SHOWN} more" if len(elsewhere) > ELSEWHERE_SHOWN else ""),
    }
    return {k: v for k, v in fields.items() if v}


def lead_for(
    client: dict, *, sheet_label: str, branch_id: str, branch_stage: str, patient_number: Optional[str],
    move_id: str, batch_id: str, elsewhere: List[str], now_iso: str,
) -> dict:
    """One past client as a lead on the Past Data branch -- the shape v3_manual_lead writes,
    plus the three fields that tie it back to its move, its sheet and its Past Data row."""
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
        "branch_stage": branch_stage,
        "notes": client.get("notes") or "",
        "extra_fields": past_fields(client, sheet_label, elsewhere),
        "alternative_phone": "",
        "address": "",
        "city": "",
        "state": "",
        "location": "",
        "department": "",
        "condition": "",
        "months_of_pain": None,
        "age": client.get("age"),
        "gender": client.get("gender") or "",
        "occupation": "",
        "expected_consultation_date": "",
        "lead_data": {},
        # When they first came, and when they were last seen: the board lists by updated_at,
        # so the people the sheet saw most recently come first.
        "created_at": created,
        "updated_at": _stamp(last) if last else created,
        PAST_MOVE_FIELD: move_id,
        "past_batch_id": batch_id,
        "past_client_id": client.get("id"),
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


async def plan(batch: dict) -> dict:
    """What moving this sheet would do, without doing it: who would be added, who is skipped
    as already moved from another sheet, and how many are already live at a working branch."""
    clients = await v3_col("past_clients").find({"batch_id": batch["id"]}, {"_id": 0}).to_list(100000)
    moved = await v3_col("leads").find(
        {"branch_id": batch["branch_id"], PAST_MOVE_FIELD: {"$ne": None}},
        {"_id": 0, "name": 1, "phone_normalized": 1, PAST_MOVE_FIELD: 1},
    ).to_list(100000)
    # A sheet's own earlier move is not "another sheet" -- but a sheet is only ever moved
    # once at a time, so anything on the branch now is another sheet's.
    by_phone: Dict[str, List[dict]] = {}
    for lead in moved:
        if lead.get("phone_normalized"):
            by_phone.setdefault(lead["phone_normalized"], []).append(lead)
    adding, skipped = [], []
    for c in clients:
        twin = next((m for m in by_phone.get(c.get("phone_normalized") or "", []) if _same_person(c, m)), None)
        (skipped if twin else adding).append(c)
    elsewhere = await _elsewhere(adding)
    return {
        "clients": adding,
        "skipped": skipped,
        "elsewhere": elsewhere,
        "live_elsewhere": sum(1 for c in adding if elsewhere.get(c.get("phone_normalized") or "")),
        "branch_stage": await first_branch_stage_for_branch(batch["branch_id"], ENTRY_FALLBACK),
    }


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
            leads.append(lead_for(
                c, sheet_label=label, branch_id=batch["branch_id"], branch_stage=p["branch_stage"],
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
            "branch_stage": p["branch_stage"],
        }
        await v3_col("past_imports").update_one({"id": batch["id"]}, {"$set": {"live_move": record}})
        return record
    except Exception:
        await v3_col("leads").delete_many({PAST_MOVE_FIELD: move_id})
        await v3_col("past_imports").update_one({"id": batch["id"], "live_move.id": move_id}, {"$set": {"live_move": None}})
        raise


async def take_back(batch: dict, taken_back_by: str) -> int:
    """Remove this sheet's moved leads, and everything written against them since -- the
    stage moves, remarks and follow-ups of the trial. Returns how many leads went. The sheet
    itself is untouched and can be moved again."""
    record = batch.get("live_move") or {}
    if not record.get("id"):
        return 0
    ids = await v3_col("leads").distinct("id", {PAST_MOVE_FIELD: record["id"]})
    result = await v3_col("leads").delete_many({PAST_MOVE_FIELD: record["id"]})
    await lead_purge.delete_lead_trail(ids)
    await v3_col("past_imports").update_one(
        {"id": batch["id"]},
        {"$set": {"live_move": None},
         "$push": {"live_move_history": {
             **record, "taken_back_at": datetime.now(timezone.utc).isoformat(), "taken_back_by": taken_back_by,
         }}},
    )
    return result.deleted_count
