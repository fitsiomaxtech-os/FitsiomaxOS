import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Search, Settings as Cog, Calendar as CalendarIcon, Phone, FileText, CheckCircle2, X, Pencil, PhoneOff, Clock, Bell, Building2, Trash2, Lock, Users, CalendarCheck, UserRound, LogOut, Mail, Youtube, ChevronDown, ChevronRight, RefreshCw, UserPlus, BarChart3, CalendarDays, IdCard } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  getLeads, createManualLead, stagesList, updateLead, rnrAttempt, scheduleFollowUp, rescheduleFollowUp, scheduleAppointment, getBranches, leadActivity,
  listTestimonials, addTestimonial, deleteTestimonial, getDashboardOverview,
} from "@/lib/api";
import { LeadEditModal } from "@/components/LeadEditModal";
import { CreateLeadModal, DEPARTMENT_OPTIONS } from "@/components/CreateLeadModal";
import { LeadsAnalyticsDashboard } from "@/components/marketing/LeadsAnalyticsDashboard";
import { PullFromSheetButton } from "@/components/PullFromSheetButton";
import { DeleteLeadDialog } from "@/components/DeleteLeadDialog";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar } from "@/components/QuickDateFilterBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StageTabBar } from "@/components/ui/stage-tab";
import { BottomNavTab } from "@/components/ui/bottom-nav-tab";
import { StatTile } from "@/components/ui/stat-tile";
import { MilkDateInput, MilkDateTextInput, MilkTimeInput } from "@/components/ui/milk-calendar";
import { callTimeStamp, callDateStamp, dateStampFull } from "@/lib/time";
import { displayPhone, telNumber } from "@/lib/phone";

export const initials = (name) => (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

// Deterministic avatar color per first letter so A→one hue, B→another, etc.
// Tailwind 26-letter palette (bg + text pair) chosen for legibility on white rows.
const AVATAR_PALETTE = [
  { bg: "bg-red-100",     fg: "text-red-700" },     // A
  { bg: "bg-orange-100",  fg: "text-orange-700" },  // B
  { bg: "bg-amber-100",   fg: "text-amber-700" },   // C
  { bg: "bg-yellow-100",  fg: "text-yellow-800" },  // D
  { bg: "bg-lime-100",    fg: "text-lime-700" },    // E
  { bg: "bg-green-100",   fg: "text-green-700" },   // F
  { bg: "bg-emerald-100", fg: "text-emerald-700" }, // G
  { bg: "bg-teal-100",    fg: "text-teal-700" },    // H
  { bg: "bg-cyan-100",    fg: "text-cyan-700" },    // I
  { bg: "bg-sky-100",     fg: "text-sky-700" },     // J
  { bg: "bg-blue-100",    fg: "text-blue-700" },    // K
  { bg: "bg-indigo-100",  fg: "text-indigo-700" },  // L
  { bg: "bg-violet-100",  fg: "text-violet-700" },  // M
  { bg: "bg-purple-100",  fg: "text-purple-700" },  // N
  { bg: "bg-fuchsia-100", fg: "text-fuchsia-700" }, // O
  { bg: "bg-pink-100",    fg: "text-pink-700" },    // P
  { bg: "bg-rose-100",    fg: "text-rose-700" },    // Q
  { bg: "bg-red-200",     fg: "text-red-800" },     // R
  { bg: "bg-orange-200",  fg: "text-orange-800" },  // S
  { bg: "bg-amber-200",   fg: "text-amber-800" },   // T
  { bg: "bg-lime-200",    fg: "text-lime-800" },    // U
  { bg: "bg-emerald-200", fg: "text-emerald-800" }, // V
  { bg: "bg-cyan-200",    fg: "text-cyan-800" },    // W
  { bg: "bg-blue-200",    fg: "text-blue-800" },    // X
  { bg: "bg-violet-200",  fg: "text-violet-800" },  // Y
  { bg: "bg-pink-200",    fg: "text-pink-800" },    // Z
];

export const avatarColor = (name) => {
  const c = (name || "?").trim().charAt(0).toUpperCase();
  const idx = c.charCodeAt(0) - 65;
  if (idx < 0 || idx > 25) return { bg: "bg-slate-100", fg: "text-slate-700" };
  return AVATAR_PALETTE[idx];
};

// 10-digit → prepend 91; 11-digit leading 0 → drop the 0 and prepend 91 — same
// sanitizer used for WhatsApp links elsewhere in this app (PhysioBoard, Client Portal).
const waNumber = (raw) => {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
};

// lucide-react has no WhatsApp glyph, so this is hand-drawn (duplicated per-file,
// matching the convention already used in PhysioBoard.jsx / PatientsPortalPanel.jsx).
const WhatsAppIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39a9.9 9.9 0 0 0 4.75 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2m0 18.15a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.14.82.84-3.06-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.55-3.7 8.24-8.24 8.24m4.52-6.17c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.81-.78.97-.15.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.24-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.36-.77-1.86-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31s-.87.85-.87 2.08.89 2.41 1.02 2.58c.12.17 1.75 2.67 4.24 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.16-.48-.28"/>
  </svg>
);

const branchLabel = (b) => b?.branch_name || b?.name || "";

/** A stored key as words: "google_sheets" reads as "Google Sheets". */
const humanWords = (v) => String(v).replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

/** A lead's source as words for the line under its name — "google_sheets" reads as
 *  "Google Sheets", the way HR Admin prints a candidate's source under their name. */
const sourceLabel = (src) => (src ? humanWords(src) : "—");

/**
 * The colour a Pre-Sales stage is known by, for the lead popup's stage pills and the
 * table's stage chip.
 *
 * Its selected colour first. CI/CD ROOTS lets every KPI card rest in one grey and take its
 * own colour only once picked, so on this board the plain colour can be the same grey for
 * every stage — pills drawn in it would all read alike, where Branch Admin's popup shows
 * each stage in its own. A stage with no selected colour falls back to its plain one.
 */
const stageInk = (stage) => stage?.selected_color || stage?.color || "#64748b";

/**
 * The Assigned To column's dropdown — plain white and slate, no per-branch colours.
 *
 * It draws its own list rather than using a native <select>, whose option list is
 * drawn by the OS and ignores CSS, so it would look out of place next to the board.
 *
 * The panel is position:fixed and measured off the trigger, because the leads table
 * sits in an overflow-auto wrapper that would otherwise clip an absolutely-positioned
 * one. A fixed panel can't follow what it is anchored to, so any scroll or resize
 * closes it rather than leaving it stranded beside a different row — except a scroll of
 * the list itself, which is the panel being used, not left behind.
 *
 * It is portalled to <body> because the table is drawn at 90% (zoom). A fixed box inside
 * a zoomed ancestor has its top and left scaled along with it, so the panel would open a
 * tenth short of the trigger it was measured off.
 *
 * `options` is [{ value, label }]. `resetLabel`, when given, adds a neutral first row
 * that clears the selection — that's the filter's "All Sources"; the assign column has
 * no such row because unassigning a lead isn't a thing you can do here.
 */
const BranchSelect = ({
  value, options, onChange, placeholder, resetLabel, testid,
  triggerClass = "h-8 min-w-[7.5rem] text-xs", emptyText = "Nothing to choose from.",
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // The panel is outside wrapRef in the DOM now, so a press on it has to be checked
    // against both — or picking a branch would close the list before the click landed.
    const inside = (target) => [wrapRef, panelRef].some((r) => r.current && r.current.contains(target));
    const onPointer = (e) => { if (!inside(e.target)) setOpen(false); };
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", onPointer, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onPointer, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = wrapRef.current.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const height = Math.min(48 + options.length * 34, 288);
    // Wide enough to read a long source name, but never wider than the window on a
    // phone. Then pinned inside the viewport: a control sitting near the right edge
    // would otherwise open a panel that runs straight off the screen, which is what
    // made this one unreadable and half of it unclickable.
    const width = Math.min(Math.max(r.width, 232), window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({
      left,
      width,
      ...(room > height ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
    });
    setOpen(true);
  };

  const pick = (v) => { setOpen(false); if (v !== value) onChange(v); };

  return (
    <div className="relative inline-block max-w-full" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        className={`flex w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2 font-semibold transition hover:bg-slate-50 ${triggerClass} ${current ? "text-slate-700" : "text-slate-500"}`}
        data-testid={testid}
      >
        <span className="truncate">{current ? current.label : placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl"
          style={pos}
          data-testid={`${testid}-list`}
        >
          {resetLabel && (
            <button
              type="button"
              onClick={() => pick("")}
              className={`flex w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs font-semibold transition hover:bg-slate-100 ${!value ? "bg-slate-100 text-slate-800" : "text-slate-600"}`}
            >
              <span className="truncate">{resetLabel}</span>
              {!value && <CheckCircle2 className="ml-auto h-3.5 w-3.5 shrink-0 opacity-70" />}
            </button>
          )}
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-slate-400">{emptyText}</p>
          ) : options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                title={o.label}
                className={`flex w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs font-semibold transition hover:bg-slate-100 ${active ? "bg-slate-100 text-slate-800" : "text-slate-600"}`}
              >
                <span className="truncate">{o.label}</span>
                {active && <CheckCircle2 className="ml-auto h-3.5 w-3.5 shrink-0 opacity-70" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
};

const testimonialsUrl = () => `${window.location.origin}/testimonials`;

// Call → native dialer (tel:); WhatsApp → a template message pointing the lead at the
// patient testimonial videos before the rep even gets them on the phone. Same-tab
// navigation (window.location.href, not window.open), matching the fix applied
// elsewhere for the mobile "blank screen on return from WhatsApp" bug.
const LeadContactIcons = ({ lead }) => {
  if (!lead.phone) return null;
  const num = waNumber(lead.phone);
  const handleCall = (e) => { e.stopPropagation(); window.location.href = `tel:${telNumber(lead.phone)}`; };
  const handleWhatsApp = (e) => {
    e.stopPropagation();
    const text = [
      `Hi ${lead.name || "there"}, this is Fitsiomax!`,
      "",
      "Take a look at real patient success stories before we connect:",
      testimonialsUrl(),
    ].join("\n");
    window.location.href = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
  };
  // 40px targets with a tinted disc behind each. These now render only on the phone
  // cards, and at 3.5 icons inside 1.5 padding they were 26px of tappable area with
  // nothing marking them as buttons — under the 44px a thumb is generally reckoned to
  // need, and sitting next to a card that opens the lead on tap, so a near miss opened
  // the wrong thing entirely.
  return (
    <div className="flex items-center justify-center gap-2">
      <button
        type="button"
        onClick={handleCall}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600 transition active:bg-sky-100"
        title="Call"
        aria-label={`Call ${lead.name || "lead"}`}
        data-testid={`presales-call-${lead.id}`}
      >
        <Phone className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={handleWhatsApp}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 transition active:bg-emerald-100"
        title="WhatsApp"
        aria-label={`WhatsApp ${lead.name || "lead"}`}
        data-testid={`presales-whatsapp-${lead.id}`}
      >
        <WhatsAppIcon className="h-5 w-5" />
      </button>
    </div>
  );
};

// Shared between the desktop Appointment column and the mobile Consultations tab —
// same branch_stage vocabulary the Branch Admin's own pipeline already uses.
const branchStatusInfo = (lead, branches) => {
  const branchName = lead.branch_id
    ? (branches.find((b) => b.id === lead.branch_id)?.branch_name || branches.find((b) => b.id === lead.branch_id)?.name)
    : (lead.appointment_mode === "online" ? "Online Consultation" : "Unassigned");
  const status = lead.branch_stage || "Pending";
  const statusColor = {
    "New Appointment": "bg-blue-50 text-blue-700 border-blue-200",
    "Portfolio": "bg-violet-50 text-violet-700 border-violet-200",
    "Follow Up": "bg-orange-50 text-orange-700 border-orange-200",
    "Appointment": "bg-teal-50 text-teal-700 border-teal-200",
    "Appointment Date & Time": "bg-teal-50 text-teal-700 border-teal-200",
    "Cancelled": "bg-rose-50 text-rose-700 border-rose-200",
  }[status] || "bg-slate-50 text-slate-600 border-slate-200";
  return { branchName, status, statusColor };
};

// Marketing Head's KPI row — a fixed funnel rather than the live Pre-Sales stage list,
// since two of these span more than one field. "Branch Admin Appointment" counts
// a branch board's own appointment stage regardless of how the lead got there: "New
// Appointment" is where a Pre-Sales-controlled branch's board opens (the lead arrives
// already booked), "Appointment Date & Time" is the stage a Branch-Admin-controlled
// branch's own leads reach once *it* books one directly — both mean "there's a booked
// appointment sitting on a branch's board" (see backend/stage_utils.py). "Lost" folds in
// each sub-pipeline's own didn't-convert stage, since a lead can end up not converting from
// any of the three.
/**
 * Every branch_stage that means "a booked appointment is sitting on a branch's board".
 *
 * There are three because the stage has been renamed as the branch pipeline changed, and a
 * board reads live data written by every version of it: "New Appointment" is where a
 * Pre-Sales-fed branch's board opened, "Appointment Date & Time" was the seeded name a
 * branch reached once it booked one itself, and "Appointment" is what that stage is called
 * now. Matching only the seeded names is how this count silently read low.
 *
 * Shared by the two card rows that ask the question, so they cannot drift apart.
 */
const BRANCH_APPOINTMENT_STAGES = ["Appointment", "New Appointment", "Appointment Date & Time"];
const isBranchAppointment = (l) => BRANCH_APPOINTMENT_STAGES.includes(l.branch_stage);

/**
 * The Sales Master View's cards: five counts, then the two revenue figures.
 *
 * Not the live Pre-Sales stage list the individual rep's board uses. A master view is read
 * to see how far the whole book got — booked by which desk, consulted, treated — and that
 * spans four different fields, none of which is the pre-sales stage on its own.
 *
 * Consultation and Treatment count the fee actually collected rather than a stage reached,
 * which is what makes each count and the revenue beside it two readings of one event
 * instead of two numbers that can disagree.
 *
 * `amount` marks the revenue cards. Clicking one filters the table to the leads that
 * contributed to it, so a figure can always be taken apart.
 */
const SALES_MASTER_CARDS = [
  { key: "all", label: "All Leads", color: "#22c55e" },
  { key: "presales_appointment", label: "Pre-sales Appointment", color: "#6366f1", match: (l) => l.stage === "Appointment" },
  { key: "branch_appointment", label: "Branch Admin Appointment", color: "#14b8a6", match: isBranchAppointment },
  { key: "consultation", label: "Consultation", color: "#0ea5e9", match: (l) => Number(l.consultation_fee || 0) > 0 },
  { key: "treatment", label: "Treatment", color: "#a855f7", match: (l) => Number(l.treatment_fee_paid || 0) > 0 },
  {
    key: "consultation_revenue",
    label: "Consultation Revenue",
    color: "#f59e0b",
    amount: (l) => Number(l.consultation_fee || 0),
  },
  {
    key: "treatment_revenue",
    label: "Treatment Revenue",
    color: "#ef4444",
    amount: (l) => Number(l.treatment_fee_paid || 0),
  },
];

const MARKETING_HEAD_FUNNEL = [
  { key: "new_leads", label: "New Leads", color: "#3b82f6", match: (l) => l.stage === "New Leads" },
  { key: "rnr", label: "RNR", color: "#f59e0b", match: (l) => l.stage === "RNR" },
  { key: "follow_up", label: "Follow Up", color: "#8b5cf6", match: (l) => l.stage === "Follow Up" },
  { key: "appointment_pre_sales", label: "Pre-Sales Appointment", color: "#6366f1", match: (l) => l.stage === "Appointment" },
  {
    key: "appointment_branch_admin",
    label: "Branch Admin Appointment",
    color: "#14b8a6",
    match: isBranchAppointment,
  },
  { key: "consultation_done", label: "Consultation Done", color: "#10b981", match: (l) => l.consultation_stage === "Consultation Completed" },
  {
    key: "lost",
    label: "Lost",
    color: "#ef4444",
    match: (l) => l.stage === "Lost" || l.branch_stage === "Cancelled" || l.consultation_stage === "Cancel",
  },
];

/**
 * Leads / Analytics — the board's two pages, not two of its filters.
 *
 * Wears the top nav strip's tab rather than the rounded pill everything under it wears.
 * These switch which page you are on; All/Online/Offline and the branch pills narrow
 * whatever page that is. Dressed as a pill, a page switch read as one more thing to
 * filter by, sitting in a stack of three rows that all looked alike.
 */
const PreSalesViewTab = ({ active, onClick, children, testid }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
      active ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100"
    }`}
    data-testid={testid}
  >
    {children}
  </button>
);

// The branch filter chips on Marketing / Sales (Master) View. Boxes, not capsules:
// rounded-md is the same calc(var(--radius) - 2px) the All/Online/Offline group beside
// them already uses, so the two halves of one filter row read as one control instead of
// a segmented box followed by a row of radio-looking pills.
const PreSalesBranchPill = ({ active, onClick, children, testid }) => (
  <button
    type="button"
    onClick={onClick}
    className={`shrink-0 rounded-md border px-3 py-1 text-xs font-medium transition ${
      active ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-500 hover:border-sky-300 hover:text-sky-600"
    }`}
    data-testid={testid}
  >
    {children}
  </button>
);

// Which desk is holding a lead right now — the one fact the merged Super Admin view adds
// that neither of the two split boards needed, since each of them only ever shows one.
const HandledByBadge = ({ lead }) => {
  const isBranchAdmin = lead.lead_control === "branch_admin";
  const isBoth = lead.lead_control === "both";
  return (
    <span
      className={`inline-flex w-fit items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
        isBoth
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : isBranchAdmin ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"
      }`}
    >
      {isBoth ? "Both" : isBranchAdmin ? "Branch Admin" : "Pre-Sales"}
    </span>
  );
};

// A "both" lead belongs to each desk's book, so it passes either desk's filter.
const handledBy = (lead, desk) =>
  desk === "branch_admin" ? lead.lead_control !== "pre_sales" : lead.lead_control !== "branch_admin";

const PRESALES_ANALYTICS_DATE_PRESETS = [
  // First, because it is the widest: every other option here narrows it.
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "this_week", label: "This Week" },
  { key: "this_month", label: "This Month" },
  { key: "custom", label: "Custom" },
];

// The funnel this board feeds, off one /dashboard/overview call: leads and appointments
// through to what a branch makes of them — consultations, sessions, and the treatment
// packages patients end up buying.
//
// The last two are a pair, both counted off the Treatment Fee: how many patients bought a
// package, and what those came to. "Treatment Purchase Revenue" is the figure that used to
// be labelled "Session Amount Collected" — the same money, named for the thing being sold
// rather than for the visits it pays for, so it reads with the count beside it.
//
// Pending Session Amount is gone from here. It is an outstanding balance rather than
// anything this board's date range describes — every other card counts what happened in
// the window, that one reported what was owed right now regardless of it.
const PRESALES_ANALYTICS_METRICS = [
  { key: "leads", label: "All Leads" },
  { key: "appointments", label: "Appointment Booked" },
  { key: "consultations", label: "Consultations" },
  { key: "consultation_revenue", label: "Consultations Revenue", currency: true },
  { key: "sessions_booked", label: "Sessions Total Booked" },
  { key: "treatment_purchases", label: "Treatment Purchase Number" },
  { key: "session_revenue", label: "Treatment Purchase Revenue", currency: true },
];

// Which desk is holding a lead, as something you can filter by rather than only read off
// each row. A master view carries both halves of the book at once (see load()), and the
// HANDLED BY column already names them in exactly these words.
const HANDLED_BY_FILTERS = [
  // First, because it is the widest: both of the others narrow it.
  { key: "all", label: "All" },
  { key: "pre_sales", label: "Pre-Sales" },
  { key: "branch_admin", label: "Branch Admin" },
];

/** Which arm a branch belongs to, read off the vertical's own key — "online_fitness",
 *  "online_physiotherapy". The same test Branches & Verticals splits its groups on, so a
 *  branch lands on the same side of the line on both boards. */
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// Which arm of the business to read, above the branch pills that name the branches in it.
//
// This is not the pills said twice. A pill picks one branch, so there is no way through
// them to ask for both online arms together, or for every room at once — and those are the
// two questions a master view is opened to answer. Picking a group here still leaves every
// branch in it pickable below.
const BRANCH_MODE_FILTERS = [
  // Widest first, as the Handled By row above it does: the other two are a step in from it.
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
];

// The leads toolbar's dropdown look — the Handled By filter's, shared with the two branch
// dropdowns that can sit beside it so the three read as one set. Tinted while it narrows
// the list, so a filtered table always has something on screen saying so.
const toolbarSelectClass = (narrowed) => `h-10 w-40 shrink-0 rounded-md border px-2.5 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 ${
  narrowed ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
}`;

/**
 * All/Online/Offline and the branch pills as two toolbar dropdowns (branchFilterInToolbar).
 * The same state and the same pickMode the rows use, so the branch list still narrows to
 * the group picked beside it and a group change still lets go of a branch outside it.
 *
 * Radix Select refuses an empty value, so "All Branches" rides as "all" and maps back to
 * the "" sourceFilter holds for every branch.
 */
const BranchScopeSelects = ({ mode, onMode, branchId, onBranch, branches, testid }) => (
  <>
    <Select value={mode} onValueChange={onMode}>
      <SelectTrigger title="Online / Offline" aria-label="Online / Offline" className={toolbarSelectClass(mode !== "all")} data-testid={`${testid}-mode`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-slate-200">
        {BRANCH_MODE_FILTERS.map((o) => (
          <SelectItem key={o.key} value={o.key} className="text-xs text-slate-700" data-testid={`${testid}-mode-${o.key}`}>
            {o.key === "all" ? "Online & Offline" : o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    <Select value={branchId || "all"} onValueChange={(v) => onBranch(v === "all" ? "" : v)}>
      <SelectTrigger title="Branch" aria-label="Branch" className={toolbarSelectClass(!!branchId)} data-testid={`${testid}-branch`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72 border-slate-200">
        <SelectItem value="all" className="text-xs text-slate-700" data-testid={`${testid}-branch-all`}>All Branches</SelectItem>
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id} className="text-xs text-slate-700" data-testid={`${testid}-branch-${b.id}`}>
            {branchLabel(b)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </>
);

/**
 * A row of pills acting as one segmented control — the date presets on the Analytics pane
 * and the Leads range row, and the Handled By filter that sits beside the latter. One
 * component so that three controls reading as the same thing cannot drift into three that
 * behave differently at the same width.
 *
 * It wraps rather than holding one line. The five range labels come to roughly 340px, and
 * a phone's content column is 336px inside the page's own px-3 — as a nowrap row it pushed
 * the whole board sideways, so every screen using it scrolled horizontally.
 *
 * `options` is [{ key, label }]. `testid` is the prefix each button's own testid is built
 * from, so every caller keeps the ids it already had.
 */
const SegmentedPillGroup = ({ options, active, onPick, testid }) => (
  <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
    {options.map((o) => (
      <button
        key={o.key}
        onClick={() => onPick(o.key)}
        className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition sm:px-3 ${
          active === o.key ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
        }`}
        data-testid={`${testid}-${o.key}`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const presalesStartOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const presalesStartOfWeek = (d) => { const x = presalesStartOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; };
const presalesStartOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
// The reader's own calendar day, not UTC's. toISOString() converts before it formats, so
// local midnight on a +05:30 clock comes back as 18:30 the day BEFORE: "This Week" and
// "This Month" each opened a day early, and "Today" read as yesterday until 05:30 every
// morning. Built from the local getters instead, which is the day the clinic is asking
// about and the day /dashboard/overview now answers on.
const presalesToIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const presalesEndOfDay = (d) => { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; };

/** The from/to a preset key covers. Every range ends today rather than at the end of the
 *  period — "This Month" means the month so far, not a window running into the future. */
const presalesRangeFor = (key) => {
  const today = new Date();
  if (key === "today") return { from: presalesStartOfDay(today), to: presalesEndOfDay(today) };
  if (key === "this_week") return { from: presalesStartOfWeek(today), to: presalesEndOfDay(today) };
  if (key === "this_month") return { from: presalesStartOfMonth(today), to: presalesEndOfDay(today) };
  return { from: null, to: null };
};

/**
 * The range row from the Analytics pane, driving the Leads table's own date filter.
 *
 * Same presets, same order, same look — the two panes of one board asking the same
 * question should not be answered by two different controls. It emits the
 * { key, label, from, to } shape the Leads filter already reads, so nothing downstream of
 * dateFilter had to change.
 *
 * `onHandledByChange` opts a caller into the Handled By filter sitting beside the presets:
 * given, the row carries both; left off, it is the range row it always was. It rides in
 * here rather than in a row of its own because the two narrow the same list, and a second
 * bordered strip under this one would read as a filter for something else.
 */
const PreSalesRangePills = ({ value, onChange, testid = "presales-range", handledBy, onHandledByChange }) => {
  const activeKey = value?.key || "all";
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const pick = (key) => {
    if (key === "all") { onChange(null); return; }
    const label = PRESALES_ANALYTICS_DATE_PRESETS.find((p) => p.key === key)?.label || key;
    // Custom lands with no dates yet, which reads as unfiltered until both are given —
    // the alternative is guessing a range on the user's behalf the moment they click it.
    if (key === "custom") { onChange({ key, label, from: null, to: null }); return; }
    onChange({ key, label, ...presalesRangeFor(key) });
  };

  const applyCustom = (fromStr, toStr) => {
    if (!fromStr || !toStr) return;
    onChange({
      key: "custom",
      label: "Custom",
      from: new Date(`${fromStr}T00:00:00`),
      to: new Date(`${toStr}T23:59:59`),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:gap-3 sm:p-3" data-testid={`${testid}-row`}>
      <SegmentedPillGroup options={PRESALES_ANALYTICS_DATE_PRESETS} active={activeKey} onPick={pick} testid={testid} />
      {/* Kept next to the presets it belongs to, ahead of the Handled By group, so the
          range and the dates it resolves to read as one thing. */}
      {/* One line, from and to and the word between them. nowrap rather than the wrap this
          group carried: the trio comes to roughly 290px against a phone's 336px content
          column, so it fits everywhere, and breaking it put "to" on a line of its own,
          reading as a label for the field under it rather than as the join between two. The
          outer row still wraps, so on a narrow screen the whole group drops below the
          presets together instead of being torn in half. */}
      {activeKey === "custom" && (
        <div className="flex flex-nowrap items-center gap-1.5 text-xs text-slate-500">
          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
          {/* Typed, not picked. Whoever pulls this range already knows both dates — the
              month grid made them navigate to two days they could simply have keyed in,
              and a range a quarter back cost several taps of the arrow per field. */}
          <MilkDateTextInput
            value={customFrom}
            onChange={(e) => { setCustomFrom(e.target.value); applyCustom(e.target.value, customTo); }}
            className="h-8 w-[7.25rem] rounded-md border-slate-200 px-2 text-xs"
            data-testid={`${testid}-custom-from`}
          />
          <span className="shrink-0">to</span>
          {/* Bounded by the other field, so a backwards range is refused as it is typed
              rather than quietly returning nothing from the table below. */}
          <MilkDateTextInput
            value={customTo}
            onChange={(e) => { setCustomTo(e.target.value); applyCustom(customFrom, e.target.value); }}
            min={customFrom || undefined}
            className="h-8 w-[7.25rem] rounded-md border-slate-200 px-2 text-xs"
            data-testid={`${testid}-custom-to`}
          />
        </div>
      )}
      {/* Flush to the right edge, so the row is justified rather than leaving both filters
          huddled at the left under a strip of empty white. From sm only: once the row wraps
          on a phone, ml-auto would strand this group hard right on a line of its own. */}
      {onHandledByChange && (
        <div className="sm:ml-auto">
          <SegmentedPillGroup
            options={HANDLED_BY_FILTERS}
            active={handledBy}
            onPick={onHandledByChange}
            testid={`${testid}-handled-by`}
          />
        </div>
      )}
    </div>
  );
};

/** A specific branch wins outright; otherwise the group's own branches summed (Offline/
 *  Online), or the bucket's grand total for All. Same shape as Overview's own helper.
 *
 *  The group is summed from the per-branch rows rather than asked of the endpoint, which
 *  reports a total and a breakdown and no notion of an arm. An empty `groupBranchIds` is
 *  All — the same thing no pill selected has always meant. */
const presalesAnalyticsValueFor = (bucket, branchId, groupBranchIds) => {
  if (!bucket) return 0;
  const branches = bucket.branches || [];
  if (branchId) {
    const hit = branches.find((b) => b.branch_id === branchId);
    return hit ? hit.value : 0;
  }
  if (groupBranchIds?.length) {
    const ids = new Set(groupBranchIds);
    return branches.reduce((sum, b) => sum + (ids.has(b.branch_id) ? b.value : 0), 0);
  }
  return bucket.total;
};

/**
 * Pre-Sales' own analytics board — same data, same math as Branches & Verticals >
 * Overview, just reached from inside the Sales Master View instead. A second call to
 * the same endpoint rather than lifted state: the two boards' date/branch filters are
 * independent, and sharing one would mean picking a date range on one silently changed
 * what the other was showing.
 */
const PreSalesAnalyticsPanel = ({ sourceFilter, groupBranchIds, role }) => {
  // Marketing Head reads a leads dashboard here instead of the seven figures: charts of
  // where leads came from and how far they got, and no money anywhere. A marketing desk
  // does not answer for revenue, and putting it on the same screen invites reading a
  // source's worth off charts that never priced anything.
  const leadsOnly = role === "marketing_head";
  // Opens on today, the same as the Leads pane beside it — the board is read to see where
  // the day stands, and every wider range is a step back from that.
  const [preset, setPreset] = useState("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  // Held apart from `data` so a failed load can say so. Swallowing the error left every
  // card reading 0, which is indistinguishable from a branch that genuinely has none —
  // and that is exactly how a 403 on this endpoint passed for real figures.
  const [failed, setFailed] = useState(false);

  const { startDate, endDate } = useMemo(() => {
    const today = new Date();
    // "All" carries no dates at all — see load(), which then asks for no window rather
    // than for a very wide one, and lets the endpoint answer over everything it holds.
    if (preset === "all") return { startDate: "", endDate: "" };
    if (preset === "today") return { startDate: presalesToIso(today), endDate: presalesToIso(today) };
    if (preset === "this_week") return { startDate: presalesToIso(presalesStartOfWeek(today)), endDate: presalesToIso(today) };
    if (preset === "this_month") return { startDate: presalesToIso(presalesStartOfMonth(today)), endDate: presalesToIso(today) };
    return { startDate: customFrom, endDate: customTo };
  }, [preset, customFrom, customTo]);

  const load = useCallback(() => {
    // The leads dashboard fetches its own, leaner data — this call carries revenue and
    // session figures it has no cards for.
    if (leadsOnly) return;
    if (preset === "custom" && (!customFrom || !customTo)) return;
    setLoading(true);
    const params = preset === "all" ? {} : { start_date: startDate, end_date: endDate };
    getDashboardOverview(params)
      .then((rows) => { setData(rows); setFailed(false); })
      .catch(() => { setData(null); setFailed(true); })
      .finally(() => setLoading(false));
  }, [startDate, endDate, preset, customFrom, customTo, leadsOnly]);

  useEffect(() => { load(); }, [load]);

  // The branch pill, resolved to the id the leads dashboard filters on. A pill is the
  // narrower of the two and wins; with none lit the group above it decides, and an empty
  // list is every branch — which is what no pill selected has always meant.
  const branchIds = useMemo(
    () => (sourceFilter ? [sourceFilter] : (groupBranchIds || [])),
    [sourceFilter, groupBranchIds],
  );

  const fmt = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

  return (
    <div className="space-y-4" data-testid="presales-analytics-panel">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:gap-3 sm:p-3" data-testid="presales-analytics-date-filter">
        <SegmentedPillGroup options={PRESALES_ANALYTICS_DATE_PRESETS} active={preset} onPick={setPreset} testid="presales-analytics-preset" />
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <CalendarDays className="h-3.5 w-3.5" />
            <MilkDateInput value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-slate-200 px-2 text-xs" data-testid="presales-analytics-custom-from" />
            <span>to</span>
            <MilkDateInput value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-slate-200 px-2 text-xs" data-testid="presales-analytics-custom-to" />
          </div>
        )}
      </div>

      {leadsOnly ? (
        // Under the same range row above, which is the only filter row on this pane — the
        // dashboard's charts all read the slice it selects.
        <LeadsAnalyticsDashboard
          startDate={preset === "all" ? "" : startDate}
          endDate={preset === "all" ? "" : endDate}
          branchIds={branchIds}
        />
      ) : loading && !data ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
      ) : failed ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800" data-testid="presales-analytics-failed">
          These figures could not be loaded. Refresh to try again — if it keeps happening, this account may not have access to the org-wide numbers.
        </p>
      ) : (
        // All seven across one row on a wide screen — they are one funnel read
        // left to right, and wrapping the last three onto a second line broke that
        // into two groups it does not actually have. Narrower widths still wrap:
        // seven cards on a laptop would leave no room for the figures themselves.
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" data-testid="presales-analytics-metrics">
          {PRESALES_ANALYTICS_METRICS.map((m) => {
            const value = presalesAnalyticsValueFor(data?.[m.key], sourceFilter, groupBranchIds);
            return (
              <div key={m.key} className="rounded-xl border-2 border-slate-200 bg-white px-3 py-3 sm:px-4 sm:py-3.5" data-testid={`presales-analytics-metric-${m.key}`}>
                {/* Wraps rather than truncating. Seven-up leaves a card too narrow for
                    the longer names, and "TREATMENT PURCHASE …" on two of them gave no
                    way to tell the count from the revenue. The two-line floor keeps the
                    figures on one baseline across the row whether a label takes one line
                    or two. */}
                <span className="block min-h-[2.5em] text-[11px] font-bold uppercase leading-tight tracking-wider text-slate-500">{m.label}</span>
                {/* Steps down wherever the card is narrow: two-up on a phone and seven-up
                    at xl both leave about 170px, and "₹5,54,752" at the larger size runs
                    straight out of it — as a truncated figure, which reads as a smaller
                    number rather than as a clipped one. */}
                <span className="mt-1 block truncate text-2xl font-extrabold text-slate-800 sm:text-3xl xl:text-2xl">{m.currency ? fmt(value) : value}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const PRESALES_TABS = [
  { key: "leads", label: "Leads", icon: Users },
  { key: "consultations", label: "Consultations", icon: CalendarCheck },
  { key: "profile", label: "Profile", icon: UserRound },
];

const PRESALES_CRM_LOCKED = false;

/**
 * The Pre-Sales pipeline.
 *
 * Mounted in three places: the Pre Sales role's own view, Super Admin > PRE SALES, and —
 * when a branch runs on Branch Admin Lead Control — as the first tab of that branch's
 * Branch Admin Master View. The third is why `branchControlled` exists: the same board,
 * pointed at the other half of the leads.
 *
 * @param branchControlled  false shows leads whose branch leaves them to Pre-Sales (the
 *                          Pre-Sales desk's own book). true shows the leads a branch has
 *                          taken over, which is exactly what its Branch Admin works.
 *                          The two are complements, so no lead is on both boards and
 *                          none is on neither.
 * @param branchId          the branch this board is pinned to, when it is pinned to one.
 *                          Stands in for currentUser.branch_id so a Super Admin drilled
 *                          into a branch schedules against that branch, not none.
 * @param embedded          drop the phone bottom-padding; the host board already pads for
 *                          its own fixed nav and two lots of it leave a dead band.
 */
export const PreSalesCRM = ({
  onManageStages,
  role,
  currentUser,
  onLogout,
  branchControlled = false,
  branchId = null,
  embedded = false,
  // Leads / Analytics, when the page header owns the switch instead of this board. Passed
  // together or not at all: given both, the in-board tab strip stands down and the header's
  // is the only one, so the two can never sit on screen disagreeing about the current page.
  masterView: masterViewProp,
  onMasterViewChange,
  // Operations' Pre Sales tab: pinned to one rep, on top of whatever branchId already
  // narrows to. Nothing else passes this, so every existing caller is unaffected.
  assignedUserId = null,
  // Super Admin's Marketing / Sales Master View and Operations' Pre Sales tab, and the
  // Business Development Executive's Marketing View / Sales View: the leads pane only,
  // with no Leads / Analytics switch, and the All/Online/Offline group and the branch
  // pills folded into the toolbar as two dropdowns instead of a row of their own above
  // the cards. Sales Head's and Marketing Head's own boards leave both off and keep their
  // rows.
  leadsOnly = false,
  branchFilterInToolbar = false,
}) => {
  const [stages, setStages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [branches, setBranches] = useState([]);
  const [search, setSearch] = useState("");
  // Opens on New Leads, not All — that's the stage that needs action; a rep shouldn't
  // have to dig through everything already worked on just to see what's new. Marketing
  // Head has no leads to action, so its funnel opens on the whole picture instead.
  // A rep opens on New Leads — the stage that needs action, rather than a list of
  // everything already worked. A master view opens on All: its cards are not a worklist,
  // and "all" is the key every one of those rows uses for the unfiltered card.
  const [stageFilter, setStageFilter] = useState(() => (
    ["marketing_head", "super_admin", "sales_head"].includes(role) ? "all" : "New Leads"
  ));
  const [sourceFilter, setSourceFilter] = useState("");
  // Opens on today, matching the Analytics pane. Held as the same { key, label, from, to }
  // any pick produces, so the Today pill reads as selected on arrival rather than the board
  // showing a filtered set with nothing on screen saying it is filtered.
  const [dateFilter, setDateFilter] = useState(() => ({ key: "today", label: "Today", ...presalesRangeFor("today") }));
  const [editing, setEditing] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [loading, setLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [activeTab, setActiveTab] = useState("leads"); // mobile bottom-nav only; desktop always shows Leads
  // Super Admin, Sales Head and Marketing Head only, from here down: which top-level
  // pane is showing. Sales Head is Pre-Sales' own manager, and Marketing Head reads the
  // same funnel from the marketing side -- both get the same org-wide picture Super
  // Admin's Pre Sales tab has, rather than one rep's own filtered book.
  //
  // Which arm the board is reading: "all" | "online" | "offline". This was here once and
  // was taken out as a second control for a scope the branch pills could already pick.
  // That was wrong about what it does. A pill selects one branch, so the pills alone can
  // show one online arm or the other and never both — and "how did Online do today" is a
  // question this view exists to answer. Back, and narrowing the pills as well as the
  // list, so the two read as one control rather than two that disagree.
  const [modeFilter, setModeFilter] = useState("all");
  const [masterViewOwn, setMasterViewOwn] = useState("leads"); // "leads" | "analytics"
  // The header's copy wins when the page supplies one; otherwise this board keeps its own.
  const headerOwnsViewTabs = typeof onMasterViewChange === "function";
  // leadsOnly pins the pane rather than only hiding the switch, so nothing can leave the
  // board on an Analytics pane with no way back.
  const masterView = leadsOnly ? "leads" : headerOwnsViewTabs ? masterViewProp : masterViewOwn;
  const setMasterView = headerOwnsViewTabs ? onMasterViewChange : setMasterViewOwn;
  // The two rows above the cards, each of which can stand down: the view tabs when the
  // header carries them or the board is leads-only, the branch row when its two filters
  // ride in the toolbar instead.
  const showViewTabs = !headerOwnsViewTabs && !leadsOnly;
  const showBranchRow = branches.length > 0 && !branchFilterInToolbar;
  // Which desk's half of the book to read: "all" | "pre_sales" | "branch_admin". Opens on
  // All, the whole picture this view exists to give — the other two are a step in from it.
  const [handledByFilter, setHandledByFilter] = useState("all");
  const isSuperAdminMasterView = role === "super_admin" || role === "sales_head" || role === "marketing_head";
  // Marketing Head's KPI row is a fixed funnel rather than the live, admin-configurable
  // Pre-Sales stage list everyone else's cards come from (see MARKETING_HEAD_FUNNEL) —
  // two of its buckets aren't a single stage-field equality.
  const isMarketingHeadFunnel = role === "marketing_head";
  // Super Admin's and Sales Head's card row: the five counts and two revenue figures, not
  // the live Pre-Sales stage list. An individual rep keeps that list — New Leads / RNR /
  // Follow Up is how they work their own book, and these seven answer a different question.
  const isSalesMasterCards = isSuperAdminMasterView && !isMarketingHeadFunnel;
  // Marketing Head's board only, as asked for. Every master view carries both desks' leads
  // and tags each row HANDLED BY, so this would read the same on Super Admin's and Sales
  // Head's — flipping this one flag is all it would take to give it to them too.
  const showHandledByFilter = role === "marketing_head";
  // Marketing Master View reads the funnel; it does not work it. The lead popup there is a
  // record to look at, so the Move to Stage row is gone from its footer. Pre-Sales and the
  // Sales master views keep it - they are the desks that actually move a lead along.
  const canMoveStage = role !== "marketing_head";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Scoped to the branch when this board is pinned to one. The API already scopes a
      // Branch Admin to their own branch, but a Super Admin drilled into a branch is not
      // scoped by anything — without this they would see every branch's taken-over leads
      // on one branch's tab.
      const [stgs, ldList] = await Promise.all([
        stagesList("pre_sales"),
        getLeads(branchId ? { branch_id: branchId } : {}),
      ]);
      setStages(stgs);
      // Lead Control splits the leads between two copies of this board: the Pre-Sales
      // desk's own, and the one a branch gets when it takes its leads over. Filtered here
      // at the source rather than in each memo below — the KPI cards, the stage tabs, the
      // table and the pipeline view all read from this one list, and a lead hidden from
      // three of the four would be worse than showing it everywhere. The backend resolves
      // the flag from each lead's branch on every fetch, so flipping the switch moves
      // leads between the two boards on the next refresh.
      //
      // Super Admin's Master View is the one exception: it is meant to be the whole
      // picture across every branch, so it shows both halves at once (each row tagged
      // Branch Admin or Pre-Sales) instead of picking one side the way the Pre-Sales
      // role's own board and a branch's embedded board still do.
      setLeads(isSuperAdminMasterView ? ldList : ldList.filter((l) => handledBy(l, branchControlled ? "branch_admin" : "pre_sales")));
      // If a lead is currently open in the detail dialog, refresh its reference
      // so saved edits show up immediately.
      setEditing((prev) => prev ? (ldList.find((l) => l.id === prev.id) || prev) : prev);
    } catch (e) { toast.error("Failed to load"); }
    setLoading(false);
  }, [branchControlled, branchId, isSuperAdminMasterView]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { getBranches().then(setBranches).catch(() => {}); }, []);

  // The branches the group holds, and their ids. One source for three readers: the pills
  // draw from the list, the leads memo filters on the ids, and Analytics is scoped by the
  // same ids so the two panes cannot describe different populations.
  const modeBranches = useMemo(() => (
    modeFilter === "all"
      ? branches
      : branches.filter((b) => isOnlineVertical(b.vertical) === (modeFilter === "online"))
  ), [branches, modeFilter]);
  // Empty for All, which every reader downstream already treats as unscoped.
  const modeBranchIds = useMemo(
    () => (modeFilter === "all" ? [] : modeBranches.map((b) => b.id)),
    [modeFilter, modeBranches],
  );

  // Changing the group has to let go of a pill the new group does not contain. Left set,
  // the board would keep filtering to a branch whose pill is no longer drawn — a list
  // narrowed to one branch with nothing on screen naming it. Done here rather than in an
  // effect so the pills and the rows never render a frame out of step.
  const pickMode = (key) => {
    setModeFilter(key);
    setSourceFilter((id) => {
      if (!id || key === "all") return id;
      const picked = branches.find((b) => b.id === id);
      return picked && isOnlineVertical(picked.vertical) === (key === "online") ? id : "";
    });
  };

  // Leads narrowed by Date Filter + Branch filter only — feeds both the KPI
  // summary cards and the table, so the cards stay dynamic with those two filters
  // without also collapsing to whatever single stage tab is currently selected.
  const dateSourceFiltered = useMemo(() => {
    let rows = leads;
    // Empty is every branch, which is why the control opens on "All Branches" and its
    // reset returns here. Leads with no branch yet are the unassigned ones and belong in
    // the all-branches view, so they only drop out once a specific branch is picked.
    if (sourceFilter) {
      rows = rows.filter((l) => (l.branch_id || "") === sourceFilter);
    }
    // The arm, where no single branch is picked — and pickMode guarantees a picked one is
    // already inside it, so the two never fight. A lead with no branch yet belongs to
    // neither arm, so it drops out of a group exactly as it drops out of a named branch.
    if (modeFilter !== "all") {
      const ids = new Set(modeBranchIds);
      rows = rows.filter((l) => ids.has(l.branch_id));
    }
    if (assignedUserId) {
      rows = rows.filter((l) => l.assigned_user_id === assignedUserId);
    }
    // The same complement load() splits the two boards on, applied here as a filter rather
    // than at the source: this view is meant to hold both halves, and narrowing it is a
    // question the user asks of it, not the shape of what it fetched.
    if (showHandledByFilter && handledByFilter !== "all") {
      rows = rows.filter((l) => handledBy(l, handledByFilter));
    }
    if (dateFilter) {
      const from = dateFilter.from?.getTime();
      const to = dateFilter.to?.getTime();
      rows = rows.filter((l) => {
        const ts = new Date(l.created_at || 0).getTime();
        if (!ts) return false;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      });
    }
    return rows;
  }, [leads, sourceFilter, modeFilter, modeBranchIds, dateFilter, showHandledByFilter, handledByFilter, assignedUserId]);

  const stageCounts = useMemo(() => {
    const map = { All: dateSourceFiltered.length };
    stages.forEach((s) => { map[s.name] = 0; });
    dateSourceFiltered.forEach((l) => { if (map[l.stage] != null) map[l.stage] += 1; });
    return map;
  }, [dateSourceFiltered, stages]);

  // Marketing Head's own bucket counts — same idea as stageCounts, against
  // MARKETING_HEAD_FUNNEL's match functions instead of a live stage-name equality.
  const funnelCounts = useMemo(() => {
    const map = { all: dateSourceFiltered.length };
    MARKETING_HEAD_FUNNEL.forEach((b) => { map[b.key] = dateSourceFiltered.filter(b.match).length; });
    return map;
  }, [dateSourceFiltered]);

  // The master cards' figures — a count for the five, a sum for the two revenue ones. Both
  // read the same date/branch-filtered set the table does, so a card and the rows it opens
  // can never describe different populations.
  const masterCardValues = useMemo(() => {
    const map = { all: dateSourceFiltered.length };
    SALES_MASTER_CARDS.forEach((c) => {
      if (c.key === "all") return;
      map[c.key] = c.amount
        ? dateSourceFiltered.reduce((sum, l) => sum + c.amount(l), 0)
        : dateSourceFiltered.filter(c.match).length;
    });
    return map;
  }, [dateSourceFiltered]);

  // Total plus up to eight stage cards. Declared here rather than further down because
  // kpiCardModels below reads it — a const referenced above its own declaration is a
  // ReferenceError at render, not a hoisted undefined.
  const kpiStages = stages.slice(0, 8);

  /**
   * One list of cards for whichever row this board is showing, so the desk and the phone
   * render the same set from the same source. They used to be two pieces of JSX, and the
   * phone's was a stage bar keyed on stage names — which on a master view meant its pills
   * set a filter the card logic did not recognise, and clicking one quietly did nothing.
   *
   * `key` is what stageFilter holds; `testid` is kept separate so every id these cards
   * already had survives.
   */
  const kpiCardModels = useMemo(() => {
    if (isMarketingHeadFunnel) {
      return [
        { key: "all", testid: "all", label: "All", value: funnelCounts.all, color: "#22c55e" },
        ...MARKETING_HEAD_FUNNEL.map((b) => ({
          key: b.key, testid: b.key, label: b.label, value: funnelCounts[b.key] || 0, color: b.color,
        })),
      ];
    }
    if (isSalesMasterCards) {
      return SALES_MASTER_CARDS.map((c) => ({
        key: c.key,
        testid: c.key,
        label: c.label,
        color: c.color,
        // Rupees on the two revenue cards, a plain count on the rest — a bare number beside
        // "Consultation Revenue" reads as a count of consultations.
        value: c.amount
          ? `₹${Number(masterCardValues[c.key] || 0).toLocaleString("en-IN")}`
          : Number(masterCardValues[c.key] || 0).toLocaleString("en-IN"),
      }));
    }
    return [
      { key: "All", testid: "all", label: "Total Leads", value: stageCounts.All, color: "#22c55e" },
      ...kpiStages.map((s) => ({
        key: s.name, testid: s.name, label: s.name, value: stageCounts[s.name] || 0, color: s.color,
        // The stage's own hover and picked colours from CI/CD ROOTS; unset falls back to color.
        hoverColor: s.hover_color, selectedColor: s.selected_color,
      })),
    ];
  }, [isMarketingHeadFunnel, isSalesMasterCards, funnelCounts, masterCardValues, stageCounts, kpiStages]);

  // The toolbar filter and the per-row assign dropdown take the same {value,label} shape,
  // so they share one list. The source list that used to sit here went with the filter it
  // fed — the SOURCE column still shows where each lead came from, it is just no longer
  // something you can narrow the board by.
  const branchOptions = useMemo(() => branches.map((b) => ({ value: b.id, label: branchLabel(b) })), [branches]);

  const filtered = useMemo(() => {
    let rows = dateSourceFiltered;
    if (isMarketingHeadFunnel) {
      if (stageFilter !== "all") {
        const bucket = MARKETING_HEAD_FUNNEL.find((b) => b.key === stageFilter);
        if (bucket) rows = rows.filter(bucket.match);
      }
    } else if (isSalesMasterCards) {
      if (stageFilter !== "all") {
        const card = SALES_MASTER_CARDS.find((c) => c.key === stageFilter);
        // A revenue card narrows to the leads that contributed to it, so the figure can be
        // taken apart rather than only looked at.
        if (card?.amount) rows = rows.filter((l) => card.amount(l) > 0);
        else if (card?.match) rows = rows.filter(card.match);
      }
    } else if (stageFilter !== "All") {
      rows = rows.filter((l) => l.stage === stageFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((l) => (l.name || "").toLowerCase().includes(q) || (l.phone || "").includes(q) || (l.email || "").toLowerCase().includes(q));
    }
    return rows.slice().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }, [dateSourceFiltered, stageFilter, search, isMarketingHeadFunnel, isSalesMasterCards]);

  // Rendering thousands of rows at once is fine on desktop but chokes mobile
  // devices, so re-page back to 50 whenever the filtered set changes.
  useEffect(() => { setVisibleCount(50); }, [stageFilter, sourceFilter, modeFilter, search, dateFilter, handledByFilter]);
  const visibleLeads = filtered.slice(0, visibleCount);

  // The desk table's columns and each one's share of the row. table-fixed divides the row
  // by the stated widths, so they have to add up to the whole however many of the optional
  // columns are drawn: each is a weight here, turned into a percentage of what is on.
  // Stage is wide enough for its chip and a follow-up time beside it, and Branch Admin
  // Status for branch, status and expert on the one line.
  const tableCols = [
    ["lead", 20], ["contact", 13], ["source", 11], ["stage", 18],
    isSuperAdminMasterView && ["handled", 12],
    stageFilter === "Appointment" && ["branchStatus", 24],
    stageFilter === "RNR" && ["lastCall", 16],
    ["created", 10], ["assigned", 15], ["actions", 6],
  ].filter(Boolean);
  const tableWeight = tableCols.reduce((sum, [, w]) => sum + w, 0);
  const colWidth = Object.fromEntries(tableCols.map(([key, w]) => [key, { width: `${(w / tableWeight) * 100}%` }]));

  // Mobile Consultations tab — this rep's leads currently booked for a consultation.
  // Not narrowed by the Leads tab's own date filter — ConsultationsTab applies its own.
  const appointmentLeads = useMemo(
    () => leads.filter((l) => l.stage === "Appointment").sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")),
    [leads],
  );

  const moveToStage = async (leadId, stageName) => {
    try { await updateLead(leadId, { stage: stageName }); toast.success(`Moved to ${stageName}`); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Move failed"); }
  };

  if (PRESALES_CRM_LOCKED) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white py-24 text-center" data-testid="presales-crm-locked">
        <Lock className="h-10 w-10 text-slate-300" />
        <h2 className="text-xl font-bold text-slate-700">Pre Sales is locked</h2>
        <p className="max-w-sm text-sm text-slate-500">This dashboard has been locked by a Super Admin. Contact your administrator to restore access.</p>
      </div>
    );
  }

  // flex+gap, not space-y — space-y's sibling selector keys off the `hidden` HTML
  // attribute, not the `hidden` class, so the desktop leads block (hidden by class
  // on mobile, not attribute) would still count as a sibling and hand the next
  // block phantom top margin for content a phone never draws.
  // Bottom padding for every role now, not just Pre Sales: Super Admin gets the card list
  // on a phone too, and its own fixed bottom nav would otherwise sit on the last card.
  // Desktop has no bar and no padding.
  return (
    <div className={`flex flex-col gap-5 ${embedded ? "" : "pb-20 md:pb-0"}`} data-testid="presales-crm-page">
    {/* Desk only, whoever is looking. Super Admin used to get this table on a phone while
        the Pre Sales role got the card list below — the same screen, one of them unusable,
        decided by who was logged in. Both now get the cards. */}
    <div className="hidden space-y-5 md:block" data-testid="presales-leads-tab">
      {/* Master View controls — Super Admin only: which pane (Leads / Analytics), and
          which branches (All/Online/Offline, then the individual branches in that
          group) both panes are scoped to.

          Above the KPI cards, because the cards are counted for whatever these select.
          With the cards on top they read as the page's headline totals, which is not what
          they are the moment a branch pill is on. */}
      {isSuperAdminMasterView && (showViewTabs || showBranchRow) && (
        <div className="space-y-2" data-testid="presales-master-controls">
          {/* A rule under it, the same one the branch tabs carry: it separates the two
              pages from the filters that narrow whichever one is open. Skipped when the
              page header carries them instead — two strips would be two answers. */}
          {showViewTabs && (
            <div className="flex items-center gap-1 border-b border-slate-200 pb-2" data-testid="presales-view-tabs">
              <PreSalesViewTab active={masterView === "leads"} onClick={() => setMasterView("leads")} testid="presales-view-leads">
                <Users className="h-4 w-4" />Leads
              </PreSalesViewTab>
              <PreSalesViewTab active={masterView === "analytics"} onClick={() => setMasterView("analytics")} testid="presales-view-analytics">
                <BarChart3 className="h-4 w-4" />Analytics
              </PreSalesViewTab>
            </div>
          )}

          {showBranchRow && (
            <div className="flex flex-wrap items-center gap-2" data-testid="presales-branch-filters">
              {/* Ahead of the pills, not above them: the group and the branches in it are
                  one question narrowing by degrees, and a row of its own would read as a
                  filter for something else. */}
              <SegmentedPillGroup options={BRANCH_MODE_FILTERS} active={modeFilter} onPick={pickMode} testid="presales-branch-mode" />
              <div className="flex flex-wrap items-center gap-1.5" data-testid="presales-branch-pills">
                {modeBranches.map((b) => (
                  <PreSalesBranchPill
                    key={b.id}
                    active={sourceFilter === b.id}
                    onClick={() => setSourceFilter((id) => (id === b.id ? "" : b.id))}
                    testid={`presales-branch-pill-${b.id}`}
                  >
                    {branchLabel(b)}
                  </PreSalesBranchPill>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* KPI Cards — the Leads pane only. They are that table's stage filter, not a
          summary: each one selects a stage and the list below narrows to it. Analytics
          has no such table to narrow, and its own cards already open with All Leads, so
          on that pane these were a second row of counts answering nothing. */}
      {/* Columns sized to the label rather than counted out per breakpoint: auto-fit packs
          in as many as fit, and the floor is whatever holds the longest of these names —
          "Branch Admin Appointment" — on one line inside the card's padding.
          The floor is the whole balancing act. Too low and the label wraps; too high and
          the eighth card drops to a second row. 10.5rem is what lets all eight sit across
          a full desktop while still fitting that name whole, and it only works because the
          label is sentence case: uppercase runs about a third wider and needed 13.5rem,
          which is what pushed the row onto two lines.
          Narrower windows take fewer cards per row rather than squeezing the words. */}
      {!(masterView === "analytics" && isSuperAdminMasterView) && (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]" data-testid="presales-kpi-row">
          {kpiCardModels.map((c) => (
            <KpiCard
              key={c.key}
              label={c.label}
              value={c.value}
              active={stageFilter === c.key}
              color={c.color}
              hoverColor={c.hoverColor}
              selectedColor={c.selectedColor}
              onClick={() => setStageFilter(c.key)}
              testid={`presales-kpi-${c.testid}`}
            />
          ))}
        </div>
      )}

      {masterView === "analytics" && isSuperAdminMasterView ? (
        <PreSalesAnalyticsPanel sourceFilter={sourceFilter} groupBranchIds={modeBranchIds} role={role} />
      ) : (
      <>
      {/* Toolbar — Branch Admin's Branch Leads bar, piece for piece: the search first and
          capped (a field stretched across the desk is mostly empty runway), the one-tap
          ranges as separate buttons beside it, the Handled By filter as a dropdown where
          Branch Admin keeps its Pain Type / City ones, and the actions pushed to the right
          edge — calendar, refresh, create, pull. No box around it, the same as there.

          Built from the same QuickDateFilterBar that board uses rather than restyling
          this board's own pills, so the two cannot drift apart. It emits the
          { key, label, from, to } shape dateFilter already holds, and null for All. The
          calendar is the Custom: the ranges hide their own Custom trigger (showCustom)
          because the icon on the right opens the same popover. */}
      <div className="flex flex-wrap items-center gap-3" data-testid="presales-toolbar">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search leads by name, email, phone..." className="h-10 pl-9" data-testid="presales-search" />
        </div>
        <div className="shrink-0">
          <QuickDateFilterBar value={dateFilter} onChange={setDateFilter} testid="presales-leads-range" inline showCustom={false} />
        </div>
        {isSuperAdminMasterView && branchFilterInToolbar && branches.length > 0 && (
          <BranchScopeSelects
            mode={modeFilter}
            onMode={pickMode}
            branchId={sourceFilter}
            onBranch={setSourceFilter}
            branches={modeBranches}
            testid="presales-toolbar-branch"
          />
        )}
        {showHandledByFilter && (
          <Select value={handledByFilter} onValueChange={setHandledByFilter}>
            <SelectTrigger
              title="Handled By"
              aria-label="Handled By"
              className={toolbarSelectClass(handledByFilter !== "all")}
              data-testid="presales-leads-range-handled-by"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-slate-200">
              {HANDLED_BY_FILTERS.map((o) => (
                <SelectItem key={o.key} value={o.key} className="text-xs text-slate-700" data-testid={`presales-leads-range-handled-by-${o.key}`}>
                  {o.key === "all" ? "All Handlers" : o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Icons only; the labels live on title/aria-label so a hover and a screen reader
            still say what each does. Same order and colours as Branch Leads. */}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="presales-date-filter" centered iconOnly />
          <Button
            onClick={load}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="presales-refresh-btn"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            onClick={() => setShowCreate(true)}
            title="Create Lead"
            aria-label="Create Lead"
            className="h-10 w-10 shrink-0 bg-sky-600 p-0 hover:bg-sky-700"
            data-testid="presales-create-lead-btn"
          >
            <UserPlus className="h-4 w-4" />
          </Button>
          <PullFromSheetButton onPulled={load} iconOnly />
          {role === "super_admin" && (
            <Button
              variant="outline"
              className="h-10 shrink-0 px-4"
              onClick={onManageStages}
              title="Manage Stages"
              aria-label="Manage Stages"
              data-testid="presales-manage-stages-btn"
            >
              <Cog className="mr-1 h-4 w-4" />
              Manage Stages
            </Button>
          )}
        </div>
      </div>

      {/* The stage strip that used to sit here is gone. It set the same `stageFilter`
          the KPI cards above already set, so every stage was on screen twice, four
          rows apart, with the pair drifting out of step as you clicked either one.
          The cards win: they carry the counts. The mobile block below keeps its own
          StageTabBar — it has no KPI row, so that one isn't a duplicate. */}

      {/* Leads table — Branch Admin's Branch Leads list, piece for piece: drawn at 90%,
          its own scroll region under a sticky header, and one line a row. What used to
          sit on a second line under a cell — the email under the phone, the follow-up
          time under the stage, the branch's status and expert under its name — is beside
          it or on its hover instead. zoom scales vh with everything else, so 72vh here is
          the same 65vh of screen the Branch Leads list takes. */}
      <div className="w-full overflow-hidden rounded-lg border border-slate-200 bg-white" style={{ zoom: 0.9 }} data-testid="presales-leads-card">
          <div className="max-h-[72vh] overflow-auto">
            <table className="w-full min-w-[900px] table-fixed divide-y divide-slate-200 text-sm">
              <thead className="sticky top-0 z-10 bg-slate-700 text-left text-xs font-semibold uppercase tracking-wide text-white">
                <tr>
                  <th className="truncate px-4 py-3" style={colWidth.lead}>Lead</th>
                  <th className="truncate px-4 py-3" style={colWidth.contact}>Contact</th>
                  <th className="truncate px-4 py-3" style={colWidth.source}>Source</th>
                  <th className="truncate px-4 py-3" style={colWidth.stage}>Stage</th>
                  {isSuperAdminMasterView && <th className="truncate px-4 py-3" style={colWidth.handled}>Handled By</th>}
                  {stageFilter === "Appointment" && <th className="truncate px-4 py-3" style={colWidth.branchStatus}>Branch Admin Status</th>}
                  {stageFilter === "RNR" && <th className="truncate px-4 py-3" style={colWidth.lastCall}>Last Call</th>}
                  <th className="truncate px-4 py-3" style={colWidth.created}>Created</th>
                  <th className="truncate px-4 py-3" style={colWidth.assigned}>Assigned To</th>
                  <th className="truncate px-2 py-3 text-center" style={colWidth.actions}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleLeads.map((l) => {
                  const stg = stages.find((s) => s.name === l.stage);
                  const stageHex = stageInk(stg);
                  return (
                    <tr key={l.id} onClick={() => setEditing(l)} className="cursor-pointer transition-colors hover:bg-slate-50" data-testid={`presales-lead-row-${l.id}`}>
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3" title={l.name || undefined}>
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                            {l.name?.charAt(0)?.toUpperCase() || "?"}
                          </div>
                          <span className="truncate font-semibold text-slate-900">{l.name}</span>
                        </div>
                      </td>
                      {/* Number only, and the email on its hover. Call and WhatsApp both
                          hand off to an app the desk does not have — tel: and wa.me open a
                          dialer and a phone client, so on a desktop they were two icons per
                          row that either did nothing or launched the wrong thing. They stay
                          on the phone cards, where they work. */}
                      <td className="truncate px-4 py-3 text-slate-600" title={[displayPhone(l.phone), l.email].filter(Boolean).join("\n") || undefined}>
                        {displayPhone(l.phone) || "—"}
                      </td>
                      <td className="truncate px-4 py-3 text-slate-600" title={l.source_tab || l.source_type ? sourceLabel(l.source_tab || l.source_type) : undefined} data-testid={`presales-lead-source-${l.id}`}>
                        {sourceLabel(l.source_tab || l.source_type) || "—"}
                      </td>
                      <td className="px-4 py-3">
                        {/* One width for every chip, so the column reads as a row of equal
                            boxes — the Branch Leads list's stage chip. The RNR count and the
                            follow-up time ride beside it rather than under it. */}
                        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <span
                            title={l.stage || undefined}
                            className="inline-block w-[118px] max-w-full shrink-0 truncate rounded-[5px] border px-2 py-0.5 text-center align-middle text-xs font-medium"
                            style={{ background: `${stageHex}14`, color: stageHex, border: `1px solid ${stageHex}33` }}
                          >
                            {l.stage || "—"}
                          </span>
                          {l.stage === "RNR" && (l.rnr_attempts || 0) > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold text-rose-700" title={`${l.rnr_attempts} unanswered call attempts`} data-testid={`presales-rnr-badge-${l.id}`}>
                              <PhoneOff className="h-2.5 w-2.5" />×{l.rnr_attempts}
                            </span>
                          )}
                          {l.stage === "Follow Up" && l.next_follow_up_at && (() => {
                            const dt = new Date(l.next_follow_up_at);
                            const today = new Date(); today.setHours(0, 0, 0, 0);
                            const diff = Math.floor((dt.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
                            const isToday = diff === 0;
                            const isTomorrow = diff === 1;
                            const isPast = dt.getTime() < Date.now();
                            const tone = isPast ? "bg-rose-50 text-rose-700 border-rose-200" : isToday ? "bg-amber-50 text-amber-700 border-amber-300" : "bg-emerald-50 text-emerald-700 border-emerald-200";
                            return (
                              <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`} data-testid={`presales-followup-badge-${l.id}`}>
                                <Clock className="h-2.5 w-2.5" />
                                {isToday ? "Today" : isTomorrow ? "Tomorrow" : dt.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}
                                {" · "}
                                {dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
                              </span>
                            );
                          })()}
                        </div>
                      </td>
                      {isSuperAdminMasterView && (
                        <td className="px-4 py-3" title={l.lead_control !== "pre_sales" && l.branch_stage ? l.branch_stage : undefined} data-testid={`presales-handled-by-${l.id}`}>
                          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                            <span className="shrink-0"><HandledByBadge lead={l} /></span>
                            {l.lead_control !== "pre_sales" && l.branch_stage && (
                              <span className="min-w-0 truncate text-[10px] text-slate-400">{l.branch_stage}</span>
                            )}
                          </div>
                        </td>
                      )}
                      {stageFilter === "Appointment" && (() => {
                        const { branchName, status, statusColor } = branchStatusInfo(l, branches);
                        const expert = l.assigned_physio_name ? `Expert: ${l.assigned_physio_name}` : "Pending Expert";
                        // Branch, status and expert on the one line, the branch name giving
                        // way first so the status and the expert stay readable; all three
                        // in full on hover.
                        return (
                          <td className="px-4 py-3 text-xs" title={[branchName, status, expert].filter(Boolean).join(" · ")}>
                            <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap" data-testid={`presales-branch-status-${l.id}`}>
                              <span className="min-w-0 truncate font-semibold text-slate-700">{branchName || "—"}</span>
                              <span className={`inline-flex shrink-0 items-center rounded border px-1.5 text-[10px] font-semibold ${statusColor}`}>{status}</span>
                              <span className={`shrink-0 text-[10px] ${l.assigned_physio_name ? "text-emerald-600" : "text-amber-600"}`}>{expert}</span>
                            </div>
                          </td>
                        );
                      })()}
                      {stageFilter === "RNR" && (
                        <td className="px-4 py-3">
                          {l.rnr_last_attempt_at ? (
                            <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap" title={`${callTimeStamp(l.rnr_last_attempt_at)} · ${callDateStamp(l.rnr_last_attempt_at)}`} data-testid={`presales-rnr-lastcall-${l.id}`}>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                                <Clock className="h-2.5 w-2.5" />{callTimeStamp(l.rnr_last_attempt_at)}
                              </span>
                              <span className="shrink-0 text-[10px] text-slate-400">{callDateStamp(l.rnr_last_attempt_at)}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      )}
                      <td className="truncate px-4 py-3 text-slate-500">{(l.created_at || "").slice(0, 10) || "—"}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <BranchSelect
                          value={l.branch_id || ""}
                          options={branchOptions}
                          placeholder="— Assign —"
                          emptyText="No branches available."
                          // pickedBranchId, not branchId — the component now takes a
                          // branchId prop, and a parameter shadowing it here would read
                          // like the board's own branch rather than the row's choice.
                          onChange={async (pickedBranchId) => {
                            if (!pickedBranchId) return;
                            try {
                              await scheduleAppointment(l.id, { department: "physio", mode: "offline", branch_id: pickedBranchId });
                              toast.success(`Assigned to ${branchLabel(branches.find((b) => b.id === pickedBranchId)) || "branch"}`);
                              load();
                            } catch (err) { toast.error(err?.response?.data?.detail || "Failed to assign branch"); }
                          }}
                          testid={`presales-assign-branch-${l.id}`}
                        />
                      </td>
                      <td className="px-1 py-3 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          {role === "super_admin" && (
                            <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(l); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" data-testid={`presales-lead-delete-${l.id}`} title="Delete lead">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); setEditing(l); }} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" data-testid={`presales-lead-view-${l.id}`} title="View / Edit">
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && <tr><td colSpan={tableCols.length} className="px-4 py-10 text-center text-slate-400">{loading ? "Loading..." : "No leads match."}</td></tr>}
              </tbody>
            </table>
          </div>
          {filtered.length > visibleCount && (
            <div className="flex items-center justify-center border-t border-slate-100 p-3">
              <Button variant="outline" onClick={() => setVisibleCount((c) => c + 50)} data-testid="presales-load-more">
                Load More ({filtered.length - visibleCount} remaining)
              </Button>
            </div>
          )}
      </div>
      </>
      )}
    </div>

      {activeTab === "leads" && (
        <div className="space-y-3 md:hidden" data-testid="presales-leads-mobile">
          {/* Two rows, split by what they do: the first narrows what you are looking at,
              the second acts on it. Seven controls will not share one line on a phone at
              a usable size, and this is the seam that reads. */}
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            {/* min-w-0 flex-1: an input carries an intrinsic width as its flex floor, so
                without this it refuses to shrink and pushes the date and refresh buttons
                off the right edge of a narrow phone. */}
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leads..."
              className="h-8 min-w-0 flex-1 border-0 p-0 focus-visible:ring-0"
              data-testid="presales-mobile-search"
            />
            <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="presales-mobile-date-filter" centered iconOnly />
            <Button
              onClick={load}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
              className="h-8 w-8 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
              data-testid="presales-mobile-refresh-btn"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {/* Same controls as the desk toolbar, stacked instead of inline — a phone has no
              room for a row of pills beside search and refresh, so this gets its own
              block rather than squeezing into the row above. The dropdown that used to
              sit here for branch selection is gone; the pills below replace it. */}
          {isSuperAdminMasterView && (
            <div className="space-y-2" data-testid="presales-mobile-master-controls">
              {showViewTabs && (
                <div className="flex items-center gap-1 border-b border-slate-200 pb-2" data-testid="presales-mobile-view-tabs">
                  <PreSalesViewTab active={masterView === "leads"} onClick={() => setMasterView("leads")} testid="presales-mobile-view-leads">
                    <Users className="h-4 w-4" />Leads
                  </PreSalesViewTab>
                  <PreSalesViewTab active={masterView === "analytics"} onClick={() => setMasterView("analytics")} testid="presales-mobile-view-analytics">
                    <BarChart3 className="h-4 w-4" />Analytics
                  </PreSalesViewTab>
                </div>
              )}
              {/* The desk toolbar's two dropdowns, on a line of their own: the search row
                  above has no room left for them. */}
              {branchFilterInToolbar && branches.length > 0 && (
                <div className="flex flex-wrap items-center gap-2" data-testid="presales-mobile-branch-selects">
                  <BranchScopeSelects
                    mode={modeFilter}
                    onMode={pickMode}
                    branchId={sourceFilter}
                    onBranch={setSourceFilter}
                    branches={modeBranches}
                    testid="presales-mobile-toolbar-branch"
                  />
                </div>
              )}
              {showBranchRow && (
                <div className="flex flex-wrap items-center gap-2" data-testid="presales-mobile-branch-filters">
                  <SegmentedPillGroup options={BRANCH_MODE_FILTERS} active={modeFilter} onPick={pickMode} testid="presales-mobile-branch-mode" />
                  <div className="flex flex-wrap items-center gap-1.5" data-testid="presales-mobile-branch-pills">
                    {modeBranches.map((b) => (
                      <PreSalesBranchPill
                        key={b.id}
                        active={sourceFilter === b.id}
                        onClick={() => setSourceFilter((id) => (id === b.id ? "" : b.id))}
                        testid={`presales-mobile-branch-pill-${b.id}`}
                      >
                        {branchLabel(b)}
                      </PreSalesBranchPill>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Right-aligned for Pre Sales. Manage Stages being Super Admin's alone makes
              this row one icon for them — and one control at the left edge with the rest
              of the line empty reads as something that failed to load rather than as a
              toolbar. */}
          <div className={`flex items-center gap-2 ${role === "super_admin" ? "" : "justify-end"}`}>
            {/* Super Admin's alone — the Pre Sales role can work the pipeline but not
                reshape it, and the button 403s for them anyway. */}
            {role === "super_admin" && (
              <Button
                variant="outline"
                className="h-10 w-10 shrink-0 p-0"
                onClick={onManageStages}
                title="Manage Stages"
                aria-label="Manage Stages"
                data-testid="presales-mobile-manage-stages-btn"
              >
                <Cog className="h-4 w-4" />
              </Button>
            )}
            <Button
              onClick={() => setShowCreate(true)}
              title="Create Lead"
              aria-label="Create Lead"
              variant="outline"
              className="h-10 w-10 shrink-0 p-0"
              data-testid="presales-mobile-create-lead-btn"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <PullFromSheetButton onPulled={() => { load(); setStageFilter("New Leads"); }} iconOnly />
          </div>

          {masterView === "analytics" && isSuperAdminMasterView ? (
            <PreSalesAnalyticsPanel sourceFilter={sourceFilter} groupBranchIds={modeBranchIds} role={role} />
          ) : (
          <>
          {/* Same range row the desk gets, above the stage bar it narrows. */}
          <PreSalesRangePills
            value={dateFilter}
            onChange={setDateFilter}
            testid="presales-mobile-leads-range"
            handledBy={showHandledByFilter ? handledByFilter : undefined}
            onHandledByChange={showHandledByFilter ? setHandledByFilter : undefined}
          />
          {/* A master view's cards are not stages, so the stage bar cannot carry them — its
              pills would set a filter the card logic does not recognise and quietly do
              nothing. Those boards get the same card row the desk shows; a rep's board,
              whose cards really are the live stages, keeps the bar it already had. */}
          {isMarketingHeadFunnel || isSalesMasterCards ? (
            <div className="grid grid-cols-2 gap-2" data-testid="presales-mobile-kpi-row">
              {kpiCardModels.map((c) => (
                <KpiCard
                  key={c.key}
                  label={c.label}
                  value={c.value}
                  active={stageFilter === c.key}
                  color={c.color}
                  hoverColor={c.hoverColor}
                  selectedColor={c.selectedColor}
                  onClick={() => setStageFilter(c.key)}
                  testid={`presales-mobile-kpi-${c.testid}`}
                />
              ))}
            </div>
          ) : (
            <StageTabBar
              stages={stages}
              stageFilter={stageFilter === "All" ? null : stageFilter}
              setStageFilter={(v) => setStageFilter(v === null ? "All" : v)}
              counts={stageCounts}
              totalCount={stageCounts.All}
              testid="presales-mobile-stagebar"
            />
          )}

          <div className="space-y-2">
            {visibleLeads.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
                {loading ? "Loading..." : "No leads match."}
              </p>
            ) : visibleLeads.map((l) => {
              const stg = stages.find((s) => s.name === l.stage);
              const hex = stg?.color || "#64748b";
              return (
                <div
                  key={l.id}
                  onClick={() => setEditing(l)}
                  className="rounded-xl border border-slate-200 bg-white p-3"
                  data-testid={`presales-mobile-card-${l.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarColor(l.name).bg} ${avatarColor(l.name).fg}`}>{initials(l.name)}</span>
                      <p className="min-w-0 truncate text-sm font-bold text-slate-800">{l.name || "—"}</p>
                    </div>
                    <span className="shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] font-bold" style={{ background: `${hex}14`, color: hex, border: `1px solid ${hex}33` }}>
                      {l.stage}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                      {l.stage === "RNR" && (l.rnr_attempts || 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5 font-semibold text-rose-600">
                          <PhoneOff className="h-2.5 w-2.5" />×{l.rnr_attempts}
                        </span>
                      )}
                      {l.stage === "RNR" && l.rnr_last_attempt_at && (
                        <span className="inline-flex items-center gap-0.5 font-semibold text-rose-600">
                          <Clock className="h-2.5 w-2.5" />{callTimeStamp(l.rnr_last_attempt_at)}
                        </span>
                      )}
                      {l.stage === "Follow Up" && l.next_follow_up_at && (
                        <span className="inline-flex items-center gap-0.5 font-semibold text-amber-600">
                          <Clock className="h-2.5 w-2.5" />
                          {new Date(l.next_follow_up_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}
                        </span>
                      )}
                      {(l.source_tab || l.source_type) && <span className="truncate">{l.source_tab || l.source_type}</span>}
                    </div>
                    <LeadContactIcons lead={l} />
                  </div>
                </div>
              );
            })}
          </div>

          {filtered.length > visibleCount && (
            <div className="flex items-center justify-center pt-1">
              <Button variant="outline" onClick={() => setVisibleCount((c) => c + 50)} data-testid="presales-mobile-load-more">
                Load More ({filtered.length - visibleCount} remaining)
              </Button>
            </div>
          )}
          </>
          )}

          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="fixed bottom-24 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg hover:bg-sky-700"
            data-testid="presales-mobile-create-fab"
            aria-label="Create Lead"
          >
            <Plus className="h-6 w-6" />
          </button>
        </div>
      )}

      {role === "pre_sales" && activeTab === "consultations" && (
        <ConsultationsTab leads={appointmentLeads} branches={branches} loading={loading} onOpen={setEditing} />
      )}

      {role === "pre_sales" && activeTab === "profile" && (
        <ProfileTab currentUser={currentUser} branches={branches} onLogout={onLogout} />
      )}

      {editing && (
        <LeadDetailDialog lead={editing} stages={stages} currentUser={currentUser} pinnedBranchId={branchId} canMoveStage={canMoveStage} onClose={() => setEditing(null)} onSaved={load} onMoveStage={moveToStage} />
      )}

      {showCreate && (
        // Pinned to this board's branch when it has one. A lead created on a Branch
        // Admin's Pre Sales tab with no branch would be an unbranched lead, which always
        // belongs to Pre-Sales — it would vanish from the board that created it.
        <CreateLeadModal onClose={() => setShowCreate(false)} onSaved={load} branchId={branchId} isSuperAdmin={isSuperAdminMasterView} />
      )}

      {/* Now the shared dialog, so this and Branch Admin's Delete Patient ask the same
          question and make the same call for what is one and the same record. */}
      {confirmDelete && (
        <DeleteLeadDialog
          lead={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => { setConfirmDelete(null); load(); }}
        />
      )}

      {role === "pre_sales" && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 md:hidden" data-testid="presales-bottom-nav">
          <div className="mx-auto flex max-w-lg items-stretch justify-around">
            {PRESALES_TABS.map((t) => {
              const Icon = t.icon;
              return (
                <BottomNavTab
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  icon={<Icon className="h-5 w-5" />}
                  label={t.label}
                  active={activeTab === t.key}
                  data-testid={`presales-nav-${t.key}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ============ Mobile: Consultations tab (leads booked for a consultation) ============

// Read-only milestone tracker for what happens to a lead after it's handed to a
// branch: branch_stage carries the first two ("New Appointment" is set the instant a
// branch is assigned; "Appointment Date & Time" is set once a specific date/time is
// booked, and branch_stage never advances past it). The doctor finishing the visit
// and suggesting a treatment plan is a *different* field — consultation_stage (or
// head_consultation_stage) hits "Consultation Visit" — so it's tracked separately and
// can be true at the same time branch_stage is still "Appointment Date & Time".
const CONSULT_MILESTONES = [
  { key: "new", label: "New Branch Assign", color: "#0ea5e9" },
  { key: "booked", label: "Consultation Booked", color: "#f59e0b" },
  { key: "completed", label: "Consultation Completed", color: "#22c55e" },
];

const consultMilestoneMatch = (l, key) => {
  if (key === "new") return l.branch_stage === "New Appointment";
  if (key === "booked") return l.branch_stage === "Appointment" || l.branch_stage === "Appointment Date & Time";
  if (key === "completed") return l.consultation_stage === "Consultation Visit" || l.head_consultation_stage === "Consultation Visit";
  return false;
};

const ConsultationsTab = ({ leads, branches, loading, onOpen }) => {
  const [dateFilter, setDateFilter] = useState(null);
  const [milestoneFilter, setMilestoneFilter] = useState(null);

  const milestoneCounts = useMemo(() => ({
    new: leads.filter((l) => consultMilestoneMatch(l, "new")).length,
    booked: leads.filter((l) => consultMilestoneMatch(l, "booked")).length,
    completed: leads.filter((l) => consultMilestoneMatch(l, "completed")).length,
  }), [leads]);

  // Filters by appointment_date (when the consultation is booked), not created_at —
  // same field ConsultationsBoard's own date filter uses for this stage of leads.
  const filtered = useMemo(() => {
    let rows = leads;
    if (dateFilter) {
      const from = dateFilter.from?.getTime();
      const to = dateFilter.to?.getTime();
      rows = rows.filter((l) => {
        if (!l.appointment_date) return false;
        const ts = new Date(`${l.appointment_date}T00:00:00`).getTime();
        if (!ts) return false;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      });
    }
    if (milestoneFilter) rows = rows.filter((l) => consultMilestoneMatch(l, milestoneFilter));
    return rows;
  }, [leads, dateFilter, milestoneFilter]);

  return (
    <div className="space-y-3 md:hidden" data-testid="presales-consultations-tab">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Consultations ({filtered.length})</h2>
        <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="presales-consult-date-filter" centered iconOnly />
      </div>

      <div className="grid grid-cols-3 gap-2" data-testid="presales-consult-milestones">
        {CONSULT_MILESTONES.map((m) => {
          const active = milestoneFilter === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setMilestoneFilter(active ? null : m.key)}
              className="rounded-xl p-2.5 text-center transition-all"
              style={
                active
                  ? { background: m.color, color: "#fff", boxShadow: `0 2px 8px ${m.color}40` }
                  : { background: `${m.color}14`, color: m.color, border: `1px solid ${m.color}33` }
              }
              data-testid={`presales-consult-milestone-${m.key}`}
            >
              <p className="text-lg font-bold leading-none">{milestoneCounts[m.key]}</p>
              <p className="mt-1 text-[9px] font-semibold uppercase leading-tight tracking-tight">{m.label}</p>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-sm text-slate-400">
          {loading ? "Loading..." : "No consultations booked yet."}
        </p>
      ) : (
        filtered.map((l) => {
          const { branchName, status, statusColor } = branchStatusInfo(l, branches);
          const completed = consultMilestoneMatch(l, "completed");
          return (
            <div
              key={l.id}
              onClick={() => onOpen(l)}
              className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
              data-testid={`presales-consultation-card-${l.id}`}
            >
              <div className="flex items-center gap-2">
                <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarColor(l.name).bg} ${avatarColor(l.name).fg}`}>{initials(l.name)}</span>
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{l.name}</p>
                <LeadContactIcons lead={l} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-600">{branchName || "—"}</span>
                <span className={`inline-flex items-center rounded border px-1.5 text-[10px] font-semibold ${statusColor}`}>{status}</span>
                {l.assigned_physio_name ? (
                  <span className="text-[10px] text-emerald-600">Expert: {l.assigned_physio_name}</span>
                ) : (
                  <span className="text-[10px] text-amber-600">Pending Expert</span>
                )}
                {completed && (
                  <span className="inline-flex items-center gap-0.5 rounded border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700">
                    <CheckCircle2 className="h-2.5 w-2.5" />Treatment Suggested
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};

// ============ Mobile: Profile tab (rep's own info + testimonial video management) ============

const ProfileTab = ({ currentUser, branches, onLogout }) => {
  const [videos, setVideos] = useState([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const loadVideos = useCallback(async () => {
    setLoadingVideos(true);
    try { setVideos(await listTestimonials()); }
    catch { /* keep whatever was already shown */ }
    setLoadingVideos(false);
  }, []);

  useEffect(() => { loadVideos(); }, [loadVideos]);

  const branchName = currentUser?.branch_id
    ? (branches.find((b) => b.id === currentUser.branch_id)?.branch_name || branches.find((b) => b.id === currentUser.branch_id)?.name)
    : null;
  const joinedOn = currentUser?.created_at
    ? new Date(currentUser.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : "—";

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSaving(true);
    try {
      await addTestimonial({ youtube_url: url.trim(), title: title.trim() || undefined });
      setUrl(""); setTitle("");
      toast.success("Testimonial added");
      loadVideos();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not add — check the YouTube link");
    }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    try { await deleteTestimonial(id); setVideos((v) => v.filter((x) => x.id !== id)); }
    catch { toast.error("Delete failed"); }
  };

  return (
    <div className="space-y-4 md:hidden" data-testid="presales-profile-tab">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-100 text-xl font-bold text-sky-700">
              {currentUser?.full_name?.charAt(0)?.toUpperCase() || "?"}
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-slate-800">{currentUser?.full_name}</p>
              <p className="flex items-center gap-1 text-xs text-slate-400"><Mail className="h-3 w-3" />{currentUser?.email}</p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <span className="text-xs text-slate-400">Role</span>
              <span className="text-sm font-medium text-slate-700">Pre-Sales</span>
            </div>
            {branchName && (
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-xs text-slate-400">Branch</span>
                <span className="text-sm font-medium text-slate-700">{branchName}</span>
              </div>
            )}
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs text-slate-400">Joined On</span>
              <span className="text-sm font-medium text-slate-700">{joinedOn}</span>
            </div>
          </div>
          <Button variant="outline" onClick={onLogout} className="mt-4 w-full text-rose-600 hover:bg-rose-50" data-testid="presales-profile-logout">
            <LogOut className="mr-1.5 h-4 w-4" />Logout
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Youtube className="h-4 w-4 text-rose-500" />Testimonial Videos
          </CardTitle>
          <p className="text-xs text-slate-400">Shown live on the link shared with leads over WhatsApp.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={handleAdd} className="space-y-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste YouTube video link" data-testid="presales-testimonial-url" />
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" data-testid="presales-testimonial-title" />
            <Button type="submit" disabled={saving || !url.trim()} className="w-full bg-sky-600 hover:bg-sky-700" data-testid="presales-testimonial-add">
              {saving ? "Adding..." : "Add Video"}
            </Button>
          </form>

          <div className="space-y-2 pt-1">
            {loadingVideos ? (
              <p className="text-center text-xs text-slate-400">Loading...</p>
            ) : videos.length === 0 ? (
              <p className="text-center text-xs text-slate-400">No videos added yet.</p>
            ) : (
              videos.map((v) => (
                <div key={v.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2" data-testid={`presales-testimonial-row-${v.id}`}>
                  <span className="truncate text-xs font-medium text-slate-700">{v.title || v.video_id}</span>
                  <button type="button" onClick={() => handleDelete(v.id)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" data-testid={`presales-testimonial-delete-${v.id}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

/**
 * One stage's count, and the control that filters the table to it.
 *
 * Wears Branch Admin > Fitness's summary card (ui/stat-tile with `arrow`): white, a grey
 * uppercase label with a chevron, the figure in the card's colour, and the picked card
 * ringed in it. The colour is whatever hex the stage carries, which StatTile takes inline.
 *
 * `hoverColor` and `selectedColor` are a Pre-Sales stage's own hover and picked colours
 * from CI/CD ROOTS. Each falls back to `color`, so a card without them (Total Leads, every
 * master-view card) draws the way it always has.
 */
const KpiCard = ({ label, value, color, hoverColor, selectedColor, active, onClick, testid }) => {
  const [hovered, setHovered] = useState(false);
  // Picked wins over hovered: the card under the pointer that is already the filter keeps
  // saying so.
  const ink = active ? (selectedColor || color) : hovered && hoverColor ? hoverColor : color;
  return (
    <div
      className="h-full min-w-0"
      title={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <StatTile label={label} value={value} color={ink} active={active} onClick={onClick} testid={testid} arrow />
    </div>
  );
};

// Legacy compact chip kept for callers that haven't migrated yet (unused after redesign).
const ChipTab = ({ label, active, onClick, color, testid }) => (
  <button onClick={onClick} data-testid={testid} className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition ${active ? "text-white" : "text-slate-600 bg-slate-100 hover:bg-slate-200"}`} style={active ? { background: color } : undefined}>
    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: color }} />{label}
  </button>
);

// ============ Lead Detail Dialog (Overview + Move-to-Stage + Edit) ============

/**
 * The activity line without its "Call attempt #4 — " prefix.
 *
 * The backend writes that prefix so the entry reads on its own in the Timeline tab and in
 * Transaction History, where nothing else says which call it was. In RNR Record the badge
 * beside it already says ATTEMPT 4, so the prefix printed the number twice on one row.
 *
 * Stripped here rather than dropped at the source, because those other screens still need
 * it. Anything that doesn't match the pattern is passed through untouched — an activity
 * line written some other way should still be readable, not silently blanked.
 */
const rnrDetail = (details) => {
  const text = (details || "").trim();
  const stripped = text.replace(/^call attempt\s*#?\d+\s*[—–-]\s*/i, "");
  if (!stripped) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
};

/** Whether a lead actually carries an answer. Explicit rather than falsiness, because 0 is
 *  one: "months_of_pain: 0" is somebody who started hurting this month. */
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/** "2026-08-05" -> "Wednesday, August 5", as Branch Admin's Lead Details prints a day. A
 *  value that is not a plain calendar day — a sheet can write anything here — is shown as
 *  it was written rather than as "Invalid Date". */
const weekdayLabel = (d) => {
  if (!hasValue(d)) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d))
    ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
    : String(d);
};

// pinnedBranchId: set when the board is a single branch's, which is how a Super Admin
// drilled into a branch gets a branch for the appointment flow — they have none of their
// own, and without it every appointment asks them to pick one they already chose.
// onDeleted: opt-in Delete beside Edit, through the shared DeleteLeadDialog. Only the
// Business Development board's Dashboard passes it; called with the id once it is gone.
export const LeadDetailDialog = ({ lead, stages, currentUser, pinnedBranchId = null, canMoveStage = true, onClose, onSaved, onMoveStage, onDeleted = null }) => {
  const [tab, setTab] = useState("overview");
  const [showEdit, setShowEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [currentLead, setCurrentLead] = useState(lead);
  const [followUpDraft, setFollowUpDraft] = useState(null); // { date, time, remarks } | null
  const [rescheduleDraft, setRescheduleDraft] = useState(null); // { followupId, date, time, reason } | null
  const [appointmentDraft, setAppointmentDraft] = useState(null); // { department, appointment_date, appointment_time, remarks } | null
  const [appointmentResult, setAppointmentResult] = useState(null); // summary shown after a successful schedule
  const [branches, setBranches] = useState([]);
  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);

  useEffect(() => {
    getBranches().then(setBranches).catch(() => {});
  }, []);

  // Both Timeline and RNR Record read the same activity trail — RNR Record is that trail
  // filtered to the call attempts, not a second source. One fetch serves both, so the two
  // tabs can never show a different number of calls for the same lead.
  const leadId = currentLead?.id;
  const loadActivity = useCallback(() => {
    if (!leadId) return;
    setActivityLoading(true);
    leadActivity(leadId).then(setActivity).catch(() => setActivity([])).finally(() => setActivityLoading(false));
  }, [leadId]);

  useEffect(() => {
    if (tab === "history" || tab === "rnr") loadActivity();
  }, [tab, loadActivity]);

  // "rnr_attempt" is the action v3_leads writes on every +1 No Answer. Nothing else in
  // the trail records a call, so this is the whole of what the OS knows about ringing
  // this person.
  const rnrRows = activity.filter((a) => a.action === "rnr_attempt");

  useEffect(() => { setCurrentLead(lead); }, [lead]);

  const refreshAndKeep = () => { onSaved && onSaved(); };

  // Logged from the RNR Status card on Overview and from the RNR Record tab alike. The
  // trail is read again when it is on screen, so the attempt shows in the list it was
  // logged from.
  const logRnrAttempt = async () => {
    const next = (currentLead.rnr_attempts || 0) + 1;
    if (!window.confirm(`Log a No Answer for ${currentLead.name || "this client"}?\n\nThis records attempt #${next}.`)) return;
    try {
      const updated = await rnrAttempt(currentLead.id);
      setCurrentLead(updated);
      toast.success(`Attempt logged (#${updated.rnr_attempts})`);
      onSaved && onSaved();
      if (tab === "rnr" || tab === "history") loadActivity();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  // The follow-up form, opened on tomorrow at ten. One form, reached from the Follow Up
  // pill, the Follow-Up card's Schedule and the Follow-Up tab.
  const startFollowUp = () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    setFollowUpDraft({ date: tomorrow.toISOString().slice(0, 10), time: "10:00", remarks: "" });
  };

  // A stage pill pressed. Follow Up and Appointment open their forms instead of moving the
  // lead outright — each needs a date first. Every other stage, Lost included, moves at once.
  const moveTo = async (s) => {
    if (s.name === "Follow Up") { startFollowUp(); return; }
    if (s.name === "Appointment") {
      const tmrw = new Date(Date.now() + 24 * 60 * 60 * 1000);
      setAppointmentDraft({ department: "physio", appointment_date: tmrw.toISOString().slice(0, 10), appointment_time: "10:00", remarks: "" });
      return;
    }
    await onMoveStage(currentLead.id, s.name);
    setCurrentLead({ ...currentLead, stage: s.name });
  };

  // Overview's cards, on the terms Branch Admin's lead popup draws them. The RNR card stays
  // on a lead rung without an answer even after it has moved on — the attempts are why it
  // sits where it does — but not on Appointment, where the calls are behind it.
  const rnrCount = currentLead.rnr_attempts || 0;
  const atRnrStage = currentLead.stage === "RNR";
  const atAppointment = currentLead.stage === "Appointment";
  const showRnrCard = !atAppointment && (atRnrStage || rnrCount > 0);
  const followUps = currentLead.follow_ups || [];
  // The follow-up the lead is actually on: newest first, skipping the rescheduled ones —
  // the same rule the Follow-Up tab draws with.
  const activeFollowUp = followUps.slice().reverse().find((f) => f.status !== "rescheduled") || null;
  const showFollowUpCard = !atAppointment && (followUps.length > 0 || currentLead.stage === "Follow Up");
  // Where the lead can be sent: every stage but New Leads, which is where leads arrive and
  // never where one is moved to. The stage the lead is on stays, drawn as picked.
  const moveStages = stages.filter((s) => s.name !== "New Leads");
  const avatarFirstChar = (currentLead.name?.trim()?.charAt(0) || "?").toUpperCase();

  // Who the patient is, read back off the record, on a tab of its own. Empty fields are
  // dropped rather than drawn as dashes — a walk-in carries three of these and a sheet
  // import fifteen. Added is last and always there, so the card is never empty.
  const source = currentLead.source_tab || currentLead.source_type;
  const months = currentLead.months_of_pain;
  const leadDetailRows = [
    ["Source", source ? sourceLabel(source) : ""],
    ["Department", DEPARTMENT_OPTIONS.find((d) => d.value === currentLead.department)?.label || currentLead.department],
    ["Vertical", currentLead.vertical ? humanWords(currentLead.vertical) : ""],
    ["Alternative Phone", displayPhone(currentLead.alternative_phone)],
    ["Age", currentLead.age],
    ["Gender", currentLead.gender],
    ["Occupation", currentLead.occupation],
    ["Condition", currentLead.condition],
    ["Months of Pain", hasValue(months) ? `${months} ${Number(months) === 1 ? "month" : "months"}` : ""],
    ["Expected Consultation", weekdayLabel(currentLead.expected_consultation_date)],
    ["Location", currentLead.location],
    ["Address", currentLead.address],
    ["City", currentLead.city],
    ["State", currentLead.state],
    ["Assigned To", currentLead.assigned_user_name],
    ["Added", dateStampFull(currentLead.created_at)],
  ].filter(([, value]) => hasValue(value));

  // Branch Admin's five tabs, in its order and colours. History is Timeline and RNR History
  // is RNR Record there; the keys stay as they were.
  const TABS = [
    { key: "overview", label: "Overview", color: "bg-sky-500" },
    { key: "follow-up", label: "Follow-Up", color: "bg-amber-500" },
    { key: "history", label: "Timeline", color: "bg-emerald-500" },
    { key: "rnr", label: "RNR Record", color: "bg-rose-500" },
    { key: "lead-details", label: "Lead Details", color: "bg-indigo-500" },
  ];

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" data-testid="presales-detail-dialog">
      {!showEdit && (
      // Branch Admin's lead popup (Branch Leads), piece for piece, with 4px corners: a white
      // header carrying the ID and stage chips, square pill tabs, white cards, and the stage
      // pills as the last card on Overview rather than a footer under every tab. Never
      // taller than the screen, and only the body scrolls, so the header and tabs stay put.
      <div className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl ring-1 ring-slate-200 sm:max-h-[530px] sm:max-w-[575px]" data-testid="presales-detail-card">
        {/* One row: avatar, name, ID and stage chip, the buttons on the same centre line.
            On a phone, two: name and buttons, then the chips under both — the wrappers are
            display:contents there so all of it lays out on one grid. No avatar on a phone:
            the initial only repeats the name beside it. */}
        <div className="relative shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-5 sm:py-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 sm:flex sm:justify-between sm:gap-3">
            <div className="contents sm:flex sm:min-w-0 sm:items-center sm:gap-3">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-bold text-slate-600 ring-1 ring-slate-200 sm:inline-flex sm:h-11 sm:w-11">{avatarFirstChar}</span>
              <div className="contents sm:flex sm:min-w-0 sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-1">
                <p className="col-start-1 row-start-1 min-w-0 text-base font-semibold leading-tight text-slate-900" data-testid="presales-detail-name">{currentLead.name}</p>
                <div className="col-span-2 col-start-1 row-start-2 flex flex-wrap items-center gap-1.5">
                  {currentLead.patient_number && (
                    <span className="rounded-[5px] bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600 sm:px-2" data-testid="presales-detail-patient-number">{currentLead.patient_number}</span>
                  )}
                  <span className="rounded-[5px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700 sm:px-2.5" data-testid="presales-detail-stage">
                    {currentLead.stage || "No Stage"}
                  </span>
                </div>
              </div>
            </div>
            <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-1.5">
              {currentLead.source_type === "manual" && (
                <button
                  type="button"
                  onClick={() => setShowEdit(true)}
                  title="Edit"
                  aria-label="Edit"
                  className="inline-flex items-center rounded-[5px] bg-white p-2 text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
                  data-testid="presales-detail-edit-btn"
                >
                  <Pencil className="h-5 w-5" />
                </button>
              )}
              {onDeleted && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  title="Delete"
                  aria-label="Delete"
                  className="inline-flex items-center rounded-[5px] bg-white p-2 text-rose-600 transition hover:bg-rose-50 hover:text-rose-700"
                  data-testid="presales-detail-delete-btn"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
              )}
              <button type="button" onClick={onClose} title="Close" aria-label="Close" className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" data-testid="presales-detail-close">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Pill tabs, centred. On a phone each wrapped row stretches its pills to the full
            width, so the rows end on the same edge as the cards below. */}
        <div className="flex shrink-0 flex-wrap justify-center gap-1.5 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 sm:px-5" data-testid="presales-detail-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-auto whitespace-nowrap rounded-[3px] px-3.5 py-1 text-center text-xs font-semibold transition-all sm:flex-none ${tab === t.key ? `${t.color} text-white shadow-sm` : "bg-white text-slate-600 hover:bg-slate-100"}`}
              data-testid={`presales-detail-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* min-h-0 as well as flex-1: without it a flex child refuses to shrink past its
            content, and the scroll would move to the page instead of staying in here. */}
        <div className={`min-h-0 flex-1 overflow-y-auto bg-slate-50/30 ${tab === "overview" ? "p-1.5" : "p-4 sm:p-5"}`} data-testid="presales-detail-content">
          {tab === "overview" && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-[3px] border border-sky-100 bg-white shadow-sm" data-testid="presales-detail-contact">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-100 text-sky-600"><Phone className="h-4 w-4" /></span>
                  <p className="text-xs font-bold uppercase tracking-wider text-sky-700">Contact</p>
                </div>
                <div className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="shrink-0 text-xs font-medium text-slate-500">Phone</span>
                    <span className="min-w-0 truncate font-medium text-slate-800">{displayPhone(currentLead.phone) || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="shrink-0 text-xs font-medium text-slate-500">Email</span>
                    <span className="min-w-0 truncate font-medium text-slate-800" title={currentLead.email || undefined}>{currentLead.email || "—"}</span>
                  </div>
                </div>
              </div>

              {/* On a lead parked at RNR, how many times somebody has rung is what the popup
                  is opened to find out, so it sits above the pills. +1 No Answer only while
                  the lead is actually at RNR; on one that has moved on, the card is a record. */}
              {showRnrCard && (
                <div className="overflow-hidden rounded-[3px] border border-rose-100 bg-white shadow-sm" data-testid="presales-detail-rnr-tracker">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-700">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-rose-600"><PhoneOff className="h-4 w-4" /></span>
                      RNR Status
                    </p>
                    {rnrCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setTab("rnr")}
                        className="-mr-2 shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50 sm:mr-0"
                        data-testid="presales-detail-rnr-open"
                      >
                        Record
                      </button>
                    )}
                  </div>
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">Client Not Answered</p>
                        <p className="text-[11px] text-slate-500">
                          Attempts so far: <span className="font-bold text-rose-600">{rnrCount}</span>
                        </p>
                        {currentLead.rnr_last_attempt_at && (
                          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500" data-testid="presales-detail-rnr-lastcall">
                            <Clock className="h-3 w-3" />
                            Last call
                            <span className="font-bold text-slate-700">{callTimeStamp(currentLead.rnr_last_attempt_at)}</span>
                            <span className="text-slate-400">· {callDateStamp(currentLead.rnr_last_attempt_at)}</span>
                          </p>
                        )}
                      </div>
                      {atRnrStage && (
                        <Button
                          size="sm"
                          onClick={logRnrAttempt}
                          className="h-8 w-full shrink-0 bg-rose-600 text-white hover:bg-rose-700 sm:w-auto"
                          data-testid="presales-detail-rnr-attempt"
                        >
                          <PhoneOff className="mr-1 h-3.5 w-3.5" /> +1 No Answer
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* The next call, on a lead at Follow Up — the one line of the Follow-Up tab
                  worth reading without changing tabs, with a link there for the rest. */}
              {showFollowUpCard && (
                <div className="overflow-hidden rounded-[3px] border border-amber-100 bg-white shadow-sm" data-testid="presales-detail-followup-preview">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-700">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700"><Bell className="h-4 w-4" /></span>
                      Follow-Up
                    </p>
                    {(activeFollowUp || canMoveStage) && (
                      <button
                        type="button"
                        onClick={() => (activeFollowUp ? setTab("follow-up") : startFollowUp())}
                        className="-mr-2 shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50 sm:mr-0"
                        data-testid="presales-detail-followup-preview-open"
                      >
                        {activeFollowUp ? "Manage" : "Schedule"}
                      </button>
                    )}
                  </div>
                  {activeFollowUp ? (() => {
                    const dt = new Date(`${activeFollowUp.date}T${activeFollowUp.time}:00`);
                    const isUpcoming = dt.getTime() > Date.now();
                    // Everything before the one that stands, counted rather than listed:
                    // the tab is where a history belongs.
                    const earlier = followUps.length - 1;
                    return (
                      <div className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800" data-testid="presales-detail-followup-preview-when">
                            {dt.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · {activeFollowUp.time}
                          </p>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${isUpcoming ? "bg-emerald-500" : "bg-rose-500"}`}>
                            {isUpcoming ? "UPCOMING" : "OVERDUE"}
                          </span>
                        </div>
                        {activeFollowUp.remarks && (
                          <div className="rounded-md bg-slate-50 px-2.5 py-1.5 text-sm text-slate-700 ring-1 ring-slate-100">{activeFollowUp.remarks}</div>
                        )}
                        <p className="text-[11px] text-slate-400">
                          Set by {activeFollowUp.created_by || "—"}
                          {earlier > 0 && ` · ${earlier} earlier ${earlier === 1 ? "follow-up" : "follow-ups"}`}
                        </p>
                      </div>
                    );
                  })() : (
                    <p className="px-4 py-3 text-sm text-slate-400">No follow-up scheduled yet.</p>
                  )}
                </div>
              )}

              {currentLead.notes && (
                <div className="overflow-hidden rounded-[3px] border border-amber-100 bg-white shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700"><FileText className="h-4 w-4" /></span>
                    <p className="text-xs font-bold uppercase tracking-wider text-amber-700">Notes</p>
                  </div>
                  <p className="px-4 py-3 text-sm leading-relaxed text-slate-700">{currentLead.notes}</p>
                </div>
              )}

              {/* The stage pills, last, each in its stage's own colour and the lead's own
                  stage filled in. Three equal columns on a phone so they sit in even rows;
                  from sm up a centred, wrapping row of natural widths. Marketing Master View
                  reads the funnel rather than working it, so it has none. */}
              {canMoveStage && moveStages.length > 0 && (
                <div className="overflow-hidden rounded-[3px] border border-violet-100 bg-white shadow-sm" data-testid="presales-detail-pipeline">
                  <div className="grid grid-cols-3 gap-1.5 px-4 py-3 sm:flex sm:flex-wrap sm:justify-center sm:gap-1.5 sm:px-[5px]" data-testid="presales-detail-move-stages">
                    {moveStages.map((s) => {
                      const active = currentLead.stage === s.name;
                      const tint = stageInk(s);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => moveTo(s)}
                          disabled={active}
                          className="rounded-[3px] px-1 py-2.5 text-[11px] font-semibold leading-tight transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-90 sm:whitespace-nowrap sm:px-3 sm:text-xs"
                          style={active ? { background: tint, color: "#ffffff" } : { background: `${tint}14`, color: tint, border: `1px solid ${tint}33` }}
                          data-testid={`presales-detail-move-${s.name}`}
                        >
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "follow-up" && (
            <div className="space-y-4" data-testid="presales-detail-followups">
              {/* On top, where Branch Admin's tab keeps its form — the same form the Follow Up
                  pill opens, so a follow-up can be set without going back to Overview. */}
              {canMoveStage && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-amber-200 bg-amber-50/40 px-4 py-3" data-testid="presales-followup-schedule-bar">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700"><Bell className="h-3.5 w-3.5" /> Schedule Follow-Up</p>
                  <Button size="sm" onClick={startFollowUp} className="h-8 shrink-0 bg-amber-600 px-4 text-white hover:bg-amber-700" data-testid="presales-followup-schedule-open">
                    Schedule
                  </Button>
                </div>
              )}
              {followUps.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400" data-testid="presales-followups-empty">No follow-ups scheduled yet</p>
              ) : (
                <div className="space-y-2">
                  {followUps.slice().reverse().map((f, idx) => {
                    const dt = new Date(`${f.date}T${f.time}:00`);
                    const isUpcoming = dt.getTime() > Date.now();
                    const isRescheduled = f.status === "rescheduled";
                    const isActive = idx === 0 && !isRescheduled;
                    return (
                      <div
                        key={f.id}
                        className={`flex items-start gap-3 rounded-[3px] border p-3 ${
                          isRescheduled ? "border-slate-200 bg-slate-50/70 opacity-70" : isUpcoming ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"
                        }`}
                        data-testid={`presales-followup-tab-row-${f.id}`}
                      >
                        <span className={`mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${isRescheduled ? "bg-slate-100 text-slate-400" : isUpcoming ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                          <Bell className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className={`text-sm font-semibold ${isRescheduled ? "text-slate-500 line-through decoration-slate-300" : "text-slate-800"}`}>
                              {dt.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · {f.time}
                            </p>
                            {isRescheduled && <span className="rounded-full bg-slate-300 px-2 py-0.5 text-[10px] font-bold text-white">RESCHEDULED</span>}
                            {!isRescheduled && isUpcoming && <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">UPCOMING</span>}
                          </div>
                          {f.remarks && (
                            <div className="mt-1.5 rounded-md bg-white px-2.5 py-1.5 text-sm text-slate-700 ring-1 ring-slate-100">
                              {f.remarks}
                            </div>
                          )}
                          {isRescheduled && f.reschedule_reason && (
                            <div className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 ring-1 ring-amber-100">
                              <span className="font-semibold">Reschedule reason:</span> {f.reschedule_reason}
                            </div>
                          )}
                          <p className="mt-1.5 text-[11px] text-slate-400">Set by {f.created_by || "—"} · {new Date(f.created_at).toLocaleString()}</p>
                        </div>
                        {isActive && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 flex-shrink-0 border-amber-200 text-amber-700 hover:bg-amber-50"
                            onClick={() => setRescheduleDraft({ followupId: f.id, date: f.date, time: f.time, reason: "" })}
                            data-testid={`presales-followup-reschedule-${f.id}`}
                          >
                            Reschedule
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "history" && (
            <div className="space-y-3" data-testid="presales-detail-history">
              {activityLoading && <p className="py-8 text-center text-sm text-slate-400">Loading timeline...</p>}
              {!activityLoading && activity.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-400" data-testid="presales-history-empty">No timeline events yet</p>
              )}
              {!activityLoading && activity.length > 0 && (
                <ol className="ml-3 space-y-4 border-l-2 border-slate-200 py-1 pl-6">
                  {activity.map((a) => (
                    <li key={a.id} className="relative" data-testid={`presales-history-row-${a.id}`}>
                      <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-sky-500" />
                      <div className="rounded-[3px] border border-slate-100 bg-slate-50 p-3">
                        <p className="text-sm text-slate-700">{a.details || humanWords(a.action || "event")}</p>
                        <p className="mt-1 text-[10px] text-slate-400">
                          {a.created_by || "system"}{a.created_by_role ? ` · ${a.created_by_role}` : ""} · {new Date(a.created_at).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* Every attempt, rather than the counter and the latest one the Overview card
              carries: whether this lead is worth ringing again needs the dates and names
              beside them, because "8 attempts" says nothing about whether they were eight
              days apart or eight in one afternoon. */}
          {tab === "rnr" && (
            <div className="space-y-3" data-testid="presales-detail-rnr">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-rose-100 bg-white px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-600"><PhoneOff className="h-4 w-4" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-rose-700">Call Attempts</p>
                    {/* Off the lead's own counter rather than the length of the list below,
                        so a trail that predates the counter still reports right. */}
                    <p className="text-[11px] text-slate-500" data-testid="presales-rnr-count">
                      {rnrCount === 0 ? "None logged yet" : `${rnrCount} logged`}
                      {currentLead.rnr_last_attempt_at && ` · last ${callTimeStamp(currentLead.rnr_last_attempt_at)}, ${callDateStamp(currentLead.rnr_last_attempt_at)}`}
                    </p>
                  </div>
                </div>
                {atRnrStage && (
                  <Button
                    size="sm"
                    onClick={logRnrAttempt}
                    className="h-8 bg-rose-600 text-white hover:bg-rose-700"
                    data-testid="presales-detail-rnr-record-attempt"
                  >
                    <PhoneOff className="mr-1 h-3.5 w-3.5" /> +1 No Answer
                  </Button>
                )}
              </div>

              {activityLoading && <p className="py-8 text-center text-sm text-slate-400">Loading call history...</p>}

              {!activityLoading && rnrRows.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-400" data-testid="presales-rnr-empty">
                  {rnrCount > 0
                    // The counter can be ahead of the trail for leads that were rung before
                    // the activity log recorded it. Saying so beats showing an empty list
                    // under a figure that insists calls were made.
                    ? "No individual calls are logged for this lead — only the running total above."
                    : "No call attempts logged yet."}
                </p>
              )}

              {!activityLoading && rnrRows.length > 0 && (
                <ol className="ml-3 space-y-4 border-l-2 border-rose-100 py-1 pl-6">
                  {rnrRows.map((a, i) => (
                    <li key={a.id} className="relative" data-testid={`presales-rnr-row-${a.id}`}>
                      <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-rose-500" />
                      <div className="rounded-[3px] border border-rose-100 bg-rose-50/50 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Newest first, so attempt numbering counts down the page. */}
                          <span className="rounded-[3px] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700 ring-1 ring-rose-100">
                            Attempt {rnrRows.length - i}
                          </span>
                          {/* callTimeStamp, not toLocaleString: it reads the clock in IST and
                              names the band — "01:02 pm Afternoon" — the same way the card on
                              Overview reports the last call. */}
                          <span className="text-[11px] font-medium text-slate-600">{callTimeStamp(a.created_at)}</span>
                          <span className="text-[11px] text-slate-400">· {callDateStamp(a.created_at)}</span>
                        </div>
                        {a.details && <p className="mt-1 text-sm text-slate-700">{rnrDetail(a.details)}</p>}
                        <p className="mt-1 text-[10px] text-slate-400">
                          by {a.created_by || "system"}{a.created_by_role ? ` · ${a.created_by_role}` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === "lead-details" && (
            <div className="space-y-3" data-testid="presales-detail-lead-details">
              <div className="overflow-hidden rounded-[3px] border border-indigo-100 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700"><IdCard className="h-4 w-4" /></span>
                  <p className="text-xs font-bold uppercase tracking-wider text-indigo-700">Lead Details</p>
                </div>
                <div className="space-y-2 px-4 py-3">
                  {leadDetailRows.map(([label, value]) => (
                    <div key={label} className="flex items-start justify-between gap-3 text-sm" data-testid={`presales-detail-row-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
                      <span className="shrink-0 text-xs font-medium text-slate-500">{label}</span>
                      <span className="break-words text-right font-medium text-slate-800">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {showEdit && (
        <LeadEditModal lead={currentLead} onClose={() => setShowEdit(false)} onSaved={() => { refreshAndKeep(); setShowEdit(false); }} />
      )}

      {confirmDelete && onDeleted && (
        <DeleteLeadDialog
          lead={currentLead}
          onClose={() => setConfirmDelete(false)}
          onDeleted={(id) => { setConfirmDelete(false); onDeleted(id); }}
        />
      )}

      {followUpDraft && !showEdit && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4" data-testid="presales-followup-modal">
          {/* Scrolls itself rather than overflowing the viewport — date, time, a textarea
              and the footer come to more than a phone in landscape has to give. */}
          <div className="max-h-[95vh] w-full max-w-md overflow-y-auto rounded-[4px] bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                <p className="text-base font-semibold">Schedule Follow-Up</p>
              </div>
              <button onClick={() => setFollowUpDraft(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="presales-followup-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Date *</label>
                <MilkDateInput
                  centered
                  title="Follow-Up Date"
                  value={followUpDraft.date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setFollowUpDraft({ ...followUpDraft, date: e.target.value })}
                  data-testid="presales-followup-date"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Time *</label>
                <MilkTimeInput
                  centered
                  title="Follow-Up Time"
                  value={followUpDraft.time}
                  onChange={(e) => setFollowUpDraft({ ...followUpDraft, time: e.target.value })}
                  data-testid="presales-followup-time"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Remarks</label>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                  placeholder="What to discuss in the next call..."
                  value={followUpDraft.remarks}
                  onChange={(e) => setFollowUpDraft({ ...followUpDraft, remarks: e.target.value })}
                  data-testid="presales-followup-remarks"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
              <Button variant="outline" onClick={() => setFollowUpDraft(null)} data-testid="presales-followup-cancel">Cancel</Button>
              <Button
                className="bg-amber-500 text-white hover:bg-amber-600"
                onClick={async () => {
                  if (!followUpDraft.date || !followUpDraft.time) {
                    toast.error("Date and time are required");
                    return;
                  }
                  try {
                    const updated = await scheduleFollowUp(currentLead.id, followUpDraft);
                    setCurrentLead(updated);
                    setFollowUpDraft(null);
                    toast.success(`Follow-up scheduled for ${followUpDraft.date} at ${followUpDraft.time}`);
                    onSaved && onSaved();
                  } catch (e) { toast.error(e?.response?.data?.detail || "Failed to schedule"); }
                }}
                data-testid="presales-followup-save"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" /> Save & Move to Follow Up
              </Button>
            </div>
          </div>
        </div>
      )}

      {rescheduleDraft && !showEdit && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4" data-testid="presales-reschedule-modal">
          <div className="max-h-[95vh] w-full max-w-md overflow-y-auto rounded-[4px] bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                <p className="text-base font-semibold">Reschedule Follow-Up</p>
              </div>
              <button onClick={() => setRescheduleDraft(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="presales-reschedule-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">New Date *</label>
                <MilkDateInput
                  centered
                  title="New Follow-Up Date"
                  value={rescheduleDraft.date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, date: e.target.value })}
                  data-testid="presales-reschedule-date"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">New Time *</label>
                <MilkTimeInput
                  centered
                  title="New Follow-Up Time"
                  value={rescheduleDraft.time}
                  onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, time: e.target.value })}
                  data-testid="presales-reschedule-time"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Reason for Reschedule *</label>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                  placeholder="Why is this being rescheduled..."
                  value={rescheduleDraft.reason}
                  onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, reason: e.target.value })}
                  data-testid="presales-reschedule-reason"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
              <Button variant="outline" onClick={() => setRescheduleDraft(null)} data-testid="presales-reschedule-cancel">Cancel</Button>
              <Button
                className="bg-amber-500 text-white hover:bg-amber-600"
                onClick={async () => {
                  if (!rescheduleDraft.date || !rescheduleDraft.time || !rescheduleDraft.reason.trim()) {
                    toast.error("Date, time and reason are required");
                    return;
                  }
                  try {
                    const updated = await rescheduleFollowUp(currentLead.id, rescheduleDraft.followupId, {
                      date: rescheduleDraft.date, time: rescheduleDraft.time, reason: rescheduleDraft.reason,
                    });
                    setCurrentLead(updated);
                    setRescheduleDraft(null);
                    toast.success(`Follow-up rescheduled to ${rescheduleDraft.date} at ${rescheduleDraft.time}`);
                    onSaved && onSaved();
                  } catch (e) { toast.error(e?.response?.data?.detail || "Failed to reschedule"); }
                }}
                data-testid="presales-reschedule-save"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" /> Reschedule
              </Button>
            </div>
          </div>
        </div>
      )}

      {appointmentDraft && !showEdit && (() => {
        const myBranch = pinnedBranchId || currentUser?.branch_id;
        const myBranchName = branches.find((b) => b.id === myBranch)?.branch_name || branches.find((b) => b.id === myBranch)?.name || "";
        const resolvedBranchName = () => myBranchName || branches.find((b) => b.id === appointmentDraft.branch_id)?.branch_name || branches.find((b) => b.id === appointmentDraft.branch_id)?.name || "your branch";
        const closeAll = () => { setAppointmentDraft(null); setAppointmentResult(null); };
        return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4" data-testid="presales-appointment-modal">
          <div className="max-h-[95vh] w-full max-w-md overflow-y-auto rounded-[4px] bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-gradient-to-r from-emerald-500 to-teal-600 px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5" />
                <p className="text-base font-semibold">{appointmentResult ? "Moved to Branch Admin" : "Schedule Appointment"}</p>
              </div>
              <button onClick={closeAll} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="presales-appointment-close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {appointmentResult ? (
              <>
                <div className="space-y-3 p-5">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-700">Sent To Branch Admin</p>
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex justify-between"><dt className="text-slate-500">Service</dt><dd className="font-semibold text-slate-800">{appointmentResult.department === "physio" ? "Physiotherapy" : "Fitness"}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Branch</dt><dd className="font-semibold text-slate-800">{appointmentResult.branchName}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Date</dt><dd className="font-semibold text-slate-800">{appointmentResult.appointment_date}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Time</dt><dd className="font-semibold text-slate-800">{appointmentResult.appointment_time}</dd></div>
                    </dl>
                    <p className="mt-2 border-t border-emerald-200 pt-2 text-[11px] text-emerald-700">
                      The branch admin will see this in New Appointment and assign a Fitsiomax Expert for this date &amp; time.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Lead Summary</p>
                    <p className="text-sm font-semibold text-slate-800">{currentLead.name || "Unknown"}</p>
                    <p className="text-xs text-slate-500">{displayPhone(currentLead.phone)}</p>
                  </div>
                  {appointmentResult.remarks && (
                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Remarks</p>
                      <p className="text-sm text-slate-700">{appointmentResult.remarks}</p>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
                  <Button className="bg-emerald-500 text-white hover:bg-emerald-600" onClick={closeAll} data-testid="presales-appointment-done">
                    <CheckCircle2 className="mr-1 h-4 w-4" /> Done
                  </Button>
                </div>
              </>
            ) : (
            <>
            <div className="space-y-4 p-5">
              <div className="space-y-3">
                {myBranchName ? (
                  <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                    <Building2 className="h-3.5 w-3.5" /> {myBranchName}
                  </div>
                ) : (
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">Select Branch *</label>
                    <select
                      value={appointmentDraft.branch_id || ""}
                      onChange={(e) => setAppointmentDraft({ ...appointmentDraft, branch_id: e.target.value })}
                      className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      data-testid="presales-appointment-branch"
                    >
                      <option value="">-- choose a branch --</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.branch_name || b.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">Date *</label>
                    <MilkDateInput
                      centered
                      title="Appointment Date"
                      accent="teal"
                      value={appointmentDraft.appointment_date}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setAppointmentDraft({ ...appointmentDraft, appointment_date: e.target.value })}
                      data-testid="presales-appointment-date"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">Time *</label>
                    <MilkTimeInput
                      centered
                      title="Appointment Time"
                      accent="teal"
                      value={appointmentDraft.appointment_time}
                      onChange={(e) => setAppointmentDraft({ ...appointmentDraft, appointment_time: e.target.value })}
                      data-testid="presales-appointment-time"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">Remarks</label>
                  <textarea
                    rows={3}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    placeholder="e.g. Lower back pain, 3 months"
                    value={appointmentDraft.remarks}
                    onChange={(e) => setAppointmentDraft({ ...appointmentDraft, remarks: e.target.value })}
                    data-testid="presales-appointment-remarks"
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
              <Button variant="outline" onClick={closeAll} data-testid="presales-appointment-cancel">Cancel</Button>
              <Button
                className="bg-emerald-500 text-white hover:bg-emerald-600"
                onClick={async () => {
                  if (!myBranchName && !appointmentDraft.branch_id) {
                    toast.error("Please select a branch");
                    return;
                  }
                  if (!appointmentDraft.appointment_date || !appointmentDraft.appointment_time) {
                    toast.error("Pick a date and time");
                    return;
                  }
                  try {
                    const payload = {
                      department: appointmentDraft.department,
                      mode: "offline",
                      appointment_date: appointmentDraft.appointment_date,
                      appointment_time: appointmentDraft.appointment_time,
                      remarks: appointmentDraft.remarks,
                    };
                    // Sent explicitly when the board is pinned to a branch. Leaving it out
                    // lets the API infer the branch from whoever is logged in, which is
                    // right for a Branch Admin and wrong for a Super Admin drilled into a
                    // branch — they have none, and the appointment would land nowhere.
                    if (pinnedBranchId) payload.branch_id = pinnedBranchId;
                    else if (!myBranchName) payload.branch_id = appointmentDraft.branch_id;
                    const updated = await scheduleAppointment(currentLead.id, payload);
                    setCurrentLead(updated);
                    setAppointmentResult({
                      department: appointmentDraft.department,
                      branchName: resolvedBranchName(),
                      appointment_date: appointmentDraft.appointment_date,
                      appointment_time: appointmentDraft.appointment_time,
                      remarks: appointmentDraft.remarks,
                    });
                    onSaved && onSaved();
                  } catch (e) { toast.error(e?.response?.data?.detail || "Failed to schedule appointment"); }
                }}
                data-testid="presales-appointment-save"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" /> Move to Branch Admin
              </Button>
            </div>
            </>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
};

const Section = ({ title, children }) => (
  <div className="rounded-lg border border-slate-200 p-3">
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
    <div className="space-y-1">{children}</div>
  </div>
);

const Row = ({ k, v }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="text-slate-500">{k}</span>
    <span className="text-slate-800">{String(v)}</span>
  </div>
);

export default PreSalesCRM;
