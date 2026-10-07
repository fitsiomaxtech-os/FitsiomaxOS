import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Building2, CalendarDays, Check, ChevronDown, Clock, Loader2, Phone, RefreshCw, Star, Stethoscope, UserCheck, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { HeadPhysioBoard } from "@/components/HeadPhysioBoard";
import { WeekStrip, todayIso } from "@/components/WeekStrip";
import { RescheduledTag } from "@/components/ui/lead-marks";
import {
  getConsultantSlots, getDoctors, getMyConsultBranches, hpResolvedConsultant, listBranchConsultants,
  reassignConsultant, setMyConsultBranch,
} from "@/lib/api";
import { to12h } from "@/lib/time";

const ALL = "all";

/**
 * Which branch's consultations are on screen.
 *
 * Checkbox rows rather than a tick on the right, because that is how every other branch
 * picker in this OS now reads — but one answer at a time, because the board underneath
 * takes a single branch. A list where two could be ticked would promise a merged view the
 * board cannot produce: it collapses whatever it is given to the first entry.
 *
 * "All Branches" is a real answer here rather than the absence of one. A consultant covers
 * the whole organisation, so it is the normal case and sits at the top.
 */
const BranchPicker = ({ value, branches, onPick }) => {
  const [open, setOpen] = useState(false);
  const current = value === ALL ? null : branches.find((b) => b.id === value);
  const label = value === ALL ? "All Branches" : (current?.branch_name || "Select branch");

  const options = [
    { value: ALL, label: "All Branches", hint: "Every branch you consult for" },
    ...branches.map((b) => ({ value: b.id, label: b.branch_name })),
  ];

  return (
    <>
      <Button
        variant="outline"
        className="h-10 w-40 shrink-0 justify-between gap-2 px-3"
        onClick={() => setOpen(true)}
        data-testid="my-consultation-branch-trigger"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          data-testid="my-consultation-branch-modal"
        >
          <div className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Consultations for</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
                data-testid="my-consultation-branch-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {options.map((o) => {
                const on = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => { setOpen(false); onPick(o.value); }}
                    className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition hover:bg-slate-100 ${
                      on ? "font-bold text-slate-900" : "text-slate-600"
                    }`}
                    data-testid={`my-consultation-branch-option-${o.value}`}
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-slate-700 bg-slate-700" : "border-slate-300 bg-white"}`}>
                      {on && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{o.label}</span>
                      {o.hint && <span className="block truncate text-[11px] font-normal text-slate-400">{o.hint}</span>}
                    </span>
                  </button>
                );
              })}
              {branches.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-slate-400">No branches yet.</p>
              )}
            </div>
            <div className="shrink-0 border-t border-slate-200 px-4 py-2.5 text-right">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)} data-testid="my-consultation-branch-cancel">Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/**
 * The consultants who work the branch picked beside it.
 *
 * A menu of people rather than a filter: picking one opens their day, it does not narrow
 * the board underneath. Under All Branches it lists every consultant, since a consultant
 * is org-wide and the question "whose day" still has an answer there.
 */
const ConsultantPicker = ({ branchId, excludeId, onPick }) => {
  const [rows, setRows] = useState([]);
  // The reader is never on their own list — this menu is for opening somebody else's day,
  // and their own is the board already underneath it.
  const consultants = useMemo(
    () => rows.filter((c) => !c.is_me && (!excludeId || c.id !== excludeId)),
    [rows, excludeId],
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // A branch asks who is posted there — the same list Reassign reads, Super Admin first.
    // All Branches has no posting to ask about, so it lists every consultant by name.
    const req = branchId === ALL
      ? getDoctors().then((rows) => (rows || [])
        .filter((d) => d.profile_type === "head_physio")
        .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""))))
      : listBranchConsultants(branchId).then((res) => res?.consultants || []);
    req
      .then((list) => { if (live) setRows(list); })
      .catch(() => { if (live) setRows([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-10 shrink-0 justify-between gap-2 bg-sky-600 px-3 text-white hover:bg-sky-700" data-testid="my-consultation-consultant-trigger">
          <span className="flex min-w-0 items-center gap-2">
            <Stethoscope className="h-4 w-4 shrink-0" />
            <span className="truncate">Consultants{consultants.length ? ` (${consultants.length})` : ""}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-80" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto" data-testid="my-consultation-consultant-menu">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-slate-400">
          {branchId === ALL ? "All consultants" : "Consultants at this branch"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <p className="px-2 py-4 text-center text-xs text-slate-400">Loading…</p>
        ) : consultants.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-slate-400">No consultants for this branch.</p>
        ) : consultants.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onSelect={() => onPick(c)}
            className="cursor-pointer flex-col items-start gap-0"
            data-testid={`my-consultation-consultant-${c.id}`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
              {c.full_name}
              {c.is_super_admin && <span className="rounded-[4px] bg-slate-100 px-1 py-px text-[9px] font-bold uppercase text-slate-600">Super Admin</span>}
            </span>
            {c.specialization && <span className="text-[11px] text-slate-400">{c.specialization}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Which branches the Super Admin takes consultations at — one On/Off per branch.
 *
 * On is what puts them on that branch's Consultant Calendar (MANAGEMENT) and in its booking
 * and reassign pickers, so the Branch Admin there can open the days agreed on the phone and
 * book a patient into them. Off takes them out of that branch only. Everything is On until
 * switched off, so a new branch has them without anybody remembering to add it.
 *
 * An icon beside the name chip, opening the switches in a popup — the header row stays one
 * line. Not drawn at all when a developer has the feature off (Danger Zone).
 */
const ConsultBranchSwitches = () => {
  const [rows, setRows] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let live = true;
    getMyConsultBranches()
      .then((res) => { if (live) { setRows(res?.branches || []); setEnabled(!!res?.enabled); } })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const flip = async (row, on) => {
    setBusyId(row.branch_id);
    // Drawn at once, then replaced by the server's answer — or put back if it refused.
    setRows((cur) => cur.map((r) => (r.branch_id === row.branch_id ? { ...r, on } : r)));
    try {
      const res = await setMyConsultBranch(row.branch_id, on);
      setRows(res?.branches || []);
      toast.success(`${row.branch_name}: consultations ${on ? "On" : "Off"}`);
    } catch (err) {
      setRows((cur) => cur.map((r) => (r.branch_id === row.branch_id ? { ...r, on: !on } : r)));
      toast.error(err?.response?.data?.detail || "Could not change this branch");
    } finally {
      setBusyId(null);
    }
  };

  if (rows === null || !enabled) return null;
  const onCount = rows.filter((r) => r.on).length;
  const someOff = onCount < rows.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Take consultations at — branch On/Off"
        aria-label="Take consultations at — branch On/Off"
        className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
        data-testid="my-consultation-branch-switches-open"
      >
        <Building2 className="h-4 w-4" />
        {/* How many are On, so a branch switched Off is visible without opening it. */}
        <span className={`absolute -right-1.5 -top-1.5 rounded-full px-1.5 text-[9px] font-bold leading-4 text-white ${someOff ? "bg-amber-500" : "bg-emerald-600"}`}>
          {onCount}/{rows.length}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          data-testid="my-consultation-branch-switches"
        >
          <section className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-slate-400" /> Take consultations at
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
                data-testid="my-consultation-branch-switches-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-slate-400">No branches yet.</p>
            ) : (
              // One branch per row, read top to bottom like the branch picker beside it.
              <div className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
                {rows.map((r) => (
                  <label
                    key={r.branch_id}
                    className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                    data-testid={`my-consultation-branch-switch-${r.branch_id}`}
                  >
                    <span className={`truncate text-sm ${r.on ? "font-medium text-slate-800" : "text-slate-400"}`}>{r.branch_name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`text-[10px] font-bold uppercase ${r.on ? "text-emerald-600" : "text-slate-400"}`}>{r.on ? "On" : "Off"}</span>
                      <Switch
                        checked={r.on}
                        disabled={busyId !== null}
                        onCheckedChange={(on) => flip(r, on)}
                        className="data-[state=checked]:bg-emerald-600"
                      />
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
};

// The marks spelled out, beside the patient's name. The list has room for the words now
// that it is one row per patient rather than a card per hour, and a row that says "needs
// attention" does not need the reader to know what a red dot meant.
const MarkBadges = ({ booking }) => (
  <>
    {booking.is_vip && (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
        <Star className="h-3 w-3 fill-amber-400 text-amber-500" /> VIP
      </span>
    )}
    {booking.needs_attention && (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200">
        <AlertCircle className="h-3 w-3 fill-rose-500 text-white" /> Needs attention
      </span>
    )}
  </>
);

const KIND_TONE = {
  consultation: "border-sky-200 bg-sky-50 text-sky-700",
  review: "border-violet-200 bg-violet-50 text-violet-700",
};

// Booked / Available are gone with the grid: an empty hour is no longer a thing this
// popup shows, so a filter that selects one would filter to nothing at all.
const BOOKING_FILTERS = [
  { key: "all", label: "All" },
  { key: "vip", label: "VIP" },
  { key: "attention", label: "Attention" },
];

const bookingMatches = (bk, filter) => {
  if (filter === "vip") return !!bk.is_vip;
  if (filter === "attention") return !!bk.needs_attention;
  return true;
};

/** "2026-09-26" -> "Sat, 26 Sep 2026" — the date each row is actually on. */
const dayLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
};

/**
 * One consultant's booked patients for a day — name, when, and which branch.
 *
 * It used to be the consultant's whole grid: every published hour as a card, with the
 * empty ones saying "Available". On a normal day that is seventeen empty cards around one
 * patient, and the patient is what the reader came for — nobody opens another consultant's
 * day from My Consultation to admire their free hours. The grid also cost a second click:
 * the patient's details only appeared once their hour was selected.
 *
 * So the slots are gone and what was behind them is the list. An hour with nothing in it
 * simply isn't a row. Availability still lives where it is acted on — the booking popup on
 * Branch Leads, which is the only place a free hour can actually be taken.
 */
const ConsultantSlotsModal = ({ branchId, consultant, canAssignToMe = false, onAssigned, onClose }) => {
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  // Paging the week quickly fires several requests; only the latest may land.
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await getConsultantSlots(branchId, consultant.id, date);
      if (id === reqId.current) setData(res);
    } catch (err) {
      if (id === reqId.current) {
        setData(null);
        toast.error(err?.response?.data?.detail || "Could not load this consultant's slots");
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [branchId, consultant.id, date]);

  useEffect(() => { load(); }, [load]);

  // Takes this patient's consultation off the consultant whose day this is and onto the
  // reader, keeping the slot — the same move Reassign makes, for one patient at a time.
  const [assigningId, setAssigningId] = useState(null);
  const assignToMe = async (bk) => {
    setAssigningId(bk.id);
    try {
      const res = await reassignConsultant([bk.lead_id]);
      if (res?.moved?.length) {
        toast.success(`${bk.patient_name} moved to ${res.consultant?.full_name || "you"}`);
        load();
        if (onAssigned) onAssigned();
      } else {
        toast.error(res?.skipped?.[0]?.reason || "Could not assign this patient to you");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not assign this patient to you");
    } finally {
      setAssigningId(null);
    }
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Every patient the consultant holds that day, flattened out of the slots they came in
  // and ordered by the hour — the grid was the only thing that needed them kept apart.
  const bookings = useMemo(() => {
    const rows = (data?.slots || []).flatMap((s) => s.bookings || []);
    return rows.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
  }, [data]);
  const visible = useMemo(() => bookings.filter((bk) => bookingMatches(bk, filter)), [bookings, filter]);
  const summary = data?.summary || {};

  const filterCount = (key) => (key === "all" ? bookings.length : bookings.filter((bk) => bookingMatches(bk, key)).length);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="consultant-slots-modal"
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 bg-slate-900 px-5 py-4 text-white">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-lg font-bold">
              <Stethoscope className="h-5 w-5 shrink-0" />
              {consultant.full_name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-slate-300">
              {[consultant.specialization, "Booked patients"].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-lg border border-slate-600 p-2 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              aria-label="Refresh"
              data-testid="consultant-slots-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border-2 border-orange-200 bg-orange-100 p-2 text-orange-600 hover:bg-orange-200"
              aria-label="Close"
              data-testid="consultant-slots-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <WeekStrip value={date} onChange={setDate} testid="consultant-slots-week" />

          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1" data-testid="consultant-slots-filter">
            {BOOKING_FILTERS.map((f) => {
              const on = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                  data-testid={`consultant-slots-filter-${f.key}`}
                >
                  {f.key === "vip" && <Star className={`h-3 w-3 ${on ? "fill-amber-300 text-amber-300" : "fill-amber-400 text-amber-500"}`} />}
                  {f.key === "attention" && <AlertCircle className={`h-3 w-3 ${on ? "fill-rose-400 text-slate-900" : "fill-rose-500 text-white"}`} />}
                  {f.label}
                  <span className={on ? "text-white/70" : "text-slate-400"}>{filterCount(f.key)}</span>
                </button>
              );
            })}
            {(summary.vip > 0 || summary.attention > 0) && (
              <span className="ml-auto px-2 text-[11px] text-slate-500">
                {summary.vip || 0} VIP · {summary.attention || 0} need attention
              </span>
            )}
          </div>

          {loading && !data ? (
            <p className="py-12 text-center text-sm text-slate-400">Loading appointments…</p>
          ) : bookings.length === 0 ? (
            <div className="py-12 text-center" data-testid="consultant-slots-empty">
              <CalendarDays className="mx-auto mb-2 h-9 w-9 text-slate-200" />
              <p className="text-sm text-slate-400">No appointments for {consultant.full_name} on this day.</p>
            </div>
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">No appointments match this filter.</p>
          ) : (
            <div className="space-y-2" data-testid="consultant-appointments-list">
              {visible.map((bk) => (
                <div
                  key={`${bk.kind}-${bk.id}`}
                  // The mark colours the row's edge, the same way it coloured the card it
                  // replaces: a VIP or a flagged patient reads down the list before any
                  // name does, and attention wins where both apply.
                  className={`flex flex-col gap-2 rounded-lg border border-l-4 border-slate-200 bg-white p-3 sm:flex-row sm:items-start sm:justify-between ${
                    bk.needs_attention ? "border-l-rose-500" : bk.is_vip ? "border-l-amber-400" : "border-l-sky-500"
                  }`}
                  data-testid={`consultant-slot-booking-${bk.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-slate-800">{bk.patient_name}</span>
                      <MarkBadges booking={bk} />
                      <RescheduledTag
                        lead={{ appointment_rescheduled: bk.rescheduled, appointment_rescheduled_from: bk.rescheduled_from }}
                      />
                    </div>
                    {/* When and where, on their own line under the name — the two things
                        the grid used to say from the card's position rather than in words. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3 text-slate-400" />
                        {dayLabel(data?.date || date)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3 text-slate-400" />
                        {to12h(bk.time)}
                      </span>
                      {bk.branch_name && (
                        <span className={`inline-flex items-center gap-1 ${bk.branch_id && branchId !== ALL && bk.branch_id !== branchId ? "text-amber-700" : ""}`}>
                          <Building2 className="h-3 w-3 text-slate-400" />
                          {bk.branch_name}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                      {bk.patient_number && <span className="font-mono">{bk.patient_number}</span>}
                      {bk.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{bk.phone}</span>}
                    </div>
                  </div>
                  {/* The tag, and under it the one thing to do about it. Only a consultation
                      can be moved — a review is dispatched to a consultant, not booked. */}
                  <div className="flex shrink-0 flex-row items-center gap-2 sm:flex-col sm:items-end">
                    <span className={`rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${KIND_TONE[bk.kind] || KIND_TONE.consultation}`}>
                      {bk.kind === "review" ? `Review${bk.status === "completed" ? " · Completed" : ""}` : "Consultation"}
                    </span>
                    {canAssignToMe && bk.kind === "consultation" && bk.lead_id && (
                      <Button
                        size="sm"
                        onClick={() => assignToMe(bk)}
                        disabled={assigningId !== null}
                        className="h-8 gap-1.5 bg-sky-600 px-3 text-xs text-white hover:bg-sky-700"
                        data-testid={`consultant-slot-assign-me-${bk.id}`}
                      >
                        {assigningId === bk.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <UserCheck className="h-3.5 w-3.5" />}
                        Assign to me
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * A Super Admin's own consultation board.
 *
 * The same board a CONSULTANT signs in to, opened from the Master View, with a branch
 * picker in front of it — a consultant covers the whole organisation, so which branch's
 * appointments are being read is the first question and there was nowhere to answer it.
 * Beside it, the branch's consultants: pick one to open their day slot by slot.
 *
 * This page used to be about somebody else. A Super Admin is hired as a Super Admin, so
 * HR never minted them a consultant record, and with nothing to match on the board fell
 * back to whichever record existed and listed the whole branch's consultations under a
 * title that says "My". Three different owners on one page: a banner naming a consultant
 * picked at random, a table showing every consultant's patients, and a Review queue that
 * could only ever be empty.
 *
 * Both halves are fixed at the source rather than papered over here. The record is created
 * on mount (ensure_super_admin_consultant), so the reader always has one; and the board is
 * asked for `mine`, so what it lists is the consultations booked to them. The page is now
 * true to its name, and empty until they take one — which is the honest answer, not a bug.
 *
 * The banner stays for the one case still possible: a CONSULTANT hired without a record.
 * A Super Admin can no longer reach it.
 */
export const MyConsultationBoard = ({ user, search = "", onSearchChange, branches = [] }) => {
  const [branchId, setBranchId] = useState(ALL);
  const [resolved, setResolved] = useState(null);
  const [slotsFor, setSlotsFor] = useState(null);
  // Bumped after a patient is assigned to the reader so the board underneath reads them in.
  // The board fetches on mount, and a remount is the one refresh it answers to from outside.
  const [boardKey, setBoardKey] = useState(0);
  const bumpBoard = useCallback(() => setBoardKey((k) => k + 1), []);

  const load = useCallback(() => {
    hpResolvedConsultant()
      .then(setResolved)
      .catch(() => setResolved(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const closeSlots = useCallback(() => setSlotsFor(null), []);
  const notMine = resolved && !resolved.is_mine;

  // The start of the board's own tool bar rather than a row above it: branch, whose day,
  // whose book, then the board's search, dates and refresh — one row on a wide screen.
  const toolbarLead = (
    <>
      <BranchPicker value={branchId} branches={branches} onPick={setBranchId} />

      {/* Beside the branch picker because it answers the same first question — which
          branch — and then whose day at it. Replaced Assign Consultations here. */}
      <ConsultantPicker
        branchId={branchId}
        excludeId={resolved?.is_mine ? resolved.consultant_id : null}
        onPick={setSlotsFor}
      />

      {/* Whose book this is, said once at the top. The page is named after the reader
          and lists only their patients now, so the name is confirmation rather than a
          warning — and the tag beside it is the same one their rows wear downstream,
          so the reader recognises their own work on a Branch Admin's screen too. */}
      {resolved?.is_mine && resolved.consultant_name && (
        <div
          className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3"
          data-testid="my-consultation-whoami"
        >
          <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="text-xs font-semibold text-slate-700">{resolved.consultant_name}</span>
          {resolved.is_super_admin && (
            <span className="rounded-[4px] border border-slate-300 bg-slate-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-slate-600">
              Head Chief
            </span>
          )}
        </div>
      )}

      {resolved?.is_super_admin && <ConsultBranchSwitches />}
    </>
  );

  return (
    <div className="space-y-4" data-testid="my-consultation-board">
      {notMine && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" data-testid="my-consultation-not-mine">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-800">
            No consultant record is linked to this login, so there is nothing to show. Ask HR Admin to link a CONSULTANT record to it.
          </p>
        </div>
      )}

      {/* branchId, never branchIds: the board collapses a list to its first entry, so
          handing it several would show one and imply all of them. */}
      <HeadPhysioBoard
        key={boardKey}
        branchId={branchId}
        user={user}
        // The whole difference between this page and Operations > Consultant. Without it
        // the board is branch-scoped, which is a supervisor's question, not this one's.
        mine
        search={search}
        onSearchChange={onSearchChange}
        toolbarLead={toolbarLead}
        ledgerCards
        rowArrow
        oneLineRows
      />

      {slotsFor && (
        <ConsultantSlotsModal
          branchId={branchId}
          consultant={slotsFor}
          // The move is Super Admin only server-side, so the button is offered only there.
          canAssignToMe={!!resolved?.is_super_admin}
          onAssigned={bumpBoard}
          onClose={closeSlots}
        />
      )}
    </div>
  );
};

export default MyConsultationBoard;
