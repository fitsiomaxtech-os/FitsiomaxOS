"""Old clients: instalments on a course begun on the old Physio Tracker, paid off on the OS."""
import pytest

import old_clients
from old_clients import OldClientError

TODAY = "2026-10-03"
NOW = "2026-10-03T09:15:00+00:00"

# Rs.30,000 for a treatment course, Rs.10,000 of it paid on the tracker as the 1st instalment.
FORM = {
    "name": "  Sumaiya   Naaz ", "phone": "+91 93636 60871", "old_patient_id": "PT-0412",
    "category": "session", "package": "12 Session Pack", "total_fee": 30000, "paid_before": 10000,
    "instalments_before": 1,
}


def _client(**over):
    return {"id": "C1", "branch_id": "B1", **old_clients.clean_client({**FORM, **over})}


def _pay(pid, amount, at):
    return {"id": pid, "amount": amount, "created_at": at}


def test_clean_client_tidies_name_and_phone():
    c = old_clients.clean_client(FORM)
    assert c["name"] == "Sumaiya Naaz"
    assert c["phone"] == "9363660871"
    assert c["total_fee"] == 30000 and c["paid_before"] == 10000


@pytest.mark.parametrize("over, says", [
    ({"name": " "}, "name"),
    ({"phone": "12345"}, "10-digit"),
    ({"category": "zumba"}, "what the old course was for"),
    ({"total_fee": 0}, "total fee"),
    ({"paid_before": -1}, "less than zero"),
    ({"paid_before": 30000}, "fully paid"),
    ({"next_due_date": "15/10/2026"}, "YYYY-MM-DD"),
])
def test_clean_client_refuses(over, says):
    with pytest.raises(OldClientError, match=says):
        old_clients.clean_client({**FORM, **over})


def test_money_paid_before_counts_as_at_least_one_instalment():
    c = old_clients.clean_client({**FORM, "instalments_before": 0})
    assert c["instalments_before"] == 1
    # Nothing paid there: the first instalment taken here is #1.
    c = old_clients.clean_client({**FORM, "paid_before": 0, "instalments_before": 0})
    assert old_clients.next_instalment(c, []) == 1


def test_balance_and_numbering_follow_the_payments():
    c = _client()
    assert old_clients.balance(c, []) == 20000
    assert old_clients.next_instalment(c, []) == 2
    pays = [_pay("P1", 10000, "2026-09-02T06:30:00+00:00")]
    assert old_clients.balance(c, pays) == 10000
    assert old_clients.next_instalment(c, pays) == 3
    pays.append(_pay("P2", 12000, "2026-10-01T06:30:00+00:00"))
    assert old_clients.balance(c, pays) == 0  # never below zero


def test_balances_after_reads_each_receipt_as_it_was():
    c = _client()
    # Listed newest first, as the ledger hands them back.
    pays = [_pay("P2", 5000, "2026-10-01T06:30:00+00:00"), _pay("P1", 10000, "2026-09-02T06:30:00+00:00")]
    assert old_clients.balances_after(c, pays) == {"P1": 10000, "P2": 5000}


def test_check_day_defaults_to_today_and_refuses_the_future():
    assert old_clients.check_day("", TODAY) == TODAY
    assert old_clients.check_day("2026-09-20", TODAY) == "2026-09-20"
    with pytest.raises(OldClientError, match="future"):
        old_clients.check_day("2026-10-04", TODAY)
    with pytest.raises(OldClientError):
        old_clients.check_day("yesterday", TODAY)


def test_stamp_keeps_the_moment_today_and_noon_ist_for_an_earlier_day():
    assert old_clients.stamp_for(TODAY, TODAY, NOW) == NOW
    assert old_clients.stamp_for("2026-09-20", TODAY, NOW) == "2026-09-20T06:30:00+00:00"


def test_details_line_reads_back_through_the_finance_parsers():
    # The amount and the mode lead, so _parse_rs_amount and _parse_payment_mode find them.
    line = old_clients.details_line(12000.0, "upi", 2, _client(), " · UPI txn 4283", "TXN-ANN-261003-0001")
    assert line.startswith("Collected Rs.12000 via upi ·")
    assert "Old client instalment #2 for '12 Session Pack' (old ID PT-0412)" in line
    assert line.endswith("· UPI txn 4283 · Txn TXN-ANN-261003-0001")


def test_matches_name_phone_digits_and_old_id():
    c = _client()
    assert old_clients.matches(c, "")
    assert old_clients.matches(c, "sumaiya")
    assert old_clients.matches(c, "93636 60")
    assert old_clients.matches(c, "pt-04")
    assert not old_clients.matches(c, "kumar")
    # Two digits are part of too many numbers to mean anything.
    assert not old_clients.matches({**c, "name": "X"}, "93")


def test_summary_status_off_the_next_due_date():
    c = _client(next_due_date="2026-10-01")
    s = old_clients.summary(c, [], TODAY, "Anna Nagar")
    assert s["balance"] == 20000 and s["status"] == "overdue" and s["category_label"] == "Treatment"
    assert old_clients.summary(_client(next_due_date="2026-10-05"), [], TODAY)["status"] == "due_soon"
    assert old_clients.summary(_client(), [], TODAY)["status"] == "partial"
    paid = [_pay("P1", 20000, "2026-10-02T06:30:00+00:00")]
    assert old_clients.summary(c, paid, TODAY)["status"] == "paid"


def test_same_course_is_phone_line_and_package():
    a = _client()
    assert old_clients.same_course(a, {**a, "package": "12 session pack"})
    assert not old_clients.same_course(a, {**a, "category": "rehab"})
    assert not old_clients.same_course(a, {**a, "phone": "9000000000"})
