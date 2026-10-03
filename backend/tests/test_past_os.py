"""The OS Data workbook reader (past_os.py): Leads, Physio, Sessions, Reviews and Payments,
read in one go and tied together by Patient ID.

Synthetic people only -- no row of a real sheet goes into a file.
"""
from datetime import datetime, time as dt_time

import pytest

import past_data
from past_data import PastDataError, read_workbook
from past_os import COLUMNS, build, clock, moment


def lead(n, pid, name, phone, stage="Physio Assign", **extra):
    record = {"excel_id": pid, "name": name, "phone": phone, "current_stage": stage,
              "lead_at": datetime(2026, 9, 1, 10, 0), "_row": n}
    record.update(extra)
    return record


def child(n, pid, name="", **extra):
    record = {"client_excel_id": pid, "name": name, "_row": n}
    record.update(extra)
    return record


def codes(data):
    return sorted({f.code for f in data.findings})


def by_id(data):
    return {c["excel_id"]: c for c in data.clients}


def test_one_upload_holds_leads_sessions_and_revenue():
    data = build({
        "Leads": [lead(3, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(3, "FM-1", course="Treatment", package="12 Pack", sessions=12, amount=12000,
                         start_date=datetime(2026, 9, 6))],
        "Sessions": [child(3, "FM-1", course="Treatment", at=datetime(2026, 9, 7, 18, 0), status="Completed"),
                     child(4, "FM-1", course="Treatment", at=datetime(2026, 9, 9, 18, 0), status="upcoming")],
        "Reviews": [child(3, "FM-1", at=datetime(2026, 9, 20, 11, 0), status="Completed")],
        "Payments": [child(3, "FM-1", payment_for="Treatment Fee", status="Paid", amount=6000,
                           paid_date=datetime(2026, 9, 6), mode="Cash")],
    })
    assert data.layout == "os"
    assert data.types == ["lead", "sessions", "revenue"]
    client = data.clients[0]
    assert (client["sessions_completed"], client["sessions_upcoming"], client["reviews_count"]) == (1, 1, 1)
    course = data.treatments[0]
    assert course["service"] == "Treatment · 12 Pack" and course["recommended_sessions"] == 12 and course["fee"] == 12000
    assert (course["sessions_completed"], course["sessions_upcoming"]) == (1, 1)
    assert data.payments[0]["treatment_id"] == course["id"] and client["paid_total"] == 6000
    assert client["latest_status"] == "Physio Assign"
    summary = past_data.summary(data)
    assert (summary["sessions"], summary["reviews"], summary["types"]) == (2, 1, ["lead", "sessions", "revenue"])


def test_leads_alone_is_one_type():
    data = build({"Leads": [lead(2, "FM-1", "Test Arun", "9000000001")]})
    assert data.types == ["lead"]


def test_pending_is_owed_and_a_blank_status_is_neither():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Payments": [
            child(2, "FM-1", payment_for="Treatment Fee", status="Pending", amount=6000, due_date=datetime(2026, 10, 6)),
            child(3, "FM-1", payment_for="Treatment Fee", status=None, amount=500),
            child(4, "FM-1", payment_for="Treatment Fee", status="Paid", amount=1000, paid_date=datetime(2026, 9, 1), mode="UPI"),
        ],
    })
    pending, blank, paid = data.payments
    assert (pending["state"], pending["outstanding"], pending["amount_paid"]) == ("unpaid", 6000, None)
    assert (blank["state"], blank["outstanding"], blank["flags"]) == ("unknown", 0, ["no_status"])
    assert (paid["state"], paid["amount_paid"], paid["mode"]) == ("paid", 1000, "upi")
    client = data.clients[0]
    assert (client["paid_total"], client["outstanding_total"]) == (1000, 6000)


def test_consultation_fees_go_under_a_consultation_course():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001", consultation_visit_date=datetime(2026, 9, 5))],
        "Payments": [child(2, "FM-1", payment_for="Consultation Fee", status="Paid", amount=500,
                           paid_date=datetime(2026, 9, 5), mode="Cash")],
    })
    course = data.treatments[0]
    assert (course["service"], course["start_date"]) == ("Consultation", "2026-09-05")
    assert data.payments[0]["treatment_id"] == course["id"]
    assert "payment_no_course" not in codes(data)


def test_a_renewal_takes_the_sessions_and_payments_after_it():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(2, "FM-1", course="Treatment", package="First", start_date=datetime(2026, 9, 1)),
                   child(3, "FM-1", course="Treatment", package="Renewal", start_date=datetime(2026, 10, 1))],
        "Sessions": [child(2, "FM-1", course="Treatment", at=datetime(2026, 9, 10, 10, 0), status="Completed"),
                     child(3, "FM-1", course="Treatment", at=datetime(2026, 10, 3, 10, 0), status="Completed")],
        "Payments": [child(2, "FM-1", payment_for="Treatment Fee", status="Paid", amount=1, paid_date=datetime(2026, 10, 1), mode="Cash")],
    })
    first, renewal = data.treatments
    assert (first["sessions_completed"], renewal["sessions_completed"]) == (1, 1)
    assert data.payments[0]["treatment_id"] == renewal["id"]


def test_a_rehab_session_does_not_count_on_a_treatment_course():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(2, "FM-1", course="Treatment", start_date=datetime(2026, 9, 1))],
        "Sessions": [child(2, "FM-1", course="Rehab", at=datetime(2026, 9, 10, 10, 0), status="Completed")],
    })
    assert data.treatments[0]["sessions_completed"] == 0
    assert "session_no_course" in codes(data) and data.clients[0]["sessions_completed"] == 1


def test_a_row_without_patient_id_is_matched_by_phone_and_name():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001"), lead(3, None, "Test Indu", "9000000009")],
        "Payments": [{"client_excel_id": None, "phone": 9000000009, "name": "Test Indu", "payment_for": "Treatment Fee",
                      "status": "Paid", "amount": 3000, "paid_date": datetime(2026, 9, 15), "mode": "Bank Transfer", "_row": 2}],
    })
    client = data.clients[1]
    # The other rows have IDs, so this one's missing ID is a slip, and said so.
    assert client["excel_id"] == "Leads · row 3" and "no_patient_id" in client["flags"]
    assert data.payments[0]["client_id"] == client["id"] and data.payments[0]["mode"] == "account_transfer"
    assert "payment_no_course" in codes(data)


def phone_child(n, phone, name="", **extra):
    record = {"phone": phone, "name": name, "_row": n}
    record.update(extra)
    return record


def test_a_sheet_without_patient_ids_ties_its_tabs_by_phone():
    data = build({
        "Leads": [lead(2, None, "Test Bala", "88255 87322"), lead(3, None, "Test Anbu", "9344123286"),
                  lead(4, None, "Sample Priya", "9000000000")],
        "Physio": [phone_child(2, "8825587322", course="Treatment", physio="Test Salma", start_date=datetime(2026, 9, 20)),
                   phone_child(3, 9344123286.0, course="Treatment", start_date=datetime(2026, 10, 6))],
        "Sessions": [phone_child(2, "+91 8825587322", completed_dates="21, 22-09-2026"),
                     phone_child(3, "9344123286", upcoming_dates="13-10-2026"),
                     phone_child(4, "9000000000", completed_dates="1-10-2026")],
        "Payments": [phone_child(2, "8825587322", consultation_fee=1500, consultation_date=datetime(2026, 9, 18),
                                 consultation_mode="Cash")],
    })
    # No Patient ID anywhere is the sheet's layout, not a slip; the sample row's children are
    # passed over like the sample row itself.
    assert codes(data) == ["sample_row"]
    bala, anbu = data.clients
    assert "no_patient_id" not in bala["flags"] + anbu["flags"]
    assert (bala["sessions_completed"], anbu["sessions_upcoming"]) == (2, 1)
    assert data.payments[0]["client_id"] == bala["id"] and bala["paid_total"] == 1500


def test_leads_keep_the_patient_id_and_the_other_tabs_go_by_phone():
    data = build({
        "Leads": [lead(2, "PAR-1", "Test Bala", "8825587322"), lead(3, "PAR-2", "Test Anbu", "9344123286")],
        "Physio": [phone_child(2, "8825587322", course="Treatment", start_date=datetime(2026, 9, 20))],
        "Sessions": [phone_child(2, "8825587322", completed_dates="21, 22-09-2026")],
        "Reviews": [phone_child(2, "8825587322"), phone_child(3, "9344123286")],
        "Payments": [phone_child(2, "9344123286", consultation_fee=1500, consultation_date=datetime(2026, 9, 18),
                                 consultation_mode="Cash")],
    })
    # A review with nothing but the phone is a review; its blank Status is not reported.
    assert codes(data) == []
    bala, anbu = data.clients
    assert (bala["excel_id"], bala["sessions_completed"], bala["reviews_count"]) == ("PAR-1", 2, 1)
    assert (anbu["reviews_count"], anbu["paid_total"]) == (1, 1500)


def test_a_family_on_one_phone_needs_the_name_on_the_other_tabs():
    data = build({
        "Leads": [lead(2, None, "Test Mala", "9000000005"), lead(3, None, "Test Ravi", "9000000005")],
        "Sessions": [phone_child(2, "9000000005", completed_dates="21-09-2026"),
                     phone_child(3, "9000000005", "Test Ravi", completed_dates="22-09-2026")],
    })
    mala, ravi = data.clients
    assert mala["sessions"] == [] and [s["at"] for s in ravi["sessions"]] == ["2026-09-22"]
    assert [f.detail for f in data.findings if f.code == "no_client"] == [
        "(no name): 9000000005 -- more than one client matches"]


def test_a_row_naming_nobody_is_left_out():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Payments": [child(2, "FM-9", payment_for="Treatment Fee", status="Paid", amount=100)],
        "Sessions": [{"client_excel_id": None, "phone": "9000000077", "name": "Nobody", "_row": 2, "status": "Completed"}],
    })
    assert data.payments == [] and data.clients[0]["sessions"] == []
    assert [f.code for f in data.findings].count("no_client") == 2
    assert "no_client" in past_data.NOT_IMPORTED


def test_the_template_sample_row_is_never_imported():
    data = build({
        "Leads": [lead(2, "FM-0001", "Sample Priya", "9000000001"), lead(3, "FM-2", "Test Bala", "9000000002")],
        "Payments": [child(2, "FM-0001", "Sample Priya", payment_for="Treatment Fee", status="Paid", amount=3000)],
        "Physio": [child(2, "FM-0001", "Sample Priya", course="Treatment")],
    })
    assert [c["name"] for c in data.clients] == ["Test Bala"]
    assert data.payments == [] and data.treatments == []
    assert "sample_row" in codes(data)


def test_only_the_sample_row_is_refused():
    with pytest.raises(PastDataError, match="sample row"):
        build({"Leads": [lead(2, "FM-0001", "Sample Priya", "9000000001")]})


def test_a_child_sample_row_is_skipped_even_when_its_id_is_reused():
    data = build({
        "Leads": [lead(2, "FM-0001", "Test Real", "9000000001")],
        "Payments": [child(2, "FM-0001", "Sample Priya", payment_for="Treatment Fee", status="Paid", amount=3000)],
    })
    assert data.payments == []


@pytest.mark.parametrize("written,stage,flagged", [
    ("Physio Assign", "Physio Assign", False),
    ("consultation booked", "Consultation Booked", False),
    ("NOT A PROSPECT", "Not a prospect", False),
    ("Cancelled", "Cancelled", False),
    ("Cancel", "Cancel", False),
    ("Consulted", "Leads", True),
    (None, "Leads", True),
])
def test_current_stage(written, stage, flagged):
    data = build({"Leads": [lead(2, "FM-1", "Test Arun", "9000000001", stage=written)]})
    client = data.clients[0]
    assert client["current_stage"] == stage and client["latest_status"] == stage
    assert ("unknown_stage" in client["flags"]) is flagged


def test_lead_fields_are_kept_for_the_lead():
    data = build({"Leads": [lead(
        2, "FM-1", "Test Arun", "9000000001", gender="male", department="Online Fitness", age=41.0,
        months_of_pain=6.0, alternative_phone=9000000099.0, city="Chennai", condition="Knee",
        appointment_at=datetime(2026, 9, 4, 11, 30), branch="Anna Nagar",
    )]})
    client = data.clients[0]
    assert (client["gender"], client["department"], client["age"], client["months_of_pain"]) == ("Male", "online_fitness", 41, 6)
    assert (client["alternative_phone"], client["city"], client["condition"]) == ("9000000099", "Chennai", "Knee")
    assert client["journey"]["appointment_at"] == "2026-09-04 11:30"
    assert data.branches == {"Anna Nagar": 1}


def test_duplicate_ids_and_shared_phones():
    data = build({"Leads": [
        lead(2, "FM-1", "Test Arun", "9000000001"),
        lead(3, "FM-1", "Test Arun Again", "9000000001"),
        lead(4, "FM-2", "Test Jaya", "9000000001"),
    ]})
    assert [c["excel_id"] for c in data.clients] == ["FM-1", "FM-2"]
    assert {"duplicate_id", "shared_phone"} <= set(codes(data))


def test_values_off_the_template_lists_are_reported():
    """What the Dummy OG Sheet held: a course by another name, statuses the lists do not have,
    and a payment with no Payment For. Each is said out loud rather than passed over."""
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(2, "FM-1", course="Physio 1-on-1", package="2w", sessions=14, amount=8400)],
        "Sessions": [child(2, "FM-1", course="treatment", at=datetime(2026, 9, 7), status="Active")],
        "Reviews": [child(2, "FM-1", at=datetime(2026, 9, 20), status="Complete")],
        "Payments": [child(2, "FM-1", payment_for="-", status="Active or Paid", amount=8400)],
    })
    assert {"unknown_course", "unknown_session_status", "unknown_review_status", "unknown_payment_for",
            "no_status"} <= set(codes(data))
    course = data.treatments[0]
    # Read as Treatment, so the session (course "treatment") finds it.
    assert course["course"] == "Treatment" and course["service"] == "Treatment · 2w"
    assert "session_no_course" not in codes(data)
    client = data.clients[0]
    assert client["sessions"][0]["status"] == "Active" and client["reviews"][0]["status"] == "Complete"
    assert client["paid_total"] == 0 and data.payments[0]["state"] == "unknown"


def test_template_values_raise_nothing():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(2, "FM-1", course="Rehab", package="Knee Rehab", sessions=10, amount=9000)],
        "Sessions": [child(2, "FM-1", course="Rehab", at=datetime(2026, 9, 7), status="Upcoming")],
        "Reviews": [child(2, "FM-1", at=datetime(2026, 9, 20), status="Pending")],
        "Payments": [child(2, "FM-1", payment_for="Treatment Fee", status="Paid", amount=9000, paid_date=datetime(2026, 9, 6)),
                     child(3, "FM-1", payment_for="Consultation Fee", status="Pending", amount=500)],
    })
    assert not {"unknown_course", "unknown_session_status", "unknown_review_status", "unknown_payment_for"} & set(codes(data))


def test_one_row_per_client_lists_its_session_dates():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Physio": [child(2, "FM-1", course="Treatment", sessions=11, start_date=datetime(2026, 9, 20))],
        "Sessions": [child(2, "FM-1", course="Treatment", physio="Test Salma", time=dt_time(10, 0),
                           completed_dates="21-09-2026, 22-09-2026;\n23/09/2026",
                           upcoming_dates="07-10-2026 18:30, 08-10-2026")],
    })
    assert codes(data) == []
    client = data.clients[0]
    assert [(s["at"], s["status"]) for s in client["sessions"]] == [
        ("2026-09-21 10:00", "Completed"), ("2026-09-22 10:00", "Completed"), ("2026-09-23 10:00", "Completed"),
        # A date written with its own time keeps it.
        ("2026-10-07 18:30", "Upcoming"), ("2026-10-08 10:00", "Upcoming"),
    ]
    assert {s["physio"] for s in client["sessions"]} == {"Test Salma"}
    assert (client["sessions_completed"], client["sessions_upcoming"]) == (3, 2)
    course = data.treatments[0]
    assert (course["sessions_completed"], course["sessions_upcoming"]) == (3, 2)
    assert {s["treatment_excel_id"] for s in client["sessions"]} == {course["excel_id"]}
    assert past_data.summary(data)["sessions"] == 5 and data.tab_rows["Sessions"] == 1


def test_days_alone_take_the_month_of_the_full_date_after_them():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Bala", "9000000001")],
        "Physio": [child(2, "FM-1", course="Treatment", start_date=datetime(2026, 9, 20))],
        "Sessions": [child(2, "FM-1", course="Treatment", time="10:00",
                           completed_dates="21, 22, 29-09-2026, 1, 2 - 10 - 2026",
                           upcoming_dates="5, 6 18:30, 7, 8-10-2026 9:00, 9")],
    })
    sessions = data.clients[0]["sessions"]
    assert [(s["at"], s["status"]) for s in sessions] == [
        ("2026-09-21 10:00", "Completed"), ("2026-09-22 10:00", "Completed"), ("2026-09-29 10:00", "Completed"),
        ("2026-10-01 10:00", "Completed"), ("2026-10-02 10:00", "Completed"),
        ("2026-10-05 10:00", "Upcoming"), ("2026-10-07 10:00", "Upcoming"), ("2026-10-08 09:00", "Upcoming"),
    ]
    # "6 18:30" is not a day alone, and 9 has no full date after it: both reported, never guessed.
    assert [f.detail for f in data.findings if f.code == "bad_session_date"] == [
        "Test Bala: '6 18:30'", "Test Bala: '9 (no month and year after it)'"]


def test_a_date_written_twice_is_read_once():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Bala", "9000000001")],
        "Sessions": [child(2, "FM-1", course="Treatment", completed_dates="2, 4, 6, 8, 6 - 10 - 2026",
                           upcoming_dates="8-10-2026")],
    })
    assert [(s["at"], s["status"]) for s in data.clients[0]["sessions"]] == [
        ("2026-10-02", "Completed"), ("2026-10-04", "Completed"), ("2026-10-06", "Completed"), ("2026-10-08", "Completed")]
    assert [f.detail for f in data.findings if f.code == "repeated_session_date"] == [
        "Test Bala: 2026-10-06", "Test Bala: 2026-10-08"]


def test_a_day_the_month_does_not_have_is_reported():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Bala", "9000000001")],
        "Sessions": [child(2, "FM-1", course="Treatment", completed_dates="30, 31, 1-09-2026")],
    })
    assert [s["at"] for s in data.clients[0]["sessions"]] == ["2026-09-01", "2026-09-30"]
    assert "Test Bala: '31-09-2026'" in [f.detail for f in data.findings]


def test_a_single_date_cell_and_no_session_time():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Sessions": [child(2, "FM-1", course="Rehab", completed_dates=datetime(2026, 9, 21))],
    })
    assert [(s["at"], s["status"]) for s in data.clients[0]["sessions"]] == [("2026-09-21", "Completed")]


def test_unreadable_session_dates_and_times_are_reported():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001"), lead(3, "FM-2", "Test Bala", "9000000002")],
        "Physio": [child(2, "FM-1", course="Treatment"), child(3, "FM-2", course="Treatment")],
        "Sessions": [child(2, "FM-1", course="Treatment", time="morning",
                           completed_dates="21-09-2026, 31-09-2026, 22-09"),
                     child(3, "FM-2", course="Treatment", physio="Test Salma")],
    })
    assert [f.code for f in data.findings].count("bad_session_date") == 2
    assert "bad_session_time" in codes(data) and "no_session_dates" in codes(data)
    arun, bala = data.clients
    assert [s["at"] for s in arun["sessions"]] == ["2026-09-21"] and bala["sessions"] == []
    assert "no_session_dates" in past_data.NOT_IMPORTED


def test_a_session_with_no_course_is_reported_once_per_row():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Arun", "9000000001")],
        "Sessions": [child(2, "FM-1", course="Treatment", completed_dates="21-09-2026, 22-09-2026, 23-09-2026")],
    })
    assert [f.code for f in data.findings] == ["session_no_course"]
    assert data.clients[0]["sessions_completed"] == 3


def instalments(**parts):
    """{"instalment_<n>_<part>": cell} off i1_amount=2800, i1_paid_date=..."""
    out = {}
    for key, value in parts.items():
        n, part = key[1:].split("_", 1)
        out[f"instalment_{n}_{part}"] = value
    return out


def test_one_payments_row_per_client():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Bala", "9000000001")],
        "Physio": [child(2, "FM-1", course="Treatment", sessions=14, amount=8400, start_date=datetime(2026, 9, 19))],
        "Payments": [child(2, "FM-1", consultation_fee=1500, consultation_date=datetime(2026, 9, 18),
                           consultation_mode="Cash", **instalments(
                               i1_amount=2800, i1_paid_date="20-09-2026", i1_mode="UPI",
                               i2_amount=2800, i2_paid_date=datetime(2026, 9, 27), i2_mode="Cash",
                               i3_amount=2800, i3_due_date=datetime(2026, 10, 10)))],
    })
    assert codes(data) == []
    consultation, first, second, third = data.payments
    assert [p["excel_id"] for p in data.payments] == [
        "Payments · row 2 · Consultation", "Payments · row 2 · Instalment 1",
        "Payments · row 2 · Instalment 2", "Payments · row 2 · Instalment 3"]
    assert (consultation["state"], consultation["amount_paid"], consultation["paid_date"], consultation["mode"]) == (
        "paid", 1500, "2026-09-18", "cash")
    consult_course = next(t for t in data.treatments if t["course"] == "Consultation")
    assert consultation["treatment_id"] == consult_course["id"]
    assert [(p["installment"], p["state"], p["paid_date"], p["mode"]) for p in (first, second)] == [
        (1, "paid", "2026-09-20", "upi"), (2, "paid", "2026-09-27", "cash")]
    assert (third["state"], third["outstanding"], third["due_date"], third["status_as_written"]) == (
        "unpaid", 2800, "2026-10-10", "Pending")
    course = next(t for t in data.treatments if t["course"] == "Treatment")
    assert {p["treatment_id"] for p in (first, second, third)} == {course["id"]}
    client = data.clients[0]
    assert (client["paid_total"], client["outstanding_total"]) == (7100, 2800)


def test_a_payment_with_no_date_is_neither_paid_nor_owed():
    data = build({
        "Leads": [lead(2, "FM-1", "Test Bala", "9000000001"), lead(3, "FM-2", "Test Anbu", "9000000002")],
        "Physio": [child(2, "FM-1", course="Treatment")],
        "Payments": [child(2, "FM-1", consultation_fee=1500, consultation_mode="Cash",
                           **instalments(i1_amount=2800, i1_paid_date="31-09-2026", i1_mode="UPI")),
                     child(3, "FM-2", phone="9000000002")],
    })
    consultation, first = data.payments
    assert (consultation["state"], consultation["amount_paid"], consultation["outstanding"]) == ("unknown", None, 0)
    assert (first["state"], first["amount_paid"], first["outstanding"]) == ("unknown", None, 0)
    details = [f.detail for f in data.findings if f.code == "no_status"]
    assert details == ["Test Bala: Rs.1500, Consultation: no Consultation Date",
                       "Test Bala: Rs.2800, Instalment 1: no Paid Date or Due Date that reads as a date ('31-09-2026')"]
    assert "no_payments" in codes(data) and "no_payments" in past_data.NOT_IMPORTED
    assert data.clients[0]["paid_total"] == 0


@pytest.mark.parametrize("written,read", [
    (dt_time(10, 0), "10:00"),
    (datetime(1899, 12, 30, 18, 30), "18:30"),
    (0.4375, "10:30"),
    ("10:00", "10:00"),
    ("6:30 pm", "18:30"),
    ("10 AM", "10:00"),
    (10, "10:00"),
    ("morning", ""),
    (None, ""),
])
def test_clock(written, read):
    assert clock(written) == read


def test_moment_keeps_a_time_and_drops_midnight():
    assert moment(datetime(2026, 9, 4, 11, 30)) == "2026-09-04 11:30"
    assert moment(datetime(2026, 9, 4)) == "2026-09-04"
    assert moment("04-09-2026 11:30") == "2026-09-04 11:30"
    assert moment("-") == ""


def _workbook(path, tabs):
    from openpyxl import Workbook
    wb = Workbook()
    wb.remove(wb.active)
    for title, (columns, rows) in tabs.items():
        ws = wb.create_sheet(title)
        ws.append(list(columns.values()))
        for values in rows:
            ws.append([values.get(key) for key in columns])
    wb.save(path)
    return path


def test_read_workbook_reads_the_os_data_workbook(tmp_path):
    path = _workbook(tmp_path / "OSDATAX.xlsx", {
        "Leads": (COLUMNS["Leads"], [{"excel_id": "FM-1", "name": "Test Arun", "phone": "9000000001", "current_stage": "RNR"}]),
        # The template's own tab name, with its trailing space.
        "Reviews ": (COLUMNS["Reviews"], [{"client_excel_id": "FM-1", "at": datetime(2026, 9, 1), "status": "Pending"}]),
        # NAME, PHONE and AMOUNT columns: the revenue reader would have taken this tab alone.
        "Payments": (COLUMNS["Payments"], [{"client_excel_id": "FM-1", "status": "Pending", "amount": 700}]),
        "Listed Data": ({"a": "Current Stage", "b": "Gender"}, [{"a": "Leads", "b": "Male"}]),
    })
    data = read_workbook(path)
    assert data.layout == "os" and data.types == ["lead", "sessions", "revenue"]
    assert data.tabs == ["Leads", "Reviews", "Payments"] and data.tabs_missing == ["Physio", "Sessions"]
    assert data.payments[0]["state"] == "unpaid" and data.clients[0]["reviews_count"] == 1


def test_read_workbook_reads_a_sessions_row_per_client(tmp_path):
    """The Sessions tab as the template now lays it out: no Session No, Date & Time, Status or
    Remarks -- a row per client's course, its dates in two cells."""
    columns = {k: COLUMNS["Sessions"][k] for k in (
        "client_excel_id", "phone", "name", "course", "physio", "time", "completed_dates", "upcoming_dates")}
    path = _workbook(tmp_path / "OSDATAX.xlsx", {
        "Leads": (COLUMNS["Leads"], [{"excel_id": "FM-1", "name": "Test Arun", "phone": "9000000001",
                                      "current_stage": "Physio Assign"}]),
        "Physio": (COLUMNS["Physio"], [{"client_excel_id": "FM-1", "course": "Treatment", "sessions": 11,
                                        "start_date": datetime(2026, 10, 6)}]),
        "Sessions": (columns, [{"client_excel_id": "FM-1", "course": "Treatment", "physio": "Test Salma",
                                "time": dt_time(10, 0), "completed_dates": "07-10-2026, 08-10-2026\n09-10-2026",
                                "upcoming_dates": "13-10-2026, 14-10-2026"}]),
    })
    data = read_workbook(path)
    assert codes(data) == [] and data.tab_rows["Sessions"] == 1
    client = data.clients[0]
    assert (client["sessions_completed"], client["sessions_upcoming"]) == (3, 2)
    assert client["sessions"][0]["at"] == "2026-10-07 10:00" and client["sessions"][-1]["at"] == "2026-10-14 10:00"


def test_read_workbook_reads_a_payments_row_per_client(tmp_path):
    """The Payments tab as the template now lays it out: as many instalment columns as the
    plan has, "Installment" spelt either way, and no Status, Amount or Reference No."""
    columns = {k: COLUMNS["Payments"][k] for k in (
        "client_excel_id", "phone", "name", "consultation_fee", "consultation_date", "consultation_mode")}
    for n in (1, 2):
        word = "Instalment" if n == 1 else "Installment"
        columns.update({f"instalment_{n}_amount": f"{word} {n} Amount", f"instalment_{n}_paid_date": f"{word} {n} Paid Date",
                        f"instalment_{n}_due_date": f"{word} {n} Due Date", f"instalment_{n}_mode": f"{word} {n} Mode"})
    path = _workbook(tmp_path / "OSDATAX.xlsx", {
        "Leads": (COLUMNS["Leads"], [{"excel_id": "FM-1", "name": "Test Anbu", "phone": "9000000001",
                                      "current_stage": "Physio Assign"}]),
        "Payments": (columns, [{"client_excel_id": "FM-1", "consultation_fee": 1500,
                                "consultation_date": datetime(2026, 9, 18), "consultation_mode": "Cash",
                                "instalment_1_amount": 9600, "instalment_1_paid_date": datetime(2026, 9, 18),
                                "instalment_1_mode": "UPI", "instalment_2_amount": 9600,
                                "instalment_2_due_date": datetime(2026, 10, 18)}]),
    })
    data = read_workbook(path)
    assert codes(data) == ["payment_no_course"] and data.tab_rows["Payments"] == 1
    assert [(p["payment_for"], p["installment"], p["state"]) for p in data.payments] == [
        ("Consultation Fee", None, "paid"), ("Treatment Fee", 1, "paid"), ("Treatment Fee", 2, "unpaid")]
    client = data.clients[0]
    assert (client["paid_total"], client["outstanding_total"]) == (11100, 9600)


def test_read_workbook_reads_a_sheet_without_patient_id(tmp_path):
    """Phone, not Patient ID, ties every tab together -- and tells the workbook for this one."""
    def without_id(tab):
        return {k: v for k, v in COLUMNS[tab].items() if k not in ("excel_id", "client_excel_id")}

    path = _workbook(tmp_path / "OSDATAX.xlsx", {
        "Leads": (without_id("Leads"), [{"name": "Test Bala", "phone": "8825587322", "current_stage": "Physio Assign"}]),
        "Sessions": ({k: without_id("Sessions")[k] for k in ("phone", "time", "completed_dates")},
                     [{"phone": "8825587322", "time": "10:00", "completed_dates": "21, 22-09-2026"}]),
    })
    data = read_workbook(path)
    assert data.layout == "os" and "no_patient_id" not in codes(data)
    assert [s["at"] for s in data.clients[0]["sessions"]] == ["2026-09-21 10:00", "2026-09-22 10:00"]


def test_a_payments_tab_without_status_is_refused(tmp_path):
    columns = {k: v for k, v in COLUMNS["Payments"].items() if k != "status"}
    path = _workbook(tmp_path / "OSDATAX.xlsx", {
        "Leads": (COLUMNS["Leads"], [{"excel_id": "FM-1", "name": "Test Arun", "phone": "9000000001", "current_stage": "RNR"}]),
        "Payments": (columns, [{"client_excel_id": "FM-1", "amount": 700}]),
    })
    with pytest.raises(PastDataError, match="Status"):
        read_workbook(path)
