import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, X, Search, UserPlus, Info } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { searchOldClients, recordOldClientPayment } from "@/lib/api";
import { CollectField, TenderFields, emptyTender, tenderPayload } from "@/components/branch/CollectTender";

const fmt = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Off the local clock, not toISOString(), which is UTC and east of Greenwich hands back
// yesterday for the first hours of every morning.
const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDay = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");

// What the old course was for, by the revenue line its money lands on -- old_clients.CATEGORIES
// on the server. The four the old Physio Tracker sold.
const CATEGORIES = [
  ["session", "Treatment"],
  ["rehab", "Rehab"],
  ["consultation", "Consultation"],
  ["diet", "Diet"],
];

const emptyClient = {
  name: "", phone: "", old_patient_id: "", category: "session", package: "",
  total_fee: "", paid_before: "", instalments_before: "1",
};

const clientFrom = (c) => ({
  name: c.name || "",
  phone: c.phone || "",
  old_patient_id: c.old_patient_id || "",
  category: c.category || "session",
  package: c.package || "",
  total_fee: String(c.total_fee ?? ""),
  paid_before: String(c.paid_before ?? ""),
  instalments_before: String(c.instalments_before ?? ""),
});

const digitsOf = (s) => String(s || "").replace(/\D/g, "");

/**
 * Old Client Instalment -- money taken against a course begun on the old Physio Tracker,
 * for a client whose history never came across to the OS (backend/old_clients.py).
 *
 * Three steps on one form: find the client (or add them), check their old course, take the
 * instalment. A client found here was added the first time one of their instalments was
 * entered, so the second visit is a search and a figure, not the whole form again. The OS's
 * own clients on the same name or phone are listed beside them: a course the OS already
 * holds is collected from that client's card, and this form is not a second way to do it.
 *
 * @param branchId   The branch the money was taken at. Empty where the board above is
 *                   reading every branch -- the form then asks for one.
 * @param startWith  { id, phone, branch_id } of an old client to open straight on, as
 *                   Payment Schedule's Collect does.
 */
export const OldClientInstalmentDialog = ({ branchId = "", branches = [], startWith = null, onClose, onSaved }) => {
  const today = toIso(new Date());
  const [branch, setBranch] = useState(branchId || startWith?.branch_id || "");
  const [q, setQ] = useState(startWith?.phone || "");
  const [found, setFound] = useState({ old_clients: [], os_clients: [] });
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [editing, setEditing] = useState(false);
  const [client, setClient] = useState(emptyClient);
  const [pay, setPay] = useState({ amount: "", paid_on: today, next_due_date: "", ...emptyTender });
  const [saving, setSaving] = useState(false);
  // Opened from a Payment Schedule row: picked the first time the search hands it back,
  // and never again, so "Change client" goes back to a search rather than straight in.
  const autoPick = useRef(startWith?.id || null);

  const pick = useCallback((c) => {
    setPicked(c);
    setIsNew(false);
    setEditing(false);
    setClient(clientFrom(c));
    setPay((p) => ({ ...p, amount: "" }));
  }, []);

  useEffect(() => {
    if (!branch || picked || isNew) return undefined;
    let live = true;
    const t = setTimeout(() => {
      setSearching(true);
      searchOldClients({ q: q.trim() || undefined, branch_id: branch })
        .then((d) => {
          if (!live) return;
          setFound({ old_clients: d.old_clients || [], os_clients: d.os_clients || [] });
          const hit = autoPick.current && (d.old_clients || []).find((c) => c.id === autoPick.current);
          autoPick.current = null;
          if (hit) pick(hit);
        })
        .catch(() => { if (live) setFound({ old_clients: [], os_clients: [] }); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [branch, q, picked, isNew, pick]);

  const setC = (patch) => setClient((c) => ({ ...c, ...patch }));
  const setP = (patch) => setPay((p) => ({ ...p, ...patch }));

  const startNew = () => {
    // Whatever was typed into the search is the start of the form: digits are a phone,
    // anything else a name.
    const typed = q.trim();
    const asPhone = /^[\d\s+()-]{6,}$/.test(typed);
    setClient({ ...emptyClient, ...(asPhone ? { phone: digitsOf(typed) } : { name: typed }) });
    setPicked(null);
    setIsNew(true);
    setEditing(true);
  };

  const backToSearch = () => {
    setPicked(null);
    setIsNew(false);
    setEditing(false);
  };

  // The figures the payment half reads, off the form as it stands -- so correcting the
  // total on an existing client moves the balance in front of the desk before it is saved.
  // The total fee is optional; without it there is no balance to show or to cap at.
  const total = Number(client.total_fee) || 0;
  const hasTotal = total > 0;
  const before = Number(client.paid_before) || 0;
  const paidHere = picked ? Number(picked.paid_on_os) || 0 : 0;
  const owed = Math.max(round2(total - before - paidHere), 0);
  const instalmentsBefore = Math.max(Number(client.instalments_before) || 0, before > 0 ? 1 : 0);
  const number = instalmentsBefore + (picked ? picked.payments.length : 0) + 1;
  const amount = parseFloat(pay.amount);
  const showPayment = Boolean(picked || isNew);

  const submit = async () => {
    if (!branch) { toast.error("Pick the branch this payment was taken at"); return; }
    // Only the amount is required. The rest is optional, but checked when it is typed.
    const phoneDigits = digitsOf(client.phone);
    if (phoneDigits && phoneDigits.slice(-10).length !== 10) { toast.error("Phone must be a 10-digit number"); return; }
    if (hasTotal && before >= total) { toast.error("The old tracker already shows this course as fully paid"); return; }
    if (!(amount > 0)) { toast.error("Enter the amount paid"); return; }
    if (hasTotal && amount > owed + 0.01) { toast.error(`That is more than the ${fmt(owed)} still owed on this course`); return; }
    if (pay.paid_on && pay.paid_on > today) { toast.error("Paid on cannot be a future date"); return; }
    const tender = tenderPayload(pay);
    if (tender.error) { toast.error(tender.error); return; }

    setSaving(true);
    try {
      const res = await recordOldClientPayment({
        ...tender.payload,
        amount,
        // Left blank, the server takes it as today.
        paid_on: pay.paid_on || undefined,
        branch_id: branch,
        old_client_id: picked?.id || undefined,
        // Sent for an existing client too: it is how a correction, and the next due date
        // agreed at this visit, reach the record.
        client: {
          ...client,
          total_fee: total,
          paid_before: before,
          instalments_before: instalmentsBefore,
          next_due_date: pay.next_due_date || "",
        },
      });
      onSaved && onSaved(res);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not record the instalment");
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      data-testid="old-client-dialog"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="old-client-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-white">
          <div className="flex min-w-0 items-center gap-2">
            <History className="h-5 w-5 shrink-0" />
            <p id="old-client-title" className="min-w-0 truncate text-base font-semibold">Old Client Instalment</p>
          </div>
          <button type="button" onClick={() => !saving && onClose()} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" aria-label="Close" data-testid="old-client-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-3">
          {!branchId && (
            <label className="block">
              <span className="mb-0.5 block text-xs font-semibold text-slate-700">Branch *</span>
              <select
                value={branch}
                onChange={(e) => { setBranch(e.target.value); backToSearch(); }}
                disabled={Boolean(picked || isNew)}
                className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:bg-slate-50"
                data-testid="old-client-branch"
              >
                <option value="">Pick the branch the money was taken at</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
              </select>
            </label>
          )}

          {branch && !showPayment && (
            <div className="space-y-3" data-testid="old-client-find">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, phone or old patient ID"
                  className="h-10 w-full rounded-md border border-slate-300 pl-9 pr-3 text-sm text-slate-900 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                  data-testid="old-client-search"
                />
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {q.trim() ? "Old clients found" : "Recently added old clients"}
                  {searching && <span className="ml-2 font-normal normal-case text-slate-400">Searching…</span>}
                </p>
                {found.old_clients.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                    {q.trim() ? "No old client by that name, phone or ID yet." : "No old clients entered at this branch yet."}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {found.old_clients.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pick(c)}
                        disabled={c.total_fee > 0 && c.balance <= 0}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-200 disabled:hover:bg-white"
                        data-testid={`old-client-result-${c.id}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-800">{c.name || "Old client"}</span>
                          <span className="block truncate text-[11px] text-slate-500">
                            {[c.phone, c.old_patient_id && `ID ${c.old_patient_id}`, c.category_label, c.package].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {c.balance > 0 ? (
                          <span className="shrink-0 text-right">
                            <span className="block text-sm font-bold text-amber-600">{fmt(c.balance)} due</span>
                            <span className="block text-[10px] text-slate-400">Next: instalment #{c.next_instalment_number}</span>
                          </span>
                        ) : c.total_fee > 0 ? (
                          <span className="shrink-0 text-xs font-semibold text-emerald-600">Paid up</span>
                        ) : (
                          <span className="shrink-0 text-right">
                            <span className="block text-xs font-semibold text-slate-500">Total not set</span>
                            <span className="block text-[10px] text-slate-400">Next: instalment #{c.next_instalment_number}</span>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {found.os_clients.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5" data-testid="old-client-os-matches">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                    <Info className="h-3.5 w-3.5" /> Already a client on the OS
                  </p>
                  <p className="mt-0.5 text-[11px] text-amber-900/80">
                    If this money is for their package on the OS, collect it from their client card (Payment Schedule), not here.
                  </p>
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-900">
                    {found.os_clients.map((c) => (
                      <li key={c.id}>{[c.name, c.phone, c.patient_number].filter(Boolean).join(" · ")}</li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={startNew}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50"
                data-testid="old-client-new"
              >
                <UserPlus className="h-4 w-4" /> New old client
              </button>
            </div>
          )}

          {showPayment && (picked && !editing ? (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3" data-testid="old-client-picked">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-800">{client.name || "Old client"}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {[client.phone, client.old_patient_id && `ID ${client.old_patient_id}`].filter(Boolean).join(" · ")}
                  </p>
                  <p className="truncate text-[11px] text-slate-500">
                    {[CATEGORIES.find(([k]) => k === client.category)?.[1], client.package].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-[11px] font-semibold">
                  <button type="button" onClick={() => setEditing(true)} className="text-indigo-700 hover:underline" data-testid="old-client-edit">Edit details</button>
                  <button type="button" onClick={backToSearch} className="text-slate-500 hover:underline" data-testid="old-client-change">Change</button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-white px-2 py-1.5">
                  <p className="text-[10px] font-semibold uppercase text-slate-400">Course fee</p>
                  <p className="text-sm font-bold text-slate-800">{hasTotal ? fmt(total) : "Not set"}</p>
                </div>
                <div className="rounded-md bg-white px-2 py-1.5">
                  <p className="text-[10px] font-semibold uppercase text-slate-400">Paid so far</p>
                  <p className="text-sm font-bold text-emerald-600">{fmt(before + paidHere)}</p>
                </div>
                <div className="rounded-md bg-white px-2 py-1.5">
                  <p className="text-[10px] font-semibold uppercase text-slate-400">Balance</p>
                  <p className="text-sm font-bold text-amber-600">{hasTotal ? fmt(owed) : "—"}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5" data-testid="old-client-form">
              <div className="flex items-center justify-end">
                <button type="button" onClick={picked ? () => setEditing(false) : backToSearch} className="text-[11px] font-semibold text-slate-500 hover:underline">
                  {picked ? "Done" : "Back to search"}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                <CollectField compact label="Client Name" value={client.name} onChange={(e) => setC({ name: e.target.value })} testid="old-client-name" />
                <CollectField compact label="Phone" value={client.phone} onChange={(e) => setC({ phone: e.target.value })} inputMode="tel" testid="old-client-phone" />
                <CollectField compact label="Old Patient ID" value={client.old_patient_id} onChange={(e) => setC({ old_patient_id: e.target.value })} testid="old-client-old-id" />
                <CollectField compact label="Package" value={client.package} onChange={(e) => setC({ package: e.target.value })} testid="old-client-package" />
              </div>
              <div>
                <span className="mb-0.5 block text-xs font-semibold text-slate-700">Paid For</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {CATEGORIES.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setC({ category: key })}
                      className={`rounded-md border px-2 py-1.5 text-xs font-semibold transition ${
                        client.category === key ? "border-indigo-500 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
                      }`}
                      data-testid={`old-client-category-${key}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-3">
                <CollectField compact label="Total Course Fee" value={client.total_fee} onChange={(e) => setC({ total_fee: e.target.value })} placeholder="0" inputMode="decimal" testid="old-client-total" />
                <CollectField compact label="Paid in Old Tracker" value={client.paid_before} onChange={(e) => setC({ paid_before: e.target.value })} placeholder="0" inputMode="decimal" testid="old-client-paid-before" />
                <CollectField compact label="Instalments Paid There" value={client.instalments_before} onChange={(e) => setC({ instalments_before: e.target.value })} placeholder="1" inputMode="numeric" testid="old-client-instalments-before" />
              </div>
            </div>
          ))}

          {showPayment && (
            <div className="space-y-2.5 border-t border-slate-100 pt-3" data-testid="old-client-payment">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Instalment #{number}</p>
                <div className="text-right">
                  <p className="text-[10px] font-semibold uppercase text-emerald-800/80">Balance</p>
                  <p className="text-lg font-bold leading-tight text-emerald-800" data-testid="old-client-balance">{hasTotal ? fmt(owed) : "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-3">
                <CollectField compact label="Amount Paid *" value={pay.amount} onChange={(e) => setP({ amount: e.target.value })} placeholder="0" inputMode="decimal" testid="old-client-amount" />
                <CollectField compact label="Paid On" type="date" max={today} value={pay.paid_on} onChange={(e) => setP({ paid_on: e.target.value })} testid="old-client-paid-on" />
                <CollectField compact label="Next Instalment Due" type="date" value={pay.next_due_date} onChange={(e) => setP({ next_due_date: e.target.value })} testid="old-client-next-due" />
              </div>
              {owed > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button" onClick={() => setP({ amount: String(owed) })}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    data-testid="old-client-amount-full"
                  >
                    Full balance {fmt(owed)}
                  </button>
                  {amount > 0 && amount <= owed + 0.01 && (
                    <p className="text-xs text-slate-600">Balance after this payment: <span className="font-semibold">{fmt(owed - amount)}</span></p>
                  )}
                </div>
              )}
              {pay.paid_on && pay.paid_on < today && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900" data-testid="old-client-backdated">
                  Back-dated: this goes into {fmtDay(pay.paid_on)}&apos;s revenue and closing count. A day whose books are already closed can&apos;t take it.
                </p>
              )}

              <TenderFields compact draft={pay} setDraft={setP} testid="old-client-collect" />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-2.5">
          <button
            type="button" onClick={onClose} disabled={saving}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-50"
            data-testid="old-client-cancel"
          >
            Cancel
          </button>
          {showPayment && (
            <button
              type="button" onClick={submit} disabled={saving}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              data-testid="old-client-confirm"
            >
              {saving ? "Recording..." : "Record Instalment"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default OldClientInstalmentDialog;
