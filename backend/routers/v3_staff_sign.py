"""My Profile > Sign Upload: everybody's own sign, whatever their desk, and nobody else's. With
it, what the Consultation Form and the prescription ask for as they are drawn. Whose sign
prints on which paper is staff_sign.py's."""
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

import staff_sign
from database import v3_col
from deps import (
    is_branch_admin_role, is_head_physio_role, is_physio_role, online_arm_practice, v3_current_user,
    v3_require_roles, vertical_in_arm,
)
from physio_scope import user_branch_ids
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3", tags=["staff-sign"])

ROLES = ("branch_admin", "super_admin", "business_dev")
# Who opens a patient's prescription: the desks that read their documents.
PRESCRIPTION_ROLES = (*ROLES, "head_physio", "physio", "nutrition_coach")


def _stamp(row: dict) -> dict:
    return {"uploaded_at": row.get("uploaded_at") or "", "uploaded_by": row.get("uploaded_by") or ""}


def _signed(name: str, row: Optional[dict]) -> dict:
    return {"name": name, "image": staff_sign.data_url(row), **_stamp(row or {})}


async def _read_sign(file: UploadFile) -> bytes:
    """The picture the editor sends, or a refusal: a small PNG and nothing else."""
    data = await file.read(staff_sign.MAX_BYTES + 1)
    if len(data) > staff_sign.MAX_BYTES:
        raise HTTPException(status_code=413, detail="The sign picture is too large")
    size = staff_sign.png_size(data)
    if not size:
        raise HTTPException(status_code=400, detail="The sign must be a PNG picture")
    if not (0 < size[0] <= staff_sign.MAX_WIDTH and 0 < size[1] <= staff_sign.MAX_HEIGHT):
        raise HTTPException(status_code=400, detail="The sign picture is too large")
    return data


# My Profile > Sign Upload. No id in either: they answer for whoever holds the token, as the
# rest of My Profile does, so every desk has them.
@router.get("/me/signature")
async def my_signature(user: V3UserOut = Depends(v3_current_user)):
    return _signed(user.full_name, await staff_sign.of_user(user.id))


@router.post("/me/signature")
async def upload_my_signature(file: UploadFile = File(...), user: V3UserOut = Depends(v3_current_user)):
    me = {"id": user.id, "full_name": user.full_name}
    return _signed(user.full_name, await staff_sign.save(me, await _read_sign(file), me))


@router.delete("/me/signature")
async def delete_my_signature(user: V3UserOut = Depends(v3_current_user)):
    await staff_sign.remove({"id": user.id}, {"id": user.id})
    return _signed(user.full_name, None)


def _own_branch(user: V3UserOut, branch_id: str) -> None:
    if is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="This is not your branch")


@router.get("/branches/{branch_id}/therapist-names")
async def therapist_names(branch_id: str, user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """The branch's therapists and consultants, offered as a name is typed on the form."""
    _own_branch(user, branch_id)
    people = (await staff_sign.people_at(branch_id)).values()
    names = {
        (p.get("full_name") or "").strip() for p in people
        if p.get("consults") or is_head_physio_role(p.get("role") or "") or is_physio_role(p.get("role") or "")
    }
    return {"names": sorted(names - {""}, key=str.lower)}


@router.get("/branches/{branch_id}/therapist-sign")
async def therapist_sign(branch_id: str, name: str = Query(""), user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """The sign that goes with a therapist's name as it is typed on the Consultation Form."""
    _own_branch(user, branch_id)
    return {"name": name, "image": staff_sign.data_url(await staff_sign.therapist_sign(name, branch_id))}


@router.get("/leads/{lead_id}/prescription-sign")
async def prescription_sign(lead_id: str, user: V3UserOut = Depends(v3_require_roles(*PRESCRIPTION_ROLES))):
    """The consultant's sign for this patient's prescription, with the name it belongs to, so
    it is only ever drawn over that name."""
    lead = await v3_col("leads").find_one(
        {"id": lead_id},
        {"_id": 0, "branch_id": 1, "vertical": 1, "assigned_physio_id": 1, "assigned_physio_name": 1, "appointment_date": 1},
    )
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if is_branch_admin_role(user.role):
        practice = online_arm_practice(user.role)
        in_arm = bool(practice) and vertical_in_arm(lead.get("vertical"), practice)
        if not in_arm and lead.get("branch_id") not in user_branch_ids(user):
            raise HTTPException(status_code=403, detail="This patient is not at your branch")
    return await staff_sign.consultant_sign(lead) or {"name": "", "image": ""}
