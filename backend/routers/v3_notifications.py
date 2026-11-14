"""The header bell: a person's own notifications.

One row per thing somebody should hear about, addressed to one login. Today the only
writer is a leave or permission being approved or rejected (routers/v3_hr_ops.py ->
notify_request_decision); the reader is the bell every signed-in user has in the header.

Every endpoint here is scoped to the caller's own user id -- nothing reads or marks
another person's notifications.
"""
import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends

from database import v3_col
from deps import v3_current_user
from schemas.v3 import V3UserOut
from utils import now_iso

router = APIRouter(prefix="/api/v3")

KIND_LABEL = {"leave": "Leave", "permission": "Permission"}


async def _login_for_request(row: Dict[str, Any]) -> str:
    """The login a request belongs to: whoever raised it, else the account on that employee."""
    if row.get("source") == "self" and row.get("requested_by_user_id"):
        return row["requested_by_user_id"]
    if row.get("employee_id"):
        acct = await v3_col("users").find_one({"employee_id": row["employee_id"]}, {"_id": 0, "id": 1})
        if acct:
            return acct["id"]
    return ""


async def notify_request_decision(row: Dict[str, Any], decision: str, by: str, note: str = "") -> None:
    """Tell the person their leave / permission was approved or rejected.

    Reopening (back to pending) withdraws the earlier notice instead, so the bell never
    says "Approved" about a request that is undecided again.
    """
    if row.get("kind") not in KIND_LABEL:
        return
    await v3_col("notifications").delete_many({"ref_id": row.get("id"), "type": "request_decision"})
    if decision not in ("approved", "rejected"):
        return
    user_id = await _login_for_request(row)
    if not user_id:
        return
    label = KIND_LABEL[row["kind"]]
    await v3_col("notifications").insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "type": "request_decision",
        "ref_id": row.get("id"),
        "status": decision,
        "title": f"{label} {decision.capitalize()}",
        "kind": row["kind"],
        "from_date": row.get("from_date") or "",
        "to_date": row.get("to_date") or "",
        "from_time": row.get("from_time") or "",
        "to_time": row.get("to_time") or "",
        "days": row.get("days") or 0,
        "note": (note or "").strip(),
        "by": by or "",
        "read": False,
        "created_at": now_iso(),
    })


@router.get("/notifications")
async def my_notifications(user: V3UserOut = Depends(v3_current_user)):
    rows = await v3_col("notifications").find(
        {"user_id": user.id}, {"_id": 0},
    ).sort("created_at", -1).to_list(50)
    unread = await v3_col("notifications").count_documents({"user_id": user.id, "read": False})
    return {"notifications": rows, "unread": unread}


@router.post("/notifications/read-all")
async def read_all(user: V3UserOut = Depends(v3_current_user)):
    res = await v3_col("notifications").update_many(
        {"user_id": user.id, "read": False}, {"$set": {"read": True}},
    )
    return {"updated": res.modified_count}


@router.delete("/notifications")
async def clear_all(user: V3UserOut = Depends(v3_current_user)):
    res = await v3_col("notifications").delete_many({"user_id": user.id})
    return {"deleted": res.deleted_count}
