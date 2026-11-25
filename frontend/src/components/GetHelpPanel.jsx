import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Paperclip, X } from "lucide-react";
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

// The same limits as HELP_IMAGES_MAX / HELP_IMAGE_MAX_BYTES on the backend.
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * My Profile's Get Help: a 420 x 660 panel in the bottom-right corner. Any number of
 * topics, a few words, up to three images, Submit Request. An image comes in two ways:
 * Attach (a file) or paste (Ctrl + V of a screenshot). Portalled to the body so no
 * transformed parent can clip it; Escape or the X closes it.
 */
export function GetHelpPanel({ onClose }) {
  const [topics, setTopics] = useState([]);
  const [message, setMessage] = useState("");
  const [images, setImages] = useState([]); // { id, file, url }
  const [sending, setSending] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The previews' object URLs are let go when the panel closes.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.url)), []);

  // Kept in the list's own order, whatever order they were ticked in.
  const toggle = (t) => setTopics((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : TOPICS.filter((x) => x === t || cur.includes(x))));

  const addImages = (files) => {
    const room = MAX_IMAGES - images.length;
    const ok = [];
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) { toast.error("Only PNG, JPG or WebP images"); continue; }
      if (file.size > MAX_IMAGE_BYTES) { toast.error("Each image must be under 5 MB"); continue; }
      if (ok.length >= room) { toast.error(`Up to ${MAX_IMAGES} images`); break; }
      ok.push({ id: `${Date.now()}-${Math.random()}`, file, url: URL.createObjectURL(file) });
    }
    if (ok.length) setImages((cur) => [...cur, ...ok]);
  };

  const removeImage = (id) => setImages((cur) => {
    const gone = cur.find((img) => img.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    return cur.filter((img) => img.id !== id);
  });

  const onPick = (e) => {
    addImages([...(e.target.files || [])]);
    e.target.value = ""; // the same file can be picked again after removing it
  };

  // A screenshot on the clipboard pastes in as an image; plain text pastes as usual.
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };

  const ready = topics.length > 0 && (!topics.includes("Other") || message.trim());
  const full = images.length >= MAX_IMAGES;

  const submit = async () => {
    if (!ready || sending) return;
    setSending(true);
    const form = new FormData();
    topics.forEach((t) => form.append("topics", t));
    form.append("message", message.trim());
    images.forEach((img) => form.append("images", img.file, img.file.name || "image"));
    try {
      await sendHelpRequest(form);
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
      onPaste={onPaste}
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

        {images.length > 0 && (
          <div className="mt-2 flex shrink-0 gap-2" data-testid="get-help-images">
            {images.map((img, i) => (
              <div key={img.id} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[4px] border border-slate-200 bg-slate-50">
                <img src={img.url} alt={`Image ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900/70 text-white hover:bg-slate-900"
                  aria-label={`Remove image ${i + 1}`}
                  data-testid={`get-help-image-remove-${i}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1.5 shrink-0 text-[11px] text-slate-400">Up to {MAX_IMAGES} images. Attach, or paste a screenshot (Ctrl + V).</p>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-slate-100 px-4 py-3">
        <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(",")} multiple onChange={onPick} className="hidden" data-testid="get-help-file" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={full}
          className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Attach image"
          title="Attach image"
          data-testid="get-help-attach"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        {images.length > 0 && <span className="ml-1 text-[11px] tabular-nums text-slate-400" data-testid="get-help-image-count">{images.length}/{MAX_IMAGES}</span>}

        <button
          type="button"
          onClick={submit}
          disabled={!ready || sending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-600/30 transition hover:-translate-y-px hover:bg-sky-700 hover:shadow-xl disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
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
