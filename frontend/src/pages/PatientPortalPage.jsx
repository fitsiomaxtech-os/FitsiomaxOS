import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, Check, ChevronRight, ClipboardCheck, ClipboardList, Clock, Dumbbell, Eye, EyeOff, IndianRupee, Lock, LogOut, MessageSquareHeart, PhoneCall, Salad, Star, UserRound, Users, Video, X } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ZoomableImage, ZoomablePdf } from "@/components/ui/zoomable-view";
import { slotTo12h } from "@/lib/time";
import {
  loadPortalSession, savePortalSession, clearPortalSession,
  patientPortalLogin, patientPortalLogout, patientPortalMe, patientPortalGoogleLogin,
  patientPortalSwitch,
  patientPortalForgotPassword, patientPortalVerifyResetOtp, patientPortalResetPassword,
  patientPortalDocuments, patientPortalDocumentUrl, patientPortalDietChartUrl,
  patientPortalSubmitFeedback, patientPortalMyFeedback,
  patientPortalReplyFeedback, patientPortalMyReview, patientPortalReviewWeek,
  patientPortalSkipWeekReview,
  patientPortalRequestPaymentExtension,
} from "@/lib/patientPortalApi";

const LOGO_URL =
  "https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707/artifacts/nozl77ti_Logo%20Icon.webp";

// Unset until the clinic creates a Google Cloud OAuth Client ID and this env var is
// set on the frontend build — until then the button below simply doesn't render.
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;

// Standalone route (/portal) — the patient's own login, entirely separate from the staff
// CRM's auth. A Branch Admin generates these credentials from the Patients tab and shares
// them (link + email + password) over WhatsApp once the Treatment Fee is collected.
export const PatientPortalPage = () => {
  const [session, setSession] = useState(loadPortalSession());

  // Gives /portal its own installable PWA identity — separate icon, name and manifest
  // from the staff CRM that shares this same index.html — without touching index.html
  // itself, so /app is never affected.
  useEffect(() => {
    const setLink = (rel, href, extra = {}) => {
      let el = document.querySelector(`link[rel="${rel}"][data-portal-pwa]`);
      if (!el) {
        el = document.createElement("link");
        el.rel = rel;
        el.setAttribute("data-portal-pwa", "true");
        document.head.appendChild(el);
      }
      el.href = href;
      Object.entries(extra).forEach(([k, v]) => el.setAttribute(k, v));
    };
    const setMeta = (name, content) => {
      let el = document.querySelector(`meta[name="${name}"][data-portal-pwa]`);
      if (!el) {
        el = document.createElement("meta");
        el.name = name;
        el.setAttribute("data-portal-pwa", "true");
        document.head.appendChild(el);
      }
      el.content = content;
    };

    setLink("manifest", "/portal-manifest.json");
    setLink("apple-touch-icon", "/apple-touch-icon.png");
    setLink("icon", "/logo-icon-192.png", { type: "image/png" });
    setMeta("theme-color", "#0284c7");
    setMeta("apple-mobile-web-app-capable", "yes");
    setMeta("apple-mobile-web-app-status-bar-style", "black-translucent");
    setMeta("apple-mobile-web-app-title", "Fitsiomax Portal");

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/portal-sw.js", { scope: "/portal" }).catch(() => {});
    }
  }, []);

  const handleLogin = (data) => {
    savePortalSession(data);
    setSession(data);
  };

  const updateSession = (changes) => {
    const next = { ...loadPortalSession(), ...changes };
    savePortalSession(next);
    setSession(next);
  };

  const handleLogout = async () => {
    await patientPortalLogout();
    clearPortalSession();
    setSession(null);
  };

  if (!session?.token) {
    return <PortalLogin onLogin={handleLogin} />;
  }
  // A family on one login picks who they are looking at before anything loads — every
  // tab below answers for exactly one patient.
  if (session.needs_choice) {
    return (
      <PatientPicker
        patients={session.patients || []}
        onChosen={(chosen) => updateSession({ ...chosen, needs_choice: false })}
        onLogout={handleLogout}
      />
    );
  }
  return (
    <PortalDashboard
      // Keyed on the patient so switching drops the last patient's data rather than
      // flashing it under the new name while the next load is in flight.
      key={session.lead_id || "patient"}
      onLogout={handleLogout}
      onSwitchPatient={(session.patients || []).length > 1 ? () => updateSession({ needs_choice: true }) : null}
    />
  );
};

function PortalLogin({ onLogin }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forgot, setForgot] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await patientPortalLogin(loginId.trim(), password);
      onLogin(data);
      toast.success("Login successful");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-8" data-testid="patient-portal-login">
      <Card className="w-full max-w-sm rounded-xl border border-slate-200 shadow-[0_8px_30px_rgb(2,6,23,0.06)]">
        <CardHeader className="space-y-2 pb-2 text-center">
          <img src={LOGO_URL} alt="Fitsiomax" className="mx-auto h-12 w-12 rounded-lg object-contain" />
          <p className="text-sm font-semibold text-sky-600">FitsiomaxOS</p>
          <h1 className="text-lg font-bold text-slate-900">Client Portal</h1>
        </CardHeader>
        <CardContent>
          {forgot ? (
            <ForgotPasswordFlow
              initialLogin={loginId}
              onCancel={() => setForgot(false)}
              onDone={() => { setPassword(""); setForgot(false); }}
            />
          ) : (
          <>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Phone number or Email</label>
              {/* Plain text, not type="email": the browser would refuse a phone number
                  as an invalid email before the form ever submitted. */}
              <Input
                type="text"
                autoComplete="username"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="98765 43210 or you@example.com"
                required
                data-testid="patient-portal-email"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-9"
                  data-testid="patient-portal-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="-mt-1 text-right">
              <button
                type="button"
                onClick={() => setForgot(true)}
                className="text-xs font-medium text-sky-600 hover:text-sky-700"
                data-testid="patient-portal-forgot-password"
              >
                Forgot password?
              </button>
            </div>
            <Button type="submit" className="w-full" disabled={loading} data-testid="patient-portal-login-submit">
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
          <GoogleSignInButton onLogin={onLogin} />
          </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// A family registered on one phone or email signs in once and picks who to look at. The
// list comes from the sign-in itself, and the server only switches to a patient it holds.
function PatientPicker({ patients, onChosen, onLogout }) {
  const [busy, setBusy] = useState(null);

  const choose = async (p) => {
    setBusy(p.lead_id);
    try {
      const data = await patientPortalSwitch(p.lead_id);
      onChosen({ lead_id: data.lead_id, patient_name: data.patient_name });
    } catch (err) {
      if (err?.response?.status === 401) { onLogout(); return; }
      toast.error(err?.response?.data?.detail || "Could not open this patient");
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-8" data-testid="patient-portal-picker">
      <Card className="w-full max-w-sm rounded-xl border border-slate-200 shadow-[0_8px_30px_rgb(2,6,23,0.06)]">
        <CardHeader className="space-y-2 pb-2 text-center">
          <img src={LOGO_URL} alt="Fitsiomax" className="mx-auto h-12 w-12 rounded-lg object-contain" />
          <h1 className="text-lg font-bold text-slate-900">Who are you checking?</h1>
          <p className="text-xs text-slate-500">This login has more than one patient.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {patients.map((p) => (
            <button
              key={p.lead_id}
              type="button"
              disabled={busy !== null}
              onClick={() => choose(p)}
              className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-sky-300 hover:bg-sky-50 disabled:opacity-60"
              data-testid={`patient-portal-pick-${p.lead_id}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
                {(p.name || "?").charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-800">{p.name || "Patient"}</span>
                {p.patient_number && <span className="block text-[11px] text-slate-400">{p.patient_number}</span>}
              </span>
              {busy === p.lead_id
                ? <span className="text-[11px] text-slate-400">Opening…</span>
                : <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />}
            </button>
          ))}
          <Button variant="ghost" size="sm" className="w-full text-xs text-slate-500" onClick={onLogout} data-testid="patient-portal-picker-logout">
            <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Only account emails a Branch Admin already created get in this way — signing in with
// Google links to an existing portal account by email, it never creates a new one.
function GoogleSignInButton({ onLogin }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const handleCredential = async (response) => {
      try {
        const data = await patientPortalGoogleLogin(response.credential);
        onLogin(data);
        toast.success("Login successful");
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Google sign-in failed");
      }
    };

    const init = () => {
      if (!window.google?.accounts?.id || !buttonRef.current) return;
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredential });
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "outline", size: "large", width: 280, text: "signin_with",
      });
    };

    if (window.google?.accounts?.id) {
      init();
      return;
    }
    const existing = document.getElementById("google-identity-script");
    if (existing) {
      existing.addEventListener("load", init, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = "google-identity-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [onLogin]);

  if (!GOOGLE_CLIENT_ID) return null;

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center gap-3 text-xs text-slate-400">
        <div className="h-px flex-1 bg-slate-200" />
        <span>OR</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>
      <div ref={buttonRef} className="flex justify-center" data-testid="patient-portal-google-button" />
    </div>
  );
}

/** Indian digit grouping — 4,97,896 rather than 497896. The patient is reading what they
    were charged, and an ungrouped six-figure number is read wrong before it is read. */
const money = (n) => (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const ordinal = (n) => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
};

// Small header shown at the top of Sessions and Treatment — who's actually treating
// this patient. No contact/call action for the Head Physio anywhere in the portal,
// by design; only the branch itself is reachable from here (see ProfileTab).
function DoctorMiniCard({ physioName, headPhysioName }) {
  if (!physioName && !headPhysioName) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white p-3 text-xs" data-testid="patient-portal-doctor-card">
      {headPhysioName && (
        <div>
          <span className="text-slate-400">CONSULTANT</span>{" "}
          <span className="font-semibold text-slate-700">{headPhysioName}</span>
        </div>
      )}
      {physioName && (
        <div>
          <span className="text-slate-400">Physio</span>{" "}
          <span className="font-semibold text-slate-700">{physioName}</span>
        </div>
      )}
    </div>
  );
}

/** The first day of a course still to be done, or -1 when every one of them is finished.
 *
 *  The only day a patient may join, and the same rule the server already holds them to:
 *  _first_incomplete_before in v3_physio_board refuses to complete or mark absent any day
 *  with an earlier one outstanding — "treatment days are worked in order". This page used
 *  to offer a join link on all six at once, which invited a patient into day six while day
 *  one was still ahead of them, and the physio's board would then refuse to record it.
 *
 *  Counted per course. A rehab course and a treatment package are separate runs of days
 *  for the same patient, so rehab day 2 is not held back by treatment day 1 — the server
 *  draws that line in the same helper and this has to draw it in the same place.
 *
 *  Status, not date: an absence pushes a day's slot down the course and leaves it carrying
 *  a later date than the day behind it, so ordering on the date would call a sequence
 *  broken that is not.
 */
const firstOpenDay = (days) => (days || []).findIndex((d) => d.status !== "completed");

/** Completed / Remaining / Total, and the bar under them, for one course of days. */
function CourseStats({ completed, total, label, tone = "sky" }) {
  const remaining = Math.max(total - completed, 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const violet = tone === "violet";
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
          <p className="text-xl font-bold text-emerald-700">{completed}</p>
          <p className="text-[10px] text-emerald-500">Completed</p>
        </div>
        <div className={`rounded-xl border p-3 text-center ${violet ? "border-violet-200 bg-violet-50" : "border-sky-200 bg-sky-50"}`}>
          <p className={`text-xl font-bold ${violet ? "text-violet-700" : "text-sky-700"}`}>{remaining}</p>
          <p className={`text-[10px] ${violet ? "text-violet-500" : "text-sky-500"}`}>Remaining</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
          <p className="text-xl font-bold text-slate-700">{total}</p>
          <p className="text-[10px] text-slate-400">Total</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-slate-600">{label}</p>
          <p className={`text-xs font-bold ${violet ? "text-violet-700" : "text-sky-700"}`}>{pct}%</p>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full bg-gradient-to-r transition-all ${violet ? "from-violet-400 to-emerald-400" : "from-sky-400 to-emerald-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </>
  );
}

/** One day of a course — a treatment session or a rehab day, which are the same row.
 *
 *  `open` is whether this is the day the patient is up to. Only that day carries the join
 *  link, and only when it is held over video: the rest are ahead of them, and a link on one
 *  invites them into the wrong room on the wrong day.
 *
 *  The row IS the link when there is one. A patient looking at "Session 1, Friday, 11:30"
 *  and wanting to join taps the session, because that is the thing on screen they are
 *  thinking about, so the whole row answers to it. The chip stays as the visible say-so
 *  that it will — a row that silently opens a new tab is a surprise.
 */
function DayRow({ title, subtitle, number, status, slotTime, meetLink, open, remarks, action, testid, meetTestid, tone = "slate" }) {
  const joinable = !!meetLink && open && status !== "completed";
  const Row = joinable ? "a" : "div";
  const rowProps = joinable ? { href: meetLink, target: "_blank", rel: "noopener noreferrer" } : {};
  const pending = tone === "violet" ? "bg-violet-100 text-violet-600" : "bg-slate-100 text-slate-500";
  return (
    <Row
      {...rowProps}
      className={`flex items-center gap-3 px-4 py-3 ${joinable ? "cursor-pointer transition hover:bg-violet-50/60" : ""}`}
      data-testid={testid}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        status === "completed" ? "bg-emerald-100 text-emerald-700" : pending
      }`}>
        {status === "completed" ? <Check className="h-4 w-4" /> : number}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-700">
          {title} {subtitle ? <span className="text-slate-400">· {subtitle}</span> : null}
        </p>
        <p className="flex items-center gap-1 text-[10px] text-slate-400">
          <Clock className="h-3 w-3" />
          {slotTime ? `${slotTime.split("T")[0]} at ${slotTo12h(slotTime)}` : "—"}
        </p>
        {joinable && (
          <span
            className="mt-1 inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700"
            data-testid={meetTestid}
          >
            <Video className="h-3 w-3" /> Join on Google Meet
          </span>
        )}
        {remarks}
      </div>
      {action}
      {/* shrink-0: without it a long physio remark beside this squeezes the
          badge until "upcoming" wraps mid-word. */}
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold ${
        status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}>
        {status}
      </span>
    </Row>
  );
}

/** Why only one day carries a join link, said once above the list.
 *
 *  Five rows each repeating "available after Session 1" is five times the words for one
 *  fact. The patient needs to know which day is theirs to join; they do not need telling
 *  on every day that is not.
 */
function InOrderNote({ nextNumber, noun }) {
  if (nextNumber == null) return null;
  return (
    <p className="border-b border-slate-100 bg-violet-50/40 px-4 py-2 text-[10px] text-violet-600" data-testid="patient-portal-in-order-note">
      You are up to <span className="font-semibold">{noun} {nextNumber}</span> — that is the one to join.
      The days after it open as each is completed.
    </p>
  );
}

// Exported (Sessions/Treatment/Payment only — pure renders off `data`, nothing
// auth-bound) so Operations' Client tab can show a staff-side preview of a patient's
// own portal without duplicating three tabs' worth of markup.
export function SessionsTab({ data, reviews = null, onReviewed }) {
  const rehab = data.rehab;
  const rehabDays = rehab?.days || [];
  // Only a patient actually on a rehab course gets the choice. Everybody else sees the
  // treatment days exactly as before, with no tab bar above them asking them to pick
  // between one thing and nothing.
  const hasRehab = rehabDays.length > 0 || !!rehab?.physio_name;
  const [course, setCourse] = useState("treatment");
  const showing = hasRehab ? course : "treatment";

  return (
    <div className="space-y-4" data-testid="patient-portal-sessions-tab">
      <DoctorMiniCard physioName={data.physio_name} headPhysioName={data.head_physio_name} />

      {/* Two courses, two tabs, rather than one scroll with the second stacked under the
          first. They are separate runs of days with separate counts — see the rehab block
          in v3_patient_portal — and stacked they read as one long course whose numbering
          restarts halfway down, under tiles that only ever counted the first of them. */}
      {hasRehab && (
        <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1" data-testid="patient-portal-course-tabs">
          {[
            { key: "treatment", label: "Treatment", count: data.total_sessions || 0 },
            { key: "rehab", label: "Rehab", count: rehab?.total_days || 0 },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setCourse(t.key)}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                showing === t.key
                  ? t.key === "rehab" ? "bg-violet-50 text-violet-700" : "bg-sky-50 text-sky-700"
                  : "text-slate-500 hover:bg-slate-50"
              }`}
              data-testid={`patient-portal-course-tab-${t.key}`}
            >
              {t.label} <span className="font-normal text-slate-400">· {t.count}</span>
            </button>
          ))}
        </div>
      )}

      {showing === "treatment"
        ? <TreatmentCourse data={data} reviews={reviews} onReviewed={onReviewed} />
        : <RehabCourse rehab={rehab} reviews={reviews} onReviewed={onReviewed} />}
    </div>
  );
}

/** The treatment package: its days, and the physio's weekly notes on them. */
function TreatmentCourse({ data, reviews, onReviewed }) {
  const sessions = data.sessions || [];
  const openIdx = firstOpenDay(sessions);

  return (
    <>
      <CourseStats
        completed={data.completed_sessions || 0}
        total={data.total_sessions || 0}
        label="Overall Progress"
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            <Calendar className="h-4 w-4 text-sky-500" /> Session History
          </h2>
        </div>
        <InOrderNote nextNumber={openIdx >= 0 ? sessions[openIdx].session_number : null} noun="Session" />
        <div className="divide-y divide-slate-50">
          {sessions.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">No sessions booked yet</p>
          ) : (
            sessions.map((s, i) => (
              <DayRow
                key={s.session_number}
                title={`Session ${s.session_number}`}
                subtitle={s.week_number ? `Week ${s.week_number}` : ""}
                number={s.session_number}
                status={s.status}
                slotTime={s.slot_time}
                meetLink={s.meet_link}
                open={i === openIdx}
                testid={`patient-portal-session-${s.session_number}`}
                meetTestid={`patient-portal-session-meet-${s.session_number}`}
                remarks={<>
                  {(s.jr_physio_remarks || s.rehab_remarks) ? (
                    <div className="mt-1.5 space-y-1 rounded border border-emerald-100 bg-emerald-50 p-2">
                      {s.jr_physio_remarks && (
                        <p className="text-[10px] text-emerald-600"><span className="font-semibold">Treatment: </span>{s.jr_physio_remarks}</p>
                      )}
                      {s.rehab_remarks && (
                        <p className="text-[10px] text-emerald-600"><span className="font-semibold">Rehab: </span>{s.rehab_remarks}</p>
                      )}
                    </div>
                  ) : null}
                </>}
                action={<WeekReviewButton track="treatment" number={s.session_number} reviews={reviews} onReviewed={onReviewed} />}
              />
            ))
          )}
        </div>
      </div>

      {data.weekly_assessments && data.weekly_assessments.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <ClipboardList className="h-4 w-4 text-sky-500" /> Weekly Progress Notes
            </h2>
          </div>
          <div className="divide-y divide-slate-50">
            {data.weekly_assessments.map((a) => (
              <div key={a.week_number} className="px-4 py-3">
                <p className="mb-1 text-xs font-semibold text-slate-700">Week {a.week_number}</p>
                {a.jr_physio_notes ? (
                  <p className="text-xs text-slate-600">{a.jr_physio_notes}</p>
                ) : (
                  <p className="text-xs italic text-slate-300">No notes yet</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The rehab course, when the patient is on one.
 *
 *  Its own tab rather than mixed into the treatment days, because they are two courses
 *  that happen to share a physio: rehab has its own day numbering, its own count and its
 *  own fee, and a patient can be on it having never bought a session package. See the
 *  rehab block in v3_patient_portal, and v3_rehab's own docstring for why the two have
 *  never shared a collection.
 *
 *  Absent from this page entirely until now. A patient booked onto rehab saw no sign of it
 *  while the Payment tab showed them the Rehab Fee they had paid, which is a charge with
 *  no course behind it on the one screen whose job is telling them what they bought.
 */
function RehabCourse({ rehab, reviews, onReviewed }) {
  const days = rehab?.days || [];
  const openIdx = firstOpenDay(days);

  return (
    <>
      <CourseStats
        completed={rehab?.completed_days || 0}
        total={rehab?.total_days || 0}
        label="Rehab Progress"
        tone="violet"
      />

      <div className="overflow-hidden rounded-xl border border-violet-200 bg-white" data-testid="patient-portal-rehab">
        <div className="border-b border-violet-100 bg-violet-50/60 px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-violet-800">
            <Dumbbell className="h-4 w-4 text-violet-500" /> Rehab Exercise Days
          </h2>
          <p className="mt-0.5 text-[10px] text-violet-500">
            {rehab?.physio_name ? <>With <span className="font-semibold">{rehab.physio_name}</span>. </> : null}
            Runs alongside your treatment sessions.
          </p>
        </div>
        <InOrderNote nextNumber={openIdx >= 0 ? days[openIdx].day_number : null} noun="Rehab Day" />
        <div className="divide-y divide-slate-50">
          {days.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">No rehab days booked yet</p>
          ) : (
            days.map((r, i) => (
              <DayRow
                key={r.day_number}
                title={`Rehab Day ${r.day_number}`}
                subtitle={r.total_days ? `of ${r.total_days}` : ""}
                number={r.day_number}
                status={r.status}
                slotTime={r.slot_time}
                meetLink={r.meet_link}
                open={i === openIdx}
                tone="violet"
                testid={`patient-portal-rehab-day-${r.day_number}`}
                meetTestid={`patient-portal-rehab-meet-${r.day_number}`}
                remarks={<>
                  {r.physio_remarks ? (
                    <div className="mt-1.5 rounded border border-emerald-100 bg-emerald-50 p-2">
                      <p className="text-[10px] text-emerald-600">
                        <span className="font-semibold">Rehab: </span>{r.physio_remarks}
                      </p>
                    </div>
                  ) : null}
                </>}
                action={<WeekReviewButton track="rehab" number={r.day_number} reviews={reviews} onReviewed={onReviewed} />}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

/** The patient's Diet Chart, once it is theirs to read.
 *
 *  Three states and they are all different things. No chart: nothing to say, so nothing is
 *  shown. A chart waiting on the fee: said plainly, because the alternative is a patient
 *  who was told a chart was coming seeing an empty screen and concluding the Nutritionist
 *  forgot them — the actual answer is a payment at the desk, and only the clinic can tell
 *  them that. A chart they have paid for: opened.
 *
 *  The server decides which of the three this is; nothing here can promote one to another.
 *  When a chart is held, the payload carries no document id and no filename, and the
 *  download route refuses independently — so this component could not reveal it by mistake
 *  even if it tried to.
 */
/**
 * What kind of thing a file is, for the viewer below.
 *
 * The blob's own content type first, because that is the server's answer and it is the one
 * that is right when a file was uploaded with a misleading name. The extension is only
 * consulted when the server said nothing useful — an octet-stream, which is what a strict
 * store hands back for everything it is unsure of.
 */
const viewerKindOf = (type, name) => {
  const mime = String(type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "other";
};

/**
 * A file, shown where the patient is rather than in a tab they have to find their way back
 * from.
 *
 * These used to open with window.open, which on a phone means the portal disappears and
 * the picture arrives in a second tab -- and the way back is the browser's tab switcher,
 * not anything this app put on screen. For a chart somebody glances at between one card
 * and the next, that is the whole interaction gone wrong. So it opens over the page, and
 * closing it puts them back exactly where they were.
 *
 * Portalled to the body because the page has a fixed bottom nav at z-40 and cards with
 * their own stacking; rendered in place, the overlay would be cropped by whichever one it
 * happened to sit inside.
 *
 * Three ways to draw one, because a portal serves pictures and PDFs and has no say in
 * which: an image is drawn, a PDF is framed, and anything else is offered as a download
 * rather than shown as a blank rectangle. The escape hatch stays on all three -- a browser
 * that will not render a blob PDF in a frame (which is most phones) must not leave the
 * patient looking at nothing, so "Open in a new tab" is still there, as a fallback now
 * rather than as the only behaviour.
 */
function FileViewer({ file, onClose }) {
  const kind = viewerKindOf(file?.type, file?.name);

  // Escape closes it, and the page behind stops scrolling while it is up -- a body that
  // scrolls under a full-screen overlay is how somebody closes the viewer and finds
  // themselves somewhere else on the page.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!file) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/90 p-3 sm:p-6"
      onClick={onClose}
      data-testid="patient-portal-file-viewer"
    >
      <div
        className="mx-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <p className="min-w-0 truncate text-sm font-semibold text-slate-800" title={file.name}>
            {file.name || "Document"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
            data-testid="patient-portal-file-viewer-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
          {kind === "image" && (
            <ZoomableImage
              src={file.url}
              alt={file.name || "Document"}
              className="!h-[70vh]"
              testid="patient-portal-file-viewer-image"
            />
          )}
          {kind === "pdf" && (
            <ZoomablePdf
              src={file.url}
              title={file.name || "Document"}
              className="h-[70vh] w-full overflow-hidden rounded-lg bg-white"
              testid="patient-portal-file-viewer-pdf"
            />
          )}
          {kind === "other" && (
            <p className="py-10 text-center text-sm text-slate-500" data-testid="patient-portal-file-viewer-other">
              This file can&apos;t be previewed here. Download it to open it.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5">
          {/* Still here, and still doing what it always did. A phone that refuses to draw
              a blob PDF in a frame would otherwise leave the patient with a white box and
              no way on. */}
          <a
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-semibold text-slate-500 hover:text-slate-700"
            data-testid="patient-portal-file-viewer-newtab"
          >
            Open in a new tab
          </a>
          <a
            href={file.url}
            download={file.name || "document"}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-slate-900"
            data-testid="patient-portal-file-viewer-download"
          >
            Download
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Let go of an object URL, but not this second.
 *
 *  The viewer's own footer hands this URL to two things that outlive it: a download, and
 *  the new-tab fallback. Both are still reading from it after the viewer they were pressed
 *  in has closed, and revoking it out from under them is a failed download or a blank tab.
 *  So the allocation is held a minute past its last use — the same delay, and the same
 *  reason, as the window.open this replaced.
 */
const releaseLater = (url) => {
  if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
};

/** Fetching a file, holding it while it is on screen, and letting go of it afterwards.
 *
 *  One hook because both the Diet Chart and the documents list do exactly this, and the
 *  part that is easy to get wrong is the same in both: the object URL is a real allocation,
 *  and it has to be released when the viewer closes and again if the component unmounts
 *  with one still open.
 */
function useFileViewer(failureMessage) {
  const [opening, setOpening] = useState(null);
  const [file, setFile] = useState(null);

  const close = useCallback(() => {
    setFile((current) => {
      releaseLater(current?.url);
      return null;
    });
  }, []);

  // Only on unmount -- the patient navigating away with the viewer open.
  useEffect(() => close, [close]);

  const open = useCallback(async (key, name, fetcher) => {
    setOpening(key);
    try {
      const { url, type } = await fetcher();
      // Replacing rather than assuming there is nothing to replace. The viewer covers the
      // buttons that open it, so in practice one is always closed before the next is
      // opened -- but "in practice" is not a reason to leak the allocation if that ever
      // stops being true.
      setFile((previous) => {
        releaseLater(previous?.url);
        return { url, type, name };
      });
    } catch {
      toast.error(failureMessage);
    }
    setOpening(null);
  }, [failureMessage]);

  return { opening, file, open, close };
}

function DietChartRow({ chart }) {
  const { opening, file, open, close } = useFileViewer(
    "Your Diet Chart couldn't be opened. Please ask your branch.",
  );
  if (!chart || (!chart.available && !chart.awaiting_payment)) return null;

  if (chart.awaiting_payment) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3" data-testid="patient-portal-diet-chart-locked">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800">
          <Lock className="h-3.5 w-3.5" /> Your Diet Chart is ready
        </p>
        <p className="mt-1 text-[11px] text-amber-700">
          It will appear here once the Diet Chart fee has been paid. Please speak to your branch.
        </p>
      </div>
    );
  }

  const name = chart.original_name || "Diet Chart";

  return (
    <>
      <button
        type="button"
        // A blob rather than a link: the route needs the session token in a header, which
        // a plain <a href> cannot send. What is new is where it goes — over the page
        // instead of into a tab the patient has to find their way back from.
        onClick={() => open("chart", name, patientPortalDietChartUrl)}
        disabled={!!opening}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-orange-200 bg-orange-50/60 p-3 text-left transition hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
        data-testid="patient-portal-diet-chart"
      >
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-orange-500">Your Diet Chart</p>
          <p className="truncate text-xs font-semibold text-orange-900">{name}</p>
          <p className="text-[10px] text-orange-400">
            {chart.sent_by || "Your Nutritionist"}
            {chart.sent_at ? ` · ${String(chart.sent_at).slice(0, 10)}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-[11px] font-semibold text-orange-600">
          {opening ? "Opening..." : "View"}
        </span>
      </button>
      {file && <FileViewer file={file} onClose={close} />}
    </>
  );
}

/** When the patient sees their Nutrition Coach, and how far through the check-ins they
    are. Renders nothing at all unless a Diet Consultation has been booked, or a chart is
    on its way to them — a patient who bought only a chart never books a thing, and this
    card was their whole diet screen. */
function DietCard({ diet }) {
  const hasChart = !!(diet?.chart?.available || diet?.chart?.awaiting_payment);
  if (!diet || (!diet.appointment_at && !diet.total_checkins && !hasChart)) return null;
  const date = (diet.appointment_at || "").split("T")[0];
  const done = diet.completed_checkins || 0;
  const total = diet.total_checkins || 0;

  return (
    <div className="overflow-hidden rounded-xl border border-orange-200 bg-white" data-testid="patient-portal-diet-card">
      <div className="border-b border-orange-100 bg-orange-50/60 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-orange-700">
          <Salad className="h-4 w-4 text-orange-500" /> Diet Plan
        </h2>
      </div>
      <div className="space-y-2 px-4 py-3">
        {diet.coach_name && (
          <p className="text-xs text-slate-600">
            Nutritionist <span className="font-semibold text-slate-800">{diet.coach_name}</span>
          </p>
        )}
        {date && (
          <div className="rounded-md border border-orange-200 bg-orange-50 px-2.5 py-2 text-xs text-orange-800">
            Diet Consultation on <span className="font-semibold">{date}</span>
            {" at "}<span className="font-semibold">{slotTo12h(diet.appointment_at)}</span>
            {/* Inside the appointment box rather than under it: it is where that
                appointment happens, and read as part of the same sentence. Only for a
                coach on an online arm — a branch's own Nutritionist is seen in the room
                and has no video room recorded. */}
            {diet.meet_link && (
              <a
                href={diet.meet_link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
                data-testid="patient-portal-diet-meet"
              >
                <Video className="h-3 w-3" /> Join on Google Meet
              </a>
            )}
          </div>
        )}
        {total > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>Check-ins</span>
              <span className="font-semibold text-slate-700">{done} of {total}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-orange-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {/* The plan the patient is meant to follow — the reason they came. */}
        {diet.consultation_report && (
          <div className="rounded-lg border border-orange-200 bg-orange-50/60 p-3" data-testid="patient-portal-diet-report">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-orange-500">
              Diet Consultation Report
            </p>
            <p className="whitespace-pre-wrap text-xs text-orange-900">{diet.consultation_report}</p>
            {diet.consultation_report_by && (
              <p className="mt-1.5 text-[10px] text-orange-400">
                {diet.consultation_report_by}
                {diet.consultation_report_at ? ` · ${String(diet.consultation_report_at).slice(0, 10)}` : ""}
              </p>
            )}
          </div>
        )}

        {/* The chart itself, under the report it follows from. Gated on its own fee by the
            server, not by this screen — see DietChartRow. */}
        <DietChartRow chart={diet.chart} />
      </div>
    </div>
  );
}

/** The client's Review Record: every Consultant review raised on their course, with the
    date it was booked for, whether it has been done, and the Consultant's suggestions.
    Shown on Overview (it answers "where am I in my course") and again under Treatment,
    where it sits with the diagnosis it follows from. Renders nothing before the first
    review is raised, rather than an empty card on a brand-new patient's screen. */
function ReviewRecordCard({ reviews, testid = "patient-portal-review-record" }) {
  if (!reviews || reviews.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid={testid}>
      <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <ClipboardCheck className="h-4 w-4 text-sky-500" /> Review Record
        </h2>
      </div>
      <div className="divide-y divide-slate-50">
        {reviews.map((r, i) => (
          <div key={r.id || i} className="px-4 py-3" data-testid={`${testid}-${r.review_number}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="flex-1 text-xs font-semibold text-slate-700">{ordinal(r.review_number)} Review</p>
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                r.status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
              }`}>
                {r.status === "completed" ? "Completed" : "In Progress"}
              </span>
            </div>
            {r.review_date && <p className="mt-0.5 text-[10px] text-slate-400">{r.review_date}</p>}
            {r.head_physio_suggestions && <p className="mt-1.5 text-xs text-slate-600">{r.head_physio_suggestions}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TreatmentTab({ data, reviews = null, onReviewed }) {
  return (
    <div className="space-y-4" data-testid="patient-portal-treatment-tab">
      <DoctorMiniCard physioName={data.physio_name} headPhysioName={data.head_physio_name} />

      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Treatment Package</p>
        <p className="text-sm font-semibold text-slate-800">
          {data.session_package_name || "—"}{data.session_package_sessions ? ` · ${data.session_package_sessions} sessions` : ""}
        </p>
      </div>
      {data.diagnosis && (
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Diagnosis</p>
          <p className="whitespace-pre-wrap text-xs text-slate-700">{data.diagnosis}</p>
        </div>
      )}
      {data.physio_diagnosis_report && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-sky-500">Diagnosis Report</p>
          <p className="whitespace-pre-wrap text-xs text-sky-900">{data.physio_diagnosis_report}</p>
        </div>
      )}
      {data.treatment_summary && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-violet-500">Treatment Plan</p>
          <p className="whitespace-pre-wrap text-xs text-violet-900">{data.treatment_summary}</p>
        </div>
      )}
      {!data.physio_diagnosis_report && !data.treatment_summary && (
        <p className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
          No treatment details shared yet.
        </p>
      )}

      {/* The diet side of their care. Shown only once a Diet Consultation is actually
          booked — diet is optional, and an empty card on every other patient's screen
          would suggest a plan they were never put on. */}
      <DietCard diet={data.diet} />

      <ReviewRecordCard reviews={data.reviews} testid="patient-portal-review" />
    </div>
  );
}

/**
 * Sessions paid for against the package, and -- once they are used up with a balance owing
 * -- the hold on treatment and a way to ask the branch for more time to pay. Without
 * `onChanged` (the staff preview of this screen) the request button is not offered.
 */
function SessionPaymentNotice({ sp, onChanged }) {
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const status = sp.extension_status;
  const canAsk = !!onChanged && status !== "requested" && !(status === "approved" && !sp.on_hold);

  const submit = async () => {
    if (!reason.trim()) { toast.error("Tell the branch why you need more time"); return; }
    setBusy(true);
    try {
      await patientPortalRequestPaymentExtension({ requestedDueDate: date, reason: reason.trim() });
      toast.success("Request sent to your branch");
      setAsking(false);
      onChanged();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not send the request");
    }
    setBusy(false);
  };

  return (
    <div className="mt-2 space-y-2" data-testid="portal-session-payment">
      <p className="text-[11px] text-slate-500">
        {sp.paid_sessions} of {sp.total_sessions} sessions paid for · balance ₹{money(sp.balance)}
      </p>
      {sp.on_hold && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800" data-testid="portal-session-payment-hold">
          <p className="font-semibold">Your paid sessions are used up</p>
          <p className="mt-0.5">Please pay the balance of ₹{money(sp.balance)} to continue with session {sp.paid_sessions + 1}, or ask the branch for more time.</p>
        </div>
      )}
      {status === "requested" && (
        <p className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-2 text-xs text-violet-800">
          Your request for more time{sp.extension_requested_due_date ? ` (until ${sp.extension_requested_due_date})` : ""} is with the branch.
        </p>
      )}
      {status === "approved" && !sp.on_hold && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700">
          The branch has extended your balance due date to {sp.extended_due_date}. Your sessions can continue.
        </p>
      )}
      {status === "rejected" && (
        <p className="text-[11px] text-slate-500">
          The branch could not extend the due date{sp.extension_decision_note ? `: ${sp.extension_decision_note}` : "."}
        </p>
      )}
      {canAsk && (
        asking ? (
          <div className="space-y-2 rounded-md border border-slate-200 p-2.5" data-testid="portal-extension-form">
            <label className="block text-[11px] font-semibold text-slate-600">
              Pay by (optional)
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-8 text-xs" />
            </label>
            <label className="block text-[11px] font-semibold text-slate-600">
              Reason
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                className="mt-1 block w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs font-normal"
                data-testid="portal-extension-reason"
              />
            </label>
            <div className="flex gap-2">
              <Button size="sm" className="h-8 flex-1 text-xs" disabled={busy} onClick={submit} data-testid="portal-extension-submit">
                Send request
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="h-8 w-full text-xs" onClick={() => setAsking(true)} data-testid="portal-extension-open">
            Ask for more time to pay
          </Button>
        )
      )}
    </div>
  );
}

export function PaymentTab({ data, onChanged }) {
  const p = data.payment || {};
  // All three fees. The diet one was missing, so a patient who paid for a diet
  // consultation was shown a Total that did not include their own money.
  const totalAll = (p.consultation_fee_total || 0) + (p.treatment_fee_total || 0) + (p.diet_fee_total || 0) + (p.diet_chart_fee_total || 0);
  const collectedAll = (p.consultation_fee_paid || 0) + (p.treatment_fee_paid || 0) + (p.diet_fee_paid || 0) + (p.diet_chart_fee_paid || 0);
  const pendingAll = Math.max(totalAll - collectedAll, 0);

  return (
    <div className="space-y-4" data-testid="patient-portal-payment-tab">
      {/* Grouped and truncated. These were raw numbers — ₹497896 — in a tile a third of
          a phone wide: hard to read at a glance, and a longer figure would have run past
          its own border rather than shortening. */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-center">
          <p className="truncate text-lg font-bold text-sky-700" title={`₹${money(totalAll)}`}>₹{money(totalAll)}</p>
          <p className="text-[10px] text-sky-500">Total</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
          <p className="truncate text-lg font-bold text-emerald-700" title={`₹${money(collectedAll)}`}>₹{money(collectedAll)}</p>
          <p className="text-[10px] text-emerald-500">Collected</p>
        </div>
        <div className={`rounded-xl border p-3 text-center ${pendingAll > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
          <p className={`truncate text-lg font-bold ${pendingAll > 0 ? "text-amber-700" : "text-slate-700"}`} title={`₹${money(pendingAll)}`}>₹{money(pendingAll)}</p>
          <p className={`text-[10px] ${pendingAll > 0 ? "text-amber-500" : "text-slate-400"}`}>Pending</p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="patient-portal-consultation-fee">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Consultation Fee</p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${p.consultation_fee_paid ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {p.consultation_fee_paid ? "Paid" : "Pending"}
          </span>
        </div>
        {p.consultation_fee_paid ? (
          <p className="text-xs text-slate-600">₹{money(p.consultation_fee_paid)} <span className="capitalize text-slate-400">via {p.consultation_payment_mode}</span></p>
        ) : (
          <p className="text-xs text-slate-400">Not yet collected{p.consultation_fee_total ? ` — ₹${money(p.consultation_fee_total)} due` : ""}</p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="patient-portal-treatment-fee">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Treatment Fee</p>
          {p.treatment_fee_total == null ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Not Assigned</span>
          ) : p.is_partial ? (
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">Partial</span>
          ) : p.treatment_fee_paid ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Paid in Full</span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Pending</span>
          )}
        </div>
        {p.is_partial ? (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">{p.installments_paid} of {p.installments_total} payments collected</p>
            {p.next_due_date ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                Next payment <span className="font-semibold">₹{money(p.next_due_amount)}</span> due {p.next_due_date}
              </div>
            ) : (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700">All installments collected</p>
            )}
          </div>
        ) : p.treatment_fee_paid ? (
          <p className="text-xs text-slate-600">₹{money(p.treatment_fee_paid)} <span className="capitalize text-slate-400">via {p.treatment_payment_mode}</span></p>
        ) : (
          <p className="text-xs text-slate-400">No treatment fee collected yet</p>
        )}
        {p.session_payment && <SessionPaymentNotice sp={p.session_payment} onChanged={onChanged} />}
      </div>

      {/* Only for patients who actually took a diet plan. Diet is optional, so an empty
          card on every other patient's screen would be a bill they never had. */}
      {p.diet_fee_paid != null && (
        <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="patient-portal-diet-fee">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Diet Consultation Fee</p>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Paid</span>
          </div>
          <p className="text-xs text-slate-600">
            ₹{money(p.diet_fee_paid)} <span className="capitalize text-slate-400">via {p.diet_payment_mode}</span>
          </p>
          {p.diet_package_name && <p className="mt-0.5 text-[11px] text-slate-400">{p.diet_package_name}</p>}
        </div>
      )}

      {/* The Diet Chart's own fee. Its own card rather than a figure added into the one
          above, because a patient sold both would otherwise read a total they cannot match
          against either receipt — on the screen whose whole job is telling them what they
          were charged for. */}
      {p.diet_chart_fee_paid != null && (
        <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="patient-portal-diet-chart-fee">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Diet Chart Fee</p>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Paid</span>
          </div>
          <p className="text-xs text-slate-600">
            ₹{money(p.diet_chart_fee_paid)} <span className="capitalize text-slate-400">via {p.diet_chart_payment_mode}</span>
          </p>
          {p.diet_chart_package_name && <p className="mt-0.5 text-[11px] text-slate-400">{p.diet_chart_package_name}</p>}
        </div>
      )}
    </div>
  );
}


const prettyBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The patient's own documents.
 *
 * Only what the branch has shared comes back — the server decides that, not this
 * component, so nothing here can widen it. Renders nothing at all when the list is empty,
 * because an empty "Documents" card reads as something having gone missing.
 *
 * Opened through a blob URL rather than a direct link: the download route needs the
 * session token in a header, which an <a href> cannot send. Shown over the page rather
 * than in a new tab, for the reason set out on FileViewer — the same control as the Diet
 * Chart above, so it behaves the same way.
 */
function PatientDocuments() {
  const [docs, setDocs] = useState([]);
  const { opening, file, open, close } = useFileViewer(
    "That document couldn't be opened. Please ask your branch.",
  );

  useEffect(() => {
    let cancelled = false;
    patientPortalDocuments()
      .then((r) => { if (!cancelled) setDocs(r.documents || []); })
      .catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, []);

  if (docs.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="patient-portal-documents">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Your Documents</p>
      <div className="space-y-2">
        {docs.map((d) => {
          const name = d.label || d.original_name;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => open(d.id, name, () => patientPortalDocumentUrl(d.id))}
              disabled={opening === d.id}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 p-2.5 text-left transition hover:border-sky-300 hover:bg-sky-50/50 disabled:opacity-50"
              data-testid={`patient-portal-document-${d.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-800">{name}</p>
                <p className="text-[10px] text-slate-400">
                  {d.kind === "consultation_form" ? "Consultation Form" : "Report"}
                  {d.size_bytes ? ` · ${prettyBytes(d.size_bytes)}` : ""}
                  {d.created_at ? ` · ${String(d.created_at).slice(0, 10)}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-[11px] font-semibold text-sky-600">
                {opening === d.id ? "Opening..." : "View"}
              </span>
            </button>
          );
        })}
      </div>
      {file && <FileViewer file={file} onClose={close} />}
    </div>
  );
}

const PORTAL_PASSWORD_MIN = 6;

// Forgot password in three steps — who you are, the emailed code, the new password. Used
// on the sign-in screen and inside the Overview's Password card.
function ForgotPasswordFlow({ initialLogin = "", onDone, onCancel }) {
  const [step, setStep] = useState("login"); // "login" | "otp" | "password"
  const [loginId, setLoginId] = useState(initialLogin);
  const [requestId, setRequestId] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const [otp, setOtp] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Something went wrong. Please try again.");
    }
    setBusy(false);
  };

  const sendCode = (e) => {
    e?.preventDefault();
    if (!loginId.trim()) { toast.error("Enter your phone number or email"); return; }
    run(async () => {
      const res = await patientPortalForgotPassword(loginId.trim());
      setRequestId(res.request_id);
      setSentMessage(res.message);
      setOtp("");
      setStep("otp");
      setCooldown(60);
      toast.success("Code sent");
    });
  };

  const verifyCode = (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp.trim())) { toast.error("Enter the 6-digit code"); return; }
    run(async () => {
      const res = await patientPortalVerifyResetOtp(requestId, otp.trim());
      setResetToken(res.reset_token);
      setStep("password");
    });
  };

  const savePassword = (e) => {
    e.preventDefault();
    if (next.length < PORTAL_PASSWORD_MIN) { toast.error(`New password must be at least ${PORTAL_PASSWORD_MIN} characters`); return; }
    if (next !== confirm) { toast.error("New passwords do not match"); return; }
    run(async () => {
      const res = await patientPortalResetPassword(resetToken, next, confirm);
      toast.success(res?.message || "Password reset. Please sign in with your new password.");
      onDone?.();
    });
  };

  const stepNumber = { login: 1, otp: 2, password: 3 }[step];
  const label = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400";

  return (
    <div className="space-y-3" data-testid="patient-portal-forgot-flow">
      <div>
        <p className="text-sm font-semibold text-slate-800">Reset your password</p>
        <p className="text-[11px] text-slate-400">Step {stepNumber} of 3</p>
      </div>

      {step === "login" && (
        <form onSubmit={sendCode} className="space-y-3">
          <div>
            <label className={label}>Phone number or Email</label>
            <Input
              type="text"
              autoComplete="username"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="98765 43210 or you@example.com"
              className="h-9 text-sm"
              data-testid="patient-portal-forgot-login"
            />
          </div>
          <p className="text-[11px] text-slate-500">We'll email a 6-digit code to the email address on your portal login.</p>
          <Button type="submit" className="w-full bg-sky-600 text-white hover:bg-sky-700" disabled={busy} data-testid="patient-portal-forgot-send">
            {busy ? "Sending..." : "Send Code"}
          </Button>
        </form>
      )}

      {step === "otp" && (
        <form onSubmit={verifyCode} className="space-y-3">
          <p className="rounded-md bg-sky-50 px-3 py-2 text-[11px] text-sky-700">{sentMessage}</p>
          <div>
            <label className={label}>6-digit code</label>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              className="h-10 text-center text-lg tracking-[0.5em]"
              data-testid="patient-portal-forgot-otp"
            />
          </div>
          <Button type="submit" className="w-full bg-sky-600 text-white hover:bg-sky-700" disabled={busy} data-testid="patient-portal-forgot-verify">
            {busy ? "Checking..." : "Verify Code"}
          </Button>
          <div className="flex items-center justify-between text-xs">
            <button type="button" onClick={() => setStep("login")} className="font-medium text-slate-500">
              Change phone / email
            </button>
            <button
              type="button"
              onClick={() => sendCode()}
              disabled={busy || cooldown > 0}
              className="font-medium text-sky-600 disabled:text-slate-400"
              data-testid="patient-portal-forgot-resend"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </div>
        </form>
      )}

      {step === "password" && (
        <form onSubmit={savePassword} className="space-y-3">
          <div>
            <label className={label}>New password</label>
            <Input type={show ? "text" : "password"} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="h-9 text-sm" data-testid="patient-portal-forgot-new" />
          </div>
          <div>
            <label className={label}>Confirm new password</label>
            <Input type={show ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 text-sm" data-testid="patient-portal-forgot-confirm" />
          </div>
          <button type="button" onClick={() => setShow((v) => !v)} className="flex items-center gap-1 text-[11px] font-medium text-slate-500">
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {show ? "Hide passwords" : "Show passwords"}
          </button>
          <p className="text-[10px] text-slate-400">
            At least {PORTAL_PASSWORD_MIN} characters. Family members on this login get the new password too, and everyone is signed out.
          </p>
          <Button type="submit" className="w-full bg-sky-600 text-white hover:bg-sky-700" disabled={busy} data-testid="patient-portal-forgot-save">
            {busy ? "Saving..." : "Reset Password"}
          </Button>
        </form>
      )}

      <Button type="button" variant="ghost" size="sm" className="w-full text-xs text-slate-500" onClick={onCancel} disabled={busy}>
        Back
      </Button>
    </div>
  );
}

function ProfileTab({ data }) {
  const Row = ({ label, value }) => (
    !value ? null : (
      <div>
        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <p className="text-xs text-slate-700">{value}</p>
      </div>
    )
  );

  return (
    <div className="space-y-4" data-testid="patient-portal-profile-tab">
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Your Details</p>
        <div className="grid grid-cols-2 gap-3">
          <Row label="Patient Number" value={data.patient_number} />
          <Row label="Phone" value={data.phone} />
          <Row label="Email" value={data.email} />
          <Row label="Age" value={data.age} />
          <Row label="Gender" value={data.gender} />
          <Row label="Occupation" value={data.occupation} />
          <Row label="Address" value={data.address} />
          <Row label="City / State" value={[data.city, data.state].filter(Boolean).join(", ")} />
          <Row label="Condition" value={data.condition} />
        </div>
      </div>

      {(data.head_physio_name || data.physio_name) && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Your Care Team</p>
          <div className="space-y-2">
            {/* Deliberately no call/contact action here for the Head Physio — name only. */}
            <Row label="CONSULTANT" value={data.head_physio_name} />
            <Row label="Physio" value={data.physio_name} />
          </div>
        </div>
      )}

      {/* The Consultant's review schedule. On Overview because it is the one thing a
          client checks between visits — when their next review falls and what came out
          of the last one — and Overview is where they land. */}
      <ReviewRecordCard reviews={data.reviews} />

      <PatientDocuments />

      {(data.branch_name || data.branch_phone) && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-600">Your Branch</p>
          <p className="text-sm font-semibold text-slate-800">{data.branch_name}</p>
          {data.branch_address && <p className="mt-0.5 text-xs text-slate-600">{data.branch_address}</p>}
          {data.branch_phone && (
            <Button
              size="sm"
              className="mt-2 bg-sky-600 text-xs text-white hover:bg-sky-700"
              onClick={() => { window.location.href = `tel:${data.branch_phone.replace(/[^0-9+]/g, "")}`; }}
              data-testid="patient-portal-call-branch"
            >
              <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Call Branch
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Overview leads: it is the patient's own details, care team, documents and branch —
// what they are looking at when they first open the app — and the three after it answer
// "how is my treatment going", which is the follow-up.
//
// `short` is the phone label. Four full labels cannot share a phone's width once one of
// them is "Payment History": at 360px each tab gets about 85px, and that label needs
// well over a hundred. Truncating gives "Payment Hist…", wrapping makes that one tab
// two lines tall and pushes the bar off the bottom of the screen. Shortening is the only
// option that keeps all four readable in one row. `label` is what the desktop shows.
const PORTAL_TABS = [
  { key: "profile", label: "Overview", short: "Overview", icon: UserRound },
  { key: "sessions", label: "Sessions", short: "Sessions", icon: Calendar },
  { key: "treatment", label: "Treatment", short: "Treatment", icon: ClipboardList },
  { key: "payment", label: "Payment History", short: "Payments", icon: IndianRupee },
  // Last, because it is the one tab a patient comes to say something rather than to look
  // something up. "Feedback" fits at 360px, so short and label are the same word.
  { key: "feedback", label: "Feedback", short: "Feedback", icon: MessageSquareHeart },
];

/**
 * Talk to Management — the client's chat with the people who answer for their care.
 *
 * The client picks one of Super Admin, Branch Admin and their Consultant at a time. Each is
 * its own conversation (the Branch Admin never sees what went to Super Admin), with its own
 * chat and message box. Super Admin takes only SUPER_ADMIN_MESSAGE_LIMIT messages in all.
 */
// Mirrors SUPER_ADMIN_MESSAGE_LIMIT in backend/routers/v3_patient_portal.py.
const SUPER_ADMIN_MESSAGE_LIMIT = 2;

const feedbackTo = (consultantName, hasConsultantThreads) => [
  {
    key: "super_admin",
    label: "Super Admin",
    who: "Head chief · Sumaiya Naaz",
    blurb: "Super Admin: something serious, or about the branch itself — your branch does not see it.",
  },
  {
    key: "branch_admin",
    label: "Branch Admin",
    who: "My branch",
    blurb: "Branch Admin: anything about the branch, your appointments or your bill.",
  },
  ...((consultantName || hasConsultantThreads) ? [{
    key: "consultant",
    label: "Consultant",
    who: consultantName || "Your consultant",
    blurb: `Consultant: about your treatment — goes to ${consultantName || "your consultant"} directly.`,
  }] : []),
];

const feedbackSentOn = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** The thread a new message to one side belongs to, or nothing if it starts one. Rows
    arrive newest first, so this is the most recent one still open. */
const openThreadOf = (rows) => rows.find((f) => (f.status || "new") !== "resolved") || null;

const audienceOf = (f) => f.audience || "branch_admin";

/** Every message on the chosen sides, oldest first. One message the client sent to several
    sides at once is stored once per side; it is drawn once, naming everyone it went to. */
const mergedMessages = (rows) => {
  const all = rows
    .flatMap((f) => (f.messages || []).map((m) => ({ ...m, sides: [audienceOf(f)] })))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const out = [];
  all.forEach((m) => {
    const twin = m.author === "patient" && out.find((o) => o.author === "patient"
      && o.body === m.body
      && !o.sides.includes(m.sides[0])
      && Math.abs(new Date(o.created_at) - new Date(m.created_at)) < 60000);
    if (twin) twin.sides.push(m.sides[0]);
    else out.push(m);
  });
  return out;
};

/** One chosen person's own conversation and message box inside Talk to Management. */
function PersonChat({ audience, name, rows, draft, onDraft, sending, onAnswer, remaining = null }) {
  const limitReached = remaining !== null && remaining <= 0;
  const endRef = useRef(null);
  const chatRef = useRef(null);
  // How tall three messages happen to be, once they are on screen.
  const [chatMax, setChatMax] = useState(null);
  const messages = mergedMessages(rows);
  const askedRows = rows.filter((f) => (f.status || "new") === "awaiting_patient");

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  // Three messages showing, the rest scrolled — measured, since bubbles run one to five lines.
  useLayoutEffect(() => {
    const box = chatRef.current;
    if (!box) return undefined;
    const measure = () => {
      const items = Array.from(box.children).filter((el) => el !== endRef.current);
      if (items.length <= 3) { setChatMax(null); return; }
      const GAP = 8;      // space-y-2
      const PADDING = 24; // p-3, top and bottom
      const last = items.slice(-3);
      const next = Math.ceil(
        last.reduce((total, el) => total + el.offsetHeight, 0) + GAP * (last.length - 1) + PADDING,
      );
      setChatMax((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [messages.length]);

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3" data-testid={`portal-feedback-person-${audience.key}`}>
      <div>
        <p className="text-xs font-bold text-slate-700">{audience.label}</p>
        <p className="text-[11px] leading-snug text-slate-500">{audience.blurb}</p>
        {remaining !== null && (
          <p
            className={`mt-1 text-[11px] font-semibold ${limitReached ? "text-rose-600" : "text-amber-700"}`}
            data-testid="portal-feedback-super-limit"
          >
            {limitReached
              ? `You have sent your ${SUPER_ADMIN_MESSAGE_LIMIT} messages to Super Admin. Please write to your Branch Admin.`
              : `You can send ${SUPER_ADMIN_MESSAGE_LIMIT} messages to Super Admin in all — ${remaining} left.`}
          </p>
        )}
      </div>

      {messages.length > 0 && (
        <div
          ref={chatRef}
          className="max-h-80 space-y-2 overflow-y-auto rounded-lg bg-slate-50/80 p-3"
          style={chatMax ? { maxHeight: chatMax } : undefined}
          data-testid={`portal-feedback-chat-${audience.key}`}
        >
          {messages.map((m) => {
            const own = m.author === "patient";
            const who = own ? "You" : (m.author_name || name);
            return (
              <div key={m.id} className={`flex ${own ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${own ? "bg-sky-600 text-white" : "bg-white text-slate-700 shadow-sm"}`}>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5">{m.body}</p>
                  <p className={`mt-0.5 text-[10px] ${own ? "text-sky-100" : "text-slate-400"}`}>
                    {[who, feedbackSentOn(m.created_at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {askedRows.map((row) => (
        <div key={row.id} className="rounded-lg border border-violet-200 bg-violet-50/70 p-3" data-testid="portal-feedback-asked">
          <p className="text-[11px] font-semibold text-violet-900">{name} asked: has this sorted it?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              className="h-7 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700"
              disabled={sending}
              onClick={() => onAnswer(row, true)}
              data-testid="portal-feedback-yes"
            >
              Yes, all sorted
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-slate-200 px-2 text-[11px]"
              disabled={sending}
              onClick={() => onAnswer(row, false)}
              data-testid="portal-feedback-no"
            >
              Not yet
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-violet-700/70">Write a line below first if you want to say why.</p>
        </div>
      ))}

      <div>
        <textarea
          rows={3}
          value={draft}
          maxLength={2000}
          onChange={(e) => onDraft(e.target.value)}
          disabled={limitReached}
          placeholder={limitReached ? "Message limit reached" : `Message to ${name}…`}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-50"
          data-testid={`portal-feedback-message-${audience.key}`}
        />
        <p className="mt-0.5 text-right text-[10px] text-slate-400">{draft.length}/2000</p>
      </div>
    </div>
  );
}

function FeedbackTab({ data, onSeen }) {
  // One draft per person, so switching between people keeps what was written to each.
  const [drafts, setDrafts] = useState({});
  // One person at a time; null when none is chosen.
  const [selected, setSelected] = useState("branch_admin");
  const [sending, setSending] = useState(false);
  const [mine, setMine] = useState([]);

  const loadMine = useCallback(() => {
    patientPortalMyFeedback()
      .then((data) => {
        setMine(data?.feedback || []);
        // The GET just stamped every thread seen server-side; drop the bottom-nav badge.
        onSeen?.();
      })
      .catch(() => { /* the conversation is a courtesy; sending works without it */ });
  }, [onSeen]);
  useEffect(() => { loadMine(); }, [loadMine]);

  const consultantName = (data?.feedback_consultant_name || "").trim();
  const hasConsultantThreads = mine.some((f) => f.audience === "consultant");
  const canWriteToConsultant = Boolean(consultantName || hasConsultantThreads);
  const audiences = feedbackTo(consultantName, hasConsultantThreads);
  const nameOf = (key) => (key === "consultant" ? (consultantName || "Your consultant")
    : key === "super_admin" ? "Super Admin" : "Branch Admin");

  // Nothing points at a Consultant card that is no longer on screen.
  useEffect(() => {
    if (!canWriteToConsultant && selected === "consultant") setSelected(null);
  }, [canWriteToConsultant, selected]);

  // Tapping the chosen card again unticks it.
  const toggle = (key) => setSelected((cur) => (cur === key ? null : key));

  // Each change of who is chosen fetches the latest of that conversation.
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) { firstSelection.current = false; return; }
    loadMine();
  }, [selected, loadMine]);

  const setDraft = (key, value) => setDrafts((d) => ({ ...d, [key]: value }));
  const chosen = audiences.find((a) => a.key === selected) || null;
  const superSent = mine
    .filter((f) => audienceOf(f) === "super_admin")
    .reduce((n, f) => n + (f.messages || []).filter((m) => m.author === "patient").length, 0);
  const superRemaining = Math.max(0, SUPER_ADMIN_MESSAGE_LIMIT - superSent);
  const remainingFor = (key) => (key === "super_admin" ? superRemaining : null);
  const body = chosen ? (drafts[chosen.key] || "").trim() : "";
  const canSend = Boolean(chosen && body && !(chosen.key === "super_admin" && superRemaining <= 0));

  const waiting = (key) => mine.some(
    (f) => audienceOf(f) === key && (f.status || "new") === "awaiting_patient",
  );

  // The message goes to the one chosen person: into their open conversation, or starting one.
  const sendMessage = async () => {
    if (!canSend) return;
    const key = chosen.key;
    setSending(true);
    try {
      const open = openThreadOf(mine.filter((f) => audienceOf(f) === key));
      if (open) await patientPortalReplyFeedback(open.id, { body });
      else await patientPortalSubmitFeedback({ message: body, audience: key });
      setDraft(key, "");
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Could not send to ${nameOf(key)}. Please try again.`);
    } finally {
      setSending(false);
      loadMine();
    }
  };

  // "Has this sorted it?" is answered on the one conversation that asked, with that person's draft.
  const answer = async (row, resolved) => {
    const key = audienceOf(row);
    setSending(true);
    try {
      await patientPortalReplyFeedback(row.id, { body: (drafts[key] || "").trim(), resolved });
      setDraft(key, "");
      loadMine();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send that. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card data-testid="portal-feedback">
      <CardContent className="space-y-4 p-5">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <MessageSquareHeart className="h-4 w-4 text-sky-500" />Talk to Management
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Chat with the management. Pick one person to send to.</p>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Send to (choose one)</p>
          <div className={`grid gap-2 ${audiences.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`} data-testid="portal-feedback-audience">
            {audiences.map((a) => {
              const on = selected === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => toggle(a.key)}
                  aria-pressed={on}
                  className={`relative flex items-start gap-2 rounded-lg border p-3 text-left transition ${on ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500" : "border-slate-200 bg-white hover:border-sky-300"}`}
                  data-testid={`portal-feedback-to-${a.key}`}
                >
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300 bg-white"}`}>
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-xs font-bold ${on ? "text-sky-700" : "text-slate-700"}`}>{a.label}</span>
                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400">{a.who}</span>
                  </span>
                  {waiting(a.key) && !on && (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-violet-500" data-testid={`portal-feedback-dot-${a.key}`} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {chosen && (
          <PersonChat
            key={chosen.key}
            audience={chosen}
            name={nameOf(chosen.key)}
            rows={mine.filter((f) => audienceOf(f) === chosen.key)}
            draft={drafts[chosen.key] || ""}
            onDraft={(value) => setDraft(chosen.key, value)}
            sending={sending}
            onAnswer={answer}
            remaining={remainingFor(chosen.key)}
          />
        )}

        <Button
          className="w-full"
          disabled={sending || !canSend}
          onClick={sendMessage}
          data-testid="portal-feedback-submit"
        >
          {sending ? "Sending…" : chosen ? `Send to ${nameOf(chosen.key)}` : "Send"}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Five tappable stars. Tapping the chosen star again clears it. */
function StarPicker({ value, onChange, testid, size = "h-7 w-7" }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" data-testid={testid}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          onClick={() => onChange && onChange(value === n ? null : n)}
          disabled={!onChange}
          className="p-0.5"
          data-testid={`${testid}-${n}`}
        >
          <Star className={`${size} transition ${value && n <= value ? "fill-amber-400 text-amber-400" : "text-slate-300 hover:text-amber-300"}`} />
        </button>
      ))}
    </div>
  );
}

const STAR_WORDS = { 1: "Poor", 2: "Not great", 3: "Okay", 4: "Good", 5: "Excellent" };

const inputBox = "w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400";

/** Stars and words, and a button to save them. `onSubmit(rating, comment)` returns the
    server's answer; the form clears itself only on success. */
function ReviewForm({ initial = null, placeholder, submitLabel = "Submit review", onSubmit, onDone, testid }) {
  const [rating, setRating] = useState(initial?.rating || null);
  const [comment, setComment] = useState(initial?.comment || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!rating) { toast.error("Tap the stars to give a rating"); return; }
    setSaving(true);
    try {
      const res = await onSubmit(rating, comment);
      toast.success(res?.message || "Thank you for your review.");
      if (!initial) { setRating(null); setComment(""); }
      onDone?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save your review. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        <StarPicker value={rating} onChange={setRating} testid={`${testid}-stars`} />
        {rating && <span className="text-xs font-semibold text-amber-600">{STAR_WORDS[rating]}</span>}
      </div>
      <textarea
        rows={3}
        maxLength={2000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={placeholder || "Tell us more (optional)"}
        className={inputBox}
        data-testid={`${testid}-comment`}
      />
      <Button className="w-full" disabled={saving || !rating} onClick={save} data-testid={`${testid}-submit`}>
        {saving ? "Saving…" : initial ? "Update review" : submitLabel}
      </Button>
    </div>
  );
}

/** The Review pop-up. Without `onClose` it cannot be dismissed — that is the required one.
    `underNav` sits it beneath the bottom nav, so a required pop-up holds the tab it is on
    without locking the client out of the others. */
function ReviewDialog({ title, subtitle, onClose, children, footer, testid, underNav = false }) {
  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-slate-900/60 p-4 ${underNav ? "z-30 pb-20" : "z-[60]"}`}
      onClick={onClose || undefined}
      data-testid={testid}
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />{title}
            </p>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {children}
        {footer}
      </div>
    </div>,
    document.body,
  );
}

/** The Review button on a row: grey until there is something to review, amber while a
    review is due, and the client's stars once given (tap to change them). */
function ReviewChip({ state, rating, label, required, onClick, testid }) {
  const base = "relative inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition";
  const look = state === "done" ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
    : state === "due" ? "border-amber-400 bg-amber-400 text-white hover:bg-amber-500"
    : "cursor-not-allowed border-slate-200 bg-white text-slate-300";
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={`${base} ${look}`}
      title={state === "locked" ? "You can review once it is completed" : undefined}
      data-testid={testid}
    >
      <Star className={`h-3 w-3 ${state === "done" ? "fill-amber-400 text-amber-400" : ""}`} />
      {label || (state === "done" ? `${rating}/5` : "Review")}
      {state === "due" && required && (
        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-rose-500" />
      )}
    </button>
  );
}

const weekTitle = (w) => `${w.track === "rehab" ? "Rehab " : ""}Week ${w.week_number}`;

const weekRange = (w) => {
  if (w.first_number == null) return "";
  const noun = w.track === "rehab" ? "Rehab Days" : "Sessions";
  return w.first_number === w.last_number ? `${noun.replace(/s$/, "")} ${w.first_number}` : `${noun} ${w.first_number}–${w.last_number}`;
};

/** The client's saved Physio review for one week, if any. */
const savedForWeek = (reviews, w) => (reviews?.week_reviews || []).find(
  (r) => r.kind === "physio" && r.track === w.track && r.week_number === w.week_number,
);

/** Every 7 days of treatment: the Physio's star rating and the client's Treatment Feedback,
    each in its own box. Both are required of a review that is sent — but sending one at all
    is not: `onSkip` adds Skip beside Submit, which the pop-up that opens by itself offers. */
function WeekReviewForm({ week, reviews, onDone, onSkip, testid }) {
  const saved = savedForWeek(reviews, week);
  const physioName = week.physio_name || reviews?.physio?.name || "";
  const [rating, setRating] = useState(saved?.rating || null);
  const [comment, setComment] = useState(saved?.comment || "");
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const ready = !!rating && !!comment.trim();

  const skip = async () => {
    setSkipping(true);
    try {
      const res = await patientPortalSkipWeekReview({ track: week.track, week_number: week.week_number });
      toast.success(res?.message || "Skipped. You can review this week any time from Sessions.");
      onSkip?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not skip this review. Please try again.");
    } finally {
      setSkipping(false);
    }
  };

  const save = async () => {
    if (!rating) { toast.error("Tap the stars to rate your physio"); return; }
    if (!comment.trim()) { toast.error("Write your Treatment Feedback"); return; }
    setSaving(true);
    try {
      const res = await patientPortalReviewWeek({ track: week.track, week_number: week.week_number, rating, comment });
      toast.success(res?.message || "Thank you for your review.");
      onDone?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save your review. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const box = "space-y-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3";
  const heading = "text-[11px] font-semibold uppercase tracking-wide text-slate-500";
  return (
    <div className="space-y-3" data-testid={testid}>
      <div className={box} data-testid={`${testid}-rating`}>
        <p className={heading}>
          Star Rating{physioName ? <span className="font-normal normal-case tracking-normal text-slate-400"> · {physioName}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StarPicker value={rating} onChange={setRating} testid={`${testid}-stars`} />
          {rating && <span className="text-xs font-semibold text-amber-600">{STAR_WORDS[rating]}</span>}
        </div>
      </div>
      <div className={box} data-testid={`${testid}-feedback`}>
        <p className={heading}>Treatment Feedback</p>
        <textarea
          rows={4}
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="How was your treatment this week?"
          className={`${inputBox} bg-white`}
          data-testid={`${testid}-comment`}
        />
      </div>
      <Button className="w-full" disabled={saving || skipping || !ready} onClick={save} data-testid={`${testid}-submit`}>
        {saving ? "Saving…" : saved ? "Update review" : "Submit review"}
      </Button>
      {onSkip && (
        <Button
          variant="ghost"
          className="w-full text-xs text-slate-500 hover:text-slate-700"
          disabled={saving || skipping}
          onClick={skip}
          data-testid={`${testid}-skip`}
        >
          {skipping ? "Skipping…" : "Skip for now"}
        </Button>
      )}
    </div>
  );
}

/** The Review button on the Session History row of a week's last day (e.g. Session 7).
    Appears only once every day in that week is completed: amber while not yet reviewed,
    then "Reviewed" (tap to change it). Opens the Physio review pop-up.
    Nothing without `reviews`: the staff preview of this tab draws the days alone. */
function WeekReviewButton({ track, number, reviews, onReviewed }) {
  const [open, setOpen] = useState(false);
  if (!reviews || number == null) return null;
  const week = (reviews.weeks || []).find((w) => w.track === track && w.complete && w.last_number === number);
  if (!week) return null;
  const done = !!savedForWeek(reviews, week);
  const testid = `portal-week-review-${track}-${week.week_number}`;
  return (
    <>
      <ReviewChip
        state={done ? "done" : "due"}
        label={done ? "Reviewed" : `Review ${weekTitle(week)}`}
        testid={`${testid}-button`}
        onClick={() => setOpen(true)}
      />
      {open && (
        <ReviewDialog
          title={`Review ${weekTitle(week)}`}
          subtitle={`${weekRange(week)} · rate your physio`}
          onClose={() => setOpen(false)}
          testid={`${testid}-dialog`}
        >
          <WeekReviewForm
            week={week}
            reviews={reviews}
            testid={`${testid}-form`}
            onDone={() => { setOpen(false); onReviewed?.(); }}
          />
        </ReviewDialog>
      )}
    </>
  );
}

/** The Review pop-up that opens by itself on the Sessions tab once a week of treatment is
    completed and not yet reviewed. Not mandatory: Skip closes it for good on that week and
    releases the Physio's Send to Review, and the week's own Review button on the Session
    History row still opens it whenever the client changes their mind. Closing it with the X
    dismisses it for this visit only — it is back the next time they open Sessions. It sits
    under the bottom nav, so the client can always leave for another tab. */
function WeekReviewGate({ reviews, onChanged }) {
  const pending = reviews?.weeks_pending || [];
  // Keyed on the week, so dismissing one and finishing it still lets the next week ask.
  const [dismissed, setDismissed] = useState(null);
  const week = pending[0];
  if (!week) return null;
  const key = `${week.track}-${week.week_number}`;
  if (dismissed === key) return null;

  return (
    <ReviewDialog
      title={`Review ${weekTitle(week)}`}
      subtitle={`${weekRange(week) ? `${weekRange(week)} completed. ` : ""}How was your week? Rate your physio${pending.length > 1 ? ` — ${pending.length} weeks are waiting` : ""}.`}
      onClose={() => setDismissed(key)}
      underNav
      testid="portal-week-review-gate"
    >
      <WeekReviewForm
        key={key}
        week={week}
        reviews={reviews}
        testid="portal-week-review-gate-form"
        onDone={onChanged}
        onSkip={onChanged}
      />
    </ReviewDialog>
  );
}

function PortalDashboard({ onLogout, onSwitchPatient }) {
  // Lands on Overview, the first tab. A patient opening the app is most often checking
  // who they are with and when — not scrolling a session list they already know.
  const [activeTab, setActiveTab] = useState("profile");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await patientPortalMe());
    } catch (err) {
      setError(err?.response?.data?.detail || "Unable to load your records");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Physio Review and Consultant Review. Loaded with the dashboard, not the tab, because an
  // unrated physio day holds the client on a pop-up wherever they land.
  const [reviews, setReviews] = useState(null);
  const loadReviews = useCallback(() => {
    patientPortalMyReview().then(setReviews).catch(() => setReviews(null));
  }, []);
  // Refetched each time Overview or Sessions opens, so a week finished or skipped since the
  // app was opened shows up there without a reload.
  useEffect(() => {
    if (activeTab === "profile" || activeTab === "sessions") loadReviews();
  }, [loadReviews, activeTab]);

  // Opening the Feedback tab reads its replies (the GET stamps them seen), so the
  // bottom-nav badge should clear the moment they land there rather than lag a reload.
  const clearFeedbackBadge = useCallback(() => {
    setData((d) => (d && d.feedback_unread ? { ...d, feedback_unread: 0 } : d));
  }, []);

  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-slate-400">Loading...</p></div>;
  if (error || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-rose-500">{error || "Unable to load your records"}</p>
        <Button variant="outline" onClick={onLogout}>Sign In Again</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20" data-testid="patient-portal-dashboard">
      <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
              {data.patient_name?.charAt(0)?.toUpperCase()}
            </div>
            <div>
              <h1 className="text-sm font-semibold text-slate-800">{data.patient_name}</h1>
              <p className="text-[10px] text-sky-600">FitsiomaxOS Client Portal</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onSwitchPatient && (
              <Button variant="outline" size="sm" onClick={onSwitchPatient} data-testid="patient-portal-switch-patient">
                <Users className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Switch patient</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onLogout} data-testid="patient-portal-logout">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {activeTab === "sessions" && <SessionsTab data={data} reviews={reviews} onReviewed={loadReviews} />}
        {activeTab === "treatment" && <TreatmentTab data={data} reviews={reviews} onReviewed={loadReviews} />}
        {activeTab === "payment" && <PaymentTab data={data} onChanged={load} />}
        {activeTab === "profile" && <ProfileTab data={data} />}
        {activeTab === "feedback" && (
          <FeedbackTab data={data} onSeen={clearFeedbackBadge} />
        )}
      </div>

      {/* Sessions tab only — the review lives there, beside the week's last day. */}
      {activeTab === "sessions" && <WeekReviewGate reviews={reviews} onChanged={loadReviews} />}

      {/* Unlike every other bottom nav in the OS this one has no md:hidden — the portal
          shows it at all widths — so the slate is reverted from md up rather than applied
          outright, keeping the desktop bar white as it was. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 md:border-slate-200 md:bg-white" data-testid="patient-portal-bottom-nav">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {PORTAL_TABS.map((t) => {
            const Icon = t.icon;
            const isActive = activeTab === t.key;
            // Only the Feedback tab carries one today: how many threads the clinic has
            // written back on since this patient last opened it. Clears on open — see
            // clearFeedbackBadge and patient_portal_my_feedback's seen stamp.
            const badge = t.key === "feedback" ? (data.feedback_unread || 0)
              : t.key === "sessions" ? (reviews?.weeks_pending?.length || 0) : 0;
            // On a phone, the same slot as the staff boards' BottomNavTab: glyph in a chip
            // that lights on the open tab, its name at 0.55rem beneath. From md up every
            // md: class puts back the white desktop bar exactly as it was.
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 pb-1.5 pt-1 text-[0.55rem] leading-tight transition md:px-0 md:py-2.5 md:text-[10px] md:font-medium md:leading-normal ${isActive ? "font-semibold text-white md:text-sky-600" : "font-medium text-slate-200 md:text-slate-400"}`}
                data-testid={`patient-portal-tab-${t.key}`}
              >
                <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full md:h-auto md:w-auto md:bg-transparent ${isActive ? "bg-white/20" : ""}`}>
                  <Icon className="h-5 w-5 shrink-0" />
                  {badge > 0 && (
                    <span
                      className="absolute right-0 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-slate-500 bg-rose-500 px-1 text-[9px] font-bold leading-none text-white md:-right-2.5 md:-top-1.5 md:border-white"
                      data-testid={`patient-portal-tab-badge-${t.key}`}
                    >
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </span>
                {/* min-w-0 above and truncate here so a long label shortens instead of
                    forcing its tab wider and squeezing the other three. */}
                <span className="w-full truncate px-0.5 text-center sm:hidden">{t.short}</span>
                <span className="hidden w-full truncate px-0.5 text-center sm:inline">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
