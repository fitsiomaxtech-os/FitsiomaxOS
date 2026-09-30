import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Mail, Printer, FileText, MessageCircle, Wallet, PhoneCall, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { getClientTransactionHistory, markInstallmentPaid, collectPastBalance } from "@/lib/api";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (d) => (d ? (d.length > 10 ? d.slice(0, 16).replace("T", " ") : d) : "—");
const formatMode = (mode) => (mode ? (mode === "upi" ? "UPI" : mode.charAt(0).toUpperCase() + mode.slice(1)) : "");

const STATUS_STYLES = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  processing: "bg-amber-50 text-amber-700 border-amber-200",
};

const BALANCE_STATUS_META = {
  paid: { label: "Paid", classes: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  overdue: { label: "Overdue", classes: "bg-rose-100 text-rose-800 border-rose-200" },
  due_soon: { label: "Due Soon", classes: "bg-amber-100 text-amber-800 border-amber-200" },
  partial: { label: "Partial", classes: "bg-sky-100 text-sky-800 border-sky-200" },
};

const SCHEDULE_STATUS_META = {
  paid: { label: "Paid", classes: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  overdue: { label: "Overdue", classes: "bg-rose-100 text-rose-800 border-rose-200" },
  due_today: { label: "Due", classes: "bg-amber-100 text-amber-800 border-amber-200" },
  upcoming: { label: "Upcoming", classes: "bg-orange-100 text-orange-800 border-orange-200" },
};

// A Past Data row's status is the Outstanding table's (past_data_live.owed_status), where
// "partial" means owed but not yet close to due -- which on a single installment reads as
// upcoming, not as part paid.
const PAST_STATUS_META = {
  overdue: SCHEDULE_STATUS_META.overdue,
  due_soon: { label: "Due Soon", classes: "bg-amber-100 text-amber-800 border-amber-200" },
  partial: SCHEDULE_STATUS_META.upcoming,
};

const Badge = ({ meta }) => (
  <span className={`inline-flex items-center rounded-[5px] border px-2 py-0.5 text-[11px] font-semibold ${meta.classes}`}>
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

const CollectField = ({ label, value, onChange, placeholder, testid, inputMode }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-semibold text-slate-700">{label}</span>
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      inputMode={inputMode}
      className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
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

/** Label left, value right, hairline between — for facts that are read, not scanned. */
const StatRows = ({ rows }) => (
  <dl className="divide-y divide-slate-100 border-y border-slate-100">
    {rows.filter(Boolean).map(([label, value]) => (
      <div key={label} className="flex items-baseline justify-between gap-4 py-2">
        <dt className="shrink-0 text-xs font-medium text-slate-500">{label}</dt>
        <dd className="min-w-0 break-words text-right text-sm text-slate-800">{value}</dd>
      </div>
    ))}
  </dl>
);

const SectionTitle = ({ children, aside }) => (
  <div className="mb-2.5 flex items-baseline justify-between gap-3">
    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">{children}</h4>
    {aside}
  </div>
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
    return <p className="rounded-lg border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500">No payments recorded yet.</p>;
  }
  return (
    <div className="space-y-2" data-testid="client-history-transactions">
      {transactions.map((tx) => {
        const open = openId === tx.id;
        const off = Number(tx.discount_amount) || 0;
        const pct = discountPct(tx);
        return (
          <div key={tx.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid={`client-history-tx-${tx.id}`}>
            <button
              type="button"
              onClick={() => setOpenId(open ? null : tx.id)}
              className="flex w-full items-start justify-between gap-3 px-3.5 py-3 text-left hover:bg-slate-50"
              data-testid={`client-history-tx-toggle-${tx.id}`}
            >
              <span className="flex min-w-0 items-start gap-2">
                <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "" : "-rotate-90"}`} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold capitalize text-slate-800">{tx.source}</span>
                  <span className="block text-xs text-slate-600">{fmtDayTime(tx.date)} · {formatMode(tx.payment_mode)}</span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-sm font-bold tabular-nums text-slate-900">{fmt(tx.amount)}</span>
                <span className="block text-[11px] font-bold uppercase tracking-wide text-teal-700">Paid</span>
              </span>
            </button>

            {open && (
              <div className="border-t border-slate-100 px-3.5 py-3">
                {/* The arithmetic in one line, so a discounted payment explains itself
                    rather than needing three labelled boxes to say the same thing. */}
                {off > 0 && (
                  <p className="mb-2.5 font-mono text-sm tabular-nums text-slate-600" data-testid={`client-history-tx-maths-${tx.id}`}>
                    {fmt(tx.original_amount).replace("Rs.", "")} <span className="text-slate-400">−</span>{" "}
                    <span className="text-amber-700">{fmt(off).replace("Rs.", "")}</span>
                    {pct != null && (
                      <span className="ml-1 rounded bg-amber-100 px-1 py-px text-[11px] font-bold text-amber-800" data-testid={`client-history-tx-discount-pct-${tx.id}`}>{pct}%</span>
                    )}{" "}
                    <span className="text-slate-400">=</span>{" "}
                    <span className="font-semibold text-slate-900">{fmt(tx.amount).replace("Rs.", "")}</span>{" "}
                    <span className="text-slate-500">collected</span>
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
    <div className="rounded-lg border border-slate-200 bg-white p-3.5" data-testid="client-history-session-package">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-slate-800">{count > 0 ? `${count}-session course` : "Treatment package"}</p>
        <span className={`shrink-0 text-[11px] font-bold uppercase tracking-wide ${purchased ? "text-teal-700" : "text-slate-500"}`}>
          {purchased ? (pd.session_due > 0 ? "Part paid" : "Purchased") : "Not purchased"}
        </span>
      </div>
      {count > 0 && count <= 24 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {Array.from({ length: count }, (_, i) => (
            <span
              key={i}
              className={`flex h-6 min-w-6 items-center justify-center rounded border px-1.5 font-mono text-xs ${purchased ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}
            >
              {i + 1}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-600">{purchased ? `${fmt(paid)} paid` : "Nothing paid yet"}</span>
        {price > 0 && (
          <span className="text-slate-600">
            Quoted <span className="font-mono font-semibold text-slate-800">{fmt(price)}</span>
            {perSession && <span className="text-slate-500"> · {fmt(perSession)}/session</span>}
          </span>
        )}
      </div>
    </div>
  );
};

/** One thing owed — an installment on a fee's schedule, or a row of a Past Data sheet. */
const DueRow = ({ title, sub, amount, meta, next, children, testid }) => (
  <div className={`rounded-lg border px-3.5 py-3 ${next ? "border-rose-200 bg-rose-50/70" : "border-slate-200 bg-white"}`} data-testid={testid}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
          {title}
          {next && <span className="rounded bg-rose-600 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white">Next</span>}
        </p>
        {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm font-bold tabular-nums text-slate-900">{fmt(amount)}</p>
        <div className="mt-1"><Badge meta={meta} /></div>
      </div>
    </div>
    {children}
  </div>
);

/** One of the contact card's actions. Readable when it can't be used rather than faded to
 *  40% — the reason it can't ("No email") is on the button itself. */
const ContactAction = ({ icon: Icon, label, offLabel, onClick, disabled, testid }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={disabled ? offLabel : label}
    aria-label={disabled ? offLabel : label}
    className="flex flex-col items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-1 py-2.5 text-xs font-semibold text-slate-800 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:border-dashed disabled:bg-slate-50 disabled:text-slate-500 disabled:hover:border-slate-300 disabled:hover:bg-slate-50"
    data-testid={testid}
  >
    <Icon className="h-4 w-4" />
    <span className="leading-tight">{disabled ? offLabel : label}</span>
  </button>
);

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

const RECENT_PAYMENTS = 3;

/**
 * Client Details modal — a client's profile, current outstanding balance, full
 * payment history, and complete activity timeline. Opened via the eye icon from
 * Transactions History, Accountant Manage's Collections tables, and Total Revenue.
 *
 * Two panes. The left one is the money and the person: what is owed, the one button that
 * collects it, and how to reach them — so the answer to "what do we do about this client"
 * never scrolls away. The right one is the record, in three tabs.
 *
 * Portalled to <body> and sized off the viewport (dvh), so no board it opens from can clip
 * it: on a short laptop screen each pane scrolls inside the popup, on a phone it is the
 * whole screen, and the footer is always in view.
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

  // The page behind stays where it was: without this, a wheel over the backdrop scrolled
  // the board underneath, and the popup reopened over a different row than it closed on.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escape backs out one layer at a time: the Collect popup first, then this one.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (collectDraft) {
        if (!recording) setCollectDraft(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collectDraft, recording, onClose]);

  const client = data?.client;
  const pd = data?.payment_details || {};
  const schedule = data?.schedule || [];
  const pastOwed = data?.past_owed || [];
  const transactions = data?.transactions || [];
  const timeline = data?.timeline || [];
  const status = data?.status || "processing";
  const balanceMeta = BALANCE_STATUS_META[data?.balance_status] || BALANCE_STATUS_META.partial;

  // What the money strip adds up. Billed is derived, not stored: what was collected, plus
  // what was given away, plus what is still owed, is by definition what was billed.
  const collected = transactions.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const discount = transactions.reduce((s, t) => s + Math.max(Number(t.discount_amount) || 0, 0), 0);
  const due = Number(data?.balance) || 0;
  const billed = collected + discount + due;
  const pct = (n) => (billed > 0 ? Math.max((n / billed) * 100, 0) : 0);
  // The single discount's own percentage, quoted only when there is exactly one —
  // averaging several across different prices would be a made-up number.
  const discounted = transactions.filter((t) => Number(t.discount_amount) > 0);
  const solePct = discounted.length === 1 ? discountPct(discounted[0]) : null;

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

  // What Collect takes. An installment on the OS's own schedule first; otherwise a Past
  // Data client's sheet balance, which the server pays off oldest due first and which may
  // be collected a row at a time or all at once. A balance on neither — a Consultation Fee
  // never collected — belongs to the client's card in Consultations, where collecting it
  // also moves them on.
  const pastTotal = Math.round(pastOwed.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const collectKind = pd.next_installment_number ? "installment" : pastOwed.length > 0 ? "past" : null;

  /** Opens the confirmation popup rather than collecting on the spot. Money changing
   *  hands off a single unguarded click is how a client gets charged twice. */
  const openCollect = () => {
    if (collectKind === "installment") {
      setCollectDraft({ ...emptyCollectDraft, kind: "installment", amount: nextInstallment?.amount ? String(nextInstallment.amount) : "" });
    } else if (collectKind === "past") {
      setCollectDraft({ ...emptyCollectDraft, kind: "past", amount: String(pastOwed[0].amount) });
    }
  };

  const setDraft = (patch) => setCollectDraft((d) => ({ ...d, ...patch }));

  const submitCollect = async () => {
    const draft = collectDraft;
    const amount = parseFloat(draft.amount);
    if (!(amount > 0)) {
      toast.error("Enter a valid amount");
      return;
    }
    if (draft.kind === "past" && amount > pastTotal + 0.01) {
      toast.error(`That is more than the ${fmt(pastTotal)} this client owes`);
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
      if (draft.kind === "past") {
        await collectPastBalance(leadId, payload);
      } else {
        // Which fee's balance this is. Omitted, the server would take it as the Treatment
        // Fee's — the only schedule that existed when that default was written.
        payload.fee = pd.next_installment_fee || "treatment";
        await markInstallmentPaid(leadId, pd.next_installment_number, payload);
      }
      toast.success(`${fmt(amount)} collected from ${client.name}`);
      setCollectDraft(null);
      load();
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to record payment");
    }
    setRecording(false);
  };

  const collectLabel = collectKind === "installment"
    ? `Collect ${pd.next_installment_label || "installment"} #${pd.next_installment_number}`
    : "Collect payment";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/50 sm:items-center sm:p-4" data-testid="client-history-modal">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-history-name"
        className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-5xl sm:rounded-xl lg:h-[min(46rem,calc(100dvh-2rem))]"
      >
        {/* ---- header: who this is ---- */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-100 text-lg font-bold text-teal-800 sm:flex">
              {(client?.name || "?").trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="client-history-name" className="truncate text-xl font-bold text-slate-900" data-testid="client-history-name">{client?.name || "Loading..."}</h3>
                {client && (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`} data-testid="client-history-status">
                    <span className={`h-1.5 w-1.5 rounded-full ${status === "done" ? "bg-emerald-500" : "bg-amber-500"}`} />
                    {status === "done" ? "Completed" : "In Progress"}
                  </span>
                )}
              </div>
              {/* Identity in one line: who, where, their file number, and when they first
                  came in. Each part is dropped rather than shown blank when absent. */}
              {client && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-slate-600" data-testid="client-history-meta">
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
          </div>
          <button
            type="button" onClick={onClose} title="Close" aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            data-testid="client-history-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading && !data ? (
          <p className="flex-1 py-16 text-center text-sm text-slate-500">Loading...</p>
        ) : !data ? (
          <p className="flex-1 py-16 text-center text-sm text-slate-500">Failed to load client details.</p>
        ) : (
          // One row held to the popup's height (minmax(0,1fr)) so each pane scrolls on its
          // own at lg; an auto row would grow to the taller pane and be clipped instead.
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
            {/* ---- left: the money, the one action on it, and the person ---- */}
            <aside className="space-y-4 border-b border-slate-200 bg-slate-50 p-4 sm:p-5 lg:overflow-y-auto lg:overscroll-contain lg:border-b-0 lg:border-r">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="client-history-money-strip">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-600">{due > 0 ? "Balance due" : "Balance"}</p>
                <p className={`mt-1 font-mono text-3xl font-bold tabular-nums ${due > 0 ? "text-rose-700" : "text-teal-700"}`} data-testid="client-history-balance">{fmt(due)}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-slate-700">
                  {due > 0 ? <Badge meta={balanceMeta} /> : <Badge meta={BALANCE_STATUS_META.paid} />}
                  {due > 0 && data.next_due_date && <span>Next due <span className="font-semibold">{fmtDay(data.next_due_date)}</span></span>}
                </div>

                <div className="mt-3.5 flex h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="bg-teal-600" style={{ width: `${pct(collected)}%` }} title={`Collected ${fmt(collected)}`} />
                  {/* Hatched, because a discount is money that was never taken — it should
                      not read as solidly as money that was. */}
                  <div
                    style={{ width: `${pct(discount)}%`, backgroundImage: "repeating-linear-gradient(45deg, #f59e0b 0 3px, #fde68a 3px 6px)" }}
                    title={`Discount ${fmt(discount)}`}
                  />
                  <div className="bg-rose-400" style={{ width: `${pct(due)}%` }} title={`Due ${fmt(due)}`} />
                </div>

                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="flex items-center gap-2 text-slate-600"><span className="h-2 w-2 rounded-full bg-slate-400" />Billed</dt>
                    <dd className="font-mono font-semibold tabular-nums text-slate-900">{fmt(billed)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="flex items-center gap-2 text-slate-600"><span className="h-2 w-2 rounded-full bg-amber-400" />Discount{solePct != null ? ` (${solePct}%)` : ""}</dt>
                    <dd className={`font-mono font-semibold tabular-nums ${discount > 0 ? "text-amber-700" : "text-slate-500"}`}>{discount > 0 ? `−${fmt(discount)}` : fmt(0)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="flex items-center gap-2 text-slate-600"><span className="h-2 w-2 rounded-full bg-teal-600" />Collected</dt>
                    <dd className="font-mono font-semibold tabular-nums text-teal-700">{fmt(collected)}</dd>
                  </div>
                </dl>
                <p className="mt-2.5 text-xs text-slate-500">
                  {data.last_payment_date ? `Last payment ${fmtDayTime(data.last_payment_date)}` : "No payments yet"}
                </p>

                {collectKind ? (
                  <button
                    type="button" onClick={openCollect} disabled={recording}
                    className="mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                    data-testid="client-history-record-payment"
                  >
                    <Wallet className="h-4 w-4" /> {recording ? "Saving..." : collectLabel}
                  </button>
                ) : due > 0 ? (
                  <p className="mt-3.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900" data-testid="client-history-collect-note">
                    Not on an installment schedule — collect it from the client's card in <span className="font-semibold">Consultations</span>.
                  </p>
                ) : (
                  <p className="mt-3.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-sm text-teal-900" data-testid="client-history-collect-note">
                    Nothing left to collect. This client is fully paid.
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <SectionTitle>Contact</SectionTitle>
                <StatRows rows={[
                  ["Phone", client?.phone || "Not on file"],
                  ["Email", client?.email || "Not on file"],
                  client?.source && ["Source", client.source],
                  client?.assigned_physio_name && ["Expert", client.assigned_physio_name],
                ]} />
                {/* Full strength whenever they work. A Past Data client's balance can be
                    collected here now, so a reminder about it is the desk's to send too. */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <ContactAction icon={PhoneCall} label="Call" offLabel="No phone" onClick={callClient} disabled={!client?.phone} testid="client-history-call" />
                  <ContactAction icon={MessageCircle} label="WhatsApp" offLabel="No phone" onClick={sendReminder} disabled={!client?.phone} testid="client-history-reminder" />
                  <ContactAction icon={Mail} label="Email" offLabel="No email" onClick={sendEmailReminder} disabled={!client?.email} testid="client-history-email" />
                </div>
              </div>
            </aside>

            {/* ---- right: the record ---- */}
            <section className="flex min-w-0 flex-col lg:min-h-0">
              <div className="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-slate-200 bg-white px-3 sm:px-5 lg:static" role="tablist">
                {[
                  { key: "overview", label: "Overview", count: null },
                  { key: "transactions", label: "Transactions", count: transactions.length },
                  { key: "timeline", label: "Timeline", count: timeline.length },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={`-mb-px border-b-2 px-3 py-3 text-sm font-semibold transition ${tab === t.key ? "border-teal-600 text-teal-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
                    data-testid={`client-history-tab-${t.key}`}
                  >
                    {t.label}
                    {/* The count belongs on the tab: it says whether opening it is worth the
                        click, which the label alone never does. */}
                    {t.count != null && (
                      <span className={`ml-1.5 rounded-full px-1.5 py-px text-xs tabular-nums ${tab === t.key ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-600"}`}>{t.count}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="space-y-6 p-4 sm:p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
                {tab === "overview" ? (
                  <>
                    {/* What is still owed, row by row, in the order Collect takes it. */}
                    {pastOwed.length > 0 && (
                      <div data-testid="client-history-past-owed">
                        <SectionTitle aside={<span className="text-xs font-semibold text-slate-600">{pastOwed.length} due · {fmt(pastTotal)}</span>}>
                          Balance to collect
                        </SectionTitle>
                        <div className="space-y-2">
                          {pastOwed.map((r, i) => (
                            <DueRow
                              key={r.id}
                              title={r.service || "Past Data course"}
                              sub={[
                                r.due_date && `Due ${fmtDay(r.due_date)}`,
                                r.excel_id,
                                r.collected > 0 && `${fmt(r.collected)} already collected`,
                              ].filter(Boolean).join(" · ")}
                              amount={r.amount}
                              meta={PAST_STATUS_META[r.status] || PAST_STATUS_META.partial}
                              next={i === 0}
                              testid={`client-history-past-owed-${r.id}`}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {schedule.length > 0 && (
                      <div>
                        <SectionTitle>Payment Schedule</SectionTitle>
                        <div className="space-y-2">
                          {schedule.map((s) => {
                            const isNext = s.installment_number === pd.next_installment_number && s.fee === (pd.next_installment_fee || "treatment");
                            return (
                              <DueRow
                                key={`${s.fee || "treatment"}-${s.installment_number}`}
                                // Which fee this row belongs to. Numbering restarts per fee, so
                                // without it a client owing on two reads as "#1, #2, #1, #2".
                                title={`${s.fee_label || "Installment"} #${s.installment_number}`}
                                sub={s.due_date ? `Due ${fmtDay(s.due_date)}` : null}
                                amount={s.amount}
                                meta={SCHEDULE_STATUS_META[s.status] || SCHEDULE_STATUS_META.upcoming}
                                next={isNext}
                                testid={`client-history-schedule-${s.fee || "treatment"}-${s.installment_number}`}
                              >
                                {/* How this one was settled, once it has been — the UTR or cheque
                                    number is the only way to match it to a bank statement later. */}
                                {s.payment_mode && (
                                  <div className="mt-2 flex flex-wrap items-center gap-1" data-testid={`client-history-schedule-ref-${s.fee || "treatment"}-${s.installment_number}`}>
                                    <span className="rounded-[4px] border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">{formatMode(s.payment_mode)}</span>
                                    {paidReference(s).map((chip) => (
                                      <span key={chip} className="rounded-[4px] bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{chip}</span>
                                    ))}
                                  </div>
                                )}
                              </DueRow>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {(pd.session_package_sessions || pd.session_package_price || pd.session_total > 0) && (
                      <div>
                        <SectionTitle>Session Package</SectionTitle>
                        <SessionPackageCard pd={pd} />
                      </div>
                    )}

                    <div>
                      <SectionTitle
                        aside={transactions.length > RECENT_PAYMENTS && (
                          <button type="button" onClick={() => setTab("transactions")} className="inline-flex items-center gap-0.5 text-xs font-semibold text-teal-700 hover:text-teal-900" data-testid="client-history-all-payments">
                            All {transactions.length} <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        )}
                      >
                        Recent payments
                      </SectionTitle>
                      <PaymentCards transactions={transactions.slice(0, RECENT_PAYMENTS)} servicedBy={client?.assigned_physio_name} />
                    </div>
                  </>
                ) : tab === "transactions" ? (
                  <PaymentCards transactions={transactions} servicedBy={client?.assigned_physio_name} />
                ) : (
                  <div className="space-y-2">
                    {timeline.length === 0 ? (
                      <p className="py-6 text-center text-sm text-slate-500">No activity yet.</p>
                    ) : timeline.map((ev) => (
                      <div key={ev.id} className="flex items-start gap-2.5 rounded-lg border border-slate-100 bg-slate-50 px-3.5 py-2.5" data-testid={`client-history-event-${ev.id}`}>
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                        <div className="min-w-0">
                          <p className="break-words text-sm text-slate-800">{ev.details}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{fmtDate(ev.created_at)} · {ev.created_by}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* The paperwork, in a footer that never scrolls away — it applies to the client,
            not to whichever tab happens to be open. */}
        {data && (
          <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
            <button type="button" onClick={() => window.print()} title="Print receipt" className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 sm:flex-none" data-testid="client-history-print">
              <Printer className="h-4 w-4 shrink-0" /> Print<span className="hidden sm:inline"> receipt</span>
            </button>
            <button type="button" onClick={() => downloadInvoice(client, data)} title="Download invoice" className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 sm:flex-none" data-testid="client-history-invoice">
              <FileText className="h-4 w-4 shrink-0" /> <span className="hidden sm:inline">Download </span>Invoice
            </button>
            <button type="button" onClick={onClose} className="ml-auto hidden rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:block" data-testid="client-history-footer-close">
              Close
            </button>
          </div>
        )}
      </div>

      {collectDraft && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !recording) setCollectDraft(null); }}
          data-testid="client-collect-modal"
        >
          <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
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
              {collectDraft.kind === "past" ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3" data-testid="client-collect-past-summary">
                  <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Past Data balance</p>
                  <p className="mt-0.5 text-2xl font-bold text-emerald-800">{fmt(pastTotal)}</p>
                  <p className="mt-0.5 text-xs text-emerald-900/80">
                    {client?.name} · {pastOwed.length} {pastOwed.length === 1 ? "installment" : "installments"} owed
                    {pastOwed[0]?.due_date ? ` · next due ${fmtDay(pastOwed[0].due_date)}` : ""}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                    {pd.next_installment_label || "Installment"} #{pd.next_installment_number}
                    {/* installments_total counts the Treatment Fee's schedule, so "of N"
                        is only true when that is the fee being collected. */}
                    {pd.next_installment_fee === "treatment" && pd.installments_total ? ` of ${pd.installments_total}` : ""}
                  </p>
                  <p className="mt-0.5 text-2xl font-bold text-emerald-800">{fmt(nextInstallment?.amount)}</p>
                  <p className="mt-0.5 text-xs text-emerald-900/80">
                    {client?.name}{nextInstallment?.due_date ? ` · due ${nextInstallment.due_date}` : ""}
                  </p>
                </div>
              )}

              <div className="mt-4 space-y-3">
                <div>
                  <CollectField
                    label="Amount Collected"
                    value={collectDraft.amount}
                    onChange={(e) => setDraft({ amount: e.target.value })}
                    placeholder="0"
                    inputMode="decimal"
                    testid="client-collect-amount"
                  />
                  {/* The two amounts a desk actually takes against a sheet balance, one tap
                      each; anything in between is typed. */}
                  {collectDraft.kind === "past" && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button" onClick={() => setDraft({ amount: String(pastOwed[0].amount) })}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        data-testid="client-collect-amount-next"
                      >
                        Next due {fmt(pastOwed[0].amount)}
                      </button>
                      {pastOwed.length > 1 && (
                        <button
                          type="button" onClick={() => setDraft({ amount: String(pastTotal) })}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          data-testid="client-collect-amount-full"
                        >
                          Full balance {fmt(pastTotal)}
                        </button>
                      )}
                      <p className="w-full text-xs text-slate-600">Up to {fmt(pastTotal)}. It pays off the oldest due installment first.</p>
                    </div>
                  )}
                </div>

                <div>
                  <span className="mb-1 block text-xs font-semibold text-slate-700">Payment Mode</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {COLLECT_MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => setDraft({ payment_mode: m.value })}
                        className={`rounded-md border px-2 py-2 text-xs font-semibold transition ${collectDraft.payment_mode === m.value ? m.active : m.classes}`}
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
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-50"
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
    </div>,
    document.body,
  );
};

export default ClientHistoryModal;
