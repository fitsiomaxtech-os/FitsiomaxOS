import { useEffect, useRef, useState } from "react";
import { Eye, Loader2, Signature, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getSignature, listSignatures, uploadSignature } from "@/lib/api";
import { SIGN_FILE_TYPES, signFromFile, signSrc } from "@/lib/signImage";

const showDay = (iso) => {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/** Where a person's sign prints, under their group's heading. */
const PRINTS_ON = {
  "Branch Admin": "Bills they collect",
  Consultant: "Prescription, Consultation Form",
  Therapist: "Consultation Form",
  Other: "Bills they collect",
};

/**
 * One sign on its own: the one already saved (View), or the one just picked, as it will
 * print, with Save. White behind it on every theme, as the paper is.
 */
const SignPanel = ({ title, image, note, busy = false, onSave, onClose }) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} data-testid="digital-sign-panel">
    <div className="flex w-full max-w-md flex-col overflow-hidden rounded-[4px] bg-white shadow-xl">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <p className="min-w-0 truncate text-sm font-semibold text-slate-800">{title}</p>
        <button type="button" onClick={onClose} disabled={busy} className="rounded-[4px] p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" data-testid="digital-sign-panel-close"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-4">
        <div className="flex h-44 flex-col justify-end rounded-[4px] border border-slate-200 bg-[#fff] px-6 pb-4">
          {image ? (
            <div className="text-center">
              <img src={image} alt={title} className="inline-block max-h-28 max-w-full" data-testid="digital-sign-image" />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-sky-600" /></div>
          )}
          <div className="mx-auto mt-1 w-56 border-t-2 border-dotted border-[#525252] pt-1 text-center text-xs text-[#525252]">Signature</div>
        </div>
        {note && <p className="mt-2 text-xs text-slate-500" data-testid="digital-sign-note">{note}</p>}
      </div>
      {onSave && (
        <div className="flex justify-end border-t border-slate-100 px-4 py-3">
          <Button type="button" onClick={onSave} disabled={busy} className="h-9 rounded-[4px] bg-sky-600 px-5 hover:bg-sky-700" data-testid="digital-sign-save">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
        </div>
      )}
    </div>
  </div>
);

/**
 * Admin Setting > Digital Sign: everyone who signs at this branch, with Upload and View. The
 * sign then prints by itself -- on the bills a person collects, the prescriptions in their
 * name and the Consultation Forms that name them. A picked photo is cleaned down to the ink
 * first (lib/signImage.js) and shown before it is saved.
 *
 * A plain overlay, like the other popups in the same menu.
 */
export const DigitalSignDialog = ({ branchId, onClose }) => {
  const [data, setData] = useState(null); // { branch_name, groups, people }
  const [failed, setFailed] = useState("");
  const [tries, setTries] = useState(0);
  const [view, setView] = useState(null); // { person, image }
  const [draft, setDraft] = useState(null); // { person, blob, url }
  const [reading, setReading] = useState(""); // the person whose picture is being read
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const pickFor = useRef(null);
  const viewing = useRef(""); // so a slow picture for a panel since shut is dropped

  useEffect(() => {
    let live = true;
    setFailed("");
    listSignatures(branchId)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setFailed(e?.response?.data?.detail || "Couldn't load the signs"); });
    return () => { live = false; };
  }, [branchId, tries]);

  const draftUrl = draft?.url;
  useEffect(() => (draftUrl ? () => URL.revokeObjectURL(draftUrl) : undefined), [draftUrl]);

  const pick = (person) => {
    pickFor.current = person;
    fileRef.current?.click();
  };

  const read = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be picked again
    const person = pickFor.current;
    if (!file || !person) return;
    setReading(person.user_id);
    // A beat for the spinner to show: reading a large photo holds the page for a moment.
    await new Promise((r) => { setTimeout(r, 30); });
    try {
      setDraft({ person, ...(await signFromFile(file)) });
    } catch (err) {
      toast.error(err?.message || "This picture could not be read.");
    } finally {
      setReading("");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { person, blob } = draft;
      const r = await uploadSignature(person.user_id, branchId, blob);
      setData((d) => ({
        ...d,
        people: d.people.map((p) => (p.user_id === person.user_id ? { ...p, has_sign: true, uploaded_at: r.uploaded_at, uploaded_by: r.uploaded_by } : p)),
      }));
      setDraft(null);
      toast.success(`${person.name}'s sign saved`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the sign");
    } finally {
      setSaving(false);
    }
  };

  const open = async (person) => {
    viewing.current = person.user_id;
    setView({ person, image: "" });
    try {
      const r = await getSignature(person.user_id, branchId);
      if (viewing.current === person.user_id) setView({ person, image: signSrc(r.image) });
    } catch (e) {
      if (viewing.current !== person.user_id) return;
      viewing.current = "";
      setView(null);
      toast.error(e?.response?.data?.detail || "Couldn't open the sign");
    }
  };

  const shut = () => { viewing.current = ""; setView(null); };

  const groups = (data?.groups || [])
    .map((name) => ({ name, people: data.people.filter((p) => p.group === name) }))
    .filter((g) => g.people.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }} data-testid="digital-sign-dialog">
      <div className="relative flex h-[560px] max-h-[90vh] w-full max-w-[775px] flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl">
        {/* The same blue header as Branch Location's, beside it in the menu. */}
        <div className="flex items-center justify-between gap-3 border-b border-sky-700 bg-[#0284C7] px-5 py-3">
          <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold text-white">
            <Signature className="h-4 w-4 shrink-0 text-white" />
            <span className="shrink-0">Digital Sign</span>
            {data?.branch_name && <span className="truncate text-sm font-normal text-white/80">{data.branch_name}</span>}
          </h3>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-[4px] p-1 text-white/90 transition hover:bg-white/15 hover:text-white" aria-label="Close" data-testid="digital-sign-close"><X className="h-4 w-4" /></button>
        </div>

        <input ref={fileRef} type="file" accept={SIGN_FILE_TYPES.join(",")} onChange={read} className="hidden" data-testid="digital-sign-file" />

        {failed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-slate-500">
            {failed}
            <Button type="button" variant="outline" size="sm" onClick={() => setTries((n) => n + 1)} className="rounded-[4px]">Retry</Button>
          </div>
        ) : !data ? (
          <div className="flex flex-1 items-center justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {groups.map((g) => (
              <section key={g.name} data-testid={`digital-sign-group-${g.name.toLowerCase().replace(/\s+/g, "-")}`}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{g.name}</p>
                  <p className="truncate text-[11px] text-slate-400">{PRINTS_ON[g.name]}</p>
                </div>
                <div className="divide-y divide-slate-100 rounded-[4px] border border-slate-200">
                  {g.people.map((p) => (
                    <div key={p.user_id} className="flex items-center gap-2 px-3 py-2.5" data-testid={`digital-sign-row-${p.user_id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">
                          {p.name || "—"}{p.you && <span className="ml-1.5 text-xs font-normal text-slate-400">(You)</span>}
                        </p>
                        <p className={`truncate text-[11px] ${p.has_sign ? "text-emerald-700" : "text-slate-400"}`}>
                          {p.has_sign ? `Sign added${showDay(p.uploaded_at) ? ` · ${showDay(p.uploaded_at)}` : ""}` : "No sign yet"}
                        </p>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => open(p)} disabled={!p.has_sign} className="h-8 shrink-0 gap-1.5 rounded-[4px] px-2.5 text-xs" data-testid={`digital-sign-view-${p.user_id}`}>
                        <Eye className="h-3.5 w-3.5" />View
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => pick(p)}
                        disabled={!p.can_upload || !!reading}
                        title={p.can_upload ? "Upload" : "Only this person's own desk can upload their sign"}
                        className="h-8 w-[88px] shrink-0 gap-1.5 rounded-[4px] bg-sky-600 px-2.5 text-xs hover:bg-sky-700"
                        data-testid={`digital-sign-upload-${p.user_id}`}
                      >
                        {reading === p.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}Upload
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {view && (
          <SignPanel
            title={view.person.name}
            image={view.image}
            note={view.person.uploaded_by ? `Uploaded by ${view.person.uploaded_by}${showDay(view.person.uploaded_at) ? ` · ${showDay(view.person.uploaded_at)}` : ""}` : ""}
            onClose={shut}
          />
        )}
        {draft && (
          <SignPanel
            title={draft.person.name}
            image={draft.url}
            note={draft.person.has_sign ? "Replaces the present sign from today." : "This is how the sign will print."}
            busy={saving}
            onSave={save}
            onClose={() => setDraft(null)}
          />
        )}
      </div>
    </div>
  );
};
