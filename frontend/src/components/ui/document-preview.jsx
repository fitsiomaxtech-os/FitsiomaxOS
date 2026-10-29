import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import { ZoomableImage, ZoomablePdf } from "@/components/ui/zoomable-view";

/**
 * A patient's document, read on the page that listed it.
 *
 * Every document route is authenticated, so the bytes arrive as a blob rather than at a
 * URL a browser can be pointed at. The obvious thing to do with the object URL that comes
 * back is hand it to window.open — and that is what the Physio board did, which took the
 * physio out of the patient they were reading and left them to find their way back
 * through browser tabs. A record you open to check against the notes beside it belongs
 * beside them, not in place of them.
 *
 * Two more things a new tab gets wrong, both of which this avoids by never opening one:
 * the open happens after an await, so the click that started it has expired by the time
 * it runs and a popup blocker can swallow it with nothing thrown to catch; and the blob
 * then has to be revoked on a guessed timer, because nothing here can know when the tab
 * is done reading it.
 *
 * Shared rather than written per board — DietBoard's chart panel already had this shape,
 * and LeadDocuments has an image-only lightbox of its own. Both can move onto this.
 */

const isPdf = (contentType, name) => /pdf/i.test(contentType || "") || /\.pdf$/i.test(name || "");
const isImageDoc = (contentType, name) =>
  String(contentType || "").startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(name || "");
const isVideoDoc = (contentType, name) =>
  String(contentType || "").startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(name || "");

/**
 * Holds the document currently on screen and owns its blob URL.
 *
 * Revoked when the reader closes it, and again on unmount — a panel can be taken off the
 * page with a document still open (the modal behind it closes, the board reloads), and an
 * object URL nobody hands back holds its bytes for the life of the tab. Deliberately not
 * revoked on a timer: the bytes live exactly as long as they are on screen, and somebody
 * reading a long report cannot have it expire underneath them.
 */
export const useDocumentPreview = () => {
  // { url, name, pdf, image, video } — null when nothing is open.
  const [preview, setPreview] = useState(null);
  // Mirrors preview.url so the unmount cleanup can revoke it. An effect that closed over
  // the state would be handing back whatever the url was when it last ran.
  const openUrl = useRef(null);

  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);

  // Replaces whatever was open, handing the old blob back on the way — a reader who opens
  // a second document has finished with the first.
  const openPreview = useCallback(({ url, name, contentType }) => {
    const label = name || "Document";
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return {
        url,
        name: label,
        // The stored type where there is one, the file's own name where there is not: a
        // document filed before content_type was recorded still knows what it is.
        pdf: isPdf(contentType, label),
        image: isImageDoc(contentType, label),
        video: isVideoDoc(contentType, label),
      };
    });
  }, []);

  useEffect(() => { openUrl.current = preview?.url || null; }, [preview]);

  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closePreview(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, closePreview]);

  // Empty dependency list on purpose, read through the ref so it still sees whatever is
  // open at the moment it runs.
  useEffect(() => () => {
    if (openUrl.current) URL.revokeObjectURL(openUrl.current);
  }, []);

  return { preview, openPreview, closePreview };
};

/**
 * The sheet itself. Renders nothing until something is open.
 *
 * Portalled to the body and above z-[80]: the panels that list documents sit inside
 * full-screen pages (z-50) and inside modals stacked on top of those (z-[60], z-[70]), so
 * rendering it in place would put the document underneath the thing that opened it.
 */
export const DocumentPreview = ({ preview, onClose, icon: Icon = FileText, testid = "document-preview" }) => {
  if (!preview) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black/70 p-3 sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid={testid}
    >
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
          <Icon className="h-4 w-4 shrink-0 text-sky-600" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800" title={preview.name}>
            {preview.name}
          </p>
          {/* The way out for anything the browser will not draw inline, and for somebody
              who wants the file rather than a look at it. A real link off the blob, not a
              scripted open: it carries the click that started it, which is the thing a
              popup blocker asks for. */}
          <a
            href={preview.url}
            download={preview.name}
            className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50"
            data-testid={`${testid}-download`}
          >
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-slate-100"
            aria-label="Close the document"
            title="Close (Esc)"
            data-testid={`${testid}-close`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-slate-100">
          {preview.pdf ? (
            <ZoomablePdf src={preview.url} title={preview.name} testid={`${testid}-pdf`} />
          ) : preview.image ? (
            <ZoomableImage src={preview.url} alt={preview.name} testid={`${testid}-image`} />
          ) : preview.video ? (
            // The case sheet's progression clips are filed here as videos.
            <video src={preview.url} controls className="h-full w-full bg-black" data-testid={`${testid}-video`} />
          ) : (
            // Anything else — a scan filed as a .doc, a spreadsheet. Saying so beats an
            // empty frame that looks like the document failed to load.
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileText className="h-8 w-8 text-slate-300" aria-hidden />
              <p className="text-xs text-slate-500">
                This kind of file can't be shown here. Download it to open it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
