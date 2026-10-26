import { useEffect, useSyncExternalStore } from "react";
import { getPaymentModeVisibility } from "@/lib/api";

// The tender set every collection flow already writes into its "... via X" wording
// (see _parse_payment_mode in v3_finance.py), plus "unknown" for the rows that carry
// none — package_sold, and any Expense logged before payment_mode existed.
//
// Shared by every board that splits money by tender — Expense (ExpenseBoard), Accountant
// Manage's own payment-mode row, and FinanceBoard/FinanceOverviewBoard, which no board
// renders any more — rather than copied into each: the four tiles the branch reads as
// "Cash, Cheque, Bank, UPI" have to say the same thing in the same order wherever they
// appear, and a label changed in one place and not the others is how a bank transfer
// starts reading as "Account_transfer" on one tab and "Bank" on the next.
export const PAYMENT_MODE_ORDER = ["cash", "cheque", "account_transfer", "upi", "card", "unknown"];

export const PAYMENT_MODE_LABELS = {
  cash: "Cash",
  cheque: "Cheque",
  account_transfer: "Bank",
  upi: "UPI",
  card: "Card",
  unknown: "Other",
};

export const PAYMENT_MODE_COLORS = {
  cash: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200" },
  cheque: { text: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200" },
  account_transfer: { text: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200" },
  upi: { text: "text-violet-700", bg: "bg-violet-50", border: "border-violet-200" },
  card: { text: "text-pink-700", bg: "bg-pink-50", border: "border-pink-200" },
  unknown: { text: "text-slate-600", bg: "bg-slate-50", border: "border-slate-200" },
};

// The modes a branch can actually pick when logging an expense — "unknown" is only ever
// something Income's own unlabelled rows fall back to, never a choice on a form.
export const EXPENSE_PAYMENT_MODE_OPTIONS = ["cash", "cheque", "account_transfer", "upi", "card"];

// `modes` is the raw {mode: amount} map either board's summary returns. Always renders
// Cash, Cheque, Bank and UPI — the four the branch asked for, in that fixed order, so the
// row doesn't reshuffle depending on what happened to be collected that day — then Card
// and Other only when they actually carry money, so an empty tile isn't shown for a tender
// this branch never takes.
export const orderedPaymentModeEntries = (modes) => {
  const map = modes || {};
  const primary = ["cash", "cheque", "account_transfer", "upi"];
  const rest = PAYMENT_MODE_ORDER.filter((m) => !primary.includes(m) && (map[m] || 0) > 0);
  return [...primary, ...rest].map((mode) => [mode, map[mode] || 0]);
};

// ------------------------------------------------- Payment Modes Show / Hide
//
// The modes a developer has hidden in Developer Access. A hidden mode comes off every
// Payment Mode picker; records already paid in it, the report tiles and the filters keep it.
// Read once per page load, on the first picker drawn, and refreshed by the Developer Access
// switches themselves when they change it.
let hiddenModes = [];
let loaded = false;
const listeners = new Set();

export const setHiddenPaymentModes = (list) => {
  hiddenModes = Array.isArray(list) ? [...list] : [];
  loaded = true;
  listeners.forEach((fn) => fn());
};

const subscribe = (fn) => {
  listeners.add(fn);
  if (!loaded) {
    loaded = true;
    getPaymentModeVisibility().then((r) => setHiddenPaymentModes(r?.hidden)).catch(() => { loaded = false; });
  }
  return () => listeners.delete(fn);
};

/** The hidden modes, re-rendering the caller when they change. */
export const useHiddenPaymentModes = () => useSyncExternalStore(subscribe, () => hiddenModes);

/** `list` without the hidden modes. Items can be mode strings, or objects carrying the mode
 *  as `value` (or `key`). Anything that is not a mode -- Partial Payment, "Nothing collected"
 *  -- passes through. */
export const withoutHiddenModes = (list, hidden) => (list || []).filter((m) => {
  const mode = typeof m === "string" ? m : (m.value ?? m.key);
  return !hidden.includes(mode);
});

/** Hook form of the two above: the list as a picker should draw it. */
export const useShownPaymentModes = (list) => withoutHiddenModes(list, useHiddenPaymentModes());

const modeOf = (m) => (typeof m === "string" ? m : (m.value ?? m.key));

/** Keeps a picker off a hidden mode: when `mode` is one the developer hid (every form opens
 *  on Cash), `setMode` is handed the first mode still shown. An empty `mode` (Not paid yet)
 *  is left alone. */
export const useKeepModeShown = (mode, shown, setMode) => {
  const first = shown[0] ? modeOf(shown[0]) : null;
  const stray = !!mode && !!first && !shown.some((m) => modeOf(m) === mode);
  useEffect(() => {
    if (stray) setMode(first);
  }, [stray]); // eslint-disable-line react-hooks/exhaustive-deps
};

/** The same for a list of payment lines, each carrying its own `mode`. */
export const useKeepLinesShown = (lines, shown, setLines) => {
  const first = shown[0] ? modeOf(shown[0]) : null;
  const isShown = (mode) => shown.some((m) => modeOf(m) === mode);
  const stray = !!first && (lines || []).some((l) => l.mode && !isShown(l.mode));
  useEffect(() => {
    if (stray) setLines(lines.map((l) => (l.mode && !isShown(l.mode) ? { ...l, mode: first, reference: "", notes: {} } : l)));
  }, [stray]); // eslint-disable-line react-hooks/exhaustive-deps
};
