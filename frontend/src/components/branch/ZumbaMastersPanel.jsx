import { useCallback, useEffect, useState } from "react";
import { Clock, Music, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemedSelect } from "@/components/ui/themed-select";
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

  // One class's dropdown, shared by the phone rows and the desk cards so the two layouts
  // cannot set a class differently.
  const classSelect = (slot, holder, className, testid) => (
    <select
      value={holder?.id || ""}
      disabled={busy}
      onChange={(e) => setClassMaster(slot, e.target.value, holder?.id || "")}
      className={`rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus:border-violet-400 disabled:opacity-60 ${className}`}
      data-testid={testid}
    >
      <option value="">Nobody</option>
      {masters.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="zumba-masters-panel">
      <section className="bg-white sm:rounded-xl sm:border sm:border-slate-200">
        {/* Phone: the dialog's own header, level with its close ✕ (pr-12 keeps Refresh
            clear of it). Desk: the panel's header as before. */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 py-3 pl-4 pr-12 sm:flex-wrap sm:bg-slate-50/60 sm:p-4">
          <div className="flex min-w-0 items-center gap-2.5 sm:block">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] bg-violet-100 text-violet-600 sm:hidden">
              <Music className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 sm:text-slate-700">
                <Music className="hidden h-4 w-4 text-violet-500 sm:block" /> Zumba Masters
              </h3>
              <p className="truncate text-[11px] text-slate-400 sm:hidden">Who takes each class</p>
            </div>
          </div>
          <Button onClick={load} disabled={loading} className="h-8 w-8 shrink-0 rounded-[5px] bg-slate-500 p-0 text-white hover:bg-slate-600 sm:h-9 sm:w-9 sm:rounded-md" title="Refresh" aria-label="Refresh" data-testid="zumba-masters-refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="sm:p-4">
          {loading ? (
            <p className="py-6 text-center text-xs text-slate-400">Loading masters…</p>
          ) : masters.length === 0 ? (
            <p className="m-4 rounded-[5px] border border-dashed border-slate-200 py-8 sm:m-0 sm:rounded-lg text-center text-xs text-slate-400" data-testid="zumba-masters-empty">
              No Zumba accounts at this branch yet — add one in HR Admin, then customers are filed to a class automatically.
            </p>
          ) : (
            <>
              {/* Phone: the two classes as edge-to-edge rows, the time beside its dropdown. */}
              <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400 sm:hidden">Classes</p>
              <ul className="divide-y divide-slate-100 border-b border-slate-100 sm:hidden" data-testid="zumba-slots-phone">
                {TIME_SLOTS.map((slot) => {
                  const holder = masters.find((m) => m.time_slot === slot);
                  const [from, to] = slot.split(" - ");
                  return (
                    <li key={slot} className="flex items-center gap-3 px-4 py-2.5" data-testid={`zumba-slot-phone-${slot}`}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] bg-violet-50 text-violet-600">
                        <Clock className="h-4 w-4" />
                      </span>
                      <span className="w-[4.25rem] shrink-0 leading-tight">
                        <span className="block text-xs font-semibold text-slate-800">{from}</span>
                        <span className="block text-[10px] text-slate-400">to {to}</span>
                      </span>
                      <ThemedSelect
                        value={holder?.id || ""}
                        onChange={(v) => setClassMaster(slot, v, holder?.id || "")}
                        options={[{ value: "", label: "Nobody" }, ...masters.map((m) => ({ value: m.id, label: m.name }))]}
                        placeholder="Nobody"
                        disabled={busy}
                        className="h-9 min-w-0 flex-1 rounded-[5px] px-2.5 text-sm"
                        testid={`zumba-class-master-phone-${slot}`}
                      />
                    </li>
                  );
                })}
              </ul>

              {/* Desk: a card per class, with whether anybody chose the holder. */}
              <div className="hidden gap-3 sm:grid sm:grid-cols-2">
                {TIME_SLOTS.map((slot) => {
                  const holder = masters.find((m) => m.time_slot === slot);
                  return (
                    <div key={slot} className="rounded-lg border border-slate-200 p-3" data-testid={`zumba-slot-${slot}`}>
                      <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">{slot}</p>
                      {classSelect(slot, holder, "mt-2 h-9 w-full", `zumba-class-master-${slot}`)}
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        {/* Whether anybody said so, or it simply follows from the roster —
                            presenting an arrangement nobody chose as though somebody had is
                            how a branch ends up disputing a revenue split. */}
                        {holder
                          ? holder.slot_set ? "Set for this branch" : "Implied — nobody has chosen this yet"
                          : "This class has nobody on it"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {masters.length > 0 && (
            <div className="sm:mt-4 sm:border-t sm:border-slate-100 sm:pt-3">
              <p className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400 sm:mb-2 sm:border-0 sm:bg-transparent sm:p-0">
                Masters at this branch
                <span className="rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-500 sm:hidden">{masters.length}</span>
              </p>
              {/* Phone: one edge-to-edge row each, the class they hold as a pill. Desk: chips. */}
              <ul className="divide-y divide-slate-100 sm:flex sm:flex-wrap sm:gap-2 sm:divide-y-0">
                {masters.map((m) => (
                  <li key={m.id} className="flex items-center gap-2.5 px-4 py-2.5 sm:gap-2 sm:rounded-lg sm:border sm:border-slate-200 sm:px-2.5 sm:py-1.5" data-testid={`zumba-master-${m.id}`}>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700 sm:h-7 sm:w-7">
                      {(m.name || "?").charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 sm:flex-none">
                      <span className="block truncate text-sm font-medium text-slate-800">{m.name || "—"}</span>
                      <span className="hidden text-[10px] text-slate-400 sm:block">{m.time_slot || "No class yet"}</span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium sm:hidden ${m.time_slot ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-500"}`}>
                      {m.time_slot || "No class yet"}
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
