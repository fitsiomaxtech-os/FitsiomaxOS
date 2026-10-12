import { useEffect, useState } from "react";
import { Building2, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { HeadPhysioCalendar } from "@/components/HeadPhysioCalendar";
import { getMyConsultBranches, hpResolvedConsultant, setMyConsultBranch } from "@/lib/api";

/**
 * Which branches the Super Admin takes consultations at — one On/Off per branch.
 *
 * On is what puts them on that branch's Consultant Calendar (MANAGEMENT) and in its booking
 * and reassign pickers, so the Branch Admin there can open the days agreed on the phone and
 * book a patient into them. Off takes them out of that branch only. Everything is On until
 * switched off, so a new branch has them without anybody remembering to add it.
 *
 * An icon beside the name chip, opening the switches in a popup — the header row stays one
 * line. Not drawn at all when a developer has the feature off (Danger Zone).
 */
const ConsultBranchSwitches = () => {
  const [rows, setRows] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let live = true;
    getMyConsultBranches()
      .then((res) => { if (live) { setRows(res?.branches || []); setEnabled(!!res?.enabled); } })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const flip = async (row, on) => {
    setBusyId(row.branch_id);
    // Drawn at once, then replaced by the server's answer — or put back if it refused.
    setRows((cur) => cur.map((r) => (r.branch_id === row.branch_id ? { ...r, on } : r)));
    try {
      const res = await setMyConsultBranch(row.branch_id, on);
      setRows(res?.branches || []);
      toast.success(`${row.branch_name}: consultations ${on ? "On" : "Off"}`);
    } catch (err) {
      setRows((cur) => cur.map((r) => (r.branch_id === row.branch_id ? { ...r, on: !on } : r)));
      toast.error(err?.response?.data?.detail || "Could not change this branch");
    } finally {
      setBusyId(null);
    }
  };

  if (rows === null || !enabled) return null;
  const onCount = rows.filter((r) => r.on).length;
  const someOff = onCount < rows.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Take consultations at — branch On/Off"
        aria-label="Take consultations at — branch On/Off"
        className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
        data-testid="my-consultation-branch-switches-open"
      >
        <Building2 className="h-4 w-4" />
        {/* How many are On, so a branch switched Off is visible without opening it. */}
        <span className={`absolute -right-1.5 -top-1.5 rounded-full px-1.5 text-[9px] font-bold leading-4 text-white ${someOff ? "bg-amber-500" : "bg-emerald-600"}`}>
          {onCount}/{rows.length}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          data-testid="my-consultation-branch-switches"
        >
          <section className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-slate-400" /> Take consultations at
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
                data-testid="my-consultation-branch-switches-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-slate-400">No branches yet.</p>
            ) : (
              // One branch per row, read top to bottom like the branch picker beside it.
              <div className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
                {rows.map((r) => (
                  <label
                    key={r.branch_id}
                    className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                    data-testid={`my-consultation-branch-switch-${r.branch_id}`}
                  >
                    <span className={`truncate text-sm ${r.on ? "font-medium text-slate-800" : "text-slate-400"}`}>{r.branch_name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`text-[10px] font-bold uppercase ${r.on ? "text-emerald-600" : "text-slate-400"}`}>{r.on ? "On" : "Off"}</span>
                      <Switch
                        checked={r.on}
                        disabled={busyId !== null}
                        onCheckedChange={(on) => flip(r, on)}
                        className="data-[state=checked]:bg-emerald-600"
                      />
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
};

/**
 * A Super Admin's Sumaiya Consultations, branch by branch.
 *
 * The same panel as Branch Admin's Sumaiya Consultations tab — the Consultant Calendar with
 * Sumaiya preselected — read one branch at a time from the strip above it. Branch-wise only:
 * a calendar is published per branch, so there is no All Branches answer to give here.
 *
 * The patient table this page used to be is gone from here; the bookings themselves are
 * still on each branch's Consultation tab.
 */
export const MyConsultationBoard = ({ branches = [] }) => {
  const [branchId, setBranchId] = useState("");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  // Still asked on mount: it is where a Super Admin's own consultant record is made if they
  // have none (ensure_super_admin_consultant), which is what puts them on the calendar.
  useEffect(() => {
    hpResolvedConsultant()
      .then((res) => setIsSuperAdmin(!!res?.is_super_admin))
      .catch(() => setIsSuperAdmin(false));
  }, []);

  // The first branch until one is picked, and again if the picked one leaves the list.
  useEffect(() => {
    if (branches.length && !branches.some((b) => b.id === branchId)) setBranchId(branches[0].id);
  }, [branches, branchId]);

  return (
    <div className="space-y-4" data-testid="my-consultation-board">
      <div className="flex items-center gap-2">
        <div className="show-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1" data-testid="my-consultation-branch-tabs">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBranchId(b.id)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                branchId === b.id ? "bg-sky-600 text-white shadow-sm" : "text-slate-500 hover:bg-sky-50 hover:text-sky-700"
              }`}
              data-testid={`my-consultation-branch-tab-${b.id}`}
            >
              <Building2 className="h-4 w-4" /> {b.branch_name}
            </button>
          ))}
          {branches.length === 0 && <p className="px-3 py-2 text-sm text-slate-400">No branches yet.</p>}
        </div>
        {isSuperAdmin && <ConsultBranchSwitches />}
      </div>

      {/* Keyed on the branch so each one opens fresh on Sumaiya — the calendar only
          preselects into an empty selection. */}
      {branchId && <HeadPhysioCalendar key={branchId} branchId={branchId} preselectName="Sumaiya" />}
    </div>
  );
};

export default MyConsultationBoard;
