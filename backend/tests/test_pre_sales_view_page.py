"""The Pre Sales View's paged read (GET /leads/pre-sales-view): the first page and the next,
the stage counts across the whole filtered list, the desk split, and each filter. No server
or DB -- the collections are in memory."""
import asyncio
from types import SimpleNamespace

import lead_control
import routers.v3_leads as v3_leads

BDE = SimpleNamespace(full_name="Monica", role="business_dev", branch_id=None)


def _matches(doc, query):
    for key, want in query.items():
        have = doc.get(key)
        if isinstance(want, dict) and "$in" in want:
            if have not in want["$in"]:
                return False
        elif have != want:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, _):
        return self.docs


class _Col:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query, projection=None):
        keep = [k for k, v in (projection or {}).items() if v == 1]
        hits = [d for d in self.docs if _matches(d, query)]
        return _Cursor([{k: d[k] for k in keep if k in d} if keep else dict(d) for d in hits])


def _lead(i, **extra):
    return {
        "id": f"L{i:03d}", "name": f"Patient {i}", "phone": f"98400{i:05d}", "vertical": "Physio",
        "source_type": "manual", "stage": "New Leads", "branch_id": "anna",
        "created_at": f"2026-11-{1 + i % 25:02d}T05:{i % 60:02d}:00.123456+00:00",
        "updated_at": "2026-11-26T00:00:00+00:00", "extra_fields": {}, **extra,
    }


def _run(monkeypatch, leads, **params):
    cols = {
        "leads": _Col(leads),
        "branches": _Col([{"id": "anna", "lead_control": "pre_sales"}, {"id": "taken", "lead_control": "branch_admin"}]),
    }
    monkeypatch.setattr(v3_leads, "v3_col", lambda name: cols[name])
    monkeypatch.setattr(lead_control, "v3_col", lambda name: cols[name])
    args = dict(branch_id=None, stage=None, date_from=None, date_to=None, q=None, sort="newest",
                mark=None, source=None, platform=None, skip=0, limit=75)
    args.update(params)
    return asyncio.run(v3_leads.v3_pre_sales_view_leads(user=BDE, **args))


def test_first_page_then_next(monkeypatch):
    leads = [_lead(i) for i in range(200)]
    first = _run(monkeypatch, leads)
    assert len(first["leads"]) == 75 and first["total"] == 200 and first["counts"]["All"] == 200
    stamps = [l.created_at for l in first["leads"]]
    assert stamps == sorted(stamps, reverse=True)
    nxt = _run(monkeypatch, leads, skip=75, limit=50)
    assert len(nxt["leads"]) == 50
    assert not {l.id for l in first["leads"]} & {l.id for l in nxt["leads"]}
    assert nxt["leads"][0].created_at <= first["leads"][-1].created_at


def test_counts_ignore_the_stage_and_total_follows_it(monkeypatch):
    leads = [_lead(i, stage="RNR" if i % 4 == 0 else "New Leads") for i in range(40)]
    page = _run(monkeypatch, leads, stage="RNR")
    assert page["total"] == 10 and len(page["leads"]) == 10
    assert page["counts"] == {"All": 40, "RNR": 10, "New Leads": 30}


def test_branch_handed_to_its_admin_is_left_out(monkeypatch):
    leads = [_lead(1), _lead(2, branch_id="taken"), _lead(3, branch_id=None)]
    page = _run(monkeypatch, leads)
    assert sorted(l.id for l in page["leads"]) == ["L001", "L003"]
    assert [l.id for l in _run(monkeypatch, leads, branch_id="anna")["leads"]] == ["L001"]


def test_filters(monkeypatch):
    leads = [
        _lead(1, source_type="meta", platform="Instagram", is_vip=True),
        _lead(2, source_type="meta", platform="Facebook"),
        _lead(3, source_tab="Walk-in", needs_attention=True, email="X@Mail.com"),
        _lead(4, created_at="2026-11-26T09:00:00Z"),
        _lead(5, created_at="2026-11-25T18:29:59+00:00"),
    ]
    ids = lambda page: sorted(l.id for l in page["leads"])
    assert ids(_run(monkeypatch, leads, source="Meta")) == ["L001", "L002"]
    assert ids(_run(monkeypatch, leads, source="Meta", platform="Facebook")) == ["L002"]
    assert ids(_run(monkeypatch, leads, mark="vip")) == ["L001"]
    assert ids(_run(monkeypatch, leads, mark="attention")) == ["L003"]
    assert ids(_run(monkeypatch, leads, q="x@mail")) == ["L003"]
    assert ids(_run(monkeypatch, leads, q="9840000004")) == ["L004"]
    # Today in Chennai, as the browser sends it: 26 Nov 00:00 IST to 23:59:59.999 IST.
    today = _run(monkeypatch, leads, date_from="2026-11-25T18:30:00.000Z", date_to="2026-11-26T18:29:59.999Z")
    assert ids(today) == ["L004"]
    assert _run(monkeypatch, leads)["sources"] == ["Meta", "Walk-in", "manual"]
