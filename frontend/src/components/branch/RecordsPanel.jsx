import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight, ChevronDown, ChevronRight, Download, EyeOff, FileSpreadsheet, FileText, Filter, Lock, Megaphone,
  RefreshCw, Search, Truck, UserCheck, X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters } from "@/components/QuickDateFilterBar";
import { VendorPanel } from "@/components/branch/VendorPanel";
import { downloadLeadsReportPdf, downloadLeadsReportXlsx } from "@/components/branch/leadsReport";
import {
  getBranchBoard,
  getBranches,
  getBranchTransferRecords,
  getLeadSourceVisibility,
  unlockLeadSourceVisibility,
  setLeadSourceHidden,
} from "@/lib/api";
import { downloadCsv } from "@/lib/printable";
import { dateStampFull, callTimeStamp } from "@/lib/time";
import { telNumber } from "@/lib/phone";

/**
 * The branch's Records tab. Branch Transfer Records is the first record kept here; the
 * sub-tab strip is there so the next one lands beside it rather than on a new top tab.
 */
const RECORD_TABS = [
  { key: "branch_transfers", label: "Branch Transfer Records", icon: ArrowLeftRight },
  { key: "leads_converted", label: "Leads Converted", icon: UserCheck },
  { key: "lead_sources", label: "Leads Source", icon: Megaphone },
  { key: "vendors", label: "Vendor Records", icon: Truck },
];

const money = (n) => `Rs.${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const currentStage = (lead) => lead.consultation_stage || lead.branch_stage || lead.stage || "—";
// Read as the Branch Leads Source column and its dropdown read it: source_tab, else source_type.
const NO_SOURCE = "No Source";
const sourceOf = (lead) => String(lead.source_tab || lead.source_type || "").trim() || NO_SOURCE;
// [source, count] pairs, biggest first; a lead with no source goes last whatever its count.
const countBySource = (leads) => {
  const counts = {};
  leads.forEach((l) => { const s = sourceOf(l); counts[s] = (counts[s] || 0) + 1; });
  return Object.entries(counts)
    .sort(([a, x], [b, y]) => (a === NO_SOURCE) - (b === NO_SOURCE) || y - x || a.localeCompare(b));
};

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
      {sub === "leads_converted" && <LeadsConvertedRecords branchId={branchId} />}
      {sub === "lead_sources" && <LeadSourceRecords branchId={branchId} />}
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
        "Sessions Released", "Collected by From Branch", "Collected by To Branch", "Balance to Collect",
        "Reason", "Transferred By", "Role"],
      ...rows.map((r) => [
        r.lead.patient_number, r.lead.name, r.lead.phone, r.lead.email,
        r.direction === "outgoing" ? "Outgoing" : "Incoming",
        r.from_branch_name, r.to_branch_name,
        dateStampFull(r.at), callTimeStamp(r.at),
        r.consultation_stage || "", currentStage(r.lead), r.lead.current_branch_name,
        r.sessions_released || 0, r.from_branch_collected || 0, r.to_branch_collected || 0,
        r.lead.balance_to_collect || 0,
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
                <CollectedSplit record={r} compact />
                {r.reason ? <p className="mt-1 truncate text-[11px] text-slate-500">Reason: {r.reason}</p> : null}
              </button>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Patient</th>
                    <th className="px-4 py-2.5 font-semibold">Contact</th>
                    <th className="px-4 py-2.5 font-semibold">From</th>
                    <th className="px-4 py-2.5 font-semibold">To</th>
                    <th className="px-4 py-2.5 font-semibold">Transferred On</th>
                    <th className="px-4 py-2.5 font-semibold">Stage</th>
                    <th className="px-4 py-2.5 font-semibold">Collected</th>
                    <th className="px-4 py-2.5 font-semibold">Reason</th>
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
                      <td className="px-4 py-3"><CollectedSplit record={r} /></td>
                      <td className="max-w-[14rem] px-4 py-3 text-slate-600">
                        <span className="line-clamp-2" title={r.reason || ""}>{r.reason || "—"}</span>
                      </td>
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

const has = (v) => v !== null && v !== undefined;

// The four services sold after the consultation. Buying any one of them is what converts a
// lead -- the Dashboard's Number Of Converted rule (_is_converted in v3_dashboard.py), so
// the two figures never disagree. Change one, change both.
const SERVICES = [
  { key: "physio_assign", label: "Physio Assign", match: (l) => has(l.treatment_fee_paid) || !!l.session_package_id },
  { key: "rehab", label: "Rehab", match: (l) => has(l.rehab_fee_paid) },
  { key: "diet_consultation", label: "Diet Consultation", match: (l) => has(l.diet_fee_paid) },
  { key: "diet_chart", label: "Diet Chart", match: (l) => has(l.diet_chart_fee_paid) },
];
const isConvertedLead = (l) => SERVICES.some((s) => s.match(l));
const servicesOf = (l) => SERVICES.filter((s) => s.match(l)).map((s) => s.label);

// Consultation stages a lead only stands on once it has been seen.
const SEEN_STAGES = new Set(["Consultation Visit", "Fee Collected", "Physio Assign", "Consultation Completed"]);

// The main line, in order -- what the Reached column reads. Each step counts the leads that
// REACHED it, not the ones standing on it now: a lead is on one stage at a time, so "on
// Appointment now" drops everybody who has since moved on and the count would rise and fall
// at random. `proof` is something the lead keeps after moving on -- a date, a booking, a
// payment -- and is this step's own evidence only. furthestStep adds the rest: reaching a
// step proves every step before it.
const FUNNEL = [
  { key: "leads", label: "Lead", proof: () => true },
  // Fixing the appointment is what books the consultation: one step, either proof.
  {
    key: "appointment",
    label: "Appointment",
    proof: (l) => !!l.appointment_date || (l.consultation_follow_ups || []).length > 0
      || !!l.head_consultation_stage || (!!l.consultation_stage && l.consultation_stage !== "Cancel"),
  },
  {
    key: "consultation_visit",
    label: "Consultation Visit",
    proof: (l) => !!l.consultation_decision || has(l.consultation_fee) || SEEN_STAGES.has(l.consultation_stage),
  },
  { key: "fee_collected", label: "Fee Collected", proof: (l) => has(l.package_paid) },
  { key: "converted", label: "Converted", proof: isConvertedLead },
];
const furthestStep = (l) => {
  for (let i = FUNNEL.length - 1; i > 0; i -= 1) if (FUNNEL[i].proof(l)) return i;
  return 0;
};
const reachedAtLeast = (key) => {
  const i = FUNNEL.findIndex((s) => s.key === key);
  return (l) => furthestStep(l) >= i;
};

const isCancelled = (l) => l.branch_stage === "Cancelled" || l.consultation_stage === "Cancel";

/**
 * The tab's six cards, one row. RNR and Follow Up are detours a lead comes back from, so
 * they count anyone who was ever there; Appointment and Consultation Visit count the leads
 * that reached them (see FUNNEL); Lost is every way a lead stops short -- Not a Prospect,
 * Cancel at the branch or at the consultation, and Pre-Sales' own Lost -- the reading the
 * Marketing Head's Lost card takes in PreSalesCRM.
 */
const LEAD_CARDS = [
  { key: "leads", label: "Leads", match: () => true },
  { key: "rnr", label: "RNR", match: (l) => (l.rnr_attempts || 0) > 0 || l.branch_stage === "RNR" },
  { key: "follow_up", label: "Follow Up", match: (l) => (l.follow_ups || []).length > 0 || l.branch_stage === "Follow Up" },
  { key: "appointment", label: "Appointment", match: reachedAtLeast("appointment") },
  { key: "consultation_visit", label: "Consultation Visit", match: reachedAtLeast("consultation_visit") },
  {
    key: "lost",
    label: "Lost",
    match: (l) => l.stage === "Lost" || !!l.not_prospect_at || l.branch_stage === "Not a prospect" || isCancelled(l),
  },
];
const CARD_BY_KEY = Object.fromEntries(LEAD_CARDS.map((c) => [c.key, c]));
const countCards = (leads) => {
  const out = Object.fromEntries(LEAD_CARDS.map((c) => [c.key, 0]));
  leads.forEach((l) => LEAD_CARDS.forEach((c) => { if (c.match(l)) out[c.key] += 1; }));
  return out;
};

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const ALL_SOURCES = "all";

// "01 Oct 2026 – 31 Oct 2026", the period a report covers, read off whichever of the two
// date controls is narrowing the list.
const periodLabel = (filter) => {
  if (!filter?.from && !filter?.to) return "All dates";
  if (!filter.to) return `From ${dateStampFull(filter.from)}`;
  if (!filter.from) return `Up to ${dateStampFull(filter.to)}`;
  const a = dateStampFull(filter.from);
  const b = dateStampFull(filter.to);
  return a === b ? a : `${a} – ${b}`;
};
const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The report object behind both files (see leadsReport.js), shared by Leads Converted and
 * Leads Source so a download from either tab reads the same. `scoped` is what the cards
 * count -- date, search and source applied; `list` is the leads printed one per row.
 */
const buildLeadsReport = ({ branchName, scoped, list, filter, sourceLabel, showing }) => {
  const counts = countCards(scoped);
  const bySource = countBySource(scoped).map(([name]) => {
    const c = countCards(scoped.filter((l) => sourceOf(l) === name));
    return [name, ...LEAD_CARDS.map((card) => c[card.key])];
  });
  const now = new Date();
  return {
    branch: branchName,
    period: periodLabel(filter),
    source: sourceLabel,
    showing,
    generated: `${dateStampFull(now)}, ${callTimeStamp(now)}`,
    summary: LEAD_CARDS.map((c) => ({
      key: c.key,
      label: c.label,
      count: counts[c.key],
      share: c.key === "leads" ? "Every lead" : `${pct(counts[c.key], counts.leads)} of Leads`,
    })),
    bySource: { rows: bySource, total: LEAD_CARDS.map((c) => counts[c.key]) },
    leads: list.map((l) => ({
      patientNumber: l.patient_number,
      name: l.name,
      // Plain digits, as the Call button dials it: some records carry "p:+91..." from the sheet.
      phone: telNumber(l.phone) || l.phone,
      email: l.email,
      source: sourceOf(l),
      reached: FUNNEL[furthestStep(l)].label,
      stage: currentStage(l),
      services: servicesOf(l).join(", "),
      date: dateStampFull(l.created_at),
      time: callTimeStamp(l.created_at),
    })),
  };
};

const leadsReportFilename = ({ prefix, branchName, source, filter }, ext) => [
  prefix,
  fileSlug(branchName),
  source === ALL_SOURCES ? "all-sources" : fileSlug(source),
  filter ? fileSlug(periodLabel(filter)) : new Date().toISOString().slice(0, 10),
].filter(Boolean).join("-") + `.${ext}`;

// Saves the report as kind: "pdf" or "xlsx".
const saveLeadsReport = async (kind, report, filename) => {
  try {
    if (kind === "pdf") await downloadLeadsReportPdf(report, filename);
    else downloadLeadsReportXlsx(report, filename);
  } catch {
    toast.error("Couldn't build the report");
  }
};

// The Download button and its two formats, as both lead tabs carry it.
const LeadsReportMenu = ({ disabled, exporting, caption, onPick, testid }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        size="sm"
        disabled={disabled || exporting}
        className="h-9 w-9 p-0 bg-emerald-600 text-white hover:bg-emerald-700 sm:h-8 sm:w-auto sm:px-3"
        title="Download the report"
        aria-label="Download the report"
        data-testid={testid}
      >
        {exporting ? <RefreshCw className="h-4 w-4 animate-spin sm:mr-1.5" /> : <Download className="h-4 w-4 sm:mr-1.5" />}
        <span className="hidden sm:inline">Download</span>
        <ChevronDown className="ml-1 hidden h-3.5 w-3.5 opacity-80 sm:inline" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60" data-testid={`${testid}-menu`}>
      <DropdownMenuLabel className="text-[11px] font-normal text-slate-500">{caption}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => onPick("pdf")} className="gap-2.5 py-2" data-testid={`${testid}-pdf`}>
        <FileText className="h-4 w-4 text-rose-600" />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-slate-800">PDF Report</span>
          <span className="text-[11px] text-slate-400">Summary, by source, lead list</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onPick("xlsx")} className="gap-2.5 py-2" data-testid={`${testid}-excel`}>
        <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-slate-800">Excel Sheet</span>
          <span className="text-[11px] text-slate-400">Summary and Leads sheets</span>
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

// The branch's name, for the report's letterhead only, so a failure costs that line alone.
const useBranchName = (branchId) => {
  const [branchName, setBranchName] = useState("");
  useEffect(() => {
    if (!branchId) return undefined;
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranchName((rows || []).find((b) => b.id === branchId)?.branch_name || ""); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [branchId]);
  return branchName;
};

/**
 * Leads Converted: the branch's leads as six cards -- Lead, RNR, Follow Up, Appointment,
 * Consultation Visit, Lost -- counted off the same lead list Branch Leads draws, the way
 * Leads Source is. A card narrows the list below it.
 *
 * The toolbar carries Branch Leads' Source filter, and Download offers the month-end report
 * as a PDF or an Excel workbook: the six counts, the same six split by source, and the
 * leads behind them. Pick This Month (or the calendar) and a source, then download.
 *
 * Dated by when the lead came in, as the Dashboard's funnel is: the cards then describe one
 * set of people from enquiry onward, rather than this month's appointments over this
 * month's enquiries, which are mostly different people. A lead moved to another branch is
 * counted where it is now, as on every other Branch Leads screen.
 */
const LeadsConvertedRecords = ({ branchId }) => {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(false);
  const branchName = useBranchName(branchId);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const [pick, setPick] = useState("leads");
  const [source, setSource] = useState(ALL_SOURCES);
  const [exporting, setExporting] = useState(false);
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
      const data = await getBranchBoard(branchId);
      setLeads(data.leads || []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to load leads");
    }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  // Date and search first, then source, the card last: the cards count what the date,
  // search and source leave, and pressing one never changes the numbers on the others.
  // Newest lead first.
  const dated = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = effectiveDateFilter?.from?.getTime();
    const to = effectiveDateFilter?.to?.getTime();
    return leads
      .filter((l) => {
        const ts = new Date(l.created_at || 0).getTime();
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        if (!q) return true;
        return [l.name, l.phone, l.patient_number].some((v) => (v || "").toLowerCase().includes(q));
      })
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }, [leads, search, effectiveDateFilter]);

  // Every source the branch has ever had, so the menu does not reshuffle as the dates
  // move; the count beside each is for the dates picked.
  const sourceOptions = useMemo(() => {
    const inRange = Object.fromEntries(countBySource(dated));
    return countBySource(leads).map(([name]) => [name, inRange[name] || 0]);
  }, [leads, dated]);

  const scoped = useMemo(
    () => (source === ALL_SOURCES ? dated : dated.filter((l) => sourceOf(l) === source)),
    [dated, source],
  );
  const counts = useMemo(() => countCards(scoped), [scoped]);
  const rows = useMemo(() => scoped.filter(CARD_BY_KEY[pick].match), [scoped, pick]);

  const sourceLabel = source === ALL_SOURCES ? "All Sources" : source;
  const filtered = pick !== "leads" || source !== ALL_SOURCES || !!effectiveDateFilter || !!search.trim();
  const clearFilters = () => {
    setPick("leads");
    setSource(ALL_SOURCES);
    setQuickDate(null);
    setDateFilter(null);
    setSearch("");
    setSearchOpen(false);
  };

  const exportReport = async (kind) => {
    if (exporting) return;
    setExporting(true);
    const report = buildLeadsReport({
      branchName,
      scoped,
      list: rows,
      filter: effectiveDateFilter,
      sourceLabel,
      showing: pick === "leads" ? "All Leads" : CARD_BY_KEY[pick].label,
    });
    await saveLeadsReport(kind, report, leadsReportFilename({ prefix: "leads-report", branchName, source, filter: effectiveDateFilter }, kind));
    setExporting(false);
  };

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const toggleSearch = () => {
    if (searchOpen) setSearch("");
    setSearchOpen((v) => !v);
  };

  if (!branchId) {
    return <p className="py-10 text-center text-sm text-slate-400">Leads are kept per branch.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* One row of six from lg; three a row below that, where six would not read. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-6">
        {LEAD_CARDS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setPick(c.key)}
            className={`relative rounded-[5px] border bg-white px-3 py-2.5 text-left transition-colors ${
              pick === c.key ? "border-sky-400 ring-1 ring-sky-300" : "border-slate-200 hover:border-slate-300"
            }`}
            title={c.label}
            data-testid={`leads-converted-card-${c.key}`}
          >
            <p className="truncate pr-6 text-[11px] font-medium text-slate-500">{c.label}</p>
            <p className={`text-xl font-bold ${c.key === "lost" ? "text-rose-600" : "text-slate-800"}`}>{counts[c.key]}</p>
            <p className="truncate text-[10px] text-slate-400">
              {c.key === "leads" ? "Every lead" : `${pct(counts[c.key], counts.leads)} of Leads`}
            </p>
            <ChevronRight aria-hidden className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          </button>
        ))}
      </div>

      {/* The Branch Transfer Records toolbar, field for field, with Branch Leads' Source
          filter after the dates and Download opening onto its two formats. One line on a
          phone: the search, the source and the download are glyphs there. */}
      <div className="flex flex-nowrap items-center gap-1 sm:flex-wrap sm:gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={toggleSearch}
          className={`h-9 w-9 shrink-0 p-0 sm:hidden ${searchOpen ? "border-sky-500 bg-sky-50 text-sky-700" : ""}`}
          title={searchOpen ? "Close search" : "Search"}
          aria-label={searchOpen ? "Close search" : "Search"}
          aria-expanded={searchOpen}
          data-testid="leads-converted-search-toggle"
        >
          {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </Button>
        <div className={`relative min-w-0 flex-1 sm:block sm:min-w-[200px] sm:max-w-xs ${searchOpen ? "" : "hidden"}`}>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, phone..."
            className="pl-9"
            data-testid="leads-converted-search"
          />
        </div>
        <div className={`min-w-0 flex-1 sm:flex-none sm:block ${searchOpen ? "hidden" : ""}`}>
          <QuickDateFilterBar value={quickDate} onChange={setQuickDate} testid="leads-converted-quick-date" showCustom={false} micro />
        </div>
        <span className="shrink-0 [&_button]:h-9 sm:[&_button]:h-10">
          <DateFilterPopover value={dateFilter} onChange={applyDateFilter} testid="leads-converted-date-filter" centered iconOnly phoneIconOnly />
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={`h-9 w-9 shrink-0 p-0 text-xs font-medium sm:h-10 sm:w-auto sm:max-w-[13rem] sm:px-3 ${
                source !== ALL_SOURCES ? "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-800" : "text-slate-600"
              }`}
              title={`Source: ${sourceLabel}`}
              aria-label={`Source: ${sourceLabel}`}
              data-testid="leads-converted-source-filter"
            >
              <Filter className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden truncate sm:inline">{sourceLabel}</span>
              <ChevronDown className="ml-1 hidden h-3.5 w-3.5 opacity-60 sm:inline" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto" data-testid="leads-converted-source-menu">
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-slate-400">Source</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={source} onValueChange={setSource}>
              <DropdownMenuRadioItem value={ALL_SOURCES} className="text-xs font-medium text-slate-600">
                <span className="flex-1">All Sources</span>
                <span className="ml-3 text-[11px] text-slate-400">{dated.length}</span>
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {sourceOptions.map(([name, n]) => (
                <DropdownMenuRadioItem key={name} value={name} className="text-xs text-slate-700" data-testid={`leads-converted-source-${name}`}>
                  <span className="flex-1 truncate">{name}</span>
                  <span className="ml-3 text-[11px] text-slate-400">{n}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="h-9 w-9 p-0 border-slate-500 bg-slate-500 text-white hover:bg-slate-600 hover:text-white sm:h-8 sm:w-auto sm:px-3"
            title="Refresh"
            aria-label="Refresh"
            data-testid="leads-converted-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <LeadsReportMenu
            disabled={!scoped.length}
            exporting={exporting}
            caption={`${sourceLabel} · ${periodLabel(effectiveDateFilter)}`}
            onPick={exportReport}
            testid="leads-converted-download"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500" data-testid="leads-converted-showing">
        <p className="min-w-0 truncate">
          Showing <span className="font-semibold text-slate-700">{pick === "leads" ? "All Leads" : CARD_BY_KEY[pick].label}</span>
          {source !== ALL_SOURCES ? <> · <span className="font-semibold text-slate-700">{source}</span></> : null}
          {" "}· {rows.length}
        </p>
        {filtered ? (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:border-slate-300 hover:text-slate-700"
            data-testid="leads-converted-clear"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        ) : null}
      </div>

      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white py-14 text-center text-sm text-slate-400">
          {loading ? "Loading..." : leads.length ? "No leads match." : "No leads yet."}
        </div>
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {rows.map((l) => (
              <div key={l.id} className="w-full rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{l.name}</p>
                    <p className="truncate text-xs text-slate-500">{currentStage(l)}</p>
                  </div>
                  <SourcePill source={sourceOf(l)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span>{l.phone}</span>
                  <span>· {dateStampFull(l.created_at)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Patient</th>
                    <th className="px-4 py-2.5 font-semibold">Contact</th>
                    <th className="px-4 py-2.5 font-semibold">Source</th>
                    <th className="px-4 py-2.5 font-semibold">Reached</th>
                    <th className="px-4 py-2.5 font-semibold">Services Bought</th>
                    <th className="px-4 py-2.5 font-semibold">Stage</th>
                    <th className="px-4 py-2.5 font-semibold">Lead Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50" data-testid={`leads-converted-row-${l.id}`}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{l.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{l.patient_number || "—"}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {l.phone}
                        {l.email ? <span className="block truncate text-[11px] text-slate-400">{l.email}</span> : null}
                      </td>
                      <td className="px-4 py-3"><SourcePill source={sourceOf(l)} /></td>
                      <td className="px-4 py-3 text-slate-600">{FUNNEL[furthestStep(l)].label}</td>
                      <td className="px-4 py-3"><ServicePills services={servicesOf(l)} /></td>
                      <td className="px-4 py-3 text-slate-600">{currentStage(l)}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="whitespace-nowrap">{dateStampFull(l.created_at)}</span>
                        <span className="block text-[11px] text-slate-400">{callTimeStamp(l.created_at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const ServicePills = ({ services }) => (
  services.length ? (
    <span className="flex flex-wrap justify-end gap-1 sm:justify-start">
      {services.map((s) => (
        <span key={s} className="whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          {s}
        </span>
      ))}
    </span>
  ) : <span className="text-[11px] text-slate-400">—</span>
);

/**
 * Where the branch's leads came from: one card per source, counted off the same lead list
 * Branch Leads draws, so a number here and the Source dropdown there never disagree.
 * Built the way Branch Transfer Records is -- cards, search, both date controls -- and
 * Download is Leads Converted's: the same PDF report and Excel workbook, for the source card
 * picked and the dates set.
 */
const LeadSourceRecords = ({ branchId }) => {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const [source, setSource] = useState("all");
  const [exporting, setExporting] = useState(false);
  const branchName = useBranchName(branchId);
  const [quickDate, setQuickDate] = useState(null);
  const [dateFilter, setDateFilter] = useState(null);
  // The sources a developer has switched off: their card is left out of the strip, their
  // leads are not. The password the popup was opened with is held here, in memory only, so
  // a second visit to the popup in the same sitting does not ask again; leaving the tab
  // forgets it, and the server checks it on every switch regardless.
  const [hidden, setHidden] = useState([]);
  // Developer Access can take the button away altogether. Off until the server says On, so
  // a switched-off button never flashes up while the setting is read.
  const [buttonEnabled, setButtonEnabled] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [devPassword, setDevPassword] = useState(null);
  const applyDateFilter = (next) => {
    setDateFilter(next);
    if (next) setQuickDate(null);
  };
  const effectiveDateFilter = useMemo(() => intersectDateFilters(dateFilter, quickDate), [dateFilter, quickDate]);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    // Apart, so a failed read of the hidden list still draws every card rather than none.
    getLeadSourceVisibility()
      .then((r) => { setHidden(r.hidden || []); setButtonEnabled(r.button_enabled !== false); })
      .catch(() => {});
    try {
      const data = await getBranchBoard(branchId);
      setLeads(data.leads || []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to load lead sources");
    }
    setLoading(false);
  }, [branchId]);

  const applyHidden = (next) => {
    setHidden(next);
    // A card that has just gone cannot stay the one the list is narrowed to.
    if (next.includes(source)) setSource("all");
  };

  useEffect(() => { load(); }, [load]);

  // Date and search first, source last, so the cards count what the date and search leave
  // and pressing one never changes the numbers on the others. Newest lead first.
  const dated = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = effectiveDateFilter?.from?.getTime();
    const to = effectiveDateFilter?.to?.getTime();
    return leads
      .filter((l) => {
        const ts = new Date(l.created_at || 0).getTime();
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        if (!q) return true;
        return [l.name, l.phone, l.patient_number, sourceOf(l)].some((v) => (v || "").toLowerCase().includes(q));
      })
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }, [leads, search, effectiveDateFilter]);

  // All Sources still counts a hidden source's leads: they are still in the list below it.
  const cards = useMemo(
    () => [["all", dated.length], ...countBySource(dated).filter(([s]) => !hidden.includes(s))],
    [dated, hidden],
  );

  // Every source at this branch, undated, for the popup -- and a hidden one with no lead
  // here, so it can still be switched back on from this branch.
  const allSources = useMemo(() => {
    const here = countBySource(leads);
    const seen = new Set(here.map(([s]) => s));
    return [...here, ...hidden.filter((s) => !seen.has(s)).map((s) => [s, 0])];
  }, [leads, hidden]);

  const rows = useMemo(
    () => (source === "all" ? dated : dated.filter((l) => sourceOf(l) === source)),
    [dated, source],
  );

  const sourceLabel = source === "all" ? "All Sources" : source;
  const exportReport = async (kind) => {
    if (exporting) return;
    setExporting(true);
    const report = buildLeadsReport({
      branchName, scoped: rows, list: rows, filter: effectiveDateFilter, sourceLabel, showing: "All Leads",
    });
    await saveLeadsReport(kind, report, leadsReportFilename({ prefix: "leads-source-report", branchName, source, filter: effectiveDateFilter }, kind));
    setExporting(false);
  };

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const toggleSearch = () => {
    if (searchOpen) setSearch("");
    setSearchOpen((v) => !v);
  };

  if (!branchId) {
    return <p className="py-10 text-center text-sm text-slate-400">Lead sources are kept per branch.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3 lg:grid-cols-5">
        {cards.map(([key, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSource(key)}
            className={`relative rounded-[5px] border bg-white px-3 py-2.5 text-left transition-colors ${
              source === key ? "border-sky-400 ring-1 ring-sky-300" : "border-slate-200 hover:border-slate-300"
            }`}
            title={key === "all" ? "All Sources" : key}
            data-testid={`lead-source-card-${key}`}
          >
            <p className="truncate pr-6 text-[11px] font-medium text-slate-500">{key === "all" ? "All Sources" : key}</p>
            <p className="text-xl font-bold text-slate-800">{count}</p>
            <ChevronRight aria-hidden className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          </button>
        ))}
      </div>

      {/* The Branch Transfer Records toolbar, field for field: one line on a phone with
          the search behind its icon, the wrapping desk row from sm up. */}
      <div className="flex flex-nowrap items-center gap-1 sm:flex-wrap sm:gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={toggleSearch}
          className={`h-9 w-9 shrink-0 p-0 sm:hidden ${searchOpen ? "border-sky-500 bg-sky-50 text-sky-700" : ""}`}
          title={searchOpen ? "Close search" : "Search"}
          aria-label={searchOpen ? "Close search" : "Search"}
          aria-expanded={searchOpen}
          data-testid="lead-source-search-toggle"
        >
          {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </Button>
        <div className={`relative min-w-0 flex-1 sm:block sm:min-w-[200px] sm:max-w-xs ${searchOpen ? "" : "hidden"}`}>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, phone, source..."
            className="pl-9"
            data-testid="lead-source-search"
          />
        </div>
        <div className={`min-w-0 flex-1 sm:flex-none sm:block ${searchOpen ? "hidden" : ""}`}>
          <QuickDateFilterBar value={quickDate} onChange={setQuickDate} testid="lead-source-quick-date" showCustom={false} micro />
        </div>
        <span className="shrink-0 [&_button]:h-9 sm:[&_button]:h-10">
          <DateFilterPopover value={dateFilter} onChange={applyDateFilter} testid="lead-source-date-filter" centered iconOnly phoneIconOnly />
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {buttonEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setVisibilityOpen(true)}
            className="h-9 w-9 p-0 sm:h-8 sm:w-auto sm:px-3"
            title="Show / Hide Sources (Developer Access)"
            aria-label="Show / Hide Sources"
            data-testid="lead-source-visibility-btn"
          >
            <EyeOff className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Show / Hide Sources</span>
          </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="h-9 w-9 p-0 border-slate-500 bg-slate-500 text-white hover:bg-slate-600 hover:text-white sm:h-8 sm:w-auto sm:px-3"
            title="Refresh"
            aria-label="Refresh"
            data-testid="lead-source-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <LeadsReportMenu
            disabled={!rows.length}
            exporting={exporting}
            caption={`${sourceLabel} · ${periodLabel(effectiveDateFilter)}`}
            onPick={exportReport}
            testid="lead-source-download"
          />
        </div>
      </div>

      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white py-14 text-center text-sm text-slate-400">
          {loading ? "Loading..." : leads.length ? "No leads match." : "No leads yet."}
        </div>
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {rows.map((l) => (
              <div key={l.id} className="w-full rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{l.name}</p>
                    <p className="truncate text-xs text-slate-500">{currentStage(l)}</p>
                  </div>
                  <SourcePill source={sourceOf(l)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span>{l.phone}</span>
                  <span>· {dateStampFull(l.created_at)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Patient</th>
                    <th className="px-4 py-2.5 font-semibold">Contact</th>
                    <th className="px-4 py-2.5 font-semibold">Source</th>
                    <th className="px-4 py-2.5 font-semibold">Stage</th>
                    <th className="px-4 py-2.5 font-semibold">Lead Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50" data-testid={`lead-source-row-${l.id}`}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{l.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{l.patient_number || "—"}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {l.phone}
                        {l.email ? <span className="block truncate text-[11px] text-slate-400">{l.email}</span> : null}
                      </td>
                      <td className="px-4 py-3"><SourcePill source={sourceOf(l)} /></td>
                      <td className="px-4 py-3 text-slate-600">{currentStage(l)}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="whitespace-nowrap">{dateStampFull(l.created_at)}</span>
                        <span className="block text-[11px] text-slate-400">{callTimeStamp(l.created_at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {visibilityOpen && buttonEnabled && (
        <SourceVisibilityDialog
          sources={allSources}
          hidden={hidden}
          onHiddenChange={applyHidden}
          password={devPassword}
          onPassword={setDevPassword}
          onClose={() => setVisibilityOpen(false)}
        />
      )}
    </div>
  );
};

/**
 * Show / Hide Sources, behind the developer password: one line per source, its switch on
 * the right, the way the Danger Zone's list reads. A switch moves only once the server has
 * saved it, and a refused password locks the popup again rather than leaving dead switches.
 */
const SourceVisibilityDialog = ({ sources, hidden, onHiddenChange, password, onPassword, onClose }) => {
  const [passwordInput, setPasswordInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [saving, setSaving] = useState(null);

  const unlock = async (e) => {
    e.preventDefault();
    if (!passwordInput) return;
    setUnlocking(true);
    try {
      const r = await unlockLeadSourceVisibility(passwordInput);
      onHiddenChange(r.hidden || []);
      onPassword(passwordInput);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not unlock");
    }
    setPasswordInput("");
    setUnlocking(false);
  };

  const flip = async (name, show) => {
    setSaving(name);
    try {
      const r = await setLeadSourceHidden(password, name, !show);
      onHiddenChange(r.hidden || []);
      toast.success(show ? `${name} is shown` : `${name} is hidden`);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403 || status === 429 || status === 503) onPassword(null);
      toast.error(err?.response?.data?.detail || "Could not save");
    }
    setSaving(null);
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto" data-testid="lead-source-visibility-dialog">
        <DialogHeader>
          <DialogTitle>Show / Hide Sources</DialogTitle>
          <DialogDescription>
            A hidden source loses its summary card only. Its leads stay in the list and in All Sources. Applies to every branch.
          </DialogDescription>
        </DialogHeader>

        {!password ? (
          <form onSubmit={unlock} className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <Lock className="h-4 w-4" /> Developer password
            </div>
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              data-testid="lead-source-visibility-password"
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={unlocking || !passwordInput} data-testid="lead-source-visibility-unlock">
                {unlocking ? "Checking..." : "Unlock"}
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        ) : !sources.length ? (
          <p className="py-6 text-center text-sm text-slate-400">No sources yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
            {sources.map(([name, count]) => {
              const shown = !hidden.includes(name);
              return (
                <label key={name} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50" data-testid={`lead-source-visibility-row-${name}`}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800" title={name}>{name}</span>
                    <span className="text-[11px] text-slate-400">{count} lead{count === 1 ? "" : "s"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase ${shown ? "text-emerald-600" : "text-slate-400"}`}>
                      {saving === name ? "Saving" : shown ? "Show" : "Hide"}
                    </span>
                    <Switch
                      checked={shown}
                      disabled={saving !== null}
                      onCheckedChange={(v) => flip(name, v)}
                      className="data-[state=checked]:bg-emerald-600"
                      data-testid={`lead-source-visibility-toggle-${name}`}
                    />
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

const SourcePill = ({ source }) => (
  <span
    className={`inline-block max-w-[11rem] shrink-0 truncate whitespace-nowrap align-middle rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${
      source === NO_SOURCE ? "border-slate-200 bg-slate-50 text-slate-400" : "border-sky-200 bg-sky-50 text-sky-700"
    }`}
    title={source}
  >
    {source}
  </span>
);

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

/**
 * The money on one transfer, both sides of it: what the branch left had collected, and
 * what the branch the patient went to has collected since. Each branch reads its own
 * figure in the same place on the same row, so the two lists never tell different stories.
 */
const CollectedSplit = ({ record, compact = false }) => (
  <div className={`${compact ? "mt-1.5 flex flex-wrap gap-x-3" : "space-y-0.5"} text-[11px]`}>
    <p className="whitespace-nowrap text-slate-600">
      <span className="text-slate-400">{record.from_branch_name || "From"}:</span>{" "}
      <b className={record.direction === "outgoing" ? "text-amber-700" : "text-slate-700"}>
        {money(record.from_branch_collected ?? record.collected_before_transfer)}
      </b>
    </p>
    <p className="whitespace-nowrap text-slate-600">
      <span className="text-slate-400">{record.to_branch_name || "To"}:</span>{" "}
      <b className={record.direction === "incoming" ? "text-emerald-700" : "text-slate-700"}>
        {money(record.to_branch_collected)}
      </b>
    </p>
  </div>
);

const PAY_MODES = { cash: "Cash", upi: "UPI", card: "Card", cheque: "Cheque", account_transfer: "Bank transfer" };

const PaymentsColumn = ({ title, subtitle, ours, rows, total }) => {
  const list = rows || [];
  return (
    <div className={`rounded-lg border p-3 ${ours ? "border-sky-300 bg-sky-50/50" : "border-slate-200"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">
            {title}
            {ours ? <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">Your branch</span> : null}
          </p>
          <p className="text-[11px] text-slate-400">{subtitle}</p>
        </div>
        <p className="shrink-0 text-base font-bold text-slate-800">{money(total)}</p>
      </div>
      {list.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">Nothing collected.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {list.map((p) => (
            <li key={p.id || `${p.collected_at}-${p.label}`} className="flex items-start justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-700">
                  {p.label}
                  {PAY_MODES[p.payment_mode] ? <span className="ml-1 font-normal text-slate-400">via {PAY_MODES[p.payment_mode]}</span> : null}
                </p>
                <p className="truncate text-[11px] text-slate-400">
                  {dateStampFull(p.collected_at)}{p.collected_by ? ` · ${p.collected_by}` : ""}{p.transaction_id ? ` · ${p.transaction_id}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-xs font-semibold text-slate-700">{money(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

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
            <Field label="Completed Sessions">{record.sessions_completed == null ? "—" : String(record.sessions_completed)}</Field>
            {record.consultation_released ? <Field label="Booked Consultation">Released</Field> : null}
            {record.physio_released ? <Field label="Physio Released">{record.physio_released}</Field> : null}
            <Field label="Transferred By">
              {record.transferred_by}{record.transferred_by_role ? ` (${record.transferred_by_role.replace(/_/g, " ")})` : ""}
            </Field>
            <div className="col-span-2 sm:col-span-3"><Field label="Reason">{record.reason}</Field></div>
          </div>
        </section>

        <section className="space-y-3" data-testid="transfer-record-payments">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Payments — Who Collected What</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <PaymentsColumn
              title={`Collected by ${record.from_branch_name || "From Branch"}`}
              subtitle="Before the transfer · stays in this branch's book"
              ours={record.direction === "outgoing"}
              rows={record.from_branch_payments}
              total={record.from_branch_collected ?? record.collected_before_transfer}
            />
            <PaymentsColumn
              title={`Collected by ${record.to_branch_name || "To Branch"}`}
              subtitle="After the transfer · belongs to this branch"
              ours={record.direction === "incoming"}
              rows={record.to_branch_payments}
              total={record.to_branch_collected}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-600">Balance still to collect{lead.current_branch_name ? ` (by ${lead.current_branch_name})` : ""}</span>
            <span className="font-bold text-slate-800">{money(lead.balance_to_collect)}</span>
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
            <Field label="Treatment Package">{lead.session_package_name}</Field>
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
