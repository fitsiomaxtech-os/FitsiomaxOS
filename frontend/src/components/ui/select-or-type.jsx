import { useEffect, useRef, useState } from "react";
import { List, PenLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { THEMED_CONTENT, THEMED_ITEM, THEMED_TRIGGER } from "@/components/ui/themed-select";

// Radix keeps "" for "nothing picked", so the manual row needs a value no option can have.
const MANUAL = "__manual_entry__";

/**
 * The themed dropdown with a way out: the usual options one click away in the app's own
 * list (a native <datalist> opens the browser's grey menu instead), and a "Type
 * manually…" row at the top that swaps the dropdown for a text box, for the value nobody listed.
 * The box carries a button back to the list.
 *
 * Opens straight into the text box when the saved value is not one of the options, so an
 * existing typed-in value reads as itself rather than as a blank dropdown.
 */
export const SelectOrType = ({
  value,
  onChange,
  options,
  placeholder = "Select",
  manualLabel = "Type manually…",
  manualPlaceholder = "Type here",
  className = "",
  testid,
}) => {
  const isListed = (v) => options.includes(v);
  const [manual, setManual] = useState(() => !!value && !isListed(value));
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const focusInput = useRef(false);

  // A value set from outside (a lead loaded after mount) that is not on the list still
  // has to show; the reverse is left alone, so clearing the box does not yank it away.
  useEffect(() => {
    if (value && !isListed(value)) setManual(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (manual && focusInput.current) {
      focusInput.current = false;
      inputRef.current?.focus();
    }
  }, [manual]);

  const pick = (v) => {
    // The box starts from what was picked, so "Other" can be edited into something specific.
    if (v === MANUAL) {
      focusInput.current = true;
      setManual(true);
      return;
    }
    onChange(v);
  };

  const backToList = () => {
    if (!isListed(value)) onChange("");
    setManual(false);
    setOpen(true);
  };

  if (manual) {
    return (
      <div className="relative">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={manualPlaceholder}
          className={`pr-9 ${className}`}
          data-testid={testid}
        />
        <button
          type="button"
          onClick={backToList}
          title="Choose from the list"
          aria-label="Choose from the list"
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-sky-600"
          data-testid={testid && `${testid}-list`}
        >
          <List className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <Select value={isListed(value) ? value : ""} onValueChange={pick} open={open} onOpenChange={setOpen}>
      <SelectTrigger
        className={`${THEMED_TRIGGER} ${className}`}
        data-testid={testid}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={THEMED_CONTENT}
        // The trigger is gone once "Type manually…" is picked; focus goes to the box instead.
        onCloseAutoFocus={(e) => focusInput.current && e.preventDefault()}
      >
        {/* First, so it is in view without scrolling past every option to reach it. */}
        <SelectItem value={MANUAL} className="text-sm font-medium text-sky-700 focus:bg-sky-50 focus:text-sky-700" data-testid={testid && `${testid}-manual`}>
          <span className="flex items-center gap-2">
            <PenLine className="h-3.5 w-3.5" />
            {manualLabel}
          </span>
        </SelectItem>
        <SelectSeparator className="bg-slate-100" />
        {options.map((o) => (
          <SelectItem key={o} value={o} className={THEMED_ITEM}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
