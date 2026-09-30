import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Link2Off, Loader2, RefreshCw, Undo2, Unlink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { PastDataDisconnectDialog } from "@/components/pastData/PastDataDisconnectDialog";
import { PastDataImportDialog } from "@/components/pastData/PastDataImportDialog";
import { PastDataMoveDialog } from "@/components/pastData/PastDataMoveDialog";
import { getPastDataSheets, setPastDataSheetBranch } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { layoutLabel, rs } from "@/lib/pastData";

const n = (v) => (v || 0).toLocaleString("en-IN");
const clientsIn = (list) => list.reduce((sum, s) => sum + (s.counts?.past_clients || 0), 0);

// The Zumba tab's summary cards (LedgerCard in branch/ZumbaPanel.jsx), tone for tone.
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
      className={`h-full w-full rounded-[2px] border ${t.border} ${t.bg} p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_rgba(15,23,42,0.07)] transition duration-200 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_8px_24px_rgba(15,23,42,0.10)] sm:p-4 ${dimmed ? "opacity-70 hover:opacity-100" : ""}`}
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

const selectClass = "h-8 w-full min-w-[150px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Settings -> Import/Export: every Past Data sheet on every branch, for Super Admin.
 *
 * A sheet is added on the Past Data branch (Add Sheet; the server's home_id) and connected
 * from here to the branch it belongs to -- which then shows it on its own Past Data tab, and
 * is where Move to Live puts its clients -- or disconnected from its branch, which leaves it
 * on no branch's tab and not movable until it is given one. A live sheet keeps its branch
 * until it is returned back: its clients are on that branch's Branch Leads.
 *
 * Disconnect is the other thing: it deletes the sheet's data, and the sheet stays listed as
 * Archived. Same dialogs as the Past Data tab (PastDataBoard).
 *
 * `leading` is Settings' sub-tab switcher, on the same row as Add Sheet the way Workflow
 * Roots puts it beside Add Stage.
 */
export const PastDataImportExport = ({ leading = null }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [card, setCard] = useState("all");
  const [importOpen, setImportOpen] = useState(false);
  const [moving, setMoving] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
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

  const sheets = data?.sheets || [];
  const branches = data?.branches || [];
  const canManage = !!data?.can_manage;
  const counted = Object.fromEntries(CARDS.map((c) => [c.key, sheets.filter(c.pick)]));
  const shown = card === "all" ? sheets.filter((s) => !s.archived) : counted[card];

  return (
    <div className="space-y-5" data-testid="import-export-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {leading}
        <div className="flex shrink-0 items-center gap-2">
          {data?.can_add && (
            <Button onClick={() => setImportOpen(true)} className="bg-sky-600 hover:bg-sky-700" data-testid="import-export-add">
              <Upload className="mr-1 h-4 w-4" />Add Sheet
            </Button>
          )}
          <Button
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="import-export-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

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

      <Card data-testid="import-export-card">
        <CardHeader><CardTitle className="text-base">Past Data Sheets</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="import-export-error">{error}</p>
          ) : !data ? (
            <div className="flex items-center justify-center py-8 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">Sheet</th>
                  <th>Type</th>
                  <th>Clients</th>
                  <th>Paid</th>
                  <th>Branch</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const liveMove = s.live_move;
                  const busy = switching === s.id;
                  // A branch archived since the sheet was connected to it is not in the list,
                  // but is still where the sheet is.
                  const options = s.branch_id && !branches.some((b) => b.id === s.branch_id)
                    ? [{ id: s.branch_id, branch_name: s.branch_name || s.branch_id }, ...branches]
                    : branches;
                  return (
                    <tr key={s.id} className="border-t border-slate-100" data-testid={`import-export-row-${s.id}`}>
                      <td className="py-3 pr-3">
                        <p className="font-medium text-slate-800">{s.label}</p>
                        <p className="text-xs text-slate-400">{dateStampFull(s.archived ? s.removed_at : s.imported_at)}</p>
                      </td>
                      <td className="pr-3">
                        <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.layout === "revenue" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>
                          {layoutLabel(s.layout)}
                        </span>
                      </td>
                      <td className="pr-3 tabular-nums">{n(s.counts?.past_clients)}</td>
                      <td className="whitespace-nowrap pr-3 tabular-nums">{rs(s.paid_total)}</td>
                      <td className="pr-3">
                        {canManage && !s.archived ? (
                          <select
                            value={s.branch_id || ""}
                            onChange={(e) => setBranch(s, e.target.value)}
                            disabled={!!liveMove || busy}
                            title={liveMove ? "Return Back first" : undefined}
                            className={selectClass}
                            aria-label="Branch"
                            data-testid={`import-export-branch-${s.id}`}
                          >
                            {!s.branch_id && <option value="" disabled>Select Branch</option>}
                            {options.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                          </select>
                        ) : (
                          <span className="text-xs text-slate-600">{s.branch_name || "—"}</span>
                        )}
                      </td>
                      <td className="pr-3">
                        {s.archived ? (
                          <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">Archived</span>
                        ) : liveMove ? (
                          <span className="whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700" data-testid={`import-export-live-${s.id}`}>
                            {liveMove.status === "moving" ? "Moving…" : `Active · ${n(liveMove.leads)}`}
                          </span>
                        ) : (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Inactive</span>
                        )}
                      </td>
                      <td>
                        {canManage && !s.archived && (
                          <div className="flex flex-wrap gap-2">
                            {liveMove ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-slate-600"
                                onClick={() => setMoving({ sheet: s, mode: "back" })}
                                data-testid={`import-export-return-${s.id}`}
                              >
                                <Undo2 className="h-3.5 w-3.5" />Return Back
                              </Button>
                            ) : s.branch_id ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                onClick={() => setMoving({ sheet: s, mode: "move" })}
                                data-testid={`import-export-move-${s.id}`}
                              >
                                <ArrowUpRight className="h-3.5 w-3.5" />Move to Live
                              </Button>
                            ) : null}
                            {s.branch_id && !liveMove && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                onClick={() => setBranch(s, "")}
                                disabled={busy}
                                data-testid={`import-export-unbranch-${s.id}`}
                              >
                                <Link2Off className="h-3.5 w-3.5" />Disconnect Branch
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                              onClick={() => setDisconnecting(s)}
                              data-testid={`import-export-disconnect-${s.id}`}
                            >
                              <Unlink className="h-3.5 w-3.5" />Disconnect
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan="7" className="py-6 text-center text-slate-400" data-testid="import-export-empty">No sheets.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {data?.can_add && (
        <PastDataImportDialog
          open={importOpen}
          branchId={data.home_id}
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
    </div>
  );
};

export default PastDataImportExport;
