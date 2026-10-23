import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, CheckCircle2, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { collectPreBook, listStoreItems } from "@/lib/api";
import { loadSession } from "@/lib/session";
import { consultationItemPrice } from "@/lib/consultationPackages";
import { COLLECT_MODES, CollectField, TenderFields, emptyTender, tenderPayload } from "@/components/branch/CollectTender";
import { ReceiptDialog } from "@/components/ReceiptDialog";
import { ALL_PAYMENT_MODE_LABELS, paymentReference } from "@/lib/receipt";
import { advanceForLabel, preBookOf, rupees, shortDay } from "@/lib/preBook";

// Pre Book is money handed over today, so every mode that settles now and not Cheque.
const PRE_BOOK_MODES = COLLECT_MODES.filter((m) => m.value !== "cheque");

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const Section = ({ title, children, done }) => (
  <div className={`rounded-xl border p-3 ${done ? "border-teal-200 bg-teal-50/60" : "border-slate-200"}`}>
    <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
      {done && <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />}
      {title}
    </p>
    {children}
  </div>
);

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
  const [consultOn, setConsultOn] = useState(!paidConsult);
  const [itemId, setItemId] = useState("");
  const [consultAmount, setConsultAmount] = useState("");
  const [advanceOn, setAdvanceOn] = useState(!paidAdvance);
  const [advanceFor, setAdvanceFor] = useState("sessions");
  const [advanceNote, setAdvanceNote] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [draft, setDraft] = useState({ ...emptyTender });
  const [confirmed, setConfirmed] = useState(false);
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
  const consultNow = consultOn && !paidConsult ? r2(parseFloat(consultAmount)) : 0;
  const advanceNow = advanceOn && !paidAdvance ? r2(parseFloat(advanceAmount)) : 0;
  const total = r2(consultNow + advanceNow);
  const consultShort = price != null && consultNow > 0 && consultNow < price ? r2(price - consultNow) : 0;

  // Escape closes this popup only, never the lead card under it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || receipts.length) return;
      e.stopPropagation();
      if (!saving) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [saving, onClose, receipts.length]);

  const pickItem = (id) => {
    setItemId(id);
    const next = items.rows.find((i) => i.id === id);
    const p = next ? consultationItemPrice(next, mode) : null;
    setConsultAmount(p != null ? String(p) : "");
  };

  const submit = async () => {
    const payload = { confirmed: true };
    if (consultOn && !paidConsult) {
      if (!item) { toast.error("Pick a consultation package"); return; }
      if (price == null) { toast.error(`${item.name} has no ${mode} price in Services & Products`); return; }
      if (!(consultNow > 0)) { toast.error("Enter the consultation amount"); return; }
      if (consultNow > price + 0.009) { toast.error(`More than ${item.name} costs (${rupees(price)}) — put the rest in the Advance`); return; }
      payload.consultation_item_id = item.id;
      payload.consultation_amount = consultNow;
    }
    if (advanceOn && !paidAdvance) {
      if (!(advanceNow > 0)) { toast.error("Enter the advance amount"); return; }
      if (advanceFor === "others" && !advanceNote.trim()) { toast.error("Say what the advance is for"); return; }
      payload.advance_for = advanceFor;
      payload.advance_amount = advanceNow;
      if (advanceNote.trim()) payload.advance_note = advanceNote.trim();
    }
    if (!payload.consultation_item_id && !payload.advance_amount) { toast.error("Enter the consultation, the advance, or both"); return; }
    if (!confirmed) { toast.error(`Tick that ${rupees(total)} has been received`); return; }
    const tender = tenderPayload(draft);
    if (tender.error) { toast.error(tender.error); return; }

    setSaving(true);
    let res;
    try {
      res = await collectPreBook(lead.id, { ...payload, ...tender.payload });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not collect the Pre Book payment");
      setSaving(false);
      return;
    }
    setSaving(false);
    toast.success(`${rupees(total)} collected for Pre Book`);
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
      modeLabel: ALL_PAYMENT_MODE_LABELS[tender.payload.payment_mode] || tender.payload.payment_mode,
      reference: paymentReference(tender.payload),
      collectedBy: loadSession()?.user?.full_name || "Branch Admin",
      isCash: tender.payload.payment_mode === "cash",
      cashCounted: "",
    };
    const out = [];
    if (res.transaction_ids?.consultation) {
      out.push({
        ...base,
        receiptNo: res.transaction_ids.consultation,
        paidFor: "Pre Book — Consultation",
        packageName: item?.name || "",
        amount: consultNow,
        originalAmount: consultShort ? price : null,
        balanceDue: consultShort ? `Rs.${consultShort} on the visit day` : "",
      });
    }
    if (res.transaction_ids?.advance) {
      out.push({
        ...base,
        receiptNo: res.transaction_ids.advance,
        paidFor: `Pre Book — Advance (${advanceForLabel({ for: advanceFor, note: advanceNote.trim() })})`,
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
      <div role="dialog" aria-modal="true" aria-labelledby="pre-book-collect-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-teal-600 px-5 py-3.5 text-white">
          <div className="flex min-w-0 items-center gap-2">
            <CalendarClock className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <p id="pre-book-collect-title" className="text-base font-semibold">Pre Book</p>
              <p className="truncate text-[11px] text-white/85">
                {lead.name}
                {pb.plan_label ? ` · ${pb.plan_label}` : ""}
                {pb.date ? ` (${shortDay(pb.date)})` : ""}
              </p>
            </div>
          </div>
          <button type="button" onClick={() => !saving && onClose()} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" aria-label="Close" data-testid="pre-book-collect-close">
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
                {paidConsult.paid < paidConsult.price ? ` · ${rupees(paidConsult.price - paidConsult.paid)} to collect on the visit day` : ""}
                {paidConsult.applied_at ? " · used on the Consultation Fee" : ""}
              </p>
            </Section>
          ) : (
            <Section title="Consultation">
              <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={consultOn} onChange={(e) => setConsultOn(e.target.checked)} data-testid="pre-book-consult-on" />
                Collect a consultation package
              </label>
              {consultOn && (
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-slate-700">Package (Services &amp; Products › Pre Book)</span>
                    <select
                      value={itemId}
                      onChange={(e) => pickItem(e.target.value)}
                      disabled={items.loading || !items.rows.length}
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
                      data-testid="pre-book-consult-item"
                    >
                      {items.loading && <option value="">Loading…</option>}
                      {!items.loading && !items.rows.length && <option value="">None yet — add one under Services &amp; Products › Consultations › Pre Book</option>}
                      {items.rows.map((i) => {
                        const p = consultationItemPrice(i, mode);
                        return <option key={i.id} value={i.id}>{i.name}{p != null ? ` — ${rupees(p)}` : " — no price"}</option>;
                      })}
                    </select>
                  </label>
                  <CollectField
                    label="Amount paid now (₹)"
                    type="number"
                    inputMode="decimal"
                    value={consultAmount}
                    onChange={(e) => setConsultAmount(e.target.value)}
                    placeholder={price != null ? String(price) : "0"}
                    testid="pre-book-consult-amount"
                  />
                  <p className="text-[11px] text-slate-500">
                    {consultShort
                      ? `Part payment — ${rupees(consultShort)} is collected on the visit day.`
                      : "The whole price, or less to confirm the booking (the rest on the visit day)."}
                  </p>
                </div>
              )}
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
                  <div>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">Advance for</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[["sessions", "Sessions"], ["others", "Others"]].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setAdvanceFor(key)}
                          className={`rounded-md border px-2 py-2 text-xs font-semibold transition ${advanceFor === key ? "border-teal-500 bg-teal-600 text-white" : "border-teal-200 bg-teal-50 text-teal-700"}`}
                          data-testid={`pre-book-advance-for-${key}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <CollectField
                    label={advanceFor === "others" ? "What is it for? *" : "Note (optional)"}
                    value={advanceNote}
                    onChange={(e) => setAdvanceNote(e.target.value)}
                    placeholder={advanceFor === "others" ? "e.g. Diet consultation" : "e.g. 10 sessions agreed"}
                    testid="pre-book-advance-note"
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
                  <p className="text-[11px] text-slate-500">
                    {advanceFor === "sessions"
                      ? "Used on the Treatment Fee once the consultant picks the sessions; the rest is collected then."
                      : "Recorded on the patient; settle it by hand when the service is given."}
                  </p>
                </div>
              )}
            </Section>
          )}

          {!nothingLeft && (
            <>
              <div className="space-y-3">
                <TenderFields draft={draft} setDraft={setD} testid="pre-book" modes={PRE_BOOK_MODES} />
              </div>
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="pre-book-confirm" />
                <span>I have received <span className="font-semibold">{rupees(total)}</span> from {lead.name || "the client"}.</span>
              </label>
              <div className="flex items-center justify-between rounded-xl border border-teal-200 bg-teal-50 px-4 py-2.5">
                <span className="text-xs font-bold uppercase tracking-wide text-teal-800">Total received</span>
                <span className="text-xl font-bold text-teal-800" data-testid="pre-book-total">{rupees(total)}</span>
              </div>
            </>
          )}
          {nothingLeft && (
            <p className="text-center text-xs text-slate-500">Both parts are paid. A wrong payment is deleted from finance and collected again.</p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button" onClick={onClose} disabled={saving}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-50"
            data-testid="pre-book-cancel"
          >
            {nothingLeft ? "Close" : "Cancel"}
          </button>
          {!nothingLeft && (
            <button
              type="button" onClick={submit} disabled={saving || !(total > 0)}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
              data-testid="pre-book-collect"
            >
              {saving ? "Collecting..." : `Collect ${rupees(total)}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default PreBookCollectDialog;
