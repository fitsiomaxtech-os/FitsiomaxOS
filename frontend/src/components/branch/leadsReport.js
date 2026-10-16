// The Leads Converted tab's month-end report, as a PDF and as an Excel workbook.
//
// Both are drawn from one report object (see LeadsConvertedRecords), so the file a Branch
// Admin prints and the sheet they send on cannot disagree. Two parts in each: the summary
// -- the six cards and the same six counts split by source -- and then the leads behind
// them, one per row.
import { LOGO_URL } from "@/lib/printable";
import { savePdf } from "@/lib/pdf";
import { downloadXlsx, xlsxColName } from "@/lib/xlsx";
import { toast } from "@/components/ui/sonner";
import { displayPhone } from "@/lib/phone";

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
// Drawn with jsPDF's own text and shapes, not rendered from HTML. The first version went
// through html2canvas, and in a real browser it set Lexend's letter-spacing a glyph at a
// time ("FI TSI OMAX"), cut the tile labels in half, sat table text on the row rules and
// broke "CONSULTATION VISIT" mid-word. Here every string is placed at a measured point, so
// the alignment is the same on every machine, the text stays selectable, and a page ends
// between rows by arithmetic rather than by where a canvas slice happened to fall.
//
// Units are mm on an A4 landscape page: the lead list needs nine columns in full, and a
// portrait page could only hold them by cutting phone numbers, stages and dates short.
// ---------------------------------------------------------------------------------------

const PAGE_W = 297;
const PAGE_H = 210;
const M = 12; // side margin
const CONTENT_W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 18; // last line a row may end on; the footer lives below it

const C = {
  ink: [15, 23, 42],
  body: [51, 65, 85],
  muted: [100, 116, 139],
  faint: [148, 163, 184],
  rule: [226, 232, 240],
  zebra: [248, 250, 252],
  head: [71, 85, 105],
  shade: [241, 245, 249],
  accent: [15, 118, 110],
  accentSoft: [240, 253, 250],
  accentEdge: [153, 246, 228],
  lost: [190, 18, 60],
  white: [255, 255, 255],
};

// The built-in Helvetica only covers Latin-1 (WinAnsi). A character outside it -- a Tamil
// name, an emoji in a source -- would print as junk, so it is dropped instead; dashes and
// the middle dot are inside the set and survive.
const pdfSafe = (v) => String(v ?? "")
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[^ -~ -ÿ–—•…]/g, "")
  .replace(/\s+/g, " ")
  .trim();

// Cut to fit the cell, with an ellipsis, by measured width rather than character count.
const fit = (pdf, text, width) => {
  const t = pdfSafe(text);
  if (pdf.getTextWidth(t) <= width) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pdf.getTextWidth(`${t.slice(0, mid).trimEnd()}...`) <= width) lo = mid; else hi = mid - 1;
  }
  return `${t.slice(0, lo).trimEnd()}...`;
};

const fill = (pdf, rgb) => pdf.setFillColor(...rgb);
const stroke = (pdf, rgb) => pdf.setDrawColor(...rgb);
const ink = (pdf, rgb) => pdf.setTextColor(...rgb);
const font = (pdf, style, size) => { pdf.setFont("helvetica", style); pdf.setFontSize(size); };

// The logo as a PNG data URL. It is a .webp on a CDN, which jsPDF does not read, so it goes
// through a canvas. Any failure -- offline, CORS, a slow CDN -- costs the logo only.
const loadLogo = () => new Promise((resolve) => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  let timer = null;
  const done = (v) => { clearTimeout(timer); resolve(v); };
  timer = setTimeout(() => done(null), 3000);
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 256;
      c.height = img.naturalHeight || 256;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      done(c.toDataURL("image/png"));
    } catch { done(null); }
  };
  img.onerror = () => done(null);
  img.src = LOGO_URL;
});

const sectionLabel = (pdf, text, y, note) => {
  font(pdf, "bold", 8);
  ink(pdf, C.muted);
  pdf.text(text.toUpperCase(), M, y, { charSpace: 0.35 });
  if (note) {
    const w = pdf.getTextWidth(text.toUpperCase()) + text.length * 0.35;
    font(pdf, "normal", 8);
    ink(pdf, C.faint);
    pdf.text(note, M + w + 2.5, y);
  }
};

// Page one's letterhead: brand on the left, what this is and what it covers on the right.
const drawLetterhead = (pdf, r, logo) => {
  fill(pdf, C.accent);
  pdf.rect(0, 0, PAGE_W, 2, "F");

  const top = 10;
  let textX = M;
  if (logo) {
    fill(pdf, C.accentSoft);
    stroke(pdf, C.accentEdge);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(M, top, 17, 17, 3, 3, "FD");
    pdf.addImage(logo, "PNG", M + 2, top + 2, 13, 13);
    textX = M + 21;
  }
  font(pdf, "bold", 17);
  ink(pdf, C.ink);
  pdf.text("FITSIOMAX", textX, top + 6.5, { charSpace: 0.8 });
  font(pdf, "normal", 8.5);
  ink(pdf, C.muted);
  pdf.text("Physiotherapy & Rehabilitation", textX, top + 11.5);
  if (r.branch) {
    font(pdf, "bold", 9);
    ink(pdf, C.body);
    pdf.text(fit(pdf, r.branch, 120), textX, top + 16.5);
  }

  const right = PAGE_W - M;
  font(pdf, "bold", 14);
  ink(pdf, C.accent);
  pdf.text(r.title || "LEADS REPORT", right, top + 6.5, { align: "right" });
  const meta = r.meta || [["Period", r.period], ["Source", r.source], ["Showing", r.showing]];
  meta.forEach(([k, v], i) => {
    const y = top + 12 + i * 4.6;
    font(pdf, "bold", 8.5);
    ink(pdf, C.ink);
    const value = fit(pdf, v, 110);
    pdf.text(value, right, y, { align: "right" });
    const vw = pdf.getTextWidth(value);
    font(pdf, "normal", 8.5);
    ink(pdf, C.muted);
    pdf.text(k, right - vw - 2, y, { align: "right" });
  });

  stroke(pdf, C.rule);
  pdf.setLineWidth(0.3);
  pdf.line(M, 36, PAGE_W - M, 36);
  return 44;
};

// Every later page: enough to say whose report this is if the page is found loose.
const drawStrip = (pdf, r) => {
  fill(pdf, C.accent);
  pdf.rect(0, 0, PAGE_W, 2, "F");
  font(pdf, "bold", 9.5);
  ink(pdf, C.accent);
  pdf.text(r.title || "LEADS REPORT", M, 10, { charSpace: 0.4 });
  font(pdf, "normal", 8);
  ink(pdf, C.muted);
  const strip = r.strip || [r.branch, r.period, r.source];
  pdf.text(fit(pdf, strip.filter(Boolean).join("  ·  "), 200), PAGE_W - M, 10, { align: "right" });
  stroke(pdf, C.rule);
  pdf.setLineWidth(0.3);
  pdf.line(M, 13.5, PAGE_W - M, 13.5);
  return 21;
};

// The six cards, as on screen: label, count, share.
const drawTiles = (pdf, summary, y) => {
  const gap = 3;
  const w = (CONTENT_W - gap * (summary.length - 1)) / summary.length;
  const h = 19;
  summary.forEach((s, i) => {
    const x = M + i * (w + gap);
    fill(pdf, C.white);
    stroke(pdf, C.rule);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(x, y, w, h, 1.8, 1.8, "FD");
    font(pdf, "bold", 7);
    ink(pdf, C.muted);
    pdf.text(fit(pdf, s.label, w - 5), x + 2.8, y + 5);
    font(pdf, "bold", 15);
    ink(pdf, s.key === "lost" ? C.lost : C.ink);
    pdf.text(String(s.count), x + 2.8, y + 12);
    font(pdf, "normal", 6.5);
    ink(pdf, C.faint);
    pdf.text(fit(pdf, s.share, w - 5), x + 2.8, y + 16.2);
  });
  return y + h;
};

/**
 * A table that runs onto as many pages as it needs, its header repeated on each.
 * cols: [{ header, width, align, wrap }]; rows: arrays of cell text; total: an optional last row.
 * A `wrap` column runs a long value onto a second line (and a third at most) instead of
 * cutting it, and its row grows to hold it; every other column stays one line.
 * Returns the y it finished at.
 */
const drawTable = (pdf, { cols, rows, total, y, rowH = 6.4, size = 8, onNewPage }) => {
  const headSize = 6.8;
  const pad = 2;
  // Headers wrap rather than truncate -- "Consultation Visit" in a narrow count column
  // reads as two lines, never as "CONSULTATI ON".
  font(pdf, "bold", headSize);
  const headLines = cols.map((c) => pdf.splitTextToSize(pdfSafe(c.header).toUpperCase(), c.width - pad * 2));
  const lineCount = Math.max(...headLines.map((l) => l.length));
  const headH = Math.max(7.5, 3.4 + lineCount * 3);

  const drawHead = (top) => {
    fill(pdf, C.head);
    pdf.rect(M, top, CONTENT_W, headH, "F");
    font(pdf, "bold", headSize);
    ink(pdf, C.white);
    let x = M;
    cols.forEach((c, i) => {
      const lines = headLines[i];
      const blockH = (lines.length - 1) * 3;
      const firstY = top + headH / 2 - blockH / 2 + 1.1;
      lines.forEach((line, li) => {
        const tx = c.align === "right" ? x + c.width - pad : x + pad;
        pdf.text(line, tx, firstY + li * 3, { align: c.align === "right" ? "right" : "left" });
      });
      x += c.width;
    });
    return top + headH;
  };

  const lineGap = size * 0.3528 * 1.25;
  // Each cell's lines, and the height the row needs to hold the tallest of them.
  const layoutRow = (cells, bold) => {
    font(pdf, bold ? "bold" : "normal", size);
    const lines = cols.map((c, i) => {
      const raw = cells[i] === null || cells[i] === undefined || cells[i] === "" ? "-" : cells[i];
      if (!c.wrap) return [fit(pdf, raw, c.width - pad * 2)];
      const all = pdf.splitTextToSize(pdfSafe(raw), c.width - pad * 2);
      return all.length <= 3 ? all : [...all.slice(0, 2), fit(pdf, all.slice(2).join(" "), c.width - pad * 2)];
    });
    const most = Math.max(...lines.map((l) => l.length));
    return { lines, h: Math.max(rowH, rowH + (most - 1) * lineGap) };
  };

  const drawRow = (cells, top, { zebra, bold, totalRow }) => {
    const { lines, h } = layoutRow(cells, bold);
    if (totalRow) {
      fill(pdf, C.shade);
      pdf.rect(M, top, CONTENT_W, h, "F");
      stroke(pdf, C.ink);
      pdf.setLineWidth(0.5);
      pdf.line(M, top, M + CONTENT_W, top);
    } else if (zebra) {
      fill(pdf, C.zebra);
      pdf.rect(M, top, CONTENT_W, h, "F");
    }
    font(pdf, bold ? "bold" : "normal", size);
    let x = M;
    cols.forEach((c, i) => {
      ink(pdf, c.muted && !totalRow ? C.faint : C.ink);
      // Baseline at the optical middle of the row: half the row, plus a third of the cap
      // height, which is where Helvetica's x-height centres. A cell of several lines
      // centres the block the same way, so a one-line neighbour sits level with its middle.
      const baseY = top + h / 2 - ((lines[i].length - 1) * lineGap) / 2 + size * 0.3528 * 0.35;
      const tx = c.align === "right" ? x + c.width - pad : x + pad;
      lines[i].forEach((line, li) => {
        pdf.text(line, tx, baseY + li * lineGap, { align: c.align === "right" ? "right" : "left" });
      });
      x += c.width;
    });
    if (!totalRow) {
      stroke(pdf, C.rule);
      pdf.setLineWidth(0.2);
      pdf.line(M, top + h, M + CONTENT_W, top + h);
    }
    return top + h;
  };

  let cursor = drawHead(y);
  rows.forEach((cells, i) => {
    if (cursor + layoutRow(cells).h > BOTTOM) cursor = drawHead(onNewPage());
    cursor = drawRow(cells, cursor, { zebra: i % 2 === 1 });
  });
  if (total) {
    if (cursor + layoutRow(total, true).h > BOTTOM) cursor = drawHead(onNewPage());
    cursor = drawRow(total, cursor, { bold: true, totalRow: true });
  }
  return cursor;
};

const drawEmpty = (pdf, text, y) => {
  stroke(pdf, C.faint);
  pdf.setLineWidth(0.3);
  pdf.setLineDashPattern([1.2, 1.2], 0);
  pdf.roundedRect(M, y, CONTENT_W, 14, 2, 2, "S");
  pdf.setLineDashPattern([], 0);
  font(pdf, "normal", 9);
  ink(pdf, C.faint);
  pdf.text(text, PAGE_W / 2, y + 8.3, { align: "center" });
  return y + 14;
};

const drawFooters = (pdf, generated) => {
  const pages = pdf.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    pdf.setPage(p);
    stroke(pdf, C.faint);
    pdf.setLineWidth(0.2);
    pdf.setLineDashPattern([1, 1], 0);
    pdf.line(M, PAGE_H - 12, PAGE_W - M, PAGE_H - 12);
    pdf.setLineDashPattern([], 0);
    font(pdf, "normal", 7.5);
    ink(pdf, C.faint);
    pdf.text(`Generated ${pdfSafe(generated)}`, M, PAGE_H - 7.5);
    pdf.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 7.5, { align: "right" });
  }
};

// Widths add up to CONTENT_W (273). Each is set to hold its longest ordinary value whole --
// "ANN-261013-0012", "+971559158911", "Consultation Visit", "Consultation Booked",
// "13 Oct 2026" -- so only a genuinely long name or source is ever cut.
const LEAD_COLS = [
  { header: "#", width: 10, align: "right", muted: true, get: (l, n) => String(n) },
  { header: "Patient No.", width: 30, get: (l) => l.patientNumber },
  { header: "Patient Name", width: 42, get: (l) => l.name },
  { header: "Phone", width: 27, get: (l) => displayPhone(l.phone) },
  { header: "Source", width: 36, get: (l) => l.source },
  { header: "Reached", width: 28, get: (l) => l.reached },
  { header: "Current Stage", width: 33, get: (l) => l.stage },
  { header: "Services Bought", width: 44, get: (l) => l.services },
  { header: "Created", width: 23, get: (l) => l.date },
];

export const buildLeadsReportPdf = async (r) => {
  const [{ jsPDF }, logo] = await Promise.all([import("jspdf"), loadLogo()]);
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape", compress: true });
  pdf.setLineHeightFactor(1.15);
  const newPage = () => { pdf.addPage(); return drawStrip(pdf, r); };

  // Page one: the month at a glance -- it can be handed over by itself.
  let y = drawLetterhead(pdf, r, logo);
  sectionLabel(pdf, "Summary", y);
  y = drawTiles(pdf, r.summary, y + 3) + 10;

  sectionLabel(pdf, "Source-wise Breakdown", y);
  y += 3;
  const heads = r.summary.map((s) => s.label);
  // Each count column is as wide as its longest header word needs, so a two-word header
  // wraps between the words and never inside one; Source takes what is left.
  font(pdf, "bold", 6.8);
  const countWidths = heads.map((h) => Math.max(26, ...pdfSafe(h).toUpperCase().split(" ").map((w) => pdf.getTextWidth(w) + 6)));
  const sourceCols = [
    { header: "Source", width: CONTENT_W - countWidths.reduce((a, b) => a + b, 0) },
    ...heads.map((h, i) => ({ header: h, width: countWidths[i], align: "right" })),
  ];
  y = r.bySource.rows.length
    ? drawTable(pdf, {
      cols: sourceCols,
      rows: r.bySource.rows.map((row) => row.map(String)),
      total: ["Total", ...r.bySource.total.map(String)],
      y,
      rowH: 6.6,
      size: 8.5,
      onNewPage: () => { const t = newPage(); sectionLabel(pdf, "Source-wise Breakdown", t, "continued"); return t + 3; },
    })
    : drawEmpty(pdf, "No leads in this period.", y);

  // The lead list starts on a page of its own.
  y = newPage();
  sectionLabel(pdf, "Lead List", y, `${pdfSafe(r.showing)}  ·  ${r.leads.length}`);
  y += 3;
  if (!r.leads.length) {
    drawEmpty(pdf, "No leads in this selection.", y);
  } else {
    drawTable(pdf, {
      cols: LEAD_COLS,
      rows: r.leads.map((l, i) => LEAD_COLS.map((c) => c.get(l, i + 1))),
      y,
      rowH: 6.4,
      size: 7.6,
      onNewPage: () => { const t = newPage(); sectionLabel(pdf, "Lead List", t, "continued"); return t + 3; },
    });
  }

  drawFooters(pdf, r.generated);
  return pdf.output("blob");
};

export const downloadLeadsReportPdf = async (r, filename) => {
  try {
    savePdf(await buildLeadsReportPdf(r), filename);
  } catch {
    toast.error("Couldn't build the PDF");
  }
};

const COUNT_HEADS = (r) => r.summary.map((s) => s.label);

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
      cells: [i + 1, l.patientNumber || "", l.name || "", displayPhone(l.phone), l.email || "", l.source, l.reached,
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

// ---------------------------------------------------------------------------------------
// A plain list report: the same letterhead and table as above, with no summary page --
// one titled list of rows, as a board's own table is showing them. Branch Admin's
// Consultation tab downloads its stage this way.
//
// list = {
//   title, sheetTitle, sheetName, branch, generated,
//   meta:    [[label, value]] -- up to three lines under the title on page one
//   strip:   [text]           -- the line beside the title on every later page
//   listLabel, empty,
//   columns: [{ header, xlsx, align, money, wrap }] -- xlsx is the Excel column width;
//            money prints Rs. in the PDF and stays a number in Excel so the column sums;
//            wrap lets a long value take a second line in the PDF (see fitColumns)
//   rows:    [[value]]        -- in column order; null / "" reads as a dash
// }
// ---------------------------------------------------------------------------------------

const LIST_SIZE = 7.6;

/**
 * Widths from what is in each column rather than fixed shares, so nothing short is ever
 * cut: a patient number, a phone, a date, a time, a fee each gets the width of its longest
 * value. `wrap` columns -- names, plans, branches -- are the ones that give, sharing what the
 * page has left in proportion to what they would like, and wrapping onto a second line
 * where that is less than their longest value. Space to spare goes to them as well.
 */
const fitColumns = (pdf, columns, cells, size) => {
  const pad = 4.6;
  const words = (t) => pdfSafe(t).split(" ");
  const natural = [];
  const floor = [];
  columns.forEach((c, i) => {
    font(pdf, "bold", 6.8);
    // A header may wrap between words, never inside one: its longest word is a floor.
    const head = Math.max(...words(c.header.toUpperCase()).map((w) => pdf.getTextWidth(w)));
    font(pdf, "normal", size);
    let whole = pdf.getTextWidth("-");
    let word = 0;
    cells.forEach((row) => {
      whole = Math.max(whole, pdf.getTextWidth(pdfSafe(row[i])));
      if (c.wrap) word = Math.max(word, ...words(row[i]).map((w) => pdf.getTextWidth(w)));
    });
    natural.push(Math.max(head, whole) + pad);
    // A wrapping column breaks between words, so its own longest word is its floor too.
    floor.push(c.wrap ? Math.min(Math.max(head, word) + pad, natural[i]) : natural[i]);
  });

  const widths = [...floor];
  let room = CONTENT_W - widths.reduce((n, w) => n + w, 0);
  if (room < 0) {
    // More than the page holds even at the floors: everything gives, in proportion.
    const total = widths.reduce((n, w) => n + w, 0);
    return columns.map((c, i) => ({ header: c.header, width: (widths[i] * CONTENT_W) / total, align: c.align, muted: c.muted, wrap: c.wrap }));
  }
  // What is left goes to the wrapping columns still short of their longest value, an equal
  // share each, so one long Plan cannot take the page while the Stage beside it wraps.
  for (let pass = 0; pass < 20 && room > 0.01; pass += 1) {
    const short = columns.map((c, i) => i).filter((i) => columns[i].wrap && widths[i] < natural[i] - 0.01);
    if (!short.length) break;
    const share = room / short.length;
    short.forEach((i) => {
      const add = Math.min(share, natural[i] - widths[i]);
      widths[i] += add;
      room -= add;
    });
  }
  // Everything whole and page to spare: it goes to the wrapping columns, or across all.
  if (room > 0.01) {
    const takers = columns.map((c, i) => i).filter((i) => columns[i].wrap);
    const pool = takers.length ? takers : columns.map((c, i) => i);
    const base = pool.reduce((n, i) => n + widths[i], 0);
    pool.forEach((i) => { widths[i] += (room * widths[i]) / base; });
  }
  return columns.map((c, i) => ({ header: c.header, width: widths[i], align: c.align, muted: c.muted, wrap: c.wrap }));
};

const moneyText = (v) => (typeof v === "number" && Number.isFinite(v) ? `Rs.${Math.round(v).toLocaleString("en-IN")}` : v);

export const buildListReportPdf = async (list) => {
  const [{ jsPDF }, logo] = await Promise.all([import("jspdf"), loadLogo()]);
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape", compress: true });
  pdf.setLineHeightFactor(1.15);
  const newPage = () => { pdf.addPage(); return drawStrip(pdf, list); };

  const cells = list.rows.map((row) => row.map((v, i) => {
    const shown = list.columns[i].money ? moneyText(v) : v;
    return shown === null || shown === undefined ? "" : String(shown);
  }));
  const cols = fitColumns(pdf, list.columns, cells, LIST_SIZE);

  let y = drawLetterhead(pdf, list, logo);
  sectionLabel(pdf, list.listLabel, y, String(list.rows.length));
  y += 3;
  if (!list.rows.length) {
    drawEmpty(pdf, list.empty || "Nothing in this selection.", y);
  } else {
    drawTable(pdf, {
      cols,
      rows: cells,
      y,
      rowH: 6.4,
      size: LIST_SIZE,
      onNewPage: () => { const t = newPage(); sectionLabel(pdf, list.listLabel, t, "continued"); return t + 3; },
    });
  }

  drawFooters(pdf, list.generated);
  return pdf.output("blob");
};

export const downloadListReportPdf = async (list, filename) => {
  try {
    savePdf(await buildListReportPdf(list), filename);
  } catch {
    toast.error("Couldn't build the PDF");
  }
};

// One sheet: the title and its lines, then the list with its header frozen and filterable.
const listSheet = (list) => {
  const heads = list.columns.map((c) => c.header);
  const last = xlsxColName(heads.length - 1);
  const top = [
    { cells: [{ v: list.sheetTitle || list.title, s: "title" }], height: 24 },
    { cells: [{ v: [`Branch: ${list.branch || "—"}`, ...list.meta.map(([k, v]) => `${k}: ${v}`)].join("   ·   "), s: "subtitle" }] },
    { cells: [{ v: `Generated: ${list.generated}`, s: "subtitle" }] },
  ];
  const headRow = top.length + 1;
  const rows = [
    ...top,
    { cells: heads, style: "header", height: 20 },
    ...list.rows.map((row) => ({
      cells: row.map((v) => (v === null || v === undefined || v === "" ? "" : v)),
      style: "cell",
    })),
  ];
  return {
    name: list.sheetName || "List",
    rows,
    cols: list.columns.map((c) => c.xlsx || 16),
    freezeRows: headRow,
    merges: [`A1:${last}1`],
    autoFilter: `A${headRow}:${last}${headRow + Math.max(list.rows.length, 1)}`,
  };
};

export const downloadListReportXlsx = (list, filename) => downloadXlsx([listSheet(list)], filename);

/**
 * Several lists, one sheet each, in one workbook -- Branch Admin's every-stage download.
 * Each entry is a list as above; sheetName is its tab. Excel refuses a workbook with two
 * tabs of the same name (case ignored) or a name past 31 characters, so a clash gets a
 * number rather than a corrupt file.
 */
export const downloadListWorkbookXlsx = (lists, filename) => {
  const used = new Set();
  const sheets = lists.map((list, i) => {
    const base = (String(list.sheetName || `Sheet ${i + 1}`).replace(/[[\]:*?/\\]/g, " ").trim() || `Sheet ${i + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return listSheet({ ...list, sheetName: name });
  });
  downloadXlsx(sheets, filename);
};
