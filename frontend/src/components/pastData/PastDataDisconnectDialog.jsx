import { useState } from "react";
import { AlertTriangle, Loader2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { disconnectPastData } from "@/lib/api";
import { dateStampFull } from "@/lib/time";

/**
 * Super Admin's Disconnect: takes the register back out of this branch. The rows are
 * deleted on the server (see DELETE /past-data/import), so it asks once, plainly, with what
 * goes. The Excel file is untouched and Import Excel reads it again.
 */
export const PastDataDisconnectDialog = ({ open, branchId, summary, onClose, onDisconnected }) => {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const latest = summary?.imports?.[0];
  const branchName = latest?.branch_name || "this branch";

  const close = () => {
    if (busy) return;
    setConfirmed(false); setError("");
    onClose();
  };

  const run = async () => {
    setBusy(true); setError("");
    try {
      const res = await disconnectPastData(branchId);
      toast.success(`Past data disconnected — ${res.removed.past_clients.toLocaleString("en-IN")} clients removed from ${branchName}`);
      setConfirmed(false);
      setBusy(false);
      onDisconnected();
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not disconnect -- nothing was changed");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-w-lg" aria-describedby="past-disconnect-warning" data-testid="past-disconnect-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Unlink className="h-5 w-5 text-rose-600" />Disconnect past data</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span id="past-disconnect-warning">
              This deletes <b>{(summary?.clients || 0).toLocaleString("en-IN")} clients</b>,{" "}
              {(summary?.treatments || 0).toLocaleString("en-IN")} treatments and{" "}
              {(summary?.payments || 0).toLocaleString("en-IN")} installments
              {latest ? <> from {latest.source_file}, imported {latest.imported_at ? dateStampFull(latest.imported_at) : ""}</> : null}.
            </span>
          </div>

          {error && <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="past-disconnect-error">{error}</p>}

          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="past-disconnect-confirm" />
            I want to remove the past data from {branchName}.
          </label>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <Button type="button" variant="outline" onClick={close} disabled={busy} data-testid="past-disconnect-cancel">Cancel</Button>
            <Button
              type="button"
              className="gap-2 bg-rose-600 text-white hover:bg-rose-700"
              disabled={!confirmed || busy}
              onClick={run}
              data-testid="past-disconnect-submit"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PastDataDisconnectDialog;
