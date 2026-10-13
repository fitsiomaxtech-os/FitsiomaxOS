import { useEffect, useState } from "react";
import { ArrowLeftRight, Search, X, ReceiptText, Building2, ChevronDown, Check, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  getBranchBoard, getBranches, getLeadTransferEligibility, transferLeadBranch,
} from "@/lib/api";
// The calendar's own dialog shell — cream card, soft border, blurred ground. Exported by
// that file precisely so a control standing beside a calendar wears the same clothes
// instead of a second copy of them drifting away from it.
import { CenteredPicker } from "@/components/ui/milk-calendar";
import { displayPhone } from "@/lib/phone";

// Rs.1200 rather than Rs.1200.00 when the paise are zero, which they are for almost every
// collection — the history is a column of amounts and two dead digits on each of them is
// two digits of noise between the reader and the number that is actually different.
const money = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? `Rs.${v}` : `Rs.${v.toFixed(2)}`;
};

// The date alone. A receipt is looked up by the day it was issued, and a time to the second
// only makes the rows harder to scan against a patient's own paperwork.
const onDay = (iso) => (iso ? String(iso).slice(0, 10) : "—");

const MODE_LABELS = {
  cash: "Cash", upi: "UPI", card: "Card", cheque: "Cheque",
  account_transfer: "Bank transfer", unknown: "",
};

/**
 * What this patient has paid, itemised, against the branch that took each payment.
 *
 * Read before a transfer rather than after it. The impact panel above says how much stays
 * behind as one figure, and a single figure is exactly what gets disputed a week later —
 * this is the same money as a list of receipts, so the branch losing it can see which rows
 * are theirs and the branch gaining the patient can see what was already settled.
 *
 * A row attributed to some other branch is not an error: it is a payment taken before an
 * earlier transfer, and it stays with whoever collected it.
 */
export const PaymentHistory = ({ rows, currentBranchName }) => {
  const [open, setOpen] = useState(false);
  const list = rows || [];
  const total = list.reduce((sum, r) => sum + Number(r.amount || 0), 0);

  return (
    <div className="mt-3 rounded-xl border border-[#EFEAE0] bg-white/60" data-testid="branch-transfer-payments">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        data-testid="branch-transfer-payments-toggle"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <ReceiptText className="h-3.5 w-3.5 text-slate-400" />
          Payment history
          <span className="rounded-full bg-[#F3EFE6] px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
            {list.length}
          </span>
        </span>
        <span className="text-xs text-slate-500">
          {money(total)} total <span className="text-slate-400">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        list.length === 0 ? (
          <p className="border-t border-[#EFEAE0] px-3 py-3 text-xs text-slate-400" data-testid="branch-transfer-payments-empty">
            This patient has not paid anything yet, so the move leaves no money behind.
          </p>
        ) : (
          <div className="max-h-52 overflow-y-auto border-t border-[#EFEAE0]" data-testid="branch-transfer-payments-list">
            {list.map((p) => {
              // Only flagged when it is genuinely somebody else's, so the common case —
              // every receipt belonging to the branch on screen — stays unmarked.
              const elsewhere = p.branch_name && p.branch_name !== currentBranchName;
              return (
                <div
                  key={p.id || `${p.collected_at}-${p.label}`}
                  className="flex items-start justify-between gap-3 border-b border-[#EFEAE0]/60 px-3 py-2 last:border-b-0"
                  data-testid={`branch-transfer-payment-${p.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-slate-800">
                      {p.label}
                      {MODE_LABELS[p.payment_mode] ? (
                        <span className="ml-1.5 font-normal text-slate-400">via {MODE_LABELS[p.payment_mode]}</span>
                      ) : null}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {onDay(p.collected_at)}
                      {p.collected_by ? ` · ${p.collected_by}` : ""}
                      {p.transaction_id ? ` · ${p.transaction_id}` : ""}
                    </p>
                    {elsewhere && (
                      <p className="text-[10px] font-medium text-amber-600">
                        collected at {p.branch_name} — stays in that branch's book
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-slate-800">{money(p.amount)}</span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
};

/**
 * What the move does, read before it is made rather than in the toast after. Shared by
 * both transfer dialogs so the Branch Admin's popup and Super Admin's desk warn about the
 * same things in the same words.
 */
export const TransferImpact = ({ eligibility, fromBranchName, testid = "branch-transfer-impact" }) => {
  const e = eligibility || {};
  const booking = e.consultation_booking;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid={testid}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">What this move does</p>
      <ul className="mt-1.5 space-y-1 text-xs text-amber-800">
        <li>
          <b>{money(e.revenue_staying_behind)}</b> already collected stays in {fromBranchName || "this branch"}'s book.
          Anything collected from here on belongs to the new branch.
        </li>
        {Number(e.balance_to_collect) > 0 && (
          <li><b>{money(e.balance_to_collect)}</b> still to be paid. The new branch collects it.</li>
        )}
        {booking && (
          <li>
            The consultation booked for <b>{booking.appointment_date} {booking.appointment_time}</b>
            {booking.doctor_name ? ` with ${booking.doctor_name}` : ""} is released. The new branch books it again.
          </li>
        )}
        {e.sessions_to_release > 0 && (
          <li>
            <b>{e.sessions_to_release}</b> booked treatment day{e.sessions_to_release === 1 ? "" : "s"}
            {e.current_physio_name ? ` with ${e.current_physio_name}` : ""} will be released. The new branch books them again there.
          </li>
        )}
        {e.sessions_completed > 0 && (
          <li><b>{e.sessions_completed}</b> completed day{e.sessions_completed === 1 ? "" : "s"} stay on the record and still count toward the course.</li>
        )}
        <li>The Patient Number stays <b>{e.patient_number || "—"}</b>, so receipts already issued still find them.</li>
      </ul>
    </div>
  );
};

/** The reason, required — both branches read it on the Branch Transfer Record. */
export const TransferReason = ({ value, onChange, testid = "branch-transfer-reason" }) => (
  <>
    <label className="mt-3 block text-xs font-semibold text-slate-600" htmlFor={testid}>
      Reason <span className="text-rose-500">*</span>
      <span className="ml-1 font-normal text-slate-400">(shown to both branches)</span>
    </label>
    <textarea
      id={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      placeholder="e.g. Patient lives near T Nagar and finds Anna Nagar too far"
      className="mt-1 w-full resize-none rounded-lg border border-[#EFEAE0] bg-white/60 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
      data-testid={testid}
    />
  </>
);

// Same helper OperationsBoard.jsx, BranchManagementBoard.jsx and PreSalesCRM.jsx each
// already carry their own copy of.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// The order every other branch list in the OS uses: offline branches first, alphabetical,
// with the online arms trailing among themselves. The native dropdown listed them in
// whatever order the API answered, which put Online Fitness above T Nagar — not how anyone
// choosing a branch thinks about them.
const sortBranches = (list) => [...(list || [])].sort((a, b) => {
  const onlineDiff = Number(isOnlineVertical(a.vertical)) - Number(isOnlineVertical(b.vertical));
  if (onlineDiff !== 0) return onlineDiff;
  return (a.branch_name || "").localeCompare(b.branch_name || "");
});

/**
 * Where the patient is going, picked from a dialog rather than a native <select>.
 *
 * The browser's dropdown is unstyleable — its chrome, its blue highlight, its typography
 * are the operating system's and not this one's, which is the same reason the date fields
 * stopped using `<input type="date">`. Inside a popup it was worse than plain: a white
 * system menu opened over a white card with a blue bar across it, and the one irreversible
 * choice on the screen was the only control that did not look like it belonged.
 *
 * So it borrows the calendar's clothes outright — CenteredPicker's cream card, the same
 * #F3EFE6 hover the day cells use, the same rounded rows — and takes the dialog's indigo
 * for the chosen one, since that is already the accent on the button this leads to.
 */
const BranchChoice = ({ branches, value, onChange, testid = "branch-choice" }) => {
  const [open, setOpen] = useState(false);
  const list = sortBranches(branches);
  const chosen = list.find((b) => b.id === value);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-sm"
        data-testid={testid}
      >
        <span className={`flex min-w-0 items-center gap-2 ${chosen ? "text-slate-800" : "text-muted-foreground"}`}>
          {chosen && (isOnlineVertical(chosen.vertical)
            ? <Globe className="h-4 w-4 shrink-0 text-slate-400" />
            : <Building2 className="h-4 w-4 shrink-0 text-slate-400" />)}
          <span className="truncate">{chosen ? chosen.branch_name : "Choose a branch…"}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      {open && (
        <CenteredPicker title="Transfer to" onClose={() => setOpen(false)} testid={`${testid}-modal`}>
          {list.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-slate-400">
              There is no other branch to transfer to yet.
            </p>
          ) : (
            <div className="space-y-0.5" data-testid={`${testid}-list`}>
              {list.map((b) => {
                const selected = b.id === value;
                const online = isOnlineVertical(b.vertical);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => { onChange(b.id); setOpen(false); }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold transition ${
                      selected ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-[#F3EFE6]"
                    }`}
                    data-testid={`${testid}-option-${b.id}`}
                  >
                    {online
                      ? <Globe className={`h-4 w-4 shrink-0 ${selected ? "text-white/80" : "text-slate-400"}`} />
                      : <Building2 className={`h-4 w-4 shrink-0 ${selected ? "text-white/80" : "text-slate-400"}`} />}
                    <span className="min-w-0 flex-1 truncate">{b.branch_name}</span>
                    {/* Named rather than only drawn: an online arm is not a place the
                        patient travels to, and the difference decides whether a transfer
                        makes sense at all. */}
                    {online && (
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        selected ? "bg-white/20 text-white" : "bg-[#F3EFE6] text-slate-500"
                      }`}>
                        Online
                      </span>
                    )}
                    {selected && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </CenteredPicker>
      )}
    </>
  );
};

/**
 * Branch Transfer — moving one patient from the branch on screen to another.
 *
 * Any stage. Money already collected stays with this branch, whatever the old branch's
 * staff were holding (a booked consultation, treatment days, the physio) is released, and a
 * reason is required because both branches read it on the record.
 *
 * The dialog is deliberately slow at the last step. A transfer releases booked treatment
 * days and moves a patient off the board their branch admin is working, so the eligible
 * list is only the first half of it — picking someone loads what the move would actually
 * cost, and the button that does it says the cost out loud.
 *
 * Opened from Operations (Super Admin, for any branch) and from a branch's own board (its
 * Branch Admin, for their branch only). Same dialog either way: the backend decides who may
 * move whom, and a second copy of this screen for the branch case is how the two would come
 * to warn about different things. `branches` is a prop where the caller already has the
 * list and fetched here where it does not.
 */
export const BranchTransferDialog = ({ branches: branchesProp, fromBranchId, onClose, onTransferred }) => {
  const [leads, setLeads] = useState(null);
  const [branches, setBranches] = useState(branchesProp || null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(null);
  const [eligibility, setEligibility] = useState(null);
  const [toBranchId, setToBranchId] = useState("");
  const [reason, setReason] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [done, setDone] = useState(null);

  const fromBranch = (branches || []).find((b) => b.id === fromBranchId);

  useEffect(() => {
    if (branchesProp) { setBranches(branchesProp); return; }
    let cancelled = false;
    getBranches()
      .then((d) => { if (!cancelled) setBranches(d || []); })
      .catch(() => { if (!cancelled) setBranches([]); });
    return () => { cancelled = true; };
  }, [branchesProp]);

  useEffect(() => {
    let cancelled = false;
    getBranchBoard(fromBranchId)
      .then((d) => { if (!cancelled) setLeads(d?.leads || []); })
      .catch(() => { if (!cancelled) setLeads([]); });
    return () => { cancelled = true; };
  }, [fromBranchId]);

  // Every patient at the branch: a transfer is allowed at any stage.
  const transferable = leads || [];
  const q = search.trim().toLowerCase();
  const shown = q
    ? transferable.filter((l) => `${l.name || ""} ${l.phone || ""} ${l.patient_number || ""}`.toLowerCase().includes(q))
    : transferable;

  const pick = (lead) => {
    setPicked(lead);
    setEligibility(null);
    setToBranchId("");
    setReason("");
    getLeadTransferEligibility(lead.id).then(setEligibility).catch(() => setEligibility(null));
  };

  const submit = async () => {
    if (!toBranchId) { toast.error("Pick the branch to transfer to"); return; }
    if (!reason.trim()) { toast.error("Give a reason for the transfer"); return; }
    setTransferring(true);
    try {
      const res = await transferLeadBranch(picked.id, { to_branch_id: toBranchId, reason: reason.trim() });
      setDone({ ...res, name: picked.name });
      toast.success(res.message);
      // The list this came from is now one patient shorter. Refetched rather than spliced
      // so a second transfer in the same sitting reads the board as it now stands.
      getBranchBoard(fromBranchId).then((d) => setLeads(d?.leads || [])).catch(() => {});
      // The board behind this dialog is showing a patient who has just left it.
      onTransferred && onTransferred();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Transfer failed");
    }
    setTransferring(false);
  };

  const destinations = (branches || []).filter((b) => b.id !== fromBranchId);
  const toBranch = destinations.find((b) => b.id === toBranchId);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" data-testid="ops-branch-transfer-dialog">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-[#EFEAE0] bg-[#FDFCF8] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#EFEAE0] px-5 py-3">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold">
            <ArrowLeftRight className="h-4 w-4 text-indigo-600" />
            Branch Transfer
            {fromBranch && <span className="text-sm font-normal text-slate-500">from {fromBranch.branch_name}</span>}
          </h3>
          <button onClick={onClose} className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600" data-testid="ops-branch-transfer-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-5">
          {done ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4" data-testid="ops-branch-transfer-done">
              <p className="text-sm font-semibold text-emerald-800">{done.name} — {done.message}</p>
              <ul className="mt-2 space-y-1 text-xs text-emerald-700">
                {done.sessions_released > 0 && (
                  <li>{done.sessions_released} booked treatment day{done.sessions_released === 1 ? "" : "s"} released — the new branch books the rest.</li>
                )}
                {done.sessions_kept > 0 && (
                  <li>{done.sessions_kept} completed day{done.sessions_kept === 1 ? "" : "s"} stay on the record, with the physio who ran them.</li>
                )}
                {done.consultation_released && <li>The booked consultation was released — the new branch books it again.</li>}
                <li>{money(done.revenue_left_behind)} stays in {fromBranch?.branch_name || "this branch"}'s book.</li>
                {Number(done.balance_to_collect) > 0 && (
                  <li>{money(done.balance_to_collect)} still to be paid — the new branch collects it.</li>
                )}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { setDone(null); setPicked(null); setEligibility(null); }} data-testid="ops-branch-transfer-again">
                  Transfer another
                </Button>
                <Button size="sm" onClick={onClose} data-testid="ops-branch-transfer-finish">Done</Button>
              </div>
            </div>
          ) : !picked ? (
            <>
              <p className="text-xs leading-relaxed text-slate-500">
                A patient can be transferred at any stage. What they have already paid stays with
                this branch; anything booked here is released for the new branch to book again.
              </p>
              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, phone or patient number"
                  className="h-9 w-full rounded-lg border border-[#EFEAE0] bg-white/60 pl-8 pr-3 text-sm outline-none focus:border-indigo-400"
                  data-testid="ops-branch-transfer-search"
                />
              </div>
              {leads === null ? (
                <p className="py-8 text-center text-sm text-slate-400">Loading this branch's patients…</p>
              ) : shown.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400" data-testid="ops-branch-transfer-empty">
                  {transferable.length === 0
                    ? "Nobody at this branch is in a transferable state right now."
                    : "No patient here matches that search."}
                </p>
              ) : (
                <div className="mt-3 space-y-1.5" data-testid="ops-branch-transfer-list">
                  {shown.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => pick(l)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-[#EFEAE0] bg-white/60 p-2.5 text-left transition hover:border-indigo-300 hover:bg-[#F3EFE6]"
                      data-testid={`ops-branch-transfer-lead-${l.id}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">{l.name || "—"}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          {l.patient_number || displayPhone(l.phone) || "—"}
                          {l.consultation_stage === "Physio Assign" && l.assigned_physio_name ? ` · with ${l.assigned_physio_name}` : ""}
                        </p>
                      </div>
                      <span className={`max-w-[10rem] shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        l.consultation_stage === "Physio Assign" ? "bg-violet-100 text-violet-700" : "bg-[#F3EFE6] text-slate-600"
                      }`}>
                        {l.consultation_stage === "Physio Assign" ? "In treatment" : (l.consultation_stage || l.branch_stage || "Lead")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <button
                onClick={() => { setPicked(null); setEligibility(null); }}
                className="text-xs font-medium text-indigo-600 hover:underline"
                data-testid="ops-branch-transfer-back"
              >
                ← Back to the list
              </button>
              <p className="mt-2 text-base font-semibold text-slate-800">{picked.name || "—"}</p>
              <p className="text-xs text-slate-500">{picked.patient_number || displayPhone(picked.phone) || "—"}</p>

              {!eligibility ? (
                <p className="py-6 text-center text-sm text-slate-400">Checking what this move would cost…</p>
              ) : !eligibility.can_transfer ? (
                <>
                  <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-relaxed text-rose-700" data-testid="ops-branch-transfer-blocked">
                    {eligibility.blocked_reason}
                  </p>
                  {/* Shown even when the move is refused. "Why can't I move them" and "what
                      have they paid" are the same question asked twice, and the answer is
                      as useful to the branch that has to wait as to the one that may go. */}
                  <PaymentHistory rows={eligibility.payment_history} currentBranchName={fromBranch?.branch_name} />
                </>
              ) : (
                <>
                  <TransferImpact eligibility={eligibility} fromBranchName={fromBranch?.branch_name} testid="ops-branch-transfer-impact" />

                  {/* The figure above, itemised. Collapsed by default: most transfers are of
                      a lead who has paid nothing, and the count in the header already says
                      so without costing a click. */}
                  <PaymentHistory rows={eligibility.payment_history} currentBranchName={fromBranch?.branch_name} />

                  {eligibility.transfers_so_far > 0 && (
                    <p className="mt-2 text-[11px] text-slate-500" data-testid="ops-branch-transfer-prior">
                      This patient has been transferred {eligibility.transfers_so_far} time{eligibility.transfers_so_far === 1 ? "" : "s"} before.
                    </p>
                  )}

                  <label className="mt-3 block text-xs font-semibold text-slate-600">Transfer to</label>
                  <div className="mt-1">
                    <BranchChoice
                      branches={destinations}
                      value={toBranchId}
                      onChange={setToBranchId}
                      testid="ops-branch-transfer-destination"
                    />
                  </div>

                  <TransferReason value={reason} onChange={setReason} testid="ops-branch-transfer-reason" />

                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} data-testid="ops-branch-transfer-cancel">Cancel</Button>
                    <Button
                      className="bg-indigo-600 text-white hover:bg-indigo-700"
                      disabled={!toBranchId || !reason.trim() || transferring}
                      onClick={submit}
                      data-testid="ops-branch-transfer-submit"
                    >
                      {transferring
                        ? "Transferring…"
                        : toBranch
                          ? `Transfer to ${toBranch.branch_name}`
                          : "Transfer"}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BranchTransferDialog;
