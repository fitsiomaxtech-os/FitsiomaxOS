import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronLeft, Printer, FileSpreadsheet, Wallet, History, IndianRupee } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import { RecordCards } from "@/components/branch/RecordCards";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { waNumber } from "@/lib/phone";
import { isHandheld } from "@/lib/receipt";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const longDate = (iso) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** The WhatsApp wording for one row — the same points the automatic reminder email makes
 * (backend/payment_reminders.py), for the desk to send by hand. */
const reminderText = (r, today) => {
  const lines = [`Hi ${r.client_name || "there"},`, "", `This is a payment reminder from FITSIOMAX${r.branch_name ? ` ${r.branch_name}` : ""}.`];
  if (r.due_date && r.next_installment_amount != null) {
    const what = `${r.next_installment_fee_label || "Payment"}${r.next_installment_number ? ` (installment ${r.next_installment_number})` : ""}`;
    const when = r.due_date < today ? `was due on ${longDate(r.due_date)}` : r.due_date === today ? "is due today" : `is due on ${longDate(r.due_date)}`;
    lines.push(`${what}: ${fmt(r.next_installment_amount)} ${when}.`);
  }
  lines.push(`Total outstanding balance: ${fmt(r.balance)}.`, "", "If you have already paid, please ignore this message. Thank you!");
  return lines.join("\n");
};

/** Straight to the patient's chat with the reminder typed — same handoff as whatsappReceipt. */
const whatsappReminder = (r, today) => {
  const num = waNumber(r.phone);
  if (!num) return;
  const url = `https://wa.me/${num}?text=${encodeURIComponent(reminderText(r, today))}`;
  if (isHandheld()) {
    window.location.href = url;
    return;
  }
  const tab = window.open(url, "_blank");
  if (tab) tab.opener = null;
};

/** Phone cards only — the bare mark, no box or label. The desktop table leaves reminders
 *  to the client popup, whose contact row carries a WhatsApp action of its own. */
const ReminderButton = ({ row, today }) => (
  <button
    type="button"
    // The phone card is itself clickable (it opens the patient), so neither a tap nor
    // Enter on this button may reach it.
    onClick={(e) => { e.stopPropagation(); whatsappReminder(row, today); }}
    onKeyDown={(e) => e.stopPropagation()}
    title="Send payment reminder on WhatsApp"
    aria-label="Send payment reminder on WhatsApp"
    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-50 active:bg-emerald-100"
    data-testid={`outstanding-remind-whatsapp-${row.lead_id}`}
  >
    <WhatsAppIcon className="h-5 w-5" />
  </button>
);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_COLORS = [
  "#1E3A8A", "#EC4899", "#22C55E", "#38BDF8", "#FACC15", "#A78BFA",
  "#FB7185", "#F97316", "#14B8A6", "#8B5CF6", "#92400E", "#DC2626",
];

const STATUS_META = {
  overdue: { label: "Overdue", classes: "bg-rose-100 text-rose-700 border-rose-200" },
  due_soon: { label: "Due Soon", classes: "bg-amber-100 text-amber-700 border-amber-200" },
  partial: { label: "Partial Paid", classes: "bg-sky-100 text-sky-700 border-sky-200" },
};

const StatusBadge = ({ status }) => {
  const meta = STATUS_META[status] || STATUS_META.partial;
  return (
    <span className={`inline-flex whitespace-nowrap items-center rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${meta.classes}`}>
      {meta.label}
    </span>
  );
};

// The status filter as a row of pills, like the Zumba tab's payment modes, rather than a
// dropdown. Each lights in its own status colour, so the pill keeps the colour coding the
// dropdown's options had: [key, label, lit classes].
const STATUS_FILTERS = [
  ["all", "All Statuses", "border-sky-600 bg-sky-600"],
  ["overdue", "Overdue", "border-rose-600 bg-rose-600"],
  ["due_soon", "Due Soon", "border-amber-500 bg-amber-500"],
  ["partial", "Partial Paid", "border-sky-600 bg-sky-600"],
];

const MONTHS_VISIBLE = 5;
const centeredStart = (idx) => Math.min(Math.max(idx - 2, 0), MONTHS.length - MONTHS_VISIBLE);

const MonthFilterBar = ({ month, setMonth }) => {
  const [windowStart, setWindowStart] = useState(() => centeredStart(new Date().getMonth()));

  useEffect(() => {
    let autoMonth = new Date().getMonth();
    const interval = setInterval(() => {
      const nowMonth = new Date().getMonth();
      if (nowMonth !== autoMonth) {
        setMonth((prev) => {
          if (String(prev) === String(autoMonth)) {
            setWindowStart(centeredStart(nowMonth));
            return nowMonth;
          }
          return prev;
        });
        autoMonth = nowMonth;
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [setMonth]);

  const visible = MONTHS.slice(windowStart, windowStart + MONTHS_VISIBLE);

  const allActive = String(month) === "all";

  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2" data-testid="outstanding-month-bar">
      <button
        type="button"
        onClick={() => setMonth("all")}
        className={`h-12 shrink-0 rounded-md border px-5 text-sm font-semibold transition ${allActive ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        data-testid="outstanding-month-all"
      >
        All
      </button>

      <button
        type="button"
        onClick={() => setWindowStart((s) => Math.max(s - 1, 0))}
        disabled={windowStart === 0}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        data-testid="outstanding-month-prev"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div className="flex flex-1 gap-2 overflow-x-auto">
        {visible.map((label, i) => {
          const idx = windowStart + i;
          const active = String(month) === String(idx);
          const color = MONTH_COLORS[idx];
          return (
            <button
              key={label}
              type="button"
              onClick={() => setMonth(idx)}
              className="h-12 flex-1 min-w-[100px] rounded-md border text-sm font-semibold transition"
              style={active
                ? { backgroundColor: color, borderColor: color, color: "#fff" }
                : { backgroundColor: `${color}14`, borderColor: `${color}55`, color }}
              data-testid={`outstanding-month-${idx}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setWindowStart((s) => Math.min(s + 1, MONTHS.length - MONTHS_VISIBLE))}
        disabled={windowStart >= MONTHS.length - MONTHS_VISIBLE}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        data-testid="outstanding-month-next"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
};

const SummaryCard = ({ label, ...rest }) => (
  <StatTile label={label} testid={`outstanding-summary-${label.toLowerCase().replace(/\s+/g, "-")}`} {...rest} />
);

/**
 * The summary cards double as the list's filter, like the Patients strip: the rows a card
 * shows are the rows its figure is summed from, both read off this one table, so the two
 * can never disagree. Total Outstanding and Pending Clients count the same rows -- every
 * balance still open -- so either one brings back the full list.
 */
const CARD_FILTERS = {
  all: () => true,
  overdue: (r) => r.status === "overdue",
  due_today: (r, today) => r.due_date === today,
  pending: () => true,
};

const CARD_EMPTY = {
  overdue: "Nothing overdue.",
  due_today: "Nothing due today.",
};

const toCsv = (rows) => {
  const header = ["S.No", "Client", "Phone", "Branch", "Total Bill", "Paid Amount", "Outstanding Balance", "Due Date", "Status"];
  const lines = rows.map((r, i) => [
    i + 1, r.client_name, r.phone || "", r.branch_name || "", r.total_bill, r.paid_amount, r.balance,
    r.due_date || "", (STATUS_META[r.status] || STATUS_META.partial).label,
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  return [header.join(","), ...lines].join("\n");
};

const downloadCsv = (rows) => {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `outstanding-amount-${todayIso()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// A row's own key. An old client's balance (backend/old_clients.py) has no lead behind it,
// so it goes by the old client it belongs to.
const rowKey = (r) => r.lead_id || `old-${r.old_client_id}`;

/**
 * @param onCollect     Collects what a client's row has due (ScheduleCollectDialog) -- the
 *              per-row Collect the old Partial Payment tab had. `canCollect(row)` says which
 *              rows the desk may take it on; a Past Data balance is never one of them, since
 *              its popup (View) collects against the sheet.
 * @param onCollectOld  Opens the Old Client Instalment form on an old client's row. Their
 *              balance has no client card to open, so this is that row's one action; left
 *              out where the desk may not take the money, and the row offers none.
 * @param onNewOld  Opens the same form empty, for an old client not on this list yet.
 */
export const OutstandingAmountBoard = ({ rows, onView, onCollect, canCollect = () => true, onCollectOld, onNewOld }) => {
  const collectable = (r) => Boolean(onCollect) && !r.old_client && !r.past_data && r.balance > 0 && canCollect(r);
  // What a tap on the row opens, on the phone card and the table row alike: the client
  // popup, or for an old client -- who has no client card -- their instalment form.
  const openRow = (r) => (r.old_client
    ? (onCollectOld ? () => onCollectOld(r) : undefined)
    : (onView ? () => onView(r.lead_id) : undefined));
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("all");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [card, setCard] = useState("all");

  const today = todayIso();
  // A second press on the lit card puts the list back to everything.
  const pickCard = (key) => setCard((cur) => (cur === key ? "all" : key));

  const filtered = useMemo(() => rows.filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (!(r.client_name || "").toLowerCase().includes(q) && !(r.phone || "").includes(q)) return false;
    }
    if (status !== "all" && r.status !== status) return false;
    if (month !== "all") {
      if (!r.due_date || Number(r.due_date.slice(5, 7)) - 1 !== Number(month)) return false;
    }
    if (minAmount && r.balance < Number(minAmount)) return false;
    if (maxAmount && r.balance > Number(maxAmount)) return false;
    return true;
  }), [rows, search, status, month, minAmount, maxAmount]);

  // Counts alongside the sums, so each card's second line says how many clients are behind
  // the figure rather than leaving a number with no sense of scale. Taken before the card
  // filter, so picking one card leaves the other three showing their own figures.
  const totals = useMemo(() => {
    const overdueRows = filtered.filter((r) => CARD_FILTERS.overdue(r, today));
    const dueTodayRows = filtered.filter((r) => CARD_FILTERS.due_today(r, today));
    return {
      totalOutstanding: filtered.reduce((s, r) => s + r.balance, 0),
      overdue: overdueRows.reduce((s, r) => s + r.balance, 0),
      overdueClients: overdueRows.length,
      dueToday: dueTodayRows.reduce((s, r) => s + r.balance, 0),
      dueTodayClients: dueTodayRows.length,
      pendingClients: filtered.length,
    };
  }, [filtered, today]);

  // What the list and the export carry: the filters above, narrowed to the picked card.
  const shown = useMemo(() => filtered.filter((r) => CARD_FILTERS[card](r, today)), [filtered, card, today]);
  const emptyText = CARD_EMPTY[card] || "No outstanding balances.";

  return (
    <div className="space-y-4" data-testid="outstanding-amount-board">
      <MonthFilterBar month={month} setMonth={setMonth} />

      {/* `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness, Patients and Review strips. Each one
          filters the list below -- see CARD_FILTERS. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="Total Outstanding" value={fmt(totals.totalOutstanding)} sub={plural(totals.pendingClients, "client")} arrow color="#d97706" active={card === "all"} onClick={() => pickCard("all")} />
        <SummaryCard label="Overdue Amount" value={fmt(totals.overdue)} sub={plural(totals.overdueClients, "client")} arrow color="#e11d48" active={card === "overdue"} onClick={() => pickCard("overdue")} />
        <SummaryCard label="Due Today" value={fmt(totals.dueToday)} sub={plural(totals.dueTodayClients, "client")} arrow color="#0284c7" active={card === "due_today"} onClick={() => pickCard("due_today")} />
        <SummaryCard label="Pending Clients" value={totals.pendingClients} sub="still owing something" arrow color="#7c3aed" active={card === "pending"} onClick={() => pickCard("pending")} />
      </div>

      <Card data-testid="accountant-manage-outstanding">
        <CardContent className="p-0">
          {/* One toolbar, then the table, as on the Zumba tab: status and amount on the
              left, search and the buttons at the right. On a window too narrow for all
              three groups they wrap onto their own lines rather than interleaving. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5" data-testid="outstanding-status-filter">
              {STATUS_FILTERS.map(([key, label, on]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatus(key)}
                  className={`h-8 rounded-md border px-3 text-xs font-semibold transition ${
                    status === key
                      ? `${on} text-white shadow-sm`
                      : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600"
                  }`}
                  data-testid={`outstanding-status-filter-option-${key}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="hidden h-6 w-px bg-slate-200 xl:block" aria-hidden="true" />
            <div className="flex items-center gap-1.5">
              <Input
                type="number" value={minAmount} onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Min amount" className="h-8 w-28 text-xs"
                data-testid="outstanding-min-amount"
              />
              <Input
                type="number" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="Max amount" className="h-8 w-28 text-xs"
                data-testid="outstanding-max-amount"
              />
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone"
                className="h-8 w-44 text-xs"
                data-testid="outstanding-search"
              />
              <button
                type="button" onClick={() => downloadCsv(shown)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                data-testid="outstanding-export-csv"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" /> Export Excel
              </button>
              <button
                type="button" onClick={() => window.print()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                data-testid="outstanding-print"
              >
                <Printer className="h-3.5 w-3.5" /> Print / PDF
              </button>
              {/* Money for a course begun on the old Physio Tracker: the client is on no
                  list in the OS until their first instalment is entered here. The one
                  button that creates something, so it takes the blue, as Zumba's add does. */}
              {onNewOld && (
                <button
                  type="button" onClick={onNewOld}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700"
                  data-testid="outstanding-old-client-open"
                >
                  <History className="h-3.5 w-3.5" /> Old Client Instalment
                </button>
              )}
            </div>
          </div>

          <div className="p-3 md:hidden">
            <RecordCards
              rows={shown}
              empty={emptyText}
              testid="outstanding-cards"
              card={(r) => ({
                key: rowKey(r),
                testid: `accountant-manage-outstanding-card-${rowKey(r)}`,
                title: r.old_client ? `${r.client_name} · Old client` : r.client_name,
                subtitle: r.phone || r.branch_name || "—",
                amount: (
                  <>
                    <span className="block text-sm font-bold text-amber-600">{fmt(r.balance)}</span>
                    <span className="block text-[11px] text-slate-400">{fmt(r.paid_amount)} of {fmt(r.total_bill)}</span>
                  </>
                ),
                meta: [
                  <StatusBadge status={r.status} />,
                  r.due_date ? <span className="font-semibold text-red-600">Due {r.due_date}</span> : null,
                ],
                // Not for a Past Data balance: that is what an Excel sheet said was owed when it
                // was saved, shown for reading, and no one on the OS set it.
                actions: (collectable(r) || (!r.past_data && waNumber(r.phone))) ? (
                  <>
                    {collectable(r) && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onCollect(r); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-xs font-semibold text-white hover:bg-emerald-700"
                        data-testid={`outstanding-collect-card-${rowKey(r)}`}
                      >
                        <Wallet className="h-3.5 w-3.5" /> Collect
                      </button>
                    )}
                    {!r.past_data && waNumber(r.phone) && <ReminderButton row={r} today={today} />}
                  </>
                ) : null,
                onOpen: openRow(r),
              })}
            />
          </div>

          <div className="hidden md:block">
            {shown.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-slate-400">{emptyText}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[64rem] text-left text-sm">
                  <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    {/* One fact per column, every header and cell on a single line. */}
                    <tr className="whitespace-nowrap">
                      <th className="w-[4%] px-3 py-2.5">S.No</th>
                      <th className="w-[17%] px-3 py-2.5">Client</th>
                      <th className="w-[10%] px-3 py-2.5">Phone</th>
                      <th className="w-[12%] px-3 py-2.5">Branch</th>
                      <th className="w-[9%] px-3 py-2.5">Total Bill</th>
                      <th className="w-[8%] px-3 py-2.5">Paid</th>
                      <th className="w-[9%] px-3 py-2.5">Balance</th>
                      <th className="w-[9%] px-3 py-2.5">Due Date</th>
                      <th className="w-[9%] px-3 py-2.5">Status</th>
                      <th className="w-[8%] px-3 py-2.5 text-center">Payment</th>
                      <th className="w-[5%] px-3 py-2.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((r, i) => {
                      const open = openRow(r);
                      return (
                        <tr
                          key={rowKey(r)}
                          onClick={open}
                          className={`whitespace-nowrap align-middle hover:bg-slate-50/60 ${open ? "cursor-pointer" : ""}`}
                          data-testid={`accountant-manage-outstanding-${rowKey(r)}`}
                        >
                          <td className="px-3 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                          <td className="px-3 py-3">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <p className="max-w-[13rem] truncate text-sm font-semibold leading-5 text-slate-800" title={r.client_name}>{r.client_name || "—"}</p>
                              {r.old_client && (
                                <span className="inline-flex shrink-0 items-center rounded-[5px] border border-indigo-200 bg-indigo-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-indigo-700">
                                  Old client
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-xs leading-5 text-slate-600">{r.phone || "—"}</td>
                          <td className="px-3 py-3">
                            {r.branch_name
                              ? <p className="max-w-[10rem] truncate text-xs leading-5 text-slate-600" title={r.branch_name}>{r.branch_name}</p>
                              : <span className="text-xs leading-5 text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-3 text-xs leading-5 text-slate-700">{fmt(r.total_bill)}</td>
                          <td className="px-3 py-3 text-xs font-semibold leading-5 text-emerald-700">{fmt(r.paid_amount)}</td>
                          <td className="px-3 py-3 text-xs font-semibold leading-5 text-amber-600">{fmt(r.balance)}</td>
                          <td className="px-3 py-3">
                            {r.due_date
                              ? <p className="text-xs font-semibold leading-5 text-rose-600">{r.due_date}</p>
                              : <span className="text-xs leading-5 text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
                          {/* What is due, taken from the list -- the next instalment of a
                              part-paid fee, or a Consultation Fee never collected; an old
                              client's next instalment on their own form. The cell swallows the
                              click so the button does not also open the row behind it. */}
                          <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                            {r.old_client ? (
                              onCollectOld ? (
                                <button
                                  type="button" onClick={() => onCollectOld(r)} title="Collect the next instalment"
                                  className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                                  data-testid={`outstanding-collect-old-${r.old_client_id}`}
                                >
                                  <IndianRupee className="h-3 w-3" /> Collect
                                </button>
                              ) : <span className="text-xs leading-7 text-slate-300">—</span>
                            ) : collectable(r) ? (
                              <button
                                type="button" onClick={() => onCollect(r)}
                                title={r.next_installment_number ? `Collect instalment #${r.next_installment_number}` : "Collect the Consultation Fee"}
                                className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                                data-testid={`outstanding-collect-${r.lead_id}`}
                              >
                                <IndianRupee className="h-3 w-3" /> Collect
                              </button>
                            ) : (
                              <span className="text-xs leading-7 text-slate-300">—</span>
                            )}
                          </td>
                          {/* Opens the client popup, where the payment history and the
                              WhatsApp reminder live. An old client has no client card, so
                              theirs has nothing here but the Collect beside it. */}
                          <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                            {!r.old_client && onView ? (
                              <button
                                type="button"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-sky-700"
                                onClick={() => onView(r.lead_id)}
                                title="View"
                                aria-label="View"
                                data-testid={`outstanding-view-${r.lead_id}`}
                              >
                                <ChevronRight className="h-4 w-4" />
                              </button>
                            ) : (
                              <span className="text-xs leading-7 text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default OutstandingAmountBoard;
