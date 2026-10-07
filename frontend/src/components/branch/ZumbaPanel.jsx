import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, IndianRupee, Pencil, Plus, RefreshCw, Stethoscope, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import { listZumba, listZumbaMasters, setZumbaMasterSlot, addZumba, updateZumba, deleteZumba, setZumbaStatus, acceptZumbaReferral, renewZumba, collectZumba, listStoreItems } from "@/lib/api";

// How a registration arrived, as the branch would say it. A referral is recorded against
// the master who made it rather than against a single "Masters" bucket, so these six are
// the answers that stand on their own; the masters are offered alongside them by name.
//
// Everything but Consultation and Zumba Master counts towards Direct: nobody referred
// them, they came to us. Those two name whoever did the refer, and land on Consultant and
// Refer Master. The mapping lives on the server, which stamps each row with its card so
// this list and the counts cannot disagree.
const SOURCES = [
  { key: "branch", label: "Branch Admin" },
  { key: "board", label: "Board" },
  { key: "consultations", label: "Consultation" },
  { key: "social_media", label: "Social Media" },
  { key: "personal", label: "Personal Brand (Sumaiya Naaz)" },
  { key: "fitsiomax", label: "Fitsiomax" },
];
const MASTER = "master";

// The two slots the class is taught in. Kept in step with TIME_SLOTS in
// backend/routers/v3_zumba.py, which drops anything it does not recognise.
// Exported because MANAGEMENT rosters the same two classes. These strings are matched
// character for character against TIME_SLOTS in backend/routers/v3_zumba.py — a second
// copy that drifted would send a slot the server rejects and match no holder here.
export const TIME_SLOTS = ["10:00 am - 11:00 am", "11:00 am - 12:00 pm"];
// The same four the consultation and store desks offer, in the same slugs, so a class
// fee taken in cash reads as cash wherever the money is counted later. Cheque and Partial
// belong to a treatment plan paid down over months; a membership is settled in one go.
const PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "account_transfer", label: "Account Transfer" },
];
// The date row, in the shape DateFilterPopover hands back so the two controls write one
// piece of state. "All" is null rather than an open-ended range: the absence of a filter
// and a filter that happens to match everything read the same on screen but not in the
// code, and null is the one the rest of this panel already understands.
//
// The week runs Monday to Sunday, matching DashboardBoard's row rather than the Sunday
// start used elsewhere -- a class week is the week a branch talks about.
const startOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const endOfDay = (d) => { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; };
const mondayOf = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

const DATE_PRESETS = [
  { key: "all", label: "All", range: () => null },
  { key: "today", label: "Today", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { key: "this_week", label: "This Week", range: () => { const m = mondayOf(new Date()); const e = new Date(m); e.setDate(e.getDate() + 6); return { from: m, to: endOfDay(e) }; } },
  { key: "this_month", label: "This Month", range: () => { const t = new Date(); return { from: startOfDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: endOfDay(new Date(t.getFullYear(), t.getMonth() + 1, 0)) }; } },
];
const presetFilter = (p) => { const r = p.range(); return r ? { key: p.key, label: p.label, ...r } : null; };

/** Whether a stored filter came from one of the pills above rather than the Custom dialog,
 *  which is how the Custom pill knows to stay quiet while a preset is the active one. */
const isPreset = (f) => !f || DATE_PRESETS.some((p) => p.key === f.key);

/** The stored timestamp as a plain YYYY-MM-DD, which is what the date inputs compare. */
const dayOf = (iso) => String(iso || "").slice(0, 10);

const PAYMENT_MODE_LABELS = { ...Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label])), split: "Split" };

// The modes that leave a trail somewhere else, and what that trail is called. A UPI ID and
// a transaction number are different kinds of thing, so the field asks for the one it
// wants rather than a generic "reference" the desk has to interpret. Cash is absent
// because cash leaves no trail — kept in step with REFERENCE_LABELS in
// backend/routers/v3_zumba.py, which refuses a save that arrives without one.
// The three a Zumba fee is taken by at the desk, and All Modes over them.
//
// Account Transfer is still a mode -- the form offers it and the Fee column names it -- it
// just has no pill here, because a class fee handed over at the counter is cash, UPI or a
// card and filtering by the fourth found nothing. "Nothing collected" went the same way:
// Due Payment above already answers who has not paid, and better, since it knows what is
// owed rather than only that nothing came in.
/** "1 customer" / "3 customers", for a caption that reads as a sentence rather than as a
 *  number with a noun bolted on. */
const pluralCustomers = (n) => `${n} customer${n === 1 ? "" : "s"}`;

const MODE_FILTERS = [
  ["", "All Modes"],
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["card", "Card"],
  ["account_transfer", "Bank Transfer"],
  // A payment that arrived more than one way is its own answer, not a missing one — and
  // without a pill it was the one kind of row the filter row could not find.
  ["split", "Split"],
];

const REFERENCE_LABELS = { upi: "UPI ID", card: "Transaction ID", account_transfer: "Transaction ID" };

// A membership is sold by the month — 12 classes in each. The shelf holds the per-class
// rate, so the price a customer is quoted is that rate across the whole plan, rounded back
// to the figure that was typed when the package was priced.
const CLASSES_PER_MONTH = 12;

/** "06 Aug 2026" off the stored ISO timestamp; a dash rather than "Invalid Date". */
const shortDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};
const REFERENCE_PLACEHOLDERS = { upi: "name@bank", card: "Transaction number", account_transfer: "Transaction number" };

// The notes a class fee is actually handed over in, largest first — the order a drawer is
// emptied in. Kept in step with DENOMINATIONS in backend/routers/v3_zumba.py, which drops
// a count in anything else. Shorter than the Fitness desk's list on purpose: the 2000 is
// out of circulation, and nobody counts a 3,000 rupee membership out in fives.
const DENOMINATIONS = [500, 200, 100, 50];

const EMPTY_LINE = { mode: "cash", amount: "", reference: "", notes: {} };

/** When a term starting on `from` and running `classes` long would finish, as YYYY-MM-DD.
 *
 * A preview only. The server works this out for every row that has been saved and sends it
 * back as finish_on, which is what every column reads; this exists so the form can answer
 * the question before there is a row to ask it about. Kept to the same rule — a month per
 * twelve classes, clamping rather than spilling on a short month — so the preview and the
 * saved answer agree.
 */
const finishPreview = (from, classes) => {
  const total = Number(classes) || 0;
  if (!from || !total || total % CLASSES_PER_MONTH !== 0) return "";
  const start = new Date(`${from}T00:00:00`);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start);
  end.setMonth(end.getMonth() + total / CLASSES_PER_MONTH);
  if (end.getDate() !== start.getDate()) end.setDate(0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
};

/** What one payment line comes to.
 *
 * Counted notes settle it rather than sitting beside it: two numbers that can disagree is
 * one number nobody trusts, and the count is the one somebody actually looked at.
 */
const noteTotal = (l) => DENOMINATIONS.reduce((sum, d) => sum + d * (Number(l?.notes?.[d]) || 0), 0);
const lineTotal = (l) => (l?.mode === "cash" && noteTotal(l) > 0 ? noteTotal(l) : Number(l?.amount) || 0);

// Moved above their first use. They sat below it, which runs perfectly well —
// module-level consts are initialised before any of these functions are called — but
// no-use-before-define is an error here, and the build stopped.


/** One labelled line of the detail popup. A blank reads as a dash rather than as nothing,
 *  so a gap in the record is visible instead of invisible. */
// Above ViewRegistrationModal, which reads both. A const is not hoisted, so writing
// them below the modal that prints a fee and a date left them undefined at the line
// that needed them.
const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/** The first line a payment that is missing its reference. Used before a save so the desk
 *  is told which line is short, rather than being handed the server's answer a round trip
 *  later. A split can have one traceable half and one not: the cash needs nothing and the
 *  UPI still needs its ID. */
const lineMissingReference = (lines) => (lines || []).find(
  (l) => lineTotal(l) > 0 && REFERENCE_LABELS[l.mode] && !(l.reference || "").trim(),
);

/** The payment lines a dialog sends, in the shape the server settles from. */
const paymentPayload = (lines) => (lines || [])
  .filter((l) => lineTotal(l) > 0)
  .map((l) => ({
    mode: l.mode,
    amount: lineTotal(l),
    reference: (l.reference || "").trim(),
    // Only for cash, and only what was actually counted — an empty map would read as
    // "counted nothing" rather than "did not count".
    denominations: l.mode === "cash" && noteTotal(l) > 0
      ? Object.fromEntries(DENOMINATIONS.filter((d) => Number(l.notes?.[d]) > 0).map((d) => [String(d), Number(l.notes[d])]))
      : undefined,
  }));

const linesTotal = (lines) => (lines || []).reduce((sum, l) => sum + lineTotal(l), 0);


const GENDERS = [
  { key: "female", label: "Female" },
  { key: "male", label: "Male" },
  { key: "other", label: "Other" },
];

const planLabel = (item) => {
  const classes = item.sessions_offline || item.sessions_online || 0;
  const months = classes && classes % CLASSES_PER_MONTH === 0 ? classes / CLASSES_PER_MONTH : null;
  return months ? `${months} Month${months > 1 ? "s" : ""}` : item.name;
};
/** What a package costs, in the terms its own shelf is priced in.
 *
 * A course shelf — Rehab, Fitness — holds the whole fee exactly as it was typed, so it is
 * read straight back. Every other shelf holds a per-session rate and the total is that
 * rate times the count.
 *
 * `price_is_total` is read off the item rather than inferred from its category, which is
 * what lets a row the startup conversion has not reached yet still be read the way it was
 * written. Kept in step with packageTotal in PackagesBoard.jsx, which prices the shelf,
 * and PRICE_IS_TOTAL_CATEGORIES in backend/routers/v3_store.py, which marks it.
 */
const planTotal = (item) => {
  const price = Number(item?.price_offline ?? item?.price_online) || 0;
  if (item?.price_is_total) return Math.round(price);
  return Math.round(price * (item?.sessions_offline || item?.sessions_online || 0));
};

/**
 * Money against a balance already owed.
 *
 * Separate from the edit form on purpose: editing a registration is changing what it says,
 * while this is recording something that happened at the counter. A desk taking the second
 * half of a fee should not have to open a form full of the customer's age and gender to do
 * it, and should not be able to change those by accident on the way past.
 *
 * Refuses more than is outstanding, and says so before the round trip. Taking more than
 * the balance means one of the two figures is wrong, and quietly keeping the difference
 * hides which.
 */
const CollectDueModal = ({ row, onClose, onCollected }) => {
  const outstanding = Math.max(0, Number(row.fee_amount || 0) - Number(row.fee_paid || 0));
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);

  const taking = linesTotal(lines);
  const over = taking > outstanding;
  const remaining = Math.max(0, outstanding - taking);

  const submit = async () => {
    if (taking <= 0) { toast.error("Enter an amount to collect"); return; }
    if (over) { toast.error(`That is ${rupees(taking)} against ${rupees(outstanding)} outstanding`); return; }
    const missingRef = lineMissingReference(lines);
    if (missingRef) { toast.error(`Enter the ${REFERENCE_LABELS[missingRef.mode]}`); return; }
    setSaving(true);
    try {
      const res = await collectZumba(row.id, paymentPayload(lines));
      // The server's own sentence, so what the branch reads back is what was recorded.
      toast.success(res?.message || "Payment collected");
      onCollected();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not collect");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" data-testid="zumba-collect-dialog">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Collect from {row.name}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {row.package_name ? `${row.package_name} · ` : ""}
              Fee {rupees(row.fee_amount)} · Collected {rupees(row.fee_paid)} ·{" "}
              <b className="text-rose-600">{rupees(outstanding)} due</b>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
            title="Close"
            aria-label="Close"
            data-testid="zumba-collect-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <PaymentLinesEditor
            lines={lines}
            onChange={setLines}
            prefix="zumba-collect"
            emptyNote="Add how the money arrived."
          />

          <div className={`rounded-lg border p-3 ${over ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-600">Collecting now</span>
              <span className={`text-lg font-extrabold ${over ? "text-rose-700" : "text-emerald-700"}`} data-testid="zumba-collect-total">
                {rupees(taking)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-600" data-testid="zumba-collect-summary">
              {over
                ? `That is more than the ${rupees(outstanding)} outstanding.`
                : remaining > 0
                  ? `${rupees(remaining)} will still be due after this.`
                  : taking > 0 ? "This clears the balance." : "Nothing entered yet."}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose} data-testid="zumba-collect-cancel">Cancel</Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={saving || over || taking <= 0} onClick={submit} data-testid="zumba-collect-save">
            {saving ? "Saving…" : "Collect"}
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * Another term on a membership that is nearly up.
 *
 * Asks the two things a renewal is: which plan they are going back on, and what they have
 * handed over for it. Everything else about the customer is already known and is not asked
 * again — a renewal is not a second registration.
 *
 * When the new term starts is the server's to decide, not this dialog's: it runs on from
 * the end of the current one, so a member renewing early keeps the days they paid for.
 */
const RenewMembershipModal = ({ row, packages, onClose, onRenewed }) => {
  const [pick, setPick] = useState(null);
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);

  const collected = linesTotal(lines);
  const price = pick ? planTotal(pick) : 0;

  const submit = async () => {
    if (!pick) { toast.error("Pick the membership they are renewing on"); return; }
    const missingRef = lineMissingReference(lines);
    if (missingRef) { toast.error(`Enter the ${REFERENCE_LABELS[missingRef.mode]}`); return; }
    setSaving(true);
    try {
      const res = await renewZumba(row.id, {
        package_id: pick.id,
        package_name: pick.name,
        package_sessions: pick.sessions_offline || pick.sessions_online || null,
        fee_amount: price,
        payment_lines: paymentPayload(lines),
      });
      // The server's own sentence, so what the branch reads back is what was recorded.
      toast.success(res?.message || "Membership renewed");
      onRenewed();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not renew");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" data-testid="zumba-renew-dialog">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Renew {row.name}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {row.package_name ? `${row.package_name} · ` : ""}
              {row.finish_on ? `runs out ${shortDate(row.finish_on)}` : "no end date on the current term"}
              {typeof row.classes_left === "number" ? ` · ${row.classes_left} ${row.classes_left === 1 ? "class" : "classes"} left` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
            title="Close"
            aria-label="Close"
            data-testid="zumba-renew-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="space-y-2">
            <FieldLabel>Renewing On</FieldLabel>
            <PackagePicker
              packages={packages}
              selectedId={pick?.id}
              onPick={setPick}
              prefix="zumba-renew-package"
            />
          </div>

          <div className="space-y-2">
            <FieldLabel>Fee Collected</FieldLabel>
            <PaymentLinesEditor
              lines={lines}
              onChange={setLines}
              prefix="zumba-renew"
              emptyNote="Nothing collected yet. A renewal can be recorded now and paid for later."
            />
          </div>

          {pick && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs" data-testid="zumba-renew-summary">
              <div className="flex items-center justify-between font-semibold text-slate-700">
                <span>This term</span>
                <span className="text-emerald-700">{rupees(price)}</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-600">
                {collected >= price ? "Paid up front." : `${rupees(price - collected)} of it will be outstanding.`}
                {" The new term runs on from "}
                {row.finish_on ? shortDate(row.finish_on) : "today"}.
              </p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose} data-testid="zumba-renew-cancel">Cancel</Button>
          <Button size="sm" className="bg-sky-600 hover:bg-sky-700" disabled={saving} onClick={submit} data-testid="zumba-renew-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
};

/** How many classes a plan holds, and how many months that is. */
const planClasses = (item) => Number(item?.sessions_offline || item?.sessions_online || 0);
const planMonths = (item) => {
  const classes = planClasses(item);
  return classes && classes % CLASSES_PER_MONTH === 0 ? classes / CLASSES_PER_MONTH : 0;
};

/**
 * The shelf, priced.
 *
 * The term, what it costs, and how many classes that buys — the three things a desk is
 * asked when it quotes one. What the plan divides down to a month and a class used to sit
 * under that; it is gone, because nothing can be bought at those rates and a card offering
 * four figures where three are for sale reads as a price list with two prices on it.
 */
const PackagePicker = ({ packages, selectedId, onPick, prefix }) => {
  if (packages.length === 0) {
    return (
      <p className="rounded-md bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500" data-testid={`${prefix}-empty`}>
        No Zumba memberships on the shelf yet. Add them in Services and Products → Zumba Class.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-3" data-testid={`${prefix}s`}>
      {packages.map((item) => {
        const on = selectedId === item.id;
        const total = planTotal(item);
        const classes = planClasses(item);
        const months = planMonths(item);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(on ? null : item)}
            className={`rounded-lg border p-3 text-left transition ${
              on
                ? "border-emerald-600 bg-emerald-600 text-white shadow-sm"
                : "border-emerald-100 bg-emerald-50/60 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-50"
            }`}
            title={item.name}
            data-testid={`${prefix}-${item.id}`}
          >
            <span className="block text-xs font-bold uppercase tracking-wide opacity-80">{planLabel(item)}</span>
            <span className="mt-1 block text-lg font-extrabold leading-none">{rupees(total)}</span>
            {classes ? (
              <span className={`mt-1.5 block text-[11px] ${on ? "text-white/80" : "text-emerald-700/70"}`}>
                {classes} classes{months ? ` · ${CLASSES_PER_MONTH} a month` : ""}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

/** The one dropdown shape this form uses, so six of them cannot drift into six looks. */
const FormSelect = ({ value, onChange, children, testid }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="h-10 w-full rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
    data-testid={testid}
  >
    {children}
  </select>
);

const FieldLabel = ({ children }) => (
  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</label>
);
/**
 * How a payment arrived, line by line.
 *
 * One editor for the three places money is taken — registering a customer, renewing them,
 * and collecting what is still due. They ask the identical question and were three copies
 * of the identical answer, which is three places for the denominations or the reference
 * rule to drift apart.
 *
 * State lives with the caller: each of the three keeps its lines somewhere different, and
 * a component that owned them would have to be told which.
 */
const PaymentLinesEditor = ({ lines, onChange, prefix, emptyNote }) => {
  const setLine = (i, patch) => onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  // A second line starts on UPI rather than cash: somebody adding one has already taken
  // the cash part, and the common split is cash plus something else.
  const addLine = () => onChange([...lines, lines.length === 0 ? { ...EMPTY_LINE } : { ...EMPTY_LINE, mode: "upi" }]);
  const dropLine = (i) => onChange(lines.filter((_, n) => n !== i));

  return (
    <>
      {lines.length === 0 ? (
        <p className="rounded-md bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">{emptyNote}</p>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="rounded-lg border border-slate-200 p-3" data-testid={`${prefix}-line-${i}`}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[140px] flex-1">
                <FieldLabel>Paid By</FieldLabel>
                <FormSelect value={l.mode} onChange={(v) => setLine(i, { mode: v, notes: {}, reference: "" })} testid={`${prefix}-mode-${i}`}>
                  {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </FormSelect>
              </div>
              <div className="min-w-[110px] flex-1">
                <FieldLabel>Amount</FieldLabel>
                <Input
                  type="number"
                  min="0"
                  value={l.mode === "cash" && noteTotal(l) > 0 ? noteTotal(l) : l.amount}
                  onChange={(e) => setLine(i, { amount: e.target.value })}
                  // Counted notes drive the figure, so the box shows the count rather than
                  // inviting a second, different number beside it.
                  readOnly={l.mode === "cash" && noteTotal(l) > 0}
                  className={l.mode === "cash" && noteTotal(l) > 0 ? "bg-slate-50" : ""}
                  data-testid={`${prefix}-amount-${i}`}
                />
              </div>
              {REFERENCE_LABELS[l.mode] && (
                <div className="min-w-[150px] flex-1">
                  <FieldLabel>{REFERENCE_LABELS[l.mode]}</FieldLabel>
                  <Input
                    value={l.reference}
                    onChange={(e) => setLine(i, { reference: e.target.value })}
                    placeholder={REFERENCE_PLACEHOLDERS[l.mode]}
                    data-testid={`${prefix}-reference-${i}`}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => dropLine(i)}
                className="mb-1 rounded p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                title="Remove this payment"
                aria-label="Remove this payment"
                data-testid={`${prefix}-drop-${i}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {/* Counted notes, so the drawer can be reconciled against the row rather than
                against somebody's memory of it. Optional: leaving them blank and typing
                the amount is still a payment. */}
            {l.mode === "cash" && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Notes counted
                  <span className="ml-1 font-normal normal-case text-slate-400">— leave blank to just type the amount</span>
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {DENOMINATIONS.map((d) => (
                    <div key={d}>
                      <label className="mb-0.5 block text-center text-[11px] font-bold text-slate-500">₹{d}</label>
                      <Input
                        type="number"
                        min="0"
                        value={l.notes?.[d] ?? ""}
                        onChange={(e) => setLine(i, { notes: { ...l.notes, [d]: e.target.value } })}
                        className="h-9 px-1 text-center text-sm"
                        data-testid={`${prefix}-note-${i}-${d}`}
                      />
                    </div>
                  ))}
                </div>
                {noteTotal(l) > 0 && (
                  <p className="mt-2 text-right text-[11px] text-slate-500" data-testid={`${prefix}-note-total-${i}`}>
                    {DENOMINATIONS.filter((d) => Number(l.notes?.[d]) > 0).map((d) => `${l.notes[d]}×₹${d}`).join("  +  ")}
                    {" = "}<b className="text-slate-700">{rupees(noteTotal(l))}</b>
                  </p>
                )}
              </div>
            )}
          </div>
        ))
      )}
      <Button type="button" variant="outline" size="sm" onClick={addLine} data-testid={`${prefix}-add`}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {lines.length === 0 ? "Add Payment" : "Another Payment Mode"}
      </Button>
    </>
  );
};



const sourceLabel = (r) => (
  r.source === MASTER
    ? "Refer Master"
    : (SOURCES.find((s) => s.key === r.source) || { label: "Personal" }).label
);

/** The referring master's name, for the tooltip. The column says the channel; which master
 *  it was is the detail behind it, and printing it in place of the channel put a person's
 *  name in a column of channels — next to an Assignee column holding another person's
 *  name, where the two read as each other. */
const sourceDetail = (r) => (r.source === MASTER && r.master_name ? `Refer Master · ${r.master_name}` : sourceLabel(r));

// The strip, in the order asked for. Styled like the Human Resource board's stage cards:
// a white card each, the name in its own colour above the count, and the selected one
// picked out by taking that colour into its border and a wash of it behind.
//
// The tinted boxes that used to group these are gone with the style. They were doing the
// work the colours now do, and a group box inside a row of cards that each carry their own
// colour reads as two systems arguing about the same thing.
//
// The colours run warm through the sources and cool through the four that follow, so the
// two halves of the row stay legible without drawing a box around either.
const CARDS = [
  { key: "all", label: "All", color: "#9333ea" },
  { key: "direct", label: "Direct", color: "#ca8a04" },
  { key: "consultant", label: "Consultant", color: "#ea580c" },
  // Master is the leads a master brought in — a referral filed against a named master,
  // which is what the Zumba Master View's Refer Customer writes and what this card is
  // asked for. It held the branch-sourced count until that board existed and there was a
  // real master's referral to point it at.
  { key: "masters", label: "Refer Master", color: "#0284c7" },
  // The last four are counts of people, like the four before them, but they answer what
  // became of a customer rather than where they came from: is the money settled, and are
  // they still turning up. The revenue split that used to sit here said the same thing
  // three times over and answered neither.
  //
  // Payment Done is a settled account, not "has paid something" — a customer halfway
  // through a 3,000 rupee membership belongs on Due Payment, which is the card somebody
  // acts on. A row with no fee on it yet is on neither: nothing has been sold.
  // These two answer in money rather than headcount. "Two customers have paid" is not what
  // a branch wants off a card about payment, and two owing 500 between them is a different
  // afternoon from one owing 9,000. The count moves into the caption, where it is still
  // read but is no longer the answer.
  //
  // Payment Done is the one card that opens rather than filters — see PaymentDoneModal.
  // It spent a while filtering like its neighbours, and on a branch where nobody had paid
  // yet a press on it emptied the list and said nothing else; the branch asked for the
  // details back. The list underneath has a column for none of what the figure is made of.
  //
  // Every card on the strip wears the Fitness tab's card (ui/stat-tile with `arrow`).
  { key: "payment_done", label: "Payment Done", color: "#059669", money: "fee_total", count: "fee_collected", countSub: (n) => `collected from ${n}` },
  { key: "due_payment", label: "Due Payment", color: "#d97706", money: "due_total", count: "due_payment", countSub: (n) => `owed by ${n}` },
  // One card, not two: Discontinue and Leave are both "not turning up", and splitting
  // them across the row asked the branch to read two numbers to learn one thing. The
  // distinction survives where it is actually useful — on the row, which says which — and
  // the server still counts them apart, so nothing downstream is coarsened by this.
  { key: "discontinued", label: "Discontinue", color: "#e11d48", sum: ["discontinued", "leave"] },
];

// Stage colours are stored as #rrggbb; anything else falls back to the card's own colour
// rather than drawing the figure and ring in a colour the browser cannot read.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const amountDue = (r) => Number(r?.fee_amount || 0) - Number(r?.fee_paid || 0);

const STATUS_LABELS = { discontinued: "Discontinued", leave: "On leave" };



const DetailRow = ({ label, value }) => (
  <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-1.5 last:border-b-0">
    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
    <span className="min-w-0 break-words text-right text-xs font-medium text-slate-700">{value || "—"}</span>
  </div>
);

/** Half of a class's takings are its master's. Kept in step with MASTER_SHARE in
 *  backend/routers/v3_zumba.py — the two work the same rows, and a split here that
 *  disagreed with the server's would be somebody's pay disagreeing with itself. */
const MASTER_SHARE = 0.5;

const paidOf = (r) => Number(r?.fee_paid || 0);
const slotOf = (r) => String(r?.time_slot || "").trim();
const sumPaid = (list) => list.reduce((n, r) => n + paidOf(r), 0);
const money2 = (n) => Math.round(n * 100) / 100;

/**
 * How the collected fees divide between the two masters and Fitsiomax — as lanes that can
 * be opened, not only figures to be read.
 *
 * The slot is what decides whose money it is. One master takes the 10 o'clock class and
 * another the 11 o'clock, each keeps half of what their own slot collected, and the rest
 * is Fitsiomax's. Worked out here rather than taken from the server's revenue_split,
 * because the day and mode filters below narrow what this popup is showing and a lane
 * figure carried over from the whole branch would no longer describe the lines under it.
 * The arithmetic is the server's, step for step, so with nothing filtered these are the
 * same four numbers it sends — see revenue_split in v3_zumba.
 *
 * Fitsiomax's share is the remainder rather than a second multiplication, for the reason
 * the server gives: these figures are somebody's pay and they have to add back up to what
 * was taken. That is also what decides where money on a customer with no slot yet goes —
 * it falls to Fitsiomax, and gets a lane of its own so nobody reads that share as larger
 * than Fitsiomax has really earned.
 *
 * Each lane carries the test for the rows behind it, so the tab showing a figure and the
 * table showing what it is made of cannot fall out of step.
 */
const revenueLanes = (list) => {
  const slots = TIME_SLOTS.map((slot, i) => {
    const collected = sumPaid(list.filter((r) => slotOf(r) === slot));
    return {
      // Master 01 takes the first slot and Master 02 the second. The pairing is the
      // branch's timetable rather than anything a registration records, so the number
      // comes off the slot's position and no name is claimed for it.
      key: `slot-${i + 1}`,
      label: `Master 0${i + 1} Revenue`,
      sub: slot,
      value: money2(collected * MASTER_SHARE),
      accent: "sky",
      match: (r) => slotOf(r) === slot,
    };
  });
  const total = sumPaid(list);
  const mastersTotal = money2(slots.reduce((n, s) => n + s.value, 0));
  const unslotted = money2(sumPaid(list.filter((r) => !TIME_SLOTS.includes(slotOf(r)))));
  const lanes = [
    {
      // Fitsiomax's half comes off both classes, so its lane is every payment: this is the
      // tab that holds the whole list, and the one the popup opens on.
      key: "all",
      label: "FitsioMax Revenue",
      sub: "every payment",
      value: money2(total - mastersTotal),
      accent: "emerald",
      match: () => true,
    },
    ...slots,
  ];
  // Normally absent: a membership is prepaid and the slot is set when it is sold. When it
  // is not, that money has no master to go to and sits in the Fitsiomax figure. A lane
  // rather than only a caption, so the rows behind it can be opened and put right.
  if (unslotted > 0) {
    lanes.push({
      key: "unslotted",
      label: "No slot yet",
      sub: "counted with FitsioMax",
      value: unslotted,
      accent: "amber",
      match: (r) => !TIME_SLOTS.includes(slotOf(r)),
    });
  }
  return lanes;
};

// On and off for each lane's colour. Written out rather than assembled from the accent
// name, because a class string Tailwind only sees put together at runtime is a class
// string Tailwind does not ship.
const LANE_ACCENTS = {
  emerald: {
    on: "border-emerald-500 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-500",
    off: "border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:bg-emerald-50/50",
  },
  sky: {
    on: "border-sky-500 bg-sky-50 text-sky-800 ring-1 ring-sky-500",
    off: "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:bg-sky-50/50",
  },
  amber: {
    on: "border-amber-500 bg-amber-50 text-amber-800 ring-1 ring-amber-500",
    off: "border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:bg-amber-50/50",
  },
};

/** The lanes, stretched across the popup and each one a way in. Equal widths rather than
 *  chips sized by their own text: they are the same kind of thing as each other, and a row
 *  where Fitsiomax's tab is twice the width of a master's says they are not. */
const RevenueLanes = ({ lanes, lane, onPick }) => (
  <div className="flex flex-wrap gap-2" data-testid="zumba-revenue-split">
    {lanes.map((l) => {
      const on = l.key === lane;
      const accent = LANE_ACCENTS[l.accent] || LANE_ACCENTS.emerald;
      return (
        <button
          key={l.key}
          type="button"
          onClick={() => onPick(l.key)}
          aria-pressed={on}
          className={`min-w-[8.5rem] flex-1 rounded-lg border px-3 py-2 text-left transition ${on ? accent.on : accent.off}`}
          data-testid={`zumba-revenue-lane-${l.key}`}
        >
          <p className="text-[9px] font-bold uppercase leading-none tracking-wide opacity-70">{l.label}</p>
          <p className="mt-1 text-base font-extrabold leading-none">{rupees(l.value)}</p>
          <p className="mt-1 text-[9px] font-medium leading-none opacity-60">{l.sub}</p>
        </button>
      );
    })}
  </div>
);

/** Who takes each class — shown, and correctable, but not something to fill in.
 *
 *  Nothing here needs setting up. A branch runs two classes and hires two masters for
 *  them, so the first master takes the ten o'clock and the second the eleven, and a
 *  customer's class time files them to that master from the day the account exists. This
 *  row reports that arrangement rather than asking for it.
 *
 *  It is still changeable, because the order can be wrong — a third master, or two hired
 *  the other way round — and the alternative to a correction here is a branch whose
 *  takings are split against a pairing nobody agrees with and nothing can move. Changing
 *  one is what the server treats as the branch speaking: from then on every class is taken
 *  at its word rather than implied.
 *
 *  Slot first, not master first, because that is the shape of the fact and because asking
 *  it this way round cannot express two masters answering to the same class.
 */
const ClassMasters = ({ masters, onSet, busy }) => {
  // A branch with no Zumba accounts gets no row at all. The strip exists to report a
  // pairing and let it be corrected; with nobody to pair it reported nothing and asked for
  // nothing, and a full-width bar saying so sat between the cards and the list on every
  // load. Where to add a master belongs in HR Admin, which is where somebody goes to add
  // one — not on a band of this board that a branch already running its classes never
  // sees. The pickers come back on their own the moment an account exists.
  if (masters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2" data-testid="zumba-class-masters">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Who takes each class</span>
      {TIME_SLOTS.map((slot) => {
        const holder = masters.find((m) => m.time_slot === slot);
        return (
          <label key={slot} className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <span className="font-medium text-slate-500">{slot}</span>
            <select
              value={holder?.id || ""}
              disabled={busy}
              onChange={(e) => onSet(slot, e.target.value, holder?.id || "")}
              className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11px] text-slate-700 outline-none focus:border-sky-400 disabled:opacity-60"
              data-testid={`zumba-class-master-${slot}`}
            >
              <option value="">Nobody</option>
              {masters.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
};


/**
 * The Payment Done card, opened rather than filtered.
 *
 * Every other card on the strip answers its question by narrowing the list beneath it,
 * which works while the answer is a headcount. This one's answer is money, and money has a
 * second half no column of that table can hold: whose it is. The split used to be printed
 * into the list's header, which put the breakdown of one card inside the chrome of a list
 * showing something else — so both halves are lifted out here, the split first and then
 * the payments it is made of, in one place that is about the money and nothing else.
 *
 * The lines are read off every registration rather than off the filtered list, and drop
 * whoever has discontinued exactly as the server's total does. A popup opened from a
 * figure whose lines add up to less than the figure that was clicked is the one thing a
 * card must never do, so it opens on every payment, footed, and can be read straight back
 * against the card that opened it.
 *
 * From there it narrows three ways, and each one is a question a branch actually asks of
 * this figure: whose money it is, which day it came in on, and how it arrived. They are
 * this popup's own filters rather than the table's underneath — reading the takings is not
 * a reason to lose the view being worked, and one set of pills writing both would mean it
 * is. Whatever is left showing is what the header, the lanes and the foot all describe.
 */
const PaymentDoneModal = ({ rows, owed, onShowDue, onClose }) => {
  const [lane, setLane] = useState("all");
  const [dateFilter, setDateFilter] = useState(null);
  const [modeFilter, setModeFilter] = useState("");

  // The day and the mode narrow the money itself, so the lanes are worked out from what is
  // left after them: on a week one master did not teach, that master's tab reads zero
  // rather than carrying the whole branch's figure over a list that no longer holds it.
  // The lane is applied after, or picking one would empty the tabs beside it.
  const scoped = useMemo(() => {
    let list = rows;
    if (dateFilter) {
      // Compared as timestamps rather than as day strings: the picker hands back Dates
      // whose ends are the start and the end of a day, so a single day is a range like any
      // other and needs no special case.
      const fromTs = dateFilter.from?.getTime();
      const toTs = dateFilter.to?.getTime();
      list = list.filter((r) => {
        // The day the registration was taken — the only date this record carries. A fee is
        // settled against the membership rather than stamped with a date of its own, so
        // "today" here means today's registrations, the same as it does on the table.
        const ts = new Date(`${dayOf(r.created_at)}T00:00:00`).getTime();
        if (!ts) return false;
        if (fromTs && ts < fromTs) return false;
        if (toTs && ts > toTs) return false;
        return true;
      });
    }
    if (modeFilter) list = list.filter((r) => r.payment_mode === modeFilter);
    return list;
  }, [rows, dateFilter, modeFilter]);

  const lanes = useMemo(() => revenueLanes(scoped), [scoped]);
  const picked = lanes.find((l) => l.key === lane) || lanes[0];
  const shown = useMemo(() => scoped.filter((r) => (picked?.match || (() => true))(r)), [scoped, picked]);

  // A lane can go away under a filter — the unslotted one exists only while there is
  // unslotted money — and leaving the popup pointed at a tab that is no longer on screen
  // would show a list nothing above it explains.
  useEffect(() => {
    if (!lanes.some((l) => l.key === lane)) setLane("all");
  }, [lanes, lane]);

  const collected = sumPaid(shown);
  const everything = sumPaid(rows);
  const narrowed = shown.length !== rows.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="zumba-payment-done-dialog"
    >
      {/* overflow-hidden, or the tinted header paints its own square corners over the
          rounded ones this container draws. */}
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b bg-emerald-50/60 p-5">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-800">Payment Done</h3>
            <p className="mt-1 text-2xl font-extrabold leading-none text-emerald-700" data-testid="zumba-payment-done-total">
              {rupees(collected)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              collected from {pluralCustomers(shown.length)}
              {/* What was clicked, kept in sight while the popup is narrowed: the figure
                  above is no longer the card's once a filter is on, and a number that has
                  quietly stopped being the one you came in on is worse than a caption with
                  another number in it. */}
              {narrowed ? ` · of ${rupees(everything)} from ${pluralCustomers(rows.length)}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close" data-testid="zumba-payment-done-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Whose the collected money is, above the payments it was made of — and the way
            into each of them. */}
        <div className="shrink-0 border-b border-slate-100 px-5 py-3">
          <RevenueLanes lanes={lanes} lane={picked?.key} onPick={setLane} />
        </div>

        {/* One line, two groups: when the days are asked on the left and the payment mode
            on the right, the space between them is what says they are separate questions.
            The same pair the table downstairs carries, because they are the same two
            questions — asked here of the money rather than of the roll. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-slate-100 px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="zumba-payment-done-date-filter">
            {DATE_PRESETS.map((preset) => {
              const active = preset.key === "all" ? !dateFilter : dateFilter?.key === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => setDateFilter(presetFilter(preset))}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${active ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                  data-testid={`zumba-payment-done-date-${preset.key}`}
                >
                  {preset.label}
                </button>
              );
            })}
            {/* The trigger is a Button this component does not own, so its size and text
                are pinned from out here rather than by adding props to a control five
                other boards share. Handed null while a preset is active, so it reads
                "Custom" rather than echoing the pill already lit beside it. */}
            <span className="[&_button]:h-[30px] [&_button]:rounded-md [&_button]:px-3 [&_button]:text-xs [&_button]:font-semibold [&_svg]:mr-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5">
              <DateFilterPopover
                value={isPreset(dateFilter) ? null : dateFilter}
                onChange={setDateFilter}
                centered
                placeholder="Custom"
                testid="zumba-payment-done-date-custom"
              />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="zumba-payment-done-mode-filter">
            {MODE_FILTERS.map(([key, label]) => (
              <button
                key={key || "all"}
                type="button"
                onClick={() => setModeFilter(key)}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
                  modeFilter === key
                    ? "border-sky-600 bg-sky-600 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
                }`}
                data-testid={`zumba-payment-done-mode-${key || "all"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <div className="px-5 py-12 text-center" data-testid="zumba-payment-done-empty">
              <p className="text-sm text-slate-400">
                {rows.length > 0
                  ? "Nothing collected under this filter."
                  : "Nothing has been collected at this branch yet."}
              </p>
              {/* A ₹0 popup that stops there leaves the desk nowhere to go. Whatever is
                  owed is the money that would land here, so say how much and open it. */}
              {rows.length === 0 && owed.length > 0 && (
                <button
                  type="button"
                  onClick={onShowDue}
                  className="mt-3 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
                  data-testid="zumba-payment-done-show-due"
                >
                  {rupees(owed.reduce((n, r) => n + amountDue(r), 0))} still owed by {pluralCustomers(owed.length)}
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-[5%] px-4 py-2.5">S.No</th>
                    <th className="w-[26%] px-4 py-2.5">Name</th>
                    <th className="w-[20%] px-4 py-2.5">Package</th>
                    <th className="w-[19%] px-4 py-2.5">Class</th>
                    <th className="w-[13%] px-4 py-2.5">Mode</th>
                    <th className="w-[17%] px-4 py-2.5 text-right">Collected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((r, i) => {
                    const due = Number(r.fee_amount || 0) - Number(r.fee_paid || 0);
                    return (
                      <tr key={r.id} className="align-top" data-testid={`zumba-payment-done-row-${r.id}`}>
                        <td className="px-4 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="max-w-full truncate text-sm font-semibold leading-5 text-slate-800" title={r.name}>{r.name || "—"}</p>
                          <p className="text-[10px] leading-4 text-slate-400">{r.phone || "No phone"}</p>
                        </td>
                        <td className="px-4 py-3">
                          {r.package_name ? (
                            <>
                              <p className="max-w-full truncate text-xs leading-5 text-slate-600" title={r.package_name}>{r.package_name}</p>
                              {r.package_sessions ? <p className="text-[10px] leading-4 text-slate-400">{r.package_sessions} classes</p> : null}
                            </>
                          ) : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        {/* The slot, because it is what decides whose money this line is:
                            the lane above is this column added up. A row with none yet
                            says so rather than showing a dash, since those rows are the
                            reason the "No slot yet" lane is up there at all. */}
                        <td className="px-4 py-3">
                          {r.time_slot
                            ? <p className="text-xs leading-5 text-slate-600">{r.time_slot}</p>
                            : <p className="text-xs font-semibold leading-5 text-amber-600">No slot yet</p>}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex whitespace-nowrap rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                            {PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode || "Not recorded"}
                          </span>
                        </td>
                        {/* What came in on this membership, and what is still out on it. A
                            part-paid customer is on Due Payment as well as here, and a
                            column that showed only the takings would read as settled. */}
                        <td className="px-4 py-3 text-right">
                          <p className="text-xs font-semibold leading-5 text-emerald-700">{rupees(r.fee_paid)}</p>
                          {due > 0 ? <p className="text-[10px] leading-4 text-rose-600">{rupees(due)} still due</p> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Footed, so the lines can be read back against the tab that opened them. */}
                <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Total collected</td>
                    <td className="px-4 py-3 text-right text-sm font-extrabold text-emerald-700" data-testid="zumba-payment-done-foot">{rupees(collected)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const STATUS_CHIP = {
  active: { label: "On the roll", classes: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  discontinued: { label: "Discontinued", classes: "border-rose-200 bg-rose-50 text-rose-700" },
  leave: { label: "On leave", classes: "border-indigo-200 bg-indigo-50 text-indigo-700" },
};

/** The row's version: whether they are coming, in one word. Which kind of not-coming it is
 *  stays in the tooltip and on the record — a column scanned down wants one distinction,
 *  and the difference between discontinued and on leave is read when somebody stops on the
 *  row, not while passing it. */
const STATUS_ROW = {
  active: { label: "Active", classes: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  discontinued: { label: "Inactive", classes: "border-rose-200 bg-rose-50 text-rose-700" },
  leave: { label: "Inactive", classes: "border-amber-200 bg-amber-50 text-amber-700" },
};

/**
 * Everything on one registration, read rather than edited, and the two things that end it.
 *
 * Shaped like the gym's membership dialog next door, because they answer the same question
 * about the same kind of person and reading them differently for no reason is a cost paid
 * by whoever works both tabs. What is owed leads, since it is the thing a desk opens a row
 * to find out; who they are and what they bought sit under it, side by side.
 */
const ViewRegistrationModal = ({ row, masterNameOf, onEdit, onCollect, onRenew, onDelete, onClose, onSaved }) => {
  const [pending, setPending] = useState(null); // "discontinued" | "leave" | null
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const status = row.status || "active";
  const ended = status === "discontinued" || status === "leave";
  const chip = STATUS_CHIP[status] || STATUS_CHIP.active;
  // A consultation's referral is not a row of this collection -- it is read live off the
  // lead that owns it. Ending it here would ask the server to change a record it does not
  // hold, so the popup reads it and says where the decision actually lives.
  const ownedElsewhere = row.origin === "consultation";

  const apply = async (next, why) => {
    setSaving(true);
    try {
      await setZumbaStatus(row.id, next, why);
      toast.success(
        next === "discontinued" ? "Marked discontinued"
          : next === "leave" ? "Marked on leave"
            : "Back on the class roll",
      );
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const owed = Number(row.fee_amount || 0);
  const paid = Number(row.fee_paid || 0);
  const due = owed - paid;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="zumba-view-dialog"
    >
      {/* overflow-hidden, or the tinted header and footer paint their own square
          corners over the rounded ones this container draws. */}
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b bg-slate-50/60 p-5">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-800">
              {row.name || "—"}
              <span className={`inline-flex rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${chip.classes}`} data-testid="zumba-view-status-chip">
                {chip.label}
              </span>
            </h3>
            {/* The three that identify somebody at a glance, on one line — the same three
                the gym's dialog leads with, and the reason neither needs a photo. */}
            <p className="mt-0.5 text-[11px] text-slate-500">
              {row.phone || "No phone"}{row.age ? ` · ${row.age}` : ""}{row.gender ? ` · ${row.gender}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close" data-testid="zumba-view-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* What is outstanding, first and largest. A settled row says so rather than
              printing a zero, which reads as a figure nobody has filled in yet. */}
          <div className={`rounded-xl border p-4 ${due > 0 ? "border-rose-200 bg-rose-50/70" : "border-emerald-200 bg-emerald-50/70"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Balance</p>
                <p className={`mt-0.5 text-2xl font-extrabold leading-none ${due > 0 ? "text-rose-700" : "text-emerald-700"}`} data-testid="zumba-view-balance">
                  {due > 0 ? `${rupees(due)} due` : owed > 0 ? "Paid up" : "Nothing sold yet"}
                </p>
              </div>
              {/* Offered from the balance rather than the footer, because it is the one
                  thing to do about the figure beside it. Absent when nothing is owed,
                  where there is nothing to collect. */}
              {due > 0 && !ownedElsewhere && (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={onCollect} data-testid="zumba-view-collect">
                  <IndianRupee className="mr-1 h-3.5 w-3.5" /> Collect Due
                </Button>
              )}
            </div>
            {/* The three figures on one line, in the order they happen: what it cost, what
                came in, what is left. Stacked in a corner they read as a footnote to the
                balance rather than as the arithmetic behind it. */}
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/70 pt-3 text-center">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Fee</p>
                <p className="text-sm font-bold text-slate-700">{rupees(owed)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Collected</p>
                <p className="text-sm font-bold text-emerald-700">{rupees(paid)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Due</p>
                <p className={`text-sm font-bold ${due > 0 ? "text-rose-700" : "text-slate-400"}`}>{due > 0 ? rupees(due) : "—"}</p>
              </div>
            </div>
          </div>

          {/* How far through the term they are. The two dates were readable a card away and
              the classes left were not readable at all, which is the half of it somebody
              opening this record before a renewal actually wants. */}
          {row.finish_on && (
            <div className="rounded-xl border border-slate-200 p-4" data-testid="zumba-view-term">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Term</p>
                <p className="text-xs font-medium text-slate-600">
                  {shortDate(row.joined_on || row.created_at)} <span className="text-slate-300">→</span> {shortDate(row.finish_on)}
                </p>
              </div>
              {typeof row.classes_left === "number" && Number(row.package_sessions) > 0 && (
                <>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${row.renewal_due ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${Math.min(100, Math.max(0, (row.classes_left / Number(row.package_sessions)) * 100))}%` }}
                    />
                  </div>
                  <p className={`mt-1.5 text-[11px] ${row.renewal_due ? "font-semibold text-amber-600" : "text-slate-500"}`}>
                    {row.classes_left === 0
                      ? "The term has run out."
                      : `${row.classes_left} of ${row.package_sessions} classes left${row.renewal_due ? " — due a renewal" : ""}.`}
                  </p>
                </>
              )}
            </div>
          )}

          {ended && (
            <div className={`rounded-lg border p-3 text-xs ${status === "discontinued" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-indigo-200 bg-indigo-50 text-indigo-700"}`} data-testid="zumba-view-status">
              <p className="font-bold">{STATUS_LABELS[status]}</p>
              {row.status_remarks ? <p className="mt-0.5">{row.status_remarks}</p> : null}
              {row.status_by ? <p className="mt-0.5 opacity-70">{row.status_by} · {shortDate(row.status_at)}</p> : null}
            </div>
          )}

          {/* items-start, so the shorter card ends where its last row does rather than
              stretching to match the taller one and trailing empty space. */}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-4">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Customer</p>
              <DetailRow label="Phone" value={row.phone} />
              <DetailRow label="Age" value={row.age} />
              <DetailRow label="Gender" value={(GENDERS.find((g) => g.key === row.gender) || {}).label} />
              <DetailRow label="Email" value={row.email} />
              <DetailRow label="Address" value={row.address} />
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Membership</p>
              <DetailRow label="Package" value={row.package_name} />
              <DetailRow label="Classes" value={row.package_sessions ? `${row.package_sessions} classes` : ""} />
              <DetailRow label="Time" value={row.time_slot} />
              <DetailRow label="Class" value={masterNameOf(row.assigned_master_id)} />
              <DetailRow label="Source" value={sourceDetail(row)} />
              <DetailRow label="Joined" value={shortDate(row.joined_on || row.created_at)} />
              {/* The term's own end, beside the day it began. Read off the server so
                  the sheet, the row and the master's roll are one answer. */}
              {row.finish_on ? <DetailRow label="Finishing" value={shortDate(row.finish_on)} /> : null}
            </div>
          </div>

          {/* Every payment this membership has taken, listed. "Split" on its own named the
              fact that money arrived more than one way and then withheld which ways, which
              is exactly what somebody opening this card is here to read — and after a
              renewal or two there are several to read. */}
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Payment</p>
              {paid > 0 ? <p className="text-sm font-bold text-emerald-700">{rupees(paid)} collected</p> : null}
            </div>
            {Array.isArray(row.payment_lines) && row.payment_lines.length > 0 ? (
              <div className="divide-y divide-slate-100" data-testid="zumba-view-payment">
                {row.payment_lines.map((l, i) => {
                  const notes = Object.entries(l.denominations || {})
                    .sort((a, b) => Number(b[0]) - Number(a[0]))
                    .map(([d, n]) => `${n}×₹${d}`)
                    .join("  +  ");
                  return (
                    <div key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                          {PAYMENT_MODE_LABELS[l.mode] || l.mode}
                        </span>
                        {/* The trail under the mode: a UPI ID, a transaction number, or the
                            notes that were counted out. Whichever it is, it is what a
                            disputed payment gets traced by. */}
                        {l.reference || notes ? (
                          <span className="min-w-0 truncate text-[11px] text-slate-500" title={l.reference || notes}>
                            {l.reference || notes}
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs font-semibold text-slate-700">{rupees(l.amount)}</span>
                    </div>
                  );
                })}
              </div>
            ) : row.payment_mode ? (
              // A row paid for before payments were kept line by line: it knows the mode and
              // the total and nothing about how they were split, so it says that much.
              <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="zumba-view-payment">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                  {PAYMENT_MODE_LABELS[row.payment_mode] || row.payment_mode}
                </span>
                <span className="text-[11px] text-slate-500">{row.payment_reference || "—"}</span>
              </div>
            ) : (
              <p className="py-3 text-center text-xs text-slate-400" data-testid="zumba-view-no-payment">
                {paid > 0
                  ? "Collected without a mode recorded — the figure above was set on the registration directly."
                  : "Nothing collected yet."}
              </p>
            )}
          </div>

          {/* Asked before it is saved, not after: the reason is the point of recording it. */}
          {pending ? (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Why are they {pending === "discontinued" ? "discontinuing" : "taking leave"}? *
              </label>
              <textarea
                rows={3}
                autoFocus
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={pending === "discontinued" ? "Moved away, too expensive, unhappy with the timing…" : "Travelling for a month, injury, exams…"}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                data-testid="zumba-status-remarks"
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setPending(null); setRemarks(""); }} data-testid="zumba-status-cancel">Cancel</Button>
                <Button
                  size="sm"
                  className={pending === "discontinued" ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"}
                  disabled={saving || !remarks.trim()}
                  onClick={() => apply(pending, remarks.trim())}
                  data-testid="zumba-status-confirm"
                >
                  {saving ? "Saving…" : pending === "discontinued" ? "Confirm Discontinue" : "Confirm Leave"}
                </Button>
              </div>
            </div>
          ) : null}

          {ownedElsewhere && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-[11px] font-medium text-sky-700" data-testid="zumba-view-owned-elsewhere">
              Referred on the consultation, which owns this record — discontinuing or ending it is done there, by un-ticking Zumba on the lead.
            </p>
          )}
        </div>

        {/* Close on its own at the left, the two that end a membership at the right, and
            Edit between them. Four buttons in one row read as four equally likely things
            to do, and two of them are not: Discontinue and Leave take somebody off the
            roll, and sitting them next to Close invites the mis-click. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-slate-50/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} data-testid="zumba-view-close-btn">Close</Button>
            {/* Off the row now, so it lives here: for a referral it takes it off this
                list, for a registration it deletes it — both behind a confirm. */}
            <Button
              variant="outline"
              size="sm"
              className="border-rose-200 text-rose-700 hover:bg-rose-50"
              onClick={onDelete}
              title={ownedElsewhere ? "Take this referral off the Zumba list" : "Delete"}
              data-testid="zumba-view-delete"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> {ownedElsewhere ? "Remove" : "Delete"}
            </Button>
          </div>
          {!ownedElsewhere && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onEdit} data-testid="zumba-view-edit">
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
              {/* Only once the term is nearly up — a renewal offered on the first day of
                  six months is a button nobody presses. */}
              {row.renewal_due && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={onRenew}
                  title={row.classes_left === 0
                    ? "This membership has run out — sell them another term"
                    : `${row.classes_left} classes left — sell them another term`}
                  data-testid="zumba-view-renew"
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> Renew
                </Button>
              )}
              {ended ? (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={saving} onClick={() => apply("active", "")} data-testid="zumba-status-restore">
                  Put back on the roll
                </Button>
              ) : (
                <>
                  <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" aria-hidden="true" />
                  <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => setPending("discontinued")} data-testid="zumba-status-discontinue">
                    Discontinue
                  </Button>
                  <Button size="sm" variant="outline" className="border-indigo-200 text-indigo-700 hover:bg-indigo-50" onClick={() => setPending("leave")} data-testid="zumba-status-leave">
                    Leave
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Today, as the branch's own calendar has it. Not off toISOString(), which is UTC: at
 *  three in the morning in India that still reads as yesterday, and a membership would be
 *  dated to a day nobody was at the desk. */
const todayLocal = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const EMPTY = {
  name: "", email: "", phone: "", age: "", gender: "", address: "",
  source: "personal", master_name: "", assigned_master_id: "", time_slot: "", joined_on: "",
  package_id: "", package_name: "", package_sessions: "", fee_amount: "",
};

/**
 * Zumba registrations for one branch.
 *
 * Deliberately not part of the leads pipeline: a Zumba registration has no stage, no
 * consultation and no discharge, so putting it there would have meant a row sitting in
 * every stage filter while answering none of them. The cards split by source instead,
 * which is what a branch wants to know about a class it is filling.
 */
export const ZumbaPanel = ({ branchId }) => {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [card, setCard] = useState("all");
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState(""); // "" = every mode, including none
  // The same shape Branch Leads keeps: { key, label, from, to } with Dates on the ends,
  // or null for no filter. The presets and the typed range both come from the one
  // control, so there is no From/To bar of this tab's own to keep in step with it.
  const [dateFilter, setDateFilter] = useState(null);
  const [form, setForm] = useState(null); // null | { ...fields, id? }
  const [newMaster, setNewMaster] = useState(""); // a master not yet on the list
  // The Zumba accounts at this branch, which is what a customer is assigned *to*. Not
  // the same list as `masters` above: that one is names typed onto referrals, and a
  // referral name with no account behind it cannot be given a class.
  const [zumbaMasters, setZumbaMasters] = useState([]);
  const masterNameOf = (id) => (zumbaMasters.find((m) => m.id === id) || {}).name || "";
  // The Zumba shelf as Super Admin priced it — a membership per term, monthly through
  // yearly. Read rather than hardcoded, so a change of price on the shelf, or a term
  // priced away from the standard amount, is the change of price here.
  const [packages, setPackages] = useState([]);
  // Which branch these rows belong to, as the server resolved it. Printed rather than
  // assumed: an empty list is either "nobody has registered" or "you are looking at the
  // wrong branch", and those two read identically until the branch is named.
  const [branch, setBranch] = useState(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [renewing, setRenewing] = useState(null); // the membership being sold another term
  const [collecting, setCollecting] = useState(null); // the balance being paid down
  const [viewing, setViewing] = useState(null);   // the registration open in the detail popup
  // Payment Done opens rather than filters — see PaymentDoneModal. Its own flag rather
  // than a value of `card`, because the list underneath is left on whatever it was
  // showing: reading the takings is not a reason to lose the view being worked.
  const [paymentDoneOpen, setPaymentDoneOpen] = useState(false);
  const [accepting, setAccepting] = useState(null); // the referral being taken onto the books
  // The Zumba pipeline exactly as Super Admin has it in CI/CD ROOTS. Nothing is hardcoded
  // here: a clinic that has not set the pipeline up has no stages, and the Stage column
  // and its move control drop out of the table rather than drawing an empty pipeline.
  const [stages, setStages] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listZumba(branchId);
      setRows(data.registrations || []);
      setSummary(data.summary || {});
      setMasters(data.masters || []);
      setStages(data.stages || []);
      setBranch(data.branch || null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load Zumba registrations");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  // Once, not per open: the shelf does not change while a form is on screen, and fetching
  // it on every Create would put a spinner in front of a list that is nearly always the
  // same three rows.
  useEffect(() => {
    listStoreItems("zumba", "session")
      .then(setPackages)
      .catch(() => setPackages([]));
  }, []);

  // Loaded apart from the registrations: the roster does not change when a row does, and a
  // branch with no Zumba accounts should still get its board rather than an error.
  useEffect(() => {
    let live = true;
    listZumbaMasters(branchId)
      .then((data) => { if (live) setZumbaMasters(Array.isArray(data) ? data : []); })
      .catch(() => { if (live) setZumbaMasters([]); });
    return () => { live = false; };
  }, [branchId]);

  // Handing a class to a master. The server re-files that class's customers on the same
  // call, so both the roster and the registrations are refetched rather than patched in
  // place — half a dozen rows change owner and the assignment shows on every one of them.
  const [settingSlot, setSettingSlot] = useState(false);
  const setClassMaster = async (slot, nextId, currentId) => {
    if (nextId === currentId) return;
    setSettingSlot(true);
    try {
      // Clearing a class means standing down whoever holds it; there is no id to send it
      // against otherwise, which is why the current holder is passed in.
      const res = nextId
        ? await setZumbaMasterSlot(nextId, slot)
        : await setZumbaMasterSlot(currentId, "");
      const moved = Number(res?.customers_moved || 0);
      toast.success(
        nextId
          ? `${res?.name || "Master"} takes ${slot}${moved ? ` · ${moved} customer${moved === 1 ? "" : "s"} moved` : ""}`
          : `${slot} is nobody's for now${moved ? ` · ${moved} released` : ""}`,
      );
      const roster = await listZumbaMasters(branchId).catch(() => null);
      if (Array.isArray(roster)) setZumbaMasters(roster);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not set that class");
    } finally {
      setSettingSlot(false);
    }
  };

  const visible = useMemo(() => {
    let list = rows;
    // A customer who has discontinued is off the roll, so they appear on their own card and
    // nowhere else: not in All, not under the source that brought them in, and not among
    // who owes money. Applied before the card filters rather than inside each one, so
    // there is a single place that decides who is still on the list.
    //
    // Leave is not the same and stays: they are expected back, and the counts that describe
    // the roll should still include them. The server's summary draws the same line, so the
    // number on a card and the rows behind it cannot disagree.
    if (card !== "discontinued") list = list.filter((r) => (r.status || "active") !== "discontinued");
    // Four of the cards are not sources, so each says which rows it stands for. Where a
    // customer came from and what became of them are different questions, and only the
    // first is the `card` the server stamps on the row.
    // Payment Done is not one of them: it opens its own popup instead of narrowing this.
    if (card === "due_payment") list = list.filter((r) => amountDue(r) > 0);
    else if (card === "discontinued") list = list.filter((r) => (r.status || "active") !== "active");
    else if (card !== "all") list = list.filter((r) => r.card === card);
    if (dateFilter) {
      // Compared as timestamps rather than as day strings: the picker hands back Dates
      // whose ends are the start and the end of a day, so a single day is a range like
      // any other and needs no special case.
      const fromTs = dateFilter.from?.getTime();
      const toTs = dateFilter.to?.getTime();
      list = list.filter((r) => {
        const ts = new Date(`${dayOf(r.created_at)}T00:00:00`).getTime();
        if (!ts) return false;
        if (fromTs && ts < fromTs) return false;
        if (toTs && ts > toTs) return false;
        return true;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => (r.name || "").toLowerCase().includes(q) || (r.phone || "").includes(q));
    }
    if (modeFilter) list = list.filter((r) => r.payment_mode === modeFilter);
    return list;
  }, [rows, card, search, dateFilter, modeFilter]);

  /**
   * The lines behind the Payment Done card: everyone who has handed something over.
   * Discontinued customers are dropped for the same reason the server drops them from
   * fee_total — see the summary loop in v3_zumba.py — so these lines add back up to
   * exactly the number on the card.
   *
   * Not filtered to the settled: the card counts what came in, and a customer halfway
   * through a membership has still handed money over. What they still owe is printed on
   * their line rather than being a reason to leave them out.
   */
  const paymentDoneRows = useMemo(
    () => rows.filter((r) => (r.status || "active") !== "discontinued" && Number(r.fee_paid || 0) > 0),
    [rows],
  );
  // What is still out, for the popup to point at when nothing has come in yet.
  const owedRows = useMemo(
    () => rows.filter((r) => (r.status || "active") !== "discontinued" && amountDue(r) > 0),
    [rows],
  );

  // Every master offered in the picker: the ones already referred from, plus one being
  // typed in now, so a new name is selectable the moment it exists.
  /**
   * Who can be named as the master who referred somebody.
   *
   * Three sources, in the order they matter. The Zumba accounts at this branch come first
   * and are the answer nearly every time — a master with a login is a master the branch
   * employs, and having to type their name while their account sits in the Assign To box
   * below was the gap here. Then the names already typed onto earlier referrals, so a
   * master with no account keeps working once introduced. Then whatever this row already
   * says, so editing an old referral never silently blanks its master.
   *
   * Deduped on the name case-folded, since the same person reached from two of those
   * sources is one option, not two that save the same string.
   */
  const masterOptions = useMemo(() => {
    const seen = new Map();
    const add = (name) => {
      const label = (name || "").trim();
      const key = label.toLowerCase();
      if (label && !seen.has(key)) seen.set(key, label);
    };
    zumbaMasters.forEach((m) => add(m.name));
    masters.forEach(add);
    if (form?.source === MASTER) add(form.master_name);
    return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [zumbaMasters, masters, form]);

  // The payment lines the dialog edits. Declared beside openForm rather than inside the
  // dialog's JSX so the handlers are one thing each, and `collected` is read by both the
  // Fee Collected box and the running total under the lines.

  const openForm = (row) => {
    setNewMaster("");
    setForm(row
      ? { ...EMPTY, ...row, age: row.age ?? "", joined_on: row.joined_on || dayOf(row.created_at) }
      : { ...EMPTY, joined_on: todayLocal() });
  };

  /**
   * Take a CONSULTANT's referral onto the branch's books, then edit it.
   *
   * Until this runs the row is the lead, read live, with nothing to assign a master to or
   * collect a fee against. One click does the taking over and opens the form on what it
   * made, because nobody asks for a referral to be "accepted" as an end in itself -- they
   * ask because they are about to fill something in.
   */
  const acceptAndEdit = async (row) => {
    if (accepting) return;
    setAccepting(row.id);
    try {
      const created = await acceptZumbaReferral(row.lead_id);
      await load();
      openForm(created);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not take this referral on");
    } finally {
      setAccepting(null);
    }
  };

  // The price of the membership picked in the open form: the fee box's placeholder, and
  // what is saved if that box is left empty.
  const pickedPackage = form?.package_id ? packages.find((p) => p.id === form.package_id) : null;
  const pickedPrice = pickedPackage ? planTotal(pickedPackage) : 0;

  const save = async () => {
    if (!form?.name?.trim()) { toast.error("Name is required"); return; }
    // Belt to the server's braces: a lead-backed row has no registration to write to, and
    // saying so here costs one comparison rather than a round trip that can only fail.
    if (String(form.id || "").startsWith("lead:")) {
      toast.error("Referred on the consultation — change it there, not here");
      return;
    }
    if (form.source === MASTER && !(form.master_name || "").trim()) { toast.error("Which master referred them?"); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: (form.phone || "").trim(),
        age: form.age === "" || form.age == null ? null : Number(form.age),
        email: (form.email || "").trim(),
        gender: form.gender || "",
        // Not asked for any more, but still sent: a consultation referral arrives with
        // an address off the lead, and dropping it here would mean editing such a row
        // for any other reason silently deleted it.
        address: (form.address || "").trim(),
        time_slot: form.time_slot || "",
        joined_on: form.joined_on || "",
        package_id: form.package_id || "",
        package_name: form.package_name || "",
        package_sessions: form.package_sessions === "" || form.package_sessions == null ? null : Number(form.package_sessions),
        source: form.source || "personal",
        master_name: (form.master_name || "").trim(),
        assigned_master_id: form.assigned_master_id || "",
        fee_amount: form.fee_amount === "" || form.fee_amount == null
          ? Number(pickedPrice || 0)
          : Number(form.fee_amount),
        // No fee_paid and no lines: this form registers a customer, and saying nothing about
        // the money is what leaves what has been collected alone. Sending a zero here would
        // wipe a customer's payments every time somebody fixed their phone number.
      };
      if (form.id) await updateZumba(form.id, payload);
      else await addZumba(payload, branchId);
      toast.success(form.id ? "Registration updated" : "Registration added");
      setForm(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const target = removing;
    setRemoving(null);
    try {
      await deleteZumba(target.id);
      toast.success(target.origin === "consultation" ? "Referral turned away" : "Registration removed");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not remove");
    }
  };


  return (
    <div className="flex flex-col gap-4" data-testid="branch-zumba-panel">
      {/* One row, always. The cards share the width evenly and never wrap: nine of them
          breaking as 7 + 2 read as two unrelated strips, and the second one looked like a
          separate thing rather than the tail of the first.

          No minimum width and no scroller: nine cards divide whatever width there is, so
          the row ends exactly where the page does. What gives instead is the label, which
          truncates and carries the full text on `title`.

          The Fitness tab's card, `arrow` and all: white, a grey label and the figure in the
          card's colour, the picked one ringed in it. */}
      <div
        className="grid grid-cols-2 items-stretch gap-3 sm:grid-cols-4 lg:grid-cols-7"
        data-testid="zumba-summary"
      >
        {CARDS.map((c) => {
          // Direct, Consultant and Refer Master are Zumba pipeline stages too, and wear the
          // name and colour Super Admin gives them in CI/CD ROOTS. The other cards have no
          // stage behind them and keep their own.
          const stage = stages.find((st) => st.card === c.key);
          const hex = stage && HEX_COLOR.test(stage.color || "") ? stage.color : null;
          const props = {
            label: stage?.name || c.label,
            value: c.money
              ? rupees(summary?.[c.money])
              : (c.sum || [c.key]).reduce((n, k) => n + (Number(summary?.[k]) || 0), 0),
            // A caption only where it carries a figure: the customer count behind a money
            // card. The guide lines the count cards used to wear are gone.
            sub: c.countSub && c.countSub(pluralCustomers(Number(summary?.[c.count || c.key]) || 0)),
            color: hex || c.color,
            active: c.key === "payment_done" ? paymentDoneOpen : card === c.key,
            onClick: () => (c.key === "payment_done"
              ? setPaymentDoneOpen(true)
              : setCard(c.key === "all" ? "all" : (card === c.key ? "all" : c.key))),
            testid: `zumba-card-${c.key}`,
          };
          return <StatTile key={c.key} {...props} arrow />;
        })}
      </div>

      <ClassMasters masters={zumbaMasters} onSet={setClassMaster} busy={settingSlot} />

      <Card>
        <CardContent className="p-0">
          {/* One toolbar, then the table: dates on the left, payment mode beside them, and
              search, refresh and create at the right. The title row that used to sit above
              it only repeated what the tab already says. On a window too narrow for all
              three groups they wrap onto their own lines rather than interleaving. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5" data-testid="zumba-date-filter">
              {DATE_PRESETS.map((preset) => {
                const active = preset.key === "all" ? !dateFilter : dateFilter?.key === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => setDateFilter(presetFilter(preset))}
                    className={`h-8 rounded-md px-3 text-xs font-semibold transition ${active ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                    data-testid={`zumba-date-${preset.key}`}
                  >
                    {preset.label}
                  </button>
                );
              })}
              {/* The trigger is a Button this component does not own, so its size and text
                  are pinned from out here rather than by adding props to a control five
                  other boards share. Handed null while a preset is active, so it reads
                  "Custom" rather than echoing the pill already lit beside it. */}
              <span className="[&_button]:h-8 [&_button]:rounded-md [&_button]:px-3 [&_button]:text-xs [&_button]:font-semibold [&_svg]:mr-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5">
                <DateFilterPopover
                  value={isPreset(dateFilter) ? null : dateFilter}
                  onChange={setDateFilter}
                  centered
                  placeholder="Custom"
                  testid="zumba-date-custom"
                />
              </span>
            </div>
            <span className="hidden h-6 w-px bg-slate-200 xl:block" aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-1.5" data-testid="zumba-mode-filter">
              {MODE_FILTERS.map(([key, label]) => (
                <button
                  key={key || "all"}
                  type="button"
                  onClick={() => setModeFilter(key)}
                  className={`h-8 rounded-md border px-3 text-xs font-semibold transition ${
                    modeFilter === key
                      ? "border-sky-600 bg-sky-600 text-white shadow-sm"
                      : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
                  }`}
                  data-testid={`zumba-mode-${key || "all"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone"
                className="h-8 w-44 text-xs"
                data-testid="zumba-search"
              />
              {/* The app's own refresh button — solid slate, white icon — as on Patients,
                  Accountant Manage and Branch Management. Grey rather than blue: it changes
                  nothing, and the blue is spent on the one button that creates something.
                  Kept at h-8 so it lines up with the search box and the add button. */}
              <Button
                size="sm"
                className="h-8 w-8 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
                onClick={load}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh"
                data-testid="zumba-refresh"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              <Button
                size="sm"
                className="h-8 w-8 bg-sky-600 p-0 text-white hover:bg-sky-700"
                onClick={() => openForm(null)}
                title="Zumba Lead Create"
                aria-label="Zumba Lead Create"
                data-testid="zumba-add"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {loading ? (
            <p className="px-4 py-12 text-center text-sm text-slate-400">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-400">
              {rows.length > 0
                ? "Nothing under this filter."
                : branch?.name
                  ? `No Zumba registrations at ${branch.name} yet. A registration is filed against the branch it was taken at — a master's referral lands on the branch their own account belongs to.`
                  : branch
                    ? "This account has no branch assigned, so there is no Zumba list to read. Assign one in HR Admin → Credentials."
                    : "No Zumba registrations yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[64rem] text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {/* One fact per column, every header and cell on a single line. */}
                  <tr className="whitespace-nowrap">
                    <th className="w-[4%] px-3 py-2.5">S.No</th>
                    <th className="w-[13%] px-3 py-2.5">Name</th>
                    <th className="w-[10%] px-3 py-2.5">Master</th>
                    <th className="w-[9%] px-3 py-2.5">Mobile</th>
                    <th className="w-[9%] px-3 py-2.5">Package</th>
                    <th className="w-[15%] px-3 py-2.5">Date</th>
                    <th className="w-[6%] px-3 py-2.5">Classes</th>
                    <th className="w-[7%] px-3 py-2.5">Collected</th>
                    <th className="w-[8%] px-3 py-2.5">Due Payment</th>
                    <th className="w-[7%] px-3 py-2.5">Status</th>
                    <th className="w-[7%] px-3 py-2.5 text-center">Payment</th>
                    <th className="w-[5%] px-3 py-2.5 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((r, i) => {
                    const paid = Number(r.fee_paid || 0);
                    const due = Number(r.fee_amount || 0) - paid;
                    const master = masterNameOf(r.assigned_master_id);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => setViewing(r)}
                        className="cursor-pointer whitespace-nowrap align-middle hover:bg-slate-50/60"
                        data-testid={`zumba-row-${r.id}`}
                      >
                        <td className="px-3 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                        <td className="px-3 py-3">
                          <p className="max-w-[12rem] truncate text-sm font-semibold leading-5 text-slate-800" title={r.name}>{r.name || "—"}</p>
                        </td>
                        {/* The master teaching their class, as assigned on the record. */}
                        <td className="px-3 py-3">
                          {master
                            ? <p className="max-w-[10rem] truncate text-xs leading-5 text-slate-600" title={master}>{master}</p>
                            : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600">{r.phone || "—"}</td>
                        <td className="px-3 py-3">
                          {r.package_name
                            ? <p className="max-w-[9rem] truncate text-xs leading-5 text-slate-600" title={r.package_name}>{r.package_name}</p>
                            : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        {/* The term's start and end on one line. The end is counted forward
                            from the start by the plan's own length — the server works it out
                            so this column and the master's roll cannot answer it differently. */}
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600">
                          {shortDate(r.joined_on || r.created_at)} – {r.finish_on ? shortDate(r.finish_on) : "—"}
                        </td>
                        {/* Classes left in the term, in amber once a renewal is due. */}
                        <td className="px-3 py-3">
                          {typeof r.classes_left === "number" ? (
                            <p className={`text-xs leading-5 ${r.renewal_due ? "font-semibold text-amber-600" : "text-slate-600"}`}>
                              {r.classes_left === 0 ? "Term over" : r.classes_left}
                            </p>
                          ) : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        {/* What has come in, and what has not, in a column each. The plan's
                            price is neither: it is their sum, and the package two columns
                            over already names it. */}
                        <td className="px-3 py-3">
                          <p className="text-xs font-semibold leading-5 text-emerald-700">{rupees(paid)}</p>
                        </td>
                        <td className="px-3 py-3">
                          {due > 0
                            ? <p className="text-xs font-semibold leading-5 text-rose-600">{rupees(due)}</p>
                            : Number(r.fee_amount || 0) > 0
                              ? <p className="text-xs leading-5 text-emerald-600">Paid up</p>
                              : <p className="text-xs leading-5 text-slate-300">—</p>}
                        </td>
                        {/* Whether they are still coming, in the words the record uses. */}
                        <td className="px-3 py-3">
                          {(() => {
                            const key = r.status || "active";
                            const chip = STATUS_ROW[key] || STATUS_ROW.active;
                            return (
                              <span
                                className={`inline-flex whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${chip.classes}`}
                                title={(STATUS_CHIP[key] || STATUS_CHIP.active).label}
                                data-testid={`zumba-row-status-${r.id}`}
                              >
                                {chip.label}
                              </span>
                            );
                          })()}
                        </td>
                        {/* The money still owed, and the one button that takes it. Green on
                            a fresh package nothing has been paid on yet; red once part has
                            come in and a balance is left over, because that is the one to
                            chase. A referral's button here takes it onto the branch's books,
                            which is where a fee can be set at all. The cell swallows the
                            click so the button does not also open the record behind it. */}
                        <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                          {r.origin === "consultation" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 border-sky-200 px-2 text-[10px] font-semibold text-sky-700 hover:bg-sky-50"
                              disabled={accepting === r.id}
                              onClick={() => acceptAndEdit(r)}
                              title="Referred on the consultation — take it onto the branch's books to assign a master, set a time and collect the fee"
                              data-testid={`zumba-accept-${r.id}`}
                            >
                              <Stethoscope className="h-3 w-3" />
                              {accepting === r.id ? "Taking on…" : "Referred"}
                            </Button>
                          ) : due > 0 ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className={`h-7 gap-1 px-2 text-[10px] font-semibold ${paid > 0
                                ? "border-rose-300 text-rose-700 hover:bg-rose-50"
                                : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}
                              onClick={() => setCollecting(r)}
                              title={paid > 0 ? `${rupees(due)} balance still due — take a payment` : `${rupees(due)} to collect`}
                              data-testid={`zumba-collect-${r.id}`}
                            >
                              <IndianRupee className="h-3 w-3" />
                              {paid > 0 ? "Due Collect" : "Collect"}
                            </Button>
                          ) : (
                            <span className="text-xs leading-7 text-slate-300">—</span>
                          )}
                        </td>
                        {/* Opens the record, where Edit, Renew and Delete live. */}
                        <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-sky-700"
                            onClick={() => setViewing(r)}
                            title="View"
                            aria-label="View"
                            data-testid={`zumba-view-${r.id}`}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {form && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" data-testid="zumba-dialog">
          {/* Header outside the scroller rather than at the top of it: a close the reader
              has to scroll back up to find is one they will look for on the backdrop
              instead. The body scrolls under it. */}
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">{form.id ? "Edit Zumba Lead" : "Zumba Lead Create"}</h3>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                title="Close"
                aria-label="Close"
                data-testid="zumba-dialog-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Two questions to a row, so the whole form sits on one screen without a
                scroll. The body still scrolls on a short window; Save and Cancel sit in
                a footer outside it so they never scroll away. */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <FieldLabel>Name *</FieldLabel>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" data-testid="zumba-field-name" />
                </div>
                <div className="space-y-1">
                  <FieldLabel>Email</FieldLabel>
                  <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" data-testid="zumba-field-email" />
                </div>

                <div className="space-y-1">
                  <FieldLabel>Phone Number</FieldLabel>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="10-digit number" data-testid="zumba-field-phone" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <FieldLabel>Age</FieldLabel>
                    <Input type="number" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} placeholder="—" data-testid="zumba-field-age" />
                  </div>
                  <div className="space-y-1">
                    <FieldLabel>Gender</FieldLabel>
                    <FormSelect value={form.gender} onChange={(v) => setForm({ ...form, gender: v })} testid="zumba-field-gender">
                      <option value="">Not stated</option>
                      {GENDERS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                    </FormSelect>
                  </div>
                </div>

                <div className="space-y-1">
                  <FieldLabel>Source of the Lead</FieldLabel>
                  <FormSelect
                    value={form.source}
                    onChange={(v) => setForm({ ...form, source: v, master_name: v === MASTER ? form.master_name : "" })}
                    testid="zumba-field-source"
                  >
                    {SOURCES.map((src) => <option key={src.key} value={src.key}>{src.label}</option>)}
                    <option value={MASTER}>Zumba Master</option>
                  </FormSelect>
                </div>

                {/* Time, and nothing beside it: the class a customer comes to already says
                    which master is theirs, so there is no Assign To. Who that is gets named
                    underneath, at the moment it is decided. */}
                <div className="space-y-1">
                  <FieldLabel>Time</FieldLabel>
                  <FormSelect value={form.time_slot} onChange={(v) => setForm({ ...form, time_slot: v })} testid="zumba-field-time">
                    <option value="">Not set</option>
                    {TIME_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
                  </FormSelect>
                  {(() => {
                    if (!form.time_slot) {
                      return (
                        <p className="text-[11px] text-slate-400" data-testid="zumba-field-time-hint">
                          The class time decides the master.
                        </p>
                      );
                    }
                    const teacher = zumbaMasters.find((m) => m.time_slot === form.time_slot);
                    return teacher ? (
                      <p className="text-[11px] text-slate-500" data-testid="zumba-field-time-master">
                        Goes to <span className="font-semibold text-slate-700">{teacher.name}</span>, who takes this class.
                      </p>
                    ) : (
                      // Only ever seen by a branch with no Zumba accounts at all.
                      <p className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-700" data-testid="zumba-field-time-nomaster">
                        No Zumba accounts at this branch yet — add one in HR Admin.
                      </p>
                    );
                  })()}
                </div>

                {/* Which master, asked only once the source says a master referred them.
                    The roster is the names already referred from, so the first referral
                    by a master has to introduce them. */}
                {form.source === MASTER && (
                  <div className="space-y-1.5 rounded-md border border-emerald-100 bg-emerald-50/60 p-2.5 sm:col-span-2">
                    <FieldLabel>Which master referred them?</FieldLabel>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <FormSelect
                        value={form.master_name}
                        onChange={(v) => setForm({ ...form, master_name: v })}
                        testid="zumba-field-master-name"
                      >
                        <option value="">Select a master…</option>
                        {masterOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </FormSelect>
                      <div className="flex items-center gap-2">
                        <Input
                          value={newMaster}
                          onChange={(e) => setNewMaster(e.target.value)}
                          placeholder="New master's name"
                          className="text-xs"
                          data-testid="zumba-field-new-master"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-10 shrink-0 border-emerald-200 text-xs text-emerald-700 hover:bg-emerald-50"
                          disabled={!newMaster.trim()}
                          onClick={() => { setForm({ ...form, source: MASTER, master_name: newMaster.trim() }); setNewMaster(""); }}
                          data-testid="zumba-field-add-master"
                        >
                          Add Master
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Joined is asked rather than taken from when the row was typed — a
                    branch entering last week's walk-ins would otherwise date every
                    membership to the paperwork. */}
                <div className="space-y-1">
                  <FieldLabel>Joined</FieldLabel>
                  <Input
                    type="date"
                    value={form.joined_on || ""}
                    onChange={(e) => setForm({ ...form, joined_on: e.target.value })}
                    data-testid="zumba-field-joined"
                  />
                </div>
                <div className="space-y-1">
                  <FieldLabel>Finishing</FieldLabel>
                  {/* Read-only: it is the joining date plus the plan's length, and a box
                      that could disagree with those two is a third answer. */}
                  <Input
                    type="date"
                    value={finishPreview(form.joined_on, form.package_sessions)}
                    readOnly
                    title={form.package_sessions ? "Follows from the membership below." : "Pick a membership below to set this."}
                    className="bg-slate-50"
                    data-testid="zumba-field-finish"
                  />
                </div>

                {/* The shelf, priced. Picking a membership fills the amount owed; what
                    has actually been handed over is taken later through Collect. */}
                <div className="space-y-1 sm:col-span-2">
                  <FieldLabel>Fee</FieldLabel>
                  <PackagePicker
                    packages={packages}
                    selectedId={form.package_id}
                    onPick={(item) => setForm(item
                      ? {
                          ...form,
                          package_id: item.id,
                          package_name: item.name,
                          package_sessions: planClasses(item) || "",
                          fee_amount: planTotal(item),
                        }
                      : { ...form, package_id: "", package_name: "", package_sessions: "", fee_amount: "" })}
                    prefix="zumba-field-package"
                  />
                </div>

                <div className="space-y-1">
                  <FieldLabel>Fee Amount</FieldLabel>
                  {/* Still editable over the picked plan's price, for a discount; cleared,
                      the plan's price is the placeholder and is what gets saved. */}
                  <Input
                    type="number"
                    value={form.fee_amount}
                    onChange={(e) => setForm({ ...form, fee_amount: e.target.value })}
                    placeholder={pickedPrice ? String(pickedPrice) : "0"}
                    data-testid="zumba-field-amount"
                  />
                </div>
                <p className="self-end pb-1 text-[11px] text-slate-400">
                  {pickedPrice
                    ? `Package price ${rupees(pickedPrice)} — edit to charge a different amount. Collect the fee from the row once registered.`
                    : "Pick a membership above, or type the fee. Collect the fee from the row once registered."}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <Button variant="outline" size="sm" onClick={() => setForm(null)} data-testid="zumba-cancel">Cancel</Button>
              <Button size="sm" className="bg-sky-600 hover:bg-sky-700" disabled={saving} onClick={save} data-testid="zumba-save">
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {collecting && (
        <CollectDueModal
          row={collecting}
          onClose={() => setCollecting(null)}
          onCollected={load}
        />
      )}

      {renewing && (
        <RenewMembershipModal
          row={renewing}
          packages={packages}
          onClose={() => setRenewing(null)}
          onRenewed={load}
        />
      )}

      {viewing && (
        <ViewRegistrationModal
          row={viewing}
          masterNameOf={masterNameOf}
          onEdit={() => { const r = viewing; setViewing(null); openForm(r); }}
          onCollect={() => { const r = viewing; setViewing(null); setCollecting(r); }}
          onRenew={() => { const r = viewing; setViewing(null); setRenewing(r); }}
          onDelete={() => { const r = viewing; setViewing(null); setRemoving(r); }}
          onClose={() => setViewing(null)}
          onSaved={load}
        />
      )}

      {paymentDoneOpen && (
        <PaymentDoneModal
          rows={paymentDoneRows}
          owed={owedRows}
          onShowDue={() => { setPaymentDoneOpen(false); setCard("due_payment"); }}
          onClose={() => setPaymentDoneOpen(false)}
        />
      )}

      {removing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" data-testid="zumba-delete-dialog">
          <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100">
                <Trash2 className="h-5 w-5 text-rose-600" />
              </div>
              <div className="min-w-0">
                {/* Two different acts behind one button, so the dialog says which. A
                    registration is deleted; a referral is only turned away, and saying
                    "cannot be undone" about that would be false. */}
                <h3 className="text-base font-semibold text-slate-900">
                  {removing.origin === "consultation" ? "Turn this referral away?" : "Remove this registration?"}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  <b className="text-slate-700">{removing.name}</b> comes off the Zumba list and out of the counts above.
                  {removing.origin === "consultation"
                    ? " The consultation's own record is untouched, and a fresh Zumba recommendation there brings them back."
                    : " This cannot be undone."}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setRemoving(null)} data-testid="zumba-delete-cancel">Cancel</Button>
              <Button size="sm" className="bg-rose-600 hover:bg-rose-700" onClick={remove} data-testid="zumba-delete-confirm">Yes, Remove</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ZumbaPanel;
