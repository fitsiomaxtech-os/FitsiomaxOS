import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getBranches, getLeadTransferEligibility, transferLeadBranch } from "@/lib/api";
import { PaymentHistory, TransferImpact, TransferReason } from "@/components/branch/BranchTransferDialog";
import { displayPhone } from "@/lib/phone";
import { clamp, useDismissOutside, useFloatingPosition } from "@/lib/use-floating";

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
  // The Transfer to list, floating under (or over) its field the way the Reschedule popup's
  // Consultant list does, rather than the browser's own <select> list.
  const [listOpen, setListOpen] = useState(false);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const listPos = useFloatingPosition(listOpen, listRef, (w, h) => {
    const gap = 8;
    const field = triggerRef.current.getBoundingClientRect();
    let top = field.bottom + 4;
    if (top + h > window.innerHeight - gap && field.top - h - 4 >= gap) top = field.top - h - 4;
    return { left: field.left, width: field.width, top: clamp(top, gap, window.innerHeight - h - gap) };
  });
  useDismissOutside(listOpen, [triggerRef, listRef], () => setListOpen(false));

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
            {lead.patient_number || displayPhone(lead.phone) || "—"}
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
              {/* The list floats in a portal over the dialog (z-[70], above its z-[60]), so
                  the card's scrolling neither clips it nor pushes the reason field down. */}
              <button
                id="lead-branch-transfer-select"
                ref={triggerRef}
                type="button"
                onClick={() => setListOpen((o) => !o)}
                className={`mt-1 flex h-10 w-full items-center gap-2 rounded-md border bg-white px-3 text-left text-sm transition-colors ${listOpen ? "border-sky-300 ring-2 ring-sky-100" : "border-[#EFEAE0] hover:bg-[#F3EFE6]"}`}
                aria-haspopup="listbox"
                aria-expanded={listOpen}
                data-testid="lead-branch-transfer-destination"
              >
                <span className={`min-w-0 flex-1 truncate ${toBranch ? "font-medium text-slate-800" : "text-slate-400"}`}>
                  {toBranch ? toBranch.branch_name : "Choose a branch…"}
                </span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${listOpen ? "rotate-180" : ""}`} />
              </button>
              {listOpen && createPortal(
                <div
                  ref={listRef}
                  className="fixed z-[70] max-h-60 overflow-y-auto rounded border border-[#EFEAE0] bg-white p-1 shadow-xl"
                  style={listPos || { top: 0, left: 0, visibility: "hidden" }}
                  role="listbox"
                  data-testid="lead-branch-transfer-list"
                >
                  {destinations.length === 0 && (
                    <p className="px-3 py-2 text-sm text-slate-400">No other branches.</p>
                  )}
                  {destinations.map((b) => {
                    const on = toBranchId === b.id;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onClick={() => { setToBranchId(b.id); setListOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${on ? "bg-sky-100 font-semibold text-slate-800" : "text-slate-600 hover:bg-[#F3EFE6]"}`}
                        data-testid={`lead-branch-transfer-option-${b.id}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{b.branch_name}</span>
                        <Check className={`h-4 w-4 shrink-0 text-sky-600 ${on ? "" : "invisible"}`} />
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
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
