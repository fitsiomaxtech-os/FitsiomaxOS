import { useEffect, useState } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getBranches, getLeadTransferEligibility, transferLeadBranch } from "@/lib/api";
import { PaymentHistory, TransferImpact, TransferReason } from "@/components/branch/BranchTransferDialog";

/**
 * Branch Transfer for the one lead whose popup it was opened from.
 *
 * Two steps: pick the branch, then confirm. The confirmation is its own screen rather than
 * a disabled-until-picked button, because a transfer takes the patient off the board the
 * reader is looking at — the name of the branch they are going to should be read once,
 * in a sentence, before it happens.
 *
 * Any stage. Eligibility is still asked for up front: it carries what the move does — the
 * money that stays here, the balance the new branch collects, anything booked here that is
 * released — and the confirm screen says all of it before the button is pressed. The reason
 * is required, because the receiving branch reads it on its Branch Transfer Record.
 */
export const LeadBranchTransferDialog = ({ lead, fromBranchId, onClose, onTransferred }) => {
  const [branches, setBranches] = useState(null);
  const [eligibility, setEligibility] = useState(null);
  const [toBranchId, setToBranchId] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [transferring, setTransferring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(rows || []); })
      .catch(() => { if (!cancelled) setBranches([]); });
    getLeadTransferEligibility(lead.id)
      .then((d) => { if (!cancelled) setEligibility(d); })
      .catch(() => { if (!cancelled) setEligibility({ can_transfer: false, blocked_reason: "Could not check whether this lead can be transferred." }); });
    return () => { cancelled = true; };
  }, [lead.id]);

  const fromBranch = (branches || []).find((b) => b.id === fromBranchId);
  const destinations = (branches || [])
    .filter((b) => b.id !== fromBranchId)
    .sort((a, b) => (a.branch_name || "").localeCompare(b.branch_name || ""));
  const toBranch = destinations.find((b) => b.id === toBranchId);

  const submit = async () => {
    setTransferring(true);
    try {
      const res = await transferLeadBranch(lead.id, { to_branch_id: toBranchId, reason: reason.trim() });
      toast.success(res?.message || `${lead.name} transferred to ${toBranch?.branch_name}`);
      onTransferred?.(res);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Transfer failed");
      setTransferring(false);
    }
  };

  const loading = branches === null || eligibility === null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !transferring) onClose(); }}
      data-testid="lead-branch-transfer-dialog"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold text-slate-800">
            <ArrowLeftRight className="h-4 w-4 text-indigo-600" /> Branch Transfer
          </h3>
          <button onClick={onClose} disabled={transferring} className="text-slate-400 hover:text-slate-600" data-testid="lead-branch-transfer-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-5">
          <p className="text-sm font-semibold text-slate-800">{lead.name || "—"}</p>
          <p className="text-xs text-slate-500">
            {lead.patient_number || lead.phone || "—"}
            {fromBranch ? ` · ${fromBranch.branch_name}` : ""}
          </p>

          {loading ? (
            <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
          ) : !eligibility.can_transfer ? (
            <>
              <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-relaxed text-rose-700" data-testid="lead-branch-transfer-blocked">
                {eligibility.blocked_reason}
              </p>
              <div className="mt-4 flex justify-end">
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </>
          ) : !confirming ? (
            <>
              <label className="mt-4 block text-xs font-semibold text-slate-600" htmlFor="lead-branch-transfer-select">Transfer to</label>
              <select
                id="lead-branch-transfer-select"
                value={toBranchId}
                onChange={(e) => setToBranchId(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-indigo-400"
                data-testid="lead-branch-transfer-destination"
              >
                <option value="">Choose a branch…</option>
                {destinations.map((b) => (
                  <option key={b.id} value={b.id}>{b.branch_name}</option>
                ))}
              </select>
              <TransferReason value={reason} onChange={setReason} testid="lead-branch-transfer-reason" />
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                <Button
                  className="bg-indigo-600 text-white hover:bg-indigo-700"
                  disabled={!toBranchId || !reason.trim()}
                  onClick={() => setConfirming(true)}
                  data-testid="lead-branch-transfer-next"
                >
                  Transfer
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-4 text-sm text-slate-800" data-testid="lead-branch-transfer-confirm">
                Transfer <b>{lead.name}</b> from <b>{fromBranch?.branch_name || "this branch"}</b> to <b>{toBranch?.branch_name}</b>?
              </p>
              <p className="mt-1 text-xs text-slate-500">Reason: {reason.trim()}</p>
              <TransferImpact eligibility={eligibility} fromBranchName={fromBranch?.branch_name} testid="lead-branch-transfer-impact" />
              <PaymentHistory rows={eligibility.payment_history} currentBranchName={fromBranch?.branch_name} />
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="outline" disabled={transferring} onClick={() => setConfirming(false)} data-testid="lead-branch-transfer-back">
                  Back
                </Button>
                <Button
                  className="bg-indigo-600 text-white hover:bg-indigo-700"
                  disabled={transferring}
                  onClick={submit}
                  data-testid="lead-branch-transfer-submit"
                >
                  {transferring ? "Transferring…" : "Confirm Transfer"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
