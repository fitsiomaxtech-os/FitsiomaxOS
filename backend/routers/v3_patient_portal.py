"""Client Portal — a login (phone or email + password) Branch Admin generates for a patient
once their Treatment Fee is paid, so the patient can check their own session progress
without staff involvement.

Phone is the login everyone has; email is the second way in, to the same account. Several
patients may sit behind one login — a family registered on one number — so an account is
still one per patient, a password is shared across every account on the same phone or
email, and signing in hands back every patient the password opened for the patient to pick
between (see _start_portal_session and /patient-portal/switch).

Kept in its own patient_portal_accounts / patient_portal_sessions collections rather than
reusing `users`/`sessions` — those are staff-only, and `sessions` already carries a second,
unrelated shape (treatment-session bookings, deliberately, per v3_reviews.py's docstring
about what happened the last time this collection grew a second shape); a third shape on
top of that is exactly the mistake to avoid, not repeat.
"""
import asyncio
import logging
import os
import random
import secrets
import string
import uuid
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from fastapi.responses import FileResponse

import login_guard
from database import v3_col
from routers.v3_reviews import review_numbers_for_lead
from utils import now_iso, now_utc
from security import hash_password, verify_password
from portal_secret import open_password, seal_password
from routers.v3_password_reset import _hash_token, _mask_email, _send_or_503
from email_utils import SmtpNotConfigured, send_email
from deps import v3_require_roles, is_branch_admin_role, works_org_wide
from routers.v3_lead_documents import DIET_CHART, DOC_DIR, is_shared_with_patient
from routers.v3_feedback import (
    AUDIENCE_BRANCH, AUDIENCE_CONSULTANT, AUDIENCE_SUPER, AUDIENCE_WEEKLY_REVIEW, AUTHOR_PATIENT, AUTHOR_STAFF, MAX_MESSAGE,
    STATUS_AWAITING, STATUS_IN_PROGRESS, STATUS_NEW, STATUS_RESOLVED,
    _audience, _rating, _thread,
)
from physio_scope import consultant_of_lead
from routers.v3_session_payment import (
    extension_of, payment_hold_for_lead, record_extension_request, sessions_paid_for,
)
from routers.v3_marketing import normalize_phone
from schemas.v3 import (
    V3UserOut, V3PortalAccountInput, V3PatientPortalLogin, V3PatientPortalGoogleLogin,
    V3PatientPortalSwitch, V3PatientPortalChangePassword,
)

router = APIRouter(prefix="/api/v3")

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
# Where the emailed login points. Same variable and default the password-reset emails use.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://os.fitsiomax.clinic")
_google_request = google_requests.Request()


def _generate_password(length: int = 10) -> str:
    # No 0/O, 1/l/I or similarly-confusable characters — this is typed by a patient on
    # a phone keyboard, often copy-pasted imperfectly from a WhatsApp message on a small
    # screen, so every character needs to be unambiguous by eye. Length bumped up from 8
    # to 10 to keep entropy reasonable after shrinking the alphabet.
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return "".join(random.choices(alphabet, k=length))


async def _lead_or_404(lead_id: str) -> dict:
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")
    return lead


def has_treatment(lead: dict) -> bool:
    """Whether this patient is on a course of treatment, and so gets the Client Portal.

    The portal exists for a course of sessions: progress to follow, a plan to read
    between visits, a balance to watch. That is what makes it worth logging in to, and
    what a one-off consultation does not have.

    Three signals, any one of which means treatment exists. Written as presence rather
    than as an amount, because HOW MUCH has been paid must never decide this — a patient
    on a 10,000 package who has paid 2,000 is mid-treatment and needs the portal most of
    all. `treatment_fee_paid` is set the moment any treatment money or Partial Payment
    schedule is recorded, whatever the figure, including zero.

    What this deliberately excludes: "Consultation Only", and a patient who came for a
    Diet Consultation alone. Both are paying patients, and neither is a treatment patient.
    A patient on treatment who ALSO takes a diet plan matches on the treatment side and
    keeps the portal.
    """
    return (
        lead.get("treatment_fee_paid") is not None          # fee collected, in full or part
        or bool(lead.get("session_package_id"))             # treatment package chosen
        or lead.get("consultation_decision") == "consultation_treatment"
    )


# ------------------------------------------------------------- Branch Admin: manage access

def login_phone(raw) -> str:
    """The ten digits a phone login is matched on, or "" when there is no whole number.

    The last ten, so +91 98765 43210, 098765 43210 and a record carrying a "p:" prefix all
    reach the same account. Anything shorter is not a phone anybody can sign in with, and
    is kept off the account rather than stored as a partial key that could match a stranger.
    """
    key = normalize_phone(str(raw or ""))
    return key if len(key) == 10 else ""


async def _accounts_sharing_login(lead_id: str, phone: str, email: str) -> list:
    """Every other patient's account signed in with this phone or this email — the family
    this lead's login belongs to. Newest first, so the password a joining patient inherits
    is the one most recently shared."""
    clauses = []
    if phone:
        clauses.append({"phone": phone})
    if email:
        clauses.append({"email": email})
    if not clauses:
        return []
    return await v3_col("patient_portal_accounts").find(
        {"$or": clauses, "lead_id": {"$ne": lead_id}}, {"_id": 0},
    ).sort("updated_at", -1).to_list(50)


async def _patients_for(lead_ids: list) -> list:
    """Who each lead is, as the patient picker shows them, in a stable order by name."""
    if not lead_ids:
        return []
    rows = await v3_col("leads").find(
        {"id": {"$in": list(lead_ids)}}, {"_id": 0, "id": 1, "name": 1, "patient_number": 1},
    ).to_list(len(lead_ids))
    rows.sort(key=lambda r: (r.get("name") or "").lower())
    return [
        {"lead_id": r["id"], "name": r.get("name") or "", "patient_number": r.get("patient_number")}
        for r in rows
    ]


async def sync_portal_login_phone(lead_id: str, phone) -> None:
    """Carry a corrected phone number onto the patient's portal login.

    Called after staff edit a lead. Without it, fixing a mistyped number at the desk leaves
    the patient signing in with the wrong one — the number on file and the number that
    logs in would quietly disagree.
    """
    await v3_col("patient_portal_accounts").update_one(
        {"lead_id": lead_id}, {"$set": {"phone": login_phone(phone), "updated_at": now_iso()}},
    )


async def backfill_portal_account_phones() -> None:
    """Give every account made before phone sign-in the phone its patient is on file with.

    Run at startup. Only touches accounts with no `phone` field at all, so it does its work
    once and costs a single empty query on every boot after.
    """
    filled = 0
    async for account in v3_col("patient_portal_accounts").find(
        {"phone": {"$exists": False}}, {"_id": 0, "id": 1, "lead_id": 1},
    ):
        lead = await v3_col("leads").find_one({"id": account.get("lead_id")}, {"_id": 0, "phone": 1})
        await v3_col("patient_portal_accounts").update_one(
            {"id": account["id"]}, {"$set": {"phone": login_phone((lead or {}).get("phone"))}},
        )
        filled += 1
    if filled:
        logging.getLogger(__name__).info(f"portal accounts given a login phone: {filled}")


@router.get("/leads/{lead_id}/portal-account")
async def get_portal_account(lead_id: str, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    lead = await _lead_or_404(lead_id)
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Patient not found")
    account = await v3_col("patient_portal_accounts").find_one(
        {"lead_id": lead_id},
        {
            "_id": 0, "phone": 1, "email": 1, "created_at": 1, "blocked": 1,
            "created_via": 1, "email_status": 1, "password_sealed": 1,
        },
    )
    auto_skip = bool(lead.get("portal_auto_skip"))
    if not account:
        return {"exists": False, "auto_skip": auto_skip}
    phone, email = account.get("phone") or "", account.get("email") or ""
    siblings = await _accounts_sharing_login(lead_id, phone, email)
    return {
        "exists": True,
        "phone": phone,
        "email": email,
        # The password in force, for the desk to read out. "" for a login made before it
        # was kept readable — the popup then offers a reset rather than showing nothing
        # without saying why.
        "password": await open_password(account.get("password_sealed") or ""),
        "created_at": account.get("created_at"),
        "shared_with": [p["name"] for p in await _patients_for([s["lead_id"] for s in siblings])],
        "blocked": bool(account.get("blocked")),
        "created_via": account.get("created_via") or "",
        "email_status": account.get("email_status") or "",
        "auto_skip": auto_skip,
    }


@router.post("/leads/{lead_id}/portal-account")
async def create_or_reset_portal_account(
    lead_id: str,
    payload: V3PortalAccountInput,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Create-or-reset in one call: the first time, this creates the account; every call
    after that resets the password (freshly generated unless the caller supplies one),
    since re-sharing a lost password is the same action either way. The plaintext
    password is returned only here, this once — nothing later can ever read it back.

    One password per login. Resetting it resets every patient signed in on the same phone
    or email, since that is one person holding one set of credentials. A new patient
    joining a login the family already has inherits its password instead of replacing it,
    so the rest of the family is not locked out by a sibling being added — `password` then
    comes back as None and `joined_existing` says why.
    """
    lead = await _lead_or_404(lead_id)
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Patient not found")
    if not has_treatment(lead):
        raise HTTPException(
            status_code=400,
            detail="Only treatment patients get the Client Portal — this patient has no treatment sessions.",
        )

    phone = login_phone(payload.phone if payload.phone is not None else lead.get("phone"))
    email = (payload.email or lead.get("email") or "").strip().lower()
    if not phone and not email:
        raise HTTPException(
            status_code=400,
            detail="A 10-digit phone number or an email is required for portal access",
        )
    return await _save_portal_login(lead, user, phone, email, (payload.password or "").strip(), "manual")


async def _save_portal_login(lead: dict, user, phone: str, email: str, supplied: str, created_via: str) -> dict:
    """Write one lead's portal login — create it, reset it, or add it to its family's.

    Shared by the Branch Admin's Generate / Reset button and the automatic login made when
    a treatment course is booked, so the family-password rules in the endpoint's docstring
    hold whichever of the two made the account.
    """
    lead_id = lead["id"]
    now = now_iso()
    existing = await v3_col("patient_portal_accounts").find_one({"lead_id": lead_id}, {"_id": 0, "id": 1})
    siblings = await _accounts_sharing_login(lead_id, phone, email)

    joined_existing = not existing and not supplied and bool(siblings)
    if joined_existing:
        password = None
        password_hash = siblings[0].get("password_hash", "")
        password_sealed = siblings[0].get("password_sealed", "")
    else:
        password = supplied or _generate_password()
        password_hash = hash_password(password)
        password_sealed = await seal_password(password)

    # Two copies of the password: `password_hash`, which a sign-in is checked against, and
    # `password_sealed`, which the Patients popup can read back to show the desk the
    # password actually in force. See portal_secret.py for why the second is encrypted.
    login_fields = {
        "phone": phone,
        "email": email,
        "password_hash": password_hash,
        "password_sealed": password_sealed,
        "updated_at": now,
        "updated_by": user.full_name,
    }
    if existing:
        await v3_col("patient_portal_accounts").update_one({"lead_id": lead_id}, {"$set": login_fields})
    else:
        await v3_col("patient_portal_accounts").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "branch_id": lead.get("branch_id"),
            **login_fields,
            "created_at": now,
            "created_by": user.full_name,
            # "auto" when booking the treatment course made it, "manual" for the button.
            "created_via": created_via,
        })
    if password is not None and siblings:
        await v3_col("patient_portal_accounts").update_many(
            {"id": {"$in": [s["id"] for s in siblings]}},
            {"$set": {
                "password_hash": password_hash,
                "password_sealed": password_sealed,
                "updated_at": now,
                "updated_by": user.full_name,
            }},
        )

    shared_with = [p["name"] for p in await _patients_for([s["lead_id"] for s in siblings])]
    login_label = " / ".join(x for x in (phone, email) if x)
    if joined_existing:
        details = f"Added to the existing Client Portal login {login_label} (shared with {', '.join(shared_with)})"
    else:
        details = f"{'Reset' if existing else 'Created'} Client Portal access for {login_label}"
        if shared_with:
            details += f" — same password now applies to {', '.join(shared_with)}"
    if created_via == "auto":
        details = f"Automatically, on booking treatment: {details[0].lower()}{details[1:]}"
    elif created_via == "approved":
        details = f"On branch approval: {details[0].lower()}{details[1:]}"
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portal_account_reset" if existing else "portal_account_created",
        "details": details,
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {
        "phone": phone,
        "email": email,
        "password": password,
        "joined_existing": joined_existing,
        "shared_with": shared_with,
    }


# ------------------------------------------------- Automatic login when treatment is booked

# Who may change what — the control plan agreed with the clinic:
#   clinic-wide switch and email wording   Super Admin, Business Development
#   a branch's mode                         the same two for any branch, all three modes;
#                                           a Branch Admin for their own branch, but only
#                                           between "immediate" and "approval" — never "off"
#   one client (block, resend, skip)        all three, a Branch Admin inside their branch
PORTAL_SETTINGS_ID = "_singleton_"
BRANCH_MODES = ("immediate", "approval", "off")
BRANCH_ADMIN_MODES = ("immediate", "approval")

DEFAULT_EMAIL_SUBJECT = "Your Fitsiomax Client Portal login"
# {login} is one or two lines (phone, then email). {branch_help} is a sentence with the
# branch's number, or nothing when the branch has none on file.
DEFAULT_EMAIL_BODY = (
    "Hi {name},\n"
    "\n"
    "Your Fitsiomax Client Portal is ready. You can see your session dates, your treatment\n"
    "progress and your payments there, any time.\n"
    "\n"
    "Login here: {link}\n"
    "{login}\n"
    "Password: {password}\n"
    "\n"
    "Please keep this password private.{branch_help}\n"
    "\n"
    "— Fitsiomax"
)
EMAIL_TEMPLATE_KEYS = ("name", "link", "login", "password", "branch_help")


async def portal_settings() -> dict:
    """The clinic-wide portal settings, with defaults for anything never saved.

    Automatic login is on unless somebody turned it off: that is what the clinic agreed,
    and it is how Step 2 already behaved, so an install that never opens the settings keeps
    doing what it did. A blank subject or body means the default wording.
    """
    row = await v3_col("portal_settings").find_one({"id": PORTAL_SETTINGS_ID}, {"_id": 0}) or {}
    return {
        "auto_enabled": row.get("auto_enabled", True),
        "email_subject": (row.get("email_subject") or "").strip() or DEFAULT_EMAIL_SUBJECT,
        "email_body": (row.get("email_body") or "").strip() or DEFAULT_EMAIL_BODY,
        "updated_at": row.get("updated_at"),
        "updated_by": row.get("updated_by"),
    }


async def branch_portal_mode(branch_id: Optional[str]) -> str:
    """One branch's mode — "immediate" for a branch nobody has set, which is the default."""
    if not branch_id:
        return "immediate"
    row = await v3_col("portal_branch_settings").find_one({"branch_id": branch_id}, {"_id": 0, "mode": 1})
    mode = (row or {}).get("mode")
    return mode if mode in BRANCH_MODES else "immediate"


def _fill(template: str, values: dict) -> str:
    """Put the values into {placeholders} by plain replacement. Not str.format: the wording
    is typed by staff, and a stray { or } in it must not break every email that follows."""
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return template


async def _email_portal_login(lead: dict, login: dict) -> str:
    """Send a new portal login to the patient's inbox, and say what became of it.

    Returns "sent", "failed", "not_configured" (no SMTP credentials on this server) or
    "no_email". Never raises: the caller is a booking, and a mail server being down is
    not a reason for a patient's sessions not to be booked. The real SMTP error is logged
    by email_utils either way.

    Sent off the event loop — smtplib blocks, for up to its 20-second timeout, and every
    other request on this worker would otherwise wait out a slow mail server with it.

    Worded by the clinic-wide template. A template edited so that it no longer carries the
    login or the password still gets them, added at the end: an email that tells a patient
    their portal is ready without the means to open it is worse than no email.
    """
    if not login.get("email"):
        return "no_email"
    branch = {}
    if lead.get("branch_id"):
        branch = await v3_col("branches").find_one(
            {"id": lead["branch_id"]}, {"_id": 0, "branch_name": 1, "phone": 1},
        ) or {}
    login_lines = []
    if login.get("phone"):
        login_lines.append(f"Login (phone): {login['phone']}")
    login_lines.append(f"{'Or email' if login.get('phone') else 'Login (email)'}: {login['email']}")
    values = {
        "name": lead.get("name") or "there",
        "link": f"{FRONTEND_URL}/portal",
        "login": "\n".join(login_lines),
        "password": login["password"],
        "branch_help": (
            f"\nIf you cannot sign in, call {branch.get('branch_name') or 'your branch'} on {branch['phone']}."
            if branch.get("phone") else ""
        ),
    }
    settings = await portal_settings()
    body = _fill(settings["email_body"], values)
    if "{login}" not in settings["email_body"]:
        body += "\n\n" + values["login"]
    if "{password}" not in settings["email_body"]:
        body += f"\nPassword: {values['password']}"
    subject = _fill(settings["email_subject"], values)
    try:
        await asyncio.to_thread(send_email, login["email"], subject, body)
        return "sent"
    except SmtpNotConfigured:
        return "not_configured"
    except Exception:
        return "failed"


async def auto_portal_login_for_treatment(lead_id: str, user) -> dict:
    """Give a patient their Client Portal login the moment their treatment is booked.

    Called by the two routes that book a treatment course against a physio. What comes
    back rides on that route's response, so the desk sees the password once and can send
    it on WhatsApp; `status` says what happened:

      created     a new login, password included, emailed if the patient has an email
      joined      added to a family's existing login — same password, nothing to send
      exists      the patient already had one (a reassignment or rebooking); untouched
      pending     the branch approves logins first; queued on its Pending list
      off         turned off clinic-wide, or for this branch
      skipped     staff marked this patient "don't make a login automatically"
      no_contact  no 10-digit phone and no email on file, so nothing could be made
      error       something failed; logged, and the booking stands regardless

    No has_treatment check: the caller has just booked the treatment days, which is the
    thing that check exists to look for.
    """
    try:
        lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
        if not lead:
            return {"status": "error"}
        if await v3_col("patient_portal_accounts").find_one({"lead_id": lead_id}, {"_id": 0, "id": 1}):
            return {"status": "exists"}
        name = lead.get("name") or ""
        if lead.get("portal_auto_skip"):
            return {"status": "skipped", "patient_name": name}
        settings = await portal_settings()
        mode = await branch_portal_mode(lead.get("branch_id"))
        if not settings["auto_enabled"] or mode == "off":
            return {"status": "off", "patient_name": name}
        if mode == "approval":
            now = now_iso()
            # One open request per patient: booking again while it waits must not stack a
            # second copy of the same approval on the branch's list.
            await v3_col("portal_pending").update_one(
                {"lead_id": lead_id, "status": "pending"},
                {"$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "lead_id": lead_id,
                    "branch_id": lead.get("branch_id"),
                    "patient_name": name,
                    "phone": login_phone(lead.get("phone")),
                    "email": (lead.get("email") or "").strip().lower(),
                    "status": "pending",
                    "raised_at": now,
                    "raised_by": user.full_name,
                }},
                upsert=True,
            )
            await v3_col("lead_activity").insert_one({
                "id": str(uuid.uuid4()),
                "lead_id": lead_id,
                "action": "portal_login_pending",
                "details": "Client Portal login waiting for branch approval",
                "created_by": user.full_name,
                "created_by_role": user.role,
                "created_at": now,
            })
            return {"status": "pending", "patient_name": name}
        return await _make_and_send_portal_login(lead, user, "auto")
    except Exception:
        logging.getLogger(__name__).exception("Automatic Client Portal login failed for lead %s", lead_id)
        return {"status": "error"}


async def _make_and_send_portal_login(lead: dict, user, created_via: str) -> dict:
    """Make the login and email it, with no settings consulted — the automatic path has
    already decided it should happen, and approving a pending one is the branch deciding."""
    lead_id = lead["id"]
    phone = login_phone(lead.get("phone"))
    email = (lead.get("email") or "").strip().lower()
    if not phone and not email:
        await v3_col("lead_activity").insert_one({
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "action": "portal_account_skipped",
            "details": "Client Portal login not made: no 10-digit phone or email on file",
            "created_by": user.full_name,
            "created_by_role": user.role,
            "created_at": now_iso(),
        })
        return {"status": "no_contact", "patient_name": lead.get("name") or ""}

    login = await _save_portal_login(lead, user, phone, email, "", created_via)
    if login["joined_existing"]:
        return {"status": "joined", "patient_name": lead.get("name") or "", **login}

    email_status = await _email_portal_login(lead, login)
    await _record_email_status(lead_id, email, email_status, user)
    return {"status": "created", "email_status": email_status, "patient_name": lead.get("name") or "", **login}


async def _record_email_status(lead_id: str, email: str, email_status: str, user) -> None:
    """What became of a login email — on the account for the staff panel to show, and on
    the lead's activity so the history says whether the patient was actually sent it."""
    await v3_col("patient_portal_accounts").update_one(
        {"lead_id": lead_id}, {"$set": {"email_status": email_status, "email_status_at": now_iso()}},
    )
    if email_status == "no_email":
        return
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portal_login_emailed" if email_status == "sent" else "portal_login_email_failed",
        "details": (
            f"Client Portal login emailed to {email}" if email_status == "sent"
            else f"Client Portal login email to {email} not sent ({email_status.replace('_', ' ')})"
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })


# ------------------------------------------------------ Controls: settings, approval, per client

def _may_manage_branch(user, branch_id: Optional[str]) -> bool:
    """Super Admin and Business Development manage every branch; a Branch Admin their own."""
    if works_org_wide(user.role):
        return True
    return is_branch_admin_role(user.role) and bool(branch_id) and user.branch_id == branch_id


async def _scoped_lead(lead_id: str, user) -> dict:
    lead = await _lead_or_404(lead_id)
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Patient not found")
    return lead


@router.get("/portal-settings")
async def get_portal_controls(
    branch_id: Optional[str] = None,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Everything the Patients tab's portal card shows, and what this caller may change.

    A Branch Admin always reads their own branch, whatever `branch_id` asks for. What the
    card offers comes from `can_edit_clinic` and `branch_modes_allowed` here, so the rule
    lives in one place and the screen cannot drift from what the PUTs below enforce.
    """
    org_wide = works_org_wide(user.role)
    if not org_wide:
        branch_id = user.branch_id
    pending = []
    if branch_id:
        pending = await v3_col("portal_pending").find(
            {"branch_id": branch_id, "status": "pending"}, {"_id": 0},
        ).sort("raised_at", -1).to_list(200)
    return {
        **(await portal_settings()),
        "default_email_subject": DEFAULT_EMAIL_SUBJECT,
        "default_email_body": DEFAULT_EMAIL_BODY,
        "template_keys": list(EMAIL_TEMPLATE_KEYS),
        "can_edit_clinic": org_wide,
        "branch_id": branch_id,
        "branch_mode": await branch_portal_mode(branch_id),
        "branch_modes_allowed": list(BRANCH_MODES if org_wide else BRANCH_ADMIN_MODES),
        "pending": pending,
    }


class PortalClinicSettingsIn(BaseModel):
    auto_enabled: Optional[bool] = None
    # Blank means "back to the default wording".
    email_subject: Optional[str] = None
    email_body: Optional[str] = None


@router.put("/portal-settings/clinic")
async def save_portal_clinic_settings(
    payload: PortalClinicSettingsIn,
    user: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    updates = {}
    if payload.auto_enabled is not None:
        updates["auto_enabled"] = payload.auto_enabled
    if payload.email_subject is not None:
        updates["email_subject"] = payload.email_subject.strip()[:200]
    if payload.email_body is not None:
        updates["email_body"] = payload.email_body.strip()[:5000]
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to save")
    updates.update({"updated_at": now_iso(), "updated_by": user.full_name})
    await v3_col("portal_settings").update_one({"id": PORTAL_SETTINGS_ID}, {"$set": updates}, upsert=True)
    return await portal_settings()


class PortalBranchModeIn(BaseModel):
    mode: str


@router.put("/portal-settings/branch/{branch_id}")
async def save_portal_branch_mode(
    branch_id: str,
    payload: PortalBranchModeIn,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Set how one branch handles automatic logins.

    A Branch Admin may choose between sending immediately and waiting for approval. Off is
    not theirs to choose, and neither is undoing it: a branch Super Admin has switched off
    stays off until an org-wide desk switches it back.
    """
    if not _may_manage_branch(user, branch_id):
        raise HTTPException(status_code=404, detail="Branch not found")
    mode = (payload.mode or "").strip().lower()
    if mode not in BRANCH_MODES:
        raise HTTPException(status_code=400, detail="Mode must be immediate, approval or off")
    if not works_org_wide(user.role):
        if mode not in BRANCH_ADMIN_MODES:
            raise HTTPException(status_code=403, detail="Only Super Admin or Business Development can turn automatic portal login off")
        if await branch_portal_mode(branch_id) == "off":
            raise HTTPException(status_code=403, detail="Super Admin turned automatic portal login off for this branch — only they can turn it back on")
    await v3_col("portal_branch_settings").update_one(
        {"branch_id": branch_id},
        {"$set": {"branch_id": branch_id, "mode": mode, "updated_at": now_iso(), "updated_by": user.full_name}},
        upsert=True,
    )
    return {"branch_id": branch_id, "mode": mode}


async def _open_pending(pending_id: str, user) -> dict:
    row = await v3_col("portal_pending").find_one({"id": pending_id, "status": "pending"}, {"_id": 0})
    if not row or not _may_manage_branch(user, row.get("branch_id")):
        raise HTTPException(status_code=404, detail="This request is no longer waiting")
    return row


async def _close_pending(pending_id: str, status: str, user) -> None:
    await v3_col("portal_pending").update_one(
        {"id": pending_id},
        {"$set": {"status": status, "closed_at": now_iso(), "closed_by": user.full_name}},
    )


@router.post("/portal-pending/{pending_id}/approve")
async def approve_portal_pending(
    pending_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Make and send a login that was waiting. Answers in the same shape the booking does,
    so the desk gets the same popup with the password and Send on WhatsApp.

    The request stays open when nothing could be made (no phone or email yet): fixing the
    patient's details and approving again is the obvious next move, and closing it would
    lose the one reminder that this patient still has no login.
    """
    row = await _open_pending(pending_id, user)
    lead = await v3_col("leads").find_one({"id": row["lead_id"]}, {"_id": 0})
    if not lead:
        await _close_pending(pending_id, "dismissed", user)
        raise HTTPException(status_code=404, detail="Patient not found")
    if await v3_col("patient_portal_accounts").find_one({"lead_id": lead["id"]}, {"_id": 0, "id": 1}):
        await _close_pending(pending_id, "approved", user)
        return {"status": "exists", "patient_name": lead.get("name") or ""}
    result = await _make_and_send_portal_login(lead, user, "approved")
    if result["status"] in ("created", "joined"):
        await _close_pending(pending_id, "approved", user)
    return result


@router.post("/portal-pending/{pending_id}/dismiss")
async def dismiss_portal_pending(
    pending_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    row = await _open_pending(pending_id, user)
    await _close_pending(pending_id, "dismissed", user)
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": row["lead_id"],
        "action": "portal_login_pending_dismissed",
        "details": "Client Portal login request dismissed — no login made",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    return {"status": "dismissed"}


@router.post("/leads/{lead_id}/portal-account/email")
async def email_portal_login_again(
    lead_id: str,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Resend the login by email.

    A password is only ever stored hashed, so there is nothing to send again as it was:
    this is a reset that emails the new one. Like every reset it changes the password for
    the whole family on that login — the panel warns before the click.
    """
    lead = await _scoped_lead(lead_id, user)
    account = await v3_col("patient_portal_accounts").find_one({"lead_id": lead_id}, {"_id": 0})
    if not account:
        raise HTTPException(status_code=404, detail="This patient has no portal login yet")
    if account.get("blocked"):
        raise HTTPException(status_code=400, detail="Unblock this login before sending it again")
    email = (account.get("email") or lead.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="No email on this login — share it on WhatsApp instead")
    login = await _save_portal_login(lead, user, account.get("phone") or "", email, "", "manual")
    email_status = await _email_portal_login(lead, login)
    await _record_email_status(lead_id, email, email_status, user)
    return {"status": "created", "email_status": email_status, "patient_name": lead.get("name") or "", **login}


class PortalBlockIn(BaseModel):
    blocked: bool


@router.post("/leads/{lead_id}/portal-account/block")
async def set_portal_account_blocked(
    lead_id: str,
    payload: PortalBlockIn,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Pause or restore one patient's portal access.

    Blocking signs them out everywhere now rather than at their next login, which means
    ending every session that can reach this patient — including a family member's, who
    simply signs in again and no longer finds this patient on their list.
    """
    await _scoped_lead(lead_id, user)
    account = await v3_col("patient_portal_accounts").find_one({"lead_id": lead_id}, {"_id": 0, "id": 1})
    if not account:
        raise HTTPException(status_code=404, detail="This patient has no portal login yet")
    now = now_iso()
    if payload.blocked:
        await v3_col("patient_portal_accounts").update_one(
            {"lead_id": lead_id}, {"$set": {"blocked": True, "blocked_at": now, "blocked_by": user.full_name}},
        )
        await v3_col("patient_portal_sessions").delete_many({"$or": [{"lead_id": lead_id}, {"lead_ids": lead_id}]})
    else:
        await v3_col("patient_portal_accounts").update_one(
            {"lead_id": lead_id}, {"$set": {"blocked": False, "unblocked_at": now, "unblocked_by": user.full_name}},
        )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portal_account_blocked" if payload.blocked else "portal_account_unblocked",
        "details": "Client Portal access blocked" if payload.blocked else "Client Portal access restored",
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"blocked": payload.blocked}


class PortalAutoSkipIn(BaseModel):
    skip: bool


@router.put("/leads/{lead_id}/portal-auto")
async def set_portal_auto_skip(
    lead_id: str,
    payload: PortalAutoSkipIn,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Don't make this patient a login automatically. Generate Portal Access by hand still
    works; this only stops the booking from doing it. Turning it on also clears an approval
    already waiting for them, which would otherwise make the login this just ruled out."""
    await _scoped_lead(lead_id, user)
    now = now_iso()
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"portal_auto_skip": payload.skip, "updated_at": now}})
    if payload.skip:
        await v3_col("portal_pending").update_many(
            {"lead_id": lead_id, "status": "pending"},
            {"$set": {"status": "dismissed", "closed_at": now, "closed_by": user.full_name}},
        )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portal_auto_skip_on" if payload.skip else "portal_auto_skip_off",
        "details": (
            "Client Portal login will not be made automatically for this patient" if payload.skip
            else "Client Portal login will be made automatically again for this patient"
        ),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now,
    })
    return {"portal_auto_skip": payload.skip}


# --------------------------------------------------------------------- Patient: log in

async def _start_portal_session(accounts: list) -> dict:
    """One session for every patient the credentials opened.

    The session carries the whole list and one of them as the active patient. Every portal
    route keeps reading `lead_id` exactly as before, so nothing downstream knows families
    exist; switching patients rewrites that one field, and only to a lead in `lead_ids`,
    which was fixed here from accounts whose password actually matched.
    """
    patients = await _patients_for([a["lead_id"] for a in accounts])
    if not patients:
        raise HTTPException(status_code=401, detail="Invalid phone/email or password")
    by_lead = {a["lead_id"]: a for a in accounts}
    lead_ids = [p["lead_id"] for p in patients]
    # These patients' sessions past their twelve hours (login_guard.py) are dead anyway.
    await v3_col("patient_portal_sessions").delete_many({
        "$or": [{"lead_id": {"$in": lead_ids}}, {"lead_ids": {"$in": lead_ids}}],
        "created_at": {"$lt": login_guard.expired_before()},
    })
    token = str(uuid.uuid4())
    await v3_col("patient_portal_sessions").insert_one({
        "token": token,
        "account_id": by_lead[patients[0]["lead_id"]]["id"],
        "lead_id": patients[0]["lead_id"],
        "lead_ids": lead_ids,
        "created_at": now_iso(),
    })
    return {
        "token": token,
        "lead_id": patients[0]["lead_id"],
        "patient_name": patients[0]["name"],
        "patients": patients,
        "needs_choice": len(patients) > 1,
    }


def _login_query(identifier: str) -> Optional[dict]:
    """What a typed login is looked up by: an email if it has an @, else a phone number."""
    identifier = (identifier or "").strip()
    if "@" in identifier:
        return {"email": identifier.lower()}
    phone = login_phone(identifier)
    return {"phone": phone} if phone else None


@router.post("/patient-portal/login")
async def patient_portal_login(payload: V3PatientPortalLogin):
    """Phone number or email, and the password.

    Several accounts can answer one login (a family on one number), and each is checked
    against the password on its own rather than assuming they agree — an account left
    behind on an older password does not get opened by the newer one.
    """
    query = _login_query(payload.login or payload.email or "")
    if not query or not payload.password:
        raise HTTPException(status_code=401, detail="Invalid phone/email or password")
    # Five wrong passwords lock this phone or email for ten minutes (login_guard.py). Keyed
    # on the normalised login, so "98400 12345" and "+919840012345" share one count.
    attempt_key = f"portal:{query.get('email') or query.get('phone')}"
    await login_guard.count_try(attempt_key)
    accounts = await v3_col("patient_portal_accounts").find(query, {"_id": 0}).to_list(50)
    matched = [a for a in accounts if verify_password(payload.password, a.get("password_hash", ""))]
    if not matched:
        await login_guard.refuse(attempt_key, "Invalid phone/email or password")
    await login_guard.clear(attempt_key)
    return await _start_portal_session(_unblocked(matched))


# What a patient whose access has been paused is told. Only after the password has matched:
# said to anyone typing a number, it would confirm that number belongs to a patient.
PORTAL_PAUSED = "Your portal access is paused. Please contact your branch."


def _unblocked(accounts: list) -> list:
    """The accounts a sign-in may open. A family member who is blocked drops off the list
    while the rest still get in; only when every one of them is blocked is the sign-in
    refused, and then with the paused message rather than "wrong password"."""
    open_accounts = [a for a in accounts if not a.get("blocked")]
    if not open_accounts:
        raise HTTPException(status_code=403, detail=PORTAL_PAUSED)
    return open_accounts


@router.post("/patient-portal/google-login")
async def patient_portal_google_login(payload: V3PatientPortalGoogleLogin):
    """Sign-in with Google — does NOT create accounts. A patient only gets in this way
    if their Google account's email already matches a portal account a Branch Admin
    created for them; this keeps the "who can log in" decision where it already lives
    (treatment_fee_paid + Branch Admin action), same as the email/password path."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google Sign-In is not configured for this clinic yet")
    try:
        claims = google_id_token.verify_oauth2_token(payload.credential, _google_request, GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(status_code=401, detail="Could not verify Google sign-in")

    if not claims.get("email_verified"):
        raise HTTPException(status_code=401, detail="Google account email is not verified")

    email = claims["email"].strip().lower()
    accounts = await v3_col("patient_portal_accounts").find({"email": email}, {"_id": 0}).to_list(50)
    if not accounts:
        raise HTTPException(
            status_code=404,
            detail="No portal account found for this Google account. Ask your clinic to share your portal login.",
        )
    return await _start_portal_session(_unblocked(accounts))


async def _portal_session(authorization: str) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1].strip()
    session = await v3_col("patient_portal_sessions").find_one(
        {"token": token}, {"_id": 0, "token": 1, "lead_id": 1, "lead_ids": 1, "created_at": 1},
    )
    # Twelve hours from sign-in, in use or not -- see login_guard.py.
    if not session or login_guard.session_expired(session):
        if session:
            await v3_col("patient_portal_sessions").delete_one({"token": token})
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    return session


async def _current_patient_lead_id(authorization: str = Header(...)) -> str:
    return (await _portal_session(authorization))["lead_id"]


@router.get("/patient-portal/patients")
async def patient_portal_patients(authorization: str = Header(...)):
    """Every patient this sign-in may look at, and which one it is looking at now.

    A session from before families existed has no `lead_ids`, and reads as the one patient
    it was opened for.
    """
    session = await _portal_session(authorization)
    return {
        "active_lead_id": session["lead_id"],
        "patients": await _patients_for(session.get("lead_ids") or [session["lead_id"]]),
    }


@router.post("/patient-portal/switch")
async def patient_portal_switch(payload: V3PatientPortalSwitch, authorization: str = Header(...)):
    """Point this session at another patient on the same login.

    Only to a lead the session was opened with — the list was fixed at sign-in from the
    accounts the password matched, and a lead id from the body is never trusted beyond it.
    The account is looked up again as well, so a patient whose portal access was removed
    after sign-in cannot be switched back to.
    """
    session = await _portal_session(authorization)
    allowed = session.get("lead_ids") or [session["lead_id"]]
    if payload.lead_id not in allowed:
        raise HTTPException(status_code=404, detail="Patient not found")
    account = await v3_col("patient_portal_accounts").find_one(
        {"lead_id": payload.lead_id}, {"_id": 0, "id": 1, "blocked": 1},
    )
    patients = await _patients_for([payload.lead_id])
    if not account or not patients:
        raise HTTPException(status_code=404, detail="Patient not found")
    if account.get("blocked"):
        raise HTTPException(status_code=403, detail=PORTAL_PAUSED)
    await v3_col("patient_portal_sessions").update_one(
        {"token": session["token"]},
        {"$set": {"lead_id": payload.lead_id, "account_id": account["id"]}},
    )
    return {"lead_id": payload.lead_id, "patient_name": patients[0]["name"]}


PORTAL_PASSWORD_MIN = 6


@router.post("/patient-portal/change-password")
async def patient_portal_change_password(payload: V3PatientPortalChangePassword, authorization: str = Header(...)):
    """Refused. Portal passwords are set by the Super Admin or Branch Admin only; the portal
    no longer offers this, and a hand-made request is turned away rather than honoured."""
    await _portal_session(authorization)
    raise HTTPException(status_code=403, detail="Your password is managed by the clinic. Please contact your branch.")


# ------------------------------------------------------- Patient: forgot password (OTP)
#
# The same safeguards as the staff flow in v3_password_reset.py: a 6-digit code stored
# only as a hash, 5 minutes to use it, 5 wrong tries, one request a minute and five an
# hour per login. The code goes to email because no SMS or WhatsApp gateway is set up;
# phone is still how the patient names their login.

PORTAL_OTP_TTL_MINUTES = 5
PORTAL_OTP_MAX_ATTEMPTS = 5
PORTAL_RESET_COOLDOWN_SECONDS = 60
PORTAL_RESET_MAX_PER_HOUR = 5


class PortalForgotIn(BaseModel):
    login: str


class PortalVerifyOtpIn(BaseModel):
    request_id: str
    otp: str


class PortalResetIn(BaseModel):
    reset_token: str
    new_password: str
    confirm_password: str


def _expired(iso: str) -> bool:
    return datetime.fromisoformat(iso) < now_utc()


@router.post("/patient-portal/forgot-password")
async def patient_portal_forgot_password(payload: PortalForgotIn):
    """Email a one-time code to the patient who has lost their password.

    One login answers for a whole family, so the reset covers every account on that phone
    or email — the same reach a branch reset has. A login nobody holds gets the same reply
    as a real one, so this cannot be used to find out who is a patient.
    """
    query = _login_query(payload.login)
    if not query:
        raise HTTPException(status_code=400, detail="Enter the phone number or email you sign in with")
    key = query.get("phone") or query.get("email")
    requests_col = v3_col("patient_portal_reset_requests")

    window_start = (now_utc() - timedelta(hours=1)).isoformat()
    if await requests_col.count_documents({"login": key, "created_at": {"$gte": window_start}}) >= PORTAL_RESET_MAX_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many reset requests. Please try again later.")
    last = await requests_col.find_one({"login": key}, {"_id": 0, "created_at": 1}, sort=[("created_at", -1)])
    if last:
        elapsed = (now_utc() - datetime.fromisoformat(last["created_at"])).total_seconds()
        if elapsed < PORTAL_RESET_COOLDOWN_SECONDS:
            raise HTTPException(status_code=429, detail=f"Please wait {int(PORTAL_RESET_COOLDOWN_SECONDS - elapsed)}s before requesting another code")

    accounts = await v3_col("patient_portal_accounts").find(
        {**query, "blocked": {"$ne": True}}, {"_id": 0, "id": 1, "lead_id": 1, "email": 1},
    ).to_list(50)
    request_id = str(uuid.uuid4())
    doc = {
        "id": request_id,
        "login": key,
        "account_ids": [a["id"] for a in accounts],
        "attempts": 0,
        "verified": False,
        "consumed": False,
        "created_at": now_iso(),
        "expires_at": (now_utc() + timedelta(minutes=PORTAL_OTP_TTL_MINUTES)).isoformat(),
    }
    if not accounts:
        await requests_col.insert_one(doc.copy())
        return {"request_id": request_id, "message": "If this login is registered, a 6-digit code has been sent to its email."}

    email = query.get("email") or next((a["email"] for a in accounts if a.get("email")), "")
    if not email:
        lead = await v3_col("leads").find_one(
            {"id": {"$in": [a["lead_id"] for a in accounts]}, "email": {"$nin": [None, ""]}}, {"_id": 0, "email": 1},
        )
        email = ((lead or {}).get("email") or "").strip().lower()
    if not email:
        raise HTTPException(
            status_code=400,
            detail="No email is on file for this login, so a code cannot be sent. Please contact your branch to reset your password.",
        )

    otp = f"{secrets.randbelow(1000000):06d}"
    doc["otp_hash"] = _hash_token(otp)
    await asyncio.to_thread(
        _send_or_503,
        email,
        "FitsiomaxOS Client Portal — Password reset code",
        (
            "Hello,\n\n"
            "A password reset was requested for your FitsiomaxOS Client Portal login.\n\n"
            f"Your code: {otp}\n"
            f"It expires in {PORTAL_OTP_TTL_MINUTES} minutes.\n\n"
            "If you did not ask for this, ignore this email — your password will not change."
        ),
    )
    await requests_col.insert_one(doc.copy())
    return {"request_id": request_id, "message": f"A 6-digit code has been sent to {_mask_email(email)}"}


@router.post("/patient-portal/verify-reset-otp")
async def patient_portal_verify_reset_otp(payload: PortalVerifyOtpIn):
    requests_col = v3_col("patient_portal_reset_requests")
    req = await requests_col.find_one({"id": payload.request_id}, {"_id": 0})
    if not req or not req.get("otp_hash") or req.get("consumed") or req.get("verified"):
        raise HTTPException(status_code=400, detail="Incorrect code. Please check it or request a new one.")
    if _expired(req["expires_at"]):
        raise HTTPException(status_code=400, detail="This code has expired. Please request a new one.")
    if req.get("attempts", 0) >= PORTAL_OTP_MAX_ATTEMPTS:
        raise HTTPException(status_code=400, detail="Too many incorrect attempts. Please request a new code.")
    if not secrets.compare_digest(_hash_token((payload.otp or "").strip()), req["otp_hash"]):
        await requests_col.update_one({"id": req["id"]}, {"$inc": {"attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code. Please check it or request a new one.")

    reset_token = secrets.token_urlsafe(32)
    await requests_col.update_one({"id": req["id"]}, {"$set": {
        "verified": True,
        "reset_token_hash": _hash_token(reset_token),
        "expires_at": (now_utc() + timedelta(minutes=10)).isoformat(),
    }})
    return {"reset_token": reset_token}


@router.post("/patient-portal/reset-password")
async def patient_portal_reset_password(payload: PortalResetIn):
    if payload.new_password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="New passwords do not match")
    if len(payload.new_password or "") < PORTAL_PASSWORD_MIN:
        raise HTTPException(status_code=400, detail=f"New password must be at least {PORTAL_PASSWORD_MIN} characters")

    requests_col = v3_col("patient_portal_reset_requests")
    req = await requests_col.find_one(
        {"reset_token_hash": _hash_token(payload.reset_token or ""), "verified": True, "consumed": False}, {"_id": 0},
    )
    if not req or _expired(req["expires_at"]):
        raise HTTPException(status_code=400, detail="This reset has expired. Please start again.")

    accounts = await v3_col("patient_portal_accounts").find(
        {"id": {"$in": req.get("account_ids") or []}, "blocked": {"$ne": True}}, {"_id": 0, "id": 1, "lead_id": 1},
    ).to_list(50)
    if not accounts:
        raise HTTPException(status_code=400, detail="This login is not available. Please contact your branch.")

    now = now_iso()
    lead_ids = [a["lead_id"] for a in accounts]
    await v3_col("patient_portal_accounts").update_many(
        {"id": {"$in": [a["id"] for a in accounts]}},
        {"$set": {
            "password_hash": hash_password(payload.new_password),
            # In step with the hash, so the desk is never read out a password the patient
            # has since replaced with one of their own.
            "password_sealed": await seal_password(payload.new_password),
            "updated_at": now,
            "updated_by": "Patient",
        }},
    )
    # Every open sign-in on these patients ends: whoever had the old password is out.
    await v3_col("patient_portal_sessions").delete_many({"$or": [{"lead_id": {"$in": lead_ids}}, {"lead_ids": {"$in": lead_ids}}]})
    await requests_col.update_one({"id": req["id"]}, {"$set": {"consumed": True, "consumed_at": now}})
    await v3_col("lead_activity").insert_many([{
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "portal_password_reset_otp",
        "details": "Client Portal password reset by the patient with an emailed code",
        "created_by": "Patient",
        "created_by_role": "patient",
        "created_at": now,
    } for lead_id in lead_ids])
    return {"message": "Password reset. Please sign in with your new password."}


@router.post("/patient-portal/logout")
async def patient_portal_logout(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        return {"message": "Logged out"}
    token = authorization.split(" ", 1)[1].strip()
    await v3_col("patient_portal_sessions").delete_one({"token": token})
    return {"message": "Logged out"}


async def _diet_chart_for_patient(lead: dict) -> dict:
    """What the Client Portal may say about this patient's Diet Chart.

    The one rule, in one place: the chart is shown once the Diet Chart Fee is collected and
    not before. The coach can prepare and send it whenever their work reaches them — it sits
    here complete and invisible until the desk takes the money.

    Read live off the lead every time it is asked, never off a flag written when the chart
    was sent. A "shared" flag set at send time would be a copy of a payment state that can
    still change, and the first refund or corrected collection would leave a patient reading
    a chart they had not paid for with nothing in the system saying why.

    Unpaid, the patient is told a chart is waiting rather than told nothing. Silence would
    have them ringing the branch to ask whether the Nutritionist had forgotten them, when
    the actual answer is a fee at the desk. Nothing identifying the chart goes out with that
    — no document id, no filename — because the id is the key to the download route.
    """
    paid = lead.get("diet_chart_fee_paid") is not None
    doc = await v3_col("lead_documents").find_one(
        {"lead_id": lead["id"], "kind": DIET_CHART}, {"_id": 0}, sort=[("created_at", -1)]
    )
    if not doc:
        return {"available": False, "awaiting_payment": False}
    if not paid:
        return {"available": False, "awaiting_payment": True}
    return {
        "available": True,
        "awaiting_payment": False,
        "document_id": doc.get("id"),
        "original_name": doc.get("original_name"),
        "content_type": doc.get("content_type"),
        "size_bytes": doc.get("size_bytes"),
        "sent_at": lead.get("diet_chart_sent_at") or doc.get("created_at"),
        "sent_by": lead.get("diet_chart_sent_by") or doc.get("uploaded_by"),
    }


async def _build_portal_payload(lead: dict) -> dict:
    """Everything all four Client Portal tabs (Sessions / Treatment / Payment History /
    Profile) render from — shared by the patient's own `/patient-portal/me` and staff's
    `/leads/{lead_id}/portal-preview`, so a Super Admin looking at a patient's Operations
    board sees exactly what that patient sees, not a second hand-maintained copy of it."""
    lead_id = lead["id"]

    # `sessions` is physio treatment days only — diet check-ins live in their own
    # collection, so nothing here can miscount one as the other.
    sessions = await v3_col("sessions").find({"lead_id": lead_id}, {"_id": 0}).sort("slot_time", 1).to_list(500)
    assessments = await v3_col("weekly_assessments").find({"lead_id": lead_id}, {"_id": 0}).sort("week_number", 1).to_list(100)
    reviews = await v3_col("reviews").find({"lead_id": lead_id}, {"_id": 0}).sort("raised_at", 1).to_list(50)
    review_numbers = review_numbers_for_lead(reviews)
    diet_days = await v3_col("diet_sessions").find({"lead_id": lead_id}, {"_id": 0}).sort("slot_time", 1).to_list(200)
    # The rehab course, which this page has never shown. A patient booked onto rehab saw
    # nothing of it here: not the days, not the physio, not the remarks written against
    # them — and the fee for it has been on the Payment tab the whole time, so the one
    # screen that told them what they had paid for showed a charge with no course behind it.
    #
    # Its own collection and its own block, for the reason v3_rehab's docstring gives at
    # length: `sessions` is read in forty-odd places as treatment days, and folding rehab
    # into it would fire a physio's week-one review three days early. They are two courses
    # that share a physio and a calendar, so they are counted apart here too — the tiles
    # above stay the treatment package's, exactly as the diet block leaves them alone.
    rehab_days = await v3_col("rehab_sessions").find(
        {"lead_id": lead_id}, {"_id": 0}
    ).sort("slot_time", 1).to_list(200)
    # The video room each of these is held in, joined on at read rather than copied onto
    # every row when the days were booked.
    #
    # Read live on purpose, which is the opposite of what a consultation does. A
    # consultation freezes the link onto the appointment because the patient was sent a
    # confirmation naming it, and moving a meeting somebody has already been told about is
    # not something a later edit should be able to do. Nothing is sent for these: the
    # patient reads this page, so the room it shows should be the room the expert is in
    # today. An online physio changing their room otherwise leaves thirty booked days
    # pointing at a room nobody will be in.
    #
    # Blank for a branch's own physio, who has no room recorded because the field is only
    # offered to the online arms — which is exactly right. Their patient comes to the
    # branch, and a join link on that day would be an invitation to somewhere nobody is.
    expert_ids = {s.get("physio_id") for s in sessions if s.get("physio_id")}
    expert_ids |= {d.get("coach_id") for d in diet_days if d.get("coach_id")}
    expert_ids |= {r.get("physio_id") for r in rehab_days if r.get("physio_id")}
    meet_by_expert: Dict[str, str] = {}
    if expert_ids:
        async for d in v3_col("doctors").find(
            {"id": {"$in": list(expert_ids)}}, {"_id": 0, "id": 1, "meet_link": 1},
        ):
            link = str(d.get("meet_link") or "").strip()
            if link:
                meet_by_expert[d["id"]] = link
    for s in sessions:
        s["meet_link"] = meet_by_expert.get(s.get("physio_id"), "")
    for d in diet_days:
        d["meet_link"] = meet_by_expert.get(d.get("coach_id"), "")
    for r in rehab_days:
        r["meet_link"] = meet_by_expert.get(r.get("physio_id"), "")
    # The coach on the lead rather than on a day, because the diet card shows one
    # appointment rather than a list — and the days above may not exist yet when the first
    # one is booked from the consultation.
    diet_meet_link = ""
    if lead.get("diet_coach_id"):
        coach_row = await v3_col("doctors").find_one(
            {"id": lead["diet_coach_id"]}, {"_id": 0, "meet_link": 1},
        )
        diet_meet_link = str((coach_row or {}).get("meet_link") or "").strip()

    total = len(sessions)
    completed = len([s for s in sessions if s.get("status") == "completed"])

    # Who may be written to on the Feedback tab. Resolved beside the branch lookup because
    # it is the same kind of fact about this patient: who answers for their care.
    consultant = await consultant_of_lead(lead)

    # A count for the Feedback tab's own badge in the bottom nav: threads where the clinic
    # has written back since the patient last opened the tab. patient_seen_at is stamped by
    # patient_portal_my_feedback (the GET the tab fires on open), so the badge clears the
    # moment they look — it counts new replies, not open conversations. Rows with no staff
    # message yet, or seen since the last one, don't count.
    # Weekly review threads are the staff's record of the client's review, not a chat the
    # portal shows, so a reply on one must not light a badge the client cannot clear.
    fb_rows = await v3_col("patient_feedback").find(
        {"lead_id": lead_id, "audience": {"$ne": AUDIENCE_WEEKLY_REVIEW}},
        {"_id": 0, "id": 1, "messages": 1, "message": 1, "reply": 1,
         "replied_at": 1, "handled_at": 1, "patient_name": 1, "created_at": 1,
         "patient_seen_at": 1},
    ).to_list(200)
    feedback_unread = 0
    for r in fb_rows:
        staff_times = [
            (m.get("created_at") or "") for m in _thread(r) if m.get("author") == AUTHOR_STAFF
        ]
        last_staff = max(staff_times) if staff_times else ""
        if last_staff and (r.get("patient_seen_at") or "") < last_staff:
            feedback_unread += 1

    branch = {}
    if lead.get("branch_id"):
        branch = await v3_col("branches").find_one(
            {"id": lead["branch_id"]}, {"_id": 0, "branch_name": 1, "phone": 1, "address": 1}
        ) or {}

    # Every Treatment Fee installment collected so far, split into what's actually
    # been paid vs the next thing due — same math the Physio's own Payment History
    # tab and Branch Admin's Outstanding Amount board use.
    installments = (lead.get("treatment_fee_payment_details") or {}).get("installments") or []
    is_partial = lead.get("treatment_fee_payment_mode") == "partial"
    treatment_paid = (
        sum(i.get("amount", 0) for i in installments if i.get("paid")) if is_partial
        else (lead.get("treatment_fee_paid") or 0)
    )
    unpaid = sorted((i for i in installments if not i.get("paid")), key=lambda i: i.get("due_date", "")) if is_partial else []
    next_due = unpaid[0] if unpaid else None

    # Sessions paid for against sessions had, so the portal can say when treatment is on hold
    # for the balance and let the client ask the branch for more time.
    paid_cover = sessions_paid_for(lead)
    pay_hold = await payment_hold_for_lead(lead["id"]) if paid_cover else None
    ext = extension_of(lead) or {}
    session_payment = {
        "paid_sessions": paid_cover["paid_sessions"],
        "total_sessions": paid_cover["total_sessions"],
        "balance": paid_cover["balance"],
        "on_hold": bool(pay_hold),
        "completed_sessions": (pay_hold or {}).get("completed_sessions"),
        "extension_status": ext.get("status") or "",
        "extension_requested_due_date": ext.get("requested_due_date") or "",
        "extended_due_date": ext.get("extended_due_date") or "",
        "extension_decision_note": ext.get("decision_note") or "",
    } if paid_cover else None

    return {
        "patient_name": lead.get("name", "Unknown"),
        "phone": lead.get("phone", ""),
        "email": lead.get("email", ""),
        "patient_number": lead.get("patient_number"),
        "age": lead.get("age"),
        "gender": lead.get("gender"),
        "occupation": lead.get("occupation"),
        "address": lead.get("address"),
        "city": lead.get("city"),
        "state": lead.get("state"),
        "condition": lead.get("condition"),

        # Doctor detail card — physio_name from the session docs (same source the
        # Physio board itself uses); head_physio_name is informational only, no
        # contact info is ever included anywhere in this response on purpose.
        "physio_name": next((s.get("physio_name") for s in sessions if s.get("physio_name")), ""),
        "head_physio_name": next((s.get("head_physio_name") for s in sessions if s.get("head_physio_name")), ""),

        # Who Feedback may be addressed to. Read off the newest appointment rather than off
        # anything on the lead, because the appointment is what the consultant's own patient
        # list is built from -- see consultant_of_lead. A thread has to follow the record
        # that holds the patient or it arrives on a board that will not open it.
        "feedback_consultant_id": consultant["id"],
        "feedback_consultant_name": consultant["name"],
        "feedback_unread": feedback_unread,

        "branch_name": branch.get("branch_name", ""),
        "branch_phone": branch.get("phone", ""),
        "branch_address": branch.get("address", ""),

        "total_sessions": total,
        "completed_sessions": completed,
        "remaining_sessions": total - completed,
        "sessions": [
            {
                # The day's id, so the portal can attach the client's Physio Review to it.
                "id": s.get("id"),
                "session_number": s.get("session_number"),
                "week_number": s.get("week_number"),
                "slot_time": s.get("slot_time"),
                "status": s.get("status"),
                "jr_physio_remarks": s.get("jr_physio_remarks"),
                "rehab_remarks": s.get("rehab_remarks"),
                # The room this day is held in. Joined onto the row above since the day
                # video sessions existed, and dropped again right here: this projection
                # builds a fresh dict per session and never carried the field, so the
                # portal has been rendering a join button on a value that was always
                # undefined. The only meeting link that ever reached this page was the
                # diet block's, which is fetched separately further down.
                "meet_link": s.get("meet_link") or "",
            }
            for s in sessions
        ],
        "weekly_assessments": [
            {"week_number": a.get("week_number"), "jr_physio_notes": a.get("jr_physio_notes"), "status": a.get("status")}
            for a in assessments
        ],

        "diagnosis": lead.get("diagnosis"),
        "physio_diagnosis_report": lead.get("physio_diagnosis_report"),
        "treatment_summary": lead.get("treatment_summary"),
        "session_package_name": lead.get("session_package_name"),
        "session_package_sessions": lead.get("session_package_sessions"),

        # Numbered by the same rule the Physio board uses, so a patient reading their own
        # reviews and the physio reading theirs are looking at the same week numbers. The
        # arithmetic that was here divided the closing review down onto the week before it,
        # and, having no floor of 1, numbered a course shorter than a week "review 0".
        "reviews": [
            {
                "id": r.get("id"),
                "review_number": review_numbers.get(r.get("id"), 1),
                "status": r.get("status"),
                "review_date": r.get("review_date"),
                "head_physio_suggestions": r.get("head_physio_suggestions"),
            }
            for r in reviews
        ],

        # The diet side of the patient's care. Absent entirely until now, so a patient on a
        # diet plan had no sign of it here and — worse — no sign of the fee they paid for
        # it. Returned as its own block rather than folded into the physio numbers: they
        # are separate courses of care with separate clinicians.
        "diet": {
            "coach_name": lead.get("diet_coach_name"),
            "appointment_at": lead.get("diet_appointment_at"),
            # Where to join, for a check-in held over video. Empty for a coach seen at the
            # branch, which is every coach but an online arm's.
            "meet_link": diet_meet_link,
            "stage": lead.get("diet_stage"),
            # The coach's written plan — the diet counterpart of the physio's Diagnosis
            # Report, and the thing the patient is actually meant to follow.
            "consultation_report": lead.get("diet_consultation_report"),
            "consultation_report_at": lead.get("diet_consultation_report_at"),
            "consultation_report_by": lead.get("diet_consultation_report_by"),
            # The Diet Chart, and only if it has been paid for. See
            # _diet_chart_for_patient — the fee is read at the moment this is asked, so the
            # portal can never show a chart the money has not been taken for.
            #
            # Separate from consultation_report above, which is not gated and should not be:
            # that is the coach's write-up of an appointment the patient already paid to
            # attend. The chart is a product they buy on its own.
            "chart": await _diet_chart_for_patient(lead),
            "total_checkins": len(diet_days),
            "completed_checkins": len([d for d in diet_days if d.get("status") == "completed"]),
            "checkins": [
                {
                    "day_number": d.get("day_number"),
                    "slot_time": d.get("slot_time"),
                    "status": d.get("status"),
                    "coach_remarks": d.get("coach_remarks"),
                    "weight_kg": d.get("weight_kg"),
                    # Same omission as the sessions list above, and the same fix: a
                    # check-in held over video had its room joined on and then dropped.
                    "meet_link": d.get("meet_link") or "",
                }
                for d in diet_days
            ],
        },

        # The rehab course, beside the diet block and for the same reason it is beside it:
        # a separate course of care with its own days, its own count and its own fee, run
        # alongside the treatment package rather than inside it. Its physio may be the same
        # person delivering the treatment days; the course is not the same course.
        #
        # Named off the lead rather than off a day, so a patient assigned a rehab physio
        # before any day is booked still sees who they are with — the same thing the diet
        # block does with diet_coach_name.
        "rehab": {
            "physio_name": lead.get("rehab_physio_name"),
            "stage": lead.get("rehab_stage"),
            "total_days": len(rehab_days),
            "completed_days": len([r for r in rehab_days if r.get("status") == "completed"]),
            "days": [
                {
                    "id": r.get("id"),
                    "day_number": r.get("day_number"),
                    "total_days": r.get("total_days"),
                    "slot_time": r.get("slot_time"),
                    "status": r.get("status"),
                    "physio_remarks": r.get("physio_remarks"),
                    "meet_link": r.get("meet_link") or "",
                }
                for r in rehab_days
            ],
        },

        "payment": {
            "consultation_fee_total": lead.get("package_price"),
            "consultation_fee_paid": lead.get("package_paid"),
            "consultation_payment_mode": lead.get("package_payment_mode"),
            "treatment_fee_total": lead.get("session_package_price"),
            "treatment_fee_paid": treatment_paid,
            "treatment_payment_mode": lead.get("treatment_fee_payment_mode"),
            "is_partial": is_partial,
            "installments_total": len(installments),
            "installments_paid": len([i for i in installments if i.get("paid")]),
            "next_due_amount": next_due.get("amount") if next_due else None,
            "next_due_date": next_due.get("due_date") if next_due else None,
            "session_payment": session_payment,
            # The third fee. Left out, the portal's own Total was short by whatever the
            # patient paid for their diet consultation — a wrong number on the one screen
            # where the patient checks what they have been charged.
            "diet_package_name": lead.get("diet_package_name"),
            "diet_fee_total": lead.get("diet_package_price"),
            "diet_fee_paid": lead.get("diet_fee_paid"),
            "diet_payment_mode": lead.get("diet_fee_payment_mode"),
            # The fourth fee, and its own line rather than a sum into the diet one above. A
            # patient sold both a consultation and a chart would otherwise see a single
            # figure they cannot reconcile against either receipt, on the one screen whose
            # whole job is telling them what they have been charged for.
            "diet_chart_package_name": lead.get("diet_chart_package_name"),
            "diet_chart_fee_total": lead.get("diet_chart_package_price"),
            "diet_chart_fee_paid": lead.get("diet_chart_fee_paid"),
            "diet_chart_payment_mode": lead.get("diet_chart_fee_payment_mode"),
        },
    }


@router.get("/patient-portal/me")
async def patient_portal_me(lead_id: str = Depends(_current_patient_lead_id)):
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")
    return await _build_portal_payload(lead)


class V3PaymentExtensionRequestIn(BaseModel):
    requested_due_date: Optional[str] = None
    reason: Optional[str] = ""


@router.post("/patient-portal/payment-extension")
async def patient_portal_payment_extension(
    payload: V3PaymentExtensionRequestIn,
    lead_id: str = Depends(_current_patient_lead_id),
):
    """The client asking their branch for more time to pay the treatment balance. The Branch
    Admin approves it from the rupee bell, which lets the remaining sessions go ahead."""
    ext = await record_extension_request(lead_id, payload.requested_due_date, payload.reason or "")
    return {"extension_status": ext["status"], "requested_due_date": ext.get("requested_due_date") or ""}


class V3PatientFeedbackIn(BaseModel):
    rating: Optional[int] = None
    message: Optional[str] = ""
    # Who it is for: the branch that runs their care, Super Admin, or the consultant who
    # saw them. Anything unrecognised reads as the branch, which is where a patient who was
    # not asked would have sent it.
    audience: Optional[str] = None


# How many messages a patient may send to Super Admin, across all their threads. Branch
# Admin and Consultant have no limit.
SUPER_ADMIN_MESSAGE_LIMIT = 2


async def _super_admin_messages_sent(lead_id: str) -> int:
    rows = await v3_col("patient_feedback").find(
        {"lead_id": lead_id, "audience": AUDIENCE_SUPER}, {"_id": 0},
    ).to_list(200)
    return sum(1 for r in rows for m in _thread(r) if m.get("author") == AUTHOR_PATIENT)


async def _check_super_admin_limit(lead_id: str) -> None:
    if await _super_admin_messages_sent(lead_id) >= SUPER_ADMIN_MESSAGE_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"You can send only {SUPER_ADMIN_MESSAGE_LIMIT} messages to Super Admin. Please write to your Branch Admin.",
        )


@router.post("/patient-portal/feedback")
async def patient_portal_feedback(
    payload: V3PatientFeedbackIn,
    lead_id: str = Depends(_current_patient_lead_id),
):
    """What a patient thought, in their own words, from their own session.

    Written here rather than in the feedback router because this is the one place that
    knows which patient is asking -- the portal session is the identity, and taking a lead
    id from the body would let anybody file feedback as anybody.

    The patient and their branch are copied onto the row rather than looked up when the
    branch reads it. Feedback is a thing somebody said on a day: it should still name who
    said it after they have been moved to another branch, or after the lead behind it is
    gone.

    Refused when there is nothing to say. A rating with no words is a fine piece of
    feedback and is allowed; an empty form is a misclick.
    """
    message = (payload.message or "").strip()[:MAX_MESSAGE]
    rating = _rating(payload.rating)
    audience = _audience(payload.audience)
    # Weekly review threads are filed by the review itself, never chosen from this form.
    if audience == AUDIENCE_WEEKLY_REVIEW:
        audience = AUDIENCE_BRANCH
    # The words are the whole of it now: the portal stopped asking for a rating, because a
    # star out of five says something happened without saying what and a branch cannot act on
    # four stars. The field is still read for anything sent by an older app, and a row that
    # carries one keeps it.
    if not message:
        raise HTTPException(status_code=400, detail="Tell us how it went")
    if audience == AUDIENCE_SUPER:
        await _check_super_admin_limit(lead_id)

    lead = await _lead_or_404(lead_id)
    # Copied onto the row, like the patient and the branch beside it, and for the same
    # reason: this is a thing somebody said to a particular person on a day. Resolving it
    # when the consultant opens their board would hand the thread to whoever saw the patient
    # most recently by then, which is not who they wrote to.
    consultant = await consultant_of_lead(lead) if audience == AUDIENCE_CONSULTANT else {"id": "", "name": ""}
    if audience == AUDIENCE_CONSULTANT and not consultant["id"]:
        # The portal does not offer the card without one, so this is a stale tab or a
        # hand-made request. Falling back to the branch would be quietly showing it to the
        # people the patient chose not to write to.
        raise HTTPException(status_code=400, detail="You have not seen a consultant yet")
    row = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "branch_id": lead.get("branch_id"),
        # Empty on everything not addressed to a consultant, which is what their own read
        # filters on -- an unaddressed thread is nobody's inbox.
        "consultant_id": consultant["id"],
        "consultant_name": consultant["name"],
        "patient_name": (lead.get("name") or "").strip(),
        "patient_phone": (lead.get("phone") or "").strip(),
        "rating": rating,
        "message": message,
        "audience": audience,
        "status": STATUS_NEW,
        "note": "",
        "created_at": now_iso(),
    }
    # The first line of the conversation, not a field beside it. `message` stays written
    # as well: it is what every existing reader of this collection looks for, and the
    # thread is the same words rather than a second copy of a different truth.
    row["messages"] = [{
        "id": str(uuid.uuid4()),
        "author": AUTHOR_PATIENT,
        "author_name": row["patient_name"],
        "body": message,
        "created_at": row["created_at"],
    }]
    await v3_col("patient_feedback").insert_one(dict(row))
    # Says who has it, because the patient chose. "Your branch has it" over a complaint the
    # patient deliberately sent past the branch would be the one thing they were avoiding.
    if audience == AUDIENCE_SUPER:
        thanks = "Thank you — Super Admin has it."
    elif audience == AUDIENCE_CONSULTANT:
        # By name. The patient picked a person off a card with that name on it, and "your
        # consultant has it" would leave them wondering which one.
        thanks = f"Thank you — {consultant['name']} has it." if consultant["name"] else "Thank you — your consultant has it."
    else:
        thanks = "Thank you — your branch has it."
    return {"message": thanks, "feedback": row}


@router.get("/patient-portal/feedback")
async def patient_portal_my_feedback(lead_id: str = Depends(_current_patient_lead_id)):
    """What this patient has sent, and what has become of it.

    A patient who says something and hears nothing back assumes it went nowhere, and sends
    it again or stops sending. Showing the state of each one -- waiting, being looked at,
    finished -- is the smallest honest answer: it does not promise a reply, it says
    somebody has it.

    The reply comes back with it -- what the branch said when they closed it, which they
    wrote knowing the patient would read it. The note does not: that is the branch's working
    record of what they did, written to be read by colleagues, and putting it in front of
    the person it is about would change what gets written there.
    """
    rows = await v3_col("patient_feedback").find(
        {"lead_id": lead_id, "audience": {"$ne": AUDIENCE_WEEKLY_REVIEW}},
        {"_id": 0, "id": 1, "rating": 1, "message": 1, "status": 1, "created_at": 1,
         "audience": 1, "reply": 1, "replied_at": 1, "replied_by": 1, "patient_name": 1,
         "messages": 1},
    ).sort("created_at", -1).to_list(200)
    for row in rows:
        row["messages"] = _thread(row)
        # Whether the last word was theirs, so the portal can show which of these is
        # waiting on the clinic and which is waiting on them.
        last = row["messages"][-1] if row["messages"] else None
        row["awaiting_clinic"] = bool(last and last.get("author") == AUTHOR_PATIENT)
    # Opening this tab is reading it: stamp every thread seen now, which is what clears the
    # bottom-nav badge feedback_unread counts (see _build_portal_payload). One write per
    # tab-open rather than a per-thread mark — the tab shows all channels at once.
    if rows:
        await v3_col("patient_feedback").update_many(
            {"lead_id": lead_id}, {"$set": {"patient_seen_at": now_iso()}}
        )
    return {"feedback": rows}


class PortalFeedbackReplyIn(BaseModel):
    body: Optional[str] = ""
    # Answering the clinic's "did that settle it?". True closes the thread, False sends it
    # back to them. Left unset for an ordinary message that answers nothing.
    resolved: Optional[bool] = None


@router.post("/patient-portal/feedback/{feedback_id}/message")
async def patient_portal_feedback_reply(
    feedback_id: str,
    payload: PortalFeedbackReplyIn,
    lead_id: str = Depends(_current_patient_lead_id),
):
    """The patient's next word on their own thread.

    Their session is the identity here, as everywhere else in this router, and the thread
    has to be theirs — a feedback id from the body would otherwise let anybody write into
    anybody's conversation.

    `resolved` is the answer to being asked whether it was settled, and it is the only
    thing that closes a thread. The branch can say what it did and ask; whether that was
    enough is not theirs to decide, and a complaint marked dealt with by the person
    complained about is how somebody learns not to bother saying anything.

    Saying "not yet" hands it straight back rather than leaving it closed-with-a-caveat:
    In Progress is a column somebody works through, and Awaiting is one that waits.
    """
    row = await v3_col("patient_feedback").find_one(
        {"id": feedback_id, "lead_id": lead_id}, {"_id": 0}
    )
    if not row:
        raise HTTPException(status_code=404, detail="No such feedback")

    body = (payload.body or "").strip()[:MAX_MESSAGE]
    if payload.resolved is None and not body:
        raise HTTPException(status_code=400, detail="Write something to send")
    if body and _audience(row.get("audience")) == AUDIENCE_SUPER:
        await _check_super_admin_limit(lead_id)

    now = now_iso()
    thread = _thread(row)
    if body:
        thread = [*thread, {
            "id": str(uuid.uuid4()),
            "author": AUTHOR_PATIENT,
            "author_name": row.get("patient_name") or "",
            "body": body,
            "created_at": now,
        }]

    changes = {"messages": thread}
    if payload.resolved is True:
        changes.update({"status": STATUS_RESOLVED, "resolved_by_patient_at": now})
    elif payload.resolved is False:
        changes["status"] = STATUS_IN_PROGRESS
    elif row.get("status") == STATUS_RESOLVED:
        # Writing again on something closed opens it back up. The alternative is a message
        # nobody is looking at, in a column nobody works through.
        changes["status"] = STATUS_IN_PROGRESS

    await v3_col("patient_feedback").update_one({"id": feedback_id}, {"$set": changes})
    return {**row, **changes}


# --------------------------------------------------------------- Staff: preview a patient's
# --------------------------------------------------------------- own portal, without logging
# --------------------------------------------------------------- in as them

@router.get("/leads/{lead_id}/portal-preview")
async def staff_view_patient_portal(lead_id: str, user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev"))):
    """Operations' Client tab reaching a patient's own board the same way it already
    reaches a Physio's or Pre Sales rep's — no separate portal login needed, and (unlike
    the patient's own session) no password or account is involved at all."""
    lead = await _lead_or_404(lead_id)
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=404, detail="Patient not found")
    return await _build_portal_payload(lead)


# ------------------------------------------------------------------ Patient: own documents

@router.get("/patient-portal/documents")
async def patient_portal_documents(lead_id: str = Depends(_current_patient_lead_id)):
    """The patient's own documents, and only the ones the branch has shared.

    `lead_id` comes from the session token and is never accepted from the caller — the
    staff route takes it in the path, which is right there because staff legitimately read
    across patients, and would be a way to read anyone's file here.
    """
    docs = await v3_col("lead_documents").find(
        {"lead_id": lead_id}, {"_id": 0, "stored_name": 0}
    ).sort("created_at", -1).to_list(500)
    return {
        "documents": [
            {
                "id": d.get("id"),
                "label": d.get("label"),
                "original_name": d.get("original_name"),
                "kind": d.get("kind"),
                "content_type": d.get("content_type"),
                "size_bytes": d.get("size_bytes"),
                "created_at": d.get("created_at"),
            }
            for d in docs if is_shared_with_patient(d)
        ]
    }


@router.get("/patient-portal/diet-chart")
async def patient_portal_download_diet_chart(lead_id: str = Depends(_current_patient_lead_id)):
    """The Diet Chart's bytes, for the patient who paid for it.

    Its own route rather than a document id handed to the generic download above, and that
    is the point: the generic route decides by is_shared_with_patient, which is a flag on a
    row and cannot see what has been paid. This one re-reads the fee off the lead and
    refuses without it, so the gate holds on the bytes and not only on the screen that links
    to them.

    Takes no parameters at all. `lead_id` comes from the session token, and which chart is
    "the" chart is decided here rather than by the caller — there is nothing to pass, and so
    nothing to pass that belongs to somebody else.

    The same 404 whether the fee is unpaid or no chart exists. Which of the two it is tells
    a patient something about their own file that the portal has already said properly in
    the diet block; repeating it here as the difference between two error codes is just a
    way to probe.
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead or lead.get("diet_chart_fee_paid") is None:
        raise HTTPException(status_code=404, detail="No Diet Chart is available yet")
    doc = await v3_col("lead_documents").find_one(
        {"lead_id": lead_id, "kind": DIET_CHART}, {"_id": 0}, sort=[("created_at", -1)]
    )
    if not doc:
        raise HTTPException(status_code=404, detail="No Diet Chart is available yet")
    path = os.path.join(DOC_DIR, doc["stored_name"])
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(DOC_DIR) or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File is missing from storage")
    return FileResponse(path, media_type=doc.get("content_type"), filename=doc.get("original_name"))


@router.get("/patient-portal/documents/{doc_id}/download")
async def patient_portal_download_document(
    doc_id: str, lead_id: str = Depends(_current_patient_lead_id)
):
    """The bytes, for one of this patient's own shared documents.

    Three things have to hold, and each is checked rather than assumed: the document
    belongs to the lead this session is for, the branch has shared it, and the resolved
    path is still inside the documents folder. A document id on its own is not a key.
    """
    doc = await v3_col("lead_documents").find_one({"id": doc_id, "lead_id": lead_id}, {"_id": 0})
    if not doc or not is_shared_with_patient(doc):
        # The same 404 either way: "exists but is not shared with you" is itself something
        # a patient does not need told.
        raise HTTPException(status_code=404, detail="Document not found")
    path = os.path.join(DOC_DIR, doc["stored_name"])
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(DOC_DIR) or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File is missing from storage")
    return FileResponse(path, media_type=doc.get("content_type"), filename=doc.get("original_name"))
