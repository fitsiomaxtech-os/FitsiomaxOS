import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { getBranchTabActivity } from "@/lib/api";

/**
 * The red dot on a Branch Admin tab: something in it is waiting for the admin.
 *
 * A tab is waiting when it has records nobody has acted on yet (a lead still on New Leads,
 * a referral not accepted...) or anything added in the last 24 hours -- the server sends
 * both, see backend/routers/v3_tab_activity.
 *
 * Opening the tab puts its dot out, but only for REMIND_MS: it is a reminder, not a
 * notification to clear, so it comes back after that while the work is still there. And
 * it comes back on a refresh, and so on the first visit each morning, because what has
 * been opened is held in memory and nowhere else. A record that lands after the tab was
 * opened lights it again at once.
 *
 * Keys are the board's own: a top tab's view key, and `<tab>.<sub-tab>` for a sub-tab. A top
 * tab is waiting when it or any of its sub-tabs is, and is put out on its own when opened --
 * its sub-tabs keep their dots until each is opened, so the reader still sees which one.
 */

const REFRESH_MS = 2 * 60 * 1000;
const REMIND_MS = 4 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
// How often the dots are re-read against the clock, so one put out comes back on time.
const TICK_MS = 15 * 1000;

const TabDotsContext = createContext(null);
export const TabDotsProvider = TabDotsContext.Provider;

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? 0 : t;
};

// A key and its sub-tabs.
const family = (map, key) => Object.keys(map).filter((k) => k === key || k.startsWith(`${key}.`));

function newestFor(latest, key) {
  return family(latest, key).reduce((best, k) => Math.max(best, ms(latest[k])), 0);
}

/** The board's half: fetches what is waiting and holds what has been opened. Pass the result to TabDotsProvider. */
export function useTabDotsState({ branchId, enabled = true }) {
  const [data, setData] = useState(null);
  // key -> when it was opened. Memory only: a refresh is meant to bring every dot back.
  const [opened, setOpened] = useState({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setData(null);
    setOpened({});
  }, [branchId]);

  useEffect(() => {
    if (!enabled || !branchId) return undefined;
    let alive = true;
    const load = () => getBranchTabActivity(branchId)
      .then((res) => { if (alive) setData({ latest: res?.latest || {}, pending: res?.pending || {} }); })
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

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  const has = useCallback((key) => {
    if (!data || !key) return false;
    const newest = newestFor(data.latest, key);
    const untouched = family(data.pending, key).some((k) => data.pending[k] > 0);
    if (!untouched && !(newest && now - newest < RECENT_MS)) return false;
    const at = opened[key];
    if (!at) return true;
    return now - at >= REMIND_MS || newest > at;
  }, [data, opened, now]);

  const markSeen = useCallback((key) => {
    // The later of the newest record and now: a server clock ahead of this one would
    // otherwise relight the tab the reader is looking at.
    const at = Math.max(Date.now(), data ? newestFor(data.latest, key) : 0);
    setNow(Date.now());
    setOpened((prev) => ({ ...prev, [key]: at }));
  }, [data]);

  return useMemo(() => ({ has, markSeen }), [has, markSeen]);
}

/** Whether `key` has a dot. False outside a TabDotsProvider, so a panel reused elsewhere shows none. */
export function useTabDot(key) {
  const ctx = useContext(TabDotsContext);
  return !!ctx && !!key && ctx.has(key);
}

/** Puts out `key`'s dot while it is open -- so the tab being read never shows one. */
export function useMarkTabSeen(key, open = true) {
  const ctx = useContext(TabDotsContext);
  const lit = !!ctx && !!key && ctx.has(key);
  // Layout effect so a dot relit on the open tab is put out before it paints.
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
