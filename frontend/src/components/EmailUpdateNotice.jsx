import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { EmailUpdateForm, EmailVerifiedTag } from "@/components/EmailId";
import { useFeatureAllowed } from "@/lib/featureVisibility";

/**
 * "Update your Email ID" -- shown after sign-in to a login whose email nobody has verified.
 *
 * It never stands in anybody's way: the X closes it and the board is right there. Closed, it
 * stays away until the next sign-in, and it is gone for good once the email is verified.
 *
 * Shown or hidden for everybody from Developer Access > Features (`update_email_notice`),
 * which ships hidden. useFeatureAllowed, so it never flashes up while that is being read.
 *
 * Mounted only behind the sign-in: reading the features without a session is a 401.
 */
const CLOSED_KEY = "email_notice_closed";

// Which sign-in it was closed for, by the tail of its token, so the next one shows it again.
const signInMark = (token) => String(token || "").slice(-8);

const readClosed = () => {
  try { return sessionStorage.getItem(CLOSED_KEY) || ""; } catch { return ""; }
};

export const EmailUpdateNotice = ({ user, token }) => {
  const shown = useFeatureAllowed("update_email_notice");
  const [closedFor, setClosedFor] = useState(readClosed);
  const mark = signInMark(token);

  const close = () => {
    try { sessionStorage.setItem(CLOSED_KEY, mark); } catch { /* it just shows again */ }
    setClosedFor(mark);
  };

  // `in`, not just falsy: a copy of the user kept from before this field existed has not
  // said either way, and /auth/me is about to.
  const notVerified = Boolean(user) && "email_verified_at" in user && !user.email_verified_at;
  if (!shown || !notVerified || !mark || closedFor === mark) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-3 sm:p-4" data-testid="email-notice">
      <div className="w-full max-w-md overflow-hidden rounded-[4px] bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Update your Email ID">
        <div className="flex items-center gap-4 bg-slate-500 px-5 py-3 text-[12px] font-semibold uppercase leading-5 text-white [font-family:Inter,sans-serif]" data-testid="email-notice-header">
          <p className="min-w-0 flex-1 truncate">Update your Email ID</p>
          <button type="button" onClick={close} title="Close" aria-label="Close" className="shrink-0 text-white hover:opacity-80" data-testid="email-notice-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="rounded-[4px] border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Current Email ID</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <p className="min-w-0 break-all text-sm text-slate-700" data-testid="email-notice-current">{user.email}</p>
              <EmailVerifiedTag verified={false} testid="email-notice-tag" />
            </div>
          </div>
          <EmailUpdateForm currentEmail={user.email} onDone={close} testid="email-notice" />
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default EmailUpdateNotice;
