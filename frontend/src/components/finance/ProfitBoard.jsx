import { useCallback, useEffect, useMemo, useState } from "react";
import { FinanceDateFilter } from "@/components/finance/FinanceDateFilter";
import { rangeFor, rangeIncomplete } from "@/lib/dateRange";
import { getBranches, getFinanceProfit } from "@/lib/api";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * Accountant > Profit — Revenue (every collection for the window, same figure
 * Accountant Manage's own Total Revenue tile shows) less Expense for the same window
 * and branch. Approval status plays no part: it's a review step, not a filter on what
 * counts as money in.
 *
 * `branchId`/`mode`/`scoped` are optional — see the same note on ExpenseBoard. Passed by
 * Super Admin's Finance screen, whose branch-pill row already picked a scope; left off,
 * this keeps picking its own on the Accountant's own dashboard.
 *
 * The window is the shared finance row — All through Custom Range — rather than the pair of
 * bare date fields this board used to carry. Two fields reading "Select date" say nothing
 * about what is in force and take four taps to say Today; the row says both.
 */
export const ProfitBoard = ({ branchId: branchIdProp, mode: modeProp, scoped = false } = {}) => {
  const controlled = scoped;
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState("");
  const [mode, setMode] = useState("all"); // "all" | "online" | "offline"
  const effectiveBranchId = controlled ? (branchIdProp || "") : branchId;
  const effectiveMode = controlled ? (modeProp || "all") : mode;
  // "all" is the resting state: this board opens on the whole book, and did before there
  // was a row to say so — two empty date fields were the same window with nothing lit.
  const [preset, setPreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState({ revenue: 0, expense: 0, profit: 0, expense_by_category: [] });
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (!controlled) getBranches().then(setBranches).catch(() => {}); }, [controlled]);

  const [startDate, endDate] = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const pickDates = (key, from, to) => { setPreset(key); setCustomFrom(from); setCustomTo(to); };

  const load = useCallback(async () => {
    // A half-typed custom range would ask for everything from one date to nothing, which
    // reads as a filter that stopped working. Waits for both ends.
    if (rangeIncomplete(preset, customFrom, customTo)) return;
    setLoading(true);
    try {
      const params = {};
      if (effectiveBranchId) params.branch_id = effectiveBranchId;
      if (effectiveMode !== "all") params.mode = effectiveMode;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      setData(await getFinanceProfit(params));
    } catch { /* silent */ }
    setLoading(false);
  }, [effectiveBranchId, effectiveMode, startDate, endDate, preset, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  const positive = (data.profit || 0) >= 0;

  return (
    <div className="space-y-4" data-testid="finance-profit-root">
      <div className="flex flex-wrap items-center gap-3">
        {/* Already picked by the branch-pill row above this board when embedded in
            Super Admin's Finance screen — see the same note on ExpenseBoard. */}
        {!controlled && [["all", "All"], ["offline", "Offline"], ["online", "Online"]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              mode === key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
            }`}
            data-testid={`finance-profit-mode-${key}`}
          >
            {label}
          </button>
        ))}
        {!controlled && (
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="h-10 rounded-md border border-slate-200 px-2 text-sm"
            data-testid="finance-profit-branch"
          >
            <option value="">All Branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
          </select>
        )}
        {/* The window governs all three cards below it, so it sits with the other things
            that scope them rather than under the figures it changes. */}
        <FinanceDateFilter
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          onChange={pickDates}
          testid="finance-profit-window"
        />
      </div>

      {/* Summary's ledger cards: tinted, 2px corners, no icons. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { key: "revenue", label: "Revenue", value: data.revenue, border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-700" },
          { key: "expense", label: "Expense", value: data.expense, border: "border-rose-200", bg: "bg-rose-50/60", text: "text-rose-700" },
          positive
            ? { key: "net", label: "Profit", value: data.profit, border: "border-sky-200", bg: "bg-sky-50/60", text: "text-sky-700" }
            : { key: "net", label: "Profit", value: data.profit, border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-700" },
        ].map((c) => (
          <div key={c.key} className={`rounded-[2px] border ${c.border} ${c.bg} p-4`} data-testid={`finance-profit-${c.key}-card`}>
            <p className={`text-[11px] font-bold uppercase tracking-wider ${c.text}`}>{c.label}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${c.text}`}>{fmt(c.value)}</p>
          </div>
        ))}
      </div>

      {data.expense_by_category.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow" data-testid="finance-profit-by-category">
          <div className="bg-slate-500 px-4 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white">Expense by Category</p>
          </div>
          <div className="divide-y divide-slate-100">
            {data.expense_by_category.map((c) => (
              <div key={c.category} className="flex items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-slate-50">
                <span className="text-slate-700">{c.category}</span>
                <span className="font-semibold text-rose-600">{fmt(c.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <p className="text-center text-xs text-slate-400">Loading...</p>}
    </div>
  );
};
