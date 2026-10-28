SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]

V2_LOCATIONS = ["Anna Nagar", "T Nagar", "Parrys", "ECR"]

V3_VERTICALS = [
    "offline_physiotherapy",
    "online_physiotherapy",
    "online_fitness",
    "offline_fitness_gym",
]

# Where the Pre-Sales desk puts a lead it has given up on -- one that never picks up, says
# no, or was never a real enquiry. After Appointment, and final: the live stages are the
# worklist a rep opens every morning, and this is the one a lead leaves the funnel by.
# Named as Branch Admin's Branch Leads names it, so the Pre Sales dashboard's cards read
# the same strip: it was "Lost" until seed.replace_presales_lost_stage renamed it.
PRESALES_NOT_A_PROSPECT_STAGE = "Not a prospect"
# The lead the desk has lost -- last, after Not a prospect, and final as well. Also the
# former name of PRESALES_NOT_A_PROSPECT_STAGE, which seed.replace_presales_lost_stage reads.
PRESALES_LOST_STAGE = "Lost"
# The client who will come later and wants the visit held -- between Not a prospect and
# Lost, and not final: they are still coming. It was the last stage for a day, then became
# Lost (seed.rename_presales_pre_book_stage), and is back in front of Lost now
# (seed.restore_presales_pre_book_stage).
PRESALES_PRE_BOOK_STAGE = "Pre Book"

V3_STAGES = [
    "New Leads",
    "RNR",
    "Follow Up",
    "Appointment",
    PRESALES_NOT_A_PROSPECT_STAGE,
    PRESALES_PRE_BOOK_STAGE,
    PRESALES_LOST_STAGE,
]

V3_BRANCH_STAGES = [
    "New Appointment",
    "Portfolio",
    "Follow Up",
    "Appointment",
    "Not a prospect",
    "Pre Book",
    "Cancelled",
]

# The Branch ("sales") pipeline is one shared list, but its opening stages depend on who
# works the lead first — see lead_control. A sales stage may carry an `applies_to` of
# "pre_sales" or "branch_admin" to appear only for branches under that Lead Control;
# a stage with no `applies_to` (the default, and every stage that shipped before this)
# belongs to both and is what the bulk of the pipeline stays.
#
# A branch on Pre-Sales control opens at "New Appointment" — the lead was already worked
# and qualified by the Pre-Sales desk, so it arrives as a booked appointment. A branch
# running its own leads has done none of that yet: the lead is raw, so it opens at
# "Branch Assign" and gets an RNR stage for the calls that go unanswered, mirroring the
# Pre-Sales desk's own New Leads -> RNR -> Follow Up shape.
BRANCH_ADMIN_ENTRY_STAGE = "Branch Assign"
BRANCH_ADMIN_RNR_STAGE = "RNR"

# Where a branch appointment goes when it is called off. Last in the pipeline and final:
# nothing moves on from it, and reaching it releases the slot the consultation was holding
# (see v3_move_branch_stage).
#
# Named here rather than written as a literal at each site because three of them have to
# agree -- the seed that creates the pill, the stage move that frees the slot, and the
# booking endpoint's own final_stage -- and they were already one rename apart from
# silently doing nothing. Note it is "Cancelled", not the consultation pipeline's "Cancel":
# two pipelines, two stages, and the Branch Leads card shows both.
BRANCH_CANCELLED_STAGE = "Cancelled"

# Where a booked consultation lands. The other half of the booking dialog's two outcomes,
# BRANCH_CANCELLED_STAGE being the first.
BRANCH_APPOINTMENT_STAGE = "Appointment"
# What it was called until 2026-10-14 (see seed.rename_branch_appointment_stage). Still
# written on leads from before the rename, and still sent by a browser running an older chunk.
BRANCH_APPOINTMENT_STAGE_FORMER = "Appointment Date & Time"

# Where a lead goes when the branch decides there is no client here to win -- the enquiry
# was a wrong number, a competitor, a price-check, somebody outside the catchment, or a
# person who simply does not want treatment. Sits directly after the appointment stage
# because that is where the branch usually finds out: the call is made or the visit is
# booked, and only then is it clear this was never a prospect.
#
# Not the same thing as BRANCH_CANCELLED_STAGE beside it, which is why it is its own stage
# rather than another reason code on that one. A cancellation is a real client calling off
# a real appointment -- the slot goes back on the calendar and the branch may well rebook
# them. This is the lead being written off, and nothing is released because there was
# nothing worth holding. Keeping the two apart is what lets a branch read its cancellation
# rate as cancellations rather than as bad leads.
BRANCH_NOT_A_PROSPECT_STAGE = "Not a prospect"

# Where a lead waits when the client has committed to coming later -- "book me in for next
# month" -- and has paid to hold that place. Sits after Not a prospect, and is not final:
# the lead is booked onto a real slot from here when the planned visit comes round.
#
# Its own stage rather than an early Appointment, because there is no slot yet to hold. What
# the lead carries instead is when the client said they would come (pre_book_plan /
# pre_book_date, asked on the move) and what they paid up front: a consultation package
# and/or an advance, collected in the Pre Book popup and applied to the real fees on the day
# (see routers/v3_pre_book.py).
BRANCH_PRE_BOOK_STAGE = "Pre Book"

# When the client said they would come, as the move onto Pre Book offers it. The label is
# what the board shows; the date it works out to travels beside it and may be adjusted, so
# "Next Month" can mean the 3rd as readily as today's date a month on. "date" is a day the
# desk picked outright. Mirrored by PRE_BOOK_PLANS in BranchAdminBoard.jsx.
PRE_BOOK_PLANS = {
    "next_week": "Next Week",
    "two_weeks": "In 2 Weeks",
    "next_month": "Next Month",
    "two_months": "In 2 Months",
    "three_months": "In 3 Months",
    "date": "On a Date",
}

# ------------------------------------------------------------------- Branch arms ("sales")
#
# The clinic runs two practices — one in the room, one over video — and they do not work a
# lead the same way, so each gets its own Branch Lead pipeline rather than sharing one list
# and pretending the difference is cosmetic. The stage row carries `arm`; which arm a record
# belongs to is read off its vertical (see stage_utils.sales_arm_for).
#
# Offline is the arm the single shared list became, so an install that has never heard of
# arms reads as offline and nothing about it changes.
SALES_ARM_OFFLINE = "offline"
SALES_ARM_ONLINE = "online"
SALES_ARMS = (SALES_ARM_OFFLINE, SALES_ARM_ONLINE)

# ------------------------------------------------------------------ Stage roles ("sales")
#
# A handful of Branch stages are not just positions on a strip: the board opens the booking
# dialog on one, frees the consultation slot on another, and hides a third from the pills
# because it is reached by its own dialog. Every one of those behaviours used to be written
# as a comparison against the stage's *name*, on both sides of the wire — which meant Super
# Admin renaming the stage in CI/CD ROOTS silently detached the behaviour from the stage.
# Renaming "Appointment Date & Time" did not rename a label; it stopped appointments being
# bookable, and the booking endpoint rejected the move outright (see its final_stage check).
#
# So the behaviour hangs off a `role` stamped on the stage document instead. The name is
# then Super Admin's to change: the role travels with the row through a rename, and every
# site that has to recognise the stage asks for the role and gets whatever it is called now.
#
# This map is only the initial stamping, applied by name once to stages that predate the
# field (see seed.ensure_sales_stage_roles). It is not consulted at runtime — a stage that
# already carries a role is never re-matched against these names.
SALES_STAGE_ROLE_APPOINTMENT = "appointment"
SALES_STAGE_ROLE_CANCELLED = "cancelled"
SALES_STAGE_ROLE_RNR = "rnr"
SALES_STAGE_ROLE_PORTFOLIO = "portfolio"
# Not a behaviour of its own, but one of the three exits the board offers a lead standing at
# Appointment. Named by role for the same reason as the rest: renamed, it silently vanished
# from that list rather than being renamed in it.
SALES_STAGE_ROLE_FOLLOW_UP = "follow_up"
# The fourth exit from Appointment, and named by role for the same reason Follow Up is: the
# board has to know which pill this is to offer it there at all (see APPOINTMENT_EXITS in
# BranchAdminBoard.jsx), and to keep counting a written-off lead under it once a consultant
# has moved the patient along the consultation pipeline underneath.
SALES_STAGE_ROLE_NOT_A_PROSPECT = "not_a_prospect"
# The move onto it asks when the client plans to come, and the board opens the Pre Book
# popup on it -- both found by role, so a rename keeps them.
SALES_STAGE_ROLE_PRE_BOOK = "pre_book"

SALES_STAGE_ROLES_BY_NAME = {
    BRANCH_APPOINTMENT_STAGE: SALES_STAGE_ROLE_APPOINTMENT,
    BRANCH_CANCELLED_STAGE: SALES_STAGE_ROLE_CANCELLED,
    BRANCH_NOT_A_PROSPECT_STAGE: SALES_STAGE_ROLE_NOT_A_PROSPECT,
    BRANCH_PRE_BOOK_STAGE: SALES_STAGE_ROLE_PRE_BOOK,
    BRANCH_ADMIN_RNR_STAGE: SALES_STAGE_ROLE_RNR,
    "Portfolio": SALES_STAGE_ROLE_PORTFOLIO,
    "Follow Up": SALES_STAGE_ROLE_FOLLOW_UP,
}

# What each role falls back to when no stage carries it — a database that predates the
# stamping, or one where Super Admin has deleted the stage outright.
SALES_STAGE_ROLE_FALLBACKS = {v: k for k, v in SALES_STAGE_ROLES_BY_NAME.items()}

# Branch's own consultation pipeline. "New Appointment" was retired, and the stage that
# replaced it — "Follow Up" — has since been renamed "Consultation Booked" (see
# seed.migrate_consultation_stages). The Head Physio's independent pipeline below still
# has its own New Appointment stage.
#
# The rename is not cosmetic. This is where a lead lands the moment Branch Leads books its
# appointment, and while it was called "Follow Up" it shared a name with the Branch
# ("sales") pipeline's own Follow Up stage — which meant the Consultation tab dropped it
# from its pill bar (one name, one pill, kept on the Branch side; see
# consultationOnlyStages in BranchAdminBoard.jsx). Every freshly booked patient therefore
# sat on a stage that tab had no pill for: in the list, counted in All Stages, and under
# none of the cards above it. A name of its own gives the stage a pill of its own.
V3_CONSULTATION_STAGES = [
    "Consultation Booked",
    "Consultation Visit",
    "Fee Collected",
    "Physio Assign",
    # "Consultation Completed" was here. It is still written to a lead -- it is how a
    # Consultation Only patient is closed out -- but it has no pill of its own any more:
    # the Completed stage takes those patients in beside everybody who finished a course.
    # See retire_consultation_completed_stage in seed.py.
    "Cancel",
]

# Standalone Head Physio consultation pipeline — fully independent from the
# Branch's V3_CONSULTATION_STAGES above (separate lead field, separate stage type).
# Consultation Pack is chosen inline in the lead popup (not a stage move), and Physio
# Assign lives entirely on Branch Admin's own board now (after Treatment Fee).
V3_HEAD_CONSULTATION_STAGES = [
    "New Appointment",
    "Consultation Visit",
]

# Recruitment pipeline for the Human Resource Master View. Candidates (job seekers), not
# patients — they live in their own `candidates` collection and never touch `leads`.
#
# Seeded once by v3_recruitment._ensure_recruitment_stages, then owned by the database:
# nothing reads these literals at runtime, so HR renaming a stage is safe. Candidates
# reference a stage by id, not by name, so a rename needs no migration at all.
V3_RECRUITMENT_STAGES = [
    # (name, colour, is_final)
    ("Applied", "#6366f1", False),
    ("Screening", "#0ea5e9", False),
    ("Interview", "#f59e0b", False),
    ("Selected", "#a855f7", False),
    ("Offer Sent", "#14b8a6", False),
    ("Joined", "#22c55e", True),
    ("Rejected", "#ef4444", True),
]

# ------------------------------------------------------------- Branch expense categories
#
# What a branch may record spending against. A fixed list, not a free-text box: an
# accountant reading a month of these wants them to add up by category, and typed
# categories drift into "Maintenance", "maintenence" and "AC repair" for one thing.
#
# Rent, Salary and Electricity ("EB") are deliberately absent. They are large, fixed and
# paid centrally by the accountant against an invoice or a standing instruction — a branch
# holds no cash to pay a month's rent out of, and an accountant signing off a Rs.80,000
# "rent" line a branch typed is signing off a figure with nothing behind it. Those stay on
# the accountant's own expense screen. Enforced in create_expense (v3_finance.py); mirrored
# on the client in frontend/src/lib/expenseCategories.js.
BRANCH_EXPENSE_CATEGORIES = [
    "Water",
    "Internet & Phone",
    "Maintenance",
    "Equipment",
    "Consumables",
    "Housekeeping",
    "Marketing",
    "Travel",
    "Staff Welfare",
    "Other",
]

# A branch may never file against these — head office pays them. Matched on the trimmed
# lowercased string so "Rent ", "RENT" and "eb" cannot slip past.
BRANCH_BLOCKED_EXPENSE_CATEGORIES = {
    "rent", "salary", "salaries", "staff salary", "staff salaries",
    "electricity", "eb", "electricity board", "electricity bill", "current bill",
}

