import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Mail,
  MapPin,
  MoreVertical,
  Phone,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { toast } from "@/components/ui/sonner";
import { getBdSummaryRows } from "@/lib/api";
import { displayPhone, telNumber } from "@/lib/phone";
// The avatar the rest of the OS already gives a lead: same two letters, same hue per
// first letter, so one person is the same colour on this list and on Sales View.
import { avatarColor, initials } from "@/components/PreSalesCRM";

/* ─── Status ─── */

// What a pre-sales stage is worth showing as. Matched on words rather than on the four
// literals in constants.py, because the stage list is editable (Settings > Pipeline
// Stages) and a branch that renames "Appointment" to "Consultation Booked" must not drop
// back to the neutral tone. Anything unmatched reads as in-progress rather than as bad --
// an unrecognised stage is this file being out of date, not a lead being wrong.
const STATUS_TONES = [
  {
    match: /appoint|book|convert|won|qualif|closed/i,
    icon: CheckCircle2,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  {
    match: /follow|callback|nurtur/i,
    icon: Clock,
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  {
    match: /rnr|not interested|junk|invalid|lost|dead|cancel|reject/i,
    icon: XCircle,
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
];

const NEW_TONE = {
  icon: Sparkles,
  className: "border-sky-200 bg-sky-50 text-sky-700",
};

const toneFor = (stage) => STATUS_TONES.find((t) => t.match.test(stage || "")) || NEW_TONE;

/** The stage's own name, in the tone its wording earns — colour is the grouping, the text
 *  is the fact. A badge reading "Booked" over a lead the pipeline calls "Appointment Date &
 *  Time" would be this file naming the stage instead of the pipeline, and the desk works
 *  the pipeline. */
const StatusBadge = ({ stage }) => {
  const tone = toneFor(stage);
  const Icon = tone.icon;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${tone.className}`}
      title={stage || "No stage"}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{stage || "—"}</span>
    </span>
  );
};

/* ─── Helpers ─── */

// 10-digit → prepend 91; 11-digit leading 0 → drop the 0 and prepend 91 — the same
// sanitizer PreSalesCRM, PhysioBoard and the Client Portal each keep for their own
// WhatsApp links.
const waNumber = (raw) => {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
};

const copy = (value, what) => {
  if (!value) return;
  navigator.clipboard?.writeText(value)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error(`Could not copy the ${what.toLowerCase()}`));
};


/* ─── The list ─── */

/**
 * The leads behind one row of the Marketing or Sales breakdown table — one lead per line.
 *
 * Opened by clicking a row on BdMarketingSources, which owns the range, the branch scope
 * and the grouping and hands the answer down here as a title and a set of query params.
 * This component asks no scoping question of its own at all, and draws no toolbar: every
 * control that narrows what is on screen lives on the board's one toolbar row, including
 * the search box whose text arrives here as a prop.
 *
 * That is not only tidiness. The row that was clicked already fixes a source, a stage, a
 * branch or a pairing of them, and a Status dropdown down here could quietly overrule the
 * stage in the header — leaving the bar naming one thing and the rows showing another.
 * Going back is how the scope changes.
 *
 * Rows come from /dashboard/bd-summary/rows?metric=total, the endpoint this board's
 * summary cards already drill into: same collection, same filters, same 500-row cap with
 * the unclipped total beside it. The search is applied here, over what came back, because
 * that endpoint takes no text.
 *
 * @param branches   every branch, from useDashboardData — for resolving a lead's branch name
 * @param dateParams the board's date range, already in the two params the endpoint takes
 * @param params     the row's own scope: branch_id/branch_ids, source_tab and stage
 * @param search     the board toolbar's search box, applied over the rows on screen
 * @param title      what was clicked, shown in the header beside the back arrow
 * @param subtitle   the second line under it — the branch, and the row's own two figures
 * @param onBack     returns to the breakdown table
 * @param onOpenLead opens a row in Sales View's own lead popup, the way a card's list does
 */
export const BdMarketingList = ({
  branches, dateParams, params, search = "", title, subtitle, onBack, onOpenLead,
}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // The row's scope is settled upstairs and arrives as one object, so a new selection is
  // one changed dependency rather than three.
  useEffect(() => {
    // Guarded: a source clicked twice quickly leaves two requests in flight, and the
    // slower one must not land on top of the newer list.
    let cancelled = false;
    setLoading(true);
    getBdSummaryRows("total", { ...dateParams, ...params })
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) { toast.error("Failed to load these leads"); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateParams, params]);

  const branchName = useCallback(
    (id) => (id ? (branches.find((b) => b.branch_id === id)?.branch_name || "Unknown") : "Unassigned"),
    [branches],
  );

  const sent = useMemo(() => data?.rows || [], [data]);

  // Matched against what the row actually shows — name, source, email, phone, place and
  // stage — so a desk can find anything it can see and nothing it cannot.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sent;
    return sent.filter((r) => [
      r.name, r.source_tab, r.source_type, r.email, r.phone,
      r.city, r.location, branchName(r.branch_id), r.stage,
    ].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [sent, search, branchName]);

  const clipped = data ? data.total - sent.length : 0;
  const narrowed = rows.length !== sent.length;

  const place = (r) => r.city || r.location || branchName(r.branch_id);
  const channel = (r) => r.source_tab || r.source_type || "—";

  return (
    <div className="space-y-4" data-testid="bd-marketing-list-tab">
      {/* Where the table left off. The arrow and the title are one control, not a button
          beside a heading: the whole bar is the way back, and a desk that has drilled into
          a sheet reaches for the name it clicked. */}
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-sky-300 hover:bg-sky-50/40"
        data-testid="bd-marketing-list-back"
      >
        <ArrowLeft className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-slate-800">{title}</span>
          <span className="block truncate text-xs text-slate-500">{subtitle}</span>
        </span>
      </button>

      <Card data-testid="bd-marketing-list-card">
        <CardContent className="p-0">
          {/* The two ways this list can be shorter than the estate's own figure, said only
              when one of them is happening: the server's cap, and the search box. */}
          {data && (clipped > 0 || narrowed) && (
            <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500" data-testid="bd-marketing-list-count">
              {clipped > 0 && `Showing the ${sent.length.toLocaleString("en-IN")} most recent of ${data.total.toLocaleString("en-IN")}`}
              {clipped > 0 && narrowed && " · "}
              {narrowed && `${rows.length.toLocaleString("en-IN")} match the search`}
            </p>
          )}

          {loading ? (
            <p className="px-3 py-16 text-center text-sm text-slate-400" data-testid="bd-marketing-list-loading">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-16 text-center text-sm text-slate-400" data-testid="bd-marketing-list-empty">
              {sent.length === 0 ? "No leads in this range." : "Nothing here matches the search."}
            </p>
          ) : (
            <>
              {/* Phone: the same facts stacked. A table of six columns on a 360px screen is
                  a table nobody reads. */}
              <div className="space-y-2 p-3 md:hidden" data-testid="bd-marketing-list-mobile">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenLead?.(r)}
                    onKeyDown={(e) => { if (e.key === "Enter") onOpenLead?.(r); }}
                    className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 hover:border-sky-300"
                    data-testid={`bd-marketing-list-card-${r.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarColor(r.name).bg} ${avatarColor(r.name).fg}`}>
                        {initials(r.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-800">{r.name || "—"}</p>
                        <p className="truncate text-xs text-slate-500">{channel(r)}</p>
                      </div>
                      <StatusBadge stage={r.stage} />
                    </div>
                    <div className="mt-2 space-y-1 pl-12">
                      {r.email && <p className="flex items-center gap-1.5 truncate text-xs text-slate-600"><Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />{r.email}</p>}
                      {displayPhone(r.phone) && <p className="flex items-center gap-1.5 truncate text-xs text-slate-600"><Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />{displayPhone(r.phone)}</p>}
                      <p className="flex items-center gap-1.5 truncate text-xs text-slate-600"><MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />{place(r)}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Location</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => onOpenLead?.(r)}
                        title="Open lead"
                        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                        data-testid={`bd-marketing-list-row-${r.id}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarColor(r.name).bg} ${avatarColor(r.name).fg}`}>
                              {initials(r.name)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-slate-800">{r.name || "—"}</p>
                              <p className="truncate text-xs text-slate-500">{r.vertical || r.department || "—"}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <p className="truncate font-medium text-slate-700">{channel(r)}</p>
                          <p className="truncate text-xs text-slate-500">{r.source_type || "—"}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="flex items-center gap-1.5 text-slate-600">
                            <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate">{r.email || "—"}</span>
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-slate-600">
                            <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate">{displayPhone(r.phone) || "—"}</span>
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5 text-slate-600">
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate">{place(r)}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3"><StatusBadge stage={r.stage} /></td>
                        {/* Both controls stop the click reaching the row: a WhatsApp tap
                            that also opened the lead popup would leave the desk looking at
                            a dialog it did not ask for, behind a new tab. */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            {r.phone ? (
                              <a
                                href={`https://wa.me/${waNumber(r.phone)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`WhatsApp ${r.name || "this lead"}`}
                                className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-50"
                                data-testid={`bd-marketing-list-wa-${r.id}`}
                              >
                                <WhatsAppIcon className="h-4 w-4" />
                              </a>
                            ) : <span className="w-7" />}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label="More actions"
                                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                                  data-testid={`bd-marketing-list-menu-${r.id}`}
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem onSelect={() => onOpenLead?.(r)}>Open lead</DropdownMenuItem>
                                {r.phone && <DropdownMenuItem onSelect={() => { window.location.href = `tel:${telNumber(r.phone)}`; }}>Call</DropdownMenuItem>}
                                {displayPhone(r.phone) && <DropdownMenuItem onSelect={() => copy(displayPhone(r.phone), "Phone")}>Copy phone</DropdownMenuItem>}
                                {r.email && <DropdownMenuItem onSelect={() => copy(r.email, "Email")}>Copy email</DropdownMenuItem>}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
