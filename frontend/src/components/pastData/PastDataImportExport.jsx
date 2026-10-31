import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Link2Off, Loader2, RefreshCw, Search, Trash2, Undo2, Unlink, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { PastDataDisconnectDialog } from "@/components/pastData/PastDataDisconnectDialog";
import { PastDataImportDialog } from "@/components/pastData/PastDataImportDialog";
import { PastDataMoveDialog } from "@/components/pastData/PastDataMoveDialog";
import { deletePastDataArchived, getPastDataSheets, setPastDataSheetBranch } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { rs } from "@/lib/pastData";

const n = (v) => (v || 0).toLocaleString("en-IN");
const clientsIn = (list) => list.reduce((sum, s) => sum + (s.counts?.past_clients || 0), 0);

// The Zumba tab's summary cards (LedgerCard in branch/ZumbaPanel.jsx), tone for tone, with
// 5px corners here rather than its 2px.
// Whole class names, not `bg-${tone}-50` built at runtime: Tailwind only compiles the
// class names it can read in the source.
const LEDGER_TONES = {
  purple: { border: "border-purple-200", bg: "bg-purple-50/60", text: "text-purple-700", sub: "text-purple-600" },
  sky: { border: "border-sky-200", bg: "bg-sky-50/60", text: "text-sky-700", sub: "text-sky-600" },
  emerald: { border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-700", sub: "text-emerald-600" },
  amber: { border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-700", sub: "text-amber-600" },
  rose: { border: "border-rose-200", bg: "bg-rose-50/60", text: "text-rose-700", sub: "text-rose-600" },
};

const LedgerCard = ({ label, value, sub, tone, color, active, dimmed, onClick, testid }) => {
  const t = LEDGER_TONES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-full w-full rounded-[5px] border ${t.border} ${t.bg} p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_rgba(15,23,42,0.07)] transition duration-200 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_8px_24px_rgba(15,23,42,0.10)] sm:p-4 ${dimmed ? "opacity-70 hover:opacity-100" : ""}`}
      style={active ? { borderColor: color } : undefined}
      data-testid={testid}
    >
      <div className="flex items-start justify-between gap-1">
        <p className={`min-w-0 break-words text-[10px] font-bold uppercase leading-tight tracking-wider sm:text-[11px] ${t.text}`}>{label}</p>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 sm:h-4 sm:w-4" aria-hidden="true" />
      </div>
      <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${t.text}`}>{value}</p>
      {sub && <p className={`mt-0.5 text-[10px] leading-tight sm:text-[11px] ${t.sub}`}>{sub}</p>}
    </button>
  );
};

// Each card counts sheets and filters the list to them; pressed again, the list is every
// sheet still connected. Archived is the disconnected ones, which the list otherwise leaves out.
const CARDS = [
  { key: "active", label: "Active Sheet", color: "#059669", ledger: "emerald", pick: (s) => !s.archived && !!s.live_move },
  { key: "inactive", label: "Inactive Sheet", color: "#d97706", ledger: "amber", pick: (s) => !s.archived && !s.live_move },
  { key: "archived", label: "Archived Sheet", color: "#e11d48", ledger: "rose", pick: (s) => s.archived },
  { key: "connected", label: "Connected Branch Sheet", color: "#0284c7", ledger: "sky", pick: (s) => !s.archived && !!s.branch_id },
  { key: "no_branch", label: "Without Branch Sheet", color: "#9333ea", ledger: "purple", pick: (s) => !s.archived && !s.branch_id },
];

// Chips as the Zumba table draws its Status (5px corners, bold 10px).
const chip = "inline-flex whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold";
const STATUS_CHIP = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  inactive: "border-amber-200 bg-amber-50 text-amber-700",
  archived: "border-rose-200 bg-rose-50 text-rose-700",
};

// The OS's slim filter dropdown, at the row buttons' height.
const triggerClass = "h-7 w-[160px] rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-none hover:bg-slate-50 focus:ring-2 focus:ring-sky-200";
// The row's actions, icon only: what each does is on its title.
const rowButton = "h-7 w-7 p-0";
// The toolbar's Search, Add Sheet and Refresh: plain outlined icons, as the Zumba phone toolbar's.
const toolButton = "h-8 w-8 shrink-0 border-slate-200 bg-white p-0 text-slate-500 hover:bg-slate-50";

/**
 * Settings -> Import/Export: every Past Data sheet on every branch, for Super Admin.
 *
 * The one place Past Data is managed: no branch board has a tab for it. A sheet is added on
 * no branch (Add Sheet) and connected from here to the branch it belongs to -- which is where Move to Live puts its clients -- or disconnected
 * from its branch, which leaves it not movable until it is given one. A live sheet keeps its
 * branch until it is returned back: its clients are on that branch's Branch Leads.
 *
 * Disconnect is the other thing: it deletes the sheet's data, and the sheet stays listed as
 * Archived until Delete takes it off.
 *
 * The list is the Branch Admin's Zumba table (branch/ZumbaPanel.jsx): a toolbar of Search, Add
 * Sheet and Refresh icons over a slate-headed table, one line per sheet.
 *
 * `leading` is Settings' sub-tab switcher, on the row above the summary cards.
 */
export const PastDataImportExport = ({ leading = null }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [card, setCard] = useState("all");
  const [search, setSearch] = useState("");
  // The search box, opened from its icon; its ✕ closes and clears it, so no search is left
  // narrowing the list unseen.
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moving, setMoving] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  // The archived sheet whose Delete was pressed, while its confirmation is open.
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // The sheet whose branch is being changed, while that request is out.
  const [switching, setSwitching] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    getPastDataSheets()
      .then((res) => { if (live) setData(res); })
      .catch((e) => { if (live) setError(e?.response?.data?.detail || "Could not load Past Data"); })
      .finally(() => { if (live) setRefreshing(false); });
    return () => { live = false; };
  }, [reloadKey]);

  const refresh = () => { setRefreshing(true); setReloadKey((k) => k + 1); };

  const setBranch = async (sheet, branchId) => {
    setSwitching(sheet.id);
    try {
      const res = await setPastDataSheetBranch(sheet.id, branchId);
      toast.success(res.branch_id ? `${sheet.label} → ${res.branch_name}` : `${sheet.label}: branch disconnected`);
      refresh();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not change the branch");
    } finally {
      setSwitching("");
    }
  };

  const deleteArchived = async () => {
    setDeleteBusy(true);
    try {
      await deletePastDataArchived(deleting.id);
      toast.success(`${deleting.label} deleted`);
      setDeleting(null);
      refresh();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete");
    } finally {
      setDeleteBusy(false);
    }
  };

  const sheets = data?.sheets || [];
  const branches = data?.branches || [];
  const canManage = !!data?.can_manage;
  const counted = Object.fromEntries(CARDS.map((c) => [c.key, sheets.filter(c.pick)]));
  const q = search.trim().toLowerCase();
  const shown = (card === "all" ? sheets.filter((s) => !s.archived) : counted[card])
    .filter((s) => !q || [s.label, s.source_file, s.branch_name].some((v) => (v || "").toLowerCase().includes(q)));

  return (
    <div className="space-y-5" data-testid="import-export-page">
      {leading && <div className="flex flex-wrap items-center gap-3">{leading}</div>}

      {data && (
        <div className="grid grid-cols-2 items-stretch gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="import-export-summary">
          {CARDS.map((c) => (
            <LedgerCard
              key={c.key}
              label={c.label}
              value={counted[c.key].length}
              sub={`${n(clientsIn(counted[c.key]))} clients`}
              tone={c.ledger}
              color={c.color}
              active={card === c.key}
              dimmed={card !== "all" && card !== c.key}
              onClick={() => setCard((cur) => (cur === c.key ? "all" : c.key))}
              testid={`import-export-card-${c.key}`}
            />
          ))}
        </div>
      )}

      <Card className="overflow-hidden rounded-[4px]" data-testid="import-export-card">
        <CardContent className="p-0">
          <div className="flex items-center justify-end gap-2 border-b border-slate-100 px-4 py-2.5" data-testid="import-export-toolbar">
            {searchOpen ? (
              <div className="relative min-w-0 flex-1 sm:max-w-xs sm:flex-none sm:basis-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search sheet or branch"
                  className="h-8 pl-8 pr-8 text-xs"
                  autoFocus
                  data-testid="import-export-search"
                />
                <button
                  type="button"
                  onClick={() => { setSearch(""); setSearchOpen(false); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100"
                  title="Close search"
                  aria-label="Close search"
                  data-testid="import-export-search-close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => setSearchOpen(true)}
                className={toolButton}
                title="Search"
                aria-label="Search"
                data-testid="import-export-search-open"
              >
                <Search className="h-4 w-4" />
              </Button>
            )}
            {data?.can_add && (
              <Button
                variant="outline"
                onClick={() => setImportOpen(true)}
                className={toolButton}
                title="Add Sheet"
                aria-label="Add Sheet"
                data-testid="import-export-add"
              >
                <Upload className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="outline"
              onClick={refresh}
              disabled={refreshing}
              className={toolButton}
              title="Refresh"
              aria-label="Refresh"
              data-testid="import-export-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {error ? (
            <p className="px-4 py-12 text-center text-sm text-rose-600" data-testid="import-export-error">{error}</p>
          ) : !data ? (
            <div className="flex items-center justify-center px-4 py-12 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : shown.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-400" data-testid="import-export-empty">No sheets.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <tr className="whitespace-nowrap">
                    <th className="w-[4%] px-3 py-2.5">S.No</th>
                    <th className="w-[17%] px-3 py-2.5">Sheet</th>
                    <th className="w-[7%] px-3 py-2.5">Clients</th>
                    <th className="w-[10%] px-3 py-2.5">Total Income</th>
                    <th className="w-[11%] px-3 py-2.5">Total Outstanding</th>
                    <th className="w-[9%] px-3 py-2.5">Date</th>
                    <th className="w-[13%] px-3 py-2.5">Branch</th>
                    <th className="w-[7%] px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((s, i) => {
                    const liveMove = s.live_move;
                    const busy = switching === s.id;
                    const status = s.archived ? "archived" : liveMove ? "active" : "inactive";
                    // A branch archived since the sheet was connected to it is not in the list,
                    // but is still where the sheet is.
                    const options = s.branch_id && !branches.some((b) => b.id === s.branch_id)
                      ? [{ id: s.branch_id, branch_name: s.branch_name || s.branch_id }, ...branches]
                      : branches;
                    return (
                      <tr key={s.id} className="whitespace-nowrap align-middle hover:bg-slate-50/60" data-testid={`import-export-row-${s.id}`}>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                        <td className="px-3 py-3">
                          <p className="max-w-[14rem] truncate text-sm font-semibold leading-5 text-slate-800" title={s.source_file || s.label}>{s.label}</p>
                        </td>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600">{n(s.counts?.past_clients)}</td>
                        <td className="px-3 py-3">
                          <p className="text-xs font-semibold leading-5 text-emerald-700" data-testid={`import-export-income-${s.id}`}>{rs(s.paid_total)}</p>
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-xs font-semibold leading-5 text-amber-700" data-testid={`import-export-outstanding-${s.id}`}>{rs(s.outstanding_total)}</p>
                        </td>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600">{dateStampFull(s.archived ? s.removed_at : s.imported_at) || "—"}</td>
                        <td className="px-3 py-3">
                          {canManage && !s.archived ? (
                            <Select value={s.branch_id || ""} onValueChange={(v) => setBranch(s, v)} disabled={!!liveMove || busy}>
                              <SelectTrigger
                                className={triggerClass}
                                title={liveMove ? "Return Back first" : undefined}
                                aria-label="Branch"
                                data-testid={`import-export-branch-${s.id}`}
                              >
                                <SelectValue placeholder="Select Branch" />
                              </SelectTrigger>
                              <SelectContent className="max-h-72 border-slate-200">
                                {options.map((b) => (
                                  <SelectItem key={b.id} value={b.id} className="text-xs" data-testid={`import-export-branch-option-${b.id}`}>
                                    {b.branch_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : s.branch_name ? (
                            <p className="max-w-[10rem] truncate text-xs leading-5 text-slate-600" title={s.branch_name}>{s.branch_name}</p>
                          ) : (
                            <span className="text-xs leading-5 text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`${chip} ${STATUS_CHIP[status]}`} data-testid={`import-export-status-${s.id}`}>
                            {status === "active"
                              ? (liveMove.status === "moving" ? "Moving…" : `Active · ${n(liveMove.leads)}`)
                              : status === "archived" ? "Archived" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {canManage && (
                            <div className="flex items-center gap-1.5">
                              {s.archived ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className={`${rowButton} border-rose-300 text-rose-700 hover:bg-rose-50`}
                                  onClick={() => setDeleting(s)}
                                  title="Delete"
                                  aria-label="Delete"
                                  data-testid={`import-export-delete-${s.id}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : (
                                <>
                                  {liveMove ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className={`${rowButton} border-slate-300 text-slate-700 hover:bg-slate-50`}
                                      onClick={() => setMoving({ sheet: s, mode: "back" })}
                                      title="Return Back"
                                      aria-label="Return Back"
                                      data-testid={`import-export-return-${s.id}`}
                                    >
                                      <Undo2 className="h-3.5 w-3.5" />
                                    </Button>
                                  ) : s.branch_id ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className={`${rowButton} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
                                      onClick={() => setMoving({ sheet: s, mode: "move" })}
                                      title="Move to Live"
                                      aria-label="Move to Live"
                                      data-testid={`import-export-move-${s.id}`}
                                    >
                                      <ArrowUpRight className="h-3.5 w-3.5" />
                                    </Button>
                                  ) : null}
                                  {s.branch_id && !liveMove && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className={`${rowButton} border-amber-300 text-amber-700 hover:bg-amber-50`}
                                      onClick={() => setBranch(s, "")}
                                      disabled={busy}
                                      title="Disconnect Branch"
                                      aria-label="Disconnect Branch"
                                      data-testid={`import-export-unbranch-${s.id}`}
                                    >
                                      <Link2Off className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className={`${rowButton} border-rose-300 text-rose-700 hover:bg-rose-50`}
                                    onClick={() => setDisconnecting(s)}
                                    title="Disconnect"
                                    aria-label="Disconnect"
                                    data-testid={`import-export-disconnect-${s.id}`}
                                  >
                                    <Unlink className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              )}
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

      {data?.can_add && (
        <PastDataImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); refresh(); }}
        />
      )}
      {canManage && (
        <PastDataMoveDialog
          sheet={moving?.sheet || null}
          mode={moving?.mode}
          onClose={() => setMoving(null)}
          onDone={() => { setMoving(null); refresh(); }}
        />
      )}
      {canManage && (
        <PastDataDisconnectDialog
          sheet={disconnecting}
          onClose={() => setDisconnecting(null)}
          onDisconnected={() => { setDisconnecting(null); refresh(); }}
        />
      )}
      <Dialog open={!!deleting} onOpenChange={(v) => { if (!v && !deleteBusy) setDeleting(null); }}>
        <DialogContent className="max-w-sm" aria-describedby={undefined} data-testid="import-export-delete-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base"><Trash2 className="h-5 w-5 text-rose-600" />Delete {deleting?.label}?</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setDeleting(null)} disabled={deleteBusy} data-testid="import-export-delete-cancel">Cancel</Button>
            <Button
              type="button"
              className="gap-2 bg-rose-600 text-white hover:bg-rose-700"
              onClick={deleteArchived}
              disabled={deleteBusy}
              data-testid="import-export-delete-confirm"
            >
              {deleteBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PastDataImportExport;
