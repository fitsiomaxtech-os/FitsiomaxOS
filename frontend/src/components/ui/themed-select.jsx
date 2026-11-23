import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Shared with SelectOrType, so a typed-or-picked field and a plain picker look like one form.
export const THEMED_TRIGGER =
  "border-slate-200 bg-white text-slate-800 shadow-none hover:bg-slate-50 focus:ring-2 focus:ring-sky-200 data-[placeholder]:text-slate-400 disabled:bg-slate-100 disabled:text-slate-500 disabled:opacity-100";
// z-[200] lifts the list above the modals (z-[60]..z-[90]) it opens inside.
export const THEMED_CONTENT = "z-[200] max-h-72 border-slate-200";
export const THEMED_ITEM = "text-sm text-slate-700 focus:bg-sky-50 focus:text-sky-700";

// Radix keeps "" for "nothing picked" and refuses it as an item's value, so a blank option
// rides under this stand-in and is turned back into "" on the way out.
const BLANK = "__blank__";

/**
 * A drop-in for a native <select>, in the app's own list rather than the OS's blue one.
 * `options` takes plain strings or { value, label }. An option whose value is "" stays in
 * the list, muted, so a field can still be cleared the way the native blank row allowed;
 * while nothing is picked the trigger shows `placeholder` in grey.
 */
export const ThemedSelect = ({ value, onChange, options, placeholder = "Select", disabled, title, className = "", testid }) => {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <Select value={value || ""} onValueChange={(v) => onChange(v === BLANK ? "" : v)} disabled={disabled}>
      <SelectTrigger className={`${THEMED_TRIGGER} ${className}`} title={title} data-testid={testid}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={THEMED_CONTENT}>
        {opts.map((o) => (
          <SelectItem
            key={o.value || BLANK}
            value={o.value || BLANK}
            className={`${THEMED_ITEM} ${o.value ? "" : "text-slate-400"}`}
          >
            {o.label || placeholder}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
