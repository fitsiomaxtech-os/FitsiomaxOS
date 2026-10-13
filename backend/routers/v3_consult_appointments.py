"""Consultation Appointment Scheduling — fully managed by the Branch Admin from
the Branch Admin > Calendar > Schedule view.

The Branch Admin books a consultation between a client and a Head Physio,
choosing date/time/physio. Availability is derived from the branch's working
hours (weekly_hours) and holidays configured in Super Admin > Branch Management;
double-booking a Head Physio is prevented. Appointments live in the shared
`appointments` collection (status="new_appointment", appt_kind="consultation")
so they automatically surface on the Head Physio's own calendar too.
"""
from fastapi import APIRouter, HTTPException, Depends
from typing import Optional
from pydantic import BaseModel
from datetime import datetime
import re
import uuid

from database import v3_col
from utils import now_iso, normalize_slot_time, active_doctor_query
from deps import v3_require_roles
from branch_calendar import day_status
from consult_duration_rule import duration_rule_enabled
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3")

_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]  # Mon=0 .. Sun=6


class ConsultApptCreate(BaseModel):
    patient_name: str
    doctor_id: str
    date: str   # YYYY-MM-DD
    time: str   # HH:MM
    duration: Optional[int] = 30
    notes: Optional[str] = None
    lead_id: Optional[str] = None


class ConsultApptUpdate(BaseModel):
    patient_name: Optional[str] = None
    doctor_id: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    duration: Optional[int] = None
    notes: Optional[str] = None


def _day_key(date_str: str) -> Optional[str]:
    try:
        return _DAY_KEYS[datetime.strptime(date_str, "%Y-%m-%d").weekday()]
    except Exception:
        return None


async def _get_branch(branch_id: str) -> dict:
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    return branch


async def _get_doctor(doctor_id: str) -> dict:
    # Any branch expert can be chosen for the appointment (matches the Branch Leads
    # "Appointment Date & Time" flow, which lists all available experts).
    doc = await v3_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Expert not found")
    return doc


def _hours_for(branch: dict, date_str: str):
    """(is_open, open_time, close_time, reason). reason is set only when closed.

    Read off branch_calendar.day_status, which the Monthly Calendar writes, so a day marked
    Leave there is closed here and a normally-closed weekday marked Working is open."""
    if _day_key(date_str) is None:
        return (False, None, None, "Invalid date")
    day = day_status(branch, date_str)
    if day["status"] == "leave":
        if day["source"] == "weekly":
            return (False, None, None, "The branch is closed on this day")
        return (False, None, None, "This date is a branch leave day" + (f" ({day['note']})" if day["note"] else ""))
    return (True, day["open"], day["close"], None)


async def _validate_slot(branch: dict, date_str: str, time_str: str, doctor_id: str, exclude_id: Optional[str] = None) -> str:
    is_open, open_t, close_t, reason = _hours_for(branch, date_str)
    if not is_open:
        raise HTTPException(status_code=400, detail=reason or "The branch is closed on this date")
    if not (open_t <= time_str < close_t):
        raise HTTPException(status_code=400, detail=f"Time must be within the branch working hours ({open_t}–{close_t})")
    slot = normalize_slot_time(f"{date_str}T{time_str}")
    # Switched off in Developer Access, the Consultant can hold several patients at one time.
    if not await duration_rule_enabled():
        return slot
    q = {"doctor_id": doctor_id, "slot_time": slot, "status": "new_appointment"}
    if exclude_id:
        q["id"] = {"$ne": exclude_id}
    if await v3_col("appointments").find_one(q, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="This CONSULTANT is already booked at that time")
    return slot


@router.get("/branch-admin/{branch_id}/consult-appointments")
async def list_consult_appointments(branch_id: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    rows = await v3_col("appointments").find(
        {"branch_id": branch_id, "appt_kind": "consultation", "status": {"$ne": "cancelled"}},
        {"_id": 0},
    ).sort("slot_time", 1).to_list(5000)
    return {"appointments": rows}


def _slots_between(open_t: str, close_t: str) -> list:
    """30-minute start times in [open, close)."""
    def to_min(t):
        h, m = t.split(":")
        return int(h) * 60 + int(m)
    start, end = to_min(open_t), to_min(close_t)
    return [f"{x // 60:02d}:{x % 60:02d}" for x in range(start, end, 30)]


@router.get("/branch-admin/{branch_id}/consult-availability")
async def consult_availability(branch_id: str, date: str, doctor_id: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Available 30-minute start times for one Head Physio on a date, derived from the
    branch working hours minus times that Head Physio is already booked."""
    branch = await _get_branch(branch_id)
    is_open, open_t, close_t, reason = _hours_for(branch, date)
    if not is_open:
        return {"open": False, "reason": reason, "slots": []}
    booked_rows = await v3_col("appointments").find(
        {"doctor_id": doctor_id, "status": "new_appointment", "slot_time": {"$regex": f"^{date}T"}},
        {"_id": 0, "slot_time": 1},
    ).to_list(500)
    booked = {r["slot_time"].split("T")[1] for r in booked_rows if "T" in (r.get("slot_time") or "")}
    blocking = await duration_rule_enabled()
    return {
        "open": True,
        "open_time": open_t,
        "close_time": close_t,
        "slots": [s for s in _slots_between(open_t, close_t) if not (blocking and s in booked)],
        "booked": sorted(booked),
    }


@router.get("/branch-admin/{branch_id}/consult-day")
async def consult_day(branch_id: str, date: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Drives the Consultation Calendar booking flow for a selected date:
    1) validate the date against the branch working calendar (weekly hours + holidays);
    2) if open, load every Head Physio assigned to the branch and, per physio, return
       the branch working-hour slots minus the 30-min slots they are already booked for
       on that date. If closed/holiday, returns open=False with a reason and no physios."""
    branch = await _get_branch(branch_id)
    is_open, open_t, close_t, reason = _hours_for(branch, date)
    if not is_open:
        return {"open": False, "reason": reason, "open_time": None, "close_time": None, "head_physios": []}

    # Head Physios are org-wide: they take consultations for every branch, so this
    # never narrows by branch_id.
    hps = await v3_col("doctors").find(active_doctor_query({"profile_type": "head_physio"}), {"_id": 0}).to_list(200)
    doctor_ids = [d["id"] for d in hps]

    booked_by_doc: dict = {}
    if doctor_ids:
        booked_rows = await v3_col("appointments").find(
            {"doctor_id": {"$in": doctor_ids}, "status": "new_appointment", "slot_time": {"$regex": f"^{date}T"}},
            {"_id": 0, "doctor_id": 1, "slot_time": 1},
        ).to_list(2000)
        for r in booked_rows:
            st = r.get("slot_time") or ""
            if "T" in st:
                booked_by_doc.setdefault(r["doctor_id"], set()).add(st.split("T")[1])

    blocking = await duration_rule_enabled()
    head_physios = []
    for d in hps:
        booked = booked_by_doc.get(d["id"], set())
        # Availability is the Head Physio's OWN calendar slots (set in the Consultant
        # Calendar) for this date, minus the ones already booked — not the whole
        # branch working day.
        day_times = sorted({
            s.split("T")[1] for s in (d.get("slots") or [])
            if isinstance(s, str) and s.startswith(f"{date}T")
        })
        head_physios.append({
            "id": d["id"],
            "full_name": d["full_name"],
            "specialization": d.get("specialization", ""),
            "available_slots": [t for t in day_times if not (blocking and t in booked)],
            "booked_slots": sorted(booked),
        })
    return {"open": True, "reason": None, "open_time": open_t, "close_time": close_t, "head_physios": head_physios}


@router.get("/branch-admin/{branch_id}/consultant-slots")
async def consultant_slots(branch_id: str, doctor_id: str, date: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev", "head_physio"))):
    """One CONSULTANT's day, hour by hour, with who is sitting in each hour.

    Drives the consultant popup on My Consultation: every slot the consultant published for
    the date, plus any hour something was booked into without one, each carrying the
    patients in it and the two marks a branch puts on a patient — VIP and needs attention —
    so the desk sees who to treat especially well before opening anyone.

    Bookings at every branch are returned, not only `branch_id`'s. A consultant is org-wide
    and an hour taken at another branch is still an hour they are not free; each booking
    names its branch so the caller can say where it is.
    """
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    doctor = await _get_doctor(doctor_id)
    prefix = {"$regex": f"^{re.escape(date)}T"}

    appt_rows = await v3_col("appointments").find(
        {"doctor_id": doctor_id, "status": "new_appointment", "slot_time": prefix},
        {"_id": 0, "id": 1, "slot_time": 1, "lead_id": 1, "lead_name": 1, "patient_name": 1,
         "branch_id": 1, "rescheduled": 1, "rescheduled_from": 1},
    ).to_list(500)
    # A review dispatched into one of the consultant's slots holds that hour exactly as a
    # consultation does; one sent without a time was never placed and has no hour to show.
    review_rows = await v3_col("reviews").find(
        {"head_physio_id": doctor_id, "review_date": date, "review_time": {"$nin": ["", None]}},
        {"_id": 0, "id": 1, "lead_id": 1, "lead_name": 1, "review_time": 1, "status": 1, "branch_id": 1},
    ).to_list(500)

    lead_ids = list({r["lead_id"] for r in (*appt_rows, *review_rows) if r.get("lead_id")})
    leads = await v3_col("leads").find(
        {"id": {"$in": lead_ids}},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "patient_number": 1, "branch_id": 1,
         "is_vip": 1, "needs_attention": 1},
    ).to_list(len(lead_ids) or 1)
    lead_map = {l["id"]: l for l in leads}

    branch_ids = {r.get("branch_id") or lead_map.get(r.get("lead_id"), {}).get("branch_id") for r in (*appt_rows, *review_rows)}
    branch_ids.discard(None)
    branches = await v3_col("branches").find(
        {"id": {"$in": list(branch_ids)}}, {"_id": 0, "id": 1, "branch_name": 1},
    ).to_list(len(branch_ids) or 1)
    branch_names = {b["id"]: b.get("branch_name", "") for b in branches}

    def booking(row, kind, time_str):
        lead = lead_map.get(row.get("lead_id"), {})
        b_id = row.get("branch_id") or lead.get("branch_id") or ""
        return {
            "id": row.get("id"),
            "kind": kind,
            "time": time_str,
            "lead_id": row.get("lead_id"),
            "patient_name": lead.get("name") or row.get("patient_name") or row.get("lead_name") or "Unknown",
            "phone": lead.get("phone", ""),
            "patient_number": lead.get("patient_number", ""),
            "is_vip": bool(lead.get("is_vip")),
            "needs_attention": bool(lead.get("needs_attention")),
            "branch_id": b_id,
            "branch_name": branch_names.get(b_id, ""),
            "rescheduled": bool(row.get("rescheduled")),
            "rescheduled_from": row.get("rescheduled_from") or "",
            "status": row.get("status", ""),
        }

    by_time: dict = {}
    for r in appt_rows:
        t = (r.get("slot_time") or "").split("T")[1] if "T" in (r.get("slot_time") or "") else ""
        if t:
            by_time.setdefault(t, []).append(booking(r, "consultation", t))
    for r in review_rows:
        t = r["review_time"]
        by_time.setdefault(t, []).append(booking(r, "review", t))

    published = {
        s.split("T")[1] for s in (doctor.get("slots") or [])
        if isinstance(s, str) and s.startswith(f"{date}T")
    }
    slots = [
        {"time": t, "published": t in published, "bookings": by_time.get(t, [])}
        for t in sorted(published | set(by_time.keys()))
    ]
    all_bookings = [b for s in slots for b in s["bookings"]]
    return {
        "doctor_id": doctor["id"],
        "doctor_name": doctor.get("full_name", ""),
        "specialization": doctor.get("specialization", ""),
        "date": date,
        "slots": slots,
        "summary": {
            "slots": len(slots),
            "booked": sum(1 for s in slots if s["bookings"]),
            "free": sum(1 for s in slots if not s["bookings"]),
            "vip": sum(1 for b in all_bookings if b["is_vip"]),
            "attention": sum(1 for b in all_bookings if b["needs_attention"]),
        },
    }


@router.post("/branch-admin/{branch_id}/consult-appointments")
async def create_consult_appointment(branch_id: str, payload: ConsultApptCreate, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    if not payload.patient_name.strip():
        raise HTTPException(status_code=400, detail="Patient name is required")
    branch = await _get_branch(branch_id)
    doc = await _get_doctor(payload.doctor_id)
    slot = await _validate_slot(branch, payload.date, payload.time, payload.doctor_id)
    appt = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        "doctor_id": payload.doctor_id,
        "doctor_name": doc["full_name"],
        "lead_id": payload.lead_id,
        "lead_name": payload.patient_name.strip(),   # hp calendar reads lead_name
        "patient_name": payload.patient_name.strip(),
        "appointment_date": payload.date,
        "appointment_time": payload.time,
        "slot_time": slot,
        "duration": payload.duration or 30,
        "notes": (payload.notes or "").strip(),
        "status": "new_appointment",
        "appt_kind": "consultation",
        "created_by": user.full_name,
        # Written alongside created_by so every appointment carries the same audit pair
        # regardless of which screen booked it.
        "created_by_role": user.role,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await v3_col("appointments").insert_one(appt.copy())
    return appt


@router.patch("/branch-admin/consult-appointments/{appt_id}")
async def update_consult_appointment(appt_id: str, payload: ConsultApptUpdate, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    appt = await v3_col("appointments").find_one({"id": appt_id, "appt_kind": "consultation"}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")
    branch = await _get_branch(appt["branch_id"])
    updates = {"updated_at": now_iso()}
    if payload.date or payload.time or payload.doctor_id:
        new_date = payload.date or appt["appointment_date"]
        new_time = payload.time or appt["appointment_time"]
        new_doctor = payload.doctor_id or appt["doctor_id"]
        slot = await _validate_slot(branch, new_date, new_time, new_doctor, exclude_id=appt_id)
        updates.update({"appointment_date": new_date, "appointment_time": new_time, "slot_time": slot, "doctor_id": new_doctor})
        if payload.doctor_id and payload.doctor_id != appt["doctor_id"]:
            updates["doctor_name"] = (await _get_doctor(payload.doctor_id))["full_name"]
    if payload.patient_name is not None and payload.patient_name.strip():
        updates["patient_name"] = payload.patient_name.strip()
        updates["lead_name"] = payload.patient_name.strip()
    if payload.notes is not None:
        updates["notes"] = payload.notes.strip()
    if payload.duration:
        updates["duration"] = payload.duration
    await v3_col("appointments").update_one({"id": appt_id}, {"$set": updates})
    return await v3_col("appointments").find_one({"id": appt_id}, {"_id": 0})


@router.post("/branch-admin/consult-appointments/{appt_id}/cancel")
async def cancel_consult_appointment(appt_id: str, _: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    appt = await v3_col("appointments").find_one({"id": appt_id, "appt_kind": "consultation"}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")
    await v3_col("appointments").update_one({"id": appt_id}, {"$set": {"status": "cancelled", "updated_at": now_iso()}})
    return {"message": "Appointment cancelled", "id": appt_id}
