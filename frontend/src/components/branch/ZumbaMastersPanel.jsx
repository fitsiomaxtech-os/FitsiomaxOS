import { useCallback, useEffect, useState } from "react";
import { Music, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { listZumbaMasters, setZumbaMasterSlot } from "@/lib/api";
// The branch's two class times, taken from where the Zumba board already keeps them
// rather than written out again: they are matched character for character against
// the backend tuple, and a second copy that drifted would match no holder.
import { TIME_SLOTS } from "@/components/branch/ZumbaPanel";

/**
 * ZUMBA — who teaches which class at this branch.
 *
 * MANAGEMENT is where a branch says who works here and when: the consultants' calendar, the
 * physios', the nutritionists'. Zumba answers the same question in the shape Zumba actually
 * has. A master does not publish slots a patient books into one at a time — there are two
 * class times and somebody takes each, and a customer registering is filed to whoever holds
 * their slot.
 *
 * Asked slot first, not master first, because that is the shape of the fact and because
 * asking it this way round cannot express two masters answering to the same class.
 *
 * The same control also sits on the Zumba board, beside the customers it files. It is here
 * as well because this is the roster, and someone setting up a branch's week looks here —
 * both call the same endpoint, so neither can drift from the other.
 */



export const ZumbaMastersPanel = ({ branchId }) => {
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listZumbaMasters(branchId);
      setMasters(Array.isArray(rows) ? rows : []);
    } catch {
      setMasters([]);
    }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const setClassMaster = async (slot, nextId, currentId) => {
    if (nextId === currentId) return;
    setBusy(true);
    try {
      // Clearing a class means standing down whoever holds it; there is no id to send it
      // against otherwise, which is why the current holder is passed in.
      const res = nextId ? await setZumbaMasterSlot(nextId, slot) : await setZumbaMasterSlot(currentId, "");
      const moved = Number(res?.customers_moved || 0);
      toast.success(
        nextId
          ? `${res?.name || "Master"} takes ${slot}${moved ? ` · ${moved} customer${moved === 1 ? "" : "s"} moved` : ""}`
          : `${slot} is nobody's for now${moved ? ` · ${moved} released` : ""}`,
      );
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not set that class");
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="zumba-masters-panel">
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Music className="h-4 w-4 text-violet-500" /> Zumba Masters
            </h3>
          </div>
          <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh" data-testid="zumba-masters-refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="p-4">
          {loading ? (
            <p className="py-6 text-center text-xs text-slate-400">Loading masters…</p>
          ) : masters.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400" data-testid="zumba-masters-empty">
              No Zumba accounts at this branch yet — add one in HR Admin, then customers are filed to a class automatically.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {TIME_SLOTS.map((slot) => {
                const holder = masters.find((m) => m.time_slot === slot);
                return (
                  <div key={slot} className="rounded-lg border border-slate-200 p-3" data-testid={`zumba-slot-${slot}`}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">{slot}</p>
                    <select
                      value={holder?.id || ""}
                      disabled={busy}
                      onChange={(e) => setClassMaster(slot, e.target.value, holder?.id || "")}
                      className="mt-2 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus:border-violet-400 disabled:opacity-60"
                      data-testid={`zumba-class-master-${slot}`}
                    >
                      <option value="">Nobody</option>
                      {masters.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <p className="mt-1.5 hidden text-[11px] text-slate-400 sm:block">
                      {/* Whether anybody said so, or it simply follows from the roster —
                          presenting an arrangement nobody chose as though somebody had is
                          how a branch ends up disputing a revenue split. Desk only: on a
                          phone the dropdown above already names who holds the class. */}
                      {holder
                        ? holder.slot_set ? "Set for this branch" : "Implied — nobody has chosen this yet"
                        : "This class has nobody on it"}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {masters.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Masters at this branch</p>
              <ul className="flex flex-wrap gap-2">
                {masters.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5" data-testid={`zumba-master-${m.id}`}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                      {(m.name || "?").charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">{m.name || "—"}</span>
                      <span className="block text-[10px] text-slate-400">{m.time_slot || "No class yet"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default ZumbaMastersPanel;
