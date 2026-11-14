/**
 * Business Development Executive > Permission.
 *
 * Every leave and permission request from the branch staff -- Branch Admin, Physio,
 * Consultant, Masters (Zumba) and Accountant -- in one table, decided in place. Reads
 * GET /hr/staff-requests (role and branch beside each row) and decides through the same
 * PATCH /hr/approvals/{id} HR Admin > Approvals uses, so both screens act on one record.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, RefreshCw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { hrDecideApproval, hrStaffRequests } from "@/lib/api";
import { duration, prettyTime } from "@/lib/clock";

const GROUPS = [
  { key: "branch_admin", label: "Branch Admin", roles: ["branch_admin", "branch_admin_physio", "branch_admin_fitness", "branch_admin_physio_fitness", "online_physio_admin", "online_fitness_admin"] },
  { key: "physio", label: "Physio", roles: ["physio", "online_physio"] },
  { key: "consultant", label: "Consultant", roles: ["consultant", "online_consultant", "head_physio", "online_head_physio", "consultant_physio"] },
  { key: "masters", label: "Masters", roles: ["zumba"] },
  { key: "accountant", label: "Accountant", roles: ["accountant"] },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.roles.map((r) => [r, g])));

const STATUSES = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];
const KINDS = [
  { key: "all", label: "All" },
  { key: "leave", label: "Leave" },
  { key: "permission", label: "Permission" },
];

const STATUS_TONE = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
};

const prettyDate = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "");

const whenOf = (row) => {
  if (row.kind === "permission") {
    return `${prettyDate(row.from_date)} · ${prettyTime(row.from_time)} - ${prettyTime(row.to_time)} (${duration(row.minutes)})`;
  }
  if (!row.from_date) return "—";
  return row.from_date === row.to_date
    ? `${prettyDate(row.from_date)} (1 day)`
    : `${prettyDate(row.from_date)} - ${prettyDate(row.to_date)} (${row.days} days)`;
};

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

const Pill = ({ active, onClick, children, testid }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-3 text-sm font-medium transition ${
      active ? "border-sky-600 bg-sky-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
    }`}
    data-testid={testid}
  >
    {children}
  </button>
);

export const StaffRequestsPanel = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("pending");
  const [kind, setKind] = useState("all");
  const [group, setGroup] = useState("all");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    return hrStaffRequests()
      .then((d) => setRows((d?.requests || []).filter((r) => GROUP_OF[r.role])))
      .catch(fail)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const byGroupKind = useMemo(
    () => rows.filter((r) => (group === "all" || GROUP_OF[r.role]?.key === group) && (kind === "all" || r.kind === kind)),
    [rows, group, kind],
  );
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0, all: byGroupKind.length };
    byGroupKind.forEach((r) => { if (c[r.status] !== undefined) c[r.status] += 1; });
    return c;
  }, [byGroupKind]);
  const shown = useMemo(
    () => (status === "all" ? byGroupKind : byGroupKind.filter((r) => r.status === status)),
    [byGroupKind, status],
  );

  const decide = async (row, decision) => {
    setBusy(row.id);
    try {
      await hrDecideApproval(row.id, decision);
      toast.success(decision === "pending" ? "Reopened" : decision === "approved" ? "Approved" : "Rejected");
      await load();
    } catch (e) { fail(e); } finally { setBusy(""); }
  };

  return (
    <div className="space-y-3" data-testid="bd-permission-tab">
      <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-slate-200 bg-white p-2">
        {STATUSES.map((s) => (
          <Pill key={s.key} active={status === s.key} onClick={() => setStatus(s.key)} testid={`bd-perm-status-${s.key}`}>
            {s.label}
            <span className={`rounded-[4px] px-1.5 text-xs ${status === s.key ? "bg-white/20" : "bg-slate-100 text-slate-500"}`}>{counts[s.key]}</span>
          </Pill>
        ))}
        <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" />
        {KINDS.map((k) => (
          <Pill key={k.key} active={kind === k.key} onClick={() => setKind(k.key)} testid={`bd-perm-kind-${k.key}`}>{k.label}</Pill>
        ))}
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="h-9 rounded-[4px] border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus:border-sky-400"
          data-testid="bd-perm-role"
        >
          <option value="all">All Staff</option>
          {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="ml-auto h-9 w-9 shrink-0 rounded-[4px] bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="bd-perm-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="overflow-x-auto rounded-[4px] border border-slate-200 bg-white">
        <table className="w-full min-w-[900px] text-sm" data-testid="bd-perm-table">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">S.No</th>
              <th className="px-3 py-2.5">Staff</th>
              <th className="px-3 py-2.5">Role</th>
              <th className="px-3 py-2.5">Branch</th>
              <th className="px-3 py-2.5">Type</th>
              <th className="px-3 py-2.5">Date / Time</th>
              <th className="px-3 py-2.5">Reason</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && !shown.length ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-400">Loading...</td></tr>
            ) : !shown.length ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-400">No requests</td></tr>
            ) : shown.map((row, i) => (
              <tr key={row.id} className="border-b border-slate-100 last:border-0" data-testid={`bd-perm-row-${row.id}`}>
                <td className="px-3 py-2.5 text-slate-500">{i + 1}</td>
                <td className="px-3 py-2.5 font-medium text-slate-800">{row.employee_name || "—"}</td>
                <td className="px-3 py-2.5 text-slate-600">{GROUP_OF[row.role]?.label || "—"}</td>
                <td className="px-3 py-2.5 text-slate-600">{row.branch_name || "—"}</td>
                <td className="px-3 py-2.5 text-slate-600">{row.kind === "permission" ? "Permission" : "Leave"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{whenOf(row)}</td>
                <td className="max-w-[260px] px-3 py-2.5 text-slate-600"><span className="line-clamp-2">{row.reason || "—"}</span></td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-[4px] px-2 py-0.5 text-[11px] font-bold uppercase ${STATUS_TONE[row.status] || "bg-slate-100 text-slate-600"}`}>{row.status}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-1.5">
                    {row.status === "pending" ? (
                      <>
                        <Button size="sm" disabled={busy === row.id} onClick={() => decide(row, "approved")} className="h-8 rounded-[4px] bg-emerald-600 hover:bg-emerald-700" data-testid={`bd-perm-approve-${row.id}`}>
                          <Check className="h-4 w-4" />Approve
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => decide(row, "rejected")} className="h-8 rounded-[4px]" data-testid={`bd-perm-reject-${row.id}`}>
                          <Ban className="h-4 w-4" />Reject
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => decide(row, "pending")} className="h-8 rounded-[4px]" data-testid={`bd-perm-reopen-${row.id}`}>
                        <Undo2 className="h-4 w-4" />Reopen
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
