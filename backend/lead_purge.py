"""Deleting a patient outright: what goes with them, and whether the button is offered.

Two things live here because they are two halves of one decision.

**The wipe.** Every board in the OS keeps its own trail keyed on `lead_id` — Branch
Leads' activity, remarks and follow-ups, the appointment, Physio's treatment days and
reviews, Diet, Rehab, Zumba, Fitness, the fee reminders raised off the payment plan,
the client portal login, and what the client wrote in feedback and reviews. Deleting
the `leads` row alone leaves every bit of that behind, still pointing at somebody who
is gone: treatment slots on a physio's day list under no name, a portal account that
still signs in, a reminder chasing a fee for nobody. So the lead and its whole trail
go in one call, and the list of collections lives here — one place, read by the single
delete, the branch bulk delete and the org-wide hard delete alike, so the three can
never drift into cleaning up different amounts.

**The switch.** A delete this complete is not something a branch desk should be able to
reach on an ordinary Tuesday without somebody having decided so, and which installs
want it reachable is a question that changes. So it is a developer setting — Super
Admin > Pipeline Stages > Danger Zone — rather than a role: the answer is about this
install, not about a job title. It is on unless switched off, because installs that
predate the switch already had the button and a missing row has to read as the
behaviour they already had.
"""

import os
from typing import List

from database import v3_col
from routers.v3_lead_documents import DOC_DIR

# Every collection that files a document against a lead. Grouped by the board that
# writes it, so a new board's trail has an obvious place to be added.
LEAD_REFERENCING_COLLECTIONS = [
    # Branch Leads' own trail, and the client documents filed against the patient.
    "lead_activity", "lead_followups", "lead_remarks", "lead_documents",
    # The consultation, and the boards that work a patient once it is done. `sessions`
    # also holds auth login tokens, but those carry no lead_id and so can never match.
    "appointments", "sessions", "reviews", "weekly_assessments",
    "package_recommendations", "diet_sessions", "rehab_sessions",
    # Zumba and Fitness: the registration, and the "already offered, they said no" mark
    # that stops the referral being raised at them again.
    "zumba_registrations", "zumba_referral_dismissals",
    "fitness_registrations", "fitness_referral_dismissals",
    # Money still owed: the installment reminders raised off the lead's fee plan. The
    # money already collected is fields on the lead row itself, which goes with it.
    "payment_reminders",
    # What the client wrote and what was written back — the feedback threads, the weekly
    # client reviews, and the marks saying a review was offered and skipped.
    "patient_feedback", "client_reviews", "client_review_skips",
    # The client portal: the login, whatever devices it is signed in on, a signup still
    # waiting to be approved, and the share token the read-only patient view opens on.
    "patient_portal_accounts", "patient_portal_sessions", "portal_pending",
    "patient_tokens",
]


async def _remove_document_files(lead_ids: List[str]) -> None:
    """Unlink the uploaded files themselves, not only the rows that list them.

    A client's scans and reports are bytes in backend/client_documents/ with a row
    pointing at each one. Dropping the rows alone strands the files on disk for good:
    the row was the only record of whose they were, so after it goes nothing lists them
    and nothing will ever clean them up. Runs before the rows are deleted, because it
    reads them to find the filenames.
    """
    rows = await v3_col("lead_documents").find(
        {"lead_id": {"$in": lead_ids}}, {"_id": 0, "stored_name": 1}
    ).to_list(10000)
    for row in rows:
        stored = row.get("stored_name")
        if not stored:
            continue
        try:
            os.remove(os.path.join(DOC_DIR, stored))
        except OSError:
            # Already gone, or the disk refused. The row goes either way: a stranded
            # file is litter, a listed document whose download 404s is a bug report.
            pass


async def delete_lead_trail(lead_ids: List[str]) -> None:
    """Wipe every collection that keys a document off any of these leads.

    Does not touch the `leads` rows themselves — each caller deletes those, because each
    one has its own idea of which leads it is allowed to delete and needs the count back.
    """
    if not lead_ids:
        return
    await _remove_document_files(lead_ids)
    for coll in LEAD_REFERENCING_COLLECTIONS:
        await v3_col(coll).delete_many({"lead_id": {"$in": lead_ids}})
    # A family member's portal sign-in lists every patient it can open under `lead_ids`.
    # Their session is theirs and stays; the patient who is gone comes off its list.
    await v3_col("patient_portal_sessions").update_many(
        {"lead_ids": {"$in": lead_ids}}, {"$pull": {"lead_ids": {"$in": lead_ids}}}
    )


async def sweep_orphaned_trails() -> int:
    """Clear every trail record whose lead no longer exists. Run on every startup.

    The deletes above only clean up after themselves from the day each one called
    `delete_lead_trail`. Anything deleted by a path that did not — the Marketing board's
    delete did not until 2026-09-18 — left its reviews, treatment days and portal login
    behind, still listed under the patient's name on the Review and Physio boards. This
    is what makes such a patient gone after the fact, and keeps any future path that
    forgets from leaving a ghost past the next restart.

    Refuses to run against an empty `leads` collection: on a fresh or half-restored
    database every trail record would look orphaned, and the sweep would take them all.
    """
    if not await v3_col("leads").find_one({}, {"_id": 1}):
        return 0
    live = set(await v3_col("leads").distinct("id"))
    orphaned: set = set()
    for coll in LEAD_REFERENCING_COLLECTIONS:
        # Only rows that name a lead: auth tokens in `sessions`, and any row filed
        # without a patient, carry no lead_id and are not this sweep's business.
        ids = await v3_col(coll).distinct("lead_id", {"lead_id": {"$nin": [None, ""]}})
        orphaned.update(i for i in ids if isinstance(i, str) and i not in live)
    if orphaned:
        await delete_lead_trail(list(orphaned))
    return len(orphaned)


# The Danger Zone row, and what the Branch Leads board asks before drawing its bin icon.
DELETE_BUTTON_SETTING_ID = "lead_delete_button"


async def delete_button_enabled() -> bool:
    """Is the Branch Leads and Pre Sales delete button offered? On unless a developer
    switched it off."""
    row = await v3_col("app_settings").find_one({"id": DELETE_BUTTON_SETTING_ID}, {"_id": 0})
    return True if not row else bool(row.get("enabled", True))
