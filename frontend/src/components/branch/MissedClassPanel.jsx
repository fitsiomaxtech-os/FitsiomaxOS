import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeatDots } from "@/components/ui/seat-dots";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import { unscheduledSessions, scheduleSession, getDoctorCalendar, listStoreItems } from "@/lib/api";
import { endTime12h, to12h } from "@/lib/time";

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
function SlotPicker({ session, onClose, onBooked }) {
  const [calendar, setCalendar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pickedDate, setPickedDate] = useState(null);
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
  // `next_day_at` is the other end, and is usually empty — a second absence before the
  // first was re-booked can strand two days, and then the earlier one has a day in front
  // of it as well as behind. Both come from the server, which applies the same two bounds
  // before it accepts the booking.
  const courseEnd = session.course_end || "";
  const nextDayAt = session.next_day_at || "";

  // Every slot this physio has published that falls in that window, grouped by the day it
  // falls on. Full slots stay in, unlike the chip list this replaced: the day panel has
  // the room to draw them for what they are, and a time shown as taken tells the branch
  // more than a time that silently isn't there.
  const slotsByDate = useMemo(() => {
    const map = {};
    for (const slot of calendar?.slots || []) {
      const [d, t] = String(slot).split("T");
      if (!d || !t || d < today) continue;
      // Slots are normalized `YYYY-MM-DDTHH:MM`, so they compare as strings in time order.
      if (courseEnd && slot <= courseEnd) continue;
      if (nextDayAt && slot >= nextDayAt) continue;
      (map[d] = map[d] || []).push(t);
    }
    Object.values(map).forEach((times) => times.sort());
    return map;
  }, [calendar, today, courseEnd, nextDayAt]);

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

  const step = (delta) => setCursor(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const book = async (slot) => {
    setSaving(true);
    try {
      await scheduleSession(session.id, slot);
      const [d, t] = slot.split("T");
      toast.success(`Day ${session.session_number} booked for ${shortDate(d)} at ${to12h(t)}`);
      onBooked();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't book that slot");
    }
    setSaving(false);
  };

  const dayTimes = pickedDate ? slotsByDate[pickedDate] || [] : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        data-testid="missed-class-slot-picker"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700">
            {(session.physio_name || "?").trim().charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-bold text-slate-800">
              {session.lead_name || "Unknown"}{" "}
              <span className="font-medium text-slate-400">with</span>{" "}
              {session.physio_name || "the physio"}
            </h3>
            <p className="truncate text-[11px] text-slate-400">
              {session.track === "rehab" ? "Rehab day" : "Day"} {session.session_number} of{" "}
              {session.total_sessions} · {sessionMinutes} min ·{" "}
              {openSlotCount} slot{openSlotCount === 1 ? "" : "s"} open
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
            data-testid="missed-class-picker-dismiss"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Why this day is here, on one line that scrolls sideways rather than wrapping —
            the absence the physio recorded is the only context for whether the patient is
            likely to make a new day at all. */}
        <div className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 sm:px-4 sm:py-2">
          <div className="flex items-stretch gap-2 overflow-x-auto whitespace-nowrap sm:gap-2.5">
            <span className="hidden shrink-0 self-center text-[10px] font-bold uppercase tracking-wider text-slate-500 sm:inline">
              Missed day
            </span>
            <span
              className="shrink-0 rounded-md border border-amber-800 bg-amber-700 px-2.5 py-1 text-[11px] font-bold text-white sm:px-3 sm:text-[12px]"
              data-testid="missed-class-picker-day"
            >
              Day {session.session_number} needs a date
            </span>
            {session.last_absence && (
              <span className="hidden shrink-0 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-700 sm:inline sm:px-3 sm:text-[12px]">
                Absent {shortDate(session.last_absence.date)}
                {session.last_absence.remarks && (
                  <span className="ml-2 font-medium text-rose-500">{session.last_absence.remarks}</span>
                )}
              </span>
            )}
            {/* Why the calendar starts where it does. Without this the grid simply has no
                dots on the next three weeks and reads as a physio with no free time, when
                what it actually means is that the patient is booked until here. */}
            {courseEnd && (
              <span
                className="shrink-0 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 sm:px-3 sm:text-[12px]"
                data-testid="missed-class-picker-course-end"
              >
                Slots end {shortDate(courseEnd.split("T")[0])}
                <span className="ml-2 font-medium text-emerald-600">{to12h(courseEnd.split("T")[1])}</span>
              </span>
            )}
            <span className="ml-auto hidden shrink-0 self-center pl-1 text-[11px] font-bold text-slate-600 sm:inline sm:text-[12px]">
              {capacity} patient{capacity === 1 ? "" : "s"} per slot
            </span>
          </div>
        </div>

        {loading ? (
          <p className="px-5 py-14 text-center text-sm text-slate-400">Loading this physio's calendar...</p>
        ) : failed ? (
          <p className="m-4 rounded-lg border border-dashed border-slate-200 px-3 py-12 text-center text-sm text-slate-400">
            Couldn't load {session.physio_name || "this physio"}'s calendar.
          </p>
        ) : openDates.length === 0 ? (
          <p className="m-4 rounded-lg border border-dashed border-amber-200 bg-amber-50 px-3 py-10 text-center text-sm text-amber-800" data-testid="missed-class-no-slots">
            {session.physio_name || "This physio"} has no free slots published
            {courseEnd
              ? ` after ${longDate(courseEnd.split("T")[0])}, when ${session.lead_name || "this patient"}'s booked days run out.`
              : " from today on."}
            <span className="mt-1 block text-xs font-normal text-amber-700">
              Open some days in MANAGEMENT → PHYSIO CALENDAR, then come back.
            </span>
          </p>
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
                  const isToday = d === today;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setPickedDate(isFocused ? null : d)}
                      disabled={dayOpen === 0}
                      className={`relative h-9 rounded-md text-[13px] font-semibold transition-all ${
                        isFocused
                          ? "bg-violet-600 text-white shadow-md ring-2 ring-violet-300 ring-offset-1"
                          : dayOpen > 0
                          ? `text-slate-600 hover:bg-slate-100 ${isToday ? "border border-amber-300" : ""}`
                          : `cursor-not-allowed text-slate-300 ${isToday ? "border border-slate-200" : ""}`
                      }`}
                      title={dayOpen > 0
                        ? `${dayOpen} slot${dayOpen > 1 ? "s" : ""} open`
                        : d < today ? "Already past" : "No slots free"}
                      data-testid={`missed-class-date-${d}`}
                    >
                      {day}
                      {dayOpen > 0 && !isFocused && (
                        <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-emerald-400" />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-slate-100 pt-2 text-[11px] font-semibold text-slate-500">
                <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Slots open</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-600" /> Picked</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border border-amber-300" /> Today</span>
              </div>
            </div>

            {/* Times published on the focused date. overflow and flex-1 only from lg, where
                the calendar and the times are side-by-side columns that scroll on their
                own; stacked on a phone, a scroller inside the body's own scroller traps the
                times in a short box the last of them cannot be reached in. */}
            <div className="w-full flex-shrink-0 p-3 sm:p-4 lg:flex-1 lg:overflow-y-auto">
              {!pickedDate ? (
                <div className="flex h-full items-center justify-center py-10">
                  <div className="text-center">
                    <Calendar className="mx-auto mb-2 h-10 w-10 text-slate-200" />
                    <p className="text-sm text-slate-400">Pick a date to see this physio's open times</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-base font-bold text-slate-800" data-testid="missed-class-picked-date">
                      {longDate(pickedDate)}
                    </h4>
                    <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-semibold text-slate-400">
                      <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Open</span>
                      <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> Taken</span>
                    </div>
                  </div>

                  {dayTimes.length === 0 ? (
                    <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm text-slate-400">
                      Nothing published on this day — open it in MANAGEMENT → PHYSIO CALENDAR first.
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-1.5 sm:gap-2" data-testid="missed-class-slot-grid">
                      {dayTimes.map((time) => {
                        const slot = `${pickedDate}T${time}`;
                        const seats = seatsTaken(slot);
                        const mine = ownSlot(slot);
                        const shut = !slotOpen(slot);
                        return (
                          <button
                            key={time}
                            type="button"
                            disabled={shut || saving}
                            onClick={() => book(slot)}
                            className={`overflow-hidden rounded-lg border-2 p-2 text-left transition-all sm:p-2.5 ${
                              shut
                                ? "cursor-not-allowed border-amber-300 bg-amber-50 opacity-70"
                                : "border-emerald-200 bg-emerald-50 hover:border-emerald-400 hover:shadow-sm disabled:opacity-50"
                            }`}
                            title={mine
                              ? `${session.lead_name || "This patient"} already has a day at ${to12h(time)} — pick another time`
                              : shut
                              ? `Full · ${seats} of ${capacity} taken`
                              : `${to12h(time)} – ${endTime12h(time, sessionMinutes)} · ${seats} of ${capacity} taken`}
                            data-testid={`missed-class-slot-${slot}`}
                          >
                            {/* Two lines, always: the time on its own so a long one like
                                "10:00 AM" cannot break after the hour and turn one box into
                                four lines while a short one beside it stays at two. */}
                            <p className={`truncate text-[13px] font-bold sm:text-sm ${shut ? "text-amber-800" : "text-emerald-800"}`}>
                              {to12h(time)}
                            </p>
                            {/* A slot says how full it is rather than who is in it — the
                                physio takes several at once, so the seat count is what
                                decides whether the day can go here. */}
                            <p className={`mt-0.5 flex items-center gap-1 truncate text-[10px] font-medium sm:text-xs ${shut ? "text-amber-600" : "text-emerald-600"}`}>
                              <SeatDots taken={seats} capacity={capacity} />
                              <span className="min-w-0 truncate">
                                {mine ? "already here" : shut ? "full" : `ends ${endTime12h(time, sessionMinutes)}`}
                              </span>
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
          <p className="min-w-0 truncate text-[11px] text-slate-400">
            {pickedDate ? "Picking a time books this day straight away." : "Pick a day with a green dot."}
          </p>
          <Button variant="outline" size="sm" onClick={onClose} className="shrink-0">Close</Button>
        </div>
      </div>
    </div>
  );
}

export default function MissedClassPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await unscheduledSessions();
      setRows(data.sessions || []);
    } catch {
      toast.error("Couldn't load missed classes");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const patients = useMemo(() => new Set(rows.map((r) => r.lead_id)).size, [rows]);

  return (
    <div className="space-y-4" data-testid="branch-missed-class-panel">
      {/* `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness, Review and Patients strips. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Days to re-book" value={rows.length} sub="left without a date" arrow color="#d97706" testid="missed-class-tile-days" />
        <StatTile label="Patients waiting" value={patients} sub="owed a day of treatment" arrow color="#dc2626" testid="missed-class-tile-patients" />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          A day here is a day the patient has paid for and not been given. Book it onto the physio's calendar,
          after the days they already hold.
        </p>
        <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh" data-testid="missed-class-refresh">
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
          <table className="w-full table-fixed text-left text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-[8%] px-3 py-2.5">S.No</th>
                <th className="w-[26%] px-3 py-2.5">Patient</th>
                <th className="w-[13%] px-3 py-2.5">Day</th>
                <th className="w-[18%] px-3 py-2.5">Physio</th>
                <th className="w-[20%] px-3 py-2.5">Missed on</th>
                <th className="w-[15%] px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s, i) => (
                <tr key={s.id} className="align-middle hover:bg-slate-50/60" data-testid={`missed-class-row-${s.id}`}>
                  <td className="px-3 py-3 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-3 py-3">
                    <p className="truncate text-sm font-semibold text-slate-800">{s.lead_name || "Unknown"}</p>
                    <p className="truncate text-[11px] text-slate-400">{s.patient_number || s.phone || "—"}</p>
                  </td>
                  {/* Which course the day fell out of, not only its number. Rehab and
                      treatment are separate runs of days for the same patient, and both
                      land in this queue — "Day 3" alone would have the branch placing a
                      rehab day back into the treatment course. */}
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                        s.track === "rehab" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      Day {s.session_number}
                    </span>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      of {s.total_sessions} · {s.track === "rehab" ? "Rehab" : "Treatment"}
                    </p>
                  </td>
                  <td className="truncate px-3 py-3 text-xs text-slate-600">{s.physio_name || "—"}</td>
                  <td className="px-3 py-3">
                    {/* The absence that caused this — the reason the physio typed is the
                        only context for whether the patient is likely to make a new day. */}
                    {s.last_absence ? (
                      <>
                        <p className="text-xs text-slate-600">{shortDate(s.last_absence.date)}</p>
                        <p className="truncate text-[10px] text-slate-400" title={s.last_absence.remarks || ""}>
                          {s.last_absence.remarks || `Day ${s.last_absence.session_number} absent`}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      size="sm"
                      className="bg-amber-600 text-xs text-white hover:bg-amber-700"
                      onClick={() => setPicking(s)}
                      data-testid={`missed-class-assign-${s.id}`}
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
          session={picking}
          onClose={() => setPicking(null)}
          onBooked={() => { setPicking(null); load(); }}
        />
      )}
    </div>
  );
}
