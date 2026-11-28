/**
 * The six-digit box a verification code is typed into.
 *
 * Shared because two screens ask for the same code and it has to be the same field: the
 * Security tab, where somebody switches two-factor on, and the sign-in screen they meet
 * the next morning because they did. A box that looked one way during setup and another
 * at the gate would be the second thing to doubt at a moment already spent wondering
 * whether the mail arrived.
 *
 * Non-digits are stripped as they arrive rather than refused on submit — a code pasted out
 * of an email usually brings a space with it, and rejecting that reads as a puzzle rather
 * than as validation. `autoComplete="one-time-code"` is what lets a phone offer the code
 * from the notification instead of making somebody switch apps to read it.
 */
import { Input } from "@/components/ui/input";

export const CODE_LENGTH = 6;

export const CodeInput = ({ value, onChange, testid = "code-input", onEnter, autoFocus = false, className = "" }) => (
  <Input
    value={value}
    onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
    // Enter submits wherever this sits outside a form — the Security tab confirms with a
    // button, and typing six digits then reaching for the mouse is the wrong ending.
    onKeyDown={(e) => { if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); } }}
    placeholder="••••••"
    inputMode="numeric"
    autoComplete="one-time-code"
    maxLength={CODE_LENGTH}
    autoFocus={autoFocus}
    aria-label="Verification code"
    className={`border-slate-200 bg-white text-center text-lg font-semibold tracking-[0.5em] ${className}`}
    data-testid={testid}
  />
);

export default CodeInput;
