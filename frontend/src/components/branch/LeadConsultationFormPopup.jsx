import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import {
  createConsultationForm,
  getBranches,
  getConsultationForm,
  listConsultationForms,
  updateConsultationForm,
} from "@/lib/api";
import { branchNameOf } from "@/lib/branchOrder";
import { EMPTY_FORM, formBranchName, formBranchesFrom, formFromLead, todayIso } from "@/components/branch/ConsultationFormSheets";
import { ClientFormStages } from "@/components/branch/ClientFormStages";

/**
 * Branch Admin's lead popup > Form: the Consultation Form's steps (the client link's own,
 * ClientFormStages), over the app. It opens already filled with what the lead holds -- and
 * with the lead's saved form, should it have one: those answers win, the lead fills what
 * the form left blank. Name, Mobile Number and Branch must be there; the rest is optional.
 *
 * Submit saves it as the lead's Consultation Form (tied by lead_id, so the next Form opens
 * the same one). The three-page paper is only the report of it, in Settings >
 * Consultation Form; the clinic's own part (diagnosis, treatment) is kept as it was.
 *
 * With no `lead` it is Settings > Consultation Form's New Form: the same steps, blank but
 * for today's date and the branch's own name, saved as a form of its own. `onSaved` lets
 * the list behind it reload.
 */

// The steps' "Your Place" takes a city: the first part of "Chennai, Tamil Nadu", letters only.
const cityOnly = (v) => String(v || "").split(",")[0].replace(/[^A-Za-z .'-]/g, "").replace(/ {2,}/g, " ").trim();
const filled = (v) => String(v ?? "").trim() !== "";

export const LeadConsultationFormPopup = ({ lead = null, branchId, onClose, onSaved }) => {
  const leadId = lead?.id || null;
  const [ready, setReady] = useState(null); // { form, branches, savedId, saved }
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const [branchRows, found] = await Promise.all([
        getBranches().catch(() => []),
        leadId ? listConsultationForms(branchId, "", { leadId }).catch(() => ({ forms: [] })) : { forms: [] },
      ]);
      const mine = leadId ? (found.forms || []).find((f) => f.lead_id === leadId) : null;
      let saved = null;
      if (mine) {
        try { saved = await getConsultationForm(branchId, mine.id); } catch { saved = null; }
      }
      if (!live) return;
      const fromLead = lead ? formFromLead(lead) : { ...EMPTY_FORM, date: todayIso() };
      const home = formBranchName(branchNameOf((branchRows || []).find((b) => b.id === branchId)));
      const base = { ...fromLead, branch: home };
      // The saved form's answers first; the lead's details fill only what it left blank.
      const form = saved
        ? Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, filled(saved[k]) ? String(saved[k]) : base[k] || ""]))
        : base;
      setReady({
        form: { ...form, place: cityOnly(form.place) },
        branches: formBranchesFrom(branchRows),
        savedId: saved ? mine.id : null,
        saved,
      });
    })();
    return () => { live = false; };
    // Once per lead: the lead popup hands a fresh object on every render, and a refetch
    // would put the steps back to their start under the desk's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, leadId]);

  const submit = async (answers) => {
    setSending(true);
    setError("");
    try {
      if (ready.savedId) {
        // The whole form goes back, the clinic's part as saved, so nothing of it is cleared.
        const whole = Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, String(ready.saved?.[k] ?? "")]));
        await updateConsultationForm(branchId, ready.savedId, { ...whole, ...answers });
        toast.success("Consultation form updated");
      } else {
        await createConsultationForm(branchId, { ...EMPTY_FORM, ...answers }, { leadId });
        toast.success("Consultation form saved");
      }
      onSaved?.();
      onClose();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Couldn't save the form. Please try again.");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto overflow-x-hidden bg-slate-900/50 backdrop-blur-sm"
      data-cs-scroll
      data-testid="lead-consultation-form-popup"
    >
      {ready ? (
        <ClientFormStages form={ready.form} branches={ready.branches} sending={sending} error={error} onSubmit={submit} onClose={onClose} />
      ) : (
        <div className="flex min-h-full items-center justify-center text-white/80"><Loader2 className="h-6 w-6 animate-spin" /></div>
      )}
    </div>
  );
};
