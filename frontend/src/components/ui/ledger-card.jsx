import { ChevronRight } from "lucide-react";

/**
 * The finance boards' summary card: white and bordered at rest, its label in grey bold
 * small caps with the arrow in the corner, the figure in dark ink, and a caption under it.
 * Colour is kept for the picked card alone, which is filled solid in its own colour with
 * the words in white, so which one is open reads at a glance.
 *
 * One hex per card, applied inline: Tailwind reads class names out of the source, so a class
 * built at runtime from a colour compiles to nothing.
 *
 * `muted` greys a figure of nothing -- Rs.0 still says the desk was open and took nothing,
 * which is worth showing and not worth reading first.
 *
 * A shade darker below sm -- label, caption and a muted figure alike. The desk greys are
 * read on a monitor at arm's length; on a phone in daylight slate-400 type at 10px all but
 * disappeared, and a muted Rs.0 came out under 3:1 against the white. Still a step lighter
 * than a figure that has money in it, so the difference between the two survives.
 *
 * Without onClick it is a figure to read rather than a button: no arrow, no hover.
 *
 * `corner` is a control that belongs to this card alone (My Consultation's All card picks
 * which of its two queues to show), set on the top line just left of the arrow. It holds
 * buttons of its own, and a button inside a button is markup the browser unnests, so with
 * a corner the chrome moves to a wrapper and only the figure stays pressable. The caller
 * draws the control, so it is the caller that knows to turn it white on a picked card.
 */
export const LedgerCard = ({ label, value, sub, color = "#0284c7", active = false, muted = false, onClick, title, testid, corner }) => {
  const Tag = onClick ? "button" : "div";
  const chrome = `h-full w-full min-w-0 rounded-[5px] border text-left transition duration-200 ${
    active
      ? "shadow-[0_2px_4px_rgba(15,23,42,0.06),0_8px_20px_rgba(15,23,42,0.12)]"
      : `border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${
        onClick ? "hover:border-slate-300 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_6px_16px_rgba(15,23,42,0.08)]" : ""
      }`
  }`;
  const fill = active ? { borderColor: color, backgroundColor: color } : undefined;
  const body = (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      title={title}
      className={corner ? "block h-full w-full p-3 text-left sm:p-4" : `${chrome} p-3 sm:p-4`}
      style={corner ? undefined : fill}
      data-testid={testid}
    >
      <div className="flex items-start justify-between gap-1">
        <p className={`min-w-0 text-[10px] font-bold uppercase leading-tight tracking-wider sm:text-[11px] ${active ? "text-white" : "text-slate-600 sm:text-slate-500"} ${
          corner ? "truncate pr-[7.5rem]" : "break-words"
        }`}>
          {label}
        </p>
        {onClick && <ChevronRight className={`h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4 ${active ? "text-white" : "text-slate-400"}`} aria-hidden="true" />}
      </div>
      <p className={`mt-1 break-words text-xl font-bold tabular-nums sm:text-2xl ${active ? "text-white" : muted ? "text-slate-500 sm:text-slate-400" : "text-slate-900"}`}>{value}</p>
      {sub ? (
        <p className={`mt-0.5 text-[11px] leading-tight ${active ? "text-white sm:text-white/90" : "text-slate-500 sm:text-slate-400"}`}>{sub}</p>
      ) : null}
    </Tag>
  );

  if (!corner) return body;
  return (
    <div className={`relative ${chrome}`} style={fill}>
      {/* Level with the label, inset past the arrow: p-3 plus the arrow and a gap below sm,
          p-4 plus the larger arrow and the same gap from sm up. */}
      <div className="absolute right-[34px] top-2.5 z-10 sm:right-10 sm:top-3.5">{corner}</div>
      {body}
    </div>
  );
};

export default LedgerCard;
