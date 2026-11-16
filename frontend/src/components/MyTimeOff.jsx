/**
 * Time Off — the third tab of everybody's own page, and the one that writes into HR's work.
 *
 *     Leave        whole days, one or many
 *     Permission   hours inside one working day
 *
 * It sits beside Attendance rather than in a dialog off the header for the reason the
 * other tabs do: what is on it is a year of requests and a form, which a dialog can
 * only letterbox. And it belongs on this page in particular because the tab next to it is
 * where an approved request ends up — a leave becomes the day marked `leave` on the month,
 * a permission becomes hours accounted for on a day still worked.
 *
 * Nothing here decides anything. Every request lands in HR's approvals list as pending —
 * the same list, not a second one — and HR approves it, at which point it reaches the
 * attendance register on its own (see backend/routers/v3_hr_ops.py).
 *
 * Withdrawing is only offered while a request is pending, and the server says so per row
 * (`can_withdraw`) rather than this file working it out — a button that shows up on a
 * decided request is a button that errors when pressed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlarmClock, Ban, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Hourglass, Palmtree, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { duration, prettyTime } from "@/lib/clock";
import { myRequests, raiseMyRequest, withdrawMyRequest } from "@/lib/api";

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

/** Mirrors SELF_SERVICE_KINDS in backend/routers/v3_me.py. `timed` is what splits the form
 *  in two: a leave wants two dates, a permission wants one date and two clock times, and
 *  offering both to both would leave every request half empty. */
const KINDS = [
  {
    key: "leave",
    label: "Leave",
    icon: Palmtree,
    blurb: "Whole days off. Approved, they go on the register as leave.",
    timed: false,
  },
  {
    key: "permission",
    label: "Permission",
    icon: Clock3,
    blurb: "A few hours inside one working day. The day still counts as worked.",
    timed: true,
  },
];
const KIND_BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));

const STATUS = {
  pending: { label: "Waiting on HR", tone: "bg-amber-100 text-amber-700", icon: Hourglass },
  approved: { label: "Approved", tone: "bg-emerald-100 text-emerald-700", icon: Check },
  rejected: { label: "Not approved", tone: "bg-rose-100 text-rose-700", icon: Ban },
};

const prettyDate = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "");

const thisYear = () => String(new Date().getFullYear());

/** What one request covers, in a line: a day, a span of them, or hours of one. */
const covers = (r) => {
  if (r.kind === "permission") {
    return `${prettyDate(r.from_date)} · ${prettyTime(r.from_time)} → ${prettyTime(r.to_time)} · ${duration(r.minutes)}`;
  }
  if (r.from_date === r.to_date) return prettyDate(r.from_date);
  return `${prettyDate(r.from_date)} → ${prettyDate(r.to_date)} · ${r.days} days`;
};

/** A figure with a caption, in the same shape as the Attendance tab's tiles beside it, so
 *  the three tabs read as one page rather than three. */
const Tile = ({ label, value, sub, tone = "text-slate-800", testid }) => (
  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm" data-testid={testid}>
    <span className="block truncate text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
    <span className={`mt-0.5 block text-2xl font-extrabold ${tone}`}>{value}</span>
    {sub && <span className="mt-0.5 block text-[11px] text-slate-400">{sub}</span>}
  </div>
);

/**
 * The form, which is the whole point of the tab.
 *
 * Collapsed behind a button rather than sitting open above the list: most openings of this
 * tab are somebody checking whether last week's request was decided, and a form in front
 * of that is a form in the way.
 */
// `popup` lays the same fields out for RequestPopup: a scrolling body whose Reason box takes
// the spare height, and Cancel / Send pinned in a footer.
const RequestForm = ({ limits, today, busy, onSubmit, onCancel, compact = false, popup = false }) => {
  const [kind, setKind] = useState("leave");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [reason, setReason] = useState("");

  const spec = KIND_BY_KEY[kind];
  const maxHours = Math.round((limits?.max_minutes || 240) / 60);

  // The one figure worth showing before it is sent: how long a permission is being asked
  // for. It is also what the server refuses on, so seeing it beforehand is the difference
  // between correcting a time and being told off for one.
  const askedMinutes = useMemo(() => {
    if (!spec.timed || !fromTime || !toTime) return 0;
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return mins(toTime) - mins(fromTime);
  }, [spec.timed, fromTime, toTime]);

  const tooLong = askedMinutes > (limits?.max_minutes || 240);
  const tooShort = askedMinutes > 0 && askedMinutes < (limits?.min_minutes || 15);

  const submit = () => {
    if (!fromDate) { toast.error(spec.timed ? "Pick the day this is for." : "Pick the first day."); return; }
    if (spec.timed && (!fromTime || !toTime)) { toast.error("Set both times."); return; }
    if (!reason.trim()) { toast.error("Say what this is for."); return; }
    onSubmit({
      kind,
      from_date: fromDate,
      // A one-day leave is the common case, so leaving the second date blank means the
      // same day rather than being an error to correct.
      to_date: spec.timed ? fromDate : (toDate || fromDate),
      from_time: spec.timed ? fromTime : "",
      to_time: spec.timed ? toTime : "",
      reason: reason.trim(),
    });
  };

  const kindPicker = (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {KINDS.map((k) => {
        const Icon = k.icon;
        const on = kind === k.key;
        return (
          <button
            key={k.key}
            type="button"
            onClick={() => setKind(k.key)}
            className={`rounded-lg border px-3 py-2 text-left transition ${
              on ? "border-sky-500 bg-white shadow-sm" : "border-slate-200 bg-white/60 hover:border-sky-300"
            }`}
            data-testid={`my-timeoff-kind-${k.key}`}
          >
            <span className={`flex items-center gap-1.5 text-sm font-bold ${on ? "text-sky-700" : "text-slate-600"}`}>
              <Icon className="h-4 w-4" />{k.label}
            </span>
            {!compact && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{k.blurb}</span>}
          </button>
        );
      })}
    </div>
  );

  const fields = spec.timed ? (
    <div className={`${popup ? "" : "mt-3 "}grid grid-cols-1 gap-3 sm:grid-cols-3`}>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Day</span>
        <MilkDateInput value={fromDate} accent="sky" centered title="Which day?" onChange={(e) => setFromDate(e.target.value)} data-testid="my-timeoff-day" />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
        <input
          type="time"
          value={fromTime}
          onChange={(e) => setFromTime(e.target.value)}
          className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
          data-testid="my-timeoff-from-time"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
        <input
          type="time"
          value={toTime}
          onChange={(e) => setToTime(e.target.value)}
          className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
          data-testid="my-timeoff-to-time"
        />
      </label>
    </div>
  ) : (
    <div className={`${popup ? "" : "mt-3 "}grid grid-cols-1 gap-3 sm:grid-cols-2`}>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">First day</span>
        <MilkDateInput value={fromDate} accent="sky" centered title="First day off" onChange={(e) => setFromDate(e.target.value)} data-testid="my-timeoff-from" />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Last day</span>
        <MilkDateInput value={toDate} min={fromDate} accent="sky" centered title="Last day off" placeholder="Same day" onChange={(e) => setToDate(e.target.value)} data-testid="my-timeoff-to" />
      </label>
    </div>
  );

  const asked = spec.timed && askedMinutes > 0 && (
    <p
      className={`${popup ? "" : "mt-2 "}text-xs font-semibold ${tooLong || tooShort ? "text-rose-600" : "text-sky-700"}`}
      data-testid="my-timeoff-asked"
    >
      {tooLong
        ? `That's ${duration(askedMinutes)} — a permission tops out at ${maxHours} hours. Longer than that, ask for leave.`
        : tooShort
          ? `That's ${duration(askedMinutes)} — anything under ${limits?.min_minutes || 15} minutes is a break, not a permission.`
          : `Asking for ${duration(askedMinutes)}.`}
    </p>
  );

  const reasonBox = (
    <textarea
      value={reason}
      onChange={(e) => setReason(e.target.value)}
      rows={2}
      placeholder={compact ? "Enter reason" : "Whoever decides this is reading it cold — say what it's for."}
      className={`w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-sky-400 focus:ring-1 focus:ring-sky-300 ${popup ? "min-h-0 flex-1 resize-none" : ""}`}
      data-testid="my-timeoff-reason"
    />
  );

  const cancelButton = <Button variant="outline" onClick={onCancel} className={popup ? "min-w-[110px]" : "flex-1"} data-testid="my-timeoff-cancel">Cancel</Button>;
  const sendButton = (
    <Button onClick={submit} disabled={busy || tooLong || tooShort} className={`${popup ? "min-w-[140px]" : "flex-1"} bg-sky-600 text-white hover:bg-sky-700`} data-testid="my-timeoff-send">
      {busy ? "Sending…" : "Send to HR"}
    </Button>
  );

  const footnote = !compact && (
    <p className={`${popup ? "text-left" : "mt-2 text-center"} text-[11px] text-slate-500`}>
      {today ? `Today is ${prettyDate(today)}. ` : ""}HR decides this — nothing is booked until they do.
    </p>
  );

  if (popup) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="my-timeoff-form">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {kindPicker}
          {fields}
          {asked}
          <label className="flex min-h-[110px] flex-1 flex-col">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reason</span>
            {reasonBox}
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          {footnote || <span />}
          <div className="flex shrink-0 gap-2">{cancelButton}{sendButton}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 shadow-sm" data-testid="my-timeoff-form">
      {kindPicker}
      {fields}
      {asked}
      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reason</span>
        {reasonBox}
      </label>
      <div className="mt-3 flex gap-2">{cancelButton}{sendButton}</div>
      {footnote}
    </div>
  );
};

/**
 * The form as a popup, 730 x 550 from sm up (never taller than the window), for the
 * Permission Request board. Portalled to the body so no transformed parent can clip it,
 * and not a Radix dialog: the date fields open their calendar as a fixed layer, which a
 * transformed dialog card would trap inside itself. Closed by X or Cancel only, so a
 * stray click beside it does not throw away a half-written reason.
 */
const RequestPopup = ({ onClose, ...formProps }) => createPortal(
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" data-testid="my-timeoff-popup-overlay">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="my-timeoff-popup-title"
      className="flex h-[min(550px,calc(100dvh-1.5rem))] w-full max-w-[730px] flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl ring-1 ring-slate-200 [&_*]:!rounded-[4px]"
      data-testid="my-timeoff-popup"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div className="min-w-0">
          <h2 id="my-timeoff-popup-title" className="text-base font-semibold text-slate-800">New Request</h2>
          <p className="text-xs text-slate-500">Leave or permission, sent to HR to approve.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          data-testid="my-timeoff-popup-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <RequestForm popup onCancel={onClose} {...formProps} />
    </div>
  </div>,
  document.body,
);

/** One request, with its decision if it has one. */
const RequestRow = ({ row, onWithdraw }) => {
  const kind = KIND_BY_KEY[row.kind] || KIND_BY_KEY.leave;
  const state = STATUS[row.status] || STATUS.pending;
  const Icon = kind.icon;
  const StateIcon = state.icon;
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm" data-testid={`my-timeoff-row-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
              <Icon className="h-3 w-3" />{kind.label}
            </span>
            <span className="text-sm font-semibold text-slate-800">{covers(row)}</span>
          </p>
          {row.reason && <p className="mt-1 text-sm text-slate-600">{row.reason}</p>}
          <p className="mt-1 text-[11px] text-slate-400">
            {/* A request HR logged on somebody's behalf reads differently from one they
                filed themselves, and on their own list that difference is worth saying. */}
            {row.raised_by_me ? "You asked for this" : `Logged for you by ${row.requested_by || "HR"}`}
            {row.decided_by ? ` · ${row.status === "approved" ? "Approved" : "Decided"} by ${row.decided_by}` : ""}
          </p>
          {row.decision_note && (
            <p className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600" data-testid={`my-timeoff-note-${row.id}`}>
              {row.decision_note}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${state.tone}`}>
            <StateIcon className="h-3 w-3" />{state.label}
          </span>
          {row.can_withdraw && (
            <button
              type="button"
              onClick={() => onWithdraw(row)}
              title="Withdraw this request"
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              data-testid={`my-timeoff-withdraw-${row.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
};

export const TimeOffTab = ({ compact = false }) => {
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((y) => {
    setLoading(true);
    return myRequests(y).then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(year); }, [year, load]);

  const send = async (payload) => {
    setBusy(true);
    try {
      await raiseMyRequest(payload);
      toast.success("Sent to HR. You'll see it here once they decide.");
      setAsking(false);
      // Jump to the year the request is actually in, so a leave booked for January while
      // reading last year's list does not vanish on being sent.
      const asked = String(payload.from_date || "").slice(0, 4);
      if (asked && asked !== year) setYear(asked); else load(year);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const withdraw = async (row) => {
    if (!window.confirm(`Withdraw this ${(KIND_BY_KEY[row.kind] || {}).label?.toLowerCase() || "request"}?`)) return;
    try {
      await withdrawMyRequest(row.id);
      toast.success("Withdrawn.");
      load(year);
    } catch (e) { fail(e); }
  };

  const rows = data?.requests || [];
  const counts = data?.counts || {};
  const taken = data?.taken || {};

  if (data && data.linked === false) {
    return (
      <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-8 text-center text-sm text-amber-800" data-testid="my-timeoff-unlinked">
        {data.reason}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="my-timeoff-tab">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setYear(String(Number(year) - 1))}
          className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50"
          data-testid="my-timeoff-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-slate-700" data-testid="my-timeoff-year">{year}</span>
        <button
          type="button"
          disabled={year >= thisYear()}
          onClick={() => setYear(String(Number(year) + 1))}
          className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-40"
          data-testid="my-timeoff-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Approved only, and the caption says so — a pending leave is not time off yet, and
          counting it here would tell somebody they had spent days they may still be
          refused. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Tile label="Leave taken" value={`${taken.leave_days || 0}d`} sub={compact ? null : "Approved"} tone="text-sky-600" testid="my-timeoff-leave-days" />
        <Tile label="Permission" value={duration(taken.permission_minutes || 0)} sub={compact ? null : `${taken.permission_count || 0} times`} tone="text-violet-600" testid="my-timeoff-perm" />
        <Tile label="Waiting" value={counts.pending || 0} sub={compact ? null : "With HR"} tone={counts.pending ? "text-amber-600" : "text-slate-400"} testid="my-timeoff-pending" />
      </div>

      {asking ? (
        <RequestForm
          compact={compact}
          limits={data?.permission_limits}
          today={data?.today}
          busy={busy}
          onSubmit={send}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <Button onClick={() => setAsking(true)} className="w-full bg-sky-600 text-white hover:bg-sky-700" data-testid="my-timeoff-new">
          <Plus className="h-4 w-4" />{compact ? "New request" : "Ask for leave or permission"}
        </Button>
      )}

      {loading && !data ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (compact && asking ? null : (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-sm text-slate-400" data-testid="my-timeoff-empty">
          <AlarmClock className="mx-auto mb-2 h-5 w-5 text-slate-300" />
          {compact ? "No requests" : `Nothing asked for in ${year}.`}
        </p>
      )) : (
        <ul className="space-y-2" data-testid="my-timeoff-list">
          {rows.map((r) => <RequestRow key={r.id} row={r} onWithdraw={withdraw} />)}
        </ul>
      )}
    </div>
  );
};

// ---------- the Permission Request board (My Profile, desktop) ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekday = (iso, style = "long") => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: style }) : "");

/** Calendar days of one request that fall inside [start, end] (both ISO, inclusive). */
const daysInside = (r, start, end) => {
  const from = r.from_date > start ? r.from_date : start;
  const to = (r.to_date || r.from_date) < end ? (r.to_date || r.from_date) : end;
  if (from > to) return 0;
  return Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
};

const STATUS_TABS = [
  { key: "pending", label: "Pending", on: "border-amber-500 bg-amber-500 text-white", onBadge: "bg-white/30 text-white", badge: "bg-amber-100 text-amber-700" },
  { key: "approved", label: "Approved", on: "border-emerald-500 bg-emerald-500 text-white", onBadge: "bg-white/30 text-white", badge: "bg-emerald-100 text-emerald-700" },
  { key: "rejected", label: "Rejected", on: "border-rose-500 bg-rose-500 text-white", onBadge: "bg-white/30 text-white", badge: "bg-rose-100 text-rose-700" },
];

const BoardTile = ({ label, value, sub, tone, testid }) => (
  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center shadow-sm" data-testid={testid}>
    <span className="block truncate text-xs text-slate-600">{label}</span>
    <span className={`mt-1 block text-2xl font-bold leading-tight ${tone}`}>{value}</span>
    <span className="mt-0.5 block truncate text-[11px] text-slate-500">{sub}</span>
  </div>
);

const selectCls = "h-9 rounded-md border border-slate-200 bg-white px-3 pr-8 text-sm font-medium text-slate-700 shadow-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300";

/** One request as a table row of the board. */
const BoardRow = ({ row, onWithdraw }) => {
  const kind = KIND_BY_KEY[row.kind] || KIND_BY_KEY.leave;
  const state = STATUS[row.status] || STATUS.pending;
  const Icon = kind.icon;
  const StateIcon = state.icon;
  const to = row.to_date || row.from_date;
  const oneDay = row.kind === "permission" || row.from_date === to;
  return (
    <tr className="border-b border-slate-100 align-top last:border-0" data-testid={`my-timeoff-row-${row.id}`}>
      <td className="px-2.5 py-3">
        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
          <Icon className="h-3 w-3" />{kind.label}
        </span>
      </td>
      <td className="whitespace-nowrap px-2.5 py-3 text-slate-800">
        {oneDay ? prettyDate(row.from_date) : `${prettyDate(row.from_date)} → ${prettyDate(to)}`}
        {row.kind === "permission" && (
          <span className="block text-[11px] text-slate-500">{prettyTime(row.from_time)} → {prettyTime(row.to_time)}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2.5 py-3 text-slate-600">
        {oneDay ? weekday(row.from_date) : `${weekday(row.from_date, "short")} → ${weekday(to, "short")}`}
      </td>
      <td className="whitespace-nowrap px-2.5 py-3 text-slate-800">
        {row.kind === "permission" ? duration(row.minutes) : `${row.days || 1} ${(row.days || 1) === 1 ? "day" : "days"}`}
      </td>
      <td className="px-2.5 py-3 text-slate-700">
        {row.reason || "—"}
        {!row.raised_by_me && <span className="block text-[11px] text-slate-400">Logged for you by {row.requested_by || "HR"}</span>}
        {row.decision_note && (
          <span className="mt-1 block bg-slate-50 px-2 py-1 text-xs text-slate-600" data-testid={`my-timeoff-note-${row.id}`}>{row.decision_note}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2.5 py-3">
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${state.tone}`}>
            <StateIcon className="h-3 w-3" />{state.label}
          </span>
          {row.can_withdraw && (
            <button
              type="button"
              onClick={() => onWithdraw(row)}
              title="Withdraw this request"
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              data-testid={`my-timeoff-withdraw-${row.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        {row.decided_by && <span className="mt-1 block text-[11px] text-slate-400">by {row.decided_by}</span>}
      </td>
    </tr>
  );
};

/**
 * Permission Request as a month board: month and year at the top with New Request beside
 * them, four figures for the month, and the month's requests split into Pending /
 * Approved / Rejected in a table. The form opens in RequestPopup rather than pushing the
 * list down.
 *
 * The server sends a year; the month is cut from it here. A request belongs to every
 * month it touches, so a leave from the 30th to the 2nd shows under both.
 */
export const PermissionRequestBoard = () => {
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [tab, setTab] = useState("pending");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((y) => {
    setLoading(true);
    return myRequests(y).then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(year); }, [year, load]);

  const send = async (payload) => {
    setBusy(true);
    try {
      await raiseMyRequest(payload);
      toast.success("Sent to HR. You'll see it here once they decide.");
      setAsking(false);
      // Jump to the month the request is in, on Pending, so it is on screen once sent.
      const [y, m] = String(payload.from_date || "").split("-");
      setTab("pending");
      if (m) setMonth(Number(m) - 1);
      if (y && y !== year) setYear(y); else load(year);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const withdraw = async (row) => {
    if (!window.confirm(`Withdraw this ${(KIND_BY_KEY[row.kind] || {}).label?.toLowerCase() || "request"}?`)) return;
    try {
      await withdrawMyRequest(row.id);
      toast.success("Withdrawn.");
      load(year);
    } catch (e) { fail(e); }
  };

  const monthStart = toIso(new Date(Number(year), month, 1));
  const monthEnd = toIso(new Date(Number(year), month + 1, 0));
  const monthLabel = `${MONTHS[month]} ${year}`;

  const inMonth = useMemo(
    () => (data?.requests || []).filter((r) => r.from_date && r.from_date <= monthEnd && (r.to_date || r.from_date) >= monthStart),
    [data, monthStart, monthEnd],
  );
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    inMonth.forEach((r) => { if (c[r.status] !== undefined) c[r.status] += 1; });
    return c;
  }, [inMonth]);
  const approved = inMonth.filter((r) => r.status === "approved");
  const leaveDays = approved.filter((r) => r.kind === "leave").reduce((n, r) => n + daysInside(r, monthStart, monthEnd), 0);
  const permissions = approved.filter((r) => r.kind === "permission");
  const permissionMinutes = permissions.reduce((n, r) => n + (r.minutes || 0), 0);
  const shown = inMonth.filter((r) => r.status === tab);

  const nowYear = Number(thisYear());
  const years = [nowYear - 2, nowYear - 1, nowYear, nowYear + 1];
  if (!years.includes(Number(year))) years.unshift(Number(year));

  if (data && data.linked === false) {
    return (
      <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-8 text-center text-sm text-amber-800" data-testid="my-timeoff-unlinked">
        {data.reason}
      </p>
    );
  }

  const tabLabel = STATUS_TABS.find((t) => t.key === tab)?.label || "Pending";
  const newButton = (testid, small = false) => (
    <button
      type="button"
      onClick={() => setAsking(true)}
      className={`inline-flex items-center gap-2 rounded-md bg-emerald-500 font-semibold text-white shadow-sm transition hover:bg-emerald-600 ${small ? "px-3.5 py-1.5 text-sm" : "px-4 py-2 text-sm"}`}
      data-testid={testid}
    >
      {!small && <Send className="h-4 w-4" />}New Request
    </button>
  );

  return (
    <div className="space-y-4" data-testid="my-timeoff-board">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={selectCls} aria-label="Month" data-testid="my-timeoff-month">
            {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(e.target.value)} className={selectCls} aria-label="Year" data-testid="my-timeoff-year">
            {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
        </div>
        {newButton("my-timeoff-new")}
      </div>

      {/* Approved only for the two "taken" figures: a pending leave is not time off yet. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <BoardTile label="Leave Taken" value={`${leaveDays}d`} sub={monthLabel} tone="text-indigo-500" testid="my-timeoff-leave-days" />
        <BoardTile label="Permission" value={duration(permissionMinutes)} sub={`${permissions.length} ${permissions.length === 1 ? "time" : "times"}`} tone="text-orange-500" testid="my-timeoff-perm" />
        <BoardTile label="Waiting" value={counts.pending} sub="With HR" tone="text-rose-500" testid="my-timeoff-pending" />
        <BoardTile label="Total Requests" value={inMonth.length} sub="This Month" tone="text-emerald-500" testid="my-timeoff-total" />
      </div>

      <div className="flex flex-wrap gap-2" data-testid="my-timeoff-status-tabs">
        {STATUS_TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition ${on ? t.on : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              data-testid={`my-timeoff-tab-${t.key}`}
            >
              {t.label}
              <span className={`min-w-[18px] rounded-full px-1.5 text-[11px] font-semibold leading-[18px] ${on ? t.onBadge : t.badge}`}>{counts[t.key]}</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="my-timeoff-table-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">{tabLabel} Requests</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="my-timeoff-table">
            <thead>
              <tr className="border-b border-slate-200 text-[13px] text-slate-600">
                <th className="px-2.5 py-2.5 font-medium">Type</th>
                <th className="px-2.5 py-2.5 font-medium">Date</th>
                <th className="px-2.5 py-2.5 font-medium">Day</th>
                <th className="px-2.5 py-2.5 font-medium">Duration</th>
                <th className="px-2.5 py-2.5 font-medium">Reason</th>
                <th className="px-2.5 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-400">Loading…</td></tr>
              ) : shown.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center" data-testid="my-timeoff-empty">
                    <CalendarDays className="mx-auto mb-2 h-10 w-10 text-slate-400" strokeWidth={1.5} />
                    <p className="text-sm text-slate-600">No {tabLabel.toLowerCase()} requests in {monthLabel}</p>
                    {tab === "pending" && <div className="mt-3">{newButton("my-timeoff-empty-new", true)}</div>}
                  </td>
                </tr>
              ) : shown.map((r) => <BoardRow key={r.id} row={r} onWithdraw={withdraw} />)}
            </tbody>
          </table>
        </div>
      </div>

      {asking && (
        <RequestPopup
          limits={data?.permission_limits}
          today={data?.today}
          busy={busy}
          onSubmit={send}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
};

/**
 * Time Off on its own, full-screen — for the phone headers that carry it as a button
 * (Physio, Consultant) rather than as a row of the profile menu. Phones only, like the
 * button that opens it; from md up Time Off is a tab of My Profile.
 */
export const TimeOffPage = ({ onClose }) => (
  <div className="fixed inset-0 z-50 flex flex-col bg-slate-50 md:hidden" data-testid="my-timeoff-page">
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-3">
      <button
        type="button"
        onClick={onClose}
        className="-ml-1 rounded-full p-1.5 text-slate-700 active:bg-slate-100"
        aria-label="Back"
        data-testid="my-timeoff-page-back"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <h2 className="text-lg font-semibold text-slate-800">Time Off</h2>
    </div>
    <div className="flex-1 overflow-y-auto p-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
      <TimeOffTab />
    </div>
  </div>
);

export default TimeOffTab;
