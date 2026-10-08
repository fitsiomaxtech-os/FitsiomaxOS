import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Users, CalendarCheck, Activity, IndianRupee, RefreshCw,
  Megaphone, Headphones, BarChart3, Wallet, Stethoscope, ShoppingBag, Salad,
  AlertCircle, CalendarClock, CheckCircle2, XCircle, Star, AlertTriangle, Music, HeartPulse, Building2,
  ChevronDown, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { getDashboardOverview, getDashboardLeadsTrend, getLeadsAnalytics, getRevenueOverview, mkGetTeam, getDashboardClients, hrUsers, hrEmployees, hrMeta } from "@/lib/api";
import { TeamCard } from "@/components/marketing/TeamCard";
import { StaffRoster } from "@/components/StaffRoster";
import { setCustomRoleClasses } from "@/lib/roles";
import { LeadsAnalyticsDashboard } from "@/components/marketing/LeadsAnalyticsDashboard";

// Five sub-tabs, each scoped by the same date range and the same All/Offline/Online +
// branch filter (see ModeBranchFilter below) — the split the rest of the OS already
// filters branches by. Marketing and Sales read the same /dashboard/leads-analytics
// payload (source breakdown vs stage breakdown); Revenue and Team read the two payloads
// every other tab already fetches (getDashboardOverview, mkGetTeam); Analytics is the
// six-month growth trend, on its own now that Executive Overview no longer exists.
export const DASH_TABS = [
  { key: "marketing", label: "Marketing", icon: Megaphone },
  { key: "sales", label: "Sales", icon: Headphones },
  { key: "revenue", label: "Revenue", icon: IndianRupee },
  { key: "team", label: "Team", icon: Users },
  // After Team, because it is the same kind of question one rung in: Team is who works
  // here, this is who they are working on and which of them cannot be left to the ordinary
  // run of the pipeline.
  { key: "clients", label: "Clients", icon: Star },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
];

// The two marks a lead can carry, in the words the board uses for them. Both are put on by
// hand and neither follows from a stage, which is exactly why they are worth a tab: a lead
// sitting in a perfectly ordinary stage can be either.
const CLIENT_VIEWS = [
  {
    key: "premium",
    label: "Premium (VIP Client)",
    icon: Star,
    color: "#d97706",
    sub: "starred to be treated especially well",
    empty: "Nobody is starred yet. Star a client from their lead to bring them here.",
  },
  {
    key: "attention",
    label: "Need Attention",
    icon: AlertTriangle,
    color: "#dc2626",
    sub: "flagged as needing looking at",
    empty: "Nothing is flagged. Flag a client from their lead when something needs looking at.",
  },
];

const TEAM_PANELS = {
  pre_sales: { title: "Pre-Sales Team", subtitle: "Lead qualification and appointment booking" },
  branch: { title: "Branch Performance", subtitle: "Consultations booked in, and how many reached a physio" },
};

const startOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const endOfDay = (d) => { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; };
const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// A real Monday→Sunday calendar week, not a rolling last-7-days window.
const mondayOf = (d) => {
  const n = startOfDay(d);
  const day = n.getDay(); // 0 = Sun .. 6 = Sat
  n.setDate(n.getDate() + (day === 0 ? -6 : 1 - day));
  return n;
};
const sundayOf = (d) => { const m = mondayOf(d); const n = new Date(m); n.setDate(n.getDate() + 6); return n; };
const daysBack = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() - n); return x; };

// One-tap ranges, widest first, then the day, the week, the month and the quarter.
// Anything else is a Custom Range away.
//
// All carries no dates at all — the overview endpoint treats a missing start and end as
// unfiltered rather than needing some sentinel "since the beginning" date, so All is the
// absence of a range rather than a very wide one.
//
// Last 90 Days counts today as one of the ninety, so it runs today-89 → today. The
// alternative — ninety whole days ending yesterday — makes the figure exclude the
// morning's takings, which is the one thing a Super Admin opening this board is
// most likely to be checking.
// `short` is the phone label. Six full labels cannot share a phone's width, and the
// alternatives are worse: truncating gives "Last 9…", wrapping costs a row, scrolling
// hides the last two off the edge. Shortening is the only one that keeps all six on
// screen and readable. `label` is still what the chip and the filter state carry, so
// nothing downstream sees the abbreviation.
const DASH_PRESETS = [
  { key: "all", label: "All", short: "All", range: () => ({ from: null, to: null }) },
  { key: "today", label: "Today", short: "Today", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { key: "this_week", label: "This Week", short: "Week", range: () => ({ from: mondayOf(new Date()), to: endOfDay(sundayOf(new Date())) }) },
  { key: "this_month", label: "This Month", short: "Month", range: () => { const t = new Date(); return { from: startOfDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: endOfDay(new Date(t.getFullYear(), t.getMonth() + 1, 0)) }; } },
  { key: "last_90", label: "Last 90 Days", short: "90d", range: () => ({ from: daysBack(new Date(), 89), to: endOfDay(new Date()) }) },
];

const presetFilter = (p) => ({ key: p.key, label: p.label, ...p.range() });

// What the board opens on, and where clearing the Custom filter lands: All. The shared
// filter's cleared state is null, which this board can't hold — every card reads from
// `dateFilter` — so it resolves to the preset that means the same thing.
const defaultFilter = () => presetFilter(DASH_PRESETS[0]);

const fmtValue = (tabKey, value) => (tabKey === "revenue" ? `₹${(value || 0).toLocaleString("en-IN")}` : value);

// Same helper BranchManagementBoard.jsx, PreSalesCRM.jsx, OperationsBoard.jsx and
// BranchStoreBoard.jsx each already carry their own copy of.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

const MODE_GROUPS = [
  { key: "all", label: "All" },
  { key: "offline", label: "Offline" },
  { key: "online", label: "Online" },
];

/** Comma-separated branch ids for /dashboard/leads-analytics' own `branch_ids` param — a
 *  specific branch wins outright, otherwise every branch in the selected group. `undefined`
 *  for All, which the endpoint reads as unfiltered rather than needing every id spelled
 *  out. A group that resolves to zero branches (Online, before any exist) is asked for by
 *  an id nothing can match, so it returns nothing rather than silently falling back to
 *  every branch the way an empty string would. */
export const resolveBranchIds = (branches, group, branchId) => {
  if (branchId) return branchId;
  if (group === "all") return undefined;
  const ids = branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online")).map((b) => b.branch_id);
  return ids.length ? ids.join(",") : "__none__";
};

/**
 * The same All / Offline / Online + branch filter as ModeBranchFilter below, folded into
 * something that fits on a toolbar row beside other controls.
 *
 * Same state, same props, same meaning — only the branch half is drawn differently. There
 * it is a bordered box of one chip per branch, which on this estate is seven chips and
 * needs a row of its own; here it is a button that names the current branch and opens the
 * same list in a popover. A board with one toolbar row to spend cannot afford the chips,
 * and a board with room for them should not be made to hunt inside a popover.
 *
 * Picking a group clears any branch already chosen — the two read as one filter, not two
 * independent ones — which is the one behaviour that would break if a caller wired the
 * halves up separately, and the reason they stay one component.
 */
export const ModeBranchScope = ({ branches, group, onGroup, branchId, onBranch, testid }) => {
  const visible = group === "all" ? branches : branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online"));
  const current = branches.find((b) => b.branch_id === branchId);
  const allLabel = group === "all" ? "All Branches" : `All ${group === "online" ? "Online" : "Offline"}`;
  return (
    <>
      {/* h-10 and white, so it lines up with the branch button beside it and the date
          buttons on Super Admin's row, which sits on the page's grey rather than in a card. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5" data-testid={`${testid}-groups`}>
        {MODE_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => { onGroup(g.key); onBranch(""); }}
            aria-pressed={group === g.key}
            className={`h-full shrink-0 rounded px-2.5 text-xs font-semibold transition ${
              group === g.key ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
            }`}
            data-testid={`${testid}-group-${g.key}`}
          >
            {g.label}
          </button>
        ))}
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Filter by branch"
            className={`flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition ${
              branchId ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            data-testid={`${testid}-branch-button`}
          >
            <Building2 className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[130px] truncate">{current?.branch_name || allLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-80 w-64 overflow-y-auto p-1" data-testid={`${testid}-branch-menu`}>
          {/* The group's own "everything" row first, and it is what a cleared branch means
              rather than a fourth group: clearing the branch inside Offline returns to
              Offline, not to the whole estate. */}
          <button
            type="button"
            onClick={() => onBranch("")}
            className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition hover:bg-slate-50 ${!branchId ? "font-semibold text-sky-700" : "text-slate-700"}`}
            data-testid={`${testid}-branch-all`}
          >
            <Check className={`h-3.5 w-3.5 shrink-0 ${branchId ? "opacity-0" : ""}`} />
            <span className="truncate">{allLabel}</span>
          </button>
          {visible.map((b) => (
            <button
              key={b.branch_id}
              type="button"
              onClick={() => onBranch(branchId === b.branch_id ? "" : b.branch_id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition hover:bg-slate-50 ${branchId === b.branch_id ? "font-semibold text-sky-700" : "text-slate-700"}`}
              data-testid={`${testid}-branch-${b.branch_id}`}
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${branchId === b.branch_id ? "" : "opacity-0"}`} />
              <span className="truncate">{b.branch_name}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </>
  );
};

/**
 * The filter every sub-tab below Marketing/Sales/Revenue/Team opens with: All / Offline /
 * Online, and under it one pill per branch in whichever group is picked. Picking a group
 * clears any branch already chosen — the two rows read as one filter, not two independent
 * ones — and picking the already-selected branch clears back to the group.
 */
export const ModeBranchFilter = ({ branches, group, onGroup, branchId, onBranch, testid }) => {
  const visible = group === "all" ? branches : branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online"));
  return (
    <div className="space-y-2" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        {MODE_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => { onGroup(g.key); onBranch(""); }}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              group === g.key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
            }`}
            data-testid={`${testid}-group-${g.key}`}
          >
            {g.label}
          </button>
        ))}
      </div>
      {/* Finance's branch row, class for class: one bordered box of square chips from sm up,
          a dropdown on a phone. Seven branch names wrap to three rows of chips on a phone,
          and a select holds them in one. */}
      {visible.length > 0 && (
        <>
          <select
            value={branchId}
            onChange={(e) => onBranch(e.target.value)}
            className="h-10 w-full rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 sm:hidden"
            data-testid={`${testid}-branch-select`}
          >
            <option value="">{group === "all" ? "All Branches" : `All ${group === "online" ? "Online" : "Offline"} Branches`}</option>
            {visible.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
          </select>
          <div className="hidden flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:flex">
            {visible.map((b) => (
              <button
                key={b.branch_id}
                type="button"
                onClick={() => onBranch(branchId === b.branch_id ? "" : b.branch_id)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  branchId === b.branch_id ? "bg-sky-600 text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                }`}
                data-testid={`${testid}-branch-${b.branch_id}`}
              >
                <Building2 className="h-3.5 w-3.5" /> {b.branch_name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// A different colour per card rather than one hue for the whole tab — Marketing and Sales
// both arrive as a short list of counts (Total, Booked, then up to seven sources/stages),
// and every card in the same blue reads as one card split into pieces rather than several
// distinct things being compared. Cycled by position, same as BRANCH_INKS below.
const CARD_COLORS = ["#0284c7", "#7c3aed", "#059669", "#d97706", "#e11d48", "#0d9488", "#4f46e5", "#ea580c", "#0891b2", "#db2777"];

const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/**
 * Dashboard > Marketing — leads by channel: Instagram, Meta, and the rest, for whichever
 * branch/vertical group is picked. "Deliberately no money and no session/treatment
 * counts" per the endpoint's own docstring — this answers where a lead came from, and
 * Revenue is where what it turned into lives.
 */
const MarketingTab = ({ branches, dateFilter, scope }) => {
  const [ownGroup, setOwnGroup] = useState("all");
  const [ownBranchId, setOwnBranchId] = useState("");
  // The caller's toolbar scope when there is one, for the reason Revenue below gives.
  const group = scope ? scope.group : ownGroup;
  const branchId = scope ? scope.branchId : ownBranchId;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = {};
    if (dateFilter.from && dateFilter.to) { params.start_date = toIso(dateFilter.from); params.end_date = toIso(dateFilter.to); }
    const branchIds = resolveBranchIds(branches, group, branchId);
    if (branchIds) params.branch_ids = branchIds;
    getLeadsAnalytics(params)
      .then(setData)
      .catch(() => { toast.error("Failed to load Marketing"); setData(null); })
      .finally(() => setLoading(false));
  }, [branches, group, branchId, dateFilter]);

  return (
    <div className="space-y-4" data-testid="dashboard-marketing-tab">
      {!scope && (
        <ModeBranchFilter branches={branches} group={group} onGroup={setOwnGroup} branchId={branchId} onBranch={setOwnBranchId} testid="dashboard-marketing-filter" />
      )}
      {loading || !data ? (
        <p className="py-16 text-center text-sm text-slate-400">{loading ? "Loading..." : "No data."}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="dashboard-marketing-cards">
          <StatTile label="Total Leads" value={(data.total || 0).toLocaleString("en-IN")} icon={Users} color={CARD_COLORS[0]} testid="dashboard-marketing-total" />
          <StatTile label="Booked" value={(data.booked || 0).toLocaleString("en-IN")} icon={CalendarCheck} color={CARD_COLORS[1]} testid="dashboard-marketing-booked" />
          {(data.by_source || []).map((s, i) => (
            <StatTile key={s.name} label={s.name} value={(s.value || 0).toLocaleString("en-IN")} icon={Megaphone} color={CARD_COLORS[(i + 2) % CARD_COLORS.length]} testid={`dashboard-marketing-source-${slugify(s.name)}`} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Dashboard > Sales — the same call as Marketing, read as a funnel instead of a channel
 * list: how many leads sit in each Pre-Sales stage right now, for whichever branch/vertical
 * group is picked.
 */
const SalesTab = ({ branches, dateFilter, scope }) => {
  const [ownGroup, setOwnGroup] = useState("all");
  const [ownBranchId, setOwnBranchId] = useState("");
  const group = scope ? scope.group : ownGroup;
  const branchId = scope ? scope.branchId : ownBranchId;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = {};
    if (dateFilter.from && dateFilter.to) { params.start_date = toIso(dateFilter.from); params.end_date = toIso(dateFilter.to); }
    const branchIds = resolveBranchIds(branches, group, branchId);
    if (branchIds) params.branch_ids = branchIds;
    getLeadsAnalytics(params)
      .then(setData)
      .catch(() => { toast.error("Failed to load Sales"); setData(null); })
      .finally(() => setLoading(false));
  }, [branches, group, branchId, dateFilter]);

  return (
    <div className="space-y-4" data-testid="dashboard-sales-tab">
      {!scope && (
        <ModeBranchFilter branches={branches} group={group} onGroup={setOwnGroup} branchId={branchId} onBranch={setOwnBranchId} testid="dashboard-sales-filter" />
      )}
      {loading || !data ? (
        <p className="py-16 text-center text-sm text-slate-400">{loading ? "Loading..." : "No data."}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="dashboard-sales-cards">
          <StatTile label="Total Leads" value={(data.total || 0).toLocaleString("en-IN")} icon={Users} color={CARD_COLORS[0]} testid="dashboard-sales-total" />
          <StatTile label="Booked" value={(data.booked || 0).toLocaleString("en-IN")} icon={CalendarCheck} color={CARD_COLORS[1]} testid="dashboard-sales-booked" />
          {(data.by_stage || []).map((s, i) => (
            <StatTile key={s.name} label={s.name} value={(s.value || 0).toLocaleString("en-IN")} icon={Headphones} color={CARD_COLORS[(i + 2) % CARD_COLORS.length]} testid={`dashboard-sales-stage-${slugify(s.name)}`} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Dashboard > Revenue — the full money breakdown (RevenueSummaryCards) from
 * /finance/revenue-overview, shown by default for the whole business and narrowed by the
 * same All/Offline/Online chips and branch pick as every other tab.
 */
const RevenueTab = ({ data, loading, dateFilter, scope }) => {
  const [ownGroup, setOwnGroup] = useState("all");
  const [ownBranchId, setOwnBranchId] = useState("");
  // The scope is the caller's whenever the caller carries one. Both boards that mount
  // these tabs -- Super Admin's and the Business Development desk's -- hand down the
  // branch popover already on their toolbar, and the chip row is left off rather than
  // drawn a second time under it saying the same thing.
  const group = scope ? scope.group : ownGroup;
  const branchId = scope ? scope.branchId : ownBranchId;
  const branches = data?.leads?.branches || [];
  const selectedBranch = branches.find((b) => b.branch_id === branchId);

  if (loading || !data) {
    return <p className="py-16 text-center text-sm text-slate-400">{loading ? "Loading..." : "No data."}</p>;
  }

  return (
    <div className="space-y-4" data-testid="dashboard-revenue-tab">
      {!scope && (
        <ModeBranchFilter branches={branches} group={group} onGroup={setOwnGroup} branchId={branchId} onBranch={setOwnBranchId} testid="dashboard-revenue-filter" />
      )}
      <RevenueSummaryCards branch={selectedBranch} group={group} dateFilter={dateFilter} />
    </div>
  );
};

/**
 * Dashboard > Team — everyone who works here, then the two rosters that carry a
 * conversion rate (Pre-Sales, and the branch accounts themselves), scoped by the same
 * All/Offline/Online filter rather than one branch at a time — "the teams across all
 * online offline" in one screen instead of picked one branch at a time.
 *
 * The roster goes first because it is the wider question: the two panels below it measure
 * two desks, and every other person on the payroll — consultants, physios, nutritionists,
 * HR, Finance — is only on this tab because the roster lists them.
 */
const TeamTab = ({ team, loading, branches, roster, rosterLoading, scope }) => {
  const [ownGroup, setOwnGroup] = useState("all");
  const [ownBranchId, setOwnBranchId] = useState("");
  // Same arrangement as Revenue above: the filter belongs to whoever drew it.
  const group = scope ? scope.group : ownGroup;
  const branchId = scope ? scope.branchId : ownBranchId;
  // And the same for the name search. The roster and the two panels are three lists of
  // people on one tab, so one box narrows all three -- typing a name into a toolbar and
  // having it reach only the middle card would be the box being wrong twice. A scope with
  // no `search` (Super Admin's toolbar has no box) leaves the roster drawing its own.
  const q = (scope?.search || "").trim().toLowerCase();

  if (loading || !team) {
    return <p className="py-16 text-center text-sm text-slate-400">{loading ? "Loading..." : "No data."}</p>;
  }

  const scopedMembers = (members) => {
    const named = q
      ? members.filter((m) => `${m.full_name || ""} ${m.name || ""} ${m.email || ""} ${m.branch_name || ""}`.toLowerCase().includes(q))
      : members;
    if (branchId) return named.filter((m) => m.branch_id === branchId);
    if (group === "all") return named;
    const ids = new Set(branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online")).map((b) => b.branch_id));
    return named.filter((m) => ids.has(m.branch_id));
  };

  const preSalesMembers = team.pre_sales || [];
  const branchMembers = team.sales || [];
  const scopeLabel = branchId
    ? branches.find((b) => b.branch_id === branchId)?.branch_name
    : group === "all" ? null : (group === "online" ? "Online" : "Offline");

  // Which branches the roster draws a section for — the same filter the cards below read,
  // applied to branches rather than to people, because the roster is grouped by branch.
  const visibleBranches = branchId
    ? branches.filter((b) => b.branch_id === branchId)
    : group === "all"
      ? branches
      : branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online"));

  return (
    <div className="space-y-4" data-testid="dashboard-team-tab">
      {!scope && (
        <ModeBranchFilter branches={branches} group={group} onGroup={setOwnGroup} branchId={branchId} onBranch={setOwnBranchId} testid="dashboard-team-filter" />
      )}

      {/* showUnposted only under All: an accountant is posted to no branch, so keeping
          them on screen while the filter says Online or Anna Nagar would be the filter
          silently not applying to the one section it cannot describe. */}
      <StaffRoster
        users={roster?.users}
        employees={roster?.employees}
        loading={rosterLoading}
        branches={branches}
        visibleBranches={visibleBranches}
        showUnposted={!branchId && group === "all"}
        search={scope?.search}
      />

      {/* No benchmarkFrom, so the average follows the filter — narrowed to one branch or
          one mode, its agents are measured against each other, the peers actually doing
          the same job in the same place. */}
      <TeamCard
        title={TEAM_PANELS.pre_sales.title}
        subtitle={scopeLabel ? `${scopeLabel} · ${TEAM_PANELS.pre_sales.subtitle}` : TEAM_PANELS.pre_sales.subtitle}
        members={scopedMembers(preSalesMembers)}
        kind="pre_sales"
      />

      {/* benchmarkFrom is every branch account, even when the filter narrows the list — a
          branch's peers are the other branches, so measuring it against only itself or its
          own mode would hand it a delta of zero the moment the filter was applied. */}
      <TeamCard
        title={TEAM_PANELS.branch.title}
        subtitle={scopeLabel ? `${scopeLabel} · ${TEAM_PANELS.branch.subtitle}` : TEAM_PANELS.branch.subtitle}
        members={scopedMembers(branchMembers)}
        benchmarkFrom={branchMembers}
        kind="branch"
      />
    </div>
  );
};

/**
 * The three payloads the six tabs below read, and when each of them is asked for.
 *
 * Lifted out of the board so a second desk can mount the same six tabs without a second
 * copy of the fetching — see BusinessLeadsDashboard's Dashboard tab, which puts them on
 * its own strip beside OnBoarding and systematic statistics. A figure reads the same on
 * both boards because it is literally this request answering both, which is the only
 * reason somebody who reads both can trust either.
 *
 * `enabled` is for that second caller. Its strip opens on a tab of its own — OnBoarding,
 * which reads none of this — and the overview is a wide request to pay for before anybody
 * has asked for a tab that needs it. Super Admin's own board passes nothing and so fetches
 * on mount, exactly as it always has.
 */
export const useDashboardData = (dateFilter, activeTab, enabled = true) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [team, setTeam] = useState(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [roster, setRoster] = useState(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  // A named loader rather than the fetch inline in the effect, so Refresh has something to
  // call — the effect still owns when it runs on a date change.
  const loadOverview = useCallback(() => {
    setLoading(true);
    // No dates on All — the endpoint reads that as unfiltered.
    const params = dateFilter?.from && dateFilter?.to
      ? { start_date: toIso(dateFilter.from), end_date: toIso(dateFilter.to) }
      : {};
    return getDashboardOverview(params)
      .then(setData)
      .catch(() => toast.error("Failed to load dashboard"))
      .finally(() => setLoading(false));
  }, [dateFilter]);

  useEffect(() => { if (enabled) loadOverview(); }, [enabled, loadOverview]);

  // Fetched once, on the first visit to Team, and not refetched when the date range
  // changes — /marketing/team-members counts a person's whole book and takes no dates.
  // Refetching on every range change would burn a request to return the same numbers, and
  // would imply the figures answer to the filter when they don't.
  useEffect(() => {
    if (activeTab !== "team" || team || teamLoading) return;
    setTeamLoading(true);
    mkGetTeam()
      .then(setTeam)
      .catch(() => { toast.error("Failed to load the team"); setTeam({ pre_sales: [], sales: [] }); })
      .finally(() => setTeamLoading(false));
  }, [activeTab, team, teamLoading]);

  // The staff roster, fetched on the same terms and for the same reason: an account and an
  // employee record are lists of people, not of anything that happened between two dates,
  // so both are fetched once on the first visit to Team and left alone.
  //
  // Both halves settle together, and a failure in either leaves an empty list rather than
  // a half-drawn roster claiming to be the whole company. hrMeta rides along only for the
  // colours a custom role was given — the roster renders roles the built-in map does not
  // name, and without it they would wear the neutral fallback. Its own failure costs a hue
  // and nothing else, so it is swallowed.
  useEffect(() => {
    if (activeTab !== "team" || roster || rosterLoading) return;
    setRosterLoading(true);
    hrMeta().then((m) => setCustomRoleClasses(m?.custom_roles)).catch(() => {});
    Promise.all([hrUsers(), hrEmployees({ status: "active" })])
      .then(([users, employees]) => setRoster({
        users: Array.isArray(users) ? users : [],
        employees: Array.isArray(employees) ? employees : [],
      }))
      .catch(() => { toast.error("Failed to load the staff roster"); setRoster({ users: [], employees: [] }); })
      .finally(() => setRosterLoading(false));
  }, [activeTab, roster, rosterLoading]);

  // Every branch, offline or online — the roster Marketing/Sales/Revenue/Team's filter
  // picks from. Read off the leads bucket, but any bucket would do; they all carry the
  // same branch list.
  //
  // Memoised because four of the six tabs name it in an effect's dependency list: rebuilt
  // as a fresh `[]` on every render, a board whose overview had not landed yet would
  // re-ask the analytics endpoint each time its parent redrew.
  const branches = useMemo(() => data?.leads?.branches || [], [data]);

  // Super Admin's Refresh: the overview, and the two Team payloads dropped so they are
  // asked for again -- now if Team is open, otherwise on the next visit. The once-only rule
  // above is about a date change, which cannot move them; a press of Refresh is somebody
  // asking whether anything has.
  const reload = useCallback(() => {
    setTeam(null);
    setRoster(null);
    return loadOverview();
  }, [loadOverview]);

  return { data, loading, team, teamLoading, roster, rosterLoading, branches, loadOverview, reload };
};

/**
 * Whichever of the six is open, drawn — and nothing else: no date row, no tab strip.
 *
 * Those two live with whoever mounts this, because the two boards that do put them in
 * different places. Super Admin keeps its range on a row of its own above the strip; the
 * Business Development desk folds both into the two navigation bars its Dashboard already
 * carries.
 */
export const DashboardTabPanel = ({ tab, dateFilter, dash, scope }) => {
  const { data, loading, team, teamLoading, roster, rosterLoading, branches } = dash;
  return tab === "marketing" ? (
    <MarketingTab branches={branches} dateFilter={dateFilter} scope={scope} />
  ) : tab === "sales" ? (
    <SalesTab branches={branches} dateFilter={dateFilter} scope={scope} />
  ) : tab === "revenue" ? (
    <RevenueTab data={data} loading={loading} dateFilter={dateFilter} scope={scope} />
  ) : tab === "team" ? (
    <TeamTab team={team} loading={teamLoading} branches={branches} roster={roster} rosterLoading={rosterLoading} scope={scope} />
  ) : tab === "clients" ? (
    <ClientsTab branches={branches} scope={scope} />
  ) : (
    <AnalyticsTab data={data} dateFilter={dateFilter} scope={scope} />
  );
};

// Super Admin's default landing page — Marketing / Sales / Revenue / Team / Clients /
// Analytics, each scoped by the one toolbar row above them: a date range, All/Offline/
// Online, a branch, and Refresh.
export const DashboardBoard = () => {
  const [dateFilter, setDateFilter] = useState(defaultFilter);
  const [activeTab, setActiveTab] = useState("marketing");
  // The branch scope, held here rather than inside each tab, so it is drawn once on the
  // toolbar and means the same thing on all six -- Anna Nagar picked on Marketing is still
  // Anna Nagar on Revenue. It used to be a chip row of its own under the tab strip, drawn
  // afresh (and reset to All) by every tab.
  const [group, setGroup] = useState("all");
  const [branchId, setBranchId] = useState("");
  // Bumped by Refresh, and the open tab's key: remounting it re-asks for whatever that tab
  // fetches for itself (Marketing and Sales' counts, Clients, the Analytics charts), which
  // reloading the overview alone never reached.
  const [reloadKey, setReloadKey] = useState(0);
  const dash = useDashboardData(dateFilter, activeTab);
  const { loading, branches, reload } = dash;

  // No `search`: this toolbar has no box, so Team and Clients keep their own.
  const scope = useMemo(() => ({ group, onGroup: setGroup, branchId, onBranch: setBranchId }), [group, branchId]);

  const refresh = () => {
    reload();
    setReloadKey((k) => k + 1);
  };

  return (
    // No title block. The tab above already reads Dashboard, and the strapline named the
    // five tabs sitting right below it.
    <div className="space-y-4" data-testid="dashboard-board">
      {/* One toolbar row, read left to right: which dates, which side of the business,
          which branch, then Refresh held to the far right. On a phone the six ranges
          take the first line and the rest wrap onto a second. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="dashboard-toolbar">
        {/* Five one-tap ranges, then Custom for everything else — the OS's shared date
            filter, which also carries Yesterday, Last Month and an exact day.

            Custom only shows a label when the range came from inside it. Picking Today or
            This Month in there sets the same key a button owns, so the button lights up
            and Custom goes back to reading "Custom" rather than the two of them naming the
            same range side by side.

            On a phone the six share their line edge to edge (flex-1) with short labels, so
            nothing sits off screen; min-w-0 + truncate is the fallback if a label ever
            doesn't fit. From sm up they keep their natural widths. */}
        <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:gap-2" data-testid="dashboard-date-filter">
          {DASH_PRESETS.map((p) => {
            const active = dateFilter.key === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setDateFilter(presetFilter(p))}
                className={`h-10 min-w-0 flex-1 truncate rounded-md px-1 text-[11px] font-medium transition sm:flex-none sm:px-3 sm:text-sm ${active ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                data-testid={`dashboard-preset-${p.key}`}
              >
                <span className="sm:hidden">{p.short}</span>
                <span className="hidden sm:inline">{p.label}</span>
              </button>
            );
          })}
          {/* The trigger is a Button this component doesn't own, so its width, padding, text
              size and icon are pinned from out here rather than by adding breakpoint props
              to a control five other boards share. */}
          <span className="min-w-0 flex-1 sm:flex-none [&_button]:h-10 [&_button]:w-full [&_button]:justify-center [&_button]:px-1 [&_button]:text-[11px] [&_svg]:hidden sm:[&_button]:w-auto sm:[&_button]:px-4 sm:[&_button]:text-sm sm:[&_svg]:inline-block">
            <DateFilterPopover
              value={DASH_PRESETS.some((p) => p.key === dateFilter.key) ? null : dateFilter}
              onChange={(next) => setDateFilter(next || defaultFilter())}
              testid="dashboard-date-filter-popover"
              placeholder="Custom"
              centered
            />
          </span>
        </div>

        {/* All / Offline / Online, then the branch as a dropdown -- the Business
            Development desk's toolbar control, so seven branch chips no longer need a row
            of their own. */}
        <ModeBranchScope
          branches={branches}
          group={group}
          onGroup={setGroup}
          branchId={branchId}
          onBranch={setBranchId}
          testid="dashboard-scope"
        />

        <Button
          onClick={refresh}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="ml-auto h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="dashboard-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* The six tabs in the toolbar's own style: one button each, white and bordered,
          the open one filled sky. Two rows of three on a phone, where six in a row leaves
          each too narrow to read; natural widths from sm up, like the ranges above. */}
      <div className="grid grid-cols-3 gap-1 sm:flex sm:flex-wrap sm:gap-2" data-testid="dashboard-tab">
        {DASH_TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md px-1 text-[11px] font-medium transition sm:px-3 sm:text-sm ${active ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid={`dashboard-tab-${t.key}`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      <DashboardTabPanel key={reloadKey} tab={activeTab} dateFilter={dateFilter} dash={dash} scope={scope} />
    </div>
  );
};

/** "21 Aug 2026" off a stored date or timestamp; a dash rather than "Invalid Date". */
const shortDate = (value) => {
  if (!value) return "—";
  const d = new Date(String(value).length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * Dashboard > Clients — the two lists that are not a stage.
 *
 * Every other tab on this board reads a pipeline: how many arrived, how many booked, what
 * they were worth. These two are the leads somebody has marked by hand, and they cut across
 * all of it -- a starred client can be anywhere in the pipeline, and so can one something is
 * wrong with. That is why they are worth their own tab rather than a filter on somebody
 * else's list.
 *
 * A lead carrying both marks appears on both lists, because it is the row somebody wants to
 * find under either.
 */
const ClientsTab = ({ branches = [], scope }) => {
  const [view, setView] = useState("premium");
  const [data, setData] = useState({ premium: [], attention: [] });
  const [loading, setLoading] = useState(true);
  const [ownSearch, setOwnSearch] = useState("");
  // The toolbar's box when the caller carries one, this card's own otherwise -- and only
  // one of the two is ever drawn, so the list is never narrowed by a box nobody can see.
  // A scope without `search` is a toolbar with no box (Super Admin's), so the card keeps its own.
  const toolbarSearch = scope?.search !== undefined;
  const search = toolbarSearch ? scope.search : ownSearch;

  useEffect(() => {
    let live = true;
    setLoading(true);
    getDashboardClients()
      .then((res) => { if (live) setData({ premium: res?.premium || [], attention: res?.attention || [] }); })
      .catch(() => { if (live) setData({ premium: [], attention: [] }); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const current = CLIENT_VIEWS.find((v) => v.key === view) || CLIENT_VIEWS[0];

  // The branch scope, applied here rather than at the endpoint. Both lists arrive in one
  // request for the whole estate and the two cards above count them, so re-asking the
  // server per branch would be a round trip to narrow rows already in hand -- and would
  // leave the counts answering a different question from the table under them.
  const scopedIds = scope ? resolveBranchIds(branches, scope.group, scope.branchId) : undefined;
  const idSet = scopedIds ? new Set(String(scopedIds).split(",")) : null;
  const scopedRows = (key) => {
    const all = data[key] || [];
    return idSet ? all.filter((r) => idSet.has(r.branch_id)) : all;
  };
  const rows = scopedRows(view);
  const q = search.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) => `${r.name} ${r.phone} ${r.email}`.toLowerCase().includes(q))
    : rows;

  return (
    <div className="space-y-4" data-testid="dashboard-clients">
      {/* The two counts as cards, and each one opens its own list -- a figure you cannot
          open is a figure somebody has to take on trust. */}
      <div className="grid grid-cols-2 gap-3">
        {CLIENT_VIEWS.map((v) => (
          <StatTile
            key={v.key}
            label={v.label}
            value={scopedRows(v.key).length}
            sub={v.sub}
            icon={v.icon}
            color={v.color}
            active={view === v.key}
            onClick={() => setView(v.key)}
            testid={`dashboard-clients-card-${v.key}`}
          />
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <current.icon className="h-4 w-4" style={{ color: current.color }} />
            {current.label}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{visible.length}</span>
          </p>
          {!toolbarSearch && (
            <div className="relative ml-auto min-w-0 flex-1 sm:max-w-xs">
              <Input
                value={search}
                onChange={(e) => setOwnSearch(e.target.value)}
                placeholder="Search name, phone or email..."
                className="h-9"
                data-testid="dashboard-clients-search"
              />
            </div>
          )}
        </div>

        {loading ? (
          <p className="px-4 py-12 text-center text-sm text-slate-400">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-slate-400" data-testid="dashboard-clients-empty">
            {rows.length === 0 ? current.empty : "Nobody matches that search."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] table-fixed text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-[4%] px-3 py-2.5">S.No</th>
                  <th className="w-[18%] px-3 py-2.5">Name</th>
                  <th className="w-[12%] px-3 py-2.5">Phone Number</th>
                  <th className="w-[18%] px-3 py-2.5">Mail</th>
                  <th className="w-[14%] px-3 py-2.5">Stage</th>
                  <th className="w-[14%] px-3 py-2.5">Assigned Physio</th>
                  <th className="w-[10%] px-3 py-2.5">Appointment</th>
                  <th className="w-[10%] px-3 py-2.5">Last Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r, i) => (
                  <tr key={r.id} className="align-top hover:bg-slate-50/60" data-testid={`dashboard-client-${r.id}`}>
                    <td className="px-3 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <p className="max-w-full truncate text-sm font-semibold leading-5 text-slate-800" title={r.name}>{r.name || "—"}</p>
                        {/* Which branch they belong to, under the name: these lists run
                            across every branch, so a row without one is a row somebody has
                            to go looking for. */}
                        {r.branch_name ? <p className="max-w-full truncate text-[11px] leading-4 text-slate-400">{r.branch_name}</p> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-slate-600">{r.phone || "—"}</td>
                    <td className="px-3 py-3 text-xs leading-5 text-slate-600">
                      <span className="block max-w-full truncate" title={r.email || ""}>{r.email || "—"}</span>
                    </td>
                    <td className="px-3 py-3">
                      {r.stage ? (
                        <span className="inline-block max-w-full truncate whitespace-nowrap rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold leading-4 text-slate-600" title={r.stage}>
                          {r.stage}
                        </span>
                      ) : <span className="text-xs leading-5 text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-slate-600">
                      <span className="block max-w-full truncate" title={r.assigned_physio_name || ""}>{r.assigned_physio_name || "—"}</span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <p className="text-xs leading-5 text-slate-600">{r.appointment_date ? shortDate(r.appointment_date) : "—"}</p>
                        {r.appointment_time ? <p className="text-[10px] leading-4 text-slate-400">{r.appointment_time}</p> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-slate-500">{r.updated_at ? shortDate(r.updated_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// Drives BranchGrowthTrend below — not a StatTile row, since it's a plain switch between
// four lines on one chart rather than four counts worth their own cards.
const GROWTH_METRICS = [
  { key: "leads", label: "Leads" },
  { key: "appointments", label: "Appointments" },
  { key: "treatments", label: "Treatments" },
  { key: "revenue", label: "Revenue", currency: true },
];

/**
 * Dashboard > Analytics — the "Power BI" view: charts, not cards. LeadsAnalyticsDashboard
 * is the same one Marketing Master View's own Analytics tab already gives (funnel, source/
 * vertical donuts, booking rate by source, leads by branch and by weekday, and — the "team
 * wise pre sales" ask — leads per owner), scoped by the same All/Offline/Online + branch
 * filter every other tab uses. Underneath it, the six-month branch-by-branch growth trend
 * this board has always drawn, for the one thing the donuts/bars above don't show: a
 * branch's line over time against the others'.
 */
const AnalyticsTab = ({ data, dateFilter, scope }) => {
  const [ownGroup, setOwnGroup] = useState("all");
  const [ownBranchId, setOwnBranchId] = useState("");
  const [trendMetric, setTrendMetric] = useState("leads");
  // The caller's scope when there is one, for the reason Revenue above gives.
  const group = scope ? scope.group : ownGroup;
  const branchId = scope ? scope.branchId : ownBranchId;

  const branches = data?.leads?.branches || [];
  // Through resolveBranchIds, the same resolution Marketing, Sales, Revenue and Team all
  // use. This tab had its own copy of the filter and it disagreed on the one case that
  // matters: a group holding no branches resolved to [], which the endpoint reads as no
  // filter at all -- so picking Online with no online branches showed the whole company
  // here while every other tab correctly showed nothing. Split as a string and back
  // because that helper speaks the endpoint's comma-separated param and the dashboard
  // below takes a list.
  const ids = resolveBranchIds(branches, group, branchId);
  const scopedBranchIds = ids ? String(ids).split(",") : undefined;

  const activeMetric = GROWTH_METRICS.find((m) => m.key === trendMetric) || GROWTH_METRICS[0];

  return (
    <div className="space-y-4" data-testid="dashboard-analytics-tab">
      {!scope && (
        <ModeBranchFilter branches={branches} group={group} onGroup={setOwnGroup} branchId={branchId} onBranch={setOwnBranchId} testid="dashboard-analytics-filter" />
      )}

      <LeadsAnalyticsDashboard
        startDate={dateFilter?.from ? toIso(dateFilter.from) : undefined}
        endDate={dateFilter?.to ? toIso(dateFilter.to) : undefined}
        branchIds={scopedBranchIds}
      />

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Branch-wise growth</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {GROWTH_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setTrendMetric(m.key)}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                trendMetric === m.key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
              }`}
              data-testid={`dashboard-growth-metric-${m.key}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <BranchGrowthTrend metric={activeMetric} highlightBranch={branchId || null} />
      </div>
    </div>
  );
};

/**
 * The trend payload, fetched once and shared.
 *
 * Both charts read the same six months, and both redraw on a metric change rather than
 * refetching — the response already carries all four series, so a request per selection
 * would be four round trips for data already in hand.
 */
const useTrendData = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getDashboardLeadsTrend(6)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { data, loading };
};

/** The selected metric's series for one branch, falling back to the legacy `values` row
 *  so an older payload without `series` still draws its leads line. */
const branchSeries = (b, metricKey) => b.series?.[metricKey] || (metricKey === "leads" ? b.values : null) || [];

/**
 * The drawing width, measured rather than assumed.
 *
 * A fixed viewBox with a fixed height scales to whichever axis runs out first, and on a
 * wide card that is the height — so the plot was drawn at its natural ratio and centred,
 * leaving a margin down each side. Measuring lets the viewBox be the real pixel box: the
 * chart fills the card, and strokes, text and circles stay the size they are declared
 * instead of being scaled along with the geometry.
 */
const useMeasuredWidth = (fallback = 720) => {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setWidth(Math.max(320, Math.round(el.clientWidth)));
    apply();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", apply);
      return () => window.removeEventListener("resize", apply);
    }
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
};

/**
 * A Catmull-Rom spline written out as cubic béziers — the curved line the design asks for.
 *
 * Worth knowing what a curve costs: between two months it bows above or below the straight
 * path, so the ink between readings suggests values that were never measured, and a series
 * that touches zero can dip visually below it. The readings themselves stay exact, which
 * is why every point is also marked and printed in the readout.
 */
const smoothPath = (pts) => {
  if (!pts.length) return "";
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"} ${p[0]},${p[1]}`).join(" ");
  const t = 0.2; // Low tension: enough to read as a curve, not enough to loop or overshoot far.
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d += ` C ${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t}`
      + ` ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t}`
      + ` ${p2[0]},${p2[1]}`;
  }
  return d;
};

/** The axis ceiling: a 1 / 2 / 5 × power-of-ten step, topped out at a multiple of it
 *  rather than at the data. Scaling straight to the peak would leave the highest reading
 *  sitting on the frame with no room above it. */
const axisFor = (peakValue) => {
  const peak = Math.max(1, peakValue);
  const raw = peak / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  return { axisMax: step * Math.ceil(peak / step) };
};

const monthLabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString("en-US", { month: "short" });

// Greyscale, darkest first — the reference design's own scheme. Branch identity rests on
// the legend and the hover readout rather than on hue, which is what makes a monochrome
// ramp safe here: four greys are not reliably tellable apart on their own.
const BRANCH_INKS = ["#18181b", "#52525b", "#a1a1aa", "#d4d4d8", "#71717a", "#3f3f46"];

/**
 * Six months split by branch — which branch is moving, and how they sit against each
 * other. Draws whichever metric is selected on the cards above.
 */
const BranchGrowthTrend = ({ metric, highlightBranch }) => {
  const { data, loading } = useTrendData();
  const [hoverIdx, setHoverIdx] = useState(null);
  const [wrapRef, W] = useMeasuredWidth();

  if (loading) return <Card><CardContent className="p-5"><p className="py-10 text-center text-sm text-slate-400">Loading growth…</p></CardContent></Card>;
  if (!data || !data.months?.length) return null;

  // A selected branch is highlighted rather than filtered to: dropping the other lines
  // would lose the very thing this chart is for, which is where that branch sits against
  // them.
  const series = (data.branches || []).map((b, i) => ({
    ...b,
    color: BRANCH_INKS[i % BRANCH_INKS.length],
    points: branchSeries(b, metric.key),
    faded: !!highlightBranch && b.branch_id !== highlightBranch,
  }));
  if (!series.length) return null;

  const { axisMax } = axisFor(Math.max(0, ...series.flatMap((s) => s.points)));

  const H = 300;
  const PAD_L = 18;
  const PAD_R = 18;
  // Headroom at the top and a little under the baseline, because a curve bows past its
  // own points — without it the highest peak clips against the frame.
  const PAD_T = 24;
  const PAD_B = 34;
  const plotW = Math.max(1, W - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const x = (i) => PAD_L + (data.months.length === 1 ? plotW / 2 : (i / (data.months.length - 1)) * plotW);
  const y = (v) => PAD_T + plotH - (v / axisMax) * plotH;

  const readout = (v) => (metric.currency ? fmtValue("revenue", v) : v.toLocaleString("en-IN"));

  return (
    <Card data-testid="dashboard-branch-growth">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-bold text-slate-800">OverAll Growth</p>
          <p className="text-[11px] text-slate-400">{metric.label} by branch · last 6 months</p>
        </div>

        {/* Legend always. Four greys cannot be told apart by eye, so identity rests here
            and in the readout — the swatch only ties a name to a line already labelled. */}
        <div className="mb-2 flex flex-wrap justify-center gap-x-8 gap-y-2">
          {series.map((s) => (
            <span key={s.branch_id} className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wide ${s.faded ? "text-slate-400" : "text-slate-700"}`}>
              <span className="h-3 w-3 shrink-0 rounded-[2px]" style={{ background: s.color, opacity: s.faded ? 0.35 : 1 }} />
              {s.branch_name}
            </span>
          ))}
        </div>

        {/* No bands and no gridlines — a single hairline baseline, as the design has it.
            Nothing is left on the chart to read a value off, which is what the permanent
            markers and the readout below are for. */}
        <div ref={wrapRef}>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric.label} per branch over the last six months`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} stroke="#e4e4e7" strokeWidth="1" />

            {data.months.map((k, i) => (
              <text key={k} x={x(i)} y={H - 12} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 11 }}>
                {monthLabel(k)}
              </text>
            ))}

            {hoverIdx !== null && (
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD_T} y2={y(0)} stroke="#e4e4e7" strokeWidth="1" />
            )}

            {/* Faded lines first, so the highlighted one is drawn over them rather than
                under whichever branch happens to come later in the payload. */}
            {[...series].sort((a, b) => Number(b.faded) - Number(a.faded)).map((s) => (
              <path
                key={s.branch_id}
                fill="none"
                stroke={s.color}
                strokeWidth={s.faded ? 1.5 : 2.25}
                strokeOpacity={s.faded ? 0.25 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
                d={smoothPath(s.points.map((v, i) => [x(i), y(v || 0)]))}
              />
            ))}

            {/* Every reading marked, always. The curve between them is interpolation; these
                are the only places on the chart where the ink is a measurement. */}
            {[...series].sort((a, b) => Number(b.faded) - Number(a.faded)).map((s) => (
              s.points.map((v, i) => (
                <circle
                  key={`${s.branch_id}-${i}`}
                  cx={x(i)}
                  cy={y(v || 0)}
                  r={hoverIdx === i && !s.faded ? 5 : 3.5}
                  fill={s.color}
                  fillOpacity={s.faded ? 0.25 : 1}
                />
              ))
            ))}

            {data.months.map((k, i) => (
              <rect
                key={k}
                x={x(i) - plotW / Math.max(1, data.months.length - 1) / 2}
                y={PAD_T}
                width={plotW / Math.max(1, data.months.length - 1)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              />
            ))}
          </svg>
        </div>

        <div className="mt-2 min-h-[20px] text-[11px] text-slate-500">
          {hoverIdx !== null && (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span className="font-semibold text-slate-700">{monthLabel(data.months[hoverIdx])} {data.months[hoverIdx].slice(0, 4)}</span>
              {series.map((s) => (
                <span key={s.branch_id}>
                  <span className="inline-block h-2 w-2 rounded-sm align-middle" style={{ background: s.color }} />{" "}
                  {s.branch_name} <b className="text-slate-700">{readout(s.points[hoverIdx] || 0)}</b>
                </span>
              ))}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};


const money = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const amt = (v) => Number(v) || 0;

/** Still owed on a Partial Payment plan. A row already collected is history; counting it
    would make this a total of the plan rather than of what is still to come. */
export const unpaidSchedule = (schedule = []) => schedule.filter((s) => s.status !== "paid");

/**
 * Clients with nothing left owing, rolled up from their own transactions — the same cut
 * Accountant Manage's Payment Paid makes.
 *
 * Store sales are excluded outright rather than merely carrying no lead: a counter sale
 * that ever gained one would otherwise be credited to whoever it landed beside.
 */
export const paidByLead = (transactions = [], outstanding = []) => {
  const owing = new Set(outstanding.map((o) => o.lead_id));
  const out = {};
  transactions.forEach((t) => {
    if (t.source === "store" || !t.lead_id || owing.has(t.lead_id)) return;
    out[t.lead_id] = (out[t.lead_id] || 0) + amt(t.gross);
  });
  return out;
};

/** Billed, and nothing collected at all — what separates this from Outstanding Amount's
    part-payers, who have paid something and still owe the rest. */
export const fullyUnpaid = (outstanding = []) =>
  outstanding.filter((o) => amt(o.paid_amount) <= 0 && amt(o.balance) > 0);

/**
 * The Revenue tab's cards — one branch's money when a branch is picked, otherwise the
 * whole business (or its Online/Offline half).
 *
 * Every figure comes from /finance/revenue-overview scoped to this branch — the same
 * payload Accountant Manage reads — so a branch's numbers here and on that board cannot
 * disagree. Derived the same way too: Payment Paid and Payment Unpaid are the roll-ups
 * that board performs, not second definitions written for this screen.
 *
 * What used to open here was the lead breakdown: who booked, which physio saw them. That
 * is the Pre Sales and BRANCHS question, and on a tab named Revenue it answered one
 * nobody had asked.
 */
const RevenueSummaryCards = ({ branch, group = "all", dateFilter }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = {};
    if (branch) params.branch_id = branch.branch_id;
    else if (group !== "all") params.vertical_mode = group;
    if (dateFilter?.from && dateFilter?.to) {
      params.start_date = toIso(dateFilter.from);
      params.end_date = toIso(dateFilter.to);
    }
    getRevenueOverview(params)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [branch?.branch_id, group, dateFilter]);

  const b = data?.breakdown || {};
  const transactions = data?.transactions || [];
  const outstanding = data?.outstanding_clients || [];
  const schedule = data?.payment_schedule || [];

  const outstandingTotal = outstanding.reduce((s, c) => s + amt(c.balance), 0);

  const scheduleUnpaid = unpaidSchedule(schedule);
  const scheduleTotal = scheduleUnpaid.reduce((s, r) => s + amt(r.amount), 0);

  const paid = paidByLead(transactions, outstanding);
  const paidTotal = Object.values(paid).reduce((s, v) => s + v, 0);

  const unpaidClients = fullyUnpaid(outstanding);
  const unpaidTotal = unpaidClients.reduce((s, c) => s + amt(c.balance), 0);

  const cards = [
    { key: "total", label: "Total Revenue", value: money(data?.kpis?.total_collected), sub: `${transactions.length} transactions`, color: "#059669", icon: Wallet },
    { key: "consultation", label: "Consultations Revenue", value: money(b.consultation_revenue), sub: `${b.consultation_pct || 0}% of total`, color: "#0284c7", icon: Stethoscope },
    { key: "session", label: "Sessions Revenue", value: money(b.session_revenue), sub: `${b.session_pct || 0}% of total`, color: "#7c3aed", icon: Activity },
    { key: "diet", label: "Diet Collections", value: money(b.diet_revenue), sub: `${b.diet_pct || 0}% of total`, color: "#ea580c", icon: Salad },
    { key: "store", label: "Store Payment", value: money(b.store_revenue), sub: `${transactions.filter((t) => t.source === "store").length} sales`, color: "#0d9488", icon: ShoppingBag },
    // Beside the other shelves rather than up with the org-wide figures: what a Zumba class
    // or a Rehab course took is a question about one branch, and the row above answers for
    // the whole company. Both were already inside its Total Revenue -- this names them.
    { key: "zumba", label: "Zumba Revenue", value: money(b.zumba_revenue), sub: `${b.zumba_pct || 0}% of total`, color: "#c026d3", icon: Music },
    { key: "rehab", label: "Rehab Revenue", value: money(b.rehab_revenue), sub: `${b.rehab_pct || 0}% of total`, color: "#0891b2", icon: HeartPulse },
    { key: "outstanding", label: "Outstanding Amount", value: money(outstandingTotal), sub: `${outstanding.length} ${outstanding.length === 1 ? "client" : "clients"}`, color: "#d97706", icon: AlertCircle },
    { key: "schedules", label: "Payment Schedules", value: money(scheduleTotal), sub: `${scheduleUnpaid.length} still due`, color: "#4f46e5", icon: CalendarClock },
    { key: "paid", label: "Payment Paid", value: money(paidTotal), sub: `${Object.keys(paid).length} settled`, color: "#059669", icon: CheckCircle2 },
    { key: "unpaid", label: "Payment Unpaid", value: money(unpaidTotal), sub: `${unpaidClients.length} ${unpaidClients.length === 1 ? "client" : "clients"}`, color: "#e11d48", icon: XCircle },
  ];

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4" data-testid="branch-revenue-cards">
      <div className="mb-3">
        <p className="text-sm font-bold text-sky-700">
          {branch ? branch.branch_name : group === "online" ? "Online Branches" : group === "offline" ? "Offline Branches" : "All Branches"}{" "}
          <span className="font-normal text-slate-400">{dateFilter?.label || "All"}</span>
        </p>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading...</p>
      ) : !data ? (
        <p className="py-8 text-center text-sm text-slate-400">Couldn't load this branch's transactions.</p>
      ) : (
        <div className="space-y-3">
          {[cards.slice(0, 6), cards.slice(6)].map((row, i) => (
            <div
              key={i}
              className={`grid gap-3 grid-cols-2 sm:grid-cols-3 ${i === 0 ? "lg:grid-cols-6" : "lg:grid-cols-5"}`}
              data-testid={`branch-revenue-row-${i + 1}`}
            >
              {row.map((c) => (
                <StatTile key={c.key} label={c.label} value={c.value} sub={c.sub} icon={c.icon} color={c.color} testid={`branch-revenue-${c.key}`} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
