import { useCallback, useEffect, useRef, useState } from "react";
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

const longPeriod = (p) => {
  const parts = String(p || "").split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[Number(parts[1]) - 1] || "";
  if (parts.length === 3) return `${Number(parts[2])} ${m} ${parts[0]}`;
  return `${m} ${parts[0]}`;
};



/** ₹ the way Finance's Cash flow axis writes it: ₹15 L, ₹1.2 Cr, ₹45 k. */
const inrAxis = (n) => {
  const v = Number(n || 0);
  const trim = (x) => String(Math.round(x * 100) / 100);
  if (v >= 1e7) return `₹${trim(v / 1e7)} Cr`;
  if (v >= 1e5) return `₹${trim(v / 1e5)} L`;
  if (v >= 1e3) return `₹${trim(v / 1e3)} k`;
  return `₹${Math.round(v)}`;
};

const TableIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" />
  </svg>
);
const ChartIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

const ViewDataButton = ({ on, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testid}
    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 shadow-[0_1px_2px_rgba(37,99,235,0.08)] transition-all duration-200 hover:border-transparent hover:bg-gradient-to-r hover:from-sky-500 hover:to-blue-600 hover:text-white hover:shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)] active:scale-[0.98]"
  >
    {on ? <ChartIcon /> : <TableIcon />}
    {on ? "View chart" : "View data"}
  </button>
);

const REVENUE_TYPE_LABEL = { consultation: "Consultation", session: "Session", diet: "Diet", rehab: "Rehab", spot_joining: "Spot joining", zumba: "Zumba" };

/* ── chrome ─────────────────────────────────────────────────────────────────────── */

const Card = ({ title, sub, children, className = "", testid, action }) => (
  <div
    className={`group/card relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(37,99,235,0.18)] transition-shadow duration-300 hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_36px_-14px_rgba(37,99,235,0.32)] ${className}`}
    data-testid={testid}
  >
    <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-400 via-blue-600 to-indigo-500" />
    <div className="flex items-start justify-between gap-4 border-b border-blue-100/70 bg-gradient-to-r from-sky-50/90 via-blue-50/40 to-white px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      </div>
      {action}
    </div>
    <div className="flex-1 px-5 py-4">{children}</div>
  </div>
);

const Empty = ({ children }) => <p className="py-10 text-center text-sm text-slate-400">{children}</p>;



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
    <span
      className="block h-full rounded-full shadow-[0_1px_4px_-1px_rgba(37,99,235,0.45)]"
      style={{ width: `${value ? Math.max(1.5, (value / max) * 100) : 0}%`, background: `linear-gradient(90deg, ${color}99, ${color})` }}
    />
  </span>
);

/** One line of the hover card, styled as the Finance charts' tooltip: a short coloured
 *  dash, the figure in bold, what it counts, and a quiet ratio after it. */
const HoverStat = ({ color, label, value, note, money }) => (
  <div className="flex items-baseline gap-2 whitespace-nowrap">
    <span className="inline-block h-[2px] w-3 shrink-0 translate-y-[-3px] rounded-full" style={{ background: color }} />
    <span className="text-[13px] font-semibold tabular-nums text-slate-900">{money || nf(value)}</span>
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
const HoverRows = ({ head, rows, scale, hint, tickFormat = compact }) => {
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
                {/* Above the guides, which would otherwise cut white lines across a bar. */}
                <span className="relative z-[1] flex flex-col gap-1.5">{row.bars}</span>
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
                className="absolute top-0 whitespace-nowrap"
                style={{
                  left: `${(t / scale.top) * 100}%`,
                  transform: i === 0 ? "none" : i === scale.ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {tickFormat(t)}
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

/** Days rolled into Monday-to-Sunday weeks, for the one-branch view of a long range: a row
 *  a day is thirty rows, a row a week is four or five. Months are left as they are. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodBuckets = (periods, values) => {
  if (!periods.length) return [];
  if (periods[0].length === 7 || periods.length <= 14) {
    return periods.map((p, i) => ({ key: p, label: longPeriod(p), value: values[i] || 0 }));
  }
  const weeks = [];
  periods.forEach((p, i) => {
    const d = new Date(`${p}T00:00:00Z`);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    let w = weeks[weeks.length - 1];
    if (!w || w.key !== key) {
      w = { key, first: d, last: d, value: 0 };
      weeks.push(w);
    }
    w.last = d;
    w.value += values[i] || 0;
  });
  return weeks.map((w) => {
    const a = `${w.first.getUTCDate()} ${MONTHS[w.first.getUTCMonth()]}`;
    const b = `${w.last.getUTCDate()} ${MONTHS[w.last.getUTCMonth()]}`;
    return { key: w.key, label: a === b ? a : `${a} – ${b}`, value: w.value };
  });
};

/** Leads or revenue over the range, in the bar-list format of the branch cards: one row
 *  and one bar per branch on a shared, ticked scale. With one branch picked, the rows are
 *  that branch's weeks (or days, or months) instead. Hover a row for its figures, best day
 *  included; View data opens the day-by-day table behind it. */
const BranchTrendCard = ({ title, sub, periods, series, money, emptyText, testid, single, className, breakdown, breakdownLabel }) => {
  const [asData, setAsData] = useState(false);
  const names = Object.keys(series || {});
  const fmt = money ? inr : nf;
  const tickFormat = money ? inrAxis : compact;
  const tint = money ? CATEGORICAL[2] : SERIES;
  const unit = money ? "collected" : "leads";

  const branchRows = names
    .map((n) => {
      const vals = series[n] || [];
      const value = vals.reduce((a, v) => a + v, 0);
      let best = -1;
      vals.forEach((v, i) => { if (v > 0 && (best < 0 || v > vals[best])) best = i; });
      return { key: n, label: n, value, best: best >= 0 ? { period: periods[best], value: vals[best] } : null };
    })
    .filter((row) => row.value > 0)
    .sort((x, y) => y.value - x.value);
  // One branch picked: what its total is made of (sources for leads, fee types for
  // revenue), not a single bar. Without a breakdown, its weeks.
  const rows = single
    ? (breakdown ? breakdown.map((row) => ({ key: row.name, label: row.name, value: row.value })) : periodBuckets(periods || [], series[names[0]] || []))
    : branchRows;
  const total = rows.reduce((a, row) => a + row.value, 0);
  const scale = niceScale(Math.max(1, ...rows.map((row) => row.value)));

  const table = (
    <div className="max-h-[300px] overflow-auto rounded-lg border border-slate-100">
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2">{periods[0]?.length > 7 ? "Day" : "Month"}</th>
            {names.map((n) => <th key={n} className="px-3 py-2 text-right">{n}</th>)}
            {names.length > 1 && <th className="px-3 py-2 text-right">Total</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {(periods || []).map((period, i) => {
            const cells = names.map((n) => series[n][i] || 0);
            const sum = cells.reduce((a, v) => a + v, 0);
            if (!sum) return null;
            return (
              <tr key={period} className="transition-colors hover:bg-blue-50/40">
                <td className="px-3 py-2 text-slate-600">{longPeriod(period)}</td>
                {cells.map((v, k) => <td key={names[k]} className="px-3 py-2 text-right tabular-nums text-slate-800">{v ? fmt(v) : <span className="text-slate-300">—</span>}</td>)}
                {names.length > 1 && <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{fmt(sum)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <Card
      title={title}
      sub={sub}
      testid={testid}
      className={className}
      action={rows.length > 0 ? <ViewDataButton on={asData} onClick={() => setAsData((v) => !v)} testid={`${testid}-view-data`} /> : null}
    >
      {rows.length === 0 || total === 0 ? <Empty>{emptyText}</Empty> : asData ? table : (
        <HoverRows
          scale={scale}
          tickFormat={tickFormat}
          head={
            <>
              <span>{single ? (breakdownLabel || (periods[0]?.length === 7 ? "Month" : periods.length <= 14 ? "Day" : "Week")) : "Branch"}</span>
              <span className="flex items-center gap-3 font-medium normal-case tracking-normal">
                <Dot color={tint}>{money ? "Revenue" : "Leads"}</Dot>
              </span>
            </>
          }
          rows={rows.map((row) => ({
            key: row.key,
            label: row.label,
            bars: <Track value={row.value} max={scale.top} color={tint} />,
            stats: (
              <>
                <HoverStat color={tint} label={unit} value={money ? undefined : row.value} note={`${pctOf(row.value, total)} of total`} money={money ? fmt(row.value) : null} />
                {row.best && (
                  <p className="mt-1 text-[11px] text-slate-400">
                    Best {periods[0]?.length === 7 ? "month" : "day"}: {longPeriod(row.best.period)} · {fmt(row.best.value)}
                  </p>
                )}
              </>
            ),
          }))}
        />
      )}
    </Card>
  );
};



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
  const branchFunnel = data?.branch_funnel || [];
  const branchTrend = data?.branch_trend || { grain: "day", periods: [], leads: {}, revenue: {} };
  const sumSeries = (obj) => Object.entries(obj || {})
    .map(([name, vals]) => ({ name, value: vals.reduce((a, v) => a + v, 0) }))
    .filter((row) => row.value > 0)
    .sort((x, y) => y.value - x.value);
  const trendLeadTotal = sumSeries(branchTrend.leads).reduce((a, row) => a + row.value, 0);
  const revenueByType = (branchTrend.revenue_by_type || [])
    .filter((row) => row.value > 0)
    .map((row) => ({ name: REVENUE_TYPE_LABEL[row.name] || row.name, value: row.value }));
  const revenueTotal = revenueByType.reduce((a, row) => a + row.value, 0);
  // One branch: where its leads came from, biggest first.
  const leadSources = (data?.by_source || []).filter((row) => row.value > 0);
  // One branch: its revenue in the desk's five lines, always all five so a line that took
  // nothing reads as zero rather than going missing. Rehab, spot joining and anything
  // else the fee trail names fall under Other.
  const kindTotals = Object.fromEntries((branchTrend.revenue_by_type || []).map((row) => [row.name, row.value]));
  const revenueKinds = [
    { name: "Consultations", value: kindTotals.consultation || 0 },
    { name: "Sessions", value: kindTotals.session || 0 },
    { name: "Diet collections", value: kindTotals.diet || 0 },
    { name: "Zumba", value: kindTotals.zumba || 0 },
    {
      name: "Other",
      value: Object.entries(kindTotals)
        .filter(([k]) => !["consultation", "session", "diet", "zumba"].includes(k))
        .reduce((a, [, v]) => a + v, 0),
    },
  ];
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

      {/* 1 — leads and revenue over time, side by side at half width each */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BranchTrendCard
          key={`leads-${branchKey}`}
          title="Leads over time"
          sub={oneBranch ? `${nf(total)} leads in this range, by source` : `${nf(trendLeadTotal)} leads in this range, by branch`}
          periods={branchTrend.periods}
          series={branchTrend.leads}
          single={oneBranch}
          breakdown={leadSources}
          breakdownLabel="Source"
          emptyText="No leads arrived in this range."
          testid="leads-analytics-trend"
        />
        <BranchTrendCard
          key={`revenue-${branchKey}`}
          title="Revenue"
          sub={`${inr(revenueTotal)} across ${nf(branchTrend.revenue_payments || 0)} payments, ${oneBranch ? "by type" : "by branch"}`}
          periods={branchTrend.periods}
          series={branchTrend.revenue}
          money
          single={oneBranch}
          breakdown={revenueKinds}
          breakdownLabel="Revenue type"
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
      </div>
    </div>
  );
};

export default LeadsAnalyticsDashboard;
