"""Offline Consultation Form: the clinic's three-page paper form, filled on screen.

Branch Admin > Settings > Consultation Form. Each saved form is one patient's sheet, kept
under the branch it was filled at, and opens again in the same layout for editing.

The fields are the paper's own, page for page (see FIELDS). Every one is free text: the
form is a record of what was written, not a lead, so nothing here moves a lead's stage or
touches its bill.

Client link. The desk can send a form to the patient to fill themselves: Share mints an
unguessable `share_token` and marks the form `client_status: "requested"`, and the public
page at /consult-form/<token> asks the patient only CLIENT_FIELDS, in five short steps --
page 1's details, history and muscles, and the Previous Consultations section. The diagnosis
and the treatment plan are the clinic's to write and never leave through the link. One submission per
request: once the patient sends it the link answers "already submitted" until the desk
shares it again.
"""
import re
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import consultation_form_page3
import staff_sign
from database import v3_col
from deps import is_branch_admin_role, online_arm_practice, v3_require_roles, vertical_in_arm
from physio_scope import user_branch_ids
from schemas.v3 import V3UserOut
from utils import live_branch_query, now_iso

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
    # Page 3. Most of it is the Consultant's Treatment Prescription, copied from the lead
    # (consultation_form_page3.py).
    "treatment_protocol", "sessions_weeks_required", "sessions_weeks_online_offline",
    "short_term_goal", "long_term_goal", "dos_and_donts", "special_instructions",
    "therapist_name",
)
# What the patient fills through the link. The frontend's CLIENT_FIELDS is the same list.
CLIENT_FIELDS = (
    "name", "age", "sex", "contact_no", "mail_id", "source_of_reference", "nature_of_job",
    "branch", "date", "place",
    "past_medical_history", "any_medication", "symptoms_root_cause",
    "primary_muscles", "secondary_muscles",
    "previous_medical_consultations", "previous_diagnosis", "previous_physiotherapy",
)
MAX_LEN = 5000
LIST_FIELDS = {"_id": 0, "id": 1, "name": 1, "contact_no": 1, "date": 1, "therapist_name": 1,
               "branch": 1, "created_at": 1, "updated_at": 1, "created_by": 1,
               "share_token": 1, "client_status": 1, "client_submitted_at": 1, "lead_id": 1}


class ConsultationFormInput(BaseModel):
    fields: Dict[str, Optional[str]] = {}
    # The lead the form was opened from (the Branch Lead popup's Form button), so the same
    # patient's form opens again there instead of a second one being started.
    lead_id: Optional[str] = None


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


async def _sign_of(row: dict) -> Optional[dict]:
    """The sign over the form's Therapist Name, with the name it belongs to. Only ever handed
    to the desk: the client's link asks for CLIENT_FIELDS alone."""
    image = staff_sign.data_url(await staff_sign.form_sign(row))
    return {"name": row["therapist_name"], "image": image} if image else None


async def _signed_as(branch_id: str, name: str) -> Optional[str]:
    """The id of the sign a form is saved with, for the therapist named on it."""
    sign = await staff_sign.therapist_sign(name, branch_id)
    return sign["id"] if sign else None


async def _branch_exists(branch_id: str) -> None:
    if not await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Branch not found")


@router.get("/branches/{branch_id}/consultation-forms")
async def list_consultation_forms(
    branch_id: str,
    q: Optional[str] = Query(None),
    lead_id: Optional[str] = Query(None),
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    _guard(user, branch_id)
    query: dict = {"branch_id": branch_id}
    if lead_id:
        query["lead_id"] = lead_id
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
    # A form made before page 3 was linked, or before the Consultant wrote it, shows the
    # Treatment Prescription in its blanks; saving it keeps them.
    row = await _get(branch_id, form_id)
    filled = await consultation_form_page3.fill_blanks(row, row.get("lead_id"))
    return {**filled, "therapist_sign": await _sign_of(row)}


@router.get("/leads/{lead_id}/consultation-report")
async def lead_consultation_report(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles(*ROLES)),
):
    """One lead's Consultation Form, to read: the Consultation popup's Progression tab.

    Found by the lead alone, so a patient who moved branches keeps the form the first one
    filled. With none saved yet it still answers, with what the Consultant has prescribed
    (`saved` is False), and the screen fills the patient's details from the lead.

    The newest form wins, as the lead's own Form button opens it. The share token is left
    out: reading the report is not sending it to the patient."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "branch_id": 1, "vertical": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if is_branch_admin_role(user.role):
        # Their own branch's patient, or -- for an admin who runs an online arm, whose leads
        # carry no branch -- one of that arm's.
        practice = online_arm_practice(user.role)
        in_arm = bool(practice) and vertical_in_arm(lead.get("vertical"), practice)
        if not in_arm and lead.get("branch_id") not in user_branch_ids(user):
            raise HTTPException(status_code=403, detail="This patient is not at your branch")
    rows = await v3_col(COL).find({"lead_id": lead_id}, {"_id": 0}).sort("created_at", -1).to_list(1)
    row = rows[0] if rows else {}
    filled = await consultation_form_page3.fill_blanks(row, lead_id)
    return {
        "saved": bool(row),
        "client_status": row.get("client_status"),
        "fields": {k: filled.get(k) or "" for k in FIELDS},
        "therapist_sign": await _sign_of(row),
    }


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
    lead_id = (payload.lead_id or "").strip()
    # Page 3: the Consultant's Treatment Prescription, from the lead, where the form brings none.
    fields = await consultation_form_page3.fill_blanks(_clean(payload.fields), lead_id)
    extra = {"therapist_sign_id": await _signed_as(branch_id, fields["therapist_name"])}
    if lead_id:
        extra["lead_id"] = lead_id
    return await _insert(branch_id, user, fields, extra)


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
    row = await _get(branch_id, form_id)
    fields = _clean(payload.fields)
    # A form signed once keeps that sign for as long as it names the same therapist.
    signed = row.get("therapist_sign_id")
    if not signed or fields["therapist_name"] != (row.get("therapist_name") or ""):
        signed = await _signed_as(branch_id, fields["therapist_name"])
    await v3_col(COL).update_one(
        {"id": form_id, "branch_id": branch_id},
        {"$set": {**fields, "therapist_sign_id": signed, "updated_by": user.full_name, "updated_at": now_iso()}},
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


async def _offline_branch_names() -> list:
    """The branches the patient can pick on the link: every live one a patient walks into.
    Online branches are left out -- this is the Offline Consultation Form. Names only, no
    ids or contacts: the link is public."""
    rows = await v3_col("branches").find(
        live_branch_query(), {"_id": 0, "branch_name": 1, "vertical": 1},
    ).to_list(500)
    return [
        r["branch_name"] for r in rows
        if r.get("branch_name") and not str(r.get("vertical") or "").startswith("online_")
    ]


@router.get("/public/consultation-forms/{token}")
async def public_get_consultation_form(token: str):
    row = await _by_token(token)
    branch = await v3_col("branches").find_one({"id": row["branch_id"]}, {"_id": 0, "branch_name": 1}) or {}
    status = row.get("client_status")
    return {
        "branch_name": branch.get("branch_name") or "",
        "branches": await _offline_branch_names(),
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
