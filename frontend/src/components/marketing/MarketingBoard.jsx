import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileSpreadsheet, Users,
  Plus, RefreshCw, ArrowRightLeft, X, Pencil, ChevronRight, Archive, ArchiveRestore, Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemedSelect } from "@/components/ui/themed-select";
import { toast } from "@/components/ui/sonner";
import {
  mkGetDistribution, mkPatchDistribution, mkRefreshDistribution,
  mkUnassignedCount, mkDistributeUnassigned,
  mkGetTeam, mkCreateTeamMember,
  mkGetSources, mkLeadFieldCatalogue, gsSheetHeaders, leadFieldsCreate, mkCreateSource, mkUpdateSource, mkDeleteSource,
  gsStatus, gsAuthUrl, gsDisconnect, gsPull, gsListTabs,
  getBranches,
} from "@/lib/api";
import { MaskedContact } from "@/components/MaskedContact";

// Extract spreadsheet ID from any Google Sheets URL: /spreadsheets/d/{ID}/...
// Shared by SourcesTab, EditSourceDialog, and SheetEntriesEditor rather than each keeping
// its own copy.
const extractSheetId = (url) => {
  if (!url) return "";
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : "";
};

const emptySheetEntry = () => ({
  id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  sheet_url: "", spreadsheet_id: "", sheet_names: ["Sheet1"],
  // {lead field key: sheet column}. Held on the row rather than on the dialog because a
  // row that is not the first becomes its own source on Save, and its mapping has to
  // travel with it — otherwise every sheet added in one go would land unmapped.
  column_mapping: {},
});

// "offline_physiotherapy" -> "Offline Physiotherapy". The stored name stays snake_case
// (matched against branches.vertical/verticals.name elsewhere); only the label is prettied.
const prettyVertical = (v) => String(v || "")
  .split("_")
  .filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(" ");

// Every default vertical is named "online_.../offline_..." — same helper as
// Branches & Verticals' own mode tag, read off that prefix.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// Type column: "google_sheets" -> "Google Sheet"; anything else goes through the same
// snake_case prettifier the vertical tags use ("walk_in" -> "Walk In").
const sourceTypeLabel = (t) => (t === "google_sheets" || t === "google_sheet" ? "Google Sheet" : prettyVertical(t) || "Other");

// Sync Status column. last_synced is stored as a UTC ISO string; shown in the viewer's
// own clock, date and time, e.g. "20 Nov 2026, 11:53 am".
const formatSynced = (iso) => {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
};

const SUB_TABS = [
  { key: "team", label: "Team & Distribution", icon: Users },
  { key: "lead_sources", label: "Lead Sources", icon: FileSpreadsheet },
];

const TabBtn = ({ active, label, Icon, onClick, testid }) => (
  <button
    onClick={onClick}
    data-testid={testid}
    className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-600 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}
  >
    <Icon className="h-4 w-4" />
    {label}
  </button>
);

// ============ Sources ============

const SourcesTab = ({ branches: branchesProp = [] }) => {
  const [branches, setBranches] = useState(branchesProp);
  const loadBranches = useCallback(() => getBranches().then(setBranches).catch((e) => console.warn("[branches]", e?.message || e)), []);
  useEffect(() => { loadBranches(); }, [loadBranches]);

  const [sources, setSources] = useState([]);
  // Which of them are shown — archiving hides a source without losing its config or the
  // leads it already brought in, so there has to be somewhere to see it again.
  const [sourceView, setSourceView] = useState("active");
  const [gs, setGs] = useState({ connected: false });
  const [showEdit, setShowEdit] = useState(null);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [pullingId, setPullingId] = useState(null);
  // "View" shows the connection and its controls. It used to open locked behind a
  // code; that came off with the rest of the lock system.
  const [showManage, setShowManage] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);

  const load = useCallback(() => mkGetSources().then(setSources).catch((e) => console.warn("[load failed]", e?.message || e)), []);
  const loadGs = useCallback(() => gsStatus().then(setGs).catch((e) => console.warn("[gs status]", e?.message || e)), []);
  useEffect(() => { load(); loadGs(); }, [load, loadGs]);

  const visibleSources = useMemo(
    () => sources.filter((s) => (sourceView === "archived" ? s.is_archived : !s.is_archived)),
    [sources, sourceView],
  );

  // OAuth result detection (?sheets_connect=success)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sheets_connect") === "success") {
      toast.success("Google Sheets connected");
      window.history.replaceState({}, "", window.location.pathname);
      loadGs();
    } else if (params.get("sheets_connect") === "failed") {
      toast.error(`Google connect failed: ${params.get("reason") || "unknown"}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [loadGs]);

  const connectGoogle = async () => {
    try {
      const r = await gsAuthUrl();
      window.location.href = r.auth_url;
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to start OAuth"); }
  };


  const closeManage = () => setShowManage(false);

  // Disconnect still confirms. It is the one action on this screen that stops every
  // branch's sheet sync at once and cannot be undone from the app — a misclick guard,
  // not a lock.
  const disconnectFromManage = async () => {
    if (!window.confirm("Disconnect Google Sheets? Every branch's lead sync stops until it is reconnected.")) return;
    setManageBusy(true);
    try {
      await gsDisconnect();
      toast.success("Disconnected");
      closeManage();
      loadGs();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Disconnect failed");
    }
    setManageBusy(false);
  };

  const pullNow = async (s) => {
    setPullingId(s.id);
    try {
      const res = await gsPull(s.id);
      if (res.imported > 0) toast.success(`Pulled ${res.imported} new leads from ${s.name}`);
      else toast(`No new leads. ${res.skipped_duplicate || 0} duplicates, ${res.skipped_no_phone || 0} missing phone.`);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Pull failed"); }
    setPullingId(null);
  };

  // Archived rows only. Removes the row with its sheet link and mapping; leads it
  // already imported stay where they are.
  const [deletingId, setDeletingId] = useState(null);
  const deleteSource = async (s) => {
    if (!window.confirm(`Permanently delete "${s.name}"?\n\nIts Google Sheet link and column mapping are removed and cannot be restored. Leads it already imported are kept.`)) return;
    setDeletingId(s.id);
    try {
      await mkDeleteSource(s.id);
      toast.success("Source deleted");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
    setDeletingId(null);
  };

  return (
    <div className="space-y-4" data-testid="mk-sources-tab">
      {/* One toolbar: Google connection on the left, Active/Archived on the right.
          No Add Source here any more — a row exists for every branch in Branch Manager
          the moment that branch does (see seed.ensure_branch_lead_sources), so there is
          nothing left to add by hand. Paste a sheet URL into an existing branch's row via
          its Edit Source popup, or open a new branch in Operations > Branch > Branch Manager. */}
      <div data-testid="gs-bar" className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <svg viewBox="0 0 48 48" className="h-6 w-6 shrink-0">
            <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
            <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
            <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/>
            <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
          </svg>
          <p className="text-sm font-semibold text-slate-800">Google Sheets</p>
          {gs.connected ? (
            <>
              <span className="text-xs font-medium text-emerald-600">Connected</span>
              <span className="text-slate-300">·</span>
              <Button variant="outline" size="sm" className="h-7 rounded-[4px] px-3 text-xs" onClick={() => setShowManage(true)} data-testid="gs-view-btn">View</Button>
            </>
          ) : (
            <>
              <span className="text-xs text-slate-500">Not connected</span>
              <Button size="sm" onClick={connectGoogle} className="h-7 rounded-[4px] border border-slate-300 bg-white px-3 text-xs text-slate-800 shadow-sm hover:bg-slate-50" data-testid="gs-connect-btn">
                Continue with Google
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddSheet(true)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="mk-source-add-sheet"
          >
            <Plus className="h-4 w-4" />Add Sheet
          </button>
          <button onClick={() => setSourceView("active")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${sourceView === "active" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600"}`} data-testid="mk-source-tab-active">
            Active ({sources.filter((s) => !s.is_archived).length})
          </button>
          <button onClick={() => setSourceView("archived")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${sourceView === "archived" ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-600"}`} data-testid="mk-source-tab-archived">
            Archived ({sources.filter((s) => s.is_archived).length})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[4px] border border-slate-200 bg-white" data-testid="mk-sources-table">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="w-[6%] px-3 py-2">S.No</th>
              <th className="px-3 py-2">Sheet Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2">Sync Status</th>
              <th className="px-3 py-2 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleSources.map((s, i) => {
              const branchNames = (s.branch_ids || []).map((bid) => branches.find((b) => b.id === bid)?.branch_name || "Unknown branch");
              const canPull = s.source_type === "google_sheets" && s.spreadsheet_id && gs.connected;
              // A Google Sheets row with no sheet linked pulls nothing, so it is not Active
              // even though the source itself is switched on.
              const status = !s.is_active ? "deactive" : s.source_type === "google_sheets" && !s.spreadsheet_id ? "no_sheet" : "active";
              return (
                // The whole row opens Edit Source; header row keeps its own height.
                <tr
                  key={s.id}
                  onClick={() => setShowEdit(s)}
                  title="Edit connected sheet"
                  className="h-[65px] cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  data-testid={`mk-source-row-${s.id}`}
                >
                  <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">{s.name}</td>
                  <td className="px-3 py-2 text-slate-600">{sourceTypeLabel(s.source_type)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold ${
                        status === "active" ? "bg-green-100 text-green-700" : status === "no_sheet" ? "bg-orange-100 text-orange-700" : "bg-slate-200 text-slate-600"
                      }`}
                      data-testid={`mk-source-status-${s.id}`}
                    >
                      {status === "active" ? "Active" : status === "no_sheet" ? "No Sheet" : "Deactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600" data-testid={`mk-source-branch-${s.id}`}>
                    {branchNames.length ? branchNames.join(", ") : "All Branches"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatSynced(s.last_synced)}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {/* Fixed-width slot, arrow pinned to its right edge — rows with no
                        Pull Lead (no sheet linked yet) keep their arrow in the same column. */}
                    <div className={`mx-auto flex items-center justify-end gap-2 ${s.is_archived ? "w-[176px]" : "w-[136px]"}`}>
                      {/* Archived rows: Delete Permanently in place of Pull Lead. */}
                      {s.is_archived && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => deleteSource(s)}
                          disabled={deletingId === s.id}
                          className="h-7 border-red-200 px-2.5 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                          data-testid={`mk-source-delete-${s.id}`}
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          {deletingId === s.id ? "Deleting..." : "Delete Permanently"}
                        </Button>
                      )}
                      {!s.is_archived && canPull && (
                        <Button
                          size="sm"
                          onClick={() => pullNow(s)}
                          disabled={pullingId === s.id}
                          className="h-7 bg-emerald-600 px-2.5 text-xs hover:bg-emerald-700"
                          data-testid={`gs-pull-${s.id}`}
                        >
                          <RefreshCw className={`mr-1 h-3 w-3 ${pullingId === s.id ? "animate-spin" : ""}`} />
                          {pullingId === s.id ? "Pulling..." : "Pull Lead"}
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowEdit(s)}
                        title="Edit connected sheet"
                        aria-label={`Edit ${s.name}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                        data-testid={`mk-source-edit-${s.id}`}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleSources.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-400">
                  {sourceView === "archived" ? "No archived sources." : "No branches yet — add one in Operations > Branch > Branch Manager."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAddSheet && (
        <AddSheetDialog branches={branches} sources={sources} onClose={() => setShowAddSheet(false)} onSaved={() => { setShowAddSheet(false); load(); }} />
      )}

      {showEdit && (
        <EditSourceDialog source={showEdit} branches={branches} onClose={() => setShowEdit(null)} onSaved={() => { setShowEdit(null); load(); }} />
      )}

      {showManage && (
        <DialogShell title="Google Sheets Connection" onClose={closeManage} testid="gs-manage-dialog">
              <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
                {gs.connected ? "Currently connected." : "Not connected."}
              </p>
              <Button onClick={connectGoogle} className="w-full bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 shadow-sm" data-testid="gs-manage-connect">
                {gs.connected ? "Reconnect / Switch Account" : "Connect Google"}
              </Button>
              {gs.connected && (
                <Button
                  onClick={disconnectFromManage}
                  disabled={manageBusy}
                  className="w-full bg-red-600 text-white hover:bg-red-700"
                  data-testid="gs-manage-disconnect"
                >
                  {manageBusy ? "Disconnecting..." : "Disconnect"}
                </Button>
              )}
        </DialogShell>
      )}
    </div>
  );
};

// Lead Control (Pre-Sales vs Branch Admin) used to have a switch on this card, but the
// setting lives on the branch, not the source — it's now only changed from Branch Wise /
// Branch Management, where a branch's own state is the thing on screen while you decide.

/**
 * Which worksheet/tab(s) get pulled, upgraded from a typed guess to a pick.
 *
 * Once a spreadsheet ID is known, this loads that sheet's actual tabs (debounced, so it
 * doesn't fire on every keystroke of the URL) and swaps the free-text input for a checklist
 * of real tab names — one or several can be picked, and only those are ever pulled (a
 * spreadsheet with one lead-form tab per branch, say, can be pulled as one source). If the
 * lookup fails (not connected yet, sheet not shared), it falls back to a comma-separated
 * text input rather than blocking entry.
 */
const SheetTabPicker = ({ spreadsheetId, values, onChange, testid }) => {
  const [tabs, setTabs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!spreadsheetId) { setTabs([]); setFailed(false); return; }
    let alive = true;
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      gsListTabs(spreadsheetId)
        .then((r) => { if (alive) { setTabs(r.tabs || []); setLoading(false); } })
        .catch(() => { if (alive) { setTabs([]); setFailed(true); setLoading(false); } });
    }, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [spreadsheetId]);

  const toggle = (tab) => onChange(values.includes(tab) ? values.filter((t) => t !== tab) : [...values, tab]);

  if (tabs.length > 0) {
    // Whatever was already picked stays checkable even if it fell out of the freshly
    // loaded list (a tab renamed since this source was last saved, say).
    const extra = values.filter((v) => !tabs.includes(v));
    return (
      <div>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2" data-testid={testid}>
          {[...tabs, ...extra].map((t) => (
            <label key={t} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
              <input type="checkbox" checked={values.includes(t)} onChange={() => toggle(t)} data-testid={`${testid}-${t}`} />
              {t}
            </label>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-emerald-600">✓ {tabs.length} tab{tabs.length === 1 ? "" : "s"} found — pick one or more; only those are pulled.</p>
      </div>
    );
  }

  return (
    <div>
      <Input
        placeholder="Worksheet/Tab name(s), comma separated (default: Sheet1)"
        value={values.join(", ")}
        onChange={(e) => onChange(e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
        data-testid={testid}
      />
      {loading && <p className="mt-1 text-[10px] text-slate-400">Loading tabs…</p>}
      {failed && <p className="mt-1 text-[10px] text-amber-600">Couldn't load tabs automatically — type tab name(s) comma-separated, or check the sheet is shared.</p>}
    </div>
  );
};

/**
 * Several Google Sheets connected from one popup, listed as rows. Each entry here is the
 * exact shape a source's own sheet fields already were (sheet_url/spreadsheet_id/
 * sheet_names) before this existed — on Save, the first becomes the source being created/
 * edited and any rest become new sibling sources (see submit()/save() in the two dialogs
 * below). Nothing is created here just by adding a row; only Save calls the API.
 */
const SheetEntriesEditor = ({ entries, onChange, testid, fallbackHeaders = [] }) => {
  const [editingId, setEditingId] = useState(entries[0]?.id ?? null);
  // Which row's mapping is open. A row can only be mapped once its sheet resolves —
  // there are no columns to show before that.
  const [mappingFor, setMappingFor] = useState(null);

  const updateEntry = (id, patch) => onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const removeEntry = (id) => onChange(entries.filter((e) => e.id !== id));
  const addEntry = () => {
    const next = emptySheetEntry();
    onChange([...entries, next]);
    setEditingId(next.id);
  };
  const onUrlChange = (id, url) => {
    const current = entries.find((e) => e.id === id);
    updateEntry(id, { sheet_url: url, spreadsheet_id: extractSheetId(url) || current?.spreadsheet_id || "" });
  };

  const mappedCount = (entry) => Object.keys(entry.column_mapping || {}).length;

  // Shared by the collapsed row and the expanded editor so a sheet is mapped the same way
  // whichever state its row happens to be in.
  const MapButton = ({ entry }) => (
    <Button
      type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs"
      disabled={!entry.spreadsheet_id}
      title={entry.spreadsheet_id ? "Map this sheet's columns onto lead fields" : "Paste a sheet URL first"}
      onClick={() => setMappingFor(entry.id)}
      data-testid={`${testid}-map-${entry.id}`}
    >
      <ArrowRightLeft className="mr-1 h-3 w-3" />
      Edit Mapping{mappedCount(entry) > 0 ? ` (${mappedCount(entry)})` : ""}
    </Button>
  );

  return (
    <div className="space-y-2" data-testid={testid}>
      {entries.map((entry) => {
        const isEditing = editingId === entry.id || !entry.spreadsheet_id;
        if (!isEditing) {
          // Collapsed row view — the "row view" the popup lists once a sheet resolves.
          return (
            <div key={entry.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2" data-testid={`${testid}-row-${entry.id}`}>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-700">{entry.sheet_url}</p>
                <p className="text-[10px] text-slate-400">{entry.sheet_names.length} tab{entry.sheet_names.length === 1 ? "" : "s"} selected</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <MapButton entry={entry} />
                <button type="button" onClick={() => setEditingId(entry.id)} className="text-slate-400 hover:text-sky-600" title="Edit this sheet" data-testid={`${testid}-edit-${entry.id}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {entries.length > 1 && (
                  <button type="button" onClick={() => removeEntry(entry.id)} className="text-slate-400 hover:text-rose-600" title="Remove this sheet" data-testid={`${testid}-remove-${entry.id}`}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        }
        // Expanded "normal view" — today's exact single-sheet URL + tab-picker form.
        return (
          <div key={entry.id} className="space-y-2 rounded-md border border-sky-200 bg-sky-50/50 p-2" data-testid={`${testid}-editor-${entry.id}`}>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Paste Google Sheet URL (https://docs.google.com/spreadsheets/d/...)"
                value={entry.sheet_url}
                onChange={(e) => onUrlChange(entry.id, e.target.value)}
                className="flex-1"
                data-testid={`${testid}-url-${entry.id}`}
              />
              {entries.length > 1 && (
                <button type="button" onClick={() => removeEntry(entry.id)} className="shrink-0 text-slate-400 hover:text-rose-600" title="Remove this sheet" data-testid={`${testid}-remove-${entry.id}`}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {entry.spreadsheet_id && (
              <>
                <p className="text-[10px] text-emerald-600">✓ Sheet ID detected: <code className="rounded bg-emerald-50 px-1">{entry.spreadsheet_id.slice(0, 24)}…</code></p>
                <SheetTabPicker
                  spreadsheetId={entry.spreadsheet_id}
                  values={entry.sheet_names}
                  onChange={(v) => updateEntry(entry.id, { sheet_names: v })}
                  testid={`${testid}-tabs-${entry.id}`}
                />
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline" className="text-xs" onClick={() => setEditingId(null)} data-testid={`${testid}-done-${entry.id}`}>
                    Done
                  </Button>
                  <MapButton entry={entry} />
                </div>
              </>
            )}
          </div>
        );
      })}
      <Button type="button" size="sm" variant="outline" onClick={addEntry} className="text-xs" data-testid={`${testid}-add`}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add Sheet
      </Button>

      {mappingFor && (() => {
        const entry = entries.find((e) => e.id === mappingFor);
        if (!entry) return null;
        return (
          <SheetMappingDialog
            title="Edit Mapping"
            spreadsheetId={entry.spreadsheet_id}
            tabs={entry.sheet_names}
            fallbackHeaders={fallbackHeaders}
            value={entry.column_mapping || {}}
            onClose={() => setMappingFor(null)}
            // Kept on the row, not saved to the server here. This row may not be a source
            // yet, and even where it is, the popup's own Save is what the user is
            // expecting to commit — mapping behind its back would be a second, invisible
            // save with different rules.
            onSave={(m) => { updateEntry(entry.id, { column_mapping: m }); setMappingFor(null); toast.success("Mapping set — Save Changes to apply it"); }}
          />
        );
      })()}
    </div>
  );
};

/**
 * Which branches a source is tagged to. Several can be picked on one card — with more
 * than one branch there's no single branch a row obviously belongs to, so beyond exactly
 * one selected branch this is a tag for organizing/filtering only (see the backend's
 * _internal_pull_source for the one-branch-still-auto-assigns rule).
 *
 * No separate Verticals picker: each picked branch already carries its own vertical
 * (Physiotherapy branches are offline, Online Physio/Fitness are online).
 */
// Offline branches first (A-Z), online ones grouped last (A-Z among themselves) — same
// order Branch Wise uses, so a name here sits where the Branch Manager already trained
// the eye to find it. Sorted here rather than by the caller: all four TargetPicker call
// sites (Add/Edit x Google Sheets/other) share one branches prop and would otherwise
// need the same sort repeated at each one.
const sortedForPicker = (branches) => [...branches].sort((a, b) => {
  const onlineDiff = Number(isOnlineVertical(a.vertical)) - Number(isOnlineVertical(b.vertical));
  if (onlineDiff !== 0) return onlineDiff;
  return (a.branch_name || "").localeCompare(b.branch_name || "");
});

const TargetPicker = ({ branches, branchIds, onBranchIdsChange, testid }) => (
  <div>
    {/* Tall enough to hold every branch open today (7) with no scroll — a name sitting
        one scroll below the fold is what read as "missing" here before. Still capped and
        scrollable for whenever the list outgrows that. */}
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-[4px] border border-slate-200 p-2" data-testid={`${testid}-branches`}>
      {sortedForPicker(branches).map((b) => {
        const checked = branchIds.includes(b.id);
        return (
          <label key={b.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onBranchIdsChange(e.target.checked ? [...branchIds, b.id] : branchIds.filter((id) => id !== b.id))}
              data-testid={`${testid}-branch-${b.id}`}
            />
            {b.branch_name}
          </label>
        );
      })}
      {branches.length === 0 && <p className="px-1.5 py-1 text-[11px] text-slate-400">No branches yet</p>}
    </div>
  </div>
);

// One labelled row of the Edit Source popup: label down the left, field on the right —
// the same row the HR Add/Edit Employee popup is built from.
const FieldRow = ({ label, children }) => (
  <div className="flex items-start gap-3 border-b border-slate-100 py-1 last:border-0">
    <label className="w-36 shrink-0 pt-2 text-xs text-slate-500">{label}</label>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

const EditSourceDialog = ({ source, branches = [], onClose, onSaved }) => {
  const initialHeaders = (source.headers_detected || []).join(", ");
  // Not editable here, or anywhere in this dialog — a card is named after the branch it
  // belongs to (see seed.ensure_branch_lead_sources on the backend), and the only place
  // that name ever changes is renaming the branch itself in Branch Manager.
  const name = source.name || "";
  const [sourceType, setSourceType] = useState(source.source_type || "google_sheets");
  // Non-google types only: a plain reference URL, unrelated to sheet parsing.
  const [sheetUrl, setSheetUrl] = useState(source.sheet_url || "");
  // Google Sheets: this source's own sheet is the first row, seeded with today's exact
  // values — saving without touching Sources updates it byte-for-byte as before. Any row
  // added after it becomes a brand-new sibling source on save (see save() below).
  // The first row's column_mapping is also what the Edit Mapping section edits.
  const [sheetEntries, setSheetEntries] = useState([{
    id: source.id,
    sheet_url: source.sheet_url || "",
    spreadsheet_id: source.spreadsheet_id || "",
    sheet_names: source.sheet_names || (source.sheet_name ? [source.sheet_name] : ["Sheet1"]),
    column_mapping: source.column_mapping || {},
  }]);
  // Which section the left-hand list has open: "mapping" | "details" | "sources".
  const [pickedSection, setSection] = useState("details");
  const [headers, setHeaders] = useState(initialHeaders);
  const [branchIds, setBranchIds] = useState(source.branch_ids || (source.branch_id ? [source.branch_id] : []));
  // No longer editable here — carried through unchanged so a save doesn't wipe whatever
  // a source already had tagged from before this picker was removed.
  const sourceVerticals = source.verticals || [];
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(!!source.auto_sync_enabled);
  const [autoSyncInterval, setAutoSyncInterval] = useState(String(source.auto_sync_interval_minutes || 60));
  const [archiving, setArchiving] = useState(false);

  const isSheets = sourceType === "google_sheets";
  // Sources is a Google Sheets section only; switching the type away while it is open
  // lands back on Details.
  const section = !isSheets && pickedSection === "sources" ? "details" : pickedSection;
  const sections = [
    { key: "mapping", label: "Edit Mapping" },
    { key: "details", label: "Details" },
    ...(isSheets ? [{ key: "sources", label: `Sources (${sheetEntries.filter((e) => e.spreadsheet_id).length})` }] : []),
  ];
  const ownEntry = sheetEntries[0];
  const setOwnMapping = (fn) => setSheetEntries((es) => es.map((e, i) => (i === 0 ? { ...e, column_mapping: fn(e.column_mapping || {}) } : e)));

  // Archive, not delete — the source's config and the leads it already brought in stay;
  // it is restored from the same icon on the Archived list.
  const toggleArchive = async () => {
    setArchiving(true);
    try {
      await mkUpdateSource(source.id, { is_archived: !source.is_archived });
      toast.success(source.is_archived ? "Source restored" : "Source archived");
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Archive failed");
      setArchiving(false);
    }
  };

  const save = async () => {
    const validEntries = isSheets ? sheetEntries.filter((e) => e.spreadsheet_id) : [];
    // A branch's row starts with no sheet linked, and its mapping can be set before one
    // is. Saving with no sheet is only refused when it would unlink one this source
    // already had, or when a URL was typed that isn't a sheet URL.
    const typedBadUrl = sheetEntries.some((e) => (e.sheet_url || "").trim() && !e.spreadsheet_id);
    if (isSheets && validEntries.length === 0 && (source.spreadsheet_id || typedBadUrl)) {
      toast.error("Paste a valid Google Sheet URL (must contain /spreadsheets/d/<ID>/)");
      return;
    }
    const payload = {
      source_type: sourceType,
      sheet_url: isSheets ? (validEntries[0]?.sheet_url || "") : sheetUrl,
      branch_ids: branchIds,
      verticals: sourceVerticals,
      auto_sync_enabled: autoSyncEnabled,
      auto_sync_interval_minutes: Number(autoSyncInterval) || 60,
    };
    if (validEntries.length > 0) {
      payload.spreadsheet_id = validEntries[0].spreadsheet_id;
      payload.sheet_names = validEntries[0].sheet_names.length ? validEntries[0].sheet_names : ["Sheet1"];
      payload.column_mapping = validEntries[0].column_mapping || {};
    } else if (JSON.stringify(ownEntry.column_mapping || {}) !== JSON.stringify(source.column_mapping || {})) {
      // No sheet behind it: only sent when Edit Mapping actually changed it.
      payload.column_mapping = ownEntry.column_mapping || {};
    }
    // Only touch headers/mapping if the user actually changed them — avoids
    // silently wiping any manual "Edit Mapping" customization on every save.
    if (headers !== initialHeaders) {
      payload.headers = headers.split(",").map((h) => h.trim()).filter(Boolean);
    }
    try {
      await mkUpdateSource(source.id, payload);
      // Any sheet beyond the first becomes a brand-new sibling source, not folded into
      // this one — gsPull/auto-sync (per-source, one spreadsheet_id each) need no
      // changes. mkCreateSource takes no auto-sync fields, matching how Add always worked.
      const newHeaders = headers.split(",").map((h) => h.trim()).filter(Boolean);
      for (const entry of validEntries.slice(1)) {
        await mkCreateSource({
          name: name.trim(), sheet_url: entry.sheet_url, source_type: sourceType, headers: newHeaders,
          spreadsheet_id: entry.spreadsheet_id,
          sheet_names: entry.sheet_names.length ? entry.sheet_names : ["Sheet1"],
          // Each added sheet keeps the mapping it was given in the popup. Without this a
          // sheet mapped before Save would arrive with nothing but auto-detection.
          column_mapping: entry.column_mapping || {},
          branch_ids: branchIds, verticals: sourceVerticals,
        });
      }
      const createdCount = Math.max(0, validEntries.length - 1);
      toast.success(createdCount > 0 ? `Source updated · ${createdCount} new source${createdCount === 1 ? "" : "s"} created` : "Source updated");
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Update failed"); }
  };

  // Sections down the left, the open one's rows down the right — same layout as the
  // HR Add/Edit Employee popup. Only the right side scrolls.
  return (
    <DialogShell
      title="Edit Source"
      onClose={onClose}
      testid="mk-edit-source-dialog"
      maxWidth="max-w-[740px]"
      boxClassName="relative h-[600px]"
      rounded="rounded-[4px]"
      bodyClassName="flex flex-col sm:flex-row"
      headerActions={(
        <button
          type="button"
          onClick={toggleArchive}
          disabled={archiving}
          title={source.is_archived ? "Restore source" : "Archive source"}
          aria-label={source.is_archived ? "Restore source" : "Archive source"}
          className="text-slate-400 hover:text-amber-600 disabled:opacity-50"
          data-testid="mk-edit-source-archive"
        >
          {source.is_archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </button>
      )}
    >
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/60 p-2 text-xs sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r" data-testid="mk-edit-source-sections">
        {sections.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSection(t.key)}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left ${section === t.key ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`}
            data-testid={`mk-edit-source-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* No footer: Save floats over the popup's bottom-right corner, and the scrolling side
          keeps bottom room so its last row never sits under the button. */}
      <Button
        onClick={save}
        className="absolute bottom-4 right-5 z-10 bg-sky-600 shadow-lg hover:bg-sky-700"
        data-testid="mk-edit-source-save"
      >
        ✓ Save Changes
      </Button>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-16">
        {section === "mapping" && (
          <div className="space-y-3 px-5 py-3">
            <SheetMappingPanel
              spreadsheetId={isSheets ? ownEntry.spreadsheet_id : ""}
              tabs={ownEntry.sheet_names}
              fallbackHeaders={source.headers_detected || []}
              value={ownEntry.column_mapping || {}}
              onChange={setOwnMapping}
            />
          </div>
        )}

        {section === "details" && (
          <div className="px-5 py-1">
            <FieldRow label="Sheet Name">
              <div className="flex h-8 w-full items-center rounded-[4px] border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700" data-testid="mk-edit-source-name">{name}</div>
            </FieldRow>
            <FieldRow label="Type">
              <ThemedSelect
                value={sourceType}
                onChange={setSourceType}
                options={["meta", "seo", "referral", "walk_in", "website", "csv_import", "google_sheets", "other"]}
                className="h-8 w-full rounded-[4px]"
                testid="mk-edit-source-type"
              />
            </FieldRow>
            {!isSheets && (
              <FieldRow label="Source URL">
                <Input className="h-8 rounded-[4px]" placeholder="Optional, for reference" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} data-testid="mk-edit-source-url" />
              </FieldRow>
            )}
            <FieldRow label="Branches">
              <TargetPicker
                branches={branches}
                branchIds={branchIds}
                onBranchIdsChange={setBranchIds}
                testid="mk-edit-source-target"
              />
            </FieldRow>
            <FieldRow label="Headers">
              <Input className="h-8 rounded-[4px]" placeholder="Comma separated — optional" value={headers} onChange={(e) => setHeaders(e.target.value)} data-testid="mk-edit-source-headers" />
            </FieldRow>
            {isSheets && (
              <>
                <FieldRow label="Auto-sync">
                  <div className="flex h-8 items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={autoSyncEnabled} onChange={(e) => setAutoSyncEnabled(e.target.checked)} data-testid="mk-edit-source-autosync" />
                    {autoSyncEnabled ? (
                      <>
                        <span>Every</span>
                        <Input type="number" min="5" className="h-8 w-20 rounded-[4px]" value={autoSyncInterval} onChange={(e) => setAutoSyncInterval(e.target.value)} data-testid="mk-edit-source-interval" />
                        <span>minutes</span>
                      </>
                    ) : (
                      <span>Off</span>
                    )}
                  </div>
                </FieldRow>
              </>
            )}
          </div>
        )}

        {section === "sources" && (
          <div className="px-5 py-3">
            <SheetEntriesEditor
              entries={sheetEntries}
              fallbackHeaders={source.headers_detected || []}
              onChange={(v) => setSheetEntries(v.length ? v : [emptySheetEntry()])}
              testid="mk-edit-source-sheets"
            />
          </div>
        )}
      </div>
    </DialogShell>
  );
};

/**
 * Add Sheet: connect a Google Sheet to a branch. A branch whose own row has no sheet yet
 * gets it on that row; a branch that already has one gets a further row of its own,
 * tagged to that branch alone (seed.ensure_branch_lead_sources keeps those).
 */
const AddSheetDialog = ({ branches = [], sources = [], onClose, onSaved }) => {
  const [branchId, setBranchId] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [tabs, setTabs] = useState(["Sheet1"]);
  const [busy, setBusy] = useState(false);
  const spreadsheetId = extractSheetId(sheetUrl);

  const save = async () => {
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) { toast.error("Pick a branch"); return; }
    if (!spreadsheetId) { toast.error("Paste a valid Google Sheet URL (must contain /spreadsheets/d/<ID>/)"); return; }
    const ownRows = sources.filter((s) => !s.is_archived && (s.branch_ids || []).length === 1 && s.branch_ids[0] === branchId);
    if (ownRows.some((s) => s.spreadsheet_id === spreadsheetId)) {
      toast.error(`This sheet is already connected to ${branch.branch_name}`);
      return;
    }
    const sheet = {
      source_type: "google_sheets",
      sheet_url: sheetUrl.trim(),
      spreadsheet_id: spreadsheetId,
      sheet_names: tabs.length ? tabs : ["Sheet1"],
    };
    const emptyRow = ownRows.find((s) => !s.spreadsheet_id);
    setBusy(true);
    try {
      if (emptyRow) await mkUpdateSource(emptyRow.id, sheet);
      else await mkCreateSource({ ...sheet, name: branch.branch_name, branch_ids: [branchId], verticals: [] });
      toast.success(`Sheet connected to ${branch.branch_name}`);
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not add the sheet");
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Add Sheet" onClose={onClose} testid="mk-add-sheet-dialog" maxWidth="max-w-[560px]" rounded="rounded-[4px]">
      <div>
        <FieldRow label="Branch">
          <ThemedSelect
            value={branchId}
            onChange={setBranchId}
            options={sortedForPicker(branches).map((b) => ({ value: b.id, label: b.branch_name }))}
            placeholder="Select branch"
            className="h-8 w-full rounded-[4px]"
            testid="mk-add-sheet-branch"
          />
        </FieldRow>
        <FieldRow label="Sheet URL">
          <Input
            className="h-8 rounded-[4px]"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            data-testid="mk-add-sheet-url"
          />
        </FieldRow>
        {spreadsheetId && (
          <FieldRow label="Tabs">
            <SheetTabPicker spreadsheetId={spreadsheetId} values={tabs} onChange={setTabs} testid="mk-add-sheet-tabs" />
          </FieldRow>
        )}
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy} className="bg-sky-600 hover:bg-sky-700" data-testid="mk-add-sheet-save">
          {busy ? "Adding..." : "✓ Add Sheet"}
        </Button>
      </div>
    </DialogShell>
  );
};

const SKIP = "__skip__";
const ADD_QUESTION = "__add_question__";

/**
 * Edit Mapping: this sheet's columns down the left, what each one becomes down the right.
 *
 * Column-first, which is the way round somebody reads a sheet — you go through the
 * questions the form asked and say where each answer goes. The old dialog listed nine
 * fields and asked which column filled each, which cannot express "this column is a
 * question nobody has a field for yet" and silently hid every column it had no field for.
 *
 * Stored the other way round, {field: column}, because that is the shape column_mapping
 * has always had and inverting it would orphan every mapping already saved. One field can
 * therefore hold one column: picking a field that is already spoken for moves it.
 *
 * Persistence is the caller's — a saved source PATCHes, a row in the Add/Edit popup keeps
 * it on the row until that popup saves.
 *
 * The panel is controlled: `value` is the mapping, `onChange` takes an updater
 * (prev => next), same shape as a useState setter. SheetMappingDialog wraps it in its own
 * popup with a Save button; Edit Source shows it inline in its Edit Mapping section.
 */
const SheetMappingPanel = ({ spreadsheetId, tabs, fallbackHeaders = [], value, onChange }) => {
  const tabList = (tabs && tabs.length ? tabs : ["Sheet1"]);
  const [pickedTab, setTab] = useState(tabList[0]);
  // The tab list can change under an inline panel (a sheet re-picked in Sources), so a
  // tab that is no longer listed falls back to the first one.
  const tab = tabList.includes(pickedTab) ? pickedTab : tabList[0];
  // Seeded from the last sync so a source with no spreadsheet behind it — a CSV or a Meta
  // source — still has columns to map. The live read below replaces these when there is a
  // sheet to read them from.
  const [headers, setHeaders] = useState(fallbackHeaders);
  const [loading, setLoading] = useState(false);
  const [headerError, setHeaderError] = useState("");
  const [groups, setGroups] = useState([]);
  const mapping = value || {};
  const setMapping = onChange;
  // The column waiting on a new question, and the label being typed for it.
  const [newQuestionFor, setNewQuestionFor] = useState(null);
  const [newQuestionLabel, setNewQuestionLabel] = useState("");
  // Columns typed in by hand: a source with no sheet linked yet has no first row to read,
  // so there would be nothing to map. Same rows as a read column once added.
  const [addedCols, setAddedCols] = useState([]);
  const [newCol, setNewCol] = useState("");

  const loadCatalogue = useCallback(
    () => mkLeadFieldCatalogue().then((d) => setGroups(d.groups || [])).catch((e) => console.warn("[catalogue]", e?.message || e)),
    [],
  );
  useEffect(() => { loadCatalogue(); }, [loadCatalogue]);

  useEffect(() => {
    if (!spreadsheetId || !tab) return undefined;
    let alive = true;
    setLoading(true); setHeaderError("");
    gsSheetHeaders(spreadsheetId, tab)
      .then((d) => { if (alive) { setHeaders(d.headers || []); setLoading(false); } })
      .catch((e) => {
        if (!alive) return;
        // Falling back to whatever the last sync recorded rather than showing an empty
        // dialog: stale columns are still worth mapping, and the banner says they are stale.
        setHeaders(fallbackHeaders);
        setHeaderError(e?.response?.data?.detail || "Couldn't read this tab's columns live.");
        setLoading(false);
      });
    return () => { alive = false; };
    // fallbackHeaders is a fresh array each render from the caller; depending on it would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadsheetId, tab]);

  // {column: field}, the direction this dialog reads in.
  const fieldFor = useMemo(() => {
    const out = {};
    Object.entries(mapping || {}).forEach(([field, column]) => { out[column] = field; });
    return out;
  }, [mapping]);

  const labelFor = useMemo(() => {
    const out = {};
    groups.forEach((g) => (g.fields || []).forEach((f) => { out[f.key] = f.label; }));
    return out;
  }, [groups]);

  const setColumn = (column, fieldKey) => {
    setMapping((prev) => {
      const next = {};
      Object.entries(prev || {}).forEach(([f, c]) => {
        if (c === column) return;   // this column is being reassigned
        if (f === fieldKey) return; // this field is being taken by this column
        next[f] = c;
      });
      if (fieldKey && fieldKey !== SKIP) next[fieldKey] = column;
      return next;
    });
  };

  const onPick = (column, chosen) => {
    if (chosen === ADD_QUESTION) {
      setNewQuestionFor(column);
      setNewQuestionLabel(column);
      return;
    }
    setColumn(column, chosen);
  };

  const createQuestion = async () => {
    const label = newQuestionLabel.trim();
    if (!label) { toast.error("Give the question a name"); return; }
    try {
      const created = await leadFieldsCreate({ label, type: "text" });
      await loadCatalogue();
      setColumn(newQuestionFor, `custom.${created.key}`);
      setNewQuestionFor(null);
      toast.success(`"${label}" added — it appears on the Create Lead form too`);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not add that question"); }
  };

  // A mapping can point at a column this tab does not have — a renamed question, or a
  // mapping made against another tab. Shown rather than dropped, because silently losing
  // it is how a mapping becomes wrong without anyone being told.
  //
  // With no sheet to read, what is already mapped is drawn as its own row instead, so it
  // can still be changed here.
  const columns = [...new Set([...headers, ...(!spreadsheetId ? Object.values(mapping) : []), ...addedCols])];
  const orphaned = Object.entries(mapping || {}).filter(([, c]) => !columns.includes(c));

  const addColumn = () => {
    const c = newCol.trim();
    if (!c) return;
    if (!columns.includes(c)) setAddedCols((prev) => [...prev, c]);
    setNewCol("");
  };

  return (
    <>
      {tabList.length > 1 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="mk-map-tabpicker">
          <span className="mr-1 text-xs text-slate-500">Tab:</span>
          {tabList.map((t) => (
            <button
              key={t} type="button" onClick={() => setTab(t)}
              className={`rounded-md px-2 py-1 text-xs ${t === tab ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              data-testid={`mk-map-tab-${t}`}
            >{t}</button>
          ))}
        </div>
      )}

      {loading && <p className="text-xs text-slate-400">Reading this tab's columns…</p>}
      {headerError && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">{headerError} Showing the columns from the last sync instead.</p>}

      {!loading && columns.length === 0 && (
        <p className="rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-500">
          {spreadsheetId ? "No columns found in this tab's first row." : "No sheet linked yet — add the sheet's column names below to map them."}
        </p>
      )}

      {columns.length > 0 && (
        <>
          <div className="flex gap-3 px-1">
            <p className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sheet column</p>
            <p className="flex-[1.2] text-[10px] font-semibold uppercase tracking-wide text-slate-400">Becomes</p>
          </div>
          <div className="space-y-1.5">
            {columns.map((h) => (
              <div key={h} className="flex items-start gap-3">
                {/* Green once the column is mapped to a field, orange while it is on Skip. */}
                <div
                  className={`flex min-w-0 flex-1 items-center self-stretch rounded-md border px-2 py-1.5 ${fieldFor[h] ? "border-emerald-200 bg-emerald-50" : "border-orange-200 bg-orange-50"}`}
                  title={h}
                  data-testid={`mk-map-colname-${h}`}
                >
                  <span className={`truncate text-xs font-medium ${fieldFor[h] ? "text-emerald-700" : "text-orange-700"}`}>{h}</span>
                </div>
                <div className="flex-[1.2]">
                  <select
                    className={`h-9 w-full rounded-md border px-2 text-sm ${fieldFor[h] ? "border-emerald-300" : "border-orange-300"}`}
                    value={fieldFor[h] || SKIP}
                    onChange={(e) => onPick(h, e.target.value)}
                    data-testid={`mk-map-col-${h}`}
                  >
                    <option value={SKIP}>— Skip —</option>
                    {groups.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {(g.fields || []).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </optgroup>
                    ))}
                    <optgroup label="—">
                      <option value={ADD_QUESTION}>+ Add a custom question…</option>
                    </optgroup>
                  </select>
                  {newQuestionFor === h && (
                    <div className="mt-1 flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 p-1.5" data-testid="mk-map-newquestion">
                      <Input
                        value={newQuestionLabel}
                        onChange={(e) => setNewQuestionLabel(e.target.value)}
                        placeholder="Question name"
                        className="h-7 flex-1 text-xs"
                        data-testid="mk-map-newquestion-label"
                      />
                      <Button size="sm" className="h-7 text-xs" onClick={createQuestion} data-testid="mk-map-newquestion-save">Add</Button>
                      <button type="button" onClick={() => setNewQuestionFor(null)} className="text-slate-400 hover:text-slate-600" data-testid="mk-map-newquestion-cancel"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!loading && (
        <div className="flex items-center gap-2" data-testid="mk-map-addcol">
          <Input
            value={newCol}
            onChange={(e) => setNewCol(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addColumn(); } }}
            placeholder="Sheet column name"
            className="h-8 flex-1 rounded-[4px] text-xs"
            data-testid="mk-map-addcol-name"
          />
          <Button type="button" size="sm" variant="outline" className="h-8 rounded-[4px] text-xs" onClick={addColumn} disabled={!newCol.trim()} data-testid="mk-map-addcol-btn">
            <Plus className="mr-1 h-3.5 w-3.5" />Add Column
          </Button>
        </div>
      )}

      {orphaned.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2" data-testid="mk-map-orphaned">
          <p className="text-[11px] font-medium text-amber-800">Mapped to columns this tab doesn't have</p>
          {orphaned.map(([field, column]) => (
            <div key={field} className="mt-1 flex items-center justify-between gap-2 text-[11px] text-amber-700">
              <span className="truncate">{labelFor[field] || field} ← <code className="rounded bg-amber-100 px-1">{column}</code></span>
              <button
                type="button"
                onClick={() => setMapping((prev) => { const n = { ...prev }; delete n[field]; return n; })}
                className="shrink-0 underline hover:text-amber-900"
                data-testid={`mk-map-drop-${field}`}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

    </>
  );
};

const SheetMappingDialog = ({ title, value, onClose, onSave, ...panel }) => {
  const [mapping, setMapping] = useState(value || {});
  return (
    <DialogShell title={title} onClose={onClose} testid="mk-sheet-map-dialog" maxWidth="max-w-3xl">
      <SheetMappingPanel {...panel} value={mapping} onChange={setMapping} />
      <Button onClick={() => onSave(mapping)} className="w-full" data-testid="mk-map-save">Save Mapping</Button>
    </DialogShell>
  );
};

// ============ Team & Distribution ============

const TeamTab = ({ team, reloadTeam, branches }) => {
  const [settings, setSettings] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", password: "", team_type: "pre_sales", branch_id: "" });
  const [unassigned, setUnassigned] = useState(0);
  const [distributing, setDistributing] = useState(false);

  const loadSettings = useCallback(() => mkGetDistribution().then(setSettings).catch((e) => console.warn("[load failed]", e?.message || e)), []);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const loadUnassigned = useCallback(
    () => mkUnassignedCount().then((r) => setUnassigned(r?.count || 0)).catch(() => setUnassigned(0)),
    [],
  );
  useEffect(() => { loadUnassigned(); }, [loadUnassigned]);

  const patch = async (updates) => {
    const next = await mkPatchDistribution(updates);
    setSettings(next);
  };

  const refresh = async () => {
    const next = await mkRefreshDistribution();
    setSettings(next);
    toast.success("Teams refreshed");
    reloadTeam();
  };

  // Assigning a few thousand leads is not something to do by mis-click, and there is no
  // undo — the previous owner of each lead was nobody, so there is nothing to restore to.
  const distribute = async () => {
    if (!window.confirm(
      `Assign ${unassigned.toLocaleString("en-IN")} unassigned leads across the Pre-Sales team?\n\n`
      + "Leads that already have an agent are left alone. This cannot be undone."
    )) return;
    setDistributing(true);
    try {
      const res = await mkDistributeUnassigned();
      toast.success(`${(res.assigned || 0).toLocaleString("en-IN")} leads assigned`);
      await Promise.all([loadUnassigned(), reloadTeam()]);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not distribute the leads");
    }
    setDistributing(false);
  };

  const submit = async () => {
    if (!form.full_name || !form.email || !form.password) { toast.error("Name, email, password required"); return; }
    const payload = { full_name: form.full_name, email: form.email, password: form.password, team_type: form.team_type };
    if (form.team_type === "branch_admin" && form.branch_id) payload.branch_id = form.branch_id;
    try {
      await mkCreateTeamMember(payload);
      toast.success("Team member created");
      setShowAdd(false);
      setForm({ full_name: "", email: "", password: "", team_type: "pre_sales", branch_id: "" });
      reloadTeam();
    } catch (e) { toast.error(e?.response?.data?.detail || "Create failed"); }
  };

  if (!settings) return <p className="text-sm text-slate-500">Loading...</p>;

  return (
    <div className="space-y-5" data-testid="mk-team-tab">
      <Card data-testid="mk-distribution-card">
        <CardHeader><CardTitle className="text-base">Distribution Settings</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">Auto-Distribute New Leads</p>
              <p className="text-xs text-slate-500">Apply round-robin to leads synced from any source.</p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2" data-testid="mk-dist-enabled">
              <input type="checkbox" checked={!!settings.enabled} onChange={(e) => patch({ enabled: e.target.checked })} className="h-4 w-4" />
              <span className="text-xs font-medium">{settings.enabled ? "ON" : "OFF"}</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-slate-700">Type:</label>
            <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={settings.distribution_type === "round_robin"} onChange={() => patch({ distribution_type: "round_robin" })} data-testid="mk-dist-round-robin" />Round Robin</label>
            <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={settings.distribution_type === "manual"} onChange={() => patch({ distribution_type: "manual" })} data-testid="mk-dist-manual" />Manual Only</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={refresh} data-testid="mk-dist-refresh"><RefreshCw className="mr-1 h-4 w-4" />Refresh Team from Users</Button>
            <Button size="sm" onClick={() => setShowAdd(true)} data-testid="mk-add-team-btn"><Plus className="mr-1 h-4 w-4" />Add Team Member</Button>
          </div>

          {/* Round-robin only ever runs at the moment a lead arrives from a source sync,
              and only if distribution was already on with a team set. Everything that
              predates that has no agent and no way to get one — which is what makes every
              per-agent figure read zero. This is the only thing that can assign them
              after the fact. */}
          {unassigned > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="mk-unassigned-banner">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-800">
                  {unassigned.toLocaleString("en-IN")} leads have no Pre-Sales agent
                </p>
                <p className="text-xs text-amber-700">
                  They arrived before auto-distribute was on, so nothing counts them against anyone. Leads that already have an agent are left alone.
                </p>
              </div>
              <Button size="sm" onClick={distribute} disabled={distributing} className="shrink-0 bg-amber-600 text-white hover:bg-amber-700" data-testid="mk-distribute-unassigned">
                <ArrowRightLeft className="mr-1 h-4 w-4" />
                {distributing ? "Distributing..." : "Distribute Them"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {showAdd && (
        <DialogShell title="Add Team Member" onClose={() => setShowAdd(false)} testid="mk-add-team-dialog">
          <Input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} data-testid="mk-add-team-name" />
          <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="mk-add-team-email" />
          <Input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="mk-add-team-pwd" />
          <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.team_type} onChange={(e) => setForm({ ...form, team_type: e.target.value })} data-testid="mk-add-team-type">
            <option value="pre_sales">Pre-Sales</option>
            <option value="branch_admin">Branch Admin (Sales)</option>
          </select>
          {form.team_type === "branch_admin" && (
            <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} data-testid="mk-add-team-branch">
              <option value="">Select branch</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
            </select>
          )}
          <Button onClick={submit} className="w-full" data-testid="mk-add-team-submit">Create</Button>
        </DialogShell>
      )}
    </div>
  );
};

// The Pre-Sales Team and Sales Team panels are gone from here. The Super Admin Dashboard
// carries them as its own tabs now, and two screens showing the same figures is one
// screen too many — this tab is for configuring distribution, not reading it back.
// TeamCard itself lives in components/marketing/TeamCard.jsx.

// ============ Dialog shell ============

// Header stays outside the scrolling body (own row, shrink-0) rather than scrolling with
// the content — a tall form (Add/Edit Source, with its branch and tab checklists) used to
// push the close button off the top of the screen with no way to scroll back up to it,
// since the old shell had no height cap at all.
// `boxClassName` fixes a size (Edit Source is 740 x 600); the body scrolls inside it, so
// a section that grows never pushes the header or the footer out of the box.
// `headerActions` sit just left of the X; `footer` is pinned below the scrolling body.
const DialogShell = ({ title, onClose, children, testid, maxWidth = "max-w-md", rounded = "rounded-lg", boxClassName = "", bodyClassName = "space-y-3 overflow-y-auto p-5", headerActions = null, footer = null }) => (
  <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" data-testid={testid}>
    <div className={`flex max-h-[85vh] w-full ${maxWidth} flex-col ${rounded} bg-white shadow-xl ${boxClassName}`}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <div className="flex items-center gap-3">
          {headerActions}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="mk-dialog-close"><X className="h-4 w-4" /></button>
        </div>
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>
        {children}
      </div>
      {footer && <div className="shrink-0 border-t border-slate-200 px-5 py-3">{footer}</div>}
    </div>
  </div>
);

// ============ Root ============

export const MarketingBoard = ({ branches = [], leading = null }) => {
  const [tab, setTab] = useState("team");
  const [team, setTeam] = useState({ pre_sales: [], sales: [] });
  const reloadTeam = useCallback(() => mkGetTeam().then(setTeam).catch((e) => console.warn("[load failed]", e?.message || e)), []);
  useEffect(() => { reloadTeam(); }, [reloadTeam]);

  return (
    <div className="space-y-4" data-testid="marketing-board">
      {/* No heading. The nav tab above already reads Marketing Source.
          `leading` is the Settings switcher (Marketing Source / CI/CD ROOTS) handed down by
          the page: it holds the left of this row and the sub-tabs the right, so the two
          levels of tabs read as one bar rather than two stacked strips. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
        {leading}
        <div className="flex flex-wrap gap-2" data-testid="mk-subtabs">
          {SUB_TABS.map((t) => (
            <TabBtn key={t.key} active={tab === t.key} label={t.label} Icon={t.icon} onClick={() => setTab(t.key)} testid={`mk-subtab-${t.key}`} />
          ))}
        </div>
      </div>
      {tab === "lead_sources" && <SourcesTab branches={branches} />}
      {tab === "team" && <TeamTab team={team} reloadTeam={reloadTeam} branches={branches} />}
    </div>
  );
};

export default MarketingBoard;
