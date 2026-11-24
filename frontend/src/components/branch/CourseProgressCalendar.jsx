import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { to12h } from "@/lib/time";

/**
 * Treatment Progress / Rehab Progress: the whole course on a calendar, read only.
 *
 * Opened from the View button on the current physio card (Consultation > Physio Assign and
 * the Rehab card). It answers how far in the patient is — days completed, booked, missed and
 * still waiting on a date — and where those days fall, including days a previous physio ran.
 *
 * `days` is one row per course day: { id, day, date, time, status, physio_name, absences }.
 * Treatment gets them from GET physio-progress; rehab builds them with rehabCalendarDays.
 * status is "completed", "booked" (has a date) or "waiting" (no date yet).
 */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

/** Today in the browser's own timezone, never UTC. */
const localToday = () => {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth(), d.getDate());
};

const shortDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
};

const longDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
};

const byDate = (a, b) => `${a.date}T${a.time || ""}`.localeCompare(`${b.date}T${b.time || ""}`);

// Booked days wear the course's own colour: violet for treatment, cyan for rehab.
const TONES = {
  violet: {
    cell: "border border-violet-300 bg-white text-violet-700 hover:bg-violet-50",
    badge: "bg-violet-600",
    focus: "bg-violet-600 ring-violet-300",
    tile: "border-violet-300 bg-violet-50 text-violet-700 enabled:hover:bg-violet-100",
    num: "text-violet-600",
    pill: "bg-violet-100 text-violet-700",
    card: "border-violet-300 bg-violet-50 text-violet-700",
    sub: "text-violet-600",
  },
  cyan: {
    cell: "border border-cyan-300 bg-white text-cyan-700 hover:bg-cyan-50",
    badge: "bg-cyan-600",
    focus: "bg-cyan-600 ring-cyan-300",
    tile: "border-cyan-300 bg-cyan-50 text-cyan-700 enabled:hover:bg-cyan-100",
    num: "text-cyan-600",
    pill: "bg-cyan-100 text-cyan-700",
    card: "border-cyan-300 bg-cyan-50 text-cyan-700",
    sub: "text-cyan-600",
  },
};

/** Rehab days (GET /branch/rehab-sessions) as the rows this calendar reads. */
export const rehabCalendarDays = (rows) => (rows || []).map((r) => {
  const completed = r.status === "completed";
  const [slotDate = "", slotTime = ""] = String(r.slot_time || "").trim().split("T");
  const date = completed ? slotDate || String(r.completed_at || "").slice(0, 10) : slotDate;
  return {
    id: r.id,
    day: r.day_number,
    date,
    time: slotTime.slice(0, 5),
    status: completed ? "completed" : date ? "booked" : "waiting",
    physio_name: r.physio_name || "",
    absences: (r.absences || []).map((ab) => ({
      date: ab.date || "",
      day: ab.session_number || r.day_number,
      remarks: ab.remarks || "",
      marked_by: ab.marked_by || "",
    })),
  };
});

export function CourseProgressCalendar({
  title,
  leadName,
  physioName,
  days,
  packageDays,
  tone = "violet",
  dayNoun = "Day",
  showAllDays = true,
  onClose,
  testid = "course-progress",
}) {
  const skin = TONES[tone] || TONES.violet;
  const today = useMemo(localToday, []);
  const listRef = useRef(null);

  const list = useMemo(() => [...(days || [])].sort((a, b) => (a.day || 0) - (b.day || 0)), [days]);
  const completed = useMemo(() => list.filter((d) => d.status === "completed"), [list]);
  const booked = useMemo(() => list.filter((d) => d.status === "booked").sort(byDate), [list]);
  const waiting = useMemo(() => list.filter((d) => d.status === "waiting"), [list]);
  const absences = useMemo(
    () => list.flatMap((d) => (d.absences || []).map((ab) => ({ ...ab, physio_name: d.physio_name }))).sort(byDate),
    [list],
  );
  const total = packageDays || list.length;

  // Every date the course touches, with what happened on it. One date can hold more than
  // one: a day completed and another missed, or a day missed twice.
  const marks = useMemo(() => {
    const map = {};
    const on = (d) => (map[d] = map[d] || { completed: [], booked: [], absent: [] });
    list.forEach((d) => {
      if (d.date && d.status === "completed") on(d.date).completed.push(d);
      if (d.date && d.status === "booked") on(d.date).booked.push(d);
    });
    absences.forEach((ab) => { if (ab.date) on(ab.date).absent.push(ab); });
    return map;
  }, [list, absences]);

  // Opens on today when the patient has a day today, else on their next booked day, else on
  // the last day they came — the date the desk is most likely asking about.
  const [picked, setPicked] = useState(() => {
    if (marks[today]) return today;
    const next = booked.find((d) => d.date >= today);
    if (next) return next.date;
    const lastDone = [...completed].filter((d) => d.date).sort(byDate).pop();
    return lastDone?.date || booked[0]?.date || absences[absences.length - 1]?.date || null;
  });
  const [cursor, setCursor] = useState(() => {
    const [y, m] = (picked || today).split("-").map(Number);
    return { y, m: m - 1 };
  });

  const showMonth = (d) => {
    if (!d) return;
    const [y, m] = d.split("-").map(Number);
    setCursor({ y, m: m - 1 });
  };
  const focusDate = (d) => {
    if (!d) return;
    setPicked(d);
    showMonth(d);
  };
  const step = (delta) => setCursor(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const lastDoneDate = [...completed].filter((d) => d.date).sort(byDate).pop()?.date;
  const nextBookedDate = (booked.find((d) => d.date >= today) || booked[0])?.date;
  const lastAbsentDate = [...absences].filter((a) => a.date).pop()?.date;
  const pickedMarks = picked ? marks[picked] : null;

  const tiles = [
    { key: "completed", label: "Completed", count: completed.length, cls: "border-emerald-300 bg-emerald-50 text-emerald-700 enabled:hover:bg-emerald-100", num: "text-emerald-600", go: () => focusDate(lastDoneDate), can: !!lastDoneDate },
    { key: "booked", label: "Booked", count: booked.length, cls: skin.tile, num: skin.num, go: () => focusDate(nextBookedDate), can: !!nextBookedDate },
    { key: "absent", label: "Absent", count: absences.length, cls: "border-rose-300 bg-rose-50 text-rose-700 enabled:hover:bg-rose-100", num: "text-rose-600", go: () => focusDate(lastAbsentDate), can: !!lastAbsentDate },
    { key: "waiting", label: "Waiting for a date", count: waiting.length, cls: "border-amber-300 bg-amber-50 text-amber-700 enabled:hover:bg-amber-100", num: "text-amber-600", go: showAllDays ? () => listRef.current?.querySelector("[data-waiting]")?.scrollIntoView({ behavior: "smooth", block: "center" }) : null, can: showAllDays && waiting.length > 0 },
    { key: "total", label: "Total", count: total, cls: "border-slate-300 bg-white text-slate-700", num: "text-slate-600", go: null, can: false },
  ];

  const statusPill = (d) => (d.status === "completed"
    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Completed</span>
    : d.status === "booked"
    ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${skin.pill}`}>Booked</span>
    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">Waiting for a date</span>);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid={testid}
    >
      {/* Without All days the popup is only as tall as the calendar, not a fixed 84vh. */}
      <div className={`flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl sm:max-h-[84vh] ${showAllDays ? "h-[calc(100vh-1.5rem)] sm:h-[84vh]" : ""}`}>
        <div className="flex shrink-0 items-center gap-3 bg-slate-500 px-5 py-3 text-[12px] font-semibold uppercase leading-5 text-white [font-family:Inter,sans-serif]">
          <p className="min-w-0 flex-1 truncate" data-testid={`${testid}-title`}>
            {leadName || "Unknown"} <span className="font-normal opacity-80">with</span> {physioName || "the physio"}
          </p>
          <span className="hidden shrink-0 sm:block" data-testid={`${testid}-heading`}>{title}</span>
          <button type="button" onClick={onClose} className="shrink-0 text-white" aria-label="Close" data-testid={`${testid}-close`}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* The counts. Each one opens the month of its days. */}
        <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 sm:grid-cols-3 sm:px-4 lg:grid-cols-5">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.go || undefined}
              disabled={!t.can}
              className={`flex items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-left text-[11px] font-bold uppercase disabled:cursor-default sm:text-[12px] ${t.cls}`}
              data-testid={`${testid}-count-${t.key}`}
            >
              <span className="truncate">{t.label}</span>
              <span className={`shrink-0 font-semibold ${t.num}`}>{t.count}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className={`flex flex-col lg:flex-row ${showAllDays ? "border-b border-slate-200" : ""}`}>
            {/* Month grid: the day number badges each date the course touches. */}
            <div className="w-full flex-shrink-0 border-b border-slate-100 p-3 sm:p-4 lg:w-[19.5rem] lg:border-b-0 lg:border-r">
              <div className="mb-2 flex items-center justify-between">
                <button type="button" onClick={() => step(-1)} className="rounded p-1 hover:bg-slate-100" aria-label="Previous month" data-testid={`${testid}-prev-month`}>
                  <ChevronLeft className="h-4 w-4 text-slate-500" />
                </button>
                <h4 className="text-sm font-bold text-slate-700" data-testid={`${testid}-month`}>
                  {MONTH_NAMES[cursor.m]} {cursor.y}
                </h4>
                <button type="button" onClick={() => step(1)} className="rounded p-1 hover:bg-slate-100" aria-label="Next month" data-testid={`${testid}-next-month`}>
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                </button>
              </div>

              <div className="mb-1 grid grid-cols-7 gap-1">
                {WEEKDAY_LABELS.map((d) => (
                  <div key={d} className="py-0.5 text-center text-[11px] font-semibold text-slate-400">{d}</div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: new Date(cursor.y, cursor.m, 1).getDay() }, (_, i) => (
                  <div key={`pad-${i}`} className="h-9" />
                ))}
                {Array.from({ length: new Date(cursor.y, cursor.m + 1, 0).getDate() }, (_, i) => {
                  const day = i + 1;
                  const d = isoDate(cursor.y, cursor.m, day);
                  const m = marks[d];
                  const done = !!m?.completed.length;
                  const missed = !!m?.absent.length;
                  const upcoming = !!m?.booked.length;
                  const isFocused = picked === d;
                  const isToday = d === today;
                  const badges = [
                    done && { kind: "completed", day: m.completed[0].day || "C", fill: "bg-emerald-500" },
                    missed && { kind: "absent", day: m.absent[0].day || "A", fill: "bg-rose-500" },
                    upcoming && { kind: "booked", day: m.booked[0].day || "B", fill: skin.badge },
                  ].filter(Boolean).slice(0, 2);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setPicked(isFocused ? null : d)}
                      disabled={!m}
                      className={`relative h-9 rounded-[4px] text-[13px] font-semibold transition-all ${
                        isFocused
                          ? `${skin.focus} text-white shadow-md ring-2 ring-offset-1`
                          : done
                          ? "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          : missed
                          ? "border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                          : upcoming
                          ? skin.cell
                          : "cursor-default text-slate-400"
                      } ${isToday && !isFocused ? "ring-2 ring-slate-500 ring-offset-1" : ""}`}
                      title={[
                        isToday ? "Today" : "",
                        ...(m?.completed || []).map((x) => `${dayNoun} ${x.day || ""} · Completed${x.time ? ` · ${to12h(x.time)}` : ""}`),
                        ...(m?.absent || []).map((x) => `${dayNoun} ${x.day || ""} · Absent${x.remarks ? ` · ${x.remarks}` : ""}`),
                        ...(m?.booked || []).map((x) => `${dayNoun} ${x.day || ""} · Booked${x.time ? ` · ${to12h(x.time)}` : ""}`),
                      ].filter(Boolean).join("\n")}
                      data-testid={`${testid}-date-${d}`}
                    >
                      {day}
                      {badges.map((b, n) => (
                        <span
                          key={b.kind}
                          className={`absolute -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow-sm ${b.fill} ${n === 0 ? "-right-0.5" : "-left-0.5"}`}
                        >
                          {b.day}
                        </span>
                      ))}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[11px] font-semibold text-slate-500">
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> Completed</span>
                <span className="flex items-center gap-1"><span className={`inline-block h-2.5 w-2.5 rounded-full ${skin.badge}`} /> Booked</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" /> Absent</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-[3px] ring-2 ring-slate-500" /> Today</span>
              </div>
            </div>

            {/* The clicked date: which day, at what time, done by whom, or why it was missed. */}
            <div className="min-w-0 flex-1 p-3 sm:p-4" data-testid={`${testid}-day-panel`}>
              {picked ? (
                <>
                  <p className="mb-3 flex items-center gap-2 text-[14px] font-bold text-slate-800">
                    {longDate(picked)}
                    {picked === today && <span className="rounded-full bg-slate-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">Today</span>}
                  </p>
                  {pickedMarks ? (
                    <div className="space-y-2">
                      {pickedMarks.completed.map((x, i) => (
                        <div key={`c-${i}`} className="rounded-[4px] border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px]">
                          <p className="font-bold text-emerald-700">COMPLETED <span className="ml-2 font-medium text-emerald-600">{dayNoun} {x.day}</span></p>
                          <p className="mt-0.5 text-emerald-700">{x.time ? to12h(x.time) : "Time not recorded"}{x.physio_name ? ` · Physio: ${x.physio_name}` : ""}</p>
                        </div>
                      ))}
                      {pickedMarks.absent.map((x, i) => (
                        <div key={`a-${i}`} className="rounded-[4px] border border-rose-300 bg-rose-50 px-3 py-2 text-[12px]">
                          <p className="font-bold text-rose-700">ABSENT <span className="ml-2 font-medium text-rose-500">{dayNoun} {x.day}</span></p>
                          <p className="mt-0.5 text-rose-600">
                            {x.remarks || "No remarks"}
                            {x.marked_by ? ` · Marked by ${x.marked_by}` : ""}
                          </p>
                        </div>
                      ))}
                      {pickedMarks.booked.map((x, i) => (
                        <div key={`b-${i}`} className={`rounded-[4px] border px-3 py-2 text-[12px] ${skin.card}`}>
                          <p className="font-bold">BOOKED <span className={`ml-2 font-medium ${skin.sub}`}>{dayNoun} {x.day}</span></p>
                          <p className={`mt-0.5 ${skin.sub}`}>{x.time ? to12h(x.time) : "Time not set"}{x.physio_name ? ` · Physio: ${x.physio_name}` : ""}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-[4px] border border-dashed border-slate-200 px-3 py-6 text-center text-[12px] text-slate-400">Nothing on this date.</p>
                  )}
                </>
              ) : (
                <p className="rounded-[4px] border border-dashed border-slate-200 px-3 py-10 text-center text-[12px] text-slate-400">
                  Click a marked date to see its day.
                </p>
              )}
            </div>
          </div>

          {/* Every day of the course in order, including the ones with no date yet. Treatment
              Progress leaves it out (showAllDays false); Rehab Progress keeps it. */}
          {showAllDays && (
          <div className="p-3 sm:p-4" ref={listRef}>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">All days</p>
            {list.length === 0 ? (
              <p className="rounded-[4px] border border-dashed border-slate-200 px-3 py-6 text-center text-[12px] text-slate-400">No days booked yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-[4px] border border-slate-200">
                <table className="w-full min-w-[40rem] text-left text-[12px]" data-testid={`${testid}-list`}>
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">{dayNoun}</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Physio</th>
                      <th className="px-3 py-2">Absent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {list.map((d, i) => (
                      <tr
                        key={d.id || i}
                        onClick={() => focusDate(d.date)}
                        data-waiting={d.status === "waiting" ? "" : undefined}
                        className={`${d.date ? "cursor-pointer hover:bg-slate-50" : ""} ${d.date && d.date === picked ? "bg-slate-100" : ""}`}
                        data-testid={`${testid}-row-${d.day || i}`}
                      >
                        <td className="px-3 py-2 font-bold text-slate-700">{d.day || "—"}</td>
                        <td className="px-3 py-2 text-slate-700">
                          {d.date ? shortDate(d.date) : <span className="italic text-amber-600">No date yet</span>}
                          {d.date === today && <span className="ml-1.5 rounded-full bg-slate-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">Today</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{d.time ? to12h(d.time) : "—"}</td>
                        <td className="px-3 py-2">{statusPill(d)}</td>
                        <td className="px-3 py-2 text-slate-600">{d.physio_name || "—"}</td>
                        <td className="px-3 py-2 text-rose-600">
                          {(d.absences || []).length
                            ? d.absences.map((ab) => shortDate(ab.date) || "Date unknown").join(", ")
                            : <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
