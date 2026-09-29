import { useEffect, useState } from "react";
import { X, Mail, Printer, FileText, MessageCircle, Wallet, PhoneCall, ChevronDown } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { getClientTransactionHistory, markInstallmentPaid } from "@/lib/api";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (d) => (d ? (d.length > 10 ? d.slice(0, 16).replace("T", " ") : d) : "—");
const formatMode = (mode) => (mode ? (mode === "upi" ? "UPI" : mode.charAt(0).toUpperCase() + mode.slice(1)) : "");

const STATUS_STYLES = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  processing: "bg-amber-50 text-amber-700 border-amber-200",
};

const BALANCE_STATUS_META = {
  paid: { label: "Paid", classes: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  overdue: { label: "Overdue", classes: "bg-rose-100 text-rose-700 border-rose-200" },
  due_soon: { label: "Due Soon", classes: "bg-amber-100 text-amber-700 border-amber-200" },
  partial: { label: "Partial", classes: "bg-sky-100 text-sky-700 border-sky-200" },
};

const SCHEDULE_STATUS_META = {
  paid: { label: "Paid", classes: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  overdue: { label: "Overdue", classes: "bg-rose-100 text-rose-700 border-rose-200" },
  due_today: { label: "Due", classes: "bg-amber-100 text-amber-700 border-amber-200" },
  upcoming: { label: "Upcoming", classes: "bg-orange-100 text-orange-700 border-orange-200" },
};

const Badge = ({ meta }) => (
  <span className={`inline-flex items-center rounded-[5px] border px-2 py-0.5 text-[10px] font-semibold ${meta.classes}`}>
    {meta.label}
  </span>
);

/** "2026-08-06T07:26:11Z" -> "06 Aug 2026" */
const fmtDay = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/** "2026-08-06T07:26:11Z" -> "06 Aug, 07:26" */
const fmtDayTime = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 16).replace("T", " ");
  return `${dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}, ${dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

/** One figure in the money strip, with a colour tick tying it to its share of the bar. */
const MoneyStat = ({ tick, label, value, sub, valueClass = "text-slate-900" }) => (
  <div>
    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
      <span className={`inline-block h-0.5 w-2.5 rounded-full ${tick}`} />
      {label}
    </p>
    <p className={`mt-0.5 font-mono text-lg font-semibold tabular-nums ${valueClass}`}>{value}</p>
    {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
  </div>
);

const INFO_BOX_NEUTRAL = "border-slate-200 bg-slate-50 text-slate-700";

// The same four modes, colours and mode-specific fields the Consultations board
// collects with — a payment recorded from here has to be indistinguishable from one
// recorded there, or Accountant Manage ends up with two grades of record.
const COLLECT_MODES = [
  { value: "cash", label: "Cash", classes: "border-emerald-300 bg-emerald-50 text-emerald-700", active: "border-emerald-500 bg-emerald-600 text-white" },
  { value: "upi", label: "UPI", classes: "border-sky-300 bg-sky-50 text-sky-700", active: "border-sky-500 bg-sky-600 text-white" },
  { value: "card", label: "Card", classes: "border-violet-300 bg-violet-50 text-violet-700", active: "border-violet-500 bg-violet-600 text-white" },
  { value: "account_transfer", label: "Account Transfer", classes: "border-cyan-300 bg-cyan-50 text-cyan-700", active: "border-cyan-500 bg-cyan-600 text-white" },
  { value: "cheque", label: "Cheque", classes: "border-amber-300 bg-amber-50 text-amber-700", active: "border-amber-500 bg-amber-600 text-white" },
];

const emptyCollectDraft = {
  amount: "",
  payment_mode: "cash",
  upi_transaction_id: "",
  card_transaction_id: "",
  account_number: "", account_holder_name: "", bank_name: "", ifsc_code: "",
  cheque_number: "", transfer_reference: "",
};

/** A payment's discount as a percentage of the price it was taken off, to 2dp with any
 *  trailing zeros dropped (25, not 25.00). Null when there's no original price to measure
 *  against, so the caller shows nothing rather than a meaningless 0%. */
const discountPct = (tx) => {
  const original = Number(tx.original_amount);
  const discount = Number(tx.discount_amount);
  if (!Number.isFinite(original) || original <= 0 || !Number.isFinite(discount) || !discount) return null;
  return Number((Math.abs(discount) / original * 100).toFixed(2));
};

const CollectField = ({ label, value, onChange, placeholder, testid }) => (
  <label className="block">
    <span className="mb-1 block text-[11px] font-semibold text-slate-600">{label}</span>
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
      data-testid={testid}
    />
  </label>
);

/** The reference a paid installment carries, as short chips — how it was paid and the
 *  proof of it. Nothing renders for a mode that has no reference (cash). */
const paidReference = (s) => [
  s.upi_transaction_id && `Txn ${s.upi_transaction_id}`,
  s.upi_utr && `UTR ${s.upi_utr}`,
  s.card_transaction_id && `Card txn ${s.card_transaction_id}`,
  s.account_last4 && `A/C ****${s.account_last4}`,
  s.account_holder_name,
  s.cheque_number && `Cheque #${s.cheque_number}`,
  s.bank_name,
  s.ifsc_code,
].filter(Boolean);

/** The same reference, pulled back out of an activity-log line for the transaction list,
 *  which only ever receives the rendered sentence. Anything before the mode marker is
 *  the description, not a reference, so it's left alone. */
const detailReference = (details) => {
  const m = /·\s*(UPI txn|UTR|Card txn|A\/C \*\*\*\*|Cheque #)/.exec(details || "");
  return m ? details.slice(m.index + 1).trim() : "";
};

const InfoBox = ({ children, className = INFO_BOX_NEUTRAL }) => (
  <div className={`rounded-md border px-2.5 py-1.5 ${className}`}>
    {children}
  </div>
);

/** Label left, value right, hairline between — for facts that are read, not scanned. */
const StatRows = ({ rows }) => (
  <dl className="divide-y divide-slate-100 border-y border-slate-100">
    {rows.filter(Boolean).map(([label, value]) => (
      <div key={label} className="flex items-baseline justify-between gap-4 py-1.5">
        <dt className="shrink-0 text-[11px] text-slate-400">{label}</dt>
        <dd className="text-right text-xs text-slate-700">{value}</dd>
      </div>
    ))}
  </dl>
);

/**
 * One expandable card per collection. Collapsed it answers "how much, when, how"; opened
 * it shows the arithmetic and the references an accountant needs to trace it.
 *
 * Everything here comes off the transaction record — nothing is inferred. A field with no
 * value is dropped rather than shown blank, so what remains is all true.
 */
const PaymentCards = ({ transactions, servicedBy }) => {
  const [openId, setOpenId] = useState(transactions[0]?.id || null);
  if (transactions.length === 0) {
    return <p className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">No payments recorded yet.</p>;
  }
  return (
    <div className="space-y-2" data-testid="client-history-transactions">
      {transactions.map((tx) => {
        const open = openId === tx.id;
        const off = Number(tx.discount_amount) || 0;
        const pct = discountPct(tx);
        return (
          <div key={tx.id} className="overflow-hidden rounded-lg border border-slate-200" data-testid={`client-history-tx-${tx.id}`}>
            <button
              type="button"
              onClick={() => setOpenId(open ? null : tx.id)}
              className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
              data-testid={`client-history-tx-toggle-${tx.id}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "" : "-rotate-90"}`} />
                <span className="min-w-0">
                  <span className="text-sm font-semibold capitalize text-slate-800">{tx.source}</span>
                  <span className="ml-2 text-[11px] text-slate-400">{fmtDayTime(tx.date)} · {formatMode(tx.payment_mode)}</span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-sm font-semibold tabular-nums text-slate-900">{fmt(tx.amount)}</span>
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-teal-700">Paid in full</span>
              </span>
            </button>

            {open && (
              <div className="border-t border-slate-100 px-3 py-2.5">
                {/* The arithmetic in one line, so a discounted payment explains itself
                    rather than needing three labelled boxes to say the same thing. */}
                {off > 0 && (
                  <p className="mb-2.5 font-mono text-xs tabular-nums text-slate-500" data-testid={`client-history-tx-maths-${tx.id}`}>
                    {fmt(tx.original_amount).replace("Rs.", "")} <span className="text-slate-300">−</span>{" "}
                    <span className="text-amber-700">{fmt(off).replace("Rs.", "")}</span>
                    {pct != null && (
                      <span className="ml-1 rounded bg-amber-100 px-1 py-px text-[10px] font-bold text-amber-800" data-testid={`client-history-tx-discount-pct-${tx.id}`}>{pct}%</span>
                    )}{" "}
                    <span className="text-slate-300">=</span>{" "}
                    <span className="font-semibold text-slate-800">{fmt(tx.amount).replace("Rs.", "")}</span>{" "}
                    <span className="text-slate-400">collected</span>
                  </p>
                )}
                <StatRows rows={[
                  tx.transaction_id && ["Transaction", <span key="t" className="font-mono">{tx.transaction_id}</span>],
                  !tx.transaction_id && tx.receipt_no && ["Receipt", <span key="r" className="font-mono">{tx.receipt_no}</span>],
                  tx.collected_by && ["Collected by", tx.collected_by_role ? `${tx.collected_by} · ${formatMode(tx.collected_by_role).replace(/_/g, " ")}` : tx.collected_by],
                  off > 0 && tx.discount_reason && ["Discount", tx.discount_reason],
                  detailReference(tx.details) && ["Reference", <span key="ref" className="break-all font-mono">{detailReference(tx.details)}</span>],
                  servicedBy && ["Service by", servicedBy],
                ]} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** The treatment course as quoted, and how much of it has been paid for. Deliberately
 *  silent on sessions *used* — attendance isn't recorded anywhere, so any "0 of 6 used"
 *  would be a claim this screen can't stand behind. */
const SessionPackageCard = ({ pd }) => {
  const count = Number(pd.session_package_sessions) || 0;
  const price = Number(pd.session_package_price) || 0;
  const paid = Number(pd.session_paid) || 0;
  const purchased = paid > 0;
  const perSession = count > 0 && price > 0 ? Math.round(price / count) : null;
  return (
    <div className="rounded-lg border border-slate-200 p-3" data-testid="client-history-session-package">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-slate-800">{count > 0 ? `${count}-session course` : "Treatment package"}</p>
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${purchased ? "text-teal-700" : "text-slate-400"}`}>
          {purchased ? (pd.session_due > 0 ? "Part paid" : "Purchased") : "Not purchased"}
        </span>
      </div>
      {count > 0 && count <= 24 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {Array.from({ length: count }, (_, i) => (
            <span
              key={i}
              className={`flex h-6 min-w-6 items-center justify-center rounded border px-1.5 font-mono text-[11px] ${purchased ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-300"}`}
            >
              {i + 1}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
        <span className="text-slate-400">{purchased ? `${fmt(paid)} paid` : "Nothing paid yet"}</span>
        {price > 0 && (
          <span className="text-slate-500">
            Quoted <span className="font-mono">{fmt(price)}</span>
            {perSession && <span className="text-slate-400"> · {fmt(perSession)}/session</span>}
          </span>
        )}
      </div>
    </div>
  );
};

/** What to do about this client, worked out from their actual state. No recommendation is
 *  stored anywhere, so this reports the position rather than inventing clinical advice. */
const NextStep = ({ pd, balance, hasSchedule }) => {
  const quoted = Number(pd.session_package_price) || 0;
  const paid = Number(pd.session_paid) || 0;

  // Money owed is red and loud; a package merely never taken up is amber and quieter;
  // nothing due is grey. The amount carries the weight, so it's set larger than the body
  // rather than being another line of the same small text.
  let tone = "border-slate-300 bg-slate-50";
  let titleClass = "text-slate-800";
  let bodyClass = "text-slate-600";
  let title = "Nothing outstanding";
  let body = "This client is fully settled. No action needed.";

  if (balance > 0) {
    tone = "border-rose-600 bg-rose-50";
    titleClass = "text-rose-900";
    bodyClass = "text-rose-800";
    title = `${fmt(balance)} outstanding`;
    body = hasSchedule
      ? `${pd.next_installment_label || "Installment"} #${pd.next_installment_number} is the next one due. Collect it from this screen.`
      : "Not on an installment schedule — collect it from the client's card in Consultations.";
  } else if (quoted > 0 && paid <= 0) {
    tone = "border-amber-500 bg-amber-50";
    titleClass = "text-amber-900";
    bodyClass = "text-amber-800";
    title = "Package not purchased";
    body = `A course was quoted at ${fmt(quoted)} during the consultation but nothing has been collected for it yet.`;
  }

  return (
    <div className={`rounded-r-md border-l-4 px-3 py-2.5 ${tone}`} data-testid="client-history-next-step">
      <p className={`text-sm font-bold ${titleClass}`}>{title}</p>
      <p className={`mt-0.5 text-[11px] font-medium leading-relaxed ${bodyClass}`}>{body}</p>
    </div>
  );
};

const downloadInvoice = (client, data) => {
  const lines = [
    `Invoice — ${client.name}`,
    client.phone ? `Phone: ${client.phone}` : "",
    client.email ? `Email: ${client.email}` : "",
    client.branch_name ? `Branch: ${client.branch_name}` : "",
    "",
    "Date,Type,Payment Mode,Amount,Receipt No",
    ...(data.transactions || []).map((tx) => `${(tx.date || "").slice(0, 10)},${tx.source},${tx.payment_mode},${tx.amount},${tx.receipt_no || ""}`),
    "",
    `Outstanding Balance,,,${data.balance}`,
  ].filter(Boolean).join("\n");
  const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${client.name.replace(/\s+/g, "-").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Client Details modal — a client's profile, current outstanding balance, full
 * payment history, and complete activity timeline. Opened via the eye icon from
 * Transactions History, Accountant Manage's Collections tables, and Total Revenue.
 * Two sub-tabs: Overview (client + payment details + completed status) and
 * Timeline (the client's overall activity feed).
 */
export const ClientHistoryModal = ({ leadId, onClose, onChanged }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("overview");
  const [recording, setRecording] = useState(false);
  const [collectDraft, setCollectDraft] = useState(null);

  const load = () => {
    setLoading(true);
    getClientTransactionHistory(leadId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [leadId]);

  const client = data?.client;
  const pd = data?.payment_details || {};
  const schedule = data?.schedule || [];
  const transactions = data?.transactions || [];
  const timeline = data?.timeline || [];
  const status = data?.status || "processing";
  const balanceMeta = BALANCE_STATUS_META[data?.balance_status] || BALANCE_STATUS_META.partial;

  const sendReminder = () => {
    if (!client?.phone) return;
    const digits = client.phone.replace(/[^0-9]/g, "");
    const msg = encodeURIComponent(`Hi ${client.name}, this is a reminder that you have an outstanding balance of ${fmt(data.balance)}. Kindly clear it at your earliest convenience.`);
    // Same-tab handoff, not window.open(..., "_blank") — see caf18a6: the new-tab route
    // leaves mobile browsers on a blank white screen when WhatsApp returns control.
    window.location.href = `https://wa.me/${digits}?text=${msg}`;
  };

  const sendEmailReminder = () => {
    if (!client?.email) return;
    const subject = encodeURIComponent("Outstanding Payment Reminder");
    const body = encodeURIComponent(`Hi ${client.name},\n\nThis is a reminder that you have an outstanding balance of ${fmt(data.balance)}.\n\nKindly clear it at your earliest convenience.`);
    window.location.href = `mailto:${client.email}?subject=${subject}&body=${body}`;
  };

  const callClient = () => {
    if (!client?.phone) return;
    window.location.href = `tel:${client.phone.replace(/[^0-9+]/g, "")}`;
  };

  // Numbering restarts per fee, so a row is identified by both — matching on the number
  // alone would find, say, the Consultation Fee's row #2 when the Diet Fee's is due.
  const nextInstallment = schedule.find(
    (s) => s.installment_number === pd.next_installment_number && s.fee === (pd.next_installment_fee || "treatment")
  );

  /** Opens the confirmation popup rather than collecting on the spot. Money changing
   *  hands off a single unguarded click is how a client gets charged twice. */
  const openCollect = () => {
    if (!pd.next_installment_number) return;
    setCollectDraft({ ...emptyCollectDraft, amount: nextInstallment?.amount ? String(nextInstallment.amount) : "" });
  };

  const setDraft = (patch) => setCollectDraft((d) => ({ ...d, ...patch }));

  const submitCollect = async () => {
    const draft = collectDraft;
    const amount = parseFloat(draft.amount);
    if (!(amount > 0)) {
      toast.error("Enter a valid amount");
      return;
    }
    const mode = draft.payment_mode;
    const payload = { payment_mode: mode, amount };
    // Validated here as well as on the server so the popup keeps what was typed —
    // a round trip that fails would otherwise send them back to an empty form.
    if (mode === "upi") {
      payload.upi_transaction_id = draft.upi_transaction_id.trim();
    } else if (mode === "card") {
      // The terminal's transaction id, and nothing else — the desk cannot read an account
      // number or an IFSC off a card, so asking for them only ever got them invented.
      if (!draft.card_transaction_id.trim()) {
        toast.error("Card Transaction ID is required");
        return;
      }
      payload.card_transaction_id = draft.card_transaction_id.trim();
    } else if (mode === "account_transfer") {
      if (!draft.account_number.trim() || !draft.account_holder_name.trim() || !draft.bank_name.trim() || !draft.ifsc_code.trim()) {
        toast.error("Account Number, Account Holder Name, Bank Name and IFSC Code are required");
        return;
      }
      if (!draft.transfer_reference.trim()) {
        toast.error("Reference / UTR No. is required for an Account Transfer");
        return;
      }
      payload.account_number = draft.account_number.trim();
      payload.account_holder_name = draft.account_holder_name.trim();
      payload.bank_name = draft.bank_name.trim();
      payload.ifsc_code = draft.ifsc_code.trim();
      payload.transfer_reference = draft.transfer_reference.trim();
    } else if (mode === "cheque") {
      if (!draft.bank_name.trim() || !draft.cheque_number.trim()) {
        toast.error("Bank Name and Cheque Number are required");
        return;
      }
      payload.bank_name = draft.bank_name.trim();
      payload.cheque_number = draft.cheque_number.trim();
    }

    setRecording(true);
    try {
      // Which fee's balance this is. Omitted, the server would take it as the Treatment
      // Fee's — the only schedule that existed when that default was written.
      payload.fee = pd.next_installment_fee || "treatment";
      await markInstallmentPaid(leadId, pd.next_installment_number, payload);
      toast.success(`${fmt(amount)} collected from ${client.name}`);
      setCollectDraft(null);
      load();
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to record payment");
    }
    setRecording(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="client-history-modal">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-slate-900" data-testid="client-history-name">{client?.name || "Loading..."}</h3>
              {client && (
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status]}`} data-testid="client-history-status">
                  <span className={`h-1.5 w-1.5 rounded-full ${status === "done" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {status === "done" ? "Completed" : "In Progress"}
                </span>
              )}
            </div>
            {/* Identity in one line: who, where, their file number, and when they first
                came in. Each part is dropped rather than shown blank when absent. */}
            {client && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500" data-testid="client-history-meta">
                {[
                  client.phone,
                  client.branch_name,
                  client.patient_number && <span key="pn" className="font-mono">{client.patient_number}</span>,
                  client.first_seen && `First seen ${fmtDay(client.first_seen)}`,
                ].filter(Boolean).map((part, i, arr) => (
                  <span key={i} className="flex items-center gap-2">
                    {part}
                    {i < arr.length - 1 && <span className="text-slate-300">·</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" data-testid="client-history-close"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-5">
          {[
            { key: "overview", label: "Overview", count: null },
            { key: "transactions", label: "Transactions", count: transactions.length },
            { key: "timeline", label: "Timeline", count: timeline.length },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${tab === t.key ? "border-teal-600 text-teal-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              data-testid={`client-history-tab-${t.key}`}
            >
              {t.label}
              {/* The count belongs on the tab: it says whether opening it is worth the
                  click, which the label alone never does. */}
              {t.count != null && <span className="ml-1.5 text-[11px] tabular-nums text-slate-400">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* The money strip — the whole financial position in one line, kept above the
            tabs' content so it reads the same wherever you are. Billed is derived, not
            stored: what was collected, plus what was given away, plus what is still
            owed, is by definition what was billed. */}
        {!loading && data && (() => {
          const collected = transactions.reduce((s, t) => s + (Number(t.amount) || 0), 0);
          const discount = transactions.reduce((s, t) => s + Math.max(Number(t.discount_amount) || 0, 0), 0);
          const due = Number(data.balance) || 0;
          const billed = collected + discount + due;
          const pct = (n) => (billed > 0 ? Math.max((n / billed) * 100, 0) : 0);
          // The single discount's own percentage, quoted only when there is exactly one —
          // averaging several across different prices would be a made-up number.
          const discounted = transactions.filter((t) => Number(t.discount_amount) > 0);
          const solePct = discounted.length === 1 ? discountPct(discounted[0]) : null;
          return (
            <div className="border-b border-slate-200 bg-slate-50/60 px-5 py-3" data-testid="client-history-money-strip">
              <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div className="bg-teal-600" style={{ width: `${pct(collected)}%` }} title={`Collected ${fmt(collected)}`} />
                {/* Hatched, because a discount is money that was never taken — it should
                    not read as solidly as money that was. */}
                <div
                  style={{
                    width: `${pct(discount)}%`,
                    backgroundImage: "repeating-linear-gradient(45deg, #f59e0b 0 3px, #fde68a 3px 6px)",
                  }}
                  title={`Discount ${fmt(discount)}`}
                />
                <div className="bg-rose-300" style={{ width: `${pct(due)}%` }} title={`Due ${fmt(due)}`} />
              </div>

              <div className="mt-2.5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
                  <MoneyStat tick="bg-slate-400" label="Billed" value={fmt(billed)} />
                  <MoneyStat
                    tick="bg-amber-400" label="Discount"
                    value={discount > 0 ? `−${fmt(discount)}` : fmt(0)}
                    valueClass={discount > 0 ? "text-amber-700" : "text-slate-400"}
                    sub={solePct != null ? `${solePct}% off` : null}
                  />
                  <MoneyStat
                    tick="bg-teal-600" label="Collected" value={fmt(collected)}
                    valueClass="text-teal-700"
                    sub={pd.consultation_payment_mode ? formatMode(pd.consultation_payment_mode) : null}
                  />
                  <MoneyStat
                    tick="bg-rose-300" label="Due" value={fmt(due)}
                    valueClass={due > 0 ? "text-rose-700" : "text-slate-400"}
                    sub={`Next due ${data.next_due_date || "—"}`}
                  />
                </div>
                <div className="text-right">
                  <p className={`text-xs font-semibold ${due > 0 ? "text-rose-700" : "text-teal-700"}`}>
                    {due > 0 ? balanceMeta.label : "Settled"}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {data.last_payment_date ? `Last payment ${fmtDayTime(data.last_payment_date)}` : "No payments yet"}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading ? (
            <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
          ) : !data ? (
            <p className="py-10 text-center text-sm text-slate-400">Failed to load client details.</p>
          ) : tab === "overview" ? (
            <>
              <div className="grid grid-cols-1 items-start gap-x-8 gap-y-6 lg:grid-cols-[1.15fr_1fr]">
              {/* ---- left: what has actually been paid ---- */}
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Payments</h4>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    {transactions.length === 0 ? "None yet" : `${transactions.length} of ${transactions.length} settled`}
                  </span>
                </div>
                <PaymentCards transactions={transactions} servicedBy={client?.assigned_physio_name} />
                {data.balance <= 0 && transactions.length > 0 && (
                  <div className="rounded-r-md border-l-2 border-teal-600 bg-teal-50/60 px-3 py-2.5" data-testid="client-history-collect-note">
                    <p className="text-xs font-semibold text-teal-800">Nothing left to collect</p>
                    <p className="mt-0.5 text-[11px] text-teal-700">This client is fully paid. Print the receipt or send it on WhatsApp to close the visit.</p>
                  </div>
                )}
                {data.balance > 0 && !pd.next_installment_number && (
                  <div className="rounded-r-md border-l-4 border-rose-600 bg-rose-50 px-3 py-2.5" data-testid="client-history-collect-note">
                    <p className="text-sm font-bold text-rose-900">{fmt(data.balance)} outstanding</p>
                    <p className="mt-0.5 text-[11px] font-medium text-rose-800">This balance isn't on an installment schedule — collect it from the client's card in Consultations.</p>
                  </div>
                )}
              </div>

              {/* ---- right: the course, what to do next, how to reach them ---- */}
              <div className="space-y-6">
                {(pd.session_package_sessions || pd.session_package_price || pd.session_total > 0) && (
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Session Package</h4>
                    <SessionPackageCard pd={pd} />
                  </div>
                )}

                <div className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Next Step</h4>
                  <NextStep pd={pd} balance={data.balance} hasSchedule={schedule.length > 0} />
                </div>

                <div className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Contact</h4>
                  <StatRows rows={[
                    ["Phone", client?.phone || "Not on file"],
                    ["Email", client?.email || "Not on file"],
                    client?.source && ["Source", client.source],
                    client?.assigned_physio_name && ["Expert", client.assigned_physio_name],
                  ]} />
                </div>
              </div>
              </div>

              {schedule.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Payment Schedule</p>
                  <div className="space-y-1.5">
                    {schedule.map((s) => (
                      <div key={`${s.fee || "treatment"}-${s.installment_number}`} className="rounded-lg border border-slate-100 px-3 py-1.5 text-xs" data-testid={`client-history-schedule-${s.fee || "treatment"}-${s.installment_number}`}>
                        {/* Which fee this row belongs to. Numbering restarts per fee, so
                            without it a client owing on two reads as "#1, #2, #1, #2". */}
                        {s.fee_label && <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{s.fee_label}</p>}
                        <div className="flex items-center justify-between">
                          <span className="w-8 font-medium text-slate-500">#{s.installment_number}</span>
                          <span className="flex-1"><Badge meta={SCHEDULE_STATUS_META[s.status] || SCHEDULE_STATUS_META.upcoming} /></span>
                          <span className="w-20 text-right font-semibold text-slate-700">{fmt(s.amount)}</span>
                          <span className="w-24 text-right text-slate-400">{s.due_date}</span>
                        </div>
                        {/* How this one was settled, once it has been — the UTR or cheque
                            number is the only way to match it to a bank statement later. */}
                        {s.payment_mode && (
                          <div className="mt-1 flex flex-wrap items-center gap-1 pl-8" data-testid={`client-history-schedule-ref-${s.fee || "treatment"}-${s.installment_number}`}>
                            <span className="rounded-[4px] border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{formatMode(s.payment_mode)}</span>
                            {paidReference(s).map((chip) => (
                              <span key={chip} className="rounded-[4px] bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">{chip}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </>
          ) : tab === "transactions" ? (
            <PaymentCards transactions={transactions} servicedBy={client?.assigned_physio_name} />
          ) : (
            <div className="space-y-2">
              {timeline.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">No activity yet.</p>
              ) : timeline.map((ev) => (
                <div key={ev.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs" data-testid={`client-history-event-${ev.id}`}>
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <div>
                    <p className="text-slate-700">{ev.details}</p>
                    <p className="mt-0.5 text-[10px] text-slate-400">{fmtDate(ev.created_at)} · {ev.created_by}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* The actions live in a fixed footer rather than a grid inside the scroll area:
            they apply to the client, not to whichever tab happens to be open, and they
            should still be reachable at the bottom of a long timeline.

            All five on one row at every width. On a phone they are icons alone, sharing
            the row equally so each is a full tap target; the words return from sm up.
            Every label stays on title/aria-label, so the icon-only state still says what
            it does to a screen reader and on a long press. */}
        {!loading && data && (
          <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
            <div className="flex items-center gap-1.5 sm:contents">
              <button type="button" onClick={() => window.print()} title="Print receipt" aria-label="Print receipt" className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-2 py-2.5 text-xs font-semibold text-white hover:bg-teal-800 sm:flex-none sm:px-3 sm:py-2" data-testid="client-history-print">
                <Printer className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Print receipt</span>
              </button>
              <button type="button" onClick={() => downloadInvoice(client, data)} title="Download invoice" aria-label="Download invoice" className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:flex-none sm:px-3 sm:py-2" data-testid="client-history-invoice">
                <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Download invoice</span>
              </button>
              {/* Off for a Past Data trial client: their balance is what an Excel sheet said,
                  shown to read, and no one on the OS asked them for it. Email below too. */}
              <button type="button" onClick={sendReminder} disabled={!client?.phone || client?.past_data} title="Send on WhatsApp" aria-label="Send on WhatsApp" className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-3 sm:py-2" data-testid="client-history-reminder">
                <MessageCircle className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Send on WhatsApp</span>
              </button>
              <button type="button" onClick={callClient} disabled={!client?.phone} title="Call" aria-label="Call" className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-3 sm:py-2" data-testid="client-history-call">
                <PhoneCall className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Call</span>
              </button>
              {/* Not in the design, kept anyway: emailing a reminder already worked, and a
                  layout change is no reason to take a working action away. */}
              <button type="button" onClick={sendEmailReminder} disabled={!client?.email || client?.past_data} title="Email" aria-label="Email" className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-3 sm:py-2" data-testid="client-history-email">
                <Mail className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Email</span>
              </button>
            </div>
            {/* Collecting from here only ever works against an installment schedule, so
                rather than a dead grey button the footer says why it's unavailable. */}
            <div className="text-right text-[11px] text-slate-400 sm:ml-auto">
              {pd.next_installment_number ? (
                <button
                  type="button" onClick={openCollect} disabled={recording}
                  className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                  data-testid="client-history-record-payment"
                >
                  <Wallet className="h-3.5 w-3.5" /> {recording ? "Saving..." : `Collect ${pd.next_installment_label || "installment"} #${pd.next_installment_number}`}
                </button>
              ) : (
                <span data-testid="client-history-collect-note">
                  Collect payment is off — <span className="font-semibold text-slate-500">{data.balance > 0 ? "not on a schedule" : "nothing outstanding"}</span>
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {collectDraft && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !recording) setCollectDraft(null); }}
          data-testid="client-collect-modal"
        >
          <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-3.5 text-white">
              <div className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                <p className="text-base font-semibold">Collect Payment</p>
              </div>
              <button onClick={() => !recording && setCollectDraft(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="client-collect-close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* What exactly is being collected, before any of it is typed — the whole
                  point of the confirmation step. */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  {pd.next_installment_label || "Installment"} #{pd.next_installment_number}
                  {/* installments_total counts the Treatment Fee's schedule, so "of N"
                      is only true when that is the fee being collected. */}
                  {pd.next_installment_fee === "treatment" && pd.installments_total ? ` of ${pd.installments_total}` : ""}
                </p>
                <p className="mt-0.5 text-2xl font-bold text-emerald-700">{fmt(nextInstallment?.amount)}</p>
                <p className="mt-0.5 text-[11px] text-emerald-700/80">
                  {client?.name}{nextInstallment?.due_date ? ` · due ${nextInstallment.due_date}` : ""}
                </p>
              </div>

              <div className="mt-4 space-y-3">
                <CollectField
                  label="Amount Collected"
                  value={collectDraft.amount}
                  onChange={(e) => setDraft({ amount: e.target.value })}
                  placeholder="0"
                  testid="client-collect-amount"
                />

                <div>
                  <span className="mb-1 block text-[11px] font-semibold text-slate-600">Payment Mode</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {COLLECT_MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => setDraft({ payment_mode: m.value })}
                        className={`rounded-md border px-2 py-1.5 text-xs font-semibold transition ${collectDraft.payment_mode === m.value ? m.active : m.classes}`}
                        data-testid={`client-collect-mode-${m.value}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {collectDraft.payment_mode === "upi" && (
                  <div className="space-y-3 rounded-lg border border-sky-100 bg-sky-50/50 p-3">
                    <CollectField label="UPI Transaction ID" value={collectDraft.upi_transaction_id} onChange={(e) => setDraft({ upi_transaction_id: e.target.value })} placeholder="e.g. 428301947281" testid="client-collect-upi-txn" />
                  </div>
                )}

                {collectDraft.payment_mode === "card" && (
                  <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/50 p-3">
                    <CollectField label="Transaction ID *" value={collectDraft.card_transaction_id} onChange={(e) => setDraft({ card_transaction_id: e.target.value })} placeholder="From the card terminal slip" testid="client-collect-card-txn" />
                  </div>
                )}

                {collectDraft.payment_mode === "account_transfer" && (
                  <div className="space-y-3 rounded-lg border border-cyan-100 bg-cyan-50/50 p-3">
                    <CollectField label="Account Number *" value={collectDraft.account_number} onChange={(e) => setDraft({ account_number: e.target.value })} placeholder="Only the last 4 digits are stored" testid="client-collect-transfer-account-number" />
                    <CollectField label="Account Holder Name *" value={collectDraft.account_holder_name} onChange={(e) => setDraft({ account_holder_name: e.target.value })} placeholder="Name on the account" testid="client-collect-transfer-account-holder" />
                    <CollectField label="Bank Name *" value={collectDraft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" testid="client-collect-transfer-bank" />
                    <CollectField label="IFSC Code *" value={collectDraft.ifsc_code} onChange={(e) => setDraft({ ifsc_code: e.target.value })} placeholder="e.g. HDFC0001234" testid="client-collect-transfer-ifsc" />
                    <CollectField label="Reference / UTR No. *" value={collectDraft.transfer_reference} onChange={(e) => setDraft({ transfer_reference: e.target.value })} placeholder="e.g. 302411223344" testid="client-collect-transfer-reference" />
                  </div>
                )}

                {collectDraft.payment_mode === "cheque" && (
                  <div className="space-y-3 rounded-lg border border-amber-100 bg-amber-50/50 p-3">
                    <CollectField label="Bank Name *" value={collectDraft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" testid="client-collect-cheque-bank" />
                    <CollectField label="Cheque Number *" value={collectDraft.cheque_number} onChange={(e) => setDraft({ cheque_number: e.target.value })} placeholder="e.g. 004512" testid="client-collect-cheque-number" />
                  </div>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button
                type="button" onClick={() => setCollectDraft(null)} disabled={recording}
                className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-white disabled:opacity-50"
                data-testid="client-collect-cancel"
              >
                Cancel
              </button>
              <button
                type="button" onClick={submitCollect} disabled={recording}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                data-testid="client-collect-confirm"
              >
                {recording ? "Collecting..." : "Confirm & Collect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClientHistoryModal;
