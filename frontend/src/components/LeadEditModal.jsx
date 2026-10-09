import { useEffect, useState } from "react";
import { X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { updateLead, getBranches } from "@/lib/api";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { DEPARTMENT_OPTIONS, SOURCE_SUGGESTIONS } from "@/components/CreateLeadModal";

const GENDERS = ["Male", "Female", "Other"];
// The two departments a lead is seen at a branch for. The other two are run online and
// carry no branch, which is the same split CreateLeadModal makes when the lead is first
// filed -- an edit form that disagreed with the create form about this would quietly move
// a fitness patient off the branch that has been seeing them.
const BRANCHED_DEPARTMENTS = ["offline_physio", "offline_fitness"];
// Kept in step with CreateLeadModal's own map. Department is the answer a human gives and
// vertical is what the boards filter on, so changing one without the other files the lead
// under a department it is no longer listed by.
const VERTICAL_MAP = {
  online_physio: "online_physiotherapy",
  offline_fitness: "offline_fitness",
  online_fitness: "online_fitness",
};

// An intake question's own key, made readable. These arrive as the sheet's column headers
// -- "months_of_pain" on one, "What type of pain?" on the next -- so the ones already
// written for people are left alone and only the machine-shaped ones are unpicked.
const humanKey = (key) => String(key || "")
  .replace(/[_-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/^./, (c) => c.toUpperCase());

// What this form can honestly edit back. extra_fields is an untyped dict on the wire, so a
// sheet can leave a nested object in there; drawing that in a text box would save the
// string "[object Object]" over the real answer.
const isEditableAnswer = (v) => ["string", "number", "boolean"].includes(typeof v);

/**
 * Every field on a lead a person is allowed to correct, in one form.
 *
 * Opened from Pre-Sales' own card and from the Branch Leads popup, which is why the branch
 * picker is a prop rather than an assumption. It is off for the branch popup: a patient
 * moves between branches through Branch Transfer -- Operations for a Super Admin, the
 * branch's own toolbar for its Branch Admin -- which carries their fees and sessions with
 * them, and a radio button here would move the person and leave the money behind.
 *
 * Source opens on what the lead popup shows for it (source_tab, else source_type) and is
 * only sent when it was actually changed: a save that never touched it must not stamp a
 * sheet lead's raw source_type into source_tab, which the dashboards group on.
 */
export const LeadEditModal = ({ lead, onClose, onSaved, allowBranchChange = true }) => {
  const initialSource = lead.source_tab || lead.source_type || "";
  const [form, setForm] = useState({
    source_tab: initialSource,
    name: lead.name || "",
    phone: lead.phone || "",
    alternative_phone: lead.alternative_phone || "",
    email: lead.email || "",
    address: lead.address || "",
    city: lead.city || "",
    state: lead.state || "",
    location: lead.location || "",
    department: lead.department || "",
    condition: lead.condition || "",
    expected_consultation_date: lead.expected_consultation_date || "",
    months_of_pain: lead.months_of_pain ?? "",
    age: lead.age ?? "",
    gender: lead.gender || "",
    occupation: lead.occupation || "",
    branch_id: lead.branch_id || "",
    notes: lead.notes || "",
  });
  // The intake form's own answers, keyed as the sheet asked them. Only the ones that can be
  // typed back are held here; the rest of extra_fields is carried across untouched on save.
  const [answers, setAnswers] = useState(() => Object.fromEntries(
    Object.entries(lead.extra_fields || {})
      .filter(([, v]) => isEditableAnswer(v))
      .map(([k, v]) => [k, String(v)]),
  ));
  const [answersTouched, setAnswersTouched] = useState(false);
  const [branches, setBranches] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!allowBranchChange) return;
    getBranches().then(setBranches).catch((e) => console.warn("[load failed]", e?.message || e));
  }, [allowBranchChange]);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const setAnswer = (k, v) => { setAnswersTouched(true); setAnswers((p) => ({ ...p, [k]: v })); };

  const answerKeys = Object.keys(answers);

  const save = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      toast.error("Name and phone are required");
      return;
    }
    // Only refused where there was one to lose. A sheet import can land a lead with no
    // department at all, and demanding one before a phone number could be corrected made
    // the reader guess a department -- which decides which board the lead is listed on --
    // in order to fix something else. Clearing one that was set is still refused.
    if (!form.department && lead.department) { toast.error("Department is required"); return; }
    const source = form.source_tab.trim();
    // Same rule as Department: one that was set cannot be blanked, since an empty source_tab
    // is its own silent bucket on every board that groups by channel.
    if (!source && initialSource) { toast.error("Source is required"); return; }
    const payload = { ...form };
    if (source === initialSource) delete payload.source_tab;
    else payload.source_tab = source;
    // The endpoint drops nulls rather than writing them, so a number cleared here stays as
    // it was -- there is no value meaning "no answer" for an int field on the way in.
    payload.months_of_pain = payload.months_of_pain === "" ? null : Number(payload.months_of_pain);
    payload.age = payload.age === "" ? null : Number(payload.age);
    if (allowBranchChange) {
      if (!BRANCHED_DEPARTMENTS.includes(payload.department)) payload.branch_id = null;
    } else {
      // Never sent from a board that does not offer it, so a save here cannot re-post a
      // branch and undo a transfer that happened since the form was opened.
      delete payload.branch_id;
    }
    // Only when it actually changed: every other save leaves the lead's vertical exactly as
    // whatever filed it set, including the older spellings this map does not produce.
    if (payload.department !== (lead.department || "")) {
      payload.vertical = VERTICAL_MAP[payload.department] || "offline_physiotherapy";
    }
    if (answersTouched) {
      // The original spread first: extra_fields is replaced wholesale by the endpoint, and
      // the nested values this form refused to draw are still answers somebody gave.
      payload.extra_fields = { ...(lead.extra_fields || {}) };
      for (const [k, v] of Object.entries(answers)) {
        const was = (lead.extra_fields || {})[k];
        payload.extra_fields[k] = typeof was === "boolean"
          ? v === "true"
          : typeof was === "number" && String(v).trim() !== "" && !Number.isNaN(Number(v))
            ? Number(v)
            : v;
      }
    }
    try {
      setSaving(true);
      await updateLead(lead.id, payload);
      toast.success("Lead updated");
      onSaved && onSaved();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    // Above the card that opens it on every board: Branch Leads' own popup sits at z-50,
    // and an edit form behind the card being edited is a dead click.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" data-testid="lead-edit-modal">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-sky-600" />
            <h3 className="text-base font-semibold text-slate-900">Edit Lead — {lead.name}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" data-testid="lead-edit-close"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Section title="Contact">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name *"><Input value={form.name} onChange={(e) => set("name", e.target.value)} data-testid="lead-edit-name" /></Field>
              <Field label="Phone *"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} data-testid="lead-edit-phone" /></Field>
              <Field label="Alternative Phone"><Input value={form.alternative_phone} onChange={(e) => set("alternative_phone", e.target.value)} data-testid="lead-edit-altphone" /></Field>
              <Field label="Email"><Input value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="lead-edit-email" /></Field>
              <Field label="Address" className="sm:col-span-2"><Input value={form.address} onChange={(e) => set("address", e.target.value)} data-testid="lead-edit-address" /></Field>
              <Field label="City"><Input value={form.city} onChange={(e) => set("city", e.target.value)} data-testid="lead-edit-city" /></Field>
              <Field label="State"><Input value={form.state} onChange={(e) => set("state", e.target.value)} data-testid="lead-edit-state" /></Field>
              <Field label="Location"><Input value={form.location} onChange={(e) => set("location", e.target.value)} data-testid="lead-edit-location" /></Field>
              <Field label="Source">
                {/* Typed with suggestions, as on the create form: a channel nobody has
                    named yet can still be written down as what it was. */}
                <Input list="lead-edit-source-options" value={form.source_tab} onChange={(e) => set("source_tab", e.target.value)} data-testid="lead-edit-source" />
                <datalist id="lead-edit-source-options">
                  {SOURCE_SUGGESTIONS.map((o) => <option key={o} value={o} />)}
                </datalist>
              </Field>
            </div>
          </Section>

          <Section title="Patient Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={lead.department ? "Department *" : "Department"}>
                <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.department} onChange={(e) => set("department", e.target.value)} data-testid="lead-edit-department">
                  <option value="">Select department</option>
                  {DEPARTMENT_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
              <Field label="Condition / Pain Area"><Input value={form.condition} onChange={(e) => set("condition", e.target.value)} data-testid="lead-edit-condition" /></Field>
              <Field label="Months of Pain"><Input type="number" min="0" value={form.months_of_pain} onChange={(e) => set("months_of_pain", e.target.value)} data-testid="lead-edit-months-pain" /></Field>
              <Field label="Age"><Input type="number" min="0" value={form.age} onChange={(e) => set("age", e.target.value)} data-testid="lead-edit-age" /></Field>
              <Field label="Gender">
                <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm" value={form.gender} onChange={(e) => set("gender", e.target.value)} data-testid="lead-edit-gender">
                  <option value="">Select</option>
                  {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Occupation"><Input value={form.occupation} onChange={(e) => set("occupation", e.target.value)} data-testid="lead-edit-occupation" /></Field>
              <Field label="Expected Consultation Date" className="sm:col-span-2"><MilkDateInput centered confirm title="Expected Consultation Date" value={form.expected_consultation_date} onChange={(e) => set("expected_consultation_date", e.target.value)} data-testid="lead-edit-consultdate" /></Field>
            </div>
          </Section>

          {allowBranchChange && BRANCHED_DEPARTMENTS.includes(form.department) && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3" data-testid="lead-edit-branch-section">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-700">Assign to Branch</p>
              <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
                {branches.length === 0 && <p className="text-xs text-slate-500">No branches yet. Add one from Super Admin → Master View.</p>}
                {branches.map((b) => (
                  <label key={b.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs ${form.branch_id === b.id ? "border-sky-500 bg-white shadow" : "border-slate-200 bg-white"}`} data-testid={`lead-edit-branch-${b.id}`}>
                    <input type="radio" name="branch" checked={form.branch_id === b.id} onChange={() => set("branch_id", b.id)} className="mt-0.5" />
                    <div>
                      <p className="font-semibold text-slate-800">{b.branch_name}</p>
                      <p className="text-slate-500">Branch Admin: <span className="text-slate-700">{b.admin_name}</span></p>
                      <p className="text-slate-400">{b.address}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {answerKeys.length > 0 && (
            <Section title="Enquiry Form Answers">
              {/* Named by the question as the form asked it, because that is the only name
                  these have -- a branch that asks nine questions has nine of these, and no
                  board can know them in advance. */}
              <div className="grid gap-3 sm:grid-cols-2">
                {answerKeys.map((k) => (
                  <Field key={k} label={humanKey(k)}>
                    {typeof (lead.extra_fields || {})[k] === "boolean" ? (
                      <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm" value={answers[k]} onChange={(e) => setAnswer(k, e.target.value)} data-testid={`lead-edit-answer-${k}`}>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <Input value={answers[k]} onChange={(e) => setAnswer(k, e.target.value)} data-testid={`lead-edit-answer-${k}`} />
                    )}
                  </Field>
                ))}
              </div>
            </Section>
          )}

          <Section title="Notes">
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} className="h-20 w-full rounded-md border border-slate-200 p-2 text-sm" data-testid="lead-edit-notes" />
          </Section>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="lead-edit-cancel">Cancel</Button>
          <Button onClick={save} disabled={saving} data-testid="lead-edit-submit">{saving ? "Saving…" : "Save Lead"}</Button>
        </div>
      </div>
    </div>
  );
};

const Section = ({ title, children }) => (
  <div className="rounded-lg border border-slate-200 p-4">
    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
    {children}
  </div>
);

const Field = ({ label, children, className = "" }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="text-xs font-medium text-slate-600">{label}</label>
    {children}
  </div>
);

export default LeadEditModal;
