// Past Data's words and colours — the pre-OS Excel register, read-only (see
// backend/routers/v3_past_data.py). One file for the board and the client popup so a flag
// or a status reads the same in the list as it does on the person.

import { PAYMENT_MODE_LABELS } from "@/lib/paymentModes";

export const rs = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// Lakh and crore for the tiles, where "Rs.1,34,38,570" does not fit two to a phone row.
// The exact figure is one tap away, in the list and on the person.
export const rsShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return `Rs.${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `Rs.${(v / 1e5).toFixed(1)} L`;
  return rs(v);
};

// The flags the import can leave on a record, worded for the row they sit on. Mirrors the
// codes in FINDINGS in backend/past_data.py (plus family_phone, which is a note rather than
// a finding) — a code added there needs its words here, or it shows as the bare code.
export const FLAG_LABELS = {
  check_phone: "Phone needs checking",
  family_phone: "Family number (-1)",
  shared_phone: "Phone shared with another client",
  name_differs: "Name differs from Patient Master",
  no_service: "No service type",
  client_mismatch: "Row names a different patient",
  check_mode: "Payment mode missing",
  unknown_state: "No status or amount",
  no_date: "No date on the row",
};

export const flagLabel = (code) => FLAG_LABELS[code] || code;

// The two kinds of sheet the import reads (backend past_data.py / past_revenue.py).
export const LAYOUT_LABELS = {
  register: "Register",
  revenue: "Revenue sheet",
};

export const layoutLabel = (layout) => LAYOUT_LABELS[layout] || LAYOUT_LABELS.register;

// The register's own course statuses. Read as what the sheet said on the day it was saved:
// it left consultation-only patients "Active", so Active here is not "in treatment now".
const STATUS_TONES = {
  Active: "border-sky-200 bg-sky-50 text-sky-700",
  Completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  Dropped: "border-rose-200 bg-rose-50 text-rose-700",
  "Referred Out": "border-amber-200 bg-amber-50 text-amber-700",
  "On Hold": "border-slate-200 bg-slate-100 text-slate-600",
};

export const statusTone = (status) => STATUS_TONES[status] || "border-slate-200 bg-slate-50 text-slate-600";

export const PAYMENT_STATES = {
  paid: { label: "Paid", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  unpaid: { label: "Unpaid", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  cancelled: { label: "Cancelled", tone: "border-slate-200 bg-slate-100 text-slate-500" },
  unknown: { label: "No status", tone: "border-slate-200 bg-slate-50 text-slate-500" },
};

export const paymentState = (state) => PAYMENT_STATES[state] || PAYMENT_STATES.unknown;

export const modeLabel = (mode, asWritten) => (mode ? PAYMENT_MODE_LABELS[mode] || mode : asWritten || "");
