import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, CheckCircle2, Clock, X, Search, RefreshCw, ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, intersectDateFilters, quickDatePreset } from "@/components/QuickDateFilterBar";
import { StatTile } from "@/components/ui/stat-tile";
import { LeadRowCard } from "@/components/ui/lead-row-card";
import { branchReviews, branchSendReview, getAvailableExperts, getAvailableDates } from "@/lib/api";
import { to12h, endTime12h } from "@/lib/time";
import { waNumber } from "@/lib/phone";

// Three views onto one pipeline: waiting to be sent, sent and still outstanding, done.
// Each row already names the Head Physio it went to, so the branch can see who has what
// without a separate view for it.
const SUB_TABS = [
  { key: "send", label: "Send to Review", icon: Send, color: "#d97706" },
  { key: "pending", label: "Pending Review", icon: Clock, color: "#0284c7" },
  { key: "complete", label: "Review Complete", icon: CheckCircle2, color: "#059669" },
];

// A review's status as its phone card's badge, in its sub-tab's own colour. Overdue, a
// sent review past its date, is worked out per row and shown over this.
const REVIEW_STATUS = {
  send_to_review: { label: "Send to Review", color: "#d97706" },
  sent: { label: "Pending", color: "#0284c7" },
  completed: { label: "Completed", color: "#059669" },
};

/**
 * The date a review means on each tab, and what to call it.
 *
 * One filter, three meanings — which is right, because the tabs are three stages of one
 * review and a stage's date is the thing that happened at it. Filtering a review waiting to
 * be sent by the date it is due with a Head Physio would filter on a date it does not have
 * yet, and every row would vanish.
 */
const DATE_FIELD = {
  send: { label: "Raised On", of: (r) => (r.raised_at || "").slice(0, 10) },
  pending: { label: "Review Date", of: (r) => (r.review_date || "").slice(0, 10) },
  complete: { label: "Completed On", of: (r) => (r.completed_at || r.review_date || "").slice(0, 10) },
};

// "2026-09-29" read as local midnight. new Date("2026-09-29") is UTC midnight, which
// in IST lands at 05:30 and in any zone west of UTC on the previous day.
const localDay = (iso) => {
  const [y, m, d] = (iso || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

const inDateFilter = (iso, f) => {
  if (!f || (!f.from && !f.to)) return true;
  const day = localDay(iso);
  if (!day) return false;
  return (!f.from || day >= f.from) && (!f.to || day <= f.to);
};

const dmy = (d) => {
  if (!d) return "—";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  return y && m && day ? `${day} - ${m} - ${y}` : d;
};

const Empty = ({ children }) => (
  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-12 text-center text-sm text-slate-400">{children}</p>
);

/**
 * Branch Admin > Review — the middle link in the post-treatment review chain. A Physio
 * raises a review once a patient has been through a week of treatment; this is where the
 * Branch Admin puts it in front of a named Head Physio for a date, and watches it through
 * to done.
 */
export const BranchReviewPanel = ({ branchId }) => {
  const [sub, setSub] = useState("send");
  const [data, setData] = useState({ reviews: [], counts: {}, head_physios: [], today: "" });
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  // Two date controls over one list, same as the Consultation tab: the one-tap ranges,
  // and the calendar for everything else. The list is their overlap.
  // The ranges survive a tab change -- "This Week" is a question worth asking of every
  // stage, and the lit button says it is on. The calendar pick is cleared: an exact day
  // chosen as a Raised On date means nothing as a Completed On one.
  // Opens on Today: the day's reviews are what the desk comes here for. All is one tap away.
  const [quickDate, setQuickDate] = useState(() => quickDatePreset("today"));
  const [dateFilter, setDateFilter] = useState(null);
  const effectiveDateFilter = useMemo(() => intersectDateFilters(dateFilter, quickDate), [dateFilter, quickDate]);
  const [sendDraft, setSendDraft] = useState(null); // { review, head_physio_id, review_date, review_time, duration, notes }
  const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState(null);
  // Booking flow state, mirroring the Appointment popup: which month the calendar is on,
  // which days that month have a free slot, and who is free on the picked day.
  const [sendMonth, setSendMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [openDates, setOpenDates] = useState({});
  const [hpAvail, setHpAvail] = useState({ experts: [], loading: false });

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try { setData(await branchReviews(branchId)); }
    catch { setData({ reviews: [], counts: {}, head_physios: [], today: "" }); }
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const counts = data.counts || {};
  const countFor = (key) => (
    key === "send" ? counts.send_to_review
      : key === "pending" ? counts.sent
      : counts.completed
  ) || 0;

  const rows = useMemo(() => {
    const all = data.reviews || [];
    let list = sub === "send" ? all.filter((r) => r.status === "send_to_review")
      : sub === "pending" ? all.filter((r) => r.status === "sent")
      : all.filter((r) => r.status === "completed");
    if (effectiveDateFilter) {
      const of = DATE_FIELD[sub].of;
      list = list.filter((r) => inDateFilter(of(r), effectiveDateFilter));
    }
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter((r) =>
      (r.lead_name || "").toLowerCase().includes(q)
      || (r.patient_number || "").toLowerCase().includes(q)
      || (r.phone || "").includes(q)
      || (r.head_physio_name || "").toLowerCase().includes(q));
  }, [data.reviews, sub, search, effectiveDateFilter]);

  const openSend = (review) => {
    const startDate = review.review_date || data.today || new Date().toISOString().slice(0, 10);
    const [y, m] = startDate.split("-").map(Number);
    setSendMonth({ y, m: m - 1 });
    setSendDraft({
      review,
      head_physio_id: review.head_physio_id || "",
      review_date: startDate,
      review_time: review.review_time || "",
      duration: review.review_duration || null,
      notes: review.branch_notes || "",
    });
  };

  // Which days of the shown month have a Head Physio slot free, refreshed as the popup
  // pages between months.
  useEffect(() => {
    if (!sendDraft || !branchId) return;
    const month = `${sendMonth.y}-${String(sendMonth.m + 1).padStart(2, "0")}`;
    let cancelled = false;
    getAvailableDates(branchId, month, undefined, sendDraft.review?.id)
      .then((res) => { if (!cancelled) setOpenDates(res?.dates || {}); })
      .catch(() => { if (!cancelled) setOpenDates({}); });
    return () => { cancelled = true; };
  }, [sendDraft ? true : false, sendDraft?.review?.id, sendMonth.y, sendMonth.m, branchId]);

  // Head Physios free on the picked date, each carrying their own open times — so
  // choosing one reveals their slots without a second request.
  useEffect(() => {
    if (!sendDraft?.review_date || !branchId) return;
    let cancelled = false;
    setHpAvail((p) => ({ ...p, loading: true }));
    getAvailableExperts(branchId, sendDraft.review_date, undefined, undefined, sendDraft.review?.id)
      .then((res) => { if (!cancelled) setHpAvail({ experts: res?.experts || [], loading: false }); })
      .catch(() => { if (!cancelled) setHpAvail({ experts: [], loading: false }); });
    return () => { cancelled = true; };
  }, [sendDraft?.review_date, sendDraft?.review?.id, branchId]);

  // The Consultant's whole day: open times, and the ones a consultation or another review
  // already holds, marked as booked so the Branch Admin sees why they cannot be picked.
  const sendSlots = useMemo(() => {
    if (!sendDraft?.head_physio_id) return [];
    const doc = hpAvail.experts.find((d) => d.id === sendDraft.head_physio_id);
    if (!doc) return [];
    return [
      ...(doc.free_slots || []),
      ...(doc.booked_slots || []).map((s) => ({ ...s, booked: true })),
    ].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }, [hpAvail.experts, sendDraft?.head_physio_id]);

  const submitSend = async () => {
    if (!sendDraft.head_physio_id) { toast.error("Pick a CONSULTANT"); return; }
    if (!sendDraft.review_date) { toast.error("Pick a review date"); return; }
    setSending(true);
    try {
      await branchSendReview(sendDraft.review.id, {
        head_physio_id: sendDraft.head_physio_id,
        review_date: sendDraft.review_date,
        review_time: sendDraft.review_time || null,
        review_duration: sendDraft.duration || null,
        notes: sendDraft.notes || null,
      });
      toast.success("Review sent to the CONSULTANT");
      setSendDraft(null);
      await load();
      setSub("pending");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to send the review");
    }
    setSending(false);
  };

  const ReviewRow = ({ r, index }) => {
    const overdue = r.status === "sent" && r.review_date && r.review_date < (data.today || "");
    return (
      <tr className="transition-colors hover:bg-slate-50" data-testid={`branch-review-row-${r.id}`}>
        <td className="px-4 py-3 align-middle text-slate-400">{index + 1}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle font-medium text-slate-800">{r.lead_name}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle font-mono text-xs text-slate-500">{r.patient_number || "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle text-slate-600">{r.physio_name || "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle font-medium text-violet-700">{r.head_physio_name || "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle text-slate-600">{r.session_package_name || "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 align-middle text-slate-600">{r.review_number || "—"}</td>
        <td className={`whitespace-nowrap px-4 py-3 align-middle ${overdue ? "font-semibold text-rose-600" : "text-slate-600"}`}>
          {r.review_date ? `${dmy(r.review_date)}${r.review_time ? ` · ${to12h(r.review_time)}` : ""}` : "—"}
          {overdue && <span className="ml-2 rounded-md bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">OVERDUE</span>}
        </td>
        <td className="whitespace-nowrap px-4 py-3 align-middle">
          <div className="flex items-center justify-end gap-2">
            {r.status === "send_to_review" ? (
              <Button size="sm" className="bg-amber-600 text-xs text-white hover:bg-amber-700" onClick={() => openSend(r)} data-testid={`branch-review-send-${r.id}`}>
                <Send className="mr-1.5 h-3.5 w-3.5" /> Send to CONSULTANT
              </Button>
            ) : r.status === "sent" ? (
              <Button size="sm" variant="outline" className="text-xs" onClick={() => openSend(r)} data-testid={`branch-review-reassign-${r.id}`}>
                Reassign
              </Button>
            ) : null}
            <button type="button" onClick={() => setViewing(r)} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800" title="View details" aria-label="View details" data-testid={`branch-review-view-${r.id}`}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  // Same row as a card, for phones. Seven columns can't hold their width there — the
  // table scrolled sideways and left Physio, Weeks, the Send button and View all
  // off-screen, so the one thing this tab exists to do couldn't be reached.
  //
  // Drawn as the one-row card Branch Leads, Consultation and House Visit use (see
  // ui/lead-row-card): the review's status where they show a stage, Call and WhatsApp
  // beside the numbers. Tapping the card is View, as tapping a lead opens it; Send and
  // Reassign stay a button of their own under the details, since sending is the thing
  // this tab is for.
  const ReviewCard = ({ r }) => {
    const overdue = r.status === "sent" && r.review_date && r.review_date < (data.today || "");
    const status = overdue ? { label: "Overdue", color: "#e11d48" } : REVIEW_STATUS[r.status];
    // A button inside the card: its own click and key presses must not also open View.
    const own = (fn) => ({
      onClick: (e) => { e.stopPropagation(); fn(); },
      onKeyDown: (e) => e.stopPropagation(),
    });
    return (
      <LeadRowCard
        id={r.id}
        name={r.lead_name}
        badge={status?.label}
        badgeColor={status?.color}
        idLine={[r.patient_number, r.phone || "—"]}
        wa={waNumber(r.phone)}
        onOpen={() => setViewing(r)}
        testid="branch-review-card"
        details={(
          <>
            <p className="truncate text-[11px] text-slate-500">
              <span className="font-semibold text-slate-700">{r.treatment_days} treatment days</span>
              {r.session_package_name && <> · {r.session_package_name}</>}
            </p>
            <p className="truncate text-[10px] text-slate-400">Physio: {r.physio_name || "—"}</p>
            {sub !== "send" && (
              <p className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
                <CalendarIcon className={`h-3 w-3 ${overdue ? "text-rose-500" : "text-slate-400"}`} />
                <span className={`font-semibold ${overdue ? "text-rose-600" : "text-slate-700"}`}>
                  {dmy(r.review_date)}{r.review_time ? ` · ${to12h(r.review_time)}` : ""}
                </span>
                <span className="truncate font-medium text-violet-700">{r.head_physio_name || "—"}</span>
              </p>
            )}
            {r.reason && <p className="text-[10px] text-slate-400">{r.reason}</p>}
            {r.status === "send_to_review" ? (
              <div className="pt-1.5">
                <Button size="sm" className="bg-amber-600 text-xs text-white hover:bg-amber-700" {...own(() => openSend(r))} data-testid={`branch-review-card-send-${r.id}`}>
                  <Send className="mr-1.5 h-3.5 w-3.5" /> Send to CONSULTANT
                </Button>
              </div>
            ) : r.status === "sent" ? (
              <div className="pt-1.5">
                <Button size="sm" variant="outline" className="text-xs" {...own(() => openSend(r))} data-testid={`branch-review-card-reassign-${r.id}`}>
                  Reassign
                </Button>
              </div>
            ) : null}
          </>
        )}
      />
    );
  };

  return (
    <div className="space-y-4" data-testid="branch-review-panel">
      {/* The Head Physio board's work cards, so both ends of the review chain read the
          same way. These replaced the coloured stage pills the Branch Leads bar uses:
          three permanently tinted pills gave every stage the same shout, and a filled
          orange "Send to Review" read as urgent whether it held two reviews or none.
          Selection is what the colour marks now. Still three across on a phone — they
          fit, and the third was otherwise behind a sideways swipe.

          `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness and Zumba strips. "desk": the chevron is
          sm-up only, a phone card is label and figure alone. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="branch-review-subtabs">
        {SUB_TABS.map((t) => (
          <StatTile
            key={t.key}
            label={t.label}
            value={countFor(t.key)}
            arrow="desk"
            color={t.color}
            active={sub === t.key}
            onClick={() => { setSub(t.key); setDateFilter(null); }}
            testid={`branch-review-subtab-${t.key}`}
          />
        ))}
      </div>

      {/* No Card around this row any more. A bordered input sitting inside a bordered
          card is two rectangles drawing the same edge twice, which is what made the bar
          look boxed-in. The field is now the surface itself.

          The Consultation tab's toolbar, in its order: search, the one-tap ranges, then
          the calendar and Refresh on the right. Everything is h-10 so the preset buttons,
          which are h-10 wherever they appear, sit level with the field beside them. */}
      <div className="flex items-center gap-2">
        <div className="group relative min-w-0 flex-1 lg:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-sky-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, number, phone or CONSULTANT..."
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-10 text-sm text-slate-700 shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            data-testid="branch-review-search"
          />
          {/* Clearing a search by backspacing a long phrase is needless work. */}
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              data-testid="branch-review-search-clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {/* In the toolbar from lg; below that the same row stands on its own line under
            it, as on the Consultation tab. Tomorrow is shown because Pending Review is
            read by review date, which is a booking and can be tomorrow's. */}
        <div className="hidden shrink-0 lg:block">
          <QuickDateFilterBar
            value={quickDate}
            onChange={setQuickDate}
            testid="branch-review-quick-date-inline"
            inline
            showCustom={false}
            showTomorrow
          />
        </div>
        {/* The calendar for everything the ranges don't cover — Yesterday, Last Month, an
            exact day, a typed range. Centred rather than anchored: this sits directly
            above the table, where a panel hanging off the button opens over the rows and
            is clipped by the scroll. Which date it reads is the tab's (DATE_FIELD). */}
        <div className="ml-auto flex shrink-0 items-center gap-2" title={DATE_FIELD[sub].label}>
          <DateFilterPopover
            value={dateFilter}
            onChange={(next) => setDateFilter(next || null)}
            testid="branch-review-date-filter"
            placeholder={DATE_FIELD[sub].label}
            centered
            iconOnly
            phoneIconOnly
          />
          {/* Grey and icon-only at every width, matching the Refresh on Branch Leads and
              the Consultant board. It was a labelled sky button here, then an orange one,
              both of which read as something to act on sitting beside the date; refreshing
              is the least interesting thing on the row and is coloured accordingly. The
              word lives on title/aria-label. */}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-500 text-white shadow-sm transition hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="branch-review-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="lg:hidden">
        <QuickDateFilterBar
          value={quickDate}
          onChange={setQuickDate}
          testid="branch-review-quick-date"
          showCustom={false}
          showTomorrow
        />
      </div>

      {loading && rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading reviews...</p>
      ) : rows.length === 0 ? (
        <Empty>
          {sub === "send" ? "No reviews waiting to be sent. A Physio raises one once a patient has completed 7 days of treatment."
            : sub === "pending" ? "Nothing pending — every review sent out has been written."
            : "No completed reviews yet."}
        </Empty>
      ) : (
        <>
        <div className="space-y-2 md:hidden" data-testid="branch-review-mobile">
          {rows.map((r) => <ReviewCard key={r.id} r={r} />)}
        </div>

        <div className="hidden overflow-auto rounded-xl border border-slate-200 bg-white md:block">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="w-12 px-4 py-2.5">S.No</th>
                <th className="px-4 py-2.5">Patient</th>
                <th className="whitespace-nowrap px-4 py-2.5">UPN</th>
                <th className="whitespace-nowrap px-4 py-2.5">Physio</th>
                <th className="whitespace-nowrap px-4 py-2.5">Consultant</th>
                <th className="whitespace-nowrap px-4 py-2.5">Total Weeks</th>
                <th className="whitespace-nowrap px-4 py-2.5">Review Counts</th>
                <th className="whitespace-nowrap px-4 py-2.5">Review Date</th>
                <th className="whitespace-nowrap px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => <ReviewRow key={r.id} r={r} index={i} />)}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* Send to Head Physio — the same three-step booking the Appointment popup uses:
          the date narrows who's free, the chosen Head Physio narrows which times exist.
          A review is an appointment with a Head Physio, so it's booked like one rather
          than typed into a bare date field. */}
      {sendDraft && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" data-testid="branch-review-send-modal">
          <div className="flex h-[calc(100vh-1rem)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-100 px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <CalendarIcon className="h-6 w-6 shrink-0 text-slate-500" />
                <div className="min-w-0">
                  <p className="text-lg font-bold text-slate-800">Send to CONSULTANT</p>
                  <p className="truncate text-xs text-slate-500">
                    {sendDraft.review.lead_name} · {sendDraft.review.treatment_days} treatment days · pick a date, then the CONSULTANT, then their time
                  </p>
                </div>
              </div>
              <button onClick={() => setSendDraft(null)} className="shrink-0 rounded-lg border-2 border-orange-200 bg-orange-100 p-2 text-orange-600 transition hover:border-orange-300 hover:bg-orange-200" data-testid="branch-review-send-close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              {/* STEP 1 — Date */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-6 lg:w-[28rem] lg:border-b-0 lg:border-r lg:overflow-y-auto" data-testid="branch-review-date-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">1 · Date</p>
                {(() => {
                  const todayStr = new Date().toISOString().slice(0, 10);
                  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                  const firstDow = new Date(sendMonth.y, sendMonth.m, 1).getDay();
                  const daysInMonth = new Date(sendMonth.y, sendMonth.m + 1, 0).getDate();
                  const pad = (n) => String(n).padStart(2, "0");
                  const stepMonth = (delta) => setSendMonth(({ y, m }) => {
                    const d = new Date(y, m + delta, 1);
                    return { y: d.getFullYear(), m: d.getMonth() };
                  });
                  return (
                    <>
                      <div className="mb-3 flex items-center justify-between">
                        <button type="button" onClick={() => stepMonth(-1)} className="rounded p-1 hover:bg-slate-100" data-testid="branch-review-prev-month">
                          <ChevronLeft className="h-5 w-5 text-slate-500" />
                        </button>
                        <h4 className="text-base font-bold text-slate-700">{monthNames[sendMonth.m]} {sendMonth.y}</h4>
                        <button type="button" onClick={() => stepMonth(1)} className="rounded p-1 hover:bg-slate-100" data-testid="branch-review-next-month">
                          <ChevronRight className="h-5 w-5 text-slate-500" />
                        </button>
                      </div>
                      <div className="mb-1 grid grid-cols-7 gap-1">
                        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                          <div key={d} className="py-1 text-center text-xs font-semibold text-slate-400">{d}</div>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} className="h-14" />)}
                        {Array.from({ length: daysInMonth }, (_, i) => {
                          const day = i + 1;
                          const dateStr = `${sendMonth.y}-${pad(sendMonth.m + 1)}-${pad(day)}`;
                          const isPast = dateStr < todayStr;
                          const isPicked = sendDraft.review_date === dateStr;
                          const isToday = dateStr === todayStr;
                          const openSlots = openDates[dateStr] || 0;
                          const hasSlots = !isPast && openSlots > 0;
                          return (
                            <button
                              key={day}
                              type="button"
                              disabled={isPast}
                              // Availability is per-day, so a new date drops the Head Physio
                              // and slot chosen under the old one.
                              onClick={() => setSendDraft({ ...sendDraft, review_date: dateStr, head_physio_id: "", review_time: "", duration: null })}
                              className={`h-14 rounded-lg text-lg font-semibold transition ${
                                isPicked
                                  ? "bg-teal-600 text-white shadow-sm ring-2 ring-teal-200"
                                  : isPast
                                  ? "cursor-not-allowed text-slate-300"
                                  : hasSlots
                                  ? "bg-violet-300 text-white shadow-sm hover:bg-violet-400"
                                  : isToday
                                  ? "border border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100"
                                  : "text-slate-600 hover:bg-slate-100"
                              }`}
                              title={hasSlots ? `${openSlots} slot${openSlots === 1 ? "" : "s"} open` : undefined}
                              data-testid={`branch-review-day-${day}`}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-400">
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-violet-300" /> Slots open</span>
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-teal-600" /> Picked</span>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* STEP 2 — Head Physio */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-5 lg:w-[22rem] lg:border-b-0 lg:border-r lg:overflow-y-auto" data-testid="branch-review-hp-panel">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">2 · CONSULTANT</p>
                <p className="mb-3 text-xs text-slate-400">Only those with availability on the picked date.</p>
                {!sendDraft.review_date ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Pick a date first.</p>
                ) : hpAvail.loading ? (
                  <p className="text-sm text-slate-400">Checking availability...</p>
                ) : hpAvail.experts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">No CONSULTANT is available on this date.</p>
                ) : (
                  <div className="space-y-2">
                    {hpAvail.experts.map((doc) => {
                      const active = sendDraft.head_physio_id === doc.id;
                      const open = (doc.free_slots || []).length;
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => setSendDraft({ ...sendDraft, head_physio_id: doc.id, review_time: "", duration: null })}
                          className={`flex w-full items-center gap-3 rounded-lg border-2 p-3.5 text-left transition ${active ? "border-teal-500 bg-teal-50 shadow-sm" : "border-slate-200 bg-white hover:border-teal-300 hover:bg-slate-50"}`}
                          data-testid={`branch-review-hp-${doc.id}`}
                        >
                          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-bold ${active ? "bg-teal-600 text-white" : "bg-teal-100 text-teal-700"}`}>
                            {doc.full_name?.charAt(0) || "H"}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-slate-800">{doc.full_name}</p>
                            <p className={`truncate text-xs ${open > 0 ? "text-slate-400" : "text-amber-600"}`}>
                              {open > 0 ? `${open} slot${open === 1 ? "" : "s"} open` : "Nothing published"}
                            </p>
                          </div>
                          {active && <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-teal-600" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* STEP 3 — Time slot, from what the Head Physio actually published. */}
              <div className="w-full flex-shrink-0 p-4 sm:p-5 lg:flex-1 lg:overflow-y-auto" data-testid="branch-review-slot-panel">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">3 · Time Slot</p>
                <p className="mb-3 text-xs text-slate-400">Published availability only.</p>
                {!sendDraft.head_physio_id ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Select a CONSULTANT to see their available times.</p>
                ) : sendSlots.length === 0 ? (
                  <div className="rounded-lg border-2 border-amber-200 bg-amber-50 px-4 py-3" data-testid="branch-review-no-slots">
                    <p className="text-sm font-semibold text-amber-800">No availability published for this date.</p>
                    <p className="mt-0.5 text-xs text-amber-700">
                      Confirm with the CONSULTANT, then open MANAGEMENT → CONSULTANT CALENDAR and mark them available.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="branch-review-slots">
                    {sendSlots.map((s) => {
                      if (s.booked) {
                        return (
                          <div
                            key={`booked-${s.slot_time}`}
                            className="cursor-not-allowed rounded-lg border-2 border-rose-200 bg-rose-50 px-2 py-2.5 text-center text-rose-700"
                            title={s.lead_name ? `Booked for ${s.lead_name}` : "Booked"}
                            data-testid={`branch-review-slot-booked-${s.time}`}
                          >
                            <span className="block text-base font-bold line-through decoration-rose-300">{to12h(s.time)}</span>
                            <span className="block truncate text-[11px] font-semibold">Booked{s.lead_name ? ` · ${s.lead_name}` : ""}</span>
                          </div>
                        );
                      }
                      const active = sendDraft.review_time === s.time;
                      return (
                        <button
                          key={s.slot_time}
                          type="button"
                          onClick={() => setSendDraft({ ...sendDraft, review_time: s.time, duration: s.duration })}
                          className={`rounded-lg border-2 px-2 py-2.5 text-center transition ${active ? "border-teal-500 bg-teal-50 text-teal-700 shadow-sm ring-2 ring-teal-100" : "border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:bg-slate-50"}`}
                          data-testid={`branch-review-slot-${s.time}`}
                        >
                          <span className="block text-base font-bold">{to12h(s.time)}</span>
                          <span className="block text-[11px] text-slate-400">{s.duration} min</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {sendDraft.review_time && sendDraft.duration && (
                  <p className="mt-4 rounded-lg border-2 border-teal-300 bg-teal-50 px-4 py-2.5 text-sm font-bold text-teal-700" data-testid="branch-review-slot-summary">
                    {to12h(sendDraft.review_time)} – {endTime12h(sendDraft.review_time, sendDraft.duration)} · {sendDraft.duration} minute review
                  </p>
                )}

                {sendDraft.review.physio_notes && (
                  <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Physio's Notes</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{sendDraft.review.physio_notes}</p>
                  </div>
                )}

                <div className="mt-5">
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-400">Notes</label>
                  <textarea
                    rows={3}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
                    placeholder="Optional notes for the CONSULTANT..."
                    value={sendDraft.notes}
                    onChange={(e) => setSendDraft({ ...sendDraft, notes: e.target.value })}
                    data-testid="branch-review-notes"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-100 px-6 py-3.5">
              <Button variant="outline" onClick={() => setSendDraft(null)} data-testid="branch-review-send-cancel">Cancel</Button>
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={submitSend} disabled={sending || !sendDraft.head_physio_id} data-testid="branch-review-send-submit">
                {sending ? "Sending..." : "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Read-only detail */}
      {viewing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" data-testid="branch-review-view-modal">
          <div className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
              <div className="min-w-0">
                <p className="truncate text-lg font-bold text-slate-800">{viewing.lead_name}</p>
                <p className="text-xs text-slate-500">{viewing.patient_number || "—"} · {viewing.phone || "—"}</p>
              </div>
              <button onClick={() => setViewing(null)} className="shrink-0 rounded-lg border-2 border-orange-200 bg-orange-100 p-2 text-orange-600 hover:bg-orange-200" data-testid="branch-review-view-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  ["Status", viewing.status === "send_to_review" ? "Waiting to be sent" : viewing.status === "sent" ? "With the CONSULTANT" : "Completed"],
                  ["Treatment Days", `${viewing.treatment_days}`],
                  ["Package", viewing.session_package_name || "—"],
                  ["Raised By", `${viewing.physio_name || "—"} · ${dmy(viewing.raised_at)}`],
                  ["CONSULTANT", viewing.head_physio_name || "Not sent yet"],
                  ["Review Date", dmy(viewing.review_date)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-slate-200 px-3 py-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{k}</p>
                    <p className="mt-0.5 break-words font-semibold text-slate-700">{v}</p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {viewing.reason && <Block label="Reason" text={viewing.reason} />}
                {viewing.physio_notes && <Block label="Physio's Notes" text={viewing.physio_notes} />}
                {viewing.head_physio_notes && <Block label="CONSULTANT's Review" text={viewing.head_physio_notes} tone="emerald" />}
                {viewing.head_physio_suggestions && <Block label="Suggestions" text={viewing.head_physio_suggestions} tone="emerald" />}
              </div>
            </div>
            <div className="flex justify-end border-t border-slate-200 bg-slate-50 px-6 py-3.5">
              <Button variant="outline" onClick={() => setViewing(null)} data-testid="branch-review-view-done">Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Block = ({ label, text, tone }) => (
  <div className={`rounded-lg border p-3 ${tone === "emerald" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
    <p className={`text-[11px] font-bold uppercase tracking-wider ${tone === "emerald" ? "text-emerald-600" : "text-slate-400"}`}>{label}</p>
    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{text}</p>
  </div>
);

export default BranchReviewPanel;
