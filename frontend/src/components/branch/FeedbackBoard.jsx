import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bell, Building2, CheckCircle2, Clock, Inbox, KeyRound, Lock, MessageCircle, RefreshCw, RotateCcw, Search, Send, Star, Stethoscope, Ticket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/ui/stat-tile";
import { toast } from "@/components/ui/sonner";
import {
  deleteFeedbackChat, devDeleteFeedback, devResetFeedbackToNew, getFeedbackChatDelete, listBranchFeedback, setFeedbackChatDelete, moveBranchFeedback, replyBranchFeedback, unlockDangerZone,
} from "@/lib/api";
import { displayPhone } from "@/lib/phone";

// What can have happened to a ticket, in the order it is worked through. A ticket arrives
// New, somebody picks it up, somebody asks whether it is settled, the patient closes it.
// Kept in step with STATUSES in backend/routers/v3_feedback.py.
const COLUMNS = [
  { key: "new", label: "New", icon: Inbox, color: "#d97706", sub: "waiting to be picked up", empty: "Nothing waiting." },
  { key: "in_progress", label: "In Progress", icon: Clock, color: "#0284c7", sub: "being dealt with", empty: "Nothing being dealt with." },
  { key: "awaiting_patient", label: "Asked", icon: MessageCircle, color: "#7c3aed", sub: "waiting on the patient", empty: "Nobody has been asked." },
  { key: "resolved", label: "Resolved", icon: CheckCircle2, color: "#059669", sub: "finished with", empty: "Nothing finished yet." },
];

const STATUS_CHIP = {
  new: { label: "New", classes: "border-amber-200 bg-amber-50 text-amber-700", dot: "#d97706" },
  in_progress: { label: "In Progress", classes: "border-sky-200 bg-sky-50 text-sky-700", dot: "#0284c7" },
  awaiting_patient: { label: "Asked", classes: "border-violet-200 bg-violet-50 text-violet-700", dot: "#7c3aed" },
  resolved: { label: "Resolved", classes: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "#059669" },
};

// Where a ticket can go from where it is. Both directions, because picking something up by
// mistake is ordinary and a board you cannot walk backwards on gets worked around.
//
// Resolve is not among them. Closing a complaint is not this side's to do: the branch says
// what it did and asks whether that settled it, and the patient's answer is what moves it.
// The button that asks lives on the composer, because asking is a message.
const MOVES = {
  new: [{ to: "in_progress", label: "Pick up" }],
  in_progress: [{ to: "new", label: "Put back" }],
  awaiting_patient: [{ to: "in_progress", label: "Still working on it" }],
  resolved: [{ to: "in_progress", label: "Reopen" }],
};

const shortDateTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** The time on the list, where the column is narrow and the day is usually today. */
const listStamp = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

// The ticket's reference, which is what a patient on the phone reads out and what two
// people at a desk use to mean the same complaint. The id is a uuid and nobody says one
// aloud, so the tail of it stands in — short enough to read, long enough that one client's
// handful of tickets never collide.
const ticketRef = (id) => `#${String(id || "").replace(/-/g, "").slice(-6).toUpperCase()}`;

// When this ticket last moved, whoever moved it. What the list sorts on: a ticket the
// patient wrote into an hour ago is live, whatever day it was opened.
const ticketAt = (t) => {
  const msgs = t.messages || [];
  return (msgs.length ? msgs[msgs.length - 1].created_at : "") || t.created_at || "";
};

const lastBody = (t) => {
  const msgs = t.messages || [];
  return msgs.length ? msgs[msgs.length - 1].body : (t.message || "");
};

// One client, one identity. lead_id is the account the feedback was written from; phone
// and name stand in for rows old enough to predate it, so nobody is split into two people
// on the list by a field that was not filled in yet.
const clientKey = (r) => r.lead_id || r.patient_phone || r.patient_name || r.id;

const AVATAR_TONES = ["#0284c7", "#7c3aed", "#059669", "#d97706", "#db2777", "#4f46e5"];
const toneFor = (key) => {
  let n = 0;
  for (const ch of String(key || "")) n = (n * 31 + ch.charCodeAt(0)) % 9973;
  return AVATAR_TONES[n % AVATAR_TONES.length];
};

const initialsOf = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map((w) => w[0]).join("") || "?").toUpperCase();
};

/** The rating as stars, or nothing at all.
 *
 *  Absent rather than zero stars when none was left: a patient who wrote a paragraph and
 *  skipped the rating has not given the place one star, and drawing five empty ones says
 *  they did.
 */
const Stars = ({ rating }) => {
  if (!rating) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={`${rating} out of 5`} aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`h-3 w-3 ${n <= rating ? "fill-amber-400 text-amber-400" : "text-slate-200"}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
};

const Avatar = ({ name, tone, size = "h-9 w-9 text-[11px]" }) => (
  <span
    aria-hidden
    className={`flex shrink-0 items-center justify-center rounded-full font-bold ${size}`}
    style={{ background: `${tone}1A`, color: tone }}
  >
    {initialsOf(name)}
  </span>
);

/**
 * One client on the list.
 *
 * Everything they have ever raised sits behind this single line, which is the point: the
 * board used to draw a card per ticket, so a patient who wrote three times was three
 * headings called Priya with three phone numbers under them and nothing to say from the
 * outside that they were one person.
 */
const ClientRow = ({ client, active, onSelect, showBranch, picking, pickedCount, onPick, onDelete, deleting }) => (
  <div className={`flex items-stretch border-l-2 transition ${active ? "border-sky-500 bg-sky-50/70" : "border-transparent hover:bg-slate-50"}`}>
  {/* Developer tools only: ticks every ticket this client has on the list. A checkbox beside
      the row rather than inside it, because a checkbox inside a button is not clickable on
      its own. */}
  {picking && (
    <label className="flex shrink-0 cursor-pointer items-center pl-3" title="Select all of this client's tickets">
      <input
        type="checkbox"
        className="h-4 w-4 accent-rose-600"
        checked={pickedCount > 0 && pickedCount === client.tickets.length}
        ref={(el) => { if (el) el.indeterminate = pickedCount > 0 && pickedCount < client.tickets.length; }}
        onChange={(e) => onPick(client.tickets.map((t) => t.id), e.target.checked)}
        data-testid={`feedback-pick-client-${client.key}`}
      />
    </label>
  )}
  <button
    type="button"
    onClick={() => onSelect(client.key)}
    className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
    data-testid={`feedback-client-${client.key}`}
  >
    <Avatar name={client.name} tone={client.tone} />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{client.name || "A patient"}</p>
        <span className="shrink-0 text-[10px] text-slate-400">{listStamp(client.lastAt)}</span>
      </div>
      <p className="truncate text-xs text-slate-500">{lastBody(client.tickets[0]) || "Rating only"}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {client.awaiting && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">Your turn</span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
          <Ticket className="h-3 w-3" aria-hidden />
          {client.tickets.length === 1 ? "1 ticket" : `${client.tickets.length} tickets`}
          {client.open > 0 ? ` · ${client.open} open` : ""}
        </span>
        {showBranch && client.branch_name ? (
          <span className="truncate text-[10px] text-slate-400">· {client.branch_name}</span>
        ) : null}
      </div>
    </div>
  </button>
  {/* Chat Delete, when a developer has switched it on. Beside the row for the same reason
      the checkbox is: a button inside a button is not clickable on its own. */}
  {onDelete && (
    <button
      type="button"
      onClick={() => onDelete(client)}
      disabled={deleting}
      className="flex shrink-0 items-center px-3 text-slate-300 transition hover:text-rose-600 disabled:opacity-50"
      title="Delete this chat"
      aria-label={`Delete ${client.name || "this patient"}'s chat`}
      data-testid={`feedback-chat-delete-${client.key}`}
    >
      <Trash2 className="h-4 w-4" />
    </button>
  )}
  </div>
);

/**
 * One client's tickets, and the conversation on whichever one is open.
 *
 * The rail across the top is why this is a ticket desk rather than a chat app: a patient
 * who complains about the parking in June and about a Physio in August has two separate
 * things to be dealt with, each with its own reference and status, and running them into
 * one stream would close both when the patient answers about one. The rail keeps them
 * apart; the thread underneath keeps each one readable as the conversation it is.
 */
const TicketPane = ({ client, ticket, onPickTicket, onMove, onSend, moving, sending, onBack, showBranch, picking, picked, onPick }) => {
  const [draft, setDraft] = useState("");
  const scroller = useRef(null);
  const ticketId = ticket?.id;
  const written = (ticket?.messages || []).length;

  // A half-written answer belongs to the ticket it was being written on, so moving to
  // another one puts it away. Only on the ticket changing, though: clearing it whenever the
  // thread grew would throw away what somebody was typing the moment a refresh brought in
  // the patient's latest line.
  useEffect(() => { setDraft(""); }, [ticketId]);

  // Back to the newest message whenever the ticket changes or is written into, the way any
  // conversation opens. Without it a long thread opens on the first line the patient wrote
  // months ago, with the answer just sent somewhere below the fold.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ticketId, written]);

  if (!ticket) return null;
  const thread = ticket.messages || [];
  const chip = STATUS_CHIP[ticket.status] || STATUS_CHIP.new;

  const send = (askResolved) => {
    const body = draft.trim();
    if (!body) { toast.error("Write something to send"); return; }
    onSend(ticket, body, askResolved, () => setDraft(""));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`feedback-ticket-${ticket.id}`}>
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 shrink-0 rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 md:hidden"
          aria-label="Back to the list"
          data-testid="feedback-thread-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Avatar name={client.name} tone={client.tone} size="h-10 w-10 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-800">{client.name || "A patient"}</p>
          <p className="truncate text-[11px] text-slate-400">
            {[displayPhone(client.phone), showBranch ? client.branch_name : ""].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Stars rating={ticket.rating} />
      </div>

      {/* Every ticket this client has raised, newest first. One ticket still gets a chip
          rather than no rail at all: the reference and the status are what a branch quotes
          back to a patient, and they should not appear and disappear depending on how many
          times somebody has written in. */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-100 bg-slate-50/70 px-4 py-2" data-testid="feedback-ticket-rail">
        {client.tickets.map((t) => {
          const c = STATUS_CHIP[t.status] || STATUS_CHIP.new;
          const on = t.id === ticket.id;
          return (
            <span key={t.id} className="flex shrink-0 items-center gap-1">
            {picking && (
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-rose-600"
                checked={picked.has(t.id)}
                onChange={(e) => onPick([t.id], e.target.checked)}
                aria-label={`Select ticket ${ticketRef(t.id)}`}
                data-testid={`feedback-pick-ticket-${t.id}`}
              />
            )}
            <button
              type="button"
              onClick={() => onPickTicket(t.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium transition ${
                on ? "border-slate-300 bg-white text-slate-700 shadow-sm" : "border-transparent text-slate-500 hover:bg-white"
              }`}
              title={`${c.label} · ${shortDateTime(t.created_at)}`}
              data-testid={`feedback-ticket-chip-${t.id}`}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} />
              {ticketRef(t.id)}
              <span className="font-sans text-[10px] text-slate-400">{listStamp(ticketAt(t))}</span>
              {t.awaiting_staff && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </button>
            </span>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2">
        <Ticket className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span className="font-mono text-[11px] font-semibold text-slate-600">{ticketRef(ticket.id)}</span>
        <span className="truncate text-[11px] text-slate-400">raised {shortDateTime(ticket.created_at)}</span>
        <span className="flex-1" />
        {/* Says the thread has been written into since anyone here last answered. The status
            cannot say this: it is still In Progress either way, and without it a patient's
            reply lands on a ticket somebody has already worked through. */}
        {ticket.awaiting_staff && (
          <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700" data-testid={`feedback-awaiting-${ticket.id}`}>
            Your turn
          </span>
        )}
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${chip.classes}`} data-testid={`feedback-status-${ticket.id}`}>
          {chip.label}
        </span>
      </div>

      {/* The exchange, oldest first, each side on its own. */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4" data-testid={`feedback-thread-${ticket.id}`}>
        {thread.length === 0 ? (
          <p className="text-xs italic text-slate-400">Rating only — nothing written.</p>
        ) : thread.map((m) => {
          const mine = m.author === "staff";
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-2xl px-3 py-2 ${mine ? "rounded-br-sm bg-sky-600 text-white" : "rounded-bl-sm bg-slate-100 text-slate-700"}`}>
                <p className="whitespace-pre-wrap break-words text-xs leading-5">{m.body}</p>
                <p className={`mt-1 text-[10px] ${mine ? "text-sky-100/80" : "text-slate-400"}`}>
                  {[mine ? (m.author_name || "Branch") : (client.name || "Patient"), shortDateTime(m.created_at)].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {ticket.status === "resolved" ? (
        <div className="shrink-0 border-t border-slate-100 bg-emerald-50/60 px-4 py-3" data-testid={`feedback-closed-${ticket.id}`}>
          <p className="text-[11px] text-emerald-700">The patient said this was settled.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(MOVES.resolved || []).map((m) => (
              <Button
                key={m.to}
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={moving}
                onClick={() => onMove(ticket, m.to)}
                data-testid={`feedback-move-${ticket.id}-${m.to}`}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-slate-200 bg-white p-3">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Enter sends, because this reads as a conversation and everybody's hands
            // already know that. Shift+Enter is the new line, for the answer that needs one.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(false); }
            }}
            placeholder="Write back to the patient…"
            className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            data-testid={`feedback-compose-${ticket.id}`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 bg-sky-600 px-2.5 text-[11px] text-white hover:bg-sky-700"
              disabled={sending}
              onClick={() => send(false)}
              data-testid={`feedback-send-${ticket.id}`}
            >
              <Send className="mr-1 h-3 w-3" /> Send
            </Button>
            {/* Closing one is asking a question, so it is a way of sending rather than a
                status to set. The patient's answer is what moves it. */}
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-emerald-200 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50"
              disabled={sending}
              onClick={() => send(true)}
              data-testid={`feedback-ask-resolved-${ticket.id}`}
            >
              Send &amp; ask if it is sorted
            </Button>
            {(MOVES[ticket.status] || []).map((m) => (
              <Button
                key={m.to}
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={moving}
                onClick={() => onMove(ticket, m.to)}
                data-testid={`feedback-move-${ticket.id}-${m.to}`}
              >
                {m.label}
              </Button>
            ))}
            <span className="ml-auto hidden text-[10px] text-slate-400 sm:block">Enter sends · Shift+Enter for a new line</span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * What patients have said, as a ticket desk.
 *
 * The people who have written down one side, their conversation down the other, because
 * the unit of the work is a patient with something outstanding rather than a card. The
 * cards this replaced repeated the same patient once per complaint — three headings called
 * Priya, three phone numbers, and nothing to say that they were one person or that two of
 * the three were already dealt with.
 *
 * Each of that patient's complaints keeps its own ticket, reference and status on the rail
 * above the thread. Merging them into one conversation would be the opposite mistake:
 * answering about the parking would close the complaint about the Physio.
 */
export const FeedbackBoard = ({ branchId, onClose, onCounts, headOffice = false, developerAccess = false }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all"); // "all" | one of COLUMNS
  const [sending, setSending] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  // On a phone the two panes cannot both be on screen, so the thread covers the list and
  // grows a back arrow. On anything wider they sit side by side and this is ignored.
  const [showThreadOnMobile, setShowThreadOnMobile] = useState(false);
  // Head office reads two different post-bags and they are not the same job. Only shown to
  // them: a branch has one, its own, and a tab strip over a single thing is furniture.
  const [audience, setAudience] = useState("all"); // "all" | "super_admin" | "branch_admin" | "physio"
  // Developer tools, for clearing demo and testing tickets. Nothing shows until the Danger
  // Zone password is in, and the server checks it again on every call -- this lock is manners.
  // Held in memory only, so a reload locks it again.
  const [devPassword, setDevPassword] = useState("");
  const [askingPassword, setAskingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [devBusy, setDevBusy] = useState("");
  // Chat Delete: the bin on each client row. Server-side, so switching it here turns it on
  // for every board, and the delete endpoint refuses while it is off.
  const [chatDelete, setChatDelete] = useState(false);
  const [chatDeleteSaving, setChatDeleteSaving] = useState(false);
  const [deletingClient, setDeletingClient] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBranchFeedback(branchId);
      setRows(data.feedback || []);
      setChatDelete(!!data.chat_delete_enabled);
      setError("");
      onCounts?.(data);
    } catch (e) {
      // Said rather than swallowed: an empty board and a board that failed to load look
      // identical, and only one of them means there is nothing to do.
      setError(e?.response?.data?.detail || "Could not load feedback.");
    } finally {
      setLoading(false);
    }
  }, [branchId, onCounts]);

  useEffect(() => { load(); }, [load]);

  // Only head office ever sees both kinds, so the strip only exists for them. A branch is
  // already held to its own by the server and would be choosing between one thing and it.
  // Told, not inferred. This used to read "has no branch pinned", which was a fair
  // proxy for head office while they were the only reader without one -- and stopped
  // being one the moment a consultant could open this board. A consultant has no branch
  // either, so they were about to be shown the audience strip and every branch's name.
  const isHeadOffice = headOffice && rows.some((r) => ["super_admin", "consultant", "physio"].includes(r.audience || "branch_admin"));
  const byAudience = useMemo(
    () => (audience === "all" ? rows
      : audience === "consultant" ? rows.filter((r) => ["consultant", "physio"].includes(r.audience || "branch_admin"))
      : rows.filter((r) => (r.audience || "branch_admin") === audience)),
    [rows, audience],
  );

  // Counted off the post-bag being read rather than off every row, or standing on the head
  // office tab would show tiles counting the branches' post and a list that does not.
  const counts = useMemo(() => {
    const out = { all: byAudience.length };
    for (const c of COLUMNS) out[c.key] = byAudience.filter((r) => (r.status || "new") === c.key).length;
    return out;
  }, [byAudience]);

  // The list: one entry per client, however much they have raised. Sorted by what is
  // waiting rather than by name — a patient who has answered and is sitting unanswered is
  // the reason this screen is open, and alphabetical order buries them halfway down.
  const clients = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const tickets = byAudience
      .filter((r) => (filter === "all" ? true : (r.status || "new") === filter))
      .filter((r) => {
        if (!needle) return true;
        const hay = [r.patient_name, r.patient_phone, r.branch_name, ticketRef(r.id), ...(r.messages || []).map((m) => m.body)]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(needle);
      });

    const map = new Map();
    for (const t of tickets) {
      const key = clientKey(t);
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: t.patient_name || "",
          phone: t.patient_phone || "",
          branch_id: t.branch_id || "",
          branch_name: t.branch_name || "",
          tone: toneFor(key),
          tickets: [],
        });
      }
      map.get(key).tickets.push(t);
    }
    const list = [...map.values()];
    for (const c of list) {
      c.tickets.sort((a, b) => String(ticketAt(b)).localeCompare(String(ticketAt(a))));
      c.awaiting = c.tickets.some((t) => t.awaiting_staff || (t.status || "new") === "new");
      c.open = c.tickets.filter((t) => (t.status || "new") !== "resolved").length;
      c.lastAt = ticketAt(c.tickets[0]);
    }
    return list.sort(
      (a, b) => Number(b.awaiting) - Number(a.awaiting) || String(b.lastAt).localeCompare(String(a.lastAt)),
    );
  }, [byAudience, filter, search]);

  // Branch by branch, for the tab that is about the branches rather than about head
  // office's own post. Sorted by what is waiting: a branch with unanswered feedback is the
  // one head office is looking for, and alphabetical order buries it.
  const listGroups = useMemo(() => {
    if (!(isHeadOffice && audience === "branch_admin")) return [{ key: "", name: "", clients }];
    const groups = new Map();
    for (const c of clients) {
      const key = c.branch_id || "";
      if (!groups.has(key)) groups.set(key, { key, name: c.branch_name || "Unknown branch", clients: [] });
      groups.get(key).clients.push(c);
    }
    return [...groups.values()].sort(
      (a, b) =>
        b.clients.filter((c) => c.awaiting).length - a.clients.filter((c) => c.awaiting).length ||
        a.name.localeCompare(b.name),
    );
  }, [clients, isHeadOffice, audience]);

  // Whoever is open, if they are still on the list — a filter or a search that drops them
  // has to drop the thread with them, or the pane goes on showing a client the list beside
  // it says is not there.
  const client = clients.find((c) => c.key === selectedClient) || null;
  const ticket = client ? (client.tickets.find((t) => t.id === selectedTicket) || client.tickets[0]) : null;

  // Opened for them: an inbox landing on an empty pane asks for a click to show what is
  // plainly the next thing to read. It only reaches the screen on a wide one — on a phone
  // showThreadOnMobile keeps the list up until somebody chooses.
  useEffect(() => {
    if (!clients.length) { setSelectedClient(null); return; }
    if (!clients.some((c) => c.key === selectedClient)) {
      setSelectedClient(clients[0].key);
      setSelectedTicket(null);
    }
  }, [clients, selectedClient]);

  const pickClient = (key) => {
    setSelectedClient(key);
    setSelectedTicket(null);
    setShowThreadOnMobile(true);
  };

  const move = async (row, to) => {
    setMoving(row.id);
    try {
      await moveBranchFeedback(row.id, to, "", "");
      // Held across the reload, because moving one changes its status and a filtered list
      // would otherwise reload with the ticket in hand gone from under the pane.
      setSelectedTicket(row.id);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not move that");
    } finally {
      setMoving(null);
    }
  };

  // Answering is the whole of the work, so it lives under the thread rather than behind a
  // dialog. Asking whether it is settled is the same call with a flag: closing one is a
  // question put to the patient, and their answer is what resolves it.
  const send = async (row, body, askResolved, done) => {
    setSending(row.id);
    try {
      await replyBranchFeedback(row.id, body, askResolved);
      done?.();
      setSelectedTicket(row.id);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send that");
    } finally {
      setSending(null);
    }
  };

  const lockDev = () => {
    setDevPassword("");
    setAskingPassword(false);
    setPasswordInput("");
    setPicked(new Set());
  };

  const unlockDev = async (e) => {
    e.preventDefault();
    setUnlocking(true);
    try {
      await unlockDangerZone(passwordInput);
      setDevPassword(passwordInput);
      getFeedbackChatDelete(passwordInput).then((r) => setChatDelete(!!r.enabled)).catch(() => {});
      setAskingPassword(false);
      setPasswordInput("");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not unlock");
    } finally {
      setUnlocking(false);
    }
  };

  const toggleChatDelete = async () => {
    const next = !chatDelete;
    setChatDeleteSaving(true);
    try {
      const r = await setFeedbackChatDelete(devPassword, next);
      setChatDelete(!!r.enabled);
      toast.success(`Chat Delete ${r.enabled ? "on" : "off"}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not change Chat Delete");
    } finally {
      setChatDeleteSaving(false);
    }
  };

  // Every ticket of this client's that the list is showing, in one go. The patient's portal
  // loses them too, so it is confirmed first.
  const deleteChat = async (c) => {
    const ids = c.tickets.map((t) => t.id);
    if (!ids.length) return;
    const who = c.name || "this patient";
    if (!window.confirm(`Delete ${who}'s chat?\n\n${ids.length} ticket(s) and every message on them will be removed from this board and from the patient's portal. This cannot be undone.`)) return;
    setDeletingClient(c.key);
    try {
      const res = await deleteFeedbackChat(ids);
      toast.success(`${who}'s chat deleted (${res.deleted} ticket(s))`);
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not delete that chat");
    } finally {
      setDeletingClient(null);
    }
  };

  const pick = (ids, on) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });
  };

  // Every ticket the list is showing right now, so "select all" means what is on screen and
  // never quietly includes tickets a filter or search has hidden.
  const shownIds = useMemo(() => clients.flatMap((c) => c.tickets.map((t) => t.id)), [clients]);
  // Only what still exists and is on screen is acted on: a ticket picked, then filtered out,
  // is not deleted by somebody who can no longer see it was ticked.
  const pickedShown = shownIds.filter((id) => picked.has(id));
  const allShownPicked = shownIds.length > 0 && pickedShown.length === shownIds.length;

  // Reset and Delete are two separate actions with two separate confirmations. Resetting a
  // ticket keeps its conversation and never deletes it; deleting never resets anything.
  const devResetToNew = async () => {
    const ids = pickedShown;
    if (!ids.length) return;
    if (!window.confirm(`Move ${ids.length} selected ticket(s) back to New?\n\nThe conversation is kept. Only the status changes.`)) return;
    setDevBusy("reset");
    try {
      const res = await devResetFeedbackToNew(ids, devPassword);
      toast.success(`${res.reset} ticket(s) moved back to New`);
      setPicked(new Set());
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not reset those");
    } finally {
      setDevBusy("");
    }
  };

  const devDelete = async () => {
    const ids = pickedShown;
    if (!ids.length) return;
    // Typed, not clicked: this runs on the live server too, and a stray OK on a dialog should
    // not be enough to remove what a real patient wrote.
    const typed = window.prompt(
      `Permanently delete ${ids.length} selected ticket(s)?\n\nThey will be removed from this board and from the patient's portal. This cannot be undone.\n\nType DELETE to confirm.`,
    );
    if ((typed || "").trim() !== "DELETE") {
      if (typed !== null) toast.error("Not deleted. Type DELETE to confirm.");
      return;
    }
    setDevBusy("delete");
    try {
      const res = await devDeleteFeedback(ids, devPassword);
      toast.success(`${res.deleted} ticket(s) deleted`);
      setPicked(new Set());
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not delete those");
    } finally {
      setDevBusy("");
    }
  };

  // What head office is looking at, and how many of each. Counted off every row rather
  // than off what is on screen, or the tab you are standing on would always read as all
  // of them.
  const AUDIENCE_TABS = [
    { key: "all", label: "Everything", icon: Bell, count: rows.length },
    { key: "super_admin", label: "Direct to head chief", icon: Bell, count: rows.filter((r) => (r.audience || "branch_admin") === "super_admin").length },
    // Head office reads these too, and is the only side that reads all three. A consultant
    // thread is not the branch's -- see BRANCH_HIDDEN_AUDIENCES -- so counting it under
    // Branch-wise, which is what "not head office's" used to do, filed it with the people
    // who cannot open it. The retired physio audience is folded in here rather than given a
    // fourth tab: it is the same thing under the name it was offered under for half a day.
    { key: "consultant", label: "Direct to a consultant", icon: Stethoscope, count: rows.filter((r) => ["consultant", "physio"].includes(r.audience || "branch_admin")).length },
    { key: "branch_admin", label: "Branch-wise", icon: Building2, count: rows.filter((r) => (r.audience || "branch_admin") === "branch_admin").length },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-50" data-testid="feedback-board">
      {/* A page of its own rather than a card laid over the board behind it. There can be
          dozens of these, each a complaint somebody wrote about their care, and working
          through them is the job for as long as it takes — not a glance at a dialog with
          the rest of the branch still showing round the edges.

          Edge to edge, because the thread pane is the screen: every pixel spent on a margin
          is a pixel the conversation does not get. */}
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="flex w-full items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
            aria-label="Back"
            data-testid="feedback-close"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <Bell className="h-5 w-5 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-800">Patient Feedback</h2>
            <p className="truncate text-xs text-slate-400">What patients have written about their care</p>
          </div>
          {developerAccess && !devPassword && !askingPassword && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-slate-400 hover:text-slate-600"
              onClick={() => setAskingPassword(true)}
              title="Developer tools: reset or delete demo tickets"
              data-testid="feedback-dev-access"
            >
              <KeyRound className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Developer Access</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0" data-testid="feedback-refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {developerAccess && !devPassword && askingPassword && (
          <form onSubmit={unlockDev} className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 sm:px-6" data-testid="feedback-dev-password">
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <Lock className="h-3.5 w-3.5" /> Developer password
            </span>
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="h-8 w-full max-w-xs rounded-md border border-slate-200 px-2 text-xs focus:border-sky-400 focus:outline-none"
              data-testid="feedback-dev-password-input"
            />
            <Button type="submit" size="sm" className="h-8" disabled={unlocking || !passwordInput} data-testid="feedback-dev-unlock">
              {unlocking ? "Checking…" : "Unlock"}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={lockDev}>Cancel</Button>
          </form>
        )}

        {developerAccess && devPassword && (
          <div className="flex flex-wrap items-center gap-2 border-t border-rose-200 bg-rose-50 px-4 py-2 sm:px-6" data-testid="feedback-dev-toolbar">
            <span className="text-xs font-semibold text-rose-800">Developer tools · demo &amp; testing only</span>
            <div className="flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-800" title="Show a delete button on each client in the list">
              Chat Delete
              <button
                type="button"
                role="switch"
                aria-checked={chatDelete}
                aria-label="Chat Delete"
                disabled={chatDeleteSaving}
                onClick={toggleChatDelete}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50 ${chatDelete ? "bg-rose-600" : "bg-slate-300"}`}
                data-testid="feedback-chat-delete-toggle"
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition ${chatDelete ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
              <span className={chatDelete ? "text-rose-700" : "text-slate-400"}>{chatDelete ? "On" : "Off"}</span>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-rose-700">
              <input
                type="checkbox"
                className="h-4 w-4 accent-rose-600"
                checked={allShownPicked}
                disabled={!shownIds.length}
                onChange={(e) => pick(shownIds, e.target.checked)}
                data-testid="feedback-dev-pick-all"
              />
              Select all shown ({shownIds.length})
            </label>
            <span className="text-xs text-rose-700" data-testid="feedback-dev-count">{pickedShown.length} selected</span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-amber-300 bg-white text-amber-700 hover:bg-amber-50"
              disabled={!pickedShown.length || !!devBusy}
              onClick={devResetToNew}
              data-testid="feedback-dev-reset-new"
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> {devBusy === "reset" ? "Resetting…" : "Reset to New"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-rose-300 bg-white text-rose-700 hover:bg-rose-100"
              disabled={!pickedShown.length || !!devBusy}
              onClick={devDelete}
              data-testid="feedback-dev-delete"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> {devBusy === "delete" ? "Deleting…" : "Delete"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-slate-500" onClick={lockDev} data-testid="feedback-dev-lock">
              <Lock className="mr-1 h-3.5 w-3.5" /> Lock
            </Button>
          </div>
        )}
      </header>

      {error ? (
        <div className="flex-1 space-y-2 py-12 text-center text-sm">
          <p className="font-medium text-rose-600" data-testid="feedback-error">{error}</p>
          <Button size="sm" variant="outline" onClick={load}>Try again</Button>
        </div>
      ) : loading ? (
        <p className="flex-1 py-12 text-center text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="flex-1 py-12 text-center text-sm text-slate-400" data-testid="feedback-empty">
          No feedback yet. It arrives here when a patient leaves some in their portal.
        </p>
      ) : (
        <>
          <div className="shrink-0 space-y-3 px-4 py-4 sm:px-6">
            {/* Two post-bags, and they are not the same job. What a patient sent past their
                branch is head office's own to answer — half of it is about the Branch Admin.
                What the branches received is head office watching over them, which reads
                branch by branch rather than as one pile. */}
            {isHeadOffice && (
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1" data-testid="feedback-audience-tabs">
                {AUDIENCE_TABS.map((t) => {
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => { setAudience(t.key); setFilter("all"); }}
                      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                        audience === t.key ? "bg-sky-100 text-sky-700" : "text-slate-500 hover:bg-slate-50"
                      }`}
                      data-testid={`feedback-audience-${t.key}`}
                    >
                      <Icon className="h-3.5 w-3.5" /> {t.label}
                      <span className="text-[10px] text-slate-400">({t.count})</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* The five counts across one row, the full width of the screen. Four to a row
                wrapped Resolved onto a line of its own, where a tile sitting alone above the
                feedback reads as a heading for it rather than as the last of the five. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5" data-testid="feedback-summary">
              <StatTile
                label="All"
                value={counts.all}
                sub="every piece of feedback"
                icon={Bell}
                color="#7c3aed"
                active={filter === "all"}
                onClick={() => setFilter("all")}
                testid="feedback-card-all"
              />
              {COLUMNS.map((col) => (
                <StatTile
                  key={col.key}
                  label={col.label}
                  value={counts[col.key]}
                  sub={col.sub}
                  icon={col.icon}
                  color={col.color}
                  active={filter === col.key}
                  onClick={() => setFilter(filter === col.key ? "all" : col.key)}
                  testid={`feedback-card-${col.key}`}
                />
              ))}
            </div>
          </div>

          {/* The desk itself: who is waiting on the left, what they said on the right. Both
              panes scroll inside themselves, so the list stays put while a long thread is
              read and the composer stays under the thumb rather than at the bottom of the
              page. */}
          <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 sm:px-6">
            <aside
              className={`min-h-0 w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:w-[21rem] md:shrink-0 ${
                showThreadOnMobile ? "hidden md:flex" : "flex"
              }`}
              data-testid="feedback-client-list"
            >
              <div className="shrink-0 border-b border-slate-100 p-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 focus-within:border-sky-400">
                  <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search a name, number or ticket…"
                    className="w-full bg-transparent text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none"
                    data-testid="feedback-search"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {clients.length === 0 ? (
                  <p className="px-4 py-10 text-center text-xs text-slate-400" data-testid="feedback-none-here">
                    {search.trim()
                      ? "Nobody matches that."
                      : (COLUMNS.find((c) => c.key === filter) || {}).empty || "Nothing here."}
                  </p>
                ) : (
                  listGroups.map((g) => (
                    <div key={g.key || "all"} data-testid={`feedback-branch-${g.key || "all"}`}>
                      {g.name ? (
                        <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-slate-100 bg-slate-50/95 px-3 py-1.5 backdrop-blur">
                          <Building2 className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-600">{g.name}</span>
                          <span className="text-[10px] text-slate-400">{g.clients.length}</span>
                        </div>
                      ) : null}
                      {g.clients.map((c) => (
                        <ClientRow
                          key={c.key}
                          client={c}
                          active={c.key === selectedClient}
                          onSelect={pickClient}
                          showBranch={isHeadOffice && audience !== "branch_admin"}
                          picking={!!devPassword}
                          pickedCount={c.tickets.filter((t) => picked.has(t.id)).length}
                          onPick={pick}
                          onDelete={chatDelete ? deleteChat : undefined}
                          deleting={deletingClient === c.key}
                        />
                      ))}
                    </div>
                  ))
                )}
              </div>
            </aside>

            <section
              className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${
                showThreadOnMobile ? "flex" : "hidden md:flex"
              }`}
              data-testid="feedback-thread-pane"
            >
              {ticket ? (
                <TicketPane
                  client={client}
                  ticket={ticket}
                  onPickTicket={setSelectedTicket}
                  onMove={move}
                  onSend={send}
                  moving={moving === ticket.id}
                  sending={sending === ticket.id}
                  onBack={() => setShowThreadOnMobile(false)}
                  showBranch={isHeadOffice}
                  picking={!!devPassword}
                  picked={picked}
                  onPick={pick}
                />
              ) : (
                <p className="m-auto px-6 text-center text-xs text-slate-400">
                  Pick somebody on the left to read what they wrote.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
};

export default FeedbackBoard;
