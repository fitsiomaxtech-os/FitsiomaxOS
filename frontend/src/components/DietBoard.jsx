import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  ClipboardCheck,
  Eye,
  Lock,
  RefreshCw,
  Salad,
  Search,
  Stethoscope,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { LeadMarks } from "@/components/ui/lead-marks";
import { ZoomableImage, ZoomablePdf } from "@/components/ui/zoomable-view";
import { dietChartUrl, dietConsultations, dietPatients, dietSessions, recommendDietChart, saveDietConsultationReport, sendDietChart } from "@/lib/api";
import { to12h } from "@/lib/time";
import { MyProfilePage } from "@/components/MyProfilePage";
import { ProfileNavGlyph } from "@/components/ui/employee-avatar";

/**
 * Diet Master View — the Nutrition Coach's own board.
 *
 * Two tabs: the consultations to work through, and the caseload behind them. It keeps the
 * Physio Master View's shape where it still applies, so a coach moving between the two
 * boards does not have to learn a second layout.
 *
 * Two things are intentionally absent, and their absence is the design rather than an
 * omission:
 *
 *   No Review tab. On the physio side reviews exist so a junior's work gets seen by a
 *   senior. One Nutrition Coach runs the whole vertical, so there is nobody above them for
 *   a review to route to. A Review tab here would be a queue that never fills.
 *
 *   No treatment-day terminology. These are check-in days against a diet plan, counted
 *   out of diet_sessions — a separate collection from `sessions`, so nothing here can be
 *   miscounted as physio treatment (see the module docstring in backend/routers/v3_diet.py).
 */

const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");

// One Refresh per tab, wired to that tab's own loader. Icon-only and grey — it is the one
// control that acts rather than filters, so it should not read as another filter chip, but
// it is not the loudest thing on the board either.
const RefreshBtn = ({ onClick, busy, testid }) => (
  <Button
    onClick={onClick}
    disabled={busy}
    title="Refresh"
    aria-label="Refresh"
    className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
    data-testid={testid}
  >
    <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
  </Button>
);

const VIEW_TABS = [
  { key: "consultations", label: "Consultations", icon: Stethoscope },
  { key: "patients", label: "Patients", icon: Users },
];

// The Human Resource Master View's stage card: white and bordered, a coloured label over a
// big coloured number, and selecting one brings its own colour to the border and a wash of
// it to the card. Each tile keeps a distinct colour so the queue reads at a glance rather
// than as three identical boxes.
//
// No icon and no sub-line, matching HR. The icon repeated what the label already said in
// the space the number wanted, and the sub-line ("Not yet on a plan") was a caption on a
// word that needs none.
const StatTile = ({ label, value, color = "#64748b", onClick, active, testid }) => {
  const Tag = onClick ? "button" : "div";
  const tagProps = onClick ? { type: "button", onClick, "data-testid": testid } : { "data-testid": testid };
  return (
    <Tag
      {...tagProps}
      className={`w-full min-w-0 rounded-lg border-2 px-2 py-2 text-center transition sm:rounded-xl sm:px-4 sm:py-4 sm:text-left ${
        active ? "shadow-sm" : `border-slate-200 bg-white ${onClick ? "hover:shadow-sm" : ""}`
      }`}
      style={active ? { borderColor: color, backgroundColor: `${color}14` } : undefined}
    >
      {/* Two lines' worth of height on a phone whether the label needs it or not: "New
          Consultation" wraps where "All" and "Completed" do not, and without this its
          number would sit a line lower than its neighbours'. Desktop truncates instead. */}
      <span
        className="block min-h-[2.3em] break-words text-[9px] font-bold uppercase leading-[1.15] sm:min-h-0 sm:truncate sm:text-xs sm:tracking-wider"
        style={{ color }}
        title={label}
      >
        {label}
      </span>
      <span className="mt-0.5 block text-lg font-extrabold leading-tight sm:mt-1 sm:text-3xl" style={{ color }}>
        {value}
      </span>
    </Tag>
  );
};

// One colour per tile, so a glance at the row says which number is which.
const TILE_COLORS = { referred: "#0ea5e9", waiting: "#f59e0b", booked: "#10b981", neutral: "#64748b" };

// `user` / `roleLabel` / `onLogout` add the phone bar's Profile stop (the coach's own
// board only -- Operations mounts this per coach without them). My Profile stands in the
// board's place with the bar under it, and Logout sits on its Security tab.
export const DietBoard = ({ coachId, user, roleLabel, onLogout } = {}) => {
  const [activeTab, setActiveTab] = useState("consultations");
  const [consultCount, setConsultCount] = useState(0);
  const [patientsCount, setPatientsCount] = useState(0);
  const badgeFor = { consultations: consultCount, patients: patientsCount };

  const [toolbarSlot, setToolbarSlot] = useState(null);
  const slotFor = (key) => (activeTab === key ? toolbarSlot : null);

  return (
    <div className="space-y-3 pb-20 md:pb-0" data-testid="diet-board-root">
      {/* Filled-pill tabs on a rule, the same control the Human Resource Master View uses.
          This is top-level navigation between three different jobs, and a filled pill says
          "you are here" more plainly than an underline does. Kept in emerald rather than
          HR's indigo so the vertical is still identifiable at a glance. */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4 md:border-b md:border-slate-200 md:pb-2" data-testid="diet-view-bar">
        <div className="hidden flex-wrap items-center gap-2 md:flex" data-testid="diet-view-tabs">
          {VIEW_TABS.map((tab) => {
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
                  active ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
                data-testid={`diet-view-tab-${tab.key}`}
              >
                <Icon className="h-4 w-4" /> {tab.label}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"}`}>
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div ref={setToolbarSlot} className="flex flex-wrap items-center gap-2" data-testid="diet-view-toolbar" />
      </div>

      <div style={{ display: activeTab === "consultations" ? "block" : "none" }}>
        <ConsultationsTab coachId={coachId} onCountChange={setConsultCount} toolbarSlot={slotFor("consultations")} />
      </div>
      <div style={{ display: activeTab === "patients" ? "block" : "none" }}>
        <PatientsTab coachId={coachId} onCountChange={setPatientsCount} toolbarSlot={slotFor("patients")} />
      </div>

      {user && activeTab === "profile" && (
        <MyProfilePage user={user} roleLabel={roleLabel} onBack={() => setActiveTab("consultations")} onLogout={onLogout} phoneBar />
      )}

      {/* Phones only — the tab strip above is desk-only. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="diet-bottom-nav">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {VIEW_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            const count = badgeFor[tab.key] || 0;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${isActive ? "text-white" : "text-slate-200"}`}
                data-testid={`diet-bottom-tab-${tab.key}`}
              >
                <span className="relative">
                  <Icon className="h-5 w-5" />
                  {count > 0 && (
                    <span className="absolute -right-2 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </span>
                {tab.label}
              </button>
            );
          })}
          {user && (
            <button
              type="button"
              onClick={() => setActiveTab("profile")}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${activeTab === "profile" ? "text-white" : "text-slate-200"}`}
              data-testid="diet-bottom-tab-profile"
            >
              <ProfileNavGlyph user={user} size={22} />
              Profile
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// The same five the other boards offer, in the same order and wording, so a coach who
// has used Consultations does not have to learn a second set of words for one idea.
//
// Compared as "YYYY-MM-DD" text rather than as Dates: appointment_date is stored that way,
// zero-padded, so string order is date order and no timezone gets a chance to move a
// booking a day either side of a boundary.
//
// Last 90 Days counts today as one of the ninety, the same reckoning DashboardBoard uses.
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shiftDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const DATE_PRESETS = [
  { key: "all", label: "All", range: () => null },
  { key: "today", label: "Today", range: () => { const t = isoOf(new Date()); return { from: t, to: t }; } },
  // Monday to Sunday, the week a clinic works to. getDay() calls Sunday 0, so it is pulled
  // back six days rather than one.
  { key: "this_week", label: "This Week", range: () => {
    const now = new Date();
    const mon = shiftDays(now, now.getDay() === 0 ? -6 : 1 - now.getDay());
    return { from: isoOf(mon), to: isoOf(shiftDays(mon, 6)) };
  } },
  { key: "this_month", label: "This Month", range: () => {
    const t = new Date();
    return { from: isoOf(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoOf(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
  } },
  { key: "last_90", label: "Last 90 Days", range: () => ({ from: isoOf(shiftDays(new Date(), -89)), to: isoOf(new Date()) }) },
];

/**
 * Diet Consultations — who is coming in, and who has already been seen.
 *
 * The list is everyone the Head Physio referred: `diet_recommended`, set when they chose
 * the patient's plan. That flag is the referral, so this queue and that decision cannot
 * disagree.
 *
 * Patients who already have a plan stay in the list, marked, rather than dropping out. A
 * coach needs to see what they have done as much as what is waiting, and a queue that
 * empties itself leaves no way to check the day back.
 */
function ConsultationsTab({ coachId, onCountChange, toolbarSlot }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("pending");
  // Opens on All. A board that opened on Today would hide every patient waiting to be
  // booked — they have no date to fall inside one — and the count on the card above would
  // stop matching the list under it.
  const [datePreset, setDatePreset] = useState("all");
  const [reportFor, setReportFor] = useState(null); // the patient whose report is open

  // A callback rather than an inline effect, so the toolbar's Refresh has something to
  // call. The Patients tab was already shaped this way.
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await dietConsultations(coachId)).patients || []); }
    catch { setRows([]); }
    setLoading(false);
  }, [coachId]);

  useEffect(() => { load(); }, [load]);

  // Completed means the coach has done what this patient was referred for, not that a slot
  // was booked. A consultation booked for next week has not happened, and a card counting it
  // as done would say so on the day it was booked.
  //
  // What is owed depends on which of the two the referral was for, because the clinic sells
  // two things under the word "diet" and they are finished by different acts. A Diet
  // Consultation is finished by the write-up — the thing the patient then reads in their own
  // portal, so it is the point at which the coach's work exists. A Diet Chart is finished by
  // sending the chart. A patient referred for both owes both.
  //
  // A patient referred ONLY for a chart never attends a consultation, so no report is ever
  // written for them. Judged on the report alone they would sit in New Consultation forever,
  // charted and delivered, with the badge counting work nobody could ever clear.
  //
  // Both flags false is the plain referral every consultation before them carries, and that
  // has always meant the report — so it still does.
  const chartOnly = (r) => !!r.diet_chart && !r.diet_consultation;
  const owesReport = (r) => !chartOnly(r) && !r.diet_consultation_report;
  const owesChart = (r) => !!r.diet_chart && !r.chart?.sent;
  const pending = rows.filter((r) => owesReport(r) || owesChart(r));
  const done = rows.filter((r) => !owesReport(r) && !owesChart(r));

  // The badge counts outstanding work, so it falls to zero as the coach writes them up
  // rather than holding at the referral total.
  useEffect(() => { onCountChange?.(pending.length); }, [pending.length, onCountChange]);

  // The diet consultation's own date, which is the one this board is about — not the
  // physio appointment the patient may also have.
  //
  // A patient with no date booked drops out of every range but All. That is what the
  // filter asks: "seen this week" cannot include somebody who is not booked at all, and
  // keeping them in would make Today mean "today, plus everyone with no day yet".
  const dateRange = DATE_PRESETS.find((d) => d.key === datePreset)?.range() || null;
  const visible = (filter === "done" ? done : filter === "all" ? rows : pending)
    .filter((r) => {
      if (!dateRange) return true;
      const on = r.appointment_date || "";
      return on >= dateRange.from && on <= dateRange.to;
    })
    .filter((r) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (r.lead_name || "").toLowerCase().includes(q) || (r.phone || "").includes(q);
    });

  // One row on every width. The search used to be w-full, which on a phone left the Refresh
  // no room and wrapped it onto a line of its own; it now takes the space left over beside
  // the button instead. min-w-0 so it can actually shrink — a flex item defaults to its
  // content's width and would push the button off the edge.
  const toolbar = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto" data-testid="diet-consult-toolbar">
      {/* Before the search, because it is the coarser cut: which days, then which patient
          within them. Wraps to its own line on a phone rather than squeezing the search
          box, which is the control that needs the room. */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5" data-testid="diet-consult-date-filter">
        {DATE_PRESETS.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => setDatePreset(d.key)}
            className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
              datePreset === d.key ? "bg-sky-500 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50"
            }`}
            data-testid={`diet-consult-date-${d.key}`}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="relative min-w-0 flex-1 sm:w-[260px] sm:flex-none">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient..." className="h-10 pl-9" data-testid="diet-consult-search" />
      </div>
      <RefreshBtn onClick={load} busy={loading} testid="diet-consult-refresh" />
    </div>
  );

  return (
    <div data-testid="diet-consultations-tab">
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}

      <div className="mb-4 grid grid-cols-3 gap-2 sm:gap-3">
        <StatTile label="All" value={rows.length} color={TILE_COLORS.referred} onClick={() => setFilter("all")} active={filter === "all"} testid="diet-consult-stat-all" />
        <StatTile label="New Consultation" value={pending.length} color={TILE_COLORS.waiting} onClick={() => setFilter("pending")} active={filter === "pending"} testid="diet-consult-stat-waiting" />
        <StatTile label="Completed" value={done.length} color={TILE_COLORS.booked} onClick={() => setFilter("done")} active={filter === "done"} testid="diet-consult-stat-seen" />
      </div>


      {loading ? (
        <p className="py-16 text-center text-sm text-slate-400">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="py-16 text-center">
          <Stethoscope className="mx-auto mb-3 h-10 w-10 text-slate-200" />
          <p className="text-sm text-slate-400">
            {filter === "done"
              ? "Nothing finished yet. A patient counts as completed once their report is saved and any Diet Chart has been sent."
              : "Nothing outstanding. The branch books a Diet Consultation from the patient's card in Consultations."}
          </p>
        </div>
      ) : (
        <ConsultationList rows={visible} onOpen={setReportFor} />
      )}

      {reportFor && (
        <DietReportModal
          patient={reportFor}
          onClose={() => setReportFor(null)}
          onSaved={(text) => {
            setRows((prev) => prev.map((r) => (r.lead_id === reportFor.lead_id
              ? { ...r, diet_consultation_report: text } : r)));
            setReportFor(null);
          }}
          // Patches the row rather than closing, because sending a chart is not finishing
          // with the patient — the report may still be unwritten, and the modal is where
          // that happens.
          onChartSent={(chart) => {
            setRows((prev) => prev.map((r) => (r.lead_id === reportFor.lead_id
              ? { ...r, chart } : r)));
          }}
        />
      )}
    </div>
  );
}

/**
 * The Diet Chart — the coach's prepared plan, sent to the patient's Client Portal.
 *
 * A file rather than a typed plan, because that is what a chart already is: a laid-out week
 * of meals the coach prepares in whatever they prepare it in. Retyping it into a textarea
 * would produce a worse chart more slowly, and the report above is already the place for
 * words.
 *
 * Sending is never blocked on the fee, and this says so rather than hiding it. The coach
 * works when the work reaches them; the branch collects when the patient pays. What the fee
 * buys is the patient's sight of the chart — so a chart sent unpaid is finished work sitting
 * behind a gate, and the coach is the person the patient asks about it. Told nothing, they
 * would answer from a screen that says "sent" and be wrong.
 *
 * Replaces rather than appends. One current chart per patient, the same rule the report
 * follows, so sending a second supersedes the first.
 */
function DietChartPanel({ patient, chart, onSent }) {
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState(false);
  // Whether a chart has been called for at all. Held locally as well as on the patient so
  // the panel answers the moment it is pressed -- the branch's fee panel is the thing
  // waiting on it, and a coach who has to reload to see their own recommendation land will
  // press it twice.
  const [recommended, setRecommended] = useState(!!patient.diet_chart);
  const [recommending, setRecommending] = useState(false);
  // The chart on screen: { url, pdf, name }. null when nothing is open.
  const [preview, setPreview] = useState(null);
  // Mirrors preview.url purely so unmount can revoke it — an effect that closed over the
  // state would be cleaning up whatever the url was when it last ran.
  const previewRef = useRef(null);

  const sent = !!chart?.sent;
  const visible = !!chart?.visible_to_client;
  const feePaid = !!chart?.fee_paid;

  // The half of the referral that is the coach's to decide. The Consultant sends the
  // patient for a consultation; whether they leave with a chart is answered here, after
  // they have been seen, and it is what puts the Diet Chart Fee in front of the branch.
  const recommend = async () => {
    setRecommending(true);
    try {
      await recommendDietChart(patient.lead_id);
      setRecommended(true);
      toast.success("Diet Chart recommended. The branch collects the Diet Chart Fee next.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't recommend a Diet Chart");
    }
    setRecommending(false);
  };

  const send = async () => {
    if (!file) { toast.error("Choose the chart file first"); return; }
    setSending(true);
    try {
      const res = await sendDietChart(patient.lead_id, file);
      toast.success(res?.visible_to_client
        ? "Diet Chart sent to the Client Portal"
        : "Diet Chart sent — the client sees it once the Diet Chart Fee is collected");
      setFile(null);
      onSent?.(res);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't send the Diet Chart");
    }
    setSending(false);
  };

  // Fetched as a blob: the route needs the session token in a header, which a plain link
  // cannot send.
  //
  // Shown here rather than handed to a new tab. A coach opens the chart to read it back
  // against the report they are part-way through writing, and a new tab is the one place
  // that report is not — they lose the form to look at the plan, and come back to it by
  // hunting through tabs. It also went through window.open after an await, which has lost
  // the click that started it by the time it runs and gets swallowed by a popup blocker
  // with nothing thrown to catch and nothing on screen to explain it.
  const view = async () => {
    setOpening(true);
    try {
      const url = await dietChartUrl(patient.lead_id);
      const name = chart?.original_name || "";
      // The stored type where there is one, the file's own name where there is not — a
      // chart uploaded before content_type was recorded still knows what it is.
      const pdf = /pdf/i.test(chart?.content_type || "") || /\.pdf$/i.test(name);
      setPreview({ url, pdf, name: name || "Diet Chart" });
    } catch {
      toast.error("That chart couldn't be opened.");
    }
    setOpening(false);
  };

  // Revoked on the way out rather than on a timer. The bytes are held for exactly as long
  // as they are on screen, and a coach reading a long chart cannot have it expire under
  // them mid-read, which a timeout would eventually do.
  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closePreview(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, closePreview]);

  useEffect(() => { previewRef.current = preview?.url || null; }, [preview]);

  // The panel can be unmounted with the chart still open — the report modal behind it
  // closes, or the board refreshes — and the blob would be held until the tab is closed.
  // Read through the ref so this can have an empty dependency list and still see the url
  // that is open at the moment it runs.
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50/40 p-3" data-testid="diet-chart-panel">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-orange-700">
        <Salad className="h-3.5 w-3.5" /> Diet Chart
      </p>

      {/* The first step, and the one that was missing. A chart is a second product at a
          second price: until it is called for there is nothing for the branch to sell and
          nothing here for the coach to owe. Said before the uploader rather than beside it,
          because that is the order it happens in -- recommend, the branch collects, the
          chart goes out. */}
      {!recommended ? (
        <div className="mb-2 rounded-md border border-orange-200 bg-white/70 p-2.5" data-testid="diet-chart-recommend-panel">
          <p className="text-[11px] leading-relaxed text-slate-600">
            No Diet Chart has been called for. Recommend one if this patient needs it — the
            branch collects the Diet Chart Fee after that.
          </p>
          <Button
            className="mt-2 h-8 bg-orange-500 text-[11px] hover:bg-orange-600"
            onClick={recommend}
            disabled={recommending}
            data-testid="diet-chart-recommend"
          >
            <ClipboardCheck className="mr-1 h-3.5 w-3.5" />
            {recommending ? "Recommending..." : "Recommend Diet Chart"}
          </Button>
        </div>
      ) : (
        <p className="mb-2 text-[11px] font-medium text-emerald-700" data-testid="diet-chart-recommended">
          Diet Chart recommended{feePaid ? " · fee collected" : " — waiting on the branch to collect the Diet Chart Fee"}
        </p>
      )}

      {/* What the patient can actually see, said plainly. "Sent" alone would read as
          "they have it", and unpaid they do not. */}
      {!sent ? (
        <p className="text-[11px] text-slate-500">
          No chart sent yet. Upload the prepared chart as a PDF or an image.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-slate-800">{chart.original_name}</p>
            <p className={`text-[11px] ${visible ? "text-emerald-600" : "text-amber-600"}`}>
              {visible ? (
                <>Visible to the client{chart.sent_at ? ` · sent ${String(chart.sent_at).slice(0, 10)}` : ""}</>
              ) : (
                <><Lock className="mr-1 inline h-3 w-3" />Held until the Diet Chart Fee is collected</>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 text-[11px]"
            onClick={view}
            disabled={opening}
            data-testid="diet-chart-view"
          >
            <Eye className="mr-1 h-3.5 w-3.5" />{opening ? "Opening..." : "View"}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="min-w-0 flex-1 text-[11px] text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-orange-100 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-orange-700"
          data-testid="diet-chart-file"
        />
        <Button
          className="h-8 shrink-0 bg-orange-500 text-[11px] hover:bg-orange-600"
          onClick={send}
          disabled={sending || !file}
          data-testid="diet-chart-send"
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          {sending ? "Sending..." : sent ? "Replace Chart" : "Send Chart"}
        </Button>
      </div>

      {/* Through a portal and above z-[70]: this panel lives inside the report modal, and
          sometimes inside the patient modal behind that, so rendering it in place would
          put the chart underneath the form that opened it. */}
      {preview && createPortal(
        <div
          className="fixed inset-0 z-[80] flex flex-col bg-black/70 p-3 sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}
          data-testid="diet-chart-preview"
        >
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
              <Salad className="h-4 w-4 shrink-0 text-orange-600" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800" title={preview.name}>
                {preview.name}
              </p>
              {/* The way out for a PDF the browser will not draw inline, and for a coach
                  who wants the file rather than a look at it. A real link off the blob,
                  not a scripted open: it carries the click that started it, which is the
                  thing a popup blocker asks for. */}
              <a
                href={preview.url}
                download={preview.name}
                className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50"
                data-testid="diet-chart-download"
              >
                Download
              </a>
              <button
                type="button"
                onClick={closePreview}
                className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-slate-100"
                aria-label="Close the chart"
                data-testid="diet-chart-preview-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-slate-100">
              {preview.pdf ? (
                <ZoomablePdf src={preview.url} title={preview.name} testid="diet-chart-pdf" />
              ) : (
                <ZoomableImage src={preview.url} alt={preview.name} testid="diet-chart-image" />
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * The Diet Consultation report — what the coach concluded, and the thing the patient then
 * reads in their own Client Portal.
 *
 * One report per patient, replaced rather than appended to: it is the current plan, not a
 * log. The per-visit notes belong on each check-in day.
 */
function DietReportModal({ patient, onClose, onSaved, onChartSent }) {
  const [text, setText] = useState(patient.diet_consultation_report || "");
  const [saving, setSaving] = useState(false);
  // The chart as the queue last reported it, updated in place when one is sent so the panel
  // reflects the send without waiting for a refresh of the whole board.
  const [chart, setChart] = useState(patient.chart || null);

  const save = async () => {
    if (!text.trim()) { toast.error("Write the report before saving"); return; }
    setSaving(true);
    try {
      await saveDietConsultationReport(patient.lead_id, text.trim());
      toast.success("Diet Consultation report saved");
      onSaved(text.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the report");
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3" data-testid="diet-report-modal">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <Salad className="h-4 w-4 text-orange-500" /> Diet Consultation Report
            </p>
            <p className="truncate text-[11px] text-slate-400">{patient.lead_name}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" data-testid="diet-report-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 overflow-y-auto px-4 py-3">
          <p className="text-[11px] text-slate-500">
            The patient reads this in their Client Portal, so write it to them: what the
            plan is, and what to follow.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder="Assessment, the diet plan, what to avoid, what to follow between check-ins..."
            className="w-full rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-orange-400"
            data-testid="diet-report-text"
          />

          {/* The chart, in the same place as the report, because they are one patient's
              work and the coach should not have to find a second screen to finish it. Below
              the report rather than beside it: the report is written first, at the
              consultation, and the chart follows from what it says. */}
          <DietChartPanel
            patient={patient}
            chart={chart}
            onSent={(res) => { setChart(res); onChartSent?.(res); }}
          />
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
          <Button variant="outline" className="flex-1 text-xs" onClick={onClose} data-testid="diet-report-cancel">
            Cancel
          </Button>
          <Button
            className="flex-[2] bg-orange-500 text-xs hover:bg-orange-600"
            onClick={save}
            disabled={saving || !text.trim()}
            data-testid="diet-report-save"
          >
            {saving ? "Saving..." : patient.diet_consultation_report ? "Update Report" : "Save Report"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A status pill in the Human Resource Master View's shape — a bordered chip tinted with
    its own colour, rather than a solid block. */
const StatusPill = ({ label, color, testid }) => (
  <span
    className="inline-flex shrink-0 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold"
    style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}
    data-testid={testid}
  >
    {label}
  </span>
);

/**
 * The consultation queue as a table from tablet up, and the same rows as cards on a phone
 * — the Human Resource Master View's list, which is the pattern the OS uses wherever a
 * queue has more than two facts per row.
 *
 * As stacked cards, the phone number, the appointment and the check-in count were run into
 * one grey line separated by dots, so nothing lined up between rows and a coach scanning
 * for "who am I seeing on the 17th" had to read every row in full. In columns the same
 * facts sit under a heading that names them.
 */
const ConsultationList = ({ rows, onOpen }) => (
  <>
    <div className="space-y-2 sm:hidden" data-testid="diet-consult-list-mobile">
      {rows.map((p) => (
        <button
          key={p.lead_id}
          type="button"
          onClick={() => onOpen(p)}
          className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left"
          data-testid={`diet-consult-${p.lead_id}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-800">{p.lead_name}<LeadMarks lead={p} className="ml-1.5" /></p>
              <p className="truncate text-xs text-slate-500">{p.phone || "—"}</p>
            </div>
            {p.booked
              ? <StatusPill label="BOOKED" color={TILE_COLORS.booked} />
              : <StatusPill label="WAITING" color={TILE_COLORS.waiting} />}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {p.consultation_decision === "consultation_treatment" && (
              <span className="rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">+ TREATMENT</span>
            )}
            {p.appointment_date && (
              <span className="font-semibold text-emerald-600">
                {fmtDate(p.appointment_date)}{p.appointment_time ? ` ${to12h(p.appointment_time)}` : ""}
              </span>
            )}
            {p.total_days > 0 && <span>· {p.completed_days}/{p.total_days} check-ins</span>}
            {p.diet_consultation_report
              ? <span className="font-semibold text-emerald-600">· report written</span>
              : <span className="text-slate-400">· no report yet</span>}
            {/* Only where a chart is part of this patient's referral, so it stays off every
                patient who was sent for the consultation alone. */}
            {(p.diet_chart || p.chart?.sent) && (
              p.chart?.visible_to_client
                ? <span className="font-semibold text-emerald-600">· chart sent</span>
                : p.chart?.sent
                ? <span className="font-semibold text-amber-600">· chart held (fee due)</span>
                : <span className="text-slate-400">· chart due</span>
            )}
          </div>
        </button>
      ))}
    </div>

    <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="diet-consult-list-desktop">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
            <tr>
              <th className="px-4 py-2.5 font-semibold">S.No</th>
              <th className="px-4 py-2.5 font-semibold">Patient</th>
              <th className="px-4 py-2.5 font-semibold">Contact</th>
              <th className="px-4 py-2.5 font-semibold">Plan</th>
              <th className="px-4 py-2.5 font-semibold">Diet Consultation</th>
              <th className="px-4 py-2.5 font-semibold">Check-ins</th>
              <th className="px-4 py-2.5 font-semibold">Report</th>
              <th className="px-4 py-2.5 font-semibold">Chart</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p, i) => (
              <tr key={p.lead_id} onClick={() => onOpen(p)} className="cursor-pointer hover:bg-slate-50" data-testid={`diet-consult-${p.lead_id}`}>
                {/* Numbered off the list as it stands, not off anything on the record —
                    so it still counts 1, 2, 3 down whatever the filters have left. */}
                <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800">{p.lead_name}<LeadMarks lead={p} className="ml-1.5" /></p>
                  {p.patient_number && <p className="font-mono text-[11px] text-slate-400">{p.patient_number}</p>}
                </td>
                <td className="px-4 py-3 text-slate-600">{p.phone || "—"}</td>
                {/* Whether this patient is also on a physio course — it changes how a diet
                    plan should be pitched, and the coach sees it nowhere else. */}
                <td className="px-4 py-3">
                  {p.consultation_decision === "consultation_treatment"
                    ? <span className="rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">+ TREATMENT</span>
                    : <span className="text-[11px] text-slate-400">Diet only</span>}
                </td>
                {/* The DIET consultation's own date and time, not the Head Physio's. */}
                <td className="px-4 py-3 text-slate-600">
                  {p.appointment_date
                    ? <span className="whitespace-nowrap">{fmtDate(p.appointment_date)}{p.appointment_time ? ` at ${to12h(p.appointment_time)}` : ""}</span>
                    : "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {p.total_days > 0 ? `${p.completed_days}/${p.total_days}` : "—"}
                </td>
                {/* Who has been written up. The report is what the patient reads in their
                    own portal, so an unwritten one is work still outstanding. */}
                <td className="px-4 py-3">
                  {p.diet_consultation_report
                    ? <StatusPill label="WRITTEN" color={TILE_COLORS.booked} />
                    : <span className="text-[11px] text-slate-400">—</span>}
                </td>
                {/* Three states, not two. A chart the coach sent is not a chart the patient
                    has: unpaid it is held, and this is where the coach finds that out
                    rather than from the patient asking why nothing arrived. */}
                <td className="px-4 py-3">
                  {p.chart?.visible_to_client
                    ? <StatusPill label="SENT" color={TILE_COLORS.booked} />
                    : p.chart?.sent
                    ? <StatusPill label="FEE DUE" color={TILE_COLORS.waiting} />
                    : p.diet_chart
                    ? <StatusPill label="CHART DUE" color={TILE_COLORS.referred} />
                    : <span className="text-[11px] text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {p.booked
                    ? <StatusPill label="BOOKED" color={TILE_COLORS.booked} testid={`diet-consult-status-${p.lead_id}`} />
                    : <StatusPill label="AWAITING BOOKING" color={TILE_COLORS.waiting} testid={`diet-consult-status-${p.lead_id}`} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </>
);

function PatientsTab({ coachId, onCountChange, toolbarSlot }) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [historyTab, setHistoryTab] = useState("ongoing");
  const [openLead, setOpenLead] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setPatients((await dietPatients(coachId)).patients || []); }
    catch { /* silent */ }
    setLoading(false);
  }, [coachId]);

  useEffect(() => { load(); }, [load]);

  const isDone = (p) => p.total_days > 0 && p.remaining_days === 0;
  const ongoing = patients.filter((p) => !isDone(p));
  const completed = patients.filter(isDone);
  const visible = historyTab === "completed" ? completed : ongoing;

  useEffect(() => { onCountChange?.(ongoing.length); }, [ongoing.length, onCountChange]);

  // This tab has no search or filter of its own, so its toolbar is the Refresh alone —
  // still portaled into the shared slot, so the button sits in the same place on both
  // tabs rather than moving when you switch.
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-testid="diet-patients-toolbar">
      <RefreshBtn onClick={load} busy={loading} testid="diet-patients-refresh" />
    </div>
  );

  return (
    <div data-testid="diet-patients-tab">
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {[{ key: "ongoing", label: "Ongoing", count: ongoing.length }, { key: "completed", label: "Completed", count: completed.length }].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setHistoryTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${historyTab === t.key ? "bg-emerald-100 text-emerald-700" : "text-slate-500 hover:bg-slate-50"}`}
            data-testid={`diet-history-${t.key}`}
          >
            {t.label} <span className="text-[10px] text-slate-400">({t.count})</span>
          </button>
        ))}
      </div>

      {visible.length === 0 && !loading ? (
        <div className="py-16 text-center">
          <Users className="mx-auto mb-3 h-10 w-10 text-slate-200" />
          <p className="text-sm text-slate-400">{historyTab === "completed" ? "No completed diet plans yet" : "No patients assigned yet"}</p>
        </div>
      ) : (
        <PatientList rows={visible} onOpen={setOpenLead} />
      )}

      {openLead && <PatientDaysModal patient={openLead} onClose={() => setOpenLead(null)} />}
    </div>
  );
}

/** The caseload in the same list the queue uses: table from tablet up, cards on a phone.
    The progress bar survives into the table as a column of its own — it is the one thing
    on this board that answers "how far through is this patient" without arithmetic. */
const PatientList = ({ rows, onOpen }) => {
  const pct = (p) => (p.total_days > 0 ? (p.completed_days / p.total_days) * 100 : 0);
  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid="diet-patient-list-mobile">
        {rows.map((p) => (
          <button
            key={p.lead_id}
            type="button"
            onClick={() => onOpen(p)}
            className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left"
            data-testid={`diet-patient-${p.lead_id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">{p.lead_name}<LeadMarks lead={p} className="ml-1.5" /></p>
                <p className="truncate text-xs text-slate-500">{p.phone || "—"}</p>
              </div>
              <span className="shrink-0 text-sm font-bold text-emerald-600">{p.completed_days}/{p.total_days}</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct(p)}%` }} />
            </div>
          </button>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="diet-patient-list-desktop">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Patient</th>
                <th className="px-4 py-2.5 font-semibold">Contact</th>
                <th className="px-4 py-2.5 font-semibold">Next Check-in</th>
                <th className="px-4 py-2.5 font-semibold">Progress</th>
                <th className="px-4 py-2.5 font-semibold">Done</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => (
                <tr
                  key={p.lead_id}
                  onClick={() => onOpen(p)}
                  className="cursor-pointer hover:bg-slate-50"
                  data-testid={`diet-patient-${p.lead_id}`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{p.lead_name}<LeadMarks lead={p} className="ml-1.5" /></p>
                    {p.diet_stage && <p className="text-[11px] text-slate-400">{p.diet_stage}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{p.phone || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {p.next_day?.slot_time
                      ? <span className="whitespace-nowrap">{fmtDate((p.next_day.slot_time || "").slice(0, 10))} at {to12h((p.next_day.slot_time || "").slice(11, 16))}</span>
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct(p)}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-bold text-emerald-600">{p.completed_days}/{p.total_days}</span>
                  </td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

const PatientDaysModal = ({ patient, onClose }) => {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    dietSessions(patient.lead_id)
      .then((r) => setDays(r.days || []))
      .catch(() => setDays([]))
      .finally(() => setLoading(false));
  }, [patient.lead_id]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="diet-patient-modal">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between bg-emerald-600 px-5 py-4 text-white">
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{patient.lead_name}</p>
            <p className="text-xs text-white/80">{patient.completed_days} of {patient.total_days} check-ins done</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
          ) : days.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">No check-in days booked yet.</p>
          ) : (
            <div className="space-y-2">
              {days.map((d) => {
                const done = d.status === "completed";
                return (
                  <div key={d.id} className={`rounded-lg border p-3 ${done ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-700">Day {d.day_number}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                        {done ? "Completed" : "Upcoming"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {fmtDate((d.slot_time || "").slice(0, 10))} · {to12h((d.slot_time || "").slice(11, 16))}
                      {d.weight_kg != null ? ` · ${d.weight_kg} kg` : ""}
                    </p>
                    {d.coach_remarks && <p className="mt-1 text-xs text-slate-600">“{d.coach_remarks}”</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DietBoard;
