// ---- Payment receipt ----------------------------------------------------------------
// The receipt is built as a standalone HTML document rather than printed from the page:
// window.print() on a board would send the whole board — modals, sidebar and all — to the
// printer, and the same document is what gets downloaded, so paper and file always match.
//
// Lifted out of ConsultationsBoard, which is where every one of these was written and for
// a while the only screen that could produce a receipt at all. Three screens can now: the
// fee cards on a patient reissue the one they were handed, the Accountant Manage desk
// reissues any collection on its ledger, and the collect popups still print the original.
// One copy of the document is what stops those three handing a patient three different
// pieces of paper for the same payment.
import {
  PRINTABLE_STYLES, docHeadHtml, escapeHtml, rupees, openPrintable,
} from "@/lib/printable";
import { displayPhone } from "@/lib/phone";

// "split" is here and not on the collect popups' own lists on purpose: it is never a mode
// anyone picks, it is what the record says afterwards when a collection came in over more
// than one tender. A reissued receipt reads the stored mode back, so without this line a
// split payment printed the bare word "split" on the one row a patient checks.
export const ALL_PAYMENT_MODE_LABELS = { cash: "Cash", upi: "UPI", card: "Card", account_transfer: "Account Transfer", cheque: "Cheque", partial: "Partial Payment", split: "Split" };

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

// The receipt's own document content. The branding, styles and the open/print/download/
// share mechanics are shared with every other printable in lib/printable.js.
export const receiptRows = (r) => [
  [isSchedule(r) ? "Reference No." : "Transaction ID", r.receiptNo],
  ["Date", r.dateLabel],
  ["Patient", r.patient],
  ["Patient No.", r.patientNo],
  ["Phone", displayPhone(r.phone)],
  r.branch ? ["Branch", r.branch] : null,
  [isSchedule(r) ? "Scheduled For" : "Paid For", r.paidFor],
  r.packageName ? ["Package", r.packageName] : null,
  r.sessionsCovered ? ["Sessions Covered", r.sessionsCovered] : null,
  ["Payment Mode", r.modeLabel],
  r.reference ? ["Reference", r.reference] : null,
  // Printed because the count is the half of a cash payment that can be checked against
  // a till later; the figure on its own cannot be.
  r.cashCounted ? ["Cash Counted", r.cashCounted] : null,
  r.originalAmount != null && r.originalAmount !== r.amount ? ["Original Price", `Rs.${r.originalAmount}`] : null,
  // The percentage alongside the rupees, so the receipt says how big the discount was and
  // not just how much came off. Omitted when there's no original price to measure against.
  r.discount
    ? ["Discount", r.originalAmount > 0
        ? `- Rs.${r.discount} (${Number(((r.discount / r.originalAmount) * 100).toFixed(2))}%)`
        : `- Rs.${r.discount}`]
    : null,
  [isSchedule(r) ? "Total Payable" : "Amount Paid", `Rs.${r.amount}`],
  r.balanceDue ? ["Balance Due", r.balanceDue] : null,
  [isSchedule(r) ? "Prepared By" : "Collected By", r.collectedBy],
].filter(Boolean);

/**
 * The shorter list the on-screen receipt shows. Deliberately not receiptRows.
 *
 * The printed bill and the shared text are records — they carry the branch, the package,
 * the mode, the original price and who collected it, because that is what a receipt has to
 * prove months later. The popup is an acknowledgement seen for a few seconds while the
 * patient is still standing there, and thirteen rows to confirm one payment is a wall to
 * read past rather than a confirmation.
 *
 * Everything dropped here is still on the bill, in the share text and in the download.
 * Money is not among it: the three figures sit in the block above this, larger.
 */
export const receiptPopupRows = (r) => [
  [isSchedule(r) ? "Reference No." : "Transaction ID", r.receiptNo],
  ["Date and Time", r.dateLabel],
  ["Patient Name", r.patient],
  ["Phone Number", displayPhone(r.phone)],
  [isSchedule(r) ? "Scheduled For" : "Paid For", r.paidFor],
].filter(([, v]) => v);

// The printed bill. Laid out as an invoice rather than a list of rows — who paid, how much,
// for what, and how — but it carries every field receiptRows does, so paper and the shared
// text still say the same things.
export const receiptHtml = (r) => {
  const sch = isSchedule(r);
  const hasOriginal = r.originalAmount != null && r.originalAmount !== r.amount;
  const pct = r.discount && r.originalAmount > 0
    ? ` (${Number(((r.discount / r.originalAmount) * 100).toFixed(2))}%)`
    : "";
  const kv = (rows) => `<table class="kv">${rows.filter((row) => row && row[1]).map(
    ([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`,
  ).join("")}</table>`;
  const installments = r.installments || [];

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Receipt ${escapeHtml(r.receiptNo)}</title><style>${PRINTABLE_STYLES}</style></head>
<body><div class="doc ${sch ? "tone-sch" : "tone-paid"}">
  ${docHeadHtml({
    title: sch ? "Payment Schedule" : "Payment Receipt",
    meta: [[sch ? "Reference No." : "Transaction ID", r.receiptNo], ["Date", r.dateLabel]],
    status: sch ? "PAYMENT SCHEDULE" : "PAYMENT RECEIVED",
    branch: r.branch,
  })}
  <div class="body">
    <div class="grid2">
      <div class="panel">
        <p class="label">${sch ? "Prepared For" : "Received From"}</p>
        <div class="name">${escapeHtml(r.patient)}</div>
        ${kv([["Patient No.", r.patientNo], ["Phone", displayPhone(r.phone)]])}
      </div>
      <div class="amount">
        ${sch ? "" : `<div class="stamp">PAID</div>`}
        <p class="label">${sch ? "Total Payable" : "Amount Paid"}</p>
        <div class="value">${rupees(r.amount)}</div>
        <div class="mode">${escapeHtml(r.modeLabel)}</div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody><tr>
        <td class="desc">${escapeHtml(r.paidFor || (sch ? "Payment schedule" : "Payment"))}
          ${r.packageName ? `<small>Package: ${escapeHtml(r.packageName)}</small>` : ""}
          ${r.sessionsCovered ? `<small>Sessions covered: ${escapeHtml(r.sessionsCovered)}</small>` : ""}
        </td>
        <td class="num">${rupees(hasOriginal ? r.originalAmount : r.amount)}</td>
      </tr></tbody>
    </table>

    <div class="grid2 summary">
      <div class="panel">
        <p class="label">Payment Details</p>
        ${kv([
          ["Payment Mode", r.modeLabel],
          ["Reference", r.reference],
          ["Cash Counted", r.cashCounted],
          [sch ? "Prepared By" : "Collected By", r.collectedBy],
        ])}
      </div>
      <table class="totals">
        ${hasOriginal ? `<tr><td>Original Price</td><td class="num">${rupees(r.originalAmount)}</td></tr>` : ""}
        ${r.discount ? `<tr class="off"><td>Discount${pct}</td><td class="num">- ${rupees(r.discount)}</td></tr>` : ""}
        <tr class="grand"><td>${sch ? "Total Payable" : "Amount Paid"}</td><td class="num">${rupees(r.amount)}</td></tr>
        ${r.balanceDue ? `<tr class="due"><td>Balance Due</td><td class="num">${escapeHtml(r.balanceDue)}</td></tr>` : ""}
      </table>
    </div>

    ${installments.length ? `<table class="items">
      <thead><tr><th>#</th><th>Sessions</th><th>Due Date</th><th class="num">Amount</th><th class="num">Status</th></tr></thead>
      <tbody>${installments.map((i, n) => `<tr>
        <td>${n + 1}</td>
        <td>${i.sessions ? escapeHtml(i.sessions) : "—"}</td>
        <td>${escapeHtml(i.due_date || "—")}</td>
        <td class="num">${rupees(i.amount)}</td>
        <td class="num"><span class="badge ${i.paid ? "badge-paid" : "badge-due"}">${i.paid ? "PAID" : "DUE"}</span></td>
      </tr>`).join("")}</tbody>
    </table>` : ""}

    ${sch ? `<div class="note note-warn">This is a payment schedule, not a receipt — no amount has been collected yet.<br>A receipt is issued for each installment when it is paid.</div>` : ""}
  </div>
  <div class="foot">
    <div>${sch ? "Computer-generated payment schedule." : "This is a computer-generated receipt and needs no signature."}</div>
    <div class="thanks">Thank you for choosing FITSIOMAX</div>
  </div>
</div></body></html>`;
};

export const printReceipt = (r) => openPrintable(receiptHtml(r), { print: true });
// WhatsApp, Share and Download send receiptHtml as a PDF — see ReceiptDialog and lib/pdf.js.

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
 * What it cannot carry is the record behind the money — the package name, the cash
 * denominations, the bank reference, the installment schedule. Those live on the lead and
 * only the patient's own fee card can reach them, so a receipt reissued from here is the
 * shorter of the two on purpose rather than by omission.
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
