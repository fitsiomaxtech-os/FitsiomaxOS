"""Reading the pre-OS Excel register into the Past Data tables.

Unit tests, like test_branch_routing.py beside this one: nothing here touches a database --
see backend/past_data.py. The workbook itself is patient data and never enters the repo, so
the sheets are built here in a few rows each, laid out the way the real register lays them
out: a title row above each header, and on the Payment Tracker a row of status totals
between the title and the header.

What matters most is what the import must not do on a guess. A payment written against the
wrong patient stays on the course it names; a mistyped phone gets no lookup key rather than
a stranger's; an enquiry that could belong to two people belongs to neither. Those get as
much space here as the happy path.
"""
import os
import sys
from datetime import datetime

import pytest

# Same note as the files beside this one: pytest with no __init__.py puts this directory on
# the path rather than the backend root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import past_data  # noqa: E402
from past_data import (  # noqa: E402
    PastDataError, amount, build, day, match_key, payment_mode, payment_state, phone,
    read_workbook, service, summary,
)


# ------------------------------------------------------------------------------ cleaners

def test_phone_plain_mobile_is_its_own_lookup_key():
    assert phone(9840250617) == ("9840250617", "9840250617", [])


def test_phone_country_code_and_leading_zero_come_off():
    assert phone("+91 98402 50617")[1] == "9840250617"
    assert phone("09840250617")[1] == "9840250617"


def test_phone_family_suffix_is_the_family_number():
    written, looked_up, flags = phone("9578141888-1")
    assert written == "9578141888-1"
    assert looked_up == "9578141888"
    assert flags == ["family_phone"]


@pytest.mark.parametrize("value", [805610223, 96986448844, 1234567890, "+179043563755", None, ""])
def test_phone_that_is_not_a_mobile_gets_no_lookup_key(value):
    # "The last ten" of a mistyped number is somebody else's number.
    _, looked_up, flags = phone(value)
    assert looked_up == ""
    assert "check_phone" in flags


def test_match_key_keeps_a_short_number_for_matching_sheets():
    # Useless for finding the patient later, but the same typo in both sheets still pairs them.
    assert match_key(500907189) == "500907189"
    assert match_key("9578141888-1") == "9578141888"


def test_amount_reads_numbers_and_rupee_text():
    assert amount(3000) == 3000
    assert amount(3000.0) == 3000 and isinstance(amount(3000.0), int)
    assert amount("Rs. 1,500") == 1500
    assert amount("₹2,200") == 2200
    assert amount("paid") is None
    assert amount(None) is None
    assert amount(datetime(2026, 4, 1)) is None


def test_day_reads_excel_dates_and_typed_ones():
    assert day(datetime(2026, 4, 1, 0, 0)) == "2026-04-01"
    assert day("01-04-2026") == "2026-04-01"
    assert day("sometime in april") == ""
    assert day(None) == ""


def test_service_trims_and_folds_the_two_spellings_of_group_fitness():
    assert service("Rehab ") == ("Rehab", "offline")
    assert service("Offline Fitness Group") == ("Offline Group Fitness", "offline")
    assert service("Online Fitness Group") == ("Online Group Fitness", "online")
    assert service("Online Physio 1-on-1") == ("Online Physio 1-on-1", "online")
    assert service(None) == ("", "")


@pytest.mark.parametrize("written, mode", [
    ("UPI", "upi"), ("Cash", "cash"), ("Card - Credit", "card"), ("Card-credit", "card"),
    ("Credit-card", "card"), ("Card - Debit", "card"), ("Bank Transfer", "account_transfer"),
    ("Cheque", "cheque"), ("Insurance", "unknown"), ("", ""), (None, ""),
])
def test_payment_mode(written, mode):
    assert payment_mode(written) == mode


def test_payment_mode_holding_a_date_is_no_mode():
    assert payment_mode(datetime(2026, 6, 30)) == ""


def test_payment_state_folds_the_dated_statuses_into_unpaid():
    # Overdue / Due Soon were worked out against the day the workbook was saved.
    for status in ("Overdue", "Pending", "Due Soon"):
        assert payment_state(status, None, 5000) == "unpaid"
    assert payment_state("Paid", 3000, 3000) == "paid"
    assert payment_state("Cancelled", None, None) == "cancelled"
    assert payment_state("", None, None) == "unknown"


# ---------------------------------------------------------------------------- linking

def client(pid, name, ph, reg="2026-04-01", prs=None):
    return {"excel_id": pid, "name": name, "phone": ph, "registration_date": datetime.fromisoformat(reg),
            "enquiry_excel_id": prs, "_row": 3}


def treatment(eid, pid, name, svc="Physio 1-on-1", fee=1000, status="Active"):
    return {"excel_id": eid, "client_excel_id": pid, "name": name, "service": svc, "fee": fee,
            "status": status, "start_date": datetime(2026, 4, 2), "_row": 3}


def payment(pay, eid, pid, name, due=None, paid=None, status="Paid", mode="UPI", balance=None):
    return {"excel_id": pay, "treatment_excel_id": eid, "client_excel_id": pid, "name": name,
            "amount_due": due, "amount_paid": paid, "balance": balance, "status": status, "mode": mode,
            "paid_date": datetime(2026, 4, 2) if status == "Paid" else None, "_row": 4}


def enquiry(prs, name, ph, when="2026-04-01", status="Converted"):
    return {"excel_id": prs, "name": name, "phone": ph, "enquiry_date": datetime.fromisoformat(when),
            "status": status, "converted": "Y", "_row": 3}


def by_excel(rows):
    return {r["excel_id"]: r for r in rows}


def test_payment_stays_on_the_course_it_names_when_its_patient_id_disagrees():
    data = build(
        [client("PAT-1", "Chandrashekar", 9000000001), client("PAT-2", "Padmasaran", 9000000002)],
        [treatment("ENR-1", "PAT-1", "Chandrashekar")],
        [payment("PAY-1", "ENR-1", "PAT-2", "Padmasaran", due=5000, paid=5000)],
        [],
    )
    pay = data.payments[0]
    course = data.treatments[0]
    assert pay["treatment_id"] == course["id"]
    assert pay["client_id"] == course["client_id"] == by_excel(data.clients)["PAT-1"]["id"]
    assert pay["client_excel_id"] == "PAT-2"  # kept as written
    assert "client_mismatch" in pay["flags"]
    assert [f.code for f in data.findings] == ["client_mismatch"]


def test_payment_naming_no_course_is_left_out_and_reported():
    data = build([client("PAT-1", "A", 9000000001)], [], [payment("PAY-1", "ENR-9", "PAT-1", "A", 100, 100)], [])
    assert data.payments == []
    assert [f.code for f in data.findings] == ["missing_treatment"]


def test_course_naming_no_client_is_left_out_and_reported():
    data = build([], [treatment("ENR-1", "PAT-9", "Nobody")], [], [])
    assert data.treatments == []
    assert [f.code for f in data.findings] == ["missing_client"]


def test_totals_are_summed_off_installments_not_the_fee_and_skip_cancelled():
    # A renewal logged as more rows on the same enrollment: the fee says 3000, the patient paid 10500.
    data = build(
        [client("PAT-1", "Anita", 9000000001)],
        [treatment("ENR-1", "PAT-1", "Anita", fee=3000)],
        [
            payment("PAY-1", "ENR-1", "PAT-1", "Anita", 3000, 3000),
            payment("PAY-2", "ENR-1", "PAT-1", "Anita", 7500, 7500),
            payment("PAY-3", "ENR-1", "PAT-1", "Anita", status="Cancelled", mode=None),
            payment("PAY-4", "ENR-1", "PAT-1", "Anita", due=4000, status="Overdue", mode=None, balance=4000),
        ],
        [],
    )
    course = data.treatments[0]
    assert course["fee"] == 3000
    assert course["paid_total"] == 10500
    assert course["outstanding_total"] == 4000
    assert course["payments_count"] == 3
    person = data.clients[0]
    assert (person["paid_total"], person["outstanding_total"], person["treatments_count"]) == (10500, 4000, 1)
    assert person["latest_status"] == "Active"
    assert summary(data)["payment_states"]["cancelled"]["rows"] == 1


def test_issue_count_gathers_flags_from_the_client_their_courses_and_payments():
    data = build(
        [client("PAT-1", "Chandrashekar", 805610223), client("PAT-2", "Padmasaran", "9000000002-1")],
        [treatment("ENR-1", "PAT-1", "Chandrashekar", svc=None)],
        [payment("PAY-1", "ENR-1", "PAT-2", "Padmasaran", 100, 100, mode=None)],
        [],
    )
    first, second = data.clients
    # check_phone + no_service + client_mismatch + check_mode
    assert first["issue_count"] == 4
    # A family "-1" is how the number was written, not a problem with it.
    assert second["flags"] == ["family_phone"] and second["issue_count"] == 0


def test_paid_row_without_a_mode_is_flagged_but_imported():
    data = build([client("PAT-1", "A", 9000000001)], [treatment("ENR-1", "PAT-1", "A")],
                 [payment("PAY-1", "ENR-1", "PAT-1", "A", 100, 100, mode=None)], [])
    assert data.payments[0]["flags"] == ["check_mode"]


def test_shared_phone_flags_every_client_on_it_and_merges_nobody():
    data = build([client("PAT-1", "Saraswathi", 9710375164), client("PAT-2", "Saraswathi", "9710375164-1")], [], [], [])
    assert len(data.clients) == 2
    one, two = data.clients
    assert "shared_phone" in one["flags"] and "shared_phone" in two["flags"]
    assert one["shared_phone_with"] == ["PAT-2"] and two["shared_phone_with"] == ["PAT-1"]


def test_enquiry_attaches_by_phone():
    data = build([client("PAT-1", "Isreal", 9840250617)], [], [], [enquiry("PRS-1", "Isreal", "9840250617")])
    assert [e["excel_id"] for e in data.clients[0]["enquiries"]] == ["PRS-1"]
    assert data.enquiries_attached == 1


def test_enquiry_attaches_by_the_same_typo_in_both_sheets():
    data = build([client("PAT-1", "Sandhya", 500907189)], [], [], [enquiry("PRS-1", "Sandhya", "500907189")])
    assert data.enquiries_attached == 1


def test_enquiry_on_a_family_phone_goes_to_the_named_member():
    data = build(
        [client("PAT-1", "Maheswari", 7358696741), client("PAT-2", "Tamilselvi", "7358696741-1")],
        [], [], [enquiry("PRS-1", "Tamilselvi", "7358696741-1")],
    )
    assert [c["excel_id"] for c in data.clients if c["enquiries"]] == ["PAT-2"]


def test_enquiry_for_one_person_entered_twice_goes_to_the_nearer_registration():
    data = build(
        [client("PAT-1", "Saraswathi", 9710375164, reg="2026-04-01"),
         client("PAT-2", "Saraswathi", 9710375164, reg="2026-05-06")],
        [], [], [enquiry("PRS-1", "Saraswathi", "9710375164", when="2026-05-05")],
    )
    assert [c["excel_id"] for c in data.clients if c["enquiries"]] == ["PAT-2"]


def test_enquiry_that_could_be_two_people_belongs_to_neither():
    data = build(
        [client("PAT-1", "Saraswathi", 9710375164, reg="2026-04-01"),
         client("PAT-2", "Saraswathi", 9710375164, reg="2026-04-01")],
        [], [], [enquiry("PRS-1", "Saraswathi", "9710375164", when="2026-04-01")],
    )
    assert not any(c["enquiries"] for c in data.clients)
    assert [f.code for f in data.findings if f.code.startswith("enquiry")] == ["enquiry_ambiguous"]


def test_enquiry_on_a_family_phone_naming_nobody_there_belongs_to_neither():
    data = build(
        [client("PAT-1", "Maheswari", 7358696741), client("PAT-2", "Tamilselvi", "7358696741-1")],
        [], [], [enquiry("PRS-1", "Kumar", "7358696741")],
    )
    assert data.enquiries_attached == 0
    assert "enquiry_ambiguous" in [f.code for f in data.findings]


def test_enquiry_matching_no_client_is_left_out():
    data = build([client("PAT-1", "A", 9000000001)], [], [], [enquiry("PRS-1", "B", "9000000009")])
    assert data.enquiries_attached == 0
    assert [f.code for f in data.findings] == ["enquiry_no_client"]


def test_explicit_prospect_id_wins_over_the_phone():
    data = build(
        [client("PAT-1", "Suganya Devi", 9840790507, prs="PRS-1"), client("PAT-2", "Other", 9000000002)],
        [], [], [enquiry("PRS-1", "Suganya Devi", "9000000002")],
    )
    assert [c["excel_id"] for c in data.clients if c["enquiries"]] == ["PAT-1"]


def test_recommended_sessions_keeps_the_words_when_they_are_not_a_count():
    rows = [treatment("ENR-1", "PAT-1", "A"), treatment("ENR-2", "PAT-1", "A")]
    rows[0]["recommended_sessions"] = 12
    rows[1]["recommended_sessions"] = "8w"
    data = build([client("PAT-1", "A", 9000000001)], rows, [], [])
    first, second = data.treatments
    assert (first["recommended_sessions"], first["recommended_sessions_text"]) == (12, "")
    assert (second["recommended_sessions"], second["recommended_sessions_text"]) == (None, "8w")


# ------------------------------------------------------------------------ the workbook

def write_register(path, drop_column=None):
    """A four-sheet register shaped like the real one, two clients deep."""
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)

    def sheet(name, title, header, rows, spacer=None):
        header = [h for h in header if h != drop_column]
        ws = wb.create_sheet(name)
        ws.append([title])
        if spacer:
            ws.append(spacer)
        ws.append(header)
        for row in rows:
            ws.append([row.get(h) for h in header])
        # Formula residue below the last record, in a helper column the way "Days Since
        # Inquiry" leaves it -- a value, but nobody's.
        ws.append([None] * (len(header) - 1) + [181])

    sheet("Patient Master", "PATIENT MASTER", list(past_data.CLIENT_COLUMNS.values()), [
        {"Patient ID": "PAT-001", "Full Name": "Vincy", "Gender": "Female", "Phone": 8939889847,
         "Registration Date": datetime(2026, 3, 2)},
        {"Patient ID": "PAT-002", "Full Name": "Porkodi", "Gender": "Female", "Phone": 9884738865,
         "Registration Date": datetime(2026, 3, 2)},
    ])
    sheet("Enrollment Register", "ENROLLMENT REGISTER", list(past_data.TREATMENT_COLUMNS.values()), [
        {"Enrollment ID": "ENR-001", "Patient ID": "PAT-002", "Patient Name": "Porkodi",
         "Service Type": "Zumba Classes", "Enrollment Date": datetime(2026, 4, 1), "Status": "Active",
         "Total Fee (INR)": 3000},
    ])
    sheet("Payment Tracker", "PAYMENT TRACKER", list(past_data.PAYMENT_COLUMNS.values()), [
        {"Payment ID": "PAY-0001", "Enrollment ID": "ENR-001", "Patient ID": "PAT-002", "Patient Name": "Porkodi",
         "Installment #": 1, "Total Installments": 1, "Amount Due (INR)": 3000, "Amount Paid (INR)": 3000,
         "Balance (INR)": 0, "Due Date": datetime(2026, 4, 1), "Date Paid": datetime(2026, 4, 1),
         "Payment Mode": "UPI", "Status": "Paid"},
    ], spacer=["Paid", None, "Overdue", None, "Due Soon (<=7 days)", None, "Pending"])
    sheet("Prospect Pipeline", "PROSPECT PIPELINE", list(past_data.ENQUIRY_COLUMNS.values()), [
        {"Prospect ID": "PRS-001", "Full Name": "Porkodi", "Phone": "9884738865",
         "Inquiry Date": datetime(2026, 3, 30), "Status": "Converted", "Converted? (Y/N)": "Y"},
    ])
    wb.save(path)


def test_read_workbook_finds_each_header_below_its_title(tmp_path):
    path = tmp_path / "register.xlsx"
    write_register(path)
    data = read_workbook(path)
    assert [c["excel_id"] for c in data.clients] == ["PAT-001", "PAT-002"]
    porkodi = by_excel(data.clients)["PAT-002"]
    assert porkodi["registration_date"] == "2026-03-02"
    assert porkodi["paid_total"] == 3000
    assert [e["excel_id"] for e in porkodi["enquiries"]] == ["PRS-001"]
    assert data.payments[0]["mode"] == "upi"
    assert data.findings == []  # the residue row is nobody, and is not reported as anybody


def test_read_workbook_refuses_a_sheet_missing_a_required_column(tmp_path):
    path = tmp_path / "register.xlsx"
    write_register(path, drop_column="Phone")
    with pytest.raises(PastDataError, match="Phone"):
        read_workbook(path)
