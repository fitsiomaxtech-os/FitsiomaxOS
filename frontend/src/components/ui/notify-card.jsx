import { ChevronRight } from "lucide-react";

/**
 * A full-width filter row for a phone: the card's icon in a tinted square on the left,
 * the label over the figure, and a chevron in a tinted disc on the right — stacked one
 * card to a row, where a three-across StatTile strip squeezes "COMPLETED" into ~110px.
 *
 * The count is also pinned to the top-right corner as a notification badge, and the
 * badge pings while the count is above 0, so a bucket with someone waiting in it reads
 * as waiting before the figure is even read. At 0 the badge stays, greyed and still: a
 * badge that appears and disappears moves the eye to the cards that have nothing.
 * `motion-safe` so a phone set to reduce motion gets the badge without the pulse.
 *
 * The badge hangs 6px past the card's corner, so the list it sits in needs that much
 * room on the right and top — the page gutter gives it.
 *
 * Every colour is an inline style off one hex per card, for the same reason StatTile
 * gives: a `bg-${tone}-100` built at runtime compiles to nothing.
 *
 * The picked card is outlined and washed in its own colour, as in the reference the
 * user sent; the others stay white.
 *
 * `badgeColor` paints only the corner badge, leaving the card on `color` — how a
 * colourless card still says somebody is waiting in it (Branch Leads and Consultation on
 * a phone). Falls back to `color`, so a caller passing one hex keeps drawing badge and
 * body in the same colour as before.
 *
 * `showCount` drops the badge entirely, for a row with nothing to count: the Management
 * sub-tab cards are this shape without a number in the corner.
 *
 * `count` puts its own number in the badge where the figure is not one -- Accountant
 * Manage's Summary cards show an amount, and how many payments make it up in the corner.
 *
 * `dot` is the red new-since-last-opened dot (see tab-dot.jsx), for a row with no count.
 *
 * `inline` lays the row out on one line instead, drawn to the reference the user sent:
 * a plain grey icon, the label, the count in a light orange box beside it, a plain grey
 * chevron on the right -- no tinted squares, no big figure; a deeper shadow (shadow-md)
 * than the stacked card's, and the label at Manage's text-xs. The open card's border is
 * 2px, its padding 1px less each side so the card does not grow when picked. The corner badge
 * gives way to a red dot inside the corner that pops up every 3s (tailwind.config's
 * dot-pop), shown only while the count is above 0: the dot says someone is waiting, the
 * box says how many. Colours are fixed rather than taken from `color`/`badgeColor`, the
 * reference being one look for every stage. Branch Leads' and Consultation's stage cards
 * on a phone, and Activity Care > Zumba's.
 *
 * `display` puts other text in the inline box than the count -- Zumba's money cards show
 * their amount there, while `count` (the customers behind it) still decides the dot.
 *
 * `showCount={false}` on an inline row drops the box and the dot with it: icon, label and
 * chevron alone, for a row that opens a section rather than counting anything (HR Admin >
 * Staff on a phone).
 */
export const NotifyCard = ({ label, value, icon: Icon, color = "#0284c7", badgeColor, active = false, onClick, testid, showCount = true, count: badgeCount, dot = false, inline = false, display }) => {
  const count = Number(badgeCount ?? value) || 0;
  const live = count > 0;
  const badge = badgeColor || color;
  if (inline) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`relative flex w-full items-center gap-4 rounded-xl bg-white text-left shadow-md transition active:scale-[0.99] ${active ? "border-2 border-slate-400 px-[15px] py-[13px]" : "border border-slate-200 px-4 py-3.5"}`}
        data-testid={testid}
      >
        {/* Both icons at 80% of their old size and 85% of their old opacity: the stage icon
            19.2px -> 15.4px at 75% -> 64%, the chevron 24px -> 19.2px at 85%. The name
            leads, the icons only hint. */}
        {Icon && <Icon aria-hidden className="h-[0.96rem] w-[0.96rem] shrink-0 text-slate-500 opacity-[0.64]" strokeWidth={2} />}
        {/* Manage's card label size (text-xs, see the stacked card below). */}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-900 opacity-75">{label}</span>
        {/* Right-aligned beside the chevron, so the counts line up down the stack. One width
            for every box, wide enough for three digits, so 0 and 123 sit in the same shape;
            the full figure is shown (no 99+), and only a fourth digit widens it. Only the
            fill is faded (to 35%); the number stays solid, in a darker orange to read on it. */}
        {showCount && (
          <span
            className="inline-flex h-7 min-w-[3rem] shrink-0 items-center justify-center rounded-md border border-orange-200 bg-orange-100/35 px-2 text-base font-medium tabular-nums text-orange-700"
            data-testid={testid ? `${testid}-badge` : undefined}
          >
            {display ?? count}
          </span>
        )}
        <ChevronRight aria-hidden className="h-[1.2rem] w-[1.2rem] shrink-0 text-slate-500 opacity-[0.85]" />
        {live && showCount && (
          <span aria-hidden className="absolute right-2.5 top-2 h-2.5 w-2.5 rounded-full bg-red-500 motion-safe:animate-dot-pop" data-testid={testid ? `${testid}-dot` : undefined} />
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="relative flex w-full items-center gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition active:scale-[0.99]"
      style={active
        ? { borderColor: color, backgroundColor: `${color}0F`, boxShadow: `0 0 0 1px ${color}` }
        : { borderColor: "#e2e8f0" }}
      data-testid={testid}
    >
      {Icon && (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${color}1F` }}>
          <Icon aria-hidden className="h-5 w-5" style={{ color }} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-slate-600">{label}</span>
        <span className="block text-xl font-extrabold leading-tight" style={{ color }}>{value}</span>
      </span>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: `${color}1A` }}>
        <ChevronRight aria-hidden className="h-4 w-4" style={{ color }} />
      </span>

      {showCount && (
        <span aria-hidden className="absolute -right-1.5 -top-1.5 flex" data-testid={testid ? `${testid}-badge` : undefined}>
          {live && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: badge }} />}
          <span
            className="relative inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white"
            style={{ background: live ? badge : "#cbd5e1" }}
          >
            {count > 99 ? "99+" : count}
          </span>
        </span>
      )}
      {dot && !showCount && (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 ring-1 ring-white" data-testid={testid ? `${testid}-dot` : undefined} />
      )}
    </button>
  );
};

export default NotifyCard;
