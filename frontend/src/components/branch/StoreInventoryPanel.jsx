import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, PackagePlus, ShoppingCart, ArrowRightLeft, Pencil, Trash2, Search, X, History,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import {
  listInventoryItems, inventorySummary, inventoryMovements,
  createInventoryItem, updateInventoryItem, deleteInventoryItem,
  addInventoryStock, sellInventoryItem, transferInventoryItem,
  getBranches, listVendors,
} from "@/lib/api";

/**
 * What differs between the three shelves this panel serves.
 *
 * Stock is the same problem on all of them — a count, a sale, a transfer — but the words
 * are not. A treadmill does not come in strips and a protein tub is not a piece, and a
 * unit list that has to cover everything ends up meaning nothing on any of them. The
 * `units` here are a subset of what the backend accepts; anything added to one must be
 * added there too or the save is refused.
 *
 * `low` is the default alert level for a new item. Ten is a shelf of tablets and a
 * fortnight of sachets; two is a lot of treadmills.
 */
const CATEGORIES = {
  tablet: {
    noun: "Tablet", plural: "Tablets",
    units: ["Strip", "Bottle", "Tube", "Sachet", "Pack", "Box"], defaultUnit: "Strip", low: 10,
    searchHint: "Search tablet or brand...",
    empty: "No tablets yet — add one to start tracking stock.",
    namePlaceholder: "e.g. Paracetamol 500mg",
    brandPlaceholder: "e.g. Calpol",
  },
  supplementary: {
    noun: "Supplement", plural: "Supplements",
    units: ["Bottle", "Sachet", "Pack", "Box", "Tube"], defaultUnit: "Bottle", low: 10,
    searchHint: "Search supplement or brand...",
    empty: "No supplements yet — add one to start tracking stock.",
    namePlaceholder: "e.g. Whey Protein 1kg",
    brandPlaceholder: "e.g. Optimum Nutrition",
  },
  equipment: {
    noun: "Equipment", plural: "Equipment",
    units: ["Piece", "Set", "Pair", "Box", "Pack"], defaultUnit: "Piece", low: 2,
    searchHint: "Search equipment or brand...",
    empty: "No equipment yet — add one to start tracking stock.",
    namePlaceholder: "e.g. Resistance Band (Medium)",
    brandPlaceholder: "e.g. Decathlon",
  },
};

const PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "account_transfer", label: "Account Transfer" },
];

export const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const errText = (e, fallback) => e?.response?.data?.detail || fallback;

const MOVEMENT_META = {
  add: { label: "Added", classes: "border-sky-200 bg-sky-50 text-sky-700", sign: "+" },
  sale: { label: "Sold", classes: "border-emerald-200 bg-emerald-50 text-emerald-700", sign: "−" },
  transfer_out: { label: "Moved out", classes: "border-amber-200 bg-amber-50 text-amber-700", sign: "−" },
  transfer_in: { label: "Moved in", classes: "border-violet-200 bg-violet-50 text-violet-700", sign: "+" },
};

export const when = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso.slice(0, 16); }
};

/** One dialog shell for all four forms, so a fifth doesn't arrive with its own geometry. */
/**
 * The store's dialog shell.
 *
 * `width` and `light` are both opt-in and both default to what every form here already
 * looked like — a narrow column under a coloured bar. The Vendor form is the one that
 * asks for something else: it is two columns side by side, and a deep header over a form
 * that wide reads as a banner rather than a title, so it takes a plain one.
 *
 * `bodyCls` is there for the same reason. The stacked forms want the shell to space their
 * fields out; a form that lays out its own columns wants the shell to keep out of it.
 */
export const Modal = ({
  title, subtitle, accent = "bg-violet-600", onClose, children, footer, testid,
  width = "max-w-md", light = false, bodyCls = "space-y-3 p-5",
}) => (
  <div
    className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4"
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    data-testid={testid}
  >
    <div className={`flex max-h-[92vh] w-full ${width} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}>
      {light ? (
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <p className="min-w-0 truncate text-[15px] font-bold text-slate-800">{title}</p>
          <button onClick={onClose} className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" data-testid={`${testid}-close`}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className={`flex items-start justify-between gap-3 px-5 py-4 text-white ${accent}`}>
          <div className="min-w-0">
            <p className="text-base font-semibold">{title}</p>
            {subtitle && <p className="truncate text-xs text-white/80">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid={`${testid}-close`}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className={`flex-1 overflow-y-auto ${bodyCls}`}>{children}</div>
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">{footer}</div>
    </div>
  </div>
);

export const Field = ({ label, children, hint }) => (
  <div>
    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</label>
    {children}
    {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
  </div>
);

export const inputCls = "h-9 w-full rounded-md border border-slate-200 px-3 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400";

/** Stock reads as a state, not a number: out, nearly out, or fine. */
const StockBadge = ({ qty, low }) => {
  const tone = qty <= 0 ? "border-rose-200 bg-rose-50 text-rose-700"
    : low ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <span className={`inline-flex items-center gap-1 rounded-[5px] border px-2 py-0.5 text-xs font-bold ${tone}`}>
      {qty <= 0 ? "Out of stock" : qty}
    </span>
  );
};

/**
 * Stock for one Fitsiomax Store shelf. Tablet, Supplementary and Equipment are the same
 * board with different words on it — the counting, selling and moving are identical, so
 * they are one component rather than three that drift.
 *
 * Mounted with a `key` of the category so switching tabs remounts rather than showing the
 * previous shelf's rows while the new ones load.
 */
/**
 * One shelf of the Fitsiomax Store: the catalogue, this branch's count against each row,
 * and the add / sell / move that change it.
 *
 * `branchId` is which branch's stock is being looked at, and it is optional. A Branch
 * Admin omits it — the backend pins them to their own branch whatever they send, so
 * sending nothing is both correct and the safer default. A Super Admin has no branch of
 * their own, so they name one, and every call that touches stock has to carry it: the
 * server refuses with "branch_id is required" rather than guessing.
 *
 * The catalogue itself is org-wide, so creating and deleting an entry carry no branch.
 * That asymmetry is the point of the split — one spelling of a tablet across the whole
 * organisation is what lets two branches transfer it to each other.
 */
export const StoreInventoryPanel = ({ category = "tablet", branchId, reloadToken }) => {
  const CAT = CATEGORIES[category] || CATEGORIES.tablet;
  // Spread into every stock-scoped call. Empty for a Branch Admin, so their requests go
  // out exactly as they did before this prop existed.
  const scope = branchId ? { branch_id: branchId } : {};
  // Test ids carry the category, so the three shelves stay distinguishable in a run and
  // the Tablet ones keep the names they already had.
  const tid = (s) => `${category}-${s}`;

  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [movements, setMovements] = useState([]);
  const [branches, setBranches] = useState([]);
  // The Vendor tab's list, for the Add Stock picker. Switched-off vendors are left out
  // — the server refuses stock booked against one, and offering it is offering an error.
  const [vendors, setVendors] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // One at a time: whichever of the four forms is open, and the row it is about.
  const [itemDraft, setItemDraft] = useState(null);    // create / edit catalogue entry
  const [addDraft, setAddDraft] = useState(null);      // stock in
  const [sellDraft, setSellDraft] = useState(null);    // counter sale
  const [moveDraft, setMoveDraft] = useState(null);    // send to another branch

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = branchId ? { branch_id: branchId } : {};
      const [rows, totals, ledger] = await Promise.all([
        listInventoryItems({ category, ...s }),
        inventorySummary({ category, ...s }),
        inventoryMovements({ category, limit: 50, ...s }),
      ]);
      setItems(rows);
      setSummary(totals);
      setMovements(ledger.movements || []);
    } catch (e) {
      toast.error(errText(e, `Couldn't load the ${CAT.noun.toLowerCase()} stock`));
    }
    setLoading(false);
  }, [category, CAT.noun, branchId]);

  // reloadToken is bumped by the store's Refresh; `load` itself is unchanged by it, so it
  // has to be named here or the button would do nothing on a stock shelf.
  useEffect(() => { load(); }, [load, reloadToken]);
  // Only needed by the move form, but fetched once here rather than on each open.
  useEffect(() => { getBranches().then(setBranches).catch(() => {}); }, []);
  useEffect(() => {
    listVendors({ category, active_only: true, ...(branchId ? { branch_id: branchId } : {}) })
      .then(setVendors)
      .catch(() => setVendors([]));
  }, [category, branchId]);

  // Filtered in the browser: the whole catalogue is already loaded, and a round trip per
  // keystroke would be slower than the list is long.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.name} ${i.brand || ""}`.toLowerCase().includes(q));
  }, [items, search]);

  // Where stock can be moved TO. The branch being viewed is dropped: the server refuses a
  // move to the branch the stock is already at, and offering it is offering an error. A
  // Branch Admin passes no branchId, and their own branch is filtered server-side, so this
  // only bites for a Super Admin looking at a named shelf.
  const branchOptions = useMemo(
    () => branches
      .filter((b) => b.id !== branchId)
      .map((b) => ({ id: b.id, name: b.branch_name || b.name || "Unnamed branch" })),
    [branches, branchId],
  );

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

  const saveItem = async () => {
    const d = itemDraft;
    if (!d.name.trim()) { toast.error("Name is required"); return; }
    const payload = {
      category,
      name: d.name.trim(),
      brand: d.brand.trim(),
      unit: d.unit,
      sale_price: Number(d.sale_price) || 0,
      cost_price: Number(d.cost_price) || 0,
      low_stock_at: Number(d.low_stock_at) || 0,
      notes: d.notes.trim(),
    };
    const ok = await run(
      () => (d.id ? updateInventoryItem(d.id, payload, scope) : createInventoryItem(payload)),
      d.id ? `${CAT.noun} updated` : `${CAT.noun} added to the catalogue`,
    );
    if (ok) setItemDraft(null);
  };

  const removeItem = async (item) => {
    // The server refuses while any branch still holds stock and says where it is, so the
    // only thing worth confirming here is the intent.
    if (!window.confirm(`Remove ${item.name} from the catalogue?`)) return;
    await run(() => deleteInventoryItem(item.id), `${CAT.noun} removed`);
  };

  const submitAdd = async () => {
    const qty = Number(addDraft.qty);
    if (!qty || qty < 1) { toast.error("Quantity must be at least 1"); return; }
    const ok = await run(() => addInventoryStock(addDraft.item.id, {
      qty,
      cost_price: addDraft.cost_price === "" ? null : Number(addDraft.cost_price),
      vendor_id: addDraft.vendor_id || null,
      supplier: addDraft.supplier.trim(),
      note: addDraft.note.trim(),
    }, scope), "Stock added");
    if (ok) setAddDraft(null);
  };

  const submitSell = async () => {
    const qty = Number(sellDraft.qty);
    if (!qty || qty < 1) { toast.error("Quantity must be at least 1"); return; }
    if (qty > sellDraft.item.stock) { toast.error(`Only ${sellDraft.item.stock} in stock`); return; }
    const ok = await run(() => sellInventoryItem(sellDraft.item.id, {
      qty,
      unit_price: sellDraft.unit_price === "" ? null : Number(sellDraft.unit_price),
      customer_name: sellDraft.customer_name.trim(),
      payment_mode: sellDraft.payment_mode,
      note: sellDraft.note.trim(),
    }, scope), "Sale recorded");
    if (ok) setSellDraft(null);
  };

  const submitMove = async () => {
    const qty = Number(moveDraft.qty);
    if (!qty || qty < 1) { toast.error("Quantity must be at least 1"); return; }
    if (qty > moveDraft.item.stock) { toast.error(`Only ${moveDraft.item.stock} in stock`); return; }
    if (!moveDraft.to_branch_id) { toast.error("Pick the branch it is going to"); return; }
    const ok = await run(() => transferInventoryItem(moveDraft.item.id, {
      qty,
      to_branch_id: moveDraft.to_branch_id,
      note: moveDraft.note.trim(),
    }, scope), "Stock moved");
    if (ok) setMoveDraft(null);
  };

  const newItem = () => setItemDraft({
    id: null, name: "", brand: "", unit: CAT.defaultUnit,
    sale_price: "", cost_price: "", low_stock_at: CAT.low, notes: "",
  });

  const editItem = (it) => setItemDraft({
    id: it.id, name: it.name, brand: it.brand || "", unit: it.unit || CAT.defaultUnit,
    sale_price: it.sale_price ?? "", cost_price: it.cost_price ?? "",
    low_stock_at: it.low_stock_at ?? CAT.low, notes: it.notes || "",
  });

  const sellTotal = sellDraft
    ? (Number(sellDraft.qty) || 0) * (sellDraft.unit_price === "" ? Number(sellDraft.item.sale_price) || 0 : Number(sellDraft.unit_price) || 0)
    : 0;

  const empty = loading || visible.length === 0;

  // The same three actions on a table row and on a phone card. Holds no state of its own,
  // so being re-created each render costs nothing and keeps the two lists in step by
  // construction rather than by remembering to edit both.
  const RowActions = ({ item }) => (
    <>
      <Button
        size="sm" variant="outline" className="h-8 border-sky-200 text-sky-700 hover:bg-sky-50"
        onClick={() => setAddDraft({ item, qty: "", cost_price: "", vendor_id: "", supplier: "", note: "" })}
        data-testid={tid(`add-stock-${item.id}`)}
      >
        <PackagePlus className="mr-1 h-3.5 w-3.5" /> Add
      </Button>
      <Button
        size="sm" variant="outline" className="h-8 border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
        disabled={item.stock <= 0}
        onClick={() => setSellDraft({ item, qty: 1, unit_price: item.sale_price ?? "", customer_name: "", payment_mode: "cash", note: "" })}
        data-testid={tid(`sell-${item.id}`)}
      >
        <ShoppingCart className="mr-1 h-3.5 w-3.5" /> Sell
      </Button>
      <Button
        size="sm" variant="outline" className="h-8 border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-40"
        disabled={item.stock <= 0}
        onClick={() => setMoveDraft({ item, qty: 1, to_branch_id: "", note: "" })}
        data-testid={tid(`move-${item.id}`)}
      >
        <ArrowRightLeft className="mr-1 h-3.5 w-3.5" /> Move
      </Button>
      <button
        onClick={() => editItem(item)}
        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-violet-600"
        title="Edit" data-testid={tid(`edit-${item.id}`)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => removeItem(item)}
        className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
        title="Delete" data-testid={tid(`delete-${item.id}`)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <div className="space-y-4" data-testid={tid("inventory-panel")}>
      {/* `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness, Patients and Review strips. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={CAT.plural} value={summary?.items ?? "—"} sub="in the catalogue" arrow color="#7c3aed" />
        <StatTile label="In Stock" value={summary?.units ?? "—"} sub={`worth ${fmt(summary?.stock_value)}`} arrow color="#0284c7" />
        <StatTile label="Low Stock" value={summary?.low_stock ?? "—"} sub={`${summary?.out_of_stock ?? 0} fully out`} arrow color="#d97706" />
        <StatTile label="Sold Today" value={fmt(summary?.sold_today_amount)} sub={`${summary?.sold_today_qty ?? 0} units`} arrow color="#059669" />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={CAT.searchHint}
              className={`${inputCls} pl-9`}
              data-testid={tid("inventory-search")}
            />
          </div>
          <Button onClick={newItem} className="bg-violet-600 text-white hover:bg-violet-700" data-testid={tid("inventory-new")}>
            <Plus className="mr-1.5 h-4 w-4" /> New {CAT.noun}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden" data-testid={tid("inventory-table-card")}>
        <CardContent className="p-0">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{CAT.noun} Stock</p>
          </div>

          {empty ? (
            <p className="px-4 py-14 text-center text-sm text-slate-400" data-testid={tid("inventory-empty")}>
              {loading ? "Loading stock..."
                : items.length === 0 ? CAT.empty
                  : "Nothing matches that search."}
            </p>
          ) : (
            <>
              {/* A phone gets cards. The desktop table is 720px before it is readable, and
                  a row whose whole point is three buttons is the worst thing to make
                  someone find by scrolling sideways. */}
              <div className="space-y-2 p-3 sm:hidden" data-testid={tid("list-mobile")}>
                {visible.map((it, i) => (
                  <div key={it.id} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={tid(`card-${it.id}`)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {/* The same number the table shows, so a count read off a phone
                            and one read off the desk agree. */}
                        <p className="truncate text-sm font-bold text-slate-800">
                          <span className="mr-1.5 font-semibold text-slate-300">{i + 1}.</span>{it.name}
                        </p>
                        <p className="truncate text-xs text-slate-500">{it.brand || "No brand"}</p>
                      </div>
                      <StockBadge qty={it.stock} low={it.low} />
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">{fmt(it.sale_price)} per {(it.unit || "unit").toLowerCase()}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <RowActions item={it} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto sm:block" data-testid={tid("list-desktop")}>
                {/* Widened with the S.No column rather than left alone: the actions were
                    already the tightest thing in the row. */}
                <table className="w-full min-w-[780px] text-sm">
                  <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="w-12 px-4 py-2.5 font-semibold">S.No</th>
                      <th className="px-4 py-2.5 font-semibold">{CAT.noun}</th>
                      <th className="px-4 py-2.5 font-semibold">Unit</th>
                      <th className="px-4 py-2.5 font-semibold">Price</th>
                      <th className="px-4 py-2.5 font-semibold">Stock</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visible.map((it, i) => (
                      <tr key={it.id} className="hover:bg-slate-50" data-testid={tid(`row-${it.id}`)}>
                        {/* Numbers the rows on screen, not the catalogue: filter or search
                            and it counts what is left, the way the collections tables do.
                            It is a position in a list, never an id — the item's own id is
                            what every action here is sent against. */}
                        <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">{it.name}</p>
                          <p className="text-[11px] text-slate-400">{it.brand || "—"}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {it.unit}
                          <span className="block text-[11px] text-slate-400">low at {it.low_stock_at ?? 0}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {fmt(it.sale_price)}
                          <span className="block text-[11px] text-slate-400">cost {fmt(it.cost_price)}</span>
                        </td>
                        <td className="px-4 py-3"><StockBadge qty={it.stock} low={it.low} /></td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <RowActions item={it} />
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

      <Card className="overflow-hidden" data-testid={tid("inventory-movements")}>
        <CardContent className="p-0">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <History className="h-3.5 w-3.5" /> Stock Movements
            </p>
          </div>
          {movements.length === 0 ? (
            <p className="px-4 py-14 text-center text-sm text-slate-400">Nothing has moved yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">{CAT.noun}</th>
                    <th className="px-4 py-2.5 font-semibold">What</th>
                    <th className="px-4 py-2.5 font-semibold">Qty</th>
                    <th className="px-4 py-2.5 font-semibold">Amount</th>
                    <th className="px-4 py-2.5 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movements.map((m) => {
                    const meta = MOVEMENT_META[m.kind] || { label: m.kind, classes: "border-slate-200 bg-slate-50 text-slate-600", sign: "" };
                    const detail = m.kind === "sale" ? (m.customer_name || "Counter sale")
                      : m.kind === "add" ? (m.supplier || "Stock in")
                        : m.kind === "transfer_out" ? `to ${m.to_branch_name || "another branch"}`
                          : `from ${m.from_branch_name || "another branch"}`;
                    return (
                      <tr key={m.id} className="hover:bg-slate-50" data-testid={tid(`movement-${m.id}`)}>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-500">{when(m.created_at)}</td>
                        <td className="px-4 py-3 font-medium text-slate-800">{m.item_name}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex shrink-0 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${meta.classes}`}>{meta.label}</span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-700">{meta.sign}{m.qty}</td>
                        <td className="px-4 py-3 text-slate-600">{m.kind === "sale" ? fmt(m.amount) : "—"}</td>
                        <td className="px-4 py-3 text-slate-500">
                          {detail}
                          {m.by_user_name && <span className="text-[11px] text-slate-400"> · {m.by_user_name}</span>}
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

      {itemDraft && (
        <Modal
          title={itemDraft.id ? `Edit ${CAT.noun}` : `New ${CAT.noun}`}
          subtitle="Shared across branches — each branch keeps its own count"
          onClose={() => setItemDraft(null)}
          testid={tid("item-modal")}
          footer={<>
            <Button variant="outline" onClick={() => setItemDraft(null)} data-testid={tid("item-cancel")}>Cancel</Button>
            <Button className="bg-violet-600 text-white hover:bg-violet-700" disabled={busy} onClick={saveItem} data-testid={tid("item-save")}>
              {itemDraft.id ? "Save Changes" : `Add ${CAT.noun}`}
            </Button>
          </>}
        >
          <Field label="Name *">
            <input className={inputCls} value={itemDraft.name} onChange={(e) => setItemDraft({ ...itemDraft, name: e.target.value })} placeholder={CAT.namePlaceholder} data-testid={tid("item-name")} />
          </Field>
          <Field label="Brand">
            <input className={inputCls} value={itemDraft.brand} onChange={(e) => setItemDraft({ ...itemDraft, brand: e.target.value })} placeholder={CAT.brandPlaceholder} data-testid={tid("item-brand")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sold As">
              {/* The stored unit is kept as an option even when this shelf no longer
                  offers it. The backend's list is wider than any one panel's, so an item
                  saved as something not on this list would otherwise open on a blank
                  dropdown and read as though its unit had been lost. */}
              <select className={inputCls} value={itemDraft.unit} onChange={(e) => setItemDraft({ ...itemDraft, unit: e.target.value })} data-testid={tid("item-unit")}>
                {[...new Set([...CAT.units, itemDraft.unit].filter(Boolean))].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Low Stock At" hint="Flagged at or below this">
              <input type="number" min="0" className={inputCls} value={itemDraft.low_stock_at} onChange={(e) => setItemDraft({ ...itemDraft, low_stock_at: e.target.value })} data-testid={tid("item-low")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sale Price">
              <input type="number" min="0" className={inputCls} value={itemDraft.sale_price} onChange={(e) => setItemDraft({ ...itemDraft, sale_price: e.target.value })} placeholder="0" data-testid={tid("item-sale-price")} />
            </Field>
            <Field label="Cost Price">
              <input type="number" min="0" className={inputCls} value={itemDraft.cost_price} onChange={(e) => setItemDraft({ ...itemDraft, cost_price: e.target.value })} placeholder="0" data-testid={tid("item-cost-price")} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={2} className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400" value={itemDraft.notes} onChange={(e) => setItemDraft({ ...itemDraft, notes: e.target.value })} placeholder="Storage, handling, anything worth remembering" data-testid={tid("item-notes")} />
          </Field>
        </Modal>
      )}

      {addDraft && (
        <Modal
          title="Add Stock"
          subtitle={`${addDraft.item.name} · ${addDraft.item.stock} in stock now`}
          accent="bg-sky-600"
          onClose={() => setAddDraft(null)}
          testid={tid("add-modal")}
          footer={<>
            <Button variant="outline" onClick={() => setAddDraft(null)} data-testid={tid("add-cancel")}>Cancel</Button>
            <Button className="bg-sky-600 text-white hover:bg-sky-700" disabled={busy} onClick={submitAdd} data-testid={tid("add-save")}>
              <PackagePlus className="mr-1.5 h-4 w-4" /> Add to Stock
            </Button>
          </>}
        >
          <Field label={`Quantity (${addDraft.item.unit}) *`}>
            <input type="number" min="1" className={inputCls} value={addDraft.qty} onChange={(e) => setAddDraft({ ...addDraft, qty: e.target.value })} placeholder="0" data-testid={tid("add-qty")} />
          </Field>
          <Field label="Cost Price" hint={`Leave blank to keep the price already on the ${CAT.noun.toLowerCase()}`}>
            <input type="number" min="0" className={inputCls} value={addDraft.cost_price} onChange={(e) => setAddDraft({ ...addDraft, cost_price: e.target.value })} placeholder={String(addDraft.item.cost_price ?? 0)} data-testid={tid("add-cost")} />
          </Field>
          {/* Who it came from, as a vendor if there is one and as free text otherwise.
              Picking a vendor is what ties the delivery to the Vendor tab — its spend, its
              supply list and its history all come off this one choice — so the typed box
              is only offered while nothing is picked, rather than sitting beside it
              collecting a second, unmatched spelling of the same supplier. */}
          <Field label="Vendor" hint={vendors.length === 0 ? "None on this shelf yet — add them under Services and Products > Vendor" : "Adds this item to that vendor's supply list"}>
            <select
              className={inputCls}
              value={addDraft.vendor_id}
              onChange={(e) => setAddDraft({ ...addDraft, vendor_id: e.target.value, supplier: "" })}
              data-testid={tid("add-vendor")}
            >
              <option value="">-- not from a listed vendor --</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          {!addDraft.vendor_id && (
            <Field label="Supplier">
              <input className={inputCls} value={addDraft.supplier} onChange={(e) => setAddDraft({ ...addDraft, supplier: e.target.value })} placeholder="Who it came from" data-testid={tid("add-supplier")} />
            </Field>
          )}
          <Field label="Note">
            <input className={inputCls} value={addDraft.note} onChange={(e) => setAddDraft({ ...addDraft, note: e.target.value })} placeholder="Invoice number, batch, anything" data-testid={tid("add-note")} />
          </Field>
        </Modal>
      )}

      {sellDraft && (
        <Modal
          title={`Sell ${CAT.noun}`}
          subtitle={`${sellDraft.item.name} · ${sellDraft.item.stock} in stock`}
          accent="bg-emerald-600"
          onClose={() => setSellDraft(null)}
          testid={tid("sell-modal")}
          footer={<>
            <Button variant="outline" onClick={() => setSellDraft(null)} data-testid={tid("sell-cancel")}>Cancel</Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy} onClick={submitSell} data-testid={tid("sell-save")}>
              <ShoppingCart className="mr-1.5 h-4 w-4" /> Record Sale
            </Button>
          </>}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Quantity (${sellDraft.item.unit}) *`}>
              <input type="number" min="1" max={sellDraft.item.stock} className={inputCls} value={sellDraft.qty} onChange={(e) => setSellDraft({ ...sellDraft, qty: e.target.value })} data-testid={tid("sell-qty")} />
            </Field>
            <Field label="Price Each">
              <input type="number" min="0" className={inputCls} value={sellDraft.unit_price} onChange={(e) => setSellDraft({ ...sellDraft, unit_price: e.target.value })} data-testid={tid("sell-price")} />
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">Total</span>
            <span className="text-lg font-extrabold text-emerald-700" data-testid={tid("sell-total")}>{fmt(sellTotal)}</span>
          </div>
          <Field label="Patient / Customer">
            <input className={inputCls} value={sellDraft.customer_name} onChange={(e) => setSellDraft({ ...sellDraft, customer_name: e.target.value })} placeholder="Who is buying it" data-testid={tid("sell-customer")} />
          </Field>
          <Field label="Payment Mode">
            <select className={inputCls} value={sellDraft.payment_mode} onChange={(e) => setSellDraft({ ...sellDraft, payment_mode: e.target.value })} data-testid={tid("sell-mode")}>
              {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Note">
            <input className={inputCls} value={sellDraft.note} onChange={(e) => setSellDraft({ ...sellDraft, note: e.target.value })} placeholder="Optional" data-testid={tid("sell-note")} />
          </Field>
        </Modal>
      )}

      {moveDraft && (
        <Modal
          title="Move to Another Branch"
          subtitle={`${moveDraft.item.name} · ${moveDraft.item.stock} in stock here`}
          accent="bg-amber-600"
          onClose={() => setMoveDraft(null)}
          testid={tid("move-modal")}
          footer={<>
            <Button variant="outline" onClick={() => setMoveDraft(null)} data-testid={tid("move-cancel")}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={submitMove} data-testid={tid("move-save")}>
              <ArrowRightLeft className="mr-1.5 h-4 w-4" /> Move Stock
            </Button>
          </>}
        >
          <Field label={`Quantity (${moveDraft.item.unit}) *`}>
            <input type="number" min="1" max={moveDraft.item.stock} className={inputCls} value={moveDraft.qty} onChange={(e) => setMoveDraft({ ...moveDraft, qty: e.target.value })} data-testid={tid("move-qty")} />
          </Field>
          <Field label="Move To *" hint="It lands in that branch's stock straight away">
            <select className={inputCls} value={moveDraft.to_branch_id} onChange={(e) => setMoveDraft({ ...moveDraft, to_branch_id: e.target.value })} data-testid={tid("move-branch")}>
              <option value="">-- choose a branch --</option>
              {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Note">
            <input className={inputCls} value={moveDraft.note} onChange={(e) => setMoveDraft({ ...moveDraft, note: e.target.value })} placeholder="Why it is moving" data-testid={tid("move-note")} />
          </Field>
        </Modal>
      )}
    </div>
  );
};

export default StoreInventoryPanel;
