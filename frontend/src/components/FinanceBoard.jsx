import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeIndianRupee,
  CreditCard,
  FileText,
  Package,
  Search,
  TrendingUp,
  Users,
  Clock,
  CalendarDays,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { getBranchFinance } from "@/lib/api";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_COLORS, orderedPaymentModeEntries } from "@/lib/paymentModes";
import { displayPhone } from "@/lib/phone";

const FEE_FILTERS = [
  { key: "all", label: "All" },
  { key: "consultation", label: "Consultation" },
  { key: "package", label: "Package" },
];

export const FinanceBoard = ({ branchId, mode } = {}) => {
  const [data, setData] = useState({ summary: {}, transactions: [] });
  const [loading, setLoading] = useState(false);
  const [feeType, setFeeType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const loadFinance = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (feeType !== "all") params.fee_type = feeType;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      if (searchQuery.trim()) params.search = searchQuery.trim();
      if (branchId) params.branch_id = branchId;
      // "online" | "offline" — the Accountant's Summary tab own vertical filter, passed
      // straight through to the backend since a transaction carries no branch data of
      // its own to filter by client-side.
      if (mode) params.mode = mode;
      const result = await getBranchFinance(params);
      setData(result);
    } catch { /* silent */ }
    setLoading(false);
  }, [feeType, startDate, endDate, searchQuery, branchId, mode]);

  useEffect(() => { loadFinance(); }, [loadFinance]);

  const s = data.summary || {};
  const showBranchColumn = (s.by_branch || []).length > 1;

  const formatCurrency = (val) => {
    const num = Number(val) || 0;
    if (num >= 100000) return `${(num / 100000).toFixed(1)}L`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString("en-IN");
  };

  const formatDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    } catch { return iso.slice(0, 10); }
  };

  const formatTime = (iso) => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  };

  const SUMMARY_CARDS = [
    {
      label: "Total Revenue",
      value: s.total_revenue,
      prefix: "Rs.",
      icon: TrendingUp,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      border: "border-emerald-200",
    },
    {
      label: "Consultation Fees",
      value: s.consultation_total,
      prefix: "Rs.",
      sub: `${s.consultation_count || 0} patients`,
      icon: FileText,
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-200",
    },
    {
      label: "Package Payments",
      value: s.package_total,
      prefix: "Rs.",
      sub: `${s.package_count || 0} packages`,
      icon: Package,
      color: "text-violet-600",
      bg: "bg-violet-50",
      border: "border-violet-200",
    },
    {
      label: "Pending Collection",
      value: s.pending_count,
      icon: Clock,
      sub: "awaiting payment",
      color: "text-amber-600",
      bg: "bg-amber-50",
      border: "border-amber-200",
    },
  ];

  return (
    <div className="space-y-5" data-testid="finance-board-root">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="finance-summary-cards">
        {SUMMARY_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className={`rounded-xl border ${card.border} ${card.bg} p-4`}
              data-testid={`finance-card-${card.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <div className="flex items-start justify-between mb-2">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{card.label}</p>
                <div className={`rounded-lg p-1.5 ${card.bg}`}>
                  <Icon className={`h-4 w-4 ${card.color}`} />
                </div>
              </div>
              <p className={`text-2xl font-bold ${card.color}`}>
                {card.prefix || ""}{formatCurrency(card.value)}
              </p>
              {card.sub && <p className="text-[10px] text-slate-400 mt-0.5">{card.sub}</p>}
            </div>
          );
        })}
      </div>

      {/* Income by Payment Mode — Cash, Cheque, Bank and UPI always shown, in that
          order, so the row reads the same whichever of the four the branch actually
          took; Card and Other join only when they carry money. Same tile shape and
          same four-first order as the Expense tab, so the two sides of the same
          collection read as one system rather than two boards that happened to agree. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="finance-payment-modes">
        {orderedPaymentModeEntries(s.payment_modes).map(([pm, amt]) => {
          const c = PAYMENT_MODE_COLORS[pm] || PAYMENT_MODE_COLORS.unknown;
          return (
            <div
              key={pm}
              className={`rounded-xl border ${c.border} ${c.bg} p-4`}
              data-testid={`finance-payment-mode-${pm}`}
            >
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{PAYMENT_MODE_LABELS[pm]}</p>
              <p className={`mt-1 text-xl font-bold ${c.text}`}>Rs.{formatCurrency(amt)}</p>
            </div>
          );
        })}
      </div>

      {/* Revenue by Branch — only meaningful when viewing more than one branch at once */}
      {(s.by_branch || []).length > 1 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="finance-by-branch-table">
          <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Revenue by Branch</p>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Branch</th>
                <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">Consultation</th>
                <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">Package</th>
                <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total</th>
                <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">Patients</th>
              </tr>
            </thead>
            <tbody>
              {s.by_branch.map((b) => (
                <tr key={b.branch_id} className="border-b border-slate-50 last:border-0" data-testid={`finance-by-branch-row-${b.branch_id}`}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{b.branch_name || "Unknown"}</td>
                  <td className="px-4 py-2.5 text-right text-slate-600">Rs.{(b.consultation_total || 0).toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right text-slate-600">Rs.{(b.package_total || 0).toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">Rs.{(b.total_revenue || 0).toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{b.total_patients || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex items-center gap-3 flex-wrap" data-testid="finance-filters">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
          {FEE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFeeType(f.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                feeType === f.key
                  ? "bg-sky-500 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50"
              }`}
              data-testid={`finance-filter-${f.key}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <Input
            placeholder="Search patient..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs border-slate-200"
            data-testid="finance-search"
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <CalendarDays className="h-3.5 w-3.5" />
          <MilkDateInput
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-8 rounded-md border border-slate-200 px-2 text-xs"
            data-testid="finance-start-date"
          />
          <span>to</span>
          <MilkDateInput
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="h-8 rounded-md border border-slate-200 px-2 text-xs"
            data-testid="finance-end-date"
          />
        </div>
      </div>

      {/* Transactions Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="finance-transactions-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80">
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Patient</th>
                {showBranchColumn && <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Branch</th>}
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Type</th>
                <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">Amount</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Details</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Collected By</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Date</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Stage</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.length === 0 ? (
                <tr>
                  <td colSpan={showBranchColumn ? 8 : 7} className="px-4 py-12 text-center">
                    <BadgeIndianRupee className="h-8 w-8 text-slate-200 mx-auto mb-2" />
                    <p className="text-xs text-slate-400">
                      {loading ? "Loading transactions..." : "No transactions found"}
                    </p>
                  </td>
                </tr>
              ) : (
                data.transactions.map((tx, i) => (
                  <tr
                    key={tx.id || i}
                    className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors"
                    data-testid={`finance-tx-row-${i}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                          {tx.patient_name?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-800">{tx.patient_name}</p>
                          <p className="text-[10px] text-slate-400">{displayPhone(tx.patient_phone)}</p>
                        </div>
                      </div>
                    </td>
                    {showBranchColumn && (
                      <td className="px-4 py-3 text-xs text-slate-600">{tx.branch_name || "—"}</td>
                    )}
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          tx.fee_type === "package"
                            ? "bg-violet-100 text-violet-700"
                            : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {tx.fee_type === "package" ? (
                          <><Package className="h-3 w-3" /> Package</>
                        ) : (
                          <><CreditCard className="h-3 w-3" /> Consultation</>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className="text-sm font-bold text-slate-800">Rs.{(tx.amount || 0).toLocaleString("en-IN")}</p>
                    </td>
                    <td className="px-4 py-3">
                      {tx.package_weeks ? (
                        <span className="text-xs text-violet-600">{tx.package_weeks} weeks</span>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-xs text-slate-600">{tx.collected_by || "—"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-xs text-slate-600">{formatDate(tx.collected_at)}</p>
                      <p className="text-[10px] text-slate-400">{formatTime(tx.collected_at)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        {tx.branch_stage || "—"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.transactions.length > 0 && (
          <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 flex items-center justify-between">
            <p className="text-[11px] text-slate-400">
              {data.transactions.length} transaction{data.transactions.length !== 1 ? "s" : ""}
            </p>
            <p className="text-[11px] font-semibold text-slate-600">
              Total: Rs.{data.transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0).toLocaleString("en-IN")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
