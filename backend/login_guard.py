"""Two limits on signing in: how long a session lasts, and how many wrong passwords a login
takes before it is locked.

Sessions. A token used to live until somebody pressed Log Out, so one copied off a machine
kept working forever. Every session -- staff and Client Portal alike -- now ends
SESSION_HOURS after the sign-in that made it, in use or not, and the person signs in again.
It is measured from created_at, which every session collection already stamps, so sessions
already open when this shipped are aged from their own sign-in rather than handed a fresh
twelve hours.

Wrong passwords. MAX_WRONG_PASSWORDS tries in a row on one login, without a right one in
between, lock that login for LOCK_MINUTES -- the right password included, which is the
point. Counted per login as typed (an email, or a portal phone number), not per account, so
a login nobody owns locks exactly like a real one and the lock says nothing about which
logins exist. A run of wrong tries that goes quiet for LOCK_MINUTES starts over, and that is
also how a lock ends.

The counter lives in Mongo, not in memory, so a restart or a second worker does not hand out
a fresh five.
"""
import math
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from database import v3_col
from utils import now_utc

SESSION_HOURS = 12
MAX_WRONG_PASSWORDS = 5
LOCK_MINUTES = 10


# --------------------------------------------------------------------- Session expiry

def _as_utc(value) -> Optional[datetime]:
    """A stored timestamp as an aware UTC datetime: an ISO string from now_iso(), or a BSON
    date, which the driver hands back naive."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def session_expired(session: dict) -> bool:
    """Whether this session is past its SESSION_HOURS. One with no readable created_at is
    treated as expired: every sign-in stamps one, so a row without it predates them all."""
    created = _as_utc(session.get("created_at"))
    return created is None or now_utc() - created >= timedelta(hours=SESSION_HOURS)


def expired_before() -> str:
    """created_at below this is an expired session. ISO strings from now_iso() sort in time
    order, so a range on the stored string finds them without parsing each row."""
    return (now_utc() - timedelta(hours=SESSION_HOURS)).isoformat()


# --------------------------------------------------------------------- Wrong passwords

def _attempts():
    # Keyed on _id, which Mongo keeps unique on its own, so two first tries landing at once
    # cannot each open a separate count.
    return v3_col("login_attempts")


def _locked(last_at, now: datetime) -> HTTPException:
    started = _as_utc(last_at) or now
    left = started + timedelta(minutes=LOCK_MINUTES) - now
    minutes = max(1, math.ceil(left.total_seconds() / 60))
    unit = "minute" if minutes == 1 else "minutes"
    return HTTPException(
        status_code=429,
        detail=f"Too many wrong passwords. This login is locked; try again in {minutes} {unit}.",
    )


async def count_try(key: str) -> None:
    """Count one sign-in try against `key` before its password is checked, or refuse it.

    Counted first, and in one atomic step, rather than checked here and counted only after
    the password turns out wrong: bcrypt takes a moment, and a burst of parallel requests
    would all pass a check made before any of them had failed. Taking the try up front means
    the sixth of a burst is refused however close together they land. The count is wiped by
    clear() when the password is right, so only wrong ones are left standing.
    """
    now = now_utc()
    quiet_since = now - timedelta(minutes=LOCK_MINUTES)
    for _ in range(3):
        # A run of tries still under the cap, the last of them recent.
        row = await _attempts().find_one_and_update(
            {"_id": key, "count": {"$lt": MAX_WRONG_PASSWORDS}, "last_at": {"$gt": quiet_since}},
            {"$inc": {"count": 1}, "$set": {"last_at": now}},
        )
        if row:
            return
        # No count yet, or the last try was long enough ago to start over -- which is how a
        # lock ends too. A recent row fails the filter, so the upsert tries to insert a
        # second document under the same _id and is refused.
        try:
            await _attempts().update_one(
                {"_id": key, "last_at": {"$lte": quiet_since}},
                {"$set": {"count": 1, "last_at": now}},
                upsert=True,
            )
            return
        except DuplicateKeyError:
            pass
        row = await _attempts().find_one({"_id": key})
        if row and row.get("count", 0) >= MAX_WRONG_PASSWORDS:
            raise _locked(row.get("last_at"), now)
        # Under the cap after all: another request opened or restarted the count between
        # the two steps above. Go round again and add to it.
    raise _locked(now, now)


async def refuse(key: str, detail: str) -> None:
    """Answer a wrong password: the usual 401, or the lock once this try was the last one
    allowed. The try itself was already counted by count_try()."""
    row = await _attempts().find_one({"_id": key})
    if row and row.get("count", 0) >= MAX_WRONG_PASSWORDS:
        raise _locked(row.get("last_at"), now_utc())
    raise HTTPException(status_code=401, detail=detail)


async def clear(key: str) -> None:
    """The password was right: the wrong ones before it no longer count."""
    await _attempts().delete_one({"_id": key})
