import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Calendar, CheckCircle2, ChevronLeft, ChevronRight, Home, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { AppointmentConfirmCard } from "@/components/AppointmentConfirmCard";
import { getAvailableDates, getAvailableExperts, listStoreItems, scheduleBranchAppointment } from "@/lib/api";
import { to12h, endTime12h } from "@/lib/time";
import { toIso, todayIso } from "@/lib/dateRange";

// The Pre Sales lead card's Appointment pill. It used to take a branch, a requested date
// and time and a remark, and pass the lead to Branch Admin, who then booked the consultant.
// The desk now books the consultant itself, the way Branch Leads does (BranchLeadModal in
// BranchAdminBoard): where the consultation happens first -- Offline Consultation or House
// Visit, the question and the two choices and nothing else -- then, for a house visit, its
// package, then the date / consultant / time grid. Confirm is schedule-branch-appointment
// with presales_handoff, which moves the lead to the Pre-Sales Appointment stage and the
// branch in the same write as the booking.
//
// Branch Leads' own pencil on a booked time (hand it to another consultant, move it, swap
// it) is left out: those move somebody else's appointment, and that is the branch's call.
// The day's bookings are still listed, read-only, so the desk can see what is free.

/** 128 bits from the platform CSPRNG -- the confirmation's share link is keyed by it. */
const randomToken = () => {
  const bytes = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "9:05" -> 545. Minutes past midnight, or null if it isn't a clock reading. */
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
};
const clockText = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const shiftName = (mins) => (mins < 12 * 60 ? "Morning" : mins < 17 * 60 ? "Afternoon" : "Evening");

/** The three time fields read as one 24-hour "HH:MM", or "" while any is unreadable. */
const clockOf = ({ h, m, ap }) => {
  const hh = Number(h);
  const mm = Number(m);
  if (String(h).trim() === "" || !Number.isInteger(hh) || hh < 1 || hh > 12) return "";
  if (String(m).trim() === "" || !Number.isInteger(mm) || mm < 0 || mm > 59) return "";
  const h24 = ap === "PM" ? (hh === 12 ? 12 : hh + 12) : hh === 12 ? 0 : hh;
  return `${String(h24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

/** "14:30" -> the three fields. */
const clockFrom = (hhmm) => {
  const mins = minutesOf(hhmm);
  if (mins === null) return { h: "", m: "", ap: "AM" };
  const h24 = Math.floor(mins / 60);
  return { h: String(h24 % 12 === 0 ? 12 : h24 % 12), m: String(mins % 60).padStart(2, "0"), ap: h24 >= 12 ? "PM" : "AM" };
};

export function PreSalesAppointmentDialog({ lead, branchId: ownBranchId = "", branches = [], onClose, onBooked }) {
  // The branch the patient is booked at: the desk's own, or picked here when the login has
  // none (Super Admin, Business Dev) -- consultants and their days are per branch.
  const [branchId, setBranchId] = useState(ownBranchId || "");
  const branchInfo = branches.find((b) => b.id === branchId) || null;
  const [draft, setDraft] = useState(() => {
    const tomorrow = toIso(new Date(Date.now() + 86400000));
    return {
      step: "visit",
      visit_type: "",
      visit_package_id: "",
      visit_package: null,
      visit_package_amount: null,
      appointment_date: lead.appointment_date && lead.appointment_date >= todayIso() ? lead.appointment_date : tomorrow,
      appointment_time: lead.appointment_time || "",
      physio_id: lead.assigned_physio_id || "",
      duration: null,
    };
  });
  const [time, setTime] = useState(() => clockFrom(lead.appointment_time || ""));
  const [month, setMonth] = useState(() => { const [y, m] = draft.appointment_date.split("-").map(Number); return { y, m: m - 1 }; });
  const [openDates, setOpenDates] = useState({});
  const [experts, setExperts] = useState({ experts: [], slot_minutes: null, duration_rule: true, loading: false });
  const [hvPackages, setHvPackages] = useState({ items: [], loading: false, error: "" });
  const [saving, setSaving] = useState(false);
  // Shown once the booking is made, as Branch Leads shows it, so the patient can be sent it.
  const [confirm, setConfirm] = useState(null);

  const loadHvPackages = async () => {
    setHvPackages((p) => ({ ...p, loading: true, error: "" }));
    try {
      setHvPackages({ items: (await listStoreItems("home_visit_consultation", "session")) || [], loading: false, error: "" });
    } catch (e) {
      setHvPackages({ items: [], loading: false, error: e?.response?.data?.detail || "Could not load the House Visit packages" });
    }
  };

  const fetchExperts = useCallback(async (branch, dateStr) => {
    if (!branch || !dateStr) return;
    setExperts((p) => ({ ...p, loading: true }));
    try {
      const res = await getAvailableExperts(branch, dateStr, undefined, lead.id);
      setExperts({ experts: res.experts || [], slot_minutes: res.slot_minutes || null, duration_rule: res.duration_rule !== false, loading: false });
      setDraft((d) => ((res.experts || []).some((x) => x.id === d.physio_id) ? d : { ...d, physio_id: "" }));
    } catch {
      setExperts({ experts: [], slot_minutes: null, duration_rule: true, loading: false });
    }
  }, [lead.id]);

  const booking = draft.step === "book";
  useEffect(() => {
    if (booking) fetchExperts(branchId, draft.appointment_date);
  }, [booking, branchId, draft.appointment_date, fetchExperts]);

  // Which days of the shown month have a consultant on, so the days worth clicking show.
  useEffect(() => {
    if (!booking || !branchId) return undefined;
    let cancelled = false;
    getAvailableDates(branchId, `${month.y}-${String(month.m + 1).padStart(2, "0")}`, lead.id)
      .then((res) => { if (!cancelled) setOpenDates(res?.dates || {}); })
      .catch(() => { if (!cancelled) setOpenDates({}); });
    return () => { cancelled = true; };
  }, [booking, branchId, month.y, month.m, lead.id]);

  const selectedExpert = useMemo(
    () => (draft.physio_id ? experts.experts.find((d) => d.id === draft.physio_id) : null) || null,
    [experts.experts, draft.physio_id],
  );
  // The picked consultant's day: open times and taken ones together, in clock order.
  const daySlots = useMemo(() => {
    if (!selectedExpert) return [];
    const free = (selectedExpert.free_slots || []).map((s) => ({ ...s, booked: false }));
    const taken = (selectedExpert.booked_slots || []).map((s) => ({ ...s, booked: true }));
    return [...free, ...taken].sort((a, b) => (a.slot_time || "").localeCompare(b.slot_time || ""));
  }, [selectedExpert]);
  const slotMinutes = experts.slot_minutes || 30;
  const durationRule = experts.duration_rule !== false;
  const dayPublished = (selectedExpert?.published_slot_count || 0) > 0;
  // The stretches of the day the consultant published.
  const dayBlocks = useMemo(() => {
    const published = (selectedExpert?.day_blocks || [])
      .map((b) => [minutesOf(b.start), minutesOf(b.end)])
      .filter(([a, b]) => a !== null && b !== null);
    if (published.length) return published;
    const rows = daySlots
      .map((x) => [minutesOf(x.time), minutesOf(x.time) + (Number(x.duration) || 0)])
      .filter(([a]) => a !== null)
      .sort((a, b) => a[0] - b[0]);
    const blocks = [];
    rows.forEach(([a, b]) => {
      const last = blocks[blocks.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else blocks.push([a, b]);
    });
    return blocks;
  }, [daySlots, selectedExpert]);
  const dayHours = dayBlocks.map(([a, b]) => `${to12h(clockText(a))} – ${to12h(clockText(b))}`).join(" · ");
  // A typed time outside every published stretch: said, not refused.
  const outsideHours = useMemo(() => {
    const t = minutesOf(draft.appointment_time);
    if (t === null || dayBlocks.length === 0) return false;
    return !dayBlocks.some(([a, b]) => t >= a && t + slotMinutes <= b);
  }, [draft.appointment_time, dayBlocks, slotMinutes]);
  // Whatever already holds the consultant across the typed hour. Refused, as the server
  // refuses it -- two patients in one room.
  const clash = useMemo(() => {
    const start = minutesOf(draft.appointment_time);
    if (start === null || !durationRule) return null;
    return daySlots.find((x) => {
      if (!x.booked) return false;
      const t = minutesOf(x.time);
      return t !== null && start < t + (Number(x.duration) || 30) && t < start + slotMinutes;
    }) || null;
  }, [draft.appointment_time, daySlots, slotMinutes, durationRule]);

  const setClock = (patch) => {
    const next = { ...time, ...patch };
    setTime(next);
    const hhmm = clockOf(next);
    setDraft((d) => ({ ...d, appointment_time: hhmm, duration: hhmm ? slotMinutes : null }));
  };

  const chooseVisit = (key) => {
    if (!branchId) { toast.error("Please select a branch"); return; }
    if (key === "home") {
      setDraft((d) => ({ ...d, visit_type: "home", step: "package" }));
      loadHvPackages();
    } else {
      setDraft((d) => ({ ...d, visit_type: "branch", visit_package_id: "", visit_package: null, visit_package_amount: null, step: "book" }));
    }
  };

  const submit = async () => {
    if (!draft.appointment_date) { toast.error("Pick a date"); return; }
    if (!draft.physio_id) { toast.error("Select a CONSULTANT"); return; }
    if (!draft.appointment_time) { toast.error("Type the time agreed with the patient"); return; }
    if (draft.visit_type === "home" && !draft.visit_package_id) {
      toast.error("Pick a House Visit package");
      setDraft((d) => ({ ...d, step: "package" }));
      loadHvPackages();
      return;
    }
    if (draft.visit_type === "home" && draft.visit_package?.manual && !(Number(draft.visit_package_amount) > 0)) {
      toast.error("Enter the amount for the House Visit package");
      setDraft((d) => ({ ...d, step: "package" }));
      return;
    }
    const refNo = `APT-${(lead.patient_number || lead.id || "").toString().slice(-8).toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const shareToken = randomToken();
    setSaving(true);
    try {
      const saved = await scheduleBranchAppointment(lead.id, {
        appointment_date: draft.appointment_date,
        appointment_time: draft.appointment_time,
        physio_id: draft.physio_id,
        notes: "",
        duration: draft.duration,
        visit_type: draft.visit_type,
        visit_package_id: draft.visit_type === "home" ? draft.visit_package_id : "",
        visit_package_amount: draft.visit_package?.manual ? Number(draft.visit_package_amount) || null : null,
        ref_no: refNo,
        share_token: shareToken,
        presales_handoff: true,
        branch_id: branchId,
      });
      toast.success(`Appointment ${draft.appointment_date} ${to12h(draft.appointment_time)} booked`);
      onBooked && onBooked(saved);
      setConfirm({
        refNo,
        shareToken,
        patient: lead.name || "—",
        patientNo: saved?.patient_number || lead.patient_number || "—",
        phone: lead.phone || "—",
        branch: branchInfo?.branch_name || branchInfo?.name || "",
        branchAddress: branchInfo?.address || "",
        mapLocation: branchInfo?.map_location || "",
        adminName: branchInfo?.admin_name || "",
        adminPhone: branchInfo?.admin_phone || "",
        branchPhone: branchInfo?.phone || "",
        date: draft.appointment_date,
        time: draft.appointment_time,
        duration: draft.duration || 30,
        headPhysio: selectedExpert?.full_name || "—",
        houseVisit: saved?.visit_type === "home",
        packageName: saved?.visit_package_name || "",
        packagePrice: saved?.visit_package_price ?? null,
        meetLink: (selectedExpert?.meet_link || "").trim(),
        notes: "",
        bookedBy: "Pre Sales",
      });
    } catch (e) {
      toast.error(e?.response?.data?.detail || e?.message || "Failed to schedule");
    }
    setSaving(false);
  };

  // Once booked, only the confirmation stays up; closing it closes this popup too.
  if (confirm) {
    return <AppointmentConfirmCard appt={confirm} onClose={() => { setConfirm(null); onClose(); }} testid="presales-appt-confirm" />;
  }

  const todayStr = todayIso();
  const firstDow = new Date(month.y, month.m, 1).getDay();
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const pad = (n) => String(n).padStart(2, "0");
  const stepMonth = (delta) => setMonth(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-2 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="presales-appt-modal">
      <div
        className={`flex max-h-[calc(100vh-2rem)] w-full ${booking ? "max-w-6xl" : "max-w-2xl"} flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl`}
        style={{ maxHeight: "calc(100dvh - 2rem)" }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 sm:px-5 sm:py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Calendar className="h-4 w-4 shrink-0 text-sky-600" />
            <p className="truncate text-sm font-semibold text-slate-900">Appointment</p>
            {booking && (
              <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-[4px] border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700" data-testid="presales-appt-visit-chip">
                {draft.visit_type === "home" ? <Home className="h-3.5 w-3.5 shrink-0" /> : <Building2 className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">
                  {draft.visit_type === "home"
                    ? `House Visit${draft.visit_package?.name ? ` · ${draft.visit_package.name}` : ""}`
                    : "Offline Consultation"}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, step: "visit" }))}
                  className="shrink-0 font-bold text-sky-800 underline underline-offset-2 hover:text-sky-900"
                  data-testid="presales-appt-visit-change"
                >
                  Change
                </button>
              </span>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="presales-appt-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Where the consultation happens: the question and the two choices, no more. */}
        {draft.step === "visit" && (
          <div className="overflow-y-auto p-4 sm:p-6" data-testid="presales-appt-visit-step">
            <p className="mb-4 text-base font-bold text-slate-800">How will {lead.name || "the patient"} be consulted?</p>
            {/* Only a login with no branch of its own is asked which one. */}
            {!ownBranchId && (
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="mb-4 h-10 w-full rounded-[4px] border border-slate-200 px-3 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                data-testid="presales-appt-branch"
              >
                <option value="">-- choose a branch --</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name || b.name}</option>)}
              </select>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { key: "branch", label: "Offline Consultation", icon: Building2 },
                { key: "home", label: "House Visit", icon: Home },
              ].map((v) => {
                const Icon = v.icon;
                const on = draft.visit_type === v.key;
                return (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => chooseVisit(v.key)}
                    className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${
                      on ? "border-sky-500 bg-sky-50 shadow-sm" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"
                    }`}
                    data-testid={`presales-appt-visit-${v.key}`}
                  >
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${on ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-bold text-slate-800">{v.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {draft.step === "package" && (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="presales-appt-package-step">
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <p className="mb-4 text-base font-bold text-slate-800">House Visit package</p>
              {hvPackages.loading ? (
                <p className="py-10 text-center text-sm text-slate-400">Loading packages…</p>
              ) : hvPackages.error ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-6 text-center text-sm text-rose-700">
                  {hvPackages.error}
                  <button type="button" onClick={loadHvPackages} className="ml-2 font-semibold underline">Try again</button>
                </div>
              ) : hvPackages.items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">No House Visit packages yet.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2" data-testid="presales-appt-packages">
                  {hvPackages.items.map((it) => {
                    const picked = draft.visit_package_id === it.id;
                    const visits = Number(it.sessions_offline) || 0;
                    const rate = Number(it.price_offline) || 0;
                    const total = Math.round(it.price_is_total ? rate : rate * visits);
                    return (
                      <button
                        key={it.id}
                        type="button"
                        // A package with no fixed price stays here so its amount can be typed.
                        onClick={() => setDraft((d) => ({
                          ...d,
                          visit_type: "home",
                          visit_package_id: it.id,
                          visit_package: { id: it.id, name: it.name, manual: Boolean(it.manual_price) },
                          visit_package_amount: it.manual_price ? (d.visit_package_id === it.id ? d.visit_package_amount : "") : null,
                          step: it.manual_price ? "package" : "book",
                        }))}
                        className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-left transition ${
                          picked ? "border-sky-500 bg-sky-50 shadow-sm" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"
                        }`}
                        data-testid={`presales-appt-package-${it.id}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold text-slate-800">{it.name}</span>
                          <span className="mt-1 block text-[11px] text-slate-500">
                            {visits} {visits === 1 ? "visit" : "visits"}{!it.price_is_total && visits > 1 ? ` · ₹${rate} per visit` : ""}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          {it.manual_price
                            ? <span className="text-xs font-bold text-amber-700">Enter amount</span>
                            : <span className="text-base font-extrabold text-slate-900">₹{total}</span>}
                          {picked && <CheckCircle2 className="h-5 w-5 text-sky-600" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {draft.visit_package?.manual && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="presales-appt-package-amount">
                  <label className="mb-1 block text-xs font-bold text-amber-800">Amount for {draft.visit_package.name}</label>
                  <div className="relative max-w-xs">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-amber-700">₹</span>
                    <Input
                      type="number"
                      min="1"
                      autoFocus
                      value={draft.visit_package_amount ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, visit_package_amount: e.target.value }))}
                      placeholder="Enter the amount"
                      className="bg-white pl-7"
                      data-testid="presales-appt-package-amount-input"
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2 sm:px-5 sm:py-2.5">
              <Button variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, step: "visit" }))} data-testid="presales-appt-package-back">
                <ChevronLeft className="mr-1 h-4 w-4" />Back
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                {draft.visit_package?.manual && (
                  <Button
                    size="sm"
                    className="bg-sky-600 text-white hover:bg-sky-700"
                    onClick={() => {
                      if (!(Number(draft.visit_package_amount) > 0)) { toast.error("Enter the amount"); return; }
                      setDraft((d) => ({ ...d, step: "book" }));
                    }}
                    data-testid="presales-appt-package-continue"
                  >
                    Continue
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {booking && (<>
          <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            {/* 1 · Date */}
            <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[24rem] lg:overflow-y-auto lg:border-b-0 lg:border-r" data-testid="presales-appt-date-panel">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">1 · Date</p>
              <div className="mb-3 flex items-center justify-between">
                <button type="button" onClick={() => stepMonth(-1)} className="rounded p-1 hover:bg-slate-100" data-testid="presales-appt-prev-month">
                  <ChevronLeft className="h-5 w-5 text-slate-500" />
                </button>
                <h4 className="text-base font-bold text-slate-700">{MONTH_NAMES[month.m]} {month.y}</h4>
                <button type="button" onClick={() => stepMonth(1)} className="rounded p-1 hover:bg-slate-100" data-testid="presales-appt-next-month">
                  <ChevronRight className="h-5 w-5 text-slate-500" />
                </button>
              </div>
              <div className="mb-1 grid grid-cols-7 gap-1">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                  <div key={d} className="py-1 text-center text-xs font-semibold text-slate-400">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} className="h-11" />)}
                {Array.from({ length: daysInMonth }, (_, i) => {
                  const day = i + 1;
                  const dateStr = `${month.y}-${pad(month.m + 1)}-${pad(day)}`;
                  const isPast = dateStr < todayStr;
                  const isPicked = draft.appointment_date === dateStr;
                  const hasSlots = !isPast && (openDates[dateStr] || 0) > 0;
                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={isPast}
                      // Availability is per day, so a new date clears the consultant and time.
                      onClick={() => {
                        setDraft((d) => ({ ...d, appointment_date: dateStr, physio_id: "", appointment_time: "", duration: null }));
                        setTime({ h: "", m: "", ap: "AM" });
                      }}
                      className={`h-11 rounded-lg text-base font-semibold transition ${
                        isPicked
                          ? "bg-sky-500 text-white shadow-sm ring-2 ring-sky-300"
                          : isPast
                            ? "cursor-not-allowed text-slate-300"
                            : hasSlots
                              ? "bg-sky-200 text-sky-900 shadow-sm hover:bg-sky-300"
                              : dateStr === todayStr
                                ? "border border-sky-400 text-sky-700 hover:bg-sky-50"
                                : "text-slate-600 hover:bg-slate-100"
                      }`}
                      data-testid={`presales-appt-day-${day}`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-200" /> Available</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-500" /> Picked</span>
              </div>
            </div>

            {/* 2 · Consultant */}
            <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[20rem] lg:overflow-y-auto lg:border-b-0 lg:border-r" data-testid="presales-appt-expert-panel">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">2 · CONSULTANT</p>
              {!draft.appointment_date ? (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Pick a date first.</p>
              ) : experts.loading ? (
                <p className="text-sm text-slate-400">Checking availability...</p>
              ) : experts.experts.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">No CONSULTANT is available on this date.</p>
              ) : (
                <div className="space-y-1.5">
                  {experts.experts.map((doc) => {
                    const active = draft.physio_id === doc.id;
                    const open = doc.published_slot_count || 0;
                    return (
                      <button
                        key={doc.id}
                        type="button"
                        onClick={() => {
                          setDraft((d) => ({ ...d, physio_id: doc.id, appointment_time: "", duration: null }));
                          setTime({ h: "", m: "", ap: "AM" });
                        }}
                        className={`flex h-12 w-full items-center gap-2.5 rounded-[4px] border px-2.5 text-left transition ${active ? "border-sky-500 bg-sky-50" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"}`}
                        data-testid={`presales-appt-expert-${doc.id}`}
                      >
                        <EmployeeAvatar
                          employee={doc}
                          size={32}
                          fallbackClassName={active ? "bg-sky-600 text-white" : "bg-sky-100 text-sky-700"}
                          className={active ? "ring-2 ring-sky-500" : ""}
                        />
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{doc.full_name}</p>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-[4px] px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                            open > 0 ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"
                          }`}
                        >
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${open > 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
                          {open > 0 ? "Available" : "Not available"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3 · Time, typed as agreed with the patient. */}
            <div className="w-full flex-shrink-0 p-4 sm:p-5 lg:flex-1 lg:overflow-y-auto" data-testid="presales-appt-slot-panel">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">3 · Time</p>
              {!draft.physio_id ? (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Select a CONSULTANT to fix the time.</p>
              ) : !dayPublished ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="presales-appt-no-slots">
                  <p className="text-sm font-semibold text-amber-800">Not available on this date.</p>
                  <p className="mt-0.5 text-xs text-amber-700">Pick another date or CONSULTANT.</p>
                </div>
              ) : (
                <>
                  {dayBlocks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[4px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800" data-testid="presales-appt-available">
                      {dayBlocks.map(([a, b]) => (
                        <span key={a} className="whitespace-nowrap">
                          <b className="font-semibold">{shiftName(a)}</b> · {to12h(clockText(a))} – {to12h(clockText(b))}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-4">
                    <label className="mb-1.5 block text-xs font-semibold text-slate-600" htmlFor="presales-appt-hour">Appointment time</label>
                    <div className="flex items-center gap-2" data-testid="presales-appt-time-entry">
                      <input
                        id="presales-appt-hour"
                        type="text"
                        inputMode="numeric"
                        maxLength={2}
                        placeholder="7"
                        value={time.h}
                        onChange={(e) => setClock({ h: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                        className="h-12 w-16 rounded-[4px] border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                        data-testid="presales-appt-hour"
                      />
                      <span className="text-xl font-bold text-slate-400">:</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={2}
                        placeholder="15"
                        value={time.m}
                        onChange={(e) => setClock({ m: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                        className="h-12 w-16 rounded-[4px] border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                        data-testid="presales-appt-minute"
                      />
                      <div className="ml-1 flex overflow-hidden rounded-[4px] border border-slate-200">
                        {["AM", "PM"].map((half) => (
                          <button
                            key={half}
                            type="button"
                            onClick={() => setClock({ ap: half })}
                            className={`px-3 py-2.5 text-sm font-bold transition ${time.ap === half ? "bg-sky-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                            data-testid={`presales-appt-${half.toLowerCase()}`}
                          >
                            {half}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {clash && (
                    <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3" data-testid="presales-appt-clash">
                      <p className="text-sm font-semibold text-rose-800">
                        {to12h(draft.appointment_time)} runs into {to12h(clash.time)}{clash.lead_name ? ` — ${clash.lead_name}` : ""}.
                      </p>
                      <p className="mt-0.5 text-xs text-rose-700">Pick a different time.</p>
                    </div>
                  )}

                  {!clash && outsideHours && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="presales-appt-outside-hours">
                      <p className="text-sm font-semibold text-amber-800">{to12h(draft.appointment_time)} is outside the hours published for this day.</p>
                      {dayHours && <p className="mt-0.5 text-xs text-amber-700">{selectedExpert?.full_name} is down for {dayHours}.</p>}
                    </div>
                  )}

                  {/* The day as it already stands, so the desk can see what is free. */}
                  {daySlots.some((x) => x.booked) && (
                    <div className="mt-4" data-testid="presales-appt-booked-list">
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Already booked this day</p>
                      <ol className="divide-y divide-slate-200 overflow-hidden rounded-[4px] border border-slate-200 bg-slate-50">
                        {daySlots.filter((x) => x.booked).map((x, i) => (
                          <li key={`${x.slot_time}-${x.review_id || x.lead_id || i}`} className="flex items-center gap-2 px-3 py-2">
                            <span className="w-5 shrink-0 text-xs font-bold text-slate-400">{i + 1}.</span>
                            <span className="shrink-0 text-sm font-bold text-slate-600">
                              {to12h(x.time)}{durationRule ? ` – ${endTime12h(x.time, Number(x.duration) || slotMinutes)}` : ""}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
                              {(x.lead_name || "").trim() || "Booked"}
                              {x.review_id && <span className="ml-1 text-[11px] font-semibold text-slate-400">· Review</span>}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2 sm:px-5 sm:py-2.5">
            <Button variant="outline" size="sm" onClick={onClose} data-testid="presales-appt-cancel">Cancel</Button>
            <Button
              size="sm"
              className="bg-sky-600 text-white hover:bg-sky-700"
              disabled={!!clash || saving}
              onClick={submit}
              data-testid="presales-appt-save"
            >
              {saving ? "Booking…" : "Confirm"}
            </Button>
          </div>
        </>)}
      </div>
    </div>
  );
}

export default PreSalesAppointmentDialog;
