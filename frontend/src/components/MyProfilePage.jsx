/**
 * MY PROFILE — the page everybody has about themselves, whatever desk they sit at.
 *
 *     Attendance     the month I have worked, and today so far
 *     My Profile     what this company holds about me
 *     Security       the password and second factor on my own login
 *
 * It replaced a dialog. The old My Profile was four lines in a box — name, role, joining
 * date — and every other fact about a person (their address, who to call in an emergency,
 * which account their salary lands in, how many hours they did last week) lived on screens
 * only Super Admin and HR can open. So the answer to "what does the company have on me"
 * was "ask somebody", for all forty-eight people on the books.
 *
 * A page rather than a bigger dialog because of what is on it. The month is a table with
 * eleven columns and thirty rows; a dialog either scrolls it in a letterbox or grows until
 * it is a page with a shadow under it. This takes the whole area under the header, with
 * Back where the board was.
 *
 * Attendance leads, not the profile. A profile is read once, when somebody joins or when a
 * detail changes; the month is read on a Friday afternoon by anyone wondering whether they
 * are ahead. The tab that opens is the one being opened for.
 *
 * Both halves come from routers/v3_me.py, which takes no id — there is no request this
 * page can make that reads another person's record.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  BriefcaseBusiness,
  CalendarDays,
  CalendarOff,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  Home,
  KeyRound,
  Layers,
  Loader2,
  LogIn,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { getBranches, myAttendance, myProfile, MY_PHOTO_CHANGED_EVENT, removeMyPhoto, uploadMyPhoto } from "@/lib/api";
import { toast } from "@/components/ui/sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
// The branch's working / leave days — the same calendar Management → Calendar sets.
import { BranchMonthlyCalendar } from "@/components/branch/BranchMonthlyCalendar";
import { CLOCK_CHANGED_EVENT } from "@/components/ClockWidget";
// The third tab, in its own file. Same reason HROpsTabs.jsx lives beside HRBoard.jsx: this
// page is already six hundred lines of two tabs, and the one that writes is the one most
// likely to be edited on its own.
import { TimeOffTab } from "@/components/MyTimeOff";
// And the fourth, split out for the same reason — it is the other tab that writes, and
// what it writes is the login itself.
import { SecurityTab } from "@/components/MySecurity";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { PhotoEditor } from "@/components/ui/photo-editor";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
// The same formatters the header clock and HR's register read a day with, so an hour and
// a half is not "1h 30m" here and "90m" three screens away.
import { duration, hours, prettyTime } from "@/lib/clock";

// A fourth tab means four across a phone, which is about 46px of text a tab — under what
// "Attendance" and "My Profile" need, so both would arrive as an ellipsis. `short` is the
// phone label; the full one returns from sm up. See SegmentedTabs.
const TABS = [
  // First: the month the branch is open, which is the frame the other tabs are read in.
  { key: "calendar", label: "Monthly Calendar", short: "Calendar", icon: CalendarDays },
  { key: "attendance", label: "Attendance", short: "Hours", icon: Clock },
  // Between the two, because that is the order the questions come in: what did I work,
  // what am I asking for, and who am I on the books. What Time Off writes also lands on
  // the tab to its left -- an approved leave marks those days, an approved permission
  // notes its hours on one of them.
  { key: "timeoff", label: "Time Off", short: "Leave", icon: CalendarOff },
  { key: "profile", label: "My Profile", short: "Profile", icon: UserRound },
  // Last, because it is the tab opened on purpose rather than in passing. The three before
  // it are read — what did I work, what did I ask for, what do they have on me — and this
  // one is only reached by somebody who came to change something.
  { key: "security", label: "Security", short: "Login", icon: ShieldCheck },
];

// ---------- reading the figures ----------

/** Minutes as a signed count of hours: +1.3h, -9.0h, and 0 as a flat "0.0h".
 *
 *  A balance is the one figure on this page that is read for its sign before its size, so
 *  the plus is printed rather than left implied — "1.3h" beside "-9.0h" in the same column
 *  reads as a magnitude, not as an hour and a half in hand.
 */
const signedHours = (mins) => {
  const n = Math.round(Number(mins) || 0);
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${(Math.abs(n) / 60).toFixed(1)}h`;
};

/** Minutes as plain hours to one place: 176.0, 26.3. For the summary row, where six
 *  figures are compared against each other and "7h 45m" is two numbers to read per tile. */
const plainHours = (mins) => (Math.abs(Number(mins) || 0) / 60).toFixed(1);

const monthLabel = (m) =>
  m ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "";

const shiftMonth = (m, by) => {
  const d = new Date(`${m}-01T00:00:00`);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const dayNumber = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const prettyDate = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  // Stored as YYYY-MM-DD by HR's form. Anything else — a date somebody typed in another
  // shape before the form was strict about it — is shown as it was written rather than
  // run through a parser that would turn it into "Invalid Date".
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return new Date(`${text}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

// What the register's marks are called on a person's own screen, and the colour each
// carries. `working` and `done` are the clock's states rather than HR's marks — a day
// nobody has marked is described by what was pressed on it, which is the honest answer
// and the one HR's own board gives (see _board_status in backend/routers/v3_hr_ops.py).
const STATUS_STYLES = {
  present: { label: "Present", cls: "bg-emerald-50 text-emerald-700" },
  late: { label: "Late", cls: "bg-amber-50 text-amber-700" },
  half_day: { label: "Half day", cls: "bg-orange-50 text-orange-700" },
  absent: { label: "Absent", cls: "bg-rose-50 text-rose-700" },
  leave: { label: "Leave", cls: "bg-violet-50 text-violet-700" },
  week_off: { label: "Week off", cls: "bg-slate-100 text-slate-500" },
  holiday: { label: "Holiday", cls: "bg-sky-50 text-sky-700" },
  working: { label: "Working", cls: "bg-emerald-50 text-emerald-700" },
  on_break: { label: "On break", cls: "bg-amber-50 text-amber-700" },
  done: { label: "Present", cls: "bg-emerald-50 text-emerald-700" },
  out: { label: "—", cls: "bg-slate-50 text-slate-400" },
};

const statusOf = (row) => STATUS_STYLES[row.status || row.state] || STATUS_STYLES.out;

// ---------- the small pieces ----------

/** A labelled figure, as one line of a list — the same shape as the Profile screen's
 *  rows. The month's counts and its hours are both drawn with it, so they read as one
 *  summary rather than as two designs. */
const Tile = ({ label, value, sub, tone = "text-slate-800", testid }) => (
  <div className="flex items-center gap-2 py-3 text-sm" data-testid={testid}>
    <dt className="w-40 shrink-0 text-slate-500">
      {label}
      {/* The explanatory line under a label is desktop-only; a phone keeps label and value. */}
      {sub && <span className="hidden text-[11px] leading-tight text-slate-400 md:block">{sub}</span>}
    </dt>
    <dd className={`min-w-0 flex-1 font-medium ${tone}`}>{value}</dd>
  </div>
);

/** One fact off the record: what it is called, and what it says.
 *
 *  A missing value is a dash rather than an empty space, so a half-filled record reads as
 *  a record with gaps in it — which is a thing to go and get filled in — rather than as a
 *  screen that failed to load.
 */
const Field = ({ label, value, testid }) => (
  <div data-testid={testid}>
    <p className="text-[11px] text-slate-400">{label}</p>
    <p className="mt-0.5 break-words text-sm font-medium text-slate-700">{value || "—"}</p>
  </div>
);

const Panel = ({ title, icon: Icon, children, className = "", testid }) => (
  <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`} data-testid={testid}>
    <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
      {Icon && <Icon className="h-4 w-4 text-slate-400" />}
      {title}
    </h3>
    {children}
  </section>
);

// ---------- attendance ----------

/** Today, across the top: the day as it stands right now.
 *
 *  The same six figures the header clock holds behind its pill, laid out rather than
 *  hidden — this is the screen somebody opened to look at them.
 */
const TodayStrip = ({ row, standard, today }) => {
  const style = statusOf(row || {});
  const when = today ? new Date(`${today}T00:00:00`) : null;
  return (
    <section data-testid="my-attendance-today">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Today
          {when && (
            <span className="font-medium normal-case tracking-normal text-slate-600" data-testid="my-attendance-today-date">
              · {dayNumber(today)} · {when.toLocaleDateString("en-GB", { weekday: "long" })}
            </span>
          )}
          <span className="hidden text-xs font-normal normal-case tracking-normal text-slate-400 md:inline">
            (Standard: {standard?.start} – {standard?.end})
          </span>
        </h3>
      </div>
      <dl className="divide-y divide-slate-100 px-1">
        <div className="flex items-center gap-2 py-3 text-sm" data-testid="my-attendance-today-status">
          <dt className="w-40 shrink-0 text-slate-500">Status</dt>
          <dd className="min-w-0 flex-1">
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.cls}`}>{style.label}</span>
          </dd>
        </div>
        <Tile
          label="Login – Logout"
          value={<>{prettyTime(row?.clock_in) || "—"} <span className="text-slate-300">–</span> {prettyTime(row?.clock_out) || "—"}</>}
          testid="my-attendance-today-in-out"
        />
        <Tile label="Sessions" value={row?.sessions ?? 0} testid="my-attendance-today-sessions" />
        <Tile label="On the clock" value={hours(row?.login_minutes)} tone="text-emerald-600" testid="my-attendance-today-login" />
      </dl>
    </section>
  );
};

/** Today's clients and bookings — what a Physio, a Consultant or a Branch Admin has on
 *  their book today. Other roles get no `workload` and this draws nothing. */
const WORKLOAD_TILES = {
  physio: [
    ["Today's clients", "clients", "text-slate-800"],
    ["Today's treatments", "treatments", "text-sky-600"],
    ["Completed treatments", "completed", "text-emerald-600"],
    ["Pending treatments", "pending", "text-amber-600"],
  ],
  consultant: [
    ["Today's clients", "clients", "text-slate-800"],
    ["Today's consultations", "consultations", "text-sky-600"],
    ["Completed consultations", "completed", "text-emerald-600"],
    ["Pending consultations", "pending", "text-amber-600"],
  ],
  branch: [
    ["Today's appointments", "appointments", "text-slate-800"],
    ["Completed appointments", "completed", "text-emerald-600"],
    ["Pending appointments", "pending", "text-amber-600"],
    ["Today's consultations", "consultations", "text-sky-600"],
    ["Today's treatments", "treatments", "text-violet-600"],
  ],
};

const TodayWorkload = ({ workload }) => {
  const tiles = WORKLOAD_TILES[workload?.kind];
  if (!tiles) return null;
  return (
    <section data-testid="my-attendance-workload">
      <h3 className="flex items-center gap-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Today's work</h3>
      <dl className="divide-y divide-slate-100 px-1">
        {tiles.map(([label, key, tone]) => (
          <Tile key={key} label={label} value={workload[key] ?? 0} tone={tone} testid={`my-attendance-workload-${key}`} />
        ))}
      </dl>
    </section>
  );
};

/** The month's counts, and then its hours. Two rows because they answer two questions —
 *  how many days, and how many hours — and one row of twelve tiles answers neither. */
const MonthSummary = ({ totals, month, today, workload }) => {
  const behind = (totals?.balance_minutes || 0) < 0;
  // Only when there is some. A "0.0h" permission tile on every month of every person who
  // has never asked for an hour off would be a column of zeroes explaining a feature
  // rather than a figure reporting a month.
  const permission = (totals?.permission_minutes || 0) > 0;
  return (
    <>
      <section data-testid="my-attendance-counts">
        <h3 className="flex items-center gap-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">This month</h3>
        <dl className="divide-y divide-slate-100 px-1">
          <Tile label="Working days" value={totals?.working_days ?? 0} sub={monthLabel(month)} testid="my-attendance-working-days" />
          <Tile label="Present days" value={totals?.present_days ?? 0} tone="text-sky-600" testid="my-attendance-present-days" />
          <Tile label="Absent" value={totals?.absent_days ?? 0} tone={totals?.absent_days ? "text-rose-600" : "text-slate-800"} testid="my-attendance-absent-days" />
          <Tile label="On leave" value={totals?.leave_days ?? 0} tone="text-violet-600" testid="my-attendance-leave-days" />
        </dl>
      </section>

      {workload}

      <section data-testid="my-attendance-hours">
        <h3 className="flex items-center gap-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Hours — {monthLabel(month)}
        </h3>
        <dl className="divide-y divide-slate-100 px-1">
          <Tile
            label="Expected"
            value={plainHours(totals?.expected_minutes)}
            sub={`${totals?.working_days ?? 0} days × 8h`}
            testid="my-attendance-expected"
          />
          <Tile label="Worked" value={plainHours(totals?.worked_minutes)} tone="text-emerald-600" sub="Actual hours" testid="my-attendance-worked" />
          <Tile label="Extra" value={signedHours(totals?.extra_minutes)} tone="text-emerald-600" sub="Overtime" testid="my-attendance-overtime" />
          <Tile label="On breaks" value={plainHours(totals?.break_minutes)} tone="text-amber-600" sub="Off the clock" testid="my-attendance-breaks" />
          {/* Beside the breaks, because both are time out of a working day. The
              difference is that somebody signed this one off in advance — which is also
              why it is worth seeing next to a balance it helps explain. */}
          {permission && (
            <Tile
              label="Permission"
              value={plainHours(totals?.permission_minutes)}
              tone="text-sky-600"
              sub={`${totals?.permission_days ?? 0} day${totals?.permission_days === 1 ? "" : "s"}, approved`}
              testid="my-attendance-permission"
            />
          )}
          <Tile
            label="Expected so far"
            value={plainHours(totals?.expected_to_date_minutes)}
            sub={`Up to ${dayNumber(today)}`}
            testid="my-attendance-expected-to-date"
          />
          {/* Measured against the days that have happened, not against the whole month —
              the backend sends both, and a balance of −150h on the 5th would be the
              calendar talking, not the person. */}
          <Tile
            label="Balance"
            value={signedHours(totals?.balance_minutes)}
            sub={behind ? "Behind, so far" : "In hand"}
            tone={behind ? "text-rose-600" : "text-emerald-600"}
            testid="my-attendance-balance"
          />
        </dl>
      </section>
    </>
  );
};

// ---------- attendance, on a phone ----------
//
// The phone's Attendance screen (view "summary" / "history") is cards rather than the
// desktop's label-and-value lists, sized so the summary — the month, Today, This Month,
// Today's Work — sits on one screen between the header and the bottom bar without a
// scroll. That is why the figures run four across and the month's hours live on View
// History instead. The desktop is untouched.

const PhoneCard = ({ title, icon: Icon, children, testid }) => (
  <section className="rounded-md border border-slate-200/80 bg-white p-2.5 shadow-sm" data-testid={testid}>
    {title && (
      <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Icon className="h-4 w-4 text-sky-600" />
        {title}
      </h3>
    )}
    {children}
  </section>
);

/** One figure, stacked: glyph in a tinted square, its name, its value. Four fit across a
 *  phone. `className` is the tile itself: bordered white on Today, tinted on the month. */
const PhoneStat = ({ icon: Icon, tone, label, value, className = "", testid }) => (
  <div className={`min-w-0 rounded-md px-0.5 py-1.5 text-center ${className}`} data-testid={testid}>
    <span className={`mx-auto flex h-6 w-6 items-center justify-center rounded-md ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
    <span className="mt-1 block truncate text-[10px] leading-tight tracking-tight text-slate-500">{label}</span>
    <span className="mt-0.5 block truncate text-sm font-bold leading-tight text-slate-900">{value}</span>
  </div>
);

const NO_TIME = "– – –";

const PhoneToday = ({ row, today }) => {
  const style = statusOf(row || {});
  // Nothing pressed yet is the screen's own blue rather than the grey of a blank cell.
  const box = style === STATUS_STYLES.out ? "bg-sky-50 text-sky-600" : style.cls;
  const when = today ? new Date(`${today}T00:00:00`) : null;
  const card = "border border-slate-200 bg-white";
  return (
    <PhoneCard testid="my-attendance-today">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-slate-500">
            Today{when && ` · ${when.toLocaleDateString("en-GB", { weekday: "long" })}`}
          </p>
          {when && <p className="text-xl font-bold leading-tight text-slate-900" data-testid="my-attendance-today-date">{dayNumber(today)}</p>}
        </div>
        <div className={`flex min-w-[5.5rem] shrink-0 flex-col items-center justify-center rounded-md px-3 py-1.5 ${box}`} data-testid="my-attendance-today-status">
          <span className="text-[10px] font-medium">Status</span>
          <span className="text-sm font-bold leading-tight">{style.label}</span>
        </div>
      </div>
      <div className="my-2 border-t border-slate-100" />
      <div className="grid grid-cols-4 gap-1.5">
        <PhoneStat icon={LogIn} tone="bg-emerald-50 text-emerald-600" label="Login" value={prettyTime(row?.clock_in) || NO_TIME} className={card} testid="my-attendance-today-in" />
        <PhoneStat icon={LogOut} tone="bg-rose-50 text-rose-600" label="Logout" value={prettyTime(row?.clock_out) || NO_TIME} className={card} testid="my-attendance-today-out" />
        <PhoneStat icon={Layers} tone="bg-sky-50 text-sky-600" label="Sessions" value={row?.sessions ?? 0} className={card} testid="my-attendance-today-sessions" />
        <PhoneStat icon={Clock} tone="bg-emerald-50 text-emerald-600" label="On the clock" value={hours(row?.login_minutes)} className={card} testid="my-attendance-today-login" />
      </div>
    </PhoneCard>
  );
};

const PhoneMonthCounts = ({ totals }) => (
  <PhoneCard title="This Month" icon={CalendarDays} testid="my-attendance-counts">
    <div className="grid grid-cols-4 gap-1.5">
      <PhoneStat icon={CalendarDays} tone="bg-sky-100 text-sky-600" label="Working days" value={totals?.working_days ?? 0} className="bg-sky-50/70" testid="my-attendance-working-days" />
      <PhoneStat icon={UserRound} tone="bg-emerald-100 text-emerald-600" label="Present days" value={totals?.present_days ?? 0} className="bg-emerald-50/70" testid="my-attendance-present-days" />
      <PhoneStat icon={X} tone="bg-rose-100 text-rose-600" label="Absent" value={totals?.absent_days ?? 0} className="bg-rose-50/70" testid="my-attendance-absent-days" />
      <PhoneStat icon={BriefcaseBusiness} tone="bg-violet-100 text-violet-600" label="On leave" value={totals?.leave_days ?? 0} className="bg-violet-50/70" testid="my-attendance-leave-days" />
    </div>
  </PhoneCard>
);

const PHONE_WORKLOAD_ICONS = { clients: Users, appointments: CalendarDays, treatments: FileText, consultations: FileText, completed: Check };

/** Today's book in one row. Pending is left to the desktop: it is Today's less
 *  Completed, both already here, and the row has no room for it. */
const PhoneWorkload = ({ workload }) => {
  const tiles = (WORKLOAD_TILES[workload?.kind] || []).filter(([, key]) => key !== "pending");
  if (!tiles.length) return null;
  return (
    <PhoneCard title="Today's Work" icon={ClipboardList} testid="my-attendance-workload">
      <div className={`grid gap-1.5 ${tiles.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
        {tiles.map(([label, key]) => {
          const Icon = PHONE_WORKLOAD_ICONS[key] || ClipboardList;
          return (
            <div key={key} className="min-w-0 rounded-md border border-slate-200 bg-white p-1.5" data-testid={`my-attendance-workload-${key}`}>
              <div className="flex items-center justify-between gap-1">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${key === "completed" ? "bg-emerald-50 text-emerald-600" : "bg-sky-50 text-sky-600"}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="truncate text-base font-bold text-slate-900">{workload[key] ?? 0}</span>
              </div>
              <p className="mt-1 line-clamp-2 min-h-[1.5rem] text-[10px] leading-3 text-slate-500">{label}</p>
            </div>
          );
        })}
      </div>
    </PhoneCard>
  );
};

/** The month's hours, the same figures the desktop lists, two to a row. On View History
 *  rather than the summary: the summary is kept to one screen, and the hours are the
 *  month's detail, read alongside its days. */
const PhoneHours = ({ totals, today }) => {
  const behind = (totals?.balance_minutes || 0) < 0;
  const figures = [
    ["Expected", plainHours(totals?.expected_minutes), "text-slate-900", `${totals?.working_days ?? 0} days × 8h`, "expected"],
    ["Worked", plainHours(totals?.worked_minutes), "text-emerald-600", "Actual hours", "worked"],
    ["Extra", signedHours(totals?.extra_minutes), "text-emerald-600", "Overtime", "overtime"],
    ["On breaks", plainHours(totals?.break_minutes), "text-amber-600", "Off the clock", "breaks"],
    (totals?.permission_minutes || 0) > 0 && [
      "Permission", plainHours(totals?.permission_minutes), "text-sky-600",
      `${totals?.permission_days ?? 0} day${totals?.permission_days === 1 ? "" : "s"}, approved`, "permission",
    ],
    ["Expected so far", plainHours(totals?.expected_to_date_minutes), "text-slate-900", `Up to ${dayNumber(today)}`, "expected-to-date"],
    ["Balance", signedHours(totals?.balance_minutes), behind ? "text-rose-600" : "text-emerald-600", behind ? "Behind, so far" : "In hand", "balance"],
  ].filter(Boolean);
  return (
    <PhoneCard title="Hours" icon={Clock} testid="my-attendance-hours">
      <div className="grid grid-cols-2 gap-2">
        {figures.map(([label, value, tone, sub, key]) => (
          <div key={key} className="min-w-0 rounded-md border border-slate-200 bg-white p-2" data-testid={`my-attendance-${key}`}>
            <p className="truncate text-xs text-slate-500">{label}</p>
            <p className={`text-base font-bold leading-tight ${tone}`}>{value}</p>
            <p className="truncate text-[11px] text-slate-400">{sub}</p>
          </div>
        ))}
      </div>
    </PhoneCard>
  );
};

/** Every day of the month, newest first.
 *
 *  A table on a desktop and a stack of cards on a phone. Eleven columns do not survive a
 *  phone at any font size, and the usual answer — a horizontally scrolling table — hides
 *  the columns most worth reading (what was worked, and whether it was behind).
 */
const MonthTable = ({ rows }) => {
  if (!rows.length) {
    return (
      <p className="rounded-md border border-dashed border-slate-200 bg-white py-10 text-center text-sm text-slate-400 sm:rounded-xl" data-testid="my-attendance-empty">
        Nothing recorded this month yet.
      </p>
    );
  }
  return (
    <section data-testid="my-attendance-history">
      <h3 className="flex items-center gap-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">Attendance history</h3>

      {/* Phone */}
      <ul className="divide-y divide-slate-100 sm:hidden">
        {rows.map((r) => {
          const style = statusOf(r);
          return (
            <li key={r.date} className="px-1 py-3" data-testid={`my-attendance-card-${r.date}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">
                  {dayNumber(r.date)} <span className="font-normal text-slate-400">{r.weekday}</span>
                </span>
                <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${style.cls}`}>{style.label}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {prettyTime(r.clock_in) || "—"} <span className="text-slate-300">→</span> {prettyTime(r.clock_out) || "—"}
                {r.break_minutes > 0 && <span className="text-amber-600"> · {duration(r.break_minutes)} break</span>}
              </p>
              <p className="mt-1 text-xs">
                <span className="font-semibold text-emerald-600">{hours(r.worked_minutes)}</span>
                <span className="text-slate-300"> worked · </span>
                <span className={r.balance_minutes < 0 ? "font-semibold text-rose-600" : "font-semibold text-emerald-600"}>
                  {signedHours(r.balance_minutes)}
                </span>
              </p>
              {r.permission && (
                <p className="mt-1 text-[11px] font-semibold text-sky-600" data-testid={`my-attendance-permission-${r.date}`}>
                  Permission {prettyTime(r.permission.from)}–{prettyTime(r.permission.to)} · {duration(r.permission.minutes)}
                </p>
              )}
              {r.note && <p className="mt-1 text-[11px] text-slate-400">{r.note}</p>}
            </li>
          );
        })}
      </ul>

      {/* Desktop */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm" data-testid="my-attendance-table">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2 font-semibold">Date</th>
              <th className="px-3 py-2 font-semibold">Day</th>
              <th className="px-3 py-2 text-center font-semibold">Sessions</th>
              <th className="px-3 py-2 font-semibold">Login</th>
              <th className="px-3 py-2 font-semibold">Logout</th>
              <th className="px-3 py-2 font-semibold">On the clock</th>
              <th className="px-3 py-2 font-semibold">Break</th>
              <th className="px-3 py-2 font-semibold">Work hrs</th>
              <th className="px-3 py-2 font-semibold">Balance</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((r) => {
              const style = statusOf(r);
              return (
                <tr key={r.date} className="hover:bg-slate-50/70" data-testid={`my-attendance-row-${r.date}`}>
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-700">{dayNumber(r.date)}</td>
                  <td className="px-3 py-2.5 text-slate-500">{r.weekday}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded bg-slate-100 px-1 text-[11px] font-semibold text-slate-600">
                      {r.sessions}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{prettyTime(r.clock_in) || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{prettyTime(r.clock_out) || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{hours(r.login_minutes)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-amber-600">
                    {r.break_minutes ? duration(r.break_minutes) : "—"}
                    {r.break_count > 1 && <span className="ml-1 text-[11px] text-slate-400">({r.break_count})</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-emerald-600">{hours(r.worked_minutes)}</td>
                  <td className={`whitespace-nowrap px-3 py-2.5 font-semibold ${r.balance_minutes < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {signedHours(r.balance_minutes)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}>{style.label}</span>
                  </td>
                  {/* A short day with an approved permission on it is a short day on
                      purpose, and this column is where a day says why. The permission
                      leads: it is the answer to the question the balance beside it
                      raises. */}
                  <td className="max-w-[16rem] truncate px-4 py-2.5 text-slate-400" title={[r.permission ? `Permission ${r.permission.from}–${r.permission.to}${r.permission.reason ? `: ${r.permission.reason}` : ""}` : "", r.note].filter(Boolean).join(" · ")}>
                    {r.permission && (
                      <span className="mr-1.5 whitespace-nowrap rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700" data-testid={`my-attendance-permission-${r.date}`}>
                        {duration(r.permission.minutes)} permission
                      </span>
                    )}
                    {r.note || (r.permission ? "" : "—")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

// `view`: "all" draws the whole month on one screen (desktop). On a phone the history is a
// screen of its own behind a View History button, so it is "summary" or "history" there.
const AttendanceTab = ({ view = "all" }) => {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    myAttendance(month)
      .then(setData)
      .catch((e) => setError(e?.response?.data?.detail || "Could not load your attendance"))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  // Clock In, Clock Out and the breaks are pressed in the header, not here, so the month is
  // read again after each press -- and when the tab is come back to -- instead of showing
  // the day as it stood when this page first opened.
  useEffect(() => {
    window.addEventListener(CLOCK_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener(CLOCK_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  // Memoised rather than `data?.days || []`: the fallback is a fresh array on every
  // render, which would make the lookup below recompute forever.
  const rows = useMemo(() => data?.days || [], [data]);
  // Today is the first row of the current month, and nothing at all in a past one — the
  // strip is about the day in progress, so an older month simply does not have one.
  const todayRow = useMemo(
    () => (data?.today ? rows.find((r) => r.date === data.today) : null),
    [rows, data?.today],
  );
  const isThisMonth = month === thisMonth();
  // "summary" and "history" are only ever the phone's screens; "all" is the desktop's.
  const phone = view !== "all";

  return (
    <div className={phone ? "space-y-2" : "space-y-4"} data-testid="my-profile-attendance-tab">
      {phone ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-slate-200/80 bg-white p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, -1))}
            className="rounded-md p-1.5 text-slate-600 active:bg-slate-100"
            aria-label="Previous month"
            data-testid="my-attendance-prev"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-900" data-testid="my-attendance-month">
            <CalendarDays className="h-4 w-4 text-slate-500" />
            {monthLabel(month)}
          </span>
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={isThisMonth}
            className="rounded-md p-1.5 text-slate-600 active:bg-slate-100 disabled:opacity-30"
            aria-label="Next month"
            data-testid="my-attendance-next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      ) : (
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100"
          aria-label="Previous month"
          data-testid="my-attendance-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-slate-700" data-testid="my-attendance-month">{monthLabel(month)}</span>
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, 1))}
          // Nothing to show past this month: the days have not happened, and a next arrow
          // that lands on an empty table is a control that only reports its own limit.
          disabled={isThisMonth}
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Next month"
          data-testid="my-attendance-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      )}

      {error && (
        <p className={`${phone ? "rounded-md" : "rounded-xl"} border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700`} data-testid="my-attendance-error">
          {error}
        </p>
      )}

      {loading && !data ? (
        <p className="py-16 text-center text-sm text-slate-400" data-testid="my-attendance-loading">Loading your month…</p>
      ) : (
        <>
          {view === "summary" && (
            <>
              {isThisMonth && <PhoneToday row={todayRow} today={data?.today} />}
              <PhoneMonthCounts totals={data?.totals} />
              {isThisMonth && <PhoneWorkload workload={data?.workload} />}
            </>
          )}
          {view === "history" && <PhoneHours totals={data?.totals} today={data?.today} />}
          {view === "all" && (
            <>
              {isThisMonth && <TodayStrip row={todayRow} standard={data?.standard} today={data?.today} />}
              <MonthSummary
                totals={data?.totals}
                month={month}
                today={data?.today}
                workload={isThisMonth && <TodayWorkload workload={data?.workload} />}
              />
            </>
          )}
          {view !== "summary" && <MonthTable rows={rows} />}
          {/* Said once, at the foot, rather than as a banner over the figures: the hours
              above are real either way — they are what this person pressed — and only the
              marks (leave, absent, half day) are missing without the link. */}
          {data && !data.linked && (
            <p className="hidden text-center text-xs text-slate-400 md:block" data-testid="my-attendance-unlinked">
              No employee record is linked to this login, so HR's marks — leave, absent, half day — are not shown here.
              The hours are your own clock.
            </p>
          )}
        </>
      )}
    </div>
  );
};

// ---------- my profile ----------

const WORK_TYPES = { online: "Online", offline: "Offline", both: "Online & Offline" };
const SERVICES = { physio: "Physiotherapy", fitness: "Fitness", both: "Physiotherapy & Fitness" };
const titleCase = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ---------- my photo ----------

/**
 * Upload / edit / remove for the signed-in person's own photo. `setData` is the profile's
 * setter. Nothing is uploaded straight off the picker: every photo, new or the current one
 * opened again with Edit, goes through PhotoEditor first, and only its Save sends a file —
 * a 512px square JPEG, so even a phone's full-size camera shot arrives well under the
 * server's 5MB cap.
 */
const useMyPhoto = (setData) => {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  // What the editor has open: { url, owned } — owned when it is a blob: URL this hook made
  // for a picked file, and so has to be released when the editor closes.
  const [editing, setEditing] = useState(null);

  const done = (url, message) => {
    setData((d) => (d ? { ...d, photo_url: url } : d));
    window.dispatchEvent(new CustomEvent(MY_PHOTO_CHANGED_EVENT, { detail: url }));
    toast.success(message);
  };

  const closeEditor = () => {
    setEditing((cur) => {
      if (cur?.owned) URL.revokeObjectURL(cur.url);
      return null;
    });
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!String(file.type).startsWith("image/")) { toast.error("Choose a JPG, PNG or WEBP image"); return; }
    setEditing({ url: URL.createObjectURL(file), owned: true });
  };

  const save = async (file) => {
    setBusy(true);
    try {
      const { photo_url } = await uploadMyPhoto(file);
      done(photo_url, "Profile photo updated");
      closeEditor();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not upload the photo");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeMyPhoto();
      done("", "Profile photo removed");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not remove the photo");
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    remove,
    pick: () => inputRef.current?.click(),
    edit: (url) => { if (url) setEditing({ url, owned: false }); },
    elements: (
      <>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFile} data-testid="my-profile-photo-input" />
        <PhotoEditor source={editing?.url || null} saving={busy} onCancel={closeEditor} onSave={save} title="Adjust profile photo" />
      </>
    ),
  };
};

/** The avatar with a camera badge on it; tapping either opens the picker. */
const PhotoAvatar = ({ person, size, photo }) => (
  <div className="relative shrink-0" style={{ width: size, height: size }}>
    <button
      type="button"
      onClick={photo.pick}
      disabled={photo.busy}
      className="block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
      aria-label={person?.photo_url ? "Change profile photo" : "Upload profile photo"}
      data-testid="my-profile-photo"
    >
      <EmployeeAvatar employee={person} size={size} className="text-2xl" />
    </button>
    {photo.busy && (
      <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white/70">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
      </span>
    )}
    <button
      type="button"
      onClick={photo.pick}
      disabled={photo.busy}
      className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-emerald-600 text-white shadow hover:bg-emerald-700 disabled:opacity-60"
      aria-label="Choose a photo"
      data-testid="my-profile-photo-camera"
    >
      <Camera className="h-3.5 w-3.5" />
    </button>
  </div>
);

const PhotoActions = ({ person, photo, className = "" }) => (
  <div className={`flex items-center gap-3 text-xs font-semibold ${className}`}>
    <button
      type="button"
      onClick={photo.pick}
      disabled={photo.busy}
      className="text-emerald-700 hover:underline disabled:opacity-60"
      data-testid="my-profile-photo-upload"
    >
      {person?.photo_url ? "Change photo" : "Upload photo"}
    </button>
    {person?.photo_url && (
      <>
        <button
          type="button"
          onClick={() => photo.edit(person.photo_url)}
          disabled={photo.busy}
          className="text-sky-700 hover:underline disabled:opacity-60"
          data-testid="my-profile-photo-edit"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={photo.remove}
          disabled={photo.busy}
          className="text-rose-600 hover:underline disabled:opacity-60"
          data-testid="my-profile-photo-remove"
        >
          Remove
        </button>
      </>
    )}
  </div>
);

const ProfileTab = ({ roleLabel }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const photo = useMyPhoto(setData);

  useEffect(() => {
    let live = true;
    myProfile()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e?.response?.data?.detail || "Could not load your profile"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) {
    return <p className="py-16 text-center text-sm text-slate-400" data-testid="my-profile-loading">Loading your profile…</p>;
  }
  if (error) {
    return (
      <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" data-testid="my-profile-error">
        {error}
      </p>
    );
  }

  const account = data?.account || {};
  const hasBank = data.bank_name || data.bank_account || data.ifsc;

  return (
    <div className="space-y-4" data-testid="my-profile-profile-tab">
      {!data.linked && (
        <p className="hidden rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 md:block" data-testid="my-profile-unlinked">
          This login is not linked to an employee record, so only what the account itself carries is shown below.
          Ask HR to link it from Credentials.
        </p>
      )}

      {/* Top-aligned, so a shorter panel keeps its own height rather than stretching to
          match the one beside it and trailing empty space under its last field. The two
          full-width rows — the address, which runs long, and the two money/contact panels
          that are short — keep the grid from ending on a ragged single cell. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Panel title="Personal information" icon={UserRound} testid="my-profile-personal">
          <div className="mb-4 flex items-center gap-3 border-b border-slate-100 pb-4">
            {photo.elements}
            <PhotoAvatar person={data} size={64} photo={photo} />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-slate-800" data-testid="my-profile-name">{data.full_name}</p>
              <p className="truncate text-xs text-slate-500">{data.designation || roleLabel}</p>
              {data.employee_code && (
                <span className="mt-1 inline-block rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700" data-testid="my-profile-code">
                  {data.employee_code}
                </span>
              )}
              <PhotoActions person={data} photo={photo} className="mt-1.5" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Email" value={data.email} testid="my-profile-email" />
            <Field label="Phone" value={data.phone} testid="my-profile-phone" />
            <Field label="Date of birth" value={prettyDate(data.dob)} />
            <Field label="Gender" value={titleCase(data.gender)} />
            <Field label="Blood group" value={data.blood_group} />
            <Field label="Marital status" value={titleCase(data.marital_status)} />
            <Field label="Father's name" value={data.father_name} />
            <Field label="Mother's name" value={data.mother_name} />
          </div>
        </Panel>

        <Panel title="Employment details" icon={BriefcaseBusiness} testid="my-profile-employment">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {/* The employee code where there is one, and the login's own short id where
                there is not — the header dialog called that the Employee ID for a year,
                and an account with nobody on the books behind it still has to answer
                "which id am I". */}
            <Field label="Employee ID" value={data.employee_code || account.short_id} testid="my-profile-employee-id" />
            <Field label="Role" value={roleLabel || titleCase(account.role)} testid="my-profile-role" />
            <Field label="Designation" value={data.designation} />
            <Field label="Department" value={data.department} />
            <Field label="Branch" value={account.branch_name} testid="my-profile-branch" />
            <Field label="Works" value={[WORK_TYPES[data.work_type], SERVICES[data.service]].filter(Boolean).join(" · ")} />
            <Field label="Joining date" value={prettyDate(data.joining_date)} testid="my-profile-joining" />
            <Field label="Reporting to" value={data.reporting_to} />
            <Field label="Status" value={titleCase(data.status)} />
            <Field label="Account created" value={prettyDate(String(account.created_at || "").slice(0, 10))} />
            {/* Masked to the last four by the server, so the full number never reaches the
                browser — see _masked in backend/routers/v3_me.py. Enough to confirm which
                document HR has on file, which is what this row is read for. */}
            <Field label="PAN" value={data.pan} />
            <Field label="Aadhaar" value={data.aadhar} />
          </div>
        </Panel>

        <Panel title="Address" icon={Home} className="lg:col-span-2" testid="my-profile-address">
          <p className="whitespace-pre-line break-words text-sm font-medium text-slate-700" data-testid="my-profile-address-value">
            {data.address || "—"}
          </p>
        </Panel>

        <Panel title="Emergency contact" icon={ShieldAlert} testid="my-profile-emergency">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Contact name" value={data.emergency_contact_name} />
            <Field label="Contact phone" value={data.emergency_contact_phone} />
          </div>
        </Panel>

        <Panel title="Bank details" icon={Banknote} testid="my-profile-bank">
          {hasBank ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Bank name" value={data.bank_name} />
              <Field label="Account number" value={data.bank_account} />
              <Field label="IFSC" value={data.ifsc} />
            </div>
          ) : (
            <p className="text-sm text-slate-400">Nothing on file.<span className="hidden md:inline"> HR adds this on your employee record.</span></p>
          )}
        </Panel>
      </div>

      {/* Where a correction goes. Everything above is HR's to write — a page that shows a
          wrong phone number and says nothing about how to fix it makes the reader hunt for
          somebody to tell. */}
      <p className="hidden text-center text-xs text-slate-400 md:block" data-testid="my-profile-footnote">
        Apart from your photo, these details are held by HR. Anything wrong here is corrected on your employee record — ask HR to update it.
      </p>
    </div>
  );
};

/** Profile on a phone: no panels, one label/value line after another. */
const PhoneProfileList = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const photo = useMyPhoto(setData);

  useEffect(() => {
    let live = true;
    myProfile()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e?.response?.data?.detail || "Could not load your profile"); });
    return () => { live = false; };
  }, []);

  if (error) {
    return (
      <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" data-testid="my-profile-error">
        {error}
      </p>
    );
  }
  if (!data) {
    return <p className="py-16 text-center text-sm text-slate-400" data-testid="my-profile-loading">Loading your profile…</p>;
  }

  const account = data.account || {};
  const active = String(data.status || "").toLowerCase() === "active";
  const rows = [
    ["Name", data.full_name, "my-profile-name"],
    ["Date of Birth", prettyDate(data.dob)],
    ["Employee ID", data.employee_code || account.short_id, "my-profile-employee-id"],
    ["Branch", account.branch_name, "my-profile-branch"],
    ["Designation", data.designation],
    ["Department", data.department],
    ["Email", data.email, "my-profile-email"],
    ["Gender", titleCase(data.gender)],
    ["Marital Status", titleCase(data.marital_status)],
  ];

  return (
    <div data-testid="my-profile-profile-tab">
      <div className="flex flex-col items-center gap-2 border-b border-slate-100 pb-4 pt-1">
        {photo.elements}
        <PhotoAvatar person={data} size={88} photo={photo} />
        <PhotoActions person={data} photo={photo} className="text-sm" />
      </div>
      <dl className="divide-y divide-slate-100 px-1">
        {rows.map(([label, value, testid]) => (
          <div key={label} className="flex gap-2 py-3 text-sm">
            <dt className="w-32 shrink-0 text-slate-500">{label}</dt>
            <dd className="min-w-0 flex-1 break-all font-medium text-slate-800" data-testid={testid}>{value || "—"}</dd>
          </div>
        ))}
        <div className="flex items-center gap-2 py-3 text-sm">
          <dt className="w-32 shrink-0 text-slate-500">Status</dt>
          <dd className="min-w-0 flex-1">
            {data.status ? (
              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                {titleCase(data.status)}
              </span>
            ) : <span className="font-medium text-slate-800">—</span>}
          </dd>
        </div>
        <div className="flex gap-2 py-3 text-sm">
          <dt className="w-32 shrink-0 text-slate-500">Joining Date</dt>
          <dd className="min-w-0 flex-1 font-medium text-slate-800" data-testid="my-profile-joining">{prettyDate(data.joining_date) || "—"}</dd>
        </div>
      </dl>
    </div>
  );
};

// ---------- monthly calendar ----------

const ORG_WIDE = ["super_admin", "business_dev"];

/** My branch's Working / Leave days. Super Admin and BDE run every branch, so they pick one. */
const MonthlyCalendarTab = ({ user }) => {
  const orgWide = ORG_WIDE.includes(String(user?.role || "").trim().toLowerCase());
  const own = [...new Set([user?.branch_id, ...(user?.branch_ids || [])].filter(Boolean))];
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(own[0] || "");

  useEffect(() => {
    if (!orgWide && own.length < 2) return;
    getBranches()
      .then((rows) => {
        const list = (rows || []).filter((b) => orgWide || own.includes(b.id));
        setBranches(list);
        setBranchId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgWide]);

  if (!branchId) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400" data-testid="my-calendar-no-branch">
        You are not posted to a branch yet, so there is no branch calendar to show.
      </p>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4" data-testid="my-calendar-tab">
      {branches.length > 1 && (
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 sm:w-72"
          data-testid="my-calendar-branch"
        >
          {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name || b.name || b.id}</option>)}
        </select>
      )}
      <BranchMonthlyCalendar branchId={branchId} />
    </div>
  );
};

// ---------- the phone menu ----------

/** True below md — the width the boards' bottom bars are drawn at. Read rather than left to
 *  CSS so only one of the two layouts is mounted, and a month is not fetched twice. */
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

// The same sections as the tabs, as a settings list: one row per section, the title alone.
const MENU_ITEMS = [
  { key: "profile", title: "Profile", icon: UserRound },
  { key: "security", title: "Account", icon: KeyRound },
  { key: "attendance", title: "Attendance", icon: Clock },
  { key: "calendar", title: "Monthly Calendar", icon: CalendarDays },
  { key: "timeoff", title: "Time Off", icon: CalendarOff },
];

/**
 * My Profile on a phone, laid out like a messenger's settings: who I am at the top, then
 * one row per section, each opening full-screen with a back arrow. Five segmented tabs
 * across a phone is five glyphs to learn; a list says what each one is.
 */
// `onBack` is for a host with no bottom bar to leave by: the menu then carries its own way out.
const PhoneProfileMenu = ({ user, onLogout, hideTimeOff, onBack }) => {
  const [open, setOpen] = useState(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const items = hideTimeOff ? MENU_ITEMS.filter((i) => i.key !== "timeoff") : MENU_ITEMS;

  if (open) {
    const history = open === "attendance-history";
    const item = history ? { title: "Attendance History" } : items.find((i) => i.key === open);
    return (
      <div className="space-y-3" data-testid={`my-profile-screen-${open}`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(history ? "attendance" : null)}
            className="-ml-1 rounded-full p-1.5 text-slate-700 active:bg-slate-100"
            aria-label="Back"
            data-testid="my-profile-screen-back"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-slate-800">{item?.title}</h2>
          {open === "attendance" && (
            <button
              type="button"
              onClick={() => setOpen("attendance-history")}
              className="shrink-0 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 active:bg-sky-100"
              data-testid="my-attendance-view-history"
            >
              View History
            </button>
          )}
        </div>
        {open === "calendar" ? <MonthlyCalendarTab user={user} />
          : open === "attendance" ? <AttendanceTab view="summary" />
          : history ? <AttendanceTab view="history" />
          : open === "timeoff" ? <TimeOffTab />
            : open === "security" ? <SecurityTab />
              : <PhoneProfileList />}
      </div>
    );
  }

  return (
    <div className="-mx-1 rounded-2xl bg-white px-4 pb-4 pt-1 shadow-sm" data-testid="my-profile-menu">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 mt-3 rounded-full p-1.5 text-slate-700 active:bg-slate-100"
          aria-label="Back"
          data-testid="my-profile-back"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      <ul className="divide-y divide-slate-100">
        {items.map(({ key, title, icon: Icon }) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => setOpen(key)}
              className="flex w-full items-center gap-4 py-3.5 text-left active:bg-slate-50"
              data-testid={`my-profile-menu-${key}`}
            >
              <Icon className="h-5 w-5 shrink-0 text-slate-600" />
              <span className="min-w-0 flex-1 text-[15px] font-medium text-slate-800">{title}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
            </button>
          </li>
        ))}
        {onLogout && (
          <li>
            <button
              type="button"
              onClick={() => setConfirmLogout(true)}
              className="flex w-full items-center gap-4 py-3.5 text-left text-rose-600 active:bg-rose-50"
              data-testid="my-profile-menu-logout"
            >
              <LogOut className="h-5 w-5 shrink-0" />
              <span className="text-[15px] font-medium">Log out</span>
            </button>
          </li>
        )}
      </ul>

      {/* The row sits last in a list a thumb scrolls through, so a stray tap there would end
          the session; this asks once. Phones only — the menu itself is phones only.
          Drawn at 80%: the box's width and corners are cut to 80% here, and everything
          inside it, padding included, is zoomed to 0.8. The box itself is not zoomed — it is
          centred with left 50% and a translate, and zoom on a fixed box pulls it off centre. */}
      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent className="w-[calc(80%-1.6rem)] max-w-[19.2rem] gap-0 rounded-[13px] p-0" data-testid="my-profile-logout-confirm">
          <div className="grid gap-5 p-5" style={{ zoom: 0.8 }}>
            <AlertDialogHeader className="items-center space-y-3 text-center sm:text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <LogOut className="h-6 w-6" />
              </span>
              <AlertDialogTitle className="text-base text-slate-800">Log out?</AlertDialogTitle>
              <AlertDialogDescription className="text-[13px] text-slate-500">
                You will need your password to sign back in.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:space-x-0">
              <AlertDialogCancel className="mt-0 h-11 rounded-xl" data-testid="my-profile-logout-cancel">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onLogout}
                className="h-11 rounded-xl bg-rose-600 text-white hover:bg-rose-700"
                data-testid="my-profile-logout-confirm-button"
              >
                Log out
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// ---------- the page ----------

// The Physio board's phone bar: five tabs in one row, so four go to their glyph and Leave
// goes to its word. Leave is the one kept in words because no glyph says "leave" as
// plainly as the word does.
const PHONE_BAR_MODES = { calendar: "icon", attendance: "icon", timeoff: "text", profile: "icon", security: "icon" };
const PHONE_BAR_TABS = TABS.map((t) => ({ ...t, phone: PHONE_BAR_MODES[t.key] }));

/**
 * `phoneBar` is for a host that already frames this page on a phone — the Physio board,
 * which opens it from its own bottom bar. Below sm it drops the Back button and the name
 * (the bar underneath is the way out, and the header above already carries the name) and
 * puts all five tabs on one row. From sm up, and for every other host, the page is as it was.
 */
/**
 * `onLogout` is for a host whose phone header no longer carries a logout — Super Admin,
 * whose bottom bar opens this page. It is handed to the Security tab, which draws the
 * button below md; from md up the header's own logout is on screen.
 */
// `keepBack` keeps Back on a phone with the one-row bar, for a host with no bottom bar to
// leave by (BDE, Accountant open this from the header).
// `phoneMenu` swaps the tabs for PhoneProfileMenu below md, for every host.
// `timeOffInHeader` is for a host whose phone header carries Time Off as its own button
// (Physio, Consultant): the phone menu then leaves the row out, so it is not in two places.
// The desktop tabs keep it — the header button is phones only.
export const MyProfilePage = ({ user, roleLabel, onBack, onLogout, phoneBar = false, keepBack = false, hideTimeOff = false, phoneMenu = true, timeOffInHeader = false }) => {
  const [tab, setTab] = useState("attendance");
  const phone = usePhone();
  // Super Admin has no one above them to ask for leave, so the tab is not offered.
  const tabs = hideTimeOff ? TABS.filter((t) => t.key !== "timeoff") : TABS;
  const phoneTabs = hideTimeOff ? PHONE_BAR_TABS.filter((t) => t.key !== "timeoff") : PHONE_BAR_TABS;

  if (phoneMenu && phone) {
    return <PhoneProfileMenu user={user} onLogout={onLogout} hideTimeOff={hideTimeOff || timeOffInHeader} onBack={keepBack || !phoneBar ? onBack : null} />;
  }

  return (
    <div className="space-y-4" data-testid="my-profile-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={`min-w-0 items-center gap-3 ${phoneBar && !keepBack ? "hidden sm:flex" : "flex"}`}>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50"
            data-testid="my-profile-back"
          >
            Back
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-emerald-700 sm:text-xl" data-testid="my-profile-greeting">
              {user?.full_name}
            </h2>
          </div>
        </div>
        {/* Full width on a phone, where the bar is its own row of four columns; sized to
            its labels from sm up. It used to be pinned to w-96, which fitted three tabs
            and cut all four down to "Atte…", "Tim…", "My …", "Sec…" — a tab clipped to
            four characters is not a tab. shrink-0 keeps the greeting beside it from
            squeezing it back into an ellipsis; the row wraps instead. */}
        <div className="w-full sm:w-auto sm:shrink-0" data-testid="my-profile-tabs-wrap">
          {phoneBar
            ? <SegmentedTabs tabs={phoneTabs} value={tab} onChange={setTab} testid="my-profile-tabs" fit />
            : <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} testid="my-profile-tabs" mobileCols={3} fit />}
        </div>
      </div>

      {/* Both tabs stay mounted once opened would mean two months of requests for a screen
          somebody opened to read one thing, so each is mounted only while it is the tab.
          Switching back re-reads, which is right for a page whose whole subject is what
          happened today. */}
      {tab === "calendar" ? <MonthlyCalendarTab user={user} />
        : tab === "attendance" ? <AttendanceTab />
        : tab === "timeoff" && !hideTimeOff ? <TimeOffTab />
          : tab === "security" ? <SecurityTab onLogout={onLogout} />
            : <ProfileTab roleLabel={roleLabel} />}
    </div>
  );
};

export default MyProfilePage;
