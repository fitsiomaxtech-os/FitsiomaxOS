import { useMemo, useState } from "react";
import { Building2, Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * BranchFilterPopover
 *
 * The branch picker Operations used to spell out as a full row of pills, folded into a
 * single trigger + dialog so the row it lived on is free for the actions that belong
 * beside it (Branch Transfer, Branch Manager).
 *
 * The dialog *is* the picker — the branches are rows you click, not a <select> inside it.
 * A dropdown here meant opening a popup to open a popup, and the list is short enough to
 * show whole.
 *
 * Wears the same clothes as DateFilterPopover's `centered` variant — milk-white panel
 * (#FDFCF8 on #EFEAE0), amber for the active state — because to the person using it this
 * is the same kind of control as the date filter sitting elsewhere on the OS, and two
 * filters that behave alike should not look like they came from different products.
 *
 * Props:
 *  - branches: [{ id, branch_name, vertical }]
 *  - selectedId / onSelect: controlled selection
 *  - testid: string (optional)
 *  - fill: the trigger stretches to the width it is given and its label truncates inside
 *    it, rather than sizing to the label -- for a phone row it shares with another picker
 *    (Operations).
 */

// Same helper OperationsBoard.jsx, BranchManagementBoard.jsx and PreSalesCRM.jsx each
// already carry their own copy of.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

export const BranchFilterPopover = ({ branches = [], selectedId, onSelect, testid = "branch-filter", fill = false }) => {
  const [open, setOpen] = useState(false);

  // Offline branches first (alphabetical), online ones trail — the order the pill row
  // used and the order Branch Wise already sorts in, so a branch sits where it always has.
  const sorted = useMemo(() => {
    return [...(branches || [])].sort((a, b) => {
      const onlineDiff = Number(isOnlineVertical(a.vertical)) - Number(isOnlineVertical(b.vertical));
      if (onlineDiff !== 0) return onlineDiff;
      return (a.branch_name || "").localeCompare(b.branch_name || "");
    });
  }, [branches]);

  // Grouped rather than one flat list: an online vertical is not a place you can walk
  // into, and reading the two apart matters more the longer the list gets.
  const offline = sorted.filter((b) => !isOnlineVertical(b.vertical));
  const online = sorted.filter((b) => isOnlineVertical(b.vertical));
  const groups = [
    { key: "branches", label: "Branches", items: offline },
    { key: "online", label: "Online", items: online },
  ];
  const bothGroups = offline.length > 0 && online.length > 0;

  const selected = sorted.find((b) => b.id === selectedId);
  const activeLabel = selected?.branch_name || "Branch Filter";

  // Picking is the whole job here — there is nothing else in the dialog to fill in, so a
  // separate Apply would only be a second click on a decision already made.
  const pick = (id) => {
    if (id) onSelect(id);
    setOpen(false);
  };

  return (
    <div className={fill ? "flex w-full min-w-0 items-center" : "inline-flex items-center"}>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        title={activeLabel}
        aria-label={`Branch filter: ${activeLabel}`}
        className={`h-9 gap-2 px-3 ${fill ? "w-full min-w-0" : ""} ${selected ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100" : ""}`}
        data-testid={`${testid}-btn`}
      >
        <Building2 className="h-4 w-4" />
        <span className={fill ? "min-w-0 flex-1 truncate text-left" : "max-w-[180px] truncate"}>{activeLabel}</span>
        <ChevronDown className="h-4 w-4 opacity-70" />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          data-testid={`${testid}-modal`}
        >
          <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[#EFEAE0] bg-[#FDFCF8] shadow-2xl" data-testid={`${testid}-panel`}>
            <div className="flex shrink-0 items-center justify-between border-b border-[#EFEAE0] px-4 py-3">
              <p className="text-sm font-bold text-slate-800">Filter by Branch</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-[#F3EFE6] hover:text-slate-600"
                title="Close"
                aria-label="Close"
                data-testid={`${testid}-exit`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* A list, not a dropdown. The <select> put a second popup on top of the one
                the person had just opened — two layers of chrome to answer "which
                branch", when the whole list fits in the dialog the click already cost
                them. Picking a row is the answer and the close, in one. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid={`${testid}-list`}>
              {groups.map((g) => (
                g.items.length > 0 && (
                  <div key={g.key} className="mb-1 last:mb-0" data-testid={`${testid}-group-${g.key}`}>
                    {/* The heading only earns its line when there is another group to
                        tell this one apart from. */}
                    {bothGroups && (
                      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.label}</p>
                    )}
                    {g.items.map((b) => {
                      const on = b.id === selectedId;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => pick(b.id)}
                          className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
                            on ? "bg-amber-100 font-semibold text-amber-800" : "text-slate-700 hover:bg-[#F3EFE6]"
                          }`}
                          data-testid={`${testid}-option-${b.id}`}
                        >
                          <Building2 className={`h-4 w-4 shrink-0 ${on ? "text-amber-700" : "text-slate-400"}`} />
                          <span className="min-w-0 flex-1 truncate">{b.branch_name}</span>
                          {on && <Check className="h-4 w-4 shrink-0 text-amber-700" />}
                        </button>
                      );
                    })}
                  </div>
                )
              ))}
              {sorted.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-slate-400" data-testid={`${testid}-empty`}>No branches yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BranchFilterPopover;
