import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronDown, Clock, Loader2, Plus, RefreshCw, Save, Salad, Stethoscope, Activity, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { ShiftPickerModal } from "@/components/ui/shift-picker";
import { toast } from "@/components/ui/sonner";
import {
  createShift,
  deleteShift,
  getAttendanceRules,
  getShiftRoster,
  listShifts,
  saveAttendanceRules,
  setDoctorShift,
  updateShift,
} from "@/lib/api";
import { to12h } from "@/lib/time";
import { announceShiftsChanged, hoursLabel, onShiftsChanged, shiftIdsOf } from "@/lib/shifts";

/**
 * TIME MANAGEMENT — the hours the branch runs, and who works which of them.
 *
 * A calendar used to be opened across one fixed window for everybody (8 AM to 10 PM),
 * which is not how the floor works: a morning physio leaves at 2 and an evening consultant
 * only starts at 3. Publishing a 9 PM slot for either offers a patient a time nobody will
 * be there for.
 *
 * So a window gets a name — Morning, Evening, Online, Full Time — and an expert gets put on
 * one. From then on their CONSULTANT / PHYSIO / DIET calendar is cut across exactly those
 * hours: pick Yamini on Morning here, and her day opens 7 AM – 2 PM over there.
 *
 * An expert can be put on more than one, because a split day is ordinary on this floor: the
 * consultant who works 8 AM – 1 PM, goes home, and is back 5 PM – 9 PM is on a morning and
 * an evening. Both halves open and the afternoon between them stays closed — which is the
 * whole point, since a single 8-to-9 shift would offer patients every hour they are away.
 *
 * The four seeded shifts are a starting point, not a rule — name and both ends are editable
 * and a branch can add its own, because every clinic keeps its own hours.
 *
 * Changing a shift never touches slots already published. It governs the days opened from
 * then on, so a patient booked into a 6 PM slot keeps it when the physio moves to mornings;
 * closing that day down is the Unsave button on the calendar, deliberately a separate act.
 *
 * Below the shifts sits the other kind of hours this branch keeps: the WORKING DAY its
 * staff are due on, and the days it is closed. That one has nothing to do with patient
 * bookings — it is what HR's attendance register reads to decide who was late and who was
 * absent — and it is a section of its own for exactly that reason.
 */

// The three calendars this rosters, in the order MANAGEMENT lists them. `profile_type` is
// what the backend keys experts on — the same value each calendar tab passes.
const CALENDAR_KINDS = [
  { key: "head_physio", label: "Consultant Calendar", short: "Consultant", icon: Stethoscope, noun: "CONSULTANT", plural: "CONSULTANTS" },
  { key: "physio", label: "Physio Calendar", short: "Physio", icon: Activity, noun: "Physio", plural: "Physios" },
  { key: "nutrition_coach", label: "Diet Calendar", short: "Diet", icon: Salad, noun: "Nutritionist", plural: "Nutritionists" },
];

const NEW_SHIFT = { name: "", start_time: "09:00", end_time: "18:00" };

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
};

/** "07:00"–"14:00" -> "7 hrs". The length of the working day, in the card's own words. */
const spanLabel = (start, end) => {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || to <= from) return "—";
  const mins = to - from;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs ? `${hrs} hr${hrs > 1 ? "s" : ""}` : ""}${rem ? `${hrs ? " " : ""}${rem} min` : ""}` || "—";
};

const windowLabel = (start, end) => `${to12h(start)} – ${to12h(end)}`;

/** One editable shift. Kept local until Save, so a half-typed time never reaches the API. */
function ShiftCard({ shift, onSaved, onDeleted }) {
  const [draft, setDraft] = useState({ name: shift.name, start_time: shift.start_time, end_time: shift.end_time });
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Re-sync when the list reloads under it (another edit saved, or a refresh), otherwise
  // the card would keep showing values the server no longer holds.
  useEffect(() => {
    setDraft({ name: shift.name, start_time: shift.start_time, end_time: shift.end_time });
  }, [shift.id, shift.name, shift.start_time, shift.end_time]);

  const dirty = draft.name !== shift.name || draft.start_time !== shift.start_time || draft.end_time !== shift.end_time;
  const from = minutesOf(draft.start_time);
  const to = minutesOf(draft.end_time);
  const invalid = !draft.name.trim() || from === null || to === null || to <= from;

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      const updated = await updateShift(shift.id, {
        name: draft.name.trim(),
        start_time: draft.start_time,
        end_time: draft.end_time,
      });
      toast.success(`${updated.name}: ${windowLabel(updated.start_time, updated.end_time)}`);
      await onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the shift");
    }
    setSaving(false);
  };

  const remove = async () => {
    if (!window.confirm(`Delete the ${shift.name} shift? Anyone on it goes back to no shift.`)) return;
    setRemoving(true);
    try {
      const res = await deleteShift(shift.id);
      toast.success(
        `${shift.name} deleted`
        + (res?.unassigned ? ` · ${res.unassigned} expert${res.unassigned > 1 ? "s" : ""} taken off it` : ""),
      );
      await onDeleted();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete the shift");
    }
    setRemoving(false);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`shift-card-${shift.id}`}>
      <div className="flex items-center gap-2">
        <Input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className="h-8 flex-1 text-sm font-semibold"
          placeholder="Shift name"
          data-testid={`shift-name-${shift.id}`}
        />
        <button
          type="button"
          onClick={remove}
          disabled={removing}
          title="Delete this shift"
          className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500 md:text-slate-300"
          data-testid={`shift-delete-${shift.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 24-hour inputs on purpose — an <input type="time"> hands back "HH:MM" whatever the
          browser displays, which is exactly what the API stores. The 12-hour reading sits
          underneath, because that is how the clinic says it out loud. */}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="time"
          value={draft.start_time}
          onChange={(e) => setDraft((d) => ({ ...d, start_time: e.target.value }))}
          className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
          data-testid={`shift-start-${shift.id}`}
        />
        <span className="shrink-0 text-xs text-slate-400">to</span>
        <input
          type="time"
          value={draft.end_time}
          onChange={(e) => setDraft((d) => ({ ...d, end_time: e.target.value }))}
          className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
          data-testid={`shift-end-${shift.id}`}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`min-w-0 truncate text-[11px] ${invalid ? "text-rose-500" : "text-slate-400"}`}>
          {invalid
            ? (!draft.name.trim() ? "Name it first" : "Must end after it starts")
            : `${windowLabel(draft.start_time, draft.end_time)} · ${spanLabel(draft.start_time, draft.end_time)}`}
        </p>
        {dirty && (
          <Button
            size="sm"
            onClick={save}
            disabled={saving || invalid}
            className="h-7 shrink-0 bg-violet-600 px-2.5 text-[11px] text-white hover:bg-violet-700"
            data-testid={`shift-save-${shift.id}`}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Save className="mr-1 h-3 w-3" /> Save</>}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * THE WORKING DAY — when staff are expected in, and which days the branch is closed.
 *
 * Deliberately not a shift. A shift is when patients may be booked with an expert; this is
 * when the people who work here are due, and it is what HR's attendance register reads to
 * decide whether somebody was on time, half a day, or absent. The two sit on one screen
 * because a Branch Admin thinks of both as "our hours", and in two sections because
 * confusing them would put a physio's booking window onto somebody's payslip.
 *
 * What it changes is worth being plain about, and the panel says so on screen: attendance
 * is read off these rules rather than stored against them, so moving the week off to
 * Tuesday re-reads every Tuesday this month as a rest day and every Sunday back into a
 * working day. Any day HR marked by hand is untouched either way — a decision always beats
 * a reading. See backend/attendance_rules.py.
 */
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const RuleField = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
    {children}
    {hint && <span className="mt-1 hidden text-[10px] leading-snug text-slate-400 md:block">{hint}</span>}
  </label>
);

const WorkingDayCard = ({ branchId }) => {
  const [rules, setRules] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!branchId) return undefined;
    let cancelled = false;
    setLoading(true);
    getAttendanceRules(branchId)
      .then((r) => { if (!cancelled) setRules(r.rules); })
      .catch((e) => { if (!cancelled) toast.error(e?.response?.data?.detail || "Could not read the working day"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [branchId]);

  const set = (patch) => setRules((r) => ({ ...r, ...patch }));

  // A day is toggled rather than picked from a list: the question is "is the branch closed
  // on this day", which is seven yes/no answers, and a multi-select would make the common
  // case (one day, Sunday) two clicks and a scroll.
  const toggleDay = (index) => {
    const on = rules.week_offs || [];
    set({ week_offs: on.includes(index) ? on.filter((d) => d !== index) : [...on, index].sort((a, b) => a - b) });
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveAttendanceRules(branchId, {
        work_start: rules.work_start,
        work_end: rules.work_end,
        grace_minutes: Number(rules.grace_minutes || 0),
        half_day_minutes: Number(rules.half_day_minutes || 0),
        week_offs: rules.week_offs || [],
      });
      setRules(saved.rules);
      toast.success("Working day saved — the attendance register reads it from now on");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save the working day");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !rules) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-3 md:p-4" data-testid="working-day-loading">
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the working day…
        </p>
      </section>
    );
  }

  const offDays = rules.week_offs || [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white" data-testid="working-day-card">
      <div className="border-b border-slate-100 bg-slate-50/60 p-3 md:p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <CalendarDays className="h-4 w-4 shrink-0 text-emerald-500" /> Working Day &amp; Week Off
        </h3>
        <p className="mt-1 hidden text-[11px] text-slate-400 md:block">
          When your staff are due in, and which days you are closed. HR&apos;s attendance register reads this to
          decide who was on time, who was half a day and who was absent — this is not the patient booking window above.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-4 md:p-4">
        <RuleField label="Day starts">
          <input
            type="time"
            value={rules.work_start || ""}
            onChange={(e) => set({ work_start: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
            data-testid="working-day-start"
          />
        </RuleField>
        <RuleField label="Day ends">
          <input
            type="time"
            value={rules.work_end || ""}
            onChange={(e) => set({ work_end: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
            data-testid="working-day-end"
          />
        </RuleField>
        <RuleField label="Grace" hint="Minutes after the start that still count as on time.">
          <input
            type="number"
            min={0}
            max={120}
            value={rules.grace_minutes ?? 0}
            onChange={(e) => set({ grace_minutes: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
            data-testid="working-day-grace"
          />
        </RuleField>
        <RuleField label="Half day under" hint="Hours actually worked, breaks already taken off.">
          <input
            type="number"
            min={0}
            max={12}
            step={0.5}
            value={Number(rules.half_day_minutes || 0) / 60}
            onChange={(e) => set({ half_day_minutes: Math.round(Number(e.target.value || 0) * 60) })}
            className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
            data-testid="working-day-halfday"
          />
        </RuleField>
      </div>

      <div className="border-t border-slate-100 px-3 pb-3 pt-3 md:px-4 md:pb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Week off</p>
        <p className="mt-0.5 hidden text-[10px] text-slate-400 md:block">
          Days nobody at this branch is expected in. They are never counted absent and never cost pay.
        </p>
        {/* All seven in one row on a phone, where 56px buttons wrapped Sunday (and more)
            onto a line of its own. */}
        <div className="mt-2 grid grid-cols-7 gap-1 md:flex md:flex-wrap md:gap-1.5" data-testid="working-day-week-offs">
          {DAY_LABELS.map((label, index) => {
            const off = offDays.includes(index);
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggleDay(index)}
                className={`h-9 w-full min-w-0 rounded-md border text-xs font-semibold transition md:w-14 ${
                  off
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:bg-emerald-50"
                }`}
                data-testid={`working-day-off-${index}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {offDays.length === 0 && (
          <p className="mt-2 text-[11px] font-medium text-amber-600" data-testid="working-day-no-off">
            No day off selected — every day of the week will be counted as a working day.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-3 md:px-4">
        <p className="hidden max-w-lg text-[11px] text-slate-400 md:block">
          Saving applies to days already past as well as days to come: attendance is read from these rules, not
          frozen against them. Anything HR marked by hand on the register stays exactly as they marked it.
        </p>
        <Button
          size="sm"
          onClick={save}
          disabled={saving}
          className="h-9 w-full shrink-0 bg-emerald-600 text-xs text-white hover:bg-emerald-700 md:h-8 md:w-auto"
          data-testid="working-day-save"
        >
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          Save working day
        </Button>
      </div>
    </section>
  );
};

export const TimeManagementPanel = ({ branchId }) => {
  const [shifts, setShifts] = useState([]);
  const [profileType, setProfileType] = useState("head_physio");
  const [experts, setExperts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rosterLoading, setRosterLoading] = useState(false);
  // Which expert's dropdown is mid-save — the row shows a spinner rather than the whole
  // list blanking, since several can be rostered one after another.
  const [assigning, setAssigning] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newShift, setNewShift] = useState(NEW_SHIFT);
  const [creating, setCreating] = useState(false);
  // The expert whose shifts are open in the picker. A dialog rather than a dropdown,
  // because the question is now "which windows", and a native multi-select is the one
  // control nobody can tell is multi.
  const [picking, setPicking] = useState(null);

  const kind = CALENDAR_KINDS.find((k) => k.key === profileType) || CALENDAR_KINDS[0];

  const loadShifts = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await listShifts(branchId);
      setShifts(data?.shifts || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load the shifts");
    }
  }, [branchId]);

  const loadRoster = useCallback(async () => {
    if (!branchId) return;
    setRosterLoading(true);
    try {
      const data = await getShiftRoster(branchId, profileType);
      setExperts(data?.experts || []);
    } catch {
      setExperts([]);
    }
    setRosterLoading(false);
  }, [branchId, profileType]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadShifts().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadShifts]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  // A shift edited from a calendar lands here without a reload, and the other way round.
  useEffect(
    () => onShiftsChanged(branchId, "time-management", () => { loadShifts(); loadRoster(); }),
    [branchId, loadShifts, loadRoster],
  );
  const reloadAndAnnounce = async () => {
    await Promise.all([loadShifts(), loadRoster()]);
    announceShiftsChanged(branchId, "time-management");
  };

  const assign = async (expert, shiftIds) => {
    setAssigning(expert.id);
    try {
      const updated = await setDoctorShift(expert.id, shiftIds);
      // Read back off what the server resolved, not off what was ticked: two windows that
      // overlap come back merged into one, and the branch should be told the day they
      // actually got rather than the two they picked.
      const hours = hoursLabel({ segments: updated.shift_windows, start_time: updated.shift_start, end_time: updated.shift_end });
      toast.success(
        updated.shift_id
          ? `${expert.full_name} works ${updated.shift_name} · ${hours}`
          : `${expert.full_name} taken off their shift`,
      );
      setPicking(null);
      await loadRoster();
      announceShiftsChanged(branchId, "time-management");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't set the shift");
    }
    setAssigning(null);
  };

  const create = async () => {
    const from = minutesOf(newShift.start_time);
    const to = minutesOf(newShift.end_time);
    if (!newShift.name.trim()) { toast.error("Give the shift a name"); return; }
    if (from === null || to === null || to <= from) { toast.error("The shift must end after it starts"); return; }
    setCreating(true);
    try {
      const created = await createShift(branchId, { ...newShift, name: newShift.name.trim() });
      toast.success(`${created.name} added · ${windowLabel(created.start_time, created.end_time)}`);
      setNewShift(NEW_SHIFT);
      setAdding(false);
      await loadShifts();
      announceShiftsChanged(branchId, "time-management");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't add the shift");
    }
    setCreating(false);
  };

  // A CONSULTANT is org-wide — one record taking consultations at any branch — so a shift
  // on them may have been defined by another branch. Offer those alongside this branch's
  // own rather than showing a picker with no option behind a window it is displaying.
  const foreignOptions = useMemo(() => {
    const known = new Set(shifts.map((s) => s.id));
    return (expert) =>
      (expert.shift_windows || [])
        .filter((w) => w.shift_id && !known.has(w.shift_id))
        .map((w) => ({
          id: w.shift_id,
          label: `${w.shift_name || "Shift"} (another branch)`,
          hint: windowLabel(w.start_time, w.end_time),
        }));
  }, [shifts]);

  const rostered = experts.filter((e) => e.shift_id).length;

  return (
    // Below md (phones, the user's ~720px one included) every caption on this screen is
    // dropped and the padding tightens, so the controls themselves fill the card. From md
    // up nothing changes.
    <div className="flex flex-col gap-3 md:gap-4" data-testid="time-management-root">
      {/* ------------------------------------------------- The windows themselves */}
      <section className="rounded-xl border border-slate-200 bg-white" data-testid="shift-definitions">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 p-3 md:flex-wrap md:p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Clock className="h-4 w-4 shrink-0 text-violet-500" /> Shift Timings
            </h3>
            <p className="mt-1 hidden text-[11px] text-slate-400 md:block">
              The hours this branch runs. Rename them or move either end — a calendar is only ever opened across the shift its expert is on.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={loadShifts} className="h-8 w-8 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600 md:h-9 md:w-9" title="Refresh" aria-label="Refresh" data-testid="shifts-refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              onClick={() => setAdding((v) => !v)}
              className="h-8 bg-violet-600 text-xs text-white hover:bg-violet-700"
              data-testid="shift-add-toggle"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add Shift
            </Button>
          </div>
        </div>

        <div className="p-3 md:p-4">
          {adding && (
            <div className="mb-3 rounded-xl border border-dashed border-violet-300 bg-violet-50/40 p-3" data-testid="shift-add-form">
              {/* A phone gets three even rows — name, start to end, Add beside Cancel — where
                  the wrapping row left the times and buttons scattered at whatever width
                  each happened to need. md:contents hands the buttons back to the one row. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 md:flex md:flex-wrap">
                <Input
                  value={newShift.name}
                  onChange={(e) => setNewShift((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Shift name (e.g. Late Evening)"
                  className="col-span-3 h-8 text-sm md:min-w-[10rem] md:flex-1"
                  data-testid="shift-new-name"
                />
                <input
                  type="time"
                  value={newShift.start_time}
                  onChange={(e) => setNewShift((s) => ({ ...s, start_time: e.target.value }))}
                  className="h-8 w-full min-w-0 rounded-md border border-slate-200 px-2 text-sm text-slate-700 md:w-auto"
                  data-testid="shift-new-start"
                />
                <span className="text-xs text-slate-400">to</span>
                <input
                  type="time"
                  value={newShift.end_time}
                  onChange={(e) => setNewShift((s) => ({ ...s, end_time: e.target.value }))}
                  className="h-8 w-full min-w-0 rounded-md border border-slate-200 px-2 text-sm text-slate-700 md:w-auto"
                  data-testid="shift-new-end"
                />
                <div className="col-span-3 grid grid-cols-2 gap-2 md:contents">
                  <Button size="sm" onClick={create} disabled={creating} className="h-8 bg-violet-600 text-xs text-white hover:bg-violet-700" data-testid="shift-new-save">
                    {creating ? "Adding..." : "Add"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setAdding(false); setNewShift(NEW_SHIFT); }} className="h-8 text-xs">
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <p className="py-6 text-center text-xs text-slate-400">Loading shifts…</p>
          ) : shifts.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">No shifts yet — add one above.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="shift-list">
              {shifts.map((s) => (
                <ShiftCard key={s.id} shift={s} onSaved={reloadAndAnnounce} onDeleted={reloadAndAnnounce} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------- Who works which of them */}
      <section className="rounded-xl border border-slate-200 bg-white" data-testid="shift-roster">
        <div className="border-b border-slate-100 bg-slate-50/60 p-3 md:p-4">
          <div className="flex items-center justify-between gap-2 md:flex-wrap">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                <kind.icon className="h-4 w-4 shrink-0 text-violet-500" /> Who Works Which Shift
              </h3>
              <p className="mt-1 hidden text-[11px] text-slate-400 md:block">
                Pick the calendar, then put each {kind.noun} on a shift — or on two, for a morning
                and an evening. Their day on {kind.label} opens across those hours only, and stays
                closed in between.
              </p>
            </div>
            {experts.length > 0 && (
              <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700" data-testid="roster-count">
                {rostered} of {experts.length} rostered
              </span>
            )}
          </div>
          <div className="mt-3">
            <SegmentedTabs
              tabs={CALENDAR_KINDS}
              value={profileType}
              onChange={setProfileType}
              mobileCols={3}
              testid="roster-calendar-kind"
            />
          </div>
        </div>

        <div className="divide-y divide-slate-100" data-testid="roster-list">
          {rosterLoading ? (
            <p className="py-8 text-center text-xs text-slate-400">Loading {kind.plural.toLowerCase()}…</p>
          ) : experts.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-400">
              No {kind.plural} {profileType === "head_physio" ? "created" : "assigned to this branch"} yet — ask HR Admin to add one.
            </p>
          ) : (
            experts.map((expert) => (
              // A phone lays the row out as a grid: name across from the shift button, the
              // hours chip under the name. Wrapped as a flex row it dropped the chip and the
              // button onto lines of their own at whatever width each needed. The placement
              // classes are inert from md up, where the row is the one flex line again.
              <div key={expert.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-3 md:flex md:flex-wrap md:gap-3" data-testid={`roster-row-${expert.id}`}>
                <div className="row-span-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600">
                  {expert.full_name?.charAt(0)?.toUpperCase() || "E"}
                </div>
                <div className="col-start-2 row-start-1 min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{expert.full_name}</p>
                  <p className="truncate text-[10px] text-slate-400 md:whitespace-normal">
                    {expert.specialization || kind.noun}
                    {expert.slots_open > 0 && ` · ${expert.slots_open} slot${expert.slots_open > 1 ? "s" : ""} already published`}
                  </p>
                </div>
                {/* The hours they will get, stated in full — the control says the names,
                    this says what it means for their day. Both halves of a split day are
                    written out: "8:00 AM – 9:00 PM" for a morning-and-evening consultant
                    would be a working day they do not work. */}
                <span
                  className={`col-span-2 col-start-2 row-start-2 justify-self-start shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold md:whitespace-nowrap ${
                    expert.shift_id ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"
                  }`}
                  data-testid={`roster-window-${expert.id}`}
                >
                  {expert.shift_id
                    ? hoursLabel({ segments: expert.shift_windows, start_time: expert.shift_start, end_time: expert.shift_end })
                    : "Full day (no shift)"}
                </span>
                <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2">
                  {assigning === expert.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />}
                  <button
                    type="button"
                    onClick={() => setPicking(expert)}
                    disabled={assigning === expert.id}
                    className="flex max-w-[9rem] items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 md:max-w-[15rem]"
                    title="The working windows this expert's day is opened across"
                    data-testid={`roster-select-${expert.id}`}
                  >
                    <span className="min-w-0 truncate">
                      {expert.shift_name || "No shift — full day"}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="hidden border-t border-slate-100 px-4 py-3 text-[11px] text-slate-400 md:block">
          Moving someone to another shift changes the days opened from now on. Slots already published stay
          as they are — close them from <b>{kind.label} → Unsave</b>, so a patient's booked time is never
          dropped by a settings change.
        </p>
      </section>

      {/* Which windows one expert works, as a dialog. The list is a set of ticks rather
          than a one-of-many, because a morning and an evening is one person's day. */}
      {picking && (
        <ShiftPickerModal
          title={`Shifts for ${picking.full_name}`}
          shifts={shifts}
          extraOptions={foreignOptions(picking)}
          value={shiftIdsOf(picking)}
          saving={assigning === picking.id}
          onSave={(ids) => assign(picking, ids)}
          onClose={() => setPicking(null)}
        />
      )}

      {/* Last, because it is set once and then left alone, where the two above are worked
          with. It is also the only thing on this screen that reaches somebody's pay. */}
      <WorkingDayCard branchId={branchId} />
    </div>
  );
};

export default TimeManagementPanel;
