"""Whether a Consultant's booked time blocks anyone else from the same time.

On (the default), every consultation and review holds its Consultation Duration on the
Consultant's day, and a second booking that runs into it is refused. Off, the duration
blocks nothing: the branch can put several patients at 10:25 with the same Consultant,
which is how a busy branch actually runs its consultation desk — patients arrive
together and wait their turn, and a 10-minute grid only made the desk invent times.

One switch for every branch, set in Developer Access. Read on every request, so flipping
it changes the next booking straight away.
"""
from database import v3_col

SETTING_ID = "consultation_duration_rule"


async def duration_rule_enabled() -> bool:
    """On unless a developer switched it off."""
    row = await v3_col("app_settings").find_one({"id": SETTING_ID}, {"_id": 0})
    return True if not row else bool(row.get("enabled", True))
