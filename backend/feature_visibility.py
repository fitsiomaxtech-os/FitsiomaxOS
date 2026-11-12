"""Hide Features — whole features a developer has switched off in the Danger Zone.

One list in app_settings, read by every screen that draws a hideable feature and
changed only behind the developer password (see the endpoints in routers/v3_config.py).
Hiding a feature takes its controls off every screen at once; the records it already
wrote are untouched.

Its own module, like lead_purge and consult_duration_rule, because both v3_config (the
endpoints) and the boards' routers (the behaviour a hidden feature relaxes) read it —
importing one router from the other is how circular imports start.
"""

from typing import List

from database import v3_col

SETTING_ID = "hidden_features"

# Every feature the Hide Features tab offers. A key here is a contract with the frontend's
# HIDE_FEATURE_ROWS (DeveloperZone.jsx): the screens read the same string.
#
# treatments: the Treatments catalogue tab in Services and Products (Super Admin's and every
# branch's), and the Consultant's Treatment Summary tick-list with it — hiding one without
# the other would leave a dropdown reading a catalogue nobody can see, or a catalogue
# feeding a dropdown that no longer exists.
#
# past_day_appointments: picking a day before today on the Appointment popup's calendar
# (Branch Leads and Pre Sales). The tab shows it as Allow / Block — hidden is Block.
FEATURE_KEYS = ("treatments", "past_day_appointments")

# What a missing row means. "treatments" ships hidden: this install asked for the tab and
# the Treatment Summary dropdown to be off out of the box, and Show in Hide Features is how
# it comes back. "past_day_appointments" ships blocked, which is how the calendar has
# always behaved.
DEFAULT_HIDDEN = ("treatments", "past_day_appointments")

# The keys a row decided on before rows carried `known` — every key that existed then. A
# key added later is not in such a row's `hidden` because nobody has flipped it yet, not
# because it was shown, so it takes its default rather than reading as shown.
LEGACY_KNOWN = ("treatments",)


async def hidden_features() -> List[str]:
    """The hidden feature keys. A missing row is the defaults, not an empty list, and so is
    any key the stored row has never decided on."""
    row = await v3_col("app_settings").find_one({"id": SETTING_ID}, {"_id": 0})
    if not row:
        return list(DEFAULT_HIDDEN)
    known = set(row.get("known") or LEGACY_KNOWN)
    stored = set(row.get("hidden") or [])
    return [
        f for f in FEATURE_KEYS
        if (f in stored if f in known else f in DEFAULT_HIDDEN)
    ]


async def feature_hidden(feature: str) -> bool:
    return feature in await hidden_features()
