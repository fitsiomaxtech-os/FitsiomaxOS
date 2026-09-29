import { useEffect, useState } from "react";
import { AlertTriangle, Archive, CalendarDays, Loader2, Phone, Stethoscope, UserRound } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPastDataClient } from "@/lib/api";
import { dateStampFull } from "@/lib/time";
import { flagLabel, modeLabel, paymentState, rs, statusTone } from "@/lib/pastData";

const Chip = ({ className = "", children, testid }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`} data-testid={testid}>
    {children}
  </span>
);

const FlagChips = ({ flags = [], testid }) => (flags.length ? (
  <div className="flex flex-wrap gap-1" data-testid={testid}>
    {flags.map((f) => (
      <Chip key={f} className="border-amber-200 bg-amber-50 text-amber-700"><AlertTriangle className="h-3 w-3" />{flagLabel(f)}</Chip>
    ))}
  </div>
) : null);

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
    <p className="truncate text-sm text-slate-800">{children || <span className="text-slate-300">—</span>}</p>
  </div>
);

const day = (value) => (value ? dateStampFull(value) : "");

const sessionsText = (t) => {
  if (t.recommended_sessions != null) return `${t.recommended_sessions} sessions`;
  return t.recommended_sessions_text || "";
};

const PaymentsTable = ({ payments, showCancelled }) => {
  const rows = showCancelled ? payments : payments.filter((p) => p.state !== "cancelled");
  if (!rows.length) return <p className="px-3 py-2 text-xs text-slate-400">No installments recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 font-semibold">#</th>
            <th className="px-3 py-2 text-right font-semibold">Due</th>
            <th className="px-3 py-2 text-right font-semibold">Paid</th>
            <th className="px-3 py-2 font-semibold">Due date</th>
            <th className="px-3 py-2 font-semibold">Paid on</th>
            <th className="px-3 py-2 font-semibold">Mode</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p) => {
            const state = paymentState(p.state);
            return (
              <tr key={p.id} className={p.state === "cancelled" ? "text-slate-400" : "text-slate-700"} data-testid={`past-payment-${p.excel_id}`}>
                <td className="whitespace-nowrap px-3 py-2">
                  {p.installment ?? "—"}{p.installments_total ? ` / ${p.installments_total}` : ""}
                  <span className="ml-1.5 font-mono text-[10px] text-slate-400">{p.excel_id}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{p.amount_due != null ? rs(p.amount_due) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{p.amount_paid != null ? rs(p.amount_paid) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2">{day(p.due_date) || "—"}</td>
                <td className="whitespace-nowrap px-3 py-2">{day(p.paid_date) || "—"}</td>
                <td className="whitespace-nowrap px-3 py-2">{modeLabel(p.mode, p.mode_as_written) || "—"}</td>
                <td className="px-3 py-2"><Chip className={state.tone}>{state.label}</Chip></td>
                <td className="px-3 py-2">
                  {p.notes && <p className="max-w-[220px] text-slate-500">{p.notes}</p>}
                  {p.flags?.includes("client_mismatch") && (
                    <p className="text-[11px] text-amber-700">Row says {p.client_excel_id} {p.name}</p>
                  )}
                  <FlagChips flags={(p.flags || []).filter((f) => f !== "client_mismatch")} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const TreatmentCard = ({ t, showCancelled }) => (
  <div className="overflow-hidden rounded-lg border border-slate-200" data-testid={`past-treatment-${t.excel_id}`}>
    <div className="space-y-2 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-slate-900">{t.service || <span className="italic text-slate-400">No service type</span>}</p>
        <span className="font-mono text-[11px] text-slate-400">{t.excel_id}</span>
        {t.status && <Chip className={statusTone(t.status)}>{t.status}</Chip>}
        {t.mode === "online" && <Chip className="border-violet-200 bg-violet-50 text-violet-700">Online</Chip>}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500">
          <CalendarDays className="h-3.5 w-3.5" />{day(t.start_date) || "—"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Fact label="Physio">{t.physio}</Fact>
        <Fact label="Recommended">{sessionsText(t)}</Fact>
        <Fact label="Fee in register">{t.fee != null ? rs(t.fee) : ""}</Fact>
        <Fact label="Paid"><span className="font-semibold text-emerald-700">{rs(t.paid_total)}</span></Fact>
        <Fact label="Still owed">
          <span className={t.outstanding_total > 0 ? "font-semibold text-amber-700" : "text-slate-500"}>{rs(t.outstanding_total)}</span>
        </Fact>
      </div>
      {t.notes && <p className="text-xs text-slate-600"><span className="font-semibold text-slate-500">Notes: </span>{t.notes}</p>}
      <FlagChips flags={t.flags} />
    </div>
    <div className="border-t border-slate-100">
      <PaymentsTable payments={t.payments || []} showCancelled={showCancelled} />
    </div>
  </div>
);

/**
 * One past client, whole: who they were, what they asked about, every course, and every
 * installment under the course it was paid against. Read-only — this is the register as it
 * was kept, and nothing on it can be collected, booked or moved from here.
 */
export const PastClientDialog = ({ clientId, onClose, onOpenClient }) => {
  const [client, setClient] = useState(null);
  const [error, setError] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    setClient(null);
    setError("");
    setShowCancelled(false);
    getPastDataClient(clientId)
      .then((row) => { if (live) setClient(row); })
      .catch((e) => { if (live) setError(e?.response?.data?.detail || "Could not load this client"); });
    return () => { live = false; };
  }, [clientId]);

  const treatments = client?.treatments || [];
  const cancelledCount = treatments.reduce((n, t) => n + (t.payments || []).filter((p) => p.state === "cancelled").length, 0);

  return (
    <Dialog open={!!clientId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto" data-testid="past-client-dialog">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <UserRound className="h-5 w-5 text-sky-600" />
            {client?.name || "Past client"}
            {client?.excel_id && <span className="font-mono text-sm font-normal text-slate-400">{client.excel_id}</span>}
            <Chip className="border-slate-200 bg-slate-50 text-slate-500"><Archive className="h-3 w-3" />Read-only · Excel register</Chip>
          </DialogTitle>
          <DialogDescription>
            {client?.branch_name ? `Imported into ${client.branch_name} from ${client.source_file || "the register"}.` : "From the clinic's register before the OS."}
            {" "}Not counted in live leads, revenue or dashboards.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="past-client-error">{error}</p>}
        {!client && !error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        )}

        {client && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-4">
              <Fact label="Phone">
                <span className="inline-flex items-center gap-1 font-mono"><Phone className="h-3 w-3 text-slate-400" />{client.phone}</span>
              </Fact>
              <Fact label="Gender / Age">{[client.gender, client.age].filter(Boolean).join(" · ")}</Fact>
              <Fact label="Registered">{day(client.registration_date)}</Fact>
              <Fact label="Source / Referred by">{client.source}</Fact>
              <Fact label="Treatments">{String(client.treatments_count ?? 0)}</Fact>
              <Fact label="Paid"><span className="font-semibold text-emerald-700">{rs(client.paid_total)}</span></Fact>
              <Fact label="Still owed">
                <span className={client.outstanding_total > 0 ? "font-semibold text-amber-700" : "text-slate-500"}>{rs(client.outstanding_total)}</span>
              </Fact>
              <Fact label="Last treatment">{day(client.last_treatment_date)}</Fact>
            </div>

            {client.notes && <p className="text-sm text-slate-600"><span className="font-semibold text-slate-500">Notes: </span>{client.notes}</p>}
            <FlagChips flags={client.flags} testid="past-client-flags" />
            {client.shared_phone_clients?.length > 0 && (
              <p className="text-xs text-slate-600" data-testid="past-client-shared">
                Also on this number:{" "}
                {client.shared_phone_clients.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <button type="button" className="font-medium text-sky-700 hover:underline" onClick={() => onOpenClient(c.id)}>
                      {c.name} ({c.excel_id})
                    </button>
                  </span>
                ))}
              </p>
            )}

            {client.enquiries?.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Enquiries</h3>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[560px] text-left text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Date</th>
                        <th className="px-3 py-2 font-semibold">Interested in</th>
                        <th className="px-3 py-2 font-semibold">Outcome</th>
                        <th className="px-3 py-2 font-semibold">Package recommended</th>
                        <th className="px-3 py-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {client.enquiries.map((e) => (
                        <tr key={e.excel_id}>
                          <td className="whitespace-nowrap px-3 py-2">{day(e.enquiry_date) || "—"} <span className="ml-1 font-mono text-[10px] text-slate-400">{e.excel_id}</span></td>
                          <td className="px-3 py-2">{e.service_interest || "—"}</td>
                          <td className="px-3 py-2">{e.outcome || "—"}</td>
                          <td className="px-3 py-2">{e.package_recommended || "—"}</td>
                          <td className="px-3 py-2">{e.status || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
                  <Stethoscope className="h-3.5 w-3.5" />Treatments
                </h3>
                {cancelledCount > 0 && (
                  <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                    <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} data-testid="past-client-show-cancelled" />
                    Show {cancelledCount} cancelled installment{cancelledCount === 1 ? "" : "s"}
                  </label>
                )}
              </div>
              {treatments.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
                  No treatment courses in the register — see the enquiry above for how their visit ended.
                </p>
              ) : (
                treatments.map((t) => <TreatmentCard key={t.id} t={t} showCancelled={showCancelled} />)
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PastClientDialog;
