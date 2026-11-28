/**
 * The Email ID of a login: the box that checks itself, and the form that verifies one.
 *
 * Two words that are not the same thing, here and on the server (backend/email_check.py):
 *
 *     Valid       the address could receive mail. Answered as it is typed, no button.
 *     Verified    somebody read a code out of it.
 *
 * The box is shared by everything that puts an email on a login (Add / Edit Employee, Create
 * User, Credentials -> Edit, and a person's own Security tab), so they cannot disagree about
 * what is allowed. The server runs the same check on the save and has the last word.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Mail, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { CODE_LENGTH, CodeInput } from "@/components/ui/code-input";
import { toast } from "@/components/ui/sonner";
import {
  checkMyEmail,
  finishMyEmailVerify,
  hrFinishEmailProof,
  hrFinishEmailVerify,
  hrResendEmailProof,
  hrResendEmailVerify,
  hrStartEmailProof,
  hrStartEmailVerify,
  MY_EMAIL_CHANGED_EVENT,
  resendMyEmailVerify,
  startMyEmailVerify,
} from "@/lib/api";

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

// ---------- whose mail it is ----------

const PROVIDER_NAMES = { google: "Google", outlook: "Outlook", yahoo: "Yahoo", zoho: "Zoho" };

/** The mail service's own mark. Anything that is not one of the four is a plain envelope. */
export const MailProviderIcon = ({ provider, className = "h-4 w-4" }) => {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Google">
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
        <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z" />
      </svg>
    );
  }
  if (provider === "outlook") {
    return (
      <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Outlook">
        <rect x="1" y="1" width="10.4" height="10.4" fill="#F25022" />
        <rect x="12.6" y="1" width="10.4" height="10.4" fill="#7FBA00" />
        <rect x="1" y="12.6" width="10.4" height="10.4" fill="#00A4EF" />
        <rect x="12.6" y="12.6" width="10.4" height="10.4" fill="#FFB900" />
      </svg>
    );
  }
  if (provider === "yahoo") {
    return (
      <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Yahoo">
        <rect width="24" height="24" rx="4" fill="#6001D2" />
        <text x="12" y="17" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="14" fill="#fff">Y!</text>
      </svg>
    );
  }
  if (provider === "zoho") {
    return (
      <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Zoho" fill="none" strokeWidth="1.8">
        <rect x="1" y="8" width="7" height="8" rx="1" stroke="#E42527" />
        <rect x="6" y="8" width="7" height="8" rx="1" stroke="#089949" />
        <rect x="11" y="8" width="7" height="8" rx="1" stroke="#226DB4" />
        <rect x="16" y="8" width="7" height="8" rx="1" stroke="#F9B21D" />
      </svg>
    );
  }
  return <Mail className={`${className} text-slate-500`} aria-label="Email" />;
};

// ---------- the automatic check ----------

// Long enough that a name being typed is not checked letter by letter.
const CHECK_DELAY_MS = 600;
const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CANNOT_CHECK = "Could not check this Email ID now. Try again.";

const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * The state of one Email ID box: { status, provider, reason, allowed, retry }.
 *
 *     empty       nothing typed
 *     unchanged   the login's own current address (`current`), which is never checked: a
 *                 login already in the OS keeps its email whatever the check would say
 *     checking    typed, not answered yet
 *     valid / invalid / unchecked   the server's answer
 *
 * `check` takes the address and resolves to the server's answer. An answer for an address
 * that has since been typed over is dropped, so `checking` is what a box shows the moment
 * it changes.
 */
export const useEmailCheck = (email, check, current = "") => {
  const value = String(email || "").trim().toLowerCase();
  const unchanged = Boolean(value) && same(value, current);
  const [answer, setAnswer] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // The latest `check` without listing it below: callers write it inline, and a new one on
  // every render would start the check over on every render.
  const checkRef = useRef(check);
  useEffect(() => { checkRef.current = check; });

  useEffect(() => {
    if (!value || unchanged) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      if (!SHAPE.test(value)) {
        setAnswer({ email: value, status: "invalid", reason: "Enter a full Email ID, like name@gmail.com" });
        return;
      }
      let next;
      try {
        next = await checkRef.current(value);
      } catch {
        next = { status: "unchecked", reason: CANNOT_CHECK };
      }
      if (live) setAnswer({ ...next, email: value });
    }, CHECK_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [value, unchanged, attempt]);

  const retry = useCallback(() => { setAnswer(null); setAttempt((n) => n + 1); }, []);

  const answered = answer?.email === value ? answer : null;
  const status = !value ? "empty" : unchanged ? "unchanged" : answered ? answered.status : "checking";
  return {
    status,
    provider: status === "valid" ? answered.provider : null,
    reason: answered?.reason || "",
    allowed: status === "valid" || status === "unchanged",
    retry,
  };
};

/** Why a save has to wait on this box, or "" when it does not. */
export const emailBlock = (state) => {
  if (state.allowed) return "";
  if (state.status === "empty") return "Enter the Email ID";
  if (state.status === "checking") return "Still checking the Email ID — one moment";
  if (state.status === "invalid") return `Email ID not allowed: ${state.reason}`;
  return state.reason || CANNOT_CHECK;
};

/** The line under the box. `unchangedText` is said of the login's own current address. */
/** `hideValid` leaves the "Valid" line out (Credentials, whose OTP row already says Verified). */
export const EmailIdStatus = ({ state, unchangedText = "", hideValid = false, testid = "email-id" }) => {
  const line = "mt-1 flex min-w-0 items-start gap-1 text-[11px] leading-4";
  const icon = "mt-0.5 h-3 w-3 shrink-0";
  if (state.status === "checking") {
    return <p className={`${line} text-slate-400`} data-testid={`${testid}-status`}><Loader2 className={`${icon} animate-spin`} /> Checking…</p>;
  }
  if (state.status === "valid") {
    if (hideValid) return null;
    const name = PROVIDER_NAMES[state.provider];
    return (
      <p className={`${line} font-semibold text-emerald-600`} data-testid={`${testid}-status`}>
        <CheckCircle2 className={icon} /> Valid{name ? ` · ${name}` : ""}
      </p>
    );
  }
  if (state.status === "invalid") {
    return (
      <p className={`${line} text-rose-600`} data-testid={`${testid}-status`}>
        <XCircle className={icon} />
        <span className="min-w-0 break-words"><b>Not Allowed</b> · {state.reason}</span>
      </p>
    );
  }
  if (state.status === "unchecked") {
    return (
      <p className={`${line} text-amber-600`} data-testid={`${testid}-status`}>
        <AlertTriangle className={icon} />
        <span className="min-w-0 break-words">
          {state.reason}{" "}
          <button type="button" onClick={state.retry} className="font-semibold underline" data-testid={`${testid}-retry`}>Check again</button>
        </span>
      </p>
    );
  }
  if (state.status === "unchanged" && unchangedText) {
    return <p className={`${line} text-slate-400`} data-testid={`${testid}-status`}>{unchangedText}</p>;
  }
  return null;
};

/** The Email ID box: what is typed, the mark of whose mail it is, and the answer under it.
 *  `provider` is the mark for the login's own (unchanged, verified) address, which is never
 *  re-checked. Any other prop goes to the input. */
export const EmailIdInput = ({
  value, onChange, state, unchangedText = "", provider = null, hideValid = false, className = "", testid = "email-id", ...rest
}) => (
  <div>
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter the Email ID"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={state.status === "invalid"}
        className={`pr-10 ${className}`}
        data-testid={testid}
        {...rest}
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-center" data-testid={`${testid}-icon`}>
        {state.status === "checking" && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        {state.status === "valid" && <MailProviderIcon provider={state.provider} />}
        {state.status === "unchanged" && provider && <MailProviderIcon provider={provider} />}
        {state.status === "invalid" && <XCircle className="h-4 w-4 text-rose-500" />}
      </span>
    </div>
    <EmailIdStatus state={state} unchangedText={unchangedText} hideValid={hideValid} testid={testid} />
  </div>
);

/** Verified / Not Verified, wherever a login's email is shown. With `provider` (google,
 *  outlook, yahoo, zoho), a verified one reads "Verified by [that service's logo]". */
export const EmailVerifiedTag = ({ verified, provider, testid }) => {
  const name = verified ? PROVIDER_NAMES[provider] : "";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${verified ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
      title={verified ? `A code was read out of this ${name ? `${name} ` : ""}Email ID` : "Nobody has read a code out of this Email ID yet"}
      data-testid={testid}
    >
      {verified ? (name ? "Verified by" : "Verified") : "Not Verified"}
      {name && <MailProviderIcon provider={provider} className="h-3 w-3" />}
    </span>
  );
};

const Label = ({ children }) => <p className="mb-1 text-[11px] text-slate-400">{children}</p>;

// ---------- verifying somebody else's ----------

/**
 * An admin (Super Admin, BDE, Branch Admin) verifying another login's Email ID: Send Code
 * mails a code to that inbox, its holder reads it out, the admin types it in. `onVerified`
 * runs once the server says Verified.
 */
export const AdminEmailVerify = ({ userId, email, onVerified, testid = "admin-email-verify" }) => {
  const [pending, setPending] = useState(null); // { challenge_id, email_masked }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    try {
      setBusy(true);
      const data = await hrStartEmailVerify(userId);
      setPending(data);
      setCode("");
      toast.success(`Code sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    try {
      setBusy(true);
      const data = await hrResendEmailVerify(userId, pending.challenge_id);
      setPending((p) => ({ ...p, ...data }));
      setCode("");
      toast.success(`New code sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    if (code.length !== CODE_LENGTH) { toast.error(`Enter the ${CODE_LENGTH}-digit code`); return; }
    try {
      setBusy(true);
      const data = await hrFinishEmailVerify(userId, pending.challenge_id, code);
      toast.success(data.message || "Email ID verified");
      onVerified?.(data);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  if (!pending) {
    return (
      <div className="space-y-2" data-testid={testid}>
        <p className="text-xs text-slate-500">
          A code goes to <b className="break-all text-slate-700">{email}</b>. Ask them to read it out, then enter it here.
        </p>
        <Button type="button" onClick={send} disabled={busy} className="w-full rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-send`}>
          {busy ? "Sending code…" : "Send Code"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={`${testid}-code-step`}>
      <div>
        <Label>Code sent to {pending.email_masked}. It expires in 5 minutes.</Label>
        <CodeInput value={code} onChange={setCode} onEnter={verify} testid={`${testid}-code`} autoFocus />
      </div>
      <Button type="button" onClick={verify} disabled={busy} className="w-full rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-verify`}>
        {busy ? "Checking…" : "Verify"}
      </Button>
      <div className="flex justify-end">
        <button type="button" onClick={resend} disabled={busy} className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50" data-testid={`${testid}-resend`}>
          Send another code
        </button>
      </div>
    </div>
  );
};

// ---------- proving a new one before its login exists ----------

/** Whether `proof` ({ proof_id, email }) proves this address. */
export const provesEmail = (proof, email) => Boolean(proof?.proof_id) && same(proof.email, email);

/**
 * The OTP row under a new login's Email ID (Add / Edit Employee -> Credentials): Send OTP
 * once the box says Valid, the code its holder reads out, Verify. `onProof` gets
 * { proof_id, email } -- held by the form and spent on the login when it is saved.
 */
export const EmailOtpVerify = ({ email, state, proof, onProof, employeeId, fullName, testid = "email-otp" }) => {
  const [pending, setPending] = useState(null); // { challenge_id, email_masked, email }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const value = String(email || "").trim();
  // A code sent to an address since typed over is for that one, not this.
  const live = pending && same(pending.email, value) ? pending : null;

  if (provesEmail(proof, value)) {
    return (
      <p className="flex h-8 items-center gap-1.5 text-xs font-semibold text-emerald-600" data-testid={`${testid}-verified`}>
        <CheckCircle2 className="h-4 w-4" /> Verified
        {state.provider && <MailProviderIcon provider={state.provider} className="h-4 w-4" />}
      </p>
    );
  }

  const send = async () => {
    try {
      setBusy(true);
      const data = await hrStartEmailProof({ email: value, employee_id: employeeId || undefined, full_name: fullName || undefined });
      setPending({ ...data, email: value });
      setCode("");
      toast.success(`OTP sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    try {
      setBusy(true);
      const data = await hrResendEmailProof(live.challenge_id);
      setPending((p) => ({ ...p, ...data }));
      setCode("");
      toast.success(`New OTP sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    if (code.length !== CODE_LENGTH) { toast.error(`Enter the ${CODE_LENGTH}-digit OTP`); return; }
    try {
      setBusy(true);
      const data = await hrFinishEmailProof(live.challenge_id, code);
      toast.success(data.message || "Email ID verified");
      setPending(null);
      setCode("");
      onProof?.({ proof_id: data.proof_id, email: data.email || value });
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const hint = "mt-1 text-[11px] leading-4 text-slate-400";
  if (!live) {
    const ready = state.status === "valid";
    return (
      <div data-testid={testid}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={send}
          disabled={!ready || busy}
          className="h-8 text-xs"
          data-testid={`${testid}-send`}
        >
          <Mail className="mr-1.5 h-3.5 w-3.5" /> {busy ? "Sending OTP…" : "Send OTP"}
        </Button>
        <p className={hint}>
          {ready ? "Sends a 6-digit code to this Email ID — ask them to read it out." : "Enter a valid Email ID first."}
        </p>
      </div>
    );
  }

  return (
    <div data-testid={`${testid}-code-step`}>
      <div className="flex items-center gap-2">
        <CodeInput value={code} onChange={setCode} onEnter={verify} testid={`${testid}-code`} autoFocus className="h-8 w-36 text-sm tracking-[0.35em]" />
        <Button type="button" size="sm" onClick={verify} disabled={busy} className="h-8 bg-sky-600 text-xs hover:bg-sky-700" data-testid={`${testid}-verify`}>
          {busy ? "Checking…" : "Verify"}
        </Button>
        <button type="button" onClick={resend} disabled={busy} className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50" data-testid={`${testid}-resend`}>
          Resend
        </button>
      </div>
      <p className={hint}>OTP sent to {live.email_masked}. It expires in 5 minutes.</p>
    </div>
  );
};

// ---------- verifying my own ----------

/**
 * Verify the Email ID I sign in with, or move my login to another one: the address, then the
 * code that was sent to it. Used by the Security tab and the "Update your Email ID" message.
 *
 * Moving asks for the current password too (the server does, and says why); verifying the
 * one already there does not. App is told when it is done, so the copy of the signed-in user
 * it holds, and the message with it, follow without a reload.
 */
export const EmailUpdateForm = ({ currentEmail, verified = false, onDone, onCancel, testid = "email-update" }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(null); // { challenge_id, email_masked }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const state = useEmailCheck(email, checkMyEmail, currentEmail);
  const changing = state.status !== "empty" && state.status !== "unchanged";
  const alreadyVerified = verified && state.status === "unchanged";

  const send = async (e) => {
    e?.preventDefault?.();
    const block = emailBlock(state);
    if (block) { toast.error(block); return; }
    if (alreadyVerified) { toast.error("This Email ID is already verified"); return; }
    if (changing && !password) { toast.error("Enter your current password"); return; }
    try {
      setBusy(true);
      const data = await startMyEmailVerify(email.trim(), changing ? password : "");
      setPending(data);
      setCode("");
      toast.success(`Code sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    try {
      setBusy(true);
      const data = await resendMyEmailVerify(pending.challenge_id);
      setPending((p) => ({ ...p, ...data }));
      setCode("");
      toast.success(`New code sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    if (code.length !== CODE_LENGTH) { toast.error(`Enter the ${CODE_LENGTH}-digit code`); return; }
    try {
      setBusy(true);
      const data = await finishMyEmailVerify(pending.challenge_id, code);
      toast.success(data.message);
      window.dispatchEvent(new CustomEvent(MY_EMAIL_CHANGED_EVENT, {
        detail: { email: data.email, email_verified_at: data.email_verified_at },
      }));
      onDone?.(data);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  if (pending) {
    return (
      <div className="space-y-3" data-testid={`${testid}-code-step`}>
        <div>
          <Label>Code sent to {pending.email_masked}. It expires in 5 minutes.</Label>
          <CodeInput value={code} onChange={setCode} onEnter={verify} testid={`${testid}-code`} autoFocus />
        </div>
        <Button onClick={verify} disabled={busy} className="w-full rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-verify`}>
          {busy ? "Checking…" : "Verify"}
        </Button>
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => { setPending(null); setCode(""); }} disabled={busy} className="text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50" data-testid={`${testid}-back`}>
            Change Email ID
          </button>
          <button type="button" onClick={resend} disabled={busy} className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50" data-testid={`${testid}-resend`}>
            Send another code
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-3" onSubmit={send} data-testid={`${testid}-form`}>
      <div>
        <Label>Email ID</Label>
        <EmailIdInput
          value={email}
          onChange={setEmail}
          state={state}
          unchangedText={alreadyVerified ? "This Email ID is already verified" : "Your current Email ID. The code goes to it."}
          className="rounded-[4px] border-slate-200 bg-white"
          testid={`${testid}-email`}
        />
        {!verified && state.status === "empty" && currentEmail && (
          <button type="button" onClick={() => setEmail(currentEmail)} className="mt-1 text-[11px] font-medium text-sky-600 hover:text-sky-700" data-testid={`${testid}-use-current`}>
            Use my current Email ID
          </button>
        )}
      </div>
      {changing && (
        <div>
          <Label>Current password</Label>
          <SecretInput value={password} onChange={setPassword} placeholder="The one you signed in with" autoComplete="current-password" className="rounded-[4px]" testid={`${testid}-password`} />
        </div>
      )}
      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy} className="flex-1 rounded-[4px]" data-testid={`${testid}-cancel`}>Cancel</Button>
        )}
        <Button type="submit" disabled={busy || !state.allowed || alreadyVerified} className="flex-1 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid={`${testid}-send`}>
          {busy ? "Sending code…" : "Send Code"}
        </Button>
      </div>
    </form>
  );
};
