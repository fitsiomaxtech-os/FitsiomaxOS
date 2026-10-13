import { useEffect, useState } from "react";
import { Calendar, ClipboardList, IndianRupee, PhoneCall, UserRound } from "lucide-react";
import { getClientPortalPreview } from "@/lib/api";
import { LeadDocuments } from "@/components/LeadDocuments";
import { telNumber } from "@/lib/phone";
import { SessionsTab, TreatmentTab, PaymentTab } from "@/pages/PatientPortalPage";

// Operations' Client tab: the same four tabs the patient sees on their own /portal
// login (Overview / Sessions / Treatment / Payment History), reached the way every other
// Operations tab reaches a board — pick a branch, pick a person, see exactly what they'd
// see — so a Super Admin never needs the patient's own portal password to check on them.
// Sessions/Treatment/Payment History are the exact same components the patient portal
// itself renders; only Overview is rebuilt here, since the patient portal's version
// fetches documents with the *patient's* own bearer token, which staff don't have.
const TABS = [
  { key: "overview", label: "Overview", icon: UserRound },
  { key: "sessions", label: "Sessions", icon: Calendar },
  { key: "treatment", label: "Treatment", icon: ClipboardList },
  { key: "payment", label: "Payment History", icon: IndianRupee },
];

const Row = ({ label, value }) => (
  !value ? null : (
    <div>
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-xs text-slate-700">{value}</p>
    </div>
  )
);

const OverviewTab = ({ data, leadId }) => (
  <div className="space-y-4" data-testid="client-portal-preview-overview-tab">
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Your Details</p>
      <div className="grid grid-cols-2 gap-3">
        <Row label="Patient Number" value={data.patient_number} />
        <Row label="Phone" value={data.phone} />
        <Row label="Email" value={data.email} />
        <Row label="Age" value={data.age} />
        <Row label="Gender" value={data.gender} />
        <Row label="Occupation" value={data.occupation} />
        <Row label="Address" value={data.address} />
        <Row label="City / State" value={[data.city, data.state].filter(Boolean).join(", ")} />
        <Row label="Condition" value={data.condition} />
      </div>
    </div>

    {(data.head_physio_name || data.physio_name) && (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Care Team</p>
        <div className="space-y-2">
          <Row label="CONSULTANT" value={data.head_physio_name} />
          <Row label="Physio" value={data.physio_name} />
        </div>
      </div>
    )}

    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Documents</p>
      <LeadDocuments leadId={leadId} canEdit={false} />
    </div>

    {(data.branch_name || data.branch_phone) && (
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-600">Branch</p>
        <p className="text-sm font-semibold text-slate-800">{data.branch_name}</p>
        {data.branch_address && <p className="mt-0.5 text-xs text-slate-600">{data.branch_address}</p>}
        {data.branch_phone && (
          <a
            href={`tel:${telNumber(data.branch_phone)}`}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
            data-testid="client-portal-preview-call-branch"
          >
            <PhoneCall className="h-3.5 w-3.5" /> Call Branch
          </a>
        )}
      </div>
    )}
  </div>
);

export const ClientPortalPreview = ({ leadId }) => {
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setTab("overview");
    setLoading(true);
    setError(null);
    getClientPortalPreview(leadId)
      .then(setData)
      .catch((e) => setError(e?.response?.data?.detail || "Unable to load this client's portal"))
      .finally(() => setLoading(false));
  }, [leadId]);

  if (loading) return <p className="py-10 text-center text-sm text-slate-400">Loading...</p>;
  if (error || !data) return <p className="py-10 text-center text-sm text-rose-500">{error || "Unable to load this client's portal"}</p>;

  return (
    <div className="space-y-4" data-testid="client-portal-preview">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="client-portal-preview-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              data-testid={`client-portal-preview-tab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab data={data} leadId={leadId} />}
      {tab === "sessions" && <SessionsTab data={data} />}
      {tab === "treatment" && <TreatmentTab data={data} />}
      {tab === "payment" && <PaymentTab data={data} />}
    </div>
  );
};

export default ClientPortalPreview;
