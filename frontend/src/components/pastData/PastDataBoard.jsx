import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Archive, ArrowUpRight, ChevronLeft, ChevronRight, ClipboardList, FileSpreadsheet, IndianRupee,
  Loader2, RefreshCw, Search, Undo2, Unlink, Upload, Users, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import { MaskedContact } from "@/components/MaskedContact";
import { PastClientDialog } from "@/components/pastData/PastClientDialog";
import { PastDataDisconnectDialog } from "@/components/pastData/PastDataDisconnectDialog";
import { PastDataImportDialog } from "@/components/pastData/PastDataImportDialog";
import { PastDataMoveDialog } from "@/components/pastData/PastDataMoveDialog";
import { getPastDataClients, getPastDataSummary } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { layoutLabel, rs, rsShort, statusTone } from "@/lib/pastData";

const PAGE_SIZE = 50;
// Radix Select will not take "" as an item's value, so "every one" is spelled out.
const ALL = "all";

const SORTS = [
  { key: "recent", label: "Recent first" },
  { key: "name", label: "Name A–Z" },
  { key: "owing", label: "Most owed" },
  { key: "paid", label: "Most paid" },
  { key: "id", label: "Patient ID" },
];

const triggerClass = "h-10 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-none hover:bg-slate-50 focus:ring-2 focus:ring-sky-200 sm:w-[180px]";

const day = (value) => (value ? dateStampFull(value) : "");
const n = (v) => (v || 0).toLocaleString("en-IN");

// One sheet in the Sheets list: what it is, what is in it, whether its clients are live on
// Branch Leads, and its own Move to live (or Take back) and Disconnect.
const SheetRow = ({ sheet, canManage, onDisconnect, onMove }) => {
  const counts = sheet.counts || {};
  const revenue = sheet.layout === "revenue";
  const tabs = sheet.tabs || [];
  const live = sheet.live_move;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" data-testid={`past-sheet-${sheet.id}`}>
      <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-slate-900">{sheet.label}</p>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${revenue ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>
            {layoutLabel(sheet.layout)}
          </span>
          {live && (
            <span
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
              title={`Moved ${day(live.moved_at)}${live.moved_by ? ` by ${live.moved_by}` : ""}`}
              data-testid={`past-sheet-live-${sheet.id}`}
            >
              {live.status === "moving" ? "Moving to live…" : `Live on Branch Leads · ${n(live.leads)}`}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {n(counts.past_clients)} clients · {revenue ? `${n(counts.past_payments)} payments` : `${n(counts.past_treatments)} treatments`}
          {" · "}{rs(sheet.paid_total)}
          {revenue && tabs.length > 0 && ` · ${tabs.length === 1 ? tabs[0] : `${tabs[0]} to ${tabs[tabs.length - 1]}`}`}
        </p>
        <p className="truncate text-[11px] text-slate-400">
          {sheet.source_file} · added {day(sheet.imported_at)}{sheet.imported_by ? ` by ${sheet.imported_by}` : ""}
        </p>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {live ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-slate-600"
              onClick={() => onMove(sheet, "back")}
              data-testid={`past-sheet-take-back-${sheet.id}`}
            >
              <Undo2 className="h-3.5 w-3.5" />Take back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              onClick={() => onMove(sheet, "move")}
              data-testid={`past-sheet-move-${sheet.id}`}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />Move to live
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            onClick={() => onDisconnect(sheet)}
            data-testid={`past-sheet-disconnect-${sheet.id}`}
          >
            <Unlink className="h-3.5 w-3.5" />Disconnect
          </Button>
        </div>
      )}
    </li>
  );
};

/**
 * Past Data: the clinic's Excel sheets from before the OS, as they were kept — the register
 * with its courses and installments, and the branches' monthly revenue sheets — every past
 * client and what they paid, read-only.
 *
 * Its own screen rather than rows on the lead boards, because it is its own data: the
 * import writes past_clients/past_treatments/past_payments and never touches leads, so no
 * live board, dashboard or finance figure counts a row of it. A past patient who comes back
 * arrives as a new enquiry like anybody else; this is where their history is looked up.
 *
 * Mounted as a tab of the branch board, on the one branch the sheets were imported into
 * (see BranchAdminBoard), and held to that branch: `branchId` goes on every request. Each
 * uploaded file is a sheet of its own, listed with its own Disconnect; Super Admin and that
 * branch's own admin add and disconnect them (can_add / can_manage from the server).
 *
 * The tiles double as the list's filter (Still owed, Needs a look), the way the money
 * boards use theirs; Clients clears it.
 */
export const PastDataBoard = ({ branchId, onLeadsChanged }) => {
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [service, setService] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [sheet, setSheet] = useState(ALL);
  const [show, setShow] = useState("");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [list, setList] = useState({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [openId, setOpenId] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  // The sheet whose Disconnect was pressed, while its confirmation is open.
  const [disconnecting, setDisconnecting] = useState(null);
  // The sheet whose Move to live or Take back was pressed, and which of the two.
  const [moving, setMoving] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Only the newest request may draw the list: typing fast fires several, and they are
  // not guaranteed to come back in the order they were sent.
  const requestSeq = useRef(0);

  useEffect(() => {
    setSummaryError("");
    getPastDataSummary(branchId)
      .then(setSummary)
      .catch((e) => setSummaryError(e?.response?.data?.detail || "Could not load Past Data"))
      .finally(() => setRefreshing(false));
  }, [branchId, reloadKey]);

  const refresh = () => { setRefreshing(true); setReloadKey((k) => k + 1); };

  // The box searches as you type, but a request per keystroke is a request per letter of
  // every name. Waits for a pause instead.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    if (!summary?.imported) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setListError("");
    getPastDataClients({
      branch_id: branchId || undefined,
      q: q || undefined,
      service: service === ALL ? undefined : service,
      status: status === ALL ? undefined : status,
      sheet: sheet === ALL ? undefined : sheet,
      show: show || undefined,
      sort,
      page,
      page_size: PAGE_SIZE,
    })
      .then((data) => { if (seq === requestSeq.current) setList(data); })
      .catch((e) => { if (seq === requestSeq.current) setListError(e?.response?.data?.detail || "Could not load the list"); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
    // Refresh reloads the summary, and a new summary is what redraws the list -- so the
    // list needs no reload counter of its own, which would fetch it twice.
  }, [branchId, summary, q, service, status, sheet, show, sort, page]);

  const pick = (setter) => (value) => { setter(value); setPage(1); };
  const toggleShow = (key) => { setShow((cur) => (cur === key ? "" : key)); setPage(1); };

  if (summaryError) {
    return <p className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" data-testid="past-data-error">{summaryError}</p>;
  }
  if (!summary) {
    return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading Past Data…</div>;
  }

  const sheets = summary.imports || [];
  const sheetLabel = Object.fromEntries(sheets.map((s) => [s.id, s.label]));
  const hasRevenue = sheets.some((s) => s.layout === "revenue");
  const hasRegister = sheets.some((s) => s.layout !== "revenue");
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, list.total);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const reload = () => { setPage(1); setReloadKey((k) => k + 1); };

  return (
    <div className="space-y-4" data-testid="past-data-board">
      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="rounded-lg bg-slate-100 p-2"><Archive className="h-5 w-5 text-slate-600" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-900">Past Data</h2>
          <p className="text-xs text-slate-500">
            The clinic's Excel sheets from before the OS, read-only. Nothing here counts in live leads, revenue or dashboards.
            A sheet moved to live is tried out on this branch's Branch Leads only.
          </p>
          {summary.imported && (
            <p className="mt-1 inline-flex flex-wrap items-center gap-1 text-xs text-slate-500" data-testid="past-data-source">
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
              {sheets.length} sheet{sheets.length === 1 ? "" : "s"}
              {sheets[0]?.branch_name ? ` in ${sheets[0].branch_name}` : ""}
              {summary.first_date && ` · registrations ${day(summary.first_date)} to ${day(summary.last_date)}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Super Admin, or this branch's own admin once it holds past data -- can_add on
              /past-data/summary. Each file added is a sheet of its own below. */}
          {summary.can_add && summary.imported && (
            <Button variant="outline" className="h-10 gap-2" onClick={() => setImportOpen(true)} data-testid="past-data-add-sheet">
              <Upload className="h-4 w-4" />Add sheet
            </Button>
          )}
          <Button
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
            className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
            data-testid="past-data-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing || loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {sheets.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid="past-data-sheets">
          <h3 className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Sheets ({sheets.length})
          </h3>
          <ul className="divide-y divide-slate-100">
            {sheets.map((s) => (
              <SheetRow
                key={s.id}
                sheet={s}
                canManage={summary.can_manage}
                onDisconnect={setDisconnecting}
                onMove={(sheetRow, mode) => setMoving({ sheet: sheetRow, mode })}
              />
            ))}
          </ul>
        </section>
      )}

      {!summary.imported ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center" data-testid="past-data-empty">
          <Archive className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm font-semibold text-slate-600">No sheets added yet</p>
          {summary.can_add ? (
            <>
              <p className="mt-1 text-xs text-slate-500">Add the clinic register or a branch's revenue sheet. It is checked first, and nothing is written until you confirm.</p>
              <Button className="mt-4 gap-2 bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setImportOpen(true)} data-testid="past-data-import">
                <Upload className="h-4 w-4" />Add a sheet
              </Button>
            </>
          ) : (
            <p className="mt-1 text-xs text-slate-500">Super Admin or this branch's admin adds sheets from this tab.</p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile
              label="Clients" value={summary.clients.toLocaleString("en-IN")}
              sub={sheets.length > 1 ? `Across ${sheets.length} sheets` : hasRevenue ? "Everyone in the revenue sheet" : "Everyone in the Patient Master"}
              icon={Users} color="#0284c7" active={!show} onClick={() => { setShow(""); setPage(1); }} testid="past-tile-clients"
            />
            <StatTile
              label="Treatments" value={summary.treatments.toLocaleString("en-IN")}
              sub={hasRevenue && hasRegister ? "Courses, and paid visits" : hasRevenue ? "One per payment row" : "Courses in the register"}
              icon={ClipboardList} color="#6366f1" testid="past-tile-treatments"
            />
            <StatTile
              label="Collected" value={rsShort(summary.paid_total)} sub="Paid in Excel, not OS revenue"
              icon={IndianRupee} color="#059669" testid="past-tile-collected"
            />
            <StatTile
              label="Still owed" value={rsShort(summary.outstanding_total)} sub={`${summary.owing_clients} clients, when saved`}
              icon={Wallet} color="#d97706" active={show === "owing"} onClick={() => toggleShow("owing")} testid="past-tile-owing"
            />
            <StatTile
              label="Needs a look" value={summary.needs_look_clients.toLocaleString("en-IN")} sub="Clients flagged on import"
              icon={AlertTriangle} color="#e11d48" active={show === "needs_look"} onClick={() => toggleShow("needs_look")} testid="past-tile-needs-look"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Name, phone or PAT-ID"
                className="h-10 pl-9"
                data-testid="past-data-search"
              />
            </div>
            {sheets.length > 1 && (
              <Select value={sheet} onValueChange={pick(setSheet)}>
                <SelectTrigger className={triggerClass} aria-label="Sheet" data-testid="past-data-sheet"><SelectValue /></SelectTrigger>
                <SelectContent className="border-slate-200">
                  <SelectItem value={ALL} className="text-xs">All sheets</SelectItem>
                  {sheets.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-xs">{s.label} ({n(s.counts?.past_clients)})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={service} onValueChange={pick(setService)}>
              <SelectTrigger className={triggerClass} aria-label="Service" data-testid="past-data-service"><SelectValue /></SelectTrigger>
              <SelectContent className="border-slate-200">
                <SelectItem value={ALL} className="text-xs">All services</SelectItem>
                {summary.services.map((s) => (
                  <SelectItem key={s.name} value={s.name} className="text-xs">{s.name} ({s.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={pick(setStatus)}>
              <SelectTrigger className={triggerClass} aria-label="Latest status" data-testid="past-data-status"><SelectValue /></SelectTrigger>
              <SelectContent className="border-slate-200">
                <SelectItem value={ALL} className="text-xs">All statuses</SelectItem>
                {summary.statuses.map((s) => (
                  <SelectItem key={s.name} value={s.name} className="text-xs">{s.name} ({s.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={pick(setSort)}>
              <SelectTrigger className={triggerClass} aria-label="Sort" data-testid="past-data-sort"><SelectValue /></SelectTrigger>
              <SelectContent className="border-slate-200">
                {SORTS.map((s) => <SelectItem key={s.key} value={s.key} className="text-xs">{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          </div>

          {listError && <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{listError}</p>}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm" data-testid="past-data-table">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Patient</th>
                    <th className="px-3 py-2.5 font-semibold">Phone</th>
                    <th className="px-3 py-2.5 font-semibold">Registered</th>
                    <th className="px-3 py-2.5 font-semibold">Treatments</th>
                    <th className="px-3 py-2.5 font-semibold">Latest status</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Paid</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Owed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.rows.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setOpenId(c.id)}
                      className="cursor-pointer hover:bg-sky-50/50"
                      data-testid={`past-row-${c.excel_id}`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-slate-900">{c.name}</p>
                          {c.issue_count > 0 && (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label={`${c.issue_count} flagged`} />
                          )}
                        </div>
                        <p className="font-mono text-[11px] text-slate-400">
                          {c.excel_id}{c.gender ? ` · ${c.gender}` : ""}{c.age ? ` · ${c.age}` : ""}
                        </p>
                        {sheets.length > 1 && sheetLabel[c.batch_id] && (
                          <span className="mt-0.5 inline-flex rounded bg-slate-100 px-1.5 text-[10px] font-medium text-slate-500" data-testid="past-row-sheet">
                            {sheetLabel[c.batch_id]}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <MaskedContact phone={c.phone || ""} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-600">{day(c.registration_date)}</td>
                      <td className="px-3 py-2.5">
                        <p className="text-xs text-slate-700">{c.treatments_count || 0}{c.last_treatment_date ? ` · last ${day(c.last_treatment_date)}` : ""}</p>
                        <p className="max-w-[220px] truncate text-[11px] text-slate-400">{(c.services || []).join(", ")}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {c.latest_status ? (
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(c.latest_status)}`}>{c.latest_status}</span>
                        ) : <span className="text-xs text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-medium text-emerald-700">{rs(c.paid_total)}</td>
                      <td className={`whitespace-nowrap px-3 py-2.5 text-right text-xs ${c.outstanding_total > 0 ? "font-semibold text-amber-700" : "text-slate-400"}`}>
                        {rs(c.outstanding_total)}
                      </td>
                    </tr>
                  ))}
                  {!loading && list.rows.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-500" data-testid="past-data-no-rows">No clients match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              <span data-testid="past-data-range">{list.total ? `Showing ${from}–${to} of ${list.total.toLocaleString("en-IN")}` : "0 clients"}</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page" data-testid="past-data-prev">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-2">Page {page} of {pages}</span>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Next page" data-testid="past-data-next">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      <PastClientDialog clientId={openId} onClose={() => setOpenId("")} onOpenClient={setOpenId} />
      {summary.can_add && (
        <PastDataImportDialog
          open={importOpen}
          branchId={branchId}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); reload(); }}
        />
      )}
      {summary.can_manage && (
        <PastDataMoveDialog
          sheet={moving?.sheet || null}
          mode={moving?.mode}
          onClose={() => setMoving(null)}
          onDone={() => { setMoving(null); refresh(); onLeadsChanged?.(); }}
        />
      )}
      {summary.can_manage && (
        <PastDataDisconnectDialog
          sheet={disconnecting}
          onClose={() => setDisconnecting(null)}
          onDisconnected={() => {
            // The list may have been showing only that sheet; it is gone now.
            if (sheet === disconnecting?.id) setSheet(ALL);
            if (disconnecting?.live_move) onLeadsChanged?.();
            setDisconnecting(null); setOpenId(""); reload();
          }}
        />
      )}
    </div>
  );
};

export default PastDataBoard;
