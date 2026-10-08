"""Which day a dashboard figure is counted on.

The only tests here that need no server: the date-window helpers are pure, and the two
of them are the whole reason a single row of cards can disagree with itself. Every board
sends a plain calendar day and means the clinic's day; the fields it lands on are stored
on two different clocks (see the comment above the helpers in routers/v3_dashboard.py),
and getting that wrong is what put six sessions on a day that also reported no money and
nobody seen.

Twice before, figures on this row were fixed by a commit that had nothing to check it
against -- see "Stop counting login tokens as booked sessions" and "Fix two wrong figures
on the analytics cards". This is that check.
"""
import os

# The router imports database.py at module scope, which reads these. Motor connects
# lazily, so a URL nothing dials is enough to get at the pure functions below.
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_date_windows")

from datetime import datetime, timezone  # noqa: E402

from utils import CLINIC_UTC_OFFSET, clinic_day_of  # noqa: E402
from routers.v3_dashboard import (  # noqa: E402
    _clinic_day_start_utc,
    _local_date_range_query,
    _named_branch_counts,
    _utc_stamp_range_query,
    _weekday_of,
)

DAY = "2026-09-03"


def stored_stamp(clinic_wall_clock: str) -> str:
    """What now_iso() would have written for something done at that time in the clinic."""
    naive = datetime.fromisoformat(clinic_wall_clock)
    return (naive - CLINIC_UTC_OFFSET).replace(tzinfo=timezone.utc).isoformat()


def in_window(stamp: str, window: dict) -> bool:
    """The comparison Mongo makes on these string bounds."""
    rng = window["created_at"]
    return (stamp >= rng.get("$gte", "")) and ("$lt" not in rng or stamp < rng["$lt"])


# ---------------------------------------------------------------- local-clock fields

def test_local_fields_compare_the_day_as_written():
    """slot_time and appointment_date are stored as the branch typed them."""
    assert _local_date_range_query("slot_time", DAY, DAY) == {
        "slot_time": {"$gte": DAY, "$lte": f"{DAY}T23:59:59"}
    }


def test_local_upper_bound_covers_a_wall_clock_slot_and_a_bare_date():
    rng = _local_date_range_query("slot_time", DAY, DAY)["slot_time"]
    for value in (f"{DAY}T00:00", f"{DAY}T10:00", f"{DAY}T23:30", DAY):
        assert rng["$gte"] <= value <= rng["$lte"], value


# ------------------------------------------------------------------ UTC-stamp fields

def test_clinic_day_opens_at_1830_utc_the_day_before():
    assert _clinic_day_start_utc(DAY) == "2026-09-02T18:30:00"
    assert _clinic_day_start_utc(DAY, plus_days=1) == "2026-09-03T18:30:00"


def test_the_whole_clinic_day_is_counted_and_nothing_either_side():
    """The 00:00-05:30 band is the regression: those hours were being dropped, and the
    same hours of the NEXT morning counted in their place."""
    window = _utc_stamp_range_query("created_at", DAY, DAY)
    inside = ["2026-09-03T00:00:00", "2026-09-03T00:05:00", "2026-09-03T05:29:59",
              "2026-09-03T09:00:00", "2026-09-03T23:59:59"]
    outside = ["2026-09-02T23:59:59", "2026-09-04T00:00:00", "2026-09-04T00:01:00"]
    for wall in inside:
        assert in_window(stored_stamp(wall), window), f"{wall} should count as {DAY}"
    for wall in outside:
        assert not in_window(stored_stamp(wall), window), f"{wall} should not count as {DAY}"


def test_upper_bound_is_half_open_so_the_offset_suffix_cannot_sort_past_it():
    """A "+00:00" suffix makes a stamp sort AFTER an otherwise-equal bound, which is why
    the top of the range names the next midnight instead of reaching for the last second
    of this one."""
    window = _utc_stamp_range_query("created_at", DAY, DAY)
    midnight_tonight = "2026-09-03T18:30:00+00:00"      # 00:00 tomorrow, clinic time
    last_instant_today = "2026-09-03T18:29:59.999999+00:00"
    assert not in_window(midnight_tonight, window)
    assert in_window(last_instant_today, window)


def test_a_multi_day_range_spans_every_day_it_names():
    window = _utc_stamp_range_query("created_at", "2026-09-01", DAY)
    for wall in ("2026-09-01T00:00:00", "2026-09-02T12:00:00", "2026-09-03T23:59:00"):
        assert in_window(stored_stamp(wall), window), wall
    assert not in_window(stored_stamp("2026-08-31T23:59:00"), window)
    assert not in_window(stored_stamp("2026-09-04T00:00:00"), window)


def test_todays_leads_card_counts_the_clinic_day_not_the_utc_one(monkeypatch):
    """The Business Development desk's Today's Leads card. It opened at UTC midnight --
    05:30 IST -- and read 0 at eleven in the morning on a day with new leads."""
    import routers.v3_dashboard as dashboard
    monkeypatch.setattr(dashboard, "clinic_today", lambda: DAY)
    lo, hi = dashboard._clinic_today_window()
    window = {"created_at": {"$gte": lo, "$lt": hi}}
    assert window == _utc_stamp_range_query("created_at", DAY, DAY)
    for wall in ("2026-09-03T00:00:00", "2026-09-03T00:35:00", "2026-09-03T05:29:59", "2026-09-03T23:59:59"):
        assert in_window(stored_stamp(wall), window), f"{wall} is today's lead"
    for wall in ("2026-09-02T23:59:59", "2026-09-04T00:00:00"):
        assert not in_window(stored_stamp(wall), window), f"{wall} is not today's lead"


# ------------------------------------------------------------------- absent / unusable

def test_no_dates_is_no_clause_on_either_clock():
    """What the "All" preset asks for. A missing clause has to widen the query, never
    narrow it -- an empty {} here is every row, which is the point."""
    assert _utc_stamp_range_query("created_at", None, None) == {}
    assert _local_date_range_query("slot_time", None, None) == {}


def test_an_unreadable_date_leaves_that_end_unbounded():
    assert _clinic_day_start_utc("not-a-date") is None
    assert _utc_stamp_range_query("created_at", "not-a-date", None) == {}
    assert _utc_stamp_range_query("created_at", "not-a-date", DAY) == {
        "created_at": {"$lt": "2026-09-03T18:30:00"}
    }


def test_one_open_end_is_still_a_range():
    assert _utc_stamp_range_query("created_at", DAY, None) == {
        "created_at": {"$gte": "2026-09-02T18:30:00"}
    }


# ------------------------------------------------------- bucketing the rows that came back
#
# The window was only ever half of it. Dashboard > Analytics selected leads on the clinic's
# clock and then read each lead's DAY off the first ten characters of the stored UTC stamp,
# which is the same five-and-a-half-hour error one step later: the range opened with a
# spillover day nobody asked for, every day inside it was short its own small hours, and
# "which days run hot" put Sunday's early leads on Saturday.

def test_a_lead_taken_in_the_small_hours_counts_on_the_day_the_desk_worked():
    assert clinic_day_of(stored_stamp("2026-09-03T03:00:00")) == DAY
    assert clinic_day_of(stored_stamp("2026-09-03T00:00:00")) == DAY
    assert clinic_day_of(stored_stamp("2026-09-03T05:29:59")) == DAY


def test_the_clinic_day_ends_at_midnight_not_at_1830_utc():
    assert clinic_day_of(stored_stamp("2026-09-03T23:59:59")) == DAY
    assert clinic_day_of(stored_stamp("2026-09-04T00:00:00")) == "2026-09-04"


def test_every_lead_the_window_admits_buckets_inside_the_window():
    """The property the trend chart rests on: no bar outside the range it was asked for."""
    window = _utc_stamp_range_query("created_at", DAY, DAY)
    for hour in range(24):
        stamp = stored_stamp(f"{DAY}T{hour:02d}:30:00")
        assert in_window(stamp, window)
        assert clinic_day_of(stamp) == DAY, f"{hour}:30 bucketed outside its own window"


def test_the_stamp_forms_the_syncs_actually_write_are_all_read():
    """now_iso() writes "+00:00", Meta exports arrive as "+0000", and older rows are bare."""
    for stamp in ("2026-09-02T21:30:00+00:00", "2026-09-02T21:30:00+0000",
                  "2026-09-02T21:30:00Z", "2026-09-02T21:30:00"):
        assert clinic_day_of(stamp) == DAY, stamp


def test_an_unreadable_stamp_is_left_out_rather_than_guessed():
    for stamp in (None, "", "   ", "not-a-stamp"):
        assert clinic_day_of(stamp) is None


def test_which_days_run_hot_is_asked_of_the_clinics_week():
    """2026-09-03 is a Thursday. A lead taken at 02:00 that morning is stored on
    Wednesday UTC, and belongs on Thursday's bar."""
    assert _weekday_of(stored_stamp("2026-09-03T02:00:00")) == "Thu"
    assert _weekday_of(stored_stamp("2026-09-03T14:00:00")) == "Thu"
    assert _weekday_of(stored_stamp("2026-09-03T23:30:00")) == "Thu"
    assert _weekday_of("nonsense") is None


# ------------------------------------------------------------------ leads by branch add up

def test_branches_sharing_a_name_are_summed_not_overwritten():
    """Leads by branch is keyed by name for display. Written as a dict comprehension the
    second id to land on a name replaced the first instead of adding to it, so the chart
    stopped summing to the total printed above it."""
    counts = _named_branch_counts({"b1": 7, "b2": 4}, {"b1": "Anna Nagar", "b2": "Anna Nagar"})
    assert counts == {"Anna Nagar": 11}


def test_no_branch_and_a_deleted_branch_share_the_unassigned_row():
    """The common case: one lead never given a branch, two whose branches are gone. All
    three read "Unassigned", and all three have to be counted there."""
    counts = _named_branch_counts({"": 5, "gone-1": 3, "gone-2": 2, "b1": 7}, {"b1": "Anna Nagar"})
    assert counts == {"Unassigned": 10, "Anna Nagar": 7}


def test_branch_rows_still_add_up_to_the_total_they_came_from():
    by_branch_id = {"": 12, "b1": 40, "b2": 31, "stale": 6}
    counts = _named_branch_counts(by_branch_id, {"b1": "ECR", "b2": "T Nagar"})
    assert sum(counts.values()) == sum(by_branch_id.values())
