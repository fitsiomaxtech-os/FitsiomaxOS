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

export const CollectField = ({ label, value, onChange, placeholder, testid, inputMode, type, max }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-semibold text-slate-700">{label}</span>
    <input
      type={type}
      max={max}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      inputMode={inputMode}
      className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
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

/** The five mode buttons and, under them, the fields the picked one is traced by. */
export const TenderFields = ({ draft, setDraft, testid }) => (
  <>
    <div>
      <span className="mb-1 block text-xs font-semibold text-slate-700">Payment Mode</span>
      <div className="grid grid-cols-3 gap-1.5">
        {COLLECT_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setDraft({ payment_mode: m.value })}
            className={`rounded-md border px-2 py-2 text-xs font-semibold transition ${draft.payment_mode === m.value ? m.active : m.classes}`}
            data-testid={`${testid}-mode-${m.value}`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>

    {draft.payment_mode === "upi" && (
      <div className="space-y-3 rounded-lg border border-sky-100 bg-sky-50/50 p-3">
        <CollectField label="UPI Transaction ID" value={draft.upi_transaction_id} onChange={(e) => setDraft({ upi_transaction_id: e.target.value })} placeholder="e.g. 428301947281" testid={`${testid}-upi-txn`} />
      </div>
    )}

    {draft.payment_mode === "card" && (
      <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/50 p-3">
        <CollectField label="Transaction ID *" value={draft.card_transaction_id} onChange={(e) => setDraft({ card_transaction_id: e.target.value })} placeholder="From the card terminal slip" testid={`${testid}-card-txn`} />
      </div>
    )}

    {draft.payment_mode === "account_transfer" && (
      <div className="space-y-3 rounded-lg border border-cyan-100 bg-cyan-50/50 p-3">
        <CollectField label="Account Number *" value={draft.account_number} onChange={(e) => setDraft({ account_number: e.target.value })} placeholder="Only the last 4 digits are stored" testid={`${testid}-transfer-account-number`} />
        <CollectField label="Account Holder Name *" value={draft.account_holder_name} onChange={(e) => setDraft({ account_holder_name: e.target.value })} placeholder="Name on the account" testid={`${testid}-transfer-account-holder`} />
        <CollectField label="Bank Name *" value={draft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" testid={`${testid}-transfer-bank`} />
        <CollectField label="IFSC Code *" value={draft.ifsc_code} onChange={(e) => setDraft({ ifsc_code: e.target.value })} placeholder="e.g. HDFC0001234" testid={`${testid}-transfer-ifsc`} />
        <CollectField label="Reference / UTR No. *" value={draft.transfer_reference} onChange={(e) => setDraft({ transfer_reference: e.target.value })} placeholder="e.g. 302411223344" testid={`${testid}-transfer-reference`} />
      </div>
    )}

    {draft.payment_mode === "cheque" && (
      <div className="space-y-3 rounded-lg border border-amber-100 bg-amber-50/50 p-3">
        <CollectField label="Bank Name *" value={draft.bank_name} onChange={(e) => setDraft({ bank_name: e.target.value })} placeholder="e.g. HDFC Bank" testid={`${testid}-cheque-bank`} />
        <CollectField label="Cheque Number *" value={draft.cheque_number} onChange={(e) => setDraft({ cheque_number: e.target.value })} placeholder="e.g. 004512" testid={`${testid}-cheque-number`} />
      </div>
    )}
  </>
);
