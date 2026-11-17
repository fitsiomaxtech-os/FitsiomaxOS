"""Paid-session alerts: a Treatment Fee collected for some of the sessions tells the branch
when the sessions paid for have been used up."""
from routers.v3_session_payment import alert_message, payment_alert, sessions_paid_for


def _lead(installments, sessions=14, price=11200):
    return {
        "id": "L1", "name": "BALA TESTING", "session_package_sessions": sessions,
        "session_package_price": price,
        "treatment_fee_payment_details": {"installments": installments},
    }


# Rs.11,200 for 14 sessions, 12 collected now and 2 left on a balance installment.
BALA = _lead([
    {"amount": 9600, "due_date": "2026-09-21", "paid": True, "sessions": 12},
    {"amount": 1600, "due_date": "2026-09-30", "paid": False, "sessions": 2},
])


def test_sessions_paid_for_reads_installment_session_counts():
    paid = sessions_paid_for(BALA)
    assert paid["paid_sessions"] == 12
    assert paid["balance"] == 1600
    assert paid["balance_due_date"] == "2026-09-30"


def test_no_alert_while_paid_sessions_remain():
    assert payment_alert(BALA, 5) is None
    assert payment_alert(BALA, 0) is None


def test_heads_up_one_session_before():
    assert payment_alert(BALA, 11)["level"] == "last_paid"


def test_due_once_paid_sessions_are_used():
    alert = payment_alert(BALA, 12)
    assert alert["level"] == "due" and alert["unpaid_sessions_given"] == 0
    assert "used all 12 paid sessions" in alert_message(alert)


def test_due_past_paid_sessions_counts_unpaid_given():
    alert = payment_alert(BALA, 14)
    assert alert["level"] == "due" and alert["unpaid_sessions_given"] == 2
    assert "paid for only 12" in alert_message(alert)
    assert "13 sessions" in alert_message(payment_alert(BALA, 13))


def test_settled_balance_clears_alert():
    lead = _lead([
        {"amount": 9600, "due_date": "2026-09-21", "paid": True, "sessions": 12},
        {"amount": 1600, "due_date": "2026-09-30", "paid": True, "sessions": 2},
    ])
    assert payment_alert(lead, 14) is None


def test_partial_schedule_without_session_counts_divides_money():
    # Rs.10,000 for 10 sessions, Rs.4,500 paid -> 4 sessions (a half-paid one does not count).
    lead = _lead([
        {"amount": 4500, "due_date": "2026-09-01", "paid": True},
        {"amount": 5500, "due_date": "2026-10-01", "paid": False},
    ], sessions=10, price=10000)
    assert sessions_paid_for(lead)["paid_sessions"] == 4
    assert payment_alert(lead, 4)["level"] == "due"


def test_fully_paid_upfront_has_no_alert():
    assert payment_alert({"id": "L2", "session_package_sessions": 10, "treatment_fee_paid": 8000}, 10) is None


# ---------- The block past the paid sessions, and the Branch Admin's extension ----------
from routers.v3_session_payment import extension_active, payment_hold, payment_hold_message  # noqa: E402


def _with_ext(ext):
    return {**BALA, "session_payment_extension": ext}


def test_day_13_is_held_once_12_paid_sessions_are_used():
    assert payment_hold(BALA, 11) is None
    hold = payment_hold(BALA, 12)
    assert hold["next_session"] == 13
    assert "Day 13 is on hold" in payment_hold_message(hold)


def test_request_alone_does_not_release_the_hold():
    hold = payment_hold(_with_ext({"status": "requested", "requested_due_date": "2026-10-15"}), 12)
    assert hold is not None
    assert "request for more time" in payment_hold_message(hold)


def test_approved_extension_releases_until_its_date():
    lead = _with_ext({"status": "approved", "extended_due_date": "2026-10-15"})
    assert extension_active(lead, today="2026-10-15")
    assert payment_hold(lead, 12, today="2026-09-21") is None
    assert payment_hold(lead, 13, today="2026-10-15") is None
    # Past the extended date the remaining days are held again.
    assert payment_hold(lead, 13, today="2026-10-16") is not None


def test_rejected_extension_keeps_the_hold():
    assert payment_hold(_with_ext({"status": "rejected"}), 12) is not None


def test_no_hold_once_balance_is_paid():
    lead = _lead([
        {"amount": 9600, "paid": True, "sessions": 12},
        {"amount": 1600, "paid": True, "sessions": 2},
    ])
    assert payment_hold(lead, 12) is None


def test_unpaid_allowed_releases_the_hold_but_keeps_the_alert():
    lead = {**BALA, "unpaid_days_allowed": True}
    assert payment_hold(lead, 12) is None
    assert payment_hold(lead, 13) is None
    assert payment_alert(lead, 12)["level"] == "due"
