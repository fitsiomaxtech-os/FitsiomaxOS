import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Minus, Phone as PhoneIcon, Plus, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { bmTeamAdd, bmTeamRemove, getTeam } from "@/lib/api";
import { displayPhone, telNumber } from "@/lib/phone";
import { TeamAddDialog } from "@/components/branch/BranchDetailPage";

/**
 * Activity Care's Team Consultants and Team Physio tabs: every consultant, or every physio,
 * in the organisation, one to a row — S.No, name, own branch, the branches they collaborate
 * with, phone, gender, status, an Add or Remove and an arrow — narrowed by a search, by
 * branch and by gender. Add — the toolbar's, picking a person, or a row's — brings them to the
 * viewer's own branch and nowhere else; they keep the branches they already have. A row's
 * Remove ends that collaboration again.
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
// size: its width; by default it shares the row, and from lg up it is a fixed 9rem.
const FilterSelect = ({ value, onChange, allLabel, options, label, testid, size = "min-w-0 flex-1 lg:w-36 lg:flex-none" }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger
      title={label}
      aria-label={label}
      className={`h-9 rounded-md border px-2.5 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 ${size} ${
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
 * A row's Add or Remove, asked before it is done: either one changes where the person is
 * offered for booking. Add starts a collaboration at the viewer's branch; Remove ends it.
 * Their own branch is never removed — the button is not shown for it, and the server
 * refuses it.
 */
const BranchChangeDialog = ({ mode, member, branch, desk, onClose, onSaved }) => {
  const [busy, setBusy] = useState(false);
  const adding = mode === "add";

  const confirm = async () => {
    setBusy(true);
    try {
      const res = adding
        ? await bmTeamAdd(branch.id, member.user_id, desk.key)
        : await bmTeamRemove(branch.id, member.user_id, desk.key);
      toast.success(res?.message || `${member.full_name} ${adding ? "added to" : "removed from"} ${branch.name}`);
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || (adding ? "Could not add" : "Could not remove"));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl" data-testid={`team-row-${mode}-dialog`}>
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h3 className="min-w-0 truncate text-base font-semibold text-slate-800">
            {adding ? "Add to" : "Remove from"} {branch.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">{member.full_name}</span>
            {adding ? <> starts working at {branch.name} too</> : <> stops working at {branch.name}</>}
            {member.own_branch && <> and stays at {member.own_branch.name}</>}.
            {!adding && <> Appointments already booked here are kept.</>}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              onClick={confirm}
              disabled={busy}
              className={adding ? "bg-sky-600 text-white hover:bg-sky-700" : "bg-rose-600 text-white hover:bg-rose-700"}
              data-testid={`team-row-${mode}-confirm`}
            >
              {busy ? (adding ? "Adding..." : "Removing...") : (adding ? "Add" : "Remove")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

// toolbarSlot: the right end of Activity Care's tab strip. From lg up the filters and Refresh
// sit there, on the tabs' line; below lg, and when no slot is given, they sit above the table.
// branchId: the viewer's own branch, which the toolbar's Add brings people to.
export const TeamPanel = ({ kind, branchId = null, toolbarSlot = null }) => {
  const k = KINDS[kind];
  const [data, setData] = useState({ members: [], branches: [] });
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState("all");
  const [gender, setGender] = useState("all");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false); // the phone toolbar's search box
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(null); // { mode, member, branch }, a row's Add or Remove

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

  // A row's Add goes to the viewer's own branch, no picker — a Branch Admin brings people to
  // their branch and to no other.
  const myBranch = { id: branchId, name: data.branches.find((b) => b.id === branchId)?.name || "your branch" };

  // One action a row, decided by where they stand with the viewer's branch: their own
  // branch — nothing to do; collaborating with it — Remove; not at it — Add. A profile-only
  // expert has no login to post, and a Super Admin taking consultations already runs every
  // branch, so neither gets one. null when there is nothing to do: the table shows a dash
  // there, the phone card nothing.
  const rowAction = (m) => {
    const here = branchId ? m.collab_branches?.find((b) => b.id === branchId) : null;
    const own = m.all_branches || (branchId && m.own_branch?.id === branchId);
    if (!branchId || !m.user_id || own) return null;
    return here ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirming({ mode: "remove", member: m, branch: here })}
        className="h-8 gap-1 border-rose-200 px-2.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        title={`Remove ${m.full_name} from ${here.name}`}
        aria-label={`Remove ${m.full_name} from ${here.name}`}
        data-testid={`team-row-remove-${m.id}`}
      >
        <Minus className="h-3.5 w-3.5" /> Remove
      </Button>
    ) : (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirming({ mode: "add", member: m, branch: myBranch })}
        className="h-8 gap-1 border-sky-200 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-50 hover:text-sky-800"
        title={`Add ${m.full_name} to ${myBranch.name}`}
        aria-label={`Add ${m.full_name} to ${myBranch.name}`}
        data-testid={`team-row-add-${m.id}`}
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    );
  };

  const rowOptions = (m) => {
    const action = rowAction(m);
    return action
      ? <div className="flex items-center justify-center">{action}</div>
      : <div className="text-center text-slate-400">—</div>;
  };

  // The toolbar's pieces, laid out twice: in one row on a phone, and wrapping (or on the
  // tab line) from sm up. Each copy keeps its own test ids.
  const searchBox = (wrapClass, testid, autoFocus = false) => (
    <div className={`relative ${wrapClass}`}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, phone or branch"
        className="h-9 pl-8 pr-8 text-xs"
        autoFocus={autoFocus}
        data-testid={testid}
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
  );

  const branchFilter = (testid, size) => (
    <FilterSelect
      value={branch}
      onChange={setBranch}
      label="Branch"
      allLabel="All Branches"
      options={data.branches.map((b) => [b.id, b.name])}
      testid={testid}
      size={size}
    />
  );

  const genderFilter = (testid, size) => (
    <FilterSelect
      value={gender}
      onChange={setGender}
      label="Gender"
      allLabel="All"
      options={[["male", "Male"], ["female", "Female"], ["other", "Others"]]}
      testid={testid}
      size={size}
    />
  );

  const refreshButton = (
    <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh">
      <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
    </Button>
  );

  const addButton = (testid) => (
    <Button
      onClick={() => setAdding(true)}
      disabled={!branchId}
      className="h-9 w-9 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700"
      title={`Add ${k.desk.label}`}
      aria-label={`Add ${k.desk.label}`}
      data-testid={testid}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );

  const filters = (
    <>
      {searchBox("w-full lg:w-52", `team-search-${kind}`)}
      {branchFilter(`team-branch-filter-${kind}`)}
      {genderFilter(`team-gender-filter-${kind}`)}
      {refreshButton}
      {addButton(`team-add-${kind}`)}
    </>
  );

  // Phone: everything on one line, the search behind an icon. Opened, the box takes the
  // line until its ✕, which also clears it, so no search is left narrowing the list unseen.
  const phoneToolbar = (
    <div className="flex items-center gap-1.5 sm:hidden" data-testid={`team-toolbar-phone-${kind}`}>
      {searchOpen ? (
        <>
          {searchBox("min-w-0 flex-1", `team-search-phone-${kind}`, true)}
          <Button
            variant="outline"
            onClick={() => { setSearch(""); setSearchOpen(false); }}
            className="h-9 w-9 shrink-0 border-slate-200 p-0 text-slate-500"
            title="Close search"
            aria-label="Close search"
            data-testid={`team-search-close-phone-${kind}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="outline"
            onClick={() => setSearchOpen(true)}
            className="h-9 w-9 shrink-0 border-slate-200 bg-white p-0 text-slate-500 hover:bg-slate-50"
            title="Search"
            aria-label="Search"
            data-testid={`team-search-open-phone-${kind}`}
          >
            <Search className="h-4 w-4" />
          </Button>
          {branchFilter(`team-branch-filter-phone-${kind}`, "min-w-0 flex-1")}
          {genderFilter(`team-gender-filter-phone-${kind}`, "w-[4.5rem] shrink-0")}
          {refreshButton}
          {addButton(`team-add-phone-${kind}`)}
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid={`team-panel-${kind}`}>
      {toolbarSlot && createPortal(filters, toolbarSlot)}
      {adding && (
        <TeamAddDialog
          desk={k.desk}
          branchId={branchId}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }}
        />
      )}
      {confirming && (
        <BranchChangeDialog
          mode={confirming.mode}
          member={confirming.member}
          branch={confirming.branch}
          desk={k.desk}
          onClose={() => setConfirming(null)}
          onSaved={() => { setConfirming(null); load(); }}
        />
      )}
      {phoneToolbar}
      {/* From sm to lg the search takes a line of its own, the two filters and Refresh under
          it. Up to 2xl they stay above the table: on the tab line any narrower they pushed
          the last tabs out of sight. */}
      <div className={`hidden flex-wrap items-center gap-2 sm:flex ${toolbarSlot ? "2xl:hidden" : ""}`}>{filters}</div>

      {loading && data.members.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-xs text-slate-400">Loading {k.plural}…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-xs text-slate-400">
          No {k.plural} match {search.trim() ? "this search" : "these filters"}.
        </p>
      ) : (
        <>
          {/* Phone: a card each. Who they are on top — initial with the S.No, name and
              gender, their branches under it — and what to do below a rule: the phone to
              ring and the Add or Remove. A card with neither has no lower line. */}
          <div className="flex flex-col gap-2 md:hidden">
            {visible.map((m, i) => {
              const action = rowAction(m);
              return (
                <div key={m.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" data-testid={`team-row-${m.id}`}>
                  <div className="flex items-center gap-3 p-3">
                    <span className="relative shrink-0">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-50 text-sm font-bold text-sky-700">
                        {m.full_name?.charAt(0)?.toUpperCase() || "?"}
                      </span>
                      <span className="absolute -bottom-1 -left-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-white bg-slate-500 px-1 text-[9px] font-semibold tabular-nums text-white">
                        {i + 1}
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="min-w-0 truncate text-sm font-semibold text-slate-800">{m.full_name}</p>
                        {m.gender && <span className="shrink-0"><GenderChip gender={m.gender} /></span>}
                        {m.status !== "active" && <span className="shrink-0"><StatusChip status={m.status} /></span>}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <OwnBranch m={m} />
                        {!m.all_branches && m.collab_branches?.length > 0 && <CollabBranches m={m} />}
                      </div>
                    </div>
                    {arrow(m)}
                  </div>
                  {(m.phone || action) && (
                    <div className="flex min-h-[2.75rem] items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-xs">
                        {m.phone ? (
                          <><PhoneIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" /><Phone phone={m.phone} /></>
                        ) : (
                          <span className="text-slate-400">No phone</span>
                        )}
                      </span>
                      {action}
                    </div>
                  )}
                </div>
              );
            })}
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
                  <th className="px-4 py-2.5 text-center">Option</th>
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
                    <td className="whitespace-nowrap px-4 py-3">{rowOptions(m)}</td>
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
