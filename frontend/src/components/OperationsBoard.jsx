import { useEffect, useRef, useState } from "react";
import { Building2, Headphones, Stethoscope, Activity, Salad, UserRound, ChevronDown, ChevronUp, Search, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDoctors, bmPreSalesMembers, getLeads, hrUsers } from "@/lib/api";
import { BranchAdminBoard } from "@/components/BranchAdminBoard";
import { HeadPhysioBoard } from "@/components/HeadPhysioBoard";
import { PhysioBoard } from "@/components/PhysioBoard";
import { DietBoard } from "@/components/DietBoard";
import { PreSalesCRM } from "@/components/PreSalesCRM";
import { ClientPortalPreview } from "@/components/ClientPortalPreview";
import { BranchManagementBoard } from "@/components/branch/BranchManagementBoard";
// The pill row's replacement on the compact layout (Super Admin's page) — see `compact`
// on OperationsBoard below.
import { BranchFilterPopover } from "@/components/BranchFilterPopover";
import { displayPhone } from "@/lib/phone";

// Same helper BranchManagementBoard.jsx, PreSalesCRM.jsx, MarketingBoard.jsx and
// BranchStoreBoard.jsx each already carry their own copy of.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// Anna Nagar is the flagship branch every Super Admin lands on first, so every
// Operations tab opens there instead of an empty "pick a branch" prompt. Falls back to
// the first offline branch (same sort order the picker itself uses) if Anna Nagar isn't
// in the list yet.
const findDefaultBranchId = (branches) => {
  const list = branches || [];
  const annaNagar = list.find((b) => /anna\s*nagar/i.test(b.branch_name || ""));
  if (annaNagar) return annaNagar.id;
  const sorted = [...list].sort((a, b) => {
    const onlineDiff = Number(isOnlineVertical(a.vertical)) - Number(isOnlineVertical(b.vertical));
    if (onlineDiff !== 0) return onlineDiff;
    return (a.branch_name || "").localeCompare(b.branch_name || "");
  });
  return sorted[0]?.id || "";
};

const OPERATIONS_TABS = [
  { key: "pre_sales", label: "Pre Sales", icon: Headphones },
  { key: "branch", label: "Branch", icon: Building2 },
  { key: "consultant", label: "Consultant", icon: Stethoscope },
  { key: "physio", label: "Physio", icon: Activity },
  { key: "nutritionist", label: "Nutritionist", icon: Salad },
  { key: "client", label: "Client", icon: UserRound },
];

/**
 * Same pill row every Operations tab picks a branch from — offline branches first
 * (alphabetical), online ones trail (alphabetical among themselves), matching how
 * Branch Wise already sorts. One shared component rather than each tab styling its own,
 * so a branch reads the same way regardless of which team you're looking at it through.
 *
 * On a phone the pills wrapped into a block of rows above every board, so there it is the
 * one Branch dropdown instead (BranchFilterPopover, the same list in a dialog), sharing its
 * row with the person picker beside it. The desk keeps the pills.
 */
const OperationsBranchPicker = ({ branches, selectedId, onSelect, testid }) => {
  const sorted = [...(branches || [])].sort((a, b) => {
    const onlineDiff = Number(isOnlineVertical(a.vertical)) - Number(isOnlineVertical(b.vertical));
    if (onlineDiff !== 0) return onlineDiff;
    return (a.branch_name || "").localeCompare(b.branch_name || "");
  });
  return (
    <>
    <div className="min-w-0 flex-1 basis-0 sm:hidden">
      <BranchFilterPopover branches={branches} selectedId={selectedId} onSelect={onSelect} testid={`${testid}-phone`} fill />
    </div>
    <div className="hidden flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:flex" data-testid={testid}>
      {sorted.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onSelect(b.id)}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
            selectedId === b.id ? "bg-sky-600 text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
          }`}
          data-testid={`${testid}-${b.id}`}
        >
          <Building2 className="h-3.5 w-3.5" /> {b.branch_name}
        </button>
      ))}
      {sorted.length === 0 && <p className="px-2 py-1.5 text-sm text-slate-400">No branches yet.</p>}
    </div>
    </>
  );
};

// The row a tab's pickers sit on. One line on a phone -- the Branch dropdown and the person
// picker share it half and half -- and the desk's wrapping row from sm up.
const PICKER_ROW = "flex items-center gap-2 sm:flex-wrap sm:gap-3";
// A person picker's own box on that row: half the phone's line, its own width on a desk.
const PICKER_CELL = "relative min-w-0 flex-1 basis-0 sm:flex-none sm:basis-auto";
// The native select inside it: the full half on a phone, at the trigger's height beside it.
const PICKER_SELECT = "h-9 w-full min-w-0 appearance-none rounded-md border border-slate-200 bg-white px-3 pr-8 text-sm sm:h-10 sm:w-auto sm:min-w-[220px]";

const EmptyPrompt = ({ text, testid }) => (
  <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center" data-testid={testid}>
    <ChevronUp className="mx-auto h-5 w-5 text-sky-500 motion-safe:animate-bounce" />
    <p className="mt-1 text-sm font-semibold text-slate-600">{text}</p>
  </div>
);

// ---------- Branch tab: pick a branch, see that branch admin's full board ----------

// `compact` hands the branch picker and the Branch Manager button up to the Operations nav
// bar, where BDE puts them (see OperationsBranchActions) — the tab then renders only the
// board and the dialogs those buttons open. Selection and dialog state live in
// OperationsBoard either way, so the nav bar and the tab are never arguing over which
// branch is showing.
const OperationsBranchTab = ({
  branches,
  actingUser,
  compact = false,
  selectedId,
  onSelect,
  showManager,
  onCloseManager,
  onOpenManager,
}) => {
  return (
    <div className="space-y-4" data-testid="ops-branch-tab">
      {!compact && (
      <div className="flex items-center justify-between gap-2 sm:flex-wrap sm:gap-3">
        <OperationsBranchPicker branches={branches} selectedId={selectedId} onSelect={onSelect} testid="ops-branch-picker" />
        {/* Opens Branches & Verticals' MANAGER page in a dialog right here rather than
            switching the top nav to Branches & Verticals — this stays "Operations" the
            whole time it's open, closed with the same click that would otherwise be a
            back button. */}
        {selectedId && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              className="h-9 gap-2 bg-indigo-600 px-3 text-white hover:bg-indigo-700"
              onClick={onOpenManager}
              data-testid="ops-branch-goto-manager-btn"
            >
              <Users className="h-4 w-4" /> Branch Manager
            </Button>
          </div>
        )}
      </div>
      )}
      {/* Branch Transfer lives on each lead's own popup here (the icon beside Edit), not as a
          button over the stages. */}
      {selectedId ? (
        <BranchAdminBoard key={selectedId} branchId={selectedId} embedded canTransferBranch />
      ) : (
        <EmptyPrompt text="Pick a branch above to open its full board" testid="ops-branch-empty" />
      )}
      {showManager && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-2 sm:p-4" data-testid="ops-branch-manager-dialog">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
              <h3 className="inline-flex items-center gap-2 text-base font-semibold"><Users className="h-4 w-4 text-indigo-600" />Branch Manager</h3>
              <button onClick={onCloseManager} className="text-slate-400 hover:text-slate-600" data-testid="ops-branch-manager-close"><X className="h-4 w-4" /></button>
            </div>
            <div className="overflow-y-auto p-3 sm:p-5">
              <BranchManagementBoard actingUser={actingUser} initialTab="creation" lockTab />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------- Consultant tab: pick a branch, see its Consultants' board ----------
//
// The dropdown here is read-only, unlike Physio/Nutritionist below — a Consultant (Head
// Physio) covers every branch by default rather than belonging to one, and HeadPhysioBoard
// shows one shared queue for the whole branch rather than a view filtered to one person, so
// picking a different name wouldn't change anything below it. It's here purely so the branch
// a Super Admin has assigned a Consultant to (Branches & Verticals > that branch > Assign
// Head Physio) is visible at a glance, the same names HeadPhysioBoard is already showing
// the combined queue for.
const OperationsConsultantTab = ({ branches, actingUser }) => {
  const [selectedId, setSelectedId] = useState("");
  // Every CONSULTANT login, org-wide — filtered to the picked branch below rather than
  // fetched per-branch. The `doctors` collection's branch_id doesn't track this (a Head
  // Physio doctor profile isn't branch-scoped there), so the source of truth is the same
  // users.branch_ids Roles & Credentials now assigns a CONSULTANT from.
  const [allConsultants, setAllConsultants] = useState([]);
  const [selectedConsultantId, setSelectedConsultantId] = useState("");
  useEffect(() => {
    if (!selectedId && branches && branches.length) setSelectedId(findDefaultBranchId(branches));
  }, [branches, selectedId]);

  // Every consultant role, not the one slug: the desk is `consultant`/`online_consultant`
  // plus the two retired slugs migrate_consultant_roles has not necessarily reached, and
  // naming any one of them leaves consultants missing from this picker with nothing on
  // screen to say why. /hr/users reads a comma-separated list as a family — see
  // list_users in backend/routers/v3_hr.py. Kept in step with HEAD_PHYSIO_ROLES in
  // backend/deps.py.
  useEffect(() => {
    hrUsers({ role: "consultant,online_consultant,head_physio,online_head_physio" })
      .then(setAllConsultants)
      .catch(() => setAllConsultants([]));
  }, []);

  // Relevant to the picked branch: posted to it.
  //
  // A Consultant covering every branch by default used to be the other half of this, and
  // org_wide was how the row said so. It is always false now — a Consultant is posted to
  // chosen branches like every other desk — so what is left is the branch match, and an
  // unposted Consultant appears under no branch rather than under all of them. The flag is
  // still read so a row from a server mid-deploy is not misfiled.
  const consultants = selectedId
    ? allConsultants.filter((u) => u.org_wide || (u.branches || []).some((b) => b.id === selectedId))
    : [];
  useEffect(() => {
    setSelectedConsultantId(consultants[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, allConsultants.length]);

  return (
    <div className="space-y-4" data-testid="ops-consultant-tab">
      <div className={PICKER_ROW}>
        <OperationsBranchPicker branches={branches} selectedId={selectedId} onSelect={setSelectedId} testid="ops-consultant-picker" />
        {/* Named, because a bare box reading "Yamini" next to a row of branch pills does
              not say what it is choosing — it could as easily be a filter on the branch
              list. The label carries the accessible name too: this select had none at all,
              so a screen reader announced it as an unlabelled combo box.

              Inline rather than stacked above, so it lines up with the pills beside it
              instead of making the row two lines tall.

              On a phone the name goes (the select keeps its aria-label) and the box takes
              the half of the row beside the Branch dropdown. */}
        {selectedId && (
          <label className="flex h-9 min-w-0 flex-1 basis-0 items-center gap-2 rounded-md border border-slate-200 bg-white pl-3 pr-1 sm:h-10 sm:flex-none sm:basis-auto" title="The board below always shows this branch's whole Consultant queue, whichever name is picked here">
            <span className="hidden shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-slate-400 sm:inline">
              Select Consultant
            </span>
            <span className="relative min-w-0 flex-1 sm:flex-none">
              <select
                value={selectedConsultantId}
                onChange={(e) => setSelectedConsultantId(e.target.value)}
                aria-label="Select Consultant"
                className="h-8 w-full min-w-0 appearance-none rounded-md border-0 bg-transparent pl-1 pr-7 text-sm font-medium text-slate-800 outline-none sm:w-auto sm:min-w-[160px]"
                data-testid="ops-consultant-person-select"
              >
                {consultants.length === 0 ? (
                  <option value="">No Consultant assigned to this branch</option>
                ) : (
                  consultants.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)
                )}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </span>
          </label>
        )}
      </div>
      {selectedId ? (
        <HeadPhysioBoard key={`${selectedId}-hp`} branchId={selectedId} user={actingUser} supervising />
      ) : (
        <EmptyPrompt text="Pick a branch above to see its Consultants" testid="ops-consultant-empty" />
      )}
    </div>
  );
};

// ---------- Physio / Nutritionist: branch -> employee dropdown -> their own board ----------
//
// Same shape Branch Control already uses for its Physio View, just generalised to any
// profile_type the doctors collection carries (physio, nutrition_coach) and to whichever
// board that profile owns (PhysioBoard, DietBoard).

const OperationsPersonTab = ({ branches, profileType, personLabel, boardTestid, renderBoard }) => {
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [people, setPeople] = useState([]);
  const [selectedPersonId, setSelectedPersonId] = useState("");

  useEffect(() => {
    if (!selectedBranchId && branches && branches.length) setSelectedBranchId(findDefaultBranchId(branches));
  }, [branches, selectedBranchId]);

  useEffect(() => {
    setSelectedPersonId("");
    if (!selectedBranchId) { setPeople([]); return; }
    getDoctors({ branch_id: selectedBranchId })
      .then((rows) => {
        const filtered = (rows || []).filter((d) => d.profile_type === profileType);
        setPeople(filtered);
        setSelectedPersonId(filtered[0]?.id || "");
      })
      .catch(() => setPeople([]));
  }, [selectedBranchId, profileType]);

  return (
    <div className="space-y-4" data-testid={boardTestid}>
      <div className={PICKER_ROW}>
        <OperationsBranchPicker branches={branches} selectedId={selectedBranchId} onSelect={setSelectedBranchId} testid={`${boardTestid}-branch-picker`} />
        {selectedBranchId && (
          <div className={PICKER_CELL}>
            <select
              value={selectedPersonId}
              onChange={(e) => setSelectedPersonId(e.target.value)}
              aria-label={`Select a ${personLabel}`}
              className={PICKER_SELECT}
              data-testid={`${boardTestid}-person-select`}
            >
              <option value="">{`— Select a ${personLabel} —`}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              {people.length === 0 && <option value="" disabled>{`No ${personLabel.toLowerCase()}s in this branch yet`}</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        )}
      </div>

      {!selectedBranchId ? (
        <EmptyPrompt text="Pick a branch above" testid={`${boardTestid}-empty-branch`} />
      ) : selectedPersonId ? (
        renderBoard(selectedPersonId)
      ) : (
        <EmptyPrompt text={`Pick a ${personLabel.toLowerCase()} above to open their board`} testid={`${boardTestid}-empty-person`} />
      )}
    </div>
  );
};

// ---------- Pre Sales tab: branch -> rep dropdown -> their own leads ----------

const OperationsPreSalesTab = ({ branches, actingUser }) => {
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [reps, setReps] = useState([]);
  const [selectedRepId, setSelectedRepId] = useState("");

  useEffect(() => {
    if (!selectedBranchId && branches && branches.length) setSelectedBranchId(findDefaultBranchId(branches));
  }, [branches, selectedBranchId]);

  useEffect(() => {
    setSelectedRepId("");
    if (!selectedBranchId) { setReps([]); return; }
    bmPreSalesMembers(selectedBranchId)
      .then((rows) => {
        setReps(rows);
        setSelectedRepId(rows?.[0]?.id || "");
      })
      .catch(() => setReps([]));
  }, [selectedBranchId]);

  return (
    <div className="space-y-4" data-testid="ops-presales-tab">
      <div className={PICKER_ROW}>
        <OperationsBranchPicker branches={branches} selectedId={selectedBranchId} onSelect={setSelectedBranchId} testid="ops-presales-branch-picker" />
        {selectedBranchId && (
          <div className={PICKER_CELL}>
            <select
              value={selectedRepId}
              onChange={(e) => setSelectedRepId(e.target.value)}
              aria-label="Select a Pre Sales rep"
              className={PICKER_SELECT}
              data-testid="ops-presales-person-select"
            >
              <option value="">— Select a Pre Sales rep —</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name || r.email}</option>)}
              {reps.length === 0 && <option value="" disabled>No Pre Sales reps for this branch yet</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        )}
      </div>

      {!selectedBranchId ? (
        <EmptyPrompt text="Pick a branch above" testid="ops-presales-empty-branch" />
      ) : selectedRepId ? (
        // super_admin role so this gets the full desktop table (KPIs, Handled By, the
        // works) — assignedUserId narrows that same table to just this rep's own leads,
        // rather than trading it for a smaller, separately-built view. Leads only, with the
        // branch filters as toolbar dropdowns -- the same shape as the master views.
        <PreSalesCRM
          key={selectedRepId}
          role="super_admin"
          currentUser={actingUser}
          branchId={selectedBranchId}
          assignedUserId={selectedRepId}
          embedded
          leadsOnly
          branchFilterInToolbar
        />
      ) : (
        <EmptyPrompt text="Pick a Pre Sales rep above to see their leads" testid="ops-presales-empty-person" />
      )}
    </div>
  );
};

// A branch's client list can run into the hundreds, unlike the Physio/Nutritionist/Pre
// Sales dropdowns above (a handful of staff each) — so this one gets its own search box
// rather than the plain <select> those use, matching the searchable employee picker
// HR Admin's Create User already has.
const SearchableClientSelect = ({ clients, selectedId, onSelect, testid }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const selected = clients.find((c) => c.id === selectedId);
  const currentLabel = selected ? `${selected.name}${displayPhone(selected.phone) ? ` — ${displayPhone(selected.phone)}` : ""}` : "— Select a client —";

  const q = query.trim().toLowerCase();
  const filtered = q
    ? clients.filter((c) => `${c.name || ""} ${c.phone || ""}`.toLowerCase().includes(q))
    : clients;

  // On a phone the box is the right half of the picker row, so its list hangs from the
  // box's right edge and runs as wide as the screen allows, rather than from its left edge
  // at 260px and off the side of the screen.
  return (
    <div className={PICKER_CELL} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-sm sm:h-10 sm:w-auto sm:min-w-[220px]"
        data-testid={testid}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-72 w-[min(20rem,calc(100vw_-_1.5rem))] overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg sm:left-0 sm:w-auto sm:min-w-[260px]" data-testid={`${testid}-list`}>
          <div className="relative border-b border-slate-100 p-1.5">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search client..."
              className="h-8 w-full rounded-md border border-slate-200 pl-8 pr-2 text-xs outline-none focus:border-sky-400"
              data-testid={`${testid}-search`}
            />
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto p-1.5">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onSelect(c.id); setOpen(false); }}
                className={`block w-full rounded-md px-3 py-1.5 text-left text-xs font-medium ${selectedId === c.id ? "bg-sky-50 text-sky-700" : "text-slate-700 hover:bg-slate-50"}`}
                data-testid={`${testid}-option-${c.id}`}
              >
                {c.name}{displayPhone(c.phone) ? ` — ${displayPhone(c.phone)}` : ""}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-slate-400">
                {clients.length === 0 ? "No clients for this branch yet" : "No clients match."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------- Client tab: branch -> client list -> their history ----------

const OperationsClientTab = ({ branches }) => {
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState("");

  useEffect(() => {
    if (!selectedBranchId && branches && branches.length) setSelectedBranchId(findDefaultBranchId(branches));
  }, [branches, selectedBranchId]);

  useEffect(() => {
    setSelectedClientId("");
    if (!selectedBranchId) { setClients([]); return; }
    getLeads({ branch_id: selectedBranchId })
      .then((rows) => {
        setClients(rows);
        setSelectedClientId(rows?.[0]?.id || "");
      })
      .catch(() => setClients([]));
  }, [selectedBranchId]);

  return (
    <div className="space-y-4" data-testid="ops-client-tab">
      <div className={PICKER_ROW}>
        <OperationsBranchPicker branches={branches} selectedId={selectedBranchId} onSelect={setSelectedBranchId} testid="ops-client-branch-picker" />
        {selectedBranchId && (
          <SearchableClientSelect clients={clients} selectedId={selectedClientId} onSelect={setSelectedClientId} testid="ops-client-select" />
        )}
      </div>

      {!selectedBranchId ? (
        <EmptyPrompt text="Pick a branch above" testid="ops-client-empty-branch" />
      ) : !selectedClientId ? (
        <EmptyPrompt text="Pick a client above to see their portal" testid="ops-client-empty-person" />
      ) : (
        <ClientPortalPreview key={selectedClientId} leadId={selectedClientId} />
      )}
    </div>
  );
};

/**
 * Operations — Super Admin's own view of every team, one designation at a time. Each tab
 * is the same board that person or branch already has, reached the way Branches &
 * Verticals > Branch Control already reaches a Branch Admin/Consultant/Physio's board
 * (and Branch Wise reaches a branch's): pick a branch, then (where the role is branch-
 * scoped rather than org-wide) an employee, and see exactly what they'd see, with full
 * control, no separate login needed.
 */
export const OperationsBoard = ({ actingUser, branches = [], initialTab = "pre_sales", compact = false }) => {
  const [tab, setTab] = useState(initialTab);

  // Branch tab state, held here rather than inside the tab because on the compact layout
  // the controls that drive it sit in the nav bar above it, outside the tab entirely.
  const [branchTabId, setBranchTabId] = useState("");
  const [showManager, setShowManager] = useState(false);
  useEffect(() => {
    if (!branchTabId && branches && branches.length) setBranchTabId(findDefaultBranchId(branches));
  }, [branches, branchTabId]);

  // The nav row has a whole right half doing nothing on a desktop width, and the Branch
  // tab has three controls that were costing it two stacked rows above the board. Moving
  // them up buys that height back for the board itself.
  const showBranchActions = compact && tab === "branch";

  return (
    <div className="space-y-4" data-testid="operations-board">
      {/* On a phone the six tabs wrapped onto two and three lines. There it is HR Admin's
          strip (the BDE Dashboard's): one row of icons, the open tab in sky with its name
          slid out beside its icon. From sm up it is the desk's row of filled pills. */}
      <div className="flex flex-nowrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:flex-wrap sm:gap-2" data-testid="operations-tabs">
        {OPERATIONS_TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-label={t.label}
              title={t.label}
              data-testid={`operations-tab-${t.key}`}
              className={`inline-flex min-w-0 flex-auto items-center justify-center whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition sm:flex-none sm:gap-2 sm:px-3 ${
                active ? "bg-sky-50 text-sky-700 sm:bg-sky-600 sm:text-white sm:shadow-sm" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className={`overflow-hidden text-ellipsis transition-[max-width,margin,opacity] duration-200 ease-out sm:ml-0 sm:max-w-none sm:opacity-100 ${active ? "ml-2 max-w-[9rem] opacity-100" : "ml-0 max-w-0 opacity-0"}`}>
                {t.label}
              </span>
            </button>
          );
        })}
        {/* ml-auto, not justify-between: the tabs keep their natural width so they read as
            one group, and this lot takes whatever is left. Desk only: on a phone the strip
            is one row of icons, and these get a row of their own under it (below). */}
        {showBranchActions && (
          <div className="ml-auto hidden shrink-0 flex-wrap items-center gap-2 px-1 py-0.5 sm:flex" data-testid="operations-branch-actions">
            <BranchFilterPopover
              branches={branches}
              selectedId={branchTabId}
              onSelect={setBranchTabId}
              testid="ops-branch-filter"
            />
            <Button
              className="h-9 gap-2 bg-indigo-600 px-3 text-white hover:bg-indigo-700"
              onClick={() => setShowManager(true)}
              data-testid="ops-branch-goto-manager-btn"
            >
              <Users className="h-4 w-4" /> Branch Manager
            </Button>
          </div>
        )}
      </div>

      {/* Phone: the Branch tab's two controls on one row under the strip, the Branch
          dropdown taking what Branch Manager leaves -- the picker row every other tab has. */}
      {showBranchActions && (
        <div className="flex items-center gap-2 sm:hidden" data-testid="operations-branch-actions-phone">
          <div className="min-w-0 flex-1">
            <BranchFilterPopover
              branches={branches}
              selectedId={branchTabId}
              onSelect={setBranchTabId}
              testid="ops-branch-filter-phone"
              fill
            />
          </div>
          <Button
            className="h-9 shrink-0 gap-2 bg-indigo-600 px-3 text-white hover:bg-indigo-700"
            onClick={() => setShowManager(true)}
            data-testid="ops-branch-goto-manager-btn-phone"
          >
            <Users className="h-4 w-4" /> Branch Manager
          </Button>
        </div>
      )}

      {tab === "pre_sales" && <OperationsPreSalesTab branches={branches} actingUser={actingUser} />}
      {tab === "branch" && (
        <OperationsBranchTab
          branches={branches}
          actingUser={actingUser}
          compact={compact}
          selectedId={branchTabId}
          onSelect={setBranchTabId}
          showManager={showManager}
          onOpenManager={() => setShowManager(true)}
          onCloseManager={() => setShowManager(false)}
        />
      )}
      {tab === "consultant" && <OperationsConsultantTab branches={branches} actingUser={actingUser} />}
      {tab === "physio" && (
        <OperationsPersonTab
          branches={branches}
          profileType="physio"
          personLabel="Physio"
          boardTestid="ops-physio-tab"
          renderBoard={(physioId) => <PhysioBoard key={physioId} physioId={physioId} />}
        />
      )}
      {tab === "nutritionist" && (
        <OperationsPersonTab
          branches={branches}
          profileType="nutrition_coach"
          personLabel="Nutritionist"
          boardTestid="ops-nutritionist-tab"
          renderBoard={(coachId) => <DietBoard key={coachId} coachId={coachId} />}
        />
      )}
      {tab === "client" && <OperationsClientTab branches={branches} />}
    </div>
  );
};

export default OperationsBoard;
