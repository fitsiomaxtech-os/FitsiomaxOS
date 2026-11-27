import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, CheckCircle2, Clock, X, Search, RefreshCw, ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import { QuickDateFilterBar, QUICK_DATE_PRESETS, intersectDateFilters, quickDatePreset } from "@/components/QuickDateFilterBar";
import { StageTab } from "@/components/ui/stage-tab";
import { PhoneStageTile } from "@/components/ui/phone-stage-grid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PHONE_LEAD_LIST, PhoneLeadCard } from "@/components/ui/phone-lead-card";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { branchReviews, branchSendReview, getAvailableExperts, getAvailableDates } from "@/lib/api";
import { to12h, endTime12h } from "@/lib/time";
import { todayIso } from "@/lib/dateRange";
import { displayPhone } from "@/lib/phone";

// The Send to CONSULTANT popup's time step, as the Appointment popup's: the hour typed in
// three fields and checked against the consultant's day (PreSalesAppointmentDialog).
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "9:05" -> 545. Minutes past midnight, or null if it isn't a clock reading. */
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
};
const clockText = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const shiftName = (mins) => (mins < 12 * 60 ? "Morning" : mins < 17 * 60 ? "Afternoon" : "Evening");
/** The three time fields read as one 24-hour "HH:MM", or "" while any is unreadable. */
const clockOf = ({ h, m, ap }) => {
  const hh = Number(h);
  const mm = Number(m);
  if (String(h).trim() === "" || !Number.isInteger(hh) || hh < 1 || hh > 12) return "";
  if (String(m).trim() === "" || !Number.isInteger(mm) || mm < 0 || mm > 59) return "";
  const h24 = ap === "PM" ? (hh === 12 ? 12 : hh + 12) : hh === 12 ? 0 : hh;
  return `${String(h24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
/** "14:30" -> the three fields. */
const clockFrom = (hhmm) => {
  const mins = minutesOf(hhmm);
  if (mins === null) return { h: "", m: "", ap: "AM" };
  const h24 = Math.floor(mins / 60);
  return { h: String(h24 % 12 === 0 ? 12 : h24 % 12), m: String(mins % 60).padStart(2, "0"), ap: h24 >= 12 ? "PM" : "AM" };
};

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

// The phone toolbar's dropdown, as the Zumba and Fitness lists': tinted while it narrows
// the list, so a range left on is never mistaken for the whole stage.
const PhoneFilterSelect = ({ value, onChange, options, allValue, label, testid }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger
      title={label}
      aria-label={label}
      className={`h-8 min-w-0 flex-1 rounded-md border px-2 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 ${
        value !== allValue ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
      data-testid={testid}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent className="z-[200] max-h-72 border-slate-200" data-testid={`${testid}-menu`}>
      {options.map(([v, text]) => (
        <SelectItem key={v} value={v} className={`text-xs ${v === allValue ? "font-medium text-slate-500" : "text-slate-700"}`}>{text}</SelectItem>
      ))}
    </SelectContent>
  </Select>
);

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
  const [searchOpen, setSearchOpen] = useState(false); // the phone toolbar's search box
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
  const [hpAvail, setHpAvail] = useState({ experts: [], slot_minutes: null, duration_rule: true, loading: false });
  const [sendClock, setSendClockState] = useState({ h: "", m: "", ap: "AM" }); // the typed review time

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
    const startDate = review.review_date || data.today || todayIso();
    const [y, m] = startDate.split("-").map(Number);
    setSendMonth({ y, m: m - 1 });
    setSendClockState(clockFrom(review.review_time || ""));
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
      .then((res) => {
        if (!cancelled) setHpAvail({ experts: res?.experts || [], slot_minutes: res?.slot_minutes || null, duration_rule: res?.duration_rule !== false, loading: false });
      })
      .catch(() => { if (!cancelled) setHpAvail({ experts: [], slot_minutes: null, duration_rule: true, loading: false }); });
    return () => { cancelled = true; };
  }, [sendDraft?.review_date, sendDraft?.review?.id, branchId]);

  const selectedHp = useMemo(
    () => (sendDraft?.head_physio_id ? hpAvail.experts.find((d) => d.id === sendDraft.head_physio_id) : null) || null,
    [hpAvail.experts, sendDraft?.head_physio_id],
  );
  // The Consultant's whole day: open times and the ones a consultation or another review
  // already holds, in clock order.
  const sendSlots = useMemo(() => {
    if (!selectedHp) return [];
    return [
      ...(selectedHp.free_slots || []).map((s) => ({ ...s, booked: false })),
      ...(selectedHp.booked_slots || []).map((s) => ({ ...s, booked: true })),
    ].sort((a, b) => (a.slot_time || a.time || "").localeCompare(b.slot_time || b.time || ""));
  }, [selectedHp]);
  const slotMinutes = hpAvail.slot_minutes || 30;
  const durationRule = hpAvail.duration_rule !== false;
  const dayPublished = (selectedHp?.published_slot_count || 0) > 0;
  // The stretches of the day the Consultant published.
  const dayBlocks = useMemo(() => {
    const published = (selectedHp?.day_blocks || [])
      .map((b) => [minutesOf(b.start), minutesOf(b.end)])
      .filter(([a, b]) => a !== null && b !== null);
    if (published.length) return published;
    const spans = sendSlots
      .map((x) => [minutesOf(x.time), minutesOf(x.time) + (Number(x.duration) || 0)])
      .filter(([a]) => a !== null)
      .sort((a, b) => a[0] - b[0]);
    const blocks = [];
    spans.forEach(([a, b]) => {
      const last = blocks[blocks.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else blocks.push([a, b]);
    });
    return blocks;
  }, [sendSlots, selectedHp]);
  const dayHours = dayBlocks.map(([a, b]) => `${to12h(clockText(a))} – ${to12h(clockText(b))}`).join(" · ");
  // A typed time outside every published stretch: said, not refused.
  const outsideHours = useMemo(() => {
    const t = minutesOf(sendDraft?.review_time);
    if (t === null || dayBlocks.length === 0) return false;
    return !dayBlocks.some(([a, b]) => t >= a && t + slotMinutes <= b);
  }, [sendDraft?.review_time, dayBlocks, slotMinutes]);
  // Whatever already holds the Consultant across the typed hour. Refused, as the server
  // refuses it.
  const clash = useMemo(() => {
    const start = minutesOf(sendDraft?.review_time);
    if (start === null || !durationRule) return null;
    return sendSlots.find((x) => {
      if (!x.booked) return false;
      const t = minutesOf(x.time);
      return t !== null && start < t + (Number(x.duration) || 30) && t < start + slotMinutes;
    }) || null;
  }, [sendDraft?.review_time, sendSlots, slotMinutes, durationRule]);

  const setSendClock = (patch) => {
    const next = { ...sendClock, ...patch };
    setSendClockState(next);
    const hhmm = clockOf(next);
    setSendDraft((d) => ({ ...d, review_time: hhmm, duration: hhmm ? slotMinutes : null }));
  };

  const submitSend = async () => {
    if (!sendDraft.head_physio_id) { toast.error("Pick a CONSULTANT"); return; }
    if (!sendDraft.review_date) { toast.error("Pick a review date"); return; }
    // Half a time typed would otherwise go out as no time at all.
    if (!sendDraft.review_time && (sendClock.h || sendClock.m)) { toast.error("Type the full review time"); return; }
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
  // off-screen.
  //
  // Drawn as Branch Leads' phone card (ui/phone-lead-card, asked 2026-11-27): initials,
  // the name over the phone, the review's status in the orange box where a lead shows its
  // stage. Tapping the card is View, and Send to CONSULTANT and Reassign are in that
  // popup's footer.
  const ReviewCard = ({ r }) => {
    const overdue = r.status === "sent" && r.review_date && r.review_date < (data.today || "");
    const status = overdue ? { label: "Overdue" } : REVIEW_STATUS[r.status];
    return (
      <PhoneLeadCard
        id={r.id}
        name={r.lead_name}
        subLine={[displayPhone(r.phone)]}
        stage={status?.label || "—"}
        onOpen={() => setViewing(r)}
        testid="branch-review-card"
      />
    );
  };

  // A stage picked from the phone's tiles: the same as tapping the desk's tile.
  const openPhoneCard = (key) => {
    setSub(key);
    setDateFilter(null);
  };

  return (
    <div className="space-y-4" data-testid="branch-review-panel">
      {/* Phone: Branch Leads' summary tiles (ui/phone-stage-grid), the three stages
          three across, and the stage's list right below on this same screen (asked
          2026-11-27). */}
      <div className="grid auto-rows-fr grid-cols-3 gap-2 sm:hidden" data-testid="branch-review-phone-cards">
        {SUB_TABS.map((t) => (
          <PhoneStageTile
            key={t.key}
            icon={t.icon}
            label={t.label}
            count={countFor(t.key)}
            active={sub === t.key}
            onClick={() => openPhoneCard(t.key)}
            testid={`branch-review-phone-card-${t.key}`}
          />
        ))}
      </div>

      {/* Phone: the toolbar in one row under the tiles -- search behind an icon, the
          ranges as a dropdown, the calendar, Refresh. Opened, the search box takes the row
          until its close, which also clears it. */}
        <div className="flex items-center gap-1 sm:hidden" data-testid="branch-review-toolbar-phone">
          {searchOpen ? (
            <>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search patient, number, phone…"
                  className="h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-xs text-slate-700 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  autoFocus
                  data-testid="branch-review-search-phone"
                />
              </div>
              <button
                type="button"
                onClick={() => { setSearch(""); setSearchOpen(false); }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500"
                title="Close search"
                aria-label="Close search"
                data-testid="branch-review-search-close-phone"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                title="Search"
                aria-label="Search"
                data-testid="branch-review-search-open-phone"
              >
                <Search className="h-4 w-4" />
              </button>
              <PhoneFilterSelect
                value={quickDate?.key || "all"}
                onChange={(v) => setQuickDate(quickDatePreset(v))}
                options={QUICK_DATE_PRESETS.map((x) => [x.key, x.label])}
                allValue="all"
                label="Dates"
                testid="branch-review-quick-date-phone"
              />
              <span className="flex shrink-0 [&>div>button]:h-8 [&>div>button:first-child]:w-8" title={DATE_FIELD[sub].label}>
                <DateFilterPopover
                  value={dateFilter}
                  onChange={(next) => setDateFilter(next || null)}
                  testid="branch-review-date-filter-phone"
                  placeholder={DATE_FIELD[sub].label}
                  centered
                  iconOnly
                  phoneIconOnly
                />
              </span>
              <button
                type="button"
                onClick={load}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-500 text-white shadow-sm transition hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="branch-review-refresh-phone"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </>
          )}
        </div>

      {/* The Head Physio board's work cards, so both ends of the review chain read the
          same way. These replaced the coloured stage pills the Branch Leads bar uses:
          three permanently tinted pills gave every stage the same shout, and a filled
          orange "Send to Review" read as urgent whether it held two reviews or none.
          Selection is what the colour marks now. Still three across on a phone — they
          fit, and the third was otherwise behind a sideways swipe.

          `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner, matching the Fitness and Zumba strips. "desk": the chevron is
          sm-up only, a phone card is label and figure alone. */}
      <div className="hidden rounded-xl border border-sky-100 bg-gradient-to-r from-sky-50 via-indigo-50 to-violet-50 p-1 shadow-[0_1px_2px_0_rgb(15_23_42/0.04),0_4px_12px_-4px_rgb(99_102_241/0.12)] sm:block" data-testid="branch-review-subtabs">
        <div className="flex flex-nowrap gap-2">
          {SUB_TABS.map((t) => (
            <StageTab
              key={t.key}
              label={t.label}
              count={countFor(t.key)}
              active={sub === t.key}
              onClick={() => { setSub(t.key); setDateFilter(null); }}
              testid={`branch-review-subtab-${t.key}`}
              gridded
              plain
            />
          ))}
        </div>
      </div>

      {/* No Card around this row any more. A bordered input sitting inside a bordered
          card is two rectangles drawing the same edge twice, which is what made the bar
          look boxed-in. The field is now the surface itself.

          The Consultation tab's toolbar, in its order: search, the one-tap ranges, then
          the calendar and Refresh on the right. Everything is h-10 so the preset buttons,
          which are h-10 wherever they appear, sit level with the field beside them. */}
      <div className="hidden items-center gap-2 sm:flex">
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

      <div className="hidden sm:block lg:hidden">
        <QuickDateFilterBar
          value={quickDate}
          onChange={setQuickDate}
          testid="branch-review-quick-date"
          showCustom={false}
          showTomorrow
        />
      </div>

      <div>
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
        <div className={`${PHONE_LEAD_LIST} md:hidden`} data-testid="branch-review-mobile">
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
      </div>

      {/* Send to CONSULTANT — styled and laid out as the Appointment popup
          (PreSalesAppointmentDialog / Branch Leads): one-line header, a card the size of
          what is in it, the date narrowing who is in, the chosen CONSULTANT's day beside
          the typed time. A review is an appointment with a CONSULTANT, so it is booked
          like one. */}
      {sendDraft && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-2 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setSendDraft(null); }}
          data-testid="branch-review-send-modal"
        >
          <div
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl"
            style={{ maxHeight: "calc(100dvh - 2rem)" }}
          >
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 sm:px-5 sm:py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <CalendarIcon className="h-4 w-4 shrink-0 text-sky-600" />
                <p className="shrink-0 truncate text-sm font-semibold text-slate-900">Send to Consultant</p>
                <span className="ml-1 inline-flex min-w-0 items-center rounded-[4px] border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700" data-testid="branch-review-send-chip">
                  <span className="truncate">{sendDraft.review.lead_name} · {sendDraft.review.treatment_days} treatment days</span>
                </span>
              </div>
              <button onClick={() => setSendDraft(null)} className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="branch-review-send-close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              {/* 1 · Date */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[24rem] lg:overflow-y-auto lg:border-b-0 lg:border-r" data-testid="branch-review-date-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">1 · Date</p>
                {(() => {
                  // The clinic's own date, not UTC's.
                  const todayStr = todayIso();
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
                        <h4 className="text-base font-bold text-slate-700">{MONTH_NAMES[sendMonth.m]} {sendMonth.y}</h4>
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
                        {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} className="h-11" />)}
                        {Array.from({ length: daysInMonth }, (_, i) => {
                          const day = i + 1;
                          const dateStr = `${sendMonth.y}-${pad(sendMonth.m + 1)}-${pad(day)}`;
                          const isPast = dateStr < todayStr;
                          const isPicked = sendDraft.review_date === dateStr;
                          const hasSlots = !isPast && (openDates[dateStr] || 0) > 0;
                          return (
                            <button
                              key={day}
                              type="button"
                              disabled={isPast}
                              // Availability is per day, so a new date clears the CONSULTANT and time.
                              onClick={() => {
                                setSendDraft({ ...sendDraft, review_date: dateStr, head_physio_id: "", review_time: "", duration: null });
                                setSendClockState({ h: "", m: "", ap: "AM" });
                              }}
                              className={`h-11 rounded-lg text-base font-semibold transition ${
                                // Today is a light orange whatever else it is; picked, it keeps
                                // the orange and gains a ring.
                                dateStr === todayStr
                                  ? isPicked
                                    ? "bg-orange-100 text-orange-700 shadow-sm ring-2 ring-orange-400"
                                    : "bg-orange-100 text-orange-700 hover:bg-orange-200"
                                  : isPicked
                                    ? "bg-sky-500 text-white shadow-sm ring-2 ring-sky-300"
                                    : isPast
                                      ? "cursor-not-allowed text-slate-300"
                                      : hasSlots
                                        ? "bg-sky-200 text-sky-900 shadow-sm hover:bg-sky-300"
                                        : "text-slate-600 hover:bg-slate-100"
                              }`}
                              title={hasSlots ? "A CONSULTANT is available on this day" : undefined}
                              data-testid={`branch-review-day-${day}`}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-400">
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-200" /> Available</span>
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-sky-500" /> Picked</span>
                        <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded bg-orange-100 ring-1 ring-inset ring-orange-200" /> Today</span>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* 2 · CONSULTANT */}
              <div className="w-full flex-shrink-0 border-b border-slate-200 p-4 sm:p-5 lg:w-[20rem] lg:overflow-y-auto lg:border-b-0 lg:border-r" data-testid="branch-review-hp-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">2 · CONSULTANT</p>
                {!sendDraft.review_date ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Pick a date first.</p>
                ) : hpAvail.loading ? (
                  <p className="text-sm text-slate-400">Checking availability...</p>
                ) : hpAvail.experts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">No CONSULTANT is available on this date.</p>
                ) : (
                  <div className="space-y-1.5">
                    {hpAvail.experts.map((doc) => {
                      const active = sendDraft.head_physio_id === doc.id;
                      const open = doc.published_slot_count || 0;
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => {
                            setSendDraft({ ...sendDraft, head_physio_id: doc.id, review_time: "", duration: null });
                            setSendClockState({ h: "", m: "", ap: "AM" });
                          }}
                          className={`flex h-12 w-full items-center gap-2.5 rounded-[4px] border px-2.5 text-left transition ${active ? "border-sky-500 bg-sky-50" : "border-slate-200 bg-white hover:border-sky-300 hover:bg-slate-50"}`}
                          data-testid={`branch-review-hp-${doc.id}`}
                        >
                          <EmployeeAvatar
                            employee={doc}
                            size={32}
                            fallbackClassName={active ? "bg-sky-600 text-white" : "bg-sky-100 text-sky-700"}
                            className={active ? "ring-2 ring-sky-500" : ""}
                          />
                          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{doc.full_name}</p>
                          <span
                            className={`inline-flex shrink-0 items-center gap-1.5 rounded-[4px] px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                              open > 0 ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"
                            }`}
                          >
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${open > 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
                            {open > 0 ? "Available" : "Not available"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 3 · Time, typed as agreed, checked against the CONSULTANT's day. */}
              <div className="w-full flex-shrink-0 p-4 sm:p-5 lg:flex-1 lg:overflow-y-auto" data-testid="branch-review-slot-panel">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">3 · Time</p>
                {!sendDraft.head_physio_id ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">Select a CONSULTANT to fix the time.</p>
                ) : !dayPublished ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="branch-review-no-slots">
                    <p className="text-sm font-semibold text-amber-800">Not available on this date.</p>
                    <p className="mt-0.5 text-xs text-amber-700">
                      Confirm with the CONSULTANT, then open MANAGEMENT → CONSULTANT CALENDAR and mark the day available.
                    </p>
                  </div>
                ) : (
                  <>
                    {dayBlocks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[4px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800" data-testid="branch-review-available">
                        {dayBlocks.map(([a, b]) => (
                          <span key={a} className="whitespace-nowrap">
                            <b className="font-semibold">{shiftName(a)}</b> · {to12h(clockText(a))} – {to12h(clockText(b))}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-4">
                      <label className="mb-1.5 block text-xs font-semibold text-slate-600" htmlFor="branch-review-hour">Review time</label>
                      <div className="flex items-center gap-2" data-testid="branch-review-time-entry">
                        <input
                          id="branch-review-hour"
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          placeholder="7"
                          value={sendClock.h}
                          onChange={(e) => setSendClock({ h: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                          className="h-12 w-16 rounded-[4px] border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                          data-testid="branch-review-hour"
                        />
                        <span className="text-xl font-bold text-slate-400">:</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          placeholder="15"
                          value={sendClock.m}
                          onChange={(e) => setSendClock({ m: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                          className="h-12 w-16 rounded-[4px] border border-slate-200 text-center text-xl font-bold text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                          data-testid="branch-review-minute"
                        />
                        <div className="ml-1 flex overflow-hidden rounded-[4px] border border-slate-200">
                          {["AM", "PM"].map((half) => (
                            <button
                              key={half}
                              type="button"
                              onClick={() => setSendClock({ ap: half })}
                              className={`px-3 py-2.5 text-sm font-bold transition ${sendClock.ap === half ? "bg-sky-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                              data-testid={`branch-review-${half.toLowerCase()}`}
                            >
                              {half}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400" data-testid="branch-review-slot-summary">
                        {sendDraft.review_time
                          ? <>Booking <b className="font-semibold text-slate-600">{to12h(sendDraft.review_time)}</b>{durationRule ? <> – {endTime12h(sendDraft.review_time, slotMinutes)} · {slotMinutes} minute review.</> : "."}</>
                          : durationRule ? <>{slotMinutes}-minute review.</> : <>Several patients can be booked at the same time.</>}
                      </p>
                    </div>

                    {clash && (
                      <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3" data-testid="branch-review-clash">
                        <p className="text-sm font-semibold text-rose-800">
                          {to12h(sendDraft.review_time)} runs into {to12h(clash.time)}{clash.lead_name ? ` — ${clash.lead_name}` : ""}.
                        </p>
                        <p className="mt-0.5 text-xs text-rose-700">Pick a different time.</p>
                      </div>
                    )}

                    {!clash && outsideHours && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="branch-review-outside-hours">
                        <p className="text-sm font-semibold text-amber-800">{to12h(sendDraft.review_time)} is outside the hours published for this day.</p>
                        {dayHours && <p className="mt-0.5 text-xs text-amber-700">{selectedHp?.full_name} is down for {dayHours}.</p>}
                      </div>
                    )}

                    {/* The day as it already stands, so the desk can see what is free. */}
                    {sendSlots.some((x) => x.booked) && (
                      <div className="mt-4" data-testid="branch-review-booked-list">
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Already booked this day</p>
                        <ol className="divide-y divide-slate-200 overflow-hidden rounded-[4px] border border-slate-200 bg-slate-50">
                          {sendSlots.filter((x) => x.booked).map((x, i) => (
                            <li key={`${x.slot_time}-${x.review_id || x.lead_id || i}`} className="flex items-center gap-2 px-3 py-2">
                              <span className="w-5 shrink-0 text-xs font-bold text-slate-400">{i + 1}.</span>
                              <span className="shrink-0 text-sm font-bold text-slate-600">
                                {to12h(x.time)}{durationRule ? ` – ${endTime12h(x.time, Number(x.duration) || slotMinutes)}` : ""}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
                                {(x.lead_name || "").trim() || "Booked"}
                                {x.review_id && <span className="ml-1 text-[11px] font-semibold text-slate-400">· Review</span>}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </>
                )}

                <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-semibold text-slate-600" htmlFor="branch-review-notes">Notes</label>
                  <textarea
                    id="branch-review-notes"
                    rows={3}
                    className="w-full rounded-[4px] border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                    placeholder="Optional notes for the CONSULTANT..."
                    value={sendDraft.notes}
                    onChange={(e) => setSendDraft({ ...sendDraft, notes: e.target.value })}
                    data-testid="branch-review-notes"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2 sm:px-5 sm:py-2.5">
              <Button variant="outline" size="sm" onClick={() => setSendDraft(null)} data-testid="branch-review-send-cancel">Cancel</Button>
              <Button
                size="sm"
                className="bg-sky-600 text-white hover:bg-sky-700"
                onClick={submitSend}
                disabled={sending || !sendDraft.head_physio_id || !!clash}
                data-testid="branch-review-send-submit"
              >
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
                <p className="text-xs text-slate-500">{viewing.patient_number || "—"} · {displayPhone(viewing.phone) || "—"}</p>
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
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
              {/* The row's Send and Reassign, here since the phone's rows lost their
                  buttons (2026-11-27). */}
              {viewing.status === "send_to_review" ? (
                <Button className="bg-amber-600 text-white hover:bg-amber-700" onClick={() => { const r = viewing; setViewing(null); openSend(r); }} data-testid="branch-review-view-send">
                  <Send className="mr-1.5 h-3.5 w-3.5" /> Send to CONSULTANT
                </Button>
              ) : viewing.status === "sent" ? (
                <Button variant="outline" onClick={() => { const r = viewing; setViewing(null); openSend(r); }} data-testid="branch-review-view-reassign">
                  Reassign
                </Button>
              ) : null}
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
