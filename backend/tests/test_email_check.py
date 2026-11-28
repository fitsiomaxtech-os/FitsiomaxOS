"""The automatic Email ID check, the code that verifies an inbox, and what each leaves alone.

Runs on an in-memory stand-in for Mongo, with DNS and SMTP replaced, so it touches neither.
"""
import asyncio
import os
import re
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "test_email_check")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import email_check  # noqa: E402
import feature_visibility  # noqa: E402
import login_guard  # noqa: E402
import two_factor  # noqa: E402
from email_utils import SmtpSendFailed  # noqa: E402
from routers import v3_auth, v3_hr, v3_security  # noqa: E402
from schemas.v3 import V3LoginRequest, V3TwoFactorResendRequest, V3TwoFactorVerifyRequest, V3UserOut  # noqa: E402


def hash_password(password):
    """Stands in for bcrypt, which this test neither needs nor exercises."""
    return f"$2b${password}"


def run(coro):
    return asyncio.run(coro)


def _match(doc, query):
    for key, want in (query or {}).items():
        have = doc.get(key)
        if isinstance(want, dict):
            if "$regex" in want:
                if not re.search(want["$regex"], str(have or ""), re.I if "i" in want.get("$options", "") else 0):
                    return False
            if "$ne" in want and have == want["$ne"]:
                return False
            if "$in" in want and have not in want["$in"]:
                return False
            if "$lt" in want and not (have is not None and have < want["$lt"]):
                return False
        elif have != want:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        self.rows.sort(key=lambda r: str(r.get(key) or ""), reverse=direction < 0)
        return self

    def skip(self, n):
        self.rows = self.rows[n:]
        return self

    async def to_list(self, n):
        return self.rows[:n]


class Col:
    def __init__(self):
        self.rows = []

    def _hits(self, query):
        return [r for r in self.rows if _match(r, query)]

    async def find_one(self, query=None, projection=None, sort=None):
        rows = self._hits(query)
        if sort:
            rows.sort(key=lambda r: str(r.get(sort[0][0]) or ""), reverse=sort[0][1] < 0)
        return dict(rows[0]) if rows else None

    def find(self, query=None, projection=None):
        return Cursor([dict(r) for r in self._hits(query)])

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

    async def update_one(self, query, change, upsert=False):
        hits = self._hits(query)
        for row in hits[:1]:
            row.update(change.get("$set", {}))
            for k, v in change.get("$inc", {}).items():
                row[k] = row.get(k, 0) + v
        return SimpleNamespace(matched_count=len(hits[:1]), modified_count=len(hits[:1]))

    async def delete_many(self, query):
        gone = self._hits(query)
        self.rows = [r for r in self.rows if r not in gone]
        return SimpleNamespace(deleted_count=len(gone))

    delete_one = delete_many


ADMIN = V3UserOut(id="boss", full_name="Boss", email="boss@gmail.com", role="super_admin", created_at="2026-01-01")


@pytest.fixture
def db(monkeypatch):
    cols = {}

    def get(name):
        return cols.setdefault(name, Col())

    for mod in (email_check, two_factor, v3_auth, v3_hr, v3_security, feature_visibility):
        monkeypatch.setattr(mod, "v3_col", get)
    for mod in (v3_auth, v3_hr, v3_security):
        monkeypatch.setattr(mod, "hash_password", hash_password)
    for mod in (v3_auth, v3_security):
        monkeypatch.setattr(mod, "verify_password", lambda plain, stored: stored == hash_password(plain))

    async def ok(*_a, **_k):
        return None

    async def refuse(*_a, **_k):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    monkeypatch.setattr(login_guard, "count_try", ok)
    monkeypatch.setattr(login_guard, "clear", ok)
    monkeypatch.setattr(login_guard, "refuse", refuse)

    async def roles():
        return ["physio_x", "super_admin", "accountant"]

    async def custom():
        return []

    monkeypatch.setattr(v3_hr, "_all_role_names", roles)
    monkeypatch.setattr(v3_hr, "_custom_roles", custom)

    # Three domains: one on Google, one on nobody's, one DNS cannot answer for.
    async def mx(domain):
        if domain == "clinic.test":
            return ["aspmx.l.google.com"]
        if domain == "corp.test":
            return ["corp-test.mail.protection.outlook.com"]
        if domain == "own.test":
            return ["mail.own.test"]
        if domain == "down.test":
            raise email_check.LookupFailed("no answer")
        return []

    monkeypatch.setattr(email_check, "_mx_hosts", mx)

    sent = []
    monkeypatch.setattr(two_factor, "smtp_configured", lambda: True)
    monkeypatch.setattr(two_factor, "send_email", lambda to, subject, body: sent.append((to, subject, body)))
    get.sent = sent
    return get


def code_in(db):
    return re.search(r"Code: (\d{6})", db.sent[-1][2]).group(1)


def add_user(db, uid="u1", email="rabi@nomail.test", **extra):
    row = {"id": uid, "full_name": "Rabi", "email": email, "password": hash_password("secret1"),
           "role": "physio_x", "is_active": True, "created_at": "2026-01-01", **extra}
    db("users").rows.append(row)
    return row


def me(row):
    return V3UserOut(**{k: v for k, v in row.items() if k != "password"})


# ---------------------------------------------------------------- the check itself

@pytest.mark.parametrize("email,status,provider", [
    ("Name.One@Gmail.com", "valid", "google"),
    ("name+tag@gmail.com", "valid", "google"),
    ("a@outlook.com", "valid", "outlook"),
    ("a_b@yahoo.co.in", "valid", "yahoo"),
    ("a@zohomail.in", "valid", "zoho"),
    ("a@clinic.test", "valid", "google"),
    ("a@corp.test", "valid", "outlook"),
    ("o'brien@own.test", "valid", "other"),
    ("x@own.test", "valid", "other"),
    ("a@nomail.test", "invalid", None),
    ("a@down.test", "unchecked", None),
    ("priya", "invalid", None),
    ("priya@", "invalid", None),
    ("priya@gmail", "invalid", None),
    ("pri ya@gmail.com", "invalid", None),
    ("a..b@own.test", "invalid", None),
    (".a@own.test", "invalid", None),
    ("a.@own.test", "invalid", None),
    ("a@-bad.test", "invalid", None),
    ("a@gmial.com", "invalid", None),
    ("a@gmail.co", "invalid", None),
    ("na_me@gmail.com", "invalid", None),
    ("", "invalid", None),
    (None, "invalid", None),
    ("a" * 250 + "@gmail.com", "invalid", None),
])
def test_check(db, email, status, provider):
    got = run(email_check.check(email))
    assert (got["status"], got["provider"]) == (status, provider), got


def test_slip_says_what_was_meant(db):
    assert run(email_check.check("priya@gmial.com"))["reason"] == "Did you mean priya@gmail.com?"


def test_a_lookup_that_fails_is_not_called_a_bad_address(db):
    with pytest.raises(HTTPException) as e:
        run(email_check.require_allowed("a@down.test"))
    assert e.value.status_code == 503 and "Try again" in e.value.detail


def test_taken_ignores_case_and_leaves_out_its_own_login(db):
    add_user(db, "u1", "Priya@Gmail.com")
    with pytest.raises(HTTPException) as e:
        run(email_check.require_allowed("priya@gmail.com"))
    assert e.value.status_code == 409
    assert run(email_check.require_allowed(" PRIYA@gmail.com ", "u1")) == "priya@gmail.com"


# ---------------------------------------------------------------- creating and editing logins

def new_login(email):
    return v3_hr.UserAccountCreate(full_name="New", email=email, password="secret1", role="physio_x")


def test_a_bad_email_creates_nothing(db):
    for bad in ("priya", "a@nomail.test", "a@gmial.com", "a@down.test"):
        with pytest.raises(HTTPException):
            run(v3_hr.create_user_account(new_login(bad), ADMIN))
    assert db("users").rows == []


def test_a_new_login_is_stored_lower_case_not_verified_and_owes_a_code(db):
    out = run(v3_hr.create_user_account(new_login("New.One@Gmail.com"), ADMIN))
    row = db("users").rows[0]
    assert row["email"] == "new.one@gmail.com" and row["email_verified_at"] is None and row["email_code_due"] is True
    assert "password" not in out


def test_an_old_test_login_can_still_be_edited_with_its_email_unchanged(db):
    add_user(db, "u1", "Rabi@nomail.test")
    run(v3_hr.update_user_account("u1", v3_hr.UserAccountUpdate(email="rabi@nomail.test", mobile_number="9876543210"), ADMIN))
    row = db("users").rows[0]
    assert row["email"] == "Rabi@nomail.test" and row["mobile_number"] == "+919876543210"
    # The email alone, unchanged: nothing to write, and not an error.
    assert run(v3_hr.update_user_account("u1", v3_hr.UserAccountUpdate(email="Rabi@nomail.test"), ADMIN))["id"] == "u1"


def test_a_changed_email_is_checked_and_stops_being_verified(db):
    add_user(db, "u1", "old@gmail.com", email_verified_at="2026-11-01")
    with pytest.raises(HTTPException):
        run(v3_hr.update_user_account("u1", v3_hr.UserAccountUpdate(email="a@nomail.test"), ADMIN))
    assert db("users").rows[0]["email_verified_at"] == "2026-11-01"
    run(v3_hr.update_user_account("u1", v3_hr.UserAccountUpdate(email="New@gmail.com"), ADMIN))
    assert db("users").rows[0]["email"] == "new@gmail.com" and db("users").rows[0]["email_verified_at"] is None


def test_employee_popup_password_change_on_an_old_test_login(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "designation": "Physio"})
    add_user(db, "u1", "rabi@nomail.test", employee_id="e1")
    before = db("users").rows[0]["password"]
    run(v3_hr.save_employee_account("e1", v3_hr.EmployeeAccountSave(email="rabi@nomail.test", password="secret2"), ADMIN))
    assert db("users").rows[0]["password"] != before and db("users").rows[0]["email"] == "rabi@nomail.test"
    with pytest.raises(HTTPException):
        run(v3_hr.save_employee_account("e1", v3_hr.EmployeeAccountSave(email="rabi2@nomail.test"), ADMIN))


# ---------------------------------------------------------------- one Email for employee and login

def test_employee_email_change_moves_the_login(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "email": "rabi@gmail.com"})
    add_user(db, "u1", "rabi@gmail.com", employee_id="e1", email_verified_at="2026-11-01")
    run(v3_hr.update_employee("e1", v3_hr.EmployeeUpdate(email=" New@Gmail.com "), ADMIN))
    assert db("employees").rows[0]["email"] == "new@gmail.com"
    u = db("users").rows[0]
    assert u["email"] == "new@gmail.com" and u["email_verified_at"] is None


def test_employee_email_same_address_leaves_the_login_verified(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "email": "rabi@gmail.com"})
    add_user(db, "u1", "rabi@gmail.com", employee_id="e1", email_verified_at="2026-11-01")
    run(v3_hr.update_employee("e1", v3_hr.EmployeeUpdate(email="RABI@gmail.com", phone="9"), ADMIN))
    assert db("employees").rows[0]["email"] == "rabi@gmail.com"
    assert db("users").rows[0]["email_verified_at"] == "2026-11-01"


def test_employee_email_refused_or_blank_changes_nothing(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "email": "rabi@gmail.com"})
    add_user(db, "u1", "rabi@gmail.com", employee_id="e1")
    add_user(db, "u2", "taken@gmail.com")
    for bad in ("a@nomail.test", "taken@gmail.com", ""):
        with pytest.raises(HTTPException):
            run(v3_hr.update_employee("e1", v3_hr.EmployeeUpdate(email=bad, phone="9"), ADMIN))
    assert db("employees").rows[0]["email"] == "rabi@gmail.com" and "phone" not in db("employees").rows[0]
    assert db("users").rows[0]["email"] == "rabi@gmail.com"


def test_employee_without_a_login_keeps_any_email(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "email": ""})
    run(v3_hr.update_employee("e1", v3_hr.EmployeeUpdate(email="someone@nomail.test"), ADMIN))
    assert db("employees").rows[0]["email"] == "someone@nomail.test"


def test_login_email_changes_reach_the_employee(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "designation": "Physio", "email": "old@gmail.com"})
    add_user(db, "u1", "old@gmail.com", employee_id="e1")
    run(v3_hr.save_employee_account("e1", v3_hr.EmployeeAccountSave(email="two@gmail.com"), ADMIN))
    assert db("employees").rows[0]["email"] == "two@gmail.com"
    run(v3_hr.update_user_account("u1", v3_hr.UserAccountUpdate(email="three@gmail.com"), ADMIN))
    assert db("employees").rows[0]["email"] == "three@gmail.com"


def test_a_new_login_for_an_employee_sets_their_email(db):
    db("employees").rows.append({"id": "e1", "full_name": "Rabi", "email": "personal@yahoo.com", "joining_date": "2026-01-01"})
    login = v3_hr.UserAccountCreate(full_name="Rabi", email="Rabi@Gmail.com", password="secret1", role="physio_x", employee_id="e1")
    run(v3_hr.create_user_account(login, ADMIN))
    assert db("employees").rows[0]["email"] == "rabi@gmail.com"


def test_startup_merge_gives_every_employee_their_logins_email(db, monkeypatch):
    import seed
    monkeypatch.setattr(seed, "v3_col", db)
    db("employees").rows += [
        {"id": "e1", "email": "personal@yahoo.com"},
        {"id": "e2", "email": ""},
        {"id": "e3", "email": "Same@gmail.com"},
        {"id": "e4", "email": "nologin@gmail.com"},
    ]
    add_user(db, "u1", "one@gmail.com", employee_id="e1")
    add_user(db, "u2", "two@gmail.com", employee_id="e2")
    add_user(db, "u3", "same@gmail.com", employee_id="e3")
    add_user(db, "u9", "free@gmail.com")
    run(seed.merge_employee_login_emails())
    rows = {e["id"]: e for e in db("employees").rows}
    assert rows["e1"]["email"] == "one@gmail.com" and rows["e1"]["email_before_merge"] == "personal@yahoo.com"
    assert rows["e2"]["email"] == "two@gmail.com" and "email_before_merge" not in rows["e2"]
    assert rows["e3"]["email"] == "Same@gmail.com" and "updated_at" not in rows["e3"]
    assert rows["e4"]["email"] == "nologin@gmail.com"


def test_verified_badge_names_the_mail_service(db):
    assert run(email_check.provider_of("a@clinic.test")) == "google"
    assert run(email_check.provider_of("a@gmail.com")) == "google"
    assert run(email_check.provider_of("a@down.test")) is None
    assert run(email_check.provider_of("")) is None


# ---------------------------------------------------------------- an admin verifying a login

BRANCH_ADMIN = V3UserOut(id="ba", full_name="BA", email="ba@gmail.com", role="branch_admin", branch_id="b1", created_at="2026-01-01")


def test_admin_verifies_a_login_with_the_code_its_holder_reads_out(db):
    add_user(db, "u1", "rabi@gmail.com")
    ch = run(v3_hr.start_user_email_verify("u1", ADMIN))
    assert db.sent[-1][0] == "rabi@gmail.com" and "Your admin is verifying" in db.sent[-1][2]
    with pytest.raises(HTTPException) as e:
        run(v3_hr.finish_user_email_verify("u1", v3_hr.UserEmailVerifyFinish(challenge_id=ch["challenge_id"], code="000000"), ADMIN))
    assert e.value.status_code == 401
    out = run(v3_hr.finish_user_email_verify("u1", v3_hr.UserEmailVerifyFinish(challenge_id=ch["challenge_id"], code=code_in(db)), ADMIN))
    assert out["email_verified_at"] and db("users").rows[0]["email_verified_at"] == out["email_verified_at"]
    with pytest.raises(HTTPException) as e:
        run(v3_hr.start_user_email_verify("u1", ADMIN))
    assert e.value.status_code == 400


def test_admin_verify_code_is_tied_to_its_login(db):
    add_user(db, "u1", "one@gmail.com")
    add_user(db, "u2", "two@gmail.com")
    ch = run(v3_hr.start_user_email_verify("u1", ADMIN))
    with pytest.raises(HTTPException) as e:
        run(v3_hr.finish_user_email_verify("u2", v3_hr.UserEmailVerifyFinish(challenge_id=ch["challenge_id"], code=code_in(db)), ADMIN))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        run(v3_hr.resend_user_email_verify("u2", v3_hr.UserEmailVerifyResend(challenge_id=ch["challenge_id"]), ADMIN))
    assert not db("users").rows[1].get("email_verified_at")


def test_admin_verify_refuses_an_address_changed_while_the_code_was_out(db):
    row = add_user(db, "u1", "old@gmail.com")
    ch = run(v3_hr.start_user_email_verify("u1", ADMIN))
    code = code_in(db)
    row["email"] = "new@gmail.com"
    with pytest.raises(HTTPException) as e:
        run(v3_hr.finish_user_email_verify("u1", v3_hr.UserEmailVerifyFinish(challenge_id=ch["challenge_id"], code=code), ADMIN))
    assert e.value.status_code == 409 and not row.get("email_verified_at")


def test_branch_admin_verifies_only_their_own_branch(db):
    db("employees").rows += [{"id": "e1", "branch_id": "b1"}, {"id": "e2", "branch_id": "b2"}]
    add_user(db, "u1", "mine@gmail.com", employee_id="e1")
    add_user(db, "u2", "theirs@gmail.com", employee_id="e2")
    add_user(db, "u3", "hr@gmail.com", employee_id="e1", role="hr_admin")
    assert run(v3_hr.start_user_email_verify("u1", BRANCH_ADMIN))["challenge_id"]
    for uid in ("u2", "u3"):
        with pytest.raises(HTTPException) as e:
            run(v3_hr.start_user_email_verify(uid, BRANCH_ADMIN))
        assert e.value.status_code == 403


def test_email_check_endpoint_knows_whose_login_it_is(db):
    add_user(db, "u1", "rabi@gmail.com", employee_id="e1")
    ask = lambda **k: run(v3_hr.check_login_email(v3_hr.EmailCheckRequest(email="rabi@gmail.com", **k), ADMIN))  # noqa: E731
    assert ask()["status"] == "invalid" and "Already used" in ask()["reason"]
    assert ask(employee_id="e1")["status"] == "valid"
    assert ask(user_id="u1")["status"] == "valid"


# ---------------------------------------------------------------- signing in

def sign_in(email, password="secret1"):
    return run(v3_auth.v3_login(V3LoginRequest(email=email, password=password)))


def test_an_old_test_login_signs_in_with_no_code(db):
    add_user(db, "u1", "rabi@nomail.test")
    out = sign_in("rabi@nomail.test")
    assert out.token and out.user.email_verified_at is None and db.sent == []


def test_a_new_login_gets_a_code_and_is_verified_by_it(db):
    add_user(db, "u1", "rabi@gmail.com", email_code_due=True, email_verified_at=None)
    out = sign_in("Rabi@gmail.com")
    assert out["two_factor_required"] and out["email_verify"] and db("sessions").rows == []
    assert db.sent[-1][0] == "rabi@gmail.com"

    with pytest.raises(HTTPException) as e:
        wrong = "000000" if code_in(db) != "000000" else "111111"
        run(v3_auth.v3_login_verify_2fa(V3TwoFactorVerifyRequest(challenge_id=out["challenge_id"], code=wrong)))
    assert e.value.status_code == 401 and db("sessions").rows == []

    done = run(v3_auth.v3_login_verify_2fa(V3TwoFactorVerifyRequest(challenge_id=out["challenge_id"], code=code_in(db))))
    assert done.token and done.user.email_verified_at
    assert db("users").rows[0]["email_code_due"] is False
    # The next one is just the password.
    assert sign_in("rabi@gmail.com").token and len(db.sent) == 1


def test_resend_on_the_first_sign_in_screen(db):
    add_user(db, "u1", "rabi@gmail.com", email_code_due=True)
    out = sign_in("rabi@gmail.com")
    again = V3TwoFactorResendRequest(challenge_id=out["challenge_id"])
    with pytest.raises(HTTPException) as e:
        run(v3_auth.v3_login_resend_2fa(again))
    assert e.value.status_code == 429
    db("two_factor_challenges").rows[0]["last_sent_at"] = "2026-01-01T00:00:00+00:00"
    assert run(v3_auth.v3_login_resend_2fa(again))["email_masked"] == "r**i@gmail.com"
    assert len(db.sent) == 2


def test_no_lock_out_when_the_code_cannot_be_sent(db, monkeypatch):
    add_user(db, "u1", "rabi@gmail.com", email_code_due=True)

    def boom(*_):
        raise SmtpSendFailed("535")

    monkeypatch.setattr(two_factor, "send_email", boom)
    out = sign_in("rabi@gmail.com")
    assert out.token and out.user.email_verified_at is None and db("users").rows[0]["email_code_due"] is True

    monkeypatch.setattr(two_factor, "smtp_configured", lambda: False)
    assert sign_in("rabi@gmail.com").token


def test_two_factor_still_gates_and_its_code_verifies_the_inbox(db, monkeypatch):
    add_user(db, "u1", "rabi@gmail.com", two_factor_enabled=True, email_code_due=True)
    out = sign_in("rabi@gmail.com")
    assert out["two_factor_required"] and "email_verify" not in out
    done = run(v3_auth.v3_login_verify_2fa(V3TwoFactorVerifyRequest(challenge_id=out["challenge_id"], code=code_in(db))))
    assert done.token and db("users").rows[0]["email_verified_at"]

    # 2FA is a gate: a server that cannot send its code must not let anybody through.
    def boom(*_):
        raise SmtpSendFailed("535")

    monkeypatch.setattr(two_factor, "send_email", boom)
    with pytest.raises(HTTPException) as e:
        sign_in("rabi@gmail.com")
    assert e.value.status_code == 503


def test_a_wrong_password_never_sends_a_code(db):
    add_user(db, "u1", "rabi@gmail.com", email_code_due=True)
    with pytest.raises(HTTPException):
        sign_in("rabi@gmail.com", "nope")
    assert db.sent == []


def test_an_email_verify_code_cannot_sign_anybody_in(db):
    row = add_user(db, "u1", "rabi@gmail.com")
    ch = run(v3_security.start_email_verify(v3_security.EmailStartRequest(email="rabi@gmail.com"), me(row)))
    with pytest.raises(HTTPException) as e:
        run(v3_auth.v3_login_verify_2fa(V3TwoFactorVerifyRequest(challenge_id=ch["challenge_id"], code=code_in(db))))
    assert e.value.status_code == 404 and db("sessions").rows == []


# ---------------------------------------------------------------- updating my own

def start(row, email, pwd=""):
    return run(v3_security.start_email_verify(
        v3_security.EmailStartRequest(email=email, current_password=pwd), me(row)))


def finish(row, challenge_id, code):
    return run(v3_security.finish_email_verify(
        v3_security.EmailVerifyRequest(challenge_id=challenge_id, code=code), me(row)))


def test_verifying_the_current_email_needs_no_password(db):
    row = add_user(db, "u1", "rabi@gmail.com")
    ch = start(row, "RABI@gmail.com")
    assert ch["changing"] is False
    out = finish(row, ch["challenge_id"], code_in(db))
    assert out["email"] == "rabi@gmail.com" and db("users").rows[0]["email_verified_at"]
    with pytest.raises(HTTPException) as e:
        start(row, "rabi@gmail.com")
    assert e.value.detail == "This Email ID is already verified"


def test_moving_to_a_new_email(db):
    db("employees").rows.append({"id": "e1", "email": "Rabi@nomail.test"})
    row = add_user(db, "u1", "rabi@nomail.test", employee_id="e1")
    for pwd in ("", "wrong"):
        with pytest.raises(HTTPException) as e:
            start(row, "rabi@gmail.com", pwd)
        assert e.value.detail == "Your current password is not right"
    with pytest.raises(HTTPException) as e:
        start(row, "rabi2@nomail.test", "secret1")
    assert "not allowed" in e.value.detail
    assert db.sent == []

    ch = start(row, "Rabi@gmail.com", "secret1")
    assert db.sent[-1][0] == "rabi@gmail.com"
    assert db("users").rows[0]["email"] == "rabi@nomail.test"  # nothing moves before the code

    with pytest.raises(HTTPException) as e:
        start(row, "rabi3@gmail.com", "secret1")
    assert e.value.status_code == 429

    out = finish(row, ch["challenge_id"], code_in(db))
    u = db("users").rows[0]
    assert out["email"] == u["email"] == "rabi@gmail.com" and u["email_verified_at"]
    assert db("employees").rows[0]["email"] == "rabi@gmail.com"
    assert sign_in("rabi@gmail.com").token


def test_the_employee_email_always_follows_the_login(db):
    # Personal > Email and Credentials > Email ID are one address now, so even an employee
    # record that held a different one is moved with the login.
    db("employees").rows.append({"id": "e1", "email": "personal@yahoo.com"})
    row = add_user(db, "u1", "rabi@nomail.test", employee_id="e1")
    ch = start(row, "rabi@gmail.com", "secret1")
    finish(row, ch["challenge_id"], code_in(db))
    assert db("employees").rows[0]["email"] == "rabi@gmail.com"


def test_somebody_elses_challenge_is_refused_unspent(db):
    one = add_user(db, "u1", "one@gmail.com")
    two = add_user(db, "u2", "two@gmail.com")
    ch = start(one, "one@gmail.com")
    with pytest.raises(HTTPException) as e:
        finish(two, ch["challenge_id"], code_in(db))
    assert e.value.status_code == 403
    assert finish(one, ch["challenge_id"], code_in(db))["email"] == "one@gmail.com"


def test_an_email_taken_while_the_code_was_out(db):
    row = add_user(db, "u1", "rabi@nomail.test")
    ch = start(row, "rabi@gmail.com", "secret1")
    add_user(db, "u2", "rabi@gmail.com")
    with pytest.raises(HTTPException) as e:
        finish(row, ch["challenge_id"], code_in(db))
    assert e.value.status_code == 409 and db("users").rows[0]["email"] == "rabi@nomail.test"


# ---------------------------------------------------------------- Developer Access

def test_the_message_ships_hidden_on_a_new_and_on_an_existing_install(db):
    assert "update_email_notice" in run(feature_visibility.hidden_features())
    db("app_settings").rows.append({
        "id": feature_visibility.SETTING_ID, "hidden": [],
        "known": [k for k in feature_visibility.FEATURE_KEYS if k != "update_email_notice"],
    })
    assert run(feature_visibility.hidden_features()) == ["update_email_notice"]
    db("app_settings").rows[0]["known"] = list(feature_visibility.FEATURE_KEYS)
    assert run(feature_visibility.hidden_features()) == []
