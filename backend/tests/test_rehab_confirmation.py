"""Existing rehab referrals can be priced before treatment ends, without rebooking."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import routers.v3_head_physio_board as board
class _Col:
    def __init__(self, *docs):
        self.docs = list(docs)

    async def find_one(self, query, projection=None):
        return next((dict(d) for d in self.docs if d["id"] == query["id"]), None)

    async def update_one(self, query, change):
        for doc in self.docs:
            if doc["id"] == query["id"]:
                doc.update(change["$set"])

    async def update_many(self, query, change):
        for doc in self.docs:
            if all(doc.get(key) == value for key, value in query.items()):
                doc.update(change["$set"])

    async def insert_one(self, doc):
        self.docs.append(doc)



@pytest.mark.parametrize("booked", [False, True])
def test_consultant_confirms_rehab_during_treatment(monkeypatch, booked):
    lead = dict(
        id="lead", name="Patient", phone="1234567890", vertical="offline_physiotherapy",
        source_type="manual", stage="Consultation", extra_fields={}, created_at="2026-11-12",
        rehab_after_treatment=True, completed_sessions=0, total_sessions=84,
        consultation_stage="Fee Collected", session_package_price=100800,
    )
    if booked:
        lead["rehab_consult_date"] = "2026-11-13"
    cols = {"leads": _Col(lead), "appointments": _Col(), "lead_activity": _Col()}
    monkeypatch.setattr(board, "v3_col", cols.__getitem__)
    monkeypatch.setattr(board, "ensure_head_chief_lead", AsyncMock())
    monkeypatch.setattr(board, "_rehab_package_fields", AsyncMock(return_value=(
        {"rehab_package_id": "package", "rehab_package_name": "Rehab",
         "rehab_package_price": 5000, "rehab_package_sessions": 12}, " Rehab",
    )))
    user = SimpleNamespace(full_name="Consultant", role="head_physio")
    payload = board.V3RehabConsultCompleteInput(rehab_item_id="package")
    result = asyncio.run(board.hp_complete_rehab_consultation("lead", payload, user))
    updated = result["lead"]
    assert updated["rehab_referred"] is True
    assert updated["rehab_package_price"] == 5000
    assert updated["rehab_consulted_by"] == "Consultant"
    assert updated["consultation_stage"] == "Fee Collected"
    assert updated["session_package_price"] == 100800
    assert cols["appointments"].docs == []
    with pytest.raises(HTTPException, match="already been done"):
        asyncio.run(board.hp_complete_rehab_consultation("lead", payload, user))

