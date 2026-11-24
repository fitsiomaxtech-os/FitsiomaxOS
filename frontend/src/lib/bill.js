// ---- The bill -------------------------------------------------------------------------
// The paper every payment is handed over with, laid out on the clinic's own BILL / RECEIPT.
// One standalone HTML document: Print opens it, and WhatsApp, Share and Download draw the
// same document into the PDF (lib/pdf.js), so paper and file cannot disagree.
//
// What it says comes from the server (GET /finance/bills/<transaction id>, backend/bills.py),
// whichever screen opened it. A Payment Schedule has no transaction, and a bill that could
// not be fetched still has to print, so both are built here off the receipt itself.
import { escapeHtml } from "@/lib/printable";
import { BILL_LOGO } from "@/lib/billLogo";
import { displayPhone } from "@/lib/phone";
import { signSrc } from "@/lib/signImage";

const BLUE = "#2b6cb0";
const PHONE = "+91 75388 36030";

const two = (n) => (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (n) => `₹ ${two(n)}`;

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const under100 = (n) => (n < 20 ? ONES[n] : [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(" "));
const under1000 = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : "", under100(n % 100)].filter(Boolean).join(" ");

/** 4000 -> "Rupees Four Thousand Only", counted in lakhs and crores. */
export const amountInWords = (value) => {
  const paise = Math.round((Number(value) || 0) * 100);
  let n = Math.floor(paise / 100);
  const parts = [];
  [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]].forEach(([size, name]) => {
    const count = Math.floor(n / size);
    if (count) parts.push(`${under1000(count)} ${name}`);
    n %= size;
  });
  if (n) parts.push(under1000(n));
  const p = paise % 100;
  return `Rupees ${parts.join(" ") || "Zero"}${p ? ` and ${under100(p)} Paise` : ""} Only`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-05" -> "05-Dec-2026". A day with no time in it, so no time zone can move it. */
export const billDay = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1] || m[2]}-${m[1]}` : String(value || "");
};

/** A stored moment as the clinic's own clock reads it: "23-Nov-2026, 10:30 AM". */
export const billDateTime = (value) => {
  const text = String(value || "");
  // A stamp with no offset on it is UTC, as the server writes them.
  const at = new Date(/T/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? `${text}Z` : text);
  if (!text || Number.isNaN(at.getTime())) return text;
  const part = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const hour = Number(part.hour) % 24;
  return `${part.day}-${MONTHS[Number(part.month) - 1]}-${part.year}, ${String(hour % 12 || 12).padStart(2, "0")}:${part.minute} ${hour < 12 ? "AM" : "PM"}`;
};

/** How the money came in, on one line. Amounts only where there is more than one tender. */
export const paymentText = (payments) => (payments || []).map((p) => [
  `${p.label}${payments.length > 1 ? ` ${rs(p.amount)}` : ""}`, p.reference, p.notes && `Counted ${p.notes}`,
].filter(Boolean).join(" · ")).join("  +  ");

/** What the document prints, off the server's bill where there is one. */
const billModel = (r) => {
  const b = r.bill;
  if (b) {
    return {
      title: "BILL / RECEIPT",
      number: b.bill_no ? ["Bill No", b.bill_no] : null,
      reference: ["Transaction ID", (b.transaction_ids || []).join(", ") || r.receiptNo],
      date: billDateTime(b.date),
      patient: { ...b.patient }, branch: { ...b.branch },
      items: b.items || [], subtotal: b.subtotal, discount: b.discount, total: b.total, totalLabel: "TOTAL",
      already: b.already_paid, now: b.paid_now,
      balance: b.balance > 0 ? rs(b.balance) : "", due: b.balance > 0 ? billDay(b.due_date) : "",
      payment: paymentText(b.payments), words: b.paid_now,
      by: ["Collected By", b.collected_by], sign: signSrc(b.signature), installments: b.installments || [],
    };
  }
  const schedule = r.kind === "schedule";
  const discount = Number(r.discount) || 0;
  const subtotal = (Number(r.amount) || 0) + discount;
  return {
    title: schedule ? "PAYMENT SCHEDULE" : "BILL / RECEIPT",
    number: null,
    reference: [schedule ? "Reference No" : "Transaction ID", r.receiptNo],
    date: r.dateLabel,
    patient: { name: r.patient, number: r.patientNo === "—" ? "" : r.patientNo, phone: r.phone === "—" ? "" : r.phone },
    branch: { name: r.branch },
    items: [{
      service: r.paidFor || "Payment", detail: [r.packageName, r.sessionsCovered].filter(Boolean).join(" · "),
      qty: 1, price: subtotal, amount: subtotal,
    }],
    subtotal, discount, total: r.amount, totalLabel: schedule ? "TOTAL PAYABLE" : "TOTAL",
    already: 0, now: schedule ? null : r.amount, balance: schedule ? "" : r.balanceDue || "", due: "",
    payment: schedule ? "" : [r.modeLabel, r.reference, r.cashCounted && `Counted ${r.cashCounted}`].filter((v) => v && v !== "—").join(" · "),
    words: r.amount,
    by: [schedule ? "Prepared By" : "Collected By", r.collectedBy], installments: r.installments || [],
    note: schedule ? "This is a payment schedule, not a bill. No amount has been collected yet, and a bill is given for each installment when it is paid." : "",
  };
};

const STYLES = `
  /* Its own font link: this document opens in its own window and the app's CSS never
     reaches it. The PDF loads the same faces into the page that draws it (lib/pdf.js). */
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box}
  body{margin:0;padding:24px 0;background:#e2e8f0;color:#262626;font-family:'Inter','Segoe UI',Arial,sans-serif;
       font-size:15px;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* 718px is the 190mm between A4's 10mm margins, on paper and in the PDF alike, and
     1030px stops short of the 1047px a page holds. */
  .doc{display:flex;flex-direction:column;width:718px;max-width:100%;min-height:1030px;margin:0 auto;padding:18px 19px 8px;background:#fff}
  .head{display:flex;align-items:center;gap:30px}
  .mark{flex:none;display:block;width:85px;height:96px;object-fit:contain}
  .brand{color:${BLUE};font-size:50px;font-weight:800;line-height:1;letter-spacing:-1px}
  .tag{margin-top:7px;font-size:16px;font-weight:600}
  .tel{margin-top:4px;font-size:18px;font-weight:600}
  .rule{height:3px;margin-top:22px;background:${BLUE}}
  .title{margin-top:18px;color:${BLUE};font-size:23px;font-weight:700;letter-spacing:2px;text-align:center}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:20px}
  .row b,.val{font-weight:600}
  .top{margin-top:16px}
  .ref{margin-top:6px;font-size:13px;color:#404040}
  .sec{margin-top:16px;color:${BLUE};font-weight:700}
  .line{display:flex;flex-wrap:wrap;gap:4px 34px;margin-top:8px}
  .line .grow{flex:1 1 220px;min-width:0}
  .addr{margin-top:3px;font-size:12.5px;color:#525252}
  .dash{margin-top:14px;border-top:2px dashed #525252}
  table{width:100%;border-collapse:collapse}
  th,td{padding:0;text-align:left;vertical-align:top}
  .items{border-collapse:separate;border-spacing:0}
  .items th{padding:9px 0;font-weight:700}
  .items td{padding:9px 0}
  .items .sn{width:44px}.items .qty{width:70px;text-align:center}
  .items .num{width:118px;text-align:right;white-space:nowrap}
  .items small{display:block;margin-top:2px;font-size:12.5px;color:#525252}
  /* One cell the width of the table: a dashed border on five cells restarts at each. */
  .items .cut{padding:0;border-bottom:2px dashed #525252;line-height:0;font-size:0}
  .sum{margin-top:8px}
  .sum .row+.row{margin-top:5px}
  .total{margin-top:9px;color:${BLUE};font-size:21px;font-weight:700}
  .money{margin-top:10px}
  .money .row+.row{margin-top:6px}
  .bal,.bal b{color:#b91c1c;font-weight:600}
  .words{margin-top:10px;font-size:14px}
  .words b{font-weight:600}
  .mode{margin-top:10px}
  .plan{margin-top:12px}
  .plan h4{margin:0 0 4px;color:${BLUE};font-size:13px;font-weight:700}
  .plans{display:flex;gap:26px;align-items:flex-start}
  .plan table{font-size:12.5px}
  .plan th,.plan td{padding:4px 6px;border-bottom:1px solid #d5dae1}
  .plan th{background:#f3f6fa;font-weight:600}
  .plan .num{text-align:right;white-space:nowrap}
  .plan .paid{color:#15803d;font-weight:600}.plan .owed{color:#b45309;font-weight:600}
  /* A bill with a plan under it is closed up, so up to a dozen installments stay on one
     page with the signature. */
  .tight{font-size:14px;padding-top:10px}
  .tight .rule{margin-top:14px}.tight .title{margin-top:12px}.tight .top{margin-top:10px}.tight .sec{margin-top:10px}
  .tight .line{margin-top:5px}.tight .dash{margin-top:9px}
  .tight .items th,.tight .items td{padding:6px 0}.tight .items .cut{padding:0}
  .tight .total{margin-top:6px;font-size:20px}.tight .money{margin-top:7px}.tight .money .row+.row{margin-top:4px}
  .tight .words,.tight .mode{margin-top:7px}.tight .foot{padding-top:34px}.tight .thanks{margin-top:12px}
  .note{margin-top:16px;padding:10px 12px;border:1px solid #f0c36d;border-radius:4px;background:#fff9ee;color:#8a4b0a;font-size:13px}
  .foot{margin-top:auto;padding-top:40px}
  .sign{align-items:flex-end}
  .sign .box{position:relative;width:240px;padding-top:7px;border-top:2px dotted #525252;text-align:center;font-size:14px;color:#525252}
  /* The collector's sign, standing on the dotted line in the room a hand sign is left. A
     bill closed up for its plan keeps that room as it is. */
  .foot.signed{padding-top:62px}
  .tight .foot.signed{padding-top:34px}
  .ink{position:absolute;left:0;right:0;bottom:100%;margin-bottom:5px;line-height:0;text-align:center}
  .ink img{display:inline-block;max-width:220px;max-height:56px;vertical-align:bottom}
  .tight .ink img{max-height:34px}
  .thanks{margin-top:18px;font-size:17px;font-weight:600;text-align:center}
  /* No page margin, so the browser has nowhere to print its own date, title, about:blank and
     page number; the sheet carries the margin itself, on every page it runs to. */
  @page{size:A4;margin:0}
  @media print{
    body{padding:0;background:#fff}
    .doc{width:100%;min-height:1108px;padding:52px 57px 40px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
    tr,.foot,.row{break-inside:avoid}
  }
`;

const head = (title) => `
  <div class="head">
    <img class="mark" src="${BILL_LOGO}" alt="">
    <div><div class="brand">FITSIO_MAX</div><div class="tag">Pain Management | Athletic Rehab | Fitness</div><div class="tel">${PHONE}</div></div>
  </div>
  <div class="rule"></div>
  <div class="title">${escapeHtml(title)}</div>`;

const field = (label, value, cls = "") => (value === 0 || value ? `<div class="${cls}">${label}: <span class="val">${escapeHtml(value)}</span></div>` : "");
const row = (label, value, cls = "") => `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`;

/** "Anna Nagar Branch " -> "Anna Nagar": the line already says Branch. */
const branchLabel = (name) => String(name || "").trim().replace(/\s+branch$/i, "");

const patientHtml = (p, branch) => {
  const name = branchLabel(branch?.name);
  const address = [branch?.address, branch?.phone && `Phone: ${displayPhone(branch.phone)}`].filter(Boolean).join(" · ");
  return `
  <div class="sec">Patient Details:</div>
  <div class="line">${field("Name", p.name, "grow")}${field("Patient No", p.number)}</div>
  <div class="line">${field("Age", p.age)}${field("Sex", p.sex)}${field("Contact no", displayPhone(p.phone))}</div>
  ${name ? `<div class="line">${field("Branch", name)}</div>` : ""}
  ${address ? `<div class="addr">${escapeHtml(address)}</div>` : ""}`;
};

const page = (title, body, cls = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head><body><div class="doc ${cls}">${body}</div></body></html>`;

const CUT = `<tr><th class="cut" colspan="5"></th></tr>`;

/** The installments, in two columns once there are enough of them to run long. */
const planHtml = (plan) => {
  if (!plan.length) return "";
  const sessions = plan.some((i) => i.sessions);
  const rows = plan.map((i, n) => `<tr><td>${n + 1}</td>${sessions ? `<td>${escapeHtml(i.sessions || "—")}</td>` : ""}<td>${escapeHtml(billDay(i.due_date) || "—")}</td><td class="num">${two(i.amount)}</td><td class="${i.paid ? "paid" : "owed"}">${i.paid ? "Paid" : "Due"}</td></tr>`);
  const half = rows.length > 4 ? Math.ceil(rows.length / 2) : rows.length;
  const table = (part) => `<table><thead><tr><th>#</th>${sessions ? "<th>Sessions</th>" : ""}<th>Due Date</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${part.join("")}</tbody></table>`;
  return `<div class="plan"><h4>Payment Plan</h4><div class="plans">${table(rows.slice(0, half))}${half < rows.length ? table(rows.slice(half)) : ""}</div></div>`;
};

const footHtml = (by, sign = "") => `
  <div class="foot${sign ? " signed" : ""}">
    <div class="row sign">${by && by[1] ? `<div>${by[0]}: <b>${escapeHtml(by[1])}</b></div>` : "<div></div>"}<div class="box">${sign ? `<div class="ink"><img src="${sign}" alt=""></div>` : ""}Authorised Signature</div></div>
    <div class="thanks">Thank You</div>
  </div>`;

/** The bill (or Payment Schedule) for a receipt, as one printable document. */
export const billHtml = (r) => {
  const m = billModel(r);
  const plan = m.installments || [];
  return page(`${m.title === "PAYMENT SCHEDULE" ? "Payment Schedule" : "Bill"} ${m.number ? m.number[1] : m.reference[1]}`, `
  ${head(m.title)}
  <div class="row top"><span>${m.number ? `${m.number[0]}: <b>${escapeHtml(m.number[1])}</b>` : `${m.reference[0]}: <b>${escapeHtml(m.reference[1])}</b>`}</span><span>Date: <b>${escapeHtml(m.date)}</b></span></div>
  ${m.number ? `<div class="row ref"><span>${m.reference[0]}: <b>${escapeHtml(m.reference[1])}</b></span></div>` : ""}
  ${patientHtml(m.patient, m.branch)}

  <div class="dash"></div>
  <table class="items">
    <thead><tr><th class="sn">SN</th><th>Service</th><th class="qty">Qty</th><th class="num">Price</th><th class="num">Amt</th></tr>${CUT}</thead>
    <tbody>${m.items.map((i, n) => `<tr>
      <td class="sn">${n + 1}</td>
      <td>${escapeHtml(i.service)}${i.detail ? `<small>${escapeHtml(i.detail)}</small>` : ""}</td>
      <td class="qty">${escapeHtml(i.qty)}</td><td class="num">${two(i.price)}</td><td class="num">${two(i.amount)}</td>
    </tr>`).join("")}</tbody>
  </table>
  <div class="dash" style="margin-top:6px"></div>
  <div class="sum">
    ${row("Subtotal", rs(m.subtotal))}
    ${m.discount > 0 ? row(`Discount${m.subtotal > 0 ? ` (${Number(((m.discount / m.subtotal) * 100).toFixed(2))}%)` : ""}`, `- ${two(m.discount)}`) : ""}
  </div>
  <div class="dash" style="margin-top:9px"></div>
  ${row(m.totalLabel, rs(m.total), "total")}
  <div class="dash" style="margin-top:9px"></div>
  <div class="money">
    ${m.already > 0 ? row("Already Paid", rs(m.already)) : ""}
    ${m.now != null ? row("Paid Now", `<b>${rs(m.now)}</b>`) : ""}
    ${m.balance ? row(`Balance Due${m.due ? ` (${escapeHtml(m.due)})` : ""}`, `<b>${escapeHtml(m.balance)}</b>`, "bal") : ""}
  </div>
  <div class="words">${m.now != null ? "Paid Now" : "Total"} in words: <b>${amountInWords(m.words)}</b></div>
  ${m.payment ? `<div class="mode"><b>Payment mode:</b> ${escapeHtml(m.payment)}</div>` : ""}
  ${planHtml(plan)}
  ${m.note ? `<div class="note">${escapeHtml(m.note)}</div>` : ""}
  ${footHtml(m.by, m.sign)}`, plan.length ? "tight" : "");
};

/**
 * The message a bill is sent with: who it is for, what was paid, what is left, and nothing
 * else -- the rest is on the bill. `link` is the PDF's own link, for a chat that can carry
 * text but not a file; without one the PDF is in the message itself.
 */
export const billMessage = (r, link = "") => {
  const schedule = r.kind === "schedule";
  const name = /^(—|counter sale)?$/i.test(String(r.patient || "").trim()) ? "" : ` ${String(r.patient).trim()}`;
  const place = branchLabel(r.branch);
  const amount = `₹${(Number(r.amount) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const balance = r.bill?.balance > 0
    ? `Balance Due: ₹${Number(r.bill.balance).toLocaleString("en-IN", { maximumFractionDigits: 2 })}${r.bill.due_date ? ` on ${billDay(r.bill.due_date)}` : ""}`
    : "";
  return [
    `Hi${name},`,
    schedule
      ? `Your payment schedule for ${amount} from FITSIO_MAX${place ? `, ${place}` : ""}.`
      : `Thank you for your payment of ${amount} at FITSIO_MAX${place ? `, ${place}` : ""}.`,
    r.bill?.bill_no ? `Bill No: ${r.bill.bill_no}` : "",
    balance,
    link ? `\nYour bill (PDF):\n${link}` : "",
  ].filter(Boolean).join("\n");
};

/**
 * Everything one client has paid, on the same paper: Client Details' Print and Download.
 *
 * rows: [{ date, service, reference, mode, amount }], oldest first.
 */
export const statementHtml = ({ client, rows, billed, discount, paid, balance, due }) => page(`Payment Statement ${client.name || ""}`, `
  ${head("PAYMENT STATEMENT")}
  <div class="row top"><span>${client.patient_number ? `Patient No: <b>${escapeHtml(client.patient_number)}</b>` : ""}</span><span>Date: <b>${escapeHtml(billDateTime(new Date().toISOString()))}</b></span></div>
  ${patientHtml({ name: client.name, phone: client.phone }, { name: client.branch_name })}
  <div class="dash"></div>
  <table class="items">
    <thead><tr><th class="sn">SN</th><th style="width:112px">Date</th><th>Payment</th><th style="width:130px">Mode</th><th class="num">Amt</th></tr>${CUT}</thead>
    <tbody>${rows.length ? rows.map((r, n) => `<tr>
      <td class="sn">${n + 1}</td><td>${escapeHtml(billDateTime(r.date).split(",")[0])}</td>
      <td>${escapeHtml(r.service)}${r.reference ? `<small>${escapeHtml(r.reference)}</small>` : ""}</td>
      <td>${escapeHtml(r.mode)}</td><td class="num">${two(r.amount)}</td>
    </tr>`).join("") : `<tr><td colspan="5">No payments yet.</td></tr>`}</tbody>
  </table>
  <div class="dash" style="margin-top:6px"></div>
  <div class="sum">
    ${row("Total Billed", rs(billed))}
    ${discount > 0 ? row("Discount", `- ${two(discount)}`) : ""}
  </div>
  <div class="dash" style="margin-top:9px"></div>
  ${row("TOTAL PAID", rs(paid), "total")}
  <div class="dash" style="margin-top:9px"></div>
  <div class="money">${balance > 0 ? row(`Balance Due${due ? ` (${escapeHtml(billDay(due))})` : ""}`, `<b>${rs(balance)}</b>`, "bal") : row("Balance Due", `<b>${rs(0)}</b>`)}</div>
  <div class="words">Total paid in words: <b>${amountInWords(paid)}</b></div>
  ${footHtml(null)}`);
