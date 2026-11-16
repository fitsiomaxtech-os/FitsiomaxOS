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
 */
export const PhoneStageTile = ({ icon: Icon, label, count, active, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`relative flex h-full min-h-[72px] w-full min-w-0 flex-col justify-between gap-2 rounded-xl bg-white text-left shadow-md transition active:scale-[0.99] ${active ? "border-2 border-slate-400 p-[9px]" : "border border-slate-200 p-2.5"}`}
    data-testid={testid}
  >
    <span className="flex items-center justify-between gap-1">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-slate-500 opacity-70" />
      <span className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md border border-orange-200 bg-orange-100/35 px-1.5 text-sm font-medium tabular-nums text-orange-700" data-testid={`${testid}-badge`}>
        {count}
      </span>
    </span>
    <span className="truncate text-[11px] font-medium text-slate-900 opacity-75" title={label}>{label}</span>
    {count > 0 && (
      <span aria-hidden className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white motion-safe:animate-dot-pop" />
    )}
  </button>
);

// The ranges under the grid, one row of six; anything else is the toolbar's calendar.
const PHONE_RANGE_KEYS = ["all", "today", "yesterday", "this_week", "this_month", "last_90"];
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
 */
export const PhoneRangeRow = ({ value, calendarSet = false, onChange, testid }) => (
  <div className="grid grid-cols-6 gap-1" data-testid={testid}>
    {PHONE_RANGE_KEYS.map((key) => {
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
