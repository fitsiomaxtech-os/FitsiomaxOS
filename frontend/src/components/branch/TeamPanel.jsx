import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { getTeam } from "@/lib/api";
import { displayPhone, telNumber } from "@/lib/phone";

/**
 * Activity Care's Team Consultants and Team Physio tabs: every consultant, or every physio,
 * in the organisation, one to a row — S.No, name, branch, phone, gender, status and an
 * arrow — narrowed by branch and by gender.
 */
const KINDS = {
  consultants: { plural: "consultants" },
  physio: { plural: "physios" },
};

const GENDER_LABEL = { male: "Male", female: "Female" };

const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "");

/**
 * The OS's own dropdown, as Branch Leads' list filters wear it: sky while it is narrowing the
 * list, plain while it is on its "all" answer, and a capped menu that scrolls.
 */
const FilterSelect = ({ value, onChange, allLabel, options, label, testid }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger
      title={label}
      aria-label={label}
      className={`h-9 min-w-0 flex-1 rounded-md border px-2.5 text-xs font-medium shadow-none transition-colors focus:ring-2 focus:ring-sky-200 lg:w-44 lg:flex-none ${
        value !== "all" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
      data-testid={testid}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent className="max-h-72 border-slate-200" data-testid={`${testid}-menu`}>
      <SelectItem value="all" className="text-xs font-medium text-slate-500">{allLabel}</SelectItem>
      {options.map(([v, text]) => (
        <SelectItem key={v} value={v} className="text-xs text-slate-700">{text}</SelectItem>
      ))}
    </SelectContent>
  </Select>
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

const StatusChip = ({ status }) => (
  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
    {capitalise(status) || "—"}
  </span>
);

const Phone = ({ phone }) => (
  phone ? (
    <a href={`tel:${telNumber(phone)}`} className="text-slate-600 hover:text-sky-700" onClick={(e) => e.stopPropagation()}>
      {displayPhone(phone)}
    </a>
  ) : (
    <span className="text-slate-400">—</span>
  )
);

// toolbarSlot: the right end of Activity Care's tab strip. From lg up the filters and Refresh
// sit there, on the tabs' line; below lg, and when no slot is given, they sit above the table.
export const TeamPanel = ({ kind, toolbarSlot = null }) => {
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
      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
      title="Open"
      aria-label={`Open ${m.full_name}`}
      data-testid={`team-open-${m.id}`}
    >
      <ChevronRight className="h-4 w-4" />
    </button>
  );

  const filters = (
    <>
      <FilterSelect
        value={branch}
        onChange={setBranch}
        label="Branch"
        allLabel="All Branches"
        options={data.branches.map((b) => [b.id, b.name])}
        testid={`team-branch-filter-${kind}`}
      />
      <FilterSelect
        value={gender}
        onChange={setGender}
        label="Gender"
        allLabel="Male & Female"
        options={[["male", "Male"], ["female", "Female"]]}
        testid={`team-gender-filter-${kind}`}
      />
      <Button onClick={load} disabled={loading} className="h-9 w-9 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600" title="Refresh" aria-label="Refresh">
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-3" data-testid={`team-panel-${kind}`}>
      {toolbarSlot && createPortal(filters, toolbarSlot)}
      <div className={`flex items-center gap-2 ${toolbarSlot ? "lg:hidden" : ""}`}>{filters}</div>

      {loading && data.members.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-xs text-slate-400">Loading {k.plural}…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center text-xs text-slate-400">
          No {k.plural} match these filters.
        </p>
      ) : (
        <>
          {/* Phone: one row each, branch and phone under the name. */}
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden">
            {visible.map((m, i) => (
              <div key={m.id} className="flex items-center gap-3 p-3" data-testid={`team-row-${m.id}`}>
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{m.full_name}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {branchText(m)}{m.phone && <> · <Phone phone={m.phone} /></>}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <GenderChip gender={m.gender} />
                  {m.status !== "active" && <StatusChip status={m.status} />}
                </div>
                {arrow(m)}
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
            <table className="min-w-full text-sm">
              {/* A light header, not the slate-500 bar the other tables wear. */}
              <thead className="border-b border-slate-200 bg-slate-100 text-left text-xs uppercase text-slate-600">
                <tr>
                  <th className="w-16 px-4 py-2.5">S.No</th>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Gender</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="w-20 px-4 py-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((m, i) => (
                  <tr key={m.id} className="hover:bg-slate-50" data-testid={`team-tr-${m.id}`}>
                    <td className="px-4 py-3 tabular-nums text-slate-400">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                          {m.full_name?.charAt(0)?.toUpperCase() || "?"}
                        </span>
                        <span className="font-medium text-slate-800">{m.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{branchText(m)}</td>
                    <td className="whitespace-nowrap px-4 py-3"><Phone phone={m.phone} /></td>
                    <td className="px-4 py-3"><GenderChip gender={m.gender} /></td>
                    <td className="px-4 py-3"><StatusChip status={m.status} /></td>
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
