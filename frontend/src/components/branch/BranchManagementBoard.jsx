import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Pencil, Trash2, Archive, ArchiveRestore, X, Users, MapPin, Phone, Mail, RefreshCw, Layers, LayoutDashboard, ChevronDown, ChevronUp, BadgeIndianRupee, BarChart3, CalendarDays, Workflow, Building2, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  bmList, bmCreateWithExistingAdmin, bmReassignAdmin,
  updateBranch, hrBranchAdminCandidates,
  getVerticals, createVertical, deleteVertical, getDoctors,
  getDashboardOverview, bmListArchived, bmArchiveBranch, bmRestoreBranch, bmDeleteArchivedBranch,
} from "@/lib/api";
import { MilkDateInput } from "@/components/ui/milk-calendar";
// Shared with the branch form's Vertical picker, so a service type is the same colour and
// the same wording on both screens — they open a click apart from this board's toolbar.
import { serviceTypeColor, serviceTypeLabel, serviceTypeChipStyle } from "@/lib/serviceTypes";
import { BranchDetailPage } from "@/components/branch/BranchDetailPage";
import { BranchFormDialogV2 } from "@/components/branch/BranchFormDialogV2";
import { BranchAdminBoard } from "@/components/BranchAdminBoard";
import { HeadPhysioBoard } from "@/components/HeadPhysioBoard";
import { PhysioBoard } from "@/components/PhysioBoard";
import { AccountantManagementBoard } from "@/components/branch/AccountantManagementBoard";

// Every default vertical is named "online_..."/"offline_..." — read off that prefix
// rather than a separate stored field, so the tag on a card can never disagree with
// its actual vertical. Same helper as BranchFormDialogV2's own mode toggle.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// No Service Type tab. It is a setting, not a board — it was a tab holding one text field,
// and it now opens from MANAGER, the only tab that ever needs it.
const TABS = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "ac_overview", label: "Analytics", icon: BadgeIndianRupee },
  { key: "creation", label: "MANAGER", icon: Users },
  { key: "branch_control", label: "Branch Control", icon: LayoutDashboard },
];

/**
 * @param detailReadOnly  drill into a branch, but read-only. The Business Development
 *                        Executive's board mounts this panel as its own Branch Control
 *                        tab, and a branch's detail page reaches HR's account actions
 *                        (activate, deactivate, permanently delete a user) and its
 *                        payment settings -- neither of which is branch control, and
 *                        neither of which that role's token is allowed to call. Without
 *                        this the controls would be drawn and then 403 on press. Super
 *                        Admin's own mounts leave it off and keep the full page.
 */
export const BranchManagementBoard = ({ actingUser, onNavigateToOperations, initialTab = "overview", lockTab = false, detailReadOnly = false } = {}) => {
  const [tab, setTab] = useState(initialTab);
  const [drilledBranchId, setDrilledBranchId] = useState(null);
  // A callback ref, not useRef: the portal has to re-render once the node exists, and a
  // ref object mutating in place never triggers that.
  const [actionSlot, setActionSlot] = useState(null);

  if (drilledBranchId) {
    return <BranchDetailPage branchId={drilledBranchId} onBack={() => setDrilledBranchId(null)} readOnly={detailReadOnly} />;
  }

  return (
    <div className="space-y-5" data-testid="branch-mgmt-board">
      {/* No heading. The nav tab above already reads Branches & Verticals. */}
      {/* lockTab drops this whole row — Operations' own "Branch Manager" dialog opens
          straight on MANAGER and has nothing else here worth switching to, so the row
          would just be three dead tabs beside the one that matters. CreationTab's own
          fallback (no actionSlot to portal into) puts Refresh/Service Type/Archives/Add
          Branch inline on its own row instead of losing them along with the tab bar. */}
      {!lockTab && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="bm-subtabs">
          {/* A dropdown on a phone. Three tabs plus three actions wrapped to two rows, which
              left Accountant Management sharing a line with the buttons and reading as one
              of them. One select, and the actions keep the row's right end to themselves.

              The action slot stays a single node: it is a portal target, and a second copy
              for desktop would leave the ref pointing at whichever mounted last. */}
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 md:hidden"
            data-testid="bm-subtab-select"
          >
            {TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)} data-testid={`bm-subtab-${t.key}`} className={`hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition md:inline-flex ${active ? "bg-sky-50 text-sky-700" : "text-slate-600 hover:bg-slate-50"}`}>
                <Icon className="h-4 w-4" />{t.label}
              </button>
            );
          })}
          <div ref={setActionSlot} className="ml-auto flex shrink-0 items-center gap-2 pr-1" data-testid="bm-subtab-actions" />
        </div>
      )}
      {tab === "overview" && <OverviewTab />}
      {tab === "creation" && <CreationTab onDrillIn={setDrilledBranchId} actionSlot={actionSlot} onNavigateToOperations={onNavigateToOperations} />}
      {tab === "branch_control" && <BranchControlTab actingUser={actingUser} />}
      {tab === "ac_overview" && <AccountantManagementBoard />}
    </div>
  );
};

// ---------- Overview ----------

const OVERVIEW_DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "this_week", label: "This Week" },
  { key: "this_month", label: "This Month" },
  { key: "custom", label: "Custom" },
];

// Every card's number is one metric read off /dashboard/overview's buckets — each bucket
// already carries a per-branch and a per-vertical breakdown, currency ones just need
// formatting on the way out.
const OVERVIEW_METRICS = [
  { key: "leads", label: "All Leads" },
  { key: "appointments", label: "Appointment Booked" },
  { key: "consultations", label: "Consultations" },
  { key: "consultation_revenue", label: "Consultations Revenue", currency: true },
  { key: "sessions_booked", label: "Sessions Total Booked" },
  { key: "session_revenue", label: "Session Amount Collected", currency: true },
  // Not scoped to the date filter above on the backend — see the comment on
  // pending_bucket in v3_dashboard.py. Shown here anyway, since a card missing from this
  // row would read as "not tracked" rather than "always current".
  { key: "pending_session_amount", label: "Pending Session Amount", currency: true },
];

const overviewStartOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const overviewStartOfWeek = (d) => { const x = overviewStartOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; };
const overviewStartOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
// The reader's own calendar day, not UTC's. toISOString() converts before it formats, so
// local midnight on a +05:30 clock comes back as 18:30 the day BEFORE: "This Week" and
// "This Month" each opened a day early, and "Today" read as yesterday until 05:30 every
// morning. Built from the local getters instead, which is the day the clinic is asking
// about and the day /dashboard/overview now answers on.
const overviewToIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Same top-level split as MANAGER's own filter (All Branches / Offline / Online).
// Under it, a second row of one pill per branch in that group — same branches MANAGER
// lists, so a branch added there shows up here without anything else changing.
const OVERVIEW_GROUPS = [
  { key: "all", label: "All" },
  { key: "offline", label: "Offline" },
  { key: "online", label: "Online" },
];

/** A specific branch picked from the second row wins outright. Otherwise: the group's
 *  total (all branches in it summed) for Offline/Online, or the bucket's grand total for
 *  All. */
const overviewValueFor = (bucket, branchId, group) => {
  if (!bucket) return 0;
  const branches = bucket.branches || [];
  if (branchId) {
    const hit = branches.find((b) => b.branch_id === branchId);
    return hit ? hit.value : 0;
  }
  if (!group || group === "all") return bucket.total;
  return branches.filter((b) => isOnlineVertical(b.vertical) === (group === "online")).reduce((s, b) => s + b.value, 0);
};

/**
 * The landing tab for Branches & Verticals — leads through pending balance, for whichever
 * group or individual branch the two rows below the date filter pick, all fed by the one
 * /dashboard/overview call the main Dashboard already uses (same figures, same math, so
 * this tab and that one can never disagree about what a number means).
 */
const OverviewTab = () => {
  const [preset, setPreset] = useState("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState("all");
  const [branchId, setBranchId] = useState(""); // "" = the whole group, not one branch

  const { startDate, endDate } = useMemo(() => {
    const today = new Date();
    if (preset === "today") return { startDate: overviewToIso(today), endDate: overviewToIso(today) };
    if (preset === "this_week") return { startDate: overviewToIso(overviewStartOfWeek(today)), endDate: overviewToIso(today) };
    if (preset === "this_month") return { startDate: overviewToIso(overviewStartOfMonth(today)), endDate: overviewToIso(today) };
    return { startDate: customFrom, endDate: customTo };
  }, [preset, customFrom, customTo]);

  const load = useCallback(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    setLoading(true);
    getDashboardOverview({ start_date: startDate, end_date: endDate })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [startDate, endDate, preset, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  const selectGroup = (g) => { setGroup(g); setBranchId(""); };

  // Every branch under the selected group — all 7 under All, the 5 offline ones under
  // Offline, the 2 online ones under Online. Read off the leads bucket, but any bucket
  // would do; they all carry the same branch list.
  const branchList = data?.leads?.branches || [];
  const visibleBranches = group === "all" ? branchList : branchList.filter((b) => isOnlineVertical(b.vertical) === (group === "online"));

  const fmt = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

  return (
    <div className="space-y-4" data-testid="bm-overview-tab">
      {/* Date filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="bm-overview-date-filter">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {OVERVIEW_DATE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${preset === p.key ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
              data-testid={`bm-overview-preset-${p.key}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <CalendarDays className="h-3.5 w-3.5" />
            <MilkDateInput value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-slate-200 px-2 text-xs" data-testid="bm-overview-custom-from" />
            <span>to</span>
            <MilkDateInput value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-slate-200 px-2 text-xs" data-testid="bm-overview-custom-to" />
          </div>
        )}
      </div>

      {/* All / Offline / Online — same split as MANAGER's own filter */}
      <div className="flex flex-wrap items-center gap-2" data-testid="bm-overview-groups">
        {OVERVIEW_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => selectGroup(g.key)}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              group === g.key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
            }`}
            data-testid={`bm-overview-group-${g.key}`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* One pill per branch in the selected group — picking one drills into just that
          branch; the group pill above still stands for "all of them" when none is picked. */}
      {visibleBranches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="bm-overview-branches">
          {visibleBranches.map((b) => (
            <button
              key={b.branch_id}
              type="button"
              onClick={() => setBranchId((id) => (id === b.branch_id ? "" : b.branch_id))}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
                branchId === b.branch_id ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-500 hover:border-sky-300 hover:text-sky-600"
              }`}
              data-testid={`bm-overview-branch-${b.branch_id}`}
            >
              {b.branch_name}
            </button>
          ))}
        </div>
      )}

      {/* Summary metrics, for whichever branch (or the whole group) is selected */}
      {loading && !data ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="bm-overview-metrics">
          {OVERVIEW_METRICS.map((m) => {
            const value = overviewValueFor(data?.[m.key], branchId, group);
            return (
              <div key={m.key} className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3.5" data-testid={`bm-overview-metric-${m.key}`}>
                <span className="block truncate text-[11px] font-bold uppercase tracking-wider text-slate-500">{m.label}</span>
                <span className="mt-1 block text-3xl font-extrabold text-slate-800">{m.currency ? fmt(value) : value}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------- Branch Control (Super Admin driving a Branch Admin's own board) ----------

// Dressed like DateFilterPopover's `centered` variant and BranchFilterPopover — milk-white
// panel (#FDFCF8 on #EFEAE0), amber for the picked branch — so it reads as the same kind
// of filter as the date filter elsewhere on the OS. It used to cycle a rainbow palette by
// list position, which gave a branch a different colour whenever the list changed.
const BranchSelectDropdown = ({ value, branches, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const current = branches.find((b) => b.id === value);
  const pick = (id) => { onChange(id); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 min-w-[240px] items-center justify-between gap-2 rounded-md border px-3 text-sm font-medium transition-colors ${
          current ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        }`}
        data-testid="bm-branch-control-select"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{current ? current.branch_name : "Select a branch"}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-72 min-w-[260px] overflow-y-auto rounded-xl border border-[#EFEAE0] bg-[#FDFCF8] p-1.5 shadow-2xl" data-testid="bm-branch-control-select-list">
          <button
            type="button"
            onClick={() => pick("")}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
              current ? "text-slate-500 hover:bg-[#F3EFE6]" : "bg-amber-100 font-semibold text-amber-800"
            }`}
            data-testid="bm-branch-control-select-option-none"
          >
            — Select a branch —
          </button>
          {branches.length > 0 && <div className="my-1 border-t border-[#EFEAE0]" />}
          {branches.map((b) => {
            const on = b.id === value;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => pick(b.id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  on ? "bg-amber-100 font-semibold text-amber-800" : "text-slate-700 hover:bg-[#F3EFE6]"
                }`}
                data-testid={`bm-branch-control-select-option-${b.id}`}
              >
                <Building2 className={`h-4 w-4 shrink-0 ${on ? "text-amber-700" : "text-slate-400"}`} />
                <span className="min-w-0 flex-1 truncate">{b.branch_name}</span>
                {on && <Check className="h-4 w-4 shrink-0 text-amber-700" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const BranchControlTab = ({ actingUser }) => {
  const [branches, setBranches] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [viewAs, setViewAs] = useState("branch_admin"); // "branch_admin" | "head_physio" | "physio"
  const [physios, setPhysios] = useState([]);
  const [selectedPhysioId, setSelectedPhysioId] = useState("");

  useEffect(() => { bmList().then(setBranches).catch(() => {}); }, []);

  useEffect(() => {
    setSelectedPhysioId("");
    if (!selectedId || viewAs !== "physio") { setPhysios([]); return; }
    getDoctors({ branch_id: selectedId })
      .then((rows) => setPhysios((rows || []).filter((d) => d.profile_type === "physio")))
      .catch(() => setPhysios([]));
  }, [selectedId, viewAs]);

  const selected = branches.find((b) => b.id === selectedId);

  return (
    <div className="space-y-4" data-testid="bm-branch-control-tab">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <label className="text-xs font-medium text-slate-600">Viewing branch:</label>
        <BranchSelectDropdown value={selectedId} branches={branches} onChange={setSelectedId} />
        {selected && <span className="text-xs text-slate-400">{selected.admin_name ? `Managed by ${selected.admin_name}` : "No admin assigned"}</span>}

        <div className="flex w-full flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 sm:ml-auto sm:w-auto">
          {[{ key: "branch_admin", label: "Branch Admin View" }, { key: "head_physio", label: "CONSULTANT View" }, { key: "physio", label: "Physio View" }].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setViewAs(t.key)}
              className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition ${
                viewAs === t.key ? "bg-white text-sky-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
              data-testid={`bm-branch-control-viewas-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {viewAs === "physio" && selectedId && (
          <div className="relative">
            <select
              value={selectedPhysioId}
              onChange={(e) => setSelectedPhysioId(e.target.value)}
              className="h-9 min-w-[220px] appearance-none rounded-md border border-slate-200 bg-white px-3 pr-8 text-sm"
              data-testid="bm-branch-control-physio-select"
            >
              <option value="">— Select a physio —</option>
              {physios.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              {physios.length === 0 && <option value="" disabled>No physios in this branch yet</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        )}
      </div>

      {!selectedId ? (
        // A chevron bounces up at the control that needs using, the same prompt the
        // Dashboard's Revenue breakdown uses while its own branch picker is untouched.
        // The paragraph alone said "Pick a branch above" in the same grey as the rest of
        // it, which reads as a page with nothing on it rather than one waiting on a
        // choice. motion-safe, so a reader who has asked for reduced motion still gets
        // the arrow — it just holds still.
        <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center" data-testid="bm-branch-control-empty">
          <ChevronUp className="mx-auto h-5 w-5 text-sky-500 motion-safe:animate-bounce" />
          <p className="mt-1 text-sm font-semibold text-slate-600">Pick a branch above to open its full dashboard</p>
          <p className="mx-auto mt-1.5 max-w-3xl text-sm text-slate-400">
            Branch Admin view (Branch Leads, Consultations, Treatment Sessions, Rehab, Finance, Fitsiomax Store), CONSULTANT view (their own Consultations pipeline, Review, Rehab, Calendar), or Physio view (Consultations, Today, Full Calendar, Patients History for one physio) — with full control, same as they'd see it.
          </p>
        </div>
      ) : viewAs === "head_physio" ? (
        <HeadPhysioBoard key={`${selectedId}-hp`} branchId={selectedId} user={actingUser} supervising />
      ) : viewAs === "physio" ? (
        selectedPhysioId ? (
          <PhysioBoard key={`${selectedPhysioId}-ph`} physioId={selectedPhysioId} />
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400" data-testid="bm-branch-control-physio-empty">
            Pick a physio above to open their dashboard.
          </div>
        )
      ) : (
        <BranchAdminBoard key={`${selectedId}-ba`} branchId={selectedId} />
      )}
    </div>
  );
};

// ---------- Creation & Manager ----------

const CreationTab = ({ onDrillIn, actionSlot, onNavigateToOperations }) => {
  const [branches, setBranches] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [reassigning, setReassigning] = useState(null);
  const [showServiceTypes, setShowServiceTypes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modeFilter, setModeFilter] = useState("all"); // "all" | "online" | "offline"
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [showArchives, setShowArchives] = useState(false);

  /** `notify` is set only by the Refresh button. The same loader runs on mount and after
   *  every save, and none of those should announce themselves. */
  const load = useCallback(async ({ notify = false } = {}) => {
    setLoading(true);
    try {
      // The unscoped getDoctors that used to run here went with the Total Physio tile it
      // counted for. It pulled every doctor in the organisation on each load and refresh
      // to produce one number, and nothing else on this tab read it.
      const [bs, cs] = await Promise.all([
        bmList(),
        hrBranchAdminCandidates().catch(() => []),
      ]);
      setBranches(bs);
      setCandidates(cs);
      if (notify) toast.success("Refreshed");
    } catch (e) {
      // bmList had no catch of its own, so a failure rejected this whole function
      // unhandled: nothing updated and nothing was said, which is exactly what a dead
      // button looks like.
      toast.error(e?.response?.data?.detail || "Couldn't load branches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredBranches = modeFilter === "all"
    ? branches
    : branches.filter((b) => isOnlineVertical(b.vertical) === (modeFilter === "online"));

  // Rendered into the tab bar above. All three are icon-only there: a labelled button in a
  // row of tabs reads as another tab, and the row has no width to spare for the word anyway.
  // The two that only read or open sit in grey; Add Branch, the one that creates a record,
  // keeps the filled blue to itself.
  const actions = (
    <>
      {/* Spins and locks while in flight, as every other Refresh in the OS does, and says
          so when it lands — a reload that changes nothing on screen is otherwise
          indistinguishable from a button that does nothing. */}
      <Button
        className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        onClick={() => load({ notify: true })}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        data-testid="bm-refresh"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
      <Button
        className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        onClick={() => setShowServiceTypes(true)}
        title="Service Type"
        aria-label="Service Type"
        data-testid="bm-service-type-btn"
      >
        <Layers className="h-4 w-4" />
      </Button>
      <Button
        className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
        onClick={() => setShowArchives(true)}
        title="All Archives"
        aria-label="All Archives"
        data-testid="bm-all-archives-btn"
      >
        <ArchiveRestore className="h-4 w-4" />
      </Button>
      <Button
        className="h-9 w-9 shrink-0 bg-sky-600 p-0 hover:bg-sky-700"
        onClick={() => { setEditing(null); setShowAdd(true); }}
        title="Add Branch"
        aria-label="Add Branch"
        data-testid="bm-add-branch-btn"
      >
        <Plus className="h-4 w-4" />
      </Button>
      {/* Jumps to Operations > Branch, the same board a branch's manager (its admin)
          already opens from here via Branch Control — a second way into the same place,
          for when the next step is running that branch rather than editing its record. */}
      {onNavigateToOperations && (
        <Button
          className="h-9 w-9 shrink-0 bg-indigo-600 p-0 hover:bg-indigo-700"
          onClick={onNavigateToOperations}
          title="Go to Operations"
          aria-label="Go to Operations"
          data-testid="bm-goto-operations-btn"
        >
          <Workflow className="h-4 w-4" />
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-4" data-testid="bm-creation-tab">
      {actionSlot ? createPortal(actions, actionSlot) : <div className="flex items-center justify-end gap-2">{actions}</div>}

      {/* The four totals that sat here are gone. MANAGER is the list of branches and who
          runs each one, and every figure they carried is already on the cards below —
          branch count is the number of cards, and leads and doctors are on each card and
          add up in the eye. A row of tiles that only restates the list under it costs a
          screenful before the list starts. */}

      {/* Pills, not a dropdown — the online/offline split used to be a hidden option inside
          "All Branches" that nothing on screen hinted at.
          Left, so it starts on the same edge as the cards it filters; right-aligned it read
          as belonging to the toolbar above rather than to the list below. */}
      <div className="flex flex-wrap items-center justify-start gap-2" data-testid="bm-mode-filter">
        {[["all", "All Branches"], ["offline", "Offline"], ["online", "Online"]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setModeFilter(key)}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              modeFilter === key ? "border-sky-600 bg-sky-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
            }`}
            data-testid={`bm-mode-filter-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filteredBranches.length === 0 && (
          <Card><CardContent className="p-6 text-center text-sm text-slate-400">
            {branches.length === 0 ? <>No branches yet. Click <span className="font-semibold">Add Branch</span> to start.</> : "No branches match this filter."}
          </CardContent></Card>
        )}
        {filteredBranches.map((b) => (
          <Card key={b.id} className="border-slate-200 cursor-pointer hover:shadow-md transition" data-testid={`bm-branch-card-${b.id}`} onClick={() => onDrillIn && onDrillIn(b.id)}>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-1.5 text-base text-slate-900 hover:text-sky-700">
                  {b.branch_name}
                  {b.code && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600" data-testid={`bm-branch-code-${b.id}`}>{b.code}</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${isOnlineVertical(b.vertical) ? "bg-violet-50 text-violet-600" : "bg-emerald-50 text-emerald-600"}`}
                    data-testid={`bm-branch-mode-${b.id}`}
                  >
                    {isOnlineVertical(b.vertical) ? "Online" : "Offline"}
                  </span>
                </CardTitle>
                {b.address && <p className="mt-0.5 inline-flex items-center text-xs text-slate-500"><MapPin className="h-3 w-3 mr-1" />{b.address}</p>}
              </div>
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <button onClick={(e) => { e.stopPropagation(); setEditing(b); setShowAdd(true); }} className="text-blue-500 hover:text-blue-700" data-testid={`bm-branch-edit-${b.id}`}><Pencil className="h-4 w-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); setArchiveTarget(b); }} className="text-red-500 hover:text-red-700" title="Archive" data-testid={`bm-branch-archive-${b.id}`}><Archive className="h-4 w-4" /></button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Branch Admin</p>
                {/* A branch is created without one now, so the empty desk has to read as a
                    step still to take rather than as a missing value: an em dash under
                    "Branch Admin" gave no clue that the link below it is what fills it. */}
                {b.admin_name ? (
                  <>
                    <p className="mt-1 text-sm font-medium text-slate-800">{b.admin_name}</p>
                    <p className="text-xs text-slate-500"><Mail className="inline h-3 w-3 mr-1" />{b.admin_email || "—"}</p>
                    {b.admin_phone && <p className="text-xs text-slate-500"><Phone className="inline h-3 w-3 mr-1" />{b.admin_phone}</p>}
                  </>
                ) : (
                  <p className="mt-1 text-sm font-medium text-amber-600" data-testid={`bm-branch-unassigned-${b.id}`}>Not assigned yet</p>
                )}
                <button onClick={(e) => { e.stopPropagation(); setReassigning(b); }} className="mt-2 text-xs font-medium text-sky-600 hover:underline" data-testid={`bm-branch-reassign-${b.id}`}>{b.admin_name ? "Reassign Manager →" : "Assign Branch Admin →"}</button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
                <Stat label="Leads" value={b.leads_total || 0} color="#0ea5e9" />
                <Stat label="Open" value={b.leads_open || 0} color="#f59e0b" />
                <Stat label="Completed" value={b.leads_completed || 0} color="#22c55e" />
                <Stat label="Doctors" value={b.doctors_count || 0} color="#a855f7" />
              </div>
              <button className="w-full text-center text-xs font-semibold text-sky-600 hover:underline" data-testid={`bm-branch-open-${b.id}`}>Open Branch Details →</button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* A branch is created on this tab and has to be given a service type in that form;
          if the one it needs does not exist yet, leaving to make it meant abandoning a
          half-filled form. A dialog rather than a panel: it is opened rarely, and it
          returns you to exactly the tab you were on. */}
      {showServiceTypes && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bm-service-type-dialog">
          {/* Lexend, scoped to this dialog. It is already loaded for the printed sheets, so
              this costs no extra font request. */}
          <div className="w-full max-w-lg rounded-lg bg-white shadow-xl" style={{ fontFamily: "Lexend, sans-serif" }}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="inline-flex items-center gap-2 text-base font-semibold"><Layers className="h-4 w-4 text-sky-600" />Service Type</h3>
              <button onClick={() => setShowServiceTypes(false)} className="text-slate-400 hover:text-slate-600" data-testid="bm-service-type-close"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-5">
              <ServiceTypeManager onChanged={load} />
            </div>
          </div>
        </div>
      )}

      {showAdd && <BranchFormDialogV2 branch={editing} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />}

      {reassigning && <ReassignAdminDialog branch={reassigning} candidates={candidates.filter((c) => !c.assigned_branch || c.id === reassigning.admin_user_id)} onClose={() => setReassigning(null)} onSaved={() => { setReassigning(null); load(); }} />}

      {archiveTarget && (
        <ArchiveBranchModal
          branch={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={() => { setArchiveTarget(null); load(); }}
        />
      )}

      {showArchives && (
        <ArchivedBranchesModal
          onClose={() => setShowArchives(false)}
          onRestored={load}
        />
      )}
    </div>
  );
};

// Re-enters the branch's own login password (not a generic "type DELETE to confirm") — an
// archive still just soft-hides the branch, but the same Super Admin session that can open
// this card can also click through it in one misplaced tap, so the check has to cost more
// than a click.
const ArchiveBranchModal = ({ branch, onClose, onArchived }) => {
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!password) { toast.error("Enter your password"); return; }
    setSaving(true);
    try {
      await bmArchiveBranch(branch.id, password);
      toast.success(`"${branch.branch_name}" archived`);
      onArchived();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Archive failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bm-archive-dialog">
      <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold"><Archive className="h-4 w-4 text-red-500" />Archive Branch</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="bm-archive-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 p-5">
          <p className="text-sm text-slate-600">
            Archiving <span className="font-semibold text-slate-800">"{branch.branch_name}"</span> hides it from the live list. Its admin, leads, and history stay intact — restore it any time from "All Archives".
          </p>
          <Field label="Confirm your Super Admin password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Password"
              autoFocus
              data-testid="bm-archive-password"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="bm-archive-cancel">Cancel</Button>
          <Button className="bg-red-600 hover:bg-red-700" onClick={submit} disabled={saving} data-testid="bm-archive-confirm">
            {saving ? "Archiving…" : "Archive"}
          </Button>
        </div>
      </div>
    </div>
  );
};

// The step after archiving, and the one nothing undoes — so the same password as archive,
// and the dialog says where the branch's leads and its admin end up before it goes.
const DeleteArchivedBranchModal = ({ branch, onClose, onDeleted }) => {
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const leads = branch.leads_total || 0;

  const submit = async () => {
    if (!password) { toast.error("Enter your password"); return; }
    setSaving(true);
    try {
      await bmDeleteArchivedBranch(branch.id, password);
      toast.success(`"${branch.branch_name}" deleted`);
      onDeleted();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="bm-archived-delete-dialog">
      <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold"><Trash2 className="h-4 w-4 text-red-500" />Delete Branch</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="bm-archived-delete-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 p-5">
          <p className="text-sm text-slate-600">
            Permanently deletes <span className="font-semibold text-slate-800">"{branch.branch_name}"</span>. This can't be undone.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
            <li>{leads > 0 ? `Its ${leads} lead${leads === 1 ? "" : "s"} go back to Pre-Sales with no branch.` : "It has no leads."}</li>
            {branch.admin_name && <li>{branch.admin_name} keeps their login and becomes unassigned in HR.</li>}
          </ul>
          <Field label="Confirm your Super Admin password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Password"
              autoFocus
              data-testid="bm-archived-delete-password"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="bm-archived-delete-cancel">Cancel</Button>
          <Button className="bg-red-600 hover:bg-red-700" onClick={submit} disabled={saving} data-testid="bm-archived-delete-confirm">
            {saving ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
};

const ArchivedBranchesModal = ({ onClose, onRestored }) => {
  const [archived, setArchived] = useState([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setArchived(await bmListArchived()); }
    catch (e) { toast.error(e?.response?.data?.detail || "Couldn't load archives"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const restore = async (b) => {
    setRestoringId(b.id);
    try {
      await bmRestoreBranch(b.id);
      toast.success(`"${b.branch_name}" restored`);
      await load();
      onRestored();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Restore failed");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bm-archives-dialog">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold"><ArchiveRestore className="h-4 w-4 text-slate-600" />All Archives</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="bm-archives-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto p-5">
          {loading && <p className="text-center text-sm text-slate-400">Loading…</p>}
          {!loading && archived.length === 0 && <p className="text-center text-sm text-slate-400">No archived branches.</p>}
          {archived.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 p-3" data-testid={`bm-archived-row-${b.id}`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{b.branch_name}</p>
                <p className="truncate text-xs text-slate-500">{b.admin_name || "—"}{b.archived_at ? ` · archived ${b.archived_at.slice(0, 10)}` : ""}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  className="h-8 shrink-0 bg-emerald-600 px-3 text-xs hover:bg-emerald-700"
                  onClick={() => restore(b)}
                  disabled={restoringId === b.id}
                  data-testid={`bm-archived-restore-${b.id}`}
                >
                  {restoringId === b.id ? "Restoring…" : "Restore"}
                </Button>
                <Button
                  className="h-8 shrink-0 bg-red-600 px-3 text-xs hover:bg-red-700"
                  onClick={() => setDeleteTarget(b)}
                  disabled={restoringId === b.id}
                  data-testid={`bm-archived-delete-${b.id}`}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {deleteTarget && (
        <DeleteArchivedBranchModal
          branch={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </div>
  );
};

const BranchFormDialog = ({ branch, candidates, onClose, onSaved }) => {
  const isEdit = !!branch;
  const [form, setForm] = useState({
    branch_name: branch?.branch_name || "",
    address: branch?.address || "",
    admin_user_id: branch?.admin_user_id || "",
    admin_phone: branch?.admin_phone || "",
    vertical: branch?.vertical || "offline_physiotherapy",
  });
  const available = candidates.filter((c) => !c.assigned_branch || c.id === branch?.admin_user_id);

  const submit = async () => {
    if (!form.branch_name.trim() || !form.address.trim()) { toast.error("Branch name and address required"); return; }
    if (!isEdit && !form.admin_user_id) { toast.error("Select a branch admin"); return; }
    try {
      if (isEdit) {
        await updateBranch(branch.id, { branch_name: form.branch_name, address: form.address, admin_phone: form.admin_phone, vertical: form.vertical });
        toast.success("Branch updated");
      } else {
        await bmCreateWithExistingAdmin({ branch_name: form.branch_name, address: form.address, admin_user_id: form.admin_user_id, admin_phone: form.admin_phone, vertical: form.vertical });
        toast.success("Branch created");
      }
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bm-branch-form-dialog">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold">{isEdit ? "Edit Branch" : "Add Branch"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="bm-branch-form-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 p-5">
          <Field label="Branch Name *"><Input value={form.branch_name} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} placeholder="e.g. Anna Nagar" data-testid="bm-form-name" /></Field>
          <Field label="Address *"><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street, City" data-testid="bm-form-address" /></Field>
          {!isEdit && (
            <Field label="Branch Admin (Manager) *">
              <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.admin_user_id} onChange={(e) => setForm({ ...form, admin_user_id: e.target.value })} data-testid="bm-form-admin">
                <option value="">— Select existing branch_admin user —</option>
                {available.length === 0 && <option disabled>No available branch_admin users — create one in HR</option>}
                {available.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.email}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">Only users with role=branch_admin (not yet assigned to a branch) appear here. Create more in HR → Credentials.</p>
            </Field>
          )}
          <Field label="Admin Phone"><Input value={form.admin_phone} onChange={(e) => setForm({ ...form, admin_phone: e.target.value })} placeholder="+91 …" data-testid="bm-form-phone" /></Field>
          <Field label="Vertical">
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value })} data-testid="bm-form-vertical">
              <option value="offline_physiotherapy">Offline Physiotherapy</option>
              <option value="online_physiotherapy">Online Physiotherapy</option>
              <option value="fitness">Fitness</option>
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="bm-form-cancel">Cancel</Button>
          <Button onClick={submit} className="bg-sky-600 hover:bg-sky-700" data-testid="bm-form-submit">{isEdit ? "Save" : "Create Branch"}</Button>
        </div>
      </div>
    </div>
  );
};

const ReassignAdminDialog = ({ branch, candidates, onClose, onSaved }) => {
  const [pick, setPick] = useState(branch.admin_user_id || "");
  const save = async () => {
    if (!pick) { toast.error("Select a manager"); return; }
    try { await bmReassignAdmin(branch.id, pick); toast.success("Manager reassigned"); onSaved(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };
  // Reads as "Assign" on a branch that has never had one — which, since the create form
  // stopped asking for an admin, is every branch on the day it is made.
  const assigned = !!branch.admin_user_id;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bm-reassign-dialog">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
        <h3 className="text-base font-semibold">{assigned ? "Reassign Manager" : "Assign Branch Admin"} — {branch.branch_name}</h3>
        <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="bm-reassign-select">
          <option value="">— Pick branch admin —</option>
          {candidates.length === 0 && <option disabled>No unassigned Branch Admin — add the employee in HR → Credentials first</option>}
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.email}</option>)}
        </select>
        <p className="text-[11px] text-slate-400">{assigned ? "Reassigning will unlink the previous manager from this branch." : "Shows every Branch Admin from HR → Credentials who does not already run a branch."}</p>
        <div className="flex gap-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="bm-reassign-cancel">Cancel</Button><Button onClick={save} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="bm-reassign-submit">Save</Button></div>
      </div>
    </div>
  );
};

const Stat = ({ label, value, color }) => (
  <div className="rounded border border-slate-100 p-2">
    <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-base font-bold" style={{ color }}>{value}</p>
  </div>
);

const Field = ({ label, children, className = "" }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="text-xs font-medium text-slate-700">{label}</label>
    {children}
  </div>
);

// ---------- Service Type (moved from Super Admin Master View "Business Verticals") ----------
/**
 * Add or remove a service type, and see the ones that exist. Opened from MANAGER's toolbar,
 * where a branch is created and the type it needs may not exist yet.
 *
 * onChanged lets the host refresh whatever it renders off the same list.
 */
const ServiceTypeManager = ({ onChanged }) => {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [removingId, setRemovingId] = useState("");

  const fetchItems = useCallback(async () => {
    try {
      const rows = await getVerticals();
      const defaults = ["offline_physiotherapy", "online_physiotherapy", "online_fitness", "offline_fitness_gym"];
      // `stored` separates real records from the placeholder list shown on an empty
      // database. The placeholders have no row behind them, so they have nothing to
      // delete — offering the bin there would only ever produce a 404.
      setItems(rows && rows.length
        ? rows.map((r) => ({ ...r, stored: true }))
        : defaults.map((n) => ({ id: n, name: n, stored: false })));
    } catch (err) {
      toast.error("Failed to load service types");
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const addItem = async (event) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("Enter a service type name");
      return;
    }
    try {
      setLoading(true);
      await createVertical({ name: name.trim(), active: true });
      setName("");
      await fetchItems();
      onChanged && onChanged();
      toast.success("Service type added");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to add service type");
    } finally {
      setLoading(false);
    }
  };

  const removeItem = async (item) => {
    if (!window.confirm(`Delete service type "${serviceTypeLabel(item.name).toUpperCase()}"?`)) return;
    try {
      setRemovingId(item.id);
      await deleteVertical(item.id);
      await fetchItems();
      onChanged && onChanged();
      toast.success("Service type deleted");
    } catch (err) {
      // The 409 names the branches still on this type, so it is worth showing in full
      // rather than collapsing to "Delete failed".
      toast.error(err?.response?.data?.detail || "Failed to delete service type");
    } finally {
      setRemovingId("");
    }
  };

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={addItem} data-testid="service-type-form">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new_service_type"
          className="h-10 flex-1"
          data-testid="service-type-input"
        />
        <Button type="submit" disabled={loading} className="h-10 shrink-0 bg-sky-600 px-5 hover:bg-sky-700" data-testid="service-type-submit">
          <Plus className="mr-1 h-4 w-4" />Add
        </Button>
      </form>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const chip = serviceTypeChipStyle(serviceTypeColor(item.name));
          return (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition hover:shadow-sm"
              style={chip.tile}
              data-testid={`service-type-row-${item.id}`}
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={chip.glyph}>
                <Layers className="h-3.5 w-3.5" style={chip.icon} />
              </span>
              {/* The OS's small-caps label: uppercase, tracked, one step down in size. A
                  service type is a tag on a branch, not prose, and it reads as one here. */}
              <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-slate-600" title={item.name}>
                {serviceTypeLabel(item.name)}
              </span>
              {item.stored && (
                <button
                  type="button"
                  onClick={() => removeItem(item)}
                  disabled={removingId === item.id}
                  className="shrink-0 text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                  title="Delete service type"
                  aria-label={`Delete ${serviceTypeLabel(item.name)}`}
                  data-testid={`service-type-delete-${item.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500 sm:col-span-2">
            No service types yet. Add one above.
          </p>
        )}
      </div>
    </div>
  );
};

export default BranchManagementBoard;
