// The printables as real PDF files — what WhatsApp, Share and Download send.
//
// Every one of those used to leave as something else: the receipt as a line of typed text
// or a raw .html file, the appointment as a PNG plus a message. A patient forwarding any of
// them to an insurer or an employer was forwarding a screenshot. Now all three routes carry
// the same A4 PDF, drawn from the exact HTML the Print button opens, so the file and the
// paper cannot disagree.
//
// jsPDF and html2canvas are imported on first use, not at the top: they are a few hundred
// KB between them and nobody who never opens a receipt should download them.
import { useEffect, useMemo } from "react";
import { toast } from "@/components/ui/sonner";
import { waNumber } from "@/lib/phone";
import { isHandheld } from "@/lib/receipt";

const A4_W = 210;
const A4_H = 297;
const MARGIN = 10;
// A4 at 96dpi — the width the sheet is laid out at, so its desktop layout is the one drawn
// rather than the phone breakpoint PRINTABLE_STYLES switches to under 600px.
const RENDER_W = 794;

/** A standalone printable HTML document -> PDF Blob. */
export const htmlToPdf = async (html) => {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);
  // Off-screen rather than hidden: a display:none frame lays nothing out to draw.
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${RENDER_W}px;height:1123px;border:0`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    // Waits for the logo and the web font, same reason openPrintable does — drawn early,
    // the sheet has a hole where the logo goes. The timer covers either never arriving.
    await new Promise((resolve) => {
      if (doc.readyState === "complete") resolve();
      else frame.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 4000);
    });
    try { await doc.fonts?.ready; } catch { /* fonts API missing — draw with what loaded */ }

    const target = doc.querySelector(".doc") || doc.body;
    const canvas = await html2canvas(target, {
      scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: RENDER_W, logging: false,
    });

    const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const w = A4_W - MARGIN * 2;
    const pxPerMm = canvas.width / w;
    const pagePx = Math.floor((A4_H - MARGIN * 2) * pxPerMm);
    // Sliced a page at a time, so a schedule with a long installment table runs onto a
    // second page instead of being squeezed into one at a size nobody can read.
    for (let y = 0; y < canvas.height; y += pagePx) {
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = Math.min(pagePx, canvas.height - y);
      const ctx = slice.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, -y);
      if (y > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", MARGIN, MARGIN, w, slice.height / pxPerMm);
    }
    return pdf.output("blob");
  } finally {
    frame.remove();
  }
};

/**
 * A PDF built at most once, on demand. A failed build is forgotten so the next click
 * tries again instead of replaying the same error forever.
 */
export const pdfJob = (html) => {
  let pending = null;
  return () => {
    if (!pending) pending = htmlToPdf(html).catch((err) => { pending = null; throw err; });
    return pending;
  };
};

/**
 * pdfJob, started as soon as the popup opens.
 *
 * The share sheet only opens inside a click — a few seconds' grace on Chrome, far less on
 * Safari — and drawing the PDF can take that long on a phone. Building it in the
 * background while the branch reads the card means the click usually finds it ready.
 */
export const usePdf = (html) => {
  const job = useMemo(() => (html ? pdfJob(html) : null), [html]);
  useEffect(() => { job?.().catch(() => {}); }, [job]);
  return job;
};

export const savePdf = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const build = async (job) => {
  try { return await job(); } catch {
    toast.error("Couldn't build the PDF");
    return null;
  }
};

/** Copied for pasting beside a PDF that had to be saved rather than shared. Best effort:
 *  after the PDF's await the browser may no longer count this as the click. */
const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

/**
 * Through the OS share sheet as a file. "saved" when the device can't share files.
 *
 * `text` rides along as the message — the appointment's map link, which a link drawn
 * inside the PDF could not carry: the sheet is an image, so nothing on it can be tapped.
 */
const shareFile = async (blob, filename, title, text) => {
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share(text ? { files: [file], title, text } : { files: [file], title });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";  // closed the share sheet
      // NotAllowedError: the click's grace ran out while the PDF was drawing. Saved
      // instead, so the click still produces the file.
    }
  }
  savePdf(blob, filename);
  return "saved";
};

export const downloadPdf = async (job, filename) => {
  const blob = await build(job);
  if (blob) savePdf(blob, filename);
};

export const sharePdf = async (job, filename, title, text) => {
  const blob = await build(job);
  if (!blob) return;
  if (await shareFile(blob, filename, title, text) !== "saved") return;
  if (text && await copyText(text)) toast.success("PDF saved, map link copied — attach the file and paste the link");
  else toast.success("PDF saved — attach it to your message");
};

/**
 * The PDF to the patient on WhatsApp.
 *
 * WhatsApp gives no single route that does both halves: wa.me addresses a number but
 * carries text only, and the share sheet carries a file but asks who it is for. So a phone
 * gets the share sheet with the PDF (WhatsApp is on it), and a desk — where WhatsApp Web
 * cannot be handed a file at all — gets the PDF downloaded and the patient's chat opened
 * beside it, to drop the file into. `text` is the message on both: the share sheet's
 * caption on a phone, the chat's typed-in draft on a desk.
 */
export const whatsappPdf = async (job, filename, title, phone, text) => {
  const num = waNumber(phone);
  if (!num) { toast.error("This patient has no phone number on file"); return; }

  if (isHandheld()) {
    const blob = await build(job);
    if (!blob) return;
    if (await shareFile(blob, filename, title, text) === "saved") {
      if (text && await copyText(text)) toast.success("PDF saved, map link copied — open WhatsApp, attach it and paste the link");
      else toast.success("PDF saved — open WhatsApp and attach it");
    }
    return;
  }

  // Claimed now, while the click still counts — after the await the popup blocker takes
  // it. noopener isn't passed because it makes window.open return null; the opener is
  // cleared by hand for the same protection.
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  const blob = await build(job);
  if (!blob) { tab?.close(); return; }
  savePdf(blob, filename);
  const url = `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
  if (tab && !tab.closed) tab.location.href = url;
  else window.open(url, "_blank");
  toast.success("PDF downloaded — attach it in the WhatsApp chat");
};
