"""Branch Leads' Lost stage: seeded after Pre Book on each arm, locked once a lead is on it,
paired with Pre Sales' Lost on a Lead Control Both branch, and the slot goes back. No server
or DB -- the collections are in memory."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import lead_control
import routers.v3_branch_admin as branch_admin
import seed
import stage_utils
from routers.v3_branch_admin import v3_move_branch_stage
from schemas.v3 import V3BranchStageInput

DESK = SimpleNamespace(full_name="Priya", role="branch_admin", branch_id="che")


def _matches(doc, query):
    for key, want in query.items():
        have = doc.get(key)
        if isinstance(want, dict):
            if "$gte" in want and not (have or 0) >= want["$gte"]:
                return False
            if "$in" in want and have not in want["$in"]:
                return False
            if "$nin" in want and have in want["$nin"]:
                return False
        elif have != want:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, key, _):
        return _Cursor(sorted(self.docs, key=lambda d: d.get(key) or 0))

    async def to_list(self, _):
        return self.docs


class _Result:
    modified_count = 0


class _Col:
    def __init__(self, *docs):
        self.docs = [dict(d) for d in docs]

    async def find_one(self, query, _=None):
        return next((dict(d) for d in self.docs if _matches(d, query)), None)

    def find(self, query, _=None):
        return _Cursor([dict(d) for d in self.docs if _matches(d, query)])

    async def distinct(self, key, query):
        return list({d.get(key) for d in self.docs if _matches(d, query)})

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def insert_many(self, docs):
        self.docs.extend(dict(d) for d in docs)

    def _write(self, hits, change):
        result = _Result()
        for hit in hits:
            hit.update(change.get("$set", {}))
            for key, by in change.get("$inc", {}).items():
                hit[key] = (hit.get(key) or 0) + by
            result.modified_count += 1
        return result

    async def update_one(self, query, change):
        return self._write([d for d in self.docs if _matches(d, query)][:1], change)

    async def update_many(self, query, change):
        return self._write([d for d in self.docs if _matches(d, query)], change)


def _pipeline():
    rows = []
    for arm in ("offline", "online"):
        for order, (name, role) in enumerate([
            ("New Appointment", None),
            ("RNR", "rnr"),
            ("Follow Up", "follow_up"),
            ("Appointment", "appointment"),
            ("Not a prospect", "not_a_prospect"),
            ("Pre Book", "pre_book"),
            ("Lost", "lost"),
            ("Cancelled", "cancelled"),
        ]):
            row = {"id": f"{arm}-{order}", "name": name, "type": "sales", "order": order, "arm": arm}
            if role:
                row["role"] = role
            rows.append(row)
    return rows


@pytest.fixture
def db(monkeypatch):
    cols = {
        "leads": _Col(),
        "appointments": _Col(),
        "pipeline_stages": _Col(*_pipeline()),
        "lead_activity": _Col(),
        "branches": _Col({"id": "che", "lead_control": "both"}),
        "migrations": _Col(),
    }
    get = lambda name: cols[name]  # noqa: E731
    monkeypatch.setattr(stage_utils, "v3_col", get)
    monkeypatch.setattr(branch_admin, "v3_col", get)
    monkeypatch.setattr(seed, "v3_col", get)

    async def _control(_):
        return lead_control.BOTH

    async def _arm(**_):
        return "offline"

    async def _names(*_):
        return [r["name"] for r in cols["pipeline_stages"].docs if r["arm"] == "offline"]

    monkeypatch.setattr(lead_control, "branch_lead_control", _control)
    monkeypatch.setattr(stage_utils, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "_branch_stage_names", _names)
    return cols


def _run(coro):
    return asyncio.run(coro)


def _strip(db, arm):
    rows = [r for r in db["pipeline_stages"].docs if r["arm"] == arm]
    return [r["name"] for r in sorted(rows, key=lambda r: r["order"])]


def test_seed_puts_lost_straight_after_pre_book_on_each_arm_and_only_once(db):
    db["pipeline_stages"].docs = [r for r in db["pipeline_stages"].docs if r["name"] != "Lost"]
    for r in db["pipeline_stages"].docs:
        if r["name"] == "Cancelled":
            r["order"] = 6

    _run(seed.ensure_branch_lost_stage())
    _run(seed.ensure_branch_lost_stage())

    for arm in ("offline", "online"):
        assert _strip(db, arm)[-3:] == ["Pre Book", "Lost", "Cancelled"]
    lost = [r for r in db["pipeline_stages"].docs if r["name"] == "Lost"]
    assert len(lost) == 2
    # Not final, or a branch running its own leads would lose the pill (see leadPillStages).
    assert all(r["role"] == "lost" and r["is_final"] is False for r in lost)


def test_a_lost_lead_refuses_every_move_and_a_renamed_stage_stays_locked(db):
    with pytest.raises(HTTPException) as refused:
        _run(stage_utils.refuse_if_branch_lost({"branch_stage": "Lost"}))
    assert refused.value.status_code == 409

    for row in db["pipeline_stages"].docs:
        if row.get("role") == "lost":
            row["name"] = "Gone"
    with pytest.raises(HTTPException):
        _run(stage_utils.refuse_if_branch_lost({"branch_stage": "Gone"}))

    _run(stage_utils.refuse_if_branch_lost({"branch_stage": "Follow Up"}))
    _run(stage_utils.refuse_if_branch_lost(None))


def test_the_move_to_lost_frees_the_slot_and_then_the_lead_cannot_leave(db):
    db["leads"].docs.append({
        "id": "l1", "name": "Asha", "phone": "9840000000", "vertical": "offline_physiotherapy",
        "source_type": "manual", "extra_fields": {}, "created_at": "2026-11-04T10:00:00",
        "branch_id": "che", "stage": "Appointment", "branch_stage": "Appointment",
    })
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    moved = _run(v3_move_branch_stage("l1", V3BranchStageInput(branch_stage="Lost"), DESK))

    assert moved.branch_stage == "Lost"
    # Both desks, on this Lead Control Both branch.
    assert moved.stage == "Lost"
    assert db["appointments"].docs[0]["status"] == "cancelled"

    with pytest.raises(HTTPException) as refused:
        _run(v3_move_branch_stage("l1", V3BranchStageInput(branch_stage="Follow Up"), DESK))
    assert refused.value.status_code == 409
    assert db["leads"].docs[0]["branch_stage"] == "Lost"


def test_pre_sales_lost_lands_on_the_branch_lost_and_frees_the_slot(db):
    db["leads"].docs.append({"id": "l1", "branch_id": "che", "stage": "Lost", "branch_stage": "Appointment"})
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    _run(stage_utils.match_desk_stages("l1", "stage", "Priya", "pre_sales"))

    assert db["leads"].docs[0]["branch_stage"] == "Lost"
    assert db["appointments"].docs[0]["status"] == "cancelled"


def test_a_board_with_no_lost_stage_still_takes_pre_sales_lost_as_not_a_prospect(db):
    db["pipeline_stages"].docs = [r for r in db["pipeline_stages"].docs if r["name"] != "Lost"]
    db["leads"].docs.append({"id": "l1", "branch_id": "che", "stage": "Lost", "branch_stage": "Appointment"})

    _run(stage_utils.match_desk_stages("l1", "stage", "Priya", "pre_sales"))

    assert db["leads"].docs[0]["branch_stage"] == "Not a prospect"


def test_the_one_shot_moves_only_both_branch_leads_written_off_as_not_a_prospect(db):
    db["branches"].docs.append({"id": "own", "lead_control": "branch_admin"})
    db["leads"].docs += [
        {"id": "moved", "branch_id": "che", "stage": "Lost", "branch_stage": "Not a prospect"},
        {"id": "own-stage", "branch_id": "che", "stage": "Lost", "branch_stage": "Cancelled"},
        {"id": "live", "branch_id": "che", "stage": "Not a prospect", "branch_stage": "Not a prospect"},
        {"id": "other-control", "branch_id": "own", "stage": "Lost", "branch_stage": "Not a prospect"},
    ]

    _run(seed.move_both_desk_lost_leads())
    # The marker: a lead put back by hand afterwards is not moved on the next boot.
    db["leads"].docs[0]["branch_stage"] = "Not a prospect"
    _run(seed.move_both_desk_lost_leads())

    by_id = {d["id"]: d["branch_stage"] for d in db["leads"].docs}
    assert by_id == {
        "moved": "Not a prospect",
        "own-stage": "Cancelled",
        "live": "Not a prospect",
        "other-control": "Not a prospect",
    }
    assert db["migrations"].docs[0]["leads_moved"] == 1
