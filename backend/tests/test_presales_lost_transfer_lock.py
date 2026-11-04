"""Pre Sales' Lost shuts Branch Transfer: the dialogs are told so before the form, the move
itself is refused, and the Edit form cannot change the branch instead. No server or DB --
the collections are in memory."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routers.v3_branch_admin as branch_admin
import routers.v3_leads as leads_router
import stage_utils
from routers.v3_branch_admin import V3BranchTransferInput, v3_transfer_branch, v3_transfer_eligibility
from routers.v3_leads import v3_edit_lead
from schemas.v3 import V3LeadUpdate

DESK = SimpleNamespace(full_name="Priya", role="pre_sales", branch_id=None)


class _Col:
    def __init__(self, *docs):
        self.docs = [dict(d) for d in docs]

    def _hits(self, query):
        return [d for d in self.docs if all(d.get(k) == v for k, v in query.items())]

    async def find_one(self, query, _=None):
        return next((dict(d) for d in self._hits(query)), None)

    async def count_documents(self, _):
        return 0

    async def update_one(self, query, change):
        hits = self._hits(query)[:1]
        for hit in hits:
            hit.update(change.get("$set", {}))
        return SimpleNamespace(matched_count=len(hits))


def _lead(stage):
    return {
        "id": "l1", "name": "Meena", "phone": "9994900000", "stage": stage, "branch_id": "anna",
        "branch_stage": "New Appointment", "created_at": "2026-11-01T10:00:00+00:00",
        "vertical": "offline_physiotherapy", "source_type": "manual", "extra_fields": {},
    }


@pytest.fixture
def db(monkeypatch):
    cols = {
        "leads": _Col(),
        "branches": _Col({"id": "anna", "branch_name": "Anna Nagar"}, {"id": "tnagar", "branch_name": "T Nagar"}),
        "sessions": _Col(),
        "appointments": _Col(),
        "pipeline_stages": _Col({"type": "sales", "role": "lost", "name": "Lost", "id": "s1"}),
    }
    get = lambda name: cols[name]  # noqa: E731
    monkeypatch.setattr(stage_utils, "v3_col", get)
    monkeypatch.setattr(branch_admin, "v3_col", get)
    monkeypatch.setattr(leads_router, "v3_col", get)

    async def _nothing(*_, **__):
        return None

    async def _no_payments(_):
        return []

    async def _opening(*_):
        return "New Appointment"

    monkeypatch.setattr(branch_admin, "lead_payment_history", _no_payments)
    monkeypatch.setattr(leads_router, "log_stage_moves", _nothing)
    monkeypatch.setattr(leads_router, "match_desk_stages", _nothing)
    monkeypatch.setattr(leads_router, "first_branch_stage_for_branch", _opening)
    return cols


def _run(coro):
    return asyncio.run(coro)


def test_eligibility_blocks_a_lost_lead_before_the_form(db):
    db["leads"].docs = [_lead("Lost")]
    out = _run(v3_transfer_eligibility("l1", user=DESK))
    assert out["can_transfer"] is False
    assert "Lost" in out["blocked_reason"]


def test_eligibility_leaves_every_other_stage_open(db):
    for stage in ("New Leads", "RNR", "Follow Up", "Pre Book", "Appointment", "Not a prospect"):
        db["leads"].docs = [_lead(stage)]
        out = _run(v3_transfer_eligibility("l1", user=DESK))
        assert out["can_transfer"] is True, stage


def test_a_lost_lead_cannot_be_transferred_and_stays_where_it_is(db):
    db["leads"].docs = [_lead("Lost")]
    with pytest.raises(HTTPException) as refused:
        _run(v3_transfer_branch("l1", V3BranchTransferInput(to_branch_id="tnagar", reason="Nearer home"), user=DESK))
    assert refused.value.status_code == 400
    assert "Lost" in refused.value.detail
    assert db["leads"].docs[0] == _lead("Lost")


def test_the_edit_form_cannot_change_a_lost_leads_branch(db):
    db["leads"].docs = [_lead("Lost")]
    with pytest.raises(HTTPException) as refused:
        _run(v3_edit_lead("l1", V3LeadUpdate(branch_id="tnagar"), user=DESK))
    assert refused.value.status_code == 409
    assert db["leads"].docs[0] == _lead("Lost")


def test_the_edit_form_still_saves_a_lost_lead_that_resends_its_own_branch(db):
    db["leads"].docs = [_lead("Lost")]
    _run(v3_edit_lead("l1", V3LeadUpdate(name="Meenakshi", branch_id="anna"), user=DESK))
    assert db["leads"].docs[0]["name"] == "Meenakshi"
    assert db["leads"].docs[0]["branch_id"] == "anna"


def test_the_edit_form_still_changes_the_branch_of_a_live_lead(db):
    db["leads"].docs = [_lead("Follow Up")]
    _run(v3_edit_lead("l1", V3LeadUpdate(branch_id="tnagar"), user=DESK))
    assert db["leads"].docs[0]["branch_id"] == "tnagar"
