import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Eye, ChevronDown, ChevronRight, ChevronLeft, Printer, FileSpreadsheet, AlertCircle, AlarmClock, CalendarClock, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { RecordCards } from "@/components/branch/RecordCards";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { getClientTransactionHistory } from "@/lib/api";
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

const ReminderButton = ({ row, today, compact }) => (
  <button
    type="button"
    // The phone card is itself clickable (it opens the patient), so neither a tap nor
    // Enter on this button may reach it.
    onClick={(e) => { e.stopPropagation(); whatsappReminder(row, today); }}
    onKeyDown={(e) => e.stopPropagation()}
    title="Send payment reminder on WhatsApp"
    className={compact
      ? "inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
      : "rounded p-1 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"}
    data-testid={`outstanding-remind-whatsapp-${row.lead_id}`}
  >
    <WhatsAppIcon className="h-3.5 w-3.5" />{compact ? " Remind" : null}
  </button>
);
const formatMode = (mode) => (mode ? (mode === "upi" ? "UPI" : mode.charAt(0).toUpperCase() + mode.slice(1)) : "");

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
    <span className={`inline-flex items-center rounded-[5px] border px-2 py-0.5 text-[10px] font-semibold ${meta.classes}`}>
      {meta.label}
    </span>
  );
};

// Native <select> can't reliably color individual dropdown-list items across
// browsers — only the closed box. This renders each option as its own colored,
// rounded row in a custom open list instead.
const ColorFilterDropdown = ({ value, options, onChange, testId }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const current = options.find((o) => o.value === value) || options[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm font-semibold ${current?.classes || "border-slate-200 bg-white text-slate-700"}`}
        data-testid={testId}
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-64 min-w-[170px] space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-1.5 shadow-lg" data-testid={`${testId}-list`}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`block w-full whitespace-nowrap rounded-md border px-3 py-1.5 text-left text-xs font-semibold ${o.classes}`}
              data-testid={`${testId}-option-${o.value}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

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

const ExpandedHistory = ({ leadId }) => {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getClientTransactionHistory(leadId)
      .then((d) => { setHistory(d); setLoading(false); })
      .catch(() => { setHistory(null); setLoading(false); });
  }, [leadId]);

  if (loading) return <p className="px-4 py-3 text-xs text-slate-400">Loading payment history...</p>;
  const transactions = history?.transactions || [];
  if (transactions.length === 0) return <p className="px-4 py-3 text-xs text-slate-400">No payment history yet.</p>;

  return (
    <div className="space-y-1.5 px-4 py-3">
      {transactions.map((tx) => (
        <div key={tx.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-1.5 text-xs">
          <span className="capitalize text-slate-600">{tx.source} · <span className="normal-case">{formatMode(tx.payment_mode)}</span></span>
          <span className="text-slate-400">{(tx.date || "").slice(0, 10)}</span>
          <span className="font-semibold text-emerald-600">{fmt(tx.amount)}</span>
        </div>
      ))}
    </div>
  );
};

export const OutstandingAmountBoard = ({ rows, onView }) => {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("all");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [expanded, setExpanded] = useState(null);

  const today = todayIso();

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
  // the figure rather than leaving a number with no sense of scale.
  const totals = useMemo(() => {
    const overdueRows = filtered.filter((r) => r.status === "overdue");
    const dueTodayRows = filtered.filter((r) => r.due_date === today);
    return {
      totalOutstanding: filtered.reduce((s, r) => s + r.balance, 0),
      overdue: overdueRows.reduce((s, r) => s + r.balance, 0),
      overdueClients: overdueRows.length,
      dueToday: dueTodayRows.reduce((s, r) => s + r.balance, 0),
      dueTodayClients: dueTodayRows.length,
      pendingClients: filtered.length,
    };
  }, [filtered, today]);

  const footer = useMemo(() => filtered.reduce((acc, r) => ({
    total_bill: acc.total_bill + (r.total_bill || 0),
    paid_amount: acc.paid_amount + (r.paid_amount || 0),
    balance: acc.balance + (r.balance || 0),
  }), { total_bill: 0, paid_amount: 0, balance: 0 }), [filtered]);

  return (
    <div className="space-y-4" data-testid="outstanding-amount-board">
      <MonthFilterBar month={month} setMonth={setMonth} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="Total Outstanding" value={fmt(totals.totalOutstanding)} sub={plural(totals.pendingClients, "client")} icon={AlertCircle} color="#d97706" />
        <SummaryCard label="Overdue Amount" value={fmt(totals.overdue)} sub={plural(totals.overdueClients, "client")} icon={AlarmClock} color="#e11d48" />
        <SummaryCard label="Due Today" value={fmt(totals.dueToday)} sub={plural(totals.dueTodayClients, "client")} icon={CalendarClock} color="#0284c7" />
        <SummaryCard label="Pending Clients" value={totals.pendingClients} sub="still owing something" icon={Users} color="#7c3aed" />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client or phone..."
            className="h-9 min-w-[200px] flex-1 rounded-md border border-slate-200 px-3 text-sm"
            data-testid="outstanding-search"
          />
          <ColorFilterDropdown
            value={status}
            options={[
              { value: "all", label: "All Statuses", classes: "border-slate-200 bg-white text-slate-700" },
              { value: "overdue", label: "Overdue", classes: STATUS_META.overdue.classes },
              { value: "due_soon", label: "Due Soon", classes: STATUS_META.due_soon.classes },
              { value: "partial", label: "Partial Paid", classes: STATUS_META.partial.classes },
            ]}
            onChange={setStatus}
            testId="outstanding-status-filter"
          />
          <input
            type="number" value={minAmount} onChange={(e) => setMinAmount(e.target.value)}
            placeholder="Min amount" className="h-9 w-28 rounded-md border border-slate-200 px-2 text-sm"
          />
          <input
            type="number" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)}
            placeholder="Max amount" className="h-9 w-28 rounded-md border border-slate-200 px-2 text-sm"
          />
          <div className="ml-auto flex gap-2">
            <button
              type="button" onClick={() => downloadCsv(filtered)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
              data-testid="outstanding-export-csv"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" /> Export Excel
            </button>
            <button
              type="button" onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
              data-testid="outstanding-print"
            >
              <Printer className="h-3.5 w-3.5" /> Print / PDF
            </button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="accountant-manage-outstanding">
        <CardContent className="p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Outstanding Amount</p>
          <RecordCards
            rows={filtered}
            empty="No outstanding balances."
            testid="outstanding-cards"
            card={(r) => ({
              key: r.lead_id,
              testid: `accountant-manage-outstanding-card-${r.lead_id}`,
              title: r.client_name,
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
                !r.past_data && waNumber(r.phone) && <ReminderButton row={r} today={today} compact />,
              ],
              onOpen: onView ? () => onView(r.lead_id) : undefined,
            })}
          />

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[62rem] table-fixed border-separate border-spacing-x-0 border-spacing-y-2 text-sm">
              <thead>
                <tr>
                  <th className="w-[4%] px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400"></th>
                  <th className="w-[5%] px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">S.No</th>
                  <th className="w-[16%] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Client</th>
                  <th className="w-[13%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Phone</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Branch</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Bill</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Paid</th>
                  <th className="w-[10%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Balance</th>
                  <th className="w-[9%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-red-600">Due Date</th>
                  <th className="w-[9%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Status</th>
                  <th className="w-[13%] px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-sm text-slate-400">No outstanding balances.</td></tr>
                ) : filtered.map((r, i) => (
                  <Fragment key={r.lead_id}>
                    <tr data-testid={`accountant-manage-outstanding-${r.lead_id}`}>
                      <td className="rounded-l-[5px] border-y border-l border-slate-200 bg-white px-2 py-2 text-center">
                        <button type="button" onClick={() => setExpanded(expanded === r.lead_id ? null : r.lead_id)} className="text-slate-400 hover:text-slate-700">
                          {expanded === r.lead_id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="border-y border-slate-200 bg-white px-2 py-2 text-center text-slate-400">{i + 1}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 font-medium text-slate-800">{r.client_name}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-600">{r.phone || "—"}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-600">{r.branch_name || "—"}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center text-slate-700">{fmt(r.total_bill)}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center font-semibold text-emerald-600">{fmt(r.paid_amount)}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center font-semibold text-amber-600">{fmt(r.balance)}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center font-semibold text-red-600">{r.due_date || "—"}</td>
                      <td className="border-y border-slate-200 bg-white px-3 py-2 text-center"><StatusBadge status={r.status} /></td>
                      <td className="rounded-r-[5px] border-y border-r border-slate-200 bg-white px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          <button type="button" onClick={() => onView && onView(r.lead_id)} title="View Details" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-sky-600">
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          {/* Not for a Past Data balance: that is what an Excel sheet said was owed
                              when it was saved, shown for reading, and no one on the OS set it. */}
                          {!r.past_data && waNumber(r.phone) && <ReminderButton row={r} today={today} />}
                        </div>
                      </td>
                    </tr>
                    {expanded === r.lead_id && (
                      <tr>
                        <td colSpan={11} className="border-x border-b border-slate-200 bg-slate-50/60 p-0">
                          <ExpandedHistory leadId={r.lead_id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Totals</td>
                    <td className="px-3 py-2 text-center text-xs font-bold text-slate-700">{fmt(footer.total_bill)}</td>
                    <td className="px-3 py-2 text-center text-xs font-bold text-emerald-600">{fmt(footer.paid_amount)}</td>
                    <td className="px-3 py-2 text-center text-xs font-bold text-amber-600">{fmt(footer.balance)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default OutstandingAmountBoard;
