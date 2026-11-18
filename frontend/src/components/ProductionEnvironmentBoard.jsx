import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Rocket, GitCommitHorizontal, CheckCircle2, XCircle, Loader2, RefreshCw,
  CircleAlert, Clock, History, Server,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { StatTile } from "@/components/ui/stat-tile";
import { listDeployments, startDeployment } from "@/lib/api";

const shortSha = (sha) => (sha ? sha.slice(0, 7) : "—");

const when = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return String(iso).slice(0, 16); }
};

const STATUS_META = {
  running: { label: "Running", classes: "border-sky-200 bg-sky-50 text-sky-700", icon: Loader2, spin: true },
  success: { label: "Live", classes: "border-emerald-200 bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  failed: { label: "Failed", classes: "border-rose-200 bg-rose-50 text-rose-700", icon: XCircle },
};

const StatusBadge = ({ status }) => {
  const meta = STATUS_META[status] || { label: status || "—", classes: "border-slate-200 bg-slate-50 text-slate-600", icon: Clock };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${meta.classes}`}>
      <Icon className={`h-3 w-3 ${meta.spin ? "animate-spin" : ""}`} />{meta.label}
    </span>
  );
};

/**
 * Production Environment — the one page that puts a person between main and the server.
 *
 * Pushing to main no longer releases anything. Commits collect here, and what is running
 * only changes when the button below is pressed.
 *
 * The deploy restarts the API that started it, so the request cannot report its own
 * outcome. It returns as soon as the script is away and this polls until the server comes
 * back, at which point the backend decides what happened by whether HEAD moved.
 */
export const ProductionEnvironmentBoard = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      setData(await listDeployments());
    } catch (e) {
      // A deploy takes the API down with it, so a failed poll mid-deploy is expected and
      // says nothing worth interrupting anyone about.
      if (!quiet) toast.error(e?.response?.data?.detail || "Couldn't load the deployment state");
    }
    if (!quiet) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const running = data?.running;

  // While one is out, poll: the server is going down and coming back, and the page should
  // settle by itself rather than asking someone to keep reloading it.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => load({ quiet: true }), 5000);
    return () => clearInterval(id);
  }, [running, load]);

  const pending = useMemo(() => data?.pending || [], [data]);
  const history = useMemo(() => data?.history || [], [data]);

  const lastSuccess = useMemo(() => history.find((h) => h.status === "success"), [history]);

  const onDeploy = async () => {
    const count = pending.length;
    const what = count === 0
      ? "Nothing new is waiting. Redeploy the running commit anyway?"
      : `Release ${count} commit${count === 1 ? "" : "s"} to production?`;
    if (!window.confirm(what)) return;

    setBusy(true);
    try {
      const res = await startDeployment({ note: note.trim() });
      toast.success(res?.message || "Deploy started");
      setNote("");
      await load({ quiet: true });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't start the deploy");
    }
    setBusy(false);
  };

  const live = data?.live || {};

  return (
    <div className="space-y-4" data-testid="production-environment-board">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Running Now" value={shortSha(live.sha)} sub={live.subject || "Nothing detected"}
          icon={Server} color="#059669" testid="prod-tile-live"
        />
        <StatTile
          label="Waiting" value={data?.pending_count ?? "—"} sub={pending.length ? "not released yet" : "nothing waiting"}
          icon={Clock} color={pending.length ? "#d97706" : "#64748b"} testid="prod-tile-pending"
        />
        <StatTile
          label="Deploys" value={history.length} sub="on record" icon={History} color="#7c3aed" testid="prod-tile-count"
        />
        <StatTile
          label="Last Release" value={lastSuccess ? shortSha(lastSuccess.sha_after) : "—"}
          sub={lastSuccess ? `by ${lastSuccess.triggered_by_name || "someone"}` : "none yet"}
          icon={Rocket} color="#0284c7" testid="prod-tile-last"
        />
      </div>

      {data?.notice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800" data-testid="prod-notice">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{data.notice}</span>
        </div>
      )}

      <Card className="overflow-hidden" data-testid="prod-deploy-card">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Waiting to Release {data ? `· ${data.repo} · ${data.branch}` : ""}
            </p>
            <button
              type="button"
              onClick={() => load()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
              data-testid="prod-refresh"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>

          {loading && !data ? (
            <p className="px-4 py-14 text-center text-sm text-slate-400">Checking what is live...</p>
          ) : (
            <>
              {pending.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400" data-testid="prod-pending-empty">
                  Everything on {data?.branch || "main"} is live. Nothing is waiting.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100" data-testid="prod-pending-list">
                  {pending.map((c) => (
                    <li key={c.sha} className="flex items-start gap-3 px-4 py-3" data-testid={`prod-pending-${c.sha.slice(0, 7)}`}>
                      <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-800">{c.subject}</p>
                        <p className="text-[11px] text-slate-400">
                          <span className="font-mono">{shortSha(c.sha)}</span>
                          {c.author ? ` · ${c.author}` : ""} · {when(c.date)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note for the record — what is going out, or what to watch (optional)"
                  className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  data-testid="prod-deploy-note"
                />
                {data && !data.can_deploy && (
                  <p className="text-[11px] font-semibold text-rose-600" data-testid="prod-no-command">
                    {data.deploy_blocked_reason || "This server cannot run a deploy, so the button is disabled."}
                  </p>
                )}
                <Button
                  onClick={onDeploy}
                  disabled={busy || !!running || !data?.can_deploy}
                  className="h-11 w-full bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  data-testid="prod-deploy-button"
                >
                  {running ? (
                    <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Deploying — the server will restart</>
                  ) : (
                    <><Rocket className="mr-2 h-5 w-5" /> Deploy to Production</>
                  )}
                </Button>
                {running && (
                  <p className="text-center text-[11px] text-slate-500" data-testid="prod-running-hint">
                    Started {when(running.started_at)} by {running.triggered_by_name || "someone"}. This page keeps checking
                    and will show the result once the server is back — a minute or two is normal.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden" data-testid="prod-history-card">
        <CardContent className="p-0">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <History className="h-3.5 w-3.5" /> Deployment History
            </p>
          </div>
          {history.length === 0 ? (
            <p className="px-4 py-14 text-center text-sm text-slate-400">Nothing has been deployed from here yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="w-12 px-4 py-2.5 font-semibold">S.No</th>
                    <th className="px-4 py-2.5 font-semibold">Started</th>
                    <th className="px-4 py-2.5 font-semibold">Released By</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">From → To</th>
                    <th className="px-4 py-2.5 font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((h, i) => (
                    <tr key={h.id} className="hover:bg-slate-50" data-testid={`prod-history-${h.id}`}>
                      <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-500">{when(h.started_at)}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{h.triggered_by_name || "—"}</td>
                      <td className="px-4 py-3"><StatusBadge status={h.status} /></td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-600">
                        {shortSha(h.sha_before)} → {h.sha_after ? shortSha(h.sha_after) : "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {h.error
                          ? <span className="text-rose-600">{h.error}</span>
                          : (h.note || <span className="text-slate-300">—</span>)}
                      </td>
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

export default ProductionEnvironmentBoard;
