import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  BadgeIndianRupee,
  BarChart3,
  Briefcase,
  Building2,
  CalendarDays,
  CalendarOff,
  Headphones,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MoreHorizontal,
  Salad,
  Settings,
  ShieldCheck,
  Store,
  Stethoscope,
  UserPlus,
  Users,
  Workflow,
  X,
  Bell,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  addDoctorSlots,
  apiLogout,
  assignLeadBranch,
  bookLeadAppointment,
  completeAppointment,
  confirmLead,
  createBranch,
  createDoctor,
  createManualLead,
  createSheetConnection,
  createVertical,
  getAvailableDoctors,
  getBranches,
  listBranchFeedback,
  qualifyLead,
  saveSheetMapping,
  syncSheetConnection,
  updateLead,
} from "@/lib/api";
import { toast, Toaster } from "@/components/ui/sonner";
import { EmployeeAvatar, ProfileNavGlyph } from "@/components/ui/employee-avatar";
// Everyone's own clock, in the bar above every board. Static rather than one of the
// lazy boards below: it is on screen for every role from the first paint, so splitting
// it would only add a round trip to the one control that is always there.
import { ClockWidget } from "@/components/ClockWidget";
import { SessionPaymentBell } from "@/components/SessionPaymentBell";

/**
 * The boards, each in its own chunk.
 *
 * These were static imports, and this file is what every signed-in person loads first, so
 * webpack pulled all twenty-two boards -- and everything they reach, ConsultationsBoard
 * and the charts included -- into one file the browser had to have before it could paint
 * anything. A Physio downloaded Finance, HR, Marketing and Zumba to look at their own day.
 *
 * Nothing about how they render changes: every one of them was already behind a `show...`
 * condition, so the import is now fetched on the same event that used to mount an
 * already-downloaded component. The Suspense boundary sits below the header, so switching
 * boards leaves the nav and the role bar on screen rather than blanking the page.
 *
 * Boards that import each other -- Operations reaches four of them, BranchManagement three
 * -- are fine as they are: webpack lifts what they share into a common chunk rather than
 * copying it into each, and none of them is reachable from the login screen either way.
 */
const BusinessLeadsDashboard = lazy(() => import("@/components/BusinessLeadsDashboard").then((m) => ({ default: m.BusinessLeadsDashboard })));
const PreSalesBoard = lazy(() => import("@/components/PreSalesBoard").then((m) => ({ default: m.PreSalesBoard })));
const BranchAdminBoard = lazy(() => import("@/components/BranchAdminBoard").then((m) => ({ default: m.BranchAdminBoard })));
// Two entries against one module, which webpack resolves to one chunk they share -- the
// calendar modal is opened from the header while the board is up, so by then it is loaded.
const HeadPhysioBoard = lazy(() => import("@/components/HeadPhysioBoard").then((m) => ({ default: m.HeadPhysioBoard })));
const HeadPhysioCalendarModal = lazy(() => import("@/components/HeadPhysioBoard").then((m) => ({ default: m.HeadPhysioCalendarModal })));
const PhysioBoard = lazy(() => import("@/components/PhysioBoard").then((m) => ({ default: m.PhysioBoard })));
const PhysioCalendarPage = lazy(() => import("@/components/PhysioBoard").then((m) => ({ default: m.CalendarPage })));
const DietBoard = lazy(() => import("@/components/DietBoard").then((m) => ({ default: m.DietBoard })));
const MarketingBoard = lazy(() => import("@/components/marketing/MarketingBoard").then((m) => ({ default: m.MarketingBoard })));
const PreSalesCRM = lazy(() => import("@/components/PreSalesCRM").then((m) => ({ default: m.PreSalesCRM })));
const DashboardBoard = lazy(() => import("@/components/DashboardBoard").then((m) => ({ default: m.DashboardBoard })));
const PipelineStageManagement = lazy(() => import("@/components/PipelineStageManagement").then((m) => ({ default: m.PipelineStageManagement })));
const PastDataImportExport = lazy(() => import("@/components/pastData/PastDataImportExport").then((m) => ({ default: m.PastDataImportExport })));
const HRBoard = lazy(() => import("@/components/hr/HRBoard").then((m) => ({ default: m.HRBoard })));
const HumanResourceBoard = lazy(() => import("@/components/hr/HumanResourceBoard").then((m) => ({ default: m.HumanResourceBoard })));
const FinanceWiseBoard = lazy(() => import("@/components/branch/FinanceWiseBoard").then((m) => ({ default: m.FinanceWiseBoard })));
const PackagesBoard = lazy(() => import("@/components/PackagesBoard").then((m) => ({ default: m.PackagesBoard })));
const MyConsultationBoard = lazy(() => import("@/components/MyConsultationBoard").then((m) => ({ default: m.MyConsultationBoard })));
const OperationsBoard = lazy(() => import("@/components/OperationsBoard").then((m) => ({ default: m.OperationsBoard })));
const AccountantBoard = lazy(() => import("@/components/finance/AccountantBoard").then((m) => ({ default: m.AccountantBoard })));
const ZumbaMasterBoard = lazy(() => import("@/components/ZumbaMasterBoard").then((m) => ({ default: m.ZumbaMasterBoard })));
const FeedbackBoard = lazy(() => import("@/components/branch/FeedbackBoard").then((m) => ({ default: m.FeedbackBoard })));
// Everybody's own page — their month, and their record. Lazy like the boards it stands in
// for: it is opened from the header a few times a month, and it is the only screen here
// that every single role can reach, so bundling it would put it in front of every first
// paint in the building.
const MyProfilePage = lazy(() => import("@/components/MyProfilePage").then((m) => ({ default: m.MyProfilePage })));
// Time Off on its own, opened from the Physio and Consultant phone headers.
const TimeOffPage = lazy(() => import("@/components/MyTimeOff").then((m) => ({ default: m.TimeOffPage })));

/**
 * What sits under the header while a board's chunk is on the wire.
 *
 * Left quiet on purpose. This page deliberately dropped its old "Loading boards..."
 * banner because each board reports its own loading (see the note at the foot of this
 * file); a chunk arriving is the same kind of wait, and announcing it in words would put
 * back the thing that was removed.
 */
const BoardFallback = () => (
  <div className="flex items-center justify-center py-20" data-testid="board-loading">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-sky-600" />
  </div>
);

const ROLE_META = {
  super_admin: { label: "Super Admin", icon: ShieldCheck },
  // Assignable, but gated on nothing yet: what a Pro may not do has still to be decided,
  // and a permission set guessed at here would be the wrong way round to find out. Until
  // then it reaches no board — see DEFAULT_ROLES in backend/routers/v3_hr.py.
  super_admin_pro: { label: "Super Admin Pro", icon: ShieldCheck },
  business_dev: { label: "Business Development Executive", icon: Briefcase },
  pre_sales: { label: "Pre Sales", icon: Headphones },
  sales_head: { label: "Sales Head", icon: Headphones },
  marketing_head: { label: "Marketing Head", icon: Megaphone },
  branch_admin: { label: "Branch Admin", icon: Building2 },
  online_physio_admin: { label: "Online Physio Admin", icon: Building2 },
  online_fitness_admin: { label: "Online Fitness Admin", icon: Building2 },
  // Retired. The three named the practice a branch sells rather than the arm it works in,
  // and held plain Branch Admin's permissions exactly — migrate_branch_admin_roles in
  // backend/seed.py collapses them onto it. Kept here only so an account the migration has
  // not reached still renders with a name instead of a raw slug.
  branch_admin_physio: { label: "Branch Admin", icon: Building2 },
  branch_admin_fitness: { label: "Branch Admin", icon: Building2 },
  branch_admin_physio_fitness: { label: "Branch Admin", icon: Building2 },
  // The consultation desk, under the names this clinic uses. A designation is a role
  // here, so the titles in HR's structure are minted as roles, and the title for this
  // desk is CONSULTANT. Online Consultant is the same board and the same reach over
  // video — named for the room, not for a different job. See HEAD_PHYSIO_ROLES in
  // backend/deps.py.
  consultant: { label: "Consultant", icon: Stethoscope },
  online_consultant: { label: "Online Consultant", icon: Stethoscope },
  // Retired. No longer assignable — migrate_consultant_roles in backend/seed.py rewrites
  // both to the pair above — and kept here only so an account the migration has not
  // reached still renders with a name instead of a raw slug.
  head_physio: { label: "Consultant", icon: Stethoscope },
  online_head_physio: { label: "Online Consultant", icon: Stethoscope },
  physio: { label: "Physiotherapist", icon: Activity },
  online_physio: { label: "Online Physiotherapist", icon: Activity },
  accountant: { label: "Accountant", icon: BadgeIndianRupee },
  hr_admin: { label: "HR Admin", icon: UserPlus },
  // Retired wording, rewritten by migrate_designation_roles in backend/seed.py. Kept so an
  // account the migration has not reached still renders with a name, not a raw slug.
  human_resource: { label: "HR Admin", icon: UserPlus },
  // Nutritionist names the person; Diet stays the name of the service they run, which
  // is why the Diet Consultation stage, the Diet calendar and the diet fees keep theirs.
  nutritionist: { label: "Nutritionist", icon: Salad },
  zumba: { label: "Zumba", icon: Salad },
  // Retired wordings, same reason as HR Admin above.
  nutrition_coach: { label: "Nutritionist", icon: Salad },
  diet_manage: { label: "Nutritionist", icon: Salad },
};

/** Whether a role slug should land on the recruitment board.
 *
 * The HR role is added by hand in Super Admin -> HR Admin, so its slug is whatever label
 * was typed. Matching the shape of the slug rather than one literal means a different
 * wording ("HR Manager", "Recruiter") still reaches the board instead of falling through
 * to a blank screen. Kept in step with _is_hr_role in backend/routers/v3_recruitment.py —
 * a role that passes here and fails there would render the board and 403 every call.
 */
/** Whether a role slug reads as the Diet vertical.
 *
 * Same reason isHumanResourceRole exists: the role is typed by hand in Roles &
 * Credentials, so its slug is whatever wording was used — this install has "diet_manage",
 * not "nutrition_coach", and that user logged in to a blank page. Kept in step with
 * is_diet_role in backend/deps.py; a role that passes here and fails there would render
 * the board and 403 every call.
 */
const isDietRole = (role) => {
  const r = String(role || "").trim().toLowerCase();
  if (r === "super_admin") return false;
  if (r.includes("nutrition_coach")) return true;
  return r.split("_").some((t) => ["diet", "nutrition", "nutritionist", "dietician", "dietitian"].includes(t));
};

const isHumanResourceRole = (role) => {
  const r = String(role || "").trim().toLowerCase();
  if (r.includes("human_resource")) return true;
  return r.split("_").some((t) => ["hr", "recruiter", "recruitment", "talent"].includes(t));
};

/** Whether a role gets the Branch Admin board.
 *
 * A branch is run by one of these whether it sells physiotherapy, fitness, both, or runs
 * online. The name says which practice the person runs; the job is the same job, so they
 * land on the same board rather than on near-copies of one.
 *
 * Matched exactly, unlike the two predicates above — they match loosely because their
 * roles are typed by hand, and doing that here would catch the plain `physio` role on the
 * "physio" token and open the branch's accounts to a treating physio. Kept in step with
 * BRANCH_ADMIN_ROLES in backend/deps.py: a role that passes here and fails there would
 * render the whole board and 403 every call in it.
 */
const BRANCH_ADMIN_ROLES = [
  "branch_admin",
  "online_physio_admin",
  "online_fitness_admin",
  // Retired and no longer assignable, but still listed. This decides which board renders,
  // and dropping a slug the moment it stops being handed out would blank the board of an
  // account the migration has not reached yet — locking somebody out of their own branch
  // over a rename that was never supposed to change anybody's access. Kept in step with
  // LEGACY_BRANCH_ADMIN_ROLES in backend/deps.py, which keeps them for the same reason.
  "branch_admin_physio",
  "branch_admin_fitness",
  "branch_admin_physio_fitness",
];
const isBranchAdminRole = (role) => BRANCH_ADMIN_ROLES.includes(String(role || "").trim().toLowerCase());

/** Whether a role gets the Physio board.
 *
 * An Online Physio treats over video what a Physio treats on the floor — same patients,
 * sessions, reviews and board — so it lands on the same one rather than a near-copy.
 *
 * Matched exactly for the same reason isBranchAdminRole is: a loose match on the "physio"
 * token would also catch head_physio and drop the CONSULTANT onto a treating physio's
 * board. Kept in step with PHYSIO_ROLES in backend/deps.py — a role that passes here and
 * fails there would render the whole board and 403 every call in it.
 */
const isPhysioRole = (role) => ["physio", "online_physio"].includes(String(role || "").trim().toLowerCase());

/** Whether a role takes consultations — in the room or over video.
 *
 * Matched exactly, like isPhysioRole: every slug is fixed, and a loose match would be
 * wrong twice over — on the "physio" token inside head_physio, which is the confusion
 * those two predicates exist to keep apart, and on the "consultant" token, which
 * sales_consultant would also answer to. Kept in step with HEAD_PHYSIO_ROLES in
 * backend/deps.py: a role that passes there and fails here logs in to no board at all.
 */
const isHeadPhysioRole = (role) =>
  // The last two are retired slugs, listed for the same reason the backend still accepts
  // them: an account migrate_consultant_roles has not reached must still reach its board.
  ["consultant", "online_consultant", "head_physio", "online_head_physio"].includes(
    String(role || "").trim().toLowerCase()
  );

/** Whether a role gets the Pre-Sales board.
 *
 * Sales Head is Pre-Sales' own manager — same board, same leads, just the org-wide
 * Master View instead of one rep's own book (PreSalesCRM itself decides which, off the
 * same role prop). Matched exactly, like isBranchAdminRole and isPhysioRole above. Kept
 * in step with PRE_SALES_ROLES in backend/deps.py — a role that passes here and fails
 * there would render the board and 403 every call in it.
 */
const PRE_SALES_ROLES = ["pre_sales", "sales_head"];
const isPreSalesRole = (role) => PRE_SALES_ROLES.includes(String(role || "").trim().toLowerCase());

/** Whether a role gets the Zumba master's board.
 *
 * Matched loosely, like isDietRole and isHumanResourceRole: this role is typed by hand in
 * Roles & Credentials, so the slug is whatever wording was used — this install has
 * "zumba", and a "Zumba Master" typed tomorrow would be "zumba_master". Matched on whole
 * underscore-separated tokens so an unrelated role cannot slip through on a substring.
 *
 * Kept in step with is_zumba_role in backend/deps.py, except for Super Admin: they reach
 * the class roll through their own board, so sending them here instead would take the
 * whole of Super Admin away. */
const isZumbaRole = (role) => {
  const r = String(role || "").trim().toLowerCase();
  if (r === "super_admin") return false;
  return r.split("_").includes("zumba");
};

/** A role slug read back as a title: "zumba" -> "Zumba", "zumba_master" -> "Zumba Master".
 *
 * The last resort for a role nothing else names. A slug is stored the way it is typed and
 * printed the way it is stored, so a role created as "Zumba" put "zumba Master View" in
 * the header -- the one board title on the app starting in lower case. */
const titleFromSlug = (role) => String(role || "")
  .split("_")
  .filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(" ");

// Same destinations as the desktop tab strip below. On a phone, three get a direct
// bottom-nav slot each; the rest sit behind a "More" sheet — both derived from this one
// array so the two surfaces can't drift out of sync.
// Dashboard is the default landing view. Master View was retired from here — the
// Dashboard now carries the same headline counts, per branch and per date range.
// Branches & Verticals and Branch Wise were retired from the nav — Operations' own
// Branch tab already reaches the same BranchAdminBoard per branch, its "Branch Manager"
// dialog already reaches Branches & Verticals' old MANAGER (branch creation / admin
// credentials), and Dashboard already carries the headline metrics Overview/Analytics
// used to show. Nothing behind either tab was otherwise unique.
const SUPER_ADMIN_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  // Every team, one designation at a time — Pre Sales/Branch/Consultant/Physio/
  // Nutritionist/Client each reached the way Branch Control used to reach a branch's
  // own board, generalised past just branches and physios.
  { key: "operations", label: "Operations", icon: Workflow },
  // Same board Marketing Head's own login sees (role is hardcoded to "marketing_head" on
  // the mount below, not read from the signed-in Super Admin) — a way to look at that
  // funnel without logging in as that role.
  { key: "marketing_master", label: "Marketing Master View", icon: Megaphone },
  { key: "presales", label: "Sales Master View", icon: Headphones },
  { key: "finance", label: "Finance", icon: BadgeIndianRupee },
  { key: "hr", label: "HR Admin", icon: Users },
  // Treatment moved inside Services and Products (as its own sub-tab, next to Vending
  // Machine) rather than sitting here as a peer of the catalogue that holds it.
  { key: "packages", label: "Services and Products", icon: Store },
  // Marketing Source and CI/CD ROOTS live inside here now, as its own sub-tab pair — two
  // configuration screens, not two peers of Dashboard/HR/Pre-Sales on the main strip.
  { key: "settings", label: "Settings", icon: Settings },
  // Last, because it is the only tab here that is about the signed-in person rather than
  // about the organisation — everything to its left is a view over somebody else's work.
  { key: "my_consultation", label: "My Consultation", icon: Stethoscope },
];

// Marketing Source and CI/CD ROOTS still resolve through the same superAdminView values
// they always did ("marketing"/"stages") — Settings is a second name for that pair of
// states, not a third state of its own, so PreSalesCRM's "Manage Stages" jump
// (setSuperAdminView("stages")) keeps working without knowing Settings exists.
// Import/Export is Past Data's sheets (PastDataImportExport), reachable here without
// opening the Past Data Entry branch board.
const SETTINGS_SUB_VIEWS = ["marketing", "stages", "import_export"];
const SETTINGS_SUB_TABS = [
  { key: "marketing", label: "Marketing Source", icon: Megaphone },
  { key: "stages", label: "Workflow Roots", icon: Activity },
  { key: "import_export", label: "Import/Export", icon: ArrowDownUp },
];
const isSuperAdminTabActive = (view, key) => (key === "settings" ? SETTINGS_SUB_VIEWS.includes(view) : view === key);

/**
 * Which Super Admin page is open outlives a refresh.
 *
 * Reloading in the middle of HR Admin or Finance used to land back on Dashboard, which
 * reads as the app forgetting where you were rather than as a reload of the page you were
 * on. Kept per browser rather than in the URL: this board is one route, and pushing a
 * query string for every tab would fill the back button with tab switches.
 *
 * "settings" is never a stored value — it is a second name for the marketing/stages pair,
 * not a state of its own — so the valid list is every other tab key plus those two.
 */
const SUPER_ADMIN_VIEW_STORAGE_KEY = "fitsiomax.super_admin_view";
const SUPER_ADMIN_VIEWS = [
  ...SUPER_ADMIN_TABS.map((t) => t.key).filter((k) => k !== "settings"),
  ...SETTINGS_SUB_VIEWS,
];
// Storage throws outright in private mode and where site data is blocked, and a stored
// view that no longer exists (a tab renamed since the last visit) has to fall through to
// the default rather than render an empty board.
const readStoredSuperAdminView = () => {
  try {
    const stored = window.localStorage.getItem(SUPER_ADMIN_VIEW_STORAGE_KEY);
    return SUPER_ADMIN_VIEWS.includes(stored) ? stored : null;
  } catch {
    return null;
  }
};
const writeStoredSuperAdminView = (view) => {
  try {
    window.localStorage.setItem(SUPER_ADMIN_VIEW_STORAGE_KEY, view);
  } catch {
    // The board still works; it just will not remember on the next reload.
  }
};
const forgetStoredSuperAdminView = () => {
  try {
    window.localStorage.removeItem(SUPER_ADMIN_VIEW_STORAGE_KEY);
  } catch {
    // As above.
  }
};

const SUPER_ADMIN_BOTTOM_KEYS = ["dashboard", "operations", "hr"];
const SUPER_ADMIN_BOTTOM_TABS = SUPER_ADMIN_TABS.filter((t) => SUPER_ADMIN_BOTTOM_KEYS.includes(t.key));
// Everything not on the bar, with nothing held back. CI/CD ROOTS used to be excluded here
// because Pre-Sales reaches it through its own Manage Stages button — but it is a peer tab
// on the desktop strip, and leaving it out was the one destination a phone could not reach.
const SUPER_ADMIN_MORE_TABS = SUPER_ADMIN_TABS.filter((t) => !SUPER_ADMIN_BOTTOM_KEYS.includes(t.key));


const defaultLead = {
  name: "",
  phone: "",
  email: "",
  vertical: "offline_physiotherapy",
  source_tab: "Manual",
  notes: "",
};

const defaultBranch = {
  branch_name: "",
  address: "",
  admin_name: "",
  admin_email: "",
  admin_password: "",
  admin_phone: "",
  vertical: "offline_physiotherapy",
};

const defaultDoctor = {
  full_name: "",
  profile_type: "physio",
  branch_id: "",
  specialization: "",
};

const defaultSheetConnection = {
  connection_name: "",
  spreadsheet_id: "",
  sync_interval_minutes: 30,
};

const defaultMapping = {
  name: "name",
  phone: "phone",
  email: "email",
  vertical: "vertical",
};

const defaultSyncPayload = `{
  "tabs": [
    {
      "tab_name": "Instagram",
      "rows": [
        {
          "name": "Priya",
          "phone": "9000010001",
          "email": "priya@example.com",
          "vertical": "offline_physiotherapy",
          "campaign": "meta_1"
        }
      ]
    }
  ]
}`;

const LOGO_URL =
  "https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707/artifacts/nozl77ti_Logo%20Icon.webp";

export const CRMPage = ({ auth, onLogout }) => {
  const [masterBoard, setMasterBoard] = useState({ stage_counts: {}, total: 0 });
  const [branchMaster, setBranchMaster] = useState({ branch_stage_counts: {}, total: 0 });
  const [branchBoard, setBranchBoard] = useState({ stage_counts: {} });
  const [verticals, setVerticals] = useState([]);
  const [branches, setBranches] = useState([]);
  const [leads, setLeads] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [sheetConnections, setSheetConnections] = useState([]);

  const [leadForm, setLeadForm] = useState(defaultLead);
  const [branchForm, setBranchForm] = useState(defaultBranch);
  const [doctorForm, setDoctorForm] = useState(defaultDoctor);
  const [verticalName, setVerticalName] = useState("");
  const [slotDoctorId, setSlotDoctorId] = useState("");
  const [slotTime, setSlotTime] = useState("");

  const [assignBranchSelection, setAssignBranchSelection] = useState({});
  const [selectedLeadForBooking, setSelectedLeadForBooking] = useState("");
  const [bookingTime, setBookingTime] = useState("");
  const [availableDoctors, setAvailableDoctors] = useState([]);
  const [selectedDoctorForBooking, setSelectedDoctorForBooking] = useState("");

  const [sheetConnectionForm, setSheetConnectionForm] = useState(defaultSheetConnection);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [mappingFields, setMappingFields] = useState(defaultMapping);
  const [syncPayload, setSyncPayload] = useState(defaultSyncPayload);

  const [leadStageFilter, setLeadStageFilter] = useState("");
  const [leadBranchFilter, setLeadBranchFilter] = useState("");
  const [leadDateFrom, setLeadDateFrom] = useState("");
  const [leadDateTo, setLeadDateTo] = useState("");
  const [appointmentFilter, setAppointmentFilter] = useState("all");

  const [customFieldName, setCustomFieldName] = useState("");
  const [customFieldType, setCustomFieldType] = useState("text");
  const [customFieldOptions, setCustomFieldOptions] = useState("");
  const [customFieldDefs, setCustomFieldDefs] = useState([]);

  const [editingLeadId, setEditingLeadId] = useState("");
  const [leadEditForm, setLeadEditForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    extra_fields: {},
  });

  const [showProfile, setShowProfile] = useState(false);
  const [showPhysioCalendar, setShowPhysioCalendar] = useState(false);
  const [showHPCalendar, setShowHPCalendar] = useState(false);
  const [showTimeOff, setShowTimeOff] = useState(false);
  // The Consultant board's search text. The box itself is the board's: the left rail on a
  // desk, the tool bar's magnifier on a phone. It used to open from a header button on a
  // phone, which moved into the board's tool bar with Search / Date Filter / Refresh.
  const [hpSearch, setHpSearch] = useState("");
  const [showSuperAdminMenu, setShowSuperAdminMenu] = useState(false);

  const role = auth.user.role;
  // A hand-created HR role can carry any slug, so fall back to the board's own name
  // rather than printing "hr_manager Master View" in the header.
  // A hand-created role's slug is not a title — "diet_manage Master View" is what the
  // raw value gives. Named roles come from ROLE_META; the two families that accept
  // arbitrary wording are named by what they are.
  const roleLabel = ROLE_META[role]?.label
    || (isDietRole(role) ? "Nutritionist" : null)
    || (isHumanResourceRole(role) ? "Human Resource" : titleFromSlug(role));
  // Consultant, Nutritionist, Branch Admin and the Business Development desk stand alone,
  // with no "Master View" after them. The first two are named for the clinician rather
  // than for a desk that administers something, so the suffix was describing a view they
  // do not have. Branch Admin does run a desk, but one branch of it — "Master View"
  // claims a reach across the organisation that the role does not have, and the plain
  // name is what the person is. Business Development Executive is already the full name
  // of the desk, and its board now carries the Marketing and Sales master views as two
  // tabs inside it — a title claiming one master view over the lot would name the
  // smaller part of what is on screen. Physiotherapist is named for the clinician, the
  // same as Consultant. Accountant is named for the person too, asked for on 2026-09-28.
  //
  // All of them are printed as they are written — a board title in full caps reads as
  // shouting where every other board is sentence case.
  const isPlainTitle = isHeadPhysioRole(role) || isPhysioRole(role) || isDietRole(role) || isBranchAdminRole(role) || role === "business_dev" || role === "accountant";
  const boardTitle = isPlainTitle
    ? roleLabel
    // Sales Head gets the same title as Pre-Sales, not "Sales Head Master View" — it's the
    // same board (PreSalesCRM, full Master View) under a second role, not a board of its own.
    // Plain "Sales" since 2026-09-29, asked for by name.
    : isPreSalesRole(role) ? "Sales" : `${roleLabel} Master View`;
  const myBranch = branches.find((b) => b.id === auth.user.branch_id);
  const myBranchName = myBranch?.branch_name || "";
  const VERTICAL_LABELS = { offline_physiotherapy: "Physiotherapy", offline_fitness_gym: "Fitness", offline_fitness: "Fitness" };
  const myVerticalLabel = VERTICAL_LABELS[myBranch?.vertical] || "";

  // Leads / Analytics in the page header, for Sales Head and nobody else.
  //
  // Super Admin and Marketing Head reach the same two pages from the strip inside the
  // board — they arrive with a nav bar already above them, and a second row of tabs in
  // the header would be two strips answering the same question. Pre-Sales never sees the
  // pages at all: the pane switch lives behind isSuperAdminMasterView, which that role is
  // not. So the header only carries them where the whole page is this board and there is
  // no nav above it.
  const [presalesView, setPresalesView] = useState("leads");
  // BDE's board tab, held here so the phone footer can switch it.
  const [bdTab, setBdTab] = useState("dashboard");
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackUnread, setFeedbackUnread] = useState(0);

  const [superAdminView, setSuperAdminView] = useState(() => {
    if (typeof window === "undefined") return "dashboard";
    // Google's OAuth callback returns with this flag and expects Marketing Source on
    // screen, so it wins over whichever page was open when the redirect started.
    if (new URLSearchParams(window.location.search).get("sheets_connect")) {
      return "marketing";
    }
    return readStoredSuperAdminView() || "dashboard";
  });

  // Written on every change rather than on unload, so a refresh, a crash and a closed tab
  // all reopen on the page that was actually last on screen.
  useEffect(() => { writeStoredSuperAdminView(superAdminView); }, [superAdminView]);

  const safeCall = async (fn, fallback) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  /**
   * The branch list, and nothing else.
   *
   * This used to fetch eight endpoints on every login — the master board, the branch
   * master board, every lead, every doctor, every appointment, the verticals, the sheet
   * connections and a branch board — from the days when this page rendered the boards
   * itself. Every board now loads its own data, and all eight results were being thrown
   * away: masterBoard, branchMaster, branchBoard, doctors, verticals and sheetConnections
   * were set and never read, appointments fed a variable nothing used, and leads was read
   * only by two legacy dialogs whose state is never set.
   *
   * So the page opened by making eight requests it discarded, several of which 403 for a
   * CONSULTANT or a Physio, and held "Loading boards..." on screen until the slowest of
   * them came back. Branches is the one that is genuinely used: the branch name beside the
   * role in the header, and the two Super Admin boards that take it as a prop.
   *
   * Nothing reports progress for it. The indicator that used to sit bottom-right spoke
   * for the eight-endpoint version; each board now shows its own loading, and a toast for
   * one branch list is reporting work nobody is waiting on.
   */
  const loadEverything = async () => {
    setBranches(await safeCall(() => getBranches(), []));
  };

  useEffect(() => {
    loadEverything();
  }, []);

  useEffect(() => {
    if (!editingLeadId) {
      return;
    }
    const selected = leads.find((lead) => lead.id === editingLeadId);
    if (!selected) {
      return;
    }
    setLeadEditForm({
      name: selected.name || "",
      phone: selected.phone || "",
      email: selected.email || "",
      notes: selected.notes || "",
      extra_fields: selected.extra_fields || {},
    });
  }, [editingLeadId, leads]);

  const logout = async () => {
    try {
      await apiLogout();
    } catch {
      // no-op
    }
    // Signing out ends the trail: the next person to sign in on this browser opens on
    // Dashboard rather than on the page the last one was reading.
    forgetStoredSuperAdminView();
    onLogout();
  };

  const createLeadNow = async (event) => {
    event.preventDefault();
    try {
      await createManualLead({ ...leadForm, source_type: "manual" });
      setLeadForm(defaultLead);
      toast.success("Lead created");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Lead create failed");
    }
  };

  const createBranchNow = async (event) => {
    event.preventDefault();
    try {
      await createBranch(branchForm);
      setBranchForm(defaultBranch);
      toast.success("Branch and branch admin created");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Branch create failed");
    }
  };

  const createDoctorNow = async (event) => {
    event.preventDefault();
    try {
      await createDoctor({ ...doctorForm, branch_id: doctorForm.branch_id || null });
      setDoctorForm(defaultDoctor);
      toast.success("Doctor profile created");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Doctor create failed");
    }
  };

  const addSlotNow = async (event) => {
    event.preventDefault();
    try {
      await addDoctorSlots(slotDoctorId, { slots: [slotTime] });
      setSlotTime("");
      toast.success("Slot added");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Slot add failed");
    }
  };

  const addVerticalNow = async (event) => {
    event.preventDefault();
    if (!verticalName.trim()) {
      toast.error("Vertical name required");
      return;
    }
    try {
      await createVertical({ name: verticalName.trim(), active: true });
      setVerticalName("");
      toast.success("Vertical created");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Vertical create failed");
    }
  };

  const qualifyNow = async (leadId) => {
    try {
      await qualifyLead(leadId);
      toast.success("Lead qualified");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Qualify failed");
    }
  };

  const assignBranchNow = async (leadId) => {
    const branchId = assignBranchSelection[leadId];
    if (!branchId) {
      toast.error("Select branch first");
      return;
    }
    try {
      await assignLeadBranch(leadId, { branch_id: branchId });
      toast.success("Assigned to branch");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Assign failed");
    }
  };

  const confirmNow = async (leadId) => {
    try {
      await confirmLead(leadId);
      toast.success("Branch confirmed lead");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Confirm failed");
    }
  };

  const checkDoctorsNow = async () => {
    const lead = leads.find((item) => item.id === selectedLeadForBooking);
    const branchId = lead?.branch_id || auth.user.branch_id;
    if (!branchId || !bookingTime) {
      toast.error("Pick lead and booking time");
      return;
    }
    try {
      const result = await getAvailableDoctors({ branch_id: branchId, slot_time: bookingTime });
      setAvailableDoctors(result.available_doctors || []);
      if (!(result.available_doctors || []).length) {
        toast.error("No doctors available at selected slot");
      }
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Availability check failed");
    }
  };

  const bookNow = async () => {
    if (!selectedLeadForBooking || !selectedDoctorForBooking || !bookingTime) {
      toast.error("Lead, slot and doctor required");
      return;
    }
    try {
      await bookLeadAppointment(selectedLeadForBooking, {
        doctor_id: selectedDoctorForBooking,
        slot_time: bookingTime,
      });
      toast.success("Appointment booked");
      setSelectedLeadForBooking("");
      setBookingTime("");
      setSelectedDoctorForBooking("");
      setAvailableDoctors([]);
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Booking failed");
    }
  };

  const completeNow = async (appointmentId) => {
    try {
      await completeAppointment(appointmentId);
      toast.success("Appointment completed");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Complete failed");
    }
  };

  const createSheetConnectionNow = async (event) => {
    event.preventDefault();
    try {
      await createSheetConnection(sheetConnectionForm);
      setSheetConnectionForm(defaultSheetConnection);
      toast.success("Sheet connection created");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Sheet connection failed");
    }
  };

  const saveMappingNow = async () => {
    if (!selectedConnectionId) {
      toast.error("Select a sheet connection first");
      return;
    }
    try {
      await saveSheetMapping(selectedConnectionId, {
        field_map: mappingFields,
        create_new_fields: true,
      });
      toast.success("Mapping saved");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Save mapping failed");
    }
  };

  const runSyncNow = async () => {
    if (!selectedConnectionId) {
      toast.error("Select a sheet connection first");
      return;
    }
    try {
      const parsed = JSON.parse(syncPayload);
      await syncSheetConnection(selectedConnectionId, parsed);
      toast.success("Sheet sync complete");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Sync failed: verify JSON");
    }
  };

  const addCustomFieldDef = () => {
    const cleanName = customFieldName.trim();
    if (!cleanName) {
      toast.error("Custom field name required");
      return;
    }
    if (customFieldDefs.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
      toast.error("Custom field already exists");
      return;
    }

    setCustomFieldDefs((prev) => [
      ...prev,
      {
        name: cleanName,
        type: customFieldType,
        options:
          customFieldType === "select"
            ? customFieldOptions
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : [],
      },
    ]);
    setCustomFieldName("");
    setCustomFieldOptions("");
    toast.success("Custom field added");
  };

  const saveLeadEdit = async () => {
    if (!editingLeadId) {
      toast.error("Select lead to edit");
      return;
    }
    try {
      await updateLead(editingLeadId, {
        name: leadEditForm.name,
        phone: leadEditForm.phone,
        email: leadEditForm.email,
        notes: leadEditForm.notes,
        extra_fields: leadEditForm.extra_fields,
      });
      toast.success("Lead updated");
      await loadEverything();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Lead update failed");
    }
  };

  const showSuperAdminBoard = role === "super_admin";
  // Who /branch/feedback answers for. A branch reads its own patients' feedback; head
  // office reads that and its own. Anyone else has no board behind the bell.
  // A consultant now has post of their own -- what their patients wrote to them, and
  // nothing else. The endpoint scopes it from their login, so the same bell and the same
  // board serve all three without any of them seeing another's.
  const canReadFeedback = showSuperAdminBoard || isBranchAdminRole(role) || isHeadPhysioRole(role);
  const showBusinessDevBoard = role === "business_dev";
  const showPreSalesBoard = isPreSalesRole(role);
  // Its own flag rather than folded into isPreSalesRole/PRE_SALES_ROLES — it mounts the
  // same PreSalesCRM board (Master View, same as Sales Head), but the header should read
  // "Marketing Head", not "Pre Sales".
  const showMarketingHeadBoard = role === "marketing_head";
  const showBranchBoard = isBranchAdminRole(role);
  const showHeadPhysioBoard = isHeadPhysioRole(role);
  const showPhysioBoard = isPhysioRole(role);
  const showDietBoard = isDietRole(role);
  const showAccountantBoard = role === "accountant";
  const showZumbaBoard = isZumbaRole(role);
  // Clients whose paid treatment sessions have run out with a balance owing: Branch Admin,
  // Super Admin, the BDE and the Accountant only.
  const canSeeSessionPayments = showSuperAdminBoard || showBranchBoard || showBusinessDevBoard || showAccountantBoard;

  // What patients have sent past their branch, waiting to be read. Asked once when the
  // board opens rather than polled: feedback arrives at the pace people write it, and a
  // request every half minute to learn that nothing changed is paid for all day.
  //
  // For everyone the bell is shown to. A Branch Admin is scoped to their own branch, which
  // the backend does from their login anyway — passed here so the count and the board that
  // opens behind it are asking the same question.
  useEffect(() => {
    if (!canReadFeedback) return undefined;
    let live = true;
    listBranchFeedback(isBranchAdminRole(role) ? auth?.user?.branch_id : undefined)
      .then((data) => { if (live) setFeedbackUnread(data?.unread || 0); })
      .catch(() => { /* the bell carries no count; the board says why when opened */ });
    return () => { live = false; };
  }, [canReadFeedback, role, auth?.user?.branch_id]);
  const showHumanResourceBoard = isHumanResourceRole(role);

  // Phones: who reaches My Profile from their bottom bar rather than the header, and whose
  // Logout lives on My Profile's Security tab rather than in the header. BDE and Accountant
  // have no bottom bar, so they keep the header avatar and lose only the logout beside it.
  // A Consultant's bar is sm:hidden where the others are md:hidden, hence two breakpoints.
  // The boards with no bar of their own get this page's phone footer (see phoneFooter below).
  const showSalesHeadBoard = role === "sales_head";
  const genericFooter = showBusinessDevBoard || showAccountantBoard || showSalesHeadBoard || showMarketingHeadBoard || showZumbaBoard;
  const profileInFooter = showSuperAdminBoard || showHumanResourceBoard || showHeadPhysioBoard || showDietBoard || genericFooter;
  const logoutInProfile = profileInFooter || showPhysioBoard || showBranchBoard;
  const profileInFooterClass = !profileInFooter ? "flex" : showHeadPhysioBoard ? "hidden sm:flex" : "hidden md:flex";
  const logoutInProfileClass = !logoutInProfile ? "" : showHeadPhysioBoard ? "hidden sm:inline-flex" : "hidden md:inline-flex";

  // The phone footer for boards that have none of their own, in Super Admin's shape: a few
  // direct stops, a More sheet where there are more, and My Profile last. Every stop closes
  // My Profile on the way, the same as Super Admin's bar.
  const bdStop = (key, label, icon) => ({
    key, label, icon,
    active: key === "settings" ? ["marketing", "stages"].includes(bdTab) : bdTab === key,
    onSelect: () => setBdTab(key === "settings" ? "marketing" : key),
  });
  const onlyStop = (key, label, icon) => ({ key, label, icon, active: true, onSelect: () => {} });
  const phoneFooter = !genericFooter ? null
    : showBusinessDevBoard ? {
      // Mirrors BusinessLeadsDashboard's TABS; that module is lazy, so it is not imported here.
      stops: [bdStop("dashboard", "Dashboard", BarChart3), bdStop("marketing_view", "Marketing View", Megaphone), bdStop("sales_view", "Sales View", Headphones)],
      more: [
        bdStop("finance", "Finance", BadgeIndianRupee),
        bdStop("hr", "HR Admin", Users),
        bdStop("packages", "Services and Products", Store),
        bdStop("branch_control", "Branch Control", LayoutDashboard),
        bdStop("settings", "Settings", Settings),
      ],
    }
    : showSalesHeadBoard ? {
      stops: [
        { key: "leads", label: "Leads", icon: Users, active: presalesView === "leads", onSelect: () => setPresalesView("leads") },
        { key: "analytics", label: "Analytics", icon: BarChart3, active: presalesView === "analytics", onSelect: () => setPresalesView("analytics") },
      ],
      more: [],
    }
    : {
      stops: [
        showAccountantBoard ? onlyStop("finance", "Finance", BadgeIndianRupee)
          : showMarketingHeadBoard ? onlyStop("marketing", "Marketing", Megaphone)
            : onlyStop("zumba", "Zumba", LayoutDashboard),
      ],
      more: [],
    };

  const filteredAppointmentsForPhysioBoards = appointments;

  // Settings' Marketing Source / CI/CD ROOTS switcher. Not a row of its own: each screen
  // places it in its own top bar -- left of Marketing Source's sub-tabs, left of CI/CD
  // ROOTS' Add Stage -- so Settings opens on one row of controls rather than two.
  const settingsSubTabs = (
    <div className="flex flex-wrap gap-2" data-testid="settings-subtabs">
      {SETTINGS_SUB_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setSuperAdminView(t.key)}
          data-testid={`settings-subtab-${t.key}`}
          className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${superAdminView === t.key ? "bg-sky-600 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}
        >
          <t.icon className="h-4 w-4" />
          {t.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50" data-testid="role-board-page">
      <Toaster richColors position="top-right" />

      <div className="w-full" data-testid="role-board-full-width-wrap">
        <header className="sticky top-0 z-20 w-full border-b border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-6 sm:py-4" data-testid="role-board-header">
          {/* Physio, mobile only: name + FitsiomaxOS subline on the left, Calendar /
              Profile / Logout icons on the right — replaces the desktop header below,
              which stays exactly as-is for every other role and at sm:+ for physio. */}
          {showPhysioBoard && (
            <div className="flex items-center justify-between gap-2 sm:hidden" data-testid="physio-mobile-header">
              <div className="flex min-w-0 items-center gap-2">
                <img src={LOGO_URL} alt="Fitsiomax" className="h-9 w-9 shrink-0 rounded-lg object-contain" data-testid="header-left-logo-mobile" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900" data-testid="physio-mobile-header-name">{auth.user.full_name}</p>
                  <p className="truncate text-[10px] font-semibold tracking-wide text-sky-600" data-testid="physio-mobile-header-brand">
                    {myBranchName}{myVerticalLabel && ` ${myVerticalLabel}`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ClockWidget />
                <button type="button" onClick={() => setShowPhysioCalendar(true)} className="rounded-md p-2 text-slate-500 hover:bg-slate-50" data-testid="physio-mobile-header-calendar">
                  <CalendarDays className="h-5 w-5" />
                </button>
                {/* Time Off up here rather than as a row of the Profile menu: asking for a
                    day off is a thing done from wherever the physio is, not a setting. */}
                <button type="button" onClick={() => setShowTimeOff(true)} className="rounded-md p-2 text-slate-500 hover:bg-slate-50" aria-label="Time Off" title="Time Off" data-testid="physio-mobile-header-timeoff">
                  <CalendarOff className="h-5 w-5" />
                </button>
                {/* No profile or logout here: the bottom bar's Profile opens My Profile, and
                    Logout sits on its Security tab. */}
              </div>
            </div>
          )}
          {/* Branch Admin, mobile only — same trade the Physio header makes above, for the
              same reason. "Branch Admin" is the one thing the person holding the phone
              already knows; who they are signed in as and which branch they are signed in
              to is what they cannot see, and on a shared handset it is the answer that
              decides whether the next tap goes on the right branch's lead.

              The right-hand cluster is the four controls that do something from here —
              clock, money, post, account — and nothing else. Logout used to sit beside
              them as a fifth icon; it now lives under the avatar, where an account action
              belongs, which also buys the two lines on the left the width to be read. */}
          {showBranchBoard && (
            <div className="flex items-center justify-between gap-2 sm:hidden" data-testid="branch-mobile-header">
              <div className="flex min-w-0 items-center gap-2">
                <img src={LOGO_URL} alt="Fitsiomax" className="h-9 w-9 shrink-0 rounded-lg object-contain" data-testid="branch-mobile-header-logo" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900" data-testid="branch-mobile-header-name">{auth.user.full_name}</p>
                  {/* The branch, or the role where there is no branch to name — an org-level
                      account mounting this board would otherwise get a blank second line. */}
                  <p className="truncate text-[10px] font-semibold tracking-wide text-sky-600" data-testid="branch-mobile-header-branch">
                    {myBranchName || roleLabel}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ClockWidget />
                {/* Clients whose sessions have run out owing money. canDecide, because a
                    Branch Admin is one of the two roles that can act on it — the same
                    prop the desktop header hands it below. */}
                {canSeeSessionPayments && <SessionPaymentBell canDecide />}
                {canReadFeedback && (
                  <button
                    type="button"
                    onClick={() => setShowFeedback(true)}
                    className="relative shrink-0 rounded-md p-2 text-slate-500 transition hover:bg-amber-50 hover:text-amber-600"
                    aria-label={feedbackUnread > 0 ? `${feedbackUnread} new client feedback` : "Client feedback"}
                    data-testid="branch-mobile-header-feedback"
                  >
                    <Bell className="h-5 w-5" />
                    {feedbackUnread > 0 && (
                      <span
                        className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white"
                        data-testid="branch-mobile-header-feedback-count"
                      >
                        {feedbackUnread > 99 ? "99+" : feedbackUnread}
                      </span>
                    )}
                  </button>
                )}
                {/* No account menu: the bottom bar's Profile opens My Profile, and Logout
                    sits on its Security tab. */}
              </div>
            </div>
          )}
          {/* Stood down below sm wherever one of the phone headers above has taken over,
              so the two can never both be on screen. */}
          <div className={`flex flex-wrap items-center justify-between gap-2 ${showPhysioBoard || showBranchBoard ? "hidden sm:flex" : ""}`}>
            <div className="flex min-w-0 items-center gap-2 sm:gap-4">
              <img src={LOGO_URL} alt="Fitsiomax" className="h-9 w-9 shrink-0 rounded-lg object-contain sm:h-14 sm:w-14" data-testid="header-left-logo" />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold tracking-wide text-sky-600 sm:text-xs" data-testid="role-board-brand-subtitle">
                  FitsiomaxOS
                </p>
                {/* On a phone the board title costs a whole line to say something the user
                    already knows, so these two boards show who is signed in instead. The
                    desktop header is untouched. */}
                <h1 className="truncate text-base font-bold text-slate-900 sm:text-2xl" data-testid="role-board-title">
                  {/* On a phone the board title is the least useful thing that could sit
                      here: whoever is holding it already knows which board they opened,
                      and what they cannot see is which account they are signed in as —
                      the desktop shows that in the corner, and a phone has no corner to
                      spare. Pre-Sales joins Head Physio and HR in trading one for the
                      other below sm. */}
                  {showHeadPhysioBoard || showHumanResourceBoard || showPreSalesBoard || showMarketingHeadBoard ? (
                    <>
                      <span className="sm:hidden">{auth.user.full_name}</span>
                      <span className="hidden sm:inline">{boardTitle}</span>
                    </>
                  ) : boardTitle}
                </h1>
              </div>
              {/* Sales Head only — see the note on presalesView. The board stands its own
                  strip down only when it is handed the pair of props below, so the two can
                  never sit on screen disagreeing about which page is open. */}
              {role === "sales_head" && (
                <div className="hidden shrink-0 items-center gap-1 sm:ml-4 md:flex" data-testid="header-presales-view-tabs">
                  {[
                    { key: "leads", label: "Leads", icon: Users },
                    { key: "analytics", label: "Analytics", icon: BarChart3 },
                  ].map((t) => {
                    const Icon = t.icon;
                    const active = presalesView === t.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => { setShowProfile(false); setPresalesView(t.key); }}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition sm:px-3 sm:py-2 ${
                          active ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100"
                        }`}
                        data-testid={`header-presales-view-${t.key}`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {/* The label goes on a phone, where the header is already carrying
                            a name and a logout — the icons still say which is which. */}
                        <span className="hidden sm:inline">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              {/* First in the cluster, and before the bell: the clock is the only control
                  here that is about the person rather than about their work, and it is the
                  one they press twice a day whatever board they are on. */}
              <ClockWidget />
              {/* A Head Physio's own calendar sits beside their profile rather than in the
                  board's tab row — it's a reference, not one of the lists they work. */}
              {showHeadPhysioBoard && (
                <button
                  type="button"
                  onClick={() => setShowHPCalendar(true)}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-[2px] border border-slate-200 px-2 text-xs font-medium text-slate-600 shadow-[0_1px_3px_0_rgb(0_0_0/0.055),0_1px_2px_-1px_rgb(0_0_0/0.055)] transition-colors hover:bg-slate-50 sm:h-11 sm:px-3"
                  data-testid="hp-header-calendar-button"
                >
                  <CalendarDays className="h-4 w-4" />
                  <span className="hidden sm:inline">Calendar</span>
                </button>
              )}
              {/* Time Off on a phone, for the two boards that carry it here instead of in
                  the Profile menu (see timeOffInHeader on MyProfilePage). Below sm the
                  Physio has its own header above, so this one is theirs from sm to md. */}
              {(showHeadPhysioBoard || showPhysioBoard) && (
                <button
                  type="button"
                  onClick={() => setShowTimeOff(true)}
                  className={`${showHeadPhysioBoard ? "inline-flex" : "hidden sm:inline-flex"} h-8 shrink-0 items-center justify-center rounded-[2px] border border-slate-200 px-2 text-slate-600 shadow-[0_1px_3px_0_rgb(0_0_0/0.055),0_1px_2px_-1px_rgb(0_0_0/0.055)] transition-colors hover:bg-slate-50 sm:h-11 sm:px-3 md:hidden`}
                  aria-label="Time Off"
                  title="Time Off"
                  data-testid="header-timeoff-button"
                >
                  <CalendarOff className="h-4 w-4" />
                </button>
              )}
              {/* One bell, one place, for everyone who has post to read. It used to sit in
                  the header for Super Admin and down inside the tab strip on the Branch
                  Admin board, so the same thing lived in two places and only one of them
                  was where a person looks for it.

                  Only the roles the endpoint answers for: a bell shown to a physio would
                  count nothing and open a 403. */}
              {canSeeSessionPayments && <SessionPaymentBell canDecide={showSuperAdminBoard || showBranchBoard} mobilePage={showSuperAdminBoard} />}
              {canReadFeedback && (
                <button
                  type="button"
                  onClick={() => setShowFeedback(true)}
                  className="relative shrink-0 rounded-md p-2 text-slate-400 transition hover:bg-amber-50 hover:text-amber-600"
                  title={feedbackUnread > 0 ? `${feedbackUnread} new client feedback` : "Client feedback"}
                  aria-label={feedbackUnread > 0 ? `${feedbackUnread} new client feedback` : "Client feedback"}
                  data-testid="super-admin-feedback-bell"
                >
                  <Bell className="h-4 w-4" />
                  {feedbackUnread > 0 && (
                    <span
                      className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white"
                      data-testid="super-admin-feedback-count"
                    >
                      {feedbackUnread > 99 ? "99+" : feedbackUnread}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowProfile(true)}
                // Super Admin's phone reaches My Profile (and Logout, inside it) from the
                // bottom bar, so the header drops both below md.
                className={`${profileInFooterClass} items-center gap-2 rounded-[2px] bg-white px-1.5 py-1 text-left transition hover:bg-slate-50 sm:h-11 sm:gap-2.5 sm:px-3 sm:py-1.5`}
                data-testid="role-board-profile-button"
              >
                {/* Whoever is signed in, by their own face. The same component the HR
                    directory draws with, so the picture HR uploaded when they were taken
                    on is the picture here, and a missing file falls back to their initial
                    rather than a broken image. */}
                <EmployeeAvatar employee={auth.user} size={32} className="hidden sm:flex" />
                <EmployeeAvatar employee={auth.user} size={28} className="flex sm:hidden" />
                <span className="hidden sm:block">
                  <span className="block text-sm font-semibold leading-tight text-slate-900" data-testid="role-board-user-greeting">
                    {auth.user.full_name}
                  </span>
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400" data-testid="role-board-user-subtitle">
                    {roleLabel}{myBranchName && ` · ${myBranchName}`}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                className={`px-2 text-slate-600 hover:bg-transparent hover:text-slate-900 sm:h-11 sm:px-3 ${logoutInProfileClass}`}
                data-testid="role-board-logout-button"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>
        {/* The modals sit in their own boundary with no fallback. A dialog that
            arrives a beat after the click is better than a spinner in the middle
            of a page for something that has not opened yet. */}
        <Suspense fallback={null}>

        {showFeedback && (
          <FeedbackBoard
            // Only a Branch Admin is pinned to a branch. Super Admin opens it unscoped and
            // narrows from inside, which is what reading every branch's post requires.
            branchId={isBranchAdminRole(role) ? auth?.user?.branch_id : undefined}
            // Who is reading, said outright. A consultant has no branch either, so the
            // board cannot work this out from the absence of one.
            headOffice={showSuperAdminBoard}
            // Developer Access is Super Admin's and the BDE's only -- the same two roles
            // the server's developer-password gate lets through.
            developerAccess={role === "super_admin" || role === "business_dev"}
            onClose={() => setShowFeedback(false)}
            onCounts={(data) => setFeedbackUnread(data?.unread || 0)}
          />
        )}

        {showPhysioBoard && showPhysioCalendar && (
          <PhysioCalendarPage onClose={() => setShowPhysioCalendar(false)} />
        )}

        {showHeadPhysioBoard && showHPCalendar && (
          <HeadPhysioCalendarModal branchId={auth?.user?.branch_id} onClose={() => setShowHPCalendar(false)} />
        )}

        {(showPhysioBoard || showHeadPhysioBoard) && showTimeOff && (
          <TimeOffPage onClose={() => setShowTimeOff(false)} />
        )}

        </Suspense>

        <div className={`w-full space-y-4 px-3 py-4 sm:space-y-6 sm:px-6 sm:py-6 ${showSuperAdminBoard || showBusinessDevBoard || showAccountantBoard || showZumbaBoard ? "pb-20 md:pb-6" : ""}`}>

        {showSuperAdminBoard && (
          <div className="hidden flex-wrap gap-2 border-b border-slate-200 pb-2 md:flex" data-testid="super-admin-nav">
            {SUPER_ADMIN_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => { setShowProfile(false); setSuperAdminView((v) => (t.key === "settings" ? (SETTINGS_SUB_VIEWS.includes(v) ? v : "marketing") : t.key)); }}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${isSuperAdminTabActive(superAdminView, t.key) ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                data-testid={`super-admin-tab-${t.key}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Phone equivalent of the tab strip above: three direct destinations plus a
            "More" sheet for the rest — same pattern as the Physio/Branch Admin/Pre-Sales
            bottom navs.

            Icons only. Four slots across a phone leave room for a label, but the labels
            that fit are not the real ones — "Branch Management" arrives as two wrapped
            lines or an ellipsis, which names the destination no better than its icon does.
            Each carries its full name on aria-label and title, so the bar is still
            readable to a screen reader and on a long press. */}
        {showSuperAdminBoard && (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="super-admin-bottom-nav">
            <div className="flex items-stretch justify-around">
              {SUPER_ADMIN_BOTTOM_TABS.map((t) => {
                const Icon = t.icon;
                const active = !showProfile && superAdminView === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setShowProfile(false); setSuperAdminView(t.key); setShowSuperAdminMenu(false); }}
                    aria-label={t.label}
                    aria-current={active ? "page" : undefined}
                    title={t.label}
                    className={`flex flex-1 items-center justify-center py-3.5 ${active ? "text-white" : "text-slate-200"}`}
                    data-testid={`super-admin-nav-${t.key}`}
                  >
                    <Icon className="h-6 w-6" />
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowSuperAdminMenu((v) => !v)}
                aria-label="More"
                aria-expanded={showSuperAdminMenu}
                title="More"
                className={`flex flex-1 items-center justify-center py-3.5 ${
                  (!showProfile && SUPER_ADMIN_MORE_TABS.some((t) => isSuperAdminTabActive(superAdminView, t.key))) || showSuperAdminMenu ? "text-white" : "text-slate-200"
                }`}
                data-testid="super-admin-nav-more"
              >
                <MoreHorizontal className="h-6 w-6" />
              </button>
              {/* My Profile, and Logout inside it -- the header drops both on a phone. */}
              <button
                type="button"
                onClick={() => { setShowProfile(true); setShowSuperAdminMenu(false); }}
                aria-label="My Profile"
                aria-current={showProfile ? "page" : undefined}
                title="My Profile"
                className={`flex flex-1 items-center justify-center py-3.5 ${showProfile ? "text-white" : "text-slate-200"}`}
                data-testid="super-admin-nav-profile"
              >
                <ProfileNavGlyph user={auth?.user} size={28} iconClassName="h-6 w-6" />
              </button>
            </div>
          </div>
        )}

        {showSuperAdminBoard && showSuperAdminMenu && (
          <div
            className="fixed inset-0 z-50 flex items-end bg-slate-900/40 md:hidden"
            onClick={() => setShowSuperAdminMenu(false)}
            data-testid="super-admin-menu-sheet"
          >
            <div className="w-full rounded-t-2xl bg-white p-2 pb-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-3 py-2">
                <p className="text-sm font-semibold text-slate-700">More</p>
                <button type="button" onClick={() => setShowSuperAdminMenu(false)} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100" data-testid="super-admin-menu-close">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {SUPER_ADMIN_MORE_TABS.map((t) => {
                const Icon = t.icon;
                const active = isSuperAdminTabActive(superAdminView, t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      setShowProfile(false);
                      setSuperAdminView((v) => (t.key === "settings" ? (SETTINGS_SUB_VIEWS.includes(v) ? v : "marketing") : t.key));
                      setShowSuperAdminMenu(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium ${active ? "bg-sky-50 text-sky-700" : "text-slate-700 hover:bg-slate-50"}`}
                    data-testid={`super-admin-menu-${t.key}`}
                  >
                    <Icon className="h-4 w-4" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {phoneFooter && (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500 pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="role-bottom-nav">
            <div className="flex items-stretch justify-around">
              {phoneFooter.stops.map((t) => {
                const Icon = t.icon;
                const active = !showProfile && t.active;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setShowProfile(false); setShowSuperAdminMenu(false); t.onSelect(); }}
                    aria-label={t.label}
                    aria-current={active ? "page" : undefined}
                    title={t.label}
                    className={`flex flex-1 items-center justify-center py-3.5 ${active ? "text-white" : "text-slate-200"}`}
                    data-testid={`role-bottom-nav-${t.key}`}
                  >
                    <Icon className="h-6 w-6" />
                  </button>
                );
              })}
              {phoneFooter.more.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSuperAdminMenu((v) => !v)}
                  aria-label="More"
                  aria-expanded={showSuperAdminMenu}
                  title="More"
                  className={`flex flex-1 items-center justify-center py-3.5 ${
                    (!showProfile && phoneFooter.more.some((t) => t.active)) || showSuperAdminMenu ? "text-white" : "text-slate-200"
                  }`}
                  data-testid="role-bottom-nav-more"
                >
                  <MoreHorizontal className="h-6 w-6" />
                </button>
              )}
              <button
                type="button"
                onClick={() => { setShowProfile(true); setShowSuperAdminMenu(false); }}
                aria-label="My Profile"
                aria-current={showProfile ? "page" : undefined}
                title="My Profile"
                className={`flex flex-1 items-center justify-center py-3.5 ${showProfile ? "text-white" : "text-slate-200"}`}
                data-testid="role-bottom-nav-profile"
              >
                <ProfileNavGlyph user={auth?.user} size={28} iconClassName="h-6 w-6" />
              </button>
            </div>
          </div>
        )}

        {phoneFooter && showSuperAdminMenu && (
          <div
            className="fixed inset-0 z-50 flex items-end bg-slate-900/40 md:hidden"
            onClick={() => setShowSuperAdminMenu(false)}
            data-testid="role-menu-sheet"
          >
            <div className="w-full rounded-t-2xl bg-white p-2 pb-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-3 py-2">
                <p className="text-sm font-semibold text-slate-700">More</p>
                <button type="button" onClick={() => setShowSuperAdminMenu(false)} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100" data-testid="role-menu-close">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {phoneFooter.more.map((t) => {
                const Icon = t.icon;
                const active = !showProfile && t.active;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setShowProfile(false); setShowSuperAdminMenu(false); t.onSelect(); }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium ${active ? "bg-sky-50 text-sky-700" : "text-slate-700 hover:bg-slate-50"}`}
                    data-testid={`role-menu-${t.key}`}
                  >
                    <Icon className="h-4 w-4" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* My Profile stands in place of the board rather than over it.
            It used to be a dialog, and what is on it now — a month of attendance eleven
            columns wide, and every field HR holds — is a page's worth of screen. The nav
            above stays put, and every tab in it closes this on the way out, so the page is
            left the same way any board is: by going somewhere else. */}
        {showProfile ? (
          <Suspense fallback={<BoardFallback />}>
            <MyProfilePage
              user={auth.user}
              roleLabel={roleLabel}
              onBack={() => setShowProfile(false)}
              onLogout={logoutInProfile ? logout : undefined}
              phoneBar={logoutInProfile}
              keepBack={!profileInFooter}
              hideTimeOff={showSuperAdminBoard}
              timeOffInHeader={showPhysioBoard || showHeadPhysioBoard}
            />
          </Suspense>
        ) : (
        <>

        {/* Below the nav, not around it: the tabs and the role bar stay on screen
            while a board chunk is fetched, so switching boards reads as the board
            loading rather than the page going away. */}
        <Suspense fallback={<BoardFallback />}>

        {showSuperAdminBoard && superAdminView === "hr" && (
          <HRBoard isSuperAdmin={role === "super_admin"} />
        )}

        {showSuperAdminBoard && superAdminView === "operations" && (
          <OperationsBoard actingUser={auth.user} branches={branches} compact />
        )}

        {showSuperAdminBoard && superAdminView === "finance" && (
          <FinanceWiseBoard branches={branches} />
        )}

        {showSuperAdminBoard && superAdminView === "packages" && (
          <PackagesBoard />
        )}

        {showSuperAdminBoard && superAdminView === "my_consultation" && (
          <MyConsultationBoard
            user={auth?.user}
            branches={branches}
            search={hpSearch}
            onSearchChange={setHpSearch}
          />
        )}

        {showSuperAdminBoard && SETTINGS_SUB_VIEWS.includes(superAdminView) && (
          <div data-testid="super-admin-settings">
            {superAdminView === "marketing" && <MarketingBoard branches={branches} leading={settingsSubTabs} />}
            {superAdminView === "stages" && <PipelineStageManagement leading={settingsSubTabs} />}
            {superAdminView === "import_export" && <PastDataImportExport leading={settingsSubTabs} />}
          </div>
        )}

        {showSuperAdminBoard && superAdminView === "presales" && (
          <PreSalesCRM onManageStages={() => setSuperAdminView("stages")} role={role} currentUser={auth.user} />
        )}

        {showSuperAdminBoard && superAdminView === "marketing_master" && (
          <PreSalesCRM role="marketing_head" currentUser={auth.user} />
        )}

        {showPreSalesBoard && (
          <PreSalesCRM
            role={role}
            currentUser={auth.user}
            onLogout={logout}
            {...(role === "sales_head" ? { masterView: presalesView, onMasterViewChange: setPresalesView } : {})}
          />
        )}

        {showMarketingHeadBoard && (
          <PreSalesCRM role={role} currentUser={auth.user} onLogout={logout} />
        )}

        {showSuperAdminBoard && superAdminView === "dashboard" && (
          <DashboardBoard />
        )}

        {showBusinessDevBoard && (
          <BusinessLeadsDashboard currentUser={auth?.user} tab={bdTab} onTabChange={setBdTab} />
        )}

        {showBranchBoard && (
          <BranchAdminBoard branchId={auth?.user?.branch_id} currentUser={auth?.user} canTransferBranch roleLabel={roleLabel} onLogout={logout} />
        )}

        {showHeadPhysioBoard && (
          // `mine`: a Consultant signing into their own board asks for their own patients,
          // not the branch's. Without it this fell to the branch-wide query and every
          // Consultant read every other Consultant's consultations. Operations and Branch
          // Control mount the same board with `supervising` instead and keep the branch view.
          <HeadPhysioBoard branchId={auth?.user?.branch_id} branchIds={auth?.user?.branch_ids} user={auth?.user} mine search={hpSearch} onSearchChange={setHpSearch} roleLabel={roleLabel} onLogout={logout} />
        )}

        {showPhysioBoard && (
          // user/roleLabel are for the board's own My Profile stop — the fourth glyph on
          // the phone's bottom bar, which renders the same page this one does from the
          // header button, inside the board so the bar stays under it.
          <PhysioBoard user={auth.user} roleLabel={roleLabel} onLogout={logout} />
        )}

        {showDietBoard && (
          <DietBoard user={auth.user} roleLabel={roleLabel} onLogout={logout} />
        )}

        {showHumanResourceBoard && (
          <HumanResourceBoard user={auth.user} roleLabel={roleLabel} onLogout={logout} />
        )}

        {showAccountantBoard && <AccountantBoard />}
        {showZumbaBoard && <ZumbaMasterBoard />}

        </Suspense>

        </>
        )}
        </div>
      </div>

      {/* No "Loading boards..." indicator any more. It spoke for the eight-endpoint load
          this page used to run, and nothing on screen waits for what is left: each board
          fetches and reports its own loading, and the one request here only fills in the
          branch name beside the role. A toast for it would be reporting work the reader
          is not waiting on. */}
    </div>
  );
};

