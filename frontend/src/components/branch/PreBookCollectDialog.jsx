import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Check, CheckCircle2, ChevronDown, List, PenLine, Pencil, Trash2, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import {
  addPreBookAdvanceOption, collectPreBook, deletePreBookAdvanceOption, listPreBookAdvanceOptions,
  listStoreItems, renamePreBookAdvanceOption,
} from "@/lib/api";
import { loadSession } from "@/lib/session";
import { consultationItemPrice } from "@/lib/consultationPackages";
import { COLLECT_MODES, CollectField, TenderFields, emptyTender, tenderPayload } from "@/components/branch/CollectTender";
import { ReceiptDialog } from "@/components/ReceiptDialog";
import { ALL_PAYMENT_MODE_LABELS, paymentReference } from "@/lib/receipt";
import { advanceForLabel, preBookConsultOwed, preBookOf, rupees, shortDay } from "@/lib/preBook";

// Pre Book is money handed over today, so every mode that settles now and not Cheque.
const PRE_BOOK_MODES = COLLECT_MODES.filter((m) => m.value !== "cheque");

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const Section = ({ title, children, done }) => (
  <div className={`rounded-[5px] p-3 ${done ? "bg-teal-50/60" : ""}`}>
    <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
      {done && <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />}
      {title}
    </p>
    {children}
  </div>
);

const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
const fail = (e, fallback) => toast.error(e?.response?.data?.detail || fallback);

/**
 * Advance for: Sessions, or Others typed by hand. A typed name is kept on a list shared by
 * every branch, so the next one is picked rather than typed again, and each kept name can be
 * renamed or deleted from the list itself.
 *
 * `value` is { for, note }: an advance for Others carries its name as the note, which is how
 * the server has always stored it. `manual` is the text box Others opens; `typed` is what is
 * in it, read by the popup's Collect too, so a name typed and not yet added still counts.
 */
const AdvanceForPicker = ({ value, onChange, manual, onManual, typed, onTyped }) => {
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name }
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let live = true;
    listPreBookAdvanceOptions().then((rows) => live && setOptions((rows || []).sort(byName))).catch(() => {});
    return () => { live = false; };
  }, []);

  // A click anywhere else closes the list, and any rename left half-typed in it.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setEditing(null); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => { if (manual) inputRef.current?.focus(); }, [manual]);

  const pick = (next, typing = false) => {
    onChange(next);
    onManual(typing);
    onTyped("");
    setOpen(false);
    setEditing(null);
  };

  const addTyped = async () => {
    const name = typed.trim();
    if (!name) { toast.error("Type what the advance is for"); return; }
    const known = options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (known) { pick({ for: "others", note: known.name }); return; }
    setBusy(true);
    try {
      const row = await addPreBookAdvanceOption(name);
      setOptions((list) => [...list, row].sort(byName));
      pick({ for: "others", note: row.name });
    } catch (e) {
      fail(e, "Could not add it");
    }
    setBusy(false);
  };

  const saveEdit = async () => {
    const name = (editing?.name || "").trim();
    if (!name) { toast.error("Type a name"); return; }
    const old = options.find((o) => o.id === editing.id)?.name;
    setBusy(true);
    try {
      const row = await renamePreBookAdvanceOption(editing.id, name);
      setOptions((list) => list.map((o) => (o.id === row.id ? row : o)).sort(byName));
      if (value.for === "others" && value.note === old) onChange({ for: "others", note: row.name });
      setEditing(null);
    } catch (e) {
      fail(e, "Could not rename it");
    }
    setBusy(false);
  };

  const remove = async (o) => {
    if (!window.confirm(`Delete "${o.name}" from the list?`)) return;
    setBusy(true);
    try {
      await deletePreBookAdvanceOption(o.id);
      setOptions((list) => list.filter((x) => x.id !== o.id));
      if (value.for === "others" && value.note === o.name) onChange({ for: "sessions", note: "" });
    } catch (e) {
      fail(e, "Could not delete it");
    }
    setBusy(false);
  };

  if (manual) {
    return (
      <div className="relative">
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }}
          placeholder="Type manually"
          className="h-10 w-full rounded-md border border-slate-300 bg-white pl-3 pr-[4.5rem] text-sm text-slate-900 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
          data-testid="pre-book-advance-typed"
        />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <button
            type="button" onClick={addTyped} disabled={busy}
            title="Add to the list" aria-label="Add to the list"
            className="flex h-7 w-7 items-center justify-center rounded text-teal-600 hover:bg-teal-50 disabled:opacity-50"
            data-testid="pre-book-advance-typed-add"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button" onClick={() => { onManual(false); onTyped(""); setOpen(true); }}
            title="Choose from the list" aria-label="Choose from the list"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-teal-600"
            data-testid="pre-book-advance-typed-list"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  const label = value.for === "sessions" ? "Sessions" : value.note || "Others";
  const row = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-teal-50";
  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-10 w-full items-center justify-between rounded-md border bg-white px-3 text-sm text-slate-900 ${open ? "border-teal-400 ring-1 ring-teal-400" : "border-slate-300"}`}
        data-testid="pre-book-advance-for"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg" data-testid="pre-book-advance-for-list">
          <button type="button" onClick={() => pick({ for: "sessions", note: "" })} className={row} data-testid="pre-book-advance-for-sessions">
            <span className="flex-1">Sessions</span>
            {value.for === "sessions" && <Check className="h-4 w-4 text-teal-600" />}
          </button>
          <button type="button" onClick={() => pick({ for: "others", note: "" }, true)} className={`${row} font-medium text-teal-700`} data-testid="pre-book-advance-for-others">
            <PenLine className="h-3.5 w-3.5" />
            <span className="flex-1">Type manually</span>
          </button>
          {options.length > 0 && <div className="my-1 border-t border-slate-100" />}
          {options.map((o) => (editing?.id === o.id ? (
            <div key={o.id} className="flex items-center gap-1 px-2 py-1">
              <input
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(); } }}
                className="h-8 min-w-0 flex-1 rounded border border-slate-300 px-2 text-sm focus:border-teal-400 focus:outline-none"
                data-testid="pre-book-advance-option-edit-input"
              />
              <button type="button" onClick={saveEdit} disabled={busy} aria-label="Save" className="flex h-7 w-7 items-center justify-center rounded text-teal-600 hover:bg-teal-50 disabled:opacity-50">
                <Check className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setEditing(null)} aria-label="Cancel" className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div key={o.id} className="flex items-center hover:bg-teal-50">
              <button type="button" onClick={() => pick({ for: "others", note: o.name })} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm" data-testid="pre-book-advance-option">
                <span className="flex-1 truncate">{o.name}</span>
                {value.for === "others" && value.note === o.name && <Check className="h-4 w-4 shrink-0 text-teal-600" />}
              </button>
              <button type="button" onClick={() => setEditing({ id: o.id, name: o.name })} disabled={busy} title="Edit" aria-label={`Edit ${o.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-teal-600" data-testid="pre-book-advance-option-edit">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => remove(o)} disabled={busy} title="Delete" aria-label={`Delete ${o.name}`} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-rose-600" data-testid="pre-book-advance-option-delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )))}
        </div>
      )}
    </div>
  );
};

/**
 * The Pre Book popup: what the client paid to hold a later visit.
 *
 * Two parts, entered apart as the branch asked: a Consultation package off Services &
 * Products with what was paid on it (the whole price, or part -- Rs.500 to confirm the
 * booking, the rest on the day), and an Advance for Sessions or for something else. One
 * payment covers both, since the client pays once; each part is still filed as its own
 * transaction, so each one prints its own receipt and finance can trace it.
 *
 * A part already paid is shown, not offered again -- see collect_pre_book.
 */
export const PreBookCollectDialog = ({ lead, branchId, onClose, onCollected }) => {
  const pb = preBookOf(lead) || {};
  const paidConsult = pb.consultation;
  const paidAdvance = pb.advance;
  const mode = lead.appointment_mode || "offline";

  const [items, setItems] = useState({ rows: [], loading: true });
  // The package is the first on the Pre Book shelf; there is no picker any more.
  const [itemId, setItemId] = useState("");
  const [consultAmount, setConsultAmount] = useState("");
  // Set only by "Give Rs.X as discount": the rest of a part payment, written off.
  const [consultDiscount, setConsultDiscount] = useState("");
  const [advanceOn, setAdvanceOn] = useState(!paidAdvance);
  const [advanceFor, setAdvanceFor] = useState("sessions");
  const [advanceNote, setAdvanceNote] = useState("");
  // Others, typed by hand -- see AdvanceForPicker.
  const [advanceManual, setAdvanceManual] = useState(false);
  const [advanceTyped, setAdvanceTyped] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  // One Payment Mode for both parts: the client pays once.
  const [draft, setDraft] = useState({ ...emptyTender });
  const [saving, setSaving] = useState(false);
  // The receipts still to show, one per transaction, after the money is in.
  const [receipts, setReceipts] = useState([]);
  const setD = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Services and Products > Consultations > Pre Book, with this branch's prices -- the
  // shelf kept for this popup alone. By name, so Reconsultation and its neighbours read in
  // the order anyone would look for them.
  useEffect(() => {
    let live = true;
    listStoreItems("pre_book", "consultation", branchId)
      .then((rows) => {
        if (!live) return;
        const list = (rows || [])
          .filter((i) => i.item_type === "consultation")
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setItems({ rows: list, loading: false });
        if (list[0]) {
          setItemId(list[0].id);
          const p = consultationItemPrice(list[0], mode);
          setConsultAmount(p != null ? String(p) : "");
        }
      })
      .catch(() => live && setItems({ rows: [], loading: false }));
    return () => { live = false; };
  }, [branchId, mode]);

  const item = items.rows.find((i) => i.id === itemId) || null;
  const price = item ? consultationItemPrice(item, mode) : null;
  // A blank or zero amount leaves the consultation out of this collection.
  const consultNow = !paidConsult ? Math.max(0, r2(parseFloat(consultAmount))) : 0;
  const consultOff = consultNow > 0 ? Math.max(0, r2(parseFloat(consultDiscount))) : 0;
  const advanceNow = advanceOn && !paidAdvance ? r2(parseFloat(advanceAmount)) : 0;
  // What an advance for Others is for: the name picked, or the one still in the text box.
  const advanceNoteNow = advanceFor === "others" ? (advanceManual ? advanceTyped : advanceNote).trim() : "";
  const total = r2(consultNow + advanceNow);
  // What is left for the visit day: the price, less the discount and what is paid now.
  const consultShort = price != null && consultNow > 0 && consultNow + consultOff < price ? r2(price - consultOff - consultNow) : 0;

  // Escape closes this popup only, never the lead card under it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || receipts.length) return;
      // An open Payment Mode menu takes the Escape itself and closes alone.
      if (e.target?.closest?.('[role="menu"]')) return;
      e.stopPropagation();
      if (!saving) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [saving, onClose, receipts.length]);

  // The rest of a part payment, written off rather than collected on the visit day.
  const shortToDiscount = () => setConsultDiscount(String(r2(consultOff + consultShort)));

  const submit = async () => {
    const payload = { confirmed: true };
    if (consultNow > 0) {
      if (!item) { toast.error("No consultation package yet — add one under Services & Products › Consultations › Pre Book"); return; }
      if (price == null) { toast.error(`${item.name} has no ${mode} price in Services & Products`); return; }
      if (consultOff >= price) { toast.error(`The discount has to be less than ${rupees(price)}`); return; }
      if (consultNow + consultOff > price + 0.009) { toast.error(`More than ${item.name} costs after the discount (${rupees(price - consultOff)}) — put the rest in the Advance`); return; }
      payload.consultation_item_id = item.id;
      payload.consultation_amount = consultNow;
      if (consultOff > 0) payload.consultation_discount = consultOff;
    }
    if (advanceOn && !paidAdvance) {
      if (!(advanceNow > 0)) { toast.error("Enter the advance amount"); return; }
      if (advanceFor === "others" && !advanceNoteNow) { toast.error("Type or pick what the advance is for"); return; }
      payload.advance_for = advanceFor;
      payload.advance_amount = advanceNow;
      if (advanceNoteNow) payload.advance_note = advanceNoteNow;
    }
    if (!payload.consultation_item_id && !payload.advance_amount) { toast.error("Enter the consultation, the advance, or both"); return; }
    // The one mode goes as the top-level fields for the consultation and as advance_payment.
    const tender = tenderPayload(draft);
    if (tender.error) { toast.error(tender.error); return; }
    const consultTender = payload.consultation_item_id ? tender : null;
    const advanceTender = payload.advance_amount ? tender : null;
    if (consultTender) Object.assign(payload, consultTender.payload);
    if (advanceTender) payload.advance_payment = advanceTender.payload;

    setSaving(true);
    let res;
    try {
      res = await collectPreBook(lead.id, payload);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not collect the Pre Book payment");
      setSaving(false);
      return;
    }
    setSaving(false);
    toast.success(`${rupees(total)} collected for Pre Book`);
    // A name typed for Others and collected without pressing Add is kept for next time too.
    // A clash means it is on the list already, which is all this wanted.
    if (payload.advance_for === "others" && advanceManual) addPreBookAdvanceOption(advanceNoteNow).catch(() => {});
    const updated = res.lead || lead;
    onCollected && onCollected(updated);

    // One receipt per transaction, in the order they were taken.
    const now = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const base = {
      kind: "paid",
      dateLabel: now,
      patient: lead.name || "—",
      patientNo: lead.patient_number || "—",
      phone: lead.phone || "—",
      branch: "",
      sessionsCovered: "",
      installments: [],
      discount: null,
      collectedBy: loadSession()?.user?.full_name || "Branch Admin",
      cashCounted: "",
    };
    // How one part was paid, as its receipt prints it.
    const paidBy = (t) => ({
      modeLabel: ALL_PAYMENT_MODE_LABELS[t.payment_mode] || t.payment_mode,
      reference: paymentReference(t),
      isCash: t.payment_mode === "cash",
    });
    const out = [];
    if (res.transaction_ids?.consultation) {
      out.push({
        ...base,
        ...paidBy(consultTender.payload),
        receiptNo: res.transaction_ids.consultation,
        paidFor: "Pre Book — Consultation",
        packageName: item?.name || "",
        amount: consultNow,
        discount: consultOff || null,
        originalAmount: consultShort || consultOff ? price : null,
        balanceDue: consultShort ? `Rs.${consultShort} on the visit day` : "",
      });
    }
    if (res.transaction_ids?.advance) {
      out.push({
        ...base,
        ...paidBy(advanceTender.payload),
        receiptNo: res.transaction_ids.advance,
        paidFor: `Pre Book — Advance (${advanceForLabel({ for: advanceFor, note: advanceNoteNow })})`,
        packageName: "",
        amount: advanceNow,
        originalAmount: null,
        balanceDue: "",
      });
    }
    if (out.length) setReceipts(out);
    else onClose();
  };

  if (receipts.length) {
    return (
      <ReceiptDialog
        receipt={receipts[0]}
        onClose={() => {
          const rest = receipts.slice(1);
          if (rest.length) setReceipts(rest);
          else onClose();
        }}
        testid="pre-book-receipt"
      />
    );
  }

  const nothingLeft = paidConsult && paidAdvance;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      data-testid="pre-book-collect-dialog"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="pre-book-collect-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-[5px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <CalendarClock className="h-5 w-5 shrink-0 text-teal-600" />
            <p id="pre-book-collect-title" className="text-base font-semibold text-slate-800">Pre Book</p>
          </div>
          <button type="button" onClick={() => !saving && onClose()} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="pre-book-collect-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {/* ① The consultation package. */}
          {paidConsult ? (
            <Section title="Consultation" done>
              <p className="text-sm font-semibold text-slate-800">{paidConsult.name} · {rupees(paidConsult.paid)}</p>
              <p className="text-[11px] text-slate-500">
                Paid {shortDay(paidConsult.at)}
                {paidConsult.discount ? ` · ${rupees(paidConsult.discount)} discount` : ""}
                {preBookConsultOwed(paidConsult) > 0 ? ` · ${rupees(preBookConsultOwed(paidConsult))} to collect on the visit day` : ""}
                {paidConsult.applied_at ? " · used on the Consultation Fee" : ""}
              </p>
            </Section>
          ) : (
            <Section title="Consultation">
              <div className="space-y-2">
                <CollectField
                  label="Amount paid now (₹)"
                  type="number"
                  inputMode="decimal"
                  value={consultAmount}
                  // A new amount is a new part payment; its rest is owed until given as discount again.
                  onChange={(e) => { setConsultAmount(e.target.value); setConsultDiscount(""); }}
                  placeholder={price != null ? String(price) : "0"}
                  testid="pre-book-consult-amount"
                />
                {consultShort ? (
                  <div className="flex text-[11px]">
                    <button
                      type="button"
                      onClick={shortToDiscount}
                      className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-semibold text-amber-700 hover:bg-amber-100"
                      data-testid="pre-book-consult-short-to-discount"
                    >
                      Give {rupees(consultShort)} as discount
                    </button>
                  </div>
                ) : consultOff > 0 && consultNow > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span>{rupees(consultOff)} discount — nothing left to collect on the visit day.</span>
                    <button
                      type="button"
                      onClick={() => setConsultDiscount("")}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50"
                      data-testid="pre-book-consult-discount-undo"
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">The whole price, or less to confirm the booking (the rest on the visit day).</p>
                )}
              </div>
            </Section>
          )}

          {/* ② The advance. */}
          {paidAdvance ? (
            <Section title="Advance" done>
              <p className="text-sm font-semibold text-slate-800">{advanceForLabel(paidAdvance)} · {rupees(paidAdvance.amount)}</p>
              <p className="text-[11px] text-slate-500">
                Paid {shortDay(paidAdvance.at)}{paidAdvance.applied_at ? " · used on the Treatment Fee" : ""}
              </p>
            </Section>
          ) : (
            <Section title="Advance">
              <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={advanceOn} onChange={(e) => setAdvanceOn(e.target.checked)} data-testid="pre-book-advance-on" />
                Collect an advance
              </label>
              {advanceOn && (
                <div className="space-y-2">
                  <AdvanceForPicker
                    value={{ for: advanceFor, note: advanceNote }}
                    onChange={(v) => { setAdvanceFor(v.for); setAdvanceNote(v.note); }}
                    manual={advanceManual}
                    onManual={setAdvanceManual}
                    typed={advanceTyped}
                    onTyped={setAdvanceTyped}
                  />
                  <CollectField
                    label="Advance amount (₹)"
                    type="number"
                    inputMode="decimal"
                    value={advanceAmount}
                    onChange={(e) => setAdvanceAmount(e.target.value)}
                    placeholder="0"
                    testid="pre-book-advance-amount"
                  />
                </div>
              )}
            </Section>
          )}

          {/* ③ How the client paid, for both parts. */}
          {!nothingLeft && (
            <div className="px-3">
              <TenderFields draft={draft} setDraft={setD} testid="pre-book" modes={PRE_BOOK_MODES} dropdown />
            </div>
          )}

          {nothingLeft && (
            <p className="text-center text-xs text-slate-500">Both parts are paid. A wrong payment is deleted from finance and collected again.</p>
          )}
        </div>

        {!nothingLeft && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
            <button
              type="button" onClick={submit} disabled={saving || !(total > 0)}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
              data-testid="pre-book-collect"
            >
              {saving ? "Collecting..." : `Collect ${rupees(total)}`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default PreBookCollectDialog;
