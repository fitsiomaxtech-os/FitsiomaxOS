import { useLayoutEffect, useRef, useState } from "react";

/**
 * The clinic's three-page paper Offline Consultation Form, as fillable sheets. Shared by
 * Branch Admin's Settings > Consultation Form and the patient's own link
 * (pages/ClientConsultationFormPage). Fields and their order are the paper's, page for page
 * -- the backend's FIELDS in routers/v3_consultation_forms.py is the same list.
 *
 * `client` shows only what the patient fills through the link (CLIENT_FIELDS): page 1's
 * details and history and the Previous Consultations section. The muscles, the diagnosis
 * and the treatment plan are the clinic's to write.
 */

export const LINE = 32; // px between the dotted rules, as on the paper
export const FORM_BLUE = "#3b7bbf";
export const PAPER_BRANCHES = ["Anna Nagar", "Parrys", "T.Nagar", "ECR"];

export const EMPTY_FORM = {
  name: "", age: "", sex: "", contact_no: "", mail_id: "", source_of_reference: "", nature_of_job: "",
  branch: "", date: "", place: "",
  past_medical_history: "", any_medication: "", symptoms_root_cause: "", primary_muscles: "", secondary_muscles: "",
  previous_medical_consultations: "", previous_diagnosis: "", previous_physiotherapy: "",
  fitsiomax_diagnosis: "", treatment_goals: "",
  treatment_protocol: "", sessions_weeks_required: "", sessions_weeks_online_offline: "",
  short_term_goal: "", long_term_goal: "", dos_and_donts: "", special_instructions: "",
  therapist_name: "",
};

export const CLIENT_FIELDS = [
  "name", "age", "sex", "contact_no", "mail_id", "source_of_reference", "nature_of_job",
  "branch", "date", "place",
  "past_medical_history", "any_medication", "symptoms_root_cause",
  "previous_medical_consultations", "previous_diagnosis", "previous_physiotherapy",
];

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const showDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || "—";
};
// The branch's own name onto one of the paper's four boxes, so a new form starts ticked.
export const paperBranch = (name) => {
  const n = (name || "").toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("annanagar")) return "Anna Nagar";
  if (n.includes("parry")) return "Parrys";
  if (n.includes("tnagar")) return "T.Nagar";
  if (n.includes("ecr")) return "ECR";
  return "";
};

// A dotted rule under every line: one dot every 5px, sat on the line's baseline.
const dotted = {
  backgroundImage: "radial-gradient(circle at 1px 1px, #cbd5e1 0.9px, transparent 1.1px)",
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
  // Grows with what is written -- a saved form opens showing all of it -- in whole lines,
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
  <p className="pt-2 text-[16px] font-bold" style={{ color: FORM_BLUE }}>{children}</p>
);

/** One sheet of the paper: white, a faint brand mark behind, the page number in the corner. */
const Page = ({ n, children }) => (
  <div className="relative overflow-hidden rounded-[4px] border border-slate-200 bg-white px-5 pb-10 pt-6 shadow-sm sm:px-10" data-testid={`consultation-form-page-${n}`}>
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 select-none text-center font-serif leading-none text-slate-900/[0.04]">
      <p className="text-[56px] font-bold tracking-wider sm:text-[88px]">FITSIO_MAX</p>
      <p className="mt-2 font-sans text-[20px] sm:text-[32px]">Physio Care &amp; Fitness Centre</p>
    </div>
    <div className="relative flex flex-col gap-1">{children}</div>
    <span className="absolute bottom-3 right-5 text-sm font-semibold" style={{ color: FORM_BLUE }}>{n}</span>
  </div>
);

export const ConsultationFormSheets = ({ f, set, client = false }) => {
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
            <p className="text-3xl font-black leading-none tracking-wide sm:text-6xl" style={{ color: FORM_BLUE }}>FITSIO_MAX</p>
            <p className="mt-2 text-[11px] font-semibold text-slate-700 sm:text-lg">Pain Management | Athletic Rehab | Fitness</p>
            <p className="text-[12px] font-semibold text-slate-800 sm:text-lg">+91 75388 36030</p>
          </div>
        </div>
        <div className="mt-3 h-0.5" style={{ background: FORM_BLUE }} />
        <p className="mx-auto mt-3 border-b-2 pb-0.5 text-center text-lg font-extrabold tracking-wide sm:text-2xl" style={{ color: FORM_BLUE, borderColor: FORM_BLUE }}>
          OFFLINE CONSULTATION FORM
        </p>

        <SectionHead>Patient Details:</SectionHead>
        <Line label="Name:" autoComplete="name" {...bind("name")} />
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-[1fr_1.4fr_2.6fr]">
          <Line label="Age:" inputMode="numeric" {...bind("age")} />
          <Line label="Sex:" {...bind("sex")} />
          <Line label="Contact no:" inputMode="tel" autoComplete="tel" {...bind("contact_no")} />
        </div>
        <Line label="Mail Id:" type="email" autoComplete="email" {...bind("mail_id")} />
        <Line label="Source of Reference:" {...bind("source_of_reference")} />
        <Line label="Nature of Job:" {...bind("nature_of_job")} />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2" role="radiogroup" aria-label="Branches">
          <span className="text-[15px] text-slate-700">Branches :</span>
          {PAPER_BRANCHES.map((b) => {
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
          {!client && <Lines label="Primary Muscles:" rows={2} {...bind("primary_muscles")} />}
          {!client && <Lines label="Secondary Muscles:" rows={2} {...bind("secondary_muscles")} />}
        </div>
      </Page>

      {/* Page 2 */}
      <Page n={2}>
        <SectionHead>Previous Consultations</SectionHead>
        <Lines inline label="Previous Medical Consultations:" rows={5} {...bind("previous_medical_consultations")} />
        <Lines inline label="Previous Diagnosis:" rows={3} {...bind("previous_diagnosis")} />
        <Lines inline label="Previous Physiotherapy:" rows={5} {...bind("previous_physiotherapy")} />
        {!client && (
          <>
            <div className="h-6" />
            <SectionHead>Diagnosis &amp; Treatment Plan</SectionHead>
            <Lines inline label="Fitsiomax Diagnosis:" rows={5} {...bind("fitsiomax_diagnosis")} />
            <Lines inline label="Treatment Goals:" rows={10} {...bind("treatment_goals")} />
          </>
        )}
      </Page>

      {/* Page 3 -- the clinic's alone. */}
      {!client && (
        <Page n={3}>
          <Lines inline label="Treatment Protocol:" rows={10} {...bind("treatment_protocol")} />
          <Lines inline label="No of Sessions / Weeks Required:" rows={2} {...bind("sessions_weeks_required")} />
          <Lines inline label="No of Sessions / Weeks (Online /Offline):" rows={2} {...bind("sessions_weeks_online_offline")} />
          <Lines inline label="Short Term Goal :" rows={2} {...bind("short_term_goal")} />
          <Lines inline label="Long Term Goal:" rows={2} {...bind("long_term_goal")} />
          <Lines inline label="Do's & Don'ts:" rows={4} {...bind("dos_and_donts")} />
          <Lines label="Special Instructions to the Therapist:" rows={5} {...bind("special_instructions")} />
          <div className="mx-auto mt-10 w-full max-w-md text-center">
            <p className="text-lg font-bold" style={{ color: FORM_BLUE }}>Therapist Name &amp; Sign:</p>
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
      )}
    </div>
  );
};
