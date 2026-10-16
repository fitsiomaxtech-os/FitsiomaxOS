"""Paid sessions running out — telling the branch when a client's treatment has used up
what they have paid for.

A Treatment Fee can be collected for only some of a package's sessions (12 of 14, say) with
the rest left as a balance installment on a due date. payment_reminders.py chases that
balance by date, by emailing the patient. Nothing looked at it by *session*: a client could
be given all 14 days while the balance for the last two sat unpaid, and the physio giving
them, the Branch Admin at the desk and the Accountant were never told.

So the rule here is counted in days of treatment, not calendar days:

    completed sessions >= sessions paid for, with a balance still owing  ->  "due"
    one paid session left                                                ->  "last_paid"

Worked out live from the lead and its completed sessions rather than stored, so a payment
clears the alert the moment it is collected and a client who crossed the line before this
existed (BALA TESTING, 14 given against 12 paid) shows up without a backfill.

Past that line the next treatment day is held, not just flagged: the physio's Complete is
refused (payment_hold_for_lead) until the balance is collected. The client can ask for more
time from their portal, and a Branch Admin can grant it — an extension moves the balance's
due date and lets the remaining days go ahead unpaid until that date.

Two ways it reaches people:
  * GET /api/v3/session-payment-alerts — the header's rupee bell, for Branch Admin (their
    branch), Super Admin and BDE (all).
  * notify_after_session_complete — called when a physio completes a treatment day. It
    logs the crossing on the client's timeline and, on the day the paid sessions run out,
    emails the branch's admins, the accountants and the physio (when SMTP is configured).
"""
import asyncio
import logging
import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import v3_col
from deps import v3_require_roles, is_branch_admin_role
from email_utils import send_email, smtp_configured
from schemas.v3 import V3UserOut
from utils import clinic_today, now_iso

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v3")

# Anything under a rupee is rounding left by a per-session rate, not money owed.
_BALANCE_EPSILON = 0.5


def sessions_paid_for(lead: dict, total_sessions: int = 0) -> Optional[dict]:
    """How many of this client's treatment sessions are paid for, or None when nothing is
    owed on the Treatment Fee.

    A collection for some of the sessions writes the count on each installment
    (`sessions`), which is exact even under a discount, so that is read first. A Partial
    Payment schedule carries amounts only; there the paid money is divided by the package's
    per-session rate, rounding down — a session half paid for is not paid for.
    """
    installments = (lead.get("treatment_fee_payment_details") or {}).get("installments") or []
    if not installments:
        return None
    unpaid = [i for i in installments if not i.get("paid")]
    balance = round(sum(float(i.get("amount") or 0) for i in unpaid), 2)
    if balance <= _BALANCE_EPSILON:
        return None

    total = int(lead.get("session_package_sessions") or 0) or int(total_sessions or 0)
    if total <= 0:
        return None

    paid_rows = [i for i in installments if i.get("paid")]
    paid_amount = round(sum(float(i.get("amount") or 0) for i in paid_rows), 2)
    if all(isinstance(i.get("sessions"), (int, float)) for i in installments):
        covered = int(sum(i["sessions"] for i in paid_rows))
    else:
        price = sum(float(i.get("amount") or 0) for i in installments) or float(lead.get("session_package_price") or 0)
        rate = price / total if price else 0
        covered = int((paid_amount + 0.01) // rate) if rate else 0
    covered = max(0, min(covered, total))

    next_due = sorted(unpaid, key=lambda i: i.get("due_date") or "")[0]
    return {
        "total_sessions": total,
        "paid_sessions": covered,
        "paid_amount": paid_amount,
        "balance": balance,
        "balance_due_date": next_due.get("due_date"),
    }


def payment_alert(lead: dict, completed: int, total_sessions: int = 0) -> Optional[dict]:
    """The alert for one client given how many treatment days they have had, or None."""
    paid = sessions_paid_for(lead, total_sessions)
    if not paid or completed <= 0:
        return None
    if completed >= paid["paid_sessions"]:
        level = "due"
    elif paid["paid_sessions"] - completed == 1:
        level = "last_paid"
    else:
        return None
    return {
        "lead_id": lead["id"],
        "name": lead.get("name") or "",
        "patient_number": lead.get("patient_number") or "",
        "phone": lead.get("phone") or "",
        "branch_id": lead.get("branch_id"),
        "assigned_physio_id": lead.get("assigned_physio_id"),
        "package_name": lead.get("session_package_name") or "",
        "completed_sessions": completed,
        "unpaid_sessions_given": max(0, completed - paid["paid_sessions"]),
        "level": level,
        "extension": extension_of(lead),
        "extension_active": extension_active(lead),
        **paid,
    }


def alert_message(alert: dict) -> str:
    """One line a person can act on, used for the toast, the timeline and the email."""
    name = alert.get("name") or "This client"
    paid, done = alert["paid_sessions"], alert["completed_sessions"]
    rs = f"Rs.{alert['balance']:,.0f}"
    ext = alert.get("extension") or {}
    if alert.get("extension_active"):
        return f"{name} has {paid} of {alert['total_sessions']} sessions paid — Branch Admin extended the balance of {rs} to {ext.get('extended_due_date') or '—'}; remaining sessions may go ahead."
    if ext.get("status") == "requested" and alert["level"] == "due":
        return f"{name} has used all {paid} paid sessions (balance {rs}) and has asked for more time to pay — approve or reject the request."
    if alert["level"] == "last_paid":
        return f"{name} has 1 paid session left ({paid} of {alert['total_sessions']} paid) — collect the balance of {rs} before session {paid + 1}."
    if done > paid and done >= alert["total_sessions"]:
        return f"{name} has finished all {done} sessions but paid for only {paid} — balance of {rs} is still due."
    if done > paid:
        return f"{name} has had {done} sessions but paid for only {paid} — balance of {rs} is due. Collect before the next session."
    return f"{name} has used all {paid} paid sessions — balance of {rs} is due before session {paid + 1}."


def extension_of(lead: dict) -> Optional[dict]:
    """The client's request for more time on the Treatment Fee balance, whatever its state."""
    ext = lead.get("session_payment_extension")
    return ext if isinstance(ext, dict) and ext.get("status") else None


def extension_active(lead: dict, today: Optional[str] = None) -> bool:
    """Whether a Branch Admin has let the remaining days go ahead unpaid, as of today.

    Good through the date they extended the balance to, inclusive. Past it the days are
    held again, the same as a due date that was never moved — the client can ask again.
    """
    ext = extension_of(lead)
    if not ext or ext.get("status") != "approved":
        return False
    until = (ext.get("extended_due_date") or "")[:10]
    return not until or until >= (today or clinic_today())


def payment_hold(lead: dict, completed: int, total_sessions: int = 0, today: Optional[str] = None) -> Optional[dict]:
    """Why the next treatment day may not be given, or None when it may.

    Held once every paid session has been used with a balance still owing, unless an
    extension is running. Same arithmetic as the alert, so the bell and the block agree.
    """
    paid = sessions_paid_for(lead, total_sessions)
    if not paid or completed < paid["paid_sessions"] or extension_active(lead, today):
        return None
    return {
        **paid,
        "completed_sessions": completed,
        "next_session": completed + 1,
        "extension": extension_of(lead),
    }


def payment_hold_message(hold: dict) -> str:
    rs = f"Rs.{hold['balance']:,.0f}"
    text = (
        f"All {hold['paid_sessions']} paid sessions are used — balance of {rs} is due. "
        f"Day {hold['next_session']} is on hold until the balance is paid"
    )
    ext = hold.get("extension") or {}
    if ext.get("status") == "requested":
        return text + ", or the Branch Admin approves the client's request for more time."
    if ext.get("status") == "approved":
        return text + f". The extension to {ext.get('extended_due_date') or '—'} has run out."
    return text + " or the Branch Admin extends the due date."


async def payment_hold_for_lead(lead_id: str) -> Optional[dict]:
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        return None
    counts = (await _completed_counts([lead_id])).get(lead_id) or {}
    return payment_hold(lead, int(counts.get("completed") or 0), int(counts.get("total") or 0))


async def _completed_counts(lead_ids: list) -> dict:
    """Completed treatment days and total booked days per lead, in one aggregate."""
    if not lead_ids:
        return {}
    rows = await v3_col("sessions").aggregate([
        {"$match": {"lead_id": {"$in": lead_ids}}},
        {"$group": {
            "_id": "$lead_id",
            "total": {"$sum": 1},
            "completed": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
        }},
    ]).to_list(len(lead_ids) + 10)
    return {r["_id"]: r for r in rows}


async def alerts_for_query(lead_query: dict) -> list:
    query = {**lead_query, "treatment_fee_payment_details.installments": {"$elemMatch": {"paid": {"$ne": True}}}}
    leads = await v3_col("leads").find(query, {"_id": 0}).to_list(5000)
    counts = await _completed_counts([l["id"] for l in leads])
    alerts = []
    for lead in leads:
        c = counts.get(lead["id"]) or {}
        alert = payment_alert(lead, int(c.get("completed") or 0), int(c.get("total") or 0))
        if alert:
            alerts.append(alert)
    if not alerts:
        return []

    branch_ids = list({a["branch_id"] for a in alerts if a.get("branch_id")})
    physio_ids = list({a["assigned_physio_id"] for a in alerts if a.get("assigned_physio_id")})
    branches = {b["id"]: b.get("branch_name", "") for b in await v3_col("branches").find(
        {"id": {"$in": branch_ids}}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)}
    physios = {d["id"]: d.get("full_name", "") for d in await v3_col("doctors").find(
        {"id": {"$in": physio_ids}}, {"_id": 0, "id": 1, "full_name": 1}).to_list(500)}
    for a in alerts:
        a["branch_name"] = branches.get(a.get("branch_id"), "")
        a["physio_name"] = physios.get(a.get("assigned_physio_id"), "")
        a["message"] = alert_message(a)
    # Requests waiting on a decision first; then owed-and-given, most unpaid sessions at the
    # top; heads-ups after.
    alerts.sort(key=lambda a: (
        (a.get("extension") or {}).get("status") != "requested",
        a["level"] != "due", -a["unpaid_sessions_given"], -a["balance"],
    ))
    return alerts


@router.get("/session-payment-alerts")
async def session_payment_alerts(
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Clients whose paid treatment sessions have run out (or are about to) with a balance
    still owing — the header's rupee bell."""
    if is_branch_admin_role(user.role):
        if not user.branch_id:
            return {"alerts": [], "extension_requests": 0, "due": 0, "last_paid": 0}
        lead_query = {"branch_id": user.branch_id}
    else:
        lead_query = {}
    alerts = await alerts_for_query(lead_query)
    return {
        "alerts": alerts,
        "extension_requests": sum(1 for a in alerts if (a.get("extension") or {}).get("status") == "requested"),
        "due": sum(1 for a in alerts if a["level"] == "due"),
        "last_paid": sum(1 for a in alerts if a["level"] == "last_paid"),
    }


async def _staff_emails(lead: dict) -> list:
    """Branch Admins of the client's branch, every active accountant, and their physio."""
    emails = []
    users = await v3_col("users").find(
        {"is_active": {"$ne": False}, "$or": [
            {"branch_id": lead.get("branch_id"), "role": {"$regex": "admin"}},
            {"role": "accountant"},
        ]},
        {"_id": 0, "email": 1, "role": 1},
    ).to_list(200)
    emails += [u["email"] for u in users if u.get("email") and (u["role"] == "accountant" or is_branch_admin_role(u["role"]))]
    if lead.get("assigned_physio_id"):
        doctor = await v3_col("doctors").find_one({"id": lead["assigned_physio_id"]}, {"_id": 0, "user_id": 1})
        if doctor and doctor.get("user_id"):
            physio = await v3_col("users").find_one({"id": doctor["user_id"]}, {"_id": 0, "email": 1})
            if physio and physio.get("email"):
                emails.append(physio["email"])
    return list(dict.fromkeys(e.strip().lower() for e in emails if e and e.strip()))


async def _email_staff(lead: dict, alert: dict) -> None:
    try:
        recipients = await _staff_emails(lead)
        branch = await v3_col("branches").find_one({"id": lead.get("branch_id")}, {"_id": 0, "branch_name": 1}) or {}
        subject = f"Payment due — {alert['name']} has used all paid sessions"
        number = f" ({alert['patient_number']})" if alert["patient_number"] else ""
        body = "\n".join([
            alert_message(alert),
            "",
            f"Client: {alert['name']}{number}",
            f"Branch: {branch.get('branch_name') or '—'}",
            f"Package: {alert['package_name'] or '—'}",
            f"Sessions completed: {alert['completed_sessions']} of {alert['total_sessions']}",
            f"Sessions paid for: {alert['paid_sessions']}",
            f"Balance due: Rs.{alert['balance']:,.0f}" + (f" (due {alert['balance_due_date']})" if alert.get("balance_due_date") else ""),
            "",
            "Please collect the balance from the client before the next session.",
            "",
            "FITSIOMAX",
        ])
        for to in recipients:
            try:
                await asyncio.to_thread(send_email, to, subject, body)
            except Exception:  # email_utils logs the SMTP error itself
                pass
    except Exception:
        logger.exception("Session payment alert email failed for lead %s", lead.get("id"))


async def notify_after_session_complete(lead_id: str, created_by: str = "", created_by_role: str = "") -> Optional[dict]:
    """After a treatment day is completed: the alert for this client now, if any.

    Writes the crossing to the client's timeline whenever the day just given reached or
    went past what is paid for, and emails the staff once — on the day the paid sessions
    run out (or the first day this finds them run out, if that point was passed unrecorded).
    """
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        return None
    counts = (await _completed_counts([lead_id])).get(lead_id) or {}
    alert = payment_alert(lead, int(counts.get("completed") or 0), int(counts.get("total") or 0))
    if not alert:
        return None
    alert["message"] = alert_message(alert)
    if alert["level"] != "due":
        return alert

    already_emailed = await v3_col("lead_activity").find_one(
        {"lead_id": lead_id, "action": "session_payment_due", "paid_sessions": alert["paid_sessions"]},
        {"_id": 1},
    )
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "session_payment_due",
        "details": f"Payment due — {alert['message']}",
        "paid_sessions": alert["paid_sessions"],
        "completed_sessions": alert["completed_sessions"],
        "balance": alert["balance"],
        "created_by": created_by or "System",
        "created_by_role": created_by_role or "system",
        "created_at": now_iso(),
    })
    if not already_emailed and smtp_configured():
        asyncio.get_event_loop().create_task(_email_staff(lead, alert))
    return alert


# ---------- Due-date extensions ----------

class SessionPaymentExtensionDecision(BaseModel):
    # The date the balance now falls due. Required to approve; the remaining sessions may
    # be given unpaid through it.
    extended_due_date: Optional[str] = None
    note: Optional[str] = ""


def _valid_date(value: Optional[str]) -> str:
    text = (value or "").strip()[:10]
    try:
        date.fromisoformat(text)
    except ValueError:
        raise HTTPException(status_code=400, detail="Pick a valid date (YYYY-MM-DD)")
    return text


async def record_extension_request(lead_id: str, requested_due_date: Optional[str], reason: str) -> dict:
    """The client asking, from their portal, for more time to pay the balance."""
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Patient not found")
    if not sessions_paid_for(lead):
        raise HTTPException(status_code=400, detail="There is no treatment balance to extend")
    prior = extension_of(lead) or {}
    if prior.get("status") == "requested":
        raise HTTPException(status_code=400, detail="Your request is already with the branch")
    wanted = _valid_date(requested_due_date) if requested_due_date else ""
    if wanted and wanted < clinic_today():
        raise HTTPException(status_code=400, detail="The new date can't be in the past")
    reason = (reason or "").strip()[:500]
    ext = {
        "status": "requested",
        "requested_due_date": wanted,
        "reason": reason,
        "requested_at": now_iso(),
        "history": prior.get("history") or [],
    }
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"session_payment_extension": ext}})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "session_payment_extension_requested",
        "details": "Client asked for more time to pay the treatment balance"
                   + (f" — until {wanted}" if wanted else "") + (f". Reason: {reason}" if reason else ""),
        "created_by": lead.get("name") or "Client",
        "created_by_role": "patient",
        "created_at": now_iso(),
    })
    return ext


async def _lead_for_decision(lead_id: str, user: V3UserOut) -> dict:
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Client not found")
    if is_branch_admin_role(user.role) and lead.get("branch_id") != user.branch_id:
        raise HTTPException(status_code=403, detail="This client is not in your branch")
    return lead


@router.post("/session-payment/{lead_id}/extension/approve")
async def approve_session_payment_extension(
    lead_id: str,
    payload: SessionPaymentExtensionDecision,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    """Let the remaining treatment days go ahead unpaid, by moving the balance's due date.

    Works with or without a request from the client — the desk can grant it when the client
    asks in person. The unpaid installments take the new date, so the payment reminders
    chase the new date rather than the old one; the old one is kept on each row.
    """
    lead = await _lead_for_decision(lead_id, user)
    if not sessions_paid_for(lead):
        raise HTTPException(status_code=400, detail="This client has no treatment balance owing")
    new_date = _valid_date(payload.extended_due_date)
    if new_date < clinic_today():
        raise HTTPException(status_code=400, detail="The new due date can't be in the past")

    installments = (lead.get("treatment_fee_payment_details") or {}).get("installments") or []
    for inst in installments:
        if not inst.get("paid"):
            inst.setdefault("original_due_date", inst.get("due_date"))
            inst["due_date"] = new_date

    prior = extension_of(lead) or {}
    note = (payload.note or "").strip()[:500]
    ext = {
        **prior,
        "status": "approved",
        "extended_due_date": new_date,
        "decided_by": user.full_name,
        "decided_by_role": user.role,
        "decided_at": now_iso(),
        "decision_note": note,
    }
    ext["history"] = (prior.get("history") or []) + [{
        "status": "approved", "extended_due_date": new_date, "by": user.full_name, "at": now_iso(), "note": note,
    }]
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {
        "session_payment_extension": ext,
        "treatment_fee_payment_details.installments": installments,
        "updated_at": now_iso(),
    }})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "session_payment_extension_approved",
        "details": f"Treatment balance due date extended to {new_date} by {user.full_name} — remaining sessions may go ahead without payment until then."
                   + (f" Note: {note}" if note else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    return {"extension": ext}


@router.post("/session-payment/{lead_id}/extension/reject")
async def reject_session_payment_extension(
    lead_id: str,
    payload: SessionPaymentExtensionDecision,
    user: V3UserOut = Depends(v3_require_roles("branch_admin", "super_admin", "business_dev")),
):
    lead = await _lead_for_decision(lead_id, user)
    prior = extension_of(lead) or {}
    if prior.get("status") != "requested":
        raise HTTPException(status_code=400, detail="There is no pending request to reject")
    note = (payload.note or "").strip()[:500]
    ext = {
        **prior,
        "status": "rejected",
        "decided_by": user.full_name,
        "decided_by_role": user.role,
        "decided_at": now_iso(),
        "decision_note": note,
    }
    ext["history"] = (prior.get("history") or []) + [{"status": "rejected", "by": user.full_name, "at": now_iso(), "note": note}]
    await v3_col("leads").update_one({"id": lead_id}, {"$set": {"session_payment_extension": ext, "updated_at": now_iso()}})
    await v3_col("lead_activity").insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "action": "session_payment_extension_rejected",
        "details": f"Client's request for more time on the treatment balance rejected by {user.full_name}." + (f" Note: {note}" if note else ""),
        "created_by": user.full_name,
        "created_by_role": user.role,
        "created_at": now_iso(),
    })
    return {"extension": ext}
