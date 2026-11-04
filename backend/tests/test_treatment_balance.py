"""What a Treatment Fee collection for some of a package's sessions leaves owing. Pure
functions — no server or DB."""
import pytest

from routers.v3_packages import settle_fee_money

# Rs.90,000 for 84 sessions, 20 of them collected now.
TWENTY = 21428.57


def _settle(amount, list_price=TWENTY, discount=None, **kw):
    return settle_fee_money(
        list_price=list_price, total_price=90000, amount=amount, discount_in=discount,
        balance_due_date="2026-12-01", **kw,
    )


@pytest.mark.parametrize("amount, balance", [(22000, 68000), (20000, 70000), (TWENTY, 68571.43)])
def test_extra_toward_bill_leaves_the_package_less_what_was_collected(amount, balance):
    settled = _settle(amount, extra_toward_bill=True)
    assert settled["balance"] == balance
    assert settled["discount"] == 0
    assert settled["installments"][1]["amount"] == balance


def test_a_typed_discount_still_comes_off_the_package():
    assert _settle(22000, discount=1000, extra_toward_bill=True)["balance"] == 67000


def test_money_past_the_whole_package_is_an_additional_amount():
    settled = _settle(95000, list_price=90000, extra_toward_bill=True)
    assert settled["balance"] == 0
    assert settled["discount"] == -5000
    assert settled["reason"] == "Additional amount collected"


def test_without_it_extra_stays_on_top_of_the_sessions():
    settled = _settle(22000)
    assert settled["balance"] == 68571.43
    assert settled["reason"] == "Additional amount collected"
