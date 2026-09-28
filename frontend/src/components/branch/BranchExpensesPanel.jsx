import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Coins, HandCoins, Plus, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  getBranches, getFinanceExpenses, createFinanceExpense,
  getBranchCash, createCashHandover, listCashHandovers, cancelCashHandover,
  listVendors, createVendor,
} from "@/lib/api";
import { DENOMINATIONS, noteTotal, countedNotes, noteBreakdown, notesLabel } from "@/lib/denominations";

const fmt = (n) => `Rs.${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Count a cash pile out by note. Optional — a busy desk records the figure alone — but a
 * count that is entered has to agree with the amount, the same rule every cash fee
 * follows. `amount` is what it is checked against; `onChange` gets { notes, coins,
 * counted }.
 */
const DenominationFields = ({ amount, notes, coins, onNotes, onCoins, testPrefix, required = false }) => {
  const counted = noteTotal(notes) + (Number(coins) || 0);
  const target = Number(amount) || 0;
  const diff = counted - target;
  const matches = target > 0 && Math.abs(diff) < 0.01;
  return (
    <div data-testid={`${testPrefix}-denominations`}>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{required ? "Denominations *" : "Denominations (optional)"}</label>
        <button
          type="button"
          onClick={() => { onNotes(noteBreakdown(target)); onCoins(""); }}
          disabled={!(target > 0)}
          className="text-[11px] font-semibold text-sky-600 hover:text-sky-700 disabled:text-slate-300"
          data-testid={`${testPrefix}-fill-notes`}
        >
          Fill to amount
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {DENOMINATIONS.map((d) => (
          <div key={d}>
            <label className="mb-0.5 block text-[10px] text-slate-500">Rs.{d}</label>
            <Input
              type="number"
              min="0"
              value={notes[d] ?? ""}
              onChange={(e) => onNotes({ ...notes, [d]: e.target.value })}
              className="h-9 tabular-nums"
              data-testid={`${testPrefix}-note-${d}`}
            />
          </div>
        ))}
      </div>
      <label className="mb-0.5 mt-2 block text-[10px] text-slate-500">Coins and change (Rs.)</label>
      <Input
        type="number"
        min="0"
        value={coins}
        onChange={(e) => onCoins(e.target.value)}
        className="h-9 tabular-nums"
        data-testid={`${testPrefix}-coins`}
      />
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-slate-500">Counted</span>
        <span className={`font-bold tabular-nums ${matches ? "text-emerald-600" : "text-slate-700"}`} data-testid={`${testPrefix}-counted`}>
          {fmt(counted)}
        </span>
      </div>
      {target > 0 && counted > 0 && Math.abs(diff) >= 0.01 && (
        <p className="mt-1 text-[11px] text-amber-700" data-testid={`${testPrefix}-count-mismatch`}>
          {diff > 0 ? `${fmt(diff)} more than the amount above.` : `${fmt(-diff)} short of the amount above.`}
        </p>
      )}
    </div>
  );
};

// For reading back old rows only — a branch expense logged before this screen was
// cash-only may carry any of these. The form no longer offers the choice.
const MODE_LABELS = {
  cash: "Cash", upi: "UPI", card: "Card", account_transfer: "Bank Transfer", cheque: "Cheque",
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * What a branch has asked to spend, and what has been signed off.
 *
 * The branch raises; the accountant decides. A Branch Admin cannot approve their own
 * spending — approval is somebody other than the person who spent it saying the money
 * went where the form says. So this screen has no approve button on it at all.
 *
 * A branch spends cash and only cash: it comes out of the same drawer the day's
 * collections go into, and the Cash in hand figure above the tabs is what is left in it.
 */
const StatusChip = ({ row }) => {
  if (row.rejected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700">
        <XCircle className="h-3 w-3" /> Rejected
      </span>
    );
  }
  if (row.approved) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
      <Clock className="h-3 w-3" /> Waiting on the accountant
    </span>
  );
};

/**
 * The branch whose drawer this is, asked for in the dialog when the board behind it is
 * not scoped to one.
 *
 * Both of these forms are statements about one branch's cash — the server refuses either
 * without a branch on it — and until this existed the buttons were simply disabled on
 * All Branches, which is where this desk usually sits. A disabled button is the screen
 * refusing to say what it wants; asking here is the same question, put where it can be
 * answered.
 */
const BranchPicker = ({ value, onChange, branches, testid }) => (
  <div>
    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Branch *</label>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
      data-testid={testid}
    >
      <option value="">Pick a branch…</option>
      {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
    </select>
    <p className="mt-1 text-[10px] text-slate-400">Whose drawer the cash comes out of.</p>
  </div>
);

/** One branch's drawer figure, for a dialog whose branch is picked inside it. The panel
    behind only holds the figure for a branch it was already scoped to, and an amount
    checked against nothing is a check that always passes. */
const usePickedBranchCash = (fixedBranchId, pickedBranchId, fallback) => {
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    if (fixedBranchId || !pickedBranchId) { setPicked(null); return undefined; }
    let alive = true;
    getBranchCash({ branch_id: pickedBranchId })
      .then((box) => { if (alive) setPicked(box?.cash_in_hand ?? null); })
      .catch(() => { if (alive) setPicked(null); });
    return () => { alive = false; };
  }, [fixedBranchId, pickedBranchId]);

  return fixedBranchId ? fallback : picked;
};

/** Vendor names compared the way the server links old expenses to them. */
const vendorKey = (name) => (name || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

export const AddExpenseDialog = ({ onClose, onSaved, cashInHand, branchId, branches, pastRows = [], initialVendorId = "" }) => {
  // No Category box: the vendor picked is what the expense is for, and one not from a
  // listed vendor is filed as Other. paid_to is the Name typed by hand.
  const [form, setForm] = useState({
    amount: "", expense_date: todayIso(),
    vendor_id: "", paid_to: "", reference: "", note: "",
  });
  // The Vendor book, for the Paid to picker. Switched-off vendors are left out, as they
  // are from Add Stock -- the server refuses an expense booked against one.
  const [vendors, setVendors] = useState([]);
  useEffect(() => {
    listVendors({ active_only: true }).then((v) => setVendors(v || [])).catch(() => setVendors([]));
  }, []);
  const [pickedBranch, setPickedBranch] = useState("");
  const [notes, setNotes] = useState({});
  const [coins, setCoins] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const spendingBranch = branchId || pickedBranch;
  const drawer = usePickedBranchCash(branchId, pickedBranch, cashInHand);
  const amountNum = Number(form.amount);
  const overDrawer = drawer != null && amountNum > 0 && amountNum > drawer;
  const counted = noteTotal(notes) + (Number(coins) || 0);
  const countEntered = counted > 0;

  // What this vendor has been paid before, old expenses included -- the list already
  // links a typed name to its vendor, so the history is there without a second fetch.
  const vendorHistory = useMemo(
    () => (form.vendor_id ? pastRows.filter((r) => r.vendor_id === form.vendor_id) : []),
    [pastRows, form.vendor_id],
  );

  // The + beside the picker: a vendor added here goes into the same Vendor list as
  // Records > Vendor Records, and is picked for this expense straight away.
  const [newVendor, setNewVendor] = useState(null); // { name, phone } while open
  const [addingVendor, setAddingVendor] = useState(false);
  const saveNewVendor = async () => {
    if (!newVendor?.name.trim()) { toast.error("Enter the vendor name"); return; }
    setAddingVendor(true);
    try {
      const v = await createVendor({ name: newVendor.name.trim(), phone: newVendor.phone.trim() });
      setVendors((list) => [...list, v].sort((a, b) => a.name.localeCompare(b.name)));
      setForm((f) => ({ ...f, vendor_id: v.id }));
      setNewVendor(null);
      toast.success(`${v.name} added`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add the vendor");
    } finally {
      setAddingVendor(false);
    }
  };

  const pickVendor = (id) => {
    const v = vendors.find((x) => x.id === id);
    setForm((f) => ({ ...f, vendor_id: v ? id : "" }));
  };

  // Opened from a vendor's View: pick them once the list has arrived.
  useEffect(() => {
    if (initialVendorId && vendors.some((v) => v.id === initialVendorId)) pickVendor(initialVendorId);
  }, [vendors]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!spendingBranch) { toast.error("Pick the branch whose drawer this cash came out of"); return; }
    if (!(amountNum > 0)) { toast.error("Enter how much was spent"); return; }
    if (!form.paid_to.trim()) { toast.error("Enter the name"); return; }
    // Every branch expense is cash out of the drawer, and cash leaves no invoice behind
    // it — this sentence is the whole of what the accountant approves it on.
    if (!form.note.trim()) { toast.error("Say what the cash was spent on"); return; }
    // Cash is counted out by note, always -- and the count has to come to the amount.
    if (!countEntered) { toast.error("Enter the denominations for the cash"); return; }
    if (Math.abs(counted - amountNum) >= 0.01) {
      toast.error("The notes counted do not add up to the amount");
      return;
    }
    setSaving(true);
    try {
      // A name typed by hand that is a listed vendor is booked against that vendor.
      const typedVendor = form.vendor_id ? null : vendors.find((v) => vendorKey(v.name) === vendorKey(form.paid_to));
      const vendor = vendors.find((v) => v.id === form.vendor_id) || typedVendor;
      await createFinanceExpense({
        ...form,
        category: vendor?.name || "Other",
        vendor_id: vendor?.id || undefined,
        amount: amountNum,
        // Whose drawer the notes came out of, and that they came out of a drawer at all.
        // Both are sent rather than left to the role: a Super Admin or Business Dev
        // standing on this screen is spending one branch's cash, and without these two
        // the server read their expense as head office's own — filed against no branch,
        // and approved the moment it was written instead of waiting on the accountant.
        branch_id: spendingBranch,
        from_branch_drawer: true,
        payment_mode: "cash",
        cash_denominations: countedNotes(notes) || {},
        cash_coins: Number(coins) || 0,
      });
      toast.success("Sent to the accountant for approval");
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="branch-expense-dialog"
    >
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Add Expense</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {!branchId && (
            <BranchPicker
              value={pickedBranch}
              onChange={setPickedBranch}
              branches={branches}
              testid="branch-expense-branch"
            />
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Name *</label>
              <Input
                value={form.paid_to}
                onChange={(e) => set("paid_to", e.target.value)}
                placeholder="Enter name"
                data-testid="branch-expense-paid-to"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Amount *</label>
              <Input
                type="number"
                min="0"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
                placeholder="0"
                data-testid="branch-expense-amount"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Vendor</label>
              <div className="flex gap-2">
                <select
                  value={form.vendor_id}
                  onChange={(e) => pickVendor(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                  data-testid="branch-expense-vendor"
                >
                  <option value="">-- not a listed vendor --</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => setNewVendor(newVendor ? null : { name: "", phone: "" })}
                  className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md border ${
                    newVendor ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                  title="Add vendor"
                  aria-label="Add vendor"
                  data-testid="branch-expense-vendor-add"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {newVendor && (
                <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-sky-200 bg-sky-50/50 p-2" data-testid="branch-expense-new-vendor">
                  <Input
                    value={newVendor.name}
                    onChange={(e) => setNewVendor((n) => ({ ...n, name: e.target.value }))}
                    placeholder="Vendor name *"
                    className="min-w-[140px] flex-1 bg-white"
                    autoFocus
                    data-testid="branch-expense-new-vendor-name"
                  />
                  <Input
                    value={newVendor.phone}
                    onChange={(e) => setNewVendor((n) => ({ ...n, phone: e.target.value }))}
                    placeholder="Phone"
                    className="w-32 bg-white"
                    data-testid="branch-expense-new-vendor-phone"
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-9 bg-sky-600 text-white hover:bg-sky-700"
                    disabled={addingVendor}
                    onClick={saveNewVendor}
                    data-testid="branch-expense-new-vendor-save"
                  >
                    {addingVendor ? "Adding…" : "Add"}
                  </Button>
                </div>
              )}
              {vendorHistory.length > 0 && (
                <p className="mt-1 text-[10px] text-slate-500" data-testid="branch-expense-vendor-history">
                  {`${vendorHistory.length} earlier expense${vendorHistory.length === 1 ? "" : "s"} · ${fmt(vendorHistory.reduce((t, r) => t + (Number(r.amount) || 0), 0))} · last ${fmt(vendorHistory[0].amount)} on ${vendorHistory[0].expense_date || "—"}`}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Spent on</label>
              <Input
                type="date"
                value={form.expense_date}
                onChange={(e) => set("expense_date", e.target.value)}
                data-testid="branch-expense-date"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bill / reference no.</label>
              <Input
                value={form.reference}
                onChange={(e) => set("reference", e.target.value)}
                placeholder="Optional"
                data-testid="branch-expense-reference"
              />
            </div>
          </div>

          <div
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${
              overDrawer ? "border-amber-200 bg-amber-50 text-amber-800" : "border-sky-200 bg-sky-50 text-sky-800"
            }`}
            data-testid="branch-expense-drawer-hint"
          >
            <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <b>Cash.</b> This comes out of the branch drawer.
              {drawer != null && (
                <>
                  {" "}It holds {fmt(drawer)} — {fmt(drawer - (amountNum > 0 ? amountNum : 0))} after this.
                  {overDrawer && " That is more than is in it; record it anyway if the money was spent."}
                </>
              )}
            </span>
          </div>

          <DenominationFields
            amount={form.amount}
            notes={notes}
            coins={coins}
            onNotes={setNotes}
            onCoins={setCoins}
            testPrefix="branch-expense"
            required
          />

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              What the cash was spent on *
            </label>
            <textarea
              rows={3}
              value={form.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder="Auto to the courier office, receipt kept in the drawer"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                form.note.trim() ? "border-slate-200 focus:border-sky-400" : "border-amber-300 focus:border-amber-400"
              }`}
              data-testid="branch-expense-note"
            />
            {!form.note.trim() && (
              <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700" data-testid="branch-expense-reason-missing">
                <AlertTriangle className="h-3 w-3" />
                Required
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-sky-600 text-white hover:bg-sky-700" disabled={saving} onClick={submit} data-testid="branch-expense-submit">
            {saving ? "Sending…" : "Send for approval"}
          </Button>
        </div>
      </div>
    </div>
  );
};

const HandoverDialog = ({ onClose, onSaved, cashInHand, branchId, branches }) => {
  const [form, setForm] = useState({ amount: "", handed_to: "", on: todayIso(), note: "" });
  const [pickedBranch, setPickedBranch] = useState("");
  const [notes, setNotes] = useState({});
  const [coins, setCoins] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const sendingBranch = branchId || pickedBranch;
  const drawer = usePickedBranchCash(branchId, pickedBranch, cashInHand);
  const amountNum = Number(form.amount);
  const overDrawer = drawer != null && amountNum > 0 && amountNum > drawer;
  const counted = noteTotal(notes) + (Number(coins) || 0);
  const countEntered = counted > 0;

  const submit = async () => {
    if (!sendingBranch) { toast.error("Pick the branch this cash is being sent from"); return; }
    if (!(amountNum > 0)) { toast.error("Enter how much is being handed over"); return; }
    if (!form.handed_to.trim()) { toast.error("Name who is carrying the cash"); return; }
    if (countEntered && Math.abs(counted - amountNum) >= 0.01) {
      toast.error("The notes counted do not add up to the amount");
      return;
    }
    setSaving(true);
    try {
      await createCashHandover({
        ...form,
        branch_id: sendingBranch,
        amount: amountNum,
        cash_denominations: countEntered ? (countedNotes(notes) || {}) : undefined,
        cash_coins: Number(coins) || 0,
      });
      toast.success("Cash handed over — waiting for the accountant to receive it");
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not record that handover");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="branch-handover-dialog"
    >
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Hand over cash</h3>
            <p className="text-[11px] text-slate-500">Settle the drawer to the person carrying it to the accountant.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {!branchId && (
            <BranchPicker
              value={pickedBranch}
              onChange={setPickedBranch}
              branches={branches}
              testid="branch-handover-branch"
            />
          )}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Amount *</label>
            <Input type="number" min="0" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0" data-testid="branch-handover-amount" />
            {drawer != null && (
              <p className={`mt-1 text-[10px] ${overDrawer ? "text-amber-700" : "text-slate-400"}`}>
                Drawer holds {fmt(drawer)}{overDrawer ? " — that is more than is in it" : ` — ${fmt(drawer - (amountNum > 0 ? amountNum : 0))} left after this`}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Handed to *</label>
            <Input value={form.handed_to} onChange={(e) => set("handed_to", e.target.value)} placeholder="Who is carrying it" data-testid="branch-handover-to" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</label>
            <Input type="date" value={form.on} onChange={(e) => set("on", e.target.value)} data-testid="branch-handover-date" />
          </div>
          <DenominationFields
            amount={form.amount}
            notes={notes}
            coins={coins}
            onNotes={setNotes}
            onCoins={setCoins}
            testPrefix="branch-handover"
          />
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Note</label>
            <Input value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="Optional" data-testid="branch-handover-note" />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={saving} onClick={submit} data-testid="branch-handover-submit">
            {saving ? "Recording…" : "Hand over"}
          </Button>
        </div>
      </div>
    </div>
  );
};


/**
 * One of the four piles this panel opens on, in the shape HR Admin's own stage cards
 * wear: white and bordered at rest, its own colour on the label and the figure, and the
 * colour pulled onto the border with a wash through the card when it is the one being
 * read. Money first and the count under it — the opposite way round to HR's, where a
 * count is the whole answer; here what was spent is the answer and how many rows it took
 * is the footnote.
 */
const SummaryCard = ({ label, color, amount, sub, active, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`min-w-0 rounded-xl border-2 px-3 py-3 text-left transition hover:shadow-sm ${
      active ? "shadow-sm" : "border-slate-200 bg-white"
    }`}
    style={active ? { borderColor: color, backgroundColor: `${color}14` } : undefined}
    data-testid={testid}
  >
    <span
      className="block break-words text-[10px] font-bold uppercase leading-[1.15] tracking-wider sm:truncate sm:text-[11px]"
      style={{ color }}
      title={label}
    >
      {label}
    </span>
    <span className="mt-1 block truncate text-lg font-extrabold leading-tight tabular-nums sm:text-xl" style={{ color }}>
      {amount}
    </span>
    <span className="mt-0.5 block truncate text-[10px] text-slate-400">{sub}</span>
  </button>
);

/** The wrapper every list on this panel sits in — HR Admin's list frame exactly: one
    rounded card, the header band in slate, rows divided rather than boxed. */
const ListFrame = ({ children, testid }) => (
  <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid={testid}>
    <div className="overflow-x-auto">{children}</div>
  </div>
);

const EmptyList = ({ children, testid }) => (
  <p
    className="rounded-xl border border-dashed border-slate-200 px-3 py-14 text-center text-sm text-slate-400"
    data-testid={testid}
  >
    {children}
  </p>
);

/**
 * Expenses as a list — the same list whichever pile is being read, because a request, a
 * signed-off expense and a rejected one are one record at three moments of its life, and
 * three differently shaped tables would say otherwise.
 *
 * Two renderings of it, as on HR Admin's own board: cards down a phone, where seven
 * columns cannot fit and a sideways scrollbar hides half of them, and the table from sm
 * up.
 *
 * @param showBranch  With no branch picked above, these rows are several branches' and
 *                    the row has to say whose. Scoped to one, it would be that branch's
 *                    name repeated down the screen.
 */
const VendorTag = () => (
  <span className="ml-1.5 inline-block rounded-full bg-sky-50 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase text-sky-700">
    Vendor
  </span>
);

const ExpenseList = ({ rows, loading, empty, showBranch, testid }) => {
  if (loading) return <EmptyList testid={`${testid}-loading`}>Loading…</EmptyList>;
  if (!rows.length) return <EmptyList testid="branch-expense-empty">{empty}</EmptyList>;

  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid={`${testid}-mobile`}>
        {rows.map((r) => (
          <div
            key={r.id}
            className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left"
            data-testid={`branch-expense-card-row-${r.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">{r.category}</p>
                <p className="truncate text-xs text-slate-500">
                  {r.paid_to || "Paid to not set"}
                  {r.vendor_id ? <VendorTag /> : null}
                </p>
              </div>
              <span className="shrink-0 text-sm font-bold tabular-nums text-slate-800">{fmt(r.amount)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>{r.expense_date || "—"}</span>
              {showBranch && r.branch_name ? <span>· {r.branch_name}</span> : null}
              {r.reference ? <span>· {r.reference}</span> : null}
            </div>
            <div className="mt-2">
              <StatusChip row={r} />
              {r.rejected && r.rejection_reason ? (
                <span className="mt-1 block text-[10px] text-rose-600">{r.rejection_reason}</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <ListFrame testid={`${testid}-desktop`}>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-semibold">S:No</th>
              <th className="px-4 py-2.5 font-semibold">Date</th>
              <th className="px-4 py-2.5 font-semibold">Category</th>
              <th className="px-4 py-2.5 font-semibold">Paid To</th>
              <th className="px-4 py-2.5 font-semibold">Reference</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={r.id} className="align-top hover:bg-slate-50" data-testid={`branch-expense-row-${r.id}`}>
                <td className="px-4 py-3 tabular-nums text-slate-400" data-testid={`branch-expense-sno-${r.id}`}>{i + 1}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{r.expense_date || "—"}</td>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800">{r.category}</p>
                  {showBranch && r.branch_name ? <p className="text-[11px] text-slate-400">{r.branch_name}</p> : null}
                  {r.note ? <p className="text-[11px] text-slate-400">{r.note}</p> : null}
                  {r.payment_mode && r.payment_mode !== "cash" ? (
                    <span className="mt-0.5 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                      {MODE_LABELS[r.payment_mode] || r.payment_mode}
                    </span>
                  ) : null}
                </td>
                <td className="break-words px-4 py-3 text-slate-600">
                  {r.paid_to || "—"}
                  {r.vendor_id ? <VendorTag /> : null}
                </td>
                <td className="break-words px-4 py-3 text-slate-500">{r.reference || "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-slate-800">
                  {fmt(r.amount)}
                  {notesLabel(r.cash_denominations) ? (
                    <span className="mt-0.5 block text-[10px] font-normal text-slate-400" data-testid={`branch-expense-notes-${r.id}`}>
                      {notesLabel(r.cash_denominations)}{Number(r.cash_coins) > 0 ? ` + Rs.${r.cash_coins} coins` : ""}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <StatusChip row={r} />
                  {r.rejected && r.rejection_reason ? (
                    <span className="mt-0.5 block text-[10px] text-rose-600">{r.rejection_reason}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ListFrame>
    </>
  );
};

/**
 * The drawer as a list rather than a figure: every movement that made it, in the order
 * the sum works, ending on what should be in the drawer now. The Cash In Hand card above
 * is the answer; this is the working behind it.
 */
const CashMovementList = ({ cash }) => {
  const lines = [
    {
      key: "collected",
      label: "Collected in cash",
      detail:
        cash.cash_approved != null || cash.cash_awaiting != null
          ? `approved ${fmt(cash.cash_approved)} · awaiting ${fmt(cash.cash_awaiting)}`
          : "cash taken at the desk",
      amount: cash.collected_cash,
      sign: "+",
      tone: "text-slate-700",
    },
    { key: "spent", label: "Spent in cash", detail: "expenses paid out of the drawer", amount: cash.cash_spent, sign: "−", tone: "text-rose-600" },
    { key: "handed", label: "Handed over", detail: "received by the accountant", amount: cash.handed_over, sign: "−", tone: "text-rose-600" },
  ];
  if (cash.in_transit > 0) {
    lines.push({ key: "transit", label: "In transit", detail: "left the branch, not yet received", amount: cash.in_transit, sign: "−", tone: "text-amber-700" });
  }
  if (cash.adjustments !== 0) {
    lines.push({
      key: "adjustments",
      label: "Opening / corrections",
      detail: "set by the accountant",
      amount: Math.abs(cash.adjustments),
      sign: cash.adjustments > 0 ? "+" : "−",
      tone: cash.adjustments < 0 ? "text-rose-600" : "text-emerald-700",
    });
  }

  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid="branch-cash-movements-mobile">
        {lines.map((l) => (
          <div key={l.key} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-800">{l.label}</p>
              <p className="truncate text-[11px] text-slate-400">{l.detail}</p>
            </div>
            <span className={`shrink-0 text-sm font-semibold tabular-nums ${l.tone}`}>{l.sign} {fmt(l.amount)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-slate-300 bg-slate-50 p-3">
          <p className="text-sm font-bold text-slate-700">Cash in hand</p>
          <span className="text-sm font-bold tabular-nums text-slate-800">{fmt(cash.cash_in_hand)}</span>
        </div>
      </div>

      <ListFrame testid="branch-cash-movements-desktop">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Movement</th>
              <th className="px-4 py-2.5 font-semibold">Detail</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => (
              <tr key={l.key} className="hover:bg-slate-50" data-testid={`branch-cash-movement-${l.key}`}>
                <td className="px-4 py-3 font-medium text-slate-800">{l.label}</td>
                <td className="px-4 py-3 text-[11px] text-slate-400">{l.detail}</td>
                <td className={`whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums ${l.tone}`}>
                  {l.sign} {fmt(l.amount)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50/70">
              <td className="px-4 py-3 font-bold text-slate-700">Cash in hand</td>
              <td className="px-4 py-3 text-[11px] text-slate-400">what should be in the drawer now</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-slate-800" data-testid="branch-cash-in-hand">
                {fmt(cash.cash_in_hand)}
              </td>
            </tr>
          </tbody>
        </table>
      </ListFrame>
    </>
  );
};

/**
 * Every branch's drawer, a row each, for the desk reading all of them at once — the same
 * sum as the movements list above, laid sideways: what each branch took in cash, what it
 * spent and sent up, and what it should still be holding.
 */
const CashByBranchList = ({ rows }) => {
  if (!rows.length) return <EmptyList testid="branch-cash-by-branch-empty">No branches to count.</EmptyList>;

  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid="branch-cash-by-branch-mobile">
        {rows.map((b) => (
          <div key={b.branch_id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`branch-cash-branch-card-${b.branch_id}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-bold text-slate-800">{b.branch_name || "—"}</p>
              <span className={`shrink-0 text-sm font-bold tabular-nums ${b.cash_in_hand < 0 ? "text-rose-700" : "text-slate-800"}`}>
                {fmt(b.cash_in_hand)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>collected {fmt(b.collected_cash)}</span>
              <span>· spent {fmt(b.cash_spent)}</span>
              <span>· handed over {fmt(b.handed_over)}</span>
              {b.in_transit > 0 ? <span className="text-amber-700">· in transit {fmt(b.in_transit)}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <ListFrame testid="branch-cash-by-branch-desktop">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Branch</th>
              <th className="px-4 py-2.5 text-right font-semibold">Collected In Cash</th>
              <th className="px-4 py-2.5 text-right font-semibold">Spent</th>
              <th className="px-4 py-2.5 text-right font-semibold">Handed Over</th>
              <th className="px-4 py-2.5 text-right font-semibold">In Transit</th>
              <th className="px-4 py-2.5 text-right font-semibold">Cash In Hand</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((b) => (
              <tr key={b.branch_id} className="hover:bg-slate-50" data-testid={`branch-cash-branch-${b.branch_id}`}>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800">{b.branch_name || "—"}</p>
                  {!b.opening_set ? <p className="text-[11px] text-amber-700">opening not set</p> : null}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-600">{fmt(b.collected_cash)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-rose-600">− {fmt(b.cash_spent)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-rose-600">− {fmt(b.handed_over)}</td>
                <td className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${b.in_transit > 0 ? "text-amber-700" : "text-slate-400"}`}>
                  {b.in_transit > 0 ? `− ${fmt(b.in_transit)}` : "—"}
                </td>
                <td className={`whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums ${b.cash_in_hand < 0 ? "text-rose-700" : "text-slate-800"}`}>
                  {fmt(b.cash_in_hand)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ListFrame>
    </>
  );
};

/** Every handover sent up, newest first — not only the ones still in the air. A pending
    one can still be pulled back; a received one is there to be read back against, which
    is the whole reason the accountant counts it in. */
const HandoverList = ({ handovers, onCancel, showBranch }) => {
  if (!handovers.length) {
    return (
      <EmptyList testid="branch-handover-empty">
        Nothing handed over yet. Hand over cash sends the drawer up to the accountant.
      </EmptyList>
    );
  }

  const chip = (h) => {
    if (h.status === "received") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
          <CheckCircle2 className="h-3 w-3" /> Received
        </span>
      );
    }
    if (h.status === "cancelled") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">
          <XCircle className="h-3 w-3" /> Cancelled
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
        <Clock className="h-3 w-3" /> Waiting to be received
      </span>
    );
  };

  return (
    <>
      <div className="space-y-2 sm:hidden" data-testid="branch-handover-list-mobile">
        {handovers.map((h) => (
          <div key={h.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`branch-handover-card-${h.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">{fmt(h.amount)}</p>
                <p className="truncate text-xs text-slate-500">to {h.handed_to || "—"} · {h.on || "—"}</p>
                {showBranch && h.branch_name ? <p className="truncate text-[11px] text-slate-400">{h.branch_name}</p> : null}
              </div>
              {chip(h)}
            </div>
            {h.status === "pending" && (
              <button
                type="button"
                onClick={() => onCancel(h.id)}
                className="mt-2 text-[11px] text-slate-400 underline hover:text-rose-600"
                data-testid={`branch-handover-cancel-${h.id}`}
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>

      <ListFrame testid="branch-handover-list-desktop">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Date</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-2.5 font-semibold">Handed To</th>
              <th className="px-4 py-2.5 font-semibold">Notes Counted</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {handovers.map((h) => (
              <tr key={h.id} className="align-top hover:bg-slate-50" data-testid={`branch-handover-${h.id}`}>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{h.on || "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-slate-800">
                  {fmt(h.amount)}
                  {h.received_amount != null && Math.abs(h.variance) >= 0.01 ? (
                    <span className="mt-0.5 block text-[10px] font-normal text-amber-700">counted in {fmt(h.received_amount)}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-700">{h.handed_to || "—"}</p>
                  {showBranch && h.branch_name ? <p className="text-[11px] text-slate-400">{h.branch_name}</p> : null}
                  {/* Who said this cash was on its way. Worth a line since the accountant
                      can raise one against a branch as well as receive it, so a branch
                      reading its own drawer can see a handover it did not send up. */}
                  {h.raised_by ? <p className="text-[11px] text-slate-400">raised by {h.raised_by}</p> : null}
                  {h.note ? <p className="text-[11px] text-slate-400">{h.note}</p> : null}
                </td>
                <td className="px-4 py-3 text-[11px] text-slate-400">
                  {notesLabel(h.cash_denominations)
                    ? `${notesLabel(h.cash_denominations)}${Number(h.cash_coins) > 0 ? ` + Rs.${h.cash_coins} coins` : ""}`
                    : "—"}
                </td>
                <td className="px-4 py-3">{chip(h)}</td>
                <td className="px-4 py-3 text-right">
                  {h.status === "pending" ? (
                    <button
                      type="button"
                      onClick={() => onCancel(h.id)}
                      className="text-[11px] text-slate-400 underline hover:text-rose-600"
                      data-testid={`branch-handover-cancel-${h.id}`}
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ListFrame>
    </>
  );
};

const countLabel = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param branchId  Whose drawer to show. Cash in hand belongs to a branch, so with no
 *                  branch in view the card and the handover button are left out.
 */
export const BranchExpensesPanel = ({ onChanged, branchId }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Which of the four piles is open. It opens on the request log rather than the drawer:
  // the drawer is only there when a branch is picked, and this is the expense side.
  const [view, setView] = useState("request");
  const [adding, setAdding] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  const [cash, setCash] = useState(null);
  const [handovers, setHandovers] = useState([]);
  // Only for the two dialogs, and only where the board above has not already picked one:
  // both forms are statements about a single branch's cash, so with no branch in view
  // they have to ask which.
  const [branches, setBranches] = useState([]);

  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // This branch's spending, not every branch's. The drawer figure on the first card
      // is one branch's, so a list beside it that counted them all would be two scopes
      // in one panel.
      const data = await getFinanceExpenses(branchId ? { branch_id: branchId } : {});
      setRows(data.expenses || []);
      onChangedRef.current?.();
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  // The drawer and its handovers, reloaded whenever the expenses are — a cash expense
  // draws the drawer down as it is raised.
  //
  // Asked for with no branch too, which is where this desk usually sits: /finance/branch-cash
  // answers a branch with its own five figures and no branch with the roll-up across every
  // branch, { total, by_branch }. The Cash In Hand card reads the same off either; what
  // changes is the list it opens — one branch's movements, or every branch's drawer a row
  // each.
  const loadCash = useCallback(async () => {
    try {
      const [box, ho] = await Promise.all([
        getBranchCash(branchId ? { branch_id: branchId } : {}),
        listCashHandovers(branchId ? { branch_id: branchId } : {}),
      ]);
      setCash(box);
      setHandovers(ho.handovers || []);
    } catch {
      setCash(null);
      setHandovers([]);
    }
  }, [branchId]);

  useEffect(() => { loadCash(); }, [loadCash]);

  useEffect(() => {
    if (branchId) { setBranches([]); return; }
    getBranches().then((b) => setBranches(b || [])).catch(() => setBranches([]));
  }, [branchId]);

  const pullBackHandover = async (id) => {
    try {
      await cancelCashHandover(id);
      toast.success("Handover cancelled");
      loadCash();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not cancel that");
    }
  };

  // The piles, counted once here rather than read off the endpoint's own totals for the
  // cards and off the rows for the lists: the figure on a card and the rows it opens are
  // then the same pass over the same list, and cannot part company.
  //
  // Request holds what is still only a request — once the accountant signs one off it is
  // spending, and moves to Expense Approved rather than being counted in both. A rejected
  // row has nowhere else to be read, so it stays here, wearing its own chip.
  const piles = useMemo(() => {
    const out = {
      request: { rows: [], total: 0 },
      pending: { rows: [], total: 0 },
      approved: { rows: [], total: 0 },
    };
    rows.forEach((r) => {
      const amount = Number(r.amount) || 0;
      if (!r.approved) {
        out.request.rows.push(r);
        out.request.total += amount;
      }
      if (r.rejected) return;
      const key = r.approved ? "approved" : "pending";
      out[key].rows.push(r);
      out[key].total += amount;
    });
    return out;
  }, [rows]);

  // Both shapes of /finance/branch-cash, read the same way: the five figures, and the
  // per-branch breakdown where there is one.
  const byBranch = cash?.by_branch || null;
  const cashFigures = byBranch ? cash.total : cash;
  const showCash = !!cashFigures;
  const activeView = view === "cash" && !showCash ? "request" : view;

  // The four, in the order the desk asked for them. There was a fifth, Approved, carrying
  // the same signed-off total over the same rows as Expense Approved — the same card twice
  // on the screen — so Expense Approved answers both questions on its own.
  const CARDS = [
    ...(showCash
      ? [{
          key: "cash",
          label: "Cash In Hand",
          color: cashFigures.cash_in_hand < 0 ? "#e11d48" : "#0284c7",
          amount: fmt(cashFigures.cash_in_hand),
          sub: byBranch
            // The total leaves out branches whose opening count is not set yet.
            ? `across ${countLabel(byBranch.length - (cashFigures.opening_unset || 0), "branch", "branches")}`
              + (cashFigures.opening_unset ? ` · ${cashFigures.opening_unset} not opened` : "")
            : cash.opening_set ? "in the drawer now" : "opening not set",
        }]
      : []),
    {
      key: "request",
      label: "Expense Request",
      color: "#6366f1",
      amount: fmt(piles.request.total),
      sub: `${countLabel(piles.request.rows.length, "request", "requests")} raised`,
    },
    {
      key: "expense_approved",
      label: "Expense Approved",
      color: "#059669",
      amount: fmt(piles.approved.total),
      sub: `${countLabel(piles.approved.rows.length, "expense", "expenses")} signed off`,
    },
    {
      key: "pending",
      label: "Pending Approved",
      color: "#d97706",
      amount: fmt(piles.pending.total),
      sub: `${countLabel(piles.pending.rows.length, "request", "requests")} waiting`,
    },
  ];

  // What the list under the cards is, per card: what it is called, what it holds, and
  // what it says when it holds nothing.
  const LISTS = {
    request: {
      title: "Expense requests not yet approved",
      hint: "Waiting and sent back, newest first — approved ones move to Expense Approved",
      rows: piles.request.rows,
      empty: "No open requests.",
    },
    expense_approved: {
      title: "Expenses approved by the accountant",
      hint: "Each one as it was raised, approved and paid",
      rows: piles.approved.rows,
      empty: "Nothing approved yet.",
    },
    pending: {
      title: "Waiting on the accountant",
      hint: "Raised at the branch and not yet signed off",
      rows: piles.pending.rows,
      empty: "Nothing waiting. Add Expense sends a request to the accountant.",
    },
  };

  const list = LISTS[activeView];
  // What the two dialogs check an amount against. One branch's drawer or nothing: the
  // roll-up is several drawers added up, and "that is more than is in it" said against a
  // figure spread over every branch would be a check on nothing.
  const cashInHand = byBranch ? null : cash?.cash_in_hand ?? null;

  return (
    <div className="space-y-4" data-testid="branch-expenses-panel">
      {/* The four piles, as cards that are also the tabs onto them — the shape HR Admin's
          stage cards already wear on this system, and for the same reason: a figure you
          press to read the rows behind it, rather than a row of figures and a tab bar
          under it saying the same thing twice.

          Two across a phone so the amounts stay readable, four across from lg where there
          is room for the whole row of them. */}
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4"
        data-testid="branch-expense-summary-cards"
      >
        {CARDS.map((c) => (
          <SummaryCard
            key={c.key}
            label={c.label}
            color={c.color}
            amount={c.amount}
            sub={c.sub}
            active={activeView === c.key}
            onClick={() => setView(c.key)}
            testid={`branch-expense-card-${c.key}`}
          />
        ))}
      </div>

      {/* What is being read, and the one thing there is to do to it. Add Expense sits on
          every expense pile rather than only the requests: wanting to log spending does
          not depend on which pile happened to be open when you thought of it. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-700" data-testid="branch-expense-list-title">
            {activeView !== "cash"
              ? list.title
              : byBranch ? "What every branch is holding" : "How the drawer got to that figure"}
          </p>
          <p className="text-[11px] text-slate-400">
            {activeView !== "cash"
              ? list.hint
              : byBranch
                ? "One row per branch — collections in, spending and handovers out"
                : "Collections in; spending and handovers out"}
          </p>
        </div>
        {activeView === "cash" ? (
          <Button
            onClick={() => setHandingOver(true)}
            className="ml-auto h-9 bg-amber-600 text-xs text-white hover:bg-amber-700"
            data-testid="branch-handover-open"
          >
            <HandCoins className="mr-1.5 h-3.5 w-3.5" /> Hand over cash
          </Button>
        ) : (
          <Button
            className="ml-auto bg-sky-600 text-white hover:bg-sky-700"
            onClick={() => setAdding(true)}
            data-testid="branch-expense-add"
          >
            <Plus className="mr-1 h-4 w-4" /> Add Expense
          </Button>
        )}
      </div>

      {activeView === "cash" ? (
        <div className="space-y-4">
          {!byBranch && !cash.opening_set && (
            <p
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700"
              data-testid="branch-cash-not-set"
            >
              Opening cash not set by the accountant — this is collections less spending since tracking began.
            </p>
          )}
          {byBranch ? <CashByBranchList rows={byBranch} /> : <CashMovementList cash={cash} />}
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-700">Handovers</p>
            <HandoverList handovers={handovers} onCancel={pullBackHandover} showBranch={!branchId} />
          </div>
        </div>
      ) : (
        <ExpenseList
          rows={list.rows}
          loading={loading}
          empty={list.empty}
          showBranch={!branchId}
          testid="branch-expense-list"
        />
      )}

      {adding && (
        <AddExpenseDialog
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); loadCash(); }}
          cashInHand={cashInHand}
          branchId={branchId}
          branches={branches}
          pastRows={rows}
        />
      )}
      {handingOver && (
        <HandoverDialog
          onClose={() => setHandingOver(false)}
          onSaved={() => { setHandingOver(false); loadCash(); }}
          cashInHand={cashInHand}
          branchId={branchId}
          branches={branches}
        />
      )}
    </div>
  );
};

export default BranchExpensesPanel;
