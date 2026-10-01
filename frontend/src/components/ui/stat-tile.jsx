import { ChevronRight } from "lucide-react";

/**
 * The figure card the money boards share: a label, the number, a line saying what the
 * number counts, and the card's colour carried by a disc bleeding out of the top-right
 * corner with an icon in it.
 *
 * The colour is a disc rather than a filled tile because these arrive four and seven to a
 * row — seven filled tiles is seven things shouting and none of them is the figure. The
 * icon says which card at a glance, which matters most on a phone where the labels
 * truncate before the numbers do.
 *
 * Every colour is an inline style off one hex per card. Tailwind reads class names out of
 * the source, so a `bg-${tone}-100` built at runtime compiles to nothing and the disc
 * would come out invisible — and a hex means a new card needs no class map kept in step.
 *
 * Renders a button when given an onClick (the collections boards use their tiles as the
 * table's filter) and a plain div otherwise, so a card that does nothing is not announced
 * to a screen reader as something to press.
 *
 * `compact` is for a row that has to stay one row on a phone. Four of these across a
 * ~325px screen leaves about 70px a card, which is less than the corner disc and the
 * label can share: so below sm the disc and its icon step out and the label takes the
 * whole width, with the figure and the sub-line sized down to match. From sm up a compact
 * card is the ordinary card — the squeeze is only ever the phone's.
 *
 * `arrow` drops the corner disc and its icon in favour of the ledger card's chevron, on a
 * 5px corner -- the look the finance cards and Zumba's own strip already wear. Opt-in so
 * the money, physio and review boards keep the disc they were built around.
 *
 * Two slots for controls that belong to one card rather than to the list under it:
 * `footer` on a rule beneath the figure, and `corner` on the top line, running up to the
 * icon with the icon on its right. Corner is for a control that reads as a property of
 * the card — which of the things it counts to show — where a rule underneath makes it
 * look like a second card. It needs a card wide enough to hold it beside the label.
 */
export const StatTile = ({
  label, value, sub, icon: Icon, color = "#0284c7", active = false, onClick, testid, footer, corner,
  compact = false, arrow = false,
}) => {
  // With a footer or a corner the card cannot be one big button: both hold controls of
  // their own, and a button inside a button is invalid markup the browser unnests, which
  // loses the inner clicks. So the chrome moves to a wrapper and only the figure stays
  // pressable.
  const wrapped = !!footer || !!corner;
  const Tag = onClick ? "button" : "div";
  const tagProps = onClick ? { type: "button", onClick } : {};
  // h-full so a row of these comes out level. Their container stretches each cell to the
  // tallest, but a tile that only claims its content height floats at the top of that
  // cell — which is what left one card with a footer standing taller than the three
  // beside it.
  const chrome = `relative h-full w-full overflow-hidden ${arrow ? "rounded-[5px]" : "rounded-xl"} border bg-white text-left shadow-sm transition ${
    active ? "border-transparent" : `border-slate-200 ${onClick ? "hover:shadow-md" : ""}`
  }`;
  const body = (
    <Tag
      {...tagProps}
      className={wrapped
        ? "relative block w-full flex-1 p-3 text-left sm:p-4"
        : `${chrome} ${compact ? "p-2" : "p-3"} sm:p-4`}
      style={!wrapped && active ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
      data-testid={testid}
    >
      {/* The corner disc and its icon are the money boards' own decoration. An `arrow` card
          (Branch Admin's Fitness-style strips) drops both and carries the ledger
          card's chevron instead -- see ui/ledger-card and ZumbaPanel's own card, which
          these strips match. */}
      {!arrow && (
        <span
          aria-hidden
          className={`pointer-events-none absolute -right-5 -top-5 h-16 w-16 rounded-full sm:-right-6 sm:-top-6 sm:h-20 sm:w-20 ${compact ? "hidden sm:block" : ""}`}
          style={{ background: `linear-gradient(135deg, ${color}2E, ${color}0D)` }}
        />
      )}
      {Icon && !corner && !arrow && <Icon aria-hidden className={`absolute right-2.5 top-2.5 h-3.5 w-3.5 sm:right-3.5 sm:top-3.5 sm:h-4 sm:w-4 ${compact ? "hidden sm:block" : ""}`} style={{ color }} />}
      {arrow && !corner && (
        <ChevronRight aria-hidden className={`absolute right-2.5 top-2.5 h-3.5 w-3.5 text-slate-400 sm:right-3.5 sm:top-3.5 sm:h-4 sm:w-4 ${compact ? "hidden sm:block" : ""}`} />
      )}
      {/* The right padding keeps a long label out from under the icon; the figure shrinks
          on a phone because two cards to a row leaves about 130px and "Rs.4,32,704" does
          not fit at text-2xl with nowhere to wrap.
          Everything steps down below sm because these also arrive three to a row on the
          Physio board, which leaves ~110px. At the old fixed p-4/pr-9 that is about 40px
          of text column, and "COMPLETED" is one word that cannot wrap — it would have been
          clipped by the overflow-hidden above rather than shortened. break-words is the
          floor: a label with nowhere left to go breaks instead of disappearing.
          Wider again where a corner control shares that top line, and reserved at a fixed
          width rather than measured: the label is the half that gives way there, so it
          truncates instead of wrapping under a control it cannot see. The sm figure is
          that same reserve plus the 30px the control is inset by below — the two move
          together or the label slides under the thing the space was kept for. */}
      <p className={`font-bold uppercase leading-tight tracking-wider text-slate-500 sm:text-[11px] ${compact ? "text-[9px] tracking-wide" : "text-[10px]"} ${
        corner ? "truncate pr-[8.5rem] sm:pr-[10.375rem]" : compact ? "break-words pr-0 sm:pr-9" : "break-words pr-7 sm:pr-9"
      }`}>{label}</p>
      <p className={`mt-1 font-extrabold sm:text-2xl ${compact ? "text-base" : "text-xl"}`} style={{ color }}>{value}</p>
      {sub && <p className={`mt-0.5 leading-tight text-slate-400 sm:text-[10px] ${compact ? "text-[8px]" : "text-[10px]"}`}>{sub}</p>}
    </Tag>
  );

  if (!wrapped) return body;
  return (
    <div className={`${chrome} flex flex-col`} style={active ? { boxShadow: `0 0 0 2px ${color}` } : undefined}>
      {/* Outside the figure's button, over the top-right of the card: the control sits on
          the card's own top line, with the icon kept on its right so the corner still
          reads as one thing. */}
      {corner && (
        <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5 sm:right-3.5 sm:top-3.5">
          {/* The control sits 30px in from the icon, which stays on the card's right edge.
              Hard against it the two read as one run of chrome, and the buttons sat over
              the decorative disc behind the icon; the gap separates the thing you press
              from the thing that only labels the card.

              From sm up only. On a phone this corner is already the reason the All card is
              widened to 13.5rem — see HeadPhysioBoard — and 30px more there is 30px the
              card does not have, so it would clip rather than shift. */}
          <span className="sm:mr-[30px]">{corner}</span>
          {Icon && <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" style={{ color }} />}
        </div>
      )}
      {body}
      {footer && <div className="border-t border-slate-100 px-3 pb-2.5 pt-2 sm:px-4">{footer}</div>}
    </div>
  );
};

export default StatTile;
