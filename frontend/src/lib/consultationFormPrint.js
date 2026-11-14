// The filled Offline Consultation Form as paper: three A4 sheets laid out like the printed
// form -- its header, its dotted lines, the writing on them -- built as one standalone HTML
// document. Print opens it in its own window (window.print() on the app would send the
// whole board); Download draws the same sheets into a PDF, one sheet a page, so the file
// and the paper cannot disagree.
//
// jsPDF and html2canvas are imported on first use, as lib/pdf.js does.
import { toast } from "@/components/ui/sonner";
import { escapeHtml } from "@/lib/printable";
import { PAPER_BRANCHES, showDate } from "@/components/branch/ConsultationFormSheets";

const BLUE = "#3b7bbf";
const STEP = 30; // px between the ruled lines
const SHEET_W = 794; // A4 at 96dpi
const SHEET_H = 1123;

const STYLES = `
  *{box-sizing:border-box}
  body{margin:0;background:#e2e8f0;font-family:Arial,Helvetica,sans-serif;color:#1e293b;
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{position:relative;width:${SHEET_W}px;min-height:${SHEET_H}px;margin:24px auto;padding:52px 64px 60px;
         background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.15);overflow:hidden}
  .wm{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:rgba(15,23,42,.05);
      pointer-events:none;line-height:1}
  .wm b{display:block;font-family:Georgia,'Times New Roman',serif;font-size:96px;letter-spacing:4px}
  .wm span{display:block;font-size:34px;margin-top:10px}
  .content{position:relative}
  .pno{position:absolute;right:40px;bottom:26px;color:${BLUE};font-weight:700;font-size:15px}
  .head{display:flex;align-items:center;gap:26px}
  .mark{flex:none;text-align:center;width:150px}
  .mark img{width:84px;height:84px;object-fit:contain;display:block;margin:0 auto}
  .mark b{display:block;font-family:Georgia,'Times New Roman',serif;font-size:15px;letter-spacing:.5px;color:#1e293b}
  .mark span{display:block;font-size:9px;color:#475569}
  .brand{flex:1;text-align:center}
  .brand .t{font-size:60px;font-weight:900;color:${BLUE};letter-spacing:1px;line-height:1}
  .brand .s{font-size:19px;font-weight:700;margin-top:10px;color:#334155}
  .brand .p{font-size:19px;font-weight:700;margin-top:2px}
  .rule-blue{height:2px;background:${BLUE};margin:16px 0 18px}
  .title{text-align:center}
  .title span{display:inline-block;font-size:25px;font-weight:800;color:${BLUE};letter-spacing:1px;border-bottom:2.5px solid ${BLUE};padding-bottom:2px}
  .sec{color:${BLUE};font-weight:700;font-size:17px;margin:18px 0 4px}
  .lbl{font-size:15px;color:#334155;white-space:nowrap}
  .val{color:#0f2a6b;font-size:15px}
  .one{display:flex;align-items:flex-end;gap:6px;margin-top:8px}
  .one>.lbl{line-height:22px;padding-bottom:1.6px}
  .one .val{flex:1;min-width:0;border-bottom:1.6px dotted #475569;min-height:24px;line-height:22px;padding:0 4px;word-break:break-word}
  .row{display:flex;gap:14px}
  .row .one{flex:1}
  .branches{display:flex;align-items:center;gap:28px;margin:16px 0 6px;font-size:15px;color:#334155}
  .branches i{display:inline-block;width:24px;height:24px;border:1.8px solid #475569;vertical-align:middle;margin-right:10px;
              text-align:center;line-height:21px;font-style:normal;font-weight:700;color:#fff}
  .branches i.on{background:${BLUE};border-color:${BLUE}}
  .ml{margin-top:8px}
  .ml>.lbl{display:block;line-height:${STEP}px}
  .box{position:relative}
  .txt{position:relative;z-index:1;line-height:${STEP}px;white-space:pre-wrap;word-break:break-word;padding:0 4px}
  .txt .lbl{padding-right:6px}
  .ln{position:absolute;left:0;right:0;border-top:1.6px dotted #475569}
  .sign{text-align:center;margin:56px auto 0;width:440px}
  .sign .lbl{display:block;color:${BLUE};font-weight:700;font-size:19px}
  .sign .val{display:block;border-bottom:1.6px dotted #475569;min-height:30px;line-height:30px;margin-top:6px}
  /* The PDF only: html2canvas sets text lower in a tall line box than a browser does --
     about half the line's extra leading -- which ran the dotted rules through the words.
     Lifted back by that much, so the file matches the printed sheet. */
  .pdf .txt,.pdf .sign .t{position:relative;top:-7px}
  .pdf .one .t,.pdf .one>.lbl{position:relative;top:-3px}
  .pdf .branches i{line-height:15px}
  @page{size:A4;margin:0}
  @media print{
    body{background:#fff}
    .sheet{margin:0;box-shadow:none;page-break-after:always;break-after:page}
    .sheet:last-child{page-break-after:auto;break-after:auto}
  }
`;

const v = (s) => `<span class="val"><span class="t">${escapeHtml(s)}</span></span>`;
const one = (label, value) => `<div class="one"><span class="lbl">${escapeHtml(label)}</span>${v(value)}</div>`;
// Ruled lines; the rules themselves are drawn by layoutRules once the text has a height.
const lines = (label, value, rows, inline = true) => (inline
  ? `<div class="ml"><div class="box" data-rows="${rows}"><div class="txt"><span class="lbl">${escapeHtml(label)}</span>${v(value)}</div></div></div>`
  : `<div class="ml"><span class="lbl">${escapeHtml(label)}</span><div class="box" data-rows="${rows}"><div class="txt">${v(value)}</div></div></div>`);

const sheet = (n, body) => `
  <div class="sheet">
    <div class="wm"><b>FITSIO_MAX</b><span>Physio Care &amp; Fitness Centre</span></div>
    <div class="content">${body}</div>
    <div class="pno">${n}</div>
  </div>`;

export const consultationFormHtml = (f) => {
  const logo = `${window.location.origin}/logo-icon-192.png`;
  const page1 = `
    <div class="head">
      <div class="mark"><img src="${logo}" alt="" /><b>FITSIO_MAX</b><span>Physio Care &amp; Fitness Centre</span></div>
      <div class="brand"><div class="t">FITSIO_MAX</div><div class="s">Pain Management | Athletic Rehab | Fitness</div><div class="p">+91 75388 36030</div></div>
    </div>
    <div class="rule-blue"></div>
    <div class="title"><span>OFFLINE CONSULTATION FORM</span></div>
    <div class="sec">Patient Details:</div>
    ${one("Name:", f.name)}
    <div class="row">${one("Age:", f.age)}${one("Sex:", f.sex)}<div class="one" style="flex:2.4"><span class="lbl">Contact no:</span>${v(f.contact_no)}</div></div>
    ${one("Mail Id:", f.mail_id)}
    ${one("Source of Reference:", f.source_of_reference)}
    ${one("Nature of Job:", f.nature_of_job)}
    <div class="branches"><span>Branches :</span>${PAPER_BRANCHES.map((b) => `<span><i class="${f.branch === b ? "on" : ""}">${f.branch === b ? "&#10003;" : ""}</i>${escapeHtml(b)}</span>`).join("")}</div>
    <div class="row">${one("Date:", f.date ? showDate(f.date) : "")}<div class="one" style="flex:2"><span class="lbl">Place:</span>${v(f.place)}</div></div>
    <div style="height:14px"></div>
    ${lines("Past Medical History:", f.past_medical_history, 2, false)}
    ${lines("Any Medication:", f.any_medication, 2, false)}
    ${lines("Symptoms / Root Cause :", f.symptoms_root_cause, 2, false)}
    ${lines("Primary Muscles:", f.primary_muscles, 2, false)}
    ${lines("Secondary Muscles:", f.secondary_muscles, 2, false)}`;
  const page2 = `
    <div class="sec" style="margin-top:0">Previous Consultations</div>
    ${lines("Previous Medical Consultations:", f.previous_medical_consultations, 5)}
    ${lines("Previous Diagnosis:", f.previous_diagnosis, 3)}
    ${lines("Previous Physiotherapy:", f.previous_physiotherapy, 5)}
    <div style="height:34px"></div>
    <div class="sec">Diagnosis &amp; Treatment Plan</div>
    ${lines("Fitsiomax Diagnosis:", f.fitsiomax_diagnosis, 5)}
    ${lines("Treatment Goals:", f.treatment_goals, 10)}`;
  const page3 = `
    ${lines("Treatment Protocol:", f.treatment_protocol, 10)}
    ${lines("No of Sessions / Weeks Required:", f.sessions_weeks_required, 2)}
    ${lines("No of Sessions / Weeks (Online /Offline):", f.sessions_weeks_online_offline, 2)}
    ${lines("Short Term Goal :", f.short_term_goal, 2)}
    ${lines("Long Term Goal:", f.long_term_goal, 2)}
    ${lines("Do's & Don'ts:", f.dos_and_donts, 4)}
    ${lines("Special Instructions to the Therapist:", f.special_instructions, 5, false)}
    <div class="sign"><span class="lbl">Therapist Name &amp; Sign:</span>${v(f.therapist_name)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Consultation Form${f.name ? ` - ${escapeHtml(f.name)}` : ""}</title>
    <style>${STYLES}</style></head><body>${sheet(1, page1)}${sheet(2, page2)}${sheet(3, page3)}</body></html>`;
};

/** Draws each box's dotted lines: as many as the paper has, or as many as the writing needs. */
const layoutRules = (doc) => {
  doc.querySelectorAll(".box").forEach((box) => {
    const txt = box.querySelector(".txt");
    const n = Math.max(Number(box.dataset.rows) || 1, Math.round(txt.offsetHeight / STEP));
    box.style.height = `${n * STEP}px`;
    box.querySelectorAll(".ln").forEach((el) => el.remove());
    for (let i = 0; i < n; i += 1) {
      const ln = doc.createElement("div");
      ln.className = "ln";
      ln.style.top = `${i * STEP + STEP - 5}px`;
      box.appendChild(ln);
    }
  });
};

const waitLoad = (win, doc) => new Promise((resolve) => {
  if (doc.readyState === "complete") { resolve(); return; }
  win.addEventListener("load", resolve, { once: true });
  setTimeout(resolve, 3000);
});

export const formFileName = (f) => `Consultation-Form-${(f.name || "Patient").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Patient"}.pdf`;

/** Opened before any await, so the pop-up blocker still counts it as the click. */
export const claimPrintWindow = () => {
  const w = window.open("", "_blank", "width=900,height=900");
  if (!w) toast.error("Allow pop-ups to print the form");
  return w;
};

export const printConsultationForm = (f, win = null) => {
  const w = win || claimPrintWindow();
  if (!w || w.closed) return;
  w.document.write(consultationFormHtml(f));
  w.document.close();
  layoutRules(w.document);
  w.focus();
  waitLoad(w, w.document).then(() => {
    layoutRules(w.document);
    try { w.print(); } catch { /* closed before printing */ }
  });
};

export const consultationFormPdf = async (f) => {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${SHEET_W + 60}px;height:${SHEET_H}px;border:0`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write(consultationFormHtml(f));
    doc.close();
    await waitLoad(frame.contentWindow, doc);
    layoutRules(doc);
    doc.body.classList.add("pdf");
    const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const sheets = [...doc.querySelectorAll(".sheet")];
    for (let i = 0; i < sheets.length; i += 1) {
      sheets[i].style.boxShadow = "none";
      sheets[i].style.margin = "0";
      // eslint-disable-next-line no-await-in-loop
      const canvas = await html2canvas(sheets[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false, windowWidth: SHEET_W + 60 });
      let w = 210;
      let h = (canvas.height * 210) / canvas.width;
      // A sheet the writing ran long on is shrunk onto its one page rather than cut.
      if (h > 297) { w = (w * 297) / h; h = 297; }
      if (i > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", (210 - w) / 2, 0, w, h, undefined, "FAST");
    }
    return pdf.output("blob");
  } finally {
    frame.remove();
  }
};

export const downloadConsultationForm = async (f) => {
  try {
    const blob = await consultationFormPdf(f);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = formFileName(f);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast.error("Couldn't build the PDF");
  }
};
