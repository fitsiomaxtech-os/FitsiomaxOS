import { Phone } from "lucide-react";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";

/**
 * The phone card Branch Admin's patient lists share — Branch Leads, Consultation, House
 * Visit and Review — drawn as the reference the user sent: one row, the avatar, then two
 * lines beside it, the name across from a badge and the patient's numbers across from
 * Call and WhatsApp. Anything a list adds (an appointment, a follow-up, a review's
 * Consultant) goes in `details`, under the name.
 *
 * Two flex rows rather than one grid: a grid column is as wide as its widest cell, so the
 * badge's would take the buttons' width and cut a 412px phone's name off at "Amreen
 * Offline Fi…".
 *
 * `idLine` is the patient number, phone and the like: one dotted line from sm up, as the
 * reference has them. Below sm the Call and WhatsApp pair leaves about 100px beside it, so
 * the parts stack one to a line instead of wrapping mid-line and stranding a dot on a line
 * of its own.
 *
 * `wa` is the number from lib/phone's waNumber; without one the buttons are left off, as
 * there is nobody to ring. They are anchors rather than buttons so tel: and the WhatsApp
 * handoff are the browser's own, and stop propagation so tapping one doesn't also open
 * the card behind it.
 *
 * `badgeColor` is a hex, set inline for the reason StatTile gives: a `bg-${tone}-100`
 * built at runtime compiles to nothing. Left unset the badge is plain grey.
 *
 * `mark` replaces the initial in the avatar circle — a select-mode checkbox, say.
 * `className` carries the card's border and fill, so a picked card can be tinted.
 *
 * Test ids are `${testid}-${id}`, `${testid}-call-${id}` and `${testid}-whatsapp-${id}`,
 * which is what each list's cards were already called before they shared this.
 */
export const LeadRowCard = ({
  id,
  name,
  nameAddon = null,
  mark = null,
  badge = null,
  badgeColor = null,
  idLine = [],
  wa = null,
  details = null,
  onOpen,
  className = "border-slate-200 bg-white",
  testid,
}) => {
  const parts = idLine.filter(Boolean);
  return (
    // A div, not a button: Call and WhatsApp are themselves interactive, and a button
    // inside a button is invalid markup that browsers resolve by dropping one of them.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); }
      }}
      className={`w-full cursor-pointer rounded-xl border p-3 text-left shadow-sm transition active:bg-slate-50 sm:p-4 ${className}`}
      data-testid={`${testid}-${id}`}
    >
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-bold text-violet-700 sm:h-12 sm:w-12 sm:text-base">
          {mark || name?.charAt(0)?.toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 sm:space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[15px] font-semibold leading-tight text-slate-900 sm:text-base">
              {name || "—"}{nameAddon}
            </p>
            {badge && (
              <span
                className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium sm:px-2.5 sm:text-xs"
                style={badgeColor
                  ? { background: `${badgeColor}14`, color: badgeColor, border: `1px solid ${badgeColor}33` }
                  : { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" }}
              >
                {badge}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 flex-col text-[11px] font-medium leading-snug text-slate-400 sm:flex-row sm:flex-wrap sm:gap-x-1.5 sm:text-xs">
              {parts.flatMap((part, i) => [
                i > 0 && <span key={`dot-${i}`} className="hidden sm:inline" aria-hidden="true">•</span>,
                <span key={i} className="truncate">{part}</span>,
              ])}
            </p>
            {wa && (
              <div className="flex shrink-0 gap-1 sm:gap-2">
                <a
                  href={`tel:${wa}`}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="flex h-8 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 active:bg-slate-100 sm:h-10 sm:gap-1.5 sm:px-4 sm:text-sm"
                  data-testid={`${testid}-call-${id}`}
                >
                  <Phone className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> Call
                </a>
                <a
                  href={`https://wa.me/${wa}`}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="flex h-8 items-center justify-center gap-1 rounded-lg border border-[#25D366]/40 bg-[#25D366]/10 px-2 text-xs font-semibold text-[#128C7E] active:bg-[#25D366]/20 sm:h-10 sm:gap-1.5 sm:px-4 sm:text-sm"
                  data-testid={`${testid}-whatsapp-${id}`}
                >
                  <WhatsAppIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> WhatsApp
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Lined up under the name: the avatar's 40px (48 from sm) and the gap after it. */}
      {details && (
        <div className="mt-1.5 min-w-0 space-y-0.5 pl-[52px] sm:mt-2.5 sm:pl-16">
          {details}
        </div>
      )}
    </div>
  );
};
