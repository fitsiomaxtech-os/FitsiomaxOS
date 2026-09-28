/**
 * The Finance Summary tab's figure card (AccountantManageTab's RevenueTile), for the
 * other finance pages to draw their rows of cards with, so every tab of that board reads
 * as one set: 2px corners, a sentence-case label, the figure, and the picked card tinted
 * and outlined in its own colour rather than ringed.
 *
 * The colour is one hex, applied inline — Tailwind reads class names out of the source,
 * so a class built at runtime from a tone name compiles to nothing.
 */
export const SummaryTile = ({ label, value, sub, color = "#0284c7", active = false, onClick, testid, valueClassName = "text-slate-900" }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    data-testid={testid}
    className={`flex h-full w-full flex-col overflow-hidden rounded-[2px] border border-slate-200 p-3 text-left transition-all duration-150 sm:p-3.5 ${
      active
        ? "shadow-[0_4px_14px_-4px_rgba(16,24,40,0.16)]"
        : "bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:bg-slate-50/60"
    }`}
    style={active ? { borderColor: color, backgroundColor: `${color}14` } : undefined}
  >
    <p className={`truncate text-[11px] transition-colors sm:text-xs ${active ? "font-semibold text-slate-900" : "font-medium text-slate-500"}`}>{label}</p>
    <p className={`mt-1 text-base font-semibold tabular-nums tracking-tight sm:text-[18px] sm:leading-6 ${valueClassName}`}>{value}</p>
    {sub ? <p className="mt-0.5 truncate text-[10px] leading-tight text-slate-400 sm:text-[11px]">{sub}</p> : null}
  </button>
);

export default SummaryTile;
