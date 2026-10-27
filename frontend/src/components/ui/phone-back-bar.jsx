import { useLayoutEffect, useState } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Written out rather than built from `from`: Tailwind reads the source for class names, so
// a `${from}:hidden` built at runtime compiles to nothing and the bar would show on a desk.
const HIDE_FROM = { sm: "sm:hidden", md: "md:hidden" };

/**
 * The bar over whatever a phone row opened -- a Dashboard figure, a Staff section, a
 * supervised board's view: the way back to the rows, the name of what is open (with its
 * count in the rows' orange box when it has one), and a menu to jump to another without
 * going back first. Branch Admin's Review bar, as HR Admin and Operations wear it. Phone
 * only; `from` is the breakpoint the host's own desk layout starts at, "sm" or "md".
 *
 * `items` are what the menu offers, as { key, label, icon, value? }. An item whose `value`
 * is undefined has nothing to count and draws no number.
 *
 * Sticks just under the board header, whose height is the role's own (Branch Admin's is
 * 61px, Super Admin's taller), so it is measured as the bar mounts rather than assumed.
 */
export const PhoneBackBar = ({ current, items, onBack, onPick, backLabel, testid, from = "sm" }) => {
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    setTop(document.querySelector('[data-testid="role-board-header"]')?.getBoundingClientRect().height || 0);
  }, []);
  return (
    <div
      className={`sticky z-10 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2 shadow-sm ${HIDE_FROM[from] || HIDE_FROM.sm}`}
      style={{ top }}
      data-testid={`${testid}-back`}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left active:bg-slate-100"
        aria-label={backLabel}
        data-testid={`${testid}-back-btn`}
      >
        <ChevronLeft aria-hidden className="h-5 w-5 shrink-0 text-slate-600 motion-safe:animate-nudge-left" />
        <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{current.label}</span>
        {current.value !== undefined && (
          <span className="inline-flex h-6 min-w-[2.25rem] shrink-0 items-center justify-center rounded-md border border-orange-200 bg-orange-100/35 px-2 text-sm font-medium tabular-nums text-orange-700">
            {current.value}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-600 active:bg-slate-100"
            aria-label="Switch"
            data-testid={`${testid}-card-menu`}
          >
            <Menu aria-hidden className="h-5 w-5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
          {items.filter((o) => o.key !== current.key).map((o) => {
            const Icon = o.icon;
            return (
              <DropdownMenuItem
                key={o.key}
                onSelect={() => onPick(o.key)}
                className="gap-2.5 py-2"
                data-testid={`${testid}-card-menu-${o.key}`}
              >
                {Icon && <Icon aria-hidden className="h-4 w-4 shrink-0 text-slate-500" />}
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{o.label}</span>
                {o.value !== undefined && <span className="text-xs font-semibold tabular-nums text-slate-500">{o.value}</span>}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default PhoneBackBar;
