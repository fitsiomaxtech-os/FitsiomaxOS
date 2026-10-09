import re
import uuid
from database import db, v2_col, v3_col
from deps import HEAD_PHYSIO_ROLES, LEGACY_CONSULTANT_ROLES, is_hr_role, is_diet_role, is_zumba_role
from utils import PAST_MOVE_FIELD, now_iso, derive_branch_code, generate_patient_number, enquiry_created_at, find_enquiry_stamp
from security import hash_password
from constants import (
    V3_VERTICALS, V3_BRANCH_STAGES, V3_STAGES, V3_CONSULTATION_STAGES, V3_HEAD_CONSULTATION_STAGES,
    BRANCH_ADMIN_ENTRY_STAGE, BRANCH_ADMIN_RNR_STAGE,
    BRANCH_CANCELLED_STAGE, BRANCH_APPOINTMENT_STAGE, BRANCH_NOT_A_PROSPECT_STAGE,
    SALES_STAGE_ROLES_BY_NAME,
    SALES_STAGE_ROLE_CANCELLED,
    SALES_STAGE_ROLE_RNR,
    SALES_STAGE_ROLE_APPOINTMENT,
    SALES_STAGE_ROLE_NOT_A_PROSPECT,
    SALES_ARM_OFFLINE, SALES_ARM_ONLINE,
)
import lead_control
from stage_utils import get_first_stage_name, first_branch_stage_for, realign_branch_stage_leads


# Maps deprecated branch_stage labels (legacy 8-stage flow) to the new flow.
# Idempotent: runs every startup; only touches leads with a legacy value.
_LEGACY_BRANCH_STAGE_MAP = {
    "Call & Confirm": "New Appointment",
    "Qualified": "New Appointment",
    "Head Physio Appointment": "Appointment Date & Time",
    "Consultation Fee Collected": "New Appointment",
    "Consultation Done": "Portfolio",
    "Follow-up Package Upsell": "Follow Up",
    "Package Paid": "Appointment Date & Time",
    "Jr. Physio Assigned": "Appointment Date & Time",
    "Assigned Physio": "Appointment Date & Time",
    "Branch": "Appointment Date & Time",
}

# Maps deprecated pre-sales stage labels → new 4-stage flow. RNR is its own stage
# again (see ensure_rnr_stage below) — no longer mapped away to Follow Up.
_LEGACY_PRESALES_STAGE_MAP = {
    "New Lead": "New Leads",
    "Pre-sales Qualified": "Follow Up",
    "Assigned to Branch": "Appointment",
    "Branch Confirmed": "Appointment",
    "Appointment Booked": "Appointment",
    "Completed": "Appointment",
}


async def migrate_branch_stages() -> None:
    """Map legacy branch_stage and pre-sales stage values to new flows. Safe to re-run."""
    # Resolve the live first "sales" stage name once — Super Admin may have renamed it via
    # Pipeline Stage Management (e.g. "New Appointment" -> "New Leads"), and every legacy
    # mapping below that used to hardcode the literal "New Appointment" must land on whatever
    # that stage is actually called now, or the leads become invisible orphans on the board.
    # Pinned to the Pre-Sales side: the two modes now share order 0, so "the first sales
    # stage" is ambiguous on its own. Legacy leads predate Lead Control and belong on the
    # original entry stage; ensure_branch_admin_stages then rehomes the branch-run ones.
    first_branch_stage = await first_branch_stage_for(lead_control.PRE_SALES, "New Appointment")
    legacy_branch_stage_map = {
        old: (first_branch_stage if new == "New Appointment" else new)
        for old, new in _LEGACY_BRANCH_STAGE_MAP.items()
    }
    # Branch stage migration
    for old, new in legacy_branch_stage_map.items():
        await v3_col("leads").update_many(
            {"branch_stage": old},
            {"$set": {"branch_stage": new, "updated_at": now_iso()}},
        )
    # Remove "Qualified" and "Assigned Physio" from pipeline_stages (sales type)
    await v3_col("pipeline_stages").delete_many({"type": "sales", "name": {"$in": ["Qualified", "Assigned Physio"]}})
    # Pre-sales stage migration
    for old, new in _LEGACY_PRESALES_STAGE_MAP.items():
        await v3_col("leads").update_many(
            {"stage": old},
            {"$set": {"stage": new, "updated_at": now_iso()}},
        )
    # Backfill orphaned leads: the Branch board's own total is every lead with a branch_id
    # assigned (regardless of the pre-sales "stage" field), so any such lead whose branch_stage
    # is empty or doesn't match a currently valid "sales" stage name (e.g. still stuck on a dead
    # literal from before a rename) gets moved onto the live first stage — otherwise it's counted
    # in "All Stages" but invisible in every individual stage pill.
    valid_branch_stages = set(await v3_col("pipeline_stages").distinct("name", {"type": "sales"}))
    if valid_branch_stages:
        # Which entry stage an orphan lands on depends on the branch it belongs to: a branch
        # running its own leads opens at Branch Assign, one fed by Pre-Sales at New Appointment.
        # Grouped by control so this stays two writes rather than one per branch.
        control_map = await lead_control.branch_control_map()
        branches_by_control = {}
        for branch_id, control in control_map.items():
            branches_by_control.setdefault(control, []).append(branch_id)
        for control, branch_ids in branches_by_control.items():
            entry_stage = await first_branch_stage_for(control, first_branch_stage)
            # $nin against names only (not None/"") is deliberate: a missing/None/empty branch_stage
            # is never "in" that list of real names either, so it's naturally caught by this same
            # filter and doesn't need a separate query.
            await v3_col("leads").update_many(
                {"branch_id": {"$in": branch_ids}, "branch_stage": {"$nin": list(valid_branch_stages)}},
                {"$set": {"branch_stage": entry_stage, "updated_at": now_iso()}},
            )
    # Re-seed pipeline_stages of type=sales with the new names if any legacy entries exist.
    legacy_sales = await v3_col("pipeline_stages").find(
        {"type": "sales", "name": {"$in": list(_LEGACY_BRANCH_STAGE_MAP.keys())}},
        {"_id": 0, "id": 1},
    ).to_list(50)
    if legacy_sales:
        await v3_col("pipeline_stages").delete_many({"type": "sales"})
        SALES_COLORS = ["#0ea5e9", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4", "#14b8a6", "#6366f1", "#ef4444"]
        docs = []
        for idx, name in enumerate(V3_BRANCH_STAGES):
            docs.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "color": SALES_COLORS[idx % len(SALES_COLORS)],
                "type": "sales",
                "order": idx,
                "is_final": name in ("Assigned Physio", "Cancelled"),
                "created_at": now_iso(),
            })
        if docs:
            await v3_col("pipeline_stages").insert_many(docs)
    # Re-seed pipeline_stages of type=pre_sales with the new names if any legacy entries exist.
    legacy_pre = await v3_col("pipeline_stages").find(
        {"type": "pre_sales", "name": {"$in": list(_LEGACY_PRESALES_STAGE_MAP.keys())}},
        {"_id": 0, "id": 1},
    ).to_list(50)
    if legacy_pre:
        await v3_col("pipeline_stages").delete_many({"type": "pre_sales"})
        PRESALES_COLORS = ["#0ea5e9", "#ef4444", "#f59e0b", "#22c55e"]
        docs = []
        for idx, name in enumerate(V3_STAGES):
            docs.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "color": PRESALES_COLORS[idx % len(PRESALES_COLORS)],
                "type": "pre_sales",
                "order": idx,
                "is_final": name == "Appointment",
                "created_at": now_iso(),
            })
        if docs:
            await v3_col("pipeline_stages").insert_many(docs)


async def ensure_rnr_stage() -> None:
    """RNR was folded into Follow Up when the pre-sales pipeline was cut down to 3 stages;
    it's back as its own stage between New Leads and Follow Up. Idempotent: only inserts it
    once, shifting every later pre-sales stage's order forward by one to make room. A no-op
    if pre-sales stages haven't been seeded yet (migrate_branch_stages/_ensure_seed already
    build the full V3_STAGES list, RNR included, in that case)."""
    existing = await v3_col("pipeline_stages").find_one({"type": "pre_sales", "name": "RNR"}, {"_id": 0, "id": 1})
    if existing:
        return
    new_leads = await v3_col("pipeline_stages").find_one({"type": "pre_sales", "name": "New Leads"}, {"_id": 0, "order": 1})
    if not new_leads:
        return
    insert_order = new_leads["order"] + 1
    await v3_col("pipeline_stages").update_many(
        {"type": "pre_sales", "order": {"$gte": insert_order}},
        {"$inc": {"order": 1}},
    )
    await v3_col("pipeline_stages").insert_one({
        "id": str(uuid.uuid4()),
        "name": "RNR",
        "color": "#ef4444",
        "type": "pre_sales",
        "order": insert_order,
        "is_final": False,
        "created_at": now_iso(),
    })


async def ensure_sales_stage_roles() -> None:
    """Stamp the behavioural Branch stages with the role that carries their behaviour.

    Four of the sales stages do something rather than merely mark a position: the board
    opens its booking dialog on Appointment, releases the consultation slot on Cancelled,
    reads RNR as "not reached yet", and keeps Portfolio off the strip because it is entered
    from its own scheduling dialog. Every one of those was a comparison against the stage's
    *name*, on both sides of the wire — so renaming one in CI/CD ROOTS did not rename a
    label, it detached the behaviour from the stage and left the booking endpoint rejecting
    the move as an unknown final_stage.

    Matched by name once and only for rows that have no role yet. A stage that already
    carries one is never re-matched, which is the whole point: after this has run, the name
    belongs to Super Admin and the role stays put through every rename.

    Idempotent, and a no-op until the sales stages exist.
    """
    for name, role in SALES_STAGE_ROLES_BY_NAME.items():
        await v3_col("pipeline_stages").update_many(
            {"type": "sales", "name": name, "role": {"$exists": False}},
            {"$set": {"role": role}},
        )


async def ensure_sales_arm_split() -> None:
    """Give the online arm a Branch Lead pipeline of its own, copied from the offline one.

    Until now there was one `sales` list and every branch answered to it, which meant Super
    Admin had one Branch Lead control for a clinic that runs two practices: an online arm
    could not be given a stage the offline branches did not also get, or have one renamed
    without renaming it on the floor as well.

    The split is a copy rather than a fresh shape on purpose. The online arm already has
    live leads standing on these stage names, and seeding it empty -- or with an invented
    pipeline -- would leave every one of them on a stage its board draws no pill for. Copied,
    the day of the split changes nothing anybody can see: both arms read exactly as the one
    list did, and they only diverge when Super Admin edits one of them.

    Roles, colours, order and `applies_to` come across with each stage, so the online copy
    books appointments and frees slots the same way the offline one does.

    Idempotent: keyed on the online side already existing, so it runs once. Must run after
    every pass that shapes the sales list -- it copies whatever they left.
    """
    already = await v3_col("pipeline_stages").count_documents(
        {"type": "sales", "arm": SALES_ARM_ONLINE}
    )
    if already:
        return
    rows = await v3_col("pipeline_stages").find(
        {"type": "sales"}, {"_id": 0}
    ).sort("order", 1).to_list(400)
    if not rows:
        return  # nothing seeded yet; the pipeline passes above build it first
    # The list as it stands becomes the offline arm.
    await v3_col("pipeline_stages").update_many(
        {"type": "sales"}, {"$set": {"arm": SALES_ARM_OFFLINE}}
    )
    copies = []
    for row in rows:
        copy = dict(row)
        copy["id"] = str(uuid.uuid4())
        copy["arm"] = SALES_ARM_ONLINE
        copy["created_at"] = now_iso()
        copies.append(copy)
    await v3_col("pipeline_stages").insert_many(copies)


async def ensure_branch_cancelled_stage() -> None:
    """Give the Branch (sales) pipeline its Cancelled pill, last.

    "Cancelled" has been in V3_BRANCH_STAGES since the beginning, but that list is only
    read when the whole sales pipeline is re-seeded from the built-in defaults -- which has
    not happened on this database in a long time -- so the stage never actually existed as
    a row. The Branch Leads card showed a Cancel pill, but it was the Consultations
    pipeline's, backed by consultation_stage: cancelling a booked appointment moved the
    lead inside a pipeline it had not reached yet and left branch_stage sitting on
    Appointment.

    Last on purpose, and is_final: it is where a lead stops. Placed by reading the highest
    order in the pipeline rather than at a fixed index, since Pipeline Stage Management can
    reorder everything above it.

    No applies_to: a cancelled appointment is a cancelled appointment whether the branch
    runs its own leads or is fed by Pre-Sales, so both modes get the pill.

    Idempotent, and a no-op until the sales stages exist.
    """
    # By role first, then by name for a database stamped before roles existed. Matching on
    # the name alone re-created the stage the moment Super Admin renamed it: the rename
    # succeeded, the next restart found no row called "Cancelled", and the branch ended up
    # with both the renamed stage and a fresh Cancelled beside it.
    existing = await v3_col("pipeline_stages").find_one(
        {"type": "sales", "$or": [
            {"role": SALES_STAGE_ROLE_CANCELLED},
            {"name": BRANCH_CANCELLED_STAGE},
        ]},
        {"_id": 0, "id": 1},
    )
    if existing:
        return
    last = await v3_col("pipeline_stages").find_one(
        {"type": "sales"}, {"_id": 0, "order": 1}, sort=[("order", -1)]
    )
    if not last:
        return
    await v3_col("pipeline_stages").insert_one({
        "id": str(uuid.uuid4()),
        "name": BRANCH_CANCELLED_STAGE,
        # Rose, the colour a stopped thing already wears across these boards.
        "color": "#ef4444",
        "type": "sales",
        "order": (last.get("order") or 0) + 1,
        "is_final": True,
        "role": SALES_STAGE_ROLE_CANCELLED,
        "created_at": now_iso(),
    })


# Recognising one of the behavioural sales stages on a row read straight out of the
# collection. The role where the row carries one, the name it shipped under where it does
# not -- the same two-step the board does in stageHasRole (BranchAdminBoard.jsx), and the
# reason a stage Super Admin has renamed is still found by the passes below rather than
# quietly created a second time beside itself.
def _sales_row_has_role(row: dict, role: str, shipped_name: str) -> bool:
    if row.get("role"):
        return row["role"] == role
    return row.get("name") == shipped_name


async def ensure_branch_not_a_prospect_stage() -> None:
    """Give the Branch (sales) pipeline its "Not a prospect" pill, right after Appointment.

    The branch needs somewhere to put an enquiry that was never a client -- a wrong number,
    a competitor ringing round for prices, somebody outside the catchment, somebody who has
    decided against treatment. Until now the only stage that said anything of the kind was
    Cancelled, which means something else entirely: a real client calling off a real
    appointment, with a slot to hand back and a rebooking to chase. Written off into that
    one, dead leads inflated the cancellation rate and buried the bookings actually worth
    ringing back.

    Positioned against the appointment stage rather than at a fixed index, because that is
    where the branch finds out -- the call is made or the visit is booked, and only then is
    it clear there was nothing here. Pipeline Stage Management can reorder everything around
    it afterwards.

    Not is_final, unlike Cancelled. A final stage is dropped from the strip on a branch
    running its own leads (see leadPillStages), which is exactly the branch that most needs
    to read this list back: Cancelled can afford to lose its pill because cancelling happens
    in the appointment dialog and the pill only ever showed leftovers, while this stage is
    reached from the strip and nowhere else.

    No applies_to: a lead that is not a prospect is not a prospect whether the branch runs
    its own leads or is fed by Pre-Sales, so both modes get the pill.

    Run once per arm, since each Branch pipeline carries its own copy of every stage -- and
    after ensure_sales_arm_split, which would otherwise copy an offline-only insert across
    on the next boot and leave the online arm a boot behind. Idempotent, and a no-op until
    the sales stages exist.
    """
    rows = await v3_col("pipeline_stages").find(
        {"type": "sales"}, {"_id": 0, "name": 1, "order": 1, "arm": 1, "role": 1}
    ).sort("order", 1).to_list(400)
    if not rows:
        return
    # Grouped by arm rather than filtered to the two known ones: a database mid-upgrade
    # still has rows with no arm at all, and those are one shared pipeline that must get
    # the stage exactly once.
    by_arm = {}
    for row in rows:
        by_arm.setdefault(row.get("arm"), []).append(row)

    for arm, arm_rows in by_arm.items():
        if any(
            _sales_row_has_role(r, SALES_STAGE_ROLE_NOT_A_PROSPECT, BRANCH_NOT_A_PROSPECT_STAGE)
            for r in arm_rows
        ):
            continue
        after = next(
            (r for r in arm_rows
             if _sales_row_has_role(r, SALES_STAGE_ROLE_APPOINTMENT, BRANCH_APPOINTMENT_STAGE)),
            None,
        )
        if not after:
            continue  # nothing to position against on this arm
        insert_order = (after.get("order") or 0) + 1
        # `{"arm": None}` matches a missing field as well as a null one in MongoDB, which is
        # what the un-split case needs -- those rows have no `arm` key at all.
        arm_filter = {"arm": arm} if arm else {"arm": None}
        await v3_col("pipeline_stages").update_many(
            {"type": "sales", "order": {"$gte": insert_order}, **arm_filter},
            {"$inc": {"order": 1}},
        )
        doc = {
            "id": str(uuid.uuid4()),
            "name": BRANCH_NOT_A_PROSPECT_STAGE,
            # Slate. Cancelled's rose is the colour of something called off, and this is
            # not that -- grey is the pipeline reading "set aside", and keeps the two
            # endings from looking like one at a glance across the strip.
            "color": "#64748b",
            "type": "sales",
            "order": insert_order,
            "is_final": False,
            "role": SALES_STAGE_ROLE_NOT_A_PROSPECT,
            "created_at": now_iso(),
        }
        if arm:
            doc["arm"] = arm
        await v3_col("pipeline_stages").insert_one(doc)


async def ensure_consultation_booked_stage() -> None:
    """Give the Branch consultation pipeline its opening pill, at the head of the bar.

    Normally this stage is already there under its new name -- migrate_consultation_stages
    renames the old "Follow Up" into it. This is for the pipelines where there is nothing
    to rename: a branch whose Super Admin had deleted that stage from Pipeline Stage
    Management back when it was the nameless one with no pill of its own.

    It cannot be left missing. Booking an appointment in Branch Leads lands a lead on
    whichever stage sits first in this pipeline (see v3_schedule_branch_appointment), so
    without this one the booking goes straight into Consultation Visit -- a patient
    recorded as having attended a consultation nobody has held yet, and the whole reason
    the flow reads wrong from the Consultation tab.

    Inserted at order 0 rather than positioned against a neighbour, because being first IS
    what this stage is: everything else in the pipeline happens after the booking.
    Idempotent, and a no-op until the consultation stages exist.
    """
    existing = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Consultation Booked"}, {"_id": 0, "id": 1}
    )
    if existing:
        return
    # Nothing to be first of yet -- migrate_consultation_stages has not seeded the pipeline.
    # It runs before this on startup, so this only holds on a database with no consultation
    # pipeline at all, where inserting a lone opening stage would be inventing one.
    if await v3_col("pipeline_stages").count_documents({"type": "consultation"}) == 0:
        return
    await v3_col("pipeline_stages").update_many(
        {"type": "consultation"}, {"$inc": {"order": 1}}
    )
    await v3_col("pipeline_stages").insert_one({
        "id": str(uuid.uuid4()),
        "name": "Consultation Booked",
        # Blue, the colour the pipeline's first stage has always been seeded in
        # (CONSULTATION_COLORS[0] in migrate_consultation_stages).
        "color": "#3b82f6",
        "type": "consultation",
        "order": 0,
        "is_final": False,
        "created_at": now_iso(),
    })


async def ensure_rehab_stage() -> None:
    """Give the Branch consultation pipeline its Rehab pill, right after Physio Assign.

    A stage nothing ever writes, exactly like Diet Consultation: a lead belongs under it
    because its Rehab Fee has been collected, not because anyone moved it there — see
    matchesConsultationStage on the frontend. Rehab runs beside the physio pipeline rather
    than inside it, so the lead keeps whatever consultation_stage it actually holds.

    Seeded here rather than added by hand in Pipeline Stage Management so every branch gets
    it without a setup step. Idempotent, and a no-op until the consultation stages exist.
    """
    existing = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Rehab"}, {"_id": 0, "id": 1}
    )
    if existing:
        return
    after = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Physio Assign"}, {"_id": 0, "order": 1}
    )
    if not after:
        return
    insert_order = after["order"] + 1
    await v3_col("pipeline_stages").update_many(
        {"type": "consultation", "order": {"$gte": insert_order}},
        {"$inc": {"order": 1}},
    )
    await v3_col("pipeline_stages").insert_one({
        "id": str(uuid.uuid4()),
        "name": "Rehab",
        # Cyan, the colour the Rehab fee already wears on the Fee Collected panel.
        "color": "#0891b2",
        "type": "consultation",
        "order": insert_order,
        "is_final": False,
        "created_at": now_iso(),
    })


# The two stages that close out a patient's course, in the order they are worked through.
# Both are read off the lead rather than written to it, like Rehab beside them: a patient
# is on the diet list because their diet fee is in and a Nutrition Coach has them, and on
# the completed list because there are no treatment days left. Nothing moves them there.
DIET_STAGE = ("Diet Consultation", "#f97316")
COMPLETED_STAGE = ("Completed", "#059669")


async def ensure_diet_and_completed_stages() -> None:
    """Put Diet Consultation and Completed on the Branch consultation pipeline, after Rehab.

    Two more stages nothing ever writes -- see matchesConsultationStage on the frontend for
    what puts a lead under each. They sit between Rehab and Cancel because that is the order
    a course actually ends in: the physio work finishes, the diet side runs on beside it,
    and Cancel stays last as the thing that is not an ending but an abandonment.

    Positioned against Rehab rather than at a fixed index, since Pipeline Stage Management
    may have moved things. Each is inserted on its own and skipped if already there, so a
    Super Admin who deletes one does not get the other recreated alongside it.
    """
    after = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Rehab"}, {"_id": 0, "order": 1}
    )
    if not after:
        return  # Rehab is seeded first; nothing to position against yet.
    order = after["order"]
    for name, colour in (DIET_STAGE, COMPLETED_STAGE):
        exists = await v3_col("pipeline_stages").find_one(
            {"type": "consultation", "name": name}, {"_id": 0, "id": 1}
        )
        if exists:
            # Still step past it, so the second stage lands after the first rather than
            # on top of it when only one of the two is missing.
            order += 1
            continue
        order += 1
        await v3_col("pipeline_stages").update_many(
            {"type": "consultation", "order": {"$gte": order}},
            {"$inc": {"order": 1}},
        )
        await v3_col("pipeline_stages").insert_one({
            "id": str(uuid.uuid4()),
            "name": name,
            "color": colour,
            "type": "consultation",
            "order": order,
            # Completed is where a patient stops, but it is not final in the pipeline's
            # sense: is_final closes a lead out of the working lists, and a finished course
            # is still a patient the branch may sell another one to.
            "is_final": False,
            "created_at": now_iso(),
        })


async def ensure_diet_chart_stage() -> None:
    """Give the Branch consultation pipeline its Diet Chart pill, right after Diet Consultation.

    A stage nothing ever writes, exactly like Diet Consultation and Rehab beside it: a lead
    belongs under it because their Diet Chart Fee has been collected, not because anyone
    moved them there — see matchesConsultationStage on the frontend. Diet Consultation and
    Diet Chart are two different products a patient can be sold on the same visit (see
    DIET_FEE_KINDS on the frontend), each with its own fee, so they get two separate pills
    rather than one shared between them.

    Positioned against Diet Consultation rather than a fixed index, since Pipeline Stage
    Management may have moved things.

    Seeded here rather than added by hand in Pipeline Stage Management so every branch gets
    it without a setup step. Idempotent, and a no-op until Diet Consultation exists.
    """
    existing = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Diet Chart"}, {"_id": 0, "id": 1}
    )
    if existing:
        return
    after = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Diet Consultation"}, {"_id": 0, "order": 1}
    )
    if not after:
        return
    insert_order = after["order"] + 1
    await v3_col("pipeline_stages").update_many(
        {"type": "consultation", "order": {"$gte": insert_order}},
        {"$inc": {"order": 1}},
    )
    await v3_col("pipeline_stages").insert_one({
        "id": str(uuid.uuid4()),
        "name": "Diet Chart",
        # A lighter orange than Diet Consultation's #f97316, so the two read as the same
        # diet family while still standing apart on the bar.
        "color": "#fb923c",
        "type": "consultation",
        "order": insert_order,
        "is_final": False,
        "created_at": now_iso(),
    })


# Words that show up in a lead source's free-typed name purely as decoration ("Physio
# Parrys", "Anna Nagar _ Physiotherphy") and would otherwise stop it from being recognised
# as belonging to "Parrys Branch" / "Anna Nagar Branch". Stripped from both sides before
# comparing, so only the part that actually names the place is left to match on. Includes
# the misspellings already living in the data (Physiotherphy, Physiotheraphy) rather than
# correcting them — this is read-only matching, not a spellcheck.
_LEAD_SOURCE_NAME_FILLER = {"branch", "physio", "physiotherapy", "physiotherphy", "physiotheraphy", "online"}


def _lead_source_core_tokens(name: str) -> set:
    words = re.findall(r"[a-z]{2,}", str(name or "").lower().replace("_", " "))
    return {w for w in words if w not in _LEAD_SOURCE_NAME_FILLER}


def _lead_source_branch_ids(source: dict) -> list:
    ids = source.get("branch_ids")
    if ids is not None:
        return ids
    legacy = source.get("branch_id")
    return [legacy] if legacy else []


def _default_lead_source_doc(branch_id: str, branch_name: str) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "name": branch_name,
        "source_type": "google_sheets",
        "sheet_url": "",
        "spreadsheet_id": "",
        "sheet_name": "Sheet1",
        "sheet_names": ["Sheet1"],
        "column_mapping": {},
        "custom_fields": [],
        "headers_detected": [],
        "branch_ids": [branch_id],
        "verticals": [],
        "row_count": 0,
        "last_synced": None,
        "is_active": True,
        "is_archived": False,
        "created_at": now_iso(),
    }


async def create_default_lead_source(branch_id: str, branch_name: str) -> None:
    """Give a brand-new branch its own Lead Source card the moment it's created.

    Called from every branch-creation route (v3_config.v3_create_branch,
    v3_branch_mgmt.create_branch_with_existing_admin) rather than left for the next
    server restart to pick up via ensure_branch_lead_sources below — a branch opened this
    afternoon should show up on Marketing > Lead Sources this afternoon, not after the next
    deploy. Unlinked until someone pastes its Google Sheet into Edit Source; nothing here
    invents a spreadsheet that doesn't exist yet.

    Idempotent: a branch id can only reach this twice if something calls it twice, and the
    check below makes the second call a no-op instead of a duplicate card.
    """
    exists = await v3_col("marketing_sources").find_one({"branch_ids": [branch_id]}, {"_id": 0, "id": 1})
    if exists:
        return
    await v3_col("marketing_sources").insert_one(_default_lead_source_doc(branch_id, branch_name))


async def sync_lead_source_branch_name(branch_id: str, branch_name: str) -> None:
    """Keep a branch's Lead Source card's name in step when the branch itself is renamed.

    Called from v3_config.v3_update_branch whenever branch_name is part of the update.
    The card's name is never editable on its own (see update_source in v3_marketing,
    which drops "name" from every PATCH) specifically so that Branch Manager stays the
    one place a rename actually happens — this is the other half of that: the rename
    still has to reach the card somehow.
    """
    await v3_col("marketing_sources").update_one(
        {"branch_ids": [branch_id]}, {"$set": {"name": branch_name}}
    )


async def ensure_branch_lead_sources() -> None:
    """One Lead Source card per branch, named after the branch and tagged to it.

    Branch Manager (Operations > Branch) is what drives which cards exist on
    Marketing > Lead Sources now, not a Super Admin picking a name and ticking branch
    boxes by hand in an Add Source popup — see MarketingBoard's SourcesTab, which no
    longer offers one. This is the startup half of that: it reconciles whatever the
    marketing_sources collection already holds against the current branch list, every
    time the server starts (deploys happen on every push here, so this runs often and
    has to be safe to run every time).

    Three passes:
      1. A branch already tied to exactly one source (branch_ids == [branch.id]) just
         gets that source's name straightened to match — everything else it carries
         (its Google Sheet, column mapping, auto-sync settings) is untouched.
      2. A branch still unmatched is checked against every source that isn't tied to any
         branch, by name (see _lead_source_core_tokens) — this is what turns "Physio
         Parrys" into Parrys Branch's own card, sheet and all, on the very first run
         instead of leaving it an orphan beside a freshly-created empty one.
      3. Any source nobody claimed — including one tagged to several branches or a
         vertical, which no longer fits a one-card-per-branch model — is archived, not
         deleted: still there under Archived if the branch/sheet pairing needs sorting
         out by hand. A branch nothing claimed gets a fresh, unlinked card.
    """
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1}).to_list(500)
    sources = await v3_col("marketing_sources").find({}, {"_id": 0}).to_list(500)

    claimed_source_ids = set()
    branch_to_source = {}

    for branch in branches:
        match = next((s for s in sources if _lead_source_branch_ids(s) == [branch["id"]]), None)
        if match:
            branch_to_source[branch["id"]] = match
            claimed_source_ids.add(match["id"])

    for branch in branches:
        if branch["id"] in branch_to_source:
            continue
        branch_tokens = _lead_source_core_tokens(branch["branch_name"])
        if not branch_tokens:
            continue
        candidate = next(
            (
                s for s in sources
                if s["id"] not in claimed_source_ids
                and not _lead_source_branch_ids(s)
                and _lead_source_core_tokens(s.get("name")) & branch_tokens
            ),
            None,
        )
        if candidate:
            branch_to_source[branch["id"]] = candidate
            claimed_source_ids.add(candidate["id"])

    for branch in branches:
        match = branch_to_source.get(branch["id"])
        if not match:
            await v3_col("marketing_sources").insert_one(_default_lead_source_doc(branch["id"], branch["branch_name"]))
            continue
        updates = {}
        if match.get("name") != branch["branch_name"]:
            updates["name"] = branch["branch_name"]
        if _lead_source_branch_ids(match) != [branch["id"]]:
            updates["branch_ids"] = [branch["id"]]
        if match.get("is_archived"):
            updates["is_archived"] = False
        if updates:
            await v3_col("marketing_sources").update_one({"id": match["id"]}, {"$set": updates})

    for s in sources:
        if s["id"] not in claimed_source_ids and not s.get("is_archived"):
            await v3_col("marketing_sources").update_one({"id": s["id"]}, {"$set": {"is_archived": True}})


async def retire_consultation_completed_stage() -> None:
    """Take the Consultation Completed pill off the Branch consultation pipeline.

    Not a deletion of what it meant. A Consultation Only patient -- fee paid, no treatment
    -- is still marked done through the same route and still carries the same
    consultation_stage; the dashboard's Patient count still reads it. What goes is the pill,
    because Completed beside it now takes those patients in along with everybody who
    finished a course, and two stages for "there is nothing left to attend" is one more
    than a branch can act on.

    The stage value is left on every lead that holds it. It is data about what happened,
    and rewriting it would lose the difference between a patient who finished treatment and
    one who never had any.
    """
    await v3_col("pipeline_stages").delete_one(
        {"type": "consultation", "name": "Consultation Completed"}
    )


async def ensure_branch_admin_stages() -> None:
    """Give the Branch pipeline its Branch-Admin-only opening: Branch Assign, then RNR.

    A branch fed by the Pre-Sales desk receives leads already qualified and booked, so its
    board opens at "New Appointment". A branch running its own leads receives them raw and
    has to work them itself, so it opens at "Branch Assign" and needs somewhere to park the
    calls nobody picks up. Both shapes share one `sales` stage list and are told apart by
    `applies_to` (see constants.py), which is why this inserts stages rather than renaming
    the existing one — a rename would drag every Pre-Sales branch along with it.

    Idempotent: kept as a no-op once Branch Assign exists, so a Super Admin who later
    renames or deletes either stage does not get it silently recreated on next boot.
    """
    existing = await v3_col("pipeline_stages").find_one(
        {"type": "sales", "applies_to": lead_control.BRANCH_ADMIN}, {"_id": 0, "id": 1}
    )
    if existing:
        return
    # Position both new stages against whatever the current entry stage is, rather than
    # against the literal "New Appointment" — Pipeline Stage Management may have renamed it.
    entry = await v3_col("pipeline_stages").find(
        {"type": "sales"}, {"_id": 0, "id": 1, "name": 1, "order": 1}
    ).sort("order", 1).limit(1).to_list(1)
    if not entry:
        return  # stages not seeded yet; _ensure_seed builds the list first
    entry_stage = entry[0]
    entry_order = entry_stage["order"]

    # The stage that was global until now becomes the Pre-Sales-side entry only. Every
    # later stage (Follow Up onwards) stays shared and just shifts to make room for RNR.
    await v3_col("pipeline_stages").update_one(
        {"id": entry_stage["id"]}, {"$set": {"applies_to": lead_control.PRE_SALES}}
    )
    await v3_col("pipeline_stages").update_many(
        {"type": "sales", "order": {"$gt": entry_order}}, {"$inc": {"order": 1}}
    )
    await v3_col("pipeline_stages").insert_many([
        {
            "id": str(uuid.uuid4()),
            "name": BRANCH_ADMIN_ENTRY_STAGE,
            "color": "#0ea5e9",
            "type": "sales",
            # Shares the entry slot with the Pre-Sales stage it stands in for: only one of
            # the two is ever visible to a given branch, so they never collide on a board.
            "order": entry_order,
            "is_final": False,
            "applies_to": lead_control.BRANCH_ADMIN,
            "created_at": now_iso(),
        },
        {
            "id": str(uuid.uuid4()),
            "name": BRANCH_ADMIN_RNR_STAGE,
            "color": "#ef4444",
            "type": "sales",
            "order": entry_order + 1,
            "is_final": False,
            "applies_to": lead_control.BRANCH_ADMIN,
            "role": SALES_STAGE_ROLE_RNR,
            "created_at": now_iso(),
        },
    ])

    # Branches already switched to Branch Admin have a backlog sitting on the stage that
    # just became Pre-Sales-only — it would vanish from their board otherwise.
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "lead_control": 1}).to_list(1000)
    for branch in branches:
        if lead_control.normalize(branch.get("lead_control")) == lead_control.BRANCH_ADMIN:
            await realign_branch_stage_leads(branch["id"], lead_control.BRANCH_ADMIN)


# The stage briefly promoted from the mirrored "Leads" pill into a real branch stage, and
# rolled back again. Named here rather than in constants.py because nothing but the rollback
# below refers to it any more.
_ROLLED_BACK_LEADS_STAGE = "Leads"


async def undo_branch_leads_stage() -> None:
    """Take the Branch pipeline back off the real "Leads" stage, leaving the mirrored pill.

    Reverting that change in code is not enough on its own: the stage row and the leads
    moved onto it are still in the database, and the mirrored pill this code draws is also
    called "Leads" — so the board would render the pair of them, two pills with one name and
    the branch's leads split across both. This puts the data back to match the code.

    Idempotent, and a no-op on any database that never took the change.
    """
    leads_stage = await v3_col("pipeline_stages").find_one(
        {"type": "sales", "name": _ROLLED_BACK_LEADS_STAGE}, {"_id": 0, "id": 1, "order": 1}
    )
    if not leads_stage:
        return
    # Back where they were: everything on Leads arrived by import and was moved off Branch
    # Assign by the change now being undone.
    await v3_col("leads").update_many(
        {"branch_stage": _ROLLED_BACK_LEADS_STAGE},
        {"$set": {"branch_stage": BRANCH_ADMIN_ENTRY_STAGE, "updated_at": now_iso()}},
    )
    await v3_col("pipeline_stages").delete_one({"id": leads_stage["id"]})
    # Close the gap it left, so Branch Assign is back at the head of the pipeline.
    await v3_col("pipeline_stages").update_many(
        {"type": "sales", "order": {"$gt": leads_stage["order"]}}, {"$inc": {"order": -1}}
    )
    # `entry` only ever existed to tell the two openings apart. With one opening again,
    # nothing reads it, and leaving it behind would mislead the next person to look.
    await v3_col("pipeline_stages").update_many({"type": "sales"}, {"$unset": {"entry": ""}})
    # The catch-up that filled Leads from Pre-Sales New Leads is a one-shot, and its marker
    # outlives the code being reverted. Left behind, it would sit there claiming the work was
    # already done and quietly stop that migration ever running again if it is reapplied.
    await v3_col("migrations").delete_one({"name": "backfill_leads_stage_from_presales"})


# Maps deprecated consultation_stage labels (legacy 6-stage flow) to the new 7-stage flow.
# Idempotent: runs every startup; only touches leads with a legacy value.
_LEGACY_CONSULTATION_STAGE_MAP = {
    "Clinic Visit": "Consultation Visit",
    "Package Chosen": "Fee Collected",
    "Completed": "Fee Collected",
    "Cancelled": "Cancel",
    "Consultation Fee": "Fee Collected",
    "Treatment Fee": "Physio Assign",
    "Consultation Fee Collected": "Fee Collected",
    "Treatment Fee Collected": "Physio Assign",
    # RNR folded into the pipeline's opening stage when it was retired, and follows that
    # stage through its rename rather than naming a stage that no longer exists.
    "RNR": "Consultation Booked",
}

# Deliberately NOT a _LEGACY_CONSULTATION_STAGE_MAP entry, even though it is a rename like
# every other line in it. That map is also the trigger for a full re-seed: finding any of
# its keys as a live pipeline_stages doc deletes the whole consultation stage list and
# rebuilds it from V3_CONSULTATION_STAGES, which would take Rehab, Diet Consultation, Diet
# Chart and Completed down with it -- and every colour, order or label Super Admin has set
# on the stages that survive. This is one stage being renamed in place, so it renames one
# stage in place.
_RENAMED_CONSULTATION_ENTRY = ("Follow Up", "Consultation Booked")


async def migrate_consultation_stages() -> None:
    """Map legacy consultation_stage values to the new flow and (re)seed pipeline_stages
    of type=consultation. Safe to re-run."""
    for old, new in _LEGACY_CONSULTATION_STAGE_MAP.items():
        await v3_col("leads").update_many(
            {"consultation_stage": old},
            {"$set": {"consultation_stage": new, "updated_at": now_iso()}},
        )
    legacy = await v3_col("pipeline_stages").find(
        {"type": "consultation", "name": {"$in": list(_LEGACY_CONSULTATION_STAGE_MAP.keys())}},
        {"_id": 0, "id": 1},
    ).to_list(50)
    existing_count = await v3_col("pipeline_stages").count_documents({"type": "consultation"})
    if legacy or existing_count == 0:
        await v3_col("pipeline_stages").delete_many({"type": "consultation"})
        CONSULTATION_COLORS = ["#3b82f6", "#f43f5e", "#f97316", "#8b5cf6", "#14b8a6", "#22c55e", "#64748b"]
        docs = []
        for idx, name in enumerate(V3_CONSULTATION_STAGES):
            docs.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "color": CONSULTATION_COLORS[idx % len(CONSULTATION_COLORS)],
                "type": "consultation",
                "order": idx,
                "is_final": name in ("Physio Assign", "Consultation Completed", "Cancel"),
                "created_at": now_iso(),
            })
        if docs:
            await v3_col("pipeline_stages").insert_many(docs)

    # Retire Consultation Pack as a separate stage on Branch's own consultation pipeline —
    # the flow now connects directly Consultation Visit -> Consultation Fee. Backfill any
    # lead still sitting on it first (to Consultation Fee, the natural next stage), so
    # nothing goes orphaned once the stage doc is removed. Unconditional/safe to re-run
    # (not gated behind an existence check beyond the deletion itself, so a lead that ends
    # up on this dead value later — e.g. via a stale client — still gets corrected).
    await v3_col("leads").update_many(
        {"consultation_stage": "Consultation Pack"},
        {"$set": {"consultation_stage": "Fee Collected", "updated_at": now_iso()}},
    )
    await v3_col("pipeline_stages").delete_many({"type": "consultation", "name": "Consultation Pack"})

    # Retire "New Appointment" from Branch's own consultation pipeline — consultations
    # now begin at Consultation Booked (renamed from Follow Up just below, which is why the
    # backfill names the new label). Backfill any lead still sitting on it first so nothing is
    # orphaned, then drop the stage doc. Scoped to type="consultation" only: the Head
    # Physio's independent pipeline keeps its own New Appointment stage.
    await v3_col("leads").update_many(
        {"consultation_stage": "New Appointment"},
        {"$set": {"consultation_stage": "Consultation Booked", "updated_at": now_iso()}},
    )
    await v3_col("pipeline_stages").delete_many({"type": "consultation", "name": "New Appointment"})

    # Rename that opening stage "Follow Up" -> "Consultation Booked". In place, so the
    # stage keeps its id, its order at the head of the pipeline and whatever colour Super
    # Admin gave it -- a delete-and-insert would move it to the end and orphan every lead
    # standing on it in the gap.
    #
    # Why at all: see V3_CONSULTATION_STAGES in constants.py. The Branch pipeline has a
    # "Follow Up" of its own, and a name shared between the two pipelines gets a single
    # pill on the Branch side -- so this stage, which is where booking an appointment puts
    # a lead, had no pill on the Consultation tab and every freshly booked patient landed
    # somewhere that tab could not show.
    #
    # The leads move first. Between the two writes a lead may briefly hold a stage name
    # nothing matches; doing them the other way round would leave leads on "Follow Up"
    # after the stage doc had already stopped being called that, and the orphan backfill at
    # the end of this function would sweep them somewhere else entirely.
    _from, _to = _RENAMED_CONSULTATION_ENTRY
    await v3_col("leads").update_many(
        {"consultation_stage": _from},
        {"$set": {"consultation_stage": _to, "updated_at": now_iso()}},
    )
    _old_stage = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": _from}, {"_id": 0, "id": 1, "order": 1}
    )
    if _old_stage:
        _already = await v3_col("pipeline_stages").find_one(
            {"type": "consultation", "name": _to}, {"_id": 0, "id": 1}
        )
        if _already:
            # Both names live at once — a Super Admin added the new stage by hand before
            # this ran. Renaming into it would put two identically named pills on the bar,
            # each claiming the same leads. The leads are already on the new name (moved
            # above), so the old doc has nothing left to hold: drop it and close the gap it
            # leaves, rather than leaving a hole in the order the next insert positions
            # itself against.
            await v3_col("pipeline_stages").delete_one({"id": _old_stage["id"]})
            await v3_col("pipeline_stages").update_many(
                {"type": "consultation", "order": {"$gt": _old_stage["order"]}},
                {"$inc": {"order": -1}},
            )
        else:
            await v3_col("pipeline_stages").update_one(
                {"id": _old_stage["id"]}, {"$set": {"name": _to}}
            )

    # Additive: make sure newer consultation stages (added after the initial seed) exist too,
    # without disturbing any Super Admin edits (color/order/rename) made to the existing ones.
    existing_names = set(await v3_col("pipeline_stages").find(
        {"type": "consultation"}, {"_id": 0, "name": 1}
    ).distinct("name"))
    new_stage_specs = [(name, color) for name, color in
                        [("Physio Assign", "#a855f7")]
                        if name not in existing_names]
    if new_stage_specs:
        anchor = await v3_col("pipeline_stages").find_one(
            {"type": "consultation", "name": "Consultation Visit"}, {"_id": 0, "order": 1}
        )
        if anchor is not None:
            await v3_col("pipeline_stages").update_many(
                {"type": "consultation", "order": {"$gt": anchor["order"]}},
                {"$inc": {"order": len(new_stage_specs)}},
            )
            base_order = anchor["order"] + 1
        else:
            last = await v3_col("pipeline_stages").find(
                {"type": "consultation"}, {"_id": 0, "order": 1}
            ).sort("order", -1).limit(1).to_list(1)
            base_order = (last[0]["order"] + 1) if last else 0
        docs = [{
            "id": str(uuid.uuid4()),
            "name": name,
            "color": color,
            "type": "consultation",
            "order": base_order + idx,
            "is_final": False,
            "created_at": now_iso(),
        } for idx, (name, color) in enumerate(new_stage_specs)]
        await v3_col("pipeline_stages").insert_many(docs)

    # Reorder: Physio Assign now happens after fee collection, not before — a physio
    # shouldn't be assigned to deliver sessions until payment is settled. Only re-order
    # if it's still positioned before Fee Collected, so a Super Admin who deliberately
    # moved it elsewhere isn't fought on restart.
    physio_assign = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Physio Assign"}, {"_id": 0, "order": 1}
    )
    treatment_fee = await v3_col("pipeline_stages").find_one(
        {"type": "consultation", "name": "Fee Collected"}, {"_id": 0, "order": 1}
    )
    if physio_assign and treatment_fee and physio_assign["order"] < treatment_fee["order"]:
        old_order, new_order = physio_assign["order"], treatment_fee["order"]
        await v3_col("pipeline_stages").update_many(
            {"type": "consultation", "order": {"$gt": old_order, "$lte": new_order}},
            {"$inc": {"order": -1}},
        )
        await v3_col("pipeline_stages").update_one(
            {"type": "consultation", "name": "Physio Assign"},
            {"$set": {"order": new_order, "is_final": True}},
        )

    # Backfill orphaned leads: any lead with a consultation_stage set that no longer matches a
    # currently valid stage name (e.g. still stuck on a legacy/dead literal, or Super Admin
    # renamed the first stage) gets moved onto the live first stage — otherwise it's counted in
    # "All Stages" but invisible in every individual stage pill.
    valid_consultation_stages = set(await v3_col("pipeline_stages").distinct("name", {"type": "consultation"}))
    if valid_consultation_stages:
        first_consultation_stage = await get_first_stage_name("consultation", "Consultation Booked")
        await v3_col("leads").update_many(
            {"consultation_stage": {"$ne": None, "$nin": list(valid_consultation_stages)}},
            {"$set": {"consultation_stage": first_consultation_stage, "updated_at": now_iso()}},
        )


async def migrate_head_consultation_stages() -> None:
    """Seed the standalone Head Physio consultation pipeline (type=head_consultation,
    lead field=head_consultation_stage) — fully independent from Branch's own
    consultation_stage pipeline. Safe to re-run."""
    existing_count = await v3_col("pipeline_stages").count_documents({"type": "head_consultation"})
    if existing_count == 0:
        HEAD_CONSULTATION_COLORS = ["#3b82f6", "#0ea5e9", "#8b5cf6", "#a855f7"]
        docs = []
        for idx, name in enumerate(V3_HEAD_CONSULTATION_STAGES):
            docs.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "color": HEAD_CONSULTATION_COLORS[idx % len(HEAD_CONSULTATION_COLORS)],
                "type": "head_consultation",
                "order": idx,
                "is_final": name in ("Consultation Visit",),
                "created_at": now_iso(),
            })
        if docs:
            await v3_col("pipeline_stages").insert_many(docs)

    # Retire Consultation Pack / Physio Assign as separate stages on Head Physio's own
    # pipeline — package selection is now an inline part of the lead popup (not a stage
    # move), and physio assignment moved entirely to Branch Admin's board (after
    # Treatment Fee). Backfill any lead still sitting on one of these first, so nothing
    # goes orphaned once the stage itself is removed.
    retired_names = ["Consultation Pack", "Physio Assign"]
    retired = await v3_col("pipeline_stages").find(
        {"type": "head_consultation", "name": {"$in": retired_names}}, {"_id": 0, "id": 1}
    ).to_list(10)
    if retired:
        await v3_col("leads").update_many(
            {"head_consultation_stage": {"$in": retired_names}},
            {"$set": {"head_consultation_stage": "Consultation Visit", "updated_at": now_iso()}},
        )
        await v3_col("pipeline_stages").delete_many({"type": "head_consultation", "name": {"$in": retired_names}})

    # Correction (unconditional, safe to re-run): the backfill above only touched
    # head_consultation_stage, so any lead it moved to Consultation Visit could be left
    # showing an earlier Branch stage (e.g. still "New Appointment") even though the
    # doctor's own board says they're already at Consultation Visit or beyond. Advance
    # Branch's own consultation_stage to match for any lead that's behind — but never
    # regress one that's already further along (or cancelled) on Branch's side.
    branch_stage_order = [
        r["name"] for r in await v3_col("pipeline_stages").find(
            {"type": "consultation"}, {"_id": 0, "name": 1}
        ).sort("order", 1).to_list(50)
    ]
    if "Consultation Visit" in branch_stage_order:
        behind_stages = branch_stage_order[:branch_stage_order.index("Consultation Visit")]
        await v3_col("leads").update_many(
            {
                "head_consultation_stage": "Consultation Visit",
                "consultation_stage": {"$in": behind_stages + [None]},
            },
            {"$set": {"consultation_stage": "Consultation Visit", "updated_at": now_iso()}},
        )


SESSION_ITEM_RATE_PER_SESSION_ONLINE = 1200
SESSION_ITEM_RATE_PER_SESSION_OFFLINE = 800


# The shelves whose price is a whole course rather than a per-session rate.
#
# Zumba is sold as a membership -- 12 classes a month, priced by the month -- Rehab as one
# 26-session programme at one price, and Fitness as a month at the gym, 26 sessions for
# what the month costs. Not one of the three is a per-session rate, so the flat rate below
# is not their rate and never was. Forcing it on Zumba rewrote a Rs.3,000 membership as
# Rs.9,600 (12 x 800) on the next restart, which is what "the fees keep changing" was: not
# the form, this migration, running on every boot.
#
# Fitness was left off this list and got the same treatment from the other side. Its rows
# hold the month as it stands, so the pass did not multiply the price out -- it wrote the
# per-session rate straight over the month, turning an 18,000 Personal Training and a
# 14,000 Group Training into Rs.800 apiece -- on the same startup that seeded them, since
# the pass runs a line after the seed, and again on every one since. That is what the
# Sessions > Fitness cards were reading as "26 Sessions" for "Rs.800".
#
# Kept as categories rather than as a flag on the item, because it is the shelf that is
# sold this way, not the individual row -- a new Zumba membership must be exempt the moment
# it is created, without anyone remembering to mark it.
COURSE_PRICED_CATEGORIES = ("zumba", "rehab", "fitness")

# Home Visit's two shelves (Consultant and Physiotherapy). A visit to somebody's house is
# priced by Super Admin package by package -- a Standard visit and a Distance visit are not
# the same trip -- so the flat per-session rate below is not theirs either. Left in, the
# pass put every one of them back to Rs.800 on each restart, which is what "I changed it to
# 1600 and it went back to 800" was.
HOME_VISIT_CATEGORIES = ("home_visit", "home_visit_consultation")


async def _home_visit_item_ids() -> set:
    rows = await v3_col("store_items").find(
        {"category": {"$in": list(HOME_VISIT_CATEGORIES)}},
        {"_id": 0, "id": 1},
    ).to_list(500)
    return {r["id"] for r in rows}


async def _course_priced_item_ids() -> set:
    rows = await v3_col("store_items").find(
        {"item_type": "session", "category": {"$in": list(COURSE_PRICED_CATEGORIES)}},
        {"_id": 0, "id": 1},
    ).to_list(500)
    return {r["id"] for r in rows}


# The gym sells two things and no more: one trainer to yourself, or the room. Both run
# twenty-six sessions a month and both are priced as the month, not per session.
FITNESS_PACKAGES = (
    {"name": "Personal Training", "price": 18000.0},
    {"name": "Group Training", "price": 14000.0},
)
FITNESS_SESSIONS_PER_MONTH = 26


async def ensure_fitness_packages() -> None:
    """Put the gym's two packages on the shelf, and only those two.

    Fitness is not a catalogue anybody composes -- it is Personal Training or Group
    Training, at a standard monthly price, and a branch registering somebody picks one of
    the two. Seeding them means the shelf is never empty on a fresh install and never
    depends on somebody remembering the figures.

    Created if missing and left alone if present, matched on the name: a price the Super
    Admin has deliberately corrected is theirs to keep, and rewriting it on every restart
    would make the form a suggestion box. The same price is written to both modes because
    the gym is a room somebody comes to -- there is no online rate to be different.
    """
    for plan in FITNESS_PACKAGES:
        existing = await v3_col("store_items").find_one(
            {"item_type": "session", "category": "fitness", "name": plan["name"]},
            {"_id": 0, "id": 1},
        )
        if existing:
            continue
        now = now_iso()
        await v3_col("store_items").insert_one({
            "id": str(uuid.uuid4()),
            "item_type": "session",
            "category": "fitness",
            "name": plan["name"],
            "description": f"{FITNESS_SESSIONS_PER_MONTH} sessions a month",
            "image_url": None,
            "price_online": plan["price"],
            "price_offline": plan["price"],
            "duration_minutes": 60,
            "sessions_online": FITNESS_SESSIONS_PER_MONTH,
            "sessions_offline": FITNESS_SESSIONS_PER_MONTH,
            # The figure above is the month, not a rate to multiply out. Kept in step with
            # PRICE_IS_TOTAL_CATEGORIES in routers/v3_store.py.
            "price_is_total": True,
            "created_at": now,
            "updated_at": now,
        })


async def repair_flattened_fitness_prices() -> None:
    """Put back the two gym prices that the flat-rate pass overwrote.

    Fitness was missing from COURSE_PRICED_CATEGORIES, so normalize_session_item_prices()
    reached its rows on every boot and wrote the per-session rate straight over the month:
    Personal Training at 18,000 and Group Training at 14,000 both came out as 800 offline
    and 1,200 online. The rows carry price_is_total, so the card then read that 800 as the
    whole 26-session month, and two packages that cost different amounts showed the same
    figure. The exemption above stops it happening again; this puts back what it took.

    Only a row still holding the flat rate exactly is written. That figure is the
    overwrite's own signature -- 800 for a month of twenty-six sessions is not a price
    anybody quoted -- and a price the Super Admin has since typed is some other number,
    left alone. Which is also what makes this safe on every boot rather than once.
    """
    for plan in FITNESS_PACKAGES:
        item = await v3_col("store_items").find_one(
            {"item_type": "session", "category": "fitness", "name": plan["name"]},
            {"_id": 0, "id": 1, "price_online": 1, "price_offline": 1},
        )
        if not item:
            continue
        updates = {}
        if item.get("price_offline") == SESSION_ITEM_RATE_PER_SESSION_OFFLINE:
            updates["price_offline"] = plan["price"]
        if item.get("price_online") == SESSION_ITEM_RATE_PER_SESSION_ONLINE:
            updates["price_online"] = plan["price"]
        if updates:
            # Restated rather than assumed: a row the flat-rate pass had hold of is a row
            # whose price is being read as a month again, and the mark is what says so.
            updates["price_is_total"] = True
            updates["updated_at"] = now_iso()
            await v3_col("store_items").update_one({"id": item["id"]}, {"$set": updates})


async def migrate_course_prices_to_totals() -> None:
    """Move course-priced packages from a per-session rate to the total they were typed as.

    Rehab and Fitness are both entered by hand now: what the Super Admin types is what is
    stored, shown and charged, with nothing in between. Rows written before that hold the
    total divided by the session count — 31,200 kept as 1,200 — so they are multiplied back
    out once and marked, and the readers use the figure as it stands from then on.

    Kept in step with PRICE_IS_TOTAL_CATEGORIES in routers/v3_store.py, which decides the
    same thing for rows written from now on. A shelf added there and not here would leave
    its existing rows reading as course totals while still holding rates.

    Idempotent by the mark rather than by the value: an already-converted row is
    indistinguishable from an unconverted one by price alone, and a second pass would
    multiply a course total by its session count and sell 26 sessions for 811,200.

    A row with no session count is left exactly as it is. There is nothing to multiply by,
    and inventing a multiplier here would be putting a number on a course nobody quoted.
    """
    items = await v3_col("store_items").find(
        {"item_type": "session", "category": {"$in": ["rehab", "fitness"]}, "price_is_total": {"$ne": True}},
        {"_id": 0},
    ).to_list(500)
    for item in items:
        updates = {"price_is_total": True, "updated_at": now_iso()}
        online_sessions = item.get("sessions_online")
        offline_sessions = item.get("sessions_offline")
        if online_sessions and item.get("price_online") is not None:
            updates["price_online"] = round(item["price_online"] * online_sessions, 2)
        if offline_sessions and item.get("price_offline") is not None:
            updates["price_offline"] = round(item["price_offline"] * offline_sessions, 2)
        await v3_col("store_items").update_one({"id": item["id"]}, {"$set": updates})


async def flag_manual_session_packages() -> None:
    """Mark the leads whose Treatment Package is priced by the branch.

    A package ticked "Branch Admin enters the amount" is stored at a placeholder price of
    0. A Consultation Decision saved on one before the decision knew about the flag wrote
    that 0 times the sessions onto the lead as the fee, and never marked the lead -- so the
    Treatment Fee card offered to collect nothing instead of asking for the amount.

    Only leads whose Treatment Fee has not been collected: once it has, the figure is a
    financial record. Idempotent: a lead already marked is skipped, which also keeps an
    amount the branch has since typed."""
    items = await v3_col("store_items").find({"manual_price": True}, {"_id": 0, "id": 1}).to_list(500)
    ids = [i["id"] for i in items]
    if not ids:
        return
    await v3_col("leads").update_many(
        {
            "session_package_id": {"$in": ids},
            "treatment_fee_paid": None,
            "session_package_manual": {"$ne": True},
            # The same exemption as normalize_lead_session_package_prices: a moved client's
            # price came from their sheet.
            PAST_MOVE_FIELD: None,
        },
        {"$set": {"session_package_manual": True, "session_package_price": None, "updated_at": now_iso()}},
    )


async def backfill_branch_codes() -> None:
    """Every branch needs a short unique code (e.g. 'ANN' for Anna Nagar, 'ECR' for ECR)
    that prefixes its patients' Patient Numbers. Auto-derives one from the branch name
    for any branch that doesn't already have one set (existing branches, first run).
    Idempotent/safe to re-run — only ever fills in a missing code, never overwrites one
    a Super Admin already set."""
    branches = await v3_col("branches").find({}, {"_id": 0, "id": 1, "branch_name": 1, "code": 1}).to_list(1000)
    existing_codes = {b["code"] for b in branches if b.get("code")}
    for b in branches:
        if b.get("code"):
            continue
        code = derive_branch_code(b.get("branch_name", ""), existing_codes)
        existing_codes.add(code)
        await v3_col("branches").update_one({"id": b["id"]}, {"$set": {"code": code}})


async def backfill_patient_numbers() -> None:
    """Assign a Patient Number (BRANCHCODE-YYMMDD-SEQUENCE, e.g. ANN-260727-0000) to any
    lead that has a branch_id but no patient_number yet — processed oldest-first so the
    sequence reads chronologically. Runs after backfill_branch_codes() so every branch
    already has a code to draw from. Uses the same atomic per-branch-per-day counter as
    live lead creation, so a backfilled number can never collide with one a real request
    assigns for the same branch+day. Idempotent/safe to re-run."""
    leads = await v3_col("leads").find(
        {"branch_id": {"$ne": None}, "patient_number": None},
        {"_id": 0, "id": 1, "branch_id": 1, "created_at": 1},
    ).sort("created_at", 1).to_list(20000)
    for lead in leads:
        patient_number = await generate_patient_number(lead["branch_id"], at=lead.get("created_at"))
        if patient_number:
            await v3_col("leads").update_one({"id": lead["id"]}, {"$set": {"patient_number": patient_number}})


async def backfill_lead_enquiry_dates() -> None:
    """Date a lead by when the patient enquired, not by when the sync reached them.

    Both importers stamped created_at with the moment the pull ran, and every board that
    narrows by date is built on that field -- so a row the sheet picked up a day late was
    dated a day late, and a branch filtering to the 1st was shown a patient who enquired on
    the 31st. The enquiry time was in the export the whole time.

    The importers read it now, but that only helps rows arriving from here on: both of them
    skip a phone number they already hold, so a re-pull never revisits a lead to correct it.
    Which leaves every lead already stored, and there is no version of "run this by hand on
    the server" that makes a branch's counts right today. So it runs on startup, with the
    other forty.

    Safe to re-run, which is what makes that reasonable. The new value is computed from the
    lead's own stamp and written only where it differs, so the second startup finds nothing
    to do and the hundredth is a single query. A lead with no readable stamp -- typed in at
    the desk, or off a sheet with no such column -- has no better answer than the one it
    already carries and is left alone.

    patient_number is deliberately not touched. It is an identifier, printed and quoted
    back by patients, and its date says when the record was made rather than when anybody
    enquired. Expect the two to disagree on exactly the leads this moves.

    On the timezone, which decides whether a lead moves a day at all: Meta stamps
    created_time in the AD ACCOUNT's zone, and the day the clinic counts a lead on is the
    day Meta's own report puts it on. enquiry_created_at keeps the wall clock as written
    and anchors it to the clinic's day rather than converting it -- see the note there.
    """
    # Every lead, streamed rather than collected, and the stamp looked for in Python. It can
    # be in the ad record or in extra_fields under whatever the sheet's header said, and a
    # query naming one of those would quietly skip the leads carrying it in the other. A
    # cursor rather than to_list(N) for the same reason in a different shape: a cap silently
    # stops backfilling once the clinic passes it, and nothing says it has.
    cursor = v3_col("leads").find(
        {},
        {"_id": 0, "id": 1, "created_at": 1, "lead_data": 1, "extra_fields": 1},
    )

    moved = 0
    async for lead in cursor:
        stamp = find_enquiry_stamp(lead.get("lead_data"), lead.get("extra_fields"))
        if not stamp:
            continue
        enquired = enquiry_created_at(stamp)
        if not enquired or enquired == lead.get("created_at"):
            continue
        await v3_col("leads").update_one(
            {"id": lead["id"]},
            {"$set": {"created_at": enquired, "updated_at": now_iso()}},
        )
        moved += 1
    if moved:
        print(f"[startup] re-dated {moved} lead(s) to when the patient enquired")


async def backfill_zumba_package_sessions() -> None:
    """Give a Zumba registration back the class count its package always had.

    The branch's form learned to record package_sessions after these rows were written, so
    a membership sold before then names a package and says nothing about its length. The
    master's board reads that count for two columns -- how many classes, and the finish
    date it works out from them -- and both have been printing a dash for every one of
    them.

    Read off the catalogue item the row already points at, so nothing is inferred: a row
    with no package_id, or one naming an item since deleted, is left alone rather than
    guessed at. Only ever fills a missing count, never corrects one somebody set, so it is
    safe to re-run.
    """
    rows = await v3_col("zumba_registrations").find(
        {"package_id": {"$nin": [None, ""]},
         "$or": [{"package_sessions": None}, {"package_sessions": {"$exists": False}}]},
        {"_id": 0, "id": 1, "package_id": 1},
    ).to_list(5000)
    if not rows:
        return

    items = await v3_col("store_items").find(
        {"id": {"$in": sorted({r["package_id"] for r in rows})}},
        {"_id": 0, "id": 1, "sessions_offline": 1, "sessions_online": 1},
    ).to_list(1000)
    sessions_of = {}
    for item in items:
        count = item.get("sessions_offline") or item.get("sessions_online")
        if isinstance(count, int) and count > 0:
            sessions_of[item["id"]] = count

    for row in rows:
        count = sessions_of.get(row["package_id"])
        if count:
            await v3_col("zumba_registrations").update_one(
                {"id": row["id"]}, {"$set": {"package_sessions": count}}
            )


async def deactivate_legacy_demo_admin() -> None:
    """Disable the old demo super_admin account (admin@fitsiomax.com / admin123).
    Replaced by a real Super Admin login; kept as a record for audit, not deleted. Safe to re-run."""
    await v3_col("users").update_one(
        {"email": "admin@fitsiomax.com", "role": "super_admin"},
        {"$set": {"is_active": False}},
    )


async def sync_head_physio_doctors() -> None:
    """Consultants created via HR's Roles & Credentials only get a `users` row; Branch Admin's
    calendar reads the separate `doctors` collection. Backfill a matching doctors row (linked via
    user_id) for any consultant user that doesn't have one yet, so their calendar is manageable.
    Also keeps `doctors.full_name` in sync with the linked user's current name — it's a
    denormalized copy that otherwise goes stale whenever the user is renamed. Safe to re-run.

    Every consultant role rather than the one slug: somebody hired as an Online Consultant
    before that title counted as a consultant's has a login and no expert record, and so is
    missing from the calendar they were hired for with nothing on screen to say why. The
    record is stamped "head_physio" whichever role it came from — see expert_profile_type."""
    linked_user_ids = set(await v3_col("doctors").distinct("user_id"))
    cursor = v3_col("users").find(
        {"role": {"$in": sorted(HEAD_PHYSIO_ROLES)}, "is_active": True}, {"_id": 0}
    )
    async for user in cursor:
        if user["id"] not in linked_user_ids:
            await v3_col("doctors").insert_one({
                "id": str(uuid.uuid4()),
                "full_name": user["full_name"],
                "profile_type": "head_physio",
                "branch_id": user.get("branch_id"),
                "specialization": "",
                "slots": [],
                "slot_details": [],
                "user_id": user["id"],
                "created_at": now_iso(),
            })
            continue
        await v3_col("doctors").update_many(
            {"user_id": user["id"], "full_name": {"$ne": user["full_name"]}},
            {"$set": {"full_name": user["full_name"]}},
        )


async def consolidate_head_physio_doctors() -> None:
    """Collapse each Consultant down to one branchless expert record.

    One record per assigned branch left duplicates in every expert picker, and split their
    published availability across records — which is why a branch could show a Consultant
    as having published nothing while their real slots sat on a sibling record.

    Still wanted now that a Consultant is branch-selective, and for a sharper reason than
    tidiness: two records for one person means two independent clash checks, so the same
    Consultant could be booked into the same hour at two branches with nothing to notice.
    Where they are OFFERED is narrowed by the branches on their login instead, which this
    no longer touches.

    Slots are merged rather than picked, so no published availability is lost, and the
    surviving record keeps the id that appointments already point at wherever possible.
    Safe to re-run: once each user has a single branchless record there is nothing to do.
    """
    by_user: dict = {}
    cursor = v3_col("doctors").find({"profile_type": "head_physio"}, {"_id": 0})
    async for doc in cursor:
        key = doc.get("user_id") or f"name:{doc.get('full_name')}"
        by_user.setdefault(key, []).append(doc)

    for key, docs in by_user.items():
        if len(docs) == 1 and docs[0].get("branch_id") is None:
            continue  # already consolidated

        # Keep whichever record is actually referenced by appointments; failing that, the
        # one carrying the most published slots. Either way its id stays valid.
        ids = [d["id"] for d in docs]
        booked = await v3_col("appointments").find(
            {"doctor_id": {"$in": ids}}, {"_id": 0, "doctor_id": 1}
        ).to_list(5000)
        booked_ids = {b.get("doctor_id") for b in booked}
        keeper = next((d for d in docs if d["id"] in booked_ids), None)
        if keeper is None:
            keeper = max(docs, key=lambda d: len(d.get("slots") or []))

        merged_slots = sorted({s for d in docs for s in (d.get("slots") or []) if isinstance(s, str)})
        details: dict = {}
        for d in docs:
            for det in (d.get("slot_details") or []):
                if det.get("slot_time"):
                    details.setdefault(det["slot_time"], det)
        merged_details = [details[t] for t in sorted(details) if t in details]

        await v3_col("doctors").update_one({"id": keeper["id"]}, {"$set": {
            "branch_id": None,
            "slots": merged_slots,
            "slot_details": merged_details,
        }})
        drop = [d["id"] for d in docs if d["id"] != keeper["id"]]
        if drop:
            # Re-point any appointment on a dropped record before it disappears, so no
            # booking is orphaned by the merge.
            await v3_col("appointments").update_many(
                {"doctor_id": {"$in": drop}}, {"$set": {"doctor_id": keeper["id"]}}
            )
            await v3_col("doctors").delete_many({"id": {"$in": drop}})

    # Their login's branches are NOT cleared any more.
    #
    # This is where "a Consultant works across every branch" was actually enforced: the
    # branches were wiped at every startup, so any selection made in Roles & Credentials
    # survived until the next restart and then silently vanished. A Consultant is now
    # posted to chosen branches like every other desk, and consultants_serving_branch in
    # deps.py reads that selection to decide where they are offered.
    #
    # The record consolidation above stays, and still matters: one person keeps one
    # branchless calendar, which is what makes a Consultant impossible to double-book
    # across two branches in the same hour. Only their reach is selective, not their diary.


async def backfill_consultant_branches_from_employees() -> None:
    """Give a Consultant's login back the branches their employee record already names.

    The other half of making a Consultant branch-selective, and the half that had nothing
    to read. Where a Consultant works is decided on their employee record and cascaded to
    the login, which is what every branch-scoped list reads. But consolidate_head_physio_
    doctors cleared those logins at every startup for as long as Consultants were org-wide,
    so on an install upgrading into selective branches every Consultant login is blank
    while their employee row still says Anna Nagar or Tirchy.

    The result was a Consultant Calendar, a booking popup and a Team roster that were all
    empty at every branch, with the branch plainly printed two screens away in HR. Nothing
    was lost — the answer was on the employee all along — and this copies it back across.

    Only ever fills a login that has NO branches at all. A Consultant somebody has since
    posted, or deliberately taken off every branch by clearing it on the employee record
    (which cascades, so both halves go blank together), is left exactly as it is. That is
    what keeps this safe to run at every startup rather than once: after the first pass
    there is nothing blank left to fill, and it can never re-post somebody who was unposted
    on purpose, because unposting clears the employee too.

    ALL_BRANCHES is expanded rather than copied. An employee covering everything carries
    that marker; a Consultant covering everything now has to name the branches, because an
    empty list on a login means nowhere and no longer means everywhere. A branch added
    later will not be picked up — that is the honest consequence of a selective model,
    and it is visible and fixable on the row rather than silent.

    Consultants only. They are the one desk whose branches were being erased; every other
    role's login has carried its own all along.

    The employee is found by the link where there is one and BY NAME where there is not.
    That second path is not an edge case: employee_id on a login is optional, the two
    screens are filled in months apart, and _consultants_for_vertical already carries the
    same fallback for the same reason. Without it this function skipped exactly the people
    it was written for — HR printing Parrys Branch on the employee row while the login
    stayed blank and the Consultant Calendar stayed empty — because the only thing tying
    the two halves together was the link that was missing.

    A name is only accepted when it resolves to exactly ONE employee whose designation
    reads as this desk. A name shared by two people says nothing about which of them holds
    the login, and a namesake in another department is not this person at all, so an
    ambiguous match is dropped rather than guessed.

    Where a name resolves, the link itself is written back alongside the branches. The
    branches alone would be a repair with a short life: the next time HR moved that
    Consultant the cascade would look for the login by employee_id, fail to find it again,
    and the two halves would part exactly as before.
    """
    from routers.v3_hr import ALL_BRANCHES

    def name_key(value) -> str:
        return str(value or "").strip().lower()

    linked, unlinked = [], []
    async for u in v3_col("users").find(
        {"role": {"$in": sorted(HEAD_PHYSIO_ROLES)}},
        {"_id": 0, "id": 1, "employee_id": 1, "branch_id": 1, "branch_ids": 1, "full_name": 1},
    ):
        if [b for b in (u.get("branch_ids") or []) if b] or u.get("branch_id"):
            continue
        if u.get("employee_id"):
            linked.append(u)
        elif name_key(u.get("full_name")):
            unlinked.append(u)
    if not linked and not unlinked:
        return

    emps = {}
    if linked:
        async for e in v3_col("employees").find(
            {"id": {"$in": [u["employee_id"] for u in linked]}},
            {"_id": 0, "id": 1, "branch_id": 1, "branch_ids": 1},
        ):
            emps[e["id"]] = e

    # The same shape _consultants_for_vertical uses to trace an unlinked login: first
    # sighting of a name keeps the row, a second sighting poisons it to None, and only the
    # names that survive are read back.
    by_name = {}
    if unlinked:
        wanted = {name_key(u.get("full_name")) for u in unlinked}
        seen: dict = {}
        async for e in v3_col("employees").find(
            {}, {"_id": 0, "id": 1, "full_name": 1, "designation": 1, "branch_id": 1, "branch_ids": 1},
        ):
            key = name_key(e.get("full_name"))
            if key not in wanted:
                continue
            # The designation is what says this row is the same desk as the login. Read
            # through _slug_of_role so "ONLINE CONSULTANT" and online_consultant are the
            # one answer they are everywhere else, and matched against the same set the
            # logins were selected on rather than a second list to keep in step.
            if _slug_of_role(e.get("designation")) not in HEAD_PHYSIO_ROLES:
                continue
            seen[key] = None if key in seen else e
        by_name = {k: e for k, e in seen.items() if e}

    every = None
    for u in linked + unlinked:
        emp = emps.get(u["employee_id"]) if u.get("employee_id") else by_name.get(name_key(u.get("full_name")))
        if not emp:
            continue
        at = [b for b in (emp.get("branch_ids") or []) if b and b != ALL_BRANCHES]
        if not at and emp.get("branch_id") == ALL_BRANCHES:
            if every is None:
                every = await v3_col("branches").distinct("id", {})
            at = list(every)
        elif not at and emp.get("branch_id"):
            at = [emp["branch_id"]]
        if not at:
            continue
        account = {"branch_ids": at, "branch_id": at[0]}
        # Only where the name found them. A login that already carried the link keeps the
        # one it has: this function is repairing branches, and rewriting an existing link
        # off a name match is how the wrong two halves would be joined.
        if not u.get("employee_id"):
            account["employee_id"] = emp["id"]
        await v3_col("users").update_one({"id": u["id"]}, {"$set": account})


# The slug each retired consultation role is rewritten to. Same desk, same board, same
# pipeline — only the name changes, so the mapping is one-to-one and nothing about the
# workflow moves with it.
CONSULTANT_ROLE_RENAMES = {
    "head_physio": "consultant",
    "online_head_physio": "online_consultant",
}


async def migrate_consultant_roles() -> None:
    """Rename the consultation desk's role slugs to the names the clinic actually uses.

    A designation is a role in this OS, and the designation for this desk is CONSULTANT —
    "head physio" is a word nobody outside the code says. So `head_physio` becomes
    `consultant` and `online_head_physio` becomes `online_consultant`, and the two old
    slugs are gone from DEFAULT_ROLES so nobody can be given one again.

    Only the login's `role` is rewritten. The expert record's `profile_type` stays
    "head_physio" on purpose: every consultation query in the OS keys on it — the
    Consultant calendar lists on it, the board resolves its own expert by it, the
    consult-appointment and review endpoints filter on it — so renaming that as well would
    hide every consultant from every board that looks for them, for no gain the user can
    see. It is an internal type, exactly as "physio" is the type stamped on an
    online_physio. See expert_profile_type in routers/v3_hr.py.

    ONLINE CONSULTANTS who were hired before an online role existed still read
    `head_physio` and so land on `consultant` here, not `online_consultant` — this maps
    slugs, and does not try to guess the arm from a job title. Nothing breaks: the online
    branch finds them through their designation, which _names_the_online_arm in
    routers/v3_config.py already reads alongside the role for exactly that reason.

    Safe to re-run: after the first pass there is nothing left matching the old slugs.
    """
    await _rename_role_slugs(CONSULTANT_ROLE_RENAMES)


async def _rename_role_slugs(renames: dict) -> None:
    """Rewrite a set of retired role slugs to the ones that replace them.

    Shared by every role retirement, because all of them have the same three places to
    reach and the third is easy to forget. Both callers had the same reasons for each:

    The login's `role` is the slug the whole OS branches on, so it is the one that has to
    move. HR's employee records carry the same slug as a designation on some installs, so
    they move with it or the two halves of one person disagree about the job they hold.

    And a custom role typed by hand under a retired name would put the slug straight back
    into the Designation and Create User dropdowns that DEFAULT_ROLES no longer offers it
    in — one picker handing out a role the rest of the OS has retired. Renamed rather than
    deleted, so any custom colour and the row's own history survive.

    Safe to re-run: after the first pass nothing matches the old slugs any more.
    """
    # Imported here rather than at module scope: it is the only thing this needs from that
    # router, and the router pulls in plenty the rest of seeding does not.
    from routers.v3_hr import DEFAULT_ROLES

    for old, new in renames.items():
        await v3_col("users").update_many({"role": old}, {"$set": {"role": new}})
        await v3_col("employees").update_many(
            {"designation": old}, {"$set": {"designation": new}}
        )
    async for row in v3_col("custom_roles").find({}, {"_id": 0}):
        new = renames.get(_slug_of_role(row.get("name")))
        if not new:
            continue
        # Unless the replacement already exists — as a built-in, or under its own custom
        # row — in which case the duplicate is the thing to remove rather than a second
        # copy to create: _all_role_names would otherwise list the same desk twice.
        clash = await v3_col("custom_roles").find_one({"name": new}, {"_id": 0})
        if new in DEFAULT_ROLES or (clash and clash.get("id") != row.get("id")):
            await v3_col("custom_roles").delete_one({"id": row["id"]})
        else:
            await v3_col("custom_roles").update_one(
                {"id": row["id"]}, {"$set": {"name": new}}
            )


# The slug each retired Branch Admin variant is rewritten to.
#
# All three collapse onto plain `branch_admin`, and nothing about anybody's access changes
# when they do: the six slugs were always one permission set under several names — see
# BRANCH_ADMIN_ROLES in deps.py — so the variants were a label saying which practice the
# person ran, never a different reach into the branch. The label is what is being dropped.
#
# The two online admins are NOT here. Those name the arm rather than the practice, the
# online branches are a real separate vertical, and they stay assignable.
BRANCH_ADMIN_ROLE_RENAMES = {
    "branch_admin_physio": "branch_admin",
    "branch_admin_fitness": "branch_admin",
    "branch_admin_physio_fitness": "branch_admin",
}


async def migrate_branch_admin_roles() -> None:
    """Collapse the three Branch Admin practice variants back onto plain Branch Admin.

    A branch is run by one Branch Admin whichever practice it sells, and splitting the
    title three ways bought nothing: the permissions were identical, so the only thing the
    variants did was make the Create User and Designation pickers offer four spellings of
    one job and leave whoever was filling the form to guess which mattered. It did not, and
    HR's own structure had already settled on the single "Branch Admin" designation.

    Nobody gains or loses anything here. Anyone holding a variant keeps the same reach over
    the same branch under the name the rest of the OS already used for it, and the three
    slugs stay recognised in BRANCH_ADMIN_ROLES so an account this has not reached yet is
    not locked out of its own board in the meantime.

    Which practice a branch actually runs is a fact about the branch, and the branch's own
    `vertical` is where it is recorded — a far better place for it than a copy on each of
    its admins that nothing ever read.

    Safe to re-run: after the first pass nothing matches the old slugs any more.
    """
    await _rename_role_slugs(BRANCH_ADMIN_ROLE_RENAMES)


async def migrate_designation_roles() -> None:
    """Move the desks that were typed by hand onto the fixed slugs HR's structure names.

    HR Admin, Nutritionist and Zumba were never in DEFAULT_ROLES. Each was created by
    whoever typed its title into Credentials, so the OS could not know the wording and had
    to guess — is_hr_role, is_diet_role and is_zumba_role in deps.py each match a bag of
    tokens for that reason. It still went wrong: this install ended up with `diet_manage`,
    which the Diet board had never been written against, and that user logged in to a blank
    screen until the predicate was widened to catch them.

    They are permanent desks, so they are now named once in DEFAULT_ROLES and matched
    exactly. This is the sweep that moves the accounts already holding a typed variant.

    Super Admin is excluded explicitly and that exclusion is the whole safety of this
    function: is_hr_role and is_diet_role both answer True for super_admin — deliberately,
    since Super Admin may reach every board — so a rename driven off those predicates alone
    would quietly demote the owner of the system to a Nutritionist.

    A slug already in DEFAULT_ROLES is left alone for the same reason, or `physio` would be
    swept up by nothing in particular the day somebody adds a token to a predicate.

    Safe to re-run: after the first pass every account already holds a built-in slug, which
    is the condition this skips on.
    """
    from routers.v3_hr import DEFAULT_ROLES

    # Ordered: the first predicate that claims a slug wins, and they cannot overlap for
    # anything reaching this point since Super Admin is already excluded.
    desks = ((is_hr_role, "hr_admin"), (is_diet_role, "nutritionist"), (is_zumba_role, "zumba"))

    def _target(role: str):
        r = (role or "").strip().lower()
        if not r or r == "super_admin" or r in DEFAULT_ROLES:
            return None
        for predicate, slug in desks:
            if predicate(r):
                return slug
        return None

    for role in await v3_col("users").distinct("role"):
        target = _target(role)
        if target:
            await v3_col("users").update_many({"role": role}, {"$set": {"role": target}})

    # The employee record carries the same slug as a designation on some installs, and the
    # custom role behind it would otherwise keep offering the old wording in the picker
    # DEFAULT_ROLES no longer lists it in.
    for row in await v3_col("custom_roles").find({}, {"_id": 0}).to_list(500):
        target = _target(_slug_of_role(row.get("name")))
        if not target:
            continue
        await v3_col("employees").update_many(
            {"designation": row.get("name")}, {"$set": {"designation": target}}
        )
        # Built-in now, so the custom row is a duplicate of it rather than a row to rename.
        await v3_col("custom_roles").delete_one({"id": row["id"]})


async def retire_aliased_designation_roles() -> None:
    """Remove the roles minted for a designation whose desk already had a shorter name.

    Three titles in HR's structure do not reduce to the slug that runs their desk —
    "Business Development Executive" is business_dev, and the two physiotherapist titles
    are physio and online_physio. Before DESIGNATION_ROLE_ALIASES existed,
    ensure_roles_for_designations could not know that, so it minted one role per title and
    the Credentials picker ended up offering BUSINESS DEVELOPMENT EXECUTIVE beside BUSINESS
    DEV: the same desk twice, one of them holding no permissions at all, and nothing on
    screen to say which was which.

    The alias map stops it happening again. This is the sweep for the rows already there.

    Accounts are moved before the role is deleted, not after, so nobody is left holding a
    slug that no longer exists. They lose nothing — the minted role never carried any
    permission, and the built-in it collapses onto is the one their board was gated on.

    Safe to re-run: the second pass finds no rows left to move.
    """
    from routers.v3_hr import DESIGNATION_ROLE_ALIASES

    for minted, real in DESIGNATION_ROLE_ALIASES.items():
        await v3_col("users").update_many({"role": minted}, {"$set": {"role": real}})
        await v3_col("employees").update_many(
            {"designation": minted}, {"$set": {"designation": real}}
        )
        await v3_col("custom_roles").delete_many({"name": minted})


async def ensure_structure_departments() -> None:
    """Make sure HR's structure holds every department and designation the clinic works to.

    Additive on purpose, twice over. A department already there keeps its designations —
    an employee references their department and designation by name, so rewriting either
    out from under them strands the record in a group that no longer exists, which is what
    the Employees tab filters and the Department Strength bars count on.

    So this only ever adds: a department that is missing, and a designation missing from a
    department that already exists. Nothing is renamed, merged or removed — the old
    departments stay until somebody empties them by hand and deletes them, which is a
    decision about where people work rather than one a migration should take.

    Safe to re-run: the second pass finds everything already present.
    """
    from routers.v3_hr import STRUCTURE, structure_key

    existing = {
        structure_key(d.get("name")): d
        for d in await v3_col("hr_departments").find({}, {"_id": 0}).to_list(500)
    }
    now = now_iso()
    for dept, titles in STRUCTURE.items():
        row = existing.get(structure_key(dept))
        if row is None:
            await v3_col("hr_departments").insert_one({
                "id": str(uuid.uuid4()),
                "name": dept,
                "designations": list(titles),
                "created_at": now,
            })
            continue
        # Compared case-insensitively: "Consultant" typed here yesterday is not a second
        # designation from "CONSULTANT" in the list above, and adding it would put the same
        # job in the department twice with no way to tell the rows apart.
        have = {structure_key(t) for t in (row.get("designations") or [])}
        fresh = [t for t in titles if structure_key(t) not in have]
        if fresh:
            await v3_col("hr_departments").update_one(
                {"id": row["id"]},
                {"$set": {"designations": (row.get("designations") or []) + fresh}},
            )


async def dedupe_department_designations() -> None:
    """One entry per job title in a department, whichever case each was typed in.

    A department is a list of designations, and the same title reached that list twice —
    "Consultant" beside "CONSULTANT", "Online Consultant" beside "Online  Consultant". The
    guards that were meant to stop it compared the names literally with only their case
    folded, so any difference in spacing or punctuation slipped through, and PUT
    .../designations/order compared the submitted list with the stored one as SETS, which
    cannot see a repeat at all. Both are tightened in routers/v3_hr.py; this is the sweep
    for the lists that already carry the repeats.

    The first spelling wins, because it is the one every earlier record was written
    against. Employees holding a dropped spelling are rewritten to the survivor in the same
    pass — dropping the name without moving the people would leave an employee pointing at
    a designation the department no longer lists, which is a record that filters to nothing
    on the Employees tab and counts toward no designation on the Dashboard.

    Only ever removes a repeat of a title the department already holds. A title held once
    is never touched, and no title moves between departments — where a job belongs is a
    decision about the org, not one a migration should take.

    Safe to re-run: the second pass finds every list already unique.
    """
    from routers.v3_hr import structure_key

    for dept in await v3_col("hr_departments").find({}, {"_id": 0}).to_list(500):
        names = [n for n in (dept.get("designations") or []) if isinstance(n, str) and n.strip()]
        kept: list = []
        seen: dict = {}
        # old spelling -> the spelling that survives it, for the employees carrying it.
        rewrites: dict = {}
        for name in names:
            key = structure_key(name)
            if not key:
                continue
            if key in seen:
                if name != seen[key]:
                    rewrites[name] = seen[key]
                continue
            seen[key] = name
            kept.append(name)
        if len(kept) == len(names):
            continue
        await v3_col("hr_departments").update_one({"id": dept["id"]}, {"$set": {"designations": kept}})
        for old, survivor in rewrites.items():
            await v3_col("employees").update_many(
                {"designation": old}, {"$set": {"designation": survivor}}
            )


def _slug_of_role(label) -> str:
    """A role label reduced to the slug the OS branches on ("Head Physio" -> head_physio)."""
    return re.sub(r"[^a-z0-9]+", "_", str(label or "").strip().lower()).strip("_")


async def retire_experts_without_a_login() -> None:
    """Mark expert profiles whose login is deactivated or gone as inactive.

    Deactivating or deleting a login used to leave the `doctors` record behind untouched,
    so the person stayed in every consultant list and stayed bookable after they had left.
    That is now followed through at the point of deactivation, but nobody retired before
    then carries the flag — including anyone whose login was permanently deleted, whose
    record was left pointing at a user that no longer exists and could not be removed by
    hand either, since deleting an expert is refused for anything holding a user_id.

    This is the sweep that catches them. Only profiles that carry a user_id are considered:
    an expert added under HR > Fitsiomax Experts never had a login and is not missing one.

    Idempotent, and it only ever sets the flag it finds wrong, so a record already correct
    is left alone and someone reactivated is not retired again on the next restart.
    """
    linked = await v3_col("doctors").find(
        {"user_id": {"$nin": [None, ""]}}, {"_id": 0, "id": 1, "user_id": 1, "is_active": 1}
    ).to_list(5000)
    if not linked:
        return

    user_ids = list({d["user_id"] for d in linked})
    users = await v3_col("users").find(
        {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "is_active": 1}
    ).to_list(5000)
    # A login that is missing entirely and one that is switched off mean the same thing to
    # a booking list: not someone to offer.
    alive = {u["id"] for u in users if u.get("is_active", True)}

    retire = [d["id"] for d in linked if d["user_id"] not in alive and d.get("is_active") is not False]
    if retire:
        await v3_col("doctors").update_many(
            {"id": {"$in": retire}}, {"$set": {"is_active": False, "updated_at": now_iso()}}
        )

    # The other direction, so a login switched back on before this existed is not left
    # retired by a sweep that only ever removes people.
    restore = [d["id"] for d in linked if d["user_id"] in alive and d.get("is_active") is False]
    if restore:
        await v3_col("doctors").update_many(
            {"id": {"$in": restore}}, {"$set": {"is_active": True, "updated_at": now_iso()}}
        )


async def backfill_login_history_from_sessions() -> None:
    """login_history only started recording on /auth/login once that tracking was added,
    so anyone already logged in at that point shows zero entries in the Super Admin
    Login Tracker until they log in again. Backfill one entry per such user from their
    current active session (sessions holds one row per user, its created_at is their
    last real login time). Only touches users with zero login_history rows — once a
    user has a real tracked login, this never overwrites or duplicates it. Safe to re-run."""
    # The "sessions" collection holds two unrelated shapes: auth login tokens
    # ({token, user_id, created_at}) and treatment sessions ({lead_id, physio_id,
    # slot_time, ...}). Only the login tokens carry user_id — reading the treatment ones
    # here raised KeyError and killed the app at startup, so filter to the auth shape.
    sessions = await v3_col("sessions").find({"user_id": {"$exists": True}}, {"_id": 0}).to_list(2000)
    if not sessions:
        return
    session_user_ids = list({s["user_id"] for s in sessions})
    already_tracked = set(await v3_col("login_history").distinct("user_id", {"user_id": {"$in": session_user_ids}}))
    to_backfill = [s for s in sessions if s["user_id"] not in already_tracked]
    if not to_backfill:
        return
    users = await v3_col("users").find(
        {"id": {"$in": [s["user_id"] for s in to_backfill]}}, {"_id": 0}
    ).to_list(2000)
    user_map = {u["id"]: u for u in users}
    docs = []
    for s in to_backfill:
        user = user_map.get(s["user_id"])
        if not user:
            continue
        docs.append({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "user_name": user.get("full_name", ""),
            "email": user.get("email", ""),
            "role": user.get("role", ""),
            "branch_id": user.get("branch_id"),
            "created_at": s.get("created_at") or now_iso(),
        })
    if docs:
        await v3_col("login_history").insert_many(docs)


async def ensure_v1_seed_data() -> None:
    users_count = await db.users.count_documents({})
    if users_count == 0:
        await db.users.insert_one(
            {
                "id": str(uuid.uuid4()),
                "full_name": "Super Admin",
                "email": "admin@physiofit.com",
                "password": hash_password("admin123"),
                "role": "super_admin",
                "branch_id": None,
                "is_active": True,
                "created_at": now_iso(),
            }
        )

    default_role_users = [
        {
            "full_name": "Pre-sales Executive",
            "email": "presales@physiofit.com",
            "password": "presales123",
            "role": "pre_sales",
        },
        {
            "full_name": "Sales Executive",
            "email": "sales@physiofit.com",
            "password": "sales123",
            "role": "sales",
        },
    ]

    for default_user in default_role_users:
        exists = await db.users.find_one({"email": default_user["email"]}, {"_id": 0})
        if not exists:
            await db.users.insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "full_name": default_user["full_name"],
                    "email": default_user["email"],
                    "password": hash_password(default_user["password"]),
                    "role": default_user["role"],
                    "branch_id": None,
                    "is_active": True,
                    "created_at": now_iso(),
                }
            )

    stages_count = await db.stages.count_documents({})
    if stages_count == 0:
        base_stages = [
            {"name": "New Lead", "pipeline": "pre_sales", "order": 1},
            {"name": "Follow Up", "pipeline": "pre_sales", "order": 2},
            {"name": "Appointment Booked", "pipeline": "pre_sales", "order": 3},
            {"name": "New Appointment", "pipeline": "sales", "order": 1},
            {"name": "Discussion", "pipeline": "sales", "order": 2},
            {"name": "Package Purchased", "pipeline": "sales", "order": 3},
        ]
        for item in base_stages:
            await db.stages.insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "name": item["name"],
                    "pipeline": item["pipeline"],
                    "order": item["order"],
                    "created_at": now_iso(),
                }
            )

    await db.sheets_configs.update_one(
        {"singleton": "global"},
        {
            "$setOnInsert": {
                "singleton": "global",
                "spreadsheet_id": "",
                "sheet_name": "Leads",
                "column_mapping": {},
                "last_sync": None,
                "updated_at": now_iso(),
            }
        },
        upsert=True,
    )


async def v2_seed() -> None:
    users = [
        {"full_name": "Super Admin", "email": "admin@fitsiomax.com", "password": "admin123", "role": "super_admin"},
        {"full_name": "Online Fitness", "email": "onlinefitness@fitsiomax.com", "password": "online123", "role": "online_fitness"},
        {"full_name": "Online Physio", "email": "onlinephysio@fitsiomax.com", "password": "physio123", "role": "online_physio"},
        {"full_name": "Offline Physio", "email": "offlinephysio@fitsiomax.com", "password": "offline123", "role": "offline_physio"},
    ]
    for user in users:
        exists = await v2_col("users").find_one({"email": user["email"]}, {"_id": 0})
        if not exists:
            await v2_col("users").insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "full_name": user["full_name"],
                    "email": user["email"],
                    "password": hash_password(user["password"]),
                    "role": user["role"],
                    "is_active": True,
                    "created_at": now_iso(),
                }
            )

    if await v2_col("services").count_documents({}) == 0:
        defaults = [
            {"name": "Online Fitness Program", "mode": "online", "category": "fitness_program"},
            {"name": "Online Physio Therapy", "mode": "online", "category": "physio_therapy"},
            {"name": "Offline Physio Therapy", "mode": "offline", "category": "physio_therapy"},
            {"name": "Offline Fitness GYM", "mode": "offline", "category": "offline_fitness_gym"},
        ]
        for item in defaults:
            await v2_col("services").insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "name": item["name"],
                    "mode": item["mode"],
                    "category": item["category"],
                    "created_at": now_iso(),
                }
            )


async def v3_seed() -> None:
    # Only the real Super Admin is seeded here. The generic demo role accounts
    # (Business Dev/Pre Sales/Branch Admin/Head Physio/Physio @fitsiomax.com)
    # that used to live in this list had hardcoded, guessable passwords and
    # were removed — real accounts are created through HR > Roles & Credentials.
    seed_users = [
        {"full_name": "Super Admin", "email": "fitsiomaxtech@gmail.com", "password": "FitsioMax06", "role": "super_admin"},
    ]
    for user in seed_users:
        exists = await v3_col("users").find_one({"email": user["email"]}, {"_id": 0})
        if not exists:
            await v3_col("users").insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "full_name": user["full_name"],
                    "email": user["email"],
                    "password": hash_password(user["password"]),
                    "role": user["role"],
                    "branch_id": None,
                    "is_active": True,
                    "created_at": now_iso(),
                }
            )

    if await v3_col("verticals").count_documents({}) == 0:
        for name in V3_VERTICALS:
            await v3_col("verticals").insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "active": True,
                    "created_at": now_iso(),
                }
            )

    # No branch and no team member is invented here any more.
    #
    # Both were props for the demo logins this function used to create. The seeded branch
    # only appeared when branchadmin@fitsiomax.com existed, and existed to give that
    # account somewhere to point; the two team members — Karthik Reddy and Divya Pillai,
    # on @constructions.com addresses — came in with the CRM this was built out of and
    # name nobody who works here. The demo accounts went when their hardcoded passwords
    # did, and these outlived them: on a fresh install they are the whole of what the
    # Marketing team lists, and every name on it is fictional.
    #
    # A branch is opened in Branch Management and a person is hired in HR, where they get
    # a department and a designation from the structure ensure_structure_departments()
    # lays down. That structure is the only thing this file still puts in front of
    # somebody, and it is a list of job titles rather than a list of people. Nothing that
    # boots should be adding a colleague or a location nobody asked for.
    #
    # Nothing is deleted for the same reason deactivate_legacy_demo_admin() deactivates
    # rather than drops: an install that has already run the old seed keeps its rows, and
    # whether a fictional branch is worth removing is a decision for whoever can see what
    # has since been booked against it.
