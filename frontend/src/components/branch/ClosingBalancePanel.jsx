import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, BookCheck, BookLock, BookOpen, CalendarDays, CreditCard, Smartphone, Save, TrendingDown, TrendingUp, Check, AlertTriangle, Wallet, CalendarClock, Lock, Unlock, Undo2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isoToManual } from "@/components/DateFilterPopover";
import { getClosingBalance, getClosingBalanceHistory, saveClosingBalance, closeBook, reopenBook, getRevenueOverview, getFinanceExpenses } from "@/lib/api";
import { loadSession } from "@/lib/session";
import { DENOMINATIONS, noteTotal, countedNotes, noteBreakdown } from "@/lib/denominations";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Built off the local clock rather than toISOString(), which converts to UTC first: east
// of Greenwich that hands back yesterday's date for the whole of the early evening, and a
// branch closing at 8pm would be shown counting the wrong day.
const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => toIso(new Date());
const fromIso = (iso) => new Date(`${iso}T00:00:00`);
const shiftDays = (iso, n) => { const d = fromIso(iso); d.setDate(d.getDate() + n); return toIso(d); };

/** Every date from `start` to `end`, oldest first. Both ends are inclusive: a range that
 *  quietly dropped its last day would report a month as counted while the 31st sat
 *  uncounted and invisible. */
const daysBetween = (start, end) => {
  const out = [];
  for (let d = start; d <= end && out.length < 400; d = shiftDays(d, 1)) out.push(d);
  return out;
};

const dayLabel = (iso) => {
  const d = fromIso(iso);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
};

/**
 * The three ways a branch settles, and the one thing each is checked by.
 *
 * They are not interchangeable fields with a mode label on top. Cash is evidenced by the
 * notes themselves, UPI by the id the money arrived on, and a card batch by the number the
 * terminal printed — each is what a dispute over that money is actually traced by, and
 * asking for the wrong one gets an invented answer typed in to get past the form.
 */
const MODES = [
  { key: "cash", label: "Cash", icon: Banknote, color: "#059669" },
  { key: "upi", label: "UPI", icon: Smartphone, color: "#7c3aed" },
  { key: "card", label: "Card", icon: CreditCard, color: "#0284c7" },
];

/** A figure with its name, for the strips at the top of both views. */
const Figure = ({ label, value, sub, icon: Icon, color, testid }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={testid}>
    <div className="flex items-center gap-2">
      {Icon && <Icon className="h-3.5 w-3.5" style={{ color }} />}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
    </div>
    <p className="mt-1.5 text-2xl font-bold tabular-nums" style={{ color }}>{value}</p>
    {sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}
  </div>
);

/**
 * Counted against expected, said in one line.
 *
 * Zero is its own state rather than a small difference: "balanced" is the answer a desk is
 * looking for, and a green Rs.0 beside two red figures is harder to read than the word.
 */
const Variance = ({ counted, expected, testid }) => {
  const diff = round2(counted - expected);
  if (Math.abs(diff) < 0.01) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700" data-testid={testid}>
        <Check className="h-3 w-3" /> Balanced
      </span>
    );
  }
  const over = diff > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${over ? "bg-sky-50 text-sky-700" : "bg-rose-50 text-rose-700"}`}
      data-testid={testid}
    >
      {over ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {over ? "Over by " : "Short by "}{fmt(Math.abs(diff))}
    </span>
  );
};

/**
 * A day's spending, split by the mode it left in.
 *
 * Income has no matching helper on purpose: it comes back already split per day, from
 * revenue-overview's own by_day_modes. Grouping it here meant reading `transactions`,
 * which that endpoint cuts to the most recent 500 -- fine for one evening, and quietly
 * wrong across a busy month, where the earliest days would come back looking quiet
 * because their collections fell off the end of the list. Expenses are not truncated
 * that way, and carry a plain date and one mode each.
 */
const expenseByDayFrom = (expenses) => {
  const out = {};
  for (const row of expenses) {
    const day = row?.expense_date || "";
    if (!day) continue;
    const mode = row?.payment_mode || "unknown";
    out[day] = out[day] || {};
    out[day][mode] = round2((out[day][mode] || 0) + (Number(row.amount) || 0));
  }
  return out;
};

/**
 * What each mode should come to on one day: its own takings, less what was refunded or
 * paid out by it.
 *
 * Nothing carries overnight. Cash used to, on the reasoning that it is the one mode that
 * physically stays in the building — the drawer opening on what last night's count left in
 * it. It doesn't stay: the takings are banked or handed over each night, so the drawer
 * opens each morning at nothing, and carrying yesterday in asked the counter to find money
 * that had already left the building. Mirrored by _day_figures in v3_finance.py, so a day
 * read here and the same day signed off there show the same expected figure.
 */
const expectedFor = (income = {}, expense = {}) => ({
  cash: round2((income.cash || 0) - (expense.cash || 0)),
  upi: round2((income.upi || 0) - (expense.upi || 0)),
  card: round2((income.card || 0) - (expense.card || 0)),
});

const sumModes = (m) => round2((m.cash || 0) + (m.upi || 0) + (m.card || 0));
const sumAll = (m = {}) => round2(Object.values(m).reduce((a, b) => a + (Number(b) || 0), 0));

/** Who may take a signature back: the accountant, and now the branch desk for its own day
 *  -- the Undo on this tab and on Close Books. It used to be the accountant's alone; the
 *  branch asked to be able to correct a day it closed too early. What keeps that honest is
 *  that a reason is asked for and kept on the book beside the original signature. Checked
 *  on the server too (reopen_book) -- this only decides whether the button is worth showing. */
const REOPEN_ROLES = [
  "super_admin", "accountant", "business_dev",
  "branch_admin", "online_physio_admin", "online_fitness_admin",
  "branch_admin_physio", "branch_admin_fitness", "branch_admin_physio_fitness",
];
export const canReopenBooks = () => REOPEN_ROLES.includes(
  String(loadSession()?.user?.role || "").trim().toLowerCase(),
);

/** Undo a closed day: asks why, reopens it, and hands back the book as it now stands -- or
 *  null when nothing changed (no reason given, or the server said no, which it says). */
export const undoCloseBook = async ({ day, branchId }) => {
  const reason = window.prompt(`Undo the close for ${day}? The book is reopened and the count can be changed again.\n\nWhy is it being undone?`) || "";
  if (!reason.trim()) return null;
  try {
    const res = await reopenBook({ on: day, branch_id: branchId, reason: reason.trim() });
    toast.success(res?.message === "Book reopened" ? `Close undone — ${day} is open again` : res?.message || "Close undone");
    return res?.book || null;
  } catch (err) {
    toast.error(err?.response?.data?.detail || "Could not undo the close");
    return null;
  }
};

/** The Undo on a closed day, the same face wherever a closed day is listed. */
export const UndoCloseButton = ({ onClick, busy = false, size = "sm", testid }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    disabled={busy}
    title="Undo the close — reopen this day's book"
    className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 ${
      size === "sm" ? "h-7 px-2 text-[11px]" : "h-9 px-3 text-xs"
    }`}
    data-testid={testid}
  >
    <Undo2 className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
    {busy ? "Undoing..." : "Undo"}
  </button>
);

const stampedAt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/**
 * Where one evening's book stands, in a word.
 *
 * Three states rather than two. A day nobody has signed off is not the same as one that was
 * signed off and opened again, and a screen that showed both as "open" would lose the one
 * fact an auditor is looking for.
 */
const BookChip = ({ book, testid }) => {
  if (!book) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500" data-testid={testid}>
        <BookOpen className="h-3 w-3" /> Open
      </span>
    );
  }
  if (!book.closed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700" data-testid={testid}>
        <Unlock className="h-3 w-3" /> Reopened
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${
        book.matched ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
      data-testid={testid}
    >
      <BookCheck className="h-3 w-3" /> {book.matched ? "Closed · matched" : "Closed · differed"}
    </span>
  );
};

/**
 * One evening counted — the form, and the three figures the count is judged against.
 *
 * Its own component rather than the whole panel because the tab now reads back as well as
 * records: everything here is about a single named day, and the week and month views below
 * share nothing with it but the branch.
 */
const DayCount = ({ branchId, day, refreshKey, onBusy }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [yesterday, setYesterday] = useState(null);
  const [saved, setSaved] = useState(null);
  // The day's book, if it has one. Held beside the count rather than derived from it: a
  // counted day and a signed-off day are two different states, and most evenings sit in
  // the first for a while.
  const [book, setBook] = useState(null);
  const [closingBook, setClosingBook] = useState(false);
  const [income, setIncome] = useState({});
  const [expense, setExpense] = useState({});
  // The expected split as the server works it out — the same figure close_book compares
  // the count to. Preferred over the client calc below, which cannot see the branch cash
  // box; kept as the fallback for an older backend that does not send this.
  const [serverExpected, setServerExpected] = useState(null);
  // The form: the notes counted, the coins under them, and each cashless mode's amount
  // with the reference it is traced by.
  const [notes, setNotes] = useState({});
  const [coins, setCoins] = useState("");
  const [upiAmount, setUpiAmount] = useState("");
  const [upiId, setUpiId] = useState("");
  const [cardAmount, setCardAmount] = useState("");
  const [cardRef, setCardRef] = useState("");
  const [note, setNote] = useState("");

  /** Put the form back to what is stored for this day, or to blank when nothing is. */
  const fillFrom = useCallback((record) => {
    setNotes(record?.cash_denominations || {});
    setCoins(record?.cash_coins ? String(record.cash_coins) : "");
    setUpiAmount(record?.upi_amount ? String(record.upi_amount) : "");
    setUpiId(record?.upi_id || "");
    setCardAmount(record?.card_amount ? String(record.card_amount) : "");
    setCardRef(record?.card_transaction_id || "");
    setNote(record?.note || "");
  }, []);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    onBusy?.(true);
    try {
      // The stored count, and the day's own takings and spending. Asked for together
      // because the screen is the three set against each other — showing the count before
      // the figures it is judged by would flash a shortfall that is only a slow request.
      const [cb, rev, exp] = await Promise.all([
        getClosingBalance({ branch_id: branchId, on: day }),
        getRevenueOverview({ branch_id: branchId, start_date: day, end_date: day }),
        getFinanceExpenses({ branch_id: branchId, start_date: day, end_date: day }),
      ]);
      setYesterday(cb?.yesterday || null);
      setSaved(cb?.today || null);
      setBook(cb?.book || null);
      setServerExpected(cb?.expected || null);
      fillFrom(cb?.today);
      // Both sides read off the server's own split rather than re-derived here. It is the
      // same figure close_book signs the day against, so what the branch is looking at
      // when it presses Close is what gets written into the book.
      setIncome(rev?.payment_modes || {});
      setExpense(exp?.payment_modes || {});
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not load the closing balance");
    }
    setLoading(false);
    onBusy?.(false);
    // refreshKey is a dependency on purpose: it is how the toolbar's Refresh reaches in
    // here without this component owning a button of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, day, fillFrom, refreshKey]);

  useEffect(() => { load(); }, [load]);

  // Hands the toolbar's spinner back if this view is swapped out mid-fetch. Without it,
  // changing period during a load leaves Refresh spinning on a request nobody is waiting
  // for and the button disabled for the rest of the session.
  useEffect(() => () => onBusy?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const cashNotesTotal = useMemo(() => noteTotal(notes), [notes]);
  const cashCounted = round2(cashNotesTotal + (parseFloat(coins) || 0));
  const upiCounted = round2(parseFloat(upiAmount) || 0);
  const cardCounted = round2(parseFloat(cardAmount) || 0);
  const totalCounted = round2(cashCounted + upiCounted + cardCounted);

  const expected = useMemo(
    () => serverExpected || expectedFor(income, expense),
    [serverExpected, income, expense],
  );
  const totalExpected = sumModes(expected);

  const counted = { cash: cashCounted, upi: upiCounted, card: cardCounted };

  const dayIncome = useMemo(() => sumAll(income), [income]);
  const dayExpense = useMemo(() => sumAll(expense), [expense]);

  const setNote_ = (d, v) => setNotes((n) => ({ ...n, [d]: v }));

  // A closed book locks the count under it. The fields stay on screen because they are the
  // record of what was counted, but they stop taking edits -- an editable box over a
  // signed-off day is a trap that ends in a refusal from the server.
  const locked = !!book?.closed;

  // The book is signed against what is *stored*, not against what is on screen. Somebody
  // who types a correction and presses Close without saving would otherwise sign off a
  // figure nobody recorded, and the book would disagree with the count under it from the
  // moment it was written.
  const unsavedCount = !!saved && Math.abs(totalCounted - (saved.total || 0)) >= 0.01;

  const signOff = async () => {
    if (unsavedCount) {
      toast.error("Update the count first — the figures on screen are not the ones saved");
      return;
    }
    setClosingBook(true);
    try {
      const res = await closeBook({ on: day, branch_id: branchId });
      setBook(res?.book || null);
      toast.success(res?.message || "Book closed");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not close the book");
    }
    setClosingBook(false);
  };

  const reopen = async () => {
    setClosingBook(true);
    const reopened = await undoCloseBook({ day, branchId });
    if (reopened) setBook(reopened);
    setClosingBook(false);
  };

  // Refused here as well as on the server, so the desk is told before the request goes out
  // rather than after it comes back — the same rule the fee popups follow.
  const missingUpiId = upiCounted > 0 && !upiId.trim();
  const missingCardRef = cardCounted > 0 && !cardRef.trim();

  const submit = async () => {
    if (missingUpiId) { toast.error("UPI ID is required for the UPI amount counted"); return; }
    if (missingCardRef) { toast.error("Card Transaction ID is required for the card amount counted"); return; }
    setSaving(true);
    let res;
    try {
      res = await saveClosingBalance({
        on: day,
        branch_id: branchId,
        cash_denominations: countedNotes(notes) || {},
        cash_coins: parseFloat(coins) || 0,
        upi_amount: upiCounted,
        upi_id: upiId.trim(),
        card_amount: cardCounted,
        card_transaction_id: cardRef.trim(),
        note: note.trim(),
      });
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not save the closing balance");
      setSaving(false);
      return;
    }
    setSaving(false);
    toast.success(res?.message || "Closing balance saved");
    setSaved(res?.closing_balance || null);
  };

  return (
    <div className="space-y-4" data-testid="closing-balance-day">
      {saved && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700" data-testid="closing-balance-saved-chip">
          <Check className="h-3.5 w-3.5" />
          Counted by {saved.counted_by || "—"}
          {saved.updated_by && saved.updated_by !== saved.counted_by ? ` · last corrected by ${saved.updated_by}` : ""}
        </span>
      )}

      {/* The three figures the count is judged against, in the order the day runs:
          what was left last night, what came in, what went out. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure
          label="Yesterday's close"
          value={fmt(yesterday?.total || 0)}
          sub={yesterday ? `Cash ${fmt(yesterday.cash_total)} · counted by ${yesterday.counted_by || "—"}` : "No count recorded for the day before"}
          icon={Wallet}
          color="#475569"
          testid="closing-balance-yesterday"
        />
        <Figure
          label="Today's income"
          value={fmt(dayIncome)}
          sub={`Cash ${fmt(income.cash || 0)} · UPI ${fmt(income.upi || 0)} · Card ${fmt(income.card || 0)}`}
          icon={TrendingUp}
          color="#059669"
          testid="closing-balance-income"
        />
        <Figure
          label="Today's expense"
          value={fmt(dayExpense)}
          sub={`Cash ${fmt(expense.cash || 0)} · UPI ${fmt(expense.upi || 0)} · Card ${fmt(expense.card || 0)}`}
          icon={TrendingDown}
          color="#e11d48"
          testid="closing-balance-expense"
        />
      </div>

      {/* One block per mode. Each asks for its own amount and the one reference that
          makes it checkable. */}
      <div className="grid gap-3 lg:grid-cols-3">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={`closing-balance-block-${m.key}`}>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <Icon className="h-4 w-4" style={{ color: m.color }} />
                  {m.label}
                </span>
                <Variance counted={counted[m.key]} expected={expected[m.key]} testid={`closing-balance-variance-${m.key}`} />
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Expected {fmt(expected[m.key])}
                {m.key === "cash" ? " — today's cash, less what was paid out in cash" : " — today's takings, less what was refunded or paid by it"}
              </p>

              {m.key === "cash" ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Denominations</p>
                    {/* Fills the grid with the fewest notes that make the expected figure.
                        A starting point for a desk that has already counted and agrees,
                        never a substitute for counting: it is only ever what *should* be
                        there, which is the number being checked. */}
                    <button
                      type="button"
                      onClick={() => setNotes(noteBreakdown(Math.max(0, expected.cash)))}
                      className="text-[11px] font-medium text-sky-600 hover:text-sky-700"
                      data-testid="closing-balance-fill-notes"
                    >
                      Fill to expected
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {DENOMINATIONS.map((d) => (
                      <label key={d} className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-slate-400">Rs.{d}</span>
                        <Input
                          type="number"
                          min="0"
                          value={notes[d] ?? ""}
                          onChange={(e) => setNote_(d, e.target.value)}
                          disabled={locked}
                          className="h-9 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
                          data-testid={`closing-balance-note-${d}`}
                        />
                      </label>
                    ))}
                  </div>
                  <label className="block">
                    {/* Its own box because the note ladder stops at ten and a drawer does
                        not — without it a till holding Rs.7 of change could never balance. */}
                    <span className="mb-0.5 block text-[10px] font-medium text-slate-400">Coins and change (Rs.)</span>
                    <Input
                      type="number"
                      min="0"
                      value={coins}
                      onChange={(e) => setCoins(e.target.value)}
                      disabled={locked}
                      className="h-9 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
                      data-testid="closing-balance-coins"
                    />
                  </label>
                  <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                    <span className="text-[11px] text-slate-500">Notes {fmt(cashNotesTotal)}</span>
                    <span className="text-sm font-bold tabular-nums text-slate-800">{fmt(cashCounted)}</span>
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <label className="block">
                    <span className="mb-0.5 block text-[10px] font-medium text-slate-400">Amount counted (Rs.)</span>
                    <Input
                      type="number"
                      min="0"
                      value={m.key === "upi" ? upiAmount : cardAmount}
                      onChange={(e) => (m.key === "upi" ? setUpiAmount : setCardAmount)(e.target.value)}
                      disabled={locked}
                      className="h-9 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
                      data-testid={`closing-balance-amount-${m.key}`}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-[10px] font-medium text-slate-400">
                      {m.key === "upi" ? "UPI ID" : "Card Transaction ID"}
                    </span>
                    <Input
                      value={m.key === "upi" ? upiId : cardRef}
                      onChange={(e) => (m.key === "upi" ? setUpiId : setCardRef)(e.target.value)}
                      placeholder={m.key === "upi" ? "name@bank" : "Terminal batch / txn no."}
                      disabled={locked}
                      className="h-9 text-sm disabled:bg-slate-50 disabled:text-slate-500"
                      data-testid={`closing-balance-ref-${m.key}`}
                    />
                    {((m.key === "upi" && missingUpiId) || (m.key === "card" && missingCardRef)) && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-rose-600" data-testid={`closing-balance-ref-missing-${m.key}`}>
                        <AlertTriangle className="h-3 w-3" />
                        Required once there is money to trace
                      </span>
                    )}
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The whole day in one line, and the way to commit it. */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Total counted</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-slate-800" data-testid="closing-balance-total-counted">{fmt(totalCounted)}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">Expected {fmt(totalExpected)}</p>
          </div>
          <div className="pb-1.5">
            <Variance counted={totalCounted} expected={totalExpected} testid="closing-balance-variance-total" />
          </div>
          <label className="min-w-[12rem] flex-1">
            <span className="mb-0.5 block text-[10px] font-medium text-slate-400">Note (what explains a difference)</span>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Banked Rs.10,000 at 6pm"
              disabled={locked}
              className="h-9 text-sm disabled:bg-slate-50 disabled:text-slate-500"
              data-testid="closing-balance-note"
            />
          </label>
          <Button
            onClick={submit}
            disabled={saving || loading || locked}
            className="h-9 shrink-0 bg-emerald-600 text-xs hover:bg-emerald-700"
            data-testid="closing-balance-save"
          >
            <Save className="mr-1.5 h-4 w-4" />
            {saving ? "Saving..." : saved ? "Update count" : "Record closing balance"}
          </Button>
        </div>
        {/* Said plainly rather than left for a branch to find out by trying: this is a
            record that can be corrected right up until the book on it is closed. */}
        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
          {locked
            ? "This day's book is closed, so the count is fixed. Undo the close below to count it again."
            : "A count can be corrected by counting again — saving this day a second time replaces it and keeps who first counted it."}
        </p>
      </div>

      {/* Close Book — the day signed off, immediately under the count it is signed on.
          Its own card rather than a second button in the row above, because it is a
          different act: that button records what was in the drawer, this one puts a name
          to the day and says whether the money was there. */}
      <div
        className={`rounded-xl border p-4 shadow-sm ${
          book?.closed
            ? book.matched ? "border-emerald-200 bg-emerald-50/40" : "border-rose-200 bg-rose-50/40"
            : "border-slate-200 bg-white"
        }`}
        data-testid="closing-balance-book"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
            {book?.closed ? <BookLock className="h-4 w-4 text-slate-500" /> : <BookOpen className="h-4 w-4 text-slate-400" />}
            Close book
          </span>
          <BookChip book={book} testid="closing-balance-book-chip" />

          <div className="ml-auto flex items-center gap-2">
            {book?.closed ? (
              canReopenBooks() && (
                <UndoCloseButton onClick={reopen} busy={closingBook} size="md" testid="closing-balance-book-reopen" />
              )
            ) : (
              <Button
                onClick={signOff}
                disabled={closingBook || loading || !saved || unsavedCount}
                className="h-9 bg-slate-800 text-xs text-white hover:bg-slate-900 disabled:bg-slate-300"
                data-testid="closing-balance-book-close"
              >
                <Lock className="mr-1.5 h-4 w-4" />
                {closingBook ? "Closing..." : book ? "Close the book again" : "Close the book"}
              </Button>
            )}
          </div>
        </div>

        {book?.closed ? (
          <div className="mt-2 space-y-0.5">
            {/* The figures as they were signed, not as they read now. That is the whole
                reason a book stores its own totals -- see the note above CloseBookInput in
                v3_finance.py -- and showing today's figures under yesterday's signature
                would quietly undo it. */}
            <p className="text-sm font-semibold text-slate-800" data-testid="closing-balance-book-verdict">
              {book.matched
                ? "The money matched."
                : `${book.difference > 0 ? "Over" : "Short"} by ${fmt(Math.abs(book.difference))}.`}
              <span className="ml-1.5 font-normal text-slate-500">
                Counted {fmt(book.counted?.total)} against {fmt(book.expected?.total)} expected.
              </span>
            </p>
            <p className="text-[11px] text-slate-500" data-testid="closing-balance-book-signature">
              Closed by {book.closed_by || "—"}{book.closed_at ? ` · ${stampedAt(book.closed_at)}` : ""}
              {book.counted_by ? ` · counted by ${book.counted_by}` : ""}
            </p>
            {book.note ? <p className="text-[11px] italic text-slate-500">“{book.note}”</p> : null}
          </div>
        ) : (
          <div className="mt-2 space-y-0.5">
            {/* Said before it is pressed, because it is the one action on this screen that
                cannot be undone by the person taking it. */}
            <p className="text-[11px] text-slate-500" data-testid="closing-balance-book-hint">
              {!saved
                ? "Count this day first — a book cannot be signed off over a drawer nobody counted."
                : unsavedCount
                  ? "The count on screen has changed and not been saved. Update it, then close the book on what was recorded."
                  : "Signing off records what was counted against what the day says it took, with your name and the time on it, and fixes the count until the close is undone."}
            </p>
            {/* A book is closed on a difference as readily as on a match. A branch that
                cannot sign off a short evening either stops closing its books or makes the
                drawer say what the system wants, and the second is the worse failure. */}
            {saved && !book && Math.abs(totalCounted - totalExpected) >= 0.01 && (
              <p className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700" data-testid="closing-balance-book-differs">
                <AlertTriangle className="h-3 w-3" />
                This day does not balance. It can still be closed — the difference is recorded with it.
              </p>
            )}
            {book && !book.closed && (
              <p className="text-[11px] text-amber-700" data-testid="closing-balance-book-reopened">
                Reopened by {book.reopened_by || "—"}{book.reopened_at ? ` · ${stampedAt(book.reopened_at)}` : ""}
                {book.reopen_reason ? ` — “${book.reopen_reason}”` : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The evenings in a window, counted or not, each against what its own day says it took.
 *
 * A day at a time, never added into one total. Cash carries from one night to the next, so
 * a month's "total counted" would be the same drawer counted thirty times over — a figure
 * ten times the money that was ever in the building. What a range *can* be totalled on is
 * income, expense, and the daily differences, because each of those belongs to its own day
 * and to no other.
 *
 * The uncounted evenings are listed as loudly as the counted ones. A history that showed
 * only what was recorded would read as a clean month on a branch that counted twice.
 */
const ClosingBalanceHistory = ({ branchId, start, end, refreshKey, onBusy, onOpenDay }) => {
  const [history, setHistory] = useState(null);
  // The evening whose close is being undone, while the request is out.
  const [undoing, setUndoing] = useState(null);
  const [incomeByDay, setIncomeByDay] = useState({});
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!branchId || !start || !end) return;
    setLoading(true);
    onBusy?.(true);
    try {
      // The counts, and the live figures they are judged against — asked for over the
      // whole window in one request each rather than a day at a time, which on a month
      // would be ninety requests to fill one table.
      const [hist, rev, exp] = await Promise.all([
        getClosingBalanceHistory({ branch_id: branchId, start_date: start, end_date: end }),
        getRevenueOverview({ branch_id: branchId, start_date: start, end_date: end }),
        getFinanceExpenses({ branch_id: branchId, start_date: start, end_date: end }),
      ]);
      setHistory(hist);
      setIncomeByDay(rev?.by_day_modes || {});
      setExpenses(exp?.expenses || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not load the closing balances");
      setHistory(null);
      setIncomeByDay({});
      setExpenses([]);
    }
    setLoading(false);
    onBusy?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, start, end, refreshKey]);

  useEffect(() => { load(); }, [load]);

  // Hands the toolbar's spinner back if this view is swapped out mid-fetch. Without it,
  // changing period during a load leaves Refresh spinning on a request nobody is waiting
  // for and the button disabled for the rest of the session.
  useEffect(() => () => onBusy?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const undoClose = async (on) => {
    setUndoing(on);
    const reopened = await undoCloseBook({ day: on, branchId });
    setUndoing(null);
    if (reopened) load();
  };

  const expenseByDay = useMemo(() => expenseByDayFrom(expenses), [expenses]);

  // The books, by the day each belongs to. Their own map rather than folded into the
  // counts: a day can be counted and not yet signed off, which is the state most evenings
  // are in, and one lookup that answered both questions could not say so.
  const bookByDay = useMemo(() => {
    const out = {};
    for (const b of history?.books || []) out[b.on] = b;
    return out;
  }, [history]);

  // The counts, keyed by their evening. `opening` -- the last count before the window --
  // was folded in here so the first day could carry in from the night before it. Nothing
  // carries now, so it would only key a date outside the window that nothing reads.
  const countByDay = useMemo(() => {
    const out = {};
    for (const r of history?.records || []) out[r.on] = r;
    return out;
  }, [history]);

  const rows = useMemo(() => {
    // Never past today. A month range runs to the 30th from the 9th, and twenty-one
    // evenings that have not happened yet listed as "not counted" is a backlog invented
    // by a date picker.
    const last = end > todayIso() ? todayIso() : end;
    return daysBetween(start, last).map((on) => {
      const record = countByDay[on] || null;
      const book = bookByDay[on] || null;
      const income = incomeByDay[on] || {};
      const expense = expenseByDay[on] || {};
      const expected = expectedFor(income, expense);
      const liveExpected = sumModes(expected);
      // A closed day is reported as it was signed, not as it reads today. The live figure
      // is still worked out beside it so the row can say when the two have parted company
      // -- a day signed off as balanced whose income has since been back-dated is worth
      // knowing about, and it is invisible if the signature is quietly recomputed.
      const signedExpected = book?.closed ? round2(book.expected?.total || 0) : null;
      return {
        on,
        record,
        book,
        income,
        expense,
        expected,
        liveExpected,
        totalExpected: signedExpected == null ? liveExpected : signedExpected,
        drifted: signedExpected != null && Math.abs(signedExpected - liveExpected) >= 0.01,
        counted: record?.total || 0,
        dayIncome: sumAll(income),
        dayExpense: sumAll(expense),
      };
    }).reverse(); // newest first: the evening somebody is chasing is the most recent one
  }, [start, end, countByDay, bookByDay, incomeByDay, expenseByDay]);

  const summary = useMemo(() => {
    const done = rows.filter((r) => r.record);
    return {
      days: rows.length,
      counted: done.length,
      closed: rows.filter((r) => r.book?.closed).length,
      income: round2(rows.reduce((n, r) => n + r.dayIncome, 0)),
      expense: round2(rows.reduce((n, r) => n + r.dayExpense, 0)),
      // Summed only over the evenings actually counted. A night nobody counted has no
      // difference — it has no count — and folding its expected figure in as a shortfall
      // would blame a branch for a missing form rather than for missing money.
      variance: round2(done.reduce((n, r) => n + (r.counted - r.totalExpected), 0)),
      latest: done.length ? done[0] : null,
    };
  }, [rows]);

  if (loading && !history) {
    return <p className="py-12 text-center text-sm text-slate-400" data-testid="closing-balance-history-loading">Loading…</p>;
  }

  return (
    <div className="space-y-4" data-testid="closing-balance-history">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Evenings counted"
          value={`${summary.counted} of ${summary.days}`}
          sub={`${summary.closed} book${summary.closed === 1 ? "" : "s"} closed${
            summary.counted === summary.days
              ? ""
              : ` · ${summary.days - summary.counted} evening${summary.days - summary.counted === 1 ? "" : "s"} not counted`
          }`}
          icon={CalendarClock}
          color={summary.counted === summary.days ? "#059669" : "#d97706"}
          testid="closing-balance-history-counted-days"
        />
        <Figure
          label="Income in range"
          value={fmt(summary.income)}
          sub="Every collection taken in these days"
          icon={TrendingUp}
          color="#059669"
          testid="closing-balance-history-income"
        />
        <Figure
          label="Expense in range"
          value={fmt(summary.expense)}
          sub="Everything paid out in these days"
          icon={TrendingDown}
          color="#e11d48"
          testid="closing-balance-history-expense"
        />
        <Figure
          label="Net difference"
          value={fmt(summary.variance)}
          sub={summary.counted
            ? `Across the ${summary.counted} evening${summary.counted === 1 ? "" : "s"} counted`
            : "Nothing counted in this range yet"}
          icon={Wallet}
          color={Math.abs(summary.variance) < 0.01 ? "#475569" : summary.variance > 0 ? "#0284c7" : "#e11d48"}
          testid="closing-balance-history-variance"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {/* Fixed proportions rather than auto widths, the same reason the expenses table
            pins its own: left to itself the browser hands a wide screen's slack to
            whichever row holds the longest note, and the dates stop lining up. */}
        <table className="w-full min-w-[1120px] table-fixed text-xs">
          <colgroup>
            <col className="w-[12%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Evening</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">Cash</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">UPI</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">Card</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">Counted</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">Expected</th>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Difference</th>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Counted by</th>
              {/* The book, last: a day is counted before it is signed off, and the row
                  reads in the order the evening actually happens. */}
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Book</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-slate-400" data-testid="closing-balance-history-empty">
                  No days in this range yet.
                </td>
              </tr>
            ) : rows.map((r) => (
              <tr
                key={r.on}
                className={`border-t border-slate-100 align-top ${r.record ? "" : "bg-slate-50/60"}`}
                data-testid={`closing-balance-history-row-${r.on}`}
              >
                <td className="px-3 py-2.5">
                  {/* The date opens that evening's own count sheet. A month view whose
                      rows could not be opened would leave a branch reading a gap it has no
                      way to fill from where it is standing. */}
                  <button
                    type="button"
                    onClick={() => onOpenDay(r.on)}
                    className="font-medium text-slate-700 hover:text-sky-600 hover:underline"
                    data-testid={`closing-balance-history-open-${r.on}`}
                  >
                    {dayLabel(r.on)}
                  </button>
                  {r.record?.note ? (
                    <span className="mt-0.5 block text-[10px] font-normal text-slate-400">{r.record.note}</span>
                  ) : null}
                </td>
                {r.record ? (
                  <>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.record.cash_total)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.record.upi_amount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(r.record.card_amount)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{fmt(r.counted)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                      {fmt(r.totalExpected)}
                      {/* Only ever shown on a signed day: the figure above is what the book
                          says, and this is the day telling a different story since. */}
                      {r.drifted ? (
                        <span className="block text-[10px] text-amber-600" data-testid={`closing-balance-history-drift-${r.on}`}>
                          now {fmt(r.liveExpected)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <Variance counted={r.counted} expected={r.totalExpected} testid={`closing-balance-history-variance-${r.on}`} />
                    </td>
                    <td className="break-words px-3 py-2.5 text-slate-500">
                      {r.record.counted_by || "—"}
                      {r.record.updated_by && r.record.updated_by !== r.record.counted_by ? (
                        <span className="block text-[10px] text-slate-400">corrected by {r.record.updated_by}</span>
                      ) : null}
                    </td>
                    <td className="break-words px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <BookChip book={r.book} testid={`closing-balance-history-book-${r.on}`} />
                        {r.book?.closed && canReopenBooks() && (
                          <UndoCloseButton
                            onClick={() => undoClose(r.on)}
                            busy={undoing === r.on}
                            testid={`closing-balance-history-undo-${r.on}`}
                          />
                        )}
                      </div>
                      {r.book ? (
                        <span className="mt-0.5 block text-[10px] text-slate-400">
                          {r.book.closed
                            ? `${r.book.closed_by || "—"}${r.book.closed_at ? ` · ${stampedAt(r.book.closed_at)}` : ""}`
                            : `by ${r.book.reopened_by || "—"}${r.book.reopen_reason ? ` — ${r.book.reopen_reason}` : ""}`}
                        </span>
                      ) : null}
                    </td>
                  </>
                ) : (
                  <>
                    {/* An evening nobody counted has no figures of its own, so the row says
                        so once rather than printing five zeroes that read as a day the
                        branch took nothing. What the day *should* have held is still shown,
                        because that is the number whoever counts it late will be working
                        to. */}
                    <td className="px-3 py-2.5 text-slate-400" colSpan={4}>
                      Not counted
                      {/* A day nothing moved on is a different silence from a busy day
                          nobody counted, and reading a month a branch is chasing, that is
                          the difference between a gap and a problem. */}
                      {r.dayIncome === 0 && r.dayExpense === 0 ? (
                        <span className="text-slate-300"> · nothing taken or paid out</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmt(r.totalExpected)}</td>
                    <td className="px-3 py-2.5" colSpan={3}>
                      <button
                        type="button"
                        onClick={() => onOpenDay(r.on)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
                        data-testid={`closing-balance-history-count-${r.on}`}
                      >
                        <Save className="h-3 w-3" /> Count this evening
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        A range lists its evenings rather than adding them up: cash carries from one night into the next, so a month
        of counts summed together would be the same drawer counted thirty times.
      </p>
    </div>
  );
};

/**
 * Closing Balance — what the desk holds when it shuts, against what the day says it took.
 *
 * One branch, and either one evening or a run of them, over Accountant Manage's own date
 * range like every other tab on it. A window of one day -- Today, Yesterday, or a custom
 * range of a single date -- is that evening's count, the form. A longer one reads its
 * evenings back. All has no window to read, so it opens on tonight's count, which is what
 * the desk comes to this tab to do.
 *
 * `expected` is worked out here rather than stored on the record — see the note above
 * save_closing_balance in v3_finance.py.
 *
 * @param branchId   The branch whose drawer this is. Required — "All Branches" has no
 *                   drawer to count, and the panel says so rather than adding four
 *                   branches' cash into one meaningless total.
 * @param start/end  The range from the filter at the top, both empty on All.
 * @param refreshKey That row's Refresh.
 * @param onPickDay  Narrows the top filter to one day, for a row in the history that opens
 *                   its own evening -- the only window a count can be recorded in.
 */
export const ClosingBalancePanel = ({ branchId, start = "", end = "", refreshKey = 0, onPickDay }) => {
  const single = !start || !end || start === end;
  const day = start || end || todayIso();

  if (!branchId) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 py-12 text-center" data-testid="closing-balance-no-branch">
        <Wallet className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm font-medium text-slate-600">Pick a branch to close its day</p>
        <p className="mt-1 text-xs text-slate-400">
          A closing balance is one drawer counted at one desk. Every branch has its own, so there is nothing to count across all of them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="closing-balance-panel">
      {/* Which evening, or which run of them -- the filter at the top sets it, and this
          says what that came to, since the count form below never names its own day. */}
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600" data-testid="closing-balance-window">
        <CalendarDays className="h-3.5 w-3.5 text-emerald-600" />
        {single ? (
          <>Closing day: <span className="font-semibold text-slate-800">{isoToManual(day)}</span></>
        ) : (
          <>Evenings from <span className="font-semibold text-slate-800">{isoToManual(start)}</span> to <span className="font-semibold text-slate-800">{isoToManual(end)}</span></>
        )}
      </p>

      {single ? (
        <DayCount branchId={branchId} day={day} refreshKey={refreshKey} />
      ) : (
        <ClosingBalanceHistory
          branchId={branchId}
          start={start}
          end={end}
          refreshKey={refreshKey}
          onOpenDay={(on) => onPickDay?.(on)}
        />
      )}
    </div>
  );
};
