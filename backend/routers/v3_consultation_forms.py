"""Offline Consultation Form: the clinic's three-page paper form, filled on screen.

Branch Admin > Settings > Consultation Form. Each saved form is one patient's sheet, kept
under the branch it was filled at, and opens again in the same layout for editing.

The fields are the paper's own, page for page (see FIELDS). Every one is free text: the
form is a record of what was written, not a lead, so nothing here moves a lead's stage or
touches its bill.

Client link. The desk can send a form to the patient to fill themselves: Share mints an
unguessable `share_token` and marks the form `client_status: "requested"`, and the public
page at /consult-form/<token> shows the patient only CLIENT_FIELDS -- page 1's details and
history and the Previous Consultations section. The diagnosis, the treatment plan and the
muscles are the clinic's to write and never leave through the link. One submission per
request: once the patient sends it the link answers "already submitted" until the desk
shares it again.
"""
import re
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from database import v3_col
from deps import is_branch_admin_role, v3_require_roles
from physio_scope import user_branch_ids
from schemas.v3 import V3UserOut
from utils import now_iso

router = APIRouter(prefix="/api/v3", tags=["consultation-forms"])

ROLES = ("branch_admin", "super_admin", "business_dev")
COL = "consultation_forms"

# The paper's fields, in its order. Anything else sent is dropped.
FIELDS = (
    # Page 1 -- Patient Details
    "name", "age", "sex", "contact_no", "mail_id", "source_of_reference", "nature_of_job",
    "branch", "date", "place",
    "past_medical_history", "any_medication", "symptoms_root_cause",
    "primary_muscles", "secondary_muscles",
    # Page 2 -- Previous Consultations; Diagnosis & Treatment Plan
    "previous_medical_consultations", "previous_diagnosis", "previous_physiotherapy",
    "fitsiomax_diagnosis", "treatment_goals",
    # Page 3
    "treatment_protocol", "sessions_weeks_required", "sessions_weeks_online_offline",
    "short_term_goal", "long_term_goal", "dos_and_donts", "special_instructions",
    "therapist_name",
)
# What the patient fills through the link. The frontend's CLIENT_FIELDS is the same list.
CLIENT_FIELDS = (
    "name", "age", "sex", "contact_no", "mail_id", "source_of_reference", "nature_of_job",
    "branch", "date", "place",
    "past_medical_history", "any_medication", "symptoms_root_cause",
    "previous_medical_consultations", "previous_diagnosis", "previous_physiotherapy",
)
MAX_LEN = 5000
LIST_FIELDS = {"_id": 0, "id": 1, "name": 1, "contact_no": 1, "date": 1, "therapist_name": 1,
               "branch": 1, "created_at": 1, "updated_at": 1, "created_by": 1,
               "share_token": 1, "client_status": 1, "client_submitted_at": 1}


class ConsultationFormInput(BaseModel):
    fields: Dict[str, Optional[str]] = {}


def _guard(user: V3UserOut, branch_id: str) -> None:
    # A Branch Admin keeps its own branch's forms; the org-wide desks any branch's.
    if is_branch_admin_role(user.role) and branch_id not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="This is not your branch")


def _clean(fields: Dict[str, Optional[str]], keys=FIELDS, need_name: bool = True) -> dict:
    out = {}
    for key in keys:
        value = str(fields.get(key) or "").replace("\r\n", "\n").strip()
        if len(value) > MAX_LEN:
            raise HTTPException(status_code=400, detail=f"{key.replace('_', ' ').title()} is too long")
        out[key] = value
    if need_name and not out.get("name"):
        raise HTTPException(status_code=400, detail="Enter the patient's name")
    return out


async def _get(branch_id: str, form_id: str) -> dict:
    row = await v3_col(COL).find_one({"id": form_id, "branch_id": branch_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Form not found")
    return row


async def _branch_exists(branch_id: str) -> None:
    if not await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Branch not found")


@router.get("/branches/{branch_id}/consultation-forms")
async def list_consultation_forms(
    branch_id: str,
    q: Optional[str] = Query(None),
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    query: dict = {"branch_id": branch_id}
    term = (q or "").strip()
    if term:
        rx = {"$regex": re.escape(term), "$options": "i"}
        query["$or"] = [{"name": rx}, {"contact_no": rx}, {"therapist_name": rx}]
    rows = await v3_col(COL).find(query, LIST_FIELDS).sort("created_at", -1).to_list(500)
    return {"forms": rows}


@router.get("/branches/{branch_id}/consultation-forms/{form_id}")
async def get_consultation_form(
    branch_id: str,
    form_id: str,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    return await _get(branch_id, form_id)


async def _insert(branch_id: str, user: V3UserOut, fields: dict, extra: Optional[dict] = None) -> dict:
    now = now_iso()
    row = {
        "id": str(uuid.uuid4()),
        "branch_id": branch_id,
        **fields,
        **(extra or {}),
        "created_by": user.full_name,
        "created_at": now,
        "updated_by": user.full_name,
        "updated_at": now,
    }
    await v3_col(COL).insert_one(row.copy())
    return row


@router.post("/branches/{branch_id}/consultation-forms")
async def create_consultation_form(
    branch_id: str,
    payload: ConsultationFormInput,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    await _branch_exists(branch_id)
    return await _insert(branch_id, user, _clean(payload.fields))


@router.post("/branches/{branch_id}/consultation-forms/request")
async def request_consultation_form(
    branch_id: str,
    payload: ConsultationFormInput,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """A blank form for the patient to fill through the link. Name and number are optional:
    the desk may know them already, or leave them for the patient."""
    _guard(user, branch_id)
    await _branch_exists(branch_id)
    return await _insert(
        branch_id, user, _clean(payload.fields, need_name=False),
        {"share_token": uuid.uuid4().hex, "client_status": "requested", "client_requested_at": now_iso()},
    )


@router.post("/branches/{branch_id}/consultation-forms/{form_id}/share")
async def share_consultation_form(
    branch_id: str,
    form_id: str,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """Opens the form to the patient: keeps its link if it has one, and lets a form already
    sent back be filled again."""
    _guard(user, branch_id)
    row = await _get(branch_id, form_id)
    token = row.get("share_token") or uuid.uuid4().hex
    await v3_col(COL).update_one(
        {"id": form_id, "branch_id": branch_id},
        {"$set": {"share_token": token, "client_status": "requested", "client_requested_at": now_iso()}},
    )
    return {"share_token": token, "client_status": "requested"}


@router.put("/branches/{branch_id}/consultation-forms/{form_id}")
async def update_consultation_form(
    branch_id: str,
    form_id: str,
    payload: ConsultationFormInput,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    await _get(branch_id, form_id)
    await v3_col(COL).update_one(
        {"id": form_id, "branch_id": branch_id},
        {"$set": {**_clean(payload.fields), "updated_by": user.full_name, "updated_at": now_iso()}},
    )
    return await _get(branch_id, form_id)


@router.delete("/branches/{branch_id}/consultation-forms/{form_id}")
async def delete_consultation_form(
    branch_id: str,
    form_id: str,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    res = await v3_col(COL).delete_one({"id": form_id, "branch_id": branch_id})
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Form not found")
    return {"deleted": True}


# ---- The patient's side: no login, keyed by the share token alone. ----

async def _by_token(token: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
        raise HTTPException(status_code=404, detail="This link is not valid")
    row = await v3_col(COL).find_one({"share_token": token}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="This link is not valid")
    return row


@router.get("/public/consultation-forms/{token}")
async def public_get_consultation_form(token: str):
    row = await _by_token(token)
    branch = await v3_col("branches").find_one({"id": row["branch_id"]}, {"_id": 0, "name": 1}) or {}
    status = row.get("client_status")
    return {
        "branch_name": branch.get("name") or "",
        "status": "open" if status == "requested" else "submitted",
        "fields": {k: row.get(k) or "" for k in CLIENT_FIELDS},
    }


@router.post("/public/consultation-forms/{token}")
async def public_submit_consultation_form(token: str, payload: ConsultationFormInput):
    row = await _by_token(token)
    if row.get("client_status") != "requested":
        raise HTTPException(status_code=409, detail="This form has already been submitted. Contact the clinic to change it.")
    fields = _clean(payload.fields, keys=CLIENT_FIELDS)
    now = now_iso()
    res = await v3_col(COL).update_one(
        {"id": row["id"], "client_status": "requested"},
        {"$set": {**fields, "client_status": "submitted", "client_submitted_at": now,
                  "updated_by": fields["name"] + " (client)", "updated_at": now}},
    )
    if not res.modified_count:
        raise HTTPException(status_code=409, detail="This form has already been submitted. Contact the clinic to change it.")
    return {"submitted": True}
