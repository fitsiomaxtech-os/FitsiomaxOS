import { ChevronDown } from "lucide-react";

// One set per accent, spelt out in full: Tailwind reads class names out of the source, so a
// class built at runtime from a colour name compiles to nothing.
const ACCENTS = {
  sky: { on: "border-sky-600 bg-sky-50 text-sky-700", chevron: "text-sky-600", ring: "focus-visible:ring-sky-500" },
  indigo: { on: "border-indigo-600 bg-indigo-50 text-indigo-700", chevron: "text-indigo-600", ring: "focus-visible:ring-indigo-500" },
};

/**
 * A filter row folded into one native dropdown, for a phone: the row of buttons it stands in
 * for runs off the side of the screen there, and the phone's own picker is the right size
 * for a thumb. Same 40px height as the buttons it replaces.
 *
 * White while it is on its "everything" value, tinted in its accent once it narrows
 * anything (`active`), so a filtered board says so without the list being opened -- the job
 * the lit button did in the row.
 *
 * The options are the caller's, as children, so a filter can carry one that is an action
 * rather than a value (the date filter's Custom Range…).
 */
export const FilterSelect = ({ value, onChange, active = false, accent = "sky", label, title, className = "", testid, children }) => {
  const A = ACCENTS[accent] || ACCENTS.sky;
  return (
    <div className={`relative min-w-0 ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        title={title}
        className={`h-10 w-full appearance-none rounded-md border pl-2.5 pr-7 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${A.ring} ${
          active ? A.on : "border-slate-200 bg-white text-slate-700"
        }`}
        data-testid={testid}
      >
        {children}
      </select>
      <ChevronDown
        className={`pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 ${active ? A.chevron : "text-slate-400"}`}
        aria-hidden="true"
      />
    </div>
  );
};

export default FilterSelect;
