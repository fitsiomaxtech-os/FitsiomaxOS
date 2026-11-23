"""SECURITY — the fourth tab of everybody's own page, and the only one that changes a login.

    Password        change my own, knowing the old one
    Email ID        verify the one I sign in with, or move to another
    Two-factor      a code to my email at every sign-in, on or off
    Devices         where this account is signed in, and a way to end the rest

Like /me/profile and /me/attendance beside it, nothing here takes an id. Every endpoint
answers for whoever holds the token, so there is no request shape on this router that can
read or change another person's login — which is what makes it safe to hand to every role
at once. HR's side of the same subject (setting somebody else's password, deactivating an
account) stays where it was, on /hr/users, behind HR's roles.

Turning 2FA on or off both require a code to the registered address, not just the
session. A session is whoever is sitting at the desk; the mailbox is the person. Without
that, walking past an unlocked screen is enough to remove somebody's second factor, which
would make the feature worth less than the checkbox that draws it.

Changing a password ends every other session but this one. A password is usually changed
because somebody else may have had it, and leaving the old tokens live means the change
did nothing for the case it was made for.
"""
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

import email_check
import two_factor
from database import v3_col
from email_utils import smtp_configured
from deps import v3_current_user
from schemas.v3 import V3UserOut
from security import hash_password, verify_password
from utils import now_iso

router = APIRouter(prefix="/api/v3/me/security")

MIN_PASSWORD_LENGTH = 6


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_password: str


class TwoFactorStartRequest(BaseModel):
    # "enable" or "disable" — which way this is being pushed. Sent by the screen rather
    # than inferred from the stored flag so a stale tab cannot turn 2FA off by pressing a
    # button that said "Enable" when it was drawn.
    intent: str


class TwoFactorVerifyRequest(BaseModel):
    intent: str
    challenge_id: str
    code: str


class TwoFactorResendRequest(BaseModel):
    intent: str
    challenge_id: str


class EmailCheckRequest(BaseModel):
    email: str


class EmailStartRequest(BaseModel):
    email: str
    # Asked only when the address changes. Verifying the one already on the login takes no
    # password: it changes nothing about who can sign in.
    current_password: str = ""


class EmailChallengeRequest(BaseModel):
    challenge_id: str


class EmailVerifyRequest(BaseModel):
    challenge_id: str
    code: str


def _token_of(authorization: str) -> str:
    return authorization.split(" ", 1)[1].strip()


async def _account(user_id: str) -> Dict[str, Any]:
    """The stored login, password included — this router checks and writes it.

    v3_current_user hands back a V3UserOut, which drops the hash and everything else the
    model does not name, so the document has to be read again here rather than carried.
    """
    row = await v3_col("users").find_one({"id": user_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


def _intent_or_400(intent: str) -> str:
    value = str(intent or "").strip().lower()
    if value not in ("enable", "disable"):
        raise HTTPException(status_code=400, detail="Unknown action")
    return value


@router.get("")
async def my_security(user: V3UserOut = Depends(v3_current_user), authorization: str = Header(...)):
    """Everything the tab paints in one read: the password's age, the 2FA state, the devices.

    Sessions are counted rather than listed with a device name because nothing on this
    install records one — every session document is a token, a user and a timestamp (see
    v3_auth.py). A list of six identical rows saying "Unknown device" is worse than the
    number, and the action underneath it — end the others — works the same either way.
    """
    row = await _account(user.id)
    token = _token_of(authorization)
    sessions: List[Dict[str, Any]] = await v3_col("sessions").find(
        {"user_id": user.id}, {"_id": 0, "token": 1, "created_at": 1}
    ).sort("created_at", -1).to_list(100)

    last_login = await v3_col("login_history").find_one(
        {"user_id": user.id}, {"_id": 0, "created_at": 1}, sort=[("created_at", -1)]
    )

    return {
        # Super Admin's Email ID panel has no Change Email ID button.
        "role": row.get("role", ""),
        "email": row.get("email", ""),
        "email_masked": two_factor.mask_email(row.get("email", "")),
        "email_verified_at": row.get("email_verified_at"),
        # The mail service the code was read out of, for "Verified by [its logo]". Only
        # looked up once verified: before that there is no mark to draw.
        "email_provider": await email_check.provider_of(row.get("email")) if row.get("email_verified_at") else None,
        "password_changed_at": row.get("password_changed_at"),
        "two_factor": {
            "enabled": two_factor.is_enabled(row),
            "method": "email" if two_factor.is_enabled(row) else None,
            "enabled_at": row.get("two_factor_enabled_at"),
            # Whether this server can send the code at all. Email is the only delivery
            # method, so with no SMTP credentials the button is a button that cannot work
            # — the screen is better off saying that up front than after it is pressed.
            #
            # Reported even when 2FA is already on, because that is the worse case: a code
            # will be asked for at the next sign-in and the server cannot send one.
            "email_configured": smtp_configured(),
        },
        "sessions": {
            "total": len(sessions),
            # What "Sign out everywhere else" would actually end, so the button can say a
            # number and stay off when there is nothing but this browser.
            "others": max(len(sessions) - 1, 0),
            "current_started_at": next((s["created_at"] for s in sessions if s["token"] == token), None),
        },
        "last_login_at": (last_login or {}).get("created_at"),
    }


@router.post("/password")
async def change_my_password(
    payload: ChangePasswordRequest,
    user: V3UserOut = Depends(v3_current_user),
    authorization: str = Header(...),
):
    """Change my own password, having proved I know the current one.

    The current password is required even though the session already proves who this is.
    HR can set a password without it — that is a reset, done by somebody accountable for
    doing it — but a person changing their own at an unlocked desk is exactly the case the
    old password is there to catch.
    """
    row = await _account(user.id)

    # 400, not 401. The session reaching this endpoint is perfectly good — it is the field
    # in the body that is wrong — and 401 is the status the frontend's axios interceptor
    # reads as "this token is dead, clear it and reload". Answering a typo with the status
    # that means a dead session would sign the user out for mistyping.
    if not verify_password(payload.current_password, row.get("password", "")):
        raise HTTPException(status_code=400, detail="Your current password is not right")
    if payload.new_password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="The two new passwords do not match")
    if len(payload.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if verify_password(payload.new_password, row.get("password", "")):
        raise HTTPException(status_code=400, detail="That is already your password — choose a different one")

    await v3_col("users").update_one(
        {"id": user.id},
        {"$set": {"password": hash_password(payload.new_password), "password_changed_at": now_iso()}},
    )

    # Everywhere else is signed out; this browser is not. Ending the session that just made
    # the change would drop the user on the login screen with no word of whether it worked.
    token = _token_of(authorization)
    ended = await v3_col("sessions").delete_many({"user_id": user.id, "token": {"$ne": token}})

    return {
        "message": "Password changed",
        "sessions_ended": ended.deleted_count,
    }


@router.post("/email/check")
async def check_my_email(payload: EmailCheckRequest, user: V3UserOut = Depends(v3_current_user)):
    """The automatic check behind the Email ID box. My own address is not "already used"."""
    return await email_check.check_for_login(payload.email, user.id)


@router.post("/email/start")
async def start_email_verify(payload: EmailStartRequest, user: V3UserOut = Depends(v3_current_user)):
    """Mail the code that verifies my Email ID, or moves my login to a new one.

    Moving asks for the current password as well. The email is what Forgot Password writes
    to, so changing it at an unlocked desk would hand over the account; the code alone does
    not stop that, because it goes to the new inbox.
    """
    row = await _account(user.id)
    changing = not two_factor.same_email(payload.email, row.get("email"))
    if not changing and row.get("email_verified_at"):
        raise HTTPException(status_code=400, detail="This Email ID is already verified")
    if changing and not verify_password(payload.current_password, row.get("password", "")):
        raise HTTPException(status_code=400, detail="Your current password is not right")

    wait = await two_factor.wait_before_resend(user.id, "email_verify")
    if wait:
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before asking for another code")

    # The address already on the login is not held to the check: it is in use, and a code
    # read out of it says more than the check can.
    target = await email_check.require_allowed(payload.email, user.id) if changing else row["email"]
    challenge = await two_factor.issue_challenge(row, "email_verify", email=target)
    return {**challenge, "changing": changing}


@router.post("/email/resend")
async def resend_email_verify(payload: EmailChallengeRequest, user: V3UserOut = Depends(v3_current_user)):
    return await two_factor.resend_challenge(payload.challenge_id, "email_verify")


@router.post("/email/verify")
async def finish_email_verify(payload: EmailVerifyRequest, user: V3UserOut = Depends(v3_current_user)):
    """The code checks out -- this inbox is mine, so it becomes the login's, verified."""
    row = await two_factor.consume_challenge(payload.challenge_id, payload.code, "email_verify", user_id=user.id)
    target, current = row["challenge_email"], row.get("email", "")
    if two_factor.same_email(target, current):
        return {"email": current, "email_verified_at": row["email_verified_at"], "message": "Email ID verified"}

    # Asked again: somebody may have taken it in the five minutes the code was out.
    target = await email_check.require_allowed(target, user.id)
    verified_at = now_iso()
    await v3_col("users").update_one(
        {"id": user.id},
        {"$set": {"email": target, "email_verified_at": verified_at, "email_code_due": False}},
    )
    # The employee record's Email is the same Email ID as the login (Add / Edit Employee
    # shows one box on Personal and Credentials), so it always follows.
    if row.get("employee_id"):
        await v3_col("employees").update_one(
            {"id": row["employee_id"]}, {"$set": {"email": target, "updated_at": now_iso()}}
        )
    return {
        "email": target,
        "email_verified_at": verified_at,
        "message": f"Email ID updated. Sign in with {target} from now on.",
    }


@router.post("/2fa/start")
async def start_two_factor(payload: TwoFactorStartRequest, user: V3UserOut = Depends(v3_current_user)):
    """Send the code that confirms turning 2FA on, or off."""
    intent = _intent_or_400(payload.intent)
    row = await _account(user.id)
    enabled = two_factor.is_enabled(row)

    if intent == "enable" and enabled:
        raise HTTPException(status_code=400, detail="Two-factor authentication is already on")
    if intent == "disable" and not enabled:
        raise HTTPException(status_code=400, detail="Two-factor authentication is already off")

    return await two_factor.issue_challenge(row, intent)


@router.post("/2fa/resend")
async def resend_two_factor(payload: TwoFactorResendRequest, user: V3UserOut = Depends(v3_current_user)):
    intent = _intent_or_400(payload.intent)
    return await two_factor.resend_challenge(payload.challenge_id, intent)


@router.post("/2fa/verify")
async def verify_two_factor(payload: TwoFactorVerifyRequest, user: V3UserOut = Depends(v3_current_user)):
    """The code checks out — flip the flag.

    consume_challenge returns the account the challenge was raised against; it is compared
    with the session's own before anything is written, so a challenge id belonging to
    somebody else is refused rather than applied to whoever presents it.
    """
    intent = _intent_or_400(payload.intent)
    owner = await two_factor.consume_challenge(payload.challenge_id, payload.code, intent)
    if owner["id"] != user.id:
        raise HTTPException(status_code=403, detail="This verification belongs to another account")

    if intent == "enable":
        await v3_col("users").update_one(
            {"id": user.id},
            {"$set": {"two_factor_enabled": True, "two_factor_method": "email", "two_factor_enabled_at": now_iso()}},
        )
        return {"enabled": True, "message": "Two-factor authentication is on. You'll get a code by email at every sign-in."}

    await v3_col("users").update_one(
        {"id": user.id},
        {"$set": {"two_factor_enabled": False, "two_factor_method": None, "two_factor_enabled_at": None}},
    )
    return {"enabled": False, "message": "Two-factor authentication is off. Only your password is needed now."}


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(user: V3UserOut = Depends(v3_current_user), authorization: str = Header(...)):
    """End every session on this account except the one asking."""
    token = _token_of(authorization)
    ended = await v3_col("sessions").delete_many({"user_id": user.id, "token": {"$ne": token}})
    return {"sessions_ended": ended.deleted_count, "message": f"Signed out of {ended.deleted_count} other device(s)"}
