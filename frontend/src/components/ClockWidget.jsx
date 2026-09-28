/**
 * The clock in the header — everyone's own record of the day they worked.
 *
 *     Clock In  →  Break Out  →  Break In  →  Clock Out
 *                     (why?)
 *
 * In the header rather than on a board because it belongs to the person signed in, not to
 * any one desk: a physio, a receptionist and the Super Admin all clock the same way, and
 * the header is the only thing on screen for all of them.
 *
 * Whatever can be pressed right now is a button, sitting in the bar. The state's other
 * facts — when the day started, which breaks were taken and why — live behind the pill
 * next to it, because they are read once or twice a day and the header is not theirs to
 * fill. See backend/routers/v3_clock.py: the four states and which action each allows come
 * down with every reply, so this file never decides what is pressable, it draws what it
 * was told.
 *
 * Times come from the server, always. A browser clock somebody can change is not a record,
 * and two people in one clinic disagreeing about when 9 AM was is the thing a register
 * exists to settle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Coffee, LogIn, LogOut, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { clockToday, clockIn, clockBreakOut, clockBreakIn, clockOut, clockHistory, eodToday } from "@/lib/api";
import { EodReportSheet } from "@/components/eod/EodReportSheet";
// Shared with HR's register, which shows the same day from the other side.
import { duration, prettyTime } from "@/lib/clock";

// Fired after every successful press, for screens that show the same day.
export const CLOCK_CHANGED_EVENT = "clock:changed";

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

// How often the header re-reads its own numbers. A minute is the smallest unit anything
// here is shown in, so counting faster would only redraw the same figure.
const TICK_MS = 30000;

/** The elapsed figures, moved forward locally between fetches.
 *
 *  The server sends what was true when it answered. Rather than asking again every thirty
 *  seconds for a number that only goes up, the time since that answer is added on — so the
 *  header ticks on one request instead of a hundred and twenty a shift. Every press
 *  refetches, so the local guess never gets to be more than half a minute out.
 */
const elapsed = (day, fetchedAt, now) => {
  const since = Math.max(Math.floor((now - fetchedAt) / 60000), 0);
  if (day?.state === "working") return { worked: day.worked_minutes + since, onBreak: 0 };
  if (day?.state === "on_break") return { worked: day.worked_minutes, onBreak: (day.breaks.find((b) => b.running)?.minutes || 0) + since };
  return { worked: day?.worked_minutes || 0, onBreak: 0 };
};

/** A modal, portalled to the body so no header stacking context can crop it. */
const Sheet = ({ title, subtitle, onClose, children, wide, testid }) => createPortal(
  <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center" data-testid={testid}>
    <div className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl bg-white shadow-2xl`}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100" aria-label="Close" data-testid={`${testid}-close`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  </div>,
  document.body,
);

/**
 * What the break is for, asked before it starts.
 *
 * Six taps and a box. The presets are the common answers and come down from the server, so
 * one clinic's list is one list; the box is there because the interesting breaks are the
 * ones nobody thought to preset, and forcing those into "Personal" would lose exactly the
 * detail this question was asked for.
 */
const BreakReasonSheet = ({ presets, busy, onStart, onClose }) => {
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const reason = (typed.trim() || picked).trim();
  return (
    <Sheet title="Going on a break" subtitle="Say what it is for — it goes on your record for the day." onClose={onClose} testid="clock-break-sheet">
      <div className="flex flex-wrap gap-2" data-testid="clock-break-presets">
        {(presets || []).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => { setPicked(r); setTyped(""); }}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              picked === r && !typed.trim()
                ? "border-amber-500 bg-amber-500 text-white"
                : "border-slate-200 text-slate-600 hover:border-amber-300 hover:bg-amber-50"
            }`}
            data-testid={`clock-break-preset-${r}`}
          >
            {r}
          </button>
        ))}
      </div>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        maxLength={80}
        placeholder="Or type another reason…"
        className="mt-3 h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
        data-testid="clock-break-other"
      />
      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={onClose} className="flex-1" data-testid="clock-break-cancel">Cancel</Button>
        <Button
          onClick={() => onStart(reason)}
          disabled={!reason || busy}
          className="flex-1 bg-amber-500 text-white hover:bg-amber-600"
          data-testid="clock-break-start"
        >
          {busy ? "Starting…" : "Start Break"}
        </Button>
      </div>
      {!reason && <p className="mt-2 text-center text-[11px] text-slate-400">Pick one or type your own to start the break.</p>}
    </Sheet>
  );
};

/** Today, in full: when it started, every break and why, and where the hours went. */
const TodaySheet = ({ day, live, onClose, onHistory, onReport, reportFiled }) => (
  <Sheet title="Your day" subtitle={day.date} onClose={onClose} testid="clock-today-sheet">
    <div className="grid grid-cols-2 gap-2">
      <Figure label="Clocked in" value={prettyTime(day.clock_in) || "—"} testid="clock-today-in" />
      <Figure label="Clocked out" value={prettyTime(day.clock_out) || (day.state === "done" ? "—" : "Still on")} testid="clock-today-out" />
      <Figure label="Worked" value={duration(live.worked)} tone="text-emerald-600" testid="clock-today-worked" />
      <Figure label="On breaks" value={duration(day.break_minutes + live.onBreak)} tone="text-amber-600" testid="clock-today-breaks" />
    </div>

    <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Breaks</p>
    {day.breaks.length === 0 ? (
      <p className="mt-1 rounded-lg border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">No breaks today.</p>
    ) : (
      <ul className="mt-1 divide-y divide-slate-100" data-testid="clock-today-break-list">
        {day.breaks.map((b, i) => (
          <li key={i} className="flex items-center justify-between gap-3 py-2" data-testid={`clock-today-break-${i}`}>
            <span className="min-w-0">
              <span className="block truncate text-sm text-slate-700">{b.reason}</span>
              <span className="block text-[11px] text-slate-400">
                {prettyTime(b.out)} → {b.running ? "still out" : prettyTime(b.in)}
              </span>
            </span>
            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-bold ${b.running ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
              {duration(b.minutes)}
            </span>
          </li>
        ))}
      </ul>
    )}

    <Button variant="outline" onClick={onHistory} className="mt-4 w-full" data-testid="clock-today-history">
      <CalendarDays className="h-4 w-4" />My attendance history
    </Button>
    {/* Physios and Consultants only: a report skipped at Clock Out can still be filed. */}
    {onReport && (
      <Button variant="outline" onClick={onReport} className="mt-2 w-full" data-testid="clock-today-eod">
        <ClipboardList className="h-4 w-4" />{reportFiled ? "Edit EOD report" : "Submit EOD report"}
      </Button>
    )}
  </Sheet>
);

const Figure = ({ label, value, tone = "text-slate-800", testid }) => (
  <div className="rounded-lg border border-slate-200 px-3 py-2" data-testid={testid}>
    <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
    <span className={`mt-0.5 block text-lg font-extrabold ${tone}`}>{value}</span>
  </div>
);

const monthLabel = (m) => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "");
const shiftMonth = (m, by) => {
  const d = new Date(`${m}-01T00:00:00`);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

/** Their own month: every day they clocked, with the breaks that were taken on it.
 *
 *  Only ever their own — the endpoint behind this takes no id. Somebody who wants to read
 *  the whole clinic's month is asking for HR's register, which is gated as it always was.
 */
const HistorySheet = ({ onClose }) => {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setLoading(true);
    clockHistory(month).then(setData).catch(fail).finally(() => setLoading(false));
  }, [month]);

  const totals = data?.totals;
  return (
    <Sheet title="My attendance" subtitle="Every day you clocked, and where the hours went." onClose={onClose} wide testid="clock-history-sheet">
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} data-testid="clock-history-prev"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm font-semibold text-slate-700" data-testid="clock-history-month">{monthLabel(month)}</span>
        <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, 1))} data-testid="clock-history-next"><ChevronRight className="h-4 w-4" /></Button>
      </div>

      {totals && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Figure label="Days" value={totals.days_clocked} testid="clock-history-days" />
          <Figure label="Worked" value={duration(totals.worked_minutes)} tone="text-emerald-600" testid="clock-history-worked" />
          <Figure label="On breaks" value={duration(totals.break_minutes)} tone="text-amber-600" testid="clock-history-breaks" />
        </div>
      )}

      {loading && !data ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : (data?.days || []).length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          Nothing clocked this month.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="clock-history-list">
          {data.days.map((d) => (
            <li key={d.date} data-testid={`clock-history-day-${d.date}`}>
              <button
                type="button"
                onClick={() => setOpen(open === d.date ? null : d.date)}
                className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50"
              >
                <span className="w-28 shrink-0 text-sm font-medium text-slate-700">{dayLabel(d.date)}</span>
                <span className="w-40 shrink-0 text-xs text-slate-500">
                  {prettyTime(d.clock_in) || "—"} <span className="text-slate-300">→</span> {prettyTime(d.clock_out) || "—"}
                </span>
                <span className="text-xs font-semibold text-emerald-600">{duration(d.worked_minutes)}</span>
                {d.breaks.length > 0 && (
                  <span className="ml-auto shrink-0 rounded bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                    {d.breaks.length} {d.breaks.length === 1 ? "break" : "breaks"} · {duration(d.break_minutes)}
                  </span>
                )}
              </button>
              {/* The reasons are the point of keeping breaks at all, so they are one click
                  from the day rather than a screen away. Collapsed by default: most days
                  are read for their hours, not for why somebody stepped out at 3. */}
              {open === d.date && d.breaks.length > 0 && (
                <ul className="mb-2 ml-2 border-l-2 border-amber-200 pl-3" data-testid={`clock-history-breaks-${d.date}`}>
                  {d.breaks.map((b, i) => (
                    <li key={i} className="py-1 text-xs text-slate-600">
                      <span className="font-medium">{b.reason}</span>
                      <span className="text-slate-400"> · {prettyTime(b.out)} → {b.running ? "still out" : prettyTime(b.in)} · {duration(b.minutes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
};

export const ClockWidget = () => {
  const [day, setDay] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null); // null | "break" | "today" | "history" | "eod"
  // Today's EOD report state, for Physios and Consultants — null until read, and
  // eligible:false for everybody else, who never see the popup.
  const [eod, setEod] = useState(null);
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await clockToday();
      if (!mounted.current) return;
      setDay(d);
      setFetchedAt(Date.now());
    } catch {
      // A header that cannot reach the clock says nothing rather than throwing a toast
      // over whatever the person actually came here to do. The next press reports properly.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    // Coming back to a tab left open since morning: the figures are re-read rather than
    // carried on from wherever the local count had drifted to.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const live = useMemo(() => elapsed(day, fetchedAt, Date.now()), [day, fetchedAt]);

  // Asked after Clock Out, and read once on load so "Your day" can offer the report.
  const loadEod = useCallback(async () => {
    try {
      const info = await eodToday();
      if (mounted.current) setEod(info);
      return info;
    } catch { return null; }
  }, []);

  useEffect(() => { loadEod(); }, [loadEod]);

  const openEod = async () => {
    const info = await loadEod();
    if (info?.eligible) setSheet("eod");
  };

  const act = async (fn, done, after) => {
    setBusy(true);
    try {
      const d = await fn();
      setDay((prev) => ({ ...prev, ...d }));
      setFetchedAt(Date.now());
      // The Attendance page is drawn from the same record, so tell it to read it again
      // rather than leaving it on whatever it loaded before this press.
      try { window.dispatchEvent(new Event(CLOCK_CHANGED_EVENT)); } catch (err) { /* noop */ }
      if (done) toast.success(done);
      setSheet((s) => (s === "break" ? null : s));
      if (after) after();
    } catch (e) {
      fail(e);
      // Whatever was refused, the day on screen was not what the server had — so take its
      // word for it rather than leaving a button that cannot work.
      load();
    } finally { setBusy(false); }
  };

  if (!day) return null;

  const can = (a) => (day.actions || []).includes(a);
  const onBreak = day.state === "on_break";

  return (
    <>
      {/* The pill: what the day is doing, and the way in to the rest of it. Its own
          button so the actions beside it are never mis-tapped by somebody who only
          wanted to look. */}
      {day.state !== "out" && (
        <button
          type="button"
          onClick={() => setSheet("today")}
          title="Your day so far"
          className={`hidden shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-semibold transition sm:inline-flex ${
            onBreak
              ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
              : day.state === "done"
                ? "border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100"
                : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          }`}
          data-testid="clock-pill"
        >
          {onBreak ? <Coffee className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
          {onBreak
            ? `On break · ${duration(live.onBreak)}`
            : day.state === "done"
              ? `Out ${prettyTime(day.clock_out)} · ${duration(live.worked)}`
              : `In ${prettyTime(day.clock_in)} · ${duration(live.worked)}`}
        </button>
      )}

      {can("clock_in") && (
        <Button size="sm" disabled={busy} onClick={() => act(clockIn, day.state === "done" ? "Clocked in again" : "Clocked in — have a good day")} className="shrink-0 rounded-[2px] bg-emerald-500 px-2 hover:bg-emerald-600 sm:px-3" data-testid="clock-in-button">
          <LogIn className="h-4 w-4" /><span className="hidden sm:inline">Clock In</span>
        </Button>
      )}

      {can("break_out") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setSheet("break")} className="shrink-0 border-amber-200 px-2 text-amber-700 hover:bg-amber-50 sm:px-3" data-testid="clock-break-out-button">
          <Coffee className="h-4 w-4" /><span className="hidden sm:inline">Break Out</span>
        </Button>
      )}

      {can("break_in") && (
        <Button size="sm" disabled={busy} onClick={() => act(clockBreakIn, "Welcome back")} className="shrink-0 bg-amber-500 px-2 hover:bg-amber-600 sm:px-3" data-testid="clock-break-in-button">
          <Play className="h-4 w-4" /><span className="hidden sm:inline">Break In</span>
        </Button>
      )}

      {can("clock_out") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(clockOut, "Clocked out", async () => {
          // The end-of-day report, for Physios and Consultants who have not filed one yet.
          const info = await loadEod();
          if (info?.eligible && !info.report) setSheet("eod");
        })} className="shrink-0 border-slate-200 px-2 text-slate-600 hover:bg-slate-50 sm:px-3" data-testid="clock-out-button">
          <LogOut className="h-4 w-4" /><span className="hidden sm:inline">Clock Out</span>
        </Button>
      )}

      {sheet === "break" && (
        <BreakReasonSheet
          presets={day.break_reasons}
          busy={busy}
          onStart={(reason) => act(() => clockBreakOut(reason), "Break started")}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "today" && (
        <TodaySheet
          day={day}
          live={live}
          onClose={() => setSheet(null)}
          onHistory={() => setSheet("history")}
          onReport={eod?.eligible ? openEod : null}
          reportFiled={!!eod?.report}
        />
      )}
      {sheet === "history" && <HistorySheet onClose={() => setSheet(null)} />}
      {sheet === "eod" && eod?.eligible && (
        <EodReportSheet info={eod} onClose={() => setSheet(null)} onSaved={(report) => setEod((e) => ({ ...e, report }))} />
      )}
    </>
  );
};
