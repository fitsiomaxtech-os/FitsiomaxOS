"""Two-factor codes — the one place a 2FA challenge is made, checked and re-sent.

There is one delivery method: a six-digit code to the address the account signs in with.
No SMS gateway is configured on this install (see v3_password_reset.py, which emails its
"mobile" OTP for the same reason), and an authenticator app would put a QR and a recovery
path in front of forty-eight people who mostly sign in from one machine.

The same challenge shape serves three moments, told apart by `purpose`:

    enable   turning 2FA on from the Security tab — proves the address can be read
             before the account starts depending on it
    disable  turning it off again — the same proof, so a borrowed desk cannot
             quietly remove the second factor
    login    the gate itself, after the password has already checked out

Two more use the same code to prove an inbox rather than to guard a door:

    email_verify   a person verifying their own Email ID, or moving their login to a new
                   one (routers/v3_security.py). Goes to the address being proved, which
                   is the row's `email` and not necessarily the login's yet.
    email_login    a new login's first sign-in (routers/v3_auth.py).

Whatever the purpose, a right code was read out of an inbox. When that inbox is the one the
login signs in with, the login is marked verified (email_verified_at) as it is spent.

Codes are stored as a SHA-256 digest rather than in the clear, the same way the reset
tokens next door are. A challenge is single-use, expires in five minutes, survives five
wrong guesses and no more, and cannot be re-sent more often than once a minute.

Kept out of both routers because both need it: v3_auth.py raises a login challenge, and
v3_security.py raises the enable/disable ones.
"""
import asyncio
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import HTTPException

from database import v3_col
from email_utils import SmtpNotConfigured, send_email, smtp_configured
from utils import now_iso, now_utc

OTP_TTL_MINUTES = 5
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60

# email_verify_admin: an admin (Super Admin, BDE, Branch Admin) verifying somebody else's
# Email ID from HR -- the code goes to that person, who reads it out to the admin.
PURPOSES = ("login", "enable", "disable", "email_verify", "email_login", "email_verify_admin")

_SUBJECTS = {
    "login": "FitsiomaxOS — your sign-in code",
    "enable": "FitsiomaxOS — confirm two-factor authentication",
    "disable": "FitsiomaxOS — confirm turning off two-factor authentication",
    "email_verify": "FitsiomaxOS — verify your Email ID",
    "email_login": "FitsiomaxOS — verify your Email ID to sign in",
    "email_verify_admin": "FitsiomaxOS — verify your Email ID",
}

_LINES = {
    "login": "Someone signed in to your FitsiomaxOS account with your password. Enter this code to finish signing in.",
    "enable": "You asked to turn on two-factor authentication for your FitsiomaxOS account. Enter this code to confirm.",
    "disable": "You asked to turn OFF two-factor authentication for your FitsiomaxOS account. Enter this code to confirm.",
    "email_verify": "Enter this code in FitsiomaxOS to verify this Email ID for your login.",
    "email_login": "This is your first sign-in to FitsiomaxOS. Enter this code to verify your Email ID and finish signing in.",
    "email_verify_admin": "Your admin is verifying this Email ID for your FitsiomaxOS login. Tell them this code to finish.",
}

_WARNINGS = {
    "login": "If this wasn't you, someone knows your password — change it as soon as you can.",
    "enable": "If this wasn't you, ignore this email. Nothing has changed.",
    "disable": "If this wasn't you, ignore this email — two-factor authentication stays ON. Then change your password.",
    "email_verify": "If you did not ask for this, ignore this email. Nothing has changed.",
    "email_login": "If this wasn't you, tell your admin.",
    "email_verify_admin": "This code only verifies your Email ID — it does not sign anybody in. If you did not expect it, ignore this email.",
}


def hash_code(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def mask_email(email: str) -> str:
    """s****a@fitsiomax.clinic — enough to recognise the inbox, not enough to learn it.

    Shown on the code screen so somebody who has forgotten which address the account
    carries can tell whether to go looking for the mail, without the screen printing a
    full address to whoever is standing at the keyboard.
    """
    text = str(email or "")
    if "@" not in text:
        return text
    name, domain = text.split("@", 1)
    if len(name) <= 2:
        masked = (name[:1] or "*") + "*"
    else:
        masked = name[0] + "*" * (len(name) - 2) + name[-1]
    return f"{masked}@{domain}"


def _expired(row: Dict[str, Any]) -> bool:
    return datetime.fromisoformat(row["expires_at"]) < now_utc()


def _deliver(user: Dict[str, Any], purpose: str, code: str) -> None:
    """Mail the code, and turn a failure into an answer the screen can act on.

    The two failures are told apart because the reader can do something different about
    each. A server with no SMTP credentials will never send this code, however many times
    the button is pressed, and saying so is the difference between an administrator fixing
    a .env and a user retrying all afternoon. A configured server that failed once is worth
    trying again.

    Either way the real SMTP error is in the log by the time this runs — email_utils puts
    it there — because the sentence a user gets can never carry "535 Username and Password
    not accepted", and that is the sentence that fixes the problem.
    """
    try:
        send_email(
            user.get("email", ""),
            _SUBJECTS[purpose],
            (
                f"Hi {user.get('full_name', '')},\n\n"
                f"{_LINES[purpose]}\n\n"
                f"Code: {code}\n"
                f"It expires in {OTP_TTL_MINUTES} minutes.\n\n"
                f"{_WARNINGS[purpose]}"
            ),
        )
    except SmtpNotConfigured as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "This server cannot send email yet, so the code could not go out. An "
                "administrator needs to set SMTP_USER and SMTP_PASSWORD in backend/.env, "
                "then restart the backend."
            ),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="The verification code could not be emailed just now. Please try again in a moment.",
        ) from exc


async def issue_challenge(user: Dict[str, Any], purpose: str, email: Optional[str] = None) -> Dict[str, Any]:
    """Raise a fresh challenge for this account and mail the code.

    `email` is the inbox to prove when that is not the one the login has now (email_verify
    moving to a new address). It is kept on the row, so a resend goes to the same inbox and
    the code can only ever confirm that address.

    Any challenge still open for the same account and purpose is dropped first. Two live
    codes for one sign-in means the older mail still works, which is a longer window than
    the five minutes this is supposed to be.
    """
    if purpose not in PURPOSES:
        raise HTTPException(status_code=400, detail="Unknown verification purpose")
    target = email or user.get("email") or ""
    if not target:
        raise HTTPException(status_code=400, detail="This account has no email address to send a code to")
    # Asked before the row is written, not after. _deliver would refuse this anyway, but by
    # then a challenge nobody can ever answer is already in the collection — and on the
    # login path that is a challenge id handed to a browser for a code that was never sent.
    if not smtp_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "This server cannot send email yet, so no code can be sent. An administrator "
                "needs to set SMTP_USER and SMTP_PASSWORD in backend/.env, then restart the backend."
            ),
        )

    await v3_col("two_factor_challenges").delete_many(
        {"user_id": user["id"], "purpose": purpose, "consumed": False}
    )

    code = f"{secrets.randbelow(1000000):06d}"
    challenge_id = str(uuid.uuid4())
    await v3_col("two_factor_challenges").insert_one({
        "id": challenge_id,
        "user_id": user["id"],
        "purpose": purpose,
        "email": target,
        "code_hash": hash_code(code),
        "attempts": 0,
        "consumed": False,
        "created_at": now_iso(),
        "last_sent_at": now_iso(),
        "expires_at": (now_utc() + timedelta(minutes=OTP_TTL_MINUTES)).isoformat(),
    })
    # Off the event loop: an SMTP server that hangs takes twenty seconds to say so, and
    # nobody else's request should wait on it.
    await asyncio.to_thread(_deliver, {**user, "email": target}, purpose, code)
    return {
        "challenge_id": challenge_id,
        "email_masked": mask_email(target),
        "expires_in": OTP_TTL_MINUTES * 60,
    }


async def wait_before_resend(user_id: str, purpose: str) -> int:
    """Seconds left before this account may be mailed another code for this purpose, 0 when
    it may. For a start that takes an address from the request, which without this is a way
    to mail the same stranger over and over."""
    row = await v3_col("two_factor_challenges").find_one(
        {"user_id": user_id, "purpose": purpose}, {"_id": 0, "last_sent_at": 1}, sort=[("last_sent_at", -1)]
    )
    if not row or not row.get("last_sent_at"):
        return 0
    elapsed = (now_utc() - datetime.fromisoformat(row["last_sent_at"])).total_seconds()
    return max(int(RESEND_COOLDOWN_SECONDS - elapsed), 0)


async def sign_in_purpose(challenge_id: str) -> str:
    """Which of the two sign-in challenges this id is: the two-factor gate, or a new login's
    first-sign-in email code. The code screen is the same one, so it answers both."""
    row = await v3_col("two_factor_challenges").find_one({"id": challenge_id}, {"_id": 0, "purpose": 1})
    return "email_login" if (row or {}).get("purpose") == "email_login" else "login"


async def resend_challenge(challenge_id: str, purpose: str) -> Dict[str, Any]:
    """A new code on the same challenge id, so the screen the user is on stays put.

    The old code stops working — a resend that left the previous one live would widen the
    window every time somebody pressed it.
    """
    row = await v3_col("two_factor_challenges").find_one(
        {"id": challenge_id, "purpose": purpose, "consumed": False}, {"_id": 0}
    )
    if not row:
        raise HTTPException(status_code=404, detail="This verification has expired — start again")

    elapsed = (now_utc() - datetime.fromisoformat(row["last_sent_at"])).total_seconds()
    if elapsed < RESEND_COOLDOWN_SECONDS:
        raise HTTPException(
            status_code=429,
            detail=f"Please wait {int(RESEND_COOLDOWN_SECONDS - elapsed)}s before asking for another code",
        )

    user = await v3_col("users").find_one({"id": row["user_id"], "is_active": True}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Account not found or inactive")

    code = f"{secrets.randbelow(1000000):06d}"
    await v3_col("two_factor_challenges").update_one(
        {"id": challenge_id},
        {"$set": {
            "code_hash": hash_code(code),
            # Attempts reset with the code. Five guesses were spent on a number that is no
            # longer the answer, and holding them against the new one locks out the person
            # who pressed Resend precisely because they never received the first.
            "attempts": 0,
            "last_sent_at": now_iso(),
            "expires_at": (now_utc() + timedelta(minutes=OTP_TTL_MINUTES)).isoformat(),
        }},
    )
    # The inbox the challenge was raised for. A row from before rows carried one has none.
    target = row.get("email") or user["email"]
    await asyncio.to_thread(_deliver, {**user, "email": target}, purpose, code)
    return {
        "challenge_id": challenge_id,
        "email_masked": mask_email(target),
        "expires_in": OTP_TTL_MINUTES * 60,
    }


def same_email(a: Any, b: Any) -> bool:
    return bool(a) and str(a).strip().lower() == str(b or "").strip().lower()


async def consume_challenge(
    challenge_id: str, code: str, purpose: str, user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Check a code and, if it is right, spend the challenge. Returns the user document,
    with the inbox that was proved as `challenge_email`.

    `user_id`, when given, is who must own the challenge -- checked before the code, so
    somebody else's challenge is refused unspent.

    Every failure path raises rather than returning a flag, so a caller cannot forget to
    look at one. The challenge is marked consumed before the caller acts on it, which is
    what makes a verified code single-use even if two requests arrive together.
    """
    row = await v3_col("two_factor_challenges").find_one(
        {"id": challenge_id, "purpose": purpose}, {"_id": 0}
    )
    if not row:
        raise HTTPException(status_code=404, detail="This verification has expired — start again")
    if user_id and row["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="This verification belongs to another account")
    if row["consumed"]:
        raise HTTPException(status_code=400, detail="This code has already been used")
    if _expired(row):
        raise HTTPException(status_code=400, detail="That code has expired — ask for a new one")
    if row["attempts"] >= MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many incorrect codes — ask for a new one")

    if hash_code(str(code or "").strip()) != row["code_hash"]:
        await v3_col("two_factor_challenges").update_one({"id": challenge_id}, {"$inc": {"attempts": 1}})
        left = MAX_ATTEMPTS - row["attempts"] - 1
        raise HTTPException(
            status_code=401,
            detail=(
                f"That code is not right — {left} {'try' if left == 1 else 'tries'} left"
                if left > 0
                else "That code is not right — ask for a new one"
            ),
        )

    user = await v3_col("users").find_one({"id": row["user_id"], "is_active": True}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Account not found or inactive")

    await v3_col("two_factor_challenges").update_one(
        {"id": challenge_id}, {"$set": {"consumed": True, "verified_at": now_iso()}}
    )
    if same_email(row.get("email"), user.get("email")):
        verified_at = user.get("email_verified_at") or now_iso()
        await v3_col("users").update_one(
            {"id": user["id"]}, {"$set": {"email_verified_at": verified_at, "email_code_due": False}}
        )
        user["email_verified_at"] = verified_at
    user["challenge_email"] = row.get("email") or ""
    return user


def is_enabled(user: Optional[Dict[str, Any]]) -> bool:
    """Whether this account is gated. Absent on every account created before 2FA existed,
    which is every account today — so the default has to be off, not missing."""
    return bool((user or {}).get("two_factor_enabled"))


def first_code_due(user: Optional[Dict[str, Any]]) -> bool:
    """Whether this login still owes the first-sign-in email code. `email_code_due` is put on
    a login when it is created (create_user_account) and only on one created since this
    shipped, so every older login signs in exactly as it did."""
    u = user or {}
    return bool(u.get("email_code_due")) and not u.get("email_verified_at")
