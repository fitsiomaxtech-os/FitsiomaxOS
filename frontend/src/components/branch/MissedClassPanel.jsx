import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeatDots } from "@/components/ui/seat-dots";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import { unscheduledSessions, scheduleSession, getDoctorCalendar, listStoreItems } from "@/lib/api";
import { slotRange12h, to12h } from "@/lib/time";
import { displayPhone } from "@/lib/phone";

/**
 * Treatment days an absence left without a date.
 *
 * When a patient misses a day, the Physio marks it absent and every later day steps down
 * into the slot in front of it, so the course stays on times the physio actually published.
 * The last day then has nowhere to go, and it lands here — the Branch Admin books the days
 * onto the physio's calendar in the first place, and this is the same act done once more.
 *
 * It is a queue rather than a notice because a day sitting in it is a day of treatment the
 * patient has paid for and is not being given. Nothing else in the OS is watching for that.
 */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

/**
 * Today in the browser's own timezone. `toISOString` is UTC, and east of Greenwich that
 * hands back yesterday for the first hours of the day — which would offer a date the
 * patient can no longer attend and hide one they still can.
 */
const localToday = () => {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth(), d.getDate());
};

/** Used until FITSIO STORE answers — the length PHYSIO CALENDAR publishes slots on. */
const FALLBACK_SESSION_MINUTES = 30;

const longDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

/** The picked day in the header, worded the way the assign Slot Picker words it. */
const headerDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
};

/** Rehab and treatment are separate courses with their own numbering, so a day says which. */
const dayName = (s) => `${s.track === "rehab" ? "Rehab Day" : "Day"} ${s.session_number}`;

/**
 * The waiting days gathered one entry per patient, in the order the server lists them.
 *
 * Every waiting day of a course carries that whole course's absences, so they are counted
 * once per course rather than once per day — added up day by day, three waiting days would
 * count each absence three times.
 */
const byPatient = (rows) => {
  const held = new Map();
  rows.forEach((r) => {
    const key = r.lead_id || r.id;
    if (!held.has(key)) held.set(key, []);
    held.get(key).push(r);
  });
  return [...held.entries()].map(([key, found]) => {
    const days = [...found].sort((a, b) => (a.track === "rehab" ? 1 : 0) - (b.track === "rehab" ? 1 : 0));
    const courses = new Map(days.map((d) => [d.track, d.absent_days || []]));
    return {
      key,
      days,
      name: days[0].lead_name || "Unknown",
      contact: days[0].patient_number || displayPhone(days[0].phone) || "—",
      physios: [...new Set(days.map((d) => d.physio_name).filter(Boolean))],
      absentCount: [...courses.values()].flat().length,
    };
  });
};

const shortDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
};

/**
 * Pick a published slot for one dateless day.
 *
 * The same month grid the assign picker uses, for the same reason: this is the assign act
 * done once more, and a Branch Admin who places a whole course on a calendar should not
 * have to read a second, differently shaped picker to place the one day that fell out of
 * it. A flat run of date chips stood here before — it could not say which month a date
 * belonged to, and a physio publishing two months ahead filled the popup with buttons
 * before the times were reached.
 *
 * Only what the physio has opened is offered — the server refuses anything else, and
 * offering a time it will reject is a worse answer than not offering it. Past dates are
 * dropped for the same reason a missed day is being rebooked at all: it has to be a day
 * the patient can still attend.
 */
function SlotPicker({ session, days, onPick, onClose, onBooked }) {
  const [calendar, setCalendar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pickedDate, setPickedDate] = useState(null);
  // The time chosen on that day. Booked from the footer, as the assign Slot Picker does,
  // rather than on the tile click itself.
  const [pickedSlot, setPickedSlot] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sessionMinutes, setSessionMinutes] = useState(FALLBACK_SESSION_MINUTES);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getDoctorCalendar(session.physio_id)
      .then((data) => { if (!cancelled) setCalendar(data); })
      .catch(() => { if (!cancelled) { setCalendar(null); setFailed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.physio_id]);

  // How long one treatment session runs, read from FITSIO STORE exactly the way PHYSIO
  // CALENDAR reads it, so the end time shown against a slot is the end of the slot being
  // booked rather than a guess that drifts once the branch changes the package.
  useEffect(() => {
    let cancelled = false;
    listStoreItems(undefined, "session")
      .then((items) => {
        const configured = (items || []).map((i) => i.duration_minutes).find((d) => Number(d) > 0);
        if (!cancelled && configured) setSessionMinutes(Number(configured));
      })
      .catch(() => { /* keep the fallback */ });
    return () => { cancelled = true; };
  }, []);

  const capacity = calendar?.slot_capacity || 1;
  const today = useMemo(localToday, []);

  // Where this day is allowed to land. Treatment days are worked in number order — the
  // physio is refused a day whose predecessors are not signed off — so the day that fell
  // out of the course has to be re-booked after the rest of it, not into the first gap
  // going. Offering next Tuesday when the patient is booked solid until October produces a
  // slot nobody can deliver: the physio opens the day, the board refuses it, and the
  // patient is turned away a second time over the same absence.
  //
  // One end only. The server keeps a dateless day numbered after every booked one
  // (course_order), so nothing booked ever sits after it. Bounding it by "the next booked
  // day" as well once left a window too small to hold a single slot, and this popup said
  // the physio had no free time with their whole month open.
  const courseEnd = session.course_end || "";

  // Every slot this physio has published after that point, grouped by the day it falls
  // on. Full slots stay in, unlike the chip list this replaced: the day panel has the room
  // to draw them for what they are, and a time shown as taken tells the branch more than
  // a time that silently isn't there.
  const slotsByDate = useMemo(() => {
    const map = {};
    for (const slot of calendar?.slots || []) {
      const [d, t] = String(slot).split("T");
      if (!d || !t || d < today) continue;
      // Slots are normalized `YYYY-MM-DDTHH:MM`, so they compare as strings in time order.
      if (courseEnd && slot <= courseEnd) continue;
      (map[d] = map[d] || []).push(t);
    }
    Object.values(map).forEach((times) => times.sort());
    return map;
  }, [calendar, today, courseEnd]);

  const seatsTaken = useCallback((slot) => calendar?.occupancy?.[slot] || 0, [calendar]);

  // A slot this same patient is already standing in. The seat count cannot express it —
  // the physio may well have room — but the patient cannot be treated twice in the same
  // half hour, and the day placed there would collide with the one already booked.
  const ownSlot = useCallback(
    (slot) => (calendar?.occupants?.[slot] || []).some((o) => o.lead_id === session.lead_id),
    [calendar, session.lead_id],
  );

  // One gate for every place that asks "can this slot be picked" — the month grid's dots,
  // the open count in the header, and the tile itself.
  const slotOpen = useCallback(
    (slot) => seatsTaken(slot) < capacity && !ownSlot(slot),
    [seatsTaken, capacity, ownSlot],
  );

  const openOn = useCallback(
    (d) => (slotsByDate[d] || []).filter((t) => slotOpen(`${d}T${t}`)).length,
    [slotsByDate, slotOpen],
  );

  const openDates = useMemo(
    () => Object.keys(slotsByDate).filter((d) => openOn(d) > 0).sort(),
    [slotsByDate, openOn],
  );
  const openSlotCount = useMemo(
    () => openDates.reduce((n, d) => n + openOn(d), 0),
    [openDates, openOn],
  );

  // Land on a month that has something in it. A physio whose next free day is three weeks
  // out opened onto an empty grid, which reads as "no slots at all" rather than "not this
  // month". Once, when the calendar arrives — paging to a quiet month afterwards is the
  // Branch Admin looking around, and must not be undone under them.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || openDates.length === 0) return;
    landed.current = true;
    const [y, m] = openDates[0].split("-").map(Number);
    setCursor({ y, m: m - 1 });
  }, [openDates]);

  // The course by date, so the calendar marks it: the days the patient came to, the ones
  // they missed and the ones still booked, which are why those dates cannot be picked. One
  // date can hold more than one of them, and one day can be missed twice.
  const presentDays = useMemo(() => session.present_days || [], [session.present_days]);
  const absentDays = useMemo(() => session.absent_days || [], [session.absent_days]);
  const bookedDays = useMemo(() => session.booked_days || [], [session.booked_days]);
  const attendance = useMemo(() => {
    const map = {};
    const on = (d) => (map[d] = map[d] || { present: [], absent: [], booked: [] });
    presentDays.forEach((x) => { if (x.date) on(x.date).present.push(x); });
    absentDays.forEach((x) => { if (x.date) on(x.date).absent.push(x); });
    bookedDays.forEach((x) => { if (x.date) on(x.date).booked.push(x); });
    return map;
  }, [presentDays, absentDays, bookedDays]);

  // The grid opens on the first month with a free slot, which is usually past the days
  // already worked. The Present and Absent counts page it back to the latest of theirs.
  const showMonthOf = (days) => {
    const last = days[days.length - 1]?.date;
    if (!last) return;
    const [y, m] = last.split("-").map(Number);
    setCursor({ y, m: m - 1 });
  };

  const step = (delta) => setCursor(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const book = async (slot) => {
    setSaving(true);
    try {
      const res = await scheduleSession(session.id, slot);
      const [d, t] = slot.split("T");
      // The number the day ends up with. With two days waiting, booking the later one
      // swaps it with the earlier so the course stays in date order.
      const booked = res?.session?.session_number ?? res?.session?.day_number ?? session.session_number;
      toast.success(`Day ${booked} booked for ${shortDate(d)} at ${to12h(t)}`);
      // Waited for, so this day cannot be booked a second time while the list reloads.
      await onBooked();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't book that slot");
    }
    setSaving(false);
  };

  const dayTimes = pickedDate ? slotsByDate[pickedDate] || [] : [];
  const dayNoun = session.track === "rehab" ? "Rehab Day" : "Day";
  const pickedMarks = pickedDate ? attendance[pickedDate] : null;

  const pickDate = (d) => {
    setPickedDate(pickedDate === d ? null : d);
    setPickedSlot(null);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl sm:h-[84vh] sm:max-h-[84vh]"
        data-testid="missed-class-slot-picker"
      >
        {/* One row, as on the assign Slot Picker: patient with physio, the picked date, close. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-3 py-2 text-slate-900 sm:flex-nowrap sm:px-4 sm:py-2.5">
          <p className="min-w-0 truncate text-[13px] font-semibold leading-tight text-slate-900 sm:text-[15px]" data-testid="missed-class-picker-title">
            {session.lead_name || "Unknown"} <span className="font-normal text-slate-400">with</span>{" "}
            <span className="text-[#8b5cf6]">{session.physio_name || "the physio"}</span>
          </p>
          {pickedDate && (
            <span className="shrink-0 border-l border-slate-200 pl-3 text-[13px] font-bold text-slate-800 sm:text-[15px]" data-testid="missed-class-picked-date">
              {headerDate(pickedDate)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[13px] font-bold text-slate-800 sm:text-[15px]" data-testid="missed-class-picker-heading">Slot Picker to Give a Date</span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
            data-testid="missed-class-picker-dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Why this day is here, on one line that scrolls sideways rather than wrapping. */}
        <div className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 sm:px-4 sm:py-2">
          <div className="flex items-stretch gap-2 overflow-x-auto whitespace-nowrap sm:gap-2.5">
            <span
              className="inline-flex shrink-0 items-center rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700 sm:px-3 sm:text-[12px]"
              data-testid="missed-class-picker-day"
            >
              MISSED
              {/* Every day this patient is waiting on; the filled one is being booked. */}
              {days.length > 1 ? (
                <span className="ml-2 inline-flex items-center gap-1">
                  {days.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => s.id !== session.id && onPick(s)}
                      disabled={saving}
                      aria-pressed={s.id === session.id}
                      className={`rounded px-1.5 font-medium ${
                        s.id === session.id ? "bg-amber-600 text-white" : "text-amber-600 hover:bg-amber-100"
                      }`}
                      data-testid={`missed-class-picker-day-${s.id}`}
                    >
                      {dayName(s)}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="ml-2 font-medium text-amber-600">{dayName(session)}</span>
              )}
            </span>
            {session.last_absence && (
              <span className="hidden shrink-0 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-700 sm:inline sm:px-3 sm:text-[12px]">
                ABSENT
                <span className="ml-2 font-medium text-rose-500">{shortDate(session.last_absence.date)}</span>
                {session.last_absence.remarks && (
                  <span className="ml-2 font-medium text-rose-500">{session.last_absence.remarks}</span>
                )}
              </span>
            )}
            {/* Why the calendar starts where it does: the patient is booked until here. */}
            {courseEnd && (
              <span
                className="shrink-0 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 sm:px-3 sm:text-[12px]"
                data-testid="missed-class-picker-course-end"
              >
                SLOTS END
                <span className="ml-2 font-medium text-emerald-600">{shortDate(courseEnd.split("T")[0])}</span>
                <span className="ml-2 font-medium text-emerald-600">{to12h(courseEnd.split("T")[1])}</span>
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <p className="flex-1 px-5 py-14 text-center text-sm text-slate-400">Loading this physio's calendar...</p>
        ) : failed ? (
          <div className="flex-1 p-4">
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-12 text-center text-sm text-slate-400">
              Couldn't load {session.physio_name || "this physio"}'s calendar.
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            {/* Month grid — a dot marks a day this physio still has room on */}
            <div className="w-full flex-shrink-0 border-b border-slate-100 p-3 sm:p-4 lg:w-[19.5rem] lg:border-b-0 lg:border-r lg:overflow-y-auto">
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => step(-1)}
                  className="rounded p-1 hover:bg-slate-100"
                  aria-label="Previous month"
                  data-testid="missed-class-prev-month"
                >
                  <ChevronLeft className="h-4 w-4 text-slate-500" />
                </button>
                <h4 className="text-sm font-bold text-slate-700" data-testid="missed-class-month">
                  {MONTH_NAMES[cursor.m]} {cursor.y}
                </h4>
                <button
                  type="button"
                  onClick={() => step(1)}
                  className="rounded p-1 hover:bg-slate-100"
                  aria-label="Next month"
                  data-testid="missed-class-next-month"
                >
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
                  const dayOpen = openOn(d);
                  const isFocused = pickedDate === d;
                  const marks = attendance[d];
                  const wasPresent = !!marks?.present.length;
                  const wasAbsent = !!marks?.absent.length;
                  const isBooked = !!marks?.booked.length;
                  // The day number, as the assign Slot Picker badges a completed day. A date
                  // holding two kinds shows one in each corner; the hover names them all.
                  const badges = [
                    wasPresent && { kind: "present", day: marks.present[0].day || "P", fill: "bg-emerald-500" },
                    wasAbsent && { kind: "absent", day: marks.absent[0].day || "A", fill: "bg-rose-500" },
                    isBooked && { kind: "booked", day: marks.booked[0].day || "B", fill: "bg-slate-500" },
                  ].filter(Boolean).slice(0, 2);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => pickDate(d)}
                      disabled={dayOpen === 0 && !marks}
                      className={`relative h-9 rounded-md text-[13px] font-semibold transition-all ${
                        isFocused
                          ? "bg-violet-600 text-white shadow-md ring-2 ring-violet-300 ring-offset-1"
                          : wasPresent
                          ? "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          : wasAbsent
                          ? "border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                          : dayOpen > 0
                          ? "text-slate-600 hover:bg-slate-100"
                          : `border border-slate-300 bg-slate-100 text-slate-500 ${isBooked ? "hover:bg-slate-200" : "cursor-not-allowed"}`
                      }`}
                      title={[
                        ...(marks?.present || []).map((x) => `${dayNoun} ${x.day || ""} · Present`),
                        ...(marks?.absent || []).map((x) => `${dayNoun} ${x.day || ""} · Absent${x.remarks ? ` · ${x.remarks}` : ""}`),
                        ...(marks?.booked || []).map((x) => `${dayNoun} ${x.day || ""} · Booked · ${to12h(x.time)}`),
                        dayOpen > 0
                          ? `${dayOpen} slot${dayOpen > 1 ? "s" : ""} open`
                          : marks ? ""
                          : d < today ? "Already past"
                          : d <= courseEnd.split("T")[0] ? `Blocked · booked until ${shortDate(courseEnd.split("T")[0])}`
                          : "No slots free",
                      ].filter(Boolean).join("\n")}
                      data-testid={`missed-class-date-${d}`}
                    >
                      {day}
                      {badges.map((b, n) => (
                        <span
                          key={b.kind}
                          className={`absolute -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow-sm ${b.fill} ${n === 0 ? "-right-0.5" : "-left-0.5"}`}
                          data-testid={`missed-class-${b.kind}-${d}`}
                        >
                          {b.day}
                        </span>
                      ))}
                      {dayOpen > 0 && !isFocused && (
                        <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-emerald-400" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* How much of the course the patient came to. Each opens its latest month. */}
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => showMonthOf(presentDays)}
                  disabled={presentDays.length === 0}
                  className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 enabled:hover:bg-emerald-100 disabled:cursor-default sm:text-[12px]"
                  data-testid="missed-class-present-count"
                >
                  PRESENT
                  <span className="font-semibold text-emerald-600">{presentDays.length} Day{presentDays.length === 1 ? "" : "s"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => showMonthOf(absentDays)}
                  disabled={absentDays.length === 0}
                  className="flex items-center justify-between rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 enabled:hover:bg-rose-100 disabled:cursor-default sm:text-[12px]"
                  data-testid="missed-class-absent-count"
                >
                  ABSENT
                  <span className="font-semibold text-rose-600">{absentDays.length} Day{absentDays.length === 1 ? "" : "s"}</span>
                </button>
              </div>

              <div className="mt-3 hidden flex-wrap items-center gap-2.5 text-[11px] font-semibold text-slate-500 sm:flex">
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> Present day</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" /> Absent day</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-500" /> Booked day</span>
                <span className="flex items-center gap-1" data-testid="missed-class-legend-blocked"><span className="inline-block h-2.5 w-2.5 rounded-[3px] border border-slate-300 bg-slate-100" /> Blocked day</span>
                <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Slots open</span>
              </div>
            </div>

            {/* Times published on the focused date. overflow and flex-1 only from lg, where
                the calendar and the times are side-by-side columns that scroll on their
                own; stacked on a phone, a scroller inside the body's own scroller traps the
                times in a short box the last of them cannot be reached in. */}
            <div className={`${pickedDate || openDates.length === 0 ? "" : "hidden sm:block"} w-full flex-shrink-0 p-3 sm:p-4 lg:flex-1 lg:overflow-y-auto`}>
              {/* What happened on the picked date, above any time still open on it. */}
              {pickedMarks && (
                <div className="mb-3 space-y-1.5" data-testid="missed-class-day-details">
                  {pickedMarks.present.map((x, i) => (
                    <p key={`p-${i}`} className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] font-bold text-emerald-700">
                      PRESENT
                      <span className="ml-2 font-medium text-emerald-600">{dayNoun} {x.day}</span>
                    </p>
                  ))}
                  {pickedMarks.absent.map((x, i) => (
                    <p key={`a-${i}`} className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-700">
                      ABSENT
                      <span className="ml-2 font-medium text-rose-500">{dayNoun} {x.day}</span>
                      {x.remarks && <span className="ml-2 font-medium text-rose-500">{x.remarks}</span>}
                    </p>
                  ))}
                  {pickedMarks.booked.map((x, i) => (
                    <p key={`b-${i}`} className="rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-[12px] font-bold text-slate-700">
                      BOOKED
                      <span className="ml-2 font-medium text-slate-500">{dayNoun} {x.day}</span>
                      <span className="ml-2 font-medium text-slate-500">{to12h(x.time)}</span>
                    </p>
                  ))}
                </div>
              )}
              {!pickedDate && openDates.length === 0 ? (
                <p className="rounded-lg border border-dashed border-amber-200 bg-amber-50 px-3 py-10 text-center text-sm text-amber-800" data-testid="missed-class-no-slots">
                  {session.physio_name || "This physio"} has no free slots published
                  {courseEnd
                    ? ` after ${longDate(courseEnd.split("T")[0])}, when ${session.lead_name || "this patient"}'s booked days run out.`
                    : " from today on."}
                  <span className="mt-1 block text-xs font-normal text-amber-700">
                    Open some days in MANAGEMENT → PHYSIO CALENDAR, then come back.
                  </span>
                </p>
              ) : !pickedDate ? (
                <div className="flex h-full items-center justify-center py-10">
                  <div className="text-center">
                    <Calendar className="mx-auto mb-2 h-10 w-10 text-slate-200" />
                    <p className="text-sm text-slate-400">Pick a date to see this physio's open times</p>
                  </div>
                </div>
              ) : dayTimes.length === 0 ? pickedMarks ? null : (
                <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm text-slate-400">
                  Nothing published on this day — open it in MANAGEMENT → PHYSIO CALENDAR first.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-2 lg:grid-cols-3" data-testid="missed-class-slot-grid">
                  {dayTimes.map((time) => {
                    const slot = `${pickedDate}T${time}`;
                    const seats = seatsTaken(slot);
                    const mine = ownSlot(slot);
                    const shut = !slotOpen(slot);
                    const picked = pickedSlot === slot;
                    const range = slotRange12h(time, sessionMinutes);
                    return (
                      <button
                        key={time}
                        type="button"
                        disabled={shut || saving}
                        onClick={() => setPickedSlot(picked ? null : slot)}
                        className={`w-full overflow-hidden rounded-lg border-2 p-2 text-left transition-all ${
                          shut
                            ? "cursor-not-allowed border-amber-300 bg-amber-50 opacity-70"
                            : picked
                            ? "border-emerald-500 bg-emerald-100 shadow-md ring-2 ring-emerald-200"
                            : "border-emerald-200 bg-white hover:border-emerald-400 hover:bg-emerald-50 hover:shadow-sm disabled:opacity-50"
                        }`}
                        title={mine
                          ? `${session.lead_name || "This patient"} already has a day at ${to12h(time)} — pick another time`
                          : shut
                          ? `Full · ${seats}/${capacity}`
                          : `${range} · ${seats}/${capacity} taken${picked ? " — click to unselect" : ""}`}
                        data-testid={`missed-class-slot-${slot}`}
                      >
                        <p className={`flex items-center gap-1.5 text-[12px] font-bold ${shut ? "text-amber-800" : picked ? "text-emerald-900" : "text-emerald-800"}`}>
                          <span className="min-w-0 truncate whitespace-nowrap">{range}</span>
                          <SeatDots taken={seats} capacity={capacity} />
                        </p>
                        <div className={`mt-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold ${shut ? "text-amber-700" : picked ? "text-emerald-800" : "text-emerald-700"}`}>
                          {picked ? (
                            <>
                              <span>{dayNoun} {session.session_number}</span>
                              <span className="inline-flex items-center gap-0.5 rounded border border-current px-1 py-0.5 leading-tight">
                                <X className="h-2.5 w-2.5" />unselect
                              </span>
                            </>
                          ) : (
                            <span className="font-medium opacity-60">{mine ? "already here" : shut ? "full" : "open"}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end border-t border-slate-200 bg-slate-50 px-3 py-2 sm:px-4 sm:py-2.5">
          <Button
            className="h-8 w-full bg-emerald-600 px-4 text-[12px] hover:bg-emerald-700 sm:w-auto"
            onClick={() => pickedSlot && book(pickedSlot)}
            disabled={saving || !pickedSlot}
            data-testid="missed-class-picker-submit"
          >
            {saving ? "Booking..." : "Book Slot"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function MissedClassPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(null);

  // Hands back what it read, or null when it could not.
  const load = useCallback(async () => {
    setLoading(true);
    let sessions = null;
    try {
      const data = await unscheduledSessions();
      sessions = data.sessions || [];
      setRows(sessions);
    } catch {
      toast.error("Couldn't load missed classes");
    }
    setLoading(false);
    return sessions;
  }, []);

  useEffect(() => { load(); }, [load]);

  const patients = useMemo(() => byPatient(rows), [rows]);

  // One row and one button stand for all of a patient's waiting days, so the popup goes on
  // to their next one rather than closing after the first. Same course before the other.
  // Read afresh each time: booking a day moves where the next one may go, and can renumber
  // it. Left alone if the popup was closed while that was being read.
  const bookedOne = async (done) => {
    const fresh = await load();
    const left = (fresh || []).filter((r) => r.lead_id === done.lead_id && r.id !== done.id);
    const next = left.find((r) => r.track === done.track) || left[0] || null;
    setPicking((now) => (now && now.id === done.id ? next : now));
  };

  return (
    <div className="space-y-4" data-testid="branch-missed-class-panel">
      {/* `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness, Review and Patients strips — and, like
          them, from sm up only ("desk"): Branch Admin's phone cards carry no arrow. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Days to re-book" value={rows.length} arrow="desk" color="#d97706" testid="missed-class-tile-days" />
        <StatTile label="Patients waiting" value={patients.length} arrow="desk" color="#dc2626" testid="missed-class-tile-patients" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button onClick={load} disabled={loading} className="ml-auto h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh" data-testid="missed-class-refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-16 text-center" data-testid="missed-class-empty">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-200" />
          <p className="text-sm text-slate-400">
            {loading ? "Loading..." : "Every treatment day has a date. Nothing to re-book."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          {/* A floor width so a phone scrolls the table inside its box. Six fixed columns
              squeezed any tighter leave "Give a date" spilling out of its cell. */}
          <table className="w-full min-w-[52rem] table-fixed text-left text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-[6%] px-3 py-2.5">S.No</th>
                <th className="w-[23%] px-3 py-2.5">Patient</th>
                <th className="w-[21%] px-3 py-2.5">Day</th>
                <th className="w-[16%] px-3 py-2.5">Physio</th>
                <th className="w-[16%] whitespace-nowrap px-3 py-2.5">Absent Counts</th>
                <th className="w-[18%] px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {patients.map((p, i) => (
                <tr key={p.key} className="align-middle hover:bg-slate-50/60" data-testid={`missed-class-row-${p.key}`}>
                  <td className="px-3 py-3 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-3 py-3">
                    <p className="truncate text-sm font-semibold text-slate-800">{p.name}</p>
                    <p className="truncate text-[11px] text-slate-400">{p.contact}</p>
                  </td>
                  {/* Every day this patient is waiting on a date for. Which course it fell
                      out of, not only its number: "Day 3" alone would have the branch
                      placing a rehab day back into the treatment course. */}
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {p.days.map((s) => (
                        <span
                          key={s.id}
                          className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold ${
                            s.track === "rehab" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {dayName(s)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="truncate px-3 py-3 text-xs text-slate-600" title={p.physios.join(", ")}>{p.physios.join(", ") || "—"}</td>
                  <td className="px-3 py-3">
                    <span
                      className="whitespace-nowrap rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700"
                      data-testid={`missed-class-absent-total-${p.key}`}
                    >
                      {p.absentCount} Day{p.absentCount === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      size="sm"
                      className="bg-amber-600 text-xs text-white hover:bg-amber-700"
                      onClick={() => setPicking(p.days[0])}
                      data-testid={`missed-class-assign-${p.key}`}
                    >
                      <CalendarPlus className="mr-1 h-3 w-3" /> Give a date
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && (
        <SlotPicker
          key={picking.id}
          session={picking}
          days={patients.find((p) => p.days.some((d) => d.id === picking.id))?.days || [picking]}
          onPick={setPicking}
          onClose={() => setPicking(null)}
          onBooked={() => bookedOne(picking)}
        />
      )}
    </div>
  );
}
