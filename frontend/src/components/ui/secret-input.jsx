/**
 * A password box with the eye, because a password typed blind into a form that also asks
 * for it twice is the form people give up on.
 *
 * Shared by the Security tab and the Email ID form, which asks for the current password
 * before it moves a login to another address.
 */
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";

export const SecretInput = ({ value, onChange, placeholder, testid, autoComplete, className = "" }) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`border-slate-200 bg-white pr-10 ${className}`}
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

export default SecretInput;
