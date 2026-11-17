/**
 * What drives the bottom-edge loading bar on every page.
 *
 * It used to belong to Branch Admin alone, switched on by that board's own `loading`
 * flag. Now it counts whatever the page is waiting for: every data read (GET) through the
 * API clients, and every board's code chunk still on the wire (lazyWithRetry). While the
 * count is above zero, <LoadingBar /> in App.js shows the bar.
 *
 * Header polls -- the bell, the clock, the tab dots, the Finance badges -- pass QUIET. They
 * refresh every minute or so whatever page is open, and a bar that flashed with each one
 * would say "loading" when nothing the person asked for is.
 *
 * Saves (POST / PUT / PATCH / DELETE) are not counted: the button pressed already shows
 * its own spinner, and the bar is for the page filling in.
 */
let pending = 0;
const listeners = new Set();

const emit = () => {
  const busy = pending > 0;
  listeners.forEach((fn) => fn(busy));
};

export const beginLoading = () => {
  pending += 1;
  if (pending === 1) emit();
};

export const endLoading = () => {
  if (pending === 0) return;
  pending -= 1;
  if (pending === 0) emit();
};

/** Calls `fn(busy)` now and on every change; returns the unsubscribe. */
export const subscribeLoading = (fn) => {
  listeners.add(fn);
  fn(pending > 0);
  return () => listeners.delete(fn);
};

/** Request config for a background read the bar should not report. */
export const QUIET = { quiet: true };

/**
 * Counts an axios instance's GETs. Call it before the instance's other request
 * interceptors are added: axios runs request interceptors last-added-first, so this one
 * then runs last, right before the request goes out.
 */
export const trackLoading = (instance) => {
  instance.interceptors.request.use((config) => {
    if ((config.method || "get").toLowerCase() === "get" && !config.quiet) {
      config.countsAsLoading = true;
      beginLoading();
    }
    return config;
  });
  const done = (config) => {
    if (!config?.countsAsLoading) return;
    config.countsAsLoading = false;
    endLoading();
  };
  instance.interceptors.response.use(
    (resp) => { done(resp?.config); return resp; },
    (error) => { done(error?.config); return Promise.reject(error); },
  );
};
