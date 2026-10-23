import { useState } from "react";
import { Headset, Hospital, Users } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Lead Control — who works this branch's leads first, Pre-Sales or the Branch Admin.
 *
 * The setting lives on the branch, so the same switch appears wherever a branch is in
 * reach: the Branch Detail header, the Edit Branch dialog, and each Marketing Source
 * card (a source is tagged to a branch, and that is where leads actually arrive). All
 * three write the same field, which is why they are one component rather than three
 * lookalikes that drift apart.
 *
 * Not stamped on leads: flipping it rehomes the leads already in the pipeline as well
 * as the next import. See backend/lead_control.py for why.
 *
 * @param confirm  ask before switching. On for the two places that save on click —
 *                 moving a branch's whole book between two desks is not something to
 *                 do by brushing a control. Off inside the Edit dialog, where nothing
 *                 happens until Save Changes and a confirm would be asking about a
 *                 change that has not been made yet.
 */

export const PRE_SALES = "pre_sales";
export const BRANCH_ADMIN = "branch_admin";
export const BOTH = "both";

const OPTIONS = [
  { value: PRE_SALES, label: "Pre Sales", icon: Headset },
  { value: BOTH, label: "Both", icon: Users },
  { value: BRANCH_ADMIN, label: "Branch Admin", icon: Hospital },
];

// An unset branch reads as Pre-Sales — the behaviour every branch had before this
// existed. Mirrors normalize() in backend/lead_control.py.
export const normalizeLeadControl = (v) => {
  if (v === BRANCH_ADMIN) return BRANCH_ADMIN;
  if (v === BOTH) return BOTH;
  return PRE_SALES;
};

export const LeadControlSwitch = ({
  value,
  onChange,
  disabled = false,
  busy = false,
  size = "md",
  testid = "lead-control",
  confirm = false,
  branchName = "",
  preSalesMembers = null,
}) => {
  const current = normalizeLeadControl(value);
  const [pending, setPending] = useState(null);
  const sm = size === "sm";

  const choose = (next) => {
    if (next === current || disabled || busy) return;
    if (confirm) { setPending(next); return; }
    onChange(next);
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Lead Control"
        title="Lead Control — who works this branch's leads first"
        className={`inline-flex rounded-lg bg-slate-100 p-1 ${sm ? "gap-0.5" : "gap-1"} ${disabled || busy ? "opacity-50" : ""}`}
        data-testid={testid}
      >
        {OPTIONS.map((o) => {
          const Icon = o.icon;
          const active = current === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || busy}
              onClick={() => choose(o.value)}
              // Content-sized rather than flex-1: the control now sits in a header, a
              // dialog field and a card, and a basis-0 child inside a shrink-to-fit
              // parent is the kind of width that resolves differently in each.
              className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold transition ${
                sm ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
              } ${
                active
                  ? "bg-sky-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-white hover:text-slate-800"
              } ${disabled || busy ? "cursor-not-allowed" : ""}`}
              data-testid={`${testid}-${o.value}`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>

      {pending && (
        <LeadControlConfirm
          from={current}
          next={pending}
          branchName={branchName}
          preSalesMembers={preSalesMembers}
          onCancel={() => setPending(null)}
          // The rep is passed alongside the new setting rather than saved separately, so a
          // hand-back and the person it went to are one act that either happens or doesn't.
          onConfirm={(assigneeId) => { const chosen = pending; setPending(null); onChange(chosen, assigneeId); }}
        />
      )}
    </>
  );
};

/**
 * The confirm step. Spells out the consequence rather than asking "are you sure" — the
 * part people get wrong is that this moves the leads already in the pipeline, not just
 * the next import, and a dialog that does not say so is not worth showing.
 */
const LeadControlConfirm = ({ from, next, branchName, preSalesMembers, onCancel, onConfirm }) => {
  const toBranch = next === BRANCH_ADMIN;
  const toBoth = next === BOTH;
  const toPreSales = next === PRE_SALES;
  const who = branchName ? `${branchName}'s` : "This branch's";
  const Icon = toBranch ? Hospital : toBoth ? Users : Headset;
  const [assigneeId, setAssigneeId] = useState("");
  // Asked whenever the branch's backlog re-enters the Pre-Sales pipeline from Branch Admin
  // control — it arrives all at once with no rep on it.
  const reentersPreSales = toPreSales || (toBoth && from === BRANCH_ADMIN);
  const asksForAssignee = reentersPreSales && Array.isArray(preSalesMembers);
  const noMembers = asksForAssignee && preSalesMembers.length === 0;
  const blocked = asksForAssignee && !assigneeId;

  const iconBg = toBranch ? "bg-sky-100" : toBoth ? "bg-violet-100" : "bg-emerald-100";
  const iconText = toBranch ? "text-sky-600" : toBoth ? "text-violet-600" : "text-emerald-600";
  const btnClass = toBranch ? "bg-sky-600 hover:bg-sky-700" : toBoth ? "bg-violet-600 hover:bg-violet-700" : "bg-emerald-600 hover:bg-emerald-700";
  const btnLabel = toBranch ? "Yes, hand over" : toBoth ? "Yes, share both" : "Yes, return to Pre-Sales";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="lead-control-confirm">
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${iconBg}`}>
            <Icon className={`h-5 w-5 ${iconText}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900" data-testid="lead-control-confirm-title">
              {toBranch
                ? "Hand these leads to the Branch Admin?"
                : toBoth
                ? "Share these leads between both desks?"
                : "Return these leads to Pre-Sales?"}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              {toBranch ? (
                <>
                  {who} leads leave the Pre-Sales pipeline — <b className="text-slate-800">the ones already in it as well as new arrivals</b> — and are worked on the branch's own Pre Sales tab instead. No Pre-Sales rep is assigned to them.
                </>
              ) : toBoth ? (
                <>
                  {who} leads will be visible to <b className="text-slate-800">both the Pre-Sales desk and the Branch Admin</b>, including the ones already in the pipeline. Both desks can work them simultaneously.
                </>
              ) : (
                <>
                  {who} leads go back into the Pre-Sales pipeline, <b className="text-slate-800">including the ones the branch is working right now</b>. The branch's Pre Sales tab disappears and new leads are shared across the Pre-Sales team again.
                </>
              )}
            </p>
            <p className="mt-2 text-[11px] text-slate-400">
              Leads with no branch yet always stay with Pre-Sales. You can switch back at any time.
            </p>
          </div>
        </div>

        {/* Who picks the book up. Asked rather than left to round-robin because these leads
            are arriving all at once and with no rep on them at all — the branch was working
            them itself until a moment ago. */}
        {asksForAssignee && (
          <div className="space-y-1.5">
            <label htmlFor="lead-control-assignee" className="block text-xs font-semibold text-slate-700">
              Hand these leads to
            </label>
            {noMembers ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800" data-testid="lead-control-no-members">
                No Pre-Sales member is attached to {branchName || "this branch"} yet. Add one in HR Admin — give a Pre-Sales user this branch — then switch.
              </p>
            ) : (
              <select
                id="lead-control-assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                data-testid="lead-control-assignee-select"
              >
                <option value="">Select a Pre-Sales member…</option>
                {preSalesMembers.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel} data-testid="lead-control-confirm-cancel">Cancel</Button>
          <Button
            onClick={() => onConfirm(assigneeId || null)}
            disabled={blocked}
            className={btnClass}
            data-testid="lead-control-confirm-ok"
          >
            {btnLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default LeadControlSwitch;
