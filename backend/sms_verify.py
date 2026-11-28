"""Server-only Twilio Verify adapter. No codes or provider credentials reach the browser."""
import os
import re

import httpx
from fastapi import HTTPException


def configured() -> bool:
    return (
        os.getenv("SMS_LOGIN_ENABLED", "").lower() == "true"
        and bool(re.fullmatch(r"AC[0-9a-fA-F]{32}", os.getenv("TWILIO_ACCOUNT_SID", "")))
        and bool(os.getenv("TWILIO_AUTH_TOKEN"))
        and bool(re.fullmatch(r"VA[0-9a-fA-F]{32}", os.getenv("TWILIO_VERIFY_SERVICE_SID", "")))
    )


def require_configured() -> None:
    if not configured():
        raise HTTPException(503, "Mobile sign-in is not available yet. Please use email sign-in.")


def normalize_phone(value: str) -> str:
    """Indian national mobile numbers, or explicit international E.164 numbers."""
    text = str(value or "").strip()
    if not re.fullmatch(r"\+?[0-9 ()-]{7,30}", text):
        raise HTTPException(400, "Enter a valid mobile number, including its country code.")
    digits = re.sub(r"[^0-9]", "", text)
    if not text.startswith("+"):
        if re.fullmatch(r"[6-9][0-9]{9}", digits):
            digits = "91" + digits
        elif not re.fullmatch(r"91[6-9][0-9]{9}", digits):
            raise HTTPException(400, "Include the country code, for example +91.")
    if not re.fullmatch(r"[1-9][0-9]{7,14}", digits):
        raise HTTPException(400, "Enter a valid mobile number, including its country code.")
    return "+" + digits


def phone_pattern(phone: str) -> str:
    # Accommodate the spaces/dashes already saved by HR without matching arbitrary text.
    digits = phone[1:]
    prefix = r"\+?"
    if re.fullmatch(r"91[6-9][0-9]{9}", digits):
        prefix = r"(?:\+?9[ ()-]*1[ ()-]*)?"
        digits = digits[2:]
    return r"^[ ()-]*" + prefix + r"[ ()-]*".join(digits) + r"[ ()-]*$"


async def _post(resource: str, data: dict) -> dict:
    require_configured()
    url = f"https://verify.twilio.com/v2/Services/{os.environ['TWILIO_VERIFY_SERVICE_SID']}/{resource}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, data=data, auth=(os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"]))
        if response.status_code == 429:
            raise HTTPException(429, "Too many SMS requests. Please try again later.")
        if response.status_code == 404 and resource == "VerificationCheck":
            raise HTTPException(400, "This code has expired or was already used. Start again.")
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        # Never echo provider errors: they can include phone numbers or account details.
        raise HTTPException(503, "SMS verification is temporarily unavailable. Please try again later.") from exc


async def send(phone: str) -> str:
    result = await _post("Verifications", {"To": phone, "Channel": "sms"})
    sid = result.get("sid", "")
    if result.get("status") != "pending" or not re.fullmatch(r"VE[0-9a-fA-F]{32}", sid):
        raise HTTPException(503, "The SMS code could not be sent. Please try again later.")
    return sid


async def check(sid: str, code: str) -> bool:
    result = await _post("VerificationCheck", {"VerificationSid": sid, "Code": code})
    return result.get("status") == "approved" and result.get("sid") == sid
