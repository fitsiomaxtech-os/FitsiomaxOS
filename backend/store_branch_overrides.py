"""Per-branch values for FITSIO STORE packages (Services and Products).

Super Admin's catalogue row is the default every branch starts from. With the developer
switch On, a Branch Admin's edit is kept for that branch alone -- its own name, prices,
Consultation Duration, session count and so on -- and every read made on behalf of that
branch lays those values over the default. With it Off (the default) there is one row and
every branch reads and edits it, which is how the store always worked.

Switching Off never deletes anything: the branch rows stay where they are and come back the
moment it is switched On again.

Kept free of FastAPI so the routers that price a booking can all call the same overlay.
"""
from datetime import datetime, timezone
from typing import List, Optional

from database import v3_col

SETTING_ID = "store_branch_overrides"
COLLECTION = "store_item_branch_overrides"

# What a branch may make its own. Never item_type or category (the server refuses a branch
# moving a package to another shelf) and never price_is_total, which follows the shelf.
FIELDS = (
    "name",
    "description",
    "image_url",
    "price_online",
    "price_offline",
    "duration_minutes",
    "consultation_package",
    "sessions_online",
    "sessions_offline",
    "manual_price",
)


async def enabled() -> bool:
    """Does each branch keep its own Services and Products? Off unless a developer said On."""
    row = await v3_col("app_settings").find_one({"id": SETTING_ID}, {"_id": 0})
    return bool(row and row.get("enabled"))


async def overlay(items: List[dict], branch_id: Optional[str]) -> List[dict]:
    """`items` with `branch_id`'s own values laid over each, where it has any.

    A row the branch changed comes back marked branch_override=True. Unchanged when the
    switch is Off or no branch is known, so a caller never has to ask first.
    """
    if not items or not branch_id or not await enabled():
        return items
    ids = [i.get("id") for i in items if i and i.get("id")]
    rows = await v3_col(COLLECTION).find(
        {"branch_id": branch_id, "item_id": {"$in": ids}}, {"_id": 0}
    ).to_list(len(ids) or 1)
    by_item = {r["item_id"]: r for r in rows}
    out = []
    for item in items:
        own = by_item.get(item.get("id")) if item else None
        if not own:
            out.append(item)
            continue
        merged = dict(item)
        for f in FIELDS:
            if f in own:
                merged[f] = own[f]
        if own.get("updated_at"):
            merged["updated_at"] = own["updated_at"]
        merged["branch_override"] = True
        out.append(merged)
    return out


async def overlay_one(item: Optional[dict], branch_id: Optional[str]) -> Optional[dict]:
    if not item:
        return item
    return (await overlay([item], branch_id))[0]


async def save(item_id: str, branch_id: str, values: dict, updated_by: str) -> None:
    """Keep `values` as `branch_id`'s own version of the package. Only FIELDS are kept."""
    doc = {f: values.get(f) for f in FIELDS if f in values}
    doc.update({
        "item_id": item_id,
        "branch_id": branch_id,
        "updated_by": updated_by,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    await v3_col(COLLECTION).update_one(
        {"item_id": item_id, "branch_id": branch_id}, {"$set": doc}, upsert=True
    )


async def forget_item(item_id: str) -> None:
    """A deleted package takes every branch's version of it along."""
    await v3_col(COLLECTION).delete_many({"item_id": item_id})
