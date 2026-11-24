import { useEffect, useMemo, useState } from "react";
import { Calendar, CheckCircle2, Download, Printer, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { toast } from "@/components/ui/sonner";
import { getBill, publicBillUrl, uploadBillPdf } from "@/lib/api";
import { LOGO_URL } from "@/lib/printable";
import { downloadPdf, savePdf, sharePdf, usePdf, whatsappPdf } from "@/lib/pdf";
import { waNumber } from "@/lib/phone";
import { billName, billTransaction, isHandheld, isSchedule, printReceipt, receiptHtml, receiptMessage, receiptPopupRows, withBill } from "@/lib/receipt";

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
 * `given` is the shape makeReceipt builds in ConsultationsBoard and receiptFromTransaction
 * and quickReceipt build in lib/receipt.js. Renders nothing when it is null, so a caller can
 * hold the state and mount this unconditionally.
 *
 * Opens at once on what the caller knows, then puts the server's bill over it (Bill No., the
 * branch, what was already paid and what is left). Print, WhatsApp, Share and Download wait
 * for that -- a moment -- so no bill is handed over without its number. If it cannot be
 * fetched they come back on what the caller knew, and the popup says so with a Retry.
 */
export function ReceiptDialog({ receipt: given, onClose, testid = "cons-receipt" }) {
  const txn = billTransaction(given);
  // Held with the id it answers, so a slow answer never lands on another receipt.
  const [fetched, setFetched] = useState(null); // { txn, bill } | { txn, failed: true } | null
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!txn) return undefined;
    let live = true;
    setFetched((f) => (f?.txn === txn && f.bill ? f : null));
    getBill(txn)
      .then((bill) => { if (live) setFetched({ txn, bill }); })
      .catch(() => { if (live) setFetched({ txn, failed: true }); });
    return () => { live = false; };
  }, [txn, tries, given]);
  const bill = txn && fetched?.txn === txn ? fetched.bill || null : null;
  const failed = !!txn && fetched?.txn === txn && !!fetched.failed;
  const waiting = !!txn && !bill && !failed;
  const receipt = useMemo(() => (given && bill ? withBill(given, bill) : given), [given, bill]);
  // WhatsApp, Share and Download all send the printed bill as one PDF.
  const html = useMemo(() => (receipt && !waiting ? receiptHtml(receipt) : null), [receipt, waiting]);
  const pdf = usePdf(html);
  const [sending, setSending] = useState(false);
  if (!receipt) return null;
  const pdfName = `${isSchedule(receipt) ? "Schedule" : "Bill"}-${billName(receipt)}.pdf`;
  const message = receiptMessage(receipt);

  // WhatsApp always carries the PDF and a short message. A phone hands the file itself over
  // through its share sheet. A desk opens the patient's own chat, and wa.me takes text and
  // no file -- so the PDF goes up behind a link of its own and rides in the message, as the
  // appointment's does (AppointmentConfirmCard). With no link to be had, the file is saved
  // beside the chat to be attached by hand.
  const sendWhatsApp = async () => {
    if (sending) return;
    const num = waNumber(receipt.phone);
    if (!num) { toast.error("This patient has no phone number on file"); return; }
    if (isHandheld() || !txn || !bill) { whatsappPdf(pdf, pdfName, "", receipt.phone, message); return; }
    // Claimed now, while the click still counts — after the awaits the popup blocker takes it.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setSending(true);
    try {
      const blob = await pdf();
      let text;
      try {
        text = receiptMessage(receipt, publicBillUrl((await uploadBillPdf(txn, blob)).token));
      } catch {
        text = message;
        savePdf(blob, pdfName);
        toast.message("PDF downloaded — attach it in the WhatsApp chat");
      }
      const url = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
      if (tab && !tab.closed) tab.location.href = url;
      else window.open(url, "_blank");
    } catch {
      tab?.close();
      toast.error("Couldn't build the PDF");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3" data-testid={`${testid}-modal`}>
      {/* 88%, this dialog only. zoom rather than transform: scale — zoom shrinks the
          layout box itself, so the flex centring above and the max-h below still work
          on the size actually drawn. scale would leave the box at full size, centring
          the card off its own bounds and reserving space nothing occupies. */}
      <div
        className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl"
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
              <p className="truncate text-xs text-white/80" data-testid={`${testid}-number`}>
                {isSchedule(receipt) ? `Reference ${receipt.receiptNo}` : receipt.bill?.bill_no ? `Bill No. ${receipt.bill.bill_no}` : `Txn ${receipt.receiptNo}`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-[4px] p-1.5 text-white/80 hover:bg-white/20" data-testid={`${testid}-close`}>
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
                <div className={`rounded-[4px] border-2 px-4 py-5 text-center ${isSchedule(receipt) ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
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
              <div className="rounded-[4px] border-2 border-emerald-200 bg-emerald-50 px-4 py-4" data-testid={`${testid}-amount-split`}>
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
        {failed && (
          <div className="flex items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 sm:px-6" data-testid={`${testid}-no-bill`}>
            <span>The Bill No. could not be loaded.</span>
            <button type="button" onClick={() => setTries((n) => n + 1)} className="font-semibold underline" data-testid={`${testid}-retry`}>Retry</button>
          </div>
        )}
        <div className="flex items-center justify-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:gap-3 sm:px-6">
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 rounded-[4px] p-0"
            disabled={waiting}
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
            className="h-10 w-10 shrink-0 rounded-[4px] bg-[#25D366] p-0 text-white hover:bg-[#1da851]"
            disabled={waiting || sending}
            onClick={sendWhatsApp}
            title="Send on WhatsApp"
            aria-label="Send on WhatsApp"
            data-testid={`${testid}-whatsapp`}
          >
            <WhatsAppIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 rounded-[4px] p-0"
            disabled={waiting}
            onClick={() => sharePdf(pdf, pdfName, "", message)}
            title="Share PDF"
            aria-label="Share PDF"
            data-testid={`${testid}-share`}
          >
            <Share2 className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-10 w-10 shrink-0 rounded-[4px] p-0"
            disabled={waiting}
            onClick={() => downloadPdf(pdf, pdfName)}
            title={isSchedule(receipt) ? "Download Schedule" : "Download Bill"}
            aria-label={isSchedule(receipt) ? "Download Schedule" : "Download Bill"}
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
