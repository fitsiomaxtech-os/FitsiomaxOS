import { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquareText, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getAppointmentMessage, saveAppointmentMessage } from "@/lib/api";
import { APPT_MSG_PLACEHOLDERS, APPT_MSG_SAMPLE, fillAppointmentMessage } from "@/lib/appointmentMessage";

const MAX_LEN = 2000;

/**
 * Settings > Appointment Msg Editor: the WhatsApp welcome Pre Sales sends for a booking at
 * this branch, worded here. The {placeholders} are filled as the message is sent; the
 * preview fills them with a sample so the desk sees what the patient will read.
 *
 * A plain overlay, like Upcoming Appointments beside it in the same menu.
 */
export const AppointmentMessageEditor = ({ branchId, onClose }) => {
  const [text, setText] = useState("");
  const [standard, setStandard] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    let live = true;
    getAppointmentMessage(branchId)
      .then((r) => { if (!live) return; setText(r.template); setSaved(r.template); setStandard(r.default); })
      .catch((e) => { if (live) toast.error(e?.response?.data?.detail || "Couldn't load the appointment message"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId]);

  // The chip goes in where the cursor is, and the cursor lands after it.
  const insert = (key) => {
    const el = boxRef.current;
    const token = `{${key}}`;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    setText(text.slice(0, at) + token + text.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveAppointmentMessage(branchId, text);
      setText(r.template);
      setSaved(r.template);
      toast.success(r.is_default ? "Standard appointment message restored" : "Appointment message saved");
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the appointment message");
    } finally {
      setSaving(false);
    }
  };

  const dirty = text !== saved;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="appointment-message-dialog">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <p className="flex items-center gap-2 text-base font-semibold text-slate-800"><MessageSquareText className="h-4 w-4 text-sky-600" />Appointment Msg Editor</p>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="appointment-message-close"><X className="h-4 w-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="grid gap-4 overflow-y-auto p-4 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-xs text-slate-500">
                The WhatsApp message sent with an appointment at this branch. Tap a field to put it where the cursor is — it is filled in for each patient as the message is sent. A line whose field is empty is left out.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {APPT_MSG_PLACEHOLDERS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => insert(p.key)}
                    className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-100"
                    title={`{${p.key}}`}
                    data-testid={`appointment-message-field-${p.key}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={boxRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={MAX_LEN}
                rows={14}
                className="w-full resize-y rounded border border-slate-200 p-3 font-mono text-[13px] leading-relaxed text-slate-800 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
                data-testid="appointment-message-text"
              />
              <p className="text-right text-[11px] text-slate-400">{text.length} / {MAX_LEN}</p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</p>
              <div className="flex-1 rounded bg-[#e5ddd5] p-3">
                <div className="whitespace-pre-wrap break-words rounded-lg bg-[#dcf8c6] px-3 py-2 text-[13px] leading-relaxed text-slate-800 shadow-sm" data-testid="appointment-message-preview">
                  {fillAppointmentMessage(text, APPT_MSG_SAMPLE) || <span className="text-slate-400">The standard message is sent when this is left blank.</span>}
                </div>
              </div>
              <p className="text-[11px] text-slate-400">Home visits and Google Meet consultations keep the standard wording.</p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setText(standard)} disabled={loading || saving || text === standard} className="gap-1.5 text-slate-500" data-testid="appointment-message-reset">
            <RotateCcw className="h-3.5 w-3.5" />Standard message
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={save} disabled={loading || saving || !dirty} className="bg-sky-600 hover:bg-sky-700" data-testid="appointment-message-save">
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
