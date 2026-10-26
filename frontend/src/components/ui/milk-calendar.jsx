import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { clamp, useFloatingPosition } from "@/lib/use-floating";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayIso = () => {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth(), d.getDate());
};

// Shared by the date and time pickers so a popup carries one colour through both.
const TONES = {
  amber: { on: "bg-amber-500 text-white shadow-sm", today: "border border-amber-300 text-amber-700", link: "text-amber-700 hover:bg-amber-100" },
  teal: { on: "bg-teal-600 text-white shadow-sm", today: "border border-teal-300 text-teal-700", link: "text-teal-700 hover:bg-teal-100" },
  sky: { on: "bg-sky-600 text-white shadow-sm", today: "border border-sky-300 text-sky-700", link: "text-sky-700 hover:bg-sky-100" },
};

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/** "14:30" → "2:30 PM". Values stay 24h `HH:MM` on the wire; only the label is 12h. */
export const formatSlotLabel = (hhmm) => {
  const mins = minutesOf(hhmm);
  if (mins == null) return "";
  const h = Math.floor(mins / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(mins % 60)} ${h >= 12 ? "PM" : "AM"}`;
};

/**
 * An always-open month picker in the OS's own palette, for popups where the native
 * `<input type="date">` picker looked like a browser dialog dropped onto the page — its
 * chrome, its blue, its typography, none of which can be styled.
 *
 * Milk white rather than pure white so it reads as a distinct surface against the white
 * popup behind it without needing a heavy border. `accent` lets a popup carry its own
 * colour through the picker: amber for Follow Up, teal elsewhere.
 *
 * `size="lg"` grows the day cells and the type for the popups that have room for it — the
 * default stays exactly as it was, so every existing caller is untouched. Only the cells
 * and the text scale; the month grid is still seven columns that fill their container.
 *
 * `className` is merged onto the card, so a caller can set its width or corners.
 */
export const MilkCalendar = ({ value, onChange, min, accent = "amber", testid = "milk-calendar", size = "md", className = "" }) => {
  const lg = size === "lg";
  const today = todayIso();
  const [cursor, setCursor] = useState(() => {
    const base = value || today;
    const [y, m] = base.split("-").map(Number);
    return { y, m: (m || 1) - 1 };
  });

  const firstDow = new Date(cursor.y, cursor.m, 1).getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const step = (delta) => setCursor(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const TONE = TONES[accent] || TONES.amber;
  const cellH = lg ? "h-11" : "h-8";

  return (
    <div className={cn("rounded-xl border border-[#EFEAE0] bg-[#FDFCF8] shadow-sm", lg ? "p-4" : "p-3", className)} data-testid={testid}>
      <div className={`flex items-center justify-between ${lg ? "mb-3" : "mb-2"}`}>
        <button type="button" onClick={() => step(-1)} className="rounded-lg p-1.5 text-slate-500 hover:bg-[#F3EFE6]" aria-label="Previous month" data-testid={`${testid}-prev`}>
          <ChevronLeft className={lg ? "h-5 w-5" : "h-4 w-4"} />
        </button>
        <p className={`font-bold text-slate-800 ${lg ? "text-base" : "text-sm"}`} data-testid={`${testid}-month`}>{MONTHS[cursor.m]} {cursor.y}</p>
        <button type="button" onClick={() => step(1)} className="rounded-lg p-1.5 text-slate-500 hover:bg-[#F3EFE6]" aria-label="Next month" data-testid={`${testid}-next`}>
          <ChevronRight className={lg ? "h-5 w-5" : "h-4 w-4"} />
        </button>
      </div>

      <div className={`grid grid-cols-7 ${lg ? "gap-1" : "gap-0.5"}`}>
        {DOW.map((d) => (
          <div key={d} className={`py-1 text-center font-bold uppercase tracking-wide text-slate-400 ${lg ? "text-[11px]" : "text-[10px]"}`}>{d}</div>
        ))}
        {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} className={cellH} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const d = iso(cursor.y, cursor.m, day);
          const disabled = min ? d < min : false;
          const selected = d === value;
          const isToday = d === today;
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              onClick={() => onChange(d)}
              className={`${cellH} rounded-lg font-semibold transition ${lg ? "text-[15px]" : "text-[13px]"} ${
                selected ? TONE.on
                  : disabled ? "cursor-not-allowed text-slate-300"
                  : isToday ? TONE.today
                  : "text-slate-600 hover:bg-[#F3EFE6]"
              }`}
              data-testid={`${testid}-day-${day}`}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className={`flex items-center justify-between border-t border-[#EFEAE0] ${lg ? "mt-3 pt-3" : "mt-2 pt-2"}`}>
        <button
          type="button"
          onClick={() => { setCursor({ y: new Date().getFullYear(), m: new Date().getMonth() }); onChange(today); }}
          className={`rounded-md px-2 py-1 font-bold ${lg ? "text-[13px]" : "text-[11px]"} ${TONE.link}`}
          data-testid={`${testid}-today`}
        >
          Today
        </button>
        <p className={`font-medium text-slate-500 ${lg ? "text-[13px]" : "text-[11px]"}`} data-testid={`${testid}-selected`}>
          {value
            ? new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
            : "No date picked"}
        </p>
      </div>
    </div>
  );
};

export default MilkCalendar;


/**
 * The shell both fields use in `centered` mode: an ordinary dialog over the popup that
 * opened it. A panel anchored to the field is clipped by the `overflow-hidden` on a modal
 * card, which swallows the last week of the month and the Today link.
 */
/** The calendar's own dialog — cream card, soft border, blurred ground. Exported so a
  * control that belongs beside a calendar can wear the same clothes rather than a
  * second copy of them drifting away from these. */
export const CenteredPicker = ({ title, onClose, testid, children }) => (
  <div
    className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4"
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    data-testid={testid}
  >
    <div className="max-h-[90vh] w-full max-w-xs overflow-y-auto rounded-2xl border border-[#EFEAE0] bg-[#FDFCF8] p-3 shadow-2xl sm:max-w-sm">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-sm font-bold text-slate-800">{title}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </div>
  </div>
);


/**
 * A date field that opens the calendar above in a popover, instead of whatever picker the
 * browser would show. Chrome's desktop dialog and the Android/iOS wheel are both
 * unstyleable and neither looks like the rest of the OS — on a phone especially, tapping a
 * date threw up a full-screen system control mid-form.
 *
 * Drop-in for `<Input type="date">`: onChange receives an event-shaped
 * `{ target: { value } }`, so existing `(e) => ...e.target.value` handlers keep working.
 */
/**
 * `iconOnly` squares the trigger down to the calendar glyph, for a toolbar where the
 * date sits beside other icon buttons and a labelled field reads as one more filter
 * rather than as the one control that opens a picker. The label is still carried on
 * `title`, and the chosen date colours the glyph so a filter in force is never silent.
 *
 * `besideRef` (a ref to a popup's card) floats the calendar outside that popup instead of
 * hanging it off the field inside it: to the card's right where the screen has room, else
 * its left, else (a phone) over the card under the field — always kept on screen.
 */
export const MilkDateInput = ({
  value, onChange, min, max, disabled, className = "", accent = "amber",
  placeholder = "Select date", centered = false, title = "Select Date", iconOnly = false,
  confirm = false, iconLeft = false, besideRef, ...rest
}) => {
  const [open, setOpen] = useState(false);
  // With `confirm`, a tapped day is only a draft until Confirm is pressed — a date that
  // books a patient in should not be set by a stray tap on the grid.
  const [draft, setDraft] = useState(value || "");
  const ref = useRef(null);
  const floatRef = useRef(null);
  const floating = !!besideRef && !centered;

  useEffect(() => { if (open) setDraft(value || ""); }, [open, value]);

  const floatPos = useFloatingPosition(open && floating, floatRef, (w, h) => {
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const field = ref.current.getBoundingClientRect();
    const card = besideRef.current?.getBoundingClientRect();
    let left;
    let top = field.top;
    if (card && vw - card.right >= w + gap * 2) left = card.right + gap;
    else if (card && card.left >= w + gap * 2) left = card.left - w - gap;
    else {
      left = field.left;
      top = field.bottom + 4;
      if (top + h > vh - gap) top = field.top - h - 4;
    }
    return { left: clamp(left, gap, vw - w - gap), top: clamp(top, gap, vh - h - gap) };
  });

  useEffect(() => {
    // A centred dialog is dismissed by its own backdrop; a document listener here would
    // also fire for clicks inside it.
    if (!open || centered) return undefined;
    const onDocClick = (e) => {
      if (ref.current?.contains(e.target) || floatRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, centered]);

  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : placeholder;

  const pick = (d) => { onChange?.({ target: { value: d } }); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={iconOnly
          ? `flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${className}`
          : `flex h-9 w-full items-center ${iconLeft ? "justify-start" : "justify-between"} gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${value ? "text-slate-800" : "text-muted-foreground"} ${className}`}
        aria-label={iconOnly ? title : undefined}
        {...rest}
      >
        {/* `iconLeft` puts the glyph before the date instead of after it. */}
        {iconLeft && !iconOnly && <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />}
        {!iconOnly && <span className="truncate">{label}</span>}
        {(iconOnly || !iconLeft) && <CalendarDays className={`h-4 w-4 shrink-0 ${iconOnly && value ? "text-sky-600" : "text-slate-400"}`} />}
      </button>

      {/* `centered` opens the calendar as a normal dialog in the middle of the screen
          instead of a panel hanging off the field. Anchored is right for a plain page form,
          where the calendar sits under the input it fills; it is wrong in a toolbar above a
          table, where the panel opens over the rows and gets clipped by whatever scrolls,
          and wrong inside a popup, where the card's own clipping cuts the grid off. */}
      {open && (centered ? (
        <CenteredPicker title={title} onClose={() => setOpen(false)} testid={`${rest["data-testid"] || "milk-date"}-modal`}>
          <MilkCalendar value={confirm ? draft : value} min={min} max={max} accent={accent} onChange={confirm ? setDraft : pick} />
          {confirm && (
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                data-testid={`${rest["data-testid"] || "milk-date"}-cancel`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!draft}
                onClick={() => pick(draft)}
                className={`h-9 rounded-md px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${(TONES[accent] || TONES.amber).on}`}
                data-testid={`${rest["data-testid"] || "milk-date"}-confirm`}
              >
                Confirm
              </button>
            </div>
          )}
        </CenteredPicker>
      ) : floating ? (
        // In a portal, so the popup's card cannot clip it; over the popup (z-[60]) and
        // under the clock dialog (z-[80]). 220px, a quarter wider than the grid's own
        // ~176px, with 4px corners like the popup it sits beside.
        createPortal(
          <div
            ref={floatRef}
            className="fixed z-[75] w-[220px] max-w-[calc(100vw-16px)]"
            style={floatPos || { top: 0, left: 0, visibility: "hidden" }}
            data-testid={`${rest["data-testid"] || "milk-date"}-float`}
          >
            <MilkCalendar value={value} min={min} max={max} accent={accent} onChange={pick} className="rounded shadow-xl" />
          </div>,
          document.body,
        )
      ) : (
        // Right-aligned and above/below by container flow; w-max keeps the grid from being
        // squeezed by a narrow field.
        <div className="absolute left-0 z-50 mt-1 w-max">
          <MilkCalendar value={value} min={min} max={max} accent={accent} onChange={pick} />
        </div>
      ))}
    </div>
  );
};


/** `2026-08-31` → `31/08/2026`. Anything that is not a whole ISO date reads as empty,
 *  so a half-typed or cleared value never shows as a mangled one. */
export const isoToDmy = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

/** `31/08/2026` → `2026-08-31`, or "" if that is not a real day. The round-trip through
 *  Date is the calendar check: JS rolls 31/02 forward to March, so a value that comes back
 *  reporting a different day than it was given was never a date in the first place. */
export const dmyToIso = (t) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(t || "").trim());
  if (!m) return "";
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (d.getFullYear() !== Number(yyyy) || d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return "";
  return `${yyyy}-${mm}-${dd}`;
};

/** Keeps the field reading DD/MM/YYYY while it is being keyed in: digits only, eight of
 *  them at most, separators put in rather than typed. Grouping off the digits instead of
 *  appending a "/" after the second one is what lets backspace work — deleting the slash
 *  in "12/" leaves "12", which regroups to "12" rather than instantly growing it back. */
const maskDmy = (raw) => {
  // A pasted ISO date is turned round rather than fed to the grouper, which would read its
  // year as a day and give "20/26/0831". Dates get copied out of this app in ISO — a paste
  // that lands as garbage looks like the field rejecting a date it plainly understands.
  const pastedIso = isoToDmy(String(raw || "").trim());
  const digits = String(pastedIso || raw || "").replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("/");
};

/**
 * A date field that is typed rather than picked — same contract as MilkDateInput above
 * (ISO `YYYY-MM-DD` in, `{ target: { value } }` out), so the two are interchangeable at a
 * call site and nothing downstream can tell which one filled the value.
 *
 * The month grid is the right control for booking a day — you are reading a calendar to
 * choose one. It is the wrong one for a report's from/to, where the operator already knows
 * both dates and wants them entered: picking a range three months back is two fields and
 * six taps through the grid against twelve keystrokes here.
 *
 * The value is only emitted once eight digits spell a real day inside min/max. Until then
 * the parent holds "" — a half-typed date is not a date, and a range that recomputed on
 * "3", then "31", then "31/0" would refilter the board under the operator mid-keystroke.
 * `text` is therefore the field's own state: the prop cannot hold "31/0" to render back.
 */
export const MilkDateTextInput = ({
  value, onChange, min, max, disabled, className = "",
  placeholder = "DD/MM/YYYY", ...rest
}) => {
  const [text, setText] = useState(() => isoToDmy(value));
  // What we last handed the parent. A `value` matching it is our own emission coming back
  // round, which must not reset the text the operator is still typing into.
  const emitted = useRef(value || "");

  useEffect(() => {
    if ((value || "") === emitted.current) return;
    emitted.current = value || "";
    setText(isoToDmy(value));
  }, [value]);

  const iso = dmyToIso(text);
  // What the field is worth right now: the typed day, or "" while it is unfinished, not a
  // real date, or outside the bounds a sibling field sets.
  const out = iso && (!min || iso >= min) && (!max || iso <= max) ? iso : "";
  // Only once all eight digits are in — a date is not wrong for being unfinished.
  const invalid = text.replace(/\D/g, "").length === 8 && !out;

  // Emitted from an effect rather than from the keystroke, so the field also speaks up when
  // `min`/`max` move under it. A range whose end was refused for preceding its start must
  // become the filter the moment the start is pulled back — deciding only on keypress left
  // both fields reading as filled while the parent still held nothing from this one.
  useEffect(() => {
    if (out === emitted.current) return;
    emitted.current = out;
    onChange?.({ target: { value: out } });
  }, [out]); // eslint-disable-line react-hooks/exhaustive-deps

  const handle = (e) => setText(maskDmy(e.target.value));

  // The class list is merged rather than concatenated. `w-full` here and a caller's
  // `w-[7.25rem]` are two classes of equal specificity, so which one wins is decided by the
  // order Tailwind emits them in, not the order they are written — and w-full was winning.
  // A caller asking for a narrow field got a full-width one, which is how a from/to pair in
  // a filter row came to stack instead of sitting side by side. cn() drops the class being
  // overridden, so an override means what it says.
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={10}
      disabled={disabled}
      value={text}
      onChange={handle}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-red-400 text-red-600 focus:border-red-500" : "border-input text-slate-800 focus:border-sky-500",
        className,
      )}
      {...rest}
    />
  );
};


/** Clinic hours. Appointments are taken between these, in half-hour slots. */
export const SLOT_DAY_START = "10:00";
export const SLOT_DAY_END = "22:00";

/**
 * The bookable half-hours of a day as chips, in the OS's palette.
 *
 * A free-text clock let anyone type 03:17, or 4am — times no branch is open for. Slots
 * make the answer a pick from what the clinic actually offers, and the grid reads at a
 * glance in a way a stepper never does.
 *
 * A `value` outside the range still shows, as its own chip ahead of the grid: older
 * bookings and branch hours predate these limits and must not be silently rewritten by
 * merely opening the picker.
 */
export const MilkTimeSlots = ({
  value, onChange, from = SLOT_DAY_START, to = SLOT_DAY_END, step = 30,
  accent = "amber", testid = "milk-time",
}) => {
  const TONE = TONES[accent] || TONES.amber;
  const slots = useMemo(() => {
    const start = minutesOf(from) ?? 600;
    const end = minutesOf(to) ?? 1320;
    const out = [];
    for (let t = start; t <= end; t += step) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    return out;
  }, [from, to, step]);

  const offGrid = value && !slots.includes(value) ? value : null;

  return (
    <div className="rounded-xl border border-[#EFEAE0] bg-[#FDFCF8] p-3 shadow-sm" data-testid={testid}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-bold text-slate-800">Pick a Slot</p>
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          {formatSlotLabel(slots[0])} – {formatSlotLabel(slots[slots.length - 1])}
        </p>
      </div>

      {offGrid && (
        <button
          type="button"
          onClick={() => onChange(offGrid)}
          className={`mb-2 w-full rounded-lg px-2 py-1.5 text-[12px] font-semibold ${TONE.on}`}
          data-testid={`${testid}-offgrid`}
        >
          {formatSlotLabel(offGrid)} <span className="font-medium opacity-80">· outside clinic hours</span>
        </button>
      )}

      <div className="grid max-h-[240px] grid-cols-3 gap-1 overflow-y-auto sm:grid-cols-4" data-testid={`${testid}-grid`}>
        {slots.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={`h-8 rounded-lg px-1 text-[12px] font-semibold transition ${
              s === value ? TONE.on : "text-slate-600 hover:bg-[#F3EFE6]"
            }`}
            data-testid={`${testid}-slot-${s}`}
          >
            {formatSlotLabel(s)}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-[#EFEAE0] pt-2">
        <p className="text-[11px] font-bold text-slate-400">{slots.length} slots</p>
        <p className="text-[11px] font-medium text-slate-500" data-testid={`${testid}-selected`}>
          {value ? formatSlotLabel(value) : "No time picked"}
        </p>
      </div>
    </div>
  );
};

/**
 * A time field that opens the slot grid above, replacing `<input type="time">` — whose
 * picker is the browser's spinner column, unstyleable and happy to accept any minute of
 * the night.
 *
 * Drop-in: the value stays 24h `HH:MM` and onChange receives `{ target: { value } }`, so
 * existing handlers and everything downstream are untouched.
 */
export const MilkTimeInput = ({
  value, onChange, disabled, className = "", accent = "amber",
  from = SLOT_DAY_START, to = SLOT_DAY_END, step = 30,
  placeholder = "Select time", centered = false, title = "Select Time", ...rest
}) => {
  const [open, setOpen] = useState(false);
  const [drop, setDrop] = useState("down");
  const ref = useRef(null);

  useEffect(() => {
    // As on the date field: a centred dialog closes on its own backdrop, so a document
    // listener here would also catch clicks on the slots inside it.
    if (!open || centered) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, centered]);

  // These sit low in tall popups (Follow Up puts Time under a full month grid), where a
  // downward panel would open past the bottom of the screen.
  const toggle = () => {
    if (!open && !centered && ref.current) {
      const box = ref.current.getBoundingClientRect();
      setDrop(window.innerHeight - box.bottom < 340 && box.top > 340 ? "up" : "down");
    }
    setOpen((o) => !o);
  };

  const pick = (t) => { onChange?.({ target: { value: t } }); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${value ? "text-slate-800" : "text-muted-foreground"} ${className}`}
        {...rest}
      >
        <span className="truncate">{value ? formatSlotLabel(value) : placeholder}</span>
        <Clock className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (centered ? (
        <CenteredPicker title={title} onClose={() => setOpen(false)} testid={`${rest["data-testid"] || "milk-time"}-modal`}>
          <MilkTimeSlots value={value} from={from} to={to} step={step} accent={accent} onChange={pick} />
        </CenteredPicker>
      ) : (
        <div className={`absolute left-0 z-50 w-max min-w-full ${drop === "up" ? "bottom-full mb-1" : "mt-1"}`}>
          <MilkTimeSlots value={value} from={from} to={to} step={step} accent={accent} onChange={pick} />
        </div>
      ))}
    </div>
  );
};
