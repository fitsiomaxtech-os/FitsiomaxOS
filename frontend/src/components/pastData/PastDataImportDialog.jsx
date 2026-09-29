import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { importPastData, previewPastDataImport } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { rs } from "@/lib/pastData";

const EXAMPLES_SHOWN = 3;

// Excel reads a UTF-8 CSV with a byte-order mark as UTF-8; without it, a name like "Sélvi"
// comes out as mojibake in the sheet the findings are meant to be fixed from.
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const downloadFindings = (rows, fileName) => {
  const lines = [
    ["Finding", "Meaning", "Sheet", "ID", "Detail", "Imported"].map(csvCell).join(","),
    ...rows.map((f) => [f.code, f.meaning, f.sheet, f.excel_id, f.detail, f.imported ? "yes, flagged" : "no"].map(csvCell).join(",")),
  ];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(fileName || "register").replace(/\.[^.]+$/, "")}-findings.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const Figure = ({ label, value, tone = "text-slate-900" }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
    <p className={`mt-0.5 text-lg font-bold ${tone}`}>{value}</p>
  </div>
);

const FindingGroup = ({ g }) => (
  <li className="rounded-md border border-slate-200 bg-white p-2.5" data-testid={`import-finding-${g.code}`}>
    <p className="text-sm text-slate-800">
      <span className={`mr-2 inline-flex min-w-[2rem] justify-center rounded-full px-1.5 text-xs font-bold ${g.imported ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-700"}`}>{g.count}</span>
      {g.meaning}
    </p>
    <ul className="mt-1 space-y-0.5 pl-10 text-xs text-slate-500">
      {g.examples.slice(0, EXAMPLES_SHOWN).map((e, i) => (
        <li key={`${e.excel_id}-${i}`}><span className="font-mono text-slate-400">{e.excel_id}</span> {e.detail}</li>
      ))}
      {g.count > EXAMPLES_SHOWN && <li className="italic">… and {g.count - EXAMPLES_SHOWN} more in the CSV</li>}
    </ul>
  </li>
);

/**
 * Super Admin's Import Excel, in the two steps the terminal tool takes: read the workbook
 * and show what importing it would do (nothing is written), then import it once somebody has
 * read that and said so. The same file is sent both times -- the server keeps nothing between
 * the two -- with the sha256 the check returned, so what is imported is what was checked.
 */
export const PastDataImportDialog = ({ open, branchId, onClose, onImported }) => {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const reset = () => {
    setFile(null); setPreview(null); setChecking(false); setImporting(false); setError(""); setConfirmed(false);
    if (inputRef.current) inputRef.current.value = "";
  };
  const close = () => { if (importing) return; reset(); onClose(); };

  const choose = async (picked) => {
    if (!picked) return;
    setFile(picked); setPreview(null); setError(""); setConfirmed(false); setChecking(true);
    try {
      setPreview(await previewPastDataImport(branchId, picked));
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not check this file");
    } finally {
      setChecking(false);
    }
  };

  const runImport = async () => {
    if (!file || !preview) return;
    setImporting(true); setError("");
    try {
      const res = await importPastData(branchId, file, preview.sha256, preview.existing.length > 0);
      toast.success(`Imported ${res.counts.past_clients} past clients into ${preview.branch.name}`);
      reset();
      onImported();
    } catch (e) {
      setError(e?.response?.data?.detail || "The import did not go through -- nothing was changed");
      setImporting(false);
    }
  };

  const report = preview?.report;
  const flagged = (report?.finding_groups || []).filter((g) => g.imported);
  const leftOut = (report?.finding_groups || []).filter((g) => !g.imported);
  const replacing = preview?.existing?.[0];
  const paid = report?.payment_states?.paid || { rows: 0 };
  const unpaid = report?.payment_states?.unpaid || { rows: 0 };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="past-import-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5 text-emerald-600" />Import Excel register</DialogTitle>
          <DialogDescription>
            Choose the register (Max00data.xlsm). It is checked first and nothing is written until you press Import.
            Past data goes only into this branch, and never into live leads, revenue or dashboards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
            <input
              ref={inputRef}
              type="file"
              accept=".xlsm,.xlsx"
              className="hidden"
              onChange={(e) => choose(e.target.files?.[0])}
              data-testid="past-import-file"
            />
            <Button type="button" variant="outline" className="gap-2" onClick={() => inputRef.current?.click()} disabled={checking || importing} data-testid="past-import-choose">
              <Upload className="h-4 w-4" />{file ? "Choose another file" : "Choose file"}
            </Button>
            <span className="min-w-0 truncate text-sm text-slate-600">{file ? file.name : "No file chosen"}</span>
            {checking && <span className="inline-flex items-center gap-1.5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Checking…</span>}
          </div>

          {error && <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="past-import-error">{error}</p>}

          {report && (
            <div className="space-y-4" data-testid="past-import-report">
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />Checked. This is what importing it into <b>{preview.branch.name}</b> would do:
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Figure label="Clients" value={report.clients.toLocaleString("en-IN")} />
                <Figure label="Treatments" value={report.treatments.toLocaleString("en-IN")} />
                <Figure label={`Paid (${paid.rows})`} value={rs(report.paid_total)} tone="text-emerald-700" />
                <Figure label={`Unpaid (${unpaid.rows})`} value={rs(report.outstanding_total)} tone="text-amber-700" />
              </div>
              <p className="text-xs text-slate-500">
                {report.payments.toLocaleString("en-IN")} installment rows · {report.enquiries_attached} of {report.enquiries_read} enquiries matched to a client
              </p>

              {flagged.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-amber-700">Imported with a warning — fix in Excel and re-import to clear</h4>
                  <ul className="space-y-1.5">{flagged.map((g) => <FindingGroup key={g.code} g={g} />)}</ul>
                </section>
              )}
              {leftOut.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-rose-700">Left out</h4>
                  <ul className="space-y-1.5">{leftOut.map((g) => <FindingGroup key={g.code} g={g} />)}</ul>
                </section>
              )}
              {report.all_findings.length > 0 && (
                <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => downloadFindings(report.all_findings, preview.file_name)} data-testid="past-import-csv">
                  <Download className="h-4 w-4" />Download all findings (CSV)
                </Button>
              )}

              {replacing && (
                <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" data-testid="past-import-replacing">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    This <b>replaces</b> the past data already here — {replacing.counts?.past_clients ?? 0} clients from {replacing.source_file},
                    imported {replacing.imported_at ? dateStampFull(replacing.imported_at) : ""}. The old import is removed only after this one is fully written.
                  </span>
                </p>
              )}

              <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="past-import-confirm" />
                I have checked this report and want to import it into {preview.branch.name}.
              </label>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <Button type="button" variant="outline" onClick={close} disabled={importing} data-testid="past-import-cancel">Cancel</Button>
            <Button
              type="button"
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!report || !confirmed || importing || checking}
              onClick={runImport}
              data-testid="past-import-submit"
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {importing ? "Importing…" : replacing ? "Replace and import" : "Import"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PastDataImportDialog;
