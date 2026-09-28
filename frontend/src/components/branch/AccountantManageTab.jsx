import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, Receipt, Wallet, Stethoscope, Activity, ShoppingBag, Salad, RefreshCw, Music2, HeartPulse, Dumbbell, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { toast } from "@/components/ui/sonner";
import { BranchExpensesPanel } from "@/components/branch/BranchExpensesPanel";
import { FinanceDateFilter } from "@/components/finance/FinanceDateFilter";
import { rangeFor } from "@/lib/dateRange";
import { getBranches, getRevenueOverview, getFinanceExpenses, getBranchCash } from "@/lib/api";
import { ClientHistoryModal } from "@/components/branch/ClientHistoryModal";
import { ReceiptDialog } from "@/components/ReceiptDialog";
import { receiptFromTransaction } from "@/lib/receipt";
import { OutstandingAmountBoard } from "@/components/branch/OutstandingAmountBoard";
import { ClosingBalancePanel } from "@/components/branch/ClosingBalancePanel";
import { CloseBookHistoryPanel } from "@/components/branch/CloseBookHistoryPanel";

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

const mainTabClasses = (tab, active) => {
  if (tab.tone === "discount") {
    return active ? "bg-amber-600 text-white shadow-sm" : "text-amber-700 hover:bg-amber-50";
  }
  if (tab.tone === "closing") {
    return active ? "bg-emerald-600 text-white shadow-sm" : "text-emerald-700 hover:bg-emerald-50";
  }
  return active ? "bg-sky-50 text-sky-700" : "text-slate-600 hover:bg-slate-50";
};

// Money in and money out — the first thing this tab is asked, and the two do not belong
// in one list. What replaced: three chips splitting collections by sign-off, which said
// the same thing three times over (every collection is pending until the Accountant's own
// Approvals tab signs it off, so Collected and Pending read identically on any branch
// that has not been through it, as Rs.4,96,594 and Rs.4,96,594 did here).
const LEDGER_VIEWS = [
  { key: "income", label: "Income" },
  // The drawer between money in and money out: what the branch should be holding now.
  { key: "cash", label: "Cash In Hand" },
  { key: "expenses", label: "Expenses" },
];

/**
 * Where a collection stands between the desk that took it and the books.
 *
 * Two, not three. There used to be a "Collected" pile between them — money taken at the
 * desk that the branch had not yet pressed "Send to accountant" on — but that step gated
 * nothing: the accountant's Approvals queue always showed every unapproved collection
 * whether it had been "sent" or not. So the moment a collection is taken it is awaiting
 * approval, and the branch has one less thing to remember at the end of a day.
 *
 * `all` is not one of them on purpose. Every row is in exactly one of these two, so a
 * third pill showing both at once would be a total that no one is responsible for.
 */
// Tones match the expense pills for the same two states -- amber for waiting on somebody,
// emerald for signed off -- so a branch reading Income after Expenses reads the same
// colours for the same thing.
const INCOME_STAGES = [
  { key: "requested", label: "Awaiting Approval", hint: "Taken at the desk, waiting for the accountant to sign it off",
    tone: { dot: "bg-amber-500", border: "border-amber-200", bg: "bg-amber-50/70", text: "text-amber-700", sub: "text-amber-600/80", ring: "#d97706" } },
  { key: "approved", label: "Income Approved", hint: "Signed off by the accountant",
    tone: { dot: "bg-emerald-500", border: "border-emerald-200", bg: "bg-emerald-50/70", text: "text-emerald-700", sub: "text-emerald-600/80", ring: "#059669" } },
];

/** Which of the two one collection is in. Everything not yet signed off is awaiting it. */
const stageOf = (tx) => (tx?.approved ? "approved" : "requested");

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
  store: "Store Purchase",
  zumba: "Zumba Registration",
  fitness: "Fitness Membership",
};

/** One ledger row as a receipt. Named here rather than inside receiptFromTransaction
 *  because the source vocabulary is this desk's, not the receipt's. */
const receiptForTxn = (tx) => receiptFromTransaction({
  ...tx,
  paidFor: RECEIPT_PAID_FOR[tx.source] || titleCase(tx.source || ""),
});

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

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const countLabel = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The revenue row's own card. StatTile is the house figure card and stays the house
 * figure card everywhere else; this row is the one place eight of them stand side by
 * side, and eight cards each carrying a coloured disc behind a coloured number is eight
 * things competing to be read first.
 *
 * So the colour moves off the number and onto one chip holding the icon: the category is
 * told apart at a glance, and every figure on the row is told in one weight and one
 * colour, whichever card is picked. A number that changes colour when its card is
 * pressed reads as a different number.
 *
 * Which card is picked is then said three quiet ways rather than one loud one: the chip
 * fills in solid, a hairline accent sits on the card's bottom edge, and the card lifts on
 * a neutral ring. A coloured ring drawn all the way round turns the card into a box with
 * a border, and eight cards with one of them boxed is a form control, not a dashboard.
 *
 * All eight are the same card at the same size, the total included. It was drawn larger
 * for a while, on the reasoning that a sum is not a category; what that actually did was
 * break the row into a headline and seven footnotes, when what a branch reads here is one
 * line of figures across. Rank is carried by the total standing first, which is enough.
 *
 * `muted` greys a figure of nothing -- Rs.0 still says the desk was open and took
 * nothing, which is worth showing and not worth reading first.
 *
 * Colours are inline styles off one hex per card for the same reason StatTile's are:
 * Tailwind reads class names out of the source, so a class name assembled at runtime
 * compiles to nothing.
 */
const RevenueTile = ({ label, value, sub, color, active, muted, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    data-testid={testid}
    className={`group relative flex h-full w-full flex-col overflow-hidden rounded-[2px] border border-slate-200 p-3 text-left transition-all duration-150 sm:p-3.5 ${
      active
        ? "shadow-[0_4px_14px_-4px_rgba(16,24,40,0.16)]"
        : "bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:bg-slate-50/60"
    }`}
    style={active ? { borderColor: color, backgroundColor: `${color}14` } : undefined}
  >
    <div className="flex w-full items-start gap-2">
      <div className="min-w-0 flex-1">
        {/* Sentence case at a normal weight rather than bold small caps: eight headings
            shouting is what made the old row hard to read past. The picked one darkens
            instead of changing colour. */}
        <p className={`truncate text-[11px] transition-colors sm:text-xs ${active ? "font-semibold text-slate-900" : "font-medium text-slate-500"}`}>{label}</p>
        {/* tabular-nums so eight figures standing side by side line up on their digits
            instead of jittering with whatever numerals each one happens to hold. */}
        <p className={`mt-1 text-base font-semibold tabular-nums tracking-tight sm:text-[18px] sm:leading-6 ${
          muted && !active ? "text-slate-400" : "text-slate-900"
        }`}>{value}</p>
        <p className="mt-0.5 truncate text-[10px] leading-tight text-slate-400 sm:text-[11px]">{sub}</p>
      </div>
    </div>
  </button>
);

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
  // Which of the three piles the income side is showing. Opens on Collected because that
  // is the one with something to do in it -- except where only signed-off money counts,
  // which fixes it on Approved and never moves it again.
  const [incomeStage, setIncomeStage] = useState(approvedOnly ? "approved" : "requested");
  const [expenseTotals, setExpenseTotals] = useState({ approved_total: 0, approved_count: 0, pending_count: 0 });
  // One branch's drawer, or every opened branch's added up where no branch is picked.
  const [cashInHand, setCashInHand] = useState(0);
  const [paymentModeFilter, setPaymentModeFilter] = useState("all");
  // Which side of the business the income summary is counting, where this board owns
  // the pills for it. "all" means no filter, same as a caller leaving `mode` unset.
  const [verticalMode, setVerticalMode] = useState("all");
  const [revenueView, setRevenueView] = useState("collected");
  const [preset, setPreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewingLeadId, setViewingLeadId] = useState(null);
  // The receipt for one collection on the ledger, reissued from the desk that keeps it.
  // The eye beside it opens the client; this opens the piece of paper.
  const [receipt, setReceipt] = useState(null);

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
  // out, takes no date range yet, and a branch with no expenses should not stop the eight
  // revenue cards rendering. Scoped to the same branch the revenue call is, though — the
  // expense tile sits in the same row as the income tiles, and one of them counting every
  // branch while the others counted the picked one is two scopes in one row of figures.
  const loadExpenseTotals = useCallback(() => {
    getFinanceExpenses(branchId ? { branch_id: branchId } : {})
      .then((d) => setExpenseTotals({
        approved_total: d.approved_total || 0,
        approved_count: d.approved_count || 0,
        pending_count: d.pending_count || 0,
      }))
      .catch(() => { /* the card falls back to zero; the panel says why when opened */ });
    getBranchCash(branchId ? { branch_id: branchId } : {})
      .then((d) => setCashInHand((d?.by_branch ? d.total?.cash_in_hand : d?.cash_in_hand) || 0))
      .catch(() => setCashInHand(0));
  }, [branchId]);

  useEffect(() => { loadExpenseTotals(); }, [loadExpenseTotals]);

  const k = data?.kpis || {};
  // `data?.x || []` builds a fresh array on every render, so every memo keyed on one was
  // re-running each time and memoising nothing. Held steady here instead.
  const transactions = useMemo(() => data?.transactions || [], [data]);
  const outstanding = useMemo(() => data?.outstanding_clients || [], [data]);

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

  // The scope chip that read all of this back in words is gone with the header it sat in.
  // It described the branch select and the range row directly beneath it, both of which say
  // what they are set to on their own faces, so it was a third control's worth of screen
  // spent repeating two.

  // The range and Refresh. Hidden on Closing Balance and Close Books, which carry their
  // own Daily/Weekly/Monthly control over which evenings are counted -- two date controls
  // over one set of figures would leave the desk asking which is in force.
  const dateControls = tab !== "closing" && tab !== "closebooks" ? (
    <div className={`flex shrink-0 flex-nowrap items-center gap-2 ${toolbarTarget ? "" : "ml-auto"}`} data-testid="accountant-manage-date-filter">
      <FinanceDateFilter
        preset={preset}
        customFrom={customFrom}
        customTo={customTo}
        onChange={pickDates}
        presets={DATE_PRESETS}
        variant="inline"
        filterIcon
        testid="accountant-manage-window"
      />
      <Button
        onClick={() => { load(); loadExpenseTotals(); }}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        data-testid="accountant-manage-refresh"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  ) : null;

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

          flex-nowrap, and the only scroll container on this line. Wrapping put the range on
          a second row under the tabs, which is a second band of controls above the figures
          and moves the whole page down whenever the row is one button too wide. Everything
          in here is shrink-0 and gives back padding rather than width under 1900px, so on any
          ordinary desk it simply fits; a phone scrolls this one strip sideways instead.

          Under 1900px, not under 2xl. The full-size type and padding were taken back at
          1536px, some 240px before this row had the width for them, so every laptop
          between the two grew the branch select, five tab names and six windows past the
          right edge at once -- and since this strip hides its scrollbar, what that looked
          like was a Custom Range button sliced down the middle and no Refresh at all. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm" data-testid="accountant-manage-maintabs">
        {!fixedBranchId && !scoped && (
          <div className="flex shrink-0 items-center gap-2 border-r border-slate-200 pl-1.5 pr-2 min-[1900px]:pr-3">
            <label htmlFor="accountant-manage-branch" className="text-xs font-medium text-slate-600">Branch:</label>
            <select
              id="accountant-manage-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="h-10 rounded-md border border-slate-200 px-2 text-xs text-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 min-[1900px]:text-sm"
              data-testid="accountant-manage-branch-select"
            >
              <option value="">All Branches</option>
              {branches.map((br) => <option key={br.id} value={br.id}>{br.branch_name}</option>)}
            </select>
          </div>
        )}
        <div className="flex shrink-0 flex-nowrap gap-1 min-[1900px]:gap-1.5">
          {MAIN_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`h-10 shrink-0 whitespace-nowrap rounded-md px-2 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 min-[1900px]:px-3.5 min-[1900px]:text-sm ${mainTabClasses(t, tab === t.key)}`}
              data-testid={`accountant-manage-maintab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* How the figures are narrowed, on the Summary page only: which side of the
            business, then how the money came in. In this row rather than a strip of their
            own, so the board keeps to one bar under the page's tabs. */}
        {tab === "summary" && (
          <>
            {verticalModeFilter && (
              <div className="flex shrink-0 flex-nowrap items-center gap-2 border-l border-slate-200 pl-2" data-testid="accountant-manage-vertical-mode-filter">
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
            <div className="flex shrink-0 flex-nowrap items-center gap-2 border-l border-slate-200 pl-2" data-testid="accountant-manage-payment-mode-filter">
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
          {/* The one question this tab opens on: money in, or money out. Two cards
              rather than a segmented pill, because the choice carries its own figure —
              a switch that also says what is on each side of it, in the shape the cards
              below it already use.

              Green for money in and rose for money out: the colours the Total Revenue
              tile and the Accountant's own Total Expense card were already wearing, so a
              figure does not change colour depending on which screen it is read on. The
              picked one takes a 1px outline in its colour and the others step back to
              70% — 2px corners, like the rest of the summary cards. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="accountant-manage-ledger-filter">
            {LEDGER_VIEWS.map((v) => {
              const on = ledger === v.key;
              const tone = {
                income: { ring: "#059669", border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-700" },
                cash: { ring: "#0284c7", border: "border-sky-200", bg: "bg-sky-50/60", text: cashInHand < 0 ? "text-rose-700" : "text-sky-700" },
                expenses: { ring: "#e11d48", border: "border-rose-200", bg: "bg-rose-50/60", text: "text-rose-700" },
              }[v.key];
              const value = {
                income: sums.totals.collected,
                cash: cashInHand,
                expenses: expenseTotals.approved_total,
              }[v.key];
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setLedger(v.key)}
                  aria-pressed={on}
                  className={`rounded-[2px] border ${tone.border} ${tone.bg} p-4 text-left transition ${on ? "" : "opacity-70 hover:opacity-100"}`}
                  style={on ? { borderColor: tone.ring } : undefined}
                  data-testid={`accountant-manage-ledger-${v.key}`}
                >
                  <p className={`text-[11px] font-bold uppercase tracking-wider ${tone.text}`}>{v.label}</p>
                  <p className={`mt-1 text-2xl font-bold tabular-nums ${tone.text}`}>{fmt(value)}</p>
                </button>
              );
            })}
          </div>

          {/* Expenses is its own ledger, not a filter of this one: nothing above it —
              the revenue tiles, the source table, the payment-mode row — describes money
              going out, so the whole of the income side steps aside for it rather than
              being reused with different numbers in it. */}
          {ledger === "cash" && <BranchExpensesPanel section="cash" onChanged={loadExpenseTotals} branchId={branchId} />}
          {ledger === "expenses" && <BranchExpensesPanel section="expenses" onChanged={loadExpenseTotals} branchId={branchId} />}

          {ledger === "income" && (
          <>
          {/* The two piles. Above the revenue tiles because it scopes them: the eight
              figures below are the picked pile's, not the day's. */}
          <div className="flex flex-wrap items-center gap-2" data-testid="accountant-manage-income-stages">
            {/* Each pile says what it holds, not just how many rows -- the same pills the
                expense side shows, for the same reason: what is waiting on a signature and
                what has been signed off are figures a branch used to have to press through
                to add up.

                Where the piles can be moved between they are the filter they always were:
                the picked one is ringed and the other steps back rather than switching
                off. Where only signed-off money counts there is nothing to pick, so they
                are plain figures at full strength. */}
            <div className="flex flex-wrap items-center gap-2">
              {INCOME_STAGES.map((st) => {
                const pile = stagePiles[st.key];
                const picked = !approvedOnly && incomeStage === st.key;
                const Pill = approvedOnly ? "span" : "button";
                return (
                  <Pill
                    key={st.key}
                    type={approvedOnly ? undefined : "button"}
                    title={st.hint}
                    onClick={approvedOnly ? undefined : () => setIncomeStage(st.key)}
                    aria-pressed={approvedOnly ? undefined : picked}
                    className={`inline-flex items-center gap-2 rounded-[2px] border ${st.tone.border} ${st.tone.bg} py-1.5 pl-3 pr-4 ${
                      approvedOnly ? "" : `transition ${picked ? "" : "opacity-60 hover:opacity-100"}`
                    }`}
                    style={picked ? { boxShadow: `0 0 0 2px ${st.tone.ring}` } : undefined}
                    data-testid={`accountant-manage-income-stage-${st.key}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.tone.dot}`} />
                    <span className={`text-[11px] font-bold uppercase tracking-wider ${st.tone.text}`}>{st.label}</span>
                    <span className={`text-sm font-bold tabular-nums ${st.tone.text}`}>{fmt(pile.total)}</span>
                    <span className={`text-[11px] ${st.tone.sub}`}>· {countLabel(pile.count, "payment")}</span>
                  </Pill>
                );
              })}
            </div>

            {/* No "Send to accountant" button any more: a collection is awaiting approval
                the moment it is taken, and the accountant's Approvals queue picks it up
                without the branch pressing anything. */}
          </div>

          {/* All eight on one line where there is room for eight, stepping down to four
              and then two rather than squeezing: at lg an eighth of the width is narrower
              than the card's own text column.

              Total stands in the line rather than above it. It is the sum of the seven
              beside it and could be argued into a card of its own -- it had one for a
              while -- but a row read across wants one card repeated, and drawing one of
              them bigger turned the other seven into its footnotes. */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3 xl:grid-cols-8">
            {REVENUE_VIEWS.map((v) => (
              <RevenueTile
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
            onView={setViewingLeadId}
            onReceipt={(tx) => setReceipt(receiptForTxn(tx))}
          />
          </>
          )}
        </div>
      ) : tab === "schedule" ? (
        <OutstandingAmountBoard rows={outstanding} onView={setViewingLeadId} onChanged={load} />
      ) : tab === "closebooks" ? (
        // Reads a month of signed-off days and nothing else, so it takes the branch from
        // up here and picks its own month -- see the panel.
        <CloseBookHistoryPanel branchId={branchId} />
      ) : tab === "closing" ? (
        // Counts one evening at a time and reads a week or a month of them back, on its
        // own period control rather than the tab's range -- see the panel. The branch is
        // the only thing it takes from up here.
        <ClosingBalancePanel branchId={branchId} />
      ) : (
        <DiscountAppliedBoard rows={discountedTxns} onView={setViewingLeadId} onReceipt={(tx) => setReceipt(receiptForTxn(tx))} />
      )}

      {/* The Custom Range dialog moved into FinanceDateFilter, which opens it from the row
          above — one dialog for the four finance pages instead of a copy per page. */}

      {viewingLeadId && <ClientHistoryModal leadId={viewingLeadId} onClose={() => setViewingLeadId(null)} onChanged={load} />}
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
const DiscountAppliedBoard = ({ rows, onView, onReceipt }) => {
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
                role={onView ? "button" : undefined}
                tabIndex={onView ? 0 : undefined}
                onClick={() => onView && onView(tx.lead_id)}
                onKeyDown={(e) => { if (onView && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onView(tx.lead_id); } }}
                className={`rounded-xl border border-slate-200 bg-white p-3 ${onView ? "cursor-pointer active:bg-slate-50" : ""}`}
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
                  {onView && <Eye className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-300" />}
                </div>
              </div>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[56rem] table-fixed border-separate border-spacing-x-0 border-spacing-y-2 text-sm">
              <thead>
                <tr>
                  <th className="w-[4%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">S.No</th>
                  <th className="w-[16%] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Client</th>
                  <th className="w-[11%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Phone</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Paid For</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Listed Price</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Collected</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Discount</th>
                  <th className="w-[8%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">%</th>
                  <th className="w-[9%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Date</th>
                  <th className="w-[12%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Branch</th>
                  <th className="w-[7%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">View</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-sm text-slate-400">No discounted collections yet.</td></tr>
                ) : visible.map((tx, i) => (
                  <tr key={tx.id} data-testid={`discount-detail-row-${tx.id}`}>
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
                      {/* Two things a row can be opened for, and they are not the same
                          thing: the eye opens the client behind the money, the receipt
                          opens the money itself. This column carried only the first, so
                          a desk asked for a copy of a bill had to open the client, find
                          the fee and reissue it from there — or, before the fee cards
                          could reissue at all, could not produce one. */}
                      <div className="flex items-center justify-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => onView && onView(tx.lead_id)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-sky-600"
                          title="Open this client"
                          aria-label="Open this client"
                          data-testid={`discount-detail-view-${tx.id}`}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {/* Only where the collection has a transaction id. Rows taken
                            before ids existed are real money and still list, but a
                            receipt with no number on it proves nothing. */}
                        {onReceipt && tx.transaction_id && (
                          <button
                            type="button"
                            onClick={() => onReceipt(tx)}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"
                            title="Receipt — print, send or download it again"
                            aria-label="Receipt"
                            data-testid={`discount-detail-receipt-${tx.id}`}
                          >
                            <Receipt className="h-4 w-4" />
                          </button>
                        )}
                      </div>
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
// collapsing a day of counter sales into one client called "Counter sale".
const groupPaymentsByClient = (rows) => {
  const acc = new Map();
  rows.forEach((tx, i) => {
    const key = tx.lead_id || `txn:${tx.id || i}`;
    let g = acc.get(key);
    if (!g) {
      g = {
        key,
        lead_id: tx.lead_id || "",
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
// Two of anything is what these columns hold; the rest are one click away with a row each,
// so the collapsed cell counts them rather than wrapping to four lines.
const firstTwo = (list) => ({ shown: list.slice(0, 2), extra: Math.max(0, list.length - 2) });

const RevenueDetailTable = ({ rows, onView, onReceipt }) => {
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
              role={onView ? "button" : undefined}
              tabIndex={onView ? 0 : undefined}
              onClick={() => onView && onView(g.lead_id)}
              onKeyDown={(e) => {
                if (onView && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onView(g.lead_id); }
              }}
              className={`rounded-xl border border-slate-200 bg-white p-3 ${onView ? "cursor-pointer active:bg-slate-50" : ""}`}
              data-testid={`revenue-detail-card-${g.key}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-800">
                    <span className="mr-1.5 font-normal text-slate-400">{i + 1}.</span>
                    {g.client_name}
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
                <th className="w-[15%] px-3 py-2.5 text-left">Client</th>
                <th className="w-[14%] px-3 py-2.5 text-center">Transaction ID</th>
                <th className="w-[12%] px-3 py-2.5 text-center">Consultation/Session</th>
                <th className="w-[11%] px-3 py-2.5 text-center">Phone</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Paid Amount</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Payment Mode</th>
                <th className="w-[10%] px-3 py-2.5 text-center">Date</th>
                <th className="w-[9%] px-3 py-2.5 text-center">Branch</th>
                <th className="w-[5%] px-3 py-2.5 text-center">View</th>
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
                    onClick={many ? () => toggle(g.key) : undefined}
                    className={`border-b border-slate-100 transition-colors hover:bg-slate-50 ${many ? "cursor-pointer" : ""}`}
                    data-testid={`revenue-detail-row-${g.key}`}
                  >
                    <td className="px-3 py-2.5 text-center text-slate-400">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">
                      {g.client_name}
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
                      <div className="flex items-center justify-center gap-0.5">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); if (onView) onView(g.lead_id); }}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-sky-600"
                          title="Open this client"
                          aria-label="Open this client"
                          data-testid={`revenue-detail-view-${g.key}`}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {/* A receipt is one collection's, and this row is a client's. So
                            it appears here only where the client made exactly one payment
                            and the two are the same thing; a client with three gets a
                            receipt button on each of the three rows underneath instead,
                            because "the receipt" for that row would have to pick one of
                            them and there is no right answer. */}
                        {onReceipt && !many && g.payments[0]?.transaction_id && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onReceipt(g.payments[0]); }}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"
                            title="Receipt — print, send or download it again"
                            aria-label="Receipt"
                            data-testid={`revenue-detail-receipt-${g.key}`}
                          >
                            <Receipt className="h-4 w-4" />
                          </button>
                        )}
                      </div>
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
                      {/* The one cell on these sub-rows that is not blank. Each of them
                          is a collection in its own right, so each has its own receipt —
                          which is the whole reason the group row above declines to show
                          one. No client button here: the row above is that client. */}
                      <td className="px-3 py-1.5 text-center">
                        {onReceipt && p.transaction_id && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onReceipt(p); }}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"
                            title="Receipt — print, send or download it again"
                            aria-label="Receipt"
                            data-testid={`revenue-detail-receipt-${p.id}`}
                          >
                            <Receipt className="h-3.5 w-3.5" />
                          </button>
                        )}
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

export default AccountantManageTab;
