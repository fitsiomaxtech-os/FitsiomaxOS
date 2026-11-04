"""Developer Access > Undo Payment: a To Verify payment off the books and owed again, behind
its own switch, sharing the Before Verify bin's take-back. No server or DB — the collections
are in memory."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routers.v3_finance as finance
from routers.v3_finance import delete_unverified_transaction, undo_unverified_payment

DESK = SimpleNamespace(full_name="Priya", role="branch_admin", branch_id="che")
DAY = "2026-11-04T10:00:00"


def _matches(doc, query):
    for key, want in query.items():
        have = doc.get(key)
        if isinstance(want, dict):
            if "$ne" in want and have == want["$ne"]:
                return False
            if "$in" in want and have not in want["$in"]:
                return False
        elif have != want:
            return False
    return True


class _Result:
    def __init__(self, count):
        self.deleted_count = self.matched_count = count


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, _):
        return self.docs


class _Col:
    def __init__(self, *docs):
        self.docs = [dict(d) for d in docs]

    async def find_one(self, query, _=None):
        return next((dict(d) for d in self.docs if _matches(d, query)), None)

    def find(self, query, _=None):
        return _Cursor([dict(d) for d in self.docs if _matches(d, query)])

    async def insert_one(self, doc):
        self.docs.append(doc)

    async def update_one(self, query, change):
        hit = next((d for d in self.docs if _matches(d, query)), None)
        for path, value in (change.get("$set", {}) if hit else {}).items():
            # "details.installments" walks into details, as Mongo does.
            *parents, leaf = path.split(".")
            at = hit
            for key in parents:
                at = at.setdefault(key, {})
            at[leaf] = value
        return _Result(1 if hit else 0)

    async def delete_one(self, query):
        hit = next((d for d in self.docs if _matches(d, query)), None)
        if hit:
            self.docs.remove(hit)
        return _Result(1 if hit else 0)

    async def delete_many(self, query):
        hits = [d for d in self.docs if _matches(d, query)]
        self.docs = [d for d in self.docs if d not in hits]
        return _Result(len(hits))


@pytest.fixture
def db(monkeypatch):
    """A lead with a consultation fee and a two-instalment session fee, the second collected."""
    cols = {
        "app_settings": _Col({"id": finance.UNDO_PAYMENT_SETTING_ID, "enabled": True}),
        "leads": _Col({
            "id": "bala", "name": "Bala", "branch_id": "che", "consultation_stage": "Fee Collected",
            "package_paid": 1000, "package_payment_mode": "full",
            "package_payment_details": {"mode": "cash"},
            "treatment_fee_paid": 30000, "treatment_fee_payment_mode": "full",
            "treatment_fee_payment_details": {"installments": [
                {"amount": 10000, "paid": True},
                {"amount": 20000, "paid": True, "transaction_id": "TXN-2", "scheduled_amount": 20000},
            ]},
        }),
        "lead_activity": _Col(
            {"id": "consult", "lead_id": "bala", "action": "package_payment_collected", "created_at": DAY,
             "transaction_id": "TXN-C"},
            {"id": "first", "lead_id": "bala", "action": "treatment_fee_collected", "created_at": DAY,
             "transaction_id": "TXN-1"},
            {"id": "second", "lead_id": "bala", "action": "treatment_fee_collected", "created_at": DAY,
             "transaction_id": "TXN-2"},
        ),
        "inventory_movements": _Col({"id": "sale", "kind": "sale", "branch_id": "che", "created_at": DAY}),
        "inventory_items": _Col(),
        "zumba_registrations": _Col(),
        "fitness_registrations": _Col(),
        "old_client_payments": _Col(),
    }
    monkeypatch.setattr(finance, "v3_col", lambda name: cols.setdefault(name, _Col()))

    async def open_book(*_):
        return cols.get("book")

    monkeypatch.setattr(finance, "_book_for", open_book)
    return cols


def _undo(activity_id):
    return asyncio.run(undo_unverified_payment(activity_id, user=DESK))


def _ids(db):
    return {d["id"] for d in db["lead_activity"].docs if "transaction_id" in d}


def _refused(call):
    with pytest.raises(HTTPException) as caught:
        asyncio.run(call)
    return caught.value


def test_switched_off_is_refused_and_touches_nothing(db):
    db["app_settings"].docs.clear()
    assert _refused(undo_unverified_payment("consult", user=DESK)).status_code == 403
    assert _ids(db) == {"consult", "first", "second"}


def test_a_consultation_fee_is_owed_again_and_the_stage_steps_back(db):
    db["leads"].docs[0].update({"treatment_fee_paid": None, "treatment_fee_payment_details": None})
    res = _undo("consult")
    lead = db["leads"].docs[0]
    assert res["message"] == "Consultation Fee undone -- Bala owes it again"
    assert lead["package_paid"] is None
    assert lead["consultation_stage"] == "Consultation Visit"
    assert "consult" not in _ids(db)


def test_a_later_instalment_goes_on_its_own_and_leaves_a_line_on_the_timeline(db):
    res = _undo("second")
    lead = db["leads"].docs[0]
    assert res["message"] == "Treatment Fee instalment undone — Rs.20000 is owed again"
    assert lead["treatment_fee_paid"] == 10000
    assert lead["treatment_fee_payment_details"]["installments"][1]["paid"] is False
    assert _ids(db) == {"consult", "first"}
    line = db["lead_activity"].docs[-1]
    assert line["action"] == "payment_undone"
    assert "undone by Priya" in line["details"]


def test_a_client_row_undoes_newest_first_down_to_nothing_owed_taken(db):
    _undo("second")
    _undo("first")
    assert db["leads"].docs[0]["treatment_fee_paid"] is None
    assert _ids(db) == {"consult"}


def test_a_store_sale_says_undone(db):
    assert _undo("sale")["message"] == "Store sale undone -- the stock is back on the shelf"
    assert db["inventory_movements"].docs == []


@pytest.mark.parametrize("stage", ["income_requested", "approved"])
def test_money_past_the_branch_is_refused(db, stage):
    db["lead_activity"].docs[0][stage] = True
    refused = _refused(undo_unverified_payment("consult", user=DESK))
    assert refused.status_code == 409
    assert refused.detail == "Only a payment still in To Verify can be undone — this one is with the accountant"
    assert "consult" in _ids(db)


def test_a_fee_with_a_payment_past_the_branch_is_not_reset_under_it(db):
    db["lead_activity"].docs[2]["income_requested"] = True
    refused = _refused(undo_unverified_payment("first", user=DESK))
    assert refused.status_code == 409
    assert "undoing this one would remove them too" in refused.detail


def test_a_closed_day_is_refused(db):
    db["book"] = {"status": "closed"}
    refused = _refused(undo_unverified_payment("consult", user=DESK))
    assert refused.status_code == 409
    assert "before undoing a payment" in refused.detail


def test_another_branch_reads_as_not_found(db):
    other = SimpleNamespace(full_name="Asha", role="branch_admin", branch_id="cbe")
    assert _refused(undo_unverified_payment("consult", user=other)).status_code == 404


def test_the_bin_keeps_its_own_switch_and_its_own_words(db):
    assert _refused(delete_unverified_transaction("second", user=DESK)).status_code == 403
    db["app_settings"].docs = [{"id": finance.BEFORE_VERIFY_DELETE_SETTING_ID, "enabled": True}]
    res = asyncio.run(delete_unverified_transaction("second", user=DESK))
    assert res["message"] == "Treatment Fee instalment deleted — Rs.20000 is owed again"
    assert db["lead_activity"].docs[-1]["action"] == "payment_deleted"
    assert _refused(undo_unverified_payment("first", user=DESK)).status_code == 403
