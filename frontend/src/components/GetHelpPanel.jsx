import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { sendHelpRequest } from "@/lib/api";
import { toast } from "@/components/ui/sonner";

// The same labels, in the same order, as HELP_TOPICS in backend/routers/v3_me.py.
const TOPICS = [
  "Technical Issue",
  "Report a Bug",
  "Account & Access Support",
  "How to Use",
  "Feature Request",
  "General Feedback",
  "Other",
];

/**
 * My Profile's Get Help: a 270 x 370 panel in the bottom-left corner, over the sidebar it
 * was opened from. A topic, a few words, Submit Request. Portalled to the body so no
 * transformed parent can clip it; Escape or the X closes it.
 */
export function GetHelpPanel({ onClose }) {
  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ready = topic && (topic !== "Other" || message.trim());

  const submit = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      await sendHelpRequest({ topic, message: message.trim() });
      toast.success("Request sent");
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not send. Try again.");
      setSending(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-label="Get Help"
      className="fixed bottom-4 left-4 z-50 flex h-[370px] max-h-[calc(100vh-2rem)] w-[270px] max-w-[calc(100vw-2rem)] flex-col rounded-[4px] border border-slate-200 bg-white shadow-xl"
      data-testid="get-help-panel"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold text-slate-900">Get Help</h2>
        <button type="button" onClick={onClose} className="-mr-1 rounded p-0.5 text-slate-500 hover:text-slate-900" aria-label="Close" data-testid="get-help-close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        <p className="mt-0.5 text-[11px] text-slate-500">How can we help you? Select an option below.</p>
        <div role="radiogroup" aria-label="Topic" className="mt-2 space-y-0.5">
          {TOPICS.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-700 hover:bg-slate-50" data-testid={`get-help-topic-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <input
                type="radio"
                name="get-help-topic"
                value={t}
                checked={topic === t}
                onChange={() => setTopic(t)}
                className="h-3.5 w-3.5 shrink-0 accent-sky-600"
              />
              {t}
            </label>
          ))}
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
          placeholder="Describe your issue or share your feedback..."
          className="mt-2 h-16 w-full resize-none rounded-[4px] border border-slate-200 px-2 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
          data-testid="get-help-message"
        />
      </div>

      <div className="flex shrink-0 justify-end border-t border-slate-100 px-4 py-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || sending}
          className="inline-flex items-center gap-1.5 rounded-full bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-sky-600/30 transition hover:-translate-y-px hover:bg-sky-700 hover:shadow-xl disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          data-testid="get-help-submit"
        >
          {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Submit Request
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default GetHelpPanel;
