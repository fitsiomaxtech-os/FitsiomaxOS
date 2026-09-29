"""
Google Sheets OAuth + Sync.

Endpoints (all under /api/v3/marketing/google-sheets):
- GET  /status       — is the company-wide OAuth connection active?
- GET  /auth         — start OAuth flow (returns URL or 302 redirect)
- GET  /callback     — Google redirects here with ?code= and ?state=
- POST /disconnect   — revoke + clear token
- POST /pull/{source_id} — pull rows from Google Sheets API, dedupe + import via marketing sync logic
"""
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional
import asyncio
import os
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials

from database import v3_col
from utils import now_iso, generate_patient_number, enquiry_created_at, find_enquiry_stamp, without_past_moves
from deps import v3_require_roles, is_branch_admin_role
from schemas.v3 import V3UserOut
from stage_utils import first_branch_stage_for
import branch_routing
import lead_control
import lead_mapping
from routers.v3_marketing import (
    auto_map_columns, normalize_phone, STANDARD_FIELDS, round_robin_assign, normalize_source,
)


router = APIRouter(prefix="/api/v3/marketing/google-sheets")


CLIENT_ID = os.environ.get("GOOGLE_SHEETS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("GOOGLE_SHEETS_CLIENT_SECRET")
REDIRECT_URI = os.environ.get("GOOGLE_SHEETS_REDIRECT_URI")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]


TOKEN_DOC_ID = "_company_shared_"


def _client_config() -> Dict[str, Any]:
    if not CLIENT_ID or not CLIENT_SECRET or not REDIRECT_URI:
        raise HTTPException(
            status_code=500,
            detail="Google OAuth not configured. Set GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET, GOOGLE_SHEETS_REDIRECT_URI.",
        )
    return {
        "web": {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [REDIRECT_URI],
        }
    }


async def _get_creds() -> Optional[Credentials]:
    doc = await v3_col("google_sheets_tokens").find_one({"id": TOKEN_DOC_ID}, {"_id": 0})
    if not doc or not doc.get("refresh_token"):
        return None
    creds = Credentials(
        token=doc.get("access_token"),
        refresh_token=doc.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=doc.get("scopes") or SCOPES,
    )
    expires_at = doc.get("expires_at")
    if expires_at:
        try:
            dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) >= dt - timedelta(seconds=60):
                await asyncio.to_thread(creds.refresh, GoogleRequest())
                await v3_col("google_sheets_tokens").update_one(
                    {"id": TOKEN_DOC_ID},
                    {"$set": {
                        "access_token": creds.token,
                        "expires_at": (creds.expiry.replace(tzinfo=timezone.utc).isoformat() if creds.expiry else None),
                    }},
                )
        except Exception:
            pass
    return creds


# ---------- endpoints ----------

@router.get("/status")
async def status(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev", "marketing_head"))):
    doc = await v3_col("google_sheets_tokens").find_one({"id": TOKEN_DOC_ID}, {"_id": 0})
    if not doc:
        return {"connected": False}
    return {
        "connected": bool(doc.get("refresh_token")),
        "connected_at": doc.get("connected_at"),
        "scopes": doc.get("scopes", []),
    }


@router.get("/auth")
async def auth_start(redirect: bool = Query(False), _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES, redirect_uri=REDIRECT_URI)
    state = str(uuid.uuid4())
    url, _state = flow.authorization_url(access_type="offline", prompt="consent", state=state, include_granted_scopes="true")
    # google-auth-oauthlib 1.x auto-generates a PKCE code_verifier. Persist it so /callback can complete the exchange.
    await v3_col("google_sheets_states").insert_one({
        "state": state,
        "code_verifier": flow.code_verifier,
        "created_at": now_iso(),
    })
    if redirect:
        return RedirectResponse(url)
    return {"auth_url": url, "state": state}


@router.get("/callback")
async def auth_callback(code: str, state: Optional[str] = None):
    # Verify state and retrieve the matching code_verifier (required for PKCE token exchange).
    code_verifier = None
    if state:
        valid = await v3_col("google_sheets_states").find_one({"state": state}, {"_id": 0})
        if not valid:
            return RedirectResponse(f"{FRONTEND_URL}/?sheets_connect=failed&reason=invalid_state")
        code_verifier = valid.get("code_verifier")
        await v3_col("google_sheets_states").delete_one({"state": state})

    try:
        flow = Flow.from_client_config(_client_config(), scopes=SCOPES, redirect_uri=REDIRECT_URI)
        if code_verifier:
            flow.code_verifier = code_verifier
        await asyncio.to_thread(flow.fetch_token, code=code)
    except Exception as e:
        return RedirectResponse(f"{FRONTEND_URL}/?sheets_connect=failed&reason={re.sub(r'[^a-zA-Z0-9_-]', '_', str(e)[:60])}")

    creds: Credentials = flow.credentials

    expires_iso = creds.expiry.replace(tzinfo=timezone.utc).isoformat() if creds.expiry else None
    await v3_col("google_sheets_tokens").update_one(
        {"id": TOKEN_DOC_ID},
        {"$set": {
            "id": TOKEN_DOC_ID,
            "access_token": creds.token,
            "refresh_token": creds.refresh_token,
            "expires_at": expires_iso,
            "scopes": list(creds.scopes or SCOPES),
            "connected_at": now_iso(),
        }},
        upsert=True,
    )
    return RedirectResponse(f"{FRONTEND_URL}/?sheets_connect=success")


class DisconnectInput(BaseModel):
    """Kept as the body type so an old client posting {"secret": "..."} still parses
    rather than 422-ing. Nothing is read from it."""
    grant_id: Optional[str] = None
    secret: Optional[str] = None


@router.post("/disconnect")
async def disconnect(payload: DisconnectInput, _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Clear the company-wide Google Sheets connection.

    Super Admin is the whole check. This used to sit behind a second factor as well —
    first a static SHEETS_DISCONNECT_SECRET, then a one-time code by email — and both
    are gone at the branch's request. The UI still confirms before calling this, because
    it stops every branch's sheet sync at once, but that is a misclick guard rather than
    something to prove.
    """
    await v3_col("google_sheets_tokens").delete_one({"id": TOKEN_DOC_ID})
    return {"disconnected": True}


# ---------- Sheets list ----------
# Disabled: listing all spreadsheets requires Drive scope.
# We intentionally use only `spreadsheets.readonly` (no Drive, no email).
# Users paste the Google Sheet URL in the Add Source dialog; the spreadsheet
# ID is extracted from the URL and used directly to read rows.

@router.get("/spreadsheets")
async def list_spreadsheets(_: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    raise HTTPException(
        status_code=400,
        detail="Listing your sheets is disabled by design (no Drive access requested). Paste the Google Sheet URL in 'Add Source' instead.",
    )


@router.get("/tabs")
async def list_tabs(spreadsheet_id: str = Query(...), _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev"))):
    """Tabs (worksheets) inside one already-known spreadsheet — unlike /spreadsheets above,
    this needs no Drive access: the caller already has the ID from a pasted URL, and
    `spreadsheets.get` only reads the one sheet it's pointed at. Used by the Add/Edit Source
    popup to let the tab be picked rather than typed."""
    creds = await _get_creds()
    if not creds:
        raise HTTPException(status_code=400, detail="Not connected to Google. Click 'Continue with Google' first.")
    try:
        svc = await asyncio.to_thread(lambda: build("sheets", "v4", credentials=creds))
        meta = await asyncio.to_thread(lambda: svc.spreadsheets().get(
            spreadsheetId=spreadsheet_id, fields="sheets.properties.title",
        ).execute())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not read that sheet: {str(e)[:200]}")
    tabs = [s["properties"]["title"] for s in meta.get("sheets", []) if s.get("properties")]
    if not tabs:
        raise HTTPException(status_code=404, detail="No tabs found in that spreadsheet")
    return {"tabs": tabs}


@router.get("/headers")
async def list_headers(
    spreadsheet_id: str = Query(...),
    tab: str = Query(...),
    _: V3UserOut = Depends(v3_require_roles("super_admin", "business_dev")),
):
    """The column names in one tab -- its first row, and nothing else.

    The left-hand side of Edit Mapping. Read live rather than from the source's stored
    headers_detected, because that field is only written by a sync: a sheet connected but
    never pulled has none, and a sheet whose form gained a question still has yesterday's.
    Mapping against either is mapping against columns that are not there.

    One row is fetched, not the sheet -- this is called every time the dialog opens.
    """
    creds = await _get_creds()
    if not creds:
        raise HTTPException(status_code=400, detail="Not connected to Google. Click 'Continue with Google' first.")
    try:
        svc = await asyncio.to_thread(lambda: build("sheets", "v4", credentials=creds))
        resp = await asyncio.to_thread(lambda: svc.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id, range=f"'{tab}'!1:1",
        ).execute())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not read that tab: {str(e)[:200]}")
    values = resp.get("values", [])
    # Blank cells in the header row are dropped rather than offered as a column with no
    # name -- a sheet's used range often runs wider than its questions do.
    headers = [str(h).strip() for h in (values[0] if values else []) if str(h).strip()]
    return {"headers": headers, "tab": tab}


# ---------- Auto-sync settings (lightweight — accessible to pre_sales too) ----------

class AutoSyncToggle(BaseModel):
    auto_sync_enabled: Optional[bool] = None
    auto_sync_interval_minutes: Optional[int] = None


@router.get("/auto-sync/sources")
async def auto_sync_sources(user: V3UserOut = Depends(v3_require_roles("super_admin", "pre_sales", "business_dev", "marketing_head", "branch_admin"))):
    """Lightweight list of Google Sheets sources with their auto-sync settings + status.
    Branch Admin only ever sees sources tagged with their own branch — a source with no
    branch (or another branch's) isn't theirs to pull."""
    connected = await v3_col("google_sheets_tokens").find_one({"id": TOKEN_DOC_ID}, {"_id": 0, "refresh_token": 1})
    query = {"source_type": "google_sheets", "is_active": True}
    if is_branch_admin_role(user.role):
        # Matches a doc whose branch_ids array contains this branch — also catches any
        # not-yet-normalized doc still on the legacy singular branch_id field.
        query["$or"] = [{"branch_ids": user.branch_id}, {"branch_id": user.branch_id}]
    sources = await v3_col("marketing_sources").find(
        query,
        {"_id": 0},
    ).sort("created_at", -1).to_list(200)
    # Strip out heavy fields we don't need
    keep = {"id", "name", "spreadsheet_id", "sheet_name", "last_synced", "row_count", "auto_sync_enabled", "auto_sync_interval_minutes"}
    sources = [{k: v for k, v in s.items() if k in keep} for s in sources]
    return {
        "connected": bool(connected and connected.get("refresh_token")),
        "sources": sources,
    }


@router.patch("/auto-sync/sources/{source_id}")
async def auto_sync_toggle(source_id: str, payload: AutoSyncToggle, _: V3UserOut = Depends(v3_require_roles("super_admin", "pre_sales", "business_dev", "marketing_head"))):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if "auto_sync_interval_minutes" in updates:
        updates["auto_sync_interval_minutes"] = max(int(updates["auto_sync_interval_minutes"]), 5)
    updates["updated_at"] = now_iso()
    res = await v3_col("marketing_sources").update_one({"id": source_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Source not found")
    return await v3_col("marketing_sources").find_one(
        {"id": source_id},
        {"_id": 0, "id": 1, "name": 1, "auto_sync_enabled": 1, "auto_sync_interval_minutes": 1, "last_synced": 1},
    )


# ---------- Pull (real Sheets API → existing dedupe/import logic) ----------

# What a phone number looks like once the punctuation is gone: ten digits on their own,
# or ten behind a country code. The upper bound is the point of the check -- a Meta lead
# id ("l:1773668330612345") is sixteen digits and normalize_phone would hand back its last
# ten quite happily, so a column is judged on how many digits it holds, not on whether
# normalize_phone can salvage something from it.
_PHONE_DIGITS = range(10, 14)

# How much of a column has to read as a phone number before it is treated as the phone
# column. A clear majority rather than a handful: a column that is mostly ages or pin
# codes with a stray long number in it is not the phone column, and importing against the
# wrong one is the failure this whole check replaced.
_PHONE_MAJORITY = 0.6


def _phone_score(header: str, rows: list) -> float:
    """What proportion of this column's filled-in rows read as a phone number."""
    filled = [str(r.get(header, "") or "").strip() for r in rows]
    filled = [v for v in filled if v]
    if not filled:
        return 0.0
    hits = sum(1 for v in filled if len(re.sub(r"\D", "", v)) in _PHONE_DIGITS)
    return hits / len(filled)


def _detect_phone_column(headers: list, rows: list) -> Optional[str]:
    """The column of this tab that actually holds phone numbers, or None.

    Decided on the values rather than the header, because this is what is left when the
    header did not say -- a sheet whose phone column is headed something no alias list
    would guess, or a stored mapping pointing at a column that turned out not to be one.
    """
    best, best_score = None, 0.0
    for header in headers:
        score = _phone_score(header, rows)
        if score > best_score:
            best, best_score = header, score
    return best if best_score >= _PHONE_MAJORITY else None


# One lock per source. The auto-sync loop and a Pull from Sheet click used to be able to
# pull the same sheet at the same moment: twice the work, and both passes could see a
# phone as new before either had inserted it, filing the same patient twice. A pull that
# finds its source already running does not wait behind it -- it says so and returns.
_PULL_LOCKS: Dict[str, asyncio.Lock] = {}


async def _internal_pull_source(source_id: str, range_: str = "A1:Z10000") -> Dict[str, Any]:
    """Pull a source unless a pull of it is already running (see _PULL_LOCKS)."""
    lock = _PULL_LOCKS.setdefault(source_id, asyncio.Lock())
    if lock.locked():
        return {"error": "already_syncing", "imported": 0}
    async with lock:
        return await _pull_source_unlocked(source_id, range_)


async def _pull_source_unlocked(source_id: str, range_: str = "A1:Z10000") -> Dict[str, Any]:
    """Pull rows from a Google Sheet into Leads. Returns result dict.
    Raises HTTPException for caller-facing errors; returns {"error": str} for scheduler usage.
    """
    source = await v3_col("marketing_sources").find_one({"id": source_id}, {"_id": 0})
    if not source:
        return {"error": "source_not_found", "imported": 0}
    source = normalize_source(source)
    if not source.get("spreadsheet_id"):
        return {"error": "no_spreadsheet_id", "imported": 0}

    creds = await _get_creds()
    if not creds:
        return {"error": "not_connected", "imported": 0}

    # A source can be pulled from several tabs of the same spreadsheet at once (e.g. one
    # lead-form tab per branch, all in one sheet). Falls back to the legacy singular
    # sheet_name the same way normalize_source backfills branch_ids, so an older source
    # still pulls its one tab exactly as before.
    sheet_names = source.get("sheet_names") or ([source["sheet_name"]] if source.get("sheet_name") else ["Sheet1"])

    try:
        svc = await asyncio.to_thread(lambda: build("sheets", "v4", credentials=creds))
    except Exception as e:
        return {"error": f"sheets_api: {str(e)[:200]}", "imported": 0}

    # Fetched per tab rather than once — tabs in the same spreadsheet often have different
    # layouts (a job-application tab living alongside branch lead-form tabs, say), so each
    # tab's headers are mapped on their own further down instead of assuming one shared
    # column layout for everything pulled.
    per_tab = []
    tabs_missing = []
    for tab_name in sheet_names:
        a1_range = f"'{tab_name}'!{range_}"
        try:
            resp = await asyncio.to_thread(lambda a1=a1_range: svc.spreadsheets().values().get(spreadsheetId=source["spreadsheet_id"], range=a1).execute())
        except Exception as range_err:
            err_text = str(range_err)
            if "Unable to parse range" in err_text or "Requested entity was not found" in err_text:
                tabs_missing.append(tab_name)
                continue
            return {"error": f"sheets_api: {err_text[:200]}", "imported": 0}
        values = resp.get("values", [])
        if not values:
            continue
        headers = [str(h).strip() for h in values[0]]
        rows = []
        for r in values[1:]:
            padded = list(r) + [""] * (len(headers) - len(r))
            rows.append({headers[i]: padded[i] for i in range(len(headers))})
        per_tab.append((tab_name, headers, rows))

    if not per_tab:
        await v3_col("marketing_sources").update_one({"id": source_id}, {"$set": {"last_synced": now_iso()}})
        if tabs_missing:
            return {"error": f"tabs_not_found: {', '.join(tabs_missing)}", "imported": 0}
        return {"imported": 0, "skipped": 0, "rows_received": 0, "message": "Sheet is empty"}

    stored_mapping = dict(source.get("column_mapping") or {})
    imported = 0
    skipped_no_phone = 0
    skipped_duplicate = 0
    rows_received = 0
    sample_errors = []
    last_headers, last_mapping = [], {}
    # Phones already on a lead, looked up a tab at a time in batches rather than one query
    # per row. The sheet is read whole on every pull, so a tab of a few thousand old rows
    # was a few thousand round trips to find one new lead -- and the button spun for all
    # of them. Grows with each insert below, so a phone repeated later in the same pull is
    # still a duplicate, as it was when every row asked the database.
    known_phones: set = set()
    # A source tagged to exactly one branch still auto-assigns every row to it, same as
    # before this field became a list. With zero or several branches there's no single one
    # to route a row to, so branch_ids becomes a tag only — same as an untagged
    # "All Branches" source has always behaved.
    branch_ids = source.get("branch_ids") or []
    source_branch_id = branch_ids[0] if len(branch_ids) == 1 else None
    verticals = source.get("verticals") or []
    default_vertical = verticals[0] if len(verticals) == 1 else "offline_physiotherapy"
    # A row that names its own branch goes to that branch instead — one form asking "which
    # is your preferred location" feeds every branch, and the source's single branch tag
    # cannot say where such a row belongs. See branch_routing.
    branch_router = await branch_routing.load()
    # Lead Control and the entry stage are a property of the branch, not of the source, so
    # they can no longer be resolved once for the whole pull. Cached per branch instead:
    # a pull is thousands of rows across a handful of branches.
    branch_entry: Dict[Optional[str], tuple] = {}
    routed_to: Dict[str, int] = {}

    async def _entry_for(branch_id: Optional[str]) -> tuple:
        """(lead control, entry branch stage) for one branch, looked up once."""
        if branch_id not in branch_entry:
            control = await lead_control.branch_lead_control(branch_id)
            branch_entry[branch_id] = (
                control, await first_branch_stage_for(control, "New Appointment"),
            )
        return branch_entry[branch_id]

    for tab_name, headers, rows in per_tab:
        rows_received += len(rows)
        # This tab's own headers, mapped fresh. Used on its own where there is no usable
        # stored mapping, and to fill the gaps in one where there is.
        auto = auto_map_columns(headers)
        # The saved mapping is reused only if this tab's headers still contain every column
        # it points at — otherwise this tab gets its own headers auto-mapped fresh rather
        # than reading from the wrong columns.
        if stored_mapping and all(h in headers for h in stored_mapping.values()):
            mapping = dict(stored_mapping)
            # A stored mapping is not a complete one. It is whatever the last pull worked
            # out, written back at the end of this function -- so a field the mapper of the
            # day failed to recognise is saved as "not mapped" and reused as such on every
            # pull after it, and improving the mapper then changes nothing for the sources
            # that most need it. That is exactly what happened to the name on the Meta
            # export: "full_name" went unmatched once, under the old exact-match mapper,
            # and the absence was persisted. Every pull since has read the sheet's name
            # column and thrown it away, and every lead landed as "Unknown".
            #
            # So a field the stored mapping does not name is taken from this tab's own
            # headers. Only ever additive: a column somebody set by hand in the mapping
            # dialog is never overridden, and a header already spoken for is not claimed
            # a second time.
            for field, header in auto.items():
                if field not in mapping and header not in set(mapping.values()):
                    mapping[field] = header
        else:
            mapping = auto
        # A stored phone column that does not hold phone numbers is the old fallback's
        # doing: with nothing mapped it took headers[0], and on a Meta export column A is
        # Meta's own lead id. That guess was written back to the source like any other
        # mapping, so removing the fallback does not undo it. Checked against the rows
        # rather than trusted, and only ever replaced by a column that does read as phones.
        if mapping.get("phone") and _phone_score(mapping["phone"], rows) < _PHONE_MAJORITY:
            better = _detect_phone_column(headers, rows)
            if better and better != mapping["phone"]:
                mapping["phone"] = better
        if "phone" not in mapping:
            detected = _detect_phone_column(headers, rows)
            if not detected:
                # Nothing in this tab reads as a phone number, and a lead with no way to
                # reach the patient is not a lead. This used to fall through to headers[0]
                # -- whatever column A happened to be -- which on a Meta lead-ads export
                # is Meta's own lead id, so every row imported with "l:1773668330..." as
                # its phone number and, worse, with phone_normalized derived from it:
                # the dedupe key both importers skip on, wrong and unnoticed. Better to
                # say the tab could not be read and let somebody map the column.
                sample_errors.append(
                    f"{tab_name}: no phone column found among {', '.join(headers[:8])}"
                    f"{'...' if len(headers) > 8 else ''} — map one in the source's column mapping"
                )
                continue
            mapping["phone"] = detected
        phone_key = mapping["phone"]
        last_headers, last_mapping = headers, mapping

        tab_phones = {
            p for p in (normalize_phone(str(r.get(phone_key, "") or "").strip()) for r in rows) if p
        } - known_phones
        tab_phones = list(tab_phones)
        # Past Data's trial clients are not known phones: a returning patient's new enquiry
        # is a new lead, and matching one of those would skip it unseen.
        for start in range(0, len(tab_phones), 1000):
            async for doc in v3_col("leads").find(
                without_past_moves({"phone_normalized": {"$in": tab_phones[start:start + 1000]}}),
                {"_id": 0, "phone_normalized": 1},
            ):
                known_phones.add(doc["phone_normalized"])

        for idx, row in enumerate(rows):
            phone_raw = str(row.get(phone_key, "") or "").strip()
            phone_norm = normalize_phone(phone_raw)
            if not phone_norm:
                skipped_no_phone += 1
                if len(sample_errors) < 3:
                    sample_errors.append(f"{tab_name} row {idx + 2}: missing phone in column '{phone_key}'")
                continue
            if phone_norm in known_phones:
                skipped_duplicate += 1
                continue
            # Every field the mapping dialog can offer, written where it actually lives:
            # the lead's own columns, the ad record, or extra detail. This used to walk
            # STANDARD_FIELDS -- nine fields -- and put all but five of them into
            # extra_fields, so a column mapped to Condition or Age never reached the
            # Condition or Age the branch reads. See backend/lead_mapping.py.
            lead_columns, ad_record, mapped_extras = lead_mapping.split_mapping(row, mapping)
            std_payload = lead_columns
            custom_payload = dict(mapped_extras)
            mapped_values = set(mapping.values())
            # An unmapped column is still worth keeping -- it is a question somebody asked
            # and an answer the patient gave, and nobody has said where to file it yet.
            for key, value in row.items():
                if key not in mapped_values and value not in (None, ""):
                    custom_payload.setdefault(key, value)

            # Which branch this patient asked for, falling back to the source's own tag
            # where the row names no branch (or names one nobody has) — that is where the
            # row would have gone before this existed, so an unreadable answer costs
            # nothing beyond the routing.
            row_branch_id = branch_routing.routed_branch_id(row, mapping, branch_router) or source_branch_id
            if row_branch_id and row_branch_id != source_branch_id:
                name = branch_router.name_of(row_branch_id)
                routed_to[name] = routed_to.get(name, 0) + 1
            row_control, row_branch_stage = await _entry_for(row_branch_id)

            # No Pre-Sales rep on a lead the Pre-Sales desk will never see. Read off the
            # branch the row is going to, not the source's: the two branches need not run
            # their leads the same way, and a lead routed to a Branch-Admin branch with a
            # Pre-Sales rep on it sits in a queue that branch never opens.
            assigned = None if row_control == lead_control.BRANCH_ADMIN else await round_robin_assign("pre_sales")
            patient_number = await generate_patient_number(row_branch_id) if row_branch_id else None
            # When the patient actually enquired, off the ad record, falling back to now
            # for a row that carries no such stamp -- a walk-in sheet, or a form whose
            # created_time column nobody mapped. See enquiry_created_at: a sync that runs
            # late must not date a lead late, which is what shows a branch yesterday's
            # patients under today.
            enquired_at = enquiry_created_at(find_enquiry_stamp(ad_record, custom_payload))
            lead = {
                "id": str(uuid.uuid4()),
                "patient_number": patient_number,
                "name": (str(std_payload.get("name") or "")).strip() or "Unknown",
                "phone": phone_raw,
                "phone_normalized": phone_norm,
                "email": std_payload.get("email", ""),
                "vertical": std_payload.get("vertical") or default_vertical,
                "source_tab": f"{source['name']} · {tab_name}" if len(sheet_names) > 1 else source["name"],
                "source_type": "google_sheets",
                # Pre-Sales stage stays normal ("New Leads") regardless — a source tagged with a
                # branch only ADDS the branch assignment, landing the lead in that branch's New
                # Appointment column too, without pulling it out of the usual Pre-Sales workflow.
                "stage": "New Leads",
                "branch_id": row_branch_id,
                "branch_stage": row_branch_stage if row_branch_id else None,
                "notes": std_payload.get("notes", ""),
                # The lead's own columns, straight across. Coercion already happened in
                # split_mapping -- a sheet is typed by whoever fills it in, and an age of
                # "35 years" landing in an int field makes the whole patient unparseable
                # on every board that lists them.
                **{k: v for k, v in std_payload.items() if k not in ("name", "email", "phone", "vertical", "notes")},
                # Written whether or not it is empty, so the field is shaped the same for
                # everyone entitled to read it -- same as the manual create path.
                "lead_data": ad_record,
                "extra_fields": custom_payload,
                "assigned_user_id": assigned["id"] if assigned else None,
                "assigned_user_name": assigned["full_name"] if assigned else None,
                "assigned_user_role": "pre_sales" if assigned else None,
                "marketing_source_id": source_id,
                "created_at": enquired_at or now_iso(),
                "updated_at": now_iso(),
            }
            await v3_col("leads").insert_one(lead.copy())
            known_phones.add(phone_norm)
            imported += 1

    new_row_count = (source.get("row_count") or 0) + imported
    update = {
        "last_synced": now_iso(),
        "row_count": new_row_count,
        "headers_detected": last_headers,
        "sheet_names": [t for t, _, _ in per_tab],
        "last_sync_imported": imported,
        "last_sync_skipped_no_phone": skipped_no_phone,
        "last_sync_skipped_duplicate": skipped_duplicate,
        "last_sync_rows_received": rows_received,
    }
    if last_mapping and last_mapping != stored_mapping:
        update["column_mapping"] = last_mapping
    await v3_col("marketing_sources").update_one({"id": source_id}, {"$set": update})

    return {
        "imported": imported,
        "skipped": skipped_no_phone + skipped_duplicate,
        "skipped_no_phone": skipped_no_phone,
        "skipped_duplicate": skipped_duplicate,
        "rows_received": rows_received,
        "phone_column_used": last_mapping.get("phone"),
        "mapping_used": last_mapping,
        # Only the rows that went somewhere other than the source's own branch, and only
        # when a location column was read at all — on a branch's own sheet this is empty
        # and the pull reads exactly as it always has.
        "branch_column_used": last_mapping.get(branch_routing.BRANCH_FIELD),
        "routed_to_branches": routed_to,
        "sample_errors": sample_errors + [f"tab not found: {t}" for t in tabs_missing],
    }


# business_dev alongside the other three: it already holds every other half of this
# import (create the connection, save its field map, run the sync, and list the
# auto-sync sources this pulls from -- /auto-sync-sources above admits it), so its
# absence here was an oversight rather than a decision. It showed as a Pull from Sheet
# button that 403s, on the Marketing View and Sales View tabs of that desk's own board.
@router.post("/pull/{source_id}")
async def pull_source(source_id: str, range_: str = Query("A1:Z10000"), user: V3UserOut = Depends(v3_require_roles("super_admin", "pre_sales", "branch_admin", "business_dev"))):
    if is_branch_admin_role(user.role):
        source = await v3_col("marketing_sources").find_one({"id": source_id}, {"_id": 0, "branch_id": 1, "branch_ids": 1})
        if not source:
            raise HTTPException(status_code=404, detail="Source not found")
        source = normalize_source(source)
        if user.branch_id not in source["branch_ids"]:
            raise HTTPException(status_code=403, detail="This sheet source isn't assigned to your branch")
    result = await _internal_pull_source(source_id, range_)
    if result.get("error"):
        err = result["error"]
        if err == "source_not_found":
            raise HTTPException(status_code=404, detail="Source not found")
        if err == "no_spreadsheet_id":
            raise HTTPException(status_code=400, detail="Source has no spreadsheet_id. Edit the source and paste the Google Sheet URL.")
        if err == "not_connected":
            raise HTTPException(status_code=400, detail="Not connected to Google. Click 'Continue with Google' first.")
        if err == "already_syncing":
            raise HTTPException(status_code=409, detail="This sheet is already syncing. Try again in a minute.")
        raise HTTPException(status_code=502, detail=err)
    return result


# ---------- Background auto-sync scheduler ----------

_SCHEDULER_TASK: Optional[asyncio.Task] = None


async def _auto_sync_loop() -> None:
    """Runs every 60s. Pulls each source whose auto_sync_enabled=True and whose
    last_synced is older than its auto_sync_interval_minutes."""
    while True:
        try:
            now = datetime.now(timezone.utc)
            sources = await v3_col("marketing_sources").find(
                {"source_type": "google_sheets", "is_active": True, "auto_sync_enabled": True, "spreadsheet_id": {"$ne": ""}},
                {"_id": 0},
            ).to_list(200)
            for s in sources:
                interval = max(int(s.get("auto_sync_interval_minutes") or 30), 5)
                last = s.get("last_synced")
                due = True
                if last:
                    try:
                        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
                        if last_dt.tzinfo is None:
                            last_dt = last_dt.replace(tzinfo=timezone.utc)
                        due = (now - last_dt).total_seconds() >= interval * 60
                    except Exception:
                        due = True
                if due:
                    try:
                        await _internal_pull_source(s["id"])
                    except Exception:
                        pass
        except Exception:
            pass
        await asyncio.sleep(60)


def start_auto_sync_scheduler() -> None:
    """Spawn the singleton scheduler task. Safe to call multiple times."""
    global _SCHEDULER_TASK
    if _SCHEDULER_TASK is None or _SCHEDULER_TASK.done():
        loop = asyncio.get_event_loop()
        _SCHEDULER_TASK = loop.create_task(_auto_sync_loop())
