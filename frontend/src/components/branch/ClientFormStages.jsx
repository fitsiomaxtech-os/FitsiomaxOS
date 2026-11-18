import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, Loader2 } from "lucide-react";
import { ThemedSelect } from "@/components/ui/themed-select";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { PAPER_BRANCHES, todayIso } from "@/components/branch/ConsultationFormSheets";

/**
 * The client link (pages/ClientConsultationFormPage), asked as eight short steps instead of
 * the paper, one field per row. Only Name and Mobile Number must be filled. The last step
 * can show every answer as a plain list first (Preview, optional), then sends the lot; the
 * client sees only a thank-you -- the filled paper is for the clinic's eyes (Branch Admin
 * opens it as a read-only report). The popup is a fixed 1020 x 520 from tablet width up,
 * the progress bar above it, Previous / Next under the fields. Each step is headed
 * "Offline Consultation Form", as the paper is; the date is picked in the OS's own calendar.
 */

const STAGES = 8;
const BLUE = "#0066ff";

// India first, as the default; the rest are where the clinic's patients most often live or work.
const COUNTRY_CODES = [
  ["IN", "91"], ["AE", "971"], ["SA", "966"], ["QA", "974"], ["KW", "965"], ["OM", "968"], ["BH", "973"],
  ["SG", "65"], ["MY", "60"], ["LK", "94"], ["NP", "977"], ["BD", "880"], ["GB", "44"], ["US", "1"],
  ["AU", "61"], ["NZ", "64"], ["DE", "49"], ["FR", "33"], ["ZA", "27"],
];
const CODE_OPTIONS = COUNTRY_CODES.map(([iso, code]) => ({ value: code, label: `${iso} +${code}` }));
const LONGEST_FIRST = COUNTRY_CODES.map(([, code]) => code).sort((a, b) => b.length - a.length);
const GENDERS = ["Male", "Female", "Other"];

// An Indian number is stored as its plain 10 digits, as every other number in the system;
// any other country keeps its code in front.
const joinPhone = (code, number) => (code === "91" ? number : `+${code} ${number}`);
const splitPhone = (raw) => {
  const text = String(raw || "").trim();
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) {
    const code = LONGEST_FIRST.find((c) => digits.startsWith(c));
    if (code) return { code, number: digits.slice(code.length) };
  }
  if (digits.length === 12 && digits.startsWith("91")) return { code: "91", number: digits.slice(2) };
  if (digits.length === 11 && digits.startsWith("0")) return { code: "91", number: digits.slice(1) };
  return { code: "91", number: digits };
};

const lettersOnly = (v) => v.replace(/[^A-Za-z ]/g, "").replace(/^ +/, "").replace(/ {2,}/g, " ");
const cityChars = (v) => v.replace(/[^A-Za-z .'-]/g, "").replace(/^[ .'-]+/, "").replace(/ {2,}/g, " ");

const NAME_OK = /^[A-Za-z]+(?: [A-Za-z]+)*$/;
const MAIL_OK = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const CITY_OK = /^[A-Za-z]+(?:[ .'-]+[A-Za-z]+)*\.?$/;

// The Name box takes typing only: paste, drop, browser autofill and spell-check swaps
// arrive with one of these input types, or with none at all.
const NOT_TYPED = new Set(["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank", "insertReplacementText"]);
const typedByHand = (e) => {
  const kind = e.nativeEvent?.inputType;
  return Boolean(kind) && !NOT_TYPED.has(kind);
};
const blockEvent = (e) => e.preventDefault();

// What each step checks before Next; the steps not listed take anything.
const check = (stage, d) => {
  const errors = {};
  if (stage === 0) {
    const name = d.name.trim();
    if (!name) errors.name = "Please enter your name";
    else if (name.length < 2 || !NAME_OK.test(name)) errors.name = "Please enter a valid name";
    if (!d.number) errors.contact_no = "Please enter your mobile number";
    else if (d.code === "91" ? !/^[6-9]\d{9}$/.test(d.number) : !/^\d{6,12}$/.test(d.number)) {
      errors.contact_no = d.code === "91" ? "Please enter a valid 10-digit mobile number" : "Please enter a valid mobile number";
    }
    if (d.mail_id && !MAIL_OK.test(d.mail_id)) errors.mail_id = "Please enter a valid email address";
  }
  if (stage === 1) {
    const place = d.place.trim();
    if (place && !CITY_OK.test(place)) errors.place = "Please enter a valid city name";
  }
  if (stage === 2) {
    if (d.age && (Number(d.age) < 1 || Number(d.age) > 120)) errors.age = "Please enter a valid age";
  }
  return errors;
};
// Where a failed Next takes the client: the first box with an error, in form order.
const FIELD_IDS = { name: "cs-name", contact_no: "cs-contact", mail_id: "cs-mail", place: "cs-place", age: "cs-age" };

const boxCls = "w-full rounded-[8px] border bg-white px-4 text-[15px] text-slate-800 outline-none placeholder:text-[#8a93b8] focus:ring-2";
const box = (bad) => `${boxCls} ${bad ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : "border-[#c7cdea] focus:border-[#0066ff] focus:ring-[#0066ff]/15"}`;

const Field = ({ label, htmlFor, required, error, children }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <label htmlFor={htmlFor} className="text-[15px] font-medium text-slate-900">
      {label}{required && <span className="ml-1 text-rose-600">*</span>}
    </label>
    {children}
    {error && <p className="text-xs text-rose-600" data-testid={`client-stage-error-${htmlFor}`}>{error}</p>}
  </div>
);

const Text = ({ id, label, value, onChange, error, required, placeholder, ...rest }) => (
  <Field label={label} htmlFor={id} required={required} error={error}>
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? label}
      className={`${box(error)} h-10`}
      data-testid={`client-stage-${id}`}
      {...rest}
    />
  </Field>
);

const Area = ({ id, label, value, onChange, rows = 4 }) => (
  <Field label={label} htmlFor={id}>
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      maxLength={5000}
      placeholder={label}
      className={`${box(false)} resize-none py-2 leading-relaxed`}
      data-testid={`client-stage-${id}`}
    />
  </Field>
);

const startFrom = (form) => {
  const phone = splitPhone(form.contact_no);
  const text = (k) => String(form[k] || "");
  return {
    name: lettersOnly(text("name")).trim(),
    code: phone.code,
    number: phone.number,
    mail_id: text("mail_id"),
    sex: GENDERS.includes(form.sex) ? form.sex : "",
    place: text("place"),
    branch: PAPER_BRANCHES.includes(form.branch) ? form.branch : "",
    age: text("age").replace(/\D/g, "").slice(0, 3),
    source_of_reference: text("source_of_reference"),
    nature_of_job: text("nature_of_job"),
    date: text("date") || todayIso(),
    past_medical_history: text("past_medical_history"),
    any_medication: text("any_medication"),
    symptoms_root_cause: text("symptoms_root_cause"),
    primary_muscles: text("primary_muscles"),
    secondary_muscles: text("secondary_muscles"),
    previous_medical_consultations: text("previous_medical_consultations"),
    previous_diagnosis: text("previous_diagnosis"),
    previous_physiotherapy: text("previous_physiotherapy"),
  };
};

const TRIM_KEYS = [
  "mail_id", "sex", "branch", "source_of_reference", "nature_of_job", "past_medical_history", "any_medication",
  "symptoms_root_cause", "primary_muscles", "secondary_muscles", "previous_medical_consultations",
  "previous_diagnosis", "previous_physiotherapy",
];

// Preview before Submit: every answer as a plain list of rows, not the paper's layout.
const PREVIEW = [
  ["Name", (d) => d.name],
  ["Mobile Number", (d) => (d.number ? `+${d.code} ${d.number}` : "")],
  ["Email ID", (d) => d.mail_id],
  ["Gender", (d) => d.sex],
  ["Your Place", (d) => d.place],
  ["Branch", (d) => d.branch],
  ["Age", (d) => d.age],
  ["Source", (d) => d.source_of_reference],
  ["Nature of Job", (d) => d.nature_of_job],
  ["Date", (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date.split("-").reverse().join("-") : d.date)],
  ["Past Medical History", (d) => d.past_medical_history],
  ["Any Medication", (d) => d.any_medication],
  ["Symptoms / Root Cause", (d) => d.symptoms_root_cause],
  ["Primary Muscles", (d) => d.primary_muscles],
  ["Secondary Muscles", (d) => d.secondary_muscles],
  ["Previous Medical Consultations", (d) => d.previous_medical_consultations],
  ["Previous Diagnosis", (d) => d.previous_diagnosis],
  ["Previous Physiotherapy", (d) => d.previous_physiotherapy],
];

const outlineCls = "flex h-10 items-center gap-1.5 rounded-[8px] border border-[#c7cdea] bg-white px-5 text-[15px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60";

export const ClientFormStages = ({ form, sending = false, error = "", onSubmit }) => {
  const [d, setD] = useState(() => startFrom(form));
  const [stage, setStage] = useState(0);
  const [preview, setPreview] = useState(false);
  // Errors show from a step's first Next on, then follow the typing. Not on blur: an
  // error appearing as a box loses focus pushes Next down under a click on its way.
  const [tried, setTried] = useState(false);
  const errors = check(stage, d);
  const err = (key) => (tried && errors[key]) || "";
  const set = (key) => (v) => setD((cur) => ({ ...cur, [key]: v }));
  const last = stage === STAGES - 1;
  // A double tap on step 7's Next must not also open Preview or send the form from step 8:
  // both sit under the pointer once the step changes.
  const movedAt = useRef(0);
  // The date's calendar floats beside this card, in a portal: hung off the field it would
  // be clipped by the popup's scrolling body.
  const cardRef = useRef(null);
  const settled = () => Date.now() - movedAt.current >= 600;

  const go = (to) => {
    movedAt.current = Date.now();
    setStage(to);
    setTried(false);
    window.scrollTo({ top: 0 });
  };

  const setNumber = (raw) => {
    let digits = raw.replace(/\D/g, "");
    if (d.code === "91" && digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (d.code === "91" && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    set("number")(digits.slice(0, d.code === "91" ? 10 : 12));
  };

  const next = (e) => {
    e.preventDefault();
    if (sending) return;
    setTried(true);
    const first = Object.keys(errors)[0];
    if (first) { document.getElementById(FIELD_IDS[first])?.focus(); return; }
    if (!last) { go(stage + 1); return; }
    if (!settled()) return;
    onSubmit({
      ...Object.fromEntries(TRIM_KEYS.map((k) => [k, d[k].trim()])),
      name: d.name.trim(),
      contact_no: joinPhone(d.code, d.number),
      age: d.age,
      place: d.place.trim().replace(/[ '-]+$/, ""),
      date: d.date || todayIso(),
    });
  };

  const backButton = (preview || stage > 0) && (
    <button
      type="button"
      onClick={() => (preview ? setPreview(false) : go(stage - 1))}
      disabled={sending}
      className={outlineCls}
      data-testid={preview ? "client-preview-back" : "client-stage-back"}
    >
      <ArrowLeft className="h-4 w-4" />Previous
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-[#eef1f8] px-4 py-6 md:justify-center md:py-10" data-testid="client-stages">
      {/* The progress sits above the popup, not in it. */}
      <div className="mb-4 flex w-full max-w-[1020px] gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={STAGES} aria-valuenow={stage + 1} aria-label="Progress" data-testid="client-stage-progress">
        {Array.from({ length: STAGES }, (_, i) => (
          <span key={i} className="h-1.5 flex-1 rounded-full transition-colors" style={{ background: i <= stage ? BLUE : "#dfe4ee" }} />
        ))}
      </div>

      <form
        ref={cardRef}
        onSubmit={next}
        noValidate
        autoComplete="off"
        className="flex w-full max-w-[1020px] flex-col rounded-[18px] bg-white shadow-xl md:h-[520px]"
        data-testid={preview ? "client-preview" : `client-stage-${stage + 1}`}
      >
        <h1 className="px-6 pt-6 text-[24px] font-semibold text-[#6b7aa6] sm:px-10 sm:pt-7 sm:text-[26px]">{preview ? "Preview" : "Offline Consultation Form"}</h1>

        {/* Rows only: one field under another. The body scrolls if it must (Preview's 18
            rows); the buttons below it never move. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-4 sm:px-10" data-testid="client-stage-body">
          <div className="flex flex-col gap-3.5">
            {preview && (
              <dl className="divide-y divide-slate-100 rounded-[8px] border border-slate-100" data-testid="client-preview-list">
                {PREVIEW.map(([label, read]) => {
                  const value = String(read(d) || "").trim();
                  return (
                    <div key={label} className="flex gap-4 px-4 py-2">
                      <dt className="w-[230px] shrink-0 text-[14px] font-medium text-slate-500">{label}</dt>
                      <dd className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px] ${value ? "text-slate-800" : "text-slate-400"}`}>{value || "—"}</dd>
                    </div>
                  );
                })}
              </dl>
            )}

            {!preview && stage === 0 && (
              <>
                <Field label="Enter your Name" htmlFor="cs-name" required error={err("name")}>
                  <input
                    id="cs-name"
                    name="cs-fullname"
                    value={d.name}
                    onChange={(e) => { if (typedByHand(e)) set("name")(lettersOnly(e.target.value)); }}
                    onPaste={blockEvent}
                    onDrop={blockEvent}
                    onCopy={blockEvent}
                    onCut={blockEvent}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="words"
                    spellCheck={false}
                    maxLength={60}
                    placeholder="Name"
                    className={`${box(err("name"))} h-10`}
                    data-testid="client-stage-cs-name"
                  />
                </Field>
                <Field label="Mobile Number" htmlFor="cs-contact" required error={err("contact_no")}>
                  <div className="flex gap-3">
                    <ThemedSelect
                      value={d.code}
                      onChange={(code) => setD((cur) => {
                        const c = code || "91";
                        return { ...cur, code: c, number: c === "91" ? cur.number.slice(0, 10) : cur.number };
                      })}
                      options={CODE_OPTIONS}
                      className="h-10 w-[120px] shrink-0 rounded-[8px] border-[#c7cdea] px-4 text-[15px]"
                      testid="client-stage-code"
                    />
                    <input
                      id="cs-contact"
                      type="tel"
                      inputMode="numeric"
                      value={d.number}
                      onChange={(e) => setNumber(e.target.value)}
                      autoComplete="tel-national"
                      placeholder="Mobile Number"
                      className={`${box(err("contact_no"))} h-10 min-w-0 flex-1`}
                      data-testid="client-stage-cs-contact"
                    />
                  </div>
                </Field>
                <Text
                  id="cs-mail"
                  label="Email ID"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={100}
                  value={d.mail_id}
                  onChange={(v) => set("mail_id")(v.replace(/\s/g, ""))}
                  error={err("mail_id")}
                />
              </>
            )}

            {!preview && stage === 1 && (
              <>
                <Field label="Gender" htmlFor="cs-gender">
                  <ThemedSelect
                    value={d.sex}
                    onChange={set("sex")}
                    options={GENDERS}
                    placeholder="Gender"
                    className="h-10 rounded-[8px] border-[#c7cdea] px-4 text-[15px] data-[placeholder]:text-[#8a93b8]"
                    testid="client-stage-cs-gender"
                  />
                </Field>
                <Text id="cs-place" label="Your Place" autoComplete="address-level2" maxLength={60} value={d.place} onChange={(v) => set("place")(cityChars(v))} error={err("place")} />
                <div className="flex flex-col gap-1.5">
                  <span className="text-[15px] font-medium text-slate-900" id="cs-branch">Branch</span>
                  <div role="radiogroup" aria-labelledby="cs-branch" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {PAPER_BRANCHES.map((b) => {
                      const on = d.branch === b;
                      return (
                        <button
                          key={b}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => set("branch")(on ? "" : b)}
                          className={`flex h-10 w-full min-w-0 items-center gap-3 rounded-[8px] border px-4 text-left text-[15px] transition ${on ? "border-[#0066ff] bg-[#0066ff]/[0.04] text-slate-900" : "border-[#c7cdea] text-slate-700 hover:bg-slate-50"}`}
                          data-testid={`client-stage-branch-${b.replace(/[^A-Za-z]/g, "").toLowerCase()}`}
                        >
                          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2" style={{ borderColor: on ? BLUE : "#94a3b8" }}>
                            {on && <span className="h-2 w-2 rounded-full" style={{ background: BLUE }} />}
                          </span>
                          {b}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {!preview && stage === 2 && (
              <>
                <Text id="cs-age" label="Age" inputMode="numeric" value={d.age} onChange={(v) => set("age")(v.replace(/\D/g, "").slice(0, 3))} error={err("age")} />
                <Text id="cs-source" label="Source" maxLength={100} value={d.source_of_reference} onChange={set("source_of_reference")} />
                <Text id="cs-job" label="Nature of Job" maxLength={100} value={d.nature_of_job} onChange={set("nature_of_job")} />
                <Field label="Date" htmlFor="cs-date">
                  <MilkDateInput
                    id="cs-date"
                    value={d.date}
                    onChange={(e) => set("date")(e.target.value || todayIso())}
                    accent="sky"
                    besideRef={cardRef}
                    title="Date"
                    // `!`: MilkDateInput appends this after its own h-9 / rounded-md /
                    // border-input rather than merging, so the plain classes lost.
                    className="!h-10 !rounded-[8px] !border-[#c7cdea] !px-4 !text-[15px] !shadow-none"
                    data-testid="client-stage-cs-date"
                  />
                </Field>
              </>
            )}

            {!preview && stage === 3 && (
              <>
                <Area id="cs-history" label="Past Medical History" value={d.past_medical_history} onChange={set("past_medical_history")} />
                <Area id="cs-medication" label="Any Medication" value={d.any_medication} onChange={set("any_medication")} />
              </>
            )}

            {!preview && stage === 4 && (
              <>
                <Area id="cs-symptoms" label="Symptoms / Root Cause" value={d.symptoms_root_cause} onChange={set("symptoms_root_cause")} />
                <Area id="cs-primary" label="Primary Muscles" value={d.primary_muscles} onChange={set("primary_muscles")} />
              </>
            )}

            {!preview && stage === 5 && (
              <Area id="cs-secondary" label="Secondary Muscles" rows={10} value={d.secondary_muscles} onChange={set("secondary_muscles")} />
            )}

            {!preview && stage === 6 && (
              <>
                <p className="text-[14px] font-semibold text-slate-400">Previous Consultations</p>
                <Area id="cs-prev-consult" label="Previous Medical Consultations" rows={9} value={d.previous_medical_consultations} onChange={set("previous_medical_consultations")} />
              </>
            )}

            {!preview && stage === 7 && (
              <>
                <Area id="cs-prev-diagnosis" label="Previous Diagnosis" value={d.previous_diagnosis} onChange={set("previous_diagnosis")} />
                <Area id="cs-prev-physio" label="Previous Physiotherapy" value={d.previous_physiotherapy} onChange={set("previous_physiotherapy")} />
              </>
            )}
          </div>

          {error && <p className="mt-4 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="client-stage-send-error">{error}</p>}
        </div>

        {/* Fixed at the foot of the popup, the same place on every step. */}
        <div className="shrink-0 px-6 pb-6 pt-3 sm:px-10 sm:pb-7" data-testid="client-stage-footer">
          <div className="flex flex-wrap items-center gap-4">
            {backButton}
            {last && !preview && (
              <button type="button" onClick={() => { if (settled()) setPreview(true); }} disabled={sending} className={outlineCls} data-testid="client-stage-preview">
                <Eye className="h-4 w-4" />Preview
              </button>
            )}
            <button
              type="submit"
              disabled={sending}
              className="flex h-10 items-center gap-1.5 rounded-[8px] px-6 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-95 disabled:opacity-60"
              style={{ background: BLUE }}
              data-testid={last ? "client-stage-submit" : "client-stage-continue"}
            >
              {last ? (
                <>{sending && <Loader2 className="h-4 w-4 animate-spin" />}Submit</>
              ) : (
                <>Next<ArrowRight className="h-4 w-4" /></>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

/** After the last step: the clinic's mark and a thank-you, nothing else. */
export const ClientThankYou = () => (
  <div className="flex min-h-screen items-center justify-center bg-[#eef1f8] px-4" data-testid="client-consult-form-done">
    <div className="w-full max-w-[420px] rounded-[8px] bg-white px-6 py-12 text-center shadow-xl">
      <img src="/logo-icon-192.png" alt="" className="mx-auto h-20 w-20 object-contain" />
      <p className="mt-3 text-xl font-bold text-slate-800">Fitsiomax Clinic</p>
      <p className="mt-8 text-2xl font-semibold" style={{ color: BLUE }}>Thank you</p>
    </div>
  </div>
);
