from datetime import datetime, timedelta, timezone
from typing import Optional
import re


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat()


# The clinic's own clock. Every timestamp is stored UTC and every board buckets its days in
# the reader's local time, which for this company is IST — so this is what "which day did
# that happen on" means here.
CLINIC_UTC_OFFSET = timedelta(hours=5, minutes=30)

# Meta writes its offsets as +0000 as often as +00:00, and datetime.fromisoformat did not
# accept the first form until 3.11. Normalised rather than depending on the interpreter the
# VPS happens to run.
_COMPACT_OFFSET = re.compile(r"([+-]\d{2})(\d{2})$")


# Headers a sheet writes the enquiry stamp under when nobody mapped the column onto the ad
# record. Compared on letters and digits alone, the way every other header in this codebase
# is, because a form names its own columns.
#
# The list can afford to be generous: whatever it finds still has to parse as a datetime
# below, and a key holding anything else yields None and leaves the lead alone. A wrong
# guess here costs nothing; a missing spelling costs a lead its real date.
_ENQUIRY_STAMP_KEYS = {
    "createdtime", "createdat", "leadcreatedtime", "submittedat", "submittedon",
    "submissiontime", "timestamp",
}


def parse_stamp(text) -> Optional[datetime]:
    """A stored timestamp, whatever spelling it arrived in. None if it is not one.

    Three spellings reach this codebase and all three are real: now_iso() writes
    "+00:00", a Meta export writes "+0000", and rows written before either carry no
    offset at all. Callers that need to know which day something happened on should not
    each be re-learning that -- see clinic_day_of below, which is the only question any
    of them is actually asking.
    """
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(_COMPACT_OFFSET.sub(r"\1:\2", raw.replace("Z", "+00:00")))
    except ValueError:
        return None


def clinic_day_of(stamp) -> Optional[str]:
    """Which clinic day a UTC-stamped instant falls on, as "YYYY-MM-DD". None if unreadable.

    The counterpart to the range helpers on the dashboards: those draw the WINDOW on the
    clinic's clock, this puts each row that came back on a DAY on the same clock. Reading
    the day off the first ten characters of the stored string instead is a UTC day, which
    is five and a half hours out -- "2026-09-02T21:30:00+00:00" reads as 2 September, but
    the lead arrived at 03:00 on the 3rd and the branch counted it there.
    """
    moment = parse_stamp(stamp)
    if moment is None:
        return None
    # A stamp written without an offset is already UTC -- now_iso() and
    # enquiry_created_at() both write one, so this is a legacy row, not a local time.
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return (moment + CLINIC_UTC_OFFSET).date().isoformat()


def clinic_today() -> str:
    """Today, on the clinic's clock, as "YYYY-MM-DD".

    clinic_day_of applied to now, and written that way rather than as its own bit of
    offset arithmetic so there is one definition of where a clinic day starts and not two
    that can drift. The server's UTC date rolls over at 05:30 IST, so a clinic opening at
    07:00 would otherwise file its first two and a half hours of every morning under
    yesterday.

    Attendance and payroll are counted a day at a time, so everything in HR that asks
    which day it is asks this instead of reaching for date.today().
    """
    return clinic_day_of(now_iso())


def find_enquiry_stamp(ad_record, extras) -> Optional[str]:
    """The enquiry stamp on a lead, wherever the sheet happened to leave it.

    The ad record first, which is where a mapped Created Time column lands. Then
    extra_fields, because a source whose Meta columns nobody mapped -- or one synced before
    lead_data existed to map onto -- keeps them all as extra detail under their own
    headers, and those leads have a real enquiry time too. See the same split on the board,
    which reads its ad block and the stray extra_fields copy the same way.
    """
    value = (ad_record or {}).get("created_time")
    if str(value or "").strip():
        return str(value).strip()
    for key, val in (extras or {}).items():
        if re.sub(r"[^a-z0-9]", "", str(key).lower()) in _ENQUIRY_STAMP_KEYS and str(val or "").strip():
            return str(val).strip()
    return None


def enquiry_created_at(created_time) -> Optional[str]:
    """When a lead enquired, from the ad export's own created_time. None if unreadable.

    Two things are going on, and only one of them is a timezone conversion.

    A lead's created_at used to be the moment the sync ran, which is not when anybody
    enquired: a row the sheet picks up late is dated late, and the branch is shown
    yesterday's patients under today. The enquiry time is right there in the ad record, so
    that is what a lead is dated by now.

    The offset on it is the AD ACCOUNT's, not the clinic's — this install's exports are
    stamped -05:00 — and the day the clinic counts a lead on is the day Meta's own report
    puts it on. Read as an instant, an enquiry at 14:42 on the 1st in that zone is 01:12 on
    the 2nd in Chennai, and lands the lead on the wrong side of a date somebody is counting
    against. So the wall clock is kept as written and re-anchored to the clinic's day: the
    board shows 14:42 on the 1st, which is what Meta shows and what the branch counted.
    """
    text = str(created_time or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(_COMPACT_OFFSET.sub(r"\1:\2", text.replace("Z", "+00:00")))
    except ValueError:
        return None
    # The offset is dropped rather than converted — see above. What is kept is the date and
    # time the export displays, placed in the clinic's day.
    naive = dt.replace(tzinfo=None)
    return (naive - CLINIC_UTC_OFFSET).replace(tzinfo=timezone.utc).isoformat()


def derive_branch_code(branch_name: str, existing_codes) -> str:
    """First 3 letters of the branch name, uppercased (e.g. 'Anna Nagar' -> 'ANN').
    Appends a numeric suffix if that collides with an already-assigned code."""
    letters = re.sub(r"[^A-Za-z]", "", branch_name or "").upper()
    base = letters[:3] or "BRN"
    candidate = base
    i = 1
    while candidate in existing_codes:
        i += 1
        candidate = f"{base}{i}"
    return candidate


async def generate_patient_number(branch_id: Optional[str], at: Optional[str] = None) -> Optional[str]:
    """Unique per-branch Patient Number: BRANCHCODE-YYMMDD-SEQUENCE (e.g. ANN-260727-0000).
    SEQUENCE resets daily per branch via an atomic counter, so it's safe to call
    concurrently. `at` lets a backfill migration generate the number for the date the
    lead was actually created, instead of today. Returns None if the branch has no code
    yet (e.g. not migrated) or branch_id is empty."""
    if not branch_id:
        return None
    from database import v3_col
    from pymongo import ReturnDocument

    branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "code": 1})
    code = branch.get("code") if branch else None
    if not code:
        return None

    if at:
        try:
            dt = datetime.fromisoformat(at.replace("Z", "+00:00"))
        except Exception:
            dt = now_utc()
    else:
        dt = now_utc()
    day_key = dt.strftime("%y%m%d")

    counter = await v3_col("counters").find_one_and_update(
        {"_id": f"patient_number:{branch_id}:{day_key}"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = counter["seq"] - 1
    return f"{code}-{day_key}-{seq:04d}"


async def generate_transaction_id(branch_id: Optional[str]) -> str:
    """Unique, human-readable id for one collection: TXN-BRANCHCODE-YYMMDD-SEQUENCE
    (e.g. TXN-ANN-260806-0000). Same shape and same atomic per-branch-per-day counter as
    generate_patient_number, so two tills collecting at once can't land on one number.

    Every payment gets one, cash included -- it's the only identifier a cash payment has,
    and the receipt printed for the patient is traced by it. A branch with no code yet
    (or a payment with no branch, e.g. an online consultation) falls back to 'GEN' rather
    than returning nothing, because a payment without an id is the case this exists to
    stop."""
    from database import v3_col
    from pymongo import ReturnDocument

    code = None
    if branch_id:
        branch = await v3_col("branches").find_one({"id": branch_id}, {"_id": 0, "code": 1})
        code = (branch or {}).get("code")
    code = code or "GEN"

    day_key = now_utc().strftime("%y%m%d")
    counter = await v3_col("counters").find_one_and_update(
        {"_id": f"transaction_id:{code}:{day_key}"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = counter["seq"] - 1
    return f"TXN-{code}-{day_key}-{seq:04d}"


def normalize_slot_time(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed.replace(second=0, microsecond=0).isoformat(timespec="minutes")
    except Exception:
        return value.strip()[:16]


# An expert who has left is hidden rather than deleted. Their `doctors` row is what a
# patient's appointments and treatment sessions point at, so removing it would orphan real
# history; is_active: False takes them out of every list they could be picked from while
# leaving what they did intact.
#
# Written as "not False" rather than "is True" because every record created before this
# existed has no such field at all, and those people are still working here. A filter of
# {"is_active": True} would empty the Experts list on the deploy that introduced it.
# Two separate facts, both of which have to be true for a record to be offered, and
# deliberately not folded into one field.
#
# `is_active` is about the person: their login is switched off or gone, so they are not
# somebody to book at all. It is owned end to end by the account — _set_expert_active
# writes it when a login is deactivated or reactivated, and retire_experts_without_a_login
# sweeps it back into line at every startup.
#
# `branch_active` is about one posting: the person is still here, still bookable, and has
# simply been unticked from this branch in HR's branch picker. Their record for it is kept
# rather than deleted, because the days already published there and the patients booked
# into them are real (see _sync_expert_branches in routers/v3_hr.py).
#
# Written as one field, the startup sweep would read "unticked from Anna Nagar" as "login
# works, so put them back" and undo the posting change on the next restart.
#
# Both are `$ne: False`, so every record written before either field existed still counts
# as active — a missing answer is not a retirement.
ACTIVE_DOCTOR = {"is_active": {"$ne": False}, "branch_active": {"$ne": False}}


# A branch that has not been put in the trash.
#
# Archiving is how a branch is removed here — a soft delete, so its leads, its history and
# its admin survive and Branch Manager > All Archives can put it back. What archiving did
# NOT do until now was hide it: only /branch-mgmt filtered on this field, so an archived
# branch went on appearing in the Operations picker, in the Create Lead form, on the
# dashboards and in every finance and store breakdown — everywhere but the one screen it
# was archived from.
#
# `$ne: True`, not `False`, for the same reason ACTIVE_DOCTOR above is `$ne: False`: every
# branch created before this field existed has no such field at all, and a filter of
# {"archived": False} would empty the branch list on the deploy that introduced it.
LIVE_BRANCH = {"archived": {"$ne": True}}


def live_branch_query(query: dict = None) -> dict:
    """Add "not in the trash" to a `branches` query.

    A helper rather than a spelled-out clause at each call site, exactly like
    active_doctor_query below, and for exactly the same reason: there are two dozen of
    those — the pickers, the dashboards, the finance breakdowns, the store's branch list,
    HR's name map — and a list that forgets it offers a branch somebody has deleted.

    Deliberately not applied to the find_one lookups that resolve a single branch by id.
    Those answer "what is this record's branch called", and a lead or an appointment
    written before the branch was archived still happened at it; blanking that name would
    rewrite history rather than hide a choice. This hides the branch from every list it
    could be *picked* from, which is what archiving it means.
    """
    return {**(query or {}), **LIVE_BRANCH}


def active_doctor_query(query: dict = None) -> dict:
    """Add the still-with-us conditions to a `doctors` query.

    A helper rather than a spelled-out clause at each call site because there are a dozen
    of those — the consultant calendars, the assign pickers, the review dispatcher, the
    diet coach list — and a list that forgets it offers someone who cannot log in, or
    someone at a branch they no longer work.
    """
    return {**(query or {}), **ACTIVE_DOCTOR}


# A lead Past Data's "Move to live" put on the Past Data branch to try the old sheets out as
# live clients (see routers/v3_past_data.py) carries the id of that move here. They are real
# leads on that branch's own board, where they are meant to be read, and nowhere else: a
# sheet's worth of back-dated clients would otherwise land in every org-wide count at once --
# the dashboards, Pre-Sales' unowned backlog and its Distribute button, the lead lists -- and
# in front of the importers' duplicate-phone check, which would drop a returning patient's
# new enquiry as already known.
#
# `None` matches the field missing too, which is every other lead there is.
PAST_MOVE_FIELD = "past_move_id"


def without_past_moves(query: dict = None) -> dict:
    """Add "not a Past Data trial client" to an org-wide `leads` query.

    For the reads that span branches. A read of one branch's leads -- a board, a branch's
    own count -- leaves it off: on the Past Data branch those clients are the point, and on
    any other branch there are none.
    """
    return {**(query or {}), PAST_MOVE_FIELD: None}


# How many patients one physio takes in a single slot. A physio runs a floor: two or
# three people on adjacent beds inside the same hour is how the treatment room actually
# works, so one-per-slot was blocking bookings that happen in real life.
DEFAULT_PHYSIO_SLOT_CAPACITY = 3
MAX_PHYSIO_SLOT_CAPACITY = 10


def slot_capacity_of(doctor: dict) -> int:
    """Patients this doctor can hold in one slot.

    Only a Physio runs a floor. A Head Physio consultation is one-to-one however this is
    configured — it is a conversation, not a treatment room — and a Nutrition Coach's
    check-in is the same shape: a weigh-in and a talk, one patient at a time. Both stay at
    1 regardless of any value stored on the record. If group check-ins are ever wanted,
    this is the one line that changes.
    """
    if (doctor or {}).get("profile_type") != "physio":
        return 1
    raw = (doctor or {}).get("slot_capacity")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_PHYSIO_SLOT_CAPACITY
    # Clamped rather than trusted: a 0 or a negative would take the physio off the
    # calendar entirely, which no one would set on purpose and nothing else would explain.
    return max(1, min(n, MAX_PHYSIO_SLOT_CAPACITY))


# The two courses a physio delivers off one published calendar: treatment days in
# `sessions`, rehab days in `rehab_sessions`. They are separate collections on purpose —
# v3_rehab's docstring sets out at length what folding rehab into `sessions` breaks — but
# they are the same physio, in the same room, in the same half hour, so "how full is this
# slot" has to read both. Counting only one is how a physio ends up owing two patients the
# same hour; counting them differently in two places is how the picker draws an open seat
# and the assign endpoint then refuses it.
PHYSIO_COURSE_COLLECTIONS = ("sessions", "rehab_sessions")

# What a row in each collection is called, so a refusal names the thing the branch has to
# go and move rather than just reporting a number.
PHYSIO_COURSE_DAY = {"sessions": "treatment day", "rehab_sessions": "rehab day"}


async def physio_slot_load(physio_id: str, slots, lead_id: str = None, replacing: str = None):
    """How busy each of these slots already is for this physio, and where this lead sits in it.

    Returns `(taken, lead_elsewhere)`.

    `taken[slot]` is the patients holding that slot across both courses. Rows belonging to
    `lead_id` in the `replacing` collection are left out: an assign call rewrites that
    lead's whole course in one go, so the days they hold today are not a clash with the
    days they are being given — without this, re-confirming a patient onto the very times
    they already have is refused as a conflict with themselves.

    This is deliberately the same arithmetic the slot picker does to draw its seat dots.
    get_doctor_calendar tags every occupant with the course it came from so the picker can
    discount exactly this lead's rows on exactly the course being replaced and nothing
    else. The two have to agree: when they drifted apart, a patient's own treatment day
    silently filled a seat the picker had already shown as free, and booking their rehab
    course came back "Full for this physio" on slots the branch had just been offered.

    `lead_elsewhere[slot]` is set when this lead already holds that slot on the *other*
    course. The physio may well have a free seat there, but the patient cannot be on the
    treatment floor and in rehab in the same half hour, so it is refused on its own terms
    rather than folded into the seat count — which would have reported the patient's own
    booking as somebody else's and given the branch nothing to act on.
    """
    from database import v3_col

    slots = list(slots)
    taken: dict = {}
    lead_elsewhere: dict = {}
    for collection in PHYSIO_COURSE_COLLECTIONS:
        rows = await v3_col(collection).find(
            {"physio_id": physio_id, "status": "upcoming", "slot_time": {"$in": slots}},
            {"_id": 0, "slot_time": 1, "lead_id": 1},
        ).to_list(1000)
        for row in rows:
            slot = row["slot_time"]
            if lead_id and row.get("lead_id") == lead_id:
                if collection == replacing:
                    continue
                lead_elsewhere[slot] = PHYSIO_COURSE_DAY[collection]
            taken[slot] = taken.get(slot, 0) + 1
    return taken, lead_elsewhere
