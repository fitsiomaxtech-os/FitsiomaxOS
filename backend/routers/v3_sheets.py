from fastapi import APIRouter, HTTPException, Depends
from typing import Dict
import uuid
import os

from database import v3_col
from utils import now_iso, without_past_moves
from deps import v3_require_roles
from schemas.v3 import (
    V3UserOut, V3SheetConnectionCreate, V3SheetMappingInput, V3SheetSyncInput,
)

router = APIRouter(prefix="/api/v3")


@router.post("/sheets/connections")
async def v3_create_sheet_connection(payload: V3SheetConnectionCreate, _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    callback_url = os.environ.get("GOOGLE_SHEETS_CALLBACK_URL") or os.environ.get("GOOGLE_REDIRECT_URI") or ""
    connection = {
        "id": str(uuid.uuid4()),
        "connection_name": payload.connection_name,
        "spreadsheet_id": payload.spreadsheet_id,
        "sync_interval_minutes": payload.sync_interval_minutes,
        "oauth_connected": False,
        "callback_url": callback_url,
        "created_at": now_iso(),
    }
    await v3_col("sheet_connections").insert_one(connection.copy())
    return connection


@router.get("/sheets/connections")
async def v3_get_sheet_connections(_: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    rows = await v3_col("sheet_connections").find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return rows


@router.post("/sheets/connections/{connection_id}/mapping")
async def v3_save_mapping(connection_id: str, payload: V3SheetMappingInput, _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    await v3_col("sheet_mappings").update_one(
        {"connection_id": connection_id},
        {"$set": {"connection_id": connection_id, "field_map": payload.field_map, "create_new_fields": payload.create_new_fields, "updated_at": now_iso()}},
        upsert=True,
    )
    return {"message": "Mapping saved", "connection_id": connection_id}


@router.post("/sheets/connections/{connection_id}/sync")
async def v3_sync_sheet(connection_id: str, payload: V3SheetSyncInput, _: V3UserOut = Depends(v3_require_roles("business_dev", "super_admin"))):
    mapping = await v3_col("sheet_mappings").find_one({"connection_id": connection_id}, {"_id": 0})
    if not mapping:
        raise HTTPException(status_code=400, detail="Field mapping not configured")

    imported = 0
    skipped = 0
    for tab in payload.tabs:
        for row in tab.rows:
            phone_key = mapping["field_map"].get("phone", "phone")
            phone_val = (row.get(phone_key) or "").strip()
            if not phone_val:
                skipped += 1
                continue
            exists = await v3_col("leads").find_one(without_past_moves({"phone": phone_val}), {"_id": 0})
            if exists:
                skipped += 1
                continue

            name_key = mapping["field_map"].get("name", "name")
            email_key = mapping["field_map"].get("email", "email")
            vertical_key = mapping["field_map"].get("vertical", "vertical")

            extra_fields: Dict[str, str] = {}
            if mapping.get("create_new_fields", True):
                for key, value in row.items():
                    if key not in [name_key, phone_key, email_key, vertical_key]:
                        extra_fields[key] = value

            lead = {
                "id": str(uuid.uuid4()),
                "name": row.get(name_key, "Unknown Lead"),
                "phone": phone_val,
                "email": row.get(email_key, ""),
                "vertical": row.get(vertical_key, "offline_physiotherapy"),
                "source_tab": tab.tab_name,
                "source_type": "google_sheet",
                "stage": "New Leads",
                "branch_id": None,
                "notes": "Imported from Google Sheet",
                "extra_fields": extra_fields,
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
            await v3_col("leads").insert_one(lead.copy())
            imported += 1

    return {"imported": imported, "skipped": skipped, "connection_id": connection_id}
