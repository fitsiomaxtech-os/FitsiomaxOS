import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Plus, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { bmTeamAdd, getTeam } from "@/lib/api";
import { displayPhone, telNumber } from "@/lib/phone";
import { TeamAddDialog } from "@/components/branch/BranchDetailPage";

/**
 * Activity Care's Team Consultants and Team Physio tabs: every consultant, or every physio,
 * in the organisation, one to a row — S.No, name, own branch, the branches they collaborate
 * with, phone, gender, status, an Add and an arrow — narrowed by a search, by branch and by gender. The toolbar's Add picks a branch
 * and then a person; a row's Add has the person and picks the branch. Either way they gain
 * the branch and keep the ones they already have.
 */
// desk: the Branch Manager Team desk that posts them, which Add goes through.
const KINDS = {
  consultants: { plural: "consultants", desk: { key: "head_physios", label: "Consultant" } },
  physio: { plural: "physios", desk: { key: "physios", label: "Physio" } },
};

const GENDER_LABEL = { male: "Male", female: "Female", other: "Other" };
const GENDER_CHIP = { male: "bg-sky-50 text-sky-700", female: "bg-pink-50 text-pink-700", other: "bg-violet-50 text-violet-700" };

// Others is everyone the first two don't take, unrecorded included: otherwise a person HR
// never gave a gender would be under All and nowhere else.
const genderMatches = (filter, gender) =>
  filter === "all" || (filter === "other" ? gender !== "male" && gender !== "female" : gender === filter);

const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "");

/**
 * The OS's own dropdown, as Branch Leads' list filters wear it: sky while it is narrowing the
 * list, plain while it is on its "all" answer, and a capped menu that scrolls.
 */
const FilterSelect = ({ value, onChange, allLabel, options, label, testid }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger
      title={label}
      aria-label={label}
      className={`h-9 min-w-0 flex-1 rounded-md border px-2.5 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 lg:w-36 lg:flex-none ${
        value !== "all" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
      data-testid={testid}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent className="max-h-72 border-slate-200" data-testid={`${testid}-menu`}>
      <SelectItem value="all" className="text-xs font-medium text-slate-500">{allLabel}</SelectItem>
      {options.map(([v, text]) => (
        <SelectItem key={v} value={v} className="text-xs text-slate-700">{text}</SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const branchText = (m) => (m.all_branches ? "All Branches" : m.branches.map((b) => b.name).join(", ") || "—");

// The branch they were hired into, boxed in orange; a Super Admin taking consultations
// belongs to every branch, so theirs reads All Branches. Branch tags share one width so the
// column lines up; a longer name is cut short and given whole on hover.
const OwnBranch = ({ m }) => {
  const name = m.all_branches ? "All Branches" : m.own_branch?.name;
  return name ? (
    <span title={name} className="inline-block w-36 truncate whitespace-nowrap rounded-[4px] border border-orange-200 bg-orange-50 px-2 py-0.5 text-center text-[11px] font-semibold text-orange-700">
      {name}
    </span>
  ) : (
    <span className="text-slate-400">—</span>
  );
};

// Every other branch they work: the ones they were brought to collaborate with.
const CollabBranches = ({ m }) => (
  m.all_branches || !m.collab_branches?.length ? (
    <span className="text-slate-400">—</span>
  ) : (
    <span className="flex flex-wrap gap-1">
      {m.collab_branches.map((b) => (
        <span key={b.id} title={b.name} className="inline-block w-36 truncate whitespace-nowrap rounded-[4px] border border-sky-200 bg-sky-50 px-2 py-0.5 text-center text-[11px] font-semibold text-sky-700">
          {b.name}
        </span>
      ))}
    </span>
  )
);

const GenderChip = ({ gender }) => (
  gender ? (
    <span className={`inline-flex rounded-[4px] px-2 py-0.5 text-[11px] font-semibold ${GENDER_CHIP[gender]}`}>
      {GENDER_LABEL[gender]}
    </span>
  ) : (
    <span className="text-slate-400">—</span>
  )
);

const StatusChip = ({ status }) => (
  <span className={`inline-flex rounded-[4px] px-2 py-0.5 text-[11px] font-semibold ${status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
    {capitalise(status) || "—"}
  </span>
);

const Phone = ({ phone }) => (
  phone ? (
    <a href={`tel:${telNumber(phone)}`} className="text-slate-600 hover:text-sky-700" onClick={(e) => e.stopPropagation()}>
      {displayPhone(phone)}
    </a>
  ) : (
    <span className="text-slate-400">—</span>
  )
);

/**
 * One person, to a branch they don't work yet — a row's Add. The branches they are already
 * at are left out, so every one listed is a new one for them.
 */
const AddToBranchDialog = ({ member, desk, branches, onClose, onSaved }) => {
  const [busyId, setBusyId] = useState(null);
  const at = new Set(member.branches.map((b) => b.id));
  const open = branches.filter((b) => !at.has(b.id));

  const pick = async (b) => {
    setBusyId(b.id);
    try {
      const res = await bmTeamAdd(b.id, member.user_id, desk.key);
      toast.success(res?.message || `${member.full_name} added to ${b.name}`);
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add");
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white shadow-2xl" data-testid="team-row-add-dialog">
        <div className="border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">Add {member.full_name} to a branch</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {member.branches.length > 0 && <>Works at {branchText(member)} now, and keeps it. </>}
            Click a branch to have them work there too.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {open.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
              {member.full_name} already works at every branch.
            </p>
          ) : (
            <div className="space-y-2">
              {open.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  disabled={!!busyId}
                  onClick={() => pick(b)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 text-left text-sm font-medium text-slate-800 transition hover:border-sky-400 hover:bg-sky-50/40 disabled:opacity-50"
                  data-testid={`team-row-add-branch-${b.id}`}
                >
                  {b.name}
                  {busyId === b.id ? <span className="text-[11px] text-slate-400">Adding...</span> : <Plus className="h-4 w-4 text-sky-600" />}
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

// toolbarSlot: the right end of Activity Care's tab strip. From lg up the filters and Refresh
// sit there, on the tabs' line; below lg, and when no slot is given, they sit above the table.
// branchId: the viewer's own branch, which Add's branch dropdown opens on.
export const TeamPanel = ({ kind, branchId = null, toolbarSlot = null }) => {
  const k = KINDS[kind];
  const [data, setData] = useState({ members: [], branches: [] });
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState("all");
  const [gender, setGender] = useState("all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [addingMember, setAddingMember] = useState(null); // a row, for its own Add

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getTeam(kind));
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Couldn't load the ${k.plural}`);
    }
    setLoading(false);
  }, [kind, k.plural]);

  useEffect(() => { load(); }, [load]);

  // Matches the name, the phone (digits alone, so "98765 43210" finds 9876543210) or a
  // branch the person works at.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return data.members.filter((m) =>
      (branch === "all" || m.all_branches || m.branches.some((b) => b.id === branch))
      && genderMatches(gender, m.gender)
      && (!q
        || m.full_name.toLowerCase().includes(q)
        || (digits && String(m.phone || "").replace(/\D/g, "").includes(digits))
        || branchText(m).toLowerCase().includes(q))
    );
  }, [data.members, branch, gender, search]);

  // Where the arrow will lead is still to be decided.
  const open = (m) => toast(`${m.full_name} — details coming soon`);

  const arrow = (m) => (
    <button
      type="button"
      onClick={() => open(m)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
      title="Open"
      aria-label={`Open ${m.full_name}`}
      data-testid={`team-open-${m.id}`}
    >
      <ChevronRight className="h-4 w-4" />
    </button>
  );

  // A row's Add. Not for a profile-only expert, who has no login to post, nor for a Super
  // Admin taking consultations, who already runs every branch.
  const rowAdd = (m) => {
    const why = !m.user_id ? "No login to add to a branch" : m.all_branches ? "Already at every branch" : null;
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setAddingMember(m)}
        disabled={!!why || data.branches.length === 0}
        className="h-8 gap-1 border-sky-200 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-50 hover:text-sky-800"
        title={why || `Add ${m.full_name} to a branch`}
        aria-label={`Add ${m.full_name} to a branch`}
        data-testid={`team-row-add-${m.id}`}
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    );
  };

  const filters = (
    <>
      <div className="relative w-full lg:w-52">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone or branch"
          className="h-9 pl-8 pr-8 text-xs"
          data-testid={`team-search-${kind}`}
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Clear search"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <FilterSelect
        value={branch}
        onChange={setBranch}
        label="Branch"
        allLabel="All Branches"
        options={data.branches.map((b) => [b.id, b.name])}
        testid={`team-branch-filter-${kind}`}
      />
      <FilterSelect
        value={gender}
        onChange={setGender}
        label="Gender"
        allLabel="All"
        options={[["male", "Male"], ["female", "Female"], ["other", "Others"]]}
        testid={`team-gender-filter-${kind}`}
      />
      <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh">
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
      <Button
        onClick={() => setAdding(true)}
        disabled={data.branches.length === 0}
        className="h-9 w-9 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700"
        title={`Add ${k.desk.label}`}
        aria-label={`Add ${k.desk.label}`}
        data-testid={`team-add-${kind}`}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-3" data-testid={`team-panel-${kind}`}>
      {toolbarSlot && createPortal(filters, toolbarSlot)}
      {adding && (
        <TeamAddDialog
          desk={k.desk}
          branchId={data.branches.some((b) => b.id === branchId) ? branchId : null}
          branches={data.branches}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }}
        />
      )}
      {addingMember && (
        <AddToBranchDialog
          member={addingMember}
          desk={k.desk}
          branches={data.branches}
          onClose={() => setAddingMember(null)}
          onSaved={() => { setAddingMember(null); load(); }}
        />
      )}
      {/* Below lg the search takes a line of its own, the two filters and Refresh under it.
          Up to 2xl they stay above the table: on the tab line any narrower they pushed the
          last tabs out of sight. */}
      <div className={`flex flex-wrap items-center gap-2 ${toolbarSlot ? "2xl:hidden" : ""}`}>{filters}</div>

      {loading && data.members.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-xs text-slate-400">Loading {k.plural}…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-xs text-slate-400">
          No {k.plural} match {search.trim() ? "this search" : "these filters"}.
        </p>
      ) : (
        <>
          {/* Phone: one row each, branch and phone under the name. */}
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden">
            {visible.map((m, i) => (
              <div key={m.id} className="flex items-center gap-3 p-3" data-testid={`team-row-${m.id}`}>
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{m.full_name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <OwnBranch m={m} />
                    {!m.all_branches && m.collab_branches?.length > 0 && <CollabBranches m={m} />}
                  </div>
                  {m.phone && <p className="mt-0.5 truncate text-[11px] text-slate-500"><Phone phone={m.phone} /></p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <GenderChip gender={m.gender} />
                  {m.status !== "active" && <StatusChip status={m.status} />}
                </div>
                {rowAdd(m)}
                {arrow(m)}
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
            <table className="min-w-full text-sm">
              {/* A light header, not the slate-500 bar the other tables wear. */}
              <thead className="border-b border-slate-200 bg-slate-100 text-left text-xs uppercase text-slate-600">
                <tr>
                  <th className="w-16 px-4 py-2.5">S.No</th>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Own Branch</th>
                  <th className="px-4 py-2.5">Collaborate Branch</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Gender</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="w-24 px-4 py-2.5 text-center">Option</th>
                  <th className="w-20 px-4 py-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((m, i) => (
                  <tr key={m.id} className="hover:bg-slate-50" data-testid={`team-tr-${m.id}`}>
                    <td className="px-4 py-3 tabular-nums text-slate-400">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                          {m.full_name?.charAt(0)?.toUpperCase() || "?"}
                        </span>
                        <span className="font-medium text-slate-800">{m.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><OwnBranch m={m} /></td>
                    <td className="px-4 py-3"><CollabBranches m={m} /></td>
                    <td className="whitespace-nowrap px-4 py-3"><Phone phone={m.phone} /></td>
                    <td className="px-4 py-3"><GenderChip gender={m.gender} /></td>
                    <td className="px-4 py-3"><StatusChip status={m.status} /></td>
                    <td className="px-4 py-3"><div className="flex justify-center">{rowAdd(m)}</div></td>
                    <td className="px-4 py-3"><div className="flex justify-center">{arrow(m)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
