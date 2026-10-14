"""Offline <-> Online swap of a Treatment Package — the money.

Unit tests, like the files beside this one. The figures are the ones agreed with the
branch: a 14-day package, Offline Rs.1200 a day, Online Rs.1900 a day, the first 7 days
collected now and the other 7 on the Payment Schedule. Swapped to Online after day 7, the
due moves from Rs.8,400 to Rs.13,300 and the course costs Rs.21,700.

Nothing here touches a database. See backend/session_mode_swap.py.
"""
import os
import sys

# Same note as the files beside this one: pytest with no __init__.py puts this directory on
# the path rather than the backend root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import session_mode_swap as sw  # noqa: E402


def _lead(**over):
    lead = {"session_package_sessions": 14, "session_package_price": 16800, "session_package_mode": "offline"}
    lead.update(over)
    return lead


# --------------------------------------------------------------- the plan

def test_never_swapped_lead_is_one_run_at_its_own_price():
    assert sw.plan_of(_lead()) == [{"mode": "offline", "days": 14, "rate": 1200.0, "amount": 16800.0}]


def test_lead_with_no_mode_ran_offline():
    assert sw.current_mode(_lead(session_package_mode=None)) == "offline"


def test_swap_to_online_after_day_seven_is_the_agreed_example():
    plan = sw.swapped_plan(sw.plan_of(_lead()), done=7, to_mode="online", to_rate=1900)
    assert plan == [
        {"mode": "offline", "days": 7, "rate": 1200.0, "amount": 8400.0},
        {"mode": "online", "days": 7, "rate": 1900.0, "amount": 13300.0},
    ]
    assert sw.plan_total(plan) == 21700.0


def test_swapping_back_keeps_the_online_days_already_done():
    plan = sw.swapped_plan(sw.plan_of(_lead()), done=7, to_mode="online", to_rate=1900)
    plan = sw.swapped_plan(plan, done=10, to_mode="offline", to_rate=1200)
    assert [(r["mode"], r["days"]) for r in plan] == [("offline", 7), ("online", 3), ("offline", 4)]
    assert sw.plan_total(plan) == 7 * 1200 + 3 * 1900 + 4 * 1200


def test_swap_before_any_day_is_done_reprices_the_whole_course():
    plan = sw.swapped_plan(sw.plan_of(_lead()), done=0, to_mode="online", to_rate=1900)
    assert plan == [{"mode": "online", "days": 14, "rate": 1900.0, "amount": 26600.0}]


def test_the_sold_run_keeps_its_price_to_the_paisa():
    # Rs.10000 over 3 days is not a whole rate; the two days kept are 2/3 of the amount,
    # not a rounded rate multiplied back up.
    lead = _lead(session_package_sessions=3, session_package_price=10000)
    plan = sw.swapped_plan(sw.plan_of(lead), done=2, to_mode="online", to_rate=1900)
    assert plan[0]["amount"] == 6666.67
    assert sw.plan_total(plan) == 6666.67 + 1900


def test_day_ranges():
    plan = sw.swapped_plan(sw.plan_of(_lead()), done=7, to_mode="online", to_rate=1900)
    ranged = sw.with_day_ranges(plan)
    assert [(r["from_day"], r["to_day"]) for r in ranged] == [(1, 7), (8, 14)]


# --------------------------------------------------------------- the schedule

def _short_collection():
    # 7 of 14 days collected now, the other 7 on the schedule.
    return [
        {"amount": 8400, "due_date": "2026-10-01", "paid": True, "sessions": 7},
        {"amount": 8400, "due_date": "2026-10-08", "paid": False, "sessions": 7},
    ]


def test_dearer_swap_raises_the_unpaid_installment():
    out = sw.reschedule(_short_collection(), delta=4900)
    assert out["installments"][1]["amount"] == 13300.0
    assert out["installments"][1]["due_date"] == "2026-10-08"
    assert out["installments"][0] == _short_collection()[0]
    assert out["booked"] == 4900.0 and out["excess"] == 0.0


def test_cheaper_swap_lowers_the_unpaid_installment():
    rows = _short_collection()
    rows[1]["amount"] = 13300
    out = sw.reschedule(rows, delta=-4900)
    assert out["installments"][1]["amount"] == 8400.0
    assert out["booked"] == -4900.0 and out["excess"] == 0.0


def test_paid_in_full_then_dearer_needs_a_due_date():
    out = sw.reschedule([], delta=4900)
    assert out["needs_due_date"] is True


def test_paid_in_full_then_dearer_opens_a_schedule():
    opening = {"amount": 16800, "due_date": "2026-10-01", "paid": True}
    out = sw.reschedule([], delta=4900, due_date="2026-10-20", opening_paid=opening)
    assert out["installments"] == [opening, {"amount": 4900.0, "due_date": "2026-10-20", "paid": False}]


def test_cheaper_than_what_was_paid_leaves_an_excess():
    out = sw.reschedule(_short_collection(), delta=-10000)
    # The Rs.8400 owed goes, the other Rs.1600 was paid over the new bill.
    assert out["installments"] == [_short_collection()[0]]
    assert out["excess"] == 1600.0
    assert out["booked"] == -8400.0


def test_excess_is_used_first_when_the_bill_goes_back_up():
    out = sw.reschedule([_short_collection()[0]], delta=2000, excess=1600, due_date="2026-10-20")
    assert out["excess"] == 0.0
    assert out["installments"][-1] == {"amount": 400.0, "due_date": "2026-10-20", "paid": False}
    assert out["booked"] == 400.0


def test_excess_covers_it_all_and_no_date_is_needed():
    out = sw.reschedule([_short_collection()[0]], delta=1000, excess=1600)
    assert out["needs_due_date"] is False
    assert out["excess"] == 600.0
    assert out["installments"] == [_short_collection()[0]]
