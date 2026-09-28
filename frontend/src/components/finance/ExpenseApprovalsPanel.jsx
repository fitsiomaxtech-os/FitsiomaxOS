import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Coins, Eye, Receipt, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getFinanceExpenses, approveFinanceExpense, rejectFinanceExpense, deleteFinanceExpense } from "@/lib/api";
import { notesLabel } from "@/lib/denominations";

const fmt = (n) => `Rs.${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const MODE_LABELS = {
  cash: "Cash", upi: "UPI", card: "Card", account_transfer: "Bank Transfer", cheque: "Cheque",
};

/**
 * Whether the sentence the branch typed is the only thing there is to approve this
 * against.
 *
 * Cash with no reference on it: no invoice, no transfer to look up, nobody else's record
 * of the payment. This used to be read off `petty_cash`, which is the tin's own test and
 * stops at Rs.1,000 — so a Rs.5,000 cash payment out of a branch drawer, which has no
 * more paperwork behind it than a Rs.200 one, had its reason run in with the date and the
 * branch on a line that clips. The bigger the cash payment, the more that sentence is
 * worth reading before initialling it.
 */
const reasonIsTheOnlyEvidence = (exp) =>
  (exp.payment_mode || "").trim().toLowerCase() === "cash" && !(exp.reference || "").trim();

/**
 * What the branches have asked to spend, for the person who signs it off.
 *
 * The same two questions the income side of this tab asks — what is waiting, and what has
 * been settled — about money going the other way. Kept as its own panel rather than folded
 * into the transactions list beside it: an expense is not a collection with a minus on it.
 * It carries who it was paid to and what for, it is approved against a bill rather than
 * against a patient, and the filters that matter on the income side (which fee, which
 * patient) mean nothing here.
 *
 * Every filter comes from the block above the ledger switch, which asks them once for both
 * sides of this tab: a day's collections and a day's spending are the same day, and the
 * two would not stay together if each side kept its own window. This panel used to keep a
 * branch select of its own, which meant the tab could be looking at one branch's income
 * beside another branch's expenses — two answers to a question the reader asked once.
 */
const Detail = ({ label, children }) => (
  <div className="min-w-0">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <div className="break-words text-sm text-slate-800">{children || "—"}</div>
  </div>
);

/** Everything the expense was raised with, read before it is signed off. */
const ExpenseDetailModal = ({ exp, deciding, onDecide, onClose }) => {
  const notes = notesLabel(exp.cash_denominations);
  const status = exp.rejected ? "Rejected" : exp.approved ? "Approved" : "Pending approval";
  const tone = exp.rejected ? "bg-rose-50 text-rose-700" : exp.approved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700";
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="finance-expense-detail"
    >
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-800">Expense Details</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-2xl font-bold text-slate-800" data-testid="finance-expense-detail-amount">{fmt(exp.amount)}</p>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Detail label="Name">{exp.paid_to}</Detail>
            <Detail label="Vendor / Category">{exp.vendor_name || exp.category}</Detail>
            <Detail label="Branch">{exp.branch_name}</Detail>
            <Detail label="Spent on">{exp.expense_date}</Detail>
            <Detail label="Payment mode">{MODE_LABELS[exp.payment_mode] || exp.payment_mode}</Detail>
            <Detail label="Bill / reference no.">{exp.reference}</Detail>
            {notes ? (
              <div className="col-span-2">
                <Detail label="Denominations">
                  {notes}{Number(exp.cash_coins) > 0 ? ` + Rs.${exp.cash_coins} coins` : ""}
                </Detail>
              </div>
            ) : null}
            <div className="col-span-2">
              <Detail label="What it was spent on">{exp.note}</Detail>
            </div>
            <Detail label="Raised by">{exp.created_by}</Detail>
            <Detail label="Raised at">{(exp.created_at || "").slice(0, 16).replace("T", " ")}</Detail>
            {exp.approved && exp.approved_by ? <Detail label="Approved by">{exp.approved_by}</Detail> : null}
            {exp.rejected && exp.rejection_reason ? (
              <div className="col-span-2"><Detail label="Rejected because">{exp.rejection_reason}</Detail></div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {!exp.approved && (
            <>
              <Button
                variant="outline"
                className="border-rose-200 text-rose-700 hover:bg-rose-50"
                disabled={deciding}
                onClick={() => onDecide(exp, false)}
                data-testid="finance-expense-detail-reject"
              >
                Reject
              </Button>
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={deciding}
                onClick={() => onDecide(exp, true)}
                data-testid="finance-expense-detail-approve"
              >
                <Check className="mr-1 h-4 w-4" /> Approve
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The step between clicking Approve and the expense being approved. Says what is about to
 * be signed off -- the figure, who it went to, what for -- so a click on the wrong row is
 * caught here rather than undone afterwards. Above Expense Details, which can open it.
 */
const ConfirmApproveModal = ({ exp, saving, onConfirm, onClose }) => (
  <div
    className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
    onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    data-testid="finance-expense-confirm"
  >
    <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h3 className="text-base font-semibold text-slate-800">Confirm Approval</h3>
        <button type="button" onClick={onClose} disabled={saving} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3 p-5">
        <p className="text-sm text-slate-600">Approve this expense?</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <Detail label="Expense">{exp.category}</Detail>
          <Detail label="Amount"><span className="font-bold text-rose-600">{fmt(exp.amount)}</span></Detail>
          <Detail label="Paid to">{exp.paid_to}</Detail>
          <Detail label="Branch">{exp.branch_name}</Detail>
          <Detail label="Payment mode">{MODE_LABELS[exp.payment_mode] || exp.payment_mode}</Detail>
          <Detail label="Spent on">{exp.expense_date}</Detail>
          <Detail label="Raised by">{exp.created_by}</Detail>
          <Detail label="Bill / reference no.">{exp.reference}</Detail>
          {exp.note ? <div className="col-span-2"><Detail label="What it was spent on">{exp.note}</Detail></div> : null}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
        <Button variant="outline" onClick={onClose} disabled={saving} data-testid="finance-expense-confirm-cancel">Cancel</Button>
        <Button
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={onConfirm}
          disabled={saving}
          data-testid="finance-expense-confirm-approve"
        >
          <Check className="mr-1 h-4 w-4" /> {saving ? "Approving…" : "Confirm"}
        </Button>
      </div>
    </div>
  </div>
);

export const ExpenseApprovalsPanel = ({
  onChanged = () => {},
  branchId = "",
  mode = "all",
  startDate = "",
  endDate = "",
}) => {
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ approved_total: 0, approved_count: 0, pending_total: 0, pending_count: 0, rejected_total: 0, rejected_count: 0 });
  const [view, setView] = useState("pending"); // "pending" | "approved" | "rejected"
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(null);
  const [viewing, setViewing] = useState(null); // the expense open in Expense Details
  const [confirming, setConfirming] = useState(null); // the expense waiting on "Yes, approve"
  // Switched on and off in Developer Access; the list says which.
  const [deleteEnabled, setDeleteEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (branchId) params.branch_id = branchId;
      if (mode && mode !== "all") params.mode = mode;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      const data = await getFinanceExpenses(params);
      setRows(data.expenses || []);
      setDeleteEnabled(!!data.delete_enabled);
      setTotals({
        approved_total: data.approved_total || 0,
        approved_count: data.approved_count || 0,
        pending_total: data.pending_total || 0,
        pending_count: data.pending_count || 0,
        rejected_total: data.rejected_total || 0,
        rejected_count: data.rejected_count || 0,
      });
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, mode, startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  // Three piles, matching the three cards: waiting, signed off, turned down. Rejected used
  // to sit in with pending, so the pending list showed rows its own card did not count.
  const visible = useMemo(
    () => rows.filter((r) => {
      if (view === "approved") return r.approved;
      if (view === "rejected") return !r.approved && r.rejected;
      return !r.approved && !r.rejected;
    }),
    [rows, view],
  );

  // Approve never goes through on the first click, from the row or from Expense Details:
  // it opens the confirm popup, and only that popup's own button sends it.
  const decide = async (exp, approve, confirmed = false) => {
    if (approve && !confirmed) { setConfirming(exp); return; }
    let reason = "";
    if (!approve) {
      reason = window.prompt(`Why is this ${exp.category} expense of ${fmt(exp.amount)} being turned down?`) || "";
      if (!reason.trim()) return;
    }
    setDeciding(exp.id);
    try {
      if (approve) await approveFinanceExpense(exp.id);
      else await rejectFinanceExpense(exp.id, reason.trim());
      toast.success(approve ? "Approved" : "Rejected");
      setViewing(null);
      setConfirming(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save that");
    } finally {
      setDeciding(null);
    }
  };

  const remove = async (exp) => {
    if (!window.confirm(`Delete this ${exp.category} expense of ${fmt(exp.amount)}? It cannot be undone.`)) return;
    setDeciding(exp.id);
    try {
      await deleteFinanceExpense(exp.id);
      toast.success("Expense deleted");
      setViewing(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete that");
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="finance-expense-approvals">
      {/* The income side's two cards plus a third for what was turned down -- and, as
          there, they are the switch: the toggle that used to sit under them only repeated
          their headings in a smaller font. */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { key: "pending", label: "Pending Approval", total: totals.pending_total, count: totals.pending_count, noun: ["request", "requests"], ring: "#d97706", border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-700", sub: "text-amber-600" },
          { key: "approved", label: "Approved", total: totals.approved_total, count: totals.approved_count, noun: ["expense", "expenses"], ring: "#059669", border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-700", sub: "text-emerald-600" },
          { key: "rejected", label: "Rejected", total: totals.rejected_total, count: totals.rejected_count, noun: ["expense", "expenses"], ring: "#e11d48", border: "border-rose-200", bg: "bg-rose-50/60", text: "text-rose-700", sub: "text-rose-600" },
        ].map((c) => {
          const on = view === c.key;
          // Summary's ledger cards: tinted, 2px corners, the picked one outlined in its own
          // colour and the others stepping back to 70%.
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setView(c.key)}
              aria-pressed={on}
              className={`rounded-[2px] border ${c.border} ${c.bg} p-4 text-left transition ${on ? "" : "opacity-70 hover:opacity-100"}`}
              style={on ? { borderColor: c.ring } : undefined}
              data-testid={`finance-expense-approvals-${c.key}-card`}
            >
              <p className={`text-[11px] font-bold uppercase tracking-wider ${c.text}`}>{c.label}</p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${c.text}`}>{fmt(c.total)}</p>
              <p className={`text-[11px] ${c.sub}`}>{c.count} {c.count === 1 ? c.noun[0] : c.noun[1]}</p>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow">
        <div className="divide-y divide-slate-50">
          {loading ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center" data-testid="finance-expense-approvals-empty">
              <Receipt className="mx-auto mb-2 h-8 w-8 text-slate-200" />
              <p className="text-xs text-slate-400">
                {view === "pending" ? "Nothing waiting on approval." : view === "rejected" ? "Nothing rejected." : "Nothing approved yet."}
              </p>
            </div>
          ) : (
            /* A table, the same shape HR Admin's candidate list has: a header naming the
               columns, a row per expense, the actions at the end and the arrow that opens
               it. The whole row opens Expense Details; the buttons act without opening. */
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm" data-testid="finance-expense-approvals-table">
                <thead className="bg-slate-500 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Expense</th>
                    <th className="px-4 py-2.5 font-semibold">Branch</th>
                    <th className="px-4 py-2.5 font-semibold">Payment</th>
                    <th className="px-4 py-2.5 font-semibold">Spent On</th>
                    <th className="px-4 py-2.5 font-semibold">Raised By</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    <th className="px-4 py-2.5" />
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((exp) => (
                    <tr
                      key={exp.id}
                      onClick={() => setViewing(exp)}
                      className="cursor-pointer hover:bg-slate-50"
                      data-testid={`finance-expense-approvals-row-${exp.id}`}
                    >
                      <td className="max-w-[280px] px-4 py-3">
                        <p className="flex items-center gap-2 font-medium text-slate-800">
                          <span className="truncate">{exp.category}</span>
                          {exp.petty_cash ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700" data-testid={`finance-expense-approvals-petty-${exp.id}`}>
                              <Coins className="h-2.5 w-2.5" /> Petty cash
                            </span>
                          ) : null}
                        </p>
                        {exp.paid_to ? <p className="truncate text-[11px] text-slate-400">to {exp.paid_to}</p> : null}
                        {/* The branch's sentence, in full when it is the only thing to
                            approve against -- see reasonIsTheOnlyEvidence. */}
                        {exp.note ? (
                          <p
                            className={reasonIsTheOnlyEvidence(exp) ? "break-words text-[11px] font-medium text-slate-700" : "truncate text-[11px] text-slate-400"}
                            title={exp.note}
                            data-testid={`finance-expense-approvals-reason-${exp.id}`}
                          >
                            “{exp.note}”
                          </p>
                        ) : null}
                        {exp.rejected && exp.rejection_reason ? (
                          <p className="truncate text-[11px] text-rose-600">Rejected — {exp.rejection_reason}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{exp.branch_name || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {MODE_LABELS[exp.payment_mode] || exp.payment_mode || "—"}
                        {exp.reference ? <span className="block truncate text-[11px] text-slate-400">{exp.reference}</span> : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{exp.expense_date || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {exp.created_by || "—"}
                        {exp.approved && exp.approved_by ? (
                          <span className="block text-[11px] text-slate-400">approved by {exp.approved_by}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-bold text-rose-600">{fmt(exp.amount)}</td>
                      {/* The click that acts on a row must not also open it. */}
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-sky-200 px-3 text-xs text-sky-700 hover:bg-sky-50"
                            onClick={() => setViewing(exp)}
                            data-testid={`finance-expense-approvals-view-${exp.id}`}
                          >
                            <Eye className="mr-1 h-3.5 w-3.5" /> View
                          </Button>
                          {!exp.approved && (
                            <>
                              <Button
                                size="sm"
                                className="h-8 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                                disabled={deciding === exp.id}
                                onClick={() => decide(exp, true)}
                                data-testid={`finance-expense-approvals-approve-${exp.id}`}
                              >
                                <Check className="mr-1 h-3.5 w-3.5" /> Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-rose-200 px-3 text-xs text-rose-700 hover:bg-rose-50"
                                disabled={deciding === exp.id}
                                onClick={() => decide(exp, false)}
                                data-testid={`finance-expense-approvals-reject-${exp.id}`}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                          {deleteEnabled && (
                            <button
                              type="button"
                              onClick={() => remove(exp)}
                              disabled={deciding === exp.id}
                              className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                              title="Delete this expense"
                              aria-label="Delete this expense"
                              data-testid={`finance-expense-approvals-delete-${exp.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right"><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {viewing && (
        <ExpenseDetailModal
          exp={viewing}
          deciding={deciding === viewing.id}
          onDecide={decide}
          onClose={() => setViewing(null)}
        />
      )}

      {confirming && (
        <ConfirmApproveModal
          exp={confirming}
          saving={deciding === confirming.id}
          onConfirm={() => decide(confirming, true, true)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
};

export default ExpenseApprovalsPanel;
