import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
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

/* ── over time, per branch ──────────────────────────────────────────────────────── */

/** ₹ in the Indian grouping the desk reads: ₹45k, ₹1.6L, ₹2.3Cr on an axis; the full
 *  ₹1,64,690 in the hover card. */
const inr = (n) => `₹${Math.round(Number(n || 0)).toLocaleString("en-IN")}`;
const inrShort = (n) => {
  const v = Number(n || 0);
  const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, "");
  if (v >= 1e7) return `₹${trim(v / 1e7)}Cr`;
  if (v >= 1e5) return `₹${trim(v / 1e5)}L`;
  if (v >= 1e3) return `₹${trim(v / 1e3)}k`;
  return `₹${Math.round(v)}`;
};
const countShort = (n) => (n >= 1000 ? `${Math.round((n / 1000) * 10) / 10}k` : String(n));

const longPeriod = (p) => {
  const parts = String(p || "").split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[Number(parts[1]) - 1] || "";
  if (parts.length === 3) return `${Number(parts[2])} ${m} ${parts[0]}`;
  return `${m} ${parts[0]}`;
};

/** The hover card for the over-time charts: the period on top, every branch that had
 *  anything that day biggest first with its coloured dash, and the day's total beneath a
 *  hairline. The highlighted branch, if one is picked in the legend, is lifted out. */
const TrendTooltip = ({ active, payload, label, money, focus }) => {
  if (!active || !payload?.length) return null;
  const rows = payload
    .filter((p) => Number(p.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const total = payload.reduce((a, p) => a + Number(p.value || 0), 0);
  const fmt = money ? inr : nf;
  return (
    <div className="min-w-[13rem] rounded-xl border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.22)] backdrop-blur-sm">
      <p className="mb-2 text-xs font-medium text-slate-500">{longPeriod(label)}</p>
      {rows.length === 0 ? (
        <p className="text-[13px] text-slate-400">Nothing on this {String(label).length > 7 ? "day" : "month"}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((p) => (
            <div
              key={p.dataKey}
              className={`flex items-baseline gap-2 whitespace-nowrap rounded-md transition-opacity ${focus && focus !== p.dataKey ? "opacity-40" : ""}`}
            >
              <span className="inline-block h-[2px] w-3 shrink-0 translate-y-[-3px] rounded-full" style={{ background: p.color }} />
              <span className="text-[13px] font-semibold tabular-nums text-slate-900">{fmt(p.value)}</span>
              <span className="truncate text-[13px] text-slate-500">{p.name}</span>
            </div>
          ))}
        </div>
      )}
      {payload.length > 1 && (
        <div className="mt-2 flex items-baseline justify-between border-t border-slate-100 pt-2 text-xs">
          <span className="text-slate-400">Total</span>
          <span className="font-semibold tabular-nums text-slate-800">{fmt(total)}</span>
        </div>
      )}
    </div>
  );
};


/** One over-time card. With several branches: a line each, and legend chips that carry
 *  the branch's total -- hover a chip to lift its line out of the others, click it to take
 *  the branch off the chart. With one branch: that branch alone, as a filled area. */
const BranchTrendCard = ({ title, sub, periods, series, money, emptyText, testid, single }) => {
  const names = Object.keys(series || {});
  const [hidden, setHidden] = useState(() => new Set());
  const [focus, setFocus] = useState(null);
  const color = (i) => CATEGORICAL[i % CATEGORICAL.length];
  const shown = names.filter((n) => !hidden.has(n));
  const rows = (periods || []).map((period, i) => {
    const row = { period };
    names.forEach((n) => { row[n] = series[n][i] || 0; });
    return row;
  });
  const totals = Object.fromEntries(names.map((n) => [n, series[n].reduce((a, v) => a + v, 0)]));
  const grand = shown.reduce((a, n) => a + totals[n], 0);
  const fmt = money ? inr : nf;
  const tick = money ? inrShort : countShort;
  const toggle = (n) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });
  const dense = rows.length > 31;
  const axisProps = {
    x: { dataKey: "period", tickFormatter: shortPeriod, tick: { fill: INK.muted, fontSize: 11 }, tickLine: false, axisLine: { stroke: INK.axis }, minTickGap: 24 },
    y: { allowDecimals: false, tickFormatter: tick, tick: { fill: INK.muted, fontSize: 11 }, tickLine: false, axisLine: false, width: money ? 52 : 40 },
  };
  const cursor = { stroke: "#94a3b8", strokeWidth: 1, strokeDasharray: "4 4" };

  return (
    <Card title={title} sub={sub} testid={testid}>
      {names.length === 0 || rows.length === 0 ? <Empty>{emptyText}</Empty> : (
        <div className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{single ? names[0] : "All branches"}</p>
              <p className="text-2xl font-semibold tabular-nums tracking-tight text-slate-900">{fmt(grand)}</p>
            </div>
          </div>

          {!single && (
            <div className="flex flex-wrap gap-1.5" onMouseLeave={() => setFocus(null)}>
              {names.map((n, i) => {
                const off = hidden.has(n);
                const lit = focus === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => toggle(n)}
                    onMouseEnter={() => setFocus(off ? null : n)}
                    aria-pressed={!off}
                    title={off ? `Show ${n}` : `Hide ${n}`}
                    className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all duration-200 ${
                      off
                        ? "border-dashed border-slate-200 bg-white text-slate-400"
                        : lit
                          ? "border-transparent bg-white text-slate-900 shadow-[0_4px_14px_-4px_rgba(15,23,42,0.25)] ring-1 ring-slate-200"
                          : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-white"
                    }`}
                  >
                    <span className="inline-block h-2 w-2 rounded-full transition-transform duration-200 group-hover:scale-125" style={{ background: off ? "#cbd5e1" : color(i) }} />
                    <span className={off ? "line-through" : ""}>{n}</span>
                    <span className="font-semibold tabular-nums text-slate-400">{tick(totals[n])}</span>
                  </button>
                );
              })}
            </div>
          )}

          <ResponsiveContainer width="100%" height={240}>
            {single ? (
              <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <defs>
                  <linearGradient id={`fill-${testid}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={money ? CATEGORICAL[2] : SERIES} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={money ? CATEGORICAL[2] : SERIES} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />
                <XAxis {...axisProps.x} />
                <YAxis {...axisProps.y} />
                <Tooltip content={<TrendTooltip money={money} />} cursor={cursor} />
                <Area
                  type="monotone"
                  dataKey={names[0]}
                  name={names[0]}
                  stroke={money ? CATEGORICAL[2] : SERIES}
                  strokeWidth={2.25}
                  fill={`url(#fill-${testid})`}
                  // Today or Yesterday is one point, and a line of one point draws nothing.
                  dot={rows.length <= 2 ? { r: 4, fill: money ? CATEGORICAL[2] : SERIES, strokeWidth: 0 } : false}
                  activeDot={{ r: 5, fill: money ? CATEGORICAL[2] : SERIES, stroke: SURFACE, strokeWidth: 2.5 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            ) : (
              <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />
                <XAxis {...axisProps.x} />
                <YAxis {...axisProps.y} />
                <Tooltip content={<TrendTooltip money={money} focus={focus} />} cursor={cursor} />
                {names.map((n, i) => (hidden.has(n) ? null : (
                  <Line
                    key={n}
                    type="monotone"
                    dataKey={n}
                    name={n}
                    stroke={color(i)}
                    strokeWidth={focus === n ? 3 : 2}
                    strokeOpacity={focus && focus !== n ? 0.18 : 1}
                    strokeLinecap="round"
                    dot={dense ? false : { r: 2.5, fill: color(i), strokeWidth: 0 }}
                    activeDot={focus && focus !== n ? false : { r: 4.5, fill: color(i), stroke: SURFACE, strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                )))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
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

/* The two branch cards are plain markup rather than a chart: name and bars sit in fixed
 * columns, so every row lines up on the same edges whatever the name length -- which an
 * SVG axis could not promise. The figures behind a row open beside the cursor on hover. */

const pctOf = (part, whole) => {
  if (!whole) return "—";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

const BOOKED = CATEGORICAL[2];
const CAME = "#0e7490";
const ROW_COLS = "grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)]";

const HeadRow = ({ children }) => (
  <div className={`grid ${ROW_COLS} items-end gap-x-4 border-b border-slate-100 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400`}>
    {children}
  </div>
);

const BranchName = ({ name, strong, active }) => (
  <span
    className={`truncate text-[13px] transition-colors duration-200 ${strong ? "font-semibold" : "font-medium"} ${
      active ? "text-blue-800" : name === "Unassigned" ? "italic text-slate-400" : strong ? "text-slate-900" : "text-slate-700"
    }`}
  >
    {name}
  </span>
);

const Dot = ({ color, children }) => (
  <span className="flex items-center gap-1.5">
    <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
    {children}
  </span>
);

const Track = ({ value, max, color, h = "h-2" }) => (
  <span className={`${h} w-full overflow-hidden rounded-full bg-slate-100`}>
    <span className="block h-full rounded-full" style={{ width: `${value ? Math.max(1.5, (value / max) * 100) : 0}%`, background: color }} />
  </span>
);

/** One line of the hover card, styled as the Finance charts' tooltip: a short coloured
 *  dash, the figure in bold, what it counts, and a quiet ratio after it. */
const HoverStat = ({ color, label, value, note }) => (
  <div className="flex items-baseline gap-2 whitespace-nowrap">
    <span className="inline-block h-[2px] w-3 shrink-0 translate-y-[-3px] rounded-full" style={{ background: color }} />
    <span className="text-[13px] font-semibold tabular-nums text-slate-900">{nf(value)}</span>
    <span className="text-[13px] text-slate-500">{label}</span>
    {note && <span className="ml-auto pl-3 text-[11px] tabular-nums text-slate-400">{note}</span>}
  </div>
);

/** Round tick steps (1, 2, 2.5, 5 x 10^n) so the axis reads 0 · 400 · 800 · 1,200 rather
 *  than 0 · 397 · 794. Bars are drawn against the top tick so they sit on the same scale. */
const niceScale = (max, count = 4) => {
  const raw = Math.max(1, max) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || 10 * mag;
  const top = Math.max(step, Math.ceil(Math.max(1, max) / step) * step);
  const ticks = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  return { top, ticks };
};
const compact = (n) => (n >= 1000 ? `${Math.round((n / 1000) * 10) / 10}k` : nf(n));

/** A row list whose hover card follows the pointer. `rows` are { key, label, bars, stats,
 *  strong }. The hovered row lifts onto a soft band so the eye keeps its place as the
 *  pointer travels down the list; `scale`, when given, draws round-number ticks along the
 *  foot of the bar column with faint guides up through the rows. */
const TIP_W = 248;
const HoverRows = ({ head, rows, scale, hint }) => {
  const [tip, setTip] = useState(null);
  const box = useRef(null);
  const move = (row) => (e) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const left = x + 18 + TIP_W > rect.width ? x - 18 - TIP_W : x + 18;
    const flipUp = y > rect.height - 110;
    setTip({ row, left: Math.max(0, left), top: flipUp ? y - 14 : y + 18, flipUp });
  };
  const guides = scale && (
    <span className="pointer-events-none absolute inset-0" aria-hidden="true">
      {scale.ticks.slice(1, -1).map((t) => (
        <span key={t} className="absolute inset-y-0 w-px bg-slate-100" style={{ left: `${(t / scale.top) * 100}%` }} />
      ))}
    </span>
  );
  return (
    <div ref={box} className="relative flex flex-col" onMouseLeave={() => setTip(null)}>
      <HeadRow>{head}</HeadRow>
      <ul className="py-1">
        {rows.map((row) => {
          const on = tip?.row.key === row.key;
          return (
            <li
              key={row.key}
              onMouseMove={move(row)}
              className={`relative grid ${ROW_COLS} cursor-default items-center gap-x-4 rounded-lg px-3 -mx-3 py-3 transition-all duration-200 ${
                on
                  // The hovered row lifts onto a soft blue wash with an accent edge, so the eye
                  // keeps its place as the pointer travels down the list.
                  ? "bg-gradient-to-r from-blue-50 via-indigo-50/60 to-white shadow-[inset_0_0_0_1px_rgba(59,130,246,0.14)]"
                  : ""
              } ${row.strong ? "mb-1 border-b border-slate-200 rounded-b-none" : ""}`}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-y-2 left-0 w-[3px] rounded-full bg-gradient-to-b from-blue-500 to-indigo-500 transition-opacity duration-200 ${on ? "opacity-100" : "opacity-0"}`}
              />
              <BranchName name={row.label} strong={row.strong} active={on} />
              <span className="relative flex flex-col gap-1.5 pr-1">
                {guides}
                {row.bars}
              </span>
            </li>
          );
        })}
      </ul>
      {scale && (
        <div className={`grid ${ROW_COLS} gap-x-4 border-t border-slate-100 pt-2`}>
          <span />
          <span className="relative mr-1 h-4 text-[11px] tabular-nums text-slate-400">
            {scale.ticks.map((t, i) => (
              <span
                key={t}
                className="absolute top-0"
                style={{
                  left: `${(t / scale.top) * 100}%`,
                  transform: i === 0 ? "none" : i === scale.ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {compact(t)}
              </span>
            ))}
          </span>
        </div>
      )}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-30 rounded-xl border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.18)] backdrop-blur-sm"
          style={{ left: tip.left, top: tip.top, width: TIP_W, transform: tip.flipUp ? "translateY(-100%)" : undefined }}
        >
          <p className="mb-1.5 truncate text-xs font-medium text-slate-500">{tip.row.title || tip.row.label}</p>
          <div className="flex flex-col gap-1">{tip.row.stats}</div>
          {hint && <p className="mt-2 text-[11px] text-slate-400">{hint}</p>}
        </div>
      )}
    </div>
  );
};

/** Leads and appointments booked per branch, two lines each. Each line is scaled to its
 *  own biggest branch -- on the leads scale a booking count of 6 would not draw at all --
 *  and the hover card gives the ratio between them. */
const BranchLeadsList = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  const maxBooked = Math.max(1, ...rows.map((r) => r.booked));
  return (
    <HoverRows
      head={
        <>
          <span>Branch</span>
          <span className="flex items-center gap-3 font-medium normal-case tracking-normal">
            <Dot color={SERIES}>Leads</Dot>
            <Dot color={BOOKED}>Booked</Dot>
          </span>
        </>
      }
      rows={rows.map((r) => ({
        key: r.name,
        label: r.name,
        bars: (
          <>
            <Track value={r.leads} max={max} color={r.name === "Unassigned" ? "#94a3b8" : SERIES} />
            <Track value={r.booked} max={maxBooked} color={BOOKED} />
          </>
        ),
        stats: (
          <>
            <HoverStat color={SERIES} label="leads" value={r.leads} />
            <HoverStat color={BOOKED} label="booked" value={r.booked} note={`${pctOf(r.booked, r.leads)} of leads`} />
          </>
        ),
      }))}
    />
  );
};

/** One branch picked: Total leads, then the four pre-sales stages the desk works from --
 *  RNR, Follow Up, Appointment, Lost -- each on the total's scale. */
const STAGE_PICK = ["RNR", "Follow Up", "Appointment", "Lost"];
const StageLeadsList = ({ total, stages }) => {
  const count = Object.fromEntries(stages.map((st) => [st.name, st.value]));
  const scale = niceScale(total);
  return (
    <HoverRows
      scale={scale}
      head={
        <>
          <span>Pre-sales stage</span>
          <span className="flex items-center gap-3 font-medium normal-case tracking-normal">
            <Dot color={SERIES}>Leads</Dot>
          </span>
        </>
      }
      rows={[
        {
          key: "__total",
          label: "Total leads",
          strong: true,
          bars: <Track value={total} max={scale.top} color="#1e4f8f" h="h-2.5" />,
          stats: <HoverStat color="#1e4f8f" label="leads" value={total} />,
        },
        ...STAGE_PICK.map((name) => ({
          key: name,
          label: name,
          bars: <Track value={count[name] || 0} max={scale.top} color={SERIES} />,
          stats: <HoverStat color={SERIES} label="leads" value={count[name] || 0} note={`${pctOf(count[name] || 0, total)} of total`} />,
        })),
      ]}
    />
  );
};

/** Per branch: appointments booked -> came in -> consultation fee paid -> session fee
 *  paid. Four thin bars on one scale, so each drop is the gap you see; the hover card
 *  gives each step as a share of the step before it. */
const CONSULT_PAID = "#4a3aa7";
const SESSION_PAID = "#eda100";
const FUNNEL_STEPS = [
  { key: "booked", label: "Booked", color: BOOKED },
  { key: "came", label: "Came for consultation", short: "came", color: CAME, of: "booked" },
  { key: "consulted", label: "Consultation paid", short: "consultation paid", color: CONSULT_PAID, of: "came" },
  { key: "session_paid", label: "Session paid", short: "session paid", color: SESSION_PAID, of: "consulted" },
];
const STEP_OF_LABEL = { booked: "booked", came: "came", consulted: "consultation paid" };
const BRANCH_STEPS = FUNNEL_STEPS.slice(0, 2);
const BranchFunnelList = ({ rows }) => {
  const scale = niceScale(Math.max(1, ...rows.map((r) => Math.max(...BRANCH_STEPS.map((st) => r[st.key] || 0)))));
  return (
    <HoverRows
      scale={scale}
      head={
        <>
          <span>Branch</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium normal-case tracking-normal">
            {BRANCH_STEPS.map((st) => <Dot key={st.key} color={st.color}>{st.label}</Dot>)}
          </span>
        </>
      }
      rows={rows.map((r) => ({
        key: r.name,
        label: r.name,
        bars: (
          <>
            {BRANCH_STEPS.map((st) => <Track key={st.key} value={r[st.key] || 0} max={scale.top} color={st.color} />)}
          </>
        ),
        stats: (
          <>
            {BRANCH_STEPS.map((st) => (
              <HoverStat
                key={st.key}
                color={st.color}
                label={st.short || "booked"}
                value={r[st.key] || 0}
                note={st.of ? `${pctOf(r[st.key] || 0, r[st.of] || 0)} of ${STEP_OF_LABEL[st.of]}` : undefined}
              />
            ))}
          </>
        ),
      }))}
    />
  );
};

/** One branch picked: its appointment funnel as four rows -- Booked, Came for
 *  consultation, Consultation paid, Session paid -- each bar on one scale, so the drop
 *  from one step to the next is the gap you see. A step's chip gives it as a share of the
 *  step before it. */
const StepFunnelList = ({ row }) => {
  const scale = niceScale(Math.max(1, ...FUNNEL_STEPS.map((st) => row[st.key] || 0)));
  return (
    <HoverRows
      head={
        <>
          <span>Step</span>
          <span className="font-medium normal-case tracking-normal">Leads at each step · share of the step before</span>
        </>
      }
      rows={FUNNEL_STEPS.map((st, i) => {
        const v = row[st.key] || 0;
        const prev = st.of ? row[st.of] || 0 : null;
        return {
          key: st.key,
          title: st.label,
          label: (
            <span className="flex items-center gap-2.5">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: st.color }}
              >
                {i + 1}
              </span>
              <span className="truncate">{st.label}</span>
            </span>
          ),
          bars: (
            <span className="flex items-center gap-3">
              <Track value={v} max={scale.top} color={st.color} h="h-2.5" />
              <span className="w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums text-slate-900">{nf(v)}</span>
              <span
                className="w-12 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums"
                style={prev === null ? { color: "transparent" } : { background: `${st.color}14`, color: st.color }}
              >
                {prev === null ? "—" : pctOf(v, prev)}
              </span>
            </span>
          ),
          stats: (
            <HoverStat
              color={st.color}
              label={st.short || "booked"}
              value={v}
              note={st.of ? `${pctOf(v, prev)} of ${STEP_OF_LABEL[st.of]}` : undefined}
            />
          ),
        };
      })}
    />
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
  const branchTrend = data?.branch_trend || { grain: "day", periods: [], leads: {}, revenue: {} };
  // The branch card lists real branches only. Leads with no branch are not a branch's
  // demand, and as the longest bar they squashed every row beneath them; their count is
  // said in the subtitle instead.
  const assignedBranches = branchFunnel.filter((r) => r.name !== "Unassigned");
  const unassignedLeads = branchFunnel.find((r) => r.name === "Unassigned")?.leads || 0;
  const assignedLeads = assignedBranches.reduce((a, r) => a + r.leads, 0);
  const assignedBooked = assignedBranches.reduce((a, r) => a + r.booked, 0);
  // One branch picked in the filter: the left card shows that branch's pre-sales stages
  // rather than a one-row branch list.
  const oneBranch = (branchIds || []).length === 1;
  const oneBranchName = oneBranch ? (branchFunnel[0]?.name || "This branch") : null;
  const byStage = (data?.by_stage || []).filter((st) => st.value > 0 || st.name !== "Not in the pipeline");
  // Only branches with something past the lead stage, most bookings first.
  const funnelRows = branchFunnel
    .filter((r) => r.booked || r.came || r.consulted || r.session_paid)
    .slice()
    .sort((a, b) => b.booked - a.booked || b.consulted - a.consulted);
  const funnelBooked = funnelRows.reduce((a, r) => a + r.booked, 0);
  const funnelCame = funnelRows.reduce((a, r) => a + (r.came || 0), 0);
  const funnelConsult = funnelRows.reduce((a, r) => a + (r.consulted || 0), 0);
  const funnelSession = funnelRows.reduce((a, r) => a + (r.session_paid || 0), 0);
  const byVertical = data?.by_vertical || [];
  const byWeekday = data?.by_weekday || [];
  const byOwner = data?.by_owner || [];
  const conversion = data?.conversion_by_source || [];
  const offlineTotal = trend.reduce((n, t) => n + Number(t.offline || 0), 0);
  const onlineTotal = trend.reduce((n, t) => n + Number(t.online || 0), 0);
  const bookingRate = total > 0 ? Math.round((booked / total) * 1000) / 10 : 0;

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

      {/* 1 — leads and revenue over time, a line per branch (or the one branch picked) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BranchTrendCard
          key={`leads-${branchKey}`}
          title="Leads over time"
          sub={`When they arrived, ${branchTrend.grain === "month" ? "by month" : "by day"}${oneBranch ? "" : " · per branch"}`}
          periods={branchTrend.periods}
          series={branchTrend.leads}
          single={oneBranch}
          emptyText="No leads arrived in this range."
          testid="leads-analytics-trend"
        />
        <BranchTrendCard
          key={`revenue-${branchKey}`}
          title="Revenue over time"
          sub={`Fees collected, on the day they were paid, ${branchTrend.grain === "month" ? "by month" : "by day"}${oneBranch ? "" : " · per branch"}`}
          periods={branchTrend.periods}
          series={branchTrend.revenue}
          money
          single={oneBranch}
          emptyText="No fees collected in this range."
          testid="leads-analytics-revenue-trend"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 2 — which branches the demand lands on, and how much of it books; with one
            branch picked, that branch's pre-sales stages instead */}
        {oneBranch ? (
          <Card title={`${oneBranchName} · pre-sales`} sub={`${nf(total)} leads · ${nf(booked)} with an appointment booked`} testid="leads-analytics-branches">
            {total === 0 ? <Empty>No leads for this branch in this range.</Empty> : <StageLeadsList total={total} stages={byStage} />}
          </Card>
        ) : (
          <Card
            title="Leads & appointments by branch"
            sub={`${nf(assignedLeads)} leads · ${nf(assignedBooked)} with an appointment booked${unassignedLeads ? ` · ${nf(unassignedLeads)} not yet given a branch` : ""}`} testid="leads-analytics-branches">
            {assignedBranches.length === 0 ? <Empty>No leads to split by branch.</Empty> : asTable ? (
              <ValueTable rows={assignedBranches.map((r) => ({ name: r.name, value: r.leads }))} firstHeading="Branch" />
            ) : (
              <BranchLeadsList rows={assignedBranches} />
            )}
          </Card>
        )}

        {/* 3 — of those booked, who came for the consultation */}
        {oneBranch ? (
          <Card
            title={`${oneBranchName} · appointment ratio`}
            sub={`${nf(funnelBooked)} booked · ${nf(funnelCame)} came · ${nf(funnelConsult)} consultation paid · ${nf(funnelSession)} session paid`}
            testid="leads-analytics-appointments-branch"
          >
            {funnelRows.length === 0 ? <Empty>No appointments booked in this range.</Empty> : (
              <StepFunnelList row={funnelRows[0]} />
            )}
          </Card>
        ) : (
          <Card
            title="Appointment ratio by branch"
            sub={`${nf(funnelBooked)} booked · ${nf(funnelCame)} came for consultation (${pctOf(funnelCame, funnelBooked)})`}
            testid="leads-analytics-appointments-branch"
          >
            {funnelRows.length === 0 ? <Empty>No appointments booked in this range.</Empty> : asTable ? (
              <ValueTable rows={funnelRows.map((r) => ({ name: r.name, value: r.booked }))} firstHeading="Branch" />
            ) : (
              <BranchFunnelList rows={funnelRows} />
            )}
          </Card>
        )}

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
