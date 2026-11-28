"""Password-authenticated SMS challenges, with persistent atomic limits and single use."""
import hashlib
import os
import re
import uuid
from datetime import timedelta, timezone

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

import sms_verify
from database import v3_col
from utils import now_utc

TTL_SECONDS = 300
COOLDOWN_SECONDS = 60
MAX_ATTEMPTS = 5


def fingerprint(user: dict) -> str:
    return hashlib.sha256(str(user.get("password", "")).encode()).hexdigest()


async def limit(key: str, maximum: int, seconds: int) -> None:
    """Fixed-window budgets, shared by workers and restarts; reserve before doing work."""
    now = now_utc()
    window = int(now.timestamp()) // seconds
    identifier = hashlib.sha256(key.encode()).hexdigest() + f":{seconds}:{window}"
    counters = v3_col("sms_login_limits")
    # Idempotent; TTL cleanup never participates in enforcing a budget.
    await counters.create_index("delete_at", expireAfterSeconds=0)
    try:
        row = await counters.find_one_and_update(
            {"_id": identifier, "count": {"$lt": maximum}},
            {"$inc": {"count": 1}, "$setOnInsert": {"delete_at": now + timedelta(seconds=seconds * 2)}},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        row = None
    if not row:
        raise HTTPException(429, "Too many mobile sign-in requests. Please try again later.")


async def send_budget(phone: str) -> None:
    await limit("phone:" + phone, 5, 3600)
    try:
        daily_max = max(1, int(os.getenv("SMS_LOGIN_DAILY_LIMIT", "100")))
    except ValueError:
        raise HTTPException(503, "Mobile sign-in is not available. Please contact your admin.")
    await limit("all-sms", daily_max, 86400)


def response(row: dict) -> dict:
    expiry = row["expires_at"]
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    remaining = max(0, int((expiry - now_utc()).total_seconds()))
    return {
        "two_factor_required": True, "channel": "sms", "challenge_id": row["id"],
        "phone_masked": "*" * (len(row["phone"]) - 4) + row["phone"][-4:],
        "expires_in": remaining, "resend_after": COOLDOWN_SECONDS,
    }


async def issue(user: dict, phone: str) -> dict:
    sms_verify.require_configured()
    now = now_utc()
    challenges = v3_col("sms_login_challenges")
    # The account's _id is unique. Racing starts cannot create two active challenges or
    # evade the cooldown by abandoning the verification page and re-entering a password.
    row = {
        "id": str(uuid.uuid4()), "user_id": user["id"], "phone": phone,
        "password_fingerprint": fingerprint(user), "attempts": 0, "consumed": False,
        "created_at": now, "expires_at": now + timedelta(seconds=TTL_SECONDS),
        "next_send_at": now + timedelta(seconds=COOLDOWN_SECONDS),
        "busy_until": now + timedelta(seconds=30), "provider_sid": None,
    }
    try:
        await challenges.update_one(
            {"_id": user["id"], "next_send_at": {"$lte": now}, "busy_until": {"$lte": now}},
            {"$set": row}, upsert=True,
        )
    except DuplicateKeyError:
        raise HTTPException(429, "Please wait 60 seconds before requesting another SMS code.")
    try:
        await send_budget(phone)
        sid = await sms_verify.send(phone)
        await challenges.update_one({"id": row["id"]}, {"$set": {"provider_sid": sid}})
    except Exception:
        await challenges.update_one({"id": row["id"]}, {"$set": {"consumed": True}})
        raise
    finally:
        await challenges.update_one({"id": row["id"]}, {"$set": {"busy_until": now_utc()}})
    return response(row)


async def _claim(challenge_id: str, verify: bool) -> dict:
    now = now_utc()
    query = {
        "id": challenge_id, "consumed": False, "expires_at": {"$gt": now},
        "attempts": {"$lt": MAX_ATTEMPTS}, "busy_until": {"$lte": now},
        "provider_sid": {"$ne": None},
    }
    update = {"$set": {"busy_until": now + timedelta(seconds=30)}}
    if verify:
        update["$inc"] = {"attempts": 1}
    else:
        query["next_send_at"] = {"$lte": now}
        update["$set"]["next_send_at"] = now + timedelta(seconds=COOLDOWN_SECONDS)
    row = await v3_col("sms_login_challenges").find_one_and_update(
        query, update, return_document=ReturnDocument.AFTER,
    )
    if not row:
        raise HTTPException(400, "This code is expired, busy, or unavailable. Wait before resending, or start again.")
    return row


async def _current_user(row: dict) -> dict:
    user = await v3_col("users").find_one({"id": row["user_id"], "is_active": True}, {"_id": 0})
    try:
        unchanged = user and sms_verify.normalize_phone(user.get("mobile_number")) == row["phone"] and fingerprint(user) == row["password_fingerprint"]
    except HTTPException:
        unchanged = False
    if not unchanged:
        raise HTTPException(401, "Account details changed. Please start sign-in again.")
    return user


async def resend(challenge_id: str) -> dict:
    sms_verify.require_configured()
    row = await _claim(challenge_id, verify=False)
    try:
        await _current_user(row)
        await send_budget(row["phone"])
        sid = await sms_verify.send(row["phone"])
        await v3_col("sms_login_challenges").update_one({"id": challenge_id}, {"$set": {"provider_sid": sid}})
        # Resending does not reset guesses or extend the password-authenticated window.
        return response(row)
    finally:
        await v3_col("sms_login_challenges").update_one({"id": challenge_id}, {"$set": {"busy_until": now_utc()}})


async def consume(challenge_id: str, code: str) -> dict:
    sms_verify.require_configured()
    if not re.fullmatch(r"[0-9]{6}", code):
        raise HTTPException(400, "Enter the 6-digit SMS code.")
    row = await _claim(challenge_id, verify=True)
    try:
        await _current_user(row)
        if not await sms_verify.check(row["provider_sid"], code):
            raise HTTPException(401, "That SMS code is not correct.")
        # Check again after the network request, then consume atomically before a session
        # can be issued. A parallel verification can never earn a second session.
        user = await _current_user(row)
        result = await v3_col("sms_login_challenges").update_one(
            {"id": challenge_id, "consumed": False, "expires_at": {"$gt": now_utc()}},
            {"$set": {"consumed": True}},
        )
        if not result.modified_count:
            raise HTTPException(400, "This verification has expired or was already used.")
        return user
    finally:
        await v3_col("sms_login_challenges").update_one({"id": challenge_id}, {"$set": {"busy_until": now_utc()}})
