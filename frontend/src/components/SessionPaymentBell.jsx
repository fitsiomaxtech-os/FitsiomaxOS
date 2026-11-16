import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { approveSessionPaymentExtension, getSessionPaymentAlerts, rejectSessionPaymentExtension } from "@/lib/api";

// Fired by the Physio board after a day is completed, so the count moves with the press
// rather than on the next page load.
export const SESSION_PAYMENT_REFRESH_EVENT = "session-payment-alerts:refresh";

const REFRESH_MS = 5 * 60 * 1000;
const EMPTY = { alerts: [], due: 0, last_paid: 0, extension_requests: 0 };

const rs = (n) => `Rs.${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * Clients whose paid treatment sessions have been used up (or have one left) while a
 * Treatment Fee balance is still owing. Super Admin, Branch Admin and BDE only; the backend
 * narrows a Branch Admin's list to their own branch. `enabled` false asks nothing.
 *
 * `status` is "loading" until the first answer and "error" when the last fetch failed, so a
 * list that could not be fetched never reads as "nobody owes anything". The first load of a
 * browser session also says so in a toast, since a count on a bell is easy to miss.
 */
export function useSessionPaymentAlerts(enabled) {
  const [data, setData] = useState(EMPTY);
  const [status, setStatus] = useState("loading");
  const announced = useRef(false);

  const load = useCallback(() => {
    if (!enabled) return;
    getSessionPaymentAlerts()
      .then((res) => {
        const next = res || EMPTY;
        setData(next);
        setStatus("ok");
        if (announced.current) return;
        announced.current = true;
        let seen = false;
        try { seen = sessionStorage.getItem("session-payment-alerts-announced") === "1"; } catch { /* private window */ }
        if (!seen && next.due > 0) {
          // Keyed: the phone header and the desktop header can both be mounted.
          toast.warning(
            `${next.due} client${next.due === 1 ? " has" : "s have"} used up their paid sessions — balance due`,
            { id: "session-payment-due", duration: 10000, description: "Open the bell at the top, Session payments due." },
          );
          try { sessionStorage.setItem("session-payment-alerts-announced", "1"); } catch { /* ignore */ }
        }
      })
      .catch(() => setStatus("error"));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const timer = setInterval(load, REFRESH_MS);
    window.addEventListener(SESSION_PAYMENT_REFRESH_EVENT, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(SESSION_PAYMENT_REFRESH_EVENT, load);
    };
  }, [enabled, load]);

  const retry = useCallback(() => { setStatus("loading"); load(); }, [load]);
  return { data, status, load, retry, count: data.due || data.last_paid, urgent: data.due > 0 };
}

/**
 * The Session payments due list, as the bell's tab shows it. Past the paid sessions the next
 * day is held until the balance is paid. `canDecide` (Branch Admin, Super Admin) adds the way
 * out: approve the client's request for more time, or grant it at the desk.
 */
export function SessionPaymentList({ data, status, onReload, onRetry, canDecide = false }) {
  const alerts = data.alerts || [];
  return (
    <div className="space-y-3" data-testid="session-payment-list">
      {data.extension_requests > 0 && (
        <p className="text-xs font-semibold text-violet-700" data-testid="session-payment-extension-count">
          {data.extension_requests} request{data.extension_requests === 1 ? "" : "s"} for more time waiting
        </p>
      )}
      {alerts.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {alerts.map((a) => (
            <div key={a.lead_id} className="rounded-[4px] border border-slate-200 bg-white px-4 py-3" data-testid={`session-payment-alert-${a.lead_id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{a.name}</p>
                  <p className="truncate text-[10px] text-slate-400">
                    {[a.patient_number, a.branch_name, a.physio_name && `Physio: ${a.physio_name}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  a.level === "due" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"
                }`}>
                  {a.level === "due" ? "Payment due" : "1 paid session left"}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div><p className="text-slate-400">Completed</p><p className="font-semibold text-slate-800">{a.completed_sessions} / {a.total_sessions}</p></div>
                <div><p className="text-slate-400">Paid for</p><p className="font-semibold text-slate-800">{a.paid_sessions}</p></div>
                <div><p className="text-slate-400">Balance</p><p className="font-semibold text-rose-600">{rs(a.balance)}</p></div>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-slate-600">{a.message}</p>
              {a.balance_due_date && <p className="mt-1 text-[10px] text-slate-400">Balance installment due {a.balance_due_date}</p>}
              <ExtensionRow alert={a} canDecide={canDecide} onDecided={onReload} />
            </div>
          ))}
        </div>
      ) : status === "loading" ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
      ) : status === "error" ? (
        <div className="py-10 text-center text-sm" data-testid="session-payment-error">
          <p className="text-rose-600">Could not load session payments.</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded-md border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Retry
          </button>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-slate-400" data-testid="session-payment-empty">No client has run out of paid sessions.</p>
      )}
    </div>
  );
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The client's request for more time on one alert, and -- for whoever may decide -- the
 * Approve / Reject controls. Approving moves the balance's due date and lets the remaining
 * sessions go ahead unpaid until then; it can be granted without a request as well.
 */
function ExtensionRow({ alert: a, canDecide, onDecided }) {
  const ext = a.extension || {};
  const requested = ext.status === "requested";
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(ext.requested_due_date || "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (!date) { toast.error("Pick the new due date"); return; }
    setBusy(true);
    try {
      await approveSessionPaymentExtension(a.lead_id, date, note);
      toast.success(`Extended to ${date} — ${a.name}'s remaining sessions can go ahead`);
      setOpen(false);
      onDecided();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not extend");
    }
    setBusy(false);
  };
  const reject = async () => {
    setBusy(true);
    try {
      await rejectSessionPaymentExtension(a.lead_id, note);
      toast.success("Request rejected — sessions stay on hold until paid");
      setOpen(false);
      onDecided();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not reject");
    }
    setBusy(false);
  };

  return (
    <div className="mt-2 space-y-1.5">
      {requested && (
        <div className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-800" data-testid={`session-payment-extension-request-${a.lead_id}`}>
          <p className="font-semibold">
            Client asked for more time{ext.requested_due_date ? ` — until ${ext.requested_due_date}` : ""}
          </p>
          {ext.reason && <p className="mt-0.5 text-violet-700">&ldquo;{ext.reason}&rdquo;</p>}
        </div>
      )}
      {a.extension_active && (
        <p className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
          Extended to {ext.extended_due_date}{ext.decided_by ? ` by ${ext.decided_by}` : ""} — sessions may go ahead
        </p>
      )}
      {ext.status === "rejected" && (
        <p className="text-[10px] text-slate-400">Request for more time rejected{ext.decided_by ? ` by ${ext.decided_by}` : ""}</p>
      )}
      {canDecide && a.level === "due" && !a.extension_active && (
        open ? (
          <div className="space-y-1.5 rounded-md border border-slate-200 p-2" data-testid={`session-payment-extension-form-${a.lead_id}`}>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              New due date
              <input
                type="date"
                min={todayIso()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-0.5 block w-full rounded border border-slate-200 px-2 py-1 text-xs font-normal normal-case text-slate-800"
                data-testid={`session-payment-extension-date-${a.lead_id}`}
              />
            </label>
            <input
              type="text"
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="block w-full rounded border border-slate-200 px-2 py-1 text-xs"
            />
            <div className="flex gap-1.5">
              <button type="button" disabled={busy} onClick={approve}
                className="flex-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                data-testid={`session-payment-extension-approve-${a.lead_id}`}>
                Allow sessions
              </button>
              {requested && (
                <button type="button" disabled={busy} onClick={reject}
                  className="flex-1 rounded-md border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  data-testid={`session-payment-extension-reject-${a.lead_id}`}>
                  Reject
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-50">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)}
            className={`w-full rounded-md px-2 py-1 text-[11px] font-semibold ${
              requested ? "bg-violet-600 text-white hover:bg-violet-700" : "border border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
            data-testid={`session-payment-extension-open-${a.lead_id}`}>
            {requested ? "Review request" : "Extend due date"}
          </button>
        )
      )}
    </div>
  );
}
