import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { getBranchTabActivity } from "@/lib/api";

/**
 * The red dot on a Branch Admin tab: something was added to it since this person last
 * opened it. Opening the tab puts it out until the next new record.
 *
 * The server says when each tab last had something new (backend/routers/v3_tab_activity);
 * this browser keeps when each tab was last opened, per login and branch. Kept here rather
 * than on the server because it is a reading aid, not a record -- a second device lighting
 * a tab the first one already opened costs a click, and saves a write on every tab change.
 *
 * Keys are the board's own: a top tab's view key, and `<tab>.<sub-tab>` for a sub-tab. A top
 * tab answers with the newest of itself and its sub-tabs, and is put out on its own when
 * opened -- its sub-tabs keep their dots until each is opened, so the reader still sees
 * which one inside has the news.
 */

const REFRESH_MS = 2 * 60 * 1000;

const TabDotsContext = createContext(null);
export const TabDotsProvider = TabDotsContext.Provider;

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? 0 : t;
};

function stampFor(latest, key) {
  let best = latest[key] || "";
  const prefix = `${key}.`;
  for (const [k, v] of Object.entries(latest)) {
    if (k.startsWith(prefix) && ms(v) > ms(best)) best = v;
  }
  return best;
}

// Private windows and blocked storage throw; the dots then simply last the session.
function readSeen(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeSeen(storageKey, seen) {
  try { localStorage.setItem(storageKey, JSON.stringify(seen)); } catch { /* ignore */ }
}

/** The board's half: fetches the stamps and holds what has been seen. Pass the result to TabDotsProvider. */
export function useTabDotsState({ branchId, userId, enabled = true }) {
  const storageKey = `tab-dots:${userId || "anon"}:${branchId || ""}`;
  const [latest, setLatest] = useState(null);
  const [seen, setSeen] = useState(() => readSeen(storageKey));

  useEffect(() => {
    setSeen(readSeen(storageKey));
    setLatest(null);
  }, [storageKey]);

  useEffect(() => {
    if (!enabled || !branchId) return undefined;
    let alive = true;
    const load = () => getBranchTabActivity(branchId)
      .then((res) => { if (alive) setLatest(res?.latest || {}); })
      .catch(() => { /* a missed poll leaves the dots as they were */ });
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, branchId]);

  // First load in this browser: what is already there counts as seen, or every tab would
  // open lit on the day this ships and the dots would say nothing.
  useEffect(() => {
    if (seen !== null || latest === null) return;
    const keys = new Set(Object.keys(latest).flatMap((k) => [k, k.split(".")[0]]));
    const initial = {};
    keys.forEach((k) => { initial[k] = stampFor(latest, k); });
    setSeen(initial);
    writeSeen(storageKey, initial);
  }, [latest, seen, storageKey]);

  const has = useCallback((key) => {
    if (!latest || !seen) return false;
    const stamp = stampFor(latest, key);
    return !!stamp && ms(stamp) > ms(seen[key]);
  }, [latest, seen]);

  const markSeen = useCallback((key) => {
    if (!latest) return;
    // The later of the newest record and now: a server clock ahead of this one would
    // otherwise relight the tab the reader is looking at.
    const stamp = stampFor(latest, key);
    const at = ms(stamp) > Date.now() ? stamp : new Date().toISOString();
    setSeen((prev) => {
      if (!prev || ms(prev[key]) >= ms(at)) return prev;
      const next = { ...prev, [key]: at };
      writeSeen(storageKey, next);
      return next;
    });
  }, [latest, storageKey]);

  return useMemo(() => ({ has, markSeen }), [has, markSeen]);
}

/** Whether `key` has a dot. False outside a TabDotsProvider, so a panel reused elsewhere shows none. */
export function useTabDot(key) {
  const ctx = useContext(TabDotsContext);
  return !!ctx && !!key && ctx.has(key);
}

/** Puts out `key`'s dot while it is open -- including for a record that lands while the reader is on it. */
export function useMarkTabSeen(key, open = true) {
  const ctx = useContext(TabDotsContext);
  const lit = !!ctx && !!key && ctx.has(key);
  // Layout effect so a dot lit by a poll on the open tab is put out before it paints.
  useLayoutEffect(() => {
    if (open && lit) ctx.markSeen(key);
  }, [ctx, key, open, lit]);
}

/** The dot itself. The parent must be `relative`; `className` places it. */
export const TabDot = ({ show, className = "-right-1 -top-1", testid }) => (show ? (
  <span
    className={`pointer-events-none absolute h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white ${className}`}
    data-testid={testid}
  >
    <span className="sr-only">New</span>
  </span>
) : null);

/** A TabDot that reads its own key off the provider -- for a sub-tab strip drawn in a map. */
export const TabDotFor = ({ dotKey, ...props }) => <TabDot show={useTabDot(dotKey)} {...props} />;
