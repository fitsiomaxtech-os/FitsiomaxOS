import axios from "axios";
import { loadSession, clearSession } from "@/lib/session";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

const api = axios.create({
  baseURL: `${BACKEND_URL}/api/v3`,
});

api.interceptors.request.use((config) => {
  const token = loadSession()?.token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// FastAPI answers a schema-level rejection (422) with `detail` as a list of error
// objects, not the string every other refusal sends. Two hundred-odd call sites read
// `err.response.data.detail` and hand it straight to a toast, and a toast handed an
// object throws "Objects are not valid as a React child" -- the app dies on the one
// error that was trying to explain itself. Flattened to a sentence here, once, so
// every caller keeps reading a string no matter which kind of refusal came back.
const detailToText = (detail) => {
  if (Array.isArray(detail)) {
    const lines = detail.map((d) => {
      if (typeof d === "string") return d;
      // `loc` is the path to the offending field, e.g. ["body", "partial_installments",
      // 0, "amount"]. The field name is what the desk can act on; "body" is not.
      const field = Array.isArray(d?.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
      const msg = d?.msg || "Invalid value";
      return field ? `${field}: ${msg}` : msg;
    });
    return lines.join("; ") || "The server rejected this request";
  }
  if (detail && typeof detail === "object") return detail.msg || JSON.stringify(detail);
  return detail;
};

// Auto-logout on stale/invalid JWT so we don't show a runtime error overlay
let _redirecting = false;
api.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status;
    if (error?.response?.data && typeof error.response.data === "object") {
      const flat = detailToText(error.response.data.detail);
      if (flat !== error.response.data.detail) error.response.data.detail = flat;
    }
    const url = error?.config?.url || "";
    // A 401 from these does not mean the session went stale — it means a secret typed
    // into the form was wrong. The two 2FA endpoints under /auth/login are reached with
    // no session at all, and every 401 from /me/security is about the field, not the
    // token: a mistyped current password, a mistyped code. Without this, getting either
    // one wrong by a character would clear the session and reload the page out from under
    // somebody who is signed in perfectly well.
    const isAuthCall =
      url.includes("/auth/login") || url.includes("/auth/logout") || url.includes("/me/security");
    if (status === 401 && !isAuthCall && !_redirecting) {
      _redirecting = true;
      clearSession();
      try { window.dispatchEvent(new Event("auth:expired")); } catch (e) { /* noop */ }
      setTimeout(() => { _redirecting = false; window.location.reload(); }, 100);
    }
    return Promise.reject(error);
  },
);

export const apiLogin = async (email, password) => {
  const { data } = await api.post("/auth/login", { email, password });
  return data;
};

export const apiMe = async () => (await api.get("/auth/me")).data;

// Sign-in, second half. An account with two-factor on gets no token from /auth/login —
// it gets `{ two_factor_required: true, challenge_id, email_masked }`, and the token only
// exists once the emailed code comes back through here. See backend/routers/v3_auth.py.
export const apiVerifyLogin2fa = async (challengeId, code) =>
  (await api.post("/auth/login/verify-2fa", { challenge_id: challengeId, code })).data;
export const apiResendLogin2fa = async (challengeId) =>
  (await api.post("/auth/login/resend-2fa", { challenge_id: challengeId })).data;

export const apiLogout = async () => {
  const { data } = await api.post("/auth/logout");
  return data;
};

export const forgotPassword = async (identifier) => (await api.post("/auth/forgot-password", { identifier })).data;
export const verifyResetOtp = async (payload) => (await api.post("/auth/verify-reset-otp", payload)).data;
export const validateResetToken = async (token) => (await api.get("/auth/reset-password/validate", { params: { token } })).data;
export const resetPassword = async (payload) => (await api.post("/auth/reset-password", payload)).data;

export const getRoleSelectionMock = async () => {
  return {
    leads_preview: [
      {
        id: "lead_01",
        name: "Priya",
        phone: "9000000001",
        source_tab: "Instagram",
        stage: "New Lead",
      },
      {
        id: "lead_02",
        name: "Arun",
        phone: "9000000002",
        source_tab: "Meta",
        stage: "Pre-sales Qualified",
      },
    ],
  };
};

export const getVerticals = async () => (await api.get("/verticals")).data;
export const createVertical = async (payload) => (await api.post("/verticals", payload)).data;
export const deleteVertical = async (id) => (await api.delete(`/verticals/${id}`)).data;

// Treatment catalogue — Super Admin > Treatment.
export const getTreatmentTypes = async () => (await api.get("/treatment-types")).data;
export const createTreatmentType = async (payload) => (await api.post("/treatment-types", payload)).data;
export const updateTreatmentType = async (id, payload) => (await api.patch(`/treatment-types/${id}`, payload)).data;
export const deleteTreatmentType = async (id) => (await api.delete(`/treatment-types/${id}`)).data;

// Type of Physios — the physiotherapy services offered, Super Admin > Services and
// Products. A name each, like treatments; prices live on the store packages.
export const getPhysioTypes = async () => (await api.get("/physio-types")).data;
export const createPhysioType = async (payload) => (await api.post("/physio-types", payload)).data;
export const updatePhysioType = async (id, payload) => (await api.patch(`/physio-types/${id}`, payload)).data;
export const deletePhysioType = async (id) => (await api.delete(`/physio-types/${id}`)).data;
// Which service an expert is offered under, set where their calendar is published.
export const setDoctorService = async (doctorId, serviceType) => (await api.patch(`/doctors/${doctorId}/service`, { service_type: serviceType })).data;
// The video room an expert takes appointments in. Saved against the person rather than
// the record, so one link covers every branch they cover — see v3_set_doctor_meet_link.
export const setDoctorMeetLink = async (doctorId, meetLink) => (await api.patch(`/doctors/${doctorId}/meet-link`, { meet_link: meetLink || "" })).data;

export const getBranches = async () => (await api.get("/branches")).data;
export const createBranch = async (payload) => (await api.post("/branches", payload)).data;
export const updateBranch = async (branchId, payload) => (await api.put(`/branches/${branchId}`, payload)).data;
export const deleteBranch = async (branchId) => (await api.delete(`/branches/${branchId}`)).data;

export const getDoctors = async (params) => (await api.get("/doctors", { params })).data;
// Who a branch's calendar publishes days for: the MANAGEMENT → MANAGER → TEAM roster for
// that desk, with an expert record made for anybody on it who has none. Separate from
// getDoctors because that one answers six other screens' questions too.
export const getCalendarExperts = async (branchId, profileType) => (await api.get(`/branches/${branchId}/calendar-experts`, { params: { profile_type: profileType } })).data;
export const createDoctor = async (payload) => (await api.post("/doctors", payload)).data;
export const deleteDoctor = async (doctorId) => (await api.delete(`/doctors/${doctorId}`)).data;
export const addDoctorSlots = async (doctorId, payload) => (await api.post(`/doctors/${doctorId}/slots`, payload)).data;
export const getAvailableDoctors = async (params) => (await api.get("/doctors/available", { params })).data;

export const getLeads = async (params) => (await api.get("/leads", { params })).data;
export const createManualLead = async (payload) => (await api.post("/leads/manual", payload)).data;
export const updateLead = async (leadId, payload) => (await api.put(`/leads/${leadId}`, payload)).data;
export const deleteLead = async (leadId) => (await api.delete(`/leads/${leadId}`)).data;
// Deleting from Branch Leads. Returns what was deleted and what was refused, with reasons.
// `purge` drops the server's refusal of anyone carrying treatment sessions or collected
// payments and takes the patient with all of it — the row's own bin icon; the select-many
// bar leaves it false so a real patient among an import survives being swept up.
export const bulkDeleteLeads = async (leadIds, confirm, purge = false) => (await api.post("/branch/leads/bulk-delete", { lead_ids: leadIds, confirm, purge })).data;
// Same permanent, no-guard delete as deleteLead() above, for several patients at once —
// no refusal for paid-for history, unlike bulkDeleteLeads. Super Admin only.
export const bulkHardDeleteLeads = async (leadIds, confirm) => (await api.post("/leads/bulk-hard-delete", { lead_ids: leadIds, confirm })).data;
export const getPortalAccountStatus = async (leadId) => (await api.get(`/leads/${leadId}/portal-account`)).data;
export const createOrResetPortalAccount = async (leadId, payload) => (await api.post(`/leads/${leadId}/portal-account`, payload)).data;
export const getClientPortalPreview = async (leadId) => (await api.get(`/leads/${leadId}/portal-preview`)).data;
// Client Portal controls. The settings read says what this caller may change
// (can_edit_clinic, branch_modes_allowed), so the screen offers only that.
export const getPortalSettings = async (branchId) => (await api.get("/portal-settings", { params: { branch_id: branchId } })).data;
export const savePortalClinicSettings = async (payload) => (await api.put("/portal-settings/clinic", payload)).data;
export const savePortalBranchMode = async (branchId, mode) => (await api.put(`/portal-settings/branch/${branchId}`, { mode })).data;
export const approvePortalPending = async (pendingId) => (await api.post(`/portal-pending/${pendingId}/approve`)).data;
export const dismissPortalPending = async (pendingId) => (await api.post(`/portal-pending/${pendingId}/dismiss`)).data;
export const emailPortalLogin = async (leadId) => (await api.post(`/leads/${leadId}/portal-account/email`)).data;
export const setPortalBlocked = async (leadId, blocked) => (await api.post(`/leads/${leadId}/portal-account/block`, { blocked })).data;
export const setPortalAutoSkip = async (leadId, skip) => (await api.put(`/leads/${leadId}/portal-auto`, { skip })).data;

export const listTestimonials = async () => (await api.get("/testimonials/manage")).data;
export const addTestimonial = async (payload) => (await api.post("/testimonials", payload)).data;
export const deleteTestimonial = async (id) => (await api.delete(`/testimonials/${id}`)).data;
// The two marks a branch puts on a patient by hand — VIP, and needs attention. Its own
// endpoint rather than updateLead: this is a one-click toggle from a row, and the full PUT
// would send every other field back with it. Pass only the flag that changed.
export const setLeadFlags = async (leadId, flags) => (await api.patch(`/leads/${leadId}/flags`, flags)).data;
export const rnrAttempt = async (leadId) => (await api.post(`/leads/${leadId}/rnr-attempt`)).data;
export const scheduleFollowUp = async (leadId, payload) => (await api.post(`/leads/${leadId}/follow-up`, payload)).data;
export const rescheduleFollowUp = async (leadId, followupId, payload) => (await api.post(`/leads/${leadId}/follow-up/${followupId}/reschedule`, payload)).data;
export const scheduleAppointment = async (leadId, payload) => (await api.post(`/leads/${leadId}/schedule-appointment`, payload)).data;
export const leadActivity = async (leadId) => (await api.get(`/leads/${leadId}/activity`)).data;
export const qualifyLead = async (leadId) => (await api.post(`/leads/${leadId}/qualify`)).data;
export const assignLeadBranch = async (leadId, payload) => (await api.post(`/leads/${leadId}/assign-branch`, payload)).data;
export const confirmLead = async (leadId) => (await api.post(`/leads/${leadId}/confirm`)).data;
export const bookLeadAppointment = async (leadId, payload) => (await api.post(`/leads/${leadId}/book-appointment`, payload)).data;

export const getAppointments = async (params) => (await api.get("/appointments", { params })).data;
export const completeAppointment = async (appointmentId) => (await api.post(`/appointments/${appointmentId}/complete`)).data;

export const createSheetConnection = async (payload) => (await api.post("/sheets/connections", payload)).data;
export const getSheetConnections = async () => (await api.get("/sheets/connections")).data;
export const saveSheetMapping = async (connectionId, payload) =>
  (await api.post(`/sheets/connections/${connectionId}/mapping`, payload)).data;
export const syncSheetConnection = async (connectionId, payload) =>
  (await api.post(`/sheets/connections/${connectionId}/sync`, payload)).data;

export const getMasterBoard = async () => (await api.get("/boards/master")).data;
export const getBranchMasterBoard = async () => (await api.get("/boards/branch-master")).data;
export const getMasterControl = async (params = {}) => (await api.get("/boards/master-control", { params })).data;
export const getDashboardOverview = async (params = {}) => (await api.get("/dashboard/overview", { params })).data;
export const getLeadsAnalytics = async (params = {}) => (await api.get("/dashboard/leads-analytics", { params })).data;
export const getDashboardBranchBreakdown = async (params = {}) => (await api.get("/dashboard/branch-breakdown", { params })).data;
export const getDashboardLeadsTrend = async (months = 6) => (await api.get("/dashboard/leads-trend", { params: { months } })).data;
export const getDashboardLeadMetrics = async (params = {}) => (await api.get("/dashboard/lead-metrics", { params })).data;
export const getDashboardLeadMetricDetail = async (params = {}) => (await api.get("/dashboard/lead-metric-detail", { params })).data;
export const getBranchBoardOld = async (branchId) => (await api.get(`/boards/branch/${branchId}`)).data;

export const getTeamMembers = async (params) => (await api.get("/team-members", { params })).data;
export const addTeamMember = async (payload) => (await api.post("/team-members", payload)).data;

export const getBdSummary = async (params = {}) => (await api.get("/dashboard/bd-summary", { params })).data;
// The rows behind one Business Development summary card. `metric` names the card that was
// opened; the response carries `kind` ("lead" | "appointment" | "branch" | "connection")
// so the caller knows which column set to draw, plus the unclipped `total` behind a
// capped `rows`. Same collections and filters as getBdSummary, so the count on a card and
// the length of this list cannot disagree.
export const getBdSummaryRows = async (metric, params = {}) => (
  await api.get("/dashboard/bd-summary/rows", { params: { ...params, metric } })
).data;
export const getLeadSources = async () => (await api.get("/lead-sources")).data;
// Every lead source in a window as table rows -- leads, booked, conversion rate, and when
// each last carried anything -- grouped by source, by branch, or by the pairing. NOT the
// `by_source` on getLeadsAnalytics: that one is capped at six plus an "Other" bucket
// because it draws a pie, and this is a table that has to name every sheet.
export const getMarketingSources = async (params = {}) => (
  await api.get("/dashboard/marketing-sources", { params })
).data;

export const getLeadRemarks = async (leadId) => (await api.get(`/leads/${leadId}/remarks`)).data;
export const addLeadRemark = async (leadId, payload) => (await api.post(`/leads/${leadId}/remarks`, payload)).data;
export const getLeadFollowUps = async (leadId) => (await api.get(`/leads/${leadId}/follow-ups`)).data;
export const addLeadFollowUp = async (leadId, payload) => (await api.post(`/leads/${leadId}/follow-ups`, payload)).data;
export const completeLeadFollowUp = async (leadId, followupId) => (await api.post(`/leads/${leadId}/follow-ups/${followupId}/complete`)).data;
export const getLeadActivity = async (leadId) => (await api.get(`/leads/${leadId}/activity`)).data;
export const moveLeadStage = async (leadId, payload) => (await api.post(`/leads/${leadId}/move-stage`, payload)).data;
export const bookAppointment = async (leadId, payload) => (await api.post(`/leads/${leadId}/book-appointment`, payload)).data;

export const getBranchBoard = async (branchId) => (await api.get(`/branch-board/${branchId}`)).data;
// The same board for an admin who runs an online arm instead of a branch. Takes no
// argument on purpose: the arm is read off the caller's own role server-side, so there is
// nothing here for one arm's admin to point at the other's patients.
export const getArmBoard = async () => (await api.get("/arm-board")).data;
export const moveBranchStage = async (leadId, payload) => (await api.post(`/leads/${leadId}/branch-stage`, payload)).data;
export const schedulePortfolio = async (leadId, payload) => (await api.post(`/leads/${leadId}/schedule-portfolio`, payload)).data;
export const scheduleBranchFollowUp = async (leadId, payload) => (await api.post(`/leads/${leadId}/branch-follow-up`, payload)).data;
export const rescheduleBranchFollowUp = async (leadId, followupId, payload) => (await api.post(`/leads/${leadId}/branch-follow-up/${followupId}/reschedule`, payload)).data;
export const collectFee = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-fee`, payload)).data;
export const assignPhysio = async (leadId, payload) => (await api.post(`/leads/${leadId}/assign-physio`, payload)).data;
export const scheduleBranchAppointment = async (leadId, payload) => (await api.post(`/leads/${leadId}/schedule-branch-appointment`, payload)).data;
// The patient's own confirmation page. Server-rendered HTML rather than an SPA route:
// chat apps fetch a shared link with a crawler that doesn't run JavaScript, and only
// real HTML gets them to draw the preview card above the message.
export const publicAppointmentUrl = (token) => `${BACKEND_URL}/api/v3/public/appointment/${token}`;
// The same confirmation the booking raised, read back off the record so it can be handed
// over again. 404s when the patient has no live consultation booked — the caller says so
// rather than opening an empty card.
export const getLeadAppointmentCard = async (leadId) => (await api.get(`/leads/${leadId}/appointment-card`)).data;
// `mine` narrows the board to the consultations booked to the caller — what My
// Consultation needs and what Operations, reading a whole branch, must not send.
export const getConsultationsBoard = async (branchId, pipeline, mine) => (await api.get(`/branch-admin/consultations/${branchId}/board`, { params: { ...(pipeline ? { pipeline } : {}), ...(mine ? { mine: true } : {}) } })).data;
// Consultation Appointment Scheduling (Branch Admin > Calendar > Schedule)
export const listConsultAppointments = async (branchId) => (await api.get(`/branch-admin/${branchId}/consult-appointments`)).data;
export const getConsultAvailability = async (branchId, date, doctorId) => (await api.get(`/branch-admin/${branchId}/consult-availability`, { params: { date, doctor_id: doctorId } })).data;
export const getConsultDay = async (branchId, date) => (await api.get(`/branch-admin/${branchId}/consult-day`, { params: { date } })).data;
// One consultant's day, slot by slot, with the patients in each and their VIP / attention marks.
export const getConsultantSlots = async (branchId, doctorId, date) => (await api.get(`/branch-admin/${branchId || "all"}/consultant-slots`, { params: { doctor_id: doctorId, date } })).data;
export const createConsultAppointment = async (branchId, payload) => (await api.post(`/branch-admin/${branchId}/consult-appointments`, payload)).data;
export const updateConsultAppointment = async (apptId, payload) => (await api.patch(`/branch-admin/consult-appointments/${apptId}`, payload)).data;
export const cancelConsultAppointment = async (apptId) => (await api.post(`/branch-admin/consult-appointments/${apptId}/cancel`)).data;
export const getAvailableExperts = async (branchId, date, time, leadId, reviewId) => (await api.get(`/branch-admin/available-experts/${branchId}`, { params: { date, ...(time ? { time } : {}), ...(leadId ? { lead_id: leadId } : {}), ...(reviewId ? { review_id: reviewId } : {}) } })).data;
export const getAvailableDates = async (branchId, month, leadId, reviewId) => (await api.get(`/branch-admin/available-dates/${branchId}`, { params: { month, ...(leadId ? { lead_id: leadId } : {}), ...(reviewId ? { review_id: reviewId } : {}) } })).data;
// The other patients at this branch holding a consultation, for the Reschedule dialog's
// SWAP tab. `leadId` is the one being swapped out of, and is left out of the answer.
export const getSwapCandidates = async (branchId, leadId) => (await api.get(`/branch-admin/swap-candidates/${branchId}`, { params: { lead_id: leadId } })).data;
// Two patients change places. Only the pair is sent — where each lands is read off their
// live appointments server-side, so this can never name a slot that was not already
// published and booked. Neither of them comes out of it without an appointment.
export const swapBranchAppointment = async (leadId, withLeadId) => (await api.post(`/leads/${leadId}/swap-branch-appointment`, { with_lead_id: withLeadId })).data;

// ---- Post-treatment Review: Physio raises -> Branch Admin sends -> Head Physio writes it
export const physioReviews = async (physioId) => (await api.get("/physio/reviews", { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioRaiseReview = async (leadId, payload, physioId) => (await api.post(`/physio/reviews/raise/${leadId}`, payload, { params: physioId ? { physio_id: physioId } : {} })).data;
export const branchReviews = async (branchId, status) => (await api.get(`/branch-admin/reviews/${branchId}`, { params: status ? { status } : {} })).data;
export const branchSendReview = async (reviewId, payload) => (await api.post(`/branch-admin/reviews/${reviewId}/send`, payload)).data;
// branchId only from a supervisor board (Operations > Consultant, Branch Control) — it
// asks for that branch's whole Consultant queue. A Consultant's own board sends none
// and gets the reviews dispatched to them.
export const hpReviews = async (branchId) => (await api.get("/head-physio/reviews", { params: branchId ? { branch_id: branchId } : {} })).data;
export const hpLeadWeekReviews = async (leadId) => (await api.get(`/head-physio/reviews/lead/${leadId}/weeks`)).data;
export const hpCompleteReview =async (reviewId, payload) => (await api.post(`/head-physio/reviews/${reviewId}/complete`, payload)).data;
export const getCalendarAvailability = async (branchId, month) => (await api.get(`/branch-admin/calendar-availability/${branchId}`, { params: { month } })).data;
export const getDaySlots = async (branchId, date) => (await api.get(`/branch-admin/day-slots/${branchId}`, { params: { date } })).data;
export const getExpertCalendar = async (expertId, month) => (await api.get(`/branch-admin/expert-calendar/${expertId}`, { params: { month } })).data;
export const listPackages = async (params = {}) => (await api.get("/packages", { params })).data;
export const createPackage = async (payload) => (await api.post("/packages", payload)).data;
export const updatePackage = async (id, payload) => (await api.put(`/packages/${id}`, payload)).data;
export const deletePackage = async (id) => (await api.delete(`/packages/${id}`)).data;
export const sellPackage = async (leadId, payload) => (await api.post(`/leads/${leadId}/sell-package`, payload)).data;
export const moveConsultationStage = async (leadId, consultation_stage) => (await api.post(`/leads/${leadId}/move-consultation-stage`, { consultation_stage })).data;
export const moveHeadConsultationStage = async (leadId, head_consultation_stage) => (await api.post(`/leads/${leadId}/move-head-consultation-stage`, { head_consultation_stage })).data;
export const scheduleConsultationFollowUp = async (leadId, payload) => (await api.post(`/leads/${leadId}/consultation-follow-up`, payload)).data;
export const rescheduleConsultationFollowUp = async (leadId, followupId, payload) => (await api.post(`/leads/${leadId}/consultation-follow-up/${followupId}/reschedule`, payload)).data;

export const getDoctorCalendar = async (doctorId) => (await api.get(`/doctors/${doctorId}/calendar`)).data;
export const setDoctorSlotCapacity = async (doctorId, slotCapacity) => (await api.patch(`/doctors/${doctorId}/slot-capacity`, { slot_capacity: slotCapacity })).data;

// ---- Shifts (MANAGEMENT → TIME MANAGEMENT) ----
// The working windows a branch runs, and who is on each. An expert's shift is what their
// CONSULTANT / PHYSIO / DIET calendar is cut across, so an evening physio's day is offered
// 3 PM – 7 PM rather than the whole clock. The four standard shifts seed themselves on the
// first read; every one of them is editable.
export const listShifts = async (branchId) => (await api.get(`/branches/${branchId}/shifts`)).data;
export const createShift = async (branchId, payload) => (await api.post(`/branches/${branchId}/shifts`, payload)).data;
export const updateShift = async (shiftId, payload) => (await api.patch(`/shifts/${shiftId}`, payload)).data;
export const deleteShift = async (shiftId) => (await api.delete(`/shifts/${shiftId}`)).data;
export const getShiftRoster = async (branchId, profileType) => (await api.get(`/branches/${branchId}/shift-roster`, { params: { profile_type: profileType } })).data;
// One expert, one or several shifts. Several because a split day is ordinary here — the
// consultant who takes 8 AM – 1 PM and is back 5 PM – 9 PM works two windows, and rostering
// them on one 8-to-9 shift would publish every afternoon hour nobody is there for. Takes a
// single id or an array; an empty one puts them back on the full working day.
export const setDoctorShift = async (doctorId, shiftIds) => {
  const ids = (Array.isArray(shiftIds) ? shiftIds : [shiftIds]).filter(Boolean);
  return (await api.patch(`/doctors/${doctorId}/shift`, { shift_ids: ids, shift_id: ids[0] || null })).data;
};
// The branch's WORKING DAY — its hours, its grace before Late, and which days it is closed.
// A different thing from the shifts above and easy to confuse: a shift is when patients may
// be booked with an expert, this is when staff are expected in, and it is what HR's
// attendance register reads to decide whether somebody was late, half a day, or absent.
// See backend/attendance_rules.py.
export const getAttendanceRules = async (branchId) => (await api.get(`/branches/${branchId}/attendance-rules`)).data;
export const saveAttendanceRules = async (branchId, payload) => (await api.put(`/branches/${branchId}/attendance-rules`, payload)).data;
// A one-off: these particular days run on a different shift, without moving the expert off
// their usual one. Takes a single id or an array — "this Saturday she works both halves" is
// one answer — and an empty one puts the days back on their usual shift.
export const setDoctorDayShift = async (doctorId, dates, shiftIds) => {
  const ids = (Array.isArray(shiftIds) ? shiftIds : [shiftIds]).filter(Boolean);
  return (await api.patch(`/doctors/${doctorId}/day-shift`, { dates, shift_ids: ids, shift_id: ids[0] || null })).data;
};

// ---- Diet Consultation (Nutrition Coach) ----
export const dietToday = async (params = {}) => (await api.get("/diet/today", { params })).data;
export const dietCalendar = async (month, year, coachId) => (await api.get("/diet/calendar", { params: { month, year, coach_id: coachId } })).data;
export const dietConsultations = async (coachId) => (await api.get("/diet/consultations", { params: { coach_id: coachId } })).data;
export const dietPatients = async (coachId) => (await api.get("/diet/patients", { params: { coach_id: coachId } })).data;
export const dietSessions = async (leadId) => (await api.get(`/diet/sessions/${leadId}`)).data;
export const dietCompleteDay = async (sessionId, payload) => (await api.post(`/diet/sessions/${sessionId}/complete`, payload)).data;
export const listNutritionCoaches = async () => (await api.get("/branch/nutrition-coaches")).data;
export const createNutritionCoach = async (payload) => (await api.post("/branch/nutrition-coaches", payload)).data;
export const assignDiet = async (payload) => (await api.post("/branch/assign-diet", payload)).data;
export const bookDietAppointment = async (payload) => (await api.post("/branch/diet-appointment", payload)).data;
export const collectDietFee = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-diet-fee`, payload)).data;
// The Diet Chart's own fee. Its own call rather than a flag on the one above, because the
// two land on different fields and a patient can be sold both — see the backend's
// collect_diet_chart_fee.
export const collectDietChartFee = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-diet-chart-fee`, payload)).data;
export const collectRehabFee = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-rehab-fee`, payload)).data;
export const saveDietConsultationReport = async (leadId, report) => (await api.post(`/diet/consultation-report/${leadId}`, { report })).data;

// ---- The Diet Chart ----
/** The Nutrition Coach says this patient needs a chart. The step between the two halves of
 *  the diet vertical: the Consultant refers for the consultation, and whether a chart is
 *  owed is decided at it, by the coach who did it. Nothing else opens the Diet Chart Fee to
 *  the branch. Returns the chart's status, the same shape the panel already reads. */
export const recommendDietChart = async (leadId) => (await api.post(`/diet/chart/${leadId}/recommend`)).data;
/** The Nutrition Coach sends a chart. Multipart, and deliberately without an explicit
 *  Content-Type: the browser has to set it itself so the multipart boundary matches the
 *  body it just built. Naming it by hand is how an upload arrives as an unparseable form. */
export const sendDietChart = async (leadId, file, label) => {
  const form = new FormData();
  form.append("file", file);
  if (label) form.append("label", label);
  return (await api.post(`/diet/chart/${leadId}`, form)).data;
};
/** The chart's bytes as an object URL, for staff. Fetched as a blob rather than linked to,
 *  because the route needs the session token in a header and a plain <a href> cannot send
 *  one. The caller owns the URL and must revokeObjectURL it when done. */
export const dietChartUrl = async (leadId) => {
  const { data } = await api.get(`/diet/chart/${leadId}/download`, { responseType: "blob" });
  return URL.createObjectURL(data);
};
export const setDocumentShared = async (leadId, docId, shared) => (await api.patch(`/leads/${leadId}/documents/${docId}/share`, null, { params: { shared } })).data;
export const branchDietPatients = async () => (await api.get("/branch/diet-patients")).data;

// ---- Reusable report wording (Head Physio's Diagnosis Report / Treatment Summary) ----
// Org-wide, so one list holds across branches. A preset only ever fills the box; what is
// saved against a patient is whatever was actually written for them.
export const listTextPresets = async (kind) => (await api.get("/text-presets", { params: kind ? { kind } : {} })).data;
export const addTextPreset = async (kind, text) => (await api.post("/text-presets", { kind, text })).data;
export const deleteTextPreset = async (presetId) => (await api.delete(`/text-presets/${presetId}`)).data;

// ---- Client documents ----
// Never served from the static /uploads mount — these are patient records, so the bytes
// come back through an authenticated route as a blob.
export const leadDocuments = async (leadId, kind) => (await api.get(`/leads/${leadId}/documents`, { params: kind ? { kind } : {} })).data;
export const uploadLeadDocument = async (leadId, file, label = "", kind = "general") => {
  const body = new FormData();
  body.append("file", file);
  body.append("label", label);
  body.append("kind", kind);
  // No explicit Content-Type: the browser has to set the multipart boundary itself, and
  // naming the header strips it and the request arrives unparseable.
  return (await api.post(`/leads/${leadId}/documents`, body)).data;
};
// Progression — the four things a case sheet cannot close without, and the check on them.
// Verifying is deliberately a different endpoint from uploading: the physio gathers the
// clips, the branch or the consultant confirms them.
export const leadProgression = async (leadId) => (await api.get(`/leads/${leadId}/progression`)).data;
export const verifyLeadDocument = async (leadId, docId, verified = true) => (await api.patch(`/leads/${leadId}/documents/${docId}/verify`, { verified })).data;
// The Google review is typed, not filed — a picture of a review cannot be followed back
// to the review. Saving it clears any previous verification, since the tick belonged to the
// words that were there when it was made.
export const setGoogleReview = async (leadId, text) => (await api.put(`/leads/${leadId}/google-review`, { text })).data;
export const verifyGoogleReview = async (leadId, verified = true) => (await api.patch(`/leads/${leadId}/google-review/verify`, { verified })).data;
export const closeCaseSheet = async (leadId) => (await api.post(`/leads/${leadId}/close-case-sheet`)).data;
export const deleteLeadDocument = async (leadId, docId) => (await api.delete(`/leads/${leadId}/documents/${docId}`)).data;
export const openLeadDocument = async (leadId, docId) => {
  const res = await api.get(`/leads/${leadId}/documents/${docId}/download`, { responseType: "blob" });
  return URL.createObjectURL(res.data);
};
export const addCalendarSlots = async (doctorId, payload, branchId) => (await api.post(`/doctors/${doctorId}/calendar-slots`, payload, { params: branchId ? { branch_id: branchId } : {} })).data;
// MANAGEMENT → CALENDAR → MONTHLY CALENDAR: which days a branch works and which it is on leave.
export const getBranchMonthCalendar = async (branchId, month) => (await api.get(`/branches/${branchId}/month-calendar`, { params: { month } })).data;
export const setBranchDayStatus = async (branchId, dates, status, note) => (await api.put(`/branches/${branchId}/month-calendar`, { dates, status, note })).data;
export const removeCalendarSlots = async (doctorId, payload) => (await api.post(`/doctors/${doctorId}/remove-slots`, payload)).data;

export const getBranchFinance = async (params = {}) => {
  const query = new URLSearchParams();
  if (params.fee_type) query.set("fee_type", params.fee_type);
  if (params.start_date) query.set("start_date", params.start_date);
  if (params.end_date) query.set("end_date", params.end_date);
  if (params.search) query.set("search", params.search);
  if (params.branch_id) query.set("branch_id", params.branch_id);
  if (params.mode) query.set("mode", params.mode);
  if (params.approved !== undefined && params.approved !== null) query.set("approved", params.approved);
  return (await api.get(`/branch/finance?${query.toString()}`)).data;
};

// ---- Finance: Approvals / Expenses / Profit (Accountant) ----
export const getFinanceApprovals = async (params = {}) => (await api.get("/finance/approvals", { params })).data;
// Behind the Developer Access delete switch; reverses the payment at its source.
export const deleteTransaction = async (id) => (await api.delete(`/finance/transactions/${id}`)).data;
// payload: { confirmed_amount } for Cash, { transaction_ref } for Bank Transfer/UPI,
// { cheque_number } for Cheque — whichever the row's own payment mode calls for.
export const approveTransaction = async (activityId, payload = {}) => (await api.post(`/finance/transactions/${activityId}/approve`, payload)).data;
export const unapproveTransaction = async (activityId) => (await api.post(`/finance/transactions/${activityId}/unapprove`)).data;
// Signing off a whole selection at once. Carries no confirmed amount, reference or
// cheque number -- there is no way to ask for those two hundred times -- so these rows
// are approved with who and when and nothing to check against. Weaker than the popup
// above on purpose; the caller is expected to say so before using it.
export const bulkApproveTransactions = async (activityIds) => (await api.post("/finance/transactions/bulk-approve", { activity_ids: activityIds })).data;
export const getFinanceExpenses = async (params = {}) => (await api.get("/finance/expenses", { params })).data;
export const createFinanceExpense = async (payload) => (await api.post("/finance/expenses", payload)).data;
export const deleteFinanceExpense = async (expenseId) => (await api.delete(`/finance/expenses/${expenseId}`)).data;
// Signing off a branch's expense, or turning it down with the reason. Neither is open to
// the Branch Admin who raised it — approval is somebody else saying the money went where
// the form says it went, the same rule the payment approvals run on.
export const approveFinanceExpense = async (expenseId) => (await api.post(`/finance/expenses/${expenseId}/approve`)).data;
export const rejectFinanceExpense = async (expenseId, reason) => (await api.post(`/finance/expenses/${expenseId}/reject`, { reason })).data;
export const getFinanceProfit = async (params = {}) => (await api.get("/finance/profit", { params })).data;

// The day-end count: what the desk actually holds, against what the system says it took.
// The GET answers with the day asked for *and* the one before it, because a closing
// balance only means something beside the previous night's — see get_closing_balance.
export const getClosingBalance = async (params = {}) => (await api.get("/finance/closing-balance", { params })).data;
export const saveClosingBalance = async (payload) => (await api.post("/finance/closing-balance", payload)).data;
// The counts already recorded across a window — a week, a month, or two typed dates.
// Only the evenings actually counted come back, so a caller walking the days of the range
// can tell a night that balanced from one nobody counted; `opening` is the last count
// before the window, which is the night its first day's cash opens on.
export const getClosingBalanceHistory = async (params = {}) => (await api.get("/finance/closing-balance/history", { params })).data;

// Signing a day off, and taking a signature back. A closed book is a snapshot — what was
// counted, what was expected and whether they matched, frozen at the moment somebody put
// their name to it — and it locks that day's count until an accountant reopens it. The
// server decides whether the money matched; a caller that sent its own verdict could sign
// off a short day as balanced. Reopening is not open to the Branch Admin who closed it,
// and takes the reason, which is kept on the book.
export const closeBook = async (payload) => (await api.post("/finance/closing-balance/close-book", payload)).data;
export const reopenBook = async (payload) => (await api.post("/finance/closing-balance/reopen-book", payload)).data;

// The petty cash tin. `balance` is every movement ever made on it — what is physically in
// it today — while the movements listed are only the window asked for. A top-up moves
// notes from the drawer into the tin and spends nothing, which is why it is not an expense.
// Sending a day's collections up to the accountant, and taking them back before they are
// signed off. Both take a list: a branch closes a day rather than a payment, and forty
// single requests is forty chances to send thirty-nine.
export const requestTransactions = async (activityIds) => (await api.post("/finance/transactions/request", { activity_ids: activityIds })).data;
export const unrequestTransactions = async (activityIds) => (await api.post("/finance/transactions/unrequest", { activity_ids: activityIds })).data;

export const getPettyCash = async (params = {}) => (await api.get("/finance/petty-cash", { params })).data;
export const topUpPettyCash = async (payload) => (await api.post("/finance/petty-cash/topup", payload)).data;

// Branch Cash — one running box per branch: what it collected in cash, spent, handed over,
// and what should be in the drawer now. `branch_id` omitted gives the accountant/Super
// Admin the roll-up across every branch. The box only means anything once the accountant
// has set its opening figure (opening_set); before that the derived balance is every rupee
// of cash ever taken and the panel prompts for the count instead.
export const getBranchCash = async (params = {}) => (await api.get("/finance/branch-cash", { params })).data;
export const getBranchCashEntries = async (params = {}) => (await api.get("/finance/branch-cash/entries", { params })).data;
export const setBranchCashAdjustment = async (payload) => (await api.post("/finance/branch-cash/adjustment", payload)).data;
export const createCashHandover = async (payload) => (await api.post("/finance/cash-handover", payload)).data;
export const listCashHandovers = async (params = {}) => (await api.get("/finance/cash-handovers", { params })).data;
export const receiveCashHandover = async (id, payload = {}) => (await api.post(`/finance/cash-handover/${id}/receive`, payload)).data;
export const cancelCashHandover = async (id) => (await api.post(`/finance/cash-handover/${id}/cancel`)).data;
// Cash coming back into a branch's drawer -- a float from head office, a handover brought
// back, an advance returned. Adds to Cash in hand the moment it is recorded.
export const createCashReturn = async (payload) => (await api.post("/finance/cash-return", payload)).data;
export const listCashReturns = async (params = {}) => (await api.get("/finance/cash-returns", { params })).data;
export const cancelCashReturn = async (id) => (await api.post(`/finance/cash-return/${id}/cancel`)).data;

// Finance > UPI: the bank accounts the group collects into, and the QR each one is
// scanned by. The image goes up on its own, ahead of Save, so the popup can show it
// before anything is committed.
export const listBankAccounts = async (params = {}) => (await api.get("/finance/bank-accounts", { params })).data;
// The same accounts read as a picker at a counter: every branch's active UPI ID, not just
// the caller's own branch's, since a desk can be told to take a payment into any of the
// group's accounts. Open to every desk that collects a fee, and it hands back only what a
// counter needs — the UPI ID, the bank, and whose branch it is.
export const listUpiCollectOptions = async () => (await api.get("/finance/bank-accounts/upi-options")).data;
export const createBankAccount = async (payload) => (await api.post("/finance/bank-accounts", payload)).data;
export const updateBankAccount = async (id, payload) => (await api.put(`/finance/bank-accounts/${id}`, payload)).data;
export const setBankAccountStatus = async (id, isActive) => (await api.post(`/finance/bank-accounts/${id}/status`, { is_active: isActive })).data;
export const deleteBankAccount = async (id) => (await api.delete(`/finance/bank-accounts/${id}`)).data;
export const uploadBankQrImage = async (file) => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post("/finance/bank-accounts/upload-qr", form);
  return data;
};

export const getRevenueOverview = async (params = {}) => (await api.get("/finance/revenue-overview", { params })).data;

export const getClientTransactionHistory = async (leadId) => (await api.get(`/finance/client/${leadId}`)).data;
export const markInstallmentPaid = async (leadId, installmentNumber, payload) => (await api.post(`/finance/installment/${leadId}/${installmentNumber}/mark-paid`, payload)).data;

// Whose consultant book the board will show, and whether it belongs to the caller. My
// Consultation reads it so it can never present somebody else's appointments as your own.
export const hpResolvedConsultant = async () => (await api.get("/head-physio/resolved")).data;
// The Super Admin's branch-wise On/Off: which branches' Consultant Calendars and booking
// pickers offer them. Both answer the full list, so the switches redraw from the server.
export const getMyConsultBranches = async () => (await api.get("/head-physio/my-branches")).data;
export const setMyConsultBranch = async (branchId, on) => (await api.put(`/head-physio/my-branches/${branchId}`, { on })).data;
// Who can be handed a consultation at this branch. Not available-experts: that one takes a
// date and hides anyone with no open slot on it, which is the question for a NEW booking.
// A reassignment keeps the slot the patient already holds.
export const listBranchConsultants = async (branchId) => (await api.get(`/consultations/${branchId}/consultants`)).data;
// Move patients onto another consultant, keeping their slot. Empty consultantId means "to me".
export const reassignConsultant = async (leadIds, consultantId, reason) => (await api.post("/consultations/reassign-consultant", { lead_ids: leadIds, ...(consultantId ? { consultant_id: consultantId } : {}), ...(reason ? { reason } : {}) })).data;
export const getHPMyCalendar = async (branchId) => (await api.get("/head-physio/my-calendar", { params: branchId ? { branch_id: branchId } : {} })).data;
export const getHPMyPatients = async (branchId) => (await api.get("/head-physio/my-patients", { params: branchId ? { branch_id: branchId } : {} })).data;
export const hpRecommendPackage = async (payload) => (await api.post("/head-physio/recommend-package", payload)).data;
export const hpGetSessions = async (leadId) => (await api.get(`/head-physio/sessions/${leadId}`)).data;
export const hpGetAssessments = async (leadId) => (await api.get(`/head-physio/weekly-assessments/${leadId}`)).data;
export const hpWeeklyReview = async (leadId, week, payload) => (await api.post(`/head-physio/weekly-review/${leadId}/${week}`, payload)).data;

export const physioConsultations = async (physioId) => (await api.get("/physio/consultations", { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioCompleteConsultation = async (leadId, physioId) => (await api.post(`/physio/leads/${leadId}/complete-consultation`, null, { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioToday = async (physioId) => (await api.get("/physio/today", { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioCalendar = async (month, year, physioId) => (await api.get("/physio/calendar", { params: { month, year, ...(physioId ? { physio_id: physioId } : {}) } })).data;
export const physioPatients = async (physioId) => (await api.get("/physio/patients", { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioPatientDetail = async (leadId, physioId) => (await api.get(`/physio/patient/${leadId}`, { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioSessions = async (leadId, physioId) => (await api.get(`/physio/sessions/${leadId}`, { params: physioId ? { physio_id: physioId } : {} })).data;
export const physioCompleteSession = async (sessionId, payload) => (await api.post(`/physio/sessions/${sessionId}/complete`, payload)).data;
// The patient did not turn up: this day takes the next day's slot, and every day after it
// steps down one. The last day comes off the end and goes to the Branch Admin for a date.
export const physioMarkAbsent = async (sessionId, payload) => (await api.post(`/physio/sessions/${sessionId}/absent`, payload)).data;

export const physioWeeklyAssessment = async (leadId, week, payload, physioId) => (await api.post(`/physio/weekly-assessment/${leadId}/${week}`, payload, { params: physioId ? { physio_id: physioId } : {} })).data;

export const getBranchRecommendations = async () => (await api.get("/branch/package-recommendations")).data;
export const assignSessions = async (payload) => (await api.post("/branch/assign-sessions", payload)).data;
export const createJrPhysio = async (payload) => (await api.post("/branch/jr-physios", payload)).data;
// Treatment days an absence pushed off the end of the booked slots, and the booking that puts one back.
export const unscheduledSessions = async () => (await api.get("/branch/sessions/unscheduled")).data;
export const scheduleSession = async (sessionId, slotTime) => (await api.post(`/branch/sessions/${sessionId}/schedule`, { slot_time: slotTime })).data;
// Acting on one booking straight off an expert's calendar, whichever course it came from
// (`course` is the tag the calendar's own `occupants` carry). Reschedule moves it to
// another published hour and refuses unless the desk has confirmed the new time with the
// patient; decline takes it off the hour it holds and always wants a reason.
export const rescheduleCalendarBooking = async (course, bookingId, payload) => (await api.post(`/branch/calendar-bookings/${course}/${bookingId}/reschedule`, payload)).data;
export const declineCalendarBooking = async (course, bookingId, reason) => (await api.post(`/branch/calendar-bookings/${course}/${bookingId}/decline`, { reason })).data;
// A physio who will not be in on a date. Marked by the physio for themselves or by the
// Branch Admin for any physio at the branch; each patient booked that day is then handed
// to another physio (patient_confirmed required) or released to wait for a new date.
export const listPhysioAbsences = async (params) => (await api.get("/physio-absences", { params })).data;
export const markPhysioAbsent = async (payload) => (await api.post("/physio-absences", payload)).data;
export const physioAbsenceDetail = async (absenceId) => (await api.get(`/physio-absences/${absenceId}`)).data;
export const cancelPhysioAbsence = async (absenceId) => (await api.delete(`/physio-absences/${absenceId}`)).data;
export const reassignAbsenceDay = async (absenceId, track, dayId, payload) => (await api.post(`/physio-absences/${absenceId}/days/${track}/${dayId}/reassign`, payload)).data;
export const releaseAbsenceDay = async (absenceId, track, dayId, reason) => (await api.post(`/physio-absences/${absenceId}/days/${track}/${dayId}/release`, { reason })).data;

export const patientView = async (token) => (await api.get(`/patient/view/${token}`)).data;


// Marketing Module
export const mkDashboard = async () => (await api.get("/marketing/dashboard")).data;
export const mkGetDistribution = async () => (await api.get("/marketing/distribution-settings")).data;
export const mkPatchDistribution = async (payload) => (await api.patch("/marketing/distribution-settings", payload)).data;
export const mkRefreshDistribution = async () => (await api.post("/marketing/distribution-settings/refresh")).data;
export const mkGetTeam = async () => (await api.get("/marketing/team-members")).data;
export const mkTeamMemberLeads = async (memberId, params = {}) => (await api.get(`/marketing/team-members/${memberId}/leads`, { params })).data;
export const mkUnassignedCount = async () => (await api.get("/marketing/unassigned-count")).data;
export const mkDistributeUnassigned = async () => (await api.post("/marketing/distribute-unassigned")).data;
export const mkCreateTeamMember = async (payload) => (await api.post("/marketing/team-members", payload)).data;
export const mkAllLeads = async (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, v); });
  return (await api.get(`/marketing/all-leads?${q.toString()}`)).data;
};
export const mkAssignLead = async (leadId, assignedTo) => (await api.post(`/marketing/assign-lead/${leadId}?assigned_to=${assignedTo}`)).data;
export const mkDeleteLead = async (leadId) => (await api.delete(`/marketing/leads/${leadId}`)).data;
export const mkBulkDelete = async (lead_ids) => (await api.post("/marketing/leads/bulk-delete", { lead_ids })).data;
// What a sheet column can be mapped onto, grouped as the Create Lead form is tabbed —
// Lead Details, Lead Data, and any custom questions. Served rather than listed in the
// popup so the dropdown and the importer cannot drift apart.
export const mkLeadFieldCatalogue = async () => (await api.get("/marketing/lead-field-catalogue")).data;
export const mkGetSources = async () => (await api.get("/marketing/sources")).data;
export const mkCreateSource = async (payload) => (await api.post("/marketing/sources", payload)).data;
export const mkUpdateSource = async (sourceId, payload) => (await api.patch(`/marketing/sources/${sourceId}`, payload)).data;
export const mkDeleteSource = async (sourceId) => (await api.delete(`/marketing/sources/${sourceId}`)).data;
export const mkSyncSource = async (sourceId, rows) => (await api.post(`/marketing/sources/${sourceId}/sync`, { rows })).data;
export const mkPerformance = async () => (await api.get("/marketing/performance")).data;


// Pipeline Stages
//
// Held per type and shared, because every board that draws a stage bar reads this on mount
// and several of them are on screen at once: opening Branch Leads' Consultation tab asked
// for `consultation` twice over -- once from the board that draws the summary cards, once
// from the ConsultationsBoard embedded underneath that counts them. The two raced, and the
// cards are labelled from the first copy and counted from the second, so until the
// duplicate landed the tab showed a row of zeroes over a table that plainly had rows in it.
//
// An in-flight request is joined rather than repeated, so simultaneous callers cost one
// round trip; a settled list is reused for STAGES_TTL_MS, which is long enough to cover a
// tab switch and short enough that a rename made in another window turns up on its own.
// Every write below drops the cache outright, so Pipeline Stage Management -- which reloads
// through here immediately after each save -- never reads back what it has just replaced.
const STAGES_TTL_MS = 60000;
const _stagesCache = new Map(); // type -> { at, data } while settled, { inflight } while not
export const invalidateStages = () => { _stagesCache.clear(); };
// `arm` narrows the Branch ("sales") pipeline to one practice -- the clinic runs an offline
// list and an online one, each edited on its own CI/CD ROOTS tab. It is part of the cache
// key, or the second tab opened would be served the first one's stages.
export const stagesList = async (type, arm) => {
  const key = `${type || ""}|${arm || ""}`;
  const held = _stagesCache.get(key);
  if (held?.inflight) return held.inflight;
  // Copied on the way out. The list is shared by every caller now, and one of them sorting
  // or splicing its own copy would be reordering everybody else's stage bar.
  if (held && Date.now() - held.at < STAGES_TTL_MS) return held.data.slice();
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (arm) params.set("arm", arm);
  const qs = params.toString();
  const inflight = api.get(`/stages${qs ? `?${qs}` : ""}`)
    .then(({ data }) => {
      const rows = Array.isArray(data) ? data : [];
      _stagesCache.set(key, { at: Date.now(), data: rows });
      return rows.slice();
    })
    .catch((err) => {
      // Nothing to hold and nothing to serve a later caller: drop the entry so the next
      // mount asks again rather than joining a promise that has already rejected.
      _stagesCache.delete(key);
      throw err;
    });
  _stagesCache.set(key, { inflight });
  return inflight;
};
export const stagesCreate = async (payload) => { const { data } = await api.post("/stages", payload); invalidateStages(); return data; };
export const stagesUpdate = async (id, payload) => { const { data } = await api.patch(`/stages/${id}`, payload); invalidateStages(); return data; };
export const stagesDelete = async (id) => { const { data } = await api.delete(`/stages/${id}`); invalidateStages(); return data; };
export const stagesReorder = async (items) => { const { data } = await api.post("/stages/reorder", { items }); invalidateStages(); return data; };
// The Danger Zone's developer password, checked by the server on every call. URI-encoded
// because a header can only carry Latin-1; the backend decodes it.
const developerHeaders = (password) => ({ "X-Developer-Password": encodeURIComponent(password || "") });
export const unlockDangerZone = async (password) => (await api.post("/admin/danger-zone/unlock", null, { headers: developerHeaders(password) })).data;
export const resetAllLeads = async (password) => (await api.post("/admin/reset-all-leads", null, { params: { confirm: true }, headers: developerHeaders(password) })).data;
export const resetAllPayments = async (password) => (await api.post("/admin/reset-all-payments", null, { params: { confirm: true }, headers: developerHeaders(password) })).data;
export const getPhysioDayLock = async (password) => (await api.get("/admin/physio-day-lock", { headers: developerHeaders(password) })).data;
export const setPhysioDayLock = async (password, locked) => (await api.put("/admin/physio-day-lock", { locked }, { headers: developerHeaders(password) })).data;
// Whether Branch Leads offers its delete at all. Read back from the branch board as
// `lead_delete_enabled` by everyone else — only the Danger Zone reads and writes it here.
export const getLeadDeleteButton = async (password) => (await api.get("/admin/lead-delete-button", { headers: developerHeaders(password) })).data;
export const setLeadDeleteButton = async (password, enabled) => (await api.put("/admin/lead-delete-button", { enabled }, { headers: developerHeaders(password) })).data;
// Whether the accountant's expense lists offer a Delete bin. Read back by them as
// `delete_enabled` on /finance/expenses — only the Danger Zone reads and writes it here.
export const getExpenseDeleteButton = async (password) => (await api.get("/admin/expense-delete-button", { headers: developerHeaders(password) })).data;
export const setExpenseDeleteButton = async (password, enabled) => (await api.put("/admin/expense-delete-button", { enabled }, { headers: developerHeaders(password) })).data;
// Whether the Super Admin's My Consultation offers its branch-wise On/Off.
export const getSaConsultBranchesSetting = async (password) => (await api.get("/admin/super-admin-consult-branches", { headers: developerHeaders(password) })).data;
export const setSaConsultBranchesSetting = async (password, enabled) => (await api.put("/admin/super-admin-consult-branches", { enabled }, { headers: developerHeaders(password) })).data;
// On: each branch keeps its own Services and Products values. Off: one catalogue for all.
export const getStoreBranchOverrides = async (password) => (await api.get("/admin/store-branch-overrides", { headers: developerHeaders(password) })).data;
export const setStoreBranchOverrides = async (password, enabled) => (await api.put("/admin/store-branch-overrides", { enabled }, { headers: developerHeaders(password) })).data;
export const resetAllUsers = async (password) => (await api.post("/admin/reset-all-users", null, { params: { confirm: true }, headers: developerHeaders(password) })).data;

// HR
export const hrDashboard = async () => (await api.get("/hr/dashboard")).data;
export const hrMeta = async () => (await api.get("/hr/meta")).data;
export const hrAddCustomRole = async (label, color) => (await api.post("/hr/roles", { label, color })).data;
export const hrDeleteCustomRole = async (name) => (await api.delete(`/hr/roles/${name}`)).data;
export const hrDepartments = async () => (await api.get("/hr/departments")).data;
export const hrCreateDepartment = async (name) => (await api.post("/hr/departments", { name })).data;
export const hrRenameDepartment = async (id, name) => (await api.patch(`/hr/departments/${id}`, { name })).data;
export const hrDeleteDepartment = async (id) => (await api.delete(`/hr/departments/${id}`)).data;
export const hrAddDesignation = async (deptId, name) => (await api.post(`/hr/departments/${deptId}/designations`, { name })).data;
export const hrDeleteDesignation = async (deptId, name) => (await api.delete(`/hr/departments/${deptId}/designations`, { params: { name } })).data;
// `merge` folds this designation into one the department already has, rather than the
// rename being refused as a clash. See rename_designation for why it is opt-in.
export const hrRenameDesignation = async (deptId, oldName, newName, merge = false) => (await api.patch(`/hr/departments/${deptId}/designations`, { old_name: oldName, new_name: newName, merge })).data;
export const hrReorderDesignations = async (deptId, designations) => (await api.put(`/hr/departments/${deptId}/designations/order`, { designations })).data;
export const hrEmployees = async (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
  return (await api.get(`/hr/employees${q.toString() ? `?${q.toString()}` : ""}`)).data;
};

// HR — the running month. Attendance, approvals, payroll and the quote board, all served
// by backend/routers/v3_hr_ops.py under the same /hr prefix as the structure endpoints
// above. Split there and grouped here for the same reason: one is the shape of the
// company, the other is what happened this month.
// ---------- the clock in the header ----------
//
// Everyone's own day, pressed by them. No id anywhere in here on purpose: each of these
// answers for whoever the token belongs to, and there is no shape of request that reads
// somebody else's — that is HR's register above.
export const clockToday = async () => (await api.get("/clock/today")).data;
export const clockIn = async () => (await api.post("/clock/in")).data;
export const clockBreakOut = async (reason) => (await api.post("/clock/break-out", { reason })).data;
export const clockBreakIn = async () => (await api.post("/clock/break-in")).data;
export const clockOut = async () => (await api.post("/clock/out")).data;
export const clockHistory = async (month) => (await api.get("/clock/history", { params: month ? { month } : {} })).data;
// EOD Report — asked at Clock Out of Physios and Consultants; read by Super Admin in HR Admin.
export const eodToday = async () => (await api.get("/eod/today")).data;
export const eodSubmit = async (payload) => (await api.post("/eod/today", payload)).data;
// Both ends optional; neither is every report ("All").
export const eodReports = async ({ from, to } = {}) => (await api.get("/eod-reports", { params: { ...(from ? { date_from: from } : {}), ...(to ? { date_to: to } : {}) } })).data;

// ---------- my own page: profile, month, and time off ----------
//
// Same rule as the clock above and for the same reason: no id is accepted by any of them,
// so there is no request shape here that reads another person's record. What HR's
// endpoints answer for everybody, these answer for whoever holds the token -- which is why
// every role may call them.
export const myProfile = async () => (await api.get("/me/profile")).data;
export const myAttendance = async (month) => (await api.get("/me/attendance", { params: month ? { month } : {} })).data;

// The three that write. They post into the very list HR decides on -- see
// backend/routers/v3_me.py -- so a leave raised here and one HR logged are the same
// record, and approving either is the same click on the same board.
// The Security tab. Same rule as the two above — no id is accepted by any of them, so
// nothing here reads or changes another person's login. HR's side of this subject (setting
// somebody else's password, deactivating an account) stays on /hr/users behind HR's roles.
export const mySecurity = async () => (await api.get("/me/security")).data;
export const changeMyPassword = async (payload) => (await api.post("/me/security/password", payload)).data;
// `intent` is "enable" or "disable" — sent rather than inferred from the stored flag, so a
// tab left open since before somebody turned 2FA on cannot turn it off by mistake.
export const startMy2fa = async (intent) => (await api.post("/me/security/2fa/start", { intent })).data;
export const resendMy2fa = async (intent, challengeId) =>
  (await api.post("/me/security/2fa/resend", { intent, challenge_id: challengeId })).data;
export const verifyMy2fa = async (intent, challengeId, code) =>
  (await api.post("/me/security/2fa/verify", { intent, challenge_id: challengeId, code })).data;
export const revokeMyOtherSessions = async () => (await api.post("/me/security/sessions/revoke-others")).data;

export const myRequests = async (year) => (await api.get("/me/requests", { params: year ? { year } : {} })).data;
export const raiseMyRequest = async (payload) => (await api.post("/me/requests", payload)).data;
export const withdrawMyRequest = async (id) => (await api.delete("/me/requests/" + id)).data;

export const hrAttendanceDay = async (date) => (await api.get("/hr/attendance", { params: date ? { date } : {} })).data;
export const hrMarkAttendance = async (date, entries) => (await api.post("/hr/attendance", { date, entries })).data;
export const hrAttendanceMonth = async (month) => (await api.get("/hr/attendance/month", { params: month ? { month } : {} })).data;
// Staff > Performance. period is week | month | quarter; date is any day inside it.
export const hrPerformance = async (period, date) => (await api.get("/hr/performance", { params: { period, ...(date ? { date } : {}) } })).data;
// The attendance board. `params` carries the span being asked for: { period: "day", date }
// for one day, or period range/month/year with from+to, month, or year beside it. The
// server decides the span and sends back what it settled on, so the screen never has to
// work out how long a month is.
export const hrAttendanceOverview = async (params = {}) => (await api.get("/hr/attendance/overview", { params })).data;

export const hrApprovals = async (params = {}) => (await api.get("/hr/approvals", { params })).data;
export const hrCreateApproval = async (payload) => (await api.post("/hr/approvals", payload)).data;
export const hrDecideApproval = async (id, decision, note = "") => (await api.patch(`/hr/approvals/${id}`, { decision, note })).data;
export const hrDeleteApproval = async (id) => (await api.delete(`/hr/approvals/${id}`)).data;

export const hrPayroll = async (month) => (await api.get("/hr/payroll", { params: month ? { month } : {} })).data;
export const hrGeneratePayroll = async (month) => (await api.post("/hr/payroll/generate", { month })).data;
// One employee's salary as a timeline: every figure they have been put on and from when,
// what each month actually paid, and the reasons a record may be filed under. The hike
// and the duration are worked out on the server from the records either side -- see
// _timeline -- so nothing here has to agree with anything separately.
export const hrEmployeeSalary = async (empId) => (await api.get(`/hr/employees/${empId}/salary`)).data;
export const hrAddSalaryRecord = async (empId, payload) => (await api.post(`/hr/employees/${empId}/salary`, payload)).data;
export const hrDeleteSalaryRecord = async (empId, recordId) => (await api.delete(`/hr/employees/${empId}/salary/${recordId}`)).data;
export const hrSalaryReasons = async () => (await api.get("/hr/salary-reasons")).data;
export const hrAddSalaryReason = async (payload) => (await api.post("/hr/salary-reasons", payload)).data;
export const hrAdjustPayslip = async (month, employeeId, payload) => (await api.patch(`/hr/payroll/${month}/slips/${employeeId}`, payload)).data;
export const hrPayrollStatus = async (month, status) => (await api.post(`/hr/payroll/${month}/status`, { status })).data;

export const hrQuotes = async () => (await api.get("/hr/quotes")).data;
export const hrQuoteToday = async () => (await api.get("/hr/quotes/today")).data;
export const hrAddQuote = async (text, author) => (await api.post("/hr/quotes", { text, author })).data;
export const hrUpdateQuote = async (id, payload) => (await api.patch(`/hr/quotes/${id}`, payload)).data;
export const hrDeleteQuote = async (id) => (await api.delete(`/hr/quotes/${id}`)).data;

// Client Reviews — the stars clients give their Consultant and Physio from the portal.
// A Branch Admin is held to their own branch on the server whatever branch_id says.
export const getClientReviews = async (branchId) => (await api.get("/client-reviews", { params: branchId ? { branch_id: branchId } : {} })).data;

// Branch Management
export const bmList = async () => (await api.get("/branch-mgmt")).data;
export const bmListArchived = async () => (await api.get("/branch-mgmt", { params: { archived: true } })).data;
export const bmArchiveBranch = async (branchId, password) => (await api.post(`/branch-mgmt/${branchId}/archive`, { password })).data;
export const bmRestoreBranch = async (branchId) => (await api.post(`/branch-mgmt/${branchId}/restore`)).data;
export const bmCreateWithExistingAdmin = async (payload) => (await api.post("/branch-mgmt/with-existing-admin", payload)).data;
export const bmReassignAdmin = async (branchId, admin_user_id) => (await api.patch(`/branch-mgmt/${branchId}/admin`, { admin_user_id })).data;
export const bmHeadPhysioCandidates = async () => (await api.get("/branch-mgmt/head-physio-candidates")).data;
export const bmAssignHeadPhysio = async (branchId, doctor_id) => (await api.patch(`/branch-mgmt/${branchId}/head-physio`, { doctor_id })).data;
export const bmPerformance = async (branchId) => (await api.get(`/branch-mgmt/${branchId}/performance`)).data;
export const bmPerformanceSummary = async () => (await api.get("/branch-mgmt/performance-summary")).data;
export const bmDetail = async (branchId) => (await api.get(`/branch-mgmt/${branchId}/detail`)).data;
export const bmLeadControlHistory = async (branchId) => (await api.get(`/branches/${branchId}/lead-control-history`)).data;
export const bmPreSalesMembers = async (branchId) => (await api.get(`/branches/${branchId}/pre-sales-members`)).data;
// Who is posted to a branch, desk by desk. A posting, not a role — the account keeps the
// role it holds and only the branch it works at changes.
export const bmTeamCandidates = async (branchId, desk) => (await api.get(`/branch-mgmt/${branchId}/team-candidates`, { params: { desk } })).data;
export const bmTeamAdd = async (branchId, userId, desk) => (await api.post(`/branch-mgmt/${branchId}/team/${userId}`, null, { params: { desk } })).data;
export const bmTeamRemove = async (branchId, userId, desk) => (await api.delete(`/branch-mgmt/${branchId}/team/${userId}`, { params: { desk } })).data;


// Google Sheets OAuth
export const gsStatus = async () => (await api.get("/marketing/google-sheets/status")).data;
export const gsAuthUrl = async () => (await api.get("/marketing/google-sheets/auth")).data;
export const gsDisconnect = async () => (await api.post("/marketing/google-sheets/disconnect", {})).data;
export const gsListSpreadsheets = async (nameContains) => (await api.get(`/marketing/google-sheets/spreadsheets${nameContains ? `?name_contains=${encodeURIComponent(nameContains)}` : ""}`)).data;
export const gsListTabs = async (spreadsheetId) => (await api.get("/marketing/google-sheets/tabs", { params: { spreadsheet_id: spreadsheetId } })).data;
// One tab's column names — its first row, read live. Edit Mapping's left-hand side.
// Not taken from the source's stored headers_detected: that is only written by a sync, so
// a sheet connected but never pulled has none and a sheet that gained a question has stale
// ones, and mapping against either is mapping against columns that are not there.
export const gsSheetHeaders = async (spreadsheetId, tab) => (await api.get("/marketing/google-sheets/headers", { params: { spreadsheet_id: spreadsheetId, tab } })).data;
// Timed, so a pull that never answers cannot leave its button spinning for good.
export const gsPull = async (sourceId) => (await api.post(`/marketing/google-sheets/pull/${sourceId}`, null, { timeout: 180000 })).data;
export const gsAutoSyncSources = async () => (await api.get("/marketing/google-sheets/auto-sync/sources", { timeout: 30000 })).data;
export const gsAutoSyncToggle = async (sourceId, payload) => (await api.patch(`/marketing/google-sheets/auto-sync/sources/${sourceId}`, payload)).data;

export const hrCreateEmployee = async (payload) => (await api.post("/hr/employees", payload)).data;
export const hrUpdateEmployee = async (id, payload) => (await api.patch(`/hr/employees/${id}`, payload)).data;
// The employee's photo, sent before the record that points at it — the file has to exist
// for photo_url to mean anything. Answers with { url }; no explicit Content-Type, because
// the browser has to set the multipart boundary itself.
export const uploadEmployeePhoto = async (file) => {
  const form = new FormData();
  form.append("file", file);
  return (await api.post("/hr/employees/upload-photo", form)).data;
};
export const hrDeleteEmployee = async (id) => (await api.delete(`/hr/employees/${id}`)).data;
export const hrUsers = async (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
  return (await api.get(`/hr/users${q.toString() ? `?${q.toString()}` : ""}`)).data;
};
export const hrCreateUser = async (payload) => (await api.post("/hr/users", payload)).data;
export const hrUpdateUser = async (id, payload) => (await api.patch(`/hr/users/${id}`, payload)).data;
export const hrUpdateUserRole = async (id, role) => (await api.patch(`/hr/users/${id}/role?role=${role}`)).data;
// Email delivery, Super Admin only. Every code this OS sends leaves through one SMTP
// account; these two say what it is set to and prove whether it works. A 403 here means
// the caller is not Super Admin, which is how the panel decides whether to draw itself.
export const hrEmailStatus = async () => (await api.get("/hr/email/status")).data;
export const hrEmailTest = async () => (await api.post("/hr/email/test")).data;

export const hrResetPassword = async (id, password) => (await api.patch(`/hr/users/${id}/reset-password?password=${encodeURIComponent(password)}`)).data;
export const hrDeactivateUser = async (id) => (await api.delete(`/hr/users/${id}`)).data;
export const hrActivateUser = async (id) => (await api.patch(`/hr/users/${id}/activate`)).data;
export const hrDeleteUserPermanent = async (id) => (await api.delete(`/hr/users/${id}/permanent`)).data;

export const requestSuperAdminOtp = async (payload) => (await api.post("/public/super-admin/request-otp", payload)).data;
export const verifySuperAdminOtp = async (payload) => (await api.post("/public/super-admin/verify-otp", payload)).data;

// Custom Lead Fields
export const leadFieldsList = async () => (await api.get("/lead-fields")).data;
export const leadFieldsCreate = async (payload) => (await api.post("/lead-fields", payload)).data;
export const leadFieldsUpdate = async (id, payload) => (await api.patch(`/lead-fields/${id}`, payload)).data;
export const leadFieldsDelete = async (id) => (await api.delete(`/lead-fields/${id}`)).data;

export const hrBranchAdminCandidates = async () => (await api.get("/hr/branch-admin-candidates")).data;

// FITSIO STORE
export const uploadStoreImage = async (file) => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post("/store/upload-image", form);
  return data;
};
export const createStoreItem = async (payload) => (await api.post("/store/items", payload)).data;
// branchId: whose Services and Products to read. A Branch Admin is always read as their own
// branch by the server; Super Admin passes it when driving a branch's board.
export const listStoreItems = async (category, itemType, branchId) => {
  const params = {};
  if (category) params.category = category;
  if (itemType) params.item_type = itemType;
  if (branchId) params.branch_id = branchId;
  return (await api.get("/store/items", { params })).data;
};
/** Every diet product the branch has priced, from both shelves.
 *
 *  Two calls because they are two item types: "diet", the timed bookable item under
 *  Consultations, and "diet_package", the flat-priced one under the Diet Package tab. A
 *  branch may have put its Diet Consultation and its Diet Chart on either, and asking for
 *  only one type is how the Collect Diet Fee button came to tell a branch to add a package
 *  they had already added. Deduplicated by id in case an item is ever returned by both. */
export const listDietStoreItems = async () => {
  const lists = await Promise.all([
    listStoreItems(undefined, "diet").catch(() => []),
    listStoreItems(undefined, "diet_package").catch(() => []),
  ]);
  const byId = new Map();
  for (const item of lists.flat()) if (item?.id) byId.set(item.id, item);
  return [...byId.values()];
};
export const updateStoreItem = async (id, payload, branchId) => (
  await api.put(`/store/items/${id}`, payload, { params: branchId ? { branch_id: branchId } : {} })
).data;
export const deleteStoreItem = async (id) => (await api.delete(`/store/items/${id}`)).data;
export const getStoreHistory = async (limit) => (await api.get("/store/history", { params: limit ? { limit } : {} })).data;
export const getPaymentHistory = async (limit) => (await api.get("/store/payment-history", { params: limit ? { limit } : {} })).data;
export const getFollowUpHistory = async (limit) => (await api.get("/store/follow-up-history", { params: limit ? { limit } : {} })).data;
export const getLoginHistory = async (limit) => (await api.get("/store/login-history", { params: limit ? { limit } : {} })).data;

// FITSIOMAX STORE > Tablet — branch stock. `category` is here so Supplementary and
// Equipment can call the same endpoints once their panels exist; the backend already
// takes them. A Branch Admin's own branch is resolved server-side from their login, so
// branch_id is only ever sent by a Super Admin looking at someone else's shelf.
export const listInventoryItems = async (params = {}) => (await api.get("/inventory/items", { params: { category: "tablet", ...params } })).data;
export const inventorySummary = async (params = {}) => (await api.get("/inventory/summary", { params: { category: "tablet", ...params } })).data;
export const inventoryMovements = async (params = {}) => (await api.get("/inventory/movements", { params: { category: "tablet", ...params } })).data;
// The catalogue is org-wide, so create and delete carry no branch. Everything that moves
// stock does: the backend pins a Branch Admin to their own branch whatever they send, and
// requires a Super Admin — who has none — to name one.
export const createInventoryItem = async (payload) => (await api.post("/inventory/items", payload)).data;
export const updateInventoryItem = async (id, payload, params = {}) => (await api.put(`/inventory/items/${id}`, payload, { params })).data;
export const deleteInventoryItem = async (id) => (await api.delete(`/inventory/items/${id}`)).data;
export const addInventoryStock = async (id, payload, params = {}) => (await api.post(`/inventory/items/${id}/add-stock`, payload, { params })).data;
export const sellInventoryItem = async (id, payload, params = {}) => (await api.post(`/inventory/items/${id}/sell`, payload, { params })).data;
export const transferInventoryItem = async (id, payload, params = {}) => (await api.post(`/inventory/items/${id}/transfer`, payload, { params })).data;

// FITSIOMAX STORE > Vendor — who the stock comes from. The list is org-wide, like the
// item catalogue it links to; branch_id only scopes the delivery totals on each row, and
// a Branch Admin is pinned to their own branch server-side whatever they send.
export const listVendors = async (params = {}) => (await api.get("/vendors", { params })).data;
export const vendorSummary = async (params = {}) => (await api.get("/vendors/summary", { params })).data;
export const vendorDeliveries = async (id, params = {}) => (await api.get(`/vendors/${id}/deliveries`, { params })).data;
// The stock catalogue as a picker — org-wide and countless, so it answers for a Super
// Admin too, who has no branch for /inventory/items to scope to.
export const vendorStock = async (params = {}) => (await api.get("/vendors/stock", { params })).data;
export const createVendorStock = async (rows) => (await api.post("/vendors/stock", rows)).data;
export const updateVendorStock = async (id, payload) => (await api.put(`/vendors/stock/${id}`, payload)).data;
export const deleteVendorStock = async (id) => (await api.delete(`/vendors/stock/${id}`)).data;
export const createVendor = async (payload) => (await api.post("/vendors", payload)).data;
export const updateVendor = async (id, payload, params = {}) => (await api.put(`/vendors/${id}`, payload, { params })).data;
export const deleteVendor = async (id) => (await api.delete(`/vendors/${id}`)).data;


export const saveLeadDiagnosis = async (leadId, diagnosis) => (await api.post(`/leads/${leadId}/diagnosis`, { diagnosis })).data;
export const sellStoreItem = async (leadId, payload) => (await api.post(`/leads/${leadId}/sell-store-item`, payload)).data;
export const collectPackagePayment = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-package-payment`, payload)).data;
export const collectTreatmentFee = async (leadId, payload) => (await api.post(`/leads/${leadId}/collect-treatment-fee`, payload)).data;
// Prices a Treatment Package that has no catalogue price (Home Visit > Physiotherapy Distance):
// the amount for one session, which the server multiplies by the package's sessions.
export const setSessionPackageAmount = async (leadId, perSessionAmount) => (await api.post(`/leads/${leadId}/session-package-amount`, { per_session_amount: perSessionAmount })).data;
export const assignPhysioWithSessions = async (leadId, payload) => (await api.post(`/leads/${leadId}/assign-physio-sessions`, payload)).data;
// Who has delivered this patient's treatment days and how far each of them got — the
// physios the patient has been through, oldest first, then the one they are with now.
export const getLeadPhysioProgress = async (leadId) => (await api.get(`/leads/${leadId}/physio-progress`)).data;
// Branch Transfer (Super Admin). Eligibility is asked first so the dialog can show what
// the move would cost -- days released, money staying behind -- before it is made.
export const getLeadTransferEligibility = async (leadId) => (await api.get(`/leads/${leadId}/transfer-eligibility`)).data;
export const transferLeadBranch = async (leadId, payload) => (await api.post(`/leads/${leadId}/transfer-branch`, payload)).data;
export const getBranchTransferRecords = async (branchId) => (await api.get(`/branch-admin/transfer-records/${branchId}`)).data;
// Rehab — a parallel course on the same physio's calendar. Its own endpoint and its own
// collection: a rehab day is not a day of the treatment package (see backend/v3_rehab).
export const assignRehab = async (payload) => (await api.post("/branch/assign-rehab", payload)).data;
export const rehabSessionsForLead = async (leadId) => (await api.get(`/branch/rehab-sessions/${leadId}`)).data;
export const saveConsultationDecision = async (leadId, payload) => (await api.post(`/leads/${leadId}/consultation-decision`, payload)).data;
// Rehab after Treatment: the branch re-appoints the patient with the Consultant once the
// course is done, and the Consultant chooses the Rehab package at that consultation.
export const bookRehabConsultation = async (leadId, payload) => (await api.post(`/leads/${leadId}/rehab-consultation/book`, payload)).data;
export const completeRehabConsultation = async (leadId, payload) => (await api.post(`/leads/${leadId}/rehab-consultation/complete`, payload)).data;
export const markConsultationCompleted = async (leadId) => (await api.post(`/leads/${leadId}/mark-consultation-completed`)).data;

export const savePhysioDiagnosis = async (leadId, report, locked = false) => (await api.post(`/leads/${leadId}/physio-diagnosis`, { report, locked })).data;
export const unlockPhysioDiagnosis = async (leadId) => (await api.put(`/leads/${leadId}/physio-diagnosis/unlock`)).data;
export const saveTreatmentSummary = async (leadId, summary, locked = false) => (await api.post(`/leads/${leadId}/treatment-summary`, { summary, locked })).data;
export const unlockTreatmentSummary = async (leadId) => (await api.put(`/leads/${leadId}/treatment-summary/unlock`)).data;


// Recruitment — Human Resource Master View. Candidates live in their own collection and
// reference a stage by id, so nothing here passes a stage *name* around.
export const recruitmentBoard = async (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
  return (await api.get(`/recruitment/board${q.toString() ? `?${q.toString()}` : ""}`)).data;
};
export const recruitmentStages = async () => (await api.get("/recruitment/stages")).data;
export const recruitmentCreateCandidate = async (payload) => (await api.post("/recruitment/candidates", payload)).data;
export const recruitmentUpdateCandidate = async (id, payload) => (await api.patch(`/recruitment/candidates/${id}`, payload)).data;
export const recruitmentMoveCandidate = async (id, payload) => (await api.post(`/recruitment/candidates/${id}/move`, payload)).data;
export const recruitmentScheduleInterview = async (id, payload) => (await api.post(`/recruitment/candidates/${id}/interview`, payload)).data;
export const recruitmentRecordOffer = async (id, payload) => (await api.post(`/recruitment/candidates/${id}/offer`, payload)).data;
export const recruitmentAddNote = async (id, note) => (await api.post(`/recruitment/candidates/${id}/notes`, { note })).data;
export const recruitmentDeleteCandidate = async (id) => (await api.delete(`/recruitment/candidates/${id}`)).data;

// Candidate lead sheets — HR's own Google Sheet sources, separate from Marketing's.
export const recruitmentSheetStatus = async () => (await api.get("/recruitment/sheets/status")).data;
export const recruitmentSources = async () => (await api.get("/recruitment/sources")).data;
export const recruitmentCreateSource = async (payload) => (await api.post("/recruitment/sources", payload)).data;
export const recruitmentUpdateSource = async (id, payload) => (await api.patch(`/recruitment/sources/${id}`, payload)).data;
export const recruitmentDeleteSource = async (id) => (await api.delete(`/recruitment/sources/${id}`)).data;
export const recruitmentPullSource = async (id) => (await api.post(`/recruitment/sources/${id}/pull`)).data;
export const recruitmentCreateStage = async (payload) => (await api.post("/recruitment/stages", payload)).data;
export const recruitmentUpdateStage = async (id, payload) => (await api.patch(`/recruitment/stages/${id}`, payload)).data;
export const recruitmentDeleteStage = async (id) => (await api.delete(`/recruitment/stages/${id}`)).data;
export const recruitmentReorderStages = async (ids) => (await api.post("/recruitment/stages/reorder", { ids })).data;

// ---- Patient feedback (the bell on the branch's header) ----
// The bell's number is the New column rather than a flag of its own, so what it counts and
// what the board shows can never disagree.
// The starred and the flagged, both lists in one request so the cards and the rows they
// count cannot arrive a moment apart.
export const getDashboardClients = async (branchId) => (await api.get("/dashboard/clients", { params: branchId ? { branch_id: branchId } : {} })).data;
// Clients whose paid treatment sessions have run out (or have one left) with a Treatment
// Fee balance still owing -- the header's rupee bell. Scoped per role by the backend.
export const getSessionPaymentAlerts = async () => (await api.get("/session-payment-alerts")).data;
// A Branch Admin letting the remaining sessions go ahead unpaid by moving the balance's due
// date, or turning down the client's request for more time.
export const approveSessionPaymentExtension = async (leadId, extendedDueDate, note) =>
  (await api.post(`/session-payment/${leadId}/extension/approve`, { extended_due_date: extendedDueDate, note })).data;
export const rejectSessionPaymentExtension = async (leadId, note) =>
  (await api.post(`/session-payment/${leadId}/extension/reject`, { note })).data;
export const listBranchFeedback = async (branchId) => (await api.get("/branch/feedback", { params: branchId ? { branch_id: branchId } : {} })).data;
export const moveBranchFeedback = async (feedbackId, status, reply, note) => (await api.patch(`/branch/feedback/${feedbackId}`, { status, reply, note })).data;
// Writing back to the patient on their own thread. ask_resolved is how a branch closes one
// — it says what was done and asks whether that settled it; the patient's answer resolves
// it, and nothing on this side can.
export const replyBranchFeedback = async (feedbackId, body, askResolved = false) => (await api.post(`/branch/feedback/${feedbackId}/message`, { body, ask_resolved: askResolved })).data;
// Developer tools for demo and testing tickets, behind the Danger Zone password. Two separate
// calls: resetting never deletes, deleting never resets.
export const devResetFeedbackToNew = async (ids, password) => (await api.post("/branch/feedback/dev/reset-to-new", { ids }, { headers: developerHeaders(password) })).data;
export const devDeleteFeedback = async (ids, password) => (await api.post("/branch/feedback/dev/delete", { ids }, { headers: developerHeaders(password) })).data;
// Chat Delete: the bin on each client in the Patient Feedback list. Switched in Developer
// Access; the board reads it back as `chat_delete_enabled` on the list.
export const getFeedbackChatDelete = async (password) => (await api.get("/branch/feedback/dev/chat-delete", { headers: developerHeaders(password) })).data;
export const setFeedbackChatDelete = async (password, enabled) => (await api.put("/branch/feedback/dev/chat-delete", { enabled }, { headers: developerHeaders(password) })).data;
export const deleteFeedbackChat = async (ids) => (await api.post("/branch/feedback/delete-chat", { ids })).data;

// ---- Zumba (Branch Admin's own tab) ----
// Not a clinical journey and so not a lead: no stage, no consultation, no discharge. The
// summary splits by where the registration came from, which is the question the branch
// actually asks of it.
export const listZumba = async (branchId) => (await api.get("/branch/zumba", { params: branchId ? { branch_id: branchId } : {} })).data;
export const addZumba = async (payload, branchId) => (await api.post("/branch/zumba", payload, { params: branchId ? { branch_id: branchId } : {} })).data;
export const updateZumba = async (registrationId, payload) => (await api.patch(`/branch/zumba/${registrationId}`, payload)).data;
export const deleteZumba = async (registrationId) => (await api.delete(`/branch/zumba/${registrationId}`)).data;

// The Zumba master accounts at a branch, for the Branch Admin's assign control. Separate
// from the `masters` list listZumba returns: that one is names typed onto referrals, this
// one is accounts a student can actually be handed to.
export const listZumbaMasters = async (branchId) => (await api.get("/branch/zumba/masters", { params: branchId ? { branch_id: branchId } : {} })).data;
// Which class a master takes. Empty time_slot stands them down from the one they had.
// Re-files that slot's customers to them server-side, so the setting and the roll cannot
// describe different arrangements — see set_zumba_master_slot.
export const setZumbaMasterSlot = async (masterId, timeSlot) => (await api.patch(`/branch/zumba/masters/${masterId}/slot`, { time_slot: timeSlot || "" })).data;
// Moving somebody along the class pipeline is the daily action, so it is its own call
// rather than a field on the edit form. The stages themselves come back on listZumba,
// straight from what Super Admin has in CI/CD ROOTS.
export const moveZumbaStage = async (registrationId, stage) => (await api.patch(`/branch/zumba/${registrationId}/stage`, { stage })).data;
export const setZumbaStatus = async (registrationId, status, remarks) => (await api.patch(`/branch/zumba/${registrationId}/status`, { status, remarks })).data;

// Another term on an existing membership. The server works out when the new term starts —
// when the old one ends, not when the button was pressed — so nothing here has to.
export const renewZumba = async (registrationId, payload) => (await api.post(`/branch/zumba/${registrationId}/renew`, payload)).data;

// Money against a balance already owed. Adds to what has been collected rather than
// replacing it, and refuses more than is outstanding.
export const collectZumba = async (registrationId, paymentLines) => (await api.post(`/branch/zumba/${registrationId}/collect`, { payment_lines: paymentLines })).data;
export const acceptZumbaReferral = async (leadId) => (await api.post(`/branch/zumba/accept/${leadId}`)).data;

// Fitness (gym) memberships — Branch Admin > Fitness. Its own desk beside Zumba: the gym
// sells memberships that run out and need renewing, with no referral pipeline behind it.
export const listFitness = async (branchId) => (await api.get("/branch/fitness", { params: branchId ? { branch_id: branchId } : {} })).data;
export const addFitness = async (payload, branchId) => (await api.post("/branch/fitness", payload, { params: branchId ? { branch_id: branchId } : {} })).data;
export const updateFitness = async (registrationId, payload) => (await api.patch(`/branch/fitness/${registrationId}`, payload)).data;
export const setFitnessStatus = async (registrationId, status, remarks) => (await api.patch(`/branch/fitness/${registrationId}/status`, { status, remarks })).data;
export const deleteFitness = async (registrationId) => (await api.delete(`/branch/fitness/${registrationId}`)).data;
// A Consultant's Fitness referral, taken onto the branch's own books. The row on the
// tab is the lead until this runs, and there is nothing to sell a membership against
// or collect a fee for until it does.
export const acceptFitnessReferral = async (leadId) => (await api.post(`/branch/fitness/accept/${leadId}`)).data;
// A collection is a list of lines, one per mode — a member can hand over cash and send
// the rest by UPI, and both halves belong against the same membership.
export const collectFitnessPayment = async (registrationId, lines, note) => (await api.post(`/branch/fitness/${registrationId}/collect`, { lines, note })).data;

// Another term on an existing membership. The server works out when the new term starts —
// when the old one ends, not when the button was pressed — so nothing here has to.
export const renewFitness = async (registrationId, payload) => (await api.post(`/branch/fitness/${registrationId}/renew`, payload)).data;

// Past Data — the clinic's Excel sheets from before the OS (the register, the branches'
// revenue sheets), read-only, managed by Super Admin from Settings > Import/Export.
// Add sheet: preview reads the workbook and writes nothing; import sends the same file again
// with the sha256 preview returned, so the server knows it is the file whose report was just
// read. Each import is one sheet on the branch — replaceId puts it in place of one already there.
const pastDataForm = (branchId, file, extra = {}) => {
  const form = new FormData();
  form.append("branch_id", branchId);
  Object.entries(extra).forEach(([k, v]) => form.append(k, String(v)));
  form.append("file", file);
  return form;
};
export const previewPastDataImport = async (branchId, file) => (await api.post("/past-data/import/preview", pastDataForm(branchId, file))).data;
export const importPastData = async (branchId, file, sha256, { label = "", replaceId = "" } = {}) => (
  await api.post("/past-data/import", pastDataForm(branchId, file, { sha256, label, replace_id: replaceId }))
).data;
// Disconnect one sheet: deletes its rows. The branch's other sheets are not touched.
export const disconnectPastDataSheet = async (sheetId) => (await api.delete(`/past-data/imports/${sheetId}`)).data;
// Move to live: one sheet's clients put on this branch's Branch Leads as live leads, to try
// them out there -- and taken back off again. The GET says what it would do and writes nothing.
// A thousand clients each get a patient number, so the move is given longer than a click.
export const previewPastDataMove = async (sheetId) => (await api.get(`/past-data/imports/${sheetId}/move`)).data;
export const movePastDataToLive = async (sheetId) => (await api.post(`/past-data/imports/${sheetId}/move`, null, { timeout: 180000 })).data;
export const takeBackPastDataMove = async (sheetId) => (await api.delete(`/past-data/imports/${sheetId}/move`, { timeout: 180000 })).data;
// Settings > Import/Export: every sheet on every branch, archived ones too, and a sheet's
// branch switched -- or disconnected, with a null branch.
export const getPastDataSheets = async () => (await api.get("/past-data/sheets")).data;
export const setPastDataSheetBranch = async (sheetId, branchId) => (
  await api.post(`/past-data/imports/${sheetId}/branch`, { branch_id: branchId || null })
).data;
// An archived (already disconnected) sheet taken off the list for good.
export const deletePastDataArchived = async (sheetId) => (await api.delete(`/past-data/archived/${sheetId}`)).data;
