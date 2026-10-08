import { useEffect, useMemo, useRef } from "react";

/**
 * DayStripFilter
 *
 * A row of single days instead of a row of ranges: All, then four days back and four
 * forward — Sep 12 … Yesterday, Today, Tomorrow … Sep 20. One tap narrows the board
 * to that one day, which is how a Consultant actually reads their queue: they are
 * looking at a day's appointments, not at a quarter's. Anything outside that fortnight
 * is the calendar's job, which is why the window stays short enough to read at a
 * glance rather than long enough to need scrolling.
 *
 * It emits the same { key, label, from, to } | null shape DateFilterPopover and
 * QuickDateFilterBar emit, so a board can swap one for the other without anything
 * downstream noticing. `key` is `day_YYYY-MM-DD`, which is what isDayKey() reads —
 * a board needs to tell "a day off this strip" from "a range typed into the
 * calendar", and the dates themselves are a moving target.
 *
 * QuickDateFilterBar is deliberately left alone: five other boards still want All /
 * Today / This Week / This Month / Last 90 Days, and this is a different control
 * rather than a new version of that one.
 *
 * Props:
 *  - value: { key, label, from: Date, to: Date } | null. null means All.
 *  - onChange: (next) => void. Emits null for All.
 *  - testid: string prefix for the row's test ids.
 *  - back / forward: how many days either side of today to offer. Four each way, so
 *    Yesterday is the last of the past four and Tomorrow the first of the next four —
 *    the two named days sit against Today rather than adrift in a longer run.
 *  - dense: a little less padding and gap, for a tool bar that has other controls to fit
 *    on the same row (My Consultation's pickers). The same buttons, about 40px narrower.
 *
 * On a phone only the three named days are drawn — Yesterday, Today, Tomorrow — with All
 * still pinned before them. The dated days are hidden, not dropped, from tablet up they
 * are the row they always were; on a phone they were a strip pushed sideways past the
 * three days anyone opened it for. The calendar button beside the strip still reaches
 * every other date.
 */

const startOfDay = (d) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
const endOfDay = (d) => { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; };
const shift = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };

// Local date, not toISOString — that converts to UTC first, and on a +05:30 clock
// midnight comes back as the day before, so every key would name the wrong day.
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Written out rather than taken from toLocaleDateString, which formats to the browser's
// locale: an en-GB machine renders the same day as "12 Sept", so the row read one way on
// one laptop and another way on the next. One spelling everywhere, and it is short.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The three days either side of now get their names rather than their dates, because
 * that is what someone is looking for when they come to this row — nobody scans for
 * "Sep 16", they scan for Today. Everything else is "Sep 12".
 */
const dayLabel = (d, offset) => (
  offset === 0 ? "Today"
    : offset === -1 ? "Yesterday"
      : offset === 1 ? "Tomorrow"
        : `${MONTHS[d.getMonth()]} ${d.getDate()}`
);

/** The filter value for one day. Exported so a board can open on a day. */
export const dayFilter = (d, offset = null) => {
  const day = startOfDay(d);
  const rel = offset === null ? Math.round((day - startOfDay(new Date())) / 86400000) : offset;
  return { key: `day_${isoOf(day)}`, label: dayLabel(day, rel), from: day, to: endOfDay(day) };
};

/** Today's day filter, computed on call rather than at import, so a tab left open
 *  overnight and reloaded opens on the new day. */
export const todayFilter = () => dayFilter(new Date(), 0);

/** True for a value this strip produced, as opposed to a range from the calendar. */
export const isDayKey = (key) => /^day_\d{4}-\d{2}-\d{2}$/.test(String(key || ""));

export const DayStripFilter = ({ value, onChange, testid = "day-strip", back = 4, forward = 4, dense = false }) => {
  const activeKey = value?.key || "all";

  // Rebuilt only when the window changes, not on every keystroke elsewhere on the board.
  const days = useMemo(() => {
    const out = [];
    for (let o = -back; o <= forward; o += 1) {
      const d = shift(new Date(), o);
      out.push({ offset: o, date: d, ...dayFilter(d, o) });
    }
    return out;
  }, [back, forward]);

  const scrollerRef = useRef(null);
  const todayRef = useRef(null);

  // Today sits in the middle of the window, so on a narrow toolbar it starts off
  // screen and the row opens showing dates nobody asked about. Centre it once on
  // mount. scrollLeft on the scroller rather than scrollIntoView(), which would also
  // scroll the page vertically to reach it.
  useEffect(() => {
    const box = scrollerRef.current;
    const btn = todayRef.current;
    if (!box || !btn) return;
    box.scrollLeft = btn.offsetLeft - (box.clientWidth - btn.offsetWidth) / 2;
  }, []);

  return (
    <div className={`flex min-w-0 items-center gap-1 ${dense ? "" : "sm:gap-1.5"}`} data-testid={testid}>
      {/* All is pinned outside the scroller: it is the way back to an unfiltered board,
          and a reset that scrolls away is a reset nobody finds. Orange throughout —
          it is the one button here that is not a date, and the colour says so at a
          glance rather than making people read the row. */}
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-pressed={activeKey === "all"}
        className={`h-10 shrink-0 rounded-md px-2 ${dense ? "sm:px-2.5" : "sm:px-3"} text-xs font-semibold transition sm:text-[13px] ${
          activeKey === "all"
            ? "bg-orange-500 text-white shadow-sm"
            : "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100"
        }`}
        data-testid={`${testid}-all`}
      >
        All
      </button>

      {/* The dates scroll rather than wrap: wrapping costs the toolbar a second row at
          every width under about 1100px, and the row is a strip you push along. */}
      <div
        ref={scrollerRef}
        className={`flex min-w-0 flex-1 items-center gap-1 ${dense ? "" : "sm:gap-1.5"} overflow-x-auto scroll-smooth py-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
        data-testid={`${testid}-scroller`}
      >
        {days.map((d) => {
          const active = activeKey === d.key;
          return (
            <button
              key={d.key}
              ref={d.offset === 0 ? todayRef : null}
              type="button"
              onClick={() => onChange({ key: d.key, label: d.label, from: d.from, to: d.to })}
              aria-pressed={active}
              title={d.date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
              // Past Yesterday and Tomorrow the days are tablet-up only; see the note above.
              className={`h-10 shrink-0 whitespace-nowrap rounded-md px-2 ${dense ? "sm:px-2.5" : "sm:px-3"} text-xs font-medium transition sm:text-[13px] ${Math.abs(d.offset) > 1 ? "hidden sm:block" : ""} ${
                active
                  ? "bg-sky-600 text-white shadow-sm"
                  // Today keeps a mark of its own while unselected, so the middle of the
                  // strip is findable after somebody has scrolled away from it.
                  : d.offset === 0
                    ? "border border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              data-testid={`${testid}-${d.key}`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DayStripFilter;
