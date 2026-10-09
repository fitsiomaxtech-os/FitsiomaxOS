// The appointment confirmation — the sheet the patient is given, and the four ways it
// leaves the room. Opening it as a printable, sharing it, WhatsApping it and saving it all
// render the exact same document.
//
// Lifted out of BranchAdminBoard, which is where it was written and for a while the only
// screen that could raise it: it appeared once, on the booking, and was gone the moment it
// was dismissed. A patient who lost the message had nothing to be sent again. It is a
// component now so the Consultations board can hand the same card back off the record,
// which is the whole point — the second copy has to be the first copy, not a redrawing of
// it that differs in some detail the patient then queries.
//
// WhatsApp, Share and Download send the printed sheet as a PDF (lib/pdf.js). They used to
// send a PNG card and a typed message; the branches asked for one file type, PDF, only.
import { CheckCircle2, Download, Printer, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { downloadPdf, sharePdf, usePdf, whatsappPdf } from "@/lib/pdf";
import { PRINTABLE_STYLES, docHeadHtml, escapeHtml, rowsHtml, openPrintable } from "@/lib/printable";
import { to12h } from "@/lib/time";

/** "2026-08-05" -> "05 - 08 - 2026" */
const dmyLabel = (d) => {
  const [y, m, day] = String(d || "").split("-");
  return y && m && day ? `${day} - ${m} - ${y}` : d || "—";
};
/** "2026-08-05" -> "Wednesday, 5 August" */
const weekdayLabel = (d) => (d
  ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
  : "—");
/** "2026-08-19" -> "Wednesday 19-08-2026". The popup hero only; the printed sheet and the
 *  card keep the spelled-out month, which reads better on paper and cannot be mistaken for
 *  month-first by a patient reading it. */
const weekdayDmy = (d) => {
  const [y, m, day] = String(d || "").split("-");
  if (!y || !m || !day) return d || "—";
  const weekday = new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday} ${day}-${m}-${y}`;
};

const packageLabel = (a) => (a.packagePrice != null ? `${a.packageName} · ₹${a.packagePrice}` : a.packageName);

// `compact` drops the date and time the confirmation's own hero already states in bigger
// type — the on-screen popup shows that hero, so repeating them underneath is noise. The
// full list keeps them, where the rows have to stand on their own as the record.
export const apptRows = (a, { compact = false } = {}) => [
  ["Reference No.", a.refNo],
  ["Patient", a.patient],
  ["Patient No.", a.patientNo],
  ["Phone", a.phone],
  compact ? null : ["Date", dmyLabel(a.date)],
  // Start only, and no length or Consultant beside it — see apptHtml. The time a patient
  // is told to come is the whole of what is promised.
  compact ? null : ["Time", to12h(a.time)],
  a.branch ? ["Branch", a.branch] : null,
  // A house visit is not at the branch, so the slip says so, and names the package the
  // patient agreed to pay for it.
  a.houseVisit ? ["Visit", "House Visit"] : null,
  a.houseVisit && a.packageName ? ["Package", packageLabel(a)] : null,
  // Where an online appointment actually happens, so the sheet the patient keeps carries
  // it as plainly as a branch name. Kept in the compact popup too, unlike Date and Time
  // above: those are dropped because the card overhead already shouts them, and this one
  // appears nowhere else on that screen.
  a.meetLink ? ["Google Meet", a.meetLink] : null,
  ["Booked By", a.bookedBy],
];

// The printed sheet: a calendar tile and the when/where up top, the patient's details and
// the booking beneath, then the standing instructions.
//
// The hero states the start time alone, for the same reason the popup's does: a
// consultation runs as long as it needs to, so a printed end time or a length beside it
// promises the patient something the branch cannot hold to. The Consultant is off it too —
// who takes the session can change between the booking and the day, and the sheet is the
// copy the patient keeps.
export const apptHtml = (a) => {
  const [y, m, d] = String(a.date || "").split("-");
  const day = y && m && d ? new Date(`${a.date}T00:00:00`) : null;
  const meet = (a.meetLink || "").trim();
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Appointment ${escapeHtml(a.refNo)}</title><style>${PRINTABLE_STYLES}</style></head>
<body><div class="doc tone-appt">
  ${docHeadHtml({
    title: "Appointment",
    meta: [["Reference No.", a.refNo]],
    status: "CONFIRMED",
    branch: a.branch,
  })}
  <div class="body">
    <div class="hero">
      ${day ? `<div class="tile">
        <div class="m">${escapeHtml(day.toLocaleDateString("en-US", { month: "short" }).toUpperCase())} ${escapeHtml(y)}</div>
        <div class="d">${escapeHtml(String(Number(d)))}</div>
        <div class="w">${escapeHtml(day.toLocaleDateString("en-US", { weekday: "long" }))}</div>
      </div>` : ""}
      <div style="min-width:0">
        <p class="label">Your Appointment</p>
        <div class="when">${escapeHtml(weekdayLabel(a.date))}</div>
        <div class="time">${escapeHtml(to12h(a.time))}</div>
        ${meet
          ? `<div class="facts"><span>Google Meet <b>${escapeHtml(meet)}</b></span></div>`
          : a.houseVisit ? `<div class="facts"><span><b>House Visit</b> — at your home</span></div>`
          : a.branch ? `<div class="facts"><span>At <b>${escapeHtml(a.branch)}</b></span></div>` : ""}
      </div>
    </div>

    <div class="grid2" style="margin-top:20px">
      <div class="panel">
        <p class="label">Patient</p>
        <div class="name">${escapeHtml(a.patient)}</div>
        ${rowsHtml([["Patient No.", a.patientNo], ["Phone", a.phone]])}
      </div>
      <div class="panel">
        <p class="label">Booking</p>
        ${rowsHtml([
          ["Date", dmyLabel(a.date)],
          a.branch ? ["Branch", a.branch] : null,
          meet ? ["Google Meet", meet] : null,
          a.houseVisit ? ["Visit", "House Visit"] : null,
          a.houseVisit && a.packageName ? ["Package", packageLabel(a)] : null,
          !meet && !a.houseVisit && a.branchAddress ? ["Location", a.branchAddress] : null,
          ["Booked By", a.bookedBy],
        ])}
      </div>
    </div>

    ${a.notes ? `<div class="note"><p class="label">Notes</p>${escapeHtml(a.notes)}</div>` : ""}
    <div class="note">
      <p class="label">Before you come</p>
      <ul class="steps">
        <li>${meet ? "Please join the meeting 5 minutes early." : a.houseVisit ? "Our consultant will come to your home at this time." : "Please arrive 10 minutes early."}</li>
        <li>To reschedule or cancel, contact the branch quoting reference <b>${escapeHtml(a.refNo)}</b>.</li>
      </ul>
    </div>
  </div>
  <div class="foot">
    <div>This is a computer-generated confirmation and needs no signature.</div>
    <div class="thanks">Thank you for choosing FITSIOMAX</div>
  </div>
</div></body></html>`;
};

/**
 * The confirmation on screen.
 *
 * `appt` is the object the booking builds and the reissue endpoint returns; nothing is
 * drawn while it is null, so a caller can hold the state and mount this unconditionally.
 * `onClose` runs on both the X and the backdrop-free header button — the booking flow uses
 * it to release the card and then move the lead on, a reissue only to dismiss it.
 */
export function AppointmentConfirmCard({ appt, onClose, testid = "branch-appt-confirm" }) {
  // WhatsApp, Share and Download all send this one PDF — the printed sheet, as a file.
  const pdf = usePdf(appt ? apptHtml(appt) : null);
  if (!appt) return null;
  const pdfName = `appointment-${appt.refNo || "confirmation"}.pdf`;
  const pdfTitle = `FITSIOMAX Appointment ${appt.refNo || ""}`.trim();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" data-testid={`${testid}-modal`}>
      {/* 90%, this dialog only. zoom rather than transform: scale — zoom shrinks the
          layout box itself, so the flex centring above and the max-h below still work
          on the size actually drawn. scale would leave the box at full size, centring
          the card off its own bounds and reserving space nothing occupies. */}
      <div
        className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        style={{ zoom: 0.9 }}
      >
        {/* The receipt popup's header. items-center so the two-line title does not
            leave a band of empty teal beneath it, a status mark rather than the logo
            (which already opens the body), and a plain close — the orange-bordered X
            read as a warning on a dialog that only confirms. */}
        <div className="flex shrink-0 items-center justify-between gap-3 bg-teal-600 px-4 py-3 text-white">
          <div className="flex min-w-0 items-center gap-2.5">
            <CheckCircle2 className="h-7 w-7 shrink-0" />
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight">Appointment Confirmed</p>
              <p className="truncate text-xs text-white/80">Ref {appt.refNo}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-white/80 hover:bg-white/20"
            aria-label="Close"
            data-testid={`${testid}-close`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-xl border-2 border-teal-200 bg-teal-50 px-4 py-5 text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-teal-600">Your Appointment</p>
            {/* Day and time on one line — they are read as one fact. Start only: a
                consultation runs as long as it needs to, so printing an end time
                promised something the branch cannot hold to. Wrapping is left on so a
                narrow phone drops the time to its own line rather than shrinking it.
                No Consultant under it, as on the printed sheet: who takes the session
                can change between the booking and the day. */}
            <p className="mt-1 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-0.5 text-xl font-extrabold text-teal-700 sm:text-2xl">
              <span>{weekdayDmy(appt.date)}</span>
              <span className="text-lg sm:text-xl">{to12h(appt.time)}</span>
            </p>
          </div>

          <dl className="mt-5 space-y-2 text-sm">
            {apptRows(appt, { compact: true }).filter(Boolean).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2">
                <dt className="shrink-0 text-slate-500">{k}</dt>
                {/* break-words and min-w-0 for the meeting link, which is one
                    unbroken token long enough to push the row off its own card. */}
                <dd className="min-w-0 break-words text-right font-semibold text-slate-700">{v}</dd>
              </div>
            ))}
          </dl>

          {/* The two standing instructions, same wording the printed sheet carries.
              The first of them is about travelling to a branch, so an appointment held
              in a video room is told to join early instead — the same swap the sheet
              makes, and for the same reason: nobody arrives anywhere for this one. */}
          <div className="mt-4 rounded-lg border border-teal-100 bg-teal-50/60 p-3 text-xs leading-relaxed text-teal-800" data-testid={`${testid}-note`}>
            <p>{appt.meetLink ? "Please join the meeting 5 minutes early." : "Please arrive 10 minutes early."}</p>
            <p>To reschedule or cancel, contact the branch quoting reference {appt.refNo}.</p>
          </div>

          {appt.notes && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Notes</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{appt.notes}</p>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-3">
          {/* Icons on one row, as the receipt popup does. Every label moves to title
              and aria-label rather than being dropped. Done goes with them: the header
              X runs the same close-and-move, so it was a second button for one action. */}
          <div className="flex items-center justify-center gap-2 pt-1 sm:gap-3">
            {/* A printer, matching the receipt popup's own first button. It opens the
                sheet with the print dialog already up, which is what a printer icon
                promises — the document glyph promised a file and delivered a print.
                Save-as-PDF still lives behind that dialog, so nothing is lost. */}
            <Button
              variant="outline"
              className="h-10 w-10 shrink-0 p-0"
              onClick={() => openPrintable(apptHtml(appt), { print: true })}
              title="Print"
              aria-label="Print"
              data-testid={`${testid}-pdf`}
            >
              <Printer className="h-4 w-4" />
            </Button>
            {/* The one the branch actually reaches for: the confirmation PDF to the
                patient's own number. */}
            <Button
              className="h-10 w-10 shrink-0 bg-[#25D366] p-0 text-white hover:bg-[#1da851]"
              onClick={() => whatsappPdf(pdf, pdfName, pdfTitle, appt.phone)}
              title="Send on WhatsApp"
              aria-label="Send on WhatsApp"
              data-testid={`${testid}-whatsapp`}
            >
              <WhatsAppIcon className="h-4 w-4" />
            </Button>
            {/* The PDF through the share sheet, for anyone other than the patient. */}
            <Button
              variant="outline"
              className="h-10 w-10 shrink-0 p-0"
              onClick={() => sharePdf(pdf, pdfName, pdfTitle)}
              title="Share PDF"
              aria-label="Share PDF"
              data-testid={`${testid}-share-card`}
            >
              <Share2 className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="h-10 w-10 shrink-0 p-0"
              onClick={() => downloadPdf(pdf, pdfName)}
              title="Download PDF"
              aria-label="Download PDF"
              data-testid={`${testid}-download`}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppointmentConfirmCard;
