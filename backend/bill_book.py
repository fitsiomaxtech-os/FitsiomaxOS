"""Bill numbers: one running series per branch, given out as each payment is taken.

FM-ANN-0001, FM-ANN-0002 ... Kept in a collection of its own rather than on the five records
a payment can be (a lead's activity, a store sale, a class fee, a membership, an old client's
instalment): the number is found by the transaction id, whichever book the money is in.

Payments taken before the bill book have no row here and print their Transaction ID alone.
A number is never given twice. Undoing a payment does not return its number.
"""

import logging
from typing import List, Optional

from database import v3_col
from utils import now_iso

logger = logging.getLogger(__name__)


async def open_bill(transaction_id: str, branch_id: Optional[str], code: str, *, bill_with: Optional[str] = None, info: Optional[dict] = None) -> str:
    """Give a transaction its Bill No.

    `bill_with`: a transaction paid in the same breath, whose bill this one goes on -- a Pre
    Book's consultation and advance are one payment on one bill. `info` is kept on the row,
    for the payments whose own record keeps only a running total.

    Never raises: the money has been taken, and a payment without a Bill No. still prints
    its Transaction ID. A failed write is logged instead.
    """
    from pymongo import ReturnDocument

    try:
        partner = await v3_col("payment_bills").find_one({"transaction_id": bill_with}, {"_id": 0}) if bill_with else None
        if partner:
            bill_no, group = partner["bill_no"], partner.get("group") or partner["transaction_id"]
        else:
            counter = await v3_col("counters").find_one_and_update(
                {"_id": f"bill_no:{code}"}, {"$inc": {"seq": 1}}, upsert=True, return_document=ReturnDocument.AFTER,
            )
            bill_no, group = f"FM-{code}-{counter['seq']:04d}", transaction_id
        await v3_col("payment_bills").insert_one({
            "transaction_id": transaction_id,
            "bill_no": bill_no,
            # The transactions on one bill share this. Not the number itself: a bill is only
            # ever joined to another on purpose.
            "group": group,
            "branch_id": branch_id or "",
            "created_at": now_iso(),
            **(info or {}),
        })
        return bill_no
    except Exception as e:
        logger.warning(f"Bill No. not given to {transaction_id}: {type(e).__name__}: {e}")
        return ""


async def bill_registration_payment(source: str, registration: dict, info: dict, by: str) -> str:
    """A Transaction ID and Bill No. for money taken on a Zumba or Fitness registration,
    which keep a running total and no payments of their own. Returns the transaction id, or
    "" when it could not be given -- the payment itself is already recorded."""
    from utils import generate_transaction_id

    try:
        return await generate_transaction_id(
            registration.get("branch_id"),
            bill_info={**info, "source": source, "registration_id": registration.get("id"), "collected_by": by},
        )
    except Exception as e:
        logger.warning(f"{source} payment on {registration.get('id')} has no bill: {type(e).__name__}: {e}")
        return ""


async def registration_bills(ids: List[str]) -> dict:
    """Registration id -> its bills, oldest first, for the ledger's Receipt buttons."""
    ids = [i for i in ids if i]
    if not ids:
        return {}
    rows = await v3_col("payment_bills").find(
        {"registration_id": {"$in": ids}, "void": {"$ne": True}},
        {"_id": 0, "transaction_id": 1, "bill_no": 1, "registration_id": 1, "amount": 1, "created_at": 1},
    ).sort("created_at", 1).to_list(20000)
    out: dict = {}
    for r in rows:
        out.setdefault(r["registration_id"], []).append({
            "transaction_id": r["transaction_id"], "bill_no": r.get("bill_no") or "",
            "amount": r.get("amount") or 0, "date": r.get("created_at") or "",
        })
    return out


async def void_registration_bills(registration_id: str) -> None:
    """The registration's payments were undone: its bills are no longer offered."""
    await v3_col("payment_bills").update_many({"registration_id": registration_id}, {"$set": {"void": True}})
