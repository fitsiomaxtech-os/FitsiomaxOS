from fastapi import APIRouter, HTTPException, Depends, Header
import re
import uuid

import two_factor
from database import v3_col
from utils import now_iso
from security import verify_password, hash_password, is_hashed
from deps import v3_current_user
from schemas.v3 import (
    V3UserOut,
    V3LoginRequest,
    V3LoginResponse,
    V3TwoFactorVerifyRequest,
    V3TwoFactorResendRequest,
)

router = APIRouter(prefix="/api/v3")

# How many devices one account can stay signed in on at once. Generous on purpose — the
# point is that a second sign-in doesn't end the first, not to police device count.
MAX_SESSIONS_PER_USER = 10


@router.get("/")
async def v3_root():
    return {"message": "FITSIOMAX OS API v3"}


async def _employee_photo(user: dict) -> str:
    """The headshot on this person's employee record, if they have one.

    Resolved here rather than in v3_current_user, which runs on every authenticated
    request in the app — a second query on all of them to paint one avatar is not a trade
    worth making. Sign-in and /auth/me are the two places the frontend takes its copy of
    the user from, so filling it there is enough for it to have one.

    The picture belongs to the employee record and the login is a separate document; they
    are joined by users.employee_id, which is absent on every account created without an
    employee behind it.
    """
    # A login with nobody on the books behind it can still set its own photo from My
    # Profile, which keeps it on the login itself -- the fallback below.
    own = (user or {}).get("photo_url") or ""
    emp_id = (user or {}).get("employee_id")
    if not emp_id:
        return own
    emp = await v3_col("employees").find_one({"id": emp_id}, {"_id": 0, "photo_url": 1})
    return (emp or {}).get("photo_url") or own


async def _issue_session(user: dict) -> V3LoginResponse:
    """Mint a token for an account that has cleared every gate in front of it.

    Split out of the login handler because there are now two doors into it: a password on
    an account without 2FA, and a verified code on an account with it. Both have to cap
    sessions, record the login and attach the headshot in the same way, and the version
    that drifts is the one that was copied.
    """
    token = str(uuid.uuid4())
    await v3_col("sessions").insert_one({"token": token, "user_id": user["id"], "created_at": now_iso()})
    # Signing in on a second device must NOT sign the first one out. A Head Physio moves
    # between a phone on the floor and a desk machine and expects both to stay live, and
    # a branch's shared account is used from more than one place at once.
    #
    # Only the oldest sessions beyond the cap are dropped, so tokens can't accumulate
    # forever on an account that signs in every day. The user_id filter also keeps this
    # away from the treatment-session documents that share this collection — those carry
    # no user_id, so they can never match.
    stale = await v3_col("sessions").find(
        {"user_id": user["id"]}, {"_id": 0, "token": 1}
    ).sort("created_at", -1).skip(MAX_SESSIONS_PER_USER).to_list(500)
    if stale:
        await v3_col("sessions").delete_many({"token": {"$in": [s["token"] for s in stale]}})
    await v3_col("login_history").insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "user_name": user.get("full_name", ""),
        "email": user.get("email", ""),
        "role": user.get("role", ""),
        "branch_id": user.get("branch_id"),
        "created_at": now_iso(),
    })
    user_public = {k: v for k, v in user.items() if k != "password"}
    user_public["photo_url"] = await _employee_photo(user)
    return V3LoginResponse(token=token, user=V3UserOut(**user_public))


@router.post("/auth/login")
async def v3_login(payload: V3LoginRequest):
    # Case-insensitive match: some accounts were created with mixed-case emails
    # (e.g. "Consultant@fitsiomax.clinic") before account creation normalized to lowercase.
    email = payload.email.strip()
    user = await v3_col("users").find_one(
        {"email": {"$regex": f"^{re.escape(email)}$", "$options": "i"}, "is_active": True},
        {"_id": 0},
    )
    if not user or not verify_password(payload.password, user.get("password", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not is_hashed(user.get("password", "")):
        await v3_col("users").update_one(
            {"id": user["id"]},
            {"$set": {"password": hash_password(payload.password)}},
        )

    # The gate. No token is minted here for an account with 2FA on — the response carries a
    # challenge instead, and the session is only created once the code comes back verified
    # at /auth/login/verify-2fa. Anything short of that (a token issued now and revoked
    # later, a flag on the session saying "half signed in") leaves a usable token in a
    # browser that has not finished proving who it is.
    #
    # response_model is gone from this route for the same reason: the two answers are
    # different shapes, and V3LoginResponse would have had to make token and user optional
    # to hold both — which would let a bug return neither and still validate.
    if two_factor.is_enabled(user):
        challenge = await two_factor.issue_challenge(user, "login")
        return {"two_factor_required": True, **challenge}

    return await _issue_session(user)


@router.post("/auth/login/verify-2fa")
async def v3_login_verify_2fa(payload: V3TwoFactorVerifyRequest):
    """Second half of a gated sign-in: the code from the email, and the session it earns.

    The password was already checked to raise the challenge, and the challenge id is the
    only thing tying this call to that one — so it is unguessable, single-use, and dies in
    five minutes. It carries the user id itself rather than taking one from the caller,
    which is what keeps a valid code for one account from signing in as another.
    """
    user = await two_factor.consume_challenge(payload.challenge_id, payload.code, "login")
    return await _issue_session(user)


@router.post("/auth/login/resend-2fa")
async def v3_login_resend_2fa(payload: V3TwoFactorResendRequest):
    """A fresh code on the same challenge, for the sign-in that never received the first."""
    return await two_factor.resend_challenge(payload.challenge_id, "login")


@router.get("/auth/me", response_model=V3UserOut)
async def v3_me(user: V3UserOut = Depends(v3_current_user)):
    # employee_id is not on V3UserOut, and v3_current_user drops everything the model does
    # not name, so the link has to be read again rather than carried through.
    row = await v3_col("users").find_one({"id": user.id}, {"_id": 0, "employee_id": 1, "photo_url": 1})
    return user.model_copy(update={"photo_url": await _employee_photo(row)})


@router.post("/auth/logout")
async def v3_logout(user: V3UserOut = Depends(v3_current_user), authorization: str = Header(...)):
    token = authorization.split(" ", 1)[1].strip()
    await v3_col("sessions").delete_one({"token": token, "user_id": user.id})
    return {"message": "Logged out"}
