import { Phone, Trash2 } from "lucide-react";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { telNumber } from "@/lib/phone";

/**
 * Branch Leads' phone card, drawn from the user's reference (2026-11-20): one white card
 * per patient with a 16px corner, a thin grey border and a soft shadow, the name in bold
 * slate, the stage pill under it, and WhatsApp then Call as bare icons on the right.
 * Every stage of Branch Leads draws it -- All Stages, New Leads, RNR, Follow Up, Pre Book,
 * Appointment, Not a Prospect and Lost -- so the patient is one tap away from any list.
 *
 * Phone only: the board mounts it in the list it hides from md up, where the desk table
 * takes over. Separate cards with a gap between them, not LeadRowCard's inbox rows.
 *
 * `wa` is lib/phone's waNumber; without one the two icons are left off and `fallback`
 * (the number as stored, say) is shown under the pill instead. The icons are anchors so
 * tel: and the WhatsApp handoff are the browser's own, and stop propagation so a tap on
 * one doesn't also open the card.
 *
 * `badgeColor` is a hex, set inline: a class built at runtime compiles to nothing.
 * `onDelete` adds a grey bin after Call (New Leads only, as before). `details` is the
 * stage's own lines -- appointment, follow-up, reminder -- under the pill.
 *
 * Test ids: `${testid}-${id}`, `${testid}-whatsapp-${id}`, `${testid}-call-${id}`,
 * `${testid}-delete-${id}`, the same names the row this replaces used.
 */
export const LEAD_CARD_LIST = "space-y-2.5";

export const LeadContactCard = ({
  id,
  name,
  nameAddon = null,
  badge = null,
  badgeColor = null,
  wa = null,
  fallback = null,
  details = null,
  onOpen,
  onDelete = null,
  testid,
}) => (
  // A div, not a button: the icons are links, and a link inside a button is invalid.
  <div
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); }
    }}
    className="w-full cursor-pointer rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-left shadow-[0_3px_8px_rgba(15,23,42,0.10)] transition active:bg-slate-50"
    data-testid={`${testid}-${id}`}
  >
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center text-[16px] font-bold leading-5 text-slate-600">
          <span className="truncate">{name || "—"}</span>{nameAddon}
        </p>
        {badge && (
          <span
            className="mt-2 inline-block max-w-full truncate rounded-lg px-3 py-1 text-[12px] font-bold leading-4"
            style={badgeColor
              ? { background: `${badgeColor}1f`, color: badgeColor }
              : { background: "#f1f5f9", color: "#475569" }}
            title={typeof badge === "string" ? badge : undefined}
          >
            {badge}
          </span>
        )}
        {!wa && fallback && <p className="mt-1.5 truncate text-[11px] font-medium text-slate-500">{fallback}</p>}
        {details && <div className="mt-1.5 min-w-0 space-y-0.5">{details}</div>}
      </div>
      {(wa || onDelete) && (
        <div className="flex shrink-0 items-center gap-1">
          {wa && (<>
            <a
              href={`https://wa.me/${wa}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="WhatsApp"
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#25D366] active:bg-green-50"
              data-testid={`${testid}-whatsapp-${id}`}
            >
              <WhatsAppIcon className="h-7 w-7" />
            </a>
            <a
              href={`tel:${telNumber(wa)}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="Call"
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#1E80F0] active:bg-blue-50"
              data-testid={`${testid}-call-${id}`}
            >
              <Phone className="h-6 w-6" />
            </a>
          </>)}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`Delete ${name || "patient"}`}
              title="Delete this patient"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 active:bg-rose-50 active:text-rose-500"
              data-testid={`${testid}-delete-${id}`}
            >
              <Trash2 className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      )}
    </div>
  </div>
);
