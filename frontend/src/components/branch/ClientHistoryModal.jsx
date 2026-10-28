import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Mail, Printer, FileText, Wallet, PhoneCall, ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { displayPhone, telNumber } from "@/lib/phone";
import { getClientTransactionHistory, markInstallmentPaid, collectPastBalance } from "@/lib/api";
import { BalanceDiscount, CollectField, TenderFields, emptyTender, tenderPayload } from "@/components/branch/CollectTender";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (d) => (d ? (d.length > 10 ? d.slice(0, 16).replace("T", " ") : d) : "—");
const formatMode = (mode) => (mode ? (mode === "upi" ? "UPI" : mode.charAt(0).toUpperCase() + mode.slice(1)) : "");
/** This popup shows no "#": "Treatment Fee #1" reads "Treatment Fee 1", and so does any
 *  activity line or label the server wrote with one. */
const noHash = (s) => String(s ?? "").replace(/#\s*/g, "");

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
  <span className={`inline-flex items-center rounded-[4px] border px-2 py-0.5 text-[11px] font-semibold ${meta.classes}`}>
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

// The modes and their fields are CollectTender's, shared with the Old Client Instalment form.
const emptyCollectDraft = { amount: "", ...emptyTender };

/** A payment's discount as a percentage of the price it was taken off, to 2dp with any
 *  trailing zeros dropped (25, not 25.00). Null when there's no original price to measure
 *  against, so the caller shows nothing rather than a meaningless 0%. */
const discountPct = (tx) => {
  const original = Number(tx.original_amount);
  const discount = Number(tx.discount_amount);
  if (!Number.isFinite(original) || original <= 0 || !Number.isFinite(discount) || !discount) return null;
  return Number((Math.abs(discount) / original * 100).toFixed(2));
};

/** The reference a paid installment carries, as short chips — how it was paid and the
 *  proof of it. Nothing renders for a mode that has no reference (cash). */
const paidReference = (s) => [
  s.upi_transaction_id && `Txn ${s.upi_transaction_id}`,
  s.upi_utr && `UTR ${s.upi_utr}`,
  s.card_transaction_id && `Card txn ${s.card_transaction_id}`,
  s.account_last4 && `A/C ****${s.account_last4}`,
  s.account_holder_name,
  s.cheque_number && `Cheque ${s.cheque_number}`,
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

/** Label left, value right, hairline between — for facts that are read, not scanned. A
 *  row's optional third entry is its class: "sm:hidden" for a fact a wide screen already
 *  shows on the card's own line. Such rows go last, so the hairlines stay single. */
const StatRows = ({ rows }) => (
  <dl className="divide-y divide-slate-100 border-y border-slate-100">
    {rows.filter(Boolean).map(([label, value, cls]) => (
      <div key={label} className={`flex items-baseline justify-between gap-4 py-2 ${cls || ""}`}>
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
 * One line of the Overview, opened for the detail behind it: the same open-and-close card
 * for a payment, a schedule row and the session package, so the three read alike. Closed
 * it is a single row — what, when, how much, where it stands. On a phone the "when" moves
 * inside rather than squeezing the row, so it is still one tap away.
 */
const FoldCard = ({ open, onToggle, title, tag, sub, amount, amountTone = "text-slate-900", status, highlight, children, testid, toggleTestid }) => (
  <div className={`overflow-hidden rounded-[4px] border ${highlight ? "border-rose-200 bg-rose-50/70" : "border-slate-200 bg-white"}`} data-testid={testid}>
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left ${highlight ? "hover:bg-rose-50" : "hover:bg-slate-50"}`}
      data-testid={toggleTestid}
    >
      <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "" : "-rotate-90"}`} />
      <span className="truncate text-sm font-semibold text-slate-800">{title}</span>
      {tag}
      {sub && <span className="hidden min-w-0 truncate text-xs text-slate-600 sm:inline"><span className="mr-1.5 text-slate-300">·</span>{sub}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
        {amount && <span className={`text-sm font-bold tabular-nums ${amountTone}`}>{amount}</span>}
        {status}
      </span>
    </button>
    {open && <div className="border-t border-slate-100 px-3.5 py-3">{children}</div>}
  </div>
);

/** A payment's status on its card — every one here has been collected. */
const PaidLabel = ({ children = "Paid", tone = "text-teal-700" }) => (
  <span className={`text-[11px] font-bold uppercase tracking-wide ${tone}`}>{children}</span>
);

/**
 * One expandable card per collection. Collapsed it answers "how much, when, how"; opened
 * it shows the arithmetic and the references an accountant needs to trace it.
 *
 * Everything here comes off the transaction record — nothing is inferred. A field with no
 * value is dropped rather than shown blank, so what remains is all true.
 */
const PaymentCards = ({ transactions, servicedBy }) => {
  const [openId, setOpenId] = useState(null);
  if (transactions.length === 0) {
    return <p className="py-4 text-center text-sm text-slate-500">No payments yet.</p>;
  }
  return (
    <div className="space-y-2" data-testid="client-history-transactions">
      {transactions.map((tx) => {
        const open = openId === tx.id;
        const off = Number(tx.discount_amount) || 0;
        const pct = discountPct(tx);
        const when = `${fmtDayTime(tx.date)} · ${formatMode(tx.payment_mode)}`;
        return (
          <FoldCard
            key={tx.id}
            open={open}
            onToggle={() => setOpenId(open ? null : tx.id)}
            title={<span className="capitalize">{tx.source}</span>}
            sub={when}
            amount={fmt(tx.amount)}
            status={<PaidLabel />}
            testid={`client-history-tx-${tx.id}`}
            toggleTestid={`client-history-tx-toggle-${tx.id}`}
          >
            {/* The arithmetic in one line, so a discounted payment explains itself
                rather than needing three labelled boxes to say the same thing. */}
            {off > 0 && (
              <p className="mb-2.5 text-sm tabular-nums text-slate-600" data-testid={`client-history-tx-maths-${tx.id}`}>
                {fmt(tx.original_amount).replace("Rs.", "")} <span className="text-slate-400">−</span>{" "}
                <span className="text-amber-700">{fmt(off).replace("Rs.", "")}</span>
                {pct != null && (
                  <span className="ml-1 rounded-[4px] bg-amber-100 px-1 py-px text-[11px] font-bold text-amber-800" data-testid={`client-history-tx-discount-pct-${tx.id}`}>{pct}%</span>
                )}{" "}
                <span className="text-slate-400">=</span>{" "}
                <span className="font-semibold text-slate-900">{fmt(tx.amount).replace("Rs.", "")}</span>{" "}
                <span className="text-slate-500">collected</span>
              </p>
            )}
            <StatRows rows={[
              tx.transaction_id && ["Transaction", <span key="t" className="tabular-nums">{tx.transaction_id}</span>],
              !tx.transaction_id && tx.receipt_no && ["Receipt", <span key="r" className="tabular-nums">{tx.receipt_no}</span>],
              tx.collected_by && ["Collected by", tx.collected_by_role ? `${tx.collected_by} · ${formatMode(tx.collected_by_role).replace(/_/g, " ")}` : tx.collected_by],
              off > 0 && tx.discount_reason && ["Discount", tx.discount_reason],
              detailReference(tx.details) && ["Reference", <span key="ref" className="break-all">{noHash(detailReference(tx.details))}</span>],
              servicedBy && ["Service by", servicedBy],
              ["Paid on", when, "sm:hidden"],
            ]} />
          </FoldCard>
        );
      })}
    </div>
  );
};

/** The treatment course as quoted, and how much of it has been paid for, on one row.
 *  Deliberately silent on sessions *used* — attendance isn't recorded anywhere, so any
 *  "0 of 6 used" would be a claim this screen can't stand behind. */
const SessionPackageCard = ({ pd, open, onToggle }) => {
  const count = Number(pd.session_package_sessions) || 0;
  const price = Number(pd.session_package_price) || 0;
  const paid = Number(pd.session_paid) || 0;
  const due = Number(pd.session_due) || 0;
  const purchased = paid > 0;
  const perSession = count > 0 && price > 0 ? Math.round(price / count) : null;
  const quote = price > 0 ? `${fmt(price)}${perSession ? ` · ${fmt(perSession)}/session` : ""}` : null;
  return (
    <FoldCard
      open={open}
      onToggle={onToggle}
      title={count > 0 ? `${count}-session course` : "Treatment package"}
      sub={quote}
      amount={purchased ? `${fmt(paid)} paid` : null}
      amountTone="text-teal-700"
      status={<PaidLabel tone={purchased ? "text-teal-700" : "text-slate-500"}>{purchased ? (due > 0 ? "Part paid" : "Purchased") : "Not purchased"}</PaidLabel>}
      testid="client-history-session-package"
      toggleTestid="client-history-session-package-toggle"
    >
      <StatRows rows={[
        count > 0 && ["Sessions", count],
        price > 0 && ["Package price", <span key="p" className="tabular-nums">{fmt(price)}</span>],
        perSession && ["Per session", <span key="s" className="tabular-nums">{fmt(perSession)}</span>],
        ["Paid", <span key="pd" className="tabular-nums">{fmt(paid)}</span>],
        due > 0 && ["Still due", <span key="d" className="tabular-nums">{fmt(due)}</span>],
      ]} />
    </FoldCard>
  );
};

/** One thing owed — an installment on a fee's schedule, or a row of a Past Data sheet. */
const DueRow = ({ title, sub, amount, meta, next, open, onToggle, children, testid }) => (
  <FoldCard
    open={open}
    onToggle={onToggle}
    title={title}
    tag={next && <span className="shrink-0 rounded-[4px] bg-rose-600 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white">Next</span>}
    sub={sub}
    amount={fmt(amount)}
    status={<Badge meta={meta} />}
    highlight={next}
    testid={testid}
    toggleTestid={`${testid}-toggle`}
  >
    {children}
  </FoldCard>
);

/** One of the contact row's actions. Only drawn when it can be used — a greyed "No email"
 *  button was one more thing to read that said nothing the missing email didn't. */
const ContactAction = ({ icon: Icon, label, onClick, className = "text-slate-700", testid }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    className={`inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-slate-200 bg-white px-2.5 text-xs font-semibold hover:bg-slate-50 ${className}`}
    data-testid={testid}
  >
    <Icon className="h-4 w-4" /> {label}
  </button>
);

/** One figure of the money strip. `aside` (the balance's status badge) wraps under the
 *  figure rather than squeezing it when the tile is narrow. Every word on a tile is Inter
 *  at 11px — label, figure and badge alike. */
const MoneyTile = ({ label, value, aside, tone = "text-slate-900", className = "border-slate-200 bg-white", testid }) => (
  <div className={`min-w-0 rounded-[4px] border px-2.5 py-2 font-['Inter',sans-serif] text-[11px] sm:px-3 ${className}`}>
    <p className="text-[11px] font-semibold uppercase text-slate-500 sm:tracking-wide">{label}</p>
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className={`break-all text-[11px] font-bold tabular-nums ${tone}`} data-testid={testid}>{value}</p>
      {aside}
    </div>
  </div>
);

const downloadInvoice = (client, data) => {
  const lines = [
    `Invoice — ${client.name}`,
    displayPhone(client.phone) ? `Phone: ${displayPhone(client.phone)}` : "",
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
 * One column, top to bottom: the money in four figures, the one button that collects it,
 * how to reach the client, then the record in three tabs. Anything with nothing to say —
 * an empty payments box, a greyed "No email" button — is left out rather than drawn.
 *
 * Portalled to <body> and sized to its content, capped by the viewport (dvh), so no board
 * it opens from can clip it. It floats over the page on a phone as on a desktop, never
 * taking the whole screen; past the cap the body scrolls and the footer stays in view.
 *
 * @param onCollect  Collects a balance this popup has no form for -- a Consultation Fee
 *              assigned and never collected -- the way the board's own row Collect does.
 *              Handed in only where the board can take it; left out, no button.
 * @param undo  Payment Schedule's Undo of the newest instalment taken on this client,
 *              { label, amount, blocked, run }: drawn beside Collect rather than on the
 *              schedule's row. `blocked` is why it cannot be pressed (the payment is with the
 *              accountant), said on a tap; `run` resolves true when it went through.
 */
export const ClientHistoryModal = ({ leadId, onClose, onChanged, onCollect, undo }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("overview");
  const [recording, setRecording] = useState(false);
  const [collectDraft, setCollectDraft] = useState(null);
  // The Overview card opened for its detail -- a schedule row, a Balance to collect row or
  // the session package -- one at a time, as Recent payments opens them.
  const [openRow, setOpenRow] = useState(null);
  const toggleRow = (key) => setOpenRow((k) => (k === key ? null : key));

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
    window.location.href = `tel:${telNumber(client.phone)}`;
  };

  // Numbering restarts per fee, so a row is identified by both — matching on the number
  // alone would find, say, the Consultation Fee's row #2 when the Diet Fee's is due.
  const nextInstallment = schedule.find(
    (s) => s.installment_number === pd.next_installment_number && s.fee === (pd.next_installment_fee || "treatment")
  );

  // What Collect takes. An installment on the OS's own schedule first; otherwise a Past
  // Data client's sheet balance, which the server pays off oldest due first and which may
  // be collected a row at a time or all at once. A balance on neither — a Consultation Fee
  // never collected — goes to the board's own Collect (`onCollect`), which takes it the way
  // Consultations does and so moves the client on too.
  const pastTotal = Math.round(pastOwed.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const collectKind = pd.next_installment_number ? "installment" : pastOwed.length > 0 ? "past" : null;
  const feeCollect = !collectKind && due > 0 && Boolean(onCollect);

  /** Opens the confirmation popup rather than collecting on the spot. Money changing
   *  hands off a single unguarded click is how a client gets charged twice. */
  const openCollect = () => {
    if (collectKind === "installment") {
      setCollectDraft({ ...emptyCollectDraft, kind: "installment", amount: nextInstallment?.amount ? String(nextInstallment.amount) : "", discount: "" });
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
    const tender = tenderPayload(draft);
    if (tender.error) {
      toast.error(tender.error);
      return;
    }
    const payload = { ...tender.payload, amount };

    setRecording(true);
    try {
      if (draft.kind === "past") {
        await collectPastBalance(leadId, payload);
      } else {
        // Which fee's balance this is. Omitted, the server would take it as the Treatment
        // Fee's — the only schedule that existed when that default was written.
        payload.fee = pd.next_installment_fee || "treatment";
        const off = Math.round(Math.max(0, parseFloat(draft.discount) || 0) * 100) / 100;
        if (off > 0) payload.discount_amount = off;
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

  // The fee alone: "Collect Extra Amount". Collect only ever takes the next one, which the
  // schedule below marks, so its number on the button said nothing.
  const collectLabel = collectKind === "installment"
    ? `Collect ${pd.next_installment_label || "installment"}`
    : "Collect payment";

  // What the Overview tab has to show. With none of it, the tab says so in one line
  // instead of drawing empty section boxes.
  const hasPackage = Boolean(pd.session_package_sessions || pd.session_package_price || pd.session_total > 0);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 sm:p-6"
      // A click on the dimmed page closes it, as on any popup that floats — but never while
      // the Collect popup is open over it, which handles its own backdrop.
      onClick={(e) => { if (e.target === e.currentTarget && !collectDraft) onClose(); }}
      data-testid="client-history-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-history-name"
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
      >
        {/* ---- header: who this is, in one row at 14px — name, status, then phone,
            branch and file number. Each part is dropped rather than shown blank when
            absent; a phone wraps the identity under the name rather than squeezing it. ---- */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5 sm:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] sm:flex-nowrap">
            <h3 id="client-history-name" className="min-w-0 max-w-full truncate text-[14px] font-bold text-slate-900 sm:max-w-[45%] sm:shrink-0" data-testid="client-history-name">{client?.name || "Loading..."}</h3>
            {client && (
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-[14px] font-semibold leading-5 ${STATUS_STYLES[status]}`} data-testid="client-history-status">
                <span className={`h-1.5 w-1.5 rounded-full ${status === "done" ? "bg-emerald-500" : "bg-amber-500"}`} />
                {status === "done" ? "Completed" : "In Progress"}
              </span>
            )}
            {client && (
              <span className="min-w-0 truncate text-[14px] text-slate-600" data-testid="client-history-meta">
                {[
                  displayPhone(client.phone),
                  client.branch_name,
                  client.patient_number && <span key="pn" className="tabular-nums">{client.patient_number}</span>,
                ].filter(Boolean).map((part, i) => (
                  <span key={i}>
                    {i > 0 && <span className="mx-1.5 text-slate-300">·</span>}
                    {part}
                  </span>
                ))}
              </span>
            )}
          </div>
          <button
            type="button" onClick={onClose} title="Close" aria-label="Close"
            className="-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            data-testid="client-history-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading && !data ? (
          <p className="py-12 text-center text-sm text-slate-500">Loading...</p>
        ) : !data ? (
          <p className="py-12 text-center text-sm text-slate-500">Failed to load client details.</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {/* ---- the money, the one action on it, and how to reach them ---- */}
            <div className="space-y-3 px-4 py-3.5 sm:px-5">
              {/* Balance first and widest — the whole row on a phone, with the other three
                  under it — since it is the one figure the desk opened this for. */}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-[1.5fr_1fr_1fr_1fr]" data-testid="client-history-money-strip">
                <MoneyTile
                  label={due > 0 ? "Balance due" : "Balance"}
                  value={fmt(due)}
                  aside={<Badge meta={due > 0 ? balanceMeta : BALANCE_STATUS_META.paid} />}
                  tone={due > 0 ? "text-rose-700" : "text-teal-700"}
                  className={`col-span-3 sm:col-span-1 ${due > 0 ? "border-rose-200 bg-rose-50" : "border-teal-200 bg-teal-50"}`}
                  testid="client-history-balance"
                />
                <MoneyTile label="Billed" value={fmt(billed)} />
                <MoneyTile
                  label="Discount"
                  value={discount > 0 ? `−${fmt(discount)}` : fmt(0)}
                  aside={solePct != null && <span className="rounded-[4px] bg-amber-100 px-1 py-px text-[11px] font-bold text-amber-800">{solePct}%</span>}
                  tone={discount > 0 ? "text-amber-700" : "text-slate-500"}
                />
                <MoneyTile label="Collected" value={fmt(collected)} tone="text-teal-700" />
              </div>

              {((due > 0 && data.next_due_date) || data.last_payment_date || collectKind || feeCollect || undo) && (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                    {due > 0 && data.next_due_date && <span>Next due <span className="font-semibold text-slate-800">{fmtDay(data.next_due_date)}</span></span>}
                    {data.last_payment_date && <span>Last paid <span className="font-semibold text-slate-800">{fmtDayTime(data.last_payment_date)}</span></span>}
                  </div>
                  {collectKind && (
                    <button
                      type="button" onClick={openCollect} disabled={recording}
                      className="flex h-10 w-full items-center justify-center gap-2 rounded-[4px] bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 sm:w-auto"
                      data-testid="client-history-record-payment"
                    >
                      <Wallet className="h-4 w-4" /> {recording ? "Saving..." : collectLabel}
                    </button>
                  )}
                  {feeCollect && (
                    <button
                      type="button" onClick={onCollect}
                      className="flex h-10 w-full items-center justify-center gap-2 rounded-[4px] bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 sm:w-auto"
                      data-testid="client-history-collect-fee"
                    >
                      <Wallet className="h-4 w-4" /> Collect Consultation Fee
                    </button>
                  )}
                  {undo && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (undo.blocked) { toast.message(undo.blocked); return; }
                        if (await undo.run()) load();
                      }}
                      aria-disabled={Boolean(undo.blocked)}
                      title={undo.blocked || `Undo ${noHash(undo.label)} — ${fmt(undo.amount)}`}
                      className={`flex h-10 w-full items-center justify-center gap-2 rounded-[4px] border px-4 text-sm font-bold sm:w-auto ${
                        undo.blocked
                          ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
                          : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                      }`}
                      data-testid="client-history-undo-instalment"
                    >
                      <Undo2 className="h-4 w-4" /> Undo {noHash(undo.label)}
                    </button>
                  )}
                </div>
              )}

              {/* Reaching the client, on a phone only — the desk on a computer calls and
                  messages from elsewhere, and this row was one more thing between the money
                  and the record. */}
              {(client?.phone || client?.email) && (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 sm:hidden" data-testid="client-history-contact">
                  <div className="flex gap-2">
                    {client?.phone && <ContactAction icon={PhoneCall} label="Call" onClick={callClient} testid="client-history-call" />}
                    {/* On for a Past Data client too: that balance can be collected here now,
                        so a reminder about it is the desk's to send. */}
                    {client?.phone && <ContactAction icon={WhatsAppIcon} label="WhatsApp" onClick={sendReminder} className="text-emerald-700" testid="client-history-reminder" />}
                    {client?.email && <ContactAction icon={Mail} label="Email" onClick={sendEmailReminder} testid="client-history-email" />}
                  </div>
                </div>
              )}
            </div>

            {/* ---- the record ---- */}
            <div className="sticky top-0 z-10 flex gap-1 border-y border-slate-200 bg-white px-3 sm:px-4" role="tablist">
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
                  className={`-mb-px border-b-2 px-2.5 py-2.5 text-sm font-semibold transition ${tab === t.key ? "border-teal-600 text-teal-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
                  data-testid={`client-history-tab-${t.key}`}
                >
                  {t.label}
                  {/* The count belongs on the tab: it says whether opening it is worth the
                      click, which the label alone never does. */}
                  {t.count != null && (
                    <span className={`ml-1.5 rounded-[4px] px-1.5 py-px text-xs tabular-nums ${tab === t.key ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-600"}`}>{t.count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="space-y-5 px-4 py-3.5 sm:px-5">
              {tab === "overview" ? (
                <>
                  {/* What is still owed, row by row, in the order Collect takes it. */}
                  {pastOwed.length > 0 && (
                    <div data-testid="client-history-past-owed">
                      <SectionTitle aside={<span className="text-xs font-semibold text-slate-600">{pastOwed.length} due · {fmt(pastTotal)}</span>}>
                        Balance to collect
                      </SectionTitle>
                      <div className="space-y-2">
                        {pastOwed.map((r, i) => {
                          const meta = PAST_STATUS_META[r.status] || PAST_STATUS_META.partial;
                          return (
                            <DueRow
                              key={r.id}
                              title={noHash(r.service || "Past Data course")}
                              sub={r.due_date ? `Due ${fmtDay(r.due_date)}` : null}
                              amount={r.amount}
                              meta={meta}
                              next={i === 0}
                              open={openRow === `past-${r.id}`}
                              onToggle={() => toggleRow(`past-${r.id}`)}
                              testid={`client-history-past-owed-${r.id}`}
                            >
                              <StatRows rows={[
                                ["Status", meta.label],
                                r.excel_id && ["Sheet ID", <span key="x" className="tabular-nums">{r.excel_id}</span>],
                                r.collected > 0 && ["Already collected", <span key="c" className="tabular-nums">{fmt(r.collected)}</span>],
                                r.due_date && ["Due", fmtDay(r.due_date), "sm:hidden"],
                              ]} />
                            </DueRow>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {schedule.length > 0 && (
                    <div>
                      <SectionTitle>Payment Schedule</SectionTitle>
                      <div className="space-y-2">
                        {schedule.map((s) => {
                          const isNext = s.installment_number === pd.next_installment_number && s.fee === (pd.next_installment_fee || "treatment");
                          const key = `${s.fee || "treatment"}-${s.installment_number}`;
                          const meta = SCHEDULE_STATUS_META[s.status] || SCHEDULE_STATUS_META.upcoming;
                          return (
                            <DueRow
                              key={key}
                              // Which fee this row belongs to. Numbering restarts per fee, so
                              // without it a client owing on two reads as "1, 2, 1, 2".
                              title={`${s.fee_label || "Installment"} ${s.installment_number}`}
                              sub={s.due_date ? `Due ${fmtDay(s.due_date)}` : null}
                              amount={s.amount}
                              meta={meta}
                              next={isNext}
                              open={openRow === `sched-${key}`}
                              onToggle={() => toggleRow(`sched-${key}`)}
                              testid={`client-history-schedule-${key}`}
                            >
                              <StatRows rows={[
                                ["Status", meta.label],
                                // How this one was settled, once it has been — the UTR or cheque
                                // number is the only way to match it to a bank statement later.
                                s.payment_mode && ["Paid by", (
                                  <span key="ref" className="inline-flex flex-wrap justify-end gap-1" data-testid={`client-history-schedule-ref-${key}`}>
                                    <span className="rounded-[4px] border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">{formatMode(s.payment_mode)}</span>
                                    {paidReference(s).map((chip) => (
                                      <span key={chip} className="rounded-[4px] bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{chip}</span>
                                    ))}
                                  </span>
                                )],
                                s.transaction_id && ["Transaction", <span key="t" className="tabular-nums">{s.transaction_id}</span>],
                                s.due_date && ["Due", fmtDay(s.due_date), "sm:hidden"],
                              ]} />
                            </DueRow>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {hasPackage && (
                    <div>
                      <SectionTitle>Session Package</SectionTitle>
                      <SessionPackageCard pd={pd} open={openRow === "package"} onToggle={() => toggleRow("package")} />
                    </div>
                  )}

                  {transactions.length > 0 && (
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
                  )}

                  {pastOwed.length === 0 && schedule.length === 0 && !hasPackage && transactions.length === 0 && (
                    <p className="py-4 text-center text-sm text-slate-500">No payments yet.</p>
                  )}
                </>
              ) : tab === "transactions" ? (
                <PaymentCards transactions={transactions} servicedBy={client?.assigned_physio_name} />
              ) : timeline.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-500">No activity yet.</p>
              ) : (
                <ol className="divide-y divide-slate-100">
                  {timeline.map((ev) => (
                    <li key={ev.id} className="flex items-start gap-2.5 py-2" data-testid={`client-history-event-${ev.id}`}>
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                      <div className="min-w-0">
                        <p className="break-words text-sm text-slate-800">{noHash(ev.details)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{fmtDate(ev.created_at)} · {ev.created_by}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}

        {/* The paperwork, in a footer that never scrolls away — it applies to the client,
            not to whichever tab happens to be open. */}
        {data && (
          <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 py-2.5 sm:px-5">
            <button type="button" onClick={() => window.print()} title="Print receipt" className="flex flex-1 items-center justify-center gap-1.5 rounded-[4px] bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 sm:flex-none" data-testid="client-history-print">
              <Printer className="h-4 w-4 shrink-0" /> Print<span className="hidden sm:inline"> receipt</span>
            </button>
            <button type="button" onClick={() => downloadInvoice(client, data)} title="Download invoice" className="flex flex-1 items-center justify-center gap-1.5 rounded-[4px] border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 sm:flex-none" data-testid="client-history-invoice">
              <FileText className="h-4 w-4 shrink-0" /> <span className="hidden sm:inline">Download </span>Invoice
            </button>
            <button type="button" onClick={onClose} className="ml-auto hidden rounded-[4px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:block" data-testid="client-history-footer-close">
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
                    {pd.next_installment_label || "Installment"} {pd.next_installment_number}
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
                {/* A discount on the installment, the amount below following it. */}
                {collectDraft.kind === "installment" && (
                  <BalanceDiscount
                    due={nextInstallment?.amount}
                    discount={collectDraft.discount}
                    amount={collectDraft.amount}
                    onChange={setDraft}
                    testid="client-collect"
                  />
                )}
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

                <TenderFields draft={collectDraft} setDraft={setDraft} testid="client-collect" />
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
