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
import { AlarmClock, Ban, Check, ChevronLeft, ChevronRight, Clock3, Hourglass, Palmtree, Plus, Trash2 } from "lucide-react";
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
const RequestForm = ({ limits, today, busy, onSubmit, onCancel }) => {
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

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 shadow-sm" data-testid="my-timeoff-form">
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
              <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{k.blurb}</span>
            </button>
          );
        })}
      </div>

      {spec.timed ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">First day</span>
            <MilkDateInput value={fromDate} accent="sky" centered title="First day off" onChange={(e) => setFromDate(e.target.value)} data-testid="my-timeoff-from" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Last day</span>
            <MilkDateInput value={toDate} min={fromDate} accent="sky" centered title="Last day off" placeholder="Same day" onChange={(e) => setToDate(e.target.value)} data-testid="my-timeoff-to" />
          </label>
        </div>
      )}

      {spec.timed && askedMinutes > 0 && (
        <p
          className={`mt-2 text-xs font-semibold ${tooLong || tooShort ? "text-rose-600" : "text-sky-700"}`}
          data-testid="my-timeoff-asked"
        >
          {tooLong
            ? `That's ${duration(askedMinutes)} — a permission tops out at ${maxHours} hours. Longer than that, ask for leave.`
            : tooShort
              ? `That's ${duration(askedMinutes)} — anything under ${limits?.min_minutes || 15} minutes is a break, not a permission.`
              : `Asking for ${duration(askedMinutes)}.`}
        </p>
      )}

      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reason</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Whoever decides this is reading it cold — say what it's for."
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
          data-testid="my-timeoff-reason"
        />
      </label>

      <div className="mt-3 flex gap-2">
        <Button variant="outline" onClick={onCancel} className="flex-1" data-testid="my-timeoff-cancel">Cancel</Button>
        <Button onClick={submit} disabled={busy || tooLong || tooShort} className="flex-1 bg-sky-600 text-white hover:bg-sky-700" data-testid="my-timeoff-send">
          {busy ? "Sending…" : "Send to HR"}
        </Button>
      </div>
      <p className="mt-2 text-center text-[11px] text-slate-500">
        {today ? `Today is ${prettyDate(today)}. ` : ""}HR decides this — nothing is booked until they do.
      </p>
    </div>
  );
};

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

export const TimeOffTab = () => {
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
        <Tile label="Leave taken" value={`${taken.leave_days || 0}d`} sub="Approved" tone="text-sky-600" testid="my-timeoff-leave-days" />
        <Tile label="Permission" value={duration(taken.permission_minutes || 0)} sub={`${taken.permission_count || 0} times`} tone="text-violet-600" testid="my-timeoff-perm" />
        <Tile label="Waiting" value={counts.pending || 0} sub="With HR" tone={counts.pending ? "text-amber-600" : "text-slate-400"} testid="my-timeoff-pending" />
      </div>

      {asking ? (
        <RequestForm
          limits={data?.permission_limits}
          today={data?.today}
          busy={busy}
          onSubmit={send}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <Button onClick={() => setAsking(true)} className="w-full bg-sky-600 text-white hover:bg-sky-700" data-testid="my-timeoff-new">
          <Plus className="h-4 w-4" />Ask for leave or permission
        </Button>
      )}

      {loading && !data ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-sm text-slate-400" data-testid="my-timeoff-empty">
          <AlarmClock className="mx-auto mb-2 h-5 w-5 text-slate-300" />
          Nothing asked for in {year}.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="my-timeoff-list">
          {rows.map((r) => <RequestRow key={r.id} row={r} onWithdraw={withdraw} />)}
        </ul>
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
