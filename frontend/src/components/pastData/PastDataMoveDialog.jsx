import { useEffect, useState } from "react";
import { ArrowUpRight, Info, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { movePastDataToLive, previewPastDataMove, takeBackPastDataMove } from "@/lib/api";

const n = (v) => (v || 0).toLocaleString("en-IN");

// What the sheet said, where it differs from the pill it lands under (see stage_for in
// backend past_data_live.py). An OS Data sheet's stages come with their own `note`.
const STAGE_NOTES = {
  Leads: "no course in the sheet",
  "Follow Up": "On Hold",
  "Fee Collected": "a consultation only",
  "Physio Assign": "a course running",
  Completed: "Completed",
  "Referred Out": "Referred Out",
  Cancel: "Dropped",
};

/**
 * Move to live, and its undo, for one sheet (see backend past_data_live.py).
 *
 * `mode` "move" asks the server what moving would do first -- how many clients go onto this
 * branch's Branch Leads, how many are skipped as already moved from another sheet, how many
 * are already live at a working branch -- and moves only once that has been read and ticked.
 * "back" takes the sheet's live clients off again. Either way the sheet stays in Past Data.
 */
export const PastDataMoveDialog = ({ sheet, mode, onClose, onDone }) => {
  const back = mode === "back";
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setPreview(null); setLoadError(""); setConfirmed(false); setError("");
    if (!sheet || back) return undefined;
    let live = true;
    previewPastDataMove(sheet.id)
      .then((res) => { if (live) setPreview(res); })
      .catch((e) => { if (live) setLoadError(e?.response?.data?.detail || "Could not check this sheet"); });
    return () => { live = false; };
  }, [sheet, back]);

  const close = () => {
    if (busy) return;
    onClose();
  };

  const run = async () => {
    setBusy(true); setError("");
    try {
      if (back) {
        const res = await takeBackPastDataMove(sheet.id);
        toast.success(`${sheet.label}: ${n(res.removed_leads)} live clients returned back`);
      } else {
        const res = await movePastDataToLive(sheet.id);
        toast.success(`${sheet.label}: ${n(res.live_move.leads)} clients are live on Branch Leads`);
      }
      setBusy(false);
      onDone();
    } catch (e) {
      setError(e?.response?.data?.detail || (back ? "Could not return them back -- nothing was changed" : "Could not move -- nothing was changed"));
      setBusy(false);
    }
  };

  const live = sheet?.live_move;
  const branch = preview?.branch_name || "this branch";
  const ready = back ? !!live : !!preview && !preview.moved && preview.adding > 0;

  return (
    <Dialog open={!!sheet} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-w-lg" aria-describedby="past-move-body" data-testid="past-move-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {back ? <Undo2 className="h-5 w-5 text-slate-600" /> : <ArrowUpRight className="h-5 w-5 text-emerald-600" />}
            {back ? "Return Back" : "Move to Live"}: {sheet?.label}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4" id="past-move-body">
          {back ? (
            <p className="text-sm text-slate-700">
              Removes the <b>{n(live?.leads)} live clients</b> this sheet put on Branch Leads, with any stage moves, remarks
              and follow-ups made on them since. The sheet stays in Past Data and can be moved again.
            </p>
          ) : loadError ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="past-move-load-error">{loadError}</p>
          ) : !preview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Checking the sheet…</div>
          ) : preview.moved ? (
            <p className="text-sm text-slate-700">This sheet is live already.</p>
          ) : (
            <>
              <ul className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" data-testid="past-move-plan">
                <li><b>{n(preview.adding)}</b> clients go onto {branch}'s Branch Leads, each with a patient number, on the stage the sheet puts them at:</li>
                {preview.stage_counts?.length > 0 && (
                  <li>
                    <ul className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2" data-testid="past-move-stages">
                      {preview.stage_counts.map((s) => (
                        <li key={s.stage} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                          <span>
                            <b>{s.pill}</b>
                            <span className="text-slate-400"> · {s.note || STAGE_NOTES[s.stage] || s.stage}</span>
                          </span>
                          <span className="font-semibold tabular-nums">{n(s.count)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                {/* An OS Data sheet's alone (care_summary in backend past_data_live.py): who
                    goes to the Consultant and Physio the sheet names, with their course, fee
                    and session days, and every name the OS has nobody for. */}
                {preview.care && (
                  <li data-testid="past-move-care">
                    <ul className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
                      {[
                        ["With their Consultant", preview.care.consultants],
                        ["With their Physio", preview.care.physios],
                        ["Package", preview.care.packages],
                        ["Fee paid", preview.care.fees_paid],
                        ["Session days", preview.care.days],
                      ].map(([label, value]) => (
                        <li key={label} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                          <span>{label}</span>
                          <span className="font-semibold tabular-nums">{n(value)}</span>
                        </li>
                      ))}
                    </ul>
                    {preview.care.unread_days > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        {n(preview.care.unread_days)} session{preview.care.unread_days === 1 ? "" : "s"} left out: Status is not Completed or Upcoming.
                      </p>
                    )}
                    {preview.care.missing?.length > 0 && (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800" data-testid="past-move-missing">
                        <p className="font-semibold">Not carried, fix the name in the sheet or in HR:</p>
                        <ul className="mt-1 space-y-0.5">
                          {preview.care.missing.map((m) => (
                            <li key={`${m.role}-${m.name}-${m.why}`}>
                              <b>{m.role} {m.name}</b>: {m.why} ({n(m.clients)} client{m.clients === 1 ? "" : "s"})
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                )}
                {preview.skipped > 0 && (
                  <li>
                    <b>{n(preview.skipped)}</b> skipped: already moved from another sheet
                    {preview.skipped_names?.length ? ` (${preview.skipped_names.slice(0, 4).join(", ")}${preview.skipped > 4 ? "…" : ""})` : ""}.
                  </li>
                )}
                {preview.live_elsewhere > 0 && (
                  <li><b>{n(preview.live_elsewhere)}</b> are already in the OS at a working branch, by phone. They are added here too, and the card says where.</li>
                )}
              </ul>
              <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {preview.care ? (
                  <span>
                    Not counted on any dashboard, and nobody is messaged. Each client goes to the Consultant and Physio the sheet
                    names, so they see them on their own boards. Their Excel payments show on this branch's Accountant tab only.
                    Return Back removes them, with their appointments and session days.
                  </span>
                ) : (
                  <span>
                    A trial on {branch} only. These clients are not counted on any dashboard or other branch, and nobody is messaged.
                    Their Excel payments show on this branch's Accountant tab only, read from the sheet, never in OS revenue.
                    What the sheet said about each one is on their card. Return Back removes them.
                  </span>
                )}
              </div>
            </>
          )}

          {error && <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" data-testid="past-move-error">{error}</p>}

          {ready && (
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="past-move-confirm" />
              {back ? `I want to take ${sheet?.label}'s clients off Branch Leads.` : `I want to put ${n(preview.adding)} clients on ${branch}'s Branch Leads.`}
            </label>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <Button type="button" variant="outline" onClick={close} disabled={busy} data-testid="past-move-cancel">Cancel</Button>
            {ready && (
              <Button
                type="button"
                className={`gap-2 text-white ${back ? "bg-slate-600 hover:bg-slate-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
                disabled={!confirmed || busy}
                onClick={run}
                data-testid="past-move-submit"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : back ? <Undo2 className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                {busy ? (back ? "Returning…" : "Moving…") : back ? "Return Back" : "Move to Live"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PastDataMoveDialog;
