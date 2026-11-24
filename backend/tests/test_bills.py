"""The bill a payment is given: its lines, its sums, its number, and who may open it. No
server or DB -- the collections are in memory."""
import asyncio
import re
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import bill_book
import bills
import database
import utils
import routers.v3_bills as api
import routers.v3_finance as finance

LEAD = {
    "id": "L1", "name": "Sample Patient", "patient_number": "ANN-261123-0000", "age": 35, "gender": "female",
    "phone": "9876543210", "branch_id": "ann",
    "session_package_name": "10 Session Pack", "session_package_price": 8000, "session_package_sessions": 10,
    "session_package_mode": "offline",
    "package_name": "First Visit", "package_price": 500, "package_mode": "online",
}


def adds_up(b):
    assert bills.near(sum(i["amount"] for i in b["items"]), b["subtotal"])
    assert bills.near(b["subtotal"] - b["discount"], b["total"])
    if b["balance"] is not None:
        assert bills.near(b["total"], b["already_paid"] + b["paid_now"] + b["balance"])
    for i in b["items"]:
        assert bills.near(i["qty"] * i["price"], i["amount"])


def bill_for(fee, details, act, amount, mode="cash", taken_at=None, lead=LEAD):
    out = bills.combine([bills.fee_part(fee, details, lead, act, amount, mode, taken_at or {})])
    adds_up(out)
    return out


def test_a_fee_paid_in_full_is_one_paid_line():
    b = bill_for("consultation", {"transaction_id": "T1"}, {"transaction_id": "T1", "created_at": "2026-11-23T05:00:00"}, 500, "upi")
    assert b["items"] == [{"service": "Consultation", "detail": "First Visit · Online", "qty": 1, "price": 500, "amount": 500}]
    assert (b["total"], b["paid_now"], b["already_paid"], b["balance"], b["status"]) == (500, 500, 0, 0, "paid")
    assert b["installments"] == []


# The part payment the user's sample bill shows: Rs.8,000 less Rs.500, Rs.4,000 now.
PART = {
    "transaction_id": "T1", "discount_amount": 500, "upi_transaction_id": "PAY1", "upi_utr": "1234",
    "installments": [
        {"amount": 4000, "due_date": "2026-11-23", "paid": True},
        {"amount": 3500, "due_date": "2026-12-05", "paid": False},
    ],
}
ACT1 = {"transaction_id": "T1", "created_at": "2026-11-23T05:00:00"}


def test_a_part_payment_says_what_is_left_and_when():
    b = bill_for("treatment", PART, ACT1, 4000, "upi")
    assert b["items"][0]["qty"] == 10 and b["items"][0]["price"] == 800 and b["items"][0]["amount"] == 8000
    assert b["items"][0]["detail"] == "10 Session Pack · Offline · Payment 1"
    assert (b["subtotal"], b["discount"], b["total"]) == (8000, 500, 7500)
    assert (b["already_paid"], b["paid_now"], b["balance"], b["due_date"]) == (0, 4000, 3500, "2026-12-05")
    assert b["status"] == "part_paid"
    assert b["payments"] == [{"mode": "upi", "label": "UPI", "amount": 4000, "reference": "PAY1 · UTR 1234", "notes": ""}]
    assert [i["paid"] for i in b["installments"]] == [True, False]


SETTLED = {
    **PART,
    "installments": [
        {"amount": 4000, "due_date": "2026-11-23", "paid": True},
        {"amount": 3500, "due_date": "2026-12-05", "paid": True, "paid_on": "2026-12-04", "transaction_id": "T2",
         "payment_mode": "card", "card_transaction_id": "SWIPE9"},
    ],
}
TAKEN = {"T2": "2026-12-04T06:00:00"}


def test_the_second_payment_counts_the_first_as_already_paid():
    b = bill_for("treatment", SETTLED, {"transaction_id": "T2", "created_at": TAKEN["T2"]}, 3500, "card", TAKEN)
    assert (b["total"], b["already_paid"], b["paid_now"], b["balance"], b["status"]) == (7500, 4000, 3500, 0, "paid")
    assert b["payments"][0]["reference"] == "SWIPE9"
    assert "Payment 2" in b["items"][0]["detail"]


def test_reprinting_the_first_bill_after_the_second_payment_says_what_it_said():
    assert bill_for("treatment", SETTLED, ACT1, 4000, "upi", TAKEN) == bill_for("treatment", PART, ACT1, 4000, "upi")


def test_a_discount_on_a_later_instalment_is_not_on_the_earlier_bill():
    details = {
        **SETTLED, "discount_amount": 700,
        "installments": [SETTLED["installments"][0], {**SETTLED["installments"][1], "amount": 3300, "discount_amount": 200, "scheduled_amount": 3500}],
    }
    first = bill_for("treatment", details, ACT1, 4000, "upi", TAKEN)
    assert (first["discount"], first["balance"], first["total"]) == (500, 3500, 7500)
    second = bill_for("treatment", details, {"transaction_id": "T2", "created_at": TAKEN["T2"]}, 3300, "card", TAKEN)
    assert (second["discount"], second["paid_now"], second["balance"], second["total"]) == (700, 3300, 0, 7300)


def test_part_sessions_name_the_sessions_this_payment_bought():
    details = {"transaction_id": "T1", "installments": [
        {"amount": 4000, "due_date": "2026-11-23", "paid": True, "sessions": 5},
        {"amount": 4000, "due_date": "2026-12-05", "paid": False, "sessions": 5},
    ]}
    b = bill_for("treatment", details, ACT1, 4000)
    assert b["items"][0]["detail"].endswith("Payment 1 · 5 of 10 sessions")
    assert (b["total"], b["balance"]) == (8000, 4000)


def test_a_payment_plan_bills_each_instalment_as_it_comes():
    rows = [
        {"amount": 3000, "due_date": "2026-11-23", "paid": True, "transaction_id": "A", "payment_mode": "cash", "denominations": {"500": 6}},
        {"amount": 3000, "due_date": "2026-12-23", "paid": True, "transaction_id": "B", "payment_mode": "upi"},
        {"amount": 2000, "due_date": "2027-01-23", "paid": False},
    ]
    taken = {"A": "2026-11-23T05:00:00", "B": "2026-12-23T05:00:00"}
    first = bill_for("treatment", {"installments": rows}, {"transaction_id": "A", "created_at": taken["A"]}, 3000, "cash", taken)
    assert (first["already_paid"], first["paid_now"], first["balance"], first["due_date"]) == (0, 3000, 5000, "2026-12-23")
    assert first["payments"][0]["notes"] == "6 x 500"
    second = bill_for("treatment", {"installments": rows}, {"transaction_id": "B", "created_at": taken["B"]}, 3000, "upi", taken)
    assert (second["already_paid"], second["paid_now"], second["balance"]) == (3000, 3000, 2000)


def test_pre_book_money_is_already_paid_on_the_balance_bill():
    details = {"pre_book": True, "pre_book_transaction_id": "P", "installments": [
        {"amount": 200, "due_date": "2026-11-23", "paid": True, "payment_mode": "pre_book", "pre_book": True},
        {"amount": 300, "due_date": "2026-11-23", "paid": True, "transaction_id": "C", "payment_mode": "cash"},
    ]}
    b = bill_for("consultation", details, {"transaction_id": "C", "created_at": "2026-11-23T05:00:00"}, 300, "cash", {"C": "2026-11-23T05:00:00"})
    assert (b["total"], b["already_paid"], b["paid_now"], b["status"]) == (500, 200, 300, "paid")


def test_a_corrected_fee_does_not_count_earlier_payments_twice():
    details = {**SETTLED, "transaction_id": "T3", "discount_amount": 500}
    act = {"transaction_id": "T3", "created_at": "2026-12-10T05:00:00"}
    b = bill_for("treatment", details, act, 7500, "cash", TAKEN)
    assert (b["already_paid"], b["paid_now"], b["balance"], b["total"]) == (0, 7500, 0, 7500)


def test_more_than_the_price_prints_as_its_own_line():
    b = bill_for("consultation", {"transaction_id": "T1"}, ACT1, 600)
    assert [(i["service"], i["amount"]) for i in b["items"]] == [("Consultation", 500), ("Additional amount", 100)]


def test_a_course_split_online_and_offline_prints_both_rates():
    lead = {**LEAD, "session_package_price": 6800, "session_mode_plan": [
        {"mode": "offline", "days": 6, "amount": 4800}, {"mode": "online", "days": 4, "amount": 2000},
    ]}
    b = bill_for("treatment", {"transaction_id": "T1"}, ACT1, 6800, lead=lead)
    assert [(i["qty"], i["price"], i["detail"]) for i in b["items"]] == [
        (6, 800, "10 Session Pack · Offline"), (4, 500, "10 Session Pack · Online"),
    ]


def test_a_price_that_does_not_divide_is_one_lot():
    lead = {**LEAD, "session_package_price": 1000, "session_package_sessions": 3}
    b = bill_for("treatment", {"transaction_id": "T1"}, ACT1, 1000, lead=lead)
    assert (b["items"][0]["qty"], b["items"][0]["price"]) == (1, 1000)
    assert "3 sessions" in b["items"][0]["detail"]


def test_a_house_visit_says_so():
    b = bill_for("treatment", {"transaction_id": "T1"}, ACT1, 8000, lead={**LEAD, "visit_type": "home"})
    assert b["items"][0]["service"] == "Physiotherapy Session (House Visit)"


def test_extra_amounts_are_billed_one_charge_at_a_time():
    rows = [
        {"amount": 300, "due_date": "2026-11-20", "paid": True, "transaction_id": "X1", "note": "Tape", "added_on": "2026-11-20"},
        {"amount": 900, "due_date": "2026-12-01", "paid": False, "note": "Belt", "added_on": "2026-11-21"},
    ]
    b = bill_for("extra", {"installments": rows}, {"transaction_id": "X1", "created_at": "2026-11-20T05:00:00"}, 300)
    assert (b["total"], b["balance"], b["status"]) == (300, 0, "paid")
    assert b["items"][0]["detail"] == "Tape"


def test_a_fee_re_collected_since_is_not_read_off_the_new_one():
    assert bills.fee_part("treatment", {"transaction_id": "NEW"}, LEAD, ACT1, 4000, "cash", {}) is None
    act = {"details": "Collected Treatment Fee · Rs.4000 via cash · balance Rs.3500.0 due 2026-12-05 · Txn T1", "discount_amount": 500}
    b = bills.combine([bills.activity_part("Physiotherapy Session", act, 4000, [], True)])
    adds_up(b)
    assert (b["total"], b["balance"], b["due_date"]) == (7500, 3500, "2026-12-05")


def test_a_payment_whose_balance_is_not_known_is_never_called_paid():
    b = bills.combine([bills.activity_part("Physiotherapy Session", {"details": "Collected Treatment Fee Installment"}, 400, [], False)])
    assert b["balance"] is None and b["status"] == ""


def test_pre_book_consultation_and_advance_are_one_bill():
    consult = {"name": "First Visit", "mode": "offline", "price": 500, "paid": 300, "discount": 50, "payment_mode": "upi",
               "payment_details": {"upi_transaction_id": "U1"}}
    advance = {"amount": 1000, "payment_mode": "upi", "payment_details": {"upi_transaction_id": "U1"}}
    b = bills.combine([bills.pre_book_consultation_part(consult, "2026-11-30"), bills.pre_book_advance_part(advance, "Sessions")])
    adds_up(b)
    assert (b["subtotal"], b["discount"], b["total"], b["paid_now"], b["balance"]) == (1500, 50, 1450, 1300, 150)
    assert b["payments"] == [{"mode": "upi", "label": "UPI", "amount": 1300, "reference": "U1", "notes": ""}]
    assert b["due_date"] == "2026-11-30"


def test_a_split_payment_names_its_parts():
    details = {"transaction_id": "T1", "payment_lines": [
        {"mode": "cash", "amount": 300, "denominations": {"200": 1, "100": 1}}, {"mode": "upi", "amount": 200, "reference": "U9"},
    ]}
    b = bill_for("consultation", details, ACT1, 500, "split")
    assert [(p["label"], p["amount"], p["reference"], p["notes"]) for p in b["payments"]] == [
        ("Cash", 300, "", "1 x 200 + 1 x 100"), ("UPI", 200, "U9", ""),
    ]


@pytest.mark.parametrize("mode, fields, says", [
    ("cheque", {"cheque_number": "000123", "bank_name": "HDFC"}, "No. 000123 · HDFC"),
    ("account_transfer", {"transfer_reference": "R1", "bank_name": "SBI"}, "R1 · SBI"),
    ("card", {"account_last4": "4455"}, "Card ****4455"),
    ("cash", {}, ""),
])
def test_references(mode, fields, says):
    assert bills.reference(mode, fields) == says


def test_store_sale():
    b = bills.combine([bills.store_part({"item_name": "Knee Cap", "qty": 2, "unit_price": 450, "amount": 900, "payment_mode": "cash"})])
    adds_up(b)
    assert (b["items"][0]["qty"], b["items"][0]["price"], b["total"], b["status"]) == (2, 450, 900, "paid")


def test_old_client_instalment():
    client = {"category": "session", "package": "12 Session Pack", "total_fee": 30000, "paid_before": 10000}
    p1 = {"id": "1", "amount": 8000, "created_at": "2026-10-01", "instalment_number": 2, "payment_mode": "cash"}
    p2 = {"id": "2", "amount": 5000, "created_at": "2026-11-01", "instalment_number": 3, "payment_mode": "cash"}
    b = bills.combine([bills.old_client_part(client, p2, [p1, p2], 7000)])
    adds_up(b)
    assert (b["total"], b["already_paid"], b["paid_now"], b["balance"]) == (30000, 18000, 5000, 7000)
    b = bills.combine([bills.old_client_part({**client, "total_fee": 0}, p2, [p1, p2], None)])
    assert b["status"] == "" and b["total"] == 5000


def test_registration_payments():
    line = [{"mode": "cash", "amount": 5000}]
    b = bills.combine([bills.registration_part({"source": "zumba", "amount": 5000, "fee_amount": 12000, "already_paid": 4000, "lines": line, "package_name": "3 Month", "package_sessions": 36})])
    adds_up(b)
    assert (b["total"], b["already_paid"], b["paid_now"], b["balance"], b["status"]) == (12000, 4000, 5000, 3000, "part_paid")
    b = bills.combine([bills.registration_part({"source": "fitness", "amount": 2000, "fee_amount": 2000, "previous_balance": 500, "lines": line, "renewal": True})])
    adds_up(b)
    assert [i["service"] for i in b["items"]] == ["Fitness Membership", "Previous balance"]
    assert b["balance"] == 500


# ---- the numbers, and opening a bill ----------------------------------------------------

def _hit(doc, q):
    for k, v in q.items():
        have = doc.get(k)
        if isinstance(v, dict):
            if "$in" in v and have not in v["$in"]:
                return False
            if "$ne" in v and have == v["$ne"]:
                return False
            if "$lte" in v and not (have or "") <= v["$lte"]:
                return False
            if "$regex" in v and not re.search(v["$regex"], str(have)):
                return False
        elif have != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, key, _=1):
        self.docs = sorted(self.docs, key=lambda d: d.get(key) or "")
        return self

    async def to_list(self, _):
        return self.docs


class _Col:
    def __init__(self):
        self.docs = []

    async def find_one(self, q, _=None):
        return next((dict(d) for d in self.docs if _hit(d, q)), None)

    def find(self, q, _=None):
        return _Cursor([dict(d) for d in self.docs if _hit(d, q)])

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def update_many(self, q, change):
        for d in self.docs:
            if _hit(d, q):
                d.update(change["$set"])

    async def update_one(self, q, change, upsert=False):
        hit = next((d for d in self.docs if _hit(d, q)), None)
        if not hit and upsert:
            hit = {}
            self.docs.append(hit)
        if hit is not None:
            hit.update(change["$set"])

    async def delete_many(self, q):
        self.docs = [d for d in self.docs if not _hit(d, q)]

    async def find_one_and_update(self, q, change, upsert=False, return_document=None):
        hit = next((d for d in self.docs if _hit(d, q)), None)
        if not hit:
            hit = {**q}
            self.docs.append(hit)
        for k, n in change["$inc"].items():
            hit[k] = hit.get(k, 0) + n
        return dict(hit)


@pytest.fixture
def db(monkeypatch):
    cols = {}

    def col(name):
        return cols.setdefault(name, _Col())

    for mod in (database, bill_book, api, finance):
        monkeypatch.setattr(mod, "v3_col", col)
    col("branches").docs += [
        {"id": "ann", "code": "ANN", "branch_name": "Anna Nagar Branch", "address": "12 Sample Street", "phone": "044000000"},
        {"id": "par", "code": "PAR", "branch_name": "Parrys"},
    ]
    return col


def run(coro):
    return asyncio.run(coro)


ADMIN = SimpleNamespace(role="branch_admin", branch_id="ann", full_name="Priya")


def test_each_branch_runs_its_own_series(db):
    ids = [run(utils.generate_transaction_id(b)) for b in ("ann", "ann", "par", None)]
    nos = [next(d["bill_no"] for d in db("payment_bills").docs if d["transaction_id"] == i) for i in ids]
    assert nos == ["FM-ANN-0001", "FM-ANN-0002", "FM-PAR-0001", "FM-GEN-0001"]


def test_a_payment_still_gets_its_id_when_the_bill_book_fails(db, monkeypatch):
    async def broken(_):
        raise RuntimeError("down")

    monkeypatch.setattr(db("payment_bills"), "insert_one", broken)
    assert run(utils.generate_transaction_id("ann")).startswith("TXN-ANN-")


def _collect(db, txn, **over):
    db("leads").docs.append({**LEAD, "treatment_fee_payment_mode": "upi", "treatment_fee_payment_details": {**PART, "transaction_id": txn}})
    db("lead_activity").docs.append({
        "id": "a1", "transaction_id": txn, "lead_id": "L1", "action": "treatment_fee_collected", "collected_amount": 4000,
        "details": "Collected Treatment Fee · Rs.4000.0 via upi", "created_at": "2026-11-23T05:00:00+00:00", "created_by": "Priya", **over,
    })


def test_opening_a_bill(db):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    b = run(api.get_bill(txn, ADMIN))
    assert b["bill_no"] == "FM-ANN-0001" and b["transaction_ids"] == [txn]
    assert b["collected_by"] == "Priya"
    assert b["patient"] == {"name": "Sample Patient", "number": "ANN-261123-0000", "age": 35, "sex": "Female", "phone": "9876543210"}
    assert b["branch"]["address"] == "12 Sample Street"
    assert (b["total"], b["paid_now"], b["balance"], b["status"]) == (7500, 4000, 3500, "part_paid")
    adds_up(b)


def test_an_old_payment_has_no_bill_no(db):
    _collect(db, "TXN-ANN-260101-0000")
    assert run(api.get_bill("TXN-ANN-260101-0000", ADMIN))["bill_no"] == ""


def test_another_branch_cannot_open_it_but_the_accountant_can(db):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    with pytest.raises(HTTPException) as e:
        run(api.get_bill(txn, SimpleNamespace(role="branch_admin", branch_id="par")))
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        run(api.get_bill(txn, SimpleNamespace(role="branch_admin", branch_id="")))
    with pytest.raises(HTTPException):
        run(api.get_bill(txn, SimpleNamespace(role="zumba", branch_id="ann")))
    assert run(api.get_bill(txn, SimpleNamespace(role="accountant", branch_id=None)))["bill_no"]


def test_only_the_money_desks_are_let_in():
    for role in ("physio", "head_physio", "pre_sales", "human_resource"):
        with pytest.raises(HTTPException) as e:
            run(api.require_bill_reader(SimpleNamespace(role=role, branch_id="ann")))
        assert e.value.status_code == 403
    for role in ("branch_admin", "online_physio_admin", "super_admin", "accountant", "business_dev", "zumba"):
        assert run(api.require_bill_reader(SimpleNamespace(role=role, branch_id="ann")))


def test_an_undone_payment_has_no_bill(db):
    txn = run(utils.generate_transaction_id("ann"))
    with pytest.raises(HTTPException) as e:
        run(api.get_bill(txn, ADMIN))
    assert e.value.status_code == 404


def test_pre_book_goes_on_one_bill_whichever_half_is_opened(db):
    t1 = run(utils.generate_transaction_id("ann"))
    t2 = run(utils.generate_transaction_id("ann", bill_with=t1))
    db("leads").docs.append({**LEAD, "pre_book": {
        "date": "2026-11-30",
        "consultation": {"transaction_id": t1, "name": "First Visit", "price": 500, "paid": 500, "payment_mode": "cash", "mode": "offline"},
        "advance": {"transaction_id": t2, "for": "sessions", "amount": 1000, "payment_mode": "cash"},
    }})
    for n, (txn, action) in enumerate([(t1, "pre_book_consultation_collected"), (t2, "pre_book_advance_collected")]):
        db("lead_activity").docs.append({"transaction_id": txn, "lead_id": "L1", "action": action, "details": "Rs.1 via cash", "created_at": f"2026-11-23T05:0{n}:00", "created_by": "Priya"})
    one, two = run(api.get_bill(t1, ADMIN)), run(api.get_bill(t2, ADMIN))
    assert one["bill_no"] == two["bill_no"] == "FM-ANN-0001"
    assert one["items"] == two["items"] and one["paid_now"] == 1500
    assert run(utils.generate_transaction_id("ann")) and db("payment_bills").docs[-1]["bill_no"] == "FM-ANN-0002"


def test_zumba_payments_are_billed_and_voided_on_undo(db):
    reg = {"id": "Z1", "branch_id": "ann", "name": "Dancer", "age": 22, "gender": "female", "phone": "9000000000"}
    db("zumba_registrations").docs.append(reg)
    info = {"amount": 5000, "lines": [{"mode": "cash", "amount": 5000}], "fee_amount": 12000, "already_paid": 0, "package_name": "3 Month"}
    txn = run(bill_book.bill_registration_payment("zumba", reg, info, "Priya"))
    b = run(api.get_bill(txn, SimpleNamespace(role="zumba", branch_id="ann")))
    assert (b["bill_no"], b["patient"]["name"], b["balance"], b["collected_by"]) == ("FM-ANN-0001", "Dancer", 7000, "Priya")
    assert [x["transaction_id"] for x in run(bill_book.registration_bills(["Z1"]))["Z1"]] == [txn]
    run(bill_book.void_registration_bills("Z1"))
    assert run(bill_book.registration_bills(["Z1"])) == {}
    with pytest.raises(HTTPException):
        run(api.get_bill(txn, ADMIN))


# ---- the PDF link -----------------------------------------------------------------------

class _Upload:
    def __init__(self, data):
        self.data = data

    async def read(self, n=-1):
        return self.data if n < 0 else self.data[:n]


PDF = b"%PDF-1.4 sample"


@pytest.fixture
def pdfs(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "BILL_PDF_DIR", str(tmp_path / "bill_pdfs"))
    return tmp_path / "bill_pdfs"


def _send(txn, user=ADMIN, data=PDF):
    return run(api.share_bill_pdf(txn, _Upload(data), user))["token"]


def test_a_sent_bill_opens_from_its_link_and_nobody_may_keep_it(db, pdfs):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    token = _send(txn)
    assert len(token) >= 20
    res = run(api.public_bill_pdf(token))
    assert res.status_code == 200 and open(res.path, "rb").read() == PDF
    assert 'filename="Bill-FM-ANN-0001.pdf"' in res.headers["content-disposition"] and res.headers["content-disposition"].startswith("inline")
    assert "no-store" in res.headers["cache-control"] and "noindex" in res.headers["x-robots-tag"]


def test_sending_again_keeps_the_link(db, pdfs):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    assert _send(txn) == _send(txn, data=PDF + b"2")
    assert len(db("bill_links").docs) == 1 and len(list(pdfs.iterdir())) == 1


def test_an_expired_link_is_gone(db, pdfs):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    token = _send(txn)
    db("bill_links").docs[0]["expires_at"] = "2020-01-01T00:00:00+00:00"
    assert run(api.public_bill_pdf(token)).status_code == 410
    # Sent again, it is a new link, and the old one stays dead.
    again = _send(txn)
    assert again != token and run(api.public_bill_pdf(token)).status_code == 410


def test_an_undone_payments_link_is_gone(db, pdfs):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    token = _send(txn)
    db("lead_activity").docs.clear()
    assert run(api.public_bill_pdf(token)).status_code == 410


@pytest.mark.parametrize("token", ["", "short", "../../etc/passwd", "a" * 22, "%2e%2e%2f" * 3, "x" * 200])
def test_a_made_up_link_opens_nothing(db, pdfs, token):
    assert run(api.public_bill_pdf(token)).status_code == 410


def test_only_a_branch_that_may_read_the_bill_can_send_it(db, pdfs):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    with pytest.raises(HTTPException) as e:
        _send(txn, SimpleNamespace(role="branch_admin", branch_id="par", full_name="X"))
    assert e.value.status_code == 404 and not db("bill_links").docs


def test_only_a_pdf_and_not_a_huge_one(db, pdfs, monkeypatch):
    txn = run(utils.generate_transaction_id("ann"))
    _collect(db, txn)
    with pytest.raises(HTTPException) as e:
        _send(txn, data=b"<html>")
    assert e.value.status_code == 400
    monkeypatch.setattr(api, "BILL_PDF_MAX_BYTES", 8)
    with pytest.raises(HTTPException) as e:
        _send(txn)
    assert e.value.status_code == 413 and not db("bill_links").docs
