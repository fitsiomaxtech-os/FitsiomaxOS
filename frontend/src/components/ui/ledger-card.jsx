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
 */
export const LedgerCard = ({ label, value, sub, color = "#0284c7", active = false, muted = false, onClick, title, testid }) => {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      title={title}
      className={`h-full w-full min-w-0 rounded-[5px] border p-3 text-left transition duration-200 sm:p-4 ${
        active
          ? "shadow-[0_2px_4px_rgba(15,23,42,0.06),0_8px_20px_rgba(15,23,42,0.12)]"
          : `border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${
            onClick ? "hover:border-slate-300 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_6px_16px_rgba(15,23,42,0.08)]" : ""
          }`
      }`}
      style={active ? { borderColor: color, backgroundColor: color } : undefined}
      data-testid={testid}
    >
      <div className="flex items-start justify-between gap-1">
        <p className={`min-w-0 break-words text-[10px] font-bold uppercase leading-tight tracking-wider sm:text-[11px] ${active ? "text-white" : "text-slate-600 sm:text-slate-500"}`}>
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
};

export default LedgerCard;
