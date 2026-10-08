import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, MapPin, Clock, Calendar as CalendarIcon, Mail, Phone, User, RefreshCw, Pencil,
  Users, BarChart3, Stethoscope, Activity, ListChecks, FileText, Wallet, UserCog, X,
  ArrowLeftRight, Plus, Trash2, Archive, Power,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/ui/filter-select";
import { toast } from "@/components/ui/sonner";
import { bmDetail, updateBranch, bmReassignAdmin, hrBranchAdminCandidates, bmHeadPhysioCandidates, bmAssignHeadPhysio, bmLeadControlHistory, bmPreSalesMembers, hrUpdateUser, bmTeamCandidates, bmTeamAdd, bmTeamRemove, hrActivateUser, hrDeactivateUser, hrDeleteUserPermanent } from "@/lib/api";
import { BranchFormDialogV2 } from "@/components/branch/BranchFormDialogV2";
import { LeadControlSwitch, normalizeLeadControl } from "@/components/branch/LeadControlSwitch";
import { slotTo12h } from "@/lib/time";
import { MilkDateInput } from "@/components/ui/milk-calendar";

const TABS = [
  { key: "summary", label: "Summary", icon: BarChart3 },
  { key: "staff", label: "Team", icon: Users },
  { key: "performance", label: "Performance", icon: Activity },
  { key: "head_physio", label: "Experts", icon: Stethoscope },
  { key: "lead_management", label: "Lead Management", icon: ArrowLeftRight },
];

export const BranchDetailPage = ({ branchId, onBack, readOnly = false }) => {
  const [tab, setTab] = useState("summary");
  const [data, setData] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by Refresh, and read by the tabs that fetch lists this page's `data` does not
  // carry — Team's Pre-Sales desk and Lead Management's switch history. Both keep their own
  // state off `branchId`, which does not change when the same branch is reloaded, so
  // without a token their effects never re-run and Refresh left them showing what they had
  // fetched when the tab first opened. TeamTab's own afterSave already reloads both lists
  // for exactly this reason; the header button had the gap that comment warns about.
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await bmDetail(branchId));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load");
    }
    setRefreshing(false);
  }, [branchId]);
  useEffect(() => { load(); }, [load]);

  // The token is bumped here rather than inside `load` so opening the page fetches each
  // list once: mount runs `load` on its own, and only a press means "everything again".
  const refresh = () => { load(); setReloadToken((n) => n + 1); };

  if (!data) return <p className="text-sm text-slate-500" data-testid="branch-detail-loading">Loading branch details...</p>;
  const b = data.branch;

  return (
    <div className="space-y-5" data-testid="branch-detail-page">
      {/* Wraps as a whole once the controls no longer fit beside the name — the button
          group gained a two-part switch, and a long address left the two halves fighting
          over the same line on a phone. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && <Button variant="ghost" size="sm" onClick={onBack} data-testid="branch-detail-back"><ArrowLeft className="h-4 w-4 mr-1" />Branches</Button>}
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-slate-900">{b.branch_name}</h2>
            <p className="text-sm text-slate-500"><MapPin className="inline h-3 w-3 mr-1" />{b.address}</p>
          </div>
        </div>
        {/* Wraps rather than overflowing: three controls plus a two-part switch is more
            than a phone header holds on one line. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Spins and goes dead while the fetch is in flight. Without that this button
              had no answer at all: the page only shows "Loading branch details..." while
              `data` is still null, so on a reload — when it never is — pressing Refresh
              changed nothing on screen and read as a broken control. Disabling also stops
              a second press from racing the first, where the slower of two replies wins
              and can put older data back on the page. */}
          <Button
            className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
            data-testid="branch-detail-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          {/* The Lead Control switch used to sit here, between Refresh and Edit. It has
              moved to the Lead Management tab, where the record of past switches gives it
              the context a bare toggle in a header could not. */}
          {!readOnly && <Button variant="outline" onClick={() => setShowEdit(true)} data-testid="branch-detail-edit"><Pencil className="h-4 w-4 mr-1" />Edit</Button>}
        </div>
      </div>

      {/* Three across on a phone, so the five tabs fall 3 + 2 rather than being squeezed
          onto one line where "Lead Management" would have nowhere to go. The icon sits
          above the label and the text shrinks, which is what the Manage sub-tabs one bar
          up already do — the two share a screen and should not each solve this
          differently. Unchanged from sm up. */}
      <div className="grid grid-cols-3 gap-1 border-b border-slate-200 pb-2 sm:flex sm:flex-wrap sm:gap-2" data-testid="branch-detail-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-center text-[10px] font-semibold leading-tight transition sm:inline-flex sm:flex-row sm:gap-2 sm:px-3 sm:text-sm sm:font-medium ${active ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100"}`} data-testid={`branch-detail-tab-${t.key}`}>
              <Icon className="h-4 w-4 shrink-0" />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "summary" && <SummaryTab data={data} branchId={branchId} onChanged={load} readOnly={readOnly} />}
      {tab === "staff" && <TeamTab staff={data.staff} branchId={branchId} onChanged={load} reloadToken={reloadToken} readOnly={readOnly} />}
      {tab === "performance" && <PerformanceTab perf={data.performance} />}
      {tab === "head_physio" && <HeadPhysioTab hp={data.head_physio_section} branchId={branchId} onChanged={load} readOnly={readOnly} />}
      {tab === "lead_management" && <LeadManagementTab branch={b} branchId={branchId} onChanged={load} reloadToken={reloadToken} readOnly={readOnly} />}

      {showEdit && <BranchFormDialogV2 branch={b} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />}
    </div>
  );
};

// ---------- Summary tab ----------

const SummaryTab = ({ data, branchId, onChanged, readOnly = false }) => {
  const b = data.branch;
  const adm = data.admin_user;
  const [showEditAdmin, setShowEditAdmin] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2" data-testid="branch-summary-card">
        <CardHeader><CardTitle className="text-base">Branch Summary</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Row icon={<User className="h-4 w-4 text-slate-400" />} label="Name" value={b.branch_name} />
          <Row icon={<MapPin className="h-4 w-4 text-slate-400" />} label="Address" value={b.address} />
          <Row icon={<CalendarIcon className="h-4 w-4 text-slate-400" />} label="Opened Date" value={b.opened_date || "—"} />
          <Row icon={<Clock className="h-4 w-4 text-slate-400" />} label="Opening Hours" value={b.opening_hours || "—"} />
          <Row icon={<FileText className="h-4 w-4 text-slate-400" />} label="Vertical" value={b.vertical} />
          <Row icon={<CalendarIcon className="h-4 w-4 text-slate-400" />} label="Created" value={(b.created_at || "").slice(0, 10) || "—"} />
        </CardContent>
      </Card>

      <Card data-testid="branch-admin-card">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <CardTitle className="text-base">Branch Admin</CardTitle>
          <div className="flex gap-1">
            {!readOnly && <button onClick={() => setShowEditAdmin(true)} className="text-blue-500 hover:text-blue-700 p-1" title="Edit admin contact" data-testid="branch-admin-edit-btn"><Pencil className="h-4 w-4" /></button>}
            {!readOnly && <button onClick={() => setShowReassign(true)} className="text-sky-600 hover:text-sky-700 p-1" title={b.admin_name ? "Reassign admin" : "Assign admin"} data-testid="branch-admin-reassign-btn"><UserCog className="h-4 w-4" /></button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
              {(b.admin_name || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"}
            </div>
            <div>
              <p className={`font-semibold ${b.admin_name ? "text-slate-900" : "text-amber-600"}`}>{b.admin_name || "Not assigned yet"}</p>
              <p className="text-xs text-slate-500">{adm?.role || "branch_admin"}</p>
            </div>
          </div>
          <div className="space-y-1 pt-2 text-sm">
            {b.admin_email && <p className="flex items-center gap-2 text-slate-600"><Mail className="h-3.5 w-3.5" />{b.admin_email}</p>}
            {b.admin_phone && <p className="flex items-center gap-2 text-slate-600"><Phone className="h-3.5 w-3.5" />{b.admin_phone}</p>}
            {adm?.created_at && <p className="text-xs text-slate-400">Joined {(adm.created_at).slice(0, 10)}</p>}
            {/* The one step left on a branch that has just been created. */}
            {!b.admin_name && !readOnly && (
              <button onClick={() => setShowReassign(true)} className="text-xs font-medium text-sky-600 hover:underline" data-testid="branch-admin-assign-link">Assign Branch Admin →</button>
            )}
          </div>
        </CardContent>
      </Card>

      {showEditAdmin && <EditAdminContactDialog branch={b} onClose={() => setShowEditAdmin(false)} onSaved={() => { setShowEditAdmin(false); onChanged && onChanged(); }} />}
      {showReassign && <ReassignAdminDialog branchId={branchId} currentAdminId={b.admin_user_id} onClose={() => setShowReassign(false)} onSaved={() => { setShowReassign(false); onChanged && onChanged(); }} />}
    </div>
  );
};

const Row = ({ icon, label, value }) => (
  <div className="flex items-start gap-3">
    {icon}
    <div className="flex-1">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-sm font-medium text-slate-800">{value}</p>
    </div>
  </div>
);

// ---------- Lead Management tab ----------

const LEAD_CONTROL_LABEL = { pre_sales: "Pre Sales", branch_admin: "Branch Admin" };

/** "2026-08-15T14:05:22+05:30" -> "15 Aug 2026, 2:05 PM". The stamp as it was written. */
const formatChangedAt = (iso) => {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return iso || "—";
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;
};

/**
 * Which desk works this branch's leads, and every time that has been changed.
 *
 * The switch was a lone toggle in the page header before this. It decides where a whole
 * branch's leads live, and a control that consequential reads better next to the record of
 * when it was last thrown than tucked between Refresh and Edit.
 */
const LeadManagementTab = ({ branch, branchId, onChanged, reloadToken = 0, readOnly = false }) => {
  const [history, setHistory] = useState(null); // null = still loading, [] = never switched
  // Fetched up front, not when the dialog opens: the confirm needs the list the moment it
  // appears, and a spinner inside a decision like this one is worse than a moment's wait.
  const [preSalesMembers, setPreSalesMembers] = useState([]);

  const loadHistory = useCallback(() => {
    bmLeadControlHistory(branchId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [branchId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const loadPreSales = useCallback(() => {
    bmPreSalesMembers(branchId).then(setPreSalesMembers).catch(() => setPreSalesMembers([]));
  }, [branchId]);
  useEffect(() => { loadPreSales(); }, [loadPreSales]);

  // The header's Refresh reaching both of the above — neither rides on the page's `data`,
  // so without this the switch history stayed as it was fetched even though the button had
  // just re-read the branch the history belongs to. See the note where the token is
  // declared; the first value is skipped because the mount effects have already fetched.
  const reloadSeen = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === reloadSeen.current) return;
    reloadSeen.current = reloadToken;
    loadHistory();
    loadPreSales();
  }, [reloadToken, loadHistory, loadPreSales]);

  const current = normalizeLeadControl(branch.lead_control);

  return (
    <div className="space-y-4" data-testid="branch-lead-management-tab">
      <Card>
        <CardHeader><CardTitle className="text-base">Lead Control</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            {current === "branch_admin"
              ? "This branch works its own leads. They skip the Pre-Sales desk and go straight to the Branch Admin, who handles the Pre-Sales stages as well."
              : "The Pre-Sales desk qualifies this branch's leads first, and hands each one over once an appointment is booked."}
          </p>
          {/* Reloads the table on change as well as the branch, so the switch just thrown
              shows up as the newest row without needing the tab reopened. */}
          <HeaderLeadControl
            branch={branch}
            preSalesMembers={preSalesMembers}
            onChanged={() => { onChanged && onChanged(); loadHistory(); }}
            readOnly={readOnly}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Switch History</CardTitle></CardHeader>
        <CardContent>
          {history === null ? (
            <p className="text-sm text-slate-500" data-testid="lead-control-history-loading">Loading…</p>
          ) : history.length === 0 ? (
            // Says "not seen" rather than "never happened": switches made before this was
            // recorded left no trace, and the table should not claim otherwise.
            <p className="text-sm text-slate-500" data-testid="lead-control-history-empty">
              No switches recorded for this branch yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] divide-y divide-slate-200 text-sm" data-testid="lead-control-history-table">
                <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Date &amp; Time</th>
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">To</th>
                    <th className="px-3 py-2">Handed To</th>
                    <th className="px-3 py-2">Changed By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((row) => (
                    <tr key={row.id} data-testid={`lead-control-history-row-${row.id}`}>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-700">{formatChangedAt(row.changed_at)}</td>
                      <td className="px-3 py-2 text-slate-500">{LEAD_CONTROL_LABEL[row.from_control] || row.from_control || "—"}</td>
                      <td className="px-3 py-2">
                        <span className="rounded-[5px] border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                          {LEAD_CONTROL_LABEL[row.to_control] || row.to_control || "—"}
                        </span>
                      </td>
                      {/* Only a hand-back to Pre-Sales names someone. Going the other way
                          the branch takes its own leads, so there is nobody to name. */}
                      <td className="px-3 py-2 text-slate-600">{row.assigned_to_name || "—"}</td>
                      <td className="px-3 py-2 text-slate-600">{row.changed_by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

/**
 * The Lead Control switch itself, saving on confirm.
 *
 * Optimistic: the switch moves as soon as the dialog is accepted and reverts if the
 * save fails. The confirm has already made this a deliberate act, so the control
 * should look decided rather than sitting inert through a round trip; the failure
 * path is a toast plus the old value back.
 */
const HeaderLeadControl = ({ branch, onChanged, readOnly = false, preSalesMembers = null }) => {
  const [value, setValue] = useState(normalizeLeadControl(branch.lead_control));
  const [saving, setSaving] = useState(false);

  // The parent reloads after a save, and Edit > Branch Details can change this too.
  useEffect(() => { setValue(normalizeLeadControl(branch.lead_control)); }, [branch.lead_control]);

  const pick = async (next, assigneeId = null) => {
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      await updateBranch(branch.id, {
        lead_control: next,
        ...(assigneeId ? { lead_control_assignee_id: assigneeId } : {}),
      });
      toast.success(next === "branch_admin" ? "Leads now go straight to the Branch Admin" : "Leads now start with Pre-Sales");
      onChanged && onChanged();
    } catch (e) {
      setValue(prev);
      toast.error(e?.response?.data?.detail || "Could not change Lead Control");
    }
    setSaving(false);
  };

  return (
    <LeadControlSwitch
      value={value}
      onChange={pick}
      busy={saving}
      disabled={readOnly}
      confirm
      branchName={branch.branch_name}
      preSalesMembers={preSalesMembers}
      size="sm"
      testid="branch-detail-lead-control"
    />
  );
};

// ---------- Team tab ----------

const initials = (name) => (name || "?").split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/**
 * The desks a branch is staffed by.
 *
 * `key` is what the posting endpoints take: which roles count as this desk is decided
 * server-side, in _desk_holds, so the two sides cannot disagree about whether an Online
 * Physio Admin belongs on Branch Admin or a diet_manage on Diet.
 *
 * `from` is which list on the branch's payload holds them. Pre Sales comes from its own
 * endpoint rather than the branch's staff, because a Pre-Sales rep works a branch's leads
 * without being posted to the branch.
 */
const TEAM_DESKS = [
  { key: "pre_sales", label: "Pre Sales", from: "preSales" },
  { key: "branch_admins", label: "Branch Admin", from: "branch_admins" },
  { key: "head_physios", label: "Consultants", from: "head_physios" },
  { key: "physios", label: "Physio", from: "physios" },
  { key: "diet", label: "Diet", from: "diet" },
  { key: "zumba", label: "Zumba", from: "zumba" },
];

/**
 * Everyone working this branch.
 *
 * "All" keeps the card-per-desk overview this tab has always been. The per-desk tabs are
 * for working on one: the same people with their contact details spelled out, an Edit on
 * each and an Add for the desk, so staffing a branch does not mean leaving for HR Admin
 * and finding your way back.
 *
 * Read-only for a Branch Admin looking at their own branch through the Manager view —
 * creating and editing logins is Super Admin's, and the endpoints refuse anyone else, so
 * the buttons are not offered rather than offered and refused.
 */
const TeamTab = ({ staff, branchId, onChanged, reloadToken = 0, readOnly = false }) => {
  const [preSalesMembers, setPreSalesMembers] = useState([]);
  const [desk, setDesk] = useState("all");
  const [editing, setEditing] = useState(null);   // a user row
  const [adding, setAdding] = useState(null);     // a TEAM_DESKS entry
  const [removing, setRemoving] = useState(null); // a user row
  const [deleting, setDeleting] = useState(null); // a user row, permanent delete
  const [removeBusy, setRemoveBusy] = useState(false);

  const loadPreSales = useCallback(() => {
    bmPreSalesMembers(branchId).then(setPreSalesMembers).catch(() => setPreSalesMembers([]));
  }, [branchId]);
  useEffect(() => { loadPreSales(); }, [loadPreSales]);

  // The header's Refresh reaching this list. It is fetched here rather than carried on the
  // page's `data`, so a reload of the same branch changes nothing this effect watches and
  // the desk kept showing what it held when the tab was opened. Same shape as the token
  // ConsultationsBoard takes from the Branch Admin toolbar: the first value is skipped
  // because the mount effect above has already fetched.
  const reloadSeen = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === reloadSeen.current) return;
    reloadSeen.current = reloadToken;
    loadPreSales();
  }, [reloadToken, loadPreSales]);

  const groups = TEAM_DESKS.map((d) => ({
    ...d,
    items: (d.from === "preSales" ? preSalesMembers : staff[d.from]) || [],
  }));
  const active = groups.find((g) => g.key === desk) || null;

  // Both lists reload: a new Physio changes the branch's staff, and a new Pre-Sales rep
  // changes only the separately-fetched list, so refreshing one of the two would leave
  // whichever desk was used looking like the save had not worked.
  const afterSave = () => { setEditing(null); setAdding(null); setRemoving(null); setDeleting(null); loadPreSales(); onChanged && onChanged(); };

  const doRemove = async () => {
    setRemoveBusy(true);
    try {
      const res = await bmTeamRemove(branchId, removing.id, desk);
      toast.success(res?.message || "Removed from this branch");
      afterSave();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not remove");
    }
    setRemoveBusy(false);
  };

  // One row per person, whichever desk they sit at, so the branch reads as a directory
  // rather than as five card stacks visited one at a time. The desk pills narrow this one
  // list now instead of switching between two different layouts.
  //
  // Deduped by id: the desk predicates are not mutually exclusive by construction, and a
  // role matching two of them would otherwise be listed twice with two sets of controls.
  const rows = (() => {
    const source = desk === "all" ? groups : groups.filter((g) => g.key === desk);
    const seen = new Set();
    const out = [];
    source.forEach((g) => {
      (g.items || []).forEach((u) => {
        if (seen.has(u.id)) return;
        seen.add(u.id);
        out.push({ ...u, deskKey: g.key, deskLabel: g.label });
      });
    });
    return out;
  })();

  const deskTabs = [{ key: "all", label: "All", items: groups.flatMap((g) => g.items) }, ...groups];

  const runAction = async (label, fn) => {
    try {
      await fn();
      toast.success(label);
      afterSave();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Could not ${label.toLowerCase()}`);
    }
  };

  return (
    <div className="space-y-3" data-testid="branch-team-tab">
      {/* On a phone the desk pills fold into one dropdown — wrapped, they took three ragged
          rows — and the strip's own box goes with them, since the dropdown carries its own.
          From sm up the pills are unchanged. */}
      <div className="flex flex-wrap items-center gap-1.5 sm:rounded-lg sm:border sm:border-slate-200 sm:bg-white sm:p-1" data-testid="branch-team-desks">
        <FilterSelect
          value={desk}
          onChange={setDesk}
          active={desk !== "all"}
          label="Desk"
          className="flex-1 sm:hidden"
          testid="branch-team-desk-select"
        >
          {deskTabs.map((g) => <option key={g.key} value={g.key}>{g.label} ({g.items.length})</option>)}
        </FilterSelect>
        {deskTabs.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setDesk(g.key)}
            className={`hidden shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition sm:inline-flex ${
              desk === g.key ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
            data-testid={`branch-team-desk-${g.key}`}
          >
            {g.label}
            <span className={`rounded px-1.5 py-px text-[10px] font-bold ${desk === g.key ? "bg-white/25" : "bg-slate-100 text-slate-500"}`}>
              {g.items.length}
            </span>
          </button>
        ))}
        {/* Add posts someone to the desk being shown, so it appears once a desk is chosen —
            on All there is no one desk for a new person to join. */}
        {!readOnly && active && (
          <Button size="sm" className="ml-auto bg-sky-600 text-white hover:bg-sky-700" onClick={() => setAdding(active)} data-testid={`branch-team-add-${active.key}`}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add {active.label}
          </Button>
        )}
      </div>

      <Card data-testid="branch-team-directory">
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-3 py-12 text-center text-sm text-slate-400">Nobody at this branch yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-[5%] px-3 py-2.5">S.No</th>
                    <th className="w-[27%] px-3 py-2.5">Name</th>
                    <th className="w-[15%] px-3 py-2.5">Desk</th>
                    <th className="w-[13%] px-3 py-2.5">Role</th>
                    <th className="w-[10%] px-3 py-2.5">Status</th>
                    <th className="w-[30%] px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((u, i) => {
                    // Absent reads as active: a Pre-Sales row comes from its own endpoint
                    // and does not always carry the flag, and defaulting it off would show
                    // that whole desk as inactive.
                    const isActive = u.is_active !== false;
                    return (
                      <tr key={u.id} className={`align-middle hover:bg-slate-50/60 ${isActive ? "" : "bg-slate-50/40"}`} data-testid={`branch-team-row-${u.id}`}>
                        <td className="px-3 py-3 text-xs text-slate-400">{i + 1}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${isActive ? "bg-slate-100 text-slate-600" : "bg-slate-200 text-slate-400"}`}>{initials(u.full_name)}</span>
                            <div className="min-w-0">
                              <p className={`truncate font-semibold ${isActive ? "text-slate-800" : "text-slate-400"}`} title={u.full_name}>{u.full_name || "—"}</p>
                              <p className="truncate text-[11px] text-slate-500" title={u.email}>{u.email || u.specialization || "—"}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-600">{u.deskLabel}</td>
                        <td className="px-3 py-3">
                          {/* The stored slug, prettied. A Branch Admin (Physio) reads as
                              what they are rather than as a bare "Branch Admin". */}
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                            {String(u.role || u.profile_type || "—").replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-500"}`} data-testid={`branch-team-status-${u.id}`}>
                            {isActive ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          {readOnly ? (
                            <span className="text-xs text-slate-300">—</span>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setEditing(u)} data-testid={`branch-team-edit-${u.id}`}>
                                <Pencil className="mr-1 h-3 w-3" /> Edit
                              </Button>
                              {/* Switching off keeps the account and its history and stops
                                  it being offered anywhere. The row stays, greyed, which is
                                  the whole reason this list carries inactive people. */}
                              <Button
                                size="sm"
                                variant="outline"
                                className={`h-7 text-[11px] ${isActive ? "border-amber-200 text-amber-700 hover:bg-amber-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                                onClick={() => runAction(isActive ? "Deactivated" : "Activated", () => (isActive ? hrDeactivateUser(u.id) : hrActivateUser(u.id)))}
                                data-testid={`branch-team-toggle-${u.id}`}
                              >
                                <Power className="mr-1 h-3 w-3" />{isActive ? "Deactivate" : "Activate"}
                              </Button>
                              {/* Off this branch, not out of the OS — the account survives
                                  and can be posted to another branch. */}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50"
                                onClick={() => setRemoving(u)}
                                data-testid={`branch-team-archive-${u.id}`}
                              >
                                <Archive className="mr-1 h-3 w-3" /> Archive
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-rose-200 text-[11px] text-rose-700 hover:bg-rose-50"
                                onClick={() => setDeleting(u)}
                                data-testid={`branch-team-delete-${u.id}`}
                              >
                                <Trash2 className="mr-1 h-3 w-3" /> Delete
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete is the one that cannot be undone, so it asks in its own words rather than
          sharing the Archive confirmation. */}
      {deleting && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" data-testid="branch-team-delete-dialog">
          <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100">
                <Trash2 className="h-5 w-5 text-rose-600" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900">Delete this account?</h3>
                <p className="mt-1 text-xs text-slate-500">
                  <b className="text-slate-700">{deleting.full_name}</b> is removed from the OS permanently, along with the expert record holding their calendar. This cannot be undone — Deactivate keeps the account and stops them being offered anywhere.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setDeleting(null)} data-testid="branch-team-delete-cancel">Cancel</Button>
              <Button
                size="sm"
                className="bg-rose-600 hover:bg-rose-700"
                onClick={() => { const u = deleting; setDeleting(null); runAction("Deleted", () => hrDeleteUserPermanent(u.id)); }}
                data-testid="branch-team-delete-confirm"
              >
                Yes, Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <TeamMemberDialog
          user={editing}
          branchId={branchId}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}

      {adding && (
        <TeamAddDialog
          desk={adding}
          branchId={branchId}
          onClose={() => setAdding(null)}
          onSaved={afterSave}
        />
      )}

      {removing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setRemoving(null); }}>
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl" data-testid="branch-team-remove-dialog">
            <div className="border-b p-5">
              <h3 className="text-base font-semibold text-slate-800">Remove {removing.full_name}?</h3>
              {/* Says what it does not do. "Remove" beside a person reads as deletion, and
                  this only ends a posting — the login and its role are untouched. */}
              <p className="mt-1 text-[11px] text-slate-500">
                They come off this branch's {active?.label} desk. Their login and role stay as they are —
                switch an account off in HR Admin → Credentials.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t p-4">
              <Button variant="outline" size="sm" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancel</Button>
              <Button size="sm" onClick={doRemove} disabled={removeBusy} className="bg-rose-600 text-white hover:bg-rose-700" data-testid="branch-team-remove-confirm">
                {removeBusy ? "Removing..." : "Remove from branch"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Pick somebody who already has the role and post them to this branch.
 *
 * Deliberately a picker, not a create form. An account is made once, in HR Admin → Roles &
 * Credentials, where the whole role list and every field is on screen; what a branch needs
 * from this page is to say who works here. Making logins in two places is how you end up
 * with the same person twice.
 *
 * The list is org-wide, because the point is to bring in somebody who is elsewhere. Where
 * each one currently sits is shown, since for a single-branch role picking them moves them
 * off it — that should be read before clicking, not discovered afterwards.
 */
const TeamAddDialog = ({ desk, branchId, onClose, onSaved }) => {
  const [state, setState] = useState({ loading: true, failed: false, candidates: [] });
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    bmTeamCandidates(branchId, desk.key)
      .then((d) => { if (alive) setState({ loading: false, failed: false, candidates: d.candidates || [] }); })
      .catch((e) => {
        if (!alive) return;
        setState({ loading: false, failed: true, candidates: [] });
        // The Consultants desk answers 400 here with the reason, which is worth reading
        // rather than showing as a generic failure.
        const msg = e?.response?.data?.detail;
        if (msg) toast.error(msg, { duration: 7000 });
      });
    return () => { alive = false; };
  }, [branchId, desk.key]);

  const shown = state.candidates.filter((c) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (c.full_name || "").toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q);
  });

  const pick = async (c) => {
    setBusyId(c.id);
    try {
      const res = await bmTeamAdd(branchId, c.id, desk.key);
      toast.success(res?.message || "Added to this branch");
      // Said plainly when a single-branch account was taken off somewhere to come here.
      if (res?.moved_from_branch_id && c.current_branches?.length) {
        toast.info(`${c.full_name} no longer works at ${c.current_branches.join(", ")}`, { duration: 7000 });
      }
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add");
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl" data-testid="branch-team-add-dialog">
        <div className="border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">Add {desk.label}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Everyone with this role who isn't already at this branch. Click one to post them here.
          </p>
        </div>

        <div className="border-b px-5 py-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email..." data-testid="branch-team-add-search" />
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {state.loading ? (
            <p className="py-10 text-center text-sm text-slate-400">Loading...</p>
          ) : state.failed ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
              Couldn't load the list.
            </p>
          ) : shown.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
              {state.candidates.length === 0
                // Two different empties: nobody holds the role anywhere, versus the search
                // matching nothing. The first one needs HR, the second needs a backspace.
                ? <>No other {desk.label.toLowerCase()} accounts exist. Create one in HR Admin → Credentials, then add them here.</>
                : "Nobody matches that search."}
            </p>
          ) : (
            <div className="space-y-2" data-testid="branch-team-add-list">
              {shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={!!busyId}
                  onClick={() => pick(c)}
                  className="flex w-full items-center gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-sky-400 hover:bg-sky-50/40 disabled:opacity-50"
                  data-testid={`branch-team-add-pick-${c.id}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">{initials(c.full_name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-800">{c.full_name}</span>
                    <span className="block truncate text-[11px] text-slate-500">{c.email}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-semibold text-slate-600">{String(c.role || "").replace(/_/g, " ")}</span>
                      {c.current_branches?.length > 0 && (
                        <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${c.multi_branch ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                          {c.multi_branch ? "also at" : "moves from"} {c.current_branches.join(", ")}
                        </span>
                      )}
                    </span>
                  </span>
                  {busyId === c.id && <span className="shrink-0 text-[11px] text-slate-400">Adding...</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t p-4">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
};

/**
 * Correct a member's own details — name, email, phone.
 *
 * Goes through HR's user endpoint, so this is the same account Credentials manages
 * rather than a second kind of user only this page understands.
 *
 * Role and branch are not here. Which branch somebody works at is what Add and Remove on
 * the desk do, and changing what somebody *is* runs through its own endpoint and belongs
 * where the whole role list is on screen.
 */
const TeamMemberDialog = ({ user, onClose, onSaved }) => {
  const [form, setForm] = useState({
    full_name: user.full_name || "",
    email: user.email || "",
    mobile_number: user.mobile_number || user.phone || "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.full_name.trim()) { toast.error("Name is required"); return; }
    if (!form.email.trim()) { toast.error("Email is required"); return; }
    setSaving(true);
    try {
      await hrUpdateUser(user.id, {
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        mobile_number: form.mobile_number.trim() || undefined,
      });
      toast.success(`${form.full_name.trim()} updated`);
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not update");
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl" data-testid="branch-team-member-dialog">
        <div className="border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">Edit {user.full_name || "member"}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Name, email and phone. Their role is changed in HR Admin → Credentials.
          </p>
        </div>

        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Full Name *</label>
            <Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} autoFocus data-testid="branch-team-name" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Email *</label>
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="branch-team-email" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Phone</label>
            <Input value={form.mobile_number} onChange={(e) => set("mobile_number", e.target.value)} placeholder="+91 ..." data-testid="branch-team-phone" />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="branch-team-save">
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
};

// ---------- Performance tab ----------

const PerformanceTab = ({ perf }) => {
  const [sub, setSub] = useState("appointments");
  const groups = [
    { key: "appointments", label: "Appointments", icon: CalendarIcon, badge: perf.appointments.total },
    { key: "consultations", label: "Consultations", icon: Stethoscope, badge: perf.consultations.total_count },
    { key: "packages", label: "Packages", icon: Wallet, badge: perf.packages.total_count },
    { key: "followups", label: "Follow-ups", icon: ListChecks, badge: perf.follow_ups.total },
  ];
  return (
    <div className="space-y-4" data-testid="branch-performance-tab">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiBig label="Total Leads" value={perf.kpis.leads_total} color="#0ea5e9" />
        <KpiBig label="Open" value={perf.kpis.leads_open} color="#f59e0b" />
        <KpiBig label="Completed" value={perf.kpis.leads_completed} color="#22c55e" />
      </div>
      <div className="flex flex-wrap gap-2 rounded-lg bg-slate-100 p-1">
        {groups.map((g) => {
          const Icon = g.icon;
          return (
            <button key={g.key} onClick={() => setSub(g.key)} className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${sub === g.key ? "bg-white text-slate-900 shadow" : "text-slate-600"}`} data-testid={`branch-perf-sub-${g.key}`}>
              <Icon className="h-4 w-4" />{g.label}<span className="ml-1 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{g.badge}</span>
            </button>
          );
        })}
      </div>

      {sub === "appointments" && (
        <Card data-testid="branch-perf-appointments">
          <CardHeader><CardTitle className="text-base">Appointments</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-3 grid gap-2 sm:grid-cols-4">
              <Mini label="Total" value={perf.appointments.total} color="#0ea5e9" />
              <Mini label="Scheduled" value={perf.appointments.scheduled} color="#f59e0b" />
              <Mini label="Completed" value={perf.appointments.completed} color="#22c55e" />
              <Mini label="Cancelled" value={perf.appointments.cancelled} color="#ef4444" />
            </div>
            <ListTable rows={perf.appointments.list} columns={[
              { key: "patient_name", label: "Patient" },
              { key: "appointment_time", label: "Date/Time", fmt: (v) => (v ? `${v.slice(0, 10)} ${slotTo12h(v)}` : "") },
              { key: "doctor_name", label: "Doctor" },
              { key: "status", label: "Status" },
            ]} empty="No appointments." testid="branch-perf-appt-table" />
          </CardContent>
        </Card>
      )}

      {sub === "consultations" && (
        <Card data-testid="branch-perf-consultations">
          <CardHeader><CardTitle className="text-base">Consultations</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <Mini label="Consultations" value={perf.consultations.total_count} color="#0ea5e9" />
              <Mini label="Revenue ₹" value={Number(perf.consultations.total_amount || 0).toLocaleString("en-IN")} color="#22c55e" />
            </div>
            <ListTable rows={perf.consultations.list} columns={[
              { key: "name", label: "Patient" },
              { key: "phone", label: "Phone" },
              { key: "consultation_fee", label: "Fee ₹", fmt: (v) => `₹${Number(v || 0).toLocaleString("en-IN")}` },
              { key: "stage", label: "Stage" },
            ]} empty="No consultations." testid="branch-perf-cons-table" />
          </CardContent>
        </Card>
      )}

      {sub === "packages" && (
        <Card data-testid="branch-perf-packages">
          <CardHeader><CardTitle className="text-base">Package Selling</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <Mini label="Packages Sold" value={perf.packages.total_count} color="#a855f7" />
              <Mini label="Revenue ₹" value={Number(perf.packages.total_amount || 0).toLocaleString("en-IN")} color="#22c55e" />
            </div>
            <ListTable rows={perf.packages.list} columns={[
              { key: "name", label: "Patient" },
              { key: "package_weeks", label: "Weeks" },
              { key: "package_amount", label: "Amount", fmt: (v) => `₹${Number(v || 0).toLocaleString("en-IN")}` },
              { key: "stage", label: "Stage" },
            ]} empty="No packages sold." testid="branch-perf-pkg-table" />
          </CardContent>
        </Card>
      )}

      {sub === "followups" && (
        <Card data-testid="branch-perf-followups">
          <CardHeader><CardTitle className="text-base">Follow-ups</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-3 grid gap-2 sm:grid-cols-3">
              <Mini label="Total" value={perf.follow_ups.total} color="#0ea5e9" />
              <Mini label="Open" value={perf.follow_ups.open} color="#f59e0b" />
              <Mini label="Done" value={perf.follow_ups.done} color="#22c55e" />
            </div>
            <ListTable rows={perf.follow_ups.list} columns={[
              { key: "lead_name", label: "Patient" },
              { key: "follow_up_date", label: "Date", fmt: (v) => (v || "").slice(0, 10) },
              { key: "note", label: "Note" },
              { key: "completed", label: "Status", fmt: (v) => (v ? "Done" : "Open") },
            ]} empty="No follow-ups." testid="branch-perf-fu-table" />
          </CardContent>
        </Card>
      )}
    </div>
  );
};

// ---------- Head Physio tab ----------

const HeadPhysioTab = ({ hp, branchId, onChanged, readOnly = false }) => {
  const [showAssign, setShowAssign] = useState(false);
  return (
  <div className="space-y-4" data-testid="branch-head-physio-tab">
    <div className="grid gap-3 sm:grid-cols-2">
      <Card data-testid="branch-hp-calendars">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">CONSULTANT Calendars</CardTitle>
          {!readOnly && <button onClick={() => setShowAssign(true)} className="text-sky-600 hover:text-sky-700 p-1" title="Assign a CONSULTANT" data-testid="branch-hp-assign-btn"><UserCog className="h-4 w-4" /></button>}
        </CardHeader>
        <CardContent>
          {hp.calendars.length === 0 ? <p className="text-sm text-slate-400">No CONSULTANT assigned yet. Click the assign icon above to link an unassigned CONSULTANT from HR → Credentials.</p> : (
            <div className="space-y-2">
              {hp.calendars.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-md border border-slate-200 p-3" data-testid={`branch-hp-cal-${d.id}`}>
                  <div>
                    <p className="text-sm font-semibold">{d.full_name}</p>
                    <p className="text-xs text-slate-500">{d.specialization || "CONSULTANT"}</p>
                    <p className="text-[11px] text-slate-400">{(d.slots || []).length} time slots configured</p>
                  </div>
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600">{d.profile_type}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card data-testid="branch-hp-physio-cal">
        <CardHeader><CardTitle className="text-base">Physio Calendars</CardTitle></CardHeader>
        <CardContent>
          {hp.physio_calendars.length === 0 ? <p className="text-sm text-slate-400">No Physio calendars yet.</p> : (
            <div className="space-y-2">
              {hp.physio_calendars.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-md border border-slate-200 p-3" data-testid={`branch-hp-pcal-${d.id}`}>
                  <div>
                    <p className="text-sm font-semibold">{d.full_name}</p>
                    <p className="text-xs text-slate-500">{d.specialization || "Physio"}</p>
                    <p className="text-[11px] text-slate-400">{(d.slots || []).length} time slots configured</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>

    <Card data-testid="branch-hp-post-treatment">
      <CardHeader><CardTitle className="text-base">Post-Treatment Reviews (Weekly Assessments)</CardTitle></CardHeader>
      <CardContent>
        {hp.post_treatment_reviews.length === 0 ? <p className="text-sm text-slate-400">No post-treatment reviews yet.</p> : (
          <div className="space-y-2">
            {hp.post_treatment_reviews.slice(0, 25).map((r, i) => (
              <div key={`${r.lead_id}-${r.week ?? i}`} className="rounded-md border border-slate-200 p-3" data-testid={`branch-hp-review-${r.lead_id}-${r.week ?? i}`}>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-800">{r.lead_name}</p>
                  <span className="rounded bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-600">Week {r.week ?? "?"}</span>
                </div>
                {r.notes && <p className="text-xs text-slate-600">{r.notes}</p>}
                {r.recommendation && <p className="mt-1 text-xs italic text-slate-500">Rec: {r.recommendation}</p>}
                {r.created_at && <p className="mt-1 text-[10px] text-slate-400">{(r.created_at).slice(0, 16).replace("T", " ")}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>

    {showAssign && <AssignHeadPhysioDialog branchId={branchId} onClose={() => setShowAssign(false)} onSaved={() => { setShowAssign(false); onChanged && onChanged(); }} />}
  </div>
  );
};

const AssignHeadPhysioDialog = ({ branchId, onClose, onSaved }) => {
  const [candidates, setCandidates] = useState([]);
  const [pick, setPick] = useState("");
  useEffect(() => { bmHeadPhysioCandidates().then(setCandidates).catch((e) => console.warn("[load hp candidates]", e?.message || e)); }, []);
  const available = candidates.filter((c) => c.branch_id !== branchId);

  const save = async () => {
    if (!pick) { toast.error("Pick a CONSULTANT"); return; }
    try { await bmAssignHeadPhysio(branchId, pick); toast.success("CONSULTANT assigned"); onSaved(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Assign failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="branch-hp-assign-dialog">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Assign CONSULTANT</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="branch-hp-assign-close"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-slate-500">Showing all CONSULTANTS from HR → Credentials. Picking one already assigned elsewhere moves them here.</p>
        <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="branch-hp-assign-select">
          <option value="">— Select CONSULTANT —</option>
          {available.length === 0 && <option disabled>No other CONSULTANTS — create one in HR</option>}
          {available.map((c) => <option key={c.id} value={c.id}>{c.full_name}{c.assigned_branch ? ` · currently at ${c.assigned_branch}` : " · unassigned"}</option>)}
        </select>
        <div className="flex gap-2 pt-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="branch-hp-assign-cancel">Cancel</Button><Button onClick={save} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="branch-hp-assign-submit">Assign</Button></div>
      </div>
    </div>
  );
};

// ---------- shared ----------

const KpiBig = ({ label, value, color }) => (
  <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderLeftColor: color, borderLeftWidth: 4 }}>
    <p className="text-xs text-slate-500">{label}</p>
    <p className="mt-1 text-3xl font-bold" style={{ color }}>{value}</p>
  </div>
);

const Mini = ({ label, value, color }) => (
  <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-center">
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-1 text-lg font-bold" style={{ color }}>{value}</p>
  </div>
);

const ListTable = ({ rows, columns, empty, testid }) => (
  <div className="overflow-auto rounded-md border border-slate-200" data-testid={testid}>
    <table className="min-w-full text-xs">
      <thead className="bg-slate-50 text-left text-slate-500">
        <tr>{columns.map((c) => <th key={c.key} className="px-3 py-2 font-semibold uppercase tracking-wide">{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={columns.length} className="px-3 py-4 text-center text-slate-400">{empty}</td></tr> :
          rows.map((r, i) => (
            <tr key={r.id || i} className="border-t border-slate-100">
              {columns.map((c) => <td key={c.key} className="px-3 py-2 text-slate-700">{c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? "—")}</td>)}
            </tr>
          ))}
      </tbody>
    </table>
  </div>
);

const EditMetaDialog = ({ branch, onClose, onSaved }) => {
  const [form, setForm] = useState({
    branch_name: branch.branch_name || "",
    address: branch.address || "",
    admin_phone: branch.admin_phone || "",
    opened_date: branch.opened_date || "",
    opening_hours: branch.opening_hours || "",
    vertical: branch.vertical || "offline_physiotherapy",
  });
  const save = async () => {
    if (!form.branch_name.trim()) { toast.error("Branch name required"); return; }
    try {
      await updateBranch(branch.id, form);
      toast.success("Branch updated");
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="branch-edit-meta-dialog">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl space-y-3">
        <h3 className="text-base font-semibold">Edit Branch — {branch.branch_name}</h3>
        <Input value={form.branch_name} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} placeholder="Name" data-testid="branch-edit-name" />
        <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Address" data-testid="branch-edit-address" />
        <MilkDateInput  value={form.opened_date} onChange={(e) => setForm({ ...form, opened_date: e.target.value })} placeholder="Opened Date" data-testid="branch-edit-opened" />
        <Input value={form.opening_hours} onChange={(e) => setForm({ ...form, opening_hours: e.target.value })} placeholder="Opening Hours (e.g. Mon-Sat 7am-9pm)" data-testid="branch-edit-hours" />
        <Input value={form.admin_phone} onChange={(e) => setForm({ ...form, admin_phone: e.target.value })} placeholder="Admin Phone" data-testid="branch-edit-phone" />
        <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value })} data-testid="branch-edit-vertical">
          <option value="offline_physiotherapy">Offline Physiotherapy</option>
          <option value="online_physiotherapy">Online Physiotherapy</option>
          <option value="fitness">Fitness</option>
        </select>
        <div className="flex gap-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="branch-edit-cancel">Cancel</Button><Button onClick={save} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="branch-edit-submit">Save</Button></div>
      </div>
    </div>
  );
};

const Field = ({ label, children, className = "" }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="text-xs font-medium text-slate-700">{label}</label>
    {children}
  </div>
);

const EditAdminContactDialog = ({ branch, onClose, onSaved }) => {
  const [form, setForm] = useState({
    admin_name: branch.admin_name || "",
    admin_email: branch.admin_email || "",
    admin_phone: branch.admin_phone || "",
  });
  const save = async () => {
    if (!form.admin_name.trim()) { toast.error("Admin name required"); return; }
    try {
      await updateBranch(branch.id, form);
      toast.success("Admin contact updated");
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="branch-admin-edit-dialog">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Edit Branch Admin Contact</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="branch-admin-edit-close"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-slate-500">Updates the contact info shown on this branch (does not change the user's login credentials — manage those in HR → Credentials).</p>
        <Field label="Display Name"><Input value={form.admin_name} onChange={(e) => setForm({ ...form, admin_name: e.target.value })} data-testid="branch-admin-edit-name" /></Field>
        <Field label="Email"><Input value={form.admin_email} onChange={(e) => setForm({ ...form, admin_email: e.target.value })} placeholder="admin@example.com" data-testid="branch-admin-edit-email" /></Field>
        <Field label="Phone"><Input value={form.admin_phone} onChange={(e) => setForm({ ...form, admin_phone: e.target.value })} placeholder="+91 …" data-testid="branch-admin-edit-phone" /></Field>
        <div className="flex gap-2 pt-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="branch-admin-edit-cancel">Cancel</Button><Button onClick={save} className="flex-1 bg-blue-600 hover:bg-blue-700" data-testid="branch-admin-edit-submit">Save</Button></div>
      </div>
    </div>
  );
};

const ReassignAdminDialog = ({ branchId, currentAdminId, onClose, onSaved }) => {
  const [candidates, setCandidates] = useState([]);
  const [pick, setPick] = useState(currentAdminId || "");
  useEffect(() => { hrBranchAdminCandidates().then(setCandidates).catch((e) => console.warn("[load candidates]", e?.message || e)); }, []);
  const available = candidates.filter((c) => !c.assigned_branch || c.id === currentAdminId);

  const assigned = !!currentAdminId;

  const save = async () => {
    if (!pick) { toast.error("Pick a manager"); return; }
    if (pick === currentAdminId) { toast.error("Already assigned to this branch"); return; }
    try { await bmReassignAdmin(branchId, pick); toast.success(assigned ? "Manager reassigned" : "Branch Admin assigned"); onSaved(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Reassign failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="branch-admin-reassign-dialog">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{assigned ? "Reassign Branch Admin" : "Assign Branch Admin"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="branch-admin-reassign-close"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-slate-500">Only users with role <span className="font-semibold">branch_admin</span> who aren't already running another branch can be picked. Create more in HR → Credentials.</p>
        <select className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="branch-admin-reassign-select">
          <option value="">— Select branch admin —</option>
          {available.length === 0 && <option disabled>No unassigned Branch Admin — add the employee in HR → Credentials first</option>}
          {available.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.email}{c.id === currentAdminId ? " (current)" : ""}</option>)}
        </select>
        <div className="flex gap-2 pt-2"><Button variant="outline" onClick={onClose} className="flex-1" data-testid="branch-admin-reassign-cancel">Cancel</Button><Button onClick={save} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="branch-admin-reassign-submit">{assigned ? "Reassign" : "Assign"}</Button></div>
      </div>
    </div>
  );
};

export default BranchDetailPage;
