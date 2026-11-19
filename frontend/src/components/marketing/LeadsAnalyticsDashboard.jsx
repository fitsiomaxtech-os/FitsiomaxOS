import { useCallback, useEffect, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { getLeadsAnalytics } from "@/lib/api";
import { LedgerCard } from "@/components/ui/ledger-card";

/**
 * Marketing Head's leads dashboard — eight cards, each answering one decision.
 *
 * Leads only: no revenue, no session or treatment counts. What a marketing desk asks is
 * how many arrived, where from, when, and how far they got; putting money on the same
 * screen invites reading a source's worth off charts that never priced anything.
 *
 * On colour, which is where a dashboard like this usually goes wrong: hue is used where it
 * carries identity nothing else does — the slices of a donut, the two lines of a split
 * trend, the two series of a grouped bar. The single-measure bar charts stay one hue
 * because their axis already names every bar, so a second colour per bar would be
 * decoration double-encoding the length the bar is already showing. The funnel is the one
 * ordered scale, so it takes a graded ramp. Every palette here was run through the
 * validator against this app's white surface rather than eyeballed.
 */

/* Ink and chrome. Text never wears a series colour — the coloured mark beside it carries
   identity, and several of these hues are illegible as type on white. */
const INK = { secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SURFACE = "#ffffff";

/* The validated 8-slot categorical order. Assigned in this fixed order, never cycled past
   eight and never generated — a ninth hue is indistinguishable from one of these under
   colour-blindness. On white: worst adjacent CVD ΔE 9.1, worst adjacent normal-vision
   ΔE 19.6. Three slots (aqua, yellow, magenta) sit under 3:1 against white, which
   obligates visible labels — every chart using them carries a legend with values, and the
   value labels on the bars carry the figures. */
const CATEGORICAL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/* Single-series hue: categorical slot 1. */
const SERIES = CATEGORICAL[0];

const nf = (n) => Number(n || 0).toLocaleString("en-IN");

/** "2026-08-17" -> "17 Aug"; "2026-08" -> "Aug 26". Axis ticks, so kept short. */
const shortPeriod = (p) => {
  const parts = String(p || "").split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[Number(parts[1]) - 1] || "";
  if (parts.length === 3) return `${Number(parts[2])} ${m}`;
  return `${m} ${String(parts[0]).slice(2)}`;
};

/** The server sends only days (or months) that had leads. A line drawn through those
 *  alone runs straight from Monday to Thursday as though Tuesday and Wednesday never
 *  happened, so the gaps are put back as zeros, first bucket to last. */
const fillTrend = (rows, grain) => {
  if (rows.length < 2) return rows;
  const have = new Map(rows.map((r) => [r.period, r]));
  const out = [];
  if (grain === "month") {
    let [y, m] = rows[0].period.split("-").map(Number);
    const [ey, em] = rows[rows.length - 1].period.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      out.push(have.get(key) || { period: key, leads: 0, offline: 0, online: 0 });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  const d = new Date(`${rows[0].period}T00:00:00Z`);
  const end = new Date(`${rows[rows.length - 1].period}T00:00:00Z`);
  while (d <= end) {
    const key = d.toISOString().slice(0, 10);
    out.push(have.get(key) || { period: key, leads: 0, offline: 0, online: 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

/* ── chrome ─────────────────────────────────────────────────────────────────────── */

const Card = ({ title, sub, children, className = "", testid }) => (
  <div className={`flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm ${className}`} data-testid={testid}>
    <div className="border-b border-slate-100 px-5 py-3.5">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
    <div className="flex-1 px-5 py-4">{children}</div>
  </div>
);

const Empty = ({ children }) => <p className="py-10 text-center text-sm text-slate-400">{children}</p>;

const VizTooltip = ({ active, payload, label, labelFormat, unit = "lead" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{labelFormat ? labelFormat(label) : label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-slate-600">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: p.color || p.payload?.fill }} />
          {p.name}: <span className="font-medium text-slate-800">{nf(p.value)}</span>
          {unit === "pct" ? "%" : ""}
        </p>
      ))}
    </div>
  );
};

/** A legend that also carries the values — the identity channel and the relief for the
 *  three light hues at once, so nothing rests on colour or a hover alone. */
const ValueLegend = ({ rows, colorAt, total }) => (
  <ul className="space-y-1.5" data-testid="viz-legend">
    {rows.map((r, i) => (
      <li key={r.name} className="flex items-center gap-2 text-xs">
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorAt(i) }} />
        <span className="min-w-0 flex-1 truncate text-slate-600" title={r.name}>{r.name}</span>
        <span className="shrink-0 font-semibold tabular-nums text-slate-800">{nf(r.value)}</span>
        {total > 0 && (
          <span className="w-9 shrink-0 text-right tabular-nums text-slate-400">
            {Math.round((r.value / total) * 100)}%
          </span>
        )}
      </li>
    ))}
  </ul>
);

const ValueTable = ({ rows, firstHeading, labelFormat, columns }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
        <tr>
          <th className="py-1.5 pr-3">{firstHeading}</th>
          {(columns || [{ key: "value", label: "Leads" }]).map((c) => (
            <th key={c.key} className="py-1.5 text-right">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.name || r.period}>
            <td className="py-1.5 pr-3 text-slate-700">{labelFormat ? labelFormat(r.period) : r.name}</td>
            {(columns || [{ key: "value", label: "Leads" }]).map((c) => (
              <td key={c.key} className="py-1.5 text-right font-medium tabular-nums text-slate-800">
                {nf(r[c.key] ?? r.leads ?? 0)}{c.pct ? "%" : ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/* ── forms ──────────────────────────────────────────────────────────────────────── */

/** Horizontal bars, one hue — the axis names each bar, so a hue per bar would only
 *  restate the length. `ramp` overrides it for an ordered scale (the funnel). */
const RankedBars = ({ rows, ramp, valueKey = "value", suffix = "", color = SERIES }) => (
  // Height grows with the rows rather than being fixed, so the axis band is never what
  // gets cut off and left in a nested scrollbar.
  <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 40 + 24)}>
    <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 4 }}>
      {/* No grid: the track behind each bar already gives the scale. */}
      <XAxis type="number" hide />
      <YAxis
        type="category"
        dataKey="name"
        // Wide enough that "Anna Nagar Branch" sits on one line rather than breaking in two.
        width={150}
        tick={{ fill: INK.secondary, fontSize: 12 }}
        tickLine={false}
        axisLine={false}
      />
      <Tooltip content={<VizTooltip unit={suffix ? "pct" : "lead"} />} cursor={{ fill: "rgba(11,11,11,0.04)" }} />
      {/* 4px round on the data end, square at the baseline; capped so a wide card leaves
          air in the band rather than one fat block. */}
      {/* A pale full-length track behind each bar, so every row reads against the same
          scale and a short bar still shows where its row is. */}
      <Bar dataKey={valueKey} radius={[0, 6, 6, 0]} maxBarSize={18} background={{ fill: "#f1f5f9", radius: 6 }} isAnimationActive={false}>
        {rows.map((r, i) => <Cell key={r.name} fill={ramp ? ramp[i] : color} />)}
        {/* Outside the bar end — a short bar has no room inside, and a clipped label is
            worse than none. */}
        <LabelList
          dataKey={valueKey}
          position="right"
          offset={8}
          className="fill-slate-600"
          style={{ fontSize: 11, fontWeight: 600 }}
          formatter={(v) => `${nf(v)}${suffix}`}
        />
      </Bar>
    </BarChart>
  </ResponsiveContainer>
);

/* The two branch cards are plain markup rather than a chart: name, bar and figures
 * each sit in a fixed column, so every row lines up on the same edges whatever the name
 * length -- which an SVG axis could not promise. */

const pctOf = (part, whole) => {
  if (!whole) return "—";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

const BOOKED = CATEGORICAL[2];
const CAME = "#0e7490";

const HeadRow = ({ cols, children }) => (
  <div className={`grid ${cols} items-end gap-x-4 border-b border-slate-100 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400`}>
    {children}
  </div>
);

const TotalRow = ({ cols, children }) => (
  <div className={`grid ${cols} items-center gap-x-4 border-t border-slate-200 pt-3 text-[13px] font-semibold text-slate-900`}>
    {children}
  </div>
);

const BranchName = ({ name }) => (
  <span className={`truncate text-[13px] font-medium ${name === "Unassigned" ? "italic text-slate-400" : "text-slate-700"}`}>
    {name}
  </span>
);

const Dot = ({ color, children }) => (
  <span className="flex items-center gap-1.5">
    <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
    {children}
  </span>
);

/** Leads and appointments booked per branch on one row: "T Nagar · 554 leads · 6 booked". */
const LEADS_COLS = "grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3.75rem_3.75rem_3.25rem]";
const BranchLeadsList = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  const maxBooked = Math.max(1, ...rows.map((r) => r.booked));
  const sum = rows.reduce((a, r) => ({ leads: a.leads + r.leads, booked: a.booked + r.booked }), { leads: 0, booked: 0 });
  return (
    <div className="flex flex-col">
      <HeadRow cols={LEADS_COLS}>
        <span>Branch</span>
        <span className="flex items-center gap-3 font-medium normal-case tracking-normal">
          <Dot color={SERIES}>Leads</Dot>
          <Dot color={BOOKED}>Booked</Dot>
        </span>
        <span className="text-right">Leads</span>
        <span className="text-right">Booked</span>
        <span className="text-right">Rate</span>
      </HeadRow>
      <ul className="divide-y divide-slate-50">
        {rows.map((r) => (
          <li
            key={r.name}
            title={`${r.name}: ${nf(r.leads)} leads, ${nf(r.booked)} booked (${pctOf(r.booked, r.leads)})`}
            className={`grid ${LEADS_COLS} items-center gap-x-4 py-2.5`}
          >
            <BranchName name={r.name} />
            {/* Two lines per branch: leads on top, booked underneath. Each line is scaled to
                its own biggest branch -- on the leads scale a booking count of 6 would not
                draw at all -- and the Rate column carries the booked-to-leads ratio. */}
            <span className="flex flex-col gap-1.5">
              <span className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${r.leads ? Math.max(1.5, (r.leads / max) * 100) : 0}%`, background: r.name === "Unassigned" ? "#94a3b8" : SERIES }}
                />
              </span>
              <span className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${r.booked ? Math.max(1.5, (r.booked / maxBooked) * 100) : 0}%`, background: BOOKED }}
                />
              </span>
            </span>
            <span className="text-right text-[13px] font-semibold tabular-nums text-slate-900">{nf(r.leads)}</span>
            <span className={`text-right text-[13px] font-semibold tabular-nums ${r.booked ? "text-emerald-700" : "text-slate-300"}`}>{nf(r.booked)}</span>
            <span className="text-right text-xs tabular-nums text-slate-500">{pctOf(r.booked, r.leads)}</span>
          </li>
        ))}
      </ul>
      <TotalRow cols={LEADS_COLS}>
        <span>All branches</span>
        <span />
        <span className="text-right tabular-nums">{nf(sum.leads)}</span>
        <span className="text-right tabular-nums text-emerald-700">{nf(sum.booked)}</span>
        <span className="text-right text-xs tabular-nums text-slate-500">{pctOf(sum.booked, sum.leads)}</span>
      </TotalRow>
    </div>
  );
};

/** Per branch: appointments booked, and how many of them came for the consultation.
 *  Only the bars are on the card; the figures behind a row open on hover, so the card
 *  reads as a comparison at a glance and the numbers are there when they are wanted. */
const FUNNEL_COLS = "grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)]";
const HoverStat = ({ color, label, value, note }) => (
  <div className="flex items-center justify-between gap-6">
    <span className="flex items-center gap-1.5 text-slate-500">
      <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
    <span className="tabular-nums">
      <span className="font-semibold text-slate-900">{nf(value)}</span>
      {note && <span className="ml-1.5 text-slate-400">{note}</span>}
    </span>
  </div>
);
const BranchFunnelList = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.booked, r.consulted)));
  const w = (v) => `${v ? Math.max(1.5, (v / max) * 100) : 0}%`;
  return (
    <div className="flex flex-col">
      <HeadRow cols={FUNNEL_COLS}>
        <span>Branch</span>
        <span className="flex items-center gap-x-3 font-medium normal-case tracking-normal">
          <Dot color={BOOKED}>Booked</Dot>
          <Dot color={CAME}>Came for consultation</Dot>
        </span>
      </HeadRow>
      <ul className="divide-y divide-slate-50">
        {rows.map((r, i) => (
          <li
            key={r.name}
            tabIndex={0}
            className={`group relative grid ${FUNNEL_COLS} cursor-default items-center gap-x-4 rounded-md py-3 outline-none hover:bg-slate-50/70 focus-visible:bg-slate-50/70`}
          >
            <BranchName name={r.name} />
            {/* Two bars on one scale, so the drop from booked to came is the gap you see. */}
            <span className="flex flex-col gap-1.5 pr-1">
              {[[r.booked, BOOKED], [r.consulted, CAME]].map(([v, c], k) => (
                <span key={k} className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <span className="block h-full rounded-full" style={{ width: w(v), background: c }} />
                </span>
              ))}
            </span>
            {/* The row's figures, on hover or keyboard focus. Opens upward on the last
                rows so it never runs off the bottom of the card. */}
            <div
              role="tooltip"
              className={`pointer-events-none absolute right-2 z-20 w-56 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-xs opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 ${
                i >= rows.length - 2 && rows.length > 2 ? "bottom-full mb-1" : "top-full mt-1"
              }`}
            >
              <p className="mb-2 truncate text-[13px] font-semibold text-slate-800">{r.name}</p>
              <div className="flex flex-col gap-1.5">
                <HoverStat color={BOOKED} label="Booked" value={r.booked} />
                <HoverStat color={CAME} label="Came" value={r.consulted} note={`${pctOf(r.consulted, r.booked)} of booked`} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Vertical columns in a fixed order (calendar), one hue. */
const OrderedColumns = ({ rows }) => (
  <ResponsiveContainer width="100%" height={220}>
    <BarChart data={rows} margin={{ top: 16, right: 8, bottom: 4, left: 0 }}>
      <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />
      <XAxis dataKey="name" tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: INK.axis }} />
      <YAxis allowDecimals={false} tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
      <Tooltip content={<VizTooltip />} cursor={{ fill: "rgba(11,11,11,0.04)" }} />
      <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={24} fill={SERIES} isAnimationActive={false}>
        <LabelList dataKey="value" position="top" offset={6} className="fill-slate-600" style={{ fontSize: 11, fontWeight: 600 }} formatter={nf} />
      </Bar>
    </BarChart>
  </ResponsiveContainer>
);

/** Donut + value legend. Part-to-whole at a glance, capped at seven slices including
 *  Other — past that the ring stops being readable whatever the palette can hold.
 *  Slices take the palette in ring order: for a donut, adjacent separation is what the
 *  validated order guarantees, and the legend states the mapping either way. */
const DonutWithLegend = ({ rows, total }) => (
  <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie
          data={rows}
          dataKey="value"
          nameKey="name"
          innerRadius={48}
          outerRadius={78}
          /* A 2px ring in the surface colour does the separating — never a stroke drawn
             around each slice to outline it. */
          stroke={SURFACE}
          strokeWidth={2}
          isAnimationActive={false}
        >
          {rows.map((r, i) => <Cell key={r.name} fill={CATEGORICAL[i % CATEGORICAL.length]} />)}
        </Pie>
        <Tooltip content={<VizTooltip />} />
      </PieChart>
    </ResponsiveContainer>
    <ValueLegend rows={rows} colorAt={(i) => CATEGORICAL[i % CATEGORICAL.length]} total={total} />
  </div>
);

/* ── the dashboard ──────────────────────────────────────────────────────────────── */

export const LeadsAnalyticsDashboard = ({ startDate, endDate, branchIds }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The charts only: the Numbers table toggle was taken off the toolbar at the desk's request.
  const asTable = false;

  const branchKey = (branchIds || []).join(",");

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    if (branchKey) params.branch_ids = branchKey;
    getLeadsAnalytics(params)
      .then((rows) => { setData(rows); setFailed(false); })
      .catch(() => { setData(null); setFailed(true); })
      .finally(() => setLoading(false));
  }, [startDate, endDate, branchKey]);

  useEffect(() => { load(); }, [load]);


  if (loading && !data) return <p className="py-10 text-center text-sm text-slate-400">Loading…</p>;
  if (failed) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800" data-testid="leads-analytics-failed">
        This dashboard could not be loaded. Refresh to try again — if it keeps happening, this account may not have access to the org-wide numbers.
      </p>
    );
  }

  const total = Number(data?.total || 0);
  const booked = Number(data?.booked || 0);
  const trend = fillTrend(data?.trend || [], data?.grain);
  const byBranch = data?.by_branch || [];
  const branchFunnel = data?.branch_funnel || [];
  // Only branches with something past the lead stage, most bookings first.
  const funnelRows = branchFunnel
    .filter((r) => r.booked || r.consulted)
    .slice()
    .sort((a, b) => b.booked - a.booked || b.consulted - a.consulted);
  const funnelBooked = funnelRows.reduce((a, r) => a + r.booked, 0);
  const funnelCame = funnelRows.reduce((a, r) => a + r.consulted, 0);
  const byVertical = data?.by_vertical || [];
  const byWeekday = data?.by_weekday || [];
  const byOwner = data?.by_owner || [];
  const conversion = data?.conversion_by_source || [];
  const grainLabel = data?.grain === "month" ? "by month" : "by day";
  const hasOnline = trend.some((t) => Number(t.online || 0) > 0);
  const offlineTotal = trend.reduce((n, t) => n + Number(t.offline || 0), 0);
  const onlineTotal = trend.reduce((n, t) => n + Number(t.online || 0), 0);
  const bookingRate = total > 0 ? Math.round((booked / total) * 1000) / 10 : 0;
  // One or two buckets (Today, Yesterday) make a line of a single dot that reads as an
  // empty chart; columns show the same counts as something that can be seen.
  const fewPoints = trend.length <= 2;

  return (
    // Held at reduced opacity while refetching rather than swapped for a skeleton: the
    // layout stays put and the previous answer stays readable.
    <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`} data-testid="leads-analytics-dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="leads-analytics-kpis">
        <LedgerCard label="Leads" value={nf(total)} sub="in this range" testid="leads-analytics-kpi-total" />
        <LedgerCard label="Reached a booking" value={nf(booked)} sub="have an appointment date" testid="leads-analytics-kpi-booked" />
        <LedgerCard label="Booking rate" value={`${bookingRate}%`} sub="booked ÷ leads" testid="leads-analytics-kpi-rate" />
        <LedgerCard label="Offline" value={nf(offlineTotal)} sub="clinic services" muted={!offlineTotal} testid="leads-analytics-kpi-offline" />
        <LedgerCard label="Online" value={nf(onlineTotal)} sub="online services" muted={!onlineTotal} testid="leads-analytics-kpi-online" />
      </div>

      {/* 1 — when leads arrive, offline against online */}
      <Card title="Leads over time" sub={`When they arrived, ${grainLabel}`} testid="leads-analytics-trend">
        {trend.length === 0 ? <Empty>No leads arrived in this range.</Empty> : asTable ? (
          <ValueTable
            rows={trend}
            firstHeading={data?.grain === "month" ? "Month" : "Day"}
            labelFormat={shortPeriod}
            columns={[{ key: "offline", label: "Offline" }, { key: "online", label: "Online" }, { key: "leads", label: "Total" }]}
          />
        ) : (
          <>
            {/* Two series, so a legend is not optional — identity never rests on
                colour-matching alone. */}
            {hasOnline && (
              <div className="mb-2 flex items-center gap-4 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORICAL[0] }} />Offline</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORICAL[1] }} />Online</span>
              </div>
            )}
            {fewPoints ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trend} margin={{ top: 20, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />
                  <XAxis dataKey="period" tickFormatter={shortPeriod} tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: INK.axis }} />
                  <YAxis allowDecimals={false} tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                  <Tooltip content={<VizTooltip labelFormat={shortPeriod} />} cursor={{ fill: "rgba(11,11,11,0.04)" }} />
                  <Bar dataKey="offline" name="Offline" fill={CATEGORICAL[0]} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                    <LabelList dataKey="offline" position="top" offset={6} className="fill-slate-600" style={{ fontSize: 11, fontWeight: 600 }} formatter={nf} />
                  </Bar>
                  {hasOnline && (
                    <Bar dataKey="online" name="Online" fill={CATEGORICAL[1]} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                      <LabelList dataKey="online" position="top" offset={6} className="fill-slate-600" style={{ fontSize: 11, fontWeight: 600 }} formatter={nf} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />
                <XAxis dataKey="period" tickFormatter={shortPeriod} tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: INK.axis }} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fill: INK.muted, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip content={<VizTooltip labelFormat={shortPeriod} />} />
                {/* 2px, no marker per point — a dot on every day is noise at this density;
                    the active dot carries the hover, ringed in the surface colour. */}
                <Line type="monotone" dataKey="offline" name="Offline" stroke={CATEGORICAL[0]} strokeWidth={2} strokeLinecap="round" dot={trend.length <= 31 ? { r: 2.5, fill: CATEGORICAL[0], strokeWidth: 0 } : false} activeDot={{ r: 4, fill: CATEGORICAL[0], stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
                {hasOnline && (
                  <Line type="monotone" dataKey="online" name="Online" stroke={CATEGORICAL[1]} strokeWidth={2} strokeLinecap="round" dot={trend.length <= 31 ? { r: 2.5, fill: CATEGORICAL[1], strokeWidth: 0 } : false} activeDot={{ r: 4, fill: CATEGORICAL[1], stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 2 — which branches the demand lands on, and how much of it books */}
        <Card title="Leads & appointments by branch" sub={`${nf(total)} leads · ${nf(booked)} with an appointment booked`} testid="leads-analytics-branches">
          {branchFunnel.length === 0 ? <Empty>No leads to split by branch.</Empty> : asTable ? (
            <ValueTable rows={branchFunnel.map((r) => ({ name: r.name, value: r.leads }))} firstHeading="Branch" />
          ) : (
            <BranchLeadsList rows={branchFunnel} />
          )}
        </Card>

        {/* 3 — of those booked, who came for the consultation */}
        <Card
          title="Appointment ratio by branch"
          sub={`${nf(funnelBooked)} booked · ${nf(funnelCame)} came for consultation (${pctOf(funnelCame, funnelBooked)}) · hover a branch for its figures`}
          testid="leads-analytics-appointments-branch"
        >
          {funnelRows.length === 0 ? <Empty>No appointments booked in this range.</Empty> : asTable ? (
            <ValueTable rows={funnelRows.map((r) => ({ name: r.name, value: r.booked }))} firstHeading="Branch" />
          ) : (
            <BranchFunnelList rows={funnelRows} />
          )}
        </Card>

        {/* 4 — which service the demand is for */}
        <Card title="Service mix" sub="Which vertical the leads asked for" testid="leads-analytics-verticals">
          {byVertical.length === 0 ? <Empty>No verticals recorded in this range.</Empty> : asTable ? (
            <ValueTable rows={byVertical} firstHeading="Vertical" />
          ) : (
            <DonutWithLegend rows={byVertical} total={total} />
          )}
        </Card>

        {/* 5 — which channels are worth the spend, not just the volume */}
        <Card title="Booking rate by source" sub="Share of a source's leads that reached a booking · sources with 5+ leads" testid="leads-analytics-conversion">
          {conversion.length === 0 ? <Empty>Not enough leads per source to compare rates yet.</Empty> : asTable ? (
            <ValueTable
              rows={conversion}
              firstHeading="Source"
              columns={[{ key: "leads", label: "Leads" }, { key: "booked", label: "Booked" }, { key: "rate", label: "Rate", pct: true }]}
            />
          ) : (
            // The rate is the bar; leads and booked ride the tooltip and the table, so a
            // strong rate off a handful of leads can always be checked.
            <RankedBars rows={conversion} valueKey="rate" suffix="%" />
          )}
        </Card>

        {/* 7 — when to staff the desk and run the spend */}
        <Card title="Which days run hot" sub="Leads by day of week, across the range" testid="leads-analytics-weekday">
          {byWeekday.length === 0 ? <Empty>No dated leads in this range.</Empty> : asTable ? (
            <ValueTable rows={byWeekday} firstHeading="Day" />
          ) : (
            <OrderedColumns rows={byWeekday} />
          )}
        </Card>

        {/* 8 — whether the book is spread evenly across the desk */}
        <Card title="Leads per owner" sub="How the book is spread across the desk" className="lg:col-span-2" testid="leads-analytics-owners">
          {byOwner.length === 0 ? <Empty>No owners recorded in this range.</Empty> : asTable ? (
            <ValueTable rows={byOwner} firstHeading="Owner" />
          ) : (
            <RankedBars rows={byOwner} />
          )}
        </Card>
      </div>
    </div>
  );
};

export default LeadsAnalyticsDashboard;
