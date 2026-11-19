"""Keeps a course's day numbers running in the same order as its dates.

Treatment and rehab days are worked strictly by number: the physio board refuses a day
whose predecessors are not signed off (v3_physio_board._first_incomplete_before). So a
day that has lost its date while a later-numbered day still holds one jams the course.
The later day cannot be delivered when it comes round, and Missed Classes cannot place
the dateless one either, because its date would have to fall between days that are
already booked, and usually there is no time free between them.

The fix is to move the numbers, not the dates. Every open day of the course keeps its own
hour, its physio and whatever an absence or a cover wrote on it. Only the "Day N" labels
are handed out again, earliest date first, with the dateless days at the end. The patient
keeps every time they agreed to; the dateless day becomes the last day of the course,
which is the only place it can go, and is booked after the days already held.

Open days carry nothing that belongs to their number. Remarks and treatments are written
when a day is signed off, and completed days are never renumbered.
"""
from database import v3_col
from utils import now_iso

# (collection, the field that numbers a day in it)
TREATMENT = ("sessions", "session_number")
REHAB = ("rehab_sessions", "day_number")


async def keep_days_in_date_order(collection: str, num_field: str, lead_id: str) -> dict:
    """Renumber this lead's open days of one course so the numbers follow the dates.

    Returns {row id: new number} for the rows that changed. Empty when the course is
    already in order, which is the usual case.
    """
    if not lead_id:
        return {}
    rows = await v3_col(collection).find(
        {"lead_id": lead_id, "status": {"$ne": "completed"}},
        {"_id": 0, "id": 1, num_field: 1, "week_number": 1, "slot_time": 1},
    ).to_list(2000)
    if len(rows) < 2:
        return {}

    by_number = sorted(rows, key=lambda r: r.get(num_field) or 0)
    # The places in the course, in order. A week number goes with its place, not with the
    # row: week 3 is the third week of the course whichever row ends up working it.
    places = [(r.get(num_field), r.get("week_number")) for r in by_number]

    # Dated days first, by date; then the dateless ones. The sort is stable, so days that
    # tie (both dateless, or two sharing an hour) keep their current order.
    def date_order(r):
        slot = (r.get("slot_time") or "").strip()
        return (0 if slot else 1, slot)

    by_date = sorted(by_number, key=date_order)

    changed: dict = {}
    for row, (number, week) in zip(by_date, places):
        if row.get(num_field) == number:
            continue
        fields = {num_field: number, "updated_at": now_iso()}
        if week is not None:
            fields["week_number"] = week
        await v3_col(collection).update_one({"id": row["id"]}, {"$set": fields})
        changed[row["id"]] = number
    return changed
