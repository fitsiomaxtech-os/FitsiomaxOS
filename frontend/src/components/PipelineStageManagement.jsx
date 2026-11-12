import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Flag, GripVertical, Lock, KeyRound, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { stagesList, stagesCreate, stagesUpdate, stagesDelete, stagesReorder, unlockDangerZone } from "@/lib/api";
import { useDevZone, unlockDevZone, openDevZone } from "@/lib/devZone";

const PALETTE = ["#6366f1", "#3b82f6", "#0ea5e9", "#06b6d4", "#14b8a6", "#22c55e", "#84cc16", "#eab308", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];

// A fresh form. hover_color and selected_color are "" for "same as the default colour",
// which is also what the server stores to clear one (see STATE_COLOR in v3_stages).
const EMPTY_FORM = { name: "", color: "#6366f1", hover_color: "", selected_color: "", is_final: false };

// Pre-Sales only: its stages are the cards and pills a Pre-Sales rep filters by, so they
// carry three colours -- at rest, under the pointer, and picked. Every other pipeline keeps
// the single colour it always had.
const STATE_COLOR_TYPES = ["pre_sales"];

/**
 * One colour choice in the stage dialog: the palette, plus a free picker for anything the
 * palette lacks. `allowDefault` adds a "Same as default" swatch that stores "", for the
 * hover and selected colours, which fall back to the stage's own colour when unset.
 */
const ColorChoice = ({ label, value, onChange, allowDefault = false, fallback, testid }) => {
  const shown = value || fallback;
  return (
    <div data-testid={testid}>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs text-slate-500">{label}</p>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: shown }} />
          {value || (allowDefault ? "Same as default" : "")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {allowDefault && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="Same as default"
            className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-[9px] font-bold text-slate-500 ${!value ? "border-slate-900 ring-2 ring-offset-1" : "border-slate-200"}`}
            style={{ background: `${fallback}22` }}
            data-testid={`${testid}-default`}
          >
            =
          </button>
        )}
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`h-7 w-7 rounded-full border-2 ${value === c ? "border-slate-900 ring-2 ring-offset-1" : "border-transparent"}`}
            style={{ background: c }}
            data-testid={`${testid}-${c}`}
          />
        ))}
        <input
          type="color"
          value={shown}
          onChange={(e) => onChange(e.target.value)}
          title="Pick any colour"
          className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
          data-testid={`${testid}-custom`}
        />
      </div>
    </div>
  );
};

/** The three states side by side, drawn the way the Sales board's stage cards draw them,
 *  so the colours are chosen against what they will actually look like. */
const StatePreview = ({ name, color, hover, selected }) => (
  <div className="grid grid-cols-3 gap-2" data-testid="stages-form-preview">
    {[
      { key: "default", label: "Default", c: color, active: false },
      { key: "hover", label: "Hover", c: hover || color, active: false },
      { key: "selected", label: "Selected", c: selected || color, active: true },
    ].map((st) => (
      <div key={st.key} className="text-center">
        <div
          className="rounded-[2px] border px-2 py-2 text-left shadow-sm"
          style={{ borderColor: st.active ? st.c : `${st.c}55`, background: st.active ? `${st.c}1f` : `${st.c}0f` }}
        >
          <p className="truncate text-[10px] font-bold uppercase tracking-wider" style={{ color: st.c }}>{name || "Stage"}</p>
          <p className="text-lg font-bold" style={{ color: st.c }}>12</p>
        </div>
        <p className="mt-1 text-[10px] text-slate-400">{st.label}</p>
      </div>
    ))}
  </div>
);

// Every pipeline Super Admin can shape, in one table. The tab strip, the dropdown and the
// card title are all derived from it, so a sixth pipeline is one entry rather than three
// separate edits that can drift apart.
//
// Recruitment is the odd one out: its records are candidates in their own collection, not
// leads, and they reference a stage by id — so renaming one here rewrites nothing and
// cannot orphan anybody.
//
// `key` is this table's own id for the tab; `type` is what the API calls the pipeline. They
// are the same for every pipeline except the Branch one, which is two lists -- the clinic
// runs an offline practice and an online one, and they do not work a lead the same way, so
// each has its own stages under one `sales` type told apart by `arm`.
const TYPES = [
  { key: "pre_sales", label: "Pre-Sales", kpi: "Pre-Sales Stages", title: "Pre-Sales", tone: "indigo", records: "Leads" },
  // The offline arm is the unmarked one: it carries the plain name, and the online arm
  // below is the one wearing a marker.
  { key: "sales", arm: "offline", label: "Branch Leads", kpi: "Branch Leads Stages", title: "Branch Leads", tone: "green", records: "Leads" },
  // Its own list, not a view of the one above. Renaming a stage here renames it for the
  // online arm's boards and rewrites only the online arm's leads.
  //
  // Both arms are called Branch Leads now, so `online` is what tells the two tabs apart: a
  // green tick beside the label rather than a second, longer name. The card heading still
  // spells the arm out, because there the tab strip is no longer next to the words.
  { key: "sales_online", type: "sales", arm: "online", label: "Branch Leads", online: true, kpi: "Branch Leads (Online) Stages", title: "Branch Leads (Online)", tone: "cyan", records: "Leads" },
  { key: "consultation", label: "Branch Consultation", kpi: "Branch Consultation Stages", title: "Branch Consultation", tone: "orange", records: "Leads" },
  { key: "head_consultation", label: "Consultant", kpi: "Consultant Stages", title: "Consultant", tone: "sky", records: "Leads" },
  { key: "recruitment", label: "HR Board", kpi: "HR Board Stages", title: "HR Board", tone: "violet", records: "Candidates" },
  // Registrations, not leads — a dancer is nobody's patient. Ships with no stages at
  // all: the pipelines above have the shape this clinic already ran, and a Zumba class
  // has no received one, so the branch names its own with Add Stage.
  { key: "zumba", label: "Zumba", kpi: "Zumba Stages", title: "Zumba", tone: "pink", records: "Registrations" },
];

// Branch stages the boards do something with, keyed by the role the backend stamps on the
// row (see constants.SALES_STAGE_ROLES_BY_NAME). Shown as a badge so this table says which
// rows carry behaviour: the name is safe to change -- that is the point of the role -- but
// a Super Admin deleting one is removing the stage a booking lands on, and nothing on this
// screen used to hint at the difference between that row and any other.
const ROLE_LABELS = {
  appointment: "Books appointments",
  cancelled: "Moves to Lost",
  rnr: "Not reached",
  portfolio: "Portfolio dialog",
  follow_up: "Appointment exit",
};

// Tailwind only ships classes it can actually see written out, so the tones are spelled in
// full rather than built as `border-${tone}-500`.
const TONE_CLASSES = {
  indigo: { border: "border-indigo-500", text: "text-indigo-600" },
  green: { border: "border-green-500", text: "text-green-600" },
  cyan: { border: "border-cyan-500", text: "text-cyan-600" },
  orange: { border: "border-orange-500", text: "text-orange-600" },
  sky: { border: "border-sky-500", text: "text-sky-600" },
  violet: { border: "border-violet-500", text: "text-violet-600" },
  pink: { border: "border-pink-500", text: "text-pink-600" },
};

// ------------------------------------------------- What the Branch Leads strip actually draws
//
// This table listed the Branch pipeline whole, which is seven rows -- and the board's strip
// draws five of them. Reading one against the other, the two extra entry stages and the
// final one looked like stages the branch had lost rather than stages the board reaches
// another way, and there was nothing on this screen to say which was which.
//
// So the Branch tab is split in two: the rows the strip draws, in strip order, and the rows
// it does not, under a divider. The rule below is the board's own -- see leadPillStages in
// BranchAdminBoard.jsx -- and has to stay the board's own, or this table goes back to
// describing something nobody can see. Three rows never reach the strip:
//
//   - the Pre-Sales-control entry stage ("New Appointment"), which a branch running its own
//     leads does not have at all (`applies_to`);
//   - the branch's own entry stage ("Branch Assign"), whose pill is the mirror row below;
//   - the Portfolio stage, reached from its own dialog rather than from the strip, and the
//     final one ("Cancelled"), which nothing lands on now a call-off is Lost.
//
// Listed rather than dropped, deliberately. They are real positions carrying real leads --
// Branch Assign holds the branch's whole intake -- and this is the only screen in the
// product that can rename, recolour or reorder them. Hiding them to match the strip would
// have matched the strip by making three stages unmanageable.
const STAGE_ROLE_PORTFOLIO = "portfolio";
const BRANCH_ADMIN_CONTROL = "branch_admin";

// The strip's first pill is not a pipeline_stages row: the backend builds it per board (see
// _presales_mirror_stage) and it reads the lead's Pre-Sales stage rather than its
// branch_stage, so a lead appears under it without anything being written to it. Rebuilt
// here so the strip half of this table matches the strip one-for-one, and drawn read-only --
// there is no document behind it to edit, delete or reorder.
const MIRROR_ROW_ID = "presales-new-leads";

// Branch Leads' Quit pill is Branch Consultation's Quit stage, lent to the lead card
// rather than copied into this pipeline (see consultationQuitStage in BranchAdminBoard).
// Listed on the Branch Leads tabs so the link is visible here, and drawn read-only: the
// stage is edited, recoloured or deleted on the Branch Consultation tab, where it lives.
const LINKED_QUIT_ROW_ID = "consultation-quit-link";
const LINKED_ROW_IDS = [MIRROR_ROW_ID, LINKED_QUIT_ROW_ID];

export const PipelineStageManagement = ({ leading = null }) => {
  const [type, setType] = useState("pre_sales");
  const [stages, setStages] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  // The Danger Zone lives on its own full-screen page now (DeveloperZone.jsx), reached
  // through the red gear in the nav bar. This screen keeps only the way in: the quiet
  // Developer Access button and the password box. The password goes to the shared devZone
  // store -- in memory, never in storage, so leaving or refreshing the page locks it again.
  const { password: devPassword } = useDevZone();
  const [askingPassword, setAskingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // The tab being looked at, resolved once: `type` is this table's tab id, and for the
  // Branch pair it is not the same string as the pipeline's API type — both tabs are
  // `sales`, told apart by the arm.
  const active = TYPES.find((t) => t.key === type) || TYPES[0];
  const apiType = active.type || active.key;
  const arm = active.arm;
  const hasStateColors = STATE_COLOR_TYPES.includes(apiType);

  // One request, for the pipeline being looked at. It used to fetch all five and keep only
  // the active list, the other four existing solely to put a count in a tab label — with
  // the counts gone so is the reason, so a load and every pipeline switch costs one call
  // instead of five.
  // Branch Consultation's Quit, for the linked row on the Branch Leads tabs.
  const [linkedQuit, setLinkedQuit] = useState(null);
  const load = useCallback(async () => {
    setStages(await stagesList(apiType, arm));
    if (apiType === "sales") {
      const consult = await stagesList("consultation").catch(() => []);
      const quit = (consult || []).find((st) => st.name === "Quit");
      setLinkedQuit(quit ? {
        id: LINKED_QUIT_ROW_ID,
        name: quit.name,
        color: quit.color,
        lead_count: quit.lead_count,
        linkedFrom: "Branch Consultation",
      } : null);
    } else {
      setLinkedQuit(null);
    }
  }, [apiType, arm]);

  useEffect(() => { load(); }, [load]);

  // Only the offline Branch tab splits. The online arm is not a branch and has no branch to
  // read a Lead Control off, so its board falls back to Pre-Sales control -- which has no
  // mirror pill, and whose strip is therefore the whole list with nothing to separate out
  // (see _board_payload). Every other pipeline lists straight through the same way.
  const splitsByStrip = apiType === "sales" && arm === "offline";

  const { stripRows, hiddenRows } = useMemo(() => {
    const linked = linkedQuit ? [linkedQuit] : [];
    if (!splitsByStrip) return { stripRows: [...stages, ...linked], hiddenRows: [] };
    // Modelled on a branch running its own leads, which is the mode that has a strip worth
    // describing. `applies_to` drops the other mode's entry stage before anything else, the
    // same way _branch_stages does before the board ever sees it.
    const onBoard = stages.filter((st) => !st.applies_to || st.applies_to === BRANCH_ADMIN_CONTROL);
    const entry = onBoard[0] || null;
    const mirror = entry ? {
      id: MIRROR_ROW_ID,
      name: "New Leads",
      color: "#6366f1",
      // Its count is the entry stage's, because that is the match the board makes: everyone
      // still sitting at the branch's opening, let go of the moment they are moved on.
      lead_count: entry.lead_count,
      mirrors: entry.name,
    } : null;
    // `role` first, falling back to the name for a row that predates the stamping pass --
    // the same trust order stageHasRole uses on the board.
    const isPortfolio = (st) => (st.role ? st.role === STAGE_ROLE_PORTFOLIO : st.name === "Portfolio");
    const onStrip = new Set(
      onBoard
        .filter((st) => st.id !== entry?.id && !isPortfolio(st) && !st.is_final)
        .map((st) => st.id),
    );
    return {
      stripRows: [...(mirror ? [mirror] : []), ...stages.filter((st) => onStrip.has(st.id)), ...linked],
      hiddenRows: stages.filter((st) => !onStrip.has(st.id)),
    };
  }, [stages, splitsByStrip, linkedQuit]);

  // Where a row sits in the pipeline itself, which is what the Order column has always
  // meant. Read off the real list rather than off the half it is drawn in: the two halves
  // interleave, so numbering each one 1..n would print two rows called 3 and leave the
  // arrows moving a stage to a position no number on screen names.
  const pipelinePosition = useCallback(
    (st) => stages.findIndex((x) => x.id === st.id) + 1,
    [stages],
  );

  const submit = async () => {
    if (!form.name.trim()) { toast.error("Stage name required"); return; }
    // The hover and selected colours only travel for a pipeline that offers them, so an
    // edit on any other tab cannot write fields its boards never read.
    const { hover_color: hoverColor, selected_color: selectedColor, ...base } = form;
    const body = hasStateColors ? { ...base, hover_color: hoverColor, selected_color: selectedColor } : base;
    try {
      if (editing) {
        await stagesUpdate(editing.id, body);
        toast.success("Stage updated");
      } else {
        await stagesCreate({ ...body, type: apiType, arm });
        toast.success("Stage created");
      }
      setShowAdd(false); setEditing(null); setForm(EMPTY_FORM);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };

  const startEdit = (s) => {
    setEditing(s);
    setForm({ name: s.name, color: s.color, hover_color: s.hover_color || "", selected_color: s.selected_color || "", is_final: !!s.is_final });
    setShowAdd(true);
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete stage "${s.name}"?`)) return;
    try { await stagesDelete(s.id); toast.success("Stage deleted"); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Delete failed"); }
  };

  // Swaps with the neighbour in the half of the table the row is drawn in, not with whatever
  // sits next to it in the pipeline. The two halves interleave -- Branch Assign is hidden
  // and sits between two rows that are not -- so `idx + dir` would send a strip row past a
  // hidden one and land it somewhere nobody pointed at. The write is still a full reorder of
  // the real list, so the pipeline keeps one order rather than gaining a display one.
  const move = async (s, dir) => {
    const group = hiddenRows.some((x) => x.id === s.id) ? hiddenRows : stripRows;
    const within = group.filter((x) => !LINKED_ROW_IDS.includes(x.id));
    const neighbour = within[within.findIndex((x) => x.id === s.id) + dir];
    if (!neighbour) return;
    const idx = stages.findIndex((x) => x.id === s.id);
    const swapIdx = stages.findIndex((x) => x.id === neighbour.id);
    if (idx < 0 || swapIdx < 0) return;
    const items = stages.map((x, i) => ({ id: x.id, order: i }));
    [items[idx], items[swapIdx]] = [items[swapIdx], items[idx]];
    items.forEach((x, i) => { x.order = i; });
    await stagesReorder(items);
    load();
  };

  // Whether this row is already at the top or bottom of its own half, which is what the
  // arrows are disabled on now that "next" is a question about the half rather than the list.
  const atGroupEdge = useCallback((st, dir) => {
    const group = hiddenRows.some((x) => x.id === st.id) ? hiddenRows : stripRows;
    const within = group.filter((x) => !LINKED_ROW_IDS.includes(x.id));
    return !within[within.findIndex((x) => x.id === st.id) + dir];
  }, [stripRows, hiddenRows]);

  // One row, drawn for either half. `muted` is the only difference the half makes to a real
  // stage: same badges, same count, same edit and delete, dimmed to say it is off the strip.
  //
  // The mirror row is the exception and is drawn without actions at all. It has no document
  // behind it, so an edit would have nothing to write to and a delete nothing to remove --
  // and offering either would suggest the strip's first pill is Super Admin's to rename,
  // when what it is called is fixed in _presales_mirror_stage.
  const renderRow = (s, muted = false) => {
    const isLinked = s.id === LINKED_QUIT_ROW_ID;
    const isMirror = s.id === MIRROR_ROW_ID || isLinked;
    return (
      <tr
        key={s.id}
        className={`border-t border-slate-100${muted ? " opacity-60" : ""}`}
        data-testid={`stages-row-${s.id}`}
      >
        <td className="py-3">
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 text-slate-300" />
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold">
              {/* The mirror sits ahead of the pipeline rather than in it (order -1 on the
                  board), so it has no position to print. A dash rather than a 0, which
                  would read as a stage nobody had ordered yet. */}
              {isMirror ? "–" : pipelinePosition(s)}
            </span>
            {isMirror ? null : (
              <>
                <button onClick={() => move(s, -1)} disabled={atGroupEdge(s, -1)} className="text-xs text-slate-400 disabled:opacity-30" data-testid={`stages-up-${s.id}`}>▲</button>
                <button onClick={() => move(s, 1)} disabled={atGroupEdge(s, 1)} className="text-xs text-slate-400 disabled:opacity-30" data-testid={`stages-down-${s.id}`}>▼</button>
              </>
            )}
          </div>
        </td>
        <td>
          {hasStateColors && !isMirror ? (
            // Default, hover, selected -- the last two fall back to the default when unset.
            <span className="inline-flex items-center gap-1" data-testid={`stages-colors-${s.id}`}>
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: s.color }} title="Default colour" />
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: s.hover_color || s.color }} title={s.hover_color ? "Hover colour" : "Hover colour (same as default)"} />
              <span className="inline-block h-3 w-3 rounded-full ring-2 ring-offset-1" style={{ background: s.selected_color || s.color, "--tw-ring-color": s.selected_color || s.color }} title={s.selected_color ? "Selected colour" : "Selected colour (same as default)"} />
            </span>
          ) : (
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: s.color }} />
          )}
        </td>
        <td className="font-medium" style={{ color: s.color }}>
          {s.name}
          {/* The Branch pipeline holds both Lead Control modes' opening stages at
              once, so it lists two entry stages and an RNR that most branches
              never see. Without this the pair reads as an accidental duplicate. */}
          {s.applies_to ? (
            <span className="ml-2 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-slate-500">
              {s.applies_to === "branch_admin" ? "Branch Admin only" : "Pre Sales only"}
            </span>
          ) : null}
          {/* A stage the boards act on rather than merely list. Renaming it is
              safe -- the behaviour is pinned to the role, not to the name -- but
              deleting it is not, and neither is assuming the branch will still
              recognise the position under a name that means something else. Said
              here because from this table one row looks much like another. */}
          {ROLE_LABELS[s.role] ? (
            <span
              className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-amber-700"
              title={`The branch boards act on this stage (${ROLE_LABELS[s.role]}). Renaming it is safe; deleting it is not.`}
            >
              {ROLE_LABELS[s.role]}
            </span>
          ) : null}
          {/* A Zumba stage that is also one of the branch tab's summary cards: its name and
              colour here are the card's, so an edit shows up on that card too. */}
          {apiType === "zumba" && s.card ? (
            <span
              className="ml-2 rounded border border-pink-200 bg-pink-50 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-pink-600"
              title="The Zumba tab's summary card uses this stage's name and colour."
            >
              Summary card
            </span>
          ) : null}
          {/* Which real stage the first pill is a view of. Without it the row reads as a
              sixth stage somebody forgot to give an order to, and the entry stage below
              reads as one with no pill for no reason -- when they are the two halves of
              one position. */}
          {isLinked ? (
            <span
              className="ml-2 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-indigo-600"
              title={`Not a Branch Leads stage: the lead card's ${s.name} pill moves the lead onto ${s.linkedFrom}'s ${s.name} stage. Edit or delete it on the ${s.linkedFrom} tab.`}
            >
              Linked · {s.linkedFrom}
            </span>
          ) : isMirror ? (
            <span
              className="ml-2 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-indigo-600"
              title={`Not a stage of its own: the strip's first pill, counting every lead still sitting on ${s.mirrors}. The board builds it, so it cannot be renamed, reordered or deleted.`}
            >
              Mirrors {s.mirrors}
            </span>
          ) : null}
          {/* The other half of that pair, said on the stage itself: its leads are on the
              board, they are just counted under a pill with a different name on it. */}
          {muted && stripRows.some((r) => r.id === MIRROR_ROW_ID && r.mirrors === s.name) ? (
            <span className="ml-2 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-slate-500">
              Counted under Leads
            </span>
          ) : null}
        </td>
        <td><span className="inline-flex h-7 min-w-[2rem] items-center justify-center rounded border border-slate-200 px-2 text-xs">{s.lead_count || 0}</span></td>
        <td>{s.is_final ? <Flag className="h-4 w-4 text-green-500" /> : null}</td>
        <td className="space-x-2">
          {isMirror ? null : (
            <>
              <button onClick={() => startEdit(s)} className="text-blue-500 hover:text-blue-700" data-testid={`stages-edit-${s.id}`}><Pencil className="h-4 w-4" /></button>
              <button onClick={() => remove(s)} className="text-red-500 hover:text-red-700" data-testid={`stages-delete-${s.id}`}><Trash2 className="h-4 w-4" /></button>
            </>
          )}
        </td>
      </tr>
    );
  };

  const cancelPassword = () => {
    setAskingPassword(false);
    setPasswordInput("");
  };

  const handleUnlock = async (e) => {
    e.preventDefault();
    if (!passwordInput) return;
    setUnlocking(true);
    try {
      await unlockDangerZone(passwordInput);
      // Hands the password to the shared store and opens the Danger Zone page at once --
      // and puts the red gear in the nav bar, which is how it reopens after Exit.
      unlockDevZone(passwordInput);
      setAskingPassword(false);
      setPasswordInput("");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not unlock");
      setPasswordInput("");
    }
    setUnlocking(false);
  };

  return (
    <div className="space-y-5" data-testid="pipeline-stages-page">
      {/* Heading removed with the others, and the back arrow after it: the Settings
          switcher already on this row is the way out, so the arrow was a second one.

          `leading` is that switcher (Marketing Source / CI/CD ROOTS) handed down by the
          page, so it and Add Stage share this one row instead of the switcher sitting on a
          row of its own above it. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {leading}
        <Button onClick={() => { setEditing(null); setForm({ ...EMPTY_FORM, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] }); setShowAdd(true); }} className="shrink-0 bg-sky-600 hover:bg-sky-700" data-testid="stages-add-btn"><Plus className="h-4 w-4 mr-1" />Add Stage</Button>
      </div>

      {/* A dropdown on a phone: five pipelines two-across left the fifth alone on a third
          row. Desktop keeps the five-up bar.

          Neither carries a stage count any more. The number belonged to the pipeline
          rather than to the choice, and the list below states it by simply being the
          list — a tab reading "Pre-Sales (4)" above four visible rows said it twice. */}
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:hidden"
        data-testid="stages-tab-select"
      >
        {TYPES.map((t) => <option key={t.key} value={t.key}>{t.online ? `${t.label} ✓ Online` : t.label}</option>)}
      </select>

      {/* One column per pipeline, counted from TYPES rather than written as a number: at a
          fixed five the sixth (Zumba) wrapped onto a row of its own, reading as a stray
          rather than as the last of six. A seventh pipeline should not need this line edited
          again -- adding it to TYPES is the whole change. */}
      <div
        className="hidden gap-2 rounded-lg bg-slate-100 p-1 sm:grid"
        style={{ gridTemplateColumns: `repeat(${TYPES.length}, minmax(0, 1fr))` }}
      >
        {TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => setType(t.key)}
            className={`rounded-md py-2 text-sm font-semibold ${type === t.key ? `bg-white shadow ${TONE_CLASSES[t.tone].text}` : "text-slate-500"}`}
            data-testid={`stages-tab-${t.key}`}
          >
            {/* Two tabs read "Branch Leads"; the tick is the only thing separating them, so
                it stays green whether or not the tab is the selected one -- a marker that
                changed colour with selection would stop being a marker. */}
            <span className="inline-flex items-center justify-center gap-1">
              {t.label}
              {t.online && <Check className="h-4 w-4 text-green-600" data-testid="stages-tab-online-mark" />}
            </span>
          </button>
        ))}
      </div>

      <Card data-testid="stages-list-card">
        <CardHeader><CardTitle className="text-base">{active.title} Pipeline Stages</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-2">Order</th><th>{hasStateColors ? "Colors" : "Color"}</th><th>Stage Name</th><th>{active.records}</th><th>Final</th><th>Actions</th></tr></thead>
            <tbody>
              {stripRows.map((s) => renderRow(s))}
              {hiddenRows.length > 0 && (
                <tr data-testid="stages-strip-divider">
                  <td colSpan="6" className="border-t border-slate-200 pt-5 pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Not shown on the Branch Leads strip
                    </p>
                    {/* Said plainly, because the rows below look like stages the branch has
                        lost and are nothing of the kind. Naming the mode matters too: the
                        split above describes a branch running its own leads, and a
                        Pre-Sales-fed one draws its own entry stage as well. */}
                    <p className="mt-1 max-w-2xl text-[11px] font-normal normal-case tracking-normal text-slate-400">
                      Real positions carrying real leads — the board reaches them another way, so the
                      strip has no pill for them. Still renameable, recolourable and reorderable here.
                      This split describes a branch running its own leads (Lead Control = Branch
                      Admin); a Pre-Sales-fed branch draws its own entry stage too.
                    </p>
                  </td>
                </tr>
              )}
              {hiddenRows.map((s) => renderRow(s, true))}
              {stages.length === 0 && <tr><td colSpan="6" className="py-6 text-center text-slate-400">No stages yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Developers only. The way into the Danger Zone, which is its own full-screen page
          now (DeveloperZone.jsx): a quiet button, then a password box — and once unlocked,
          the page opens and a red gear sits in the nav bar to reopen it. While it is
          unlocked this button simply reopens the page. */}
      {!askingPassword && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-slate-400 hover:text-slate-600"
            onClick={() => (devPassword ? openDevZone() : setAskingPassword(true))}
            data-testid="developer-access-btn"
          >
            <KeyRound className="mr-1 h-4 w-4" /> Developer Access
          </Button>
        </div>
      )}

      {!devPassword && askingPassword && (
        <Card data-testid="developer-password-card">
          <CardContent className="pt-5">
            <form onSubmit={handleUnlock} className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
                <Lock className="h-4 w-4" /> Developer password
              </div>
              <Input
                type="password"
                autoComplete="off"
                autoFocus
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="sm:max-w-xs"
                data-testid="developer-password-input"
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={unlocking || !passwordInput} data-testid="developer-unlock-btn">
                  {unlocking ? "Checking..." : "Unlock"}
                </Button>
                <Button type="button" variant="outline" onClick={cancelPassword} data-testid="developer-cancel-btn">
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" data-testid="stages-dialog">
          <div className="max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold">{editing ? "Edit Stage" : "Add Stage"}</h3>
            <Input placeholder="Stage name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="stages-form-name" />
            {hasStateColors ? (
              <div className="space-y-3">
                <ColorChoice label="Default Colour" value={form.color} fallback={form.color} onChange={(c) => setForm({ ...form, color: c })} testid="stages-form-color" />
                <ColorChoice label="Hover Colour" value={form.hover_color} fallback={form.color} allowDefault onChange={(c) => setForm({ ...form, hover_color: c })} testid="stages-form-hover-color" />
                <ColorChoice label="Selected Colour" value={form.selected_color} fallback={form.color} allowDefault onChange={(c) => setForm({ ...form, selected_color: c })} testid="stages-form-selected-color" />
                <StatePreview name={form.name} color={form.color} hover={form.hover_color} selected={form.selected_color} />
              </div>
            ) : (
              <div>
                <p className="mb-1 text-xs text-slate-500">Color</p>
                <div className="flex flex-wrap gap-2">
                  {PALETTE.map((c) => (
                    <button key={c} onClick={() => setForm({ ...form, color: c })} className={`h-7 w-7 rounded-full border-2 ${form.color === c ? "border-slate-900 ring-2 ring-offset-1" : "border-transparent"}`} style={{ background: c }} data-testid={`stages-form-color-${c}`} />
                  ))}
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.is_final} onChange={(e) => setForm({ ...form, is_final: e.target.checked })} data-testid="stages-form-final" />Mark as Final stage</label>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setShowAdd(false); setEditing(null); }} className="flex-1" data-testid="stages-form-cancel">Cancel</Button>
              <Button onClick={submit} className="flex-1" data-testid="stages-form-submit">{editing ? "Save" : "Create"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PipelineStageManagement;
