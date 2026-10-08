import { useEffect, useState } from "react";
import { Check, CheckCircle2, Loader2 } from "lucide-react";
import { CenteredPicker } from "@/components/ui/milk-calendar";
import { to12h } from "@/lib/time";

/**
 * WHICH SHIFTS AN EXPERT WORKS — several of them, on purpose.
 *
 * The roster used to ask this as a one-of-many question, and it is not one: a consultant
 * who takes 8:00 AM – 1:00 PM, goes home, and is back 5:00 PM – 9:00 PM works a morning and
 * an evening. Forced to pick one, a branch either published half their day or invented a
 * single 8-to-9 shift that offers patients every afternoon hour nobody is there for.
 *
 * So the options tick rather than replace each other, and the picker says back what the day
 * will actually run — both halves, with the gap between them left out of it.
 *
 * Nothing is sent per tick. The ticks are a draft until Save, because a split day is set as
 * one decision ("mornings and evenings") and saving each half separately would leave the
 * calendar briefly published across whichever one was ticked first.
 */
export const ShiftPickerModal = ({
  title,
  shifts = [],
  // Windows the list cannot show but the expert is on — a CONSULTANT is org-wide, so a
  // shift on them may have been defined by another branch. Offered as it stands rather
  // than leaving the control naming something with no option behind it.
  extraOptions = [],
  value = [],
  onSave,
  onClose,
  saving = false,
  noneLabel = "No shift — full day",
  noneHint = "The whole working day is offered",
}) => {
  const [picked, setPicked] = useState(value);

  // Re-sync if the roster reloads under an open picker, so Save never writes back a
  // selection made against hours that have since changed. Keyed on the ids themselves and
  // not the array, which is rebuilt on every render of the row this sits in.
  const valueKey = value.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPicked(value); }, [valueKey]);

  const options = [
    ...shifts.map((s) => ({ id: s.id, label: s.name, hint: `${to12h(s.start_time)} – ${to12h(s.end_time)}` })),
    ...extraOptions,
  ];

  const toggle = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  // Sorted by when the window starts, so "Morning + Evening" is never written the other way
  // round and the day reads in the order it is worked. A shift defined by another branch
  // has no row here to read a start off, and sorts last rather than jumping to the front.
  const byClock = (ids) =>
    [...ids].sort((a, b) =>
      (shifts.find((s) => s.id === a)?.start_time || "99:99").localeCompare(
        shifts.find((s) => s.id === b)?.start_time || "99:99",
      ),
    );

  const ordered = byClock(picked);
  const unchanged = ordered.join(",") === byClock(value).join(",");

  const summary = ordered.length === 0
    ? noneLabel
    : ordered
      .map((id) => {
        const row = options.find((o) => o.id === id);
        return row ? `${row.label} · ${row.hint}` : "";
      })
      .filter(Boolean)
      .join("   +   ");

  return (
    <CenteredPicker title={title} onClose={onClose} testid="shift-picker-modal">
      {/* Desk only — on a phone the ticks and the summary under them say it already. */}
      <p className="mb-2 hidden px-1 text-[11px] leading-snug text-slate-500 md:block">
        Tick every window this expert works. Two of them — a morning and an evening — opens
        both halves of the day and leaves the hours between them closed.
      </p>
      <div className="space-y-1">
        <button
          type="button"
          disabled={saving}
          onClick={() => setPicked([])}
          className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:opacity-60 ${
            picked.length === 0 ? "bg-[#F3EFE6]" : "hover:bg-[#F3EFE6]"
          }`}
          data-testid="shift-picker-option-none"
        >
          <span className="min-w-0">
            <span className={`block truncate text-sm ${picked.length === 0 ? "font-bold text-slate-900" : "text-slate-700"}`}>{noneLabel}</span>
            <span className="block truncate text-[11px] text-slate-500">{noneHint}</span>
          </span>
          {picked.length === 0 && <CheckCircle2 className="h-4 w-4 shrink-0 text-amber-600" />}
        </button>

        {options.map((opt) => {
          const on = picked.includes(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              disabled={saving}
              onClick={() => toggle(opt.id)}
              className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:opacity-60 ${
                on ? "bg-[#F3EFE6]" : "hover:bg-[#F3EFE6]"
              }`}
              data-testid={`shift-picker-option-${opt.id}`}
            >
              <span className="min-w-0">
                <span className={`block truncate text-sm ${on ? "font-bold text-slate-900" : "text-slate-700"}`}>{opt.label}</span>
                <span className="block truncate text-[11px] text-slate-500">{opt.hint}</span>
              </span>
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                  on ? "border-amber-600 bg-amber-600 text-white" : "border-slate-300 bg-white"
                }`}
              >
                {on && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          );
        })}
      </div>

      {/* What the day will actually run, before it is saved — the point of ticking two is
          the hours that come out of it, so they are stated rather than inferred. */}
      <p className="mt-3 rounded-xl bg-[#F3EFE6] px-3 py-2 text-[11px] font-semibold text-slate-700" data-testid="shift-picker-summary">
        {summary}
      </p>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-[#F3EFE6]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || unchanged}
          onClick={() => onSave(ordered)}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          data-testid="shift-picker-save"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save shift{ordered.length > 1 ? "s" : ""}
        </button>
      </div>
    </CenteredPicker>
  );
};

export default ShiftPickerModal;
