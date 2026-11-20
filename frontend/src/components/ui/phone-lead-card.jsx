import { ChevronRight } from "lucide-react";

/**
 * Branch Leads' phone card, drawn exactly as Pre Sales' PhoneLeadCard (PreSalesCRM.jsx),
 * which the user pointed at on 2026-11-20: initials in a grey rounded square, the name
 * with its number and source under it, the stage in an orange box, and a chevron. A
 * separate white card per lead with a gap between, not LeadRowCard's inbox rows.
 *
 * No Call or WhatsApp on the card: they are in the lead's popup.
 *
 * `subLine` is joined with " · " (the phone, then the source). `details` is the stage's
 * own lines (appointment, follow-up, reminder) under that.
 *
 * Test ids: `${testid}-${id}` and `${testid}-stage-${id}`.
 */
export const PHONE_LEAD_LIST = "space-y-2.5 pt-1";

/** Up to two initials: "Kumara Vel S" reads "KV". Pre Sales' own rule. */
export const leadInitials = (name) => (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/** A stored key as words: "google_sheets" reads as "Google Sheets". */
export const sourceWords = (v) => (v ? String(v).replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()) : "");

export const PhoneLeadCard = ({ id, name, nameAddon = null, subLine = [], stage = null, details = null, onOpen, testid }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); } }}
    className="relative flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-md transition active:scale-[0.99]"
    data-testid={`${testid}-${id}`}
  >
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">
      {leadInitials(name)}
    </span>
    <div className="min-w-0 flex-1">
      <p className="flex min-w-0 items-center text-sm font-semibold text-slate-900">
        <span className="truncate">{name || "—"}</span>
        {nameAddon}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-slate-500">
        {subLine.filter(Boolean).join(" · ") || "—"}
      </p>
      {details && <div className="mt-1 space-y-0.5">{details}</div>}
    </div>
    <span
      className="inline-flex h-7 w-[5.5rem] shrink-0 items-center justify-center rounded-md border border-orange-200 bg-orange-100/35 px-1.5 text-[11px] font-medium text-orange-700"
      title={stage || undefined}
      data-testid={`${testid}-stage-${id}`}
    >
      <span className="truncate">{stage || "—"}</span>
    </span>
    <ChevronRight aria-hidden className="h-[1.2rem] w-[1.2rem] shrink-0 text-slate-500 opacity-[0.85]" />
  </div>
);
