// ---- Payment receipt ----------------------------------------------------------------
// What a screen hands the receipt popup, and what the popup shows of it. The paper itself is
// lib/bill.js: a standalone document, so Print never sends a whole board to the printer and
// the file sent on WhatsApp is the same sheet.
//
// Every screen opens a receipt with a transaction id and whatever it knows; ReceiptDialog
// fetches the bill behind that id and `withBill` puts it over the top. So the fee cards, the
// collect popups and Accountant Manage all hand a patient the one bill.
import { openPrintable } from "@/lib/printable";
import { billDateTime, billDay, billHtml, billMessage, paymentText } from "@/lib/bill";
import { displayPhone } from "@/lib/phone";
import { loadSession } from "@/lib/session";

// "split" is here and not on the collect popups' own lists on purpose: it is never a mode
// anyone picks, it is what the record says afterwards when a collection came in over more
// than one tender. A reissued receipt reads the stored mode back, so without this line a
// split payment printed the bare word "split" on the one row a patient checks.
// "pre_book" is the same kind of after-the-fact word: a fee settled from money the client
// paid at Pre Book (see backend routers/v3_pre_book.py).
export const ALL_PAYMENT_MODE_LABELS = { cash: "Cash", upi: "UPI", card: "Card", account_transfer: "Account Transfer", cheque: "Cheque", partial: "Partial Payment", split: "Split", pre_book: "Pre Book" };

/** Whatever identifies this payment with the bank — the thing a dispute is traced by. */
export const paymentReference = (p) => p.transfer_reference
  || p.upi_utr || p.upi_transaction_id
  || p.card_transaction_id
  || (p.cheque_number ? `Cheque ${p.cheque_number}${p.bank_name ? ` · ${p.bank_name}` : ""}` : "")
  // Cards taken before they stopped asking for the payer's bank details, which kept the
  // account's last four and no transaction id. Reprinting one of those receipts has to
  // still show what it showed the day it was handed over.
  || (p.account_number ? `Card ****${String(p.account_number).replace(/\D/g, "").slice(-4)}` : "");

// `kind: "schedule"` is a Partial Payment plan — the installments are agreed but no money
// has come in yet, so it must never print "Amount Paid" or "PAYMENT RECEIVED".
export const isSchedule = (r) => r.kind === "schedule";

const rsText = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * The short list the on-screen receipt shows.
 *
 * The bill is a record and carries everything; the popup is an acknowledgement seen for a
 * few seconds while the patient is still standing there. Everything dropped here is on the
 * bill. The money is in the block above this, larger.
 */
export const receiptPopupRows = (r) => [
  [isSchedule(r) ? "Reference No." : "Transaction ID", (r.bill?.transaction_ids || []).join(", ") || r.receiptNo],
  ["Date and Time", r.dateLabel],
  ["Patient Name", r.patient],
  ["Phone Number", displayPhone(r.phone)],
  [isSchedule(r) ? "Scheduled For" : "Paid For", r.paidFor],
  ["Balance Due", r.bill ? r.balanceDue : ""],
].filter(([, v]) => v);

/** The transaction id a bill can be fetched by, or "" -- a schedule has none. */
export const billTransaction = (r) => (r && !isSchedule(r) && /^TXN-/.test(r.receiptNo || "") ? r.receiptNo : "");

/** The receipt with the server's bill over it: the bill is what is printed, so the popup
 *  says the same. */
export const withBill = (r, bill) => {
  const whole = !(bill.already_paid > 0) && !(bill.balance > 0);
  const off = whole && bill.discount > 0;
  return {
    ...r,
    bill,
    dateLabel: billDateTime(bill.date) || r.dateLabel,
    patient: bill.patient?.name || r.patient,
    patientNo: bill.patient?.number || r.patientNo,
    phone: bill.patient?.phone || r.phone,
    branch: bill.branch?.name || r.branch,
    paidFor: [...new Set((bill.items || []).map((i) => i.service))].join(" + ") || r.paidFor,
    amount: bill.paid_now,
    originalAmount: off ? bill.subtotal : null,
    discount: off ? bill.discount : null,
    modeLabel: (bill.payments || []).length > 1
      ? bill.payments.map((p) => `${p.label} ${rsText(p.amount)}`).join(" + ")
      : paymentText(bill.payments).split(" · ")[0] || r.modeLabel,
    balanceDue: bill.balance > 0 ? `${rsText(bill.balance)}${bill.due_date ? ` · due ${billDay(bill.due_date)}` : ""}` : "",
    installments: bill.installments || [],
    collectedBy: bill.collected_by || r.collectedBy,
  };
};

export const receiptHtml = billHtml;
export const receiptMessage = billMessage;
export const printReceipt = (r) => openPrintable(receiptHtml(r), { print: true });

/** "FM-ANN-0001", or the transaction id on a payment from before Bill Nos. */
export const billName = (r) => r.bill?.bill_no || r.receiptNo;

/** Whether this login may open a bill: backend/routers/v3_bills.py's BILL_ROLES, every
 *  Branch Admin variant included. */
const BILL_ROLES = new Set([
  "branch_admin", "online_physio_admin", "online_fitness_admin", "branch_admin_physio", "branch_admin_fitness",
  "branch_admin_physio_fitness", "super_admin", "accountant", "business_dev",
]);
export const canReadBills = () => BILL_ROLES.has(String(loadSession()?.user?.role || "").trim().toLowerCase());

/** The signed-in person's own name, for Collected By on a payment just taken. */
export const collectorName = () => loadSession()?.user?.full_name || "Branch Admin";

/**
 * A receipt for a payment known by little more than its transaction id -- a store sale, a
 * class fee. The bill fills in the rest; this is what shows until it lands.
 */
export const quickReceipt = ({ transactionId, patient, phone, amount, paidFor, packageName, modeLabel }) => ({
  kind: "paid",
  receiptNo: transactionId,
  dateLabel: billDateTime(new Date().toISOString()),
  patient: patient || "—",
  patientNo: "—",
  phone: phone || "—",
  branch: "",
  paidFor: paidFor || "Payment",
  packageName: packageName || "",
  sessionsCovered: "",
  balanceDue: "",
  installments: [],
  amount: Number(amount) || 0,
  originalAmount: null,
  discount: null,
  modeLabel: modeLabel || "",
  reference: "",
  collectedBy: collectorName(),
  cashCounted: "",
});

/** A phone rather than a desk: the two need opposite handoffs, below. */
export const isHandheld = () => (typeof window !== "undefined"
  && (window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0));

/**
 * A receipt rebuilt from one row of the finance ledger.
 *
 * The Accountant Manage desk works off `finance/revenue-overview`, which returns a
 * collection as money rather than as a patient: an amount, a mode, a transaction id, who
 * took it and when. That is nearly a receipt already — and crucially it carries the real
 * `created_at`, so a reissue from this desk is dated the day the money came in rather
 * than the day somebody asked for the paper again.
 *
 * It cannot carry the record behind the money -- the package, the bank reference, the
 * installments. The bill fetched by its transaction id does (see withBill); this is what
 * shows until that lands, and all there is for a payment the server has no bill for.
 */
export const receiptFromTransaction = (tx) => {
  const amount = Number(tx.gross) || 0;
  const discount = Number(tx.discount) || 0;
  return {
    kind: "paid",
    receiptNo: tx.transaction_id || "—",
    // Written by the server when the money was taken. Falls back to nothing rather than
    // to today: a receipt that quietly dates itself to the reprint is worse than one that
    // admits the date is not on the record.
    dateLabel: tx.date
      ? new Date(tx.date).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—",
    patient: tx.client_name || "—",
    patientNo: tx.patient_number || "—",
    phone: tx.phone || "—",
    branch: tx.branch_name || "",
    paidFor: tx.paidFor || "",
    packageName: tx.item_name || "",
    sessionsCovered: "",
    balanceDue: "",
    installments: [],
    amount,
    // A discount only means anything against the price it came off. The ledger carries
    // both, but `original_amount` is null on collections taken before it was recorded —
    // there the discount is dropped rather than printed against nothing.
    originalAmount: tx.original_amount != null ? Number(tx.original_amount) : null,
    discount: tx.original_amount != null && discount > 0 ? discount : null,
    modeLabel: ALL_PAYMENT_MODE_LABELS[tx.payment_mode] || tx.payment_mode || "—",
    reference: "",
    collectedBy: tx.collected_by || "Branch Admin",
    isCash: tx.payment_mode === "cash",
    cashCounted: "",
  };
};
