import { useEffect, useState } from "react";
import { AlertTriangle, EyeOff, Lock, Palette, Trash2, Wallet, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import {
  resetAllLeads, resetAllPayments, resetAllUsers,
  getPhysioDayLock, setPhysioDayLock,
  getLeadDeleteButton, setLeadDeleteButton,
  getExpenseDeleteButton, setExpenseDeleteButton,
  getBeforeVerifyDeleteButton, setBeforeVerifyDeleteButton,
  getUndoPaymentButton, setUndoPaymentButton,
  getSaConsultBranchesSetting, setSaConsultBranchesSetting,
  getStoreBranchOverrides, setStoreBranchOverrides,
  getLeadSourceButton, setLeadSourceButton,
  getConsultationDurationRule, setConsultationDurationRule,
  getBranchTabDots, setBranchTabDots,
  getAppThemeAdmin, setAppThemeAdmin,
  getPaymentModeVisibilityAdmin, setPaymentModeHidden,
  getFeatureVisibilityAdmin, setFeatureHidden,
} from "@/lib/api";
import { setHiddenPaymentModes } from "@/lib/paymentModes";
import { setHiddenFeatures } from "@/lib/featureVisibility";
import { useDevZone, closeDevZone, lockDevZone } from "@/lib/devZone";
import { ThemeAppearanceCard } from "@/components/ThemeAppearanceCard";

// The five tenders the OS collects in, as the Payment Modes tab lists them.
const PAYMENT_MODE_ROWS = [
  { mode: "cash", label: "Cash" },
  { mode: "upi", label: "UPI" },
  { mode: "card", label: "Card" },
  { mode: "account_transfer", label: "Account Transfer" },
  { mode: "cheque", label: "Cheque" },
];

// Every feature the Hide Features tab offers — the backend's FEATURE_KEYS
// (feature_visibility.py), each with the words a Super Admin reads before flipping it.
const HIDE_FEATURE_ROWS = [
  {
    key: "treatments",
    label: "Treatments",
    note: "The Treatments tab in Services and Products (Super Admin and every branch), and the Consultant's Treatment Summary dropdown with it.",
    confirmHide:
      "Hide Treatments?\n\nThe Treatments tab disappears from Services and Products for Super Admin and every branch, and the Treatment Summary dropdown disappears from the Consultant's consultation. Move to Admin stops asking for a Treatment Summary. Summaries already written stay on their patients.",
    confirmShow:
      "Show Treatments?\n\nThe Treatments tab comes back to Services and Products, the Treatment Summary dropdown comes back to the Consultant's consultation, and Move to Admin asks for it again.",
  },
];

// The four pages inside the zone. Danger Zone first because it is the one the gear is
// named after; the other three ride behind the same password.
const SUB_TABS = [
  { key: "danger", label: "Danger Zone", icon: AlertTriangle, tone: "text-red-600", activeBg: "bg-red-50" },
  { key: "payment_modes", label: "Payment Modes", icon: Wallet, tone: "text-sky-600", activeBg: "bg-sky-50" },
  { key: "theme", label: "Theme Appearance", icon: Palette, tone: "text-violet-600", activeBg: "bg-violet-50" },
  { key: "hide_features", label: "Hide Features", icon: EyeOff, tone: "text-amber-600", activeBg: "bg-amber-50" },
];

/**
 * The Danger Zone as its own full-screen page — opened by the unlock on Workflow Roots'
 * Developer Access, reopened by the red gear in the header, and left by the X. Not a
 * popup: it stands in front of the whole app the way My Profile stands in place of a
 * board, with its own sub-tab strip.
 *
 * Everything here used to be three cards at the bottom of Pipeline Stage Management; the
 * behaviour of every switch is unchanged, only the room it lives in moved. The developer
 * password comes from the shared devZone store and is sent on every call — the server
 * checks it each time regardless, so Exit keeps the gear while Lock (or a refused call)
 * drops the password and closes the whole thing.
 */
export const DeveloperZone = () => {
  const { password: devPassword, open } = useDevZone();
  const [subTab, setSubTab] = useState("danger");

  const [resetting, setResetting] = useState(false);
  const [resettingPayments, setResettingPayments] = useState(false);
  const [resettingUsers, setResettingUsers] = useState(false);
  // Each setting is null until read, so a row can say Loading rather than guess a state
  // and offer the wrong switch.
  const [dayLock, setDayLock] = useState(null);
  const [savingDayLock, setSavingDayLock] = useState(false);
  const [deleteButton, setDeleteButton] = useState(null);
  const [savingDeleteButton, setSavingDeleteButton] = useState(false);
  const [expenseDelete, setExpenseDelete] = useState(null);
  const [savingExpenseDelete, setSavingExpenseDelete] = useState(false);
  const [beforeVerifyDelete, setBeforeVerifyDelete] = useState(null);
  const [savingBeforeVerifyDelete, setSavingBeforeVerifyDelete] = useState(false);
  const [undoPayment, setUndoPayment] = useState(null);
  const [savingUndoPayment, setSavingUndoPayment] = useState(false);
  const [saBranches, setSaBranches] = useState(null);
  const [savingSaBranches, setSavingSaBranches] = useState(false);
  const [storePerBranch, setStorePerBranch] = useState(null);
  const [savingStorePerBranch, setSavingStorePerBranch] = useState(false);
  const [leadSourceButton, setLeadSourceButtonState] = useState(null);
  const [savingLeadSourceButton, setSavingLeadSourceButton] = useState(false);
  const [durationRule, setDurationRule] = useState(null);
  const [savingDurationRule, setSavingDurationRule] = useState(false);
  const [tabDots, setTabDots] = useState(null);
  const [savingTabDots, setSavingTabDots] = useState(false);
  // Payment Modes Show / Hide: the hidden modes, null until read; `savingMode` is the one
  // being flipped.
  const [hiddenModes, setHiddenModes] = useState(null);
  const [savingMode, setSavingMode] = useState(null);
  // Hide Features: the hidden feature keys, null until read; `savingFeature` likewise.
  const [hiddenFeatureKeys, setHiddenFeatureKeys] = useState(null);
  const [savingFeature, setSavingFeature] = useState(null);

  // Read once the zone is open, with the password it was opened with.
  useEffect(() => {
    if (!devPassword) {
      setDayLock(null); setDeleteButton(null); setExpenseDelete(null); setBeforeVerifyDelete(null);
      setUndoPayment(null); setSaBranches(null); setStorePerBranch(null); setLeadSourceButtonState(null);
      setDurationRule(null); setTabDots(null); setHiddenModes(null); setHiddenFeatureKeys(null);
      return;
    }
    getStoreBranchOverrides(devPassword).then((r) => setStorePerBranch(!!r.enabled)).catch(() => setStorePerBranch(null));
    getExpenseDeleteButton(devPassword).then((r) => setExpenseDelete(!!r.enabled)).catch(() => setExpenseDelete(null));
    getBeforeVerifyDeleteButton(devPassword).then((r) => setBeforeVerifyDelete(!!r.enabled)).catch(() => setBeforeVerifyDelete(null));
    getUndoPaymentButton(devPassword).then((r) => setUndoPayment(!!r.enabled)).catch(() => setUndoPayment(null));
    getPhysioDayLock(devPassword).then((r) => setDayLock(!!r.locked)).catch(() => setDayLock(null));
    getLeadDeleteButton(devPassword).then((r) => setDeleteButton(!!r.enabled)).catch(() => setDeleteButton(null));
    getSaConsultBranchesSetting(devPassword).then((r) => setSaBranches(!!r.enabled)).catch(() => setSaBranches(null));
    getLeadSourceButton(devPassword).then((r) => setLeadSourceButtonState(!!r.enabled)).catch(() => setLeadSourceButtonState(null));
    getConsultationDurationRule(devPassword).then((r) => setDurationRule(!!r.enabled)).catch(() => setDurationRule(null));
    getBranchTabDots(devPassword).then((r) => setTabDots(!!r.enabled)).catch(() => setTabDots(null));
    getPaymentModeVisibilityAdmin(devPassword).then((r) => setHiddenModes(r.hidden || [])).catch(() => setHiddenModes(null));
    getFeatureVisibilityAdmin(devPassword).then((r) => setHiddenFeatureKeys(r.hidden || [])).catch(() => setHiddenFeatureKeys(null));
  }, [devPassword]);

  // A call refused for the password (changed on the server, or too many tries) locks the
  // zone again rather than leaving a page of switches up that can only fail.
  const resetFailed = (e) => {
    const status = e?.response?.status;
    if (status === 403 || status === 429 || status === 503) lockDevZone();
    toast.error(e?.response?.data?.detail || "Reset failed");
  };

  const toggleDayLock = async () => {
    const next = !dayLock;
    const ok = window.confirm(next
      ? "Lock Physio Treatment Days?\n\nA day can then only be marked Complete or Absent on its booked date."
      : "Unlock Physio Treatment Days?\n\nThe next open day can then be marked Complete or Absent on any date. Days still have to be done in order.");
    if (!ok) return;
    setSavingDayLock(true);
    try {
      const r = await setPhysioDayLock(devPassword, next);
      setDayLock(!!r.locked);
      toast.success(r.locked ? "Physio Treatment Days locked to their booked date" : "Physio Treatment Days unlocked");
    } catch (e) {
      resetFailed(e);
    }
    setSavingDayLock(false);
  };

  const toggleDeleteButton = async () => {
    const next = !deleteButton;
    // Spelled out rather than "Enable delete?": what makes this switch worth a password is
    // that the button it turns on takes the paid-for records with the patient, and that is
    // the sentence somebody should read before agreeing to it.
    const ok = window.confirm(next
      ? "Turn the Branch Leads delete button ON?\n\nBranch Admins and Pre Sales will get a bin icon on their All Stages and New Leads rows. It deletes the patient outright — treatment slots, collected payments, appointments, documents, portal login and all. It cannot be undone."
      : "Turn the Branch Leads delete button OFF?\n\nThe bin icon and the select-many Delete bar disappear from Branch Leads, the bin disappears from Pre Sales, and the server refuses the request even if one is sent. Nothing already deleted comes back.");
    if (!ok) return;
    setSavingDeleteButton(true);
    try {
      const r = await setLeadDeleteButton(devPassword, next);
      setDeleteButton(!!r.enabled);
      toast.success(r.enabled ? "Branch Leads delete button is ON" : "Branch Leads delete button is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingDeleteButton(false);
  };

  const toggleExpenseDelete = async () => {
    const next = !expenseDelete;
    const ok = window.confirm(next
      ? "Turn the Accountant Approvals delete button ON?\n\nThe accountant gets a bin icon on every payment in Income Approval and every expense in Expenses Approval and the Expense tab. A Branch Admin gets one on their own branch's expenses in Accountant Manage. Deleting a payment resets that fee on the patient so it is owed again; deleting a cash expense puts it back in the drawer. It cannot be undone."
      : "Turn the Accountant Approvals delete button OFF?\n\nThe bin icon disappears from the accountant's Approvals and Expense tab and from the Branch Admin's Accountant Manage, and the server refuses the request even if one is sent. Nothing already deleted comes back.");
    if (!ok) return;
    setSavingExpenseDelete(true);
    try {
      const r = await setExpenseDeleteButton(devPassword, next);
      setExpenseDelete(!!r.enabled);
      toast.success(r.enabled ? "Approvals delete button is ON" : "Approvals delete button is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingExpenseDelete(false);
  };

  const toggleBeforeVerifyDelete = async () => {
    const next = !beforeVerifyDelete;
    const ok = window.confirm(next
      ? "Turn Before Verify Transactions ON?\n\nA Branch Admin gets a bin icon on every payment still in To Verify on Accountant Manage > Summary. Deleting a payment takes it off at the source: the fee or instalment is owed again, a store sale's stock goes back on the shelf. Payments already sent to the accountant, approved, or on a closed day cannot be deleted. It cannot be undone."
      : "Turn Before Verify Transactions OFF?\n\nThe bin disappears from the Branch Admin's To Verify list, and the server refuses the request even if one is sent. Nothing already deleted comes back.");
    if (!ok) return;
    setSavingBeforeVerifyDelete(true);
    try {
      const r = await setBeforeVerifyDeleteButton(devPassword, next);
      setBeforeVerifyDelete(!!r.enabled);
      toast.success(r.enabled ? "Before Verify Transactions delete is ON" : "Before Verify Transactions delete is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingBeforeVerifyDelete(false);
  };

  const toggleUndoPayment = async () => {
    const next = !undoPayment;
    const ok = window.confirm(next
      ? "Turn Undo Payment ON?\n\nA Branch Admin gets an Undo Payment button on every payment still in To Verify on Accountant Manage > Summary. Undoing a payment takes it off the books: the fee or instalment is owed again, a store sale's stock goes back on the shelf, and a line stays on the client's history. Payments already sent to the accountant, approved, or on a closed day cannot be undone this way."
      : "Turn Undo Payment OFF?\n\nThe button disappears from the Branch Admin's To Verify list, and the server refuses the request even if one is sent. Nothing already undone comes back.");
    if (!ok) return;
    setSavingUndoPayment(true);
    try {
      const r = await setUndoPaymentButton(devPassword, next);
      setUndoPayment(!!r.enabled);
      toast.success(r.enabled ? "Undo Payment is ON" : "Undo Payment is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingUndoPayment(false);
  };

  const toggleSaBranches = async () => {
    const next = !saBranches;
    const ok = window.confirm(next
      ? "Show the Super Admin's branch On/Off?\n\nMy Consultation gets the branch icon again, and any branch the Super Admin had switched Off is Off again."
      : "Hide the Super Admin's branch On/Off?\n\nThe branch icon disappears from My Consultation, and the Super Admin is listed on every branch's Consultant Calendar until it is shown again.");
    if (!ok) return;
    setSavingSaBranches(true);
    try {
      const r = await setSaConsultBranchesSetting(devPassword, next);
      setSaBranches(!!r.enabled);
      toast.success(r.enabled ? "Super Admin branch On/Off is shown" : "Super Admin branch On/Off is hidden");
    } catch (e) {
      resetFailed(e);
    }
    setSavingSaBranches(false);
  };

  const toggleStorePerBranch = async () => {
    const next = !storePerBranch;
    const ok = window.confirm(next
      ? "Turn Services and Products per branch ON?\n\nEach branch keeps its own prices, Consultation Duration, session counts and names. A Branch Admin's edit changes their branch only, and their bookings and calendar use their own figures. Branches that have not edited anything keep Super Admin's values."
      : "Turn Services and Products per branch OFF?\n\nEvery branch goes back to the same Services and Products, Super Admin's values, and a Branch Admin's edit changes it for all branches again. Each branch's own values are kept and come back if this is switched ON again.");
    if (!ok) return;
    setSavingStorePerBranch(true);
    try {
      const r = await setStoreBranchOverrides(devPassword, next);
      setStorePerBranch(!!r.enabled);
      toast.success(r.enabled ? "Each branch now has its own Services and Products" : "Services and Products are the same for every branch");
    } catch (e) {
      resetFailed(e);
    }
    setSavingStorePerBranch(false);
  };

  const toggleLeadSourceButton = async () => {
    const next = !leadSourceButton;
    const ok = window.confirm(next
      ? "Turn the Leads Source Show / Hide Sources button ON?\n\nRecords > Leads Source gets the button again. It still asks for the developer password before any source can be shown or hidden."
      : "Turn the Leads Source Show / Hide Sources button OFF?\n\nThe button disappears from Records > Leads Source, and the server refuses a change even if one is sent. Sources already hidden stay hidden.");
    if (!ok) return;
    setSavingLeadSourceButton(true);
    try {
      const r = await setLeadSourceButton(devPassword, next);
      setLeadSourceButtonState(!!r.enabled);
      toast.success(r.enabled ? "Show / Hide Sources button is ON" : "Show / Hide Sources button is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingLeadSourceButton(false);
  };

  const toggleDurationRule = async () => {
    const next = !durationRule;
    const ok = window.confirm(next
      ? "Turn the Consultation Duration ON?\n\nEvery branch: each appointment holds its Consultation Duration, and a time that runs into another booking with the same CONSULTANT is refused."
      : "Turn the Consultation Duration OFF?\n\nEvery branch: several patients can be booked at the same date and time with the same CONSULTANT. Already Booked This Day still lists them all.");
    if (!ok) return;
    setSavingDurationRule(true);
    try {
      const r = await setConsultationDurationRule(devPassword, next);
      setDurationRule(!!r.enabled);
      toast.success(r.enabled ? "Consultation Duration is ON" : "Consultation Duration is OFF — same-time bookings allowed");
    } catch (e) {
      resetFailed(e);
    }
    setSavingDurationRule(false);
  };

  const toggleTabDots = async () => {
    const next = !tabDots;
    const ok = window.confirm(next
      ? "Turn the Branch Admin tabs Red Dot ON?\n\nEvery branch: a tab with something waiting in it (new leads, consultations, referrals...) shows its red dot again, within two minutes."
      : "Turn the Branch Admin tabs Red Dot OFF?\n\nEvery branch: no red dot on any Branch Admin tab or sub-tab, within two minutes. Nothing in the tabs changes.");
    if (!ok) return;
    setSavingTabDots(true);
    try {
      const r = await setBranchTabDots(devPassword, next);
      setTabDots(!!r.enabled);
      toast.success(r.enabled ? "Branch Admin tabs Red Dot is ON" : "Branch Admin tabs Red Dot is OFF");
    } catch (e) {
      resetFailed(e);
    }
    setSavingTabDots(false);
  };

  const togglePaymentMode = async ({ mode, label }) => {
    const hide = !hiddenModes.includes(mode);
    setSavingMode(mode);
    try {
      const r = await setPaymentModeHidden(devPassword, mode, hide);
      setHiddenModes(r.hidden || []);
      // Every picker on screen follows at once, without a reload.
      setHiddenPaymentModes(r.hidden || []);
      toast.success(hide ? `${label} is hidden from every Payment Mode` : `${label} is shown again`);
    } catch (e) {
      resetFailed(e);
    }
    setSavingMode(null);
  };

  const toggleFeature = async (row) => {
    const hide = !hiddenFeatureKeys.includes(row.key);
    if (!window.confirm(hide ? row.confirmHide : row.confirmShow)) return;
    setSavingFeature(row.key);
    try {
      const r = await setFeatureHidden(devPassword, row.key, hide);
      setHiddenFeatureKeys(r.hidden || []);
      // Every screen drawing the feature follows at once, without a reload.
      setHiddenFeatures(r.hidden || []);
      toast.success(hide ? `${row.label} is hidden` : `${row.label} is shown again`);
    } catch (e) {
      resetFailed(e);
    }
    setSavingFeature(null);
  };

  const handleResetAllLeads = async () => {
    const step1 = window.confirm(
      "Reset EVERY lead in the whole OS back to a fresh, unassigned New Leads state?\n\n" +
      "This keeps each lead's name/phone/contact info, but clears their stage, branch, " +
      "consultation decision, physio assignment, packages, fees, follow-ups, VIP and Need " +
      "Attention marks, and every Diet, " +
      "Diet Chart and Rehab referral, coach, rehab physio and report — and permanently " +
      "deletes all sessions (treatment, diet and rehab days), weekly assessments, every Review " +
      "(Send to Review, Pending Review and Review Complete), package recommendations, appointments, patient view links, activity history, and every Zumba " +
      "and Fitness registration and referral.\n\nThe Management calendars start empty too: every slot published on a " +
      "Consultant, Physiotherapist or Nutritionist calendar, their one-day shift changes, every Zumba master's class, " +
      "and every Missed Class.\n\nThis cannot be undone."
    );
    if (!step1) return;
    // Typed, like the other two resets. This used to be a second OK box whose text asked
    // for "OK" to be typed into a dialog that had nowhere to type.
    const typed = window.prompt('Type RESET LEADS to confirm this final, irreversible reset.');
    if ((typed || "").trim() !== "RESET LEADS") {
      if (typed !== null) toast.error("Nothing was reset — the confirmation text didn't match");
      return;
    }
    setResetting(true);
    try {
      const res = await resetAllLeads(devPassword);
      toast.success(
        `Reset ${res.leads_reset} leads. Deleted ${res.sessions_deleted} sessions, ` +
        `${res.weekly_assessments_deleted} assessments, ${res.reviews_deleted} reviews, ${res.appointments_deleted} appointments, ` +
        `${res.lead_activity_deleted} activity entries, ${res.diet_sessions_deleted} diet and ` +
        `${res.rehab_sessions_deleted} rehab days, ${res.zumba_registrations_deleted} Zumba and ` +
        `${res.fitness_registrations_deleted} Fitness registrations. Cleared ${res.calendars_cleared} calendars ` +
        `and ${res.zumba_classes_cleared} Zumba classes.`
      );
    } catch (e) {
      resetFailed(e);
    }
    setResetting(false);
  };

  const handleResetAllPayments = async () => {
    const step1 = window.confirm(
      "Wipe EVERY payment recorded anywhere in the OS?\n\n" +
      "Patients keep their stage, branch, packages and prices, but every fee paid is cleared " +
      "and reads as owed again. Zumba and Fitness payments are cleared. Store sales are deleted " +
      "and their stock put back. Expenses, petty cash, cash handovers, opening cash, closing " +
      "balances, closed books, payslips, payroll runs, and HR advance/expense claims are " +
      "permanently deleted. Receipt numbers restart.\n\nThis cannot be undone."
    );
    if (!step1) return;
    // Typed rather than a second OK: two confirm boxes in a row are clicked through on
    // reflex, and this one erases the books.
    const typed = window.prompt('Type RESET PAYMENTS to confirm this final, irreversible reset.');
    if ((typed || "").trim() !== "RESET PAYMENTS") {
      if (typed !== null) toast.error("Nothing was reset — the confirmation text didn't match");
      return;
    }
    setResettingPayments(true);
    try {
      const res = await resetAllPayments(devPassword);
      const cashRows = Object.values(res.cash_book_deleted || {}).reduce((sum, n) => sum + n, 0);
      toast.success(
        `Cleared payments on ${res.leads_cleared} leads, ${res.zumba_registrations_cleared} Zumba and ` +
        `${res.fitness_registrations_cleared} Fitness registrations. Deleted ${res.payments_deleted} collections, ` +
        `${res.store_sales_deleted} store sales, ${cashRows} cash book entries, ${res.payslips_deleted} payslips.`
      );
    } catch (e) {
      resetFailed(e);
    }
    setResettingPayments(false);
  };

  const handleResetAllUsers = async () => {
    const step1 = window.confirm(
      "Delete EVERY user login without Super Admin?\n\n" +
      "They are signed out and deleted, with their HR employee records, attendance, leave " +
      "requests, clock-ins, login history, and expert calendars (calendars with bookings are " +
      "switched off instead). Leads, Zumba registrations and branches that named them are " +
      "unassigned. Every Client Portal login is deleted too.\n\nThis cannot be undone."
    );
    if (!step1) return;
    // Typed for the same reason as the payments reset: this one removes people's access.
    const typed = window.prompt('Type RESET USERS to confirm this final, irreversible reset.');
    if ((typed || "").trim() !== "RESET USERS") {
      if (typed !== null) toast.error("Nothing was reset — the confirmation text didn't match");
      return;
    }
    setResettingUsers(true);
    try {
      const res = await resetAllUsers(devPassword);
      toast.success(
        `Deleted ${res.users_deleted} users, ${res.employees_deleted} employee records, ` +
        `${res.expert_profiles_deleted} expert calendars (${res.expert_profiles_switched_off} switched off), ` +
        `${res.portal_accounts_deleted} portal logins. Unlinked ${res.branches_unlinked} branch admins.`
      );
    } catch (e) {
      resetFailed(e);
    }
    setResettingUsers(false);
  };

  if (!open || !devPassword) return null;

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-slate-50" data-testid="developer-zone-page">
      {/* The page's own header: who it is, and the two ways out. Exit (X) closes the page
          and keeps the gear in the nav bar; Lock forgets the password, so the gear goes
          and the next entry is the Developer Access password box again. */}
      <div className="sticky top-0 z-10 border-b border-red-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </span>
            <div>
              <p className="text-base font-bold leading-tight text-slate-900">Danger Zone</p>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Developer Access</p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-slate-500 hover:text-slate-700"
              onClick={lockDevZone}
              title="Lock Developer Access — the gear leaves the nav bar until the password is entered again"
              data-testid="developer-zone-lock-btn"
            >
              <Lock className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Lock</span>
            </Button>
            <button
              type="button"
              onClick={closeDevZone}
              className="rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
              title="Exit — stays unlocked, reopen from the gear in the nav bar"
              aria-label="Exit Danger Zone"
              data-testid="developer-zone-exit-btn"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {/* The sub-tabs, in the shape the Settings switcher draws its pills. */}
        <div className="mx-auto max-w-5xl px-4 pb-3 sm:px-6">
          <div className="flex flex-wrap gap-1.5 rounded-lg bg-slate-100 p-1" data-testid="developer-zone-subtabs">
            {SUB_TABS.map((t) => {
              const Icon = t.icon;
              const active = subTab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSubTab(t.key)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition ${active ? `${t.activeBg} ${t.tone} shadow-sm` : "text-slate-500 hover:bg-white/60"}`}
                  data-testid={`developer-zone-subtab-${t.key}`}
                >
                  <Icon className="h-4 w-4" />{t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:px-6">
        {subTab === "danger" && (
          <Card className="border-red-200" data-testid="danger-zone-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-red-700">
                <AlertTriangle className="h-4 w-4" /> Danger Zone
              </CardTitle>
            </CardHeader>
            {/* One list, a line each, the way the Super Admin's branch On/Off popup reads: the
                name on the left, its switch or button on the right. The full warning is in each
                one's confirm box, which is read before anything changes or is wiped. */}
            <CardContent>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {[
                  { key: "physio-day-lock", label: "Physio Treatment Days lock", value: dayLock, saving: savingDayLock, onFlip: toggleDayLock, on: "LOCKED", off: "UNLOCKED" },
                  { key: "lead-delete-button", label: "Branch Leads & Pre Sales delete button", value: deleteButton, saving: savingDeleteButton, onFlip: toggleDeleteButton, on: "ON", off: "OFF" },
                  { key: "expense-delete-button", label: "Accountant Approvals & Branch Accountant Manage delete button (Income & Expense)", value: expenseDelete, saving: savingExpenseDelete, onFlip: toggleExpenseDelete, on: "ON", off: "OFF" },
                  { key: "before-verify-delete-button", label: "Before Verify Transactions", value: beforeVerifyDelete, saving: savingBeforeVerifyDelete, onFlip: toggleBeforeVerifyDelete, on: "ON", off: "OFF" },
                  { key: "undo-payment-button", label: "Undo Payment", value: undoPayment, saving: savingUndoPayment, onFlip: toggleUndoPayment, on: "ON", off: "OFF" },
                  { key: "sa-consult-branches", label: "Super Admin branch On/Off", value: saBranches, saving: savingSaBranches, onFlip: toggleSaBranches, on: "ON", off: "OFF" },
                  { key: "store-per-branch", label: "Services and Products different for each branch", value: storePerBranch, saving: savingStorePerBranch, onFlip: toggleStorePerBranch, on: "ON", off: "OFF" },
                  { key: "lead-source-button", label: "Leads Source Show / Hide Sources button", value: leadSourceButton, saving: savingLeadSourceButton, onFlip: toggleLeadSourceButton, on: "ON", off: "OFF" },
                  { key: "consultation-duration-rule", label: "Consultation Duration (OFF: book many patients at the same time)", value: durationRule, saving: savingDurationRule, onFlip: toggleDurationRule, on: "ON", off: "OFF" },
                  { key: "branch-tab-dots", label: "Branch Admin tabs Red Dot", value: tabDots, saving: savingTabDots, onFlip: toggleTabDots, on: "ON", off: "OFF" },
                ].map((row) => (
                  <label key={row.key} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50" data-testid={`${row.key}-card`}>
                    <span className="text-sm font-medium text-slate-800">{row.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`text-[10px] font-bold uppercase ${row.value ? "text-emerald-600" : "text-slate-400"}`}>
                        {row.value === null ? "…" : row.saving ? "Saving" : row.value ? row.on : row.off}
                      </span>
                      <Switch
                        checked={!!row.value}
                        disabled={row.value === null || row.saving}
                        // The toggle functions confirm first and flip from the saved value, so
                        // the switch only moves once the server has said so.
                        onCheckedChange={() => row.onFlip()}
                        className="data-[state=checked]:bg-emerald-600"
                        data-testid={`${row.key}-toggle`}
                      />
                    </span>
                  </label>
                ))}
                {[
                  { key: "reset-all-leads-btn", label: "Reset all leads to a fresh state", busy: resetting, onClick: handleResetAllLeads, text: "Reset All Leads" },
                  { key: "reset-all-payments-btn", label: "Reset all payments to a fresh state", busy: resettingPayments, onClick: handleResetAllPayments, text: "Reset All Payments" },
                  { key: "reset-all-users-btn", label: "Reset all users to a fresh state (Without Super Admin)", busy: resettingUsers, onClick: handleResetAllUsers, text: "Reset All Users" },
                ].map((row) => (
                  <div key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <span className="text-sm font-medium text-red-700">{row.label}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-44 justify-center border-red-300 text-red-700 hover:bg-red-50"
                      onClick={row.onClick}
                      disabled={row.busy}
                      data-testid={row.key}
                    >
                      <Trash2 className="mr-1 h-4 w-4" /> {row.busy ? "Resetting..." : row.text}
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Which tenders the OS offers. A hidden mode comes off every Payment Mode picker --
            Collect popups, Pre Book, Fitness, Zumba, Store, Expense. Payments already taken in
            it, and the report tiles counting them, are untouched. */}
        {subTab === "payment_modes" && (
          <Card data-testid="payment-modes-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wallet className="h-4 w-4 text-sky-600" /> Payment Modes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {PAYMENT_MODE_ROWS.map((row) => {
                  const shown = hiddenModes ? !hiddenModes.includes(row.mode) : null;
                  // The last mode still shown cannot be hidden: a desk with no mode to pick
                  // cannot collect at all. The server refuses it as well.
                  const lastShown = shown && hiddenModes && hiddenModes.length >= PAYMENT_MODE_ROWS.length - 1;
                  return (
                    <label key={row.mode} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50" data-testid={`payment-mode-${row.mode}-row`}>
                      <span className="text-sm font-medium text-slate-800">{row.label}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase ${shown ? "text-emerald-600" : "text-slate-400"}`}>
                          {shown === null ? "…" : savingMode === row.mode ? "Saving" : shown ? "Show" : "Hide"}
                        </span>
                        <Switch
                          checked={!!shown}
                          disabled={shown === null || !!savingMode || lastShown}
                          onCheckedChange={() => togglePaymentMode(row)}
                          className="data-[state=checked]:bg-emerald-600"
                          data-testid={`payment-mode-${row.mode}-toggle`}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Not a danger: the look of the OS, behind the same password. */}
        {subTab === "theme" && (
          <Card data-testid="theme-appearance-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette className="h-4 w-4 text-sky-600" /> Theme Appearance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ThemeAppearanceCard
                password={devPassword}
                getSetting={getAppThemeAdmin}
                saveSetting={async (pw, setting) => {
                  const r = await setAppThemeAdmin(pw, setting);
                  toast.success("Theme saved");
                  return r;
                }}
                onFailed={resetFailed}
              />
            </CardContent>
          </Card>
        )}

        {/* Whole features a developer can take off every screen at once. Only the features
            built to be hidden are listed; what each one wrote stays on the records. */}
        {subTab === "hide_features" && (
          <Card data-testid="hide-features-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <EyeOff className="h-4 w-4 text-amber-600" /> Hide Features
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {HIDE_FEATURE_ROWS.map((row) => {
                  const shown = hiddenFeatureKeys ? !hiddenFeatureKeys.includes(row.key) : null;
                  return (
                    <label key={row.key} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50" data-testid={`hide-feature-${row.key}-row`}>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">{row.label}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">{row.note}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase ${shown ? "text-emerald-600" : "text-slate-400"}`}>
                          {shown === null ? "…" : savingFeature === row.key ? "Saving" : shown ? "Show" : "Hide"}
                        </span>
                        <Switch
                          checked={!!shown}
                          disabled={shown === null || !!savingFeature}
                          onCheckedChange={() => toggleFeature(row)}
                          className="data-[state=checked]:bg-emerald-600"
                          data-testid={`hide-feature-${row.key}-toggle`}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default DeveloperZone;
