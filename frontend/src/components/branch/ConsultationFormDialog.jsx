import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, Check, ChevronRight, ClipboardList, Copy, Download, ExternalLink, Link2, Loader2, MessageCircle,
  Pencil, Plus, Printer, Search, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ThemedSelect } from "@/components/ui/themed-select";
import { DateFilterPopover } from "@/components/DateFilterPopover";
import {
  consultationFormLink,
  createConsultationForm,
  deleteConsultationForm,
  getBranches,
  getConsultationForm,
  listConsultationForms,
  listTherapistNames,
  shareConsultationForm,
  updateConsultationForm,
} from "@/lib/api";
import { waNumber } from "@/lib/phone";
import { useTherapistSign } from "@/lib/useTherapistSign";
import { claimPrintWindow, downloadConsultationForm, printConsultationForm } from "@/lib/consultationFormPrint";
import { ConsultationFormSheets, EMPTY_FORM, PatientDetailsSheet, formBranchName, formBranchesFrom, formFromLead, showDate } from "@/components/branch/ConsultationFormSheets";
import { LeadConsultationFormPopup } from "@/components/branch/LeadConsultationFormPopup";
import { branchNameOf } from "@/lib/branchOrder";

/**
 * Settings > Consultation Form: the clinic's three-page paper Offline Consultation Form,
 * filled on screen. The list keeps the branch's saved forms; a tap opens one in the same
 * layout to edit. New Form opens the Consultation Form's steps (LeadConsultationFormPopup
 * with no lead), not the paper. The toolbar's calendar narrows the list by the form's Date,
 * and New to Old / Old to New orders it. A row's Share Link sends the patient a link to fill
 * their part themselves (pages/ClientConsultationFormPage); Print and Download give the
 * filled paper back (lib/consultationFormPrint).
 *
 * A plain overlay by default (the Consultant's patient card opens it that way). `inline`
 * draws the same card in the page instead, as a tab view: the Branch Admin's Settings gear
 * opens it in the board's place, with no close button, held to the screen's height so the
 * footer's Save stays in sight while the three pages scroll.
 */

const fillFrom = (r) => Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, r?.[k] || ""]));
// A saved form as it prints: its fields, and the sign it was saved with.
const paperOf = (r) => ({ ...fillFrom(r), therapist_sign: r?.therapist_sign?.image || "" });
// A row's day: the form's own Date (local midnight), else the day it was saved.
const rowDay = (r) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date || "");
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const t = new Date(r.created_at || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};
const savedAt = (r) => new Date(r.created_at || 0).getTime() || 0;
const SORTS = [{ value: "newest", label: "New to Old" }, { value: "oldest", label: "Old to New" }];
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

const iconBtn = "rounded p-1.5 text-slate-400 transition hover:bg-sky-50 hover:text-sky-700";

/** The row's arrow: page 1's Patient Details, read only, with the row's tools under them. */
const DetailsPanel = ({ row, details, branches, pdfBusy, onShare, onPrint, onDownload, onEdit, onDelete, onClose }) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-3 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="consultation-form-details">
    <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[4px] bg-white shadow-xl">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className={`truncate text-base font-semibold ${row.name ? "text-slate-800" : "italic text-slate-400"}`}>{row.name || "Awaiting client"}</p>
          <StatusChip status={row.client_status} />
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="consultation-form-details-close"><X className="h-4 w-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-100 p-3 sm:p-4">
        {details ? (
          <div className="rounded-[4px] border border-slate-200 bg-white px-5 pb-4 pt-2 shadow-sm sm:px-8">
            <div className="flex flex-col gap-1"><PatientDetailsSheet f={details} branches={branches} readOnly /></div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onShare} className="gap-1.5 rounded-[4px] px-2.5" title="Share link to client" data-testid="consultation-form-details-share">
            <Link2 className="h-4 w-4" /><span className="hidden sm:inline">Share Link</span>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onPrint} className="gap-1.5 rounded-[4px] px-2.5" title="Print" data-testid="consultation-form-details-print">
            <Printer className="h-4 w-4" /><span className="hidden sm:inline">Print</span>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onDownload} disabled={pdfBusy === row.id} className="gap-1.5 rounded-[4px] px-2.5" title="Download PDF" data-testid="consultation-form-details-download">
            {pdfBusy === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}<span className="hidden sm:inline">Download</span>
          </Button>
        </div>
        <div className="flex gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onDelete} className="gap-1.5 rounded-[4px] border-rose-200 px-2.5 text-rose-600 hover:bg-rose-50 hover:text-rose-700" title="Delete" data-testid="consultation-form-details-delete">
            <Trash2 className="h-4 w-4" /><span className="hidden sm:inline">Delete</span>
          </Button>
          <Button type="button" size="sm" onClick={onEdit} className="gap-1.5 rounded-[4px] bg-sky-600 px-2.5 hover:bg-sky-700" title="Edit" data-testid="consultation-form-details-edit">
            <Pencil className="h-4 w-4" />Edit
          </Button>
        </div>
      </div>
    </div>
  </div>
);

export const ConsultationFormDialog = ({ branchId, onClose, initialLead = null, inline = false }) => {
  const [initialForm] = useState(() => initialLead ? formFromLead(initialLead) : EMPTY_FORM);
  // Opened from a lead: that lead's saved form, if it has one, opens instead of a new copy.
  const leadId = initialLead?.id || null;
  const [leadLookup, setLeadLookup] = useState(Boolean(leadId));
  // Whether the open form is that lead's: a form started or opened from the list is not.
  const [leadForm, setLeadForm] = useState(Boolean(leadId));
  const [view, setView] = useState(initialLead ? "form" : "list"); // "list" | "form"
  const [rows, setRows] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [q, setQ] = useState("");
  const [dateFilter, setDateFilter] = useState(null); // DateFilterPopover's { from, to, label }
  const [sortOrder, setSortOrder] = useState("newest"); // "newest" | "oldest"
  // New Form: the Consultation Form's steps over the app, not the paper.
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [meta, setMeta] = useState(null); // the open form's client_status and stamps
  // A form the client sent back opens as a read-only report; Edit (or the row's pencil) unlocks it.
  const [report, setReport] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [saved, setSaved] = useState(initialForm);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // The Branch boxes: the live offline branches (the paper's four until they come).
  const [branchNames, setBranchNames] = useState([]);
  // Page 3's sign: the names offered as the therapist's is typed, and the open form's own.
  const [signers, setSigners] = useState([]);
  const [savedSign, setSavedSign] = useState(null); // { name, image } | null
  const [share, setShare] = useState(null); // { token, name, contact }
  const [pdfBusy, setPdfBusy] = useState(null); // the id (or "open") a PDF is being drawn for
  // The row arrow's popup: the row, and its form once fetched.
  const [detailsRow, setDetailsRow] = useState(null);
  const [details, setDetails] = useState(null);
  const detailsFor = useRef(null); // so a slow fetch for a popup since shut is dropped
  const scrollRef = useRef(null);

  useEffect(() => {
    let live = true;
    getBranches()
      .then((list) => {
        if (!live) return;
        setBranchNames(formBranchesFrom(list));
        const branch = formBranchName(branchNameOf((list || []).find((b) => b.id === branchId)));
        if (initialLead) {
          setForm((current) => current.branch ? current : { ...current, branch });
          setSaved((current) => current === initialForm ? { ...current, branch } : current);
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [branchId, initialLead, initialForm]);

  useEffect(() => {
    let live = true;
    listTherapistNames(branchId)
      .then((r) => { if (live) setSigners(r.names || []); })
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

  // The calendar's days, then the order picked. Ties (one Date) go by when each was saved.
  const shown = useMemo(() => {
    const from = dateFilter?.from?.getTime();
    const to = dateFilter?.to?.getTime();
    const list = rows.filter((r) => {
      const t = rowDay(r);
      return !(from && t < from) && !(to && t > to);
    });
    const dir = sortOrder === "oldest" ? 1 : -1;
    return list.sort((a, b) => dir * (rowDay(a) - rowDay(b) || savedAt(a) - savedAt(b)));
  }, [rows, dateFilter, sortOrder]);

  const dirty = view === "form" && JSON.stringify(form) !== JSON.stringify(saved);
  const sign = useTherapistSign(branchId, view === "form" ? form.therapist_name : "", savedSign);
  const set = (key, v) => setForm((cur) => ({ ...cur, [key]: v }));
  const top = () => scrollRef.current?.scrollTo({ top: 0 });

  const openEdit = async (id, { edit = false, lead = false } = {}) => {
    setEditingId(id);
    setLeadForm(lead);
    setReport(false);
    setSavedSign(null);
    setView("form");
    setFormLoading(true);
    top();
    try {
      const r = await getConsultationForm(branchId, id);
      const filled = fillFrom(r);
      setForm(filled);
      setSaved(filled);
      setSavedSign(r.therapist_sign || null);
      setMeta({ client_status: r.client_status, client_submitted_at: r.client_submitted_at, share_token: r.share_token });
      setReport(!edit && r.client_status === "submitted");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
      setView("list");
    } finally {
      setFormLoading(false);
    }
  };

  // The lead's own form, looked up once: found, it opens to edit; not found (or the lookup
  // fails), the new form already filled from the lead stays up.
  useEffect(() => {
    if (!leadId) return undefined;
    let live = true;
    listConsultationForms(branchId, "", { leadId })
      .then((r) => {
        const mine = (r.forms || []).find((f) => f.lead_id === leadId);
        if (live && mine) openEdit(mine.id, { edit: true, lead: true });
      })
      .catch(() => {})
      .finally(() => { if (live) setLeadLookup(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, leadId]);

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
      else await createConsultationForm(branchId, form, { leadId: leadForm ? leadId : null });
      toast.success(editingId ? "Consultation form updated" : "Consultation form saved");
      setSaved(form);
      // Opened from a lead, the job is done: back to the lead, not to the branch's list.
      if (leadForm) { onClose(); return; }
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
    if (!window.confirm(`Delete the consultation form of ${row.name || "this client"}?\n\nIt cannot be undone.`)) return false;
    try {
      await deleteConsultationForm(branchId, row.id);
      toast.success("Consultation form deleted");
      setRows((cur) => cur.filter((r) => r.id !== row.id));
      return true;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete the form");
      return false;
    }
  };

  const openDetails = async (row) => {
    detailsFor.current = row.id;
    setDetailsRow(row);
    setDetails(null);
    try {
      const r = await getConsultationForm(branchId, row.id);
      if (detailsFor.current === row.id) setDetails(fillFrom(r));
    } catch (e) {
      if (detailsFor.current !== row.id) return;
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
      detailsFor.current = null;
      setDetailsRow(null);
    }
  };

  const closeDetails = () => {
    detailsFor.current = null;
    setDetailsRow(null);
    setDetails(null);
  };

  // A form the client already sent back is opened to them again only on purpose.
  const shareRow = async (row) => {
    if (row.client_status === "submitted" && !window.confirm(`${row.name || "The client"} has already filled this form.\n\nSend the link again so they can change their answers?`)) return;
    try {
      const r = await shareConsultationForm(branchId, row.id);
      setShare({ token: r.share_token, name: row.name, contact: row.contact_no });
      if (view === "form") setMeta((m) => ({ ...m, client_status: "requested", share_token: r.share_token }));
      setDetailsRow((d) => (d?.id === row.id ? { ...d, client_status: "requested" } : d));
      load(q.trim());
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't create the link");
    }
  };

  const printRow = async (id) => {
    const w = claimPrintWindow();
    if (!w) return;
    try {
      printConsultationForm(paperOf(await getConsultationForm(branchId, id)), w, branchNames);
    } catch (e) {
      w.close();
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
    }
  };

  const downloadRow = async (id) => {
    setPdfBusy(id);
    try {
      await downloadConsultationForm(paperOf(await getConsultationForm(branchId, id)), branchNames);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't open the form");
    } finally {
      setPdfBusy(null);
    }
  };

  const downloadOpen = async () => {
    setPdfBusy("open");
    try { await downloadConsultationForm({ ...form, therapist_sign: sign }, branchNames); } finally { setPdfBusy(null); }
  };

  const card = (
      <div
        className={inline
          // Phone: under the header, above the bottom nav. Desk: under the header and the tab strip.
          ? "relative flex max-h-[calc(100dvh-var(--role-header-height,89px)-6.5rem)] min-h-[24rem] w-full flex-col overflow-hidden rounded-[4px] border border-slate-200 bg-white shadow-sm md:max-h-[calc(100dvh-var(--role-header-height,89px)-var(--branch-nav-height,42px)-2rem)]"
          : "relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl"}
        data-testid={inline ? "consultation-form-tab" : undefined}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {view === "form" && (
              <button type="button" onClick={backToList} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Back to the forms" data-testid="consultation-form-back">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <p className="flex min-w-0 items-center gap-2 truncate text-base font-semibold text-slate-800">
              <ClipboardList className="h-4 w-4 shrink-0 text-sky-600" />
              {view === "list" ? "Consultation Forms" : report ? (saved.name || "Consultation Form") : editingId ? `Edit — ${saved.name || "Consultation Form"}` : "New Consultation Form"}
            </p>
          </div>
          {!inline && (
            <button type="button" onClick={close} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="consultation-form-close"><X className="h-4 w-4" /></button>
          )}
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
                <DateFilterPopover value={dateFilter} onChange={setDateFilter} testid="consultation-form-date-filter" centered iconOnly phoneIconOnly snug />
                <ThemedSelect
                  value={sortOrder}
                  onChange={(v) => setSortOrder(v || "newest")}
                  options={SORTS}
                  title="Sort by date"
                  className="h-9 w-[8.5rem] shrink-0 rounded-[4px] text-sm"
                  testid="consultation-form-sort"
                />
                <Button type="button" size="sm" onClick={() => setCreating(true)} className="h-9 gap-1.5 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-new">
                  <Plus className="h-4 w-4" />New Form
                </Button>
              </div>

              {listLoading ? (
                <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : shown.length === 0 ? (
                <div className="rounded-[4px] border border-dashed border-slate-200 py-14 text-center text-sm text-slate-400" data-testid="consultation-form-empty">
                  {q ? "No form matches that search." : dateFilter ? "No form on those dates." : "No consultation forms yet. Tap New Form to fill one."}
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
                      {shown.map((r) => (
                        <tr key={r.id} onClick={() => openEdit(r.id)} className="cursor-pointer border-t border-slate-100 hover:bg-sky-50/50" data-testid={`consultation-form-row-${r.id}`}>
                          <td className="px-3 py-2.5">
                            <p className={r.name ? "font-medium text-slate-800" : "italic text-slate-400"}>{r.name || "Awaiting client"}</p>
                            {r.client_status && <div className="mt-0.5"><StatusChip status={r.client_status} /></div>}
                          </td>
                          <td className="hidden px-3 py-2.5 text-slate-600 sm:table-cell">{r.contact_no || "—"}</td>
                          <td className="hidden whitespace-nowrap px-3 py-2.5 text-slate-600 sm:table-cell">{showDate(r.date)}</td>
                          <td className="hidden px-3 py-2.5 text-slate-600 md:table-cell">{r.therapist_name || "—"}</td>
                          {/* Delete, then the arrow: the patient's details, with Share, Print, Download, Edit and Delete in their popup. */}
                          <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => remove(r)} className="rounded p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" aria-label="Delete form" title="Delete" data-testid={`consultation-form-delete-${r.id}`}><Trash2 className="h-4 w-4" /></button>
                              <button type="button" onClick={() => openDetails(r)} className={iconBtn} aria-label="Open patient details" title="Patient details" data-testid={`consultation-form-open-${r.id}`}><ChevronRight className="h-4 w-4" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : formLoading || leadLookup ? (
            <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <>
              {leadForm && !editingId && (
                <p className="mb-3 rounded-[4px] border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800" data-testid="consultation-form-from-lead">
                  Filled from the lead's details. Blank fields are optional — fill what you have.
                </p>
              )}
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
              {/* In a tab, the paper keeps the popup's width rather than stretching across the desk. */}
              <div className={inline ? "mx-auto w-full max-w-4xl" : ""}>
                <ConsultationFormSheets f={form} set={set} readOnly={report} branches={branchNames} sign={sign} signers={signers} />
              </div>
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
              <Button type="button" variant="outline" size="sm" onClick={() => printConsultationForm({ ...form, therapist_sign: sign }, null, branchNames)} disabled={formLoading} className="gap-1.5 rounded-[4px] px-2.5" title="Print" data-testid="consultation-form-footer-print">
                <Printer className="h-4 w-4" /><span className="hidden sm:inline">Print</span>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={downloadOpen} disabled={formLoading || pdfBusy === "open"} className="gap-1.5 rounded-[4px] px-2.5" title="Download PDF" data-testid="consultation-form-footer-download">
                {pdfBusy === "open" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}<span className="hidden sm:inline">Download</span>
              </Button>
            </div>
            <div className="flex gap-2">
              {report ? (
                <Button type="button" size="sm" onClick={() => setReport(false)} disabled={formLoading} className="gap-1.5 rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-unlock">
                  <Pencil className="h-4 w-4" />Edit
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={leadForm ? close : backToList} disabled={saving} className="rounded-[4px]">Cancel</Button>
                  <Button type="button" size="sm" onClick={save} disabled={formLoading || leadLookup || saving || (editingId && !dirty)} className="rounded-[4px] bg-sky-600 hover:bg-sky-700" data-testid="consultation-form-save">
                    {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{editingId ? "Update" : "Save"}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {detailsRow && view === "list" && (
          <DetailsPanel
            row={detailsRow}
            details={details}
            branches={branchNames}
            pdfBusy={pdfBusy}
            onShare={() => shareRow(detailsRow)}
            onPrint={() => printRow(detailsRow.id)}
            onDownload={() => downloadRow(detailsRow.id)}
            onEdit={() => { const id = detailsRow.id; closeDetails(); openEdit(id, { edit: true }); }}
            onDelete={async () => { if (await remove(detailsRow)) closeDetails(); }}
            onClose={closeDetails}
          />
        )}
        {share && <SharePanel share={share} onClose={() => setShare(null)} />}
        {/* Over the whole app, out of the card's clipping: the steps carry their own overlay. */}
        {creating && createPortal(
          <LeadConsultationFormPopup branchId={branchId} onClose={() => setCreating(false)} onSaved={() => load(q.trim())} />,
          document.body,
        )}
      </div>
  );

  if (inline) return card;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="consultation-form-dialog">
      {card}
    </div>
  );
};
