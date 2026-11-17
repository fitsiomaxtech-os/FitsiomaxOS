import axios from "axios";
import { trackLoading } from "@/lib/loadingBar";

// Deliberately separate from lib/api.js's `api` instance: that one auto-attaches the
// STAFF session token and, on any 401, clears the staff session and reloads the page.
// A patient's own session expiring must never touch a logged-in staff member's session
// in another tab, so this client carries its own token and has no such interceptor.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const PORTAL_SESSION_KEY = "fitsiomax_patient_portal_session";

const portalApi = axios.create({ baseURL: `${BACKEND_URL}/api/v3` });
// The patient's pages get the same bottom loading bar as the staff ones.
trackLoading(portalApi);

export const loadPortalSession = () => {
  try {
    const raw = localStorage.getItem(PORTAL_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const savePortalSession = (data) => {
  localStorage.setItem(PORTAL_SESSION_KEY, JSON.stringify(data));
};

export const clearPortalSession = () => {
  localStorage.removeItem(PORTAL_SESSION_KEY);
};

const authHeaders = () => {
  const token = loadPortalSession()?.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** `login` is whatever the patient typed: a phone number in any format, or an email. */
export const patientPortalLogin = async (login, password) => {
  const { data } = await portalApi.post("/patient-portal/login", { login, password });
  return data;
};

/** Every patient this sign-in may look at — more than one when a family shares a login. */
export const patientPortalPatients = async () => {
  const { data } = await portalApi.get("/patient-portal/patients", { headers: authHeaders() });
  return data;
};

/** Point the session at another patient on the same login. Every other call then answers
    for that patient; the server refuses anyone the sign-in did not open. */
export const patientPortalSwitch = async (leadId) => {
  const { data } = await portalApi.post("/patient-portal/switch", { lead_id: leadId }, { headers: authHeaders() });
  return data;
};

export const patientPortalGoogleLogin = async (credential) => {
  const { data } = await portalApi.post("/patient-portal/google-login", { credential });
  return data;
};

/** Forgot password, step 1: email a 6-digit code for this phone number or email. */
export const patientPortalForgotPassword = async (login) => {
  const { data } = await portalApi.post("/patient-portal/forgot-password", { login });
  return data;
};

/** Step 2: trade the code for a short-lived reset token. */
export const patientPortalVerifyResetOtp = async (requestId, otp) => {
  const { data } = await portalApi.post("/patient-portal/verify-reset-otp", { request_id: requestId, otp });
  return data;
};

/** Step 3: set the new password. Every open sign-in on that login is ended. */
export const patientPortalResetPassword = async (resetToken, newPassword, confirmPassword) => {
  const { data } = await portalApi.post("/patient-portal/reset-password", {
    reset_token: resetToken, new_password: newPassword, confirm_password: confirmPassword,
  });
  return data;
};

export const patientPortalLogout = async () => {
  try {
    await portalApi.post("/patient-portal/logout", null, { headers: authHeaders() });
  } catch { /* token may already be gone — logging out locally still succeeds */ }
};

export const patientPortalMe = async () => {
  const { data } = await portalApi.get("/patient-portal/me", { headers: authHeaders() });
  return data;
};

/** What the patient made of the place, in their own words. The session identifies them,
    so nothing here says who is writing — the server takes that from the token. */
export const patientPortalSubmitFeedback = async ({ rating, message, audience }) => {
  const { data } = await portalApi.post("/patient-portal/feedback", { rating, message, audience }, { headers: authHeaders() });
  return data;
};

/** The course's weeks, the ones waiting for a review, and past weekly and anytime reviews. */
// Asking the branch for more time to pay the treatment balance.
export const patientPortalRequestPaymentExtension = async ({ requestedDueDate, reason }) => {
  const { data } = await portalApi.post(
    "/patient-portal/payment-extension",
    { requested_due_date: requestedDueDate || null, reason },
    { headers: authHeaders() },
  );
  return data;
};

export const patientPortalMyReview = async () => {
  const { data } = await portalApi.get("/patient-portal/review", { headers: authHeaders() });
  return data;
};

/** Stars and Treatment Feedback for the Physio on one completed week (every 7 days). */
export const patientPortalReviewWeek = async (payload) => {
  const { data } = await portalApi.post("/patient-portal/review/week", payload, { headers: authHeaders() });
  return data;
};

/** Skip one week's review pop-up: it stops asking for that week, and stops holding the
 *  Physio's Send to Review. The week's own Review button still opens it afterwards. */
export const patientPortalSkipWeekReview = async (payload) => {
  const { data } = await portalApi.post("/patient-portal/review/week/skip", payload, { headers: authHeaders() });
  return data;
};

/** What this patient has sent, and where each piece has got to. */
export const patientPortalMyFeedback = async () => {
  const { data } = await portalApi.get("/patient-portal/feedback", { headers: authHeaders() });
  return data;
};

/** The patient's next word on a thread they already opened.
 *
 *  `resolved` answers the clinic's "did that settle it?" — true closes the thread, false
 *  hands it back. Left out for an ordinary message, which answers nothing.
 */
export const patientPortalReplyFeedback = async (feedbackId, { body, resolved } = {}) => {
  const { data } = await portalApi.post(
    `/patient-portal/feedback/${feedbackId}/message`,
    { body: body || "", ...(resolved === undefined ? {} : { resolved }) },
    { headers: authHeaders() },
  );
  return data;
};

export const patientPortalDocuments = async () => {
  const { data } = await portalApi.get("/patient-portal/documents", { headers: authHeaders() });
  return data;
};

/** The patient's Diet Chart, as an object URL and the type of the thing behind it.
 *
 *  Its own route and no document id, because the chart is not fetched the way the documents
 *  above are: the server decides which chart is theirs and refuses it outright until the
 *  Diet Chart Fee has been collected. There is nothing to pass, and so nothing to pass that
 *  belongs to somebody else.
 *
 *  A blob for the same reason as below, and the caller owns the URL. */
export const patientPortalDietChartUrl = async () => {
  const { data } = await portalApi.get("/patient-portal/diet-chart", {
    headers: authHeaders(),
    responseType: "blob",
  });
  return { url: URL.createObjectURL(data), type: data.type || "" };
};

/** The bytes, as an object URL, with the blob's content type beside it. Fetched as a blob
    rather than linked to directly: the route needs the session token in a header, which a
    plain <a href> cannot send. The caller owns the URL and must revokeObjectURL it.

    The type comes back because the screen that shows these has to decide how — a picture
    is drawn, a PDF is framed, and everything else is offered as a download. Reading it off
    the blob rather than off the filename means the server's Content-Type is what settles
    it, and the extension is only the fallback (see viewerKindOf in the portal page). */
export const patientPortalDocumentUrl = async (docId) => {
  const { data } = await portalApi.get(`/patient-portal/documents/${docId}/download`, {
    headers: authHeaders(),
    responseType: "blob",
  });
  return { url: URL.createObjectURL(data), type: data.type || "" };
};
