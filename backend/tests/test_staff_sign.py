"""Whose sign goes on which paper, and that a sign is its own person's to add.

Runs on an in-memory stand-in for Mongo, so it touches no database.
"""
import asyncio
import io
import os
import re
import struct
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "test_staff_sign")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import staff_sign  # noqa: E402
from routers import v3_consultation_forms, v3_staff_sign  # noqa: E402
from schemas.v3 import V3UserOut  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def _has(have, want):
    """Mongo's own rule: a list field matches on any one of its values."""
    if isinstance(want, dict):
        if "$in" in want:
            return any(v in want["$in"] for v in (have if isinstance(have, list) else [have]))
        if "$ne" in want:
            return have != want["$ne"]
        if "$regex" in want:
            return bool(re.search(want["$regex"], str(have or ""), re.I))
        raise AssertionError(f"unhandled query {want}")
    return want in have if isinstance(have, list) else have == want


def _match(doc, query):
    for key, want in (query or {}).items():
        if key == "$or":
            if not any(_match(doc, q) for q in want):
                return False
        elif not _has(doc.get(key), want):
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        self.rows.sort(key=lambda r: str(r.get(key) or ""), reverse=direction < 0)
        return self

    async def to_list(self, n):
        return self.rows[:n]

    async def __aiter__(self):
        for row in self.rows:
            yield row


class Col:
    def __init__(self):
        self.rows = []

    async def find_one(self, query=None, projection=None):
        return next((dict(r) for r in self.rows if _match(r, query)), None)

    def find(self, query=None, projection=None):
        return Cursor([dict(r) for r in self.rows if _match(r, query)])

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

    async def delete_many(self, query):
        kept = [r for r in self.rows if not _match(r, query)]
        gone, self.rows = len(self.rows) - len(kept), kept
        return SimpleNamespace(deleted_count=gone)

    async def update_one(self, query, change):
        for row in self.rows:
            if _match(row, query):
                row.update(change["$set"])
                break


def png(width=300, height=90, pad=0):
    return staff_sign.PNG_MAGIC + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\0\0\0" + b"\0" * (8 + pad)


def login(role, uid="me", branch="b1", name="Me"):
    return V3UserOut(id=uid, full_name=name, email="x@gmail.com", role=role, branch_id=branch, created_at="2026-01-01")


USERS = [
    {"id": "admin", "full_name": "Priya R", "role": "branch_admin", "branch_id": "b1"},
    {"id": "cons", "full_name": "Dr. Asha K.", "role": "consultant", "branch_id": "b2", "branch_ids": ["b1", "b2"]},
    {"id": "phy", "full_name": "Ravi", "role": "physio", "branch_id": "b1"},
    {"id": "phy2", "full_name": "Ravi", "role": "physio", "branch_id": "b2"},
    {"id": "far", "full_name": "Meena", "role": "physio", "branch_id": "b2"},
    {"id": "tele", "full_name": "Tele", "role": "pre_sales", "branch_id": "b1"},
    {"id": "boss", "full_name": "Boss", "role": "super_admin"},
    {"id": "acc", "full_name": "Books", "role": "accountant"},
]
DOCTORS = [
    {"id": "d-cons", "profile_type": "head_physio", "user_id": "cons", "full_name": "Dr. Asha K."},
    {"id": "d-phy", "profile_type": "physio", "user_id": "phy", "branch_id": "b1", "full_name": "Ravi"},
]


@pytest.fixture
def db(monkeypatch):
    cols = {}

    def get(name):
        return cols.setdefault(name, Col())

    async def serving(rows, branch_id):
        return [r for r in rows if r["profile_type"] != "head_physio" or r["user_id"] == "cons"]

    for mod in (staff_sign, v3_staff_sign, v3_consultation_forms):
        monkeypatch.setattr(mod, "v3_col", get)
    monkeypatch.setattr(staff_sign, "consultants_serving_branch", serving)
    get("users").rows = [dict(u) for u in USERS]
    get("doctors").rows = [dict(d) for d in DOCTORS]
    get("branches").rows = [{"id": "b1", "branch_name": "Anna Nagar"}]
    return get


def put(db, user_id, image, valid_from="2026-11-01T06:00:00+00:00", sign_id=None):
    db(staff_sign.COL).rows.append({"id": sign_id or f"{user_id}-{image}", "user_id": user_id, "image": image, "valid_from": valid_from})


def url(image):
    return f"data:image/png;base64,{image}"


def test_names_are_compared_without_titles_or_punctuation():
    assert staff_sign.name_key("Dr. Asha  K.") == staff_sign.name_key("asha k")
    assert staff_sign.name_key("Dr") == "dr"
    assert staff_sign.name_key("அன்பு")


def test_a_bill_carries_the_collectors_sign(db):
    put(db, "admin", "PRIYA")
    assert run(staff_sign.collector_sign("Priya R", "b1", "2026-11-20T05:00:00+00:00")) == url("PRIYA")
    assert run(staff_sign.collector_sign("Nobody", "b1", "")) == ""
    assert run(staff_sign.collector_sign("", "b1", "")) == ""
    # A collector with no sign: the line stays blank.
    assert run(staff_sign.collector_sign("Books", "b1", "")) == ""


def test_of_two_with_one_name_the_branch_decides_and_else_nobody_signs(db):
    put(db, "phy", "HERE")
    put(db, "phy2", "THERE")
    assert run(staff_sign.collector_sign("Ravi", "b1", "")) == url("HERE")
    assert run(staff_sign.collector_sign("Ravi", "b2", "")) == url("THERE")
    assert run(staff_sign.collector_sign("Ravi", "b9", "")) == ""


def test_someone_who_left_still_signs_their_old_bills(db):
    put(db, "admin", "PRIYA")
    next(u for u in db("users").rows if u["id"] == "admin")["is_active"] = False
    assert run(staff_sign.collector_sign("Priya R", "b1", "2026-11-20T05:00:00+00:00")) == url("PRIYA")


def test_a_bill_is_given_even_when_the_sign_cannot_be_read(db, monkeypatch):
    async def broken(*_a):
        raise RuntimeError("down")

    monkeypatch.setattr(staff_sign, "user_named", broken)
    assert run(staff_sign.collector_sign("Priya R", "b1", "")) == ""


def test_a_new_sign_does_not_resign_old_papers(db):
    put(db, "admin", "OLD", "2026-11-01T06:00:00+00:00")
    put(db, "admin", "NEW", "2026-11-10T06:00:00+00:00")
    sign = lambda at: run(staff_sign.collector_sign("Priya R", "b1", at))  # noqa: E731
    assert sign("2026-11-05T06:00:00+00:00") == url("OLD")
    assert sign("2026-11-12T06:00:00+00:00") == url("NEW")
    # Before they had one at all: the one they have now.
    assert sign("2026-10-01T06:00:00") == url("NEW")


def test_a_second_upload_the_same_day_is_a_correction(db):
    me = login("branch_admin", "admin", name="Priya R")
    first = run(staff_sign.save({"id": "admin", "full_name": "Priya R"}, png(), me.model_dump()))
    again = run(staff_sign.save({"id": "admin", "full_name": "Priya R"}, png(pad=4), me.model_dump()))
    assert again["id"] == first["id"] and len(db(staff_sign.COL).rows) == 1
    db(staff_sign.COL).rows[0]["valid_from"] = "2026-01-01T06:00:00+00:00"
    run(staff_sign.save({"id": "admin", "full_name": "Priya R"}, png(), me.model_dump()))
    assert len(db(staff_sign.COL).rows) == 2


@pytest.mark.parametrize("data", [
    pytest.param(b"", id="empty"), pytest.param(b"not a png" * 9, id="not-a-png"),
    pytest.param(b"<svg onload=alert(1)>" * 5, id="svg"), pytest.param(png(5000, 90), id="too-wide"),
    pytest.param(png(300, 0), id="no-height"), pytest.param(png(pad=staff_sign.MAX_BYTES), id="too-heavy"),
])
def test_only_a_small_png_is_kept(db, data):
    with pytest.raises(HTTPException):
        run(v3_staff_sign.upload_my_signature(UploadFile(filename="s.png", file=io.BytesIO(data)), login("physio", "phy")))
    assert db(staff_sign.COL).rows == []


def test_nobody_can_reach_anothers_sign():
    # The only ways to a sign itself: one's own, and the papers'.
    paths = {(m, r.path) for r in v3_staff_sign.router.routes for m in r.methods}
    assert paths == {
        ("GET", "/api/v3/me/signature"), ("POST", "/api/v3/me/signature"), ("DELETE", "/api/v3/me/signature"),
        ("GET", "/api/v3/branches/{branch_id}/therapist-names"), ("GET", "/api/v3/branches/{branch_id}/therapist-sign"),
        ("GET", "/api/v3/leads/{lead_id}/prescription-sign"),
    }


def test_the_form_offers_the_branchs_therapists_and_consultants(db):
    admin = login("branch_admin", "admin", name="Priya R")
    assert run(v3_staff_sign.therapist_names("b1", admin)) == {"names": ["Dr. Asha K.", "Ravi"]}
    with pytest.raises(HTTPException) as e:
        run(v3_staff_sign.therapist_names("b2", admin))
    assert e.value.status_code == 403


def test_everyone_has_their_own_at_my_profile(db):
    me = login("pre_sales", "tele", name="Tele")
    assert run(v3_staff_sign.my_signature(me)) == {"name": "Tele", "image": "", "uploaded_at": "", "uploaded_by": ""}
    done = run(v3_staff_sign.upload_my_signature(UploadFile(filename="s.png", file=io.BytesIO(png())), me))
    assert run(v3_staff_sign.my_signature(me)) == done and done["uploaded_by"] == "Tele"
    # Theirs alone, and the same one the papers read.
    assert run(v3_staff_sign.my_signature(login("physio", "phy", name="Ravi")))["image"] == ""
    assert run(staff_sign.collector_sign("Tele", "b1", "")) == done["image"]
    with pytest.raises(HTTPException):
        run(v3_staff_sign.upload_my_signature(UploadFile(filename="s.svg", file=io.BytesIO(b"<svg>" * 20)), me))
    assert run(v3_staff_sign.my_signature(me)) == done


def test_deleting_your_own_takes_it_off_every_paper(db):
    put(db, "admin", "OLD", "2026-11-01T06:00:00+00:00")
    put(db, "admin", "NEW", "2026-11-10T06:00:00+00:00")
    put(db, "phy", "RAVI")
    me = login("branch_admin", "admin", name="Priya R")
    assert run(v3_staff_sign.delete_my_signature(me)) == {"name": "Priya R", "image": "", "uploaded_at": "", "uploaded_by": ""}
    assert run(v3_staff_sign.my_signature(me))["image"] == ""
    assert run(staff_sign.collector_sign("Priya R", "b1", "2026-11-05T06:00:00+00:00")) == ""
    # Nobody else's goes, and deleting again is not an error.
    assert [r["user_id"] for r in db(staff_sign.COL).rows] == ["phy"]
    assert run(v3_staff_sign.delete_my_signature(me))["image"] == ""
    # A new one signs the old papers too.
    again = run(v3_staff_sign.upload_my_signature(UploadFile(filename="s.png", file=io.BytesIO(png())), me))
    assert run(staff_sign.collector_sign("Priya R", "b1", "2026-11-05T06:00:00+00:00")) == again["image"]


def test_a_form_whose_sign_was_deleted_is_unsigned_until_there_is_another(db):
    admin = login("branch_admin", "admin", name="Priya R")
    put(db, "phy", "FIRST", "2026-11-01T06:00:00+00:00")
    row = run(v3_consultation_forms.create_consultation_form("b1", form_input(therapist_name="Ravi"), admin))
    run(v3_staff_sign.delete_my_signature(login("physio", "phy", name="Ravi")))
    read = lambda: run(v3_consultation_forms.get_consultation_form("b1", row["id"], admin))["therapist_sign"]  # noqa: E731
    assert read() is None
    put(db, "phy", "SECOND")
    assert read()["image"] == url("SECOND")


def test_a_form_is_signed_by_the_branchs_own_therapist(db):
    put(db, "phy", "HERE")
    put(db, "far", "FAR")
    admin = login("branch_admin", "admin", name="Priya R")
    assert run(v3_staff_sign.therapist_sign("b1", "dr ravi", admin))["image"] == url("HERE")
    # Another branch's therapist, typed here, signs nothing.
    assert run(v3_staff_sign.therapist_sign("b1", "Meena", admin))["image"] == ""
    assert run(v3_staff_sign.therapist_sign("b1", "Rav", admin))["image"] == ""


def form_input(**fields):
    return v3_consultation_forms.ConsultationFormInput(fields={"name": "Patient", **fields})


def test_a_saved_form_keeps_the_sign_it_was_saved_with(db):
    admin = login("branch_admin", "admin", name="Priya R")
    put(db, "phy", "FIRST", "2026-11-01T06:00:00+00:00")
    row = run(v3_consultation_forms.create_consultation_form("b1", form_input(therapist_name="Ravi"), admin))
    put(db, "phy", "SECOND", "2026-11-02T06:00:00+00:00")
    read = lambda: run(v3_consultation_forms.get_consultation_form("b1", row["id"], admin))["therapist_sign"]  # noqa: E731
    assert read() == {"name": "Ravi", "image": url("FIRST")}
    run(v3_consultation_forms.update_consultation_form("b1", row["id"], form_input(therapist_name="Ravi", age="40"), admin))
    assert read()["image"] == url("FIRST")
    # Another name is another sign, or none.
    run(v3_consultation_forms.update_consultation_form("b1", row["id"], form_input(therapist_name="Somebody"), admin))
    assert read() is None
    run(v3_consultation_forms.update_consultation_form("b1", row["id"], form_input(therapist_name="Ravi"), admin))
    assert read()["image"] == url("SECOND")


def test_a_form_saved_before_the_sign_was_uploaded_shows_it_after(db):
    admin = login("branch_admin", "admin", name="Priya R")
    row = run(v3_consultation_forms.create_consultation_form("b1", form_input(therapist_name="Ravi"), admin))
    assert run(v3_consultation_forms.get_consultation_form("b1", row["id"], admin))["therapist_sign"] is None
    put(db, "phy", "LATER")
    assert run(v3_consultation_forms.get_consultation_form("b1", row["id"], admin))["therapist_sign"]["image"] == url("LATER")


def test_the_clients_link_never_carries_the_sign(db):
    put(db, "phy", "HERE")
    db("consultation_forms").rows.append({"id": "f", "branch_id": "b1", "share_token": "a" * 32, "client_status": "requested", "therapist_name": "Ravi"})

    async def names():
        return []

    v3_consultation_forms._offline_branch_names, kept = names, v3_consultation_forms._offline_branch_names
    try:
        out = run(v3_consultation_forms.public_get_consultation_form("a" * 32))
    finally:
        v3_consultation_forms._offline_branch_names = kept
    assert "HERE" not in str(out) and "therapist" not in str(out)


def test_a_prescription_carries_the_consultant_it_prints(db):
    put(db, "cons", "ASHA")
    put(db, "phy", "RAVI")
    db("leads").rows.append({"id": "l1", "branch_id": "b1", "assigned_physio_id": "d-cons", "assigned_physio_name": "Dr. Asha K.", "appointment_date": "2026-11-20"})
    admin = login("branch_admin", "admin", name="Priya R")
    assert run(v3_staff_sign.prescription_sign("l1", admin)) == {"name": "Dr. Asha K.", "image": url("ASHA")}
    # The record moved on to the physio: the name printed is the physio's, and so is the sign.
    db("leads").rows[0].update(assigned_physio_id="d-phy", assigned_physio_name="Ravi")
    assert run(v3_staff_sign.prescription_sign("l1", admin))["image"] == url("RAVI")
    # An id and a name that disagree follow the name printed.
    db("leads").rows[0].update(assigned_physio_id="d-phy", assigned_physio_name="Dr. Asha K.")
    assert run(v3_staff_sign.prescription_sign("l1", admin))["image"] == url("ASHA")
    with pytest.raises(HTTPException) as e:
        run(v3_staff_sign.prescription_sign("l1", login("branch_admin", "x", "b2")))
    assert e.value.status_code == 403


def test_no_sign_is_an_empty_answer(db):
    db("leads").rows.append({"id": "l1", "branch_id": "b1", "assigned_physio_name": "Dr. Asha K."})
    assert run(v3_staff_sign.prescription_sign("l1", login("head_physio", "cons", None))) == {"name": "", "image": ""}
