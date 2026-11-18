import { useEffect, useState } from "react";
import axios from "axios";
import { useParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { CLIENT_FIELDS, EMPTY_FORM, todayIso } from "@/components/branch/ConsultationFormSheets";
import { ClientFormStages, ClientThankYou } from "@/components/branch/ClientFormStages";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * Public, no login (/consult-form/<token>): the link Branch Admin sends from Settings >
 * Consultation Form > Request from Client. The patient answers their part of the paper
 * form in five short steps (components/branch/ClientFormStages) and sends it back once;
 * the filled paper itself is shown only to the clinic.
 * See routers/v3_consultation_forms.py for what the link may read and write.
 */
export const ClientConsultationFormPage = () => {
  const { token } = useParams();
  const [state, setState] = useState("loading"); // loading | open | done | submitted | invalid
  const [form, setForm] = useState(EMPTY_FORM);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "Consultation Form · Fitsiomax";
    axios
      .get(`${BACKEND_URL}/api/v3/public/consultation-forms/${token}`)
      .then(({ data }) => {
        setForm({ ...EMPTY_FORM, ...data.fields, date: data.fields?.date || todayIso() });
        setState(data.status === "open" ? "open" : "submitted");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  const submit = async (answers) => {
    const filled = { ...form, ...answers };
    setForm(filled);
    setSending(true);
    setError("");
    try {
      await axios.post(`${BACKEND_URL}/api/v3/public/consultation-forms/${token}`, {
        fields: Object.fromEntries(CLIENT_FIELDS.map((k) => [k, filled[k] || ""])),
      });
      setState("done");
      window.scrollTo({ top: 0 });
    } catch (e) {
      if (e?.response?.status === 409) setState("submitted");
      else setError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : "Couldn't send the form. Please check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const Notice = ({ icon: Icon, tone, title, text }) => (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-[4px] bg-white p-8 text-center shadow-sm" data-testid={`client-consult-form-${state}`}>
        <img src="/logo-icon-192.png" alt="Fitsiomax" className="mx-auto h-14 w-14 object-contain" />
        <Icon className={`mx-auto mt-4 h-10 w-10 ${tone}`} />
        <p className="mt-3 text-lg font-semibold text-slate-800">{title}</p>
        <p className="mt-1 text-sm text-slate-500">{text}</p>
      </div>
    </div>
  );

  if (state === "loading") {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (state === "invalid") return <Notice icon={XCircle} tone="text-rose-500" title="Link not valid" text="This form link is not valid. Please ask the clinic for a new one." />;
  if (state === "done") return <ClientThankYou />;
  if (state === "submitted") return <Notice icon={CheckCircle2} tone="text-emerald-500" title="Already submitted" text="This form has already been filled. Contact the clinic if you need to change anything." />;

  return <ClientFormStages form={form} sending={sending} error={error} onSubmit={submit} />;
};
