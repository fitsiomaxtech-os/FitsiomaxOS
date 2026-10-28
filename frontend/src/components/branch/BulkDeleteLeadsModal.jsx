import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { bulkDeleteLeads } from "@/lib/api";
import { displayPhone } from "@/lib/phone";

/**
 * Confirm a delete by typing the word.
 *
 * A count and an OK button is the shape of dialog people learn to dismiss, and this one
 * cannot be undone. Typing DELETE costs a second and cannot be done by muscle memory, so
 * the agreement is to this particular delete rather than to dialogs in general.
 *
 * The names are listed rather than only counted. "Delete 47 patients" is a number; the
 * list is what lets someone notice a real patient among the junk before it goes.
 *
 * `purge` is the row's own bin icon: the patient goes whatever they are carrying, treatment
 * slots and collected payments included. The select-many bar leaves it off, so a real
 * patient swept up with an import is refused and named instead. Same dialog either way
 * because the confirmation is the same act — but the two say different things about what
 * survives, and that difference is the whole reason to read it.
 *
 * Its own file so Pre Sales can use it too: its New Leads rows carry the same bin icon,
 * on the same Developer Access switch, and ask the same question.
 */
export function BulkDeleteLeadsModal({ leads, onClose, onDeleted, purge = false }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = typed.trim().toUpperCase() === "DELETE";

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    try {
      const res = await bulkDeleteLeads(leads.map((l) => l.id), typed.trim().toUpperCase(), purge);
      const blocked = res.blocked || [];
      if (res.deleted > 0) toast.success(`${res.deleted} patient${res.deleted > 1 ? "s" : ""} deleted`);
      // Kept apart from the success line: the ones that survived are the point of the
      // message, and folding both into one toast buries them.
      if (blocked.length) {
        const why = [...new Set(blocked.map((b) => b.reason))].join("; ");
        toast.error(`${blocked.length} kept — ${why}`, { duration: 8000 });
      }
      if (!res.deleted && !blocked.length) toast.error("Nothing was deleted");
      onDeleted(res);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white shadow-2xl" data-testid="branch-bulk-delete-modal">
        <div className="border-b p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold text-rose-700">
            <Trash2 className="h-4 w-4" /> Delete {leads.length} patient{leads.length > 1 ? "s" : ""}?
          </h3>
          <p className="mt-1 text-[11px] text-slate-500">
            {purge
              ? "This removes the patient and everything of theirs — treatment slots, collected payments, appointments, reviews, documents and portal login. It cannot be undone."
              : "This removes them and their activity, follow-ups and appointments. It cannot be undone."}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Being deleted</p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="branch-bulk-delete-list">
            {leads.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="truncate font-medium text-slate-700">{l.name || "Unnamed"}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">{l.patient_number || displayPhone(l.phone) || "—"}</span>
              </li>
            ))}
          </ul>
          {purge ? (
            <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-800" data-testid="branch-delete-purge-warning">
              Treatment sessions and collected payments go too. Nothing is kept back, and the
              finance figures this patient is counted in will change.
            </p>
          ) : (
            <p className="mt-3 text-[11px] text-slate-500">
              Anyone with treatment sessions or collected payments is kept — they are a patient with a
              record, not an import to clear. You will be told which.
            </p>
          )}
        </div>

        <div className="border-t p-4">
          <label className="mb-1.5 block text-xs font-medium text-slate-600">
            Type <b className="font-mono text-rose-700">DELETE</b> to confirm
          </label>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && armed && !busy) run(); }}
            placeholder="DELETE"
            autoFocus
            className="font-mono"
            data-testid="branch-bulk-delete-input"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              onClick={run}
              disabled={!armed || busy}
              className="bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              data-testid="branch-bulk-delete-confirm"
            >
              {busy ? "Deleting..." : `Delete ${leads.length}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BulkDeleteLeadsModal;
