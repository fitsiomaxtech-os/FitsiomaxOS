"""The consultation pipeline's Cancel stage became Quit: renamed in place, the leads and Past
Data clients on it moved with it, and the Branch pipeline's Cancelled left alone. No server
or DB -- the collections are in memory."""
import asyncio
from types import SimpleNamespace

import pytest

import past_data_live
import routers.v3_branch_admin as branch_admin
import seed
import stage_utils
from routers.v3_branch_admin import v3_move_consultation_stage
from schemas.v3 import V3ConsultationStageInput

DESK = SimpleNamespace(full_name="Priya", role="branch_admin", branch_id="che")


def _matches(doc, query):
    for key, want in query.items():
        have = doc.get(key)
        if isinstance(want, dict):
            if "$gte" in want and not (have or 0) >= want["$gte"]:
                return False
            if "$gt" in want and not (have or 0) > want["$gt"]:
                return False
            if "$ne" in want and have == want["$ne"]:
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

    def sort(self, key, direction=1):
        return _Cursor(sorted(self.docs, key=lambda d: d.get(key) or 0, reverse=direction < 0))

    def limit(self, n):
        return _Cursor(self.docs[:n])

    async def to_list(self, _):
        return self.docs

    async def distinct(self, key):
        return list({d.get(key) for d in self.docs})


class _Result:
    modified_count = 0


class _Col:
    def __init__(self, *docs):
        self.docs = [dict(d) for d in docs]

    async def find_one(self, query, _=None, **__):
        return next((dict(d) for d in self.docs if _matches(d, query)), None)

    def find(self, query=None, _=None):
        return _Cursor([dict(d) for d in self.docs if _matches(d, query or {})])

    async def distinct(self, key, query):
        return list({d.get(key) for d in self.docs if _matches(d, query)})

    async def count_documents(self, query):
        return sum(1 for d in self.docs if _matches(d, query))

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def insert_many(self, docs):
        self.docs.extend(dict(d) for d in docs)

    async def delete_one(self, query):
        hit = next((d for d in self.docs if _matches(d, query)), None)
        if hit:
            self.docs.remove(hit)

    async def delete_many(self, query):
        self.docs = [d for d in self.docs if not _matches(d, query)]

    def _write(self, hits, change):
        result = _Result()
        for hit in hits:
            hit.update(change.get("$set", {}))
            for key, by in change.get("$inc", {}).items():
                hit[key] = (hit.get(key) or 0) + by
            result.modified_count += 1
        return result

    async def update_one(self, query, change, **_):
        return self._write([d for d in self.docs if _matches(d, query)][:1], change)

    async def update_many(self, query, change):
        return self._write([d for d in self.docs if _matches(d, query)], change)


STAGES = ["Consultation Booked", "Consultation Visit", "Fee Collected", "Physio Assign", "Rehab",
          "Diet Consultation", "Diet Chart", "Completed", "Cancel"]


def _pipeline():
    rows = [{"id": f"c{i}", "name": n, "type": "consultation", "order": i, "color": f"#00000{i}"}
            for i, n in enumerate(STAGES)]
    return rows + [{"id": "s1", "name": "Cancelled", "type": "sales", "order": 7, "arm": "offline"}]


def _lead(lead_id, **fields):
    return {
        "id": lead_id, "name": "Test Asha", "phone": "9000000001", "service": "Physiotherapy",
        "source_type": "manual", "vertical": "physio", "extra_fields": {}, "created_at": "2026-11-04T10:00:00",
        "branch_id": "che", "stage": "Appointment", "branch_stage": "Appointment", **fields,
    }


@pytest.fixture
def db(monkeypatch):
    cols = {
        "leads": _Col(),
        "past_clients": _Col(),
        "appointments": _Col(),
        "pipeline_stages": _Col(*_pipeline()),
        "lead_activity": _Col(),
        "migrations": _Col(),
    }
    get = lambda name: cols[name]  # noqa: E731
    monkeypatch.setattr(stage_utils, "v3_col", get)
    monkeypatch.setattr(branch_admin, "v3_col", get)
    monkeypatch.setattr(seed, "v3_col", get)
    return cols


def _run(coro):
    return asyncio.run(coro)


def _stages(db):
    rows = [r for r in db["pipeline_stages"].docs if r["type"] == "consultation"]
    return sorted(rows, key=lambda r: r["order"])


def _rename():
    _run(seed.rename_consultation_cancel_stage())


def _boot():
    """Every consultation pass, in server.py's order."""
    async def go():
        await seed.rename_consultation_cancel_stage()
        await seed.migrate_consultation_stages()
        await seed.ensure_consultation_booked_stage()
        await seed.ensure_rehab_stage()
        await seed.ensure_diet_and_completed_stages()
        await seed.ensure_diet_chart_stage()
        await seed.retire_consultation_completed_stage()
    _run(go())


def test_one_row_is_renamed_and_the_rest_are_not_touched(db):
    _rename()

    rows = _stages(db)
    assert [r["name"] for r in rows] == [*STAGES[:-1], "Quit"]
    assert [r["id"] for r in rows] == [f"c{i}" for i in range(len(STAGES))]
    assert rows[-1]["color"] == "#000008"


def test_a_whole_boot_ends_on_the_pipeline_with_quit_last(db):
    _boot()

    assert [r["name"] for r in _stages(db)] == [*STAGES[:-1], "Quit"]


def test_a_lead_on_it_stays_on_it_instead_of_the_orphan_sweep_taking_it(db):
    db["leads"].docs.append(_lead("l1", consultation_stage="Cancel"))

    _boot()

    assert db["leads"].docs[0]["consultation_stage"] == "Quit"


def test_the_branch_pipelines_cancelled_is_another_stage_and_is_left_alone(db):
    db["leads"].docs.append(_lead("l1", branch_stage="Cancelled", consultation_stage=None))

    _boot()

    assert db["leads"].docs[0]["branch_stage"] == "Cancelled"
    assert any(r["name"] == "Cancelled" for r in db["pipeline_stages"].docs if r["type"] == "sales")


def test_a_lead_still_on_the_older_cancelled_label_follows_it_to_quit(db):
    db["leads"].docs.append(_lead("l1", consultation_stage="Cancelled"))

    _boot()

    assert db["leads"].docs[0]["consultation_stage"] == "Quit"


def test_an_os_data_client_moves_and_keeps_what_the_sheet_said(db):
    db["past_clients"].docs.append({"id": "p1", "current_stage": "Cancel", "latest_status": "Cancel",
                                    "current_stage_as_written": "cancel"})
    db["past_clients"].docs.append({"id": "p2", "current_stage": "", "latest_status": "Dropped"})

    _boot()

    moved, other = db["past_clients"].docs
    assert (moved["current_stage"], moved["latest_status"]) == ("Quit", "Quit")
    assert moved["current_stage_as_written"] == "cancel"
    assert other == {"id": "p2", "current_stage": "", "latest_status": "Dropped"}


def test_once_only_so_a_later_rename_is_not_undone(db):
    _rename()
    _stages(db)[-1]["name"] = "Cancel"

    _rename()

    assert _stages(db)[-1]["name"] == "Cancel"


def test_a_quit_added_by_hand_is_not_doubled_up(db):
    db["pipeline_stages"].docs.append({"id": "hand", "name": "Quit", "type": "consultation", "order": 9})
    db["leads"].docs.append(_lead("l1", consultation_stage="Cancel"))

    _rename()

    rows = _stages(db)
    assert [r["name"] for r in rows] == [*STAGES[:-1], "Quit"]
    assert [r["order"] for r in rows] == list(range(len(STAGES)))
    assert db["leads"].docs[0]["consultation_stage"] == "Quit"


def test_a_fresh_install_has_nothing_to_rename(db):
    db["pipeline_stages"].docs = []

    _boot()

    assert "Quit" in [r["name"] for r in _stages(db)]
    assert "Cancel" not in [r["name"] for r in _stages(db)]


@pytest.mark.parametrize("sent", ["Quit", "Cancel"])
def test_the_move_lands_on_quit_and_frees_the_slot_even_from_an_old_browser(db, sent):
    _boot()
    db["leads"].docs.append(_lead("l1", consultation_stage="Consultation Booked"))
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    moved = _run(v3_move_consultation_stage("l1", V3ConsultationStageInput(consultation_stage=sent), DESK))

    assert moved.consultation_stage == "Quit"
    assert db["appointments"].docs[0]["status"] == "cancelled"


def test_past_data_places_a_dropped_client_on_quit():
    names = {"entry": "Leads", "cancelled": "Cancelled", "consultation": {"Quit"}}

    assert past_data_live.stage_for({"latest_status": "Dropped"}, None) == "Quit"
    assert past_data_live.placement("Quit", names)["consultation_stage"] == "Quit"
    assert past_data_live.placement("Quit", {**names, "consultation": {"Cancel"}})["consultation_stage"] is None
