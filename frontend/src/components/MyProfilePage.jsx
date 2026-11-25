/**
 * MY PROFILE — the page everybody has about themselves, whatever desk they sit at.
 *
 *     Attendance     the month I have worked, and today so far
 *     Account        what this company holds about me, and (its last section, Security)
 *                    the password and second factor on my own login
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
import { createPortal } from "react-dom";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  History,
  KeyRound,
  Layers,
  LifeBuoy,
  Loader2,
  LogIn,
  LogOut,
  Stethoscope,
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
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { PermissionRequestBoard, TimeOffTab } from "@/components/MyTimeOff";
// And the fourth, split out for the same reason — it is the other tab that writes, and
// what it writes is the login itself.
import { SecurityTab } from "@/components/MySecurity";
import { EmailVerifiedTag } from "@/components/EmailId";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { PhotoEditor } from "@/components/ui/photo-editor";
import { MySign } from "@/components/MySign";
import { StatTile } from "@/components/ui/stat-tile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
// The same formatters the header clock and HR's register read a day with, so an hour and
// a half is not "1h 30m" here and "90m" three screens away.
import { duration, hours, prettyTime } from "@/lib/clock";
import { displayPhone } from "@/lib/phone";
import { versionDetail, versionLabel } from "@/lib/version";
import { GetHelpDialog } from "@/components/GetHelpDialog";

// The sidebar from md up. A phone has its own list: see MENU_ITEMS.
const TABS = [
  // First: the month the branch is open, which is the frame the other tabs are read in.
  { key: "calendar", label: "Monthly Calendar", icon: CalendarDays },
  // Leave and permission requests: what was the Attendance tab's Request popup, as a tab.
  // Not offered to Super Admin, who has no one above them to ask.
  { key: "timeoff", label: "Permission Request", icon: CalendarOff },
  { key: "attendance", label: "Attendance", icon: Clock },
  // Security is no longer a tab of its own: it is the last section inside Account.
  { key: "profile", label: "Account", icon: UserRound },
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

// ---------- attendance, on a desktop ----------
//
// Branch Admin's look: each group of figures is a strip of StatTile `arrow="desk"` cards —
// the 5px-cornered card with the figure in its colour that the Zumba, Fitness and Review
// strips wear — under a heading of its own, and the month's days are a Card holding a
// table with the slate header those boards use. The phone keeps its own cards below.

// One hex per colour, for StatTile's inline styles (see ui/stat-tile on why not classes).
const HEX = {
  slate: "#334155",
  sky: "#0284c7",
  emerald: "#059669",
  rose: "#e11d48",
  amber: "#d97706",
  violet: "#7c3aed",
};

// The register's chip on a desktop: the same tints as STATUS_STYLES with the border the
// Branch Admin lists put round theirs.
const STATUS_BORDER = {
  present: "border-emerald-200",
  late: "border-amber-200",
  half_day: "border-orange-200",
  absent: "border-rose-200",
  leave: "border-violet-200",
  week_off: "border-slate-200",
  holiday: "border-sky-200",
  working: "border-emerald-200",
  on_break: "border-amber-200",
  done: "border-emerald-200",
  out: "border-slate-200",
};

const StatusChip = ({ row, className = "" }) => {
  const style = statusOf(row || {});
  const border = STATUS_BORDER[row?.status || row?.state] || STATUS_BORDER.out;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${border} ${style.cls} ${className}`}>
      {style.label}
    </span>
  );
};

/** A heading over a strip of cards: an icon in the board's blue, the title, and whatever
 *  belongs on the right of that line. */
const DeskSection = ({ title, icon: Icon, aside, children, testid, hideHeading = false }) => (
  <section data-testid={testid}>
    {!hideHeading && <div className="mb-2 flex min-h-[1.75rem] flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <Icon className="h-4 w-4 text-sky-600" />
        {title}
      </h3>
      {aside}
    </div>}
    {children}
  </section>
);

/** Today: the day as it stands right now — when the clock went in and out, how many times,
 *  and how long it has run. The status rides on the heading line beside the standard day. */
const TodayStrip = ({ row, standard, today, hideHeading = false }) => {
  const when = today ? new Date(`${today}T00:00:00`) : null;
  return (
    <DeskSection
      title={
        <>
          Today
          {when && (
            <span className="font-normal text-slate-500" data-testid="my-attendance-today-date">
              · {dayNumber(today)} · {when.toLocaleDateString("en-GB", { weekday: "long" })}
            </span>
          )}
        </>
      }
      icon={Clock}
      aside={
        <div className="flex items-center gap-2">
          {standard?.start && (
            <span className="rounded-[5px] border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500">
              Standard {standard.start} – {standard.end}
            </span>
          )}
          <span data-testid="my-attendance-today-status"><StatusChip row={row} /></span>
        </div>
      }
      testid="my-attendance-today"
      hideHeading={hideHeading}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Login" value={prettyTime(row?.clock_in) || "—"} arrow="desk" color={HEX.emerald} testid="my-attendance-today-in" />
        <StatTile label="Logout" value={prettyTime(row?.clock_out) || "—"} arrow="desk" color={HEX.rose} testid="my-attendance-today-out" />
        <StatTile label="Sessions" value={row?.sessions ?? 0} arrow="desk" color={HEX.sky} testid="my-attendance-today-sessions" />
        <StatTile label="On the clock" value={hours(row?.login_minutes)} arrow="desk" color={HEX.emerald} testid="my-attendance-today-login" />
      </div>
    </DeskSection>
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

// text-sky-600 → HEX.sky, for the desktop's cards off the same table the phone reads.
const toneHex = (tone) => HEX[String(tone).split("-")[1]] || HEX.slate;

const TodayWorkload = ({ workload }) => {
  const tiles = WORKLOAD_TILES[workload?.kind];
  if (!tiles) return null;
  return (
    <DeskSection title="Today's work" icon={ClipboardList} testid="my-attendance-workload">
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-4 ${tiles.length === 5 ? "xl:grid-cols-5" : ""}`}>
        {tiles.map(([label, key, tone]) => (
          <StatTile key={key} label={label} value={workload[key] ?? 0} arrow="desk" color={toneHex(tone)} testid={`my-attendance-workload-${key}`} />
        ))}
      </div>
    </DeskSection>
  );
};

/** The month's counts, and then its hours. Two strips because they answer two questions —
 *  how many days, and how many hours — and one strip of twelve cards answers neither.
 *  `todayStrip` is Today's strip, set beside the counts on a wide screen. */
const MonthSummary = ({ totals, month, today, todayStrip, workload, compactLayout = false }) => {
  const behind = (totals?.balance_minutes || 0) < 0;
  // Only when there is some. A "0.0h" permission card on every month of every person who
  // has never asked for an hour off would be a card explaining a feature rather than a
  // figure reporting a month.
  const permission = (totals?.permission_minutes || 0) > 0;
  return (
    <>
      <div className={`grid ${compactLayout ? "gap-3" : "gap-4"} ${todayStrip ? (compactLayout ? "xl:grid-cols-[4fr_3fr]" : "xl:grid-cols-2") : ""}`}>
        {todayStrip}
        <DeskSection
          title={<>This month <span className="font-normal text-slate-500">· {monthLabel(month)}</span></>}
          icon={CalendarDays}
          testid="my-attendance-counts"
          hideHeading={compactLayout}
        >
          <div className={`grid gap-3 ${compactLayout ? "grid-cols-3" : "grid-cols-2 md:grid-cols-4"}`}>
            <StatTile label="Working days" value={totals?.working_days ?? 0} arrow="desk" color={HEX.slate} testid="my-attendance-working-days" />
            <StatTile label="Present days" value={totals?.present_days ?? 0} arrow="desk" color={HEX.sky} testid="my-attendance-present-days" />
            <StatTile label="Absent" value={totals?.absent_days ?? 0} arrow="desk" color={totals?.absent_days ? HEX.rose : HEX.slate} testid="my-attendance-absent-days" />
            {!compactLayout && <StatTile label="On leave" value={totals?.leave_days ?? 0} arrow="desk" color={HEX.violet} testid="my-attendance-leave-days" />}
          </div>
        </DeskSection>
      </div>

      {workload}

      {!compactLayout && <DeskSection
        title={<>Hours <span className="font-normal text-slate-500">· {monthLabel(month)}</span></>}
        icon={Clock}
        testid="my-attendance-hours"
      >
        <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${permission ? "xl:grid-cols-7" : "xl:grid-cols-6"}`}>
          <StatTile
            label="Expected"
            value={plainHours(totals?.expected_minutes)}
            sub={`${totals?.working_days ?? 0} days × 8h`}
            arrow="desk"
            color={HEX.slate}
            testid="my-attendance-expected"
          />
          <StatTile label="Worked" value={plainHours(totals?.worked_minutes)} sub="Actual hours" arrow="desk" color={HEX.emerald} testid="my-attendance-worked" />
          <StatTile label="Extra" value={signedHours(totals?.extra_minutes)} sub="Overtime" arrow="desk" color={HEX.emerald} testid="my-attendance-overtime" />
          <StatTile label="On breaks" value={plainHours(totals?.break_minutes)} sub="Off the clock" arrow="desk" color={HEX.amber} testid="my-attendance-breaks" />
          {/* Beside the breaks, because both are time out of a working day. The
              difference is that somebody signed this one off in advance — which is also
              why it is worth seeing next to a balance it helps explain. */}
          {permission && (
            <StatTile
              label="Permission"
              value={plainHours(totals?.permission_minutes)}
              sub={`${totals?.permission_days ?? 0} day${totals?.permission_days === 1 ? "" : "s"}, approved`}
              arrow="desk"
              color={HEX.sky}
              testid="my-attendance-permission"
            />
          )}
          <StatTile
            label="Expected so far"
            value={plainHours(totals?.expected_to_date_minutes)}
            sub={`Up to ${dayNumber(today)}`}
            arrow="desk"
            color={HEX.slate}
            testid="my-attendance-expected-to-date"
          />
          {/* Measured against the days that have happened, not against the whole month —
              the backend sends both, and a balance of −150h on the 5th would be the
              calendar talking, not the person. */}
          <StatTile
            label="Balance"
            value={signedHours(totals?.balance_minutes)}
            sub={behind ? "Behind, so far" : "In hand"}
            arrow="desk"
            color={behind ? HEX.rose : HEX.emerald}
            testid="my-attendance-balance"
          />
        </div>
      </DeskSection>}
    </>
  );
};

// The status's colour as a card's left edge, for Recent Activity.
const STATUS_ACCENT = {
  present: "border-l-emerald-500",
  late: "border-l-amber-500",
  half_day: "border-l-orange-500",
  absent: "border-l-rose-500",
  leave: "border-l-violet-500",
  week_off: "border-l-slate-300",
  holiday: "border-l-sky-500",
  working: "border-l-emerald-500",
  on_break: "border-l-amber-500",
  done: "border-l-emerald-500",
  out: "border-l-slate-200",
};

/** The last six days of the month as cards, under the tiles. The whole month is the
 *  History button's table; View Full Month opens it. */
const RecentActivity = ({ rows, onViewAll }) => {
  const days = rows.slice(0, 6);
  if (!days.length) return null;
  const bookings = rows.some((r) => r.appointments != null || r.consultations != null);
  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm" data-testid="my-attendance-recent">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <CalendarClock className="h-4 w-4 text-sky-600" />
          Recent Activity
        </h3>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-xs font-semibold text-sky-600 hover:bg-sky-50"
          data-testid="my-attendance-recent-all"
        >
          View Full Month
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {days.map((r) => {
          const when = new Date(`${r.date}T00:00:00`);
          const figures = bookings
            ? [[CalendarDays, "Appointments", r.appointments ?? 0], [Stethoscope, "Consultations", r.consultations ?? 0]]
            : [[LogIn, "Login", prettyTime(r.clock_in) || "—"], [LogOut, "Logout", prettyTime(r.clock_out) || "—"]];
          return (
            <div
              key={r.date}
              className={`flex items-center gap-4 rounded-md border border-l-[3px] border-slate-200 bg-white px-4 py-3 ${STATUS_ACCENT[r.status || r.state] || STATUS_ACCENT.out}`}
              data-testid={`my-attendance-recent-${r.date}`}
            >
              <div className="w-10 shrink-0 text-center">
                <p className="text-xl font-bold leading-none text-slate-800">{when.getDate()}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {when.toLocaleDateString("en-GB", { month: "short" })}
                </p>
                <p className="text-[10px] text-slate-400">{when.toLocaleDateString("en-GB", { weekday: "short" })}</p>
              </div>
              <span className="h-10 w-px shrink-0 bg-slate-100" />
              <div className="min-w-0 max-w-[11rem] flex-1 space-y-1.5">
                {figures.map(([Icon, label, value]) => (
                  <p key={label} className="flex items-center gap-2 text-xs text-slate-500">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{label}</span>
                    <span className="ml-auto text-sm font-semibold tabular-nums text-slate-800">{value}</span>
                  </p>
                ))}
              </div>
              <StatusChip row={r} className="ml-auto shrink-0" />
            </div>
          );
        })}
      </div>
    </Card>
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

const PhoneMonthCounts = ({ totals, compactLayout = false }) => (
  <PhoneCard title="This Month" icon={CalendarDays} testid="my-attendance-counts">
    <div className={`grid gap-1.5 ${compactLayout ? "grid-cols-3" : "grid-cols-4"}`}>
      <PhoneStat icon={CalendarDays} tone="bg-sky-100 text-sky-600" label="Working days" value={totals?.working_days ?? 0} className="bg-sky-50/70" testid="my-attendance-working-days" />
      <PhoneStat icon={UserRound} tone="bg-emerald-100 text-emerald-600" label="Present days" value={totals?.present_days ?? 0} className="bg-emerald-50/70" testid="my-attendance-present-days" />
      <PhoneStat icon={X} tone="bg-rose-100 text-rose-600" label="Absent" value={totals?.absent_days ?? 0} className="bg-rose-50/70" testid="my-attendance-absent-days" />
      {!compactLayout && <PhoneStat icon={BriefcaseBusiness} tone="bg-violet-100 text-violet-600" label="On leave" value={totals?.leave_days ?? 0} className="bg-violet-50/70" testid="my-attendance-leave-days" />}
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
const MonthTable = ({ rows, compactLayout = false }) => {
  const hasBookingCounts = rows.some((row) => row.appointments != null || row.consultations != null);
  if (!rows.length) {
    return (
      <p className="rounded-md border border-dashed border-slate-200 bg-white py-10 text-center text-sm text-slate-400 sm:rounded-xl" data-testid="my-attendance-empty">
        Nothing recorded this month yet.
      </p>
    );
  }
  return (
    <section data-testid="my-attendance-history">
      <h3 className="flex items-center gap-2 border-b border-slate-100 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400 sm:hidden">Attendance history</h3>

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

      {/* Desktop: a Card holding the slate-headed table the Branch Admin lists use. */}
      <Card className={`hidden overflow-hidden border-slate-200 shadow-sm sm:block ${compactLayout ? "rounded-lg" : ""}`}>
        <CardContent className="p-0">
          {!compactLayout && (<div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ClipboardList className="h-4 w-4 text-sky-600" />
              Day by day
            </h4>
            <span className="text-xs text-slate-400">{rows.length} day{rows.length === 1 ? "" : "s"}</span>
          </div>)}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-left text-sm" data-testid="my-attendance-table">
              <thead className="bg-slate-500 text-[11px] font-bold uppercase tracking-wider text-white">
                <tr className="whitespace-nowrap">
                  <th className="w-[14%] px-5 py-3">Date</th>
                  {!compactLayout && <th className="px-3 py-2.5">Day</th>}
                  <th className="w-[10%] px-3 py-3 text-center">Sessions</th>
                  <th className="w-[12%] px-3 py-3">Login</th>
                  <th className="w-[12%] px-3 py-3">Logout</th>
                  {!compactLayout && <th className="px-3 py-2.5">On the clock</th>}
                  <th className="w-[10%] px-3 py-3">Break</th>
                  {!compactLayout && <th className="px-3 py-2.5">Work hrs</th>}
                  {!compactLayout && <th className="px-3 py-2.5">Balance</th>}
                  {compactLayout && hasBookingCounts && <><th className="w-[13%] px-3 py-3 text-center">Appointments</th><th className="w-[13%] px-3 py-3 text-center">Consultations</th></>}
                  <th className="px-5 py-3 text-center">Status</th>
                  {!compactLayout && <th className="px-4 py-2.5">Note</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.date} className="whitespace-nowrap align-middle hover:bg-slate-50/60" data-testid={`my-attendance-row-${r.date}`}>
                    <td className="px-5 py-3 text-sm font-semibold leading-5 text-slate-800">{dayNumber(r.date)}</td>
                    {!compactLayout && <td className="px-3 py-3 text-xs leading-5 text-slate-500">{r.weekday}</td>}
                    <td className="px-3 py-3 text-center">
                      <span className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-1.5 text-xs font-bold text-slate-600">
                        {r.sessions}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-sm leading-5 text-slate-700">{prettyTime(r.clock_in) || "—"}</td>
                    <td className="px-3 py-3 text-sm leading-5 text-slate-700">{prettyTime(r.clock_out) || "—"}</td>
                    {!compactLayout && <td className="px-3 py-3 text-xs leading-5 text-slate-600">{hours(r.login_minutes)}</td>}
                    <td className={`px-3 py-3 text-sm leading-5 ${r.break_minutes ? "text-amber-600" : "text-slate-400"}`}>
                      {r.break_minutes ? duration(r.break_minutes) : "—"}
                      {r.break_count > 1 && <span className="ml-1 text-[11px] text-slate-400">({r.break_count})</span>}
                    </td>
                    {!compactLayout && <td className="px-3 py-3 text-xs font-semibold leading-5 text-emerald-700">{hours(r.worked_minutes)}</td>}
                    {!compactLayout && <td className={`px-3 py-3 text-xs font-semibold leading-5 ${r.balance_minutes < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                      {signedHours(r.balance_minutes)}
                    </td>}
                    {compactLayout && hasBookingCounts && <><td className="px-3 py-3 text-center text-sm font-semibold text-slate-700">{r.appointments ?? 0}</td><td className="px-3 py-3 text-center text-sm font-semibold text-slate-700">{r.consultations ?? 0}</td></>}
                    <td className="px-5 py-3 text-center"><StatusChip row={r} /></td>
                    {/* A short day with an approved permission on it is a short day on
                        purpose, and this column is where a day says why. The permission
                        leads: it is the answer to the question the balance beside it
                        raises. */}
                    {!compactLayout && <td className="max-w-[16rem] truncate px-4 py-3 text-xs leading-5 text-slate-400" title={[r.permission ? `Permission ${r.permission.from}–${r.permission.to}${r.permission.reason ? `: ${r.permission.reason}` : ""}` : "", r.note].filter(Boolean).join(" · ")}>
                      {r.permission && (
                        <span className="mr-1.5 whitespace-nowrap rounded-[5px] border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700" data-testid={`my-attendance-permission-${r.date}`}>
                          {duration(r.permission.minutes)} permission
                        </span>
                      )}
                      {r.note || (r.permission ? "" : "—")}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
};

// `view`: "all" is the desktop: the month's tiles, and the day-by-day table behind the
// toolbar's History button. On a phone the history is a screen of its own behind a View
// History button, so it is "summary" or "history" there.
const AttendanceTab = ({ view = "all", toolbarTarget = null }) => {
  // Every dashboard uses the compact attendance layout introduced for Branch Admin.
  const compactLayout = true;
  const [month, setMonth] = useState(thisMonth);
  const [dateFilter, setDateFilter] = useState(null);
  // Desktop only: the History button swaps the tiles for the day-by-day table.
  const [showHistory, setShowHistory] = useState(false);
  const requestId = useRef(0);
  const isoDate = (date) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
  const filterFrom = isoDate(dateFilter?.from);
  const filterTo = isoDate(dateFilter?.to || dateFilter?.from);
  const changeMonth = (next) => { setDateFilter(null); setMonth(next); };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    const months = [month];
    if (compactLayout && filterFrom && filterTo) {
      for (let m = filterFrom.slice(0, 7); m <= filterTo.slice(0, 7); m = shiftMonth(m, 1)) {
        if (!months.includes(m)) months.push(m);
      }
    }
    Promise.all(months.map((m) => myAttendance(m))).then((results) => {
      if (id !== requestId.current) return;
      const primary = results[0];
      const filteredDays = filterFrom ? results.flatMap((r) => r.days || [])
        .filter((r) => r.date >= filterFrom && r.date <= filterTo).sort((a, b) => b.date.localeCompare(a.date)) : primary.days;
      setData({ ...primary, filteredDays });
    }).catch((e) => { if (id === requestId.current) setError(e?.response?.data?.detail || "Could not load your attendance"); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
  }, [month, compactLayout, filterFrom, filterTo]);

  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);

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

  const attendanceToolbar = compactLayout && (
    <div className="flex flex-wrap items-center gap-2" data-testid="attendance-toolbar">
      <div className="inline-flex items-center gap-5 rounded-[4px] border border-slate-200 bg-white p-1">
        <button type="button" aria-label="Previous month" onClick={() => changeMonth(shiftMonth(month, -1))} className="rounded-[4px] border p-1.5"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-sm font-semibold">{monthLabel(month)}</span>
        <button type="button" aria-label="Next month" disabled={month >= thisMonth()} onClick={() => changeMonth(shiftMonth(month, 1))} className="rounded-[4px] border p-1.5 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
      </div>
      {/* A date range only filters the table, so picking one on the desktop opens History. */}
      <DateFilterPopover value={dateFilter} onChange={(next) => { setDateFilter(next); if (next?.from) { setMonth(isoDate(next.from).slice(0, 7)); if (!phone) setShowHistory(true); } }} iconOnly centered testid="attendance-date-filter" />
      {!phone && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowHistory((on) => !on)}
          aria-pressed={showHistory}
          aria-label="View History"
          title="View History"
          className={`h-10 w-10 px-0 ${showHistory ? "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100" : ""}`}
          data-testid="my-attendance-view-history"
        >
          <History className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  return (
    <div className={phone ? "space-y-2" : "space-y-4"} data-testid="my-profile-attendance-tab">
      {compactLayout ? (
        // On desktop the toolbar is drawn on the page's top row (toolbarTarget).
        toolbarTarget ? createPortal(attendanceToolbar, toolbarTarget) : attendanceToolbar
      ) : phone ? (
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
      // Branch Admin's month bar: a white strip with square, bordered arrows either side
      // of the month, as on the Outstanding board's month row.
      <div className="flex items-center justify-between gap-2 rounded-[5px] border border-slate-200 bg-white px-2 py-2 shadow-sm">
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
          aria-label="Previous month"
          data-testid="my-attendance-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800" data-testid="my-attendance-month">
          <CalendarDays className="h-4 w-4 text-sky-600" />
          {monthLabel(month)}
        </span>
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, 1))}
          // Nothing to show past this month: the days have not happened, and a next arrow
          // that lands on an empty table is a control that only reports its own limit.
          disabled={isThisMonth}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
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

      {loading ? (
        <p className="py-16 text-center text-sm text-slate-400" data-testid="my-attendance-loading">Loading your month…</p>
      ) : (
        <>
          {view === "summary" && (
            <>
              {isThisMonth && <PhoneToday row={todayRow} today={data?.today} />}
              <PhoneMonthCounts totals={data?.totals} compactLayout={compactLayout} />
              {!compactLayout && isThisMonth && <PhoneWorkload workload={data?.workload} />}
            </>
          )}
          {view === "history" && !compactLayout && <PhoneHours totals={data?.totals} today={data?.today} />}
          {view === "all" && !showHistory && (
            <>
              <MonthSummary
                compactLayout={compactLayout}
                totals={data?.totals}
                month={month}
                today={data?.today}
                todayStrip={isThisMonth && <TodayStrip hideHeading={compactLayout} row={todayRow} standard={data?.standard} today={data?.today} />}
                workload={!compactLayout && isThisMonth && <TodayWorkload workload={data?.workload} />}
              />
              <RecentActivity rows={rows} onViewAll={() => setShowHistory(true)} />
            </>
          )}
          {(view === "history" || (view === "all" && showHistory)) && <MonthTable rows={compactLayout ? data?.filteredDays || [] : rows} compactLayout={compactLayout} />}
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

const PROFILE_SECTIONS = [
  ["personal", "Personal"],
  ["employment", "Employment"],
  ["documents", "ID & Documents"],
  ["address", "Address & Emergency"],
  ["bank", "Bank Details"],
  ["sign", "Sign Upload"],
];

// Match the employee view dialog while keeping the profile in its existing page.
// `withSecurity` adds Security as the last section (the desktop Account tab). The phone
// leaves it out: its menu has Security as its own "Account" row.
const ProfileView = ({ data, roleLabel, photo, withSecurity = false, onLogout }) => {
  const [section, setSection] = useState("personal");
  const sections = withSecurity ? [...PROFILE_SECTIONS, ["security", "Security"]] : PROFILE_SECTIONS;
  const account = data.account || {};
  const rows = {
    personal: [["Full Name", data.full_name],
      // The login's Email ID, with the same Verified mark the Security tab shows.
      ["Email", data.email && (
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all">{data.email}</span>
          <EmailVerifiedTag verified={Boolean(data.email_verified)} provider={data.email_provider} testid="my-profile-email-tag" />
        </span>
      )],
      ["Phone", displayPhone(data.phone)],
      ["Date of Birth", prettyDate(data.dob)], ["Gender", titleCase(data.gender)],
      ["Blood Group", data.blood_group], ["Marital Status", titleCase(data.marital_status)],
      ["Father's Name", data.father_name], ["Mother's Name", data.mother_name]],
    employment: [["Employee ID", data.employee_code || account.short_id], ["Role", roleLabel || titleCase(account.role)],
      ["Designation", data.designation], ["Department", data.department], ["Branch", account.branch_name],
      ["Works", [WORK_TYPES[data.work_type], SERVICES[data.service]].filter(Boolean).join(" \u00b7 ")],
      ["Joining Date", prettyDate(data.joining_date)], ["Reporting To", data.reporting_to],
      ["Status", titleCase(data.status)], ["Account Created", prettyDate(String(account.created_at || "").slice(0, 10))]],
    documents: [["PAN", data.pan], ["Aadhaar", data.aadhar]],
    address: [["Address", data.address], ["Emergency Contact", data.emergency_contact_name],
      ["Emergency Phone", displayPhone(data.emergency_contact_phone)]],
    bank: [["Bank Name", data.bank_name], ["Account Number", data.bank_account], ["IFSC", data.ifsc]],
  };
  return (
    <section className="mx-auto w-full max-w-[860px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" data-testid="branch-profile-view">
      {photo.elements}
      {/* The name band, in the same blue as the popups' headers. */}
      <header className="flex items-center gap-3 border-b border-sky-700 bg-[#0284C7] px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold leading-tight text-white">{data.full_name || "My Profile"}</h2>
          {(roleLabel || account.branch_name) && <p className="mt-0.5 truncate text-xs font-medium text-sky-100">{[roleLabel, account.branch_name].filter(Boolean).join(" \u00b7 ")}</p>}
        </div>
        {data.status && <span className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${data.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-white/90 text-slate-600"}`}>{titleCase(data.status)}</span>}
      </header>
      {!data.linked && <p className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-800">This login is not linked to an employee record. Ask HR to link it from Credentials.</p>}
      <div className="flex min-h-[430px] flex-col sm:flex-row">
        {/* Below sm the six sections sit in two rows of three, every one on screen: as one
            scrolling row, Address & Emergency and Bank Details sat past the right edge. A
            label too long for its cell on a narrow phone wraps rather than clipping. From
            sm up it is the list down the left, as before. */}
        <nav aria-label="Profile sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/60 p-2 text-xs max-sm:grid max-sm:grid-cols-3 max-sm:overflow-visible sm:w-52 sm:flex-col sm:gap-1 sm:p-3 sm:text-sm sm:border-b-0 sm:border-r" data-testid="branch-profile-sections">
          {sections.map(([key, label]) => (
            <button type="button" key={key} onClick={() => setSection(key)} aria-current={section === key ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left focus-visible:outline-sky-600 max-sm:min-w-0 max-sm:whitespace-normal max-sm:px-2 max-sm:text-center max-sm:leading-tight ${section === key ? "bg-sky-100/70 font-semibold text-sky-700 sm:shadow-[inset_3px_0_0_#0284C7]" : "text-slate-600 hover:bg-white hover:text-slate-800"}`}
              data-testid={`branch-profile-section-${key}`}>{label}</button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 px-5 py-4 sm:px-6" aria-label={sections.find(([key]) => key === section)[1]}>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{sections.find(([key]) => key === section)[1]}</h3>
          {section === "personal" && <div className="mb-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5">
            <PhotoAvatar person={data} size={40} photo={photo} />
            <PhotoActions person={data} photo={photo} />
          </div>}
          {section === "sign" && <MySign />}
          {section === "security" && <SecurityTab embedded onLogout={onLogout} />}
          {(rows[section] || []).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:gap-4">
              <span className="shrink-0 text-xs font-medium text-slate-500 sm:w-40 sm:text-sm">{label}</span>
              <span className="min-h-9 min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800">{value || "\u2014"}</span>
            </div>
          ))}
        </div>
      </div>
      <footer className="border-t border-slate-200 bg-slate-50/60 px-5 py-3 text-xs text-slate-500">You can update your photo and your sign. For changes to your employee details, contact HR.</footer>
    </section>
  );
};

const ProfileTab = ({ roleLabel, withSecurity = false, onLogout }) => {
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

  return <ProfileView data={data} roleLabel={roleLabel} photo={photo} withSecurity={withSecurity} onLogout={onLogout} />;
};

// ---------- monthly calendar ----------

const ORG_WIDE = ["super_admin", "business_dev"];

/** My branch's Working / Leave days. Super Admin and BDE run every branch, so they pick one. */
const MonthlyCalendarTab = ({ user, toolbarTarget = null }) => {
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
      <p className="rounded-[4px] border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400" data-testid="my-calendar-no-branch">
        You are not posted to a branch yet, so there is no branch calendar to show.
      </p>
    );
  }
  return (
    <div className="space-y-3 rounded-[4px] border border-slate-200 bg-white p-3 sm:p-4" data-testid="my-calendar-tab">
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
      <BranchMonthlyCalendar branchId={branchId} toolbarTarget={toolbarTarget} />
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
  { key: "timeoff", title: "Permission Request", icon: CalendarOff },
];

/**
 * My Profile on a phone, laid out like a messenger's settings: who I am at the top, then
 * one row per section, each opening full-screen with a back arrow. Five segmented tabs
 * across a phone is five glyphs to learn; a list says what each one is.
 */
// `onBack` is for a host with no bottom bar to leave by: the menu then carries its own way out.
const PhoneProfileMenu = ({ roleLabel, user, onLogout, onBack, hideTimeOff = false }) => {
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
          : open === "timeoff" && !hideTimeOff ? <TimeOffTab compact />
            : open === "security" ? <SecurityTab />
              : <ProfileTab roleLabel={roleLabel} />}
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

/**
 * `phoneBar` is for a host that already frames this page on a phone — the Physio board,
 * which opens it from its own bottom bar. Below sm it drops the Back button, the bar
 * underneath being the way out.
 */
/**
 * `onLogout` is for a host whose phone header no longer carries a logout — Super Admin,
 * whose bottom bar opens this page. It is handed to the Security tab, which draws the
 * button below md; from md up the header's own logout is on screen.
 */
// `keepBack` keeps Back on a phone, for a host with no bottom bar to leave by (BDE,
// Accountant open this from the header).
// `phoneMenu` swaps the sidebar for PhoneProfileMenu below md, for every host.
// `hideTimeOff` drops Permission Request (Super Admin). `timeOffInHeader` is for a host
// whose phone header already carries Time Off as its own button (Physio, Consultant): the
// phone menu then leaves the row out, so it is not in two places. The sidebar keeps it.
// The page's height from md up: down to the foot of the screen, so the sidebar's footer
// sits in the bottom corner however short the tab is. Where the page starts differs by
// host (a tab strip above it or not), so its top is measured rather than written as a calc.
const useFillToScreenBottom = () => {
  const [el, setEl] = useState(null);
  const [minHeight, setMinHeight] = useState(0);
  useEffect(() => {
    if (!el) return undefined;
    const fit = () => setMinHeight(Math.max(0, window.innerHeight - (el.getBoundingClientRect().top + window.scrollY)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [el]);
  return [setEl, minHeight];
};

// The sidebar's foot: the version alone, in the bottom corner.
const SidebarFooter = () => (
  <div className="mt-auto hidden px-5 pb-4 pt-6 md:sticky md:bottom-0 md:block" data-testid="my-profile-sidebar-footer">
    <p className="text-[7px] leading-none text-slate-300" title={versionDetail || undefined} data-testid="my-profile-footer-version">
      {versionLabel}
    </p>
  </div>
);

// `withHelp` adds Get Help under Account (Branch Admin): a row that opens its popup over
// whichever tab is open, rather than a tab of its own.
export const MyProfilePage = ({ user, roleLabel, onBack, onLogout, phoneBar = false, keepBack = false, phoneMenu = true, hideTimeOff = false, timeOffInHeader = false, withHelp = false }) => {
  const [tab, setTab] = useState("attendance");
  const [helpOpen, setHelpOpen] = useState(false);
  // The tab's own tools (month, counts) are portalled into this slot, on the top row.
  const [toolsEl, setToolsEl] = useState(null);
  const [pageRef, fillHeight] = useFillToScreenBottom();
  const phone = usePhone();
  const noTimeOff = hideTimeOff || user?.role === "super_admin";
  const tabs = noTimeOff ? TABS.filter((t) => t.key !== "timeoff") : TABS;
  if (phoneMenu && phone) {
    return <PhoneProfileMenu roleLabel={roleLabel} user={user} onLogout={onLogout} hideTimeOff={noTimeOff || timeOffInHeader} onBack={keepBack || !phoneBar ? onBack : null} />;
  }

  return (
    <div
      ref={pageRef}
      className="flex flex-col bg-white md:min-h-[var(--my-profile-fill,0px)] md:flex-1 md:flex-row"
      style={{ "--my-profile-fill": `${fillHeight}px` }}
      data-testid="my-profile-page"
    >
      {/* The same sidebar as the Notifications popup, drawn as the page's left edge: flush
          under the header and as tall as the page, so it is a wall rather than a card. Only
          the column is full height — what is in it stays in view while a month scrolls past.
          CRMPage drops its own padding round this page for that. */}
      <aside className="shrink-0 border-b border-slate-200 bg-slate-50/60 md:flex md:w-56 md:flex-col md:border-b-0 md:border-r" data-testid="my-profile-sidebar">
        <nav
          aria-label="My Profile"
          className="flex gap-1 overflow-x-auto p-2 text-xs md:sticky md:top-[var(--role-header-height,89px)] md:flex-col md:overflow-visible"
          data-testid="my-profile-tabs"
        >
          {/* The sidebar's heading: Back as a bare chevron, no box round it, then the page's
              name. The chevron hops left once a second -- the boards' nudge-left, on a 1s
              beat rather than 1.5s. */}
          <div className="flex h-8 shrink-0 items-center gap-1" data-testid="my-profile-heading">
            <button
              type="button"
              onClick={onBack}
              className={`h-8 shrink-0 items-center rounded-md px-2.5 text-slate-600 hover:text-slate-900 focus-visible:outline-sky-600 ${phoneBar && !keepBack ? "hidden sm:flex" : "flex"}`}
              aria-label="Back"
              title="Back"
              data-testid="my-profile-back"
            >
              <ChevronLeft className="h-5 w-5 motion-safe:animate-[nudge-left_1s_ease-in-out_infinite]" />
            </button>
            <h2 className="truncate text-sm font-semibold text-slate-800">My Profile</h2>
          </div>
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              type="button"
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left focus-visible:outline-sky-600 ${tab === key ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`}
              data-testid={`my-profile-tabs-${key}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{label}</span>
            </button>
          ))}
          {withHelp && (
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              aria-haspopup="dialog"
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left focus-visible:outline-sky-600 ${helpOpen ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`}
              data-testid="my-profile-tabs-help"
            >
              <LifeBuoy className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">Get Help</span>
            </button>
          )}
        </nav>
        {withHelp && <GetHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />}
        <SidebarFooter />
      </aside>

      {/* gap rather than space-y: the tools row is display:none on a tab that has none, and
          must not leave its space behind. */}
      <div className="flex min-w-0 flex-col gap-4 py-4 md:flex-1 md:px-6" data-testid="my-profile-tab-body">
        <div ref={setToolsEl} className="flex flex-wrap items-center justify-end gap-2 empty:hidden" data-testid="my-profile-tab-tools" />

        {/* Both tabs stay mounted once opened would mean two months of requests for a screen
            somebody opened to read one thing, so each is mounted only while it is the tab.
            Switching back re-reads, which is right for a page whose whole subject is what
            happened today. */}
        <div className="min-w-0">
          {tab === "calendar" ? <MonthlyCalendarTab user={user} toolbarTarget={toolsEl} />
            : tab === "attendance" ? <AttendanceTab toolbarTarget={toolsEl} />
            : tab === "timeoff" && !noTimeOff ? <div className="[&_*]:!rounded-[4px]" data-testid="my-profile-timeoff-tab"><PermissionRequestBoard /></div>
              : <ProfileTab roleLabel={roleLabel} withSecurity onLogout={onLogout} />}
        </div>
      </div>
    </div>
  );
};

export default MyProfilePage;
