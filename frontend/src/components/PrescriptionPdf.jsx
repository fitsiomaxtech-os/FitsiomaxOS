import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, Printer, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { DocumentPreview, useDocumentPreview } from "@/components/ui/document-preview";
import { toast } from "@/components/ui/sonner";
import { getPrescriptionSign } from "@/lib/api";
import { downloadPdf, sharePdf, whatsappPdf } from "@/lib/pdf";
import { buildPrescription, prescriptionData, prescriptionMissing, printPrescription } from "@/lib/prescription";
import { signSrc } from "@/lib/signImage";

// `actionsSlot`: a DOM node (the popup's footer band) to draw the icon row in, instead of
// under the status line.
export const PrescriptionPdf = ({ lead, branch, actionsSlot }) => {
  const serialized = JSON.stringify(prescriptionData(lead, branch));
  const data = useMemo(() => JSON.parse(serialized), [serialized]);
  const missing = prescriptionMissing(data);
  const [retry, setRetry] = useState(0);
  const [built, setBuilt] = useState(null);
  const [error, setError] = useState(null);
  const { preview, openPreview, closePreview } = useDocumentPreview();
  // The consultant's sign, asked for before the paper is drawn so it is drawn once. No sign,
  // or none that could be fetched, is a prescription to sign by hand.
  const signKey = missing ? "" : `${lead.id}|${data.consultant}`;
  const [sign, setSign] = useState({ key: "", image: "" });
  useEffect(() => {
    if (!signKey) return undefined;
    let alive = true;
    getPrescriptionSign(lead.id)
      // Only ever over its own name: the record may have moved on since this was opened.
      .then((r) => { if (alive) setSign({ key: signKey, image: r?.name === data.consultant ? signSrc(r.image) : "" }); })
      .catch(() => { if (alive) setSign({ key: signKey, image: "" }); });
    return () => { alive = false; };
  }, [signKey, lead.id, data.consultant]);
  const signReady = !!signKey && sign.key === signKey;
  const signImage = signReady ? sign.image : "";
  const job = useMemo(() => {
    let pending;
    return () => { if (!pending) pending = buildPrescription(data, signImage); return pending; };
    // Retry creates a fresh build after a temporary asset/load failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, retry, signImage]);
  useEffect(() => {
    let alive = true;
    setError(null);
    closePreview();
    if (!missing && signReady) job().then((result) => { if (alive) setBuilt({ job, result }); })
      .catch((err) => { if (alive) setError(err.message || "Could not create the prescription PDF."); });
    return () => { alive = false; };
  }, [job, missing, signReady, closePreview]);
  const ready = !missing && signReady && built?.job === job;
  const filename = `prescription-${(data.number || lead.id || "patient").replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
  const pdf = async () => (await job()).blob;
  const title = "FITSIOMAX Prescription";
  const view = () => openPreview({ url: URL.createObjectURL(built.result.blob), name: filename, contentType: "application/pdf" });
  const print = () => {
    const tab = window.open("", "_blank");
    if (!tab) { toast.error("Allow popups to print the prescription."); return; }
    tab.opener = null;
    printPrescription(tab, built.result.pages);
  };
  // On a phone (under 640px) the five are icons only, in one row spread evenly across the
  // footer; the names come back from sm up. Each keeps its name in title / aria-label.
  const actions = (
    <div className={`flex w-full flex-nowrap gap-2 sm:w-auto sm:flex-wrap ${actionsSlot ? "sm:mr-auto" : ""}`} data-testid="prescription-actions">
      {[
        ["View PDF", Eye, view, "view"],
        ["Download", Download, () => downloadPdf(pdf, filename), "download"],
        ["WhatsApp", WhatsAppIcon, () => whatsappPdf(pdf, filename, title, data.phone), "whatsapp"],
        ["Print", Printer, print, "print"],
        ["Share", Share2, () => sharePdf(pdf, filename, title), "share"],
      ].map(([label, Icon, onClick, id]) => (
        // Icon and name in violet, 4px corners. The button itself does not change on hover;
        // only its icon does (grows on hover, dips on press).
        <Button key={id} type="button" size="sm" variant="outline"
          className="group min-w-0 flex-1 rounded-[4px] border-slate-200 bg-white px-0 text-[11px] text-[#8b5cf6] shadow-sm hover:bg-white hover:text-[#8b5cf6] sm:flex-none sm:px-3 sm:text-xs"
          disabled={!ready} onClick={onClick}
          title={label} aria-label={label} data-testid={`prescription-${id}`}>
          <Icon className="h-3.5 w-3.5 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:scale-125 group-active:translate-y-0 group-active:scale-90 sm:mr-1" />
          <span className="hidden sm:inline">{label}</span>
        </Button>
      ))}
    </div>
  );
  return (
    <div className="mt-2 space-y-3 empty:hidden" data-testid="prescription-pdf">
      {!ready && (
        <p className="text-xs text-slate-600" role="status">
          {missing || error || "Preparing prescription PDF…"}
        </p>
      )}
      {error && <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button>}
      {actionsSlot ? createPortal(actions, actionsSlot) : actions}
      <DocumentPreview preview={preview} onClose={closePreview} testid="prescription-preview" />
    </div>
  );
};
