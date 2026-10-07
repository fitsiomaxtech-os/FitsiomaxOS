import { DateFilterPopover } from "@/components/DateFilterPopover";

/**
 * QuickDateFilterBar
 *
 * A horizontal row of one-tap date ranges — All, Today, Yesterday, This Week,
 * This Month, Last 90 Days — with the shared date popover on the end for everything else.
 *
 * This is a *second*, independent date control, added beside the existing
 * DateFilterPopover rather than replacing it. Nothing in DateFilterPopover.jsx is
 * changed by it: the Custom trigger here is that same component used as-is, so the
 * calendar, Yesterday/Last Month presets and typed custom range all come along
 * unaltered. The board owning both narrows by their intersection, so each control
 * keeps showing its own state and neither silently overrules the other.
 *
 * Props:
 *  - value: the same shape DateFilterPopover emits —
 *           { key, label, from: Date|null, to: Date|null } | null. null means All.
 *  - onChange: (next) => void. Emits null for All.
 *  - testid: string prefix for the row's test ids.
 *  - inline: true when the row is being dropped into a toolbar beside other controls
 *            rather than standing on a line of its own. It then refuses to wrap and
 *            refuses to be shrunk, so the ranges stay on one line and whatever elastic
 *            sits beside them (a search field) gives up the width instead.
 *            It also tightens — 12px labels, px-2, gap-1 — which brings the five of them
 *            to about 330px against the ~450 they take standing alone, and is what lets
 *            them join a row they previously could not fit in. The tightening lifts at
 *            2xl, where the toolbar has the width to spare and the smaller type would be
 *            read as a mistake rather than as a fit.
 *            Standing on its own line the row has the width to itself and keeps full
 *            desktop sizing, so nothing changes for the boards using it that way.
 *  - showCustom: false drops the Custom trigger and leaves the five presets. Only for a
 *            board that reaches a DateFilterPopover some other way — with it false this
 *            row can express nothing but its own five ranges, so a board without a second
 *            control would lose arbitrary ranges altogether rather than relocate them.
 *  - micro: for a phone toolbar that has to hold this row AND other controls on one
 *            line. Below sm the five labels drop to All / 1D / 1W / 1M / 90d and the
 *            buttons to h-9 with hairline padding, which brings the row to about 150px
 *            against the ~290 `short` needs -- the difference between fitting beside a
 *            search icon, a calendar, a refresh and a download, and not. The full label
 *            is on `title`, and sm and up is untouched: same h-10 buttons, same words.
 *  - showTomorrow: adds Tomorrow after Today. For boards whose list is read by
 *            appointment date; off by default.
 */

const startOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const endOfDay = (d) => { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; };

// A real Monday→Sunday calendar week, not a rolling last-7-days window — same reading
// of "this week" the Dashboard's row uses, so the two boards agree on what the words mean.
const mondayOf = (d) => {
  const n = startOfDay(d);
  const day = n.getDay(); // 0 = Sun .. 6 = Sat
  n.setDate(n.getDate() + (day === 0 ? -6 : 1 - day));
  return n;
};
const sundayOf = (d) => { const m = mondayOf(d); const n = new Date(m); n.setDate(n.getDate() + 6); return n; };
const daysBack = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() - n); return x; };
const yesterday = () => daysBack(new Date(), 1);
const tomorrow = () => daysBack(new Date(), -1);

/**
 * `short` is the phone label. Six full labels cannot share a phone's width, and the
 * alternatives are worse: truncating gives "Last 9…", wrapping costs a row, scrolling
 * hides the last two off the edge. `label` is what the filter state carries, so nothing
 * downstream ever sees the abbreviation.
 *
 * All carries no dates at all rather than a very wide range — it is the absence of a
 * narrowing, which is what lets the board treat it as "this control is not filtering".
 *
 * Last 90 Days counts today as one of the ninety, so it runs today-89 → today. Ninety
 * whole days ending yesterday would drop the morning's consultations, which is the one
 * thing somebody opening this board is most likely to be checking.
 *
 * Tomorrow only means something over a list of appointments, so it is opt-in (see
 * showTomorrow) — over a list read by created date it could only ever be empty.
 */
export const QUICK_DATE_PRESETS = [
  { key: "all", label: "All", short: "All", micro: "All", range: () => ({ from: null, to: null }) },
  { key: "today", label: "Today", short: "Today", micro: "1D", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { key: "yesterday", label: "Yesterday", short: "Yday", micro: "-1D", range: () => ({ from: yesterday(), to: endOfDay(yesterday()) }) },
  { key: "tomorrow", label: "Tomorrow", short: "Tmrw", micro: "+1D", optional: true, range: () => ({ from: tomorrow(), to: endOfDay(tomorrow()) }) },
  { key: "this_week", label: "This Week", short: "Week", micro: "1W", range: () => ({ from: mondayOf(new Date()), to: endOfDay(sundayOf(new Date())) }) },
  { key: "this_month", label: "This Month", short: "Month", micro: "1M", range: () => { const t = new Date(); return { from: startOfDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: endOfDay(new Date(t.getFullYear(), t.getMonth() + 1, 0)) }; } },
  { key: "last_90", label: "Last 90 Days", short: "90d", micro: "90d", range: () => ({ from: daysBack(new Date(), 89), to: endOfDay(new Date()) }) },
];

const quickFilter = (p) => (p.key === "all" ? null : { key: p.key, label: p.label, ...p.range() });

/**
 * One preset's value by key, for a board that should OPEN on a range rather than on All.
 *
 * The same object the row emits when that button is pressed, so the button it names lights
 * up on arrival without the board having to describe its own default twice.
 *
 * The range is computed when this is called, not when the module loads, so a board
 * initialising on "today" means the day it was opened. A board left open across midnight
 * keeps the day it started on until somebody presses a range again -- which is what
 * pressing Today at 23:59 has always done, and not worth a ticking clock to fix.
 */
export const quickDatePreset = (key) => {
  const preset = QUICK_DATE_PRESETS.find((p) => p.key === key);
  return preset ? quickFilter(preset) : null;
};

/**
 * Narrows one date filter by another, so two independent controls over the same list
 * combine instead of one quietly winning. The result is the overlap: the later of the two
 * starts, the earlier of the two ends. Either side being null (unset) leaves the other
 * standing, and both being null means no narrowing at all.
 *
 * Disjoint ranges give an empty list, which is the honest answer — and both controls stay
 * lit on screen saying which two ranges produced it.
 */
export const intersectDateFilters = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  const from = [a.from, b.from].filter(Boolean).sort((x, y) => y - x)[0] || null;
  const to = [a.to, b.to].filter(Boolean).sort((x, y) => x - y)[0] || null;
  return { key: `${a.key}+${b.key}`, label: `${a.label} · ${b.label}`, from, to };
};

export const QuickDateFilterBar = ({ value, onChange, testid = "quick-date", inline = false, showCustom = true, micro = false, showTomorrow = false }) => {
  const presets = QUICK_DATE_PRESETS.filter((p) => !p.optional || showTomorrow);
  // What lights up. All is the resting state, so a cleared filter lights All rather than
  // leaving the row with nothing selected and no way to tell it apart from a custom range.
  const activeKey = value?.key || "all";
  const onPreset = presets.some((p) => p.key === activeKey);

  return (
    /* One row at every width, six equal columns on a phone so nothing lands off screen —
       an overflow-x row here puts Last 90 Days half past the edge. Desktop keeps natural
       widths, since stretching six buttons across a 1400px board would be absurd.

       Standing alone the row may wrap on a wide-but-crowded board, which costs nothing
       when there is only empty page under it. Inline in a toolbar it must not: wrapping
       there breaks the one line the toolbar is, so it holds its width and the field
       beside it shrinks instead. */
    <div
      className={`flex items-center gap-1 ${inline ? "shrink-0 flex-nowrap 2xl:gap-1.5" : "sm:gap-2 sm:flex-wrap"}`}
      data-testid={testid}
    >
      {presets.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onChange(quickFilter(p))}
          aria-pressed={activeKey === p.key}
          title={micro ? p.label : undefined}
          className={`min-w-0 flex-1 truncate rounded-md font-medium transition sm:flex-none ${
            micro
              ? "h-9 px-0.5 text-[10px] sm:h-10 sm:px-3 sm:text-sm"
              : `h-10 px-1 text-[11px] ${inline ? "sm:px-2 sm:text-xs 2xl:px-2.5 2xl:text-[13px]" : "sm:px-3 sm:text-sm"}`
          } ${
            activeKey === p.key
              ? "bg-sky-600 text-white"
              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
          data-testid={`${testid}-preset-${p.key}`}
        >
          <span className="sm:hidden">{micro ? p.micro : p.short}</span>
          <span className="hidden sm:inline">{p.label}</span>
        </button>
      ))}
      {/* The trigger is a Button this component doesn't own, so its width, padding, text
          size and icon are pinned from out here rather than by adding breakpoint props to
          a control six other boards share.

          Handed null while a preset above is lit, so it reads "Custom" instead of naming
          the same range the lit button already names.

          Withheld where the board already carries the same popover elsewhere in the row —
          see showCustom. Two triggers for one calendar side by side is the duplication,
          not the calendar. */}
      {showCustom && (
      <span className={`min-w-0 flex-1 sm:flex-none [&_button]:h-10 [&_button]:w-full [&_button]:justify-center [&_button]:px-1 [&_button]:text-[11px] [&_svg]:hidden sm:[&_button]:w-auto sm:[&_svg]:inline-block ${
        inline ? "sm:[&_button]:px-2.5 sm:[&_button]:text-xs 2xl:[&_button]:px-3 2xl:[&_button]:text-[13px]" : "sm:[&_button]:px-4 sm:[&_button]:text-sm"
      }`}>
        <DateFilterPopover
          value={onPreset ? null : value}
          onChange={(next) => onChange(next || null)}
          testid={`${testid}-custom`}
          placeholder="Custom"
          centered
        />
      </span>
      )}
    </div>
  );
};

export default QuickDateFilterBar;
