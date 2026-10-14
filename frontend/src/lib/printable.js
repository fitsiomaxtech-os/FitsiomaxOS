// Branded documents the clinic hands to a client — payment receipts, appointment
// confirmations. Each is built as a standalone HTML document and opened in its own
// window rather than printed from the page: window.print() on the app would send the
// whole board, modals and all, to the printer. The same document is what Download saves
// and what Print renders, so screen, paper and file can never disagree.
import { toast } from "@/components/ui/sonner";

// The mark the login page and CRM header already use, so a printed sheet is recognisably
// the OS's.
export const LOGO_URL =
  "https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707/artifacts/nozl77ti_Logo%20Icon.webp";

export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export const PRINTABLE_STYLES = `
  /* Its own font link. This is a standalone document opened in its own window, so the
     app's index.css never reaches it — without this the sheet falls back to Segoe UI and
     paper stops matching screen. Segoe UI stays in the stack: a printer with no network
     still produces a receipt. */
  @import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box}
  /* One accent per document state, set on .doc, so every tinted surface follows it. */
  .doc{--accent:#115e59;--soft:#e6f6f3;--edge:#5eb8ac}
  .tone-paid{--accent:#047857;--soft:#ecfdf5;--edge:#a7f3d0}
  .tone-sch{--accent:#b45309;--soft:#fffbeb;--edge:#fde68a}
  .tone-appt{--accent:#115e59;--soft:#e6f6f3;--edge:#5eb8ac}
  /* print-color-adjust, or the browser drops every tint and the accent bar on paper. */
  body{margin:0;padding:32px 16px;font-family:'Lexend','Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.45;
       color:#0f172a;background:#e2e8f0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc{position:relative;max-width:760px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;
       box-shadow:0 12px 32px rgba(15,23,42,.14)}
  .bar{height:6px;background:var(--accent)}

  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:26px 34px 22px;border-bottom:1px solid #cbd5e1}
  .brand-row{display:flex;align-items:center;gap:14px;min-width:0}
  .logo{width:58px;height:58px;object-fit:contain;border-radius:14px;background:var(--soft);border:1px solid var(--edge);padding:7px;flex:none}
  .brand{font-size:23px;font-weight:800;letter-spacing:2px;line-height:1.1}
  .sub{font-size:11.5px;color:#334155;margin-top:2px}
  .branch{font-size:12px;font-weight:600;color:#0f172a;margin-top:5px}
  .meta{text-align:right;flex:none}
  /* -1.5px: letter-spacing puts a gap after the last letter as well, so a right-aligned
     title hangs 1.5px short of the lines beneath it. Pulled back onto the same edge. */
  .doc-title{font-size:19px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:1.5px;
             line-height:1.1;margin-right:-1.5px}
  .meta-line{font-size:11.5px;color:#334155;margin-top:5px}
  .meta-line b{color:#0f172a;font-weight:600;margin-left:6px}
  /* The right padding is a letter-spacing short of the left on every tracked pill below:
     that trailing gap is inside the box, so matched padding leaves the words looking
     shifted left. This is what centres them.

     There was a 6px status dot before the word, drawn by .pill::before with a 6px gap
     after it. It never reached the PDF: html2canvas (lib/pdf.js) does not resolve
     currentColor on a pseudo-element, so it drew nothing -- but the dot's 6px box and
     the 6px gap were still laid out, pushing the word 12px right of centre inside a
     pill whose padding is tuned to the tenth of a pixel. Pseudo-elements themselves are
     fine -- .steps li::before below draws its checkmarks on the same sheet -- but that
     one names var(--accent) outright, which is the difference. It did render in the tab the
     Print button opens, so the file and the paper disagreed on a sheet that exists to
     be the same either way. Gone rather than recoloured: the pill's own tint already
     carries the status, and a dot that two renderers draw differently is a liability. */
  .pill{display:inline-flex;align-items:center;margin-top:9px;padding:4px 10.1px 4px 11px;border-radius:999px;
        font-size:10.5px;font-weight:700;letter-spacing:.9px;background:var(--soft);color:var(--accent);border:1px solid var(--edge)}

  .body{padding:24px 34px 8px}
  .label{font-size:10.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#334155;margin:0 0 8px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:stretch}
  .panel{border:1px solid #94a3b8;border-radius:12px;padding:15px 17px}
  .name{font-size:17px;font-weight:700;margin-bottom:6px}
  .kv{width:100%;border-collapse:collapse}
  .kv td{padding:3.5px 0;font-size:12px;vertical-align:top;color:#0f172a}
  .kv td.k{color:#334155;width:42%;padding-right:12px}
  .kv td.v{font-weight:700;word-break:break-word}

  .amount{position:relative;display:flex;flex-direction:column;justify-content:center;text-align:right;
          background:var(--soft);border:1px solid var(--edge);border-radius:12px;padding:16px 18px;overflow:hidden}
  .amount .value{font-size:31px;font-weight:800;color:var(--accent);line-height:1.15;margin-top:2px}
  .amount .mode{font-size:12px;color:#475569;margin-top:4px}
  .stamp{position:absolute;left:18px;top:50%;transform:translateY(-50%) rotate(-14deg);border:2.5px solid var(--accent);
         color:var(--accent);border-radius:8px;padding:3px 7px 3px 10px;font-size:17px;font-weight:800;
         letter-spacing:3px;opacity:.45}

  .items{width:100%;border-collapse:collapse;margin-top:22px}
  .items th{text-align:left;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:#64748b;font-weight:700;
            padding:9px 12px;background:#f8fafc;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0}
  .items td{padding:12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:12.5px}
  .items .num{text-align:right;white-space:nowrap}
  .items th.num{padding-right:11px}
  .items .desc{font-weight:600}
  .items .desc small{display:block;font-weight:400;color:#64748b;font-size:11.5px;margin-top:2px}
  .badge{display:inline-block;padding:2px 7.4px 2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.6px}
  .badge-paid{background:#dcfce7;color:#15803d}
  .badge-due{background:#fef3c7;color:#b45309}

  .summary{margin-top:18px}
  .totals{width:100%;border-collapse:collapse;align-self:start}
  .totals td{padding:5px 2px;font-size:12.5px}
  .totals td.num{text-align:right;font-weight:600;white-space:nowrap}
  .totals .off td{color:#be123c}
  .totals .grand td{font-size:15.5px;font-weight:800;color:var(--accent);border-top:2px solid #0f172a;padding-top:10px}
  .totals .due td{color:#be123c;font-weight:700}

  .hero{display:flex;gap:20px;align-items:center;background:var(--soft);border:1px solid var(--edge);border-radius:14px;padding:18px 20px}
  .tile{flex:none;width:100px;border-radius:12px;background:#fff;border:1px solid var(--edge);color:#0f172a;text-align:center;overflow:hidden}
  .tile .m{background:var(--accent);color:#fff;font-size:11px;font-weight:700;letter-spacing:2px;padding:5px 0 5px 2px}
  .tile .d{font-size:38px;font-weight:800;line-height:1;padding-top:10px}
  .tile .w{font-size:11px;font-weight:600;color:#334155;padding:6px 0 10px}
  .when{font-size:21px;font-weight:800;color:var(--accent);line-height:1.2}
  .time{font-size:15px;font-weight:700;margin-top:3px;color:#0f172a}
  .facts{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:10px;font-size:12px;color:#334155}
  .facts b{color:#0f172a;font-weight:700;word-break:break-all}

  .note{margin-top:18px;padding:12px 15px;border-radius:10px;background:#f8fafc;border:1px solid #94a3b8;font-size:12px;color:#1e293b;line-height:1.6}
  .note-warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
  .steps{list-style:none;margin:0;padding:0}
  .steps li{position:relative;padding-left:26px;margin:6px 0;line-height:18px}
  /* The tick is drawn, not typed. It used to be a check-mark character, which Lexend has no
     glyph for: each renderer fell back to a different font, and in the PDF the tick sat
     low and left inside its circle. A rotated border corner lands in the same place in
     every renderer. */
  .steps li::before{content:"";position:absolute;left:0;top:1px;width:16px;height:16px;border-radius:50%;background:var(--accent)}
  .steps li::after{content:"";position:absolute;left:5.5px;top:4.5px;width:4px;height:7px;border:solid #fff;
                   border-width:0 2px 2px 0;transform:rotate(45deg)}

  .foot{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:22px;padding:16px 34px 22px;
        border-top:1px dashed #94a3b8;font-size:11px;color:#475569;line-height:1.6}
  .thanks{font-size:13px;font-weight:700;color:var(--accent);text-align:right}

  @page{size:A4;margin:12mm}
  @media print{body{padding:0;background:#fff}.doc{box-shadow:none;border-radius:0;max-width:none}}
  @media (max-width:600px){
    .head{flex-direction:column}.meta{text-align:left}.grid2{grid-template-columns:1fr}
    .head,.body,.foot{padding-left:18px;padding-right:18px}.foot{flex-direction:column;align-items:flex-start}.thanks{text-align:left}
  }
`;

/** Rows are [label, value] pairs; falsy entries are dropped so callers can inline conditions. */
export const rowsHtml = (rows) => `<table class="kv">${rows.filter(Boolean).map(
  ([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`,
).join("")}</table>`;

/** "1200" -> "Rs.1,200". Anything that isn't a plain number is printed as it came. */
export const rupees = (v) => {
  const n = Number(v);
  return `Rs.${v !== "" && v != null && Number.isFinite(n) ? n.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : escapeHtml(v)}`;
};

/**
 * The letterhead every printable opens with — brand on the left, what the document is and
 * its number on the right — so a receipt and an appointment sheet read as one stationery.
 * `meta` is [label, value] pairs; `status` is the pill under the title.
 */
export const docHeadHtml = ({ title, meta = [], status, branch }) => `<div class="bar"></div>
  <div class="head">
    <div class="brand-row">
      <img class="logo" src="${LOGO_URL}" alt="FITSIOMAX">
      <div>
        <div class="brand">FITSIOMAX</div>
        <div class="sub">Physiotherapy &amp; Rehabilitation</div>
        ${branch ? `<div class="branch">${escapeHtml(branch)}</div>` : ""}
      </div>
    </div>
    <div class="meta">
      <div class="doc-title">${escapeHtml(title)}</div>
      ${meta.filter(Boolean).map(([k, v]) => `<div class="meta-line">${escapeHtml(k)}<b>${escapeHtml(v)}</b></div>`).join("")}
      ${status ? `<div class="pill">${escapeHtml(status)}</div>` : ""}
    </div>
  </div>`;

/**
 * Opens the document in its own window.
 *
 * `print` also raises the print dialog — where the browser's own "Save as PDF" lives, so
 * this is the PDF path without shipping a PDF library. It waits for the logo before
 * printing: document.write returns immediately while the image is still loading, and
 * printing on a timer produces a sheet with a blank space where the logo should be, at
 * random. `load` fires even if the image fails, and the timeout covers it never resolving.
 */
export const openPrintable = (html, { print = false } = {}) => {
  const w = window.open("", "_blank", "width=720,height=860");
  if (!w) { toast.error("Allow pop-ups to open the document"); return null; }
  w.document.write(html);
  w.document.close();
  w.focus();
  if (!print) return w;
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    try { w.print(); } catch { /* window was closed before printing */ }
  };
  if (w.document.readyState === "complete") go();
  else w.addEventListener("load", go, { once: true });
  setTimeout(go, 3000);
  return w;
};

// A cell that starts with one of these is executed as a formula when the sheet is opened,
// so a designation somebody typed as "-Senior Physio" would run rather than read. Prefixed
// with an apostrophe, which Excel strips on display and never evaluates.
const CSV_FORMULA_START = /^[=+\-@\t\r]/;

const csvCell = (value) => {
  const raw = value == null ? "" : String(value);
  const text = CSV_FORMULA_START.test(raw) ? `'${raw}` : raw;
  // Quoted only when it has to be, and an inner quote doubled, which is how CSV escapes it.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Rows of cells as a .csv, which Excel opens natively — no library, and no .xlsx writer to
 * carry for a two-column list.
 *
 * The byte-order mark is not decoration: without it Excel reads the file in the local
 * codepage and any name with an accent or a rupee sign arrives mangled. CRLF for the same
 * reason — it is what Excel writes, and what older versions expect to read.
 */
export const downloadCsv = (rows, filename) => {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
