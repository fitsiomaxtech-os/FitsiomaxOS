import { ChevronRight } from "lucide-react";

/**
 * Branch Admin > Zumba's summary card (LedgerCard in branch/ZumbaPanel.jsx), for the boards
 * that want the same strip: a faint wash of the card's colour, its label in bold small caps
 * with the arrow in the corner, the figure, and a caption under it. The picked card is filled
 * solid in its own colour with the words in white, so which one is open reads at a glance.
 *
 * One hex per card, applied inline: Tailwind reads class names out of the source, so a class
 * built at runtime from a colour compiles to nothing.
 *
 * Without onClick it is a figure to read rather than a button: no arrow, no hover.
 */
export const LedgerCard = ({ label, value, sub, color = "#0284c7", active = false, onClick, title, testid }) => {
  const Tag = onClick ? "button" : "div";
  const ink = active ? "#ffffff" : color;
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      title={title}
      className={`h-full w-full min-w-0 rounded-[5px] border p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_rgba(15,23,42,0.07)] transition duration-200 sm:p-4 ${
        onClick ? "hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_8px_24px_rgba(15,23,42,0.10)]" : ""
      }`}
      style={{ borderColor: active ? color : `${color}55`, background: active ? color : `${color}0f` }}
      data-testid={testid}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="min-w-0 break-words text-[10px] font-bold uppercase leading-tight tracking-wider sm:text-[11px]" style={{ color: ink }}>
          {label}
        </p>
        {onClick && <ChevronRight className={`h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4 ${active ? "text-white" : "text-slate-400"}`} aria-hidden="true" />}
      </div>
      <p className="mt-1 break-words text-xl font-bold tabular-nums sm:text-2xl" style={{ color: ink }}>{value}</p>
      {sub ? (
        <p className={`mt-0.5 text-[10px] leading-tight sm:text-[11px] ${active ? "opacity-90" : "opacity-80"}`} style={{ color: ink }}>{sub}</p>
      ) : null}
    </Tag>
  );
};

export default LedgerCard;
