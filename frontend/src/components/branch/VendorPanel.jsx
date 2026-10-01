import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, Search, Pencil, Trash2, Eye, History, Power, Wallet, Receipt,
  Building2, Phone, Mail, X, UserRound, Package, ChevronRight, RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { SummaryTile } from "@/components/ui/summary-tile";
// The date controls every other board on the OS is narrowed by, rather than a third
// spelling of "this month" that only this tab understands. The strip is the five one-tap
// ranges; the calendar beside it is everything else — Yesterday, Last Month, an exact
// day, a typed range — and the board narrows by the two of them intersected.
import { QuickDateFilterBar, intersectDateFilters } from "@/components/QuickDateFilterBar";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import {
  listVendors, vendorDeliveries, createVendor, updateVendor, deleteVendor,
  vendorStock, createVendorStock, updateVendorStock, deleteVendorStock,
  getFinanceExpenses, getBranchCash,
} from "@/lib/api";
// The branch's own Add Expense, opened with the vendor already picked -- the same form and
// the same approval queue as Accountant Manage > Expenses, not a second way to spend.
import { AddExpenseDialog } from "@/components/branch/BranchExpensesPanel";
// The dialog shell, the labelled field and the input class the stock panel already uses.
// Imported rather than copied: the two boards sit on the same tab row and a vendor form
// with its own geometry would read as a different product.
import { Modal, Field, inputCls, fmt, when, errText } from "@/components/branch/StoreInventoryPanel";

/**
 * The three stock shelves a vendor can turn out to supply — the same keys the inventory
 * catalogue and the backend's VALID_CATEGORIES use.
 *
 * Nothing on this tab sets them. They are written by booking a delivery against a vendor
 * in Add Stock, so a vendor's shelves are where their stock actually landed rather than
 * where somebody said it would.
 */
const SHELVES = [
  { key: "tablet", label: "Tablet" },
  { key: "supplementary", label: "Supplementary" },
  { key: "equipment", label: "Equipment" },
];

const SHELF_LABEL = Object.fromEntries(SHELVES.map((s) => [s.key, s.label]));

/**
 * What a stock row is bought for.
 *
 * Three the organisation named, and Other, which opens a box to type into — no list of
 * three survives contact with what a branch actually buys, and a fourth kind shouldn't
 * need a deploy. The server takes the word as typed, so nothing here has to agree with
 * a list anywhere else.
 */
const STOCK_TYPES = ["For Office", "Staffs", "Medical"];

/** The typed-in stock type, kept out of the list by a value no type can have. */
const OTHER_TYPE = "__other__";

/** Matches VALID_PAYMENT_MODES in backend/routers/v3_inventory.py. */
const PAYMENT_MODES = [
  { key: "cash", label: "Cash" },
  { key: "upi", label: "UPI" },
  { key: "card", label: "Card" },
  { key: "account_transfer", label: "Account Transfer" },
];

// Row keys, so a row being removed doesn't make React reuse the one below it and carry
// the wrong text into it. Never saved — the server sees the fields and nothing else.
let rowKey = 0;
const blankRow = () => ({ key: `r${++rowKey}`, name: "", stock_type: "", unit_price: "", paid: "unpaid", paid_amount: "" });

/** What a typed row costs. One row is one thing bought, so its price is its total. */
const rowTotal = (r) => Number(r.unit_price) || 0;

/** A typed row as the server takes it. Unpaid is nought, not a missing number. */
const asStockPayload = (r) => ({
  name: r.name.trim(),
  stock_type: r.stock_type.trim(),
  unit_price: Number(r.unit_price) || 0,
  paid_amount: r.paid === "paid" ? Number(r.paid_amount) || 0 : 0,
});

/** What has gone against a saved stock row, in the words the form asks it in. */
const paidText = (r) => {
  const paid = Number(r.paid_amount || 0);
  if (paid <= 0) return "Unpaid";
  return paid >= Number(r.total || 0) ? "Paid" : `${fmt(paid)} paid`;
};

/**
 * The vendor draft carries more than the form shows.
 *
 * Email, GST, payment terms and notes came off the form in the redesign, but a vendor
 * saved before that still holds them and a save sends the whole record — so they ride
 * along untouched rather than being blanked by a form that no longer asks. The same goes
 * for `active`, which the row's own power button owns now.
 *
 * `address` is on the form again, typed under the city; the rest of that list is not.
 */
const emptyDraft = {
  id: null, name: "", contact_person: "", phone: "", email: "", gst_number: "",
  city: "", address: "", payment_terms: "", notes: "",
  stock_ids: [], amount: "", paid_amount: "", payment_mode: "", payment_date: "",
  active: true,
};

const toDraft = (v) => ({
  id: v.id,
  name: v.name || "",
  contact_person: v.contact_person || "",
  phone: v.phone || "",
  email: v.email || "",
  gst_number: v.gst_number || "",
  city: v.city || "",
  address: v.address || "",
  payment_terms: v.payment_terms || "",
  notes: v.notes || "",
  stock_ids: v.stock_ids || [],
  amount: v.amount ? String(v.amount) : "",
  paid_amount: v.paid_amount ? String(v.paid_amount) : "",
  payment_mode: v.payment_mode || "",
  payment_date: v.payment_date || "",
  active: v.active !== false,
  // Typed rows are always new stock. What this vendor already supplies is in Linked
  // Stock, ticked — editing a vendor is not the place to re-type their whole book.
  rows: [blankRow()],
});

/** A fresh vendor form, with one empty stock row ready to type into. */
const newDraft = (over = {}) => ({ ...emptyDraft, rows: [blankRow()], ...over });

/**
 * Whether a row was written down inside the range asked for.
 *
 * `created_at` is stored UTC and the filter's ends are the reader's own midnights, which
 * is what makes this a Date comparison rather than a string one: for this company those
 * two are five and a half hours apart, and a purchase typed after 5.30am IST is already
 * "yesterday" in the text of its own timestamp.
 *
 * A row with no date at all drops out of any range asked for — it cannot be shown to be
 * inside one — and shows whenever nothing is being asked.
 */
const inRange = (row, range) => {
  const from = range?.from || null;
  const to = range?.to || null;
  if (!from && !to) return true;
  const on = row.created_at ? new Date(row.created_at) : null;
  if (!on || Number.isNaN(on.getTime())) return false;
  if (from && on < from) return false;
  if (to && on > to) return false;
  return true;
};

/**
 * The four figures over the tab, and the four lists under it.
 *
 * They are the filter now rather than a read-out beside one: pressing a card is how the
 * list below it is chosen, and exactly one is pressed at any time. That is what lets each
 * figure be the length or the total of the list its own card opens — a number over a list
 * it does not describe is the thing a summary row is most often wrong about.
 *
 * No per-card icons. The corner glyphs said which card at a glance, which is worth having
 * where a row of cards is only ever read; where it is pressed, the label and the ring
 * around the pressed one carry that, and four glyphs in four corners are four things to
 * look past. The corner arrow is not one of those glyphs: it is the same on all four, so
 * it marks none of them -- the ledger card's own corner (see ui/ledger-card), worn here so
 * this strip matches the branch's other summary strips.
 *
 * `count` is what the card shows and `rows` is what it opens, both off the already
 * filtered lists, so the search box and the date range narrow the figures with the lists.
 */
const CARDS = [
  { key: "vendors", label: "Vendors", color: "#7c3aed" },
  { key: "stock", label: "Stock Items", color: "#0284c7" },
  { key: "outstanding", label: "Outstanding", color: "#d97706" },
  { key: "spend", label: "Purchase Spend", color: "#059669" },
];

/** A shelf chip, still what the Shelves column is drawn with. */
const ShelfChip = ({ label, on = true, onClick, testid }) => {
  const cls = on
    ? "border-violet-200 bg-violet-50 text-violet-700"
    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50";
  return onClick ? (
    <button type="button" onClick={onClick} className={`rounded-[5px] border px-2 py-0.5 text-[11px] font-semibold ${cls}`} data-testid={testid}>
      {label}
    </button>
  ) : (
    <span className={`rounded-[5px] border px-2 py-0.5 text-[11px] font-semibold ${cls}`} data-testid={testid}>{label}</span>
  );
};

/** A required field's label — the red star the reference marks four of them with. */
const Req = ({ children }) => <>{children} <span className="text-rose-500">*</span></>;

/**
 * One titled section of a form. A tinted strip with an icon and a name, then the fields.
 *
 * The strip is doing real work, not decoration: the vendor form asks for three unrelated
 * things at once — who they are, what they supply, what has been paid — and without a
 * line between them it reads as one list of eleven boxes.
 */
const Panel = ({ title, icon: Icon, tint, children, className = "", testid }) => (
  <section className={`overflow-hidden rounded-xl border border-slate-200 ${className}`} data-testid={`vendor-panel-${testid}`}>
    <div className={`flex items-center gap-2 px-4 py-2.5 ${tint}`}>
      <Icon className="h-4 w-4" />
      <p className="text-sm font-bold">{title}</p>
    </div>
    <div className="space-y-3 p-4">{children}</div>
  </section>
);

/** A money figure with its name over it, read-only. */
const Readout = ({ label, value, tone = "text-slate-600" }) => (
  <div>
    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</label>
    <div className={`flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold ${tone}`}><span className="truncate">{value}</span></div>
  </div>
);

/**
 * One stock row's four questions: what it is, what it is for, what it cost, what has been
 * paid against it.
 *
 * Lives out here because two forms ask them — the vendor dialog, where stock is typed in
 * the first place, and the pencil on a stock row, which fixes one already saved. Two
 * copies of four fields is how the two drift into disagreeing about what a stock row is.
 */
const StockFields = ({ row, idx = 0, onChange }) => {
  // A type the list doesn't offer can only have been typed, so the box stays open on it.
  // Picking Other parks a single space here: empty would read as nothing chosen.
  const typed = !!row.stock_type && !STOCK_TYPES.includes(row.stock_type);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={<Req>Stock Name</Req>}>
        <input className={inputCls} value={row.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Enter stock name" data-testid={`stock-row-name-${idx}`} />
      </Field>
      <Field label="Stock Type">
        <select
          className={inputCls}
          value={typed ? OTHER_TYPE : row.stock_type}
          onChange={(e) => onChange({ stock_type: e.target.value === OTHER_TYPE ? " " : e.target.value })}
          data-testid={`stock-row-type-${idx}`}
        >
          <option value="">Select stock type</option>
          {STOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          <option value={OTHER_TYPE}>Other...</option>
        </select>
        {typed && (
          <input
            className={`${inputCls} mt-2`}
            value={row.stock_type.trim()}
            onChange={(e) => onChange({ stock_type: e.target.value || " " })}
            placeholder="Type the stock type"
            data-testid={`stock-row-type-other-${idx}`}
          />
        )}
      </Field>
      <Field label="Stock Price">
        <input type="number" min="0" className={inputCls} value={row.unit_price} onChange={(e) => onChange({ unit_price: e.target.value })} placeholder="Enter price" data-testid={`stock-row-price-${idx}`} />
      </Field>
      <Field label="Payment">
        {/* Unpaid is a state, not a blank box. Choosing Paid opens on the price, which is
            what is owed until somebody says otherwise. */}
        <select
          className={inputCls}
          value={row.paid}
          onChange={(e) => onChange({
            paid: e.target.value,
            paid_amount: e.target.value === "paid" ? (row.paid_amount || row.unit_price) : "",
          })}
          data-testid={`stock-row-paid-${idx}`}
        >
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>
        {row.paid === "paid" && (
          <input
            type="number" min="0"
            className={`${inputCls} mt-2`}
            value={row.paid_amount}
            onChange={(e) => onChange({ paid_amount: e.target.value })}
            placeholder="Paid amount"
            data-testid={`stock-row-paid-amount-${idx}`}
          />
        )}
      </Field>
    </div>
  );
};

/**
 * FITSIOMAX STORE > Vendor — who the organisation buys from, what it buys, what it owes.
 *
 * Two books, added from the two buttons above the table. Stock Detail is what gets bought
 * and at what rate, typed by hand because a purchase is known long before anybody decides
 * whether the thing is ever sold over a counter. Vendor is who supplies it, which of it
 * they supply, and what has been paid against the bill.
 *
 * Both are org-wide, exactly as the sales catalogue is: one vendor across the whole
 * organisation is what makes a spend figure add up and what lets two branches recognise
 * the same supplier. `branchId` only narrows the delivery totals on each row — a Branch
 * Admin is pinned to their own branch by the server whatever this sends, and a Super
 * Admin with none sees every branch's.
 *
 * The delivery totals, the Shelves column and the Supplies list come from somewhere else
 * entirely: the stock ledger, written by Add Stock on the shelf itself. Nothing on this
 * tab moves stock, which is why nothing on it needs to know which branch you are.
 */
export const VendorPanel = ({ branchId, canEdit = true, reloadToken }) => {
  const scope = branchId ? { branch_id: branchId } : {};

  const [vendors, setVendors] = useState([]);
  const [stock, setStock] = useState([]);
  // Which card is pressed, and so which list is under them. Vendors to begin with: it is
  // the first card, and it is what the tab is called.
  const [card, setCard] = useState("vendors");
  const [search, setSearch] = useState("");
  // Two controls, one narrowing. Both lists on the tab answer to it, which is why it
  // sits in the bar over both of them rather than in either card.
  const [quickDate, setQuickDate] = useState(null);
  const [dateFilter, setDateFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState(null);            // the vendor form
  const [stockDraft, setStockDraft] = useState(null);  // the stock detail form
  const [ledger, setLedger] = useState(null);          // { vendor, rows, expenses }
  const [expenseFor, setExpenseFor] = useState(null);  // { vendor, cash } -- Add Expense open

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = branchId ? { branch_id: branchId } : {};
      const [rows, book] = await Promise.all([listVendors(s), vendorStock()]);
      setVendors(rows);
      setStock(book);
    } catch (e) {
      toast.error(errText(e, "Couldn't load the vendors"));
    }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load, reloadToken]);

  /** The strip and the calendar, narrowed together. Either alone is the other's null. */
  const range = useMemo(() => intersectDateFilters(quickDate, dateFilter), [quickDate, dateFilter]);
  const dated = !!(range?.from || range?.to);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter((v) => {
      if (!inRange(v, range)) return false;
      if (!q) return true;
      return `${v.name} ${v.contact_person || ""} ${v.phone || ""} ${v.city || ""}`.toLowerCase().includes(q);
    });
  }, [vendors, search, range]);

  /** The stock list under the same dates. The search box is about vendors, so it isn't. */
  const visibleStock = useMemo(() => stock.filter((r) => inRange(r, range)), [stock, range]);

  /**
   * Vendors that still owe money, and vendors something has actually come in from.
   *
   * Both off `visible`, so they are narrowed by the same search and the same dates as the
   * vendor list itself — and both sorted by the figure their card shows, because a list
   * opened from a total is read from the biggest number down.
   *
   * A balance is floored at nought per vendor, the way the server totals it: one overpaid
   * bill cannot quietly cancel out another vendor's arrears.
   */
  const owing = useMemo(
    () => visible.filter((v) => Number(v.balance || 0) > 0).sort((a, b) => b.balance - a.balance),
    [visible],
  );
  const supplying = useMemo(
    () => visible.filter((v) => Number(v.spend || 0) > 0).sort((a, b) => b.spend - a.spend),
    [visible],
  );

  const figures = useMemo(() => ({
    vendors: { value: visible.length || "—", sub: `${visible.filter((v) => v.active !== false).length} switched on` },
    stock: { value: visibleStock.length || "—", sub: "in the stock list" },
    outstanding: {
      value: fmt(owing.reduce((sum, v) => sum + Number(v.balance || 0), 0)),
      sub: owing.length ? `${owing.length} vendor${owing.length === 1 ? "" : "s"} to pay` : "nothing to pay",
    },
    spend: {
      value: fmt(supplying.reduce((sum, v) => sum + Number(v.spend || 0), 0)),
      sub: "stock booked in, at cost",
    },
  }), [visible, visibleStock, owing, supplying]);

  const stockById = useMemo(() => Object.fromEntries(stock.map((r) => [r.id, r])), [stock]);

  const run = async (fn, successMsg) => {
    setBusy(true);
    try {
      const res = await fn();
      toast.success(res?.message || successMsg);
      await load();
      return true;
    } catch (e) {
      toast.error(errText(e, "That didn't go through"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- the vendor form

  /**
   * What the stock this vendor is already down as supplying comes to.
   *
   * The dialog has no list to tick any more — stock is typed in it instead. This still
   * counts, because clicking a row in the Stock list opens the form with that row's id
   * already on it, and the bill should open on what that row costs.
   */
  const linkedTotal = (ids) => ids.reduce((sum, id) => sum + Number(stockById[id]?.total || 0), 0);

  /**
   * The bill, from what is ticked plus what is typed.
   *
   * Both boxes stay typeable afterwards: a bill carries delivery, discount and tax that no
   * rate on a line knows about. But they open on what the lines add up to, which is right
   * far more often than nought is, and a figure that comes to nothing leaves whatever was
   * typed there alone rather than wiping it.
   */
  const recalc = (d) => {
    const total = linkedTotal(d.stock_ids) + d.rows.reduce((sum, r) => sum + rowTotal(r), 0);
    const paid = d.rows.reduce((sum, r) => sum + (r.paid === "paid" ? Number(r.paid_amount) || 0 : 0), 0);
    return {
      ...d,
      amount: total ? String(total) : d.amount,
      paid_amount: paid ? String(paid) : d.paid_amount,
    };
  };


  const payloadOf = (d) => ({
    name: d.name.trim(),
    contact_person: d.contact_person.trim(),
    phone: d.phone.trim(),
    city: d.city.trim(),
    stock_ids: d.stock_ids,
    amount: Number(d.amount) || 0,
    paid_amount: Number(d.paid_amount) || 0,
    payment_mode: d.payment_mode,
    payment_date: d.payment_date,
    address: d.address.trim(),
    // Carried through untouched — the form stopped asking for these, it didn't delete
    // them. See emptyDraft.
    email: d.email.trim(),
    gst_number: d.gst_number.trim(),
    payment_terms: d.payment_terms.trim(),
    notes: d.notes.trim(),
    active: d.active,
  });

  const saveVendor = async () => {
    // The four stars on the form, in the order they are read. Checked here rather than on
    // the server, which still asks only for a name: an existing vendor saved before these
    // were required would otherwise be unsavable, and the row's power button sends the
    // whole record through this same endpoint just to switch one off.
    const missing = [
      [!draft.name.trim(), "Vendor name is required"],
      [!draft.contact_person.trim(), "Person name is required"],
      [!draft.phone.trim(), "Phone number is required"],
      [!draft.city.trim(), "City is required"],
    ].find(([bad]) => bad);
    if (missing) { toast.error(missing[1]); return; }

    // A row nobody touched is not an entry — the form opens with one, and somebody who
    // only came to add a vendor shouldn't be told off about it.
    const typed = draft.rows.filter((r) => r.name.trim() || r.stock_type.trim() || r.unit_price);
    if (typed.some((r) => !r.name.trim())) { toast.error("Every stock row needs a name"); return; }

    // The stock book first, then the vendor pointing at it. That way round because the
    // vendor needs the ids, and because of how each half fails: stock that lands without
    // its vendor is in the list and can be ticked by hand, a vendor linked to ids that
    // don't exist can't save at all. A clashing name stops here with the vendor untouched.
    let created = [];
    if (typed.length) {
      setBusy(true);
      try {
        const res = await createVendorStock(typed.map(asStockPayload));
        created = (res.stock || []).map((r) => r.id);
      } catch (e) {
        toast.error(errText(e, "Couldn't add the stock"));
        return;
      } finally {
        setBusy(false);
      }
    }

    const d = { ...draft, stock_ids: [...new Set([...draft.stock_ids, ...created])] };
    const ok = await run(
      () => (d.id ? updateVendor(d.id, payloadOf(d), scope) : createVendor(payloadOf(d))),
      d.id ? "Vendor updated" : "Vendor added",
    );
    if (ok) setDraft(null);
  };

  // Switching a vendor off is the ordinary end of one — they stop appearing in Add Stock
  // and their deliveries stay readable. Deleting is only for a row that never bought
  // anything, and the server is the one that enforces that.
  const toggleActive = (v) => run(
    () => updateVendor(v.id, { ...payloadOf(toDraft(v)), active: !(v.active !== false) }, scope),
    v.active !== false ? `${v.name} switched off` : `${v.name} switched on`,
  );

  const removeVendor = async (v) => {
    if (!window.confirm(`Remove ${v.name} from the vendor list?`)) return;
    await run(() => deleteVendor(v.id), "Vendor removed");
  };

  // View: the vendor, what has come in from them, and what has been paid to them out of
  // the expense book -- old expenses typed before the picker included, which the server
  // links to the vendor by name.
  const openLedger = async (v) => {
    try {
      const [res, exp] = await Promise.all([
        vendorDeliveries(v.id, scope),
        getFinanceExpenses({ ...scope, vendor_id: v.id }).catch(() => ({ expenses: [] })),
      ]);
      setLedger({ vendor: v, rows: res.deliveries || [], expenses: exp.expenses || [] });
    } catch (e) {
      toast.error(errText(e, "Couldn't load this vendor"));
    }
  };

  const openAddExpense = async (v) => {
    const box = await getBranchCash({ branch_id: branchId }).catch(() => null);
    setExpenseFor({ vendor: v, cash: box?.cash_in_hand ?? null });
  };

  // ---------------------------------------------------------------- the stock form

  // The rows being typed belong to the vendor form — stock is written where the vendor
  // is, in the one dialog. Every edit re-totals the bill beside it.
  const setRow = (key, patch) => setDraft((d) => recalc({
    ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
  }));
  const addRow = () => setDraft((d) => ({ ...d, rows: [...d.rows, blankRow()] }));
  const dropRow = (key) => setDraft((d) => {
    const left = d.rows.filter((r) => r.key !== key);
    return recalc({ ...d, rows: left.length ? left : [blankRow()] });
  });

  // The pencil on a saved row. Adding moved into the vendor form; fixing a typo in
  // something already in the book still needs somewhere to happen.
  const editStock = (row) => setStockDraft({
    id: row.id,
    key: `r${Date.now()}`,
    name: row.name || "",
    stock_type: row.stock_type || "",
    unit_price: row.unit_price ? String(row.unit_price) : "",
    paid: Number(row.paid_amount || 0) > 0 ? "paid" : "unpaid",
    paid_amount: row.paid_amount ? String(row.paid_amount) : "",
  });

  const saveStock = async () => {
    if (!stockDraft.name.trim()) { toast.error("Type a stock name"); return; }
    const ok = await run(() => updateVendorStock(stockDraft.id, asStockPayload(stockDraft)), "Stock updated");
    if (ok) setStockDraft(null);
  };

  /**
   * Clicking a stock row asks who supplies it.
   *
   * This is the way round the tab is meant to be read: the stock is what a branch knows
   * it buys, and a vendor is the answer to a question about one. The form opens with the
   * row already ticked and the bill already showing what it comes to, so the only things
   * left to type are the ones only a person knows.
   */
  const addVendorFor = (row) => setDraft(newDraft({
    stock_ids: [row.id],
    amount: row.total ? String(row.total) : "",
    paid_amount: row.paid_amount ? String(row.paid_amount) : "",
  }));

  const removeStock = async (row) => {
    const msg = row.vendor_count
      ? `${row.name} is on ${row.vendor_count} vendor${row.vendor_count === 1 ? "" : "s"}. Remove it from the stock list and unlink it from them?`
      : `Remove ${row.name} from the stock list?`;
    if (!window.confirm(msg)) return;
    await run(() => deleteVendorStock(row.id), "Stock removed");
  };

  // ---------------------------------------------------------------- the table

  const empty = loading || visible.length === 0;

  const RowActions = ({ vendor }) => (
    <>
      <Button
        size="sm" variant="outline" className="h-8 border-sky-200 text-sky-700 hover:bg-sky-50"
        onClick={() => openLedger(vendor)}
        data-testid={`vendor-deliveries-${vendor.id}`}
      >
        <Eye className="mr-1 h-3.5 w-3.5" /> View
      </Button>
      {canEdit && (
        <>
          <button
            onClick={() => toggleActive(vendor)}
            className={`rounded p-1.5 ${vendor.active !== false ? "text-emerald-500 hover:bg-emerald-50" : "text-slate-300 hover:bg-slate-100"}`}
            title={vendor.active !== false ? "Switch off" : "Switch on"}
            data-testid={`vendor-toggle-${vendor.id}`}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setDraft(toDraft(vendor))}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-violet-600"
            title="Edit" data-testid={`vendor-edit-${vendor.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => removeVendor(vendor)}
            className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            title="Delete" data-testid={`vendor-delete-${vendor.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </>
  );

  const Supplies = ({ vendor }) => (
    <div className="flex flex-wrap items-center gap-1">
      {(vendor.stock || []).length === 0 ? (
        <span className="text-[11px] text-slate-400">Nothing linked yet</span>
      ) : (
        <>
          {vendor.stock.slice(0, 3).map((r) => (
            <span key={r.id} className="rounded-[5px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">{r.name}</span>
          ))}
          {vendor.stock.length > 3 && (
            <span className="text-[11px] font-semibold text-slate-400">+{vendor.stock.length - 3} more</span>
          )}
        </>
      )}
    </div>
  );

  /** What is on the bill and what is left of it. */
  const Payment = ({ vendor }) => {
    if (!vendor.amount) return <span className="text-[11px] text-slate-400">—</span>;
    const owed = Number(vendor.balance || 0);
    return (
      <>
        <p className="font-medium text-slate-700">{fmt(vendor.amount)}</p>
        <p className={`text-[11px] ${owed > 0 ? "font-semibold text-amber-600" : "text-emerald-600"}`}>
          {owed > 0 ? `${fmt(owed)} due` : "Settled"}
          {vendor.payment_date ? ` · ${vendor.payment_date}` : ""}
        </p>
      </>
    );
  };

  return (
    <div className="space-y-4" data-testid="vendor-panel">
      {/* Press one. See CARDS — the pressed card is the list below, and its figure is
          that list's own length or total. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="vendor-cards">
        {CARDS.map((c) => (
          <SummaryTile
            key={c.key}
            label={c.label}
            value={figures[c.key].value}
            sub={figures[c.key].sub}
            arrow
            color={c.color}
            active={card === c.key}
            onClick={() => setCard(c.key)}
            testid={`vendor-card-${c.key}`}
          />
        ))}
      </div>

      {/* The toolbar every list on the OS is read through: search, the five one-tap
          ranges, the calendar for everything else, a refresh, and the one button that
          adds. Same order and same controls as the patient list and the leads board, so
          a desk that moves between them is not learning a third arrangement.

          The row wraps rather than scrolls. On a phone the search takes the first line
          and the ranges and actions the second, which is where five buttons and four
          icons honestly sit at 390px. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vendor, contact or city..."
              className={`${inputCls} h-10 pl-9`}
              data-testid="vendor-search"
            />
          </div>

          {/* Dates, where the shelf chips were. The chips filtered by where a vendor's
              stock had landed, which is a fact about the ledger rather than about the
              vendor; when it was written down is the question a purchase book is asked.
              Both lists below answer to it. The Shelves column still reads the same.

              No Custom trigger on the strip: the calendar beside it is that same popover,
              and two doors onto one control is what the leads toolbar already took out. */}
          <QuickDateFilterBar
            value={quickDate}
            onChange={setQuickDate}
            testid="vendor-quick-date"
            inline
            showCustom={false}
          />
          <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="vendor-date-filter" centered iconOnly />

          {/* Both lists are a snapshot. Stock typed at another desk, or a delivery booked
              in on a shelf, appears here only on a reload, and there was no way to ask
              for one short of leaving the tab and coming back. */}
          <Button
            onClick={load}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="vendor-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>

          {/* One button, because there is one dialog — stock is typed inside it. An icon
              like the rest of the actions, with the words on title and aria-label: the
              row is read by position here and on every other board, and a lone worded
              button on the end of four glyphs reads as belonging to something else. */}
          {canEdit && (
            <Button
              onClick={() => setDraft(newDraft())}
              title="Add Vendor"
              aria-label="Add Vendor"
              className="h-10 w-10 shrink-0 bg-violet-600 p-0 text-white hover:bg-violet-700"
              data-testid="vendor-new"
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </CardContent>
      </Card>

      {/* What the Stock Items card opens. It used to sit above the vendor table with
          both on screen at once, which read as two tabs' worth of list stacked on one
          page; the cards are the way between them now. */}
      {card === "stock" && (
      <Card className="overflow-hidden" data-testid="stock-card">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Stock{visibleStock.length ? ` · ${visibleStock.length}` : ""}
            </p>
            {visibleStock.length > 0 && canEdit && (
              <p className="text-[11px] text-slate-400">Click a stock to add the vendor who supplies it</p>
            )}
          </div>

          {loading ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="stock-loading">Loading stock...</p>
          ) : visibleStock.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="stock-empty">
              {stock.length > 0 ? "No stock was added in the range chosen."
                : canEdit ? <>No stock yet — use <span className="font-semibold">Add Vendor</span> to type in what the branch buys and who supplies it.</>
                  // A screen that cannot add one shouldn't name the button that does.
                  : "No stock has been written down yet."}
            </p>
          ) : (
            <div className="divide-y divide-slate-100" data-testid="stock-list">
              {visibleStock.map((r) => (
                <div key={r.id} className="flex items-center gap-1 px-2 py-1" data-testid={`stock-item-${r.id}`}>
                  <button
                    type="button"
                    onClick={() => canEdit && addVendorFor(r)}
                    disabled={!canEdit}
                    className={`min-w-0 flex-1 rounded-lg px-2 py-2 text-left ${canEdit ? "hover:bg-violet-50" : "cursor-default"}`}
                    data-testid={`stock-pick-${r.id}`}
                  >
                    <p className="truncate text-sm font-semibold text-slate-800">{r.name}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {[
                        r.stock_type,
                        // Only rows typed back when the form asked how many carry a count.
                        r.count ? `${r.count}${r.unit ? ` ${r.unit}` : ""}` : "",
                        r.total ? fmt(r.total) : "",
                        paidText(r),
                      ].filter(Boolean).join(" · ")}
                    </p>
                  </button>

                  {/* Who already supplies it. Two names and a count, not the whole list —
                      the vendor table below is where the whole list lives. */}
                  <div className="hidden min-w-0 shrink-0 items-center gap-1 sm:flex" data-testid={`stock-vendors-${r.id}`}>
                    {(r.vendors || []).length === 0 ? (
                      <span className="text-[11px] italic text-slate-400">No vendor yet</span>
                    ) : (
                      <>
                        {r.vendors.slice(0, 2).map((vn) => (
                          <span key={vn.id} className="max-w-[140px] truncate rounded-[5px] border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                            {vn.name}
                          </span>
                        ))}
                        {r.vendors.length > 2 && (
                          <span className="text-[11px] font-semibold text-slate-400">+{r.vendors.length - 2}</span>
                        )}
                      </>
                    )}
                  </div>

                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => editStock(r)}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"
                        title="Edit this stock" data-testid={`stock-edit-${r.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => removeStock(r)}
                        className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        title="Remove this stock" data-testid={`stock-drop-${r.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <ChevronRight className="ml-0.5 h-4 w-4 shrink-0 text-slate-300" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {card === "vendors" && (
      <Card className="overflow-hidden" data-testid="vendor-table-card">
        <CardContent className="p-0">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Vendors</p>
          </div>

          {empty ? (
            <p className="px-4 py-14 text-center text-sm text-slate-400" data-testid="vendor-empty">
              {loading ? "Loading vendors..."
                : vendors.length === 0 ? (canEdit ? "No vendors yet — add one, and type what it supplies while you are there." : "No vendors yet.")
                  : dated ? "No vendors match that search in the range chosen."
                    : "Nothing matches that search."}
            </p>
          ) : (
            <>
              {/* Cards on a phone. The row is eight columns wide before it is readable and
                  the actions are the first thing to fall off the right edge. */}
              <div className="space-y-2 p-3 sm:hidden" data-testid="vendor-list-mobile">
                {visible.map((v, i) => (
                  <div key={v.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`vendor-card-${v.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">
                          <span className="mr-1.5 font-semibold text-slate-300">{i + 1}.</span>{v.name}
                        </p>
                        <p className="truncate text-xs text-slate-500">{v.contact_person || "No contact person"}{v.phone ? ` · ${v.phone}` : ""}</p>
                      </div>
                      {v.active === false && (
                        <span className="shrink-0 rounded-[5px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-bold text-slate-500">Off</span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(v.categories || []).map((c) => <ShelfChip key={c} label={SHELF_LABEL[c] || c} />)}
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      {v.stock_count} stock · {v.deliveries} deliver{v.deliveries === 1 ? "y" : "ies"}
                      {v.amount ? ` · ${fmt(v.amount)} billed` : ""}
                      {v.balance > 0 ? ` · ${fmt(v.balance)} due` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <RowActions vendor={v} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto sm:block" data-testid="vendor-list-desktop">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-500 text-left text-[11px] uppercase tracking-wide text-white">
                    <tr>
                      <th className="w-12 px-4 py-2.5 font-semibold">S.No</th>
                      <th className="px-4 py-2.5 font-semibold">Vendor</th>
                      <th className="px-4 py-2.5 font-semibold">Contact</th>
                      <th className="px-4 py-2.5 font-semibold">Shelves</th>
                      <th className="px-4 py-2.5 font-semibold">Stock</th>
                      <th className="px-4 py-2.5 font-semibold">Payment</th>
                      <th className="px-4 py-2.5 font-semibold">Deliveries</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visible.map((v, i) => (
                      <tr key={v.id} className={`hover:bg-slate-50 ${v.active === false ? "opacity-60" : ""}`} data-testid={`vendor-row-${v.id}`}>
                        {/* A position in the list on screen, never an id — every action
                            here goes against the vendor's own id. */}
                        <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">
                            {v.name}
                            {v.active === false && <span className="ml-1.5 rounded-[5px] border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">Off</span>}
                          </p>
                          <p className="text-[11px] text-slate-400">{v.city || "—"}{v.gst_number ? ` · ${v.gst_number}` : ""}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          <p>{v.contact_person || "—"}</p>
                          <p className="text-[11px] text-slate-400">{v.phone || v.email || "No number"}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(v.categories || []).length === 0
                              ? <span className="text-[11px] text-slate-400">—</span>
                              : v.categories.map((c) => <ShelfChip key={c} label={SHELF_LABEL[c] || c} />)}
                          </div>
                        </td>
                        <td className="px-4 py-3"><Supplies vendor={v} /></td>
                        <td className="px-4 py-3"><Payment vendor={v} /></td>
                        <td className="px-4 py-3 text-slate-600">
                          {v.deliveries}
                          <span className="block text-[11px] text-slate-400">{fmt(v.spend)} · {v.last_supplied_at ? when(v.last_supplied_at) : "never"}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <RowActions vendor={v} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      )}

      {/* The two money cards open a list rather than a table: each is one question — who
          is owed, and who has actually delivered — and a column of eight for a question
          of one is a table you have to read past to answer it.

          Both carry the Deliveries button, because both figures are asked the same
          follow-up: what is this made of. */}
      {card === "outstanding" && (
        <Card className="overflow-hidden" data-testid="outstanding-card">
          <CardContent className="p-0">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Still to pay{owing.length ? ` · ${owing.length}` : ""}
              </p>
            </div>
            {loading ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="outstanding-loading">Loading vendors...</p>
            ) : owing.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="outstanding-empty">
                {vendors.length === 0 ? "No vendors yet." : "Nothing is outstanding — every bill on this list is settled."}
              </p>
            ) : (
              <div className="divide-y divide-slate-100" data-testid="outstanding-list">
                {owing.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`outstanding-row-${v.id}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{v.name}</p>
                      <p className="truncate text-[11px] text-slate-500">
                        {[v.city, v.contact_person, v.phone].filter(Boolean).join(" · ") || "No contact details"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-amber-600">{fmt(v.balance)}</p>
                      <p className="text-[11px] text-slate-400">
                        {fmt(v.paid_amount)} paid of {fmt(v.amount)}
                        {v.payment_date ? ` · ${v.payment_date}` : ""}
                      </p>
                    </div>
                    <Button
                      size="sm" variant="outline" className="h-8 shrink-0 border-sky-200 text-sky-700 hover:bg-sky-50"
                      onClick={() => openLedger(v)}
                      data-testid={`outstanding-deliveries-${v.id}`}
                    >
                      <History className="mr-1 h-3.5 w-3.5" /> Deliveries
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {card === "spend" && (
        <Card className="overflow-hidden" data-testid="spend-card">
          <CardContent className="p-0">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Booked in{supplying.length ? ` · ${supplying.length}` : ""}
              </p>
            </div>
            {loading ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="spend-loading">Loading vendors...</p>
            ) : supplying.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="spend-empty">
                {/* Spend is written by the stock ledger, not by this tab — a vendor can be
                    fully typed in and still have nothing here until a delivery is booked
                    in against them on a shelf. Saying so is the difference between an
                    empty list and a list somebody thinks is broken. */}
                {vendors.length === 0
                  ? "No vendors yet."
                  : "Nothing has been booked in yet — spend is written when a delivery is added on a stock shelf."}
              </p>
            ) : (
              <div className="divide-y divide-slate-100" data-testid="spend-list">
                {supplying.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`spend-row-${v.id}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{v.name}</p>
                      <p className="truncate text-[11px] text-slate-500">
                        {v.deliveries} deliver{v.deliveries === 1 ? "y" : "ies"} · {v.units_supplied} unit{v.units_supplied === 1 ? "" : "s"}
                        {v.last_supplied_at ? ` · ${when(v.last_supplied_at)}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-emerald-700">{fmt(v.spend)}</p>
                      <div className="flex flex-wrap justify-end gap-1">
                        {(v.categories || []).map((c) => <ShelfChip key={c} label={SHELF_LABEL[c] || c} />)}
                      </div>
                    </div>
                    <Button
                      size="sm" variant="outline" className="h-8 shrink-0 border-sky-200 text-sky-700 hover:bg-sky-50"
                      onClick={() => openLedger(v)}
                      data-testid={`spend-deliveries-${v.id}`}
                    >
                      <History className="mr-1 h-3.5 w-3.5" /> Deliveries
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {stockDraft && (
        <Modal
          title="Edit Stock Detail"
          onClose={() => setStockDraft(null)}
          testid="stock-modal"
          light
          width="max-w-xl"
          bodyCls="p-4"
          footer={<>
            <Button variant="outline" onClick={() => setStockDraft(null)} data-testid="stock-cancel">Cancel</Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy} onClick={saveStock} data-testid="stock-save">
              Save Changes
            </Button>
          </>}
        >
          <Panel title="Stock Details" icon={Package} tint="bg-emerald-50/70 text-emerald-700" testid="stock-entry">
            <StockFields row={stockDraft} onChange={(patch) => setStockDraft({ ...stockDraft, ...patch })} />
          </Panel>
        </Modal>
      )}

      {draft && (
        <Modal
          title={draft.id ? "Edit Vendor" : "Add Vendor"}
          onClose={() => setDraft(null)}
          testid="vendor-modal"
          light
          width="max-w-4xl"
          bodyCls="p-4"
          footer={<>
            <Button variant="outline" onClick={() => setDraft(null)} data-testid="vendor-cancel">Cancel</Button>
            <Button className="bg-violet-600 text-white hover:bg-violet-700" disabled={busy} onClick={saveVendor} data-testid="vendor-save">
              {draft.id ? "Save Changes" : "Save Vendor"}
            </Button>
          </>}
        >
          {/* Who they are down the left; what is being bought and what has been paid
              down the right. They stack on a phone, vendor first. */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Vendor Details" icon={UserRound} tint="bg-violet-50/70 text-violet-700" testid="vendor-details">
              <Field label={<Req>Vendor Name</Req>}>
                <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Enter vendor name" data-testid="vendor-name" />
              </Field>
              <Field label={<Req>Person Name</Req>}>
                <input className={inputCls} value={draft.contact_person} onChange={(e) => setDraft({ ...draft, contact_person: e.target.value })} placeholder="Enter person name" data-testid="vendor-contact" />
              </Field>
              <Field label={<Req>Phone Number</Req>}>
                <input className={inputCls} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="Enter phone number" data-testid="vendor-phone" />
              </Field>
              {/* Typed, not picked. The list here used to be the branch names, which is
                  where the organisation is, not where a vendor is — a supplier in a town
                  the org has no branch in could only be entered through Other, and the
                  list read as though a vendor had to belong to a branch. */}
              <Field label={<Req>City</Req>}>
                <input
                  className={inputCls}
                  value={draft.city}
                  onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                  placeholder="Enter city"
                  data-testid="vendor-city"
                />
              </Field>
              {/* The rest of where they are — the city above is only the town. Optional:
                  plenty of vendors are a name and a phone number, and one that is
                  shouldn't be unsaveable for want of a door number. */}
              <Field label="Address">
                <textarea
                  rows={3}
                  className={`${inputCls} h-auto resize-y py-2 leading-5`}
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                  placeholder="Door no, street, area, pincode"
                  data-testid="vendor-address"
                />
              </Field>
            </Panel>

            <div className="space-y-4 lg:col-span-2">
              {/* Stock is typed here rather than in a dialog of its own: a vendor and what
                  they supply are one thought, and asking for them separately meant opening
                  two forms, in the right order, to write down one purchase. */}
              <Panel title="Stock Details" icon={Package} tint="bg-emerald-50/70 text-emerald-700" testid="vendor-stock-entry">
                {draft.rows.map((r, idx) => (
                  <div key={r.key} className={idx > 0 ? "border-t border-slate-100 pt-3" : ""} data-testid={`stock-row-${idx}`}>
                    {draft.rows.length > 1 && (
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Stock {idx + 1}</span>
                        <button
                          type="button"
                          onClick={() => dropRow(r.key)}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Remove this row" data-testid={`stock-row-drop-${idx}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    <StockFields row={r} idx={idx} onChange={(patch) => setRow(r.key, patch)} />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addRow}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-emerald-300 px-3 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                  data-testid="stock-row-add"
                >
                  <Plus className="h-4 w-4" /> Add Another Stock
                </button>
              </Panel>

              <Panel title="Payment to Vendor" icon={Wallet} tint="bg-amber-50/70 text-amber-700" testid="vendor-payment">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Total Amount">
                    {/* Filled in from the stock typed above and left typeable: a bill
                        carries delivery, discount and tax that no rate on a line knows
                        about. */}
                    <input type="number" min="0" className={inputCls} value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="Enter amount" data-testid="vendor-amount" />
                  </Field>
                  <Field label="Paid Amount">
                    <input type="number" min="0" className={inputCls} value={draft.paid_amount} onChange={(e) => setDraft({ ...draft, paid_amount: e.target.value })} placeholder="Enter paid" data-testid="vendor-paid" />
                  </Field>
                  <Readout
                    label="Balance"
                    value={fmt((Number(draft.amount) || 0) - (Number(draft.paid_amount) || 0))}
                    tone={(Number(draft.amount) || 0) - (Number(draft.paid_amount) || 0) > 0 ? "text-amber-700" : "text-emerald-700"}
                  />
                  <Field label="Payment Mode">
                    <select className={inputCls} value={draft.payment_mode} onChange={(e) => setDraft({ ...draft, payment_mode: e.target.value })} data-testid="vendor-mode">
                      <option value="">Not paid yet</option>
                      {PAYMENT_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Payment Date">
                    <input type="date" className={inputCls} value={draft.payment_date} onChange={(e) => setDraft({ ...draft, payment_date: e.target.value })} data-testid="vendor-paid-on" />
                  </Field>
                </div>
              </Panel>
            </div>
          </div>
        </Modal>
      )}

      {ledger && (() => {
        const v = ledger.vendor;
        const exps = ledger.expenses || [];
        const sum = (rows) => rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
        const pending = exps.filter((r) => !r.approved && !r.rejected);
        return (
          <Modal
            title={v.name}
            subtitle={[v.contact_person, v.phone, v.city].filter(Boolean).join(" · ") || "Vendor details"}
            accent="bg-sky-600"
            width="max-w-2xl"
            onClose={() => setLedger(null)}
            testid="vendor-ledger-modal"
            footer={(
              <>
                {branchId && v.active !== false && (
                  <Button
                    className="bg-violet-600 text-white hover:bg-violet-700"
                    onClick={() => openAddExpense(v)}
                    data-testid="vendor-add-expense"
                  >
                    <Plus className="mr-1 h-4 w-4" /> Add Expense
                  </Button>
                )}
                <Button variant="outline" onClick={() => setLedger(null)} data-testid="vendor-ledger-close">Close</Button>
              </>
            )}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="vendor-view-details">
              <Readout label="GST" value={v.gst_number || "—"} />
              <Readout label="Email" value={v.email || "—"} />
              <Readout label="Terms" value={v.payment_terms || "—"} />
              <Readout label="Status" value={v.active !== false ? "Active" : "Switched off"} tone={v.active !== false ? "text-emerald-600" : "text-slate-400"} />
              <Readout label="Bill" value={fmt(v.amount)} />
              <Readout label="Balance" value={fmt(v.balance)} tone={Number(v.balance) > 0 ? "text-amber-600" : "text-emerald-600"} />
              <Readout label="Expenses paid" value={fmt(sum(exps.filter((r) => r.approved)))} />
              <Readout label="Awaiting approval" value={pending.length ? `${pending.length} · ${fmt(sum(pending))}` : "None"} />
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <Receipt className="h-3.5 w-3.5" /> Expenses ({exps.length})
              </p>
              {exps.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 py-5 text-center text-sm text-slate-400" data-testid="vendor-expenses-empty">
                  No expenses paid to this vendor yet.
                </p>
              ) : (
                <div className="space-y-2" data-testid="vendor-expenses">
                  {exps.map((r) => (
                    <div key={r.id} className="rounded-lg border border-slate-200 p-2.5" data-testid={`vendor-expense-${r.id}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-800">{r.category}</p>
                        <p className="shrink-0 text-sm font-bold text-slate-700">{fmt(r.amount)}</p>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {r.expense_date || "—"}
                        {r.branch_name ? ` · ${r.branch_name}` : ""}
                        {r.reference ? ` · ${r.reference}` : ""}
                        {r.note ? ` · ${r.note}` : ""}
                        {" · "}
                        <span className={`font-semibold ${r.rejected ? "text-rose-600" : r.approved ? "text-emerald-600" : "text-amber-600"}`}>
                          {r.rejected ? "Rejected" : r.approved ? "Approved" : "Awaiting approval"}
                        </span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <Package className="h-3.5 w-3.5" /> Deliveries ({ledger.rows.length})
              </p>
              {ledger.rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 py-5 text-center text-sm text-slate-400" data-testid="vendor-ledger-empty">
                  Nothing has come in from this vendor yet. Book it in from the stock shelf&apos;s Add button.
                </p>
              ) : (
                <div className="space-y-2">
                  {ledger.rows.map((m) => (
                    <div key={m.id} className="rounded-lg border border-slate-200 p-2.5" data-testid={`vendor-ledger-${m.id}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-800">{m.item_name}</p>
                        <p className="shrink-0 text-sm font-bold text-slate-700">+{m.qty}</p>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {when(m.created_at)} · {fmt(m.amount)}
                        {m.note ? ` · ${m.note}` : ""}
                        {m.by_user_name ? ` · ${m.by_user_name}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

      {expenseFor && (
        <AddExpenseDialog
          onClose={() => setExpenseFor(null)}
          onSaved={() => {
            const v = expenseFor.vendor;
            setExpenseFor(null);
            openLedger(v);
          }}
          cashInHand={expenseFor.cash}
          branchId={branchId}
          branches={[]}
          pastRows={ledger?.vendor?.id === expenseFor.vendor.id ? ledger.expenses : []}
          initialVendorId={expenseFor.vendor.id}
        />
      )}

      {/* Where the contact details actually get used, said once rather than on every row:
          the tab is a directory, and a directory that doesn't say how to reach anyone is
          a list of names. */}
      {!loading && vendors.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" />Shared across every branch</span>
          <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />Ordering contact</span>
          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />Invoices</span>
        </p>
      )}
    </div>
  );
};

export default VendorPanel;
