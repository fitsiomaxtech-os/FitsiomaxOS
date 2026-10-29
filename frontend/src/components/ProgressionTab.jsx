import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Lock, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { closeCaseSheet, leadProgression, setGoogleReview, uploadLeadDocument, verifyGoogleReview, verifyLeadDocument } from "@/lib/api";

/**
 * PROGRESSION — the proof a course of treatment actually delivered something.
 *
 * Four things are gathered as the course runs, and the case sheet cannot be closed until
 * every one of them is both uploaded and verified. Reported per requirement rather than as
 * a single count, because "3 of 4" tells a physio to go hunting; naming the missing one
 * tells them what to do next.
 *
 * Three states, not two. "Uploaded, not yet checked" is the state a branch has to act on,
 * and folding it into Pending would hide the work that is waiting on somebody.
 *
 * Uploading and verifying are deliberately different jobs: the physio delivering the course
 * gathers the clips, and the branch or the consultant confirms them. A case sheet that one
 * person could close by uploading four files and ticking them off themselves would prove
 * nothing, which is the whole reason for asking.
 */

const STATUS = {
  completed: { label: "Completed", icon: CheckCircle2, chip: "bg-emerald-100 text-emerald-700", ring: "border-emerald-200" },
  uploaded: { label: "Awaiting check", icon: Clock, chip: "bg-amber-100 text-amber-700", ring: "border-amber-200" },
  pending: { label: "Pending", icon: AlertCircle, chip: "bg-slate-100 text-slate-500", ring: "border-slate-200" },
};

// Every line on the tab is one row of the same height, with the status chip and the button
// in fixed-width columns on the right, so the summary, the four requirements and any files
// under them line up as one table.
const ROW = "flex h-11 items-center gap-2 rounded-[4px] border px-3";
const CHIP = "flex h-6 w-24 shrink-0 items-center justify-center gap-1 rounded-[4px] text-[10px] font-semibold";
const BTN = "flex h-8 w-32 shrink-0 items-center justify-center gap-1.5 rounded-[4px] px-0 text-xs font-medium";
const NO_BTN = <span className="w-32 shrink-0" aria-hidden />;

// canClose follows canVerify unless a caller says otherwise. The physio's own popup closes
// without verifying: the server still holds the close until somebody else has verified all
// four, so the one closing never signs off their own clips.
export function ProgressionTab({ leadId, canUpload = true, canVerify = false, canClose = canVerify }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyKind, setBusyKind] = useState(null);
  const [closing, setClosing] = useState(false);
  // The typed requirement is held locally until Save. Writing on every keystroke would
  // clear the verification on every keystroke too — see setGoogleReview.
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewLoaded, setReviewLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    try {
      const next = await leadProgression(leadId);
      setData(next);
      // Seeded once from the server, then left alone: re-seeding on every reload would
      // wipe what someone was part-way through typing.
      const review = (next.requirements || []).find((r) => r.input === "text");
      setReviewDraft((cur) => (reviewLoaded ? cur : (review?.text || "")));
      setReviewLoaded(true);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [leadId, reviewLoaded]);

  useEffect(() => { load(); }, [load]);

  const upload = async (kind, file) => {
    if (!file) return;
    setBusyKind(kind);
    try {
      await uploadLeadDocument(leadId, file, "", kind);
      toast.success("Uploaded — it needs checking before it counts");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Upload failed");
    }
    setBusyKind(null);
  };

  const verify = async (docId, verified) => {
    setBusyKind(docId);
    try {
      await verifyLeadDocument(leadId, docId, verified);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't change that");
    }
    setBusyKind(null);
  };

  const saveReview = async () => {
    setBusyKind("progress_review");
    try {
      await setGoogleReview(leadId, reviewDraft);
      toast.success("Review saved — it needs checking before it counts");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the review");
    }
    setBusyKind(null);
  };

  const verifyReview = async (verified) => {
    setBusyKind("progress_review");
    try {
      await verifyGoogleReview(leadId, verified);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't change that");
    }
    setBusyKind(null);
  };

  const close = async () => {
    if (!window.confirm("Close this case sheet? Everything required is in and checked.")) return;
    setClosing(true);
    try {
      await closeCaseSheet(leadId);
      toast.success("Case sheet closed");
      await load();
    } catch (e) {
      // The server names what is still missing, so it is shown rather than replaced with a
      // generic failure — it is the only thing that says what to do next.
      toast.error(e?.response?.data?.detail || "Couldn't close the case sheet");
    }
    setClosing(false);
  };

  if (loading) return <p className="py-10 text-center text-sm text-slate-400">Loading progression…</p>;
  if (!data) return <p className="py-10 text-center text-sm text-slate-400">Couldn't load this patient's progression.</p>;

  const closed = data.case_sheet_closed;

  return (
    <div className="space-y-2" data-testid="progression-tab">
      {/* Where the case sheet stands, before any single requirement is read. The rows below
          say which ones are still pending, so the summary does not list them again. */}
      <div className={`${ROW} ${
        closed ? "border-slate-200 bg-slate-50" : data.can_close ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
      }`} data-testid="progression-summary">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
          <span className="mr-2 text-xs uppercase tracking-wider text-slate-600">Case Sheet</span>
          {closed
            ? `Closed${data.case_sheet_closed_by ? ` by ${data.case_sheet_closed_by}` : ""}`
            : `${data.completed} of ${data.total} completed`}
        </p>
        {!closed && canClose && (
          <Button
            size="sm"
            disabled={!data.can_close || closing}
            title={data.can_close ? undefined : "Every requirement has to be uploaded and verified first"}
            className={`${BTN} [&_svg]:size-3.5 ${data.can_close ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-slate-100 text-slate-400"}`}
            onClick={close}
            data-testid="progression-close"
          >
            <Lock />
            {closing ? "Closing…" : "Close Case Sheet"}
          </Button>
        )}
        {closed && (
          <span className={`${CHIP} bg-slate-200 text-slate-600`}>
            <Lock className="h-3 w-3" /> Closed
          </span>
        )}
      </div>

      {(data.requirements || []).map((req) => {
        const meta = STATUS[req.status] || STATUS.pending;
        const Icon = meta.icon;
        const icon = <Icon className={`h-4 w-4 shrink-0 ${req.status === "completed" ? "text-emerald-600" : req.status === "uploaded" ? "text-amber-600" : "text-slate-400"}`} />;
        const chip = <span className={`${CHIP} ${meta.chip}`}>{meta.label}</span>;

        // Typed, not filed: the review sits on its one row as a single-line box, with Save
        // while there is an unsaved change and Verify once it is saved.
        if (req.input === "text") {
          const dirty = reviewDraft.trim() !== (req.text || "").trim();
          const busy = busyKind === "progress_review";
          let action = NO_BTN;
          if (canUpload && !closed && (dirty || !(canVerify && req.text))) {
            action = (
              <Button
                size="sm"
                disabled={busy || !dirty}
                onClick={saveReview}
                className={`${BTN} bg-sky-600 text-white hover:bg-sky-700`}
                data-testid="progression-review-save"
              >
                {busy ? "Saving…" : "Save Review"}
              </Button>
            );
          } else if (canVerify && !closed && req.text) {
            action = (
              <button
                type="button"
                onClick={() => verifyReview(!req.verified)}
                disabled={busy}
                title={req.verified && req.verified_by ? `Verified by ${req.verified_by}` : undefined}
                className={`${BTN} ${req.verified ? "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
                data-testid="progression-review-verify"
              >
                {req.verified ? "Undo" : "Verify"}
              </button>
            );
          }
          return (
            <div key={req.kind} className={`${ROW} bg-white ${meta.ring}`} data-testid={`progression-${req.kind}`}>
              {icon}
              <span className="hidden shrink-0 text-sm font-semibold text-slate-800 sm:inline">{req.label}</span>
              {/* The review is written by whoever collected it. A reader who cannot add one
                  gets it as text rather than as a box that looks fillable and a Save that
                  would be refused — the same rule the three uploads follow. */}
              {canUpload ? (
                <input
                  type="text"
                  value={reviewDraft}
                  onChange={(e) => setReviewDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) saveReview(); }}
                  disabled={closed}
                  placeholder="Google review link or text"
                  title={reviewDraft || undefined}
                  className="h-8 min-w-0 flex-1 rounded-[4px] border border-slate-200 px-2.5 text-xs text-slate-700 focus:border-sky-400 focus:outline-none disabled:bg-slate-50"
                  data-testid="progression-review-text"
                />
              ) : (
                <span className={`min-w-0 flex-1 truncate text-xs ${req.text ? "text-slate-700" : "italic text-slate-400"}`} title={req.text || undefined} data-testid="progression-review-readonly">
                  {req.text || "Not added yet"}
                </span>
              )}
              {chip}
              {action}
            </div>
          );
        }

        return (
          <div key={req.kind} className="space-y-1" data-testid={`progression-${req.kind}`}>
            <div className={`${ROW} bg-white ${meta.ring}`}>
              {icon}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800" title={req.label}>{req.label}</span>
              {chip}
              {/* Closed means closed: nothing more is filed against a case sheet that has
                  been signed off, or the thing it was signed off against changes afterwards. */}
              {canUpload && !closed ? (
                <label className={`${BTN} cursor-pointer border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
                  <Upload className="h-3.5 w-3.5" />
                  {busyKind === req.kind ? "Uploading…" : req.documents?.length ? "Add another" : "Upload"}
                  <input
                    type="file"
                    className="hidden"
                    accept={req.kind === "progress_review" ? "image/*,application/pdf" : "video/*,image/*"}
                    disabled={busyKind === req.kind}
                    onChange={(e) => { upload(req.kind, e.target.files?.[0]); e.target.value = ""; }}
                    data-testid={`progression-upload-${req.kind}`}
                  />
                </label>
              ) : NO_BTN}
            </div>

            {/* Each file is a row of its own under the requirement, on the same columns:
                its name, whether it has been checked, and the check itself. */}
            {req.documents?.map((d) => (
              <div key={d.id} className={`${ROW} ml-6 border-slate-100 bg-slate-50`}>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-600" title={d.original_name || d.label}>
                  {d.original_name || d.label || "File"}
                </span>
                <span
                  className={`${CHIP} ${d.verified ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
                  title={d.verified && d.verified_by ? `Verified by ${d.verified_by}` : undefined}
                >
                  {d.verified ? "Verified" : "Not checked"}
                </span>
                {canVerify ? (
                  <button
                    type="button"
                    onClick={() => verify(d.id, !d.verified)}
                    disabled={busyKind === d.id}
                    className={`${BTN} ${d.verified ? "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
                    data-testid={`progression-verify-${d.id}`}
                  >
                    {d.verified ? "Undo" : "Verify"}
                  </button>
                ) : NO_BTN}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default ProgressionTab;
