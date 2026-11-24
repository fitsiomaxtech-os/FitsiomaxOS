import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, Loader2, Printer, X } from "lucide-react";
import { ThemedSelect } from "@/components/ui/themed-select";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { SpellTextarea } from "@/components/ui/spell-textarea";
import { PAPER_BRANCHES, sameBranch, todayIso } from "@/components/branch/ConsultationFormSheets";
import { loadSpelling } from "@/lib/spellcheck";

/**
 * The client link (pages/ClientConsultationFormPage), asked as eight short steps instead of
 * the paper, one field per row. Name, Mobile Number and Branch must be filled. The last step
 * can show every answer first (Preview, optional: the ten short ones as rows, the longer
 * writing in boxes that grow with it, both two a line), then sends the lot; the client sees
 * only a thank-you -- the filled paper is for the clinic's eyes (Branch Admin opens it as a
 * read-only report). The popup is 1020 wide and as tall as its step, so Previous / Next sit
 * the same gap under the last field on every step; its top stays put
 * (where a 520-high popup would sit centred). The progress bar is above it. Each step is
 * headed "Consultation Form", centred; the date is picked in the OS's own calendar. Every
 * move slides the whole popup: Next sends it off the screen to the left, then the next
 * step's popup comes in from the right (Previous the other way round); the progress bar
 * stays put and fills (or empties) as the new popup comes in.
 *
 * `onClose` puts the same steps over the app instead of a page of their own: Branch Admin's
 * lead popup opens it from its Form button (LeadConsultationFormPopup), and the card gets
 * a close cross. The overlay around it scrolls, so it is the one put back at the top.
 * `onPrint` adds Print at the right of the last step's (and Preview's) buttons; it is given
 * the answers as they stand. The client link passes none: the paper is the clinic's.
 */

const STAGES = 8;
const BLUE = "#0066ff";
// The progress bar's fill.
const GREEN = "#198754";
// The popup's heading and its buttons.
const ACCENT = "rgb(26 162 231 / 76%)";
// A move: the popup goes out (speeding up), then the next one comes in (slowing down).
// Moves are refused until both are over. The progress bar's fill repeats the way in, in
// its classes (duration-[400ms], ease-[...]).
const OUT_MS = 300;
const OUT_EASE = "cubic-bezier(0.32, 0, 0.67, 0)";
const IN_MS = 400;
const IN_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
// Past the screen's edge by this much, so the shadow goes too.
const OFF_EDGE = 40;

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
    if (!d.branch) errors.branch = "Please select your branch";
  }
  if (stage === 2) {
    if (d.age && (Number(d.age) < 1 || Number(d.age) > 120)) errors.age = "Please enter a valid age";
  }
  return errors;
};
// Where a failed Next takes the client: the first box with an error, in form order.
const FIELD_IDS = { name: "cs-name", contact_no: "cs-contact", mail_id: "cs-mail", place: "cs-place", branch: "cs-branch-first", age: "cs-age" };

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

// The free-text answers: spelling and grammar are checked inside the box, medical words first.
const Area = ({ id, label, value, onChange, rows = 4 }) => (
  <SpellTextarea
    id={id}
    label={label}
    labelClassName="text-[15px] font-medium text-slate-900"
    value={value}
    onChange={onChange}
    rows={rows}
    maxLength={5000}
    placeholder={label}
    className={`${box(false)} resize-none py-2 leading-relaxed`}
    testid={`client-stage-${id}`}
  />
);

const startFrom = (form, branches) => {
  const phone = splitPhone(form.contact_no);
  const text = (k) => String(form[k] || "");
  return {
    name: lettersOnly(text("name")).trim(),
    code: phone.code,
    number: phone.number,
    mail_id: text("mail_id"),
    sex: GENDERS.includes(form.sex) ? form.sex : "",
    place: text("place"),
    // The pick the desk sent (its own branch), as the list spells it; else none.
    branch: branches.find((b) => sameBranch(b, form.branch)) || "",
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

// Preview before Submit: every answer, not in the paper's layout. The first PREVIEW_SHORT
// (Name to Date) are label-and-value rows, the rest a box each; both go two a line.
const PREVIEW_SHORT = 10;
// Black headers, grey answers: exact colours, so no theme changes them.
const PREVIEW_HEADER = { color: "#000000" };
const PREVIEW_ANSWER = { color: "#6b7280", fontFamily: "Lexend, sans-serif", fontWeight: 400 };
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

const outlineCls = "flex h-10 items-center gap-1.5 rounded-[8px] border bg-white px-5 text-[15px] font-medium transition hover:bg-slate-50 disabled:opacity-60";
const outlineStyle = { borderColor: ACCENT, color: ACCENT };

export const ClientFormStages = ({ form, branches: liveBranches, sending = false, error = "", onSubmit, onClose, onPrint }) => {
  // The live offline branches from the link's own fetch; the paper's four should none come.
  const branches = liveBranches?.length ? liveBranches : PAPER_BRANCHES;
  const [d, setD] = useState(() => startFrom(form, branches));
  // What it opened with, so the close cross asks first only when something was changed.
  const [opened] = useState(d);
  const close = () => {
    if (sending) return;
    if (JSON.stringify(d) !== JSON.stringify(opened) && !window.confirm("Close the form? What you changed will be lost.")) return;
    onClose();
  };
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
  // The spell check's word list, fetched in the background while the first steps are
  // filled, so the free-text steps check from their first word.
  useEffect(() => {
    const t = window.setTimeout(loadSpelling, 1500);
    return () => window.clearTimeout(t);
  }, []);

  // What the popup shows: steps 0-7, then Preview as one step more.
  const view = preview ? STAGES : stage;
  // A move under way: { to, dir, phase: "out" | "in" }. Next, Previous and Preview wait
  // for it to end, so a double tap on Next cannot skip a step.
  const [moving, setMoving] = useState(null);
  const bodyRef = useRef(null);

  // The new step, put in while the popup is off the screen.
  const show = (to) => {
    setPreview(to === STAGES);
    if (to < STAGES) setStage(to);
    setTried(false);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    window.scrollTo({ top: 0 });
    cardRef.current?.closest("[data-cs-scroll]")?.scrollTo?.({ top: 0 });
  };

  const go = (to) => {
    if (moving || to === view) return;
    movedAt.current = Date.now();
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (calm || typeof cardRef.current?.animate !== "function") { show(to); return; }
    setMoving({ to, dir: to > view ? 1 : -1, phase: "out" });
  };

  // The whole popup moves, one way then the other: out past one edge of the screen, the
  // step swapped while nothing shows, then in from the other edge. Each half starts before
  // paint, so the popup never shows at rest in between.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!moving || !card) return undefined;
    const box = card.getBoundingClientRect();
    const screen = document.documentElement.clientWidth;
    // How far each way takes the popup clear of the screen.
    const toLeft = -(box.right + OFF_EDGE);
    const toRight = screen - box.left + OFF_EDGE;
    const goingOut = moving.phase === "out";
    const away = goingOut ? (moving.dir > 0 ? toLeft : toRight) : (moving.dir > 0 ? toRight : toLeft);
    const anim = card.animate(
      goingOut
        ? [{ transform: "translateX(0)" }, { transform: `translateX(${away}px)` }]
        : [{ transform: `translateX(${away}px)` }, { transform: "translateX(0)" }],
      goingOut
        ? { duration: OUT_MS, easing: OUT_EASE, fill: "forwards" }
        : { duration: IN_MS, easing: IN_EASE, fill: "backwards" },
    );
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      if (goingOut) { show(moving.to); setMoving({ ...moving, phase: "in" }); } else setMoving(null);
    };
    anim.onfinish = done;
    // Should the finish never come (a hidden tab), the move still ends.
    const timer = window.setTimeout(done, (goingOut ? OUT_MS : IN_MS) + 300);
    return () => { ended = true; window.clearTimeout(timer); anim.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);

  const setNumber = (raw) => {
    let digits = raw.replace(/\D/g, "");
    if (d.code === "91" && digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (d.code === "91" && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    set("number")(digits.slice(0, d.code === "91" ? 10 : 12));
  };

  // Every answer as it is saved, and as Print writes it on the paper.
  const answers = () => ({
    ...Object.fromEntries(TRIM_KEYS.map((k) => [k, d[k].trim()])),
    name: d.name.trim(),
    contact_no: joinPhone(d.code, d.number),
    age: d.age,
    place: d.place.trim().replace(/[ '-]+$/, ""),
    date: d.date || todayIso(),
  });

  const next = (e) => {
    e.preventDefault();
    if (sending || moving) return;
    setTried(true);
    const first = Object.keys(errors)[0];
    if (first) { document.getElementById(FIELD_IDS[first])?.focus(); return; }
    if (!last) { go(stage + 1); return; }
    if (!settled()) return;
    onSubmit(answers());
  };

  const backButton = (preview || stage > 0) && (
    <button
      type="button"
      onClick={() => go(view - 1)}
      disabled={sending}
      className={outlineCls}
      style={outlineStyle}
      data-testid={preview ? "client-preview-back" : "client-stage-back"}
    >
      <ArrowLeft className="h-4 w-4" />Previous
    </button>
  );

  return (
    // From tablet width up the top is held where a 520-high popup would sit centred, half
    // the screen less 271px (half of the bar's 22 and the 520): a shorter or taller step
    // moves only the popup's foot. The popup stops 40px above the screen's foot; beyond
    // that its body scrolls. Clipped at its sides, so a popup off the screen mid-move adds
    // no sideways scroll.
    <div
      className={`flex flex-col items-center justify-start overflow-x-clip ${onClose ? "min-h-full" : "min-h-screen bg-[#eef1f8]"} px-4 py-6 md:pb-10 md:pt-[var(--cs-top)] md:[--cs-top:max(2.5rem,calc(50vh_-_271px))]`}
      data-testid="client-stages"
    >
      {/* The progress sits above the popup, not in it, and stays put as the popup moves.
          Each bar fills from its left as its step's popup comes in, and empties back when
          Previous brings the step before it in. */}
      <div className="mb-4 flex w-full max-w-[1020px] gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={STAGES} aria-valuenow={stage + 1} aria-label="Progress" data-testid="client-stage-progress">
        {Array.from({ length: STAGES }, (_, i) => (
          <span key={i} className="relative h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "#dfe4ee" }}>
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-[400ms] ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none"
              style={{ width: i <= stage ? "100%" : "0%", background: GREEN }}
            />
          </span>
        ))}
      </div>

      <form
        ref={cardRef}
        onSubmit={next}
        noValidate
        autoComplete="off"
        className="relative flex w-full max-w-[1020px] flex-col rounded-[18px] bg-white shadow-xl md:max-h-[calc(100vh_-_var(--cs-top)_-_22px_-_2.5rem)]"
        data-testid={preview ? "client-preview" : `client-stage-${stage + 1}`}
      >
        {onClose && (
          <button
            type="button"
            onClick={close}
            disabled={sending}
            className="absolute right-4 top-4 rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 sm:right-5 sm:top-5"
            aria-label="Close"
            title="Close"
            data-testid="client-stage-close"
          >
            <X className="h-5 w-5" />
          </button>
        )}
        <h1 className="px-6 pt-6 text-center text-[24px] font-semibold sm:px-10 sm:pt-7 sm:text-[26px]" style={{ color: ACCENT }} data-testid="client-stage-heading">{preview ? "Preview" : "Consultation Form"}</h1>

        {/* Rows only: one field under another. The body is as tall as its step, the
            buttons a set gap under it; past the screen's height it scrolls (Preview) and
            the buttons stay in view. */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pb-4 pt-4 sm:px-10" data-testid="client-stage-body">
          <div
            key={view}
            inert={moving !== null}
            className="flex min-w-0 flex-col gap-3.5"
            data-testid="client-stage-panel"
          >
            {view === STAGES && (
              // Two columns from tablet width up; a phone keeps one.
              <>
                <dl className="grid grid-cols-1 rounded-[8px] border border-slate-100 sm:grid-cols-2" data-testid="client-preview-list">
                  {PREVIEW.slice(0, PREVIEW_SHORT).map(([label, read], i) => {
                    const value = String(read(d) || "").trim();
                    // No line under the last row: one cell of it on a phone, two from there up.
                    const under = i === PREVIEW_SHORT - 1 ? "" : i === PREVIEW_SHORT - 2 ? "border-b sm:border-b-0" : "border-b";
                    return (
                      <div key={label} className={`flex min-w-0 gap-4 border-slate-100 px-4 py-2 ${under} ${i % 2 === 0 ? "sm:border-r" : ""}`}>
                        <dt className="w-[130px] shrink-0 text-[14px] font-medium" style={PREVIEW_HEADER}>{label}</dt>
                        <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px]" style={PREVIEW_ANSWER}>{value || "—"}</dd>
                      </div>
                    );
                  })}
                </dl>
                {/* Each box is as tall as its writing, never less than two lines; the two on
                    one line stretch to the taller. */}
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2" data-testid="client-preview-boxes">
                  {PREVIEW.slice(PREVIEW_SHORT).map(([label, read]) => {
                    const value = String(read(d) || "").trim();
                    return (
                      <div key={label} className="flex min-w-0 flex-col gap-1.5">
                        <dt className="text-[14px] font-medium" style={PREVIEW_HEADER}>{label}</dt>
                        <dd className="min-h-[64px] grow whitespace-pre-wrap break-words rounded-[8px] border border-[#c7cdea] bg-white px-4 py-2 text-[14px] leading-relaxed" style={PREVIEW_ANSWER}>{value || "—"}</dd>
                      </div>
                    );
                  })}
                </dl>
              </>
            )}

            {view === 0 && (
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

            {view === 1 && (
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
                  <span className="text-[15px] font-medium text-slate-900" id="cs-branch">
                    Branch<span className="ml-1 text-rose-600">*</span>
                  </span>
                  {/* Required: a pick can be changed, not cleared. One row, a column per
                      branch, however many the OS has (two branches: two halves; six: six
                      sixths). A phone is too narrow for that, so there they go two a row. */}
                  <div
                    role="radiogroup"
                    aria-labelledby="cs-branch"
                    aria-required="true"
                    aria-invalid={Boolean(err("branch"))}
                    className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(var(--cs-branches),minmax(0,1fr))]"
                    style={{ "--cs-branches": branches.length }}
                    data-testid="client-stage-branches"
                  >
                    {branches.map((b, i) => {
                      const on = d.branch === b;
                      return (
                        <button
                          key={b}
                          id={i === 0 ? "cs-branch-first" : undefined}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => set("branch")(b)}
                          title={b}
                          className={`flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[8px] border px-3 text-left text-[15px] transition ${on ? "border-[#0066ff] bg-[#0066ff]/[0.04] text-slate-900" : `${err("branch") ? "border-rose-300" : "border-[#c7cdea]"} text-slate-700 hover:bg-slate-50`}`}
                          data-testid={`client-stage-branch-${b.replace(/[^A-Za-z]/g, "").toLowerCase()}`}
                        >
                          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2" style={{ borderColor: on ? BLUE : "#94a3b8" }}>
                            {on && <span className="h-2 w-2 rounded-full" style={{ background: BLUE }} />}
                          </span>
                          <span className="min-w-0 truncate">{b}</span>
                        </button>
                      );
                    })}
                  </div>
                  {err("branch") && <p className="text-xs text-rose-600" data-testid="client-stage-error-cs-branch">{err("branch")}</p>}
                </div>
              </>
            )}

            {view === 2 && (
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

            {view === 3 && (
              <>
                <Area id="cs-history" label="Past Medical History" value={d.past_medical_history} onChange={set("past_medical_history")} />
                <Area id="cs-medication" label="Any Medication" value={d.any_medication} onChange={set("any_medication")} />
              </>
            )}

            {view === 4 && (
              <>
                <Area id="cs-symptoms" label="Symptoms / Root Cause" value={d.symptoms_root_cause} onChange={set("symptoms_root_cause")} />
                <Area id="cs-primary" label="Primary Muscles" value={d.primary_muscles} onChange={set("primary_muscles")} />
              </>
            )}

            {view === 5 && (
              <Area id="cs-secondary" label="Secondary Muscles" rows={10} value={d.secondary_muscles} onChange={set("secondary_muscles")} />
            )}

            {view === 6 && (
              <>
                <p className="text-[14px] font-semibold text-slate-400">Previous Consultations</p>
                <Area id="cs-prev-consult" label="Previous Medical Consultations" rows={9} value={d.previous_medical_consultations} onChange={set("previous_medical_consultations")} />
              </>
            )}

            {view === 7 && (
              <>
                <Area id="cs-prev-diagnosis" label="Previous Diagnosis" value={d.previous_diagnosis} onChange={set("previous_diagnosis")} />
                <Area id="cs-prev-physio" label="Previous Physiotherapy" value={d.previous_physiotherapy} onChange={set("previous_physiotherapy")} />
              </>
            )}
          </div>

          {error && <p className="mt-4 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="client-stage-send-error">{error}</p>}
        </div>

        {/* At the foot of the popup, the same gap under the last field on every step. */}
        <div className="shrink-0 px-6 pb-6 pt-3 sm:px-10 sm:pb-7" data-testid="client-stage-footer">
          <div className="flex flex-wrap items-center gap-4">
            {backButton}
            {last && !preview && (
              <button type="button" onClick={() => { if (settled()) go(STAGES); }} disabled={sending} className={outlineCls} style={outlineStyle} data-testid="client-stage-preview">
                <Eye className="h-4 w-4" />Preview
              </button>
            )}
            <button
              type="submit"
              disabled={sending}
              className="flex h-10 items-center gap-1.5 rounded-[8px] px-6 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-95 disabled:opacity-60"
              style={{ background: ACCENT }}
              data-testid={last ? "client-stage-submit" : "client-stage-continue"}
            >
              {last ? (
                <>{sending && <Loader2 className="h-4 w-4 animate-spin" />}Submit</>
              ) : (
                <>Next<ArrowRight className="h-4 w-4" /></>
              )}
            </button>
            {last && onPrint && (
              <button type="button" onClick={() => { if (!moving && settled()) onPrint(answers()); }} disabled={sending} className={`${outlineCls} ml-auto`} style={outlineStyle} title="Print" data-testid="client-stage-print">
                <Printer className="h-4 w-4" />Print
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
};

/** After the last step: a 680 x 280 card, blue top strip, the thank-you on the left, a faded logo on the right. */
export const ClientThankYou = () => (
  <div className="flex min-h-screen items-center justify-center bg-[#eef1f8] px-4" data-testid="client-consult-form-done">
    <div
      className="relative flex w-full max-w-[680px] flex-col overflow-hidden rounded-[4px] bg-white shadow-xl sm:h-[280px]"
      data-testid="client-thanks-card"
    >
      <div className="h-3 shrink-0" style={{ background: BLUE }} />
      {/* The PNG carries wide padding, so the box is large; the mark itself is ~165px. */}
      <img
        src="/logo-icon-192.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute -right-[63px] top-[calc(50%+6px)] hidden h-[350px] w-[350px] -translate-y-1/2 select-none object-contain opacity-[0.13] sm:block"
      />
      <div className="relative flex flex-1 flex-col justify-center px-7 py-8 sm:px-11 sm:py-0">
        <p className="text-[22px] font-bold leading-tight text-[#0b1a44] sm:text-[28px]">
          Fitsiomax <span style={{ color: BLUE }}>OS</span>
        </p>
        <p className="mt-3 text-[40px] font-extrabold leading-none tracking-tight sm:text-[54px]" style={{ color: BLUE }}>
          Thank You!
        </p>
        <p className="mt-5 text-[16px] leading-[1.45] text-slate-600 sm:text-[19px]">
          Your details have been submitted successfully.
          <br />
          Our team will get in touch with you shortly.
        </p>
      </div>
    </div>
  </div>
);
