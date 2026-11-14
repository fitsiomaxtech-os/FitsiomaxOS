import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, Printer, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { DocumentPreview, useDocumentPreview } from "@/components/ui/document-preview";
import { toast } from "@/components/ui/sonner";
import { downloadPdf, sharePdf, whatsappPdf } from "@/lib/pdf";
import { buildPrescription, prescriptionData, prescriptionMissing, printPrescription } from "@/lib/prescription";

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
  const job = useMemo(() => {
    let pending;
    return () => { if (!pending) pending = buildPrescription(data); return pending; };
    // Retry creates a fresh build after a temporary asset/load failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, retry]);
  useEffect(() => {
    let alive = true;
    setError(null);
    closePreview();
    if (!missing) job().then((result) => { if (alive) setBuilt({ job, result }); })
      .catch((err) => { if (alive) setError(err.message || "Could not create the prescription PDF."); });
    return () => { alive = false; };
  }, [job, missing, closePreview]);
  const ready = !missing && built?.job === job;
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
  const actions = (
    <div className={`flex flex-wrap gap-2 ${actionsSlot ? "mr-auto" : ""}`} data-testid="prescription-actions">
      {[
        ["View PDF", Eye, view, "view"],
        ["Download", Download, () => downloadPdf(pdf, filename), "download"],
        ["WhatsApp", WhatsAppIcon, () => whatsappPdf(pdf, filename, title, data.phone), "whatsapp"],
        ["Print", Printer, print, "print"],
        ["Share", Share2, () => sharePdf(pdf, filename, title), "share"],
      ].map(([label, Icon, onClick, id]) => (
        <Button key={id} type="button" size="icon" variant="outline" className="h-8 w-8" disabled={!ready} onClick={onClick}
          title={label} aria-label={label} data-testid={`prescription-${id}`}>
          <Icon className="h-4 w-4" />
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
