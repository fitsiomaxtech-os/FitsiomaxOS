import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getTeam } from "@/lib/api";

/**
 * Activity Care's Team Consultants and Team Physio tabs: every consultant, or every physio,
 * in the organisation, one to a row — name, branch, gender, and an arrow — narrowed by
 * branch and by gender.
 */
const KINDS = {
  consultants: { noun: "Consultant", plural: "consultants" },
  physio: { noun: "Physio", plural: "physios" },
};

const GENDER_LABEL = { male: "Male", female: "Female" };

/** The same dropdown as the Fitness form's, sized for a filter bar. */
const FilterSelect = ({ value, onChange, children, testid }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-sky-400 focus:outline-none sm:w-52 sm:flex-none"
    data-testid={testid}
  >
    {children}
  </select>
);

const branchText = (m) => (m.all_branches ? "All Branches" : m.branches.map((b) => b.name).join(", ") || "—");

const GenderChip = ({ gender }) => (
  gender ? (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${gender === "female" ? "bg-pink-50 text-pink-700" : "bg-sky-50 text-sky-700"}`}>
      {GENDER_LABEL[gender]}
    </span>
  ) : (
    <span className="text-slate-400">—</span>
  )
);

export const TeamPanel = ({ kind }) => {
  const k = KINDS[kind];
  const [data, setData] = useState({ members: [], branches: [] });
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState("all");
  const [gender, setGender] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getTeam(kind));
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Couldn't load the ${k.plural}`);
    }
    setLoading(false);
  }, [kind, k.plural]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => data.members.filter((m) =>
    (branch === "all" || m.all_branches || m.branches.some((b) => b.id === branch))
    && (gender === "all" || m.gender === gender)
  ), [data.members, branch, gender]);

  // Where the arrow will lead is still to be decided.
  const open = (m) => toast(`${m.full_name} — details coming soon`);

  const arrow = (m) => (
    <button
      type="button"
      onClick={() => open(m)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-sky-600 transition hover:bg-sky-50"
      title="Open"
      aria-label={`Open ${m.full_name}`}
      data-testid={`team-open-${m.id}`}
    >
      <ArrowRight className="h-4 w-4" />
    </button>
  );

  return (
    <div className="flex flex-col gap-3" data-testid={`team-panel-${kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect value={branch} onChange={setBranch} testid={`team-branch-filter-${kind}`}>
          <option value="all">All Branches</option>
          {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </FilterSelect>
        <FilterSelect value={gender} onChange={setGender} testid={`team-gender-filter-${kind}`}>
          <option value="all">Male &amp; Female</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </FilterSelect>
        <span className="ml-auto text-xs text-slate-500" data-testid={`team-count-${kind}`}>
          {visible.length} of {data.members.length}
        </span>
        <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && data.members.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-xs text-slate-400">Loading {k.plural}…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-xs text-slate-400">
          No {k.plural} match these filters.
        </p>
      ) : (
        <>
          {/* Phone: one row each, the branch under the name. */}
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden">
            {visible.map((m) => (
              <div key={m.id} className="flex items-center gap-3 p-3" data-testid={`team-row-${m.id}`}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                  {m.full_name?.charAt(0)?.toUpperCase() || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{m.full_name}</p>
                  <p className="truncate text-[11px] text-slate-500">{branchText(m)}</p>
                </div>
                <GenderChip gender={m.gender} />
                {arrow(m)}
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-500 text-left text-xs uppercase text-white">
                <tr>
                  <th className="px-4 py-2.5">{k.noun} Name</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Gender</th>
                  <th className="w-20 px-4 py-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50" data-testid={`team-tr-${m.id}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                          {m.full_name?.charAt(0)?.toUpperCase() || "?"}
                        </span>
                        <span className="font-medium text-slate-800">{m.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{branchText(m)}</td>
                    <td className="px-4 py-3"><GenderChip gender={m.gender} /></td>
                    <td className="px-4 py-3"><div className="flex justify-center">{arrow(m)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
