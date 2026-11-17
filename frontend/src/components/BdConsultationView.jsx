import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Download,
  FileSpreadsheet,
  RefreshCw,
  Search,
  Star,
  UserPlus,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemedSelect } from "@/components/ui/themed-select";
import { StageTabBar } from "@/components/ui/stage-tab";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters, quickDatePreset } from "@/components/QuickDateFilterBar";
import { ConsultationsBoard } from "@/components/ConsultationsBoard";
import { downloadListReportPdf, downloadListWorkbookXlsx } from "@/components/branch/leadsReport";
import { stagesList } from "@/lib/api";
import { callTimeStamp, dateStampFull } from "@/lib/time";

// The card the view sits on when nothing else is picked, as Branch Admin's Consultation tab
// has it: a card stays lit, and clicking the lit one goes back here.
const DEFAULT_STAGE = "Consultation Visit";
// Branch Admin's own range row: Tomorrow on, Last 90 Days off.
const OMITTED_RANGES = ["last_90"];
const SORT_OPTIONS = [
  { value: "newest", label: "New to First" },
  { value: "oldest", label: "Old to First" },
];
const ALL_BRANCHES = "All Branches";

/**
 * The Business Development Executive's Consultation View: every branch's Consultation tab
 * at once -- the same stage cards and the same ConsultationsBoard Branch Admin works, read
 * across all branches (branch_id "all").
 *
 * @param onAddPatient opens the host's Add Lead form
 * @param reloadToken  bumped by the host after a lead is added
 */
export const BdConsultationView = ({ onAddPatient, reloadToken = 0 }) => {
  const [stages, setStages] = useState([]);
  const [stageFilter, setStageFilter] = useState(null);
  const [search, setSearch] = useState("");
  const [quickDate, setQuickDate] = useState(() => quickDatePreset("today"));
  const [dateFilter, setDateFilter] = useState(null);
  const [sortOrder, setSortOrder] = useState("newest");
  const [markFilter, setMarkFilter] = useState("");
  const [counts, setCounts] = useState({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef(null);

  useEffect(() => {
    stagesList("consultation").then((rows) => setStages(rows || [])).catch(() => setStages([]));
  }, []);

  const defaultStage = useMemo(() => (
    (stages.find((s) => s.name === DEFAULT_STAGE) || stages[0])?.name || null
  ), [stages]);

  // A card is always lit: on arrival, and again when the lit one is clicked off.
  useEffect(() => {
    if (!stageFilter && defaultStage) setStageFilter(defaultStage);
  }, [stageFilter, defaultStage]);
  const selectStage = useCallback((next) => setStageFilter(next || defaultStage), [defaultStage]);

  const effectiveDateFilter = useMemo(() => intersectDateFilters(dateFilter, quickDate), [dateFilter, quickDate]);

  // The board counts its own rows per stage, after the toolbar's narrowing, so a card's
  // number is the list it opens. Replaced only on a real change.
  const handleCounts = useCallback((_total, next) => {
    setCounts((prev) => {
      const keys = Object.keys(next);
      const same = keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, []);

  const refresh = () => {
    setRefreshTick((n) => n + 1);
    stagesList("consultation").then((rows) => setStages(rows || [])).catch(() => {});
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  };

  const toggleMark = (mark) => setMarkFilter((m) => (m === mark ? "" : mark));

  // Download (PDF, the open card's list) and Export Excel (a sheet per card), each as the
  // table shows it -- the board builds the rows (see its exportRef).
  const exportList = async (kind) => {
    const build = exportRef.current;
    const data = build?.();
    if (!data) { toast.error("The list is still loading — try again in a moment"); return; }
    const f = effectiveDateFilter;
    const dates = !f?.from && !f?.to ? "All dates"
      : !f.to ? `From ${dateStampFull(f.from)}`
      : !f.from ? `Up to ${dateStampFull(f.to)}`
      : dateStampFull(f.from) === dateStampFull(f.to) ? dateStampFull(f.from)
      : `${dateStampFull(f.from)} – ${dateStampFull(f.to)}`;
    const period = f?.label && f.key && !String(f.key).includes("+") ? `${f.label} (${dates})` : dates;
    const marks = markFilter === "vip" ? "Starred only" : markFilter === "attention" ? "Alert only" : "";
    const searched = search.trim() ? `Search "${search.trim()}"` : "";
    const showing = (n, extra) => {
      const count = `${n} patient${n === 1 ? "" : "s"}`;
      const narrowed = [extra, searched, marks].filter(Boolean).join(" · ");
      return narrowed ? `${count} · ${narrowed}` : count;
    };
    const now = new Date();
    const generated = `${dateStampFull(now)}, ${callTimeStamp(now)}`;
    const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const asList = (d) => ({
      title: "CONSULTATION REPORT",
      sheetTitle: `FITSIOMAX — Consultation — ${d.stage}`,
      sheetName: d.stage,
      branch: ALL_BRANCHES,
      generated,
      meta: [["Branch", ALL_BRANCHES], ["Stage", d.stage], ["Period", period], ["Showing", showing(d.rows.length, d.feeView)]],
      strip: [ALL_BRANCHES, d.stage, period],
      listLabel: `${d.stage} — Patient List`,
      empty: "No patients in this stage for the selected period.",
      columns: d.columns,
      rows: d.rows,
    });
    setExporting(true);
    try {
      if (kind === "pdf") {
        await downloadListReportPdf(asList(data), ["consultation", "all-branches", slug(data.stage), slug(dates)].filter(Boolean).join("-") + ".pdf");
      } else {
        downloadListWorkbookXlsx(
          stages.map((st) => asList(build(st.name))),
          ["consultation-all-stages", "all-branches", slug(dates)].filter(Boolean).join("-") + ".xlsx",
        );
      }
    } catch {
      toast.error("Couldn't build the file");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="bd-consultation-view">
      <StageTabBar
        stages={stages}
        stageFilter={stageFilter}
        setStageFilter={selectStage}
        counts={counts}
        hideAllStages
        plain
        testid="bd-consult-stage"
      />

      <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1 [scrollbar-width:none] sm:flex-wrap sm:gap-2 sm:overflow-visible [&::-webkit-scrollbar]:hidden" data-testid="bd-consult-tools">
        <div className="relative min-w-[8rem] flex-1 sm:min-w-[180px] sm:max-w-[260px]">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            className="h-10 pl-9"
            placeholder="Search patients in Consultations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="bd-consult-search"
          />
        </div>

        <div className="hidden shrink-0 sm:block">
          <QuickDateFilterBar
            value={quickDate}
            onChange={setQuickDate}
            testid="bd-consult-quick-date"
            inline
            showCustom={false}
            showTomorrow
            omit={OMITTED_RANGES}
          />
        </div>

        <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-1.5">
          {/* Phone: the order as one arrow that flips it; the dropdown from sm up. */}
          <button
            type="button"
            onClick={() => setSortOrder(sortOrder === "newest" ? "oldest" : "newest")}
            title={sortOrder === "newest" ? "New to First — tap for Old to First" : "Old to First — tap for New to First"}
            aria-label={sortOrder === "newest" ? "Sort: New to First" : "Sort: Old to First"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 sm:hidden"
            data-testid="bd-consult-sort-toggle"
          >
            {sortOrder === "newest" ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
          </button>
          <div className="hidden sm:block">
            <ThemedSelect
              value={sortOrder}
              onChange={setSortOrder}
              options={SORT_OPTIONS}
              title="Order the list by date"
              className="h-10 w-[124px] px-2.5 text-xs font-medium text-slate-600"
              testid="bd-consult-sort"
            />
          </div>

          <button
            type="button"
            onClick={() => toggleMark("vip")}
            title={markFilter === "vip" ? "Showing starred patients only — click to show all" : "Show starred patients only"}
            aria-label="Show starred patients only"
            aria-pressed={markFilter === "vip"}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
              markFilter === "vip" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white hover:bg-amber-50"
            }`}
            data-testid="bd-consult-filter-vip"
          >
            <Star className={`h-4 w-4 ${markFilter === "vip" ? "fill-amber-400 text-amber-500" : "text-slate-400"}`} />
          </button>
          <button
            type="button"
            onClick={() => toggleMark("attention")}
            title={markFilter === "attention" ? "Showing alert patients only — click to show all" : "Show alert patients only"}
            aria-label="Show alert patients only"
            aria-pressed={markFilter === "attention"}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
              markFilter === "attention" ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white hover:bg-rose-50"
            }`}
            data-testid="bd-consult-filter-attention"
          >
            <AlertCircle className={`h-4 w-4 ${markFilter === "attention" ? "fill-rose-500 text-white" : "text-slate-400"}`} />
          </button>

          <DateFilterPopover
            value={dateFilter}
            onChange={setDateFilter}
            testid="bd-consult-date-filter"
            centered
            iconOnly
            phoneIconOnly
          />

          <Button
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="bd-consult-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>

          <Button
            onClick={onAddPatient}
            title="Add Patient"
            aria-label="Add Patient"
            className="h-10 w-10 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700"
            data-testid="bd-consult-add-patient"
          >
            <UserPlus className="h-4 w-4" />
          </Button>

          <Button
            onClick={() => exportList("pdf")}
            disabled={exporting}
            title="Download — this stage as PDF"
            aria-label="Download"
            className="h-10 w-10 shrink-0 bg-indigo-600 p-0 text-white hover:bg-indigo-700"
            data-testid="bd-consult-download"
          >
            {exporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </Button>

          <Button
            onClick={() => exportList("xlsx")}
            disabled={exporting}
            title="Export Excel — a sheet for every stage"
            aria-label="Export Excel"
            className="h-10 w-10 shrink-0 bg-emerald-600 p-0 text-white hover:bg-emerald-700"
            data-testid="bd-consult-export-excel"
          >
            <FileSpreadsheet className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* The ranges' phone line: the row above has no room for six of them. */}
      <div className="sm:hidden">
        <QuickDateFilterBar
          value={quickDate}
          onChange={setQuickDate}
          testid="bd-consult-quick-date-phone"
          showCustom={false}
          showTomorrow
          omit={OMITTED_RANGES}
        />
      </div>

      {/* Branch Admin's Consultation tab, every branch at once. */}
      <ConsultationsBoard
        branchId="all"
        viewerRole="branch_admin"
        homeVisitScope="exclude"
        externalStageFilter={stageFilter}
        showOwnStageBar={false}
        compactTable
        consultantBranchColumn
        onCountChange={handleCounts}
        externalSearch={search}
        externalDateFilter={effectiveDateFilter}
        dateScope="activity"
        externalMarkFilter={markFilter}
        externalSortOrder={sortOrder}
        exportRef={exportRef}
        reloadToken={refreshTick + reloadToken}
        mobileCards
      />
    </div>
  );
};

export default BdConsultationView;
