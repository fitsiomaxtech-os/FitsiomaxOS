import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  BadgeIndianRupee,
  BarChart3,
  Building2,
  ChevronRight,
  Headphones,
  LayoutDashboard,
  Megaphone,
  RefreshCw,
  Search,
  Settings,
  Star,
  Store,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import {
  getBdSummary,
  getBdSummaryRows,
  getBranches,
  stagesList,
  updateLead,
} from "@/lib/api";
import { CreateLeadModal } from "@/components/CreateLeadModal";
// The toolbar controls, every one of them the same instance another board already uses --
// the five one-tap ranges and the calendar behind them, the green sheet pull, and the
// branch-to-branch move. Nothing here is a second copy cut to this board's shape: a range
// means on this dashboard exactly what it means on a branch's own list, which is the only
// reason a desk that reads both can trust either.
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters } from "@/components/QuickDateFilterBar";
import { PullFromSheetButton } from "@/components/PullFromSheetButton";
import { BranchTransferDialog } from "@/components/branch/BranchTransferDialog";
// The Marketing and Sales master views and the Branch Control panel, mounted as three
// tabs below. Imported statically, the way OperationsBoard already mounts these same two
// boards: this file is itself behind a lazy() in CRMPage, so webpack lifts what the
// chunks share rather than copying either board into each.
// LeadDetailDialog is Sales View's own lead popup, opened here from a row in a card's list
// so a lead reads and moves the same way from either place.
import { LeadDetailDialog, PreSalesCRM } from "@/components/PreSalesCRM";
import { BranchManagementBoard } from "@/components/branch/BranchManagementBoard";
// Super Admin's own six Dashboard tabs -- Marketing, Sales, Revenue, Team, Clients and
// Analytics -- and the hook that fetches what they read. Mounted on this desk's own
// Dashboard beside Summary; see DASH_SUB_TABS below.
//
// Static, unlike the six lazy() boards under it, and for the opposite reason: those are
// other tabs on the nav above, and this one IS the Dashboard tab -- the tab this board
// opens on. A lazy() could not carry useDashboardData in any case; a hook has to be
// there when the component that calls it renders.
import { DASH_TABS, DashboardTabPanel, ModeBranchScope, useDashboardData } from "@/components/DashboardBoard";
// This desk's own Marketing tab -- every lead source in the range as a row, with the leads
// behind any one of them a click away, in place of the row of per-channel totals
// DashboardTabPanel draws for that key. Only this board swaps it; Super Admin's Dashboard
// > Marketing is untouched and still gets the tiles. See the note at the render below, and
// the file's own header for why the desk wants a table rather than tiles.
import { BREAKDOWN_MODES, BdMarketingSources } from "@/components/BdMarketingSources";
// Finance, HR Admin, Services and Products, and the two Settings screens -- the same five
// boards Super Admin reaches, mounted here as this desk's own tabs.
//
// lazy() rather than the static imports above, and deliberately not the same call: these
// five are the same lazy() targets CRMPage already names, so webpack hands both pages the
// one chunk per board and neither pays for the other's copy. Static would have pulled the
// whole HR org chart and the whole catalogue into the chunk that draws this board's
// Dashboard, which is the tab it opens on and the only one most days need.
const FinanceWiseBoard = lazy(() => import("@/components/branch/FinanceWiseBoard").then((m) => ({ default: m.FinanceWiseBoard })));
const HRBoard = lazy(() => import("@/components/hr/HRBoard").then((m) => ({ default: m.HRBoard })));
const PackagesBoard = lazy(() => import("@/components/PackagesBoard").then((m) => ({ default: m.PackagesBoard })));
const MarketingBoard = lazy(() => import("@/components/marketing/MarketingBoard").then((m) => ({ default: m.MarketingBoard })));
const PipelineStageManagement = lazy(() => import("@/components/PipelineStageManagement").then((m) => ({ default: m.PipelineStageManagement })));

/**
 * What sits under the tab strip while one of those chunks is on the wire.
 *
 * The same quiet spinner CRMPage puts under its own nav, and placed the same way: below
 * the strip, not around it, so the tabs stay on screen and switching boards reads as the
 * board loading rather than the page going away.
 */
const BoardFallback = () => (
  <div className="flex items-center justify-center py-20" data-testid="bd-board-loading">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-sky-600" />
  </div>
);

// Operations is not on this strip. It stays Super Admin's own board; this desk's day is
// read on Dashboard and worked through the views below.
//
// Marketing View and Sales View are the same two boards Super Admin reaches as
// "Marketing Master View" and "Sales Master View" -- the same PreSalesCRM mount, under the
// shorter names, because here they are two tabs on a strip and not two entries on a
// top-level nav. They sit after Dashboard, before the money: the desk reads the day, then
// reads what the other two desks did with it.
//
// Branch Control is BranchManagementBoard in full -- the same panel Super Admin's
// Operations opens as a "Branch Manager" dialog, mounted as a tab instead of a popup so it has the room its
// four sub-tabs need. It replaced a "Branches" tab that held a create form and a card
// list, both of which that panel does better.
//
// Lead Master is gone. It was a second leads table on a board whose Dashboard cards now
// open the same rows, and whose Sales View works them properly.
//
// Finance, HR Admin and Services and Products are Super Admin's own three boards, mounted
// unchanged and with nothing held back -- not a reduced copy cut to this desk's shape, for
// the same reason Marketing View and Sales View are not: a figure means here what it means
// on the board that owns it, which is the only reason a desk reading both can trust either.
//
// They sit between Sales View and Branch Control because that is the order the day runs
// in: what the two lead desks did, then the money, the people and the catalogue behind it,
// then the branches those land in. Branch Control stays last of the boards because it is
// the one that acts on a branch rather than reads across all of them.
const TABS = [
  { key: "dashboard", label: "Dashboard", icon: BarChart3 },
  { key: "marketing_view", label: "Marketing View", icon: Megaphone },
  { key: "sales_view", label: "Sales View", icon: Headphones },
  { key: "finance", label: "Finance", icon: BadgeIndianRupee },
  { key: "hr", label: "HR Admin", icon: Users },
  // Treatments and Physiotherapy Treatment are sub-tabs inside it, not peers of it --
  // the same shape Super Admin's own copy has.
  { key: "packages", label: "Services and Products", icon: Store },
  { key: "branch_control", label: "Branch Control", icon: LayoutDashboard },
  { key: "settings", label: "Settings", icon: Settings },
];

// Settings is a second name for this pair of views rather than a view of its own -- the
// same shape CRMPage's own SETTINGS_SUB_VIEWS uses for Super Admin. `activeTab` holds one
// of these directly when Settings is open, so nothing has to track both a tab and a
// sub-tab and keep the two agreeing.
//
// Marketing Source and CI/CD ROOTS, from Super Admin's own Settings, which holds exactly
// that pair. Both are configuration rather than work, so this desk's Settings is the one
// place its configuration lives. The keys match CRMPage's SETTINGS_SUB_VIEWS
// ("marketing"/"stages") so the two boards name the same screens the same way.
//
// Google Sheet Connection and Lead Source sat here too and are gone. Neither was a place
// this desk works, and neither was the only copy: Marketing Source -> Lead Sources already
// connects a sheet -- through Google's own consent screen rather than a pasted spreadsheet
// ID -- and already lists where leads came from, per branch. Keeping both would have left
// two ways to connect one sheet, and the older one could quietly disagree with the newer.
const SETTINGS_SUB_VIEWS = ["marketing", "stages"];
const SETTINGS_SUB_TABS = [
  { key: "marketing", label: "Marketing Source", icon: Megaphone },
  { key: "stages", label: "Workflow Roots", icon: Activity },
];
const isTabActive = (view, key) => (key === "settings" ? SETTINGS_SUB_VIEWS.includes(view) : view === key);

// Where the strip's own Refresh is not drawn -- see the note on the button itself. Dashboard
// because its toolbar carries the same one, and the three mounted boards because each
// carries its own and this one would not touch what they show.
const REFRESH_WITHHELD_TABS = ["dashboard", "finance", "hr", "packages"];

/**
 * The toolbar's date range as the two query params both BD endpoints already take.
 *
 * Spelled out to the microsecond rather than as a bare "2026-09-12", because
 * v3_dashboard.py compares these as plain strings against the ISO `created_at` on the
 * row: "2026-09-12" sorts BELOW "2026-09-12T08:31:00+00:00", so a bare upper bound would
 * return an empty list for the very day that was asked for.
 *
 * Local calendar days, not UTC ones -- the same reading `toIso` gives every other board
 * in here. A range therefore means the day the desk is having, which is not quite the day
 * the "Today's Leads" card counts (that one is UTC midnight, in the backend, deliberately
 * -- see the note on BD_ROWS_LIMIT). The two disagree for leads that arrive between
 * midnight and 5:30am IST, and fixing that belongs with the card's own definition rather
 * than here.
 */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const dateParamsOf = (filter) => {
  const out = {};
  if (!filter) return out;
  if (filter.from) out.start_date = `${ymd(filter.from)}T00:00:00`;
  if (filter.to) out.end_date = `${ymd(filter.to)}T23:59:59.999999`;
  return out;
};

/**
 * @param currentUser  the signed-in Business Development Executive. Read by the three
 *                     tabs that mount another desk's board -- Marketing View, Sales View
 *                     and Branch Control. PreSalesCRM schedules and stamps activity against
 *                     whoever is looking, and BranchManagementBoard's Branch Control
 *                     sub-tab acts as them; without this those tabs would be working on
 *                     behalf of nobody.
 */
// `tab` / `onTabChange` hand the tab to the host, whose phone bottom bar switches it; with
// them the strip's tab buttons stand down below md and only its actions stay.
export const BusinessLeadsDashboard = ({ currentUser = null, tab, onTabChange }) => {
  // Holds a main tab key, or -- while Settings is open -- one of SETTINGS_SUB_VIEWS.
  const [ownTab, setOwnTab] = useState("dashboard");
  const activeTab = tab ?? ownTab;
  const setActiveTab = onTabChange ?? setOwnTab;
  const phoneFooter = !!onTabChange;
  const [loading, setLoading] = useState(false);

  const [summary, setSummary] = useState(null);
  const [branches, setBranches] = useState([]);
  const [showCreateLead, setShowCreateLead] = useState(false);

  // Which summary card is open, and the rows behind it. One card at a time: these lists
  // answer "which ones are they" about a figure just clicked, and two of them open at
  // once would be a report rather than an answer.
  //
  // Today's Leads is open on arrival: it is the list this desk works first every morning.
  const [openMetric, setOpenMetric] = useState("today");
  const [drill, setDrill] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // Bumped by Refresh and by a finished sheet pull, to re-ask for the open list. The rows
  // are fetched by an effect below rather than by the click that opens them, so this is
  // how anything other than a click gets that effect to run again.
  const [drillTick, setDrillTick] = useState(0);

  // The toolbar's two date controls, kept up here rather than beside the row they sit in:
  // they re-scope the whole Dashboard tab, and both endpoints that fill it are loaded
  // from this component.
  //
  // Two independent controls over one axis, combined by their overlap rather than one
  // quietly winning -- the five one-tap ranges, and the calendar behind them carrying
  // Yesterday, Last Month, an exact day and a typed range. Same division of labour Branch
  // Admin's toolbar uses, and the same `intersectDateFilters` doing it, so both stay lit
  // saying which two ranges produced the figures on screen.
  const [quickDate, setQuickDate] = useState(null);
  const [dateFilter, setDateFilter] = useState(null);

  // Branch Transfer, from this desk's toolbar. Two steps, because this board is not
  // scoped to a branch the way the two boards that already open this dialog are: it has
  // to be told which branch the patient is leaving before the dialog has anything to
  // list. `swapPicking` is that question; `swapFromId` is the answer, and the dialog.
  const [swapPicking, setSwapPicking] = useState(false);
  const [swapFromId, setSwapFromId] = useState("");

  const effectiveDateFilter = useMemo(
    () => intersectDateFilters(dateFilter, quickDate),
    [dateFilter, quickDate],
  );
  // Memoised because it is a dependency of the two loaders below -- rebuilt every render
  // it would re-fetch the board on every render.
  const dateParams = useMemo(() => dateParamsOf(effectiveDateFilter), [effectiveDateFilter]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getBdSummary(dateParams);
      setSummary(data);
    } catch (e) { console.warn("[BD load failed]", e?.message || e); }
    setLoading(false);
  }, [dateParams]);

  const loadBranches = useCallback(async () => {
    try {
      const data = await getBranches();
      setBranches(data);
    } catch (e) { console.warn("[BD load failed]", e?.message || e); }
  }, []);

  // The rows behind a card. Asked for on the click rather than held for all nine: eight of
  // the nine are never opened in a given sitting, and Total Leads alone is thousands of
  // rows this board would otherwise fetch to show a number it already has.
  // The click now only says which card is open. Fetching moved to the effect under it,
  // because there are three other things that have to re-ask the same question -- a date
  // range being pressed, Refresh, and a sheet pull landing -- and a fetch living in the
  // click handler could be reached by none of them.
  const openCard = useCallback((metricKey) => {
    setOpenMetric((cur) => (cur === metricKey ? null : metricKey));
  }, []);

  useEffect(() => {
    if (!openMetric) { setDrill(null); setDrillLoading(false); return undefined; }
    // Guarded, because a date pressed twice quickly leaves two requests in flight and the
    // slower one must not land on top of the newer list.
    let cancelled = false;
    setDrill(null);
    setDrillLoading(true);
    getBdSummaryRows(openMetric, dateParams)
      .then((d) => { if (!cancelled) setDrill(d); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.response?.data?.detail || "Could not open that list");
        setOpenMetric(null);
      })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [openMetric, dateParams, drillTick]);

  useEffect(() => {
    loadDashboard();
    loadBranches();
  }, [loadDashboard, loadBranches]);

  // Everything this board holds, re-asked for. An open list goes with it -- via drillTick
  // and the effect above -- or a reload would leave the rows on screen older than the card
  // above them.
  //
  // Silent, so it can stand behind something that reports its own result: the sheet pull
  // already says how many leads it brought in, and following that with "Data refreshed"
  // would be the board congratulating itself for the second half of one action.
  const reloadAll = useCallback(async () => {
    await Promise.all([loadDashboard(), loadBranches()]);
    setDrillTick((n) => n + 1);
  }, [loadDashboard, loadBranches]);

  const refreshAll = useCallback(async () => {
    await reloadAll();
    toast.success("Data refreshed");
  }, [reloadAll]);

  // The lead a row in a card's list was clicked for, shown in Sales View's own popup. The
  // pre-sales stages it offers are fetched on the first click rather than on load: most
  // sittings never open one.
  const [openLead, setOpenLead] = useState(null);
  const [leadStages, setLeadStages] = useState([]);
  const openLeadDetail = useCallback((lead) => {
    setOpenLead(lead);
    if (!leadStages.length) {
      stagesList("pre_sales").then(setLeadStages).catch((e) => console.warn("[BD stages load failed]", e?.message || e));
    }
  }, [leadStages.length]);
  const moveLeadStage = useCallback(async (leadId, stageName) => {
    try {
      await updateLead(leadId, { stage: stageName });
      toast.success(`Moved to ${stageName}`);
      reloadAll();
    } catch (e) { toast.error(e?.response?.data?.detail || "Move failed"); }
  }, [reloadAll]);

  return (
    <div className="space-y-5" data-testid="bd-dashboard-root">
      {/* Top navigation, in Branch Admin's shape: underlines on a rule rather than filled
          pills in a floating white card. The pills read as five buttons to press; a desk
          this size wants a nav that says where it is and otherwise gets out of the way.

          Always on screen, unlike Branch Admin's own copy (`hidden md:flex`) -- that board
          has a fixed bottom nav for phones to fall back on and this one has none, so
          hiding the strip would leave a phone with no way between tabs. */}
      {/* Hidden on a phone's Dashboard when the bottom nav is on: its tabs are down there,
          and Add Lead and Refresh have moved into the Dashboard's own toolbar, so all that
          was left here was an empty rule and a gap above the tabs. */}
      <div className={`${phoneFooter && activeTab === "dashboard" ? "hidden sm:flex" : "flex"} items-center gap-1 overflow-x-auto border-b border-slate-200`} data-testid="bd-tab-bar">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = isTabActive(activeTab, tab.key);
          return (
            <button
              key={tab.key}
              type="button"
              // Settings has no view of its own -- it opens on the first of its two.
              onClick={() => setActiveTab(tab.key === "settings" ? SETTINGS_SUB_VIEWS[0] : tab.key)}
              className={`${phoneFooter ? "hidden md:flex" : "flex"} shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                isActive
                  ? "border-sky-500 text-sky-700"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
              data-testid={`bd-tab-${tab.key}`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
        <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 pb-1.5 pl-2">
          <Button size="sm" onClick={() => setShowCreateLead(true)} className={`bg-sky-600 hover:bg-sky-700 ${activeTab === "dashboard" ? "hidden sm:inline-flex" : ""}`} data-testid="bd-quick-add-lead-btn">
            <UserPlus className="mr-1 h-4 w-4" /> Add Lead
          </Button>
          {/* The same Refresh as Branch Admin > Branch Leads: grey, icon-only, square,
              with the word on title/aria-label.

              Withheld on the Dashboard tab, where the toolbar under this strip now carries
              it. The two are the same `refreshAll`, and two identical grey squares an inch
              apart on one screen is a reader asking which of them is the real one.

              Withheld on Finance, HR Admin and Services and Products for the
              same reason, one step further out: this button reloads THIS board's summary,
              branches and sheet connections, and on those three the screen under it is
              somebody else's board with its own reload. A refresh that visibly does nothing to what is on
              screen is worse than no refresh at all. It stays for the tabs that have
              neither their own toolbar nor a board of their own. */}
          {!REFRESH_WITHHELD_TABS.includes(activeTab) && (
            <Button
              onClick={refreshAll}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
              className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
              data-testid="bd-refresh-all-btn"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </div>

      {/* Dashboard Tab */}
      {activeTab === "dashboard" && (
        <DashboardTab
          summary={summary}
          loading={loading}
          branches={branches}
          openMetric={openMetric}
          onOpenCard={openCard}
          drill={drill}
          drillLoading={drillLoading}
          quickDate={quickDate}
          onQuickDate={setQuickDate}
          dateFilter={dateFilter}
          onDateFilter={setDateFilter}
          effectiveDateFilter={effectiveDateFilter}
          onRefresh={refreshAll}
          onPulled={reloadAll}
          onBranchSwap={() => setSwapPicking(true)}
          onAddLead={() => setShowCreateLead(true)}
          onOpenLead={openLeadDetail}
        />
      )}

      {/* Marketing View / Sales View — the same two PreSalesCRM mounts Super Admin gets.
          The role is hardcoded on each, not read from the signed-in user: the prop picks
          which board PreSalesCRM draws, and a Business Development Executive passing
          their own role would land on a rep's own filtered book rather than either
          master view. What they may actually read is settled by the API off their token,
          the same as it is for Super Admin's copy of these tabs.

          `embedded` because this board is the host: PreSalesCRM's own phone padding is
          for a fixed bottom nav, and there is none under this strip. */}
      {activeTab === "marketing_view" && (
        <PreSalesCRM role="marketing_head" currentUser={currentUser} embedded />
      )}

      {activeTab === "sales_view" && (
        <PreSalesCRM role="sales_head" currentUser={currentUser} embedded />
      )}

      {/* Finance, HR Admin and Services and Products — Super Admin's own three boards,
          each the same component that board mounts, with nothing held back and nothing
          passed to narrow them. What this desk may actually read and write is settled by
          the API off its token, the same as it is for Super Admin's copy: the guards in
          backend/routers/v3_finance.py, v3_hr.py, v3_hr_ops.py, v3_packages.py,
          v3_store.py and v3_inventory.py name business_dev beside super_admin now.

          Wrapped in one Suspense rather than three: only one of them is ever mounted, so a
          boundary each would be three copies of the same fallback waiting on the same
          switch. It sits inside the strip, not around it, so the tabs stay put while a
          chunk arrives. */}
      <Suspense fallback={<BoardFallback />}>
        {activeTab === "finance" && (
          <FinanceWiseBoard branches={branches} />
        )}

        {activeTab === "hr" && (
          <HRBoard />
        )}

        {activeTab === "packages" && (
          <PackagesBoard />
        )}
      </Suspense>

      {/* Branch Control — the Branch Manager panel in full, as a tab rather than the
          dialog Operations opens it in. No `lockTab`, which is the whole point of it being
          here: that flag drops the sub-tab row, and Overview, Analytics and Branch Control
          are exactly what this desk did not have before.

          It opens on MANAGER, the tab that lists the branches and creates them -- the
          thing the old Branches tab did, so the board opens where it used to.

          `detailReadOnly` is the one thing held back. Drilling into a branch reaches HR's
          account actions (activate, deactivate, permanently delete a user) and the
          payment/UPI settings, and neither is branch control -- see the note on the
          widened guards in backend/routers/v3_branch_mgmt.py. */}
      {activeTab === "branch_control" && (
        <BranchManagementBoard actingUser={currentUser} initialTab="creation" detailReadOnly />
      )}

      {/* Settings — Super Admin's own Marketing Source and CI/CD ROOTS, as one sub-tab
          row of two. */}
      {SETTINGS_SUB_VIEWS.includes(activeTab) && (
        <div className="space-y-4" data-testid="bd-settings">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="bd-settings-subtabs">
            {SETTINGS_SUB_TABS.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActiveTab(t.key)}
                  className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-700" : "text-slate-600 hover:bg-slate-50"}`}
                  data-testid={`bd-settings-subtab-${t.key}`}
                >
                  <Icon className="h-4 w-4" />{t.label}
                </button>
              );
            })}
          </div>

          {/* No `leading` prop, unlike CRMPage's mount of these two: that prop exists to
              hand each board the switcher so Super Admin's Settings opens on one row of
              controls rather than two, and here the row is already above them. Passing it
              would draw the same buttons twice. */}
          <Suspense fallback={<BoardFallback />}>
            {activeTab === "marketing" && (
              <MarketingBoard branches={branches} />
            )}

            {activeTab === "stages" && (
              <PipelineStageManagement />
            )}
          </Suspense>
        </div>
      )}

      {openLead && (
        <LeadDetailDialog
          lead={openLead}
          stages={leadStages}
          currentUser={currentUser}
          onClose={() => setOpenLead(null)}
          onSaved={reloadAll}
          onMoveStage={moveLeadStage}
          // This desk may delete a lead outright (DELETE /leads/{id} names business_dev),
          // so its popup carries the button; Sales View's copy of this popup does not.
          onDeleted={() => { setOpenLead(null); reloadAll(); }}
        />
      )}

      {showCreateLead && (
        // `branchPicker`: this desk routes what it types in, so Branch is a field of its
        // own here rather than a list that appears only for an Offline department.
        // reloadAll, not just the cards, so the open list shows the new lead and its branch.
        <CreateLeadModal
          isSuperAdmin
          branchPicker
          onClose={() => setShowCreateLead(false)}
          onSaved={reloadAll}
        />
      )}

      {/* Which branch the patient is leaving -- the one fact BranchTransferDialog cannot
          work without and the one thing this board, which reads every branch at once,
          does not already know. Branch Admin's copy of that button skips this because its
          whole screen is one branch; Operations skips it because a branch is picked above
          the button. This desk has neither, so it asks.

          A plain list rather than a dropdown: a dropdown would be a control to open before
          the control it opens, and the branches are few enough to name on sight. */}
      {swapPicking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="bd-branch-swap-picker">
          <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="inline-flex items-center gap-2 text-base font-semibold text-slate-800">
                <ArrowLeftRight className="h-4 w-4 text-indigo-600" /> Branch Transfer
              </h3>
              <button
                type="button"
                onClick={() => setSwapPicking(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
                data-testid="bd-branch-swap-picker-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="px-5 pt-3 text-xs text-slate-500">Which branch is the patient leaving?</p>
            <div className="overflow-y-auto p-3">
              {branches.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-slate-400" data-testid="bd-branch-swap-picker-empty">
                  No branches yet.
                </p>
              ) : branches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => { setSwapFromId(b.id); setSwapPicking(false); }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50"
                  data-testid={`bd-branch-swap-from-${b.id}`}
                >
                  <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="truncate">{b.branch_name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {swapFromId && (
        <BranchTransferDialog
          branches={branches}
          fromBranchId={swapFromId}
          onClose={() => setSwapFromId("")}
          // The figures on this board counted the patient against the branch they have
          // just left, so they are wrong the moment the move lands.
          onTransferred={reloadAll}
        />
      )}

      {loading && (
        <div className="fixed bottom-4 right-4 rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-lg" data-testid="bd-loading-indicator">
          Loading...
        </div>
      )}
    </div>
  );
};

/* ─── Drill-down list ─── */

// What each kind of row is worth showing, in HR Admin's column order: an index, the thing
// itself with its secondary line under it, then the facts that name it, then when it
// arrived. One definition per kind drives both the table and the phone cards below, so
// the two can never list different facts about the same row.
const DRILL_COLUMNS = {
  lead: [
    { key: "name", label: "Lead", primary: true, value: (r) => r.name || "—", sub: (r) => r.phone || r.email || "" },
    { key: "source", label: "Source", value: (r) => r.source_tab || r.source_type || "—" },
    { key: "stage", label: "Stage", value: (r) => r.stage || "—" },
    { key: "branch", label: "Branch", value: (r, ctx) => ctx.branchName(r.branch_id) },
    { key: "created", label: "Created", value: (r) => (r.created_at || "").slice(0, 10) || "—" },
  ],
  appointment: [
    { key: "lead_name", label: "Patient", primary: true, value: (r) => r.lead_name || "—" },
    { key: "doctor_name", label: "Consultant", value: (r) => r.doctor_name || "—" },
    { key: "slot_time", label: "Slot", value: (r) => r.slot_time || "—" },
    { key: "status", label: "Status", value: (r) => r.status || "—" },
    { key: "branch", label: "Branch", value: (r, ctx) => ctx.branchName(r.branch_id) },
    { key: "created", label: "Booked", value: (r) => (r.created_at || "").slice(0, 10) || "—" },
  ],
  branch: [
    { key: "branch_name", label: "Branch", primary: true, value: (r) => r.branch_name || "—", sub: (r) => r.address || "" },
    { key: "vertical", label: "Service Type", value: (r) => r.vertical || "—" },
    { key: "admin_name", label: "Branch Admin", value: (r) => r.admin_name || "Not assigned yet" },
    { key: "admin_contact", label: "Contact", value: (r) => r.admin_email || r.admin_phone || "—" },
    { key: "created", label: "Opened", value: (r) => (r.created_at || "").slice(0, 10) || "—" },
  ],
  connection: [
    { key: "connection_name", label: "Connection", primary: true, value: (r) => r.connection_name || "—" },
    { key: "spreadsheet_id", label: "Spreadsheet ID", value: (r) => r.spreadsheet_id || "—" },
    { key: "sync_interval_minutes", label: "Every", value: (r) => (r.sync_interval_minutes ? `${r.sync_interval_minutes} min` : "—") },
    { key: "last_synced_at", label: "Last Synced", value: (r) => (r.last_synced_at || "").slice(0, 16).replace("T", " ") || "Never" },
    { key: "created", label: "Added", value: (r) => (r.created_at || "").slice(0, 10) || "—" },
  ],
};

// A card whose list reads differently from the rest of its kind, keyed by metric. Today's
// Leads is a call sheet: who, the number to ring, where they belong, where they came from,
// and the arrow into the lead. Stage and Created say nothing on a list that is all today's.
// `action` is that arrow -- drawn by the table, not read as a value, so search skips it.
const METRIC_COLUMNS = {
  today: [
    { key: "name", label: "Lead", primary: true, value: (r) => r.name || "—" },
    { key: "phone", label: "Phone", value: (r) => r.phone || "—" },
    { key: "branch", label: "Branch", value: (r, ctx) => ctx.branchName(r.branch_id) },
    { key: "source", label: "Source", value: (r) => r.source_tab || r.source_type || "—" },
    { key: "action", label: "Action", action: true, value: () => "" },
  ],
};

/**
 * The rows behind a summary card: a table from tablet up, the same rows as cards on a
 * phone. The Human Resource Master View's list, which is the pattern the OS uses wherever
 * a list has more than two facts per row -- same slate header, same row rule, same
 * hover, same centred line where there is nothing to show.
 *
 * `total` is the count the server holds and `rows` is what it sent, which is capped. The
 * two differing is the one thing a list like this must admit rather than just stopping.
 *
 * `search`, `sortOrder` and `markFilter` come from the toolbar above the cards and are
 * applied here, over the rows the server sent, rather than being asked of the server: the
 * date range is the only narrowing that endpoint takes, and these three describe the list
 * on screen rather than the figure above it. A card's number therefore keeps meaning what
 * it counted, and the line under the title says how many of those the toolbar is showing.
 */
function DrillList({ drill, loading, branches, onOpenLead, search = "", sortOrder = "newest", markFilter = "" }) {
  const branchName = useCallback(
    (id) => (id ? (branches.find((b) => b.id === id)?.branch_name || "Unknown") : "Unassigned"),
    [branches],
  );
  const ctx = useMemo(() => ({ branchName }), [branchName]);
  const kind = drill?.kind;
  const metric = drill?.metric;
  // Both memoised, and not for the arithmetic -- the two `|| []` fallbacks mint a fresh
  // empty array every render, which would be a changed dependency every render and would
  // re-narrow and re-sort the whole list each time anything on this card moved.
  const columns = useMemo(
    () => (kind ? (METRIC_COLUMNS[metric] || DRILL_COLUMNS[kind] || []) : []),
    [kind, metric],
  );
  // No column set for the kind that came back means a metric was added to the endpoint
  // without one here. Showing nothing beats rendering rows with no headings, and beats
  // the crash the phone branch below would take reading a first column that isn't there.
  const sent = useMemo(() => (columns.length ? (drill?.rows || []) : []), [columns, drill]);

  const rows = useMemo(() => {
    let list = sent;
    // The two marks live on a lead and on nothing else -- an appointment, a branch and a
    // sheet connection carry neither, so applying this to those kinds would empty the
    // list rather than narrow it, and say the branch has no VIPs when what it has is no
    // VIP field. The buttons stay pressable on every card; they simply describe nothing
    // on the four that are not leads.
    if (markFilter && kind === "lead") {
      list = list.filter((r) => (markFilter === "vip" ? r.is_vip : r.needs_attention));
    }
    // Matched against what the row actually shows, column by column, rather than against a
    // hand-listed set of fields. The four kinds carry four different shapes and one list
    // of field names could only be right about one of them; the columns are already the
    // per-kind answer to "what is worth reading here", so searching them means you can
    // find anything you can see and nothing you cannot.
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => columns.some((c) => {
        if (c.action) return false;
        const main = c.value(r, ctx);
        const sub = c.sub?.(r);
        return `${main ?? ""} ${sub ?? ""}`.toLowerCase().includes(q);
      }));
    }
    // The server sends these newest-first already, so only the other order is work.
    if (sortOrder === "oldest") {
      list = [...list].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    }
    return list;
  }, [sent, columns, ctx, kind, markFilter, search, sortOrder]);

  const clipped = drill ? drill.total - sent.length : 0;
  // The toolbar is holding rows back. Said separately from `clipped`, which is the server
  // holding rows back: one is a cap and the other is a question, and a reader who cannot
  // tell them apart cannot tell whether clearing the search would show them everything.
  const narrowed = rows.length !== sent.length;
  // A lead row opens that lead. The other three kinds have no popup of their own to open.
  const openRow = kind === "lead" && onOpenLead ? onOpenLead : null;

  return (
    <Card data-testid="bd-drill-card">
      {/* No title bar: the highlighted card above already names the list, and it closes by
          clicking that card again. What is still worth a line is the two ways this list can
          be shorter than the card's figure -- said only when one of them is happening. */}
      <CardContent className="p-0">
        {drill && (clipped > 0 || narrowed) && (
          <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500" data-testid="bd-drill-count">
            {clipped > 0 && `Showing the ${sent.length.toLocaleString("en-IN")} most recent of ${drill.total.toLocaleString("en-IN")}`}
            {clipped > 0 && narrowed && " · "}
            {narrowed && `${rows.length.toLocaleString("en-IN")} match the toolbar`}
          </p>
        )}
        {loading ? (
          <p className="px-3 py-8 text-center text-sm text-slate-400" data-testid="bd-drill-loading">Loading...</p>
        ) : rows.length === 0 ? (
          /* Which of the two emptinesses this is. "Nothing to show" over a list the
             toolbar just emptied sends somebody looking for rows that are sitting right
             there behind a search they forgot they typed. */
          <p className="px-3 py-8 text-center text-sm text-slate-400" data-testid="bd-drill-empty">
            {sent.length === 0 ? "Nothing to show." : "Nothing here matches the toolbar."}
          </p>
        ) : (
          <>
            {/* Phone: the same facts stacked, the primary column as the heading. */}
            <div className="space-y-2 p-3 md:hidden" data-testid="bd-drill-list-mobile">
              {rows.map((r, i) => {
                const [head, ...others] = columns;
                // The arrow column is a chevron beside the name here, not a labelled field.
                const rest = others.filter((c) => !c.action);
                const arrow = openRow && others.length !== rest.length;
                return (
                  <div
                    key={r.id || i}
                    {...(openRow ? { role: "button", tabIndex: 0, onClick: () => openRow(r), onKeyDown: (e) => { if (e.key === "Enter") openRow(r); } } : {})}
                    className={`rounded-xl border border-slate-200 bg-white p-3 ${openRow ? "cursor-pointer hover:border-sky-300" : ""}`}
                    data-testid={`bd-drill-card-${r.id || i}`}
                  >
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{head.value(r, ctx)}</p>
                      {arrow && <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />}
                    </div>
                    {head.sub?.(r) && <p className="truncate text-xs text-slate-500">{head.sub(r)}</p>}
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      {rest.map((c) => (
                        <div key={c.key} className="min-w-0">
                          <dt className="truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">{c.label}</dt>
                          <dd className="truncate text-xs text-slate-600">{c.value(r, ctx)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-auto md:block">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">S.No</th>
                    {columns.map((c) => <th key={c.key} className={`px-3 py-2 ${c.action ? "w-[5%] text-center" : ""}`}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.id || i}
                      {...(openRow ? { onClick: () => openRow(r), title: "Open lead" } : {})}
                      className={`border-t border-slate-100 hover:bg-slate-50 ${openRow ? "cursor-pointer" : ""}`}
                      data-testid={`bd-drill-row-${r.id || i}`}
                    >
                      <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                      {columns.map((c) => (c.action ? (
                        // Opens the same popup the row does; the arrow is what says so.
                        <td key={c.key} className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                          {openRow && (
                            <button
                              type="button"
                              onClick={() => openRow(r)}
                              title="View lead"
                              aria-label={`View ${r.name || "lead"}`}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                              data-testid={`bd-drill-open-${r.id || i}`}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      ) : (
                        <td key={c.key} className="px-3 py-2 text-slate-600">
                          {c.primary ? (
                            <div className="min-w-0">
                              <p className="font-medium text-slate-800">{c.value(r, ctx)}</p>
                              {c.sub?.(r) && <p className="text-xs text-slate-400">{c.sub(r)}</p>}
                            </div>
                          ) : c.value(r, ctx)}
                        </td>
                      )))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Dashboard Tab ─── */

// The row of cards this desk has always read, as a tab definition rather than as the
// cards themselves -- the five figures are built from `summary` inside the component, and
// the strip has to be drawable before that has landed.
//
// Summary is the pipeline as it stands today -- what came in and how far along it is,
// the figures a desk acts on this morning. Its key stays "onboarding", the tab's old name,
// so nothing keyed on it moves. The second row (systematic statistics: revenue, rate,
// branches, sheets) was dropped from this desk's Dashboard.
const CARD_GROUPS = [
  {
    key: "onboarding",
    label: "Summary",
    icon: UserPlus,
    cols: "lg:grid-cols-5",
  },
];

// The Dashboard's own strip: this desk's card row, then Super Admin's own Dashboard
// tabs -- Revenue, Team, Clients and Analytics.
//
// Mounted as peers of the two rather than folded in behind one of them, because they are
// the same kind of thing: a view of this Dashboard. They are DashboardBoard's own
// components, through DashboardTabPanel, with nothing held back and nothing passed to
// narrow them -- the same rule the boards on the nav above already follow. A figure means
// here exactly what it means on Super Admin's copy because it is the same request
// answering both, which is the only reason a desk reading both can trust either. What this
// account may actually read is settled by the API off its token: business_dev sits beside
// super_admin on /dashboard/overview, /dashboard/leads-analytics, /dashboard/leads-trend,
// /dashboard/clients, /marketing/team-members, /finance/revenue-overview and the three HR
// reads the Team roster is drawn from.
//
// They sit after the two card rows, not before: this desk's own nine figures are what it
// opens for, and these six are the group-wide read behind them.
//
// Marketing and Sales are left off this desk's copy: the BDE board doesn't read them.
// Super Admin's own Dashboard still draws both.
const HIDDEN_DASH_TABS = ["marketing", "sales"];
const DASH_SUB_TABS = [...CARD_GROUPS, ...DASH_TABS.filter((t) => !HIDDEN_DASH_TABS.includes(t.key))];
const CARD_GROUP_KEYS = CARD_GROUPS.map((g) => g.key);

// The two tabs this desk reads as a table of rows rather than as Super Admin's row of
// StatTiles -- see BdMarketingSources. Each opens on its own grouping: Marketing asks
// which sheet the leads came from, Sales asks where in the funnel they are.
const BREAKDOWN_TABS = { marketing: "source", sales: "stage" };

// Which of the eight tabs the toolbar's branch popover scopes, beyond the two tables
// above. All four read per-branch figures and every one of them used to draw an
// All/Offline/Online chip row of its own under the toolbar -- the same filter, a second
// time, in a second shape, on a board whose whole toolbar is built so that everything
// narrowing the screen sits on one line. The popover is now the only copy, and the panels
// take it as a prop; see DashboardTabPanel's `scope`.
//
// Summary is absent: it is this desk's own card row, scoped by the account rather than
// by a branch.
const SCOPED_TABS = ["revenue", "team", "clients", "analytics"];

// What the search box narrows on each tab, and the words printed in it. A tab named here
// has a list the box reaches; Revenue is four totals and Analytics is charts, so neither
// is, and the box is left off there rather than sitting on the row doing nothing -- the
// same rule that already kept it off these six entirely.
const SEARCH_HINTS = {
  marketing: "Search a source or branch...",
  sales: "Search a stage or branch...",
  clients: "Search a client name, phone or email...",
  team: "Search a name, email or role...",
};

// What the six imported tabs are handed when neither date control is set. They read a
// range off `.from`/`.to` without guarding it, and this board's two controls intersect to
// null rather than to an open range. Module-level so it is the same object on every
// render -- four of the six name the range in an effect's dependency list.
const ALL_DATES = { key: "all", label: "All", from: null, to: null };

/**
 * The nine figures, in the two rows they are read in.
 *
 * `metric` on each card is the key its rows are fetched by -- see BD_ROW_METRICS in
 * backend/routers/v3_dashboard.py. A card with no metric opens nothing.
 */
// OnBoarding's one colour: every figure and the open card's ring in the same slate, so the
// row reads as one set and only the ring says which list is open.
const ONBOARDING_INK = "#475569";

const buildCardGroups = (summary) => {
  const todayCount = summary.today_leads || 0;
  const followUp = summary.stage_counts?.["Follow Up"] || 0;

  const cards = {
    onboarding: [
      { key: "total", metric: "total", label: "Total Leads", value: summary.total_leads, color: ONBOARDING_INK },
      { key: "today", metric: "today", label: "Today's Leads", value: todayCount, color: ONBOARDING_INK },
      { key: "followup", metric: "followup", label: "Active Follow-ups", value: followUp, color: ONBOARDING_INK },
      { key: "appointments", metric: "appointments", label: "Appointments", value: summary.total_appointments, color: ONBOARDING_INK },
      { key: "converted", metric: "converted", label: "Converted", value: summary.completed_appointments, color: ONBOARDING_INK },
    ],
  };

  return CARD_GROUPS.map((g) => ({ ...g, cards: cards[g.key] || [] }));
};

function DashboardTab({
  summary,
  loading,
  branches,
  openMetric,
  onOpenCard,
  drill,
  drillLoading,
  quickDate,
  onQuickDate,
  dateFilter,
  onDateFilter,
  effectiveDateFilter,
  onRefresh,
  onPulled,
  onBranchSwap,
  onAddLead,
  onOpenLead,
}) {
  // Which tab of the eight is on screen. OnBoarding, because this desk's own pipeline is
  // what it opens the board for; the six group-wide reads after it are the question behind
  // that one, not instead of it.
  const [openGroup, setOpenGroup] = useState("onboarding");

  // The three toolbar controls that narrow and order the open list rather than re-asking
  // the server for it. Held here, not in the parent, because the list they describe is
  // rendered from this component -- see the note on DrillList's own props. The date range
  // is the opposite case and lives upstairs, since it re-scopes the cards too.
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [markFilter, setMarkFilter] = useState("");

  // Marketing and Sales' own three scoping controls. Held up here with the rest of the
  // toolbar rather than inside the table they scope, because that is where they are drawn:
  // the whole point of the row below is that every control narrowing what is on screen
  // sits on one line, and a filter that lived in the panel could only be drawn under it.
  const [scopeGroup, setScopeGroup] = useState("all");
  const [scopeBranchId, setScopeBranchId] = useState("");
  const [groupBy, setGroupBy] = useState("source");

  // Whether the open tab is one of this desk's two card rows, or one of the six imported
  // ones. Almost everything below branches on it: the card rows read `summary` and drive
  // the drill list, and the six read their own payloads and have no list to narrow.
  const onCards = CARD_GROUP_KEYS.includes(openGroup);

  // Whether the open tab is one of the two this desk draws as a table. Those two put four
  // more controls on the toolbar and read none of the four the card rows use.
  const breakdownMode = BREAKDOWN_TABS[openGroup] ? openGroup : null;

  // Whether the toolbar's branch popover applies to the open tab, and what its search box
  // has to narrow there. Both are what make Revenue, Team, Clients and Analytics wear the
  // same toolbar as Marketing rather than a bare row of dates and actions.
  const scopedTab = !!breakdownMode || SCOPED_TABS.includes(openGroup);
  const searchHint = onCards ? "Search this list..." : SEARCH_HINTS[openGroup];

  // The six imported tabs' own payloads -- the same hook Super Admin's Dashboard runs on.
  //
  // Gated until one of the six is first opened: the overview is a wide request, and this
  // board opens on OnBoarding, which reads none of it. Latched rather than tracking which
  // tab is open, because un-gating it on the way back to a card row would re-ask for the
  // whole overview every time somebody stepped out to OnBoarding and back. Once this desk
  // has shown it wants those figures, they stay live and follow the date range.
  const [wantsPanels, setWantsPanels] = useState(false);
  const panelRange = effectiveDateFilter || ALL_DATES;
  const dash = useDashboardData(panelRange, openGroup, wantsPanels);
  // The same range again, in the two query params the BD endpoints take rather than as the
  // {from,to} the six imported tabs read. Marketing is the only tab below that asks the
  // server for rows of its own. Memoised because it is a dependency of that table's fetch:
  // rebuilt every render, it would re-ask for the sources each time anything here moved.
  const panelDateParams = useMemo(() => dateParamsOf(effectiveDateFilter), [effectiveDateFilter]);

  // The toolbar's own branch popover and search box, handed to whichever of the six is
  // open so the panel is scoped by the row above it instead of by a filter of its own.
  // Memoised because the four tabs that take it name it in their render path on every
  // keystroke; rebuilt each render it would be a new object for no change.
  const panelScope = useMemo(() => ({
    group: scopeGroup,
    onGroup: setScopeGroup,
    branchId: scopeBranchId,
    onBranch: setScopeBranchId,
    search,
  }), [scopeGroup, scopeBranchId, search]);

  // That range in words, for the caption over the Marketing table. Both halves, because
  // neither is enough on its own: the label says which button is pressed ("Last 90 Days")
  // and the dates say what that resolved to, which is the thing a desk copies into a
  // report. An open range names itself and has no dates to give.
  const panelRangeLabel = useMemo(() => {
    const f = effectiveDateFilter;
    if (!f?.from || !f?.to) return "All time";
    const day = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    return `${f.label ? `${f.label} · ` : ""}${day(f.from)} → ${day(f.to)}`;
  }, [effectiveDateFilter]);

  // A name typed, or a mark pressed, with no card open has nothing to narrow -- the
  // controls would sit there doing nothing visible and read as broken. Total Leads is the
  // widest of the nine and every other list is a subset of it, so that is the one that
  // opens. Clearing a mark opens nothing: an answer being put away is not a question.
  const searchList = (v) => {
    setSearch(v);
    // Only on a card row. On Marketing and Sales the same box narrows the table that is
    // already on screen, and opening a summary card underneath it would answer a question
    // nobody asked with a list nobody can see.
    if (onCards && v.trim() && !openMetric) onOpenCard("total");
  };
  const toggleMark = (m) => {
    const next = markFilter === m ? "" : m;
    setMarkFilter(next);
    if (next && !openMetric) onOpenCard("total");
  };

  const cardGroups = summary ? buildCardGroups(summary) : [];
  const activeCardGroup = cardGroups.find((g) => g.key === openGroup);

  // Leaving a tab closes the list under it. Those rows were opened by a card in the row
  // being left, and only one row is on screen, so carrying them over would leave rows
  // headed by one figure sitting under a row of four others -- or, switching to one of the
  // six, under a board that never opened them at all.
  const selectGroup = (key) => {
    if (key === openGroup) return;
    if (openMetric) onOpenCard(openMetric);
    // Back on OnBoarding, Today's Leads opens again -- the same list the board arrives on.
    if (key === "onboarding") onOpenCard("today");
    if (!CARD_GROUP_KEYS.includes(key)) setWantsPanels(true);
    // A name typed on one tab means nothing on the next, and left in the box it would
    // narrow the new tab's list to nothing while reading as empty rather than as filtered.
    // The branch scope is the opposite case and is deliberately carried: it means the same
    // thing on all eight.
    setSearch("");
    // Marketing groups by source and Sales by stage, and neither key exists on the other
    // tab -- carrying the pressed one across would ask the server for a grouping it would
    // reject. The branch scope IS carried: it means the same thing on both.
    if (BREAKDOWN_TABS[key]) setGroupBy(BREAKDOWN_TABS[key]);
    setOpenGroup(key);
  };

  // What Refresh re-asks for. This board's own summary always, and on one of the six also
  // the overview behind Revenue, Team and Analytics -- the same reload Super Admin's own
  // Refresh does, and the same limit: Marketing, Sales and Clients fetch on mount and on a
  // filter change, so pressing this reloads the figures they are scoped by rather than the
  // figures themselves.
  const refreshOpen = () => {
    onRefresh();
    if (!onCards) dash.loadOverview();
  };

  return (
    <div className="space-y-3" data-testid="bd-dashboard-content">
      {/* Two bars, not one. The eight tabs and the nine controls were a single wrapping
          row, and at eight tabs that row folds onto three lines with a pill, a search
          field and a calendar sharing each of them -- nothing on it reads as belonging to
          anything else on it.

          Split, each bar says one thing. The first is where you are: eight tabs and
          nothing else, so the row can be read straight across. The second is what you can
          do here: narrow, order, mark, refresh, move, pull. The two carry the same border
          and the same height, so they read as one control block in two halves rather than
          as two unrelated strips. */}

      {/* Tabs. One wrapping row of pills, the open one in sky — the shape Settings' own
          two views already sit on. Sub-tabs and not eight more entries on the nav above,
          because every one of them is a view of this Dashboard; the tabs up there are
          other desks' boards.

          On a phone the pills wrapped onto three lines. Below sm they sit on one line as
          icons, and only the open tab spells out its name -- the strip still says where
          you are without costing three rows of a small screen. */}
      <div className="flex flex-nowrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:flex-wrap" data-testid="bd-dash-subtabs">
        {DASH_SUB_TABS.map((g) => {
          const Icon = g.icon;
          const active = g.key === openGroup;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => selectGroup(g.key)}
              aria-pressed={active}
              aria-label={g.label}
              title={g.label}
              className={`inline-flex min-w-0 flex-auto items-center justify-center whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-all duration-500 ease-in-out sm:shrink-0 sm:flex-none sm:px-3 ${active ? "bg-sky-50 text-sky-700" : "text-slate-600 hover:bg-slate-50"}`}
              data-testid={`bd-dash-subtab-${g.key}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {/* Width and opacity rather than display, so the name slides open on the tab
                  you pick and folds away on the one you left instead of snapping. */}
              <span className={`overflow-hidden text-ellipsis transition-all duration-500 ease-in-out sm:ml-2 sm:max-w-none sm:opacity-100 ${active ? "ml-2 max-w-[9rem] opacity-100" : "ml-0 max-w-0 opacity-0"}`}>{g.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tools. Read left to right: what to narrow the open list to, then which dates,
          then in what order, then what to do about it.

          It wraps rather than scrolling or hiding. Every control on here fits one line on
          a full desk at 2xl; below that the row folds onto a second and third line inside
          the same bordered card. A toolbar that overflows sideways puts Pull From Sheet
          past the edge of the screen with nothing saying it is there, and a toolbar that
          hides its right-hand half on a laptop is a toolbar most of this desk never sees.

          Three of the controls are drawn only on the two card rows -- the order dropdown
          and the two marks. All three order or narrow the list a card opens, and on the
          six imported tabs there is no such list: they would sit there doing nothing
          visible and read as broken, which is the same reason the search field opens Total
          Leads rather than doing nothing when nothing is open.

          The search field and the branch scope are drawn wherever they reach something --
          see SEARCH_HINTS and SCOPED_TABS. That is what makes Revenue, Team, Clients and
          Analytics carry this same toolbar rather than a bare row of dates and actions
          with a filter of their own underneath. The dates and the four actions stay on all
          eight, because every one of them means the same thing on every one of them. */}
      {/* On a phone the tools are one line: the search field, then every action as a bare
          icon, Add Lead included (the strip's own Add Lead steps aside below sm). The five
          ranges drop to a line of their own under it -- they are a choice among five, not
          an action, and squeezing them into icons would lose which one is lit. What does
          not fit a narrow phone scrolls sideways instead of wrapping. */}
      <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1 [scrollbar-width:none] sm:flex-wrap sm:gap-2 sm:overflow-visible [&::-webkit-scrollbar]:hidden" data-testid="bd-dash-tools">
        {/* The open list's own field. `flex-basis: 0` (from flex-1) is what keeps it off a
            line of its own: the row is measured as if this were zero wide and it then
            grows into whatever the other controls left, capped so a search box is not
            stretched across a 1600px board it cannot use. Full width on a phone, where it
            is the only thing on its line anyway. */}
        {searchHint && (
          <div className="relative min-w-[8rem] flex-1 sm:w-auto sm:min-w-[160px] sm:max-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              className="h-10 pl-9"
              placeholder={searchHint}
              value={search}
              onChange={(e) => searchList(e.target.value)}
              data-testid="bd-search"
            />
          </div>
        )}

        {/* The five one-tap ranges, `inline` so they hold one line and tighten to about
            330px, and without their own Custom trigger -- the calendar to the right opens
            that same popover, and two doors onto one control side by side is the
            duplication, not the control. */}
        {/* `w-full` below sm, and only below sm. `inline` sizes the five buttons with
            flex-1 at phone widths -- a proportion, which needs something to be a
            proportion OF. Branch Admin's copy never meets that case because it hides the
            inline row under lg and keeps a full-width one underneath; this bar has no
            second row to fall back to, so the width is given here instead. From sm the
            buttons go flex-none and size themselves, and the wrapper gets out of the way. */}
        <div className="order-last hidden w-full shrink-0 sm:order-none sm:block sm:w-auto">
          <QuickDateFilterBar
            value={quickDate}
            onChange={onQuickDate}
            testid="bd-quick-date"
            inline
            showCustom={false}
          />
        </div>

        {/* The branch scope, on six of the eight tabs: Marketing and Sales' tables, and
            Revenue, Team, Clients and Analytics. It is on this row rather than above the
            panel so the range, the scope and the grouping are read left to right as one
            sentence -- and so what is underneath is the answer and nothing else. Those
            last four each used to draw the same filter for themselves, as a chip row under
            the toolbar; this is now the only copy and they take it as a prop.

            A popover here, not the bordered row of one chip per branch that
            ModeBranchFilter draws. Seven branch chips need a row to themselves, which is
            the row this is trying not to have. */}
        {scopedTab && (
          <ModeBranchScope
            branches={dash.branches}
            group={scopeGroup}
            onGroup={setScopeGroup}
            branchId={scopeBranchId}
            onBranch={setScopeBranchId}
            testid="bd-scope"
          />
        )}

        {/* The grouping stays the two tables' own. Every other tab is a fixed set of
            figures rather than rows that could be keyed another way, so there is nothing
            for a Source / Branch / Source x Branch to re-key there. */}
        {breakdownMode && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200 p-0.5" data-testid="bd-group-by">
            {BREAKDOWN_MODES[breakdownMode].groupings.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => setGroupBy(g.key)}
                title={g.hint}
                aria-pressed={groupBy === g.key}
                className={`shrink-0 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-semibold transition ${
                  groupBy === g.key ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
                }`}
                data-testid={`bd-group-by-${g.key}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}

        {/* The actions, held to the right edge of whichever line they end up on.
            Wrappable, and deliberately not shrink-0: seven controls come to about 390px
            and a 375px phone is 15px short of that, so the alternative to a second line
            here is Pull From Sheet hanging off the edge of the screen. */}
        <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-1.5 sm:shrink sm:flex-wrap">
          {onCards && (
            <>
              {/* Words rather than an arrow, for the reason Branch Admin's copy gives: two
                  arrow states say which way the glyph points and never which way the list
                  is about to go. The closed control says the order the list is already in. */}
              {/* Phone: the order as one arrow that flips it -- down for newest first, up
                  for oldest first, with the words on title and aria-label. */}
              <button
                type="button"
                onClick={() => setSortOrder(sortOrder === "newest" ? "oldest" : "newest")}
                title={sortOrder === "newest" ? "New to First — tap for Old to First" : "Old to First — tap for New to First"}
                aria-label={sortOrder === "newest" ? "Sort: New to First" : "Sort: Old to First"}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 sm:hidden"
                data-testid="bd-sort-order-toggle"
              >
                {sortOrder === "newest" ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
              </button>
              <Select value={sortOrder} onValueChange={setSortOrder}>
                <SelectTrigger
                  title="Order the list by date"
                  aria-label="Sort order"
                  className="hidden h-10 w-[112px] shrink-0 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-none transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-sky-200 sm:flex sm:w-[124px]"
                  data-testid="bd-sort-order"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-200" data-testid="bd-sort-order-menu">
                  <SelectItem value="newest" className="text-xs text-slate-700">New to First</SelectItem>
                  <SelectItem value="oldest" className="text-xs text-slate-700">Old to First</SelectItem>
                </SelectContent>
              </Select>

              {/* The two marks, in Branch Admin's colours so a VIP is amber on both boards.
                  Lit when active, and pressing the lit one clears it, so one control both
                  narrows and returns. */}
              <button
                type="button"
                onClick={() => toggleMark("vip")}
                title={markFilter === "vip" ? "Showing VIP clients only — click to show all" : "Show VIP clients only"}
                aria-label="Show VIP clients only"
                aria-pressed={markFilter === "vip"}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
                  markFilter === "vip" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white hover:bg-amber-50"
                }`}
                data-testid="bd-filter-vip"
              >
                <Star className={`h-4 w-4 ${markFilter === "vip" ? "fill-amber-400 text-amber-500" : "text-slate-400"}`} />
              </button>
              <button
                type="button"
                onClick={() => toggleMark("attention")}
                title={markFilter === "attention" ? "Showing flagged leads only — click to show all" : "Show leads needing attention only"}
                aria-label="Show leads needing attention only"
                aria-pressed={markFilter === "attention"}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
                  markFilter === "attention" ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white hover:bg-rose-50"
                }`}
                data-testid="bd-filter-attention"
              >
                <AlertCircle className={`h-4 w-4 ${markFilter === "attention" ? "fill-rose-500 text-white" : "text-slate-400"}`} />
              </button>
            </>
          )}

          {/* Everything the five ranges are not: Yesterday, Last Month, an exact day, a
              typed range. Narrowed together with them rather than overruling them, so both
              stay lit saying what produced the figures. */}
          <DateFilterPopover
            value={dateFilter}
            onChange={onDateFilter}
            testid="bd-date-filter"
            centered
            iconOnly
            phoneIconOnly
          />

          <Button
            onClick={refreshOpen}
            disabled={loading || dash.loading}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="bd-refresh-btn"
          >
            <RefreshCw className={`h-4 w-4 ${loading || dash.loading ? "animate-spin" : ""}`} />
          </Button>

          <Button
            onClick={onBranchSwap}
            title="Branch Transfer"
            aria-label="Branch Transfer"
            variant="outline"
            className="h-10 w-10 shrink-0 border-indigo-200 p-0 text-indigo-700 hover:bg-indigo-50"
            data-testid="bd-branch-swap-btn"
          >
            <ArrowLeftRight className="h-4 w-4" />
          </Button>

          {/* Scoped server-side to whatever this account may pull, the same as every other
              mount of it. The hints name Settings → Marketing Source, because that is where
              this desk connects a sheet and tags it to a branch. */}
          <PullFromSheetButton
            onPulled={onPulled}
            notConnectedHint="Google Sheets isn't connected yet — connect it under Settings → Marketing Source → Lead Sources."
            noSourcesHint="No Google Sheet source is configured yet — add one under Settings → Marketing Source → Lead Sources."
            iconOnly
          />

          <Button
            onClick={onAddLead}
            title="Add Lead"
            aria-label="Add Lead"
            className="h-10 w-10 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700 sm:hidden"
            data-testid="bd-toolbar-add-lead-btn"
          >
            <UserPlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* The five ranges' phone line -- see the note on the tools row above. */}
      <div className="sm:hidden">
        <QuickDateFilterBar
          value={quickDate}
          onChange={onQuickDate}
          testid="bd-quick-date-phone"
          inline
          showCustom={false}
        />
      </div>

      {/* The two card rows. Their empty and loading states are here rather than at the top
          of the component, where they used to be: an empty summary is a reason to say so
          under the two bars, not a reason to take the other six tabs off the screen with
          them. */}
      {onCards ? (
        !summary && loading ? (
          <p className="py-8 text-center text-sm text-slate-400" data-testid="bd-dash-loading">Loading dashboard...</p>
        ) : !activeCardGroup ? (
          <p className="py-8 text-center text-sm text-slate-400" data-testid="bd-dash-empty">No data yet</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2" data-testid={`bd-group-${activeCardGroup.key}`}>
              {/* The same grid HR Admin's Dashboard lays its row out on -- two up on a
                  phone, the group's own width across on a desk. */}
              <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${activeCardGroup.cols}`} data-testid={`bd-metrics-${activeCardGroup.key}`}>
                {/* The Zumba strip's card, arrow and all: white, a grey label with the
                    chevron in the corner, the figure in the card's own colour, and the open
                    card ringed in it. Label and figure only -- no trend line. */}
                {activeCardGroup.cards.map((m) => (
                  <StatTile
                    key={m.key}
                    arrow
                    label={m.label}
                    value={m.value}
                    color={m.color}
                    active={openMetric === m.metric}
                    onClick={m.metric ? () => onOpenCard(m.metric) : undefined}
                    testid={`bd-metric-${m.key}`}
                  />
                ))}
              </div>
            </div>

            {openMetric && (
              <DrillList
                drill={drill}
                loading={drillLoading}
                branches={branches}
                onOpenLead={onOpenLead}
                search={search}
                sortOrder={sortOrder}
                markFilter={markFilter}
              />
            )}
          </div>
        )
      ) : (
        /* Marketing, Sales, Revenue, Team, Clients or Analytics — DashboardBoard's own
           tab, drawn from this desk's date range and its own payloads. No date row and no
           strip come with it: both are the two bars above.

           Marketing is the one exception on this board. Super Admin reads that tab as a
           row of per-channel tiles, capped at six with the rest folded into "Other" --
           right for a chart, wrong for a desk whose job is the sheets themselves. The
           sheets it most needs to check on are the small and the newly broken, which are
           exactly the ones that cap leaves unnamed, and a count on its own ranks channels
           by a size the desk already knows.

           So the same question is drawn here as a table: every source named, with Booked
           and Conversion beside the count and Last Lead to catch a sync that has stopped,
           and the leads behind any row a click away.

           Swapped here rather than inside DashboardTabPanel because the change is this
           desk's, not the tab's: Super Admin's own Dashboard > Marketing still draws the
           tiles, out of the same unchanged component. */
        <div data-testid={`bd-dash-panel-${openGroup}`}>
          {breakdownMode ? (
            <BdMarketingSources
              mode={breakdownMode}
              branches={dash.branches}
              dateParams={panelDateParams}
              group={scopeGroup}
              branchId={scopeBranchId}
              groupBy={groupBy}
              search={search}
              rangeLabel={panelRangeLabel}
              onOpenLead={onOpenLead}
            />
          ) : (
            <DashboardTabPanel tab={openGroup} dateFilter={panelRange} dash={dash} scope={panelScope} />
          )}
        </div>
      )}
    </div>
  );
}
