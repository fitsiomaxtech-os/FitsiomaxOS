// The 10-digit mobile-number box: digits only, never more than 10, checked as it is typed,
// with the same line under it the Email ID box prints (components/EmailId.jsx).
import { CheckCircle2, Phone, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { phoneCheck, phoneDigits } from "@/lib/phone";

/** Any other prop goes to the input. */
export const PhoneInput = ({ value, onChange, className = "", testid = "phone", placeholder = "10-digit mobile number", ...rest }) => {
  const state = phoneCheck(value);
  const line = "mt-1 flex min-w-0 items-start gap-1 text-[11px] leading-4";
  const icon = "mt-0.5 h-3 w-3 shrink-0";
  return (
    <div>
      <div className="relative">
        <Input
          value={value ?? ""}
          onChange={(e) => onChange(phoneDigits(e.target.value))}
          placeholder={placeholder}
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          // Not maxLength: a pasted "+91 88255 87322" is longer than 10 and would be cut
          // before phoneDigits could take the 91 off. phoneDigits holds it to 10 instead.
          aria-invalid={state.status === "invalid"}
          className={`pr-10 ${className}`}
          data-testid={testid}
          {...rest}
        />
        <span className="pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-center" data-testid={`${testid}-icon`}>
          {state.status === "valid" && <Phone className="h-4 w-4 text-emerald-600" />}
          {state.status === "invalid" && <XCircle className="h-4 w-4 text-rose-500" />}
        </span>
      </div>
      {state.status === "valid" && (
        <p className={`${line} font-semibold text-emerald-600`} data-testid={`${testid}-status`}>
          <CheckCircle2 className={icon} /> Valid · Mobile
        </p>
      )}
      {state.status === "partial" && (
        <p className={`${line} text-amber-600`} data-testid={`${testid}-status`}>{state.reason}</p>
      )}
      {state.status === "invalid" && (
        <p className={`${line} text-rose-600`} data-testid={`${testid}-status`}>
          <XCircle className={icon} />
          <span className="min-w-0 break-words"><b>Not Allowed</b> · {state.reason}</span>
        </p>
      )}
    </div>
  );
};
