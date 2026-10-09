import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, ChevronRight, Coins, HandCoins, Layers, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SummaryTile } from "@/components/ui/summary-tile";
import { toast } from "@/components/ui/sonner";
import {
  getBranches, getBranchCash, getBranchCashEntries, setBranchCashAdjustment, receiveCashHandover, deleteBranchCashEntry,
} from "@/lib/api";
import { notesLabel } from "@/lib/denominations";

const fmt = (n) => `Rs.${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const ALL = "all";

const TONE_TEXT = { slate: "text-slate-800", amber: "text-amber-700", emerald: "text-emerald-700" };

// The picked card's outline and tint, as one hex — the Summary tab's revenue tiles do
// the same, so a card here and a card there read as one row of cards.
const TONE_HEX = { slate: "#0284c7", amber: "#d97706", emerald: "#059669" };

// A card is a button: clicking it opens the rows it was summed from below the cards, and
// clicking it again closes them.
const Figure = ({ label, value, tone = "slate", testId, active = false, onClick }) => (
  <SummaryTile
    label={label}
    value={value}
    color={TONE_HEX[tone] || TONE_HEX.slate}
    valueClassName={TONE_TEXT[tone] || TONE_TEXT.slate}
    active={active}
    onClick={onClick}
    testid={testId}
  />
);

const KIND_LABEL = {
  collected: "Collected",
  collected_cash: "Collected (cash)",
  cash_spent: "Cash spent",
  cash_returned: "Cash returned",
  handed_over: "Handed over",
  in_transit: "In transit",
  cash_in_hand: "Cash in hand",
};

// What a row is, off the prefix the server gave its id: what the bin and the popup call
// it, and what deleting it does to the drawer -- said in the confirm before it goes.
const ENTRY_NOUN = { col: "payment", exp: "expense", ret: "cash return", ho: "handover" };
const ENTRY_EFFECT = {
  col: "The payment is removed at the source and is owed again.",
  exp: "Its cash goes back into the drawer.",
  ret: "The drawer drops by it again.",
  ho: "The cash counts as back in the drawer, and a count difference written when it was received goes with it.",
  adj: "Cash in hand moves back by it.",
};
const entryPrefix = (r) => String(r.id || "").split("-")[0];
const entryNoun = (r) => {
  const p = entryPrefix(r);
  if (p === "adj") return r.type === "Opening" ? "opening count" : "correction";
  return ENTRY_NOUN[p] || "entry";
};
const capFirst = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** One row, opened off its arrow (or a tap on the row): every field it has, and its bin
 *  again as a button while it can be deleted. */
const EntryDetail = ({ row, partyLabel, onClose, onDelete, deleting }) => {
  const noun = entryNoun(row);
  const lines = [
    ["Date", row.date],
    ["Branch", row.branch_name],
    ["Type", row.type],
    [partyLabel, row.party],
    ["Detail", row.detail],
    ["Status", row.status],
  ].filter(([, v]) => v);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="branch-cash-entry-detail"
    >
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-800">{capFirst(noun)}</h3>
            <p className={`text-lg font-bold tabular-nums ${row.amount < 0 ? "text-rose-600" : "text-slate-800"}`}>{fmt(row.amount)}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="divide-y divide-slate-100 overflow-auto px-5 py-1 text-sm">
          {lines.map(([k, v]) => (
            <div key={k} className="flex gap-3 py-2">
              <dt className="w-24 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
              <dd className="min-w-0 break-words text-slate-700">{v}</dd>
            </div>
          ))}
        </dl>
        {row.can_delete && (
          <div className="flex shrink-0 justify-end border-t border-slate-200 px-5 py-3">
            <Button
              variant="outline"
              onClick={() => onDelete(row)}
              disabled={deleting}
              className="h-9 border-rose-200 text-xs text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              data-testid="branch-cash-entry-detail-delete"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {deleting ? "Deleting…" : `Delete ${noun}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

/** The rows behind one card, with a Type filter off the rows' own types. Also the Cash In
 *  Hand cards on Accountant Manage's Summary (BranchExpensesPanel), where the cards are the
 *  tabs and there is nothing to close: no onClose, no close button.
 *
 *  toolbar: buttons to sit on the Type filter's row. Given, the title row goes -- the
 *  picked card above already says what is open -- and the filter and buttons are one line
 *  over the table rather than three.
 *
 *  Every row ends in an Action column: an arrow onto the row (EntryDetail), and a bin
 *  beside it where the server says the row can go (`can_delete` -- Developer Access's
 *  Income & Expense delete switch; a branch's payment only while still in To Verify, under
 *  Before Verify Transactions). onDeleted: told after one goes, so the figures above are
 *  read again. */
export const EntriesPanel = ({ kind, branchId, showBranch, onClose, toolbar, onDeleted }) => {
  const [rows, setRows] = useState(null);
  const [type, setType] = useState(ALL);
  const [deletingId, setDeletingId] = useState(null);
  const [version, setVersion] = useState(0);
  const [openRow, setOpenRow] = useState(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    getBranchCashEntries({ kind, ...(branchId ? { branch_id: branchId } : {}) })
      .then((d) => {
        if (!live) return;
        setRows(d?.rows || []);
      })
      .catch((e) => {
        if (!live) return;
        setRows([]);
        toast.error(e?.response?.data?.detail || "Could not load those entries");
      });
    return () => { live = false; };
  }, [kind, branchId, version]);

  // A new card or branch starts on every type; a reload after a delete keeps the one picked.
  useEffect(() => { setType(ALL); setOpenRow(null); }, [kind, branchId]);

  const removeEntry = async (r) => {
    const noun = entryNoun(r);
    const who = r.party ? ` (${r.party})` : "";
    if (!window.confirm(`Delete this ${noun} of ${fmt(Math.abs(r.amount))}${who}?\n\n${ENTRY_EFFECT[entryPrefix(r)] || ""} It cannot be undone.`)) return;
    setDeletingId(r.id);
    try {
      const res = await deleteBranchCashEntry(r.id);
      toast.success((res?.message || `${capFirst(noun)} deleted`).replace(/ -- /g, " — "));
      setOpenRow(null);
      setVersion((v) => v + 1);
      onDeleted?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Could not delete that ${noun}`);
    } finally {
      setDeletingId(null);
    }
  };

  const types = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((r) => m.set(r.type, (m.get(r.type) || 0) + 1));
    return [...m.entries()];
  }, [rows]);
  const shown = (rows || []).filter((r) => type === ALL || r.type === type);
  // While any row shown has a bin, a row without one keeps the bin's space empty, so every
  // arrow stands in one line under Action instead of jumping right on the rows with a bin.
  const binSlot = shown.some((r) => r.can_delete);
  const total =shown.reduce((s, r) => s + Number(r.amount || 0), 0);
  const partyLabel = kind === "cash_spent" ? "Paid to" : kind === "handed_over" || kind === "in_transit" ? "Carried by" : "Party";

  const typeFilter = types.length > 1 && (
    <select
      value={type}
      onChange={(e) => setType(e.target.value)}
      className="h-9 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1"
      aria-label="Type"
      data-testid="branch-cash-entries-types"
    >
      {[[ALL, rows.length], ...types].map(([t, n]) => (
        <option key={t} value={t}>{t === ALL ? "All types" : t} ({n})</option>
      ))}
    </select>
  );

  const table = (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow" data-testid="branch-cash-entries">
      {!toolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
          <p className="text-sm font-semibold text-slate-800">{KIND_LABEL[kind]}</p>
          {rows && <span className="text-[11px] text-slate-400">{shown.length} entries · {fmt(total)}</span>}
          <div className="ml-auto flex items-center gap-2">
            {typeFilter}
            {onClose && (
              <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="branch-cash-entries-close">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
      {!rows && <p className="py-8 text-center text-xs text-slate-400">Loading…</p>}
      {rows && shown.length === 0 && <p className="py-8 text-center text-xs text-slate-400">Nothing here yet.</p>}
      {rows && shown.length > 0 && (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="sticky top-0 bg-slate-500 text-[11px] text-white">
              <tr>
                <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Date</th>
                {showBranch && <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Branch</th>}
                <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Type</th>
                <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">{partyLabel}</th>
                <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Detail</th>
                <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Status</th>
                <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Amount</th>
                <th className="px-3 py-2.5 text-center font-semibold uppercase tracking-wide">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpenRow(r)}
                  className="cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50"
                  data-testid={`branch-cash-entry-${r.id}`}
                >
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-500">{r.date}</td>
                  {showBranch && <td className="px-3 py-2 text-slate-600">{r.branch_name}</td>}
                  <td className="px-3 py-2"><span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{r.type}</span></td>
                  <td className="px-3 py-2 text-slate-700">{r.party || "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.detail || "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.status || "—"}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.amount < 0 ? "text-rose-600" : "text-slate-800"}`}>{fmt(r.amount)}</td>
                  <td className="px-3 py-1.5 text-center">
                    {/* The bin, a bare icon, beside the one arrow -- the To Verify row's shape. */}
                    <div className="flex items-center justify-center gap-1">
                      {r.can_delete ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeEntry(r); }}
                          disabled={deletingId === r.id}
                          className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-rose-600 disabled:opacity-40"
                          title={`Delete this ${entryNoun(r)}`}
                          aria-label={`Delete this ${entryNoun(r)}`}
                          data-testid={`branch-cash-entry-delete-${r.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : binSlot ? (
                        <span className="h-7 w-7" aria-hidden="true" />
                      ) : null}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setOpenRow(r); }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-sky-700"
                        title="View details"
                        aria-label="View details"
                        data-testid={`branch-cash-entry-open-${r.id}`}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const detail = openRow && (
    <EntryDetail
      row={openRow}
      partyLabel={partyLabel}
      onClose={() => setOpenRow(null)}
      onDelete={removeEntry}
      deleting={deletingId === openRow.id}
    />
  );

  if (!toolbar) return <>{table}{detail}</>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {typeFilter}
        <div className="ml-auto flex flex-wrap gap-2">{toolbar}</div>
      </div>
      {table}
      {detail}
    </div>
  );
};

const OpeningCashForm = ({ branchId, branchName, isCorrection, onDone }) => {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const counted = Number(amount);
    if (!(counted >= 0)) { toast.error("Enter the counted cash"); return; }
    setSaving(true);
    try {
      await setBranchCashAdjustment({
        branch_id: branchId,
        reason: isCorrection ? "correction" : "opening",
        counted_amount: counted,
        note: note.trim(),
      });
      toast.success(isCorrection ? "Cash balance corrected" : "Opening cash set");
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4" data-testid="branch-cash-opening-form">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <ShieldCheck className="h-4 w-4 text-sky-600" />
        {isCorrection ? `Correct ${branchName || "this branch"}'s cash` : `Set ${branchName || "this branch"}'s opening cash`}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        {isCorrection
          ? "Count the drawer and enter what is actually in it. The difference is written as a correction."
          : "Count the branch drawer now and enter the total. From here the box tracks every collection, expense and handover on its own."}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Counted cash</label>
          <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className="w-40 tabular-nums" data-testid="branch-cash-opening-amount" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Note</label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" data-testid="branch-cash-opening-note" />
        </div>
        <Button onClick={submit} disabled={saving} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="branch-cash-opening-submit">
          {saving ? "Saving…" : isCorrection ? "Correct" : "Set opening cash"}
        </Button>
      </div>
    </div>
  );
};

const ReceiveHandoverRow = ({ handover, onReceived }) => {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(handover.amount));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const receive = async () => {
    setSaving(true);
    try {
      const received = Number(amount);
      await receiveCashHandover(handover.id, { received_amount: received, note: note.trim() });
      const variance = received - handover.amount;
      toast.success(Math.abs(variance) < 0.01 ? "Handover received" : `Received with a ${fmt(Math.abs(variance))} ${variance < 0 ? "shortfall" : "excess"}`);
      onReceived();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not receive that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3" data-testid={`branch-cash-handover-${handover.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <HandCoins className="h-3.5 w-3.5 text-amber-600" />
        <span className="font-bold tabular-nums text-slate-800">{fmt(handover.amount)}</span>
        <span className="text-slate-500">from {handover.branch_name || "branch"} · carried by {handover.handed_to} · {handover.on}</span>
        {notesLabel(handover.cash_denominations) ? (
          <span className="text-slate-400">({notesLabel(handover.cash_denominations)}{Number(handover.cash_coins) > 0 ? ` + Rs.${handover.cash_coins} coins` : ""})</span>
        ) : null}
        {handover.note ? <span className="text-slate-400">— {handover.note}</span> : null}
        {!open && (
          <Button size="sm" className="ml-auto h-7 bg-amber-600 text-[11px] text-white hover:bg-amber-700" onClick={() => setOpen(true)} data-testid={`branch-cash-handover-open-${handover.id}`}>
            Receive
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-amber-200 pt-2">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Counted</label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32 tabular-nums" data-testid={`branch-cash-handover-amount-${handover.id}`} />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Note</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </div>
          <Button size="sm" onClick={receive} disabled={saving} className="h-9 bg-emerald-600 text-xs text-white hover:bg-emerald-700" data-testid={`branch-cash-handover-confirm-${handover.id}`}>
            {saving ? "Saving…" : "Confirm receipt"}
          </Button>
          <Button size="sm" variant="outline" className="h-9 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
};

/**
 * Accountant / Super Admin — Finance > Branch Cash.
 *
 * One running box per branch: what it collected in cash, what it spent, what it has
 * handed over, and what should be in the drawer right now. The accountant sets each
 * branch's opening figure once (a physical count), receives the cash the branches send
 * up, and corrects a box after a count where it has drifted.
 *
 * @param branchId  Set by Super Admin > Finance's branch-pill row. Left unset (the
 *                  Accountant's own board) this component shows its own branch select.
 */
export const BranchCashBoard = ({ branchId: scopedBranchId, scoped = false }) => {
  const [branches, setBranches] = useState([]);
  // Null until the branch list arrives, so the board opens on Anna Nagar (the desk's
  // home branch) without first loading the All Branches roll-up.
  const [ownSel, setOwnSel] = useState(scoped ? ALL : null);
  const branchId = scoped ? (scopedBranchId || "") : (ownSel === ALL || ownSel === null ? "" : ownSel);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  // Which card's rows are open below the cards, if any. On All Branches the Branches card
  // is the resting state: it is open by default and closing any other card returns to it,
  // so the roll-up is never unselected into an empty page.
  const restKind = branchId ? null : "branches";
  const [kind, setKind] = useState(restKind);
  useEffect(() => { setKind(restKind); }, [restKind]);
  const card = (k) => ({ active: kind === k, onClick: () => setKind((cur) => (cur === k ? restKind : k)) });

  useEffect(() => {
    if (scoped) return;
    getBranches()
      .then((b) => {
        // Anna Nagar leads the pill row and is the default pick; the rest keep their order.
        const isAnna = (x) => /anna\s*nagar/i.test(x?.branch_name || "");
        const list = b || [];
        const sorted = [...list.filter(isAnna), ...list.filter((x) => !isAnna(x))];
        setBranches(sorted);
        setOwnSel((cur) => (cur === null ? (sorted.find(isAnna)?.id || ALL) : cur));
      })
      .catch(() => { setBranches([]); setOwnSel((cur) => (cur === null ? ALL : cur)); });
  }, [scoped]);

  const load = useCallback(async () => {
    if (!scoped && ownSel === null) return;
    setLoading(true);
    try {
      setData(await getBranchCash(branchId ? { branch_id: branchId } : {}));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, scoped, ownSel]);

  useEffect(() => { load(); }, [load]);

  const branchName = useMemo(() => {
    if (data?.branch_name) return data.branch_name;
    return branches.find((b) => b.id === branchId)?.branch_name || "";
  }, [data, branches, branchId]);

  const pendingHandovers = (data?.handovers || []).filter((h) => h.status === "pending");

  return (
    <div className="space-y-4" data-testid="branch-cash-board">
      {!scoped && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-2" data-testid="branch-cash-branch-row">
          <button
            type="button"
            onClick={() => setOwnSel(ALL)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${ownSel === ALL ? "bg-sky-600 text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}
          >
            <Layers className="h-3.5 w-3.5" /> All Branches
          </button>
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setOwnSel(b.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${ownSel === b.id ? "bg-sky-600 text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}
            >
              <Building2 className="h-3.5 w-3.5" /> {b.branch_name}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="py-10 text-center text-sm text-slate-400">Loading…</p>}

      {!loading && data && !branchId && (
        <div className="space-y-3" data-testid="branch-cash-rollup">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
            <Figure label="Collected" value={fmt(data.total?.collected_total)} testId="branch-cash-total-collected" {...card("collected")} />
            <Figure label="Collected (cash)" value={fmt(data.total?.collected_cash)} testId="branch-cash-total-cash" {...card("collected_cash")} />
            <Figure label="Cash returned" value={fmt(data.total?.cash_returned)} tone="emerald" testId="branch-cash-total-returned" {...card("cash_returned")} />
            <Figure label="Cash spent" value={fmt(data.total?.cash_spent)} testId="branch-cash-total-spent" {...card("cash_spent")} />
            <Figure
              label="Branches"
              value={`${(data.by_branch || []).length} branches`}
              testId="branch-cash-total-branches"
              {...card("branches")}
            />
            <Figure label="Handed over" value={fmt(data.total?.handed_over)} testId="branch-cash-total-handed" {...card("handed_over")} />
            <Figure label="In transit" value={fmt(data.total?.in_transit)} tone="amber" testId="branch-cash-total-transit" {...card("in_transit")} />
            {/* Summed over branches whose opening count is set; the rest are left out of it. */}
            <Figure
              label={data.total?.opening_unset ? `Cash in hand · ${data.total.opening_unset} not opened` : "Cash in hand"}
              value={fmt(data.total?.cash_in_hand)}
              tone="emerald"
              testId="branch-cash-total-hand"
              {...card("cash_in_hand")}
            />
          </div>
          {kind && kind !== "branches" && <EntriesPanel kind={kind} branchId="" showBranch onClose={() => setKind(restKind)} onDeleted={load} />}
          {/* The per-branch roll-up, behind the Branches card rather than always on screen. */}
          {kind === "branches" && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow" data-testid="branch-cash-branches">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
              <p className="text-sm font-semibold text-slate-800">Branches</p>
              <span className="text-[11px] text-slate-400">{(data.by_branch || []).length} branches{!scoped ? " · click a branch to open it" : ""}</span>
            </div>
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-slate-500 text-[11px] text-white">
                <tr>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Branch</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Collected (cash)</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Returned</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Spent</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Handed over</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">In transit</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Cash in hand</th>
                </tr>
              </thead>
              <tbody>
                {(data.by_branch || []).map((r) => (
                  <tr
                    key={r.branch_id}
                    onClick={scoped ? undefined : () => setOwnSel(r.branch_id)}
                    className={`border-t border-slate-100 ${scoped ? "" : "cursor-pointer hover:bg-slate-50"}`}
                    data-testid={`branch-cash-rollup-${r.branch_id}`}
                  >
                    <td className="px-3 py-2.5 font-medium text-slate-700">
                      {r.branch_name}
                      {!r.opening_set && <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">opening not set</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.collected_cash)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmt(r.cash_returned)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.cash_spent)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.handed_over)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">{fmt(r.in_transit)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{fmt(r.cash_in_hand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {!loading && data && branchId && (
        <div className="space-y-4" data-testid="branch-cash-detail">
          {!data.opening_set && (
            <OpeningCashForm branchId={branchId} branchName={branchName} isCorrection={false} onDone={load} />
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
            <Figure label="Collected" value={fmt(data.collected_total)} testId="branch-cash-collected" {...card("collected")} />
            <Figure label="Collected (cash)" value={fmt(data.collected_cash)} testId="branch-cash-cash" {...card("collected_cash")} />
            <Figure label="Cash returned" value={fmt(data.cash_returned)} tone="emerald" testId="branch-cash-returned" {...card("cash_returned")} />
            <Figure label="Spent (cash)" value={fmt(data.cash_spent)} testId="branch-cash-spent" {...card("cash_spent")} />
            <Figure label="Handed over" value={fmt(data.handed_over)} testId="branch-cash-handed" {...card("handed_over")} />
            <Figure label="In transit" value={fmt(data.in_transit)} tone="amber" testId="branch-cash-transit" {...card("in_transit")} />
            <Figure label="Cash in hand" value={fmt(data.cash_in_hand)} tone="emerald" testId="branch-cash-hand" {...card("cash_in_hand")} />
          </div>
          {kind && <EntriesPanel kind={kind} branchId={branchId} showBranch={false} onClose={() => setKind(null)} onDeleted={load} />}
          <p className="text-[11px] text-slate-500" data-testid="branch-cash-reconcile">
            Collected in cash {fmt(data.collected_cash)}
            {(data.cash_approved != null) && <span className="text-slate-400"> (approved {fmt(data.cash_approved)} · awaiting {fmt(data.cash_awaiting)})</span>}
            {data.cash_returned > 0 ? ` + returned ${fmt(data.cash_returned)}` : ""}
            {" "}− spent {fmt(data.cash_spent)} − handed over {fmt(data.handed_over)}
            {data.in_transit > 0 ? ` − in transit ${fmt(data.in_transit)}` : ""}
            {data.adjustments !== 0 ? ` ${data.adjustments > 0 ? "+" : "−"} opening/corrections ${fmt(Math.abs(data.adjustments))}` : ""}
            {" = "}<b className="text-slate-700">{fmt(data.cash_in_hand)}</b>
            {!data.opening_set && <span className="text-amber-700"> · opening cash not set yet</span>}
          </p>

          {pendingHandovers.length > 0 && (
            <div className="space-y-2" data-testid="branch-cash-handovers">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Handovers to receive</p>
              {pendingHandovers.map((h) => (
                <ReceiveHandoverRow key={h.id} handover={h} onReceived={load} />
              ))}
            </div>
          )}

          {data.opening_set && (
            <details className="rounded-lg border border-slate-200 bg-white p-3 text-xs" data-testid="branch-cash-correction">
              <summary className="cursor-pointer font-medium text-slate-600">Correct this branch's cash after a count</summary>
              <div className="mt-3">
                <OpeningCashForm branchId={branchId} branchName={branchName} isCorrection onDone={load} />
              </div>
            </details>
          )}

          {(data.adjustments_log || []).length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="branch-cash-adjustments">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Adjustments</p>
              <div className="space-y-1 text-[11px]">
                {(data.adjustments_log || []).map((a) => (
                  <div key={a.id} className="flex flex-wrap items-baseline gap-2">
                    <span className="w-20 shrink-0 tabular-nums text-slate-400">{a.on}</span>
                    <span className={`font-semibold tabular-nums ${a.amount < 0 ? "text-rose-600" : "text-emerald-700"}`}>
                      {a.amount > 0 ? "+" : ""}{fmt(a.amount)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">{a.reason}</span>
                    <span className="min-w-0 flex-1 text-slate-500">{a.note || "—"}<span className="text-slate-400"> · {a.created_by}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.handed_over === 0 && data.in_transit === 0 && pendingHandovers.length === 0 && (
            <p className="flex items-center gap-1.5 py-4 text-xs text-slate-400">
              <Coins className="h-3.5 w-3.5" /> No handovers from this branch yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default BranchCashBoard;
