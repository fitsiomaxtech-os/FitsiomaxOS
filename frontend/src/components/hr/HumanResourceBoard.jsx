import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Briefcase,
  CalendarClock,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  FileText,
  IndianRupee,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  RefreshCw,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { MilkDateInput, MilkTimeInput } from "@/components/ui/milk-calendar";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { CandidatePullButton } from "@/components/hr/CandidatePullButton";
import { CandidateSheetPanel } from "@/components/hr/CandidateSheetPanel";
import { RecruitmentStagesPanel } from "@/components/hr/RecruitmentStagesPanel";
import { to12h } from "@/lib/time";
import { MyProfilePage } from "@/components/MyProfilePage";
import { ProfileNavGlyph } from "@/components/ui/employee-avatar";
import {
  recruitmentBoard,
  recruitmentCreateCandidate,
  recruitmentUpdateCandidate,
  recruitmentMoveCandidate,
  recruitmentScheduleInterview,
  recruitmentRecordOffer,
  recruitmentAddNote,
  recruitmentDeleteCandidate,
} from "@/lib/api";

// The Human Resource Master View: one board for the whole recruitment process, from a CV
// landing to someone joining.
//
// Indigo rather than the clinical sky/teal — HR is the one board here that isn't about a
// patient, and the colour is the quickest way to know which OS you are looking at.
//
// Stage names are never written down in this file. Every stage arrives from the API with
// its own id and colour, and a candidate is moved by id — so HR can rename "Screening" to
// anything and nothing in here needs changing.

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const money = (n) =>
  n || n === 0 ? `Rs.${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";

const prettyDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const sinceDays = (iso) => {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
};

const emptyCandidate = {
  full_name: "",
  phone: "",
  email: "",
  position: "",
  department: "",
  location: "",
  experience_years: "",
  current_ctc: "",
  expected_ctc: "",
  source: "Walk-in",
  resume_url: "",
  notes: "",
};

// This board is about candidates and nothing else: the people you are hiring, and the
// plumbing that feeds and shapes that pipeline. Employees already on staff are HR Admin's
// job, under Super Admin.
const VIEWS = [
  { key: "pipeline", label: "Candidates", icon: Users },
  { key: "sources", label: "Source Manage", icon: FileSpreadsheet },
];

// `roleLabel` / `onLogout` are for the phone bar's My Profile stop: the page stands in the
// board's place with the bar still under it, and Logout sits on its Security tab.
export const HumanResourceBoard = ({ user, roleLabel = "", onLogout }) => {
  const [board, setBoard] = useState({ stages: [], candidates: [], summary: {}, sources: [], interview_modes: [] });
  const [loading, setLoading] = useState(false);
  const [stageFilter, setStageFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState(null);
  // The sheet connections are setup, not day-to-day work, so they sit behind their own
  // view rather than above the pipeline where they'd be scrolled past every morning.
  const [view, setView] = useState("pipeline");
  // null, not an empty object — the filter reads `!!value` to decide whether it is active,
  // and clearing it sets null, so any other empty shape would show as filtered from the
  // first render and never match the cleared state.
  const [dateFilter, setDateFilter] = useState(null); // { from, to, label, key } | null
  const [sortDir, setSortDir] = useState("newest");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await recruitmentBoard();
      setBoard(data);
      // Keep an open candidate card in sync with what just came back, so a stage move or a
      // new note shows in the popup without closing and reopening it.
      setSelected((prev) => (prev ? (data.candidates || []).find((c) => c.id === prev.id) || null : null));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load the recruitment board");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stages = board.stages || [];
  const totalCount = (board.candidates || []).length;

  // Stage card, date, search then sort narrow the same list, in that order.
  const rows = useMemo(() => {
    let list = board.candidates || [];
    if (stageFilter !== "all") list = list.filter((c) => c.stage_id === stageFilter);

    if (dateFilter?.from && dateFilter?.to) {
      const from = dateFilter.from.getTime();
      const to = dateFilter.to.getTime();
      list = list.filter((c) => {
        const t = new Date(c.created_at || 0).getTime();
        return Number.isFinite(t) && t >= from && t <= to;
      });
    }

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((c) =>
        [c.full_name, c.phone, c.email, c.position, c.department]
          .some((f) => String(f || "").toLowerCase().includes(q)),
      );
    }

    // Copy before sorting — the board's own array is the source for every other count.
    return [...list].sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return sortDir === "newest" ? tb - ta : ta - tb;
    });
  }, [board.candidates, stageFilter, search, dateFilter, sortDir]);

  return (
    <div className="space-y-4 pb-24 md:pb-6" data-testid="hr-recruitment-board">
      {/* Candidates is the daily work and stays first; Source Manage is setup, and sits
          behind it rather than beside the pipeline where it was scrolled past every
          morning.

          Plain tabs on a rule, matching the Super Admin nav — this is top-level navigation,
          and a segmented control reads as a filter on the thing below it. On a phone the
          same two live in the bottom bar instead, thumb-high. */}
      <div className="hidden flex-wrap gap-2 border-b border-slate-200 pb-2 md:flex" data-testid="hr-view-switch">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                view === v.key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
              data-testid={`hr-view-${v.key}`}
            >
              <Icon className="h-4 w-4" /> {v.label}
            </button>
          );
        })}
      </div>

      {view === "profile" && (
        <MyProfilePage user={user} roleLabel={roleLabel} onBack={() => setView("pipeline")} onLogout={onLogout} phoneBar />
      )}

      {view === "sources" && (
        <SourceManageView
          stageCount={stages.length}
          onImported={() => { load(); setView("pipeline"); }}
          onStagesChanged={load}
        />
      )}

      {view === "pipeline" && (
      <>
      {/* One row of cards, not two. The summary cards and the stage bar were both filters
          over the same list sitting one above the other, and the four summary answers were
          reachable from the stages anyway — Closed is Joined plus Rejected, In Process is
          everything else.

          The stages wear the summary card now: white, bordered, label over count, aligned
          left. Each keeps its own colour on the label and number so the pipeline is still
          readable at a glance; selecting one brings that colour to the border and a wash of
          it to the card, the same move the summary cards made in indigo. */}
      {/* Five to a row on a phone, so nine stages land as 5 + 4 and the whole pipeline is
          visible at once. It used to scroll sideways, which hid every stage past Screening
          behind a swipe nobody knew to make.

          flex-wrap rather than a 5-column grid: a grid pins the last four to columns 1-4
          and leaves a hole on the right, and there is no way to centre a partial final row.
          The cards are sized to fit exactly five, so full rows still reach both edges and
          only the short row centres. */}
      <div
        className="flex flex-wrap justify-center gap-1.5 sm:grid sm:grid-cols-3 sm:gap-3 lg:grid-cols-5 xl:grid-cols-9"
        style={{ fontFamily: "Lexend, sans-serif" }}
        data-testid="hr-stage-pills"
      >
        <StageCard
          label="All Stages"
          count={totalCount}
          color="#0ea5e9"
          active={stageFilter === "all"}
          onClick={() => setStageFilter("all")}
          testid="hr-stage-pill-all"
        />
        {stages.map((s) => (
          <StageCard
            key={s.id}
            label={s.name}
            count={s.count ?? 0}
            color={s.color || "#64748b"}
            active={stageFilter === s.id}
            onClick={() => setStageFilter(stageFilter === s.id ? "all" : s.id)}
            testid={`hr-stage-pill-${s.id}`}
          />
        ))}
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, phone, email or position..."
            className="min-w-0 flex-1 border-0 p-0 text-sm outline-none placeholder:text-slate-400"
            data-testid="hr-search-input"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="shrink-0 text-slate-400 hover:text-slate-600" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Centred on a phone: Add Candidate is a FAB down there, so the row is three
            controls that would otherwise sit hard left with a hole where the button isn't. */}
        <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-start">
          {/* Filters by when the candidate was added, which is what "0d / 19d" in the Age
              column counts from — the two answer the same question. */}
          <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="hr-date-filter" centered iconOnly />

          {/* Reloads the board. Distinct from the green Pull from Sheet at the end of
              this row, which reaches out to Google Sheets and can create candidates —
              they share an icon and mean different things, so this one is orange to
              match the refresh on every other Master View. */}
          <Button
            onClick={load}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-orange-500 p-0 text-white hover:bg-orange-600"
            data-testid="hr-refresh-button"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>

          {/* Icon only, but the arrow direction still carries the state — an ArrowUpDown
              would have said "sortable" without saying which way it is sorted, and that
              is the one thing this control exists to tell you. */}
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === "newest" ? "oldest" : "newest"))}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            title={sortDir === "newest" ? "Newest first" : "Oldest first"}
            aria-label={sortDir === "newest" ? "Newest first" : "Oldest first"}
            data-testid="hr-sort-toggle"
          >
            {sortDir === "newest"
              ? <ArrowDownNarrowWide className="h-4 w-4 shrink-0 text-slate-500" />
              : <ArrowUpNarrowWide className="h-4 w-4 shrink-0 text-slate-500" />}
          </button>

          <Button
            onClick={() => setShowAdd(true)}
            title="Add Candidate"
            aria-label="Add Candidate"
            className="hidden h-10 w-10 shrink-0 bg-sky-600 p-0 text-white hover:bg-sky-700 sm:inline-flex"
            data-testid="hr-add-candidate-button"
          >
            <UserPlus className="h-4 w-4" />
          </Button>

          <CandidatePullButton onPulled={load} />
        </div>
      </div>

      <CandidateList rows={rows} onOpen={setSelected} loading={loading} />

      {/* On a phone the header button is a scroll away by the time you've read the list.
          Sits above the bottom bar rather than on top of it. */}
      <button
        type="button"
        onClick={() => setShowAdd(true)}
        className="fixed bottom-20 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg sm:hidden"
        aria-label="Add candidate"
        data-testid="hr-add-candidate-fab"
      >
        <Plus className="h-6 w-6" />
      </button>
      </>
      )}

      {/* Same destinations as the desktop tabs above, from the one VIEWS array so the two
          surfaces can't drift apart. */}
      <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-slate-200 bg-white shadow-[0_-2px_10px_rgba(0,0,0,0.06)] md:hidden" data-testid="hr-bottom-nav">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = view === v.key;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium leading-tight ${
                active ? "text-indigo-600" : "text-slate-400"
              }`}
              data-testid={`hr-nav-${v.key}`}
            >
              <Icon className="h-5 w-5" />
              {v.label}
            </button>
          );
        })}
        {/* My Profile, and Logout on its Security tab -- the phone header carries neither. */}
        <button
          type="button"
          onClick={() => setView("profile")}
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium leading-tight ${
            view === "profile" ? "text-indigo-600" : "text-slate-400"
          }`}
          data-testid="hr-nav-profile"
        >
          <ProfileNavGlyph user={user} size={22} />
          Profile
        </button>
      </nav>

      {showAdd && (
        <AddCandidateModal
          sources={board.sources || []}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}

      {selected && (
        <CandidateModal
          candidate={selected}
          stages={stages}
          modes={board.interview_modes || []}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </div>
  );
};


/** A stage as a summary card: label over count, left aligned, white and bordered.
 *
 *  The stage's own colour carries the label and the number rather than the whole card, so
 *  nine of these side by side stay legible — nine saturated blocks read as a warning, not a
 *  pipeline. Selecting one pulls that colour onto the border and washes it faintly through
 *  the card, which is what the indigo summary cards did before them. */
const StageCard = ({ label, count, color, active, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    /* 20% minus its share of the four 0.375rem gaps — five across exactly, so a full row
       spans the container and the leftover row can centre under it. w-full from sm up,
       where the layout is a grid and the cell decides the width. */
    className={`w-[calc(20%-0.3rem)] min-w-0 rounded-lg border-2 px-1 py-1.5 text-center transition hover:shadow-sm sm:w-full sm:rounded-xl sm:px-4 sm:py-4 sm:text-left ${
      active ? "shadow-sm" : "border-slate-200 bg-white"
    }`}
    style={active ? { borderColor: color, backgroundColor: `${color}14` } : undefined}
    data-testid={testid}
  >
    {/* In a fifth of a phone's width a long stage name has to wrap rather than truncate —
        "Consultation" and "Consultatio…" are the same width and only one is readable. The
        wide tracking goes too; at 9px it costs a character per line and buys nothing. */}
    <span
      className="block break-words text-[9px] font-bold uppercase leading-[1.15] [hyphens:auto] sm:truncate sm:text-xs sm:tracking-wider"
      style={{ color }}
      title={label}
    >
      {label}
    </span>
    <span className="mt-0.5 block text-lg font-extrabold leading-tight sm:mt-1 sm:text-3xl" style={{ color }}>
      {count}
    </span>
  </button>
);


/** Where candidates come from, and the shape they move through — the two halves of the
    pipeline's plumbing, kept side by side because they are usually set up together and
    then rarely touched again. */
const SourceManageView = ({ stageCount, onImported, onStagesChanged }) => {
  const [sub, setSub] = useState("sheets");
  return (
    <div className="space-y-4" data-testid="hr-source-manage">
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1 sm:max-w-md" data-testid="hr-source-subtabs">
        {[
          { key: "sheets", label: "Google Sheets", icon: FileSpreadsheet },
          { key: "stages", label: `Manage Stage (${stageCount})`, icon: SlidersHorizontal },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSub(t.key)}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-semibold transition sm:text-sm ${
                sub === t.key ? "bg-white text-indigo-600 shadow" : "text-slate-500 hover:text-slate-700"
              }`}
              data-testid={`hr-source-sub-${t.key}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      {sub === "sheets" && <CandidateSheetPanel onImported={onImported} />}
      {sub === "stages" && <RecruitmentStagesPanel onChanged={onStagesChanged} />}
    </div>
  );
};


/** Table from tablet up; on a phone the same rows as a flat list split by thin lines,
    where six columns can only scroll sideways past the ones that matter. */
const CandidateList = ({ rows, onOpen, loading }) => {
  if (!rows.length) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 px-3 py-14 text-center text-sm text-slate-400" data-testid="hr-list-empty">
        {loading ? "Loading candidates..." : "No candidates here yet."}
      </p>
    );
  }

  return (
    <>
      <div className="divide-y divide-slate-200 border-y border-slate-200 sm:hidden" data-testid="hr-list-mobile">
        {rows.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen(c)}
            className="block w-full px-1 py-3 text-left active:bg-slate-50"
            data-testid={`hr-card-row-${c.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">{c.full_name}</p>
                <p className="truncate text-xs text-slate-500">{c.position || "Position not set"}</p>
              </div>
              <StagePill candidate={c} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>{c.phone}</span>
              {c.experience_years ? <span>· {c.experience_years} yrs</span> : null}
              {c.expected_ctc ? <span>· exp {money(c.expected_ctc)}</span> : null}
              {(c.interview || {}).interview_date ? (
                <span className="font-semibold text-amber-600">
                  · {prettyDate(c.interview.interview_date)} {to12h(c.interview.interview_time)}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="hr-list-desktop">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Candidate</th>
                <th className="px-4 py-2.5 font-semibold">Position</th>
                <th className="px-4 py-2.5 font-semibold">Contact</th>
                <th className="px-4 py-2.5 font-semibold">Experience</th>
                <th className="px-4 py-2.5 font-semibold">Expected</th>
                <th className="px-4 py-2.5 font-semibold">Stage</th>
                <th className="px-4 py-2.5 font-semibold">Interview</th>
                <th className="px-4 py-2.5 font-semibold">Age</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => {
                const age = sinceDays(c.created_at);
                return (
                  <tr
                    key={c.id}
                    onClick={() => onOpen(c)}
                    className="cursor-pointer hover:bg-slate-50"
                    data-testid={`hr-row-${c.id}`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{c.full_name}</p>
                      <p className="text-[11px] text-slate-400">{c.source || "—"}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.position || "—"}
                      {c.department ? <span className="block text-[11px] text-slate-400">{c.department}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.phone}
                      {c.email ? <span className="block truncate text-[11px] text-slate-400">{c.email}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{c.experience_years ? `${c.experience_years} yrs` : "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{money(c.expected_ctc)}</td>
                    <td className="px-4 py-3"><StagePill candidate={c} /></td>
                    <td className="px-4 py-3 text-slate-500">
                      {(c.interview || {}).interview_date
                        ? <span className="whitespace-nowrap">{prettyDate(c.interview.interview_date)} {to12h(c.interview.interview_time)}</span>
                        : "—"}
                    </td>
                    {/* How long they have been sitting in the pipeline — the number that
                        makes a stalled candidate obvious without opening anything. */}
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-bold ${age > 14 ? "text-red-500" : age > 7 ? "text-amber-500" : "text-slate-400"}`}>
                        {age === null ? "—" : `${age}d`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right"><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};


const StagePill = ({ candidate }) => (
  <span
    className="inline-flex shrink-0 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold"
    style={{
      color: candidate.stage_color,
      borderColor: `${candidate.stage_color}55`,
      backgroundColor: `${candidate.stage_color}14`,
    }}
    data-testid={`hr-stage-badge-${candidate.id}`}
  >
    {candidate.stage_name}
  </span>
);


const Field = ({ label, children, className = "" }) => (
  <div className={className}>
    <label className="mb-1 block text-xs font-semibold text-slate-600">{label}</label>
    {children}
  </div>
);


const AddCandidateModal = ({ sources, onClose, onSaved }) => {
  const [form, setForm] = useState(emptyCandidate);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.full_name.trim() || !form.phone.trim()) {
      toast.error("Name and phone are required");
      return;
    }
    setBusy(true);
    try {
      // Blank number fields must go as null, not "" — the API types them as floats.
      await recruitmentCreateCandidate({
        ...form,
        experience_years: form.experience_years === "" ? null : Number(form.experience_years),
        current_ctc: form.current_ctc === "" ? null : Number(form.current_ctc),
        expected_ctc: form.expected_ctc === "" ? null : Number(form.expected_ctc),
      });
      toast.success("Candidate added");
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add this candidate");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="hr-add-modal">
      {/* One settled box: header and footer are real flex rows rather than sticky
          overlays, and the panel itself never scrolls. The form is tuned to fit inside
          it, so on any normal screen there is no scrollbar at all — the middle only
          starts scrolling (quietly, no track drawn) on a genuinely short window. */}
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            <p className="text-base font-semibold">Add Candidate</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="hr-add-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Field label="Full Name *"><Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} placeholder="e.g. Ramya Raju" data-testid="hr-add-name" /></Field>
          <Field label="Phone *"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="10-digit mobile" data-testid="hr-add-phone" /></Field>
          <Field label="Email"><Input value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@example.com" data-testid="hr-add-email" /></Field>
          <Field label="Position Applied For"><Input value={form.position} onChange={(e) => set("position", e.target.value)} placeholder="e.g. Physiotherapist" data-testid="hr-add-position" /></Field>
          <Field label="Department"><Input value={form.department} onChange={(e) => set("department", e.target.value)} placeholder="e.g. Clinical" data-testid="hr-add-department" /></Field>
          <Field label="Location"><Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="e.g. Anna Nagar" data-testid="hr-add-location" /></Field>
          <Field label="Experience (years)"><Input type="number" min="0" step="0.5" value={form.experience_years} onChange={(e) => set("experience_years", e.target.value)} data-testid="hr-add-experience" /></Field>
          <Field label="Source">
            <select
              value={form.source}
              onChange={(e) => set("source", e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              data-testid="hr-add-source"
            >
              {(sources.length ? sources : ["Walk-in"]).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Current CTC (annual)"><Input type="number" min="0" value={form.current_ctc} onChange={(e) => set("current_ctc", e.target.value)} placeholder="0" data-testid="hr-add-current-ctc" /></Field>
          <Field label="Expected CTC (annual)"><Input type="number" min="0" value={form.expected_ctc} onChange={(e) => set("expected_ctc", e.target.value)} placeholder="0" data-testid="hr-add-expected-ctc" /></Field>
          <Field label="Resume Link" className="sm:col-span-2"><Input value={form.resume_url} onChange={(e) => set("resume_url", e.target.value)} placeholder="Drive / Dropbox link" data-testid="hr-add-resume" /></Field>
          <Field label="Notes" className="sm:col-span-2">
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Anything worth remembering about this candidate..."
              className="w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              data-testid="hr-add-notes"
            />
          </Field>
        </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="hr-add-cancel">Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-indigo-600 text-white hover:bg-indigo-700" data-testid="hr-add-save">
            {busy ? "Saving..." : "Add Candidate"}
          </Button>
        </div>
      </div>
    </div>
  );
};


const CandidateModal = ({ candidate, stages, modes, onClose, onChanged }) => {
  const [tab, setTab] = useState("process");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [remark, setRemark] = useState("");
  const [note, setNote] = useState("");
  const [interview, setInterview] = useState({
    interview_date: (candidate.interview || {}).interview_date || todayIso(),
    interview_time: (candidate.interview || {}).interview_time || "10:00",
    mode: (candidate.interview || {}).mode || "In-person",
    panel: (candidate.interview || {}).panel || "",
    notes: (candidate.interview || {}).notes || "",
  });
  const [offer, setOffer] = useState({
    offered_ctc: (candidate.offer || {}).offered_ctc ?? "",
    joining_date: (candidate.offer || {}).joining_date || "",
    notes: (candidate.offer || {}).notes || "",
  });

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(okMsg);
      await onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "That did not go through");
    }
    setBusy(false);
  };

  const move = (stage) => run(
    () => recruitmentMoveCandidate(candidate.id, { stage_id: stage.id, remark: remark.trim() }),
    `Moved to ${stage.name}`,
  ).then(() => setRemark(""));

  const removeCandidate = () => {
    if (!window.confirm(`Remove ${candidate.full_name} from the pipeline? This cannot be undone.`)) return;
    run(() => recruitmentDeleteCandidate(candidate.id), "Candidate removed").then(onClose);
  };

  const history = [...(candidate.history || [])].reverse();
  const age = sinceDays(candidate.created_at);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="hr-candidate-modal">
      <div className="flex max-h-[95vh] h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-4 text-white">
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{candidate.full_name}</p>
            <p className="truncate text-xs text-white/80">
              {candidate.position || "Position not set"}
              {candidate.department ? ` · ${candidate.department}` : ""}
              {age !== null ? ` · ${age} days in pipeline` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-[5px] bg-white/20 px-2 py-1 text-[11px] font-bold">{candidate.stage_name}</span>
            <button onClick={onClose} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="hr-candidate-close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-slate-200 px-3 pt-2">
          {[
            { key: "process", label: "Recruitment Process" },
            { key: "details", label: "Details" },
            { key: "history", label: `History (${history.length})` },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-t-md px-3 py-2 text-xs font-bold transition sm:text-sm ${
                tab === t.key ? "border-b-2 border-indigo-600 text-indigo-700" : "text-slate-500 hover:text-slate-700"
              }`}
              data-testid={`hr-candidate-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "process" && (
            <div className="space-y-5" data-testid="hr-candidate-process">
              {/* The pipeline as a track, so where they are and what is left both read at
                  a glance. Past stages fill in; the current one is solid. */}
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Pipeline</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {stages.map((s) => {
                    const here = s.id === candidate.stage_id;
                    const passed = s.order < (candidate.stage_order ?? 0) && !s.is_final;
                    return (
                      <span
                        key={s.id}
                        className="rounded-full border px-2.5 py-1 text-[11px] font-bold"
                        style={here
                          ? { backgroundColor: s.color, borderColor: s.color, color: "#fff" }
                          : passed
                            ? { backgroundColor: `${s.color}22`, borderColor: `${s.color}55`, color: s.color }
                            : { borderColor: "#e2e8f0", color: "#94a3b8" }}
                        data-testid={`hr-track-${s.id}`}
                      >
                        {s.name}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Move to Stage</p>
                <Input
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="Remark for this move (optional — required in spirit when rejecting)"
                  className="mb-2"
                  data-testid="hr-move-remark"
                />
                <div className="flex flex-wrap gap-2">
                  {stages.filter((s) => s.id !== candidate.stage_id).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={busy}
                      onClick={() => move(s)}
                      className="rounded-md border px-3 py-2 text-xs font-bold transition hover:shadow-sm disabled:opacity-50"
                      style={{ borderColor: `${s.color}77`, color: s.color }}
                      data-testid={`hr-move-to-${s.id}`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <CalendarClock className="h-3.5 w-3.5" /> Interview
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Date">
                    <MilkDateInput
                      value={interview.interview_date}
                      accent="sky"
                      onChange={(e) => setInterview({ ...interview, interview_date: e.target.value })}
                      data-testid="hr-interview-date"
                    />
                  </Field>
                  <Field label="Time">
                    <MilkTimeInput
                      value={interview.interview_time}
                      accent="sky"
                      onChange={(e) => setInterview({ ...interview, interview_time: e.target.value })}
                      data-testid="hr-interview-time"
                    />
                  </Field>
                  <Field label="Mode">
                    <select
                      value={interview.mode}
                      onChange={(e) => setInterview({ ...interview, mode: e.target.value })}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                      data-testid="hr-interview-mode"
                    >
                      {(modes.length ? modes : ["In-person"]).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Panel / Interviewer">
                    <Input value={interview.panel} onChange={(e) => setInterview({ ...interview, panel: e.target.value })} placeholder="Who is taking it" data-testid="hr-interview-panel" />
                  </Field>
                </div>
                <Button
                  onClick={() => run(() => recruitmentScheduleInterview(candidate.id, interview), "Interview scheduled")}
                  disabled={busy}
                  className="mt-3 bg-indigo-600 text-white hover:bg-indigo-700"
                  data-testid="hr-interview-save"
                >
                  {candidate.interview ? "Update Interview" : "Schedule Interview"}
                </Button>
                {candidate.interview && (
                  <p className="mt-2 text-xs text-slate-500" data-testid="hr-interview-current">
                    Currently: <span className="font-semibold text-slate-700">
                      {prettyDate(candidate.interview.interview_date)} · {to12h(candidate.interview.interview_time)} · {candidate.interview.mode}
                      {candidate.interview.panel ? ` · ${candidate.interview.panel}` : ""}
                    </span>
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <IndianRupee className="h-3.5 w-3.5" /> Offer
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Offered CTC (annual)">
                    <Input type="number" min="0" value={offer.offered_ctc} onChange={(e) => setOffer({ ...offer, offered_ctc: e.target.value })} placeholder="0" data-testid="hr-offer-ctc" />
                  </Field>
                  <Field label="Joining Date">
                    <MilkDateInput
                      value={offer.joining_date}
                      accent="teal"
                      onChange={(e) => setOffer({ ...offer, joining_date: e.target.value })}
                      data-testid="hr-offer-joining-date"
                    />
                  </Field>
                </div>
                <Button
                  onClick={() => run(
                    () => recruitmentRecordOffer(candidate.id, {
                      ...offer,
                      offered_ctc: offer.offered_ctc === "" ? null : Number(offer.offered_ctc),
                    }),
                    "Offer recorded",
                  )}
                  disabled={busy}
                  variant="outline"
                  className="mt-3 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                  data-testid="hr-offer-save"
                >
                  Record Offer
                </Button>
                {candidate.offer && (
                  <p className="mt-2 text-xs text-slate-500" data-testid="hr-offer-current">
                    Currently: <span className="font-semibold text-slate-700">
                      {money(candidate.offer.offered_ctc)}
                      {candidate.offer.joining_date ? ` · joins ${prettyDate(candidate.offer.joining_date)}` : ""}
                    </span>
                  </p>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Add a Note</p>
                <div className="flex gap-2">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened in the last conversation..." data-testid="hr-note-input" />
                  <Button
                    onClick={() => run(() => recruitmentAddNote(candidate.id, note), "Note added").then(() => setNote(""))}
                    disabled={busy || !note.trim()}
                    variant="outline"
                    data-testid="hr-note-save"
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
          )}

          {tab === "details" && editing && (
            <EditDetails
              candidate={candidate}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSave={(patch) => run(
                () => recruitmentUpdateCandidate(candidate.id, patch),
                "Candidate updated",
              ).then(() => setEditing(false))}
            />
          )}

          {tab === "details" && !editing && (
            <div className="space-y-4" data-testid="hr-candidate-details">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                  data-testid="hr-candidate-edit"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit Details
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Detail icon={Phone} label="Phone" value={candidate.phone} />
                <Detail icon={Mail} label="Email" value={candidate.email} />
                <Detail icon={Briefcase} label="Position" value={candidate.position} />
                <Detail icon={Users} label="Department" value={candidate.department} />
                <Detail icon={MapPin} label="Location" value={candidate.location} />
                <Detail icon={Clock} label="Experience" value={candidate.experience_years ? `${candidate.experience_years} years` : ""} />
                <Detail icon={IndianRupee} label="Current CTC" value={candidate.current_ctc ? money(candidate.current_ctc) : ""} />
                <Detail icon={IndianRupee} label="Expected CTC" value={candidate.expected_ctc ? money(candidate.expected_ctc) : ""} />
                <Detail icon={FileText} label="Source" value={candidate.source} />
                <Detail icon={Clock} label="Added" value={candidate.created_at ? prettyDate(candidate.created_at.slice(0, 10)) : ""} />
              </div>

              {candidate.resume_url && (
                <a
                  href={candidate.resume_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
                  data-testid="hr-resume-link"
                >
                  <FileText className="h-4 w-4" /> Open Resume
                </a>
              )}

              {candidate.notes && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">Notes</p>
                  <p className="whitespace-pre-wrap text-sm text-slate-700">{candidate.notes}</p>
                </div>
              )}

              {candidate.rejected_reason && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                  <p className="mb-1 text-xs font-bold uppercase tracking-wider text-red-400">Closing Remark</p>
                  <p className="text-sm text-red-700">{candidate.rejected_reason}</p>
                </div>
              )}

              <button
                type="button"
                onClick={removeCandidate}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-600 disabled:opacity-50"
                data-testid="hr-candidate-delete"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove from pipeline
              </button>
            </div>
          )}

          {tab === "history" && (
            <div data-testid="hr-candidate-history">
              {history.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">Nothing recorded yet.</p>
              ) : (
                <ol className="space-y-3">
                  {history.map((h, i) => (
                    <li key={`${h.at}-${i}`} className="flex gap-3">
                      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-400" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">{h.action}</p>
                        {h.detail && <p className="text-sm text-slate-600">{h.detail}</p>}
                        <p className="text-[11px] text-slate-400">
                          {h.by} · {h.at ? new Date(h.at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};


/** Correcting what was typed at intake — a wrong phone number otherwise makes the whole
    record dead weight. Stage, interview and offer are not here on purpose: those are moves
    in the process, and they belong on the Recruitment Process tab where they leave a
    history entry behind. */
const EditDetails = ({ candidate, busy, onCancel, onSave }) => {
  const [form, setForm] = useState({
    full_name: candidate.full_name || "",
    phone: candidate.phone || "",
    email: candidate.email || "",
    position: candidate.position || "",
    department: candidate.department || "",
    location: candidate.location || "",
    experience_years: candidate.experience_years ?? "",
    current_ctc: candidate.current_ctc ?? "",
    expected_ctc: candidate.expected_ctc ?? "",
    resume_url: candidate.resume_url || "",
    notes: candidate.notes || "",
  });
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const save = () => {
    if (!form.full_name.trim() || !form.phone.trim()) {
      toast.error("Name and phone are required");
      return;
    }
    // The API drops nulls rather than writing them, so a cleared number simply stays as
    // it was — sending "" instead would fail float validation.
    onSave({
      ...form,
      experience_years: form.experience_years === "" ? null : Number(form.experience_years),
      current_ctc: form.current_ctc === "" ? null : Number(form.current_ctc),
      expected_ctc: form.expected_ctc === "" ? null : Number(form.expected_ctc),
    });
  };

  return (
    <div className="space-y-4" data-testid="hr-candidate-edit-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full Name *"><Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} data-testid="hr-edit-name" /></Field>
        <Field label="Phone *"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} data-testid="hr-edit-phone" /></Field>
        <Field label="Email"><Input value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="hr-edit-email" /></Field>
        <Field label="Position"><Input value={form.position} onChange={(e) => set("position", e.target.value)} data-testid="hr-edit-position" /></Field>
        <Field label="Department"><Input value={form.department} onChange={(e) => set("department", e.target.value)} data-testid="hr-edit-department" /></Field>
        <Field label="Location"><Input value={form.location} onChange={(e) => set("location", e.target.value)} data-testid="hr-edit-location" /></Field>
        <Field label="Experience (years)"><Input type="number" min="0" step="0.5" value={form.experience_years} onChange={(e) => set("experience_years", e.target.value)} data-testid="hr-edit-experience" /></Field>
        <Field label="Current CTC"><Input type="number" min="0" value={form.current_ctc} onChange={(e) => set("current_ctc", e.target.value)} data-testid="hr-edit-current-ctc" /></Field>
        <Field label="Expected CTC"><Input type="number" min="0" value={form.expected_ctc} onChange={(e) => set("expected_ctc", e.target.value)} data-testid="hr-edit-expected-ctc" /></Field>
        <Field label="Resume Link"><Input value={form.resume_url} onChange={(e) => set("resume_url", e.target.value)} data-testid="hr-edit-resume" /></Field>
        <Field label="Notes" className="sm:col-span-2">
          <textarea
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            data-testid="hr-edit-notes"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} data-testid="hr-edit-cancel">Cancel</Button>
        <Button onClick={save} disabled={busy} className="bg-indigo-600 text-white hover:bg-indigo-700" data-testid="hr-edit-save">
          {busy ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
};


const Detail = ({ icon: Icon, label, value }) => (
  <div className="flex items-start gap-2.5 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="truncate text-sm font-medium text-slate-800">{value || "—"}</p>
    </div>
  </div>
);

export default HumanResourceBoard;
