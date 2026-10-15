import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { getBranchTabActivity } from "@/lib/api";

/**
 * The red dot on a Branch Admin tab: something in it is waiting for the admin.
 *
 * A tab is waiting when it has records nobody has acted on yet (a lead still on New Leads,
 * a referral not accepted...) or anything added in the last 24 hours -- the server sends
 * both, see backend/routers/v3_tab_activity.
 *
 * A dot that comes on stays for SHOW_MS and then goes out by itself, as opening the tab
 * would put it out. Either way it comes back REMIND_MS later while the work is still there:
 * it is a reminder, not a notification to clear. It also comes back on a refresh, and so on
 * the first visit each morning, because all of this is held in memory and nowhere else. A
 * record that lands after the dot went out lights it again at once.
 *
 * Keys are the board's own: a top tab's view key, and `<tab>.<sub-tab>` for a sub-tab. A top
 * tab is waiting when it or any of its sub-tabs is, and is put out on its own when opened --
 * its sub-tabs keep their dots until each is opened, so the reader still sees which one.
 */

const REFRESH_MS = 2 * 60 * 1000;
const SHOW_MS = 18 * 1000;
const REMIND_MS = 4 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

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

const sameKeys = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
const without = (map, keys) => {
  const next = { ...map };
  keys.forEach((k) => { delete next[k]; });
  return next;
};

/** The board's half: fetches what is waiting and runs each dot's on/off cycle. Pass the result to TabDotsProvider. */
export function useTabDotsState({ branchId, enabled = true }) {
  const [data, setData] = useState(null);
  // key -> when its dot went out (opened, or its SHOW_MS ran out). Memory only: a refresh
  // is meant to bring every dot back.
  const [hiddenAt, setHiddenAt] = useState({});
  // key -> when its dot came on. A key is lit exactly while it is in here.
  const [litAt, setLitAt] = useState({});
  // Bumped by the timer below, only to re-run the cycle at the moment something is due.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setData(null);
    setHiddenAt({});
    setLitAt({});
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

  // Every key the server answered, and the top tab each sub-tab belongs to.
  const keys = useMemo(() => (data
    ? [...new Set([...Object.keys(data.latest), ...Object.keys(data.pending)].flatMap((k) => [k, k.split(".")[0]]))]
    : []), [data]);

  // Whether a key's dot is due at `at`: something is waiting, and it has not gone out in
  // the last REMIND_MS (or something newer has landed since it did).
  const due = useCallback((key, at) => {
    const newest = newestFor(data.latest, key);
    const untouched = family(data.pending, key).some((k) => data.pending[k] > 0);
    if (!untouched && !(newest && at - newest < RECENT_MS)) return false;
    const out = hiddenAt[key];
    return !out || at - out >= REMIND_MS || newest > out;
  }, [data, hiddenAt]);

  // One pass of the cycle: put out what has shown for SHOW_MS, light what is due, then
  // sleep until the next of those is due. A timer to the moment, not a ticking clock --
  // every re-render here re-renders the whole board.
  useEffect(() => {
    if (!data) return undefined;
    const t = Date.now();
    const expired = keys.filter((k) => litAt[k] && t - litAt[k] >= SHOW_MS);
    if (expired.length) {
      setHiddenAt((prev) => ({ ...prev, ...Object.fromEntries(expired.map((k) => [k, Math.max(t, newestFor(data.latest, k))])) }));
      setLitAt((prev) => without(prev, expired));
      return undefined;
    }
    const lit = {};
    keys.forEach((k) => { if (due(k, t)) lit[k] = litAt[k] || t; });
    if (!sameKeys(lit, litAt)) {
      setLitAt(lit);
      return undefined;
    }
    const next = Math.min(...keys.map((k) => (litAt[k] ? litAt[k] + SHOW_MS : hiddenAt[k] ? hiddenAt[k] + REMIND_MS : Infinity)));
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(next - t, 0) + 50);
    return () => clearTimeout(timer);
  }, [data, keys, litAt, hiddenAt, due, tick]);

  const has = useCallback((key) => !!key && !!litAt[key], [litAt]);

  const markSeen = useCallback((key) => {
    // The later of the newest record and now: a server clock ahead of this one would
    // otherwise relight the tab the reader is looking at.
    const at = Math.max(Date.now(), data ? newestFor(data.latest, key) : 0);
    setHiddenAt((prev) => ({ ...prev, [key]: at }));
    setLitAt((prev) => without(prev, [key]));
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
    className={`pointer-events-none absolute h-[6.5px] w-[6.5px] rounded-full bg-red-500 ring-1 ring-white ${className}`}
    data-testid={testid}
  >
    <span className="sr-only">New</span>
  </span>
) : null);

/** A TabDot that reads its own key off the provider -- for a sub-tab strip drawn in a map. */
export const TabDotFor = ({ dotKey, ...props }) => <TabDot show={useTabDot(dotKey)} {...props} />;
