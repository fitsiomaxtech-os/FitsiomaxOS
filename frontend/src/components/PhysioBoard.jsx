import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CalendarX,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Eye,
  FileText,
  RefreshCw,
  Search,
  Send,
  Star,
  UserCircle,
  Users,
  UserX,
  X,
  Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { ProgressionTab } from "@/components/ProgressionTab";
import { LeadMarks } from "@/components/ui/lead-marks";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { StatTile } from "@/components/ui/stat-tile";
import { NotifyCard } from "@/components/ui/notify-card";
import { PhysioTreatmentChips } from "@/components/ui/physio-treatment-chips";
import { DocumentPreview, useDocumentPreview } from "@/components/ui/document-preview";
import { MyProfilePage } from "@/components/MyProfilePage";
import { ProfileNavGlyph } from "@/components/ui/employee-avatar";
import { BottomNavTab } from "@/components/ui/bottom-nav-tab";
import { SESSION_PAYMENT_REFRESH_EVENT } from "@/components/SessionPaymentBell";
import { PhysioAbsencePanel } from "@/components/PhysioAbsencePanel";
import {
  physioConsultations,
  physioCompleteConsultation,
  physioCalendar,
  physioPatients,
  physioPatientDetail,
  physioSessions,
  physioCompleteSession,
  physioMarkAbsent,
  physioReviews,
  physioRaiseReview,
  leadDocuments,
  openLeadDocument,
  getPhysioTypes,
} from "@/lib/api";
import { to12h, slotTo12h } from "@/lib/time";

// A patient's contact details are not printed anywhere on this board, and the physio
// cannot reach a patient from it either. The Patients list used to carry the number with
// Call and WhatsApp buttons beside it; that whole column is gone — the physio works from
// the name, the patient number and the course, and the number stays with the branch.
// Don't add phone, alternative phone or email back to a row, a popup, a search box or a
// dial button here; Branch Admin and Pre-Sales are where those are read and called.
//
// The board's three views, rendered twice: an underlined strip along the top on a
// desk, a fixed bar at the bottom on a phone. Treatment and Patients keep their old
// icons; Review takes the slot Calendar used to hold — Calendar moved to the
// top-right page button instead, alongside Profile on the top-left.
const VIEW_TABS = [
  { key: "treatment", label: "Treatment", icon: ClipboardList },
  // The same day board as Treatment, holding only the patients booked as a House Visit —
  // the physio goes to them. Treatment stops listing those patients.
  { key: "home_visit", label: "House Visit", icon: Home },
  { key: "review", label: "Send to Review", icon: ClipboardCheck },
  { key: "patients", label: "Patients", icon: Users },
  // The physio's own days off, and handing the patients booked on them to a colleague.
  { key: "absence", label: "Absence", icon: CalendarX },
];

/**
 * A fourth stop on the phone's bar only: My Profile, after Patients.
 *
 * It is not a board view, which is why it is kept out of VIEW_TABS — on a desk the same
 * page is one tap away in the header, beside Calendar and Logout, and a desk has the room
 * for it there. A phone header does not, so the bar carries it.
 *
 * The bar is glyphs from here on, all four of them. "Send to Review" wrapped to two lines
 * at three tabs across a 325px screen; a fourth column makes every label either wrap or
 * clip, and a label clipped to four characters says less than the icon over it does. Each
 * button keeps its words in title/aria-label, so the name is still there for a long press
 * and still read out by a screen reader.
 */
const PROFILE_TAB = { key: "profile", label: "My Profile", icon: UserCircle };
const BOTTOM_TABS = [...VIEW_TABS, PROFILE_TAB];

// `onLogout` puts Logout on My Profile's Security tab, the phone header having none.
export const PhysioBoard = ({ physioId, user, roleLabel, onLogout } = {}) => {
  const [activeTab, setActiveTab] = useState("treatment");
  // Absence is marked by the physio for themselves. A desk driving somebody else's board
  // from Operations marks it from Branch Admin > Management > Physio Absence instead.
  const viewTabs = physioId ? VIEW_TABS.filter((t) => t.key !== "absence") : VIEW_TABS;
  // Counts shown on both switchers — every one of them is what's still
  // outstanding, so it counts down as the physio works through it rather than
  // holding at a fixed total: Treatment is today's pending sessions/appointments
  // (the date filter defaults to Today already), Review is patients newly due (drops
  // off the moment one is raised), Patients is who's still ongoing. All three tabs
  // stay mounted (hidden via CSS, not unmounted) so every badge stays live even
  // while another tab is the one showing.
  const [treatmentCount, setTreatmentCount] = useState(0);
  const [homeVisitCount, setHomeVisitCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [patientsCount, setPatientsCount] = useState(0);
  const badgeFor = { treatment: treatmentCount, home_visit: homeVisitCount, review: reviewCount, patients: patientsCount };

  // Where the open tab's search and date filter render. A callback ref rather than
  // useRef: the node has to arrive as state so the tabs re-render once it exists,
  // otherwise the first paint sees null and nothing ever portals in.
  const [toolbarSlot, setToolbarSlot] = useState(null);
  // Only the tab on screen gets the slot. All three stay mounted, so handing it to
  // every tab would stack three toolbars in the one row.
  const slotFor = (key) => (activeTab === key ? toolbarSlot : null);

  return (
    <div className="space-y-3 pb-20 md:pb-0" data-testid="physio-board-root">
      {/* Tabs on the left, the open tab's search and date filter on the right. The
          strip is desk-only — a phone gets the fixed bar at the end of this file —
          but the toolbar slot is not, so on a phone this row is just the toolbar,
          which is why the border and the tab baseline are both md-only.

          The filled-pill tabs Human Resource uses, so moving between boards doesn't
          mean learning a second way to switch view. The counts come along rather
          than being dropped on desktop: an outstanding count is the reason to look
          at a tab you aren't already on — on the selected pill it goes white-on-indigo,
          since a slate badge on a filled tab reads as disabled. */}
      <div className={`flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4 md:border-b md:border-slate-200 md:pb-2 ${activeTab === "profile" ? "hidden md:flex" : "flex"}`} data-testid="physio-view-bar">
      <div className="hidden flex-wrap items-center gap-2 overflow-x-auto md:flex" data-testid="physio-view-tabs">
        {viewTabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          const count = badgeFor[tab.key] || 0;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition ${
                active ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
              data-testid={`physio-view-tab-${tab.key}`}
            >
              <Icon className="h-4 w-4" /> {tab.label}
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"}`}
                  data-testid={`physio-view-tab-badge-${tab.key}`}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          );
        })}
      </div>
        <div ref={setToolbarSlot} className="flex flex-wrap items-center gap-2 md:pb-1.5" data-testid="physio-view-toolbar" />
      </div>

      <div style={{ display: activeTab === "treatment" ? "block" : "none" }}>
        <TreatmentTab physioId={physioId} scope="exclude_home" onCountChange={setTreatmentCount} toolbarSlot={slotFor("treatment")} />
      </div>
      <div style={{ display: activeTab === "home_visit" ? "block" : "none" }}>
        <TreatmentTab physioId={physioId} scope="home" onCountChange={setHomeVisitCount} toolbarSlot={slotFor("home_visit")} />
      </div>
      <div style={{ display: activeTab === "review" ? "block" : "none" }}>
        <ReviewTab physioId={physioId} onCountChange={setReviewCount} toolbarSlot={slotFor("review")} />
      </div>
      <div style={{ display: activeTab === "patients" ? "block" : "none" }}>
        <PatientsTab physioId={physioId} onCountChange={setPatientsCount} toolbarSlot={slotFor("patients")} />
      </div>
      {!physioId && activeTab === "absence" && <PhysioAbsencePanel mode="physio" />}

      {/* My Profile stands in the board's place rather than over it, so the bar below stays
          put and Treatment takes the physio straight back — the page is left the way every
          other one here is, by going somewhere else. Mounted only while it is the tab: it
          reads a month of attendance, which is not a request to make for a tab nobody
          opened. */}
      {activeTab === "profile" && (
        <MyProfilePage user={user} roleLabel={roleLabel} onBack={() => setActiveTab("treatment")} onLogout={onLogout} phoneBar timeOffInHeader={!physioId} />
      )}

      {/* Phones only. It used to render at every width, so a desk got a bar pinned
          across the bottom of the window for a switcher that belongs at the top. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="physio-bottom-nav">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {(physioId ? BOTTOM_TABS.filter((t) => t.key !== "absence") : BOTTOM_TABS).map((tab) => {
            const Icon = tab.icon;
            return (
              <BottomNavTab
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                icon={tab.key === PROFILE_TAB.key ? <ProfileNavGlyph user={user} size={26} /> : <Icon className="h-5 w-5" />}
                label={tab.label}
                active={activeTab === tab.key}
                badge={badgeFor[tab.key] || 0}
                badgeTestId={`physio-bottom-tab-badge-${tab.key}`}
                data-testid={`physio-bottom-tab-${tab.key}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// A treatment day's date, and only its date.
//
// A day of a course is not an appointment. The package is a count of days of treatment,
// the days are worked in order, and a day is worked on the date the Branch Admin put it
// on — the clock time on that date is where the branch fitted the patient in, not a second
// gate the day has to clear. The date is already the whole rule: canWork compares
// slot_time sliced to ten characters, and the server checks day order and the review hold
// and nothing else.
//
// Printing "Wed, Sep 9 at 8:00 AM" on the rows said otherwise. A patient seen at eleven
// read as a patient who had missed something, and a physio working the list in the
// afternoon had every remaining row quoting an hour that had already gone by — an hour
// that decides nothing.
//
// So the slot's time stays on the record and on the Branch Admin's calendar, where booking
// needs it, and stops being shown as part of what the day is. The physio's own diary — the
// Calendar tab, and the day table on the board — still shows times, because that is a
// schedule and reading it is the whole point of it.
const dayDate = (slot) =>
  slot
    ? new Date(`${slot.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })
    : null;
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoOf(d);
};
// Sunday-to-Saturday calendar week containing `iso` — the week strip always shows
// a real week, not an arbitrary sliding window, so it reads like a normal calendar.
const weekDatesFor = (iso) => {
  const sunday = shiftIso(iso, -new Date(`${iso}T00:00:00`).getDay());
  return Array.from({ length: 7 }, (_, i) => shiftIso(sunday, i));
};
// The phone's strip: five days with `iso` in the middle. Five cells cannot hold a Sun-Sat
// week, and a window that steps by five keeps every day of the week reachable.
const windowDatesFor = (iso) => Array.from({ length: 5 }, (_, i) => shiftIso(iso, i - 2));
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/** True below md — the width the bottom bar is drawn at. Read rather than left to CSS
 *  because the strip's dates and its arrows' step both change with it. */
const usePhone = () => {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
};

// Tile colours. The money boards give every card its own hex and read it back for the
// figure, the corner disc and the selected ring, so the colour is the card's identity
// rather than decoration. Naming them here keeps one meaning per colour across the three
// places this board shows tiles — pending is amber wherever it appears.
const TILE = {
  total: "#0284c7",
  done: "#059669",
  pending: "#d97706",
  review: "#7c3aed",
  request: "#db2777",
};

// Every 7th treatment day is a review milestone — reviewsSoFar counts how many the patient
// has already passed, isReviewDay flags this one as the next. One definition because the
// phone list and the desktop table both draw the violet from it, and two copies of the
// arithmetic is two chances for a row to say "Review Today" in one layout and not the other.
const reviewMarks = (r) => ({
  reviewsSoFar: r.sessionNumber ? Math.floor(r.sessionNumber / 7) : 0,
  isReviewDay: r.sessionNumber > 0 && r.sessionNumber % 7 === 0,
});

// How many treatment days between reviews, used only until the real interval arrives.
// /physio/sessions now sends review_after_days off REVIEW_AFTER_DAYS in
// backend/routers/v3_reviews.py — the constant that actually decides whether a review can
// be raised — so this is the value the popup draws with for the moment before the fetch
// lands, and the fallback if an older server answers without the field.
const REVIEW_EVERY = 7;

// How one review milestone reads in the Treatment Days list. Four states, because a
// milestone is not simply due or not: it is raised by the Physio, dispatched by the Branch
// Admin, then written by the Head Physio, and a physio looking at the day list wants to
// know which of those is holding rather than being told to raise a review twice.
//
// Only "due" asks for anything. The rest are there so a finished week reads as finished.
const milestoneLook = (review) => {
  const who = review?.head_physio_name;
  switch (review?.status) {
    case "completed":
      return {
        label: "Reviewed", tone: "emerald", Icon: CheckCircle2,
        line: who ? `Reviewed by ${who}.` : "Review written.",
      };
    case "sent":
      return {
        label: "Scheduled", tone: "sky", Icon: Calendar,
        line: who ? `With ${who}.` : "Dispatched to a CONSULTANT.",
      };
    case "send_to_review":
      return {
        label: "Raised", tone: "sky", Icon: Clock,
        line: "Waiting on Branch Admin to schedule it.",
      };
    default:
      return {
        label: "Review due", tone: "amber", Icon: AlertCircle,
        line: "Raise it from the Review tab.",
      };
  }
};

// Written out rather than built from the tone, because Tailwind only ships classes it can
// see as whole strings in the source — `border-${tone}-200` compiles to nothing.
const MILESTONE_TONES = {
  emerald: { box: "border-emerald-200 bg-emerald-50", text: "text-emerald-800", soft: "text-emerald-700", badge: "bg-emerald-100 text-emerald-700" },
  sky: { box: "border-sky-200 bg-sky-50", text: "text-sky-800", soft: "text-sky-700", badge: "bg-sky-100 text-sky-700" },
  amber: { box: "border-amber-200 bg-amber-50", text: "text-amber-800", soft: "text-amber-700", badge: "bg-amber-100 text-amber-700" },
};

// `short` is the phone label. The full names run long and the modal gets roughly 340px on
// a phone, so without these the row scrolls sideways and tabs sit off-screen behind a
// gesture nobody knows is there.
//
// Consultation Report is no longer a tab of its own — it is the rest of what Overview
// already answers about this patient, and splitting "who they are" across two tabs meant
// checking both to read one story. Three tabs also give each a third more room on a phone.
const MODAL_TABS = [
  { key: "overview", label: "Overview", short: "Overview" },
  { key: "days", label: "Treatment Days", short: "Days" },
  { key: "documents", label: "Documents", short: "Docs" },
];

const docSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The patient's uploaded records, read-only.
 *
 * A physio is in READ_ROLES but not WRITE_ROLES on the documents router, so this lists and
 * opens and offers nothing else — no upload, no delete, no share toggle. Putting buttons
 * here that the API would reject is worse than not having them.
 *
 * Bytes come back as an authenticated blob rather than a static URL, so opening one means
 * fetching it first. What comes back is shown on this page rather than handed to a new
 * tab — a physio opens a scan to read it against the days and the notes beside it, and a
 * tab is the one place those are not. See useDocumentPreview, which owns the blob for
 * exactly as long as the document is on screen.
 */
const DocumentsPanel = ({ leadId }) => {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);
  const { preview, openPreview, closePreview } = useDocumentPreview();

  useEffect(() => {
    let alive = true;
    if (!leadId) return undefined;
    setLoading(true);
    leadDocuments(leadId)
      .then((r) => { if (alive) setDocs(r.documents || []); })
      .catch(() => { if (alive) setDocs([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [leadId]);

  const view = async (doc) => {
    setOpening(doc.id);
    try {
      const url = await openLeadDocument(leadId, doc.id);
      openPreview({ url, name: doc.label || doc.original_name || "Document", contentType: doc.content_type });
    } catch {
      toast.error("Could not open that document");
    } finally {
      setOpening(null);
    }
  };

  return (
    <div data-testid="physio-documents-panel">
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
        Documents {docs.length > 0 && <span className="text-slate-400">({docs.length})</span>}
      </p>
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">Loading documents…</div>
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">No documents uploaded for this patient</div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5"
              data-testid={`physio-document-${d.id}`}
            >
              <FileText className="h-4 w-4 shrink-0 text-sky-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-700">{d.label || d.original_name || "Document"}</p>
                <p className="text-[10px] text-slate-400">
                  {[d.kind, d.size_bytes ? docSize(d.size_bytes) : null, d.created_at ? String(d.created_at).slice(0, 10) : null]
                    .filter(Boolean).join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => view(d)}
                disabled={opening === d.id}
                className="flex shrink-0 items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-100 disabled:opacity-50"
                data-testid={`physio-document-view-${d.id}`}
              >
                <Eye className="h-3.5 w-3.5" /> {opening === d.id ? "Opening…" : "View"}
              </button>
            </div>
          ))}
        </div>
      )}
      <DocumentPreview preview={preview} onClose={closePreview} testid="physio-document-preview" />
    </div>
  );
};

/**
 * The client's weekly star rating, as the Physio sees it: stars only. The Treatment
 * Feedback the client wrote beside them is not sent to this board at all (see
 * physio_star_ratings in v3_client_reviews.py) — management and the Consultant read it.
 */
const StarBadge = ({ value, count, testid }) => (
  value ? (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
      title={count ? `Average of ${count} weekly review${count === 1 ? "" : "s"}` : undefined}
      data-testid={testid}
    >
      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
      {Number(value).toFixed(count ? 1 : 0)}
    </span>
  ) : null
);

// Which review week a Treatment row's stars belong to: every 7 days by number (Days 1-7
// are Week 1, 8-14 Week 2), not the booked calendar week — the same rule as week_of on
// the server.
const starWeekOf = (r) => Math.floor(((r.sessionNumber || 1) - 1) / 7) + 1;

const rowStars = (r) => r.lead?.star_weeks?.[`${r.track || "treatment"}:${starWeekOf(r)}`] || null;

function TreatmentTab({ physioId, onCountChange, toolbarSlot, scope = "all" }) {
  const [leads, setLeads] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedLead, setSelectedLead] = useState(null);

  const todayIso = isoOf(new Date());
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayIso);
  // Which Sun-Sat week is showing — held apart from selectedDate so the arrows
  // move the whole week without disturbing which single day is highlighted.
  const [weekAnchor, setWeekAnchor] = useState(todayIso);

  // A phone shows five days around the anchor and steps five at a time; wider screens keep
  // the Sun-Sat week and step a week.
  const phone = usePhone();
  const stripStep = phone ? 5 : 7;
  const stripDates = useMemo(() => (phone ? windowDatesFor(weekAnchor) : weekDatesFor(weekAnchor)), [phone, weekAnchor]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Leads carry the appointment Branch Admin booked; the calendar carries the
      // treatment days booked against this physio. Both are appointments for the day.
      const months = [...new Set(stripDates.map((d) => d.slice(0, 7)))];
      const [consults, ...calendars] = await Promise.all([
        physioConsultations(physioId),
        ...months.map((m) => physioCalendar(Number(m.slice(5, 7)), Number(m.slice(0, 4)), physioId)),
      ]);
      setLeads(consults.leads || []);
      setSessions(calendars.flatMap((c) => c.sessions || []));
    } catch { /* silent */ }
    setLoading(false);
  }, [physioId, stripDates.join(",")]);

  useEffect(() => { load(); }, [load]);

  const leadById = useMemo(() => Object.fromEntries(leads.map((l) => [l.id, l])), [leads]);
  // Treatment and House Visit are this one tab split by where the patient is treated:
  // "home" keeps the House Visit patients, "exclude_home" keeps everybody else.
  const inScope = useCallback((lead) => (
    scope === "home" ? lead?.visit_type === "home"
      : scope === "exclude_home" ? lead?.visit_type !== "home"
      : true
  ), [scope]);

  // The treatment and rehab days booked against this physio on a given day, earliest
  // time first.
  //
  // The lead's own appointment_date is deliberately not one of them. That is the
  // consultation the Branch Admin booked with a Head Physio, and it stays on the lead
  // after v3_session_assign hands the patient over to the treating physio — so every
  // patient dragged their old consultation slot onto this list as an "Appointment" row
  // with no day, no package and no review against it, and the physio was being asked to
  // close off a consultation they never took. It belongs on the Head Physio's calendar,
  // which is where appt_kind="consultation" already puts it.
  const rowsFor = useCallback((date) => {
    const rows = [];
    sessions
      .filter((s) => (s.slot_time || "").startsWith(date))
      .forEach((s) => {
        const lead = leadById[s.lead_id];
        if (!inScope(lead)) return;
        rows.push({
          key: `day-${s.id}`,
          lead: lead || { id: s.lead_id, name: s.lead_name },
          time: (s.slot_time.split("T")[1] || "").slice(0, 5),
          // A rehab day says so. It is the same physio in the same room, but it belongs to
          // the rehab course rather than the session package, and reading "Day 3 of 7" off
          // it would have the patient three days into a treatment plan they may not even
          // be on. The backend tags these — see _rehab_rows in v3_physio_board.
          label: s.track === "rehab"
            ? `Rehab Day ${s.session_number} of ${s.total_sessions}`
            : `Day ${s.session_number} of ${s.total_sessions}`,
          track: s.track || "treatment",
          sessionNumber: s.session_number,
          totalSessions: s.total_sessions,
          week: s.week_number,
          done: s.status === "completed",
          // Handed to this physio for the day while its own physio is absent.
          coveringFor: s.covered_for_physio_name || "",
        });
      });
    return rows.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }, [sessions, leadById, inScope]);

  const dayRows = useMemo(() => rowsFor(selectedDate), [rowsFor, selectedDate]);

  // Which of the three summary tiles is narrowing the day's list — "all" (the
  // default, tapping "Total Days") shows everything; "completed"/"pending" isolate
  // just that group. Tapping an already-active tile clears back to "all".
  const [rowFilter, setRowFilter] = useState("all");

  // Matches a row against the search box — one definition because the day list and the
  // two caseload lists are searched by the same box in the same toolbar, and a name that
  // finds a patient on one tab must find them on the others. Name only: searching by
  // phone here would hand back a number this board deliberately does not show.
  const matches = useCallback((lead, q) => (
    !q || (lead?.name || "").toLowerCase().includes(q)
  ), []);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = dayRows.filter((r) => matches(r.lead, q));
    if (rowFilter === "completed") rows = rows.filter((r) => r.done);
    else if (rowFilter === "pending") rows = rows.filter((r) => !r.done);
    // Incomplete cards always show first, completed (green) cards always last —
    // each group keeps its own time order from rowsFor's sort.
    const incomplete = rows.filter((r) => !r.done);
    const completed = rows.filter((r) => r.done);
    return [...incomplete, ...completed];
  }, [dayRows, search, rowFilter, matches]);

  // Every treatment day this physio holds, regardless of date — the default when
  // no Meta-style date filter is active.
  const overall = useMemo(() => {
    const total = leads.reduce((n, l) => n + (l.total_sessions || 0), 0);
    const completed = leads.reduce((n, l) => n + (l.completed_sessions || 0), 0);
    return { total, completed, pending: total - completed };
  }, [leads]);

  const countFor = (date) => sessions.filter((s) => (s.slot_time || "").startsWith(date)).length;

  // Meta Ads-style date filter for the summary tile only — separate from the week
  // strip below, which always keeps its own single selected day. Defaults to Today
  // rather than Overall, same as the week strip's own default. Picking a preset
  // whose range is a single day (Today, Yesterday, an exact calendar date) also
  // jumps the week strip there, since there's no ambiguity about which day to show.
  const [filterValue, setFilterValue] = useState(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    return { key: "today", label: "Today", from, to };
  });
  const [filterSessions, setFilterSessions] = useState([]);

  const handleFilterChange = (next) => {
    setFilterValue(next);
    if (next && isoOf(next.from) === isoOf(next.to)) {
      const d = isoOf(next.from);
      setSelectedDate(d);
      setWeekAnchor(d);
    }
  };

  useEffect(() => {
    if (!filterValue) { setFilterSessions([]); return; }
    let cancelled = false;
    (async () => {
      const months = [];
      let y = filterValue.from.getFullYear(), m = filterValue.from.getMonth();
      const endY = filterValue.to.getFullYear(), endM = filterValue.to.getMonth();
      while (y < endY || (y === endY && m <= endM)) {
        months.push({ year: y, month: m + 1 });
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
      try {
        const results = await Promise.all(months.map((mo) => physioCalendar(mo.month, mo.year, physioId)));
        if (!cancelled) setFilterSessions(results.flatMap((r) => r.sessions || []));
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [filterValue, physioId]);

  const filterStats = useMemo(() => {
    if (!filterValue) return overall;
    const fromIso = isoOf(filterValue.from);
    const toIso = isoOf(filterValue.to);
    const inRange = (d) => d && d >= fromIso && d <= toIso;
    const dayRows = filterSessions.filter((s) => inRange((s.slot_time || "").slice(0, 10)));
    const completed = dayRows.filter((s) => s.status === "completed").length;
    return { total: dayRows.length, completed, pending: dayRows.length - completed };
  }, [filterValue, filterSessions, overall]);

  // Badge is what's still outstanding today, not the whole day's total — it counts
  // down to 0 as each treatment day gets marked complete.
  useEffect(() => { onCountChange?.(filterStats.pending); }, [filterStats.pending, onCountChange]);

  const [searchOpen, setSearchOpen] = useState(false);

  // Icon-only search that expands on tap, plus the Meta-style date filter. Rendered
  // into the board's tab row rather than here, so on a desk it sits beside the tabs
  // instead of below the summary. Portaled rather than lifted into the board so this
  // tab keeps its own search text and date range — Review has its own pair, and one
  // shared filter would let a range picked over there silently narrow this tab.
  //
  // When nothing's picked the summary above shows Overall; the week strip below
  // always keeps today selected by default regardless.
  const toolbar = (
    <div className="flex w-full items-center gap-2 md:w-auto" data-testid="physio-treatment-toolbar">
      {/* Open, the box takes the room the filter pills were using rather than a row of its
          own — on a phone there is not enough width for both, and the pills are what the
          physio just stopped using. */}
      {searchOpen && (
        <div className="relative min-w-0 flex-1 md:w-[240px] md:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient by name..."
            className="h-10 pl-9 pr-9"
            data-testid="physio-treatment-search"
          />
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearch(""); }}
            className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-slate-100"
            data-testid="physio-treatment-search-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search, Date Filter, Refresh — in that order, and the same order the Patients
          tab puts its three in, so the control under a given thumb is the same control
          whichever tab is open. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {!searchOpen && (
          <button
            type="button"
            title="Search"
            aria-label="Search"
            onClick={() => setSearchOpen(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            data-testid="physio-treatment-search-open"
          >
            <Search className="h-4 w-4" />
          </button>
        )}
        <DateFilterPopover value={filterValue} onChange={handleFilterChange} testid="physio-treatment-date-filter" centered iconOnly phoneIconOnly />
        {/* Grey, matching every other Refresh in the OS — it is the one control that acts
            rather than filters, so it should not read as another filter chip. */}
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="physio-treatment-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </div>
  );

  return (
    <div data-testid="physio-treatment-tab">
      {/* Portaled into the board's tool bar row above. Kept first here so that if the slot
          has not mounted yet the fallback still renders where the tool bar belongs —
          above the summary — rather than under it. */}
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}

      {/* The tinted panel these sat in is gone — the Head Physio cards sit straight on
          the page, and boxing the same cards here made two identical controls look like
          two different ones. The heading stays: it names the range the counts answer to. */}
      <div className="mb-4" data-testid="physio-treatment-summary">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">{filterValue ? filterValue.label : "Overall Treatment"}</p>
        {/* Three across at every width, phone included. It used to fold two by two below
            sm, which cost the summary a second row on the screen that has the least of it.
            The cards carry `compact` for the narrow width a phone leaves them: below sm the
            corner disc steps out and the label takes the whole card.

            On a phone they also wear the Zumba strip's card (`arrow="phone"`): white, grey
            label with the chevron, the figure in the card's colour, no caption. From sm up
            they keep the disc and the sub-lines.

            Treatment Completed used to be a fourth card here. It counted finished patients,
            not days — the one figure in the row that did not answer to the date above it. */}
        <div className="grid grid-cols-3 gap-1.5 sm:gap-3">
          <StatTile
            compact arrow="phone"
            icon={Calendar} label="Total Days" value={filterStats.total} color={TILE.total}
            onClick={() => setRowFilter("all")} active={rowFilter === "all"} testid="physio-stat-total"
          />
          <StatTile
            compact arrow="phone"
            icon={CheckCircle2} label="Completed" value={filterStats.completed} color={TILE.done}
            sub={filterStats.total ? `${Math.round((filterStats.completed / filterStats.total) * 100)}% done` : null}
            onClick={() => setRowFilter(rowFilter === "completed" ? "all" : "completed")} active={rowFilter === "completed"} testid="physio-stat-completed"
          />
          <StatTile
            compact arrow="phone"
            icon={Clock} label="Pending" value={filterStats.pending} sub="Days left" color={TILE.pending}
            onClick={() => setRowFilter(rowFilter === "pending" ? "all" : "pending")} active={rowFilter === "pending"} testid="physio-stat-pending"
          />
        </div>
      </div>

      {/* Sun-Sat week strip — today is always the default selection.
          Kept deliberately short: this is a date picker sitting between the summary and
          the day's list, and at its old height it pushed the first patient below the fold
          on a laptop. The month line and the day cells both lost their spare padding.

          The arrows sit beside the strip and centre against its full height rather than
          riding in the month line. They step the week — the row of days — so pinned to the
          label they floated above the thing they move. */}
      <div className="mb-3 flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2 py-2" data-testid="physio-treatment-week-strip">
        <button type="button" onClick={() => setWeekAnchor((a) => shiftIso(a, -stripStep))} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100" aria-label={phone ? "Previous days" : "Previous week"} data-testid="physio-week-prev">
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="mb-1 text-center text-[11px] font-semibold text-slate-600">
            {new Date(`${weekAnchor}T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
          <div className={`grid gap-1 ${phone ? "grid-cols-5" : "grid-cols-7"}`}>
          {stripDates.map((date) => {
            const day = parseInt(date.split("-")[2], 10);
            const isSelected = date === selectedDate;
            const isToday = date === todayIso;
            const n = countFor(date);
            return (
              <button
                key={date}
                type="button"
                onClick={() => setSelectedDate(date)}
                className={`flex flex-col items-center gap-0.5 rounded-lg py-1 transition ${isSelected ? "bg-sky-600" : "hover:bg-slate-50"}`}
                data-testid={`physio-day-${date}`}
              >
                <span className={`text-[9px] font-semibold ${isSelected ? "text-sky-100" : "text-slate-400"}`}>{DAY_LETTERS[new Date(`${date}T00:00:00`).getDay()]}</span>
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                    isSelected ? "bg-white/20 text-white" : isToday ? "bg-sky-100 text-sky-700" : "text-slate-600"
                  }`}
                >
                  {day}
                </span>
                {n > 0 && <span className={`text-[9px] font-medium leading-none ${isSelected ? "text-sky-100" : "text-slate-400"}`}>{n}</span>}
              </button>
            );
          })}
          </div>
        </div>

        <button type="button" onClick={() => setWeekAnchor((a) => shiftIso(a, stripStep))} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100" aria-label={phone ? "Next days" : "Next week"} data-testid="physio-week-next">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {visibleRows.length === 0 && !loading ? (
        <div className="text-center py-16">
          <ClipboardList className="h-10 w-10 text-slate-200 mx-auto mb-3" />
          <p className="text-sm text-slate-400">
            {search.trim()
              ? `No patient matches "${search.trim()}" on this day`
              : `Nothing booked for ${new Date(`${selectedDate}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
          </p>
        </div>
      ) : (
        <>
          {/* Cards on a phone, table from sm up — the same two-mode list Human Resource
              uses for its candidates. A table is the right shape for scanning a day of
              appointments down a column, but eight columns on a 375px screen is a
              horizontal scrollbar and nothing readable, so the phone keeps the row. */}
          <div className="space-y-2 sm:hidden" data-testid="physio-treatment-list-mobile">
            {visibleRows.map((r) => {
              const l = r.lead;
              const clickable = l?.phone !== undefined;
              const { reviewsSoFar, isReviewDay } = reviewMarks(r);
              return (
                <button
                  type="button"
                  key={r.key}
                  onClick={() => clickable && setSelectedLead(l)}
                  disabled={!clickable}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-default ${
                    r.done ? "border-emerald-200 bg-emerald-50/50" : isReviewDay ? "border-violet-200 bg-violet-50/40" : "border-slate-200 bg-white hover:border-sky-200"
                  }`}
                  data-testid={`treatment-row-${r.key}`}
                >
                  <div className={`flex h-11 w-16 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${r.done ? "bg-emerald-200 text-emerald-800" : "bg-sky-100 text-sky-700"}`}>
                    {r.time ? to12h(r.time) : "—"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{l.name}</p>
                    {r.coveringFor && <p className="truncate text-[10px] font-medium text-rose-600">Covering for {r.coveringFor}</p>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                      {r.sessionNumber ? (
                        <>
                          <span>{String(r.sessionNumber).padStart(2, "0")}/{r.totalSessions}</span>
                          <span className={`rounded-full px-1.5 py-0.5 font-semibold ${reviewsSoFar > 0 ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-400"}`}>
                            {reviewsSoFar} Review{reviewsSoFar === 1 ? "" : "s"}
                          </span>
                          {isReviewDay && <span className="rounded-full bg-violet-600 px-1.5 py-0.5 font-semibold text-white">Review Today</span>}
                          <StarBadge value={rowStars(r)} />
                        </>
                      ) : (
                        <span>{r.label}</span>
                      )}
                    </div>
                  </div>
                  {r.done ? (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">Done</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-sky-600">
                      View <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="physio-treatment-list-desktop">
            <div className="overflow-x-auto">
              {/* 720 -> 820 for the Package column. The wrapper scrolls, so the columns keep their
                  widths on a narrow desk rather than being squeezed to fit.

                  table-fixed with stated percentages, the way the branch boards size theirs.
                  Auto layout handed the spare width to whichever column held the longest
                  string, so on a wide screen Patient swallowed nearly all of it and every
                  heading after it floated a hand-width clear of the badges beneath it — and
                  the columns shifted again each time the day brought different names. The
                  percentages below must total 100. */}
              <table className="w-full min-w-[920px] table-fixed text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    {/* Time and Patient stay left — they are the columns the eye scans down
                        to find a row, and a ragged left edge is what makes that hard. What
                        follows them is a single centred badge per cell, so those headings
                        centre too rather than sitting off the end of their own column. */}
                    <th className="w-[11%] px-4 py-2.5 font-semibold">Time</th>
                    <th className="w-[20%] px-4 py-2.5 font-semibold">Patient</th>
                    <th className="w-[10%] px-4 py-2.5 text-center font-semibold">Day</th>
                    <th className="w-[13%] px-4 py-2.5 text-center font-semibold">Reviews</th>
                    {/* The client's stars for the week this day sits in. Stars only: the
                        Treatment Feedback beside them is not the Physio's to read. */}
                    <th className="w-[13%] px-4 py-2.5 text-center font-semibold">Star Rating</th>
                    <th className="w-[13%] px-4 py-2.5 text-center font-semibold">Status</th>
                    {/* Which course the day belongs to. Treatment and Rehab share a physio,
                        a room and a calendar, so without this the two read as one list and
                        05/36 beside 05/26 says nothing about what either is. */}
                    <th className="w-[14%] px-4 py-2.5 text-center font-semibold">Package</th>
                    <th className="w-[6%] px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((r) => {
                    const l = r.lead;
                    const clickable = l?.phone !== undefined;
                    const { reviewsSoFar, isReviewDay } = reviewMarks(r);
                    return (
                      <tr
                        key={r.key}
                        onClick={() => clickable && setSelectedLead(l)}
                        // The done/review tint stays on the row. It is how a physio picks
                        // out what is left to do without reading the Status column, and
                        // dropping it was the one thing the table could not afford to lose.
                        className={`${clickable ? "cursor-pointer" : "cursor-default"} ${
                          r.done ? "bg-emerald-50/50 hover:bg-emerald-50" : isReviewDay ? "bg-violet-50/40 hover:bg-violet-50" : "hover:bg-slate-50"
                        }`}
                        data-testid={`treatment-row-${r.key}`}
                      >
                        <td className="px-4 py-3">
                          <span className={`inline-flex whitespace-nowrap rounded-lg px-2 py-1 text-[11px] font-bold ${r.done ? "bg-emerald-200 text-emerald-800" : "bg-sky-100 text-sky-700"}`}>
                            {r.time ? to12h(r.time) : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {/* truncate, because table-fixed will not widen the column for a
                              long name — without it the name runs on under Day. */}
                          <p className="truncate font-medium text-slate-800">{l.name}</p>
                          {r.coveringFor && <p className="truncate text-[10px] font-medium text-rose-600">Covering for {r.coveringFor}</p>}
                        </td>
                        <td className="px-4 py-3 text-center text-slate-600">
                          {r.sessionNumber
                            ? <span className="whitespace-nowrap">{String(r.sessionNumber).padStart(2, "0")}/{r.totalSessions}</span>
                            : <span className="text-slate-400">{r.label}</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {r.sessionNumber ? (
                            <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${reviewsSoFar > 0 ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-400"}`}>
                              {reviewsSoFar} Review{reviewsSoFar === 1 ? "" : "s"}
                            </span>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {rowStars(r)
                            ? <StarBadge value={rowStars(r)} testid={`treatment-row-stars-${r.key}`} />
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {r.done ? (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Done</span>
                          ) : isReviewDay ? (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white">Review Today</span>
                          ) : (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Pending</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {/* A consultation appointment is neither, and says so with a dash
                              rather than being called treatment by default. */}
                          {r.track === "rehab" ? (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-semibold text-cyan-700">Rehab</span>
                          ) : r.track === "treatment" ? (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">Treatment</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ChevronRight className="ml-auto h-4 w-4 text-slate-300" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {selectedLead && (
        <ConsultationDetailModal
          lead={selectedLead}
          physioId={physioId}
          // Days are completed inside the popup, so re-pull on close to refresh the counts.
          onClose={() => { setSelectedLead(null); load(); }}
          onDone={() => { setSelectedLead(null); load(); }}
        />
      )}
    </div>
  );
}

// In pipeline order, earliest first. "Not Due" exists because bucketOf() has always
// returned it for patients short of their next milestone, but there was no tab to reach
// them through — so Total counted five patients while the tabs between them showed one,
// which read as the review flow being broken when it was working correctly.
const REVIEW_TABS = [
  { key: "not_due", label: "Not Due", icon: Clock, color: TILE.pending },
  { key: "new_review", label: "New Review", icon: ClipboardCheck, color: TILE.review },
  { key: "requests", label: "Requests", icon: Send, color: TILE.request },
  { key: "assigned", label: "Assigned", icon: Users, color: TILE.total },
  { key: "completed", label: "Completed", icon: CheckCircle2, color: TILE.done },
];

/**
 * What a patient's course is called on their card.
 *
 * A rehab course is not cut into weeks, so the weeks line read "? weeks program" for
 * every rehab patient — a question mark standing in for a number that was never going
 * to exist. Says days for those, and falls back to the weeks the booked sessions
 * actually span when no package recommended a figure.
 */
// The client's star rating of their physio, on the treatment day it belongs to: a weekly
// review sits on the last day of its week, a Feedback-tab one on the day it was given
// (session_star_ratings on the server). Stars only; the words never reach the physio.
function SessionStars({ session }) {
  return (session.star_ratings || []).map((r, i) => (
    <span
      key={i}
      title={`Client rating: ${r} of 5`}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5"
      data-testid={`physio-session-stars-${session.id}`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`h-3 w-3 ${n <= r ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
      ))}
      <span className="ml-0.5 text-[10px] font-semibold text-amber-700">{r}</span>
    </span>
  ));
}

const courseLine = (p) => {
  const tracks = p.tracks || [];
  if (tracks.length === 1 && tracks[0] === "rehab") {
    return p.total_sessions ? `${p.total_sessions} day course` : "";
  }
  const weeks = p.package_weeks || p.weeks;
  return weeks ? `${weeks} week${weeks === 1 ? "" : "s"} program` : "";
};

const ordinal = (n) => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
};

/**
 * Send for Review. Offered the moment the Physio is due one: the client's weekly review is
 * theirs to give or skip, and it no longer holds this button (nor does the server refuse
 * the raise over it) — a review the client never gave used to strand the patient here.
 */
function SendForReviewButton({ onClick, className = "", testid }) {
  return (
    <Button size="sm" className={`bg-amber-600 text-xs text-white hover:bg-amber-700 ${className}`} onClick={onClick} data-testid={testid}>
      Send for Review
    </Button>
  );
}

/**
 * Review — the Physio's end of the post-treatment review chain, in one place.
 *
 * A new review only becomes raisable every 7 completed sessions — 7, 14, 21, 28... —
 * not "7 or more"; a 28-session package gets exactly 4 review points. New Review shows only
 * patients who've just reached one and don't already have one in flight or covering it,
 * computed server-side (_review_eligibility in v3_reviews.py) so raising one is rejected
 * the same way if attempted outside that window.
 *
 * Raising a review is what starts the chain: it lands with the Branch Admin, who
 * dispatches it to a named Head Physio, who writes it up. Requests / Assigned / Completed
 * follow a patient along that hand-off, and the weekly write-up hangs off the same rows.
 */
function ReviewTab({ physioId, onCountChange, toolbarSlot }) {
  const [patients, setPatients] = useState([]);
  const [threshold, setThreshold] = useState(7);
  const [loading, setLoading] = useState(false);
  const [bucket, setBucket] = useState("new_review");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterValue, setFilterValue] = useState(null);
  const [draft, setDraft] = useState(null); // { patient, reason, physio_notes } | null
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(null); // the patient whose review is open
  // The full review documents. /physio/reviews has always returned these beside the
  // patient rows and they were dropped on the floor — the rows carry only a status and an
  // id, so without them there is nothing to show but the badge already on screen.
  const [reviews, setReviews] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Two sources: the review chain's own state, and the session tallies that say how
      // many weeks there are to write up. Keyed together on lead_id.
      const [rev, pats] = await Promise.all([physioReviews(physioId), physioPatients(physioId)]);
      const byLead = Object.fromEntries((pats.patients || []).map((p) => [p.lead_id, p]));
      setThreshold(rev.review_after_days || 7);
      setReviews(rev.reviews || []);
      setPatients((rev.patients || []).map((p) => ({ ...(byLead[p.lead_id] || {}), ...p })));
    } catch { /* silent */ }
    setLoading(false);
  }, [physioId]);

  useEffect(() => { load(); }, [load]);

  const submitRaise = async () => {
    // The notes are the whole point of the hand-off: the Head Physio writes their review
    // off the back of what the treating physio observed. A review raised without them
    // arrives as a name and a reason, which is not enough to review anything.
    if (!draft.physio_notes.trim()) {
      toast.error("Add your notes for the CONSULTANT — they can't review the patient without them");
      return;
    }
    setSaving(true);
    try {
      await physioRaiseReview(draft.patient.lead_id, { reason: draft.reason, physio_notes: draft.physio_notes }, physioId);
      toast.success("Sent to Branch Admin for review");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to raise the review");
    }
    setSaving(false);
  };

  // Who currently holds the review. due_for_review (server-computed) means a fresh
  // 7-day milestone is reached and nothing is blocking a new one — that's New Review.
  const bucketOf = (p) => {
    if (p.review_status === "completed") return "completed";
    if (p.review_status === "sent") return "assigned";
    if (p.review_status === "send_to_review") return "requests";
    return p.due_for_review ? "new_review" : "not_due";
  };

  // Date filter narrows the whole tab, not just the final list — the Total pill and
  // every bucket's count on the tabs below are computed from this, not from `patients`.
  const dateFiltered = useMemo(() => {
    if (!filterValue) return patients;
    const fromIso = isoOf(filterValue.from);
    const toIso = isoOf(filterValue.to);
    return patients.filter((p) => {
      const d = p.first_session_date || "";
      return d && d >= fromIso && d <= toIso;
    });
  }, [patients, filterValue]);

  const counts = useMemo(() => {
    const c = { not_due: 0, new_review: 0, requests: 0, assigned: 0, completed: 0 };
    dateFiltered.forEach((p) => { const b = bucketOf(p); if (b in c) c[b] += 1; });
    return c;
  }, [dateFiltered]);

  // Nav badge reflects every patient newly due, regardless of whatever date filter
  // is currently narrowing the tab's own view.
  const newReviewTotal = useMemo(() => patients.filter((p) => bucketOf(p) === "new_review").length, [patients]);
  useEffect(() => { onCountChange?.(newReviewTotal); }, [newReviewTotal, onCountChange]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dateFiltered.filter((p) => {
      if (bucketOf(p) !== bucket) return false;
      if (q && !(
        (p.lead_name || "").toLowerCase().includes(q)
        || (p.patient_number || "").toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [dateFiltered, bucket, search]);

  const STATUS_BADGE = {
    completed: { label: "Review Completed", cls: "bg-emerald-100 text-emerald-700" },
    sent: { label: "With CONSULTANT", cls: "bg-violet-100 text-violet-700" },
    send_to_review: { label: "With Branch Admin", cls: "bg-sky-100 text-sky-700" },
  };

  const EMPTY_TEXT = {
    not_due: "Every patient is either due a review or already in one",
    new_review: "No one has reached a new review milestone yet",
    requests: "No requests waiting on the Branch Admin",
    assigned: "No reviews assigned to a CONSULTANT",
    completed: "No completed reviews yet",
  };

  // Icon-only search, the Meta-style date filter, and a small Total pill next to it —
  // everything the bucket cards below read from is filtered by this date range first,
  // so Total and every bucket count move together. Rendered into the board's tab row;
  // see the note on TreatmentTab's toolbar for why it's portaled rather than lifted.
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-testid="physio-review-toolbar">
      {searchOpen ? (
        <div className="relative w-full sm:w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient by name or patient no..."
            className="h-10 pl-9 pr-9"
            data-testid="physio-review-search"
          />
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearch(""); }}
            className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-slate-100"
            data-testid="physio-review-search-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
          data-testid="physio-review-search-open"
        >
          <Search className="h-4 w-4" />
        </button>
      )}
      {/* Grey, matching every other Refresh in the OS — it is the one control that acts
          rather than filters, so it should not read as another filter chip. */}
      <Button
        onClick={load}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        data-testid="physio-review-refresh"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
      <DateFilterPopover value={filterValue} onChange={setFilterValue} testid="physio-review-date-filter" centered iconOnly />
      <div className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3" data-testid="physio-review-total">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-600">Total</span>
        <span className="text-sm font-bold text-sky-700">{dateFiltered.length}</span>
      </div>
    </div>
  );

  return (
    <div data-testid="physio-review-tab">
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}

      {/* New Review / Requests / Assigned / Completed — same hand-off the patient
          actually moves through, one bucket at a time; New Review is the default.
          The same tile the Treatment summary uses, so both tabs of this board filter
          through one control rather than two that happen to sit on the same screen.
          All five across from sm up. A phone gets the stacked rows below instead, with
          the count badged on each card's corner. */}
      <div className="mb-3 grid grid-cols-1 gap-2.5 sm:hidden" data-testid="physio-review-buckets-phone">
        {REVIEW_TABS.map((t) => (
          <NotifyCard
            key={t.key}
            icon={t.icon}
            label={t.label}
            value={counts[t.key]}
            color={t.color}
            active={bucket === t.key}
            onClick={() => setBucket(t.key)}
            testid={`physio-review-bucket-phone-${t.key}`}
          />
        ))}
      </div>
      <div className="mb-3 hidden grid-cols-5 gap-3 sm:grid" data-testid="physio-review-buckets">
        {REVIEW_TABS.map((t) => (
          <StatTile
            key={t.key}
            icon={t.icon}
            label={t.label}
            value={counts[t.key]}
            color={t.color}
            active={bucket === t.key}
            onClick={() => setBucket(t.key)}
            testid={`physio-review-bucket-${t.key}`}
          />
        ))}
      </div>

      {visible.length === 0 && !loading ? (
        <div className="text-center py-16">
          <ClipboardCheck className="h-10 w-10 text-slate-200 mx-auto mb-3" />
          <p className="text-sm text-slate-400">{EMPTY_TEXT[bucket] || "No patient matches these filters"}</p>
        </div>
      ) : (
        <>
        {/* Cards on a phone, the table from md. Seven columns cannot reflow, and the row
            is read across — who, how far through, what is waiting on whom. */}
        <div className="space-y-2 md:hidden" data-testid="physio-review-mobile">
          {visible.map((p, i) => {
            const badge = STATUS_BADGE[p.review_status];
            return (
              <div key={p.lead_id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`physio-review-patient-${p.lead_id}`}>
                {/* Not a control. Opening a week picker here offered work that is tracked
                    elsewhere; Send for Review below is what this list actually does. */}
                <div className="flex w-full items-start gap-2.5 text-left">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                    {p.lead_name?.charAt(0)?.toUpperCase() || "?"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">
                      <span className="mr-1.5 font-semibold text-slate-300">{i + 1}.</span>{p.lead_name}<LeadMarks lead={p} className="ml-1.5" />
                    </p>
                    <p className="truncate text-[10px] text-slate-400">
                      {p.patient_number || "—"}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {/* "11 / 7 sessions" was nonsense for anyone past their first
                          milestone. Show what they've done, then either that they've
                          reached a milestone or which day brings the next one.

                          Days, not sessions: treatment_days counts the dates the patient
                          attended on, so a rehab day and a treatment day on one morning
                          are the one day they were. */}
                      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold ${
                        p.due_for_review ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                      }`}>
                        {p.treatment_days} day{p.treatment_days === 1 ? "" : "s"} done
                      </span>
                      {!p.due_for_review && !p.review_status && (
                        <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                          next review on day {(Math.floor(p.treatment_days / threshold) + 1) * threshold}
                        </span>
                      )}
                      {p.review_number > 0 && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                          {ordinal(p.review_number)} Review
                        </span>
                      )}
                      {badge && (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  {p.due_for_review && (
                    <SendForReviewButton
                      className="flex-1"
                      onClick={() => setDraft({ patient: p, reason: "", physio_notes: "" })}
                      testid={`physio-raise-review-${p.lead_id}`}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className={`text-xs ${p.due_for_review ? "shrink-0" : "flex-1"}`}
                    onClick={() => setViewing(p)}
                    data-testid={`physio-review-view-mobile-${p.lead_id}`}
                  >
                    <Eye className="mr-1 h-3.5 w-3.5" />View
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block" data-testid="physio-review-desktop">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="w-12 px-4 py-2.5 font-semibold">S.No</th>
                  <th className="px-4 py-2.5 font-semibold">Patient</th>
                  <th className="px-4 py-2.5 font-semibold">Days</th>
                  <th className="px-4 py-2.5 font-semibold">Review</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((p, i) => {
                  const badge = STATUS_BADGE[p.review_status];
                  return (
                    <tr
                      key={p.lead_id}
                      className="hover:bg-slate-50"
                      data-testid={`physio-review-row-${p.lead_id}`}
                    >
                      <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                            {p.lead_name?.charAt(0)?.toUpperCase() || "?"}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-800">{p.lead_name}<LeadMarks lead={p} className="ml-1.5" /></p>
                            <p className="truncate text-[11px] text-slate-400">{p.patient_number || "—"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold ${
                          p.due_for_review ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                        }`}>
                          {p.treatment_days} done
                        </span>
                        {!p.due_for_review && !p.review_status && (
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            next on day {(Math.floor(p.treatment_days / threshold) + 1) * threshold}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {p.review_number > 0
                          ? <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">{ordinal(p.review_number)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {badge
                          ? <span className={`inline-flex whitespace-nowrap items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {p.due_for_review && (
                            <SendForReviewButton
                              onClick={(e) => { e.stopPropagation(); setDraft({ patient: p, reason: "", physio_notes: "" }); }}
                              testid={`physio-raise-review-row-${p.lead_id}`}
                            />
                          )}
                          {/* Always offered, review or not: the dialog is the only place
                              the Head Physio's written report can be read from this board,
                              and with no review yet it still answers who the patient is. */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setViewing(p); }}
                            title="View review and patient details"
                            aria-label={`View ${p.lead_name || "patient"} review`}
                            className="rounded p-1.5 text-slate-400 transition hover:bg-sky-50 hover:text-sky-600"
                            data-testid={`physio-review-view-${p.lead_id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {/* Reading one back. The board could raise a review and show its status, but the
          Head Physio's written report — the thing the whole hand-off exists to produce —
          could not be read here at all. */}
      {viewing && (() => {
        const rev = reviews.find((r) => r.id === viewing.review_id)
          // The row's review_id is null once a fresh milestone reopens eligibility, so fall
          // back to this patient's most recent review rather than showing nothing.
          || [...reviews].filter((r) => r.lead_id === viewing.lead_id)
            .sort((a, b) => (b.raised_at || "").localeCompare(a.raised_at || ""))[0]
          || null;
        const badge = STATUS_BADGE[rev?.status || viewing.review_status];
        const Line = ({ label, children }) => (
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
            <p className="mt-0.5 break-words text-sm text-slate-700">{children || "—"}</p>
          </div>
        );
        const Report = ({ label, text, tone }) => (
          <div className={`rounded-lg border p-3 ${tone}`}>
            <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">{label}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{text?.trim() || "Not written yet."}</p>
          </div>
        );
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" onClick={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
            <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" data-testid="physio-review-view-modal">
              <div className="flex shrink-0 items-center justify-between gap-3 bg-slate-500 px-5 py-4 text-white">
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold">{viewing.lead_name}</p>
                  <p className="truncate text-xs text-white/80">
                    {viewing.patient_number || "—"}
                    {rev?.review_number || viewing.review_number ? ` · ${ordinal(rev?.review_number || viewing.review_number)} Review` : ""}
                  </p>
                </div>
                <button onClick={() => setViewing(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" aria-label="Close" data-testid="physio-review-view-close">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <Line label="Package">{rev?.session_package_name || viewing.session_package_name}</Line>
                  <Line label="Treatment Days Done">{viewing.treatment_days}</Line>
                  <Line label="Status">
                    {badge
                      ? <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                      : "No review raised yet"}
                  </Line>
                  <Line label="Raised By">{rev?.physio_name}</Line>
                  <Line label="CONSULTANT">{rev?.head_physio_name}</Line>
                </div>

                {rev ? (
                  <>
                    <Report label="Reason for Review" text={rev.reason} tone="border-slate-200 bg-white text-slate-700" />
                    <Report label="Physio's Notes" text={rev.physio_notes} tone="border-sky-200 bg-sky-50 text-sky-900" />
                    {/* The two the Head Physio writes back. Shown even while empty, so the
                        physio can see the review is still with them rather than wondering
                        whether the board simply failed to load it. */}
                    <Report label="CONSULTANT's Review" text={rev.head_physio_notes} tone="border-violet-200 bg-violet-50 text-violet-900" />
                    <Report label="Suggestions" text={rev.head_physio_suggestions} tone="border-emerald-200 bg-emerald-50 text-emerald-900" />
                  </>
                ) : (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
                    No review has been raised for this patient yet.
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Raising the review — reason and notes travel with it to the Head Physio. */}
      {draft && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" onClick={(e) => { if (e.target === e.currentTarget) setDraft(null); }}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl" data-testid="physio-raise-review-modal">
            <div className="flex items-center justify-between bg-slate-500 px-6 py-4 text-white">
              <div>
                <p className="text-lg font-bold">Send for Review</p>
                <p className="text-xs text-white/80">
                  {draft.patient.lead_name} · {ordinal(draft.patient.review_number)} Review · {draft.patient.treatment_days} treatment days
                </p>
              </div>
              <button onClick={() => setDraft(null)} className="rounded-lg border-2 border-orange-200 bg-orange-100 p-2 text-orange-600 hover:bg-orange-200" data-testid="physio-raise-review-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Reason</label>
                <Input
                  value={draft.reason}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  placeholder="e.g. Week 1 progress review"
                  data-testid="physio-raise-review-reason"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">
                  Notes for the CONSULTANT <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={4}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                  placeholder="How has the patient responded so far?"
                  value={draft.physio_notes}
                  onChange={(e) => setDraft({ ...draft, physio_notes: e.target.value })}
                  data-testid="physio-raise-review-notes"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
              <Button variant="outline" onClick={() => setDraft(null)} data-testid="physio-raise-review-cancel">Cancel</Button>
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={submitRaise} disabled={saving} data-testid="physio-raise-review-submit">
                {saving ? "Sending..." : "Send to Branch Admin"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConsultationDetailModal({ lead, physioId, onClose, onDone }) {
  const [submitting, setSubmitting] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [assessments, setAssessments] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [reviewEvery, setReviewEvery] = useState(REVIEW_EVERY);
  // The review the next day of this course is waiting on, straight off the server, and the
  // sentence it hands back to say so. Read rather than worked out here: the milestone is
  // decided by a count of distinct calendar dates across both courses, and a browser copy
  // of that arithmetic is a second chance for this list to offer a day the server refuses.
  // null when no day is held.
  const [reviewHold, setReviewHold] = useState(null);
  const [reviewHoldMessage, setReviewHoldMessage] = useState("");
  // Every paid session used with a Treatment Fee balance owing: the next treatment day waits
  // until the balance is paid or the Branch Admin extends the due date. Off the server, the
  // same as the review hold, and for treatment days only -- rehab has its own fee.
  const [paymentHold, setPaymentHold] = useState(null);
  const [paymentHoldMessage, setPaymentHoldMessage] = useState("");
  const [completeTarget, setCompleteTarget] = useState(null);
  const [absentTarget, setAbsentTarget] = useState(null);
  const [confirmingComplete, setConfirmingComplete] = useState(false);
  // Opens on Treatment Days. The physio reaches this dialog from the day's list in order
  // to mark someone present or absent, and Overview first meant a tab change before every
  // single one of those. Overview is reference; this is the work.
  const [tab, setTab] = useState("days");
  // On: a day is worked only on its booked date. Off (Danger Zone): the open day can be
  // worked on any date. Days still go in order either way -- the server enforces that.
  const [dayDateLock, setDayDateLock] = useState(true);
  // Set only when this physio is covering an absent colleague's patient: the day list is
  // then just the covered days, and this is how far the whole course has actually gone.
  const [coverCourse, setCoverCourse] = useState(null);
  const isComplete = lead.physio_stage === "Complete";

  const loadSessions = useCallback(async () => {
    try {
      const data = await physioSessions(lead.id, physioId);
      setSessions(data.sessions || []);
      setAssessments(data.assessments || []);
      setReviews(data.reviews || []);
      // Falls back to the local constant only if an older server answers without it.
      if (data.review_after_days) setReviewEvery(data.review_after_days);
      // An older server answers without these, and no hold is the honest reading of that:
      // the popup would otherwise wall off every day on a deploy that has not landed yet.
      setReviewHold(data.review_hold || null);
      setReviewHoldMessage(data.review_hold_message || "");
      setPaymentHold(data.payment_hold || null);
      setPaymentHoldMessage(data.payment_hold_message || "");
      setDayDateLock(data.day_date_lock !== false);
      setCoverCourse(data.covering
        ? { daysDone: data.course_days_done || 0, finished: !!data.course_finished }
        : null);
    } catch { /* silent */ }
  }, [lead.id, physioId]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const markComplete = async () => {
    setSubmitting(true);
    try {
      const updated = await physioCompleteConsultation(lead.id, physioId);
      toast.success("Marked complete");
      setConfirmingComplete(false);
      onDone(updated);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to mark complete");
    }
    setSubmitting(false);
  };

  const todayIso = isoOf(new Date());
  // Next unpaid Treatment Fee installment on this client's record, if any.
  const paymentDue = ((lead.treatment_fee_payment_details?.installments) || [])
    .filter((i) => !i.paid)
    .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))[0] || null;
  const overdue = paymentDue && paymentDue.due_date < todayIso;

  const completedSessions = sessions.filter((s) => s.status === "completed");
  // Closing out a course of treatment is offered only once there is a finished course to
  // close. It was offered from the first day onwards, which put the end of the treatment
  // one press away throughout the whole of it -- on a 26-day rehab course, 25 days before
  // it could be true.
  //
  // A day awaiting a date from the Branch Admin is not completed, so it holds this shut
  // too, which is right: the course is not over while a day of it is unscheduled. An
  // absence never lands here at all -- v3_physio_board moves that day down the slots
  // rather than closing it -- so no day is completed by not happening.
  //
  // Nothing booked is the exception. Those patients have no day list to finish, and
  // without this they could never be marked complete from the only screen that can do it.
  // A cover's list is only the days handed to them, so finishing those is not finishing the
  // course — the final review and Mark Complete wait for the whole course to be over.
  const allDaysDone = coverCourse
    ? coverCourse.finished
    : sessions.length === 0 || completedSessions.length === sessions.length;
  const upcomingSession = sessions.find((s) => s.status === "upcoming") || null;
  const lastCompleted = completedSessions[completedSessions.length - 1] || null;

  // Every review point this patient's treatment has reached, and what became of each.
  //
  // This used to be a single number derived from the day count alone, which meant the
  // popup could only ever say "due" — it said so about week 1 while the Head Physio's
  // write-up of week 1 was already filed, and said nothing at all on day 8, when the day
  // count is no longer a multiple of seven but the review is still outstanding. The
  // records now come back with the sessions, so each milestone reports its own state.
  //
  // A milestone with no review against it is genuinely due: reaching seven days of
  // treatment is what makes one raisable, and nothing else creates the record.
  const reviewMilestones = useMemo(() => {
    // Calendar days attended, not completed rows. A patient on rehab and a treatment
    // package at once is booked twice on the same morning, and counting rows made four
    // mornings read as eight — the week-one banner appeared on their fourth day. Mirrors
    // _completed_day_counts on the server, which is what actually lets a review be raised.
    // A cover counts the whole course's days, not just the ones handed to them.
    const done = coverCourse ? coverCourse.daysDone : new Set(
      sessions
        .filter((s) => s.status === "completed")
        .map((s) => (s.slot_time || "").slice(0, 10))
        .filter(Boolean)
    ).size;
    const reached = Math.floor(done / reviewEvery);
    // Rank so that if a milestone somehow carries two records, the furthest-along one
    // describes it — a completed review is the more truthful thing to show.
    const rank = { send_to_review: 1, sent: 2, completed: 3 };
    const byNumber = new Map();
    for (const r of reviews) {
      const n = r.review_number || 0;
      if (n < 1) continue;
      const prev = byNumber.get(n);
      if (!prev || (rank[r.status] || 0) > (rank[prev.status] || 0)) byNumber.set(n, r);
    }
    // Counted off the milestones reached, then extended to cover any review already on
    // record beyond them — a review raised at day 14 stays on the list if a day is later
    // reopened and the count drops back under it.
    const highest = Math.max(reached, ...[...byNumber.keys()], 0);
    const rows = Array.from({ length: highest }, (_, i) => {
      const number = i + 1;
      return {
        number,
        firstDay: (number - 1) * reviewEvery + 1,
        lastDay: number * reviewEvery,
        review: byNumber.get(number) || null,
        isFinal: false,
      };
    });
    // The days a course of whole weeks leaves over. Ten days reaches one milestone, at
    // day 7, and then stops -- days 8, 9 and 10 belong to no week and had nothing to be
    // due about, so the course finished with its last days never written up. A course
    // shorter than a week had no milestone at all and was never reviewed once.
    //
    // Only once every day is done: until then those are days still being worked, and the
    // next whole week is when to read them. Matches _review_eligibility on the server,
    // which decides whether the review can actually be raised.
    if (allDaysDone && done > highest * reviewEvery) {
      const number = highest + 1;
      rows.push({
        number,
        firstDay: highest * reviewEvery + 1,
        lastDay: done,
        review: byNumber.get(number) || null,
        isFinal: true,
      });
    }
    return rows;
  }, [sessions, reviews, reviewEvery, allDaysDone, coverCourse]);

  // The milestone the course currently stands at — the closing one once every day is done,
  // which is the row _review_eligibility puts one past the last whole week on the server.
  // The list keeps every milestone the treatment ever reached; only the last of them is
  // the one still being waited on.
  const currentMilestone = reviewMilestones[reviewMilestones.length - 1] || null;
  // Whether the Head Physio still owes this patient a review. Mirrors the check
  // physio_complete_consultation now makes, so the button says no before it is pressed
  // rather than the server saying it after. A patient with no days booked reaches no
  // milestone and is owed nothing — they keep the button they have always had, which is
  // the only way their consultation can be closed at all.
  const reviewOwed = !!currentMilestone && currentMilestone.review?.status !== "completed";

  // The lowest still-open day before a given one, or null when it is next in line. The
  // server refuses out-of-order completion too; this is so the button can say why before
  // it is pressed rather than after.
  // Ordered inside the day's own course. Rehab and treatment run side by side on
  // one calendar and each number from 1, so without the track a treatment day left
  // open would report a rehab day out of order and neither could ever be ticked off.
  const firstOpenBefore = (s) => {
    const n = s.session_number || 0;
    const track = s.track || "treatment";
    const earlier = sessions
      .filter((x) => (x.track || "treatment") === track)
      .filter((x) => x.status !== "completed" && (x.session_number || 0) < n)
      .map((x) => x.session_number || 0);
    return earlier.length ? Math.min(...earlier) : null;
  };

  // Work at the top, history under it: every day still to be worked first, then every
  // day already signed off. Straight day order inside each half.
  //
  // One numbered run pushed the day that asks for something further down the list with
  // every day finished — seven days into a twelve-day course this tab opened onto seven
  // Complete badges, and the one row carrying a button was below the fold. The day
  // marked Opened is why the tab is being read, so it is the first row; the finished
  // days are a record and read perfectly well at the foot of the list.
  //
  // Nothing is pinned to get it there. The numbers still ascend within each half, and
  // the open day is by definition the lowest-numbered unfinished day of its course, so
  // ordering on that alone lands it at the top and leaves the days after it in the
  // order they will be worked.
  //
  // Treatment and rehab are separate courses that each number from 1, so they are kept
  // apart rather than interleaved into an impossible Day 1, Day 1, Day 2, Day 2.
  const orderedSessions = useMemo(() => {
    const doneRank = (s) => (s.status === "completed" ? 1 : 0);
    const trackRank = (s) => ((s.track || "treatment") === "rehab" ? 1 : 0);
    return [...sessions].sort(
      (a, b) =>
        doneRank(a) - doneRank(b) ||
        trackRank(a) - trackRank(b) ||
        (a.session_number || 0) - (b.session_number || 0)
    );
  }, [sessions]);

  // The two halves of that order, under headings of their own.
  //
  // The break was already there — done days sort to the bottom — but nothing named it, so
  // a twelve-day course read as one run of twelve rows in which the physio had to work out
  // where the record ended and the work began by reading the badge on every row. Upcoming
  // is what is left to do, Completed is what has been done, and each says how many.
  //
  // Filtered off orderedSessions rather than sorted twice, so the ordering above is the
  // only place that decides what comes before what.
  const upcomingDays = useMemo(() => orderedSessions.filter((s) => s.status !== "completed"), [orderedSessions]);
  const completedDays = useMemo(() => orderedSessions.filter((s) => s.status === "completed"), [orderedSessions]);

  // Each week of days goes to the Head Physio for a review appointment; that review
  // is only "completed" once they've written it up (status flips to reviewed).
  const totalWeeks = sessions.length ? Math.max(...sessions.map((s) => s.week_number || 1)) : 0;
  const reviewedWeeks = assessments.filter((a) => a.status === "reviewed").length;
  const allReviewed = totalWeeks > 0 && reviewedWeeks >= totalWeeks;

  const fmtDate = dayDate;

  const Stat = ({ label, children }) => (
    <p className="text-sm">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</span><br />
      {children}
    </p>
  );

  const Row = ({ label, value }) => (
    !value ? null : (
      <div>
        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <p className="text-xs text-slate-700">{value}</p>
      </div>
    )
  );

  /**
   * One day of the course, as a row.
   *
   * Lifted out of the list so Upcoming and Completed can both draw it. Written inline in
   * the map it would have had to be written twice, and the two copies would have had to
   * agree on all of: which day is open, which is blocked by an earlier one, which is held
   * for a review, and which is simply not due yet.
   */
  const dayRow = (s) => {
    const done = s.status === "completed";
    // The day an absence pushed off the end of the course. It holds no slot
    // until the Branch Admin puts it on one, so there is no date on which it
    // could be worked and nothing here to press.
    const awaiting = !done && (s.needs_assignment || !s.slot_time);
    // The earliest day still open before this one. Ordered on the day number,
    // not the date: an absence pushes a day past the one after it until that
    // one shifts too, and comparing dates would call the order broken.
    const blockedBy = done ? null : firstOpenBefore(s);
    // Held by a week nobody has written up yet. The server refuses the day
    // for this reason too, so the button says it rather than letting the
    // press come back as a red toast; it holds every day still to be worked,
    // on either course, because the day count the milestone is read off
    // counts both. Never the day that reaches the milestone -- that one is
    // what makes the review raisable, and holding it would be a deadlock.
    const heldByReview = !done && !!reviewHold;
    const heldByPayment = !done && !!paymentHold && (s.track || "treatment") === "treatment";
    // The day the course currently stands on: the lowest-numbered day of this
    // track that is still open. Day 1 until Day 1 is signed off, then Day 2,
    // then Day 3 — one open day at a time, in the order they are worked.
    //
    // This used to be whichever day fell on the date picked in the strip
    // behind the popup, which opened Day 3 for a patient who had not had
    // Day 1 yet: a day the server would refuse as out of order anyway.
    const isOpenDay = !done && !awaiting && blockedBy === null;
    // A day is worked on the date it was booked for and on no other. Today's
    // row carries Complete and Absent; every other row — gone by or still to
    // come — draws as what it is, a line in the treatment list with nothing on
    // it to press, so the one day actually being worked is the only one
    // offering an action.
    const dayIso = (s.slot_time || "").slice(0, 10);
    const isToday = !!dayIso && dayIso === todayIso;
    // With the date lock switched off in the Danger Zone, the open day is workable
    // whatever its date, and every other row stays a plain list entry.
    const workable = dayDateLock ? isToday : isOpenDay;
    const canWork = isOpenDay && workable;
    // The day the course stands on, on a date that has already gone by. Named
    // rather than left blank: an "Opened" day with no buttons on it reads as a
    // broken screen rather than a day whose date came and went. Distinct from
    // `missed` below, which is the absences the day already carries — this is a
    // date that passed with nothing recorded against it either way.
    const datePassed = isOpenDay && !!dayIso && dayIso < todayIso;
    // The dates this day was already booked for and the patient did not arrive. An
    // absence does not cancel the day — it slides the day onto the next slot and pushes
    // the rest of the course down one — so once the Branch Admin has re-dated it the row
    // is indistinguishable from a day that was always on this date. The physio reads
    // "Day 12, Thursday" with no way to know Thursday is this day's second date, and the
    // patient in front of them is a patient who has already missed one. Written by the
    // Absent button and never cleared, so it is a history rather than a status.
    const missed = s.absences || [];
    // Says which date is holding this day up, so the block reads as somewhere
    // to go rather than a dead end.
    const blockedByRow = blockedBy
      ? sessions.find(
          (x) =>
            (x.track || "treatment") === (s.track || "treatment") &&
            (x.session_number || 0) === blockedBy
        )
      : null;
    const blockedByDate = blockedByRow ? fmtDate(blockedByRow.slot_time) : null;
    return (
      <div
        key={s.id}
        className={`flex items-center gap-3 rounded-lg border p-3 ${
          done ? "border-emerald-200 bg-emerald-50/50"
          : awaiting ? "border-amber-200 bg-amber-50/60"
          : heldByReview && isOpenDay ? "border-amber-200 bg-amber-50/40"
          : isOpenDay ? "border-sky-200 bg-sky-50/40"
          : "border-slate-200 bg-white"
        }`}
        data-testid={`physio-treatment-day-${s.id}`}
      >
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-emerald-200 text-emerald-800"
          : awaiting ? "bg-amber-200 text-amber-800"
          : heldByReview && isOpenDay ? "bg-amber-200 text-amber-800"
          : isOpenDay ? "bg-sky-200 text-sky-800"
          : "bg-slate-100 text-slate-500"
        }`}>
          {s.session_number}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-700">
            {/* A rehab day says so, and carries no week: a rehab course is
                not cut into weeks, and printing "Week 0" over one is worse
                than printing nothing. Same wording the day list outside
                this popup uses, so one patient reads the same either way. */}
            {s.track === "rehab" ? "Rehab " : ""}Day {s.session_number} of {s.total_sessions}
            {s.track !== "rehab" && s.week_number ? ` · Week ${s.week_number}` : ""}
            {/* Marks the one day of the course that is open to be worked.
                It sorts to the head of the list, but a position is not a
                label — a day still awaiting a date from the Branch Admin
                heads the list too and cannot be worked — so the row says
                in words which day this is. */}
            {isOpenDay && (
              datePassed ? (
                // The date came and went with nothing signed off on it. Naming
                // it is all this screen can do — a day is worked on its own
                // date, so putting this one back in play is a new date from the
                // Branch Admin.
                <span className="rounded bg-rose-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-rose-700">
                  Overdue
                </span>
              ) : heldByReview ? (
                // The day is next in line and still cannot be worked. Saying
                // "Opened" over a button that refuses to open it is the one
                // reading that helps nobody.
                <span className="rounded bg-amber-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-amber-700">
                  Held for review
                </span>
              ) : (
                <span className="rounded bg-sky-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-sky-700">
                  Opened
                </span>
              )
            )}
            {/* Sits with Opened and Held for review because it is read the same way —
                at a glance, off the title line, while scanning the list for the day to
                work. The dates themselves go underneath. */}
            {missed.length > 0 && (
              <span
                className="rounded bg-amber-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-amber-700"
                data-testid={`physio-day-rescheduled-${s.id}`}
              >
                Rescheduled{missed.length > 1 ? ` ×${missed.length}` : ""}
              </span>
            )}
          </p>
          <p className={`text-[10px] ${awaiting ? "font-semibold text-amber-700" : "text-slate-400"}`}>
            {s.slot_time
              ? fmtDate(s.slot_time)
              : awaiting
                ? "Missed class — Branch Admin to give this day a date"
                : "—"}
          </p>
          {missed.length > 0 && (
            // Directly under the date this day now holds, because the two are one fact:
            // the day is here because it was not attended there. Who marked each absence
            // and whatever they wrote at the time hang off the tooltip — useful when it
            // is read, but not what the row is for.
            <p
              className="mt-0.5 text-[10px] font-semibold text-amber-700"
              title={missed
                .map((a) => `Absent on ${fmtDate(a.date) || a.date || "an unrecorded date"}${a.marked_by ? ` — marked by ${a.marked_by}` : ""}${a.remarks ? `: ${a.remarks}` : ""}`)
                .join("\n")}
              data-testid={`physio-day-missed-${s.id}`}
            >
              Missed {missed.length > 1 ? `${missed.length} times` : "once"} — was{" "}
              {missed.map((a) => fmtDate(a.date) || a.date).filter(Boolean).join(" · ") || "an unrecorded date"}
            </p>
          )}
          {(s.physio_treatments || []).length > 0 && (
            <div className="mt-1">
              <PhysioTreatmentChips names={s.physio_treatments} testid={`physio-day-treatments-${s.id}`} />
            </div>
          )}
          {/* Every note the day carries, each under its own name. `||`
              printed the treatment half and swallowed the rehab one, so a
              day written up with both -- which is every day signed off while
              the popup still offered two boxes -- read as half a record. */}
          {s.jr_physio_remarks && (
            <p className="mt-0.5 text-[10px] text-emerald-600"><span className="font-semibold">Treatment: </span>{s.jr_physio_remarks}</p>
          )}
          {s.rehab_remarks && (
            <p className="mt-0.5 text-[10px] text-emerald-600"><span className="font-semibold">Rehab: </span>{s.rehab_remarks}</p>
          )}
        </div>
        {done ? (
          // A finished day is a record, and until now it was a record with no way into it:
          // the treatments given and the note written on the day were on the server and
          // reachable from nowhere on this screen. CompleteSessionModal already reads a
          // completed session back as a summary rather than a form — this is the button
          // that gets to it.
          <div className="flex shrink-0 items-center gap-1.5">
            <SessionStars session={s} />
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">Complete</span>
            <Button
              size="sm"
              variant="outline"
              className="border-emerald-200 text-xs text-emerald-700 hover:bg-emerald-50"
              onClick={() => setCompleteTarget(s)}
              data-testid={`physio-view-day-${s.id}`}
            >
              <Eye className="mr-1 h-3 w-3" /> View
            </Button>
          </div>
        ) : awaiting ? (
          // No button: the physio cannot place this day. Only the Branch Admin
          // books onto the published calendar, so this says who has it rather
          // than offering an action that would be refused.
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold text-amber-700"
            title="An absence pushed this day past the end of the booked slots. Branch Admin assigns it a new date."
            data-testid={`physio-day-awaiting-${s.id}`}
          >
            <AlertCircle className="h-3 w-3" /> Needs a date
          </span>
        ) : !workable ? (
          // Not today. Complete and Absent belong to the day being worked, and
          // only one date is being worked, so this row is a list entry and
          // nothing more. The title line already says which day it is and
          // whether its date has gone by.
          null
        ) : blockedBy ? (
          // Treatment runs in order, so a later day cannot be ticked off
          // while an earlier one is open. Said in the button's tooltip
          // rather than only refused by the server after the press.
          <Button
            size="sm"
            disabled
            className="shrink-0 bg-slate-100 text-xs text-slate-400 hover:bg-slate-100"
            title={`Day ${blockedBy}${blockedByDate ? ` on ${blockedByDate}` : ""} has to be finished first`}
            data-testid={`physio-day-out-of-order-${s.id}`}
          >
            <Check className="mr-1 h-3 w-3" /> After Day {blockedBy}
          </Button>
        ) : canWork ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="border-amber-200 text-xs text-amber-700 hover:bg-amber-50"
              onClick={() => setAbsentTarget(s)}
              data-testid={`physio-absent-day-${s.id}`}
            >
              <UserX className="mr-1 h-3 w-3" /> Absent
            </Button>
            {heldByPayment ? (
              // Paid sessions used up. Said on the button, as the review hold is; the
              // banner above the list says what is owed and who can release it.
              <Button
                size="sm"
                disabled
                className="bg-rose-100 text-xs text-rose-700 hover:bg-rose-100"
                title={paymentHoldMessage}
                data-testid={`physio-day-payment-held-${s.id}`}
              >
                <AlertCircle className="mr-1 h-3 w-3" /> Payment due
              </Button>
            ) : heldByReview ? (
              // A week of treatment is read before the next one is worked.
              // The same refusal the server makes, said on the button that
              // would otherwise offer the day and have the press thrown
              // back; the milestone banner above names the week and says
              // who is holding it.
              <Button
                size="sm"
                disabled
                className="bg-amber-100 text-xs text-amber-700 hover:bg-amber-100"
                title={reviewHoldMessage}
                data-testid={`physio-day-review-held-${s.id}`}
              >
                <AlertCircle className="mr-1 h-3 w-3" /> Review due
              </Button>
            ) : (
              <Button
                size="sm"
                className="bg-sky-600 text-xs text-white hover:bg-sky-700"
                onClick={() => setCompleteTarget(s)}
                data-testid={`physio-complete-day-${s.id}`}
              >
                <Check className="mr-1 h-3 w-3" /> Complete
              </Button>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" data-testid="physio-consultation-detail-modal">
        {/* Plain white header, as the Pre-Sales detail popup uses. The day count keeps
            its emphasis by going sky on a tinted chip — on the old slate bar it was
            carried by white-on-colour, which there is no colour left to do. */}
        <div className="flex shrink-0 items-start justify-between gap-3 bg-white px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold text-slate-900">{lead.name}</h3>
            {lead.patient_number ? <p className="truncate text-xs text-slate-500">{lead.patient_number}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="whitespace-nowrap rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm font-bold text-sky-700">
              {completedSessions.length}/{sessions.length} days
            </span>
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
          </div>
        </div>

        {/* One popup, four things in it: what is happening now, what the Head Physio
            wrote, the day list to tick off, and the patient's files. Stacked, that was a
            long scroll where the Complete button — the reason the popup is open — sat far
            below the reading material. Tabs keep each within one screen.
            Overview leads because it answers "what am I doing with this patient today". */}
        {/* shrink-0 is load-bearing. This is a flex column at max-h-[90vh], and a flex
            child defaults to shrink:1 — with a long day list the tab row was squeezed
            shorter than its own text, so the sky underline rode up through the labels and
            "Treatment Days" came out struck through. */}
        {/* Tabs down one side, Mark Treatment Complete down the other. The button used to
            sit at the foot of the Treatment Days list, which meant the one action that
            closes out a course of treatment was reachable from one tab of three and only
            after scrolling past every day in it. It reads as what it is up here: an
            action on this patient, not on the list.

            The scroll lives on the tabs alone rather than on this row. Put it on the row
            and the button is part of the scrolled content -- it would slide off the right
            edge on a narrow screen, which is the one place it must not go. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 sm:px-5" data-testid="physio-detail-tabs">
          {/* w-max inside min-w-0 + overflow-x-auto: the tabs keep their natural width and
              scroll within whatever the button leaves them, rather than being squeezed
              narrower than their own labels. */}
          <div className="min-w-0 overflow-x-auto">
            <div className="flex w-max gap-1">
              {MODAL_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-medium transition sm:px-3 sm:py-2 sm:text-xs ${
                    tab === t.key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                  data-testid={`physio-detail-tab-${t.key}`}
                >
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                  {t.key === "days" && sessions.length > 0 && (
                    <span className={`text-[10px] font-semibold ${tab === t.key ? "text-white/70" : "text-slate-400"}`}>
                      {completedSessions.length}/{sessions.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {allDaysDone && (
          <button
            type="button"
            onClick={() => setConfirmingComplete(true)}
            disabled={isComplete || submitting || reviewOwed}
            // Says which of the two it is waiting on. Disabled with no reason given reads
            // as broken, and the reason is on the tab behind this one.
            title={reviewOwed ? "The CONSULTANT hasn't reviewed this patient yet — raise it from the Review tab first" : undefined}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition sm:px-3.5 sm:py-2 sm:text-xs ${
              isComplete
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                // Amber rather than greyed out: this is the state the patient is actually
                // in — waiting on the review — not a button that happens to be off, and it
                // matches the milestone banner on the Treatment Days tab saying the same.
                : reviewOwed
                  ? "cursor-not-allowed border-amber-200 bg-amber-50 text-amber-700"
                  : "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100"
            }`}
            data-testid="physio-consultation-complete"
          >
            {reviewOwed && !isComplete ? <AlertCircle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            {isComplete ? "Complete" : submitting ? "Marking..." : reviewOwed ? (
              // The course cannot be closed until the review is written, so the button
              // names what it is waiting for instead of offering an action it will refuse.
              <>
                <span className="sm:hidden">Review Due</span>
                <span className="hidden sm:inline">Awaiting CONSULTANT Review</span>
              </>
            ) : (
              // "Mark Treatment Complete" alongside three tabs overruns a phone. Shortened
              // there rather than allowed to push the tabs into a scroll they don't need.
              <>
                <span className="sm:hidden">Mark Done</span>
                <span className="hidden sm:inline">Mark Treatment Complete</span>
              </>
            )}
          </button>
          )}
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {tab === "overview" && (
          <div className="rounded-xl border-2 border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Stat label="Physio">
                <span className="text-slate-700">{lead.assigned_physio_name || "—"}</span>
              </Stat>
              <Stat label="Time">
                <span className="font-semibold text-violet-700">{lead.appointment_time ? to12h(lead.appointment_time) : "—"}</span>
              </Stat>
              <Stat label="Payment Due">
                {paymentDue ? (
                  <span className={overdue ? "font-bold text-rose-600" : "font-bold text-amber-600"}>
                    Rs.{paymentDue.amount} · {fmtDate(paymentDue.due_date)}{overdue && " · OVERDUE"}
                  </span>
                ) : (
                  <span className="font-semibold text-emerald-600">Nothing due</span>
                )}
              </Stat>
              <Stat label="Upcoming">
                {upcomingSession ? (
                  <span className="font-semibold text-sky-700">
                    {fmtDate(upcomingSession.slot_time)}
                  </span>
                ) : (
                  <span className="text-slate-400">No future session booked</span>
                )}
              </Stat>
              <Stat label="Last Completed">
                {lastCompleted ? (
                  <span className="font-semibold text-emerald-600">
                    Day {lastCompleted.session_number} · {fmtDate(lastCompleted.completed_at || lastCompleted.slot_time)}
                  </span>
                ) : (
                  <span className="text-slate-400">None yet</span>
                )}
              </Stat>
              <Stat label="Stage">
                <span className="text-slate-700">{lead.physio_stage === "Complete" ? "Complete" : (lead.consultation_stage || "New Appointment")}</span>
              </Stat>
              <Stat label="Review Completed">
                {totalWeeks ? (
                  <span className={allReviewed ? "font-semibold text-emerald-600" : "font-semibold text-amber-600"}>
                    {reviewedWeeks} of {totalWeeks} week{totalWeeks === 1 ? "" : "s"}
                    {!allReviewed && " · awaiting CONSULTANT"}
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Stat>
            </div>
          </div>
          )}

          {/* Consultation Report sits under Overview rather than in a tab of its own —
              same patient, same question, and it used to take a second click to finish
              reading about them. */}
          {tab === "overview" && (
          <div className="mt-4 border-t border-slate-100 pt-4" data-testid="physio-consultation-report">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Consultation Report</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Row label="Address" value={lead.address} />
              <Row label="City / State" value={[lead.city, lead.state].filter(Boolean).join(", ")} />
              <Row label="Age" value={lead.age} />
              <Row label="Gender" value={lead.gender} />
              <Row label="Occupation" value={lead.occupation} />
              <Row label="Condition" value={lead.condition} />
              <Row label="Months of Pain" value={lead.months_of_pain} />
              <Row label="Appointment" value={lead.appointment_date ? `${lead.appointment_date}${lead.appointment_time ? ` · ${to12h(lead.appointment_time)}` : ""}` : null} />
            </div>

            {lead.diagnosis && (
              <div className="mt-3 rounded-lg border border-slate-200 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Pre-Sales Diagnosis</p>
                <p className="text-xs text-slate-700 whitespace-pre-wrap">{lead.diagnosis}</p>
              </div>
            )}
            {lead.physio_diagnosis_report && (
              <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-sky-500">Diagnosis Report</p>
                <p className="text-xs text-sky-900 whitespace-pre-wrap">{lead.physio_diagnosis_report}</p>
              </div>
            )}
            {lead.treatment_summary && (
              <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-violet-500">Treatment Summary</p>
                <p className="text-xs text-violet-900 whitespace-pre-wrap">{lead.treatment_summary}</p>
              </div>
            )}
          </div>
          )}

          {/* The reviews themselves, week by week, directly under the Treatment Summary.
              Overview could only say how many weeks were outstanding -- a count, with no
              way to read what any CONSULTANT had actually written. The write-up lived on
              the Review tab of the board behind this popup, so the one screen that holds
              everything else about the patient held none of it.

              Every milestone the treatment has reached, in order, whatever became of it:
              a week still waiting says what is holding it, a week that is done prints the
              review and the suggestions that came back with it. */}
          {tab === "overview" && (
          <div className="mt-4 border-t border-slate-100 pt-4" data-testid="physio-overview-reviews">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
              Weekly Review
              {reviewMilestones.length > 0 && (
                <span className="ml-1 font-semibold text-slate-400">
                  ({reviewMilestones.filter((m) => m.review?.status === "completed").length} of {reviewMilestones.length} written)
                </span>
              )}
            </p>

            {reviewMilestones.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                No review point reached yet — the first is due after {reviewEvery} treatment days.
              </div>
            ) : (
              <div className="space-y-2">
                {reviewMilestones.map((m) => {
                  const look = milestoneLook(m.review);
                  const t = MILESTONE_TONES[look.tone];
                  const on = m.review?.status === "completed"
                    ? fmtDate(m.review.completed_at)
                    : m.review?.status === "sent" ? fmtDate(m.review.review_date) : null;
                  const written = (m.review?.head_physio_notes || "").trim();
                  const suggestions = (m.review?.head_physio_suggestions || "").trim();
                  return (
                    <div
                      key={m.number}
                      className={`rounded-lg border p-3 ${t.box}`}
                      data-testid={`physio-overview-review-${m.number}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${t.text}`}>
                          <look.Icon className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            {/* Named the way the Treatment Days list names it, so the same
                                week is not "Week 3" on one tab and something else here. */}
                            {m.isFinal ? "Final review" : `Week ${m.number} review`} · day{m.lastDay > m.firstDay ? "s" : ""} {m.firstDay}{m.lastDay > m.firstDay ? `–${m.lastDay}` : ""}
                            <span className={`ml-1 font-normal ${t.soft}`}>
                              {look.line}{on ? ` · ${on}` : ""}
                            </span>
                          </span>
                        </p>
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${t.badge}`}>
                          {look.label}
                        </span>
                      </div>

                      {/* White rather than tinted: the milestone box already carries the
                          week's colour, and a violet card inside an emerald one turns
                          both to mud. The border and the label do the naming. */}
                      {(written || suggestions) && (
                        <div className="mt-2 space-y-2">
                          {written && (
                            <div className="rounded-lg border border-violet-200 bg-white p-2.5">
                              <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-violet-500">CONSULTANT&apos;s Review</p>
                              <p className="whitespace-pre-wrap break-words text-xs text-slate-700">{written}</p>
                            </div>
                          )}
                          {suggestions && (
                            <div className="rounded-lg border border-emerald-200 bg-white p-2.5">
                              <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-600">Suggestions</p>
                              <p className="whitespace-pre-wrap break-words text-xs text-slate-700">{suggestions}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Treatment days — one row per booked session, completed in order */}
          {tab === "days" && (
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
              Treatment Days {sessions.length > 0 && <span className="text-slate-400">({completedSessions.length} of {sessions.length} complete)</span>}
            </p>

            {paymentHold && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[11px] text-rose-800" data-testid="physio-payment-hold-banner">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <p className="font-semibold">Payment due — treatment on hold</p>
                  <p className="mt-0.5 leading-snug">{paymentHoldMessage}</p>
                  {paymentHold.extension?.status === "requested" && (
                    <p className="mt-1 font-semibold text-violet-700">The client has asked the Branch Admin for more time.</p>
                  )}
                </div>
              </div>
            )}

            {/* A review is raisable every seven treatment days. Nothing said so here, so a
                milestone was only noticed on the Review tab — which is the tab you go to
                after finishing a day, not during. Shown where the day was just ticked off.

                One row per milestone, kept once it has passed rather than replaced by the
                next: a patient twenty days in has had two reviews written about them, and
                that they happened is part of reading their treatment. The week still
                waiting is the only one that asks for anything. */}
            {reviewMilestones.length > 0 && (
              <div className="mb-3 space-y-1.5" data-testid="physio-review-milestones">
                {reviewMilestones.map((m) => {
                  const look = milestoneLook(m.review);
                  const t = MILESTONE_TONES[look.tone];
                  const on = m.review?.status === "completed"
                    ? fmtDate(m.review.completed_at)
                    : m.review?.status === "sent" ? fmtDate(m.review.review_date) : null;
                  return (
                    <div
                      key={m.number}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 ${t.box}`}
                      data-testid={`physio-review-milestone-${m.number}`}
                    >
                      <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${t.text}`}>
                        <look.Icon className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {/* A closing review covers what is left rather than a week, and
                              may be a single day, so it is named for what it is and reads
                              its range off the milestone instead of assuming seven. */}
                          {m.isFinal ? "Final review" : `Week ${m.number} review`} · day{m.lastDay > m.firstDay ? "s" : ""} {m.firstDay}{m.lastDay > m.firstDay ? `–${m.lastDay}` : ""}
                          <span className={`ml-1 font-normal ${t.soft}`}>
                            {look.line}{on ? ` · ${on}` : ""}
                          </span>
                        </span>
                      </p>
                      <span className="flex items-center gap-1.5">
                        {/* The one milestone actually holding the course up says so on its
                            own row. A patient several weeks in carries several of these
                            banners and only the last of them stops anything; without this
                            the physio has to work out which by reading all of them. */}
                        {reviewHold?.review_number === m.number && (
                          <span
                            className="rounded-md bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900"
                            title={reviewHoldMessage}
                            data-testid={`physio-review-hold-${m.number}`}
                          >
                            Days on hold
                          </span>
                        )}
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${t.badge}`}>
                          {look.label}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {sessions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                No treatment days booked yet — Branch Admin assigns these once the Treatment Fee is collected.
              </div>
            ) : (
              <div className="space-y-4">
                {/* Upcoming first: this popup is opened to work a day, and the day that
                    asks for something is in this half. Completed is the record underneath
                    it. The split was already in the ordering — nothing named it, so a
                    twelve-row list had to be read badge by badge to find where the record
                    ended and the work began. */}
                <div data-testid="physio-days-upcoming">
                  <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-600">
                    <Clock className="h-3.5 w-3.5" /> Upcoming
                    <span className="font-semibold text-slate-400">({upcomingDays.length})</span>
                  </p>
                  {upcomingDays.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/40 p-4 text-center text-xs text-emerald-700" data-testid="physio-days-upcoming-empty">
                      Every booked day is done.
                    </div>
                  ) : (
                    <div className="space-y-2">{upcomingDays.map(dayRow)}</div>
                  )}
                </div>

                <div data-testid="physio-days-completed">
                  <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Completed
                    <span className="font-semibold text-slate-400">({completedDays.length})</span>
                  </p>
                  {completedDays.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400" data-testid="physio-days-completed-empty">
                      No day has been signed off yet.
                    </div>
                  ) : (
                    <div className="space-y-2">{completedDays.map(dayRow)}</div>
                  )}
                </div>
              </div>
            )}

            {/* The note stays; the button that stood beside it has gone up to the tab
                row. It describes the per-day Complete buttons in the list above, never
                the whole-treatment one, so this is where it belongs. It no longer talks
                about the date strip: the day that is open is the next one of the course,
                not the one whose date happens to be picked behind the popup. */}
            <div className="mt-4 border-t border-slate-200 pt-3">
              <p className="text-[11px] text-slate-500">
                Days run in order — only the day marked Opened can be completed. Finishing
                it opens the day after it and drops the finished one to the bottom of this
                list. Every {reviewEvery} days the course stops for a CONSULTANT&apos;s review:
                the next day stays held until that review has been written, so raise it from
                the Review tab as soon as the week is finished.
              </p>
            </div>
          </div>
          )}

          {tab === "documents" && <DocumentsPanel leadId={lead.id} />}

        </div>

        {completeTarget && (
          <CompleteSessionModal
            session={completeTarget}
            // The whole course, so the tick-list can say how often each treatment has
            // been given already.
            sessions={sessions}
            onClose={() => setCompleteTarget(null)}
            onDone={() => { setCompleteTarget(null); loadSessions(); }}
          />
        )}

        {confirmingComplete && (
          <ConfirmTreatmentCompleteModal
            lead={lead}
            days={sessions.length}
            submitting={submitting}
            onCancel={() => setConfirmingComplete(false)}
            onConfirm={markComplete}
          />
        )}

        {absentTarget && (
          <MarkAbsentModal
            session={absentTarget}
            // The day that will come off the end — the highest-numbered day still holding a
            // slot. Named in the warning so the physio knows which one goes back to the
            // Branch Admin before agreeing to the move, not after.
            //
            // Read within the missed day's own track. A patient on rehab and a treatment
            // package at once has two runs of days numbered from 1, and the server steps
            // only through the collection the missed day belongs to — taking the highest
            // number across both would name a day of the other course, which nothing here
            // is about to move.
            lastDated={
              sessions
                .filter(
                  (x) =>
                    (x.track || "treatment") === (absentTarget.track || "treatment") &&
                    x.status !== "completed" &&
                    (x.slot_time || "").trim()
                )
                .reduce((hi, x) => Math.max(hi, x.session_number || 0), 0) || null
            }
            onClose={() => setAbsentTarget(null)}
            // Stays open on purpose: the whole schedule just moved, and closing would hide
            // the one thing worth checking. The parent list reloads when the popup closes.
            onDone={() => { setAbsentTarget(null); loadSessions(); }}
          />
        )}
      </div>
    </div>
  );
}

export function CalendarPage({ physioId, onClose }) {
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [data, setData] = useState({ sessions: [] });
  // Opens on today's date so the day detail panel doubles as the old "Today" tab —
  // no extra click needed to see today's sessions.
  const [selectedDate, setSelectedDate] = useState(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  });

  const load = useCallback(async () => {
    try { setData(await physioCalendar(currentMonth, currentYear, physioId)); } catch { /* silent */ }
  }, [currentMonth, currentYear, physioId]);

  useEffect(() => { load(); }, [load]);

  const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const firstDay = new Date(currentYear, currentMonth - 1, 1).getDay();

  const dateStr = (day) => `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const getSessionsForDay = (day) => {
    const d = dateStr(day);
    return (data.sessions || []).filter((s) => s.slot_time?.startsWith(d));
  };

  const prevMonth = () => { if (currentMonth === 1) { setCurrentMonth(12); setCurrentYear(currentYear - 1); } else setCurrentMonth(currentMonth - 1); };
  const nextMonth = () => { if (currentMonth === 12) { setCurrentMonth(1); setCurrentYear(currentYear + 1); } else setCurrentMonth(currentMonth + 1); };

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const daySessions = selectedDate ? (data.sessions || []).filter((s) => s.slot_time?.startsWith(selectedDate)) : [];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" data-testid="physio-calendar-page">
      <div className="flex items-center gap-2 border-b border-slate-200 p-4">
        <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" data-testid="physio-calendar-back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-sm font-semibold text-slate-800">My Calendar</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          {/* Calendar Grid */}
          <div className="flex-1 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between mb-4">
              <button type="button" onClick={prevMonth} className="p-1 rounded hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button>
              <h4 className="text-sm font-semibold text-slate-700">{monthNames[currentMonth]} {currentYear}</h4>
              <button type="button" onClick={nextMonth} className="p-1 rounded hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-2">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                <div key={d} className="text-center text-[10px] font-semibold text-slate-400 py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDay }, (_, i) => <div key={`e-${i}`} className="h-14 sm:h-16" />)}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const day = i + 1;
                const d = dateStr(day);
                const isToday = d === todayStr;
                const isSelected = d === selectedDate;
                const sessions = getSessionsForDay(day);
                const hasCompleted = sessions.some((s) => s.status === "completed");
                const hasUpcoming = sessions.some((s) => s.status === "upcoming");

                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setSelectedDate(d)}
                    className={`h-14 sm:h-16 rounded-lg text-xs font-medium p-1 flex flex-col items-center transition-all ${
                      isSelected ? "bg-sky-600 text-white" :
                      isToday ? "bg-sky-50 text-sky-700 border border-sky-200" :
                      "hover:bg-slate-50 text-slate-600"
                    }`}
                  >
                    <span>{day}</span>
                    {sessions.length > 0 && (
                      <div className="flex gap-0.5 mt-auto">
                        {hasUpcoming && <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? "bg-white" : "bg-sky-400"}`} />}
                        {hasCompleted && <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? "bg-white/60" : "bg-emerald-400"}`} />}
                        <span className={`text-[8px] ${isSelected ? "text-white/80" : "text-slate-400"}`}>{sessions.length}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Day Detail */}
          <div className="w-full sm:w-80 rounded-xl border border-slate-200 bg-white p-4 overflow-y-auto sm:max-h-[600px]">
            {!selectedDate ? (
              <div className="flex items-center justify-center h-32 sm:h-48">
                <div className="text-center">
                  <Calendar className="h-8 w-8 text-slate-200 mx-auto mb-2" />
                  <p className="text-xs text-slate-400">Select a date</p>
                </div>
              </div>
            ) : (
              <>
                <h4 className="text-sm font-semibold text-slate-700 mb-3">
                  {new Date(selectedDate + "T00:00").toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })}
                </h4>
                {daySessions.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-6">No sessions</p>
                ) : (
                  <div className="space-y-2">
                    {daySessions.map((s) => (
                      <div key={s.id} className={`rounded-lg border p-3 ${s.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-slate-700">{slotTo12h(s.slot_time)}</span>
                          <span className={`text-[9px] rounded-full px-1.5 py-0.5 font-semibold ${s.status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}>
                            {s.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600">{s.lead_name}</p>
                        <p className="text-[9px] text-slate-400">#{s.session_number} · W{s.week_number}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PatientsTab({ physioId, onCountChange, toolbarSlot }) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [historyTab, setHistoryTab] = useState("ongoing");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // review_number is only on /physio/reviews — merged in here so a patient's card
      // can show how many review milestones they've had without a second round trip
      // when opening their detail page.
      const [data, rev] = await Promise.all([physioPatients(physioId), physioReviews(physioId)]);
      const reviewByLead = Object.fromEntries((rev.patients || []).map((r) => [r.lead_id, r.review_number || 0]));
      setPatients((data.patients || []).map((p) => ({ ...p, review_number: reviewByLead[p.lead_id] || 0 })));
    } catch { /* silent */ }
    setLoading(false);
  }, [physioId]);

  useEffect(() => { load(); }, [load]);

  // Finished means the course is finished: every booked day done, 26 of 26. Read off
  // physio_stage, this said something else entirely — that flag is set when the physio
  // signs off their *initial consultation* of a lead (physio_complete_consultation), so a
  // patient was filed under Completed on the day they were taken on, with twelve days
  // still to run, and Ongoing stood empty while three people were mid-course.
  //
  // Nobody with no days booked counts as finished either: nothing has been completed,
  // so they wait in Ongoing until their course exists.
  const isCompleted = (p) => (p.total_sessions || 0) > 0 && (p.completed_sessions || 0) >= p.total_sessions;

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // No default range here, unlike Treatment. That tab is a day board and has to open on
  // some day; this one is a caseload, and a caseload opening pre-narrowed to today would
  // hide most of it behind a filter the physio never set.
  const [filterValue, setFilterValue] = useState(null);
  // Which patients have a treatment day inside the picked range. A patient carries no
  // date of their own — the course does — so the range is read off the calendar the
  // Treatment tab already reads, and a patient is in range when one of their days is.
  const [filterLeadIds, setFilterLeadIds] = useState(null);

  useEffect(() => {
    if (!filterValue) { setFilterLeadIds(null); return; }
    let cancelled = false;
    (async () => {
      const months = [];
      let y = filterValue.from.getFullYear(), m = filterValue.from.getMonth();
      const endY = filterValue.to.getFullYear(), endM = filterValue.to.getMonth();
      while (y < endY || (y === endY && m <= endM)) {
        months.push({ year: y, month: m + 1 });
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
      try {
        const results = await Promise.all(months.map((mo) => physioCalendar(mo.month, mo.year, physioId)));
        if (cancelled) return;
        const fromIso = isoOf(filterValue.from);
        const toIso = isoOf(filterValue.to);
        const ids = new Set(
          results
            .flatMap((r) => r.sessions || [])
            .filter((sn) => {
              const d = (sn.slot_time || "").slice(0, 10);
              return d && d >= fromIso && d <= toIso;
            })
            .map((sn) => sn.lead_id)
        );
        setFilterLeadIds(ids);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [filterValue, physioId]);

  // The counts on the two pills follow the search and the date range: they say how many
  // rows each pill would show, so a count that ignored the filters would be promising
  // patients the list underneath cannot produce.
  const matched = patients.filter((p) => {
    const q = search.trim().toLowerCase();
    if (q && !String(p.lead_name || "").toLowerCase().includes(q)) return false;
    if (filterLeadIds && !filterLeadIds.has(p.lead_id)) return false;
    return true;
  });
  const ongoingCount = matched.filter((p) => !isCompleted(p)).length;
  const completedCount = matched.filter(isCompleted).length;
  const visiblePatients = matched.filter((p) => (historyTab === "completed" ? isCompleted(p) : !isCompleted(p)));

  // Badge is who's still ongoing, not the whole caseload — it counts down to 0 once
  // every patient has finished their full treatment course. Off the whole caseload, not
  // off `matched`: the badge is read from the other two tabs, where this tab's search box
  // and date range are not on screen and cannot explain a number that moved.
  const outstanding = patients.filter((p) => !isCompleted(p)).length;
  useEffect(() => { onCountChange?.(outstanding); }, [outstanding, onCountChange]);

  // Portaled into the shared slot like the other two tabs', so a control sits in the same
  // place whichever tab is open.
  const toolbar = (
    <div className="flex w-full items-center gap-2 md:w-auto" data-testid="physio-patients-toolbar">
      {/* Ongoing / Completed, in the tool bar rather than on a row of its own beneath it,
          so this tab's chrome is the one row the Treatment tab's is. */}
      <div
        className={`${searchOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-lg border border-slate-200 bg-white p-0.5 md:flex-none sm:gap-1 sm:p-1`}
        data-testid="physio-patients-subtabs"
      >
        {[{ key: "ongoing", label: "Ongoing", count: ongoingCount }, { key: "completed", label: "Completed", count: completedCount }].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setHistoryTab(t.key)}
            aria-current={historyTab === t.key ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-[11px] font-medium transition sm:px-3 sm:text-xs ${
              historyTab === t.key ? "bg-sky-100 text-sky-700" : "text-slate-500 hover:bg-slate-50"
            }`}
            data-testid={`physio-history-subtab-${t.key}`}
          >
            {t.label} <span className="text-[10px] text-slate-400">({t.count})</span>
          </button>
        ))}
      </div>

      {searchOpen && (
        <div className="relative min-w-0 flex-1 md:w-[240px] md:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient by name..."
            className="h-10 pl-9 pr-9"
            data-testid="physio-patients-search"
          />
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearch(""); }}
            className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-slate-100"
            data-testid="physio-patients-search-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search, Date Filter, Refresh — the same three in the same order as Treatment.
          This tab used to carry Refresh alone, so a physio who had learned where the
          search box was on one tab found nothing there on the next. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {!searchOpen && (
          <button
            type="button"
            title="Search"
            aria-label="Search"
            onClick={() => setSearchOpen(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            data-testid="physio-patients-search-open"
          >
            <Search className="h-4 w-4" />
          </button>
        )}
        <DateFilterPopover value={filterValue} onChange={setFilterValue} testid="physio-patients-date-filter" centered iconOnly phoneIconOnly />
        {/* This tab had no Refresh at all — its caseload is a snapshot from when the board
            opened, so a session completed on Treatment left this list stale with no way to
            ask for a fresh one. */}
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="physio-patients-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="physio-patients-tab">
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}

      {visiblePatients.length === 0 && !loading ? (
        <div className="text-center py-16">
          <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
          <p className="text-sm text-slate-400">
            {search.trim() || filterValue
              ? "No patients match this search"
              : historyTab === "completed" ? "No completed patients yet" : "No patients assigned yet"}
          </p>
        </div>
      ) : (
        <>
        {/* Cards on a phone, the table from md — the split the Review tab already makes.
            Eight columns at min-w-[640px] left a phone showing Patient, Program and Done
            with the rest behind a sideways scroll nobody knew was there: Left, Total, the
            rating and the progress bar were all off screen. A card stacks the same figures
            instead, and the whole card opens the patient, like the row does. */}
        <div className="space-y-2 md:hidden" data-testid="physio-patients-mobile">
          {visiblePatients.map((p) => {
            const pct = p.total_sessions > 0 ? Math.round((p.completed_sessions / p.total_sessions) * 100) : 0;
            return (
              <button
                key={p.lead_id}
                type="button"
                onClick={() => setSelectedPatient(p)}
                className="block w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:bg-slate-50/70"
                data-testid={`physio-patient-card-${p.lead_id}`}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                    {p.lead_name?.charAt(0)?.toUpperCase() || "?"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{p.lead_name}</p>
                    <p className="truncate text-[11px] text-slate-400">{courseLine(p) || "—"}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {(p.tracks || []).map((t) => (
                        <span
                          key={t}
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${t === "rehab" ? "bg-cyan-100 text-cyan-700" : "bg-sky-100 text-sky-700"}`}
                        >
                          {t === "rehab" ? "Rehab" : "Treatment"}
                        </span>
                      ))}
                      {p.review_number > 0 && (
                        <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700">
                          {ordinal(p.review_number)} Review
                        </span>
                      )}
                      {p.star_average ? (
                        <span className="flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                          {Number(p.star_average).toFixed(1)}
                          <span className="font-normal text-slate-400">({p.star_count})</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-slate-300" />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-center">
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Done</p>
                    <p className="text-sm font-semibold text-emerald-600">{p.completed_sessions}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Left</p>
                    <p className="text-sm font-semibold text-sky-600">{p.remaining_sessions}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Total</p>
                    <p className="text-sm font-semibold text-slate-600">{p.total_sessions}</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400">{pct}%</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* A table from md up, like the other lists on the board. The arrow opens the
            patient's detail in a popup; the row opens it too. */}
        <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block" data-testid="physio-patients-table">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Program</th>
                <th className="px-4 py-3 text-center">Done</th>
                <th className="px-4 py-3 text-center">Left</th>
                <th className="px-4 py-3 text-center">Total</th>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Progress</th>
                <th className="w-12 px-4 py-3"><span className="sr-only">View</span></th>
              </tr>
            </thead>
            <tbody>
              {visiblePatients.map((p) => {
                const pct = p.total_sessions > 0 ? Math.round((p.completed_sessions / p.total_sessions) * 100) : 0;
                return (
                  <tr
                    key={p.lead_id}
                    onClick={() => setSelectedPatient(p)}
                    className="cursor-pointer border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70"
                    data-testid={`physio-patient-${p.lead_id}`}
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-slate-800">{p.lead_name}</p>
                      <p className="text-[11px] text-slate-400">{courseLine(p) || "—"}</p>
                    </td>
                    <td className="px-4 py-3">
                      {/* One badge per course: a patient can be running both at once. */}
                      <div className="flex flex-wrap items-center gap-1">
                        {(p.tracks || []).map((t) => (
                          <span
                            key={t}
                            className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${t === "rehab" ? "bg-cyan-100 text-cyan-700" : "bg-sky-100 text-sky-700"}`}
                            data-testid={`physio-patient-track-${p.lead_id}-${t}`}
                          >
                            {t === "rehab" ? "Rehab" : "Treatment"}
                          </span>
                        ))}
                        {p.review_number > 0 && (
                          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700">
                            {ordinal(p.review_number)} Review
                          </span>
                        )}
                        {!(p.tracks || []).length && !(p.review_number > 0) && <span className="text-slate-300">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-sm font-semibold text-emerald-600">{p.completed_sessions}</td>
                    <td className="px-4 py-3 text-center text-sm font-semibold text-sky-600">{p.remaining_sessions}</td>
                    <td className="px-4 py-3 text-center text-sm font-semibold text-slate-600">{p.total_sessions}</td>
                    {/* The client's weekly star rating of this physio, averaged. Stars only. */}
                    <td className="px-4 py-3" data-testid={`physio-patient-stars-${p.lead_id}`}>
                      {p.star_average ? (
                        <span className="flex items-center gap-1 text-sm font-semibold text-amber-600">
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                          {Number(p.star_average).toFixed(1)}
                          <span className="text-[10px] font-normal text-slate-400">({p.star_count})</span>
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-400">{pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        title="View details"
                        aria-label="View details"
                        onClick={(e) => { e.stopPropagation(); setSelectedPatient(p); }}
                        className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        data-testid={`physio-patient-view-${p.lead_id}`}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {selectedPatient && (
        <PatientDetailPage
          patient={selectedPatient}
          physioId={physioId}
          onClose={() => setSelectedPatient(null)}
          onRefresh={load}
        />
      )}
    </div>
  );
}

// Popup — Sessions / Treatment / Progression / Profile. Opened from the arrow on a row
// of the Patients table: full-screen on a phone, a centred panel from sm up.
export function PatientDetailPage({ patient, physioId, onClose, onRefresh }) {
  const [detailTab, setDetailTab] = useState("sessions");
  const [lead, setLead] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [sessionFilter, setSessionFilter] = useState("all"); // all | pending | completed
  const [viewSession, setViewSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState({ lead: false, sessions: false });

  // Settled, not all. The two calls answer about different things, and one refusing is no
  // reason to lose the other — Promise.all rejected the pair together, so a patient whose
  // record the server would not hand over lost their days with it. The page then read
  // "No sessions" for someone twenty-six days in, which is a different claim from "these
  // could not be loaded", and the empty catch meant nobody was told either.
  const load = useCallback(async () => {
    setLoading(true);
    const [leadRes, sessRes] = await Promise.allSettled([
      physioPatientDetail(patient.lead_id, physioId),
      physioSessions(patient.lead_id, physioId),
    ]);
    if (leadRes.status === "fulfilled") setLead(leadRes.value);
    if (sessRes.status === "fulfilled") setSessions(sessRes.value?.sessions || []);
    setFailed({ lead: leadRes.status === "rejected", sessions: sessRes.status === "rejected" });
    setLoading(false);
  }, [patient.lead_id, physioId]);

  useEffect(() => { load(); }, [load]);

  // Escape closes the popup, unless a day is open on top of it — that one closes first.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !viewSession) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewSession]);

  const pendingSessions = sessions.filter((s) => s.status !== "completed").length;
  const completedSessions = sessions.filter((s) => s.status === "completed").length;
  const visibleSessions = sessions.filter((s) => (
    sessionFilter === "pending" ? s.status !== "completed"
    : sessionFilter === "completed" ? s.status === "completed"
    : true
  ));

  // Rendered even when empty, as a dash. Dropping blank fields reflowed the grid for
  // every patient, which is the one thing a grid is for: Age under Age, City under City.
  const Row = ({ label, value }) => (
    <div>
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-xs text-slate-700">{value || <span className="text-slate-300">—</span>}</p>
    </div>
  );

  // No Payment History here: what a patient owes and has paid is the branch's business,
  // not the treating physio's. It stays available to Branch Admin and Accountant Manage.
  const TABS = [
    { key: "sessions", label: "Sessions" },
    { key: "treatment", label: "Treatment" },
    // Beside Treatment rather than after Profile: the clips are gathered as the course
    // runs, so it belongs with the work. Profile is the reference page you check, and
    // reads last for the same reason.
    { key: "progression", label: "Progression" },
    { key: "profile", label: "Profile" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="physio-patient-detail-page"
    >
    <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-slate-50 sm:h-[90vh] sm:rounded-2xl sm:shadow-2xl">
      {/* Everything on this page hangs off one centred column of the same width. Run
          full-bleed, the three tiles stretched the whole of a desktop monitor and nothing
          lined up with anything above or below them. */}
      <div className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
            {(patient.lead_name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-800">{patient.lead_name}</h2>
            <p className="truncate text-xs text-slate-400">
              {lead?.patient_number || ""}
            </p>
          </div>
          {/* The figures the card on the list was already showing. Opening a patient
              should not appear to change what is true about them. */}
          {sessions.length > 0 && (
            <div className="hidden shrink-0 text-right sm:block" data-testid="physio-patient-progress">
              <p className="text-sm font-bold text-slate-800">
                {completedSessions}<span className="font-normal text-slate-300"> / </span>{sessions.length}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Days done</p>
            </div>
          )}
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100" data-testid="physio-patient-back">
            <X className="h-5 w-5" />
          </button>
        </div>
        {sessions.length > 0 && (
          <div className="mx-auto w-full max-w-5xl px-4 pb-3 sm:px-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-500 transition-all"
                style={{ width: `${Math.round((completedSessions / sessions.length) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-4 sm:px-6" data-testid="physio-patient-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setDetailTab(t.key)}
              className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-xs font-medium transition ${
                detailTab === t.key ? "border-b-2 border-sky-500 text-sky-700" : "border-b-2 border-transparent text-slate-400 hover:text-slate-600"
              }`}
              data-testid={`physio-patient-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6">
        {detailTab === "sessions" && (
          <div className="space-y-3" data-testid="physio-patient-sessions-tab">
            <div className="grid grid-cols-3 gap-2">
              <StatTile
                icon={Clock} label="Pending" value={pendingSessions} color={TILE.pending}
                onClick={() => setSessionFilter("pending")} active={sessionFilter === "pending"} testid="physio-patient-stat-pending"
              />
              <StatTile
                icon={CheckCircle2} label="Completed" value={completedSessions} color={TILE.done}
                onClick={() => setSessionFilter("completed")} active={sessionFilter === "completed"} testid="physio-patient-stat-completed"
              />
              <StatTile
                icon={Calendar} label="Total" value={sessions.length} color={TILE.total}
                onClick={() => setSessionFilter("all")} active={sessionFilter === "all"} testid="physio-patient-stat-total"
              />
            </div>
            {loading ? (
              <p className="py-12 text-center text-xs text-slate-400">Loading days…</p>
            ) : failed.sessions ? (
              // Not "No sessions". That is a claim about the patient; this is a failure
              // to ask, and the two should never read the same.
              <div className="rounded-xl border border-dashed border-rose-200 bg-rose-50/50 py-10 text-center" data-testid="physio-patient-sessions-failed">
                <p className="text-xs font-semibold text-rose-700">Couldn't load this patient's days</p>
                <button type="button" onClick={load} className="mt-2 text-[11px] font-semibold text-rose-600 underline">Try again</button>
              </div>
            ) : visibleSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white py-12 text-center">
                <Calendar className="mx-auto h-6 w-6 text-slate-300" />
                <p className="mt-2 text-xs text-slate-400">
                  {sessions.length === 0 ? "No days booked for this patient yet" : `Nothing ${sessionFilter} on this course`}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleSessions.map((s) => {
                  const done = s.status === "completed";
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => setViewSession(s)}
                      className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${done ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white hover:border-sky-200"}`}
                      data-testid={`physio-patient-session-${s.id}`}
                    >
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-emerald-200 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>
                        {s.session_number}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-slate-700">
                          {s.track === "rehab"
                            ? `Rehab Day ${s.session_number} of ${s.total_sessions}`
                            : `Session #${s.session_number}${s.week_number ? ` · Week ${s.week_number}` : ""}`}
                        </p>
                        <p className="text-[10px] text-slate-400">{dayDate(s.slot_time) || "—"}</p>
                        {done && (s.physio_treatments || []).length > 0 && (
                          <p className="mt-0.5 truncate text-[10px] font-medium text-sky-700" data-testid={`physio-session-treatments-${s.id}`}>
                            {s.physio_treatments.join(" · ")}
                          </p>
                        )}
                        {/* Both, when both were written. Labelled only on the rehab line:
                            a treatment day's note is the expected one and naming it in a
                            one-line preview costs more room than it buys. */}
                        {done && s.jr_physio_remarks && (
                          <p className="mt-0.5 truncate text-[10px] text-emerald-600">{s.jr_physio_remarks}</p>
                        )}
                        {done && s.rehab_remarks && (
                          <p className="mt-0.5 truncate text-[10px] text-emerald-600"><span className="font-semibold">Rehab: </span>{s.rehab_remarks}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <SessionStars session={s} />
                        {/* Which course the day belongs to, named as the Treatment table
                            names it — a patient can be running both at once. */}
                        <span className={`hidden rounded-full px-2 py-0.5 text-[9px] font-semibold sm:inline ${s.track === "rehab" ? "bg-cyan-100 text-cyan-700" : "bg-sky-100 text-sky-700"}`}>
                          {s.track === "rehab" ? "Rehab" : "Treatment"}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                          {done ? "Completed" : "Pending"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {detailTab === "treatment" && (
          <div className="space-y-3" data-testid="physio-patient-treatment-tab">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Treatment Package</p>
              <p className="text-sm font-semibold text-slate-800">
                {lead?.session_package_name || "—"}{lead?.session_package_sessions ? ` · ${lead.session_package_sessions} sessions` : ""}
              </p>
            </div>
            {lead?.diagnosis && (
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Pre-Sales Diagnosis</p>
                <p className="whitespace-pre-wrap text-xs text-slate-700">{lead.diagnosis}</p>
              </div>
            )}
            {lead?.physio_diagnosis_report && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-sky-500">Diagnosis Report (CONSULTANT)</p>
                <p className="whitespace-pre-wrap text-xs text-sky-900">{lead.physio_diagnosis_report}</p>
              </div>
            )}
            {lead?.treatment_summary && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-violet-500">Treatment Summary (CONSULTANT)</p>
                <p className="whitespace-pre-wrap text-xs text-violet-900">{lead.treatment_summary}</p>
              </div>
            )}
            {/* What is on file for this patient, under the treatment it belongs to. The
                physio reads the scans and letters while working the course, and sending
                them to a tab of its own put the paperwork one screen away from the thing
                it is paperwork about. */}
            <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="physio-treatment-documents">
              <p className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Documents</p>
              <DocumentsPanel leadId={patient.lead_id} />
            </div>
            {lead && !lead.physio_diagnosis_report && !lead.treatment_summary && (
              <p className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
                No treatment details submitted by the CONSULTANT yet.
              </p>
            )}
            {!lead && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center" data-testid="physio-patient-treatment-empty">
                <p className="text-xs text-slate-400">{loading ? "Loading treatment details…" : "Couldn't load this patient's treatment details."}</p>
                {failed.lead && !loading && (
                  <button type="button" onClick={load} className="mt-2 text-[11px] font-semibold text-sky-600 underline">Try again</button>
                )}
              </div>
            )}
          </div>
        )}


        {detailTab === "profile" && !lead && (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center" data-testid="physio-patient-profile-empty">
            <p className="text-xs text-slate-400">{loading ? "Loading profile…" : "Couldn't load this patient's profile."}</p>
            {failed.lead && !loading && (
              <button type="button" onClick={load} className="mt-2 text-[11px] font-semibold text-sky-600 underline">Try again</button>
            )}
          </div>
        )}

        {detailTab === "profile" && lead && (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="physio-patient-profile-tab">
            <Row label="Patient Number" value={lead.patient_number} />
            <Row label="Age" value={lead.age} />
            <Row label="Gender" value={lead.gender} />
            <Row label="Occupation" value={lead.occupation} />
            <Row label="Address" value={lead.address} />
            <Row label="City / State" value={[lead.city, lead.state].filter(Boolean).join(", ")} />
            <Row label="Condition" value={lead.condition} />
            <Row label="Months of Pain" value={lead.months_of_pain} />
          </div>
        )}

        {/* The physio gathers the clips; verifying them and closing the case sheet is the
            branch's or the consultant's job, which is why canVerify is not simply true.
            The backend holds the same line — see close_case_sheet. */}
        {detailTab === "progression" && (
          <ProgressionTab leadId={patient.lead_id} canUpload canVerify={false} />
        )}
        </div>
      </div>

      {viewSession && (
        <CompleteSessionModal
          session={viewSession}
          sessions={sessions}
          onClose={() => setViewSession(null)}
          onDone={() => { setViewSession(null); load(); onRefresh?.(); }}
        />
      )}
    </div>
    </div>
  );
}

/**
 * The physiotherapy treatments given on one day, ticked off Super Admin's catalogue.
 *
 * The options are Services and Products > Physiotherapy Treatment and nothing else — the
 * same list a physio's calendar is published under. A typed-in treatment is deliberately
 * not offered: the tags are only worth something if every day across every patient uses
 * the same handful of words, and one free-text box would end that within a week. The
 * server holds the same line and refuses a name that is not on the catalogue.
 *
 * Several per day, because a session is rarely one modality — IFT and ultrasound and
 * manual therapy inside the same hour is an ordinary day.
 *
 * Ticks are written back in catalogue order rather than click order, so two days treated
 * with the same three things read identically and re-opening one does not look edited.
 *
 * The panel expands inline rather than floating. This sits inside a fixed, centred popup
 * no wider than a phone, so a measured dropdown would have to be pinned to the viewport
 * to escape it for no gain; the popup body scrolls, which is what makes a panel opening
 * below the search bar reachable on a short screen.
 *
 * Each name carries how many days of this patient's course it has already been given on,
 * because that is the question actually being asked over the tick-list — what has this
 * patient been having — and the only other way to answer it is to open every past day one
 * at a time. Counted by the caller, which is the only thing holding the rest of the days.
 */
function PhysioTreatmentPicker({ options, value, onChange, testPrefix, usage }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const names = options.map((o) => o.name);
  const known = new Set(names);
  // Anything held that is no longer on the catalogue is dropped from the ticks: a
  // treatment Super Admin has deleted is not one to offer on today's day.
  const checked = new Set((value || []).filter((n) => known.has(n)));
  const picked = names.filter((n) => checked.has(n));

  // Cleared on close rather than inside each thing that closes it, so the field cannot
  // come back holding last time's filter with the full list hidden behind it.
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const commit = (next) => onChange(names.filter((n) => next.has(n)));

  const toggle = (name) => {
    const next = new Set(checked);
    if (next.has(name)) next.delete(name); else next.add(name);
    commit(next);
  };

  // Numbered off the catalogue, not off the filtered view, so "3. Dry Needling" is still
  // number 3 once a search has narrowed the list to it. Display only — what is stored is
  // the plain name, which is what the server matches against.
  const numbered = options.map((o, i) => ({ ...o, n: i + 1 }));
  const q = query.trim().toLowerCase();
  const shown = q ? numbered.filter((o) => (o.name || "").toLowerCase().includes(q)) : numbered;
  const numberOf = (name) => (numbered.find((o) => o.name === name)?.n) || "";

  // Nothing is printed at zero: a treatment never yet given is the ordinary case on the
  // first day of a course, and a column of "0" against every line says nothing while
  // costing the width the names are using.
  const timesGiven = (name) => usage?.get?.(name) || 0;

  // Operates on what is on screen: with no search that is the whole catalogue, with one
  // it is the matches, which is what "select all" means while a filter is showing.
  const allShownChecked = shown.length > 0 && shown.every((o) => checked.has(o.name));
  const toggleAll = () => {
    const next = new Set(checked);
    if (allShownChecked) shown.forEach((o) => next.delete(o.name));
    else shown.forEach((o) => next.add(o.name));
    commit(next);
  };

  if (options.length === 0) {
    // Says where they come from rather than showing an empty box. A physio cannot add one
    // — the catalogue is Super Admin's — so the only useful thing here is who to ask.
    return (
      <p
        className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[11px] text-slate-400"
        data-testid={`${testPrefix}-empty`}
      >
        No physiotherapy treatments on the catalogue yet — Super Admin adds them in Services and Products &gt; Physiotherapy Treatment.
      </p>
    );
  }

  return (
    <div data-testid={`${testPrefix}-picker`}>
      {/* The bar is a search field. The chevron behind the divider on the right is what
          closes the list; the field itself only ever opens it, since typing into a box
          that closes the list it is filtering helps nobody. */}
      <div className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 transition ${open ? "border-sky-400 ring-1 ring-sky-100" : "border-slate-200"}`}>
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          placeholder="Search physio treatments..."
          className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-xs text-slate-700 outline-none placeholder:text-slate-400"
          data-testid={`${testPrefix}-search`}
        />
        <div className="shrink-0 border-l border-slate-200 pl-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={open ? "Hide physio treatments" : "Show physio treatments"}
            data-testid={`${testPrefix}-trigger`}
          >
            <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid={`${testPrefix}-panel`}>
          {/* Select All on the left, the running count on the right. The count is of the
              whole selection and not of what the search is showing — it is what gets
              saved, and a number that dropped every time you typed would be alarming. */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700" data-testid={`${testPrefix}-select-all`}>
              <input
                type="checkbox"
                checked={allShownChecked}
                onChange={toggleAll}
                disabled={shown.length === 0}
                className="h-3.5 w-3.5 shrink-0 accent-sky-600"
              />
              Select All
            </label>
            <span className="text-[11px] font-semibold text-teal-600" data-testid={`${testPrefix}-count`}>
              {picked.length} Selected
            </span>
          </div>

          <div className="max-h-52 overflow-y-auto p-1">
            {shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-slate-400" data-testid={`${testPrefix}-no-match`}>
                No physio treatment matches "{query.trim()}".
              </p>
            ) : (
              shown.map((o) => {
                const on = checked.has(o.name);
                return (
                  <label
                    key={o.id}
                    className={`flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs transition ${on ? "bg-sky-50 font-semibold text-sky-800" : "text-slate-700 hover:bg-slate-50"}`}
                    data-testid={`${testPrefix}-option-${o.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(o.name)}
                      className="h-3.5 w-3.5 shrink-0 accent-sky-600"
                    />
                    <span className="min-w-0 flex-1 truncate">{o.n}. {o.name}</span>
                    {/* At the end of the line, out of the name's way, so a long name still
                        truncates against the edge of the row rather than against this. */}
                    {timesGiven(o.name) > 0 && (
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${on ? "bg-sky-200 text-sky-800" : "bg-slate-100 text-slate-500"}`}
                        title={`Already given on ${timesGiven(o.name)} completed day${timesGiven(o.name) === 1 ? "" : "s"}`}
                        data-testid={`${testPrefix}-used-${o.id}`}
                      >
                        ×{timesGiven(o.name)}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* What is ticked, under the bar rather than inside it, one per line — a long name
          reads whole, and the day's treatments can be counted down at a glance, which is
          what someone about to sign the day off is doing. */}
      {picked.length > 0 ? (
        <div className="mt-2 max-h-36 space-y-1 overflow-y-auto" data-testid={`${testPrefix}-selected`}>
          {picked.map((n) => (
            <div key={n} className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-sky-800">{numberOf(n)}. {n}</span>
              {/* Repeated here so closing the list does not take the history with it —
                  this strip is what is read while the day is being signed off. */}
              {timesGiven(n) > 0 && (
                <span
                  className="shrink-0 rounded-full bg-sky-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-sky-800"
                  title={`Already given on ${timesGiven(n)} completed day${timesGiven(n) === 1 ? "" : "s"}`}
                  data-testid={`${testPrefix}-used-selected-${n}`}
                >
                  ×{timesGiven(n)}
                </span>
              )}
              <button
                type="button"
                onClick={() => toggle(n)}
                className="shrink-0 text-sky-400 transition hover:text-rose-600"
                aria-label={`Remove ${n}`}
                data-testid={`${testPrefix}-remove-${n}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-slate-400">Tick every treatment given in this session. Optional.</p>
      )}
    </div>
  );
}

// Doubles as a read-only "view summary" for an already-completed session — any
// session, in any stage, can be opened here; only an upcoming one gets an editable
// textarea and a submit button.
function CompleteSessionModal({ session, onClose, onDone, sessions }) {
  const [remarks, setRemarks] = useState(session.jr_physio_remarks || "");
  const [rehabRemarks, setRehabRemarks] = useState(session.rehab_remarks || "");
  // What was given on the day, off Super Admin's catalogue. A day already signed off
  // opens holding what it was tagged with, so this doubles as the read-back.
  const [treatments, setTreatments] = useState(session.physio_treatments || []);
  // Services and Products > Physiotherapy Treatment. Fetched per open rather than held on
  // the board: this popup is opened once a session, and a treatment added by Super Admin
  // mid-shift should be on the list the next time a physio signs a day off, not after a
  // reload of the whole board.
  const [physioTypes, setPhysioTypes] = useState([]);
  // One note per day, named after the course the day belongs to: a treatment day is
  // written up as treatment, a rehab day as rehab. Offering both asked for a note that
  // should not exist and let a day be signed off with the wrong half filled in — a
  // treatment day whose only note sat under "Rehab" read, everywhere downstream, as a
  // rehab record of a day that was not rehab. Days completed while both boxes were on
  // offer keep whatever they were written up with; the read-back below prints every note
  // a day actually carries, both of them when it carries both.
  const isRehab = session.track === "rehab";
  const [submitting, setSubmitting] = useState(false);
  const isDone = session.status === "completed";

  // How often this patient has already had each treatment, off the days already signed
  // off. It is what the picker prints beside every name.
  //
  // Both courses count. Someone running rehab and treatment at once is still one patient,
  // and "manual therapy, four times" is the true answer about them either way.
  //
  // The day being written up is left out of its own tally, as is every day still pending:
  // the number answers how many times before now, and one that climbed as the box was
  // ticked would be answering a different question in the same place.
  //
  // Empty when the caller passes no days — the count then simply does not appear, which is
  // the same thing the first day of a course shows.
  const treatmentUsage = useMemo(() => {
    const counts = new Map();
    (sessions || []).forEach((s) => {
      if (s.id === session.id || s.status !== "completed") return;
      // Per day, not per tick: a name stored twice on one old record is still the one day
      // it was given on.
      new Set(s.physio_treatments || []).forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    });
    return counts;
  }, [sessions, session.id]);

  // Silent on failure, and only for a day still to be signed off: the tick-list is not
  // what this popup is for, and a toast about a picklist over a physio trying to write up
  // a session is noise. A finished day reads its tags off the session itself and needs no
  // catalogue at all.
  useEffect(() => {
    if (isDone) return;
    getPhysioTypes().then(setPhysioTypes).catch(() => setPhysioTypes([]));
  }, [isDone]);

  // The day's own note is the report. Only one is asked for, so only that one can stand
  // in for a day having been written up at all.
  const hasReport = Boolean((isRehab ? rehabRemarks : remarks).trim());

  const handleSubmit = async () => {
    if (!hasReport) { toast.error(isRehab ? "Add Rehab Remarks" : "Add Treatment Remarks"); return; }
    setSubmitting(true);
    try {
      // Sent per track rather than both-and-empty: a treatment day posting a rehab note it
      // never showed a box for is how the wrong half got filled in the first place.
      const done = await physioCompleteSession(session.id, {
        remarks: isRehab ? "" : remarks,
        rehab_remarks: isRehab ? rehabRemarks : "",
        physio_treatments: treatments,
      });
      toast.success("Session completed");
      // The day just given used up (or nearly used up) what this client has paid for.
      const alert = done?.payment_alert;
      if (alert) {
        (alert.level === "due" ? toast.error : toast.warning)(
          alert.level === "due" ? "Payment due — inform the Branch Admin" : "Last paid session",
          { description: alert.message, duration: 12000 },
        );
        window.dispatchEvent(new Event(SESSION_PAYMENT_REFRESH_EVENT));
      }
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl bg-white shadow-2xl" data-testid="complete-session-modal">
        <div className="border-b p-5">
          {/* A rehab day is named as one here too, so the heading matches the row that was
              clicked and the only field underneath it. */}
          <h3 className="text-base font-semibold text-slate-800">
            {isDone
              ? `${isRehab ? "Rehab Day" : "Session"} ${session.session_number} Summary`
              : `Complete ${isRehab ? "Rehab Day" : "Session"} ${session.session_number}`}
          </h3>
          <p className="text-[10px] text-slate-400">{session.lead_name} · {dayDate(session.slot_time) || "—"}</p>
        </div>
        {/* Scrolls, and the header and footer do not. The tick-list expands inside this
            popup, so on a phone the Mark Complete button used to walk off the bottom of
            the screen the moment the list was opened. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {isDone ? (
            // A finished day reads back as what was written, with nothing standing in for
            // the half that was not -- an empty box under a heading says a note is missing
            // when the physio simply had none to make.
            <>
              {/* Above the notes, the same way the editor puts it above them: what was
                  done is read before what was written about it. */}
              {(session.physio_treatments || []).length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Physio Treatment</p>
                  <PhysioTreatmentChips names={session.physio_treatments} testid="session-summary-physio-treatments" />
                </div>
              )}
              {remarks.trim() && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Treatment Remarks</p>
                  <p className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="session-summary-treatment">{remarks}</p>
                </div>
              )}
              {rehabRemarks.trim() && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Rehab Remarks</p>
                  <p className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="session-summary-rehab">{rehabRemarks}</p>
                </div>
              )}
              {!remarks.trim() && !rehabRemarks.trim() && (
                <p className="text-sm italic text-slate-400">Completed without remarks.</p>
              )}
            </>
          ) : (
            <>
              {/* First, above the notes: what was done comes before what is written about
                  it, and a tick-list is quicker to answer than a paragraph. Not required
                  -- see the picker's own note -- so nothing here gates the button. */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Physio Treatment <span className="font-normal text-slate-400">(from Services and Products)</span>
                </label>
                <PhysioTreatmentPicker
                  options={physioTypes}
                  value={treatments}
                  onChange={setTreatments}
                  usage={treatmentUsage}
                  testPrefix="session-physio-treatment"
                />
              </div>

              {/* The one note this day is for. No tabs: with a box per track there was a
                  choice to get wrong, and a treatment day written up under "Rehab" is a
                  rehab record of a day that never was -- the Head Physio's review, the
                  patient's portal and the day list all read the two fields apart. */}
              {isRehab ? (
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Rehab Remarks <span className="font-normal text-slate-400">(visible to patient)</span>
                  </label>
                  <textarea
                    value={rehabRemarks}
                    onChange={(e) => setRehabRemarks(e.target.value)}
                    rows={4}
                    placeholder="Home programme, progress against the plan, precautions..."
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                    data-testid="session-rehab-remarks"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Treatment Remarks <span className="font-normal text-slate-400">(visible to patient)</span>
                  </label>
                  <textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    rows={4}
                    placeholder="Exercises done, observations, next steps..."
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                    data-testid="session-remarks"
                  />
                </div>
              )}

              {/* Said before the press rather than after: the button stays disabled until
                  the box above has something in it. */}
              <p className="text-[11px] text-slate-400" data-testid="session-remarks-hint">Required.</p>
            </>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t p-4">
          <Button variant="outline" size="sm" onClick={onClose}>{isDone ? "Close" : "Cancel"}</Button>
          {!isDone && (
            <Button size="sm" onClick={handleSubmit} disabled={submitting || !hasReport} className="bg-sky-600 hover:bg-sky-700 text-white" data-testid="session-complete-submit">
              {submitting ? "Completing..." : "Mark Complete"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
/**
 * Asked before a course of treatment is closed out.
 *
 * There is no undo on this screen: physioCompleteConsultation moves the patient to
 * Complete, and a physio has no way back from here. It also used to be a single press on
 * a button sitting a few pixels from the per-day Complete, which is pressed dozens of
 * times over a course -- the two are one slip apart, and only one of them is reversible.
 *
 * Says what will happen rather than "Are you sure?", which asks a question the answer to
 * depends on knowing what the button does.
 */
function ConfirmTreatmentCompleteModal({ lead, days, submitting, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl" data-testid="confirm-treatment-complete-modal">
        <div className="border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">Mark treatment complete?</h3>
          <p className="text-[10px] text-slate-400">{lead.name}</p>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[11px] text-emerald-800">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {days > 0
                ? <>All {days} day{days === 1 ? "" : "s"} of this treatment are finished. </>
                : null}
              {lead.name} moves to Complete and comes off your active list.
            </span>
          </div>
          <p className="text-[11px] text-slate-500">
            This cannot be undone from here — reopening the treatment is a Branch Admin's to do.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" size="sm" onClick={onCancel} data-testid="confirm-treatment-complete-cancel">Cancel</Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={submitting}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            data-testid="confirm-treatment-complete-submit"
          >
            {submitting ? "Marking..." : "Yes, mark complete"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The patient did not turn up. The day is not written off — it takes the next day's slot,
 * that day takes the one after, and so on, so the package still delivers the number of
 * treatment days it was sold as.
 *
 * Says so before the press rather than after: this rewrites the dates of every remaining
 * day, which is not something to discover from a list that quietly looks different. And it
 * names the day that comes off the end, because that one stops being the physio's to work
 * until the Branch Admin has given it a date.
 */
function MarkAbsentModal({ session, lastDated, onClose, onDone }) {
  const [remarks, setRemarks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Named the way the row behind this popup names it. The list says "Rehab Day 9 of 26"
  // and this said "Day 9", which reads as a day of the treatment package a rehab patient
  // may not even be on.
  const dayLabel = `${session.track === "rehab" ? "Rehab " : ""}Day ${session.session_number}`;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await physioMarkAbsent(session.id, { remarks });
      toast.success(res?.message || "Marked absent");
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't mark this day absent");
    }
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl" data-testid="mark-absent-modal">
        <div className="border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">Mark {dayLabel} Absent</h3>
          <p className="text-[10px] text-slate-400">
            {session.lead_name} · {dayDate(session.slot_time) || "—"}
          </p>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-800">
            <UserX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {dayLabel} takes the next day's slot, and every day after it moves
              down one. The patient still gets all {session.total_sessions} days — nothing is lost.
              {lastDated && lastDated !== session.session_number && (
                <>
                  {" "}
                  <b>{session.track === "rehab" ? "Rehab " : ""}Day {lastDated}</b> comes off the end and goes to the Branch Admin for a new date.
                </>
              )}
            </span>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Reason (optional)</label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              placeholder="Did not turn up, called in sick..."
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              data-testid="absent-remarks"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting} className="bg-amber-600 text-white hover:bg-amber-700" data-testid="absent-submit">
            {submitting ? "Moving..." : "Mark Absent & Move"}
          </Button>
        </div>
      </div>
    </div>
  );
}
