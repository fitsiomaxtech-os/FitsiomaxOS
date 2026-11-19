/**
 * HR's running month: Attendance, Payroll, Approvals and Quotes.
 *
 * Four tabs of HR Admin, sitting straight after the Dashboard because they are the work
 * of a month rather than the shape of the company — the Employees, Credentials and
 * Department tabs after them are the org chart, which changes rarely, and these change
 * every day.
 *
 * They are one file because they are one chain, the same one their endpoints describe in
 * backend/routers/v3_hr_ops.py:
 *
 *     Approvals  ->  Attendance  ->  Payroll
 *
 * An approved leave writes itself into the register; the register's loss-of-pay days are
 * what payroll pro-rates against. Splitting them into four files would have put the three
 * screens that share those rules three imports apart, and the rules are the thing most
 * likely to be edited together.
 *
 * Kept out of HRBoard.jsx, which is already four thousand lines of the org chart. The
 * tabs are wired in there; everything they do lives here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock, ArrowLeft, Ban, CalendarOff, Check, ChevronLeft, ChevronRight, Coffee,
  Clock3, Download, Eye, Filter, IndianRupee, Lock, Palmtree, Pencil,
  Pin, PinOff, Plus, Quote, RefreshCw, Search, Trash2, Undo2, UserRound, Wallet, X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { downloadCsv } from "@/lib/printable";
// The clock people press for themselves — see components/ClockWidget.jsx, which is where
// the times on this register come from now.
import { duration, hours, prettyTime } from "@/lib/clock";
import {
  hrAttendanceOverview, hrMarkAttendance, hrEmployees,
  hrApprovals, hrCreateApproval, hrDecideApproval, hrDeleteApproval,
  hrPayroll, hrGeneratePayroll, hrAdjustPayslip, hrPayrollStatus,
  hrQuotes, hrAddQuote, hrUpdateQuote, hrDeleteQuote,
  hrEmployeeSalary, hrAddSalaryRecord, hrDeleteSalaryRecord, hrAddSalaryReason,
} from "@/lib/api";

// ---------- shared ----------

const money = (n) => `₹${Math.round(Number(n || 0)).toLocaleString("en-IN")}`;

/** "2026-09-04" -> "04 Sep 2026". Blank in, blank out — a missing date reads as a dash
 *  at the call site rather than as "Invalid Date". */
const prettyDate = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "");

const prettyMonth = (month) => (month
  ? new Date(`${month}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  : "");

const shiftMonth = (month, by) => {
  const d = new Date(`${month}-01T00:00:00`);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const todayIso = () => {
  // The browser's own day, which for everyone using this is the clinic's. The server has
  // its own answer (see clinic_today in backend/utils.py) and sends it down with the
  // register; this is only for capping the date picker before that reply lands.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const shiftDay = (iso, by) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

/** A figure with a caption, in the same shape as the Dashboard's KPI tiles so the three
 *  screens read as one board rather than three. Clickable only when there is somewhere
 *  for the click to go. */
const Stat = ({ label, value, tone = "text-slate-800", onClick, active, testid }) => {
  const Tag = onClick ? "button" : "div";
  return (
    // The stage-strip tile Branch Leads and HR Admin > Dashboard wear: white, borderless
    // until picked, label over figure and centred; the open one in light blue with a
    // chevron. It sits in a StatStrip tray -- see the grids that hold these.
    <Tag
      {...(onClick ? { type: "button", onClick } : {})}
      className={`relative w-full min-w-0 rounded-lg border-2 px-3 py-2.5 text-center transition-all duration-150 ${
        active
          ? "border-sky-400 bg-sky-50 shadow-[0_2px_8px_-2px_rgba(14,165,233,0.35)]"
          : "border-transparent bg-white"
      } ${onClick && !active ? "cursor-pointer hover:border-slate-200 hover:shadow-sm" : ""}`}
      data-testid={testid}
    >
      {active && <ChevronRight className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-sky-500" />}
      <span className={`block truncate px-2 text-xs font-semibold ${active ? "text-sky-700" : "text-slate-700"}`}>{label}</span>
      <span className={`mt-1 block text-xl font-bold leading-tight tabular-nums ${tone}`}>{value}</span>
    </Tag>
  );
};

const Empty = ({ children }) => (
  <p className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">{children}</p>
);

/** A column heading and its figure, stacked — one cell of a table read on a phone.
 *
 *  The registers here are eight and nine columns wide, and a column heading is what makes
 *  a figure mean something: "08:42" under nothing could be either end of the day. Behind a
 *  sideways swipe the heading is the first thing off the screen, so on a phone each cell
 *  carries its own. */
const Cell = ({ label, children, tone = "text-slate-700" }) => (
  <div className="min-w-0">
    <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
    <p className={`truncate font-semibold ${tone}`}>{children}</p>
  </div>
);


// ---------- filtering a roster ----------

// The three things a register is narrowed by. Fifty rows is more than anybody marks in
// one sitting, and whoever is filling it in is usually working one branch or one desk at
// a time.
//
// Held as data rather than three copies of the same markup so the bar, the option lists
// and the "showing N of M" line all read the same field names, and adding a fourth axis
// is one entry rather than four edits.
const ROSTER_FILTERS = [
  { key: "department", label: "Department", all: "All Departments" },
  { key: "designation", label: "Designation", all: "All Designations" },
  { key: "branch_name", label: "Branch", all: "All Branches" },
];

const NO_FILTERS = { department: "", designation: "", branch_name: "" };

// An employee with nothing in the field. A real option rather than a gap, because
// "who has no branch set" is a question somebody actually asks -- it is the list you work
// through to fix the records. Underscored so it cannot collide with a branch called
// "Unassigned".
const UNSET = "__unset__";
const UNSET_LABELS = { department: "No department", designation: "No designation", branch_name: "No branch" };

const fieldValue = (row, key) => String(row?.[key] || "").trim();
const matchesFilter = (row, key, want) => {
  if (!want) return true;
  const has = fieldValue(row, key);
  return want === UNSET ? !has : has === want;
};

/** Rows passing every filter except `except` — which is what each dropdown's own options
 *  are drawn from, so narrowing to a department leaves only the designations that
 *  department actually has, and a filter can never offer a choice that yields nothing. */
const narrow = (rows, filters, except) =>
  rows.filter((r) => ROSTER_FILTERS.every((f) => f.key === except || matchesFilter(r, f.key, filters[f.key])));

const optionsFor = (rows, filters, key) => {
  const scoped = narrow(rows, filters, key);
  const named = [...new Set(scoped.map((r) => fieldValue(r, key)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return scoped.some((r) => !fieldValue(r, key)) ? [...named, UNSET] : named;
};

/** The three dropdowns, plus a Clear that only appears once something is filtered.
 *
 *  Selects rather than pills: a clinic has more branches and far more designations than
 *  fit a row of chips, and a dropdown is the control that stays the same size as the
 *  lists grow. */
const RosterFilterBar = ({ rows, filters, onChange, shown, total, testid }) => {
  const active = ROSTER_FILTERS.filter((f) => filters[f.key]);
  // Two up on a phone rather than three across it: at a third of 360px "All Departments"
  // arrives as "All Depa…", and a filter nobody can read is a filter nobody sets. The
  // funnel goes with them -- it labels a row, and on a phone the row is a block.
  return (
    <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:w-auto sm:flex-wrap" data-testid={testid}>
      <Filter className="hidden h-4 w-4 shrink-0 text-slate-400 sm:block" />
      {ROSTER_FILTERS.map((f) => {
        const options = optionsFor(rows, filters, f.key);
        const value = filters[f.key];
        // A filter whose value has gone (the department it belonged to was deselected, or
        // nobody in the narrowed set has it) still renders its own value, so a selection
        // never silently disappears from the control while still applying to the list.
        const list = value && !options.includes(value) ? [...options, value] : options;
        return (
          <select
            key={f.key}
            value={value}
            onChange={(e) => onChange({ ...filters, [f.key]: e.target.value })}
            title={f.label}
            className={`h-9 w-full min-w-0 rounded-md border px-2 text-sm font-medium sm:w-auto sm:max-w-[190px] ${
              value ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600"
            }`}
            data-testid={`${testid}-${f.key}`}
          >
            <option value="">{f.all}</option>
            {list.map((o) => <option key={o} value={o}>{o === UNSET ? UNSET_LABELS[f.key] : o}</option>)}
          </select>
        );
      })}
      {active.length > 0 && (
        <>
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...NO_FILTERS })} data-testid={`${testid}-clear`}>
            <X className="h-4 w-4" />Clear
          </Button>
          <span className="col-span-2 text-xs font-medium text-slate-500 sm:col-span-1" data-testid={`${testid}-count`}>
            Showing {shown} of {total}
          </span>
        </>
      )}
    </div>
  );
};
// ---------- Attendance ----------

// Mirrors ATTENDANCE_STATUSES in backend/routers/v3_hr_ops.py. `lop` is repeated here
// only so the screen can say what a mark costs before it is saved; the figure payroll
// actually uses is the server's.
const MARKS = [
  { key: "present", short: "P", label: "Present", lop: 0, on: "bg-emerald-600 text-white border-emerald-600", off: "border-emerald-200 text-emerald-700 hover:bg-emerald-50" },
  { key: "late", short: "L", label: "Late", lop: 0, on: "bg-amber-500 text-white border-amber-500", off: "border-amber-200 text-amber-700 hover:bg-amber-50" },
  { key: "half_day", short: "½", label: "Half day", lop: 0.5, on: "bg-orange-500 text-white border-orange-500", off: "border-orange-200 text-orange-700 hover:bg-orange-50" },
  { key: "absent", short: "A", label: "Absent", lop: 1, on: "bg-rose-600 text-white border-rose-600", off: "border-rose-200 text-rose-700 hover:bg-rose-50" },
  { key: "leave", short: "LV", label: "Leave", lop: 0, on: "bg-sky-600 text-white border-sky-600", off: "border-sky-200 text-sky-700 hover:bg-sky-50" },
  { key: "week_off", short: "WO", label: "Week off", lop: 0, on: "bg-slate-600 text-white border-slate-600", off: "border-slate-200 text-slate-600 hover:bg-slate-50" },
  { key: "holiday", short: "H", label: "Holiday", lop: 0, on: "bg-violet-600 text-white border-violet-600", off: "border-violet-200 text-violet-700 hover:bg-violet-50" },
];
const MARK_BY_KEY = Object.fromEntries(MARKS.map((m) => [m.key, m]));
// The two marks where the clock matters. On the rest the time boxes are pointless — a
// week off has no check-in — so they are disabled rather than left open to be filled with
// something the register would then carry around meaninglessly.
const CLOCKED = new Set(["present", "late", "half_day"]);

/** The seven marks as one row of pills. Clicking the mark already set clears it, which is
 *  how a wrong entry is taken back — there is no separate "clear" control to hunt for. */
const MarkPicker = ({ value, disabled, onPick, testid }) => (
  <div className="flex flex-wrap items-center gap-1" data-testid={testid}>
    {MARKS.map((m) => {
      const on = value === m.key;
      return (
        <button
          key={m.key}
          type="button"
          disabled={disabled}
          title={disabled ? `${m.label} — locked by an approved request` : m.label}
          onClick={() => onPick(on ? "" : m.key)}
          className={`h-8 min-w-[34px] rounded-md border px-1.5 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 sm:h-7 sm:min-w-[28px] ${on ? m.on : `bg-white ${m.off}`}`}
          data-testid={`${testid}-${m.key}`}
        >
          {m.short}
        </button>
      );
    })}
  </div>
);

/** A typed time, for the detail panel's HR override. The register's own times come off
 *  the clock; this is for the day somebody left their phone at home. */
const TimeBox = ({ value, disabled, onChange, testid }) => (
  <input
    type="time"
    value={value || ""}
    disabled={disabled}
    onChange={(e) => onChange(e.target.value)}
    className="h-9 w-full min-w-0 rounded-md border border-slate-200 px-2 text-xs text-slate-700 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-300 disabled:bg-slate-50 disabled:text-slate-300 sm:h-8 sm:w-[104px]"
    data-testid={testid}
  />
);

// ---------- the board's own vocabulary ----------

// What a row can say about somebody's day. The first four come off the clock and are
// facts; the rest are HR's marks and are decisions. Mirrors _board_status in
// backend/routers/v3_hr_ops.py, which decides which of the two speaks for a given day.
const BOARD_STATUS = {
  working: { label: "Working", tone: "bg-sky-100 text-sky-700" },
  on_break: { label: "On break", tone: "bg-amber-100 text-amber-700" },
  done: { label: "Done", tone: "bg-emerald-100 text-emerald-700" },
  yet_to_login: { label: "Yet to login", tone: "bg-slate-100 text-slate-500" },
  present: { label: "Present", tone: "bg-emerald-100 text-emerald-700" },
  late: { label: "Late", tone: "bg-amber-100 text-amber-700" },
  half_day: { label: "Half day", tone: "bg-orange-100 text-orange-700" },
  absent: { label: "Absent", tone: "bg-rose-100 text-rose-700" },
  leave: { label: "Leave", tone: "bg-sky-100 text-sky-700" },
  week_off: { label: "Week off", tone: "bg-slate-100 text-slate-600" },
  holiday: { label: "Holiday", tone: "bg-violet-100 text-violet-700" },
};

/** A day's status, and whether anybody chose it.
 *
 *  The dot is the whole point of the control now that attendance is read off the clock
 *  rather than typed: a status with one was worked out from when this person pressed in and
 *  out, measured against their branch's working day, and it will move if either changes. A
 *  status without one is somebody's decision and will not. HR needs to be able to tell
 *  those apart at a glance, because the first is worth checking and the second is worth
 *  asking about.
 */
const StatusBadge = ({ status, auto }) => {
  const s = BOARD_STATUS[status] || BOARD_STATUS.yet_to_login;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${s.tone}`}
      title={auto ? "Read from the clock and this branch's working day" : "Set by hand — a decision, not a reading"}
    >
      {auto && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40" />}
      {s.label}
    </span>
  );
};

// The four spans, mirroring PERIODS in backend/routers/v3_hr_ops.py.
const PERIODS = [
  { key: "day", label: "Day" },
  { key: "range", label: "Range" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
];

/** The pill row that picks the span. Its own control rather than a select, because four
 *  choices that are switched between constantly should be one click, not two. */
const PeriodPicker = ({ value, onChange, testid }) => (
  <div className="grid w-full grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1 sm:flex sm:w-auto sm:items-center" data-testid={testid}>
    {PERIODS.map((p) => (
      <button
        key={p.key}
        type="button"
        onClick={() => onChange(p.key)}
        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition sm:px-3 sm:text-sm ${
          value === p.key ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
        }`}
        data-testid={`${testid}-${p.key}`}
      >
        {p.label}
      </button>
    ))}
  </div>
);

/** One person's day, opened from the row. Two things live here that are deliberately not
 *  in the table: the account of their breaks, and the only way to overrule what the clock
 *  says.
 *
 *  The marks used to be seven pills on every row, which put a control for the rare case —
 *  somebody's day needs correcting — in front of the common one, which is reading who is
 *  in. They are still reachable, still the same seven, and payroll still reads them; they
 *  are one click further away because that is how often they are wanted. */
const DayDetailModal = ({ row, date, onClose, onSaved }) => {
  const [status, setStatus] = useState(row.status && BOARD_STATUS[row.status] && MARK_BY_KEY[row.status] ? row.status : "");
  const [checkIn, setCheckIn] = useState(row.check_in || "");
  const [checkOut, setCheckOut] = useState(row.check_out || "");
  const [note, setNote] = useState(row.note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await hrMarkAttendance(date, [{
        employee_id: row.employee_id,
        status,
        check_in: CLOCKED.has(status) ? checkIn : "",
        check_out: CLOCKED.has(status) ? checkOut : "",
        note,
      }]);
      toast.success(`${row.full_name}'s day saved.`);
      onSaved();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  return (
    // A sheet off the bottom of a phone rather than a box floated in the middle of one:
    // centred, a panel this tall leaves a sliver of backdrop top and bottom and its
    // controls sit where a thumb cannot reach. From sm it is the dialog it always was.
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-h-[90vh] sm:rounded-2xl sm:p-5" onClick={(e) => e.stopPropagation()} data-testid="hr-att-detail">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <EmployeeAvatar employee={row} size={40} />
            <div className="min-w-0">
              <p className="truncate font-bold text-slate-800">{row.full_name}</p>
              <p className="truncate text-xs text-slate-400">
                {[row.employee_code, row.designation, row.department, row.branch_name].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-700" data-testid="hr-att-detail-close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Worked and away, not the span between the two presses. Check in and check out
            are both on the row already, so the gross figure was the one number here that
            could be read straight off the two beside it. */}
        <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5">
          <Stat label="Worked" value={hours(row.worked_minutes)} tone="text-emerald-600" testid="hr-att-detail-worked" />
          <Stat label="On break" value={duration(row.break_minutes)} tone="text-amber-600" testid="hr-att-detail-break" />
        </div>

        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Breaks</p>
          {(row.breaks || []).length === 0 ? (
            <p className="mt-1 text-sm text-slate-400">No breaks taken.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {row.breaks.map((b, i) => (
                <li key={i} className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-sm">
                  <span className="text-slate-700">{b.reason || "No reason given"}</span>
                  <span className="text-xs text-slate-500">
                    {prettyTime(b.out)} → {b.in ? prettyTime(b.in) : <span className="font-semibold text-amber-600">still out</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Between the breaks and the mark, which is where it belongs: it explains a gap
            in the day the way a break does, and it is the reason not to reach for
            "half day" on a person who was out for two hours with permission. */}
        {row.permission && (
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3" data-testid="hr-att-detail-permission">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-700">
              <Clock3 className="h-3.5 w-3.5" />Approved permission
            </p>
            <p className="mt-1 text-sm font-semibold text-sky-900">
              {prettyTime(row.permission.from)} → {prettyTime(row.permission.to)} · {duration(row.permission.minutes)}
            </p>
            {row.permission.reason && <p className="mt-0.5 text-xs text-sky-800">{row.permission.reason}</p>}
            <p className="mt-1 text-[11px] text-sky-700">
              Hours signed off on Approvals. The day is not marked by it — they were here for the rest of it.
            </p>
          </div>
        )}

        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">HR mark</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            The day is read off the clock against this branch&apos;s working day — set on
            <b> Branch &rarr; Management &rarr; Time Management</b>. Marking it here overrules that reading for this
            one day, and what you set stays set whatever the clock does afterwards.
          </p>
          {row.auto && row.status && (
            <p className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500" data-testid="hr-att-detail-derived">
              Currently reading as <b>{(BOARD_STATUS[row.status] || {}).label || row.status}</b> — nobody has marked this day.
            </p>
          )}
          {row.locked ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-2 text-xs text-sky-800">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              Set by an approved request — change it on Approvals.
            </p>
          ) : (
            <>
              <div className="mt-2">
                <MarkPicker value={status} onPick={setStatus} testid="hr-att-detail-mark" />
              </div>
              {CLOCKED.has(status) && (
                <div className="mt-2 flex items-center gap-2">
                  <TimeBox value={checkIn} onChange={setCheckIn} testid="hr-att-detail-in" />
                  <span className="text-xs text-slate-400">to</span>
                  <TimeBox value={checkOut} onChange={setCheckOut} testid="hr-att-detail-out" />
                </div>
              )}
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                className="mt-2"
                data-testid="hr-att-detail-note"
              />
            </>
          )}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {!row.locked && (
            <Button onClick={save} disabled={saving} data-testid="hr-att-detail-save">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// Who each summary card counts, and so who clicking it lists. The same tests the cards
// count with, so a card's figure and the length of its list always agree.
const CARD_MATCH = {
  present: (r) => r.present_days > 0,
  wfh: (r) => r.present_days > 0 && !!r.remote,
  yet: (r) => r.present_days === 0 && !["absent", "leave", "week_off", "holiday"].includes(r.status),
  away: (r) => r.away_days > 0,
  permission: (r) => r.permission_days > 0,
};

export const AttendanceTab = () => {
  const [period, setPeriod] = useState("day");
  const [day, setDay] = useState(todayIso());
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [year, setYear] = useState(todayIso().slice(0, 4));
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState(null);
  // Which summary card the list below is narrowed to. "total" is everyone the dropdowns
  // leave on screen.
  const [card, setCard] = useState("total");

  // Exactly the parameters the chosen span needs, so the server is never sent a month and
  // a range at once and left to guess which was meant.
  const params = useMemo(() => {
    if (period === "day") return { period, date: day };
    if (period === "range") return { period, from, to };
    if (period === "month") return { period, month };
    return { period, year };
  }, [period, day, from, to, month, year]);

  const load = useCallback((q) => {
    setLoading(true);
    return hrAttendanceOverview(q).then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(params); }, [params, load]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const shown = useMemo(() => narrow(rows, filters), [rows, filters]);
  const filtered = shown.length !== rows.length;
  const single = !!data?.single_day;
  const k = data?.kpis || {};

  // The tiles count what is on screen once a filter is up: narrowing to Marketing and
  // being told fifteen people work here answers a question nobody asked. Unfiltered they
  // are the server's own figures, which is the same set of rows counted the same way.
  const tiles = useMemo(() => {
    if (!filtered) return k;
    return {
      total_employees: shown.length,
      present_working: shown.filter(CARD_MATCH.present).length,
      work_from_home: shown.filter(CARD_MATCH.wfh).length,
      absent_leave: shown.filter(CARD_MATCH.away).length,
      on_permission: shown.filter(CARD_MATCH.permission).length,
      yet_to_login: single ? shown.filter(CARD_MATCH.yet).length : null,
    };
  }, [filtered, k, shown, single]);

  // Yet to Login is a single-day card; over a span it is not drawn, so it cannot stay the
  // filter either.
  const activeCard = card === "yet" && !single ? "total" : card;
  // The list under the cards: the dropdowns' rows, narrowed to the card picked. The cards
  // themselves keep counting the dropdowns' rows, so every figure stays readable while one
  // of them is open.
  const listed = useMemo(
    () => (activeCard === "total" ? shown : shown.filter(CARD_MATCH[activeCard])),
    [shown, activeCard],
  );
  // Pressing the open card again puts the list back to everyone.
  const pickCard = (key) => setCard((c) => (c === key ? "total" : key));
  const emptyText = activeCard !== "total"
    ? "Nobody on this card."
    : filtered ? "Nobody matches these filters." : "No active employees.";

  // Period, date, filters and Refresh share one row; it wraps only when the screen is too
  // narrow to hold them.
  return (
    <div className="space-y-4" data-testid="hr-attendance-tab">
      <Card>
        <CardContent className="flex flex-col gap-2 p-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:p-3">
          <PeriodPicker value={period} onChange={setPeriod} testid="hr-att-period" />

          {period === "day" && (
            <div className="w-full sm:w-[170px]">
              <MilkDateInput value={day} max={data?.today || todayIso()} accent="sky" iconLeft onChange={(e) => setDay(e.target.value)} data-testid="hr-att-date" />
            </div>
          )}
          {period === "range" && (
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="w-full min-w-0 sm:w-[160px]">
                <MilkDateInput value={from} max={data?.today || todayIso()} accent="sky" iconLeft onChange={(e) => setFrom(e.target.value)} data-testid="hr-att-from" />
              </div>
              <span className="text-xs text-slate-400">to</span>
              <div className="w-full min-w-0 sm:w-[160px]">
                <MilkDateInput value={to} min={from} max={data?.today || todayIso()} accent="sky" iconLeft onChange={(e) => setTo(e.target.value)} data-testid="hr-att-to" />
              </div>
            </div>
          )}
          {period === "month" && (
            <div className="flex w-full items-center justify-center gap-1 sm:w-auto">
              <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} title="Previous month" data-testid="hr-att-month-prev">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[140px] flex-1 text-center text-sm font-semibold text-slate-800 sm:flex-none" data-testid="hr-att-month">{prettyMonth(month)}</span>
              <Button
                variant="outline"
                size="icon"
                disabled={month >= todayIso().slice(0, 7)}
                onClick={() => setMonth(shiftMonth(month, 1))}
                title="Next month"
                data-testid="hr-att-month-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          {period === "year" && (
            <div className="flex w-full items-center justify-center gap-1 sm:w-auto">
              <Button variant="outline" size="icon" onClick={() => setYear(String(Number(year) - 1))} title="Previous year" data-testid="hr-att-year-prev">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[80px] flex-1 text-center text-sm font-semibold text-slate-800 sm:flex-none" data-testid="hr-att-year">{year}</span>
              <Button
                variant="outline"
                size="icon"
                disabled={year >= todayIso().slice(0, 4)}
                onClick={() => setYear(String(Number(year) + 1))}
                title="Next year"
                data-testid="hr-att-year-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          <RosterFilterBar
            rows={rows}
            filters={filters}
            onChange={setFilters}
            shown={shown.length}
            total={rows.length}
            testid="hr-att-filters"
          />

          <Button
            size="sm"
            onClick={() => load(params)}
            disabled={loading}
            className="w-full border border-slate-200 bg-slate-100 text-slate-700 shadow-none hover:bg-slate-200 sm:ml-auto sm:w-auto"
            data-testid="hr-att-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </CardContent>
      </Card>

      <div className={`grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5 ${single ? "lg:grid-cols-6" : "lg:grid-cols-5"}`}>
        <Stat label="Total Employees" value={tiles.total_employees ?? 0} tone="text-indigo-600" onClick={() => setCard("total")} active={activeCard === "total"} testid="hr-att-k-total" />
        <Stat label={single ? "Present / Working" : "Worked at all"} value={tiles.present_working ?? 0} tone="text-emerald-600" onClick={() => pickCard("present")} active={activeCard === "present"} testid="hr-att-k-present" />
        <Stat label="Work from Home" value={tiles.work_from_home ?? 0} tone="text-violet-600" onClick={() => pickCard("wfh")} active={activeCard === "wfh"} testid="hr-att-k-wfh" />
        {single && <Stat label="Yet to Login" value={tiles.yet_to_login ?? 0} tone="text-amber-500" onClick={() => pickCard("yet")} active={activeCard === "yet"} testid="hr-att-k-yet" />}
        <Stat label="Absent / Leave" value={tiles.absent_leave ?? 0} tone="text-rose-600" onClick={() => pickCard("away")} active={activeCard === "away"} testid="hr-att-k-away" />
        {/* Its own tile because it is the one figure here that is neither present nor
            away: an approved permission is somebody who came in and had agreed hours out
            of the middle of it, and folding it into either of the two beside it would say
            something about their day that is not true. */}
        <Stat label="On Permission" value={tiles.on_permission ?? 0} tone="text-sky-600" onClick={() => pickCard("permission")} active={activeCard === "permission"} testid="hr-att-k-permission" />
      </div>

      {loading && !data ? <p className="text-sm text-slate-500">Loading...</p> : (
        <>
        {/* Phones: one card per person. The register is eight columns wide and a row of it
            is only useful read whole -- a status means nothing without the two times
            beside it -- so behind a sideways swipe somebody sees a name and half a
            department. The same rows, the same figures, stacked. */}
        <div className="space-y-2 md:hidden" data-testid="hr-att-cards">
          {listed.map((r) => {
            // On a single day the card opens that person's day, as the eye does on the
            // table. Over a span there is no one day to open, so it is not a button.
            const openDay = single ? () => setOpened(r) : null;
            return (
              <div
                key={r.employee_id}
                role={openDay ? "button" : undefined}
                tabIndex={openDay ? 0 : undefined}
                onClick={openDay || undefined}
                onKeyDown={openDay ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDay(); } } : undefined}
                className={`rounded-xl border border-slate-200 bg-white p-3 ${openDay ? "cursor-pointer active:bg-slate-50" : ""}`}
                data-testid={`hr-att-card-${r.employee_id}`}
              >
                <div className="flex items-start gap-3">
                  <EmployeeAvatar employee={r} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-800">{r.full_name}</p>
                    <p className="truncate text-xs text-slate-400">
                      {[r.designation || r.employee_code, r.department, r.branch_name].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {single && <StatusBadge status={r.status} auto={r.auto} />}
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2 text-xs">
                  {single ? (
                    <>
                      <Cell label="Check in">{r.check_in ? prettyTime(r.check_in) : "—"}</Cell>
                      <Cell label="Check out">{r.check_out ? prettyTime(r.check_out) : "—"}</Cell>
                    </>
                  ) : (
                    <>
                      <Cell label="Days present">{r.present_days}</Cell>
                      <Cell label="Days away" tone={r.away_days ? "text-rose-600" : "text-slate-400"}>{r.away_days}</Cell>
                    </>
                  )}
                  <Cell label="Worked" tone="text-slate-800">{hours(r.worked_minutes)}</Cell>
                </div>

                {(r.break_minutes > 0 || r.permission_days > 0 || openDay) && (
                  <div className="mt-2 flex items-center gap-x-3 gap-y-1 text-[11px]">
                    {r.break_minutes > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-violet-600">
                        <Coffee className="h-3.5 w-3.5 shrink-0" />
                        <span className="font-semibold">{duration(r.break_minutes)}</span>
                        <span className="text-slate-400">({r.break_count})</span>
                      </span>
                    )}
                    {r.permission_days > 0 && (
                      <span className="inline-flex min-w-0 items-center gap-1 text-sky-600" data-testid={`hr-att-card-permission-${r.employee_id}`}>
                        <Clock3 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate font-semibold">
                          {duration(r.permission_minutes)} permission
                          {!single && r.permission_days > 1 ? ` (${r.permission_days}d)` : ""}
                        </span>
                      </span>
                    )}
                    {openDay && <Eye className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-300" />}
                  </div>
                )}
              </div>
            );
          })}
          {listed.length === 0 && (
            <Empty>{emptyText}</Empty>
          )}
        </div>

        <Card className="hidden overflow-hidden md:block">
          <CardContent className="p-0">
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-700 text-left text-[11px] uppercase tracking-wide text-white">
                  <tr>
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Department</th>
                    {single ? (
                      <>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Check In</th>
                        <th className="px-4 py-3">Check Out</th>
                      </>
                    ) : (
                      <>
                        <th className="px-4 py-3 text-right">Days Present</th>
                        <th className="px-4 py-3 text-right">Days Away</th>
                      </>
                    )}
                    <th className="px-4 py-3 text-right">Worked Hours</th>
                    <th className="px-4 py-3">Break Time</th>
                    {single && <th className="px-4 py-3 text-center">Details</th>}
                  </tr>
                </thead>
                <tbody>
                  {listed.map((r) => (
                    <tr key={r.employee_id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`hr-att-row-${r.employee_id}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <EmployeeAvatar employee={r} size={36} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-800">{r.full_name}</p>
                            <p className="truncate text-xs text-slate-400">{r.designation || r.employee_code}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.department || "—"}
                        {r.branch_name && <span className="block text-xs text-slate-400">{r.branch_name}</span>}
                      </td>
                      {single ? (
                        <>
                          <td className="px-4 py-3"><StatusBadge status={r.status} auto={r.auto} /></td>
                          <td className="px-4 py-3 text-slate-700">{r.check_in ? prettyTime(r.check_in) : "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{r.check_out ? prettyTime(r.check_out) : "—"}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-right font-semibold text-slate-700">{r.present_days}</td>
                          <td className={`px-4 py-3 text-right ${r.away_days ? "font-semibold text-rose-600" : "text-slate-400"}`}>{r.away_days}</td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right font-semibold text-slate-800">{hours(r.worked_minutes)}</td>
                      <td className="px-4 py-3">
                        {r.break_minutes > 0 ? (
                          <span className="inline-flex items-center gap-1 text-violet-600" title={`${r.break_count} break${r.break_count === 1 ? "" : "s"}`}>
                            <Coffee className="h-3.5 w-3.5" />
                            <span className="font-medium">{duration(r.break_minutes)}</span>
                            <span className="text-[11px] text-slate-400">({r.break_count})</span>
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                        {/* Beside the breaks rather than in a column of its own: both are
                            time out of a working day, and the only difference between a
                            break and a permission is that somebody signed off the second.
                            Which is what the chip says — the hours, and that they were
                            agreed. */}
                        {r.permission_days > 0 && (
                          <span
                            className="mt-1 flex items-center gap-1 text-sky-600"
                            title={single && r.permission
                              ? `${prettyTime(r.permission.from)} → ${prettyTime(r.permission.to)}${r.permission.reason ? ` · ${r.permission.reason}` : ""}`
                              : `${r.permission_days} day${r.permission_days === 1 ? "" : "s"} with approved permission`}
                            data-testid={`hr-att-permission-${r.employee_id}`}
                          >
                            <Clock3 className="h-3.5 w-3.5 shrink-0" />
                            <span className="text-[11px] font-semibold">
                              {duration(r.permission_minutes)} permission
                              {!single && r.permission_days > 1 ? ` (${r.permission_days}d)` : ""}
                            </span>
                          </span>
                        )}
                      </td>
                      {single && (
                        <td className="px-4 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => setOpened(r)}
                            title={`Open ${r.full_name}'s day`}
                            className="text-slate-400 transition hover:text-sky-600"
                            data-testid={`hr-att-open-${r.employee_id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {listed.length === 0 && (
                    <tr>
                      <td colSpan={single ? 8 : 6} className="px-4 py-10 text-center text-slate-400">
                        {emptyText}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        </>
      )}

      {opened && (
        <DayDetailModal
          row={opened}
          date={data?.from}
          onClose={() => setOpened(null)}
          onSaved={() => { setOpened(null); load(params); }}
        />
      )}
    </div>
  );
};
// ---------- Payroll ----------

const RUN_TONE = {
  draft: "bg-amber-100 text-amber-700",
  finalised: "bg-sky-100 text-sky-700",
  paid: "bg-emerald-100 text-emerald-700",
};

/** A rupee figure typed against one payslip line, saved when the box is left rather than
 *  on every keystroke — a PATCH per digit would be a request per digit. */
const AmountBox = ({ value, disabled, onCommit, testid }) => {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => { setText(String(value ?? 0)); }, [value]);
  return (
    <input
      value={text}
      disabled={disabled}
      inputMode="numeric"
      onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
      onBlur={() => {
        const n = Number(text || 0);
        if (Number.isNaN(n) || n === Number(value ?? 0)) { setText(String(value ?? 0)); return; }
        onCommit(n);
      }}
      className="h-8 w-24 rounded-md border border-slate-200 px-2 text-right text-xs outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-300 disabled:bg-slate-50 disabled:text-slate-400"
      data-testid={testid}
    />
  );
};

/**
 * The lanes a payslip can be sitting in, left to right in the order somebody signing off
 * a run works through them: what cannot be paid at all, what nobody has checked, what the
 * register has already docked, what HR has moved by hand, and what needs no further
 * thought.
 *
 * A slip belongs to the first lane that claims it, so a line with unmarked days *and* a
 * bonus reads as unverified rather than as done — the unchecked half is the half worth
 * showing. The lanes are read off the slip rather than stored on it, which is why nothing
 * drags between them: a card leaves "Loss of pay" when the register changes or a figure
 * is typed, not when somebody drops it somewhere else. Dragging one by hand would be
 * claiming something about the month that the month does not say.
 */
const PAY_LANES = [
  {
    key: "no_base",
    label: "No pay set",
    hint: "No salary on the employee record, so there is nothing to pro-rate.",
    tone: "border-slate-300 bg-slate-100",
    dot: "bg-slate-400",
    match: (s) => Number(s.base || 0) <= 0,
  },
  {
    key: "unverified",
    label: "Unverified days",
    hint: "Days nobody marked. They are paid in full until Attendance says otherwise.",
    tone: "border-amber-200 bg-amber-50",
    dot: "bg-amber-400",
    match: (s) => Number(s.unmarked_days || 0) > 0,
  },
  {
    key: "lop",
    label: "Loss of pay",
    hint: "Pro-rated down by the register — worth a look before the run is finalised.",
    tone: "border-rose-200 bg-rose-50",
    dot: "bg-rose-400",
    match: (s) => Number(s.lop_days || 0) > 0,
  },
  {
    key: "adjusted",
    label: "Adjusted by hand",
    hint: "A bonus or a deduction has been typed against these.",
    tone: "border-violet-200 bg-violet-50",
    dot: "bg-violet-400",
    match: (s) => Number(s.bonus || 0) > 0 || Number(s.deduction || 0) > 0,
  },
  {
    key: "ready",
    label: "Full month",
    hint: "Marked all month, nothing added and nothing taken away.",
    tone: "border-emerald-200 bg-emerald-50",
    dot: "bg-emerald-400",
    match: () => true,
  },
];

// The last lane matches everything, so this never falls through.
const laneOf = (slip) => PAY_LANES.find((l) => l.match(slip));

/** One employee's month as a card: who they are, what the register produced, and the two
 *  figures a human is allowed to move. The sum is shown as a sum — earned, bonus,
 *  deduction, net — because on a card there is no column heading to say where the last
 *  number came from. */
const PayslipCard = ({ slip: s, editable, onAdjust, onOpen }) => (
  // The whole card opens the person. A div rather than a button because the two boxes
  // below take a figure each, and an input inside a button is markup no browser is
  // obliged to make sense of — so it carries the button's keyboard behaviour by hand
  // instead, and the boxes stop the click before it gets here.
  <div
    role="button"
    tabIndex={0}
    onClick={() => onOpen?.(s)}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(s); }
    }}
    className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-sky-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    data-testid={`hr-pay-kanban-card-${s.employee_id}`}
  >
    <div className="flex items-start gap-2" data-testid={`hr-pay-open-${s.employee_id}`}>
      <EmployeeAvatar employee={{ full_name: s.employee_name }} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-800">{s.employee_name}</p>
        <p className="truncate text-[11px] text-slate-400">
          {s.employee_code}{s.department ? ` · ${s.department}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-sm font-extrabold text-sky-700">{money(s.net_payable)}</span>
    </div>

    <div className="mt-2 flex flex-wrap gap-1">
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600" title={`From the employee record's ${s.base_from}`}>
        Base {money(s.base)}
      </span>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
        {s.payable_days}/{s.days_in_month} days
      </span>
      {s.lop_days > 0 && (
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">LOP {s.lop_days}</span>
      )}
      {s.unmarked_days > 0 && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700" title={`${s.unmarked_days} days unmarked, paid in full`}>
          {s.unmarked_days} unmarked
        </span>
      )}
    </div>

    <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-slate-500">Earned</span>
        <span className="font-medium text-slate-700">{money(s.earned)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-500">Bonus</span>
        {editable
          ? (
            // Typing a bonus is not asking for the salary dialog. Only the box swallows
            // the click — the word beside it still opens the person, like the rest of the card.
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
              <AmountBox value={s.bonus} onCommit={(n) => onAdjust(s.employee_id, { bonus: n })} testid={`hr-pay-bonus-${s.employee_id}`} />
            </span>
          )
          : <span className={s.bonus ? "font-medium text-emerald-600" : "text-slate-400"}>{money(s.bonus)}</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-500">Deduction</span>
        {editable
          ? (
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
              <AmountBox value={s.deduction} onCommit={(n) => onAdjust(s.employee_id, { deduction: n })} testid={`hr-pay-ded-${s.employee_id}`} />
            </span>
          )
          : <span className={s.deduction ? "font-medium text-rose-600" : "text-slate-400"}>{money(s.deduction)}</span>}
      </div>
    </div>
  </div>
);

/** The month, one lane at a time.
 *
 *  Five columns side by side gave every lane a fifth of the width and none of them enough:
 *  a card had to wrap a name onto two lines, four of the five columns were usually empty,
 *  and the one with everybody in it scrolled inside a strip 280px wide. The lanes are the
 *  same five and mean the same thing — this is which of them is on screen, not how many
 *  there are.
 *
 *  Opens on the first lane with anybody in it, and stops choosing the moment somebody
 *  clicks: a screen that keeps moving you to whichever tab has work on it is one you
 *  cannot stand still in.
 */
// eslint-disable-next-line no-unused-vars -- kept for reference; Payroll now always renders the list.
const PayrollBoard = ({ slips, editable, onAdjust, onOpen }) => {
  const lanes = useMemo(() => {
    const out = Object.fromEntries(PAY_LANES.map((l) => [l.key, []]));
    for (const s of slips) out[laneOf(s).key].push(s);
    return out;
  }, [slips]);

  const [lane, setLane] = useState(PAY_LANES[0].key);
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current) return;
    const first = PAY_LANES.find((l) => (lanes[l.key] || []).length > 0);
    if (first) setLane(first.key);
  }, [lanes]);

  const current = PAY_LANES.find((l) => l.key === lane) || PAY_LANES[0];
  const cards = lanes[current.key] || [];
  const net = cards.reduce((t, s) => t + Number(s.net_payable || 0), 0);

  return (
    <div className="space-y-3">
      {/* The one rule the whole screen is downstream of. It lived in the table header;
          without it here a pro-rated figure looks like an arithmetic mistake. */}
      <p className="text-xs text-slate-500">
        Pay is pro-rated on calendar days: a day of loss of pay costs base ÷ days in month. Bonuses and deductions are editable while the run is a draft.
      </p>

      {/* Across the whole width rather than packed to the left. Five tabs sitting in the
          first third of a wide screen read as a leftover row of chips; stretched, they
          read as the five compartments the month is actually divided into. Two up on a
          phone and three on a tablet, because five across a narrow screen is five
          truncated words. */}
      <div className="grid grid-cols-2 gap-1.5 border-b border-slate-200 pb-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="hr-pay-lane-tabs">
        {PAY_LANES.map((l) => {
          const on = l.key === lane;
          const count = (lanes[l.key] || []).length;
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => { picked.current = true; setLane(l.key); }}
              aria-pressed={on}
              className={`flex w-full items-center justify-between gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition ${
                on ? `${l.tone} border-transparent text-slate-800 shadow-sm` : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
              }`}
              data-testid={`hr-pay-lane-${l.key}`}
            >
              {/* The dot and the words are one thing and the count is the other, so the
                  count sits at the far edge of a stretched tab instead of floating in
                  the middle of it. */}
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${l.dot}`} />
                <span className="truncate">{l.label}</span>
              </span>
              <span className={`shrink-0 rounded-full px-1.5 text-[10px] font-bold ${on ? "bg-white/70 text-slate-700" : "bg-slate-100 text-slate-500"}`} data-testid={`hr-pay-lane-count-${l.key}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] leading-snug text-slate-500">{current.hint}</p>
        <p className="text-[11px] font-bold text-slate-600">{money(net)} net</p>
      </div>

      {cards.length === 0 ? (
        <Empty>Nobody here.</Empty>
      ) : (
        // Two or three across instead of five, so a name fits on one line and a card can
        // carry the sum being made without being a column of its own.
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid={`hr-pay-lane-list-${current.key}`}>
          {cards.map((s) => (
            <PayslipCard key={s.employee_id} slip={s} editable={editable} onAdjust={onAdjust} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
};

// The colours a reason chip comes in, written out. The server sends a colour NAME because
// Tailwind builds its stylesheet from what it can see in this source tree: a class string
// assembled on the server reaches a browser that has never heard of it, and the chip
// arrives unstyled. So the names are the contract and the literals live here.
const REASON_TONES = {
  slate: "bg-slate-100 text-slate-700",
  emerald: "bg-emerald-100 text-emerald-700",
  violet: "bg-violet-100 text-violet-700",
  amber: "bg-amber-100 text-amber-700",
  purple: "bg-purple-100 text-purple-700",
  pink: "bg-pink-100 text-pink-700",
  teal: "bg-teal-100 text-teal-700",
  sky: "bg-sky-100 text-sky-700",
  indigo: "bg-indigo-100 text-indigo-700",
  lime: "bg-lime-100 text-lime-700",
  rose: "bg-rose-100 text-rose-700",
  cyan: "bg-cyan-100 text-cyan-700",
  orange: "bg-orange-100 text-orange-700",
};
const toneOf = (reason) => REASON_TONES[reason?.tone] || REASON_TONES.slate;

/** "2026-07" -> "Jul 2026". A record stands from a month, not from a day: nobody is put on
 *  a new salary from the 14th, and a date picker asking for one invites a precision the
 *  payroll does not have. */
const prettyRecordMonth = (month) => (month
  ? new Date(`${month}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" })
  : "—");

const monthsLabel = (n, current) => {
  const word = n === 1 ? "1 month" : `${n} months`;
  return current ? `${word} (current)` : word;
};

/** Putting somebody on a figure, from a month, for a reason.
 *
 *  The reason list is the clinic's own and grows from here: "+ Add new reason" writes a
 *  ninth beside the eight rather than sending whoever needed it to a settings screen they
 *  would have to find.
 */
const AddRecordModal = ({ employeeId, reasons, onClose, onSaved, onReasonAdded }) => {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(reasons[0]?.key || "");
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [newReason, setNewReason] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!amount) { toast.error("What are they on?"); return; }
    if (!reason) { toast.error("Pick a reason"); return; }
    setSaving(true);
    try {
      await hrAddSalaryRecord(employeeId, {
        amount: Number(amount), reason, effective_from: month, note: note.trim(),
      });
      toast.success("Record added.");
      onSaved();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const addReason = async () => {
    const label = newReason.trim();
    if (!label) { toast.error("Give the reason a name"); return; }
    setSaving(true);
    try {
      const res = await hrAddSalaryReason({ label, description: newDesc.trim() });
      await onReasonAdded();
      setReason(res.reason.key);
      setNewReason(""); setNewDesc(""); setAdding(false);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-md overflow-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-h-none sm:rounded-2xl sm:p-5" onClick={(e) => e.stopPropagation()} data-testid="hr-pay-add-record">
        <div className="flex items-start justify-between gap-3">
          <p className="font-bold text-slate-800">Add salary record</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="hr-pay-add-record-close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500" htmlFor="hr-pay-rec-month">Effective from</label>
            <input
              id="hr-pay-rec-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
              data-testid="hr-pay-rec-month"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500" htmlFor="hr-pay-rec-amount">Amount</label>
            <div className="mt-1 flex items-center gap-1 rounded-lg border border-slate-200 px-2 focus-within:border-sky-400 focus-within:ring-1 focus-within:ring-sky-300">
              <span className="text-sm text-slate-400">₹</span>
              <input
                id="hr-pay-rec-amount"
                value={amount}
                inputMode="numeric"
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="h-9 w-full bg-transparent text-sm font-semibold text-slate-800 outline-none"
                data-testid="hr-pay-rec-amount"
              />
            </div>
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500" htmlFor="hr-pay-rec-reason">Reason</label>
          {adding ? (
            <div className="mt-1 space-y-2 rounded-lg border border-sky-200 bg-sky-50/60 p-2">
              <Input value={newReason} onChange={(e) => setNewReason(e.target.value.slice(0, 40))} placeholder="Name, e.g. Retention" data-testid="hr-pay-new-reason" />
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value.slice(0, 120))} placeholder="What it means (optional)" data-testid="hr-pay-new-reason-desc" />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
                <Button size="sm" disabled={saving} onClick={addReason} data-testid="hr-pay-new-reason-save">Add reason</Button>
              </div>
            </div>
          ) : (
            <select
              id="hr-pay-rec-reason"
              value={reason}
              onChange={(e) => {
                if (e.target.value === "__add__") { setAdding(true); return; }
                setReason(e.target.value);
              }}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
              data-testid="hr-pay-rec-reason"
            >
              {reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              <option value="__add__">+ Add new reason…</option>
            </select>
          )}
        </div>

        <div className="mt-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500" htmlFor="hr-pay-rec-note">Note</label>
          <Input id="hr-pay-rec-note" className="mt-1" value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="Optional" data-testid="hr-pay-rec-note" />
        </div>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={saving || adding} onClick={save} data-testid="hr-pay-rec-save">
            <Check className="h-4 w-4" />{saving ? "Saving…" : "Add record"}
          </Button>
        </div>
      </div>
    </div>
  );
};

/** One employee's pay, as a page of its own.
 *
 *  Two tabs, because there are two questions: what this month comes to, and what this
 *  person has been on. The second is a timeline — every figure they have been put on, from
 *  when, and what each one changed — rather than a log of edits, so "what were they paid
 *  in March" has an answer that does not depend on replaying anything.
 *
 *  Full-bleed over the board rather than a route: the payroll month behind it is state
 *  somebody spent clicks getting to, and coming back to the top of an empty board is what
 *  making this a URL would cost.
 */
const EmployeePayPage = ({ slip, onClose, onSaved }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("history");
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return hrEmployeeSalary(slip.employee_id).then(setData).catch(fail).finally(() => setLoading(false));
  }, [slip.employee_id]);
  useEffect(() => { load(); }, [load]);

  // Escape closes it. A full-bleed page with one way out is one somebody feels stuck in.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const records = data?.records || [];
  const income = data?.income || [];
  const reasons = data?.reasons || [];
  const totals = data?.totals || {};
  const reasonBy = Object.fromEntries(reasons.map((r) => [r.key, r]));

  const removeRecord = async (id) => {
    try {
      await hrDeleteSalaryRecord(slip.employee_id, id);
      toast.success("Record removed.");
      await load();
      onSaved?.();
    } catch (e) { fail(e); }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50" data-testid="hr-pay-employee-page">
      <div className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100" aria-label="Back to payroll" data-testid="hr-pay-employee-back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          {/* The avatar is the one thing here a phone can spare: the name, the desk and
              the figure all have to be read, and it is a coloured initial. */}
          <span className="hidden sm:block"><EmployeeAvatar employee={{ full_name: slip.employee_name }} size={44} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-800">{slip.employee_name}</h2>
            <p className="truncate text-xs text-slate-500">{slip.designation || slip.department || ""}</p>
            {data?.email && <p className="truncate text-xs text-slate-400">{data.email}</p>}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Current salary</p>
            <p className="text-base font-extrabold text-emerald-600 sm:text-lg" data-testid="hr-pay-current-salary">{money(totals.current ?? slip.base)}</p>
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-5xl gap-1.5 px-3 pb-2 sm:px-6" data-testid="hr-pay-emp-tabs">
          {[
            { key: "payslip", label: "Salary / Payslip", icon: Wallet },
            { key: "history", label: "Salary History", icon: Clock3 },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  tab === t.key ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100"
                }`}
                data-testid={`hr-pay-emp-tab-${t.key}`}
              >
                <Icon className="h-3.5 w-3.5" />{t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-4 px-3 py-4 sm:px-6 sm:py-5">
          {loading ? <p className="py-10 text-center text-sm text-slate-400">Loading…</p> : tab === "payslip" ? (
            <>
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">This month</p>
                <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label="Base" value={money(slip.base)} testid="hr-pay-emp-base" />
                  <Stat label="Payable days" value={`${slip.payable_days}/${slip.days_in_month}`} testid="hr-pay-emp-days" />
                  <Stat label="LOP days" value={slip.lop_days} tone={slip.lop_days > 0 ? "text-rose-600" : "text-slate-800"} testid="hr-pay-emp-lop" />
                  <Stat label="Earned" value={money(slip.earned)} testid="hr-pay-emp-earned" />
                  <Stat label="Bonus" value={money(slip.bonus)} tone="text-emerald-600" testid="hr-pay-emp-bonus" />
                  <Stat label="Net payable" value={money(slip.net_payable)} tone="text-sky-700" testid="hr-pay-emp-net" />
                </div>
              </div>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Every month paid</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {income.length === 0 ? (
                    <p className="py-10 text-center text-xs text-slate-400" data-testid="hr-pay-income-empty">
                      No month has been generated for them yet.
                    </p>
                  ) : (
                    <>
                    {/* Nine columns of figures is the one table here that cannot be
                        swiped: the net is the last of them, and it is the column a month
                        gets looked up for. So on a phone each month is a card with its
                        net at the top. */}
                    <div className="space-y-2 p-3 lg:hidden" data-testid="hr-pay-income-cards">
                      {income.map((m) => (
                        <div key={m.month} className="rounded-xl border border-slate-200 p-3" data-testid={`hr-pay-income-card-${m.month}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-700">{prettyMonth(m.month)}</p>
                              <p className="text-[11px] text-slate-400">Base {money(m.base)} · {m.payable_days}/{m.days_in_month} days</p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-sm font-extrabold text-sky-700">{money(m.net_payable)}</p>
                              <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${RUN_TONE[m.status] || "bg-slate-100 text-slate-500"}`}>
                                {m.status || "—"}
                              </span>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11px]">
                            <span className="text-slate-600">Earned {money(m.earned)}</span>
                            {Number(m.lop_days) > 0 && <span className="font-semibold text-rose-600">LOP {m.lop_days}</span>}
                            {Number(m.bonus) > 0 && <span className="font-semibold text-emerald-600">+{money(m.bonus)}</span>}
                            {Number(m.deduction) > 0 && <span className="font-semibold text-rose-600">−{money(m.deduction)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="hidden overflow-x-auto lg:block">
                      <table className="min-w-full text-sm" data-testid="hr-pay-income-history">
                        <thead className="bg-slate-700 text-left text-xs uppercase tracking-wide text-white">
                          <tr>
                            <th className="px-3 py-2">Month</th>
                            <th className="px-3 py-2 text-right">Base</th>
                            <th className="px-3 py-2 text-right">Days</th>
                            <th className="px-3 py-2 text-right">LOP</th>
                            <th className="px-3 py-2 text-right">Earned</th>
                            <th className="px-3 py-2 text-right">Bonus</th>
                            <th className="px-3 py-2 text-right">Deduction</th>
                            <th className="px-3 py-2 text-right">Net</th>
                            <th className="px-3 py-2">Run</th>
                          </tr>
                        </thead>
                        <tbody>
                          {income.map((m) => (
                            <tr key={m.month} className="border-t border-slate-100">
                              <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">{prettyMonth(m.month)}</td>
                              <td className="px-3 py-2 text-right text-slate-600">{money(m.base)}</td>
                              <td className="whitespace-nowrap px-3 py-2 text-right text-slate-600">{m.payable_days}<span className="text-slate-400">/{m.days_in_month}</span></td>
                              <td className={`px-3 py-2 text-right ${Number(m.lop_days) > 0 ? "font-semibold text-rose-600" : "text-slate-400"}`}>{m.lop_days}</td>
                              <td className="px-3 py-2 text-right text-slate-700">{money(m.earned)}</td>
                              <td className={`px-3 py-2 text-right ${Number(m.bonus) > 0 ? "text-emerald-600" : "text-slate-400"}`}>{money(m.bonus)}</td>
                              <td className={`px-3 py-2 text-right ${Number(m.deduction) > 0 ? "text-rose-600" : "text-slate-400"}`}>{money(m.deduction)}</td>
                              <td className="px-3 py-2 text-right font-bold text-sky-700">{money(m.net_payable)}</td>
                              <td className="px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${RUN_TONE[m.status] || "bg-slate-100 text-slate-500"}`}>
                                  {m.status || "—"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5 lg:grid-cols-4">
                <Stat label="Current salary" value={money(totals.current)} tone="text-emerald-600" testid="hr-pay-t-current" />
                {/* The raises, not the records: the figure somebody joined on is not a hike. */}
                <Stat label="Total hikes" value={totals.hikes ?? 0} tone="text-indigo-600" testid="hr-pay-t-hikes" />
                <Stat label="Initial salary" value={money(totals.initial)} tone="text-amber-600" testid="hr-pay-t-initial" />
                <Stat
                  label="Total growth"
                  value={totals.growth === null || totals.growth === undefined ? "—" : `${totals.growth > 0 ? "+" : ""}${totals.growth}%`}
                  tone="text-violet-600"
                  testid="hr-pay-t-growth"
                />
              </div>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                  <CardTitle className="text-base">Salary history</CardTitle>
                  <Button size="sm" onClick={() => setAdding(true)} data-testid="hr-pay-add-record-open">
                    <Plus className="h-4 w-4" />Add record
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  {records.length === 0 ? (
                    <p className="py-10 text-center text-xs text-slate-400" data-testid="hr-pay-records-empty">
                      Nothing on record. Add what they joined on to start the timeline.
                    </p>
                  ) : (
                    <>
                    {/* Newest first here too, and the number still counts from the figure
                        they joined on. */}
                    <div className="space-y-2 p-3 lg:hidden" data-testid="hr-pay-record-cards">
                      {[...records].reverse().map((r) => (
                        <div key={r.id} className="rounded-xl border border-slate-200 p-3" data-testid={`hr-pay-record-card-${r.id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-700">
                                <span className="mr-1.5 font-normal text-slate-400">{r.number}.</span>{prettyRecordMonth(r.effective_from)}
                              </p>
                              <p className="text-[11px] text-slate-500">{monthsLabel(r.months, r.current)}</p>
                            </div>
                            <div className="flex shrink-0 items-start gap-1">
                              <p className="text-sm font-bold text-emerald-600">{money(r.amount)}</p>
                              <button
                                type="button"
                                onClick={() => removeRecord(r.id)}
                                className="rounded p-1 text-rose-400 transition hover:bg-rose-50 hover:text-rose-600"
                                aria-label={`Remove the record from ${prettyRecordMonth(r.effective_from)}`}
                                data-testid={`hr-pay-record-card-delete-${r.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneOf(reasonBy[r.reason])}`}>
                              {reasonBy[r.reason]?.label || r.reason}
                            </span>
                            {r.change === null || r.change === 0 ? null : (
                              <span className={`text-[11px] font-bold ${r.change > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                {r.change > 0 ? "+" : "−"}{money(Math.abs(r.change))}
                                {r.percent === null || r.percent === undefined ? "" : ` (${Math.abs(r.percent).toFixed(1)}%)`}
                              </span>
                            )}
                          </div>
                          {r.note ? <p className="mt-1 text-[11px] text-slate-400">{r.note}</p> : null}
                        </div>
                      ))}
                    </div>

                    <div className="hidden overflow-x-auto lg:block">
                      <table className="min-w-full text-sm" data-testid="hr-pay-records">
                        <thead className="bg-slate-700 text-left text-xs uppercase tracking-wide text-white">
                          <tr>
                            <th className="px-3 py-2">#</th>
                            <th className="px-3 py-2">Effective from</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                            <th className="px-3 py-2">Duration</th>
                            <th className="px-3 py-2">Reason</th>
                            <th className="px-3 py-2 text-right">Hike</th>
                            <th className="px-3 py-2"></th>
                          </tr>
                        </thead>
                        {/* Newest first to read, numbered oldest first to count: #1 is the
                            figure they joined on however far down the page it sits. */}
                        <tbody>
                          {[...records].reverse().map((r) => (
                            <tr key={r.id} className="border-t border-slate-100" data-testid={`hr-pay-record-${r.id}`}>
                              <td className="px-3 py-2 text-slate-400">{r.number}</td>
                              <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">{prettyRecordMonth(r.effective_from)}</td>
                              <td className="px-3 py-2 text-right font-bold text-emerald-600">{money(r.amount)}</td>
                              <td className="whitespace-nowrap px-3 py-2 text-slate-500">{monthsLabel(r.months, r.current)}</td>
                              <td className="px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneOf(reasonBy[r.reason])}`}>
                                  {reasonBy[r.reason]?.label || r.reason}
                                </span>
                                {r.note ? <span className="block text-[11px] text-slate-400">{r.note}</span> : null}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-right">
                                {r.change === null || r.change === 0 ? (
                                  <span className="text-slate-300">–</span>
                                ) : (
                                  <span className={`font-bold ${r.change > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                    {r.change > 0 ? "+" : "−"}{money(Math.abs(r.change))}
                                    {r.percent === null || r.percent === undefined ? "" : ` (${Math.abs(r.percent).toFixed(1)}%)`}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removeRecord(r.id)}
                                  className="rounded p-1 text-rose-400 transition hover:bg-rose-50 hover:text-rose-600"
                                  aria-label={`Remove the record from ${prettyRecordMonth(r.effective_from)}`}
                                  data-testid={`hr-pay-record-delete-${r.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* What the eight words on the chips above actually mean. "3 Month Review"
                  says when, not why, and a vocabulary of abbreviations is one somebody has
                  to be taught rather than one they can read. */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Hike conditions</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {reasons.map((r) => (
                      <div key={r.key} data-testid={`hr-pay-reason-${r.key}`}>
                        <span className={`block truncate rounded-full px-2.5 py-1 text-center text-[11px] font-semibold ${toneOf(r)}`}>
                          {r.label}
                        </span>
                        <p className="mt-1 text-[11px] leading-snug text-slate-500">{r.description || "—"}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {adding && (
        <AddRecordModal
          employeeId={slip.employee_id}
          reasons={reasons}
          onClose={() => setAdding(false)}
          onReasonAdded={load}
          onSaved={async () => { setAdding(false); await load(); onSaved?.(); }}
        />
      )}
    </div>
  );
};

export const PayrollTab = () => {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback((m) => {
    setLoading(true);
    return hrPayroll(m).then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(month); }, [month, load]);

  const run = data?.run || null;
  // Memoised, not just defaulted. `data?.slips || []` mints a new empty array on every
  // render, and the search below depends on this -- so the filter would re-run for every
  // keystroke anywhere on the screen and the memo would never once hold.
  const everyone = useMemo(() => data?.slips || [], [data?.slips]);
  const totals = data?.totals || {};

  // Name, code, department or designation, because a payroll of fifty is searched for all
  // four: "Abdul" to find a person, "EMP0055" when the name is spelled three ways in the
  // records, and "Sales" or "Nutritionist" to work through a desk at a time.
  //
  // Every word has to match somewhere, not the phrase as a whole -- "abdul doctors" finds
  // the Abdul in Doctors, which is what somebody typing two words is asking for.
  const slips = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return everyone;
    return everyone.filter((s) => {
      const hay = [s.employee_name, s.employee_code, s.department, s.designation]
        .filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [everyone, query]);
  const status = run?.status || "";
  const editable = status === "draft";

  const act = async (fn, done) => {
    setBusy(true);
    try { const res = await fn(); toast.success(done); setData(res.slips ? res : await hrPayroll(month)); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };

  const adjust = async (employeeId, patch) => {
    try {
      await hrAdjustPayslip(month, employeeId, patch);
      setData(await hrPayroll(month));
    } catch (e) { fail(e); }
  };

  const exportCsv = () => {
    downloadCsv([
      ["Employee", "Code", "Department", "Base", "Days", "LOP days", "Payable days", "Earned", "Bonus", "Deduction", "Net payable"],
      ...slips.map((s) => [
        s.employee_name, s.employee_code, s.department, s.base, s.days_in_month,
        s.lop_days, s.payable_days, s.earned, s.bonus, s.deduction, s.net_payable,
      ]),
    ], `payroll-${month}.csv`);
  };

  return (
    <div className="space-y-4" data-testid="hr-payroll-tab">
      <Card>
        <CardContent className="flex flex-col gap-2 p-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:p-3">
          {/* Which month, and what its run is. One group, so the two arrows stay either
              side of the month they move when the bar stacks on a phone. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} title="Previous month" data-testid="hr-pay-prev">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[150px] flex-1 text-center text-sm font-semibold text-slate-800 sm:flex-none" data-testid="hr-pay-month">{prettyMonth(month)}</span>
            <Button
              variant="outline"
              size="icon"
              disabled={month >= todayIso().slice(0, 7)}
              onClick={() => setMonth(shiftMonth(month, 1))}
              title="Next month"
              data-testid="hr-pay-next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            {status && (
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${RUN_TONE[status] || "bg-slate-100 text-slate-600"}`} data-testid="hr-pay-status">
                {status}
              </span>
            )}
            {data?.preview && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500" data-testid="hr-pay-preview-badge">
                Preview
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {/* Narrows the lists, not the totals. The tiles above describe the month's run
                and go on saying what it comes to while somebody looks for one person in
                it — a search that quietly rewrote them would answer "what is this month"
                with "what did I just type". The count beside the box says how many are
                left, so nothing is hidden silently. */}
            <div className="relative w-full sm:w-auto">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, code, department…"
                className="h-9 w-full rounded-md border border-slate-200 pl-7 pr-7 text-sm outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-300 sm:w-52"
                data-testid="hr-pay-search"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Clear search"
                  data-testid="hr-pay-search-clear"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {query.trim() && (
              <span className="text-xs font-medium text-slate-500" data-testid="hr-pay-search-count">
                {slips.length} of {everyone.length}
              </span>
            )}
            <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={exportCsv} disabled={!slips.length} title={query.trim() ? "Exports what the search leaves" : "Exports the whole month"} data-testid="hr-pay-csv">
              <Download className="h-4 w-4" />CSV
            </Button>
            {status !== "paid" && (
              <Button variant="outline" size="sm" className="flex-1 sm:flex-none" disabled={busy || (status && status !== "draft")} onClick={() => act(() => hrGeneratePayroll(month), `${prettyMonth(month)} generated from the register.`)} data-testid="hr-pay-generate">
                <RefreshCw className="h-4 w-4" />{run ? "Regenerate" : "Generate run"}
              </Button>
            )}
            {status === "draft" && (
              <Button size="sm" className="flex-1 sm:flex-none" disabled={busy} onClick={() => act(() => hrPayrollStatus(month, "finalised"), `${prettyMonth(month)} finalised.`)} data-testid="hr-pay-finalise">
                <Check className="h-4 w-4" />Finalise
              </Button>
            )}
            {status === "finalised" && (
              <>
                <Button variant="outline" size="sm" className="flex-1 sm:flex-none" disabled={busy} onClick={() => act(() => hrPayrollStatus(month, "draft"), `${prettyMonth(month)} reopened.`)} data-testid="hr-pay-reopen">
                  <Undo2 className="h-4 w-4" />Reopen
                </Button>
                <Button size="sm" className="flex-1 sm:flex-none" disabled={busy} onClick={() => act(() => hrPayrollStatus(month, "paid"), `${prettyMonth(month)} marked paid.`)} data-testid="hr-pay-paid">
                  <Wallet className="h-4 w-4" />Mark paid
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Employees" value={totals.employees ?? 0} testid="hr-pay-t-emp" />
        <Stat label="Earned" value={money(totals.gross)} testid="hr-pay-t-gross" />
        <Stat label="Bonuses" value={money(totals.bonus)} tone="text-emerald-600" testid="hr-pay-t-bonus" />
        <Stat label="Deductions" value={money(totals.deduction)} tone="text-rose-600" testid="hr-pay-t-ded" />
        <Stat label="Net payable" value={money(totals.net_payable)} tone="text-sky-700" testid="hr-pay-t-net" />
      </div>

      {loading && !data ? <p className="text-sm text-slate-500">Loading...</p> : (
        <>
          <div className="space-y-2 lg:hidden" data-testid="hr-pay-cards">
            {slips.map((s) => (
              // A div rather than a button: the card carries no boxes today, but the row
              // it mirrors does, and the two should stay the same shape. It carries the
              // button's keyboard behaviour by hand instead.
              <div
                key={s.employee_id}
                role="button"
                tabIndex={0}
                onClick={() => setOpened(s)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpened(s); } }}
                className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 active:bg-slate-50"
                data-testid={`hr-pay-card-${s.employee_id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{s.employee_name}</p>
                    <p className="truncate text-xs text-slate-400">{s.employee_code}{s.department ? ` · ${s.department}` : ""}</p>
                  </div>
                  <span className="shrink-0 text-base font-bold text-sky-700">{money(s.net_payable)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span>Base {money(s.base)}</span>
                  <span>{s.payable_days}/{s.days_in_month} days</span>
                  {s.lop_days > 0 && <span className="font-semibold text-rose-600">LOP {s.lop_days}</span>}
                  {s.bonus > 0 && <span className="text-emerald-600">+{money(s.bonus)}</span>}
                  {s.deduction > 0 && <span className="text-rose-600">−{money(s.deduction)}</span>}
                  <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-300" />
                </div>
              </div>
            ))}
            {slips.length === 0 && <Empty>{query.trim() ? `Nobody matches “${query.trim()}”.` : "No active employees to pay."}</Empty>}
          </div>

          <Card className="hidden overflow-hidden lg:block">
            <CardContent className="p-0">
              <div className="overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-700 text-left text-xs uppercase tracking-wide text-white">
                    <tr>
                      <th className="px-3 py-2">S.No</th>
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2 text-right">Base</th>
                      <th className="px-3 py-2 text-right">Payable days</th>
                      <th className="px-3 py-2 text-right">LOP</th>
                      <th className="px-3 py-2 text-right">Earned</th>
                      <th className="px-3 py-2 text-right">Bonus</th>
                      <th className="px-3 py-2 text-right">Deduction</th>
                      <th className="px-3 py-2 text-right">Net payable</th>
                      {/* The chevron's column. Headed with nothing, as the Review and EOD
                          tables head theirs: it is an affordance, not a figure. */}
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {slips.map((s, i) => (
                      <tr
                        key={s.employee_id}
                        onClick={() => setOpened(s)}
                        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                        data-testid={`hr-pay-row-${s.employee_id}`}
                      >
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2">
                          <p className="font-medium text-slate-800">{s.employee_name}</p>
                          <p className="text-xs text-slate-400">{s.employee_code}{s.department ? ` · ${s.department}` : ""}</p>
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600" title={`From the employee record's ${s.base_from}`}>{money(s.base)}</td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          {s.payable_days}<span className="text-slate-400">/{s.days_in_month}</span>
                          {s.unmarked_days > 0 && <span className="ml-1 text-[10px] font-semibold text-amber-600" title={`${s.unmarked_days} days unmarked, paid in full`}>({s.unmarked_days}?)</span>}
                        </td>
                        <td className={`px-3 py-2 text-right ${s.lop_days > 0 ? "font-semibold text-rose-600" : "text-slate-400"}`}>{s.lop_days}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{money(s.earned)}</td>
                        <td className="px-3 py-2 text-right" onClick={editable ? (e) => e.stopPropagation() : undefined}>
                          {editable
                            ? <AmountBox value={s.bonus} onCommit={(n) => adjust(s.employee_id, { bonus: n })} testid={`hr-pay-bonus-${s.employee_id}`} />
                            : <span className={s.bonus ? "text-emerald-600" : "text-slate-400"}>{money(s.bonus)}</span>}
                        </td>
                        <td className="px-3 py-2 text-right" onClick={editable ? (e) => e.stopPropagation() : undefined}>
                          {editable
                            ? <AmountBox value={s.deduction} onCommit={(n) => adjust(s.employee_id, { deduction: n })} testid={`hr-pay-ded-${s.employee_id}`} />
                            : <span className={s.deduction ? "text-rose-600" : "text-slate-400"}>{money(s.deduction)}</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-sky-700">{money(s.net_payable)}</td>
                        <td className="px-3 py-2 text-right">
                          {/* A real button, so the page is reachable from the keyboard --
                              the row's own click is a convenience for the mouse. */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpened(s); }}
                            title={`Open ${s.employee_name}'s pay`}
                            aria-label={`Open ${s.employee_name}'s pay`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-sky-50 hover:text-sky-700"
                            data-testid={`hr-pay-open-row-${s.employee_id}`}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {slips.length === 0 && <tr><td colSpan="10" className="px-3 py-6 text-center text-slate-400">{query.trim() ? `Nobody matches “${query.trim()}”.` : "No active employees to pay."}</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {opened && (
        <EmployeePayPage
          slip={opened}
          onClose={() => setOpened(null)}
          // The lane a slip sits in is read off the salary that just changed, so the board
          // behind this is now showing somebody in the wrong one.
          onSaved={() => load(month)}
        />
      )}
    </div>
  );
};

// ---------- Approvals ----------

// Mirrors KINDS in backend/routers/v3_hr_ops.py. `dated`, `timed` and `priced` decide
// which part of the form a kind asks for — a leave wants two dates, a permission wants one
// date and two clock times, an advance wants an amount, and offering all three to all of
// them would leave every request two thirds empty.
const KINDS = [
  { key: "leave", label: "Leave", dated: true, timed: false, priced: false, icon: Palmtree },
  { key: "permission", label: "Permission", dated: false, timed: true, priced: false, icon: Clock3 },
  { key: "comp_off", label: "Comp off", dated: true, timed: false, priced: false, icon: CalendarOff },
  { key: "advance", label: "Salary advance", dated: false, timed: false, priced: true, icon: IndianRupee },
  { key: "expense", label: "Expense claim", dated: false, timed: false, priced: true, icon: Wallet },
  { key: "other", label: "Other", dated: false, timed: false, priced: false, icon: AlarmClock },
];
const KIND_BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));

const STATUS_TONE = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
};

const NewRequestModal = ({ employees, onClose, onSaved }) => {
  const [form, setForm] = useState({
    employee_id: "", kind: "leave", from_date: "", to_date: "",
    from_time: "", to_time: "", amount: "", reason: "",
  });
  const [saving, setSaving] = useState(false);
  const kind = KIND_BY_KEY[form.kind];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (!form.employee_id) { toast.error("Pick who this is for."); return; }
    setSaving(true);
    try {
      await hrCreateApproval({
        employee_id: form.employee_id,
        kind: form.kind,
        // A permission is hours of one day, so its single date arrives as both ends —
        // the server stores the pair either way, and one field here means one date to
        // pick rather than the same day typed twice.
        from_date: kind.dated || kind.timed ? form.from_date : "",
        // A one-day leave is the common case, so leaving the second date blank means the
        // same day rather than being an error to correct.
        to_date: kind.timed ? form.from_date : kind.dated ? (form.to_date || form.from_date) : "",
        from_time: kind.timed ? form.from_time : "",
        to_time: kind.timed ? form.to_time : "",
        amount: kind.priced ? Number(form.amount || 0) : 0,
        reason: form.reason,
      });
      toast.success("Request logged.");
      onSaved();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-h-[90vh] sm:rounded-2xl sm:p-5" onClick={(e) => e.stopPropagation()} data-testid="hr-approval-modal">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">New request</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="hr-approval-modal-close"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Employee</span>
            <select
              value={form.employee_id}
              onChange={(e) => set({ employee_id: e.target.value })}
              className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
              data-testid="hr-approval-employee"
            >
              <option value="">Select</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ""}</option>)}
            </select>
          </label>

          <div>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Type</span>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => set({ kind: k.key })}
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${
                    form.kind === k.key ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300"
                  }`}
                  data-testid={`hr-approval-kind-${k.key}`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {kind.dated && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">From</span>
                <MilkDateInput value={form.from_date} accent="sky" centered title="Pick the first day" onChange={(e) => set({ from_date: e.target.value })} data-testid="hr-approval-from" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">To</span>
                <MilkDateInput value={form.to_date} min={form.from_date} accent="sky" centered title="Pick the last day" placeholder="Same day" onChange={(e) => set({ to_date: e.target.value })} data-testid="hr-approval-to" />
              </label>
            </div>
          )}

          {kind.timed && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Day</span>
                <MilkDateInput value={form.from_date} accent="sky" centered title="Which day?" onChange={(e) => set({ from_date: e.target.value })} data-testid="hr-approval-perm-day" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">From</span>
                <TimeBox value={form.from_time} onChange={(v) => set({ from_time: v })} testid="hr-approval-perm-from" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">To</span>
                <TimeBox value={form.to_time} onChange={(v) => set({ to_time: v })} testid="hr-approval-perm-to" />
              </label>
            </div>
          )}

          {kind.priced && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Amount (₹)</span>
              <Input value={form.amount} inputMode="numeric" onChange={(e) => set({ amount: e.target.value.replace(/[^\d.]/g, "") })} data-testid="hr-approval-amount" />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Reason</span>
            <textarea
              value={form.reason}
              onChange={(e) => set({ reason: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
              data-testid="hr-approval-reason"
            />
          </label>

          {kind.dated && (
            <p className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              Approving this writes those days into the attendance register as leave, and payroll reads them from there.
            </p>
          )}

          {kind.timed && (
            <p className="rounded-lg border border-violet-100 bg-violet-50 px-3 py-2 text-xs text-violet-800">
              Approving this does not mark the day — they are still coming in. The hours go onto the register beside it,
              so the gap in their day reads as agreed rather than unexplained.
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving} data-testid="hr-approval-save">{saving ? "Saving..." : "Log request"}</Button>
        </div>
      </div>
    </div>
  );
};

export const ApprovalsTab = () => {
  // Five filters, one control. Four are statuses and the fifth is "raised by staff",
  // which is a different axis — but they are the same question asked of the same list
  // ("what should I be looking at"), and two rows of tiles for one list would read as two
  // lists. The odd one out narrows to pending on its own, because a request somebody
  // raised and HR has already decided is not what anybody clicks that tile to find.
  const [filter, setFilter] = useState("pending");
  const [data, setData] = useState({ approvals: [], counts: {} });
  const [employees, setEmployees] = useState([]);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback((which) => {
    setLoading(true);
    const params = which === "all" ? {}
      : which === "from_staff" ? { status: "pending", source: "self" }
        : { status: which };
    return hrApprovals(params)
      .then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(filter); }, [filter, load]);
  useEffect(() => { hrEmployees({ status: "active" }).then(setEmployees).catch(() => setEmployees([])); }, []);

  const decide = async (row, decision) => {
    try {
      const res = await hrDecideApproval(row.id, decision);
      const days = res.attendance_days_changed || 0;
      // The same figure reads two ways. For a leave it is days marked; for a permission
      // it is the one day the hours were written onto, and "1 day marked as leave" after
      // approving two hours out would be the screen contradicting the register.
      const landed = row.kind === "permission"
        ? (decision === "approved" ? " — hours noted on the register" : " — hours cleared from the register")
        : days > 0 ? ` — ${days} day${days > 1 ? "s" : ""} marked as leave`
          : days < 0 ? ` — ${-days} leave day${days < -1 ? "s" : ""} cleared` : "";
      toast.success(
        decision === "pending" ? "Sent back to pending."
          : `${decision === "approved" ? "Approved" : "Rejected"}${landed}.`
      );
      load(filter);
    } catch (e) { fail(e); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete this ${KIND_BY_KEY[row.kind]?.label.toLowerCase() || "request"} for ${row.employee_name}? Any leave days it marked are cleared too.`)) return;
    try { await hrDeleteApproval(row.id); toast.success("Deleted."); load(filter); } catch (e) { fail(e); }
  };

  const counts = data.counts || {};
  const rows = data.approvals || [];

  const when = (row) => {
    // A permission is hours of one day, so it reads as one: the date, the two times, and
    // what they add up to. Printed as a one-day span it would say the whole day was
    // taken, which is the one thing it is not.
    if (row.kind === "permission" && row.from_date) {
      return `${prettyDate(row.from_date)} · ${prettyTime(row.from_time)} → ${prettyTime(row.to_time)} · ${duration(row.minutes)}`;
    }
    if (row.from_date) {
      return row.from_date === row.to_date
        ? prettyDate(row.from_date)
        : `${prettyDate(row.from_date)} → ${prettyDate(row.to_date)} · ${row.days} days`;
    }
    return row.amount ? money(row.amount) : "—";
  };

  return (
    <div className="space-y-4" data-testid="hr-approvals-tab">
      <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/70 bg-[#eef1f8] p-1.5 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Pending" value={counts.pending ?? 0} tone={counts.pending ? "text-amber-600" : "text-slate-400"} active={filter === "pending"} onClick={() => setFilter("pending")} testid="hr-appr-f-pending" />
        {/* The queue with a person on the other end of it. Everything else on this row is
            a state a request is in; this is the part of Pending that somebody outside
            this room is waiting on an answer to, and it is the one worth clearing daily. */}
        <Stat label="From staff" value={counts.pending_from_staff ?? 0} tone={counts.pending_from_staff ? "text-sky-600" : "text-slate-400"} active={filter === "from_staff"} onClick={() => setFilter("from_staff")} testid="hr-appr-f-staff" />
        <Stat label="Approved" value={counts.approved ?? 0} tone="text-emerald-600" active={filter === "approved"} onClick={() => setFilter("approved")} testid="hr-appr-f-approved" />
        <Stat label="Rejected" value={counts.rejected ?? 0} tone="text-rose-600" active={filter === "rejected"} onClick={() => setFilter("rejected")} testid="hr-appr-f-rejected" />
        <Stat label="All requests" value={(counts.pending || 0) + (counts.approved || 0) + (counts.rejected || 0)} active={filter === "all"} onClick={() => setFilter("all")} testid="hr-appr-f-all" />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-500">
          {filter === "all" ? "Every request"
            : filter === "from_staff" ? "Pending requests people raised for themselves"
              : `${filter[0].toUpperCase()}${filter.slice(1)} requests`}
          {" · approving a leave marks the register; a permission notes the hours beside it."}
        </p>
        <Button className="w-full shrink-0 sm:w-auto" onClick={() => setAdding(true)} data-testid="hr-appr-new"><Plus className="h-4 w-4" />New request</Button>
      </div>

      {loading ? <p className="text-sm text-slate-500">Loading...</p> : rows.length === 0 ? (
        <Empty>{filter === "pending" ? "Nothing waiting on a decision." : "No requests here."}</Empty>
      ) : (
        <div className="space-y-2" data-testid="hr-appr-list">
          {rows.map((row) => {
            const kind = KIND_BY_KEY[row.kind] || KIND_BY_KEY.other;
            const Icon = kind.icon;
            return (
              <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`hr-appr-row-${row.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-800">{row.employee_name}</span>
                      <span className="text-xs text-slate-400">{row.employee_code}{row.department ? ` · ${row.department}` : ""}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        <Icon className="h-3 w-3" />{kind.label}
                      </span>
                      <span>{when(row)}</span>
                    </p>
                    {row.reason && <p className="mt-1 text-sm text-slate-500">{row.reason}</p>}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                      {/* A request its own subject raised reads differently from one HR
                          typed: somebody is waiting on the answer, and the reason on it is
                          theirs rather than a note taken over the phone. */}
                      {row.source === "self" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 font-semibold text-sky-700" data-testid={`hr-appr-self-${row.id}`}>
                          <UserRound className="h-3 w-3" />Raised by {row.employee_name || "them"}
                        </span>
                      ) : (
                        <span>Logged by {row.requested_by || "—"}</span>
                      )}
                      {row.decided_by ? <span>· {row.status} by {row.decided_by}</span> : null}
                    </p>
                  </div>

                  <div className="flex w-full items-center gap-1.5 border-t border-slate-100 pt-2 sm:w-auto sm:shrink-0 sm:flex-wrap sm:border-0 sm:pt-0">
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${STATUS_TONE[row.status]}`}>{row.status}</span>
                    {row.status === "pending" ? (
                      <>
                        <Button size="sm" className="flex-1 sm:flex-none" onClick={() => decide(row, "approved")} data-testid={`hr-appr-approve-${row.id}`}><Check className="h-4 w-4" />Approve</Button>
                        <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => decide(row, "rejected")} data-testid={`hr-appr-reject-${row.id}`}><Ban className="h-4 w-4" />Reject</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => decide(row, "pending")} title="Undo this decision" data-testid={`hr-appr-reopen-${row.id}`}>
                        <Undo2 className="h-4 w-4" />Reopen
                      </Button>
                    )}
                    <button type="button" onClick={() => remove(row)} title="Delete request" className="shrink-0 p-1.5 text-slate-400 hover:text-rose-600" data-testid={`hr-appr-delete-${row.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && <NewRequestModal employees={employees} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(filter); }} />}
    </div>
  );
};

// ---------- Quotes ----------

// The same cap MAX_QUOTE holds in backend/routers/v3_hr_ops.py — trimmed as it is typed
// so the box never accepts words the save would reject.
const MAX_QUOTE = 400;

/** The box a quote is rewritten in — the same fields as the add form, opened in place of
 *  whichever quote is being fixed. Both the board card and the list rows render this one,
 *  so a typo reads the same wherever it is caught. */
const QuoteEditor = ({ draft, setDraft, onSave, onCancel, saving, testid }) => (
  <div className="space-y-2" data-testid={testid}>
    <textarea
      value={draft.text}
      onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value.slice(0, MAX_QUOTE) }))}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      rows={2}
      autoFocus
      placeholder="The quote itself"
      className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
      data-testid={`${testid}-text`}
    />
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={draft.author}
        onChange={(e) => setDraft((d) => ({ ...d, author: e.target.value }))}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        placeholder="Who said it (optional)"
        className="w-full bg-white sm:max-w-xs"
        data-testid={`${testid}-author`}
      />
      <span className="text-xs text-slate-400">{draft.text.length}/{MAX_QUOTE}</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving} data-testid={`${testid}-cancel`}>
          <X className="h-4 w-4" />Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving} data-testid={`${testid}-save`}>
          <Check className="h-4 w-4" />Save
        </Button>
      </div>
    </div>
  </div>
);

export const QuotesTab = () => {
  const [data, setData] = useState({ quotes: [], today: null });
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Which editor is open -- "today:<id>" for the board card, "row:<id>" for the list --
  // and the words being edited. The place is part of the key because today's quote is
  // also a row: without it, one click would open the same draft in two boxes at once.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ text: "", author: "" });
  const boxRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    return hrQuotes().then(setData).catch(fail).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!text.trim()) { toast.error("Write the quote first."); boxRef.current?.focus(); return; }
    setSaving(true);
    try {
      await hrAddQuote(text.trim(), author.trim());
      setText(""); setAuthor("");
      toast.success("Added to the board.");
      load();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const patch = async (q, body, done) => {
    try { await hrUpdateQuote(q.id, body); if (done) toast.success(done); load(); } catch (e) { fail(e); }
  };

  const remove = async (q) => {
    if (!window.confirm("Delete this quote?")) return;
    try { await hrDeleteQuote(q.id); toast.success("Deleted."); setEditing(null); load(); } catch (e) { fail(e); }
  };

  const startEdit = (q, at) => { setEditing(`${at}:${q.id}`); setDraft({ text: q.text || "", author: q.author || "" }); };
  const cancelEdit = () => { setEditing(null); setDraft({ text: "", author: "" }); };

  const saveEdit = async (q) => {
    const text = draft.text.trim();
    const author = draft.author.trim();
    if (!text) { toast.error("A quote can't be empty."); return; }
    // Nothing actually changed -- close the row instead of spending a request on it.
    if (text === (q.text || "") && author === (q.author || "")) { cancelEdit(); return; }
    setSaving(true);
    try {
      await hrUpdateQuote(q.id, { text, author });
      toast.success("Saved.");
      cancelEdit();
      load();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const quotes = data.quotes || [];
  const live = quotes.filter((q) => q.active).length;

  return (
    <div className="space-y-4" data-testid="hr-quotes-tab">
      {/* Today's quote, shown the way staff will see it. The board is written here and
          read at /hr/quotes/today, so this card is the same answer that endpoint gives. */}
      <Card className="border-2 border-sky-100 bg-gradient-to-br from-sky-50 to-white">
        <CardContent className="p-4 sm:p-5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-sky-600">
            <Quote className="h-3.5 w-3.5" />Quote of the day · {prettyDate(data.date)}
          </p>
          {data.today && editing === `today:${data.today.id}` ? (
            // Fixed here rather than hunted for in the list below: the mistake is on the
            // board, so the board is where it gets corrected.
            <div className="mt-3">
              <QuoteEditor
                draft={draft}
                setDraft={setDraft}
                onSave={() => saveEdit(data.today)}
                onCancel={cancelEdit}
                saving={saving}
                testid="hr-quote-today-edit"
              />
            </div>
          ) : data.today ? (
            <>
              <div className="mt-2 flex items-start justify-between gap-3">
                <p className="text-base font-semibold leading-snug text-slate-800 sm:text-lg" data-testid="hr-quote-today">“{data.today.text}”</p>
                <button
                  type="button"
                  onClick={() => startEdit(data.today, "today")}
                  title="Fix this quote"
                  className="shrink-0 rounded-md p-1.5 text-sky-500 hover:bg-sky-100 hover:text-sky-700"
                  data-testid="hr-quote-today-edit-open"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1.5 text-sm text-slate-500">
                — {data.today.author || "Unknown"}
                {data.today.pinned && <span className="ml-2 inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-700"><Pin className="h-2.5 w-2.5" />Pinned</span>}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500" data-testid="hr-quote-today-empty">
              Nothing on the board yet. Add one below and it shows here from today.
            </p>
          )}
          <p className="mt-3 text-[11px] text-slate-400">
            {live > 1 && !data.today?.pinned
              ? `Rotating through ${live} active quotes — a different one each day. Pin one to hold it.`
              : "Pin a quote to hold it in place; unpinned, the board rotates a new one every day."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Add a quote</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_QUOTE))}
            rows={2}
            placeholder="The quote itself"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
            data-testid="hr-quote-text"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Who said it (optional)" className="w-full sm:max-w-xs" data-testid="hr-quote-author" />
            <span className="text-xs text-slate-400">{text.length}/{MAX_QUOTE}</span>
            <Button className="ml-auto w-full sm:w-auto" onClick={add} disabled={saving} data-testid="hr-quote-add"><Plus className="h-4 w-4" />Add</Button>
          </div>
        </CardContent>
      </Card>

      {loading ? <p className="text-sm text-slate-500">Loading...</p> : quotes.length === 0 ? (
        <Empty>The board is empty.</Empty>
      ) : (
        <div className="space-y-2" data-testid="hr-quote-list">
          {quotes.map((q) => (
            <div
              key={q.id}
              className={`rounded-xl border bg-white p-3 ${q.pinned ? "border-sky-300" : "border-slate-200"} ${q.active ? "" : "opacity-60"}`}
              data-testid={`hr-quote-row-${q.id}`}
            >
              {editing === `row:${q.id}` ? (
                <QuoteEditor
                  draft={draft}
                  setDraft={setDraft}
                  onSave={() => saveEdit(q)}
                  onCancel={cancelEdit}
                  saving={saving}
                  testid={`hr-quote-edit-${q.id}`}
                />
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">“{q.text}”</p>
                    <p className="mt-1 text-xs text-slate-400">
                      — {q.author || "Unknown"} · added by {q.added_by || "—"}
                      {!q.active && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">Off the board</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(q, "row")}
                      title="Edit"
                      className="p-1.5 text-slate-400 hover:text-sky-600"
                      data-testid={`hr-quote-edit-open-${q.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => patch(q, { pinned: !q.pinned }, q.pinned ? "Unpinned — the board rotates again." : "Pinned as the quote of the day.")}
                      title={q.pinned ? "Unpin" : "Pin as the quote of the day"}
                      className={`p-1.5 ${q.pinned ? "text-sky-600" : "text-slate-400 hover:text-sky-600"}`}
                      data-testid={`hr-quote-pin-${q.id}`}
                    >
                      {q.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => patch(q, { active: !q.active })}
                      title={q.active ? "Take off the board" : "Put back on the board"}
                      className={`p-1.5 ${q.active ? "text-emerald-600 hover:text-slate-500" : "text-slate-400 hover:text-emerald-600"}`}
                      data-testid={`hr-quote-toggle-${q.id}`}
                    >
                      {q.active ? <Check className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                    </button>
                    <button type="button" onClick={() => remove(q)} title="Delete" className="p-1.5 text-slate-400 hover:text-rose-600" data-testid={`hr-quote-delete-${q.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
