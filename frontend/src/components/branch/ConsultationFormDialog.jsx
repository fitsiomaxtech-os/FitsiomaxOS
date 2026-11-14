import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Check, ClipboardList, Copy, Download, ExternalLink, Link2, Loader2, MessageCircle,
  Pencil, Plus, Printer, Search, Send, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  consultationFormLink,
  createConsultationForm,
  deleteConsultationForm,
  getBranches,
  getConsultationForm,
  listConsultationForms,
  requestConsultationForm,
  shareConsultationForm,
  updateConsultationForm,
} from "@/lib/api";
import { waNumber } from "@/lib/phone";
import { claimPrintWindow, downloadConsultationForm, printConsultationForm } from "@/lib/consultationFormPrint";
import { ConsultationFormSheets, EMPTY_FORM, paperBranch, showDate, todayIso } from "@/components/branch/ConsultationFormSheets";

/**
 * Settings > Consultation Form: the clinic's three-page paper Offline Consultation Form,
 * filled on screen. The list keeps the branch's saved forms; a tap opens one in the same
 * layout to edit. Request from Client sends the patient a link to fill their part
 * themselves (pages/ClientConsultationFormPage); Print and Download give the filled
 * paper back (lib/consultationFormPrint).
 *
 * A plain overlay, like the other two popups in the same menu.
 */

const fillFrom = (r) => Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, r?.[k] || ""]));
const showStamp = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};

const StatusChip = ({ status }) => {
  if (status === "requested") return <span className="inline-flex rounded-[4px] border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Sent to client</span>;
  if (status === "submitted") return <span className="inline-flex rounded-[4px] border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Filled by client</span>;
  return null;
};

/** The link, ready to send: copy it, WhatsApp it, or open it to see what the patient sees. */
const SharePanel = ({ share, onClose }) => {
  const link = consultationFormLink(share.token);
  const [copied, setCopied] = useState(false);
  const message = `Hi${share.name ? ` ${share.name}` : ""}, please fill your Fitsiomax consultation form using this link:\n${link}`;
  const num = waNumber(share.contact);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the link and copy it");
    }
  };
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="consultation-form-share">
      <div className="w-full max-w-md rounded-[4px] bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-base font-semibold text-slate-800"><Link2 className="h-4 w-4 text-sky-600" />Client form link</p>
            <p className="mt-1 text-xs text-slate-500">
              {share.name ? `${share.name} fills` : "The client fills"} the patient details and previous consultations. Diagnosis and treatment stay with the clinic.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-slate-400 hover:bg-slate-100" aria-label="Close" data-testid="consultation-form-share-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-[4px] border border-slate-200 bg-slate-50 px-3 py-2">
          <input readOnly value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 outline-none" data-testid="consultation-form-share-link" />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copy} className="gap-1.5 rounded-[4px]" data-testid="consultation-form-share-copy">
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}Copy
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => window.open(`https://wa.me/${num}?text=${encodeURIComponent(message)}`, "_blank", "noopener")}
            className="gap-1.5 rounded-[4px] bg-emerald-600 hover:bg-emerald-700"
            data-testid="consultation-form-share-whatsapp"
          >
            <MessageCircle className="h-4 w-4" />WhatsApp
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.open(link, "_blank", "noopener")} className="gap-1.5 rounded-[4px]" data-testid="consultation-form-share-open">
            <ExternalLink className="h-4 w-4" />Open
          </Button>
        </div>
      </div>
    </div>
  );
};

/** Request from Client: who it is for, both optional -- the patient can type them. */
const RequestPanel = ({ busy, onSend, onClose }) => {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="consultation-form-request">
      <form
        className="w-full max-w-md rounded-[4px] bg-white p-5 shadow-xl"
        onSubmit={(e) => { e.preventDefault(); onSend({ name: name.trim(), contact_no: contact.trim() }); }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-base font-semibold text-slate-800"><Send className="h-4 w-4 text-sky-600" />Request from Client</p>
            <p className="mt-1 text-xs text-slate-500">Creates a link the client opens to fill the form. Both fields are optional.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <label className="mt-4 block text-xs font-medium text-slate-600">Client name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-9 w-full rounded-[4px] border border-slate-200 px-3 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" data-testid="consultation-form-request-name" />
        </label>
        <label className="mt-3 block text-xs font-medium text-slate-600">Contact no (for WhatsApp)
          <input value={contact} onChange={(e) => setContact(e.target.value)} inputMode="tel" className="mt-1 h-9 w-full rounded-[4px] border border-slate-200 px-3 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" data-testid="consultation-form-request-contact" />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy} className="rounded-[4px]">Cancel</Button>
          <Button type="submit" size="sm" disabled={busy} className="gap-1.5 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-request-send">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}Create Link
          </Button>
        </div>
      </form>
    </div>
  );
};

const iconBtn = "rounded p-1.5 text-slate-400 transition hover:bg-sky-50 hover:text-sky-700";

export const ConsultationFormDialog = ({ branchId, onClose }) => {
  const [view, setView] = useState("list"); // "list" | "form"
  const [rows, setRows] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [meta, setMeta] = useState(null); // the open form's client_status and stamps
  const [form, setForm] = useState(EMPTY_FORM);
  const [saved, setSaved] = useState(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [homeBranch, setHomeBranch] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [share, setShare] = useState(null); // { token, name, contact }
  const [pdfBusy, setPdfBusy] = useState(null); // the id (or "open") a PDF is being drawn for
  const scrollRef = useRef(null);

  useEffect(() => {
    let live = true;
    getBranches()
      .then((list) => { if (live) setHomeBranch(paperBranch((list || []).find((b) => b.id === branchId)?.name)); })
      .catch(() => {});
    return () => { live = false; };
  }, [branchId]);

  const load = useCallback(async (term) => {
    setListLoading(true);
    try {
      const r = await listConsultationForms(branchId, term);
      setRows(r.forms || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load the consultation forms");
    } finally {
      setListLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const dirty = view === "form" && JSON.stringify(form) !== JSON.stringify(saved);
  const set = (key, v) => setForm((cur) => ({ ...cur, [key]: v }));
  const top = () => scrollRef.current?.scrollTo({ top: 0 });

  const openNew = () => {
    const start = { ...EMPTY_FORM, date: todayIso(), branch: homeBranch };
    setEditingId(null);
    setMeta(null);
    setForm(start);
    setSaved(start);
    setView("form");
    top();
  };

  const openEdit = async (id) => {
    setEditingId(id);
    setView("form");
    setFormLoading(true);
    top();
    try {
      const r = await getConsultationForm(branchId, id);
      const filled = fillFrom(r);
      setForm(filled);
      setSaved(filled);
      setMeta({ client_status: r.client_status, client_submitted_at: r.client_submitted_at, share_token: r.share_token });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
      setView("list");
    } finally {
      setFormLoading(false);
    }
  };

  const backToList = () => {
    if (dirty && !window.confirm("Discard the changes on this form?")) return;
    setView("list");
    top();
  };

  const close = () => {
    if (dirty && !window.confirm("Discard the changes on this form?")) return;
    onClose();
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error("Enter the patient's name"); return; }
    setSaving(true);
    try {
      if (editingId) await updateConsultationForm(branchId, editingId, form);
      else await createConsultationForm(branchId, form);
      toast.success(editingId ? "Consultation form updated" : "Consultation form saved");
      setSaved(form);
      setView("list");
      top();
      load(q.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the form");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the consultation form of ${row.name || "this client"}?\n\nIt cannot be undone.`)) return;
    try {
      await deleteConsultationForm(branchId, row.id);
      toast.success("Consultation form deleted");
      setRows((cur) => cur.filter((r) => r.id !== row.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete the form");
    }
  };

  const sendRequest = async ({ name, contact_no }) => {
    setRequestBusy(true);
    try {
      const r = await requestConsultationForm(branchId, { name, contact_no, branch: homeBranch, date: todayIso() });
      setRequesting(false);
      setShare({ token: r.share_token, name, contact: contact_no });
      load(q.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't create the link");
    } finally {
      setRequestBusy(false);
    }
  };

  // A form the client already sent back is opened to them again only on purpose.
  const shareRow = async (row) => {
    if (row.client_status === "submitted" && !window.confirm(`${row.name || "The client"} has already filled this form.\n\nSend the link again so they can change their answers?`)) return;
    try {
      const r = await shareConsultationForm(branchId, row.id);
      setShare({ token: r.share_token, name: row.name, contact: row.contact_no });
      if (view === "form") setMeta((m) => ({ ...m, client_status: "requested", share_token: r.share_token }));
      load(q.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't create the link");
    }
  };

  const printRow = async (id) => {
    const w = claimPrintWindow();
    if (!w) return;
    try {
      printConsultationForm(fillFrom(await getConsultationForm(branchId, id)), w);
    } catch (e) {
      w.close();
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
    }
  };

  const downloadRow = async (id) => {
    setPdfBusy(id);
    try {
      await downloadConsultationForm(fillFrom(await getConsultationForm(branchId, id)));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
    } finally {
      setPdfBusy(null);
    }
  };

  const downloadOpen = async () => {
    setPdfBusy("open");
    try { await downloadConsultationForm(form); } finally { setPdfBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="consultation-form-dialog">
      <div className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {view === "form" && (
              <button type="button" onClick={backToList} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Back to the forms" data-testid="consultation-form-back">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <p className="flex min-w-0 items-center gap-2 truncate text-base font-semibold text-slate-800">
              <ClipboardList className="h-4 w-4 shrink-0 text-sky-600" />
              {view === "list" ? "Consultation Forms" : editingId ? `Edit — ${saved.name || "Consultation Form"}` : "New Consultation Form"}
            </p>
          </div>
          <button type="button" onClick={close} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="consultation-form-close"><X className="h-4 w-4" /></button>
        </div>

        <div ref={scrollRef} className={`flex-1 overflow-y-auto ${view === "form" ? "bg-slate-100 p-3 sm:p-5" : "p-4"}`}>
          {view === "list" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, contact or therapist…"
                    className="h-9 w-full rounded-[4px] border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                    data-testid="consultation-form-search"
                  />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setRequesting(true)} className="h-9 gap-1.5 rounded-[4px] border-sky-200 text-sky-700 hover:bg-sky-50" data-testid="consultation-form-request-open">
                  <Send className="h-4 w-4" />Request from Client
                </Button>
                <Button type="button" size="sm" onClick={openNew} className="h-9 gap-1.5 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-new">
                  <Plus className="h-4 w-4" />New Form
                </Button>
              </div>

              {listLoading ? (
                <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : rows.length === 0 ? (
                <div className="rounded-[4px] border border-dashed border-slate-200 py-14 text-center text-sm text-slate-400" data-testid="consultation-form-empty">
                  {q ? "No form matches that search." : "No consultation forms yet. Tap New Form to fill one, or Request from Client to send a link."}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-[4px] border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-700 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                      <tr>
                        <th className="px-3 py-2.5">Patient</th>
                        <th className="hidden px-3 py-2.5 sm:table-cell">Contact</th>
                        <th className="hidden px-3 py-2.5 sm:table-cell">Date</th>
                        <th className="hidden px-3 py-2.5 md:table-cell">Therapist</th>
                        <th className="px-3 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} onClick={() => openEdit(r.id)} className="cursor-pointer border-t border-slate-100 hover:bg-sky-50/50" data-testid={`consultation-form-row-${r.id}`}>
                          <td className="px-3 py-2.5">
                            <p className={r.name ? "font-medium text-slate-800" : "italic text-slate-400"}>{r.name || "Awaiting client"}</p>
                            {r.client_status && <div className="mt-0.5"><StatusChip status={r.client_status} /></div>}
                          </td>
                          <td className="hidden px-3 py-2.5 text-slate-600 sm:table-cell">{r.contact_no || "—"}</td>
                          <td className="hidden whitespace-nowrap px-3 py-2.5 text-slate-600 sm:table-cell">{showDate(r.date)}</td>
                          <td className="hidden px-3 py-2.5 text-slate-600 md:table-cell">{r.therapist_name || "—"}</td>
                          <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-0.5">
                              <button type="button" onClick={() => shareRow(r)} className={iconBtn} aria-label="Share link" title="Share link to client" data-testid={`consultation-form-share-${r.id}`}><Link2 className="h-4 w-4" /></button>
                              <button type="button" onClick={() => printRow(r.id)} className={iconBtn} aria-label="Print" title="Print" data-testid={`consultation-form-print-${r.id}`}><Printer className="h-4 w-4" /></button>
                              <button type="button" onClick={() => downloadRow(r.id)} disabled={pdfBusy === r.id} className={iconBtn} aria-label="Download PDF" title="Download PDF" data-testid={`consultation-form-download-${r.id}`}>
                                {pdfBusy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                              </button>
                              <button type="button" onClick={() => openEdit(r.id)} className={iconBtn} aria-label="Edit" title="Edit" data-testid={`consultation-form-edit-${r.id}`}><Pencil className="h-4 w-4" /></button>
                              <button type="button" onClick={() => remove(r)} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Delete" title="Delete" data-testid={`consultation-form-delete-${r.id}`}><Trash2 className="h-4 w-4" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : formLoading ? (
            <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <>
              {meta?.client_status === "requested" && (
                <p className="mb-3 rounded-[4px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="consultation-form-status">
                  Sent to the client — waiting for them to fill their part.
                </p>
              )}
              {meta?.client_status === "submitted" && (
                <p className="mb-3 rounded-[4px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800" data-testid="consultation-form-status">
                  Filled by the client{meta.client_submitted_at ? ` on ${showStamp(meta.client_submitted_at)}` : ""}. Complete the clinic's part below.
                </p>
              )}
              <ConsultationFormSheets f={form} set={set} />
            </>
          )}
        </div>

        {view === "form" && (
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
            <div className="flex gap-1.5">
              {editingId && (
                <Button type="button" variant="outline" size="sm" onClick={() => shareRow({ id: editingId, ...saved, client_status: meta?.client_status })} disabled={formLoading} className="gap-1.5 rounded-[4px] px-2.5" title="Share link to client" data-testid="consultation-form-footer-share">
                  <Link2 className="h-4 w-4" /><span className="hidden sm:inline">Share Link</span>
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => printConsultationForm(form)} disabled={formLoading} className="gap-1.5 rounded-[4px] px-2.5" title="Print" data-testid="consultation-form-footer-print">
                <Printer className="h-4 w-4" /><span className="hidden sm:inline">Print</span>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={downloadOpen} disabled={formLoading || pdfBusy === "open"} className="gap-1.5 rounded-[4px] px-2.5" title="Download PDF" data-testid="consultation-form-footer-download">
                {pdfBusy === "open" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}<span className="hidden sm:inline">Download</span>
              </Button>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={backToList} disabled={saving} className="rounded-[4px]">Cancel</Button>
              <Button type="button" size="sm" onClick={save} disabled={formLoading || saving || (editingId && !dirty)} className="rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-save">
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{editingId ? "Update" : "Save"}
              </Button>
            </div>
          </div>
        )}

        {requesting && <RequestPanel busy={requestBusy} onSend={sendRequest} onClose={() => setRequesting(false)} />}
        {share && <SharePanel share={share} onClose={() => setShare(null)} />}
      </div>
    </div>
  );
};
