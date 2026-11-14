import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  createConsultationForm,
  deleteConsultationForm,
  getBranches,
  getConsultationForm,
  listConsultationForms,
  updateConsultationForm,
} from "@/lib/api";

/**
 * Settings > Consultation Form: the clinic's three-page paper Offline Consultation Form,
 * filled on screen. The list keeps the branch's saved forms; a tap opens one in the same
 * layout to edit. Fields and their order are the paper's, page for page — the backend's
 * FIELDS in routers/v3_consultation_forms.py is the same list.
 *
 * A plain overlay, like the other two popups in the same menu.
 */

const LINE = 32; // px between the dotted rules, as on the paper
const BLUE = "#3b7bbf";
const BRANCHES = ["Anna Nagar", "Parrys", "T.Nagar", "ECR"];

const EMPTY = {
  name: "", age: "", sex: "", contact_no: "", mail_id: "", source_of_reference: "", nature_of_job: "",
  branch: "", date: "", place: "",
  past_medical_history: "", any_medication: "", symptoms_root_cause: "", primary_muscles: "", secondary_muscles: "",
  previous_medical_consultations: "", previous_diagnosis: "", previous_physiotherapy: "",
  fitsiomax_diagnosis: "", treatment_goals: "",
  treatment_protocol: "", sessions_weeks_required: "", sessions_weeks_online_offline: "",
  short_term_goal: "", long_term_goal: "", dos_and_donts: "", special_instructions: "",
  therapist_name: "",
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const showDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || "—";
};
// The branch's own name onto one of the paper's four boxes, so a new form starts ticked.
const paperBranch = (name) => {
  const n = (name || "").toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("annanagar")) return "Anna Nagar";
  if (n.includes("parry")) return "Parrys";
  if (n.includes("tnagar")) return "T.Nagar";
  if (n.includes("ecr")) return "ECR";
  return "";
};

// A dotted rule under every line: one dot every 5px, sat on the line's baseline.
const dotted = {
  backgroundImage: "radial-gradient(circle at 1px 1px, #64748b 0.9px, transparent 1.1px)",
  backgroundSize: `5px ${LINE}px`,
  backgroundPosition: `0 ${LINE - 4}px`,
  lineHeight: `${LINE}px`,
};

const inputCls = "w-full min-w-0 bg-transparent px-1 text-[15px] text-slate-900 outline-none placeholder:text-slate-300 focus:bg-sky-50/60";

/** One line: "Label: ......" with the dots filling the rest of the row. */
const Line = ({ label, value, onChange, className = "", testid, ...rest }) => (
  <label className={`flex min-w-0 items-end gap-1 ${className}`}>
    <span className="shrink-0 whitespace-nowrap text-[15px] text-slate-700" style={{ lineHeight: `${LINE}px` }}>{label}</span>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} h-8 flex-1`}
      style={dotted}
      data-testid={testid}
      {...rest}
    />
  </label>
);

/**
 * Several ruled lines. `inline` puts the label on the first line, the writing starting
 * after it, as most of the paper's boxes are; otherwise the label sits above.
 */
const Lines = ({ label, rows, value, onChange, inline = false, testid }) => {
  const labelRef = useRef(null);
  const boxRef = useRef(null);
  const [indent, setIndent] = useState(0);
  useLayoutEffect(() => {
    if (inline && labelRef.current) setIndent(labelRef.current.offsetWidth + 6);
  }, [inline, label]);
  // Grows with what is written — a saved form opens showing all of it — in whole lines,
  // never under the paper's count.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(rows, Math.ceil(el.scrollHeight / LINE)) * LINE}px`;
  }, [value, rows, indent]);
  return (
    <div className="min-w-0">
      {!inline && <p className="text-[15px] text-slate-700" style={{ lineHeight: `${LINE}px` }}>{label}</p>}
      <div className="relative">
        {inline && (
          <span ref={labelRef} className="pointer-events-none absolute left-0 top-0 whitespace-nowrap text-[15px] text-slate-700" style={{ lineHeight: `${LINE}px` }}>{label}</span>
        )}
        <textarea
          ref={boxRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          aria-label={label.replace(/[\s:]+$/, "")}
          className={`${inputCls} block resize-none overflow-hidden`}
          style={{ ...dotted, minHeight: rows * LINE, textIndent: inline ? indent : 0, paddingTop: 0, paddingBottom: 0 }}
          data-testid={testid}
        />
      </div>
    </div>
  );
};

const SectionHead = ({ children }) => (
  <p className="pt-2 text-[16px] font-bold" style={{ color: BLUE }}>{children}</p>
);

/** One sheet of the paper: white, a faint brand mark behind, the page number in the corner. */
const Page = ({ n, children }) => (
  <div className="relative overflow-hidden rounded-[4px] border border-slate-200 bg-white px-5 pb-10 pt-6 shadow-sm sm:px-10" data-testid={`consultation-form-page-${n}`}>
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 select-none text-center font-serif leading-none text-slate-900/[0.04]">
      <p className="text-[56px] font-bold tracking-wider sm:text-[88px]">FITSIO_MAX</p>
      <p className="mt-2 font-sans text-[20px] sm:text-[32px]">Physio Care &amp; Fitness Centre</p>
    </div>
    <div className="relative flex flex-col gap-1">{children}</div>
    <span className="absolute bottom-3 right-5 text-sm font-semibold" style={{ color: BLUE }}>{n}</span>
  </div>
);

const FormSheets = ({ f, set }) => {
  const bind = (key) => ({ value: f[key], onChange: (v) => set(key, v), testid: `consultation-form-${key}` });
  return (
    <div className="flex flex-col gap-4">
      {/* Page 1 */}
      <Page n={1}>
        <div className="flex items-center gap-4 sm:gap-6">
          <div className="flex shrink-0 flex-col items-center">
            <img src="/logo-icon-192.png" alt="" className="h-14 w-14 object-contain sm:h-20 sm:w-20" />
            <p className="font-serif text-[11px] font-bold tracking-wide text-slate-800 sm:text-sm">FITSIO_MAX</p>
            <p className="text-[8px] text-slate-600 sm:text-[9px]">Physio Care &amp; Fitness Centre</p>
          </div>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-3xl font-black leading-none tracking-wide sm:text-6xl" style={{ color: BLUE }}>FITSIO_MAX</p>
            <p className="mt-2 text-[11px] font-semibold text-slate-700 sm:text-lg">Pain Management | Athletic Rehab | Fitness</p>
            <p className="text-[12px] font-semibold text-slate-800 sm:text-lg">+91 75388 36030</p>
          </div>
        </div>
        <div className="mt-3 h-0.5" style={{ background: BLUE }} />
        <p className="mx-auto mt-3 border-b-2 pb-0.5 text-center text-lg font-extrabold tracking-wide sm:text-2xl" style={{ color: BLUE, borderColor: BLUE }}>
          OFFLINE CONSULTATION FORM
        </p>

        <SectionHead>Patient Details:</SectionHead>
        <Line label="Name:" {...bind("name")} />
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-[1fr_1.4fr_2.6fr]">
          <Line label="Age:" inputMode="numeric" {...bind("age")} />
          <Line label="Sex:" {...bind("sex")} />
          <Line label="Contact no:" inputMode="tel" {...bind("contact_no")} />
        </div>
        <Line label="Mail Id:" type="email" {...bind("mail_id")} />
        <Line label="Source of Reference:" {...bind("source_of_reference")} />
        <Line label="Nature of Job:" {...bind("nature_of_job")} />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2" role="radiogroup" aria-label="Branches">
          <span className="text-[15px] text-slate-700">Branches :</span>
          {BRANCHES.map((b) => {
            const on = f.branch === b;
            return (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set("branch", on ? "" : b)}
                className="flex items-center gap-2 text-[15px] text-slate-700"
                data-testid={`consultation-form-branch-${b.replace(/[^A-Za-z]/g, "").toLowerCase()}`}
              >
                <span className={`flex h-6 w-6 items-center justify-center border-2 ${on ? "border-sky-600 bg-sky-600 text-white" : "border-slate-500 bg-white"}`}>
                  {on && <span className="text-sm font-bold leading-none">✓</span>}
                </span>
                {b}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-[1fr_2fr]">
          <Line label="Date:" type="date" {...bind("date")} />
          <Line label="Place:" {...bind("place")} />
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Lines label="Past Medical History:" rows={2} {...bind("past_medical_history")} />
          <Lines label="Any Medication:" rows={2} {...bind("any_medication")} />
          <Lines label="Symptoms / Root Cause :" rows={2} {...bind("symptoms_root_cause")} />
          <Lines label="Primary Muscles:" rows={2} {...bind("primary_muscles")} />
          <Lines label="Secondary Muscles:" rows={2} {...bind("secondary_muscles")} />
        </div>
      </Page>

      {/* Page 2 */}
      <Page n={2}>
        <SectionHead>Previous Consultations</SectionHead>
        <Lines inline label="Previous Medical Consultations:" rows={5} {...bind("previous_medical_consultations")} />
        <Lines inline label="Previous Diagnosis:" rows={3} {...bind("previous_diagnosis")} />
        <Lines inline label="Previous Physiotherapy:" rows={5} {...bind("previous_physiotherapy")} />
        <div className="h-6" />
        <SectionHead>Diagnosis &amp; Treatment Plan</SectionHead>
        <Lines inline label="Fitsiomax Diagnosis:" rows={5} {...bind("fitsiomax_diagnosis")} />
        <Lines inline label="Treatment Goals:" rows={10} {...bind("treatment_goals")} />
      </Page>

      {/* Page 3 */}
      <Page n={3}>
        <Lines inline label="Treatment Protocol:" rows={10} {...bind("treatment_protocol")} />
        <Lines inline label="No of Sessions / Weeks Required:" rows={2} {...bind("sessions_weeks_required")} />
        <Lines inline label="No of Sessions / Weeks (Online /Offline):" rows={2} {...bind("sessions_weeks_online_offline")} />
        <Lines inline label="Short Term Goal :" rows={2} {...bind("short_term_goal")} />
        <Lines inline label="Long Term Goal:" rows={2} {...bind("long_term_goal")} />
        <Lines inline label="Do's & Don'ts:" rows={4} {...bind("dos_and_donts")} />
        <Lines label="Special Instructions to the Therapist:" rows={5} {...bind("special_instructions")} />
        <div className="mx-auto mt-10 w-full max-w-md text-center">
          <p className="text-lg font-bold" style={{ color: BLUE }}>Therapist Name &amp; Sign:</p>
          <input
            value={f.therapist_name}
            onChange={(e) => set("therapist_name", e.target.value)}
            className={`${inputCls} h-8 text-center`}
            style={dotted}
            aria-label="Therapist Name & Sign"
            data-testid="consultation-form-therapist_name"
          />
        </div>
      </Page>
    </div>
  );
};

export const ConsultationFormDialog = ({ branchId, onClose }) => {
  const [view, setView] = useState("list"); // "list" | "form"
  const [rows, setRows] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [homeBranch, setHomeBranch] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    let live = true;
    getBranches()
      .then((list) => { if (live) setHomeBranch(paperBranch((list || []).find((b) => b.id === branchId)?.name)); })
      .catch(() => {});
    return () => { live = false; };
  }, [branchId]);

  const load = useCallback(async (term) => {
    setListLoading(true);
    try {
      const r = await listConsultationForms(branchId, term);
      setRows(r.forms || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load the consultation forms");
    } finally {
      setListLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const dirty = view === "form" && JSON.stringify(form) !== JSON.stringify(saved);
  const set = (key, v) => setForm((cur) => ({ ...cur, [key]: v }));
  const top = () => scrollRef.current?.scrollTo({ top: 0 });

  const openNew = () => {
    const start = { ...EMPTY, date: todayIso(), branch: homeBranch };
    setEditingId(null);
    setForm(start);
    setSaved(start);
    setView("form");
    top();
  };

  const openEdit = async (id) => {
    setEditingId(id);
    setView("form");
    setFormLoading(true);
    top();
    try {
      const r = await getConsultationForm(branchId, id);
      const filled = Object.fromEntries(Object.keys(EMPTY).map((k) => [k, r[k] || ""]));
      setForm(filled);
      setSaved(filled);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
      setView("list");
    } finally {
      setFormLoading(false);
    }
  };

  const backToList = () => {
    if (dirty && !window.confirm("Discard the changes on this form?")) return;
    setView("list");
    top();
  };

  const close = () => {
    if (dirty && !window.confirm("Discard the changes on this form?")) return;
    onClose();
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error("Enter the patient's name"); return; }
    setSaving(true);
    try {
      if (editingId) await updateConsultationForm(branchId, editingId, form);
      else await createConsultationForm(branchId, form);
      toast.success(editingId ? "Consultation form updated" : "Consultation form saved");
      setSaved(form);
      setView("list");
      top();
      load(q.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the form");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the consultation form of ${row.name}?\n\nIt cannot be undone.`)) return;
    try {
      await deleteConsultationForm(branchId, row.id);
      toast.success("Consultation form deleted");
      setRows((cur) => cur.filter((r) => r.id !== row.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete the form");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="consultation-form-dialog">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {view === "form" && (
              <button type="button" onClick={backToList} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Back to the forms" data-testid="consultation-form-back">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <p className="flex min-w-0 items-center gap-2 truncate text-base font-semibold text-slate-800">
              <ClipboardList className="h-4 w-4 shrink-0 text-sky-600" />
              {view === "list" ? "Consultation Forms" : editingId ? `Edit — ${saved.name || "Consultation Form"}` : "New Consultation Form"}
            </p>
          </div>
          <button type="button" onClick={close} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="consultation-form-close"><X className="h-4 w-4" /></button>
        </div>

        <div ref={scrollRef} className={`flex-1 overflow-y-auto ${view === "form" ? "bg-slate-100 p-3 sm:p-5" : "p-4"}`}>
          {view === "list" ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, contact or therapist…"
                    className="h-9 w-full rounded-[4px] border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                    data-testid="consultation-form-search"
                  />
                </div>
                <Button type="button" size="sm" onClick={openNew} className="h-9 gap-1.5 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-new">
                  <Plus className="h-4 w-4" />New Form
                </Button>
              </div>

              {listLoading ? (
                <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : rows.length === 0 ? (
                <div className="rounded-[4px] border border-dashed border-slate-200 py-14 text-center text-sm text-slate-400" data-testid="consultation-form-empty">
                  {q ? "No form matches that search." : "No consultation forms yet. Tap New Form to fill one."}
                </div>
              ) : (
                <div className="overflow-hidden rounded-[4px] border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-700 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                      <tr>
                        <th className="px-3 py-2.5">Patient</th>
                        <th className="hidden px-3 py-2.5 sm:table-cell">Contact</th>
                        <th className="px-3 py-2.5">Date</th>
                        <th className="hidden px-3 py-2.5 md:table-cell">Therapist</th>
                        <th className="px-3 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} onClick={() => openEdit(r.id)} className="cursor-pointer border-t border-slate-100 hover:bg-sky-50/50" data-testid={`consultation-form-row-${r.id}`}>
                          <td className="px-3 py-2.5 font-medium text-slate-800">{r.name}</td>
                          <td className="hidden px-3 py-2.5 text-slate-600 sm:table-cell">{r.contact_no || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{showDate(r.date)}</td>
                          <td className="hidden px-3 py-2.5 text-slate-600 md:table-cell">{r.therapist_name || "—"}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex justify-end gap-1">
                              <button type="button" onClick={(e) => { e.stopPropagation(); openEdit(r.id); }} className="rounded p-1.5 text-slate-400 hover:bg-sky-50 hover:text-sky-700" aria-label="Edit" title="Edit" data-testid={`consultation-form-edit-${r.id}`}>
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); remove(r); }} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Delete" title="Delete" data-testid={`consultation-form-delete-${r.id}`}>
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : formLoading ? (
            <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <FormSheets f={form} set={set} />
          )}
        </div>

        {view === "form" && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
            <Button type="button" variant="outline" size="sm" onClick={backToList} disabled={saving} className="rounded-[4px]">Cancel</Button>
            <Button type="button" size="sm" onClick={save} disabled={formLoading || saving || (editingId && !dirty)} className="rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-save">
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{editingId ? "Update" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
