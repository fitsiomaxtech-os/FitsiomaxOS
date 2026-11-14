import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, XCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { clearNotifications, myNotifications, readAllNotifications } from "@/lib/api";
import { duration, prettyTime } from "@/lib/clock";
import { dateTimeStamp } from "@/lib/time";

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

/**
 * The header bell every signed-in person has: their own notifications, newest first.
 * Today that is a leave or permission being approved or rejected. Polled every minute;
 * a notice that arrives while the page is open also pops a toast. Opening the bell marks
 * everything read.
 */
export function NotificationBell({ className = "", iconClass = "h-4 w-4" }) {
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const seen = useRef(null);

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

  const onOpenChange = (next) => {
    setOpen(next);
    if (next && data.unread > 0) {
      readAllNotifications().catch(() => {});
      setData((d) => ({ ...d, unread: 0 }));
    }
    if (!next) setData((d) => ({ ...d, notifications: d.notifications.map((n) => ({ ...n, read: true })) }));
  };

  const clear = () => {
    clearNotifications().catch(() => {});
    setData({ notifications: [], unread: 0 });
  };

  const list = data.notifications || [];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`relative shrink-0 rounded-md p-2 transition ${data.unread ? "text-sky-600 hover:bg-sky-50" : "text-slate-400 hover:bg-slate-50"} ${className}`}
          title="Notifications"
          aria-label={data.unread ? `${data.unread} new notifications` : "Notifications"}
          data-testid="notification-bell"
        >
          <Bell className={iconClass} />
          {data.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white" data-testid="notification-bell-count">
              {data.unread > 99 ? "99+" : data.unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,360px)] rounded-[4px] p-0" data-testid="notification-popover">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold text-slate-900">Notifications</p>
          {list.length > 0 && (
            <button type="button" onClick={clear} className="text-xs font-medium text-slate-400 hover:text-rose-600" data-testid="notification-clear">
              Clear all
            </button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">No notifications</p>
          ) : list.map((n) => {
            const ok = n.status === "approved";
            const Icon = ok ? CheckCircle2 : XCircle;
            return (
              <div key={n.id} className={`flex gap-3 border-b border-slate-100 px-4 py-3 last:border-0 ${n.read ? "" : "bg-sky-50/60"}`} data-testid={`notification-${n.id}`}>
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${ok ? "text-emerald-600" : "text-rose-600"}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold ${ok ? "text-emerald-700" : "text-rose-700"}`}>{n.title}</p>
                  <p className="text-xs text-slate-600">{whenOf(n)}</p>
                  {n.note && <p className="mt-0.5 text-xs text-slate-500">{n.note}</p>}
                  <p className="mt-0.5 text-[11px] text-slate-400">{n.by ? `${n.by} · ` : ""}{dateTimeStamp(n.created_at)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
