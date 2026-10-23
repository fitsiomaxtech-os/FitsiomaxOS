import { useEffect, useMemo, useState } from "react";
import { X, Layers, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { bmCreateWithExistingAdmin, updateBranch, getVerticals } from "@/lib/api";
import { MilkDateInput, CenteredPicker } from "@/components/ui/milk-calendar";
import { LeadControlSwitch, normalizeLeadControl, BRANCH_ADMIN, BOTH } from "@/components/branch/LeadControlSwitch";
import { serviceTypeColor, serviceTypeLabel, serviceTypeChipStyle } from "@/lib/serviceTypes";

// Opening Hours, Finance Summary and CONSULTANT were tabs here. Each is reachable from
// the branch's own detail page, which is where a branch is actually read; behind a tab in
// an edit dialog they were three screens someone had to know to look inside a form for.
//
// DAYS and the weekly-hours shape below stay: the hours are still part of what this form
// saves, so they have to be carried through untouched. Dropping them from the payload
// would blank a branch's opening hours the first time anyone edited its phone number.
const DAYS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

const defaultDay = { is_open: true, open: "09:00", close: "20:00" };
const emptyWeekly = () => Object.fromEntries(DAYS.map((d) => [d.key, { ...defaultDay }]));

// Every default vertical is named "online_..."/"offline_..." — mode is read straight
// off that prefix rather than stored as a separate field, so the two can never disagree.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

/**
 * The branch's service type, picked from the OS's own chips rather than a browser menu.
 *
 * A native <select> cannot be styled — its typography, its blue highlight and its chrome
 * belong to the operating system, not this one — and this list in particular had somewhere
 * to look instead: the Service Type manager, one button away on the same toolbar, already
 * draws each type as a coloured chip. A type chosen here and the same type listed there
 * should not be two different-looking things, so this wears the manager's clothes and both
 * take their colour from the shared helper rather than from a position in a list.
 */
const VerticalPicker = ({ options, value, onChange, testid = "bf2-vertical" }) => {
  const [open, setOpen] = useState(false);
  const color = serviceTypeColor(value);
  const chip = serviceTypeChipStyle(color);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-200 px-3 text-left"
        data-testid={testid}
      >
        {value ? (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={chip.glyph}>
              <Layers className="h-3.5 w-3.5" style={chip.icon} />
            </span>
            {/* The OS's small-caps label, the same treatment the manager's chips carry: a
                service type is a tag on a branch, not prose, and it reads as one here. */}
            <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-slate-600">
              {serviceTypeLabel(value)}
            </span>
          </span>
        ) : (
          <span className="text-sm text-slate-400">Choose a service type…</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      {open && (
        <CenteredPicker title="Service Type" onClose={() => setOpen(false)} testid={`${testid}-modal`}>
          {options.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-slate-400">
              No service type matches this mode yet. Add one from Service Type on the toolbar.
            </p>
          ) : (
            <div className="grid gap-2" data-testid={`${testid}-list`}>
              {options.map((v) => {
                const c = serviceTypeColor(v);
                const s = serviceTypeChipStyle(c);
                const selected = v === value;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { onChange(v); setOpen(false); }}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition hover:shadow-sm ${
                      selected ? "ring-2 ring-offset-1" : ""
                    }`}
                    style={{ ...s.tile, ...(selected ? { "--tw-ring-color": c } : {}) }}
                    data-testid={`${testid}-option-${v}`}
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={s.glyph}>
                      <Layers className="h-3.5 w-3.5" style={s.icon} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold uppercase tracking-wide text-slate-600" title={v}>
                      {serviceTypeLabel(v)}
                    </span>
                    {selected && <Check className="h-4 w-4 shrink-0" style={s.icon} />}
                  </button>
                );
              })}
            </div>
          )}
        </CenteredPicker>
      )}
    </>
  );
};

export const BranchFormDialogV2 = ({ branch, onClose, onSaved }) => {
  const isEdit = !!branch;
  const [mode, setMode] = useState(() => (isOnlineVertical(branch?.vertical) ? "online" : "offline"));
  const [form, setForm] = useState({
    branch_name: branch?.branch_name || "",
    code: branch?.code || "",
    address: branch?.address || "",
    admin_phone: branch?.admin_phone || "",
    phone: branch?.phone || "",
    email: branch?.email || "",
    map_location: branch?.map_location || "",
    opened_date: branch?.opened_date || "",
    vertical: branch?.vertical || "offline_physiotherapy",
    lead_control: normalizeLeadControl(branch?.lead_control),
  });
  /**
   * Service types come from the list Service Type manages, not a literal.
   *
   * This select hardcoded three options, so a type added on the Service Type tab — or in
   * the new dropdown on MANAGER — could never be given to a branch, which is the only
   * reason to add one. The three remain as the fallback for a failed or empty fetch.
   */
  const [verticalOptions, setVerticalOptions] = useState([]);

  useEffect(() => {
    let alive = true;
    getVerticals()
      .then((rows) => { if (alive) setVerticalOptions((rows || []).map((r) => r.name).filter(Boolean)); })
      .catch(() => { if (alive) setVerticalOptions([]); });
    return () => { alive = false; };
  }, []);

  // Narrowed to whichever mode (Online/Offline) is picked above, so the dropdown only
  // ever offers verticals consistent with it. Whatever this branch already carries stays
  // in the list even if it's since been removed, so opening an old branch can't silently
  // reassign its vertical on save.
  const verticals = useMemo(() => {
    const base = verticalOptions.length
      ? verticalOptions
      : ["offline_physiotherapy", "online_physiotherapy", "fitness"];
    const matching = base.filter((v) => isOnlineVertical(v) === (mode === "online"));
    if (form.vertical && !matching.includes(form.vertical) && isOnlineVertical(form.vertical) === (mode === "online")) {
      return [form.vertical, ...matching];
    }
    return matching;
  }, [verticalOptions, form.vertical, mode]);

  // Switching mode drops any vertical that no longer matches it, rather than letting
  // "Online" sit selected next to a still-picked offline vertical.
  const changeMode = (nextMode) => {
    setMode(nextMode);
    if (isOnlineVertical(form.vertical) !== (nextMode === "online")) {
      const base = verticalOptions.length ? verticalOptions : ["offline_physiotherapy", "online_physiotherapy", "fitness"];
      const firstMatch = base.find((v) => isOnlineVertical(v) === (nextMode === "online")) || "";
      setForm((p) => ({ ...p, vertical: firstMatch, address: nextMode === "online" ? "" : p.address }));
    }
  };

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.branch_name.trim() || (mode === "offline" && !form.address.trim())) {
      // These used to switch back to the details tab before complaining. There is only one
      // panel now, so the field the message names is already on screen.
      toast.error(mode === "offline" ? "Branch name + address required" : "Branch name required"); return;
    }
    try {
      if (isEdit) {
        // Opening hours and holidays are deliberately absent. This form no longer shows
        // them, and a form must not write a field it does not display: sending them back
        // would have blanked a branch's hours, or invented a default week for one that had
        // none, every time somebody corrected a phone number. Left out of the payload, the
        // stored values are simply not touched.
        await updateBranch(branch.id, {
          branch_name: form.branch_name, code: form.code || undefined, address: form.address, admin_phone: form.admin_phone,
          phone: form.phone, email: form.email, map_location: form.map_location,
          opened_date: form.opened_date, vertical: form.vertical, lead_control: form.lead_control,
        });
        toast.success("Branch updated");
      } else {
        // A new branch still opens on the standard week, exactly as before — there is
        // nothing to preserve on a branch that does not exist yet, and a branch with no
        // hours at all reads as closed on the calendar.
        // No admin, no phones, no email: a branch that does not exist yet has nobody
        // running it and no front desk to ring. Those four are set on the branch itself
        // once it is on the board — see the note on the create form below.
        await bmCreateWithExistingAdmin({
          branch_name: form.branch_name, code: form.code || undefined, address: form.address,
          map_location: form.map_location,
          opened_date: form.opened_date, vertical: form.vertical, lead_control: form.lead_control,
          weekly_hours: emptyWeekly(), holidays: [],
        });
        toast.success("Branch created — open it to assign its Branch Admin.");
      }
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="branch-form-v2-dialog">
      <div className="w-full max-w-3xl rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{isEdit ? `Edit Branch — ${branch.branch_name}` : "Create New Branch"}</h3>
            {/* Named what this form now does. It promised opening hours and financials,
                which were the three tabs that have gone. */}
            <p className="text-xs text-slate-500">{isEdit ? "Update this branch's details." : "Fill in the branch's details. Its Branch Admin and contact numbers are set on the branch once it exists."}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="bf2-close"><X className="h-4 w-4" /></button>
        </div>

        {/* The tab strip went with the three tabs behind it. One tab is not a choice, and
            a lone "Branch Details" pill under a heading that already says Edit Branch is a
            control that does nothing. */}
        <div className="max-h-[60vh] overflow-y-auto p-5">
          {(
            <div className="grid gap-3 sm:grid-cols-2" data-testid="bf2-details-tab">
              <Field label="Mode" className="sm:col-span-2">
                <div className="inline-flex rounded-md border border-slate-200 p-0.5" data-testid="bf2-mode">
                  {["offline", "online"].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => changeMode(m)}
                      className={`rounded px-4 py-1.5 text-sm font-medium capitalize transition ${mode === m ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                      data-testid={`bf2-mode-${m}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {mode === "online" && <p className="mt-1.5 text-[11px] text-slate-400">No physical address needed for an online branch.</p>}
              </Field>
              <Field label="Branch Name *"><Input value={form.branch_name} onChange={(e) => set("branch_name", e.target.value)} data-testid="bf2-name" placeholder="e.g. Anna Nagar" /></Field>
              <Field label="Branch Code">
                <Input
                  value={form.code}
                  onChange={(e) => set("code", e.target.value.toUpperCase())}
                  placeholder="Auto-generated if left blank, e.g. ANN"
                  maxLength={10}
                  data-testid="bf2-code"
                />
                <p className="mt-1 text-[11px] text-slate-400">Prefixes every patient's unique Patient Number at this branch (e.g. ANN-260727-0000).</p>
              </Field>
              <Field label="Vertical">
                <VerticalPicker options={verticals} value={form.vertical} onChange={(v) => set("vertical", v)} />
              </Field>
              {/* Edit only, and read-only at that. Picking a Branch Admin while creating
                  a branch forced the order backwards — the admin's HR record had to exist
                  before the branch they run. The branch is created unassigned now, and its
                  admin is set from the branch card ("Assign Branch Admin →") or its detail
                  page after the employee has been added and given credentials. */}
              {isEdit && (
                <>
                  <Field label="Branch Admin">
                    <div className="h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm flex items-center text-slate-600">{branch.admin_name || "Unassigned"} <span className="ml-2 text-[10px] text-slate-400">(assign via Detail page)</span></div>
                  </Field>
                  <Field label="Admin Phone"><Input value={form.admin_phone} onChange={(e) => set("admin_phone", e.target.value)} placeholder="+91 …" data-testid="bf2-admin-phone" /></Field>
                  <Field label="Branch Phone"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Front-desk phone" data-testid="bf2-phone" /></Field>
                  <Field label="Branch Email"><Input value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="branch@example.com" data-testid="bf2-email" /></Field>
                </>
              )}
              {mode === "offline" && (
                <Field label="Address *" className="sm:col-span-2"><Input value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, City, PIN" data-testid="bf2-address" /></Field>
              )}
              <Field label="Opened Date"><MilkDateInput  value={form.opened_date} onChange={(e) => set("opened_date", e.target.value)} data-testid="bf2-opened-date" /></Field>
              <Field label="Map Location" className="sm:col-span-1">
                <Input value={form.map_location} onChange={(e) => set("map_location", e.target.value)} placeholder="Google Maps URL or lat,lng" data-testid="bf2-map" />
                {form.map_location && <a href={form.map_location.startsWith("http") ? form.map_location : `https://www.google.com/maps?q=${encodeURIComponent(form.map_location)}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[11px] text-sky-600 hover:underline" data-testid="bf2-map-preview">Open in Google Maps →</a>}
              </Field>
              {/* Last in the grid and spanning it: this one changes who works the
                  branch's leads, so it reads as its own decision rather than as one
                  more contact field. */}
              <Field label="Lead Control" className="sm:col-span-2">
                <LeadControlSwitch value={form.lead_control} onChange={(v) => set("lead_control", v)} testid="bf2-lead-control" />
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {form.lead_control === BRANCH_ADMIN
                    ? "This branch's leads skip the Pre-Sales pipeline and go straight to the Branch Admin. No Pre-Sales rep is assigned."
                    : form.lead_control === BOTH
                    ? "Both Pre-Sales and the Branch Admin manage this branch's leads at the same time."
                    : "New leads land in the Pre-Sales pipeline first and are shared out across the Pre-Sales team."}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Applies to leads already in the pipeline too, not only new ones. Leads with no branch yet always stay with Pre-Sales.
                </p>
              </Field>
            </div>
          )}

        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="bf2-cancel">Cancel</Button>
          <Button onClick={submit} className="bg-sky-600 hover:bg-sky-700" data-testid="bf2-submit">{isEdit ? "Save Changes" : "Create Branch"}</Button>
        </div>
      </div>
    </div>
  );
};

const Field = ({ label, children, className = "" }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="text-xs font-medium text-slate-700">{label}</label>
    {children}
  </div>
);

export default BranchFormDialogV2;
