import { Phone } from "lucide-react";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";

/**
 * The phone card Branch Admin's patient lists share — Branch Leads, Consultation, House
 * Visit and Review — drawn as a compact list row about 48px tall: a 6px corner, a 1px
 * border and a light shadow, a small avatar on the left, the name over "ID | phone"
 * beside it, and the badge, Call and WhatsApp in a row on the right. Anything a list adds
 * (an appointment, a follow-up, a review's Consultant) goes in `details`, under the name,
 * and is the only thing that makes a card taller than the row.
 *
 * Below sm, Call and WhatsApp are icon-only squares. With their labels the pair is about
 * 150px wide, and that would leave a 360px phone under 100px for the name. From sm up
 * (the user's own phone is about 720px wide) they carry their labels, as the reference
 * shows. The badge is capped and truncates, so a long stage name can't take the name's
 * room either.
 *
 * `idLine` is the patient number, phone and the like, on one line split by "|" as the
 * reference has them; it truncates at the end, so on a narrow phone the last part is the
 * one cut short.
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
      className={`w-full cursor-pointer rounded-md border px-2.5 py-1.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition active:bg-slate-50 ${className}`}
      data-testid={`${testid}-${id}`}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
          {mark || name?.charAt(0)?.toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center text-[13px] font-semibold leading-[18px] text-slate-900 sm:text-sm">
            <span className="truncate">{name || "—"}</span>{nameAddon}
          </p>
          <p className="mt-0.5 truncate text-[11px] font-medium leading-[14px] text-slate-400">
            {parts.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1 text-slate-300" aria-hidden="true">|</span>}
                {part}
              </span>
            ))}
          </p>
        </div>
        {badge && (
          <span
            className="max-w-[76px] shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 sm:max-w-[140px] sm:text-[11px]"
            style={badgeColor
              ? { background: `${badgeColor}1a`, color: badgeColor }
              : { background: "#f1f5f9", color: "#475569" }}
            title={typeof badge === "string" ? badge : undefined}
          >
            {badge}
          </span>
        )}
        {wa && (
          <div className="flex shrink-0 gap-1 sm:gap-1.5">
            <a
              href={`tel:${wa}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="Call"
              className="flex h-8 w-8 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white text-xs font-semibold text-slate-700 active:bg-slate-100 sm:w-auto sm:px-2.5"
              data-testid={`${testid}-call-${id}`}
            >
              <Phone className="h-3.5 w-3.5" /><span className="hidden sm:inline">Call</span>
            </a>
            <a
              href={`https://wa.me/${wa}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="WhatsApp"
              className="flex h-8 w-8 items-center justify-center gap-1.5 rounded-md border border-[#25D366]/40 bg-[#25D366]/10 text-xs font-semibold text-[#128C7E] active:bg-[#25D366]/20 sm:w-auto sm:px-2.5"
              data-testid={`${testid}-whatsapp-${id}`}
            >
              <WhatsAppIcon className="h-3.5 w-3.5" /><span className="hidden sm:inline">WhatsApp</span>
            </a>
          </div>
        )}
      </div>
      {/* Lined up under the name: the avatar's 32px and the 8px gap after it. */}
      {details && (
        <div className="mt-1 min-w-0 space-y-0.5 pl-10">
          {details}
        </div>
      )}
    </div>
  );
};
