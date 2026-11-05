/**
 * The WhatsApp welcome for a booking at the branch, as the branch worded it in Settings >
 * Appointment Msg Editor (backend: v3_branch_admin's APPT_MSG_*). Pre Sales fills it as the
 * message is typed into the lead's chat; the editor fills it with a sample for its preview.
 */

import { preBookWhen } from "@/lib/preBook";

/** The {placeholders} a template may use, in the order the editor offers them. */
export const APPT_MSG_PLACEHOLDERS = [
  { key: "name", label: "Patient name", sample: "Bala" },
  { key: "date_time", label: "Date & time", sample: "04 Nov 2026 · 10:00 AM" },
  { key: "branch", label: "Branch", sample: "Anna Nagar Branch" },
  { key: "reference", label: "Reference", sample: "APT-103-0008-105136" },
  { key: "pdf_link", label: "PDF link", sample: "https://os.fitsiomax.clinic/api/v3/public/appointment/…/pdf" },
  { key: "location_link", label: "Location link", sample: "https://maps.app.goo.gl/…" },
];

export const APPT_MSG_SAMPLE = Object.fromEntries(APPT_MSG_PLACEHOLDERS.map((p) => [p.key, p.sample]));

const TOKEN = /\{([a-z_]+)\}/g;

/**
 * The template with its placeholders filled. A line whose placeholders all come out empty
 * -- no PDF, no reference -- is left out. When that line was the placeholder alone (a link
 * on its own line), the "…:" line introducing it goes too, so the patient never reads a
 * label pointing at nothing. Unknown placeholders stay as typed.
 */
export const fillAppointmentMessage = (template, values) => {
  const known = (k) => APPT_MSG_PLACEHOLDERS.some((p) => p.key === k);
  const out = [];
  for (const line of String(template || "").replace(/\r\n/g, "\n").split("\n")) {
    const keys = [...line.matchAll(TOKEN)].map((m) => m[1]).filter(known);
    if (keys.length && keys.every((k) => !String(values[k] || "").trim())) {
      const bare = !line.replace(TOKEN, "").trim();
      if (bare && out.length && /:\s*$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(line.replace(TOKEN, (m, k) => (known(k) ? String(values[k] || "") : m)));
  }
  // Two blank lines where a dropped block sat between two kept ones read as one.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * The WhatsApp welcome for one booking: the branch's own wording when the booking is at the
 * branch, else the standard lines (a home visit or a Google Meet — "at {branch}" and the
 * branch's map are wrong for both). Shared by Pre Sales' Contact WhatsApp and the
 * Appointment Confirmed popup's WhatsApp, so the patient gets one message whichever was
 * tapped.
 */
export const apptWelcomeText = (card, { name, pdfUrl = "", mapUrl = "", branchName = "" } = {}) => {
  const who = name || card?.patient || "there";
  const when = preBookWhen({ date: card?.date, time: card?.time });
  if (card?.messageTemplate && !card.meetLink && !card.houseVisit) {
    return fillAppointmentMessage(card.messageTemplate, {
      name: who,
      date_time: when,
      branch: card.branch || branchName,
      reference: card.refNo && card.refNo !== "—" ? card.refNo : "",
      pdf_link: pdfUrl,
      location_link: mapUrl,
    });
  }
  const lines = [`Hi ${who}, Welcome to Fitsiomax Clinic !`];
  if (card) {
    lines.push("", `Your appointment is confirmed${when ? ` for ${when}` : ""}${card.branch && !card.meetLink && !card.houseVisit ? ` at ${card.branch}` : ""}.`);
    if (card.houseVisit) lines.push("Our consultant will come to your home at this time.");
    if (card.meetLink) lines.push(`Google Meet: ${card.meetLink}`);
    if (pdfUrl) lines.push("", "Your appointment confirmation (PDF):", pdfUrl);
  }
  if (mapUrl) lines.push("", `${branchName || card?.branch || "Our branch"} location:`, mapUrl);
  return lines.join("\n");
};
