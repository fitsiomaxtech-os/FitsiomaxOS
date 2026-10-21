import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Pencil, Users } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { ClockDurationDialog, durationLabel } from "@/components/ui/clock-time-input";
import { CreamPicker } from "@/components/ui/cream-picker";
import { getCalendarExperts, listStoreItems, setDoctorSlotCapacity, setDoctorSlotDuration } from "@/lib/api";
import { pickStoreMinutes } from "@/lib/sessionLength";

const FALLBACK_SLOT_MINUTES = 30;
const DEFAULT_CAPACITY = 3;
const CAPACITY_OPTIONS = [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} patient${n > 1 ? "s" : ""}` }));

/**
 * The two settings the Physiotherapist Calendar's header carries per physio — Treatment
 * Session Duration and Per slot — laid out for every physio on the branch at once, as tabs
 * of the calendar's gear beside Time Management. The header keeps its own pair for the
 * physio being published; this is the place to set them across the floor in one sitting.
 *
 * `mode` is "duration" or "capacity". The same endpoints the header uses, so a change here
 * is the change the calendar and Assign Physio's picker read.
 */
export const PhysioSessionSettings = ({ branchId, mode }) => {
  const [physios, setPhysios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [storeMinutes, setStoreMinutes] = useState(FALLBACK_SLOT_MINUTES);
  // The physio whose length is on the clock dialog, or "all" for every one of them.
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const rows = await getCalendarExperts(branchId, "physio");
      setPhysios((rows || []).slice().sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")));
    } catch {
      setPhysios([]);
    }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    listStoreItems(undefined, "session")
      .then((items) => {
        const configured = pickStoreMinutes(items);
        if (!cancelled && configured) setStoreMinutes(configured);
      })
      .catch(() => { /* keep the fallback */ });
    return () => { cancelled = true; };
  }, []);

  const patch = (ids, fields) =>
    setPhysios((all) => all.map((p) => (ids.includes(p.id) ? { ...p, ...fields } : p)));

  // null clears a physio's own length, so they follow FITSIO STORE again.
  const saveDuration = async (minutes) => {
    const target = editing;
    setEditing(null);
    const ids = target === "all" ? physios.map((p) => p.id) : [target];
    if (!ids.length) return;
    setBusy(target);
    try {
      await Promise.all(ids.map((id) => setDoctorSlotDuration(id, minutes)));
      patch(ids, { slot_duration_minutes: minutes });
      const who = target === "all" ? "Every physio" : physios.find((p) => p.id === target)?.full_name || "Physio";
      toast.success(minutes
        ? `${who} now runs ${durationLabel(minutes)} sessions`
        : `${who} back on FITSIO STORE's ${durationLabel(storeMinutes)}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the session length");
      load();
    }
    setBusy(null);
  };

  // Lowering this never evicts anyone, as on the header: a slot over the new number keeps
  // its bookings and only stops taking more.
  const saveCapacity = async (target, n) => {
    const ids = target === "all" ? physios.map((p) => p.id) : [target];
    if (!ids.length) return;
    setBusy(target);
    try {
      await Promise.all(ids.map((id) => setDoctorSlotCapacity(id, n)));
      patch(ids, { slot_capacity: n });
      const who = target === "all" ? "Every physio" : physios.find((p) => p.id === target)?.full_name || "Physio";
      toast.success(`${who} now takes ${n} patient${n > 1 ? "s" : ""} per slot`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the slot capacity");
      load();
    }
    setBusy(null);
  };

  const isDuration = mode === "duration";
  const own = (p) => Number(p.slot_duration_minutes) || null;
  const editingPhysio = editing && editing !== "all" ? physios.find((p) => p.id === editing) : null;

  return (
    <div className="space-y-3" data-testid={`physio-session-settings-${mode}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            {isDuration ? <Clock className="h-4 w-4 text-sky-600" /> : <Users className="h-4 w-4 text-sky-600" />}
            {isDuration ? "Treatment Session Duration" : "Patients per slot"}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {isDuration
              ? `How long one session runs on each physio's calendar. Unset follows FITSIO STORE's ${durationLabel(storeMinutes)}. Only days opened after a change are cut at it.`
              : "How many patients each physio treats in the same slot — up to 4. Lowering it never moves anyone already booked."}
          </p>
        </div>
        {physios.length > 1 && (isDuration ? (
          <button
            type="button"
            onClick={() => setEditing("all")}
            disabled={!!busy}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 text-xs font-semibold text-sky-700 transition hover:bg-sky-100 disabled:opacity-60"
            data-testid="physio-duration-all"
          >
            {busy === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
            Set for all physios
          </button>
        ) : (
          <CreamPicker
            value={null}
            onChange={(n) => saveCapacity("all", n)}
            options={CAPACITY_OPTIONS}
            icon={Users}
            label="Set for all physios"
            align="end"
            width="w-44"
            disabled={!!busy}
            testid="physio-capacity-all"
          />
        ))}
      </div>

      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {loading ? (
          <p className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading physios…
          </p>
        ) : physios.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-slate-400">
            No Physiotherapists on this branch's team yet — add them in MANAGEMENT → MANAGER → TEAM.
          </p>
        ) : physios.map((p) => {
          const mins = own(p);
          const cap = p.slot_capacity ?? DEFAULT_CAPACITY;
          return (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5" data-testid={`physio-setting-row-${p.id}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                {p.full_name?.charAt(0)?.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{p.full_name}</p>
                <p className="truncate text-[11px] text-slate-400">
                  {isDuration
                    ? (mins ? "Own length" : "From FITSIO STORE")
                    : `${cap} patient${cap > 1 ? "s" : ""} in the same slot`}
                </p>
              </div>
              {isDuration ? (
                <button
                  type="button"
                  onClick={() => setEditing(p.id)}
                  disabled={!!busy}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#EFEAE0] bg-[#FDFCF8] px-3 text-sm text-slate-500 transition hover:bg-[#F3EFE6] disabled:opacity-60"
                  title={mins ? "Set for this physio — tap to change" : "From FITSIO STORE — tap to set this physio's own length"}
                  data-testid={`physio-duration-edit-${p.id}`}
                >
                  {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : <Clock className="h-3.5 w-3.5 text-slate-400" />}
                  <span className="font-bold text-sky-700">{durationLabel(mins || storeMinutes)}</span>
                  <Pencil className="h-3 w-3 text-slate-400" />
                </button>
              ) : (
                <CreamPicker
                  value={cap}
                  onChange={(n) => saveCapacity(p.id, n)}
                  options={CAPACITY_OPTIONS}
                  icon={Users}
                  prefix="Per slot"
                  label={String(cap)}
                  set
                  align="end"
                  width="w-44"
                  disabled={!!busy}
                  testid={`physio-capacity-${p.id}`}
                />
              )}
            </div>
          );
        })}
      </div>

      {editing && (
        <ClockDurationDialog
          value={editingPhysio ? own(editingPhysio) || storeMinutes : storeMinutes}
          title={editingPhysio ? `Treatment Session Duration · ${editingPhysio.full_name}` : "Treatment Session Duration · all physios"}
          // The store link clears the override; offered whenever there is one to clear.
          fallback={editing === "all" || (editingPhysio && own(editingPhysio)) ? storeMinutes : null}
          onCancel={() => setEditing(null)}
          onOk={saveDuration}
          testid="physio-settings-duration"
        />
      )}
    </div>
  );
};
