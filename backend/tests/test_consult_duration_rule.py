"""Developer Access > Consultation Duration: on, a booked time blocks the same Consultant's
time; off, several patients can share it. No server or DB — the setting is patched."""
import asyncio

import routers.v3_reviews as reviews
from routers.v3_branch_admin import _consultant_day

DAY = "2026-10-15"
EXPERT = {"slots": [f"{DAY}T10:00"], "slot_details": [{"slot_time": f"{DAY}T10:00", "duration": 60}]}
BALA = {"slot_time": f"{DAY}T10:20", "duration": 10, "lead_id": "bala", "lead_name": "Bala"}


def _free_times(day: dict) -> list:
    return [s["time"] for s in day["free_slots"]]


def test_rule_on_takes_the_booked_time_off_the_day():
    day = _consultant_day(EXPERT, DAY, [BALA], 10)
    assert "10:20" not in _free_times(day)
    assert [b["lead_name"] for b in day["booked_slots"]] == ["Bala"]


def test_rule_off_keeps_every_time_free_and_still_lists_the_bookings():
    mani = {**BALA, "lead_id": "mani", "lead_name": "Mani"}
    day = _consultant_day(EXPERT, DAY, [BALA, mani], 10, blocking=False)
    assert "10:20" in _free_times(day)
    assert len(day["free_slots"]) == 6
    # One row per patient, both at 10:20, in the order they were booked.
    assert [(b["time"], b["lead_name"]) for b in day["booked_slots"]] == [("10:20", "Bala"), ("10:20", "Mani")]


def test_clash_check_is_skipped_while_the_rule_is_off(monkeypatch):
    async def off():
        return False

    monkeypatch.setattr(reviews, "duration_rule_enabled", off)
    assert asyncio.run(reviews.consultant_slot_clash("doc-1", f"{DAY}T10:20", 10)) is None
