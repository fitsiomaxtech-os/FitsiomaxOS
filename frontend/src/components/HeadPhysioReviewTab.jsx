import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, AlertTriangle, ChevronDown, ChevronRight, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { hpReviews, hpCompleteReview, hpLeadWeekReviews, physioSessions } from "@/lib/api";
import { to12h } from "@/lib/time";
import { LeadDocuments } from "@/components/LeadDocuments";
import { PhysioTreatmentChips } from "@/components/ui/physio-treatment-chips";
import { displayPhone } from "@/lib/phone";

// Treatment days per review — calendar days the patient attended on, which is what the
// treatment_days a review carries counts. Mirrors REVIEW_AFTER_DAYS in
// backend/routers/v3_reviews.py, which is what decides when a review is raised; this only
// decides how many days the write-up shows behind it. Move it if that one moves.
const REVIEW_EVERY = 7;

const dmy = (d) => {
  if (!d) return "—";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  return y && m && day ? `${day} - ${m} - ${y}` : d;
};

/**
 * Where a review stands, worked out once and used by both the table and the phone cards so
 * the two cannot disagree about what is overdue.
 *
 * Order matters: written is written, whatever its date. A completed review dated last week
 * is not overdue — it is done, and colouring it red would send someone chasing it.
 */
const stageOf = (r, todayDate) => {
  if (r.status === "completed") {
    return { key: "completed", label: "Completed", done: true, badge: "border-emerald-200 bg-emerald-50 text-emerald-700", card: "border-slate-200" };
  }
  if (r.review_date && todayDate && r.review_date < todayDate) {
    return { key: "overdue", label: "Overdue", done: false, badge: "border-rose-200 bg-rose-50 text-rose-700", card: "border-rose-300", warn: true };
  }
  if (r.review_date === todayDate) {
    return { key: "today", label: "Today", done: false, badge: "border-sky-200 bg-sky-50 text-sky-700", card: "border-sky-300" };
  }
  return { key: "upcoming", label: "Upcoming", done: false, badge: "border-slate-200 bg-slate-50 text-slate-600", card: "border-slate-200" };
};

// The client's stars for the week this review covers (client_rating from the server),
// or a dash while they haven't rated it.
const StarRating = ({ value, testid }) => (
  value ? (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700" data-testid={testid}>
      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
      {value}
    </span>
  ) : <span className="text-slate-300">—</span>
);

/**
 * One week's reviews, read back: the client's weekly review form (stars and Treatment
 * Feedback) and the Consultant's review of that week. Shared by the Write Review tab and
 * each week on Treatment Days, so a week reads the same wherever it is opened.
 */
const WeekReviewCard = ({ week, clinical, client, current }) => {
  const done = clinical?.status === "completed";
  return (
    <div className={`rounded-lg border p-3 ${current ? "border-sky-200 bg-sky-50/40" : "border-slate-200 bg-white"}`} data-testid={`hp-review-weekcard-${week}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-700">
          Week {week} Review
          {current && (
            <span className="ml-1.5 rounded-[4px] border border-sky-200 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-700">
              This review
            </span>
          )}
        </p>
        {clinical && (
          <span className={`rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${done ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
            {done ? "Completed" : "Pending"}
          </span>
        )}
      </div>

      <div className="mt-2">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Client's Weekly Review</p>
        {client.length === 0 ? (
          <p className="mt-0.5 text-xs italic text-slate-400">The client hasn't filled this week's review yet.</p>
        ) : client.map((c) => (
          <div key={c.id} className="mt-1">
            <div className="flex items-center gap-1.5">
              {c.track === "rehab" && <span className="text-[10px] font-semibold text-violet-600">Rehab</span>}
              <span className="inline-flex items-center gap-0.5" aria-label={`${c.rating} of 5 stars`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className={`h-3.5 w-3.5 ${n <= (c.rating || 0) ? "fill-amber-400 text-amber-400" : "text-slate-200"}`} />
                ))}
              </span>
              <span className="text-[11px] font-semibold text-amber-700">{c.rating || "—"}/5</span>
              <span className="text-[10px] text-slate-400">· {dmy(c.updated_at || c.created_at)}</span>
            </div>
            {c.comment ? (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{c.comment}</p>
            ) : (
              <p className="mt-0.5 text-xs italic text-slate-400">No feedback written.</p>
            )}
          </div>
        ))}
      </div>

      {/* The open review's own notes are already on the page around this card. */}
      {clinical && !current && (
        <>
          {clinical.physio_notes && (
            <div className="mt-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Physio's Notes{clinical.physio_name ? ` · ${clinical.physio_name}` : ""}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{clinical.physio_notes}</p>
            </div>
          )}
          <div className="mt-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Consultant's Review{done && clinical.head_physio_name ? ` · ${clinical.head_physio_name}` : ""}
            </p>
            {done && clinical.head_physio_notes ? (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{clinical.head_physio_notes}</p>
            ) : (
              <p className="mt-0.5 text-xs italic text-slate-400">{done ? "Completed without notes." : "Not written yet."}</p>
            )}
            {clinical.head_physio_suggestions && (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-emerald-700">{clinical.head_physio_suggestions}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const StageBadge = ({ stage }) => (
  <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-2 py-0.5 text-[10px] font-bold ${stage.badge}`}>
    {stage.warn && <AlertTriangle className="h-3 w-3" />}
    {stage.label}
  </span>
);

/**
 * Head Physio > Review — the far end of the post-treatment review chain. Only reviews a
 * Branch Admin has actually dispatched to this Head Physio appear here.
 *
 * "Today Review" deliberately also carries anything past its date and still unwritten:
 * an overdue review that fell out of Today would sit in a list nobody opens, which is
 * exactly how a patient's week-one review gets missed.
 */
export const HeadPhysioReviewTab = ({ branchId = null, headChief = false, selectedDate, dateRange = null, onCountChange, onRowsChange, autoOpenReviewId, onAutoOpened, reloadToken, homeVisitScope = null }) => {
  const [data, setData] = useState({ today: [], upcoming: [], overdue: [], completed: [], today_date: "" });
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(null); // { review, head_physio_notes, head_physio_suggestions }
  // A review that has already been written opens to be read, not rewritten. The board's
  // All list has a View on every row including the finished ones, and it used to open the
  // same empty write form the queue uses — so a Consultant checking what they had said was
  // shown a blank page and a Complete Review button over a review already complete.
  const reviewDone = draft?.review?.status === "completed";
  const [draftTab, setDraftTab] = useState("write");
  const [sessionState, setSessionState] = useState({ loading: false, failed: false, sessions: [] });
  const [docCount, setDocCount] = useState(0);
  const [saving, setSaving] = useState(false);
  // Which week bars the reader has opened or shut by hand; null means "whatever this
  // review covers", which is what a freshly opened popup should be showing.
  const [weekOverride, setWeekOverride] = useState(null);
  // Every week's reviews on the open patient — the clinical ones and the client's weekly
  // review form — fetched with the popup, not with the list.
  const [weekReviews, setWeekReviews] = useState({ reviews: [], client_weeks: [] });

  // branchId is set only by a supervisor board, and it is what makes this list answer to
  // the branch on screen rather than to whoever is signed in. Without it a Super Admin in
  // Operations > Consultant got an empty queue: the endpoint matched on their own
  // consultant record, and a Super Admin has none — so a review a Branch Admin had just
  // dispatched showed up on no board at all. A Consultant's own board passes nothing and
  // still sees only what was sent to them.
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await hpReviews(branchId, headChief)); }
    catch { setData({ today: [], upcoming: [], overdue: [], completed: [], today_date: "" }); }
    setLoading(false);
  }, [branchId, headChief]);

  useEffect(() => { load(); }, [load]);

  // Cleared when the popup moves to another patient: the panel refetches and reports the
  // new figure, but until it answers the label would still be carrying the last one's.
  const draftLeadId = draft?.review?.lead_id || null;
  useEffect(() => { setDocCount(0); }, [draftLeadId]);

  // The board's Refresh reaching this tab's data. The first value is skipped — the mount
  // effect above has already fetched, and firing here too would double every open.
  const reloadSeen = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === reloadSeen.current) return;
    reloadSeen.current = reloadToken;
    load();
  }, [reloadToken, load]);

  // With a day picked upstream, "due" means that day's reviews rather than everything
  // outstanding — the week strip is the filter, so the list has to answer to it.
  // A range takes over from the single day when one is set upstream — the board offers
  // one scope at a time, so this answers to whichever is active rather than both.
  const inScope = useMemo(() => {
    if (dateRange?.from && dateRange?.to) {
      // Local calendar day, not toISOString: in IST local midnight is the previous day in
      // UTC, which would pull yesterday's reviews into Today.
      const iso = (v) => { const x = new Date(v); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const from = iso(dateRange.from);
      const to = iso(dateRange.to);
      return (d) => !!d && d >= from && d <= to;
    }
    if (selectedDate) return (d) => d === selectedDate;
    return () => true;
  }, [dateRange, selectedDate]);

  // The Consultant board's House Visit tab and the main Review tab are this one list split
  // by where the patient is seen: "only" keeps the house-visit patients, "exclude" the
  // rest, null (every other caller) the whole list.
  const inVisitScope = useCallback((r) => (
    homeVisitScope === "only" ? r.visit_type === "home"
      : homeVisitScope === "exclude" ? r.visit_type !== "home"
      : true
  ), [homeVisitScope]);

  const dueList = useMemo(() => {
    const all = [...(data.overdue || []), ...(data.today || []), ...(data.upcoming || [])];
    return all.filter((r) => inScope(r.review_date || "") && inVisitScope(r));
  }, [data, inScope, inVisitScope]);

  const completedList = useMemo(() => {
    const all = data.completed || [];
    return all.filter((r) => inScope(r.review_date || "") && inVisitScope(r));
  }, [data.completed, inScope, inVisitScope]);

  // Outstanding first, then what's already written — the day's reviews are one list, not
  // two tabs to check. Each row already reads differently by status, so splitting them
  // only added a control to click before seeing either half.
  const rows = useMemo(() => [...dueList, ...completedList], [dueList, completedList]);

  // Outstanding reviews only — a tab labelled "Review 2" means two still to write, not
  // two that exist.
  useEffect(() => {
    if (onCountChange) onCountChange(dueList.length);
  }, [dueList.length, onCountChange]);

  useEffect(() => {
    if (onRowsChange) onRowsChange(rows);
  }, [rows, onRowsChange]);

  // View on the board's All list names a review; open it here once the rows this tab owns
  // have actually loaded. The same drawer serves both, and reads which it is off the
  // review: this list gives a finished one no button at all, so View is the only way one
  // is ever opened and it has to open as something to read.
  useEffect(() => {
    if (!autoOpenReviewId || !rows.length) return;
    const match = rows.find((r) => r.id === autoOpenReviewId);
    if (!match) return;
    setDraft({ review: match, head_physio_notes: "", head_physio_suggestions: "" });
    onAutoOpened && onAutoOpened();
  }, [autoOpenReviewId, rows, onAutoOpened]);

  // The patient's treatment days, pulled when a review is opened. Not with the list: this
  // is one patient's day-by-day detail and would be a request per row to fill a panel
  // nobody may open.
  useEffect(() => {
    const leadId = draft?.review?.lead_id;
    if (!leadId) return;
    let cancelled = false;
    setDraftTab("write");
    setWeekOverride(null);
    setSessionState({ loading: true, failed: false, sessions: [] });
    setWeekReviews({ reviews: [], client_weeks: [] });
    hpLeadWeekReviews(leadId)
      .then((data) => { if (!cancelled) setWeekReviews({ reviews: data.reviews || [], client_weeks: data.client_weeks || [] }); })
      .catch(() => {});
    physioSessions(leadId)
      .then((data) => { if (!cancelled) setSessionState({ loading: false, failed: false, sessions: data.sessions || [] }); })
      // The write-up is the job; losing the day list should not stop it being done.
      .catch(() => { if (!cancelled) setSessionState({ loading: false, failed: true, sessions: [] }); });
    return () => { cancelled = true; };
  }, [draft?.review?.lead_id]);

  /**
   * Every completed treatment day the patient has, cut into weeks of REVIEW_EVERY days.
   *
   * The tab used to show only the block this review is a judgement on, and nothing else —
   * so a Consultant on a patient's third review could read days 15–21 and had no way at
   * all to see what the two weeks before them had been treated with. The earlier weeks are
   * here now, each behind its own one-line bar, shut until it is asked for: the week this
   * review covers is the one that opens on its own, and the rest are a click away rather
   * than a board away.
   *
   * Days are numbered by DATE rather than by position in the session list, because the
   * count a review carries is a count of dates: a patient on rehab and a treatment package
   * at once has two rows on one morning, and counting rows would hand the Consultant three
   * and a half days where the review says seven. Both of that morning's rows land on the
   * same day number and are read together.
   *
   * Ordered by slot_time rather than session number for the same reason — the two courses
   * each number their days from 1, so the numbers alone do not put the days in order.
   */
  const dayBook = useMemo(() => {
    const done = (sessionState.sessions || [])
      .filter((s) => s.status === "completed" && s.slot_time)
      .sort((a, b) => String(a.slot_time).localeCompare(String(b.slot_time)));
    const dates = [...new Set(done.map((s) => String(s.slot_time).slice(0, 10)))];
    const dayOf = new Map(dates.map((d, i) => [d, i + 1]));

    // The block this review was raised on: the REVIEW_EVERY days ending at the day count
    // stored when it was raised, not the whole course.
    const upTo = Number(draft?.review?.treatment_days) || dates.length;
    const reviewFrom = Math.max(1, Math.min(upTo, dates.length) - REVIEW_EVERY + 1);
    const reviewTo = Math.min(upTo, dates.length);

    const byWeek = new Map();
    for (const row of done) {
      const day = dayOf.get(String(row.slot_time).slice(0, 10));
      const week = Math.ceil(day / REVIEW_EVERY);
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push({ ...row, day_index: day });
    }

    const weeks = [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([week, rows]) => {
        const days = rows.map((r) => r.day_index);
        const firstDay = Math.min(...days);
        const lastDay = Math.max(...days);
        return {
          week,
          rows,
          firstDay,
          lastDay,
          dayCount: new Set(days).size,
          from: String(rows[0].slot_time).slice(0, 10),
          // Open on its own, and badged. A week that only overlaps the window still counts
          // as part of it — the window slides by seven days and a fixed week does not, so
          // days 6-12 sit across weeks one and two and both hold days being judged here.
          inReview: lastDay >= reviewFrom && firstDay <= reviewTo,
        };
      });
    return { weeks, reviewFrom, reviewTo, totalDays: dates.length };
  }, [sessionState.sessions, draft?.review?.treatment_days]);

  // Null until somebody opens or shuts one, so the weeks this review covers stay open by
  // default without an effect writing state the moment the popup loads its days.
  const defaultOpenWeeks = useMemo(
    () => new Set(dayBook.weeks.filter((w) => w.inReview).map((w) => w.week)),
    [dayBook.weeks],
  );
  const openWeeks = weekOverride || defaultOpenWeeks;
  const toggleWeek = (week) => {
    const next = new Set(openWeeks);
    if (next.has(week)) next.delete(week);
    else next.add(week);
    setWeekOverride(next);
  };

  // Week number -> that week's clinical review and client forms. The open review's own
  // week comes from the server's numbering, so it is the same week the table calls it.
  const weekInfo = useMemo(() => {
    const clinical = new Map();
    for (const r of weekReviews.reviews) if (r.review_number) clinical.set(r.review_number, r);
    const client = new Map();
    for (const c of weekReviews.client_weeks) {
      if (!c.week_number) continue;
      if (!client.has(c.week_number)) client.set(c.week_number, []);
      client.get(c.week_number).push(c);
    }
    const currentWeek = weekReviews.reviews.find((r) => r.id === draft?.review?.id)?.review_number
      || Math.max(1, Math.floor((Number(draft?.review?.treatment_days) || 0) / REVIEW_EVERY));
    const weeks = [...new Set([...clinical.keys(), ...client.keys(), currentWeek])].sort((a, b) => a - b);
    return { clinical, client, currentWeek, weeks };
  }, [weekReviews, draft?.review?.id, draft?.review?.treatment_days]);

  const weekCard = (week) => (
    <WeekReviewCard
      key={week}
      week={week}
      clinical={weekInfo.clinical.get(week)}
      client={weekInfo.client.get(week) || []}
      current={week === weekInfo.currentWeek}
    />
  );

  const submit = async () => {
    if (!draft.head_physio_notes.trim()) { toast.error("Write the review notes"); return; }
    setSaving(true);
    try {
      await hpCompleteReview(draft.review.id, {
        head_physio_notes: draft.head_physio_notes,
        head_physio_suggestions: draft.head_physio_suggestions,
      });
      toast.success("Review completed");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save the review");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4" data-testid="hp-review-tab">
      {loading && rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading reviews...</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-12 text-center text-sm text-slate-400">
          {selectedDate
            ? "No reviews on this day."
            : branchId
              ? "No reviews on this branch yet. A Branch Admin sends one here once a Physio raises it."
              : "No reviews assigned to you. A Branch Admin sends them here once a Physio raises one."}
        </p>
      ) : (
        <>
          {/* Cards on a phone, the table from sm. Six columns cannot reflow, and a review
              is only useful read whole — who, what stage, what was recommended. */}
          <div className="space-y-2 sm:hidden" data-testid="hp-review-mobile">
            {rows.map((r, i) => {
              const st = stageOf(r, data.today_date);
              return (
                <div key={r.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 bg-white p-4 ${st.card}`} data-testid={`hp-review-card-${r.id}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-slate-800">
                        <span className="mr-1.5 font-semibold text-slate-300">{i + 1}.</span>{r.lead_name}
                      </p>
                      {r.patient_number && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-500">{r.patient_number}</span>}
                      <StageBadge stage={st} />
                      {r.client_rating ? <StarRating value={r.client_rating} /> : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {displayPhone(r.phone) || "—"} · Review {dmy(r.review_date)}{r.review_time ? ` · ${to12h(r.review_time)}` : ""} · raised by {r.physio_name || "—"}
                    </p>
                    {/* Only on a supervisor board, where the list runs across every
                        Consultant on the branch and a row is otherwise silent about whose
                        it is. On a Consultant's own board they are all theirs. */}
                    {branchId && (
                      <p className="mt-0.5 text-xs font-medium text-violet-700">{r.head_physio_name || "—"}</p>
                    )}
                    {r.physio_notes && <p className="mt-1 line-clamp-2 text-xs text-slate-600">“{r.physio_notes}”</p>}
                    {r.head_physio_suggestions && (
                      <p className="mt-1 line-clamp-2 text-xs font-medium text-emerald-700">{r.head_physio_suggestions}</p>
                    )}
                  </div>
                  {!st.done ? (
                    <Button size="sm" className="shrink-0 bg-sky-600 text-xs text-white hover:bg-sky-700" onClick={() => setDraft({ review: r, head_physio_notes: "", head_physio_suggestions: "" })} data-testid={`hp-review-write-${r.id}`}>
                      Write Review
                    </Button>
                  ) : (
                    <span className="shrink-0 rounded-md bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700">COMPLETED</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white sm:block" data-testid="hp-review-desktop">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-sm">
                <thead className="bg-slate-500 text-left text-[10px] uppercase tracking-wider text-white">
                  <tr>
                    <th className="w-12 px-4 py-2.5 font-semibold">S.No</th>
                    <th className="px-4 py-2.5 font-semibold">Patient</th>
                    <th className="px-4 py-2.5 font-semibold">Phone</th>
                    <th className="px-4 py-2.5 font-semibold">Stage</th>
                    <th className="px-4 py-2.5 font-semibold">Date</th>
                    {branchId && <th className="px-4 py-2.5 font-semibold">Consultant</th>}
                    <th className="px-4 py-2.5 font-semibold">Recommendation</th>
                    <th className="px-4 py-2.5 font-semibold">Star Rating</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => {
                    const st = stageOf(r, data.today_date);
                    return (
                      <tr key={r.id} className="hover:bg-slate-50" data-testid={`hp-review-row-${r.id}`}>
                        <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">{r.lead_name}</p>
                          <p className="text-[11px] text-slate-400">
                            {r.patient_number || "—"} · {r.treatment_days} treatment days
                          </p>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{displayPhone(r.phone) || "—"}</td>
                        <td className="px-4 py-3">
                          <StageBadge stage={st} />
                        </td>
                        {/* The slot the review was dispatched into, not just its day —
                            it is booked at an hour on the Consultant's calendar, and a
                            row that only names the date sends someone to the Branch
                            board to find out when. */}
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {dmy(r.review_date)}
                          {r.review_time && <span className="block text-[11px] text-slate-400">{to12h(r.review_time)}</span>}
                        </td>
                        {branchId && (
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-violet-700">
                            {r.head_physio_name || "—"}
                          </td>
                        )}
                        {/* What the Head Physio told the treating physio to change. Empty
                            until the review is written, which is most of this column most
                            of the time — that emptiness is the queue. */}
                        <td className="px-4 py-3 text-slate-600">
                          {r.head_physio_suggestions
                            ? <span className="line-clamp-2">{r.head_physio_suggestions}</span>
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <StarRating value={r.client_rating} testid={`hp-review-stars-${r.id}`} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!st.done ? (
                            <Button size="sm" className="bg-sky-600 text-xs text-white hover:bg-sky-700" onClick={() => setDraft({ review: r, head_physio_notes: "", head_physio_suggestions: "" })} data-testid={`hp-review-write-${r.id}`}>
                              Write Review
                            </Button>
                          ) : (
                            <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700">COMPLETED</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {draft && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3" data-testid="hp-review-modal">
          <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <div>
                <p className="text-lg font-bold text-slate-800">{draft.review.lead_name}</p>
                <p className="text-xs text-slate-500">
                  {draft.review.treatment_days} treatment days · review {dmy(draft.review.review_date)}
                </p>
              </div>
              <button onClick={() => setDraft(null)} className="rounded-lg border-2 border-orange-200 bg-orange-100 p-2 text-orange-600 hover:bg-orange-200" data-testid="hp-review-close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* The review is a judgement on a week of treatment, and until now the only
                thing in front of the person writing it was the physio's one summary note.
                The days themselves — what was done each session — sat on another board. */}
            <div className="flex shrink-0 gap-1 border-b border-slate-200 px-5 py-2" data-testid="hp-review-modal-tabs">
              {[
                { key: "write", label: reviewDone ? "The Review" : "Write Review" },
                { key: "days", label: `Treatment Days${dayBook.totalDays ? ` (${dayBook.totalDays})` : ""}` },
                { key: "documents", label: `Documents${docCount ? ` (${docCount})` : ""}` },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setDraftTab(t.key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    draftTab === t.key ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                  data-testid={`hp-review-modal-tab-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className={`flex-1 space-y-4 overflow-y-auto p-5 ${draftTab === "write" ? "" : "hidden"}`}>
              {draft.review.reason && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Reason for Review</p>
                  <p className="mt-1 text-sm text-slate-700">{draft.review.reason}</p>
                </div>
              )}
              {/* Always rendered, even when empty. Notes are required when raising a
                  review now, but reviews raised before that rule have none — and silently
                  omitting the block made it look as though the physio's remarks had gone
                  missing rather than never having been written. */}
              <div className={`rounded-lg border p-3 ${draft.review.physio_notes ? "border-sky-200 bg-sky-50" : "border-slate-200 bg-slate-50"}`} data-testid="hp-review-physio-notes">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Physio's Notes
                  {draft.review.physio_name && <span className="ml-1 font-semibold normal-case tracking-normal text-slate-500">· {draft.review.physio_name}</span>}
                </p>
                {draft.review.physio_notes ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{draft.review.physio_notes}</p>
                ) : (
                  <p className="mt-1 text-sm italic text-slate-400">The physio raised this review without notes.</p>
                )}
              </div>
              {/* Each week's review — the client's weekly form, and for earlier weeks what
                  the Consultant wrote — read before this one is written. */}
              <div className="space-y-2" data-testid="hp-review-week-reviews">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Weekly Reviews</p>
                {weekInfo.weeks.map(weekCard)}
              </div>
              {reviewDone ? (
                <>
                  {/* What was written, read back. An empty textarea over a finished review
                      says nothing was written and invites somebody to write it again. */}
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3" data-testid="hp-review-written-notes">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Review Notes</p>
                    {draft.review.head_physio_notes ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{draft.review.head_physio_notes}</p>
                    ) : (
                      <p className="mt-1 text-sm italic text-slate-400">Completed without notes.</p>
                    )}
                  </div>
                  {draft.review.head_physio_suggestions && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="hp-review-written-suggestions">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Suggestions</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{draft.review.head_physio_suggestions}</p>
                    </div>
                  )}
                  {/* Who signed it and when, because a review read weeks later is a
                      judgement somebody made on a day and not a standing fact. */}
                  <p className="text-[11px] text-slate-400" data-testid="hp-review-written-by">
                    {draft.review.head_physio_name ? `Written by ${draft.review.head_physio_name}` : "Written"}
                    {draft.review.completed_at ? ` · ${dmy(draft.review.completed_at)}` : ""}
                  </p>
                </>
              ) : (
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Review Notes *</label>
                  <textarea
                    rows={5}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                    placeholder="How is the patient responding after a week of treatment?"
                    value={draft.head_physio_notes}
                    onChange={(e) => setDraft({ ...draft, head_physio_notes: e.target.value })}
                    data-testid="hp-review-notes"
                  />
                </div>
              )}
            </div>

            <div className={`flex-1 overflow-y-auto p-5 ${draftTab === "days" ? "" : "hidden"}`} data-testid="hp-review-days">
              {sessionState.loading ? (
                <p className="py-10 text-center text-sm text-slate-400">Loading treatment days...</p>
              ) : dayBook.weeks.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">
                  {sessionState.failed
                    ? "Couldn't load this patient's treatment days."
                    : "No completed treatment days on record for this review yet."}
                </p>
              ) : (
                <>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    What the physio treated each session with
                  </p>
                  {/* The window this review is a judgement on, said once at the top rather
                      than as a heading over the days: the list below runs the whole course
                      now, and the reader still needs to know which of those days this
                      review answers for. */}
                  <p className="mb-3 mt-0.5 text-[11px] text-slate-400">
                    This review covers Days {dayBook.reviewFrom}–{dayBook.reviewTo}. Earlier weeks are here too — open one to read it.
                  </p>

                  <div className="space-y-2">
                    {dayBook.weeks.map((w) => {
                      const open = openWeeks.has(w.week);
                      return (
                        <div key={w.week} className={`overflow-hidden rounded-lg border ${w.inReview ? "border-sky-200" : "border-slate-200"}`} data-testid={`hp-review-week-${w.week}`}>
                          {/* One line, whatever the week holds — the bars are what a reader
                              scans down, so a week's days stay folded away until it is the
                              week they want. */}
                          <button
                            type="button"
                            onClick={() => toggleWeek(w.week)}
                            className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition ${w.inReview ? "bg-sky-50 hover:bg-sky-100" : "bg-slate-50 hover:bg-slate-100"}`}
                            aria-expanded={open}
                            data-testid={`hp-review-week-toggle-${w.week}`}
                          >
                            {open
                              ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                              : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                            <span className="shrink-0 text-xs font-bold text-slate-700">Week {w.week}</span>
                            <span className="truncate text-[11px] text-slate-500">
                              Days {w.firstDay}{w.lastDay > w.firstDay ? `–${w.lastDay}` : ""} · {dmy(w.from)}
                            </span>
                            {w.inReview && (
                              <span className="shrink-0 rounded-[4px] border border-sky-200 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-700">
                                This review
                              </span>
                            )}
                            <span className="ml-auto shrink-0 text-[11px] font-semibold text-slate-400">
                              {w.dayCount} day{w.dayCount === 1 ? "" : "s"}
                            </span>
                          </button>

                          {open && (
                            <div className="space-y-2 border-t border-slate-200 bg-white p-2.5" data-testid={`hp-review-week-days-${w.week}`}>
                              {weekCard(w.week)}
                              {w.rows.map((s) => {
                                const isRehab = s.track === "rehab";
                                const inWindow = s.day_index >= dayBook.reviewFrom && s.day_index <= dayBook.reviewTo;
                                return (
                                  <div key={s.id} className={`rounded-lg border p-3 ${inWindow ? "border-sky-200 bg-sky-50/40" : "border-slate-200"}`} data-testid={`hp-review-day-${s.id}`}>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs font-bold text-slate-700">
                                        {/* A rehab day is named as one. It numbers from 1
                                            inside its own course, so printing it as a plain
                                            "Day 3" beside treatment day 3 read as one day
                                            written up twice. */}
                                        {isRehab ? "Rehab Day" : "Day"} {s.session_number}
                                        <span className="ml-1.5 font-normal text-slate-400">
                                          {s.slot_time ? dmy(s.slot_time.split("T")[0]) : "—"}
                                        </span>
                                      </p>
                                      {s.completed_by && <span className="text-[10px] text-slate-400">{s.completed_by}</span>}
                                    </div>

                                    {/* What was given, off Services and Products >
                                        Physiotherapy Treatment. Above the notes, the way
                                        the physio's own popup puts it above them: what was
                                        done is read before what was written about it.
                                        Named even when empty — a Consultant judging a week
                                        should be able to tell a day nobody tagged from a
                                        day this popup simply did not print. */}
                                    <div className="mt-1.5">
                                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Physio Treatment</p>
                                      {(s.physio_treatments || []).length > 0 ? (
                                        <div className="mt-1">
                                          <PhysioTreatmentChips names={s.physio_treatments} testid={`hp-review-day-treatments-${s.id}`} />
                                        </div>
                                      ) : (
                                        <p className="mt-0.5 text-xs italic text-slate-400">No treatment tagged on this day.</p>
                                      )}
                                    </div>

                                    {/* Every note the day carries, each under its own name.
                                        The two are written for different reasons and the
                                        Consultant reads them apart. */}
                                    {s.jr_physio_remarks && (
                                      <div className="mt-2">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Treatment Remarks</p>
                                        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{s.jr_physio_remarks}</p>
                                      </div>
                                    )}
                                    {s.rehab_remarks && (
                                      <div className="mt-2">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Rehab Remarks</p>
                                        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{s.rehab_remarks}</p>
                                      </div>
                                    )}
                                    {!s.jr_physio_remarks && !s.rehab_remarks && (
                                      // Said rather than skipped: a day completed without
                                      // remarks and a day that never happened are different
                                      // things to read past.
                                      <p className="mt-2 text-sm italic text-slate-400">Completed without remarks.</p>
                                    )}

                                    {(s.absences || []).length > 0 && (
                                      <p className="mt-1.5 text-[10px] font-semibold text-amber-700">
                                        Missed {s.absences.length} time{s.absences.length === 1 ? "" : "s"} before this — moved from {dmy(s.absences[0].date)}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Scans, reports and prescriptions on the same patient, alongside the days
                and the notes. A review is a judgement on how someone is responding, and
                the x-ray that prompted the referral was a board away from the person
                writing it.

                Mounted rather than rendered on click, so the tab can carry its count
                before anyone opens it — and left listing every kind, because a document
                worth reading before writing a review is not only the ones filed as
                general. Editable: this board is only ever on screen for the Consultant,
                who is one of the three roles the documents API takes writes from. */}
            <div className={`flex-1 overflow-y-auto p-5 ${draftTab === "documents" ? "" : "hidden"}`} data-testid="hp-review-documents">
              <LeadDocuments leadId={draft.review.lead_id} kind="" canEdit onChanged={setDocCount} />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
              {reviewDone ? (
                <Button variant="outline" onClick={() => setDraft(null)} data-testid="hp-review-cancel">Close</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setDraft(null)} data-testid="hp-review-cancel">Cancel</Button>
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={submit} disabled={saving} data-testid="hp-review-submit">
                    {saving ? "Saving..." : "Complete Review"}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HeadPhysioReviewTab;
