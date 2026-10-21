import { Calendar, CheckCircle2, Download, Printer, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { LOGO_URL } from "@/lib/printable";
import { downloadPdf, sharePdf, usePdf, whatsappPdf } from "@/lib/pdf";
import { isSchedule, printReceipt, receiptHtml, receiptPopupRows } from "@/lib/receipt";

/** round2, the same helper the collect form's own discount readout uses, so the
 *  percentage on the receipt cannot disagree with the one shown while the amount was
 *  being entered. 35% off, not 35.00%; 12.5% stays 12.5%. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The receipt as the branch and the patient see it, and the four ways it leaves the room.
 *
 * Shown after a fee is taken — the money has changed hands and the client is standing
 * there, so the acknowledgement has to be something that can be handed over rather than a
 * toast that disappears. It is also what a reissue opens: the same card, rebuilt off the
 * record, because a patient who comes back for their receipt should be given the receipt
 * they were given the first time and not a second document that merely describes it.
 *
 * `receipt` is the shape makeReceipt builds in ConsultationsBoard and receiptFromTransaction
 * builds in lib/receipt.js. Renders nothing when it is null, so a caller can hold the
 * state and mount this unconditionally.
 */
export function ReceiptDialog({ receipt, onClose, testid = "cons-receipt" }) {
  // WhatsApp, Share and Download all send the printed bill as one PDF.
  const pdf = usePdf(receipt ? receiptHtml(receipt) : null);
  if (!receipt) return null;
  const pdfName = `${isSchedule(receipt) ? "schedule" : "receipt"}-${receipt.receiptNo}.pdf`;
  const pdfTitle = `FITSIOMAX ${isSchedule(receipt) ? "Payment Schedule" : "Receipt"} ${receipt.receiptNo}`;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3" data-testid={`${testid}-modal`}>
      {/* 88%, this dialog only. zoom rather than transform: scale — zoom shrinks the
          layout box itself, so the flex centring above and the max-h below still work
          on the size actually drawn. scale would leave the box at full size, centring
          the card off its own bounds and reserving space nothing occupies. */}
      <div
        className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        style={{ zoom: 0.88 }}
      >
        {/* items-center, not items-start: the title block is shorter than the logo, so
            aligning to the top left a band of empty green under the transaction line.
            Padding and logo come down with it. */}
        <div className={`flex items-center justify-between gap-3 px-4 py-3 text-white ${isSchedule(receipt) ? "bg-amber-600" : "bg-emerald-600"}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            {/* A status mark rather than the logo: the logo already opens the body
                two lines below, and the header's job is to say what happened. */}
            {isSchedule(receipt)
              ? <Calendar className="h-7 w-7 shrink-0" />
              : <CheckCircle2 className="h-7 w-7 shrink-0" />}
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight">{isSchedule(receipt) ? "Payment Schedule Created" : "Payment Received"}</p>
              <p className="truncate text-xs text-white/80">{isSchedule(receipt) ? "Reference" : "Txn"} {receipt.receiptNo}</p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid={`${testid}-close`}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center justify-center gap-2 text-center">
            <img src={LOGO_URL} alt="" className="h-7 w-7 object-contain" />
            <div className="text-left">
              <p className="text-base font-extrabold tracking-wide text-slate-800">FITSIOMAX</p>
              <p className="text-[10px] text-slate-400">{receipt.branch || "Physiotherapy & Rehabilitation"}</p>
            </div>
          </div>

          {/* With a discount, the hero shows what it was worth as well as what came
              in — billed, off, collected. Rs.780 on its own is unarguable but says
              nothing about the Rs.1,200 it started from, and that is the number a
              patient queries. Both figures were already on the receipt, several rows
              further down, which is not where anyone looks first.
              No discount, or a schedule where nothing has been collected: the single
              figure stays: a "discount Rs.0" column is noise on most receipts. */}
          {(() => {
            const billed = receipt.originalAmount;
            const off = Number(receipt.discount) || 0;
            const showSplit = !isSchedule(receipt) && off > 0 && billed > 0;
            if (!showSplit) {
              return (
                <div className={`rounded-xl border-2 px-4 py-5 text-center ${isSchedule(receipt) ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <p className={`text-xs font-bold uppercase tracking-widest ${isSchedule(receipt) ? "text-amber-600" : "text-emerald-600"}`}>
                    {isSchedule(receipt) ? "Total Payable" : "Amount Paid"}
                  </p>
                  <p className={`mt-1 text-4xl font-extrabold ${isSchedule(receipt) ? "text-amber-700" : "text-emerald-700"}`} data-testid={`${testid}-amount`}>Rs.{receipt.amount}</p>
                  <p className={`mt-1 text-sm font-semibold ${isSchedule(receipt) ? "text-amber-600" : "text-emerald-600"}`}>{receipt.modeLabel}</p>
                  {isSchedule(receipt) && (
                    <p className="mt-2 text-xs font-medium text-amber-700">Nothing collected yet — each installment gets its own receipt.</p>
                  )}
                </div>
              );
            }
            const pct = round2((off / billed) * 100);
            return (
              <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 px-4 py-4" data-testid={`${testid}-amount-split`}>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[11px] font-medium text-slate-500">Total Amount</p>
                    <p className="mt-1 text-xl font-extrabold text-slate-700">Rs.{billed}</p>
                  </div>
                  <div>
                    {/* The percentage sits in the heading rather than on a third line —
                        "32% Discount" is one fact, and splitting it made the middle
                        column a line taller than the two either side of it. */}
                    <p className="text-[11px] font-medium text-amber-600">{pct}% Discount</p>
                    <p className="mt-1 text-xl font-extrabold text-amber-700" data-testid={`${testid}-discount`}>−Rs.{off}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-emerald-600">Paid Amount</p>
                    <p className="mt-1 text-xl font-extrabold text-emerald-700" data-testid={`${testid}-amount`}>Rs.{receipt.amount}</p>
                    <p className="text-[10px] font-semibold text-emerald-600">{receipt.modeLabel}</p>
                  </div>
                </div>
              </div>
            );
          })()}

          <dl className="mt-5 space-y-2 text-sm">
            {receiptPopupRows(receipt).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">{k}</dt>
                <dd className={`text-right font-semibold ${
                  k === "Amount Paid" ? "text-emerald-700"
                  : k === "Total Payable" ? "text-amber-700"
                  : k === "Discount" ? "text-rose-600"
                  : k === "Balance Due" ? "text-rose-600"
                  : "text-slate-700"}`}>{v}</dd>
              </div>
            ))}
          </dl>

          {(receipt.installments || []).length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Installments</p>
              <div className="space-y-1.5">
                {/* A paid row shows the day the money came in; rows paid before paid_on was
                    stamped fall back to their due date, which is the day the first one is taken. */}
                {receipt.installments.map((i, n) => (
                  <div key={n} className="flex items-center justify-between rounded-[2px] border border-[#E4E4E4] px-3 py-2 text-xs">
                    <span className="text-slate-600">
                      {i.sessions ? `${i.sessions} sessions · ` : ""}
                      {i.paid ? `Paid on ${i.paid_on || i.due_date || "—"}` : `due ${i.due_date || "—"}`}
                    </span>
                    <span className={`font-bold ${i.paid ? "text-emerald-600" : "text-amber-600"}`}>
                      Rs.{i.amount}{i.paid ? " · PAID" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Icons only. With four on one row, "Download" was arriving as "Dow…", and a
            truncated word is worse than no word — the glyph at least survives. Every
            label moves to title and aria-label, so a hover still says what each does
            and a screen reader still announces it.
            Square and centred rather than four stretched quarters: an icon adrift in
            the middle of a wide button reads as a mis-render. */}
        {/* Three actions. Done went with the tick — the header X already closes this,
            and a fourth button that only dismisses was the one control here that did
            nothing to the receipt. */}
        {/* All plain but WhatsApp. Print and Share used to swap an emerald fill
            between them depending on whether the payment was cash — with WhatsApp's
            own brand green in the row, a second green next to it would have read as
            two competing defaults rather than one branded button. The green here now
            belongs to WhatsApp and means WhatsApp, nothing else. */}
        <div className="flex items-center justify-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:gap-3 sm:px-6">
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 p-0"
            onClick={() => printReceipt(receipt)}
            title={isSchedule(receipt) ? "Print Schedule" : "Print Bill"}
            aria-label={isSchedule(receipt) ? "Print Schedule" : "Print Bill"}
            data-testid={`${testid}-print`}
          >
            <Printer className="h-4 w-4" />
          </Button>
          {/* The one the branch actually reaches for: the receipt PDF is nearly always
              going to the number already printed on it. */}
          <Button
            className="h-10 w-10 shrink-0 bg-[#25D366] p-0 text-white hover:bg-[#1da851]"
            onClick={() => whatsappPdf(pdf, pdfName, pdfTitle, receipt.phone)}
            title="Send on WhatsApp"
            aria-label="Send on WhatsApp"
            data-testid={`${testid}-whatsapp`}
          >
            <WhatsAppIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 p-0"
            onClick={() => sharePdf(pdf, pdfName, pdfTitle)}
            title="Share PDF"
            aria-label="Share PDF"
            data-testid={`${testid}-share`}
          >
            <Share2 className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 p-0"
            onClick={() => downloadPdf(pdf, pdfName)}
            title={isSchedule(receipt) ? "Download Schedule" : "Download Receipt"}
            aria-label={isSchedule(receipt) ? "Download Schedule" : "Download Receipt"}
            data-testid={`${testid}-download`}
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ReceiptDialog;
