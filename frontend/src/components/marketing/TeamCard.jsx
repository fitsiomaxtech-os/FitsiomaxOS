import { useEffect, useState } from "react";
import { Users, Target, Building2, ChevronRight, Filter, Inbox, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { mkTeamMemberLeads } from "@/lib/api";
import { displayPhone } from "@/lib/phone";

/**
 * One tier of the sales chain — its people, and how each is doing.
 *
 * Lives here rather than inside MarketingBoard because the Super Admin Dashboard shows
 * the same panels as its own tabs. One component, so the two screens can't drift into
 * reporting the same person differently.
 *
 * The tiers measure different things, so the tiles are named per tier rather than sharing
 * one set of labels: Pre-Sales is judged on how much of its book it converts, the branch
 * on how many of the appointments handed to it close.
 *
 * Every figure is one /marketing/team-members already computes. The only thing derived
 * here is the comparison against the team, and that is derived rather than fetched
 * precisely so it can never disagree with the rows it is drawn from.
 */

// Which two counts make the rate. Needed because the team's own rate is the totals
// divided — sum(closed) / sum(leads) — and NOT the average of everyone's percentages.
// The mean of rates lets someone with three leads and one conversion drag the team
// benchmark as hard as someone with nine hundred, which is not what a benchmark is for.
export const TEAM_TIERS = {
  pre_sales: {
    icon: Users,
    accent: "text-amber-600",
    avatar: "bg-amber-500",
    rate: { key: "conversion_rate", num: "deals_closed", den: "total_assigned" },
    tiles: [
      { key: "total_assigned", label: "Leads" },
      { key: "deals_closed", label: "Converted" },
      { key: "conversion_rate", label: "Rate", suffix: "%", isRate: true },
    ],
  },
  sales: {
    icon: Target,
    accent: "text-emerald-600",
    avatar: "bg-emerald-500",
    rate: { key: "conversion_rate", num: "deals_closed", den: "current_leads" },
    tiles: [
      { key: "current_leads", label: "Appointments" },
      { key: "deals_closed", label: "Deals Closed" },
      { key: "conversion_rate", label: "Close Rate", suffix: "%", isRate: true },
    ],
  },
  // Same rows, same numbers — but the Dashboard names this tab Branch, because each of
  // these accounts *is* a branch. So the row leads with the branch it stands for and
  // carries the branch's whole lead count as a fourth tile.
  branch: {
    icon: Building2,
    accent: "text-emerald-600",
    avatar: "bg-emerald-500",
    subline: "branch_name",
    rate: { key: "conversion_rate", num: "deals_closed", den: "current_leads" },
    tiles: [
      { key: "total_assigned", label: "Leads" },
      { key: "current_leads", label: "Appointments" },
      { key: "deals_closed", label: "Converted" },
      { key: "conversion_rate", label: "Close Rate", suffix: "%", isRate: true },
    ],
  },
};

// Above this many people, cards stop working: the panel becomes a scroll where the first
// person and the last can never be on screen together, and comparing them is the whole
// job. Three or fewer read better as cards, which is what the marketing board shows.
const TABLE_FROM = 4;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The team's own rate: the totals divided, not the mean of the percentages. */
const teamRate = (members, rate) => {
  const den = members.reduce((s, m) => s + num(m[rate.den]), 0);
  if (!den) return null;
  return (members.reduce((s, m) => s + num(m[rate.num]), 0) / den) * 100;
};

/**
 * How far above or below the team this person is, in percentage POINTS.
 *
 * Points, not percent: the difference between 13.8% and 8.8% is five points. Calling it
 * "57% better" is arithmetically true of the ratio and says something nobody means.
 */
const Delta = ({ value, team }) => {
  if (team == null || value == null) return null;
  const d = Math.round((num(value) - team) * 10) / 10;
  if (Math.abs(d) < 0.05) return <span className="text-[10px] font-semibold text-slate-400">at team avg</span>;
  return (
    <span className={`text-[10px] font-semibold ${d > 0 ? "text-emerald-600" : "text-amber-600"}`}>
      {d > 0 ? "+" : ""}{d} pts vs team
    </span>
  );
};

/** Colour is spent only here, on the one number a manager acts on. Everywhere else it was
    decorative — Leads is not "warm" and Rate is not "purple" — and three hues on every row
    left no hue free to mean anything. */
const rateTone = (value, team) => {
  if (team == null || value == null) return "text-slate-800";
  return num(value) + 0.05 < team ? "text-amber-600" : "text-emerald-600";
};

const nameOf = (m, tier) => (tier.subline && m[tier.subline]) || m.full_name;
const subOf = (m, tier) => (tier.subline && m[tier.subline] ? m.full_name : m.email);

/**
 * One team member's own leads.
 *
 * The four headline figures are computed over their WHOLE book and never over the
 * filtered list — `Filtered Results` reports that separately. A Conversion Rate that
 * moved when you picked a date range would be a different statistic wearing the same
 * label, and the one number people quote off a screen like this.
 *
 * Stage and Source options are built before the filters are applied, so a stage you
 * filter to is still listed after you pick it and a source you filter away can be chosen
 * again.
 */
const MemberLeadsModal = ({ member, tier, onClose }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [source, setSource] = useState("");
  const [stage, setStage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    mkTeamMemberLeads(member.id, {
      ...(fromDate ? { from_date: fromDate } : {}),
      ...(toDate ? { to_date: toDate } : {}),
      ...(source ? { source } : {}),
      ...(stage ? { stage } : {}),
    })
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [member.id, fromDate, toDate, source, stage]);

  const narrowed = !!(fromDate || toDate || source || stage);
  const clear = () => { setFromDate(""); setToDate(""); setSource(""); setStage(""); };

  const Tile = ({ label, value, tone }) => (
    <div className={`rounded-xl border px-4 py-4 text-center ${tone}`}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="mt-1 text-xs font-medium opacity-70">{label}</p>
    </div>
  );

  const Field = ({ label, children }) => (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      {children}
    </div>
  );

  const inputCls = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3" data-testid="team-member-modal">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-6 pt-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${tier.avatar}`}>
              {(nameOf(member, tier) || "?").trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-2xl font-bold text-slate-800">{nameOf(member, tier)}</p>
              <p className="truncate text-sm text-slate-400">{subOf(member, tier)}</p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100" data-testid="team-member-modal-close">
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Total Leads" value={data?.total_leads ?? "—"} tone="border-amber-100 bg-amber-50/60 text-amber-600" />
            {/* A Pre-Sales agent has no Appointments figure of their own, so their second
                tile is the one their card actually shows: Converted. */}
            {data?.appointments != null
              ? <Tile label="Appointments" value={data.appointments} tone="border-emerald-100 bg-emerald-50/60 text-emerald-600" />
              : <Tile label="Converted" value={data?.converted ?? "—"} tone="border-emerald-100 bg-emerald-50/60 text-emerald-600" />}
            <Tile label={tier.tiles.find((t) => t.isRate)?.label || "Rate"} value={`${data?.conversion_rate ?? 0}%`} tone="border-violet-100 bg-violet-50/60 text-violet-600" />
            <Tile
              label={narrowed ? "Filtered Results" : "Showing All"}
              value={data?.filtered ?? "—"}
              tone={narrowed ? "border-sky-100 bg-sky-50/60 text-sky-600" : "border-slate-200 bg-slate-50 text-slate-500"}
            />
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-sm font-semibold text-slate-700">Lead Stage Breakdown</p>
            <div className="flex flex-wrap gap-2">
              {(data?.stages || []).length === 0 ? (
                <p className="text-xs text-slate-400">Nothing to break down yet.</p>
              ) : (data?.stages || []).map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setStage(stage === s.name ? "" : s.name)}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    stage === s.name ? "border-sky-400 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                  data-testid={`team-member-stage-${s.name}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${stage === s.name ? "bg-sky-500" : "bg-slate-400"}`} />
                  {s.name}: {s.value}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Filter className="h-4 w-4" /> Filters
              </p>
              {narrowed && (
                <button type="button" onClick={clear} className="text-xs font-semibold text-rose-600 hover:text-rose-800" data-testid="team-member-clear-filters">
                  Clear
                </button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="From Date">
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputCls} data-testid="team-member-from" />
              </Field>
              <Field label="To Date">
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputCls} data-testid="team-member-to" />
              </Field>
              <Field label="Source">
                <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls} data-testid="team-member-source">
                  <option value="">All Sources</option>
                  {(data?.sources || []).map((s) => <option key={s.name} value={s.name}>{s.name} ({s.value})</option>)}
                </select>
              </Field>
              <Field label="Stage">
                <select value={stage} onChange={(e) => setStage(e.target.value)} className={inputCls} data-testid="team-member-stage-select">
                  <option value="">All Stages</option>
                  {(data?.stages || []).map((s) => <option key={s.name} value={s.name}>{s.name} ({s.value})</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-sm font-semibold text-slate-700">
              Leads ({loading ? "…" : data?.filtered ?? 0})
              {!loading && (data?.filtered ?? 0) > (data?.leads || []).length && (
                <span className="ml-1 text-xs font-normal text-slate-400">· showing the first {(data?.leads || []).length}</span>
              )}
            </p>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              {loading ? (
                <p className="py-12 text-center text-sm text-slate-400">Loading...</p>
              ) : (data?.leads || []).length === 0 ? (
                <div className="py-12 text-center">
                  <Inbox className="mx-auto mb-2 h-8 w-8 text-slate-200" />
                  <p className="text-sm text-slate-400">No leads found.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">Lead</th>
                        <th className="px-3 py-3 text-left font-semibold">Contact</th>
                        <th className="px-3 py-3 text-left font-semibold">Source</th>
                        <th className="px-3 py-3 text-left font-semibold">Stage</th>
                        <th className="px-3 py-3 text-left font-semibold">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(data?.leads || []).map((l) => (
                        <tr key={l.id} className="hover:bg-slate-50" data-testid={`team-member-lead-${l.id}`}>
                          <td className="px-4 py-3">
                            <p className="truncate font-medium text-slate-800">{l.name}</p>
                            {l.branch_name && <p className="truncate text-[11px] text-slate-400">{l.branch_name}</p>}
                          </td>
                          <td className="px-3 py-3 text-slate-600">{displayPhone(l.phone) || "—"}</td>
                          <td className="px-3 py-3">
                            <span className="rounded-[5px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{l.source}</span>
                          </td>
                          <td className="px-3 py-3">
                            <span className="rounded-[5px] border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">{l.stage}</span>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-slate-500">{String(l.created_at || "").slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * `benchmarkFrom` is who the team average is computed over, and it is NOT always the rows
 * on screen.
 *
 * Filtering Pre-Sales to one branch should re-benchmark: those agents are peers doing the
 * same job in the same place, and how they compare with each other is the question.
 *
 * Filtering Branch Performance to one branch must NOT: a branch's peers are the other
 * branches, and measuring it against itself gives every branch a delta of zero forever.
 *
 * So the caller says which. Defaulting to the rows shown keeps every existing caller
 * behaving exactly as it did.
 */
export const TeamCard = ({ title, subtitle, members = [], kind, benchmarkFrom }) => {
  const tier = TEAM_TIERS[kind] || TEAM_TIERS.pre_sales;
  const Icon = tier.icon;
  const avg = teamRate(benchmarkFrom || members, tier.rate);
  const [openMember, setOpenMember] = useState(null);

  // Best rate first, so the person who needs help is findable rather than buried at
  // whatever position the roster happened to return them in.
  const rows = [...members].sort((a, b) => num(b[tier.rate.key]) - num(a[tier.rate.key]));

  return (
    <Card data-testid={`mk-team-${kind}-card`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className={`flex items-center gap-2 text-base ${tier.accent}`}>
              <Icon className="h-5 w-5 shrink-0" /> {title}
            </CardTitle>
            {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
          </div>
          {avg != null && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right" data-testid={`mk-team-${kind}-avg`}>
              <p className="text-sm font-bold text-slate-700">{Math.round(avg * 10) / 10}%</p>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Team avg</p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className={rows.length >= TABLE_FROM ? "p-0 sm:px-6 sm:pb-6" : "space-y-3"}>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">No members.</p>
        ) : rows.length >= TABLE_FROM ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Name</th>
                  {tier.tiles.map((t) => (
                    <th key={t.key} className="px-3 py-2.5 text-right font-semibold">{t.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => (
                  <tr
                    key={m.id}
                    onClick={() => setOpenMember(m)}
                    className="cursor-pointer hover:bg-slate-50"
                    data-testid={`mk-team-row-${m.id}`}
                  >
                    <td className="px-4 py-3">
                      <p className="truncate font-medium text-slate-800">{nameOf(m, tier)}</p>
                      <p className="truncate text-[11px] text-slate-400">{subOf(m, tier)}</p>
                    </td>
                    {tier.tiles.map((t) => (
                      <td key={t.key} className="px-3 py-3 text-right" data-testid={`mk-team-tile-${m.id}-${t.key}`}>
                        <p className={`font-semibold ${t.isRate ? rateTone(m[t.key], avg) : "text-slate-700"}`}>
                          {m[t.key] ?? 0}{t.suffix || ""}
                        </p>
                        {t.isRate && <Delta value={m[t.key]} team={avg} />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : rows.map((m) => (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            onClick={() => setOpenMember(m)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenMember(m); } }}
            className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50/60 p-3 transition hover:border-sky-300 hover:bg-white"
            data-testid={`mk-team-row-${m.id}`}
          >
            <div className="flex items-center gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold text-white ${tier.avatar}`}>
                {(nameOf(m, tier) || "?").trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold text-slate-800">{nameOf(m, tier)}</p>
                <p className="truncate text-xs text-slate-500">{subOf(m, tier)}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
            </div>
            <div className={`mt-3 grid gap-2 ${tier.tiles.length > 3 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
              {tier.tiles.map((t) => (
                <div key={t.key} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-center" data-testid={`mk-team-tile-${m.id}-${t.key}`}>
                  <p className={`truncate text-xl font-bold ${t.isRate ? rateTone(m[t.key], avg) : "text-slate-800"}`}>
                    {m[t.key] ?? 0}{t.suffix || ""}
                  </p>
                  <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t.label}</p>
                  {t.isRate && <Delta value={m[t.key]} team={avg} />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>

      {openMember && (
        <MemberLeadsModal member={openMember} tier={tier} onClose={() => setOpenMember(null)} />
      )}
    </Card>
  );
};

export default TeamCard;
