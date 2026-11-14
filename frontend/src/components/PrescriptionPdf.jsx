import { useEffect, useMemo, useState } from "react";
import { Download, Eye, Printer, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { DocumentPreview, useDocumentPreview } from "@/components/ui/document-preview";
import { toast } from "@/components/ui/sonner";
import { downloadPdf, sharePdf, whatsappPdf } from "@/lib/pdf";
import { buildPrescription, prescriptionData, prescriptionMissing, printPrescription } from "@/lib/prescription";

export const PrescriptionPdf = ({ lead, branch }) => {
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
  return (
    <div className="space-y-3" data-testid="prescription-pdf">
      <p className="text-xs text-slate-600" role="status">
        {missing || error || (ready ? "From the consultant’s saved Treatment Prescription." : "Preparing prescription PDF…")}
      </p>
      {error && <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button>}
      <div className="flex flex-wrap gap-2">
        {[
          ["View PDF", Eye, view, "view"],
          ["Download", Download, () => downloadPdf(pdf, filename), "download"],
          ["WhatsApp", WhatsAppIcon, () => whatsappPdf(pdf, filename, title, data.phone), "whatsapp"],
          ["Print", Printer, print, "print"],
          ["Share", Share2, () => sharePdf(pdf, filename, title), "share"],
        ].map(([label, Icon, onClick, id]) => (
          <Button key={id} type="button" size="sm" variant="outline" disabled={!ready} onClick={onClick} data-testid={`prescription-${id}`}>
            <Icon className="mr-1.5 h-3.5 w-3.5" />{label}
          </Button>
        ))}
      </div>
      <DocumentPreview preview={preview} onClose={closePreview} testid="prescription-preview" />
    </div>
  );
};
