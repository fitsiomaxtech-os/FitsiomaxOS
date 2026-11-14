/**
 * Security — the fourth tab of everybody's own page, and the only one that changes a login.
 *
 *     Password        change my own, knowing the old one
 *     Two-factor      a code to my email at every sign-in, on or off
 *     Devices         how many places this account is signed in, and a way to end the rest
 *
 * In its own file for the reason Time Off is: MyProfilePage.jsx is already six hundred
 * lines, and the tabs that write are the ones most likely to be edited on their own.
 *
 * Every request behind this reads /me/security, which takes no id — so this is the same
 * screen for a Super Admin and a physio, showing each of them only their own login. HR's
 * side of the subject stays under Credentials, where it is somebody else's account being
 * changed by somebody accountable for changing it.
 *
 * Turning two-factor on and turning it off both go through a code to the registered
 * address. The second one is the one worth arguing about, and the answer is that a session
 * is whoever is at the desk while the mailbox is the person — without it, an unlocked
 * screen is enough to strip somebody's second factor.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { CODE_LENGTH, CodeInput } from "@/components/ui/code-input";
import {
  changeMyPassword,
  mySecurity,
  resendMy2fa,
  revokeMyOtherSessions,
  startMy2fa,
  verifyMy2fa,
} from "@/lib/api";

const fail = (e) => toast.error(e?.response?.data?.detail || e?.message || "Something went wrong");

const MIN_PASSWORD = 6;

const prettyMoment = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ---------- small pieces ----------

// Shared by every dashboard; long forms and session lists scroll inside the panel.
const SECURITY_FRAME = "mx-auto h-[550px] w-full max-w-[720px] space-y-3 overflow-y-auto rounded-[4px] border border-slate-200 bg-white p-3 shadow-sm";

const Panel = ({ title, icon: Icon, children, right, testid }) => (
  <section className="rounded-[4px] border border-slate-200 bg-white p-4" data-testid={testid}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        {Icon && <Icon className="h-4 w-4 text-slate-400" />}
        {title}
      </h3>
      {right}
    </div>
    {children}
  </section>
);

const Label = ({ children }) => <p className="mb-1 text-[11px] text-slate-400">{children}</p>;

/** A password box with the eye, because a password typed blind into a form that also asks
 *  for it twice is the form people give up on. */
const SecretInput = ({ value, onChange, placeholder, testid, autoComplete }) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="border-slate-200 bg-white pr-10"
        data-testid={testid}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        tabIndex={-1}
        aria-label={shown ? "Hide password" : "Show password"}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        data-testid={`${testid}-toggle`}
      >
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
};

// ---------- password ----------

const PasswordPanel = ({ onChanged }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [busy, setBusy] = useState(false);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const close = () => {
    setOpen(false);
    setForm({ current_password: "", new_password: "", confirm_password: "" });
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    // Checked here as well as on the server so the two obvious mistakes come back without
    // a round trip. The server checks them again regardless — this form is not the only
    // way to reach that endpoint.
    if (!form.current_password) { toast.error("Enter your current password"); return; }
    if (form.new_password.length < MIN_PASSWORD) { toast.error(`New password must be at least ${MIN_PASSWORD} characters`); return; }
    if (form.new_password !== form.confirm_password) { toast.error("The two new passwords do not match"); return; }
    try {
      setBusy(true);
      const data = await changeMyPassword(form);
      toast.success(
        data.sessions_ended
          ? `Password changed. Signed out of ${data.sessions_ended} other device${data.sessions_ended === 1 ? "" : "s"}.`
          : "Password changed",
      );
      close();
      onChanged();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  return (
    <Panel
      title="Password"
      icon={KeyRound}
      testid="my-security-password"
      right={!open && (
        <Button onClick={() => setOpen(true)} className="bg-sky-600 hover:bg-sky-700" data-testid="my-security-password-open">
          Change password
        </Button>
      )}
    >
      {open && (
        <form className="max-w-md space-y-3" onSubmit={submit} data-testid="my-security-password-form">
          <div>
            <Label>Current password</Label>
            <SecretInput
              value={form.current_password}
              onChange={(v) => set({ current_password: v })}
              placeholder="The one you signed in with"
              autoComplete="current-password"
              testid="my-security-current-password"
            />
          </div>
          <div>
            <Label>New password</Label>
            <SecretInput
              value={form.new_password}
              onChange={(v) => set({ new_password: v })}
              placeholder={`At least ${MIN_PASSWORD} characters`}
              autoComplete="new-password"
              testid="my-security-new-password"
            />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <SecretInput
              value={form.confirm_password}
              onChange={(v) => set({ confirm_password: v })}
              placeholder="Type it again"
              autoComplete="new-password"
              testid="my-security-confirm-password"
            />
          </div>
          {/* Said before it happens rather than reported after. Somebody changing a
              password on the desk machine has a phone in their pocket signed in to the
              same account, and being dropped from it without warning reads as a fault. */}
          <p className="text-xs text-slate-400">
            Changing your password signs you out everywhere except this browser.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={busy} className="flex-1" data-testid="my-security-password-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="my-security-password-save">
              {busy ? "Saving…" : "Change password"}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
};

// ---------- two-factor ----------

const TwoFactorPanel = ({ state, emailMasked, onChanged }) => {
  const enabled = Boolean(state?.enabled);
  // Absent on an older backend that predates the field. Treated as configured in that
  // case, so the panel behaves as it did rather than hiding the button on every install
  // that has not been redeployed yet.
  const emailConfigured = state?.email_configured !== false;
  // `null` while nothing is being confirmed; otherwise the challenge in flight, which is
  // what decides whether the code box is on screen.
  const [pending, setPending] = useState(null); // { intent, challenge_id, email_masked }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (intent) => {
    try {
      setBusy(true);
      const data = await startMy2fa(intent);
      setPending({ intent, ...data });
      setCode("");
      toast.success(`Code sent to ${data.email_masked}`);
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    try {
      setBusy(true);
      const data = await resendMy2fa(pending.intent, pending.challenge_id);
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
      const data = await verifyMy2fa(pending.intent, pending.challenge_id, code);
      toast.success(data.message);
      setPending(null);
      setCode("");
      onChanged();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  return (
    <Panel
      title="Two-factor authentication"
      icon={enabled ? ShieldCheck : ShieldOff}
      testid="my-security-2fa"
      right={
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}
          data-testid="my-security-2fa-status"
        >
          {enabled ? "On" : "Off"}
        </span>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-700">Email code</p>
            <p className="text-xs text-slate-500" data-testid="my-security-2fa-blurb">{emailMasked}</p>
          </div>
        </div>

        {/* A server with no SMTP credentials cannot send the code this whole panel depends
            on. Said here, with the button switched off, rather than letting somebody press
            it and read the failure in a red toast — the fix belongs to an administrator,
            not to the person looking at the screen, and nothing they do will change it. */}
        {!emailConfigured ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5" data-testid="my-security-2fa-unavailable">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-800">
                {enabled ? "This server can't send your sign-in code" : "Not available on this server yet"}
              </p>
              <p className="text-xs text-amber-700">
                {enabled
                  ? "Two-factor is on for your account, but email sending is switched off on this server — ask your administrator to fix it before you sign out."
                  : "Sending email isn't set up on this server, so the code can't reach you. Ask your administrator to configure it, then come back."}
              </p>
            </div>
          </div>
        ) : !pending ? (
          <div className="space-y-2">
            <Button
              onClick={() => start(enabled ? "disable" : "enable")}
              disabled={busy}
              className={enabled ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"}
              data-testid="my-security-2fa-toggle"
            >
              {busy ? "Sending code…" : enabled ? "Turn off two-factor" : "Turn on two-factor"}
            </Button>
          </div>
        ) : (
          <div className="max-w-xs space-y-3" data-testid="my-security-2fa-verify">
            <div>
              <Label>Code sent to {pending.email_masked}</Label>
              <CodeInput value={code} onChange={setCode} onEnter={verify} testid="my-security-2fa-code" />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => { setPending(null); setCode(""); }}
                disabled={busy}
                className="flex-1"
                data-testid="my-security-2fa-cancel"
              >
                Cancel
              </Button>
              <Button onClick={verify} disabled={busy} className="flex-1 bg-sky-600 hover:bg-sky-700" data-testid="my-security-2fa-verify-btn">
                {busy ? "Checking…" : "Confirm"}
              </Button>
            </div>
            <button
              type="button"
              onClick={resend}
              disabled={busy}
              className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50"
              data-testid="my-security-2fa-resend"
            >
              Didn't get it? Send another code
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
};

// ---------- devices ----------

const SessionsPanel = ({ sessions, lastLoginAt, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const others = sessions?.others || 0;

  const revoke = async () => {
    try {
      setBusy(true);
      const data = await revokeMyOtherSessions();
      toast.success(data.message);
      onChanged();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  };

  return (
    <Panel
      title="Where you're signed in"
      icon={Laptop}
      testid="my-security-sessions"
      right={others > 0 && (
        <Button onClick={revoke} disabled={busy} variant="outline" className="border-rose-200 text-rose-600 hover:bg-rose-50" data-testid="my-security-revoke">
          {busy ? "Signing out…" : `Sign out ${others} other${others === 1 ? "" : "s"}`}
        </Button>
      )}
    >
      {/* A count rather than a list. Nothing on this install records a device name against
          a session — a session is a token, a user and a timestamp — so a list would be six
          identical rows saying "Unknown device", and the action is the same either way. */}
      <div className="space-y-1">
        <p className="text-sm text-slate-700" data-testid="my-security-sessions-count">
          {sessions?.total === 1
            ? "1 active session (this browser)"
            : `${sessions?.total || 0} active sessions (including this browser)`}
        </p>
        {lastLoginAt && (
          <p className="hidden items-center gap-1.5 text-xs text-slate-400 md:flex" data-testid="my-security-last-login">
            <Check className="h-3 w-3" /> Last sign-in {prettyMoment(lastLoginAt)}.
          </p>
        )}
      </div>
    </Panel>
  );
};

// ---------- the tab ----------

/**
 * `onLogout` is for a host whose phone header carries no logout — Super Admin. The button
 * sits at the foot of this tab below md, and is always drawn, even if the settings fail
 * to load, so a phone is never left without a way to sign out.
 */
export const SecurityTab = ({ onLogout } = {}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setData(await mySecurity());
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load your security settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const logoutButton = onLogout && (
    <button
      type="button"
      onClick={onLogout}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-3 text-sm font-semibold text-rose-600 shadow-sm hover:bg-rose-50 md:hidden"
      data-testid="my-security-logout"
    >
      <LogOut className="h-4 w-4" />
      Logout
    </button>
  );

  if (loading) {
    return (
      <div className={SECURITY_FRAME}>
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400" data-testid="my-security-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your security settings…
        </p>
        {logoutButton}
      </div>
    );
  }
  if (error) {
    return (
      <div className={SECURITY_FRAME}>
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" data-testid="my-security-error">
          {error}
        </p>
        {logoutButton}
      </div>
    );
  }

  return (
    <div className={SECURITY_FRAME} data-testid="my-security-tab">
      <PasswordPanel onChanged={load} />
      <TwoFactorPanel state={data.two_factor} emailMasked={data.email_masked} onChanged={load} />
      <SessionsPanel sessions={data.sessions} lastLoginAt={data.last_login_at} onChanged={load} />
      {logoutButton}

    </div>
  );
};

export default SecurityTab;
