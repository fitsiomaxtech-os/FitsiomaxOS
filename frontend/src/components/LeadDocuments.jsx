import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronLeft, ChevronRight, Eye, FileText, Image as ImageIcon, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { ZoomableImage } from "@/components/ui/zoomable-view";
import { leadDocuments, uploadLeadDocument, deleteLeadDocument, openLeadDocument, setDocumentShared } from "@/lib/api";

/**
 * Documents held against one client — scans, reports, prescriptions, scheme letters.
 *
 * The bytes never come from a URL the browser can fetch on its own. These are patient
 * records, and the OS's /uploads mount is public to anyone holding the link, so every
 * open goes through the authenticated download route and arrives as a blob. That has one
 * visible consequence: a document opens on click rather than being an <a href> you can
 * copy, which is the point rather than a limitation.
 */

/**
 * Says what actually went wrong instead of "Upload failed".
 *
 * Our API always answers with a JSON `detail`, so an error without one did not come from
 * the API — it came from the web server in front of it, or the request never arrived. The
 * commonest case by far is nginx's client_max_body_size, which defaults to 1MB: it rejects
 * the upload with a 413 and an HTML page, the `detail` lookup finds nothing, and every
 * cause collapses into the same unhelpful sentence. Naming the status turns "it doesn't
 * work" into something someone can fix.
 */
// Above uploadError, which reads fmtSize. A const is not hoisted, so writing these
// below the only caller left the file in an order the reader could not follow and the
// linter would not accept.
const KB = 1024;
const fmtSize = (n) => (n >= KB * KB ? `${(n / KB / KB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / KB))} KB`);

const uploadError = (err, file) => {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (detail) return detail;
  if (status === 413) {
    return `Rejected by the server as too large (${fmtSize(file?.size || 0)}). The upload limit on the web server needs raising — nginx client_max_body_size.`;
  }
  if (status === 401 || status === 403) return "You don't have permission to upload here.";
  if (status) return `Upload failed (HTTP ${status}).`;
  return "Upload failed — no response from the server. Check the connection and try again.";
};

// Kept in step with MAX_UPLOAD_BYTES in backend/routers/v3_lead_documents.py. The server
// is the one that enforces it; this copy only exists to fail fast.
const MAX_UPLOAD_MB = 500;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * KB * KB;

// A phone camera writes 3-6MB for one sheet of A4, almost all of it detail that a form
// filled in biro does not have. Resized to 2000px on the long edge and re-encoded, the
// same page lands around 300-600KB and reads identically — the handwriting is legible
// well below the resolution the sensor captured.
//
// This exists because it makes the upload smaller everywhere it travels: quicker over a
// phone connection at the front desk, smaller on the VPS disk, and comfortably under any
// web-server body limit sitting in front of the app. It is not a substitute for raising
// that limit — a multi-page PDF cannot be shrunk here and will still be refused if it is
// over the cap.
const MAX_IMAGE_EDGE = 2000;
const IMAGE_QUALITY = 0.82;
const LEAVE_ALONE_UNDER = 900 * KB;

const compressImage = (file) => new Promise((resolve) => {
  if (!String(file.type || "").startsWith("image/")) return resolve(file);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const longest = Math.max(img.width, img.height);
    const scale = Math.min(1, MAX_IMAGE_EDGE / (longest || 1));
    // Already modest and already small — re-encoding would only lose detail for nothing.
    if (scale === 1 && file.size <= LEAVE_ALONE_UNDER) return resolve(file);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        // Keep whichever is smaller. Re-encoding a screenshot or an already-optimised
        // PNG can come out bigger, and shipping the larger one would be worse than
        // having done nothing.
        if (!blob || blob.size >= file.size) return resolve(file);
        // Renamed to .jpg because that is now what it is — the backend checks the
        // extension, and a JPEG called .png would be refused.
        const base = (file.name || "page").replace(/\.[^.]+$/, "");
        resolve(new File([blob], `${base}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      IMAGE_QUALITY,
    );
  };
  // A format the browser can't decode (HEIC straight off an iPhone, say) goes up
  // untouched and is judged by the server's own extension check.
  img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  img.src = url;
});
const isImage = (t) => String(t || "").startsWith("image/");
const NAV_BTN = "shrink-0 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/25 sm:p-3";
const fmtWhen = (iso) => (iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}` : "—");

// `canUpload` splits filing off from the rest of editing and defaults to `canEdit`, so a
// caller that never mentions it keeps the panel it always had. Separate because a screen
// can want the list, the share flag and the bin while having no business adding pages:
// the Consultant reads a patient's file, the branch that ordered the reports files them.
// `hideEmpty` draws nothing while loading or with nothing on file, for a list that sits
// above another one and should take no room until it has a page.
export const LeadDocuments = ({ leadId, canEdit = true, canUpload = canEdit, kind = "general", fixedLabel = "", hint, onChanged, compact = false, hideEmpty = false }) => {
  const [docs, setDocs] = useState([]);
  const [sharing, setSharing] = useState(null); // the doc whose share flag is in flight
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Whether a file is being dragged over the panel, so it can say it will take it.
  const [dragging, setDragging] = useState(false);
  // The file chosen but not yet filed. Null until somebody picks or drops one.
  const [pending, setPending] = useState(null);
  const [label, setLabel] = useState("");
  const fileRef = useRef(null);
  // A second input rather than a `capture` attribute on the first. The attribute is a hint
  // to the browser about which source to offer, and setting it on the only input takes the
  // file picker away: a desk with a scanned PDF would have nowhere to put it. Two inputs
  // means the same panel offers the camera to the phone at the front desk and the drive to
  // the machine in the office, and neither is a detour through the other.
  const cameraRef = useRef(null);

  // `onChanged` lets a caller react to what is on file — Consultation Visit will not take
  // a payment until there is something here, and a gate that only opened on a page reload
  // would read as the upload having failed.
  //
  // Held in a ref rather than named as a dependency of `load`. Callers pass an inline
  // arrow, which is a new function every render: as a dependency it would rebuild `load`,
  // which the effect below re-runs on, which sets state, which renders again — a fetch
  // loop against the documents endpoint for as long as the card stayed open.
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const load = useCallback(() => {
    setLoading(true);
    leadDocuments(leadId, kind)
      .then((r) => {
        const list = r.documents || [];
        setDocs(list);
        onChangedRef.current?.(list.length);
      })
      .catch(() => { setDocs([]); onChangedRef.current?.(0); })
      .finally(() => setLoading(false));
  }, [leadId, kind]);

  useEffect(() => { load(); }, [load]);

  // The images on file, in the order the list shows them, and where the viewer is standing
  // in that order. Pages of a consultation form get photographed one after another, so what
  // someone wants is to read them in sequence — not to open six browser tabs and hunt
  // between them. PDFs are left to the download route: a blob in an <img> shows nothing.
  const images = docs.filter((d) => isImage(d.content_type));
  const [viewing, setViewing] = useState(null); // index into `images`, or null when closed
  const [viewSrc, setViewSrc] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  const viewDoc = viewing == null ? null : images[viewing] || null;
  const viewDocId = viewDoc?.id ?? null;

  // One blob URL per document, kept so paging back to a page already read doesn't
  // download it again. They are handed back on unmount — an object URL the document still
  // owns holds its bytes in memory for the life of the tab.
  const urlCache = useRef(new Map());
  useEffect(() => {
    const cache = urlCache.current;
    return () => { cache.forEach((u) => URL.revokeObjectURL(u)); cache.clear(); };
  }, []);

  useEffect(() => {
    if (!viewDocId) return undefined;
    const cached = urlCache.current.get(viewDocId);
    if (cached) { setViewSrc(cached); return undefined; }
    let cancelled = false;
    setViewSrc("");
    setViewBusy(true);
    openLeadDocument(leadId, viewDocId)
      .then((url) => {
        // Arrived after the reader had already moved on: revoked rather than cached, or
        // it would sit in memory as a page nothing is going to show.
        if (cancelled) { URL.revokeObjectURL(url); return; }
        urlCache.current.set(viewDocId, url);
        setViewSrc(url);
      })
      .catch(() => { if (!cancelled) { toast.error("Could not open that document"); setViewing(null); } })
      .finally(() => { if (!cancelled) setViewBusy(false); });
    return () => { cancelled = true; };
  }, [viewDocId, leadId]);

  // Deleting the page being looked at, or the last one, would otherwise leave the viewer
  // open on an index that no longer exists.
  useEffect(() => {
    if (viewing != null && viewing >= images.length) setViewing(images.length ? images.length - 1 : null);
  }, [viewing, images.length]);

  const step = useCallback((by) => {
    setViewing((i) => (i == null || images.length === 0 ? null : (i + by + images.length) % images.length));
  }, [images.length]);

  // Arrow keys and Escape. A viewer that can only be driven by clicking small targets is
  // one people stop using by the third page.
  useEffect(() => {
    if (viewing == null) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setViewing(null);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing, step]);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    // Cleared straight away so choosing the same file twice still fires a change event —
    // re-uploading a corrected scan under the same name is a normal thing to do.
    e.target.value = "";
    take(file);
  };

  /** Held and shown back before it goes anywhere.
   *
   *  Filing was instant, so whatever was under the cursor landed on this patient's record
   *  before anybody read its name — and the only way back from the wrong scan is a delete
   *  somebody has to notice is needed. The size check happens here rather than after, so
   *  an oversized file is refused before it is ever offered for confirmation.
   */
  function take(file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(`That file is ${fmtSize(file.size)} — the limit is ${MAX_UPLOAD_MB}MB.`);
      return;
    }
    setPending(file);
  }

  /** Everything that happens to the held file once it is confirmed. */
  async function send(file) {
    if (!file) return;
    setBusy(true);
    let sent = file;
    try {
      sent = await compressImage(file);
      // A fixed label names the pages for you — the consultation form is always the
      // consultation form, and asking someone to type that on every page is a field
      // they will leave blank.
      // `kind` doubles as the filter on what this panel lists, and an empty one means
      // "everything on file" rather than a kind of its own. New pages still have to be
      // filed as something, so they land under general — passing the empty string
      // through would store documents under a kind nothing ever asks for.
      await uploadLeadDocument(leadId, sent, fixedLabel || label, kind || "general");
      toast.success(
        sent.size < file.size
          ? `Uploaded · ${fmtSize(file.size)} shrunk to ${fmtSize(sent.size)}`
          : "Document uploaded",
      );
      setLabel("");
      setPending(null);
      load();
    } catch (err) {
      // Reports the size actually sent, so a 413 names the number the server refused
      // rather than the one on disk before compression.
      toast.error(uploadError(err, sent));
    }
    setBusy(false);
  }

  const open = async (doc) => {
    try {
      const url = await openLeadDocument(leadId, doc.id);
      window.open(url, "_blank", "noopener");
      // Revoked on a delay rather than immediately: the new tab has to finish reading the
      // blob first, and revoking on the next line leaves it opening a dead URL.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error("Could not open that document");
    }
  };

  const toggleShare = async (doc) => {
    const next = !doc.shared_with_patient;
    setSharing(doc.id);
    try {
      await setDocumentShared(leadId, doc.id, next);
      // Patched in place rather than reloading: the list is the same, only this flag moved.
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, shared_with_patient: next } : d)));
      toast.success(next ? "Shared with the patient's portal" : "Hidden from the patient's portal");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't change sharing");
    }
    setSharing(null);
  };

  const remove = async (doc) => {
    if (!window.confirm(`Delete "${doc.label || doc.original_name}"? This cannot be undone.`)) return;
    try {
      await deleteLeadDocument(leadId, doc.id);
      const cached = urlCache.current.get(doc.id);
      if (cached) { URL.revokeObjectURL(cached); urlCache.current.delete(doc.id); }
      toast.success("Document deleted");
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Delete failed");
    }
  };

  // Opening a document, from the row or from the eye on it. An image opens in the viewer
  // here at its own page; a PDF has no viewer of ours, so it goes to a tab.
  //
  // There was a View button above the list as well, next to Choose File. It opened the
  // viewer at the first image whichever document you were looking at, which is not what
  // is wanted from a list of them -- and next to an uploader it read as part of
  // uploading. Each document carries its own now, so the thing you press is on the thing
  // you want to see.
  const openDoc = (d) => {
    const at = images.findIndex((i) => i.id === d.id);
    if (at >= 0) setViewing(at);
    else open(d);
  };

  // Camera and Choose File (and the label box when there is no fixed label). Drawn under
  // the title, or beside it on one row when `compact`.
  const buttonRow = (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "mt-2"}`}>
      {!fixedLabel && (
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What is it? e.g. MRI report"
          className="h-9 min-w-0 flex-1 bg-white sm:max-w-xs"
          data-testid="lead-doc-label"
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.pdf"
        className="hidden"
        onChange={pick}
        data-testid="lead-doc-input"
      />
      {/* capture="environment" asks for the rear camera, which is the one pointed at
          a sheet of paper. A desktop browser has no camera to open and falls back to
          its file picker, so the button is never a dead end — it is just the slower
          of the two routes there. Images only: there is no such thing as
          photographing a PDF. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={pick}
        data-testid="lead-doc-camera-input"
      />
      <Button
        size="sm"
        className="bg-sky-600 hover:bg-sky-700"
        disabled={busy}
        onClick={() => cameraRef.current?.click()}
        data-testid="lead-doc-camera"
      >
        <Camera className="mr-1.5 h-4 w-4" />
        {busy ? "Uploading…" : "Camera"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="border-sky-200 text-sky-700 hover:bg-sky-50"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        data-testid="lead-doc-choose"
      >
        <Upload className="mr-1.5 h-4 w-4" />
        {busy ? "Uploading…" : "Choose File"}
      </Button>
    </div>
  );

  return (
    <div className="space-y-3" data-testid="lead-documents">
      {canUpload && (
        <div
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) take(e.dataTransfer?.files?.[0]); }}
          className={`rounded-xl border p-3 transition ${dragging ? "border-sky-400 bg-sky-100/70 ring-2 ring-sky-200" : "border-sky-100 bg-sky-50/60"}`}
        >
          {/* `compact`: the title and the two buttons on one row, no hint line under it. */}
          <div className={compact ? "flex flex-wrap items-center justify-between gap-2" : ""}>
          <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700">{fixedLabel ? `Upload ${fixedLabel.toLowerCase()} pages` : "Upload a document"}</p>
          {!compact && <p className="mt-0.5 text-[11px] text-slate-500">{dragging ? "Drop it to file it." : (hint || "Drop a file here, or choose one · JPG, PNG, WEBP or PDF")}</p>}
          {compact && buttonRow}
          </div>
          {/* What is about to be filed, before it is. Named rather than counted, because
              "1 file" is not something anybody can check against the folder they took it
              from. */}
          {pending && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-white p-2.5" data-testid="lead-doc-pending">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600">
                <Upload className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-800" title={pending.name}>{pending.name}</p>
                <p className="text-[11px] text-slate-500">{fmtSize(pending.size)}{label.trim() ? ` · ${label.trim()}` : ""}</p>
              </div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)} data-testid="lead-doc-pending-cancel">
                Cancel
              </Button>
              <Button size="sm" className="bg-sky-600 hover:bg-sky-700" disabled={busy} onClick={() => send(pending)} data-testid="lead-doc-pending-confirm">
                {busy ? "Uploading…" : "Upload"}
              </Button>
            </div>
          )}
          {!compact && buttonRow}
        </div>
      )}

      {loading ? (
        hideEmpty ? null : <p className="py-4 text-center text-sm text-slate-400">Loading documents…</p>
      ) : docs.length === 0 ? (
        // Nothing at all when there is a way to add one on screen: the panel above is both
        // the instruction and the action, and a box under it repeating that the list is
        // empty is a hole in the middle of the step. Callers with no uploader on screen
        // still get a line, since for them an empty list is the whole answer.
        canUpload || hideEmpty ? null : (
          <p className="py-3 text-center text-xs text-slate-400">
            {fixedLabel ? `No ${fixedLabel.toLowerCase()} pages uploaded yet.` : "No documents yet."}
          </p>
        )
      ) : (
        <ul className="space-y-2" data-testid="lead-doc-list">
          {docs.map((d) => {
            const Icon = isImage(d.content_type) ? ImageIcon : FileText;
            return (
              <li key={d.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5" data-testid={`lead-doc-${d.id}`}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  <Icon className="h-4 w-4" />
                </span>
                <button
                  type="button"
                  onClick={() => openDoc(d)}
                  className="min-w-0 flex-1 text-left"
                  data-testid={`lead-doc-open-${d.id}`}
                >
                  <p className="truncate text-sm font-semibold text-slate-800">{d.label || d.original_name}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {/* The original filename only when it isn't already the title, so a
                        document with no label doesn't print its name twice. */}
                    {d.label && d.original_name !== d.label ? `${d.original_name} · ` : ""}
                    {fmtSize(d.size_bytes || 0)} · {fmtWhen(d.created_at)} · {d.uploaded_by || "—"}
                  </p>
                </button>
                {/* Whether the patient can see this in their own Client Portal.
                    Consultation forms are shared on upload — it is the patient's own
                    form. Reports and scans are not, because a patient reading a finding
                    before a clinician has explained it is the branch's call to make
                    deliberately, one document at a time. */}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => toggleShare(d)}
                    disabled={sharing === d.id}
                    className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold transition disabled:opacity-50 ${
                      d.shared_with_patient
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "border-slate-200 text-slate-400 hover:bg-slate-50"
                    }`}
                    title={d.shared_with_patient
                      ? "Visible to the patient in their portal — click to hide"
                      : "Hidden from the patient — click to share"}
                    data-testid={`lead-doc-share-${d.id}`}
                  >
                    {d.shared_with_patient ? "SHARED" : "PRIVATE"}
                  </button>
                )}
                {/* After the badge, before the bin. Not gated on canEdit like its two
                    neighbours: a physio or coach who cannot upload or delete still has to
                    be able to read the file, and this is now the only button that opens
                    one. */}
                <button
                  type="button"
                  onClick={() => openDoc(d)}
                  className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-sky-50 hover:text-sky-600"
                  title={isImage(d.content_type) ? "View" : "Open"}
                  data-testid={`lead-doc-view-${d.id}`}
                >
                  <Eye className="h-4 w-4" />
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(d)}
                    className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    title="Delete"
                    data-testid={`lead-doc-delete-${d.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Portalled to the body: this opens from inside a lead card that is itself a modal
          with its own scroll box, and a full-screen sheet rendered inside that would be
          clipped by it and stacked underneath it. */}
      {viewDoc && createPortal(
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/70 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}
          data-testid="lead-doc-viewer"
        >
          {/* A panel rather than the whole screen. This opens from inside a lead card that
              is itself a dialog, and a sheet edge to edge loses where it was opened from —
              closing it felt like leaving the patient rather than shutting a picture. */}
          <div
            className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-slate-900 p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
          <div className="flex items-start gap-3 text-white">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{viewDoc.label || viewDoc.original_name}</p>
              <p className="truncate text-[11px] text-white/60">
                {images.length > 1 ? `${viewing + 1} of ${images.length} · ` : ""}
                {fmtSize(viewDoc.size_bytes || 0)} · {fmtWhen(viewDoc.created_at)} · {viewDoc.uploaded_by || "—"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setViewing(null)}
              className="shrink-0 rounded-full p-2 text-white/80 transition hover:bg-white/15 hover:text-white"
              title="Close (Esc)"
              data-testid="lead-doc-viewer-close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-3 flex min-h-0 flex-1 items-center gap-2 sm:gap-4">
            {images.length > 1 && (
              <button type="button" onClick={() => step(-1)} className={NAV_BTN} title="Previous (←)" data-testid="lead-doc-viewer-prev">
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}
            <div
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch"
              onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}
            >
              {viewBusy || !viewSrc ? (
                <p className="text-sm text-white/70">Loading…</p>
              ) : (
                <ZoomableImage
                  src={viewSrc}
                  alt={viewDoc.label || viewDoc.original_name}
                  dark
                  testid="lead-doc-viewer-image"
                />
              )}
            </div>
            {images.length > 1 && (
              <button type="button" onClick={() => step(1)} className={NAV_BTN} title="Next (→)" data-testid="lead-doc-viewer-next">
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default LeadDocuments;
