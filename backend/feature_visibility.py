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
FEATURE_KEYS = ("treatments",)

# What a missing row means. "treatments" ships hidden: this install asked for the tab and
# the Treatment Summary dropdown to be off out of the box, and Show in Hide Features is how
# it comes back.
DEFAULT_HIDDEN = ("treatments",)


async def hidden_features() -> List[str]:
    """The hidden feature keys. A missing row is the defaults, not an empty list."""
    row = await v3_col("app_settings").find_one({"id": SETTING_ID}, {"_id": 0})
    if not row:
        return list(DEFAULT_HIDDEN)
    return [f for f in (row.get("hidden") or []) if f in FEATURE_KEYS]


async def feature_hidden(feature: str) -> bool:
    return feature in await hidden_features()
