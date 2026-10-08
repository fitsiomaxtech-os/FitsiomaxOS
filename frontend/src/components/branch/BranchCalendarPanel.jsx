import { useCallback, useEffect, useMemo, useState } from "react";
import { Calendar as CalendarIcon, CalendarDays, ChevronLeft, ChevronRight, Clock, User, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  getBranches,
  getBranchBoard,
  getConsultDay,
  listConsultAppointments,
  updateConsultAppointment,
  cancelConsultAppointment,
} from "@/lib/api";
import { to12h } from "@/lib/time";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { BranchMonthlyCalendar } from "@/components/branch/BranchMonthlyCalendar";

// weekly_hours is keyed mon..sun; JS getDay() is 0=Sun..6=Sat.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "2026-08-02" -> "02 - 08 - 2026". Day-first, so the day of the month reads first. */
const ddmmyyyy = (dateStr) => {
  const [y, m, d] = (dateStr || "").split("-");
  return y && m && d ? `${d} - ${m} - ${y}` : dateStr || "—";
};

// Month filter — six months at a time, opening on three back / current / two ahead. The
// strip only moves when its arrows are pressed: clicking a month inside it just changes
// which one is highlighted, so the row never reflows under the cursor.
const MONTH_STRIP_LENGTH = 6;
const MONTH_STRIP_LEAD = 3;


const emptyDraft = () => ({ patient_name: "", doctor_id: "", date: iso(new Date()), time: "", notes: "", cancelled: false });

// The branch Calendar reflects the working hours + holidays configured by Super Admin
// in Branch Management, and lets the Branch Admin book / edit / cancel consultation
// appointments between a client and a Head Physio.
export const BranchCalendarPanel = ({ branchId }) => {
  const [branch, setBranch] = useState(null);
  const [leads, setLeads] = useState([]);
  const [appts, setAppts] = useState([]);
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [stripStart, setStripStart] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - MONTH_STRIP_LEAD, 1); });
  const [loading, setLoading] = useState(false);
  const [subTab, setSubTab] = useState("monthly");

  // Booking / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [dayInfo, setDayInfo] = useState(null);
  // The day a booked card was clicked into — its full list, with payments and next visits.
  const [dayView, setDayView] = useState(null); // { date, items } | null
  const [dayLoading, setDayLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const [branches, board, apptRes] = await Promise.all([
        getBranches(),
        getBranchBoard(branchId),
        listConsultAppointments(branchId),
      ]);
      setBranch((branches || []).find((b) => b.id === branchId) || null);
      setLeads(board?.leads || []);
      setAppts(apptRes?.appointments || []);
    } catch { /* silent — panel just shows an empty schedule */ }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const weekly = branch?.weekly_hours || {};
  const holidays = branch?.holidays || [];

  const upcomingGroups = useMemo(() => {
    const today = iso(new Date());
    const map = {};
    (appts || []).forEach((a) => { if (a.appointment_date >= today) (map[a.appointment_date] = map[a.appointment_date] || []).push(a); });
    const dates = Object.keys(map).sort();
    dates.forEach((d) => map[d].sort((a, b) => (a.appointment_time || "").localeCompare(b.appointment_time || "")));
    return dates.map((d) => ({ date: d, items: map[d] }));
  }, [appts]);

  const todayIso = iso(new Date());

  // One row per booking, carrying everything the calendar shows about it. The Head Physio
  // comes off the appointment itself; the Physio and the payment standing come off the
  // client's lead record, which the appointment is matched to by lead_id (falling back to
  // the name for rows booked before lead_id was recorded).
  const bookingRows = useMemo(() => {
    const leadById = {};
    const leadByName = {};
    (leads || []).forEach((l) => {
      leadById[l.id] = l;
      if (l.name) leadByName[l.name.trim().toLowerCase()] = l;
    });
    const rowFor = (lead) => ({
      physio: lead?.assigned_physio_name || "—",
      stage: lead?.consultation_stage || lead?.branch_stage || "",
      lead: lead || null,
    });

    const seen = new Set();
    const rows = [];
    (appts || []).forEach((a) => {
      const name = a.patient_name || a.lead_name || "—";
      const lead = (a.lead_id && leadById[a.lead_id]) || leadByName[name.trim().toLowerCase()] || null;
      seen.add(`${a.appointment_date}|${a.appointment_time || ""}|${name.trim().toLowerCase()}`);
      rows.push({
        id: a.id, appt: a, date: a.appointment_date, time: a.appointment_time || "",
        name, headPhysio: a.doctor_name || "—", ...rowFor(lead),
      });
    });
    // A lead carrying an appointment that never made it into `appointments` — booked
    // before Branch Leads started writing one. Kept so nothing silently disappears.
    (leads || []).forEach((l) => {
      if (!l.appointment_date) return;
      const key = `${l.appointment_date}|${l.appointment_time || ""}|${(l.name || "").trim().toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        id: `lead-${l.id}`, appt: null, date: l.appointment_date, time: l.appointment_time || "",
        name: l.name || "—", headPhysio: l.appointment_expert_name || l.appointment_doctor_name || "—", ...rowFor(l),
      });
    });
    return rows;
  }, [appts, leads]);

  // Only days that actually have a booking, in date order — the calendar lists what is
  // booked rather than painting every square of the month.
  const bookedDays = useMemo(() => {
    const prefix = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}-`;
    const map = {};
    bookingRows.forEach((r) => { if ((r.date || "").startsWith(prefix)) (map[r.date] = map[r.date] || []).push(r); });
    return Object.keys(map).sort().map((date) => ({
      date,
      items: map[date].sort((a, b) => (a.time || "").localeCompare(b.time || "")),
    }));
  }, [bookingRows, monthDate]);

  /** Next unpaid Treatment Fee installment on this client's record, if any. */
  const paymentDue = (lead) => {
    const next = ((lead?.treatment_fee_payment_details?.installments) || [])
      .filter((i) => !i.paid)
      .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))[0];
    return next ? { date: next.due_date, amount: next.amount } : null;
  };

  /** This client's next booking from today onward — their upcoming visit. */
  const upcomingFor = (name) => bookingRows
    .filter((r) => r.name.trim().toLowerCase() === (name || "").trim().toLowerCase() && r.date >= todayIso)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0] || null;

  const monthLabel = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const currentMonthKey = `${new Date().getFullYear()}-${new Date().getMonth()}`;

  // The six months the strip is showing. Held separately from the month being viewed so a
  // click inside the strip only moves the highlight — the arrows are the only thing that
  // slides the window, and they carry the viewed month along so it keeps its position.
  const monthStrip = useMemo(
    () => Array.from({ length: MONTH_STRIP_LENGTH }, (_, i) => new Date(stripStart.getFullYear(), stripStart.getMonth() + i, 1)),
    [stripStart],
  );
  const shiftStrip = (delta) => {
    setStripStart((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    setMonthDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  // ---- Booking / edit modal — date-first availability flow ----
  // 1) pick date -> validate against branch working calendar (hours + holidays)
  // 2) if open -> show Head Physios + their free 30-min slots; 3) pick physio -> slots
  const fetchDay = useCallback(async (date) => {
    if (!date) { setDayInfo(null); return; }
    setDayLoading(true);
    try { setDayInfo(await getConsultDay(branchId, date)); }
    catch { setDayInfo(null); }
    setDayLoading(false);
  }, [branchId]);

  useEffect(() => {
    if (!modalOpen) return;
    fetchDay(draft.date);
  }, [modalOpen, draft.date, fetchDay]);

  // No booking path on this panel any more — consultations are booked from Branch Leads →
  // Appointment. The modal below only ever opens on an existing appointment, to reschedule
  // or cancel it.
  const openEdit = (a) => {
    setEditingId(a.id);
    setDraft({ patient_name: a.patient_name || a.lead_name || "", doctor_id: a.doctor_id, date: a.appointment_date, time: a.appointment_time, notes: a.notes || "", cancelled: false });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditingId(null); setDayInfo(null); };

  // Selected Head Physio's free slots (add back the appointment's own time when editing).
  const selectedHP = dayInfo?.head_physios?.find((h) => h.id === draft.doctor_id) || null;
  const availableSlots = (() => {
    const slots = selectedHP ? [...(selectedHP.available_slots || [])] : [];
    if (editingId && draft.time && !slots.includes(draft.time)) slots.push(draft.time);
    return slots.sort();
  })();

  const cancelAppt = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await cancelConsultAppointment(editingId);
      toast.success("Appointment cancelled");
      closeModal();
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not cancel");
    }
    setSaving(false);
  };

  const submit = async () => {
    if (!draft.patient_name.trim()) { toast.error("Enter the patient name"); return; }
    if (!draft.date) { toast.error("Pick a date"); return; }
    if (dayInfo && !dayInfo.open) { toast.error(dayInfo.reason || "The branch is closed on this date"); return; }
    if (editingId && draft.cancelled) { await cancelAppt(); return; }
    if (!draft.doctor_id) { toast.error("Select a CONSULTANT"); return; }
    if (!draft.time) { toast.error("Select an available time slot"); return; }
    setSaving(true);
    try {
      const payload = { patient_name: draft.patient_name.trim(), doctor_id: draft.doctor_id, date: draft.date, time: draft.time, notes: draft.notes };
      await updateConsultAppointment(editingId, payload);
      toast.success("Appointment updated");
      closeModal();
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not save appointment");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4" data-testid="branch-calendar-panel">
      {/* Sub-tabs */}
      {/* Three even columns on a phone, icon over label, like the MANAGEMENT strip right
          above it: wrapped as pills the three labels fell into three ragged rows. */}
      <div className="grid auto-rows-fr grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:flex sm:flex-wrap sm:gap-2" data-testid="cal-subtabs">
        {/* First, because it is the setting the rest of this panel and the Consultant and
            Physiotherapist calendars obey: which days the branch works at all. */}
        <button type="button" onClick={() => setSubTab("monthly")} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-center text-[10px] font-semibold leading-tight transition sm:inline-flex sm:flex-row sm:gap-2 sm:px-3 sm:text-sm sm:font-medium ${subTab === "monthly" ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`} data-testid="cal-subtab-monthly">
          <CalendarDays className="h-4 w-4 shrink-0" />Monthly Calendar
        </button>
        <button type="button" onClick={() => setSubTab("schedule")} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-center text-[10px] font-semibold leading-tight transition sm:inline-flex sm:flex-row sm:gap-2 sm:px-3 sm:text-sm sm:font-medium ${subTab === "schedule" ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`} data-testid="cal-subtab-schedule">
          <CalendarIcon className="h-4 w-4 shrink-0" />Calendar by Booked Lists
        </button>
        <button type="button" onClick={() => setSubTab("upcoming")} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-center text-[10px] font-semibold leading-tight transition sm:inline-flex sm:flex-row sm:gap-2 sm:px-3 sm:text-sm sm:font-medium ${subTab === "upcoming" ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`} data-testid="cal-subtab-upcoming">
          <Clock className="h-4 w-4 shrink-0" />Upcoming Appointments
        </button>
      </div>

      {subTab === "monthly" && <BranchMonthlyCalendar branchId={branchId} />}

      {subTab === "schedule" && (
      <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold text-slate-700" data-testid="cal-month-label">{monthLabel}</p>
        {/* Every chip is the same fixed width and always carries its year on a second
            line, so the strip is exactly as wide with "September 2025" in it as with
            "May" — it can't grow, reflow, or overflow as the months change.

            Six of them plus both arrows is around 690px, though, which a phone does not
            have: the row ran off the right edge of the page. The chips now scroll inside
            their own track on mobile while the arrows stay put either side, so the strip
            keeps all six months and shifts the same way it always did. Desktop has the
            room and is unchanged. */}
        <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0" data-testid="cal-month-filter">
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => shiftStrip(-1)} data-testid="cal-prev-month"><ChevronLeft className="h-4 w-4" /></Button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] sm:flex-none sm:overflow-visible [&::-webkit-scrollbar]:hidden">
          {monthStrip.map((d) => {
            const key = `${d.getFullYear()}-${d.getMonth()}`;
            const isViewed = key === `${monthDate.getFullYear()}-${monthDate.getMonth()}`;
            const isCurrent = key === currentMonthKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setMonthDate(new Date(d.getFullYear(), d.getMonth(), 1))}
                className={`w-20 shrink-0 rounded-md border py-1 text-center leading-tight transition sm:w-24 ${
                  isViewed
                    ? "border-sky-600 bg-sky-600 text-white shadow-sm"
                    : isCurrent
                    ? "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={isCurrent ? "Current month" : undefined}
                data-testid={`cal-month-${d.getFullYear()}-${d.getMonth() + 1}`}
              >
                <span className="block truncate px-1 text-sm font-semibold">{d.toLocaleDateString("en-US", { month: "long" })}</span>
                <span className={`block text-[10px] font-medium ${isViewed ? "text-sky-100" : "text-slate-400"}`}>{d.getFullYear()}</span>
              </button>
            );
          })}
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => shiftStrip(1)} data-testid="cal-next-month"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* Booked days only, three to a row. A day with nothing on it isn't drawn at all —
          this is a list of what's booked, not a painting of the month. */}
      {bookedDays.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-12 text-center text-sm text-slate-400" data-testid="cal-no-bookings">
          Nothing booked in {monthLabel}.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="cal-booked-grid">
          {bookedDays.map(({ date, items }) => {
            const d = new Date(`${date}T00:00:00`);
            const isToday = date === todayIso;
            const isHoliday = holidays.includes(date);
            const shown = items.slice(0, 4);
            return (
              <button
                key={date}
                type="button"
                onClick={() => setDayView({ date, items })}
                className={`flex min-h-[13rem] flex-col overflow-hidden rounded-xl border-2 text-left transition hover:shadow-md ${
                  isToday ? "border-sky-400 ring-2 ring-sky-100" : "border-slate-200 hover:border-sky-300"
                } ${isHoliday ? "bg-rose-50/40" : "bg-white"}`}
                data-testid={`cal-day-${date}`}
              >
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
                  <div className="min-w-0">
                    {/* Weekday, then the date day-first in its own light-shaded chip so the
                        numbers read as one unit rather than running into the weekday. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-base font-bold ${isToday ? "text-sky-700" : "text-slate-800"}`}>
                        {d.toLocaleDateString("en-US", { weekday: "long" })}
                      </p>
                      <span className="rounded-md bg-sky-50 px-2 py-0.5 text-sm font-semibold tracking-wide text-sky-700" data-testid={`cal-day-label-${date}`}>
                        {ddmmyyyy(date)}
                      </span>
                    </div>
                    {(isToday || isHoliday) && (
                      <p className="mt-0.5 text-xs font-bold">
                        {isToday && <span className="text-sky-600">Today</span>}
                        {isToday && isHoliday && <span className="text-slate-300"> · </span>}
                        {isHoliday && <span className="text-rose-500">Holiday</span>}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-lg border-2 border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">
                    {items.length} booked
                  </span>
                </div>

                <div className="flex-1 divide-y divide-slate-100 px-4">
                  {shown.map((r) => (
                    <div key={r.id} className="py-2.5" data-testid={`cal-booking-${r.id}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-bold text-slate-800">{r.name}</p>
                        <span className="shrink-0 text-xs font-bold text-violet-600">{r.time ? to12h(r.time) : "—"}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        <span className="font-semibold text-slate-400">CONSULTANT</span> {r.headPhysio}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        <span className="font-semibold text-slate-400">Physio</span> {r.physio}
                      </p>
                    </div>
                  ))}
                </div>

                {items.length > shown.length && (
                  <p className="border-t border-slate-100 px-4 py-2 text-xs font-semibold text-sky-600">
                    +{items.length - shown.length} more<span className="hidden sm:inline"> · click to see the full list</span>
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
      </>
      )}

      {/* One booked day in full — every client on it, with what they still owe and when
          they're next in, so the day can be worked from a single screen. */}
      {dayView && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" data-testid="cal-day-modal">
          <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 bg-slate-500 px-6 py-4 text-white">
              {/* min-w-0 lets the address wrap instead of squeezing the badge into two
                  lines — the badge and the close button stay on one row, top-aligned. */}
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-lg font-bold" data-testid="cal-day-modal-date">
                  {new Date(`${dayView.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" })}
                  <span className="rounded-md bg-white/20 px-2 py-0.5 text-base font-semibold tracking-wide">{ddmmyyyy(dayView.date)}</span>
                </p>
                <p className="text-xs text-white/80">
                  {branch?.branch_name || "Branch"}
                  {branch?.address ? ` · ${branch.address}` : ""}
                  {(() => {
                    // weekly_hours keys a day as { is_open, open, close }; no entry at all
                    // means the branch defaults to open 09:00–20:00, same as the backend.
                    const cfg = weekly[DAY_KEYS[new Date(`${dayView.date}T00:00:00`).getDay()]];
                    if (holidays.includes(dayView.date)) return " · Holiday";
                    if (cfg && cfg.is_open === false) return " · Closed";
                    return ` · ${to12h(cfg?.open || "09:00")} – ${to12h(cfg?.close || "20:00")}`;
                  })()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="whitespace-nowrap rounded-lg border-2 border-white/40 bg-white/15 px-3 py-1.5 text-sm font-bold">
                  {dayView.items.length} booked
                </span>
                <button onClick={() => setDayView(null)} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="cal-day-modal-close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-2.5">
                {dayView.items.map((r) => {
                  const due = paymentDue(r.lead);
                  const overdue = due && due.date < todayIso;
                  const next = upcomingFor(r.name);
                  return (
                    <div key={r.id} className="rounded-xl border-2 border-slate-200 bg-white p-4" data-testid={`cal-day-modal-row-${r.id}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-base font-bold text-slate-800">{r.name}</p>
                        <span className="rounded-md border-2 border-violet-300 bg-violet-50 px-2.5 py-1 text-sm font-bold text-violet-700">
                          {r.time ? to12h(r.time) : "—"}
                        </span>
                      </div>

                      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <p className="text-sm text-slate-600">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">CONSULTANT</span><br />
                          {r.headPhysio}
                        </p>
                        <p className="text-sm text-slate-600">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Physio</span><br />
                          {r.physio}
                        </p>
                        <p className="text-sm">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Payment Due</span><br />
                          {due ? (
                            <span className={overdue ? "font-bold text-rose-600" : "font-bold text-amber-600"}>
                              Rs.{due.amount} · {new Date(`${due.date}T00:00:00`).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
                              {overdue && " · OVERDUE"}
                            </span>
                          ) : (
                            <span className="font-semibold text-emerald-600">Nothing due</span>
                          )}
                        </p>
                        <p className="text-sm">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Upcoming</span><br />
                          {next ? (
                            <span className="font-semibold text-sky-700">
                              {new Date(`${next.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}
                              {next.time ? ` · ${to12h(next.time)}` : ""}
                            </span>
                          ) : (
                            <span className="text-slate-400">No future visit booked</span>
                          )}
                        </p>
                      </div>

                      {r.stage && <p className="mt-2 text-xs font-semibold text-slate-400">Stage · {r.stage}</p>}

                      {r.appt && (
                        <div className="mt-3 flex justify-end">
                          <Button size="sm" variant="outline" className="text-xs" onClick={() => { setDayView(null); openEdit(r.appt); }} data-testid={`cal-day-modal-edit-${r.id}`}>
                            <Pencil className="mr-1.5 h-3 w-3" />Edit / Reschedule
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2.5 border-t-2 border-slate-200 bg-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:py-3.5">
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">Payment Due is the next unpaid Treatment Fee installment on the client's record.</p>
              <Button variant="outline" className="w-full shrink-0 sm:w-auto" onClick={() => setDayView(null)} data-testid="cal-day-modal-back">Close</Button>
            </div>
          </div>
        </div>
      )}

      {subTab === "upcoming" && (
      <div className="space-y-4" data-testid="cal-upcoming-list">
        {upcomingGroups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">No upcoming consultations.<span className="hidden sm:inline"> Use the + on a day in Calendar by Booked Lists to schedule one.</span></p>
        ) : (
          upcomingGroups.map((g) => (
            <div key={g.date} data-testid={`cal-upcoming-${g.date}`}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                {new Date(g.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
              </p>
              <div className="space-y-1.5">
                {g.items.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => openEdit(a)}
                    className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-sky-300 hover:bg-sky-50/40"
                    data-testid={`cal-upcoming-appt-${a.id}`}
                  >
                    <div className="flex w-16 shrink-0 flex-col items-center rounded-md bg-violet-50 py-1">
                      <Clock className="h-3 w-3 text-violet-500" />
                      <span className="text-xs font-bold text-violet-700">{to12h(a.appointment_time)}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800" title={a.patient_name}>{a.patient_name || a.lead_name || "—"}</p>
                      {a.doctor_name && <p className="flex items-center gap-1 truncate text-xs text-slate-500"><User className="h-3 w-3" />{a.doctor_name}</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">Scheduled</span>
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      )}

      {loading && <p className="text-center text-xs text-slate-400">Loading…</p>}
      {!loading && !branch && (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-400">
          No branch schedule found. Ask a Super Admin to set working hours &amp; holidays in Branch Management.
        </p>
      )}

      {/* Appointment Date & Time modal — same format/flow as Branch Leads */}
      {modalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }} data-testid="cal-booking-modal">
          <div className="max-h-[90vh] w-full max-w-md overflow-hidden overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-gradient-to-r from-teal-500 to-cyan-600 px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5" />
                <p className="text-base font-semibold">Appointment Date &amp; Time</p>
              </div>
              <button onClick={closeModal} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="cal-modal-close"><X className="h-4 w-4" /></button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Patient Name *</label>
                <Input value={draft.patient_name} onChange={(e) => setDraft((p) => ({ ...p, patient_name: e.target.value }))} placeholder="Client name" data-testid="cal-modal-patient" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Date *</label>
                <MilkDateInput  value={draft.date} onChange={(e) => setDraft((p) => ({ ...p, date: e.target.value, doctor_id: "", time: "" }))} data-testid="cal-modal-date" />
              </div>

              {dayLoading ? (
                <p className="text-xs text-slate-400" data-testid="cal-modal-daychecking">Checking the branch calendar…</p>
              ) : dayInfo && !dayInfo.open ? (
                <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-medium text-rose-500" data-testid="cal-modal-closed">
                  {dayInfo.reason || "The branch is closed on this date."} Booking is not allowed.
                </p>
              ) : dayInfo && dayInfo.open ? (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-600">CONSULTANT *</label>
                    <p className="mb-1.5 text-[11px] text-slate-400">Available times come from each CONSULTANT's calendar. Branch open {to12h(dayInfo.open_time)}–{to12h(dayInfo.close_time)}.</p>
                    {dayInfo.head_physios.length === 0 ? (
                      <p className="text-xs text-amber-600">No CONSULTANTS assigned to this branch yet — ask HR / Super Admin.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {dayInfo.head_physios.map((hp) => {
                          const editSelf = editingId && draft.doctor_id === hp.id && draft.time && !hp.available_slots.includes(draft.time);
                          const freeCount = hp.available_slots.length + (editSelf ? 1 : 0);
                          return (
                            <button
                              key={hp.id}
                              type="button"
                              onClick={() => setDraft((p) => ({ ...p, doctor_id: hp.id, time: "" }))}
                              className={`flex w-full items-center gap-3 rounded-md border p-2.5 text-left ${draft.doctor_id === hp.id ? "border-teal-400 bg-teal-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                              data-testid={`cal-modal-hp-${hp.id}`}
                            >
                              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-100 text-xs font-bold text-teal-700">{hp.full_name?.charAt(0) || "H"}</div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-slate-800">{hp.full_name}</p>
                                <p className="truncate text-[10px] text-slate-400">{hp.specialization || "CONSULTANT"}</p>
                              </div>
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${freeCount > 0 ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                                {freeCount > 0 ? `${freeCount} slots` : "No slots"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {selectedHP && (
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-600">Time *</label>
                      {availableSlots.length === 0 ? (
                        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-400" data-testid="cal-modal-noslots">No available time slots for {selectedHP.full_name} on this date.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5" data-testid="cal-modal-slots">
                          {availableSlots.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setDraft((p) => ({ ...p, time: t }))}
                              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${draft.time === t ? "border-teal-500 bg-teal-500 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:bg-teal-50"}`}
                              data-testid={`cal-modal-slot-${t}`}
                            >
                              {to12h(t)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : null}
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Notes</label>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
                  placeholder="Optional notes about the appointment..."
                  value={draft.notes}
                  onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                  data-testid="cal-modal-notes"
                />
              </div>
              {editingId && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={draft.cancelled} onChange={(e) => setDraft((p) => ({ ...p, cancelled: e.target.checked }))} data-testid="cal-modal-cancel-toggle" />
                  Cancelled
                </label>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
              <Button variant="outline" onClick={closeModal} disabled={saving} data-testid="cal-modal-dismiss">Cancel</Button>
              <Button className="bg-teal-600 text-white hover:bg-teal-700" onClick={submit} disabled={saving || (dayInfo && !dayInfo.open && !(editingId && draft.cancelled))} data-testid="cal-modal-save">
                {saving ? "Saving…" : "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
