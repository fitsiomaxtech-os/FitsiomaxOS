import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ThemedSelect } from "@/components/ui/themed-select";
import { PAPER_BRANCHES } from "@/components/branch/ConsultationFormSheets";

/**
 * The client link's first popup (pages/ClientConsultationFormPage): the patient's details,
 * asked before the paper form opens. Name and Contact No must be filled; the rest may be
 * left blank. Continue writes them onto the form, where they show read-only -- a tap on
 * one opens this popup again.
 */

// The form keys this popup owns, read-only on the sheets while the client fills the link.
export const DETAIL_KEYS = ["name", "mail_id", "contact_no", "place", "branch", "date", "source_of_reference", "nature_of_job"];

// India first, as the default; the rest are where the clinic's patients most often live or work.
const COUNTRY_CODES = [
  ["IN", "91"], ["AE", "971"], ["SA", "966"], ["QA", "974"], ["KW", "965"], ["OM", "968"], ["BH", "973"],
  ["SG", "65"], ["MY", "60"], ["LK", "94"], ["NP", "977"], ["BD", "880"], ["GB", "44"], ["US", "1"],
  ["AU", "61"], ["NZ", "64"], ["DE", "49"], ["FR", "33"], ["ZA", "27"],
];
const CODE_OPTIONS = COUNTRY_CODES.map(([iso, code]) => ({ value: code, label: `${iso} +${code}` }));
const LONGEST_FIRST = COUNTRY_CODES.map(([, code]) => code).sort((a, b) => b.length - a.length);

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

const check = (d) => {
  const errors = {};
  const name = d.name.trim();
  if (!name) errors.name = "Please enter your name";
  else if (name.length < 2 || !NAME_OK.test(name)) errors.name = "Please enter a valid name";
  if (d.mail_id && !MAIL_OK.test(d.mail_id)) errors.mail_id = "Please enter a valid email address";
  if (!d.number) errors.contact_no = "Please enter your contact number";
  else if (d.code === "91" ? !/^[6-9]\d{9}$/.test(d.number) : !/^\d{6,12}$/.test(d.number)) {
    errors.contact_no = d.code === "91" ? "Please enter a valid 10-digit mobile number" : "Please enter a valid contact number";
  }
  const place = d.place.trim();
  if (place && !CITY_OK.test(place)) errors.place = "Please enter a valid city name";
  return errors;
};

// Where a failed Continue takes the client: the first box with an error, in form order.
const FIELD_IDS = { name: "cd-name", mail_id: "cd-mail", contact_no: "cd-contact", place: "cd-place" };

const boxCls = "h-10 w-full rounded-[8px] border bg-white px-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:ring-2";
const box = (bad) => `${boxCls} ${bad ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : "border-slate-200 focus:border-sky-400 focus:ring-sky-100"}`;

const Field = ({ label, htmlFor, required, error, children }) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={htmlFor} className="text-sm font-semibold text-slate-700">
      {label}{required && <span className="ml-0.5 text-rose-500">*</span>}
    </label>
    {children}
    {error && <p className="text-xs text-rose-600" data-testid={`client-details-error-${htmlFor}`}>{error}</p>}
  </div>
);

export const ClientDetailsPopup = ({ form, onDone }) => {
  const [d, setD] = useState(() => {
    const phone = splitPhone(form.contact_no);
    return {
      name: lettersOnly(form.name || "").trim(),
      mail_id: form.mail_id || "",
      code: phone.code,
      number: phone.number,
      place: form.place || "",
      branch: PAPER_BRANCHES.includes(form.branch) ? form.branch : "",
      date: form.date || "",
      source_of_reference: form.source_of_reference || "",
      nature_of_job: form.nature_of_job || "",
    };
  });
  // Errors show from the first Continue on, then follow the typing. Not on blur: an error
  // appearing as a box loses focus pushes Continue down under a click already on its way.
  const [tried, setTried] = useState(false);
  const errors = check(d);
  const err = (key) => (tried && errors[key]) || "";
  const set = (key, v) => setD((cur) => ({ ...cur, [key]: v }));

  // The page behind stays still while the popup is up.
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = before; };
  }, []);

  const setNumber = (raw) => {
    let digits = raw.replace(/\D/g, "");
    if (d.code === "91" && digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (d.code === "91" && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    set("number", digits.slice(0, d.code === "91" ? 10 : 12));
  };

  const submit = (e) => {
    e.preventDefault();
    setTried(true);
    const first = Object.keys(errors)[0];
    if (first) { document.getElementById(FIELD_IDS[first])?.focus(); return; }
    onDone({
      name: d.name.trim(),
      mail_id: d.mail_id.trim(),
      contact_no: joinPhone(d.code, d.number),
      place: d.place.trim().replace(/[ '-]+$/, ""),
      branch: d.branch,
      date: d.date,
      source_of_reference: d.source_of_reference.trim(),
      nature_of_job: d.nature_of_job.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-sm" data-testid="client-details-popup">
      <div className="flex min-h-full items-center justify-center p-4">
        <form onSubmit={submit} noValidate autoComplete="off" className="w-full max-w-md rounded-[8px] bg-white p-5 shadow-2xl sm:p-6">
          <h2 className="text-xl font-bold text-slate-800">Fill Your Details</h2>

          <div className="mt-4 flex flex-col gap-3.5">
            <Field label="Name" htmlFor="cd-name" required error={err("name")}>
              <input
                id="cd-name"
                name="cd-fullname"
                value={d.name}
                onChange={(e) => { if (typedByHand(e)) set("name", lettersOnly(e.target.value)); }}
                onPaste={blockEvent}
                onDrop={blockEvent}
                onCopy={blockEvent}
                onCut={blockEvent}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="words"
                spellCheck={false}
                maxLength={60}
                placeholder="Enter your name"
                className={box(err("name"))}
                data-testid="client-details-name"
              />
            </Field>

            <Field label="Mail ID" htmlFor="cd-mail" error={err("mail_id")}>
              <input
                id="cd-mail"
                type="email"
                inputMode="email"
                value={d.mail_id}
                onChange={(e) => set("mail_id", e.target.value.replace(/\s/g, ""))}
                autoComplete="email"
                maxLength={100}
                placeholder="name@example.com"
                className={box(err("mail_id"))}
                data-testid="client-details-mail"
              />
            </Field>

            <Field label="Contact No" htmlFor="cd-contact" required error={err("contact_no")}>
              <div className="flex gap-2">
                <ThemedSelect
                  value={d.code}
                  onChange={(code) => setD((cur) => ({ ...cur, code: code || "91", number: (code || "91") === "91" ? cur.number.slice(0, 10) : cur.number }))}
                  options={CODE_OPTIONS}
                  className="h-10 w-[104px] shrink-0 rounded-[8px]"
                  testid="client-details-code"
                />
                <input
                  id="cd-contact"
                  type="tel"
                  inputMode="numeric"
                  value={d.number}
                  onChange={(e) => setNumber(e.target.value)}
                  autoComplete="tel-national"
                  placeholder="Enter contact number"
                  className={`${box(err("contact_no"))} min-w-0 flex-1`}
                  data-testid="client-details-contact"
                />
              </div>
            </Field>

            <Field label="Place" htmlFor="cd-place" error={err("place")}>
              <input
                id="cd-place"
                value={d.place}
                onChange={(e) => set("place", cityChars(e.target.value))}
                autoComplete="address-level2"
                maxLength={60}
                placeholder="Enter city name"
                className={box(err("place"))}
                data-testid="client-details-place"
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-slate-700" id="cd-branch">Fitsiomax Branch</span>
              <div role="radiogroup" aria-labelledby="cd-branch" className="grid grid-cols-2 gap-x-4 gap-y-2">
                {PAPER_BRANCHES.map((b) => {
                  const on = d.branch === b;
                  return (
                    <button
                      key={b}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set("branch", on ? "" : b)}
                      className="flex items-center gap-2 py-0.5 text-left text-sm text-slate-700"
                      data-testid={`client-details-branch-${b.replace(/[^A-Za-z]/g, "").toLowerCase()}`}
                    >
                      <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${on ? "border-sky-600" : "border-slate-400"}`}>
                        {on && <span className="h-2 w-2 rounded-full bg-sky-600" />}
                      </span>
                      {b}
                    </button>
                  );
                })}
              </div>
            </div>

            <Field label="Date" htmlFor="cd-date">
              <input
                id="cd-date"
                type="date"
                value={d.date}
                onChange={(e) => set("date", e.target.value)}
                className={box(false)}
                data-testid="client-details-date"
              />
            </Field>

            <Field label="Source of Reference" htmlFor="cd-source">
              <input
                id="cd-source"
                value={d.source_of_reference}
                onChange={(e) => set("source_of_reference", e.target.value)}
                maxLength={100}
                placeholder="Enter source of reference"
                className={box(false)}
                data-testid="client-details-source"
              />
            </Field>

            <Field label="Nature of Job" htmlFor="cd-job">
              <input
                id="cd-job"
                value={d.nature_of_job}
                onChange={(e) => set("nature_of_job", e.target.value)}
                maxLength={100}
                placeholder="Enter nature of job"
                className={box(false)}
                data-testid="client-details-job"
              />
            </Field>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              className="flex h-10 items-center gap-1.5 rounded-[8px] bg-sky-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700"
              data-testid="client-details-continue"
            >
              Continue<ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
