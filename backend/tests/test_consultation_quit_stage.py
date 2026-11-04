"""The two ways out of the consultation pipeline. Its Cancel stage became Quit, renamed in place
with the leads and Past Data clients on it, and Quit is for a patient who has been seen. Before
the visit the way out is Lost, and every lead already called off before its visit moves there.
No server or DB -- the collections are in memory."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import lead_control
import past_data_live
import routers.v3_branch_admin as branch_admin
import seed
import stage_utils
from routers.v3_branch_admin import v3_move_branch_stage, v3_move_consultation_stage
from schemas.v3 import V3BranchStageInput, V3ConsultationStageInput

DESK = SimpleNamespace(full_name="Priya", role="branch_admin", branch_id="che")


def _matches(doc, query):
    for key, want in query.items():
        if key == "$or":
            if not any(_matches(doc, option) for option in want):
                return False
            continue
        have = doc.get(key)
        if isinstance(want, dict):
            if "$exists" in want and (key in doc) != want["$exists"]:
                return False
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

    async def find_one(self, query, _=None, sort=None):
        hits = [d for d in self.docs if _matches(d, query)]
        if sort:
            hits.sort(key=lambda d: d.get(sort[0][0]) or 0)
        return dict(hits[0]) if hits else None

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
    for arm, lost in (("offline", "Lost"), ("online", "Gone")):
        for order, (name, role) in enumerate([("Appointment", "appointment"), (lost, "lost"), ("Cancelled", "cancelled")]):
            rows.append({"id": f"{arm}-{role}", "name": name, "type": "sales", "order": order, "arm": arm, "role": role})
    return rows


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
        "branches": _Col({"id": "che"}),
        "migrations": _Col(),
    }
    get = lambda name: cols[name]  # noqa: E731
    monkeypatch.setattr(stage_utils, "v3_col", get)
    monkeypatch.setattr(branch_admin, "v3_col", get)
    monkeypatch.setattr(seed, "v3_col", get)

    async def _control(_):
        return lead_control.BRANCH_ADMIN

    async def _arm(branch_id=None, role="", vertical=None):
        return "online" if vertical == "online" else "offline"

    async def _names(*_):
        return [r["name"] for r in cols["pipeline_stages"].docs if r["type"] == "sales"]

    monkeypatch.setattr(lead_control, "branch_lead_control", _control)
    monkeypatch.setattr(stage_utils, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "sales_arm_for", _arm)
    monkeypatch.setattr(seed, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "_branch_stage_names", _names)
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
def test_quit_is_refused_before_the_visit_even_from_an_old_browser(db, sent):
    _boot()
    db["leads"].docs.append(_lead("l1", consultation_stage="Consultation Booked"))
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    with pytest.raises(HTTPException) as refused:
        _run(v3_move_consultation_stage("l1", V3ConsultationStageInput(consultation_stage=sent), DESK))

    assert refused.value.status_code == 409 and "Lost" in refused.value.detail
    assert db["leads"].docs[0]["consultation_stage"] == "Consultation Booked"
    assert db["appointments"].docs[0]["status"] == "new_appointment"


@pytest.mark.parametrize("stage", ["Consultation Visit", "Fee Collected", "Physio Assign"])
@pytest.mark.parametrize("sent", ["Quit", "Cancel"])
def test_quit_is_open_from_the_visit_on_and_frees_what_is_booked(db, stage, sent):
    _boot()
    db["leads"].docs.append(_lead("l1", consultation_stage=stage))
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    moved = _run(v3_move_consultation_stage("l1", V3ConsultationStageInput(consultation_stage=sent), DESK))

    assert moved.consultation_stage == "Quit"
    assert db["appointments"].docs[0]["status"] == "cancelled"


def _lose(lead_id="l1", stage="Lost"):
    return _run(v3_move_branch_stage(lead_id, V3BranchStageInput(branch_stage=stage), DESK))


def test_lost_before_the_visit_leaves_both_consultation_boards_and_locks(db):
    db["leads"].docs.append(_lead("l1", consultation_stage="Consultation Booked", head_consultation_stage="New Appointment"))
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    moved = _lose()

    assert moved.branch_stage == "Lost"
    assert moved.consultation_stage is None and moved.head_consultation_stage is None
    assert db["appointments"].docs[0]["status"] == "cancelled"
    assert any("left 'Consultation Booked'" in r["details"] for r in db["lead_activity"].docs)
    with pytest.raises(HTTPException) as refused:
        _lose(stage="Appointment")
    assert refused.value.status_code == 409


def test_a_lead_with_no_booking_can_still_be_lost(db):
    db["leads"].docs.append(_lead("l1", branch_stage="Follow Up"))

    assert _lose().branch_stage == "Lost"


@pytest.mark.parametrize("stage", ["Consultation Visit", "Fee Collected", "Physio Assign", "Quit"])
def test_lost_is_refused_once_the_patient_has_been_seen(db, stage):
    db["leads"].docs.append(_lead("l1", consultation_stage=stage))

    with pytest.raises(HTTPException) as refused:
        _lose()

    assert refused.value.status_code == 409 and "Quit" in refused.value.detail
    assert db["leads"].docs[0]["branch_stage"] == "Appointment"


def test_a_move_onto_cancelled_lands_on_lost(db):
    db["leads"].docs.append(_lead("l1", consultation_stage="Consultation Booked"))

    moved = _lose(stage="Cancelled")

    assert moved.branch_stage == "Lost" and moved.consultation_stage is None


def test_the_consultation_tabs_lost_reaches_whatever_the_leads_own_pipeline_calls_it(db):
    db["leads"].docs.append(_lead("l1", vertical="online", consultation_stage="Consultation Booked"))

    assert _lose().branch_stage == "Gone"


@pytest.fixture
def both_desks(db, monkeypatch):
    async def _control(_):
        return lead_control.BOTH

    monkeypatch.setattr(lead_control, "branch_lead_control", _control)
    db["pipeline_stages"].docs = [r for r in db["pipeline_stages"].docs if r.get("arm") != "online"]
    return db


def test_a_pre_sales_lost_takes_an_unseen_lead_off_the_consultation_boards(both_desks):
    both_desks["leads"].docs.append(_lead("l1", stage="Lost", consultation_stage="Consultation Booked",
                                          head_consultation_stage="New Appointment"))

    _run(stage_utils.match_desk_stages("l1", "stage", "Priya", "pre_sales"))

    lead = both_desks["leads"].docs[0]
    assert lead["branch_stage"] == "Lost"
    assert lead["consultation_stage"] is None and lead["head_consultation_stage"] is None


def test_a_pre_sales_lost_leaves_a_seen_patients_consultation_as_it_is(both_desks):
    both_desks["leads"].docs.append(_lead("l1", stage="Lost", consultation_stage="Fee Collected",
                                          head_consultation_stage="Consultation Visit"))

    _run(stage_utils.match_desk_stages("l1", "stage", "Priya", "pre_sales"))

    assert both_desks["leads"].docs[0]["consultation_stage"] == "Fee Collected"


def _sweep():
    _run(seed.move_unvisited_cancellations_to_lost())


CALLED_OFF = [
    ("on Cancelled with nothing else", {"branch_stage": "Cancelled"}),
    ("on Cancelled and still booked", {"branch_stage": "Cancelled", "consultation_stage": "Consultation Booked",
                                       "head_consultation_stage": "New Appointment"}),
    ("on Quit, which was Cancel", {"consultation_stage": "Quit", "head_consultation_stage": "New Appointment"}),
    ("on Quit from a pipeline stage", {"branch_stage": "Follow Up", "consultation_stage": "Quit"}),
]


@pytest.mark.parametrize("_,fields", CALLED_OFF, ids=[c[0] for c in CALLED_OFF])
def test_a_lead_called_off_before_its_visit_lands_on_lost(db, _, fields):
    _boot()
    db["leads"].docs.append(_lead("l1", **fields))
    db["appointments"].docs.append({"id": "a1", "lead_id": "l1", "status": "new_appointment"})

    _sweep()

    lead = db["leads"].docs[0]
    assert lead["branch_stage"] == "Lost"
    assert not lead.get("consultation_stage") and not lead.get("head_consultation_stage")
    assert db["appointments"].docs[0]["status"] == "cancelled"
    assert any("called off before the visit" in r["details"] and r["created_by"] == "system" for r in db["lead_activity"].docs)


def test_a_lead_already_lost_comes_off_the_consultation_boards(db):
    _boot()
    db["leads"].docs.append(_lead("l1", branch_stage="Lost", consultation_stage="Consultation Booked"))

    _sweep()

    lead = db["leads"].docs[0]
    assert lead["branch_stage"] == "Lost" and lead["consultation_stage"] is None


def test_a_lead_still_on_the_old_name_lands_on_lost_through_a_whole_boot(db):
    db["leads"].docs.append(_lead("l1", consultation_stage="Cancel"))

    _boot()
    _sweep()

    lead = db["leads"].docs[0]
    assert lead["branch_stage"] == "Lost" and lead["consultation_stage"] is None


STAYS = [
    ("the Consultant's decision", {"consultation_stage": "Quit", "consultation_decision": "consultation_only"}),
    ("closed on the Consultant's board", {"consultation_stage": "Quit", "head_consultation_stage": "Consultation Visit"}),
    ("a Consultation Fee", {"consultation_stage": "Quit", "package_paid": 1500}),
    ("a nought from a full discount", {"consultation_stage": "Quit", "package_paid": 0}),
    ("a diet fee", {"consultation_stage": "Quit", "diet_fee_paid": 800}),
    ("the pipeline past its opening", {"branch_stage": "Cancelled", "consultation_stage": "Fee Collected"}),
    ("a Past Data trial client", {"branch_stage": "Cancelled", "consultation_stage": "Quit", "past_move_id": "m1"}),
    ("a stage that is not a call-off", {"branch_stage": "Follow Up", "consultation_stage": "Consultation Booked"}),
    ("a lead never booked", {"branch_stage": "RNR"}),
]


@pytest.mark.parametrize("_,fields", STAYS, ids=[c[0] for c in STAYS])
def test_nobody_with_anything_to_show_for_a_visit_is_touched(db, _, fields):
    _boot()
    db["leads"].docs.append(_lead("l1", **fields))
    before = dict(db["leads"].docs[0])

    _sweep()

    assert db["leads"].docs[0] == before
    assert db["migrations"].docs[-1]["leads_moved"] == 0


def test_each_arm_takes_its_own_lost(db):
    _boot()
    db["leads"].docs.append(_lead("l1", vertical="online", branch_stage="Cancelled"))

    _sweep()

    assert db["leads"].docs[0]["branch_stage"] == "Gone"


def test_the_marker_keeps_what_each_lead_stood_on_and_it_runs_once(db):
    _boot()
    db["leads"].docs.append(_lead("l1", stage="Appointment", consultation_stage="Quit", head_consultation_stage="New Appointment"))

    _sweep()
    db["leads"].docs.append(_lead("l2", branch_stage="Cancelled"))
    _sweep()

    marker = next(m for m in db["migrations"].docs if m["name"] == "move_unvisited_cancellations_to_lost")
    assert marker["leads_moved"] == 1
    assert marker["moved"] == [{
        "id": "l1", "stage": "Appointment", "branch_stage": "Appointment",
        "consultation_stage": "Quit", "head_consultation_stage": "New Appointment",
    }]
    assert db["leads"].docs[1]["branch_stage"] == "Cancelled"


def test_nothing_runs_and_nothing_is_marked_until_lost_exists(db):
    db["pipeline_stages"].docs = [r for r in db["pipeline_stages"].docs if r.get("role") != "lost"]
    db["leads"].docs.append(_lead("l1", branch_stage="Cancelled"))

    _sweep()

    assert db["leads"].docs[0]["branch_stage"] == "Cancelled"
    assert db["migrations"].docs == []


def test_the_pre_sales_card_follows_on_a_both_branch(both_desks):
    _boot()
    both_desks["leads"].docs.append(_lead("l1", stage="Appointment", branch_stage="Cancelled"))

    _sweep()

    lead = both_desks["leads"].docs[0]
    assert lead["branch_stage"] == "Lost" and lead["stage"] == "Lost"


def test_an_os_data_sheets_cancelled_lands_on_lost():
    names = {"entry": "Leads", "consultation": {"Quit"}, "roles": {"lost": "Lost"}}

    assert past_data_live._os_placement("Cancelled", names)["branch_stage"] == "Lost"


def test_past_data_places_a_dropped_client_on_quit():
    names = {"entry": "Leads", "cancelled": "Cancelled", "consultation": {"Quit"}}

    assert past_data_live.stage_for({"latest_status": "Dropped"}, None) == "Quit"
    assert past_data_live.placement("Quit", names)["consultation_stage"] == "Quit"
    assert past_data_live.placement("Quit", {**names, "consultation": {"Cancel"}})["consultation_stage"] is None
