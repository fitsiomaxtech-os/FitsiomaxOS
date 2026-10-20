import { useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

// Filter by Date's palette: the cream card and soft border for the list, and amber for
// whatever is picked — on the rows inside, and on the trigger once it holds a value.
const TRIGGER = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";
const TRIGGER_IDLE = "border-slate-200 bg-white text-slate-600 hover:bg-[#F3EFE6]";
const TRIGGER_SET = "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100";
const ROW = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition";
const ROW_ON = "bg-amber-100 font-semibold text-amber-800";
const ROW_OFF = "text-slate-700 hover:bg-[#F3EFE6]";

/**
 * A dropdown dressed as Filter by Date rather than the OS's own <select>.
 *
 * `options` takes plain strings or { value, label }. With `multiple`, `value` is an array,
 * the list stays open while rows are ticked, and every tick hands back the whole new
 * array; a "Clear" row at the foot empties it. Without it, `value` is one value and
 * picking a row closes the list.
 *
 * `label` is what the trigger says (the caller words it — "Manual Therapy +1"), `icon`
 * and `prefix` sit ahead of it, and `set` lights the trigger amber.
 */
export const CreamPicker = ({
  value, onChange, options, multiple = false, label, prefix, icon: Icon, set = false,
  disabled, title, testid = "cream-picker", align = "start", width = "w-56", emptyText = "Nothing to pick",
  className = "",
}) => {
  const [open, setOpen] = useState(false);
  const opts = (options || []).map((o) => (typeof o === "object" ? o : { value: o, label: String(o) }));
  const picked = multiple ? new Set(value || []) : null;
  const isOn = (v) => (multiple ? picked.has(v) : v === value);

  const choose = (v) => {
    if (!multiple) { setOpen(false); if (v !== value) onChange(v); return; }
    // Kept in the list's own order, so the first service stays the first one listed.
    const next = opts.map((o) => o.value).filter((x) => (x === v ? !picked.has(v) : picked.has(x)));
    onChange(next);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        disabled={disabled}
        title={title}
        className={`${TRIGGER} ${set ? TRIGGER_SET : TRIGGER_IDLE} ${className}`}
        data-testid={testid}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        {prefix && <span className="shrink-0 font-medium opacity-80">{prefix}</span>}
        <span className="min-w-0 max-w-[12rem] truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`} />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          className={`z-[200] ${width} max-h-80 overflow-y-auto rounded-xl border border-[#EFEAE0] bg-[#FDFCF8] p-1.5 shadow-2xl outline-none`}
          data-testid={`${testid}-list`}
        >
          {opts.length === 0 && <p className="px-2.5 py-2 text-xs text-slate-400">{emptyText}</p>}
          {opts.map((o) => {
            const on = isOn(o.value);
            return (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => choose(o.value)}
                className={`${ROW} ${on ? ROW_ON : ROW_OFF}`}
                role={multiple ? "menuitemcheckbox" : "menuitemradio"}
                aria-checked={on}
                data-testid={`${testid}-option-${o.value}`}
              >
                {multiple && (
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-amber-500 bg-amber-500 text-white" : "border-slate-300 bg-white"}`}>
                    {on && <Check className="h-3 w-3" />}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {!multiple && on && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
          {multiple && picked.size > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full border-t border-[#EFEAE0] px-2.5 pb-1 pt-2 text-left text-xs font-semibold text-slate-500 hover:text-slate-700"
              data-testid={`${testid}-clear`}
            >
              Clear
            </button>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

export default CreamPicker;
