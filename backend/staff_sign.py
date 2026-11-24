"""Staff signs: the picture of a person's signature that prints on the clinic's papers.

Uploaded by the person themselves at My Profile > Sign Upload (routers/v3_staff_sign.py), and put
on by itself where they are the one who signs:

    Bill / Receipt      whoever collected the payment
    Consultation Form   the therapist named on page 3
    Prescription        the consultant printed on it

Kept here and nowhere else: not under uploads/, which is public, and not on the login, which
half the app reads. A sign leaves only on a paper or to its own person.

A person has one row for each sign they have had. A paper carries the one that was theirs on
its day, so a new sign does not re-sign what the old one was on. Two uploads on one day are a
correction: the second takes the first's place. Deleting takes all of theirs, so every paper is
unsigned until they have another, which then signs the old ones too.

Payments and forms record a name and no login, so a person is found by name. Where two logins
share one and the branch does not tell them apart, the line is left blank: an unsigned paper
can be signed by hand, one with somebody else's sign on it cannot be taken back.
"""
import base64
import logging
import re
import struct
import uuid
from datetime import timezone
from typing import Dict, List, Optional

from database import v3_col
from deps import consultants_serving_branch
from utils import active_doctor_query, clinic_day_of, clinic_today, now_iso, parse_stamp

logger = logging.getLogger(__name__)

COL = "staff_signatures"

# What the sign editor sends: a trimmed PNG, the paper around the ink already cleared.
MAX_BYTES = 400 * 1024
MAX_WIDTH, MAX_HEIGHT = 1200, 600
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# A login posted to every branch carries this in branch_ids (see routers/v3_hr.py).
ALL_BRANCHES = "__all__"
PERSON_FIELDS = {"_id": 0, "id": 1, "full_name": 1, "role": 1, "branch_id": 1, "branch_ids": 1, "is_active": 1}
TITLES = {"dr", "mr", "mrs", "ms", "miss"}


def name_key(name) -> str:
    """A name as it is compared: "Dr. Asha  K." and "asha k" are one person."""
    words = re.sub(r"[\W_]+", " ", str(name or "").lower()).split()
    while len(words) > 1 and words[0] in TITLES:
        words.pop(0)
    return " ".join(words)


def png_size(data: bytes) -> Optional[tuple]:
    """(width, height) of a PNG, or None for anything else."""
    if len(data) < 33 or not data.startswith(PNG_MAGIC) or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def data_url(row: Optional[dict]) -> str:
    return f"data:image/png;base64,{row['image']}" if row and row.get("image") else ""


def _moment(stamp):
    at = parse_stamp(stamp)
    if at is None:
        return None
    # A stamp with no offset on it is UTC, as now_iso's are.
    return at.replace(tzinfo=timezone.utc) if at.tzinfo is None else at


def pick(rows: List[dict], at: str = "") -> Optional[dict]:
    """The sign that was theirs at a moment, off their rows oldest first. A paper from before
    their first one takes the sign they have now."""
    if not rows:
        return None
    when = _moment(at)
    if when is None:
        return rows[-1]
    held = [r for r in rows if (_moment(r.get("valid_from")) or when) <= when]
    return held[-1] if held else rows[-1]


async def _rows(user_id: str) -> List[dict]:
    return await v3_col(COL).find({"user_id": user_id}, {"_id": 0}).sort("valid_from", 1).to_list(100)


async def of_user(user_id: Optional[str], at: str = "") -> Optional[dict]:
    return pick(await _rows(user_id), at) if user_id else None


async def by_id(sign_id: Optional[str]) -> Optional[dict]:
    return await v3_col(COL).find_one({"id": sign_id}, {"_id": 0}) if sign_id else None


async def save(person: dict, png: bytes, by: dict) -> dict:
    """Keep a person's new sign. `by` is the login uploading it."""
    now = now_iso()
    fields = {
        "image": base64.b64encode(png).decode("ascii"),
        "name": person.get("full_name") or "",
        "uploaded_at": now, "uploaded_by": by.get("full_name") or "", "uploaded_by_id": by.get("id") or "",
    }
    rows = await _rows(person["id"])
    last = rows[-1] if rows else None
    if last and clinic_day_of(last.get("valid_from")) == clinic_today():
        await v3_col(COL).update_one({"id": last["id"]}, {"$set": fields})
        return {**last, **fields}
    row = {"id": str(uuid.uuid4()), "user_id": person["id"], "valid_from": now, **fields}
    await v3_col(COL).insert_one(row.copy())
    return row


async def remove(person: dict, by: dict) -> bool:
    """Delete a person's sign, every one they have had. False when there was none."""
    res = await v3_col(COL).delete_many({"user_id": person["id"]})
    if res.deleted_count:
        logger.info(f"Sign of {person.get('id')} deleted by {by.get('id')}")
    return bool(res.deleted_count)


def is_posted(user: dict, branch_id: str) -> bool:
    at = [user.get("branch_id"), *(user.get("branch_ids") or [])]
    return bool(branch_id) and (branch_id in at or ALL_BRANCHES in at)


async def people_at(branch_id: str) -> Dict[str, dict]:
    """login id -> login, for everyone working at a branch: those posted to it, the physios
    with a record there and the consultants who take consultations there. `consults` marks
    the last, whose role need not say so (a Super Admin taking consultations)."""
    if not branch_id:
        return {}
    people: Dict[str, dict] = {}
    async for u in v3_col("users").find(
        {"is_active": {"$ne": False}, "$or": [{"branch_id": branch_id}, {"branch_ids": {"$in": [branch_id, ALL_BRANCHES]}}]},
        PERSON_FIELDS,
    ):
        people[u["id"]] = u

    records = await v3_col("doctors").find(
        active_doctor_query({"profile_type": {"$in": ["head_physio", "physio"]}}),
        {"_id": 0, "profile_type": 1, "branch_id": 1, "user_id": 1},
    ).to_list(5000)
    here = [
        r for r in await consultants_serving_branch(records, branch_id)
        if r.get("user_id") and (r.get("profile_type") == "head_physio" or r.get("branch_id") == branch_id)
    ]
    missing = list({r["user_id"] for r in here} - set(people))
    if missing:
        async for u in v3_col("users").find({"id": {"$in": missing}, "is_active": {"$ne": False}}, PERSON_FIELDS):
            people[u["id"]] = u
    for r in here:
        if r["profile_type"] == "head_physio" and r["user_id"] in people:
            people[r["user_id"]]["consults"] = True
    return people


def one_named(name, people: List[dict], branch_id: str = "") -> Optional[dict]:
    """The one login of that name, or None. Of two, the one at the branch; of two there, the
    one still working; and still two is nobody."""
    key = name_key(name)
    found = [p for p in people if key and name_key(p.get("full_name")) == key]
    for holds in (lambda p: is_posted(p, branch_id), lambda p: p.get("is_active") is not False):
        if len(found) > 1:
            found = [p for p in found if holds(p)] or found
    return found[0] if len(found) == 1 else None


async def user_named(name, branch_id: str = "") -> Optional[dict]:
    """one_named over every login, whoever has left included: their papers stay signed."""
    words = name_key(name).split()
    if not words:
        return None
    rows = await v3_col("users").find(
        {"full_name": {"$regex": re.escape(max(words, key=len)), "$options": "i"}}, PERSON_FIELDS,
    ).to_list(1000)
    return one_named(name, rows, branch_id)


async def collector_sign(name, branch_id: str, at: str) -> str:
    """A bill's sign: whoever took the payment. "" where there is none, and never an error --
    the money has been taken, and the bill is handed over with or without it."""
    try:
        person = await user_named(name, branch_id)
        return data_url(await of_user(person["id"], at)) if person else ""
    except Exception as e:
        logger.warning(f"Bill sign not read: {type(e).__name__}: {e}")
        return ""


async def therapist_sign(name, branch_id: str) -> Optional[dict]:
    """The sign of the therapist a Consultation Form names, off the branch's own people. The
    name is typed by the desk, so a name from another branch signs nothing."""
    if not name_key(name):
        return None
    person = one_named(name, list((await people_at(branch_id)).values()), branch_id)
    return await of_user(person["id"]) if person else None


async def form_sign(form: dict) -> Optional[dict]:
    """A Consultation Form's sign: the one it was saved with, so it stays when the therapist
    moves or changes theirs; else the therapist's own, for one saved before they had one."""
    if not (form.get("therapist_name") or "").strip():
        return None
    return await by_id(form.get("therapist_sign_id")) or await therapist_sign(form["therapist_name"], form.get("branch_id") or "")


async def consultant_sign(lead: dict) -> Optional[dict]:
    """A prescription's sign and whose it is: { name, image }. The consultant it prints is the
    lead's assigned one, so that expert's login -- as long as it goes by the same name."""
    printed = (lead.get("assigned_physio_name") or "").strip()
    if not printed:
        return None
    person = None
    doctor = await v3_col("doctors").find_one(
        {"id": lead.get("assigned_physio_id")}, {"_id": 0, "user_id": 1, "full_name": 1},
    ) if lead.get("assigned_physio_id") else None
    if doctor and doctor.get("user_id") and name_key(doctor.get("full_name")) == name_key(printed):
        person = await v3_col("users").find_one({"id": doctor["user_id"]}, PERSON_FIELDS)
    person = person or await user_named(printed, lead.get("branch_id") or "")
    if not person:
        return None
    day = str(lead.get("appointment_date") or "")[:10]
    # The end of that day by the clinic's clock: a sign uploaded during it is the one used.
    at = f"{day}T18:29:59+00:00" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else ""
    image = data_url(await of_user(person["id"], at))
    return {"name": printed, "image": image} if image else None
