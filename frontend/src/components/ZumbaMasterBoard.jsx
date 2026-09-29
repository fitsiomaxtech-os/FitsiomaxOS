import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Music, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { listZumba } from "@/lib/api";

// The three evenings the class runs, in the numbering Date.getDay() uses (0 = Sunday).
// The same three the membership is sold on — see ZUMBA_CLASS_DAYS in PackagesBoard.jsx
// and CLASS_WEEKDAYS in backend/routers/v3_zumba.py, which is the one that counts.
const CLASS_DAYS = [1, 3, 5];
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

// A day as the strip counts by: local, not UTC, or a class after 5:30am IST lands on
// yesterday's column.
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoDay(new Date());
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDay(d);
};
const weekOf = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  const sunday = shiftIso(iso, -d.getDay());
  return Array.from({ length: 7 }, (_, i) => shiftIso(sunday, i));
};
const isClassDayIso = (iso) => CLASS_DAYS.includes(new Date(`${iso}T00:00:00`).getDay());

const shortDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

// The status chip as the Branch Admin's Zumba table draws it (STATUS_ROW in ZumbaPanel.jsx).
const STATUS_ROW = {
  active: { label: "Active", classes: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  discontinued: { label: "Inactive", classes: "border-rose-200 bg-rose-50 text-rose-700" },
  leave: { label: "Inactive", classes: "border-amber-200 bg-amber-50 text-amber-700" },
};

/** What the roll below is showing, so the header names the open card rather than
 *  always saying "Customers" over a list that has been narrowed. */
const CARD_TITLES = {
  all: "Customers",
  today: "Today's Session Customers",
};

/** One headline figure, and the filter behind it.
 *
 * The caption underneath is where the qualification goes, so the number itself is never
 * asked to carry a footnote. Each card narrows the roll below to the people it counted —
 * a figure you cannot open is a figure you have to take on trust.
 */
const SummaryCard = ({ label, value, caption, tone, active, onClick, testid }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex-1 rounded-xl border p-4 text-left transition hover:brightness-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${tone} ${active ? "ring-2 ring-current ring-offset-1" : ""}`}
    data-testid={testid}
  >
    <p className="text-[11px] font-bold uppercase tracking-wider opacity-70">{label}</p>
    <p className="mt-1 text-3xl font-extrabold leading-none">{value}</p>
    <p className="mt-1.5 text-[11px] font-medium opacity-70">{caption}</p>
  </button>
);

/**
 * The Zumba master's board: the class they run, at their own branch.
 *
 * Three rows before anything else — the figures, then the search, then the week — so
 * the card filter is the first thing read, the search narrows whichever card is open,
 * and the week picks the day for "Today's". The roll itself sits underneath, which is
 * what the search box searches.
 *
 * The branch is never passed: the server scopes a Zumba account to the branch it was
 * hired into, exactly as it scopes a Branch Admin.
 */
export const ZumbaMasterBoard = () => {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  // Which branch this board is reading, as the server resolved it — an account with no
  // branch of its own falls back to one, and naming it here is how a master can tell.
  const [branch, setBranch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [card, setCard] = useState("all"); // "all" | "today"
  // The day the strip is on. Today to begin with, because the class a master opens this
  // board to check is nearly always the one they are about to teach.
  const [day, setDay] = useState(todayIso);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listZumba();
      setRows(data.registrations || []);
      setSummary(data.summary || {});
      setBranch(data.branch || null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load the class roll");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Who is booked into a given day: the roll on a class day, nobody on any other. A
  // membership books all three evenings, so there is no per-day list beyond that.
  //
  // No longer split by the hour. It used to offer Both / 1st Session / 2nd Session, from
  // when a master could be handed customers out of either — the branch picked the master
  // and picked the time, and the two did not have to agree. A class now belongs to one
  // master, so every customer on this board is in that master's own hour and the tabs
  // divided the roll into itself and nothing.
  const bookedOn = (iso) => (isClassDayIso(iso) ? rows : []);

  const visible = useMemo(() => {
    // Today's card is the whole roll on a class day and nobody on any other day, matching
    // what the figure itself counts: a membership books all three evenings, so there is no
    // per-day list to draw — only a class, or no class. Nor is it split by the hour any
    // more: this board is one master's roll and a master takes one class.
    let list = rows;
    if (card === "today") {
      list = bookedOn(day);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => (r.name || "").toLowerCase().includes(q) || (r.phone || "").includes(q));
  }, [rows, search, card, day]);

  return (
    <div className="flex flex-col gap-4" data-testid="zumba-master-board">
      {/* Row one — the figures. Today's is the one that needs its caption: on a day
          the class does not run it reads zero, and without the caption a zero looks like
          an empty class rather than no class. */}
      <div className="flex flex-col gap-3 sm:flex-row" data-testid="zumba-master-summary">
        {/* One way onto this roll: the branch assigned them to you. */}
        <SummaryCard
          label="All Customers"
          value={summary.all ?? 0}
          caption="Assigned to your class by the branch"
          tone="border-violet-200 bg-violet-50 text-violet-900"
          active={card === "all"}
          onClick={() => setCard("all")}
          testid="zumba-card-all"
        />
        <SummaryCard
          label="Today's Session Customers"
          value={bookedOn(day).length}
          caption={isClassDayIso(day)
            ? (day === todayIso() ? "Booked into today's class" : `Booked into the class on ${shortDate(day)}`)
            : "No class that day — Mon, Wed, Fri"}
          tone="border-sky-200 bg-sky-50 text-sky-900"
          active={card === "today"}
          onClick={() => setCard("today")}
          testid="zumba-card-today"
        />
      </div>

      {/* Row two — find someone. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="zumba-master-toolbar">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer name or phone..."
            className="h-10 pl-9"
            data-testid="zumba-master-search"
          />
        </div>
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="zumba-master-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Row three — the week, as the Physio board draws it: the month over seven days, each carrying
          how many are booked into it, and the arrows stepping a week at a time from beside
          the row they move rather than from up in the label.

          A day with no class carries no number -- the class runs Mon, Wed and Fri, and a
          nought under Tuesday would read as an empty class rather than as no class. */}
      <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2 py-2" data-testid="zumba-master-week">
        <button
          type="button"
          onClick={() => setDay((d) => shiftIso(d, -7))}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100"
          aria-label="Previous week"
          data-testid="zumba-week-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="mb-1 text-center text-[11px] font-semibold text-slate-600" data-testid="zumba-week-month">
            {new Date(`${day}T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
          <div className="grid grid-cols-7 gap-1">
            {weekOf(day).map((iso, i) => {
              const date = Number(iso.split("-")[2]);
              const selected = iso === day;
              const isToday = iso === todayIso();
              const classDay = isClassDayIso(iso);
              const booked = bookedOn(iso).length;
              return (
                <button
                  key={iso}
                  type="button"
                  // Picking a day is asking who is in that class, so it opens the card that
                  // answers that rather than leaving the choice with no visible effect.
                  onClick={() => { setDay(iso); setCard("today"); }}
                  className={`flex flex-col items-center gap-0.5 rounded-lg py-1 transition ${selected ? "bg-sky-600" : classDay ? "hover:bg-slate-50" : "hover:bg-slate-50 opacity-60"}`}
                  title={classDay ? `${booked} booked` : "No class"}
                  data-testid={`zumba-week-day-${iso}`}
                >
                  <span className={`text-[9px] font-semibold ${selected ? "text-sky-100" : "text-slate-400"}`}>{WEEKDAY_INITIALS[i]}</span>
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      selected ? "bg-white/20 text-white" : isToday ? "bg-sky-100 text-sky-700" : "text-slate-600"
                    }`}
                  >
                    {date}
                  </span>
                  {classDay && <span className={`text-[9px] font-medium leading-none ${selected ? "text-sky-100" : "text-slate-400"}`}>{booked}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setDay((d) => shiftIso(d, 7))}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100"
          aria-label="Next week"
          data-testid="zumba-week-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
            <Music className="h-4 w-4 text-violet-600" />
            {CARD_TITLES[card] || "Customers"}
            <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-bold text-slate-500" data-testid="zumba-master-count">{visible.length}</span>
            {branch?.name && (
              <span className="rounded bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700" data-testid="zumba-master-branch">
                {branch.name}
              </span>
            )}
          </div>

          {/* The header is drawn whether or not anybody is on the roll, in the Branch
              Admin's Zumba columns -- the same customer reads the same way on both boards.
              Master, Payment and Action are the branch's: this whole board is one master's
              class, and taking money and editing the record happen at the branch desk. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr className="whitespace-nowrap">
                  <th className="w-[5%] px-3 py-2.5">S.No</th>
                  <th className="w-[17%] px-3 py-2.5">Name</th>
                  <th className="w-[11%] px-3 py-2.5">Mobile</th>
                  <th className="w-[11%] px-3 py-2.5">Package</th>
                  <th className="w-[19%] px-3 py-2.5">Date</th>
                  <th className="w-[8%] px-3 py-2.5">Classes</th>
                  <th className="w-[9%] px-3 py-2.5">Collected</th>
                  <th className="w-[10%] px-3 py-2.5">Due Payment</th>
                  <th className="w-[10%] px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">Loading…</td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400" data-testid="zumba-master-empty">
                      {rows.length === 0
                        ? "Nobody assigned to your class yet. The branch admin assigns customers to a master."
                        : search.trim()
                          ? "Nobody matches that search."
                          : card === "today"
                            ? "No class today. The class runs Mon, Wed and Fri."
                            : "Nobody here yet."}
                    </td>
                  </tr>
                ) : (
                  visible.map((r, i) => {
                    const paid = Number(r.fee_paid || 0);
                    const due = Number(r.fee_amount || 0) - paid;
                    const chip = STATUS_ROW[r.status || "active"] || STATUS_ROW.active;
                    return (
                      <tr key={r.id} className="whitespace-nowrap align-middle hover:bg-slate-50/60" data-testid={`zumba-master-row-${r.id}`}>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-400">{i + 1}</td>
                        <td className="px-3 py-3">
                          <p className="max-w-[12rem] truncate text-sm font-semibold leading-5 text-slate-800" title={r.name}>{r.name || "—"}</p>
                          {/* Which of the two they are in, under the name — on the roll as a
                              whole it is the only place the hour is said at all. */}
                          {r.time_slot ? <p className="text-[11px] text-slate-400">{r.time_slot}</p> : null}
                        </td>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600">{r.phone || "—"}</td>
                        <td className="px-3 py-3">
                          {r.package_name
                            ? <p className="max-w-[9rem] truncate text-xs leading-5 text-slate-600" title={r.package_name}>{r.package_name}</p>
                            : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-3 text-xs leading-5 text-slate-600" data-testid={`zumba-master-finish-${r.id}`}>
                          {shortDate(r.joined_on || r.created_at)} – {r.finish_on ? shortDate(r.finish_on) : "—"}
                        </td>
                        <td className="px-3 py-3">
                          {typeof r.classes_left === "number" ? (
                            <p className={`text-xs leading-5 ${r.renewal_due ? "font-semibold text-amber-600" : "text-slate-600"}`}>
                              {r.classes_left === 0 ? "Term over" : r.classes_left}
                            </p>
                          ) : <span className="text-xs leading-5 text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-xs font-semibold leading-5 text-emerald-700">{rupees(paid)}</p>
                        </td>
                        <td className="px-3 py-3">
                          {due > 0
                            ? <p className="text-xs font-semibold leading-5 text-rose-600">{rupees(due)}</p>
                            : Number(r.fee_amount || 0) > 0
                              ? <p className="text-xs leading-5 text-emerald-600">Paid up</p>
                              : <p className="text-xs leading-5 text-slate-300">—</p>}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${chip.classes}`}>
                            {chip.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
