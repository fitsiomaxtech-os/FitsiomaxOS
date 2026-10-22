import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Building2, Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getConsultationsBoard, listBranchConsultants, reassignConsultant } from "@/lib/api";
import { to12h } from "@/lib/time";
import { displayPhone } from "@/lib/phone";

/**
 * Pick patients at a branch and hand their consultations to somebody — the Super Admin
 * themselves, or a consultant of their choosing.
 *
 * One panel for both asks because they are one act: "this patient should be seen by that
 * person". Taking a patient yourself is the same move with yourself as the person, so the
 * consultant list opens on the reader and the button names whoever is picked.
 *
 * The slot never changes here. Reschedule already exists for moving a patient's time, and
 * it asks for a date, a time and a reason; a patient happy with their Tuesday 11:45 who
 * just needs a different consultant should not be put through that. Anything the server
 * could not move — the new consultant already booked at that minute, a patient with no
 * live booking — comes back named, and the panel shows it instead of closing over it.
 *
 * A branch has to be chosen. Who may work a patient is decided per branch
 * (consultants_serving_branch), so an "All Branches" list would offer consultants the
 * patient's own branch does not have.
 */
export const ConsultationReassignModal = ({ branches = [], defaultBranchId, onClose, onDone }) => {
  const initialBranch = defaultBranchId && defaultBranchId !== "all"
    ? defaultBranchId
    : (branches[0]?.id || "");
  const [branchId, setBranchId] = useState(initialBranch);
  const [leads, setLeads] = useState([]);
  const [consultants, setConsultants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    setLoading(true);
    setPicked(new Set());
    setResult(null);
    Promise.all([
      getConsultationsBoard(branchId, "head_consultation"),
      listBranchConsultants(branchId),
    ])
      .then(([board, staff]) => {
        if (cancelled) return;
        // A cancelled consultation has no booking left to hand to anybody.
        setLeads((board?.leads || []).filter((l) => l.head_consultation_stage !== "Cancel"));
        const rows = staff?.consultants || [];
        setConsultants(rows);
        // Open on the reader: taking a patient yourself is the common case.
        setTargetId((prev) => (rows.some((c) => c.id === prev) ? prev : (rows.find((c) => c.is_me)?.id || rows[0]?.id || "")));
      })
      .catch(() => { if (!cancelled) toast.error("Could not load this branch's consultations"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [branchId]);

  const target = consultants.find((c) => c.id === targetId);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = !q ? leads : leads.filter((l) =>
      [l.name, l.phone, l.patient_number, l.assigned_physio_name]
        .some((v) => (v || "").toLowerCase().includes(q)));
    // Soonest appointment first — the ones about to be seen are the ones worth moving.
    return [...rows].sort((a, b) =>
      `${a.appointment_date || "9"}${a.appointment_time || ""}`.localeCompare(`${b.appointment_date || "9"}${b.appointment_time || ""}`));
  }, [leads, query]);

  // Already with the chosen consultant: nothing to move, so not offered.
  const movable = shown.filter((l) => l.assigned_physio_id !== targetId);
  const allPicked = movable.length > 0 && movable.every((l) => picked.has(l.id));

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(movable.map((l) => l.id)));

  const submit = async () => {
    const ids = [...picked].filter((id) => leads.find((l) => l.id === id)?.assigned_physio_id !== targetId);
    if (!ids.length) { toast.error("Pick at least one patient"); return; }
    if (!targetId) { toast.error("Pick a consultant"); return; }
    setSaving(true);
    try {
      const res = await reassignConsultant(ids, targetId, reason.trim());
      setResult(res);
      const n = res?.moved?.length || 0;
      if (n) toast.success(`${n} patient${n === 1 ? "" : "s"} moved to ${res.consultant?.full_name || "the consultant"}`);
      if (res?.skipped?.length) toast.error(`${res.skipped.length} could not be moved — see the list`);
      // Reflect the move in this list without a refetch: the rows now belong to the target.
      const movedIds = new Set((res?.moved || []).map((m) => m.lead_id));
      setLeads((prev) => prev.map((l) => (movedIds.has(l.id)
        ? { ...l, assigned_physio_id: res.consultant.id, assigned_physio_name: res.consultant.full_name }
        : l)));
      setPicked(new Set());
      if (n && onDone) onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not move the patients");
    } finally {
      setSaving(false);
    }
  };

  const branchName = (id) => branches.find((b) => b.id === id)?.branch_name || "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      data-testid="reassign-modal"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 shrink-0 text-sky-600" />
            <div className="min-w-0">
              <p className="text-base font-semibold text-slate-900">Assign Consultations</p>
              <p className="truncate text-[11px] text-slate-500">Pick patients, then who sees them. Their appointment time stays as it is.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="reassign-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Branch, then search. The branch comes first because everything under it — the
            patients and who is allowed to take them — is read per branch. */}
        <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-3 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            <Building2 className="h-4 w-4 text-slate-400" />
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              disabled={saving}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm font-normal text-slate-800 focus:border-sky-400 focus:outline-none"
              data-testid="reassign-branch"
            >
              {branches.length === 0 && <option value="">No branches</option>}
              {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
            </select>
          </label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search patient, phone, patient no. or consultant..."
              className="h-9 w-full rounded-md border border-slate-200 pl-9 pr-3 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              data-testid="reassign-search"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-5 py-10 text-center text-sm text-slate-400">Loading {branchName(branchId)}...</p>
          ) : shown.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-400">
              {query ? "No patient matches that search." : "No consultations booked at this branch."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 z-10 bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="w-10 px-4 py-2">
                      <input type="checkbox" checked={allPicked} onChange={toggleAll} disabled={movable.length === 0} aria-label="Select all" data-testid="reassign-select-all" />
                    </th>
                    <th className="px-3 py-2 font-semibold">Patient</th>
                    <th className="px-3 py-2 font-semibold">Appointment</th>
                    <th className="px-3 py-2 font-semibold">Consultant now</th>
                    <th className="px-3 py-2 font-semibold">Stage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((l) => {
                    const alreadyThere = l.assigned_physio_id === targetId;
                    const on = picked.has(l.id);
                    return (
                      <tr
                        key={l.id}
                        onClick={() => { if (!alreadyThere) toggle(l.id); }}
                        className={`${alreadyThere ? "cursor-default opacity-50" : "cursor-pointer hover:bg-sky-50/60"} ${on ? "bg-sky-50" : ""}`}
                        data-testid={`reassign-row-${l.id}`}
                      >
                        <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={on} disabled={alreadyThere} onChange={() => toggle(l.id)} aria-label={`Select ${l.name}`} />
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-semibold text-slate-800">{l.name}</p>
                          <p className="font-mono text-[11px] text-slate-400">{l.patient_number || displayPhone(l.phone) || "—"}</p>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-600">
                          {l.appointment_date || "—"}{l.appointment_time ? ` · ${to12h(l.appointment_time)}` : ""}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-700">
                          <span className="inline-flex items-center gap-1.5">
                            {l.assigned_physio_name || "—"}
                            {alreadyThere && <span className="text-[10px] font-medium text-sky-600">· already with them</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{l.head_consultation_stage || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* What did not move, by name. Closing over a partial failure would leave the
              reader believing every ticked patient went across. */}
          {result?.skipped?.length > 0 && (
            <div className="mx-5 my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" data-testid="reassign-skipped">
              <p className="mb-1 text-xs font-semibold text-amber-800">Not moved</p>
              <ul className="space-y-0.5 text-xs text-amber-800">
                {result.skipped.map((s) => <li key={s.lead_id}><b>{s.name || "Patient"}</b> — {s.reason}</li>)}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 lg:flex-row lg:items-center">
          <label className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-600">
            <span className="shrink-0">Assign to</span>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              disabled={saving || consultants.length === 0}
              className="h-9 min-w-0 max-w-[16rem] rounded-md border border-slate-200 bg-white px-2 text-sm font-normal text-slate-800 focus:border-sky-400 focus:outline-none"
              data-testid="reassign-target"
            >
              {consultants.length === 0 && <option value="">No consultant works this branch</option>}
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}{c.is_me ? " (me)" : ""}{c.is_super_admin ? " · Super Admin" : ""}
                </option>
              ))}
            </select>
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional) — kept on the patient's timeline"
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm focus:border-sky-400 focus:outline-none"
            data-testid="reassign-reason"
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving} data-testid="reassign-cancel">Close</Button>
            <Button
              className="bg-sky-600 text-white hover:bg-sky-700"
              onClick={submit}
              disabled={saving || picked.size === 0 || !targetId}
              data-testid="reassign-submit"
            >
              <Check className="mr-1 h-4 w-4" />
              {saving
                ? "Assigning..."
                : `Assign ${picked.size || ""} to ${target ? (target.is_me ? "me" : target.full_name) : "..."}`.replace("  ", " ")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConsultationReassignModal;
