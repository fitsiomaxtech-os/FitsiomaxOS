import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, BarChart3, Building2, Calendar, CheckCircle2, ChevronDown, Clock,
  Database, FileSpreadsheet, History, IndianRupee, Link as LinkIcon, MapPin,
  RefreshCw, Shield, ShieldCheck, ShieldAlert, Stethoscope, UserCheck, Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Pie, PieChart, Cell, ResponsiveContainer } from "recharts";
import { getMasterControl, getBranches, getDoctors, getLeads, getVerticals, updateLead, moveLeadStage, mkPerformance } from "@/lib/api";
import { displayPhone } from "@/lib/phone";

const REFRESH_MS = 30000;

// Branch → Head Physio → Branch → End. Pre-sales stages (New Lead / Follow Up /
// Appointment on the `stage` field) are intentionally not shown here.
const JOURNEY_PILLS = [
  { label: "New Appointment",         key: "New Appointment",         color: "#3b82f6", icon: Calendar },
  { label: "Appointment Date & Time", key: "Appointment Date & Time", color: "#14b8a6", icon: Clock },
  { label: "Consultation",            key: "Consultation",            color: "#8b5cf6", icon: Stethoscope },
  { label: "Fee Collected",           key: "Fee Collected",           color: "#f59e0b", icon: IndianRupee },
  { label: "Physio Assign",           key: "Physio Assign",           color: "#a855f7", icon: Users },
  { label: "Patient",                 key: "Patient",                 color: "#22c55e", icon: CheckCircle2 },
];

const ATTENTION_ROWS = [
  { key: "follow_up_pending", label: "Follow-up Pending", color: "#f59e0b", icon: Clock,        bg: "#fff7ed", text: "#9a3412" },
  { key: "date_time_pending", label: "Date & Time Pending", color: "#10b981", icon: Calendar,  bg: "#ecfdf5", text: "#065f46" },
  { key: "branch_pending",    label: "Branch Pending",   color: "#3b82f6", icon: Building2,    bg: "#eff6ff", text: "#1e40af" },
  { key: "expert_pending",    label: "Expert Pending",   color: "#8b5cf6", icon: UserCheck,    bg: "#f5f3ff", text: "#5b21b6" },
  { key: "sync_issue",        label: "Sync Issue",       color: "#ef4444", icon: AlertTriangle, bg: "#fef2f2", text: "#991b1b" },
];

const QUEUE_CARDS = [
  { key: "todays_follow_ups",      label: "Today\u2019s Follow-ups",      color: "#f59e0b", icon: Clock,    bg: "#fff7ed" },
  { key: "appointments_today",     label: "Appointments Today",      color: "#10b981", icon: Calendar, bg: "#ecfdf5" },
  { key: "new_appointments",       label: "New Appointments",        color: "#3b82f6", icon: Calendar, bg: "#eff6ff" },
  { key: "pending_branch_actions", label: "Pending Branch Actions",  color: "#8b5cf6", icon: Building2, bg: "#f5f3ff" },
];

const QUICK_ACTIONS = [
  { key: "move_stage",   label: "Move Stage",   icon: ArrowRight,   color: "#3b82f6", bg: "#eff6ff" },
  { key: "assign_branch", label: "Assign Branch", icon: Building2,  color: "#10b981", bg: "#ecfdf5" },
  { key: "assign_expert", label: "Assign Expert", icon: UserCheck,  color: "#8b5cf6", bg: "#f5f3ff" },
  { key: "override",      label: "Override",      icon: Shield,     color: "#f97316", bg: "#fff7ed" },
  { key: "view_history",  label: "View History",  icon: History,    color: "#64748b", bg: "#f1f5f9" },
];

const WORKFLOW_COLORS = ["#22c55e", "#3b82f6", "#8b5cf6", "#ef4444"];
const PATIENT_COLORS = ["#3b82f6", "#bae6fd"];

const formatTime = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()} ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}`;
  } catch { return iso; }
};

export const MasterControlBoard = () => {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("data");
  const [quickAction, setQuickAction] = useState(null);
  const [filters, setFilters] = useState({ branch: "", service: "", expert: "", time_range: "current" });
  const [branches, setBranches] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [verticals, setVerticals] = useState([]);
  const [perf, setPerf] = useState(null);

  useEffect(() => {
    mkPerformance().then(setPerf).catch((e) => console.warn("[load failed]", e?.message || e));
  }, []);

  const refreshRef = useRef(null);

  useEffect(() => {
    const fetchOnce = async () => {
      try {
        const params = {};
        if (filters.branch) params.branch_id = filters.branch;
        if (filters.service) params.service_type = filters.service;
        if (filters.expert) params.expert_id = filters.expert;
        if (filters.time_range) params.time_range = filters.time_range;
        const res = await getMasterControl(params);
        setData(res);
      } catch (err) {
        console.error("Master control fetch error:", err);
      }
    };
    refreshRef.current = fetchOnce;
    fetchOnce();
    const id = setInterval(fetchOnce, REFRESH_MS);
    return () => clearInterval(id);
  }, [filters.branch, filters.service, filters.expert, filters.time_range]);

  useEffect(() => {
    Promise.all([getBranches().catch(() => []), getDoctors().catch(() => []), getVerticals().catch(() => [])])
      .then(([b, d, v]) => { setBranches(b || []); setDoctors(d || []); setVerticals(v || []); });
  }, []);

  // Trigger an immediate refetch via the latest effect when filters change is now handled by deps above.

  const refresh = useCallback(() => { const fn = refreshRef.current; if (fn) fn(); }, []);

  const liveLabel = useMemo(() => (data?.live_time ? formatTime(data.live_time) : "—"), [data]);

  if (!data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500" data-testid="master-control-loading">
        Loading Master Control Board…
      </div>
    );
  }

  const a = data.analytics || {};
  const cur = a.current_period || {};
  const prev = a.previous_period || {};
  const prog = a.progress || {};

  return (
    <div className="space-y-4" data-testid="master-control-section">
      {/* Master Control Board */}
      <Card className="border-slate-200 bg-white" data-testid="master-control-card">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base text-slate-900" data-testid="master-control-title">Master Control Board</CardTitle>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700" data-testid="master-control-status">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> All Systems Operational
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-slate-500">Live Date &amp; Time:&nbsp;<span className="font-semibold text-blue-600" data-testid="master-control-live-time">{liveLabel}</span></span>
            <button onClick={refresh} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-slate-500 hover:bg-slate-100" data-testid="master-control-refresh">
              <RefreshCw className="h-3.5 w-3.5" /> Auto Refresh: 30s
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 1. Patient Journey Flow Map */}
          <section className="rounded-xl border border-slate-200 p-4" data-testid="journey-flow-map">
            <p className="mb-3 text-sm font-semibold text-slate-700">1. Patient Journey Flow Map</p>
            <div className="flex flex-wrap items-center gap-2">
              {JOURNEY_PILLS.map((p, idx) => {
                const Icon = p.icon;
                const count = data.journey?.[p.key] ?? 0;
                return (
                  <div key={p.key} className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-xl px-3 py-2"
                      style={{ background: `${p.color}10`, border: `1px solid ${p.color}26` }}
                      data-testid={`journey-pill-${p.key}`}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: p.color }} />
                      <span className="text-xs font-semibold" style={{ color: p.color }}>{p.label}</span>
                      <span className="ml-1 rounded-full bg-white/80 px-1.5 text-[10px] font-bold" style={{ color: p.color }}>{count}</span>
                    </div>
                    {idx < JOURNEY_PILLS.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-300" />}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 2 / 3 — two-column block */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* 2. Attention Required */}
            <section className="rounded-xl border border-slate-200 p-4" data-testid="attention-required">
              <p className="mb-3 text-sm font-semibold text-slate-700">2. Attention Required</p>
              <ul className="space-y-2">
                {ATTENTION_ROWS.map((r) => {
                  const Icon = r.icon;
                  return (
                    <li key={r.key} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: r.bg }} data-testid={`attention-${r.key}`}>
                      <div className="flex items-center gap-2 text-xs font-medium" style={{ color: r.text }}>
                        <Icon className="h-3.5 w-3.5" style={{ color: r.color }} /> {r.label}
                      </div>
                      <span className="text-sm font-bold" style={{ color: r.text }}>{data.attention?.[r.key] ?? 0}</span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* 3. Today's Priority Queue */}
            <section className="rounded-xl border border-slate-200 p-4" data-testid="today-queue">
              <p className="mb-3 text-sm font-semibold text-slate-700">3. Today&apos;s Priority Queue</p>
              <div className="grid grid-cols-2 gap-2">
                {QUEUE_CARDS.map((c) => {
                  const Icon = c.icon;
                  return (
                    <div key={c.key} className="rounded-lg p-3" style={{ background: c.bg }} data-testid={`queue-${c.key}`}>
                      <div className="flex items-center justify-between">
                        <Icon className="h-4 w-4" style={{ color: c.color }} />
                        <ArrowRight className="h-3 w-3 text-slate-400" />
                      </div>
                      <p className="mt-1 text-[10px] font-medium" style={{ color: c.color }}>{c.label}</p>
                      <p className="text-2xl font-bold" style={{ color: c.color }}>{data.today_queue?.[c.key] ?? 0}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* 4 / 5 — two-column block */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* 4. Performance */}
            <section className="rounded-xl border border-slate-200 p-4" data-testid="master-control-performance">
              <p className="mb-3 text-sm font-semibold text-slate-700">4. Performance</p>
              <PerformanceSection perf={perf} />
            </section>

            {/* 5. Sync & System Health */}
            <section className="rounded-xl border border-slate-200 p-4" data-testid="sync-health">
              <p className="mb-3 text-sm font-semibold text-slate-700">5. Sync &amp; System Health</p>
              <ul className="space-y-2.5 text-xs">
                <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-600"><LinkIcon className="h-3.5 w-3.5 text-slate-400" /> Google Sheet Sync</span>
                  <span className={data.sync_health?.sheet_status === "Connected" ? "font-semibold text-emerald-600" : (data.sync_health?.sheet_status === "Configured" ? "font-semibold text-amber-600" : "font-semibold text-rose-500")} data-testid="sync-status">{data.sync_health?.sheet_status || "—"}</span>
                </li>
                {data.sync_health?.sources_total > 0 && (
                  <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-500"><FileSpreadsheet className="h-3.5 w-3.5 text-slate-400" /> Source</span>
                    <span className="font-semibold text-slate-700" data-testid="sync-source">
                      {data.sync_health.sources_connected} Sheet{data.sync_health.sources_connected === 1 ? "" : "s"} Connected
                    </span>
                  </li>
                )}
                <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-600"><Clock className="h-3.5 w-3.5 text-slate-400" /> Last Sync</span>
                  <span className="font-semibold text-slate-700" data-testid="sync-last">{formatTime(data.sync_health?.last_sync)}</span>
                </li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-600"><FileSpreadsheet className="h-3.5 w-3.5 text-slate-400" /> New Rows</span>
                  <span className="font-semibold text-slate-700" data-testid="sync-new-rows">{data.sync_health?.new_rows ?? 0}</span>
                </li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-600"><AlertTriangle className="h-3.5 w-3.5 text-slate-400" /> Duplicates Skipped</span>
                  <span className="font-semibold text-slate-700" data-testid="sync-duplicates">{data.sync_health?.duplicates_skipped ?? 0}</span>
                </li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-600"><MapPin className="h-3.5 w-3.5 text-slate-400" /> Mapping Status</span>
                  <span className={data.sync_health?.mapping_status === "All Mapped" ? "font-semibold text-emerald-600" : "font-semibold text-slate-700"} data-testid="sync-mapping">{data.sync_health?.mapping_status || "—"}</span>
                </li>
              </ul>
            </section>
          </div>
        </CardContent>
      </Card>

      {/* Live Analytics Overview */}
      <Card className="border-slate-200 bg-white" data-testid="live-analytics-card">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base text-slate-900">Live Analytics Overview</CardTitle>
            <button onClick={refresh} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100" data-testid="live-analytics-refresh">
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
          <span className="text-xs text-slate-500">Data as of&nbsp;<span className="font-semibold text-rose-500" data-testid="live-analytics-time">{liveLabel}</span></span>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Tabs */}
          <div className="flex overflow-x-auto border-b border-slate-200">
            {[
              { k: "data", label: "Data Processing" },
              { k: "analytical", label: "Analytical" },
              { k: "status", label: "Status Overview" },
            ].map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-semibold transition ${tab === t.k ? "border-b-2 border-blue-500 text-blue-600" : "text-slate-500 hover:text-slate-700"}`}
                data-testid={`live-tab-${t.k}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab !== "data" ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500" data-testid={`live-tab-empty-${tab}`}>
              Coming soon
            </div>
          ) : (
            <>
              {/* Filters — four color-themed dropdowns laid out horizontally */}
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3 md:grid-cols-4" data-testid="live-filters">
                <FilterDropdown label="Branch" value={filters.branch} onChange={(v) => setFilters({ ...filters, branch: v })} options={[{ value: "", label: "All Branches" }, ...branches.map((b) => ({ value: b.id, label: b.branch_name || b.name }))]} testid="filter-branch" />
                <FilterDropdown label="Service Type" value={filters.service} onChange={(v) => setFilters({ ...filters, service: v })} options={[{ value: "", label: "All Service Types" }, ...verticals.map((v) => ({ value: v.name, label: v.name }))]} testid="filter-service" />
                <FilterDropdown label="Expert" value={filters.expert} onChange={(v) => setFilters({ ...filters, expert: v })} options={[{ value: "", label: "All Experts" }, ...doctors.map((d) => ({ value: d.id, label: d.full_name }))]} testid="filter-expert" />
                <FilterDropdown label="Time Range" value={filters.time_range} onChange={(v) => setFilters({ ...filters, time_range: v })} options={[{ value: "current", label: "Current Academic Year (2025 - 2026)" }, { value: "last_30", label: "Last 30 Days" }, { value: "last_90", label: "Last 90 Days" }]} testid="filter-time-range" />
              </div>

              {/* Donuts */}
              <div className="grid gap-4 lg:grid-cols-2">
                <DonutBlock title="Lead Workflow Validation" totalLabel="Total Leads" total={a.workflow_total || 0} data={a.workflow || []} colors={WORKFLOW_COLORS} testid="donut-workflow" />
                <DonutBlock title="Patient Information Completion" totalLabel="Total Patients" total={a.patient_info_total || 0} data={a.patient_info || []} colors={PATIENT_COLORS} testid="donut-patient" />
              </div>

              {/* Period comparison */}
              <div className="grid gap-3 md:grid-cols-2">
                <PeriodBar period={cur} label="Current Period" sublabel="(2025 - 2026)" color="#22c55e" bg="#f0fdf4" testid="period-current" />
                <PeriodBar period={prev} label="Previous Period" sublabel="(2024 - 2025)" color="#3b82f6" bg="#eff6ff" testid="period-previous" />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Quick Action picker dialog */}
      {quickAction && (
        <QuickActionDialog
          actionKey={quickAction}
          onClose={() => setQuickAction(null)}
          branches={branches}
          doctors={doctors}
        />
      )}
    </div>
  );
};

const PerformanceBar = ({ label, count, total, color }) => (
  <div className="flex items-center gap-2">
    <div className="w-20 truncate text-[11px] text-slate-600" title={label}>{label}</div>
    <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
      <div className="h-full rounded" style={{ width: `${(count / total) * 100}%`, background: color }} />
    </div>
    <div className="w-6 text-right text-[11px] font-semibold text-slate-700">{count}</div>
  </div>
);

const PerformanceSection = ({ perf }) => {
  if (!perf) return <p className="text-xs text-slate-400">Loading...</p>;

  const maxFunnel = Math.max(...perf.funnel.map((r) => r.count), 1);
  const maxPre = Math.max(...perf.leads_per_pre_sales.map((r) => r.count), 1);
  const maxSales = Math.max(...perf.deals_per_sales.map((r) => r.count), 1);

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Conversion Funnel</p>
        <div className="space-y-1.5">
          {perf.funnel.map((r) => <PerformanceBar key={r.stage} label={r.stage} count={r.count} total={maxFunnel} color="#0ea5e9" />)}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Leads per Pre-Sales Agent</p>
        {perf.leads_per_pre_sales.length === 0
          ? <p className="text-[11px] text-slate-400">No data.</p>
          : <div className="max-h-24 space-y-1.5 overflow-y-auto">{perf.leads_per_pre_sales.map((r) => <PerformanceBar key={r.name} label={r.name} count={r.count} total={maxPre} color="#f59e0b" />)}</div>}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Deals Closed per Sales (Branch Admin)</p>
        {perf.deals_per_sales.length === 0
          ? <p className="text-[11px] text-slate-400">No data.</p>
          : <div className="max-h-24 space-y-1.5 overflow-y-auto">{perf.deals_per_sales.map((r) => <PerformanceBar key={r.name} label={r.name} count={r.count} total={maxSales} color="#22c55e" />)}</div>}
      </div>
    </div>
  );
};

// Cycling color palette for the filter dropdown options — same soft-pill theme
// as the Treatment Package picker on the Consultations board.
const FILTER_COLORS = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#e11d48", "#0891b2"];

const FilterDropdown = ({ label, value, onChange, options, testid }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const selIdx = Math.max(options.findIndex((o) => o.value === value), 0);
  const selOpt = options[selIdx];
  const selColor = FILTER_COLORS[selIdx % FILTER_COLORS.length];
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <div className="relative w-full" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-xs font-semibold transition hover:brightness-95"
          style={{ background: `${selColor}14`, color: selColor, borderColor: `${selColor}33` }}
          data-testid={testid}
        >
          <span className="truncate">{selOpt?.label}</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} style={{ color: selColor }} />
        </button>
        {open && (
          <div className="absolute z-20 mt-1 flex w-max min-w-full max-w-[80vw] flex-wrap gap-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-lg" data-testid={`${testid}-menu`}>
            {options.map((o, idx) => {
              const color = FILTER_COLORS[idx % FILTER_COLORS.length];
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition hover:brightness-95"
                  style={{ backgroundColor: selected ? `${color}2e` : `${color}14`, color }}
                  data-testid={`${testid}-${o.value || "all"}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const DonutBlock = ({ title, totalLabel, total, data, colors, testid }) => {
  const hasData = data.some((d) => (d.value || 0) > 0);
  return (
    <div className="rounded-xl border border-slate-200 p-4" data-testid={testid}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">{title}</p>
        <FileSpreadsheet className="h-4 w-4 text-emerald-500" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1 flex flex-col justify-center gap-1.5 text-xs">
          {data.map((d, i) => (
            <div key={d.name} className="flex items-center gap-2" data-testid={`${testid}-legend-${d.name}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: colors[i % colors.length] }} />
              <span className="text-slate-600">{d.name}</span>
            </div>
          ))}
        </div>
        <div className="col-span-2 relative h-44">
          {hasData ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" innerRadius={50} outerRadius={75} paddingAngle={2}>
                  {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">No data yet</div>
          )}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-[10px] text-slate-500">{totalLabel}</p>
            <p className="text-xl font-bold text-slate-800">{(total || 0).toLocaleString()}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const PeriodBar = ({ period, label, sublabel, color, bg, testid }) => (
  <div className="rounded-xl p-3" style={{ background: bg }} data-testid={testid}>
    <div className="flex items-center justify-between text-xs">
      <div>
        <span className="font-semibold" style={{ color }}>{label}</span>
        <span className="ml-1 text-slate-500">{sublabel}</span>
      </div>
      <span className="font-bold" style={{ color }}>{period.percent ?? 0}%</span>
    </div>
    <p className="mt-1 text-xs text-slate-600"><b>{(period.records ?? 0).toLocaleString()}</b> Records</p>
  </div>
);

const ProgressRow = ({ icon: Icon, label, color, data, testid }) => {
  const pct = data?.percent ?? 0;
  return (
    <div data-testid={testid}>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="flex items-center gap-2 font-semibold text-slate-700"><Icon className="h-3.5 w-3.5" style={{ color }} /> {label}</span>
        <span className="font-bold" style={{ color }}>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="mt-1 text-[10px] text-slate-500">{data?.completed ?? 0} / {data?.total ?? 0} Completed</p>
    </div>
  );
};

const QuickActionDialog = ({ actionKey, onClose, branches, doctors }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [extra, setExtra] = useState("");
  const action = QUICK_ACTIONS.find((q) => q.key === actionKey);

  const search = useCallback(async (q) => {
    if (!q || q.length < 2) { setResults([]); return; }
    try {
      const all = await getLeads();
      const filtered = (all || []).filter((l) => {
        const hay = `${l.name || ""} ${l.phone || ""} ${l.email || ""}`.toLowerCase();
        return hay.includes(q.toLowerCase());
      }).slice(0, 20);
      setResults(filtered);
    } catch { setResults([]); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  const apply = async () => {
    if (!picked) { toast.error("Select a lead first"); return; }
    if (actionKey === "view_history") {
      toast.info(`Opening history for ${picked.name}`);
      onClose();
      return;
    }
    if (!extra) { toast.error("Pick a target"); return; }
    try {
      if (actionKey === "move_stage") {
        await moveLeadStage(picked.id, { stage: extra });
        toast.success(`Moved ${picked.name} → ${extra}`);
      } else if (actionKey === "assign_branch") {
        await updateLead(picked.id, { branch_id: extra });
        toast.success(`Assigned ${picked.name} to branch`);
      } else if (actionKey === "assign_expert") {
        await updateLead(picked.id, { assigned_physio_id: extra });
        toast.success(`Assigned expert to ${picked.name}`);
      } else if (actionKey === "override") {
        await moveLeadStage(picked.id, { stage: extra });
        toast.success(`Override applied: ${picked.name} → ${extra}`);
      }
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Action failed");
    }
  };

  const targetOptions = useMemo(() => {
    if (actionKey === "move_stage" || actionKey === "override") {
      return [
        { value: "New Leads", label: "New Leads" }, { value: "Follow Up", label: "Follow Up" }, { value: "Appointment", label: "Appointment" },
      ];
    }
    if (actionKey === "assign_branch") return branches.map((b) => ({ value: b.id, label: b.branch_name || b.name }));
    if (actionKey === "assign_expert") return doctors.map((d) => ({ value: d.id, label: d.full_name }));
    return [];
  }, [actionKey, branches, doctors]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="quick-action-dialog">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800" data-testid="quick-action-dialog-title">{action?.label}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="quick-action-dialog-close">✕</button>
        </div>
        <div className="space-y-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search lead by name / phone / email…" data-testid="quick-action-search" />
          {results.length > 0 && !picked && (
            <ul className="max-h-44 overflow-auto rounded-md border border-slate-200" data-testid="quick-action-results">
              {results.map((l) => (
                <li
                  key={l.id}
                  onClick={() => setPicked(l)}
                  className="cursor-pointer border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50"
                  data-testid={`quick-action-result-${l.id}`}
                >
                  <p className="font-medium text-slate-800">{l.name || "—"}</p>
                  <p className="text-xs text-slate-500">{displayPhone(l.phone) || "—"} · {l.stage || "—"}</p>
                </li>
              ))}
            </ul>
          )}
          {picked && (
            <div className="rounded-md bg-blue-50 p-3 text-sm" data-testid="quick-action-picked">
              <p className="font-semibold text-blue-800">{picked.name}</p>
              <p className="text-xs text-blue-600">{displayPhone(picked.phone)} · current stage: {picked.stage}</p>
              <button onClick={() => setPicked(null)} className="mt-1 text-xs text-blue-600 hover:underline">Change</button>
            </div>
          )}
          {picked && actionKey !== "view_history" && (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">Target</p>
              <select value={extra} onChange={(e) => setExtra(e.target.value)} className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" data-testid="quick-action-target">
                <option value="">-- choose --</option>
                {targetOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} data-testid="quick-action-cancel">Cancel</Button>
            <Button onClick={apply} disabled={!picked} data-testid="quick-action-apply">Apply</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MasterControlBoard;
