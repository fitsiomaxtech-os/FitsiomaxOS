from pydantic import BaseModel, ConfigDict
from typing import List, Optional, Dict, Literal, Any


class V3UserOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    full_name: str
    email: str
    # Not a Literal — custom roles can be added at runtime via POST /hr/roles
    # (see v3_hr.py), so any string already stored on a user document must
    # deserialize here instead of 500ing every endpoint that returns it.
    role: str
    branch_id: Optional[str] = None
    # A CONSULTANT can be assigned to more than one branch (branch_id stays the
    # "primary"/first branch for every existing single-branch filter elsewhere);
    # this is the additional set consulted for branch-switching on their own board.
    branch_ids: Optional[List[str]] = None
    # The headshot HR uploaded when this person was taken on, so a board can show who is
    # signed in rather than the same grey outline for everybody. Stored on the employee
    # record, not the login — filled in at sign-in and on /auth/me, which is where the
    # frontend takes its copy of the user from. Empty for an account with no employee
    # behind it, which every seeded and shared login is.
    photo_url: Optional[str] = ""
    created_at: str

    # No role normalisation here on purpose. "consultant" used to be rewritten to
    # "physio" as a legacy UI alias, which is why nobody could ever actually be a
    # CONSULTANT: the slug was silently turned into a treating physio's on the way out of
    # every endpoint, board included. `consultant` and `online_consultant` are now the
    # real slugs for the consultation desk (see HEAD_PHYSIO_ROLES in deps.py), so the
    # role has to survive this model unchanged.


class V3LoginRequest(BaseModel):
    email: str
    password: str


class V3LoginResponse(BaseModel):
    token: str
    user: V3UserOut


# The other answer POST /auth/login can give: no token, a challenge. Two-factor accounts
# get a code by email and finish at /auth/login/verify-2fa with these two fields.
class V3TwoFactorVerifyRequest(BaseModel):
    challenge_id: str
    code: str


class V3TwoFactorResendRequest(BaseModel):
    challenge_id: str


class V3VerticalCreate(BaseModel):
    name: str
    active: bool = True


class V3VerticalOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    active: bool
    created_at: str


class V3TreatmentTypeCreate(BaseModel):
    name: str


class V3TreatmentTypeUpdate(BaseModel):
    name: str


class V3TreatmentTypeOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    created_at: str


# Type of Physios — the kinds of physiotherapy service the clinic offers, kept the same
# shape as a treatment type for the same reason: a name is the whole record, because the
# price and the session count belong to a package in FITSIO STORE.
class V3PhysioTypeCreate(BaseModel):
    name: str


class V3PhysioTypeUpdate(BaseModel):
    name: str


class V3DoctorServiceInput(BaseModel):
    """The service an expert is offered under, by name.

    The name and not the id: a doctors record already carries denormalised text for
    everything a calendar prints, and a picklist entry that is renamed is renamed
    through to the experts holding it, which the rename endpoint does.

    Empty clears it — an expert offered under no particular service is the state every
    one of them starts in.
    """
    service_type: str = ""


class V3DoctorMeetLinkInput(BaseModel):
    """The video room an expert takes their appointments in.

    One link per expert, not one per appointment: a Meet room is reusable and the day is
    already divided by the slots they published, so every patient booked with them can be
    sent the same address. Nothing here generates it — the expert makes the room in their
    own Google account and the branch records it.

    Empty clears it, which is the state every expert starts in and the one an in-the-room
    desk stays in.
    """
    meet_link: str = ""


class V3PhysioTypeOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    created_at: str


class V3BranchCreate(BaseModel):
    branch_name: str
    address: str
    admin_name: str
    admin_email: str
    admin_password: str
    admin_phone: Optional[str] = ""
    vertical: str = "offline_physiotherapy"
    code: Optional[str] = None  # short unique prefix for Patient Numbers, e.g. "ANN" — auto-derived if omitted
    lead_control: Optional[str] = None  # "pre_sales" | "branch_admin" — see backend/lead_control.py


class V3BranchOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    code: Optional[str] = None
    branch_name: str
    address: str
    # Empty on a branch nobody runs yet — branches are created unassigned and given their
    # admin afterwards (see v3_branch_mgmt.create_branch_with_existing_admin), and
    # v3_config blanks all three when an admin's user record is deleted.
    admin_user_id: str = ""
    admin_name: str = ""
    admin_email: str = ""
    admin_phone: Optional[str] = ""
    vertical: str
    opened_date: Optional[str] = ""
    opening_hours: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    map_location: Optional[str] = ""
    weekly_hours: Optional[Dict[str, Any]] = None
    holidays: Optional[List[str]] = None
    # Absent on every branch made before Lead Control existed; the readers default it
    # to "pre_sales" rather than this schema, so an old branch keeps the old behaviour.
    lead_control: Optional[str] = None
    created_at: str


class V3BranchUpdate(BaseModel):
    code: Optional[str] = None
    branch_name: Optional[str] = None
    address: Optional[str] = None
    admin_name: Optional[str] = None
    admin_email: Optional[str] = None
    admin_phone: Optional[str] = None
    vertical: Optional[str] = None
    opened_date: Optional[str] = None
    opening_hours: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    map_location: Optional[str] = None
    weekly_hours: Optional[Dict[str, Any]] = None
    holidays: Optional[List[str]] = None
    lead_control: Optional[str] = None  # "pre_sales" | "branch_admin"
    # Who picks the branch's leads up when lead_control returns to "pre_sales". Not stored
    # on the branch — it names the Pre-Sales rep the leads are handed to, and is recorded
    # against that switch. Ignored when switching the other way, since a branch working its
    # own leads has no Pre-Sales rep on them at all.
    lead_control_assignee_id: Optional[str] = None


class V3DoctorCreate(BaseModel):
    full_name: str
    profile_type: Literal["head_physio", "physio", "doctor", "nutrition_coach"]
    branch_id: Optional[str] = None
    specialization: Optional[str] = ""
    employee_id: Optional[str] = None
    joining_date: Optional[str] = None


class V3DoctorSlotsInput(BaseModel):
    slots: List[str]


class V3DoctorOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    full_name: str
    profile_type: str
    branch_id: Optional[str] = None  # a head_physio user can exist before being assigned a branch
    specialization: Optional[str] = ""
    employee_id: Optional[str] = None
    joining_date: Optional[str] = None
    slots: List[str] = []
    # Patients this physio takes in one slot — a treatment floor runs two or three at
    # once. None means the default; a Head Physio is pinned to 1 whatever is stored.
    # See slot_capacity_of() in utils.py.
    slot_capacity: Optional[int] = None
    # The expert's own video room, recorded on the calendar that publishes their days and
    # sent to the patient when one of those days is booked.
    #
    # Declared, and not left to ride along on the stored record, because this model ignores
    # extras: an undeclared field is dropped on the way out, so /doctors would answer
    # without it however faithfully it was saved. service_type is the standing proof —
    # stored, patched by its own endpoint, and invisible to every caller of this list.
    meet_link: Optional[str] = ""
    # The working window this expert is rostered on (MANAGEMENT → TIME MANAGEMENT). The
    # name and both ends are resolved from the shift on read, not stored here, so editing
    # a shift's hours moves everyone on it — see shift_utils.attach_shifts.
    shift_id: Optional[str] = None
    # Several, because a split day is ordinary: 8 AM – 1 PM and back again 5 PM – 9 PM is
    # two windows on one person. shift_start/shift_end stay the outer edges of the day for
    # every caller that only wants to say "roughly when"; `shift_windows` is the halves
    # themselves, which is what a calendar has to publish against.
    shift_ids: Optional[List[str]] = []
    shift_name: Optional[str] = ""
    shift_start: Optional[str] = None
    shift_end: Optional[str] = None
    shift_windows: Optional[List[dict]] = []
    # The Super Admin's own consultant record, which every branch's Consultant Calendar now
    # lists. Declared for the reason meet_link is: this model drops what it does not name,
    # and the calendar needs it to tag the row.
    is_super_admin: Optional[bool] = False
    created_at: str


class V3LeadData(BaseModel):
    """The ad-platform record a lead arrived on — Meta's own lead export, field for field.

    Kept as its own nested block rather than flattened onto the lead for two reasons. The
    first is a collision: this `id` is Meta's lead id and `created_time` is when Meta
    captured the form, neither of which is our `id` or our `created_at` — flattening would
    have an ad record quietly overwrite the lead's own identity. The second is that the
    whole block is one audience's (see reads_lead_data in deps.py), and
    one nested field is far easier to withhold than twelve loose ones.

    Every field is optional: a lead typed in by hand carries none of them, and an organic
    lead legitimately has no ad, adset or campaign behind it.
    """

    id: Optional[str] = ""              # Meta's lead id, not ours
    created_time: Optional[str] = ""    # when Meta captured the form, not when we stored it
    ad_id: Optional[str] = ""
    ad_name: Optional[str] = ""
    adset_id: Optional[str] = ""
    adset_name: Optional[str] = ""
    campaign_id: Optional[str] = ""
    campaign_name: Optional[str] = ""
    form_id: Optional[str] = ""
    form_name: Optional[str] = ""
    # None, not False: "nobody said" and "this came off an ad" are different answers, and
    # only the first one is true of a lead somebody typed in.
    is_organic: Optional[bool] = None
    platform: Optional[str] = ""        # "fb" | "ig", as Meta writes it


class V3LeadCreate(BaseModel):
    name: str
    phone: str
    email: Optional[str] = ""
    vertical: str = "offline_physiotherapy"
    source_tab: Optional[str] = None
    source_type: Literal["manual", "google_sheet"] = "manual"
    branch_id: Optional[str] = None
    notes: Optional[str] = ""
    extra_fields: Optional[Dict[str, Any]] = None
    alternative_phone: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    location: Optional[str] = ""
    department: Optional[str] = ""
    condition: Optional[str] = ""
    months_of_pain: Optional[int] = None
    age: Optional[int] = None
    gender: Optional[str] = ""
    occupation: Optional[str] = ""
    expected_consultation_date: Optional[str] = ""
    # The ad record behind the lead — see V3LeadData. Only Super Admin's form offers it.
    lead_data: Optional[V3LeadData] = None


class V3LeadUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    vertical: Optional[str] = None
    source_tab: Optional[str] = None
    notes: Optional[str] = None
    stage: Optional[str] = None
    branch_id: Optional[str] = None
    extra_fields: Optional[Dict[str, Any]] = None
    location: Optional[str] = None
    expected_consultation_date: Optional[str] = None
    months_of_pain: Optional[int] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    occupation: Optional[str] = None
    department: Optional[str] = None
    alternative_phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    condition: Optional[str] = None
    assigned_user_id: Optional[str] = None
    assigned_user_name: Optional[str] = None


class V3LeadOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    patient_number: Optional[str] = None  # e.g. "ANN-260727-0000" — BRANCHCODE-YYMMDD-SEQUENCE, set once branch_id is known
    name: str
    phone: str
    email: Optional[str] = ""
    vertical: str
    source_tab: Optional[str] = None
    source_type: str
    stage: str
    branch_stage: Optional[str] = None
    consultation_stage: Optional[str] = None
    head_consultation_stage: Optional[str] = None  # Head Physio's own pipeline, independent from consultation_stage
    branch_id: Optional[str] = None
    # Not stored on the lead — GET /leads resolves it from the lead's branch on the way
    # out, so flipping a branch's switch rehomes the leads already in flight. See
    # backend/lead_control.py.
    lead_control: Optional[str] = None
    notes: Optional[str] = ""
    extra_fields: Dict[str, Any]
    # The ad record behind the lead (see V3LeadData), or None where the reader is not
    # entitled to it — every endpoint that lists leads withholds it from everyone but
    # Super Admin. So None means either "no ad data" or "not yours to read", and no
    # caller has any need to tell those two apart. This model ignores extras, so without
    # this line the field would never be returned at all.
    lead_data: Optional[Dict[str, Any]] = None
    consultation_fee: Optional[float] = None
    consultation_item_name: Optional[str] = None
    consultation_mode: Optional[str] = None
    package_amount: Optional[float] = None
    package_weeks: Optional[int] = None
    package_id: Optional[str] = None
    package_name: Optional[str] = None
    package_price: Optional[float] = None
    package_paid: Optional[float] = None  # the Consultation Fee payment, by any of the standard modes
    package_payment_mode: Optional[str] = None  # "cash" | "upi" | "card"
    package_payment_details: Optional[dict] = None  # mode-specific fields (UPI txn/UTR, card/account last 4)
    treatment_fee_paid: Optional[float] = None  # the Treatment Fee payment — any payment method
    treatment_fee_payment_mode: Optional[str] = None  # "cash" | "upi" | "card" | "cheque" | "partial"
    treatment_fee_payment_details: Optional[dict] = None  # mode-specific fields (card last 4, cheque no., Partial schedule)
    package_sessions: Optional[int] = None
    package_duration_minutes: Optional[int] = None  # consultation-type packages only — no session count
    package_mode: Optional[str] = None
    # The Session package (FITSIO STORE > Sessions) chosen separately at the Treatment
    # Fee stage — distinct from package_* above, which is the Consultation package Head
    # Physio chooses inline during Consultation Visit.
    session_package_id: Optional[str] = None
    session_package_name: Optional[str] = None
    session_package_price: Optional[float] = None
    session_package_sessions: Optional[int] = None
    session_package_mode: Optional[str] = None
    # The Treatment Package has no catalogue price (a Home Visit > Physiotherapy Distance
    # package): session_package_price stays empty until the Branch Admin types it on the
    # Treatment Fee card.
    session_package_manual: Optional[bool] = None
    # The Rehab course (FITSIO STORE > Rehab) chosen alongside the Rehab referral, kept
    # apart from session_package_* because a patient can be sent away with treatment and
    # rehab both, and one set of fields could only hold one of them. This model ignores
    # extras, so without these the board could never show back what was chosen.
    rehab_package_id: Optional[str] = None
    rehab_package_name: Optional[str] = None
    rehab_package_price: Optional[float] = None
    rehab_package_sessions: Optional[int] = None
    rehab_package_mode: Optional[str] = None
    # The Zumba membership, kept apart from the other two for the same reason they are
    # kept apart from each other: a patient can leave with any combination of them.
    zumba_package_id: Optional[str] = None
    zumba_package_name: Optional[str] = None
    zumba_package_price: Optional[float] = None
    zumba_package_sessions: Optional[int] = None
    zumba_package_mode: Optional[str] = None
    # What was actually taken for the Rehab course, kept apart from the package fields
    # above the way every other fee is: the price is what it costs, this is what is in.
    rehab_fee_paid: Optional[float] = None
    rehab_fee_payment_mode: Optional[str] = None
    rehab_fee_payment_details: Optional[dict] = None
    # Who is delivering the Rehab course, and when they were put on it.
    #
    # Declared for exactly the reason the rehab_package_* block above says it is declared:
    # this model ignores extras, and every lead the Consultations board returns goes out
    # through it. All four were written by assign-rehab and then dropped on the way out, so
    # the Rehab panel's "Rehab Physio" row read "Not assigned" for a patient whose course
    # had been booked, was on a physio's calendar, and was being delivered — and the button
    # beside it went on offering to assign somebody who was already assigned.
    rehab_physio_id: Optional[str] = None
    rehab_physio_name: Optional[str] = None
    rehab_assigned_at: Optional[str] = None
    rehab_stage: Optional[str] = None
    # Every physio the rehab course has been handed between, oldest first — rehab's own
    # counterpart of physio_assignment_history, and kept for the same one reason that one
    # is kept: a physio replaced before delivering a single day leaves no rehab_sessions
    # row behind to be counted, because assign-rehab deletes their upcoming days on the way
    # out. This entry is the only trace that the spell happened at all.
    rehab_assignment_history: Optional[List[Dict[str, Any]]] = None
    consultation_decision: Optional[str] = None  # "consultation_only" | "consultation_treatment" — set by Head Physio at Save & Move
    # Whether the Head Physio also referred this patient to a Nutrition Coach. Orthogonal
    # to consultation_decision — see V3ConsultationDecisionInput.
    diet_recommended: Optional[bool] = False
    # Which of the two the referral was for — see V3ConsultationDecisionInput. Both can be
    # true, and both false is the plain referral every older consultation carries.
    diet_consultation: Optional[bool] = False
    diet_chart: Optional[bool] = False
    rehab_referred: Optional[bool] = False
    # Two marks the branch puts on a patient by hand, and the only fields here that say
    # something about how the branch feels about a patient rather than what the patient has
    # bought or been referred to. Kept apart from the pipeline for that reason: neither ever
    # moves a stage, and clearing one must never be read as progress.
    #
    #   is_vip          — treat this one especially well.
    #   needs_attention — something here needs looking at, whatever the stage says.
    is_vip: Optional[bool] = False
    needs_attention: Optional[bool] = False
    fitness_recommended: Optional[bool] = False
    zumba_recommended: Optional[bool] = False
    # Long Term, per service, set at Move to Admin. Only Rehab and Fitness run long
    # term, and a service is long term when its key is present here -- there is no
    # short/long pair to choose between, so there is nothing to store but the mark and
    # whatever was written about it, which may be nothing.
    long_term_notes: Optional[Dict[str, str]] = None
    # Rehab after Treatment. Ticked beside a Treatment package, Rehab is not sold at the
    # first consultation: the course is finished first, the branch books the patient back
    # in with the Consultant, and the package is chosen at that Rehab consultation. Until
    # then rehab_referred stays False, so no Rehab Fee is asked for and no Rehab pill
    # lists them -- see hp_complete_rehab_consultation, which is what flips it.
    rehab_after_treatment: Optional[bool] = False
    rehab_consult_date: Optional[str] = None
    rehab_consult_time: Optional[str] = None
    rehab_consult_doctor_id: Optional[str] = None
    rehab_consult_doctor_name: Optional[str] = None
    rehab_consult_remarks: Optional[str] = None
    rehab_consult_booked_at: Optional[str] = None
    rehab_consulted_at: Optional[str] = None
    rehab_consulted_by: Optional[str] = None
    # Who is actually delivering that diet plan, set by branch/assign-diet. This model
    # ignores extras, so without these three the Consultations board could never tell an
    # already-assigned patient from a new one and its Reassign control would never appear.
    diet_coach_id: Optional[str] = None
    diet_coach_name: Optional[str] = None
    diet_assigned_at: Optional[str] = None
    # The booked Diet Consultation slot, "YYYY-MM-DDTHH:MM". Distinct from
    # appointment_date/_time above, which are the Head Physio's consultation.
    diet_appointment_at: Optional[str] = None
    diet_stage: Optional[str] = None  # "Diet Consultation Booked" | "Diet Plan Assigned" | "Diet Completed"
    # The Diet Consultation Fee and the FITSIO STORE Diet Package it was collected for.
    # Kept apart from package_* (the Consultation Fee) and session_package_* (the
    # Treatment Fee) so all three read back independently on the Fee Collected panel.
    diet_package_id: Optional[str] = None
    diet_package_name: Optional[str] = None
    diet_package_price: Optional[float] = None
    diet_package_mode: Optional[str] = None  # "online" | "offline"
    diet_fee_paid: Optional[float] = None
    diet_fee_payment_mode: Optional[str] = None
    diet_fee_payment_details: Optional[dict] = None
    # The Diet Chart Fee and the Diet Package it was sold as. A whole second set rather
    # than a reuse of diet_package_*/diet_fee_*: a Diet Consultation and a Diet Chart are
    # two products a patient can be sold on the same visit, so one lead can carry both
    # fees, and folding them into one pair would make the second collection erase the
    # first — leaving the branch unable to say which of the two was paid for.
    diet_chart_package_id: Optional[str] = None
    diet_chart_package_name: Optional[str] = None
    diet_chart_package_price: Optional[float] = None
    diet_chart_package_mode: Optional[str] = None  # "online" | "offline"
    diet_chart_fee_paid: Optional[float] = None
    diet_chart_fee_payment_mode: Optional[str] = None
    diet_chart_fee_payment_details: Optional[dict] = None
    # The chart itself, once the Nutrition Coach has sent one. The bytes are a row in
    # `lead_documents`; this is the pointer to the current chart, so a screen asking
    # "has this patient got their chart" reads one field instead of querying documents.
    #
    # Sent is not the same as visible. The coach may prepare and send a chart before the
    # fee is in — these fields fill either way — and the Client Portal decides what to show
    # by reading diet_chart_fee_paid at the moment it is asked, never by trusting a flag
    # written here. See v3_patient_portal._build_portal_payload.
    diet_chart_document_id: Optional[str] = None
    diet_chart_sent_at: Optional[str] = None
    diet_chart_sent_by: Optional[str] = None
    # What the Nutrition Coach concluded at the Diet Consultation — the diet counterpart
    # of physio_diagnosis_report. One current plan, replaced rather than appended to.
    diet_consultation_report: Optional[str] = None
    diet_consultation_report_at: Optional[str] = None
    diet_consultation_report_by: Optional[str] = None
    diagnosis: Optional[str] = None  # Pre-Sales' basic diagnosis — read-only reference for the Head Physio
    physio_diagnosis_report: Optional[str] = None  # Head Physio's own diagnosis report
    physio_diagnosis_locked: Optional[bool] = False
    treatment_summary: Optional[str] = None  # Head Physio's treatment plan
    treatment_summary_locked: Optional[bool] = False
    consultation_payment_mode: Optional[str] = None  # "cash" | "upi" | "card" | ...
    assigned_physio_id: Optional[str] = None
    assigned_physio_name: Optional[str] = None
    physio_assigned_at: Optional[str] = None
    physio_stage: Optional[str] = None  # None = "Assigned" (active), "Complete" = physio's consultation review finished
    # Stamped onto the lead by _stamp_session_progress, never stored: the days live in
    # the sessions collection and are ticked off one at a time, so a count kept on the
    # lead would be a second copy of the truth, and the stale one is what a board reads.
    #
    # Declared here because this model ignores extras -- so a board returning leads
    # through it dropped both fields on the way out, and the Completed stage, which is
    # read off exactly these two numbers, saw nothing to read. None means no days were
    # ever booked, which is not zero: nobody sold that patient treatment.
    total_sessions: Optional[int] = None
    completed_sessions: Optional[int] = None
    # Stamped the same way and for the same reason, and read alongside them: a course whose
    # days are all done but whose closing Head Physio review is not yet written has not
    # finished. Without it here the flag was dropped on the way out and every board went
    # back to calling those patients Completed on the day count alone. None means nobody
    # asked -- an endpoint that does not stamp it, rather than a review that is not owed.
    review_pending: Optional[bool] = None
    # Every branch this patient has been moved between, oldest first. Declared for the same
    # reason as the two above -- a board that cannot see it cannot mark a transferred
    # patient as one, and the branch receiving them has no way to say where they came from.
    branch_transfer_history: Optional[List[Dict[str, Any]]] = None
    location: Optional[str] = None
    expected_consultation_date: Optional[str] = None
    months_of_pain: Optional[int] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    occupation: Optional[str] = None
    department: Optional[str] = None
    alternative_phone: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    condition: Optional[str] = ""
    assigned_user_id: Optional[str] = None
    assigned_user_name: Optional[str] = None
    rnr_attempts: Optional[int] = 0
    rnr_last_attempt_at: Optional[str] = None
    follow_ups: Optional[List[Dict[str, Any]]] = []
    next_follow_up_at: Optional[str] = None
    consultation_follow_ups: Optional[List[Dict[str, Any]]] = []
    next_consultation_follow_up_at: Optional[str] = None
    appointment_mode: Optional[str] = None  # "offline" | "online"
    appointment_department: Optional[str] = None  # "physio" | "fitness" — chosen when scheduling the appointment
    # Where the booked consultation happens: "branch" (the default, and every booking made
    # before this existed) or "home" — the consultant goes to the patient. Set by the branch's
    # Appointment popup; a "home" booking is worked from the House Visit tab instead of
    # Consultation.
    visit_type: Optional[str] = None
    # The Home Visit > Consultant package a "home" booking was made on, copied off the
    # catalogue when it was booked. Empty for a branch visit.
    visit_package_id: Optional[str] = None
    visit_package_name: Optional[str] = None
    visit_package_price: Optional[float] = None
    visit_package_visits: Optional[int] = None
    appointment_date: Optional[str] = None
    appointment_time: Optional[str] = None
    appointment_datetime: Optional[str] = None
    # The consultation was moved off the slot it was first booked onto.
    #
    # A mark on the patient rather than a stage, for the same reason is_vip and
    # needs_attention are: rescheduling does not move the lead anywhere -- it stays in
    # Appointment, still waiting for the same consultation -- it only says something about
    # how this one has gone. Branch Admin sets it by rebooking; the Consultant and the
    # Head Physio calendar report it read-only, so whoever is about to see the patient
    # knows this slot is not the first one that was arranged.
    #
    # Derived, never sent by a client: schedule-branch-appointment stamps it when the slot
    # actually moves, so re-picking the same time or editing the notes is not a reschedule.
    # `_count` is kept because the third move of one appointment is worth knowing about in
    # a way the first is not, and `_from` names the slot it came off so the log reads.
    appointment_rescheduled: Optional[bool] = False
    appointment_reschedule_count: Optional[int] = 0
    appointment_rescheduled_at: Optional[str] = None
    appointment_rescheduled_from: Optional[str] = None
    portfolio_date: Optional[str] = None
    portfolio_time: Optional[str] = None
    portfolio_datetime: Optional[str] = None
    # Set when the lead is moved to Not a prospect: the reminder call it is parked until.
    not_prospect_at: Optional[str] = None
    not_prospect_by: Optional[str] = None
    not_prospect_reminder_days: Optional[int] = None
    not_prospect_reminder_date: Optional[str] = None  # YYYY-MM-DD, IST
    not_prospect_remarks: Optional[str] = None
    created_at: str
    updated_at: str


class V3DiagnosisInput(BaseModel):
    diagnosis: str


class V3PhysioDiagnosisInput(BaseModel):
    report: str
    locked: bool = False


class V3TreatmentSummaryInput(BaseModel):
    summary: str
    locked: bool = False


class V3SellStoreItemInput(BaseModel):
    item_id: str
    mode: Literal["online", "offline"]
    paid_amount: Optional[float] = None
    payment_mode: str = "cash"
    notes: Optional[str] = ""


class V3PaymentLineInput(BaseModel):
    """One tender in a split payment: a mode and how much arrived that way.

    A patient paying Rs.1200 as Rs.600 cash and Rs.600 UPI is one collection made of
    two of these. Recording it as a single payment means picking a mode that is only
    half true and losing the other half.

    `reference` is whatever identifies that tender -- a UPI transaction id, a UTR, a
    cheque number. One field rather than the four the single-payment path collects for
    a card or a transfer: a split is entered at the desk with the patient waiting, and
    the full bank block per line is more than anyone will type.
    """
    mode: str
    amount: float
    reference: Optional[str] = None
    # Cash only: how many of each note this tender was made of, keyed by the note's value
    # as a string, because that is what survives a JSON round trip. Optional -- a desk
    # that did not count sends nothing, which is not the same as counting nothing.
    denominations: Optional[dict] = None


class V3PartialInstallment(BaseModel):
    """One dated promise in a Partial Payment schedule.

    Defined ahead of the fee inputs rather than beside the Treatment Fee it started on:
    every fee is now collected by the same set of payment modes, so every fee can be put
    on a schedule and every fee input needs to be able to name one of these.
    """
    amount: float
    due_date: str


class V3CollectPackagePaymentInput(BaseModel):
    # Which of the three consultation packages is being sold, chosen at the desk as the
    # fee is collected. The consultation used to have one price and nothing to pick, so
    # the package was assigned silently the moment the consultant filed their decision;
    # with three of them that pick is a decision somebody has to make, and this is where
    # it is made. The server reads the price off the item rather than taking it from the
    # client -- see collect_package_payment.
    #
    # Optional, because a lead that already carries a package (assigned before this
    # existed, or being corrected after the fact) is still collectable without re-picking.
    consultation_item_id: Optional[str] = None
    payment_mode: str = "cash"
    # Set when the fee arrived in more than one tender. Present, it settles both the
    # amount (their sum) and the mode ("split"), and payment_mode above is ignored.
    payment_lines: Optional[List[V3PaymentLineInput]] = None
    # Manual entry — defaults to the assigned package_price if omitted, but Branch
    # Admin can override it (discount, rounding, partial cash collected, etc).
    amount: Optional[float] = None
    # Branch Admin must explicitly tick a confirmation before this is accepted —
    # a deliberate double-check step, not just clicking Collect once.
    confirmed: bool = False
    # Cash — the notes the fee was counted out in, when the desk counted them. Same shape
    # and same optionality as V3PaymentLineInput.denominations above; this is the
    # single-tender path's copy, since a lone cash payment has no lines to hang it on.
    denominations: Optional[dict] = None
    # UPI
    upi_transaction_id: Optional[str] = None
    upi_utr: Optional[str] = None
    # Which of the company's own UPI IDs the money was collected into, picked from the
    # accounts saved in Finance > UPI rather than typed. Optional: it is a fact about
    # where the money landed, not about whether the payment happened, and the payments
    # taken before the picker existed have none.
    upi_id: Optional[str] = None
    # Card -- the transaction id the terminal printed, and nothing else. This used to
    # collect the same four bank fields as an Account Transfer, which no desk can fill in
    # honestly: the swipe hands back one reference and the card itself carries no IFSC.
    card_transaction_id: Optional[str] = None
    # Account Transfer — the account the money moved from. Only the last 4 digits of the
    # account number are ever persisted; the full number is never stored.
    account_number: Optional[str] = None
    account_holder_name: Optional[str] = None
    bank_name: Optional[str] = None
    ifsc_code: Optional[str] = None
    # Cheque — the bank the cheque is drawn on (bank_name, shared with Account
    # Transfer) and its
    # number. A cheque is a promise rather than money on the desk, so the fee keeps its
    # listed price: there is no amount to override and no discount to negotiate against
    # a payment that has not happened yet.
    cheque_number: Optional[str] = None
    # Account Transfer — reuses the four bank fields above (same last-4 rule) and adds
    # the bank's own reference for the transfer, which is what a dispute is traced by.
    transfer_reference: Optional[str] = None
    # Partial Payment — the schedule the fee is spread over, each installment with its
    # own amount and due date, together adding up to the whole fee. Two at least, and no
    # ceiling: some patients want it in two, others in six.
    #
    # Here rather than only on the Treatment Fee, which is where it began. A branch takes
    # its money one way, and a patient who can pay a Rs.8000 treatment package across
    # three dates can as reasonably ask the same of a Rs.4000 rehab course — so every fee
    # is collected by the same set of modes, and a schedule is one of them.
    partial_installments: Optional[List[V3PartialInstallment]] = None
    # A discount is typed here or it does not exist, and an `amount` below what is then
    # payable is a part payment, not a write-off. Both were the same number before: the
    # gap between the price and the amount was booked as a discount, so a desk taking
    # Rs.750 of a Rs.1000 fee cancelled the Rs.250 the patient was coming back with.
    # Whatever is short of the fee is scheduled as an unpaid balance instead, which is
    # what balance_due_date dates -- required whenever there is one.
    #
    # Inherited by the Diet, Diet Chart and Rehab fees, which are collected the same way.
    discount_amount: Optional[float] = None
    balance_due_date: Optional[str] = None


class V3CollectDietFeeInput(V3CollectPackagePaymentInput):
    """The Diet Consultation Fee.

    Inherits every payment field from the Consultation Fee — it is collected the same way,
    in one go, by the same six modes — and adds only what is particular to diet: which
    Diet Package from FITSIO STORE, and whether it was sold at the online or offline price.
    The Head Physio never picks a diet package the way they pick a treatment one, so it is
    chosen here at the point of collection.
    """
    item_id: str
    mode: Literal["online", "offline"] = "offline"


class V3CollectDietChartFeeInput(V3CollectPackagePaymentInput):
    """The Diet Chart Fee.

    Its own input rather than a `kind` field on V3CollectDietFeeInput, because the two are
    collected against different lead fields and one patient can be sold both. A shared
    endpoint discriminating on a string would be one typo away from a Diet Chart payment
    landing on the Diet Consultation Fee and overwriting it.

    Identical in shape to V3CollectDietFeeInput — the same six payment modes, against an
    item chosen at the point of collection — so it inherits the same payment fields for the
    same reason V3CollectRehabFeeInput does: build_payment_details validates every one of
    them, and a hand-written copy that missed transfer_reference would throw on the first
    Account Transfer.
    """
    item_id: str
    mode: Literal["online", "offline"] = "offline"


class V3CollectRehabFeeInput(V3CollectPackagePaymentInput):
    """The Rehab course fee.

    Inherits every payment field from the Consultation Fee, exactly as the Diet fee does —
    it is collected the same way, by the same six modes — and adds nothing.
    The course itself is locked in by the Consultant's decision the way the Treatment
    package is, so there is nothing to choose here: Branch Admin collects against what is
    already on the lead.

    Inherited rather than restated so build_payment_details can reach every field it
    validates; a hand-written copy that missed transfer_reference would have thrown on
    the first Account Transfer.
    """


class V3CollectTreatmentFeeInput(BaseModel):
    # The Session/Treatment package itself is locked in by the Head Physio's earlier
    # consultation-decision — Branch Admin can't choose or change item_id/mode/
    # sessions_override here. The amount defaults to the locked session_package_price
    # but can be manually overridden for the modes that settle now (discount, rounding, etc);
    # Cheque and Partial Payment keep using the locked amount as before.
    payment_mode: str
    amount: Optional[float] = None
    # House Visit patients only: the fee for one session, typed at collection. The package
    # is priced from it (fee x the package's sessions) before the money is taken, since a
    # house visit's rate is agreed at the door rather than read off the catalogue.
    per_session_fee: Optional[float] = None
    # Branch Admin must explicitly tick a confirmation before money taken at the desk is
    # accepted — a deliberate double-check step, not just clicking Collect once.
    confirmed: bool = False
    # Cash -- the notes this fee was counted out in, when the desk counted them. Same
    # shape, same optionality and the same must-agree rule as the Consultation Fee's copy
    # above: a treatment fee is the larger of the two and the one more often paid in a
    # bundle of notes, so it is the one worth being able to check a drawer against.
    denominations: Optional[dict] = None
    # Set when the fee arrived in more than one tender -- Rs.4000 cash and Rs.4000 UPI
    # is one collection made of two, not a payment under a mode that is only half true.
    # Present, it settles both the amount (their sum) and the recorded mode ("split");
    # payment_mode above then says only which mode the popup happened to open on.
    #
    # A split is money settled today, so its tenders are the settled-now modes. A
    # cheque clears when it clears and Partial Payment is a schedule rather than a
    # payment -- neither is a piece of money on the desk, so neither is a line in one.
    payment_lines: Optional[List[V3PaymentLineInput]] = None
    # UPI
    upi_transaction_id: Optional[str] = None
    upi_utr: Optional[str] = None
    # Which of the company's own UPI IDs the money was collected into, picked from the
    # accounts saved in Finance > UPI rather than typed. Optional: it is a fact about
    # where the money landed, not about whether the payment happened, and the payments
    # taken before the picker existed have none.
    upi_id: Optional[str] = None
    # Card -- the transaction id the terminal printed, and nothing else. This used to
    # collect the same four bank fields as an Account Transfer, which no desk can fill in
    # honestly: the swipe hands back one reference and the card itself carries no IFSC.
    card_transaction_id: Optional[str] = None
    # Account Transfer — the account the money moved from. Only the last 4 digits of the
    # account number are ever persisted; the full number is never stored.
    account_number: Optional[str] = None
    account_holder_name: Optional[str] = None
    # Cheque (bank_name is shared with Account Transfer)
    bank_name: Optional[str] = None
    cheque_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    # Account Transfer — reuses the four bank fields above (same last-4 rule) and adds
    # the bank's own reference for the transfer, which is what a dispute is traced by.
    transfer_reference: Optional[str] = None
    # Partial Payment — an arbitrary-length installment schedule (some clients want 2
    # payments, others want 5 or 6); every installment needs its own amount and due
    # date, and they must sum to the locked-in session_package_price.
    partial_installments: Optional[List[V3PartialInstallment]] = None
    # Cash/UPI/Card/Cheque can ALSO collect for only some of the package's sessions
    # right now (e.g. 5 of 10) rather than the full package — sessions_now defaults
    # to every session when omitted (today's full-collection behavior, unchanged).
    # balance_due_date is required whenever sessions_now is less than the package's
    # total; the remaining sessions are scheduled as a single balance installment.
    sessions_now: Optional[int] = None
    balance_due_date: Optional[str] = None
    # A discount is typed here or it does not exist. It used to be inferred -- whatever
    # the amount fell short of the fee was written off -- which meant a Branch Admin
    # taking Rs.3000 of a Rs.5000 fee today erased the Rs.2000 the patient still owed.
    # Those are two different facts: only what arrives in this field comes off the bill,
    # and anything else short of it is scheduled as a balance installment instead.
    discount_amount: Optional[float] = None


class V3MarkInstallmentPaidInput(BaseModel):
    # Optional for backward compatibility: a caller that sends no body (or omits
    # payment_mode) gets the old behavior — just flip `paid` to true, no payment
    # metadata, no activity log entry. Sending payment_mode is how the Partial
    # Payment schedule's own per-row Collect button records a real payment (mode,
    # UTR/cheque number, and an activity-log entry so it surfaces in Session
    # Collections / Accountant Manage), same as every other Treatment Fee mode.
    payment_mode: Optional[Literal["cash", "upi", "card", "cheque", "account_transfer"]] = None
    amount: Optional[float] = None
    # Which fee's schedule the installment belongs to. Any of the five can leave a
    # balance behind -- each on its own payment_details, all in the same shape -- and
    # each is collected through here. Defaults to the Treatment Fee, which was the only
    # one that could have a schedule when this endpoint was written, so every existing
    # caller keeps working without sending it.
    fee: Literal["treatment", "consultation", "rehab", "diet", "diet_chart"] = "treatment"
    # One installment is collected across the same desk as the fee it belongs to, so it
    # counts its cash the same way -- see V3PaymentLineInput.denominations.
    denominations: Optional[dict] = None
    # One installment can arrive in more than one tender as readily as a whole fee can
    # -- same shape and the same rules as the split on the collection above.
    payment_lines: Optional[List[V3PaymentLineInput]] = None
    # Which of the company's own UPI IDs the money was collected into, picked from the
    # accounts saved in Finance > UPI rather than typed. Optional: it is a fact about
    # where the money landed, not about whether the payment happened, and the payments
    # taken before the picker existed have none.
    upi_id: Optional[str] = None
    upi_transaction_id: Optional[str] = None
    upi_utr: Optional[str] = None
    # Card -- the transaction id the terminal printed, and nothing else. This used to
    # collect the same four bank fields as an Account Transfer, which no desk can fill in
    # honestly: the swipe hands back one reference and the card itself carries no IFSC.
    card_transaction_id: Optional[str] = None
    account_number: Optional[str] = None
    account_holder_name: Optional[str] = None
    bank_name: Optional[str] = None
    ifsc_code: Optional[str] = None
    cheque_number: Optional[str] = None
    transfer_reference: Optional[str] = None


class V3PortalAccountInput(BaseModel):
    # All optional — phone and email default to the lead's own; password defaults to a
    # freshly generated one when omitted ("Generate"), or the Branch Admin can supply
    # their own ("Create").
    phone: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None


class V3PatientPortalLogin(BaseModel):
    # `login` is a phone number or an email, whichever the patient typed. `email` is the
    # field's old name, still read so a browser holding a stale chunk can sign in.
    login: Optional[str] = None
    email: Optional[str] = None
    password: str


class V3PatientPortalSwitch(BaseModel):
    lead_id: str


class V3PatientPortalChangePassword(BaseModel):
    current_password: str
    new_password: str


class V3PatientPortalGoogleLogin(BaseModel):
    # The ID token JWT handed back by Google Identity Services' client-side button —
    # verified server-side against GOOGLE_CLIENT_ID before it's trusted for anything.
    credential: str


class V3TestimonialInput(BaseModel):
    youtube_url: str
    title: Optional[str] = None


class V3ConsultationDecisionInput(BaseModel):
    decision: Literal["consultation_only", "consultation_treatment"]
    # Diet is orthogonal to treatment, not another value of it: a patient can be sent to a
    # Nutrition Coach with or without physio. Kept as its own flag so the choices the
    # Head Physio actually picks from stay independent yes/nos underneath — folding them
    # into one enum would multiply the values, and every existing `== "consultation_
    # treatment"` check in the codebase would silently stop matching half the cases it
    # used to.
    diet_recommended: bool = False
    # WHICH diet thing the patient is going away with. Two flags rather than one enum, and
    # both may be on: a Nutritionist appointment and a chart to take home are two different
    # products on two different shelves, and a patient can leave with both.
    #
    # Names only at this stage. Each has a shelf waiting for it — a Diet Consultation is
    # the timed, bookable `diet` store item and a Diet Chart the flat-priced `diet_package`
    # one — so linking a package to either is a field beside these rather than a rewrite of
    # what was recorded.
    #
    # Neither is sent any more. A Diet referral means one thing here — the Nutritionist's
    # consultation — so hp_consultation_decision derives diet_consultation from
    # diet_recommended rather than asking a question with one answer.
    #
    # diet_chart is deliberately not accepted at all. Whether this patient needs a chart is
    # decided AT that consultation, by the Nutritionist who did it, and posted from their
    # own board — see recommend_diet_chart in routers/v3_diet.py. Taken here it was being
    # answered before the patient had been seen, and the branch could collect a Chart Fee
    # for a chart nobody had yet said was needed.
    # Sends the patient straight to the Head Physio's Rehab queue instead of picking a
    # Treatment Package here. Its own flag for the same reason diet is: it is a routing
    # choice, not another value of `decision`, and folding it in would break every
    # existing `== "consultation_only"` check.
    rehab_referred: bool = False
    # Same idea as rehab_referred, its own routing flag rather than a value of `decision`.
    fitness_recommended: bool = False
    # And again for Zumba, which the branch sells alongside the clinical verticals.
    zumba_recommended: bool = False
    # Required only when decision == "consultation_treatment" — the Treatment/Session
    # package (FITSIO STORE > Sessions) the Head Physio is choosing on the patient's behalf.
    item_id: Optional[str] = None
    mode: Literal["online", "offline"] = "offline"
    sessions_override: Optional[int] = None
    # The Rehab course, when one is picked alongside rehab_referred. Optional on purpose:
    # referring to Rehab without settling the course is the flow that existed before this
    # field, and the receipt still says "Waiting on a package in Rehab" for it.
    rehab_item_id: Optional[str] = None
    # The Zumba membership, when one is picked alongside it. Optional on the same terms.
    zumba_item_id: Optional[str] = None
    # The services marked Long Term, and what was written about each. Only Rehab and
    # Fitness can be: those are the two that run on past the package being sold, and the
    # others are bought, delivered and finished.
    #
    # The key is the mark and the value is the note, so a service marked with nothing
    # written yet arrives as an empty string and stays marked. A service that is not
    # marked is simply not here.
    long_term_notes: Dict[Literal["rehab", "fitness"], str] = {}
    # Rehab to follow the Treatment course rather than run beside it -- see
    # V3LeadOut.rehab_after_treatment. Sent instead of rehab_referred, with no package.
    rehab_after_treatment: bool = False


class V3AssignPhysioSessionsInput(BaseModel):
    physio_id: str
    # Exactly `session_package_sessions` slot_time strings, picked from the physio's own
    # already-configured calendar (Consultations > Physio Calendar) — booking all of the
    # patient's paid sessions in the same step the physio is assigned.
    slot_times: List[str]


class V3AssignBranchInput(BaseModel):
    branch_id: str


class V3BookAppointmentInput(BaseModel):
    doctor_id: str
    slot_time: str


class V3AppointmentOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    # A consultation booked straight from the Calendar tab can be a walk-in with no lead
    # behind it, and older rows predate created_by_role — neither is worth 500ing the
    # whole appointments list over, so both are optional here.
    lead_id: Optional[str] = None
    lead_name: str
    branch_id: str
    doctor_id: str
    doctor_name: str
    slot_time: str
    status: str
    created_by_role: Optional[str] = None
    created_at: str


class V3TeamMemberCreate(BaseModel):
    full_name: str
    email: str
    team_type: Literal["pre_sales", "sales"]


class V3TeamMemberOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    full_name: str
    email: str
    team_type: str
    created_at: str


class V3SheetConnectionCreate(BaseModel):
    connection_name: str
    spreadsheet_id: str
    sync_interval_minutes: int = 30


class V3SheetMappingInput(BaseModel):
    field_map: Dict[str, str]
    create_new_fields: bool = True


class V3SheetTabRows(BaseModel):
    tab_name: str
    rows: List[Dict[str, str]]


class V3SheetSyncInput(BaseModel):
    tabs: List[V3SheetTabRows]


class V3RemarkCreate(BaseModel):
    text: str


class V3FollowUpCreate(BaseModel):
    note: str
    scheduled_date: str


class V3MoveStageInput(BaseModel):
    stage: str


class V3BranchStageInput(BaseModel):
    branch_stage: str
    # Only read on a move to Not a prospect: when to call the patient back, in days from
    # today (15, 20, 30 or 90), and an optional note on why they were written off.
    reminder_days: Optional[int] = None
    reminder_remarks: Optional[str] = None


class V3PortfolioScheduleInput(BaseModel):
    portfolio_date: str  # YYYY-MM-DD
    portfolio_time: str  # HH:MM (24h)


class V3ConsultationStageInput(BaseModel):
    consultation_stage: str


class V3HeadConsultationStageInput(BaseModel):
    head_consultation_stage: str


class V3CollectFeeInput(BaseModel):
    fee_type: Literal["consultation", "package"]
    amount: float
    package_weeks: Optional[int] = None


class V3AssignPhysioInput(BaseModel):
    physio_id: str


class V3SlotDetail(BaseModel):
    slot_time: str
    duration: int = 30
    consultation_type: str = "initial"


class V3CalendarSlotsInput(BaseModel):
    slots: List[V3SlotDetail]


class V3RemoveSlotsInput(BaseModel):
    slot_times: List[str]



class V3PackageRecommendInput(BaseModel):
    lead_id: str
    recommended_weeks: int
    sessions_per_week: int
    notes: Optional[str] = ""


class V3AssignSessionsInput(BaseModel):
    lead_id: str
    physio_id: str
    slot_times: List[str]


class V3CompleteSessionInput(BaseModel):
    # A treatment day is written up as treatment notes, rehab notes, or both. Neither is
    # required on its own -- the endpoint rejects only the pair being empty, so a physio
    # with nothing to say about one of them is not made to type into it.
    remarks: Optional[str] = ""
    rehab_remarks: Optional[str] = ""
    # Which of the clinic's physiotherapy treatments were given on the day, by name from
    # the Super Admin catalogue (Services and Products > Physiotherapy Treatment).
    #
    # A list because a session is rarely one modality -- IFT and ultrasound and manual
    # therapy in the same hour is an ordinary day, and one field would make recording that
    # a matter of how the physio punctuated it.
    #
    # Names and not ids, matching how a doctor's service_type is stored: what a day was
    # treated with is read far more often than it is joined back to a catalogue row.
    #
    # Unlike a doctor's service_type, a rename in the catalogue does NOT write through to
    # days already signed off -- v3_update_physio_type touches doctors and nothing else,
    # and deliberately so. A completed day is a clinical record of what was done on it, and
    # correcting a spelling in Services and Products is not licence to edit it, which is
    # the same line the Treatment catalogue draws over a written Treatment Summary. It
    # follows that a treatment deleted from the catalogue still reads back on the days it
    # was given on; it just stops being offered on the next one.
    #
    # Optional. A day is a real day whether or not the physio tagged it, and every session
    # completed before this field existed carries none.
    physio_treatments: Optional[List[str]] = None


class V3AbsentSessionInput(BaseModel):
    # Optional: a physio marking a no-show in the moment should not be held up for a
    # sentence about it, and the date and who marked it are recorded either way.
    remarks: Optional[str] = ""


class V3JrPhysioWeeklyInput(BaseModel):
    jr_physio_notes: str


class V3HeadPhysioReviewInput(BaseModel):
    head_physio_notes: str
    head_physio_suggestions: str


class V3CreateJrPhysioInput(BaseModel):
    full_name: str
    email: str
    password: str
    specialization: Optional[str] = ""
