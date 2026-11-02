from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, List
from datetime import datetime, timezone

from database import v3_col
from utils import now_iso
from stage_utils import log_stage_moves
from deps import v3_current_user, v3_require_roles, is_branch_admin_role
from schemas.v3 import V3UserOut, V3AppointmentOut

router = APIRouter(prefix="/api/v3")


@router.get("/appointments", response_model=List[V3AppointmentOut])
async def v3_get_appointments(view: Optional[str] = None, user: V3UserOut = Depends(v3_current_user)):
    query = {}
    if is_branch_admin_role(user.role) and user.branch_id:
        query["branch_id"] = user.branch_id
    if view == "today":
        today = datetime.now(timezone.utc).date().isoformat()
        query["slot_time"] = {"$regex": f"^{today}"}
    if view == "new":
        query["status"] = "new_appointment"

    rows = await v3_col("appointments").find(query, {"_id": 0}).sort("slot_time", 1).to_list(1000)
    return [V3AppointmentOut(**row) for row in rows]


@router.post("/appointments/{appointment_id}/complete", response_model=V3AppointmentOut)
async def v3_complete_appointment(appointment_id: str, user: V3UserOut = Depends(v3_require_roles("head_physio", "physio", "super_admin"))):
    await v3_col("appointments").update_one({"id": appointment_id}, {"$set": {"status": "completed"}})
    appointment = await v3_col("appointments").find_one({"id": appointment_id}, {"_id": 0})
    if not appointment:
        raise HTTPException(status_code=404, detail="Appointment not found")
    before = await v3_col("leads").find_one({"id": appointment["lead_id"]}, {"_id": 0, "stage": 1})
    await v3_col("leads").update_one({"id": appointment["lead_id"]}, {"$set": {"stage": "Completed", "updated_at": now_iso()}})
    await log_stage_moves(
        appointment["lead_id"], before, {"stage": "Completed"}, user.full_name, user.role,
        f"appointment with {appointment.get('doctor_name') or 'the doctor'} completed",
    )
    return V3AppointmentOut(**appointment)
