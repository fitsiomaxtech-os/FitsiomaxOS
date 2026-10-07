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
 */
export const NotifyCard = ({ label, value, icon: Icon, color = "#0284c7", active = false, onClick, testid }) => {
  const count = Number(value) || 0;
  const live = count > 0;
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

      <span aria-hidden className="absolute -right-1.5 -top-1.5 flex" data-testid={testid ? `${testid}-badge` : undefined}>
        {live && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} />}
        <span
          className="relative inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white"
          style={{ background: live ? color : "#cbd5e1" }}
        >
          {count > 99 ? "99+" : count}
        </span>
      </span>
    </button>
  );
};

export default NotifyCard;
