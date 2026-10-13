import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { displayPhone } from "@/lib/phone";

export const MaskedContact = ({ phone: rawPhone = "", email = "", locked = false }) => {
  const phone = displayPhone(rawPhone);
  const [reveal, setReveal] = useState(false);
  const show = reveal && !locked;
  const maskedPhone = phone ? `xxxxxxxx${phone.slice(-2)}` : "";
  const maskedEmail = email ? `${email.charAt(0)}xxxx@xxxx` : "";
  return (
    <button
      type="button"
      onClick={() => !locked && setReveal((v) => !v)}
      onMouseEnter={() => !locked && setReveal(true)}
      onMouseLeave={() => !locked && setReveal(false)}
      className="flex items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-50"
      data-testid="masked-contact"
    >
      {phone && <span className="font-mono text-slate-700">{show ? phone : maskedPhone}</span>}
      {phone && email && <span className="text-slate-400">·</span>}
      {email && <span className="text-slate-600">{show ? email : maskedEmail}</span>}
      {locked ? null : show ? <EyeOff className="h-3 w-3 text-slate-400" /> : <Eye className="h-3 w-3 text-slate-400" />}
    </button>
  );
};

export default MaskedContact;
