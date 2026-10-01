import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronRight, Download, RefreshCw, Search, Truck, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters } from "@/components/QuickDateFilterBar";
import { VendorPanel } from "@/components/branch/VendorPanel";
import { getBranchTransferRecords } from "@/lib/api";
import { downloadCsv } from "@/lib/printable";
import { dateStampFull, callTimeStamp } from "@/lib/time";

/**
 * The branch's Records tab. Branch Transfer Records is the first record kept here; the
 * sub-tab strip is there so the next one lands beside it rather than on a new top tab.
 */
const RECORD_TABS = [
  { key: "branch_transfers", label: "Branch Transfer Records", icon: ArrowLeftRight },
  { key: "vendors", label: "Vendor Records", icon: Truck },
];

const money = (n) => `Rs.${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const currentStage = (lead) => lead.consultation_stage || lead.branch_stage || lead.stage || "—";

export const RecordsPanel = ({ branchId }) => {
  const [sub, setSub] = useState("branch_transfers");

  return (
    <div className="flex flex-col gap-4" data-testid="branch-records-panel">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200">
        {RECORD_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSub(t.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium sm:text-sm ${
                sub === t.key ? "border-sky-500 text-sky-700" : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
              data-testid={`records-sub-tab-${t.key}`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>
      {sub === "branch_transfers" && <BranchTransferRecords branchId={branchId} />}
      {/* The branch's one vendor screen. It moved here from Services and Products, so it
          edits: add, change and switch off vendors, and from View, see and add the
          expenses paid to each one. The book itself is still org-wide. */}
      {sub === "vendors" && <VendorPanel branchId={branchId} />}
    </div>
  );
};

const BranchTransferRecords = ({ branchId }) => {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  // Phone only: the field is behind an icon so the toolbar fits one row. Desktop ignores
  // this entirely -- the field is always on screen there, at any value of searchOpen.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const [direction, setDirection] = useState("all");
  const [open, setOpen] = useState(null);
  // The same pair Branch Leads carries: a preset row and a calendar, combined by overlap.
  // Opens on All — a record is looked up, and the transfer being looked for is rarely today's.
  const [quickDate, setQuickDate] = useState(null);
  const [dateFilter, setDateFilter] = useState(null);
  const applyDateFilter = (next) => {
    setDateFilter(next);
    if (next) setQuickDate(null);
  };
  const effectiveDateFilter = useMemo(() => intersectDateFilters(dateFilter, quickDate), [dateFilter, quickDate]);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const data = await getBranchTransferRecords(branchId);
      setRecords(data.records || []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to load transfer records");
    }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  // Date and search first, direction last, so the three cards count what the date and
  // search leave and pressing one of them never changes the numbers on the other two.
  const dated = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = effectiveDateFilter?.from?.getTime();
    const to = effectiveDateFilter?.to?.getTime();
    return records.filter((r) => {
      const ts = new Date(r.at || 0).getTime();
      if (from && ts < from) return false;
      if (to && ts > to) return false;
      if (!q) return true;
      return [r.lead.name, r.lead.phone, r.lead.patient_number, r.from_branch_name, r.to_branch_name, r.transferred_by]
        .some((v) => (v || "").toLowerCase().includes(q));
    });
  }, [records, search, effectiveDateFilter]);

  const rows = useMemo(
    () => (direction === "all" ? dated : dated.filter((r) => r.direction === direction)),
    [dated, direction],
  );

  const counts = useMemo(() => ({
    all: dated.length,
    outgoing: dated.filter((r) => r.direction === "outgoing").length,
    incoming: dated.filter((r) => r.direction === "incoming").length,
  }), [dated]);

  // CSV with a BOM, which Excel opens straight into columns. Exports what the filters
  // leave, so a search narrows the sheet the same way it narrows the list.
  const exportSheet = () => {
    downloadCsv([
      ["Patient Number", "Patient Name", "Phone", "Email", "Direction", "From Branch", "To Branch",
        "Transfer Date", "Transfer Time", "Stage at Transfer", "Current Stage", "Current Branch",
        "Sessions Released", "Collected Before Transfer", "Reason", "Transferred By", "Role"],
      ...rows.map((r) => [
        r.lead.patient_number, r.lead.name, r.lead.phone, r.lead.email,
        r.direction === "outgoing" ? "Outgoing" : "Incoming",
        r.from_branch_name, r.to_branch_name,
        dateStampFull(r.at), callTimeStamp(r.at),
        r.consultation_stage || "", currentStage(r.lead), r.lead.current_branch_name,
        r.sessions_released || 0, r.collected_before_transfer || 0,
        r.reason || "", r.transferred_by || "", r.transferred_by_role || "",
      ]),
    ], `branch-transfer-records-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  // Opening it puts the cursor in the field -- it took a tap to get there, and a second
  // tap to type in it is the kind of thing that makes a phone toolbar feel broken.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const toggleSearch = () => {
    if (searchOpen) setSearch("");
    setSearchOpen((v) => !v);
  };

  if (!branchId) {
    return <p className="py-10 text-center text-sm text-slate-400">Transfer records are kept per branch.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[
          { key: "all", label: "All Transfers" },
          { key: "outgoing", label: "Transferred Out" },
          { key: "incoming", label: "Transferred In" },
        ].map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setDirection(c.key)}
            className={`relative rounded-[5px] border bg-white px-3 py-2.5 text-left transition-colors ${
              direction === c.key ? "border-sky-400 ring-1 ring-sky-300" : "border-slate-200 hover:border-slate-300"
            }`}
            data-testid={`transfer-records-card-${c.key}`}
          >
            <p className="pr-6 text-[11px] font-medium text-slate-500">{c.label}</p>
            <p className="text-xl font-bold text-slate-800">{counts[c.key]}</p>
            {/* The ledger card's corner arrow (see ui/ledger-card), so the Records strip
                reads the same as the branch's other summary strips. */}
            <ChevronRight aria-hidden className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          </button>
        ))}
      </div>

      {/* One line on a phone, three before this: the field had a line, the dates had a
          line, and the two buttons had a third. Nothing here is new -- the same search,
          both date controls, refresh and download -- but a 360px line cannot hold them at
          desk sizing, so below sm the field hides behind its own icon, the dates go micro,
          and refresh and download shrink to 36px glyphs. sm and up is byte-for-byte the
          toolbar that was here: wrapping row, full field, worded Download Excel. */}
      <div className="flex flex-nowrap items-center gap-1 sm:flex-wrap sm:gap-2">
        {/* Phone only. Opening it swaps the presets out for the field rather than adding
            the second line this whole change exists to remove; closing clears the term,
            so a filter can never be left applied with nothing on screen saying so. */}
        <Button
          type="button"
          variant="outline"
          onClick={toggleSearch}
          className={`h-9 w-9 shrink-0 p-0 sm:hidden ${searchOpen ? "border-sky-500 bg-sky-50 text-sky-700" : ""}`}
          title={searchOpen ? "Close search" : "Search"}
          aria-label={searchOpen ? "Close search" : "Search"}
          aria-expanded={searchOpen}
          data-testid="transfer-records-search-toggle"
        >
          {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </Button>
        <div className={`relative min-w-0 flex-1 sm:block sm:min-w-[200px] sm:max-w-xs ${searchOpen ? "" : "hidden"}`}>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, phone, branch..."
            className="pl-9"
            data-testid="transfer-records-search"
          />
        </div>
        <div className={`min-w-0 flex-1 sm:flex-none sm:block ${searchOpen ? "hidden" : ""}`}>
          <QuickDateFilterBar value={quickDate} onChange={setQuickDate} testid="transfer-records-quick-date" showCustom={false} micro />
        </div>
        <span className="shrink-0 [&_button]:h-9 sm:[&_button]:h-10">
          <DateFilterPopover value={dateFilter} onChange={applyDateFilter} testid="transfer-records-date-filter" centered iconOnly phoneIconOnly />
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="h-9 w-9 p-0 border-slate-500 bg-slate-500 text-white hover:bg-slate-600 hover:text-white sm:h-8 sm:w-auto sm:px-3"
            title="Refresh"
            aria-label="Refresh"
            data-testid="transfer-records-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={exportSheet}
            disabled={!rows.length}
            className="h-9 w-9 p-0 bg-emerald-600 text-white hover:bg-emerald-700 sm:h-8 sm:w-auto sm:px-3"
            title="Download as an Excel sheet"
            aria-label="Download as an Excel sheet"
            data-testid="transfer-records-download"
          >
            <Download className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Download Excel</span>
          </Button>
        </div>
      </div>

      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white py-14 text-center text-sm text-slate-400">
          {loading ? "Loading..." : records.length ? "No transfers match." : "No branch transfers yet."}
        </div>
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setOpen(r)}
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{r.lead.name}</p>
                    <p className="truncate text-xs text-slate-500">{r.from_branch_name} → {r.to_branch_name}</p>
                  </div>
                  <DirectionPill direction={r.direction} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span>{r.lead.phone}</span>
                  <span>· {dateStampFull(r.at)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Patient</th>
                    <th className="px-4 py-2.5 font-semibold">Contact</th>
                    <th className="px-4 py-2.5 font-semibold">From</th>
                    <th className="px-4 py-2.5 font-semibold">To</th>
                    <th className="px-4 py-2.5 font-semibold">Transferred On</th>
                    <th className="px-4 py-2.5 font-semibold">Stage</th>
                    <th className="px-4 py-2.5 font-semibold">By</th>
                    <th className="px-4 py-2.5 font-semibold">Direction</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setOpen(r)}
                      className="cursor-pointer hover:bg-slate-50"
                      data-testid={`transfer-record-row-${r.id}`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{r.lead.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{r.lead.patient_number || "—"}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.lead.phone}
                        {r.lead.email ? <span className="block truncate text-[11px] text-slate-400">{r.lead.email}</span> : null}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.from_branch_name || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{r.to_branch_name || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="whitespace-nowrap">{dateStampFull(r.at)}</span>
                        <span className="block text-[11px] text-slate-400">{callTimeStamp(r.at)}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.consultation_stage || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.transferred_by || "—"}
                        {r.transferred_by_role ? <span className="block text-[11px] capitalize text-slate-400">{r.transferred_by_role.replace(/_/g, " ")}</span> : null}
                      </td>
                      <td className="px-4 py-3"><DirectionPill direction={r.direction} /></td>
                      <td className="px-4 py-3 text-right"><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <TransferRecordDialog record={open} onClose={() => setOpen(null)} />
    </div>
  );
};

const DirectionPill = ({ direction }) => (
  <span
    className={`inline-flex shrink-0 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${
      direction === "outgoing"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-emerald-200 bg-emerald-50 text-emerald-700"
    }`}
  >
    {direction === "outgoing" ? "Transferred Out" : "Transferred In"}
  </span>
);

const Field = ({ label, children }) => (
  <div>
    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
    <p className="text-sm text-slate-700">{children || "—"}</p>
  </div>
);

const TransferRecordDialog = ({ record, onClose }) => {
  if (!record) return null;
  const { lead } = record;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="transfer-record-dialog">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {lead.name} <DirectionPill direction={record.direction} />
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{lead.patient_number || "No patient number"}</DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">This Transfer</h4>
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3">
            <Field label="From Branch">{record.from_branch_name}</Field>
            <Field label="To Branch">{record.to_branch_name}</Field>
            <Field label="Date & Time">{`${dateStampFull(record.at)} ${callTimeStamp(record.at)}`}</Field>
            <Field label="Stage at Transfer">{record.consultation_stage}</Field>
            <Field label="Sessions Released">{String(record.sessions_released || 0)}</Field>
            <Field label="Collected Before Transfer">{money(record.collected_before_transfer)}</Field>
            <Field label="Transferred By">
              {record.transferred_by}{record.transferred_by_role ? ` (${record.transferred_by_role.replace(/_/g, " ")})` : ""}
            </Field>
            <div className="col-span-2 sm:col-span-3"><Field label="Reason">{record.reason}</Field></div>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Lead Details</h4>
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3">
            <Field label="Phone">{lead.phone}</Field>
            <Field label="Email">{lead.email}</Field>
            <Field label="Vertical">{lead.vertical}</Field>
            <Field label="Source">{lead.source_type}</Field>
            <Field label="Current Branch">{lead.current_branch_name}</Field>
            <Field label="Current Stage">{currentStage(lead)}</Field>
            <Field label="Physio">{lead.assigned_physio_name}</Field>
            <Field label="Package">{lead.package_name}</Field>
            <Field label="Consultation Fee">{money(lead.consultation_fee)}</Field>
            <Field label="Package Paid">{money(lead.package_paid)}</Field>
            <Field label="Treatment Fee Paid">{money(lead.treatment_fee_paid)}</Field>
            <Field label="Lead Created">{dateStampFull(lead.created_at)}</Field>
            {lead.notes ? <div className="col-span-2 sm:col-span-3"><Field label="Notes">{lead.notes}</Field></div> : null}
          </div>
        </section>

        {(lead.transfer_history || []).length > 1 && (
          <section className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">All Transfers of this Patient</h4>
            <ol className="space-y-2">
              {lead.transfer_history.map((m, i) => (
                <li key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">
                  <span className="font-medium text-slate-800">{m.from_branch_name} → {m.to_branch_name}</span>
                  <span className="block text-[11px] text-slate-400">
                    {dateStampFull(m.at)} {callTimeStamp(m.at)} · {m.transferred_by || "—"}{m.reason ? ` · ${m.reason}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
};
