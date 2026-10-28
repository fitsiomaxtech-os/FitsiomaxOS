from fastapi import APIRouter, HTTPException, Depends, Header
from typing import List, Optional, Dict
import uuid
import os

import login_guard
from database import v2_col
from utils import now_iso
from security import verify_password, hash_password, is_hashed
from deps import v2_current_user, v2_require_roles
from schemas.v2 import (
    V2UserOut, V2LoginRequest, V2LoginResponse,
    V2ServiceCreate, V2ServiceOut,
    V2DoctorCreate, V2DoctorSlotsInput, V2DoctorOut,
    V2LeadCreate, V2LeadImportInput, V2LeadOut,
    V2AppointmentCreate, V2AppointmentOut,
    V2DashboardSummary,
)
from constants import V2_LOCATIONS

router = APIRouter(prefix="/api/v2")


def v2_map_role(lead_category: str) -> str:
    if lead_category in ["online_fitness", "offline_fitness_gym"]:
        return "online_fitness"
    if lead_category == "online_physio":
        return "online_physio"
    return "offline_physio"


@router.get("/")
async def v2_root():
    return {"message": "FITSIOMAX Appointment API v2"}


@router.post("/auth/login", response_model=V2LoginResponse)
async def v2_login(payload: V2LoginRequest):
    # Same lock as the v3 staff login (login_guard.py), on its own count.
    attempt_key = f"v2:{payload.email.strip().lower()}"
    await login_guard.count_try(attempt_key)
    user = await v2_col("users").find_one({"email": payload.email.lower(), "is_active": True}, {"_id": 0})
    if not user or not verify_password(payload.password, user.get("password", "")):
        await login_guard.refuse(attempt_key, "Invalid credentials")
    await login_guard.clear(attempt_key)

    if not is_hashed(user.get("password", "")):
        await v2_col("users").update_one(
            {"id": user["id"]},
            {"$set": {"password": hash_password(payload.password)}},
        )

    token = str(uuid.uuid4())
    await v2_col("sessions").delete_many({"user_id": user["id"]})
    await v2_col("sessions").insert_one({"token": token, "user_id": user["id"], "created_at": now_iso()})
    public_user = {k: v for k, v in user.items() if k != "password"}
    return V2LoginResponse(token=token, user=V2UserOut(**public_user))


@router.post("/auth/logout")
async def v2_logout(user: V2UserOut = Depends(v2_current_user), authorization: str = Header(...)):
    token = authorization.split(" ", 1)[1].strip()
    await v2_col("sessions").delete_one({"token": token, "user_id": user.id})
    return {"message": "Logged out"}


@router.get("/meta/locations")
async def v2_get_locations(_: V2UserOut = Depends(v2_current_user)):
    return {"locations": V2_LOCATIONS}


@router.get("/services", response_model=List[V2ServiceOut])
async def v2_get_services(_: V2UserOut = Depends(v2_current_user)):
    rows = await v2_col("services").find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [V2ServiceOut(**row) for row in rows]


@router.post("/services", response_model=V2ServiceOut)
async def v2_create_service(payload: V2ServiceCreate, _: V2UserOut = Depends(v2_require_roles("super_admin"))):
    item = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "mode": payload.mode,
        "category": payload.category,
        "created_at": now_iso(),
    }
    await v2_col("services").insert_one(item.copy())
    return V2ServiceOut(**item)


@router.get("/doctors", response_model=List[V2DoctorOut])
async def v2_get_doctors(
    specialty_role: Optional[str] = None,
    location: Optional[str] = None,
    _: V2UserOut = Depends(v2_current_user),
):
    query: Dict[str, object] = {}
    if specialty_role:
        query["specialty_role"] = specialty_role
    if location:
        query["location"] = location
    rows = await v2_col("doctors").find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [V2DoctorOut(**row) for row in rows]


@router.post("/doctors", response_model=V2DoctorOut)
async def v2_create_doctor(payload: V2DoctorCreate, _: V2UserOut = Depends(v2_require_roles("super_admin"))):
    item = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name.strip(),
        "specialty_role": payload.specialty_role,
        "location": payload.location,
        "slots": [],
        "created_at": now_iso(),
    }
    await v2_col("doctors").insert_one(item.copy())
    return V2DoctorOut(**item)


@router.post("/doctors/{doctor_id}/slots", response_model=V2DoctorOut)
async def v2_create_doctor_slots(doctor_id: str, payload: V2DoctorSlotsInput, _: V2UserOut = Depends(v2_require_roles("super_admin"))):
    doctor = await v2_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    all_slots = sorted(set(doctor.get("slots", [])).union(set(payload.slots)))
    await v2_col("doctors").update_one({"id": doctor_id}, {"$set": {"slots": all_slots}})
    updated = await v2_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    return V2DoctorOut(**updated)


@router.get("/doctors/{doctor_id}/availability")
async def v2_get_doctor_availability(doctor_id: str, _: V2UserOut = Depends(v2_current_user)):
    doctor = await v2_col("doctors").find_one({"id": doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    booked_rows = await v2_col("appointments").find({"doctor_id": doctor_id, "status": "booked"}, {"_id": 0, "slot_time": 1}).to_list(1000)
    booked = {row["slot_time"] for row in booked_rows}
    grouped: Dict[str, List[Dict[str, object]]] = {}
    for slot in doctor.get("slots", []):
        key = slot.split("T")[0] if "T" in slot else slot[:10]
        grouped.setdefault(key, []).append({"slot": slot, "booked": slot in booked})
    return {"doctor_id": doctor_id, "doctor_name": doctor["full_name"], "grouped_slots": grouped}


@router.get("/leads", response_model=List[V2LeadOut])
async def v2_get_leads(
    assigned_role: Optional[str] = None,
    source: Optional[str] = None,
    search: Optional[str] = None,
    user: V2UserOut = Depends(v2_current_user),
):
    query: Dict[str, object] = {}
    if user.role != "super_admin":
        query["assigned_role"] = user.role
    elif assigned_role:
        query["assigned_role"] = assigned_role
    if source:
        query["source"] = source
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"phone": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
        ]
    rows = await v2_col("leads").find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [V2LeadOut(**row) for row in rows]


@router.post("/leads", response_model=V2LeadOut)
async def v2_add_lead(payload: V2LeadCreate, user: V2UserOut = Depends(v2_current_user)):
    assigned_role = v2_map_role(payload.lead_category)
    if user.role != "super_admin" and user.role != assigned_role:
        raise HTTPException(status_code=403, detail="Not allowed for this lead category")
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "phone": payload.phone.strip(),
        "email": payload.email,
        "lead_category": payload.lead_category,
        "assigned_role": assigned_role,
        "source": payload.source,
        "preferred_location": payload.preferred_location,
        "service_interest": payload.service_interest,
        "status": "new_lead",
        "notes": payload.notes,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await v2_col("leads").insert_one(doc.copy())
    return V2LeadOut(**doc)


@router.post("/leads/import")
async def v2_import(payload: V2LeadImportInput, _: V2UserOut = Depends(v2_require_roles("super_admin"))):
    imported = 0
    skipped = 0
    for row in payload.rows:
        exists = await v2_col("leads").find_one({"phone": row.phone}, {"_id": 0})
        if exists:
            skipped += 1
            continue
        doc = {
            "id": str(uuid.uuid4()),
            "name": row.name,
            "phone": row.phone,
            "email": row.email,
            "lead_category": row.lead_category,
            "assigned_role": v2_map_role(row.lead_category),
            "source": "google_sheet" if payload.source == "google_sheet" else "manual_csv",
            "preferred_location": row.preferred_location,
            "service_interest": row.service_interest,
            "status": "new_lead",
            "notes": row.notes,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        await v2_col("leads").insert_one(doc.copy())
        imported += 1
    return {"imported": imported, "skipped": skipped}


@router.get("/appointments", response_model=List[V2AppointmentOut])
async def v2_get_appointments(
    doctor_id: Optional[str] = None,
    user: V2UserOut = Depends(v2_current_user),
):
    query: Dict[str, object] = {}
    if doctor_id:
        query["doctor_id"] = doctor_id
    if user.role != "super_admin":
        query["pipeline_role"] = user.role
    rows = await v2_col("appointments").find(query, {"_id": 0}).sort("slot_time", 1).to_list(1000)
    return [V2AppointmentOut(**row) for row in rows]


@router.post("/appointments", response_model=V2AppointmentOut)
async def v2_add_appointment(payload: V2AppointmentCreate, user: V2UserOut = Depends(v2_current_user)):
    doctor = await v2_col("doctors").find_one({"id": payload.doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    if payload.slot_time not in doctor.get("slots", []):
        raise HTTPException(status_code=400, detail="Slot not in doctor calendar")
    clash = await v2_col("appointments").find_one({"doctor_id": payload.doctor_id, "slot_time": payload.slot_time, "status": "booked"}, {"_id": 0})
    if clash:
        raise HTTPException(status_code=409, detail="Slot already booked")

    lead_doc = None
    patient_name = payload.patient_name
    pipeline_role = user.role
    if payload.lead_id:
        lead_doc = await v2_col("leads").find_one({"id": payload.lead_id}, {"_id": 0})
        if not lead_doc:
            raise HTTPException(status_code=404, detail="Lead not found")
        patient_name = lead_doc["name"]
        pipeline_role = lead_doc["assigned_role"]
    if not patient_name:
        raise HTTPException(status_code=400, detail="Patient name is required")
    if user.role != "super_admin" and user.role != pipeline_role:
        raise HTTPException(status_code=403, detail="Cannot book outside your flow")

    service_name = None
    if payload.service_id:
        service_doc = await v2_col("services").find_one({"id": payload.service_id}, {"_id": 0})
        service_name = service_doc["name"] if service_doc else None

    appointment = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "patient_name": patient_name,
        "doctor_id": doctor["id"],
        "doctor_name": doctor["full_name"],
        "slot_time": payload.slot_time,
        "location": payload.location or doctor.get("location"),
        "service_id": payload.service_id,
        "service_name": service_name,
        "pipeline_role": pipeline_role,
        "created_by_role": user.role,
        "status": "booked",
        "notes": payload.notes,
        "created_at": now_iso(),
    }
    await v2_col("appointments").insert_one(appointment.copy())
    if lead_doc:
        await v2_col("leads").update_one({"id": lead_doc["id"]}, {"$set": {"status": "appointment_booked", "updated_at": now_iso()}})
    return V2AppointmentOut(**appointment)


@router.get("/dashboard/summary", response_model=V2DashboardSummary)
async def v2_get_summary(user: V2UserOut = Depends(v2_current_user)):
    lead_query: Dict[str, object] = {}
    appt_query: Dict[str, object] = {}
    if user.role != "super_admin":
        lead_query["assigned_role"] = user.role
        appt_query["pipeline_role"] = user.role

    metrics = {
        "total_leads": await v2_col("leads").count_documents(lead_query),
        "new_leads": await v2_col("leads").count_documents({**lead_query, "status": "new_lead"}),
        "appointments_booked": await v2_col("appointments").count_documents(appt_query),
    }
    split = {
        "online_fitness": await v2_col("leads").count_documents({**lead_query, "assigned_role": "online_fitness"}),
        "online_physio": await v2_col("leads").count_documents({**lead_query, "assigned_role": "online_physio"}),
        "offline_physio": await v2_col("leads").count_documents({**lead_query, "assigned_role": "offline_physio"}),
    }
    return V2DashboardSummary(metrics=metrics, lead_split=split)


@router.get("/sheets/status")
async def v2_sheet_status(_: V2UserOut = Depends(v2_current_user)):
    return {
        "mode": "csv_manual_first",
        "csv_import_ready": True,
        "oauth_ready": bool(os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET")),
        "message": "CSV/manual import enabled. Google OAuth can be added in next phase.",
    }
