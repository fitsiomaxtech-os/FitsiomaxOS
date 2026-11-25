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
 * My Profile's Get Help: a 420 x 660 panel in the bottom-right corner. Any number of
 * topics, a few words, Submit Request. Portalled to the body so no transformed parent can
 * clip it; Escape or the X closes it.
 */
export function GetHelpPanel({ onClose }) {
  const [topics, setTopics] = useState([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Kept in the list's own order, whatever order they were ticked in.
  const toggle = (t) => setTopics((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : TOPICS.filter((x) => x === t || cur.includes(x))));

  const ready = topics.length > 0 && (!topics.includes("Other") || message.trim());

  const submit = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      await sendHelpRequest({ topics, message: message.trim() });
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
      className="fixed bottom-4 right-4 z-50 flex h-[660px] max-h-[calc(100vh-2rem)] w-[420px] max-w-[calc(100vw-2rem)] flex-col rounded-[4px] border border-slate-200 bg-white shadow-xl"
      data-testid="get-help-panel"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-5 pt-4">
        <h2 className="text-base font-semibold text-slate-900">Get Help</h2>
        <button type="button" onClick={onClose} className="-mr-1 rounded p-0.5 text-slate-500 hover:text-slate-900" aria-label="Close" data-testid="get-help-close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4">
        <p className="mt-1 text-sm text-slate-500">How can we help you? Select an option below.</p>
        <div role="group" aria-label="Topics" className="mt-3 space-y-1">
          {TOPICS.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-3 rounded px-1.5 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid={`get-help-topic-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <input
                type="checkbox"
                value={t}
                checked={topics.includes(t)}
                onChange={() => toggle(t)}
                className="h-4 w-4 shrink-0 accent-sky-600"
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
          className="mt-3 min-h-[7rem] w-full flex-1 resize-none rounded-[4px] border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
          data-testid="get-help-message"
        />
      </div>

      <div className="flex shrink-0 justify-end border-t border-slate-100 px-5 py-3">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || sending}
          className="inline-flex items-center gap-1.5 rounded-full bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-600/30 transition hover:-translate-y-px hover:bg-sky-700 hover:shadow-xl disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          data-testid="get-help-submit"
        >
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          Submit Request
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default GetHelpPanel;
