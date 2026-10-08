import { useCallback, useEffect, useState } from "react";
import {
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Loader2,
  Pencil,
  Stethoscope,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  addCalendarSlots,
  getBranchMonthCalendar,
  getDoctorCalendar,
  getCalendarExperts,
  listShifts,
  listStoreItems,
  removeCalendarSlots,
  setDoctorDayShift,
  updateShift,
  setDoctorSlotCapacity,
  getPhysioTypes,
  setDoctorService,
  setDoctorMeetLink,
} from "@/lib/api";
import { to12h } from "@/lib/time";
import { announceShiftsChanged, gridTimesFor, hoursLabel, onShiftsChanged, shiftIdsOf } from "@/lib/shifts";

const CONSULTATION_TYPES = [
  { value: "initial", label: "Initial Consultation", color: "bg-blue-100 text-blue-700 border-blue-300" },
  { value: "follow_up", label: "Follow-up", color: "bg-amber-100 text-amber-700 border-amber-300" },
  { value: "review", label: "Review", color: "bg-emerald-100 text-emerald-700 border-emerald-300" },
];

const SESSION_TYPES = [
  { value: "session", label: "Treatment Session", color: "bg-sky-100 text-sky-700 border-sky-300" },
];

// Slot length comes from FITSIO STORE — the Consultation Duration on the consultation
// item for the Head Physio calendar, and on the session item for the Physio calendar.
// Only used if the store hasn't been configured yet.
const FALLBACK_SLOT_MINUTES = 30;

/** "2026-08-18" -> "18 Aug", for naming a day in a toast without the year taking the line. */
const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year, month) {
  return new Date(year, month, 1).getDay();
}

// Three distinct scheduling workflows share this shell, and they are NOT interchangeable:
//
//   profileType "head_physio"      ->  HEAD PHYSIO CALENDAR — consultations only. Booked
//                                      from Branch Leads -> Appointment, one per lead, and
//                                      the day is cut at the store's Consultation Duration.
//   profileType "physio"           ->  PHYSIO CALENDAR      — treatment sessions only.
//                                      Booked against a patient's session package (many per
//                                      lead), cut at the session item's duration.
//   profileType "rehab"            ->  REHAB CALENDAR       — rehab programme days, booked
//                                      against a patient's rehab course. Same shape as the
//                                      physio's; the course is the thing being delivered.
//   profileType "nutrition_coach"  ->  DIET CALENDAR        — diet check-in days, booked
//                                      against a patient's diet plan. Same shape as the
//                                      physio's, against diet_sessions rather than sessions.
//
// What varies with it: which experts are listed, where slot length comes from, and the
// language throughout. Publishing availability is the one step all three genuinely share.
// `onlineArm` says the board this is mounted on runs an arm with no room in it — one of
// the two online admins. It gates the Google Meet field and nothing else: an appointment
// held over video needs an address to hold it at, and one held in a treatment room does
// not. Passed in rather than worked out here, because the answer is a fact about whose
// board this is and only BranchAdminBoard is holding that.
export const HeadPhysioCalendar = ({ branchId, profileType = "head_physio", onlineArm = false, onOpenTimeManagement }) => {
  const isPhysio = profileType === "physio";
  const isCoach = profileType === "nutrition_coach";
  const isRehab = profileType === "rehab";
  // The Consultant's calendar answers one question per day — is this consultant working
  // it — and nothing finer. The minute a patient is actually given is typed on Branch
  // Leads → Appointment, against the day this screen opened, because a consulting desk
  // does not run to a grid: the 7:00 a grid offers is rarely the 7:12 the consultant
  // agreed to, and a tile nobody could type into was the only way to say either.
  //
  // The other three calendars keep their slot grids. A treatment session, a rehab day and
  // a diet check-in are each one unit sold off a package, so there the slot IS the thing
  // being published and a patient takes a tile off it.
  const isConsultant = profileType === "head_physio";
  // Both the physio and the coach book repeat visits against a plan, so they share the
  // slot-type vocabulary and the per-slot capacity control; only the Head Physio's
  // one-per-lead consultation flow differs.
  const isRecurring = isPhysio || isCoach || isRehab;
  // Physiotherapist, not Physio: the tab above this panel says Physiotherapist Calendar,
  // and the shorthand only ever came from the slug.
  const roleLabel = isCoach ? "Nutritionist" : isRehab ? "Rehab Therapist" : isPhysio ? "Physiotherapist" : "CONSULTANT";
  const roleLabelPlural = isCoach ? "Nutritionists" : isRehab ? "Rehab Therapists" : isPhysio ? "Physiotherapists" : "CONSULTANTS";
  // Title case for the phone dropdown's placeholder, where the shouted CONSULTANT of the
  // desk header would be the one capitalised word in a sentence.
  const roleNoun = isConsultant ? "Consultant" : roleLabel;
  // An empty consultant list is a narrowing, not an absence: consultants are org-wide, so
  // the ones missing here are the ones who work the other arm. Saying "none created yet"
  // sends the reader to HR to create somebody who is already there.
  // One sentence for all four, because there is now one answer. This list is the Team
  // roster for the desk, so empty means nobody is on that desk here and the place to fix
  // it is the tab that staffs it. The three it replaces each guessed at a different cause
  // — a missing assignment, a person never created, a designation typed without "online" —
  // from a list that could not tell which, and sent the reader to HR for a posting made in
  // MANAGER → TEAM.
  const emptyLine = `No ${roleLabelPlural} on this branch's team yet — add them in MANAGEMENT → MANAGER → TEAM.`;
  const SLOT_TYPES = isRecurring ? SESSION_TYPES : CONSULTATION_TYPES;
  // The three calendars schedule different things and must not be read as interchangeable:
  // a Head Physio's day holds consultations (booked from Branch Leads → Appointment);
  // a Physio's day holds treatment sessions; a Coach's day holds diet check-ins.
  const purpose = isCoach ? "Diet Check-ins" : isRehab ? "Rehab Sessions" : isPhysio ? "Treatment Sessions" : "Consultations";

  const [doctors, setDoctors] = useState([]);
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  // The services Super Admin offers, from Services and Products. Loaded once rather than
  // per expert: it is one short list and it does not change while a day is being opened.
  const [services, setServices] = useState([]);
  const [savingService, setSavingService] = useState(false);
  const [calendarData, setCalendarData] = useState(null);

  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  // Several days can be opened in one go. `selectedDates` is every day picked; the last
  // one clicked is the "focused" day whose slot grid is shown on the right, so a single
  // day out of the batch can still be fine-tuned before saving.
  const [selectedDates, setSelectedDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);

  const [slotDuration, setSlotDuration] = useState(FALLBACK_SLOT_MINUTES);
  const slotType = SLOT_TYPES[0].value;
  const [pendingSlots, setPendingSlots] = useState([]);
  const [saving, setSaving] = useState(false);
  const [unsaving, setUnsaving] = useState(false);

  // Keep the calendar honest against FITSIO STORE: a Consultation Duration of 45 mins
  // there must produce 45-minute slots here, not a hardcoded 30.
  useEffect(() => {
    let cancelled = false;
    // A diet check-in is a repeat visit against a plan, so it takes its length from the
    // same store item a treatment session does until Diet gets its own.
    listStoreItems(undefined, isRecurring ? "session" : "consultation")
      .then((items) => {
        // The same pick the booking popup's server makes (consultation_slot_minutes): a
        // physiotherapy item before any other shelf, then the one Super Admin edited last,
        // so the length published here is the length Branch Leads → Appointment offers.
        const rank = (i) => [["", "physiotherapy"].includes(i.category || "") ? 1 : 0, i.updated_at || i.created_at || ""];
        const configured = (items || [])
          .filter((i) => Number(i.duration_minutes) > 0)
          .sort((a, b) => {
            const [pa, ta] = rank(a);
            const [pb, tb] = rank(b);
            return pb - pa || tb.localeCompare(ta);
          })
          .map((i) => i.duration_minutes)[0];
        if (!cancelled && configured) setSlotDuration(Number(configured));
      })
      .catch(() => { /* keep the fallback */ });
    return () => { cancelled = true; };
  }, [isRecurring]);

  // Who works this desk here is MANAGEMENT → MANAGER → TEAM's answer, not this screen's.
  //
  // The two used to be worked out separately and could disagree. Team reads the logins
  // posted to the branch; this list read the `doctors` records, which are a different
  // collection written by a different set of paths — so somebody on one and not the other
  // was invisible to whichever list they were missing from. An online branch showed three
  // Consultants on Team and an empty Consultant Calendar, and nothing on either screen
  // said why.
  //
  // calendar-experts answers the Team question and mints the expert record for anybody on
  // the roster who has none, so the calendar can only ever list the people the Team tab
  // lists. Adding somebody to a desk there is now the whole of putting them on this
  // calendar.
  const loadDoctors = useCallback(async () => {
    if (!branchId) return;
    try {
      const mine = await getCalendarExperts(branchId, profileType);
      // One row per person. The server returns one record each, so this is no longer
      // collapsing duplicates — it is the guard that keeps this list from ever showing a
      // person twice, which is what it was written for when several paths could each add
      // a record. The one kept is the one with slots on it, so it can never hide a
      // calendar somebody has actually published.
      const best = new Map();
      (mine || []).forEach((d) => {
        const key = d.user_id || d.employee_id || d.full_name || d.id;
        const seen = best.get(key);
        if (!seen || (d.slots || []).length > (seen.slots || []).length) best.set(key, d);
      });
      setDoctors([...best.values()].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")));
    } catch { /* silent */ }
  }, [branchId, profileType]);

  useEffect(() => { loadDoctors(); }, [loadDoctors]);

  // Only the treatment calendar asks: a consultation and a diet check-in are the service,
  // where a physio's day could be any of several the clinic sells.
  useEffect(() => {
    if (!isPhysio) return;
    getPhysioTypes().then(setServices).catch(() => setServices([]));
  }, [isPhysio]);

  const changeService = async (name) => {
    if (!selectedDoctor) return;
    setSavingService(true);
    try {
      await setDoctorService(selectedDoctor.id, name);
      // Patched on both copies: the card in the list and the header above the grid read
      // from different objects, and reloading the whole board to move one word would
      // close the day that is mid-publish.
      setSelectedDoctor((d) => (d ? { ...d, service_type: name } : d));
      setDoctors((all) => all.map((d) => (d.id === selectedDoctor.id ? { ...d, service_type: name } : d)));
      toast.success(name ? `Offered under ${name}` : "Service cleared");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not set the service");
    }
    setSavingService(false);
  };

  const loadCalendar = useCallback(async () => {
    if (!selectedDoctor) { setCalendarData(null); return; }
    try {
      const data = await getDoctorCalendar(selectedDoctor.id);
      setCalendarData(data);
    } catch { /* silent */ }
  }, [selectedDoctor]);

  useEffect(() => { loadCalendar(); }, [loadCalendar]);

  // The branch's shifts, so the working window can be set from the calendar itself rather
  // than only from TIME MANAGEMENT — the moment you notice a physio's day is opening at
  // the wrong hours is while you are publishing it. Same list, same effect, one screen
  // closer. Silent on failure: the picker just doesn't appear.
  const [shifts, setShifts] = useState([]);
  // Per-day shift only: "these three Saturdays run mornings and evenings" without moving
  // the expert off their usual shift, which is set in TIME MANAGEMENT.
  const [savingDayShift, setSavingDayShift] = useState(false);

  const loadShifts = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await listShifts(branchId);
      setShifts(data?.shifts || []);
    } catch { setShifts([]); }
  }, [branchId]);

  useEffect(() => { loadShifts(); }, [loadShifts]);

  // Kept in step with TIME MANAGEMENT: a shift renamed or re-timed there, or an expert moved
  // onto another one, shows here without a reload (and when the tab comes back into focus).
  useEffect(
    () => onShiftsChanged(branchId, `calendar-${profileType}`, () => { loadShifts(); loadCalendar(); loadDoctors(); }),
    [branchId, profileType, loadShifts, loadCalendar, loadDoctors],
  );

  const [savingCapacity, setSavingCapacity] = useState(false);

  // Lowering this never evicts anyone. Slots already over the new number stay booked and
  // simply stop accepting more — cancelling a patient's treatment day as a side effect of
  // a settings change is not something a dropdown should be able to do.
  const saveCapacity = async (n) => {
    if (!selectedDoctor) return;
    setSavingCapacity(true);
    try {
      await setDoctorSlotCapacity(selectedDoctor.id, n);
      toast.success(`${selectedDoctor.full_name} now takes ${n} patient${n > 1 ? "s" : ""} per slot`);
      await loadCalendar();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the slot capacity");
    }
    setSavingCapacity(false);
  };

  // The shift window and the day grid it cuts, above the handlers that reach for them.
  // These were written two hundred lines lower, which is where a const starts existing —
  // so saveDayShift was restaging a day against bindings that did not exist yet.
  //
  // The working window a day is opened across. It comes from the shift this expert is on
  // (MANAGEMENT → TIME MANAGEMENT): a Morning physio's day is cut 7:00 AM – 2:00 PM, an
  // Evening one's 3:00 PM – 7:00 PM. Nobody rostered falls back to the fixed 8:00 AM –
  // 10:00 PM this calendar used before shifts existed, so an unassigned expert behaves
  // exactly as they always did.
  //
  // It can be two windows rather than one — `segments` — because a split day is ordinary:
  // 8:00 AM – 1:00 PM and back 5:00 PM – 9:00 PM. Each half is filled on its own so the
  // afternoon between them is never published, and every generated slot finishes inside
  // the half it started in: a 45-minute slot is not offered at 12:30 on a morning that
  // ends at 1:00.
  const shift = calendarData?.shift || null;
  // Days this expert worked something other than their usual shift, keyed by date. A shift
  // is a pattern, not a contract — a Morning physio who comes in full-time on Tuesday is
  // normal, and the roster has to be able to say so without moving them off Morning.
  const dayShifts = calendarData?.day_shifts || {};

  /** The window one date is opened across: its own one-off, else the usual, else the default. */
  const windowFor = (date) => (date && dayShifts[date]) || shift || null;
  // Both halves spelled out — "Morning + Evening · 8:00 AM – 1:00 PM · 5:00 PM – 9:00 PM".
  // Naming only the outer ends would read as a day this expert does not work.
  const labelOf = (w) => (w?.shift_name ? `${w.shift_name} · ${hoursLabel(w)}` : "");

  const gridTimes = (w) => gridTimesFor(w, slotDuration || 30);

  // Every free slot of a day, staged as an addition. Anything already published for that
  // date, and anything booked, is skipped so this never duplicates or disturbs a booking.
  // `windowOverride` is for the moment a day's shift is changed: the new window is known
  // from the response before calendarData has been reloaded, so the day re-cuts straight
  // away instead of one render behind.
  const stagedSlotsForDay = (d, windowOverride) => {
    const alreadyOpen = new Set((calendarData?.slots || []).filter((s) => s.startsWith(`${d}T`)));
    return gridTimes(windowOverride || windowFor(d))
      .filter((time) => {
        const full = `${d}T${time}`;
        return !alreadyOpen.has(full) && !calendarData?.booked?.[full];
      })
      .map((time) => ({ slot_time: `${d}T${time}`, duration: slotDuration, consultation_type: slotType }));
  };

  // The exception to the usual shift: these particular days run on a different one. The
  // expert stays on their own shift — this is "Akshya is on Morning and came in full-time
  // on the 18th", not a change of roster, so nothing on the left panel moves.
  //
  // Applies to every day currently selected, because picking three Saturdays and calling
  // them evenings is one decision rather than three.
  const saveDayShift = async (shiftIds) => {
    const dates = selectedDates.length > 0 ? selectedDates : selectedDate ? [selectedDate] : [];
    if (!selectedDoctor || dates.length === 0) return;
    setSavingDayShift(true);
    try {
      const res = await setDoctorDayShift(selectedDoctor.id, dates, shiftIds);
      const nextDayShifts = res?.day_shifts || {};
      // Merged in rather than waiting on a reload, so the grid re-cuts on the same click.
      setCalendarData((prev) => (prev ? { ...prev, day_shifts: nextDayShifts } : prev));
      // Restage the affected days across their new window. Anything staged under the old
      // one is dropped: half a morning plus half an evening is not a day anyone meant.
      setPendingSlots((prev) => [
        ...prev.filter((s) => !dates.some((d) => s.slot_time.startsWith(`${d}T`))),
        ...dates.flatMap((d) => stagedSlotsForDay(d, nextDayShifts[d] || shift)),
      ]);
      const dayLabel = dates.length === 1 ? shortDate(dates[0]) : `${dates.length} days`;
      toast.success(
        nextDayShifts[dates[0]]
          ? `${dayLabel}: ${labelOf(nextDayShifts[dates[0]]) || "shift set"}`
          : `${dayLabel} back on ${shift?.shift_name || "the usual day"}`,
      );
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the day's shift");
    }
    setSavingDayShift(false);
  };

  // The video room this expert meets patients in, as typed. Held apart from the record so
  // the field can be edited without every keystroke claiming to be saved, and so Save has
  // something to compare against.
  //
  // Above selectDoctor, which sets it, for the reason the shift window above is: a const
  // starts existing where it is written, and a handler reaching back up the file is the
  // one arrangement that always works.
  const [meetDraft, setMeetDraft] = useState("");
  const [savingMeet, setSavingMeet] = useState(false);
  const meetSaved = (selectedDoctor?.meet_link || "").trim();
  const meetDirty = meetDraft.trim() !== meetSaved;

  const selectDoctor = (doc) => {
    setSelectedDoctor(doc);
    setSelectedDate(null);
    setSelectedDates([]);
    setPendingSlots([]);
    // Their own room, not the last one that was typed. The field below is one input reused
    // by everybody in the list, so without this it would open on the previous expert's
    // link — which then reads as this expert's, and saves as theirs on the next click.
    setMeetDraft(doc?.meet_link || "");
  };

  const saveMeetLink = async () => {
    if (!selectedDoctor) return;
    setSavingMeet(true);
    try {
      const res = await setDoctorMeetLink(selectedDoctor.id, meetDraft.trim());
      // What the server made of it, not what was typed: a link entered without a scheme
      // comes back with https on the front, and the field has to show the address that was
      // actually stored rather than leave the reader believing they saved the other one.
      const saved = res?.meet_link ?? meetDraft.trim();
      setMeetDraft(saved);
      // Both copies, the same way changeService patches them: the list card and the header
      // read different objects, and reloading the board would close a day mid-publish.
      // Every record of this person was written, so every row of theirs is patched.
      const samePerson = (d) =>
        d.id === selectedDoctor.id
        || (selectedDoctor.user_id && d.user_id === selectedDoctor.user_id)
        || (selectedDoctor.employee_id && d.employee_id === selectedDoctor.employee_id);
      setSelectedDoctor((d) => (d ? { ...d, meet_link: saved } : d));
      setDoctors((all) => all.map((d) => (samePerson(d) ? { ...d, meet_link: saved } : d)));
      toast.success(saved ? `${selectedDoctor.full_name} meets at this link` : "Meeting link cleared");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save the meeting link");
    }
    setSavingMeet(false);
  };

  // If the store's duration arrives (or is changed) after a day was already filled in,
  // those staged slots were built on the old length — drop them rather than saving a
  // day that's half 30-minute and half 45-minute.
  useEffect(() => {
    setSelectedDate(null);
    setSelectedDates([]);
    setPendingSlots([]);
  }, [slotDuration]);


  // The branch's leave days for the month on screen (CALENDAR → MONTHLY CALENDAR). A leave
  // day cannot be opened here — the server refuses it too — so it is drawn as closed.
  const [leaveDays, setLeaveDays] = useState({});
  useEffect(() => {
    if (!branchId) return undefined;
    let cancelled = false;
    const month = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}`;
    getBranchMonthCalendar(branchId, month)
      .then((res) => {
        if (cancelled) return;
        const map = {};
        (res?.days || []).forEach((day) => { if (day.status === "leave") map[day.date] = day; });
        setLeaveDays(map);
      })
      .catch(() => { if (!cancelled) setLeaveDays({}); });
    return () => { cancelled = true; };
  }, [branchId, currentYear, currentMonth]);

  // Picking a date IS the availability confirmation — the whole working day fills in
  // straight away rather than making the Branch Admin click every slot by hand. Clicking
  // it again deselects that day and drops its staged slots. Everything lands staged, not
  // saved, so the Save / Unsave pair still governs what actually reaches the calendar.
  const toggleDate = (d) => {
    const already = selectedDates.includes(d);
    if (!already && leaveDays[d]) {
      toast.error(`The branch is on leave on ${shortDate(d)}${leaveDays[d].note ? ` (${leaveDays[d].note})` : ""} — mark it Working in CALENDAR → MONTHLY CALENDAR first`);
      return;
    }
    if (already) {
      setSelectedDates((prev) => prev.filter((x) => x !== d));
      setPendingSlots((prev) => prev.filter((s) => !s.slot_time.startsWith(`${d}T`)));
      setSelectedDate((curr) => (curr === d ? selectedDates.filter((x) => x !== d).slice(-1)[0] || null : curr));
      return;
    }
    setSelectedDates((prev) => [...prev, d]);
    setSelectedDate(d);
    setPendingSlots((prev) => [...prev.filter((s) => !s.slot_time.startsWith(`${d}T`)), ...stagedSlotsForDay(d)]);
  };

  const prevMonth = () => {
    if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(currentYear - 1); }
    else setCurrentMonth(currentMonth - 1);
  };
  const nextMonth = () => {
    if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(currentYear + 1); }
    else setCurrentMonth(currentMonth + 1);
  };

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);

  const dateStr = (day) => `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const getSimpleSlotsForDate = (date) => {
    if (!calendarData) return [];
    return (calendarData.slots || []).filter((s) => s.startsWith(date));
  };

  const isBooked = (slotTime) => {
    return calendarData?.booked?.[slotTime];
  };

  const shiftLabel = labelOf(shift);
  // What the focused day actually runs, and whether that differs from the usual.
  const dayWindow = windowFor(selectedDate);
  const dayShiftLabel = labelOf(dayWindow);
  const isOverridden = !!(selectedDate && dayShifts[selectedDate]);
  const dayShiftIds = isOverridden ? shiftIdsOf(dayShifts[selectedDate]) : [];

  // One chip ticked on or off, saved at once. Starting from the usual day, the first tick
  // is the whole one-off ("Morning only"); unticking the last one goes back to the usual.
  const toggleDayShift = (id) => {
    const next = dayShiftIds.includes(id) ? dayShiftIds.filter((x) => x !== id) : [...dayShiftIds, id];
    const startOf = (sid) => shifts.find((s) => s.id === sid)?.start_time || "99:99";
    saveDayShift([...next].sort((a, b) => startOf(a).localeCompare(startOf(b))));
  };

  // A shift's own name and hours, edited in its row. This is the branch's shift — the
  // same row TIME MANAGEMENT edits — so everyone on it moves, not just this expert.
  const [shiftDraft, setShiftDraft] = useState(null);
  const [savingShiftEdit, setSavingShiftEdit] = useState(false);
  const shiftDraftInvalid = !!shiftDraft && (!shiftDraft.name.trim() || !shiftDraft.start_time || !shiftDraft.end_time || shiftDraft.end_time <= shiftDraft.start_time);

  const saveShiftEdit = async () => {
    if (!shiftDraft || shiftDraftInvalid) return;
    setSavingShiftEdit(true);
    try {
      const saved = await updateShift(shiftDraft.id, {
        name: shiftDraft.name.trim(),
        start_time: shiftDraft.start_time,
        end_time: shiftDraft.end_time,
      });
      toast.success(`${saved?.name || shiftDraft.name} · ${to12h(saved?.start_time || shiftDraft.start_time)} – ${to12h(saved?.end_time || shiftDraft.end_time)}`);
      setShiftDraft(null);
      await loadShifts();
      announceShiftsChanged(branchId, `calendar-${profileType}`);
      // Fetched here rather than through loadCalendar so the picked days can be re-cut
      // across the new hours on the same click, not one render behind.
      if (selectedDoctor) {
        const data = await getDoctorCalendar(selectedDoctor.id);
        setCalendarData(data);
        setPendingSlots((prev) => [
          ...prev.filter((s) => !selectedDates.some((d) => s.slot_time.startsWith(`${d}T`))),
          ...selectedDates.flatMap((d) => stagedSlotsForDay(d, data?.day_shifts?.[d] || data?.shift)),
        ]);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save the shift");
    }
    setSavingShiftEdit(false);
  };


  const generateTimeGrid = (date) => gridTimes(windowFor(date));

  // What the day actually renders: the shift's grid, plus any time already published or
  // booked outside it. A shift narrowed after slots were published would otherwise hide
  // them — still on the calendar, still bookable, but with no way left to see or remove
  // them. Shown means Unsave can reach them.
  const displayTimeGrid = () => {
    const grid = generateTimeGrid(selectedDate);
    if (!selectedDate) return grid;
    const outside = new Set();
    const collect = (slotTime) => {
      if (slotTime.startsWith(`${selectedDate}T`)) outside.add(slotTime.slice(11, 16));
    };
    (calendarData?.slots || []).forEach(collect);
    Object.keys(calendarData?.booked || {}).forEach(collect);
    return [...new Set([...grid, ...outside])].sort();
  };

  const dayTimes = displayTimeGrid();

  // ── The day-level view, which is the whole of the Consultant's calendar ──
  //
  // A day is open for consultations when anything at all stands published on it. What
  // is published underneath is still a grid — the booking popup reads it to know the
  // hours this consultant works, and the other three calendars share the code that
  // writes it — but on this screen it is never shown or picked at. Open or closed is
  // the only state a consultant's day has here.
  const publishedDays = new Set((calendarData?.slots || []).map((x) => (x || "").split("T")[0]));
  const dayIsStaged = (d) => pendingSlots.some((x) => x.slot_time.startsWith(`${d}T`) && !x._remove);
  /** Open or closed as the day will stand once Save Changes has run. Closing is not
   *  staged — Mark not available goes straight to the server — so only opening is
   *  pending here. */
  const dayIsOpen = (d) => !!d && (publishedDays.has(d) || dayIsStaged(d));
  /** The appointments already sitting on a day — what closing it would be closing over. */
  const bookingsOnDay = (d) => Object.entries(calendarData?.booked || {})
    .filter(([slot]) => slot.startsWith(`${d}T`))
    .sort(([a], [b]) => a.localeCompare(b));

  const focusedDates = selectedDates.length > 0 ? selectedDates : selectedDate ? [selectedDate] : [];
  const focusedOpenCount = focusedDates.filter(dayIsOpen).length;
  const focusedBookings = focusedDates.flatMap(bookingsOnDay);
  // Nothing left to add, so Mark available has nothing to do. Distinct from "it failed":
  // every day on screen is already open.
  const nothingToOpen = pendingSlots.filter((x) => !x._remove).length === 0;
  const nothingToClose = focusedDates.every((d) => !publishedDays.has(d));

  const isSlotExisting = (time) => {
    if (!selectedDate || !calendarData) return false;
    const full = `${selectedDate}T${time}`;
    return (calendarData.slots || []).includes(full);
  };

  const isSlotPending = (time) => {
    const full = `${selectedDate}T${time}`;
    return pendingSlots.some((s) => s.slot_time === full);
  };

  const toggleSlot = (time) => {
    const full = `${selectedDate}T${time}`;
    if (isBooked(full)) { toast.error("This slot has a booked appointment"); return; }

    if (isSlotExisting(time) && !isSlotPending(time)) {
      setPendingSlots((prev) => [...prev, { slot_time: full, duration: slotDuration, consultation_type: slotType, _remove: true }]);
    } else if (isSlotPending(time)) {
      setPendingSlots((prev) => prev.filter((s) => s.slot_time !== full));
    } else {
      setPendingSlots((prev) => [...prev, { slot_time: full, duration: slotDuration, consultation_type: slotType }]);
    }
  };

  const getSlotState = (time) => {
    const full = `${selectedDate}T${time}`;
    const pending = pendingSlots.find((s) => s.slot_time === full);
    if (pending && pending._remove) return "removing";
    if (pending) return "adding";
    if (isSlotExisting(time)) return "existing";
    return "empty";
  };

  const getSlotDetail = (time) => {
    const full = `${selectedDate}T${time}`;
    const pending = pendingSlots.find((s) => s.slot_time === full);
    if (pending && !pending._remove) return pending;
    if (calendarData?.slot_details) {
      return calendarData.slot_details.find((s) => s.slot_time === full);
    }
    return null;
  };

  // Closes the selected days back down: every published slot on them is removed. Booked
  // slots are deliberately left alone — the backend refuses to drop them anyway, and a
  // patient's appointment shouldn't disappear because the day was closed.
  const unsaveDays = async () => {
    if (!selectedDoctor || selectedDates.length === 0) return;
    const published = (calendarData?.slots || []).filter((s) => selectedDates.some((d) => s.startsWith(`${d}T`)));
    const bookedCount = published.filter((s) => calendarData?.booked?.[s]).length;
    const removable = published.filter((s) => !calendarData?.booked?.[s]);

    if (removable.length === 0) {
      toast.info(
        bookedCount > 0
          ? (isConsultant ? "Only booked appointments remain — those can't be closed over" : "Only booked slots remain — those can't be removed")
          : (isConsultant ? "These days were not marked available" : "Nothing published on these days yet"),
      );
      return;
    }
    const dayLabel = selectedDates.length === 1 ? "this day" : `these ${selectedDates.length} days`;
    // Said in whatever the screen deals in. The consultant's calendar never showed the
    // slots being counted here, so counting them at it would name a thing the reader has
    // not been shown.
    if (!window.confirm(
      isConsultant
        ? `Mark ${selectedDoctor.full_name} not available on ${dayLabel}?`
        : `Remove ${removable.length} open slot${removable.length > 1 ? "s" : ""} from ${dayLabel}?`,
    )) return;

    setUnsaving(true);
    try {
      await removeCalendarSlots(selectedDoctor.id, { slot_times: removable });
      toast.success(
        isConsultant
          ? `Not available on ${selectedDates.length === 1 ? shortDate(selectedDates[0]) : `${selectedDates.length} days`}`
            + (bookedCount > 0 ? ` · ${bookedCount} booked appointment${bookedCount > 1 ? "s" : ""} kept` : "")
          : `Removed ${removable.length} slot${removable.length > 1 ? "s" : ""}`
            + (bookedCount > 0 ? ` · ${bookedCount} booked slot${bookedCount > 1 ? "s" : ""} kept` : ""),
      );
      setPendingSlots([]);
      setSelectedDates([]);
      setSelectedDate(null);
      await loadCalendar();
      await loadDoctors();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to remove slots");
    }
    setUnsaving(false);
  };

  const saveChanges = async () => {
    if (!selectedDoctor || pendingSlots.length === 0) return;
    setSaving(true);
    try {
      const toAdd = pendingSlots.filter((s) => !s._remove);
      const toRemove = pendingSlots.filter((s) => s._remove);

      if (toRemove.length > 0) {
        await removeCalendarSlots(selectedDoctor.id, { slot_times: toRemove.map((s) => s.slot_time) });
      }
      if (toAdd.length > 0) {
        await addCalendarSlots(selectedDoctor.id, { slots: toAdd.map((s) => ({ slot_time: s.slot_time, duration: s.duration, consultation_type: s.consultation_type })) }, branchId);
      }
      // The consultant's calendar counts days, because days are what it publishes.
      const openedDays = new Set(toAdd.map((x) => x.slot_time.split("T")[0])).size;
      toast.success(
        isConsultant
          ? `Available on ${openedDays} day${openedDays === 1 ? "" : "s"}`
          : `Saved ${toAdd.length} added, ${toRemove.length} removed`,
      );
      setPendingSlots([]);
      await loadCalendar();
      await loadDoctors();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
    }
    setSaving(false);
  };

  const countSlotsForDay = (day) => {
    const d = dateStr(day);
    return getSimpleSlotsForDate(d).length;
  };

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-3 sm:gap-4 lg:h-[calc(100vh-220px)] lg:flex-row" data-testid="head-physio-calendar-root">
      {/* LEFT PANEL — Doctor List */}
      <div className="flex w-full flex-shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white lg:h-full lg:w-72" data-testid="doctor-list-panel">
        {/* Phone: the list folds into one dropdown, and the card itself is the dropdown —
            no header over it, since the placeholder already names who is being picked. A
            row of 224px cards scrolled sideways showed one and a half names at a time; the
            phone's own picker shows every one. From sm up the header and cards return. */}
        <div className="relative sm:hidden">
          <Stethoscope className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-500" aria-hidden="true" />
          <select
            value={selectedDoctor ? String(selectedDoctor.id) : ""}
            onChange={(e) => selectDoctor(doctors.find((d) => String(d.id) === e.target.value) || null)}
            disabled={doctors.length === 0}
            aria-label={roleLabelPlural}
            className="h-11 w-full appearance-none bg-white pl-9 pr-9 text-sm font-semibold text-slate-800 outline-none disabled:text-slate-400"
            data-testid="doctor-select"
          >
            <option value="" disabled>
              {doctors.length === 0 ? `No ${roleNoun.toLowerCase()}s on the team` : `Select ${roleNoun}`}
            </option>
            {doctors.map((doc) => (
              <option key={doc.id} value={String(doc.id)}>
                {doc.full_name}{doc.is_super_admin ? " · Super Admin" : ""}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        </div>

        <div className="hidden border-b border-slate-100 bg-slate-50/60 p-4 sm:block">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
              <Stethoscope className="h-4 w-4 text-violet-500" /> {roleLabelPlural}
            </h3>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">{doctors.length}</span>
          </div>
        </div>

        <div className="hidden gap-1.5 overflow-x-auto p-2 sm:flex lg:flex-1 lg:flex-col lg:overflow-y-auto lg:overflow-x-visible" data-testid="doctor-list">
          {doctors.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-6">
              {emptyLine}
            </p>
          )}
          {doctors.map((doc) => {
            const isActive = selectedDoctor?.id === doc.id;
            const slotCount = (doc.slots || []).length;
            // Days, not slots, for a consultant: their calendar says which days they work
            // and the hour is agreed at booking. "1895 slots" was the grid underneath
            // being counted out loud — a number nobody could act on and nobody could
            // recognise as "this consultant works most of September".
            const dayCount = new Set((doc.slots || []).map((x) => String(x).split("T")[0])).size;
            return (
              <button
                key={doc.id}
                type="button"
                onClick={() => selectDoctor(doc)}
                className={`flex w-56 shrink-0 items-center gap-2.5 rounded-lg border p-2.5 text-left transition-all sm:w-64 lg:w-full lg:shrink lg:gap-3 lg:p-3 ${
                  isActive
                    ? "border-violet-400 bg-violet-50 shadow-sm"
                    : "border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50"
                }`}
                data-testid={`doctor-card-${doc.id}`}
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${isActive ? "bg-violet-200 text-violet-800" : "bg-slate-100 text-slate-600"}`}>
                  {doc.full_name?.charAt(0)?.toUpperCase() || "D"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-800">
                    <span className="truncate">{doc.full_name}</span>
                    {/* The Super Admin sits on every branch's list; the tag is the same one
                        their rows wear on the Consultations board. */}
                    {doc.is_super_admin && (
                      <span className="shrink-0 rounded-[4px] bg-slate-100 px-1 py-px text-[9px] font-bold uppercase text-slate-600">Super Admin</span>
                    )}
                  </p>
                  {/* Their shift, not their qualification, once they are on one: which
                      hours this person works is what decides the day about to be opened
                      for them, and it is the thing to check before clicking a date. */}
                  <p className="truncate text-[10px] text-slate-400">
                    {doc.shift_name
                      ? `${doc.shift_name} · ${hoursLabel(doc.shift_windows?.length ? { segments: doc.shift_windows } : { start_time: doc.shift_start, end_time: doc.shift_end })}`
                      : doc.service_type || doc.specialization || roleLabel}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] font-semibold ${slotCount > 0 ? "bg-emerald-50 text-emerald-600" : "bg-slate-50 text-slate-400"}`}>
                    {isConsultant ? `${dayCount} day${dayCount === 1 ? "" : "s"}` : `${slotCount} slots`}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* The expert's own video room, under the list that picked them and before the day
            being opened on the right — the address a booking made out of that day will
            carry, so it belongs to the person rather than to any one date.

            One field for the list rather than one per row: it is per expert, but only the
            selected expert's is ever being answered, and a column of eleven URL inputs is a
            column nobody can read a name out of. Nothing at all until somebody is picked,
            for the same reason the calendar beside it is empty until then.

            Only on an online arm's board. A branch's own desks see their patients in a
            room that already has an address, so the field would ask a question with no
            answer and offer to put a video link on an appointment nobody is holding over
            video.

            Rehab is the one desk on an online board that still does not carry it. A rehab
            programme day is worked on the floor with equipment in the room — it is what
            ROOM_ONLY_TABS in BranchAdminBoard.jsx says of Zumba and the gym, and the same
            is true here — so an arm with no floor is not running one over video. */}
        {!isRehab && onlineArm && selectedDoctor && (
          <div className="border-t border-slate-100 bg-slate-50/60 p-3" data-testid="doctor-meet-link-panel">
            <label
              htmlFor="doctor-meet-link"
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"
            >
              <Video className="h-3.5 w-3.5 text-violet-500" /> Google Meet link
            </label>
            <p className="mt-0.5 hidden text-[10px] text-slate-400 sm:block">
              {selectedDoctor.full_name}&apos;s own room. Sent to the patient when a slot here is booked.
            </p>
            <div className="mt-2 flex items-center gap-1.5">
              <input
                id="doctor-meet-link"
                // text, not url: a room is as often pasted in as "meet.google.com/abc-defg-hij"
                // as with the scheme on the front, and type="url" marks that invalid while
                // the server accepts it and puts the https on. inputMode still asks a phone
                // keyboard for the URL layout.
                type="text"
                inputMode="url"
                value={meetDraft}
                onChange={(e) => setMeetDraft(e.target.value)}
                // Enter saves, because this is one field with one button and reaching for
                // the mouse to commit a line you have just finished typing is a step that
                // exists only because nobody wired the key.
                onKeyDown={(e) => { if (e.key === "Enter" && meetDirty && !savingMeet) saveMeetLink(); }}
                placeholder="meet.google.com/abc-defg-hij"
                disabled={savingMeet}
                className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-[11px] text-slate-700 outline-none focus:border-violet-400 disabled:opacity-60"
                data-testid="doctor-meet-link-input"
              />
              <Button
                size="sm"
                onClick={saveMeetLink}
                disabled={savingMeet || !meetDirty}
                className="h-8 shrink-0 bg-violet-600 px-2.5 text-[11px] hover:bg-violet-700"
                data-testid="doctor-meet-link-save"
              >
                {savingMeet ? "..." : "Save"}
              </Button>
            </div>
            {/* The saved room, openable, so whoever typed it can check it goes where they
                meant before a patient is sent it. Only once it is saved and the field is
                back in agreement with it — offering to open a half-typed line would open
                the wrong room. */}
            {meetSaved && !meetDirty && (
              <a
                href={meetSaved}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block truncate text-[10px] font-medium text-violet-600 hover:underline"
                data-testid="doctor-meet-link-open"
              >
                Open {meetSaved.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        )}
      </div>

      {/* Phone, nobody picked yet: a chevron bounces up at the dropdown, the prompt Branch
          Management uses under its own branch picker, and one line with no guide text
          under it. motion-safe, so with reduced motion the arrow holds still. */}
      {!selectedDoctor && doctors.length > 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center sm:hidden" data-testid="doctor-select-prompt">
          <ChevronUp className="mx-auto h-5 w-5 text-sky-500 motion-safe:animate-bounce" aria-hidden="true" />
          <p className="mt-1 text-sm font-semibold text-slate-600">Pick a {roleNoun.toLowerCase()} above to open their calendar</p>
        </div>
      )}

      {/* RIGHT PANEL — Calendar */}
      {/* Not drawn at all on a phone until somebody is picked: there it was a card holding
          only "Select a CONSULTANT to open…", which the dropdown above already says. */}
      <div className={`${selectedDoctor ? "flex" : "hidden sm:flex"} flex-1 flex-col overflow-visible rounded-xl border border-slate-200 bg-white lg:overflow-hidden`} data-testid="calendar-panel">
        {!selectedDoctor ? (
          <div className="flex-1 flex items-center justify-center" data-testid="calendar-empty-state">
            <div className="text-center">
              <CalendarIcon className="h-12 w-12 text-slate-200 mx-auto mb-3" />
              <p className="text-sm text-slate-400">Select a {roleLabel} to open their {purpose.toLowerCase()} calendar</p>
            </div>
          </div>
        ) : (
          <>
            {/* Doctor Header. On a phone it keeps only the shift chip and the controls: the
                name and initial are already on the dropdown right above it, and the count
                line under them went as text nobody there was reading. */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2.5 sm:flex-nowrap sm:gap-0 sm:p-4">
              <div className="flex items-center gap-3">
                <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-sm font-bold text-violet-700 sm:flex">
                  {selectedDoctor.full_name?.charAt(0)?.toUpperCase()}
                </div>
                <div>
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                    <span className="hidden sm:inline">{selectedDoctor.full_name}</span>
                    {/* The shift is stated on the header rather than left to be inferred
                        from where the grid below starts — the day is being published
                        against it, so it has to be visible while publishing. */}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${shiftLabel ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-400"}`}
                      title={shiftLabel ? "Set in MANAGEMENT → TIME MANAGEMENT" : "No shift set — the full working day is offered"}
                      data-testid="calendar-shift-chip"
                    >
                      {shiftLabel || "No shift · full day"}
                    </span>
                    {/* Which of the clinic's services this expert's day is being opened
                        under. Beside the shift because the two are the same kind of fact —
                        what is being published, and when — and both have to be right
                        before a date is clicked. A select rather than a chip: the answer
                        is set here, on the screen that asks the question. */}
                    {isPhysio && (
                      <select
                        value={selectedDoctor.service_type || ""}
                        onChange={(e) => changeService(e.target.value)}
                        disabled={savingService}
                        className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 outline-none disabled:opacity-60"
                        title="The service this expert is offered under — from Services and Products"
                        data-testid="calendar-service-select"
                      >
                        <option value="">No service</option>
                        {services.map((sv) => (
                          <option key={sv.id} value={sv.name}>{sv.name}</option>
                        ))}
                      </select>
                    )}
                  </h3>
                  <p className="hidden text-[11px] text-slate-400 sm:block">
                    {isConsultant
                      ? `${purpose} · ${publishedDays.size} day${publishedDays.size === 1 ? "" : "s"} available`
                      : `${purpose} · ${slotDuration} min · ${(calendarData?.slots || []).length} slots open`}
                    {isPhysio && ` · ${calendarData?.slot_capacity ?? 3} per slot`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* A physio runs a floor — two or three patients in the same hour. Set
                    here rather than assumed, because it varies by physio and by room.
                    Head Physio has no control: a consultation is one-to-one and the
                    backend pins them to 1 whatever is sent. */}
                {isPhysio && (
                  <label className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1" title="Patients this physio treats in the same slot">
                    <Users className="h-3.5 w-3.5 text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-500">Per slot</span>
                    <select
                      value={calendarData?.slot_capacity ?? 3}
                      onChange={(e) => saveCapacity(Number(e.target.value))}
                      disabled={savingCapacity}
                      className="rounded border border-slate-200 bg-white px-1 py-0.5 text-xs font-semibold text-slate-700"
                      data-testid="physio-slot-capacity"
                    >
                      {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                )}
                {selectedDates.length > 0 && (
                  <span className="text-xs font-medium text-slate-500" data-testid="selected-days-count">
                    {selectedDates.length} day{selectedDates.length > 1 ? "s" : ""} selected
                  </span>
                )}
                {/* Counted and committed in slots, so only on the calendars that have
                    them. A consultant's day is marked available or not on the panel to
                    the right, which is one decision with one pair of buttons — a second
                    Save up here, counting the grid underneath in slots nobody picked,
                    would be the old screen showing through the new one. */}
                {!isConsultant && pendingSlots.length > 0 && (
                  <span className="text-xs text-amber-600 font-medium">{pendingSlots.length} unsaved</span>
                )}
                {!isConsultant && pendingSlots.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setPendingSlots([])} className="text-xs" data-testid="discard-changes-btn">Discard</Button>
                )}
                {!isConsultant && selectedDates.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={unsaveDays}
                    disabled={unsaving}
                    className="border-rose-200 text-rose-600 hover:bg-rose-50 text-xs"
                    data-testid="unsave-slots-btn"
                  >
                    {unsaving ? "Removing..." : "Unsave"}
                  </Button>
                )}
                {!isConsultant && pendingSlots.length > 0 && (
                  <Button size="sm" onClick={saveChanges} disabled={saving} className="bg-violet-600 hover:bg-violet-700 text-white text-xs" data-testid="save-slots-btn">
                    {saving ? "Saving..." : "Save Changes"}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              {/* Month Calendar — scrolls on its own, otherwise the controls below it
                  (duration, type, Mark Whole Day Available, Repeat) get clipped by the
                  row's lg:overflow-hidden with no way to reach them. */}
              <div className={`flex w-full flex-shrink-0 flex-col ${selectedDate ? "border-b" : "sm:border-b"} border-slate-100 p-3 sm:p-5 lg:w-[26rem] lg:border-b-0 lg:border-r lg:overflow-y-auto`}>
                <div className="flex items-center justify-between mb-4">
                  <button type="button" onClick={prevMonth} className="p-1 rounded hover:bg-slate-100" data-testid="cal-prev-month">
                    <ChevronLeft className="h-4 w-4 text-slate-500" />
                  </button>
                  <h4 className="text-sm font-semibold text-slate-700" data-testid="cal-month-title">{monthNames[currentMonth]} {currentYear}</h4>
                  <button type="button" onClick={nextMonth} className="p-1 rounded hover:bg-slate-100" data-testid="cal-next-month">
                    <ChevronRight className="h-4 w-4 text-slate-500" />
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-1 mb-1">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                    <div key={d} className="text-center text-[11px] font-semibold text-slate-400 py-1.5">{d}</div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: firstDay }, (_, i) => (
                    <div key={`empty-${i}`} className="h-11" />
                  ))}
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const day = i + 1;
                    const d = dateStr(day);
                    const isPicked = selectedDates.includes(d);
                    const isFocused = selectedDate === d;
                    const isToday = d === todayStr;
                    const slotCount = countSlotsForDay(day);
                    const leave = leaveDays[d];
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDate(d)}
                        // A day that already has slots published is filled dark green
                        // rather than flagged with a dot — at a glance the month should
                        // show which days are open, and a 4px dot doesn't carry that far.
                        // Violet still wins for days picked in this editing session, since
                        // that is what Save Changes is about to act on.
                        className={`h-11 rounded-lg text-sm font-medium relative transition-all ${
                          leave && !isPicked
                            ? `bg-rose-50 text-rose-400 line-through decoration-rose-300 border border-rose-200${isToday ? " ring-2 ring-rose-200 ring-offset-1" : ""}`
                            : isPicked
                            ? `bg-violet-600 text-white shadow-sm${isFocused ? " ring-2 ring-violet-300 ring-offset-1" : ""}`
                            : slotCount > 0
                            ? `bg-green-800 text-white shadow-sm hover:bg-green-900${isToday ? " ring-2 ring-green-300 ring-offset-1" : ""}`
                            : isToday
                            ? "bg-violet-50 text-violet-700 border border-violet-200"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                        title={
                          leave ? `Branch leave day${leave.note ? ` — ${leave.note}` : ""}${slotCount > 0 ? ` · ${slotCount} booked slot${slotCount === 1 ? "" : "s"} kept` : ""}`
                            : dayShifts[d] ? `Works ${labelOf(dayShifts[d])} on this day`
                            : isPicked ? "Click again to deselect"
                            : slotCount > 0 ? (isConsultant ? "Available" : `${slotCount} slot${slotCount === 1 ? "" : "s"} open`)
                            : undefined
                        }
                        data-testid={`cal-day-${day}`}
                      >
                        {day}
                        {/* A day running something other than the usual shift. Amber, and
                            a corner dot rather than a fill, because the fill already means
                            "published" / "picked" and both remain true of this day. */}
                        {dayShifts[d] && (
                          <span
                            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-white"
                            data-testid={`cal-day-override-${day}`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Desk only, like the day hint below: on a phone both were guide text
                    under a calendar that already shows a leave day struck through. */}
                {Object.keys(leaveDays).length > 0 && (
                  <p className="mt-2 hidden items-center gap-1.5 text-[10px] text-slate-400 sm:flex" data-testid="calendar-leave-legend">
                    <span className="inline-block h-2.5 w-2.5 rounded border border-rose-200 bg-rose-50" />
                    Branch leave day — set in CALENDAR → MONTHLY CALENDAR
                  </p>
                )}

                {selectedDate && (
                  <p className="mt-4 hidden border-t border-slate-100 pt-3 text-[11px] text-slate-400 sm:block" data-testid="calendar-day-hint">
                    {isConsultant ? (
                      dayShiftLabel
                        ? <>Marked available across <b>{dayShiftLabel}</b>{isOverridden ? " — set for this day only" : ""}. The exact time is agreed with the patient and typed on BRANCH LEADS → APPOINTMENT. </>
                        : <>Marked available for the whole day. Put them on a shift in <b>TIME MANAGEMENT</b> to say which hours they actually work. </>
                    ) : (
                      dayShiftLabel
                        ? <>Opened across <b>{dayShiftLabel}</b>{isOverridden ? " — set for this day only" : ""} at {slotDuration}-minute slots, per FITSIO STORE. </>
                        : <>Whole day opened at {slotDuration}-minute slots, per FITSIO STORE. Put them on a shift in <b>TIME MANAGEMENT</b> to cut the day to their working hours. </>
                    )}
                    Pick more dates to mark several at once, or click a date again to deselect it.
                  </p>
                )}
              </div>

              {/* Time Slots Grid */}
              {/* No "Pick a date to open the day…" pane on a phone — nothing is drawn under
                  the month until a date is picked. */}
              <div className={`${selectedDate ? "" : "hidden sm:block"} w-full flex-shrink-0 p-4 sm:p-5 lg:flex-1 lg:overflow-y-auto`}>
                {!selectedDate ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <Clock className="h-8 w-8 text-slate-200 mx-auto mb-2" />
                      <p className="text-xs text-slate-400">Pick a date to open the day for {purpose.toLowerCase()}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <h4 className="text-sm font-semibold text-slate-700" data-testid="selected-date-title">
                        {new Date(selectedDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                        {dayShiftLabel && (
                          <span className={`ml-2 text-[11px] font-medium ${isOverridden ? "text-amber-600" : "text-violet-500"}`}>
                            {dayShiftLabel}{isOverridden ? " · just this day" : ""}
                          </span>
                        )}
                      </h4>
                      {/* Top right, beside the date they act on. */}
                      {isConsultant && (
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-2" data-testid="consultant-day-actions">
                          <Button
                            size="sm"
                            onClick={saveChanges}
                            disabled={saving || nothingToOpen}
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            data-testid="consultant-mark-available"
                          >
                            {saving ? "Saving..." : nothingToOpen && focusedOpenCount > 0 ? "Already available" : "Mark available"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={unsaveDays}
                            disabled={unsaving || nothingToClose}
                            className="border-rose-200 text-rose-600 hover:bg-rose-50"
                            data-testid="consultant-mark-unavailable"
                          >
                            {unsaving ? "Removing..." : "Mark not available"}
                          </Button>
                        </div>
                      )}
                      {!isConsultant && (
                        <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
                          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400 inline-block" /> Available</span>
                          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-400 inline-block" /> Adding</span>
                          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-red-300 inline-block" /> Removing</span>
                          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400 inline-block" /> Booked</span>
                        </div>
                      )}
                    </div>
                    {/* Working a different shift on this day only. The expert stays on their
                        usual one — this is where "she's on Morning but comes in full-time
                        some days" gets said, and it has to be sayable at the moment the day
                        is being opened, not as a trip to a settings tab and back. */}
                    {/* The one shift control on this screen, laid out in the open rather than
                        behind a dialog, as a list: picking a row saves straight away (two
                        rows for a split day), and each row's Edit changes that shift's own
                        name and hours in place. */}
                    {shifts.length > 0 && (
                      <div className="mb-4 overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid="day-shift-row">
                        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
                          <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          <span className="text-[11px] font-semibold text-slate-600">
                            {selectedDates.length > 1 ? `Shift for these ${selectedDates.length} days` : "Shift for this day"}
                          </span>
                          {savingDayShift && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
                          <span className="hidden text-[10px] text-slate-400 sm:inline">
                            {isOverridden
                              ? `One-off — ${selectedDoctor.full_name} stays on ${shift?.shift_name || "their usual day"}.`
                              : "Changes this day only, not their shift."}
                          </span>
                          {onOpenTimeManagement && (
                            <button
                              type="button"
                              onClick={onOpenTimeManagement}
                              className="ml-auto rounded-md px-2 py-0.5 text-[10px] font-semibold text-violet-600 hover:bg-violet-50"
                              title="Add shifts, delete them, or change who is on which — MANAGEMENT → TIME MANAGEMENT"
                              data-testid="day-shift-open-time-management"
                            >
                              Time Management →
                            </button>
                          )}
                        </div>
                        <ul className="divide-y divide-slate-100">
                          <li>
                            <button
                              type="button"
                              disabled={savingDayShift || !isOverridden}
                              onClick={() => saveDayShift([])}
                              className={`flex w-full items-center gap-3 px-3 py-2 text-left transition disabled:cursor-default ${!isOverridden ? "bg-violet-50" : "hover:bg-slate-50"}`}
                              data-testid="day-shift-option-usual"
                            >
                              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${!isOverridden ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white"}`}>
                                {!isOverridden && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-xs ${!isOverridden ? "font-bold text-violet-700" : "font-semibold text-slate-700"}`}>
                                  {shift?.shift_name ? `${shift.shift_name} — as usual` : "Usual working day"}
                                </span>
                                <span className="block truncate text-[10px] text-slate-400">
                                  {shift ? hoursLabel(shift) : "No shift set — the full working day"}
                                </span>
                              </span>
                            </button>
                          </li>
                          {shifts.map((s) => {
                            const on = isOverridden && dayShiftIds.includes(s.id);
                            if (shiftDraft?.id === s.id) {
                              return (
                                <li key={s.id} className="bg-slate-50 px-3 py-2" data-testid={`day-shift-edit-${s.id}`}>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input
                                      type="text"
                                      value={shiftDraft.name}
                                      maxLength={40}
                                      onChange={(e) => setShiftDraft((d) => ({ ...d, name: e.target.value }))}
                                      className="h-8 min-w-0 flex-1 basis-32 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 focus:border-violet-400 focus:outline-none"
                                      placeholder="Shift name"
                                      data-testid={`day-shift-edit-name-${s.id}`}
                                    />
                                    <input
                                      type="time"
                                      value={shiftDraft.start_time}
                                      onChange={(e) => setShiftDraft((d) => ({ ...d, start_time: e.target.value }))}
                                      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-violet-400 focus:outline-none"
                                      data-testid={`day-shift-edit-start-${s.id}`}
                                    />
                                    <span className="text-[11px] text-slate-400">to</span>
                                    <input
                                      type="time"
                                      value={shiftDraft.end_time}
                                      onChange={(e) => setShiftDraft((d) => ({ ...d, end_time: e.target.value }))}
                                      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-violet-400 focus:outline-none"
                                      data-testid={`day-shift-edit-end-${s.id}`}
                                    />
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className={`text-[10px] ${shiftDraftInvalid ? "text-rose-500" : "text-slate-400"}`}>
                                      {shiftDraftInvalid
                                        ? (!shiftDraft.name.trim() ? "Name it first" : "Must end after it starts")
                                        : "Changes this shift for everyone on it at the branch."}
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setShiftDraft(null)}
                                        disabled={savingShiftEdit}
                                        className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        onClick={saveShiftEdit}
                                        disabled={savingShiftEdit || shiftDraftInvalid}
                                        className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                                        data-testid={`day-shift-edit-save-${s.id}`}
                                      >
                                        {savingShiftEdit && <Loader2 className="h-3 w-3 animate-spin" />}
                                        Save
                                      </button>
                                    </span>
                                  </div>
                                </li>
                              );
                            }
                            return (
                              <li key={s.id} className={`flex items-center ${on ? "bg-amber-50" : ""}`}>
                                <button
                                  type="button"
                                  disabled={savingDayShift}
                                  onClick={() => toggleDayShift(s.id)}
                                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition hover:bg-slate-50 disabled:opacity-60"
                                  data-testid={`day-shift-option-${s.id}`}
                                >
                                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-amber-500 bg-amber-500 text-white" : "border-slate-300 bg-white"}`}>
                                    {on && <Check className="h-3 w-3" />}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className={`block truncate text-xs ${on ? "font-bold text-amber-700" : "font-semibold text-slate-700"}`}>{s.name}</span>
                                    <span className="block truncate text-[10px] text-slate-400">{to12h(s.start_time)} – {to12h(s.end_time)}</span>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShiftDraft({ id: s.id, name: s.name || "", start_time: s.start_time || "", end_time: s.end_time || "" })}
                                  disabled={savingShiftEdit}
                                  title="Edit this shift's name and hours"
                                  className="mr-2 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-400 hover:bg-violet-50 hover:text-violet-600"
                                  data-testid={`day-shift-edit-btn-${s.id}`}
                                >
                                  <Pencil className="h-3 w-3" />
                                  Edit
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                    {/* ── The Consultant's whole answer: is this day worked, or not. ──

                        No grid of hours, because the hour is not this screen's to give. A
                        consultant's day is agreed with the patient on the phone — "come in
                        around quarter past seven" — and the desk types that on BRANCH LEADS
                        → APPOINTMENT. What this screen publishes is the day, and the shift
                        it is worked across so the desk knows which hours are fair game.

                        The two buttons are one decision said both ways round rather than a
                        toggle: closing a day can strand appointments already on it, so it
                        asks first and the affirming press must be the one that means it. */}
                    {isConsultant && focusedBookings.length > 0 && (
                      <div className="mb-4 space-y-3" data-testid="consultant-day-availability">
                        {/* What closing the day would be closing over. Said before the
                            button rather than in the error after it: the branch is about
                            to be told these cannot be removed, and knowing that while
                            deciding is the difference between a considered press and a
                            refused one. */}
                        {focusedBookings.length > 0 && (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" data-testid="consultant-day-bookings">
                            <p className="text-[11px] font-semibold text-amber-800">
                              {focusedBookings.length} appointment{focusedBookings.length === 1 ? "" : "s"} already booked — {focusedDates.length > 1 ? "these days" : "this day"} stays open for {focusedBookings.length === 1 ? "it" : "them"} whatever is set here.
                            </p>
                            <ul className="mt-1 space-y-0.5">
                              {focusedBookings.map(([slot, b]) => (
                                <li key={slot} className="text-[11px] text-amber-700">
                                  {shortDate(slot.split("T")[0])} · {to12h(slot.slice(11, 16))}{b?.lead_name ? ` — ${b.lead_name}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                      </div>
                    )}
                    {/* A shift can be edited down to less than one slot — 7:00 to 7:20 with
                        45-minute consultations fits nothing. Said plainly, because an empty
                        grid on its own reads as the calendar being broken. */}
                    {dayTimes.length === 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center" data-testid="shift-too-short">
                        <p className="text-xs font-medium text-amber-800">
                          {dayShiftLabel || "This working window"} is shorter than one {slotDuration}-minute {isRecurring ? "session" : "consultation"}.
                        </p>
                        <p className="mt-1 text-[11px] text-amber-600">
                          Widen the shift in MANAGEMENT → TIME MANAGEMENT, or shorten the duration in FITSIO STORE.
                        </p>
                      </div>
                    )}
                    {!isConsultant && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="time-slots-grid">
                      {dayTimes.map((time) => {
                        const state = getSlotState(time);
                        const detail = getSlotDetail(time);
                        const fullSlot = `${selectedDate}T${time}`;
                        const booked = isBooked(fullSlot);

                        let borderColor = "border-slate-200";
                        let bgColor = "bg-white";
                        let textColor = "text-slate-600";
                        let badge = null;

                        if (booked) {
                          borderColor = "border-amber-300";
                          bgColor = "bg-amber-50";
                          textColor = "text-amber-800";
                          badge = <span className="text-[9px] bg-amber-100 text-amber-600 rounded px-1.5 py-0.5">Booked</span>;
                        } else if (state === "existing") {
                          // An open slot carries no label — only a booked one is annotated.
                          borderColor = "border-emerald-300";
                          bgColor = "bg-emerald-50";
                          textColor = "text-emerald-800";
                        } else if (state === "adding") {
                          borderColor = "border-violet-300";
                          bgColor = "bg-violet-50";
                          textColor = "text-violet-800";
                          badge = <span className="text-[9px] bg-violet-100 text-violet-600 rounded px-1.5 py-0.5">+ Adding</span>;
                        } else if (state === "removing") {
                          borderColor = "border-red-300";
                          bgColor = "bg-red-50";
                          textColor = "text-red-600 line-through";
                          badge = <span className="text-[9px] bg-red-100 text-red-500 rounded px-1.5 py-0.5">Removing</span>;
                        }

                        return (
                          <button
                            key={time}
                            type="button"
                            onClick={() => !booked && toggleSlot(time)}
                            disabled={!!booked}
                            className={`rounded-lg border ${borderColor} ${bgColor} p-3 text-left transition-all ${booked ? "cursor-not-allowed opacity-70" : "hover:shadow-sm cursor-pointer"}`}
                            data-testid={`slot-${time}`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-sm font-semibold ${textColor}`}>{to12h(time)}</span>
                              {state === "existing" && !booked && (
                                <Trash2 className="h-3 w-3 text-slate-300 hover:text-red-400 transition-colors" />
                              )}
                            </div>
                            {badge}
                            {booked && (
                              <p className="text-[10px] text-amber-600 mt-0.5">{booked.lead_name}</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  );
};
