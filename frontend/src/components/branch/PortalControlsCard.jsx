import { useCallback, useEffect, useState } from "react";
import { ChevronDown, KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  getPortalSettings, savePortalClinicSettings, savePortalBranchMode,
  approvePortalPending, dismissPortalPending,
} from "@/lib/api";
import { PortalLoginCreatedDialog } from "@/components/branch/PortalLoginCreatedDialog";
import { displayPhone } from "@/lib/phone";

const MODE_LABEL = {
  immediate: "Send immediately",
  approval: "Wait for approval",
  off: "Off",
};

const MODE_HELP = {
  immediate: "When treatment is booked, the login is made and emailed straight away.",
  approval: "When treatment is booked, the patient waits on the list below until someone approves.",
  off: "No logins are made automatically for this branch. Generate Portal Access still works by hand.",
};

// What a caller is told after Approve & Send when there is no login to hand over.
const APPROVE_OUTCOME = {
  exists: "This patient already has a portal login",
  no_contact: "No phone number or email on file — add one to Patient Details, then approve again",
  error: "Could not make the login — try again",
};

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : "";
};

/**
 * The automatic Client Portal login, as this branch runs it: the clinic-wide switch and
 * email wording (Super Admin and Business Development), this branch's mode, and the logins
 * waiting on approval. Everything a caller may change comes back from the server with the
 * settings, so a Branch Admin is never offered a control the server would refuse.
 */
export function PortalControlsCard({ branchId }) {
  const [s, setS] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await getPortalSettings(branchId);
      setS(data);
      setSubject(data.email_subject || "");
      setBody(data.email_body || "");
      // Open on its own when somebody is waiting, which is the one thing here that needs
      // doing rather than merely setting.
      if ((data.pending || []).length > 0) setOpen(true);
    } catch {
      setS(null);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  if (!s) return null;

  const pending = s.pending || [];
  const allowed = s.branch_modes_allowed || [];
  const state = !s.auto_enabled
    ? { text: "Off for the whole clinic", tone: "bg-slate-200 text-slate-700" }
    : s.branch_mode === "off"
      ? { text: "Off for this branch", tone: "bg-slate-200 text-slate-700" }
      : s.branch_mode === "approval"
        ? { text: "Waiting for approval", tone: "bg-amber-100 text-amber-800" }
        : { text: "Sends immediately", tone: "bg-emerald-100 text-emerald-800" };

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (err) { toast.error(err?.response?.data?.detail || "Something went wrong"); }
    setBusy("");
  };

  const toggleClinic = () => run("clinic", async () => {
    await savePortalClinicSettings({ auto_enabled: !s.auto_enabled });
    toast.success(s.auto_enabled ? "Automatic portal login turned off for the clinic" : "Automatic portal login turned on for the clinic");
    await load();
  });

  const saveWording = (reset) => run("wording", async () => {
    await savePortalClinicSettings(reset ? { email_subject: "", email_body: "" } : { email_subject: subject, email_body: body });
    toast.success(reset ? "Email wording reset to the default" : "Email wording saved");
    await load();
  });

  const setMode = (mode) => run(`mode-${mode}`, async () => {
    await savePortalBranchMode(branchId, mode);
    toast.success(`This branch: ${MODE_LABEL[mode]}`);
    await load();
  });

  const approve = (p) => run(`approve-${p.id}`, async () => {
    const result = await approvePortalPending(p.id);
    if (["created", "joined"].includes(result.status)) setNotice(result);
    else toast.warning(APPROVE_OUTCOME[result.status] || "Nothing was made");
    await load();
  });

  const dismiss = (p) => run(`dismiss-${p.id}`, async () => {
    await dismissPortalPending(p.id);
    toast.success(`${p.patient_name || "Patient"} removed from the list`);
    await load();
  });

  return (
    <div className="rounded-xl border border-violet-200 bg-white" data-testid="portal-controls">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        data-testid="portal-controls-toggle"
      >
        <KeyRound className="h-4 w-4 shrink-0 text-violet-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800">Client Portal — automatic login</span>
          <span className="block text-[11px] text-slate-500">Made when treatment is booked</span>
        </span>
        <span className={`hidden whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold sm:inline ${state.tone}`}>{state.text}</span>
        {pending.length > 0 && (
          <span className="whitespace-nowrap rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white" data-testid="portal-controls-pending-count">
            {pending.length} waiting
          </span>
        )}
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-violet-100 px-4 py-4">
          <p className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold sm:hidden ${state.tone}`}>{state.text}</p>

          {/* Clinic-wide. Read by everyone, changed by the two org-wide desks. */}
          <section className="space-y-2" data-testid="portal-controls-clinic">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Whole clinic</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.auto_enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>
                {s.auto_enabled ? "ON" : "OFF"}
              </span>
              {s.can_edit_clinic ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!busy} onClick={toggleClinic} data-testid="portal-controls-clinic-toggle">
                  {s.auto_enabled ? "Turn off for all branches" : "Turn on for all branches"}
                </Button>
              ) : (
                <span className="text-[11px] text-slate-400">Set by Super Admin</span>
              )}
            </div>

            {s.can_edit_clinic && (
              <details className="rounded-lg border border-slate-200 p-3" data-testid="portal-controls-wording">
                <summary className="cursor-pointer text-xs font-medium text-slate-700">Email wording</summary>
                <div className="mt-3 space-y-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">Subject</label>
                    <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 text-sm" maxLength={200} data-testid="portal-controls-subject" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">Message</label>
                    <textarea
                      rows={10}
                      value={body}
                      maxLength={5000}
                      onChange={(e) => setBody(e.target.value)}
                      className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
                      data-testid="portal-controls-body"
                    />
                    <p className="mt-1 text-[10px] text-slate-400">
                      Filled in for each patient: {(s.template_keys || []).map((k) => `{${k}}`).join("  ")}.
                      The login and password are always added, even if you remove them.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-8 text-xs" disabled={!!busy} onClick={() => saveWording(false)} data-testid="portal-controls-save-wording">
                      Save wording
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!busy} onClick={() => saveWording(true)}>
                      Reset to default
                    </Button>
                  </div>
                </div>
              </details>
            )}
          </section>

          {/* This branch. A Branch Admin picks between the first two; "off" is the org-wide
              desks' — and once they have set it, only they can lift it. */}
          <section className="space-y-2" data-testid="portal-controls-branch">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">This branch</p>
            <div className="flex flex-wrap gap-1.5">
              {["immediate", "approval", "off"].map((mode) => {
                const active = s.branch_mode === mode;
                const can = allowed.includes(mode) && !(s.branch_mode === "off" && !allowed.includes("off"));
                return (
                  <Button
                    key={mode}
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className={`h-8 text-xs ${active ? "bg-violet-600 text-white hover:bg-violet-700" : ""}`}
                    disabled={!!busy || active || !can}
                    onClick={() => setMode(mode)}
                    data-testid={`portal-controls-mode-${mode}`}
                  >
                    {MODE_LABEL[mode]}
                  </Button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500">{MODE_HELP[s.branch_mode]}</p>
            {s.branch_mode === "off" && !allowed.includes("off") && (
              <p className="text-[11px] text-amber-700">Turned off by Super Admin — only they can turn it back on.</p>
            )}
            {!s.auto_enabled && (
              <p className="text-[11px] text-amber-700">The whole clinic is off right now, so nothing is made automatically whatever this is set to.</p>
            )}
          </section>

          {/* Waiting for approval. Kept visible even when the branch has since switched back
              to immediate: those patients were booked while it was on approval, and switching
              does not make their logins for them. */}
          <section className="space-y-2" data-testid="portal-controls-pending">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Waiting for approval</p>
              <button type="button" onClick={load} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Refresh" title="Refresh">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            {pending.length === 0 ? (
              <p className="text-[11px] text-slate-400">Nobody is waiting.</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {pending.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`portal-pending-${p.lead_id}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{p.patient_name || "Patient"}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {[displayPhone(p.phone), p.email].filter(Boolean).join(" · ") || "no phone or email"}
                        {p.raised_at && <span className="text-slate-400"> · booked {when(p.raised_at)}</span>}
                      </span>
                    </span>
                    <Button size="sm" className="h-7 bg-violet-600 text-[11px] text-white hover:bg-violet-700" disabled={!!busy} onClick={() => approve(p)} data-testid={`portal-pending-approve-${p.lead_id}`}>
                      {busy === `approve-${p.id}` ? "Sending…" : "Approve & Send"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!!busy} onClick={() => dismiss(p)} data-testid={`portal-pending-dismiss-${p.lead_id}`}>
                      Dismiss
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <PortalLoginCreatedDialog portal={notice} onClose={() => setNotice(null)} />
    </div>
  );
}
