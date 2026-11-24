"""The signs of the clinic's people, uploaded and seen.

    My Profile > Sign Upload           everybody's own, whatever their desk
    Admin Setting > Digital Sign       a branch's people, by the Branch Admin

Whose sign prints on which paper is staff_sign.py's."""
from typing import Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

import staff_sign
from database import v3_col
from deps import (
    is_branch_admin_role, is_head_physio_role, is_physio_role, is_pre_sales_role,
    online_arm_practice, v3_current_user, v3_require_roles, vertical_in_arm, works_org_wide,
)
from physio_scope import user_branch_ids
from schemas.v3 import V3UserOut

router = APIRouter(prefix="/api/v3", tags=["staff-sign"])

ROLES = ("branch_admin", "super_admin", "business_dev")
# Who opens a patient's prescription: the desks that read their documents.
PRESCRIPTION_ROLES = (*ROLES, "head_physio", "physio", "nutrition_coach")
# The desks that take money at no branch of their own. Listed for the ones that run every
# branch, since no branch's own list would ever have them.
ORG_DESKS = ("super_admin", "business_dev", "accountant")

GROUPS = ("Branch Admin", "Consultant", "Therapist", "Other")


def _group(person: dict) -> str:
    role = person.get("role") or ""
    if is_branch_admin_role(role):
        return "Branch Admin"
    if person.get("consults") or is_head_physio_role(role):
        return "Consultant"
    return "Therapist" if is_physio_role(role) else "Other"


def _may_upload(user: V3UserOut, person: dict) -> bool:
    """Your own, and the people of the branch you run. A Super Admin's is theirs to add, and a
    desk that runs every branch is not a branch's to sign for."""
    if person["id"] == user.id:
        return True
    role = (person.get("role") or "").strip().lower()
    if role.startswith("super_admin"):
        return user.role == "super_admin"
    return works_org_wide(user.role) or not works_org_wide(role)


async def _people(branch_id: str, user: V3UserOut) -> Dict[str, dict]:
    if branch_id and is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="This is not your branch")
    people = {
        i: p for i, p in (await staff_sign.people_at(branch_id)).items() if not is_pre_sales_role(p.get("role") or "")
    }
    if works_org_wide(user.role):
        async for u in v3_col("users").find(
            {"role": {"$in": list(ORG_DESKS)}, "is_active": {"$ne": False}}, staff_sign.PERSON_FIELDS,
        ):
            people.setdefault(u["id"], u)
    # Whoever is looking can always add their own, posted to this branch or not.
    people.setdefault(user.id, {"id": user.id, "full_name": user.full_name, "role": user.role})
    return people


async def _person(user_id: str, branch_id: str, user: V3UserOut) -> dict:
    person = (await _people(branch_id, user)).get(user_id)
    if not person:
        raise HTTPException(status_code=404, detail="This person is not at this branch")
    return person


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


@router.get("/signatures")
async def list_signatures(branch_id: str = Query(""), user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """Who signs at this branch, and who has a sign. The signs themselves are not in it."""
    people = await _people(branch_id, user)
    signed: Dict[str, dict] = {}
    async for row in v3_col(staff_sign.COL).find(
        {"user_id": {"$in": list(people)}}, {"_id": 0, "user_id": 1, "valid_from": 1, "uploaded_at": 1, "uploaded_by": 1},
    ).sort("valid_from", 1):
        signed[row["user_id"]] = row
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "branch_name": 1}) if branch_id else None
    rows = [
        {
            "user_id": p["id"], "name": p.get("full_name") or "", "group": _group(p), "you": p["id"] == user.id,
            "has_sign": p["id"] in signed, "can_upload": _may_upload(user, p), **_stamp(signed.get(p["id"]) or {}),
        }
        for p in people.values()
    ]
    rows.sort(key=lambda r: (GROUPS.index(r["group"]), r["name"].lower()))
    return {"branch_name": (branch or {}).get("branch_name") or "", "groups": list(GROUPS), "people": rows}


@router.get("/signatures/{user_id}")
async def get_signature(user_id: str, branch_id: str = Query(""), user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    person = await _person(user_id, branch_id, user)
    row = await staff_sign.of_user(user_id)
    if not row:
        raise HTTPException(status_code=404, detail="No sign has been uploaded yet")
    return _signed(person.get("full_name") or "", row)


@router.post("/signatures/{user_id}")
async def upload_signature(
    user_id: str,
    branch_id: str = Query(""),
    file: UploadFile = File(...),
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    person = await _person(user_id, branch_id, user)
    if not _may_upload(user, person):
        raise HTTPException(status_code=403, detail="You cannot upload this person's sign")
    row = await staff_sign.save(person, await _read_sign(file), {"id": user.id, "full_name": user.full_name})
    return _signed(person.get("full_name") or "", row)


@router.get("/branches/{branch_id}/therapist-sign")
async def therapist_sign(branch_id: str, name: str = Query(""), user: V3UserOut = Depends(v3_require_roles(*ROLES))):
    """The sign that goes with a therapist's name as it is typed on the Consultation Form."""
    if is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="This is not your branch")
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
