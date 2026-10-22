"""Branch Name and Consultant Name, tab-separated, to paste straight into Excel.

Read-only. One line per branch a Consultant is posted to, so a Consultant covering three
branches appears three times, once under each. Sorted by branch, then name. Active
consultants only; one posted nowhere yet is listed under "(No branch)".

Run on the server, where backend/.env is, then copy the output and paste into cell A1:

    cd backend && python tools/consultant_list_tsv.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import v3_col  # noqa: E402
from deps import HEAD_PHYSIO_ROLES  # noqa: E402

NO_BRANCH = "(No branch)"


def cell(value) -> str:
    # A tab or newline inside a value would split it across Excel cells.
    return " ".join(str(value or "").split())


async def main():
    users = await v3_col("users").find({}, {"_id": 0, "password": 0}).to_list(5000)
    mine = [
        u for u in users
        if (u.get("role") or "").strip().lower() in HEAD_PHYSIO_ROLES and u.get("is_active") is not False
    ]

    employees = await v3_col("employees").find({}, {"_id": 0, "id": 1, "branch_id": 1}).to_list(5000)
    emp_branch = {e.get("id"): e.get("branch_id") for e in employees}
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    branch_name = {b["id"]: b.get("branch_name") or "" for b in branches}

    rows = set()
    for u in mine:
        ids = u.get("branch_ids") or [emp_branch.get(u.get("employee_id"))]
        names = [branch_name.get(i, i) for i in ids if i] or [NO_BRANCH]
        for b in names:
            rows.add((cell(b), cell(u.get("full_name"))))

    print("Branch Name\tConsultant Name")
    for b, name in sorted(rows, key=lambda r: (r[0] == NO_BRANCH, r[0].lower(), r[1].lower())):
        print(b + "\t" + name)


if __name__ == "__main__":
    asyncio.run(main())
