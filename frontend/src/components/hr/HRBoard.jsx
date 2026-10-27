import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Users, ShieldCheck, AlertTriangle, MailCheck, BarChart3, Plus, Pencil, Trash2, Eye, EyeOff, KeyRound, X, UserPlus, MoreVertical, Check, CheckCircle2, XCircle, AlertOctagon, ChevronDown, ChevronUp, ChevronRight, GripVertical, Search, Settings, Camera, ImageOff, Download, Network, CalendarCheck, Wallet, ClipboardCheck, ClipboardList, Quote, Star, UserCheck, TrendingUp, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  hrDashboard, hrAttendanceDay, hrApprovals, hrEmployees, hrCreateEmployee, hrUpdateEmployee, hrDeleteEmployee, hrEmployeeHistory, uploadEmployeePhoto,
  hrUsers, hrCreateUser, hrUpdateUser, hrResetPassword, hrEmailStatus, hrEmailTest, hrDeactivateUser, hrActivateUser, hrDeleteUserPermanent, hrMeta, hrAddCustomRole,
  hrDepartments, hrCreateDepartment, hrRenameDepartment, hrDeleteDepartment, hrAddDesignation, hrRenameDesignation, hrDeleteDesignation, hrReorderDesignations,
  getBranches, getVerticals,
} from "@/lib/api";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { downloadCsv } from "@/lib/printable";
import { ROLE_META, roleLabel, roleClasses, setCustomRoleClasses } from "@/lib/roles";
import { AttendanceTab, PayrollTab, ApprovalsTab, QuotesTab } from "@/components/hr/HROpsTabs";
import { ClientReviewsPanel } from "@/components/reviews/ClientReviewsPanel";
import { EodReportsPanel } from "@/components/eod/EodReportsPanel";
import { PerformancePanel } from "@/components/hr/PerformancePanel";
import { displayPhone } from "@/lib/phone";
import { clamp, useDismissOutside, useFloatingPosition } from "@/lib/use-floating";

// Matches ALL_BRANCHES in backend/routers/v3_hr.py, which resolves it to a name on the way
// out. Held in branch_id where a real branch id would go, so everything that already reads
// an employee's branch keeps working without being told about it.
const ALL_BRANCHES = "__all__";

const TABS = [
  { key: "dashboard", label: "Dashboard", icon: BarChart3 },
  // Staff holds the running month -- attendance, payroll, approvals -- and everything read
  // about the people day to day, behind its own bar (STAFF_TABS below), ahead of the three
  // org-chart tabs. Their screens live in HROpsTabs.jsx.
  { key: "staff", label: "Staff", icon: UserCheck },
  { key: "employees", label: "Employees", icon: Users },
  { key: "roles", label: "Credentials", icon: ShieldCheck },
  // One screen over one set of records. The tab that used to carry this name was a second
  // view of the same departments, which left a standing question about which of the two was
  // authoritative; this one reads the list and creates, renames and deletes in it.
  //
  // The key stays "structure": it is internal state, and renaming it would only invalidate
  // the tab somebody happens to have open.
  { key: "structure", label: "Department & Designation", short: "Depts", icon: Network },
];

// The bar inside Staff. superAdminOnly works as it does on TABS: BDE mounts this same board
// and gets everything except Performance and EOD Report.
const STAFF_TABS = [
  { key: "attendance", label: "Attendance", short: "Attend", icon: CalendarCheck },
  { key: "performance", label: "Performance", short: "Perform", icon: TrendingUp, superAdminOnly: true },
  // The stars clients give their Physio from the Client Portal. Read by Super Admin and BDE
  // across every branch; Branch Admin has the same panel on its board, and this one is
  // narrowed to Physio Review the same way (physioOnly below).
  { key: "client_reviews", label: "Review", icon: Star },
  // What each Physio and Consultant did with their day, filed at Clock Out. The endpoint
  // behind it answers super_admin alone.
  { key: "eod_report", label: "EOD Report", short: "EOD", icon: ClipboardList, superAdminOnly: true },
  // An approved leave is an attendance mark, and attendance is what payroll pro-rates against.
  { key: "payroll", label: "Payroll", icon: Wallet },
  { key: "approvals", label: "Approvals", short: "Approve", icon: ClipboardCheck },
  { key: "quotes", label: "Quotes", icon: Quote },
];

const StaffTab = ({ isSuperAdmin, sub, onSubChange }) => {
  const tabs = useMemo(() => STAFF_TABS.filter((t) => !t.superAdminOnly || isSuperAdmin), [isSuperAdmin]);
  return (
    <div className="flex flex-col gap-4" data-testid="hr-staff-tab">
      <SegmentedTabs tabs={tabs} value={sub} onChange={onSubChange} testid="hr-staff-subtab" size="sm" mobileCols={4} />
      {sub === "attendance" && <AttendanceTab />}
      {sub === "performance" && isSuperAdmin && <PerformancePanel />}
      {sub === "client_reviews" && <ClientReviewsPanel physioOnly staffView />}
      {sub === "eod_report" && isSuperAdmin && <EodReportsPanel />}
      {sub === "payroll" && <PayrollTab />}
      {sub === "approvals" && <ApprovalsTab />}
      {sub === "quotes" && <QuotesTab />}
    </div>
  );
};

// The practices a branch can run, and so the services an employee can be tagged to.
// "both" is not a third practice — it is the answer that declines to narrow.
const PRACTICE_PHYSIO = "physio";
const PRACTICE_FITNESS = "fitness";
const PRACTICE_BOTH = "both";
const SERVICE_LABELS = { "": "Select", [PRACTICE_PHYSIO]: "Physio", [PRACTICE_FITNESS]: "Fitness", [PRACTICE_BOTH]: "Both" };

// The other axis: which mode somebody works. Two answers, both pickable, and blank is not
// a third one: it reads as Offline everywhere, so not choosing still lands on an answer.
// Practice below keeps its own "both"; that one is a real third answer, where a third mode
// was only ever the absence of a decision.
const MODE_ONLINE = "online";
const MODE_OFFLINE = "offline";
const MODE_OPTIONS = [MODE_ONLINE, MODE_OFFLINE];
const MODE_LABELS = { [MODE_ONLINE]: "Online", [MODE_OFFLINE]: "Offline" };
/** The mode, as the OS now understands it: online, or not.
 *
 * Not-online covers three stored values that all mean the same thing here — "offline",
 * blank, and "both", which employees classified while a third mode existed still carry.
 * Nothing writes "both" any more and it reads as Offline: somebody who worked both was in
 * a room for half of it, and the offline half is the half that decides whether they have a
 * branch. Blank especially: it is the state almost every employee
 * is in, because the field was optional for as long as it has existed, and reading it as
 * anything other than "works in the room" would quietly reclassify the whole directory.
 *
 * So the question has a default rather than a blank: Offline is everything that is not
 * the word "online", whether it was picked outright or never answered.
 */
const isOnlineMode = (mode) => mode === MODE_ONLINE;
const modeValue = (mode) => (isOnlineMode(mode) ? MODE_ONLINE : MODE_OFFLINE);

/** The mode worth saying out loud, or null for the one that is not.
 *
 * Offline says nothing. It is what almost everybody at a clinic is, so a tag on each of
 * them is a tag on the whole list — it marks nothing and costs a column. Online and Both
 * are the exceptions, and an exception is the only thing a badge is any use for.
 *
 * Unset says nothing either, and deliberately reads the same as Offline here: both mean
 * "no reason to flag this row". The difference between them is a question for the
 * Employment tab, which asks it in a field with a name on it, not for a badge in a list.
 */
const modeBadge = (mode) => (isOnlineMode(mode) ? MODE_LABELS[MODE_ONLINE] : null);

/** Whether this mode belongs to a branch at all.
 *
 * Online does not. Somebody who works only over video is not AT one, so a branch on them
 * is an address nobody attends, and every list that reads branches would go on offering
 * them in a room they never enter. Choosing Online clears the branch rather than hiding
 * it, so the record says what is true rather than carrying an answer the screen declines
 * to show.
 *
 * Both does, and keeps it: half that week is in a room, and the room has an address.
 * Offline plainly does.
 */
const modeHasBranch = (mode) => !isOnlineMode(mode);

// What the branch column reads for somebody who has no branch by virtue of their mode.
// A word rather than an empty cell: blank is what an unposted employee looks like, and
// this is the opposite — not a gap to fill, but a posting that does not apply.
const ONLINE_MODE_LABEL = "Online Mode";

// Every default vertical is named "online_.../offline_..." — same helper as
// Branches & Verticals' own mode tag, read off that prefix.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// The other half of a vertical. Mode and practice together are what a vertical names —
// offline_physiotherapy is mode "offline" and practice "physio" — so the Employment tab
// asks the two questions separately and narrows the branch list on both.
//
// Matched on whole underscore-separated tokens rather than a substring, like the role
// predicates in backend/deps.py, and null for anything that answers to neither: a vertical
// added by hand under a name this doesn't recognise must stay pickable rather than quietly
// dropping its branches out of the list with nothing on screen to say why.
const VERTICAL_PRACTICES = { physio: PRACTICE_PHYSIO, physiotherapy: PRACTICE_PHYSIO, fitness: PRACTICE_FITNESS, gym: PRACTICE_FITNESS };
const verticalPractice = (v) => {
  for (const token of String(v || "").toLowerCase().split("_")) {
    if (VERTICAL_PRACTICES[token]) return VERTICAL_PRACTICES[token];
  }
  return null;
};

// Both consultant roles can cover more than one branch — every other role keeps the
// original single Branch select.
// Physios belong to branches and may cover several, so they get the checkbox list.
// Head Physios cover the whole organisation by definition — offering them a branch choice
// would suggest they could be limited to one, which they can't be.
// Kept in step with MULTI_BRANCH_ROLES in backend/routers/v3_hr.py. A role missing here
// is offered a single branch on hire while the backend expects a list, so an Online
// Physio covering three branches would get one expert record and two empty calendars.
// A CONSULTANT picks branches like a Physio does. They used to be org-wide with the
// selection replaced by a notice saying so, which left no way to say a CONSULTANT works
// two branches out of four — the board already scopes to branch_ids, so the fact was
// storable all along and only the form refused to collect it.
//
// Empty still means every branch, which is what an existing CONSULTANT carries today.
// Requiring one would have made every one of them unsaveable until a branch was ticked.
// Up here with the other role vocabulary rather than two-thirds down the file: it is
// read from reloadMeta at the top and from the designation options in the middle, and a
// const is not hoisted, so where it was written was where it started existing.
// ---------- Roles & Credentials ----------

// The role vocabulary — labels, colours, and the custom-role register — lives in
// lib/roles.js now, because the Super Admin Dashboard's staff roster renders the same
// roles and must not name them differently. Imported at the top of this file.

/**
 * Which branch an account belongs to.
 *
 * Three answers are possible and they are not interchangeable, so none of them is
 * flattened into the same text:
 *
 *   All branches   a CONSULTANT given none of them covers all of them. Their empty branch
 *                  list means "all", and printing "—" for it would read as the opposite
 *                  of the truth. Given specific branches, they read like anyone else —
 *                  org_wide is the empty case, not the role.
 *   several        a CONSULTANT, Physio or Nutrition Coach can serve more than one. The first is
 *                  named and the rest counted, with all of them in the tooltip — a column
 *                  this narrow cannot list four branch names without pushing Actions off.
 *   one, or none   the name, or a dash for an account genuinely not attached to a branch.
 */

const MULTI_BRANCH_ROLE_LABELS = {
  consultant: "CONSULTANT",
  online_consultant: "ONLINE CONSULTANT",
  physio: "Physio",
  online_physio: "Online Physio",
  consultant_physio: "CONSULTANT + PHYSIO",
  // Retired, still mapped for an account migrate_consultant_roles has not reached.
  head_physio: "CONSULTANT",
  online_head_physio: "ONLINE CONSULTANT",
};
// A Nutritionist picks branches the same way, and for the same reason: they hold a
// calendar at each branch they work and may work more than one. The backend has accepted
// a list from them all along — only this form refused to collect it, leaving one Branch
// dropdown that could say nothing about a coach who covers two.
//
// Read off the shape of the slug rather than one literal, because a diet role is typed by
// hand in Roles & Credentials: this install's is "diet_manage", not "nutrition_coach", so
// a map keyed by the literal never matched it. Matched on whole underscore-separated
// tokens so an unrelated role can't slip through on a substring — "audit_manage" shares
// no token with the set. Super Admin reaches the Diet board but is not a coach, and is
// excluded here as it is on the backend. Kept in step with is_multi_branch_role in
// backend/routers/v3_hr.py.
const DIET_ROLE_TOKENS = ["diet", "nutrition", "nutritionist", "dietician", "dietitian"];
const multiBranchLabel = (role) => {
  const r = String(role || "").trim().toLowerCase();
  if (MULTI_BRANCH_ROLE_LABELS[r]) return MULTI_BRANCH_ROLE_LABELS[r];
  if (r === "super_admin") return null;
  if (r.includes("nutrition_coach") || r.split("_").some((t) => DIET_ROLE_TOKENS.includes(t))) return "Nutritionist";
  return null;
};
// Roles allowed to cover everything by leaving the selection empty.
//
// Empty, and the set is kept rather than deleted because the rule it encodes still has to
// be asked. It held the consultant family until Consultants became branch-selective: they
// are posted to chosen branches now, so an empty selection means nobody has said where
// they work rather than "everywhere", and the form asks for at least one branch like it
// does for a Physio. See consultants_serving_branch in backend/deps.py, which is what
// reads that selection.
const BRANCHLESS_OK_ROLES = new Set([]);

export const HRBoard = ({ isSuperAdmin = false }) => {
  const [tab, setTab] = useState("dashboard");
  const [staffSub, setStaffSub] = useState("attendance");
  const tabs =useMemo(() => TABS.filter((t) => !t.superAdminOnly || isSuperAdmin), [isSuperAdmin]);
  const [meta, setMeta] = useState({ departments: [], department_designations: {}, roles: [], custom_roles: [] });
  const reloadMeta = useCallback(() => hrMeta().then((m) => {
    // Before setMeta, so the first render after a reload already has the colours rather
    // than painting every custom role grey and correcting itself a frame later.
    setCustomRoleClasses(m.custom_roles);
    setMeta(m);
  }).catch((e) => console.warn("[load failed]", e?.message || e)), []);
  useEffect(() => { reloadMeta(); }, [reloadMeta]);
  // flex+gap, not space-y — the title/description block below is hidden by class on
  // mobile, not the hidden attribute, so space-y's sibling selector would still hand
  // the tab strip phantom top margin for content a phone never draws.
  return (
    <div className="flex flex-col gap-5" data-testid="hr-board">
      {/* No heading. The nav tab above already reads HR Admin. */}
      <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} testid="hr-subtab" mobileCols={4} />
      {/* The Dashboard's cards filter a list of their own now rather than switching tabs. */}
      {tab === "dashboard" && <DashboardTab />}
      {tab === "staff" && <StaffTab isSuperAdmin={isSuperAdmin} sub={staffSub} onSubChange={setStaffSub} />}
      {tab === "employees" && <EmployeesTab meta={meta} reloadMeta={reloadMeta} />}
      {tab === "roles" && <RolesTab meta={meta} reloadMeta={reloadMeta} />}
      {tab === "structure" && <StructureTab meta={meta} reloadMeta={reloadMeta} />}
    </div>
  );
};

// ---------- Dashboard ----------

const DashboardTab = () => {
  const [data, setData] = useState(null);
  // The rows behind the cards, fetched with the figures so a click filters in place rather
  // than waiting on a request. Each is its own slot: a desk that may read the dashboard but
  // not the register (marketing_head) still gets every list it is allowed.
  const [employees, setEmployees] = useState(null);
  const [users, setUsers] = useState(null);
  const [register, setRegister] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [selected, setSelected] = useState("active");
  const [search, setSearch] = useState("");

  useEffect(() => {
    hrDashboard().then(setData).catch(() => toast.error("Failed to load"));
    hrEmployees().then(setEmployees).catch(() => setEmployees([]));
    hrUsers().then(setUsers).catch(() => setUsers([]));
    hrAttendanceDay().then(setRegister).catch(() => setRegister({ rows: [], failed: true }));
    hrApprovals({ status: "pending" }).then((r) => setApprovals(r.approvals || [])).catch(() => setApprovals([]));
  }, []);

  if (!data) return <p className="text-sm text-slate-500">Loading...</p>;
  const k = data.kpis;

  // Sorted, so the biggest department is the one the eye lands on.
  const depts = [...(data.department_strength || [])].sort((a, b) => b.count - a.count);

  // Present and Absent are read off the day's register -- the same rows the list draws --
  // rather than off stored marks alone, which miss every day read from the clock and so
  // left both cards at 0 while the register had people in. Present keeps the late arrivals.
  const regOk = register && !register.failed;
  const regRows = register?.rows || [];
  const presentRows = regRows.filter((r) => r.status === "present" || r.status === "late");
  const absentRows = regRows.filter((r) => r.status === "absent");

  const activeEmployees = (employees || []).filter((e) => e.status === "active");
  const activeUsers = (users || []).filter((u) => u.is_active !== false);

  const cards = [
    { key: "active", label: "Active Employees", value: employees ? activeEmployees.length : k.active_employees, kind: "employees", ready: employees, rows: activeEmployees },
    { key: "users", label: "Total Users", value: users ? activeUsers.length : k.total_users, kind: "users", ready: users, rows: activeUsers },
    { key: "present", label: "Today Present", value: regOk ? presentRows.length : k.present_today, kind: "register", ready: register, rows: presentRows },
    { key: "absent", label: "Today Absent", value: regOk ? absentRows.length : (k.absent_today ?? 0), kind: "register", ready: register, rows: absentRows },
    { key: "leaves", label: "Pending Approvals", value: approvals ? approvals.length : k.pending_leaves, kind: "approvals", ready: approvals, rows: approvals || [] },
    ...depts.map((d) => ({
      key: `dept-${d.name}`,
      label: d.name,
      value: d.count,
      kind: "employees",
      ready: employees,
      rows: (employees || []).filter((e) => (e.department || "Unassigned") === d.name),
    })),
  ];
  const current = cards.find((c) => c.key === selected) || cards[0];

  const q = search.trim().toLowerCase();
  const rows = !q ? current.rows : current.rows.filter((r) =>
    [r.full_name, r.employee_name, r.employee_code, r.email, r.phone, r.designation, r.department, r.branch_name, r.role, r.kind, r.reason]
      .some((v) => String(v || "").toLowerCase().includes(q)));

  return (
    <div className="space-y-4" data-testid="hr-dashboard-tab">
      {/* The HR Admin Master View's summary cards -- label over count, left aligned, white
          and bordered -- in plain slate, without the per-stage colour. Selecting one filters
          the list under it, the way a stage does there. Five to a row on a phone. */}
      <div className="flex flex-wrap justify-center gap-1.5 sm:grid sm:grid-cols-3 sm:gap-3 lg:grid-cols-5 xl:grid-cols-9" data-testid="hr-dashboard-cards">
        {cards.map((c) => {
          const active = c.key === current.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => { setSelected(c.key); setSearch(""); }}
              className={`w-[calc(20%-0.3rem)] min-w-0 rounded-lg border-2 px-1 py-1.5 text-center transition hover:shadow-sm sm:w-full sm:rounded-xl sm:px-4 sm:py-3.5 sm:text-left ${
                active ? "border-slate-400 bg-slate-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
              aria-pressed={active}
              data-testid={`hr-kpi-${c.key}`}
            >
              <span className="block break-words text-[9px] font-medium leading-[1.15] text-slate-500 [hyphens:auto] sm:truncate sm:text-xs" title={c.label}>
                {c.label}
              </span>
              <span className="mt-0.5 block text-lg font-semibold leading-tight text-slate-600 sm:mt-1 sm:text-2xl">
                {c.value ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, code, phone or email..."
          className="min-w-0 flex-1 border-0 p-0 text-sm outline-none placeholder:text-slate-400"
          data-testid="hr-dashboard-search"
        />
        {search && (
          <button type="button" onClick={() => setSearch("")} className="shrink-0 text-slate-400 hover:text-slate-600" aria-label="Clear search">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {current.ready === null ? <p className="text-sm text-slate-500">Loading...</p> : <DashboardList kind={current.kind} rows={rows} />}
    </div>
  );
};

const dashDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};
const slugLabel = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const DashPill = ({ children }) => (
  <span className="inline-flex shrink-0 whitespace-nowrap rounded-[5px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{children}</span>
);
// Name over a quiet second line, as the Master View's Candidate and Position cells are.
const TwoLine = ({ top, sub }) => (
  <>
    <p className="font-medium text-slate-800">{top || "—"}</p>
    {sub ? <p className="truncate text-[11px] text-slate-400">{sub}</p> : null}
  </>
);

// One set of columns per kind of card. `text` is the same cell as a plain string, for the
// phone layout's one-line summary.
const DASH_COLUMNS = {
  employees: [
    { h: "Employee", cell: (e) => <TwoLine top={e.full_name} sub={e.employee_code} /> },
    { h: "Designation", cell: (e) => <TwoLine top={e.designation} sub={e.department} />, text: (e) => e.designation },
    { h: "Contact", cell: (e) => <TwoLine top={displayPhone(e.phone)} sub={e.email} />, text: (e) => displayPhone(e.phone) },
    { h: "Branch", cell: (e) => e.branch_name || "—", text: (e) => e.branch_name },
    { h: "Joined", cell: (e) => dashDate(e.joining_date) },
    { h: "Status", cell: (e) => <DashPill>{slugLabel(e.status) || "—"}</DashPill> },
  ],
  users: [
    { h: "User", cell: (u) => <TwoLine top={u.full_name} sub={u.linked_employee?.employee_code} /> },
    { h: "Role", cell: (u) => <TwoLine top={roleLabel(u.role)} sub={u.linked_employee?.designation} />, text: (u) => roleLabel(u.role) },
    { h: "Contact", cell: (u) => <TwoLine top={u.email} sub={displayPhone(u.phone)} />, text: (u) => u.email },
    { h: "Department", cell: (u) => u.linked_employee?.department || "—", text: (u) => u.linked_employee?.department },
    { h: "Status", cell: (u) => <DashPill>{u.is_active === false ? "Inactive" : "Active"}</DashPill> },
  ],
  register: [
    { h: "Employee", cell: (r) => <TwoLine top={r.full_name} sub={r.employee_code} /> },
    { h: "Designation", cell: (r) => <TwoLine top={r.designation} sub={r.department} />, text: (r) => r.designation },
    { h: "Branch", cell: (r) => r.branch_name || "—", text: (r) => r.branch_name },
    { h: "Check In", cell: (r) => r.check_in || "—", text: (r) => r.check_in && `In ${r.check_in}` },
    { h: "Check Out", cell: (r) => r.check_out || "—", text: (r) => r.check_out && `Out ${r.check_out}` },
    { h: "Status", cell: (r) => <DashPill>{slugLabel(r.status)}</DashPill> },
  ],
  approvals: [
    { h: "Employee", cell: (a) => <TwoLine top={a.employee_name} sub={a.employee_code} /> },
    { h: "Request", cell: (a) => <TwoLine top={slugLabel(a.kind)} sub={a.reason} />, text: (a) => slugLabel(a.kind) },
    {
      h: "When",
      cell: (a) => (a.from_date ? `${dashDate(a.from_date)}${a.to_date && a.to_date !== a.from_date ? ` – ${dashDate(a.to_date)}` : ""}` : a.amount ? `Rs.${a.amount}` : "—"),
      text: (a) => (a.from_date ? dashDate(a.from_date) : a.amount ? `Rs.${a.amount}` : ""),
    },
    { h: "Requested By", cell: (a) => a.requested_by || "—", text: (a) => a.requested_by },
    { h: "Raised", cell: (a) => dashDate(a.requested_at) },
    { h: "Status", cell: (a) => <DashPill>{slugLabel(a.status)}</DashPill> },
  ],
};

const DashboardList = ({ kind, rows }) => {
  const cols = DASH_COLUMNS[kind];
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-slate-200 bg-white py-8 text-center text-sm text-slate-400">Nothing to show.</p>;
  }
  const rowKey = (r, i) => r.id || r.employee_id || i;
  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid="hr-dashboard-list-mobile">
        {rows.map((r, i) => (
          <div key={rowKey(r, i)} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">{cols[0].cell(r)}</div>
              {cols[cols.length - 1].cell(r)}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {cols.map((c) => c.text?.(r)).filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="hr-dashboard-list">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
              <tr>{cols.map((c) => <th key={c.h} className="px-4 py-2.5 font-semibold">{c.h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={rowKey(r, i)} className="hover:bg-slate-50">
                  {cols.map((c, j) => <td key={c.h} className={`px-4 py-3 ${j === 0 ? "" : "text-slate-600"}`}>{c.cell(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

// ---------- shared: search, filter, directory ----------

/**
 * Collapses to a bare icon until clicked, so an empty search box doesn't sit open and
 * take up a quarter of the toolbar on every visit. Opens straight into a focused field;
 * closes itself back to the icon on blur, but only if it's empty — a live query never
 * disappears out from under someone.
 */
const SearchIconInput = ({ value, onChange, placeholder = "Search...", testid }) => {
  const [open, setOpen] = useState(Boolean(value));
  const ref = useRef(null);

  useEffect(() => { if (open) ref.current?.focus(); }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-sky-300 hover:text-sky-600"
        title="Search"
        aria-label="Search"
        data-testid={testid}
      >
        <Search className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        ref={ref}
        autoFocus
        value={value}
        onChange={onChange}
        onBlur={() => { if (!value) setOpen(false); }}
        placeholder={placeholder}
        className="pl-9"
        data-testid={testid}
      />
    </div>
  );
};

/** A pill tab for switching between departments (and "All Department"). Not built from
 *  SegmentedTabs — that component splits its track evenly across a fixed tab count, which
 *  doesn't fit a list that grows every time someone adds a department. */
/**
 * A department or designation as it should read.
 *
 * These are entered by hand over months by different people, so the same job arrives as
 * "CONSULTANT" from one and "Consultant" from another. Shouting one pill among a row of
 * ordinary ones reads as emphasis nobody meant.
 *
 * Only a name that is entirely upper case is touched. Anything with a lower-case letter in
 * it was written deliberately and is left alone — which is what keeps "HR Admin" from
 * becoming "Hr Admin", and is the whole reason this is not a blanket title-casing.
 *
 * Punctuation is untouched either way, so "BRANCH ADMIN (PHYSIO & FITNESS)" keeps its
 * brackets and its ampersand.
 */
const titleCase = (name) => {
  const text = String(name || "");
  if (text !== text.toUpperCase()) return text;
  return text.replace(/[A-Za-zÀ-ɏ]+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
};

/** The key two spellings of one name share. */
const nameKey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

/** The same job whether it arrives as a designation or as a role.
 *
 * Punctuation and spacing thrown away, because one side is a title somebody typed and the
 * other is a slug: "Pre- Sales" and pre_sales are one job, and nameKey above reads them as
 * two because an underscore is not a space.
 *
 * Compared against the role's LABEL rather than its slug, which is what makes the three
 * aliased desks line up — business_dev is labelled BUSINESS DEVELOPMENT EXECUTIVE and
 * online_physio is ONLINE PHYSIOTHERAPIST, exactly the titles HR's structure carries, so
 * no second alias map is needed here to keep in step with the backend's.
 */
const jobKey = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * One entry per name, whichever case each was typed in.
 *
 * Without this the same job is offered twice and each pill filters to half the people who
 * hold it, which reads as a list that has lost some of them.
 */
const dedupeNames = (names) => {
  const seen = new Set();
  const out = [];
  names.filter(Boolean).forEach((n) => {
    const key = nameKey(n);
    if (key && !seen.has(key)) { seen.add(key); out.push(n); }
  });
  return out.sort((a, b) => titleCase(a).localeCompare(titleCase(b)));
};

/**
 * One entry per job, in the order given — the counterpart to dedupeNames for a list whose
 * order was chosen rather than alphabetical.
 *
 * A department's designations are drag-ordered on the Departments & Designation tab, so
 * the picker that offers them should read in that order rather than re-sorted. Keyed on
 * jobKey, the same letters-only comparison unique_designations() in backend/routers/v3_hr.py
 * uses, so the two agree on what counts as the same title.
 */
const uniqueDesignations = (names) => {
  const seen = new Set();
  const out = [];
  (names || []).filter(Boolean).forEach((n) => {
    const key = jobKey(n);
    if (key && !seen.has(key)) { seen.add(key); out.push(n); }
  });
  return out;
};

/**
 * One department's configured designations, found by jobKey rather than by exact string.
 *
 * The department a form holds and the key the structure is grouped under are the same
 * name, until they aren't: these are typed by hand, so "Doctors ( Dr.'s )" on one screen
 * and "Doctors (Dr.'s)" in the structure are the same department read two ways. A literal
 * lookup misses on that difference and returns nothing — and "nothing configured" is what
 * every caller here treats as "fall back to the whole role list", so a stray bracket
 * silently unscopes the picker and offers Management's titles under Doctors.
 */
const designationsUnder = (groups, department) => {
  const wanted = jobKey(department);
  if (!wanted) return [];
  const exact = groups[department];
  if (exact) return exact;
  const hit = Object.keys(groups).find((k) => jobKey(k) === wanted);
  return hit ? groups[hit] : [];
};

/**
 * The designations of a department — or of all of them — arranged under the department
 * each belongs to.
 *
 * Both filters that offer designations used to list them flat, and with every
 * department's titles in one row that ran to sixteen pills over two lines with nothing to
 * say which belonged where — Nutritionist and Accountant sat side by side as though they
 * were the same kind of thing. Grouped, the department is read first and the job second,
 * which is the order the org is actually shaped in.
 *
 * The configured list leads, not the one read back off whoever happens to hold a job
 * today. Those two answer different questions: Department & Designation says what the org
 * has, and the records say what is currently filled. A filter built from the records alone
 * cannot offer a designation nobody holds yet, which is exactly the one somebody is about
 * to hire into.
 *
 * Each designation appears once across the whole list, under the first department that
 * configures it. What gets picked is the job on its own, so a title offered under two
 * headings would be two options that filter to exactly the same people.
 *
 * Departments are walked in meta.departments order — the order Departments & Designation
 * shows them in — so the dropdown reads the same way as the tab that defines it.
 *
 * A final group collects designations that are on somebody's record but in no
 * department's configured list. Those are the ones a filter built only from the structure
 * loses, and losing one means the people holding it cannot be filtered for at all. With a
 * department chosen they join that department's own group rather than a stray second
 * heading, and "Unassigned" — which is not a department and has no configured list — is
 * only ever described this way.
 */
const groupedDesignations = (meta, department, employees) => {
  const configured = meta?.department_designations || {};
  const scoped = Boolean(department);
  const held = (employees || [])
    .filter((e) => !scoped || (e.department || "Unassigned") === department)
    .map((e) => e.designation);

  // Keyed on jobKey, the same letters-only comparison the rest of this file folds
  // spellings with, so "Pre- Sales" and "Pre-Sales" are one option rather than two.
  const seen = new Set();
  const take = (names) => (names || []).filter(Boolean).filter((n) => {
    const key = jobKey(n);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const order = department === "Unassigned" ? []
    : department ? [department]
    : (meta?.departments || Object.keys(configured));

  const groups = [];
  order.forEach((d) => {
    const names = take(designationsUnder(configured, d));
    if (names.length) groups.push({ department: titleCase(d), designations: names });
  });

  const rest = take(dedupeNames(held));
  if (rest.length) {
    if (scoped && groups.length) groups[0].designations = groups[0].designations.concat(rest);
    else if (groups.length) groups.push({ department: "Other", designations: rest });
    else groups.push({ department: scoped ? titleCase(department) : "", designations: rest });
  }
  return groups;
};

/**
 * A filter pill, lit or not.
 *
 * The unlit ones are tinted rather than white. Against a white card a white pill with a
 * grey hairline reads as a label somebody has written down, not as something to press —
 * and these rows are almost entirely unlit, so the whole filter looked inert until the
 * pointer happened to cross it. A wash of the same blue the lit one is filled with says
 * they belong to one control and that pressing is what they are for.
 *
 * Still unmistakable which is which: the lit pill is solid sky-600 on white text, the
 * rest a pale ground with the blue only in the border and the label. Tinting the unlit
 * ones any harder is where a row of twenty starts competing with the one that is chosen.
 */
const TabPill = ({ active, onClick, children, testid }) => (
  <button
    type="button"
    onClick={onClick}
    className={`shrink-0 border px-3.5 py-1.5 text-sm font-medium transition ${
      active ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-400 hover:bg-sky-100 hover:text-sky-800"
    }`}
    data-testid={testid}
  >
    {children}
  </button>
);

/**
 * One row of a filter dropdown — the department one and the designation one both.
 *
 * The lit row is the same solid sky-600 a lit TabPill is, so the thing that is chosen
 * reads the same whichever of the two filters on the row it was chosen in. The tick is
 * not decoration — the panel scrolls, and once the selected row is scrolled out of view
 * the trigger's label is the only other thing saying what is set.
 */
const FilterOption = ({ label, selected, onSelect, testid }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm transition ${
      selected ? "bg-sky-600 font-semibold text-white" : "text-slate-700 hover:bg-sky-50 hover:text-sky-800"
    }`}
    data-testid={testid}
  >
    <span className="truncate">{label}</span>
    {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
  </button>
);

/**
 * The designation filter.
 *
 * Takes either a flat `options` list or `groups` from groupedDesignations, in which case
 * every department becomes a heading over the jobs it configures. The heading is a label
 * and not a value: what gets picked is still the job on its own, so the filter this feeds
 * is unchanged and a department's heading never narrows the match to that department's
 * records — which matters because the structure and the records disagree about where a
 * job sits often enough that pairing the two would filter to nobody.
 *
 * Built from Popover and buttons rather than a <select>. A native select's list is drawn
 * by the browser, not by this page: the grey Windows menu, its own type size, its own
 * highlight blue, and none of it reachable from a class. Next to the sky pills it sits
 * beside, the one control that opened looked like it belonged to another application.
 * This is the panel the rest of the OS opens — white card, sky highlight, and the
 * department headings set in the same small caps section labels use elsewhere in this
 * file. Popover carries the parts that are genuinely hard: it portals out, so a filter
 * near the bottom of a card is not clipped by it, and it closes on Escape and on a click
 * outside.
 *
 * The trigger shows a value the list does not offer. A filter can arrive here already set
 * — a Dashboard card or a department bar opens this page on one — and it can be a
 * spelling of a job the structure holds in different capitals. Reading "All Designations"
 * over a list that is filtered is the one state a filter must never show.
 */
const DesignationFilterSelect = ({ value, onChange, options, groups, testid }) => {
  const [open, setOpen] = useState(false);
  const sections = groups || (options?.length ? [{ department: "", designations: options }] : []);
  const pick = (next) => { onChange(next); setOpen(false); };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Filter by designation"
          className={`flex h-10 w-56 items-center justify-between gap-2 rounded-md border px-3 text-sm font-medium transition ${
            value ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
          }`}
          data-testid={testid}
        >
          <span className="truncate">{value ? titleCase(value) : "All Designations"}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </PopoverTrigger>
      {/* max-h + overflow on the list rather than the panel, so the headings scroll with
          the rows they head rather than the panel growing past the fold on an install
          with a lot of departments. */}
      <PopoverContent align="start" className="w-64 p-1" data-testid={`${testid}-panel`}>
        <div className="max-h-72 overflow-y-auto">
          <FilterOption
            label="All Designations"
            selected={!value}
            onSelect={() => pick("")}
            testid={`${testid}-all`}
          />
          {sections.map((g, i) => (
            <div key={`grp-${i}`}>
              {g.department && (
                <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  {g.department}
                </p>
              )}
              {g.designations.map((d) => (
                <FilterOption
                  key={d}
                  label={titleCase(d)}
                  selected={!!value && nameKey(d) === nameKey(value)}
                  onSelect={() => pick(d)}
                  testid={`${testid}-${d}`}
                />
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The department filter, as a dropdown.
 *
 * The same control as the designation filter beside it, deliberately: the two ask one
 * question in two halves — which department, then which job inside it — and as a row of
 * pills over a dropdown they read as two unrelated filters, the department one competing
 * with the tab bar above it for the same horizontal band. Side by side and identically
 * shaped, the pair reads as one narrowing.
 *
 * "All Departments" is a row in the list rather than a Clear button, so the default is
 * pickable in the same place every other answer is, and the trigger says which of them is
 * currently set instead of leaving "no filter" to be inferred from an unlit pill.
 *
 * The list is exactly what Department & Designation configures, in that tab's own order,
 * so the two screens name the same departments in the same sequence.
 */
const DepartmentFilterSelect = ({ value, onChange, departments, testid }) => {
  const [open, setOpen] = useState(false);
  const pick = (next) => { onChange(next); setOpen(false); };
  // Same guard the designation trigger carries: a filter can arrive set to a department
  // this list no longer offers, and the trigger must still say so rather than reading
  // "All Departments" over a list that is filtered.
  const known = (departments || []).some((d) => nameKey(d) === nameKey(value));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Filter by department"
          className={`flex h-10 w-56 items-center justify-between gap-2 rounded-md border px-3 text-sm font-medium transition ${
            value ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
          }`}
          data-testid={testid}
        >
          <span className="truncate">{value ? titleCase(value) : "All Departments"}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1" data-testid={`${testid}-panel`}>
        <div className="max-h-72 overflow-y-auto">
          <FilterOption
            label="All Departments"
            selected={!value}
            onSelect={() => pick("")}
            testid={`${testid}-all`}
          />
          {(departments || []).map((d) => (
            <FilterOption
              key={d}
              label={titleCase(d)}
              selected={!!value && nameKey(d) === nameKey(value)}
              onSelect={() => pick(d)}
              testid={`${testid}-${d}`}
            />
          ))}
          {value && !known && (
            <FilterOption label={titleCase(value)} selected onSelect={() => pick(value)} testid={`${testid}-current`} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** The mobile card list and desktop table that show a filtered set of employees —
 *  identical markup whether it's reached from the Employees tab or from a department
 *  tab on Departments & Designation, so the two never drift into two different tables. */
// Blank when work_type was never set — not every employee is tagged to a vertical, and an
// empty cell says that plainly instead of a badge reading "Offline" for someone nobody
// actually classified. Offline now reads the same way, for the reason in modeBadge: it is
// what most of the list already is, so tagging it marks nobody out.
const WorkTypeCell = ({ e }) => {
  const badge = modeBadge(e.work_type);
  if (!e.work_type && !e.service) return <span className="text-slate-300">—</span>;
  return (
    <div className="leading-tight">
      {badge && (
        <span className="inline-flex rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
          {badge}
        </span>
      )}
      {/* The practice beside the mode, in the same slate every neutral tag here wears:
          the two together are the vertical, and reading them apart is what the Employment
          tab asks for. Absent for anybody nobody classified, like the mode itself. */}
      {e.service && (
        <span className={`${badge ? "ml-1 " : ""}inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600`}>
          {SERVICE_LABELS[e.service] || e.service}
        </span>
      )}
      {/* An online employee is not at a branch, so the line says the mode instead of an
          address. See modeHasBranch. */}
      <p className="mt-0.5 text-[11px] text-slate-500">
        {modeHasBranch(e.work_type) ? (e.branch_name || "—") : ONLINE_MODE_LABEL}
      </p>
    </div>
  );
};

/** Online / Offline / Both, set in place.
 *
 * Three buttons rather than a dropdown, because there are exactly three answers and a
 * dropdown would hide two of them behind a click to show a value that is already one word
 * long. Saved the moment it is pressed, like the branch beside it: this is a correction to
 * a fact, not a form being filled, and an Apply button over one field is furniture.
 *
 * The mode that is already set stays pressable and simply does nothing, rather than being
 * disabled — a disabled control in a row of three reads as unavailable, when what is true
 * is that it is the current answer.
 */
const WorkModeToggle = ({ value, disabled, onPick, testid }) => (
  <div
    className="flex shrink-0 overflow-hidden rounded-md border border-slate-200"
    role="group"
    aria-label="Work mode"
    data-testid={testid}
  >
    {MODE_OPTIONS.map((m) => {
      // Offline is lit for everything that is not Online — blank included, since blank is
      // what most of the directory holds and it means the room. Without this the control
      // would show neither side pressed for almost everybody, reading as "unanswered" for
      // a question that has an answer.
      const on = m === MODE_ONLINE ? isOnlineMode(value) : !isOnlineMode(value);
      return (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => !on && onPick(m)}
          aria-pressed={on}
          className={`h-8 min-w-[4.5rem] px-4 text-sm font-semibold transition disabled:opacity-50 ${
            on ? "bg-slate-700 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
          }`}
          data-testid={`${testid}-${m}`}
        >
          {MODE_LABELS[m]}
        </button>
      );
    })}
  </div>
);

/**
 * What this person is on, read the way payroll reads it.
 *
 * Gross where there is one and net otherwise — the same order _monthly_base picks in on
 * the server, and the same figure the salary panel calls "current", so the directory
 * cannot name a different salary from the one that pays.
 *
 * This column showed net_salary alone under a "Net Salary" heading. A salary set from
 * Payroll Management goes to whichever of the two fields already means something (see
 * _salary_field), and for anybody who had neither — everybody paid through the salary
 * timeline and nothing else — that is gross. So a directory of forty-eight people read
 * ₹0 down the whole column while payroll held a figure for every one of them.
 *
 * The heading is "Salary" for the same reason: which of the two an employee is on is a
 * fact about that employee, and the View dialog breaks both out for anybody who needs to
 * know which.
 */
const monthlySalary = (e) => Number(e.gross_salary) || Number(e.net_salary) || 0;

/** Which of the two figures the number beside it came from, for the hover. */
const salaryBasis = (e) => (
  Number(e.gross_salary) > 0
    ? "Gross salary"
    : Number(e.net_salary) > 0
      ? "Net salary"
      : "No salary set yet"
);

const EmployeeDirectory = ({ employees, onView }) => (
  <>
    <div className="space-y-2 md:hidden" data-testid="hr-emp-cards">
      {employees.map((e) => (
        <div key={e.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`hr-emp-card-${e.id}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <EmployeeAvatar employee={e} size={36} />
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{e.full_name}</p>
                <p className="text-xs text-slate-400">{e.employee_code}</p>
              </div>
            </div>
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${e.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{e.status || "active"}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <span>{e.designation || "—"}{e.department ? ` · ${e.department}` : ""}</span>
            <span className="font-semibold text-emerald-600" title={salaryBasis(e)}>₹{monthlySalary(e).toLocaleString("en-IN")}</span>
          </div>
          {e.work_type && (
            <div className="mt-1.5">
              <WorkTypeCell e={e} />
            </div>
          )}
          <div className="mt-1 text-xs text-slate-500">{e.email}{displayPhone(e.phone) ? ` · ${displayPhone(e.phone)}` : ""}</div>
          <div className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-2">
            <button onClick={() => onView(e)} className="flex items-center gap-1 text-xs font-medium text-sky-600" data-testid={`hr-emp-card-view-${e.id}`}><Eye className="h-3.5 w-3.5" />View</button>
          </div>
        </div>
      ))}
      {employees.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">No employees.</p>}
    </div>

    <Card className="hidden overflow-hidden md:block">
      <CardContent className="p-0">
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr><th className="px-3 py-2">S.No</th><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Dept</th><th className="px-3 py-2">Designation</th><th className="px-3 py-2">Work Type</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Joining</th><th className="px-3 py-2">Salary</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Action</th></tr>
            </thead>
            <tbody>
              {employees.map((e, i) => (
                <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`hr-emp-row-${e.id}`}>
                  <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <EmployeeAvatar employee={e} size={32} />
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">{e.full_name}</p>
                        <p className="text-xs text-slate-400">{e.employee_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{e.department || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{e.designation || "—"}</td>
                  <td className="px-3 py-2"><WorkTypeCell e={e} /></td>
                  <td className="px-3 py-2 text-xs text-slate-600">{e.email}<br />{displayPhone(e.phone)}</td>
                  <td className="px-3 py-2 text-slate-500">{e.joining_date || "—"}</td>
                  <td className="px-3 py-2 font-semibold text-emerald-600" title={salaryBasis(e)}>₹{monthlySalary(e).toLocaleString("en-IN")}</td>
                  <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${e.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{e.status || "active"}</span></td>
                  <td className="px-3 py-2">
                    <button onClick={() => onView(e)} title="View employee" aria-label={`View ${e.full_name}`} className="text-slate-500 hover:text-sky-600" data-testid={`hr-emp-view-${e.id}`}><ChevronRight className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && <tr><td colSpan="10" className="px-3 py-6 text-center text-slate-400">No employees.</td></tr>}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  </>
);

// ---------- Employees ----------

const EmployeesTab = ({ meta, reloadMeta, initialFilter }) => {
  const [employees, setEmployees] = useState([]);
  const [search, setSearch] = useState("");
  const filterStatus = initialFilter?.status || "active";
  const [sortAZ, setSortAZ] = useState(null); // null = as-loaded | "asc" | "desc"
  // Arrived at from a Department Strength bar or a Departments & Designation tab.
  const [department, setDepartment] = useState(initialFilter?.department || "");
  const [designation, setDesignation] = useState(initialFilter?.designation || "");
  // Same Online/Offline split as Branches & Verticals — reads each employee's own
  // work_type, set (optionally) from the Add/Edit Employee form.
  const [workType, setWorkType] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => hrEmployees({ status: filterStatus === "all" ? "" : filterStatus }).then(setEmployees).catch((e) => console.warn("[load failed]", e?.message || e)), [filterStatus]);
  useEffect(() => { load(); }, [load]);

  // Designation options narrow to whichever department is picked, so the picker never
  // offers a combination ("Accountant" under "Doctors") that would filter to nothing.
  //
  // Grouped by department rather than listed flat. With every department's titles in one
  // row this filter ran to sixteen pills over two lines and nothing in it said which job
  // belonged to which department, so the reader had to already know the org to use it.
  // See groupedDesignations.
  //
  // Each department's own configured designation list (Departments & Designation →
  // Manage Designations) is what fills the groups, not only who currently holds a job — a
  // designation with zero employees today (a newly added admin type, say) still needs to
  // show up as a filter, or there'd be no way to filter for the first person hired into it.
  const designationGroups = useMemo(
    () => groupedDesignations(meta, department, employees),
    [employees, department, meta]
  );

  const filtered = employees.filter((e) => {
    // "Unassigned" is what the Dashboard calls an employee with no department, so it has
    // to match the empty field here or that bar would open an empty list.
    if (department && (e.department || "Unassigned") !== department) return false;
    // Folded, so the one pill standing for a job finds everyone filed under any spelling
    // of it rather than the half that happen to match its capitals.
    if (designation && nameKey(e.designation) !== nameKey(designation)) return false;
    // Compared as the two answers the OS has, not as stored strings: filtering to Offline
    // has to find everybody blank as well, who are most of them.
    if (workType && modeValue(e.work_type) !== modeValue(workType)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (e.full_name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q) || (e.employee_code || "").toLowerCase().includes(q);
  });

  const sorted = sortAZ
    ? [...filtered].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "") * (sortAZ === "asc" ? 1 : -1))
    : filtered;

  const remove = async (emp) => {
    // Says what else goes, because it is no longer only this row: the login linked to
    // them is deleted permanently with it, and Credentials loses them too.
    if (!window.confirm(`Delete employee ${emp.full_name}?

Their login account (if linked) is permanently deleted too, so they leave Employees, Credentials and Department & Designation. A copy is kept in History.`)) return;
    try { await hrDeleteEmployee(emp.id); toast.success("Deleted"); setViewing(null); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Delete failed"); }
  };

  // Offered only when it would actually match someone — otherwise every install shows an
  // "Unassigned" option that filters to an empty list.
  const hasUnassigned = employees.some((e) => !e.department);

  // flex+gap, not space-y — the desktop table below is hidden by class on mobile.
  return (
    <div className="flex flex-col gap-3" data-testid="hr-employees-tab">
      {/* One toolbar: Search, A → Z, Department, Designation, Work Type, then Add Employee
          pushed to the far end. Department and Designation are the same pair of dropdowns
          Credentials uses — picking a department narrows the designations beside it.
          "Unassigned" is offered only when somebody actually has no department. Work Type
          has no Both pill: somebody who works the two modes already appears under each. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="hr-emp-toolbar">
        <SearchIconInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee..." testid="hr-emp-search" />
        <button
          type="button"
          onClick={() => setSortAZ((s) => (s === "asc" ? "desc" : "asc"))}
          title="Sort by name"
          className={`h-10 shrink-0 rounded-md border px-3 text-sm font-medium transition ${sortAZ ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          data-testid="hr-emp-sort-az"
        >
          {sortAZ === "desc" ? "Z → A" : "A → Z"}
        </button>
        <DepartmentFilterSelect
          value={department}
          onChange={(d) => { setDepartment(d); setDesignation(""); }}
          departments={hasUnassigned ? [...meta.departments, "Unassigned"] : meta.departments}
          testid="hr-emp-dept-filter-select"
        />
        <DesignationFilterSelect
          value={designation}
          onChange={setDesignation}
          groups={designationGroups}
          testid="hr-emp-designation-filter-select"
        />
        <div className="flex items-center gap-2" data-testid="hr-emp-worktype-filter">
          <TabPill active={workType === ""} onClick={() => setWorkType("")} testid="hr-emp-worktype-filter-all">
            All
          </TabPill>
          <TabPill active={workType === "online"} onClick={() => setWorkType("online")} testid="hr-emp-worktype-filter-online">
            Online
          </TabPill>
          <TabPill active={workType === "offline"} onClick={() => setWorkType("offline")} testid="hr-emp-worktype-filter-offline">
            Offline
          </TabPill>
        </div>
        {/* History sits with Add Employee at the far end: both are about the list as a
            whole rather than a filter on it. */}
        <button
          type="button"
          onClick={() => setShowHistory(true)}
          title="Deleted employees"
          aria-label="Deleted employees"
          className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
          data-testid="hr-emp-history-btn"
        >
          <History className="h-4 w-4" />
        </button>
        <Button onClick={() => { setEditing(null); setShowAdd(true); }} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-emp-add-btn"><Plus className="h-4 w-4 mr-1" />Add Employee</Button>
      </div>

      <EmployeeDirectory employees={sorted} onView={setViewing} />

      {viewing && (
        <EmployeeViewModal
          employee={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); setShowAdd(true); }}
          onDelete={() => remove(viewing)}
        />
      )}

      {showHistory && <EmployeeHistoryModal onClose={() => setShowHistory(false)} />}

      {showAdd && <AddEmployeeModal employee={editing} meta={meta} reloadMeta={reloadMeta} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />}
    </div>
  );
};

// ---------- Employee View Modal ----------

const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const ViewRow = ({ label, value }) => (
  <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0">
    <span className="shrink-0 text-xs text-slate-500">{label}</span>
    <span className="text-right text-xs font-medium text-slate-800">{value || "—"}</span>
  </div>
);

const ViewSection = ({ title, children }) => (
  <div className="rounded-xl border border-slate-200 p-3">
    {/* Optional: the tab bar above already names the section when this card sits under
        one, and repeating it there reads as the same word twice. */}
    {title && <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</p>}
    {children}
  </div>
);

// The five stops the read-only record is read in — the same five, in the same order,
// as the Add/Edit dialog below, so a reader who knows where a field is written finds
// it again here under the same tab name.
const VIEW_TABS = [
  { key: "personal", label: "Personal" },
  { key: "employment", label: "Employment" },
  { key: "id_docs", label: "ID & Documents" },
  { key: "address", label: "Address & Emergency" },
  { key: "salary", label: "Salary & Bank" },
];

/**
 * The employee record, read-only, with Edit and Delete on it — the single entry point
 * from the directory's Actions column. Deleting from a row you can only identify by
 * position is how the wrong person gets removed; here the whole record is on screen
 * first.
 */
const EmployeeViewModal = ({ employee: e, onClose, onEdit, onDelete }) => {
  // The dialog remounts on every open ({viewing && ...} above), so this always starts
  // on the first tab rather than the one the last employee viewed was left on.
  const [tab, setTab] = useState("personal");
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
      data-testid="hr-emp-view-modal"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <EmployeeAvatar employee={e} size={44} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-base font-semibold text-slate-900" data-testid="hr-emp-view-name">{e.full_name}</h3>
                <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${e.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{e.status || "active"}</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {e.employee_code || "No code"}{e.designation ? ` · ${e.designation}` : ""}{e.department ? ` · ${e.department}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-600" data-testid="hr-emp-view-close"><X className="h-4 w-4" /></button>
        </div>

        {/* Same tab-bar shape as the Add/Edit dialog's below, so the read and the write
            of a record look like one form in two moods. The labels are fixed prose, so
            they sit in the header band rather than the body that scrolls. */}
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-slate-200 px-5 py-2 text-xs">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-3 py-1 ${tab === t.key ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
              data-testid={`hr-emp-view-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "personal" && (
            <div className="space-y-3">
              <ViewSection>
                <ViewRow label="Email" value={e.email} />
                <ViewRow label="Phone" value={displayPhone(e.phone)} />
                <ViewRow label="Date of Birth" value={e.dob} />
                <ViewRow label="Gender" value={e.gender} />
                <ViewRow label="Blood Group" value={e.blood_group} />
                <ViewRow label="Marital Status" value={e.marital_status} />
                <ViewRow label="Father's Name" value={e.father_name} />
                <ViewRow label="Mother's Name" value={e.mother_name} />
              </ViewSection>
              {/* Notes rides with Personal. The Edit dialog no longer asks for it, so this
                  only shows notes written before that field came out. */}
              {e.notes && (
                <ViewSection title="Notes">
                  <p className="whitespace-pre-wrap text-xs text-slate-700">{e.notes}</p>
                </ViewSection>
              )}
            </div>
          )}

          {tab === "employment" && (
            <ViewSection>
              <ViewRow label="Employee Code" value={e.employee_code} />
              <ViewRow label="Department" value={e.department} />
              <ViewRow label="Designation" value={e.designation} />
              <ViewRow label="Work Type" value={MODE_LABELS[modeValue(e.work_type)]} />
              <ViewRow label="Service" value={e.service ? (SERVICE_LABELS[e.service] || e.service) : ""} />
              <ViewRow label="Branch" value={e.branch_name} />
              <ViewRow label="Joining Date" value={e.joining_date} />
              <ViewRow label="Reporting To" value={e.reporting_to} />
              <ViewRow label="Status" value={e.status || "active"} />
            </ViewSection>
          )}

          {tab === "id_docs" && (
            <ViewSection>
              <ViewRow label="PAN" value={e.pan} />
              <ViewRow label="Aadhar" value={e.aadhar} />
            </ViewSection>
          )}

          {tab === "address" && (
            <ViewSection>
              <ViewRow label="Address" value={e.address} />
              <ViewRow label="Emergency Contact" value={e.emergency_contact_name} />
              <ViewRow label="Emergency Phone" value={e.emergency_contact_phone} />
            </ViewSection>
          )}

          {tab === "salary" && (
            <ViewSection>
              <ViewRow label="Net Salary" value={money(e.net_salary)} />
              <ViewRow label="Gross Salary" value={money(e.gross_salary)} />
              <ViewRow label="Bank Name" value={e.bank_name} />
              <ViewRow label="Account Number" value={e.bank_account} />
              <ViewRow label="IFSC" value={e.ifsc} />
            </ViewSection>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-5 py-3">
          {/* No Edit or Delete on a record read out of History: the employee it describes
              no longer exists to be changed. */}
          {onDelete ? (
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            data-testid="hr-emp-view-delete"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} data-testid="hr-emp-view-cancel">Close</Button>
            {onEdit && (
              <Button onClick={onEdit} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-emp-view-edit">
                <Pencil className="mr-1.5 h-4 w-4" /> Edit
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------- Employee History ----------

/**
 * Employees deleted from HR. Deleting one removes the record and its login for good, so
 * this is the only place what they were is still written down — read-only, opened from
 * the History icon on the Employees toolbar. A row opens the same View dialog the live
 * directory uses, minus Edit and Delete.
 */
const EmployeeHistoryModal = ({ onClose }) => {
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    hrEmployeeHistory().then(setRows).catch((e) => {
      toast.error(e?.response?.data?.detail || "Failed to load history");
      setRows([]);
    });
  }, []);

  const q = search.trim().toLowerCase();
  const shown = (rows || []).filter((r) => {
    if (!q) return true;
    const e = r.employee || {};
    return [e.full_name, e.employee_code, e.email, e.department, e.designation, ...(r.accounts || []).map((a) => a.email)]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
      data-testid="hr-emp-history-modal"
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <History className="h-4 w-4 shrink-0 text-slate-500" />
            <h3 className="truncate text-base font-semibold text-slate-900">Deleted Employees</h3>
            {rows && <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{rows.length}</span>}
          </div>
          <div className="flex items-center gap-2">
            <SearchIconInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search history..." testid="hr-emp-history-search" />
            <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-600" data-testid="hr-emp-history-close"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {rows === null ? (
            <p className="p-6 text-center text-sm text-slate-500">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">{rows.length ? "No deleted employee matches that search." : "No employees have been deleted yet."}</p>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Dept / Designation</th>
                  <th className="px-3 py-2">Branch</th>
                  <th className="px-3 py-2">Login</th>
                  <th className="px-3 py-2">Deleted</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const e = r.employee || {};
                  return (
                    <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setViewing(e)} data-testid="hr-emp-history-row">
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-900">{e.full_name || "—"}</p>
                        <p className="text-xs text-slate-500">{e.employee_code || "No code"}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p className="text-slate-700">{e.department || "—"}</p>
                        <p className="text-xs text-slate-500">{e.designation || "—"}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{e.branch_name || "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {(r.accounts || []).length ? r.accounts.map((a) => (
                          <p key={a.id} className="text-slate-700">{a.email} <span className="text-slate-400">· {roleLabel(a.role)}</span></p>
                        )) : <span className="text-slate-400">No login</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <p className="text-slate-700">{dashDate(r.deleted_at)}</p>
                        <p className="text-slate-500">by {r.deleted_by?.full_name || "—"}</p>
                      </td>
                      <td className="px-3 py-2 text-slate-400"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {viewing && <EmployeeViewModal employee={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};

// ---------- Manual date entry ----------

const isoToDmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

/** "07-03-1994" -> "1994-03-07", but only for a date that actually exists. The
 *  round-trip check is what rejects 31-02: the Date constructor rolls that forward
 *  to 3 March rather than failing, so comparing the parts back is the only way to
 *  catch it. */
const dmyToIso = (text) => {
  const m = /^\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})\s*$/.exec(text || "");
  if (!m) return "";
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00`);
  if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) return "";
  return iso;
};

/** Digits in, DD-MM-YYYY out — the separators appear as you type so nobody has to
 *  reach for the dash key, and pasting a date with slashes or dots still works. */
const formatDmyTyping = (text) => {
  const d = (text || "").replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
};

/**
 * Typed date entry, for a field where picking is the slow way round.
 *
 * A calendar is right for a date near today — an appointment, a due date. A date of
 * birth is decades back, which is twenty-odd clicks through months, so this takes it
 * typed instead. Emits the same `{ target: { value } }` ISO shape the picker does, so
 * the form it feeds doesn't know the difference.
 */
const ManualDateInput = ({ value, onChange, placeholder = "DD-MM-YYYY", testid }) => {
  const [text, setText] = useState(isoToDmy(value));
  const [touched, setTouched] = useState(false);

  // Follow the record when it changes underneath — opening Edit on another employee
  // reuses this component rather than remounting it.
  useEffect(() => { setText(isoToDmy(value)); setTouched(false); }, [value]);

  const handle = (e) => {
    const next = formatDmyTyping(e.target.value);
    setText(next);
    const iso = dmyToIso(next);
    if (iso) onChange({ target: { value: iso } });
    else if (next === "") onChange({ target: { value: "" } });
  };

  const complete = text.replace(/\D/g, "").length === 8;
  const invalid = touched && text !== "" && !dmyToIso(text);
  const future = !invalid && dmyToIso(text) && dmyToIso(text) > new Date().toISOString().slice(0, 10);

  return (
    <div>
      <input
        value={text}
        onChange={handle}
        onBlur={() => setTouched(true)}
        placeholder={placeholder}
        inputMode="numeric"
        maxLength={10}
        className={`h-9 w-full rounded-md border px-3 text-sm outline-none transition placeholder:text-slate-400 focus:ring-1 ${
          invalid || future ? "border-rose-300 focus:border-rose-400 focus:ring-rose-300" : "border-slate-200 focus:border-sky-400 focus:ring-sky-300"
        }`}
        data-testid={testid}
      />
      {(invalid || future) && (
        <p className="mt-1 text-[11px] font-medium text-rose-600" data-testid={`${testid}-error`}>
          {future ? "That date is in the future." : complete ? "That date doesn't exist." : "Use DD-MM-YYYY."}
        </p>
      )}
    </div>
  );
};

// ---------- Add Employee Modal (multi-tab) ----------

const EMP_TABS = [
  { key: "personal", label: "Personal" },
  { key: "employment", label: "Employment" },
  { key: "id_docs", label: "ID & Docs" },
  { key: "address", label: "Address & Emergency" },
  // Bank details and the PAN they are paid against. It used to open with two salary
  // boxes, which is not where a salary is set: a salary is a timeline of records with a
  // reason and a month behind each one, kept in Payroll Management, and this form wrote
  // straight over the figure that timeline had put on the employee. Two doors onto one
  // number, and the one with no history behind it won.
  { key: "bank", label: "Bank & PAN" },
];

const blankEmployee = {
  full_name: "", email: "", phone: "", dob: "", gender: "", blood_group: "",
  marital_status: "", father_name: "", mother_name: "", photo_url: "",
  department: "", designation: "", joining_date: "", reporting_to: "", employee_code: "",
  pan: "", aadhar: "",
  address: "", emergency_contact_name: "", emergency_contact_phone: "",
  net_salary: 0, gross_salary: 0, bank_name: "", bank_account: "", ifsc: "",
  status: "active", notes: "", work_type: "", service: "", branch_id: "",
};

/** Turns a designation into the role slug a login holds for it.
 *
 * A designation and a role are one thing in this OS, so the same answer is needed in two
 * places: Create User, which gives a new login the employee's role, and the employee form,
 * whose designation change moves the linked login's role with it. One map for both, or
 * the two would hand the same title two different roles.
 *
 * A title that matches a real access role (built-in or custom) gives that slug. One that
 * matches none is created as a custom role from that exact title — what Create User has
 * always done. resolve() answers "" when there is no title or the role could not be made.
 */
const designationKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const useDesignationRole = (meta, reloadMeta) => {
  const [resolving, setResolving] = useState(false);
  // Retired slugs are skipped, not merely ordered around.
  //
  // A retired role wears the label of the role that replaced it — that is the whole point
  // of keeping it, so a legacy account reads as a name rather than a raw slug — which
  // means several entries answer to one label and the last one written would win. That is
  // this map backwards: it exists to turn a job title into the slug to GIVE somebody, and
  // the one slug it must never hand out is the one the OS has retired. Picking the "Branch
  // Admin" designation would have created an account on branch_admin_physio_fitness, which
  // the next restart then had to migrate back off.
  const labelToSlug = useMemo(() => {
    const map = {};
    Object.entries(ROLE_META).forEach(([slug, m]) => { if (!m.retired) map[designationKey(m.label)] = slug; });
    (meta?.custom_roles || []).forEach((r) => { if (r.name && r.label) map[designationKey(r.label)] = r.name; });
    return map;
  }, [meta?.custom_roles]);

  const resolve = useCallback(async (label) => {
    if (!label) return "";
    const existing = labelToSlug[designationKey(label)];
    if (existing) return existing;
    setResolving(true);
    try {
      const created = await hrAddCustomRole(label);
      await reloadMeta?.();
      return created.name;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to set role");
      return "";
    } finally {
      setResolving(false);
    }
  }, [labelToSlug, reloadMeta]);

  return { resolve, resolving };
};

const AddEmployeeModal = ({ employee, meta, reloadMeta, initialDepartment, initialDesignation, onClose, onSaved }) => {
  const { resolve: resolveRole } = useDesignationRole(meta, reloadMeta);
  const [tab, setTab] = useState("personal");
  // initialDepartment/initialDesignation only seed a brand-new form — editing keeps using
  // the record's own values, and `employee` (not these fields) is what submit() checks to
  // decide create vs. update, so this never risks turning a create into an update.
  const [form, setForm] = useState(employee ? { ...blankEmployee, ...employee } : { ...blankEmployee, department: initialDepartment || "", designation: initialDesignation || "" });
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  // The picked photo is held here and only uploaded when the form is submitted — the same
  // order the store's item images use. Abandoning the dialog then costs nothing at all,
  // rather than leaving a file on disk nothing points at.
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null); // object URL for the picked file
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef(null);

  // Revoked on replace and on unmount: an object URL pins the whole file in memory until
  // it is, and this dialog can be opened over and over across a directory.
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const pickPhoto = (file) => {
    if (!file) return;
    // Checked here as well as on the server so the answer is immediate — the server still
    // refuses these, but after a full upload of something it was never going to keep.
    if (!PHOTO_TYPES.includes(file.type)) { toast.error("Choose a JPG, PNG or WEBP image"); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Photo must be under 5MB"); return; }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  // Clears the stored photo too: "" is what update_employee reads as remove, since it
  // drops nulls from a partial update.
  const clearPhoto = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    set("photo_url", "");
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const [branches, setBranches] = useState([]);
  useEffect(() => { getBranches().then(setBranches).catch(() => {}); }, []);
  // Whichever branches match the picked Work Type and Service — mode from the same filter
  // Branches & Verticals' own pills use, practice from the other half of the vertical.
  //
  // Service narrows only when it has been answered and answered narrowly: "" is nobody
  // having said, and "both" is somebody who works the two practices, and neither is a
  // reason to hide a branch. A vertical whose practice isn't recognised stays listed for
  // the same reason — see verticalPractice.
  const branchOptions = useMemo(
    () => branches.filter((b) => {
      // Offline is the default, so a blank Work Type narrows to the branches in the room
      // rather than to all of them. Online never reaches here: the Branch field is not
      // shown for it at all.
      if (isOnlineVertical(b.vertical) !== isOnlineMode(form.work_type)) return false;
      if (!form.service || form.service === PRACTICE_BOTH) return true;
      const practice = verticalPractice(b.vertical);
      return practice === null || practice === form.service;
    }),
    [branches, form.work_type, form.service],
  );
  // Switching either axis clears any branch already picked — a branch left set after the
  // filter moves under it would silently tag the employee to one that no longer matches
  // the Work Type and Service shown beside it.
  // Switching mode always clears the branch already picked, because the filter beneath it
  // moves and a branch left set would tag the employee to one that no longer matches. For
  // Online it is not merely cleared but not asked for at all: an online employee is not at
  // a branch, and the field is gone rather than left empty for somebody to fill back in.
  const changeWorkType = (v) => setForm((p) => ({ ...p, work_type: v, branch_id: "" }));
  const changeService = (v) => setForm((p) => ({ ...p, service: v, branch_id: "" }));

  // Designation options are scoped to whichever Department is selected (grouped from
  // the Departments & Designation tab). Departments not grouped yet fall back to the
  // full role list, so the form stays usable while that grouping is still in progress.
  // An employee whose designation predates this list keeps it as an option so editing
  // them never silently blanks the field.
  //
  // Read through designationsUnder rather than indexing department_designations directly,
  // and passed through uniqueDesignations on the way out. That buys two things this one was
  // missing. The lookup now survives a department name written with different punctuation:
  // a miss there returns nothing, and "nothing configured" is exactly what the line below
  // treats as "fall back to the whole role list", so a stray bracket was silently unscoping
  // the picker and offering Management's titles under Doctors. And the list comes back with
  // one entry per job — both the department's stored list and the role list could hold the
  // same title twice, CONSULTANT beside Consultant, which this Select's uppercase styling
  // renders identically, so the picker was showing options nothing could tell apart.
  //
  // Order is the department's own, not alphabetical: it is what the drag handles on
  // Departments & Designation write, and this picker is where it should read.
  const designationOptions = useMemo(() => {
    const scoped = uniqueDesignations(designationsUnder(meta.department_designations || {}, form.department));
    const base = scoped.length > 0 ? scoped : uniqueDesignations((meta.roles || []).map(roleLabel));
    const current = (form.designation || "").trim();
    // Compared on jobKey, not with includes: a record holding "CONSULTANT" against a list
    // holding "Consultant" was appending a second option that read the same as the first.
    const known = base.some((d) => jobKey(d) === jobKey(current));
    const all = current && !known ? [...base, current] : base;
    return ["", ...all];
  }, [meta, form.department, form.designation]);

  // Changing Department drops a Designation that doesn't belong to the new one. Without
  // this the old title stays selected and the memo above re-offers it as an extra option,
  // so the field could be saved holding a Doctors title under Management — which is the
  // department-wise scoping defeated at the one moment it matters. A title the new
  // department also lists is kept: that is the same job, not a stale one.
  const changeDepartment = (v) => setForm((p) => {
    const valid = designationsUnder(meta.department_designations || {}, v);
    const keep = valid.some((d) => jobKey(d) === jobKey(p.designation));
    return { ...p, department: v, designation: keep ? p.designation : "" };
  });

  const submit = async () => {
    if (!form.full_name.trim()) { toast.error("Full name required"); setTab("personal"); return; }
    if (!form.department) { toast.error("Pick a Department"); setTab("employment"); return; }
    if (!form.designation) { toast.error("Pick a Designation"); setTab("employment"); return; }
    // Online is two arms — Online Physiotherapy and Online Fitness — and Service is what
    // says which of them this person works. Offline does not ask: a room is chosen by name
    // in the Branch field below, which Online does not have.
    if (isOnlineMode(form.work_type) && !form.service) {
      toast.error("Pick a Service — it decides which online arm they work");
      setTab("employment");
      return;
    }
    const payload = { ...form };
    // Still sent, with no box on the form behind them any more. The form is seeded from
    // the employee, so on an edit these carry back whatever Payroll Management last wrote
    // there and the save leaves it exactly as it was; dropping them would send a salary
    // of nothing and wipe the figure the timeline had put on. On a create they are the
    // zeroes a brand-new employee starts on, which is what tells the first salary record
    // which of the two fields to take (see _salary_field).
    payload.net_salary = Number(payload.net_salary) || 0;
    payload.gross_salary = Number(payload.gross_salary) || 0;
    try {
      // Before the record, so it can point at the file. A failed upload stops here rather
      // than saving an employee whose photo silently didn't take.
      if (photoFile) {
        setUploadingPhoto(true);
        try {
          const uploaded = await uploadEmployeePhoto(photoFile);
          payload.photo_url = uploaded.url;
        } finally { setUploadingPhoto(false); }
      }
      // A changed designation is a changed role: the linked login follows it. Only on a
      // change, so a login whose role was set apart from its title on purpose is not
      // pulled back to it by an unrelated edit to their phone number.
      if (employee && jobKey(form.designation) !== jobKey(employee.designation)) {
        const role = await resolveRole(form.designation);
        if (role) payload.account_role = role;
      }
      if (employee) { await hrUpdateEmployee(employee.id, payload); toast.success("Employee updated"); }
      else { await hrCreateEmployee(payload); toast.success("Employee created"); }
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="hr-emp-modal">
      <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h3 className="text-base font-semibold">{employee ? "Edit Employee" : "Add New Employee"}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="hr-emp-modal-close"><X className="h-4 w-4" /></button>
        </div>
        {/* Sections down the left, the open one's fields down the right, one field to a
            row. A fixed height keeps the dialog from jumping as a short tab like ID & Docs
            replaces a long one like Personal. */}
        <div className="flex h-[60vh] flex-col sm:flex-row">
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/60 p-2 text-xs sm:w-48 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r" data-testid="hr-emp-modal-tabs">
            {EMP_TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left ${tab === t.key ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`} data-testid={`hr-emp-modal-tab-${t.key}`}>{t.label}</button>
            ))}
          </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {tab === "personal" && (
            <div className="grid gap-3">
              {/* Above the fields, and spanning them, because it is the one part of this
                  record you identify a person by rather than read. The hidden input is
                  driven by the buttons: a bare file input cannot be styled and prints the
                  chosen filename beside itself, which here duplicates the preview. */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                <EmployeeAvatar
                  employee={{ full_name: form.full_name, photo_url: photoPreview || form.photo_url }}
                  size={36}
                  className="ring-2 ring-white"
                />
                <p className="min-w-0 text-xs font-medium text-slate-600">
                  Profile Photo <span className="ml-1 text-[11px] font-normal text-slate-400">JPG, PNG or WEBP · up to 5MB</span>
                </p>
                <div className="ml-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(ev) => pickPhoto(ev.target.files?.[0])}
                      data-testid="hr-emp-photo-input"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => photoInputRef.current?.click()}
                      className="h-8 text-xs"
                      data-testid="hr-emp-photo-pick"
                    >
                      <Camera className="mr-1.5 h-3.5 w-3.5" />
                      {photoPreview || form.photo_url ? "Change Photo" : "Upload Photo"}
                    </Button>
                    {(photoPreview || form.photo_url) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={clearPhoto}
                        className="h-8 border-rose-200 text-xs text-rose-600 hover:bg-rose-50"
                        data-testid="hr-emp-photo-remove"
                      >
                        <ImageOff className="mr-1.5 h-3.5 w-3.5" /> Remove
                      </Button>
                    )}
                    {/* Says the picture is not saved yet, because the dialog's own Save is
                        what sends it — closing here would drop it silently otherwise. */}
                    {photoFile && (
                      <span className="text-[11px] font-medium text-amber-600" data-testid="hr-emp-photo-pending">
                        Saves with the form
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <Field label="Full Name *"><Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} data-testid="hr-emp-name" /></Field>
              <Field label="Email"><Input value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="hr-emp-email" /></Field>
              <Field label="Phone"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} data-testid="hr-emp-phone" /></Field>
              {/* Typed, not picked. A birth date is decades back — reaching it in a
                  calendar is twenty-odd clicks through months, where typing it is eight
                  keystrokes. Joining Date keeps its picker; that one is near today. */}
              <Field label="Date of Birth"><ManualDateInput value={form.dob} onChange={(e) => set("dob", e.target.value)} testid="hr-emp-dob" /></Field>
              <Field label="Gender"><Select value={form.gender} onChange={(v) => set("gender", v)} options={["", "Male", "Female", "Other"]} testid="hr-emp-gender" /></Field>
              <Field label="Blood Group"><Select value={form.blood_group} onChange={(v) => set("blood_group", v)} options={["", "O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-"]} testid="hr-emp-bg" /></Field>
              <Field label="Marital Status"><Select value={form.marital_status} onChange={(v) => set("marital_status", v)} options={["", "Single", "Married", "Divorced", "Widowed"]} testid="hr-emp-marital" /></Field>
              <Field label="Father's Name"><Input value={form.father_name} onChange={(e) => set("father_name", e.target.value)} data-testid="hr-emp-father" /></Field>
              <Field label="Mother's Name"><Input value={form.mother_name} onChange={(e) => set("mother_name", e.target.value)} data-testid="hr-emp-mother" /></Field>
            </div>
          )}
          {tab === "employment" && (
            <div className="grid gap-3">
              <Field label="Employee Code"><Input value={form.employee_code} onChange={(e) => set("employee_code", e.target.value)} placeholder="Auto-generated" data-testid="hr-emp-code" /></Field>
              <Field label="Department *"><OsSelect value={form.department} onChange={changeDepartment} options={["", ...meta.departments]} testid="hr-emp-dept" uppercase /></Field>
              <Field label="Designation *"><OsSelect value={form.designation} onChange={(v) => set("designation", v)} options={designationOptions} testid="hr-emp-designation" uppercase /></Field>
              {/* Joining Date, Reporting To and Status are not asked here. Joining Date is
                  stamped when the employee's login is created (create_user_account); all
                  three still ride along in the form, so an edit saves them back unchanged. */}
              {/* None of the three is required. Work Type and Service are the two halves of
                  a branch's vertical — mode and practice — and Branch narrows on both, the
                  same split Branches & Verticals itself uses. Branch still waits for a Work
                  Type: it is meaningless before that. */}
              {/* Both answers are offered, the same two the directory's toggle offers.
                  Leaving it on Select is still not a gap — blank reads as Offline, and the
                  line underneath says so rather than making anybody guess what blank
                  commits them to. Starred and outlined because it decides whether the
                  Branch field beside it appears at all, which is worth answering
                  deliberately even though blank is allowed. */}
              <Field label="Work Type *">
                <OsSelect
                  value={form.work_type}
                  onChange={changeWorkType}
                  options={["", ...MODE_OPTIONS]}
                  labels={{ "": "Select", ...MODE_LABELS }}
                  className={form.work_type ? "" : "border-amber-300 bg-amber-50"}
                  testid="hr-emp-worktype"
                />
                <p className="mt-1 text-[10px] text-slate-400">
                  {isOnlineMode(form.work_type)
                    ? "Works online, so no branch — Service decides the arm."
                    : "Offline — works in the room, at the branch below. Blank reads the same."}
                </p>
              </Field>
              {/* Required for Online and not for Offline, because it answers a different
                  question in each. Offline picks a room by name in the Branch field below.
                  Online has no such field — an online employee is not AT a branch — and
                  online is two arms rather than one place, so this is the only thing that
                  says whether they work Online Physiotherapy or Online Fitness. Left blank
                  it used to post them to neither, and to nothing at all: the Branch field
                  clears on the way to Online, and a cleared branch reads downstream as
                  "taken off their branch". */}
              <Field label={isOnlineMode(form.work_type) ? "Service *" : "Service"}>
                <OsSelect
                  value={form.service}
                  onChange={changeService}
                  options={["", PRACTICE_PHYSIO, PRACTICE_FITNESS, PRACTICE_BOTH]}
                  labels={SERVICE_LABELS}
                  className={isOnlineMode(form.work_type) && !form.service ? "border-amber-300 bg-amber-50" : ""}
                  testid="hr-emp-service"
                />
                {isOnlineMode(form.work_type) && (
                  <p className="mt-1 text-[10px] text-slate-400" data-testid="hr-emp-service-arm">
                    {form.service === PRACTICE_PHYSIO
                      ? "Posted to Online Physiotherapy."
                      : form.service === PRACTICE_FITNESS
                      ? "Posted to Online Fitness."
                      : form.service === PRACTICE_BOTH
                      ? "Posted to both online arms."
                      : "Which online arm they work — Physio, Fitness, or both."}
                  </p>
                )}
              </Field>
              {modeHasBranch(form.work_type) && (
                <Field label="Branch">
                  {/* All Branches is offered here too, or an employee posted to every
                      branch from New Structure would open this form showing "Not picked" —
                      the stored value matching no option — and be cleared by the next save. */}
                  <OsSelect
                    value={form.branch_id}
                    // The list goes with it. The form is seeded from the record, so it
                    // carries whatever branch_ids the record held, and the server reads a
                    // posted list ahead of branch_id — picking Parrys here over a record
                    // holding [Anna Nagar] saved Anna Nagar again. Untouched, the stored
                    // list still passes through as it was.
                    onChange={(v) => setForm((p) => ({ ...p, branch_id: v, branch_ids: v ? [v] : [] }))}
                    options={["", ALL_BRANCHES, ...branchOptions.map((b) => b.id)]}
                    labels={{ "": "— Not picked —", [ALL_BRANCHES]: "All Branches", ...Object.fromEntries(branchOptions.map((b) => [b.id, b.branch_name])) }}
                    testid="hr-emp-branch"
                  />
                </Field>
              )}
            </div>
          )}
          {/* PAN used to be the other half of this. It sits with the bank details now,
              which is what it is actually for here — the account is where the money goes
              and the PAN is what it is paid against, and they are filled in together. */}
          {tab === "id_docs" && (
            <div className="grid gap-3">
              <Field label="Aadhar"><Input value={form.aadhar} onChange={(e) => set("aadhar", e.target.value)} data-testid="hr-emp-aadhar" /></Field>
            </div>
          )}
          {tab === "address" && (
            <div className="grid gap-3">
              <Field label="Address"><textarea value={form.address} onChange={(e) => set("address", e.target.value)} className="h-20 w-full rounded-md border border-slate-200 p-2 text-sm" data-testid="hr-emp-address" /></Field>
              <div className="grid gap-3">
                <Field label="Emergency Contact Name"><Input value={form.emergency_contact_name} onChange={(e) => set("emergency_contact_name", e.target.value)} data-testid="hr-emp-ec-name" /></Field>
                <Field label="Emergency Contact Phone"><Input value={form.emergency_contact_phone} onChange={(e) => set("emergency_contact_phone", e.target.value)} data-testid="hr-emp-ec-phone" /></Field>
              </div>
            </div>
          )}
          {tab === "bank" && (
            <div className="grid gap-3">
              <Field label="Bank Name"><Input value={form.bank_name} onChange={(e) => set("bank_name", e.target.value)} data-testid="hr-emp-bank" /></Field>
              <Field label="Account Number"><Input value={form.bank_account} onChange={(e) => set("bank_account", e.target.value)} data-testid="hr-emp-account" /></Field>
              <Field label="IFSC Code"><Input value={form.ifsc} onChange={(e) => set("ifsc", e.target.value)} data-testid="hr-emp-ifsc" /></Field>
              <Field label="PAN Number"><Input value={form.pan} onChange={(e) => set("pan", e.target.value)} data-testid="hr-emp-pan" /></Field>
              {/* Said rather than left to be discovered: somebody who came to this tab to
                  type a salary needs telling where the salary went, not an empty space
                  where the box used to be. */}
              <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                Salary is set in <b>Payroll Management</b>, on the employee's own salary
                record — each figure filed with the reason for it and the month it starts,
                so what somebody was on in any given month has an answer.
              </p>
            </div>
          )}
        </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="hr-emp-modal-cancel">Cancel</Button>
          <Button onClick={submit} disabled={uploadingPhoto} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-emp-modal-submit">{uploadingPhoto ? "Uploading photo…" : `✓ ${employee ? "Save" : "Add Employee"}`}</Button>
        </div>
      </div>
    </div>
  );
};


const UserBranch = ({ user }) => {
  const branches = user.branches || [];

  if (user.org_wide) {
    return <span className="rounded bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">All branches</span>;
  }
  if (branches.length === 0) return <span className="text-xs text-slate-400">—</span>;

  return (
    <span className="text-xs text-slate-700" title={branches.map((b) => b.name).join(", ")}>
      {branches[0].name}
      {branches.length > 1 && (
        <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
          +{branches.length - 1}
        </span>
      )}
    </span>
  );
};


/**
 * The ROLE cell's picker: one neutral style for the closed box and every row, with the
 * row matching the current value as the only thing highlighted, so which one is picked
 * reads from the highlight rather than from a palette. Same treatment RoleSelectDropdown
 * gives the designation picker.
 *
 * Still built rather than a native <select>, which cannot style its option list at all —
 * the browser draws that, so the rounded rows and the highlight would both be lost.
 *
 * The list is portalled to <body> and pinned to the button's own rect. This picker sits
 * inside the table's overflow-auto scroller, and a list positioned the ordinary way is
 * clipped at that container's edge for every row far enough down it — which is most of
 * them once an install has a screenful of users. It opens upward instead when the row is
 * near the bottom of the window, and closes on any scroll, since a list fixed to the
 * viewport would otherwise sit on while the button it belongs to slides away.
 */
/**
 * A picker, opened as a dialog. Used for a branch and for a role.
 *
 * A dialog rather than a panel hanging off the control: these sit deep inside a card, in a
 * row, inside a list that scrolls — any one of which can clip a panel or stack over it. A
 * dialog answers to none of them, and it has room to say whose branch or role is being
 * changed, which a strip of options beside a button never did.
 *
 * It is also the only shape that can be scrolled. A panel pinned to the viewport has to
 * close when the page moves under it, and a scroll listener that notices the page moving
 * cannot tell that apart from the list being scrolled — so the list shut the moment it was
 * used. A dialog has nothing to keep up with and simply scrolls.
 *
 * Portalled to the body for the same reason, so no ancestor's overflow or stacking context
 * can crop it.
 *
 * No colour anywhere, which was the point of replacing the native select in the first
 * place: white card, slate text, a grey wash on hover, and the current choice marked by
 * weight and a tick rather than by hue.
 */
const PickerModal = ({
  title, value, options, onPick, onClose,
  searchable = false, searchPlaceholder = "Search...", checkbox = false,
  // Multi-select. Off by default, because most of what this picker answers has exactly one
  // answer — a role, a department, the branch a Physio treats at. It is turned on for the
  // desks that genuinely hold several: a Nutritionist works more than one branch and holds
  // a calendar at each, and a control that could only say one of them was the reason a
  // coach covering two had to be recorded as covering neither.
  //
  // A different shape of interaction, not just a different tick: single-select answers on
  // the click, because the click IS the answer. Ticking three boxes is not finished until
  // the person says it is, so multi keeps its own draft and commits on Save — and Escape
  // or Cancel throws the draft away rather than leaving half a selection written.
  multi = false, values = [], onSave,
  // Options that mean something about the whole set rather than a member of it — "no
  // branch", "all branches". Ticking one clears the rest and unticks the others, since
  // "everywhere" and "these three" cannot both be true and leaving the narrower ticks
  // underneath would suggest the wider answer was somehow limited by them.
  exclusive = [],
  // Whether an empty selection is an answer. It is not for a branch: unticking everything
  // for a desk that covers all of them is stored the same way "All Branches" is, so a save
  // on nothing would quietly do the opposite of what the empty list looks like it means.
  // Refused at the button rather than corrected after the fact, so the dialog never says
  // one thing and the row behind it another.
  requireOne = false,
}) => {
  // Opt-in, because most of these lists are five or six rows and a search box over six
  // rows is furniture. The employee list is seventy-odd and unusable without one.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => String(o.search || o.label).toLowerCase().includes(q)) : options;

  // The draft selection, seeded once. Deliberately not kept in step with `values` after
  // that: the parent's copy is what was last saved, and re-syncing to it mid-edit would
  // undo ticks the moment anything upstream re-rendered.
  const [picked, setPicked] = useState(() => (values || []).filter(Boolean));
  const isExclusive = (v) => exclusive.includes(v);
  const on = (v) => (multi ? picked.includes(v) : v === value);
  const toggle = (v) => {
    if (isExclusive(v)) { setPicked(v ? [v] : []); return; }
    setPicked((prev) => {
      const kept = prev.filter((x) => !isExclusive(x));
      return kept.includes(v) ? kept.filter((x) => x !== v) : [...kept, v];
    });
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="hr-branch-picker-modal"
    >
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
            data-testid="hr-branch-picker-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {searchable && (
          <div className="shrink-0 border-b border-slate-100 p-2">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 text-xs"
              data-testid="hr-picker-search"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-slate-400">Nothing matches that.</p>
          )}
          {shown.map((o) => {
            const ticked = on(o.value);
            return (
              <button
                key={o.value || "none"}
                type="button"
                onClick={() => (multi ? toggle(o.value) : onPick(o.value))}
                className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition hover:bg-slate-100 ${
                  ticked ? "font-bold text-slate-900" : "text-slate-600"
                }`}
                data-testid={`hr-branch-picker-option-${o.value || "none"}`}
              >
                {/* A box, and in single-select still one answer at a time — a list where two
                    could be ticked would be promising something the field behind it cannot
                    hold. In multi the field behind it is a list, so it can. */}
                {(checkbox || multi) && (
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${ticked ? "border-slate-700 bg-slate-700" : "border-slate-300 bg-white"}`}>
                    {ticked && <Check className="h-3 w-3 text-white" />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11px] font-normal text-slate-400">{o.hint}</span>}
                </span>
                {!checkbox && !multi && ticked && <CheckCircle2 className="h-4 w-4 shrink-0 text-slate-500" />}
              </button>
            );
          })}
        </div>

        {multi && requireOne && picked.length === 0 && (
          <p className="shrink-0 border-t border-slate-100 px-4 pt-2 text-[11px] text-slate-400" data-testid="hr-branch-picker-need-one">
            Tick at least one branch, or All Branches.
          </p>
        )}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={onClose} data-testid="hr-branch-picker-cancel">Cancel</Button>
          {/* Only in multi. A single-select list has already answered by the time anyone
              could reach a Save button, and offering one would suggest the click before it
              had not counted. */}
          {multi && (
            <Button
              size="sm"
              disabled={requireOne && picked.length === 0}
              onClick={() => onSave(picked)}
              data-testid="hr-branch-picker-save"
            >
              Save
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ---------- Department & Designation ----------

// The two answers that are not a branch, keyed so they can sit in the same map as the ones
// that are. Shaped like ALL_BRANCHES for the same reason it is: no branch id looks like
// this, so a real branch can never collide with one of them.
const ONLINE_GROUP = "__online__";
const NO_BRANCH_GROUP = "__none__";

// The two that are not a posting to a place, said in the colours the branch badge used
// before these were headings: violet for a mode that has no branch, amber for the gap.
// Everything else is a branch and reads as one.
const GROUP_TONE = {
  [ONLINE_GROUP]: "text-violet-600",
  [NO_BRANCH_GROUP]: "text-amber-700",
};

/** Who holds a designation, filed under the branch each of them works.
 *
 * One entry per branch a person covers, not one per person: a Physio working Anna Nagar
 * and T Nagar is at both, and a screen answering "who works here" that listed them under
 * only the first would be wrong at the second. So the group totals can sum past the count
 * on the designation above them — that badge counts people, these count postings, and the
 * difference is the multi-branch desks being shown honestly rather than a miscount.
 *
 * Four kinds of answer, in the order they read:
 *
 *   All Branches — a posting, and the widest one, so it comes before any single branch.
 *                  Not expanded into every group: repeating one person under all of them
 *                  would bury the people actually at each, which is what the groups are
 *                  for. It is also what the record says — covering everything is stored as
 *                  one answer about the whole set, not as a list of every branch.
 *   each branch  — in the order Branches & Verticals keeps them, so these sit in the same
 *                  order as the picker that writes them.
 *   Online Mode  — only where the install runs no online branch at all. An online desk is
 *                  otherwise filed under the online branches themselves, above, in their
 *                  own place in that order rather than in a group after it.
 *   No branch    — the only real gap, and last, because it is the one to act on.
 *
 * A branch id nothing matches — a branch deleted out from under the record — reads as no
 * branch, which is what it now is.
 */
const branchGroupsOf = (holders, branches) => {
  const known = new Map(branches.map((b) => [b.id, b.branch_name]));
  // The arm an online desk works, read off the branch's own vertical — the same prefix
  // Branches & Verticals tags a branch's mode with.
  const onlineBranches = branches.filter((b) => isOnlineVertical(b.vertical));
  const buckets = new Map();
  const push = (key, label, emp) => {
    if (!buckets.has(key)) buckets.set(key, { key, label, employees: [] });
    buckets.get(key).employees.push(emp);
  };
  holders.forEach((emp) => {
    if (!modeHasBranch(emp.work_type)) {
      // Under the arm their Service names, which is the whole of what Service is for on an
      // online record: online is two arms sold separately, and the Employment tab asks
      // this precisely because the Branch field it replaces is not offered once Online is
      // picked. Physio files them under Online Physiotherapy, Fitness under Online
      // Fitness, and _apply_online_arm in backend/routers/v3_hr.py posts them to the same
      // branches this reads — so the heading here is where they actually are, not a guess
      // this screen makes on its own.
      //
      // "both", blank, and an online vertical whose practice cannot be read all take every
      // arm. The first says so outright; the second is an older record saved before Service
      // was asked for, and showing them in both arms is the honest reading of a record that
      // has not answered; the third keeps an arm added by hand from silently swallowing its
      // own people, the same rule the branch picker follows.
      const practice = String(emp.service || "").trim().toLowerCase();
      const arms = onlineBranches.filter((b) => {
        if (!practice || practice === PRACTICE_BOTH) return true;
        const p = verticalPractice(b.vertical);
        return p === null || p === practice;
      });
      // The mode's own heading is what is left when no online branch answers — the install
      // runs none, or none of them is this person's arm. Without it they would be dropped
      // from a screen that is the only place their designation is listed.
      if (arms.length === 0) { push(ONLINE_GROUP, ONLINE_MODE_LABEL, emp); return; }
      arms.forEach((b) => push(b.id, b.branch_name, emp));
      return;
    }
    // Both halves of the record, because either can carry the answer alone: a
    // single-branch desk has only branch_id, and list_employees fills that one in from the
    // linked account where the employee row was left blank.
    const ids = [...new Set([...(emp.branch_ids || []), emp.branch_id].filter(Boolean))];
    if (ids.includes(ALL_BRANCHES)) { push(ALL_BRANCHES, "All Branches", emp); return; }
    const posted = ids.filter((id) => known.has(id));
    if (posted.length === 0) { push(NO_BRANCH_GROUP, "No branch", emp); return; }
    posted.forEach((id) => push(id, known.get(id), emp));
  });
  const order = [ALL_BRANCHES, ...branches.map((b) => b.id), ONLINE_GROUP, NO_BRANCH_GROUP];
  return order.map((k) => buckets.get(k)).filter(Boolean);
};

/** What else somebody covers, said from inside one branch's group.
 *
 * The heading names the branch, so the row does not repeat it. But a desk covering three
 * branches, shown under one of them with nothing else said, reads as posted there and
 * nowhere else — and the badge this replaced was the only place that fact appeared.
 *
 * Named while there is one other and counted past that, the same rule list_employees uses
 * for the row's own label in backend/routers/v3_hr.py: one name is the answer somebody
 * wants and still fits on the line, where four would be truncated into something that
 * reads like a single branch.
 */
const alsoAtLabel = (emp, branches, branchId) => {
  // Only ever said from inside a real branch. The other three groups are answers about the
  // whole set rather than one place — "also at Anna Nagar" under All Branches subtracts
  // from what the heading just said, and under Online Mode it contradicts it outright,
  // reading a branch off a record whose mode is the reason there is no branch to read.
  if (branchId === ALL_BRANCHES || branchId === ONLINE_GROUP || branchId === NO_BRANCH_GROUP) return "";
  // And never for an online desk, which is now filed under the online branches themselves
  // rather than under that group — so the group key alone stopped being enough to catch
  // this. The branches it would read are the ones on the linked LOGIN, which list_employees
  // fills in and which for a consultant are the rooms their diary serves. Printing "also at
  // Parrys" beneath a heading naming the online arm says they are in a room, which going
  // Online is precisely the answer that they are not.
  if (!modeHasBranch(emp.work_type)) return "";
  const others = [...new Set((emp.branch_ids || []).filter(
    (b) => b && b !== ALL_BRANCHES && b !== branchId && branches.some((x) => x.id === b),
  ))];
  if (others.length === 0) return "";
  if (others.length === 1) return `also at ${branches.find((b) => b.id === others[0]).branch_name}`;
  return `also at ${others.length} others`;
};

const StructureTab = ({ meta, reloadMeta }) => {
  const [depts, setDepts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  // The row whose branch is being written, so its control can be held shut while the
  // request is in flight rather than accepting a second change onto the first.
  const [movingEmployee, setMovingEmployee] = useState("");
  // The employee whose branch is being picked. One dialog for the tab rather than one per
  // row: only ever one is open, and a hundred mounted copies would be a hundred Escape
  // listeners waiting on a key nobody has pressed.
  const [branchPickerFor, setBranchPickerFor] = useState(null);
  // null | "department" | "designation" — which of the two is being named, and the name so
  // far. One dialog serves both: the two differ by a title and where the name is sent.
  // { kind: "department" | "designation", target } — target null means create, a name or a
  // department means rename that one. One piece of state for all four jobs: four separate
  // flags could contradict each other, and only ever one dialog is open.
  const [naming, setNaming] = useState(null);
  // The name a rename collided with, held while the merge is confirmed. Cleared either
  // way, so a second rename never inherits the first one's answer.
  const [mergeInto, setMergeInto] = useState("");
  const [newName, setNewName] = useState("");
  const [savingName, setSavingName] = useState(false);
  // What is about to be deleted, and whether the request is in flight.
  const [deleting, setDeleting] = useState(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  // Which designation is open. One at a time, so the department's shape stays readable
  // while a designation's people are being looked at.
  const [openDesignation, setOpenDesignation] = useState("");
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [pendingDesignation, setPendingDesignation] = useState("");

  const load = useCallback(async (keepOpen = false) => {
    try {
      const [d, e, b] = await Promise.all([hrDepartments(), hrEmployees({}), getBranches()]);
      setDepts(d || []);
      setEmployees(e || []);
      setBranches(b || []);
      // Opens on the first department rather than on nothing. There is no "all" here —
      // the question this screen answers is about one department at a time.
      setSelected((prev) => prev || d?.[0]?.name || "");
      if (!keepOpen) setOpenDesignation("");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load the structure");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const current = depts.find((d) => d.name === selected) || null;
  const designations = current?.designations || [];

  // Who holds a designation, within the department that owns it. Both halves matter: the
  // same designation name can sit under two departments, and the people under it are not
  // the same people.
  // "All Branches" sits at the top with "No branch": both are answers about the whole set
  // rather than a choice from within it, so they read as a pair before the list proper.
  const branchOptions = useMemo(() => ([
    { value: "", label: "— No branch —" },
    { value: ALL_BRANCHES, label: "All Branches" },
    ...branches.map((b) => ({ value: b.id, label: b.branch_name })),
  ]), [branches]);

  // The same list without "No branch", for the desks that can cover everything.
  //
  // Not an omission for tidiness: for a Nutritionist the two options are the same state.
  // Covering every branch is stored as an expert record belonging to none — that is what
  // ORG_WIDE_PROFILES in backend/routers/v3_config.py reads branchless as for this desk —
  // so taking one off their branches does not withdraw them from anywhere, it publishes
  // them everywhere. Offering both would be offering a choice that has one outcome, and
  // the one word for it is already in the list.
  const coveringBranchOptions = useMemo(() => ([
    { value: ALL_BRANCHES, label: "All Branches", hint: "Offered at every branch, including ones added later" },
    ...branches.map((b) => ({ value: b.id, label: b.branch_name })),
  ]), [branches]);

  // Which picker a row gets is a question about the ROLE, and a row carries a designation.
  // Asked of the title directly, only a title that happens to spell its slug answered it —
  // "Consultant" did, "Physiotherapist" did not, so a Physio could be posted to one branch
  // only. Resolved through the role's label instead, the same match Create User makes
  // (jobKey: PHYSIOTHERAPIST → physio). Built-ins are written last so a custom role that
  // shares a built-in's label cannot shadow it; retired slugs are skipped, as there.
  const designationRole = useMemo(() => {
    const map = {};
    (meta.custom_roles || []).forEach((r) => { if (r.name && r.label) map[jobKey(r.label)] = r.name; });
    Object.entries(ROLE_META).forEach(([slug, m]) => { if (!m.retired) map[jobKey(m.label)] = slug; });
    return map;
  }, [meta.custom_roles]);
  const isMultiBranchDesk = (designation) =>
    Boolean(multiBranchLabel(designation) || multiBranchLabel(designationRole[jobKey(designation)]));

  const holdersOf = (designation) => employees.filter(
    (e) => e.department === current?.name && e.designation === designation,
  );

  /** Post somebody to a branch, or take them off one.
   *
   * A PATCH carrying nothing but the branch: the endpoint applies only what it is sent, so
   * the rest of the record is not restated and cannot be flattened by an out-of-date copy
   * held on this screen.
   *
   * The row is updated in place rather than by reloading everything, so the designation
   * stays open and the list does not jump under the hand that just used it.
   */
  const moveToBranch = async (emp, branchId) => {
    if (branchId === (emp.branch_id || "")) return;
    setMovingEmployee(emp.id);
    try {
      await hrUpdateEmployee(emp.id, { branch_id: branchId });
      const name = branchId === ALL_BRANCHES
        ? "All Branches"
        : (branches.find((b) => b.id === branchId)?.branch_name || "");
      setEmployees((prev) => prev.map(
        (e) => (e.id === emp.id ? { ...e, branch_id: branchId, branch_name: name, branch_ids: [] } : e),
      ));
      toast.success(name ? `${emp.full_name} → ${name}` : `${emp.full_name} taken off their branch`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the branch");
    } finally {
      setMovingEmployee("");
    }
  };

  /** Set which mode somebody works, from the row itself.
   *
   * The same PATCH-one-field shape as the branch controls above, and for the same reason:
   * nothing else on the record is restated, so nothing else can be flattened by a copy of
   * it that this screen has been holding since the page loaded.
   *
   * Going Online clears the branch, because an online employee is not at one — see
   * modeHasBranch. The empty list is sent rather than an empty branch_id: the endpoint
   * derives branch_id from the list and cascades the list to the linked account, so
   * sending only the single field would leave the account still holding branches the
   * employee no longer has.
   *
   * Every other mode leaves the branch alone. Somebody marked Offline or Both is saying
   * where they work, not asking for their posting to be thrown away, and a branch silently
   * emptied there would be noticed a week later by whoever could not find them.
   */
  const setWorkMode = async (emp, mode) => {
    if (mode === (emp.work_type || "")) return;
    const clearing = !modeHasBranch(mode);
    setMovingEmployee(emp.id);
    try {
      await hrUpdateEmployee(emp.id, { work_type: mode, ...(clearing ? { branch_ids: [] } : {}) });
      setEmployees((prev) => prev.map((e) => (e.id === emp.id ? {
        ...e,
        work_type: mode,
        ...(clearing ? { branch_ids: [], branch_id: "", branch_name: "" } : {}),
      } : e)));
      toast.success(clearing
        ? `${emp.full_name} → ${MODE_LABELS[mode]}, taken off their branch`
        : `${emp.full_name} → ${MODE_LABELS[mode]}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the work mode");
    } finally {
      setMovingEmployee("");
    }
  };

  /** How a set of branches reads on one line. Kept in step with list_employees in
   *  backend/routers/v3_hr.py, which builds the same label for the same set — the row is
   *  written here optimistically and read back from there on the next load, and the two
   *  saying different words about an unchanged selection would look like a failed save. */
  const branchesLabel = (ids) => {
    if (ids.includes(ALL_BRANCHES)) return "All Branches";
    const names = ids.map((id) => branches.find((b) => b.id === id)?.branch_name).filter(Boolean);
    if (names.length === 0) return "";
    if (names.length <= 2) return names.join(" + ");
    return `${ids.length} branches`;
  };

  /** Post a multi-branch desk to every branch they cover.
   *
   * The list is what is sent; branch_id is not, because the two can contradict each other
   * and the endpoint derives it from the list. Same PATCH-one-thing shape as moveToBranch
   * above, and for the same reason: nothing else on the record is restated, so nothing else
   * can be flattened by an out-of-date copy held on this screen.
   */
  const saveBranches = async (emp, ids) => {
    // Saved even when the selection has not moved.
    //
    // This used to return early on an unchanged list, on the reasonable-sounding grounds
    // that there was nothing to write. What that missed is that the employee row is only
    // half of the answer: a CONSULTANT is offered at a branch by the branches on their
    // LOGIN, and if that account was never linked to this employee the two halves can
    // disagree — the row reading "Parrys Branch" while the account behind it says
    // somewhere else, or nowhere. Unchanged here has never meant unchanged there.
    //
    // So re-picking the same branch is a real instruction and is sent, which is what makes
    // re-saving the repair for a Consultant already in that state: the endpoint finds the
    // login by name, links it, and posts the branches for the first time. Costing one
    // idempotent PATCH to make that reachable in a click is the right side to err on.
    setMovingEmployee(emp.id);
    try {
      await hrUpdateEmployee(emp.id, { branch_ids: ids });
      const label = branchesLabel(ids);
      setEmployees((prev) => prev.map((e) => (e.id === emp.id ? {
        ...e, branch_ids: ids, branch_id: ids[0] || "", branch_name: label,
      } : e)));
      toast.success(label ? `${emp.full_name} → ${label}` : `${emp.full_name} taken off their branches`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the branches");
    } finally {
      setMovingEmployee("");
    }
  };

  const openNaming = (kind, target = null) => { setNewName(target || ""); setMergeInto(""); setNaming({ kind, target }); };

  /** Make sure a job title is also a role somebody can be given.
   *
   * A designation and a role are the same thing to this clinic — the title somebody holds
   * IS what their login is — but they lived in two places that only met when a user was
   * created: Create User resolved a designation to a role and minted one where there was
   * none. So a designation added here stayed unknown to Roles & Credentials until somebody
   * happened to hire into it, which is how the two lists drifted apart in the first place.
   *
   * A role that already exists is the end state being asked for, so its 409 is success.
   * Anything else is worth saying out loud but never worth failing over: the designation is
   * what was being created, and it is already saved by the time this runs.
   */
  const ensureRoleFor = async (label) => {
    try {
      await hrAddCustomRole(label);
    } catch (e) {
      if (e?.response?.status === 409) return;
      toast.error(`${label} was added, but making it a role failed — add it under Credentials.`);
    }
  };

  const submitName = async () => {
    const name = newName.trim();
    if (!name || !naming) return;
    const { kind, target } = naming;
    setSavingName(true);
    try {
      if (kind === "department" && !target) {
        await hrCreateDepartment(name);
        await load();
        // Opened on what was just made: somebody creating a department is about to fill
        // it, and leaving them on the one they were reading would hide the thing they
        // asked for behind a tab they now have to find.
        setSelected(name);
      } else if (kind === "department") {
        await hrRenameDepartment(current.id, name);
        await load();
        // Followed to the new name, or the tab somebody was standing on would stop
        // matching anything and the card beneath would empty itself.
        setSelected(name);
      } else if (!target) {
        await hrAddDesignation(current.id, name);
        // In the same breath, or the two lists start drifting again from the next title on.
        await ensureRoleFor(name);
        // Selection and open row both kept: the new designation appears in the list
        // already being looked at rather than closing it to say so.
        await load(true);
      } else {
        await hrRenameDesignation(current.id, target, name, mergeInto === name);
        await load(true);
        // The open row is keyed by name, so a rename has to move the key with it or the
        // row somebody had open would silently close.
        setOpenDesignation((prev) => (prev === target ? name : prev));
      }
      toast.success(
        mergeInto === name ? `Merged into ${name}` : target ? `Renamed to ${name}` : `${name} added`
      );
      setNaming(null);
      setNewName("");
      setMergeInto("");
      // Employees and Roles read the same lists off meta, so they have to be told.
      reloadMeta();
    } catch (e) {
      const detail = e?.response?.data?.detail || "Could not save it";
      // The server refuses a rename onto a name this department already has, and says
      // what merging would do. Offered rather than just reported: two spellings of one
      // job — "Consultants" beside "CONSULTANT" — is exactly what a rename here is for,
      // and the answer is to fold one into the other.
      if (e?.response?.status === 409 && detail.includes("already a designation here")) {
        setMergeInto(name);
      } else {
        toast.error(detail);
      }
    } finally {
      setSavingName(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      if (deleting.kind === "department") {
        await hrDeleteDepartment(deleting.dept.id);
        await load();
        // Whatever is left, or nothing. Standing on a tab that no longer exists shows an
        // empty card and no way back to a real one.
        setSelected((prev) => (prev === deleting.dept.name ? "" : prev));
      } else {
        await hrDeleteDesignation(current.id, deleting.name);
        await load(true);
        setOpenDesignation((prev) => (prev === deleting.name ? "" : prev));
      }
      toast.success(`${deleting.kind === "department" ? deleting.dept.name : deleting.name} deleted`);
      setDeleting(null);
      reloadMeta();
    } catch (e) {
      // The server refuses one that is still in use and says by how many. That message is
      // the whole answer, so it is shown rather than replaced with a generic failure.
      toast.error(e?.response?.data?.detail || "Could not delete it");
    } finally {
      setDeletingBusy(false);
    }
  };

  if (loading) return <p className="py-12 text-center text-sm text-slate-400">Loading…</p>;
  if (depts.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400" data-testid="hr-structure-empty">
        No departments yet. Add one with the Department button above.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="hr-structure-tab">
      {/* The strip scrolls; the two create buttons do not. They sit outside the scrolling
          box, pinned right, or they would slide off with the departments and be unreachable
          exactly when there are enough of them to want another. */}
      <div className="flex items-center gap-2">
      {/* One row, scrolling sideways rather than wrapping: a department's place in the row
          is how it is found again, and a row that reflows every time one is added moves
          them all. min-w-0 so the strip scrolls inside the page instead of widening it. */}
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-1" data-testid="hr-structure-depts">
          {depts.map((d) => {
            const on = d.name === selected;
            const count = (d.designations || []).length;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelected(d.name)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition ${
                  on ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
                data-testid={`hr-structure-dept-${d.id}`}
              >
                {d.name}
                <span className={`rounded px-1.5 py-px text-[10px] font-bold ${on ? "bg-white/25" : "bg-slate-100 text-slate-500"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

        <Button
          size="sm"
          variant="outline"
          className="h-9 shrink-0 border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          onClick={() => openNaming("department")}
          data-testid="hr-structure-add-department"
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Department
        </Button>
        {/* Disabled rather than hidden while nothing is selected: the button is what says
            a designation belongs to a department, and hiding it would only raise the
            question of where designations are made. */}
        <Button
          size="sm"
          className="h-9 shrink-0 bg-sky-600 text-xs text-white hover:bg-sky-700"
          disabled={!current}
          onClick={() => openNaming("designation")}
          title={current ? `Add a designation to ${current.name}` : "Pick a department first"}
          data-testid="hr-structure-add-designation"
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Designation
        </Button>
      </div>

      <Card data-testid="hr-structure-designations">
        <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
          <CardTitle className="min-w-0 truncate text-sm font-semibold text-slate-800">{current?.name || "—"}</CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {designations.length} {designations.length === 1 ? "designation" : "designations"}
            </span>
            {/* On the header rather than on the tab: the tab is how a department is chosen
                and an edit control there would be hit while reaching for the next one. */}
            {current && (
              <>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => openNaming("department", current.name)} title={`Rename ${current.name}`} aria-label={`Rename ${current.name}`} data-testid="hr-structure-dept-edit">
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="outline" className="h-7 w-7 border-rose-200 p-0 text-rose-700 hover:bg-rose-50" onClick={() => setDeleting({ kind: "department", dept: current })} title={`Delete ${current.name}`} aria-label={`Delete ${current.name}`} data-testid="hr-structure-dept-delete">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="pb-4">
          {designations.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              Nothing under {current?.name} yet.
            </p>
          ) : (
            // Numbered, because the order is the department's own and says something —
            // it is the order Departments &amp; Designation was arranged in.
            <ol className="space-y-1.5">
              {designations.map((name, i) => {
                const holders = holdersOf(name);
                const open = openDesignation === name;
                return (
                  <li key={name} className="overflow-hidden rounded-lg border border-slate-100" data-testid={`hr-structure-designation-${name}`}>
                    {/* A row of siblings, not one button wrapping the others. A button
                        inside a button is invalid markup that browsers unnest, and the
                        inner one stops receiving its clicks — so Edit and Delete sit
                        beside the opener rather than inside it. */}
                    <div className={`flex items-center gap-1 px-3 py-2 transition ${open ? "bg-sky-50" : "bg-slate-50/60 hover:bg-slate-100"}`}>
                      {/* Most of the row still opens it: that is what somebody is aiming at
                          when they want to know who holds this. */}
                      <button
                        type="button"
                        onClick={() => setOpenDesignation(open ? "" : name)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        aria-expanded={open}
                        data-testid={`hr-structure-designation-open-${name}`}
                      >
                        <span className="w-5 shrink-0 text-right text-[11px] font-bold text-slate-400">{i + 1}</span>
                        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${open ? "text-sky-800" : "text-slate-700"}`} title={name}>{name}</span>
                        {/* Counted whether it is open or not, so the row says how many
                            people are behind it before anybody clicks. Nought reads as
                            nought rather than as a missing badge. */}
                        <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold ${holders.length > 0 ? "bg-slate-200 text-slate-600" : "bg-slate-100 text-slate-400"}`}>
                          {holders.length}
                        </span>
                        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
                      </button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-7 shrink-0 p-0"
                        onClick={() => openNaming("designation", name)}
                        title={`Rename ${name}`}
                        aria-label={`Rename ${name}`}
                        data-testid={`hr-structure-designation-edit-${name}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-7 shrink-0 border-rose-200 p-0 text-rose-700 hover:bg-rose-50"
                        onClick={() => setDeleting({ kind: "designation", name })}
                        title={`Delete ${name}`}
                        aria-label={`Delete ${name}`}
                        data-testid={`hr-structure-designation-delete-${name}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    {open && (
                      <div className="space-y-3 border-t border-slate-100 bg-white px-3 py-2" data-testid={`hr-structure-holders-${name}`}>
                        {branchGroupsOf(holders, branches).map((group) => (
                          <div key={group.key} data-testid={`hr-structure-branch-group-${name}-${group.key}`}>
                            {/* The branch says itself once, over its people, instead of once
                                on every row — which is the whole of this grouping: the eye
                                reads a heading and then a list, where a column of badges
                                had to be read line by line to find who works where.

                                Counted here as well as on the designation above, and the
                                two count different things: that badge is people, this is
                                the size of one posting. See branchGroupsOf. */}
                            <div className="mb-1 flex items-center gap-2 px-0.5">
                              <span
                                className={`shrink-0 truncate text-[11px] font-bold uppercase tracking-wider ${GROUP_TONE[group.key] || "text-sky-700"}`}
                                title={group.key === ONLINE_GROUP ? "Works online, so not posted to a branch" : group.label}
                              >
                                {group.label}
                              </span>
                              {/* A rule out to the count, so a short branch name and a long
                                  one still carry the eye to the same place. */}
                              <span className="h-px flex-1 bg-slate-100" />
                              <span className="shrink-0 text-[10px] font-bold text-slate-400">{group.employees.length}</span>
                            </div>
                            <div className="space-y-1.5">
                              {group.employees.map((emp) => (
                                <div key={emp.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-slate-800">{emp.full_name}</p>
                                    <p className="truncate text-[11px] text-slate-500">{emp.employee_code || "—"}</p>
                                  </div>
                                  <WorkModeToggle
                                    value={emp.work_type}
                                    disabled={movingEmployee === emp.id}
                                    onPick={(m) => setWorkMode(emp, m)}
                                    testid={`hr-structure-mode-${emp.id}-${group.key}`}
                                  />
                                  {/* Nothing is said here now that the mode has two answers and the
                                      toggle beside it shows which. The slot stays so the branch
                                      column keeps its position down the list. */}
                                  <span className="w-2 shrink-0" />
                                  {/* Where else this person works, and nothing at all for the
                                      many who work only here — the heading above has already
                                      said where "here" is, and repeating it on every row is
                                      what the grouping is replacing.

                                      One width for every row regardless, empty or not. These
                                      are right-aligned against the buttons, so a slot sized to
                                      its own text left a ragged edge running down the list and
                                      the eye reads that as two columns rather than one. */}
                                  <span
                                    className="w-32 shrink-0 truncate text-right text-[11px] font-medium text-slate-400"
                                    title={emp.branch_name || ""}
                                    data-testid={`hr-structure-branch-${emp.id}-${group.key}`}
                                  >
                                    {alsoAtLabel(emp, branches, group.key)}
                                  </span>
                                  {/* Nothing to change where the mode has no branch. A control that
                                      opened a picker whose every answer would be cleared again on
                                      the next save would be offering a choice that does not exist.
                                      A fixed slot so the Edit button stays in its column either way. */}
                                  <span className="w-[4.75rem] shrink-0">
                                    {modeHasBranch(emp.work_type) && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 w-full text-[11px] font-medium text-slate-600"
                                        disabled={movingEmployee === emp.id}
                                        onClick={() => setBranchPickerFor(emp)}
                                        aria-label={`Change branch for ${emp.full_name}`}
                                        data-testid={`hr-structure-branch-change-${emp.id}-${group.key}`}
                                      >
                                        Change
                                      </Button>
                                    )}
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 shrink-0 text-[11px]"
                                    onClick={() => { setEditingEmployee(emp); setPendingDesignation(name); setShowAddEmployee(true); }}
                                    data-testid={`hr-structure-edit-${emp.id}-${group.key}`}
                                  >
                                    <Pencil className="mr-1 h-3 w-3" /> Edit
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        {holders.length === 0 && (
                          <p className="py-2 text-center text-xs text-slate-400">Nobody holds this designation yet.</p>
                        )}
                        {/* Seeded with this department and this designation, so the form
                            opens where the click was rather than asking again for what was
                            just pointed at. */}
                        <Button
                          size="sm"
                          className="h-8 w-full bg-sky-600 text-white hover:bg-sky-700"
                          onClick={() => { setEditingEmployee(null); setPendingDesignation(name); setShowAddEmployee(true); }}
                          data-testid={`hr-structure-add-${name}`}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" /> Add {name}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {naming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setNaming(null); }}
          data-testid="hr-structure-name-modal"
        >
          <div className="w-full max-w-sm space-y-3 rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-900">
              {naming.target
                ? `Rename ${naming.target}`
                : (naming.kind === "department" ? "New Department" : `New Designation in ${current?.name}`)}
            </h3>
            <Input
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              // Enter to save, Escape to leave: this is one field, and reaching for the
              // mouse to commit a single word is the slower half of the job.
              onKeyDown={(e) => {
                if (e.key === "Enter") submitName();
                if (e.key === "Escape") setNaming(null);
              }}
              placeholder={naming.kind === "department" ? "Department name" : "Designation name"}
              data-testid="hr-structure-name-input"
            />
            {/* The rename came back saying that name is already here. Says plainly what
                pressing Merge does, because it drops a designation and moves everybody
                under it — neither of which should be a surprise. */}
            {mergeInto === newName.trim() && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800" data-testid="hr-structure-merge-notice">
                <b>{mergeInto}</b> is already a designation here. Merging moves everyone under{" "}
                <b>{naming.target}</b> into it and removes <b>{naming.target}</b>.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setNaming(null)} data-testid="hr-structure-name-cancel">Cancel</Button>
              <Button
                size="sm"
                className={mergeInto === newName.trim() ? "bg-amber-600 hover:bg-amber-700" : "bg-sky-600 hover:bg-sky-700"}
                // Unchanged is not a save: renaming something to what it is already called
                // would spend a request to tell the user nothing happened.
                disabled={savingName || !newName.trim() || newName.trim() === naming.target}
                onClick={submitName}
                data-testid="hr-structure-name-save"
              >
                {savingName ? "Saving…" : mergeInto === newName.trim() ? `Merge into ${mergeInto}` : naming.target ? "Rename" : "Add"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleting(null); }}
          data-testid="hr-structure-delete-modal"
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100">
                <Trash2 className="h-5 w-5 text-rose-600" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900">
                  Delete {deleting.kind === "department" ? "this department?" : "this designation?"}
                </h3>
                {/* Named, not "this one". Two rows apart look identical in a confirmation
                    that does not say which was clicked. */}
                <p className="mt-1 text-xs text-slate-500">
                  <b className="text-slate-700">{deleting.kind === "department" ? deleting.dept.name : deleting.name}</b>
                  {deleting.kind === "department"
                    ? " and every designation under it come off the structure."
                    : ` comes off ${current?.name}.`}
                  {" "}Anybody still filed under it will be refused, and the message says how many.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setDeleting(null)} data-testid="hr-structure-delete-cancel">Cancel</Button>
              <Button
                size="sm"
                className="bg-rose-600 hover:bg-rose-700"
                disabled={deletingBusy}
                onClick={confirmDelete}
                data-testid="hr-structure-delete-confirm"
              >
                {deletingBusy ? "Deleting…" : "Yes, Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Two pickers, one control, chosen by the desk being posted.
          A receptionist sits at one branch, so for them the question has one answer and
          the list closes on it. A doctor — Consultant, Physio, Nutritionist — may work
          several, and a Physio or Nutritionist holds a calendar at each — the backend has
          stored that as a list all along, and this dialog was the last place still asking
          for exactly one, which is why a coach covering two branches had to be filed under
          one of them and disappeared from the other. */}
      {branchPickerFor && (isMultiBranchDesk(branchPickerFor.designation) ? (
        <PickerModal
          key={branchPickerFor.id}
          title={`Branches for ${branchPickerFor.full_name}`}
          multi
          values={
            branchPickerFor.branch_ids && branchPickerFor.branch_ids.length
              ? branchPickerFor.branch_ids
              : (branchPickerFor.branch_id ? [branchPickerFor.branch_id] : [])
          }
          exclusive={[ALL_BRANCHES]}
          requireOne
          options={coveringBranchOptions}
          onSave={(ids) => { const emp = branchPickerFor; setBranchPickerFor(null); saveBranches(emp, ids); }}
          onClose={() => setBranchPickerFor(null)}
        />
      ) : (
        <PickerModal
          title={`Branch for ${branchPickerFor.full_name}`}
          value={branchPickerFor.branch_id || ""}
          options={branchOptions}
          onPick={(v) => { const emp = branchPickerFor; setBranchPickerFor(null); moveToBranch(emp, v); }}
          onClose={() => setBranchPickerFor(null)}
        />
      ))}

      {showAddEmployee && (
        <AddEmployeeModal
          employee={editingEmployee}
          initialDepartment={current?.name || ""}
          initialDesignation={pendingDesignation}
          reloadMeta={reloadMeta}
          meta={meta}
          onClose={() => { setShowAddEmployee(false); setEditingEmployee(null); }}
          onSaved={() => {
            setShowAddEmployee(false);
            setEditingEmployee(null);
            // Reloaded with the designation left open, so the row somebody was working in
            // is still open behind the closing dialog and the new name is simply there.
            load(true);
            reloadMeta();
          }}
        />
      )}
    </div>
  );
};

// ---------- Departments & Designation ----------

const DEPT_DESIGNATION_SUB_TABS = [
  { key: "departments", label: "Departments" },
  { key: "designations", label: "Designation" },
];

// Browsing a department's people and managing the designation list itself used to share
// one screen (a "Manage Designations" button opened the latter as a popup over the
// former). Split into two plain tabs instead: Designation is now a page of its own rather
// than a dialog, which is what it needed to be able to show every department's list at
// once with a search bar over the top of it.
const DepartmentsDesignationTab = ({ meta, reloadMeta }) => {
  const [subTab, setSubTab] = useState("departments");
  return (
    <div className="space-y-4" data-testid="hr-dept-designation-tab">
      <div className="flex flex-wrap gap-2" data-testid="hr-dept-designation-subtabs">
        {DEPT_DESIGNATION_SUB_TABS.map((t) => (
          <TabPill key={t.key} active={subTab === t.key} onClick={() => setSubTab(t.key)} testid={`hr-dept-designation-subtab-${t.key}`}>
            {t.label}
          </TabPill>
        ))}
      </div>
      {subTab === "departments" && <DepartmentsTab meta={meta} reloadMeta={reloadMeta} />}
      {subTab === "designations" && <DesignationsTab meta={meta} reloadMeta={reloadMeta} />}
    </div>
  );
};

const DepartmentsTab = ({ meta, reloadMeta }) => {
  const [depts, setDepts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  // "" selects the All Department tab; otherwise a department name.
  const [selectedDept, setSelectedDept] = useState("");
  const [designationFilter, setDesignationFilter] = useState("");
  const [search, setSearch] = useState("");
  const [newDeptName, setNewDeptName] = useState("");
  const [addingDept, setAddingDept] = useState(false); // the trailing "+" tab, opened
  const [editingDeptId, setEditingDeptId] = useState(null);
  const [editDeptName, setEditDeptName] = useState("");
  const [renamingDept, setRenamingDept] = useState(false);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [viewingEmployee, setViewingEmployee] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, e] = await Promise.all([hrDepartments(), hrEmployees({})]);
      setDepts(d);
      setEmployees(e);
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to load departments"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const selectedDeptObj = useMemo(() => depts.find((d) => d.name === selectedDept) || null, [depts, selectedDept]);

  const selectTab = (name) => { setSelectedDept(name); setDesignationFilter(""); };

  // Every department and every designation under it, as a sheet.
  //
  // One row per pairing rather than two separate lists, because a designation only means
  // anything under the department that owns it — "Senior Physio" is a fact about Experts,
  // not a name floating on its own. Sorting and filtering the sheet gives either list back.
  //
  // A department with nothing under it still gets a row. Which departments exist is half
  // the question being asked, and dropping the empty ones answers only the other half.
  const exportDepartments = () => {
    const rows = [["Department", "Designation"]];
    depts.forEach((d) => {
      const designations = d.designations || [];
      if (designations.length === 0) rows.push([d.name, ""]);
      else designations.forEach((name) => rows.push([d.name, name]));
    });
    downloadCsv(rows, `departments-and-designations-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`${rows.length - 1} rows exported`);
  };

  const addDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) return;
    setAddingDept(false);
    try {
      await hrCreateDepartment(name);
      setNewDeptName("");
      toast.success(`${name} added`);
      load();
      reloadMeta();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to add department"); }
  };

  const removeDepartment = async (d) => {
    if (!window.confirm(`Delete "${d.name}"? Employees already in this department keep it as text.`)) return;
    try {
      await hrDeleteDepartment(d.id);
      if (selectedDept === d.name) setSelectedDept("");
      load();
      reloadMeta();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to delete department"); }
  };

  const startEditDept = (d) => { setEditingDeptId(d.id); setEditDeptName(d.name); };
  const cancelEditDept = () => { setEditingDeptId(null); setEditDeptName(""); };

  const saveEditDept = async (d) => {
    const name = editDeptName.trim();
    if (!name || name === d.name) { cancelEditDept(); return; }
    setRenamingDept(true);
    try {
      await hrRenameDepartment(d.id, name);
      toast.success(`Renamed to ${name}`);
      if (selectedDept === d.name) setSelectedDept(name);
      cancelEditDept();
      load();
      reloadMeta();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to rename department"); }
    setRenamingDept(false);
  };

  const removeEmployee = async (emp) => {
    if (!window.confirm(`Delete employee ${emp.full_name}?`)) return;
    try { await hrDeleteEmployee(emp.id); toast.success("Deleted"); setViewingEmployee(null); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Delete failed"); }
  };

  // Scoped to the selected tab, same as the Employees tab's own designation dropdown —
  // "All Department" sees every designation in use, a specific tab only its own.
  const deptScopedEmployees = selectedDept ? employees.filter((e) => (e.department || "Unassigned") === selectedDept) : employees;
  const designationFilterOptions = useMemo(
    () => [...new Set(deptScopedEmployees.map((e) => e.designation).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [deptScopedEmployees]
  );

  const filteredEmployees = deptScopedEmployees.filter((e) => {
    if (designationFilter && e.designation !== designationFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (e.full_name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q) || (e.employee_code || "").toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col gap-3" data-testid="hr-departments-tab">
      {/* Department tabs: All Department, then one per department, then + to add one. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="hr-dept-tabs">
        <TabPill active={selectedDept === ""} onClick={() => selectTab("")} testid="hr-dept-tab-all">
          All Department
        </TabPill>
        {depts.map((d) => (
          <TabPill key={d.id} active={selectedDept === d.name} onClick={() => selectTab(d.name)} testid={`hr-dept-tab-${d.id}`}>
            {d.name}
          </TabPill>
        ))}
        {addingDept ? (
          <span className="inline-flex items-center gap-1">
            <Input
              autoFocus
              placeholder="Department name..."
              value={newDeptName}
              onChange={(e) => setNewDeptName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addDepartment(); if (e.key === "Escape") { setAddingDept(false); setNewDeptName(""); } }}
              className="h-9 w-40 text-sm"
              data-testid="hr-dept-add-input"
            />
            <button onClick={addDepartment} disabled={!newDeptName.trim()} className="shrink-0 text-emerald-600 hover:text-emerald-700" title="Add department" data-testid="hr-dept-add-confirm">
              <CheckCircle2 className="h-4 w-4" />
            </button>
            <button onClick={() => { setAddingDept(false); setNewDeptName(""); }} className="shrink-0 text-slate-400 hover:text-slate-600" title="Cancel" data-testid="hr-dept-add-cancel">
              <X className="h-4 w-4" />
            </button>
          </span>
        ) : (
          <button
            onClick={() => setAddingDept(true)}
            title="Add department"
            aria-label="Add department"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-sky-300 text-sky-600 transition hover:bg-sky-50"
            data-testid="hr-dept-tab-add"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
        {/* Pushed to the end of the row, past the add control, because it is about the
            whole list rather than about any one department — the same reason it stays
            put when a department tab is selected. */}
        <Button
          size="sm"
          variant="outline"
          onClick={exportDepartments}
          disabled={depts.length === 0}
          className="ml-auto h-9 shrink-0 border-slate-200 text-slate-600 hover:bg-slate-50"
          title="Download every department and designation as a spreadsheet"
          data-testid="hr-dept-export"
        >
          <Download className="mr-1 h-3.5 w-3.5" /> Export
        </Button>
      </div>

      {/* Selected department's own actions — nothing to rename/delete/manage on "All". */}
      {selectedDeptObj && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2" data-testid="hr-dept-actionbar">
          {editingDeptId === selectedDeptObj.id ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Input
                autoFocus
                value={editDeptName}
                onChange={(e) => setEditDeptName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEditDept(selectedDeptObj); if (e.key === "Escape") cancelEditDept(); }}
                className="h-8 max-w-xs text-sm"
                data-testid={`hr-dept-edit-input-${selectedDeptObj.id}`}
              />
              <button onClick={() => saveEditDept(selectedDeptObj)} disabled={renamingDept} className="shrink-0 text-emerald-600 hover:text-emerald-700" data-testid={`hr-dept-edit-save-${selectedDeptObj.id}`} title="Save">
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button onClick={cancelEditDept} className="shrink-0 text-slate-400 hover:text-slate-600" data-testid={`hr-dept-edit-cancel-${selectedDeptObj.id}`} title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-800">{selectedDeptObj.name}</p>
              <p className="text-xs text-slate-500">
                {selectedDeptObj.employee_count} employee{selectedDeptObj.employee_count === 1 ? "" : "s"} · {(selectedDeptObj.designations || []).length} designation{(selectedDeptObj.designations || []).length === 1 ? "" : "s"}
              </p>
            </div>
          )}
          {editingDeptId !== selectedDeptObj.id && (
            <div className="flex shrink-0 items-center gap-1">
              <button onClick={() => startEditDept(selectedDeptObj)} className="rounded-md p-2 text-slate-400 hover:bg-white hover:text-sky-600" title="Rename department" data-testid={`hr-dept-edit-${selectedDeptObj.id}`}>
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => removeDepartment(selectedDeptObj)} className="rounded-md p-2 text-slate-400 hover:bg-white hover:text-red-500" title="Delete department" data-testid={`hr-dept-delete-${selectedDeptObj.id}`}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && depts.length === 0 && <p className="text-sm text-slate-400">No departments yet — use the + tab above to add one.</p>}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2">
        <DesignationFilterSelect value={designationFilter} onChange={setDesignationFilter} options={designationFilterOptions} testid="hr-dept-designation-filter" />
      </div>

      {/* Actions row */}
      <div className="flex items-center justify-end gap-2">
        <SearchIconInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee..." testid="hr-dept-emp-search" />
        <Button onClick={() => { setEditingEmployee(null); setShowAddEmployee(true); }} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-dept-emp-add-btn">
          <Plus className="h-4 w-4 mr-1" />Add Employee
        </Button>
      </div>

      <EmployeeDirectory employees={filteredEmployees} onView={setViewingEmployee} />

      {viewingEmployee && (
        <EmployeeViewModal
          employee={viewingEmployee}
          onClose={() => setViewingEmployee(null)}
          onEdit={() => { setEditingEmployee(viewingEmployee); setViewingEmployee(null); setShowAddEmployee(true); }}
          onDelete={() => removeEmployee(viewingEmployee)}
        />
      )}

      {showAddEmployee && (
        <AddEmployeeModal
          employee={editingEmployee}
          initialDepartment={selectedDept}
          meta={meta}
          onClose={() => { setShowAddEmployee(false); setEditingEmployee(null); }}
          onSaved={() => { setShowAddEmployee(false); setEditingEmployee(null); load(); reloadMeta(); }}
        />
      )}
    </div>
  );
};

// A page now rather than a popup opened from one department — this needs to show every
// department's designations at once (with a search bar over the top) which a
// single-department-scoped dialog couldn't.
//
// An already-claimed designation can only be renamed here, never removed — unchecking
// used to call the same delete the department picker used elsewhere, which silently
// orphaned every employee holding it rather than warning anyone. Renaming instead (cascaded
// to those employees, same as a department rename) is the one edit that can't lose track of
// who holds a title. A brand new designation still needs picking which department it
// belongs to, since a designation belongs to exactly one — the backend re-checks that too.
const DesignationsTab = ({ meta, reloadMeta }) => {
  const [depts, setDepts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [viewingDesignation, setViewingDesignation] = useState(null);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [pendingDepartment, setPendingDepartment] = useState("");
  const [pendingDesignation, setPendingDesignation] = useState("");

  const [editingKey, setEditingKey] = useState(null); // `${deptId}:${label}`
  const [editValue, setEditValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [newDeptId, setNewDeptId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);

  // Which row a drag started on — only meaningful within the same department's list, since
  // "first row" only means something inside one department's own order.
  const [dragDeptId, setDragDeptId] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, e] = await Promise.all([hrDepartments(), hrEmployees({})]);
      setDepts(d);
      setEmployees(e);
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to load designations"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const designationCounts = useMemo(() => {
    const counts = {};
    employees.forEach((e) => { if (e.designation) counts[e.designation] = (counts[e.designation] || 0) + 1; });
    return counts;
  }, [employees]);

  const claimedLabels = useMemo(() => {
    const set = new Set();
    depts.forEach((d) => (d.designations || []).forEach((l) => set.add(l)));
    return set;
  }, [depts]);

  // Exists as a role or on an employee record, but no department has claimed it yet — the
  // department picker elsewhere falls back to the full role list for exactly this reason.
  const unclaimed = useMemo(() => {
    const fromRoles = (meta?.roles || []).map(roleLabel);
    const fromEmployees = employees.map((e) => e.designation).filter(Boolean);
    return [...new Set([...fromRoles, ...fromEmployees])].filter((l) => !claimedLabels.has(l)).sort((a, b) => a.localeCompare(b));
  }, [meta?.roles, employees, claimedLabels]);

  const q = search.trim().toLowerCase();
  const matches = (label) => !q || label.toLowerCase().includes(q);

  const startRename = (deptId, label) => { setEditingKey(`${deptId}:${label}`); setEditValue(label); };
  const cancelRename = () => { setEditingKey(null); setEditValue(""); };

  const saveRename = async (deptId, oldLabel) => {
    const next = editValue.trim();
    if (!next || next === oldLabel) { cancelRename(); return; }
    setRenaming(true);
    try {
      await hrRenameDesignation(deptId, oldLabel, next);
      toast.success(`Renamed to ${next}`);
      cancelRename();
      load();
      reloadMeta();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to rename"); }
    setRenaming(false);
  };

  // Compared on letters alone, matching the duplicate check used when a role is created —
  // "Diet Manage" and "diet manage" are the same designation as far as this is concerned.
  const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const newLabelExists = !!newLabel.trim() && [...claimedLabels, ...unclaimed].some((d) => key(d) === key(newLabel));

  // A brand new designation is different from renaming one: there's no one to view yet, so
  // the useful next step is entering them, not sitting on an empty list.
  const createNew = async () => {
    const label = newLabel.trim();
    if (!label || !newDeptId || newLabelExists) return;
    setCreating(true);
    try {
      await hrAddDesignation(newDeptId, label);
      const dept = depts.find((d) => d.id === newDeptId);
      setNewLabel("");
      toast.success(`${label} added to ${dept?.name || "department"}`);
      await load();
      reloadMeta();
      setPendingDepartment(dept?.name || "");
      setPendingDesignation(label);
      setShowAddEmployee(true);
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to add designation"); }
    setCreating(false);
  };

  // Applied optimistically — the drag (or arrow click) already showed the new order, so it
  // shouldn't visibly snap back while the request is in flight — then reconciled with the
  // server, or rolled back with a fresh load if the save itself failed.
  const reorder = async (deptId, fromIndex, toIndex) => {
    if (fromIndex === toIndex || toIndex < 0) return;
    const dept = depts.find((d) => d.id === deptId);
    if (!dept || toIndex >= (dept.designations || []).length) return;
    const list = [...dept.designations];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    setDepts((prev) => prev.map((d) => (d.id === deptId ? { ...d, designations: list } : d)));
    try {
      await hrReorderDesignations(deptId, list);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to reorder");
      load();
    }
  };

  const visibleDepts = depts.filter((d) => (d.designations || []).some(matches));

  if (loading && depts.length === 0) return <p className="text-sm text-slate-500">Loading...</p>;

  return (
    <div className="space-y-4" data-testid="hr-designations-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Every designation, grouped by department. Rename one, or add a brand new one.</p>
        <SearchIconInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search designations..." testid="hr-designation-search" />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Add a new designation</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <select
              value={newDeptId}
              onChange={(e) => setNewDeptId(e.target.value)}
              className="h-9 min-w-[10rem] rounded-md border border-slate-200 px-3 text-sm"
              data-testid="hr-designation-new-dept"
            >
              <option value="">Department...</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newDeptId && !newLabelExists) createNew(); }}
              placeholder="e.g. Nutritionist"
              className="h-9 min-w-[10rem] flex-1"
              data-testid="hr-designation-new-input"
            />
            <Button onClick={createNew} disabled={creating || !newDeptId || !newLabel.trim() || newLabelExists} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-designation-new-submit">
              {creating ? "Adding..." : "Add"}
            </Button>
          </div>
          {newLabelExists && <p className="mt-1.5 text-[11px] font-semibold text-red-500" data-testid="hr-designation-new-duplicate">That designation already exists.</p>}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {visibleDepts.map((d) => (
          <Card key={d.id} data-testid={`hr-designation-dept-${d.id}`}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{d.name}</CardTitle></CardHeader>
            <CardContent className="space-y-1">
              {/* Dragging (and the up/down fallback for touch) only make sense against the
                  department's real order, which a search filter would scramble the
                  indices of — so reordering is only offered with the search box empty. */}
              {(d.designations || []).filter(matches).map((label, index) => {
                const count = designationCounts[label] || 0;
                const isEditing = editingKey === `${d.id}:${label}`;
                const reorderable = !q && !isEditing;
                const total = d.designations.length;
                return (
                  <div
                    key={label}
                    draggable={reorderable}
                    onDragStart={(e) => {
                      // Firefox won't continue a drag past dragstart unless dataTransfer
                      // actually carries something — the label itself is as good as any.
                      e.dataTransfer.setData("text/plain", label);
                      e.dataTransfer.effectAllowed = "move";
                      setDragDeptId(d.id); setDragIndex(index);
                    }}
                    onDragOver={(e) => { if (reorderable && dragDeptId === d.id) e.preventDefault(); }}
                    onDrop={(e) => {
                      if (!(reorderable && dragDeptId === d.id) || dragIndex === null) return;
                      e.preventDefault();
                      reorder(d.id, dragIndex, index);
                      setDragDeptId(null); setDragIndex(null);
                    }}
                    onDragEnd={() => { setDragDeptId(null); setDragIndex(null); }}
                    className={`flex items-center gap-2 rounded-md px-2 py-2 hover:bg-slate-50 ${reorderable ? "cursor-grab active:cursor-grabbing" : ""}`}
                    data-testid={`hr-designation-row-${d.id}-${label}`}
                  >
                    {isEditing ? (
                      <>
                        <Input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveRename(d.id, label); if (e.key === "Escape") cancelRename(); }}
                          className="h-8 flex-1 text-sm"
                          data-testid={`hr-designation-rename-input-${d.id}-${label}`}
                        />
                        <button onClick={() => saveRename(d.id, label)} disabled={renaming} className="shrink-0 text-emerald-600 hover:text-emerald-700" title="Save" data-testid={`hr-designation-rename-save-${d.id}-${label}`}>
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                        <button onClick={cancelRename} className="shrink-0 text-slate-400 hover:text-slate-600" title="Cancel" data-testid={`hr-designation-rename-cancel-${d.id}-${label}`}>
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        {reorderable ? (
                          <GripVertical className="h-4 w-4 shrink-0 text-slate-300" />
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{label}</span>
                        {reorderable && (
                          <div className="flex shrink-0 flex-col">
                            <button onClick={() => reorder(d.id, index, index - 1)} disabled={index === 0} className="text-slate-300 hover:text-sky-600 disabled:pointer-events-none disabled:opacity-30" title="Move up" data-testid={`hr-designation-up-${d.id}-${label}`}>
                              <ChevronUp className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => reorder(d.id, index, index + 1)} disabled={index === total - 1} className="text-slate-300 hover:text-sky-600 disabled:pointer-events-none disabled:opacity-30" title="Move down" data-testid={`hr-designation-down-${d.id}-${label}`}>
                              <ChevronDown className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                        <button onClick={() => startRename(d.id, label)} className="shrink-0 text-slate-400 hover:text-sky-600" title="Rename designation" data-testid={`hr-designation-edit-${d.id}-${label}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <span className="shrink-0 text-xs text-slate-500">{count} employee{count === 1 ? "" : "s"}</span>
                        {count > 0 && (
                          <button type="button" onClick={() => setViewingDesignation(label)} className="shrink-0 text-xs font-medium text-sky-600 hover:text-sky-700" data-testid={`hr-designation-view-${d.id}-${label}`}>
                            View
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
        {visibleDepts.length === 0 && depts.length > 0 && <p className="text-sm text-slate-400">No designations match "{search}".</p>}
        {depts.length === 0 && <p className="text-sm text-slate-400">No departments yet — add one on the Departments tab first.</p>}
      </div>

      {viewingDesignation && (
        <DesignationEmployeesModal
          designation={viewingDesignation}
          employees={employees.filter((e) => e.designation === viewingDesignation)}
          departmentNames={depts.map((d) => d.name)}
          onClose={() => setViewingDesignation(null)}
          onChanged={() => { load(); reloadMeta(); }}
        />
      )}

      {showAddEmployee && (
        <AddEmployeeModal
          employee={null}
          initialDepartment={pendingDepartment}
          initialDesignation={pendingDesignation}
          meta={meta}
          onClose={() => { setShowAddEmployee(false); setPendingDepartment(""); setPendingDesignation(""); }}
          onSaved={() => { setShowAddEmployee(false); setPendingDepartment(""); setPendingDesignation(""); load(); reloadMeta(); }}
        />
      )}
    </div>
  );
};

// Row-based list of every employee holding one designation, opened from the
// designations checklist. Department is editable right here — reassigning someone out
// of a department they're incorrectly parked in is the main reason to open this list.
const DesignationEmployeesModal = ({ designation, employees, departmentNames, onClose, onChanged }) => {
  const [savingId, setSavingId] = useState(null);

  const changeDepartment = async (emp, department) => {
    if (department === (emp.department || "")) return;
    setSavingId(emp.id);
    try {
      await hrUpdateEmployee(emp.id, { department });
      toast.success(`${emp.full_name} moved to ${department}`);
      onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to update"); }
    setSavingId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="hr-designation-employees-modal">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h3 className="text-base font-semibold">{designation}</h3>
            <p className="text-xs text-slate-500">{employees.length} employee{employees.length === 1 ? "" : "s"}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="hr-designation-employees-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {employees.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-100 px-3 py-2" data-testid={`hr-designation-employee-row-${e.id}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-700">
                {(e.full_name || "?").charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{e.full_name}</p>
                <p className="truncate text-xs text-slate-500">{e.employee_code}{e.email ? ` · ${e.email}` : ""}{displayPhone(e.phone) ? ` · ${displayPhone(e.phone)}` : ""}</p>
              </div>
              <select
                value={e.department || ""}
                disabled={savingId === e.id}
                onChange={(ev) => changeDepartment(e, ev.target.value)}
                className="h-8 shrink-0 rounded-md border border-slate-200 px-2 text-xs"
                data-testid={`hr-designation-employee-dept-${e.id}`}
              >
                <option value="">— Unassigned —</option>
                {departmentNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          ))}
          {employees.length === 0 && <p className="px-2 py-6 text-center text-sm text-slate-400">No employees hold this designation.</p>}
        </div>
        <div className="flex items-center justify-end border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="hr-designation-employees-done">Done</Button>
        </div>
      </div>
    </div>
  );
};

/** Whether this server can send email, and proof either way.
 *
 *  Sits above the user list because this is the Credentials screen and email is what
 *  Credentials depends on: a sign-in code, a password reset link, a reset OTP all leave
 *  through one SMTP account. When that account is wrong, every one of those fails, and
 *  what a user sees is "we couldn't send it" while the actual cause sits in a log on the
 *  VPS that nobody looking at this screen can open.
 *
 *  Draws nothing at all unless the caller is Super Admin — the endpoint answers 403 to
 *  everyone else, and that 403 is what this reads as "not for me" rather than as an error
 *  worth a toast. Nothing here is broken for an HR user who cannot see it.
 *
 *  Quiet when it is working: a gear on the Credentials toolbar, opening into the status
 *  and the test button. When it is not, the gear carries an amber dot, so the day it is
 *  broken still shows without anyone having to open it.
 */
const EmailDeliveryPanel = () => {
  const [status, setStatus] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }

  const load = useCallback(() => {
    hrEmailStatus()
      .then(setStatus)
      .catch((e) => {
        // 403 is the expected answer for anyone but a Super Admin, and means "do not draw
        // this", not "something went wrong". Any other failure also hides it rather than
        // putting an error where a status was meant to go.
        setHidden(true);
        if (e?.response?.status !== 403) console.warn("[email status]", e?.message || e);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const sendTest = async () => {
    try {
      setBusy(true);
      setResult(null);
      const data = await hrEmailTest();
      setResult({ ok: true, text: data.message });
      load();
    } catch (e) {
      // Shown in full and left on screen rather than sent to a toast that disappears in
      // four seconds. This string is the thing being read — "535 Username and Password
      // not accepted" is what tells an admin the App Password is wrong — and it is worth
      // copying into a search box, which a toast does not survive long enough for.
      setResult({ ok: false, text: e?.response?.data?.detail || e?.message || "The test failed" });
    } finally {
      setBusy(false);
    }
  };

  if (hidden || !status) return null;

  const ok = status.configured;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Email delivery settings"
          aria-label="Email delivery settings"
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-sky-300 hover:text-sky-600"
          data-testid="hr-email-settings-btn"
        >
          <Settings className="h-4 w-4" />
          {!ok && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-amber-500" data-testid="hr-email-settings-alert" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="hr-email-panel">
        <div className={`rounded-t-md border-b p-3 ${ok ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
          <div className="flex min-w-0 items-start gap-2.5">
            {ok
              ? <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
            <div className="min-w-0">
              <p className={`text-sm font-semibold ${ok ? "text-emerald-800" : "text-amber-900"}`} data-testid="hr-email-headline">
                {ok ? "Email delivery is configured" : "This server cannot send email"}
              </p>
              <p className={`break-words text-xs ${ok ? "text-emerald-700" : "text-amber-800"}`} data-testid="hr-email-detail">
                {ok
                  ? `Sending as ${status.user} via ${status.host}:${status.port}.`
                  : "Sign-in codes, password resets and two-factor all need this. Nobody can receive one until it is set."}
              </p>
              {!ok && status.hint && (
                <p className="mt-1.5 text-xs text-amber-800" data-testid="hr-email-hint">{status.hint}</p>
              )}
            </div>
          </div>
        </div>
        <div className="space-y-2.5 p-3">
          <Button
            onClick={sendTest}
            disabled={busy}
            variant="outline"
            className="w-full"
            data-testid="hr-email-test-btn"
          >
            {busy ? "Sending…" : "Send test email"}
          </Button>
          {result && (
            <p
              className={`break-words rounded-md px-2.5 py-2 text-xs ${result.ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}
              data-testid="hr-email-test-result"
            >
              {result.text}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const RolesTab = ({ meta, reloadMeta }) => {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  // Department then Designation, as two dropdowns of the same shape, reading off each
  // user's linked employee record. A user with no linked employee (most Branch
  // Admin/Pre-Sales accounts still without one) won't match the department filter; the
  // designation one still reaches them, through their role. See filteredUsers.
  const [deptFilter, setDeptFilter] = useState("");
  const [designationFilter, setDesignationFilter] = useState("");
  const [sortAZ, setSortAZ] = useState(null); // null = as-loaded | "asc" | "desc"
  const [showCreate, setShowCreate] = useState(false);
  const [actionTarget, setActionTarget] = useState(null);
  const [view, setView] = useState("list"); // "list" | "branch"

  // No role parameter any more: the Designation filter does that job, and it narrows the
  // rows already loaded rather than re-fetching. Search stays on the server, where it can
  // reach a name this page has not loaded.
  const load = useCallback(() => hrUsers({ search }).then(setUsers).catch((e) => console.warn("[load failed]", e?.message || e)), [search]);
  useEffect(() => { load(); }, [load]);

  const selectDept = (d) => { setDeptFilter(d); setDesignationFilter(""); };

  // Designations narrow to whichever department is picked and are grouped under it, same
  // as the Employees tab — the two filters ask the same question of two lists and should
  // not read as two different controls.
  //
  // The records half is each user's linked employee, which is the only place a user
  // carries a department at all. Accounts with no employee behind them contribute
  // nothing here, and do not need to: their role is what the filter below matches them
  // on, and a role's label is a designation the structure already lists.
  const designationGroups = useMemo(
    () => groupedDesignations(meta, deptFilter, users.map((u) => u.linked_employee).filter(Boolean)),
    [users, deptFilter, meta]
  );

  // Matched on the shared key rather than the exact string. One option now stands for
  // every spelling of a job, so picking Consultant finds the people filed under CONSULTANT
  // too — which is what a reader expects of a list that shows the job once.
  const filteredUsers = users.filter((u) => {
    if (deptFilter && nameKey(u.linked_employee?.department) !== nameKey(deptFilter)) return false;
    // Designation OR role. The designation is on the employee record, and plenty of
    // accounts have no employee behind them — most Branch Admin and Pre-Sales logins still
    // do not — so reading only that left them matching nothing at all. Their role says the
    // same thing the designation would have, and a designation IS a role here, so the one
    // option answers for both. This is what the separate role filter used to be for.
    if (designationFilter) {
      const want = jobKey(designationFilter);
      if (jobKey(u.linked_employee?.designation) !== want && jobKey(roleLabel(u.role)) !== want) return false;
    }
    return true;
  });

  const sortedUsers = sortAZ
    ? [...filteredUsers].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "") * (sortAZ === "asc" ? 1 : -1))
    : filteredUsers;

  // Who works where, and as what.
  //
  // Grouped by branch and then by role, because the question this answers is about a
  // branch rather than about a person: which desks are staffed at Anna Nagar, and who is
  // on them. The flat list above answers the other question and is still there for it.
  //
  // Somebody covering three branches is listed under all three. They are genuinely on
  // that branch's roster, and leaving them off the other two would make a branch read as
  // unstaffed for a role that is in fact covered.
  //
  // Super Admin is left out throughout: the account that owns the OS is not a member of
  // any branch's staff, and listing it under every branch would say otherwise.
  const branchGroups = useMemo(() => {
    const byBranch = new Map();
    const place = (branchName, user) => {
      if (!byBranch.has(branchName)) byBranch.set(branchName, new Map());
      const byRole = byBranch.get(branchName);
      const role = roleLabel(user.role);
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(user);
    };

    sortedUsers
      .filter((u) => u.role !== "super_admin")
      .forEach((u) => {
        const named = (u.branches || []).map((b) => b.name).filter(Boolean);
        // "All branches" is a heading nothing lands under any more: no role covers every
        // branch since Consultants became branch-selective, so org_wide always reads false
        // and a Consultant appears under each branch they are posted to. Kept for a row
        // served by a backend that has not restarted into the change yet.
        if (u.org_wide) place("All branches", u);
        else if (named.length) named.forEach((n) => place(n, u));
        // Kept rather than dropped: an account belonging to no branch is nearly always
        // an oversight, and it can only be noticed if it is shown somewhere.
        else place("No branch assigned", u);
      });

    // Real branches first, alphabetically; the two catch-alls last, where they read as
    // notes about the list rather than as branches in it.
    const rank = (name) => (name === "All branches" ? 1 : name === "No branch assigned" ? 2 : 0);
    return [...byBranch.entries()]
      .map(([branch, byRole]) => ({
        branch,
        people: [...byRole.values()].reduce((n, list) => n + list.length, 0),
        roles: [...byRole.entries()]
          .map(([role, list]) => ({ role, list }))
          .sort((a, b) => a.role.localeCompare(b.role)),
      }))
      .sort((a, b) => rank(a.branch) - rank(b.branch) || a.branch.localeCompare(b.branch));
  }, [sortedUsers]);

  // flex+gap, not space-y — the mobile-only toolbar/cards and the desktop table are
  // each hidden by class depending on breakpoint, not the hidden attribute.
  return (
    <div className="flex flex-col gap-4" data-testid="hr-roles-tab">
      {/* One toolbar, the same as Employees: Search, A → Z, Department, Designation, the
          All Users / Branch Wise switch, then Create User pushed to the far end.

          Department then Designation are two halves of one narrowing — which department,
          then which job in it — reading off each row's linked employee, so picking a
          department narrows the designations beside it.

          The two views answer two questions: All Users "who is this person and what can
          they do"; Branch Wise "which desks are staffed here, and by whom". Search and
          the sort apply to both. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="hr-roles-toolbar">
        <SearchIconInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email..." testid="hr-roles-search" />
        <button
          type="button"
          onClick={() => setSortAZ((s) => (s === "asc" ? "desc" : "asc"))}
          title="Sort by name"
          className={`h-10 shrink-0 rounded-md border px-3 text-sm font-medium transition ${sortAZ ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          data-testid="hr-roles-sort-az"
        >
          {sortAZ === "desc" ? "Z → A" : "A → Z"}
        </button>
        <DepartmentFilterSelect
          value={deptFilter}
          onChange={selectDept}
          departments={meta.departments}
          testid="hr-roles-dept-filter-select"
        />
        <DesignationFilterSelect
          value={designationFilter}
          onChange={setDesignationFilter}
          groups={designationGroups}
          testid="hr-roles-designation-filter-select"
        />
        <div className="flex items-center gap-2" data-testid="hr-roles-view">
          {[{ key: "list", label: "All Users" }, { key: "branch", label: "Branch Wise" }].map((v) => (
            <TabPill key={v.key} active={view === v.key} onClick={() => setView(v.key)} testid={`hr-roles-view-${v.key}`}>
              {v.label}
            </TabPill>
          ))}
        </div>
        {/* Email delivery: everything Credentials hands out — a new account, a password
            reset — travels by email. Draws nothing for a non-Super-Admin. */}
        <div className="ml-auto flex items-center gap-2">
          <EmailDeliveryPanel />
          <Button onClick={() => setShowCreate(true)} className="bg-sky-600 hover:bg-sky-700" data-testid="hr-roles-create-btn"><UserPlus className="h-4 w-4 mr-1" />Create User</Button>
        </div>
      </div>

      {view === "branch" && (
        <div className="space-y-3" data-testid="hr-branch-wise">
          {branchGroups.map((g) => (
            <Card key={g.branch} data-testid={`hr-branch-group-${g.branch}`}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                <CardTitle className="text-sm font-semibold text-slate-800">{g.branch}</CardTitle>
                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                  {g.roles.length} {g.roles.length === 1 ? "role" : "roles"} · {g.people} {g.people === 1 ? "person" : "people"}
                </span>
              </CardHeader>
              <CardContent className="space-y-1.5 p-0 pb-3">
                {g.roles.map(({ role, list }) => (
                  <div key={role} className="flex flex-wrap items-start gap-2 px-4 py-1.5" data-testid={`hr-branch-role-${role}`}>
                    <span className={`w-44 shrink-0 rounded px-2 py-0.5 text-[11px] font-bold ${roleClasses(list[0].role)}`}>{role}</span>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {list.map((u) => (
                        <span key={u.id} className="inline-flex items-center gap-1.5 text-xs text-slate-700" title={u.email}>
                          {u.full_name}
                          {/* An account switched off is still on the roster and still
                              holds the desk, so it is shown and marked rather than hidden
                              — a branch reading as staffed by somebody who cannot log in
                              is the thing worth seeing. */}
                          {u.is_active === false && (
                            <span className="rounded bg-slate-200 px-1 py-px text-[9px] font-bold text-slate-500">INACTIVE</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
          {branchGroups.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">No users.</p>
          )}
        </div>
      )}

      <div className={`space-y-2 md:hidden ${view === "branch" ? "hidden" : ""}`} data-testid="hr-user-cards">
        {sortedUsers.map((u) => (
          <div key={u.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`hr-user-card-${u.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{u.full_name}</p>
                <p className="truncate text-xs text-slate-500">{u.email}</p>
              </div>
              <button
                onClick={() => setActionTarget(u)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600"
                aria-label={`Actions for ${u.full_name}`}
                data-testid={`hr-user-card-actions-${u.id}`}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${u.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{u.is_active ? "Active" : "Inactive"}</span>
              {u.two_factor_enabled && (
                <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700" data-testid={`hr-user-card-2fa-${u.id}`}>
                  <ShieldCheck className="h-3 w-3" />2FA
                </span>
              )}
            </div>
            {u.linked_employee && (
              <p className="mt-1.5 text-xs text-emerald-600">{u.linked_employee.employee_code} - {u.linked_employee.designation || u.linked_employee.full_name}</p>
            )}
          </div>
        ))}
        {sortedUsers.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">No users.</p>}
      </div>

      <Card className={`hidden overflow-hidden ${view === "branch" ? "" : "md:block"}`}>
        <CardContent className="p-0">
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              {/* No Role column. The role is the designation, and Linked Employee already
                  prints it beside the employee code — "EMP0078 - Branch Admin" — so a
                  column of dropdowns beside it was a second copy of the same fact, and the
                  only one of the two that could be edited into disagreeing with the other.
                  A role is changed by changing the designation, in Department & Designation.

                  Branch keeps its column and loses only its heading: a branch name says what
                  it is, where an employee code and a status pill do not. */}
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">S.No</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Linked Employee</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /><th className="px-3 py-2">Action</th></tr></thead>
              <tbody>
                {sortedUsers.map((u, i) => (
                  <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`hr-user-row-${u.id}`}>
                    <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-2 font-medium text-slate-800">{u.full_name}</td>
                    <td className="px-3 py-2 text-slate-600">{u.email}</td>
                    <td className="px-3 py-2 text-xs text-emerald-600">{u.linked_employee ? `${u.linked_employee.employee_code} - ${u.linked_employee.designation || u.linked_employee.full_name}` : "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={`rounded px-2 py-0.5 text-xs ${u.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{u.is_active ? "Active" : "Inactive"}</span>
                        {/* Read-only, and beside Active because it belongs to the same
                            question — can this person get in. It is the first thing to
                            check when somebody reports being stuck at sign-in, and there
                            is no action on it here: two-factor is the account holder's
                            own, switched off only from their Security tab. */}
                        {u.two_factor_enabled && (
                          <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700" title="Two-factor authentication is on — this user gets a code by email at every sign-in" data-testid={`hr-user-2fa-${u.id}`}>
                            <ShieldCheck className="h-3 w-3" />2FA
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2"><UserBranch user={u} /></td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setActionTarget(u)}
                        title="Open actions"
                        className="text-slate-500 hover:text-sky-600"
                        aria-label={`Actions for ${u.full_name}`}
                        data-testid={`hr-user-actions-${u.id}`}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {sortedUsers.length === 0 && <tr><td colSpan="7" className="px-3 py-6 text-center text-slate-400">No users.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {showCreate && <CreateUserModal meta={meta} reloadMeta={reloadMeta} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}

      {actionTarget && (
        <UserActionsModal
          user={actionTarget}
          onClose={() => setActionTarget(null)}
          onDone={() => { setActionTarget(null); load(); }}
        />
      )}
    </div>
  );
};

const UserActionsModal = ({ user, onClose, onDone }) => {
  const [mode, setMode] = useState(null); // null | "edit" | "password" | "delete"
  const [pwd, setPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState([]);
  const [employees, setEmployees] = useState([]);
  const roleLabelForMulti = multiBranchLabel(user.role);
  const isMultiBranchRole = Boolean(roleLabelForMulti);
  const [editForm, setEditForm] = useState({
    full_name: user.full_name || "",
    email: user.email || "",
    branch_id: user.branch_id || "",
    branch_ids: user.branch_ids && user.branch_ids.length ? user.branch_ids : (user.branch_id ? [user.branch_id] : []),
    employee_id: user.employee_id || "",
    mobile_number: user.mobile_number || "",
    aadhar_number: user.aadhar_number || "",
  });

  useEffect(() => {
    if (mode !== "edit") return;
    getBranches().then(setBranches).catch(() => {});
    hrEmployees({ status: "active" }).then(setEmployees).catch(() => {});
  }, [mode]);

  // A login linked to an employee takes its Name and Branch from them: those are changed on
  // the employee (Employees, or Department & Designation) and reach the login from there.
  // Only a login with nobody behind it — "Past Data Entry" and the like — still has its
  // own, since there is no employee record to change them on.
  const linked = Boolean(editForm.employee_id);
  const linkedEmp = employees.find((e) => e.id === editForm.employee_id);
  const newlyLinked = linked && editForm.employee_id !== (user.employee_id || "");
  const shownName = newlyLinked && linkedEmp ? linkedEmp.full_name : editForm.full_name;
  const shownBranchIds = newlyLinked && linkedEmp
    ? ((linkedEmp.branch_ids || []).filter((b) => b && b !== ALL_BRANCHES).length
      ? linkedEmp.branch_ids.filter((b) => b && b !== ALL_BRANCHES)
      : (linkedEmp.branch_id && linkedEmp.branch_id !== ALL_BRANCHES ? [linkedEmp.branch_id] : []))
    : editForm.branch_ids;

  const submitEdit = async () => {
    if (!editForm.email.trim()) { toast.error("Email is required"); return; }
    if (!linked && !editForm.full_name.trim()) { toast.error("Name is required"); return; }
    if (!linked && isMultiBranchRole && !BRANCHLESS_OK_ROLES.has(user.role) && editForm.branch_ids.length === 0) {
      toast.error("Select at least one branch"); return;
    }
    try {
      setBusy(true);
      const { branch_ids, branch_id, full_name, ...rest } = editForm;
      let payload;
      if (!linked) {
        // branch_ids only applies (and is only sent) for Head Physio/Physio — every other
        // role keeps its single `branch_id` select untouched by the multi-branch field.
        payload = isMultiBranchRole ? { ...rest, full_name, branch_ids } : { ...rest, full_name, branch_id };
      } else if (newlyLinked && linkedEmp) {
        // Linked just now: the login adopts the employee's name and, where they have one,
        // their branch — the same copy Create User makes. An employee on every branch
        // sends none, since the server would write a login's "no branches" back onto the
        // employee as no branch at all.
        payload = { ...rest, full_name: linkedEmp.full_name };
        if (shownBranchIds.length) {
          payload = isMultiBranchRole ? { ...payload, branch_ids: shownBranchIds } : { ...payload, branch_id: shownBranchIds[0] };
        }
      } else {
        payload = rest;
      }
      await hrUpdateUser(user.id, payload);
      toast.success(`${shownName || user.full_name} updated`);
      onDone();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to update user"); }
    finally { setBusy(false); }
  };

  const submitPwd = async () => {
    if (pwd.length < 6) { toast.error("Password must be at least 6 characters"); return; }
    if (pwd !== confirmPwd) { toast.error("Passwords do not match"); return; }
    try {
      setBusy(true);
      const data = await hrResetPassword(user.id, pwd);
      toast.success(
        data?.sessions_ended
          ? `Password updated for ${user.full_name} — signed out of ${data.sessions_ended} device${data.sessions_ended === 1 ? "" : "s"}`
          : `Password updated for ${user.full_name}`,
      );
      onDone();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to update password"); }
    finally { setBusy(false); }
  };

  const doActivate = async () => {
    try { setBusy(true); await hrActivateUser(user.id); toast.success(`${user.full_name} activated`); onDone(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
    finally { setBusy(false); }
  };

  const doDeactivate = async () => {
    try { setBusy(true); await hrDeactivateUser(user.id); toast.success(`${user.full_name} deactivated`); onDone(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    try {
      setBusy(true);
      await hrDeleteUserPermanent(user.id);
      toast.success(`${user.full_name} permanently deleted`);
      onDone();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to delete"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="hr-user-actions-modal">
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-800" data-testid="hr-actions-title">Actions — {user.full_name}</h3>
            <p className="text-xs text-slate-500">
              {user.email} · <span className={user.is_active ? "text-emerald-600" : "text-slate-500"}>{user.is_active ? "Active" : "Inactive"}</span>
              {user.two_factor_enabled && <span className="text-violet-600"> · 2FA on</span>}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100" data-testid="hr-actions-close"><X className="h-4 w-4" /></button>
        </div>

        {!mode && (
          <div className="grid gap-2">
            <button
              onClick={() => setMode("edit")}
              className="flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-left hover:bg-sky-100"
              data-testid="hr-actions-edit"
            >
              <Pencil className="h-4 w-4 text-sky-600" />
              <div>
                <p className="text-sm font-semibold text-sky-700">Edit</p>
                <p className="text-[11px] text-sky-600">Update this user's details.</p>
              </div>
            </button>

            {/* Violet, not blue — Edit sits right above this in the same blue the rest of
                the app now uses, and two actions in one colour here would read as one. */}
            <button
              onClick={() => setMode("password")}
              className="flex items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5 text-left hover:bg-violet-100"
              data-testid="hr-actions-change-password"
            >
              <KeyRound className="h-4 w-4 text-violet-600" />
              <div>
                <p className="text-sm font-semibold text-violet-700">Change Password</p>
                <p className="text-[11px] text-violet-600">Set a new password for this user.</p>
              </div>
            </button>

            {user.is_active ? (
              <button
                onClick={doDeactivate}
                disabled={busy}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-left hover:bg-slate-100 disabled:opacity-60"
                data-testid="hr-actions-deactivate"
              >
                <XCircle className="h-4 w-4 text-slate-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-700">Deactivate</p>
                  <p className="text-[11px] text-slate-500">User keeps their data but can no longer log in.</p>
                </div>
              </button>
            ) : (
              <button
                onClick={doActivate}
                disabled={busy}
                className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-left hover:bg-emerald-100 disabled:opacity-60"
                data-testid="hr-actions-activate"
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-emerald-700">Activate</p>
                  <p className="text-[11px] text-emerald-600">Restore login access for this user.</p>
                </div>
              </button>
            )}

            <button
              onClick={() => setMode("delete")}
              className="flex items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-left hover:bg-rose-100"
              data-testid="hr-actions-delete"
            >
              <AlertOctagon className="h-4 w-4 text-rose-600" />
              <div>
                <p className="text-sm font-semibold text-rose-700">Permanently Delete</p>
                <p className="text-[11px] text-rose-600">Cannot be undone — user record is removed completely.</p>
              </div>
            </button>
          </div>
        )}

        {mode === "edit" && (
          <div className="space-y-3" data-testid="hr-actions-edit-form">
            {linked ? (
              <>
                <Field label="Name (from employee)"><Input value={shownName} readOnly disabled className="bg-slate-50" data-testid="hr-actions-edit-name" /></Field>
                <Field label="Branch (from employee)"><LockedBranches ids={shownBranchIds} branches={branches} testid="hr-actions-edit-branch" /></Field>
              </>
            ) : (
              <Field label="Name"><Input placeholder="Full name" value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} data-testid="hr-actions-edit-name" /></Field>
            )}
            <Field label="Email"><Input placeholder="user@company.com" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} data-testid="hr-actions-edit-email" /></Field>
            {!linked && (
              <>
                {isMultiBranchRole ? (
                  <Field label={`Branches (${roleLabelForMulti} can cover more than one)`}>
                    <div className="space-y-1.5 rounded-md border border-slate-200 p-2" data-testid="hr-actions-edit-branch-ids">
                      {branches.map((b) => {
                        const checked = editForm.branch_ids.includes(b.id);
                        return (
                          <label key={b.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setEditForm({
                                ...editForm,
                                branch_ids: e.target.checked
                                  ? [...editForm.branch_ids, b.id]
                                  : editForm.branch_ids.filter((id) => id !== b.id),
                              })}
                              data-testid={`hr-actions-edit-branch-ids-${b.id}`}
                            />
                            {b.branch_name}
                          </label>
                        );
                      })}
                      {branches.length === 0 && <p className="px-1.5 py-1 text-xs text-slate-400">No branches yet</p>}
                    </div>
                  </Field>
                ) : (
                  <Field label="Branch">
                    <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={editForm.branch_id} onChange={(e) => setEditForm({ ...editForm, branch_id: e.target.value })} data-testid="hr-actions-edit-branch">
                      <option value="">No branch</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                    </select>
                  </Field>
                )}
              </>
            )}
            <Field label="Linked Employee">
              <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={editForm.employee_id} onChange={(e) => setEditForm({ ...editForm, employee_id: e.target.value })} data-testid="hr-actions-edit-employee">
                <option value="">Not linked</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.employee_code} — {e.full_name} ({e.designation || "—"})</option>)}
              </select>
            </Field>
            {/* Mobile and Aadhar are gone from here. They belong to the employee record
                in HR, not to the login account this popup edits, and were the two fields
                nobody filled in. Still sent unchanged in the payload below, so a value
                already stored against an account is not wiped by saving this form. */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMode(null)} className="flex-1" data-testid="hr-actions-edit-back">Back</Button>
              <Button onClick={submitEdit} disabled={busy} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="hr-actions-edit-save">Save Changes</Button>
            </div>
          </div>
        )}

        {mode === "password" && (
          <div className="space-y-3" data-testid="hr-actions-password-form">
            <PasswordInput placeholder="New password (min 6)" value={pwd} onChange={(e) => setPwd(e.target.value)} testid="hr-actions-password-new" />
            <PasswordInput placeholder="Confirm new password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} testid="hr-actions-password-confirm" />
            {/* The two consequences, said where the button is. Both are asked about often
                enough to be worth two lines: the sign-out is new, and the 2FA one is the
                answer to "I reset their password and they still can't get in". */}
            <p className="text-[11px] text-slate-500" data-testid="hr-actions-password-note">
              This signs {user.full_name} out of every device.
              {user.two_factor_enabled
                ? " They have two-factor on, so they'll still need the code emailed to them at sign-in — only they can switch that off, from their own Security tab."
                : ""}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setMode(null); setPwd(""); setConfirmPwd(""); }} className="flex-1" data-testid="hr-actions-password-back">Back</Button>
              <Button onClick={submitPwd} disabled={busy} className="flex-1 bg-violet-600 hover:bg-violet-700" data-testid="hr-actions-password-save">Update Password</Button>
            </div>
          </div>
        )}

        {mode === "delete" && (
          <div className="space-y-3" data-testid="hr-actions-delete-confirm">
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              <p className="font-semibold">Confirm permanent deletion</p>
              <p className="mt-1">This will delete <b>{user.full_name}</b> ({user.email}) permanently. This action cannot be undone.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMode(null)} className="flex-1" data-testid="hr-actions-delete-cancel">Cancel</Button>
              <Button onClick={doDelete} disabled={busy} className="flex-1 bg-rose-600 hover:bg-rose-700" data-testid="hr-actions-delete-confirm-btn">Yes, Delete Permanently</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Picks a designation (from Departments & Designation), not a raw role slug — the caller
 * resolves that pick to an actual access role.
 *
 * A dialog rather than a panel: this sits inside a modal that already scrolls, and a list
 * hanging off a field within it was cropped by the dialog's own overflow. The list is also
 * long enough to want the whole screen rather than the gap under one field.
 */
const RoleSelectDropdown = ({ value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-sm text-slate-700"
        data-testid="hr-create-user-role"
      >
        <span className={`truncate ${value ? "" : "text-slate-400"}`}>{value || "Select role"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <PickerModal
          title="Select role"
          value={value || ""}
          options={options.map((o) => ({ value: o, label: o }))}
          onPick={(v) => { setOpen(false); onChange(v); }}
          onClose={() => setOpen(false)}
          searchable
          searchPlaceholder="Search role..."
        />
      )}
    </>
  );
};

// Designation text (e.g. "HEAD PHYSIO") reuses the same role coloring as
// roleClasses/roleLabel by converting it back to a role slug ("consultant").
const designationSlug = (designation) => (designation || "").trim().toLowerCase().replace(/\s+/g, "_");

/**
 * Picks the employee a login belongs to. Searchable, because this list runs to the whole
 * payroll and scrolling seventy rows to find one name is the slow way to do it.
 *
 * The code, the name and the designation are all searched, since any of the three is what
 * somebody happens to know when they come looking.
 */
const EmployeeSelectDropdown = ({ value, employees, onChange }) => {
  const [open, setOpen] = useState(false);
  const selected = employees.find((e) => e.id === value);
  const label = (e) => `${e.employee_code} — ${e.full_name} (${e.designation || "—"})`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-sm text-slate-700"
        data-testid="hr-create-user-emp"
      >
        <span className={`truncate ${selected ? "" : "text-slate-400"}`}>
          {selected ? label(selected) : "Select employee..."}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <PickerModal
          title="Link to Employee"
          value={value || ""}
          options={[
            { value: "", label: "Select employee..." },
            ...employees.map((e) => ({
              value: e.id,
              label: label(e),
              search: `${e.employee_code || ""} ${e.full_name || ""} ${e.designation || ""}`,
            })),
          ]}
          onPick={(v) => { setOpen(false); onChange(v); }}
          onClose={() => setOpen(false)}
          searchable
          searchPlaceholder="Search employee..."
        />
      )}
    </>
  );
};

/** A login's branches shown as the employee record has them — read, never picked. */
const LockedBranches = ({ ids, branches, testid }) => {
  const names = (ids || []).map((id) => branches.find((b) => b.id === id)?.branch_name).filter(Boolean);
  return (
    <div className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600" data-testid={testid}>
      <span className="truncate">{names.length ? names.join(", ") : "No branch"}</span>
    </div>
  );
};

const CreateUserModal = ({ meta, reloadMeta, onClose, onSaved }) => {
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ employee_id: "", full_name: "", email: "", role: "", branch_id: "", branch_ids: [], password: "", confirm: "" });
  const isMultiBranchRole = Boolean(multiBranchLabel(form.role));
  const { resolve, resolving: resolvingRole } = useDesignationRole(meta, reloadMeta);
  useEffect(() => { hrEmployees({ status: "active" }).then(setEmployees).catch((e) => console.warn("[load failed]", e?.message || e)); }, []);

  const resolveRoleFrom = async (label) => {
    setForm((p) => ({ ...p, role: "" }));
    const role = await resolve(label);
    setForm((p) => ({ ...p, role }));
  };

  /** Everything this form used to ask twice, taken from the person it is creating a login for.
   *
   * Role and Branch were their own fields, and both were already answered on the employee
   * record by the time anybody reached this form: the designation IS the role in this OS,
   * and the branches were set when the employee was posted. Asking again invited the two
   * to disagree — a login filed under one designation and a Consultant record under
   * another — and nothing downstream could tell which of them was meant.
   *
   * ALL_BRANCHES does not survive the copy. An employee covering everything is stored with
   * that marker; an account covering everything is stored holding no branches, which is how
   * list_users and the expert queries both read org-wide. Passing the marker through would
   * put a literal "__all__" where a branch id belongs.
   */
  const pickEmployee = async (id) => {
    const emp = employees.find((e) => e.id === id);
    const posted = (emp?.branch_ids || []).filter((b) => b && b !== ALL_BRANCHES);
    const single = emp?.branch_id && emp.branch_id !== ALL_BRANCHES ? [emp.branch_id] : [];
    const at = posted.length ? posted : single;
    setForm((p) => ({
      ...p,
      employee_id: id,
      full_name: emp?.full_name || p.full_name,
      email: emp?.email || p.email,
      branch_ids: at,
      branch_id: at[0] || "",
    }));
    await resolveRoleFrom(emp?.designation || "");
  };

  const submit = async () => {
    if (resolvingRole) { toast.error("Still setting up that role — one moment"); return; }
    // The employee is where the role comes from now, so there is no account to create
    // without one. Named rather than implied: "employee required" is the whole fix.
    if (!form.employee_id) { toast.error("Pick the employee this login is for"); return; }
    if (!form.role) { toast.error("That employee has no designation — set one on their record first"); return; }
    if (!form.email || !form.password) { toast.error("Email and password required"); return; }
    if (form.password.length < 6) { toast.error("Min 6 characters"); return; }
    if (form.password !== form.confirm) { toast.error("Passwords do not match"); return; }
    // No branch is allowed: the login can be made before the employee is posted anywhere.
    // Their calendar, if their desk holds one, is made when the employee record is first
    // given a branch (update_employee), so it is not refused here any more.
    try {
      await hrCreateUser({
        full_name: form.full_name || form.email.split("@")[0],
        email: form.email,
        password: form.password,
        role: form.role,
        employee_id: form.employee_id || null,
        ...(isMultiBranchRole ? { branch_ids: form.branch_ids }
          : { branch_id: form.branch_id || null }),
      });
      toast.success("User created");
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Create failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="hr-create-user-modal">
      {/* Scaled to 90% so the whole form — heading through Create User — is on screen at
          once. This panel had no height limit at all, which is why it ran off the top
          and bottom and cut its own header and buttons off.
          The max-height reads oddly on purpose: `zoom` scales the computed box, so a vh
          limit set here is multiplied by 0.9 before it lands. 100vh is what leaves the
          panel occupying ~90% of the screen, and the overflow is the safety net for a
          window short enough that even 90% doesn't fit.
          0.9 rather than the 0.8 this started at: two fields have come out of the form, so
          there is room to read the rest at a size closer to the page around it. */}
      <div className="max-h-[100vh] w-full max-w-md space-y-3 overflow-y-auto rounded-lg bg-white p-5 shadow-xl" style={{ zoom: 0.9 }}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Create User Account</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="hr-create-user-close"><X className="h-4 w-4" /></button>
        </div>
        {/* Required now, and first for the same reason: it answers Name, Email, Role and
            Branch in one pick, so everything below it is either already filled in or a
            password. */}
        <Field label="Employee *">
          <EmployeeSelectDropdown value={form.employee_id} employees={employees} onChange={pickEmployee} />
          {resolvingRole && <p className="mt-1 text-[10px] text-slate-400">Setting up their role...</p>}
        </Field>
        {/* Name and Branch are the employee's, read off the pick above and locked: they are
            changed on the employee record (Employees, or Department & Designation), and a
            login carrying its own copy is how the two came to disagree. */}
        <Field label="Name"><Input placeholder="Filled from the employee" value={form.full_name} readOnly disabled className="bg-slate-50" data-testid="hr-create-user-name" /></Field>
        <Field label="Username (Email) *"><Input placeholder="user@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="hr-create-user-email" /></Field>
        <Field label="Password *"><PasswordInput placeholder="Min 6 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} testid="hr-create-user-pwd" /></Field>
        <Field label="Confirm Password *"><PasswordInput placeholder="Confirm password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} testid="hr-create-user-confirm" /></Field>
        <div className="flex gap-2 pt-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="hr-create-user-cancel">Cancel</Button><Button onClick={submit} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="hr-create-user-submit">Create User</Button></div>
      </div>
    </div>
  );
};

// ---------- shared ----------

const Field = ({ label, children, className = "" }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="text-xs font-medium text-slate-600">{label}</label>
    {children}
  </div>
);

// A password box that can be read back. Whoever sets a password here has to pass it on
// to the person it belongs to, so being unable to check what was typed is how an account
// gets handed over with a credential nobody can log in with.
const PasswordInput = ({ value, onChange, placeholder, testid }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="pr-10"
        data-testid={testid}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 transition hover:text-slate-700"
        title={show ? "Hide password" : "Show password"}
        aria-label={show ? "Hide password" : "Show password"}
        data-testid={`${testid}-toggle`}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
};

// `uppercase` styles the displayed text only — the stored value is untouched, so
// existing records and the backend's department list keep matching.
// `labels` maps a stored value to what the reader should see, for the fields whose value
// is a slug rather than a word — "physio" is what the record holds, "Physio" is what the
// row says. Omitted, every option still reads as its own value, as it always did.
// `className` is appended last, so a caller saying something about one particular field —
// an unanswered one worth looking at — overrides the default border rather than fighting it.
const Select = ({ value, onChange, options = [], testid, uppercase = false, labels = null, className = "" }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`h-10 w-full rounded-md border border-slate-200 px-3 text-sm${uppercase ? " uppercase" : ""}${className ? ` ${className}` : ""}`}
    data-testid={testid}
  >
    {options.map((o) => <option key={o} value={o}>{(labels && labels[o]) || o || "Select"}</option>)}
  </select>
);

// Select's props, drawn as the OS's own list rather than the browser's: the same trigger and
// portalled list as Branch Transfer's "Transfer to". The list floats in a portal above the
// dialog (z-[70] over its z-40), so the dialog's scrolling body neither clips it nor shifts
// the fields under it. A stored value the options no longer hold reads as the first option,
// the way the native box showed it.
const OsSelect = ({ value, onChange, options = [], testid, uppercase = false, labels = null, className = "" }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const pos = useFloatingPosition(open, listRef, (w, h) => {
    const gap = 8;
    const field = triggerRef.current.getBoundingClientRect();
    let top = field.bottom + 4;
    if (top + h > window.innerHeight - gap && field.top - h - 4 >= gap) top = field.top - h - 4;
    return { left: field.left, width: field.width, top: clamp(top, gap, window.innerHeight - h - gap) };
  });
  useDismissOutside(open, [triggerRef, listRef], () => setOpen(false));
  const labelOf = (o) => (labels && labels[o]) || o || "Select";
  const shown = options.includes(value) ? value : options[0];
  const pick = (o) => { onChange(o); setOpen(false); };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        className={`flex h-10 w-full items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors ${className || "border-slate-200 bg-white hover:bg-[#F3EFE6]"} ${open ? "ring-2 ring-sky-100" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testid}
      >
        <span className={`min-w-0 flex-1 truncate ${uppercase ? "uppercase" : ""} ${shown ? "font-medium text-slate-800" : "text-slate-400"}`}>
          {labelOf(shown)}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && createPortal(
        <div
          ref={listRef}
          className="fixed z-[70] max-h-60 overflow-y-auto rounded border border-[#EFEAE0] bg-white p-1 shadow-xl"
          style={pos || { top: 0, left: 0, visibility: "hidden" }}
          role="listbox"
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          data-testid={testid && `${testid}-list`}
        >
          {options.map((o) => {
            const on = o === shown;
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => pick(o)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${on ? "bg-sky-100 font-semibold text-slate-800" : o ? "text-slate-600 hover:bg-[#F3EFE6]" : "text-slate-400 hover:bg-[#F3EFE6]"}`}
                data-testid={testid && `${testid}-option-${o || "blank"}`}
              >
                <span className={`min-w-0 flex-1 truncate ${uppercase ? "uppercase" : ""}`}>{labelOf(o)}</span>
                <Check className={`h-4 w-4 shrink-0 text-sky-600 ${on ? "" : "invisible"}`} />
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
};


export default HRBoard;
