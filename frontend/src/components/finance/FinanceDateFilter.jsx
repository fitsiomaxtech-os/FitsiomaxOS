import { useEffect, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MilkCalendar } from "@/components/ui/milk-calendar";
import { FilterSelect } from "@/components/ui/filter-select";
import { maskDayMonthYear, manualToIso, isoToManual } from "@/components/DateFilterPopover";
import { DATE_PRESET_LABELS, DATE_PRESET_SHORT, fromIso, toIso } from "@/lib/dateRange";

// The phone dropdown's option that opens the dialog rather than naming a window. Never the
// select's value, so picking it fires every time -- including while a custom range is
// already the one in force, which is when somebody wants to change it.
const PICK_RANGE = "__pick";

// DD-MM: a range spelt out in a select half a phone wide has no room for the years.
const shortDay = (iso) => isoToManual(iso).slice(0, 5);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The first and last day of a month, both inclusive -- day 0 of the next month is the last
// of this one, so February and the year's end come out right without saying how long either is.
const monthRange = (y, m) => [toIso(new Date(y, m, 1)), toIso(new Date(y, m + 1, 0))];

/** The month a range covers end to end, as { y, m }, or null when it is anything else. A
 *  month picked in the dialog is held as an ordinary custom range, so this is how the
 *  dialog and the chip recognise one again. */
const wholeMonth = (from, to) => {
  if (!from || !to) return null;
  const d = fromIso(from);
  const [first, last] = monthRange(d.getFullYear(), d.getMonth());
  return first === from && last === to ? { y: d.getFullYear(), m: d.getMonth() } : null;
};

/** A custom range in words: "September 2026" for a whole month, one date for one day. */
const rangeLabel = (from, to) => {
  const month = wholeMonth(from, to);
  if (month) return `${MONTH_NAMES[month.m]} ${month.y}`;
  return from === to ? isoToManual(from) : `${isoToManual(from)} to ${isoToManual(to)}`;
};

// The dialog's rail, in the order Filter by Date's own dialog lists them: the day, the day
// before, then the months, then Custom. A board's own list still decides which appear.
const RAIL_ORDER = ["today", "yesterday", "this_week", "last_month", "this_month", "custom"];
// "Custom" in the rail, where Month sits under it and neither needs the longer name.
const RAIL_LABELS = { ...DATE_PRESET_LABELS, custom: "Custom" };

/**
 * Month, in the dialog's rail: a dropdown of the twelve months, a year at a time, and
 * picking one filters to it first to last. Months still to come are greyed out, since
 * nothing has been booked in them yet.
 *
 * Portalled, so the list hangs below the rail over the dialog's edge rather than being cut
 * off by the dialog's own scroll. Its open state is the dialog's, so Esc closes the list
 * first and the dialog only on a second press.
 */
const MonthMenu = ({ picked, lit, open, onOpenChange, onPick, btnClass, testid }) => {
  const now = new Date();
  const thisYear = now.getFullYear();
  const [year, setYear] = useState(picked ? picked.y : thisYear);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => { if (next) setYear(picked ? picked.y : thisYear); onOpenChange(next); }}
    >
      <PopoverPrimitive.Trigger className={btnClass(lit || open)} data-testid={`${testid}-preset-month`}>
        <span className="flex items-center justify-center gap-1 sm:justify-between">
          Month
          <ChevronDown className={`hidden h-3.5 w-3.5 shrink-0 opacity-60 transition sm:block ${open ? "rotate-180" : ""}`} />
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-[200] max-h-[var(--radix-popover-content-available-height)] w-48 overflow-y-auto rounded-[4px] border border-[#EFEAE0] bg-[#FDFCF8] p-1.5 shadow-2xl outline-none"
          data-testid={`${testid}-month-list`}
        >
          <div className="mb-1 flex items-center justify-between border-b border-[#EFEAE0] pb-1.5">
            <button type="button" onClick={() => setYear((y) => y - 1)} className="rounded-[4px] p-1 text-slate-500 hover:bg-[#F3EFE6]" aria-label="Previous year" data-testid={`${testid}-month-prev`}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-bold text-slate-800" data-testid={`${testid}-month-year`}>{year}</p>
            <button type="button" onClick={() => setYear((y) => y + 1)} disabled={year >= thisYear} className="rounded-[4px] p-1 text-slate-500 hover:bg-[#F3EFE6] disabled:cursor-not-allowed disabled:opacity-30" aria-label="Next year" data-testid={`${testid}-month-next`}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          {MONTH_NAMES.map((name, m) => {
            const on = picked && picked.y === year && picked.m === m;
            const ahead = year > thisYear || (year === thisYear && m > now.getMonth());
            return (
              <button
                key={name}
                type="button"
                disabled={ahead}
                onClick={() => onPick(year, m)}
                role="menuitemradio"
                aria-checked={!!on}
                className={`flex w-full items-center justify-between rounded-[4px] px-2.5 py-1.5 text-left text-sm transition ${
                  on ? "bg-sky-100 font-semibold text-sky-700" : ahead ? "cursor-not-allowed text-slate-300" : "text-slate-700 hover:bg-[#F3EFE6]"
                }`}
                data-testid={`${testid}-month-${m + 1}`}
              >
                {name}
                {on && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

/**
 * Every window the finance book is read through, in the order they are reached for: the
 * whole book, then today, then the ranges that widen out from it, then an arbitrary one.
 * Yesterday sits directly under Today and This Month directly under This Week, so reading
 * the row left to right walks steadily backwards and outwards rather than stepping over a
 * week to reach a day and over last month to reach this one.
 *
 * "All" is first and is every board's default. A finance page that opened scoped to Today
 * would hide every collection and every expense older than this morning behind a filter
 * nobody set.
 *
 * A board that wants fewer passes its own list of keys — Approvals leaves Yesterday off,
 * because that desk signs off a batch rather than reads one evening back. The words and
 * the days behind them still come from lib/dateRange, so a board can drop a window but
 * cannot quietly mean something different by one it keeps.
 */
export const FINANCE_DATE_PRESETS = ["all", "today", "yesterday", "this_week", "this_month", "last_month", "custom"];
/**
 * The whole date filter, as a dialog laid out as Filter by Date's own: the windows down the
 * left, and a calendar on the right.
 *
 * It is the row's own contents rebuilt at a size worth reading, not a second filter. The
 * toolbar is where a window is changed in one tap while looking at the figures; this is
 * where you come when you are reading a calendar to decide, or when the row has shortened
 * to "Yest" and "This Mo" on a phone. Both set the same one value, so a window picked here
 * lights the same button up there. All is left off the rail: it is the row's first button
 * and the chip's X, and a dialog opened to narrow the book has no use for widening it.
 *
 * Centred over the board rather than hanging off the button that opened it: a panel
 * anchored to a chip in a toolbar opens across the very figures it is about to filter, and
 * gets clipped by whatever scrolls underneath it.
 *
 * A preset in the rail applies on the tap and closes, because there is nothing further to
 * say about it, and so does a month from Month's dropdown. So does a day tapped on the
 * calendar while it stands alone, which filters to that one day.
 *
 * Custom is the one that needs more, so it closes nothing: it turns the right-hand side
 * into two typed dates over the calendar, with Apply. Typed and picked at once, because a
 * range is two dates and people usually arrive knowing which two. Keying 04082026 is
 * quicker than navigating a grid twice; the grid is there for the times you are not.
 * Whichever is used the other follows, because they are one value shown two ways rather
 * than two controls to reconcile.
 *
 * `startOn` is the side it opens on: "custom" when it was opened to set a range (Custom
 * Range in the row, the chip, the phone dropdown), "day" for the plain calendar.
 */
const FilterByDateDialog = ({ preset, presets, from, to, startOn = "day", onPreset, onApply, onClose, phoneRail = true, testid }) => {
  const [view, setView] = useState(startOn);
  const [monthOpen, setMonthOpen] = useState(false);
  const [fromText, setFromText] = useState(() => isoToManual(from));
  const [toText, setToText] = useState(() => isoToManual(to));
  // Which end the next tap on the grid fills. Starts on From and moves itself to To, so
  // picking a range is two taps rather than two taps and a switch between them.
  const [editing, setEditing] = useState("from");

  const fromIsoVal = manualToIso(fromText);
  const toIsoVal = manualToIso(toText);
  const orderOk = !fromIsoVal || !toIsoVal || fromIsoVal <= toIsoVal;
  const ready = !!fromIsoVal && !!toIsoVal && orderOk;

  // What is in force, read back: a whole month lights Month and ticks it in the list, one
  // day is the day selected on the calendar.
  const inForce = preset === "custom" && !!from && !!to;
  const pickedMonth = inForce ? wholeMonth(from, to) : null;
  const pickedDay = inForce && from === to ? from : "";
  const rail = RAIL_ORDER.filter((key) => presets.includes(key));

  // Esc closes it, the way every other dismissable thing on these boards does -- the month
  // list first, while it is open, which handles its own Esc.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !monthOpen) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, monthOpen]);

  const pickDay = (iso) => {
    if (editing === "from") {
      setFromText(isoToManual(iso));
      // A new start after the end that was already there leaves a range running backwards.
      // Dropping the end asks for it again rather than quietly applying a swapped one.
      if (toIsoVal && iso > toIsoVal) setToText("");
      setEditing("to");
    } else {
      setToText(isoToManual(iso));
    }
  };

  // The whole box selects its end, not just the eight characters inside it — the label and
  // the padding around it are the obvious thing to aim at when switching From to To.
  const field = (label, text, set, bad, tid) => (
    <div
      onClick={() => setEditing(tid)}
      className={`min-w-0 flex-1 cursor-text rounded-[4px] border px-2.5 py-1.5 transition ${
        editing === tid ? "border-sky-400 bg-white ring-1 ring-sky-200" : "border-[#EFEAE0] bg-white/70"
      }`}
    >
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <input
        value={text}
        onChange={(e) => set(maskDayMonthYear(e.target.value, text))}
        onFocus={() => setEditing(tid)}
        onKeyDown={(e) => { if (e.key === "Enter" && ready) onApply(fromIsoVal, toIsoVal); }}
        inputMode="numeric"
        maxLength={10}
        placeholder="DD-MM-YYYY"
        className={`w-full bg-transparent text-sm outline-none ${bad ? "text-red-600" : "text-slate-800"}`}
        data-testid={`${testid}-${tid}`}
      />
    </div>
  );

  // One row across the top on a phone, a column down the side from sm. Two columns took
  // three rows to show six windows and pushed the calendar — the thing most people opened
  // this for — below the fold; the abbreviated labels are what buy the single row, and the
  // full wording comes back from sm up where the rail has the width for it.
  const railBtn = (on) => `min-w-0 flex-1 truncate rounded-[4px] px-1 py-2 text-center text-[11px] font-medium transition-colors sm:w-full sm:flex-none sm:px-3 sm:py-2 sm:text-left sm:text-sm ${
    on ? "bg-sky-100 font-semibold text-sky-700" : "text-slate-700 hover:bg-[#F3EFE6]"
  }`;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid={`${testid}-modal`}
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[4px] border border-[#EFEAE0] bg-[#FDFCF8] shadow-2xl sm:max-w-lg" data-testid={`${testid}-panel`}>
        <div className="flex items-center justify-between border-b border-[#EFEAE0] px-4 py-3">
          <p className="text-sm font-bold text-slate-800">Filter by Date</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600"
            title="Close"
            aria-label="Close"
            data-testid={`${testid}-close`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row">
          {/* The windows this board offers, then Custom and Month. flex and not a
              one-column grid from sm up: grid rows stretch to fill the dialog, which would
              spread six buttons down the whole height of the calendar beside them.

              Not on a phone opened from the dropdown (`phoneRail` false): the windows are
              the dropdown's own options, picked a tap before this opened, and six of them
              across a phone-wide dialog clip to "This …" and "Last …". That way in opens
              on Custom, the one side of this a phone without the rail can use. */}
          <div
            className={`${phoneRail ? "flex" : "hidden sm:flex"} gap-1 border-b border-[#EFEAE0] p-2 sm:w-40 sm:shrink-0 sm:flex-col sm:gap-0.5 sm:border-b-0 sm:border-r`}
            data-testid={`${testid}-presets`}
          >
            {rail.map((key) => {
              const on = key === "custom" ? view === "custom" : view !== "custom" && preset === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => (key === "custom" ? (setView("custom"), setEditing("from")) : onPreset(key))}
                  aria-pressed={on}
                  className={railBtn(on)}
                  data-testid={`${testid}-preset-${key}`}
                >
                  <span className="sm:hidden">{DATE_PRESET_SHORT[key]}</span>
                  <span className="hidden sm:inline">{RAIL_LABELS[key]}</span>
                </button>
              );
            })}
            {/* Held as a custom range, so it is offered wherever Custom is. */}
            {presets.includes("custom") && (
              <MonthMenu
                picked={pickedMonth}
                lit={view !== "custom" && !!pickedMonth}
                open={monthOpen}
                onOpenChange={setMonthOpen}
                onPick={(y, m) => { setMonthOpen(false); onApply(...monthRange(y, m)); }}
                btnClass={railBtn}
                testid={testid}
              />
            )}
          </div>

          {view === "custom" ? (
            <div className="min-w-0 flex-1 space-y-3 p-3" data-testid={`${testid}-range-panel`}>
              <div className="flex items-stretch gap-2">
                {field("From", fromText, setFromText, !!fromText && !fromIsoVal, "from")}
                {field("To", toText, setToText, (!!toText && !toIsoVal) || !orderOk, "to")}
              </div>

              {/* The grid keeps its own month as the end being filled changes, so picking a
                  From in March leaves March open to pick the To from. */}
              <MilkCalendar
                value={editing === "from" ? fromIsoVal : toIsoVal}
                min={editing === "to" ? fromIsoVal || undefined : undefined}
                accent="sky"
                onChange={pickDay}
                testid={`${testid}-calendar`}
              />

              {/* Says which of the two is wrong, rather than only greying Apply out. */}
              <p className="text-[11px] text-slate-400" data-testid={`${testid}-hint`}>
                {!orderOk
                  ? <span className="font-semibold text-red-500">From must not be after To.</span>
                  : (fromText && !fromIsoVal) || (toText && !toIsoVal)
                    ? <span className="font-semibold text-red-500">Use DD-MM-YYYY, e.g. 04-08-2026.</span>
                    : `Type both dates, or tap the grid to set ${editing === "from" ? "From" : "To"}.`}
              </p>

              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} className="flex-1 rounded-[4px]" data-testid={`${testid}-cancel`}>Cancel</Button>
                <Button
                  onClick={() => onApply(fromIsoVal, toIsoVal)}
                  disabled={!ready}
                  className="flex-1 rounded-[4px] bg-sky-600 hover:bg-sky-700"
                  data-testid={`${testid}-apply`}
                >
                  Apply
                </Button>
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-1 p-3">
              <MilkCalendar
                value={pickedDay}
                accent="sky"
                onChange={(day) => onApply(day, day)}
                testid={`${testid}-calendar`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
/**
 * The one date control every page of Finance is read through: the windows as a single
 * horizontal row of buttons, with an arbitrary range behind the last of them in a dialog.
 *
 * One row, never two. These windows are the first thing read on a finance page and the
 * thing most often changed, so they all stay on screen at once rather than folded into a
 * dropdown or stacked down the side of a popup. Where the width genuinely is not there, on
 * a phone, the row scrolls sideways instead of wrapping: a filter that reflows to two lines
 * pushes the figures it filters down the screen every time it is touched.
 *
 * The dates are held by the board rather than in here, so the range survives pressing Today
 * and coming back, and so the board reads the same [start, end] out of `rangeFor` that the
 * lit button is naming.
 *
 * Custom Range opens the dialog and lights nothing until Apply. Two date fields that appear
 * under one preset and vanish under the others — which is what these boards carried — move
 * everything below them up and down the page each time the window is changed, and stand
 * open saying nothing whenever some other preset is the one deciding it.
 *
 * @param preset      one of `presets`' keys.
 * @param customFrom  ISO start, meaningful only while preset is "custom".
 * @param customTo    ISO end, likewise.
 * @param onChange    (preset, from, to) => void. The two dates come back unchanged when a
 *                    preset is pressed, so the board keeps them for the next Custom Range.
 * @param presets     which windows this board offers, if not all of them.
 * @param variant     how the row is dressed, and whether it scrolls itself. See VARIANTS.
 * @param filterIcon  whether to close the row with a calendar button onto the same dialog
 *                    Custom Range opens, and light it while a range is in force. See below.
 * @param mobileSelect  below sm, the windows as one dropdown in place of the row, the chip
 *                    and the calendar button. Opt-in, for a board whose phone toolbar has
 *                    other filters to fit beside this one: the dropdown spells a custom
 *                    range out as its own option, and its Custom Range… opens the dialog.
 */

/**
 * The three shapes this row is worn in.
 *
 * `toolbar` is the house one, the same button Consultations and Pre-Sales carry their own
 * ranges on: 40px tall, square-cornered, bordered white while idle and filled solid when it
 * is the one deciding the screen. It stands alone on its line, so it has the width for full
 * padding and scrolls itself if a phone leaves it short.
 *
 * `pill` is Approvals', whose row shares one toolbar with the ledger switch and filter pills
 * of its own, all 30px tall. One group standing 10px taller than the group beside it reads
 * as a mistake rather than as a different kind of control. Borderless with 4px corners,
 * as that toolbar is.
 *
 * `inline` is the toolbar button on a diet, for Summary, where the row shares its line with
 * five tab buttons and the two together have to fit without wrapping. It gives back its
 * padding and a point of type, which is roughly a quarter of the row's width, and takes both
 * back on a desk genuinely wide enough for them. Borderless while idle, like the rest of
 * the Summary bar it sits in. It never scrolls itself: the toolbar it
 * sits in is the one scroll container, and a scrolling row inside a scrolling row is a trap
 * to get a mouse out of.
 *
 * That "wide enough" is 1900px, not 2xl. At 2xl the type and padding grew at 1536px, which
 * is about 240px before the row had the width for them, so a 1536-1900px window -- an
 * ordinary laptop, and the width this board is most often read at -- grew its buttons past
 * the edge and pushed Custom Range and Refresh into a scroll with no bar to show for it.
 * The row held everything a pixel under 1536 and lost two controls a pixel over it.
 */
const VARIANTS = {
  toolbar: {
    gap: "gap-1 sm:gap-2",
    scrolls: true,
    btn: "h-10 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium transition sm:px-3 sm:text-sm",
    on: "bg-sky-600 text-white",
    off: "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
  },
  inline: {
    gap: "gap-1 min-[1900px]:gap-1.5",
    scrolls: false,
    btn: "h-10 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium transition min-[1900px]:px-3 min-[1900px]:text-sm",
    on: "bg-sky-600 text-white",
    off: "bg-white text-slate-600 hover:bg-slate-50",
  },
  pill: {
    gap: "gap-1.5",
    scrolls: true,
    btn: "h-[30px] shrink-0 whitespace-nowrap rounded-[4px] px-3 text-xs font-medium transition",
    on: "bg-sky-600 text-white shadow-sm",
    off: "bg-white text-slate-600 hover:bg-slate-50 hover:text-sky-600",
  },
};

export const FinanceDateFilter = ({
  preset, customFrom = "", customTo = "", onChange,
  presets = FINANCE_DATE_PRESETS, variant = "toolbar", filterIcon = false,
  mobileSelect = false, testid = "finance-date",
}) => {
  // Closed, or the side the dialog opens on: "custom" for its two typed dates, "day" for
  // the calendar alone.
  const [open, setOpen] = useState(false);
  const hasRange = preset === "custom" && customFrom && customTo;
  // The calendar button reopens a range of several days on the two dates that make it up,
  // and anything else -- nothing set, one day, a whole month -- on the calendar.
  const iconView = hasRange && customFrom !== customTo && !wholeMonth(customFrom, customTo) ? "custom" : "day";
  const V = VARIANTS[variant] || VARIANTS.toolbar;
  const compact = variant === "pill";
  // Where the phone has the dropdown, the row and the chip are sm-and-up only.
  const rowShown = mobileSelect ? "hidden sm:flex" : "flex";

  return (
    <div className={`flex min-w-0 items-center ${V.gap} ${mobileSelect ? "flex-1 sm:flex-initial" : ""}`} data-testid={testid}>
      {mobileSelect && (
        <FilterSelect
          value={preset}
          onChange={(key) => (key === PICK_RANGE ? setOpen("custom") : onChange(key, customFrom, customTo))}
          active={preset !== "all"}
          label="Date range"
          title={hasRange ? rangeLabel(customFrom, customTo) : undefined}
          className="flex-1 sm:hidden"
          testid={`${testid}-select`}
        >
          {presets.filter((key) => key !== "custom").map((key) => (
            // "All" on its own beside the payment-mode dropdown's "All Modes" would not say
            // all of what.
            <option key={key} value={key}>{key === "all" ? "All Dates" : DATE_PRESET_LABELS[key]}</option>
          ))}
          {preset === "custom" && (
            <option value="custom">
              {!hasRange ? DATE_PRESET_LABELS.custom
                : customFrom === customTo || wholeMonth(customFrom, customTo) ? rangeLabel(customFrom, customTo)
                : `${shortDay(customFrom)} – ${shortDay(customTo)}`}
            </option>
          )}
          {presets.includes("custom") && <option value={PICK_RANGE}>Custom Range…</option>}
        </FilterSelect>
      )}

      {/* flex-nowrap over a sideways scroll, not flex-wrap: see the note above on why this
          stays one row at every width. The bar itself is hidden where the browser allows
          it, since a scrollbar under seven buttons reads as a broken control. */}
      <div className={`${rowShown} flex-nowrap items-center ${V.gap} ${
        V.scrolls ? "min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "shrink-0"
      }`}>
        {/* Custom Range is left off the row where the calendar button closes it: both open
            the one dialog, which has Custom (and Month) in its own rail. */}
        {presets.filter((key) => !(filterIcon && key === "custom")).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => (key === "custom" ? setOpen("custom") : onChange(key, customFrom, customTo))}
            aria-pressed={preset === key}
            className={`${V.btn} ${preset === key ? V.on : V.off}`}
            data-testid={`${testid}-preset-${key}`}
          >
            <span className="sm:hidden">{DATE_PRESET_SHORT[key]}</span>
            <span className="hidden sm:inline">{DATE_PRESET_LABELS[key]}</span>
          </button>
        ))}

        {/* The same dialog Custom Range opens, as a square at the end of the row, and in
            Custom Range's place: a row with this button does not carry that one. It is
            there so the row ends on something that reads as a control rather than as the
            last of five windows, and so the date filter is still one recognisable target
            on a narrow screen where the words have shortened to "Yest" and "This Mo".

            It is the one thing in the row that lights for a state rather than for a
            press: sky while a custom range is in force, which is also when the chip
            beside it is spelling that range out. Nothing else can be true of it -- it
            selects no window of its own -- so lighting it on the preset would be lighting
            it on something it did not do. */}
        {filterIcon && (
          <button
            type="button"
            onClick={() => setOpen(iconView)}
            aria-label="Filter by date"
            title="Filter by date"
            className={`flex shrink-0 items-center justify-center transition ${
              compact ? "rounded-[2px] border p-2" : "h-10 w-10 rounded-md"
            } ${hasRange ? V.on : V.off}`}
            data-testid={`${testid}-icon`}
          >
            <CalendarDays className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* The range that is actually in force, and the way back into the dialog to change
          it. The figures are filtered by it, so it has to be readable without opening
          anything. */}
      {hasRange && (
        <span className={`${rowShown} shrink-0 items-center`} data-testid={`${testid}-chip`}>
          <button
            type="button"
            onClick={() => setOpen("custom")}
            className={`flex items-center gap-1.5 border border-sky-200 bg-sky-50 font-medium text-sky-700 hover:bg-sky-100 ${
              compact ? "rounded-l-[2px] py-1.5 pl-3 pr-2 text-xs" : "h-10 rounded-l-md pl-3 pr-2 text-xs sm:text-sm"
            }`}
            data-testid={`${testid}-chip-edit`}
          >
            {/* Two calendars 4px apart, both onto the same dialog, read as two controls
                with one job between them. The lit button keeps the glyph; the chip keeps
                the dates, which is the part of it nothing else says -- a month picked from
                the dialog's Month as its name, "September 2026". */}
            {!filterIcon && <CalendarDays className="h-3.5 w-3.5" />}
            {rangeLabel(customFrom, customTo)}
          </button>
          <button
            type="button"
            onClick={() => onChange("all", "", "")}
            className={`border border-l-0 border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 ${
              compact ? "rounded-r-[2px] py-1.5 pl-1 pr-2.5" : "h-10 rounded-r-md pl-1 pr-2.5"
            }`}
            title="Clear date filter"
            aria-label="Clear date filter"
            data-testid={`${testid}-chip-clear`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}

      {/* The dialog carries the same list of windows this row does, less All, so what is
          offered in one place is what is offered in the other by construction rather than
          by two boards being kept in step by hand. */}
      {open && (
        <FilterByDateDialog
          preset={preset}
          presets={presets}
          from={customFrom}
          to={customTo}
          startOn={open}
          onPreset={(key) => { onChange(key, customFrom, customTo); setOpen(false); }}
          onClose={() => setOpen(false)}
          onApply={(f, t) => { onChange("custom", f, t); setOpen(false); }}
          phoneRail={!mobileSelect}
          testid={`${testid}-custom`}
        />
      )}
    </div>
  );
};

export default FinanceDateFilter;
