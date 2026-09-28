import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, ChevronRight, Minus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { FinanceDateFilter } from "@/components/finance/FinanceDateFilter";
import { rangeFor, rangeIncomplete } from "@/lib/dateRange";
import { getFinanceApprovals, getBranches, approveTransaction, unapproveTransaction, bulkApproveTransactions, deleteTransaction } from "@/lib/api";
import { ExpenseApprovalsPanel } from "@/components/finance/ExpenseApprovalsPanel";

// The two things this desk signs off. Money coming in was all it ever held, because money
// going out had no approval to give — a branch could not raise an expense, so the only
// expenses on file were the ones the accountant had entered themselves.
const LEDGERS = [
  { key: "income", label: "Income Approval" },
  { key: "expenses", label: "Expenses Approval" },
];

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * The red count in a tab's top-right corner that says something is waiting on this desk.
 * Same badge PhysioBoard and DietBoard put on their tabs, so a number in that corner
 * means the same thing wherever it turns up. Nothing at all at zero -- a "0" in red is an
 * alarm about nothing.
 */
export const PendingBadge = ({ count, testId }) => (count > 0 ? (
  <span
    className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white"
    data-testid={testId}
  >
    {count > 99 ? "99+" : count}
  </span>
) : null);

// Every category the backend can return, which is not what this list held: Rehab and
// Zumba were both missing, so a rehab course fee or a class fee could be seen only
// under "All" and vanished the moment any pill was picked. Zumba could not be seen at
// all until finance_approvals started reading the registrations it lives on. Fitness was
// missing the same way: a gym membership fee showed under All and under no pill, while
// Summary gives it a card of its own.
//
// Named and ordered as Summary's revenue cards are (AccountantManageTab's REVENUE_VIEWS),
// so the accountant moving from a figure there to signing it off here looks for the same
// word in the same place — this row used to say Treatments and Fitsio Store for what
// Summary calls Session and Store.
const CATEGORIES = [
  ["all", "All"],
  ["consultation", "Consultation"],
  ["session", "Session"],
  ["diet", "Diet"],
  ["store", "Store"],
  ["zumba", "Zumba"],
  ["rehab", "Rehab"],
  ["fitness", "Fitness"],
  ["other", "Others"],
];

const MODE_LABELS = { upi: "UPI", account_transfer: "Bank Transfer", cheque: "Cheque", cash: "Cash", card: "Card", partial: "Partial" };
const modeLabel = (m) => MODE_LABELS[m] || (m && m !== "unknown" ? m.charAt(0).toUpperCase() + m.slice(1) : "—");

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// Approved payments, one row per lead. Each payment is still signed off on its own while
// pending, but once through, a consultation fee and a treatment fee from the same person
// are one person's money and read as one line. Store counter sales carry no lead and stay
// a row each. Order follows the first (newest) payment of each lead, as the list came.
const groupByLead = (rows) => {
  const groups = [];
  const byLead = new Map();
  rows.forEach((tx) => {
    const g = tx.lead_id ? byLead.get(tx.lead_id) : null;
    if (g) { g.items.push(tx); return; }
    const fresh = { key: tx.lead_id || tx.id, items: [tx] };
    if (tx.lead_id) byLead.set(tx.lead_id, fresh);
    groups.push(fresh);
  });
  return groups.map((g) => {
    const dates = g.items.map((t) => (t.collected_at || "").slice(0, 10)).filter(Boolean).sort();
    return {
      ...g,
      head: g.items[0],
      total: g.items.reduce((sum, t) => sum + (Number(t.amount) || 0), 0),
      categories: uniq(g.items.map((t) => t.category)),
      modes: uniq(g.items.map((t) => modeLabel(t.payment_mode))),
      approvers: uniq(g.items.map((t) => t.approved_by)),
      dateLabel: dates.length === 0 ? "" : dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`,
    };
  });
};

// Same set a Branch Admin picks from when collecting a fee (V3MarkInstallmentPaidInput
// and its siblings across v3_packages.py) — not a separate list invented for this filter.
const PAYMENT_MODES = [
  ["all", "All Modes"],
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["card", "Card"],
  ["account_transfer", "Bank Transfer"],
  ["cheque", "Cheque"],
];

const VERTICALS = [["all", "All"], ["offline", "Offline"], ["online", "Online"]];

// The same six windows Summary offers, so a figure read there for Yesterday or Last Month
// can be opened here under the same window to sign it off. This Week went for the same
// reason Summary dropped it: the ledger is read by the day or by the month. Custom Range
// stays last, where a preset row ends everywhere else in the OS.
const DATE_PRESETS = ["all", "today", "yesterday", "this_month", "last_month", "custom"];

/**
 * One filter pill. The three rows of these used to be written out three times with three
 * different sizes -- the vertical row at text-xs/px-3, the other two at text-sm/px-3.5 --
 * so a filter block that asks three questions of equal weight answered them in two
 * typefaces. One size now, and the accent is the only thing that varies: sky for what was
 * bought, indigo for how it was paid, which is the distinction the rows are grouped on.
 */
const FilterPill = ({ on, accent = "sky", onClick, children, testId }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={on}
    className={`shrink-0 rounded-[2px] border px-3 py-1.5 text-xs font-medium transition ${
      on
        ? accent === "indigo"
          ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
          : "border-sky-600 bg-sky-600 text-white shadow-sm"
        : `border-slate-200 bg-white text-slate-600 ${accent === "indigo" ? "hover:border-indigo-300 hover:text-indigo-600" : "hover:border-sky-300 hover:text-sky-600"}`
    }`}
    data-testid={testId}
  >
    {children}
  </button>
);

/**
 * A line of the filter block, holding two groups of pills pushed to opposite ends of it.
 *
 * The gap between them is what separates the two questions, which is why they are not
 * simply four bands of pills stacked: four bands cost four bands of screen above a list
 * that is the thing anybody came here to read. On a phone there is no room to push
 * anything anywhere, so the groups stack and the gap between them does the same job
 * vertically.
 */
const FilterRow = ({ children }) => (
  <div className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
    {children}
  </div>
);

/** One question's worth of pills, wrapping within itself rather than into its neighbour. */
const FilterGroup = ({ children, testId }) => (
  <div className="flex flex-wrap items-center gap-2" data-testid={testId}>{children}</div>
);

// A payment's date and the clock time it was taken at, read off the one ISO stamp the row
// carries. One column holding both, the date over the time: they answer the same question
// — when was this money taken — and two columns apart made the desk read across the table
// to put one answer together.
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
};

// A cell with nothing to say says so once, in the same grey everywhere, rather than each
// column inventing its own way of being empty.
const Blank = () => <span className="text-slate-300">—</span>;

/**
 * The three reference columns, worked out once per row.
 *
 * They are named for UPI because that is the mode this desk spends its day signing off,
 * but every mode has the same three things to answer and the columns hold whichever
 * applies: where the money came from and where it landed, the account it landed in, and
 * the number the payment is traced by. Cash answers none of the three — counting the
 * drawer is its check — so its row is three dashes rather than three empty boxes.
 *
 * Nothing is invented. A payment that never recorded a field leaves that column blank:
 * a UPI collection taken before the company-account picker existed has its transaction
 * id and no account under it, and a counter sale records no reference at all because the
 * sell popup never asks for one.
 */
const referenceColumns = (tx) => {
  const ref = tx.payment_ref || {};
  const mode = tx.payment_mode;

  if (mode === "upi") {
    return {
      // The bank the money landed in, and whose account it is underneath. The payer's own
      // handle is not here: the column names the receiver, and a fee collection records
      // the account it landed in rather than the phone it left, so where a registration
      // did capture the sender it is shown against the client instead.
      route: [ref.receiver_bank || "", ref.receiver_name || ""],
      account: [ref.receiver_upi_id || "", ref.receiver_account || ""],
      txn: [ref.upi_transaction_id || "", ref.upi_utr ? `UTR ${ref.upi_utr}` : ""],
    };
  }
  if (mode === "account_transfer") {
    return {
      route: [ref.bank_name || "", ref.account_holder_name || ""],
      account: [ref.account_number || "", ref.ifsc_code || ""],
      txn: [ref.transfer_reference || "", ""],
    };
  }
  if (mode === "cheque") {
    return {
      route: [ref.cheque_bank || "", ""],
      account: ["", ""],
      txn: [ref.cheque_number ? `#${ref.cheque_number}` : "", ""],
    };
  }
  if (mode === "card") {
    return { route: ["", ""], account: ["", ""], txn: [ref.card_transaction_id || "", ""] };
  }
  // Zumba and Fitness keep one typed reference whatever the mode — see
  // _registration_reference on the backend.
  return { route: ["", ""], account: ["", ""], txn: [ref.reference || "", ""] };
};

// What each of the three reference columns is called for a given mode. The table heads
// them for UPI, the mode most of the queue is; in the popup there is room to name them
// for the row actually being signed off.
const REF_LABELS = {
  upi: ["Receiver Bank", "Receiver UPI", "Transaction UPI ID"],
  account_transfer: ["Bank", "Account", "Transfer Reference"],
  cheque: ["Cheque Bank", "Account", "Cheque Number"],
  card: ["Bank", "Account", "Card Transaction ID"],
};
const refLabels = (mode) => REF_LABELS[mode] || ["Bank", "Account", "Reference"];

/** One labelled fact in the popup's detail grid, with its qualifier underneath. */
const DetailItem = ({ label, value, sub, wide = false, testId }) => (
  <div className={`min-w-0 ${wide ? "col-span-2" : ""}`} data-testid={testId}>
    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
    {value ? (
      <p className="break-words text-sm font-medium text-slate-800">{value}</p>
    ) : (
      <p className="text-sm text-slate-300">—</p>
    )}
    {sub ? <p className="break-words text-[11px] leading-snug text-slate-500">{sub}</p> : null}
  </div>
);

/**
 * Everything the pending row says about the payment, laid out in the popup that signs it
 * off -- so the accountant checks the amount or reference against the whole record rather
 * than against a name and a figure, with the table hidden behind the overlay.
 */
const PaymentDetails = ({ tx }) => {
  const ref = tx.payment_ref || {};
  const cols = referenceColumns(tx);
  const [routeLabel, accountLabel, txnLabel] = refLabels(tx.payment_mode);
  const split = Array.isArray(ref.split) ? ref.split : [];
  const phone = [tx.patient_phone, ref.payer_upi_id ? `UPI ${ref.payer_upi_id}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4" data-testid="finance-approve-details">
      <div className="mb-3 flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-slate-800">{tx.patient_name}</p>
          {phone && <p className="text-xs text-slate-500">{phone}</p>}
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Amount</p>
          <p className="text-lg font-bold text-emerald-600">{fmt(tx.amount)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <DetailItem label="Branch" value={tx.branch_name} />
        <DetailItem label="Session" value={tx.category ? tx.category.charAt(0).toUpperCase() + tx.category.slice(1) : ""} />
        <DetailItem
          label="Payment Method"
          value={modeLabel(tx.payment_mode)}
          sub={split.length > 0 ? split.map((t) => `${fmt(t.amount)} ${modeLabel(t.mode)}`).join(" + ") : ""}
        />
        <DetailItem label="Date & Time" value={fmtDate(tx.collected_at)} sub={fmtTime(tx.collected_at)} />
        <DetailItem label={routeLabel} value={cols.route[0]} sub={cols.route[1]} />
        <DetailItem label={accountLabel} value={cols.account[0]} sub={cols.account[1]} />
        <DetailItem label={txnLabel} value={cols.txn[0]} sub={cols.txn[1]} />
        <DetailItem label="Collected By" value={tx.collected_by} />
      </div>
    </div>
  );
};

/**
 * Approve popup — what it asks for depends on the row's own payment mode: Cash gets a
 * re-entered amount (the one figure a cash drawer can't otherwise be checked against);
 * UPI/Bank Transfer/Card get a reference to key against the bank statement; Cheque gets
 * its number. A mode with nothing recognised (package_sold, a store sale rung up with
 * no mode) just confirms the amount, same as Cash.
 */
const ApproveModal = ({ tx, onClose, onApproved }) => {
  const mode = tx.payment_mode;
  const needsRef = mode === "upi" || mode === "card" || mode === "account_transfer";
  const needsCheque = mode === "cheque";
  const needsAmount = !needsRef && !needsCheque;

  const [amount, setAmount] = useState(String(tx.amount || ""));
  const [ref, setRef] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (needsAmount && !(Number(amount) > 0)) { toast.error("Enter the amount"); return; }
    if (needsRef && !ref.trim()) { toast.error(`Enter the ${mode === "upi" ? "UPI reference" : "transaction ID"}`); return; }
    if (needsCheque && !chequeNo.trim()) { toast.error("Enter the cheque number"); return; }
    setSaving(true);
    try {
      const payload = {};
      if (needsAmount) payload.confirmed_amount = Number(amount);
      if (needsRef) payload.transaction_ref = ref.trim();
      if (needsCheque) payload.cheque_number = chequeNo.trim();
      await approveTransaction(tx.id, payload);
      toast.success(`${tx.patient_name}'s payment approved`);
      onApproved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Approve failed"); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="finance-approve-modal">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold">Approve Payment</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="finance-approve-modal-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          <PaymentDetails tx={tx} />
          {needsAmount && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Re-enter the amount collected</label>
              <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="finance-approve-amount" />
            </div>
          )}
          {needsRef && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">{mode === "upi" ? "UPI Transaction ID" : "Transaction ID"}</label>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={mode === "upi" ? "UPI ref / UTR" : "Bank transaction ID"} data-testid="finance-approve-ref" />
            </div>
          )}
          {needsCheque && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Cheque Number</label>
              <Input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} data-testid="finance-approve-cheque" />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="finance-approve-cancel">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700" data-testid="finance-approve-confirm">
            {saving ? "Approving…" : "Approve"}
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * One box, three states. Radix's Checkbox is the house control and is used everywhere a
 * box is only on or off; this row needs a third — the header box when some of the list is
 * picked and some is not — and that component draws a tick for it, which reads as "all of
 * them" and is the one thing it must not say here.
 */
const TickBox = ({ state, onChange, label }) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={state === "some" ? "mixed" : state === "on"}
    aria-label={label}
    onClick={onChange}
    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
      state === "off"
        ? "border-slate-300 bg-white hover:border-emerald-500"
        : "border-emerald-600 bg-emerald-600 text-white"
    }`}
  >
    {state === "on" && <Check className="h-3 w-3" strokeWidth={3} />}
    {state === "some" && <Minus className="h-3 w-3" strokeWidth={3} />}
  </button>
);

/**
 * The popup for signing off a selection at once.
 *
 * It exists to say the thing the one-at-a-time popup above collects and this one cannot:
 * approving in bulk records who and when against every picked row and nothing to check
 * them against — no re-keyed cash amount, no UTR, no cheque number. That is a real
 * weakening of what an approval means here, so it is said in the popup rather than left
 * for someone to work out from what they were never asked.
 */
const BulkApproveModal = ({ count, total, saving, onClose, onConfirm }) => (
  <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="finance-bulk-approve-modal">
    <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h3 className="text-base font-semibold">Approve {count} payment{count === 1 ? "" : "s"}</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="finance-bulk-approve-close"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3 p-5">
        <p className="text-sm text-slate-600">
          Signing off <span className="font-semibold text-slate-800">{count} payment{count === 1 ? "" : "s"}</span> worth{" "}
          <span className="font-semibold text-emerald-700">{fmt(total)}</span>.
        </p>
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          Approved this way, none of them carries a confirmation: no re-entered cash amount,
          no UPI or bank reference, no cheque number. Your name and the time are recorded
          against each. Approve a row on its own if it needs checking against something.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button variant="outline" onClick={onClose} data-testid="finance-bulk-approve-cancel">Cancel</Button>
        <Button onClick={onConfirm} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700" data-testid="finance-bulk-approve-confirm">
          {saving ? "Approving…" : `Approve ${count}`}
        </Button>
      </div>
    </div>
  </div>
);

/**
 * One reference column's cell: the fact, and underneath it whatever qualifies the fact.
 * Both lines truncate and carry the full value as a tooltip, because a UPI handle or a
 * bank reference is long, exact, and worth nothing if it is silently cut in half.
 */
const RefCell = ({ lead, sub, testId }) => (
  <td className="max-w-[190px] px-3 py-3 align-top" data-testid={testId}>
    {lead || sub ? (
      <div className="min-w-0">
        {lead ? (
          <p className="truncate text-xs font-medium text-slate-700" title={lead}>{lead}</p>
        ) : null}
        {sub ? (
          <p className="truncate text-[11px] leading-snug text-slate-400" title={sub}>{sub}</p>
        ) : null}
      </div>
    ) : (
      <Blank />
    )}
  </td>
);

/**
 * The pending queue, as a table.
 *
 * Same shape the approved ledger beside it has, so both sides of this desk are read the
 * same way — a header naming the columns, a row per payment, the action at the end of it.
 *
 * The reference sits in three columns of its own rather than stacked inside the Payment
 * Method cell. Stacked, a UPI payment's account and transaction id were four lines of
 * small grey text that had to be read row by row; in columns, the whole day's collections
 * line up under one heading each, which is how a desk checking a batch against a bank
 * statement actually works — down a column, not across a card.
 */
/** The bin, shown only while Developer Access has the delete switch on. */
const DeleteIcon = ({ onClick, disabled, testId }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
    title="Delete this payment"
    aria-label="Delete this payment"
    data-testid={testId}
  >
    <Trash2 className="h-4 w-4" />
  </button>
);

const PendingTable = ({ rows, selected, onToggle, onApprove, onDelete, busyId }) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[1240px] text-sm" data-testid="finance-pending-table">
      <thead className="bg-slate-500 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
        <tr>
          <th className="w-9 px-3 py-2.5" />
          <th className="px-3 py-2.5 font-semibold">Client Name</th>
          <th className="px-3 py-2.5 font-semibold">Branch</th>
          <th className="px-3 py-2.5 font-semibold">Session</th>
          <th className="px-3 py-2.5 font-semibold">Payment Method</th>
          <th className="px-3 py-2.5 font-semibold">Receiver Bank</th>
          <th className="px-3 py-2.5 font-semibold">Receiver UPI</th>
          <th className="px-3 py-2.5 font-semibold">Transaction UPI ID</th>
          {/* Centred, because a date and a clock time are fixed-width things and a column
              of them reads as a column rather than as ragged text. */}
          <th className="px-3 py-2.5 text-center font-semibold">Date &amp; Time</th>
          <th className="px-3 py-2.5 text-right font-semibold">Amount</th>
          <th className="px-3 py-2.5" />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((tx) => {
          const cols = referenceColumns(tx);
          const split = Array.isArray((tx.payment_ref || {}).split) ? tx.payment_ref.split : [];
          return (
            <tr
              key={tx.id}
              className={`align-top transition-colors ${selected.has(tx.id) ? "bg-emerald-50/50" : "hover:bg-slate-50"}`}
              data-testid={`finance-approval-row-${tx.id}`}
            >
              <td className="px-3 py-3">
                <TickBox
                  state={selected.has(tx.id) ? "on" : "off"}
                  onChange={() => onToggle(tx.id)}
                  label={`Select ${tx.patient_name}'s payment`}
                />
              </td>
              <td className="px-3 py-3">
                <p className="font-medium text-slate-800">{tx.patient_name}</p>
                {tx.patient_phone && <p className="text-[11px] text-slate-400">{tx.patient_phone}</p>}
                {(tx.payment_ref || {}).payer_upi_id && (
                  <p className="truncate text-[11px] text-slate-400" title={tx.payment_ref.payer_upi_id}>
                    UPI {tx.payment_ref.payer_upi_id}
                  </p>
                )}
              </td>
              <td className="px-3 py-3 text-slate-600">{tx.branch_name || <Blank />}</td>
              <td className="px-3 py-3 capitalize text-slate-600">{tx.category || <Blank />}</td>
              <td className="px-3 py-3" data-testid={`finance-approval-method-${tx.id}`}>
                <p className="text-xs font-semibold text-slate-700">{modeLabel(tx.payment_mode)}</p>
                {/* A fee handed over in two tenders at once. Named here because the mode
                    alone reads "Split", which says a payment was divided without saying
                    into what. */}
                {split.length > 0 && (
                  <p className="text-[11px] leading-snug text-slate-400">
                    {split.map((t) => `${fmt(t.amount)} ${modeLabel(t.mode)}`).join(" + ")}
                  </p>
                )}
              </td>
              <RefCell lead={cols.route[0]} sub={cols.route[1]} testId={`finance-approval-route-${tx.id}`} />
              <RefCell lead={cols.account[0]} sub={cols.account[1]} testId={`finance-approval-account-${tx.id}`} />
              <RefCell lead={cols.txn[0]} sub={cols.txn[1]} testId={`finance-approval-txn-${tx.id}`} />
              <td className="whitespace-nowrap px-3 py-3 text-center" data-testid={`finance-approval-when-${tx.id}`}>
                <p className="text-xs text-slate-600">{fmtDate(tx.collected_at)}</p>
                {fmtTime(tx.collected_at) && (
                  <p className="text-[11px] text-slate-400">{fmtTime(tx.collected_at)}</p>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right font-bold text-emerald-600">{fmt(tx.amount)}</td>
              <td className="px-3 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => onApprove(tx)}
                    className="bg-emerald-600 hover:bg-emerald-700"
                    data-testid={`finance-approve-${tx.id}`}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />Approve
                  </Button>
                  {onDelete && (
                    <DeleteIcon
                      onClick={() => onDelete({ key: tx.id, head: tx, items: [tx] })}
                      disabled={busyId === tx.id}
                      testId={`finance-delete-${tx.id}`}
                    />
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

/**
 * The approved ledger, as a table — the same shape HR Admin's candidate list has, so a
 * list of records reads the same way on both desks: a header naming the columns, a row
 * per record, an action at the end of it and the arrow that opens it.
 *
 * A row is a lead, not a payment. The arrow opens it onto the payments underneath, which
 * is where a single fee can be sent back on its own; the row's own Undo returns all of
 * them. Nothing else on this board drills in, so opening happens in place rather than
 * navigating away.
 */
const ApprovedTable = ({ groups, busyId, onUndo, onDelete }) => {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm" data-testid="finance-approved-table">
        <thead className="bg-slate-500 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Patient</th>
            <th className="px-4 py-2.5 font-semibold">Branch</th>
            <th className="px-4 py-2.5 font-semibold">Payments</th>
            <th className="px-4 py-2.5 font-semibold">Mode</th>
            <th className="px-4 py-2.5 font-semibold">Date</th>
            <th className="px-4 py-2.5 font-semibold">Approved By</th>
            <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
            <th className="px-4 py-2.5" />
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groups.map((g) => {
            const isOpen = open.has(g.key);
            return (
              <Fragment key={g.key}>
                <tr
                  onClick={() => toggle(g.key)}
                  className={`cursor-pointer hover:bg-slate-50 ${isOpen ? "bg-slate-50" : ""}`}
                  data-testid={`finance-approval-row-${g.key}`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{g.head.patient_name}</p>
                    {g.items.length > 1 && (
                      <p className="text-[11px] font-semibold text-emerald-600">{g.items.length} payments</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{g.head.branch_name || "—"}</td>
                  <td className="px-4 py-3 capitalize text-slate-600">{g.categories.join(", ")}</td>
                  <td className="px-4 py-3 text-slate-600">{g.modes.join(", ") || "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{g.dateLabel || "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{g.approvers.join(", ") || "—"}</td>
                  <td className="px-4 py-3 text-right font-bold text-emerald-600">{fmt(g.total)}</td>
                  {/* The click that acts on a row must not also open it. */}
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onUndo(g)}
                        disabled={busyId === g.key}
                        data-testid={`finance-unapprove-${g.key}`}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />Undo
                      </Button>
                      {onDelete && (
                        <DeleteIcon
                          onClick={() => onDelete(g)}
                          disabled={busyId === g.key}
                          testId={`finance-delete-${g.key}`}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight
                      className={`ml-auto h-4 w-4 text-slate-300 transition-transform ${isOpen ? "rotate-90" : ""}`}
                      data-testid={`finance-approval-arrow-${g.key}`}
                    />
                  </td>
                </tr>
                {isOpen && g.items.map((t) => (
                  <tr key={t.id} className="bg-slate-50/60 text-xs" data-testid={`finance-approval-detail-${t.id}`}>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right text-slate-300">↳</td>
                    <td className="px-4 py-2 capitalize text-slate-600">{t.category}</td>
                    <td className="px-4 py-2 text-slate-600">{modeLabel(t.payment_mode)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">{(t.collected_at || "").slice(0, 10)}</td>
                    <td className="px-4 py-2 text-slate-500">{t.approved_by || "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold text-emerald-600">{fmt(t.amount)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onUndo({ key: t.id, items: [t] })}
                        disabled={busyId === t.id}
                        className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50"
                        data-testid={`finance-unapprove-one-${t.id}`}
                      >
                        Undo this
                      </button>
                    </td>
                    <td className="px-4 py-2" />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/**
 * Accountant > Approvals — "new income collected" waiting on sign-off, every kind of
 * revenue (consultation, treatment/session, diet, Fitsio Store) rather than just
 * consultation/package. Approving doesn't touch what counts as revenue anywhere else in
 * the OS — see approve_transaction's docstring — it only records that someone other
 * than whoever collected it looked the payment over, plus whatever the popup asked them
 * to confirm against the payment mode.
 *
 * `branchId`/`scoped` are the same pair ExpenseBoard and ProfitBoard take: passed by
 * Super Admin > Finance, whose branch-pill row has already picked the scope, and left off
 * on the Accountant's own board, where this keeps its own select.
 */
export const ApprovalsBoard = ({ pending = { income: 0, expenses: 0 }, onChanged = () => {}, branchId: branchIdProp, scoped = false }) => {
  const controlled = scoped;
  const [branches, setBranches] = useState([]);
  const [ownBranchId, setOwnBranchId] = useState("");
  const branchId = controlled ? (branchIdProp || "") : ownBranchId;
  const setBranchId = setOwnBranchId;
  const [mode, setMode] = useState("all"); // "all" | "online" | "offline"
  const [category, setCategory] = useState("all");
  const [paymentMode, setPaymentMode] = useState("all"); // "all" | "cash" | "upi" | "card" | "account_transfer" | "cheque"
  // The window both ledgers are read through. Held here rather than in each of them
  // because it is the one filter that means the same thing on either side -- a day's
  // collections and a day's spending are the same day -- so it is asked once, above the
  // ledger switch, and both /finance/approvals and /finance/expenses take it from here.
  const [preset, setPreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [startDate, endDate] = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );
  const pickDates = (key, from, to) => { setPreset(key); setCustomFrom(from); setCustomTo(to); };
  const [view, setView] = useState("pending"); // "pending" | "approved"
  const [ledger, setLedger] = useState("income"); // "income" | "expenses"
  const [data, setData] = useState({ transactions: [], summary: {} });
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Ids, not rows: the rows are replaced wholesale on every reload, and a set of objects
  // held across one would be comparing against rows that no longer exist.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);

  useEffect(() => { if (!controlled) getBranches().then(setBranches).catch(() => {}); }, [controlled]);

  const load = useCallback(async () => {
    // A half-typed custom range would ask for everything from one date to nothing, which
    // reads as an empty ledger rather than as an unfinished question. The list stays on
    // what it was showing until both ends are picked -- same rule Expense's row follows.
    if (rangeIncomplete(preset, customFrom, customTo)) return;
    setLoading(true);
    try {
      const params = { approved: view === "approved" };
      if (branchId) params.branch_id = branchId;
      if (mode !== "all") params.mode = mode;
      if (category !== "all") params.category = category;
      if (paymentMode !== "all") params.payment_mode = paymentMode;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      setData(await getFinanceApprovals(params));
      // Every filter change comes through here, and a selection that outlived one would
      // approve rows the accountant can no longer see. Cleared on the reload after an
      // approve too, where the picked rows have just left the list.
      setSelected(new Set());
    } catch { /* silent */ }
    setLoading(false);
  }, [branchId, mode, category, paymentMode, startDate, endDate, preset, customFrom, customTo, view]);

  useEffect(() => { load(); }, [load]);

  // One approved row can hold several payments of the same lead, so Undo takes them all
  // back to pending, where each is approved on its own again.
  // Deletes the payment at its source -- see delete_transaction. A grouped approved row
  // deletes every payment in it.
  const removePayments = async (group) => {
    const n = group.items.length;
    const who = group.head?.patient_name || "this client";
    if (!window.confirm(`Delete ${n > 1 ? `${n} payments` : "this payment"} of ${who}?\n\nThe fee goes back to owed on the client (a store sale's stock goes back on the shelf). This cannot be undone.`)) return;
    setBusyId(group.key);
    try {
      let last = "";
      for (const tx of group.items) last = (await deleteTransaction(tx.id))?.message || last;
      toast.success(n > 1 ? `${n} payments deleted` : last || "Payment deleted");
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not delete that"); }
    await load();
    onChanged();
    setBusyId(null);
  };

  const undo = async (group) => {
    setBusyId(group.key);
    try {
      for (const tx of group.items) await unapproveTransaction(tx.id);
      toast.success(group.items.length > 1 ? `${group.items.length} approvals removed` : "Approval removed");
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
    await load();
    onChanged();
    setBusyId(null);
  };

  // Only the pending list can be picked from: an approved row has an Undo instead, and
  // that is one at a time on purpose — see unapprove_transaction.
  const rows = data.transactions || [];
  const selectable = view === "pending" ? rows : [];
  // Plainly, not memoised: both inputs are rebuilt on every render, so a useMemo here
  // never actually hit its cache -- it only told the linter it was trying to.
  const picked = selectable.filter((t) => selected.has(t.id));
  const pickedTotal = picked.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const allOn = selectable.length > 0 && picked.length === selectable.length;

  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Everything currently listed, which is everything the filters above have left:
  // /finance/approvals returns the whole filtered set rather than a page of it, so "all"
  // here means all of what is being looked at, with nothing hidden behind it.
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(selectable.map((t) => t.id)));

  const bulkApprove = async () => {
    setBulkSaving(true);
    try {
      const res = await bulkApproveTransactions(picked.map((t) => t.id));
      toast.success(res?.message || "Approved");
      setBulkOpen(false);
      await load();
      onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Approve failed"); }
    setBulkSaving(false);
  };

  const s = data.summary || {};

  return (
    <div className="space-y-4" data-testid="finance-approvals-root">
      {/* One filter block for both ledgers. Its first line is the whole toolbar: which
          ledger is being signed off, then the vertical and branch, then the window pushed
          to the far end. The ledger switch used to be a full-width bar of its own above
          this block, which spent a band of screen on two buttons and split one set of
          questions across two boxes. What else is on the block follows the ledger: what it
          was for and how it was paid describe a collection and have nothing to say about
          an expense -- /finance/expenses does not take them -- so that line is not offered
          against one. Every control here is 2px-cornered, like Summary's cards. */}
      <div className="divide-y divide-slate-100 overflow-hidden rounded-[2px] border border-slate-200 bg-white" data-testid="finance-approvals-filters">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5" data-testid="finance-approvals-toolbar">
          <div className="flex shrink-0 items-center gap-0.5 rounded-[2px] border border-slate-200 bg-slate-50 p-0.5" data-testid="finance-approvals-ledger">
            {LEDGERS.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => setLedger(l.key)}
                aria-pressed={ledger === l.key}
                className={`relative whitespace-nowrap rounded-[2px] px-3 py-1 text-xs font-semibold transition ${ledger === l.key ? "bg-sky-500 text-white shadow-sm" : "text-slate-500 hover:bg-white"}`}
                data-testid={`finance-approvals-ledger-${l.key}`}
              >
                {l.label}
                {/* Which ledger the waiting items are in. Every branch, unfiltered -- see
                    AccountantBoard's pending -- so picking a branch beside it does not make
                    the other ledger's count look like it went away. */}
                <PendingBadge count={pending[l.key]} testId={`finance-approvals-ledger-badge-${l.key}`} />
              </button>
            ))}
          </div>

          <FilterGroup testId="finance-approvals-mode-filter">
            {VERTICALS.map(([key, label]) => (
              <FilterPill
                key={key}
                on={mode === key}
                onClick={() => setMode(key)}
                testId={`finance-approvals-mode-${key}`}
              >
                {label}
              </FilterPill>
            ))}
            {/* Already picked by the branch-pill row above this board when it is embedded
                in Super Admin's Finance screen — asking again underneath it would be a
                second answer to a question that has one. */}
            {!controlled && (
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="h-8 rounded-[2px] border border-slate-200 px-2 text-xs"
                data-testid="finance-approvals-branch"
              >
                <option value="">All Branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
              </select>
            )}
          </FilterGroup>

          {/* The shared finance row, so this desk and the three pages beside it name their
              windows with the same words and reach them the same way. Custom Range opens
              the dialog rather than dropping two date fields into the block underneath.
              The pill variant, not the toolbar button the other three carry: that one
              stands 8px taller than the pills sharing this line. */}
          <div className="min-w-0 sm:ml-auto">
            <FinanceDateFilter
              preset={preset}
              customFrom={customFrom}
              customTo={customTo}
              onChange={pickDates}
              presets={DATE_PRESETS}
              variant="pill"
              testid="finance-approvals-window"
            />
          </div>
        </div>

        {/* What it was for, and how it was paid. Both describe a collection and neither is
            a question /finance/expenses can answer, so the whole line goes when the ledger
            switches to expenses rather than sitting there greyed. */}
        {ledger === "income" && (
          <FilterRow>
            <FilterGroup testId="finance-approvals-category-filter">
              {CATEGORIES.map(([key, label]) => (
                <FilterPill
                  key={key}
                  on={category === key}
                  onClick={() => setCategory(key)}
                  testId={`finance-approvals-category-${key}`}
                >
                  {label}
                </FilterPill>
              ))}
            </FilterGroup>

            {/* Same set Branch Admin picks from when collecting the fee in the first
                place — not a category (what was paid for) but how, so it keeps the indigo
                it has always had rather than reading as more of the row beside it. */}
            <FilterGroup testId="finance-approvals-payment-mode-filter">
              {PAYMENT_MODES.map(([key, label]) => (
                <FilterPill
                  key={key}
                  accent="indigo"
                  on={paymentMode === key}
                  onClick={() => setPaymentMode(key)}
                  testId={`finance-approvals-payment-mode-${key}`}
                >
                  {label}
                </FilterPill>
              ))}
            </FilterGroup>
          </FilterRow>
        )}
      </div>

      {ledger === "expenses" && (
        <ExpenseApprovalsPanel
          onChanged={onChanged}
          branchId={branchId}
          mode={mode}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {ledger === "income" && (
      <>
      {/* The cards are the switch. A Pending/Approved toggle underneath them said the
          same two words a second time, in a smaller font, directly below the pair already
          naming each side and totalling it — so the pair does the picking now. */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { key: "pending", label: "Pending Approval", total: s.pending_total, count: s.pending_count, ring: "#d97706", border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-700", sub: "text-amber-600" },
          { key: "approved", label: "Approved", total: s.approved_total, count: s.approved_count, ring: "#059669", border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-700", sub: "text-emerald-600" },
        ].map((c) => {
          const on = view === c.key;
          // Summary's ledger cards: tinted, 2px corners, the picked one outlined in its own
          // colour and the other stepping back to 70%.
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setView(c.key)}
              aria-pressed={on}
              className={`rounded-[2px] border ${c.border} ${c.bg} p-4 text-left transition ${on ? "" : "opacity-70 hover:opacity-100"}`}
              style={on ? { borderColor: c.ring } : undefined}
              data-testid={`finance-approvals-${c.key}-card`}
            >
              <p className={`text-[11px] font-bold uppercase tracking-wider ${c.text}`}>{c.label}</p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${c.text}`}>{fmt(c.total)}</p>
              <p className={`text-[11px] ${c.sub}`}>{c.count || 0} payments</p>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow" data-testid="finance-approvals-summary">
        {/* One bar, two jobs. Idle it names the list and offers the tick that takes all of
            it; with anything picked it becomes the bar that acts on the picking, carrying
            the count and the money so neither has to be totted up by eye. Not a second bar
            appearing above the first, which would push the whole list down a row on the
            first click. */}
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
          {selectable.length > 0 && (
            <TickBox
              state={allOn ? "on" : picked.length > 0 ? "some" : "off"}
              onChange={toggleAll}
              label={allOn ? "Clear the selection" : `Select all ${selectable.length} payments`}
            />
          )}
          {picked.length > 0 ? (
            <>
              <p className="text-xs font-semibold text-slate-700" data-testid="finance-approvals-selection-count">
                {picked.length} selected
                <span className="ml-1.5 font-bold text-emerald-700">{fmt(pickedTotal)}</span>
              </p>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                data-testid="finance-approvals-clear-selection"
              >
                Clear
              </button>
              <Button
                size="sm"
                onClick={() => setBulkOpen(true)}
                className="ml-auto h-7 bg-emerald-600 text-xs hover:bg-emerald-700"
                data-testid="finance-approvals-approve-selected"
              >
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                Approve {picked.length}
              </Button>
            </>
          ) : (
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Payment Summary
              {selectable.length > 0 && (
                <span className="ml-2 font-medium normal-case tracking-normal text-slate-400">
                  tick to approve several at once
                </span>
              )}
            </p>
          )}
        </div>
        <div className="divide-y divide-slate-50">
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">
              {view === "pending" ? "Nothing waiting on approval." : "Nothing approved yet."}
            </p>
          ) : view === "approved" ? (
            <ApprovedTable groups={groupByLead(rows)} busyId={busyId} onUndo={undo} onDelete={data.delete_enabled ? removePayments : null} />
          ) : (
            <PendingTable rows={rows} selected={selected} onToggle={toggleOne} onApprove={setApproving} onDelete={data.delete_enabled ? removePayments : null} busyId={busyId} />
          )}
        </div>
      </div>

      </>
      )}

      {bulkOpen && (
        <BulkApproveModal
          count={picked.length}
          total={pickedTotal}
          saving={bulkSaving}
          onClose={() => setBulkOpen(false)}
          onConfirm={bulkApprove}
        />
      )}

      {approving && (
        <ApproveModal
          tx={approving}
          onClose={() => setApproving(null)}
          onApproved={() => { setApproving(null); load(); onChanged(); }}
        />
      )}
    </div>
  );
};
