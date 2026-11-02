import { useEffect, useState } from "react";
import { Activity, AlertCircle, Camera, CheckCircle2, ClipboardList, Dumbbell, Eye, FileText, HeartPulse, IndianRupee, Lock, Music2, Salad, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLeadActivity, getLeadRemarks } from "@/lib/api";
import { displayPhone } from "@/lib/phone";
import { serviceTypeTitle } from "@/lib/serviceTypes";

/**
 * Branch Admin > Consultation's popup for a patient at Consultation Visit, drawn for Pre Sales
 * to read and nothing more: the same one-row header, the same six tabs, the Consultation
 * Record bar and the Collect a Payment panel with its Prescription and Collect Fees steps.
 *
 * Nothing on it acts. Filing the prescription and collecting the fee are the branch's, and
 * Pre Sales cannot read the patient's documents or case sheet (the backend's READ_ROLES), so
 * the uploader's buttons are drawn shut, the fee rows carry a state in place of Collect, and
 * the Documents and Progression tabs say where those live.
 *
 * Copied rather than imported from ConsultationsBoard, which this board does not pull in --
 * keep the two in step. The Overview takes the branch's .fee-flat and .fee-soft (index.css),
 * and its buttons keep the cons-* test ids those rules key off, so it is drawn exactly as the
 * branch's is.
 */

const DIET_KINDS = [
  { key: "dietConsultation", label: "Diet Consultation" },
  { key: "dietChart", label: "Diet Chart" },
];
const dietLabels = ({ diet, dietConsultation, dietChart }) => {
  if (!diet) return [];
  const on = { dietConsultation, dietChart };
  const picked = DIET_KINDS.filter((k) => on[k.key]);
  return picked.length ? picked.map((k) => k.label) : ["Diet"];
};
const weeksFromPackageName = (name) => {
  const match = (name || "").match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
};
const rs = (n) => `Rs.${Number(n).toLocaleString("en-IN")}`;

const TAB_ON = "border-sky-600 bg-sky-600 text-white shadow-sm hover:bg-sky-700 hover:text-white";
const ACT_BTN = "px-2 text-[11px] sm:px-3 sm:text-xs";

const Lbl = ({ full, short }) => (
  <>
    <span className="sm:hidden">{short}</span>
    <span className="hidden sm:inline">{full}</span>
  </>
);

const PanelChip = ({ tone = "amber", tick = false, children }) => (
  <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
    tone === "emerald" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
  }`}>
    {tick && <CheckCircle2 className="h-3 w-3" />} {children}
  </span>
);

// For a tab whose content Pre Sales has no access to.
const NoAccess = ({ title, children, testid }) => (
  <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" data-testid={testid}>
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-400">
      <Lock className="h-4 w-4" />
    </span>
    <p className="text-sm font-semibold text-slate-700">{title}</p>
    <p className="max-w-sm text-xs leading-relaxed text-slate-500">{children}</p>
  </div>
);

const ProfileRow = ({ label, value }) => (
  <div className="flex items-center justify-between"><span className="text-slate-500">{label}</span><span className="font-medium">{value}</span></div>
);

export const PreSalesConsultationVisitView = ({ lead, onClose }) => {
  const [tab, setTab] = useState("overview");
  const [recordOpen, setRecordOpen] = useState(false);
  const [remarks, setRemarks] = useState([]);
  const [activity, setActivity] = useState([]);

  const consultationPaid = lead.package_paid != null;
  // GET /leads stamps rx_on_file on Consultation Visit rows whose fee is still owed; once it
  // is paid the stamp is absent and the prescription no longer gates anything.
  const rxMissing = !consultationPaid && lead.rx_on_file === false;
  const hasRx = lead.rx_on_file === true;
  // Opens where the branch's does for this patient: on the prescription while it is owed.
  const [step, setStep] = useState(rxMissing ? "documents" : "fees");

  useEffect(() => {
    setTab("overview");
    setRecordOpen(false);
    setStep(rxMissing ? "documents" : "fees");
  }, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "timeline") return;
    getLeadRemarks(lead.id).then(setRemarks).catch(() => setRemarks([]));
    getLeadActivity(lead.id).then(setActivity).catch(() => setActivity([]));
  }, [lead.id, tab]);

  // --- Consultation Record ---------------------------------------------------------------
  const written = (lead.physio_diagnosis_report || "").trim();
  const presales = (lead.diagnosis || "").trim();
  const treatment = (lead.treatment_summary || "").trim();
  const hasRecord = !!(written || presales || treatment || lead.consultation_decision);

  const plan = lead.consultation_decision ? (() => {
    const onTreatment = lead.consultation_decision === "consultation_treatment";
    const weeks = weeksFromPackageName(lead.session_package_name);
    const total = lead.session_package_sessions || 0;
    const perWeek = weeks && total ? Math.round(total / weeks) : 0;
    const rows = [
      onTreatment && {
        icon: Activity,
        label: "Treatment Package",
        value: lead.session_package_name || "Not named",
        note: perWeek && weeks ? `${perWeek} weekly × ${weeks} week${weeks === 1 ? "" : "s"} = ${total} sessions` : total ? `${total} sessions` : null,
      },
      lead.diet_recommended && {
        icon: Salad,
        label: "Diet",
        value: dietLabels({ diet: true, dietConsultation: !!lead.diet_consultation, dietChart: !!lead.diet_chart }).join(" + "),
      },
      lead.rehab_referred && {
        icon: HeartPulse,
        label: "Rehab Package",
        value: lead.rehab_package_name || "Referred",
        note: lead.rehab_package_sessions ? `${lead.rehab_package_sessions} sessions` : null,
      },
      lead.fitness_recommended && { icon: Dumbbell, label: "Fitness", value: "Referred" },
      lead.zumba_recommended && { icon: Music2, label: "Zumba Plan", value: lead.zumba_package_name || "Referred" },
    ].filter(Boolean);
    const label = [
      "Consultation",
      onTreatment ? "Treatment" : null,
      ...dietLabels({ diet: !!lead.diet_recommended, dietConsultation: !!lead.diet_consultation, dietChart: !!lead.diet_chart }),
      lead.rehab_referred ? "Rehab" : null,
      lead.fitness_recommended ? "Fitness" : null,
      lead.zumba_recommended ? "Zumba" : null,
    ].filter(Boolean).join(" + ");
    return { label, rows };
  })() : null;

  const recordCells = [
    {
      key: "diagnosis",
      label: written ? "Diagnosis" : "Diagnosis · Pre-Sales",
      full: (written || presales) && (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-xs leading-5 text-slate-800">{written || presales}</p>
          {written && presales && (
            <div className="rounded-md bg-slate-50 px-2.5 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Pre-Sales</p>
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600">{presales}</p>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "treatment",
      label: "Treatment Summary",
      full: treatment && (() => {
        const items = treatment.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        return items.length > 1 ? (
          <ol className="space-y-1">
            {items.map((t, i) => (
              <li key={i} className="flex gap-2 text-xs leading-5 text-slate-800">
                <span className="w-4 shrink-0 text-right font-semibold text-slate-400">{i + 1}.</span>
                <span className="min-w-0">{t}</span>
              </li>
            ))}
          </ol>
        ) : <p className="whitespace-pre-wrap text-xs leading-5 text-slate-800">{treatment}</p>;
      })(),
    },
    {
      key: "plan",
      label: "Plan",
      full: plan && (
        <>
          <p className="text-xs font-semibold text-slate-800">{plan.label}</p>
          {plan.rows.length > 0 ? (
            <div className="mt-2 rounded-md border border-slate-200 bg-white">
              <dl className="divide-y divide-slate-100">
                {plan.rows.map((r) => {
                  const Icon = r.icon;
                  return (
                    <div key={r.label} className="flex items-baseline justify-between gap-3 px-2.5 py-1.5">
                      <dt className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500"><Icon className="h-3 w-3 text-slate-400" /> {r.label}</dt>
                      <dd className="min-w-0 truncate text-right text-xs font-semibold text-slate-800" title={r.value}>
                        {r.value}
                        {r.note && <span className="ml-1 font-medium text-slate-400">· {r.note}</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ) : <p className="mt-1 text-[11px] text-slate-500">A plain consultation — nothing else was recommended.</p>}
        </>
      ),
    },
  ];

  // --- Fees --------------------------------------------------------------------------------
  const unpaid = (lead.package_payment_details?.installments || []).filter((x) => !x.paid);
  const consultationBalance = unpaid.length ? unpaid.reduce((s, x) => s + Number(x.amount || 0), 0) : null;
  const treatmentPaid = lead.treatment_fee_paid != null;
  const fees = [
    {
      key: "consultation",
      label: "Consultation Fee",
      amount: lead.package_price,
      paid: consultationPaid && consultationBalance == null,
      balance: consultationBalance,
      waiting: rxMissing ? "Waiting on the prescription" : null,
    },
    lead.consultation_decision === "consultation_treatment" && {
      key: "treatment",
      label: "Treatment Fee",
      sub: lead.session_package_name
        ? `${lead.session_package_name}${lead.session_package_sessions ? ` · ${lead.session_package_sessions} sessions` : ""}`
        : null,
      amount: lead.session_package_price,
      paid: treatmentPaid,
      waiting: !consultationPaid ? "After the Consultation Fee" : null,
    },
  ].filter(Boolean);

  const FeeSteps = (
    <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" data-testid="presales-consult-view-fees">
      {fees.map((f, i) => {
        const owing = !f.paid && f.balance != null;
        const amount = owing ? rs(f.balance) : f.amount != null ? rs(f.amount) : "";
        const tone = f.paid ? "text-emerald-700" : owing ? "text-amber-700" : "text-slate-800";
        return (
          <div key={f.key} className={`flex items-center gap-3 px-3 py-2.5 ${f.paid ? "bg-emerald-50/60" : ""}`} data-testid={`cons-fee-step-${f.key}`}>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${f.paid ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500"}`}>
              {f.paid ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-slate-700">{f.label}</p>
              {f.sub && <p className="truncate text-[11px] text-slate-400" title={f.sub}>{f.sub}</p>}
              {amount && <p className={`text-sm font-bold tabular-nums sm:hidden ${tone}`}>{amount}</p>}
              {!f.paid && f.waiting && <p className="truncate text-[11px] font-medium text-amber-600">{f.waiting}</p>}
            </div>
            <p className={`hidden min-w-[4.5rem] shrink-0 text-right text-sm font-bold tabular-nums sm:block ${tone}`}>{amount}</p>
            {/* A state where the branch has Collect: Pre Sales reads the fee, it does not take it. */}
            <div className="flex min-w-[5.5rem] shrink-0 justify-end sm:min-w-[6.5rem]">
              {f.paid ? (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Paid</span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700" title="Collected by Branch Admin">
                  <IndianRupee className="h-3.5 w-3.5" /> {owing ? "Balance Due" : "Due"}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  // The branch's prescription step with its uploader drawn shut.
  const DocumentsBody = (
    <div className="space-y-4" data-testid="presales-consult-view-documents">
      {rxMissing && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>Upload the prescription before collecting the fee — the photo or scan is the record of what the Consultant prescribed.</span>
        </p>
      )}
      <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-sky-800">
            <FileText className="h-3.5 w-3.5" />Prescription
            {!consultationPaid && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-sky-700">Required to collect the fee</span>}
          </p>
          {hasRx && <span className="shrink-0 text-[11px] font-semibold text-emerald-600">On file</span>}
        </div>
        {hasRx || consultationPaid ? (
          <p className="py-2 text-center text-xs text-slate-500">The prescription is filed with Branch Admin.</p>
        ) : (
          <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700">Upload prescription pages</p>
            <p className="mt-0.5 text-[11px] text-slate-500">Drop a file here, or choose one · JPG, PNG, WEBP or PDF</p>
            <div className="mt-2 flex flex-wrap items-center gap-2" title="View only — Branch Admin files the prescription">
              <Button size="sm" className="bg-sky-600 hover:bg-sky-700" disabled data-testid="presales-consult-view-camera">
                <Camera className="mr-1.5 h-4 w-4" />Camera
              </Button>
              <Button size="sm" variant="outline" className="border-sky-200 text-sky-700 hover:bg-sky-50" disabled data-testid="presales-consult-view-choose">
                <Upload className="mr-1.5 h-4 w-4" />Choose File
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const followUps = lead.consultation_follow_ups || [];
  const events = [
    ...remarks.map((r) => ({ ...r, _kind: "remark" })),
    ...activity.map((a) => ({ ...a, _kind: "activity" })),
  ].sort((x, y) => new Date(x.created_at) - new Date(y.created_at));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-2" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="presales-consult-view">
      <div className="flex max-h-[85dvh] w-full max-w-[570px] flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl ring-1 ring-slate-900/5 sm:h-[min(610px,calc(100dvh-1rem))] sm:max-h-none">
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1 self-center">
            <h3 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-slate-900">
              <span className="truncate">{lead.name || "Lead"}</span>
              {lead.patient_number && (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-500">{lead.patient_number}</span>
              )}
              <span className="shrink-0 text-sm font-medium text-slate-500">{displayPhone(lead.phone) || "—"}</span>
              {/* The branch's Appointment Card eye, shown but not opened from here. */}
              {lead.appointment_date && (
                <span className="shrink-0 text-teal-400" title="Appointment Card — opened from Branch Admin" aria-label="Appointment Card">
                  <Eye className="h-5 w-5" />
                </span>
              )}
            </h3>
          </div>
          <button onClick={onClose} className="shrink-0 rounded p-1 text-black hover:bg-slate-100" data-testid="presales-consult-view-close">
            <X className="h-5 w-5" strokeWidth={3} />
          </button>
        </div>

        <div className="flex shrink-0 flex-nowrap items-center gap-x-4 overflow-x-auto border-b border-slate-200 px-4 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-5 [&::-webkit-scrollbar]:hidden">
          {[
            { key: "overview", label: "Overview" },
            { key: "followup", label: "Follow up" },
            { key: "documents", label: "Documents" },
            { key: "progression", label: "Progression" },
            { key: "timeline", label: "Timeline" },
            { key: "profile", label: "Profile" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 py-2.5 text-xs font-semibold transition-colors ${tab === t.key ? "border-sky-600 text-sky-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              data-testid={`presales-consult-view-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-[10px]">
          {tab === "overview" && (
            <div className="fee-flat fee-soft flex flex-col gap-3">
              {hasRecord && (
                <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                  <button
                    type="button"
                    onClick={() => setRecordOpen((o) => !o)}
                    aria-expanded={recordOpen}
                    className="group flex w-full items-center gap-2 px-4 py-2.5 text-left transition hover:bg-slate-50"
                    data-testid="cons-case-record-open"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <ClipboardList className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-slate-600">Consultation Record</span>
                    {recordOpen ? (
                      <span className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 shadow-sm transition group-hover:border-slate-300 group-hover:bg-slate-100" data-testid="cons-case-record-close">
                        <X className="h-3.5 w-3.5" /> Close
                      </span>
                    ) : (
                      <span className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-700 shadow-sm transition group-hover:border-sky-300 group-hover:bg-sky-100" data-testid="cons-case-record-view">
                        <Eye className="h-3.5 w-3.5" /> View Details
                      </span>
                    )}
                  </button>
                  {recordOpen && (
                    <div className="space-y-3 border-t border-slate-100 p-4">
                      {recordCells.map((c) => (
                        <div key={c.key} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{c.label}</p>
                          {c.full || <p className="text-xs italic text-slate-400">Not written yet</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* StagePanel, tone sky, as the branch draws Consultation Visit. */}
              <div className="overflow-hidden rounded-xl border border-sky-200/80 bg-gradient-to-br from-sky-50 via-sky-50/60 to-white shadow-sm ring-1 ring-inset ring-white/60" data-testid="presales-consult-view-panel">
                <div className="flex items-center justify-between gap-3 border-b border-sky-100 px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-600/10 text-sky-700">
                      <IndianRupee className="h-4 w-4" />
                    </span>
                    <span className="truncate text-xs font-semibold uppercase tracking-wider text-sky-800">Collect a Payment</span>
                  </div>
                  {consultationPaid ? <PanelChip tone="emerald" tick>Consultation Fee In</PanelChip> : <PanelChip>Payment Due</PanelChip>}
                </div>
                <div className={step === "documents" ? "p-4" : "p-0"}>
                  <div className={`flex flex-wrap items-center gap-2 border-b border-slate-200/70 pb-3 [&>*]:shrink-0 ${step === "documents" ? "" : "px-4 pt-4"}`}>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`${step === "documents"
                        ? TAB_ON
                        : rxMissing
                        ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                        : "border-slate-200 bg-white/70 text-slate-600 hover:bg-white"} ${ACT_BTN}`}
                      onClick={() => setStep("documents")}
                      data-testid="presales-consult-view-step-rx"
                    >
                      <FileText className="mr-1 h-3.5 w-3.5" />
                      <Lbl full={rxMissing ? "Prescription — required" : "Prescription"} short="Rx" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rxMissing}
                      title={rxMissing ? "Upload the prescription first" : undefined}
                      className={`${rxMissing
                        ? "border-slate-200 bg-slate-50 text-slate-400"
                        : step === "fees" ? TAB_ON : "border-slate-200 bg-white/70 text-slate-600 hover:bg-white"} ${ACT_BTN}`}
                      onClick={() => setStep("fees")}
                      data-testid="presales-consult-view-step-fees"
                    >
                      <IndianRupee className="mr-1 h-3.5 w-3.5" />
                      <Lbl full={consultationPaid ? "Payment" : "Collect Fees"} short="Fees" />
                    </Button>
                  </div>
                  <div className="mt-3">{step === "documents" ? DocumentsBody : FeeSteps}</div>
                </div>
              </div>
            </div>
          )}

          {tab === "followup" && (
            <div className="space-y-1.5" data-testid="presales-consult-view-followups">
              {followUps.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">No follow-ups scheduled yet.</p>
              ) : followUps.slice().reverse().map((f) => {
                const isActive = f.status !== "rescheduled";
                return (
                  <div key={f.id} className={`rounded-lg border p-2.5 text-xs ${isActive ? "border-orange-200 bg-orange-50/60" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
                    <p className={`font-semibold ${isActive ? "text-orange-700" : "text-slate-400 line-through"}`}>{f.date} at {f.time}</p>
                    {f.consultant_name && <p className="mt-0.5 text-[11px] font-medium text-slate-500">with {f.consultant_name}</p>}
                    {f.remarks && <p className="mt-0.5 text-slate-600">{f.remarks}</p>}
                    {f.status === "rescheduled" && f.reschedule_reason && <p className="mt-0.5 italic text-slate-400">Rescheduled: {f.reschedule_reason}</p>}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "documents" && (
            <NoAccess title="Documents are with Branch Admin" testid="presales-consult-view-documents-tab">
              Prescriptions, reports and scans are filed and opened at the branch.
              {hasRx ? " A prescription is on file." : rxMissing ? " No prescription is on file yet." : ""}
            </NoAccess>
          )}

          {tab === "progression" && (
            <NoAccess title="Progression is with the branch" testid="presales-consult-view-progression-tab">
              The case sheet's clips, review and verification are kept by the treating physio and the Consultant.
            </NoAccess>
          )}

          {tab === "timeline" && (
            <div className="space-y-3" data-testid="presales-consult-view-timeline">
              {events.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">No timeline events yet</p>
              ) : (
                <ol className="ml-3 space-y-4 border-l-2 border-slate-200 py-1 pl-6">
                  {events.map((h) => (
                    <li key={`${h._kind}-${h.id}`} className="relative">
                      <span className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white ${h._kind === "remark" ? "bg-amber-400" : "bg-sky-500"}`} />
                      <div className={`rounded-lg border p-3 ${h._kind === "remark" ? "border-amber-100 bg-amber-50/50" : "border-slate-100 bg-slate-50"}`}>
                        <p className="text-sm text-slate-700">{h._kind === "remark" ? h.text : h.details}</p>
                        <p className="mt-1 text-[10px] text-slate-400">{h.created_by} · {h.created_at?.slice(0, 16).replace("T", " ")}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === "profile" && (
            <div className="space-y-3" data-testid="presales-consult-view-profile">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-600">Contact</p>
                <div className="space-y-1.5 text-xs text-slate-700">
                  <ProfileRow label="Phone" value={displayPhone(lead.phone) || "—"} />
                  <ProfileRow label="Alternative Phone" value={displayPhone(lead.alternative_phone) || "—"} />
                  <ProfileRow label="Email" value={lead.email || "—"} />
                  <ProfileRow label="Address" value={lead.address || "—"} />
                  <ProfileRow label="City / State" value={[lead.city, lead.state].filter(Boolean).join(", ") || "—"} />
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-600">Profile</p>
                <div className="space-y-1.5 text-xs text-slate-700">
                  <ProfileRow label="Age" value={lead.age ?? "—"} />
                  <ProfileRow label="Gender" value={lead.gender || "—"} />
                  <ProfileRow label="Occupation" value={lead.occupation || "—"} />
                  <ProfileRow label="Department" value={serviceTypeTitle(lead.department) || "—"} />
                  <ProfileRow label="Condition" value={lead.condition || "—"} />
                  <ProfileRow label="Months of Pain" value={lead.months_of_pain ?? "—"} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
