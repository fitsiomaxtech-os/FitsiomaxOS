// The Leads Converted tab's month-end report, as a PDF and as an Excel workbook.
//
// Both are drawn from one report object (see LeadsConvertedRecords), so the file a Branch
// Admin prints and the sheet they send on cannot disagree. Two parts in each: the summary
// -- the six cards and the same six counts split by source -- and then the leads behind
// them, one per row.
import { escapeHtml, LOGO_URL } from "@/lib/printable";
import { htmlPagesToPdf, savePdf } from "@/lib/pdf";
import { downloadXlsx, xlsxColName } from "@/lib/xlsx";
import { toast } from "@/components/ui/sonner";

/**
 * report = {
 *   branch, period, source, showing, generated,
 *   summary:  [{ label, count, share }],             -- the six cards, in card order
 *   bySource: { rows: [[source, ...counts]], total: [...counts] } -- counts in card order
 *   leads:    [{ patientNumber, name, phone, email, source, reached, stage, services, date, time }],
 * }
 */

// ---------------------------------------------------------------------------------------
// PDF
//
// Laid out page by page rather than as one long sheet, so a page always ends between two
// rows -- see htmlPagesToPdf. Rows are one line each at a fixed height (long text is cut
// with an ellipsis), which is what makes "how many rows fit" a number rather than a guess.
// ---------------------------------------------------------------------------------------

const SOURCE_ROWS_FIRST_PAGE = 18;
const SOURCE_ROWS_PER_PAGE = 30;
const LEAD_ROWS_PER_PAGE = 35;

const REPORT_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box}
  body{margin:0;background:#fff;font-family:'Lexend','Segoe UI',Arial,sans-serif;color:#0f172a;
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{position:relative;width:794px;height:1123px;overflow:hidden;background:#fff}
  .bar{height:6px;background:#0f766e}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:24px 30px 20px;border-bottom:1px solid #e2e8f0}
  .brand-row{display:flex;align-items:center;gap:14px}
  .logo{width:54px;height:54px;object-fit:contain;border-radius:12px;background:#f0fdfa;border:1px solid #99f6e4;padding:6px}
  .brand{font-size:22px;font-weight:800;letter-spacing:2px;line-height:1.1}
  .sub{font-size:11px;color:#64748b;margin-top:2px}
  .branch{font-size:12px;font-weight:600;color:#334155;margin-top:4px}
  .meta{text-align:right}
  .title{font-size:18px;font-weight:800;color:#0f766e;text-transform:uppercase;letter-spacing:1.5px;margin-right:-1.5px}
  .meta-line{font-size:11px;color:#64748b;margin-top:5px}
  .meta-line b{color:#0f172a;font-weight:600;margin-left:6px}
  .strip{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 30px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b}
  .strip b{color:#0f766e;font-weight:800;letter-spacing:1px;text-transform:uppercase;font-size:12px}
  .body{padding:20px 30px 0}
  .label{font-size:10.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#64748b;margin:0 0 8px}
  .label span{color:#94a3b8;font-weight:600;letter-spacing:.4px;text-transform:none;margin-left:6px}
  .tiles{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:22px}
  .tile{border:1px solid #e2e8f0;border-radius:8px;padding:9px 10px}
  .tile .k{font-size:10px;color:#64748b;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tile .v{font-size:22px;font-weight:800;line-height:1.2;margin-top:2px}
  .tile .s{font-size:9.5px;color:#94a3b8}
  .tile.lost .v{color:#be123c}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th{background:#475569;color:#fff;font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;font-weight:700;
     text-align:left;padding:0 8px;height:30px}
  td{font-size:10.5px;padding:0 8px;height:26px;border-bottom:1px solid #e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  tr:nth-child(even) td{background:#f8fafc}
  .num{text-align:right}
  th.num{text-align:right}
  tr.total td{background:#f1f5f9;font-weight:700;border-top:2px solid #0f172a}
  .muted{color:#94a3b8}
  .empty{padding:28px;text-align:center;color:#94a3b8;font-size:12px;border:1px dashed #cbd5e1;border-radius:8px}
  .foot{position:absolute;left:30px;right:30px;bottom:18px;display:flex;justify-content:space-between;
        padding-top:10px;border-top:1px dashed #cbd5e1;font-size:10px;color:#94a3b8}
`;

const chunk = (list, first, rest) => {
  const out = [list.slice(0, first)];
  for (let i = first; i < list.length; i += rest) out.push(list.slice(i, i + rest));
  return out;
};

const reportHeadHtml = (r) => `<div class="bar"></div>
  <div class="head">
    <div class="brand-row">
      <img class="logo" src="${LOGO_URL}" alt="FITSIOMAX">
      <div>
        <div class="brand">FITSIOMAX</div>
        <div class="sub">Physiotherapy &amp; Rehabilitation</div>
        ${r.branch ? `<div class="branch">${escapeHtml(r.branch)}</div>` : ""}
      </div>
    </div>
    <div class="meta">
      <div class="title">Leads Report</div>
      <div class="meta-line">Period<b>${escapeHtml(r.period)}</b></div>
      <div class="meta-line">Source<b>${escapeHtml(r.source)}</b></div>
    </div>
  </div>`;

// Every page after the first: enough to say whose report this is if it is found loose.
const stripHtml = (r) => `<div class="bar"></div>
  <div class="strip"><b>Leads Report</b><span>${escapeHtml([r.branch, r.period, r.source].filter(Boolean).join(" · "))}</span></div>`;

const COUNT_HEADS = (r) => r.summary.map((s) => s.label);

const sourceTableHtml = (r, rows, withTotal) => `<table>
  <colgroup><col style="width:190px">${COUNT_HEADS(r).map(() => "<col>").join("")}</colgroup>
  <thead><tr><th>Source</th>${COUNT_HEADS(r).map((h) => `<th class="num">${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>
    ${rows.map(([name, ...counts]) => `<tr><td title="${escapeHtml(name)}">${escapeHtml(name)}</td>${counts.map((c) => `<td class="num">${c}</td>`).join("")}</tr>`).join("")}
    ${withTotal ? `<tr class="total"><td>Total</td>${r.bySource.total.map((c) => `<td class="num">${c}</td>`).join("")}</tr>` : ""}
  </tbody>
</table>`;

const LEAD_COLS = [
  ["#", 36, (l, n) => n],
  ["Patient No.", 74, (l) => l.patientNumber],
  ["Patient Name", 148, (l) => l.name],
  ["Phone", 84, (l) => l.phone],
  ["Source", 96, (l) => l.source],
  ["Reached", 108, (l) => l.reached],
  ["Current Stage", 100, (l) => l.stage],
  ["Created", 88, (l) => l.date],
];

const leadTableHtml = (rows, startNo) => `<table>
  <colgroup>${LEAD_COLS.map(([, w]) => `<col style="width:${w}px">`).join("")}</colgroup>
  <thead><tr>${LEAD_COLS.map(([h]) => `<th${h === "#" ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((l, i) => `<tr>${LEAD_COLS.map(([h, , get]) => {
    const v = get(l, startNo + i);
    const text = v === null || v === undefined || v === "" ? "—" : String(v);
    return `<td${h === "#" ? ' class="num muted"' : ""} title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
  }).join("")}</tr>`).join("")}</tbody>
</table>`;

export const leadsReportHtml = (r) => {
  const sourcePages = chunk(r.bySource.rows, SOURCE_ROWS_FIRST_PAGE, SOURCE_ROWS_PER_PAGE);
  const leadPages = r.leads.length ? chunk(r.leads, LEAD_ROWS_PER_PAGE, LEAD_ROWS_PER_PAGE) : [];
  const listTitle = `Lead List<span>${escapeHtml(r.showing)} · ${r.leads.length}</span>`;

  const pages = [];
  // Page one: the summary. The lead list always starts on a page of its own, so the
  // first page reads as the month at a glance and can be handed over by itself.
  pages.push(`${reportHeadHtml(r)}<div class="body">
    <p class="label">Summary</p>
    <div class="tiles">${r.summary.map((s) => `<div class="tile${s.key === "lost" ? " lost" : ""}">
      <div class="k">${escapeHtml(s.label)}</div><div class="v">${s.count}</div><div class="s">${escapeHtml(s.share)}</div>
    </div>`).join("")}</div>
    <p class="label">Source-wise Breakdown</p>
    ${r.bySource.rows.length ? sourceTableHtml(r, sourcePages[0], sourcePages.length === 1) : '<div class="empty">No leads in this period.</div>'}
    ${!r.leads.length ? `<p class="label" style="margin-top:22px">${listTitle}</p><div class="empty">No leads in this selection.</div>` : ""}
  </div>`);
  sourcePages.slice(1).forEach((rows, i) => {
    pages.push(`${stripHtml(r)}<div class="body">
      <p class="label">Source-wise Breakdown<span>continued</span></p>
      ${sourceTableHtml(r, rows, i === sourcePages.length - 2)}
    </div>`);
  });
  leadPages.forEach((rows, i) => {
    pages.push(`${stripHtml(r)}<div class="body">
      <p class="label">${listTitle}${i ? "<span>continued</span>" : ""}</p>
      ${leadTableHtml(rows, i * LEAD_ROWS_PER_PAGE + 1)}
    </div>`);
  });

  const total = pages.length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Leads Report</title><style>${REPORT_STYLES}</style></head><body>
    ${pages.map((p, i) => `<div class="page">${p}<div class="foot"><span>Generated ${escapeHtml(r.generated)}</span><span>Page ${i + 1} of ${total}</span></div></div>`).join("")}
  </body></html>`;
};

export const downloadLeadsReportPdf = async (r, filename) => {
  try {
    savePdf(await htmlPagesToPdf(leadsReportHtml(r)), filename);
  } catch {
    toast.error("Couldn't build the PDF");
  }
};

// ---------------------------------------------------------------------------------------
// Excel: two sheets. Summary carries the same two tables as the PDF's first page; Leads is
// the list, its header frozen and filterable so the sheet can be cut further in Excel.
// ---------------------------------------------------------------------------------------

export const downloadLeadsReportXlsx = (r, filename) => {
  const heads = COUNT_HEADS(r);
  const width = heads.length + 1;
  const titleRows = (title) => [
    { cells: [{ v: title, s: "title" }], height: 24 },
    { cells: [{ v: `Branch: ${r.branch || "—"}`, s: "subtitle" }] },
    { cells: [{ v: `Period: ${r.period}   ·   Source: ${r.source}`, s: "subtitle" }] },
    { cells: [{ v: `Generated: ${r.generated}`, s: "subtitle" }] },
    [],
  ];

  const summaryRows = [
    ...titleRows("FITSIOMAX — Leads Report"),
    { cells: [{ v: "Summary", s: "section" }] },
    { cells: ["Stage", "Count", "% of Leads"], style: "header", height: 20 },
    ...r.summary.map((s) => ({ cells: [{ v: s.label, s: "total" }, s.count, s.share], style: "cell" })),
    [],
    { cells: [{ v: "Source-wise Breakdown", s: "section" }] },
    { cells: ["Source", ...heads], style: "header", height: 20 },
    ...r.bySource.rows.map((row) => ({ cells: row, style: "cell" })),
    { cells: ["Total", ...r.bySource.total], style: "total" },
  ];

  const leadHeads = ["S.No", "Patient No.", "Patient Name", "Phone", "Email", "Source", "Reached",
    "Current Stage", "Services Bought", "Lead Created Date", "Time"];
  const listStart = 4; // title, branch, period line, blank -- then the header
  const leadRows = [
    { cells: [{ v: `Lead List — ${r.showing} (${r.leads.length})`, s: "title" }], height: 24 },
    { cells: [{ v: `Branch: ${r.branch || "—"}   ·   Period: ${r.period}   ·   Source: ${r.source}`, s: "subtitle" }] },
    { cells: [{ v: `Generated: ${r.generated}`, s: "subtitle" }] },
    { cells: leadHeads, style: "header", height: 20 },
    ...r.leads.map((l, i) => ({
      cells: [i + 1, l.patientNumber || "", l.name || "", l.phone || "", l.email || "", l.source, l.reached,
        l.stage, l.services || "", l.date, l.time],
      style: "cell",
    })),
  ];

  downloadXlsx([
    {
      name: "Summary",
      rows: summaryRows,
      cols: [28, ...heads.map((h) => Math.max(12, h.length + 4))],
      merges: [`A1:${xlsxColName(width - 1)}1`],
    },
    {
      name: "Leads",
      rows: leadRows,
      cols: [7, 14, 26, 14, 28, 18, 18, 22, 26, 17, 11],
      freezeRows: listStart,
      merges: [`A1:${xlsxColName(leadHeads.length - 1)}1`],
      autoFilter: `A${listStart}:${xlsxColName(leadHeads.length - 1)}${listStart + Math.max(r.leads.length, 1)}`,
    },
  ], filename);
};
