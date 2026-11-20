"""What a sheet column can be mapped onto, and how a mapped row becomes a lead.

One module for both halves on purpose. The mapping dropdown offers a list of fields, and
the importer writes the fields it is given, and those two lists have to be the same list:
a field the dropdown offers but the importer does not know how to write is a mapping
somebody sets, saves, and silently never receives. Keeping the catalogue and the
translation in the same file is what stops them drifting apart.

The catalogue mirrors the Create Lead form -- both of its tabs. Lead Details is who the
patient is; Lead Data is the ad record behind them (see V3LeadData in schemas/v3.py),
which only Super Admin ever sees. Custom questions are appended by the caller from
`custom_lead_fields`, so a question added on the form is mappable from a sheet the moment
it exists.
"""

import re
from typing import Any, Dict, List, Optional, Tuple


# Where a mapped value ends up decides how it has to be written, so the catalogue is
# grouped by destination rather than by how the form happens to lay the fields out.

# Columns on the lead document itself.
LEAD_COLUMN_FIELDS: List[Tuple[str, str]] = [
    ("name", "Name"),
    ("phone", "Phone"),
    ("email", "Email"),
    ("alternative_phone", "Alternative Phone"),
    ("address", "Address"),
    ("city", "City"),
    ("state", "State"),
    ("department", "Department"),
    ("condition", "Condition / Pain Area"),
    ("months_of_pain", "Months of Pain"),
    ("age", "Age"),
    ("gender", "Gender"),
    ("occupation", "Occupation"),
    ("expected_consultation_date", "Expected Consultation Date"),
    ("notes", "Notes"),
    ("vertical", "Vertical"),
]

# Not fields on a lead, and never were -- these land in extra_fields. They stay in the
# catalogue because sheets in the field already map them and sources already store those
# mappings; dropping them from the list would not delete the mapping, only hide it.
#
# Preferred Branch is no longer only kept, though: it is read. A form asking "which is your
# preferred location" is one form feeding every branch, and mapping that column here is
# what sends each row to the branch its answer names -- see backend/branch_routing.py. The
# answer still lands in extra_fields exactly as before, because what the patient typed and
# which branch it resolved to are two different facts and the second one can be wrong.
LEGACY_EXTRA_FIELDS: List[Tuple[str, str]] = [
    ("preferred_branch", "Preferred Branch (assigns the lead's branch)"),
    ("budget", "Budget"),
]

# The ad record, addressed through the block it is stored in. The dotted key is what makes
# `lead_data.campaign_name` unambiguous next to a custom question somebody calls
# "campaign_name" -- see split_mapping below.
LEAD_DATA_PREFIX = "lead_data."

AD_RECORD_FIELDS: List[Tuple[str, str]] = [
    (LEAD_DATA_PREFIX + key, label)
    for key, label in [
        ("id", "Lead ID"),
        ("created_time", "Created Time"),
        ("ad_id", "Ad ID"),
        ("ad_name", "Ad Name"),
        ("adset_id", "Adset ID"),
        ("adset_name", "Adset Name"),
        ("campaign_id", "Campaign ID"),
        ("campaign_name", "Campaign Name"),
        ("form_id", "Form ID"),
        ("form_name", "Form Name"),
        ("is_organic", "Is Organic"),
        ("platform", "Platform"),
    ]
]

# Custom questions are addressed through their own prefix for the same reason the ad
# record is: a question keyed "city" must not be mistaken for the lead's own City.
CUSTOM_PREFIX = "custom."

# Fields the lead schema types as a whole number. Written through the coercion below
# rather than straight across, because a lead carrying "35 years" where an int is declared
# fails to parse -- and every board builds its list inside a try/except that would drop
# that patient from the screen rather than show something wrong. A sheet is typed by
# whoever fills it in, so this is the normal case, not the edge one.
INT_FIELDS = {"months_of_pain", "age"}

# The one field on the ad record that is not text.
BOOL_AD_FIELDS = {"is_organic"}

_TRUE = {"true", "yes", "y", "1", "organic"}
_FALSE = {"false", "no", "n", "0", "paid"}


# Every Google Sheet the clinic syncs is a Meta lead-ads export, so a lead off one is a Meta
# lead -- Source "meta" -- and the export's own `platform` column says which of Meta's two
# apps the patient filled the form in. Stored as words on the lead's top-level `platform`,
# beside source_type rather than inside lead_data, because the ad record is Super Admin's
# only and every desk filters on this one.
META_SOURCE_TYPE = "meta"
PLATFORM_FIELD = LEAD_DATA_PREFIX + "platform"
PLATFORM_HEADER = "platform"

# Meta writes the short code; the long word is accepted too, for a sheet somebody tidied by
# hand. Anything else -- blank, a typo, Meta's rarer "an" or "msg" -- is no platform rather
# than a guess, and such a lead is still a Meta lead.
_PLATFORM_LABELS = {
    "ig": "Instagram", "instagram": "Instagram",
    "fb": "Facebook", "facebook": "Facebook",
}


def platform_label(value: Any) -> Optional[str]:
    """`ig` / `fb` (any case, any punctuation) as Instagram / Facebook, or None."""
    return _PLATFORM_LABELS.get(re.sub(r"[^a-z]", "", str(value or "").lower()))


def _platform_from_header(values: Optional[Dict[str, Any]]) -> Optional[str]:
    """The answer under whichever key spells "platform", however it was cased or spaced."""
    for key, value in (values or {}).items():
        if re.sub(r"[^a-z0-9]", "", str(key).lower()) == PLATFORM_HEADER:
            found = platform_label(value)
            if found:
                return found
    return None


def row_platform(row: Dict[str, Any], mapping: Dict[str, str]) -> Optional[str]:
    """One sheet row's platform: the column mapped to Lead Data -> Platform if there is one,
    else the column headed "platform". Read straight off the row, so it needs nobody to map
    the column first."""
    column = mapping.get(PLATFORM_FIELD)
    if column:
        found = platform_label(row.get(column))
        if found:
            return found
    return _platform_from_header(row)


def stored_platform(lead: Dict[str, Any]) -> Optional[str]:
    """The platform an already-imported lead carries: the ad record's, else the raw answer
    the importer kept in extra_fields when nobody had mapped the column."""
    ad = lead.get("lead_data") or {}
    return platform_label(ad.get("platform")) or _platform_from_header(lead.get("extra_fields"))


def catalogue(custom_fields: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """The mapping dropdown, grouped the way the Create Lead form is tabbed.

    `custom_fields` is the raw `custom_lead_fields` collection. Passed in rather than read
    here so this module stays free of the database and can be reasoned about on its own.
    """
    groups = [
        {
            "group": "Lead Details",
            "fields": [{"key": k, "label": lb} for k, lb in LEAD_COLUMN_FIELDS],
        },
        {
            "group": "Lead Data",
            "note": "The ad record behind the lead. Super Admin only.",
            "fields": [{"key": k, "label": lb} for k, lb in AD_RECORD_FIELDS],
        },
        {
            "group": "Other",
            "note": "Stored against the lead as extra detail. Preferred Branch also decides "
                    "which branch each row is imported to, when its answer names one.",
            "fields": [{"key": k, "label": lb} for k, lb in LEGACY_EXTRA_FIELDS],
        },
    ]
    customs = [
        {"key": CUSTOM_PREFIX + f["key"], "label": f.get("label") or f["key"]}
        for f in (custom_fields or [])
        if f.get("key")
    ]
    if customs:
        groups.append({
            "group": "Custom Questions",
            "note": "Added from this dialog or from the Create Lead form.",
            "fields": customs,
        })
    return groups


def known_field_keys(custom_fields: Optional[List[Dict[str, Any]]] = None) -> set:
    """Every key the catalogue offers, flattened."""
    return {f["key"] for g in catalogue(custom_fields) for f in g["fields"]}


def to_int(value: Any) -> Optional[int]:
    """A whole number out of whatever the sheet had in the cell, or None.

    None rather than a raised error: one badly typed age is not a reason to refuse the
    patient, and the field is optional on the lead anyway.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def to_bool(value: Any) -> Optional[bool]:
    """True/False out of a sheet cell, or None where the cell says nothing recognisable.

    None matters here: on the ad record, "nobody said" and "this came off an ad" are
    different answers, and a blank cell is the first one.
    """
    if value is None or isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return None


def split_mapping(row: Dict[str, Any], mapping: Dict[str, str]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """One sheet row, sorted into where each mapped value belongs.

    Returns (lead_columns, ad_record, extras). `mapping` is {field key: sheet column},
    which is the shape it has always been stored in -- the dialog shows it the other way
    round, column first, because that is the order somebody reads a sheet in, but
    inverting it for storage would have orphaned every mapping already saved.

    Anything mapped to a key this module does not recognise is treated as extra detail
    rather than dropped. That is the same fate an unmapped column has always had, and it
    keeps a mapping saved against an older catalogue working after this one changes.
    """
    lead_columns: Dict[str, Any] = {}
    ad_record: Dict[str, Any] = {}
    extras: Dict[str, Any] = {}

    lead_keys = {k for k, _ in LEAD_COLUMN_FIELDS}

    for field_key, column in (mapping or {}).items():
        if not column or column not in row:
            continue
        value = row[column]
        if value in (None, ""):
            continue

        if field_key.startswith(LEAD_DATA_PREFIX):
            ad_key = field_key[len(LEAD_DATA_PREFIX):]
            if ad_key in BOOL_AD_FIELDS:
                coerced = to_bool(value)
                if coerced is not None:
                    ad_record[ad_key] = coerced
            else:
                ad_record[ad_key] = str(value)
        elif field_key.startswith(CUSTOM_PREFIX):
            extras[field_key[len(CUSTOM_PREFIX):]] = value
        elif field_key in lead_keys:
            if field_key in INT_FIELDS:
                coerced = to_int(value)
                if coerced is not None:
                    lead_columns[field_key] = coerced
            else:
                lead_columns[field_key] = str(value)
        else:
            extras[field_key] = value

    return lead_columns, ad_record, extras
