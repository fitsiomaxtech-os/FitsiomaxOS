"""Page 3 of the Offline Consultation Form, read off the Consultant's Treatment Prescription.

Page 3 is the clinic's: the client never fills it through the link. Each field below comes
from the lead the form was opened from (the form's `lead_id`), so the paper the branch
prints and hands over says what the Consultant prescribed:

    Fitsiomax Diagnosis                     <- Diagnosis Report
    Treatment Protocol                      <- Treatment Protocol
    No of Sessions / Weeks Required         <- the Treatment package: sessions a week x weeks
    No of Sessions / Weeks (Online/Offline) <- the course's mode, as the branch runs it
                                               (Mark Online and the Swap change it)
    Long Term Goal                          <- the Long Term services: Rehab, Fitness
    Short Term Goal                         <- the Short Term service: Zumba
    Special Instructions to the Therapist   <- Instructions

Copied, not looked up live: each is written onto the lead's forms when its source is saved
(sync_forms), and a form takes any it is missing when it is made or opened (fill_blanks).
Treatment Goals, Do's & Don'ts and Therapist Name stay the branch's to write. The sign is the
named therapist's own (staff_sign.py), or by hand on the printed sheet where there is none.
"""
import re
from typing import Iterable, Optional

import session_mode_swap
from database import v3_col

DIAGNOSIS = ("fitsiomax_diagnosis",)
NOTES = ("treatment_protocol", "special_instructions")
# What Move to Admin decides.
PLAN = ("sessions_weeks_required", "sessions_weeks_online_offline", "long_term_goal", "short_term_goal")
MODE = ("sessions_weeks_online_offline",)
LONG_TERM = ("long_term_goal",)
LINKED = DIAGNOSIS + NOTES + PLAN


def _text(value) -> str:
    return str(value or "").replace("\r\n", "\n").strip()


def _count(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _weeks(name: str) -> Optional[int]:
    """Store session packages are named "03 Weeks": the length is the leading number, as
    the popup's weeksFromPackageName reads it."""
    m = re.match(r"(\d+)", name or "")
    return int(m.group(1)) if m else None


def _has_course(lead: dict) -> bool:
    return lead.get("consultation_decision") == "consultation_treatment" and bool(_text(lead.get("session_package_name")))


def _sessions_required(lead: dict) -> str:
    """e.g. "Package: 03 Weeks -- 3 sessions a week x 3 weeks = 9 sessions"."""
    if not _has_course(lead):
        return ""
    name = _text(lead.get("session_package_name"))
    sessions = _count(lead.get("session_package_sessions"))
    weeks = _weeks(name)
    if weeks and sessions and sessions % weeks == 0:
        per_week = sessions // weeks
        return (f"Package: {name} — {per_week} session{'s' if per_week != 1 else ''} a week × "
                f"{weeks} week{'s' if weeks != 1 else ''} = {sessions} sessions")
    if sessions:
        return f"Package: {name} — {sessions} sessions"
    return f"Package: {name}"


def _mode_line(lead: dict) -> str:
    """The mode the course runs in. A course the branch swapped part-way says which days
    run in which mode: "Offline: 7 sessions (Day 1-7) · Online: 7 sessions (Day 8-14)"."""
    if not _has_course(lead):
        return ""
    plan = [run for run in (lead.get("session_mode_plan") or []) if _count(run.get("days")) > 0]
    if len(plan) > 1:
        return " · ".join(
            f"{str(run.get('mode') or 'offline').title()}: {run['days']} sessions (Day {run['from_day']}–{run['to_day']})"
            for run in session_mode_swap.with_day_ranges(plan)
        )
    mode = session_mode_swap.current_mode(lead).title()
    sessions = _count(lead.get("session_package_sessions"))
    return f"{mode}: {sessions} sessions" if sessions else mode


def _with_note(head: str, note) -> str:
    note = _text(note)
    return f"{head} — {note}" if note else head


def _long_term(lead: dict) -> str:
    """Rehab and Fitness, one line each, with what the Consultant wrote about the long term."""
    notes = lead.get("long_term_notes") or {}
    out = []
    if lead.get("rehab_referred") or lead.get("rehab_after_treatment"):
        name = _text(lead.get("rehab_package_name"))
        sessions = _count(lead.get("rehab_package_sessions"))
        if name:
            head = f"Rehab: {name}" + (f" ({sessions} sessions)" if sessions else "")
        elif lead.get("rehab_after_treatment"):
            head = "Rehab: after the Treatment course"
        else:
            head = "Rehab"
        out.append(_with_note(head, notes.get("rehab")))
    if lead.get("fitness_recommended"):
        out.append(_with_note("Fitness", notes.get("fitness")))
    return "\n".join(out)


def _short_term(lead: dict) -> str:
    if not lead.get("zumba_recommended"):
        return ""
    name = _text(lead.get("zumba_package_name"))
    classes = _count(lead.get("zumba_package_sessions"))
    if not name:
        return "Zumba"
    return f"Zumba: {name}" + (f" ({classes} classes)" if classes else "")


def page3_of(lead: dict) -> dict:
    """Every linked page 3 field, as the lead has it now."""
    return {
        "fitsiomax_diagnosis": _text(lead.get("physio_diagnosis_report")),
        "treatment_protocol": _text(lead.get("treatment_protocol")),
        "special_instructions": _text(lead.get("special_instructions")),
        "sessions_weeks_required": _sessions_required(lead),
        "sessions_weeks_online_offline": _mode_line(lead),
        "long_term_goal": _long_term(lead),
        "short_term_goal": _short_term(lead),
    }


async def sync_forms(lead_id: str, keys: Iterable[str]) -> None:
    """Writes `keys` onto every Consultation Form tied to the lead, as the lead has them now.
    Called once their source is saved; a field the source has emptied is emptied too."""
    keys = tuple(keys)
    if not lead_id or not keys:
        return
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        return
    page3 = page3_of(lead)
    await v3_col("consultation_forms").update_many({"lead_id": lead_id}, {"$set": {k: page3[k] for k in keys}})


async def fill_blanks(fields: dict, lead_id: Optional[str]) -> dict:
    """`fields` with each linked field it has left blank taken from the lead. A new form gets
    what was prescribed before it was made, and a form made before this link existed shows
    it when opened."""
    if not lead_id or all(fields.get(k) for k in LINKED):
        return fields
    lead = await v3_col("leads").find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        return fields
    return {**fields, **{k: v for k, v in page3_of(lead).items() if v and not fields.get(k)}}
