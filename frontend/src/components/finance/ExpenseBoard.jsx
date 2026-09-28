import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote, Check, Coins, CreditCard, FileText, Landmark, Plus, Receipt, Smartphone, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SummaryTile } from "@/components/ui/summary-tile";
import { toast } from "@/components/ui/sonner";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import {
  getBranches, getFinanceExpenses, createFinanceExpense, deleteFinanceExpense,
  approveFinanceExpense, rejectFinanceExpense, listVendors, createVendor,
} from "@/lib/api";
import { EXPENSE_PAYMENT_MODE_OPTIONS, PAYMENT_MODE_LABELS, PAYMENT_MODE_COLORS, orderedPaymentModeEntries } from "@/lib/paymentModes";
import { PETTY_CASH_LIMIT, PETTY_CASH_REASON_REQUIRED, isPettyCash } from "@/lib/pettyCash";
import { DENOMINATIONS, noteTotal, countedNotes, noteBreakdown, notesLabel } from "@/lib/denominations";
import { PettyCashPanel } from "@/components/finance/PettyCashPanel";
import { FinanceDateFilter } from "@/components/finance/FinanceDateFilter";
import { todayIso, rangeFor, rangeIncomplete } from "@/lib/dateRange";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN")}`;

// The copy this page kept of lib/dateRange's helpers is gone; it now takes them from
// there, which is where they were extracted to and which the window's own row already
// reads. `todayIso` is still wanted here for the date a new expense defaults to — that has
// to be the local day, not a UTC one, or an expense entered in the evening files itself
// under tomorrow.

const blankExpense = { category: "", amount: "", branch_id: "", note: "", expense_date: todayIso(), payment_mode: "cash", reference: "", vendor_id: "" };

/** The small uppercase caption every field in the Add Expense dialog carries — the same
 *  one the branch's own Add Expense uses, so the two forms read as one form. */
const FieldLabel = ({ children }) => (
  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</label>
);

/**
 * What each cashless tender is asked for, so the row carries something the payment can
 * actually be found by. All four land in the one `reference` field the record already
 * keeps and the list already prints — the tender beside it says which kind of number it
 * is, so four columns would be four ways of storing one answer.
 *
 * Cash is not here: notes have no reference to quote, so it is asked for the count
 * instead — see the denominations grid below.
 */
const REFERENCE_ASK = {
  upi: { label: "UPI ID", placeholder: "name@bank", missing: "Enter the UPI ID it was paid to" },
  card: { label: "Card Transaction ID", placeholder: "Terminal batch / txn no.", missing: "Enter the card transaction ID" },
  account_transfer: { label: "Transaction ID", placeholder: "Bank transaction ID / UTR", missing: "Enter the bank transaction ID" },
  cheque: { label: "Cheque Number", placeholder: "Cheque no.", missing: "Enter the cheque number" },
};

// SummaryTile colours its card off one hex rather than a class, so the tender colours live
// here as hex beside the class map every other reader of paymentModes.js uses. Same hues
// as PAYMENT_MODE_COLORS — emerald, amber, sky, violet, pink, slate — so a tile and a
// chip for the same tender are the same colour on the same screen.
const MODE_TILE = {
  cash: { color: "#059669", icon: Banknote },
  cheque: { color: "#d97706", icon: FileText },
  account_transfer: { color: "#0284c7", icon: Landmark },
  upi: { color: "#7c3aed", icon: Smartphone },
  card: { color: "#db2777", icon: CreditCard },
  unknown: { color: "#64748b", icon: Receipt },
};

/** Where a row stands with the person who signs it off. Three states, said in one chip
 *  rather than inferred from which buttons happen to be on the row. */
const StatusChip = ({ exp }) => {
  const [label, tone] = exp.rejected
    ? ["Rejected", "border-rose-200 bg-rose-50 text-rose-700"]
    : exp.approved
      ? ["Approved", "border-emerald-200 bg-emerald-50 text-emerald-700"]
      : ["Pending", "border-amber-200 bg-amber-50 text-amber-700"];
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>
      {label}
    </span>
  );
};

/** The tender a row was paid by, in the colour its tile carries above. */
const ModeChip = ({ mode }) => {
  const c = PAYMENT_MODE_COLORS[mode] || PAYMENT_MODE_COLORS.unknown;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${c.border} ${c.bg} ${c.text}`}>
      {PAYMENT_MODE_LABELS[mode] || PAYMENT_MODE_LABELS.unknown}
    </span>
  );
};

/** Rs.15,000 in a tin, marked because it changes what there is to approve against: rent
 *  arrives with an invoice, petty cash with a sentence somebody typed. */
const PettyChip = () => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
    <Coins className="h-2.5 w-2.5" /> Petty cash
  </span>
);

/**
 * Accountant > Expense — what went out, logged by hand (rent, salaries, supplies —
 * whatever category is typed). Feeds the Profit tab, which is Revenue less this same
 * list for the same window.
 *
 * Three controls narrow the list, and they are three different questions: when (the date
 * presets), whose (branch and vertical), and by what tender (the tiles, which are the
 * filter rather than a read-only summary). The tiles keep counting the whole window
 * whichever one is picked, so the row of them stays a summary of the day and not of the
 * filter — the same rule the Approvals cards follow.
 *
 * `branchId`/`mode`/`scoped` are optional: passed by Super Admin's Finance screen, whose
 * own branch-pill row already picked a scope — this board then reads that scope instead
 * of asking a second time with its own dropdown. `scoped` is the explicit flag for that
 * (rather than inferring it from `branchId` being set, which is exactly as legitimately
 * undefined for "All Branches" as it is for "no caller passed anything"). Left off, this
 * keeps its original shape: the Accountant's own login board, picking its own branch and
 * vertical.
 */
export const ExpenseBoard = ({ branchId: branchIdProp, mode: modeProp, scoped = false } = {}) => {
  const controlled = scoped;
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState("");
  const [mode, setMode] = useState("all"); // "all" | "online" | "offline"
  const effectiveBranchId = controlled ? (branchIdProp || "") : branchId;
  const effectiveMode = controlled ? (modeProp || "all") : mode;
  // Which book is being read: what was spent, or the tin most of the small cash spending
  // comes out of. Two views of overlapping money — see PettyCashPanel — so they share this
  // page's window and branch rather than each asking again.
  const [view, setView] = useState("expenses"); // "expenses" | "petty"
  const [preset, setPreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Which tender's rows are listed. "" is every one of them, which is the Total tile —
  // the tile that is lit when no other is.
  const [tender, setTender] = useState("");
  const [data, setData] = useState({ expenses: [], total: 0, payment_modes: {} });
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(blankExpense);
  // The cash count, kept beside the form rather than in it: the grid is keyed by the
  // note's face value and the record stores only the notes actually seen, so the two are
  // different shapes — see countedNotes.
  const [notes, setNotes] = useState({});
  const [coins, setCoins] = useState("");
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState(null);
  // The Vendor book, for the picker in the Add Expense dialog — the same list the Vendor
  // tab keeps, switched-off vendors left out since the server refuses an expense against
  // one. Fetched when the dialog opens so a vendor added on the Vendor tab is there.
  const [vendors, setVendors] = useState([]);
  const [newVendor, setNewVendor] = useState(null); // { name, phone } while the + is open
  const [addingVendor, setAddingVendor] = useState(false);

  useEffect(() => { if (!controlled) getBranches().then(setBranches).catch(() => {}); }, [controlled]);
  useEffect(() => {
    if (showAdd) listVendors({ active_only: true }).then((v) => setVendors(v || [])).catch(() => setVendors([]));
  }, [showAdd]);

  const [startDate, endDate] = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const pickDates = (key, from, to) => { setPreset(key); setCustomFrom(from); setCustomTo(to); };

  const load = useCallback(async () => {
    // A half-typed custom range would ask for everything from one date to nothing, which
    // reads as a filter that stopped working. Waits for both ends.
    if (rangeIncomplete(preset, customFrom, customTo)) return;
    setLoading(true);
    try {
      const params = {};
      if (effectiveBranchId) params.branch_id = effectiveBranchId;
      if (effectiveMode !== "all") params.mode = effectiveMode;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      setData(await getFinanceExpenses(params));
    } catch { /* silent */ }
    setLoading(false);
  }, [effectiveBranchId, effectiveMode, startDate, endDate, preset, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  // The tender filter is applied here rather than asked of the endpoint: the window's rows
  // are already in hand, and /finance/expenses has no payment-mode parameter to pass. The
  // tiles above keep reading the whole window either way.
  const visible = useMemo(
    () => (data.expenses || []).filter((e) => !tender || (e.payment_mode || "unknown") === tender),
    [data.expenses, tender],
  );
  const visibleTotal = useMemo(
    () => visible.reduce((n, e) => n + (Number(e.amount) || 0), 0),
    [visible],
  );

  const expenseBranchId = (controlled ? effectiveBranchId : form.branch_id) || null;
  const petty = isPettyCash(form.amount, form.payment_mode, expenseBranchId);

  // What the form asks for below the tender: a count for cash, a reference for the four
  // that settle somewhere and can be traced by a number.
  const paidInCash = form.payment_mode === "cash";
  const ask = REFERENCE_ASK[form.payment_mode];
  const coinsPaid = Math.round((parseFloat(coins) || 0) * 100) / 100;
  const countedCash = useMemo(() => noteTotal(notes) + coinsPaid, [notes, coinsPaid]);
  const cashShortfall = Math.round((Number(form.amount) - countedCash) * 100) / 100;

  const closeAdd = () => {
    setShowAdd(false);
    setForm(blankExpense);
    setNotes({});
    setCoins("");
    setNewVendor(null);
  };

  // The + beside the vendor picker: added to the same Vendor list the Vendor tab shows,
  // and picked for this expense straight away.
  const saveNewVendor = async () => {
    if (!newVendor?.name.trim()) { toast.error("Enter the vendor name"); return; }
    setAddingVendor(true);
    try {
      const v = await createVendor({ name: newVendor.name.trim(), phone: newVendor.phone.trim() });
      setVendors((list) => [...list, v].sort((a, b) => a.name.localeCompare(b.name)));
      setForm((f) => ({ ...f, vendor_id: v.id }));
      setNewVendor(null);
      toast.success(`${v.name} added`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add the vendor");
    } finally {
      setAddingVendor(false);
    }
  };

  const submit = async () => {
    if (!form.category.trim()) { toast.error("Expense name is required"); return; }
    if (!(Number(form.amount) > 0)) { toast.error("Enter an amount"); return; }
    // Asked for the same reason the approve popup asks: an expense somebody has to sign
    // off is a claim about a real payment, and a figure with nothing to trace it to
    // cannot be checked against a statement.
    if (ask && !form.reference.trim()) { toast.error(ask.missing); return; }
    // Cash has no reference, so the count is what stands in for one — and a count that
    // does not come to the amount is not a count of this payment.
    if (paidInCash && Math.abs(cashShortfall) >= 0.01) {
      toast.error(
        cashShortfall > 0
          ? `The notes come to ${fmt(countedCash)}, ${fmt(cashShortfall)} short of the amount`
          : `The notes come to ${fmt(countedCash)}, ${fmt(-cashShortfall)} more than the amount`,
      );
      return;
    }
    if (petty && !form.note.trim()) { toast.error(PETTY_CASH_REASON_REQUIRED); return; }
    setSaving(true);
    try {
      const vendor = vendors.find((v) => v.id === form.vendor_id);
      await createFinanceExpense({
        ...form,
        amount: Number(form.amount),
        branch_id: expenseBranchId,
        vendor_id: vendor?.id || undefined,
        paid_to: vendor?.name || "",
        // Cash carries the bill number, if there is one; the other four carry what their
        // tender is traced by. Either way it is the one box on screen for this tender.
        reference: form.reference.trim(),
        cash_denominations: paidInCash ? (countedNotes(notes) || {}) : {},
        cash_coins: paidInCash ? coinsPaid : 0,
      });
      toast.success("Expense logged — waiting in Approvals");
      closeAdd();
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to log expense"); }
    setSaving(false);
  };

  const remove = async (exp) => {
    if (!window.confirm(`Delete this ${exp.category} expense of ${fmt(exp.amount)}?`)) return;
    try { await deleteFinanceExpense(exp.id); toast.success("Deleted"); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Delete failed"); }
  };

  // Signing off what a branch has asked to spend, or turning it down. A rejection asks for
  // the reason rather than assuming one: the branch is owed an answer they can act on, and
  // a row that comes back refused with nothing attached gets sent again unchanged.
  const decide = async (exp, approve) => {
    let reason = "";
    if (!approve) {
      reason = window.prompt(`Why is this ${exp.category} expense of ${fmt(exp.amount)} being turned down?`) || "";
      if (!reason.trim()) return;
    }
    setDeciding(exp.id);
    try {
      if (approve) await approveFinanceExpense(exp.id);
      else await rejectFinanceExpense(exp.id, reason.trim());
      toast.success(approve ? "Approved" : "Rejected");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save that");
    } finally {
      setDeciding(null);
    }
  };

  const pending = (exp) => exp.approved === false && !exp.rejected;
  /** The line under an expense's name: where the money went, what it can be traced by,
   *  and — where it was cash — the notes it was counted out in. */
  const detailLine = (exp) => [
    exp.paid_to && `to ${exp.paid_to}`,
    exp.reference,
    notesLabel(exp.cash_denominations),
    exp.note,
  ].filter(Boolean).join(" · ");
  const emptyLine = tender
    ? `Nothing paid by ${PAYMENT_MODE_LABELS[tender] || "that tender"} in this window.`
    : preset === "all" ? "No expenses logged yet." : "No expenses in this window.";

  /** The two buttons a waiting row carries, on both the table and the phone list. */
  const decideButtons = (exp) => (
    <>
      <Button
        size="sm"
        className="h-7 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700"
        disabled={deciding === exp.id}
        onClick={() => decide(exp, true)}
        data-testid={`finance-expense-approve-${exp.id}`}
      >
        <Check className="mr-1 h-3 w-3" /> Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-rose-200 px-2 text-[11px] text-rose-700 hover:bg-rose-50"
        disabled={deciding === exp.id}
        onClick={() => decide(exp, false)}
        data-testid={`finance-expense-reject-${exp.id}`}
      >
        Reject
      </Button>
    </>
  );

  return (
    <div className="space-y-4" data-testid="finance-expense-root">
      {/* Which of the two books. The tin is not a separate subject from the expense list —
          nearly every line in it is a small cash expense on the list beside it — so it
          belongs here as a view of this page rather than as a fifth tab up on the finance
          row, where it would read as a fourth thing the desk keeps. */}
      <div className="flex w-full items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5" data-testid="finance-expense-views">
        {[["expenses", "Expenses"], ["petty", "Petty Cash"]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={`flex-1 rounded-md px-4 py-2 text-xs font-semibold transition ${
              view === key ? "bg-sky-500 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50"
            }`}
            data-testid={`finance-expense-view-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* When, and the one thing on this page that adds to it rather than narrowing it.
          The window sits at the top because it governs every figure below it — the tiles
          included — and a filter under the numbers it changes reads as a filter on the
          list alone. Shared by both views: the window and the branch are the same question
          whichever book is open. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The shared finance row, so this page and the three beside it name their windows
            with the same words and reach them the same way. Custom Range opens the dialog
            rather than dropping two date fields into the page underneath: fields that
            appear on one preset and vanish on the others move every figure below them up
            and down the screen each time the window is changed. */}
        <FinanceDateFilter
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          onChange={pickDates}
          testid="finance-expense-window"
        />
        {/* The tin has its own way in — Top Up, on the panel itself — and it is not an
            expense, so it does not belong behind this button. */}
        {view === "expenses" && (
          <Button onClick={() => setShowAdd(true)} className="h-10 shrink-0 bg-sky-600 hover:bg-sky-700" data-testid="finance-expense-add-btn">
            <Plus className="mr-1 h-4 w-4" />Add Expense
          </Button>
        )}
      </div>

      {/* Whose. Branch and vertical are already picked by the branch-pill row above this
          board when embedded there — asking again here would be a second control for the
          same scope. The Accountant's own dashboard has no such row, so it keeps both.
          Above the figures rather than between them and the list, because both views put
          their own figures under it and a filter that sat in a different place on each
          would read as a different filter. */}
      {!controlled && (
        <div className="flex flex-wrap items-center gap-2">
          {[["all", "All"], ["offline", "Offline"], ["online", "Online"]].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                mode === key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
              }`}
              data-testid={`finance-expense-mode-${key}`}
            >
              {label}
            </button>
          ))}
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-600"
            data-testid="finance-expense-branch"
          >
            <option value="">All Branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
          </select>
        </div>
      )}

      {view === "petty" && (
        <PettyCashPanel
          branchId={effectiveBranchId}
          mode={effectiveMode}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {view === "expenses" && (
      <>
      {/* The window's money, split by tender, and the filter for the list below in the
          same row of cards — the house tile draws itself as a button when it is given
          something to do. Total is the "all tenders" tile: it is lit when no other is,
          and pressing it clears the filter. Every figure here is the whole window
          whichever tile is lit, so the row stays a summary of the day rather than a
          summary of the filter. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="finance-expense-payment-modes">
        <SummaryTile
          label="Total Expense"
          value={fmt(data.total)}
          sub={tender ? "All tenders — press to clear" : "Every tender in this window"}
          color="#e11d48"
          active={!tender}
          onClick={() => setTender("")}
          testid="finance-expense-total-card"
        />
        {orderedPaymentModeEntries(data.payment_modes).map(([pm, amt]) => {
          const t = MODE_TILE[pm] || MODE_TILE.unknown;
          return (
            <SummaryTile
              key={pm}
              label={PAYMENT_MODE_LABELS[pm]}
              value={fmt(amt)}
              sub={tender === pm ? "Showing these only" : "Press to show only these"}
              color={t.color}
              active={tender === pm}
              onClick={() => setTender(tender === pm ? "" : pm)}
              testid={`finance-expense-payment-mode-${pm}`}
            />
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow" data-testid="finance-expense-list">
        {/* What is actually on the table under the filters, counted and totalled. The
            total here follows the tender filter where the tiles above do not: this line
            describes the rows, and a footer figure that disagreed with the rows under it
            would be the one number on the page nobody could tie out. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            {visible.length} {visible.length === 1 ? "expense" : "expenses"}
            {tender ? <span className="ml-1.5 font-medium normal-case tracking-normal text-slate-400">paid by {PAYMENT_MODE_LABELS[tender]}</span> : null}
          </p>
          <p className="text-sm font-bold tabular-nums text-rose-600">{fmt(visibleTotal)}</p>
        </div>

        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">Loading...</p>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center" data-testid="finance-expense-empty">
            <Receipt className="mx-auto mb-2 h-8 w-8 text-slate-200" />
            <p className="text-xs text-slate-400">{emptyLine}</p>
          </div>
        ) : (
          <>
            {/* The table proper, from md up. Below that the same rows as cards: nine
                columns on a phone is a horizontal scrollbar over text nobody can read,
                and this list is worked from a phone at the desk as often as not. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[52rem] table-fixed text-sm">
                <thead className="bg-slate-500 text-white">
                  <tr>
                    <th className="w-[26%] px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Expense</th>
                    <th className="w-[15%] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Branch</th>
                    <th className="w-[11%] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Date</th>
                    <th className="w-[11%] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Mode</th>
                    <th className="w-[11%] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Status</th>
                    <th className="w-[12%] px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide">Amount</th>
                    <th className="w-[14%] px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((exp) => (
                    <tr
                      key={exp.id}
                      className={`transition hover:bg-slate-50 ${pending(exp) ? "bg-amber-50/40" : ""}`}
                      data-testid={`finance-expense-row-${exp.id}`}
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium text-slate-800">{exp.category}</span>
                          {exp.petty_cash ? <PettyChip /> : null}
                        </div>
                        {/* What the money bought and who it went to, under the name rather
                            than in columns of their own: both are blank on plenty of rows,
                            and two mostly-empty columns cost the width the figures need. */}
                        {detailLine(exp) ? (
                          <p className="mt-0.5 truncate text-xs text-slate-500">{detailLine(exp)}</p>
                        ) : null}
                        {/* Who asked, on a row somebody is being asked to sign off.
                            Approving a figure without knowing whose spending it is, is
                            initialling a number. */}
                        {pending(exp) && exp.created_by ? (
                          <p className="mt-0.5 truncate text-[11px] text-amber-700">Raised by {exp.created_by}</p>
                        ) : null}
                        {exp.rejected && exp.rejection_reason ? (
                          <p className="mt-0.5 truncate text-[11px] text-rose-600">Rejected — {exp.rejection_reason}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 align-top text-slate-600">{exp.branch_name || "—"}</td>
                      <td className="px-3 py-3 align-top tabular-nums text-slate-600">{exp.expense_date || "—"}</td>
                      <td className="px-3 py-3 align-top"><ModeChip mode={exp.payment_mode || "unknown"} /></td>
                      <td className="px-3 py-3 align-top"><StatusChip exp={exp} /></td>
                      <td className="px-3 py-3 text-right align-top font-bold tabular-nums text-rose-600">{fmt(exp.amount)}</td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center justify-end gap-2">
                          {/* Only on what is actually waiting. An expense the accountant
                              entered is already signed off by the act of entering it, and
                              one already decided is not a decision to make twice. */}
                          {pending(exp) ? decideButtons(exp) : null}
                          {data.delete_enabled && (
                            <button
                              onClick={() => remove(exp)}
                              className="text-slate-300 transition hover:text-rose-600"
                              title="Delete this expense"
                              data-testid={`finance-expense-delete-${exp.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-slate-50 md:hidden">
              {visible.map((exp) => (
                <div
                  key={exp.id}
                  className={`px-4 py-3 ${pending(exp) ? "bg-amber-50/40" : ""}`}
                  data-testid={`finance-expense-card-${exp.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-800">{exp.category}</span>
                        {exp.petty_cash ? <PettyChip /> : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {[exp.branch_name, exp.expense_date, detailLine(exp)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-rose-600">{fmt(exp.amount)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ModeChip mode={exp.payment_mode || "unknown"} />
                    <StatusChip exp={exp} />
                    <div className="ml-auto flex items-center gap-2">
                      {pending(exp) ? decideButtons(exp) : null}
                      {data.delete_enabled && (
                        <button
                          onClick={() => remove(exp)}
                          className="text-slate-300 transition hover:text-rose-600"
                          title="Delete this expense"
                          data-testid={`finance-expense-card-delete-${exp.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {pending(exp) && exp.created_by ? (
                    <p className="mt-1 truncate text-[11px] text-amber-700">Raised by {exp.created_by}</p>
                  ) : null}
                  {exp.rejected && exp.rejection_reason ? (
                    <p className="mt-1 truncate text-[11px] text-rose-600">Rejected — {exp.rejection_reason}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      </>
      )}

      {showAdd && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}
          data-testid="finance-expense-add-dialog"
        >
          {/* Laid out as the branch's Add Expense is — labelled fields, name and amount
              side by side, the vendor picker with its +, a bill number — so the accountant
              and the branch fill in the same form. What is the accountant's own stays: the
              branch it is booked to and every tender, not cash alone. The body scrolls and
              the buttons stay put, so a tall form never pushes them off screen. */}
          <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/60 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-800">Add Expense</h3>
              <button type="button" onClick={closeAdd} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close" data-testid="finance-expense-add-close"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {/* Already fixed by the branch-pill row above this board when embedded there;
                  the Accountant's own dashboard has no such row and still picks one here. */}
              {controlled ? (
                <p className="text-xs text-slate-500" data-testid="finance-expense-form-branch-fixed">
                  Recorded {effectiveBranchId ? "against this branch." : "as an org-wide expense (All Branches)."}
                </p>
              ) : (
                <div>
                  <FieldLabel>Branch</FieldLabel>
                  <select
                    value={form.branch_id}
                    onChange={(e) => setForm({ ...form, branch_id: e.target.value })}
                    className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm focus:border-sky-400 focus:outline-none"
                    data-testid="finance-expense-form-branch"
                  >
                    <option value="">All Branches (org-wide)</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel>Name *</FieldLabel>
                  <Input placeholder="e.g. Rent, Salaries" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} data-testid="finance-expense-category" />
                </div>
                <div>
                  <FieldLabel>Amount *</FieldLabel>
                  <Input type="number" min="0" placeholder="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="finance-expense-amount" />
                </div>

                <div className="sm:col-span-2">
                  <FieldLabel>Vendor</FieldLabel>
                  <div className="flex gap-2">
                    <select
                      value={form.vendor_id}
                      onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}
                      className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                      data-testid="finance-expense-vendor"
                    >
                      <option value="">-- not a listed vendor --</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => setNewVendor(newVendor ? null : { name: "", phone: "" })}
                      className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md border ${
                        newVendor ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                      title="Add vendor"
                      aria-label="Add vendor"
                      data-testid="finance-expense-vendor-add"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  {newVendor && (
                    <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-sky-200 bg-sky-50/50 p-2" data-testid="finance-expense-new-vendor">
                      <Input
                        value={newVendor.name}
                        onChange={(e) => setNewVendor((n) => ({ ...n, name: e.target.value }))}
                        placeholder="Vendor name *"
                        className="min-w-[140px] flex-1 bg-white"
                        autoFocus
                        data-testid="finance-expense-new-vendor-name"
                      />
                      <Input
                        value={newVendor.phone}
                        onChange={(e) => setNewVendor((n) => ({ ...n, phone: e.target.value }))}
                        placeholder="Phone"
                        className="w-32 bg-white"
                        data-testid="finance-expense-new-vendor-phone"
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 bg-sky-600 text-white hover:bg-sky-700"
                        disabled={addingVendor}
                        onClick={saveNewVendor}
                        data-testid="finance-expense-new-vendor-save"
                      >
                        {addingVendor ? "Adding…" : "Add"}
                      </Button>
                    </div>
                  )}
                </div>

                <div>
                  <FieldLabel>Spent on</FieldLabel>
                  <MilkDateInput value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} data-testid="finance-expense-date" />
                </div>
              </div>

              <div>
                <FieldLabel>Payment mode</FieldLabel>
                <div className="flex flex-wrap gap-1.5" data-testid="finance-expense-form-mode">
                  {EXPENSE_PAYMENT_MODE_OPTIONS.map((m) => {
                    const selected = m === form.payment_mode;
                    const c = PAYMENT_MODE_COLORS[m];
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setForm({ ...form, payment_mode: m })}
                        className={`h-9 min-w-[64px] flex-1 rounded-md border text-center text-xs font-semibold transition ${
                          selected ? `${c.bg} ${c.border} ${c.text} shadow-sm` : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                        data-testid={`finance-expense-form-mode-${m}`}
                      >
                        {PAYMENT_MODE_LABELS[m]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* What this payment can be found by later, directly under the mode row that
                  decides the question: a bill number for cash (optional — not every cash
                  payment has one), and for the other four whatever their tender is traced
                  by, which is required. */}
              <div data-testid="finance-expense-reference-field">
                <FieldLabel>{ask ? `${ask.label} *` : "Bill / reference no."}</FieldLabel>
                <Input
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  placeholder={ask ? ask.placeholder : "Optional"}
                  data-testid="finance-expense-reference"
                />
              </div>

              {paidInCash && (
                <div data-testid="finance-expense-denominations">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Denominations *</span>
                    {/* The fewest notes that make the amount, for the common case where
                        the drawer was paid out in exactly that. Same button Closing
                        Balance offers over the same grid. */}
                    <button
                      type="button"
                      onClick={() => { setNotes(noteBreakdown(Number(form.amount) || 0)); setCoins(""); }}
                      disabled={!(Number(form.amount) > 0)}
                      className="text-[11px] font-semibold text-sky-600 hover:text-sky-700 disabled:text-slate-300"
                      data-testid="finance-expense-fill-notes"
                    >
                      Fill to amount
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {DENOMINATIONS.map((d) => (
                      <div key={d}>
                        <label className="mb-0.5 block text-[10px] text-slate-500">Rs.{d}</label>
                        <Input
                          type="number"
                          min="0"
                          value={notes[d] ?? ""}
                          onChange={(e) => setNotes({ ...notes, [d]: e.target.value })}
                          className="h-9"
                          data-testid={`finance-expense-note-${d}`}
                        />
                      </div>
                    ))}
                  </div>
                  {/* The ladder stops at ten and a payment does not: without this a cash
                      expense of Rs.1,234 could never be made to add up. */}
                  <label className="mb-0.5 mt-2 block text-[10px] text-slate-500">Coins and change (Rs.)</label>
                  <Input
                    type="number"
                    min="0"
                    value={coins}
                    onChange={(e) => setCoins(e.target.value)}
                    className="h-9"
                    data-testid="finance-expense-coins"
                  />
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-slate-500">Counted</span>
                    <span className={`font-bold tabular-nums ${
                      Number(form.amount) > 0 && Math.abs(cashShortfall) < 0.01 ? "text-emerald-600" : "text-slate-700"
                    }`} data-testid="finance-expense-counted-cash">
                      {fmt(countedCash)}
                    </span>
                  </div>
                  {Number(form.amount) > 0 && Math.abs(cashShortfall) >= 0.01 && (
                    <p className="mt-1 text-[11px] text-amber-700" data-testid="finance-expense-cash-mismatch">
                      {cashShortfall > 0
                        ? `${fmt(cashShortfall)} short of the amount above.`
                        : `${fmt(-cashShortfall)} more than the amount above.`}
                    </p>
                  )}
                </div>
              )}

              <div>
                <FieldLabel>{petty ? "What the petty cash was spent on *" : "Remarks"}</FieldLabel>
                <textarea
                  rows={2}
                  placeholder={petty ? "Reason — what the petty cash was spent on" : "Optional"}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                    petty && !form.note.trim() ? "border-amber-300 focus:border-amber-400" : "border-slate-200 focus:border-sky-400"
                  }`}
                  data-testid="finance-expense-note"
                />
              </div>
              {petty && (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800" data-testid="finance-expense-petty-hint">
                  <Coins className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <b>Petty cash.</b> Rs.{PETTY_CASH_LIMIT.toLocaleString("en-IN")} or less in cash comes out of this branch&apos;s tin,
                    and the reason above is the only record of what it bought.
                  </span>
                </p>
              )}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <Button variant="outline" onClick={closeAdd} data-testid="finance-expense-cancel">Cancel</Button>
              <Button onClick={submit} disabled={saving} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="finance-expense-submit">
                {saving ? "Saving..." : "Add Expense"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExpenseBoard;
