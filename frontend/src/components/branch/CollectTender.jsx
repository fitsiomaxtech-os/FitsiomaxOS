import { useEffect, useState } from "react";
import { Banknote, ChevronDown, CreditCard, FileText, Landmark, Smartphone } from "lucide-react";
import { useShownPaymentModes } from "@/lib/paymentModes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// How one collection was paid, as the Collect popups ask it: the mode, and the reference
// each mode is traced by. Lifted out of ClientHistoryModal when the Old Client Instalment
// form needed the same five buttons and the same fields -- a second copy is a second set of
// rules for what a card or a transfer must carry, and the server applies one (_tender in
// routers/v3_finance.py).

// The same modes, colours and mode-specific fields the Consultations board collects with —
// a payment recorded from here has to be indistinguishable from one recorded there, or
// Accountant Manage ends up with two grades of record.
export const COLLECT_MODES = [
  { value: "cash", label: "Cash", classes: "border-emerald-300 bg-emerald-50 text-emerald-700", active: "border-emerald-500 bg-emerald-600 text-white" },
  { value: "upi", label: "UPI", classes: "border-sky-300 bg-sky-50 text-sky-700", active: "border-sky-500 bg-sky-600 text-white" },
  { value: "card", label: "Card", classes: "border-violet-300 bg-violet-50 text-violet-700", active: "border-violet-500 bg-violet-600 text-white" },
  { value: "account_transfer", label: "Account Transfer", classes: "border-cyan-300 bg-cyan-50 text-cyan-700", active: "border-cyan-500 bg-cyan-600 text-white" },
  { value: "cheque", label: "Cheque", classes: "border-amber-300 bg-amber-50 text-amber-700", active: "border-amber-500 bg-amber-600 text-white" },
];

export const emptyTender = {
  payment_mode: "cash",
  upi_transaction_id: "",
  card_transaction_id: "",
  account_number: "", account_holder_name: "", bank_name: "", ifsc_code: "",
  cheque_number: "", transfer_reference: "",
};

// `compact` is the tighter size the Old Client Instalment form uses to fit one screen.
export const CollectField = ({ label, value, onChange, placeholder, testid, inputMode, type, max, compact = false }) => (
  <label className="block">
    <span className={`${compact ? "mb-0.5" : "mb-1"} block text-xs font-semibold text-slate-700`}>{label}</span>
    <input
      type={type}
      max={max}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      inputMode={inputMode}
      className={`${compact ? "h-9" : "h-10"} w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400`}
      data-testid={testid}
    />
  </label>
);

/**
 * The mode as the server wants it, with its references, or what is missing. Checked here as
 * well as on the server so a popup keeps what was typed -- a round trip that fails would
 * otherwise send the desk back to an empty form.
 */
export const tenderPayload = (draft) => {
  const mode = draft.payment_mode;
  const payload = { payment_mode: mode };
  if (mode === "upi") {
    payload.upi_transaction_id = draft.upi_transaction_id.trim();
  } else if (mode === "card") {
    // The terminal's transaction id, and nothing else — the desk cannot read an account
    // number or an IFSC off a card, so asking for them only ever got them invented.
    if (!draft.card_transaction_id.trim()) return { error: "Card Transaction ID is required" };
    payload.card_transaction_id = draft.card_transaction_id.trim();
  } else if (mode === "account_transfer") {
    if (!draft.account_number.trim() || !draft.account_holder_name.trim() || !draft.bank_name.trim() || !draft.ifsc_code.trim()) {
      return { error: "Account Number, Account Holder Name, Bank Name and IFSC Code are required" };
    }
    if (!draft.transfer_reference.trim()) return { error: "Reference / UTR No. is required for an Account Transfer" };
    payload.account_number = draft.account_number.trim();
    payload.account_holder_name = draft.account_holder_name.trim();
    payload.bank_name = draft.bank_name.trim();
    payload.ifsc_code = draft.ifsc_code.trim();
    payload.transfer_reference = draft.transfer_reference.trim();
  } else if (mode === "cheque") {
    if (!draft.bank_name.trim() || !draft.cheque_number.trim()) return { error: "Bank Name and Cheque Number are required" };
    payload.bank_name = draft.bank_name.trim();
    payload.cheque_number = draft.cheque_number.trim();
  }
  return { payload };
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * A discount on a balance being collected -- the next installment of a part-paid fee, or
 * anything else that is owed. Rupees or a percentage of what is due, either way round, and
 * the net that is left to collect spelled out under it.
 *
 * `onChange` is handed `{ discount, amount }`: the amount follows the discount while it is
 * still sitting on the net payable, the rule the fee popups on the Consultations board use
 * -- an amount already typed short is a part payment somebody chose, and agreeing a
 * discount is no reason to quietly collect the rest of it.
 */
export const BalanceDiscount = ({ due, discount, amount, onChange, testid = "balance", compact = false }) => {
  const owed = Number(due) || 0;
  const off = Math.max(0, parseFloat(discount) || 0);
  const net = r2(owed - off);
  const tooBig = owed > 0 && off >= owed;
  // Typed by whoever is at the desk while they type it, and re-derived from the rupees
  // whenever those are what changed.
  const [pctText, setPctText] = useState(() => (owed > 0 && off > 0 ? String(r2((off / owed) * 100)) : ""));

  const apply = (raw) => {
    const next = Math.max(0, parseFloat(raw) || 0);
    const amt = parseFloat(amount);
    const onNet = !Number.isFinite(amt) || Math.abs(amt - net) < 0.01;
    onChange({ discount: raw, ...(onNet ? { amount: String(r2(owed - next)) } : {}) });
  };
  if (!(owed > 0)) return null;
  const box = `${compact ? "h-9" : "h-10"} w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400`;

  return (
    <div className="space-y-2" data-testid={`${testid}-discount`}>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-700">Discount %</span>
          <input
            type="number" min="0" max="100" inputMode="decimal" placeholder="0"
            value={pctText}
            onChange={(e) => {
              setPctText(e.target.value);
              const p = parseFloat(e.target.value);
              apply(Number.isFinite(p) && p > 0 ? String(r2((owed * p) / 100)) : "");
            }}
            className={box}
            data-testid={`${testid}-discount-pct`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-700">Discount (₹)</span>
          <input
            type="number" min="0" inputMode="decimal" placeholder="0"
            value={discount ?? ""}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setPctText(Number.isFinite(v) && v > 0 ? String(r2((v / owed) * 100)) : "");
              apply(e.target.value);
            }}
            className={box}
            data-testid={`${testid}-discount-rs`}
          />
        </label>
      </div>
      {off > 0 && !tooBig && (
        <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800" data-testid={`${testid}-net-payable`}>
          <span>Net Payable <span className="opacity-70">(Rs.{owed.toLocaleString("en-IN")} less Rs.{off.toLocaleString("en-IN")})</span></span>
          <span className="font-semibold">Rs.{net.toLocaleString("en-IN")}</span>
        </div>
      )}
      {tooBig && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-800" data-testid={`${testid}-discount-too-big`}>
          The discount has to be less than the Rs.{owed.toLocaleString("en-IN")} due.
        </div>
      )}
    </div>
  );
};

const MODE_ICONS = { cash: Banknote, upi: Smartphone, card: CreditCard, account_transfer: Landmark, cheque: FileText };

// The mode as a menu in the Windows 11 manner: a frosted panel, rounded rows with the mode's
// icon, and a dot by the one picked. It floats on its own layer (Radix, portalled to the page,
// as the Branch Leads stage menu is), so the popup it sits in can neither clip nor scroll it,
// and it opens the same way: fading in, growing from 95% and sliding down out of its box. It
// flips above the box when there is no room below. Only as wide as its rows, as a Windows
// menu is, rather than the width of its box. Arrow keys move through it, Enter picks.
const ModeDropdown = ({ value, onChange, modes, compact, testid }) => {
  const current = modes.find((m) => m.value === value);
  const CurrentIcon = MODE_ICONS[value];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`group flex ${compact ? "h-9" : "h-10"} w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition hover:border-slate-400 focus-visible:border-teal-400 data-[state=open]:border-teal-400 data-[state=open]:ring-1 data-[state=open]:ring-teal-400`}
          data-testid={`${testid}-mode`}
        >
          {CurrentIcon && <CurrentIcon className="h-4 w-4 shrink-0 text-teal-600" />}
          <span className="flex-1 truncate text-left">{current?.label || "Pick a mode"}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      {/* Above the Collect popups, which sit at z-[70]. */}
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="z-[80] w-max min-w-[11rem] rounded-lg border-black/[0.06] bg-white/85 p-1 text-slate-800 shadow-[0_8px_28px_rgba(15,23,42,0.16)] backdrop-blur-xl duration-150"
        data-testid={`${testid}-mode-list`}
      >
        {modes.map((m) => {
          const Icon = MODE_ICONS[m.value];
          const on = m.value === value;
          return (
            <DropdownMenuItem
              key={m.value}
              onSelect={() => onChange(m.value)}
              className="h-9 cursor-pointer gap-2.5 rounded-md px-2 text-sm text-slate-800 focus:bg-slate-900/[0.06] focus:text-slate-800"
              data-testid={`${testid}-mode-${m.value}`}
            >
              <span className="flex w-3 shrink-0 justify-center">
                {on && <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />}
              </span>
              {Icon && <Icon className={`h-4 w-4 shrink-0 ${on ? "text-teal-600" : "text-slate-500"}`} />}
              <span className={`flex-1 truncate ${on ? "font-medium" : ""}`}>{m.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The five mode buttons and, under them, the fields the picked one is traced by.
 *  `modes` narrows the buttons for a collection that cannot take every mode -- Pre Book is
 *  money in hand, so it leaves Cheque off. */
// `dropdown` asks the mode as a dropdown rather than a row of buttons -- the Pre Book popup's way.
export const TenderFields = ({ draft, setDraft, testid, compact = false, modes: allModes = COLLECT_MODES, dropdown = false }) => {
  // Less any mode hidden in Developer Access. A draft sitting on a hidden one (every popup
  // opens on Cash) moves to the first mode still shown, so nothing is sent in a mode the
  // desk can no longer see.
  const modes = useShownPaymentModes(allModes);
  const pickedShown = modes.some((m) => m.value === draft.payment_mode);
  const firstShown = modes[0]?.value;
  useEffect(() => {
    if (!pickedShown && firstShown) setDraft({ payment_mode: firstShown });
  }, [pickedShown, firstShown, setDraft]);

  return (
  <>
    <div>
      <span className={`${compact ? "mb-0.5" : "mb-1"} block text-xs font-semibold text-slate-700`}>Payment Mode</span>
      {dropdown ? (
        <ModeDropdown value={draft.payment_mode} onChange={(v) => setDraft({ payment_mode: v })} modes={modes} compact={compact} testid={testid} />
      ) : (
      <div className="grid grid-cols-3 gap-1.5">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setDraft({ payment_mode: m.value })}
            className={`rounded-md border px-2 ${compact ? "py-1.5" : "py-2"} text-xs font-semibold transition ${draft.payment_mode === m.value ? m.active : m.classes}`}
            data-testid={`${testid}-mode-${m.value}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      )}
    </div>

    {draft.payment_mode === "upi" && (
      <div className="space-y-3 rounded-lg border border-sky-100 bg-sky-50/50 p-3">
        <CollectField label="UPI Transaction ID" value={draft.upi_transaction_id} onChange={(e) => setDraft({ upi_transaction_id: e.target.value })} placeholder="e.g. 428301947281" compact={compact} testid={`${testid}-upi-txn`} />
      </div>
    )}

    {draft.payment_mode === "card" && (
      <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/50 p-3">
        <CollectField label="Transaction ID *" value={draft.card_transaction_id} onChange={(e) => setDraft({ card_transaction_id: e.target.value })} placeholder="From the card terminal slip" compact={compact} testid={`${testid}-card-txn`} />
      </div>
    )}

    {draft.payment_mode === "account_transfer" && (
      <div className="space-y-3 rounded-lg border border-cyan-100 bg-cyan-50/50 p-3">
        <CollectField label="Account Number *" value={draft.account_number} onChange={(e) => setDraft({ account_number: e.target.value })} placeholder="Only the last 4 digits are stored" compact={compact} testid={`${testid}-transfer-account-number`} />
        <CollectField label="Account Holder Name *" value={draft.account_holder_name} onChange={(e) => setDraft({ account_holder_name: e.target.value })} placeholder="Name on the account" compact={compact} testid={`${testid}-transfer-account-holder`} />
        <CollectField label="Bank Name *" value={draft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" compact={compact} testid={`${testid}-transfer-bank`} />
        <CollectField label="IFSC Code *" value={draft.ifsc_code} onChange={(e) => setDraft({ ifsc_code: e.target.value })} placeholder="e.g. HDFC0001234" compact={compact} testid={`${testid}-transfer-ifsc`} />
        <CollectField label="Reference / UTR No. *" value={draft.transfer_reference} onChange={(e) => setDraft({ transfer_reference: e.target.value })} placeholder="e.g. 302411223344" compact={compact} testid={`${testid}-transfer-reference`} />
      </div>
    )}

    {draft.payment_mode === "cheque" && (
      <div className="space-y-3 rounded-lg border border-amber-100 bg-amber-50/50 p-3">
        <CollectField label="Bank Name *" value={draft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" compact={compact} testid={`${testid}-cheque-bank`} />
        <CollectField label="Cheque Number *" value={draft.cheque_number} onChange={(e) => setDraft({ cheque_number: e.target.value })} placeholder="e.g. 004512" compact={compact} testid={`${testid}-cheque-number`} />
      </div>
    )}
  </>
);
};
