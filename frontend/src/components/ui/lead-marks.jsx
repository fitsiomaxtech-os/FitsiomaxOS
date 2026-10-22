import { AlertCircle, ArrowLeftRight, RotateCcw, Star, Video } from "lucide-react";

/**
 * The two marks a branch puts on a patient by hand, shown read-only.
 *
 * They are set in one place — Branch Leads, on any of its stages, where the branch's own
 * admin has the patient in front of them. Everywhere else a patient surfaces they are only
 * reported: a Consultant seeing the gold star knows to treat this one especially well, a
 * Physio seeing the red flag knows something needs looking at, and neither is being asked
 * to decide it from the fraction of the branch their own board shows them.
 *
 * Renders nothing at all when a patient carries neither, because these lists are long and a
 * pair of empty outlines on every row of them is noise standing in for information. The
 * editable pair in Branch Leads does the opposite, and for the opposite reason: there the
 * control has to be findable before it has ever been used.
 */
export const LeadMarks = ({ lead, className = "" }) => {
  const vip = !!(lead?.is_vip);
  const attention = !!(lead?.needs_attention);
  if (!vip && !attention) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 align-middle ${className}`} data-testid="lead-marks">
      {vip && (
        <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-label="VIP client">
          <title>VIP client</title>
        </Star>
      )}
      {attention && (
        <AlertCircle className="h-3.5 w-3.5 fill-rose-500 text-white" aria-label="Needs attention">
          <title>Needs attention</title>
        </AlertCircle>
      )}
    </span>
  );
};

/**
 * "Rescheduled" — this patient's consultation was moved off the slot it was first booked
 * onto.
 *
 * A mark, not a stage, and it lives here beside the other two for the same reason: it says
 * something about how a patient's booking has gone, never about where they are in the
 * pipeline. A rescheduled lead is still sitting in Appointment waiting for the same
 * consultation.
 *
 * Set in one place — Branch Leads, by rebooking the appointment onto a different slot —
 * and reported read-only everywhere else. The Consultant about to see this patient, and
 * the Head Physio looking at the day's calendar, both want to know the 10:30 in front of
 * them is not the time that was originally arranged; neither is being asked to decide it.
 *
 * Renders nothing when the patient has not been moved, like LeadMarks above and for the
 * same reason: an empty outline on every row of a long list is noise standing in for
 * information.
 *
 * The count shows from the second move on. One reschedule is ordinary and needs no number;
 * three is a patient who keeps not coming, and that is worth reading off the row rather
 * than out of the activity log.
 */
export const RescheduledTag = ({ lead, className = "", compact = false }) => {
  if (!lead?.appointment_rescheduled) return null;
  const count = Number(lead.appointment_reschedule_count) || 1;
  const from = lead.appointment_rescheduled_from || "";
  const title = from
    ? `Rescheduled ${count > 1 ? `${count} times, last ` : ""}from ${from.replace("T", " ")}`
    : "Appointment rescheduled";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200 align-middle ${
        compact ? "px-1 py-0 text-[8px]" : "px-1.5 py-0.5 text-[9px]"
      } ${className}`}
      title={title}
      aria-label={title}
      data-testid="lead-rescheduled-tag"
    >
      <RotateCcw className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
      {compact ? (count > 1 ? `×${count}` : "") : <>Rescheduled{count > 1 ? ` ×${count}` : ""}</>}
    </span>
  );
};

/**
 * "Transferred" — this patient came here from another branch, or has left for one.
 *
 * The third mark, and it belongs beside the other two rather than in the stage strip for
 * the same reason they do: a transferred patient is not at a stage of their own. They are
 * sitting in New Appointment or in Physio Assign exactly like everybody around them, and
 * the one thing that is not true of the row either side of theirs is that the history
 * behind them happened somewhere else.
 *
 * Which is worth a glyph on the name because of what the history costs to read otherwise.
 * The money already collected stayed in the branch they came from (revenue_branch_splits),
 * their booked treatment days were released and have to be booked again here, and their
 * Patient Number was issued by the other branch. A Branch Admin who does not know that is
 * about to wonder why a patient at Fee Collected has nothing in this branch's book.
 *
 * Set by nobody: unlike the star and the flag, this is not a judgement anyone makes about
 * a patient — it is written by the transfer itself, in BranchTransferDialog, and read here.
 *
 * Indigo, which is the colour the transfer dialog already uses for itself, and the arrow
 * it opens with. Renders nothing for a patient who has never moved, like the marks above
 * it: most patients have not, and an outline on every row of them is noise.
 *
 * The count shows from the second move on, on the same reasoning as RescheduledTag: one
 * transfer is ordinary, three is a patient nobody has settled, and that reads better off
 * the row than out of the activity log.
 */
export const TransferredTag = ({ lead, className = "", compact = false }) => {
  const moves = lead?.branch_transfer_history || [];
  if (!moves.length) return null;
  const last = moves[moves.length - 1] || {};
  const from = last.from_branch_name || "another branch";
  const on = last.at ? String(last.at).slice(0, 10) : "";
  const title = `${moves.length > 1 ? `Transferred ${moves.length} times, last ` : "Transferred "}from ${from}${on ? ` on ${on}` : ""}`;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 align-middle font-bold text-indigo-600 ${
        compact ? "text-[8px]" : "text-[9px]"
      } ${className}`}
      title={title}
      aria-label={title}
      data-testid="lead-transferred-tag"
    >
      <ArrowLeftRight className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      {moves.length > 1 ? `×${moves.length}` : ""}
    </span>
  );
};

/**
 * "Online" — this patient's course is on the Online package.
 *
 * Set by Mark Online (or a Swap to Online) on the Physio Assign panel, and cleared by
 * Unmark Online, which puts session_package_mode back to "offline". The tag reads that
 * one field, so it shows on every list the lead appears on until it is unmarked.
 *
 * Violet, the colour of the Online chip on the physio card, with the same video glyph
 * the Mark Online button carries. Renders nothing for an Offline patient.
 */
export const OnlineTag = ({ lead, className = "", compact = false }) => {
  if (lead?.session_package_mode !== "online") return null;
  const on = lead.online_marked_at ? String(lead.online_marked_at).slice(0, 10) : "";
  const title = `Online${on ? ` — marked ${on}${lead.online_marked_by ? ` by ${lead.online_marked_by}` : ""}` : ""}`;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-[2px] bg-violet-600 font-bold uppercase tracking-wide text-white align-middle ${
        compact ? "px-1 py-0 text-[8px]" : "px-1.5 py-0.5 text-[9px]"
      } ${className}`}
      title={title}
      aria-label={title}
      data-testid="lead-online-tag"
    >
      <Video className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
      {compact ? "" : "Online"}
    </span>
  );
};

export default LeadMarks;
