"""How long each Physiotherapy consultation package runs.

Unit tests, like the files beside this one. What this module decides is how much of a
physio's day one appointment takes, and both ways of being wrong are quiet: too short and
the next patient is booked on top of the one still in the room, too long and a slot nobody
needed is held shut every time the package is sold.

The figure most worth pinning is the one that looks wrong: Consultation + 1 Session is 45
minutes, not 45 plus a session, because the session is booked separately and no session in
this system carries a length to add. That is a decision, not an oversight, so it is written
down as a test — otherwise the next person to read it fixes it.

Nothing here touches a database. See backend/consultation_packages.py.
"""
import os
import sys

import pytest

# Same note as the files beside this one: pytest with no __init__.py puts this directory on
# the path rather than the backend root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import consultation_packages as cp  # noqa: E402


# --------------------------------------------------------------- the three lengths

def test_only_consultation_is_forty_five_minutes():
    assert cp.duration_for("only_consultation") == 45


def test_consultation_plus_physio_is_the_two_added_up():
    """45 + 20, held as one booking: the physio runs on the end of the consultation."""
    assert cp.duration_for("consultation_plus_physio") == 65
    assert cp.duration_for("consultation_plus_physio") == (
        cp.CONSULTATION_MINUTES + cp.PHYSIO_ADD_ON_MINUTES
    )


def test_consultation_plus_session_holds_only_the_consultation():
    """The one that reads oddly on purpose.

    The bundled session is booked on its own, whenever the patient is next free, so the
    appointment is 45 minutes. Making this 45 + something would block out time in a
    physio's calendar for an appointment nobody has made yet, on every sale.
    """
    assert cp.duration_for("consultation_plus_session") == 45
    assert cp.includes_session("consultation_plus_session") is True


def test_only_the_session_package_owes_a_session():
    assert cp.includes_session("only_consultation") is False
    assert cp.includes_session("consultation_plus_physio") is False
    assert cp.includes_session("reconsultation") is False


def test_every_package_contains_the_same_consultation():
    """Whatever else is in it, the consultation itself is 45 minutes."""
    for key in cp.keys():
        assert cp.duration_for(key) >= cp.CONSULTATION_MINUTES


# ------------------------------------------------------------------ naming the shelf

def test_the_three_packages_and_their_labels():
    """The labels are what the dropdown shows and what lands in the item's name, so a
    change here renames rows on a shelf somebody is selling from."""
    assert cp.keys() == [
        "only_consultation",
        "consultation_plus_physio",
        "consultation_plus_session",
        "reconsultation",
    ]
    assert cp.label_of("only_consultation") == "Only Consultation"
    assert cp.label_of("consultation_plus_physio") == "Consultation + 20 mins Physio"
    assert cp.label_of("consultation_plus_session") == "Consultation + 1 Session"
    assert cp.label_of("reconsultation") == "Reconsultation"


def test_label_of_an_unknown_key_is_empty_not_an_error():
    """Labels are read to draw a screen; a missing one must not take the screen down."""
    assert cp.label_of("nonsense") == ""
    assert cp.label_of(None) == ""


# -------------------------------------------------------------- naming no package at all

@pytest.mark.parametrize("key", [None, ""])
def test_no_package_named_means_no_derived_duration(key):
    """Fitness and Diet Consultations still pick a duration by hand, and every row created
    before the packages existed has no key — all of them must keep the duration they have
    rather than acquire one."""
    assert cp.duration_for(key) is None


def test_an_unknown_package_is_refused_not_guessed():
    """A form and a server that disagree about what is on the shelf. Guessing a length
    would file that disagreement as a bookable slot in somebody's day."""
    with pytest.raises(ValueError):
        cp.duration_for("consultation_plus_two_sessions")


def test_includes_session_is_false_for_anything_unknown():
    assert cp.includes_session("nonsense") is False
    assert cp.includes_session(None) is False


# ------------------------------------------------------- the popup's copy of this table

# The dropdown mirrors this module so it can draw itself and preview the length without a
# round trip. The minutes it holds are only a preview -- the server re-derives them on the
# way in -- but a preview that disagrees with what gets saved is worse than no preview: the
# form would promise 65 minutes and store 45, and nobody would find out until a physio's
# afternoon ran over.
#
# Read out of the source rather than trusted, because nothing else makes the two lists one
# list. A regex is enough: the table is a literal by design, so that the person editing it
# can see every package at once.
_JSX = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend", "src", "lib", "consultationPackages.js",
)


def _packages_from_jsx():
    """{key: (label, minutes)} as the front end has them."""
    import re

    with open(_JSX, encoding="utf-8") as fh:
        source = fh.read()
    start = source.index("export const CONSULTATION_PACKAGES = [")
    table = source[start:source.index("];", start)]
    found = {}
    for block in re.finditer(
        r'key:\s*"(?P<key>[^"]+)".*?label:\s*"(?P<label>[^"]+)".*?minutes:\s*(?P<minutes>\d+)',
        table,
        re.S,
    ):
        found[block.group("key")] = (block.group("label"), int(block.group("minutes")))
    return found


@pytest.mark.skipif(not os.path.exists(_JSX), reason="frontend not checked out beside the backend")
def test_the_popups_package_list_matches_this_one():
    from_jsx = _packages_from_jsx()
    assert from_jsx, "could not read CONSULTATION_PACKAGES out of lib/consultationPackages.js"
    assert sorted(from_jsx) == sorted(cp.keys()), "the popup and the server offer different packages"
    for key, (label, minutes) in from_jsx.items():
        assert label == cp.label_of(key), f"{key}: popup says {label!r}"
        assert minutes == cp.duration_for(key), f"{key}: popup previews {minutes} mins"
