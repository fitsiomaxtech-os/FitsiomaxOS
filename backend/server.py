from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
import os
import logging

from database import client
from indexes import ensure_core_indexes
from seed import ensure_v1_seed_data, v2_seed, v3_seed, migrate_branch_stages, migrate_consultation_stages, migrate_head_consultation_stages, deactivate_legacy_demo_admin, migrate_consultant_roles, migrate_branch_admin_roles, backfill_consultant_branches_from_employees, migrate_designation_roles, retire_aliased_designation_roles, ensure_structure_departments, dedupe_department_designations, sync_head_physio_doctors, consolidate_head_physio_doctors, retire_experts_without_a_login, backfill_login_history_from_sessions, normalize_session_item_prices, normalize_lead_session_package_prices, flag_manual_session_packages, migrate_course_prices_to_totals, ensure_fitness_packages, repair_flattened_fitness_prices, backfill_branch_codes, backfill_patient_numbers, backfill_lead_enquiry_dates, backfill_zumba_package_sessions, ensure_rnr_stage, ensure_branch_admin_stages, ensure_branch_cancelled_stage, ensure_sales_stage_roles, ensure_sales_arm_split, ensure_branch_not_a_prospect_stage, ensure_consultation_booked_stage, ensure_rehab_stage, ensure_diet_and_completed_stages, ensure_diet_chart_stage, retire_consultation_completed_stage, undo_branch_leads_stage, ensure_branch_lead_sources
from routers.v3_google_sheets import start_auto_sync_scheduler
from payment_reminders import start_payment_reminder_scheduler
import lead_purge
from routers import v1, v2, v3_auth, v3_config, v3_leads, v3_branch_admin, v3_appointments, v3_sheets, v3_dashboard, v3_head_physio, v3_finance, v3_head_physio_board, v3_physio_board, v3_session_assign, v3_patient_view, v3_marketing, v3_stages, v3_hr, v3_hr_ops, v3_hr_performance, v3_clock, v3_me, v3_security, v3_lead_fields, v3_branch_mgmt, v3_google_sheets, v3_packages, v3_public_super_admin, v3_password_reset, v3_store, v3_consult_appointments, v3_reviews, v3_patient_portal, v3_testimonials, v3_recruitment, v3_diet, v3_lead_documents, v3_inventory, v3_text_presets, v3_shifts, v3_zumba, v3_rehab, v3_fitness, v3_feedback, v3_client_reviews, v3_eod_reports, v3_branch_calendar, v3_session_payment, v3_physio_absence, v3_vendors, v3_past_data

app = FastAPI()

app.include_router(v1.router)
app.include_router(v2.router)
app.include_router(v3_auth.router)
app.include_router(v3_config.router)
app.include_router(v3_leads.router)
app.include_router(v3_branch_admin.router)
app.include_router(v3_appointments.router)
app.include_router(v3_sheets.router)
app.include_router(v3_dashboard.router)
app.include_router(v3_head_physio.router)
app.include_router(v3_finance.router)
app.include_router(v3_head_physio_board.router)
app.include_router(v3_physio_board.router)
app.include_router(v3_diet.router)
app.include_router(v3_lead_documents.router)
app.include_router(v3_session_assign.router)
app.include_router(v3_patient_view.router)
app.include_router(v3_marketing.router)
app.include_router(v3_stages.router)
app.include_router(v3_hr.router)
app.include_router(v3_hr_ops.router)
app.include_router(v3_clock.router)
app.include_router(v3_me.router)
app.include_router(v3_security.router)
app.include_router(v3_text_presets.router)
app.include_router(v3_lead_fields.router)
app.include_router(v3_branch_mgmt.router)
app.include_router(v3_google_sheets.router)
app.include_router(v3_packages.router)
app.include_router(v3_public_super_admin.router)
app.include_router(v3_password_reset.router)
app.include_router(v3_store.router)
app.include_router(v3_consult_appointments.router)
app.include_router(v3_reviews.router)
app.include_router(v3_patient_portal.router)
app.include_router(v3_testimonials.router)
app.include_router(v3_recruitment.router)
app.include_router(v3_inventory.router)
app.include_router(v3_vendors.router)
app.include_router(v3_shifts.router)
app.include_router(v3_zumba.router)
app.include_router(v3_rehab.router)
app.include_router(v3_fitness.router)
app.include_router(v3_feedback.router)
app.include_router(v3_client_reviews.router)
app.include_router(v3_eod_reports.router)
app.include_router(v3_branch_calendar.router)
app.include_router(v3_hr_performance.router)
app.include_router(v3_session_payment.router)
app.include_router(v3_physio_absence.router)
app.include_router(v3_past_data.router)

UPLOAD_ROOT = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)
app.mount("/api/v3/uploads", StaticFiles(directory=UPLOAD_ROOT), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_seed_data():
    # First, before the seed and migration passes below: those run hundreds of queries
    # of their own, and until this the collections had no index but _id_ -- which
    # nothing in this codebase ever looks a document up by. See indexes.py.
    await ensure_core_indexes()
    await ensure_v1_seed_data()
    await v2_seed()
    await v3_seed()
    await deactivate_legacy_demo_admin()
    await migrate_branch_stages()
    await ensure_rnr_stage()
    # Must follow migrate_branch_stages: that one may re-seed the whole sales list from the
    # built-in defaults, which would drop the two stages this adds on top of it.
    await ensure_branch_admin_stages()
    # Rollback of the real "Leads" stage. Must follow the above, which puts Branch Assign
    # back in place for the leads this returns to it.
    await undo_branch_leads_stage()
    # Last of the sales-pipeline passes, because it appends itself after whatever the ones
    # above left in place -- run earlier, the stages they add would land after Cancelled.
    await ensure_branch_cancelled_stage()
    # After every pass that can create a sales stage, so each one gets stamped in the same
    # boot it appears in. From here on the behaviour hangs off the role rather than off the
    # name, which is what makes a rename in CI/CD ROOTS safe.
    await ensure_sales_stage_roles()
    # Last of all the sales passes: it copies whatever they left into the online arm, so
    # anything added after it would land on the offline side only.
    await ensure_sales_arm_split()
    # The exception to the line above, and why it inserts itself once per arm rather than
    # once: it has to run after the split, or the boot that first creates the online arm
    # copies an offline pipeline that does not have this stage yet.
    await ensure_branch_not_a_prospect_stage()
    await migrate_consultation_stages()
    # After the consultation stages exist, and before the three passes below that position
    # themselves by order: this one goes in at the head of the pipeline and pushes every
    # other stage along by one, so running it first keeps their arithmetic on one list.
    await ensure_consultation_booked_stage()
    # After the consultation stages exist, since it inserts itself relative to one of them.
    await ensure_rehab_stage()
    await ensure_diet_and_completed_stages()
    # After Diet Consultation exists, since it inserts itself right after it.
    await ensure_diet_chart_stage()
    await retire_consultation_completed_stage()
    await migrate_head_consultation_stages()
    # Before the flat-rate pass below, which skips Rehab entirely — but ordering it first
    # keeps the two from ever being read as competing for the same rows.
    await migrate_course_prices_to_totals()
    await ensure_fitness_packages()
    # After the shelf exists and before the flat-rate pass, which no longer touches Fitness
    # at all: this only has to undo the boots where it did.
    await repair_flattened_fitness_prices()
    await normalize_session_item_prices()
    await normalize_lead_session_package_prices()
    # After the pass above, so a lead it re-priced is still left for the branch to price.
    await flag_manual_session_packages()
    await backfill_branch_codes()
    # Reconciles Lead Sources against the current branch list every startup — see its own
    # docstring for why that has to be safe to run repeatedly rather than a one-shot.
    await ensure_branch_lead_sources()
    await backfill_patient_numbers()
    # After backfill_patient_numbers, not before: that one draws a lead's number from its
    # created_at, and the numbers already issued are left as they are. Running it the other
    # way round would hand a lead a number dated by the enquiry and leave every number
    # issued before today dated by the import, which is two rules for one identifier.
    await backfill_lead_enquiry_dates()
    await backfill_zumba_package_sessions()
    # Every job title in the structure becomes a role somebody can be given, which is what
    # makes Designation and Role one list rather than two that only met when a user
    # happened to be created. Imported here rather than at module scope: it is the only
    # thing startup needs from that router, and the router imports plenty startup does not.
    from routers.v3_hr import ensure_roles_for_designations
    await ensure_roles_for_designations()
    # Before the two expert syncs below and after the designations sweep above: it renames
    # head_physio -> consultant on the logins, and both of those read the consultant
    # family off `users.role`, so running it later would leave one boot's worth of
    # consultants unsynced.
    await migrate_consultant_roles()
    # Beside it and for the same reason: the three practice variants of Branch Admin
    # collapse onto plain branch_admin, and this has to run after the designations sweep
    # above or that pass would mint back the slug this one has just retired.
    await migrate_branch_admin_roles()
    # The desks that used to be typed by hand — HR Admin, Nutritionist, Zumba — onto the
    # fixed slugs, and HR's structure filled in with every department and designation the
    # clinic works to. The structure runs after the rename so the designations it adds are
    # matched against roles that have already settled.
    await migrate_designation_roles()
    # The duplicate desks minted before the alias map existed — BUSINESS DEVELOPMENT
    # EXECUTIVE beside BUSINESS DEV, and the two physiotherapist titles beside their own.
    await retire_aliased_designation_roles()
    await ensure_structure_departments()
    # Straight after the structure is filled in, because that pass is the last thing
    # that appends to a department's designations and this is what leaves each list
    # holding one entry per job — the Designation picker was offering CONSULTANT twice
    # and the reader had no way to tell the two apart.
    await dedupe_department_designations()
    # After the role renames above, because it reads the consultant family off users.role
    # and the retired slugs have only just been rewritten into it. Before the expert syncs
    # below, so a Consultant whose branches are restored here is already posted by the time
    # anything reads them.
    await backfill_consultant_branches_from_employees()
    await sync_head_physio_doctors()
    # Must follow the sync above: that one creates any missing record, this one collapses
    # every CONSULTANT's records down to the single branchless one they should have.
    await consolidate_head_physio_doctors()
    # Anyone whose login was switched off or deleted before that followed through to
    # their expert profile. Without this they stay in every consultant list.
    await retire_experts_without_a_login()
    await backfill_login_history_from_sessions()
    # Portal accounts made before phone sign-in carry no phone to be found by.
    await v3_patient_portal.backfill_portal_account_phones()
    await v3_inventory.ensure_inventory_indexes()
    await v3_vendors.ensure_vendor_indexes()
    await v3_finance.return_self_approved_expenses()
    # Anything a deleted patient left behind on the other boards goes — see its docstring.
    await lead_purge.sweep_orphaned_trails()
    start_auto_sync_scheduler()
    start_payment_reminder_scheduler()


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
