import { Eye } from "lucide-react";

/**
 * The phone face of the Accountant Manage tables.
 *
 * Every one of those tables is table-fixed with percentage columns and no min-width, so on
 * a phone each column collapsed to a fraction of ~330px and the text of one ran straight
 * through the next — a branch name printed over a client name, an amount over its payment
 * mode. The columns cannot simply be made to scroll either: a transaction is only useful
 * read whole, and nine columns behind a swipe means seeing two of them.
 *
 * So each board hands this one component a card spec and keeps its table from md up.
 * Shared rather than written seven times because these cards differ only in which fields
 * they name, and seven copies would drift the moment one was edited.
 *
 * `card(row, i)` returns { key, title, subtitle?, amount?, meta?, actions?, onOpen?, testid? }.
 * meta entries may be strings or badge elements; falsy ones are dropped, so a board can
 * pass `cond && <Badge/>` without guarding. `actions` sits at the right end beside View;
 * a control there must stop its own click, or it opens the card too.
 */
export const RecordCards = ({ rows, card, empty = "Nothing here yet.", testid }) => (
  <div className="space-y-2 md:hidden" data-testid={testid}>
    {rows.length === 0 ? (
      <p className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">{empty}</p>
    ) : rows.map((row, i) => {
      const c = card(row, i);
      const clickable = typeof c.onOpen === "function";
      const meta = (c.meta || []).filter(Boolean);
      return (
        // A div rather than a button: several of these cards carry badges and the odd
        // control of their own, and a button cannot legally contain one.
        <div
          key={c.key ?? i}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={clickable ? () => c.onOpen() : undefined}
          onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.onOpen(); } } : undefined}
          className={`rounded-xl border border-slate-200 bg-white p-3 ${clickable ? "cursor-pointer active:bg-slate-50" : ""}`}
          data-testid={c.testid}
        >
          <div className="flex items-start justify-between gap-2">
            {/* min-w-0 on the left so a long name truncates instead of shoving the amount
                off the card — the failure this whole component exists to undo. */}
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-800">
                <span className="mr-1.5 font-normal text-slate-400">{i + 1}.</span>{c.title}
              </p>
              {c.subtitle ? <p className="truncate text-xs text-slate-500">{c.subtitle}</p> : null}
            </div>
            {c.amount ? <div className="shrink-0 text-right leading-tight">{c.amount}</div> : null}
          </div>
          {meta.length > 0 || clickable || c.actions ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
              {meta.map((m, j) => <span key={j} className="min-w-0 max-w-full truncate">{m}</span>)}
              {(clickable || c.actions) && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-2">
                  {c.actions}
                  {clickable && (
                    <span className="inline-flex items-center gap-1 font-semibold text-sky-700">
                      <Eye className="h-3.5 w-3.5" /> View
                    </span>
                  )}
                </span>
              )}
            </div>
          ) : null}
        </div>
      );
    })}
  </div>
);

export default RecordCards;
