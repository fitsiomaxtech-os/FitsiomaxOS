import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, RefreshCw, Undo2, Unlink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PastDataDisconnectDialog } from "@/components/pastData/PastDataDisconnectDialog";
import { PastDataImportDialog } from "@/components/pastData/PastDataImportDialog";
import { PastDataMoveDialog } from "@/components/pastData/PastDataMoveDialog";
import { getPastDataBranches, getPastDataSummary } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { layoutLabel, rs } from "@/lib/pastData";

const n = (v) => (v || 0).toLocaleString("en-IN");

/**
 * Settings -> Import/Export: Past Data's sheets for Super Admin, without going through the
 * Past Data Entry branch board. The same sheets and the same Move to Live / Return Back /
 * Disconnect as PastDataBoard's Sheets list, and the same dialogs -- only the list, since
 * browsing the clients stays on that branch's Past Data tab.
 *
 * The branch comes from /past-data/branches: importable_ids is the branch holding the sheets
 * once there is one (see past_data_branches), so this names no branch of its own. Before the
 * first import it can be several empty branches, and a picker appears.
 *
 * `leading` is Settings' sub-tab switcher, on the same row as Add Sheet the way Workflow
 * Roots puts it beside Add Stage.
 */
export const PastDataImportExport = ({ branches = [], leading = null }) => {
  const [branchIds, setBranchIds] = useState(null);
  const [branchId, setBranchId] = useState("");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moving, setMoving] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);

  useEffect(() => {
    let live = true;
    getPastDataBranches()
      .then((res) => {
        if (!live) return;
        const ids = res?.importable_ids?.length ? res.importable_ids : res?.branch_ids || [];
        setBranchIds(ids);
        setBranchId((cur) => (ids.includes(cur) ? cur : ids[0] || ""));
      })
      .catch((e) => { if (live) { setBranchIds([]); setError(e?.response?.data?.detail || "Could not load Past Data"); } });
    return () => { live = false; };
  }, [reloadKey]);

  useEffect(() => {
    if (!branchId) { setRefreshing(false); return undefined; }
    let live = true;
    setError("");
    getPastDataSummary(branchId)
      .then((res) => { if (live) setSummary(res); })
      .catch((e) => { if (live) setError(e?.response?.data?.detail || "Could not load Past Data"); })
      .finally(() => { if (live) setRefreshing(false); });
    return () => { live = false; };
  }, [branchId, reloadKey]);

  const refresh = () => { setRefreshing(true); setReloadKey((k) => k + 1); };

  const branchName = (id) => branches.find((b) => b.id === id)?.branch_name || id;
  const sheets = summary?.imports || [];
  const canManage = !!summary?.can_manage;

  return (
    <div className="space-y-5" data-testid="import-export-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {leading}
        <div className="flex shrink-0 items-center gap-2">
          {summary?.can_add && (
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

      <Card data-testid="import-export-card">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Past Data Sheets</CardTitle>
          {branchIds?.length > 1 ? (
            <select
              value={branchId}
              onChange={(e) => { setSummary(null); setBranchId(e.target.value); }}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
              aria-label="Branch"
              data-testid="import-export-branch"
            >
              {branchIds.map((id) => <option key={id} value={id}>{branchName(id)}</option>)}
            </select>
          ) : branchId ? (
            <span className="text-sm text-slate-500" data-testid="import-export-branch-name">{branchName(branchId)}</span>
          ) : null}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="import-export-error">{error}</p>
          ) : branchIds === null || (branchId && !summary) ? (
            <div className="flex items-center justify-center py-8 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">Sheet</th>
                  <th>Type</th>
                  <th>Clients</th>
                  <th>Paid</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => {
                  const liveMove = s.live_move;
                  return (
                    <tr key={s.id} className="border-t border-slate-100" data-testid={`import-export-row-${s.id}`}>
                      <td className="py-3 pr-3">
                        <p className="font-medium text-slate-800">{s.label}</p>
                        <p className="text-xs text-slate-400">{s.imported_at ? dateStampFull(s.imported_at) : ""}</p>
                      </td>
                      <td className="pr-3">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.layout === "revenue" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>
                          {layoutLabel(s.layout)}
                        </span>
                      </td>
                      <td className="pr-3 tabular-nums">{n(s.counts?.past_clients)}</td>
                      <td className="pr-3 tabular-nums">{rs(s.paid_total)}</td>
                      <td className="pr-3">
                        {liveMove ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700" data-testid={`import-export-live-${s.id}`}>
                            {liveMove.status === "moving" ? "Moving…" : `Live · ${n(liveMove.leads)}`}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">Past Data</span>
                        )}
                      </td>
                      <td>
                        {canManage && (
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
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                onClick={() => setMoving({ sheet: s, mode: "move" })}
                                data-testid={`import-export-move-${s.id}`}
                              >
                                <ArrowUpRight className="h-3.5 w-3.5" />Move to Live
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
                {sheets.length === 0 && (
                  <tr><td colSpan="6" className="py-6 text-center text-slate-400" data-testid="import-export-empty">No sheets yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {summary?.can_add && (
        <PastDataImportDialog
          open={importOpen}
          branchId={branchId}
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
