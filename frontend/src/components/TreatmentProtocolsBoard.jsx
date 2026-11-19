import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, RefreshCw, ScrollText, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { getTreatmentProtocols, createTreatmentProtocol, updateTreatmentProtocol, deleteTreatmentProtocol } from "@/lib/api";

/**
 * Branch Admin > Services and Products > Treatment Protocol. The same kind of list as the
 * Treatments tab, but each row also holds a little information about the protocol. The
 * information is optional; only the name is needed.
 *
 * One list for the whole OS. The Consultant can drop a protocol into their Treatment
 * Protocol box (Treatment Prescription popup); the box keeps the typed text, so editing or
 * deleting a protocol here never changes what is already on a patient.
 *
 * Developer Access > Hide Tab > Branch Admin hides this tab (ba_treatment_protocol).
 */
export const TreatmentProtocolsBoard = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  // null: closed. { id?, name, info }: the create (no id) or edit popup, on its own copy.
  const [draft, setDraft] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await getTreatmentProtocols());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load treatment protocols");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => `${r.name || ""} ${r.info || ""}`.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const remove = async (row) => {
    try {
      await deleteTreatmentProtocol(row.id);
      toast.success(`Deleted ${row.name}`);
      setConfirmDelete(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div className="space-y-4" data-testid="treatment-protocols-board">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search treatment protocols..."
            className="h-10 pl-8"
            data-testid="treatment-protocol-search"
          />
        </div>
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="treatment-protocol-refresh-btn"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <Button
          onClick={() => setDraft({ name: "", info: "" })}
          className="h-10 w-10 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700 sm:w-auto sm:px-4"
          title="Create Treatment Protocol"
          aria-label="Create Treatment Protocol"
          data-testid="treatment-protocol-create-btn"
        >
          <Plus className="h-4 w-4 sm:mr-1" />
          <span className="hidden sm:inline">Create Treatment Protocol</span>
        </Button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Treatment Protocols <span className="text-slate-400">({rows.length})</span>
          </p>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-slate-400" data-testid="treatment-protocol-loading">Loading treatment protocols...</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center" data-testid="treatment-protocol-empty">
            <ScrollText className="h-9 w-9 text-slate-300" />
            <p className="text-sm text-slate-500">
              {rows.length === 0 ? "No treatment protocols yet." : `Nothing matches "${search}".`}
            </p>
            {rows.length === 0 && (
              <p className="text-xs text-slate-400">Click <span className="font-semibold">Create Treatment Protocol</span> to add the first one.</p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="treatment-protocol-list">
            {filtered.map((row) => (
              <li key={row.id} className="flex items-start gap-3 px-4 py-3" data-testid={`treatment-protocol-row-${row.id}`}>
                <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{row.name}</p>
                  {row.info && (
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-slate-500" data-testid={`treatment-protocol-info-${row.id}`}>{row.info}</p>
                  )}
                </div>
                <button
                  onClick={() => setDraft({ id: row.id, name: row.name || "", info: row.info || "" })}
                  className="shrink-0 rounded p-1.5 text-slate-400 transition hover:bg-sky-50 hover:text-sky-600"
                  title={`Edit ${row.name}`}
                  aria-label={`Edit ${row.name}`}
                  data-testid={`treatment-protocol-edit-${row.id}`}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDelete(row)}
                  className="shrink-0 rounded p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  title={`Delete ${row.name}`}
                  aria-label={`Delete ${row.name}`}
                  data-testid={`treatment-protocol-delete-${row.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {draft && (
        <ProtocolDialog
          draft={draft}
          existing={rows}
          onClose={() => setDraft(null)}
          onSaved={() => { setDraft(null); load(); }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="treatment-protocol-delete-dialog">
          <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-rose-100">
                <Trash2 className="h-5 w-5 text-rose-600" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900">Delete treatment protocol?</h3>
                <p className="mt-1 text-xs text-slate-500">
                  <b className="text-slate-700">{confirmDelete.name}</b> is removed from the list. Protocols already written on patients stay as they are.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setConfirmDelete(null)} data-testid="treatment-protocol-delete-cancel">Cancel</Button>
              <Button onClick={() => remove(confirmDelete)} className="bg-rose-600 hover:bg-rose-700" data-testid="treatment-protocol-delete-confirm">
                Yes, Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Create (no id) or edit one protocol: Name, and Information (optional). */
const ProtocolDialog = ({ draft, existing = [], onClose, onSaved }) => {
  const [name, setName] = useState(draft.name || "");
  const [info, setInfo] = useState(draft.info || "");
  const [saving, setSaving] = useState(false);
  const editing = Boolean(draft.id);

  const trimmed = name.trim();
  const duplicate = useMemo(
    () => existing.some((r) => r.id !== draft.id && (r.name || "").toLowerCase() === trimmed.toLowerCase()),
    [existing, draft.id, trimmed],
  );

  const submit = async () => {
    if (!trimmed) { toast.error("Enter a treatment protocol name"); return; }
    if (duplicate) return;
    setSaving(true);
    try {
      const payload = { name: trimmed, info: info.trim() };
      if (editing) await updateTreatmentProtocol(draft.id, payload);
      else await createTreatmentProtocol(payload);
      toast.success(editing ? `Saved ${trimmed}` : `Added ${trimmed}`);
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || (editing ? "Save failed" : "Create failed"));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="treatment-protocol-dialog">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{editing ? "Edit Treatment Protocol" : "Create Treatment Protocol"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close" data-testid="treatment-protocol-dialog-close"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Treatment Protocol Name *</label>
            <Input
              value={name}
              autoFocus
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Frozen Shoulder Protocol"
              data-testid="treatment-protocol-name"
            />
            {duplicate && trimmed && (
              <p className="mt-1 text-[11px] font-medium text-rose-600" data-testid="treatment-protocol-duplicate">
                "{trimmed}" is already in the list.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Information <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea
              value={info}
              onChange={(e) => setInfo(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="A little information about this protocol"
              className="w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              data-testid="treatment-protocol-info"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="treatment-protocol-cancel">Cancel</Button>
          <Button
            onClick={submit}
            disabled={saving || duplicate || !trimmed}
            className="bg-sky-600 hover:bg-sky-700"
            data-testid="treatment-protocol-submit"
          >
            {editing ? (saving ? "Saving..." : "Save") : (<><Plus className="mr-1 h-4 w-4" />{saving ? "Adding..." : "Add Treatment Protocol"}</>)}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default TreatmentProtocolsBoard;
