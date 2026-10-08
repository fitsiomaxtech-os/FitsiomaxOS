import { ChevronRight, Phone, Trash2 } from "lucide-react";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";

/**
 * The phone card Branch Admin's patient lists share — Branch Leads, Consultation, House
 * Visit and Review — drawn as a compact list row about 48px tall: a small avatar on the
 * left, the name over the patient ID beside it, and the badge, Call and WhatsApp in a row
 * on the right. Anything a list adds
 * (an appointment, a follow-up, a review's Consultant) goes in `details`, under the name,
 * and is the only thing that makes a card taller than the row.
 *
 * The row has no border, corner, shadow or gap of its own: the list draws one white box
 * round all of them and a thin line between each (`LEAD_ROW_LIST`), the way a mail inbox
 * stacks its rows. The user asked for that over separate cards with space between.
 *
 * Below sm the box runs the full width of the screen, as the user asked: it steps out
 * over the page's 12px side padding (CRMPage's px-3, the only side padding between the
 * screen and any of these lists) and loses its side borders and corners. The row's own
 * 12px keeps the avatar off the screen edge and in line with the toolbar above.
 *
 * Below sm, Call and WhatsApp are bare icons — a sky phone, a green WhatsApp mark — with no
 * box, border or fill, each on the same 32px tap area the boxes had. With a box round each, every row
 * carried four (the badge and three buttons) and the column of green and rose squares was
 * the first thing the eye found, not the names; the user asked for the lighter look. With
 * their labels the pair is about 150px wide, and that would leave a 360px phone (the
 * user's own, below sm) under 100px for the name. From sm up they are the bordered,
 * labelled buttons the reference shows. The badge is capped and truncates, so a long stage
 * name can't take the name's room either.
 *
 * The avatar is sky below sm, the header's brand blue, rather than violet; the name is a
 * step bigger and the ID line a step darker there, so the text outweighs the icons.
 *
 * `idLine` is the patient number, city and the like, on one line split by "|" as the
 * reference has them; it truncates at the end, so on a narrow phone the last part is the
 * one cut short. The lists leave the phone number out of it wherever Call and WhatsApp
 * are drawn (the user asked for that); only `glance` and an unringable number show it.
 *
 * `wa` is the number from lib/phone's waNumber; without one Call and WhatsApp are left off, as
 * there is nobody to ring. They are anchors rather than buttons so tel: and the WhatsApp
 * handoff are the browser's own, and stop propagation so tapping one doesn't also open
 * the card behind it.
 *
 * `badgeColor` is a hex, set inline for the reason StatTile gives: a `bg-${tone}-100`
 * built at runtime compiles to nothing. Left unset the badge is plain grey.
 *
 * `onDelete`, when given, adds a bin button after WhatsApp — the desk table's Action
 * cell, on the phone. Icon-only at every width, as it is on the desk. Below sm it is a
 * plain grey bin that turns rose only while pressed, so the rarest action isn't the
 * loudest thing on every row; from sm up it is boxed in rose so it is not mistaken for
 * one of the two ways of reaching the patient. The list decides who gets it and what
 * confirming it asks; the card only draws it.
 *
 * `glance` is the lighter card Branch Leads draws on All Stages, where the list is the
 * whole branch to be looked over rather than one stage to be worked: no Call or
 * WhatsApp, the stage boxed with a 4px corner and a border (the worked lists' badge has
 * a 5px corner and none), the bin a plain grey
 * icon, and a grey arrow at the end that says the card opens. The arrow is part of the
 * card, not a button of its own, so tapping it is tapping the card.
 *
 * `mark` replaces the initial in the avatar circle — a select-mode checkbox, say.
 * `className` carries the row's fill, so a picked row can be tinted.
 *
 * Test ids are `${testid}-${id}`, `${testid}-call-${id}`, `${testid}-whatsapp-${id}` and
 * `${testid}-delete-${id}`, which is what each list's cards were already called before
 * they shared this.
 */
/** The box a list of LeadRowCards sits in: one border round them all, a line between each. */
export const LEAD_ROW_LIST = "-mx-3 divide-y divide-slate-200 overflow-hidden border-y border-slate-200 bg-white sm:mx-0 sm:rounded-lg sm:border-x";

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
  onDelete = null,
  glance = false,
  className = "bg-white",
  testid,
}) => {
  const parts = idLine.filter(Boolean);
  const showContact = wa && !glance;
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
      className={`w-full cursor-pointer px-3 py-2 text-left transition active:bg-slate-50 ${className}`}
      data-testid={`${testid}-${id}`}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-700 sm:bg-violet-100 sm:text-violet-700">
          {mark || name?.charAt(0)?.toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center text-[14px] font-semibold leading-[18px] text-slate-900 sm:text-sm">
            <span className="truncate">{name || "—"}</span>{nameAddon}
          </p>
          <p className="mt-0.5 truncate text-[11px] font-medium leading-[14px] text-slate-500 sm:text-slate-400">
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
            className={glance
              ? "max-w-[120px] shrink-0 truncate rounded-[4px] border px-2 py-0.5 text-[11px] font-medium leading-4 sm:max-w-[160px]"
              : "max-w-[76px] shrink-0 truncate rounded-[5px] px-2 py-0.5 text-[10px] font-medium leading-4 sm:max-w-[140px] sm:text-[11px]"}
            style={badgeColor
              ? { background: `${badgeColor}1a`, color: badgeColor, borderColor: `${badgeColor}40` }
              : { background: "#f1f5f9", color: "#475569", borderColor: "#e2e8f0" }}
            title={typeof badge === "string" ? badge : undefined}
          >
            {badge}
          </span>
        )}
        {(showContact || onDelete) && (
          <div className="flex shrink-0 sm:gap-1.5">
            {showContact && (<>
              <a
                href={`tel:${wa}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="Call"
                className="flex h-8 w-8 items-center justify-center gap-1.5 rounded-full text-sky-600 active:bg-sky-50 sm:w-auto sm:rounded-md sm:border sm:border-slate-200 sm:bg-white sm:px-2.5 sm:text-xs sm:font-semibold sm:text-slate-700 sm:active:bg-slate-100"
                data-testid={`${testid}-call-${id}`}
              >
                <Phone className="h-[18px] w-[18px] sm:h-3.5 sm:w-3.5" /><span className="hidden sm:inline">Call</span>
              </a>
              <a
                href={`https://wa.me/${wa}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="WhatsApp"
                className="flex h-8 w-8 items-center justify-center gap-1.5 rounded-full text-green-600 active:bg-green-50 sm:w-auto sm:rounded-md sm:border sm:border-[#25D366]/40 sm:bg-[#25D366]/10 sm:px-2.5 sm:text-xs sm:font-semibold sm:text-[#128C7E] sm:active:bg-[#25D366]/20"
                data-testid={`${testid}-whatsapp-${id}`}
              >
                <WhatsAppIcon className="h-5 w-5 sm:h-3.5 sm:w-3.5" /><span className="hidden sm:inline">WhatsApp</span>
              </a>
            </>)}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label={`Delete ${name || "patient"}`}
                title="Delete this patient"
                className={glance
                  ? "flex h-8 w-8 items-center justify-center rounded-full text-slate-400 active:bg-slate-100 active:text-rose-500 sm:rounded-md"
                  : "flex h-8 w-8 items-center justify-center rounded-full text-slate-400 active:bg-rose-50 active:text-rose-500 sm:rounded-md sm:border sm:border-rose-200 sm:bg-white sm:text-rose-500"}
                data-testid={`${testid}-delete-${id}`}
              >
                <Trash2 className={glance ? "h-[18px] w-[18px] sm:h-4 sm:w-4" : "h-[18px] w-[18px] sm:h-3.5 sm:w-3.5"} />
              </button>
            )}
          </div>
        )}
        {glance && <ChevronRight className="-ml-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />}
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
