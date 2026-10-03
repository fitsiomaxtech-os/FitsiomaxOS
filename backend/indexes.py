"""The indexes every board reads through.

The collections were created without any index but `_id_`, which Mongo makes on its own.
Nothing in this codebase looks a document up by `_id`: leads, users, sessions, branches and
the rest all carry their own string `id`, and every query filters on that or on a scoping
field beside it. So every one of them was a full collection scan, and every sort a
in-memory sort of whatever it returned.

Two of those scans ran on *every authenticated request* before the endpoint did any work of
its own — `v3_current_user` looks up the bearer token in `sessions` and then the login in
`users` (see deps.py). A board that fires eight requests to draw itself therefore paid
sixteen collection scans before fetching a single lead, and `sessions` is the collection
that grows with every login for the life of the install.

Called first thing at startup, ahead of the seed and migration passes, so those run through
the indexes too. `create_index` is idempotent: an index that already exists with the same
spec and name is a no-op, so this costs nothing on later boots.

None of these are unique. An index that enforces a constraint would fail to build against
data that already violates it, and a startup that dies on an index is worse than a slow
query — dedupe belongs in a migration that can report what it found, not here.
"""

import logging

from database import v3_col

logger = logging.getLogger(__name__)

# (collection, keys, name). Keys are the pymongo [(field, direction)] form.
#
# Each one is here because a query in this repo actually asks for it; the comment says
# which. Compound keys are ordered equality-first, then the sort, so one index serves both
# halves of the query rather than filtering through the index and sorting in memory.
CORE_INDEXES = [
    # Every authenticated request, before anything else happens. `sessions` holds auth
    # tokens and treatment days in one collection, so this scan grows with both.
    ("sessions", [("token", 1)], "token"),
    # ...and the login behind the token, second half of the same dependency.
    ("users", [("id", 1)], "id"),
    # _stamp_session_progress aggregates a branch's whole board through this, and the
    # physio boards read a patient's days by it.
    ("sessions", [("lead_id", 1)], "lead_id"),
    ("sessions", [("id", 1)], "id"),
    # The Security tab counts an account's live sessions, and changing a password or
    # signing out everywhere else deletes by the same field. Unindexed, each of those
    # scanned a collection that also holds every treatment day on the install.
    ("sessions", [("user_id", 1)], "user_id"),
    # A 2FA code is looked up by its challenge id on every digit typed into a sign-in, and
    # raising one clears the account's open challenges by (user_id, purpose) first.
    ("two_factor_challenges", [("id", 1)], "id"),
    ("two_factor_challenges", [("user_id", 1), ("purpose", 1)], "user_id_purpose"),
    # The other half of a course. Every Branch Leads board runs leads_awaiting_review to
    # decide who is Completed, which reads _course_progress and _completed_day_counts, and
    # both scan rehab_sessions by lead_id -- twice per load, and unindexed it was the whole
    # collection each time even for a branch holding two patients. The Rehab board and
    # _first_session_date read a patient's rehab days by the same key; find_one/update hit
    # the row's own id.
    ("rehab_sessions", [("lead_id", 1)], "lead_id"),
    ("rehab_sessions", [("id", 1)], "id"),
    # leads_awaiting_review again: the closing review it looks for is found by lead_id, once
    # per finished course on every board that shows a Completed pill (Branch Leads, the
    # Consultations board, Physio Master View). Grows with every review ever written, so
    # unindexed this scan got slower for the life of the install. The Review tab's own
    # find_one/update reach a review by its id.
    ("reviews", [("lead_id", 1)], "lead_id"),
    ("reviews", [("id", 1)], "id"),
    # 107 find_one and 58 update_one across the routers, all keyed on the lead's own id.
    ("leads", [("id", 1)], "id"),
    # /branch-board/{branch_id} and /branch-admin/consultations/{branch_id}/board: the same
    # filter and the same sort, so one compound index answers both without a memory sort.
    ("leads", [("branch_id", 1), ("updated_at", -1)], "branch_recent"),
    # The consultations board with branch_id="all" — a Head Physio covers every branch and
    # so filters on the pipeline field alone.
    ("leads", [("consultation_stage", 1)], "consultation_stage"),
    ("leads", [("head_consultation_stage", 1)], "head_consultation_stage"),
    # The Pre-Sales pipeline's own lists.
    ("leads", [("stage", 1)], "stage"),
    # Duplicate detection on import and on Create Lead.
    ("leads", [("phone_normalized", 1)], "phone_normalized"),
    ("leads", [("created_at", -1)], "created_at"),
    ("branches", [("id", 1)], "id"),
    ("doctors", [("id", 1)], "id"),
    ("doctors", [("profile_type", 1)], "profile_type"),
    ("employees", [("id", 1)], "id"),
    ("store_items", [("id", 1)], "id"),
    # A branch's own Services and Products values, laid over the catalogue on every store
    # list and every booking priced at that branch (store_branch_overrides.overlay).
    ("store_item_branch_overrides", [("branch_id", 1), ("item_id", 1)], "branch_item"),
    ("users", [("email", 1)], "email"),
    # _branch_stages / _consultation_stage_names: filter by type, read in order.
    ("pipeline_stages", [("type", 1), ("order", 1)], "type_order"),
    ("pipeline_stages", [("id", 1)], "id"),
    ("appointments", [("id", 1)], "id"),
    ("appointments", [("branch_id", 1), ("slot_time", 1)], "branch_slot"),
    ("appointments", [("lead_id", 1)], "lead_id"),
    ("lead_activity", [("lead_id", 1), ("created_at", -1)], "lead_recent"),
    # A patient's documents, and the one question the Consultation Fee is gated on: the
    # consultations board asks "which of these leads has a prescription" once per load, and
    # collect-package-payment asks it of one lead before it takes any money. Equality on
    # both fields, so the compound key answers either — and the documents tab's own
    # {lead_id} / {lead_id, kind} listings read through its prefix.
    ("lead_documents", [("lead_id", 1), ("kind", 1)], "lead_kind"),
    # Client Portal feedback. Every /patient-portal/me load now reads a patient's threads
    # by lead_id to count unread replies for the Feedback tab's badge, and the tab's own
    # list sorts them newest-first; the branch and head-office boards read by branch_id the
    # same way; a reply reaches one thread by its own id. Grows with every message ever
    # sent, so unindexed each of those was a full scan of the lot.
    ("patient_feedback", [("lead_id", 1), ("created_at", -1)], "lead_recent"),
    ("patient_feedback", [("branch_id", 1), ("created_at", -1)], "branch_recent"),
    ("patient_feedback", [("id", 1)], "id"),
    # The thread a weekly review filed, found again when the client edits that review.
    ("patient_feedback", [("client_review_id", 1)], "client_review"),
    # Client Reviews: one per client, found by lead from the portal and by branch from the
    # management boards.
    ("client_reviews", [("lead_id", 1)], "lead"),
    ("client_reviews", [("branch_id", 1)], "branch"),
    # EOD Reports: one per person per clinic day, read back by day on Super Admin's list.
    ("eod_reports", [("user_id", 1), ("date", 1)], "user_date"),
    ("eod_reports", [("date", 1)], "date"),
    # Client Portal sign-in. A login is matched on phone or on email, and several accounts
    # can share either (one family, one number), so both are scanned rather than found once.
    # The staff panel reaches a patient's account by lead_id, and every portal request
    # resolves its bearer token first.
    ("patient_portal_accounts", [("phone", 1)], "phone"),
    ("patient_portal_accounts", [("email", 1)], "email"),
    ("patient_portal_accounts", [("lead_id", 1)], "lead_id"),
    ("patient_portal_sessions", [("token", 1)], "token"),
    # The approval queue a branch reads on its Patients tab, and the one-open-request-per-
    # patient upsert a booking makes into it; a branch's own automatic-login mode.
    ("portal_pending", [("branch_id", 1), ("status", 1)], "branch_status"),
    ("portal_pending", [("lead_id", 1), ("status", 1)], "lead_status"),
    ("portal_branch_settings", [("branch_id", 1)], "branch_id"),
    # Branch Cash -- see the branch-cash section of routers/v3_finance.py. Every read of a
    # branch's box scans its handovers and its adjustments by branch_id (the adjustments
    # also as a date range, up to a day, for the closing screen), and receiving a handover
    # reaches it by its own id.
    ("cash_handovers", [("branch_id", 1), ("raised_at", -1)], "branch_recent"),
    ("cash_handovers", [("id", 1)], "id"),
    ("cash_adjustments", [("branch_id", 1), ("on", 1)], "branch_on"),
    # HR's running month — see routers/v3_hr_ops.py. `attendance` is the one that matters:
    # saving a register upserts one row per employee on {date, employee_id}, so a clinic of
    # fifty does fifty of these in a call, against a collection that gains fifty rows a day
    # for the life of the install. The month view and payroll both scan {date} as a range,
    # which the same compound key answers through its prefix.
    ("attendance", [("date", 1), ("employee_id", 1)], "date_employee"),
    # _clear_marks, when an approval is revoked or deleted.
    ("attendance", [("approval_id", 1)], "approval_id"),
    # The clock in the header -- see routers/v3_clock.py. Every press reads and writes one
    # person's one document for today, which is this key exactly, and it is read again on
    # every page load by everyone signed in. Their own month scans {user_id} with date as a
    # range, which the same compound key answers through its prefix.
    ("clock_days", [("user_id", 1), ("date", 1)], "user_date"),
    # _clear_marks again, for the other half: a permission hangs its hours on a day's
    # existing row rather than owning one, so taking it back finds them by their own key.
    ("attendance", [("permission_id", 1)], "permission_id"),
    # The approvals list: filtered by status, newest first.
    ("approvals", [("status", 1), ("requested_at", -1)], "status_recent"),
    ("approvals", [("id", 1)], "id"),
    # A person's own leave and permission, read off their profile -- see
    # routers/v3_me.py. Their year is a range scan on from_date within one employee,
    # which this compound key answers, and the same prefix serves the clash check that
    # runs before every leave they raise.
    ("approvals", [("employee_id", 1), ("from_date", -1)], "employee_dates"),
    # A month's payslips, and the single line an adjustment writes to.
    ("payslips", [("month", 1), ("employee_id", 1)], "month_employee"),
    ("payroll_runs", [("month", 1)], "month"),
    ("hr_quotes", [("id", 1)], "id"),
    # payment_reminders.py checks every due installment against what was already sent for
    # it, once an hour.
    ("payment_reminders", [("lead_id", 1), ("fee", 1), ("installment_number", 1)], "lead_fee_installment"),
    # Past Data -- see routers/v3_past_data.py. A client opened from the list is read by its
    # own id, then every course and installment of theirs by client_id.
    ("past_clients", [("id", 1)], "id"),
    ("past_treatments", [("client_id", 1)], "client_id"),
    ("past_payments", [("client_id", 1)], "client_id"),
    # Old clients -- see old_clients.py. The search reads one branch's; a client's balance
    # is summed from every instalment of theirs; and the finance reads take a branch's
    # instalments over a date range.
    ("old_clients", [("branch_id", 1), ("created_at", -1)], "branch_recent"),
    ("old_client_payments", [("old_client_id", 1)], "old_client_id"),
    ("old_client_payments", [("branch_id", 1), ("created_at", -1)], "branch_recent"),
]


async def ensure_core_indexes() -> None:
    """Build the indexes above, one at a time, and keep going if one of them fails.

    A failure here is a slow install, not a broken one — every query still returns the same
    documents without its index. So it is logged and stepped over rather than raised: an
    index that cannot be built (a name already taken by a different spec, a permission the
    deploy user lacks) must not stop the app from starting.
    """
    built = 0
    for collection, keys, name in CORE_INDEXES:
        try:
            await v3_col(collection).create_index(keys, name=name)
            built += 1
        except Exception as e:
            logger.warning(f"index {collection}.{name} not built: {type(e).__name__}: {e}")
    logger.info(f"core indexes ready ({built}/{len(CORE_INDEXES)})")
