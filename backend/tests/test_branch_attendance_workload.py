"""Exercise daily branch counts without importing the application's live database."""
import ast
import asyncio
from datetime import date, timedelta
from pathlib import Path
from typing import Dict


def load_counter(records, queries):
    tree = ast.parse((Path(__file__).parents[1] / "routers/v3_me.py").read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_branch_daily_workload")

    class Collection:
        def __init__(self, name):
            self.name = name

        def find(self, query, projection):
            queries.append((self.name, query))
            self.rows = [r for r in records.get(self.name, [])
                         if r["branch_id"] == query["branch_id"]
                         and query["slot_time"]["$gte"] <= r["slot_time"] < query["slot_time"]["$lt"]
                         and r.get("status") != query["status"]["$ne"]]
            return self

        async def to_list(self, limit):
            return self.rows

    namespace = {"Dict": Dict, "date": date, "timedelta": timedelta, "v3_col": Collection}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "counter", "exec"), namespace)
    return namespace[function.name]


def test_branch_scope_cancellations_and_daily_classification():
    def booking(day="2026-11-14", **extra):
        return {"branch_id": "A", "slot_time": day + "T10:00:00", **extra}

    records = {
        "appointments": [booking(), booking(appt_kind="diet"), booking(status="cancelled"),
                         booking(branch_id="B"), booking("2026-12-01"), booking("2026-11-30")],
        "sessions": [booking(), booking(status="cancelled")],
        "rehab_sessions": [booking("2026-11-15")],
    }
    queries = []
    count = load_counter(records, queries)
    result = asyncio.run(count("A", "2026-11-01", "2026-11-30"))
    assert result == {"2026-11-14": {"appointments": 3, "consultations": 1},
                      "2026-11-15": {"appointments": 1, "consultations": 0},
                      "2026-11-30": {"appointments": 1, "consultations": 1}}
    assert len(queries) == 3


def test_missing_branch_does_not_query_other_branches():
    queries = []
    count = load_counter({}, queries)
    assert asyncio.run(count("", "2026-11-01", "2026-11-30")) == {}
    assert queries == []
