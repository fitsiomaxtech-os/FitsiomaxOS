import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, Mail } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiLogin, apiResendLogin2fa, apiVerifyLogin2fa } from "@/lib/api";
import { toast } from "@/components/ui/sonner";
import { ForgotPasswordModal } from "@/components/ForgotPasswordModal";
import { LegalLinks } from "@/components/LegalLinks";
import { versionDetail, versionLabel } from "@/lib/version";
// The same six-digit box the Security tab uses to switch two-factor on, so the field
// somebody meets at sign-in is the one they already used to set it up.
import { CODE_LENGTH, CodeInput } from "@/components/ui/code-input";

const BG_IMAGE =
  "https://images.pexels.com/photos/62693/pexels-photo-62693.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";

const LOGO_URL =
  "https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707/artifacts/nozl77ti_Logo%20Icon.webp";

// How long five wrong passwords lock a login for. The server owns the rule (LOCK_MINUTES in
// backend/login_guard.py); this is only the figure the warning quotes.
const LOCK_MINUTES = 10;

// The 429 says "try again in N minutes"; N is what is left of the lock.
const minutesLeftOf = (detail) => {
  const match = /(\d+)\s*minute/.exec(detail || "");
  return match ? Number(match[1]) : LOCK_MINUTES;
};

export const LoginPage = ({ onLogin }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  // What the last Continue was refused for, shown in red under the password rather than in
  // a toast that is gone before it is read: { kind: "invalid" } for a wrong email or
  // password (401), { kind: "invalid", missing: ["@", "."] } for an email without an "@" or
  // a "." (caught here, never sent, so it costs none of the five tries), and
  // { kind: "locked", minutesLeft } once the fifth wrong one locks the login (429). Null
  // until a refusal, and cleared by the next Continue.
  const [loginError, setLoginError] = useState(null);
  // The second step, and null whenever there isn't one. An account with two-factor on gets
  // no token from /auth/login — it gets a challenge, and this holds it until the emailed
  // code comes back. The password is dropped from state the moment the challenge exists;
  // it has done its job and the second call doesn't take it.
  const [challenge, setChallenge] = useState(null); // { challenge_id, email_masked }
  const [code, setCode] = useState("");
  const location = useLocation();
  const navigate = useNavigate();

  const finish = (data) => {
    onLogin(data);
    toast.success("Login successful");
    navigate(location.state?.from || "/app", { replace: true });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const missing = ["@", "."].filter((mark) => !email.trim().includes(mark));
    if (missing.length) {
      setLoginError({ kind: "invalid", missing });
      return;
    }
    setLoading(true);
    setLoginError(null);
    try {
      const data = await apiLogin(email, password);
      if (data?.two_factor_required) {
        setChallenge(data);
        setPassword("");
        setCode("");
        toast.success(`Code sent to ${data.email_masked}`);
        return;
      }
      finish(data);
    } catch (error) {
      const status = error?.response?.status;
      const detail = error?.response?.data?.detail;
      if (status === 401) setLoginError({ kind: "invalid" });
      else if (status === 429) setLoginError({ kind: "locked", minutesLeft: minutesLeftOf(detail) });
      else toast.error(detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (event) => {
    event?.preventDefault?.();
    if (code.length !== CODE_LENGTH) {
      toast.error(`Enter the ${CODE_LENGTH}-digit code`);
      return;
    }
    setLoading(true);
    try {
      finish(await apiVerifyLogin2fa(challenge.challenge_id, code));
    } catch (error) {
      toast.error(error?.response?.data?.detail || "That code did not work");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setLoading(true);
    try {
      const data = await apiResendLogin2fa(challenge.challenge_id);
      setChallenge((c) => ({ ...c, ...data }));
      setCode("");
      toast.success(`New code sent to ${data.email_masked}`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Could not send another code");
    } finally {
      setLoading(false);
    }
  };

  // Back to the password. The challenge is abandoned rather than kept aside — it expires
  // in five minutes either way, and a stale one behind a second password attempt is a
  // code box that rejects the code that just arrived.
  const handleStartOver = () => {
    setChallenge(null);
    setCode("");
    setPassword("");
  };

  const handleForgotPassword = () => {
    setForgotOpen(true);
  };

  return (
    // 100dvh where the browser has it: on a phone 100vh is the height with the address bar
    // hidden, so a page that tall puts its bottom edge — and the footer pinned to it —
    // under the bar until the reader scrolls. Older browsers keep min-h-screen.
    <div
      className="relative min-h-screen overflow-hidden bg-white supports-[height:100dvh]:min-h-[100dvh]"
      data-testid="screen1-login-page"
    >
      <img
        src={BG_IMAGE}
        alt="Minimal background"
        className="absolute inset-0 h-full w-full object-cover object-center"
        data-testid="screen1-login-background-image"
      />
      <div className="absolute inset-0 bg-white/90 backdrop-blur-[2px]" data-testid="screen1-login-overlay" />

      {/* On phones the card is drawn at 90%. transform: scale rather than zoom — the card is
          w-full, and zoom leaves a percentage width alone, so only its contents would shrink.
          The card sits centred in a full-height flex box, so scaling about its centre keeps it there. */}
      {/* pb-12 on phones keeps the card clear of the one-line footer under it. */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 pb-12 pt-8 supports-[height:100dvh]:min-h-[100dvh] md:px-8 md:py-10">
        <Card
          className="w-full max-w-md rounded-[4px] border border-slate-200 bg-white shadow-[0_8px_30px_rgb(2,6,23,0.06)] max-md:scale-90"
          data-testid="screen1-login-card"
        >
          <CardHeader className="space-y-1 pb-2 text-center">
            <img
              src={LOGO_URL}
              alt="Fitsiomax"
              className="mx-auto h-16 w-16 rounded-lg object-contain"
              data-testid="screen1-login-logo"
            />
            <h1 className="font-heading text-3xl font-bold text-slate-900" data-testid="screen1-login-title">
              FITSIOMAX OS
            </h1>
            <p
              className="text-xs font-medium uppercase tracking-[0.14em] text-sky-600"
              data-testid="screen1-login-brand-subtitle"
            >
              Powered by Fitsiomax Clinic
            </p>
          </CardHeader>

          <CardContent>
            {challenge ? (
              <form className="space-y-4" onSubmit={handleVerify} data-testid="screen1-login-2fa-form">
                <div className="flex items-start gap-3 rounded-[4px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-700">Check your email</p>
                    <p className="text-xs text-slate-500" data-testid="screen1-login-2fa-sent-to">
                      We sent a {CODE_LENGTH}-digit code to {challenge.email_masked}. It expires in 5 minutes.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700" data-testid="screen1-login-2fa-label">
                    Verification code
                  </label>
                  <CodeInput value={code} onChange={setCode} testid="screen1-login-2fa-input" autoFocus />
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-[4px] bg-sky-500 text-white hover:bg-sky-600"
                  data-testid="screen1-login-2fa-submit"
                >
                  {loading ? "Verifying..." : "Verify & sign in"}
                </Button>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleStartOver}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700"
                    data-testid="screen1-login-2fa-back"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={loading}
                    className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50"
                    data-testid="screen1-login-2fa-resend"
                  >
                    Send another code
                  </button>
                </div>
              </form>
            ) : (
              <form className="space-y-4" onSubmit={handleSubmit} data-testid="screen1-login-form">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700" data-testid="screen1-login-email-label">
                    Email
                  </label>
                  <Input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="user@fitsiomax.com"
                    className="rounded-[4px] border-slate-200 bg-white"
                    data-testid="screen1-login-email-input"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700" data-testid="screen1-login-password-label">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={handleForgotPassword}
                      className="text-xs font-medium text-sky-600 hover:text-sky-700"
                      data-testid="screen1-login-forgot-password"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="••••••••"
                      className="rounded-[4px] border-slate-200 bg-white pr-10"
                      data-testid="screen1-login-password-input"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      data-testid="screen1-login-password-toggle"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Lexend, scoped to these messages; index.css already loads it. The message
                    never says which of the two was wrong, so it gives away no account. */}
                {loginError?.kind === "invalid" && (
                  <p
                    role="alert"
                    className="text-sm font-medium text-red-600"
                    style={{ fontFamily: "Lexend, sans-serif" }}
                    data-testid="screen1-login-error-invalid"
                  >
                    Invalid email or password
                    {loginError.missing && ` ${loginError.missing.map((mark) => `'${mark}'`).join(" ")}`}
                  </p>
                )}
                {loginError?.kind === "locked" && (
                  // One row of text, no icon. The minutes are what is left of the lock: 10 on
                  // the try that set it, fewer on a try made while it still holds. flex-wrap
                  // only lets a narrow phone drop the second half under the first.
                  <div
                    role="alert"
                    className="flex flex-wrap items-baseline gap-x-2 rounded-[4px] border border-red-200 bg-red-50 px-3 py-2"
                    style={{ fontFamily: "Lexend, sans-serif" }}
                    data-testid="screen1-login-error-locked"
                  >
                    <span className="text-sm font-semibold text-red-700">Access Warning</span>
                    <span className="text-sm text-red-600">
                      Access restricted for {loginError.minutesLeft} minute{loginError.minutesLeft === 1 ? "" : "s"}.
                    </span>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-[4px] bg-sky-500 text-white hover:bg-sky-600"
                  data-testid="screen1-login-submit-button"
                >
                  {loading ? "Signing in..." : "Continue"}
                </Button>
              </form>
            )}

            <p className="mt-5 text-center text-xs text-slate-400" data-testid="screen1-login-footer-note">
              {challenge
                ? "Didn't get the code? Check your spam folder, or ask your admin."
                : "Only invited users can login. Contact your admin for access."}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Version in the bottom-left corner, legal links in the bottom-right — on phones
          too, one line across the bottom. */}
      <div className="absolute inset-x-0 bottom-5 z-10 flex items-center justify-between gap-3 px-5 md:bottom-6 md:px-8">
        {/* 8.4px is 70% of text-xs, asked for so the corners stay quiet beside the card. */}
        <span title={versionDetail} className="text-[8.4px] text-slate-400" data-testid="app-version">
          {versionLabel}
        </span>
        <LegalLinks textClass="gap-2 text-[8.4px]" />
      </div>

      <ForgotPasswordModal open={forgotOpen} onOpenChange={setForgotOpen} />
    </div>
  );
};
