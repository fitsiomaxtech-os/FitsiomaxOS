import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getBranchTabActivity } from "@/lib/api";

/**
 * The red dot on a Branch Admin tab: something in it is waiting for the admin.
 *
 * A tab is waiting when it has records nobody has acted on yet (a lead still on New Leads,
 * a referral not accepted...) or anything added in the last 24 hours -- the server sends
 * both, see backend/routers/v3_tab_activity.
 *
 * A dot stays until its own tab is clicked. From the click it lasts SHOW_MS more, then goes
 * out -- on that tab only; every other tab keeps its dot. REMIND_MS later it comes back,
 * again until clicked, while the work is still there: a reminder, not a notification to
 * clear. A refresh brings every dot back, and so does the first visit each morning,
 * because all of this is held in memory and nowhere else. A record that lands after a dot
 * went out lights it again at once.
 *
 * Keys are the board's own: a top tab's view key, and `<tab>.<sub-tab>` for a sub-tab. A top
 * tab is waiting when it or any of its sub-tabs is.
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

const without = (map, keys) => {
  const next = { ...map };
  keys.forEach((k) => { delete next[k]; });
  return next;
};

/** The board's half: fetches what is waiting and runs each dot's click/hide cycle. Pass the result to TabDotsProvider. */
export function useTabDotsState({ branchId, enabled = true }) {
  const [data, setData] = useState(null);
  // key -> when its tab was clicked while the dot was on; the dot goes out SHOW_MS later.
  const [clickedAt, setClickedAt] = useState({});
  // key -> when its dot went out. Memory only: a refresh is meant to bring every dot back.
  const [hiddenAt, setHiddenAt] = useState({});
  // The clock the dots are read against, moved on by the timer below only when something
  // is due -- every re-render here re-renders the whole board.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setData(null);
    setClickedAt({});
    setHiddenAt({});
  }, [branchId]);

  useEffect(() => {
    if (!enabled || !branchId) return undefined;
    let alive = true;
    const load = () => getBranchTabActivity(branchId)
      .then((res) => {
        if (!alive) return;
        setData({ latest: res?.latest || {}, pending: res?.pending || {} });
        setNow(Date.now());
      })
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

  // Something is waiting, and the dot has not gone out in the last REMIND_MS (or something
  // newer has landed since it did).
  const has = useCallback((key) => {
    if (!data || !key) return false;
    const newest = newestFor(data.latest, key);
    const untouched = family(data.pending, key).some((k) => data.pending[k] > 0);
    if (!untouched && !(newest && now - newest < RECENT_MS)) return false;
    const out = hiddenAt[key];
    return !out || now - out >= REMIND_MS || newest > out;
  }, [data, hiddenAt, now]);

  // Put out the dots whose SHOW_MS since the click has run, then sleep until the next
  // click runs out or the next hidden dot is due back.
  useEffect(() => {
    if (!data) return undefined;
    const t = Date.now();
    const expired = Object.keys(clickedAt).filter((k) => t - clickedAt[k] >= SHOW_MS);
    if (expired.length) {
      // The later of now and the newest record: a server clock ahead of this one would
      // otherwise relight the dot straight away.
      setHiddenAt((prev) => ({ ...prev, ...Object.fromEntries(expired.map((k) => [k, Math.max(t, newestFor(data.latest, k))])) }));
      setClickedAt((prev) => without(prev, expired));
      setNow(t);
      return undefined;
    }
    const next = Math.min(
      ...Object.values(clickedAt).map((c) => c + SHOW_MS),
      ...Object.values(hiddenAt).map((h) => h + REMIND_MS).filter((due) => due > t),
    );
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(next - t, 0) + 50);
    return () => clearTimeout(timer);
  }, [data, clickedAt, hiddenAt, now]);

  // A click on a lit tab starts its SHOW_MS; a second click inside that does not restart it.
  const click = useCallback((key) => {
    if (!has(key)) return;
    setClickedAt((prev) => (prev[key] ? prev : { ...prev, [key]: Date.now() }));
  }, [has]);

  return useMemo(() => ({ has, click }), [has, click]);
}

/** Whether `key` has a dot. False outside a TabDotsProvider, so a panel reused elsewhere shows none. */
export function useTabDot(key) {
  const ctx = useContext(TabDotsContext);
  return !!ctx && !!key && ctx.has(key);
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

/** What a tab's onClick calls to start its dot's last SHOW_MS. A no-op outside a TabDotsProvider. */
export function useTabDotClick() {
  const ctx = useContext(TabDotsContext);
  return useCallback((key) => { if (ctx) ctx.click(key); }, [ctx]);
}

/** A TabDot that reads its own key off the provider -- for a sub-tab strip drawn in a map. */
export const TabDotFor = ({ dotKey, ...props }) => <TabDot show={useTabDot(dotKey)} {...props} />;
