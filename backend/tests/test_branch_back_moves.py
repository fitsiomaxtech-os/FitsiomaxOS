"""Branch Leads' moves back: Follow Up, Not a prospect and Pre Book to RNR, Appointment to RNR
and Follow Up. A booked lead sent back gives its booking up, a seen patient cannot go, and a
lead with no booking keeps what it has. No server or DB -- the collections are in memory."""
import pytest
from fastapi import HTTPException

import lead_control
import routers.v3_branch_admin as branch_admin
import stage_utils
from routers.v3_branch_admin import (
    V3BranchAppointmentInput, V3BranchFollowUpInput, V3BranchFollowUpRescheduleInput,
    v3_move_branch_stage, v3_reschedule_branch_follow_up, v3_schedule_branch_appointment,
    v3_schedule_branch_follow_up,
)
from schemas.v3 import V3BranchStageInput
from test_branch_lost_stage import DESK, _Col, _pipeline, _run

BOOKED = "Consultation Booked"
HEAD_BOOKED = "New Appointment"


class _Leads(_Col):
    async def find_one(self, query, _=None, sort=None):
        return await super().find_one(query, _)

    def _write(self, hits, change):
        for hit in hits:
            for key, item in change.get("$push", {}).items():
                hit.setdefault(key, []).append(item)
        return super()._write(hits, change)


@pytest.fixture
def db(monkeypatch):
    cols = {
        "leads": _Leads(),
        "appointments": _Leads(),
        "pipeline_stages": _Leads(*_pipeline(), {"id": "c0", "name": BOOKED, "type": "consultation", "order": 0}),
        "lead_activity": _Leads(),
        "branches": _Leads({"id": "che", "lead_control": "both"}),
        "doctors": _Leads({"id": "dr2", "full_name": "Dr Ravi"}),
    }
    get = lambda name: cols[name]  # noqa: E731
    monkeypatch.setattr(stage_utils, "v3_col", get)
    monkeypatch.setattr(branch_admin, "v3_col", get)

    async def _control(_):
        return lead_control.BOTH

    async def _arm(**_):
        return "offline"

    async def _names(*_):
        return [r["name"] for r in cols["pipeline_stages"].docs if r.get("arm") == "offline"]

    async def _no_clash(*_, **__):
        return None

    async def _first_stage():
        return [BOOKED]

    async def _first_head_stage():
        return [HEAD_BOOKED]

    monkeypatch.setattr(lead_control, "branch_lead_control", _control)
    monkeypatch.setattr(stage_utils, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "sales_arm_for", _arm)
    monkeypatch.setattr(branch_admin, "_branch_stage_names", _names)
    monkeypatch.setattr(branch_admin, "consultant_slot_clash", _no_clash)
    monkeypatch.setattr(branch_admin, "_consultation_stage_names", _first_stage)
    monkeypatch.setattr(branch_admin, "_head_consultation_stage_names", _first_head_stage)
    return cols


def _add_lead(db, branch_stage, **extra):
    db["leads"].docs.append({
        "id": "l1", "name": "Asha", "phone": "9840000000", "vertical": "offline_physiotherapy",
        "source_type": "manual", "extra_fields": {}, "created_at": "2026-11-04T10:00:00",
        "branch_id": "che", "stage": branch_stage, "branch_stage": branch_stage, **extra,
    })


def _add_booked_lead(db, branch_stage="Appointment", consultation_stage=BOOKED, **extra):
    _add_lead(
        db, branch_stage,
        appointment_date="2026-11-06", appointment_time="10:30", appointment_datetime="2026-11-06T10:30:00",
        assigned_physio_id="dr1", assigned_physio_name="Dr Meena", physio_assigned_at="2026-11-04T10:00:00",
        consultation_stage=consultation_stage, head_consultation_stage=HEAD_BOOKED, **extra,
    )
    db["appointments"].docs.append({
        "id": "a1", "lead_id": "l1", "status": "new_appointment", "appt_kind": "consultation",
        "slot_time": "2026-11-06T10:30",
    })


def _to(stage):
    return V3BranchStageInput(branch_stage=stage)


def _assert_booking_gone(db, lead):
    assert db["appointments"].docs[0]["status"] == "cancelled"
    assert lead.consultation_stage is None
    assert lead.head_consultation_stage is None
    assert lead.appointment_date is None
    assert lead.appointment_time is None
    assert lead.assigned_physio_id is None
    assert lead.assigned_physio_name is None


def _trail(db):
    return " | ".join(a["details"] for a in db["lead_activity"].docs)


@pytest.mark.parametrize("start", ["Follow Up", "Not a prospect", "Pre Book"])
def test_each_stage_goes_back_to_rnr_with_no_booking_to_undo(db, start):
    _add_lead(db, start)

    moved = _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    assert moved.branch_stage == "RNR"
    # The Pre Sales card follows, on this Lead Control Both branch.
    assert moved.stage == "RNR"


def test_appointment_back_to_rnr_gives_the_booking_up(db):
    _add_booked_lead(db)

    moved = _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    assert moved.branch_stage == "RNR"
    assert moved.stage == "RNR"
    _assert_booking_gone(db, moved)
    assert "1 appointment cancelled, slot freed" in _trail(db)
    assert f"left '{BOOKED}'" in _trail(db)


def test_appointment_back_to_follow_up_gives_the_booking_up(db):
    _add_booked_lead(db)

    moved = _run(v3_schedule_branch_follow_up("l1", V3BranchFollowUpInput(date="2026-11-07", time="11:00"), DESK))

    assert moved.branch_stage == "Follow Up"
    assert moved.stage == "Follow Up"
    assert moved.next_follow_up_at == "2026-11-07T11:00:00"
    assert len(moved.follow_ups) == 1
    _assert_booking_gone(db, moved)
    assert "1 appointment cancelled, slot freed" in _trail(db)


def test_rescheduling_a_follow_up_on_a_booked_lead_gives_the_booking_up(db):
    _add_booked_lead(db, follow_ups=[{"id": "f1", "date": "2026-11-05", "time": "09:00", "status": "active"}])

    moved = _run(v3_reschedule_branch_follow_up(
        "l1", "f1", V3BranchFollowUpRescheduleInput(date="2026-11-07", time="11:00"), DESK,
    ))

    assert moved.branch_stage == "Follow Up"
    _assert_booking_gone(db, moved)
    assert "1 appointment cancelled, slot freed" in _trail(db)


@pytest.mark.parametrize("start", ["Not a prospect", "Pre Book"])
def test_a_slot_carried_on_from_appointment_goes_back_with_the_lead(db, start):
    # Appointment's move onto either keeps the booking, so the lead can still be holding it.
    _add_booked_lead(db, branch_stage=start, pre_book={"date": "2026-12-01", "advance": 500})

    moved = _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    assert moved.branch_stage == "RNR"
    _assert_booking_gone(db, moved)
    # What was paid ahead is not a booking.
    assert moved.pre_book["advance"] == 500


def test_a_seen_patient_cannot_go_back_to_rnr(db):
    _add_booked_lead(db, consultation_stage="Consultation Visit")

    with pytest.raises(HTTPException) as refused:
        _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    assert refused.value.status_code == 409
    lead = db["leads"].docs[0]
    assert lead["branch_stage"] == "Appointment"
    assert lead["consultation_stage"] == "Consultation Visit"
    assert db["appointments"].docs[0]["status"] == "new_appointment"


def test_a_follow_up_on_a_seen_patient_keeps_their_record(db):
    # The Follow-Up tab books the call for a patient past their visit as well.
    _add_booked_lead(db, consultation_stage="Fee Collected")

    moved = _run(v3_schedule_branch_follow_up("l1", V3BranchFollowUpInput(date="2026-11-07", time="11:00"), DESK))

    assert moved.consultation_stage == "Fee Collected"
    assert moved.head_consultation_stage == HEAD_BOOKED
    assert moved.appointment_date == "2026-11-06"
    assert moved.assigned_physio_name == "Dr Meena"
    assert db["appointments"].docs[0]["status"] == "new_appointment"
    assert "slot freed" not in _trail(db)


def test_a_lead_with_no_booking_keeps_the_time_pre_sales_asked_for(db):
    _add_lead(db, "Follow Up", appointment_date="2026-11-06", appointment_time="10:30")

    moved = _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    assert moved.branch_stage == "RNR"
    assert moved.appointment_date == "2026-11-06"
    assert moved.appointment_time == "10:30"
    assert "cancelled" not in _trail(db)


def test_a_lead_sent_back_books_again_as_a_first_booking(db):
    _add_booked_lead(db)
    _run(v3_move_branch_stage("l1", _to("RNR"), DESK))

    booked = _run(v3_schedule_branch_appointment("l1", V3BranchAppointmentInput(
        appointment_date="2026-11-09", appointment_time="12:00", physio_id="dr2", duration=30,
    ), DESK))

    assert booked.branch_stage == "Appointment"
    assert booked.stage == "Appointment"
    assert booked.consultation_stage == BOOKED
    assert booked.head_consultation_stage == HEAD_BOOKED
    assert booked.assigned_physio_name == "Dr Ravi"
    # A new slot, not a move of the old one: nothing is held open, and it is no reschedule.
    assert not booked.appointment_rescheduled
    held = [a for a in db["appointments"].docs if a["status"] == "new_appointment"]
    assert [a["slot_time"] for a in held] == ["2026-11-09T12:00"]
