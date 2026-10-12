"""Which expert records belong to which expert, and which leads they are responsible for.

Both desks, because both ask the same two questions and got different answers when the
physio half lived here and the consultant half lived in its own board.
"""
from typing import Optional

from fastapi import HTTPException

from database import v3_col
from deps import collapse_duplicate_experts, is_branch_admin_role, works_org_wide
from utils import clinic_today


def _ids(physio_id) -> list:
    """One record id or several, always as a list.

    Every caller here used to pass a single expert record id, because one physio was taken
    to mean one `doctors` row. They routinely hold several -- see resolve_physio_doctor --
    so these take either now, and a plain string keeps working unchanged for the callers
    that genuinely have one.
    """
    if not physio_id:
        return []
    if isinstance(physio_id, str):
        return [physio_id]
    return [p for p in physio_id if p]


async def resolve_physio_doctor(user_id: str, role: str = "", physio_id: Optional[str] = None) -> Optional[dict]:
    """The expert records belonging to the physio who is logged in, and which to open on.

    A physio's board starts from a LOGIN and has to find the `doctors` record it belongs
    to. Assign Physio never does: it writes the id of a record taken straight from the
    branch's expert list into sessions.physio_id and leads.assigned_physio_id, and never
    needs the login at all. Two ends of the same link -- and they part company the moment
    one person holds more than one record.

    They routinely do. Half a dozen paths mint these records and most carry no user_id to
    dedupe against -- 26 of the 29 physio records in the db_backup snapshot have none --
    so HR's branch sync cannot see what is already there and adds another beside it.
    collapse_duplicate_experts exists because Assign Physio was offering one physio three
    times over.

    This resolver was a find_one on user_id with an employee_id fallback, so it landed on
    at most one of those records, and on none at all where none of them carried the link.
    Every endpoint hanging off it then answered {"patients": []} and the board read 0
    across every tile with nothing on screen to say why -- which is exactly what "I
    assigned the physio and their master view is empty" looks like from the inside.

    So every record the person holds is collected, and the reads are scoped to all of them
    rather than to one. Which record the branch happened to book against stops mattering,
    and nothing is stranded on a twin: the physio sees their patients whichever of their
    own records the days were filed under.

    Three routes in, each tried only when the one before it finds nothing:

      1. doctors.user_id == the login's id -- the link, where it was ever written.
      2. users.employee_id -> doctors.employee_id -- the profile-only rows Fitsiomax
         Experts creates carry no user_id, but do carry the employee they were made for.
      3. the person's own name, among records carrying NO user_id at all.

    The third answers the common state, and it is fenced: a record already linked to
    another login is never claimed, so the wrong answer needs two physios of one name with
    an unlinked record between them. That is the trade collapse_duplicate_experts already
    makes when it merges on the name, for the reason it gives -- the pickers show a name
    and nothing else, so two of them were already indistinguishable there. Records at the
    person's own branch are preferred where any answer, so a namesake elsewhere loses to
    the physio actually standing there.

    Read-only. Nothing is merged, deleted or linked here: moving bookings between records
    is not a repair a page load should be making, and which record is the one to keep is a
    question about the data rather than about the code -- tools/physio_board_check.py
    answers it on the server.

    The record RETURNED is the survivor collapse_duplicate_experts would keep, so the board
    opens on the same row Assign Physio offers and the branch publishes hours against: its
    slots are the calendar, and its id is what a new assessment is filed under. The whole
    set rides along on `physio_ids`, which is what the reads scope by.
    """
    if physio_id and works_org_wide(role):
        # A desk driving one physio's board from Operations names the record outright, so
        # it is taken as given rather than resolved -- a branch can have several physios and
        # there is no login here to match on.
        doctor = await v3_col("doctors").find_one(
            {"id": physio_id, "profile_type": "physio"}, {"_id": 0},
        )
        if doctor:
            return {**doctor, "physio_ids": [doctor["id"]]}

    mine = await v3_col("doctors").find(
        {"user_id": user_id, "profile_type": "physio"}, {"_id": 0},
    ).to_list(50)

    if not mine:
        raw_user = await v3_col("users").find_one(
            {"id": user_id},
            {"_id": 0, "employee_id": 1, "full_name": 1, "branch_id": 1, "branch_ids": 1},
        ) or {}
        if raw_user.get("employee_id"):
            mine = await v3_col("doctors").find(
                {"employee_id": raw_user["employee_id"], "profile_type": "physio"}, {"_id": 0},
            ).to_list(50)
        if not mine:
            mine = await _unlinked_records_named(raw_user)

    if not mine:
        return None

    primary = mine[0] if len(mine) == 1 else (await collapse_duplicate_experts(mine))[0]
    return {**primary, "physio_ids": list(dict.fromkeys([d["id"] for d in mine if d.get("id")]))}


async def _unlinked_records_named(raw_user: dict) -> list:
    """The physio records answering to this person's name that no login has claimed.

    Held to `user_id` being empty on purpose: a record already pointing at somebody else's
    login is theirs, whatever it is called, and is never taken from them here. Their own
    branch is preferred where it answers -- a namesake at another branch is a worse guess
    than the physio standing in the one whose patients these are.
    """
    name = str(raw_user.get("full_name") or "").strip().lower()
    if not name:
        return []
    rows = await v3_col("doctors").find(
        {"profile_type": "physio", "user_id": {"$in": [None, ""]}}, {"_id": 0},
    ).to_list(500)
    named = [d for d in rows if str(d.get("full_name") or "").strip().lower() == name]
    if not named:
        return []
    branches = [b for b in [raw_user.get("branch_id"), *(raw_user.get("branch_ids") or [])] if b]
    if branches:
        here = [d for d in named if d.get("branch_id") in branches]
        if here:
            return here
    return named


async def physio_lead_ids(physio_id) -> list:
    """Every lead this physio is responsible for, however they were given to them.

    Two ways in, and only one of them was ever counted. A treatment patient is handed over
    by setting assigned_physio_id on the lead; a rehab patient is handed over by booking
    rehab_sessions against the physio, and the lead itself is never stamped — the course is
    its own collection, deliberately (see v3_rehab).

    So a physio's own board could not see their rehab patients: absent from Patients,
    absent from Review, and on Treatment the day was drawn from a session row with no lead
    behind it, which is why the row showed a name and no phone and would not open.

    One helper because it was wrong in three places for one reason, and a fourth caller
    that forgets rehab would be the same bug again.

    Takes every record id the physio holds rather than one, for the same reason: a
    patient does not stop being theirs because the branch booked them against a duplicate
    row of the same person. See resolve_physio_doctor.
    """
    ids = _ids(physio_id)
    if not ids:
        return []
    assigned = await v3_col("leads").distinct("id", {"assigned_physio_id": {"$in": ids}})
    # own_course_days, so a rehab day covered for an absent colleague does not make their
    # patient this physio's for good — and stays this patient's physio's while it is away.
    rehab = await v3_col("rehab_sessions").distinct("lead_id", {**own_course_days(ids)})
    return list(dict.fromkeys([*assigned, *rehab]))

async def physio_owns_lead(physio_id, lead_id: str) -> bool:
    """Whether one lead is this physio's patient — the single-lead form of the above.

    The list helper was written for "which patients are mine" and the endpoints that ask
    "is this one mine" were left comparing assigned_physio_id themselves, which is the
    half of the answer that is blank for a rehab patient. So a physio could see Rakshana
    on their own Patients list and be told the record was not theirs on opening it: the
    detail call 403'd, and because the page fetched it alongside the sessions in one
    Promise.all, the whole page came back empty rather than the one tab that failed.

    Kept beside physio_lead_ids so the two answers cannot drift apart — including in
    taking every record id the physio holds, or a patient their own list had just offered
    them would 403 for sitting on the other one.
    """
    ids = _ids(physio_id)
    if not ids:
        return False
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "assigned_physio_id": 1})
    if lead and lead.get("assigned_physio_id") in ids:
        return True
    if await v3_col("rehab_sessions").find_one(
        {"lead_id": lead_id, "physio_id": {"$in": ids}}, {"_id": 0, "id": 1}
    ):
        return True
    # Covering for an absent colleague: the day was handed to this physio for one date
    # (see v3_physio_absence), and they cannot treat a patient whose record they are refused.
    return bool(await v3_col("sessions").find_one(
        {"lead_id": lead_id, "physio_id": {"$in": ids}, "covered_for_physio_id": {"$exists": True}},
        {"_id": 0, "id": 1},
    ))


def own_course_days(ids: list) -> dict:
    """The query for a physio's own days, including the ones handed to a cover.

    A day given to another physio while this one was absent (v3_physio_absence) is still a
    day of this physio's patient's course. Counted by physio_id alone it vanished from
    their tally, and the patient read 11 of 12 on the board of the physio treating them.
    """
    return {"$or": [
        {"physio_id": {"$in": ids}, "covered_for_physio_id": {"$exists": False}},
        {"covered_for_physio_id": {"$in": ids}},
    ]}


async def covering_lead_ids(ids: list) -> list:
    """Leads whose day this physio is only covering for an absent colleague."""
    out = []
    for collection in ("sessions", "rehab_sessions"):
        out += await v3_col(collection).distinct(
            "lead_id", {"physio_id": {"$in": ids}, "covered_for_physio_id": {"$exists": True}},
        )
    return list(dict.fromkeys(out))


async def review_cover_holders(lead_ids: list) -> dict:
    """Leads whose review is with a covering physio right now: {lead_id: physio_id}.

    A patient stays on their own physio's caseload while a colleague covers them, but the
    review is raised by whoever is treating them. Read off the patient's latest day up to
    today: where that day was handed over for an absence, the physio it was handed to holds
    the review. Otherwise the lead is left out, and the review stays with their own physio.
    """
    if not lead_ids:
        return {}
    cutoff = clinic_today() + "￿"
    latest: dict = {}
    for collection in ("sessions", "rehab_sessions"):
        rows = await v3_col(collection).find(
            {"lead_id": {"$in": lead_ids}, "slot_time": {"$nin": [None, ""], "$lte": cutoff}},
            {"_id": 0, "lead_id": 1, "slot_time": 1, "physio_id": 1, "covered_for_physio_id": 1},
        ).to_list(20000)
        for row in rows:
            held = latest.get(row["lead_id"])
            if held is None or (row.get("slot_time") or "") > (held.get("slot_time") or ""):
                latest[row["lead_id"]] = row
    return {
        lead_id: row["physio_id"]
        for lead_id, row in latest.items()
        if row.get("covered_for_physio_id") and row.get("physio_id")
    }


async def resolve_consultant_doctor(user_id: str, role: str = "") -> Optional[dict]:
    """The expert record belonging to the consultant who is logged in, and the rest of theirs.

    A consultant is SUPPOSED to have exactly one, branchless record -- they cover the whole
    organisation -- so their own user_id ought to resolve it outright. In practice they end
    up with more than one: several paths mint these records, and consolidate_head_physio_doctors
    in seed.py exists because they have.

    find_one against that is a coin toss, and every screen a consultant has rides on the
    answer: their patients are the appointments carrying this record's id and their calendar
    is its slots, so landing on the empty twin shows a consultant with a full book an empty
    board with nothing on screen saying why.

    So every record is read and the one holding the work is chosen: the one with
    appointments against it, else the one with published slots, else the oldest, which is
    the one the others were duplicated from. Read-only -- throwing away a record with
    bookings on it is not a repair a page load should be making.

    Lives here rather than in the consultation board because it is no longer only that
    board's question: what a patient wrote to their consultant is scoped by these ids too,
    and a second resolver answering it slightly differently is the exact bug
    resolve_physio_doctor above was written to end. `consultant_ids` carries the whole set
    for that reason -- the board opens on one record, but a read must not miss post filed
    against a twin.
    """
    mine = await v3_col("doctors").find(
        {"user_id": user_id, "profile_type": "head_physio"}, {"_id": 0},
    ).to_list(50)
    if mine:
        if len(mine) > 1:
            ids = [d["id"] for d in mine]
            # Which of them anything is actually booked against. distinct rather than a
            # count per record: one query, and the question is only ever "does this hold any".
            busy = set(await v3_col("appointments").distinct("doctor_id", {"doctor_id": {"$in": ids}}))
            mine.sort(key=lambda d: (
                0 if d["id"] in busy else 1,
                0 if (d.get("slots") or []) else 1,
                str(d.get("created_at") or ""),
            ))
        return {**mine[0], "consultant_ids": list(dict.fromkeys([d["id"] for d in mine if d.get("id")]))}
    if works_org_wide(role):
        # Driving somebody else's board. Any consultant record answers, which is right for
        # that and wrong for a page called My Consultation -- see hp_resolved_consultant,
        # which is what says so on screen.
        one = await v3_col("doctors").find_one({"profile_type": "head_physio"}, {"_id": 0})
        return {**one, "consultant_ids": [one["id"]]} if one else None
    return None


async def consultant_of_lead(lead: dict) -> dict:
    """The consultant who saw this patient -- hp_my_patients read the other way round.

    That board is every lead with an appointment against the consultant's record, so this
    is the newest appointment on the lead and the record it was booked against. The two
    have to agree: the consultant a patient is offered as an address must be the consultant
    whose own patient list holds them, or the thread lands on a board that will not open it.

    Not read off the lead. `assigned_physio_id` there is the treating physio despite the
    consultation booking copying it onto `consultant_id` at times -- see physio_lead_ids --
    and the appointment is the only record that says who actually took the consultation.

    Returns the id and the name together: the id is whose thread it is, the name is who the
    patient is told they are writing to, and looking the name up separately is how a row
    ends up addressed to a blank.
    """
    if not lead:
        return {"id": "", "name": ""}
    appointment = await v3_col("appointments").find_one(
        {"lead_id": lead.get("id"), "doctor_id": {"$nin": [None, ""]}},
        {"_id": 0, "doctor_id": 1, "consultant_name": 1, "doctor_name": 1},
        sort=[("slot_time", -1)],
    ) or {}
    doctor_id = str(appointment.get("doctor_id") or "").strip()
    if not doctor_id:
        return {"id": "", "name": ""}
    name = str(appointment.get("consultant_name") or appointment.get("doctor_name") or "").strip()
    # An appointment carrying no name still has to be addressed to somebody by name, or the
    # portal offers "send to " with nothing after it.
    if not name:
        doctor = await v3_col("doctors").find_one(
            {"id": doctor_id}, {"_id": 0, "full_name": 1},
        ) or {}
        name = str(doctor.get("full_name") or "").strip()
    return {"id": doctor_id, "name": name}


# ---------------------------------------------------------------------------------------
# Head Chief: the consultations a Super Admin takes, as Branch Admin's Sumaiya
# Consultations tab reads them -- the Super Admin's own My Consultation board, held to the
# Branch Admin's branch.
# ---------------------------------------------------------------------------------------

async def head_chief_doctor_ids() -> list:
    """The consultant records a Super Admin takes consultations on (ensure_super_admin_consultant)."""
    return await v3_col("doctors").distinct("id", {"profile_type": "head_physio", "is_super_admin": True})


async def head_chief_lead_ids() -> list:
    """Every lead booked to a Head Chief. Off `appointments.doctor_id`, the same way the
    board's `mine` narrowing reads whose consultation it is -- and not diet check-ins."""
    ids = await head_chief_doctor_ids()
    if not ids:
        return []
    return await v3_col("appointments").distinct(
        "lead_id", {"doctor_id": {"$in": ids}, "appt_kind": {"$ne": "diet"}},
    )


def user_branch_ids(user) -> list:
    """The branches a login is posted to: the primary one and any others."""
    return [b for b in [getattr(user, "branch_id", None), *(getattr(user, "branch_ids", None) or [])] if b]


async def ensure_head_chief_lead(user, lead_id: str) -> None:
    """A Branch Admin works a Head Chief's consultation only at their own branch.

    Their role was let onto the Consultant's actions for the Sumaiya Consultations tab, and
    that tab is all it was let on for: the patient must be booked to a Head Chief and sit at
    the Branch Admin's branch. Every other role passes through untouched -- this narrows the
    one role it was added for and nobody else."""
    if not is_branch_admin_role(getattr(user, "role", "")):
        return
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0, "branch_id": 1})
    if not lead or lead.get("branch_id") not in user_branch_ids(user):
        raise HTTPException(status_code=403, detail="This patient is not at your branch")
    ids = await head_chief_doctor_ids()
    booked = ids and await v3_col("appointments").find_one(
        {"lead_id": lead_id, "doctor_id": {"$in": ids}, "appt_kind": {"$ne": "diet"}}, {"_id": 0, "id": 1},
    )
    if not booked:
        raise HTTPException(status_code=403, detail="Only the Head Chief's consultations can be worked from here")
