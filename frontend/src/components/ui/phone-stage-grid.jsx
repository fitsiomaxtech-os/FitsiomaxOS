import { QUICK_DATE_PRESETS, quickDatePreset } from "@/components/QuickDateFilterBar";

/**
 * The phone's stage summary grid, as Pre Sales' phone board draws it and Branch Admin >
 * Branch Leads' phone now does too -- one component, so the two grids stay one look.
 *
 * One stage per tile, three to a row: the stage's glyph and its count on top, the name
 * under them. The count box and the red waiting dot are the inline NotifyCard's, so the
 * grid reads as the same set as the stage rows elsewhere. The grid gives every tile the
 * same height (auto-rows-fr); the open tile is outlined 2px with its padding 1px less, so
 * it does not grow when picked.
 *
 * `count` may be a figure in words too (Zumba's money tiles: "₹12,000"); a long one drops
 * to 11px so it stays inside the tile. `dot` says whether the red dot shows, for a tile
 * whose figure is not a headcount; left out, it shows while the count is above 0.
 */
export const PhoneStageTile = ({ icon: Icon, label, count, dot, active, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`relative flex h-full min-h-[72px] w-full min-w-0 flex-col justify-between gap-2 rounded-xl bg-white text-left shadow-md transition active:scale-[0.99] ${active ? "border-2 border-slate-400 p-[9px]" : "border border-slate-200 p-2.5"}`}
    data-testid={testid}
  >
    <span className="flex items-center justify-between gap-1">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-slate-500 opacity-70" />
      <span className={`inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md border border-orange-200 bg-orange-100/35 px-1.5 font-medium tabular-nums text-orange-700 ${String(count).length > 6 ? "text-[11px]" : "text-sm"}`} data-testid={`${testid}-badge`}>
        {count}
      </span>
    </span>
    <span className="truncate text-[11px] font-medium text-slate-900 opacity-75" title={label}>{label}</span>
    {(dot ?? count > 0) && (
      <span aria-hidden className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white motion-safe:animate-dot-pop" />
    )}
  </button>
);

// The ranges under the grid, one row of six; anything else is the toolbar's calendar.
const PHONE_RANGE_KEYS = ["all", "today", "yesterday", "this_week", "this_month", "last_90"];
// Branch Admin > Consultation's six: its own range row's (Tomorrow in, 90d out), so the
// phone offers the same ranges as the tab does from sm up.
export const PHONE_CONSULT_RANGE_KEYS = ["all", "yesterday", "today", "tomorrow", "this_week", "this_month"];
const PHONE_RANGE_PILL = "h-10 w-full min-w-0 truncate rounded-md px-0.5 text-[11px] font-medium transition";
const phoneRangeTone = (on) => (on ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 active:bg-slate-50");

/**
 * The phone's date ranges under the stage grid: All, Today, Yday, Week, Month and 90d as
 * six equal buttons, the full name on `title`.
 *
 *  - value: the board's range (what quickDatePreset returns), null for All.
 *  - calendarSet: a date picked on the toolbar's calendar is narrowing the list. All is
 *    not lit while it is, so the lit button always names what the list is cut to.
 *  - onChange(next): the range pressed, null for All. Both boards clear their calendar
 *    there, so a range pressed replaces a picked date rather than overlapping it.
 *  - keys: which six ranges, in order (PHONE_RANGE_KEYS unless given).
 */
export const PhoneRangeRow = ({ value, calendarSet = false, onChange, keys = PHONE_RANGE_KEYS, testid }) => (
  <div className="grid grid-cols-6 gap-1" data-testid={testid}>
    {keys.map((key) => {
      const p = QUICK_DATE_PRESETS.find((x) => x.key === key);
      const on = key === "all" ? !value && !calendarSet : value?.key === key;
      return (
        <button
          key={key}
          type="button"
          onClick={() => onChange(quickDatePreset(key))}
          aria-pressed={on}
          title={p.label}
          className={`${PHONE_RANGE_PILL} ${phoneRangeTone(on)}`}
          data-testid={`${testid}-preset-${key}`}
        >
          {p.short}
        </button>
      );
    })}
  </div>
);
