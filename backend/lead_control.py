"""Who works a lead first: Pre-Sales, or the Branch Admin directly.

The OS was built assuming a Pre-Sales desk qualifies every incoming lead before a
branch ever sees it. That desk is not always staffed — a clinic may run without one
and hire later — and when it is empty every imported lead lands in a pipeline nobody
opens. Lead Control is the switch for that: per branch, either

    "pre_sales"     — the original flow. The lead sits in the Pre-Sales pipeline,
                      is round-robined to the Pre-Sales team, and reaches the branch
                      once it is qualified (or immediately as well, if the source
                      carries a branch tag — that has always been true).

    "branch_admin"  — the Pre-Sales step is skipped. The lead goes straight onto the
                      branch board and never appears in the Pre-Sales pipeline, and
                      no Pre-Sales rep is assigned to it.

It is resolved live from the branch rather than stamped on the lead, so flipping the
switch moves the leads already sitting in the wrong place too, not only the next
import. That is the point of it — a clinic turning the desk off has a backlog to
rehome, and a clinic turning it back on wants that backlog handed over.

A lead with no branch yet cannot be branch-controlled: there is no branch to hand it
to. Those stay with Pre-Sales whatever any switch says, which is also why the branch
is the thing that carries the setting.
"""

from typing import Dict, Optional

from database import v3_col

PRE_SALES = "pre_sales"
BRANCH_ADMIN = "branch_admin"
# Both desks work the lead: it stays in the Pre-Sales pipeline with a Pre-Sales rep, and
# the branch board runs it the Branch Admin way at the same time.
BOTH = "both"
VALID = (PRE_SALES, BRANCH_ADMIN, BOTH)
DEFAULT = PRE_SALES


def stage_mode(control: str) -> str:
    """Which `applies_to` stage set the branch board uses. Both reuses Branch Admin's, so
    the board has one entry stage rather than two competing ones."""
    return BRANCH_ADMIN if control in (BRANCH_ADMIN, BOTH) else PRE_SALES


def normalize(value: Optional[str]) -> str:
    """Coerce a stored/submitted value to one of VALID, defaulting to Pre-Sales.

    Branches created before this feature have no field at all, so absent must read as
    the old behaviour rather than as an error.
    """
    v = str(value or "").strip().lower()
    return v if v in VALID else DEFAULT


async def branch_control_map() -> Dict[str, str]:
    """{branch_id: control} for every branch, in one query."""
    rows = await v3_col("branches").find({}, {"_id": 0, "id": 1, "lead_control": 1}).to_list(1000)
    return {r["id"]: normalize(r.get("lead_control")) for r in rows if r.get("id")}


async def branch_lead_control(branch_id: Optional[str]) -> str:
    """Control for one branch. No branch means Pre-Sales — see the module docstring."""
    if not branch_id:
        return DEFAULT
    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "lead_control": 1})
    return normalize((branch or {}).get("lead_control"))


def control_for_lead(lead: dict, control_by_branch: Dict[str, str]) -> str:
    """Resolve a single lead against a map from branch_control_map()."""
    branch_id = lead.get("branch_id")
    if not branch_id:
        return DEFAULT
    return control_by_branch.get(branch_id, DEFAULT)
