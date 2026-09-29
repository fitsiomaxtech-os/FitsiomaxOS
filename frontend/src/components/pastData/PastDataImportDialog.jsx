import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { importPastData, previewPastDataImport } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { layoutLabel, rs } from "@/lib/pastData";

const EXAMPLES_SHOWN = 3;
const n = (v) => (v || 0).toLocaleString("en-IN");

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
  a.download = `${(fileName || "sheet").replace(/\.[^.]+$/, "")}-findings.csv`;
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
 * Add a sheet to Past Data, in the two steps the terminal tool takes: read the workbook and
 * show what adding it would do (nothing is written), then add it once somebody has read that
 * and said so. The same file is sent both times -- the server keeps nothing between the two
 * -- with the sha256 the check returned, so what is added is what was checked.
 *
 * It reads either kind of sheet the clinic kept: the register, or a branch's monthly revenue
 * sheet. Each becomes a sheet of its own on the tab. A file that is already there is caught
 * here: the very same file cannot be added twice, and one holding mostly the same people as a
 * sheet already there (the register saved again) is offered as that sheet's replacement.
 */
export const PastDataImportDialog = ({ open, branchId, onClose, onImported }) => {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [label, setLabel] = useState("");
  const [replaceId, setReplaceId] = useState("");
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const reset = () => {
    setFile(null); setPreview(null); setLabel(""); setReplaceId("");
    setChecking(false); setImporting(false); setError(""); setConfirmed(false);
    if (inputRef.current) inputRef.current.value = "";
  };
  const close = () => { if (importing) return; reset(); onClose(); };

  const choose = async (picked) => {
    if (!picked) return;
    setFile(picked); setPreview(null); setError(""); setConfirmed(false); setChecking(true);
    try {
      const res = await previewPastDataImport(branchId, picked);
      setPreview(res);
      setLabel(res.suggested_label || "");
      // Mostly the same people as a sheet already here: replacing it is the likely intent.
      setReplaceId((res.overlaps || []).find((o) => o.same_people)?.id || "");
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not check this file");
    } finally {
      setChecking(false);
    }
  };

  const report = preview?.report;
  const revenue = report?.layout === "revenue";
  const flagged = (report?.finding_groups || []).filter((g) => g.imported);
  const leftOut = (report?.finding_groups || []).filter((g) => !g.imported);
  const sameFile = preview?.same_file;
  const repeats = (preview?.overlaps || []).filter((o) => o.same_people);
  const sharing = (preview?.overlaps || []).filter((o) => !o.same_people);
  const replacing = (preview?.existing || []).find((s) => s.id === replaceId);
  const paid = report?.payment_states?.paid || { rows: 0 };
  const unpaid = report?.payment_states?.unpaid || { rows: 0 };
  const name = label.trim() || preview?.suggested_label || "this sheet";

  const runImport = async () => {
    if (!file || !preview) return;
    setImporting(true); setError("");
    try {
      const res = await importPastData(branchId, file, preview.sha256, { label: label.trim(), replaceId });
      toast.success(`${replacing ? "Replaced" : "Added"} ${name} — ${n(res.counts.past_clients)} past clients`);
      reset();
      onImported();
    } catch (e) {
      setError(e?.response?.data?.detail || "The sheet was not added -- nothing was changed");
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="past-import-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5 text-emerald-600" />Add a sheet</DialogTitle>
          <DialogDescription>
            Choose an Excel sheet: the clinic register, or a branch's monthly revenue sheet. It is checked first and
            nothing is written until you press Add. Past data never goes into live leads, revenue or dashboards.
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
              <p className="inline-flex flex-wrap items-center gap-1.5 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />Checked: a {layoutLabel(report.layout).toLowerCase()}. This is what adding it to <b>{preview.branch.name}</b> would do:
              </p>

              <label className="block space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Sheet name</span>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={preview.suggested_label} className="h-9 sm:w-80" data-testid="past-import-label" />
              </label>

              {revenue ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Figure label="Clients" value={n(report.clients)} />
                  <Figure label="Payments" value={n(report.payments)} />
                  <Figure label="Collected" value={rs(report.paid_total)} tone="text-emerald-700" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Figure label="Clients" value={n(report.clients)} />
                  <Figure label="Treatments" value={n(report.treatments)} />
                  <Figure label={`Paid (${paid.rows})`} value={rs(report.paid_total)} tone="text-emerald-700" />
                  <Figure label={`Unpaid (${unpaid.rows})`} value={rs(report.outstanding_total)} tone="text-amber-700" />
                </div>
              )}
              <p className="text-xs text-slate-500" data-testid="past-import-sub">
                {revenue
                  ? `Month tabs read: ${(report.tabs || []).join(", ")} · one payment per row`
                  : `${n(report.payments)} installment rows · ${report.enquiries_attached} of ${report.enquiries_read} enquiries matched to a client`}
              </p>

              {flagged.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-amber-700">Imported with a warning — fix in Excel and replace the sheet to clear</h4>
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

              {sameFile ? (
                <p className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" data-testid="past-import-same-file">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>This exact file is already here as <b>{sameFile.label}</b>, added {sameFile.imported_at ? dateStampFull(sameFile.imported_at) : ""}.</span>
                </p>
              ) : (
                <>
                  {repeats.length > 0 && (
                    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="past-import-repeats">
                      <p className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          Most of these people are already here: {repeats.map((o) => `${n(o.matched)} of ${n(o.of)} in ${o.label}`).join("; ")}.
                          It looks like the same sheet saved again.
                        </span>
                      </p>
                      <div className="space-y-1 pl-6">
                        {repeats.map((o) => (
                          <label key={o.id} className="flex cursor-pointer items-center gap-2">
                            <input type="radio" name="past-import-mode" checked={replaceId === o.id} onChange={() => setReplaceId(o.id)} data-testid={`past-import-replace-${o.id}`} />
                            Replace <b>{o.label}</b> with this file
                          </label>
                        ))}
                        <label className="flex cursor-pointer items-center gap-2">
                          <input type="radio" name="past-import-mode" checked={!replaceId} onChange={() => setReplaceId("")} data-testid="past-import-add-alongside" />
                          Add as another sheet (these people will show twice)
                        </label>
                      </div>
                    </div>
                  )}
                  {sharing.length > 0 && (
                    <p className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600" data-testid="past-import-sharing">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{sharing.map((o) => `${n(o.matched)} of ${n(o.of)} people are also in ${o.label}`).join("; ")} — patients who came back. They are added here as well.</span>
                    </p>
                  )}
                </>
              )}

              {!sameFile && (
                <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="past-import-confirm" />
                  I have checked this report and want to {replacing ? `replace ${replacing.label} with it` : `add it to ${preview.branch.name}`}.
                </label>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <Button type="button" variant="outline" onClick={close} disabled={importing} data-testid="past-import-cancel">Cancel</Button>
            <Button
              type="button"
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!report || !!sameFile || !confirmed || importing || checking}
              onClick={runImport}
              data-testid="past-import-submit"
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {importing ? "Adding…" : replacing ? `Replace ${replacing.label}` : "Add sheet"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PastDataImportDialog;
