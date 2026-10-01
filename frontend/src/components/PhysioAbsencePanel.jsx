import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRightLeft, CalendarX, CheckCircle2, Clock, RefreshCw, Trash2, UserX, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import {
  listPhysioAbsences,
  markPhysioAbsent,
  physioAbsenceDetail,
  cancelPhysioAbsence,
  reassignAbsenceDay,
  releaseAbsenceDay,
} from "@/lib/api";
import { to12h } from "@/lib/time";

/**
 * A physio who will not be in on a date, and the patients booked with them that day.
 *
 * One panel for both desks. The physio marks themselves off (`mode="physio"`); the Branch
 * Admin marks any physio at the branch (`mode="branch"`). Either can then settle each
 * patient: hand the day to another physio who has the same hour open and a seat free, or
 * — if the patient would rather wait for their own physio — release it, which sends it to
 * Missed Classes for a new date. Handing over is refused until the patient has agreed:
 * who treats them is theirs to say.
 */

const pad2 = (n) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const longDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};
const timeOf = (slot) => (slot && slot.includes("T") ? to12h(slot.split("T")[1].slice(0, 5)) : "—");
const errText = (err, fallback) => err?.response?.data?.detail || fallback;

// One tone per state, used for the row's dot and its pill, so a state reads the same
// colour wherever it appears in the popup.
const STATE_BADGE = {
  waiting: { label: "Needs a plan", pill: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500" },
  reassigned: { label: "Handed over", pill: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500" },
  released: { label: "Waiting for new date", pill: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-400" },
  done: { label: "Done", pill: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
};

const initialOf = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

/**
 * Handing one patient's day to another physio, in a popup of its own.
 *
 * The pick, the patient's agreement and the Hand over button live together here rather
 * than open on every row: with a dozen patients on an absent day, a form per row buried
 * the list it was meant to work through. Each physio at the branch is a card, since the
 * seats free at this hour are the whole decision. The server sorts free first, fewest
 * booked first, so the top card is the natural pick; busy ones stay on the list with the
 * reason, so the desk can see that opening an hour is all it would take.
 */
function HandOverDialog({ absence, day, candidates, onClose, onDone }) {
  const [toId, setToId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const options = candidates || [];
  const picked = options.find((c) => c.id === toId);
  const hasFree = options.some((c) => c.available && c.id !== day.physio_id);

  const assign = async () => {
    if (!toId) { toast.error("Pick the physio who will see this patient"); return; }
    if (!confirmed) { toast.error(`Confirm with ${day.lead_name} that they are happy to see ${picked?.name || "another physio"}`); return; }
    setSaving(true);
    try {
      await reassignAbsenceDay(absence.id, day.track, day.id, { to_physio_id: toId, patient_confirmed: true, note });
      toast.success(`${day.lead_name} will see ${picked?.name || "the new physio"} at ${timeOf(day.slot_time)}`);
      onDone();
    } catch (err) {
      toast.error(errText(err, "Couldn't hand this day over"));
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-3 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5" data-testid={`absence-handover-${day.id}`}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600 ring-1 ring-inset ring-sky-100">
            <ArrowRightLeft className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {day.state === "reassigned" ? "Hand to someone else" : "Hand over"}
            </p>
            <h3 className="truncate text-lg font-semibold leading-tight text-slate-900">{day.lead_name}</h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1 font-medium tabular-nums text-slate-600">
                <Clock className="h-3 w-3" /> {timeOf(day.slot_time)}
              </span>
              <span className="text-slate-300">·</span>
              <span>{longDate(absence.date)}</span>
              <span className="text-slate-300">·</span>
              <span>{day.track === "rehab" ? "Rehab day" : "Day"} {day.session_number} of {day.total_sessions}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="-mr-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto border-t border-slate-100 px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Who covers {timeOf(day.slot_time)}?</p>
          {options.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3" role="radiogroup" data-testid={`absence-day-physio-${day.id}`}>
              {options.map((c) => {
                const current = c.id === day.physio_id;
                const selectable = c.available && !current;
                const selected = toId === c.id;
                const free = Math.max((c.capacity || 0) - (c.taken || 0), 0);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!selectable || saving}
                    onClick={() => { setToId(c.id); setConfirmed(false); }}
                    className={`flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                      selected
                        ? "border-sky-500 bg-sky-50 ring-2 ring-sky-200"
                        : selectable
                          ? "border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40"
                          : "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                    }`}
                    data-testid={`absence-day-physio-${day.id}-${c.id}`}
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      selected ? "bg-sky-600 text-white" : selectable ? "bg-sky-100 text-sky-700" : "bg-slate-200 text-slate-500"
                    }`}>
                      {selected ? <CheckCircle2 className="h-4 w-4" /> : initialOf(c.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-800">{c.name}</span>
                      <span className={`block truncate text-[11px] ${selectable ? "text-emerald-700" : "text-slate-500"}`}>
                        {current
                          ? "Covering now"
                          : c.available
                            ? `${free} seat${free === 1 ? "" : "s"} free · ${c.taken}/${c.capacity} booked`
                            : c.reason}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {options.length > 0 && !hasFree && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              No other physio has {timeOf(day.slot_time)} open with a free seat. Open it in MANAGEMENT → PHYSIO CALENDAR, or let the patient wait for a new date.
            </p>
          )}
          {options.length === 0 && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> No other physio at this branch.
            </p>
          )}

          {toId && (
            <>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={saving}
                  className="mt-0.5 h-3.5 w-3.5 accent-sky-600"
                  data-testid={`absence-day-confirm-${day.id}`}
                />
                <span>
                  I've spoken to <span className="font-semibold">{day.lead_name}</span> and they are happy to see{" "}
                  <span className="font-semibold">{picked?.name}</span> at {timeOf(day.slot_time)}.
                </span>
              </label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={saving}
                placeholder="Note (optional)"
                className="h-9 bg-white shadow-sm"
              />
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving} className="bg-white">Cancel</Button>
          <Button
            size="sm"
            onClick={assign}
            disabled={saving || !toId || !confirmed}
            className="bg-sky-600 text-white hover:bg-sky-700"
            data-testid={`absence-day-assign-${day.id}`}
          >
            <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" /> {saving ? "Handing over…" : "Hand over"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One patient's day on the absent date, and the two ways to settle it. */
function DayRow({ absence, day, candidates, onChanged }) {
  const [handingOver, setHandingOver] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [saving, setSaving] = useState(false);

  const settled = day.state === "done" || day.state === "released";
  const badge = STATE_BADGE[day.state] || STATE_BADGE.waiting;

  const release = async () => {
    if (!releaseReason.trim()) { toast.error("Say what the patient asked for"); return; }
    setSaving(true);
    try {
      await releaseAbsenceDay(absence.id, day.track, day.id, releaseReason.trim());
      toast.success(`${day.lead_name}'s day is in Missed Classes, waiting on a new date`);
      setReleasing(false); setReleaseReason("");
      onChanged();
    } catch (err) {
      toast.error(errText(err, "Couldn't release this day"));
    }
    setSaving(false);
  };

  return (
    <li
      className={`rounded-xl border bg-white transition-shadow ${
        day.state === "waiting" ? "border-amber-200 shadow-sm" : "border-slate-200"
      }`}
      data-testid={`absence-day-${day.id}`}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
          {initialOf(day.lead_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">{day.lead_name}</p>
            <span className="shrink-0 text-xs text-slate-400">
              {day.track === "rehab" ? "Rehab day" : "Day"} {day.session_number} of {day.total_sessions}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1 font-medium tabular-nums text-slate-600">
              <Clock className="h-3 w-3" /> {timeOf(day.slot_time)}
            </span>
            {day.state === "reassigned" && (
              <>
                <span className="text-slate-300">·</span>
                <span className="inline-flex min-w-0 items-center gap-1">
                  <ArrowRightLeft className="h-3 w-3 text-sky-500" />
                  Covered by <span className="truncate font-semibold text-slate-700">{day.physio_name}</span>
                </span>
              </>
            )}
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${badge.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          {badge.label}
        </span>
      </div>

      {!settled && !releasing && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
          <Button size="sm" variant="outline" onClick={() => setReleasing(true)} className="h-8 bg-white text-xs" data-testid={`absence-day-release-${day.id}`}>
            <Clock className="mr-1.5 h-3.5 w-3.5" /> Patient will wait
          </Button>
          <Button
            size="sm"
            onClick={() => setHandingOver(true)}
            className="h-8 bg-sky-600 text-xs text-white hover:bg-sky-700"
            data-testid={`absence-day-handover-${day.id}`}
          >
            <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" /> {day.state === "reassigned" ? "Change physio" : "Hand over"}
          </Button>
        </div>
      )}

      {!settled && releasing && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">What did the patient ask for?</label>
            <Input
              autoFocus
              value={releaseReason}
              onChange={(e) => setReleaseReason(e.target.value)}
              placeholder="e.g. wants to wait for their own physio"
              className="h-9 bg-white shadow-sm"
              data-testid={`absence-day-release-reason-${day.id}`}
            />
            <p className="mt-1.5 text-xs text-slate-500">
              The day comes off {longDate(absence.date)} and goes to Missed Classes for a new date. It stays part of the package.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { setReleasing(false); setReleaseReason(""); }} disabled={saving} className="h-8 bg-white text-xs">Back</Button>
            <Button size="sm" onClick={release} disabled={saving} className="h-8 bg-amber-600 text-xs text-white hover:bg-amber-700" data-testid={`absence-day-release-confirm-${day.id}`}>
              Release day
            </Button>
          </div>
        </div>
      )}

      {handingOver && (
        <HandOverDialog
          absence={absence}
          day={day}
          candidates={candidates}
          onClose={() => setHandingOver(false)}
          onDone={() => { setHandingOver(false); onChanged(); }}
        />
      )}
    </li>
  );
}

/** The worklist for one absence: every patient booked with the physio that day. */
function AbsenceDetail({ absenceId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await physioAbsenceDetail(absenceId));
    } catch (err) {
      toast.error(errText(err, "Couldn't load this absence"));
    }
    setLoading(false);
  }, [absenceId]);

  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onChanged(); };
  const days = data?.days || [];
  // Counted off the rows rather than the payload's counts, so the footer and the list above
  // it are the same pass over the same days.
  const counts = useMemo(() => {
    const out = { waiting: 0, reassigned: 0, released: 0, done: 0 };
    days.forEach((d) => { out[d.state in out ? d.state : "waiting"] += 1; });
    return out;
  }, [days]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-[2px] sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5" data-testid="physio-absence-detail">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pb-4 pt-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600 ring-1 ring-inset ring-rose-100">
            <UserX className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Physio absence</p>
            <h3 className="truncate text-lg font-semibold leading-tight text-slate-900">{data?.physio_name || "Physio"}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 font-medium text-rose-700 ring-1 ring-inset ring-rose-100">
                <CalendarX className="h-3 w-3" /> {longDate(data?.date) || "—"}
              </span>
              {data?.reason && <span className="truncate">{data.reason}</span>}
              <span className="truncate">Marked by <span className="font-medium text-slate-700">{data?.marked_by || "—"}</span></span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="-mr-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto border-t border-slate-200 px-5 py-4">
          {loading && !data ? (
            <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
          ) : days.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center">
              <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-200" />
              <p className="text-sm text-slate-400">No patients were booked with this physio on this day.</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {days.map((d) => (
                <DayRow
                  key={`${d.id}-${d.state}`}
                  absence={data}
                  day={d}
                  candidates={(data?.candidates || {})[d.slot_time]}
                  onChanged={changed}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-5 py-3">
          <p className="text-xs text-slate-400">
            {days.length > 0 && counts.waiting === 0 ? "Every patient has a plan for this day." : "Changes save as you make them."}
          </p>
          <Button variant="outline" size="sm" onClick={onClose} className="bg-white">Close</Button>
        </div>
      </div>
    </div>
  );
}

export function PhysioAbsencePanel({ mode = "branch", branchId = null }) {
  const isPhysio = mode === "physio";
  const [data, setData] = useState({ absences: [], physios: [] });
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ date: localToday(), physio_id: "", reason: "" });
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  // Which tile narrows the list: null for every absence, or a state whose patients the
  // absence must still have. Clicking the lit tile again clears it.
  const [filter, setFilter] = useState(null);
  const pickFilter = (f) => setFilter((cur) => (cur === f ? null : f));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The board's branch rides along: a Super Admin opening this board through
      // Operations has no branch of their own, and without it the server had no branch to
      // list physios from — the picker opened on an empty box.
      setData(await listPhysioAbsences(!isPhysio && branchId ? { branch_id: branchId } : undefined));
    } catch (err) {
      toast.error(errText(err, "Couldn't load absences"));
    }
    setLoading(false);
  }, [isPhysio, branchId]);

  useEffect(() => { load(); }, [load]);

  const absences = useMemo(() => data.absences || [], [data]);
  const totals = useMemo(() => absences.reduce((t, a) => ({
    waiting: t.waiting + (a.counts?.waiting || 0),
    reassigned: t.reassigned + (a.counts?.reassigned || 0),
    released: t.released + (a.counts?.released || 0),
  }), { waiting: 0, reassigned: 0, released: 0 }), [absences]);
  const shown = useMemo(
    () => (filter ? absences.filter((a) => (a.counts?.[filter] || 0) > 0) : absences),
    [absences, filter],
  );

  const submit = async () => {
    if (!form.date) { toast.error("Pick the date"); return; }
    if (!isPhysio && !form.physio_id) { toast.error("Pick the physio who is absent"); return; }
    setSaving(true);
    try {
      const created = await markPhysioAbsent({
        date: form.date,
        reason: form.reason,
        physio_id: isPhysio ? undefined : form.physio_id,
      });
      const n = created.days_total || 0;
      toast.success(n
        ? `Marked absent. ${n} patient${n === 1 ? "" : "s"} booked that day need${n === 1 ? "s" : ""} another physio or a new date.`
        : "Marked absent. Nobody was booked that day.");
      setForm((f) => ({ ...f, reason: "" }));
      await load();
      if (n) setOpenId(created.id);
    } catch (err) {
      toast.error(errText(err, "Couldn't mark absent"));
    }
    setSaving(false);
  };

  const cancel = async (a) => {
    const msg = a.counts?.reassigned
      ? `Cancel ${a.physio_name}'s absence on ${longDate(a.date)}? The ${a.counts.reassigned} day(s) handed to other physios go back to ${a.physio_name}.`
      : `Cancel ${a.physio_name}'s absence on ${longDate(a.date)}?`;
    if (!window.confirm(msg)) return;
    try {
      await cancelPhysioAbsence(a.id);
      toast.success("Absence cancelled");
      load();
    } catch (err) {
      toast.error(errText(err, "Couldn't cancel the absence"));
    }
  };

  return (
    <div className="space-y-4" data-testid={`physio-absence-panel-${mode}`}>
      {/* `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness, Review and Patients strips. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Absences" value={absences.length} sub="today and ahead" arrow color="#e11d48" active={filter === null} onClick={() => setFilter(null)} testid="physio-absence-tile-count" />
        <StatTile label="Need a plan" value={totals.waiting} sub="patients still booked" arrow color="#d97706" active={filter === "waiting"} onClick={() => pickFilter("waiting")} testid="physio-absence-tile-waiting" />
        <StatTile label="Handed over" value={totals.reassigned} sub="to another physio" arrow color="#0284c7" active={filter === "reassigned"} onClick={() => pickFilter("reassigned")} testid="physio-absence-tile-reassigned" />
        <StatTile label="Waiting" value={totals.released} sub="for a new date" arrow color="#64748b" active={filter === "released"} onClick={() => pickFilter("released")} testid="physio-absence-tile-released" />
      </div>

      {/* Mark absent */}
      <div className="rounded-xl border border-slate-200 bg-white p-4" data-testid="physio-absence-form">
        <p className="mb-3 text-sm font-semibold text-slate-700">
          {isPhysio ? "Mark yourself absent" : "Mark a physio absent"}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {!isPhysio && (
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Physio
              <Select
                value={form.physio_id}
                onValueChange={(v) => setForm((f) => ({ ...f, physio_id: v }))}
              >
                <SelectTrigger
                  className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-800 shadow-none hover:bg-slate-50 focus:ring-2 focus:ring-sky-200"
                  data-testid="physio-absence-physio"
                >
                  <SelectValue placeholder="Pick a physio…" />
                </SelectTrigger>
                <SelectContent className="max-h-72 border-slate-200">
                  {(data.physios || []).map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-sm text-slate-700">{p.name}</SelectItem>
                  ))}
                  {!(data.physios || []).length && (
                    <p className="px-2 py-3 text-center text-xs text-slate-400">
                      {loading ? "Loading…" : "No physios at this branch"}
                    </p>
                  )}
                </SelectContent>
              </Select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Date
            <MilkDateInput
              min={localToday()}
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              accent="sky"
              iconLeft
              className="h-10 border-slate-200 bg-white font-normal normal-case tracking-normal sm:w-44"
              data-testid="physio-absence-date"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Reason
            <Input
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. unwell, family function"
              className="h-10"
              data-testid="physio-absence-reason"
            />
          </label>
          <Button onClick={submit} disabled={saving} className="h-10 bg-rose-600 text-white hover:bg-rose-700" data-testid="physio-absence-submit">
            <CalendarX className="mr-1.5 h-4 w-4" /> Mark Absent
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Every patient booked on an absent day needs another physio or a new date, agreed with the patient.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} className="shrink-0" data-testid="physio-absence-refresh">
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-14 text-center" data-testid="physio-absence-empty">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-200" />
          <p className="text-sm text-slate-400">
            {loading ? "Loading…" : absences.length === 0 ? "No absences marked from today on." : "No absences match this card."}
          </p>
          {!loading && filter && absences.length > 0 && (
            <button type="button" onClick={() => setFilter(null)} className="mt-2 text-xs font-medium text-sky-700 hover:underline">
              Show all absences
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2" data-testid="physio-absence-list">
          {shown.map((a) => {
            const waiting = a.counts?.waiting || 0;
            return (
              <div key={a.id} className={`flex flex-col gap-3 rounded-xl border bg-white p-3 sm:flex-row sm:items-center ${waiting ? "border-amber-200" : "border-slate-200"}`} data-testid={`physio-absence-row-${a.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">
                    {longDate(a.date)}{!isPhysio && <span className="font-medium text-slate-500"> · {a.physio_name}</span>}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {a.reason ? `${a.reason} · ` : ""}marked by {a.marked_by}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                    {a.days_total === 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">No patients booked</span>}
                    {waiting > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">{waiting} need a plan</span>}
                    {a.counts?.reassigned > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-700">{a.counts.reassigned} handed over</span>}
                    {a.counts?.released > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{a.counts.released} waiting for new date</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => cancel(a)} className="text-rose-600" data-testid={`physio-absence-cancel-${a.id}`}>
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setOpenId(a.id)}
                    className={waiting ? "bg-amber-600 text-white hover:bg-amber-700" : "bg-slate-600 text-white hover:bg-slate-700"}
                    data-testid={`physio-absence-open-${a.id}`}
                  >
                    <Users className="mr-1 h-3.5 w-3.5" /> {waiting ? "Assign patients" : "View patients"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openId && <AbsenceDetail absenceId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

export default PhysioAbsencePanel;
