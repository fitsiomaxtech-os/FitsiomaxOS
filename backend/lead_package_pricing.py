"""Keep an unpaid lead's Treatment Package price in step with the package it was sold.

hp_consultation_decision copies the price onto the lead (session_package_price) when the
package is chosen, and the Treatment Fee card collects against that copy. Left alone the
copy never moves, so a rate changed in Services and Products afterwards never reached the
patients already holding the package -- the Collect UPI Payment popup kept asking for the
old figure. This re-reads the package (with the lead's own branch prices laid over it) and
writes sessions x the current rate back onto every lead still waiting to pay.

Only leads with nothing collected on the Treatment Fee are touched: once money is in, the
figure is a financial record. Left out, as everywhere else that prices a lead: House Visit
patients and branch-priced (manual) packages, whose figure was typed by the branch;
course-priced shelves, whose price is a whole course rather than a rate; and clients moved
in from an OS Data sheet, who were charged what the sheet says."""
from typing import Optional

import store_branch_overrides
from database import v3_col
from utils import PAST_MOVE_FIELD, now_iso


async def reprice_unpaid_leads(item_id: Optional[str] = None) -> int:
    """Re-price the unpaid leads holding `item_id` (every package when None). Returns how
    many leads changed."""
    q = {
        "session_package_id": {"$ne": None} if item_id is None else item_id,
        "session_package_sessions": {"$ne": None},
        "treatment_fee_paid": None,
        PAST_MOVE_FIELD: None,
    }
    leads = await v3_col("leads").find(
        q,
        {"_id": 0, "id": 1, "branch_id": 1, "session_package_id": 1, "session_package_sessions": 1,
         "session_package_price": 1, "session_package_mode": 1, "session_package_manual": 1, "visit_type": 1},
    ).to_list(5000)
    items: dict = {}
    changed = 0
    for lead in leads:
        if lead.get("visit_type") == "home" or lead.get("session_package_manual"):
            continue
        pid = lead["session_package_id"]
        if pid not in items:
            items[pid] = await v3_col("store_items").find_one({"id": pid}, {"_id": 0})
        base = items[pid]
        if not base or base.get("item_type") != "session" or base.get("price_is_total") or base.get("manual_price"):
            continue
        item = await store_branch_overrides.overlay_one(dict(base), lead.get("branch_id"))
        rate = item.get("price_online") if lead.get("session_package_mode") == "online" else item.get("price_offline")
        if rate is None:
            continue
        price = round(float(rate) * lead["session_package_sessions"], 2)
        if price != lead.get("session_package_price"):
            await v3_col("leads").update_one(
                {"id": lead["id"]},
                {"$set": {"session_package_price": price, "updated_at": now_iso()}},
            )
            changed += 1
    return changed
