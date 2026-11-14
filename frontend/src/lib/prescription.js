// The supplied letterhead is the artwork, not an approximation made from HTML.
// Draw at its original PDF coordinates, preserving room for a handwritten signature.
const W = 595.2;
const H = 841.92;
const BLUE = "#194579";
const clean = (value) => String(value ?? "").trim();

export const prescriptionData = (lead, branch) => {
  const plan = [];
  if (lead.consultation_decision === "consultation_only") plan.push("Consultation only");
  if (lead.consultation_decision === "consultation_treatment") {
    plan.push(`Treatment: ${lead.session_package_name || "Package not selected"}${lead.session_package_sessions ? ` — ${lead.session_package_sessions} sessions` : ""}`);
  }
  if (lead.diet_recommended) {
    plan.push(`Diet: ${[lead.diet_consultation && "Consultation", lead.diet_chart && "Diet chart"].filter(Boolean).join(" + ") || "Referred"}`);
  }
  if (lead.rehab_referred) plan.push(`Rehab: ${lead.rehab_package_name || "Referred"}${lead.rehab_package_sessions ? ` — ${lead.rehab_package_sessions} sessions` : ""}`);
  if (lead.rehab_after_treatment && !lead.rehab_consulted_at) plan.push("Rehab after treatment: Consultant to select package");
  if (lead.fitness_recommended) plan.push("Fitness: Referred");
  if (lead.zumba_recommended) plan.push(`Zumba: ${lead.zumba_package_name || "Referred"}`);
  const date = clean(lead.appointment_date).slice(0, 10);
  return {
    name: clean(lead.name), number: clean(lead.patient_number), phone: clean(lead.phone),
    age: lead.age == null ? "" : String(lead.age), gender: clean(lead.gender),
    address: clean(branch?.address),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join("/") : "",
    consultant: clean(lead.assigned_physio_name),
    // Never substitute the pre-sales diagnosis for the consultant's report.
    diagnosis: clean(lead.physio_diagnosis_report), summary: clean(lead.treatment_summary),
    plan: plan.join("\n"),
  };
};

export const prescriptionMissing = (data) => {
  if (!data.diagnosis) return "The consultant has not saved a Diagnosis Report yet.";
  if (!data.address) return "The patient’s branch address is unavailable. Add it in branch settings or reload.";
  if (!data.date) return "The consultation date is missing.";
  if (!data.consultant) return "The attending consultant’s name is missing.";
  return "";
};

// Preserve paragraphs; split even a single long word without clipping any characters.
export const wrapPrescriptionText = (ctx, text, width) => String(text).split(/\r?\n/).flatMap((paragraph) => {
  const lines = [];
  let line = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = ""; }
    if (ctx.measureText(word).width > width) {
      for (const char of Array.from(word)) {
        if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ""; }
        line += char;
      }
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines;
});

const loadArtwork = () => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("Could not load the prescription letterhead. Please retry."));
  img.src = `${process.env.PUBLIC_URL || ""}/prescription/letterhead.png`;
});

export const buildPrescription = async (data) => {
  const missing = prescriptionMissing(data);
  if (missing) throw new Error(missing);
  const [{ jsPDF }, artwork] = await Promise.all([import("jspdf"), loadArtwork()]);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(W * 2.5);
  canvas.height = Math.ceil(H * 2.5);
  const ctx = canvas.getContext("2d");
  ctx.scale(canvas.width / W, canvas.height / H);
  const font = (size = 11, bold = false) => { ctx.font = `${bold ? "bold " : ""}${size}px Arial, sans-serif`; };
  const fitted = (text, x, y, width, maxLines, size, bold = false) => {
    let lines;
    do { font(size, bold); lines = wrapPrescriptionText(ctx, text, width); if (lines.length <= maxLines) break; size -= 0.5; } while (size >= 6);
    if (lines.length > maxLines) throw new Error("The branch address or consultant name is too long for the letterhead.");
    lines.forEach((line, i) => ctx.fillText(line, x, y + i * (size + 1.5)));
  };
  const pages = [];
  let y;
  const beginPage = () => {
    ctx.drawImage(artwork, 0, 0, W, H);
    ctx.fillStyle = BLUE;
    fitted(data.address, 354.5, 70, 215, 4, 10);
    font(12, true); ctx.fillText(data.date, 454, 174);
    fitted(data.consultant, 394, 713, 167, 2, 12, true);
    y = 207;
    font(11, true);
    const patient = `Patient: ${data.name}${data.number ? `   |   ID: ${data.number}` : ""}`;
    wrapPrescriptionText(ctx, patient, 547).forEach((line) => { ctx.fillText(line, 24, y); y += 15; });
    font(10);
    const details = [data.age && `Age: ${data.age}`, data.gender && `Gender: ${data.gender}`, data.phone && `Phone: ${data.phone}`].filter(Boolean).join("   |   ");
    wrapPrescriptionText(ctx, details, 547).forEach((line) => { ctx.fillText(line, 24, y); y += 14; });
    y += 14;
  };
  const endPage = () => { pages.push(canvas.toDataURL("image/png")); };
  beginPage();
  for (const [title, text] of [["Diagnosis Report", data.diagnosis], ["Treatment Summary", data.summary], ["Treatment Plan", data.plan]]) {
    if (!text) continue;
    if (y + 34 > 595) { endPage(); beginPage(); }
    font(11, true); ctx.fillStyle = BLUE; ctx.fillText(title, 24, y); y += 18;
    font(11); const lines = wrapPrescriptionText(ctx, text, 547);
    for (const line of lines) {
      if (y > 595) {
        endPage(); beginPage();
        font(11, true); ctx.fillStyle = BLUE; ctx.fillText(`${title} (continued)`, 24, y); y += 18;
      }
      font(11); ctx.fillStyle = "#172333"; ctx.fillText(line, 24, y); y += 15;
    }
    y += 13;
  }
  endPage();
  const pdf = new jsPDF({ unit: "pt", format: [W, H], compress: true });
  pages.forEach((page, i) => {
    if (i) pdf.addPage([W, H]);
    pdf.addImage(page, "PNG", 0, 0, W, H, undefined, "FAST");
  });
  return { blob: pdf.output("blob"), pages };
};

// Print exactly the generated page artwork; no application UI or browser PDF-plugin dependency.
export const printPrescription = (tab, pages) => {
  tab.document.write(`<!doctype html><html><head><title>Prescription</title><style>@page{size:A4 portrait;margin:0}body{margin:0}img{display:block;width:210mm;height:297mm;break-after:page}img:last-child{break-after:auto}</style></head><body>${pages.map((page) => `<img alt="Prescription page" src="${page}">`).join("")}</body></html>`);
  tab.document.close();
  Promise.all(Array.from(tab.document.images).map((img) => img.decode())).then(() => { tab.focus(); tab.print(); }).catch(() => {});
};
