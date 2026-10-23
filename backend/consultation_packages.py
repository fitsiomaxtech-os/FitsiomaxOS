"""The packages a Physiotherapy consultation is sold as, and how long each one runs.

The Physiotherapy consultation shelf is not named freely any more. It is one of three
packages, and how long an appointment runs follows from which one was sold rather than from
somebody picking minutes off a row of buttons beside the name. So the package is the input
and the duration is derived from it.

Derived, never accepted from the client, for the same reason price_is_total is: the name on
the row says what was sold and the duration says how much of a physio's day to block out
for it. A client free to send both could store a "Consultation + 20 mins Physio" that books
fifteen minutes, and nothing downstream could tell which of the two was the lie.

Kept in its own module, free of FastAPI and of the database, so the arithmetic that decides
how much of a calendar an appointment takes can be read and tested on its own. Same
arrangement as lead_mapping and branch_routing.

The popup mirrors this table (CONSULTATION_PACKAGES in frontend lib/consultationPackages.js)
to draw the dropdown and pre-fill the length.

Since 2026-09-24 a package's minutes are the *default* length only: Super Admin can edit the
duration on the item, and the store saves what was typed (5-480 mins). The package key is
still validated here.
"""

from typing import Dict, List, Optional


# Every package contains the consultation itself, and it is the same 45 minutes in each.
CONSULTATION_MINUTES = 45

# The physio that runs on the end of the consultation in the second package.
PHYSIO_ADD_ON_MINUTES = 20


PACKAGES: Dict[str, Dict[str, object]] = {
    "only_consultation": {
        "label": "Only Consultation",
        "minutes": CONSULTATION_MINUTES,
        "includes_session": False,
    },
    "consultation_plus_physio": {
        "label": f"Consultation + {PHYSIO_ADD_ON_MINUTES} mins Physio",
        # One booking, run end to end: the physio follows the consultation in the same
        # slot, so the slot has to be long enough to hold both.
        "minutes": CONSULTATION_MINUTES + PHYSIO_ADD_ON_MINUTES,
        "includes_session": False,
    },
    "consultation_plus_session": {
        "label": "Consultation + 1 Session",
        # Forty-five minutes and not a minute more.
        #
        # The session bundled into this package is booked on its own, whenever the patient
        # is next free; it is not part of this appointment. There is no session length in
        # this system to add to the consultation even if it were -- a session package
        # carries a count, not a duration, and the Create Session form has never asked for
        # one. The 30 sitting on those rows is the schema default, not a length anybody
        # chose.
        #
        # So the appointment is the consultation, and the session is a promise recorded
        # against it. Inventing a number here would block out time in a physio's calendar
        # that nobody agreed to, on every consultation ever sold this way.
        "minutes": CONSULTATION_MINUTES,
        "includes_session": True,
    },
    # A returning patient seen again by the consultant, sold at its own (lower) price --
    # Rs.600 at the time it was added, set on the item like every other package. The same
    # consultation, so the same 45 minutes; Super Admin can shorten it on the item.
    "reconsultation": {
        "label": "Reconsultation",
        "minutes": CONSULTATION_MINUTES,
        "includes_session": False,
    },
}


def keys() -> List[str]:
    return list(PACKAGES)


def label_of(key: Optional[str]) -> str:
    """What the shelf calls this package, or "" for anything not on it."""
    return str((PACKAGES.get(key or "") or {}).get("label") or "")


def duration_for(key: Optional[str]) -> Optional[int]:
    """How long this package runs, or None where no package was named.

    Raises ValueError on a key this module does not know, rather than falling back to a
    default: an unrecognised package is a form and a server that disagree about what is on
    the shelf, and guessing a length for it would file that disagreement as a bookable
    slot in somebody's day. The caller turns this into a 400.
    """
    if not key:
        return None
    package = PACKAGES.get(key)
    if not package:
        raise ValueError(f"Unknown consultation package: {key}")
    return int(package["minutes"])


def includes_session(key: Optional[str]) -> bool:
    """Whether this package owes the patient a session beyond the appointment itself."""
    return bool((PACKAGES.get(key or "") or {}).get("includes_session"))
