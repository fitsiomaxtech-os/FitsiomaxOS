import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Wallet, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { markInstallmentPaid, collectPackagePayment } from "@/lib/api";
import { loadSession } from "@/lib/session";
import { TenderFields, emptyTender, tenderPayload } from "@/components/branch/CollectTender";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The revenue line each fee's money is reported on -- revenue_overview's sources -- so the
// receipt names it the way the Summary does.
const SOURCE_OF_FEE = { treatment: "session", consultation: "consultation", rehab: "rehab", diet: "diet", diet_chart: "diet_chart" };

/** What a Payment Schedule row has to collect: the next instalment of a part-paid fee, or
 *  else a Consultation Fee assigned and never collected -- the two things that leave a
 *  client on this list (_lead_outstanding_detail in routers/v3_finance.py). */
export const collectWhat = (row) => (row?.next_installment_number ? "instalment" : "consultation");

/**
 * Collect from Payment Schedule -- the per-row Collect the old Partial Payment tab had,
 * back on the list that replaced it.
 *
 * The amount is what is due, and not typed. An instalment collected for less than itself
 * is marked paid all the same (mark_installment_paid writes the amount over it), so the
 * difference would leave the books without anybody deciding it should; and a Consultation
 * Fee taken at a discount or in part needs the reason and the plan the Consultations board
 * asks for. Both of those stay there. What this does is the plain case, in one step.
 *
 * Taken through the same endpoints the rest of the OS uses, so every rule they hold still
 * holds: collecting a Consultation Fee moves the client to Fee Collected exactly as it would
 * from Consultations.
 */
export const ScheduleCollectDialog = ({ row, onClose, onCollected }) => {
  const kind = collectWhat(row);
  const isInstalment = kind === "instalment";
  const fee = row.next_installment_fee || "treatment";
  const amount = Number(isInstalment ? row.next_installment_amount : row.balance) || 0;
  const title = isInstalment
    ? `${row.next_installment_fee_label || "Fee"} · Instalment #${row.next_installment_number}`
    : "Consultation Fee";
  const [draft, setDraft] = useState({ ...emptyTender });
  const [saving, setSaving] = useState(false);
  const setD = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Escape shuts this popup and nothing under it. Opened over the client popup, that one
  // listens for Escape on window too; caught here on the way down and stopped, it never
  // hears it, so the client popup stays open behind as Cancel would leave it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!saving) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [saving, onClose]);

  const submit = async () => {
    if (!(amount > 0)) { toast.error("Nothing is due to collect"); return; }
    const tender = tenderPayload(draft);
    if (tender.error) { toast.error(tender.error); return; }
    setSaving(true);
    try {
      const res = isInstalment
        ? await markInstallmentPaid(row.lead_id, row.next_installment_number, { ...tender.payload, amount, fee })
        // `confirmed`: this popup is that confirmation -- what is being collected and for
        // how much, read before Confirm & Collect is pressed.
        : await collectPackagePayment(row.lead_id, { ...tender.payload, amount, confirmed: true });
      onCollected && onCollected({
        // In the ledger's own shape, so the receipt is built the way a reissued one is.
        transaction_id: res.transaction_id || "",
        date: new Date().toISOString(),
        client_name: row.client_name,
        phone: row.phone,
        branch_name: row.branch_name,
        source: isInstalment ? SOURCE_OF_FEE[fee] || "session" : "consultation",
        gross: amount,
        payment_mode: tender.payload.payment_mode,
        collected_by: loadSession()?.user?.full_name || "",
        instalment_number: isInstalment ? row.next_installment_number : null,
        balance_after: Math.max(Math.round(((Number(row.balance) || 0) - amount) * 100) / 100, 0),
      });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not collect the payment");
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      data-testid="schedule-collect-dialog"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="schedule-collect-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            <p id="schedule-collect-title" className="text-base font-semibold">Collect Payment</p>
          </div>
          <button type="button" onClick={() => !saving && onClose()} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" aria-label="Close" data-testid="schedule-collect-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">{title}</p>
            <p className="mt-0.5 text-2xl font-bold text-emerald-800" data-testid="schedule-collect-amount">{fmt(amount)}</p>
            <p className="mt-0.5 text-xs text-emerald-900/80">
              {row.client_name}
              {row.due_date ? ` · due ${row.due_date}` : ""}
              {Number(row.balance) > amount ? ` · ${fmt(Number(row.balance) - amount)} still owed after this` : ""}
            </p>
          </div>
          {!isInstalment && (
            <p className="text-[11px] text-slate-500">
              Collected in full. For a discount or a part payment, collect it from the client&apos;s card in Consultations.
            </p>
          )}
          <div className="space-y-3">
            <TenderFields draft={draft} setDraft={setD} testid="schedule-collect" />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button" onClick={onClose} disabled={saving}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-50"
            data-testid="schedule-collect-cancel"
          >
            Cancel
          </button>
          <button
            type="button" onClick={submit} disabled={saving}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            data-testid="schedule-collect-confirm"
          >
            {saving ? "Collecting..." : "Confirm & Collect"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ScheduleCollectDialog;
