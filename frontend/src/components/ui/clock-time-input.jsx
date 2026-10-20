import { useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { to12h } from "@/lib/time";

const pad = (n) => String(n).padStart(2, "0");

const parse = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? { h, m } : { h: 9, m: 0 };
};

// The dial, in its own viewBox units. The numbers sit on one ring and the hand reaches it,
// so the picked number is always drawn inside the knob at the hand's tip.
const SIZE = 232;
const C = SIZE / 2;
const RING = 88;
const KNOB = 18;

const polar = (deg, r = RING) => {
  const rad = (deg * Math.PI) / 180;
  return { x: C + r * Math.sin(rad), y: C - r * Math.cos(rad) };
};

/**
 * A clock-face time dialog: the hour and minutes large across the top, AM / PM beside them,
 * and a dial underneath to set whichever of the two is lit. Tap (or drag to) an hour and it
 * moves on to the minutes by itself, so a time is two taps and OK.
 *
 * Dressed as Filter by Date is — the cream card, the soft border, the blurred ground and the
 * sky accent — so the two pickers read as one family rather than as a browser control and an
 * OS one.
 *
 * A Radix dialog rather than a fixed div because these fields live inside one: a nested Radix
 * layer stacks over its parent without the parent treating a tap on the dial as a click
 * outside it, and Esc shuts only the top one.
 */
const ClockDialog = ({ value, title, onCancel, onOk, testid }) => {
  const init = parse(value);
  const [hour, setHour] = useState(init.h % 12 || 12);
  const [minute, setMinute] = useState(init.m);
  const [pm, setPm] = useState(init.h >= 12);
  const [mode, setMode] = useState("hour");
  const svgRef = useRef(null);
  const dragging = useRef(false);

  const result = `${pad((hour % 12) + (pm ? 12 : 0))}:${pad(minute)}`;

  // Where the pointer is, as a reading on the dial: an hour snaps to the twelve numbers, a
  // minute to every one of the sixty, with the labels marking each five.
  const readAt = (e) => {
    const box = svgRef.current.getBoundingClientRect();
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    let deg = (Math.atan2(x, -y) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (mode === "hour") setHour(Math.round(deg / 30) % 12 || 12);
    else setMinute(Math.round(deg / 6) % 60);
  };

  const onDown = (e) => {
    dragging.current = true;
    svgRef.current.setPointerCapture?.(e.pointerId);
    readAt(e);
  };
  const onMove = (e) => { if (dragging.current) readAt(e); };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (mode === "hour") setMode("minute");
  };

  const marks = mode === "hour"
    ? Array.from({ length: 12 }, (_, i) => ({ n: i + 1, label: String(i + 1), deg: (i + 1) * 30 }))
    : Array.from({ length: 12 }, (_, i) => ({ n: i * 5, label: pad(i * 5), deg: i * 30 }));
  const handDeg = mode === "hour" ? hour * 30 : minute * 6;
  const tip = polar(handDeg);
  const picked = mode === "hour" ? hour : minute;

  const seg = (on) => `flex h-16 w-[4.5rem] items-center justify-center rounded-xl text-4xl font-semibold tabular-nums transition ${
    on ? "bg-sky-100 text-sky-700 ring-1 ring-sky-300" : "bg-[#F3EFE6] text-slate-700 hover:bg-[#EFEAE0]"
  }`;
  const half = (on) => `flex-1 px-3 text-xs font-bold transition ${
    on ? "bg-sky-600 text-white" : "bg-white text-slate-500 hover:bg-[#F3EFE6]"
  }`;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onOk(result); } }}
          className="fixed left-1/2 top-1/2 z-[80] max-h-[90vh] w-[calc(100%-1.5rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[#EFEAE0] bg-[#FDFCF8] shadow-2xl focus:outline-none"
          data-testid={`${testid}-modal`}
        >
          <div className="flex items-center justify-between border-b border-[#EFEAE0] px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-bold text-slate-800">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600"
              aria-label="Close"
              data-testid={`${testid}-close`}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-3 p-3 sm:p-4">
            <div className="flex items-stretch justify-center gap-2">
              <button type="button" onClick={() => setMode("hour")} className={seg(mode === "hour")} aria-label="Hour" data-testid={`${testid}-hour`}>
                {pad(hour)}
              </button>
              <span className="flex items-center text-3xl font-semibold text-slate-400">:</span>
              <button type="button" onClick={() => setMode("minute")} className={seg(mode === "minute")} aria-label="Minutes" data-testid={`${testid}-minute`}>
                {pad(minute)}
              </button>
              <div className="ml-1 flex h-16 w-14 flex-col divide-y divide-[#EFEAE0] overflow-hidden rounded-xl border border-[#EFEAE0]">
                <button type="button" onClick={() => setPm(false)} aria-pressed={!pm} className={half(!pm)} data-testid={`${testid}-am`}>AM</button>
                <button type="button" onClick={() => setPm(true)} aria-pressed={pm} className={half(pm)} data-testid={`${testid}-pm`}>PM</button>
              </div>
            </div>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="mx-auto block w-full max-w-[232px] cursor-pointer touch-none select-none"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              data-testid={`${testid}-dial`}
            >
              <circle cx={C} cy={C} r={C - 2} className="fill-[#F3EFE6]" />
              <line x1={C} y1={C} x2={tip.x} y2={tip.y} className="stroke-sky-600" strokeWidth={2} />
              <circle cx={C} cy={C} r={3.5} className="fill-sky-600" />
              <circle cx={tip.x} cy={tip.y} r={KNOB} className="fill-sky-600" />
              {/* A minute between the fives has no number to light, so the knob says so with a dot. */}
              {mode === "minute" && minute % 5 !== 0 && <circle cx={tip.x} cy={tip.y} r={3} className="fill-white" />}
              {marks.map(({ n, label, deg }) => {
                const p = polar(deg);
                return (
                  <text
                    key={label}
                    x={p.x}
                    y={p.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={`pointer-events-none text-[14px] ${n === picked ? "fill-white font-bold" : "fill-slate-600 font-medium"}`}
                  >
                    {label}
                  </text>
                );
              })}
            </svg>

            <p className="text-center text-[11px] text-slate-400" data-testid={`${testid}-hint`}>
              {mode === "hour" ? "Tap the hour on the clock." : "Now the minutes."}
              <span className="font-semibold text-slate-600"> {to12h(result)}</span>
            </p>

            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel} className="flex-1" data-testid={`${testid}-cancel`}>Cancel</Button>
              <Button onClick={() => onOk(result)} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-ok`}>OK</Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

/**
 * A time field that reads in 12-hour form and opens the clock dialog above, in place of
 * `<input type="time">` and the browser's 24-hour spinner columns.
 *
 * Drop-in: the value stays 24-hour `HH:MM`, which is what the API stores, and onChange gets
 * `{ target: { value } }`, so the handlers that fed the native input keep working unchanged.
 */
export const ClockTimeInput = ({
  value, onChange, disabled, className = "", placeholder = "Select time", title = "Select Time", ...rest
}) => {
  const [open, setOpen] = useState(false);
  const testid = rest["data-testid"] || "clock-time";

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${value ? "text-slate-700" : "text-slate-400"} ${className}`}
        {...rest}
      >
        <span className="truncate tabular-nums">{value ? to12h(value) : placeholder}</span>
        <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {open && (
        <ClockDialog
          value={value}
          title={title}
          onCancel={() => setOpen(false)}
          onOk={(t) => { onChange?.({ target: { value: t } }); setOpen(false); }}
          testid={testid}
        />
      )}
    </>
  );
};

/** 90 -> "1 h 30 min", 45 -> "45 min", 60 -> "1 h". */
export const durationLabel = (total) => {
  const n = Number(total) || 0;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return [h ? `${h} h` : "", m || !h ? `${m} min` : ""].filter(Boolean).join(" ");
};

const DURATION_PRESETS = [15, 30, 45, 60, 90];

/**
 * The clock dialog again, set to a length of time rather than a time of day: hours and
 * minutes large across the top, and the same dial to set whichever is lit. The hour face
 * runs 0 to 11 from the top, the minute face snaps to fives, and the common lengths sit
 * as chips under the readout so the usual answer is one tap.
 *
 * `fallback` is the length used when nothing is set here (FITSIO STORE's); when given,
 * a "Use … from FITSIO STORE" link hands back null to clear the override.
 */
export const ClockDurationDialog = ({
  value, title = "Session Duration", fallback, onCancel, onOk, testid = "clock-duration",
}) => {
  const init = Math.max(0, Number(value) || 0);
  const [hours, setHours] = useState(Math.min(11, Math.floor(init / 60)));
  const [minutes, setMinutes] = useState((Math.round((init % 60) / 5) * 5) % 60);
  const [mode, setMode] = useState(init >= 60 ? "hour" : "minute");
  const svgRef = useRef(null);
  const dragging = useRef(false);

  const total = hours * 60 + minutes;
  const valid = total >= 5;

  // A minute here snaps to the twelve fives — a session is never 37 minutes long.
  const readAt = (e) => {
    const box = svgRef.current.getBoundingClientRect();
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    let deg = (Math.atan2(x, -y) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (mode === "hour") setHours(Math.round(deg / 30) % 12);
    else setMinutes((Math.round(deg / 30) % 12) * 5);
  };

  const onDown = (e) => {
    dragging.current = true;
    svgRef.current.setPointerCapture?.(e.pointerId);
    readAt(e);
  };
  const onMove = (e) => { if (dragging.current) readAt(e); };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (mode === "hour") setMode("minute");
  };

  const pick = (n) => { setHours(Math.floor(n / 60)); setMinutes(n % 60); setMode("minute"); };

  const marks = mode === "hour"
    ? Array.from({ length: 12 }, (_, i) => ({ n: i, label: String(i), deg: i * 30 }))
    : Array.from({ length: 12 }, (_, i) => ({ n: i * 5, label: pad(i * 5), deg: i * 30 }));
  const handDeg = mode === "hour" ? hours * 30 : minutes * 6;
  const tip = polar(handDeg);
  const picked = mode === "hour" ? hours : minutes;

  const seg = (on) => `flex h-16 w-[4.5rem] flex-col items-center justify-center rounded-xl transition ${
    on ? "bg-sky-100 text-sky-700 ring-1 ring-sky-300" : "bg-[#F3EFE6] text-slate-700 hover:bg-[#EFEAE0]"
  }`;
  const chip = (on) => `rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
    on ? "border-sky-600 bg-sky-600 text-white" : "border-[#EFEAE0] bg-white text-slate-600 hover:bg-[#F3EFE6]"
  }`;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={(e) => { if (e.key === "Enter" && valid) { e.preventDefault(); onOk(total); } }}
          className="fixed left-1/2 top-1/2 z-[80] max-h-[90vh] w-[calc(100%-1.5rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[#EFEAE0] bg-[#FDFCF8] shadow-2xl focus:outline-none"
          data-testid={`${testid}-modal`}
        >
          <div className="flex items-center justify-between border-b border-[#EFEAE0] px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-bold text-slate-800">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600"
              aria-label="Close"
              data-testid={`${testid}-close`}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-3 p-3 sm:p-4">
            <div className="flex items-stretch justify-center gap-2">
              <button type="button" onClick={() => setMode("hour")} className={seg(mode === "hour")} aria-label="Hours" data-testid={`${testid}-hour`}>
                <span className="text-4xl font-semibold leading-none tabular-nums">{pad(hours)}</span>
                <span className="mt-1 text-[10px] font-bold uppercase tracking-wide opacity-70">hr</span>
              </button>
              <span className="flex items-center text-3xl font-semibold text-slate-400">:</span>
              <button type="button" onClick={() => setMode("minute")} className={seg(mode === "minute")} aria-label="Minutes" data-testid={`${testid}-minute`}>
                <span className="text-4xl font-semibold leading-none tabular-nums">{pad(minutes)}</span>
                <span className="mt-1 text-[10px] font-bold uppercase tracking-wide opacity-70">min</span>
              </button>
            </div>

            <div className="flex flex-wrap justify-center gap-1.5">
              {DURATION_PRESETS.map((n) => (
                <button key={n} type="button" onClick={() => pick(n)} className={chip(total === n)} data-testid={`${testid}-preset-${n}`}>
                  {durationLabel(n)}
                </button>
              ))}
            </div>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="mx-auto block w-full max-w-[232px] cursor-pointer touch-none select-none"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              data-testid={`${testid}-dial`}
            >
              <circle cx={C} cy={C} r={C - 2} className="fill-[#F3EFE6]" />
              <line x1={C} y1={C} x2={tip.x} y2={tip.y} className="stroke-sky-600" strokeWidth={2} />
              <circle cx={C} cy={C} r={3.5} className="fill-sky-600" />
              <circle cx={tip.x} cy={tip.y} r={KNOB} className="fill-sky-600" />
              {marks.map(({ n, label, deg }) => {
                const p = polar(deg);
                return (
                  <text
                    key={label}
                    x={p.x}
                    y={p.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={`pointer-events-none text-[14px] ${n === picked ? "fill-white font-bold" : "fill-slate-600 font-medium"}`}
                  >
                    {label}
                  </text>
                );
              })}
            </svg>

            <p className="text-center text-[11px] text-slate-400" data-testid={`${testid}-hint`}>
              {mode === "hour" ? "Tap the hours on the clock." : "Now the minutes."}
              <span className={`font-semibold ${valid ? "text-slate-600" : "text-rose-500"}`}>
                {" "}{valid ? `${durationLabel(total)} per session` : "At least 5 min"}
              </span>
            </p>

            {fallback ? (
              <button
                type="button"
                onClick={() => onOk(null)}
                className="block w-full text-center text-[11px] font-semibold text-sky-700 hover:underline"
                data-testid={`${testid}-reset`}
              >
                Use {durationLabel(fallback)} from FITSIO STORE
              </button>
            ) : null}

            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel} className="flex-1" data-testid={`${testid}-cancel`}>Cancel</Button>
              <Button onClick={() => onOk(total)} disabled={!valid} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-ok`}>OK</Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

export default ClockTimeInput;
