import asyncio
import os
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import v3_hr  # noqa: E402


def branch_admin(branch_id="branch-a", branch_ids=None):
    return SimpleNamespace(
        role="branch_admin",
        branch_id=branch_id,
        branch_ids=branch_ids or [],
    )


def test_branch_admin_scope_contains_only_assigned_branches():
    assert v3_hr._branch_admin_scope(branch_admin("branch-a", ["branch-b"])) == {
        "branch-a",
        "branch-b",
    }


def test_global_hr_roles_keep_their_existing_unscoped_access():
    assert v3_hr._branch_admin_scope(SimpleNamespace(role="super_admin")) is None


def test_branch_admin_without_a_branch_is_denied():
    with pytest.raises(HTTPException) as exc:
        v3_hr._branch_admin_scope(branch_admin("", []))
    assert exc.value.status_code == 403


def test_employee_with_all_branches_cannot_be_managed_by_branch_admin():
    with pytest.raises(HTTPException) as exc:
        v3_hr._require_employee_branch_scope(
            v3_hr._employee_branch_ids({"branch_id": v3_hr.ALL_BRANCHES}),
            {"branch-a"},
        )
    assert exc.value.status_code == 403


def test_branch_admin_cannot_create_employee_for_another_branch(monkeypatch):
    class Employees:
        inserted = False

        async def insert_one(self, _):
            self.inserted = True

    employees = Employees()
    monkeypatch.setattr(v3_hr, "v3_col", lambda name: employees)
    payload = v3_hr.EmployeeCreate(
        full_name="Branch Staff",
        department="Branch",
        designation="Branch Staff",
        branch_id="branch-b",
        employee_code="EMP9999",
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(v3_hr.create_employee(payload, user=branch_admin()))

    assert exc.value.status_code == 403
    assert employees.inserted is False


def test_branch_admin_cannot_list_another_branch():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(v3_hr.list_employees(branch_id="branch-b", user=branch_admin()))
    assert exc.value.status_code == 403


def test_branch_admin_can_create_employee_for_their_branch(monkeypatch):
    class Employees:
        inserted = None

        async def insert_one(self, doc):
            self.inserted = doc

    employees = Employees()
    monkeypatch.setattr(v3_hr, "v3_col", lambda name: employees)
    payload = v3_hr.EmployeeCreate(
        full_name="Branch Staff",
        department="Branch",
        designation="Branch Staff",
        branch_id="branch-a",
        employee_code="EMP9999",
    )

    result = asyncio.run(v3_hr.create_employee(payload, user=branch_admin()))

    assert result["branch_id"] == "branch-a"
    assert employees.inserted["branch_id"] == "branch-a"


def test_branch_admin_cannot_edit_an_employee_from_another_branch(monkeypatch):
    class Employees:
        async def find_one(self, *_):
            return {"id": "employee-1", "branch_id": "branch-b"}

    monkeypatch.setattr(v3_hr, "v3_col", lambda name: Employees())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            v3_hr.update_employee(
                "employee-1",
                v3_hr.EmployeeUpdate(phone="555-0100"),
                user=branch_admin(),
            )
        )

    assert exc.value.status_code == 403
