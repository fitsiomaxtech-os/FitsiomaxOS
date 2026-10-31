import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectOrType } from "@/components/ui/select-or-type";
import { ThemedSelect } from "@/components/ui/themed-select";
import { toast } from "@/components/ui/sonner";
import { createManualLead, getBranches } from "@/lib/api";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { loadSession } from "@/lib/session";
import { isOnlineServiceType, serviceTypeTitle, useServiceTypes } from "@/lib/serviceTypes";

// Suggestions, not a closed list: Source is typed by hand here, so a lead that came in
// over the phone from a channel nobody has named yet can still be filed as what it was
// rather than as "Other". "CSV Import" and "Google Sheets" are left out on purpose --
// those are stamped by the importers themselves (see backend/routers/v3_google_sheets.py),
// and a lead somebody is typing into this form by definition did not arrive off a sheet.
// Exported for LeadEditModal, so correcting a source offers the same channels as filing one.
export const SOURCE_SUGGESTIONS =["Meta", "SEO", "Referral", "Walk-In", "Website", "Instagram", "WhatsApp", "Phone Call", "Other"];
/**
 * Department is a service type: the list Branch Manager > Service Type keeps, offered as
 * it stands there, so a type added there can be given to a lead without a code change.
 *
 * Whatever the lead already carries is kept at the top even when the list no longer holds
 * it -- the four this field offered before it read that list, a type since deleted, a lock
 * set by an arm's board -- so the form never shows a filed lead as having none.
 *
 * Exported for LeadEditModal, so correcting a department offers what filing one did.
 */
export const departmentOptions = (serviceTypes, current) =>
  (current && !serviceTypes.includes(current) ? [current, ...serviceTypes] : serviceTypes)
    .map((name) => ({ value: name, label: serviceTypeTitle(name) }));

/** Whether a lead in this department is seen at a branch. Every type but an online one is:
 *  "Both Service" or "Multiple Services" still has a floor somebody walks onto. */
export const departmentHasBranch = (department) => !!department && !isOnlineServiceType(department);
const GENDER_OPTIONS = ["Male", "Female", "Other"];
// Phone-only sizing, every class below `max-sm:` so the desktop form is untouched: controls
// a notch shorter with 14px text, and the short fields two to a row. PHONE_WIDE marks a
// field that keeps a whole row to itself there -- a name, an email, an address.
const PHONE_CONTROL = "max-sm:h-8 max-sm:text-sm";
const PHONE_WIDE = "max-sm:col-span-2";
const GRID = "grid gap-x-4 gap-y-3 max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:gap-y-2 sm:grid-cols-2 lg:grid-cols-4";

/**
 * The ad record a lead arrived on — Meta's own lead export, field for field, in the order
 * Meta writes it. Its own tab rather than more rows under Patient Details, because it
 * answers a different question about the same person: Lead Details is who they are and
 * what hurts, this is which advert we paid for to hear from them.
 *
 * Names match Meta's export exactly, so a row pasted across needs no translating. Two of
 * them collide with the lead's own — this `id` is Meta's lead id, and `created_time` is
 * when Meta captured the form, not when we stored it — which is why the whole block is
 * sent nested under `lead_data` rather than flattened onto the lead. See V3LeadData in
 * backend/schemas/v3.py.
 */
export const LEAD_DATA_FIELDS = [
  { key: "id", label: "Lead ID", placeholder: "Meta's own lead id" },
  { key: "created_time", label: "Created Time", placeholder: "2026-08-31T10:30:00+0530" },
  { key: "ad_id", label: "Ad ID", placeholder: "e.g. 23851234567890123" },
  { key: "ad_name", label: "Ad Name", placeholder: "e.g. Back Pain — Video A" },
  { key: "adset_id", label: "Adset ID", placeholder: "e.g. 23851234567890456" },
  { key: "adset_name", label: "Adset Name", placeholder: "e.g. Chennai 25-54" },
  { key: "campaign_id", label: "Campaign ID", placeholder: "e.g. 23851234567890789" },
  { key: "campaign_name", label: "Campaign Name", placeholder: "e.g. Anna Nagar Leads Aug" },
  { key: "form_id", label: "Form ID", placeholder: "e.g. 987654321012345" },
  { key: "form_name", label: "Form Name", placeholder: "e.g. Free Consultation Form" },
  // Three answers rather than a checkbox: blank means nobody has said, and that is the
  // honest state of a lead somebody typed in by hand.
  { key: "is_organic", label: "Is Organic", type: "select", options: [["", "—"], ["true", "Yes"], ["false", "No"]] },
  { key: "platform", label: "Platform", type: "select", options: [["", "—"], ["fb", "Facebook (fb)"], ["ig", "Instagram (ig)"]] },
];

const blankLeadData = Object.fromEntries(LEAD_DATA_FIELDS.map((f) => [f.key, ""]));

const blank = {
  name: "", source_tab: "", email: "", phone: "", alternative_phone: "",
  address: "", city: "", state: "", department: "", condition: "",
  months_of_pain: "", age: "", gender: "", occupation: "",
  expected_consultation_date: "", branch_id: "",
};

/**
 * @param lockedDepartment A service type's name, fixing the Department instead
 *   of offering it. Passed by a board that finds its own leads by the vertical this field
 *   decides — an online arm's — where leaving it open would let somebody file a lead into
 *   another arm from a board that then could not show it back to them.
 * @param formQuestions The intake questions this board's own form asks, as
 *   `{ key, label, question }` — the Online Fitness board passes its three. Rendered as
 *   their own section and written into extra_fields under `question`, which is the key the
 *   sheet importer files an answer under and the key that board's columns read back. A
 *   lead typed in here and one that arrived off the sheet then land in the same place.
 *   Empty for every board that has none, and the section is then not drawn at all.
 * @param branchPicker Draws Branch as a field of its own, whatever the Department -- the
 *   Business Development board's Add Lead, the desk that routes every lead it types in. A
 *   branch picked there is sent as picked. Everywhere else an online Department still
 *   clears it, and the Offline-only list under the fields stays the way a lead gets one.
 */
export const CreateLeadModal = ({ onClose, onSaved, branchId = null, lockedDepartment = null, formQuestions = [], branchPicker = false }) => {
  const [form, setForm] = useState({
    ...blank,
    ...(branchId ? { branch_id: branchId } : {}),
    ...(lockedDepartment ? { department: lockedDepartment } : {}),
  });
  const [leadData, setLeadData] = useState(blankLeadData);
  const [tab, setTab] = useState("details");
  const [extraFields, setExtraFields] = useState({});
  const [branches, setBranches] = useState([]);
  const [saving, setSaving] = useState(false);
  const serviceTypes = useServiceTypes();

  useEffect(() => {
    getBranches().then(setBranches).catch((e) => console.warn("[load failed]", e?.message || e));
  }, []);

  // The picker's own order, the one every other branch list in the OS uses: offline
  // branches first, alphabetical, the online arms trailing.
  const pickerBranches = [...branches].sort((a, b) => {
    const online = (v) => String(v || "").startsWith("online_");
    return online(a.vertical) - online(b.vertical)
      || String(a.branch_name || "").localeCompare(String(b.branch_name || ""));
  });
  const showPicker = branchPicker && !branchId;

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const setExtra = (k, v) => setExtraFields((p) => ({ ...p, [k]: v }));
  const setLD = (k, v) => setLeadData((p) => ({ ...p, [k]: v }));

  // Read off the session rather than from whichever board opened this form — Branch
  // Admin's board can be opened by a Super Admin through Operations — because this tab is
  // about who is looking. The
  // server withholds the same block from everybody else on the way back out (see
  // reads_lead_data in backend/deps.py), so hiding it here is the courtesy, not the lock.
  const isSuperAdminUser = String(loadSession()?.user?.role || "").trim().toLowerCase() === "super_admin";

  const submit = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      // Back to the tab the missing field is on, so the complaint points at something the
      // user can actually see. Both required fields live on Lead Details.
      setTab("details");
      toast.error("Name and phone are required");
      return;
    }
    const payload = { ...form };
    payload.extra_fields = extraFields;
    if (isSuperAdminUser) {
      const filled = Object.entries(leadData)
        .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
        .filter(([, v]) => v !== "");
      // Left off entirely when the tab was never touched, rather than sent as a dozen
      // empty strings — a lead with no advert behind it should read as having none, not
      // as having been asked and answered blank.
      if (filled.length) {
        payload.lead_data = Object.fromEntries(
          filled.map(([k, v]) => [k, k === "is_organic" ? v === "true" : v]),
        );
      }
    }
    if (payload.months_of_pain === "") payload.months_of_pain = null;
    else payload.months_of_pain = Number(payload.months_of_pain);
    if (payload.age === "") payload.age = null;
    else payload.age = Number(payload.age);
    if (branchId) payload.branch_id = branchId;
    else if (!showPicker && !departmentHasBranch(payload.department)) payload.branch_id = "";
    payload.source_type = "manual";
    // Left blank, the lead reads as "Manual" rather than as an empty channel -- the
    // dashboards group on source_tab and an empty string would be its own silent bucket.
    payload.source_tab = String(payload.source_tab || "").trim() || "Manual";
    // The service type picked is the vertical, as it is a branch's: the boards and the
    // dashboards file a lead by its vertical, and the online arms' boards find theirs by it
    // (vertical_in_arm in backend/deps.py). Left blank, it is filed as it always was.
    payload.vertical = payload.department || "offline_physiotherapy";
    // One request at a time: a second click while the first is still out would file the
    // same patient twice, or stack one failure toast per click.
    if (saving) return;
    setSaving(true);
    try {
      await createManualLead(payload);
      toast.success("Lead created");
      onSaved && onSaved();
      onClose();
    } catch (e) {
      // A refusal the server explains comes back as `detail`. Anything else -- a crash
      // (500), a gateway that gave up (502/504), or no answer at all -- used to read as a
      // bare "Create failed", which says nothing about which of those it was. The status,
      // or the fact that nothing came back, is what tells them apart.
      console.error("[create lead failed]", e);
      const status = e?.response?.status;
      toast.error(
        e?.response?.data?.detail
          || (status ? `Create failed — server error ${status}` : "Create failed — could not reach the server"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    // z-[60], LeadEditModal's level, rather than z-40: the phone bottom navs are z-40 and
    // come later in the page, so at the same level they drew over this form's footer and
    // hid Create Lead. The date picker's own overlay sits at z-[70], still above this.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 max-sm:p-0" data-testid="create-lead-modal">
      {/* Four fields to a row on a wide screen so the whole form, footer included, fits
          the window without scrolling. Capped at the window height all the same, so on a
          short one only the fields scroll and Create Lead stays in sight. On a phone the
          card is nine tenths of the screen each way, the backdrop showing round it. */}
      <div className="flex max-h-full w-full max-w-4xl flex-col rounded-lg bg-white shadow-2xl max-sm:max-h-[90%] max-sm:w-[90%]">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-3.5 max-sm:px-4 max-sm:py-2.5">
          <h3 className="text-xl font-bold text-slate-900 max-sm:text-lg">Add New Lead</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="lead-create-close"><X className="h-5 w-5" /></button>
        </div>

        {/* Only a Super Admin gets a second tab, so for everyone else the form stays the
            single uninterrupted page it has always been rather than one lone tab with
            nothing beside it. */}
        {isSuperAdminUser && (
          <div className="flex shrink-0 gap-1 border-b border-slate-200 px-6 max-sm:px-4" data-testid="lead-create-tabs">
            {[
              { key: "details", label: "Lead Details" },
              { key: "lead_data", label: "Lead Data" },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition max-sm:px-3 max-sm:py-2 ${
                  tab === t.key
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
                data-testid={`lead-create-tab-${t.key}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Both panels stay mounted and one is hidden: switching tabs must not empty the
            one you left, and a half-filled ad record is exactly the thing somebody would
            tab away from mid-entry. */}
        <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 max-sm:space-y-3 max-sm:px-4 max-sm:py-3 ${tab === "details" ? "" : "hidden"}`} data-testid="lead-create-panel-details">
          {/* Standard fields */}
          <div className={GRID}>
            <Field label="Name *" className={PHONE_WIDE}><Input className={PHONE_CONTROL} value={form.name} onChange={(e) => set("name", e.target.value)} data-testid="lead-create-name" /></Field>
            <Field label="Phone *"><Input className={PHONE_CONTROL} value={form.phone} onChange={(e) => set("phone", e.target.value)} data-testid="lead-create-phone" /></Field>
            <Field label="Alternative Phone"><Input className={PHONE_CONTROL} value={form.alternative_phone} onChange={(e) => set("alternative_phone", e.target.value)} data-testid="lead-create-altphone" /></Field>
            <Field label="Email" className={PHONE_WIDE}><Input className={PHONE_CONTROL} value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="lead-create-email" /></Field>
            <Field label="Source" className={PHONE_WIDE}>
              {/* The common channels in the themed list, and "Type manually…" for anything
                  else, so a channel nobody has named yet is still filed as what it was. */}
              <SelectOrType
                className={PHONE_CONTROL}
                options={SOURCE_SUGGESTIONS}
                value={form.source_tab}
                onChange={(v) => set("source_tab", v)}
                placeholder="Select source"
                manualPlaceholder="Type the source"
                testid="lead-create-source"
              />
            </Field>
            <Field label="Address" className={PHONE_WIDE}><Input className={PHONE_CONTROL} value={form.address} onChange={(e) => set("address", e.target.value)} data-testid="lead-create-address" /></Field>
            <Field label="City"><Input className={PHONE_CONTROL} value={form.city} onChange={(e) => set("city", e.target.value)} data-testid="lead-create-city" /></Field>
            <Field label="State"><Input className={PHONE_CONTROL} value={form.state} onChange={(e) => set("state", e.target.value)} data-testid="lead-create-state" /></Field>
          </div>

          {/* Physio Patient Details */}
          <div className="rounded-lg border border-slate-200 p-4 max-sm:p-3">
            <div className={GRID}>
              <Field label="Department" className={PHONE_WIDE}>
                {/* Shown rather than hidden where it is fixed: the department decides which
                    board the lead lands on, and that is worth saying out loud on the form
                    that decides it. Disabled, not removed, so the answer is still read. */}
                <ThemedSelect
                  className={PHONE_CONTROL}
                  value={form.department}
                  disabled={!!lockedDepartment}
                  title={lockedDepartment ? "Set by the board you are creating this lead from" : undefined}
                  onChange={(v) => set("department", v)}
                  placeholder="Select Department"
                  options={[{ value: "", label: "Select Department" }, ...departmentOptions(serviceTypes, form.department)]}
                  testid="lead-create-department"
                />
              </Field>
              <Field label="Condition / Pain Area" className={PHONE_WIDE}><Input className={PHONE_CONTROL} value={form.condition} onChange={(e) => set("condition", e.target.value)} data-testid="lead-create-condition" /></Field>
              <Field label="Months of Pain"><Input className={PHONE_CONTROL} type="number" min="0" value={form.months_of_pain} onChange={(e) => set("months_of_pain", e.target.value)} data-testid="lead-create-months" /></Field>
              <Field label="Age"><Input className={PHONE_CONTROL} type="number" min="0" value={form.age} onChange={(e) => set("age", e.target.value)} data-testid="lead-create-age" /></Field>
              <Field label="Gender"><ThemedSelect className={PHONE_CONTROL} value={form.gender} onChange={(v) => set("gender", v)} options={["", ...GENDER_OPTIONS]} testid="lead-create-gender" /></Field>
              <Field label="Occupation"><Input className={PHONE_CONTROL} value={form.occupation} onChange={(e) => set("occupation", e.target.value)} data-testid="lead-create-occupation" /></Field>
              <Field label="Expected Consultation Date" className={`${PHONE_WIDE} ${showPicker ? "" : "sm:col-span-2"}`}><MilkDateInput centered confirm title="Expected Consultation Date" className={PHONE_CONTROL} value={form.expected_consultation_date} onChange={(e) => set("expected_consultation_date", e.target.value)} data-testid="lead-create-consultdate" /></Field>
              {showPicker && (
                <Field label="Assign Branch" className={PHONE_WIDE}>
                  {/* Left blank, the lead lands Unassigned, as it always has. */}
                  <ThemedSelect
                    className={PHONE_CONTROL}
                    value={form.branch_id}
                    onChange={(v) => set("branch_id", v)}
                    placeholder="Select Branch"
                    options={[{ value: "", label: "Select Branch" }, ...pickerBranches.map((b) => ({ value: b.id, label: b.branch_name }))]}
                    testid="lead-create-branch-select"
                  />
                </Field>
              )}
            </div>

            {!branchId && !showPicker && departmentHasBranch(form.department) && (
              <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3" data-testid="lead-create-branch-section">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-700">Assign to Branch</p>
                <div className="grid gap-2 sm:grid-cols-2 max-h-44 overflow-y-auto">
                  {branches.length === 0 && <p className="text-xs text-slate-500">No branches. Add one from Master View.</p>}
                  {branches.map((b) => (
                    <label key={b.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs ${form.branch_id === b.id ? "border-sky-500 bg-white shadow" : "border-slate-200 bg-white"}`} data-testid={`lead-create-branch-${b.id}`}>
                      <input type="radio" name="branch" checked={form.branch_id === b.id} onChange={() => set("branch_id", b.id)} className="mt-0.5" />
                      <div><p className="font-semibold">{b.branch_name}</p><p className="text-slate-500">Branch Admin: {b.admin_name}</p></div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* This board's own form questions. Free text rather than a dropdown:
              the answers arrive off a Meta form whose options are set there, not here, and
              a fixed list would quietly refuse whatever the form is changed to ask next. */}
          {formQuestions.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-4 max-sm:p-3" data-testid="lead-create-form-questions">
              <div className={GRID}>
                {formQuestions.map((q) => (
                  <Field key={q.key} label={q.label} className={PHONE_WIDE}>
                    <Input
                      className={PHONE_CONTROL}
                      value={extraFields[q.question] ?? ""}
                      onChange={(e) => setExtra(q.question, e.target.value)}
                      data-testid={`lead-create-q-${q.key}`}
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}

        </div>

        {isSuperAdminUser && (
          <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 max-sm:space-y-3 max-sm:px-4 max-sm:py-3 ${tab === "lead_data" ? "" : "hidden"}`} data-testid="lead-create-panel-lead-data">
            <div className="rounded-lg border border-slate-200 p-4 max-sm:p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Ad Record</p>
              <p className="mb-3 text-xs text-slate-400">
                The Meta lead export, field for field. Super Admin only. Leave blank for a walk-in, or for any lead with no advert behind it.
              </p>
              <div className={GRID}>
                {LEAD_DATA_FIELDS.map((f) => (
                  // Whole rows on a phone except the two short Yes/No pickers: the ids
                  // are long digit strings that would not show at half width.
                  <Field key={f.key} label={f.label} className={f.type === "select" ? "" : PHONE_WIDE}>
                    {f.type === "select" ? (
                      <ThemedSelect
                        className={PHONE_CONTROL}
                        value={leadData[f.key]}
                        onChange={(v) => setLD(f.key, v)}
                        placeholder="—"
                        options={f.options.map(([value, label]) => ({ value, label }))}
                        testid={`lead-data-${f.key}`}
                      />
                    ) : (
                      <Input
                        className={PHONE_CONTROL}
                        placeholder={f.placeholder}
                        value={leadData[f.key]}
                        onChange={(e) => setLD(f.key, e.target.value)}
                        data-testid={`lead-data-${f.key}`}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4 max-sm:px-4 max-sm:py-3">
          <Button variant="outline" onClick={onClose} className="max-sm:h-8" data-testid="lead-create-cancel">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700 max-sm:h-8" data-testid="lead-create-submit">{saving ? "Creating…" : "Create Lead"}</Button>
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

export default CreateLeadModal;
