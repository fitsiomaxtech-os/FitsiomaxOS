"""
HR Module Backend Tests — iteration 24
Tests /api/v3/hr/* endpoints (dashboard, meta, employees CRUD, users CRUD, branch-admin-candidates)
plus end-to-end flow: create employee → create user linked to employee → user appears in
branch-admin-candidates → user can log in via /api/v3/auth/login.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://lead-manager-100.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

SUPER_ADMIN = {"email": "fitsiomaxtech@gmail.com", "password": "FitsioMax06"}

VALID_ROLES = {"super_admin", "business_dev", "pre_sales", "branch_admin", "head_physio", "physio", "marketing_head"}
EXPECTED_DEPTS = {"Sales", "Operations", "Purchase", "HR", "Architecture", "Accounts", "Planning", "Quality"}


# ----- fixtures -----
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/v3/auth/login", json=SUPER_ADMIN, timeout=15)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_client(admin_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def created_ids():
    return {"employees": [], "users": []}


def _cleanup(admin_client, created_ids):
    for uid in created_ids["users"]:
        try:
            admin_client.delete(f"{API}/v3/hr/users/{uid}", timeout=10)
        except Exception:
            pass
    for eid in created_ids["employees"]:
        try:
            admin_client.delete(f"{API}/v3/hr/employees/{eid}", timeout=10)
        except Exception:
            pass


# ----- meta + dashboard -----
class TestHRMeta:
    def test_meta(self, admin_client):
        r = admin_client.get(f"{API}/v3/hr/meta", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert set(data["departments"]) == EXPECTED_DEPTS
        assert set(data["roles"]) == VALID_ROLES

    def test_dashboard(self, admin_client):
        r = admin_client.get(f"{API}/v3/hr/dashboard", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("active_employees", "total_users", "present_today", "late_today",
                  "pending_leaves", "monthly_salary_budget", "departments"):
            assert k in data["kpis"], f"missing kpi {k}"
        assert isinstance(data["department_strength"], list)

    def test_meta_requires_auth(self):
        r = requests.get(f"{API}/v3/hr/meta", timeout=10)
        assert r.status_code in (401, 403, 422)


# ----- employees CRUD -----
class TestHREmployees:
    def test_create_employee_auto_code(self, admin_client, created_ids):
        payload = {"full_name": f"TEST_Emp_{uuid.uuid4().hex[:6]}", "department": "Sales",
                   "designation": "Sales Exec", "net_salary": 30000}
        r = admin_client.post(f"{API}/v3/hr/employees", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["id"]
        assert doc["employee_code"].startswith("EMP") and len(doc["employee_code"]) == 7
        assert doc["status"] == "active"
        assert doc["full_name"] == payload["full_name"]
        created_ids["employees"].append(doc["id"])

    def test_list_employees_filter(self, admin_client, created_ids):
        r = admin_client.get(f"{API}/v3/hr/employees?status=active", timeout=10)
        assert r.status_code == 200
        rows = r.json()
        assert any(e["id"] == created_ids["employees"][0] for e in rows)
        for e in rows:
            assert e.get("status") == "active"

        r2 = admin_client.get(f"{API}/v3/hr/employees?status=left", timeout=10)
        assert r2.status_code == 200
        for e in r2.json():
            assert e.get("status") == "left"

    def test_patch_employee(self, admin_client, created_ids):
        eid = created_ids["employees"][0]
        r = admin_client.patch(f"{API}/v3/hr/employees/{eid}",
                               json={"designation": "Senior Sales Exec"}, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["designation"] == "Senior Sales Exec"

    def test_patch_employee_404(self, admin_client):
        r = admin_client.patch(f"{API}/v3/hr/employees/does-not-exist",
                               json={"designation": "X"}, timeout=10)
        assert r.status_code == 404


# ----- users CRUD + linking -----
class TestHRUsers:
    def test_create_user_linked(self, admin_client, created_ids):
        eid = created_ids["employees"][0]
        email = f"test_user_{uuid.uuid4().hex[:6]}@fitsiomax.com"
        payload = {"full_name": "TEST_BranchAdmin", "email": email,
                   "password": "branchpass1", "role": "branch_admin", "employee_id": eid}
        r = admin_client.post(f"{API}/v3/hr/users", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        u = r.json()
        assert "password" not in u
        assert u["role"] == "branch_admin"
        assert u["employee_id"] == eid
        assert u["is_active"] is True
        created_ids["users"].append(u["id"])
        created_ids["_test_email"] = email
        created_ids["_test_password"] = "branchpass1"

    def test_create_user_unlinked(self, admin_client, created_ids):
        email = f"test_unlinked_{uuid.uuid4().hex[:6]}@fitsiomax.com"
        r = admin_client.post(f"{API}/v3/hr/users",
                              json={"full_name": "TEST_Unlinked", "email": email,
                                    "password": "passpass", "role": "pre_sales",
                                    "employee_id": None}, timeout=10)
        assert r.status_code == 200, r.text
        created_ids["users"].append(r.json()["id"])

    def test_create_user_duplicate_email(self, admin_client, created_ids):
        email = created_ids["_test_email"]
        r = admin_client.post(f"{API}/v3/hr/users",
                              json={"full_name": "Dup", "email": email,
                                    "password": "passpass", "role": "physio"}, timeout=10)
        assert r.status_code == 409, r.text

    def test_list_users_enriched(self, admin_client, created_ids):
        eid = created_ids["employees"][0]
        uid = created_ids["users"][0]
        r = admin_client.get(f"{API}/v3/hr/users", timeout=10)
        assert r.status_code == 200
        rows = r.json()
        target = next((u for u in rows if u["id"] == uid), None)
        assert target is not None
        assert target.get("linked_employee") is not None
        assert target["linked_employee"]["full_name"]

    def test_list_users_role_filter(self, admin_client, created_ids):
        r = admin_client.get(f"{API}/v3/hr/users?role=branch_admin", timeout=10)
        assert r.status_code == 200
        for u in r.json():
            assert u["role"] == "branch_admin"

    def test_list_users_search(self, admin_client, created_ids):
        email = created_ids["_test_email"]
        r = admin_client.get(f"{API}/v3/hr/users?search={email[:10]}", timeout=10)
        assert r.status_code == 200
        assert any(u["email"] == email for u in r.json())

    def test_update_role_valid(self, admin_client, created_ids):
        uid = created_ids["users"][1]
        r = admin_client.patch(f"{API}/v3/hr/users/{uid}/role?role=head_physio", timeout=10)
        assert r.status_code == 200
        # Revert
        admin_client.patch(f"{API}/v3/hr/users/{uid}/role?role=pre_sales", timeout=10)

    def test_update_role_invalid(self, admin_client, created_ids):
        uid = created_ids["users"][1]
        r = admin_client.patch(f"{API}/v3/hr/users/{uid}/role?role=ceo", timeout=10)
        assert r.status_code == 400

    def test_reset_password_short(self, admin_client, created_ids):
        uid = created_ids["users"][0]
        r = admin_client.patch(f"{API}/v3/hr/users/{uid}/reset-password?password=abc", timeout=10)
        assert r.status_code == 400

    def test_reset_password_ok_and_login(self, admin_client, created_ids):
        uid = created_ids["users"][0]
        new_pw = "newpass1234"
        r = admin_client.patch(f"{API}/v3/hr/users/{uid}/reset-password?password={new_pw}", timeout=10)
        assert r.status_code == 200
        # Try login with new password
        login = requests.post(f"{API}/v3/auth/login",
                              json={"email": created_ids["_test_email"], "password": new_pw}, timeout=10)
        assert login.status_code == 200, login.text
        created_ids["_test_password"] = new_pw


# ----- branch admin candidates + e2e -----
class TestHRBranchAdminCandidates:
    def test_candidates_lists_new_user(self, admin_client, created_ids):
        uid = created_ids["users"][0]
        r = admin_client.get(f"{API}/v3/hr/branch-admin-candidates", timeout=10)
        assert r.status_code == 200, r.text
        items = r.json()
        found = next((c for c in items if c["id"] == uid), None)
        assert found is not None, "newly-created branch_admin user should appear"
        assert "assigned_branch" in found  # may be None

    def test_e2e_login_with_new_user(self, created_ids):
        login = requests.post(f"{API}/v3/auth/login",
                              json={"email": created_ids["_test_email"],
                                    "password": created_ids["_test_password"]}, timeout=10)
        assert login.status_code == 200, login.text
        body = login.json()
        assert body.get("user", {}).get("role") == "branch_admin"


# ----- delete flows + unlink + cleanup -----
class TestHRDeletion:
    def test_deactivate_user(self, admin_client, created_ids):
        uid = created_ids["users"][1]
        r = admin_client.delete(f"{API}/v3/hr/users/{uid}", timeout=10)
        assert r.status_code == 200
        # Verify is_active=false via list
        all_users = admin_client.get(f"{API}/v3/hr/users", timeout=10).json()
        u = next((x for x in all_users if x["id"] == uid), None)
        assert u is not None and u["is_active"] is False

    def test_delete_employee_deletes_login_and_keeps_history(self, admin_client, created_ids):
        eid = created_ids["employees"][0]
        uid = created_ids["users"][0]
        r = admin_client.delete(f"{API}/v3/hr/employees/{eid}", timeout=10)
        assert r.status_code == 200, r.text
        # The linked login goes with the employee, so Credentials no longer lists it.
        users = admin_client.get(f"{API}/v3/hr/users", timeout=10).json()
        assert not any(x["id"] == uid for x in users)
        # ...and History still has both halves of the person.
        history = admin_client.get(f"{API}/v3/hr/employees/history", timeout=10).json()
        entry = next((h for h in history if h["employee"]["id"] == eid), None)
        assert entry is not None
        assert any(a["id"] == uid for a in entry["accounts"])
        assert entry["deleted_at"] and entry["deleted_by"]["id"]

        # Remove from created lists since deleted
        created_ids["employees"].remove(eid)
        created_ids["users"].remove(uid)

    def test_delete_employee_404(self, admin_client):
        r = admin_client.delete(f"{API}/v3/hr/employees/does-not-exist", timeout=10)
        assert r.status_code == 404

    def test_cleanup(self, admin_client, created_ids):
        _cleanup(admin_client, created_ids)
