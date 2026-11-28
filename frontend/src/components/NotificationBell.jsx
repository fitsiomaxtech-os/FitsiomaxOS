import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, IndianRupee, MessageCircle, Trash2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { SessionPaymentList, useSessionPaymentAlerts } from "@/components/SessionPaymentBell";
import { clearNotifications, deleteNotification, myNotifications, readAllNotifications } from "@/lib/api";
import { duration, prettyTime } from "@/lib/clock";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { dateTimeStamp } from "@/lib/time";

const FeedbackBoard = lazyWithRetry(() => import("@/components/branch/FeedbackBoard").then((m) => ({ default: m.FeedbackBoard })));

const REFRESH_MS = 60 * 1000;

const prettyDate = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "");

const minutesBetween = (a, b) => {
  const m = (s) => { const [h, mm] = String(s || "").split(":").map(Number); return h * 60 + mm; };
  return m(b) - m(a);
};

const whenOf = (n) => {
  if (n.kind === "permission") {
    return `${prettyDate(n.from_date)} · ${prettyTime(n.from_time)} - ${prettyTime(n.to_time)} (${duration(minutesBetween(n.from_time, n.to_time))})`;
  }
  if (!n.from_date) return "";
  return n.from_date === n.to_date
    ? prettyDate(n.from_date)
    : `${prettyDate(n.from_date)} - ${prettyDate(n.to_date)} (${n.days} days)`;
};

const badge = (n) => (n > 99 ? "99+" : n);

/**
 * The header bell every signed-in person has. It opens one 980 x 750 popup with the tabs
 * down the left, the way My Profile lays out its sections:
 *
 *   Notifications         -- the person's own: a leave or permission approved or rejected.
 *   Client Feedback       -- the feedback desk, for the roles that read it (`feedback` set).
 *   Session payments due  -- clients past their paid sessions owing a balance, for Super
 *                            Admin, Branch Admin and BDE (`sessionPayments` set).
 *
 * A tab only appears for the roles it is for. The badge adds the three counts up. Notices
 * are polled every minute and a new one pops a toast; viewing the Notifications tab marks
 * them read.
 */
export function NotificationBell({
  className = "",
  iconClass = "h-4 w-4",
  feedback = null, // { branchId, headOffice, developerAccess }
  feedbackUnread = 0,
  onFeedbackCounts = null,
  sessionPayments = null, // { canDecide }
}) {
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("notifications");
  const seen = useRef(null);
  const pay = useSessionPaymentAlerts(!!sessionPayments);

  // FeedbackBoard reloads whenever its onCounts changes, so it gets one that never does.
  const countsRef = useRef(onFeedbackCounts);
  countsRef.current = onFeedbackCounts;
  const onCounts = useCallback((d) => countsRef.current?.(d), []);

  const load = useCallback(() => {
    myNotifications()
      .then((res) => {
        const next = res || { notifications: [], unread: 0 };
        const ids = new Set((next.notifications || []).map((n) => n.id));
        // First load just records what is there; after that anything new and unread pops.
        if (seen.current) {
          (next.notifications || [])
            .filter((n) => !n.read && !seen.current.has(n.id))
            .forEach((n) => {
              // Keyed by the notice: a phone header and the desktop row can both be
              // mounted (one hidden by CSS), and the id stops them toasting twice.
              const opts = { id: `notif-${n.id}`, duration: 8000, description: whenOf(n) };
              if (n.status === "approved") toast.success(n.title, opts);
              else toast.error(n.title, opts);
            });
        }
        seen.current = ids;
        setData(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const feedbackCount = feedback ? feedbackUnread : 0;
  const payCount = sessionPayments ? pay.count : 0;
  const total = data.unread + feedbackCount + payCount;

  const tabs = [
    { key: "notifications", label: "Notifications", icon: Bell, count: data.unread, tone: "bg-sky-500" },
    feedback && { key: "feedback", label: "Client Feedback", icon: MessageCircle, count: feedbackCount, tone: "bg-rose-500" },
    sessionPayments && { key: "payments", label: "Session payments due", icon: IndianRupee, count: payCount, tone: pay.urgent ? "bg-rose-500" : "bg-amber-500" },
  ].filter(Boolean);

  // Read once it has been on screen, not merely because the bell was opened on another tab.
  useEffect(() => {
    if (!open || tab !== "notifications" || data.unread <= 0) return;
    readAllNotifications().catch(() => {});
    setData((d) => ({ ...d, unread: 0 }));
  }, [open, tab, data.unread]);

  // The list is fetched afresh when its tab opens, as the ₹ bell's popover used to be.
  const reloadPay = pay.load;
  useEffect(() => {
    if (open && tab === "payments") reloadPay();
  }, [open, tab, reloadPay]);

  // The "new" highlight stays while the list is being read and goes once it is left.
  const markSeen = () => setData((d) => ({ ...d, notifications: (d.notifications || []).map((n) => ({ ...n, read: true })) }));

  const pickTab = (key) => {
    if (tab === "notifications" && key !== tab) markSeen();
    setTab(key);
  };

  // Opens on whatever is waiting, in the order the tabs are listed.
  const onOpenChange = (next) => {
    if (next) setTab((tabs.find((t) => t.count > 0) || tabs[0]).key);
    else markSeen();
    setOpen(next);
  };

  const clear = () => {
    clearNotifications().catch(() => {});
    setData({ notifications: [], unread: 0 });
  };

  // Notices stay until their owner deletes them, one at a time or with Clear all.
  const remove = (n) => {
    deleteNotification(n.id).catch(() => {});
    setData((d) => ({
      notifications: (d.notifications || []).filter((x) => x.id !== n.id),
      unread: Math.max(0, d.unread - (n.read ? 0 : 1)),
    }));
  };

  const list = data.notifications || [];
  const active = tabs.some((t) => t.key === tab) ? tab : "notifications";

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={`relative shrink-0 rounded-md p-2 transition ${total ? "text-sky-600 hover:bg-sky-50" : "text-slate-400 hover:bg-slate-50"} ${className}`}
        title="Notifications"
        aria-label={total ? `${total} new notifications` : "Notifications"}
        data-testid="notification-bell"
      >
        <Bell className={iconClass} />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white" data-testid="notification-bell-count">
            {badge(total)}
          </span>
        )}
      </button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[100dvh] w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[750px] sm:max-h-[calc(100vh-2rem)] sm:w-[980px] sm:max-w-[calc(100vw-2rem)] sm:rounded-[4px]"
          data-testid="notification-popover"
        >
          <header className="flex shrink-0 items-center border-b border-slate-200 py-3 pl-5 pr-12">
            <DialogTitle className="text-base font-semibold text-slate-900">Notifications</DialogTitle>
          </header>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav aria-label="Notification tabs" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/60 p-2 text-xs sm:w-56 sm:flex-col sm:border-b-0 sm:border-r" data-testid="notification-tabs">
              {tabs.map((t) => {
                const on = active === t.key;
                const Icon = t.icon;
                return (
                  <button
                    type="button"
                    key={t.key}
                    onClick={() => pickTab(t.key)}
                    aria-current={on ? "page" : undefined}
                    className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left focus-visible:outline-sky-600 ${on ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`}
                    data-testid={`notification-tab-${t.key}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t.label}</span>
                    {t.count > 0 && (
                      <span className={`flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${t.tone}`} data-testid={`notification-tab-${t.key}-count`}>
                        {badge(t.count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="min-h-0 min-w-0 flex-1" data-testid={`notification-pane-${active}`}>
              {active === "notifications" && (
                <div className="flex h-full flex-col">
                  {list.length > 0 && (
                    <div className="flex shrink-0 justify-end border-b border-slate-100 px-5 py-2">
                      <button type="button" onClick={clear} className="text-xs font-medium text-slate-400 hover:text-rose-600" data-testid="notification-clear">
                        Clear all
                      </button>
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {list.length === 0 ? (
                      <p className="px-5 py-16 text-center text-sm text-slate-400" data-testid="notification-empty">No notifications</p>
                    ) : list.map((n) => {
                      const ok = n.status === "approved";
                      const Icon = ok ? CheckCircle2 : XCircle;
                      return (
                        <div key={n.id} className={`flex gap-3 border-b border-slate-100 px-5 py-3 ${n.read ? "" : "bg-sky-50/60"}`} data-testid={`notification-${n.id}`}>
                          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${ok ? "text-emerald-600" : "text-rose-600"}`} />
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-semibold ${ok ? "text-emerald-700" : "text-rose-700"}`}>{n.title}</p>
                            <p className="text-xs text-slate-600">{whenOf(n)}</p>
                            {n.note && <p className="mt-0.5 text-xs text-slate-500">{n.note}</p>}
                            <p className="mt-0.5 text-[11px] text-slate-400">{n.by ? `${n.by} · ` : ""}{dateTimeStamp(n.created_at)}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => remove(n)}
                            className="h-7 w-7 shrink-0 self-start rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            title="Delete notification"
                            aria-label="Delete notification"
                            data-testid={`notification-delete-${n.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {active === "feedback" && feedback && (
                <Suspense fallback={<p className="py-16 text-center text-sm text-slate-400">Loading…</p>}>
                  <FeedbackBoard
                    embedded
                    branchId={feedback.branchId}
                    headOffice={!!feedback.headOffice}
                    developerAccess={!!feedback.developerAccess}
                    onClose={() => onOpenChange(false)}
                    onCounts={onCounts}
                  />
                </Suspense>
              )}

              {active === "payments" && sessionPayments && (
                <div className="h-full overflow-y-auto px-5 py-4">
                  <SessionPaymentList
                    data={pay.data}
                    status={pay.status}
                    onReload={pay.load}
                    onRetry={pay.retry}
                    canDecide={!!sessionPayments.canDecide}
                  />
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
