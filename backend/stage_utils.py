from typing import List, Optional, Set

import lead_control
from constants import BRANCH_ADMIN_RNR_STAGE, SALES_ARM_OFFLINE, SALES_ARM_ONLINE
from database import v3_col
from deps import names_the_online_arm, online_arm_practice
from utils import now_iso


# ---------------------------------------------------------------- Branch ("sales") stages
#
# The Branch pipeline is not the same shape for every branch: a branch running its own
# leads (Lead Control = Branch Admin) opens at "Branch Assign" and has an RNR stage, while
# a branch fed by the Pre-Sales desk opens at "New Appointment" and has neither. Both live
# in the one `sales` stage list, told apart by `applies_to` — see constants.py.
#
# Everything that reads or writes a lead's branch_stage must go through these, because the
# entry stage is no longer a single global name. Writing the wrong mode's entry stage onto
# a lead orphans it exactly the way a stale hardcoded literal does: the lead still counts
# in the branch total but sits on a stage that branch's board never renders.


def _visible_to(stage_row: dict, control: str) -> bool:
    """A stage with no `applies_to` belongs to both modes — that is every stage that
    existed before Lead Control, so absent must read as 'shared' rather than 'hidden'."""
    applies_to = stage_row.get("applies_to")
    return not applies_to or applies_to == lead_control.stage_mode(control)


# ------------------------------------------------------------------- The two Branch arms
#
# The second axis, alongside Lead Control above. The clinic runs an offline practice and an
# online one, and they do not work a lead the same way — so each arm has its own Branch Lead
# pipeline, edited on its own tab in CI/CD ROOTS and stamped `arm` on the stage row.
#
# Which arm a record belongs to is read from its `vertical`, never stored twice: an online
# admin's role names the arm, an online lead's vertical does, and a branch's vertical does.
# See seed.ensure_sales_arm_split for how the two lists came to exist.
#
# A stage with no `arm` belongs to both, which is what every stage was before the split —
# so a database mid-upgrade reads as shared rather than as two empty pipelines.


def _in_arm(stage_row: dict, arm: Optional[str]) -> bool:
    if not arm:
        return True
    row_arm = stage_row.get("arm")
    return not row_arm or row_arm == arm


async def sales_arm_for(
    branch_id: Optional[str] = None, role: str = "", vertical: Optional[str] = None
) -> str:
    """Which Branch Lead pipeline applies, from whichever of the three the caller has.

    Role first: an online arm admin runs a practice rather than a branch and has no
    branch_id at all (see v3_arm_board), so asking the branch would answer "offline" for
    every one of them. Then the record's own vertical, then the branch it sits in.
    """
    if online_arm_practice(role):
        return SALES_ARM_ONLINE
    if vertical is not None and names_the_online_arm(vertical):
        return SALES_ARM_ONLINE
    if branch_id:
        branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "vertical": 1})
        if names_the_online_arm((branch or {}).get("vertical")):
            return SALES_ARM_ONLINE
    return SALES_ARM_OFFLINE


async def _sales_stage_rows(arm: Optional[str] = None) -> List[dict]:
    """Sales stage rows, narrowed to one arm when the caller knows which.

    `arm=None` means every arm, which is what the callers asking a question about the
    pipeline as a whole want — "is this name a real stage anywhere" rather than "what does
    this board show".
    """
    rows = await v3_col("pipeline_stages").find(
        {"type": "sales"}, {"_id": 0, "name": 1, "applies_to": 1, "arm": 1}
    ).sort("order", 1).to_list(400)
    return [r for r in rows if _in_arm(r, arm)]


async def branch_stage_names_for(
    control: str, fallback: List[str], arm: Optional[str] = None
) -> List[str]:
    """The Branch stage names a branch under `control` actually has, in pipeline order."""
    rows = await _sales_stage_rows(arm)
    names = [r["name"] for r in rows if _visible_to(r, control)]
    return names or list(fallback)


async def branch_stage_names_for_branch(branch_id: Optional[str], fallback: List[str]) -> List[str]:
    return await branch_stage_names_for(
        await lead_control.branch_lead_control(branch_id),
        fallback,
        await sales_arm_for(branch_id=branch_id),
    )


async def first_branch_stage_for(
    control: str, fallback: str, arm: str = SALES_ARM_OFFLINE
) -> str:
    """The stage a lead lands on when it reaches a branch under `control`.

    The arm is not optional here the way it is on the membership questions above: "the
    first stage" of both pipelines at once is not a thing, and left unnarrowed this would
    return whichever arm's entry stage happened to sort first. Defaults to the offline
    pipeline, which is the one that existed before the split.
    """
    names = await branch_stage_names_for(control, [], arm)
    return names[0] if names else fallback


async def first_branch_stage_for_branch(branch_id: Optional[str], fallback: str) -> str:
    """The entry stage of one branch's board, resolved from its own Lead Control.

    The branch-aware replacement for get_first_stage_name("sales", ...): a lead handed to
    a Branch-Admin-controlled branch must open on "Branch Assign", not on the Pre-Sales
    entry stage, or it never appears on the board it was just handed to.
    """
    if not branch_id:
        return fallback
    return await first_branch_stage_for(
        await lead_control.branch_lead_control(branch_id),
        fallback,
        await sales_arm_for(branch_id=branch_id),
    )


async def entry_branch_stage_names() -> Set[str]:
    """Every mode's entry stage, for callers asking "has this lead been worked at all yet?"
    without caring which desk owns it."""
    names = set()
    # Both arms: the question is whether this lead has been worked at all, and an online
    # lead standing at the online pipeline's opening has not been, whatever that stage is
    # called on the offline side.
    for arm in (SALES_ARM_OFFLINE, SALES_ARM_ONLINE):
        rows = await _sales_stage_rows(arm)
        for control in lead_control.VALID:
            visible = [r["name"] for r in rows if _visible_to(r, control)]
            if visible:
                names.add(visible[0])
    return names


async def realign_branch_stage_leads(branch_id: str, control: str) -> int:
    """Rehome a branch's leads after its Lead Control changed. Returns how many moved.

    Lead Control is resolved live rather than stamped on the lead, so flipping the switch
    has to move the leads already sitting in the wrong place — a branch that just took its
    leads over has a backlog on the Pre-Sales entry stage, and one handing them back has a
    backlog on Branch Assign and RNR. Left alone those leads keep a branch_stage the board
    no longer renders: counted in the total, invisible in every pill.

    A lead mid-pipeline is not disturbed — Follow Up and everything past it are shared by
    both modes. Only stages the target mode does not have get moved, and RNR folds into
    Follow Up rather than back to the start, the same way it did when RNR was retired from
    the Pre-Sales and Consultation pipelines.
    """
    rows = await _sales_stage_rows(await sales_arm_for(branch_id=branch_id))
    target = [r["name"] for r in rows if _visible_to(r, control)]
    if not target:
        return 0
    entry = target[0]
    fallback_for_rnr = next((n for n in target if n == "Follow Up"), entry)
    stranded = [r["name"] for r in rows if not _visible_to(r, control)]

    moved = 0
    for name in stranded:
        destination = fallback_for_rnr if name == BRANCH_ADMIN_RNR_STAGE else entry
        if destination == name:
            continue
        result = await v3_col("leads").update_many(
            {"branch_id": branch_id, "branch_stage": name},
            {"$set": {"branch_stage": destination, "updated_at": now_iso()}},
        )
        moved += result.modified_count
    return moved


async def get_first_stage_name(stage_type: str, fallback: str) -> str:
    """Return the current name of the first (order=0) pipeline stage for the given type.

    Several code paths used to hardcode literal stage names (e.g. "New Appointment") when
    stamping a lead's first position in a pipeline. Once Super Admin renames that stage via
    Pipeline Stage Management, the hardcoded literal no longer matches any real stage — the
    lead becomes orphaned (counted in totals but invisible in every stage pill). Callers should
    look the name up dynamically instead so they always land leads on the live first stage.
    """
    doc = await v3_col("pipeline_stages").find_one(
        {"type": stage_type}, {"_id": 0, "name": 1}, sort=[("order", 1)]
    )
    return doc["name"] if doc else fallback


async def get_closing_stage_name(stage_type: str, fallback: str) -> str:
    """Return the current name of the stage a lead *finishes* a pipeline on.

    The mirror of get_first_stage_name, and orphans leads the same way when hardcoded:
    the Head Physio pipeline's closing stage shipped as "Consultation Visit" and has since
    been renamed, so writing that literal put completed consultations on a stage that no
    longer existed — invisible on every board that filters by stage.

    Prefers the stage flagged final; falls back to the last by order, since a pipeline
    always has a last stage even when nothing is flagged.
    """
    rows = await v3_col("pipeline_stages").find(
        {"type": stage_type}, {"_id": 0, "name": 1, "is_final": 1}
    ).sort("order", 1).to_list(100)
    if not rows:
        return fallback
    return next((r["name"] for r in rows if r.get("is_final")), rows[-1]["name"])


async def get_stage_name_at(stage_type: str, index: int, fallback: str) -> str:
    """Return the stage occupying a given position, for hand-off points identified by
    where they sit rather than by what they're called."""
    rows = await v3_col("pipeline_stages").find(
        {"type": stage_type}, {"_id": 0, "name": 1}
    ).sort("order", 1).to_list(100)
    names = [r["name"] for r in rows]
    if not names:
        return fallback
    return names[index] if 0 <= index < len(names) else names[-1]
