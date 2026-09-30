"""Writing the Past Data tables -- the one place an import is put down or taken back out.

Shared by the two ways an import happens: tools/past_data_import.py from a terminal, and the
Add Sheet button on Settings > Import/Export (routers/v3_past_data.py). One copy, so the two
cannot drift into writing a sheet two different ways.

Each function takes `col`, the collection getter, rather than importing database.py at the
top: the terminal tool reads and reports on a workbook where there is no .env at all -- the
laptop it is being cleaned on -- and database.py reads MONGO_URL the moment it is imported.

Where it writes: past_clients, past_treatments, past_payments, and one row per import in
past_imports. Nothing else -- not leads, not lead_activity, not sessions. That is the whole
design (see past_data.py): the live boards, dashboards and finance figures read those other
collections, so none of them can see a row written here.

Every row carries the batch id of the import that wrote it, so one import comes back out
exactly. A branch may hold several -- one per sheet uploaded, each shown and disconnected on
its own. A replace writes the new batch in full before the caller removes the old one, so a
failure half way leaves the old data standing rather than nothing.
"""
import re
import uuid
from datetime import datetime, timezone

import past_data

COLLECTIONS = ("past_clients", "past_treatments", "past_payments")
CHUNK = 500


def file_label(source_file: str) -> str:
    """A sheet's name when nobody gave it one: the file's, without its folder or extension."""
    return re.sub(r"\.[^.]+$", "", re.split(r"[\\/]", source_file or "")[-1]).strip()


def sheet_label(batch: dict) -> str:
    return batch.get("label") or file_label(batch.get("source_file", "")) or batch.get("id", "")


async def find_branch(col, code: str):
    """The branch by its code, archived or not -- an archived branch's import must still be
    findable to --remove from."""
    rows = await col("branches").find(
        {"code": {"$regex": f"^{code}$", "$options": "i"}},
        {"_id": 0, "id": 1, "branch_name": 1, "code": 1, "archived": 1},
    ).to_list(5)
    return rows[0] if len(rows) == 1 else None


async def live_imports(col, branch_id: str = None) -> list:
    """The imports not taken back out, oldest first -- one branch's, or every branch's."""
    query = {"removed_at": None}
    if branch_id:
        query["branch_id"] = branch_id
    return await col("past_imports").find(query, {"_id": 0}).sort("imported_at", 1).to_list(50)


async def home_branch_id(col):
    """The branch new sheets are added on: the one the first sheet ever went into, or None
    before any import. A sheet can be connected to another branch after (set_branch), and its
    branch_id moves with it, so the first one's origin_branch_id is what keeps this fixed."""
    first = await col("past_imports").find(
        {}, {"_id": 0, "branch_id": 1, "origin_branch_id": 1},
    ).sort("imported_at", 1).to_list(1)
    if not first:
        return None
    return first[0].get("origin_branch_id") or first[0].get("branch_id")


async def set_branch(col, batch_id: str, branch) -> None:
    """Connect one sheet to `branch`, or to no branch when it is None: the log row and every
    row the sheet wrote, so the branch's Past Data tab and the reads scoped to it follow.

    The branch it was added on is kept once, as origin_branch_id, for home_branch_id."""
    current = await col("past_imports").find_one({"id": batch_id}, {"_id": 0, "branch_id": 1}) or {}
    await col("past_imports").update_one(
        {"id": batch_id, "origin_branch_id": {"$exists": False}},
        {"$set": {"origin_branch_id": current.get("branch_id")}},
    )
    branch_id = branch["id"] if branch else None
    for name in COLLECTIONS:
        await col(name).update_many({"batch_id": batch_id}, {"$set": {"branch_id": branch_id}})
    await col("past_imports").update_one(
        {"id": batch_id},
        {"$set": {"branch_id": branch_id, "branch_code": (branch or {}).get("code", "")}},
    )


async def remove_batch(col, batch_id: str, removed_by: str = "") -> dict:
    removed = {}
    for name in COLLECTIONS:
        result = await col(name).delete_many({"batch_id": batch_id})
        removed[name] = result.deleted_count
    await col("past_imports").update_one(
        {"id": batch_id},
        {"$set": {"removed_at": datetime.now(timezone.utc).isoformat(), "removed_by": removed_by}},
    )
    return removed


async def write_batch(
    col, data: past_data.PastData, branch: dict, source_file: str, file_sha256: str,
    now=None, imported_by: str = "", label: str = "",
) -> str:
    """Write one import and log it. Returns the batch id.

    The log row goes in last, once every record is down: a batch the log does not name is
    one that never finished, and the except below clears it out again. The Past Data reads
    only ever look at batches the log names, so a half-written one is never shown either.
    """
    now = now or datetime.now(timezone.utc)
    # The time for a person reading it, and four random characters so two runs inside one
    # second -- a replace straight after an import -- cannot share an id. They would
    # otherwise, and removing the old batch would take the new one out with it.
    batch_id = "PDI-" + now.strftime("%y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    stamp = {
        "branch_id": branch["id"],
        "batch_id": batch_id,
        "source_file": source_file,
        "imported_at": now.isoformat(),
    }
    rows = {
        "past_clients": data.clients,
        "past_treatments": data.treatments,
        "past_payments": data.payments,
    }
    try:
        for name, records in rows.items():
            for start in range(0, len(records), CHUNK):
                # Copies, so Mongo's _id lands on them and not on the caller's dicts.
                await col(name).insert_many([{**r, **stamp} for r in records[start:start + CHUNK]])
        s = past_data.summary(data)
        await col("past_imports").insert_one({
            "id": batch_id,
            "branch_id": branch["id"],
            "branch_code": branch.get("code", ""),
            "source_file": source_file,
            # What the Past Data tab calls this sheet -- "Parrys", say, where every branch's
            # file is "Revenue Sheet new.xlsx".
            "label": (label or "").strip()[:80] or file_label(source_file),
            "layout": data.layout,
            "tabs": list(data.tabs),
            # The OS Data workbook's: which kinds it held (Lead, Sessions, Revenue -- the
            # Import/Export Type column), and the sessions and reviews carried on its clients.
            "types": list(data.types),
            "tab_rows": dict(data.tab_rows),
            "sessions_count": data.sessions_read,
            "reviews_count": data.reviews_read,
            # The tabs and columns Auto Scan left on, and each one's OS field on a custom
            # sheet -- empty when the whole workbook was read (the terminal tool).
            "columns": list(data.columns),
            "file_sha256": file_sha256,
            "counts": {name: len(records) for name, records in rows.items()},
            "paid_total": sum(c["paid_total"] for c in data.clients),
            "outstanding_total": sum(c["outstanding_total"] for c in data.clients),
            "findings": s["findings"],
            "imported_by": imported_by,
            "imported_at": now.isoformat(),
            "removed_at": None,
        })
    except Exception:
        for name in COLLECTIONS:
            await col(name).delete_many({"batch_id": batch_id})
        raise
    return batch_id
