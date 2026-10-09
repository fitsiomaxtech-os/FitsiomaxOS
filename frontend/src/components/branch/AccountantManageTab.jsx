import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Receipt, Wallet, Stethoscope, Activity, ShoppingBag, Salad, RefreshCw, Music2, HeartPulse, Dumbbell, ChevronDown, ChevronRight, ArrowRight, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { LedgerCard } from "@/components/ui/ledger-card";
import { toast } from "@/components/ui/sonner";
import { BranchExpensesPanel } from "@/components/branch/BranchExpensesPanel";
import { FinanceDateFilter } from "@/components/finance/FinanceDateFilter";
import { FilterSelect } from "@/components/ui/filter-select";
import { rangeFor, todayIso } from "@/lib/dateRange";
import { getBranches, getRevenueOverview, getFinanceExpenses, getBranchCash, requestTransactions, unrequestTransactions, undoLastInstalment } from "@/lib/api";
import { ClientHistoryModal } from "@/components/branch/ClientHistoryModal";
import { ReceiptDialog } from "@/components/ReceiptDialog";
import { receiptFromTransaction } from "@/lib/receipt";
import { OutstandingAmountBoard } from "@/components/branch/OutstandingAmountBoard";
import { ClosingBalancePanel } from "@/components/branch/ClosingBalancePanel";
import { CloseBookHistoryPanel } from "@/components/branch/CloseBookHistoryPanel";
import { OldClientInstalmentDialog } from "@/components/branch/OldClientInstalmentDialog";
import { ScheduleCollectDialog, collectWhat } from "@/components/branch/ScheduleCollectDialog";
import { loadSession } from "@/lib/session";

// The Consultations board, for its patient and Collect popups only (`popupOnly`). Loaded
// when a Consultation Fee is first collected from Payment Schedule, not with this tab:
// it is the largest module in the app and most visits here never need it.
const ConsultationsBoard = lazy(() => import("@/components/ConsultationsBoard"));

// Three tabs, not the ten this page used to carry: Consultation/Session/Diet/Store
// Collections were each a copy of Summary's own card-click-to-filter table scoped to one
// source, which Summary's revenue cards already do; Payment Paid/Unpaid were the same
// transactions again split by settled/unsettled, readable off Payment Schedule's own
// balance column; and the old Payment Schedule tab (Partial Payment installments) is
// superseded here by Outstanding Amount under the same name — the balance a client still
// owes, not the schedule that produced it.
const MAIN_TABS = [
  { key: "summary", label: "Summary" },
  { key: "schedule", label: "Payment Schedule" },
  { key: "discount", label: "Discount Applied", tone: "discount" },
  // The day-end count. Last of the four because it is the one thing here that is not a
  // reading of what the system already knows -- it is the desk telling the system what it
  // actually holds, which is only worth asking once the day it closes has been read.
  { key: "closing", label: "Closing Balance", tone: "closing" },
  // Directly after it, because it is the same thing read back: Closing Balance counts an
  // evening and signs it off, this is the month of evenings already signed. Separated
  // rather than folded into that panel's own Weekly/Monthly view, which answers a
  // different question -- that one lists every evening including the ones nobody counted,
  // and this one lists only the days somebody put their name to.
  { key: "closebooks", label: "Close Books", tone: "closing" },
];

/**
 * The windows this toolbar offers, out of the seven lib/dateRange names.
 *
 * This Week is the one left off. It shares its line with a branch select and five tab
 * names, so every window on it is paid for in width the tabs could have had, and a week
 * counted from Sunday is the window this desk reaches for least: the ledger is read for a
 * day, for the month that is running, or for the month being closed. The other six are
 * the ones the accountant actually narrows by.
 *
 * Order and words still come from FinanceDateFilter, so dropping one here cannot quietly
 * make another mean something different than it does on Expense or Profit.
 */
const DATE_PRESETS = ["all", "today", "yesterday", "this_month", "last_month", "custom"];

// Every tab a bordered button, the picked one filled solid in its own colour.
const mainTabClasses = (tab, active) => {
  if (tab.tone === "discount") {
    return active ? "border-amber-600 bg-amber-600 text-white shadow-sm" : "border-amber-200 bg-amber-50/40 text-amber-700 hover:border-amber-300 hover:bg-amber-50";
  }
  if (tab.tone === "closing") {
    return active ? "border-emerald-600 bg-emerald-600 text-white shadow-sm" : "border-emerald-200 bg-emerald-50/40 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50";
  }
  return active ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-sky-50/40 text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700";
};

/**
 * What a tab has waiting on it, on the tab's top-right corner: a red count, or a blue dot
 * where the tab only needs to say that something is there. The ring behind it pings so a
 * tab nobody has opened yet still catches the eye, the count pops in again whenever it
 * changes (keyed on it), and the whole badge, ring and all, cycles round the RGB spectrum
 * (.rgb-badge, index.css) -- the badge only, never the tab under it. All three motions are
 * motion-safe: a desk set to reduce motion still gets the badge, standing still in its own
 * red or blue. White-ringed so it reads on a filled tab as well.
 */
const TabBadge = ({ badge }) => {
  if (!badge) return null;
  if (badge.dot) {
    return (
      <span className="rgb-badge pointer-events-none absolute -right-1 -top-1 flex h-2.5 w-2.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500 ring-2 ring-white" />
      </span>
    );
  }
  return (
    <span className="rgb-badge pointer-events-none absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px]" aria-hidden="true">
      <span className="absolute inset-0 rounded-full bg-rose-400 opacity-75 motion-safe:animate-ping" />
      <span
        key={badge.count}
        className="relative inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white shadow-sm ring-2 ring-white motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300"
      >
        {badge.count > 99 ? "99+" : badge.count}
      </span>
    </span>
  );
};

// The Summary's five cards, each one the view under it: the three piles the income side is
// read in, the drawer, and the money that went out. The piles run in the order a collection
// travels them -- taken and waiting on the branch to verify, sent up and waiting on the
// accountant, signed off -- so the arrow on a To Verify row points at the card it moves to.
// Indigo for the branch's own pile, amber for waiting on somebody else, emerald for signed
// off, the colours the expense piles wear for the last two.
//
// Three piles again, after a spell as two. A collection used to go to the accountant the
// moment it was taken, which left the branch no say in what was sent; the branch now checks
// each one and sends it with the arrow (see stageOf, and request_transactions on the
// server), and the accountant's queue holds only what has been sent. The Payment Record
// card that read the piles at once was taken off at the branch's request; its Old Client
// Instalment button lives on Payment Schedule now.
const SUMMARY_CARDS = [
  { key: "collected", label: "To Verify", color: "#4f46e5", hint: "Taken at the desk, waiting for the branch to check it and send it to the accountant" },
  { key: "requested", label: "Awaiting Approval", color: "#d97706", hint: "Verified and sent, waiting for the accountant to sign it off" },
  { key: "approved", label: "Income Approved", color: "#059669", hint: "Signed off by the accountant" },
  // The drawer between money in and money out: what the branch should be holding now.
  { key: "cash", label: "Cash In Hand", color: "#0284c7" },
  { key: "expenses", label: "Expenses", color: "#e11d48" },
];

/** Which of the three one collection is in -- read off the record, where the arrow and its
 *  Undo write it (income_requested) and the accountant's approval does (approved). */
const stageOf = (tx) => (tx?.approved ? "approved" : tx?.income_requested ? "requested" : "collected");

// Same set a Branch Admin picks from when collecting a fee (V3MarkInstallmentPaidInput
// and its siblings across v3_packages.py) — not a separate list invented for this filter,
// same as Finance > Approvals' own payment-mode row.
const PAYMENT_MODES = [
  ["all", "All Modes"],
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["card", "Card"],
  ["account_transfer", "Bank Transfer"],
  ["cheque", "Cheque"],
];

// Online vs offline verticals, for the desks that want to read one side of the business
// at a time -- the Accountant's own Summary tab asks for it. It lives in here rather than
// in the board above because it filters the income summary and nothing else: on Payment
// Schedule, Discount Applied, Closing Balance or Close Books it narrowed nothing while
// still sitting at the top of the screen looking as though it did.
const VERTICAL_MODES = [
  ["all", "All"],
  ["offline", "Offline"],
  ["online", "Online"],
];

// The card, the table it filters to, and the label above that table are one thing, so they
// are one list rather than three that have to be kept in step.
// `label` names the section the detail table below is showing; `short` is what fits on a
// card standing eight to a row, and is what the branch breakdown's column headings were
// already making for themselves by cutting " Revenue" off the label.
const REVENUE_VIEWS = [
  { key: "collected", label: "Total Revenue", short: "Total", color: "#059669", icon: Wallet },
  { key: "consultation", label: "Consultation Revenue", short: "Consultation", color: "#0284c7", icon: Stethoscope },
  { key: "session", label: "Session Revenue", short: "Session", color: "#7c3aed", icon: Activity },
  { key: "diet", label: "Diet Revenue", short: "Diet", color: "#ea580c", icon: Salad },
  { key: "store", label: "Store Revenue", short: "Store", color: "#d97706", icon: ShoppingBag },
  // Zumba money lives on the registration, not in the leads' fee trail — see the
  // zumba loop in v3_finance.py's revenue-overview. It reaches this row the same way
  // store sales do, as transactions carrying source "zumba".
  { key: "zumba", label: "Zumba Revenue", short: "Zumba", color: "#db2777", icon: Music2 },
  // Real now that a rehab fee can be collected: rehab_fee_collected is its own revenue
  // category, so these transactions arrive carrying source "rehab".
  { key: "rehab", label: "Rehab Revenue", short: "Rehab", color: "#0891b2", icon: HeartPulse },
  // Gym memberships, reaching this row the same way Zumba's do: v3_fitness.py keeps the
  // fee on the registration, so it arrives as a transaction carrying source "fitness"
  // rather than through the leads' fee trail. Until it was counted, this was the one desk
  // taking money that never appeared on the page an accountant reads.
  { key: "fitness", label: "Fitness Revenue", short: "Fitness", color: "#65a30d", icon: Dumbbell },
];

// The seven the total is made of, which is the set the branch breakdown's columns are cut
// from: a column of totals beside seven columns that add up to it would be the same number
// written twice. Split off the one list rather than written out again, so a ninth category
// still only has to be added in one place.
const [, ...CATEGORY_VIEWS] = REVENUE_VIEWS;

// What each source's rows are called under its figure. Store sells, Zumba and Fitness
// register, everything else is paid.
const revenueNoun = (key) => (key === "store" ? "sale" : key === "zumba" || key === "fitness" ? "registration" : "payment");

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

// What a receipt calls each of the ledger's sources. The table's own column shows the
// bare category, which is the right length for a column and the wrong words for a
// document: a patient handed a sheet reading "Paid For: session" cannot match it against
// anything they were told at the desk.
const RECEIPT_PAID_FOR = {
  consultation: "Consultation Fee",
  session: "Treatment Fee",
  treatment: "Treatment Fee",
  rehab: "Rehab Fee",
  diet: "Diet Fee",
  diet_chart: "Diet Chart Fee",
  store: "Store Purchase",
  zumba: "Zumba Registration",
  fitness: "Fitness Membership",
};

/** One ledger row as a receipt. Named here rather than inside receiptFromTransaction
 *  because the source vocabulary is this desk's, not the receipt's. An instalment -- an
 *  old client's, or one collected off Payment Schedule -- says which one it was and what
 *  was left after it, the two things a client paying in pieces checks the paper for. */
const receiptForTxn = (tx) => {
  const r = receiptFromTransaction({
    ...tx,
    paidFor: RECEIPT_PAID_FOR[tx.source] || titleCase(tx.source || ""),
  });
  return {
    ...r,
    ...(tx.instalment_number ? { paidFor: `${r.paidFor} · Instalment #${tx.instalment_number}` } : {}),
    ...(tx.old_client ? { packageName: tx.session_package_label || "" } : {}),
    ...(tx.balance_after != null ? { balanceDue: fmt(tx.balance_after) } : {}),
  };
};

// Who may take which money here, as the endpoints behind each button allow it. Every Branch
// Admin variant is the branch desk, as is_branch_admin_role has it on the server.
const BRANCH_DESK_ROLES = [
  "branch_admin", "online_physio_admin", "online_fitness_admin",
  "branch_admin_physio", "branch_admin_fitness", "branch_admin_physio_fitness",
];
// An old client's instalment: the server's OLD_CLIENT_ROLES.
const OLD_CLIENT_ROLES = new Set([...BRANCH_DESK_ROLES, "super_admin", "accountant"]);
// Payment Schedule's Collect: an instalment through mark_installment_paid, a Consultation
// Fee through collect_package_payment -- which the Accountant is not on.
const INSTALMENT_ROLES = new Set([...BRANCH_DESK_ROLES, "super_admin", "accountant", "business_dev"]);
const CONSULTATION_FEE_ROLES = new Set([...BRANCH_DESK_ROLES, "super_admin", "business_dev"]);
const sessionRole = () => String(loadSession()?.user?.role || "").trim().toLowerCase();

// What the server calls money it cannot put under a branch -- see _branch_label in
// v3_finance.py. One is a client who was never given a branch, the other a branch id
// nothing answers to any more. Neither can be picked from the dropdown above, which is
// exactly why going through it one branch at a time never adds up to the total.
const UNPLACED = ["Unassigned", "Former branch"];

// The windows and the days behind them both come from lib/dateRange now — the copy this
// page kept is the one that module was extracted from. It picked up Yesterday and Last
// Month on the way, and lost a UTC bug with the copy: the dates went through
// toISOString(), which east of Greenwich turns local midnight into the previous day, so
// This Week and This Month each opened a day early.

const countLabel = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Who a popup is about, off a client's folded row or a single collection. */
const groupHead = (g) => ({ client_name: g.client_name, phone: g.phone, branch: g.branches.join(" · "), lead_id: g.lead_id, old_client: g.old_client });
const txHead = (tx) => ({ client_name: tx.client_name || "Unknown", phone: tx.phone, branch: tx.branch_name, lead_id: tx.lead_id, old_client: tx.old_client });

/** The one control a ledger row carries: the arrow into its payments (PaymentDetails), the
 *  same chevron Payment Schedule's Action column opens a client with. What can be done to
 *  the money -- send it for approval, take it back, reissue its receipt -- is in there
 *  rather than in a row of icons on every line, which the branch found harder to read
 *  than the list itself. */
const OpenArrow = ({ onClick, label = "View details", compact = false, testid }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`inline-flex items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-sky-700 ${compact ? "h-6 w-6" : "h-7 w-7"}`}
    title={label}
    aria-label={label}
    data-testid={testid}
  >
    <ChevronRight className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
  </button>
);

/** Send for approval, or Undo: moves collections between To Verify and Awaiting Approval.
 *  The branch desk's alone -- verifying is the branch's step, and the accountant's and
 *  Super Admin's copies read the piles without moving them. Nothing on an approved payment:
 *  taking back a signature is the accountant's (Approvals > Unapprove). `txs` is every
 *  collection the button stands for, all in one pile. */
const MoveChip = ({ txs, verify, label }) => {
  if (!verify || !txs.length) return null;
  const stage = stageOf(txs[0]);
  if (stage === "approved") return null;
  const busy = txs.some((t) => verify.busy.has(t.id));
  const send = stage === "collected";
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (!busy) verify.move(txs, !send); }}
      onKeyDown={(e) => e.stopPropagation()}
      disabled={busy}
      className={`inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-semibold transition disabled:opacity-50 ${
        send ? "bg-indigo-600 text-white hover:bg-indigo-700" : "border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
      }`}
      data-testid={`accountant-move-chip-${send ? "send" : "undo"}-${txs.map((t) => t.id).join("-")}`}
    >
      {send ? <>{label || "Send for approval"} <ArrowRight className="h-3.5 w-3.5" /></> : <><Undo2 className="h-3.5 w-3.5" /> {label || "Undo"}</>}
    </button>
  );
};

const PAYMENT_MODE_STYLES = {
  cash: "bg-emerald-50 text-emerald-700 border-emerald-200",
  upi: "bg-sky-50 text-sky-700 border-sky-200",
  card: "bg-violet-50 text-violet-700 border-violet-200",
  account_transfer: "bg-cyan-50 text-cyan-700 border-cyan-200",
  cheque: "bg-amber-50 text-amber-700 border-amber-200",
  partial: "bg-orange-50 text-orange-700 border-orange-200",
};

// Modes whose display name isn't just their key capitalised — without these,
// "account_transfer" would render as "Account_transfer".
const MODE_LABELS = { upi: "UPI", account_transfer: "Account Transfer" };
const formatMode = (mode) => (mode ? (MODE_LABELS[mode] || mode.charAt(0).toUpperCase() + mode.slice(1)) : "—");

const PaymentModeBadge = ({ mode }) => (
  <span className={`inline-flex items-center rounded-[5px] border px-2 py-0.5 text-[10px] font-semibold ${PAYMENT_MODE_STYLES[mode] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
    {formatMode(mode)}
  </span>
);

/**
 * The modes one collection actually arrived in.
 *
 * A fee taken half in cash and half by UPI is recorded as "split" — the right answer to
 * what the payment was, and no answer at all to what came in. This book is about what came
 * in, so a split reads back as the modes it was made of and "Split" is never shown: it is
 * the name of an arrangement, not of money, and a row wearing it told an Accountant
 * looking for their cash nothing.
 *
 * payment_split is [] on everything else, which is nearly every row — see
 * _parse_payment_split in v3_finance.py, which reads the tenders back off the collection.
 */
const modesOf = (tx) => {
  const split = tx?.payment_split || [];
  if (split.length > 0) return split.map((l) => l.mode).filter(Boolean);
  return tx?.payment_mode ? [tx.payment_mode] : [];
};

/** What of one collection landed under a given mode — the whole of it for an ordinary
 *  payment, and only that tender's share of a split. */
const amountInMode = (tx, mode) => {
  const split = tx?.payment_split || [];
  if (split.length === 0) return Number(tx?.gross) || 0;
  return split.reduce((n, l) => (l.mode === mode ? n + (Number(l.amount) || 0) : n), 0);
};

/** One badge per mode, and the breakdown on hover for the rows that have one — the
 *  figures live in the table's own Paid Amount column, so the badges stay a list of
 *  ways rather than a second column of money. */
const PaymentModes = ({ tx }) => {
  const modes = modesOf(tx);
  const split = tx?.payment_split || [];
  if (modes.length === 0) return <PaymentModeBadge mode="" />;
  return (
    <span
      className="inline-flex flex-wrap items-center justify-center gap-1"
      title={split.length > 0 ? split.map((l) => `${fmt(l.amount)} ${formatMode(l.mode)}`).join(" + ") : undefined}
    >
      {modes.map((m, i) => <PaymentModeBadge key={`${m}-${i}`} mode={m} />)}
    </span>
  );
};

/**
 * Accountant Manage — Super Admin's Branch Management > Accountant Management >
 * Accountant Manage, the same view reused read-only-by-nature (it's all reporting,
 * nothing editable) as Branch Admin's own "Accountant Manage" tab, and again as the
 * Accountant's own Summary tab. Three tabs — Summary, Payment Schedule, Discount
 * Applied — all sourced from the same finance/revenue-overview payload, scoped by the
 * date range sharing their tab bar (Payment Schedule excepted: a client's outstanding
 * balance is a right-now figure, not one a collection-date range narrows).
 *
 * @param verticalModeFilter  Show the All/Offline/Online pills, which this board then
 *              owns. The Accountant's own Summary tab asks for it; nowhere else does, and
 *              without it every vertical is counted. The pills share the Summary tab's
 *              filter strip with the payment modes, the two groups being the scope that
 *              page is read under.
 * @param approvedOnly  Counts signed-off money and nothing else, which is what the
 *              Accountant's own Summary tab asks for: money the branch has collected but
 *              had nobody sign is not the accountant's income yet, and showing it as such
 *              overstates the books. The income side fixes on the Approved pile, and the
 *              two stage pills stop being a filter and become figures to read.
 * @param toolbarTarget  An element in the page's own top bar (the finance workspace's tab
 *              row). Given one, the date range and Refresh are drawn there, so the whole
 *              dashboard reads off one top bar and this board keeps a single row of its own.
 * @param scoped  The branch is picked somewhere above this board and moves while it
 *              stays mounted -- Super Admin > Finance's branch-pill row. The select here
 *              is dropped (those pills already are it) and the branch is read straight
 *              off the prop on every render, so an empty one means All Branches rather
 *              than "pick your own", which is what a bare branchId would mean.
 */
export const AccountantManageTab = ({ branchId: fixedBranchId, verticalModeFilter = false, approvedOnly = false, scoped = false, toolbarTarget = null }) => {
  const [branches, setBranches] = useState([]);
  const [ownBranchId, setOwnBranchId] = useState(fixedBranchId || "");
  // Scoped: whatever the row above says, right now. Otherwise this board's own select,
  // seeded from a fixed branch where one was handed down and never moved after.
  const branchId = scoped ? (fixedBranchId || "") : ownBranchId;
  // Only the unscoped select sets it; kept under the old name so the JSX below reads
  // exactly as it did.
  const setBranchId = setOwnBranchId;
  const [tab, setTab] = useState("summary");
  const [ledger, setLedger] = useState("income");
  const role = useMemo(sessionRole, []);
  // The branch desk verifies what it took and sends it up (MoveButton), and undoes its own
  // last step on every tab. Nowhere the income side is fixed on signed-off money.
  const canVerify = !approvedOnly && BRANCH_DESK_ROLES.includes(role);
  // Which of the three piles the income side is showing. The branch desk opens on To
  // Verify, the one with something for it to do; elsewhere on Awaiting Approval, as it
  // always has -- except where only signed-off money counts, which fixes it on Approved
  // and never moves it again.
  const [incomeStage, setIncomeStage] = useState(approvedOnly ? "approved" : canVerify ? "collected" : "requested");
  // Collections whose Send or Undo is on its way to the server, so a second press waits.
  const [moving, setMoving] = useState(() => new Set());
  // The ledger row its arrow opened (PaymentDetails): who it is, and the ids of the
  // payments behind it. Ids rather than the rows themselves, so a Send or Undo pressed in
  // there shows the payment's new pile as soon as the list reloads.
  const [detail, setDetail] = useState(null);
  const [expenseTotals, setExpenseTotals] = useState({ approved_total: 0, approved_count: 0, pending_count: 0, pending_total: 0 });
  // One branch's drawer, or every opened branch's added up where no branch is picked.
  const [cashInHand, setCashInHand] = useState(0);
  // Branches left out of that roll-up because their drawer has no opening count yet. The
  // backend sums only counted drawers, so without this the card reads Rs.0 for a desk
  // that has taken cash all month and gives no hint why.
  const [openingUnset, setOpeningUnset] = useState(0);
  const [paymentModeFilter, setPaymentModeFilter] = useState("all");
  // Which side of the business the income summary is counting, where this board owns
  // the pills for it. "all" means no filter, same as a caller leaving `mode` unset.
  const [verticalMode, setVerticalMode] = useState("all");
  const [revenueView, setRevenueView] = useState("collected");
  const [preset, setPreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Bumped by the toolbar's Refresh, for the Closing Balance and Close Books panels, which
  // load their own figures rather than reading this board's.
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewingLeadId, setViewingLeadId] = useState(null);
  // The receipt for one collection on the ledger, reissued from the desk that keeps it.
  // The eye beside it opens the client; this opens the piece of paper.
  const [receipt, setReceipt] = useState(null);
  // The Old Client Instalment form: null when shut, otherwise what it opens on -- nothing
  // from Payment Schedule's button, one old client from that row's Collect.
  const [oldClientForm, setOldClientForm] = useState(null);
  // The Payment Schedule row whose due money is being collected, while its popup is open.
  const [collectRow, setCollectRow] = useState(null);
  // A Consultation Fee being collected on the Consultations board's own popups, mounted
  // over this tab: { row, n, opened }. `n` remounts it per Collect; `opened` stops it
  // reopening the fee each time its list reloads behind the patient.
  const [consultFee, setConsultFee] = useState(null);
  const canRecordOld = OLD_CLIENT_ROLES.has(role);
  const canCollectRow = useCallback(
    (row) => (collectWhat(row) === "instalment" ? INSTALMENT_ROLES : CONSULTATION_FEE_ROLES).has(role),
    [role],
  );

  // A scoped board still wants the list: nothing on it picks from it, but the scope chip
  // names the branch off it, and without the names it can only say "This branch".
  useEffect(() => {
    if (fixedBranchId && !scoped) return;
    getBranches().then(setBranches).catch(() => setBranches([]));
  }, [fixedBranchId, scoped]);

  // A board that hands a branch down can move it while this stays mounted — Super Admin's
  // branch picker sits above it. Seeding the state once left the tab reading the branch it
  // opened on, which is a wrong figure everywhere and a wrong drawer on the expense form:
  // cash spent on screen against one branch would have been filed against another.
  useEffect(() => {
    if (fixedBranchId) setOwnBranchId(fixedBranchId);
  }, [fixedBranchId]);

  // Both empty on "all" — no range, every collection ever made.
  const { startDate, endDate } = useMemo(() => {
    const [start, end] = rangeFor(preset, customFrom, customTo);
    return { startDate: start, endDate: end };
  }, [preset, customFrom, customTo]);

  const pickDates = (key, from, to) => { setPreset(key); setCustomFrom(from); setCustomTo(to); };

  // "online" | "offline", off this board's own pills where it carries them. Undefined
  // when it does not, or when All is picked, which getRevenueOverview reads as no filter
  // at all -- so Branch Admin's own tab and Branch Management's Analytics are unaffected.
  const verticalFilter = verticalModeFilter && verticalMode !== "all" ? verticalMode : undefined;

  const load = useCallback(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    setLoading(true);
    getRevenueOverview({
      branch_id: branchId || undefined,
      vertical_mode: verticalFilter || undefined,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [branchId, verticalFilter, startDate, endDate, preset, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  // Kept beside the revenue call rather than inside it: this one answers about money going
  // out, and a branch with no expenses should not stop the eight revenue cards rendering.
  // Scoped to the same branch and the same date range the revenue call is, though — the
  // expense figures sit in the same row as the income ones and Profit subtracts one from
  // the other, so Income for Today less Expenses for all time was two scopes in one sum.
  // The drawer is left out of the range: cash in hand is what is in the box now.
  const loadExpenseTotals = useCallback(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    getFinanceExpenses({
      branch_id: branchId || undefined,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    })
      .then((d) => setExpenseTotals({
        approved_total: d.approved_total || 0,
        approved_count: d.approved_count || 0,
        pending_count: d.pending_count || 0,
        pending_total: d.pending_total || 0,
      }))
      .catch(() => { /* the card falls back to zero; the panel says why when opened */ });
    getBranchCash(branchId ? { branch_id: branchId } : {})
      .then((d) => {
        setCashInHand((d?.by_branch ? d.total?.cash_in_hand : d?.cash_in_hand) || 0);
        setOpeningUnset(d?.by_branch ? d.total?.opening_unset || 0 : d?.opening_set === false ? 1 : 0);
      })
      .catch(() => { setCashInHand(0); setOpeningUnset(0); });
  }, [branchId, startDate, endDate, preset, customFrom, customTo]);

  useEffect(() => { loadExpenseTotals(); }, [loadExpenseTotals]);

  // A collection taken from this board: the figures reloaded and the receipt handed over,
  // as every Collect popup does -- the client is at the desk waiting for it.
  const afterCollect = (message, tx) => {
    toast.success(message);
    load();
    loadExpenseTotals();
    if (tx) setReceipt(receiptForTxn(tx));
  };

  /**
   * The arrow and its Undo: send collections up for approval, or take them back before they
   * are signed. Several at once where one client's folded row stands for several. The toast
   * carries an Undo of its own, for the press that landed on the wrong row.
   */
  const moveTxns = async (txs, back) => {
    const ids = [...new Set(txs.map((t) => t.id).filter(Boolean))];
    if (!ids.length) return;
    setMoving((prev) => new Set([...prev, ...ids]));
    try {
      const res = back ? await unrequestTransactions(ids) : await requestTransactions(ids);
      const n = back ? res?.pulled ?? ids.length : res?.sent ?? ids.length;
      if (back) {
        toast.success(`${countLabel(n, "payment")} back in To Verify`);
      } else {
        toast.success(`${countLabel(n, "payment")} sent to the accountant for approval`, {
          action: { label: "Undo", onClick: () => moveTxns(txs, true) },
        });
      }
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || (back ? "Could not take that payment back" : "Could not send that payment"));
    }
    setMoving((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };
  const verify = canVerify ? { move: moveTxns, busy: moving } : null;

  // Payment Schedule's Undo: the newest instalment on a client, back to owed. Asked first --
  // it takes money off the day -- and refused by the server once the payment is with the
  // accountant or its day's book is closed. True when it went through.
  const undoScheduleRow = async (row) => {
    const u = row.undo_last;
    if (!u) return false;
    if (!window.confirm(`Undo ${u.label} — ${fmt(u.amount)} collected from ${row.client_name || "this client"}${u.at ? ` on ${u.at.slice(0, 10)}` : ""}?\n\nThe payment is removed and the amount is owed again.`)) return false;
    try {
      const res = await undoLastInstalment(row.old_client ? { old_client_id: row.old_client_id } : { lead_id: row.lead_id });
      toast.success(res?.message || "Payment undone");
      load();
      loadExpenseTotals();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not undo that payment");
      return false;
    }
  };

  // That Undo as the client's popup draws it -- the client card for a lead, the instalment
  // form for an old client -- rather than as an icon on the Payment Schedule row. Shown
  // greyed with its reason once the payment is the accountant's.
  const scheduleUndo = (row) => {
    const u = canVerify && row?.undo_last;
    if (!u) return undefined;
    return {
      label: u.label,
      amount: u.amount,
      blocked: u.approved
        ? "Approved by the accountant — only they can undo it"
        : u.sent ? "This payment is with the accountant — undo it on Summary first, then here" : "",
      run: () => undoScheduleRow(row),
    };
  };

  const openDetail = (payments, head) => setDetail({ ids: payments.map((t) => t.id), head });

  const k = data?.kpis || {};
  // `data?.x || []` builds a fresh array on every render, so every memo keyed on one was
  // re-running each time and memoising nothing. Held steady here instead.
  const transactions = useMemo(() => data?.transactions || [], [data]);
  const outstanding = useMemo(() => data?.outstanding_clients || [], [data]);
  // The client popup's Collect: the open client's Payment Schedule row, when that row is
  // one its own Collect button would take -- the board's rule, read off the same row.
  const viewingRow = useMemo(() => outstanding.find((r) => r.lead_id === viewingLeadId), [outstanding, viewingLeadId]);
  // The opened row's payments, read off the whole ledger rather than the filtered list, so
  // a payment that has just moved pile stays in front of the desk that moved it.
  const detailPayments = useMemo(() => {
    if (!detail) return [];
    const byId = new Map(transactions.map((t) => [t.id, t]));
    return detail.ids.map((id) => byId.get(id)).filter(Boolean);
  }, [detail, transactions]);
  const viewingCollectable = Boolean(viewingRow) && !viewingRow.old_client && !viewingRow.past_data && viewingRow.balance > 0 && canCollectRow(viewingRow);
  // A Collect on a Payment Schedule row, from the table or the client popup. An instalment
  // is one fixed figure and is taken on this tab's short popup. A Consultation Fee opens the
  // Consultation tab's own Collect right here, over this page: a first collection picks the
  // package, agrees any discount and dates any balance before the mode's own Confirm &
  // Collect, and waits on the prescription -- none of which the short popup asks.
  const collectScheduleRow = (row) => {
    if (collectWhat(row) === "consultation") {
      setViewingLeadId(null);
      setConsultFee({ row, n: Date.now(), opened: false });
      return;
    }
    setCollectRow(row);
  };

  // How it was paid, which is the one cut left on this list. Whether a collection has
  // been signed off is the Accountant's own Approvals tab, and asking it here too gave a
  // branch two screens answering one question in two places.
  // The stage comes first: every figure on the income side -- the eight tiles, the
  // payment-mode row, the table -- describes one of the three piles, so narrowing to the
  // pile before anything else is what keeps the cards and the rows under them the same
  // money. Filtering afterwards would leave the tiles counting a pile the table is not
  // showing.
  const stagedTxns = useMemo(
    () => transactions.filter((t) => stageOf(t) === incomeStage),
    [transactions, incomeStage],
  );

  // What each pile holds and how many rows it holds it in, for the figure on each pill.
  // Off the whole set rather than the staged one, which is the pile currently being looked
  // at -- and deliberately before the payment-mode cut too: a pill saying what is still
  // waiting to be sent up has to say all of it, not the cash half of it, or pressing Cash
  // would make money look like it had already gone.
  const stagePiles = useMemo(() => {
    const out = {
      collected: { count: 0, total: 0 },
      requested: { count: 0, total: 0 },
      approved: { count: 0, total: 0 },
    };
    transactions.forEach((t) => {
      const pile = out[stageOf(t)];
      pile.count += 1;
      pile.total += Number(t.gross) || 0;
    });
    return out;
  }, [transactions]);

  const filteredTxns = useMemo(() => {
    if (paymentModeFilter === "all") return stagedTxns;
    return stagedTxns
      .filter((t) => modesOf(t).includes(paymentModeFilter))
      // A split belongs under both its modes, but only for the part that arrived that
      // way: Cash on a Rs.8,000 cash + Rs.4,000 UPI payment is Rs.8,000, and carrying the
      // whole Rs.12,000 into both pills would make the two figures add to more than was
      // ever collected. The row is rewritten to the tender being asked about, so the cards
      // above and the amount on the row are the same money.
      .map((t) => {
        const split = t.payment_split || [];
        if (split.length === 0) return t;
        const amount = amountInMode(t, paymentModeFilter);
        return {
          ...t,
          gross: amount,
          net: amount,
          payment_split: split.filter((l) => l.mode === paymentModeFilter),
        };
      });
  }, [stagedTxns, paymentModeFilter]);

  // Every card's figure and the count under it, from one pass over whichever set the
  // filters above left standing.
  const sums = useMemo(() => {
    const totals = { collected: 0, consultation: 0, session: 0, diet: 0, store: 0, zumba: 0, rehab: 0, fitness: 0 };
    const counts = { collected: 0, consultation: 0, session: 0, diet: 0, store: 0, zumba: 0, rehab: 0, fitness: 0 };
    filteredTxns.forEach((t) => {
      const amt = Number(t.gross) || 0;
      totals.collected += amt;
      counts.collected += 1;
      if (totals[t.source] !== undefined) {
        totals[t.source] += amt;
        counts[t.source] += 1;
      }
    });
    return { totals, counts };
  }, [filteredTxns]);

  // The same rows the cards above were summed from, grouped by branch -- deliberately
  // not the payload's own by_branch, which ignores the approval view and the payment
  // mode pills and would part company with the cards the moment either was touched.
  //
  // Here because the cards and the branches did not agree and this page gave no way to
  // see why. Money whose client was deleted, never given a branch, or left pointing at
  // a branch that no longer exists counts in every total and belongs to no branch that
  // can be selected, so switching the dropdown branch by branch could never find it.
  const branchRows = useMemo(() => {
    const acc = new Map();
    filteredTxns.forEach((t) => {
      const name = t.branch_name || UNPLACED[0];
      const row = acc.get(name) || { name, total: 0, consultation: 0, session: 0, diet: 0, store: 0, zumba: 0, rehab: 0, fitness: 0 };
      const amt = Number(t.gross) || 0;
      row.total += amt;
      if (row[t.source] !== undefined) row[t.source] += amt;
      acc.set(name, row);
    });
    return [...acc.values()].sort((a, b) => b.total - a.total);
  }, [filteredTxns]);

  const unplacedTotal = useMemo(
    () => branchRows.filter((r) => UNPLACED.includes(r.name)).reduce((sum, r) => sum + r.total, 0),
    [branchRows],
  );

  // Every collection taken below its listed price, biggest concession first — not run
  // through the Collected/Approved/Pending filter above, since a discount is a fact about
  // the collection itself, independent of whether it's since been signed off.
  const discountedTxns = useMemo(
    () => transactions
      .filter((t) => (Number(t.discount) || 0) > 0)
      .sort((a, b) => (Number(b.discount) || 0) - (Number(a.discount) || 0)),
    [transactions],
  );

  // What the tab row flags (TabBadge). Payment Schedule counts the clients whose instalment
  // is overdue or falls due today -- the two cards on that board that are a call to make
  // now, read with the same rules. Summary counts what the branch desk still has to verify,
  // and elsewhere dots while collections are waiting on the accountant's signature.
  const tabBadges = useMemo(() => {
    const today = todayIso();
    const due = outstanding.filter((r) => r.status === "overdue" || r.due_date === today).length;
    const toVerify = stagePiles.collected.count;
    const waiting = stagePiles.requested.count + toVerify;
    return {
      summary: canVerify
        ? (toVerify > 0 ? { count: toVerify, title: `${countLabel(toVerify, "payment")} to verify` } : null)
        : (waiting > 0 ? { dot: true, title: `${countLabel(waiting, "payment")} awaiting approval` } : null),
      schedule: due > 0 ? { count: due, title: `${countLabel(due, "client")} overdue or due today` } : null,
    };
  }, [outstanding, stagePiles, canVerify]);

  // The scope chip that read all of this back in words is gone with the header it sat in.
  // It described the branch select and the range row directly beneath it, both of which say
  // what they are set to on their own faces, so it was a third control's worth of screen
  // spent repeating two.

  // The range and Refresh, in force on every tab: Summary and Discount Applied by the day
  // the money came in, Payment Schedule by the day a balance falls due, Closing Balance and
  // Close Books by the evenings counted and signed. Those two once carried their own
  // period controls instead; one control for the whole board leaves nobody asking which
  // date is in force.
  //
  // On a phone, in this board's own bar, it shares a line with the payment-mode dropdown
  // and grows to fill it. Its 3rem basis is the Refresh button and the gap before it, which
  // leaves the two dropdowns the same width rather than this one a button narrower.
  const dateControls = (
    <div
      className={`flex flex-nowrap items-center gap-2 ${toolbarTarget ? "shrink-0" : "min-w-0 flex-[1_1_3rem] sm:ml-auto sm:flex-none"}`}
      data-testid="accountant-manage-date-filter"
    >
      <FinanceDateFilter
        preset={preset}
        customFrom={customFrom}
        customTo={customTo}
        onChange={pickDates}
        presets={DATE_PRESETS}
        variant="inline"
        filterIcon
        mobileSelect
        testid="accountant-manage-window"
      />
      <Button
        onClick={() => { load(); loadExpenseTotals(); setRefreshKey((n) => n + 1); }}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        data-testid="accountant-manage-refresh"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="accountant-manage-tab">
      {toolbarTarget && dateControls && createPortal(dateControls, toolbarTarget)}
      {/* No title, no standfirst, no scope chip. This board is only ever reached by opening
          the tab named after it, so a heading repeating that name, a sentence explaining
          what a ledger is, and a chip reading back the two controls directly under it cost
          a band of screen each to say what the screen already said. The figures start at the
          top of the page now, which is what anybody opening it came for.

          One row, read left to right: which branch, then which view of it, then the range it
          is narrowed to. The branch select keeps its condition: the boards that pass a fixed
          branch have nothing to choose, and the row starts at the tabs for them.

          From sm up, every group in here is shrink-0 and gives back padding rather than
          width under 1900px, so on any ordinary desk the row simply fits.

          Under 1900px, not under 2xl. The full-size type and padding were taken back at
          1536px, some 240px before this row had the width for them, so every laptop
          between the two grew the branch select, five tab names and six windows past the
          right edge at once -- and since this strip hides its scrollbar, what that looked
          like was a Custom Range button sliced down the middle and no Refresh at all.

          A phone is laid out for its width instead of shrunk to it. The same groups, all
          shrink-0, overran the bar's right edge there: "Closing B", "Ch" and half a Refresh
          button, with the rest of the page dragged sideways after them. Below sm the bar
          is three lines, every one of them the bar's own width -- the tabs, three to a line;
          the All/Offline/Online pills where the board carries them; then the payment modes
          and the date windows each folded into a dropdown, side by side, with Refresh.

          90% from sm up, this bar only. zoom rather than transform: scale — zoom shrinks the
          box itself, so the tabs, modes and windows fit on one desk line without the strip
          scrolling, and the bar stays flush with the board's edges instead of leaving the
          gap a scaled-down full-width row would. Not on a phone, where the bar is laid out
          to fit and 90% of 12px type was only harder to read. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm sm:[zoom:0.9]" data-testid="accountant-manage-maintabs">
        {!fixedBranchId && !scoped && (
          <div className="flex w-full items-center gap-2 px-1.5 sm:w-auto sm:shrink-0 sm:border-r sm:border-slate-200 sm:pr-2 min-[1900px]:pr-3">
            <label htmlFor="accountant-manage-branch" className="text-xs font-medium text-slate-600">Branch:</label>
            <select
              id="accountant-manage-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-xs text-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 sm:flex-none min-[1900px]:text-sm"
              data-testid="accountant-manage-branch-select"
            >
              <option value="">All Branches</option>
              {branches.map((br) => <option key={br.id} value={br.id}>{br.branch_name}</option>)}
            </select>
          </div>
        )}
        {/* gap-2, not gap-1: a badge stands 6px out past its tab's right edge, and any
            less would put it on the next tab's border.

            On a phone the five wrap, three to a line at a 30% basis, and each grows to share
            its line -- so the last two split theirs in half rather than leaving a hole. A
            name too long for a third of a phone breaks onto a second line inside a 44px tab
            instead of being cut off at the edge. */}
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap min-[1900px]:gap-2.5">
          {MAIN_TABS.map((t) => {
            const badge = tabBadges[t.key];
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                title={badge?.title}
                aria-label={badge ? `${t.label} (${badge.title})` : undefined}
                className={`relative h-11 min-w-0 grow basis-[30%] rounded-lg border px-1.5 text-center text-xs font-semibold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 sm:h-10 sm:shrink-0 sm:grow-0 sm:basis-auto sm:whitespace-nowrap sm:px-2.5 min-[1900px]:px-3.5 min-[1900px]:text-sm ${mainTabClasses(t, tab === t.key)}`}
                data-testid={`accountant-manage-maintab-${t.key}`}
              >
                {t.label}
                <TabBadge badge={badge} />
              </button>
            );
          })}
        </div>
        {/* How the figures are narrowed, on the Summary page only: which side of the
            business, then how the money came in. In this row rather than a strip of their
            own, so the board keeps to one bar under the page's tabs. */}
        {tab === "summary" && (
          <>
            {/* Three short words: a line of their own on a phone, a third each. */}
            {verticalModeFilter && (
              <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-nowrap sm:items-center sm:border-l sm:border-slate-200 sm:pl-2" data-testid="accountant-manage-vertical-mode-filter">
                {VERTICAL_MODES.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setVerticalMode(key)}
                    className={`h-10 shrink-0 whitespace-nowrap rounded-md border px-3 text-xs font-medium transition min-[1900px]:text-sm ${
                      verticalMode === key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
                    }`}
                    data-testid={`accountant-manage-vertical-mode-${key}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {/* Six buttons are wider than a phone, so there they are one dropdown, sharing a
                line with the date dropdown -- see dateControls. */}
            <FilterSelect
              value={paymentModeFilter}
              onChange={setPaymentModeFilter}
              active={paymentModeFilter !== "all"}
              accent="indigo"
              label="Payment mode"
              className="flex-1 sm:hidden"
              testid="accountant-manage-payment-mode-select"
            >
              {PAYMENT_MODES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </FilterSelect>
            <div className="hidden shrink-0 flex-nowrap items-center gap-2 border-l border-slate-200 pl-2 sm:flex" data-testid="accountant-manage-payment-mode-filter">
              {PAYMENT_MODES.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPaymentModeFilter(key)}
                  className={`h-10 shrink-0 whitespace-nowrap rounded-md border px-3 text-xs font-medium transition min-[1900px]:text-sm ${
                    paymentModeFilter === key ? "border-indigo-600 bg-indigo-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                  }`}
                  data-testid={`accountant-manage-payment-mode-${key}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {!toolbarTarget && dateControls}
      </div>

      {loading && !data ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
      ) : tab === "summary" ? (
        <div className="space-y-4" data-testid="accountant-manage-summary">
          {/* The four cards, each the view under it (Zumba's summary cards, ui/ledger-card):
              the two income piles, the drawer, and the money that went out. The picked one is
              filled in its colour. Where only signed-off money counts there is no pile to move
              to, so Awaiting Approval is a figure to read rather than a card to press.

              The book line that sat under them (Revenue, Expense, Profit, Total Expense) is
              gone: the branch asked for these cards and nothing else. */}
          {/* Five to a line from lg; on a phone two to a line with the fifth, Expenses,
              across both columns rather than half a line on its own. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1" data-testid="accountant-manage-ledger-filter">
            {SUMMARY_CARDS.map((c) => {
              // The income-side cards, each opening the income ledger at its own pile.
              const pile = c.key === "approved" || c.key === "requested" || c.key === "collected";
              const picked = pile ? ledger === "income" && incomeStage === c.key : ledger === c.key;
              const pendingExpense = Number(expenseTotals.pending_total) || 0;
              const card = {
                collected: { value: stagePiles.collected.total, sub: countLabel(stagePiles.collected.count, "payment") },
                approved: { value: stagePiles.approved.total, sub: countLabel(stagePiles.approved.count, "payment") },
                requested: { value: stagePiles.requested.total, sub: countLabel(stagePiles.requested.count, "payment") },
                cash: {
                  value: cashInHand,
                  color: cashInHand < 0 ? "#e11d48" : c.color,
                  sub: openingUnset > 0
                    ? (branchId
                      ? "Opening cash not set — set it on Branch Cash"
                      : `${openingUnset} ${openingUnset === 1 ? "branch" : "branches"} without an opening count, not included`)
                    : undefined,
                },
                expenses: {
                  value: expenseTotals.approved_total,
                  sub: pendingExpense > 0
                    ? `+ ${fmt(pendingExpense)} awaiting approval`
                    : countLabel(Number(expenseTotals.approved_count) || 0, "approved expense"),
                },
              }[c.key];
              const readOnly = approvedOnly && (c.key === "requested" || c.key === "collected");
              return (
                <LedgerCard
                  key={c.key}
                  label={c.label}
                  value={fmt(card.value)}
                  sub={card.sub}
                  color={card.color || c.color}
                  title={c.hint}
                  active={picked}
                  onClick={readOnly ? undefined : () => {
                    if (pile) {
                      setLedger("income");
                      setIncomeStage(c.key);
                    } else {
                      setLedger(c.key);
                    }
                  }}
                  testid={`accountant-manage-ledger-${c.key}`}
                />
              );
            })}
          </div>

          {/* Expenses is its own ledger, not a filter of this one: nothing above it —
              the revenue tiles, the source table, the payment-mode row — describes money
              going out, so the whole of the income side steps aside for it rather than
              being reused with different numbers in it. */}
          {ledger === "cash" && <BranchExpensesPanel section="cash" onChanged={loadExpenseTotals} branchId={branchId} />}
          {ledger === "expenses" && <BranchExpensesPanel section="expenses" onChanged={loadExpenseTotals} branchId={branchId} startDate={startDate} endDate={endDate} />}

          {ledger === "income" && (
          <>
          {/* All eight on one line where there is room for eight, stepping down to four
              and then two rather than squeezing: at lg an eighth of the width is narrower
              than the card's own text column.

              Total stands in the line rather than above it. It is the sum of the seven
              beside it and could be argued into a card of its own -- it had one for a
              while -- but a row read across wants one card repeated, and drawing one of
              them bigger turned the other seven into its footnotes.

              The same card as the five above (ui/ledger-card), so the two rows read as one
              set: white at rest, the picked one filled solid in its own colour. */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3 xl:grid-cols-8">
            {REVENUE_VIEWS.map((v) => (
              <LedgerCard
                key={v.key}
                label={v.short}
                value={fmt(sums.totals[v.key])}
                sub={countLabel(sums.counts[v.key], revenueNoun(v.key))}
                color={v.color}
                active={revenueView === v.key}
                muted={!sums.totals[v.key]}
                onClick={() => setRevenueView(v.key)}
                testid={`revenue-kpi-${v.label.toLowerCase().replace(/\s+/g, "-")}`}
              />
            ))}
          </div>

          {!branchId && branchRows.length > 1 && (
            <div className="rounded-md border border-slate-200 bg-white" data-testid="accountant-manage-by-branch">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
                <h3 className="text-sm font-semibold text-slate-700">Revenue by branch</h3>
                {unplacedTotal > 0 && (
                  <p className="text-[11px] text-amber-700" data-testid="accountant-manage-unplaced-note">
                    {fmt(unplacedTotal)} belongs to no branch that can be selected
                  </p>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2 text-left font-semibold">Branch</th>
                      {CATEGORY_VIEWS.map((v) => (
                        <th key={v.key} className="whitespace-nowrap px-3 py-2 text-right font-semibold">
                          {v.short}
                        </th>
                      ))}
                      <th className="px-4 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branchRows.map((r) => (
                      <tr
                        key={r.name}
                        className={`border-b border-slate-100 ${UNPLACED.includes(r.name) ? "bg-amber-50" : ""}`}
                        data-testid={`accountant-manage-branch-row-${r.name}`}
                      >
                        <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-700">{r.name}</td>
                        {CATEGORY_VIEWS.map((v) => (
                          <td key={v.key} className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-600">
                            {r[v.key] ? fmt(r[v.key]) : "—"}
                          </td>
                        ))}
                        <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums text-slate-800">{fmt(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-800">
                      <td className="px-4 py-2">All branches</td>
                      {CATEGORY_VIEWS.map((v) => (
                        <td key={v.key} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{fmt(sums.totals[v.key])}</td>
                      ))}
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{fmt(sums.totals.collected)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          <RevenueDetailTable
            rows={revenueView === "collected" ? filteredTxns : filteredTxns.filter((t) => t.source === revenueView)}
            onOpen={openDetail}
            verify={verify}
          />
          </>
          )}
        </div>
      ) : tab === "schedule" ? (
        <OutstandingAmountBoard
          rows={outstanding}
          onView={setViewingLeadId}
          onChanged={load}
          onCollect={collectScheduleRow}
          canCollect={canCollectRow}
          onNewOld={canRecordOld ? () => setOldClientForm({}) : undefined}
          onCollectOld={canRecordOld ? (row) => setOldClientForm({ startWith: { id: row.old_client_id, phone: row.phone, branch_id: row.branch_id }, row }) : undefined}
          startDate={startDate}
          endDate={endDate}
        />
      ) : tab === "closebooks" ? (
        // The signed-off days inside the range at the top -- see the panel.
        <CloseBookHistoryPanel branchId={branchId} start={startDate} end={endDate} refreshKey={refreshKey} />
      ) : tab === "closing" ? (
        // One evening's count when the range is a single day, the evenings read back when
        // it is longer -- see the panel. A history row opening its own evening narrows the
        // range at the top to that day.
        <ClosingBalancePanel
          branchId={branchId}
          start={startDate}
          end={endDate}
          refreshKey={refreshKey}
          onPickDay={(on) => pickDates("custom", on, on)}
        />
      ) : (
        <DiscountAppliedBoard rows={discountedTxns} onOpen={openDetail} verify={verify} />
      )}

      {/* The Custom Range dialog moved into FinanceDateFilter, which opens it from the row
          above — one dialog for the four finance pages instead of a copy per page. */}

      {viewingLeadId && (
        <ClientHistoryModal
          leadId={viewingLeadId}
          onClose={() => setViewingLeadId(null)}
          onChanged={load}
          onCollect={viewingCollectable ? () => collectScheduleRow(viewingRow) : undefined}
          undo={scheduleUndo(viewingRow)}
        />
      )}
      {detail && (
        <PaymentDetails
          head={detail.head}
          payments={detailPayments}
          verify={verify}
          onReceipt={(tx) => setReceipt(receiptForTxn(tx))}
          onClientHistory={(leadId) => { setDetail(null); setViewingLeadId(leadId); }}
          onClose={() => setDetail(null)}
        />
      )}
      {oldClientForm && (
        <OldClientInstalmentDialog
          branchId={branchId}
          branches={branches}
          startWith={oldClientForm.startWith || null}
          undo={scheduleUndo(oldClientForm.row)}
          onClose={() => setOldClientForm(null)}
          onSaved={(res) => {
            setOldClientForm(null);
            afterCollect(res.message || "Instalment recorded", res.transaction);
          }}
        />
      )}
      {collectRow && (
        <ScheduleCollectDialog
          row={collectRow}
          onClose={() => setCollectRow(null)}
          onCollected={(tx) => {
            setCollectRow(null);
            // Taken from the client popup, the popup goes too: what it showed is now out of
            // date, and the receipt is what comes next.
            setViewingLeadId(null);
            afterCollect(`${fmt(tx.gross)} collected from ${tx.client_name}`, tx);
          }}
        />
      )}
      {consultFee && (
        <Suspense fallback={null}>
          <ConsultationsBoard
            key={consultFee.n}
            popupOnly
            // The row's own branch: Super Admin's Finance board can be on All Branches.
            branchId={consultFee.row.branch_id || branchId}
            viewerRole="branch_admin"
            autoOpenLeadId={consultFee.opened ? null : consultFee.row.lead_id}
            autoOpenFee="consultation"
            onAutoOpened={() => setConsultFee((c) => c && { ...c, opened: true })}
            // Closed with or without the money taken -- either way this list is reloaded,
            // so a fee collected there drops off it.
            onPopupClosed={() => { setConsultFee(null); load(); }}
          />
        </Suspense>
      )}
      <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} testid="accountant-receipt" />
    </div>
  );
};

// One card per fee type, mirroring Summary's row. The first four figures this tab carried
// — total, listed value, average % and count — could not filter anything between them: all
// four described the same set of rows, so three of the cards would have been the same
// filter as the first. Splitting by source is the cut that actually partitions the list,
// and every one of those figures survives on the cards below.
//
// No Store card. A counter sale is rung at the shelf price and carries no discount, so it
// could only ever read Rs.0.
const DISCOUNT_VIEWS = [
  { key: "all", label: "Total Discount", icon: Wallet, color: "#d97706" },
  { key: "consultation", label: "Consultation", icon: Stethoscope, color: "#0284c7" },
  { key: "session", label: "Session", icon: Activity, color: "#7c3aed" },
  { key: "diet", label: "Diet", icon: Salad, color: "#059669" },
];

/**
 * Discount Applied — every collection settled below its listed price.
 *
 * The money here was never owed and never will be: the OS treats a negotiated fee as
 * settled in full the moment it is confirmed, so none of it appears under Payment
 * Schedule. Which means this is the only place the concessions a branch has granted are
 * countable at all.
 *
 * Each row is one confirmed collection, not one client, because the discount was a
 * decision taken at that moment — rolling a client's two visits together would average
 * away the one that was actually negotiated.
 */
/** @param onOpen  Opens a collection's PaymentDetails -- its arrow, and a tap on its phone card. */
const DiscountAppliedBoard = ({ rows, onOpen, verify = null }) => {
  const [view, setView] = useState("all");

  // Falls back to listed = collected + discount when original_amount is missing, which is
  // every collection taken before v3_packages began recording the listed price.
  const listedOf = (tx) => Number(tx.original_amount) || (Number(tx.gross) || 0) + (Number(tx.discount) || 0);
  const pctOf = (tx) => { const l = listedOf(tx); return l > 0 ? (Number(tx.discount) / l) * 100 : 0; };

  // Every card's figures, and the rows behind whichever is selected, from one pass.
  const slices = useMemo(() => {
    const acc = {};
    DISCOUNT_VIEWS.forEach((v) => {
      const list = v.key === "all" ? rows : rows.filter((t) => t.source === v.key);
      const given = list.reduce((s, t) => s + (Number(t.discount) || 0), 0);
      // Against the listed price, not against what was collected: Rs.200 off a Rs.1000 fee
      // is 20% off, and dividing by the Rs.800 taken would call it 25%.
      const listed = list.reduce((s, t) => s + (Number(t.original_amount) || (Number(t.gross) || 0) + (Number(t.discount) || 0)), 0);
      acc[v.key] = { list, given, listed, pct: listed > 0 ? (given / listed) * 100 : 0 };
    });
    return acc;
  }, [rows]);

  const active = slices[view] || slices.all;
  const visible = active.list;

  return (
    <div className="space-y-4" data-testid="accountant-manage-discount">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {DISCOUNT_VIEWS.map((v) => {
          const s = slices[v.key];
          return (
            <StatTile
              key={v.key}
              label={v.label}
              value={fmt(s.given)}
              // The three figures the single-total card used to spend a tile each on:
              // how many payments, how deep the cut, and what it was cut from.
              sub={`${countLabel(s.list.length, "payment")} · ${s.pct.toFixed(1)}% of ${fmt(s.listed)}`}
              icon={v.icon}
              color={v.color}
              active={view === v.key}
              onClick={() => setView(v.key)}
              testid={`discount-kpi-${v.key}`}
            />
          );
        })}
      </div>

      <Card>
        <CardContent className="p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {view === "all" ? "Discount Applied" : `${DISCOUNT_VIEWS.find((v) => v.key === view)?.label} Discounts`}
          </p>

          <div className="space-y-2 md:hidden" data-testid="discount-detail-mobile">
            {visible.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">No discounted collections yet.</p>
            ) : visible.map((tx, i) => (
              <div
                key={tx.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen([tx], txHead(tx))}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen([tx], txHead(tx)); } }}
                className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 active:bg-slate-50"
                data-testid={`discount-detail-card-${tx.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-800">
                      <span className="mr-1.5 font-normal text-slate-400">{i + 1}.</span>
                      {tx.client_name || "Unknown"}
                    </p>
                    <p className="truncate text-xs text-slate-500">{tx.phone || "—"}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold text-amber-600">−{fmt(tx.discount)}</p>
                    <p className="text-[11px] text-slate-400">{pctOf(tx).toFixed(1)}% off</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                  <span className="line-through">{fmt(listedOf(tx))}</span>
                  <span className="font-semibold text-emerald-600">{fmt(tx.gross)}</span>
                  <span className="capitalize">{tx.source}</span>
                  <span>{(tx.date || "").slice(0, 10)}</span>
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-slate-400" />
                </div>
              </div>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[56rem] table-fixed border-separate border-spacing-x-0 border-spacing-y-2 text-sm">
              <thead>
                <tr>
                  <th className="w-[4%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">S.No</th>
                  <th className="w-[14%] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Client</th>
                  <th className="w-[11%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Phone</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Paid For</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Listed Price</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Collected</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Discount</th>
                  <th className="w-[8%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">%</th>
                  <th className="w-[9%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Date</th>
                  <th className="w-[12%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Branch</th>
                  <th className="w-[9%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">{verify ? "Action" : "View"}</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-sm text-slate-400">No discounted collections yet.</td></tr>
                ) : visible.map((tx, i) => (
                  <tr key={tx.id} onClick={() => onOpen([tx], txHead(tx))} className="cursor-pointer" data-testid={`discount-detail-row-${tx.id}`}>
                    <td className="rounded-l-[5px] border-y border-l border-slate-200 bg-white px-3 py-2 text-center text-slate-400">{i + 1}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 font-medium text-slate-800">{tx.client_name || "Unknown"}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-600">{tx.phone || "—"}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center capitalize text-slate-600">{tx.source}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-500 line-through">{fmt(listedOf(tx))}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center font-semibold text-emerald-600">{fmt(tx.gross)}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center font-semibold text-amber-600">−{fmt(tx.discount)}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center">
                      <span className="inline-flex items-center rounded-[5px] border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        {pctOf(tx).toFixed(1)}%
                      </span>
                    </td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-600">{(tx.date || "").slice(0, 10)}</td>
                    <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-600">{tx.branch_name || "—"}</td>
                    <td className="rounded-r-[5px] border-y border-r border-slate-200 bg-white px-3 py-2 text-center">
                      {/* The arrow into the payment: Send for approval or Undo, and the
                          receipt, are in there (PaymentDetails). */}
                      <OpenArrow onClick={() => onOpen([tx], txHead(tx))} testid={`discount-detail-open-${tx.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// One row per client, not one per collection. A lead who paid a consultation fee, then a
// session package, then rehab arrived here as three rows that read as three different
// people on the one page whose job is "who has paid us what". The money is the client's,
// so the row is the client's, with the collections behind it folded underneath and opened
// on demand — nothing is dropped, it is only stacked.
//
// Money with no lead behind it — a counter sale, a Zumba or Fitness registration — carries
// no lead_id at all (see the store/zumba/fitness loops in v3_finance.py's revenue-overview),
// so it keys on its own record and stays the single row it has always been rather than
// collapsing a day of counter sales into one client called "Counter sale". An old client's
// instalments have no lead either, but they are one person's, so they gather under the old
// client they were paid against.
const groupPaymentsByClient = (rows) => {
  const acc = new Map();
  rows.forEach((tx, i) => {
    const key = tx.lead_id || (tx.old_client_id ? `old:${tx.old_client_id}` : `txn:${tx.id || i}`);
    let g = acc.get(key);
    if (!g) {
      g = {
        key,
        lead_id: tx.lead_id || "",
        old_client: Boolean(tx.old_client),
        client_name: tx.client_name || "Unknown",
        phone: "",
        total: 0,
        payments: [],
        sources: [],
        modes: [],
        branches: [],
      };
      acc.set(key, g);
    }
    g.total += Number(tx.gross) || 0;
    g.payments.push(tx);
    if (!g.phone && tx.phone) g.phone = tx.phone;
    // Distinct, in the order they were met: one client can pay for three things three
    // ways across two branches, and the collapsed row has to say so without printing
    // "Cash" once per collection.
    if (tx.source && !g.sources.includes(tx.source)) g.sources.push(tx.source);
    // Each way the money actually came in, so a split contributes Cash and UPI to the
    // collapsed row rather than a mode nobody can bank.
    modesOf(tx).forEach((m) => { if (!g.modes.includes(m)) g.modes.push(m); });
    if (tx.branch_name && !g.branches.includes(tx.branch_name)) g.branches.push(tx.branch_name);
  });
  return [...acc.values()]
    .map((g) => {
      const payments = [...g.payments].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      return { ...g, payments, latest: payments[0]?.date || "", oldest: payments[payments.length - 1]?.date || "" };
    })
    // A client sits where their newest collection puts them — the same newest-first order
    // the ungrouped list arrived in, which is the order a day's takings are read in.
    .sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
};

const dayOf = (d) => (d || "").slice(0, 10);

/** Marks a row as an old client's -- a course from the old Physio Tracker, paid off here. */
const OldClientTag = () => (
  <span className="ml-1.5 inline-flex items-center rounded-[5px] border border-indigo-200 bg-indigo-50 px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-indigo-700">
    Old client
  </span>
);
// Two of anything is what these columns hold; the rest are one click away with a row each,
// so the collapsed cell counts them rather than wrapping to four lines.
const firstTwo = (list) => ({ shown: list.slice(0, 2), extra: Math.max(0, list.length - 2) });

/**
 * @param onOpen  Opens a row's PaymentDetails: a client's folded row opens all of their
 *              payments, a payment's own row just that one.
 * @param verify  Whether this is the branch desk's copy, which heads the arrow's column
 *              Action rather than View -- Send and Undo are in what it opens.
 */
const RevenueDetailTable = ({ rows, onOpen, verify = null }) => {
  const groups = useMemo(() => groupPaymentsByClient(rows), [rows]);
  // Keyed by group, so narrowing the list above leaves stale keys behind harmlessly
  // rather than opening the wrong client.
  const [open, setOpen] = useState(() => new Set());

  const expandable = useMemo(() => groups.filter((g) => g.payments.length > 1), [groups]);
  const allOpen = expandable.length > 0 && expandable.every((g) => open.has(g.key));

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(expandable.map((g) => g.key)));

  return (
    <Card className="overflow-hidden" data-testid="accountant-manage-revenue-detail">
      <CardContent className="p-0">
        {/* No title or counts bar: the table's own column header is the top of the card.
            Expand all only appears when some client actually has several payments. */}
        {expandable.length > 0 && (
          <div className="flex justify-end border-b border-slate-100 px-3 py-2">
            <button
              type="button"
              onClick={toggleAll}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-600"
              data-testid="revenue-detail-toggle-all"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}

        {/* Cards on a phone. Ten columns behind a 52rem scroll means every one of them is
            off-screen except the first two, and a transaction is only useful read whole —
            who paid, how much, by what, when. The collections are listed inside the card
            rather than behind an expander: a phone row is already a block, and one line
            per payment is cheaper than a tap. */}
        <div className="space-y-2 p-3 md:hidden" data-testid="revenue-detail-mobile">
          {groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">No transactions yet.</p>
          ) : groups.map((g, i) => (
            <div
              key={g.key}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(g.payments, groupHead(g))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(g.payments, groupHead(g)); }
              }}
              className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 active:bg-slate-50"
              data-testid={`revenue-detail-card-${g.key}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-800">
                    <span className="mr-1.5 font-normal text-slate-400">{i + 1}.</span>
                    {g.client_name}
                    {g.old_client && <OldClientTag />}
                  </p>
                  <p className="truncate text-xs text-slate-500">{g.phone || "—"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold text-emerald-600">{fmt(g.total)}</p>
                  {g.payments.length > 1 && (
                    <p className="text-[10px] text-slate-400">{countLabel(g.payments.length, "payment")}</p>
                  )}
                </div>
              </div>
              <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                {g.payments.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <span className="capitalize">{p.source}</span>
                    <PaymentModes tx={p} />
                    <span>{dayOf(p.date)}</span>
                    {g.payments.length > 1 && <span className="ml-auto font-semibold text-slate-600">{fmt(p.gross)}</span>}
                  </div>
                ))}
                {g.branches.length > 0 && (
                  <p className="truncate pt-0.5 text-[11px] text-slate-400">{g.branches.join(" · ")}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 90%, the list view only. zoom rather than transform: scale, so the box itself
            shrinks and the card doesn't keep the full-size height around it. */}
        <div className="hidden overflow-x-auto md:block" style={{ zoom: 0.9 }}>
          {/* table-fixed at w-full squeezes ten columns into a phone's width rather than
              letting the wrapper scroll — the min-width is what makes it scroll instead. */}
          {/* Flat rows with a hairline between them, under the same slate-500 header the
              branch lead list uses. */}
          <table className="w-full min-w-[52rem] table-fixed border-collapse text-sm">
            <thead className="bg-slate-500 text-[11px] font-semibold uppercase tracking-wide text-white">
              <tr>
                <th className="w-[4%] px-3 py-2.5 text-center">S.No</th>
                <th className="w-[14%] px-3 py-2.5 text-left">Client</th>
                <th className="w-[13%] px-3 py-2.5 text-center">Transaction ID</th>
                <th className="w-[12%] px-3 py-2.5 text-center">Consultation/Session</th>
                <th className="w-[11%] px-3 py-2.5 text-center">Phone</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Paid Amount</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Payment Mode</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Date</th>
                <th className="w-[9%] px-3 py-2.5 text-center">Branch</th>
                {/* Action where the desk can move the row, View where it can only open it. */}
                <th className="w-[7%] px-3 py-2.5 text-center">{verify ? "Action" : "View"}</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-slate-400">No transactions yet.</td></tr>
              ) : groups.map((g, i) => {
                const many = g.payments.length > 1;
                const isOpen = open.has(g.key);
                const sources = firstTwo(g.sources);
                const modes = firstTwo(g.modes);
                const spansDays = dayOf(g.latest) !== dayOf(g.oldest);
                return [
                  <tr
                    key={g.key}
                    // A client with several payments folds open on a click; with one, the
                    // row is that payment and opens it, as its arrow does.
                    onClick={many ? () => toggle(g.key) : () => onOpen(g.payments, groupHead(g))}
                    className="cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50"
                    data-testid={`revenue-detail-row-${g.key}`}
                  >
                    <td className="px-3 py-2.5 text-center text-slate-400">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">
                      {g.client_name}
                      {g.old_client && <OldClientTag />}
                      {many && (
                        <span className="block text-[10px] font-normal text-slate-400">{countLabel(g.payments.length, "payment")}</span>
                      )}
                    </td>
                    {/* One collection still shows its own id. Several cannot, so the cell
                        becomes the way into them instead and each id gets its own row
                        underneath. Blank for collections taken before transaction ids
                        existed — those rows are real money and must still list, so this
                        shows a dash rather than being filtered out. */}
                    <td className="px-3 py-2.5 text-center">
                      {many ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggle(g.key); }}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-600"
                          data-testid={`revenue-detail-expand-${g.key}`}
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {countLabel(g.payments.length, "payment")}
                        </button>
                      ) : g.payments[0]?.transaction_id ? (
                        <span className="font-mono text-[11px] text-slate-700" title={g.payments[0].transaction_id}>{g.payments[0].transaction_id}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-600">
                      {sources.shown.map(titleCase).join(" · ") || "—"}
                      {sources.extra > 0 && <span className="text-slate-400"> +{sources.extra}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-600">{g.phone || "—"}</td>
                    <td className="px-3 py-2.5 text-center font-semibold text-emerald-600">{fmt(g.total)}</td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {g.modes.length === 0
                          ? <PaymentModeBadge mode="" />
                          : modes.shown.map((m) => <PaymentModeBadge key={m} mode={m} />)}
                        {modes.extra > 0 && <span className="text-[10px] text-slate-400">+{modes.extra}</span>}
                      </div>
                    </td>
                    {/* The newest collection dates the row; a client whose payments span
                        days says so underneath rather than reading as if they all landed
                        on the one date. */}
                    <td className="px-3 py-2.5 text-center text-slate-600">
                      {dayOf(g.latest) || "—"}
                      {spansDays && <span className="block text-[10px] text-slate-400">since {dayOf(g.oldest)}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-600">
                      {g.branches[0] || "—"}
                      {g.branches.length > 1 && <span className="text-slate-400"> +{g.branches.length - 1}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {/* The one control on the row: into the client's payments, where Send
                          for approval, Undo and each receipt are (PaymentDetails). */}
                      <OpenArrow onClick={() => onOpen(g.payments, groupHead(g))} testid={`revenue-detail-open-${g.key}`} />
                    </td>
                  </tr>,
                  // Each collection exactly as it listed before, minus the client identity
                  // the row above already carries.
                  ...(many && isOpen ? g.payments.map((p) => (
                    <tr key={`${g.key}-${p.id}`} className="border-b border-slate-100 bg-slate-50" data-testid={`revenue-detail-payment-${p.id}`}>
                      <td className="border-l-2 border-l-sky-300 px-3 py-1.5" />
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-center">
                        {p.transaction_id
                          ? <span className="font-mono text-[11px] text-slate-600" title={p.transaction_id}>{p.transaction_id}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center capitalize text-slate-600">{p.source}</td>
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-center font-semibold text-emerald-600">{fmt(p.gross)}</td>
                      <td className="px-3 py-1.5 text-center"><PaymentModes tx={p} /></td>
                      <td className="px-3 py-1.5 text-center text-slate-600">{dayOf(p.date)}</td>
                      <td className="px-3 py-1.5 text-center text-slate-600">{p.branch_name || "—"}</td>
                      {/* Each payment is a collection in its own right, so it opens on its own. */}
                      <td className="px-3 py-1.5 text-center">
                        <OpenArrow onClick={() => onOpen([p], groupHead(g))} compact testid={`revenue-detail-open-${p.id}`} />
                      </td>
                    </tr>
                  )) : []),
                ];
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};

const STAGE_BADGE = {
  collected: { label: "To Verify", className: "border-indigo-200 bg-indigo-50 text-indigo-700" },
  requested: { label: "Awaiting Approval", className: "border-amber-200 bg-amber-50 text-amber-700" },
  approved: { label: "Approved", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

/** Where one payment stands, in words: who did the last thing to it. */
const stageLine = (t) => {
  const stage = stageOf(t);
  if (stage === "approved") return `Approved by ${t.approved_by || "the accountant"}`;
  if (stage === "requested") return `Sent to the accountant${t.income_requested_by ? ` by ${t.income_requested_by}` : ""}`;
  return `Collected${t.collected_by ? ` by ${t.collected_by}` : ""} · not yet verified`;
};

/**
 * A ledger row opened by its arrow: every payment behind it, and what can be done to each.
 *
 * Send for approval and Undo (the branch desk's, `verify`), and the receipt, live here
 * rather than as a row of icons on every line of the table. Each payment says which pile it
 * is in and who put it there; a client with several in one pile can send or take back all
 * of them at once. Client history opens the client's own card, for a row that has a client.
 *
 * Portalled at the client card's own level (z-50), so the receipt (z-80) opens over it and
 * the desk comes back to this when the receipt is shut.
 */
const PaymentDetails = ({ head, payments, verify, onReceipt, onClientHistory, onClose }) => {
  const total = payments.reduce((n, t) => n + (Number(t.gross) || 0), 0);
  const toVerify = payments.filter((t) => stageOf(t) === "collected");
  const waiting = payments.filter((t) => stageOf(t) === "requested");
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="payment-details-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-details-name"
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h3 id="payment-details-name" className="truncate text-lg font-bold text-slate-900">
              {head.client_name || "Unknown"}
              {head.old_client && <OldClientTag />}
            </h3>
            <p className="mt-0.5 truncate text-sm text-slate-600">{[head.phone, head.branch].filter(Boolean).join(" · ") || "—"}</p>
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <div className="text-right">
              <p className="font-mono text-base font-bold tabular-nums text-emerald-600" data-testid="payment-details-total">{fmt(total)}</p>
              <p className="text-[11px] text-slate-500">{countLabel(payments.length, "payment")}</p>
            </div>
            <button
              type="button" onClick={onClose} title="Close" aria-label="Close"
              className="-mr-1.5 flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              data-testid="payment-details-close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-4 py-3">
          {verify && (toVerify.length > 1 || waiting.length > 1) && (
            <div className="flex flex-wrap justify-end gap-2" data-testid="payment-details-all">
              {toVerify.length > 1 && <MoveChip txs={toVerify} verify={verify} label={`Send all ${toVerify.length} for approval`} />}
              {waiting.length > 1 && <MoveChip txs={waiting} verify={verify} label={`Undo all ${waiting.length}`} />}
            </div>
          )}
          {payments.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">These payments are no longer on the list.</p>
          ) : payments.map((t) => {
            const stage = stageOf(t);
            const badge = STAGE_BADGE[stage];
            const off = Number(t.discount) || 0;
            const canMove = verify && stage !== "approved";
            return (
              <div key={t.id} className="rounded-lg border border-slate-200 bg-white px-3.5 py-3" data-testid={`payment-details-row-${t.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">
                      {RECEIPT_PAID_FOR[t.source] || titleCase(t.source || "")}
                      {t.instalment_number ? ` · Instalment #${t.instalment_number}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                      <span>{dayOf(t.date) || "—"}</span>
                      <PaymentModes tx={t} />
                      {t.transaction_id && <span className="font-mono text-[11px] text-slate-500">{t.transaction_id}</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-sm font-bold tabular-nums text-slate-900">{fmt(t.gross)}</p>
                    <span className={`mt-1 inline-flex rounded-[5px] border px-1.5 py-px text-[10px] font-semibold ${badge.className}`} data-testid={`payment-details-stage-${t.id}`}>
                      {badge.label}
                    </span>
                  </div>
                </div>
                {off > 0 && (
                  <p className="mt-1.5 text-[11px] text-amber-700">
                    Listed {fmt(Number(t.original_amount) || (Number(t.gross) || 0) + off)} · {fmt(off)} off
                  </p>
                )}
                <p className="mt-1 text-[11px] text-slate-500">{stageLine(t)}</p>
                {(canMove || t.transaction_id) && (
                  <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-2.5">
                    {canMove && <MoveChip txs={[t]} verify={verify} />}
                    {/* Only where the collection has a transaction id. Rows taken before
                        ids existed are real money and still list, but a receipt with no
                        number on it proves nothing. */}
                    {t.transaction_id && (
                      <button
                        type="button"
                        onClick={() => onReceipt(t)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        title="Receipt — print, send or download it again"
                        data-testid={`payment-details-receipt-${t.id}`}
                      >
                        <Receipt className="h-3.5 w-3.5" /> Receipt
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 py-2.5">
          {head.lead_id && onClientHistory && (
            <button
              type="button"
              onClick={() => onClientHistory(head.lead_id)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
              data-testid="payment-details-client"
            >
              Client history <ChevronRight className="h-4 w-4" />
            </button>
          )}
          <button
            type="button" onClick={onClose}
            className="ml-auto rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            data-testid="payment-details-footer-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AccountantManageTab;
