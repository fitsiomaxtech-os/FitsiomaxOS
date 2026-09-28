import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSession } from "@/lib/session";
import {
  Calendar,
  CalendarX,
  CheckCircle2,
  ArrowLeftRight,
  RefreshCw,
  ClipboardCheck,
  ChevronLeft,
  ChevronRight,
  Phone,
  Mail,
  Search,
  Stethoscope,
  Trash2,
  UserPlus,
  X,
  Activity,
  LayoutDashboard,
  FileText,
  ShoppingCart,
  ClipboardList,
  Bell,
  BadgeIndianRupee,
  Salad,
  UserCog,
  User,
  UserX,
  Clock,
  MoreHorizontal,
  UserCircle,
  Star,
  AlertCircle,
  PhoneOff,
  Music,
  Dumbbell,
  Video,
  HeartPulse,
  IdCard,
  Pencil,
  Repeat,
  Eye,
  Home,
  Building2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters, quickDatePreset } from "@/components/QuickDateFilterBar";
import { StageTabBar } from "@/components/ui/stage-tab";
import { RescheduledTag, TransferredTag } from "@/components/ui/lead-marks";
import {
  scheduleBranchAppointment,
  getBranches,
  getBranchBoard,
  getArmBoard,
  getAvailableExperts,
  getAvailableDates,
  getSwapCandidates,
  swapBranchAppointment,
  getLeadActivity,
  getLeadRemarks,
  moveBranchStage,
  moveConsultationStage,
  stagesList,
  scheduleBranchFollowUp,
  rescheduleBranchFollowUp,
  bulkDeleteLeads,
  setLeadFlags,
  rnrAttempt,
  getLeadAppointmentCard,
  listStoreItems,
} from "@/lib/api";
import { to12h, endTime12h, callTimeStamp, callDateStamp, dateStampFull } from "@/lib/time";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { HeadPhysioCalendar } from "@/components/HeadPhysioCalendar";
import { ConsultationsBoard } from "@/components/ConsultationsBoard";
import { AppointmentConfirmCard } from "@/components/AppointmentConfirmCard";
import { FitsiomaxStorePanel } from "@/components/BranchStoreBoard";
import { PullFromSheetButton } from "@/components/PullFromSheetButton";
import { AccountantManageTab } from "@/components/branch/AccountantManageTab";
import { BranchCalendarPanel } from "@/components/branch/BranchCalendarPanel";
import { TimeManagementPanel } from "@/components/branch/TimeManagementPanel";
import { ZumbaMastersPanel } from "@/components/branch/ZumbaMastersPanel";
import { BranchDetailPage } from "@/components/branch/BranchDetailPage";
import { LeadBranchTransferDialog } from "@/components/branch/LeadBranchTransferDialog";
import MissedClassPanel from "@/components/branch/MissedClassPanel";
import { PhysioAbsencePanel } from "@/components/PhysioAbsencePanel";
import { BranchReviewPanel } from "@/components/branch/BranchReviewPanel";
import { PatientsPortalPanel } from "@/components/branch/PatientsPortalPanel";
import { ClientReviewsPanel } from "@/components/reviews/ClientReviewsPanel";
import { ZumbaPanel } from "@/components/branch/ZumbaPanel";
import { FitnessPanel } from "@/components/branch/FitnessPanel";
import { RecordsPanel } from "@/components/branch/RecordsPanel";
import { MyProfilePage } from "@/components/MyProfilePage";
import { CreateLeadModal, DEPARTMENT_OPTIONS, LEAD_DATA_FIELDS } from "@/components/CreateLeadModal";
import { LeadEditModal } from "@/components/LeadEditModal";
import { MilkCalendar, MilkDateInput, MilkTimeInput } from "@/components/ui/milk-calendar";
import { isCourseComplete } from "@/lib/leadStage";

// The Branch (sales) stages this file has to recognise, addressed by the role the backend
// stamps on the stage row rather than by what the stage is called.
//
// These stages do something: the card opens its booking dialog on `appointment`, the move
// releases the consultation slot on `cancelled`, `rnr` reads as "not reached yet", and
// `portfolio` stays off the strip because it is entered from its own scheduling dialog.
// Every one of those was a comparison against the stage's name, matching the literals below
// -- so renaming one in CI/CD ROOTS did not rename a label, it detached the behaviour from
// the stage: the pill stopped opening the booking dialog, the cancel stopped freeing the
// hour, and the backend rejected the booking as an unknown final_stage. Super Admin could
// see the stage in the list and could not safely touch it.
//
// The role travels with the row through a rename, so the name is Super Admin's now.
// See constants.SALES_STAGE_ROLES_BY_NAME and seed.ensure_sales_stage_roles.
const STAGE_ROLE_APPOINTMENT = "appointment";
const STAGE_ROLE_CANCELLED = "cancelled";
const STAGE_ROLE_RNR = "rnr";
const STAGE_ROLE_PORTFOLIO = "portfolio";
const STAGE_ROLE_FOLLOW_UP = "follow_up";
// The fourth exit, and the other stage a lead stops on. Rolled like the rest because the
// board has to recognise it twice over: to offer it from Appointment at all, and to go on
// counting a written-off lead under it after a consultant has moved the patient along the
// consultation pipeline underneath (see rowStageName and matchesBranchStage).
const STAGE_ROLE_NOT_A_PROSPECT = "not_a_prospect";

// Branch Consultation's cancel stage. The Branch Leads card offers it as its Cancel pill,
// moving consultation_stage rather than branch_stage -- see consultationCancelStage.
const CONSULTATION_CANCEL_STAGE = "Cancel";

// What each role was called when it shipped. Only ever a fallback: a stage row that predates
// the stamping pass carries no role, and until the next backend restart stamps it, the name
// is all there is to go on.
const STAGE_ROLE_FALLBACK_NAMES = {
  [STAGE_ROLE_APPOINTMENT]: "Appointment Date & Time",
  [STAGE_ROLE_CANCELLED]: "Cancelled",
  [STAGE_ROLE_RNR]: "RNR",
  [STAGE_ROLE_PORTFOLIO]: "Portfolio",
  [STAGE_ROLE_FOLLOW_UP]: "Follow Up",
  [STAGE_ROLE_NOT_A_PROSPECT]: "Not a prospect",
};

// Does this stage row carry `role`? Trusts the stamp where there is one, so a stage renamed
// to something that happens to match another role's old name is still itself.
const stageHasRole = (stage, role) => (
  stage?.role ? stage.role === role : stage?.name === STAGE_ROLE_FALLBACK_NAMES[role]
);

// What the stage carrying `role` is currently called, for the sites that compare a lead's
// stored branch_stage string rather than a row.
const stageNameForRole = (stages, role) => (
  (stages || []).find((s) => stageHasRole(s, role))?.name || STAGE_ROLE_FALLBACK_NAMES[role]
);

// Where the Consultation tab opens: the head of the branch consultation pipeline, which is
// where booking an appointment in Branch Leads puts a patient.
//
// It used to open on Consultation Visit, because the stage before it was called "Follow
// Up" -- a name the Branch strip already owned, which cost it its pill here (see
// consultationOnlyStages). Opening one stage in was the closest this tab could get to
// opening at the beginning. The stage is called "Consultation Booked" now and has a pill
// of its own, so the tab opens on the patients waiting to be seen rather than one step
// past them.
const BRANCH_CONSULTATION_OPENING_STAGE = "Consultation Booked";

// The card the Consultation tab sits on when nothing else has been chosen -- on arrival,
// and again the moment a lit card is clicked off.
//
// This bar has no "All Stages" card (see hideAllStages), so an empty filter has nothing on
// screen representing it: the cards all read unselected while the table underneath quietly
// widens to every lead on the branch, including the ones that have never been booked for a
// consultation at all. There is no card to press to get back, either -- the reader has to
// guess that clicking any card and clicking it again is what they did. So the tab keeps a
// card lit at all times and this is the one it falls back to.
//
// Consultation Visit rather than the opening stage above because it is where the branch's
// own work starts: a patient who has arrived and is waiting to be seen. Falls back to
// BRANCH_CONSULTATION_OPENING_STAGE, then to whichever card comes first, so a branch that
// has renamed this stage in Pipeline Stage Management still lands on something.
const BRANCH_CONSULTATION_DEFAULT_STAGE = "Consultation Visit";

// ---- Appointment confirmation -------------------------------------------------------
// What the client walks away with. Built as its own document so it can be opened, printed
// to PDF, saved or shared — same branding, styles and mechanics the payment receipt uses,
// from lib/printable.js.

/**
 * One of the intake form's own questions, read back off a lead.
 *
 * These are sheet columns, so they arrive keyed by whatever the form called them --
 * "what_type_of_pain_are_you_experiencing?" on one branch's sheet, "What type of pain are
 * you experiencing" on the next. Compared on letters and digits alone so a form that
 * gains a capital, loses its question mark or swaps underscores for spaces keeps filling
 * its column instead of quietly going blank, which is a failure nobody can see.
 *
 * Falls back to the lead's own field where the question has one. A source whose mapping
 * sends this column to Condition or Months of Pain has no extra_fields entry left to read
 * -- the answer moved to the field it was mapped onto -- and the column would empty out
 * for exactly the sources that mapped themselves most carefully.
 */
const squashKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether one extra_fields key is one of the things being looked for.
 *
 * Two kinds of entry, both compared against the squashed key. A string is one exact
 * spelling of a header -- "City", "city_town" -- and a RegExp is a question whose wording
 * is fixed but whose middle is not: "Which area of Chennai are you located in?" is the
 * same question in every city the clinic ever opens in, and listing the cities would mean
 * the column going quiet the day a new one is added.
 *
 * Still exact matching either way, never a substring: the pattern is anchored to the whole
 * key, for the reason CITY_KEYS gives -- "city" inside "capacity" is how a column fills
 * with the wrong answer and nobody notices.
 */
const matchesFormKey = (key, wanted) => {
  const squashed = squashKey(key);
  return wanted.some((w) => (w instanceof RegExp ? w.test(squashed) : squashKey(w) === squashed));
};

const formAnswer = (lead, questionKey, fallback, formatFallback) => {
  // A list, because one field is not always one header. The intake questions each have a
  // single exact spelling and pass a string; a plain field like City is written whichever
  // way the sheet that carries it felt like writing it, and passes every spelling worth
  // recognising. Same walk either way.
  const wanted = Array.isArray(questionKey) ? questionKey : [questionKey];
  const extras = lead?.extra_fields || {};
  for (const [key, value] of Object.entries(extras)) {
    if (matchesFormKey(key, wanted) && value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  const own = fallback ? lead?.[fallback] : null;
  if (own === null || own === undefined || String(own).trim() === "") return "";
  // The field's own value needs its unit put back on. The sheet answer reads "3-6 months"
  // because that is what the patient ticked; months_of_pain is the bare number 6, and a
  // column headed Pain Duration showing "6" is not an answer to it.
  return formatFallback ? formatFallback(own) : String(own).trim();
};

/**
 * The intake-form questions the Branch Leads list gives a column to, and the toolbar a
 * filter on.
 *
 * One definition rather than two. The columns read these through formAnswer and so does
 * every dropdown above them, so a filter cannot come to disagree with the column it sits
 * over -- which is the failure that matters here, because a filter that reads the question
 * a little differently from the column silently returns nothing and looks like a branch
 * with no such patients. It is also what makes removing one of these a one-line change:
 * Consultation Type was dropped from this list and left the column, the dropdown and the
 * narrowing together, with no chance of a filter outliving the column it filtered.
 *
 * `fallback` and `formatFallback` are formAnswer's: where the sheet mapped this column
 * onto a field of the lead's own, the answer is read back off that field with its unit
 * put back on.
 *
 * `allLabel` is the dropdown's own wording, written out rather than pluralised from the
 * heading -- same reason City's is written out further down. A heading is written to sit
 * over a column and does not always take an s: "All Looking Fors" is what pluralising the
 * arm's pair produces.
 *
 * Two sets, because the forms behind the two kinds of board are two forms. A branch sees
 * a patient who arrives with a pain, and asks what it is and how long they have had it.
 * The online arms advertise on Meta and ask what the patient wants physiotherapy for and
 * how soon they want to start. Their leads carry no answer to the branch's pair, so on an
 * arm's board the branch columns read a dash the whole way down and the dropdowns over
 * them have nothing to offer.
 *
 * Which set a board draws is the board's own question, not the leads': an arm with no
 * patients yet still has to head its columns, and one lead filed under an odd vertical
 * must not repaint the table around it.
 */
const BRANCH_INTAKE_QUESTIONS = [
  { key: "pain_type", label: "Pain Type", allLabel: "All Pain Types", question: "what_type_of_pain_are_you_experiencing?", fallback: "condition", formatFallback: null },
  { key: "pain_duration", label: "Pain Duration", allLabel: "All Pain Durations", question: "how_long_have_you_had_this_pain?", fallback: "months_of_pain", formatFallback: (n) => `${n} month${Number(n) === 1 ? "" : "s"}` },
];

// No fallback field on any of the arm questions below. The branch pair reads back off the
// lead's own column where a sheet mapped the answer onto one, but nothing on a lead holds
// a start time, a preferred hour or a fitness goal -- the nearest to the first is
// expected_consultation_date, a date somebody booked rather than an answer to the
// question, and reading it would put a date under a heading nobody asked for one under.
// Unmapped, the sheet's own answer sits in extra_fields, which is what shows.
const ARM_LOOKING_FOR = { key: "looking_for", label: "Looking For", allLabel: "All Reasons", question: "what_are_you_looking_for_physiotherapy_for?", fallback: "condition", formatFallback: null };
const ARM_START_WHEN = { key: "start_when", label: "How Soon", allLabel: "All Timelines", question: "how_soon_would_you_like_to_start_physiotherapy?", fallback: null, formatFallback: null };

/**
 * The three the Online Fitness form asks, and the only questions this file offers to a
 * person filling the form in by hand -- see the Add New Lead call further down.
 *
 * Keyed by the question exactly as the sheet writes it, because that is the key the
 * importer files a sheet answer under and the key the column reads back. A lead typed in
 * at the desk and one that arrived off the sheet then land in the same place and read the
 * same way, which is the whole reason the form writes these rather than fields of its own.
 */
const FITNESS_FORM_QUESTIONS = [
  { key: "planning_start", label: "Planning To Start", allLabel: "All Start Plans", question: "when_are_you_planning_to_start?", fallback: null, formatFallback: null },
  { key: "workout_time", label: "Best Time", allLabel: "All Workout Times", question: "which_time_works_best_for_your_workouts?", fallback: null, formatFallback: null },
  { key: "fitness_goal", label: "Fitness Goal", allLabel: "All Goals", question: "what_is_your_primary_fitness_goal?", fallback: null, formatFallback: null },
];

const PHYSIO_ARM_INTAKE_QUESTIONS = [ARM_LOOKING_FOR, ARM_START_WHEN];

// On fitness the columns are exactly the three its form asks, and nothing else. How Soon
// led them for a while and read a dash on every patient: its question names
// physiotherapy, so no fitness form has ever asked it, and "when are you planning to
// start" -- which is the same question in fitness words -- was sitting in the next column
// answering it.
const FITNESS_ARM_INTAKE_QUESTIONS = FITNESS_FORM_QUESTIONS;

/**
 * What the Online Physiotherapy form offers a person filling it in by hand.
 *
 * How Soon only, of that arm's pair. Looking For falls back to the lead's own `condition`
 * (see ARM_LOOKING_FOR), and this form already has a Condition field writing that column,
 * so offering it here as well would be two inputs on one form for one answer, landing in
 * two different places and disagreeing the moment somebody fills in both.
 *
 * How Soon has no such field anywhere on the lead, which is what made it unanswerable at
 * the desk: the column existed, the sheet's leads filled it, and a lead typed in by hand
 * read a dash there with nothing on the form to change that.
 */
const PHYSIO_FORM_QUESTIONS = [ARM_START_WHEN];

/**
 * Where the patient is, read however their sheet happened to carry it.
 *
 * City is a mappable lead column (LEAD_COLUMN_FIELDS in backend/lead_mapping.py), so a
 * source whose City column is mapped writes it straight onto the lead and `fallback`
 * finds it there. But a sheet nobody has mapped that column on still brings the answer
 * across: the importer keeps every unmapped column as extra detail, keyed by whatever the
 * header said (see v3_google_sheets.py — "An unmapped column is still worth keeping").
 * Those leads carry their city in extra_fields under "City", "city", "Town" and the rest.
 *
 * Reading both is what lets one column show the city for every branch's leads instead of
 * only for the sources somebody has been through the mapping dialog for. It does not
 * replace mapping the column — a mapped source still writes the real field, which is what
 * the Create Lead form and every other board read — it stops an unmapped one showing a
 * dash where the sheet plainly has an answer.
 *
 * The spellings are listed rather than matched loosely on purpose. "city" as a substring
 * matches "capacity", and a column that quietly fills with somebody's slot capacity is
 * worse than one that occasionally reads "—".
 */
const CITY_KEYS = [
  "city", "town", "city/town", "town/city", "city_town", "hometown", "native",
  // And the question a branch's own intake form asks in place of a City column: "Which
  // area of Chennai are you located in?", which is where the patient lives said as a
  // sentence. The form asks it, the popup printed the answer under the question, and the
  // City column beside it read a dash -- one lead, its town on the screen twice, once
  // as an answer and once as a blank.
  //
  // Matched by shape rather than listed, because the city in the middle of it is whichever
  // city the branch is in. The whole key has to be the question, so nothing else can fall
  // in: "Which is your preferred location ?" -- the other question on this same form, and
  // the one that names a BRANCH rather than a patient's area -- does not match it.
  /^whichareaof[a-z]+areyoulocatedin$/,
];

const cityAnswer = (lead) => formAnswer(lead, CITY_KEYS, "city", null);

/**
 * The toolbar's dropdowns, in the order they sit in the row.
 *
 * One list rather than the intake questions plus a City control written out beside them:
 * the filter row, the narrowing and the option-gathering all walk this, so a dropdown
 * cannot come to disagree with the list it filters -- the same reason the intake questions
 * are a list and not a copy of a select per question.
 *
 * `answer` is what the filter compares and what the options are gathered from. Each
 * intake question passes formAnswer its own question text; City passes cityAnswer, which
 * reads the lead's own City field and the spellings an unmapped sheet uses. The dropdown
 * is thereby offering exactly what the City column shows, which is what stops a branch
 * picking a city out of the list and getting an empty table back.
 *
 * `allLabel` is written out rather than pluralised from the label. "All Pain Types" is
 * the label with an s on it and "All Cities" is not, and a control reading "All Citys" is
 * the sort of thing nobody reports and everybody notices.
 */
const toolbarFiltersFor = (questions) => [
  ...questions.map((q) => ({
    key: q.key,
    label: q.label,
    // Carried from the question rather than pluralised off the heading here -- see the
    // note on the two question sets. The dropdown names the thing being filtered, which
    // is not always the column heading with an s on it.
    allLabel: q.allLabel,
    width: "w-36 2xl:w-40",
    answer: (lead) => formAnswer(lead, q.question, q.fallback, q.formatFallback),
  })),
  {
    key: "city",
    label: "City",
    allLabel: "All Cities",
    // Narrower than the intake dropdowns before it, on what it holds rather than on what
    // is left over. A city is one short word and "All Cities" is shorter than "All Pain
    // Durations"; at the intake width the box would be mostly empty. w-24 still spells
    // "All Cities" out in full, which is the floor -- the intake pair cannot come down
    // with it without reading "All Pain Ty...", so this is where the row gives back the
    // width the date ranges beside it now take. See the toolbar note further down.
    width: "w-24 2xl:w-32",
    answer: cityAnswer,
  },
];

// Built once per question set, so the dropdowns change with the columns they sit over.
// City is in all three: it is a column on all three boards.
const BRANCH_TOOLBAR_FILTERS = toolbarFiltersFor(BRANCH_INTAKE_QUESTIONS);
const PHYSIO_ARM_TOOLBAR_FILTERS = toolbarFiltersFor(PHYSIO_ARM_INTAKE_QUESTIONS);
const FITNESS_ARM_TOOLBAR_FILTERS = toolbarFiltersFor(FITNESS_ARM_INTAKE_QUESTIONS);

/** Whether a branch record is one of the online arms rather than a room somebody walks
 *  into. Every default vertical is named "online_..."/"offline_...", which is the reading
 *  Operations, Branch Management and six other boards already take off this field. */
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

/**
 * Which online arm a board belongs to -- "fitness", "physio", or null for a branch.
 *
 * Asked of the login's role first and the branch record second, because only one of the
 * two is ever available: the arm's own admin reaches their board with no branch at all
 * (see getArmBoard), and a Super Admin reaches the same arm as a branch tile under a role
 * that says nothing about it.
 *
 * The vertical is tokenised rather than searched, the way vertical_in_arm does it in
 * backend/deps.py: "online_fitness" and "online_fitness_gym" are one arm, and a value
 * merely containing the letters is not.
 */
const ARM_PRACTICE_BY_ROLE = {
  online_fitness_admin: "fitness",
  online_physio_admin: "physio",
};

const armPracticeOf = (role, vertical) => {
  const byRole = ARM_PRACTICE_BY_ROLE[String(role || "").trim().toLowerCase()];
  if (byRole) return byRole;
  if (!isOnlineVertical(vertical)) return null;
  const tokens = new Set(String(vertical).toLowerCase().split(/[^a-z0-9]+/));
  if (tokens.has("fitness") || tokens.has("gym")) return "fitness";
  if (tokens.has("physio") || tokens.has("physiotherapy")) return "physio";
  return null;
};

/** "offline_physio" -> "Offline Physio", and whatever it already said where the dropdown
 *  has no label for it: department is not a controlled field on an imported lead. */
const departmentLabel = (value) =>
  DEPARTMENT_OPTIONS.find((d) => d.value === value)?.label || value || "";

/**
 * A sheet column's key, said the way a person would say it.
 *
 * extra_fields is keyed by whatever the intake form called the question, which arrives as
 * "what_type_of_pain_are_you_experiencing?". Printed verbatim that reads as a database row
 * rather than as the answer somebody actually gave, so the underscores come out and the
 * first letter goes up. Nothing else is touched — the question mark is part of the
 * question, and re-casing the words would turn a sentence into a headline.
 */
const humanKey = (key) => {
  const words = String(key || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
};

/**
 * The toolbar's filter dropdowns.
 *
 * These were native <select>s, which meant the open list was drawn by the operating
 * system: a stack of raw sheet values in the OS's own font, ignoring every border, radius
 * and colour the rest of this row is built from, and unstylable by design. Beside the
 * range buttons and the search field it was the one control that looked like it had come
 * from a different program.
 *
 * Built on the Select in components/ui now, so the menu is ours -- the card white the
 * boards use, the same rounding as the toolbar, the chosen option ticked -- while Radix
 * keeps what a native select gave for free: arrows to move, type-ahead to jump, Escape to
 * close, and a trigger that still announces the column it filters.
 *
 * The answers are put through humanKey for display only. A sheet writes "back_pain" and
 * "less_than_3_months", which is a database row rather than anything a person says out
 * loud. The value behind each option is still the lowercased answer the list matches on,
 * so what this control filters is exactly what it filtered before -- only what it reads
 * has changed.
 */
const FILTER_ALL = "__all__";

const FilterSelect = ({ filter, options, value, onChange }) => {
  const active = !!value;
  return (
    // Radix will not take "" as an option's value -- that is its cleared state -- so the
    // reset option carries a sentinel and is turned back into "" on the way out, which is
    // what listFilters has always held for "this filter is not narrowing anything".
    <Select value={value || FILTER_ALL} onValueChange={(v) => onChange(v === FILTER_ALL ? "" : v)}>
      <SelectTrigger
        title={filter.label}
        aria-label={filter.label}
        className={`h-10 ${filter.width} shrink-0 rounded-md border px-2.5 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 ${
          active
            ? "border-sky-300 bg-sky-50 text-sky-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        }`}
        data-testid={`branch-list-filter-${filter.key}`}
      >
        <SelectValue />
      </SelectTrigger>
      {/* Capped and scrolling. A branch whose sheet offers thirty pain types would
          otherwise open a menu taller than the board behind it. */}
      <SelectContent className="max-h-72 border-slate-200" data-testid={`branch-list-filter-${filter.key}-menu`}>
        {/* First and set apart, because it is the way out of the filter rather than
            another answer to it. */}
        <SelectItem value={FILTER_ALL} className="text-xs font-medium text-slate-500">{filter.allLabel}</SelectItem>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v} className="text-xs text-slate-700">{humanKey(label)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * The ad-record field keys, and the loose form a key is matched in.
 *
 * The keys in lead_data are Meta's own and exact. The same fields turning up in
 * extra_fields came off a sheet header instead, so they arrive spelled however the column
 * was typed — "Ad Name", "ad-id", "Campaign ID ". Both are flattened to the same shape
 * before the lookup, so one field is recognised however it was written.
 */
const AD_FIELD_KEYS = new Set(LEAD_DATA_FIELDS.map((field) => field.key));
const normaliseAdKey = (key) =>
  String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Whether a lead actually carries an answer. Explicit rather than falsiness, because 0 is
 *  one: "months_of_pain: 0" is somebody who started hurting this month. */
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/** A label and its value hard against the other edge, for the read-only cards below.
 *  Aligned to the top rather than centred so the label stays level with the first line of
 *  an address that wraps, and break-words so an ad id with nowhere to break still does. */
const DetailRow = ({ label, value }) => (
  <div className="flex items-start justify-between gap-3 text-sm" data-testid={`branch-lead-row-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
    <span className="shrink-0 text-xs font-medium text-slate-500">{label}</span>
    <span className="break-words text-right font-medium text-slate-800">{value}</span>
  </div>
);

/** "2026-08-05" -> "Wednesday, 5 August" */
const weekdayLabel = (d) => (d
  ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
  : "—");

/** The slot on a lead, for the Branch Leads list — "06 Aug" + "10:30 AM".
 *  Pre-Sales writes appointment_date/time when it schedules, and assigning the Fitsiomax
 *  Expert later overwrites them with the branch's own confirmed slot. So while no physio
 *  is assigned this is still Pre-Sales' requested time, which is what New Appointment
 *  needs to show. Dates are plain "YYYY-MM-DD" calendar days, not instants, so they are
 *  parsed at local midnight and never shift a day. */
const apptSlotLabel = (lead) => {
  const date = lead?.appointment_date;
  const time = lead?.appointment_time;
  if (!date && !time) return null;
  return {
    date: date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "",
    time: time ? to12h(time) : "",
  };
};

/** The follow-up call a lead is actually waiting on, for the Follow Up column —
 *  "06 Aug" + "10:30 AM", plus whether that moment has already gone by.
 *
 *  Newest first and skipping the rescheduled ones, which is the rule the lead card's own
 *  Follow-Up preview draws with: a booking that was moved is history, not the call
 *  somebody is waiting on, and naming it here would put a date on the list nobody is
 *  going to ring on.
 *
 *  next_follow_up_at is the fallback rather than the source. Every scheduling path stamps
 *  it (see v3_schedule_branch_follow_up), so a lead that reached this stage through
 *  Pre-Sales carries the field without the branch's own follow_ups[] behind it — and a
 *  column that read follow_ups[] alone would show those rows a dash.
 *
 *  Dates are plain "YYYY-MM-DD" calendar days, so they are parsed at local midnight and
 *  never shift a day; only the overdue test needs the time on it. */
const followUpSlotLabel = (lead) => {
  const active = (lead?.follow_ups || []).slice().reverse().find((f) => f.status !== "rescheduled");
  let date = active?.date;
  let time = active?.time;
  if (!date && lead?.next_follow_up_at) {
    const [d, t] = String(lead.next_follow_up_at).split("T");
    date = d;
    time = (t || "").slice(0, 5);
  }
  if (!date) return null;
  return {
    date: new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    time: time ? to12h(time) : "",
    overdue: new Date(`${date}T${time || "00:00"}:00`).getTime() < Date.now(),
  };
};

/** The Follow Up column's heading — a clock and nothing else.
 *
 *  Icon-only because the column is only ever drawn on the Follow Up stage, where what the
 *  date under it means is not in question, and because the word spelled out is wider than
 *  the "06 Aug · 10:30 AM" beneath it: the heading would have set the column's width and
 *  taken the room from the columns that are actually read.
 *
 *  The name is still carried, twice — a title for the pointer and an sr-only label for a
 *  screen reader, which would otherwise be handed a column of dates headed by nothing.
 *
 *  Renders nothing rather than an empty cell when the column is off, so the header and
 *  the rows below it count the same number of columns.
 */
const FollowUpHeaderCell = ({ show, widthClass }) => (show ? (
  <th className={`${widthClass} px-4 py-3`} title="Follow-up date & time" data-testid="branch-list-followup-head">
    <Clock className="h-4 w-4" aria-hidden="true" />
    <span className="sr-only">Follow-up date &amp; time</span>
  </th>
) : null);

/** lucide has no WhatsApp glyph and the brand mark can't be approximated with a generic
 *  chat bubble — staff scan for this exact shape. */
const WhatsAppIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 016.988 2.896 9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.943c0 2.096.549 4.142 1.595 5.945L0 24l6.305-1.654a11.94 11.94 0 005.71 1.454h.005c6.585 0 11.946-5.359 11.949-11.945a11.87 11.87 0 00-3.44-8.406" />
  </svg>
);

/** 128 bits from the platform CSPRNG — the share link's only key, so it can't be a
 *  counter or anything derived from the patient's own details. */
const randomToken = () => {
  const bytes = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** A stored phone in E.164 for wa.me, which takes digits only — no +, spaces or the
 *  "p:" prefix some records carry. A bare 10-digit number is assumed Indian, matching
 *  every other number in the system; anything already carrying a country code is left
 *  alone. Returns "" when there's nothing dialable, so the button can hide itself. */
const waNumber = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
};

/** The list's column widths, with and without the Follow Up column.
 *
 *  Stated rather than computed because table-fixed divides by the widths written down, and
 *  a set that overshoots 100 quietly squeezes the last column instead of complaining — so
 *  the extra column is paid for out of the other eight rather than added on top of them.
 *  Both sets total 100.
 *
 *  Written as whole classes, not assembled from pieces: Tailwind compiles the class names
 *  it can see in the source, and `w-[${n}%]` is not one of them.
 *
 *  Only the branch's post-entry shape has a second set. Follow Up is never an entry stage,
 *  so the entry header can only ever draw the eight it always has. */
const BRANCH_LIST_WIDTHS = {
  base: {
    patient: "w-[19%]", phone: "w-[12%]", city: "w-[11%]", painType: "w-[12%]",
    painDuration: "w-[11%]", physio: "w-[11%]", appt: "w-[10%]", followUp: "", stage: "w-[8%]",
    action: "w-[6%]",
  },
  withFollowUp: {
    patient: "w-[17%]", phone: "w-[11%]", city: "w-[10%]", painType: "w-[10%]",
    painDuration: "w-[10%]", physio: "w-[10%]", appt: "w-[9%]", followUp: "w-[9%]", stage: "w-[8%]",
    action: "w-[6%]",
  },
};

/** The same, for an online arm — five fixed columns and the form's own questions sharing
 *  what is left. The questions give up three points for the Follow Up column and the fixed
 *  five give up the other six, so no single column carries the whole of it. */
const ARM_LIST_WIDTHS = {
  base: {
    name: "w-[19%]", phone: "w-[12%]", city: "w-[10%]", appt: "w-[10%]",
    followUp: "", stage: "w-[11%]", questionShare: 32,
  },
  withFollowUp: {
    name: "w-[17%]", phone: "w-[11%]", city: "w-[9%]", appt: "w-[9%]",
    followUp: "w-[9%]", stage: "w-[10%]", questionShare: 29,
  },
};

// Which tabs get a direct slot on the phone bar. The rest go behind More.
//
// Consultation sits between Leads and Review because that is the order the branch works
// them in -- a lead is picked up, consulted, then reviewed -- and because it was the one
// list a Branch Admin opens hourly that still cost two taps behind More.
const BOTTOM_NAV_KEYS = ["pipeline", "branch_consultation", "review", "consultations"];

// The two desks that only exist in a room. Zumba is a class taught in the branch's studio
// in two fixed morning slots, and Fitness is the gym's membership roll — who is training,
// who is paused, who owes on a package. Neither is something an arm with no floor sells.
const ROOM_ONLY_TABS = ["zumba", "fitness"];

/** Whether this role runs an arm that has no room in it.
 *
 * Both online branch admins do, and both lose both tabs above — including the Fitness one
 * from ONLINE FITNESS ADMIN, which looks like the wrong tab to take off that board until
 * you read what it holds. It is the gym's membership roll, sold against the Fitness shelf
 * and worked on the floor; online fitness is not run from it. Leaving it there offered a
 * desk whose every row would have to be somebody else's branch's.
 *
 * Matched exactly, like isBranchAdminRole in pages/CRMPage.jsx and for the same reason: a
 * loose match on the "online" token would also catch a plain branch_admin at a branch
 * whose name happens to carry the word, and take two working desks off their board.
 *
 * The three retired branch_admin_* slugs are deliberately absent. Every one of them named
 * a practice sold in a room, so none can be the online arm, and reading them as one would
 * strip the tabs from a physical branch whose account the migration has not reached.
 */
const ONLINE_BRANCH_ADMIN_ROLES = ["online_physio_admin", "online_fitness_admin"];
const runsWithoutARoom = (role) => ONLINE_BRANCH_ADMIN_ROLES.includes(String(role || "").trim().toLowerCase());

// Which Department a lead created on one of those boards is. Pinned rather than left to
// the dropdown, because the arm board finds its leads by their vertical and the vertical
// is derived from this field — so a lead entered here with the Department left blank would
// be saved as offline physiotherapy and vanish from the board that created it. That is the
// same disappearance this whole path is fixing, one step further along.
//
// Kept in step with DEPARTMENT_OPTIONS and VERTICAL_MAP in components/CreateLeadModal.jsx,
// and through them with ONLINE_ARM_PRACTICE in backend/deps.py, which is what reads the
// vertical back.
//
// Keyed by the arm's practice rather than by the role that runs it, because the board is
// now reached two ways -- the arm's own admin, and a Super Admin on the arm's branch tile
// -- and only one of those has a role that names the arm. See armPracticeOf.
const ARM_DEPARTMENT = {
  physio: "online_physio",
  fitness: "online_fitness",
};

/**
 * Does this lead belong under this Branch stage?
 *
 * Nearly always a branch_stage comparison. The exception is the "Leads" pill, which the
 * board sends down carrying `mirrors_stage`: it claims every lead still sitting at the
 * branch's own opening (`unmoved_branch_stage`, i.e. "Branch Assign"), and lets go of them
 * the moment the branch moves them anywhere.
 *
 * It used to require the second half as well — that the lead was ALSO an unworked Pre-Sales
 * New Lead, which is where the pill's name comes from. That half was dropped when the
 * branch's own entry stage lost its pill to this one (see leadPillStages): the strip has a
 * single opening now, so the pill has to hold everyone standing in it. A branch that was
 * switched off Pre-Sales control carries leads rehomed onto Branch Assign with their old
 * Pre-Sales stage still on them (realign_branch_stage_leads), and under the old two-part
 * match those leads would now belong to no pill at all.
 *
 * The third exception is a lead the consultation pipeline has taken over. This board shows
 * both pipelines as one strip, and nothing writes branch_stage again once the appointment is
 * booked — so a patient the consultant had already seen went on being counted under
 * Appointment as well as under Consultation Visit, with the row's own chip (rowStageName)
 * saying one thing and the pill it was listed under saying the other. Moving forward in the
 * consultation pipeline takes the lead out of the Branch pills, the same way moving forward
 * in the Branch pipeline already takes it out of the mirrored Leads pill.
 *
 * The other exception is Completed, which is now read off the lead rather than written —
 * the same rule and the same isCourseComplete the Consultations board already shows that
 * stage through, so the two pill sets sharing one row cannot say different things about
 * the same patient. A finished patient therefore leaves whichever stage they were parked
 * in, which is what this pipeline could never do on its own: every other stage in it is
 * set by a Branch Admin acting on the patient, and nobody acts on a branch board when a
 * course ends on a physio's or a Nutritionist's.
 */
export const matchesBranchStage = (lead, stage, isConsultationOnlyStage = () => false, consultationOpeningStage = null) => {
  const name = stage?.name;
  const here = lead.branch_stage;
  // Cancel is an abandonment rather than an ending, so it keeps whatever it holds and is
  // never read as finished. Both spellings: this pipeline stores "Cancelled" and the
  // consultation one is named "Cancel", and the two pill sets are shown in one row.
  //
  // Writing a lead off as never having been a prospect is the same kind of stop, and needs
  // the same exemption for the same reason: the branch usually reaches that conclusion
  // after the appointment, by which point a consultant may have moved the patient along
  // the consultation pipeline -- and handedOver below would drop the lead out of the pill
  // that was just set on it. Named as a literal rather than by role because this function
  // is module-level and has no stage list to ask; a renamed stage loses the exemption the
  // same way Cancelled beside it would.
  const abandoned = here === "Cancelled" || here === "Cancel" || here === "Not a prospect";
  const finished = !abandoned && isCourseComplete(lead);
  // Only the Consultation-ONLY stages hand a lead over — a name both pipelines share gets a
  // single pill backed by the sales-side field, so releasing on one would drop a lead out of
  // the Branch pills with nothing on the Consultation tab left to hold it.
  //
  // Except the consultation pipeline's opening stage, which hands nothing over. Booking an
  // appointment seeds it, and booking is the Appointment pill's own work rather than the
  // consultant moving the patient on — so releasing on it would empty the pill of exactly
  // the leads it exists to hold. It used to be shared with the Branch pipeline (both were
  // called "Follow Up"), so the shared-name rule above was what kept it out of this test;
  // once it was renamed to a name of its own it fell in, and the guard has to be said out
  // loud instead.
  //
  // The name is passed in rather than written here: Pipeline Stage Management can rename
  // it, and a literal that stopped matching would empty the pill silently.
  const atConsultationOpening = !!consultationOpeningStage
    && lead.consultation_stage === consultationOpeningStage;
  const handedOver = !abandoned
    && !atConsultationOpening
    && isConsultationOnlyStage(lead.consultation_stage);
  // Completed is read off the lead here the way it already is on the Consultations board,
  // rather than waiting for somebody to move them. This pipeline is otherwise written
  // entirely by hand, and nothing in it was ever going to be written when a course ended
  // somewhere else — a patient whose treatment the physio closed, or whose diet report and
  // chart had both gone out, sat under whichever stage the branch last set, which for this
  // one was the Appointment they had already been to.
  //
  // Still claims anyone moved there by hand, so the leads already sitting in Completed
  // stay in it whether or not the lead reads as finished.
  if (name === "Completed") return finished || here === "Completed";
  // And a finished patient — or one the consultation pipeline has moved on — leaves every
  // other pill, which is the half that makes the first half true: a lead counted under both
  // Appointment and Consultation Visit is not a pipeline, and the counts across the row
  // would add up to more than the branch has.
  if (finished || handedOver) return false;
  if (!stage?.mirrors_stage) return here === name;
  return here === stage.unmoved_branch_stage;
};

/**
 * Confirm a delete by typing the word.
 *
 * A count and an OK button is the shape of dialog people learn to dismiss, and this one
 * cannot be undone. Typing DELETE costs a second and cannot be done by muscle memory, so
 * the agreement is to this particular delete rather than to dialogs in general.
 *
 * The names are listed rather than only counted. "Delete 47 patients" is a number; the
 * list is what lets someone notice a real patient among the junk before it goes.
 *
 * `purge` is the row's own bin icon: the patient goes whatever they are carrying, treatment
 * slots and collected payments included. The select-many bar leaves it off, so a real
 * patient swept up with an import is refused and named instead. Same dialog either way
 * because the confirmation is the same act — but the two say different things about what
 * survives, and that difference is the whole reason to read it.
 */
function BulkDeleteLeadsModal({ leads, onClose, onDeleted, purge = false }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = typed.trim().toUpperCase() === "DELETE";

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    try {
      const res = await bulkDeleteLeads(leads.map((l) => l.id), typed.trim().toUpperCase(), purge);
      const blocked = res.blocked || [];
      if (res.deleted > 0) toast.success(`${res.deleted} patient${res.deleted > 1 ? "s" : ""} deleted`);
      // Kept apart from the success line: the ones that survived are the point of the
      // message, and folding both into one toast buries them.
      if (blocked.length) {
        const why = [...new Set(blocked.map((b) => b.reason))].join("; ");
        toast.error(`${blocked.length} kept — ${why}`, { duration: 8000 });
      }
      if (!res.deleted && !blocked.length) toast.error("Nothing was deleted");
      onDeleted(res);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white shadow-2xl" data-testid="branch-bulk-delete-modal">
        <div className="border-b p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold text-rose-700">
            <Trash2 className="h-4 w-4" /> Delete {leads.length} patient{leads.length > 1 ? "s" : ""}?
          </h3>
          <p className="mt-1 text-[11px] text-slate-500">
            {purge
              ? "This removes the patient and everything of theirs — treatment slots, collected payments, appointments, reviews, documents and portal login. It cannot be undone."
              : "This removes them and their activity, follow-ups and appointments. It cannot be undone."}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Being deleted</p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="branch-bulk-delete-list">
            {leads.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="truncate font-medium text-slate-700">{l.name || "Unnamed"}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">{l.patient_number || l.phone || "—"}</span>
              </li>
            ))}
          </ul>
          {purge ? (
            <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-800" data-testid="branch-delete-purge-warning">
              Treatment sessions and collected payments go too. Nothing is kept back, and the
              finance figures this patient is counted in will change.
            </p>
          ) : (
            <p className="mt-3 text-[11px] text-slate-500">
              Anyone with treatment sessions or collected payments is kept — they are a patient with a
              record, not an import to clear. You will be told which.
            </p>
          )}
        </div>

        <div className="border-t p-4">
          <label className="mb-1.5 block text-xs font-medium text-slate-600">
            Type <b className="font-mono text-rose-700">DELETE</b> to confirm
          </label>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && armed && !busy) run(); }}
            placeholder="DELETE"
            autoFocus
            className="font-mono"
            data-testid="branch-bulk-delete-input"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              onClick={run}
              disabled={!armed || busy}
              className="bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              data-testid="branch-bulk-delete-confirm"
            >
              {busy ? "Deleting..." : `Delete ${leads.length}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// `roleLabel` / `onLogout` are for the phone bar's My Profile stop, which opens the page in
// the board's place (so the bar stays under it) with Logout on its Security tab.
export const BranchAdminBoard = ({ branchId, embedded = false, branchPicker = null, currentUser = null, canTransferBranch = false, roleLabel = "", onLogout }) => {
  const [boardData, setBoardData] = useState({ leads: [], stage_counts: {}, stages: [] });
  const [consultationStages, setConsultationStages] = useState([]); // dynamic Consultation Stages, merged into the same stage bar
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Phone only: the toolbar's search is an icon until tapped. Desktop's field is always
  // open and ignores this.
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState(null);
  const [activeView, setActiveView] = useState("pipeline");
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [consultationsSubTab, setConsultationsSubTab] = useState("head_physio");
  const [stageFilter, setStageFilter] = useState(null); // null = show all stages
  const [dateFilter, setDateFilter] = useState(null); // { from, to, label, key } | null
  // The board's own horizontal range row — All / Today / This Week / This Month / Last
  // 90 Days. Kept in its own state rather than sharing the one
  // above so the toolbar's date filter is left exactly as it was: pressing a range here
  // does not rewrite that control's label, and clearing that control does not undo the
  // range picked here. The two combine below.
  //
  // Opens on Today rather than All. The board is read at the desk it belongs to, and the
  // question being asked of it in the morning is who is coming in and who rang -- not the
  // whole book back to the branch's first patient, which is what All is and which takes a
  // scroll and a filter before it answers anything. Every other range is one press away,
  // All included.
  const [quickDate, setQuickDate] = useState(() => quickDatePreset("today")); // same shape; null = All
  // The toolbar's dropdowns, keyed as this board's filter list is -- { pain_type,
  // pain_duration, city } on a branch, { looking_for, start_when, city } on an online
  // arm -- each holding the lowercased answer to match on, or "" for
  // the whole list. Lowercased because a sheet is not a controlled vocabulary: the same
  // answer arrives as "Online" from one form and "online" from the next, and matching on
  // what was typed would make those two different filters. City needs this as much as any
  // of them: "chennai" and "Chennai" are one town written by two people.
  const [listFilters, setListFilters] = useState({});

  // Bumped by Refresh. loadBoard only reloads the branch leads; on a consultation stage
  // the rows on screen come from ConsultationsBoard, which needs telling separately.
  const [refreshTick, setRefreshTick] = useState(0);
  const [showCreateLead, setShowCreateLead] = useState(false);
  // Ticked rows in the leads table, and the confirm dialog they feed. A Set because this
  // is asked "is this row ticked" once per row on every render, and 2,000 rows against an
  // array is 2,000 scans of it.
  const [picked, setPicked] = useState(() => new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  // One patient off the row's Action cell. Same branch-scoped endpoint as the bulk bar, but
  // asked to purge: this one takes the patient's treatment slots and collected payments
  // with them rather than refusing over them. That is what it is for — a record that is
  // wrong all the way through cannot be cleared by a delete that steps around its middle.
  const [rowDelete, setRowDelete] = useState(null);
  // The roles that endpoint accepts (branch_admin's aliases included server-side). Anyone
  // else would only be shown a button that 403s.
  const deleteRoleAllowed = ["super_admin", "business_dev", "branch_admin", "online_physio_admin", "online_fitness_admin",
    "branch_admin_physio", "branch_admin_fitness", "branch_admin_physio_fitness"]
    .includes(String((currentUser || loadSession()?.user)?.role || "").trim().toLowerCase());
  // ...and the developer switch in Super Admin > Pipeline Stages > Danger Zone, which the
  // board carries on every load. `!== false` rather than a truth test so the button is not
  // pulled out from under the desk for the moment before the first board arrives — absent
  // reads as on, which is what the server defaults to as well.
  const canDeleteLeads = deleteRoleAllowed && boardData.lead_delete_enabled !== false;
  // Set when a lead's own detail popup hands off to a Consultation-only stage — tells the
  // embedded ConsultationsBoard which lead to auto-open once it loads, so the handoff lands
  // straight on that lead's own rich modal instead of just the filtered list.
  const [autoOpenLeadId, setAutoOpenLeadId] = useState(null);

  // The bell's number, kept beside the board rather than inside it: the count is wanted
  // on every tab, and the board it belongs to is only mounted while somebody is looking
  // at it.

  // Whether this board is scoped to an arm rather than to a branch. An online admin has no
  // branch_id — an online arm is not a branch record and its leads carry a vertical instead
  // of a branch — so asking /branch-board for branch "" is asking for nothing, which is
  // what this board did and why both online admins saw an empty table with no explanation.
  const armScoped = runsWithoutARoom(currentUser?.role);

  /**
   * Whether the board on screen belongs to one of the online arms, however it was reached.
   *
   * armScoped answers this for the arm's own admin and only for them: it reads the LOGIN's
   * role. A Super Admin opening the same arm through Operations is a super_admin looking at
   * a branch tile, so armScoped is false there and the board would head an arm's patients
   * with a walk-in branch's columns.
   *
   * The branch record answers it for everyone else. Its `vertical` is where every other
   * board reads this same question, rather than the branch's name -- that is typed by hand,
   * and on this install reads "Online Physiotheraphy".
   *
   * Fetched here rather than handed in: three boards mount this one, and each would have to
   * remember to pass it. Until it resolves the board draws the branch columns, which is the
   * right way to be wrong for a moment -- most boards are branches, and the arm's own admin
   * is already answered by armScoped without waiting for a request.
   */
  const [branchVertical, setBranchVertical] = useState(null);
  useEffect(() => {
    if (!branchId) { setBranchVertical(null); return undefined; }
    let cancelled = false;
    getBranches()
      .then((rows) => {
        if (!cancelled) setBranchVertical((rows || []).find((b) => b.id === branchId)?.vertical || null);
      })
      .catch(() => { /* the list keeps the branch columns */ });
    return () => { cancelled = true; };
  }, [branchId]);
  // "fitness" | "physio" | null. The two arms ask their patients different things, so this
  // decides the columns rather than a plain is-an-arm boolean would.
  const armPractice = armPracticeOf(currentUser?.role, branchVertical);
  const onArmBoard = !!armPractice;
  const intakeQuestions = armPractice === "fitness" ? FITNESS_ARM_INTAKE_QUESTIONS
    : armPractice === "physio" ? PHYSIO_ARM_INTAKE_QUESTIONS
      : BRANCH_INTAKE_QUESTIONS;
  const toolbarFilters = armPractice === "fitness" ? FITNESS_ARM_TOOLBAR_FILTERS
    : armPractice === "physio" ? PHYSIO_ARM_TOOLBAR_FILTERS
      : BRANCH_TOOLBAR_FILTERS;

  const loadBoard = useCallback(async () => {
    // Only a branch board needs a branch. Returning here used to be silent, which is how an
    // admin with no branch got "No patients yet." — the table's empty state standing in for
    // an answer to a question the board had never asked.
    if (!branchId && !armScoped) {
      setBoardData({ noScope: true });
      return null;
    }
    setLoading(true);
    let data = null;
    try {
      data = armScoped ? await getArmBoard() : await getBranchBoard(branchId);
      setBoardData(data);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to load branch board");
    }
    setLoading(false);
    return data;
  }, [branchId, armScoped]);

  // The two hand-made marks on a row: VIP, and needs attention. Patched into the list in
  // place rather than reloading the board — this is a click on one row of a list that can
  // run to thousands, and a full refetch would scroll-jump the person who pressed it.
  //
  // Only the flag that changed is sent, so pressing the star cannot also rewrite an
  // attention mark a colleague set a moment ago.
  const toggleLeadFlag = async (lead, field) => {
    const next = !lead[field];
    // Shown immediately and put back if the server refuses: a mark that lags a click reads
    // as a dead button and gets pressed again.
    setBoardData((b) => ({ ...b, leads: (b.leads || []).map((l) => (l.id === lead.id ? { ...l, [field]: next } : l)) }));
    try {
      await setLeadFlags(lead.id, { [field]: next });
    } catch (err) {
      setBoardData((b) => ({ ...b, leads: (b.leads || []).map((l) => (l.id === lead.id ? { ...l, [field]: !next } : l)) }));
      toast.error(err?.response?.data?.detail || "Couldn't save that mark");
    }
  };

  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { stagesList("consultation").then(setConsultationStages).catch(() => {}); }, []);

  // Branch Stages come with the board rather than from /stages, because which ones this
  // branch has depends on its Lead Control: a branch running its own leads opens at Branch
  // Assign and has an RNR stage, one fed by the Pre-Sales desk opens at New Appointment and
  // has neither. Arriving on the same response as lead_control keeps the strip and the tabs
  // describing the same mode — a separate fetch would briefly disagree after a flip.
  const stages = useMemo(() => boardData.stages || [], [boardData.stages]);

  // Guarded the same way, and for a sharper reason than a slow first paint: the board
  // response is not always a board. The no-scope case sets { noScope: true } on purpose
  // (see loadBoard), so `leads` is missing exactly when the "pick a branch" notice is the
  // thing to draw -- and every memo below runs before that notice does. A server response
  // that omits the key does the same. Reading this instead of the raw field is what makes
  // a lead-less response draw the notice rather than throw on .filter.
  const leads = useMemo(() => boardData.leads || [], [boardData.leads]);

  const stageColor = useCallback(
    // Both pipelines: a row's chip can now name a consultation stage, and looking only in
    // the sales list would have found no colour and painted it the grey of a stage nobody
    // recognises.
    (name) => (stages.find((s) => s.name === name) || consultationStages.find((s) => s.name === name))?.color || "#64748b",
    [stages, consultationStages],
  );

  // The two ways a lead can open its journey on this board: the mirrored Pre-Sales "Leads"
  // pill, and the branch's own real entry stage ("Branch Assign", or "New Appointment" on
  // Pre-Sales control). Both are pre-physio, so both drop the Physio column; a lead's popup
  // shows whichever of the two it came in through, never both.
  const mirrorStage = useMemo(() => stages.find((s) => s.mirrors_stage) || null, [stages]);
  const realEntryStage = useMemo(() => stages.find((s) => !s.mirrors_stage) || null, [stages]);

  // What a row's Stage chip should say.
  //
  // The consultation stage when the lead has one. This read branch_stage alone, which
  // stops at Appointment Date & Time the moment the appointment is booked and never moves
  // again -- so a patient whose consultation was done, whose fee was collected and whose
  // physio was assigned still read "Appointment" on this board, for good. The stage bar
  // above already spans both pipelines and counts those leads under Consultation Visit,
  // Fee Collected and Physio Assign; only the chip was still reading the first half of the
  // journey.
  //
  // Except where the branch stage is a final one. Cancelling an appointment leaves
  // consultation_stage exactly where it was, and that the lead was cancelled is the more
  // important thing to say about them than wherever their consultation had reached.
  //
  // And except at the branch's own opening, which reads "Leads" wherever the row is
  // listed -- not only under the Leads pill, as this once did. That pill is the whole of
  // the opening on the strip now (see leadPillStages), so a chip saying "Branch Assign"
  // would name a stage the bar above has no pill for: nothing to click, and nothing to
  // tell the reader which pill their row is counted under.
  const showingMirror = !!mirrorStage && stageFilter === mirrorStage.name;
  // Is this lead standing at that opening? Only meaningful on a branch running its own
  // leads; a Pre-Sales-fed branch has no mirror pill and keeps naming its entry stage.
  const atBranchOpening = useCallback(
    (lead) => !!mirrorStage && !!lead?.branch_stage && lead.branch_stage === realEntryStage?.name,
    [mirrorStage, realEntryStage],
  );
  // Which branch stages the chip says instead of the consultation stage underneath. Every
  // is_final one, plus Not a prospect -- which is deliberately not final (it keeps its pill
  // on the strip; see leadPillStages) but stops the lead just as squarely. Without it a
  // written-off lead whose consultation had moved on would be listed under the Not a
  // prospect pill while its own chip read "Consultation Visit", which is the exact
  // disagreement the note above describes for a cancellation.
  const finalBranchStages = useMemo(
    () => new Set(
      stages
        .filter((s) => s.is_final || stageHasRole(s, STAGE_ROLE_NOT_A_PROSPECT))
        .map((s) => s.name),
    ),
    [stages],
  );
  const rowStageName = useCallback(
    (lead) => {
      if ((showingMirror || atBranchOpening(lead)) && lead.branch_stage) return mirrorStage.name;
      if (lead.branch_stage && finalBranchStages.has(lead.branch_stage)) return lead.branch_stage;
      // Finished, and no stage field anywhere says so — nothing writes "Completed" onto a
      // lead, which is why both pill sets read it off the patient instead. The chip has to
      // read it the same way or a row listed under Completed sits there saying Fee
      // Collected. Cancelled leads are already answered by the final-stage line above.
      if (lead.consultation_stage !== "Cancel" && isCourseComplete(lead)) return "Completed";
      return lead.consultation_stage || lead.branch_stage;
    },
    [showingMirror, atBranchOpening, mirrorStage, finalBranchStages],
  );
  const entryStageNames = [mirrorStage?.name, realEntryStage?.name].filter(Boolean);

  /**
   * Whether the list draws its Follow Up column: the date and time of the call this
   * patient is waiting on.
   *
   * Only while the reader is standing on that stage. It is the one column that is the
   * whole of what a stage is for — a branch working Follow Up is working a diary, and on
   * every other stage it would be a column of dashes taking width from the ones being
   * read. This is how the strip's other stage-shaped columns already behave; see
   * Pre-Sales' LAST CALL, drawn on RNR and nowhere else.
   *
   * Matched by role first and loosely on the name after it. Pipeline Stage Management can
   * rename this stage, and a literal "Follow Up" would silently drop the column the day
   * somebody typed "Followup" into it — the lead card's own preview reads it the same
   * loose way (see atFollowUpStage).
   */
  const showFollowUpColumn = useMemo(() => {
    if (!stageFilter) return false;
    return stageFilter === stageNameForRole(stages, STAGE_ROLE_FOLLOW_UP)
      || /follow\s*-?\s*up/i.test(stageFilter);
  }, [stageFilter, stages]);

  // The column widths this list is drawn at, chosen once for the header and the rows
  // together — a row that disagreed with the header about how many columns there are
  // slides every cell after it a column across.
  const listWidths = (showFollowUpColumn ? BRANCH_LIST_WIDTHS.withFollowUp : BRANCH_LIST_WIDTHS.base);
  const armWidths = (showFollowUpColumn ? ARM_LIST_WIDTHS.withFollowUp : ARM_LIST_WIDTHS.base);
  // The fixed columns on an arm's table take their stated share; the questions divide what
  // is left, however many the arm asks. An inline width rather than a class because
  // Tailwind compiles the classes it can see in the source, and this one is arithmetic.
  const armQuestionWidth = `${armWidths.questionShare / (intakeQuestions.length || 1)}%`;

  // A stage the Consultation pipeline owns and the Branch one does not. Any name the two
  // share stays on the Branch side and is backed by the sales field, so one name never gets
  // a pill on both bars answering off different columns. This is why the consultation
  // pipeline's opening stage had to stop being called "Follow Up" — see
  // BRANCH_CONSULTATION_OPENING_STAGE above.
  const consultationOnlyStages = useMemo(
    () => consultationStages.filter((cs) => !stages.some((s) => s.name === cs.name)),
    [stages, consultationStages],
  );

  // Which card the Consultation tab defaults to -- see BRANCH_CONSULTATION_DEFAULT_STAGE.
  // Resolved against the cards that actually exist rather than named as a literal, so a
  // renamed stage leaves this tab landing on a card instead of on nothing. Null only while
  // the stage list is still on its way from the server.
  const consultationDefaultStage = useMemo(() => {
    const pick = (name) => consultationOnlyStages.find((st) => st.name === name);
    return (
      pick(BRANCH_CONSULTATION_DEFAULT_STAGE)
      || pick(BRANCH_CONSULTATION_OPENING_STAGE)
      || consultationOnlyStages[0]
    )?.name || null;
  }, [consultationOnlyStages]);

  // Where the consultation pipeline begins, read off the live list rather than named as a
  // literal — Pipeline Stage Management can rename it. Handed to matchesBranchStage, which
  // must not release a lead from the Branch pills for merely standing here: see the guard
  // in it. The constant is the fallback for the moment before the list has arrived.
  const consultationOpeningStage = useMemo(
    () => consultationStages[0]?.name || BRANCH_CONSULTATION_OPENING_STAGE,
    [consultationStages],
  );

  // Branch Consultation's Cancel stage, lent to the Branch Leads card as its Cancel pill.
  // Linked rather than copied: the stage lives in the consultation pipeline only, so a
  // lead cancelled from Branch Leads is counted under that pipeline's Cancel card and not
  // under a second, Branch-side stage of the same name. By name because the backend's
  // move endpoint treats "Cancel" as the side-exit by name too.
  const consultationCancelStage = useMemo(
    () => consultationStages.find((s) => s.name === CONSULTATION_CANCEL_STAGE) || null,
    [consultationStages],
  );

  // Which of the Branch stages get a pill on the strip. Four of them: Leads, RNR, Follow
  // Up, Appointment — the shape the branch pipeline was built to mirror in the first place
  // (see BRANCH_ADMIN_ENTRY_STAGE in the backend's constants.py).
  //
  // Only the strip. The pipeline itself is untouched: every stage dropped here is still a
  // real position, still written to leads, still on the lead card's own Pipeline Stage row,
  // and still counted in All Stages. What changes is which of them the reader can filter by.
  //
  //   - The branch's own entry stage ("Branch Assign") hands its pill to Leads, which now
  //     claims everyone sitting there (see matchesBranchStage). They were two pills over
  //     one position — one named for the position, one for the lead standing in it.
  //   - Portfolio comes off. It is reached by its own scheduling dialog, not by the strip.
  //   - So does the final stage ("Cancelled"), for the same reason: cancelling happens in
  //     the appointment dialog and on the lead card, and the pill only ever showed the
  //     leftovers.
  //
  // Gated on there being a mirror pill at all, which is to say on the branch running its
  // own leads. A Pre-Sales-fed branch has no Leads pill to hand the opening to, so its
  // strip is left exactly as it was.
  const leadPillStages = useMemo(() => {
    if (!mirrorStage) return stages;
    return stages.filter((s) => s.mirrors_stage || (
      s.name !== realEntryStage?.name
      && !stageHasRole(s, STAGE_ROLE_PORTFOLIO)
      && !s.is_final
    ));
  }, [stages, mirrorStage, realEntryStage]);

  // The two bars used to be one. Branch Leads carried both pipelines end to end, which put
  // thirteen pills on a strip where the first six answer "has this lead been picked up"
  // and the rest answer "how is their treatment going" — one bar reading as one question
  // when it was two, and a patient counted under Leads and again under Fee Collected.
  //
  // Each tab now shows the stages its own pipeline owns, and the board under it is decided
  // by the tab rather than by which pill happens to be lit.
  const onHomeVisitTab = activeView === "branch_home_visit";
  const onConsultationTab = activeView === "branch_consultation" || onHomeVisitTab;

  // What the cards above the list do when one of them is clicked.
  //
  // StageTabBar toggles: a second click on the lit card asks for null, which on Branch
  // Leads means All Stages and has a card of its own. The Consultation bar has no such
  // card, so null there left every card unselected and the table showing the whole branch
  // -- leads that were never booked for a consultation included -- with nothing on screen
  // to press to get back. That reads as the board having lost its filter rather than as a
  // filter having been cleared on purpose.
  //
  // So on the Consultation tab a clear lands on the default card instead: clicking the lit
  // card is a no-op, clicking any other card moves the selection, and the tab is never
  // sitting on nothing. Branch Leads keeps toggling off, which is what All Stages is for.
  const selectStage = useCallback((next) => {
    setStageFilter(next === null && onConsultationTab ? consultationDefaultStage : next);
  }, [onConsultationTab, consultationDefaultStage]);
  // The same test asked of a lead's consultation_stage rather than of the lit pill: has this
  // lead reached the half of the strip the Branch pipeline does not own? Handed to
  // matchesBranchStage, which releases it from the Branch pills once it has.
  const isConsultationOnlyStage = useCallback(
    (name) => !!name && !stages.some((s) => s.name === name),
    [stages],
  );

  // Which mark the board is narrowed to, if any. Alongside the Date Filter and the search
  // rather than beside the stage pills: it narrows WHO is on the board, not where they are
  // in it, so a stage pill still means the same thing under it.
  const [markFilter, setMarkFilter] = useState(""); // "" | "vip" | "attention"

  // Which end of the list opens it. In the toolbar with the search, the ranges and the
  // marks because it is the same kind of control they are -- it says how the whole board
  // reads, not where a patient is in it -- and it applies to both tabs from the one place,
  // the way everything else on this row does.
  //
  // Newest first by default. Both lists arrive from the server in an order nobody chose to
  // read them in (newest-updated), and the branch's question at this toolbar is nearly
  // always about the patients who have just arrived, which on a board of eighteen booked
  // consultations means the ones a strict date order buries at the bottom. The Head
  // Physio's copy of ConsultationsBoard is untouched by this and still opens on the first
  // appointment of the day -- see the note beside `filtered` there.
  const [sortOrder, setSortOrder] = useState("newest"); // "newest" | "oldest"

  // Which tab has already been opened on its own stage. A ref rather than state: it only
  // decides whether the effect below acts, and a re-render because it changed would be a
  // render nobody is waiting for.
  const openedOn = useRef(null);

  // Two jobs when the tab changes, in order.
  //
  // First, drop a stage the new tab has no pill for. Left alone it would narrow the board
  // to a stage with nothing on screen naming it and no second click to clear it. A filter
  // the new tab *does* own survives, which is what lets a lead popup send the reader
  // straight to its Consultation stage without this undoing the trip.
  //
  // Then open the tab where its work actually starts -- Branch Leads on Leads,
  // Consultation on Consultation Visit -- rather than on the whole list. Both used to land
  // on All Stages, which on Branch Leads is 2325 rows of which 2261 are the Leads pill
  // anyway, so the first thing anybody did on arriving was press the pill they had just
  // been shown the total of.
  //
  // Nothing is decided until the pills exist. The stage list arrives from the server after
  // the first render, so on mount there is no name to open on yet; this re-runs when it
  // lands, and openedOn holds the opening to once per visit rather than once per reload --
  // which is also what stops a refresh from overriding somebody who pressed All Stages on
  // purpose.
  useEffect(() => {
    const consultation = activeView === "branch_consultation" || activeView === "branch_home_visit";
    const pills = consultation ? consultationOnlyStages : leadPillStages;
    if (pills.length === 0) return;

    const ownedHere = pills.some((st) => st.name === stageFilter);
    // Drop a stage this tab has no card for. Branch Leads clears to All Stages, which has a
    // card of its own to say so; the Consultation tab has no such card, so it drops to its
    // default instead of to nothing (see BRANCH_CONSULTATION_DEFAULT_STAGE) -- and takes an
    // empty filter as the same thing to be answered, whichever way it got there.
    //
    // Watching stageFilter rather than only the tab, because this fires long after the
    // opening below: a reload that renames a stage, or a lead popup deep-linking to a stage
    // with no card, both land here with the tab already opened. Left to the once-per-visit
    // opening they would sit on an empty filter for the rest of the visit.
    if (consultation) {
      if (stageFilter !== consultationDefaultStage && (!stageFilter || !ownedHere)) {
        setStageFilter(consultationDefaultStage);
      }
    } else if (stageFilter && !ownedHere) {
      setStageFilter(null);
    }

    if (openedOn.current === activeView) return;
    openedOn.current = activeView;
    // A stage the tab already owns was chosen for a reason -- a popup's deep link, or the
    // reader's own click on the way in -- and is not something to open over.
    if (ownedHere) return;
    // Branch Leads opens on the mirror pill, which is the one reading "Leads". A branch fed
    // by Pre-Sales has no mirror, so no Leads pill to open on, and keeps All Stages: the
    // whole list is the only honest opening where the strip has nothing else to offer.
    //
    // The Consultation tab opens on its default card, which resolves to whichever pill
    // comes first if the named ones have been renamed — that is what Pipeline Stage
    // Management is for — so it always lands on one. A literal that stops matching would
    // leave this tab with no pill lit, no All Stages card to say so (see hideAllStages) and
    // every patient in the list underneath: a bar of cards that between them count fewer
    // people than the table below is showing, which reads as the cards being wrong rather
    // than as nothing being selected.
    const opening = consultation
      ? pills.find((st) => st.name === consultationDefaultStage)
      : mirrorStage;
    if (opening) setStageFilter(opening.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, consultationOnlyStages, leadPillStages, mirrorStage, consultationDefaultStage, stageFilter]);

  // The toolbar's calendar, wired so that picking a date releases the range row back to
  // All.
  //
  // The two combine by overlap below, which is the right reading of two ranges somebody
  // set on purpose and the wrong reading of the gesture that replaces one of them.
  // Picking Sep 01 while Today is lit asks for Sep 01 and gets the overlap of two
  // different days: an empty list, under a bar of zeroes, with two date controls lit
  // above it. That reads as a broken board rather than as an answer, and the date just
  // picked is plainly the one being asked for.
  //
  // Only when a date is actually set, so the x on the chip still clears the calendar
  // alone — the row is already at All by then, and resetting it there would be resetting
  // nothing. One direction only: pressing a range up in the row leaves the calendar as it
  // was, so an exact day or a typed range is never thrown away by a control that cannot
  // express one.
  const applyDateFilter = (next) => {
    setDateFilter(next);
    if (next) setQuickDate(null);
  };

  // What the board is actually narrowed to. The toolbar's date filter and the range row's
  // quick pick are two independent controls over one list, so where both are set they
  // combine by overlap rather than one silently winning — each keeps showing its own
  // state, and the list under them is what the two agreed on. Picking a date on the
  // calendar is the one gesture that drops the other, for the reason above.
  //
  // Both tabs draw the range row now, so this no longer needs to branch on which one is
  // active: quickDate simply stays null wherever the row isn't mounted, and
  // intersectDateFilters(dateFilter, null) is just dateFilter.
  const effectiveDateFilter = useMemo(
    () => intersectDateFilters(dateFilter, quickDate),
    [dateFilter, quickDate],
  );

  const filteredLeads = useMemo(() => {
    let list = leads;
    if (effectiveDateFilter) {
      const from = effectiveDateFilter.from?.getTime();
      const to = effectiveDateFilter.to?.getTime();
      list = list.filter((l) => {
        const ts = new Date(l.created_at || 0).getTime();
        if (!ts) return false;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      });
    }
    if (searchQuery.trim()) {
      // Trimmed so a Patient Number pasted with a stray space (e.g. "ANN-260921-0001 ")
      // still matches; patient_number is the branch's own ID for the patient.
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((l) =>
        l.name?.toLowerCase().includes(q) || l.phone?.includes(q) || l.email?.toLowerCase().includes(q)
        || l.patient_number?.toLowerCase().includes(q)
      );
    }
    // Applied here, with the other two, rather than to the list alone. This used to narrow
    // only the rows and only on All Stages, on the reasoning that two narrowings at once --
    // each with its own count above it -- is a list nobody can account for. That reasoning
    // was right about the danger and wrong about the fix: drawn through the same memo the
    // counts are, every pill on the bar narrows with the list, so the row of counts still
    // describes exactly what is under it. Nothing is left saying otherwise, and a branch can
    // ask "which of my VIPs are in Fee Collected" on the stage where that is worked.
    if (markFilter === "vip") list = list.filter((l) => l.is_vip);
    else if (markFilter === "attention") list = list.filter((l) => l.needs_attention);
    // The toolbar dropdowns, in the same memo as everything else above them for the reason
    // the marks were moved into it: the stage counts are drawn from this list, so a
    // narrowing applied anywhere else would leave every pill on the bar standing over the
    // table saying a number that is no longer in it.
    for (const f of toolbarFilters) {
      const wanted = listFilters[f.key];
      if (!wanted) continue;
      list = list.filter((l) => f.answer(l).toLowerCase() === wanted);
    }
    // The toolbar's order, applied last so it orders whatever the narrowings left rather
    // than an order they then cut holes in.
    //
    // On `created_at` -- when the patient arrived -- because that is what this tab lists.
    // The board arrives newest-updated first, which is a change log's order: a lead
    // touched this morning to correct a phone number opens the list above one created an
    // hour ago, and "newest" then means something the reader cannot see on the row. The
    // date on the row is the arrival date, so that is the one the control sorts on.
    //
    // A copy, not a sort in place: boardData.leads is state, and Array.sort mutates. Sorting
    // it here would reorder the array React is holding without telling it, which is how a
    // list re-renders in an order that no longer matches the one it was given.
    const arrived = (l) => new Date(l.created_at || 0).getTime() || 0;
    list = [...list].sort((a, b) => (sortOrder === "newest" ? arrived(b) - arrived(a) : arrived(a) - arrived(b)));
    return list;
  }, [leads, searchQuery, effectiveDateFilter, markFilter, listFilters, toolbarFilters, sortOrder]);

  /**
   * What each dropdown offers: the answers this branch has actually given, not a list
   * written in advance.
   *
   * These are sheet columns. Nothing validates them, every branch words its own form, and
   * a hard-coded set of options would go quietly empty on the first branch that asks
   * "How long have you had this pain?" with different words in the answers.
   *
   * Read off the whole board rather than off the filtered list, so choosing one option
   * does not empty the others of everything the reader might switch to next.
   *
   * Answers differing only in case are one option, keeping the first spelling seen as the
   * label — otherwise "Online" and "online" sit in the list twice, and picking either one
   * hides the patients who arrived under the other.
   */
  const listFilterOptions = useMemo(() => {
    const out = {};
    for (const f of toolbarFilters) {
      const seen = new Map();
      for (const lead of leads) {
        const answer = f.answer(lead);
        if (!answer) continue;
        const k = answer.toLowerCase();
        if (!seen.has(k)) seen.set(k, answer);
      }
      // numeric so "3 months" sorts before "12 months" rather than after it, which is what
      // a plain string compare does and what makes a duration list read as shuffled.
      out[f.key] = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true, sensitivity: "base" }));
    }
    return out;
  }, [leads, toolbarFilters]);

  // The rows the table is actually showing. Hoisted out of the table body because the
  // select-all box and the delete bar have to agree with it exactly — "select all" that
  // picks up a row the stage filter is hiding deletes something nobody looked at.
  // The marks are already applied by filteredLeads above, so this is the stage pill and
  // nothing else.
  const visibleLeads = useMemo(() => {
    if (stageFilter) return filteredLeads.filter((l) => matchesBranchStage(l, stages.find((s) => s.name === stageFilter), isConsultationOnlyStage, consultationOpeningStage));
    return filteredLeads;
  }, [filteredLeads, stageFilter, stages, isConsultationOnlyStage, consultationOpeningStage]);

  // A tick survives scrolling and reopening a row, but not a change to what is on screen.
  // Searching, filtering by date or switching stage replaces the list under the selection,
  // and a delete confirmed against rows the person can no longer see is one they cannot
  // check before agreeing to it.
  useEffect(() => { setPicked(new Set()); }, [stageFilter, effectiveDateFilter, searchQuery, activeView, markFilter, listFilters]);

  const pickedVisible = useMemo(
    () => visibleLeads.filter((l) => picked.has(l.id)),
    [visibleLeads, picked],
  );

  // No per-row tick any more, so nothing calls a toggle. The rest of the selection is
  // left standing: pickedVisible, the count bar and the bulk-delete dialog are whole and
  // correct, and want only a control to set the selection from. Deleting them would be
  // throwing away a working feature to tidy up after removing its only button.
  // Summary card counts follow the Date Filter (and search) too, instead of always
  // reflecting the branch's all-time totals — so the cards actually describe what's in
  // the table below them right now.
  const salesCounts = useMemo(() => {
    const counts = {};
    stages.forEach((s) => { counts[s.name] = filteredLeads.filter((l) => matchesBranchStage(l, s, isConsultationOnlyStage, consultationOpeningStage)).length; });
    return counts;
  }, [filteredLeads, stages, isConsultationOnlyStage, consultationOpeningStage]);
  // The Consultation pills are counted by the board that draws the rows under them, not
  // here. This memo used to do it off `filteredLeads`, which is this board's own list
  // narrowed by the Date Filter on `created_at` -- and ConsultationsBoard narrows the same
  // leads by `appointment_date`, because a consultation is worked on the day it is
  // attended rather than the day the record was made. The two answered different
  // questions and the tab opens on Today, so a patient booked in for this morning and
  // entered last week was in the table with a bar of zeroes over it: eight cards reading 0
  // above a row that was plainly there.
  //
  // ConsultationsBoard already publishes exactly this through onCountChange -- its own
  // rows, after its own Date Filter, search and mark filter, counted by its own stage
  // matcher. Reading it from there is what makes a pill's number and the list it opens the
  // same list by construction, rather than two implementations kept in step by hand.
  const [consultationCounts, setConsultationCounts] = useState({});
  // Stable across renders, so ConsultationsBoard's reporting effect doesn't re-fire on
  // every parent render -- it lists this callback among its dependencies, and an inline
  // arrow would make each render schedule the next one. The counts are replaced only when
  // they actually differ, for the same reason: a fresh object every time would re-render
  // the whole board on each report for no change on screen.
  const handleConsultationCounts = useCallback((_total, counts) => {
    setConsultationCounts((prev) => {
      const keys = Object.keys(counts);
      const same = keys.length === Object.keys(prev).length
        && keys.every((k) => prev[k] === counts[k]);
      return same ? prev : counts;
    });
  }, []);

  // Held for the same reason handleConsultationCounts above is: the consultations board is
  // memoised, and an arrow written inline at the mount is a new prop on every render of
  // this board -- which is often, since forty-odd pieces of state up here have nothing to
  // do with that list. Handing it a fresh one each time would re-render the whole of it.
  const clearAutoOpenLead = useCallback(() => setAutoOpenLeadId(null), []);

  // "All Stages" is the count of every lead matching the active Date Filter/search —
  // every lead in the branch when neither is set.
  const totalLeads = filteredLeads.length;

  const handleStageUpdate = async () => {
    const data = await loadBoard();
    if (selectedLead && data) {
      const updated = data.leads?.find((l) => l.id === selectedLead.id);
      if (updated) setSelectedLead(updated);
    }
  };

  // `short` is what the bottom nav shows — six full labels will not fit across a phone,
  // and a truncated "Accountant Ma…" reads worse than a word chosen to be short.
  const VIEW_TABS = [
    { key: "pipeline", label: "Branch Leads", short: "Leads", icon: LayoutDashboard },
    // Empty on purpose for now: the tab is the navigation going in ahead of what will sit
    // behind it, so the position is settled while the panel is still being decided.
    //
    // `branch_consultation`, not `consultation`, because `consultations` two rows down is
    // already taken — by the tab labelled Management, for historical reasons. Two keys a
    // single letter apart, both compared as strings against activeView, is a bug waiting
    // for whoever types the wrong one; there is nothing to make it announce itself.
    { key: "branch_consultation", label: "Consultation", short: "Consult", icon: HeartPulse },
    // The same board as Consultation, holding the bookings made as a House Visit — the
    // consultant goes to the patient. A lead lands here the moment its appointment is
    // booked with that visit type, and Consultation stops listing it.
    { key: "branch_home_visit", label: "House Visit", short: "House", icon: Home },
    // Sits next to Branch Leads because it is the other list of people the branch is
    // signing up — but its own list, not a stage of theirs: nobody registering for a
    // Zumba class is consulted, treated or discharged.
    { key: "zumba", label: "Zumba", short: "Zumba", icon: Music },
    // Beside Zumba because both are class-based memberships the branch sells and
    // renews, rather than treatment a patient is referred for.
    { key: "fitness", label: "Fitness", short: "Fitness", icon: Dumbbell },
    { key: "review", label: "Review", short: "Review", icon: ClipboardCheck },
    { key: "consultations", label: "Management", short: "Manage", icon: Stethoscope },
    { key: "patients", label: "Patients", short: "Patients", icon: User },
    // What this branch's clients rated their Consultant and Physio in the Client Portal.
    // The same panel HR Admin shows Super Admin and BDE, held to this one branch.
    { key: "client_reviews", label: "Client Reviews", short: "Ratings", icon: Star },
    { key: "accountant_mgmt", label: "Accountant Manage", short: "Accounts", icon: BadgeIndianRupee },
    // Named as Super Admin names it. This tab is that page's catalogue read from a
    // branch, and calling the same shelves two different things left nobody able to say
    // whether the branch was looking at the same list.
    { key: "store", label: "Services and Products", short: "Services", icon: ShoppingCart },
    // The branch's kept records — Branch Transfer Records first, more to sit beside it.
    { key: "records", label: "Records", short: "Records", icon: FileText },
    // Taken off an online arm's own board, where the studio and the gym floor those two
    // desks run do not exist — see runsWithoutARoom.
    //
    // Off `currentUser`, which is only passed where somebody is looking at THEIR OWN
    // branch (pages/CRMPage.jsx). Super Admin, Operations and Branch-wise all mount this
    // board without one, and keep every tab: they are reading a branch rather than running
    // it, and an org-level view that hid a desk depending on whose branch was picked would
    // be answering a question about the viewer.
  ].filter((t) => !(ROOM_ONLY_TABS.includes(t.key) && runsWithoutARoom(currentUser?.role)));

  // The phone bar carries four of them plus More; the desktop strip above still shows
  // every one. Both halves come off VIEW_TABS, so a tab added there lands in one or the
  // other rather than being dropped -- and in VIEW_TABS order, which is what puts
  // Consultation between Leads and Review on the bar without a second list to keep in step.
  const bottomTabs = VIEW_TABS.filter((t) => BOTTOM_NAV_KEYS.includes(t.key));
  const moreTabs = VIEW_TABS.filter((t) => !BOTTOM_NAV_KEYS.includes(t.key));

  // Everything under MANAGEMENT — Experts and Calendar used to be their own
  // top-level tabs, and Manager used to sit one level deeper inside Calendar;
  // all three now live here alongside the two calendars.
  const MANAGEMENT_SUB_TABS = [
    { key: "head_physio", label: "Consultant Calendar", icon: Calendar },
    { key: "physio", label: "Physiotherapist Calendar", icon: Activity },
    // Zumba in the same place, because it answers the same question this row is asking —
    // who works here and when — in the shape Zumba actually has. A master does not publish
    // slots one booking at a time; there are two class times and somebody takes each.
    { key: "zumba", label: "Zumba", icon: Music },
    // Diet is the third vertical, so its calendar sits beside the other two rather than
    // anywhere new — the Branch Admin publishes a Nutrition Coach's days exactly the way
    // they publish a Physio's.
    { key: "diet", label: "Nutritionists Calendar", icon: Salad },
    // Sits next to PHYSIO CALENDAR because that is where its slots come from: a day an
    // absence left dateless is re-booked onto exactly the calendar published one tab over.
    { key: "missed", label: "Missed Classes", icon: UserX },
    // A physio who is off: the patients booked with them that day are handed to another
    // physio, or released to Missed Classes for a new date.
    { key: "physio_absence", label: "Physio Absence", icon: CalendarX },
    { key: "manager", label: "Manager", icon: UserCog },
    { key: "calendar", label: "Calendar", icon: Calendar },
    // Sits after CALENDAR because it is the setting the three calendars above obey: the
    // shift an expert is on is the window their day gets opened across. Last in the strip
    // rather than first for the same reason — it is configured once and then left alone,
    // while the calendars are worked in daily.
    { key: "time", label: "Time Management", icon: Clock },
  ];

  return (
    // flex+gap rather than space-y: Tailwind's space-y keys off the `hidden` *attribute*,
    // so the desk-only tab strip below — hidden by class — still counted as a sibling and
    // pushed the stage bar down 16px for an element a phone never renders. A display:none
    // child isn't a flex item at all, so its gap goes with it.
    //
    // Bottom padding on a phone so the last row of a list clears the fixed nav below.
    //
    // min-w-0 on the children because a flex item defaults to min-width:auto, which would
    // let the scrolling tab strip and the leads table widen the board instead of
    // scrolling inside it.
    <div className={`flex flex-col gap-4 [&>*]:min-w-0 ${embedded ? "" : "pb-20 md:pb-0"}`} data-testid="branch-admin-board-root">
      {/* View Tabs — desk only; a phone gets the bottom nav at the end of this file. */}
      <div className="show-scrollbar hidden items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 md:flex" data-testid="branch-view-tabs">
        {VIEW_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => { setProfileOpen(false); setActiveView(tab.key); }}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                activeView === tab.key
                  ? "bg-sky-600 text-white shadow-sm"
                  : "text-slate-500 hover:bg-sky-50 hover:text-sky-700"
              }`}
              data-testid={`branch-view-tab-${tab.key}`}
            >
              <Icon className="h-4 w-4" /> {tab.label}
            </button>
          );
        })}
        {/* The bell moved to the page header, where Super Admin's already was and where a
            person looks for it. One control, one place, rather than the same thing in two
            with only one of them findable. */}
      </div>

      {profileOpen && (
        <MyProfilePage user={currentUser} roleLabel={roleLabel} onBack={() => setProfileOpen(false)} onLogout={onLogout} phoneBar />
      )}

      {/* Hidden, not unmounted, while My Profile is open: `contents` keeps every view a
          flex child of the root as before, and the lists keep their state for the way back. */}
      <div className={profileOpen ? "hidden" : "contents"}>
      {activeView === "consultations" ? (
        <div className="space-y-4" data-testid="branch-consultations-headphysio">
          {/* Three across on a phone, so they land as even rows in the order they are
              declared. Left to wrap on their own they came out ragged — four rows, one of
              them holding HEAD PHYSIO CALENDAR alone — because each label is a different
              width. A grid ignores the widths and the icon moves above the label so a
              third of the screen is enough to read it. From sm up nothing changes: one
              flex row of full-size pills. */}
          <div className="grid auto-rows-fr grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:flex sm:flex-nowrap sm:gap-1 sm:overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="branch-consultations-subtabs">
            {MANAGEMENT_SUB_TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setConsultationsSubTab(t.key)}
                  className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-center text-[10px] font-semibold leading-tight transition sm:inline-flex sm:shrink-0 sm:flex-row sm:gap-1.5 sm:whitespace-nowrap sm:px-2.5 sm:text-sm sm:font-medium 2xl:gap-2 2xl:px-3 ${consultationsSubTab === t.key ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
                  data-testid={`branch-consultations-subtab-${t.key}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />{t.label}
                </button>
              );
            })}
          </div>
          {/* onlineArm rides along to each of them: an arm with no room in it meets its
              patients over video whichever desk they are seeing, so the Google Meet field
              is offered on all of these. Rehab declines it on its own — a programme day is
              worked on the floor with the equipment in the room. See HeadPhysioCalendar. */}
          {consultationsSubTab === "physio" ? (
            <HeadPhysioCalendar branchId={branchId} profileType="physio" onlineArm={armScoped} onOpenTimeManagement={() => setConsultationsSubTab("time")} />
          ) : consultationsSubTab === "zumba" ? (
            <ZumbaMastersPanel branchId={branchId} />
          ) : consultationsSubTab === "diet" ? (
            <HeadPhysioCalendar branchId={branchId} profileType="nutrition_coach" onlineArm={armScoped} onOpenTimeManagement={() => setConsultationsSubTab("time")} />
          ) : consultationsSubTab === "missed" ? (
            <MissedClassPanel />
          ) : consultationsSubTab === "physio_absence" ? (
            <PhysioAbsencePanel mode="branch" branchId={branchId} />
          ) : consultationsSubTab === "manager" ? (
            <BranchDetailPage branchId={branchId} readOnly />
          ) : consultationsSubTab === "calendar" ? (
            <BranchCalendarPanel branchId={branchId} />
          ) : consultationsSubTab === "time" ? (
            <TimeManagementPanel branchId={branchId} />
          ) : (
            // The Google Meet field rides on this: only an online arm's own admin is asked
            // for a video room, because only their consultations are held in one. The three
            // calendars above are room desks and never carry it — see HeadPhysioCalendar.
            <HeadPhysioCalendar branchId={branchId} onlineArm={armScoped} onOpenTimeManagement={() => setConsultationsSubTab("time")} />
          )}
        </div>
      ) : activeView === "zumba" ? (
        <ZumbaPanel branchId={branchId} />
      ) : activeView === "fitness" ? (
        <FitnessPanel branchId={branchId} />
      ) : activeView === "review" ? (
        <BranchReviewPanel branchId={branchId} />
      ) : activeView === "patients" ? (
        <PatientsPortalPanel branchId={branchId} />
      ) : activeView === "client_reviews" ? (
        <ClientReviewsPanel branchId={branchId} physioOnly branchPicker />
      ) : activeView === "store" ? (
        <FitsiomaxStorePanel branchId={branchId} />
      ) : activeView === "records" ? (
        <RecordsPanel branchId={branchId} />
      ) : activeView === "accountant_mgmt" ? (
        <AccountantManageTab branchId={branchId} />
      ) : (
        <>
          {/* Stage Head Bar — Pre-Sales style sticky segmented tabs, and the same block
              serves both tabs: the pills, the toolbar under them and the table are one
              screen answering to one filter, so the two tabs differ by which pipeline's
              stages the bar is given and which board sits underneath, and by nothing
              else. Two copies of this would be two toolbars to keep in step. */}
          <StageTabBar
            stages={onConsultationTab ? consultationOnlyStages : leadPillStages}
            stageFilter={stageFilter}
            setStageFilter={selectStage}
            counts={onConsultationTab ? consultationCounts : salesCounts}
            totalCount={totalLeads}
            // All Stages counts every lead on the branch, which is the Branch Leads
            // question. Over the Consultation pills it would head a row that only counts
            // patients who have reached treatment with a figure that includes those who
            // never will.
            hideAllStages={onConsultationTab}
            testid="branch-metric"
            plain
          />

          {/* One toolbar for every stage. It used to sit inside the non-consultation
              branch, so selecting a consultation stage swapped in ConsultationsBoard's
              own toolbar and Branch Leads lost Refresh, Create Lead and Pull from Sheet —
              the same screen offering four actions or two depending on which stage pill
              was lit. The consultations board is told to hide its toolbar (passing
              externalSearch does that) and is driven from here instead. */}
          {/* Six controls on a phone. Left as fields they need roughly 520px against the
              330 a phone gives, so the row either scrolled or squeezed the search to a
              stub — both were reported as broken.

              The search collapses to its icon instead, which is the Physio board's own
              answer to the same problem. That buys ~140px and the remaining five fit at
              full size; tapping it takes the whole row, since a search in use is the only
              thing you are doing. Desktop keeps the field open beside everything else. */}
          <div className="flex items-center gap-1.5 sm:gap-3" data-testid="branch-toolbar">
            {searchOpen ? (
              <div className="relative min-w-0 flex-1 sm:hidden">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  autoFocus
                  className="pl-9 pr-9"
                  placeholder={onHomeVisitTab ? "Search in House Visits..." : onConsultationTab ? "Search in Consultations..." : "Search patients..."}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="branch-search-mobile"
                />
                <button
                  type="button"
                  onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
                  className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-slate-100"
                  aria-label="Close search"
                  data-testid="branch-search-close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 sm:hidden"
                aria-label="Search patients"
                title="Search patients"
                data-testid="branch-search-open"
              >
                <Search className="h-4 w-4" />
              </button>
            )}
            {/* The desk's own field. min-w-0 so it can shrink: a flex item defaults to its
                content's width, which would shove the buttons off the right edge.

                Capped rather than left to take the whole row. A search box stretched across
                1400px is mostly empty runway — nobody types a patient name that long — and
                the width is better spent leaving the toolbar's controls grouped where the
                eye already is. The buttons keep their right edge via ml-auto below, so the
                row still reads as one bar rather than a short field with the actions
                drifting in to meet it. */}
            <div className="relative hidden min-w-0 flex-1 sm:block sm:max-w-sm">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                className="pl-9"
                placeholder={onHomeVisitTab ? "Search patients in House Visits..." : onConsultationTab ? "Search patients in Consultations..." : "Search patients..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="branch-search"
              />
            </div>
            {/* The one-tap ranges, in the toolbar beside the search rather than on a row
                of their own underneath: search, then ranges, then the actions, one
                horizontal line that never wraps.

                Desktop widths — the breakpoint and its arithmetic are in the note just
                below. Narrower ones keep the stacked row underneath instead. The same
                instance would have had to be two anyway: one row cannot be both in the
                toolbar and under it.

                shrink-0 so the search is what gives way when the row gets tighter. Shared
                by both tabs now — Branch Leads had no range row before, only the calendar
                icon further along, which is why the toolbar comment below still calls out
                that history. */}
            {/* From lg, which is where a desktop starts. It was min-[1440px], and before
                that 2xl, both cut to the arithmetic of a row that also had to hold the
                three intake dropdowns — so every desk between 1024 and 1440, which is most
                of them, read the toolbar the way it was reported: one line of controls
                with the ranges stranded on a second underneath it.

                The split is no longer where the dropdowns stop fitting, because the
                dropdowns now wait for xl (see their note below) instead of crowding this
                row from lg. What is left to fit at 1024 is the ranges (~330 tightened,
                see QuickDateFilterBar's `inline`) and the actions (~290), which leaves the
                search its full 384. At xl the dropdowns join and the search settles around
                180px, and every width above that gives it more.

                Both tabs, same breakpoint: the Consultation tab carries no dropdowns at
                all, so if this fits on Branch Leads it fits there with room to spare.
                Below lg the ranges keep their own row underneath, which is where every
                tablet and phone width has always had them and where they still belong —
                six controls and five ranges do not share 768px whatever they are cut to. */}
            <div className="hidden shrink-0 lg:block">
              <QuickDateFilterBar
                value={quickDate}
                onChange={setQuickDate}
                testid="branch-quick-date-inline"
                inline
                showCustom={false}
              />
            </div>
            {/* Pain Type, Pain Duration and City — the columns the list grew, now askable
                rather than only readable. In this row beside the search and the ranges
                rather than on a strip of their own: a second line of filters over a table
                is a second thing to scan before reaching the table, and this row is where
                every other narrowing on this board already lives.

                City sits last, after the intake questions, rather than beside Phone the
                way its column does. The column order is how a row reads — who, where,
                then what they came in with. The filter order is the order these arrived
                in, and re-cutting the row to match the table would move controls a branch
                already knows the position of in order to place one.

                Consultation Type was here and is not any more, dropped with its column.
                Removing it from the question list took the dropdown with the column in one
                edit, which is the whole point of the two being one list.

                Branch Leads only. The Consultation tab renders its own board underneath and
                these read a lead's intake answers, which is not what that tab lists.

                Each is hidden until the branch has at least one answer to it. A dropdown
                offering only "All Pain Types" is a control that cannot do anything, and a
                row of them is most of the toolbar spent saying nothing — which is the
                state every branch is in until its sheet carries these columns. City is the
                one most likely to be alone there: it reads the lead's own field as well as
                the sheet's spellings, so a branch whose source has been mapped gets the
                dropdown even where none of the intake questions are asked.

                From xl, not lg. They want ~400px that no narrower width has spare: at sm
                the search field has only just reappeared beside the actions, and adding
                these there would drive the row into overflow rather than shrink the
                search, which is the failure the collapse-to-an-icon was built to avoid.

                It was lg, and the ~400px it took at 1024 was the reason the date ranges
                could not join this row until 1440 — three dropdowns and five ranges do not
                both fit over a search field on a 1280 desk, and something had to drop to a
                second line. The ranges won that: they are on both tabs and every stage,
                these are on one tab and answer a question a branch asks occasionally. So
                between lg and xl the ranges now sit up here and these wait, and from xl
                the row holds all four groups with the search around 180px. Under xl the
                columns are still readable in the list; it is only asking that waits for
                the width.

                Widths are per filter (see toolbarFiltersFor) rather than one class for the
                row. The intake dropdowns take w-36 up to 2xl and w-40 from there; City
                takes the size below each, because its longest label is "All Cities" and
                its answers are single words. What the closed control reads is the
                all-label, and cutting the intake pair below w-36 brings back "All Pain
                Ty..." -- a filter naming no column, which is the one thing this row of
                dropdowns is for. City is the one with room to give: at w-24 it still
                spells "All Cities" out in full, and the ~16px that buys goes to the search
                at xl, where the row is tightest. */}
            {!onConsultationTab && (
              <div className="hidden shrink-0 items-center gap-1.5 xl:flex" data-testid="branch-list-filters">
                {toolbarFilters.map((f) => {
                  const options = listFilterOptions[f.key] || [];
                  if (options.length === 0) return null;
                  return (
                    <FilterSelect
                      key={f.key}
                      filter={f}
                      options={options}
                      value={listFilters[f.key] || ""}
                      onChange={(v) => setListFilters((p) => ({ ...p, [f.key]: v }))}
                    />
                  );
                })}
              </div>
            )}
            {/* Branch Wise's own picker, handed down so it sits in this row rather than in
                a bar of its own above it. Nothing renders here on a real Branch Admin's
                board — they have one branch and never pick.

                It steps aside while the search is open: the expanded field takes the row,
                and leaving these beside it would overflow again, which is the whole thing
                being fixed. */}
            {!searchOpen && branchPicker}
            {/* Icons only. The labels live on title/aria-label rather than being dropped,
                so hovering still says what each one does and a screen reader still
                announces it — an unlabelled glyph that announces nothing is a button only
                the person who built it can use.

                One row with the search at every width — the four of them trail it rather
                than dropping to a line of their own. shrink-0 keeps them at full size and
                lets the search give up the width instead; on the narrowest phones that
                leaves the placeholder clipped, which costs less than a second row. */}
            <div className={`${searchOpen ? "hidden sm:flex" : "flex"} shrink-0 items-center gap-1.5 sm:ml-auto sm:gap-3`}>
            {/* Which end of the list opens it. First in the group of actions, immediately
                before the marks, because it is the widest reading of the board on this row:
                the marks, the ranges and the search all narrow WHO is listed, and this one
                orders whoever is left. Read left to right the row now says what to show,
                then in what order, then what to do about it.

                A dropdown rather than a toggle button, and labelled in words rather than by
                an arrow. Two arrow states on one glyph say which way it points and never
                which way it is about to go, so the reader has to press it to find out what
                it meant -- and "newest first" is not a direction anybody reads off a
                chevron. The closed control says the order the list is in.

                Text and a chevron, no glyph of its own, which is how the intake dropdowns
                further up this row are already built (FilterSelect). The trigger is
                justify-between, so an icon placed inside it would push the label into the
                middle and leave this the one control on the row whose text does not start
                where every other one's does.

                Kept at every width, unlike those dropdowns, since it is one control rather
                than three and the order of the list is the first thing a phone reads: a
                phone shows four rows at a time, so which four they are is most of what that
                screen says. It is the search that gives way for it, collapsing to its icon
                below sm the way it already does for everything else on this row. */}
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger
                title="Order the list by date"
                aria-label="Sort order"
                className="h-10 w-[112px] shrink-0 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-none transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-sky-200 sm:w-[124px]"
                data-testid="branch-sort-order"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-slate-200" data-testid="branch-sort-order-menu">
                <SelectItem value="newest" className="text-xs text-slate-700">New to First</SelectItem>
                <SelectItem value="oldest" className="text-xs text-slate-700">Old to First</SelectItem>
              </SelectContent>
            </Select>
            {/* Narrow the board to one mark, on every stage rather than on All Stages
                alone. A branch that has just marked somebody on the stage they are being
                worked on could not then ask to see only those, which is the question the
                mark was put on for — and the marks became settable on every stage before
                the reading of them did.

                Safe on a stage now because the narrowing is applied where the Date Filter
                and the search are, so the counts along the bar move with the list instead
                of standing over it saying something else.

                Lit when active, and pressing the lit one clears it, so the same control
                both narrows and returns. */}
            <div className="flex shrink-0 items-center gap-1" data-testid="branch-mark-filters">
                <button
                  type="button"
                  onClick={() => setMarkFilter((m) => (m === "vip" ? "" : "vip"))}
                  title={markFilter === "vip" ? "Showing VIP clients only — click to show all" : "Show VIP clients only"}
                  aria-label="Show VIP clients only"
                  aria-pressed={markFilter === "vip"}
                  className={`flex h-10 w-10 items-center justify-center rounded-md border transition-colors ${
                    markFilter === "vip" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white hover:bg-amber-50"
                  }`}
                  data-testid="branch-filter-vip"
                >
                  <Star className={`h-4 w-4 ${markFilter === "vip" ? "fill-amber-400 text-amber-500" : "text-slate-400"}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setMarkFilter((m) => (m === "attention" ? "" : "attention"))}
                  title={markFilter === "attention" ? "Showing flagged patients only — click to show all" : "Show patients needing attention only"}
                  aria-label="Show patients needing attention only"
                  aria-pressed={markFilter === "attention"}
                  className={`flex h-10 w-10 items-center justify-center rounded-md border transition-colors ${
                    markFilter === "attention" ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white hover:bg-rose-50"
                  }`}
                  data-testid="branch-filter-attention"
                >
                  <AlertCircle className={`h-4 w-4 ${markFilter === "attention" ? "fill-rose-500 text-white" : "text-slate-400"}`} />
                </button>
            </div>
            {/* The one calendar on the row, and now the only one. The range strip used to
                end in a Custom button that opened this same DateFilterPopover, so the
                toolbar offered two triggers for one control — the icon here, and a button
                four inches to the left of it saying the same thing.

                The strip keeps its five one-tap ranges and this keeps everything else:
                Yesterday, Last Month, an exact day, a typed range. Nothing was dropped,
                the second door was.

                Which is why this is no longer conditional. It used to hide on the
                Consultation tab, where the row's own Custom was the copy that tab actually
                used; with that gone, hiding it here would leave that tab unable to ask for
                a range at all. */}
            <DateFilterPopover value={dateFilter} onChange={applyDateFilter} testid="branch-date-filter" centered iconOnly />
            <Button
              onClick={() => { loadBoard(); setRefreshTick((n) => n + 1); }}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
              className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
              data-testid="branch-refresh-btn"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {/* Branch Leads only. This toolbar is shared by both tabs (see the note
                above it), which is what put a Create Lead button over the Consultation
                pills -- and a consultation is a patient the branch already has, arrived
                through Pre-Sales. There is nothing to create from that tab, so the
                button offered an action whose result would not appear on the screen it
                was pressed from. Hidden the same way the date popover above it is. */}
            {!onConsultationTab && (
              <Button
                onClick={() => setShowCreateLead(true)}
                title="Create Lead"
                aria-label="Create Lead"
                className="h-10 w-10 shrink-0 bg-sky-600 p-0 hover:bg-sky-700"
                data-testid="branch-create-lead-btn"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            )}
            <PullFromSheetButton
              onPulled={() => { loadBoard(); setRefreshTick((n) => n + 1); }}
              notConnectedHint="Google Sheets isn't connected yet — ask your Super Admin to connect it."
              noSourcesHint="No Google Sheet is linked to this branch yet — ask your Super Admin to tag one to this branch in Marketing Board → Lead Sources."
              iconOnly
            />
            </div>
          </div>

          {/* The same range row as the one in the toolbar, for the widths where it will
              not fit up there — below lg (1024px) this is the only copy on screen, and
              from there up this one is the one that goes. Shared by both tabs now, same as
              the inline copy above.

              A second date control, and deliberately not a replacement for the calendar
              button in the toolbar — that one still opens the shared popover with
              Yesterday, Last Month and an exact day in it, unchanged, and since this row
              gave up its own Custom trigger it is the only thing that does.

              So the two divide the work rather than repeating it: the fast path here, the
              five ranges a branch actually asks for; everything else on the calendar.
              Folded into effectiveDateFilter either way, which feeds the stage counts on
              the bar above and, on the Consultation tab, the ConsultationsBoard underneath
              too — so a pill's number always describes the list that pill opens. */}
          <div className="lg:hidden">
            <QuickDateFilterBar
              value={quickDate}
              onChange={setQuickDate}
              testid="branch-quick-date"
              showCustom={false}
            />
          </div>

          {onConsultationTab ? (
            <ConsultationsBoard
              // Keyed per tab so a switch between Consultation and House Visit starts
              // from a clean board rather than carrying the other tab's open popup.
              key={activeView}
              homeVisitScope={onHomeVisitTab ? "only" : "exclude"}
              branchId={branchId}
              viewerRole="branch_admin"
              // Same fact the calendars above are given: an arm with no room in it meets
              // its patients over video, so Assign Physio says which room and says when
              // one is missing.
              onlineArm={armScoped}
              externalStageFilter={stageFilter}
              showOwnStageBar={false}
              // The numbers on the cards above. Reported from this board rather than
              // computed up here, so a pill counts exactly the rows its own click shows --
              // see consultationCounts.
              onCountChange={handleConsultationCounts}
              autoOpenLeadId={autoOpenLeadId}
              onAutoOpened={clearAutoOpenLead}
              // Driven by the toolbar above: passing externalSearch hides this board's own
              // search row, which is also where its date filter and green refresh lived.
              externalSearch={searchQuery}
              externalDateFilter={effectiveDateFilter}
              // What a date range means over these cards. "activity" reads the range as
              // the branch's working day rather than as a list of consultation
              // appointments -- see the note beside it in preStageFiltered. The Head
              // Physio's board keeps the default, because a day on their week strip is a
              // clinic list and has to stay one.
              dateScope="activity"
              // The mark filter above narrows this board's list the way the search and the
              // Date Filter beside it do. Without it the pills would count the VIPs and the
              // table under them would show everybody.
              externalMarkFilter={markFilter}
              // Same toolbar, same list order. Without it the dropdown up there would
              // order Branch Leads and leave the tab it is actually sitting over reading
              // whichever way that board sorts on its own.
              externalSortOrder={sortOrder}
              reloadToken={refreshTick}
              // Eight columns can't be read on a phone — without this the consultation
              // stages fall back to the desk table and every field arrives truncated.
              mobileCards
            />
          ) : (
          <>

          {/* An answer where the table would otherwise show its own empty state.
              "No patients yet." is what a board says when it asked and nothing came back;
              a board with no branch and no arm never asked, and saying "yet" there sends
              somebody looking for leads that were never going to arrive. */}
          {boardData.noScope && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="branch-board-no-scope">
              This account is not posted to a branch, so there is no list to show. Ask your
              HR Admin to set the branch on it under HR → Credentials.
            </div>
          )}

          {/* Phone list — six columns can't be read at 430px whichever way they're sized,
              so below md the same rows are stacked as cards instead of being pushed off
              the side of a horizontally-scrolling table. */}
          <div className="space-y-2 md:hidden" data-testid="branch-list-mobile">
            {(() => {
              const visible = (stageFilter ? filteredLeads.filter((l) => matchesBranchStage(l, stages.find((s) => s.name === stageFilter), isConsultationOnlyStage, consultationOpeningStage)) : filteredLeads);
              if (visible.length === 0) {
                return (
                  <p className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400" data-testid="branch-list-mobile-empty">
                    No patients {stageFilter ? `in stage "${stageFilter}"` : "yet"}.
                  </p>
                );
              }
              return visible.map((lead) => {
                const rowStage = rowStageName(lead);
                const hex = rowStage ? stageColor(rowStage) : null;
                const wa = waNumber(lead.phone);
                return (
                  // A div, not a button: the Call and WhatsApp actions below are
                  // themselves interactive, and a button inside a button is invalid
                  // markup that browsers resolve by dropping one of them.
                  <div
                    key={lead.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedLead(lead)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedLead(lead); }
                    }}
                    className="w-full cursor-pointer rounded-xl border border-slate-200 bg-white p-3 text-left transition active:bg-slate-50"
                    data-testid={`branch-card-${lead.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                        {lead.name?.charAt(0)?.toUpperCase() || "?"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate font-semibold text-slate-900">{lead.name}<TransferredTag lead={lead} className="ml-1" compact /><RescheduledTag lead={lead} className="ml-1.5" compact /></span>
                          <span
                            className="shrink-0 rounded-[5px] border px-2 py-0.5 text-[10px] font-medium"
                            style={hex ? { background: `${hex}14`, color: hex, border: `1px solid ${hex}33` } : { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" }}
                          >
                            {rowStage ? rowStage : "—"}
                          </span>
                        </div>
                        {lead.patient_number && <p className="truncate font-mono text-[10px] text-slate-400">{lead.patient_number}</p>}
                        <p className="mt-1 truncate text-xs text-slate-600">
                          {lead.phone || "—"}
                          {/* Beside the phone, not under it. The card already runs five
                              rows deep and a city is two words — its own line would push
                              the appointment, which is what this card is opened for, off
                              the bottom of a phone's first screenful. */}
                          {(() => {
                            const city = cityAnswer(lead);
                            return city ? <span className="text-slate-400"> · {city}</span> : null;
                          })()}
                        </p>
                        {lead.email && <p className="truncate text-xs text-slate-500">{lead.email}</p>}
                        {(() => {
                          const slot = apptSlotLabel(lead);
                          if (!slot) return null;
                          return (
                            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px]" data-testid={`branch-card-appt-${lead.id}`}>
                              <Calendar className="h-3 w-3 text-slate-400" />
                              <span className="font-semibold text-slate-700">{[slot.date, slot.time].filter(Boolean).join(" · ")}</span>
                              {!lead.assigned_physio_name && <span className="font-medium text-amber-600">Pre-Sales request</span>}
                            </p>
                          );
                        })()}
                        {/* The same Follow Up line the table draws, on the same stage and
                            under the same rule. A phone is where a branch actually works a
                            call list, so leaving this to the desk table would hide it from
                            the reader most likely to be looking for it. */}
                        {showFollowUpColumn && (() => {
                          const fu = followUpSlotLabel(lead);
                          if (!fu) return null;
                          return (
                            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px]" data-testid={`branch-card-followup-${lead.id}`}>
                              <Clock className={`h-3 w-3 ${fu.overdue ? "text-rose-500" : "text-slate-400"}`} />
                              <span className={`font-semibold ${fu.overdue ? "text-rose-600" : "text-slate-700"}`}>{[fu.date, fu.time].filter(Boolean).join(" · ")}</span>
                              {fu.overdue && <span className="font-medium text-rose-500">Overdue</span>}
                            </p>
                          );
                        })()}
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-slate-400">
                          {lead.assigned_physio_name && <span className="truncate">Physio: {lead.assigned_physio_name}</span>}
                          <span>Updated {(lead.updated_at || "").slice(0, 10)}</span>
                        </div>
                      </div>
                    </div>
                    {/* Reaching the patient is the commonest thing done from this list, and
                        on a phone it was three taps deep behind the lead popup. Anchors
                        rather than buttons so tel: and the WhatsApp handoff are the
                        browser's own — and stopPropagation so tapping one doesn't also
                        open the lead behind it. */}
                    {wa && (
                      <div className="mt-2.5 flex gap-2 border-t border-slate-100 pt-2.5">
                        <a
                          href={`tel:${wa}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-700 active:bg-slate-100"
                          data-testid={`branch-card-call-${lead.id}`}
                        >
                          <Phone className="h-3.5 w-3.5" /> Call
                        </a>
                        <a
                          href={`https://wa.me/${wa}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#25D366]/40 bg-[#25D366]/10 py-2 text-xs font-semibold text-[#128C7E] active:bg-[#25D366]/20"
                          data-testid={`branch-card-whatsapp-${lead.id}`}
                        >
                          <WhatsAppIcon className="h-3.5 w-3.5" /> WhatsApp
                        </a>
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          {/* Shown only while something is ticked, so the ordinary view of the list is the
              one without a delete button in it. Desk only, like the table it belongs to. */}
          {pickedVisible.length > 0 && (
            <div className="mb-2 hidden flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 md:flex" data-testid="branch-bulk-bar">
              <p className="text-xs font-semibold text-rose-800">
                {pickedVisible.length} selected
                <span className="ml-1 font-normal text-rose-700">of {visibleLeads.length} shown</span>
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setPicked(new Set())} data-testid="branch-bulk-clear">
                  Clear
                </Button>
                <Button
                  size="sm"
                  className="bg-rose-600 text-white hover:bg-rose-700"
                  onClick={() => setShowBulkDelete(true)}
                  data-testid="branch-bulk-delete-btn"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            </div>
          )}

          {/* List View (table) — its own scroll region so the sticky header can use top-0
              instead of guessing the page header's pixel height, which was colliding with
              the stat cards row as it scrolled past. */}
          <div className="hidden w-full max-h-[65vh] overflow-auto rounded-lg border border-slate-200 bg-white md:block" data-testid="branch-list">
            {/* Wider floor where the board asks more than two questions: fitness draws
                eight columns, and eight inside 760px is 95px each with the scroll region
                around it going unused. */}
            <table className={`w-full ${intakeQuestions.length > 2 ? "min-w-[980px]" : "min-w-[760px]"} table-fixed divide-y divide-slate-200 text-sm`}>
              <thead className="sticky top-0 z-10 bg-slate-500 text-left text-xs font-semibold uppercase tracking-wide text-white">
                <tr>
                  {/* Three shapes: an online arm's, and a branch's with and without
                      Assigned Physio. A lead at either entry stage hasn't had a physio
                      assigned yet, so that column is dropped there — every other view of a
                      branch keeps it, and an arm never has it at all.

                      City sits with Phone rather than among the ones that follow it:
                      where the patient is is part of who they are, and the two after it
                      are the intake form's own questions, which is what the branch is
                      actually reading this list to find out. Widths total 100 either way:
                      table-fixed divides by the stated widths, and a set that overshoots
                      quietly squeezes the last column instead.

                      Consultation Type's 13/12 went to Patient, Phone and City rather
                      than being spread evenly. Those three are the ones that were
                      actually truncating: a name is as long as the patient's name, a
                      number carries +91 and the "p:" a Meta export prefixes it with, and
                      "Chennai kolathur" did not fit. The intake pair took a point each,
                      which is all "more_than_3_months" needs, and the columns after them
                      hold values of a fixed size and took none. */}
                  {onArmBoard ? (
                    /* An arm's own set, at every stage. The questions between City and
                       Appointment are that arm's form's -- two on the physiotherapy arm,
                       three on fitness -- so they are drawn from the same list the columns
                       below and the dropdowns above are, rather than written out here and
                       left to drift from it.

                       Assigned Physio is not among them: nobody is assigned a room, and
                       the consultant taking the call is on the patient's card. */
                    <>
                      <th className={`${armWidths.name} px-4 py-3`}>Name</th>
                      <th className={`${armWidths.phone} px-4 py-3`}>Phone Number</th>
                      <th className={`${armWidths.city} px-4 py-3`}>City</th>
                      {intakeQuestions.map((q) => (
                        <th key={q.key} className="px-4 py-3" style={{ width: armQuestionWidth }}>{q.label}</th>
                      ))}
                      <th className={`${armWidths.appt} px-4 py-3`}>Appointment</th>
                      <FollowUpHeaderCell show={showFollowUpColumn} widthClass={armWidths.followUp} />
                      <th className={`${armWidths.stage} px-4 py-3`}>Stage</th>
                    </>
                  ) : entryStageNames.includes(stageFilter) ? (
                    <>
                      <th className="w-[20%] px-4 py-3">Patient</th>
                      <th className="w-[13%] px-4 py-3">Phone</th>
                      <th className="w-[12%] px-4 py-3">City</th>
                      <th className="w-[13%] px-4 py-3">Pain Type</th>
                      <th className="w-[13%] px-4 py-3">Pain Duration</th>
                      <th className="w-[12%] px-4 py-3">Appointment</th>
                      <th className="w-[11%] px-4 py-3">Stage</th>
                    </>
                  ) : (
                    <>
                      <th className={`${listWidths.patient} px-4 py-3`}>Patient</th>
                      <th className={`${listWidths.phone} px-4 py-3`}>Phone</th>
                      <th className={`${listWidths.city} px-4 py-3`}>City</th>
                      <th className={`${listWidths.painType} px-4 py-3`}>Pain Type</th>
                      <th className={`${listWidths.painDuration} px-4 py-3`}>Pain Duration</th>
                      <th className={`${listWidths.physio} px-4 py-3`}>Assigned Physio</th>
                      <th className={`${listWidths.appt} px-4 py-3`}>Appointment</th>
                      <FollowUpHeaderCell show={showFollowUpColumn} widthClass={listWidths.followUp} />
                      <th className={`${listWidths.stage} px-4 py-3`}>Stage</th>
                    </>
                  )}
                  {/* Last on every shape of the table; each shape leaves it 6%. */}
                  {canDeleteLeads && <th className="w-[6%] px-2 py-3 text-center">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(() => {
                  const visible = visibleLeads;
                  // Never on an arm's board, and not at the entry stages of a branch's --
                  // the header above draws the same two cases, and a row that disagreed
                  // with it would slide every cell after this one a column to the left.
                  const showAssignedPhysio = !onArmBoard && !entryStageNames.includes(stageFilter);
                  if (visible.length === 0) {
                    return (
                      <tr>
                        {/* Counted rather than written down: five fixed columns, however
                            many questions this board asks, and Assigned Physio where it is
                            drawn. It used to read 9/8, one more than the table has ever
                            had, and a fitness arm's nine would have been a third wrong
                            answer to write down. */}
                        <td colSpan={5 + intakeQuestions.length + (showAssignedPhysio ? 1 : 0) + (showFollowUpColumn ? 1 : 0) + (canDeleteLeads ? 1 : 0)} className="px-4 py-10 text-center text-sm text-slate-400" data-testid="branch-list-empty">
                          No patients {stageFilter ? `in stage "${stageFilter}"` : "yet"}.
                        </td>
                      </tr>
                    );
                  }
                  return visible.map((lead) => {
                    const rowStage = rowStageName(lead);
                    const rowStageHex = rowStage ? stageColor(rowStage) : null;
                    return (
                      <tr
                        key={lead.id}
                        onClick={() => setSelectedLead(lead)}
                        className={`cursor-pointer transition-colors ${picked.has(lead.id) ? "bg-rose-50/70 hover:bg-rose-50" : "hover:bg-slate-50"}`}
                        data-testid={`branch-row-${lead.id}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                              {lead.name?.charAt(0)?.toUpperCase() || "?"}
                            </div>
                            <div className="min-w-0">
                              {/* The row's headline, so it carries the heaviest and darkest
                                  text in the row. As font-medium/slate-800 it sat half a step
                                  from the phone beside it and no heavier than the appointment
                                  two columns over, which left the one thing this list is
                                  scanned for competing with the columns either side of it.
                                  The mobile card above already gave the name its own weight. */}
                              <span className="flex min-w-0 items-center gap-1">
                                <span className="truncate font-semibold text-slate-900" title={lead.name}>{lead.name}</span>
                                {/* Outside the truncation, not inside it. A name long
                                    enough to be cut is exactly the row where the mark
                                    would be the part that got cut. */}
                                <TransferredTag lead={lead} />
                              </span>
                              {lead.patient_number && <span className="block truncate font-mono text-[10px] text-slate-400" title={lead.patient_number}>{lead.patient_number}</span>}
                              <RescheduledTag lead={lead} className="mt-0.5" />
                            </div>
                            {/* The two marks, after the name so they read as something said
                                about this patient rather than as part of their identity.
                                stopPropagation on both: the row opens the patient, and
                                marking one should not also open them.

                                Unset they are faint outlines rather than absent, so the
                                control is in the same place on every row — a mark that only
                                appears once set cannot be set by anyone who has not seen it
                                set before. */}
                            {/* Settable on every stage, not only on All Stages.
                                They were All-Stages-only on the reasoning that the whole
                                branch in one list is where such a judgement is made. But
                                the judgement is not made against the list — it is made
                                about the patient in front of you, and the moment it is made
                                is usually the moment their stage is being worked. Held to
                                All Stages, a Branch Admin looking at Fee Collected who
                                learns this one is a VIP has to clear the stage, find the
                                row again in two thousand, and mark it there. That is a long
                                way round to a click, and the mark that does not get made is
                                the one nobody makes.
                                Reading them back is offered on every stage too now — see
                                markFilter, which narrows the counts along with the list so
                                the bar cannot end up describing a different set. */}
                            <div className="ml-auto flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleLeadFlag(lead, "is_vip"); }}
                                title={lead.is_vip ? "VIP client — click to remove" : "Mark as VIP client"}
                                aria-label={lead.is_vip ? `Remove VIP mark from ${lead.name || "patient"}` : `Mark ${lead.name || "patient"} as VIP`}
                                aria-pressed={!!lead.is_vip}
                                className="rounded p-1 transition-colors hover:bg-amber-50"
                                data-testid={`branch-vip-${lead.id}`}
                              >
                                <Star className={`h-4 w-4 ${lead.is_vip ? "fill-amber-400 text-amber-500" : "text-slate-300 hover:text-amber-400"}`} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleLeadFlag(lead, "needs_attention"); }}
                                title={lead.needs_attention ? "Needs attention — click to clear" : "Flag as needing attention"}
                                aria-label={lead.needs_attention ? `Clear the attention flag on ${lead.name || "patient"}` : `Flag ${lead.name || "patient"} as needing attention`}
                                aria-pressed={!!lead.needs_attention}
                                className="rounded p-1 transition-colors hover:bg-rose-50"
                                data-testid={`branch-attention-${lead.id}`}
                              >
                                <AlertCircle className={`h-4 w-4 ${lead.needs_attention ? "fill-rose-500 text-white" : "text-slate-300 hover:text-rose-400"}`} />
                              </button>
                            </div>
                          </div>
                        </td>
                        <td className="truncate px-4 py-3 text-slate-600" title={lead.phone}>{lead.phone || "—"}</td>
                        {/* Read through cityAnswer, so a lead whose sheet mapped the column
                            and one whose sheet did not both show the same thing here. */}
                        {(() => {
                          const city = cityAnswer(lead);
                          return (
                            <td className="truncate px-4 py-3 text-slate-600" title={city || undefined} data-testid={`branch-row-city-${lead.id}`}>
                              {city || <span className="text-slate-400">—</span>}
                            </td>
                          );
                        })()}
                        {/* This board's own intake questions — the branch pair or the arm
                            pair, chosen once above. Each falls back to the lead's own field
                            where it has one — see formAnswer. Read from the same list the
                            toolbar filters are built from, so a column and the dropdown
                            above it cannot drift apart. */}
                        {intakeQuestions.map((q) => {
                          const answer = formAnswer(lead, q.question, q.fallback, q.formatFallback);
                          return (
                            <td key={q.key} className="truncate px-4 py-3 text-slate-600" title={answer || undefined}>
                              {answer || <span className="text-slate-400">—</span>}
                            </td>
                          );
                        })}
                        {showAssignedPhysio && (
                          <td className="truncate px-4 py-3 text-slate-600" title={lead.assigned_physio_name}>{lead.assigned_physio_name || <span className="text-slate-400">—</span>}</td>
                        )}
                        <td className="px-4 py-3">
                          {(() => {
                            const slot = apptSlotLabel(lead);
                            if (!slot) return <span className="text-slate-400">—</span>;
                            return (
                              <div className="flex flex-col gap-0.5" data-testid={`branch-row-appt-${lead.id}`}>
                                <span className="whitespace-nowrap text-xs font-semibold text-slate-700">
                                  {[slot.date, slot.time].filter(Boolean).join(" · ")}
                                </span>
                                {/* Until an expert is assigned, this is the slot Pre-Sales asked
                                    for rather than one the branch has committed to. */}
                                {!lead.assigned_physio_name && (
                                  <span className="text-[10px] font-medium text-amber-600">Pre-Sales request</span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        {/* The call this patient is waiting on. Drawn only on the Follow Up
                            stage — see showFollowUpColumn, which the header reads too, so
                            the two cannot end up counting different numbers of columns.

                            Overdue is the state worth colouring, the same judgement the
                            lead card's preview makes: an upcoming call needs nothing done
                            today, a missed one is the reason this list is open. */}
                        {showFollowUpColumn && (
                          <td className="px-4 py-3">
                            {(() => {
                              const fu = followUpSlotLabel(lead);
                              if (!fu) return <span className="text-slate-400">—</span>;
                              return (
                                <div className="flex flex-col gap-0.5" data-testid={`branch-row-followup-${lead.id}`}>
                                  <span className={`whitespace-nowrap text-xs font-semibold ${fu.overdue ? "text-rose-600" : "text-slate-700"}`}>
                                    {[fu.date, fu.time].filter(Boolean).join(" · ")}
                                  </span>
                                  {fu.overdue && <span className="text-[10px] font-medium text-rose-500">Overdue</span>}
                                </div>
                              );
                            })()}
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <span
                            title={rowStage ? rowStage : undefined}
                            className="inline-block max-w-full truncate rounded-[5px] border px-2.5 py-0.5 align-middle text-xs font-medium"
                            style={rowStageHex ? { background: `${rowStageHex}14`, color: rowStageHex, border: `1px solid ${rowStageHex}33` } : { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" }}
                          >
                            {rowStage ? rowStage : "—"}
                          </span>
                        </td>
                        {canDeleteLeads && (
                          <td className="px-2 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setRowDelete(lead); }}
                              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              title="Delete this patient and everything of theirs"
                              aria-label={`Delete ${lead.name || "patient"} and all their records`}
                              data-testid={`branch-row-delete-${lead.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>

      {/* Lead Detail Modal */}
      {selectedLead && (
        <BranchLeadModal
          lead={selectedLead}
          branchId={branchId}
          stages={stages}
          // Which of the two entry stages this lead's pipeline should open on. The strip
          // above now shows only the mirrored one (see leadPillStages), so a lead standing
          // at the branch's opening opens on Leads however it was reached — from the Leads
          // pill or from All Stages — and the card names the position the same way the row
          // that opened it did.
          openedFromMirror={showingMirror || atBranchOpening(selectedLead)}
          // So the highlighted pill on the card reads the lead the same way the bar above
          // counted it — see matchesBranchStage.
          consultationOpeningStage={consultationOpeningStage}
          // The Consultation pipeline's Cancel stage, offered as the card's last pill. The
          // stage stays in Branch Consultation; the pill only moves the lead onto it.
          consultationCancelStage={consultationCancelStage}
          onlineArm={armScoped}
          canTransferBranch={canTransferBranch}
          onClose={() => setSelectedLead(null)}
          onUpdate={handleStageUpdate}
          onOpenConsultationStage={(stage) => {
            // Hand off to the embedded Consultations board: close this modal, switch the
            // stage bar to the requested Consultation stage, and tell that board which
            // lead to auto-open — same lead, same rich stage-specific popups it already
            // has (Collect Payment, Physio Assign, etc.), instead of duplicating them here.
            setAutoOpenLeadId(selectedLead.id);
            setSelectedLead(null);
            // The Consultation stages moved to their own tab, so the handoff has to go
            // there as well as set the pill — setting the pill alone would leave the
            // reader on Branch Leads with a filter that has no pill and no board.
            setActiveView(selectedLead.visit_type === "home" ? "branch_home_visit" : "branch_consultation");
            setStageFilter(stage);
          }}
          onMoved={() => {
            // Close first, then refresh the list in the background via loadBoard directly
            // (not handleStageUpdate) — that closure's stale selectedLead would otherwise
            // re-open this same modal once the refresh resolves a couple seconds later.
            setSelectedLead(null);
            loadBoard();
          }}
        />
      )}
          </>
          )}

      {showCreateLead && (
        <CreateLeadModal
          isSuperAdmin={false}
          branchId={branchId}
          // Fixed to this arm's own department where the board is an arm's — see
          // ARM_DEPARTMENT. Null everywhere else, which leaves the field as it was.
          //
          // Keyed off the board's practice rather than the login's role. Read off the role
          // it was set for the arm's own admin and nobody else, so a Super Admin adding a
          // patient from the same arm's tile got a free Department dropdown — and a lead
          // saved with it blank is filed as offline physiotherapy and vanishes from the
          // board that created it, which is the disappearance ARM_DEPARTMENT exists to
          // prevent.
          lockedDepartment={ARM_DEPARTMENT[armPractice] || null}
          // Each arm offers the questions its own form asks: fitness its three, physio the
          // one of its two that nothing else on this form can capture. A branch offers none
          // -- its pair reads back off Condition and Months of Pain, which it already has.
          formQuestions={armPractice === "fitness" ? FITNESS_FORM_QUESTIONS
            : armPractice === "physio" ? PHYSIO_FORM_QUESTIONS : []}
          onClose={() => setShowCreateLead(false)}
          onSaved={loadBoard}
        />
      )}

      {showBulkDelete && pickedVisible.length > 0 && (
        <BulkDeleteLeadsModal
          leads={pickedVisible}
          onClose={() => setShowBulkDelete(false)}
          // Whatever the server refused stays ticked, so a second attempt is against the
          // rows that actually survived rather than against a selection the list has
          // already moved on from.
          onDeleted={(res) => {
            setShowBulkDelete(false);
            setPicked(new Set((res.blocked || []).map((b) => b.lead_id)));
            loadBoard();
          }}
        />
      )}

      {rowDelete && (
        <BulkDeleteLeadsModal
          leads={[rowDelete]}
          purge
          onClose={() => setRowDelete(null)}
          onDeleted={() => {
            setRowDelete(null);
            loadBoard();
          }}
        />
      )}

        </>
      )}
      </div>

      {loading && (
        <div className="fixed bottom-20 right-4 rounded-md bg-slate-900 px-3 py-2 text-sm text-white md:bottom-4">Loading...</div>
      )}

      {/* Bottom nav — phones only, and only when this board owns the page (not when
          Super Admin's Branch Wise embeds it, which already has its own bottom nav —
          two fixed bottom bars fighting for the same spot was the actual bug). The top
          strip scrolls sideways, which left Accountant Manage and Store behind a swipe.

          Four direct slots and a More sheet, rather than every tab across the bar: all of
          them would give each about 30px, which is why the labels are abbreviated at all.
          Columns are counted rather than hardcoded, so a tab added to BOTTOM_NAV_KEYS
          re-divides the bar instead of leaving a gap. */}
      {!embedded && (
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-600 bg-slate-500/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_10px_rgba(15,23,42,0.06)] backdrop-blur supports-[backdrop-filter]:bg-slate-500/85 md:hidden"
        data-testid="branch-bottom-nav"
      >
        <div className="grid" style={{ gridTemplateColumns: `repeat(${bottomTabs.length + 2}, minmax(0, 1fr))` }}>
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            const active = !profileOpen && activeView === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => { setProfileOpen(false); setActiveView(tab.key); setShowMoreMenu(false); }}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 py-2 transition-colors ${
                  active ? "text-white" : "text-slate-200 active:text-white"
                }`}
                data-testid={`branch-bottom-nav-${tab.key}`}
              >
                {/* The strip sits on the top edge, where the desk tabs carry their underline. */}
                {active && <span className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-white" />}
                <Icon className="h-[18px] w-[18px] flex-none" />
                <span className="w-full truncate text-center text-[9px] font-semibold leading-tight">{tab.short}</span>
              </button>
            );
          })}
          {/* Lit while one of the tabs it holds is open, so the bar still says where you
              are once you have navigated into the sheet and it has closed behind you. */}
          <button
            type="button"
            onClick={() => setShowMoreMenu((v) => !v)}
            aria-expanded={showMoreMenu}
            className={`relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 py-2 transition-colors ${
              (!profileOpen && moreTabs.some((t) => t.key === activeView)) || showMoreMenu ? "text-white" : "text-slate-200 active:text-white"
            }`}
            data-testid="branch-bottom-nav-more"
          >
            {!profileOpen && moreTabs.some((t) => t.key === activeView) && <span className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-white" />}
            <MoreHorizontal className="h-[18px] w-[18px] flex-none" />
            <span className="w-full truncate text-center text-[9px] font-semibold leading-tight">More</span>
          </button>
          {/* My Profile, and Logout on its Security tab -- the phone header carries neither. */}
          <button
            type="button"
            onClick={() => { setProfileOpen(true); setShowMoreMenu(false); }}
            aria-current={profileOpen ? "page" : undefined}
            className={`relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 py-2 transition-colors ${
              profileOpen ? "text-white" : "text-slate-200 active:text-white"
            }`}
            data-testid="branch-bottom-nav-profile"
          >
            {profileOpen && <span className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-white" />}
            <UserCircle className="h-[18px] w-[18px] flex-none" />
            <span className="w-full truncate text-center text-[9px] font-semibold leading-tight">Profile</span>
          </button>
        </div>
      </nav>
      )}

      {/* Whatever came off the bar. Full labels here — a sheet has the width the bar
          did not, so this is the one place "Accountant Manage" reads in full. */}
      {!embedded && showMoreMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-slate-900/40 md:hidden"
          onClick={() => setShowMoreMenu(false)}
          data-testid="branch-bottom-nav-sheet"
        >
          <div className="w-full rounded-t-2xl bg-white p-2 pb-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-sm font-semibold text-slate-700">More</p>
              <button
                type="button"
                onClick={() => setShowMoreMenu(false)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100"
                data-testid="branch-bottom-nav-sheet-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {moreTabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeView === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => { setProfileOpen(false); setActiveView(tab.key); setShowMoreMenu(false); }}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium ${active ? "bg-sky-50 text-sky-700" : "text-slate-700 hover:bg-slate-50"}`}
                  data-testid={`branch-bottom-nav-sheet-${tab.key}`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ─── Branch Lead Detail Modal ─── */
// `onlineArm` reaches the booking popup for one thing: whether a CONSULTANT with no video
// room is worth warning about. On an online arm it is the whole address of the
// appointment about to be confirmed. At a branch it is nothing — the consultation is held
// in a room, the field that would set a link is not offered on that board at all, and an
// amber panel naming a gap nobody there can fill is noise on every booking they make.
function BranchLeadModal({ lead, branchId, stages, consultationCancelStage = null, onClose, onUpdate, onMoved, onOpenConsultationStage, consultationOpeningStage = null, openedFromMirror = false, onlineArm = false, canTransferBranch = false }) {
  // The board offers two entry stages — the mirrored Pre-Sales "Leads" pill and the branch's
  // own first stage — but a single lead only ever came in through one of them, so its
  // pipeline shows that one and drops the other. Everything from RNR onwards is shared.
  const mirrorStageName = stages.find((s) => s.mirrors_stage)?.name;
  const realEntryStageName = stages.find((s) => !s.mirrors_stage)?.name;
  // Matches the chip on the row that opened this popup, rather than contradicting it.
  const headerStageName = (openedFromMirror && lead.branch_stage) ? mirrorStageName : lead.branch_stage;
  const entryStages = stages.filter((s) => (
    s.name === mirrorStageName ? openedFromMirror
      : s.name === realEntryStageName ? !openedFromMirror
        : true
  ));
  // Branch Leads' own stages, and not one pill further.
  //
  // This used to run the branch stages straight into the Consultation ones -- one
  // continuous pipeline from the branch's opening through Consultation Visit, Fee
  // Collected, Physio Assign, Rehab and the diet stages to Completed -- on the reasoning
  // that the card is the one place a patient's whole journey is laid out. That is a true
  // picture of where a patient goes and the wrong set of controls for this popup, which
  // is opened off Branch Leads: a list of leads, whose question is whether this one is
  // reachable, coming in, or gone quiet. The stages after Appointment answer a different
  // question, and every board that owns one of them has its own popup for it -- the
  // handoff comment further down says as much, in the code that used to send the reader
  // there.
  //
  // Cancelled goes with them. It is a branch stage rather than a consultation one, but it
  // is the end of the pipeline and not a step along it, and the four that remain are the
  // ones a lead moves between while it is still a lead.
  //
  // Nothing about the patient's actual pipeline changes here. A lead still enters the
  // Consultation stages the way it always did -- by having an appointment booked, which
  // seeds consultation_stage server-side -- and the Consultant still drives it from their
  // own board. This is which stages this card offers to move a lead to, not which stages
  // exist.
  const pipelineStages = entryStages.filter((s) => !stageHasRole(s, STAGE_ROLE_CANCELLED));
  // A lead whose appointment is booked and not yet consulted. From here the branch has
  // four things it can do, and none of them is moving the patient forward: forward is the
  // consultation happening, which the Consultant drives from their own board.
  //
  // So the rest of the pipeline is drawn but not pressable. Hidden would read as a
  // shorter pipeline rather than as a stage with few exits, and the card is the one place
  // the whole journey is laid out -- a Branch Admin looking at it is often checking where
  // a patient is going next, not moving them.
  const appointmentStageName = stageNameForRole(stages, STAGE_ROLE_APPOINTMENT);
  const cancelledStageName = stageNameForRole(stages, STAGE_ROLE_CANCELLED);
  const inAppointmentStage = lead.branch_stage === appointmentStageName;
  // The four real stages reachable from Appointment. Reschedule is the fifth exit and is
  // not in here, because it is not a stage at all -- see the pill itself.
  //
  // Not a prospect is in the list for the reason it sits where it does in the pipeline:
  // the branch usually learns there was never a client here at the point the appointment
  // is made or missed, so Appointment is the stage it has to be reachable from. Left out,
  // it would be drawn on the card and dead on every lead that could actually use it.
  const APPOINTMENT_EXITS = [
    stageNameForRole(stages, STAGE_ROLE_RNR),
    stageNameForRole(stages, STAGE_ROLE_FOLLOW_UP),
    stageNameForRole(stages, STAGE_ROLE_NOT_A_PROSPECT),
    cancelledStageName,
  ];
  // `!!name` guards the matchesBranchStage call below: a lead with no consultation_stage
  // has not been handed over, and an undefined name is in neither pipelines' stage list.
  const isConsultationOnlyStage = (name) => !!name && !stages.some((s) => s.name === name);
  const [activeTab, setActiveTab] = useState("overview");
  const [remarks, setRemarks] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  // Correcting what the lead itself says, as against moving it or booking it. The tabs
  // below are all things done TO a lead; this is the one thing done to the record, and it
  // belongs beside the name it fixes rather than as a sixth tab among the four.
  const [editing, setEditing] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const [apptDraft, setApptDraft] = useState(null); // { appointment_date, appointment_time, physio_id, notes, final_stage, duration, visit_type, visit_package_id, step } | null
  // The Home Visit > Consultant catalogue, offered when the appointment is a house visit.
  // Read when that step is reached rather than with the card: most bookings are at the
  // branch and never need it.
  const [hvPackages, setHvPackages] = useState({ items: [], loading: false, error: "" });
  const loadHvPackages = async () => {
    setHvPackages((p) => ({ ...p, loading: true, error: "" }));
    try {
      const rows = await listStoreItems("home_visit_consultation", "session");
      setHvPackages({ items: rows || [], loading: false, error: "" });
    } catch (e) {
      setHvPackages({ items: [], loading: false, error: e?.response?.data?.detail || "Could not load the House Visit packages" });
    }
  };
  // Asked before the lead is cancelled off the Appointment stage. A boolean rather than a
  // draft: there is nothing to fill in, only something to be sure about.
  const [cancelDraft, setCancelDraft] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Handing a booked appointment to a different CONSULTANT without moving it.
  //
  // The appointment dialog can already do this, but only the long way round: picking an
  // expert clears the time, and the times it then offers are the ones that expert has
  // published. So a consultant ringing to say "I am free at 1:45, give me that one" cannot
  // be obliged unless they happen to have published 1:45 — even though the booking
  // endpoint has never required a published slot, only that nobody else holds it.
  //
  // null | { leadId, date, time, duration, currentId, currentName, options, loading, saving }
  const [handover, setHandover] = useState(null);
  const [apptExperts, setApptExperts] = useState({ experts: [], available_count: 0, busy_count: 0, slot_minutes: null, loading: false });
  // The hour of the appointment, typed rather than picked. The Consultant Calendar says
  // which days a consultant works; the minute inside one is agreed with the patient on
  // the phone and entered here, because a grid of published tiles could only ever offer
  // the hours the grid happened to cut.
  //
  // Held as its three parts and not as one "HH:MM", because a field that reparses between
  // keystrokes cannot be typed into: "1" on its way to "11" is itself a valid hour, and
  // formatting it eagerly rewrites it to 01 under the cursor.
  const [apptTime, setApptTime] = useState({ h: "", m: "", ap: "AM" });
  // Month shown by the popup's own calendar. Held apart from the picked date so paging
  // through months doesn't disturb the booking being built.
  const [apptMonth, setApptMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  // Shown once a booking is actually made. Kept outside the Appointment popup because
  // confirming closes that popup and the lead card with it.
  const [apptConfirm, setApptConfirm] = useState(null);
  // The same confirmation handed back off the record, any number of times, long after the
  // booking dialog that first raised it has gone. Held apart from apptConfirm above
  // because closing that one is what moves the lead on -- reusing it for a reissue would
  // unmount this card on dismiss and drag the lead a stage forward for the crime of
  // looking at its own receipt. This one only closes.
  //
  // Loaded on press rather than with the lead: the reference, the room and the notes live
  // on the appointment row and not on the lead, so there is nothing to draw without
  // asking, and asking for every patient opened would be a request each time to save one
  // click on the few who want it. Same endpoint the Consultations board reissues from, so
  // the second copy is the first copy in every field.
  const [apptCard, setApptCard] = useState(null);
  const [loadingApptCard, setLoadingApptCard] = useState(false);
  const openApptCard = async () => {
    if (!lead?.id || loadingApptCard) return;
    setLoadingApptCard(true);
    try {
      setApptCard(await getLeadAppointmentCard(lead.id));
    } catch (err) {
      // 404 here is the useful case, not a failure: a cancelled or never-booked
      // appointment has no sheet, and the server says which in its own words.
      toast.error(err?.response?.data?.detail || "Couldn't load this patient's appointment");
    }
    setLoadingApptCard(false);
  };
  // The branch's own address and map link, for the confirmation the patient is sent —
  // they need to know where to come, which the lead record doesn't carry.
  const [branchInfo, setBranchInfo] = useState(null);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranchInfo((rows || []).find((b) => b.id === branchId) || null); })
      .catch(() => { /* the confirmation just omits the location */ });
    return () => { cancelled = true; };
  }, [branchId]);
  // { "YYYY-MM-DD": free slot count } for the shown month — drives the purple marking so
  // the days worth clicking are visible without opening each one.
  const [apptOpenDates, setApptOpenDates] = useState({});

  /** The booking sitting on one taken slot, opened from the pencil on its tile.
   *
   * A slot the grid shows as gone is not dead space — it is somebody's appointment, and
   * the three reasons a branch is ringing about it are the three ways out offered here:
   * the CONSULTANT cannot make it (hand the same time to another one), the PATIENT cannot
   * (keep the consultant, move the time), or two patients want each other's slots (SWAP).
   * The first two are the one POST that books anything; rebooking IS the reschedule, and
   * the endpoint tags a genuine move on its own by comparing the new slot against the one
   * the lead already sits on.
   *
   * SWAP is its own endpoint because it cannot be a booking. Booking one patient onto a
   * taken slot is refused by the clash check, and freeing the slot first is how a patient
   * ends up with no appointment — so the exchange is made server-side as one closed set
   * of writes, each side landing on what the other just left.
   *
   * The booking belongs to a different patient than the one whose card is open — this
   * lead's own slot never appears as taken. That is deliberate: Branch Admin owns every
   * calendar in the branch, and the moment a clash is visible is the moment it wants
   * solving, not a trip through another patient's card to solve it.
   *
   * null | { date, time, duration, leadId, leadName, physioId, physioName, mode,
   *          options, pickedPhysioId, loading, saving,
   *          moveDate, moveTime, moveDuration, dayLoading, daySlots,
   *          swapLoading, swapOptions, swapLeadId, swapQuery }
   */
  const [slotEdit, setSlotEdit] = useState(null);

  // Follow-up scheduling
  const tomorrowIso = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [followUpForm, setFollowUpForm] = useState({ date: tomorrowIso(), time: "10:00", remarks: "" });
  const [rescheduleDraft, setRescheduleDraft] = useState(null); // { followupId, date, time, reason } | null
  const [followUpBusy, setFollowUpBusy] = useState(false);

  // "Move to Stage" popup for Follow Up (mirrors Appointment Date & Time's popup pattern)
  const [followUpMoveDraft, setFollowUpMoveDraft] = useState(null); // { date, time, remarks } | null
  const [followUpMoveBusy, setFollowUpMoveBusy] = useState(false);

  /** Who could take this exact slot, and hand it to one of them.
   *
   * available-experts is asked with the time, which is the form that returns everyone not
   * already booked then rather than everyone who has published it — the distinction the
   * booking endpoint itself has always drawn. lead_id is passed so this lead's own booking
   * does not read as a clash against the consultant currently holding it.
   */
  const openHandover = async (l) => {
    setHandover({
      leadId: l.id,
      date: l.appointment_date,
      time: l.appointment_time,
      duration: l.appointment_duration || null,
      currentId: l.assigned_physio_id || "",
      currentName: l.assigned_physio_name || "",
      options: [],
      loading: true,
      saving: false,
    });
    try {
      const res = await getAvailableExperts(branchId, l.appointment_date, l.appointment_time, l.id);
      setHandover((p) => (p ? { ...p, options: res.experts || [], loading: false } : p));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load consultants");
      setHandover((p) => (p ? { ...p, loading: false } : p));
    }
  };

  const confirmHandover = async (doc) => {
    if (!handover || doc.id === handover.currentId) { setHandover(null); return; }
    setHandover((p) => ({ ...p, saving: true }));
    try {
      // The same call that books one, re-posted with the date and time untouched. Its own
      // clash check is what makes this safe: it refuses if somebody else already holds the
      // slot with the consultant being handed to.
      await scheduleBranchAppointment(handover.leadId, {
        appointment_date: handover.date,
        appointment_time: handover.time,
        physio_id: doc.id,
        final_stage: appointmentStageName,
        ...(handover.duration ? { duration: handover.duration } : {}),
      });
      toast.success(`${handover.time} moved to ${doc.full_name}`);
      setHandover(null);
      // The modal's own refresh prop, not the board's handler — that one is not in scope
      // here and would be a stale closure over a different selectedLead if it were.
      await onUpdate?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the consultant");
      setHandover((p) => (p ? { ...p, saving: false } : p));
    }
  };

  const fetchAvailableExperts = useCallback(async (branch, dateStr, leadId) => {
    if (!branch || !dateStr) return;
    setApptExperts((p) => ({ ...p, loading: true }));
    try {
      const res = await getAvailableExperts(branch, dateStr, undefined, leadId);
      setApptExperts({
        experts: res.experts || [],
        available_count: res.available_count || 0,
        busy_count: res.busy_count || 0,
        // The Consultation Duration from FITSIO STORE. A hand-typed start has no tile to
        // take a length off, so the booking is the store's length from whatever minute
        // was entered.
        slot_minutes: res.slot_minutes || null,
        loading: false,
      });
      setApptDraft((curr) => {
        if (!curr || !curr.physio_id) return curr;
        const stillAvail = (res.experts || []).some((dd) => dd.id === curr.physio_id);
        return stillAvail ? curr : { ...curr, physio_id: "" };
      });
    } catch {
      setApptExperts({ experts: [], available_count: 0, busy_count: 0, slot_minutes: null, loading: false });
    }
  }, []);

  // The picked expert's whole published day on the picked date -- the open times and the
  // taken ones together, in clock order. Both arrive with the expert list, so choosing an
  // expert reveals the day without a second round trip.
  //
  // Booked times are drawn as well, marked and unclickable, rather than left out of the
  // grid. A branch on the phone gets asked "what else is around three", and a list of
  // four gaps cannot answer that -- it looks identical whether the day is empty or nearly
  // full. Which times can be taken is carried by the tile, not by the tile's absence.
  //
  // This lead's own current slot counts as free: available-experts leaves it out of
  // `taken`, so reopening an existing appointment still shows and selects the time it
  // is sitting on.
  const apptSlotsForExpert = useMemo(() => {
    if (!apptDraft?.physio_id) return [];
    const doc = (apptExperts.experts || []).find((d) => d.id === apptDraft.physio_id);
    if (!doc) return [];
    const free = (doc.free_slots || []).map((s) => ({ ...s, booked: false }));
    const taken = (doc.booked_slots || []).map((s) => ({ ...s, booked: true }));
    return [...free, ...taken].sort((a, b) => (a.slot_time || "").localeCompare(b.slot_time || ""));
  }, [apptExperts.experts, apptDraft?.physio_id]);

  // The chosen CONSULTANT's own record, and the room on it. available-experts answers with
  // the whole expert row, so the link arrives with the list and choosing somebody reveals
  // it without a second request.
  const apptSelectedExpert = useMemo(
    () => (apptDraft?.physio_id ? (apptExperts.experts || []).find((d) => d.id === apptDraft.physio_id) : null) || null,
    [apptExperts.experts, apptDraft?.physio_id],
  );
  const apptMeetLink = (apptSelectedExpert?.meet_link || "").trim();

  // ── The hand-typed hour ──
  //
  // How long the appointment runs. The store's Consultation Duration, because a typed
  // start is not a tile and has no length of its own to read off.
  const apptSlotMinutes = apptExperts.slot_minutes || 30;
  // Whether this consultant is working the picked day at all. Read off what they
  // published rather than off what is still free: the day is the thing the Consultant
  // Calendar sets, and one with every published hour spoken for is a day they are on —
  // busy, but on it.
  const apptDayPublished = (apptSelectedExpert?.published_slot_count || 0) > 0;

  /** "9:05" -> 545. Minutes past midnight, or null if it isn't a clock reading. */
  const apptMinutesOf = (hhmm) => {
    const [h, m] = String(hhmm || "").split(":").map(Number);
    return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
  };
  const apptClockText = (mins) =>
    `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

  // The stretches of the day this consultant actually published, merged out of the slots
  // that came back. Two halves and not one: a Morning + Evening consultant is not at the
  // desk at 2 PM, and naming their day as 7 AM to 7 PM would invite a booking into the
  // gap they go home in.
  const apptDayBlocks = useMemo(() => {
    // The consultant's published shifts, straight from the calendar. Building them out of
    // the slot grid instead splits a shift wherever an off-grid booking punches a hole.
    const published = (apptSelectedExpert?.day_blocks || [])
      .map((b) => [apptMinutesOf(b.start), apptMinutesOf(b.end)])
      .filter(([a, b]) => a !== null && b !== null);
    if (published.length) return published;
    const rows = apptSlotsForExpert
      .map((x) => [apptMinutesOf(x.time), apptMinutesOf(x.time) + (Number(x.duration) || 0)])
      .filter(([a]) => a !== null)
      .sort((a, b) => a[0] - b[0]);
    const blocks = [];
    rows.forEach(([a, b]) => {
      const last = blocks[blocks.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else blocks.push([a, b]);
    });
    return blocks;
  }, [apptSlotsForExpert, apptSelectedExpert]);

  const apptShiftName = (mins) => (mins < 12 * 60 ? "Morning" : mins < 17 * 60 ? "Afternoon" : "Evening");
  const apptDayHours = apptDayBlocks.map(([a, b]) => `${to12h(apptClockText(a))} – ${to12h(apptClockText(b))}`).join(" · ");

  // A typed time outside every published stretch. Said, not refused: the branch may have
  // agreed something with the consultant that the calendar has not caught up with, and
  // this screen is not the place to overrule a conversation. What it must not do is let
  // that happen silently.
  const apptOutsideHours = useMemo(() => {
    const t = apptMinutesOf(apptDraft?.appointment_time);
    if (t === null || apptDayBlocks.length === 0) return false;
    return !apptDayBlocks.some(([a, b]) => t >= a && t + apptSlotMinutes <= b);
  }, [apptDraft?.appointment_time, apptDayBlocks, apptSlotMinutes]);

  // Whatever already holds the consultant across the typed hour. Overlap and not an exact
  // match, because a typed 10:20 collides with a 45-minute 10:00 without sharing its
  // start — which is the one thing a free-typed field makes easy to do by accident. The
  // endpoint refuses it too; this is so the refusal is read before Confirm, not after.
  const apptClash = useMemo(() => {
    const start = apptMinutesOf(apptDraft?.appointment_time);
    if (start === null) return null;
    return apptSlotsForExpert.find((x) => {
      if (!x.booked) return false;
      const t = apptMinutesOf(x.time);
      return t !== null && start < t + (Number(x.duration) || 30) && t < start + apptSlotMinutes;
    }) || null;
  }, [apptDraft?.appointment_time, apptSlotsForExpert, apptSlotMinutes]);

  /** The three fields read as one 24-hour "HH:MM", or "" while any of them is unreadable. */
  const apptClockOf = ({ h, m, ap }) => {
    const hh = Number(h);
    const mm = Number(m);
    if (String(h).trim() === "" || !Number.isInteger(hh) || hh < 1 || hh > 12) return "";
    if (String(m).trim() === "" || !Number.isInteger(mm) || mm < 0 || mm > 59) return "";
    const h24 = ap === "PM" ? (hh === 12 ? 12 : hh + 12) : hh === 12 ? 0 : hh;
    return `${String(h24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  /** Type into one of the three fields. The draft's time follows them, and goes empty
   *  again the moment they stop reading as a clock — Confirm is gated on it, so a
   *  half-typed hour can never be the one that books. */
  const setApptClock = (patch) => {
    const next = { ...apptTime, ...patch };
    setApptTime(next);
    const hhmm = apptClockOf(next);
    setApptDraft((d) => (d ? { ...d, appointment_time: hhmm, duration: hhmm ? apptSlotMinutes : null } : d));
  };

  /** "14:30" -> the three fields. For reopening a booking onto the hour it already holds. */
  const apptClockFrom = (hhmm) => {
    const mins = apptMinutesOf(hhmm);
    if (mins === null) return { h: "", m: "", ap: "AM" };
    const h24 = Math.floor(mins / 60);
    return {
      h: String(h24 % 12 === 0 ? 12 : h24 % 12),
      m: String(mins % 60).padStart(2, "0"),
      ap: h24 >= 12 ? "PM" : "AM",
    };
  };

  /** Open the pencil on a taken slot. Asks who else is free at that exact time up front,
   *  because CONSULTANT is the tab that opens and an empty list is itself the answer. */
  const openSlotEdit = async (s) => {
    if (!s?.lead_id) {
      // Older appointment rows predate lead_id being stored on them. Nothing here can
      // address a booking it cannot name, so say so rather than open a dead dialog.
      toast.error("This booking is too old to move from here — open the patient's own card");
      return;
    }
    const dateStr = apptDraft?.appointment_date;
    setSlotEdit({
      date: dateStr,
      time: s.time,
      duration: s.duration,
      leadId: s.lead_id,
      leadName: s.lead_name || "This patient",
      physioId: apptSelectedExpert?.id || "",
      physioName: apptSelectedExpert?.full_name || "",
      // The pencil is only ever pressed from the grid this card's own patient is being
      // booked on, so the time this move empties has an obvious taker. Offered rather
      // than assumed — tidying a calendar and leaving the slot open is the other reason
      // to be here — and not offered when the booking in the way is already theirs.
      canTake: s.lead_id !== lead.id,
      takeSlot: s.lead_id !== lead.id,
      mode: "consultant",
      options: [],
      pickedPhysioId: "",
      loading: true,
      saving: false,
      moveDate: dateStr,
      moveTime: "",
      moveDuration: s.duration,
      dayLoading: false,
      daySlots: [],
      swapLoading: false,
      swapOptions: [],
      swapLeadId: "",
      swapQuery: "",
    });
    try {
      // Asked with the time, which is the form that answers "who is not already booked
      // then" rather than "who published it" — the same distinction the handover on the
      // lead card draws. lead_id keeps this booking from reading as a clash with itself.
      const res = await getAvailableExperts(branchId, dateStr, s.time, s.lead_id);
      setSlotEdit((p) => (p ? { ...p, options: res.experts || [], loading: false } : p));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load consultants");
      setSlotEdit((p) => (p ? { ...p, loading: false } : p));
    }
  };

  /** The held consultant's own open times on whichever date the PATIENT tab is showing.
   *  Ids are passed in rather than read off state: this runs from a click that has just
   *  queued a state change, and the copy in scope would be the one before it. */
  const loadSlotEditDay = async (dateStr, physioId, leadId) => {
    setSlotEdit((p) => (p ? { ...p, moveDate: dateStr, moveTime: "", dayLoading: true, daySlots: [] } : p));
    try {
      const res = await getAvailableExperts(branchId, dateStr, undefined, leadId);
      const doc = (res.experts || []).find((d) => d.id === physioId);
      const slots = [...(doc?.free_slots || [])].sort((a, b) => (a.slot_time || "").localeCompare(b.slot_time || ""));
      // Their own booking is excluded from the clash check by lead_id, so the time they
      // already hold comes back as free. Moving onto it frees nothing, and with the swap
      // armed it would hand this card's patient a slot that is still taken.
      setSlotEdit((p) => (p ? {
        ...p,
        daySlots: slots.filter((sl) => !(dateStr === p.date && sl.time === p.time)),
        dayLoading: false,
      } : p));
    } catch {
      setSlotEdit((p) => (p ? { ...p, daySlots: [], dayLoading: false } : p));
    }
  };

  /** Book this card's own patient into a slot and raise the confirmation slip. Lifted out
   *  of the Confirm button because the reschedule below finishes the same way: whichever
   *  door the booking comes through, it needs the one ref number, the one share token and
   *  the same printable slip. */
  const bookLeadInto = async (draft) => {
    // Minted here so the confirmation, its share link and the stored booking all carry
    // the same pair — no second round trip to learn what the server called it.
    const refNo = `APT-${(lead.patient_number || lead.id || "").toString().slice(-8).toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const shareToken = randomToken();
    // step and visit_package are the popup's own bookkeeping, not part of the booking.
    const { step: _step, visit_package: _pkg, ...rest } = draft;
    // The typed amount only means something on a package with no fixed price.
    const payload = { ...rest, visit_package_amount: _pkg?.manual ? Number(rest.visit_package_amount) || null : null };
    const saved = await scheduleBranchAppointment(lead.id, { ...payload, ref_no: refNo, share_token: shareToken });
    toast.success(`Appointment ${draft.appointment_date} ${to12h(draft.appointment_time)} → ${draft.final_stage}`);
    setApptDraft(null);
    // The confirmation shows first and only tells the parent to close once it's
    // dismissed — onMoved unmounts this whole card, and the confirmation has to survive
    // long enough to be shared or printed.
    const hp = (apptExperts.experts || []).find((d) => d.id === draft.physio_id);
    setApptConfirm({
      finalStage: draft.final_stage,
      refNo,
      shareToken,
      patient: lead.name || "—",
      patientNo: lead.patient_number || "—",
      phone: lead.phone || "—",
      branch: branchInfo?.branch_name || lead.branch_name || "",
      branchAddress: branchInfo?.address || "",
      mapLocation: branchInfo?.map_location || "",
      adminName: branchInfo?.admin_name || "",
      adminPhone: branchInfo?.admin_phone || "",
      branchPhone: branchInfo?.phone || "",
      date: draft.appointment_date,
      time: draft.appointment_time,
      duration: draft.duration || 30,
      headPhysio: hp?.full_name || lead.assigned_physio_name || "—",
      // Read back off the saved lead: the server prices the package off the catalogue.
      houseVisit: saved?.visit_type === "home",
      packageName: saved?.visit_package_name || "",
      packagePrice: saved?.visit_package_price ?? null,
      // The room this was booked into. The server writes the same value onto the
      // appointment off the expert's own record, so what is shared here is what the
      // booking holds.
      meetLink: (hp?.meet_link || "").trim(),
      notes: (draft.notes || "").trim(),
      bookedBy: "Branch Admin",
    });
  };

  /** Every other patient at this branch who is holding a consultation, for the SWAP tab.
   *  Asked only when that tab is first opened — it is the third of three and the branch
   *  reaches for it rarely, so loading it with the dialog would be a request per pencil
   *  press for a list most of them never see. */
  const loadSwapCandidates = async (leadId) => {
    setSlotEdit((p) => (p ? { ...p, swapLoading: true } : p));
    try {
      const res = await getSwapCandidates(branchId, leadId);
      setSlotEdit((p) => (p ? { ...p, swapOptions: res.candidates || [], swapLoading: false } : p));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load the other appointments");
      setSlotEdit((p) => (p ? { ...p, swapOptions: [], swapLoading: false } : p));
    }
  };

  /** The SWAP tab's list, narrowed by its search box. Name, consultant, date and time
   *  all match on: a branch hunting for "Monisha" wants that consultant's patients and
   *  one hunting for "2:00" wants the two o'clock, and which of those they have in hand
   *  is whatever the patient on the phone happened to say. */
  const swapCandidates = useMemo(() => {
    const all = slotEdit?.swapOptions || [];
    const q = (slotEdit?.swapQuery || "").trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => (
      `${c.lead_name || ""} ${c.doctor_name || ""} ${c.appointment_date || ""} ${to12h(c.appointment_time || "")}`
        .toLowerCase().includes(q)
    ));
  }, [slotEdit?.swapOptions, slotEdit?.swapQuery]);

  // The row currently picked, read back off the unfiltered list — typing in the search
  // box after choosing somebody must not quietly unpick them.
  const swapPicked = useMemo(
    () => (slotEdit?.swapLeadId ? (slotEdit.swapOptions || []).find((c) => c.lead_id === slotEdit.swapLeadId) : null) || null,
    [slotEdit?.swapOptions, slotEdit?.swapLeadId],
  );

  /** Trade the two appointments. Only the pair of leads is sent: what each of them ends
   *  up holding is read off their live bookings server-side, so this cannot post a
   *  patient to a slot that was not already published and booked by somebody. */
  const submitSlotSwap = async () => {
    const other = (slotEdit.swapOptions || []).find((c) => c.lead_id === slotEdit.swapLeadId);
    if (!other) { toast.error("Pick the patient to swap with"); return; }
    setSlotEdit((p) => ({ ...p, saving: true }));
    try {
      await swapBranchAppointment(slotEdit.leadId, other.lead_id);
      toast.success(`${slotEdit.leadName} ↔ ${other.lead_name || "the other patient"} — slots swapped`);
      setSlotEdit(null);
      // Both sides of the swap can be on the day behind this dialog, so the grid is
      // re-asked rather than patched — the same call that feeds the CONSULTANT column.
      await fetchAvailableExperts(branchId, apptDraft?.appointment_date, lead.id);
      await onUpdate?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not swap the appointments");
      setSlotEdit((p) => (p ? { ...p, saving: false } : p));
    }
  };

  /** Apply whichever tab is open. CONSULTANT and PATIENT are the one POST that books
   *  anything — the first changes who holds the slot, the second changes when it is, and
   *  the endpoint works out which of those happened. SWAP is the other endpoint, because
   *  an exchange is two appointments moving at once and a booking can only move one.
   *
   *  final_stage is this board's Appointment stage. A lead booked under a different
   *  vertical's pipeline is refused by name there rather than moved onto the wrong
   *  stage, and the refusal is what the toast shows. */
  const submitSlotEdit = async () => {
    if (!slotEdit || slotEdit.saving) return;
    if (slotEdit.mode === "swap") { await submitSlotSwap(); return; }
    const swappingConsultant = slotEdit.mode === "consultant";
    const physioId = swappingConsultant ? slotEdit.pickedPhysioId : slotEdit.physioId;
    const date = swappingConsultant ? slotEdit.date : slotEdit.moveDate;
    const time = swappingConsultant ? slotEdit.time : slotEdit.moveTime;
    const duration = swappingConsultant ? slotEdit.duration : slotEdit.moveDuration;
    if (swappingConsultant && !physioId) { toast.error("Pick the consultant to move it to"); return; }
    if (!swappingConsultant && !time) { toast.error("Pick the time to move it to"); return; }
    // Belt and braces on the slot the PATIENT tab already leaves out: a move onto the
    // time it is on now empties nothing, and the swap below would then book this card's
    // patient into a slot that is still taken.
    if (!swappingConsultant && date === slotEdit.date && time === slotEdit.time) {
      toast.error("That is the time it is on now — pick a different one");
      return;
    }
    const taking = slotEdit.canTake && slotEdit.takeSlot;
    setSlotEdit((p) => ({ ...p, saving: true }));
    try {
      await scheduleBranchAppointment(slotEdit.leadId, {
        appointment_date: date,
        appointment_time: time,
        physio_id: physioId,
        final_stage: appointmentStageName,
        ...(duration ? { duration } : {}),
      });
      const movedTo = swappingConsultant
        ? (slotEdit.options.find((d) => d.id === physioId)?.full_name || "another consultant")
        : `${weekdayLabel(date)} ${to12h(time)}`;
      toast.success(`${slotEdit.leadName} moved to ${movedTo}`);
      setSlotEdit(null);
      if (taking) {
        // The half of the swap this dialog was opened for. Either tab empties the same
        // slot — CONSULTANT hands the time to somebody else, PATIENT takes the booking
        // off it — so the time now going to this card's patient is the one the pencil was
        // pressed on, not the one the booking moved to. Two calls, because the two
        // bookings belong to two different leads.
        try {
          await bookLeadInto({
            ...apptDraft,
            appointment_date: slotEdit.date,
            appointment_time: slotEdit.time,
            physio_id: slotEdit.physioId,
            ...(slotEdit.duration ? { duration: slotEdit.duration } : {}),
          });
        } catch (e2) {
          // The move already went through, so this cannot report as a failed reschedule.
          // Says which half stands and leaves the grid on the freed slot to be taken by
          // hand.
          toast.error(e2?.response?.data?.detail || `${slotEdit.leadName} was moved, but ${lead.name || "this patient"} could not be booked into ${to12h(slotEdit.time)} — it is free on the grid now`);
          await fetchAvailableExperts(branchId, apptDraft?.appointment_date, lead.id);
          await onUpdate?.();
        }
        return;
      }
      // The grid behind this dialog is a snapshot of the day taken before the move, so it
      // still shows the slot as taken and the new one as free. Re-ask rather than patch:
      // the same call feeds the CONSULTANT column's availability too.
      await fetchAvailableExperts(branchId, apptDraft?.appointment_date, lead.id);
      await onUpdate?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not reschedule");
      setSlotEdit((p) => (p ? { ...p, saving: false } : p));
    }
  };

  useEffect(() => {
    if (!apptDraft || !apptDraft.appointment_date || !branchId) return;
    fetchAvailableExperts(branchId, apptDraft.appointment_date, lead.id);
  }, [apptDraft?.appointment_date, branchId, lead.id, fetchAvailableExperts]);

  // Which days of the shown month have a free slot, refreshed whenever the popup pages to
  // another month.
  useEffect(() => {
    if (!apptDraft || !branchId) { return; }
    const month = `${apptMonth.y}-${String(apptMonth.m + 1).padStart(2, "0")}`;
    let cancelled = false;
    getAvailableDates(branchId, month, lead.id)
      .then((res) => { if (!cancelled) setApptOpenDates(res?.dates || {}); })
      .catch(() => { if (!cancelled) setApptOpenDates({}); });
    return () => { cancelled = true; };
  }, [apptDraft ? true : false, apptMonth.y, apptMonth.m, branchId, lead.id]);

  // Open the popup's calendar on the month the booking already sits in — reopening an
  // appointment made for next month shouldn't land on today's page with nothing selected.
  useEffect(() => {
    const d = apptDraft?.appointment_date;
    if (!d) return;
    const [y, m] = d.split("-").map(Number);
    setApptMonth((prev) => (prev.y === y && prev.m === m - 1 ? prev : { y, m: m - 1 }));
  }, [apptDraft?.appointment_date]);

  const loadRemarks = async () => {
    try { setRemarks(await getLeadRemarks(lead.id)); } catch { /* silent */ }
  };
  const loadActivity = async () => {
    try { setActivityLog(await getLeadActivity(lead.id)); } catch { /* silent */ }
  };

  useEffect(() => {
    if (activeTab === "timeline") { loadRemarks(); loadActivity(); }
    if (activeTab === "rnr") { loadActivity(); }
  }, [activeTab, lead.id]);

  // Reports whether it actually moved. The toast is still raised here -- every caller
  // wants it -- but a caller holding a confirmation dialog open needs to know not to
  // dismiss it over a move the server refused.
  const moveStage = async (stage) => {
    try {
      await moveBranchStage(lead.id, { branch_stage: stage });
      toast.success(`Moved to ${stage}`);
      onMoved && onMoved(stage); // closes immediately; parent refreshes the list itself
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Move failed");
      return false;
    }
  };

  // Same endpoint and counter Pre-Sales' own RNR tracker uses — logging an attempt here
  // doesn't move the lead off RNR, so the modal stays open and just refreshes in place,
  // same as scheduling or rescheduling a follow-up does.
  const logRnrAttempt = async () => {
    const next = (lead.rnr_attempts || 0) + 1;
    if (!window.confirm(`Log a No Answer for ${lead.name || "this client"}?\n\nThis records attempt #${next}.`)) return;
    try {
      const updated = await rnrAttempt(lead.id);
      toast.success(`Attempt logged (#${updated.rnr_attempts})`);
      await onUpdate();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to log attempt");
    }
  };

  const submitFollowUp = async () => {
    if (!followUpForm.date || !followUpForm.time) { toast.error("Date and time are required"); return; }
    try {
      setFollowUpBusy(true);
      await scheduleBranchFollowUp(lead.id, followUpForm);
      toast.success("Follow-up scheduled");
      setFollowUpForm({ date: tomorrowIso(), time: "10:00", remarks: "" });
      await onUpdate();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to schedule follow-up");
    } finally {
      setFollowUpBusy(false);
    }
  };

  const submitReschedule = async () => {
    if (!rescheduleDraft?.date || !rescheduleDraft?.time) { toast.error("Date and time are required"); return; }
    try {
      setFollowUpBusy(true);
      await rescheduleBranchFollowUp(lead.id, rescheduleDraft.followupId, {
        date: rescheduleDraft.date,
        time: rescheduleDraft.time,
        reason: rescheduleDraft.reason,
      });
      toast.success("Follow-up rescheduled");
      setRescheduleDraft(null);
      await onUpdate();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to reschedule");
    } finally {
      setFollowUpBusy(false);
    }
  };

  const submitFollowUpMove = async () => {
    if (!followUpMoveDraft?.date || !followUpMoveDraft?.time) { toast.error("Date and time are required"); return; }
    try {
      setFollowUpMoveBusy(true);
      await scheduleBranchFollowUp(lead.id, followUpMoveDraft);
      toast.success("Moved to Follow Up");
      setFollowUpMoveDraft(null);
      onMoved && onMoved("Follow Up"); // closes immediately; parent refreshes the list itself
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to schedule");
    } finally {
      setFollowUpMoveBusy(false);
    }
  };

  const TABS = [
    { key: "overview", label: "Overview", color: "bg-sky-500" },
    { key: "follow-up", label: "Follow-Up", color: "bg-amber-500" },
    { key: "timeline", label: "Timeline", color: "bg-emerald-500" },
    { key: "rnr", label: "RNR Record", color: "bg-rose-500" },
    // Last, and deliberately after the three working tabs. The first four are what
    // somebody DOES with a lead; this one is what the lead already told us, which is
    // read once and then referred back to rather than worked.
    { key: "lead-details", label: "Lead Details", color: "bg-indigo-500" },
  ];

  const avatarFirstChar = (lead.name?.trim()?.charAt(0) || "?").toUpperCase();

  // The follow-up the lead is actually on, for the Overview preview below. Newest first
  // and skipping the rescheduled ones, which is the same rule the Follow-Up tab draws
  // with — a booking that was moved is history, not the appointment somebody is waiting
  // on, and previewing it would name a date nobody is going to call on.
  const followUps = lead.follow_ups || [];
  const activeFollowUp = followUps.slice().reverse().find((f) => f.status !== "rescheduled") || null;
  // Matched loosely rather than against a literal "Follow Up": these names are editable in
  // Pipeline Stage Management, and a rename there should not silently empty this card.
  const atFollowUpStage = /follow\s*-?\s*up/i.test(headerStageName || "");
  // The attempts, newest last, exactly as the endpoint wrote them — one lead_activity row
  // per press of +1 No Answer, carrying who pressed it and when.
  const rnrLog = activityLog.filter((a) => a.action === "rnr_attempt");
  const rnrCount = lead.rnr_attempts || 0;
  // The literal is inherited from the tracker this replaces, and from the stage seed that
  // writes it (ensure_rnr_stage). Unlike Follow Up it is not matched loosely: RNR is an
  // initialism, and a loose test for three letters catches stage names that merely contain
  // them.
  const atRnrStage = lead.branch_stage === stageNameForRole(stages, STAGE_ROLE_RNR);
  // Drawn for a lead that has been called and not answered even after it has moved on:
  // the attempts are the reason it sits where it does, and they do not stop being true.
  const showRnrCard = atRnrStage || rnrCount > 0;
  // What the lead itself says about the patient, as against what the pipeline says about
  // them. This popup could show neither: it opened on a phone number, a stage strip and
  // nothing else, so a lead somebody had filled a whole intake form for read as blank as a
  // name typed in at the desk.
  //
  // Empty fields are dropped rather than drawn as em-dashes. A walk-in carries three of
  // these and a sheet import carries fifteen, and a fixed list would show the first as a
  // page of dashes — which is close to how the popup already read.
  const leadDetailRows = [
    ["Source", lead.source_tab || lead.source_type],
    ["Department", departmentLabel(lead.department)],
    ["Alternative Phone", lead.alternative_phone],
    ["Age", lead.age],
    ["Gender", lead.gender],
    ["Occupation", lead.occupation],
    ["Condition", lead.condition],
    ["Months of Pain", hasValue(lead.months_of_pain) ? `${lead.months_of_pain} ${Number(lead.months_of_pain) === 1 ? "month" : "months"}` : ""],
    ["Expected Consultation", hasValue(lead.expected_consultation_date) ? weekdayLabel(lead.expected_consultation_date) : ""],
    ["Location", lead.location],
    ["Address", lead.address],
    // cityAnswer, not lead.city: the list column reads both the mapped field and the
    // unmapped sheet header, and a city shown in the list that disappeared on opening the
    // patient would read as the popup being wrong about them.
    ["City", cityAnswer(lead)],
    ["State", lead.state],
    ["Assigned To", lead.assigned_user_name],
    // Last, and the one row every lead has: created_at is required on the record, so the
    // card can never come out empty however little else was filled in.
    ["Added", dateStampFull(lead.created_at)],
  ].filter(([, value]) => hasValue(value));

  // Every answer the intake form collected, keyed by the question as that sheet asked it.
  // However long the form was: a branch that asks nine questions has nine rows here, and no
  // board can know their names in advance.
  //
  // A column mapped onto one of the lead's own fields leaves no extra_fields entry behind,
  // so the two lists do not repeat each other — and where both hold an answer to the same
  // question they are genuinely two stored answers, both worth reading.
  //
  // Held to the three types a form field can honestly be. extra_fields is Dict[str, Any] on
  // the wire and nothing validates what a sheet puts in it, so a nested value is possible —
  // and String() would draw that as the literal "[object Object]", which is worse than not
  // drawing the row at all.
  const rawFormAnswers = Object.entries(lead.extra_fields || {}).filter(
    ([, value]) => ["string", "number", "boolean"].includes(typeof value) && hasValue(value),
  );

  // The ad record is not shown in this popup at all — which advert bought the lead is a
  // marketing question, and this screen answers a clinical one. lead_data is simply never
  // read here, but a sheet whose Meta columns were mapped as custom questions — or synced
  // before lead_data existed to map onto — stores "ad_name", "campaign_id" and the rest in
  // extra_fields, where dropping the block alone would leave them: eight lines of ad
  // plumbing filed as answers the patient gave, above the question they came in with.
  //
  // So they are recognised by what the key means rather than by where it sits, and left
  // out. Keys are matched loosely because a sheet header is written by a person: "Ad
  // Name", "ad-id" and "ad_id" are one field, whatever the column said. Anything that is
  // not a Meta field stays where it is — a question is a question. Nothing is hidden that
  // was not already elsewhere: the ad record still reads in full on the Super Admin board.
  //
  // City is held out of the list for a narrower reason. The rows above name it already —
  // and now name it whether it was mapped or not, since that is what the list column
  // reads — so leaving the extra_fields copy here prints one answer twice under one word,
  // a few lines apart. That is not two stored answers worth reading, it is the same
  // answer said twice.
  //
  // Only the copy the City row is actually showing is withheld: the keys here are the
  // ones cityAnswer reads, so nothing is dropped that the popup does not print elsewhere.
  const formAnswers = [];
  rawFormAnswers.forEach(([key, value]) => {
    if (matchesFormKey(key, CITY_KEYS)) return;
    if (AD_FIELD_KEYS.has(normaliseAdKey(key))) return;
    formAnswers.push([key, value]);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="branch-lead-modal-overlay">
      {/* A floating card on every size, not a full-bleed sheet on a phone. Edge to edge
          reads as a page you navigated to — there's no backdrop left to show it sits on
          top of the list, and nothing to tap beside it to dismiss. Height is capped so
          the darkened list stays visible above and below; the body below scrolls. */}
      <div className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 sm:max-h-[90vh] sm:max-w-2xl" data-testid="branch-lead-modal">
        {/* Plain header. The gradient made this the loudest thing on a screen whose
            subject is the cards underneath — the patient's name and their stage are the
            information here, and they read better on white than reversed out of three
            colours. Every chip in it had been picked to survive that background: white on
            20% white, a name with no colour of its own inheriting the band's. Those are
            set against the page now instead. */}
        <div className="relative border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-base font-bold text-slate-600 ring-1 ring-slate-200">{avatarFirstChar}</span>
              <div>
                <p className="text-base font-semibold leading-tight text-slate-900" data-testid="branch-lead-name">{lead.name}<TransferredTag lead={lead} className="ml-1.5" /></p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {lead.patient_number && (
                    <span className="rounded-[5px] bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-600" data-testid="branch-lead-patient-number">{lead.patient_number}</span>
                  )}
                  <span className="rounded-[5px] border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700" data-testid="branch-lead-stage">
                    {/* Named the same way the row that opened this popup was: opened from
                        Leads it reads Leads, and the pipeline below highlights Leads too. */}
                    {headerStageName ? headerStageName : "No Stage"}
                  </span>
                  {lead.consultation_fee && <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold text-teal-700 ring-1 ring-teal-100">Fee Rs.{lead.consultation_fee}</span>}
                  {lead.package_amount && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-100">Pkg Rs.{lead.package_amount}</span>}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* Super Admin only — the backend refuses anyone else, and the branch losing
                  the patient should not be the one deciding it. */}
              {canTransferBranch && (
                <button
                  onClick={() => setTransferring(true)}
                  title="Branch Transfer"
                  aria-label="Branch Transfer"
                  className="inline-flex items-center rounded-[5px] border border-indigo-200 bg-white p-1.5 text-indigo-600 transition hover:bg-indigo-50"
                  data-testid="branch-lead-transfer"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-[5px] border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
                data-testid="branch-lead-edit"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <button onClick={onClose} className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" data-testid="branch-lead-close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Pill tabs */}
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 bg-slate-50/60 px-5 py-2.5" data-testid="branch-lead-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`rounded-[5px] px-3.5 py-1 text-xs font-semibold capitalize transition-all ${activeTab === t.key ? `${t.color} text-white shadow-sm` : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"}`}
              data-testid={`branch-lead-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-50/30 p-5" data-testid="branch-lead-content">
          {activeTab === "overview" && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-xl border border-sky-100 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-100 text-sky-600"><Phone className="h-4 w-4" /></span>
                  <p className="text-xs font-bold uppercase tracking-wider text-sky-700">Contact</p>
                </div>
                <div className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between text-sm"><span className="text-xs font-medium text-slate-500">Phone</span><span className="font-medium text-slate-800">{lead.phone || "—"}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-xs font-medium text-slate-500">Email</span><span className="font-medium text-slate-800">{lead.email || "—"}</span></div>
                </div>
              </div>

              {/* Above the pipeline for the same reason the Follow-Up card is: on a lead
                  parked at RNR, how many times somebody has rung is what the popup is
                  being opened to find out. It used to sit *under* the stage picker, below
                  a row of eleven buttons, which is a long way past the point the reader
                  had already made up their mind.

                  RNR first and Follow Up second, matching the order the two stages come
                  in on the pipeline itself. */}
              {showRnrCard && (
                <div className="overflow-hidden rounded-xl border border-rose-100 bg-white shadow-sm" data-testid="branch-lead-rnr-status">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-700">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-rose-600"><PhoneOff className="h-4 w-4" /></span>
                      RNR Status
                    </p>
                    {/* Only where there is a record to open. With no attempt logged the
                        tab is an empty page, and offering it reads as a promise of one. */}
                    {rnrCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveTab("rnr")}
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50"
                        data-testid="branch-lead-rnr-status-open"
                      >
                        Record
                      </button>
                    )}
                  </div>
                  <div className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">Client Not Answered</p>
                        <p className="text-[11px] text-slate-500" data-testid="branch-lead-rnr-attempts">
                          Attempts so far: <span className="font-bold text-rose-600">{rnrCount}</span>
                        </p>
                        {lead.rnr_last_attempt_at && (
                          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500" data-testid="branch-lead-rnr-lastcall">
                            <Clock className="h-3 w-3" />
                            Last call
                            <span className="font-bold text-slate-700">{callTimeStamp(lead.rnr_last_attempt_at)}</span>
                            <span className="text-slate-400">· {callDateStamp(lead.rnr_last_attempt_at)}</span>
                          </p>
                        )}
                      </div>
                      {/* Logging an attempt is only offered while the lead is actually
                          parked at RNR. On one that has moved on, this card is a record of
                          what happened rather than a desk to work from. */}
                      {atRnrStage && (
                        <Button
                          size="sm"
                          onClick={logRnrAttempt}
                          className="h-8 shrink-0 bg-rose-600 text-white hover:bg-rose-700"
                          data-testid="branch-lead-rnr-attempt"
                        >
                          <PhoneOff className="mr-1 h-3.5 w-3.5" /> +1 No Answer
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Between Contact and the pipeline, because on a lead sitting at Follow Up
                  the next call is the thing the popup is being opened to check. The
                  Follow-Up tab still owns scheduling and the full history; this is the one
                  line of it worth reading without changing tabs, and it says so with a link
                  rather than repeating the form. */}
              {(followUps.length > 0 || atFollowUpStage) && (
                <div className="overflow-hidden rounded-xl border border-amber-100 bg-white shadow-sm" data-testid="branch-lead-followup-preview">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-700">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700"><Bell className="h-4 w-4" /></span>
                      Follow-Up
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab("follow-up")}
                      className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50"
                      data-testid="branch-lead-followup-preview-open"
                    >
                      {activeFollowUp ? "Manage" : "Schedule"}
                    </button>
                  </div>
                  {activeFollowUp ? (() => {
                    const dt = new Date(`${activeFollowUp.date}T${activeFollowUp.time}:00`);
                    const isUpcoming = dt.getTime() > Date.now();
                    // Everything before the one that stands. Counted rather than listed:
                    // the tab is where a history belongs, and a preview that grows with it
                    // stops being a preview.
                    const earlier = followUps.length - 1;
                    return (
                      <div className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800" data-testid="branch-lead-followup-preview-when">
                            {dt.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · {activeFollowUp.time}
                          </p>
                          {/* Overdue is the state worth colouring: an upcoming call needs
                              no action today, a missed one does. */}
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
                    <p className="px-4 py-3 text-sm text-slate-400" data-testid="branch-lead-followup-preview-empty">
                      No follow-up scheduled yet.
                    </p>
                  )}
                </div>
              )}

              {/* The booked slot leads, because on a lead sitting at Appointment that is
                  the thing somebody opened this popup to read. It used to be missing
                  entirely: the card was drawn only when a department, a mode or a
                  diagnosis had been filled in, none of which booking an appointment
                  writes — so a patient with a day and a time on file had a popup that
                  never mentioned either, and the only sign of the appointment was the
                  word in the header. */}
              {(lead.appointment_date || lead.appointment_time || lead.appointment_department || lead.appointment_mode || lead.diagnosis) && (
                <div className="overflow-hidden rounded-xl border border-blue-100 bg-white shadow-sm" data-testid="branch-lead-appointment-details">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-700">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-blue-700"><ClipboardList className="h-4 w-4" /></span>
                      Appointment Details
                    </p>
                    {/* The confirmation the patient was sent, handed back. The branch's
                        copy of it used to live exactly as long as the dialog that raised
                        it, so a patient who lost the WhatsApp message could only be given
                        another by rescheduling the appointment onto itself to make one.

                        On this card rather than up in the header, because the sheet is
                        about the slot printed underneath it -- somebody reaching for it is
                        already reading this block to check the day.

                        Appointment stage only. Before it there is no booking to print, and
                        the stages after it belong to boards that hand the patient their
                        own documents; the endpoint answers for the live consultation alone
                        and refuses a cancelled one, which is the same line. */}
                    {inAppointmentStage && (
                      <button
                        type="button"
                        onClick={openApptCard}
                        disabled={loadingApptCard}
                        className="flex shrink-0 items-center gap-1 rounded-[5px] border border-teal-200 bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-100 disabled:opacity-60"
                        title="Open the appointment confirmation — print, send or download it again"
                        data-testid="branch-lead-open-appt-card"
                      >
                        <Eye className="h-3.5 w-3.5 shrink-0" />
                        {loadingApptCard ? "Opening..." : "View"}
                      </button>
                    )}
                  </div>
                  <div className="space-y-2 px-4 py-3">
                    {lead.appointment_date && (
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="shrink-0 text-xs font-medium text-slate-500">Date</span>
                        <span className="text-right font-medium text-slate-800" data-testid="branch-lead-appt-date">{weekdayLabel(lead.appointment_date)}</span>
                      </div>
                    )}
                    {lead.appointment_time && (
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="shrink-0 text-xs font-medium text-slate-500">Time</span>
                        <span className="text-right font-semibold text-slate-900" data-testid="branch-lead-appt-time">{to12h(lead.appointment_time)}</span>
                      </div>
                    )}
                    {lead.appointment_department && (
                      <div className="flex items-center justify-between text-sm"><span className="text-xs font-medium text-slate-500">Service</span><span className="font-medium capitalize text-slate-800">{lead.appointment_department === "physio" ? "Physiotherapy" : "Fitness"}</span></div>
                    )}
                    {lead.appointment_mode && (
                      <div className="flex items-center justify-between text-sm"><span className="text-xs font-medium text-slate-500">Type</span><span className="font-medium capitalize text-slate-800">{lead.appointment_mode}</span></div>
                    )}
                    {lead.diagnosis && (
                      <div className="text-sm"><span className="text-xs font-medium text-slate-500">Diagnosis</span><p className="mt-0.5 font-medium text-slate-800">{lead.diagnosis}</p></div>
                    )}
                  </div>
                </div>
              )}

              {lead.assigned_physio_name && (
                <div className="overflow-hidden rounded-xl border border-emerald-100 bg-white shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700"><UserPlus className="h-4 w-4" /></span>
                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Assigned Jr. Physio</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <p className="min-w-0 truncate text-sm font-medium text-slate-800">{lead.assigned_physio_name}</p>
                    {/* Only where there is a booked slot to hand over. Without a date and a
                        time this is a reassignment with nothing to reassign, and the
                        appointment dialog is the right place to make one. */}
                    {lead.appointment_date && lead.appointment_time && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 text-[11px]"
                        onClick={() => openHandover(lead)}
                        data-testid={`appt-handover-open-${lead.id}`}
                      >
                        <ArrowLeftRight className="mr-1 h-3 w-3" /> Change
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {lead.notes && (
                <div className="overflow-hidden rounded-xl border border-amber-100 bg-white shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700"><FileText className="h-4 w-4" /></span>
                    <p className="text-xs font-bold uppercase tracking-wider text-amber-700">Notes</p>
                  </div>
                  <p className="px-4 py-3 text-sm leading-relaxed text-slate-700">{lead.notes}</p>
                </div>
              )}

              {/* Stage Pipeline */}
              <div className="overflow-hidden rounded-xl border border-violet-100 bg-white shadow-sm" data-testid="branch-lead-pipeline">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-violet-700"><ChevronRight className="h-4 w-4" /></span>
                  <p className="text-xs font-bold uppercase tracking-wider text-violet-700">Pipeline Stage</p>
                </div>
                <div className="flex flex-wrap gap-2 px-4 py-3">
                  {(pipelineStages || []).map((s) => {
                    const stage = s.name;
                    // The mirrored "Leads" pill reads the lead's Pre-Sales stage instead of
                    // its branch stage, and is never a move target: it exists to show where
                    // the lead already is, and writing to it would move the lead inside the
                    // Pre-Sales pipeline, which this board does not own.
                    const isMirror = !!s.mirrors_stage;
                    // Highlighted on the same terms the board filters by, so the pipeline
                    // here agrees with the pill the lead was listed under.
                    const isActive = isMirror
                      ? matchesBranchStage(lead, s, isConsultationOnlyStage, consultationOpeningStage)
                      : (lead.branch_stage === stage || lead.consultation_stage === stage);
                    const consultationOnly = isConsultationOnlyStage(stage);
                    // A Consultation-only stage isn't reachable until the lead has actually
                    // entered that pipeline (schedule-branch-appointment seeds
                    // consultation_stage the first time) — shown, but not yet clickable.
                    const notYetReached = consultationOnly && !lead.consultation_stage;
                    // Everything that is not one of Appointment's four exits, while the
                    // lead is sitting on Appointment. Drawn, and deliberately dead.
                    const blockedFromAppointment = inAppointmentStage && !isActive && !APPOINTMENT_EXITS.includes(stage);
                    const tint = s.color || "#64748b";
                    const handleClick = () => {
                      if (isMirror || blockedFromAppointment) return;
                      // Cancelling is not a move like the others: it puts the expert's slot
                      // back on the calendar, and the lead stops here. Asked before, not
                      // reported after — the pill sits one press from Follow Up and there
                      // is nothing on this card that undoes it.
                      if (stage === cancelledStageName) {
                        setCancelDraft(true);
                        return;
                      }
                      if (stage === appointmentStageName) {
                        setApptDraft({
                          appointment_date: lead.appointment_date || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
                          // Left blank unless this lead already holds one. Nothing is
                          // guessed: an hour typed into the field by the screen rather
                          // than by the desk is an hour nobody agreed with the patient.
                          appointment_time: lead.appointment_time || "",
                          physio_id: lead.assigned_physio_id || "",
                          notes: "",
                          duration: null,
                          final_stage: appointmentStageName,
                          // Where the consultation happens. A House Visit booking is worked
                          // from the House Visit tab rather than Consultation.
                          visit_type: lead.visit_type === "home" ? "home" : "branch",
                          // A house visit is booked on a Home Visit > Consultant package.
                          visit_package_id: lead.visit_type === "home" ? (lead.visit_package_id || "") : "",
                          visit_package: lead.visit_type === "home" && lead.visit_package_id
                            ? { id: lead.visit_package_id, name: lead.visit_package_name }
                            : null,
                          // The popup asks where the consultation happens before anything
                          // else, every time it opens: "visit" → ("package" for a house
                          // visit) → "book", the date / consultant / time grid.
                          step: "visit",
                        });
                        // The three time fields, opened on whatever the lead is already
                        // sitting on — reopening a booking has to show its own hour rather
                        // than an empty box that reads as no appointment.
                        setApptTime(apptClockFrom(lead.appointment_time || ""));
                        return;
                      }
                      if (stage === "Follow Up") {
                        setFollowUpMoveDraft({ date: tomorrowIso(), time: "10:00", remarks: "" });
                        return;
                      }
                      if (consultationOnly) {
                        if (notYetReached) {
                          toast.error("This lead needs an appointment scheduled before it can enter the Consultations pipeline");
                          return;
                        }
                        onOpenConsultationStage && onOpenConsultationStage(stage);
                        return;
                      }
                      moveStage(stage);
                    };
                    // One button per stage. The Fragment that used to wrap this held the
                    // Reschedule pill beside Appointment as well; with that gone there is
                    // one child, and a fragment around one child is a wrapper around
                    // nothing.
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={isActive || notYetReached || isMirror || blockedFromAppointment}
                        onClick={handleClick}
                        title={blockedFromAppointment ? `${stage} is not reachable from Appointment — the consultation moves the patient on from here` : undefined}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:shadow-md disabled:cursor-not-allowed ${blockedFromAppointment ? "disabled:opacity-40" : "disabled:opacity-90"}`}
                        style={isActive ? { background: tint, color: "#ffffff" } : { background: `${tint}14`, color: tint, border: `1px solid ${tint}33` }}
                        data-testid={`branch-stage-btn-${stage}`}
                      >
                        {stage}
                      </button>
                    );
                  })}
                  {/* Cancel, borrowed from Branch Consultation. Not a Branch stage: it
                      writes consultation_stage, so the lead leaves these pills and is
                      counted under the Consultation tab's Cancel card. Reachable from
                      Appointment, which is where a booking gets called off. */}
                  {consultationCancelStage && (() => {
                    const tint = consultationCancelStage.color || "#e11d48";
                    const isActive = lead.consultation_stage === consultationCancelStage.name;
                    return (
                      <button
                        type="button"
                        disabled={isActive}
                        onClick={() => setCancelDraft(true)}
                        title="Moves this lead to Cancel in Branch Consultation"
                        className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-90"
                        style={isActive ? { background: tint, color: "#ffffff" } : { background: `${tint}14`, color: tint, border: `1px solid ${tint}33` }}
                        data-testid="branch-stage-btn-consultation-cancel"
                      >
                        {consultationCancelStage.name}
                      </button>
                    );
                  })()}
                </div>
              </div>

            </div>
          )}

          {/* The record itself, on its own tab rather than stacked under the working
              cards on Overview.

              Overview answers "what do I do with this lead" -- who to ring, when, what
              was said. This answers "who is this", and a sheet import carries fifteen
              rows of it plus the advert behind them, which pushed the pipeline and the
              notes below the fold on precisely the leads carrying the most. Two
              questions, two tabs; the reference gets room to be read instead of a
              scroll past it to reach the working cards. */}
          {activeTab === "lead-details" && (
            <div className="space-y-3" data-testid="branch-lead-details-tab">
              {/* Who the patient is and what they came in saying, read back off the record.
                  The lead's own fields first, then the answers it arrived with. */}
              {(leadDetailRows.length > 0 || formAnswers.length > 0) && (
                <div className="overflow-hidden rounded-xl border border-indigo-100 bg-white shadow-sm" data-testid="branch-lead-details">
                  <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700"><IdCard className="h-4 w-4" /></span>
                    <p className="text-xs font-bold uppercase tracking-wider text-indigo-700">Lead Details</p>
                  </div>
                  <div className="space-y-2 px-4 py-3">
                    {leadDetailRows.map(([label, value]) => (
                      <DetailRow key={label} label={label} value={String(value)} />
                    ))}
                    {formAnswers.length > 0 && (
                      <div className="space-y-2 border-t border-slate-100 pt-2.5" data-testid="branch-lead-form-answers">
                        {/* Named for where they came from rather than "Custom Fields": on
                            this board they are the questions the patient answered, not
                            columns somebody added to a form. */}
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Enquiry Form</p>
                        {/* Stacked, unlike the rows above. These labels are whole questions
                            — "What type of pain are you experiencing?" — and a label beside
                            its value would leave each of them a couple of words wide. */}
                        {formAnswers.map(([key, value]) => (
                          <div key={key}>
                            <p className="text-[11px] font-medium text-slate-500">{humanKey(key)}</p>
                            <p className="break-words text-sm font-medium text-slate-800">{String(value)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* A walk-in typed in at the desk has a name and a number and nothing
                  else, so this tab can legitimately be empty. Said plainly rather than
                  left blank, which reads as a screen that failed to load. */}
              {leadDetailRows.length === 0 && formAnswers.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400" data-testid="branch-lead-details-empty">
                  Nothing was recorded for this lead beyond their name and number.
                </p>
              )}
            </div>
          )}
          {activeTab === "follow-up" && (
            <div className="space-y-4" data-testid="branch-lead-followup">
              <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4" data-testid="branch-followup-form">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><Bell className="h-3.5 w-3.5" /> Schedule Follow-Up</p>
                {/* Every control in the row carries a label and the same h-9, so the
                    three fields and the button sit on one line rather than the unlabelled
                    remarks box and a shorter sm button hanging off two labelled fields. */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-40">
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">Date</label>
                    <MilkDateInput centered title="Follow-Up Date" value={followUpForm.date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setFollowUpForm({ ...followUpForm, date: e.target.value })} className="w-full" data-testid="branch-followup-date" />
                  </div>
                  <div className="w-32">
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">Time</label>
                    <MilkTimeInput centered title="Follow-Up Time" value={followUpForm.time} onChange={(e) => setFollowUpForm({ ...followUpForm, time: e.target.value })} className="w-full" data-testid="branch-followup-time" />
                  </div>
                  <div className="min-w-[10rem] flex-1">
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">Remarks</label>
                    <Input value={followUpForm.remarks} onChange={(e) => setFollowUpForm({ ...followUpForm, remarks: e.target.value })} placeholder="Optional" className="w-full" data-testid="branch-followup-remarks" />
                  </div>
                  <Button onClick={submitFollowUp} disabled={followUpBusy} className="h-9 shrink-0 bg-amber-600 px-4 text-white hover:bg-amber-700" data-testid="branch-followup-submit">Schedule</Button>
                </div>
              </div>

              {(lead.follow_ups || []).length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No follow-ups scheduled yet</p>
              ) : (
                <div className="space-y-2">
                  {(lead.follow_ups || []).slice().reverse().map((f, idx) => {
                    const dt = new Date(`${f.date}T${f.time}:00`);
                    const isUpcoming = dt.getTime() > Date.now();
                    const isRescheduled = f.status === "rescheduled";
                    const isActive = idx === 0 && !isRescheduled;
                    return (
                      <div key={f.id} className={`flex items-start gap-3 rounded-lg border p-3 ${isRescheduled ? "border-slate-200 bg-slate-50/70 opacity-70" : isUpcoming ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`} data-testid={`branch-followup-row-${f.id}`}>
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
                          {f.remarks && <div className="mt-1.5 rounded-md bg-white px-2.5 py-1.5 text-sm text-slate-700 ring-1 ring-slate-100">{f.remarks}</div>}
                          {isRescheduled && f.reschedule_reason && (
                            <div className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 ring-1 ring-amber-100"><span className="font-semibold">Reschedule reason:</span> {f.reschedule_reason}</div>
                          )}
                          <p className="mt-1.5 text-[11px] text-slate-400">Set by {f.created_by || "—"}</p>
                        </div>
                        {isActive && (
                          <Button size="sm" variant="outline" className="h-8 flex-shrink-0 border-amber-200 text-amber-700 hover:bg-amber-50" onClick={() => setRescheduleDraft({ followupId: f.id, date: f.date, time: f.time, reason: "" })} data-testid={`branch-followup-reschedule-${f.id}`}>
                            Reschedule
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {rescheduleDraft && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="branch-followup-reschedule-form">
                  <p className="mb-2 text-xs font-semibold text-amber-700">Reschedule Follow-Up</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-500">New Date</label>
                      <MilkDateInput  value={rescheduleDraft.date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, date: e.target.value })} className="w-40" data-testid="branch-followup-reschedule-date" />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-500">New Time</label>
                      <MilkTimeInput value={rescheduleDraft.time} onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, time: e.target.value })} className="w-32" data-testid="branch-followup-reschedule-time" />
                    </div>
                    <Input value={rescheduleDraft.reason} onChange={(e) => setRescheduleDraft({ ...rescheduleDraft, reason: e.target.value })} placeholder="Reason (optional)" className="min-w-[10rem] flex-1" data-testid="branch-followup-reschedule-reason" />
                    <Button size="sm" variant="outline" onClick={() => setRescheduleDraft(null)} data-testid="branch-followup-reschedule-cancel">Cancel</Button>
                    <Button size="sm" onClick={submitReschedule} disabled={followUpBusy} className="bg-amber-600 text-white hover:bg-amber-700" data-testid="branch-followup-reschedule-save">Save</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Every attempt, rather than the counter and the latest one the Overview card
              carries. The two answer different questions: whether this lead is worth
              ringing again, and what was actually done — which needs the dates and the
              names beside them, because "8 attempts" says nothing about whether they were
              eight days apart or eight in one afternoon.

              Read off the same lead_activity log Timeline draws, filtered to the rows the
              RNR endpoint writes. Nothing new is stored for this: every press of +1 No
              Answer has always left a row, it simply had nowhere to be read except mixed
              in with the rest of the history. */}
          {activeTab === "rnr" && (
            <div className="space-y-3" data-testid="branch-lead-rnr-record">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-100 bg-white px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-600"><PhoneOff className="h-4 w-4" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-rose-700">Call Attempts</p>
                    <p className="text-[11px] text-slate-500">
                      {rnrCount === 0 ? "None logged yet" : `${rnrCount} logged`}
                      {lead.rnr_last_attempt_at && ` · last ${callDateStamp(lead.rnr_last_attempt_at)}`}
                    </p>
                  </div>
                </div>
                {atRnrStage && (
                  <Button
                    size="sm"
                    onClick={logRnrAttempt}
                    className="h-8 bg-rose-600 text-white hover:bg-rose-700"
                    data-testid="branch-lead-rnr-record-attempt"
                  >
                    <PhoneOff className="mr-1 h-3.5 w-3.5" /> +1 No Answer
                  </Button>
                )}
              </div>

              {rnrLog.length === 0 ? (
                /* The counter can be ahead of the log on a lead whose attempts predate the
                   activity row being written, so this says what it can see rather than
                   claiming nobody ever rang. */
                <p className="py-8 text-center text-sm text-slate-400" data-testid="branch-lead-rnr-record-empty">
                  {rnrCount > 0 ? "No individual attempts on record for this lead." : "No call attempts logged yet."}
                </p>
              ) : (
                <ol className="ml-3 space-y-4 border-l-2 border-rose-100 py-1 pl-6">
                  {rnrLog.map((a) => (
                    <li key={a.id} className="relative" data-testid={`branch-lead-rnr-entry-${a.id}`}>
                      <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-rose-500" />
                      <div className="rounded-lg border border-rose-100 bg-rose-50/50 p-3">
                        <p className="text-sm text-slate-700">{a.details}</p>
                        <p className="mt-1 text-[10px] text-slate-400">{a.created_by} · {a.created_at?.slice(0, 16).replace("T", " ")}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {activeTab === "timeline" && (
            <div className="space-y-3" data-testid="branch-lead-timeline">
              {(() => {
                const events = [
                  ...remarks.map((r) => ({ ...r, _kind: "remark" })),
                  ...activityLog.map((a) => ({ ...a, _kind: "activity" })),
                ].sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
                if (events.length === 0) return <p className="py-8 text-center text-sm text-slate-400">No timeline events yet</p>;
                return (
                  <ol className="ml-3 space-y-4 border-l-2 border-slate-200 py-1 pl-6">
                    {events.map((h) => (
                      <li key={`${h._kind}-${h.id}`} className="relative" data-testid={`branch-timeline-${h._kind}-${h.id}`}>
                        <span className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white ${h._kind === "remark" ? "bg-amber-400" : "bg-sky-500"}`} />
                        <div className={`rounded-lg border p-3 ${h._kind === "remark" ? "border-amber-100 bg-amber-50/50" : "border-slate-100 bg-slate-50"}`}>
                          <p className="text-sm text-slate-700">{h._kind === "remark" ? h.text : h.details}</p>
                          <p className="mt-1 text-[10px] text-slate-400">{h.created_by} · {h.created_at?.slice(0, 16).replace("T", " ")}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Appointment Date & Time Popup */}
      {handover && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !handover.saving) setHandover(null); }}
          data-testid="appt-handover-modal"
        >
          <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="shrink-0 border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Change consultant</h3>
              {/* The slot is stated and not offered for editing: this hands the same
                  appointment to somebody else, and moving it is what the appointment
                  dialog is for. */}
              <p className="mt-0.5 text-xs text-slate-500">
                {weekdayLabel(handover.date)} · {to12h(handover.time)}
                {handover.currentName ? <> — currently <b className="text-slate-700">{handover.currentName}</b></> : null}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {handover.loading && <p className="py-8 text-center text-sm text-slate-400">Loading…</p>}
              {!handover.loading && handover.options.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-slate-400">
                  Every consultant is already booked at this time.
                </p>
              )}
              {!handover.loading && handover.options.map((doc) => {
                const mine = doc.id === handover.currentId;
                // Published means they had already opened this time; the rest can still
                // take it, which is the whole point of asking here rather than in the
                // slot picker.
                const published = (doc.free_slots || []).some((sl) => sl.time === handover.time);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    disabled={handover.saving || mine}
                    onClick={() => confirmHandover(doc)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition disabled:opacity-60 ${mine ? "bg-slate-50" : "hover:bg-sky-50"}`}
                    data-testid={`appt-handover-pick-${doc.id}`}
                  >
                    {/* Same faces the booking popup's CONSULTANT column shows — this is
                        the same list of experts off the same call, and a photo in one of
                        them and an initial in the other reads as two different people. */}
                    <EmployeeAvatar employee={doc} size={32} className="text-xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{doc.full_name}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {mine ? "Currently holds this appointment" : published ? "Free — this time is on their calendar" : "Free — not on their calendar, but nothing is booked"}
                      </span>
                    </span>
                    {mine && <span className="shrink-0 rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">NOW</span>}
                  </button>
                );
              })}
            </div>

            <div className="shrink-0 border-t border-slate-200 px-4 py-2.5 text-right">
              <Button variant="outline" size="sm" disabled={handover.saving} onClick={() => setHandover(null)} data-testid="appt-handover-cancel">
                {handover.saving ? "Saving…" : "Cancel"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Moving a booking that is in the way, from the grid that showed it in the way.
          Sits above the Appointment popup rather than replacing it, so the slot being
          cleared and the day it is being cleared on stay on screen behind it. */}
      {slotEdit && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !slotEdit.saving) setSlotEdit(null); }}
          data-testid="branch-slot-edit-modal"
        >
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="shrink-0 border-b border-slate-200 bg-slate-100 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 shrink-0 text-slate-500" />
                <p className="text-sm font-bold text-slate-800">Reschedule</p>
              </div>
              {/* Whose appointment, and the one it is on now. Named because this is not
                  the patient whose card is open, and moving the wrong person's booking is
                  the mistake this dialog is one press away from. */}
              <p className="mt-0.5 truncate text-xs text-slate-500" data-testid="branch-slot-edit-subject">
                <b className="font-semibold text-slate-700">{slotEdit.leadName}</b>
                {" · "}{weekdayLabel(slotEdit.date)} {to12h(slotEdit.time)}
                {slotEdit.physioName ? <> {"·"} {slotEdit.physioName}</> : null}
              </p>
            </div>

            {/* The three ways out of a clash. Which one is right depends on who cannot
                make it, which is the thing the branch already knows and the system
                cannot. Uppercase labels on a narrow dialog, so the third one is "Swap"
                rather than a sentence — the line under the tab says what it swaps. */}
            <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-slate-200 bg-slate-50 p-1.5">
              {[
                ["consultant", "Consultant", ArrowLeftRight],
                ["patient", "Patient", Clock],
                ["swap", "Swap", Repeat],
              ].map(([m, label, Icon]) => (
                <button
                  key={m}
                  type="button"
                  disabled={slotEdit.saving}
                  onClick={() => {
                    setSlotEdit((p) => (p ? { ...p, mode: m } : p));
                    if (m === "patient" && slotEdit.daySlots.length === 0 && !slotEdit.dayLoading) {
                      loadSlotEditDay(slotEdit.moveDate, slotEdit.physioId, slotEdit.leadId);
                    }
                    if (m === "swap" && slotEdit.swapOptions.length === 0 && !slotEdit.swapLoading) {
                      loadSwapCandidates(slotEdit.leadId);
                    }
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider transition sm:px-3 sm:text-xs ${
                    slotEdit.mode === m
                      ? "bg-white text-teal-700 shadow-sm ring-1 ring-teal-200"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                  data-testid={`branch-slot-edit-tab-${m}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" /> {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {slotEdit.mode === "consultant" ? (
                <>
                  <p className="mb-2 text-xs text-slate-500">
                    Same time, someone else takes it.
                  </p>
                  {slotEdit.loading && <p className="py-8 text-center text-sm text-slate-400">Checking who is free…</p>}
                  {!slotEdit.loading && slotEdit.options.length === 0 && (
                    <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
                      Every consultant is already booked at {to12h(slotEdit.time)}. Move the patient instead.
                    </p>
                  )}
                  {!slotEdit.loading && slotEdit.options.map((doc) => {
                    const holds = doc.id === slotEdit.physioId;
                    const picked = doc.id === slotEdit.pickedPhysioId;
                    // Published means they had already opened this time; the rest can
                    // still take it, which is the whole point of asking here rather than
                    // in the slot picker.
                    const publishedIt = (doc.free_slots || []).some((sl) => sl.time === slotEdit.time);
                    return (
                      <button
                        key={doc.id}
                        type="button"
                        disabled={slotEdit.saving || holds}
                        onClick={() => setSlotEdit((p) => (p ? { ...p, pickedPhysioId: doc.id } : p))}
                        className={`mb-1.5 flex w-full items-center gap-3 rounded-lg border-2 px-3 py-2.5 text-left transition disabled:opacity-60 ${
                          picked ? "border-teal-500 bg-teal-50 shadow-sm" : "border-slate-200 bg-white hover:border-teal-300 hover:bg-slate-50"
                        }`}
                        data-testid={`branch-slot-edit-pick-${doc.id}`}
                      >
                        <EmployeeAvatar employee={doc} size={32} className="text-xs" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-800">{doc.full_name}</span>
                          <span className="block truncate text-[11px] text-slate-500">
                            {holds ? "Holds it now" : publishedIt ? "Free — this time is on their calendar" : "Free — not on their calendar, but nothing is booked"}
                          </span>
                        </span>
                        {holds && <span className="shrink-0 rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">NOW</span>}
                        {picked && <CheckCircle2 className="h-5 w-5 shrink-0 text-teal-600" />}
                      </button>
                    );
                  })}
                </>
              ) : slotEdit.mode === "patient" ? (
                <>
                  <p className="mb-2 text-xs text-slate-500">
                    Same consultant{slotEdit.physioName ? <> — <b className="font-semibold text-slate-700">{slotEdit.physioName}</b></> : null}, a different time.
                  </p>
                  <div className="mb-3">
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Move to date</label>
                    <MilkDateInput
                      value={slotEdit.moveDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => loadSlotEditDay(e.target.value, slotEdit.physioId, slotEdit.leadId)}
                      className="w-44"
                      data-testid="branch-slot-edit-date"
                    />
                  </div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Move to time</label>
                  {slotEdit.dayLoading ? (
                    <p className="py-8 text-center text-sm text-slate-400">Reading their calendar…</p>
                  ) : slotEdit.daySlots.length === 0 ? (
                    // Only what this consultant has actually published, same as the grid
                    // behind: a reschedule that invented a time would put the patient
                    // somewhere the consultant never agreed to be.
                    <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
                      Nothing open on this date. Try another, or hand the slot to another consultant.
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="branch-slot-edit-slots">
                      {slotEdit.daySlots.map((sl) => {
                        const picked = slotEdit.moveTime === sl.time;
                        return (
                          <button
                            key={sl.slot_time}
                            type="button"
                            disabled={slotEdit.saving}
                            onClick={() => setSlotEdit((p) => (p ? { ...p, moveTime: sl.time, moveDuration: sl.duration } : p))}
                            className={`flex min-h-[3.5rem] items-center justify-between gap-2 rounded-lg border-2 px-3 py-2 text-left transition ${
                              picked
                                ? "border-teal-500 bg-teal-50 text-teal-700 shadow-sm ring-2 ring-teal-100"
                                : "border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:bg-slate-50"
                            }`}
                            data-testid={`branch-slot-edit-slot-${sl.time}`}
                          >
                            <span className="truncate text-base font-bold">{to12h(sl.time)}</span>
                            <span className="shrink-0 text-[11px] text-slate-400">{sl.duration} min</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* An exchange, never a handover. Both patients keep an appointment —
                      each lands on the slot the other has just left — so this tab is
                      offered without the warning a "give the slot away" tab would need,
                      and the endpoint behind it refuses anything that isn't a clean
                      trade rather than freeing a slot to make one. */}
                  <p className="mb-2 text-xs text-slate-500">
                    Two patients change places. <b className="font-semibold text-slate-700">{slotEdit.leadName}</b> takes the appointment below, and that patient takes {to12h(slotEdit.time)}.
                  </p>
                  {slotEdit.swapLoading && <p className="py-8 text-center text-sm text-slate-400">Reading the branch's other appointments…</p>}
                  {!slotEdit.swapLoading && slotEdit.swapOptions.length === 0 && (
                    <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
                      Nobody else at this branch has a consultation booked, so there is nothing to trade for. Move the patient instead.
                    </p>
                  )}
                  {!slotEdit.swapLoading && slotEdit.swapOptions.length > 0 && (
                    <>
                      {/* A branch runs more consultations than fit a scroll, and the one
                          being looked for is named on the phone rather than spotted. */}
                      <div className="relative mb-2">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <Input
                          value={slotEdit.swapQuery}
                          onChange={(e) => setSlotEdit((p) => (p ? { ...p, swapQuery: e.target.value } : p))}
                          placeholder="Find a patient, consultant or time…"
                          className="h-9 pl-8 text-sm"
                          data-testid="branch-slot-edit-swap-search"
                        />
                      </div>
                      {swapCandidates.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
                          No appointment matches that.
                        </p>
                      ) : swapCandidates.map((c) => {
                        const picked = c.lead_id === slotEdit.swapLeadId;
                        // The day is only worth printing when it is not the one already
                        // named in the header two lines up.
                        const sameDay = c.appointment_date === slotEdit.date;
                        return (
                          <button
                            key={c.lead_id}
                            type="button"
                            disabled={slotEdit.saving}
                            onClick={() => setSlotEdit((p) => (p ? { ...p, swapLeadId: c.lead_id } : p))}
                            className={`mb-1.5 flex w-full items-center gap-3 rounded-lg border-2 px-3 py-2.5 text-left transition disabled:opacity-60 ${
                              picked ? "border-teal-500 bg-teal-50 shadow-sm" : "border-slate-200 bg-white hover:border-teal-300 hover:bg-slate-50"
                            }`}
                            data-testid={`branch-slot-edit-swap-${c.lead_id}`}
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-500">
                              {(c.lead_name || "?").trim().charAt(0).toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-800">{c.lead_name || "Unnamed patient"}</span>
                              <span className="block truncate text-[11px] text-slate-500">
                                {sameDay ? to12h(c.appointment_time) : `${weekdayLabel(c.appointment_date)} ${to12h(c.appointment_time)}`}
                                {c.doctor_name ? ` · ${c.doctor_name}` : ""}
                              </span>
                            </span>
                            {picked && <CheckCircle2 className="h-5 w-5 shrink-0 text-teal-600" />}
                          </button>
                        );
                      })}
                      {/* Both halves spelled out before it is pressed. A swap moves a
                          patient who is not on screen and not the one whose card is
                          open, and reading it back is the only chance to catch the
                          wrong row having been picked. */}
                      {swapPicked && (
                        <div className="mt-2 rounded-lg border border-teal-200 bg-teal-50/70 p-3 text-xs text-teal-900" data-testid="branch-slot-edit-swap-summary">
                          <p className="mb-1 font-bold uppercase tracking-wider text-teal-700">After the swap</p>
                          <p className="truncate">
                            <b className="font-semibold">{slotEdit.leadName}</b> → {weekdayLabel(swapPicked.appointment_date)} {to12h(swapPicked.appointment_time)}
                            {swapPicked.doctor_name ? ` · ${swapPicked.doctor_name}` : ""}
                          </p>
                          <p className="truncate">
                            <b className="font-semibold">{swapPicked.lead_name || "The other patient"}</b> → {weekdayLabel(slotEdit.date)} {to12h(slotEdit.time)}
                            {slotEdit.physioName ? ` · ${slotEdit.physioName}` : ""}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            {/* Both halves of the swap, on the row that performs it. The freed time is
                the same one either tab empties, so the offer reads the same on both. */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-100 px-4 py-2.5">
              {slotEdit.canTake && slotEdit.mode !== "swap" ? (
                <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-slate-600" title={`Book ${lead.name || "this patient"} into ${to12h(slotEdit.time)} as soon as it is free`}>
                  <input
                    type="checkbox"
                    checked={!!slotEdit.takeSlot}
                    disabled={slotEdit.saving}
                    onChange={(e) => setSlotEdit((p) => (p ? { ...p, takeSlot: e.target.checked } : p))}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600 accent-teal-600 focus:ring-teal-500"
                    data-testid="branch-slot-edit-take"
                  />
                  <span className="truncate">
                    Then give {to12h(slotEdit.time)} to <b className="font-semibold text-slate-700">{lead.name || "this patient"}</b>
                  </span>
                </label>
              ) : (
                // Nothing to offer. Either the booking in the way is this card's own, or
                // SWAP is the open tab — that one does not free the slot at all, it hands
                // it to the patient picked in the list, so there is nothing left over for
                // this card's patient to be given.
                <span />
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" disabled={slotEdit.saving} onClick={() => setSlotEdit(null)} data-testid="branch-slot-edit-cancel">
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="bg-teal-600 text-white hover:bg-teal-700"
                  disabled={slotEdit.saving || (
                    slotEdit.mode === "consultant" ? !slotEdit.pickedPhysioId
                      : slotEdit.mode === "patient" ? !slotEdit.moveTime
                        : !slotEdit.swapLeadId
                  )}
                  onClick={submitSlotEdit}
                  data-testid="branch-slot-edit-save"
                >
                  {slotEdit.mode === "swap"
                    ? (slotEdit.saving ? "Swapping…" : "Swap")
                    : slotEdit.saving
                      ? (slotEdit.canTake && slotEdit.takeSlot ? "Swapping…" : "Moving…")
                      : (slotEdit.canTake && slotEdit.takeSlot ? "Reschedule & book" : "Reschedule")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {apptDraft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-2 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) setApptDraft(null); }} data-testid="branch-appt-modal">
          {/* A card the size of what is in it, capped at the viewport. It used to be given
              the whole screen height because step 3 was a grid of every slot a consultant
              published and needed all of it; step 3 is now three small fields, and a
              full-height card around them is most of a screen of white space with Confirm
              stranded at the bottom of it.

              The cap is in dvh with a vh class behind it: 100vh on mobile measures the
              viewport as if the browser's URL bar were hidden, which is what pushed
              Confirm below the fold. Inline rather than a second max-h class, because two
              Tailwind classes setting one property are resolved by stylesheet order and
              not by the order they are written here — inline wins wherever dvh is
              understood, and is dropped as invalid wherever it is not, leaving the class. */}
          <div
            className={`flex max-h-[calc(100vh-2rem)] w-full ${apptDraft.step === "book" ? "max-w-5xl" : "max-w-2xl"} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
            style={{ maxHeight: "calc(100dvh - 2rem)" }}
          >
            {/* One line, and only the word for what this is. The three steps below are
                numbered and titled already, so a subtitle spelling their order out again
                was a second row of chrome on the one dialog that needs its height for
                slots. The same reasoning shrinks the bar itself. */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 sm:px-5 sm:py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-sky-600" />
                <p className="truncate text-sm font-semibold text-slate-900">Appointment</p>
                {/* What the first step settled, kept in sight while the slot is picked,
                    with the way back to change it. */}
                {apptDraft.step === "book" && (
                  <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700" data-testid="branch-appt-visit-chip">
                    {apptDraft.visit_type === "home" ? <Home className="h-3.5 w-3.5 shrink-0" /> : <Building2 className="h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate">
                      {apptDraft.visit_type === "home"
                        ? `House Visit${apptDraft.visit_package?.name ? ` · ${apptDraft.visit_package.name}` : ""}`
                        : "Offline Consultation"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setApptDraft({ ...apptDraft, step: "visit" })}
                      className="shrink-0 font-bold text-sky-800 underline underline-offset-2 hover:text-sky-900"
                      data-testid="branch-appt-visit-change"
                    >
                      Change
                    </button>
                  </span>
                )}
              </div>
              <button onClick={() => setApptDraft(null)} className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="branch-appt-close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Asked first, before any date: where the consultation happens. Offline goes
                straight to the slot. A house visit is sold on a Home Visit > Consultant
                package, so that is picked next and the slot after it. */}
            {apptDraft.step === "visit" && (
              <div className="overflow-y-auto p-4 sm:p-6" data-testid="branch-appt-visit-step">
                <p className="mb-1 text-base font-bold text-slate-800">How will {lead.name || "the patient"} be consulted?</p>
                <p className="mb-4 text-xs text-slate-500">Choose where the consultation happens. You'll pick the date and time next.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { key: "branch", label: "Offline Consultation", sub: "The patient comes to the branch", icon: Building2 },
                    { key: "home", label: "House Visit", sub: "The consultant goes to the patient's home — pick a package next", icon: Home },
                  ].map((v) => {
                    const Icon = v.icon;
                    const on = apptDraft.visit_type === v.key;
                    return (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => {
                          if (v.key === "home") {
                            setApptDraft({ ...apptDraft, visit_type: "home", step: "package" });
                            loadHvPackages();
                          } else {
                            setApptDraft({ ...apptDraft, visit_type: "branch", visit_package_id: "", visit_package: null, step: "book" });
                          }
                        }}
                        className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${
                          on ? "border-sky-500 bg-sky-50 shadow-sm" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"
                        }`}
                        data-testid={`branch-appt-visit-${v.key}`}
                      >
                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${on ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-slate-800">{v.label}</span>
                          <span className="mt-0.5 block text-xs text-slate-500">{v.sub}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {apptDraft.step === "package" && (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="branch-appt-package-step">
                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                  <p className="mb-1 text-base font-bold text-slate-800">House Visit package</p>
                  <p className="mb-4 text-xs text-slate-500">Pick the package this visit is booked on. The appointment is booked next.</p>
                  {hvPackages.loading ? (
                    <p className="py-10 text-center text-sm text-slate-400">Loading packages…</p>
                  ) : hvPackages.error ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-6 text-center text-sm text-rose-700">
                      {hvPackages.error}
                      <button type="button" onClick={loadHvPackages} className="ml-2 font-semibold underline">Try again</button>
                    </div>
                  ) : hvPackages.items.length === 0 ? (
                    // Nothing to pick means nothing to book on, and saying where packages
                    // come from is more use than an empty list.
                    <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
                      No House Visit packages yet. Add one under Services and Products → Home Visit → Consultant.
                    </p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2" data-testid="branch-appt-packages">
                      {hvPackages.items.map((it) => {
                        const picked = apptDraft.visit_package_id === it.id;
                        const visits = Number(it.sessions_offline) || 0;
                        const rate = Number(it.price_offline) || 0;
                        const total = Math.round(it.price_is_total ? rate : rate * visits);
                        return (
                          <button
                            key={it.id}
                            type="button"
                            // A package with no fixed price (a Distance visit) stays on this
                            // step so its amount can be typed below; the rest go on to the slot.
                            onClick={() => setApptDraft({
                              ...apptDraft,
                              visit_type: "home",
                              visit_package_id: it.id,
                              visit_package: { id: it.id, name: it.name, manual: Boolean(it.manual_price) },
                              visit_package_amount: it.manual_price ? (apptDraft.visit_package_id === it.id ? apptDraft.visit_package_amount : "") : null,
                              step: it.manual_price ? "package" : "book",
                            })}
                            className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-left transition ${
                              picked ? "border-sky-500 bg-sky-50 shadow-sm" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"
                            }`}
                            data-testid={`branch-appt-package-${it.id}`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-bold text-slate-800">{it.name}</span>
                              {it.description ? <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{it.description}</span> : null}
                              <span className="mt-1 block text-[11px] text-slate-500">
                                {visits} {visits === 1 ? "visit" : "visits"}{!it.price_is_total && visits > 1 ? ` · ₹${rate} per visit` : ""}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                              {it.manual_price
                                ? <span className="text-xs font-bold text-amber-700">Enter amount</span>
                                : <span className="text-base font-extrabold text-slate-900">₹{total}</span>}
                              {picked && <CheckCircle2 className="h-5 w-5 text-sky-600" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* The amount for a package Super Admin left unpriced. Typed here, by the
                      desk that agreed it with the patient, and charged exactly as typed. */}
                  {apptDraft.visit_package?.manual && (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="branch-appt-package-amount">
                      <label className="mb-1 block text-xs font-bold text-amber-800">Amount for {apptDraft.visit_package.name}</label>
                      <div className="relative max-w-xs">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-amber-700">₹</span>
                        <Input
                          type="number"
                          min="1"
                          autoFocus
                          value={apptDraft.visit_package_amount ?? ""}
                          onChange={(e) => setApptDraft({ ...apptDraft, visit_package_amount: e.target.value })}
                          placeholder="Enter the amount"
                          className="bg-white pl-7"
                          data-testid="branch-appt-package-amount-input"
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2 sm:px-5 sm:py-2.5">
                  <Button variant="outline" size="sm" onClick={() => setApptDraft({ ...apptDraft, step: "visit" })} data-testid="branch-appt-package-back">
                    <ChevronLeft className="mr-1 h-4 w-4" />Back
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setApptDraft(null)}>Cancel</Button>
                    {apptDraft.visit_package?.manual && (
                      <Button
                        size="sm"
                        className="bg-sky-600 text-white hover:bg-sky-700"
                        onClick={() => {
                          if (!(Number(apptDraft.visit_package_amount) > 0)) { toast.error("Enter the amount"); return; }
                          setApptDraft({ ...apptDraft, step: "book" });
                        }}
                        data-testid="branch-appt-package-continue"
                      >
                        Continue
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {apptDraft.step === "book" && (<>
            {/* Three steps left to right: the date narrows who's available, the chosen
                Head Physio narrows which times exist. Each column only fills in once the
                one before it has an answer. */}
            <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              {/* STEP 1 — Date */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[24rem] lg:border-b-0 lg:border-r lg:overflow-y-auto" data-testid="branch-appt-date-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">1 · Date</p>
                {(() => {
                  const todayStr = new Date().toISOString().slice(0, 10);
                  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                  const firstDow = new Date(apptMonth.y, apptMonth.m, 1).getDay();
                  const daysInMonth = new Date(apptMonth.y, apptMonth.m + 1, 0).getDate();
                  const pad = (n) => String(n).padStart(2, "0");
                  const stepMonth = (delta) => setApptMonth(({ y, m }) => {
                    const d = new Date(y, m + delta, 1);
                    return { y: d.getFullYear(), m: d.getMonth() };
                  });
                  return (
                    <>
                      <div className="mb-3 flex items-center justify-between">
                        <button type="button" onClick={() => stepMonth(-1)} className="rounded p-1 hover:bg-slate-100" data-testid="branch-appt-prev-month">
                          <ChevronLeft className="h-5 w-5 text-slate-500" />
                        </button>
                        <h4 className="text-base font-bold text-slate-700">{monthNames[apptMonth.m]} {apptMonth.y}</h4>
                        <button type="button" onClick={() => stepMonth(1)} className="rounded p-1 hover:bg-slate-100" data-testid="branch-appt-next-month">
                          <ChevronRight className="h-5 w-5 text-slate-500" />
                        </button>
                      </div>
                      <div className="mb-1 grid grid-cols-7 gap-1">
                        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                          <div key={d} className="py-1 text-center text-xs font-semibold text-slate-400">{d}</div>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} className="h-11" />)}
                        {Array.from({ length: daysInMonth }, (_, i) => {
                          const day = i + 1;
                          const dateStr = `${apptMonth.y}-${pad(apptMonth.m + 1)}-${pad(day)}`;
                          const isPast = dateStr < todayStr;
                          const isPicked = apptDraft.appointment_date === dateStr;
                          const isToday = dateStr === todayStr;
                          const openSlots = apptOpenDates[dateStr] || 0;
                          const hasSlots = !isPast && openSlots > 0;
                          return (
                            <button
                              key={day}
                              type="button"
                              disabled={isPast}
                              // A new date invalidates the expert and slot chosen under the
                              // old one — availability is per-day, so both are cleared.
                              onClick={() => {
                                setApptDraft({ ...apptDraft, appointment_date: dateStr, physio_id: "", appointment_time: "", duration: null });
                                setApptTime({ h: "", m: "", ap: "AM" });
                              }}
                              className={`h-11 rounded-lg text-base font-semibold transition ${
                                isPicked
                                  // Brand blue -- colors.palette.primary, #0EA5E9. The halo
                                  // is sky-300 rather than sky-200 on purpose: sky-200 is
                                  // what the legend teaches as "available", and a picked
                                  // day ringed in it would read as saying both.
                                  ? "bg-sky-500 text-white shadow-sm ring-2 ring-sky-300"
                                  : isPast
                                  ? "cursor-not-allowed text-slate-300"
                                  : hasSlots
                                  // Light blue marks a day some consultant is actually
                                  // available on, so the days worth clicking are visible
                                  // without opening each one. The number goes dark with the
                                  // fill -- this carried white text while it was
                                  // violet-300, which a light blue cannot hold.
                                  ? "bg-sky-200 text-sky-900 shadow-sm hover:bg-sky-300"
                                  : isToday
                                  ? "border border-sky-400 text-sky-700 hover:bg-sky-50"
                                  : "text-slate-600 hover:bg-slate-100"
                              }`}
                              title={hasSlots ? "A CONSULTANT is available on this day" : undefined}
                              data-testid={`branch-appt-day-${day}`}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-400">
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-200" /> Available</span>
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-500" /> Picked</span>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* STEP 2 — Head Physio */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[18rem] lg:border-b-0 lg:border-r lg:overflow-y-auto" data-testid="branch-appt-expert-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">2 · CONSULTANT</p>
                {!apptDraft.appointment_date ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Pick a date first.</p>
                ) : apptExperts.loading ? (
                  <p className="text-sm text-slate-400">Checking availability...</p>
                ) : apptExperts.experts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">No CONSULTANT is available on this date.</p>
                ) : (
                  <div className="space-y-2">
                    {apptExperts.experts.map((doc) => {
                      const active = apptDraft.physio_id === doc.id;
                      // Available means this consultant is working the day, which is the
                      // one thing the Consultant Calendar sets. Read off what they
                      // published, not off what is still free, so this column and the Time
                      // column beside it can never disagree about the same consultant —
                      // free slots would call a consultant who is in all day but fully
                      // booked "not available", when the branch's next move is to look at
                      // their bookings and move one.
                      const open = doc.published_slot_count || 0;
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => {
                            setApptDraft({ ...apptDraft, physio_id: doc.id, appointment_time: "", duration: null });
                            setApptTime({ h: "", m: "", ap: "AM" });
                          }}
                          className={`flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition ${active ? "border-sky-500 bg-sky-50 shadow-sm" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"}`}
                          data-testid={`branch-appt-expert-${doc.id}`}
                        >
                          {/* The consultant's own face where HR has one on file, their
                              initial in the column's blue where they do not — the same
                              component the directory and the signed-in header use, so a
                              photo cannot appear on some boards and not others. The ring
                              carries the picked state a solid fill used to, which a
                              photograph has no room for. */}
                          <EmployeeAvatar
                            employee={doc}
                            size={44}
                            fallbackClassName={active ? "bg-sky-600 text-white" : "bg-sky-100 text-sky-700"}
                            className={active ? "ring-2 ring-sky-500" : ""}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-slate-800">{doc.full_name}</p>
                            {/* Available or not, and nothing else. The count that used to
                                sit here was a number nobody acted on: the slot grid one
                                column over is where a time actually gets chosen, and it
                                now shows the consultant's whole day anyway, so the tally
                                was both duplicated and less useful than the thing it
                                duplicated. Green reads as "go", amber as "not this one",
                                which is the whole of the decision this column makes. */}
                            <span
                              className={`mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                                open > 0
                                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                  : "bg-amber-50 text-amber-700 ring-amber-200"
                              }`}
                              data-testid={`branch-appt-expert-open-${doc.id}`}
                            >
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${open > 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
                              {open > 0 ? "Available" : "Not available"}
                            </span>
                          </div>
                          {active && <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-sky-600" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* The room the picked CONSULTANT meets in, under the choice that decides
                    it. Read off their record — set in MANAGEMENT → CONSULTANT CALENDAR —
                    rather than typed here: it is a fact about the expert, the same one
                    every patient booked with them is sent, and a booking screen able to
                    name the room would be a booking screen able to send a patient
                    anywhere.

                    Said before Confirm rather than only after it, because it is the half
                    of an online appointment the branch cannot check afterwards. A
                    consultant with no room recorded is the one case worth interrupting
                    for: the confirmation is about to go out with nowhere in it. */}
                {/* The link itself wherever there is one — a room recorded against this
                    consultant is where this appointment is happening, whichever board is
                    booking it. The warning for a missing one only on an online arm, where
                    a missing room is a confirmation about to go out with nowhere in it. */}
                {apptSelectedExpert && (apptMeetLink || onlineArm) && (
                  apptMeetLink ? (
                    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3" data-testid="branch-appt-meet-link">
                      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-violet-500">
                        <Video className="h-3.5 w-3.5" /> Google Meet
                      </p>
                      <a
                        href={apptMeetLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 block break-all text-xs font-semibold text-violet-700 hover:underline"
                        data-testid="branch-appt-meet-link-open"
                      >
                        {apptMeetLink.replace(/^https?:\/\//, "")}
                      </a>
                      <p className="mt-1.5 text-[10px] text-violet-500">Goes to the patient with the confirmation.</p>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="branch-appt-no-meet-link">
                      <p className="text-xs font-semibold text-amber-800">No Google Meet link for this CONSULTANT.</p>
                      <p className="mt-0.5 text-[10px] text-amber-700">
                        The confirmation will go out without one. Add it in MANAGEMENT → CONSULTANT CALENDAR.
                      </p>
                    </div>
                  )
                )}
              </div>

              {/* STEP 3 — The hour, typed. The Consultant Calendar publishes the DAY a
                  consultant works and nothing finer, because the minute a patient is given
                  is agreed on the phone — "come in around quarter past seven" — and no grid
                  of cut tiles can offer that. So this column asks whether the consultant is
                  on the day at all, and then takes the time the desk agreed.

                  The hours they published are named beside the field rather than enforced
                  by it, and a time outside them is warned about rather than refused: the
                  branch may have arranged something the calendar has not caught up with,
                  and a booking screen is not the place to overrule a conversation. A time
                  that collides with somebody else's appointment IS refused — that one is
                  not a judgement call, it is two patients in one room. */}
              {/* overflow and flex-1 are gated to lg on purpose. Below that the three
                  steps are one stacked column that scrolls as a whole, and an inner
                  scroller here would trap this step in a short box of its own inside that
                  scroll — two scrollbars, and the field unreachable. */}
              <div className="w-full flex-shrink-0 p-4 sm:p-5 lg:flex-1 lg:overflow-y-auto" data-testid="branch-appt-slot-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">3 · Time</p>
                {!apptDraft.physio_id ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Select a CONSULTANT to fix the time.</p>
                ) : !apptDayPublished ? (
                  // Not on this day at all. The Consultant Calendar is the only thing that
                  // fixes it, so it is named rather than left to be found.
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="branch-appt-no-slots">
                    <p className="text-sm font-semibold text-amber-800">Not available on this date.</p>
                    <p className="mt-0.5 text-xs text-amber-700">
                      Confirm with the consultant, then open MANAGEMENT → CONSULTANT CALENDAR and mark the day available.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Available, and the hours they said they would be here. The whole of
                        what the calendar has to say about this day, said once. */}
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3" data-testid="branch-appt-available">
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Available
                      </span>
                      {apptDayBlocks.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {apptDayBlocks.map(([a, b]) => (
                            <span key={a} className="rounded-md bg-white px-2 py-1 text-xs text-emerald-800 ring-1 ring-inset ring-emerald-200">
                              <b className="font-semibold">{apptShiftName(a)}</b> · {to12h(apptClockText(a))} – {to12h(apptClockText(b))}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* The hour itself. Three fields and not one text box, because a
                        patient is told "quarter past seven in the evening" and that is
                        three answers — an hour, a minute and which half of the day — and a
                        single box makes the desk assemble them into a format first. */}
                    <div className="mt-4">
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600" htmlFor="branch-appt-hour">
                        Appointment time
                      </label>
                      <div className="flex items-center gap-2" data-testid="branch-appt-time-entry">
                        <input
                          id="branch-appt-hour"
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          placeholder="7"
                          value={apptTime.h}
                          onChange={(e) => setApptClock({ h: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                          className="h-12 w-16 rounded-lg border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                          data-testid="branch-appt-hour"
                        />
                        <span className="text-xl font-bold text-slate-400">:</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          placeholder="15"
                          value={apptTime.m}
                          onChange={(e) => setApptClock({ m: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                          className="h-12 w-16 rounded-lg border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                          data-testid="branch-appt-minute"
                        />
                        <div className="ml-1 flex overflow-hidden rounded-lg border border-slate-200">
                          {["AM", "PM"].map((half) => (
                            <button
                              key={half}
                              type="button"
                              onClick={() => setApptClock({ ap: half })}
                              className={`px-3 py-2.5 text-sm font-bold transition ${apptTime.ap === half ? "bg-sky-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                              data-testid={`branch-appt-${half.toLowerCase()}`}
                            >
                              {half}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        {apptDraft.appointment_time
                          ? <>Booking <b className="font-semibold text-slate-600">{to12h(apptDraft.appointment_time)}</b> for {apptSlotMinutes} minutes.</>
                          : <>{apptSlotMinutes}-minute consultation.</>}
                      </p>
                    </div>

                    {/* Two patients in one room. Refused here so the branch reads it beside
                        the field that caused it rather than as a 409 over a dialog that has
                        already been confirmed. */}
                    {apptClash && (
                      <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3" data-testid="branch-appt-clash">
                        <p className="text-sm font-semibold text-rose-800">
                          {to12h(apptDraft.appointment_time)} runs into {to12h(apptClash.time)}
                          {apptClash.lead_name ? ` — ${apptClash.lead_name}` : ""}.
                        </p>
                        <p className="mt-0.5 text-xs text-rose-700">
                          {apptSelectedExpert?.full_name} is with {apptClash.review_id ? "a review" : "another patient"} then. Pick a different time, or move that booking with the pencil below.
                        </p>
                      </div>
                    )}

                    {/* Outside the published hours: said, never blocked. See the note at
                        the head of this step. */}
                    {!apptClash && apptOutsideHours && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="branch-appt-outside-hours">
                        <p className="text-sm font-semibold text-amber-800">{to12h(apptDraft.appointment_time)} is outside the hours published for this day.</p>
                        <p className="mt-0.5 text-xs text-amber-700">
                          {apptDayHours ? `${apptSelectedExpert?.full_name} is down for ${apptDayHours}. ` : ""}
                          It will still book — check the consultant is coming in for it.
                        </p>
                      </div>
                    )}

                    {/* The day as it already stands. Not a grid to pick from any more, but
                        the branch on the phone still gets asked "what else is around
                        three", and an hour with nothing against it is the answer. The
                        pencil is the only thing here that touches somebody else's
                        appointment, which is why it is its own press. */}
                    {apptSlotsForExpert.some((x) => x.booked) && (
                      <div className="mt-4" data-testid="branch-appt-booked-list">
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Already booked this day</p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {apptSlotsForExpert.filter((x) => x.booked).map((x) => (
                            <div
                              key={x.slot_time}
                              className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2"
                              data-testid={`branch-appt-slot-${x.time}`}
                            >
                              <span className="min-w-0">
                                <span className="block text-sm font-bold text-slate-500">{to12h(x.time)} – {endTime12h(x.time, Number(x.duration) || apptSlotMinutes)}</span>
                                <span className="block truncate text-[11px] font-semibold text-slate-400">
                                  {x.review_id ? "Review" : "Booked"}{x.lead_name ? ` · ${x.lead_name}` : ""}
                                </span>
                              </span>
                              {/* A review is moved from Review > Reassign, not from here:
                                  the pencil reschedules a consultation, and this patient
                                  has none in this hour. */}
                              {!x.review_id && (
                                <button
                                  type="button"
                                  onClick={() => openSlotEdit(x)}
                                  className="shrink-0 rounded-md border border-slate-300 bg-white p-1.5 text-slate-500 transition hover:border-sky-400 hover:bg-sky-50 hover:text-sky-600"
                                  title={`Reschedule the ${to12h(x.time)} booking${x.lead_name ? ` — ${x.lead_name}` : ""}`}
                                  data-testid={`branch-appt-slot-edit-${x.time}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* No cancelling from here. This dialog books a slot; dropping the lead out of
                the pipeline is the Cancelled stage pill's job, and that one asks first. */}
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2 sm:px-5 sm:py-2.5">
              <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setApptDraft(null)} data-testid="branch-appt-cancel">Cancel</Button>
              <Button
                size="sm"
                className="bg-sky-600 text-white hover:bg-sky-700"
                // A clash is the one thing this button will not carry through. The hour is
                // typed now, so an overlap is a slip rather than a choice, and the panel
                // above has already named whose appointment it runs into.
                disabled={!!apptClash}
                onClick={async () => {
                  if (!apptDraft.appointment_date) { toast.error("Pick a date"); return; }
                  if (!apptDraft.physio_id) { toast.error("Please select an expert"); return; }
                  if (!apptDraft.appointment_time) { toast.error("Type the time agreed with the patient"); return; }
                  if (apptDraft.visit_type === "home" && apptDraft.visit_package?.manual && !(Number(apptDraft.visit_package_amount) > 0)) {
                    toast.error("Enter the amount for the House Visit package");
                    setApptDraft({ ...apptDraft, step: "package" });
                    return;
                  }
                  if (apptDraft.visit_type === "home" && !apptDraft.visit_package_id) {
                    toast.error("Pick a House Visit package");
                    setApptDraft({ ...apptDraft, step: "package" });
                    loadHvPackages();
                    return;
                  }
                  try {
                    await bookLeadInto(apptDraft);
                  } catch (e) {
                    // Names the failure rather than reporting every one as a scheduling
                    // failure: the booking above is only the first of several statements
                    // here, and a fault in any of the rest used to surface as "Failed to
                    // schedule" over a confirmation dialog that had already opened.
                    toast.error(e?.response?.data?.detail || e?.message || "Failed to schedule");
                  }
                }}
                data-testid="branch-appt-save"
              >
                Confirm
              </Button>
              </div>
            </div>
            </>)}
          </div>
        </div>
      )}


      {/* Cancelling off Appointment. Says what will happen rather than "Are you sure?",
          which asks a question whose answer depends on knowing what the button does: the
          slot goes back on the expert's calendar, and Cancelled is the end of this
          pipeline — nothing on this card moves a lead out of it again. */}
      {cancelDraft && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setCancelDraft(false); }}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl" data-testid="branch-cancel-confirm">
            <div className="border-b p-5">
              <h3 className="text-base font-semibold text-slate-800">Cancel this appointment?</h3>
              <p className="text-[10px] text-slate-400">{lead.name}{lead.phone ? ` · ${lead.phone}` : ""}</p>
            </div>
            <div className="space-y-3 p-5">
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[11px] text-rose-800">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {apptSlotLabel(lead)
                    ? <>The {apptSlotLabel(lead)} slot{lead.assigned_physio_name ? ` with ${lead.assigned_physio_name}` : ""} goes back on the calendar for someone else to take. </>
                    : <>Any slot this lead is holding goes back on the calendar. </>}
                  {lead.name} moves to {consultationCancelStage?.name || CONSULTATION_CANCEL_STAGE} in Branch Consultation and leaves the Branch Leads pills.
                </span>
              </div>
              {/* Rebooking is the other door, and it is one press away on the same card.
                  Said here because a Branch Admin reaching for Cancel because the patient
                  cannot make Tuesday wants Reschedule, and finding that out afterwards
                  costs them the slot. */}
              <p className="text-[11px] text-slate-500">
                If the patient only needs a different time, close this and press <span className="font-semibold text-amber-700">Reschedule</span> instead — that keeps the lead where it is.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t p-4">
              <Button variant="outline" size="sm" onClick={() => setCancelDraft(false)} data-testid="branch-cancel-confirm-back">Keep it</Button>
              <Button
                size="sm"
                disabled={cancelling}
                className="bg-rose-600 text-white hover:bg-rose-700"
                onClick={async () => {
                  setCancelling(true);
                  // Stays open if the move was refused, so the reason is read beside the
                  // button that caused it rather than over a card that has just closed.
                  const target = consultationCancelStage?.name || CONSULTATION_CANCEL_STAGE;
                  let moved = false;
                  try {
                    await moveConsultationStage(lead.id, target);
                    toast.success(`Moved to ${target}`);
                    moved = true;
                  } catch (err) {
                    toast.error(err?.response?.data?.detail || "Cancel failed");
                  }
                  setCancelling(false);
                  if (moved) { setCancelDraft(false); onMoved && onMoved(target); }
                }}
                data-testid="branch-cancel-confirm-submit"
              >
                {cancelling ? "Cancelling..." : "Cancel appointment"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* The confirmation the branch has just booked. Closing it is what finally moves
          the lead on: onMoved unmounts this whole card, so the confirmation has to
          survive long enough to be printed, shared or sent first. */}
      <AppointmentConfirmCard
        appt={apptConfirm}
        onClose={() => { const s = apptConfirm.finalStage; setApptConfirm(null); onMoved && onMoved(s); }}
      />

      {/* The same card, reopened off the booking from the View above. A separate mount
          from the one over it so the two cannot share a close: that one moves the lead
          on, this one only puts the sheet away. */}
      <AppointmentConfirmCard
        appt={apptCard}
        onClose={() => setApptCard(null)}
        testid="branch-appt-reissue"
      />

      {/* Follow Up Date & Time Popup (triggered from Move to Stage) */}
      {followUpMoveDraft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) setFollowUpMoveDraft(null); }} data-testid="branch-followup-move-modal">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                <p className="text-base font-semibold">Follow Up — Date & Time</p>
              </div>
              <button onClick={() => setFollowUpMoveDraft(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="branch-followup-move-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Date *</label>
                {/* Always open, in the OS's own palette — the native picker dropped a
                    browser dialog with its own chrome and blue over the popup. */}
                <MilkCalendar
                  value={followUpMoveDraft.date}
                  min={new Date().toISOString().slice(0, 10)}
                  accent="amber"
                  onChange={(d) => setFollowUpMoveDraft({ ...followUpMoveDraft, date: d })}
                  testid="branch-followup-move-date"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Time *</label>
                <MilkTimeInput value={followUpMoveDraft.time} onChange={(e) => setFollowUpMoveDraft({ ...followUpMoveDraft, time: e.target.value })} data-testid="branch-followup-move-time" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Remarks</label>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                  placeholder="Optional remarks..."
                  value={followUpMoveDraft.remarks}
                  onChange={(e) => setFollowUpMoveDraft({ ...followUpMoveDraft, remarks: e.target.value })}
                  data-testid="branch-followup-move-remarks"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
              <Button variant="outline" onClick={() => setFollowUpMoveDraft(null)} data-testid="branch-followup-move-cancel">Cancel</Button>
              <Button className="bg-amber-600 text-white hover:bg-amber-700" onClick={submitFollowUpMove} disabled={followUpMoveBusy} data-testid="branch-followup-move-save">Save & Move</Button>
            </div>
          </div>
        </div>
      )}

      {/* Every field on the lead, in one form. onUpdate is the board's own refresh, which
          re-reads the row and hands this popup the saved version back -- so the cards
          behind the form show the correction the moment it is made, without closing.

          allowBranchChange is off: a patient moves between branches through Branch
          Transfer, which carries their fees and sessions with them. */}
      {editing && (
        <LeadEditModal
          lead={lead}
          allowBranchChange={false}
          onClose={() => setEditing(false)}
          onSaved={onUpdate}
        />
      )}
      {transferring && (
        <LeadBranchTransferDialog
          lead={lead}
          fromBranchId={branchId}
          onClose={() => setTransferring(false)}
          // The lead now belongs to another branch's board, so close the popup and refresh
          // the list it came from — the same path a stage move takes.
          onTransferred={() => { setTransferring(false); onMoved?.(); }}
        />
      )}
    </div>
  );
}
