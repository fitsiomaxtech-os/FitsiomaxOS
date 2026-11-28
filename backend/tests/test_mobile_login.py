"""Offline authentication tests: in-memory Mongo and mocked SMS, never real messages."""
import asyncio
import os
import re
import sys
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import mongomock
import pytest
from fastapi import HTTPException

os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "test_mobile_login")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mobile_login
import sms_verify
import login_guard
from routers import v3_auth, v3_hr
from schemas.v3 import V3LoginRequest
from utils import now_utc


def run(coro):
    return asyncio.run(coro)


class Cursor:
    def __init__(self, cursor):
        self.cursor = cursor

    def limit(self, number):
        self.cursor = self.cursor.limit(number)
        return self

    async def to_list(self, number):
        return list(self.cursor)[:number]


class Collection:
    def __init__(self, collection):
        self.collection = collection

    def find(self, *args, **kwargs):
        return Cursor(self.collection.find(*args, **kwargs))

    def __getattr__(self, name):
        async def call(*args, **kwargs):
            return getattr(self.collection, name)(*args, **kwargs)
        return call


@pytest.fixture
def setup(monkeypatch):
    db = mongomock.MongoClient(tz_aware=True).db
    col = lambda name: Collection(db[name])
    for module in (mobile_login, login_guard, v3_auth, v3_hr):
        monkeypatch.setattr(module, "v3_col", col)
    monkeypatch.setenv("SMS_LOGIN_ENABLED", "true")
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC" + "a" * 32)
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-only-secret")
    monkeypatch.setenv("TWILIO_VERIFY_SERVICE_SID", "VA" + "b" * 32)
    monkeypatch.setenv("SMS_LOGIN_DAILY_LIMIT", "100")
    sender = AsyncMock(return_value="VE" + "c" * 32)
    checker = AsyncMock(return_value=True)
    monkeypatch.setattr(sms_verify, "send", sender)
    monkeypatch.setattr(sms_verify, "check", checker)
    user = {"id": "u1", "mobile_number": "98765 43210", "password": "$2b$test", "is_active": True, "email": "test@example.com"}
    db.users.insert_one(user.copy())
    return SimpleNamespace(db=db, user=user, send=sender, check=checker)


@pytest.mark.parametrize("value", ["9876543210", "+91 98765-43210", "919876543210", "(98765) 43210"])
def test_phone_normalization(value):
    phone = sms_verify.normalize_phone(value)
    assert phone == "+919876543210"
    assert re.fullmatch(sms_verify.phone_pattern(phone), value)


@pytest.mark.parametrize("value", ["123", "abc9876543210", "+0000000000", "", "9876543210 ext 9"])
def test_invalid_phone(value):
    with pytest.raises(HTTPException):
        sms_verify.normalize_phone(value)


def issue(setup):
    return run(mobile_login.issue(setup.user, "+919876543210"))


def test_disabled_fails_closed(setup, monkeypatch):
    monkeypatch.setenv("SMS_LOGIN_ENABLED", "false")
    assert run(v3_auth.login_options()) == {"mobile_sms_enabled": False}
    with pytest.raises(HTTPException) as error:
        issue(setup)
    assert error.value.status_code == 503
    setup.send.assert_not_called()


def test_single_use_masking_and_no_code_storage(setup):
    challenge = issue(setup)
    assert "token" not in challenge and "provider_sid" not in challenge
    assert challenge["phone_masked"].endswith("3210")
    assert "9876543210" not in str(challenge)
    assert not any("code" in key for key in setup.db.sms_login_challenges.find_one())
    assert run(mobile_login.consume(challenge["challenge_id"], "123456"))["id"] == "u1"
    with pytest.raises(HTTPException):
        run(mobile_login.consume(challenge["challenge_id"], "123456"))
    assert setup.check.await_count == 1


def test_expiry_blocks_provider_check(setup):
    challenge = issue(setup)
    setup.db.sms_login_challenges.update_one({}, {"$set": {"expires_at": now_utc() - timedelta(seconds=1)}})
    with pytest.raises(HTTPException):
        run(mobile_login.consume(challenge["challenge_id"], "123456"))
    setup.check.assert_not_called()


def test_wrong_code_limit_survives_resend(setup):
    challenge = issue(setup)
    setup.check.return_value = False
    for _ in range(4):
        with pytest.raises(HTTPException):
            run(mobile_login.consume(challenge["challenge_id"], "000000"))
    before = setup.db.sms_login_challenges.find_one()
    setup.db.sms_login_challenges.update_one({}, {"$set": {"next_send_at": now_utc() - timedelta(seconds=1)}})
    run(mobile_login.resend(challenge["challenge_id"]))
    after = setup.db.sms_login_challenges.find_one()
    assert after["attempts"] == 4 and after["expires_at"] == before["expires_at"]
    for _ in range(2):
        with pytest.raises(HTTPException):
            run(mobile_login.consume(challenge["challenge_id"], "000000"))
    assert setup.check.await_count == 5


def test_restart_and_resend_cannot_skip_cooldown(setup):
    challenge = issue(setup)
    with pytest.raises(HTTPException):
        issue(setup)
    with pytest.raises(HTTPException):
        run(mobile_login.resend(challenge["challenge_id"]))
    assert setup.send.await_count == 1


@pytest.mark.parametrize("change", [{"is_active": False}, {"mobile_number": "9876543211"}, {"password": "new-password"}])
def test_account_changes_invalidate_challenge(setup, change):
    challenge = issue(setup)
    setup.db.users.update_one({}, {"$set": change})
    with pytest.raises(HTTPException):
        run(mobile_login.consume(challenge["challenge_id"], "123456"))
    setup.check.assert_not_called()


def test_parallel_verify_only_one_success(setup):
    challenge = issue(setup)
    async def slow_check(*args):
        await asyncio.sleep(0.01)
        return True
    setup.check.side_effect = slow_check
    async def attempts():
        return await asyncio.gather(*[mobile_login.consume(challenge["challenge_id"], "123456") for _ in range(4)], return_exceptions=True)
    results = run(attempts())
    assert sum(isinstance(result, dict) for result in results) == 1
    assert setup.check.await_count == 1


def test_parallel_send_only_one_delivery(setup):
    async def attempts():
        return await asyncio.gather(*[mobile_login.issue(setup.user, "+919876543210") for _ in range(4)], return_exceptions=True)
    results = run(attempts())
    assert sum(isinstance(result, dict) for result in results) == 1
    assert setup.send.await_count == 1


def test_budget_is_atomic(setup):
    async def attempts():
        return await asyncio.gather(*[mobile_login.limit("budget", 3, 3600) for _ in range(10)], return_exceptions=True)
    results = run(attempts())
    assert sum(result is None for result in results) == 3


def test_provider_failure_never_issues_usable_challenge(setup):
    setup.send.side_effect = HTTPException(503, "Unavailable")
    with pytest.raises(HTTPException):
        issue(setup)
    assert setup.db.sms_login_challenges.find_one()["consumed"] is True


def test_daily_send_budget(setup, monkeypatch):
    monkeypatch.setenv("SMS_LOGIN_DAILY_LIMIT", "1")
    issue(setup)
    setup.db.sms_login_challenges.update_one({}, {"$set": {"next_send_at": now_utc() - timedelta(seconds=1)}})
    with pytest.raises(HTTPException) as error:
        issue(setup)
    assert error.value.status_code == 429
    assert setup.send.await_count == 1


def test_password_and_unique_account_required(setup, monkeypatch):
    monkeypatch.setattr(v3_auth, "verify_password", lambda plain, stored: plain == "correct")
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    payload = v3_auth.MobileLoginRequest(mobile_number="9876543210", password="wrong")
    with pytest.raises(HTTPException):
        run(v3_auth.login_mobile(payload, request))
    setup.send.assert_not_called()
    payload.password = "correct"
    result = run(v3_auth.login_mobile(payload, request))
    assert result["channel"] == "sms" and "token" not in result
    setup.db.users.insert_one({**setup.user, "id": "u2", "mobile_number": "+91 98765 43210"})
    with pytest.raises(HTTPException):
        run(v3_auth.login_mobile(payload, request))
    assert setup.send.await_count == 1


def test_sms_does_not_bypass_email_two_factor(setup, monkeypatch):
    setup.db.users.update_one({}, {"$set": {"two_factor_enabled": True}})
    challenge = issue(setup)
    email = AsyncMock(return_value={"challenge_id": "email-challenge"})
    session = AsyncMock()
    monkeypatch.setattr(v3_auth.two_factor, "issue_challenge", email)
    monkeypatch.setattr(v3_auth, "_issue_session", session)
    result = run(v3_auth.verify_mobile(v3_auth.MobileCodeRequest(challenge_id=challenge["challenge_id"], code="123456")))
    assert result["two_factor_required"] is True
    email.assert_awaited_once()
    session.assert_not_called()


def test_email_login_still_works_when_sms_disabled(setup, monkeypatch):
    monkeypatch.setenv("SMS_LOGIN_ENABLED", "false")
    monkeypatch.setattr(v3_auth, "verify_password", lambda *args: True)
    session = AsyncMock(return_value={"token": "email-session"})
    monkeypatch.setattr(v3_auth, "_issue_session", session)
    result = run(v3_auth.v3_login(V3LoginRequest(email="test@example.com", password="correct")))
    assert result["token"] == "email-session"
    setup.send.assert_not_called()


def test_adapter_uses_verification_sid_and_requires_approved(monkeypatch):
    post = AsyncMock(return_value={"sid": "VE" + "a" * 32, "status": "pending"})
    monkeypatch.setattr(sms_verify, "_post", post)
    assert run(sms_verify.check("VE" + "a" * 32, "123456")) is False
    post.assert_awaited_with("VerificationCheck", {"VerificationSid": "VE" + "a" * 32, "Code": "123456"})
    post.return_value["status"] = "approved"
    assert run(sms_verify.check("VE" + "b" * 32, "123456")) is False
    assert run(sms_verify.check("VE" + "a" * 32, "123456")) is True


def test_provider_errors_do_not_expose_details(setup, monkeypatch):
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            return httpx.Response(401, json={"message": "private provider details"}, request=httpx.Request("POST", url))
    monkeypatch.setattr(sms_verify.httpx, "AsyncClient", Client)
    with pytest.raises(HTTPException) as error:
        run(sms_verify._post("Verifications", {}))
    assert error.value.status_code == 503 and "private" not in error.value.detail


def test_account_mobile_validation_and_duplicate_detection(setup):
    assert run(v3_hr._validated_login_mobile("+91 98765 43210", "u1")) == "+919876543210"
    assert run(v3_hr._validated_login_mobile("", "u1")) == ""
    with pytest.raises(HTTPException):
        run(v3_hr._validated_login_mobile("9876543210", "u2"))
    with pytest.raises(HTTPException):
        run(v3_hr._validated_login_mobile("9", "u1"))
