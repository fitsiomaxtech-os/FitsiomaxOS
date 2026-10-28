import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { forgotPassword, verifyResetOtp, resetPassword } from "@/lib/api";

const Field = ({ label, children }) => (
  <div className="space-y-1">
    <label className="text-sm font-medium text-slate-700">{label}</label>
    {children}
  </div>
);

const INITIAL_STATE = {
  step: "identifier", // identifier -> otp | sent -> newpassword -> success
  identifier: "",
  requestId: null,
  otp: "",
  resetToken: null,
  newPassword: "",
  confirmPassword: "",
  sentMessage: "",
};

// The line under the title, per step. The first step has none: the field's own label says
// what to type.
const DESCRIPTIONS = {
  otp: "Enter the OTP sent to verify it's you.",
  sent: "Check your inbox for next steps.",
  newpassword: "Choose a new password for your account.",
  success: "You're all set.",
};

export const ForgotPasswordModal = ({ open, onOpenChange }) => {
  const [state, setState] = useState(INITIAL_STATE);
  const [loading, setLoading] = useState(false);
  const set = (patch) => setState((prev) => ({ ...prev, ...patch }));

  const handleOpenChange = (next) => {
    if (!next) setState(INITIAL_STATE);
    onOpenChange(next);
  };

  const submitIdentifier = async (event) => {
    event.preventDefault();
    if (!state.identifier.trim()) {
      toast.error("Enter your email or mobile number");
      return;
    }
    setLoading(true);
    try {
      const data = await forgotPassword(state.identifier.trim());
      if (data.request_id) {
        set({ step: "otp", requestId: data.request_id, sentMessage: data.message });
        toast.success(data.message);
      } else {
        set({ step: "sent", sentMessage: data.message });
      }
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to send recovery instructions");
    } finally {
      setLoading(false);
    }
  };

  const submitOtp = async (event) => {
    event.preventDefault();
    if (!state.otp.trim()) {
      toast.error("Enter the OTP");
      return;
    }
    setLoading(true);
    try {
      const data = await verifyResetOtp({ request_id: state.requestId, otp: state.otp.trim() });
      set({ step: "newpassword", resetToken: data.reset_token });
      toast.success("OTP verified");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "OTP verification failed");
    } finally {
      setLoading(false);
    }
  };

  const submitNewPassword = async (event) => {
    event.preventDefault();
    if (state.newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (state.newPassword !== state.confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await resetPassword({
        token: state.resetToken,
        new_password: state.newPassword,
        confirm_password: state.confirmPassword,
      });
      set({ step: "success" });
      toast.success("Password reset successful");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  const description = DESCRIPTIONS[state.step];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* With no description, aria-describedby={undefined} tells Radix there is none to
          link rather than letting it warn about a missing one. */}
      <DialogContent
        className="max-w-md sm:rounded-[4px]"
        data-testid="forgot-password-modal"
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>Reset your password</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {state.step === "identifier" && (
          <form className="space-y-4" onSubmit={submitIdentifier} data-testid="forgot-password-identifier-form">
            <Field label="Email or Mobile Number">
              <Input
                value={state.identifier}
                onChange={(e) => set({ identifier: e.target.value })}
                data-testid="forgot-password-identifier-input"
                autoFocus
              />
            </Field>
            <Button type="submit" disabled={loading} className="w-full bg-sky-500 text-white hover:bg-sky-600" data-testid="forgot-password-send-btn">
              {loading ? "Sending..." : "Send Recovery Instructions"}
            </Button>
          </form>
        )}

        {state.step === "otp" && (
          <form className="space-y-4" onSubmit={submitOtp} data-testid="forgot-password-otp-form">
            <p className="text-sm text-slate-600" data-testid="forgot-password-otp-message">{state.sentMessage}</p>
            <Field label="OTP">
              <Input
                value={state.otp}
                onChange={(e) => set({ otp: e.target.value })}
                placeholder="6-digit code"
                data-testid="forgot-password-otp-input"
                autoFocus
              />
            </Field>
            <p className="text-xs text-slate-400">This code expires in 5 minutes.</p>
            <Button type="submit" disabled={loading} className="w-full bg-sky-500 text-white hover:bg-sky-600" data-testid="forgot-password-verify-otp-btn">
              {loading ? "Verifying..." : "Verify OTP"}
            </Button>
            <button
              type="button"
              onClick={() => set({ step: "identifier", otp: "" })}
              className="w-full text-center text-xs font-medium text-slate-500 hover:text-slate-700"
              data-testid="forgot-password-back-btn"
            >
              ← Use a different email or number
            </button>
          </form>
        )}

        {state.step === "sent" && (
          <div className="space-y-4" data-testid="forgot-password-sent-panel">
            <p className="text-sm text-slate-600">{state.sentMessage}</p>
            <p className="text-xs text-slate-400">The reset link expires in 15 minutes.</p>
            <Button onClick={() => handleOpenChange(false)} className="w-full" variant="outline" data-testid="forgot-password-sent-close-btn">
              Close
            </Button>
          </div>
        )}

        {state.step === "newpassword" && (
          <form className="space-y-4" onSubmit={submitNewPassword} data-testid="forgot-password-newpassword-form">
            <Field label="New Password">
              <Input
                type="password"
                value={state.newPassword}
                onChange={(e) => set({ newPassword: e.target.value })}
                placeholder="Min 6 characters"
                data-testid="forgot-password-new-password-input"
                autoFocus
              />
            </Field>
            <Field label="Confirm Password">
              <Input
                type="password"
                value={state.confirmPassword}
                onChange={(e) => set({ confirmPassword: e.target.value })}
                placeholder="Re-enter new password"
                data-testid="forgot-password-confirm-password-input"
              />
            </Field>
            <Button type="submit" disabled={loading} className="w-full bg-sky-500 text-white hover:bg-sky-600" data-testid="forgot-password-reset-btn">
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
          </form>
        )}

        {state.step === "success" && (
          <div className="space-y-4" data-testid="forgot-password-success-panel">
            <p className="text-sm text-slate-600">Your password has been reset. Please log in with your new password.</p>
            <Button onClick={() => handleOpenChange(false)} className="w-full bg-sky-500 text-white hover:bg-sky-600" data-testid="forgot-password-success-close-btn">
              Back to Login
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ForgotPasswordModal;
