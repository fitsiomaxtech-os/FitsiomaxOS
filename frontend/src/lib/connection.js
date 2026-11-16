// Can this browser reach Fitsiomax OS right now?
//
// navigator.onLine alone is not enough: it is false when Wi-Fi is switched off, but stays
// true on a Wi-Fi that has no internet behind it. So "online" is checked by asking our own
// server for a tiny file. Any answer at all, even an error status, means the line works.
//
// Many requests can fail at once when the line drops (a board loads ten things), so every
// caller shares one check in flight rather than firing ten.

/** Fired by anything that just saw a request fail with no answer. OfflineScreen listens. */
export const MAYBE_OFFLINE_EVENT = "fitsiomax:maybe-offline";

const PROBE_TIMEOUT_MS = 6000;
let inflight = null;

const runProbe = async () => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null;
  try {
    await fetch(`/favicon.ico?_=${Date.now()}`, { method: "HEAD", cache: "no-store", signal: ctrl?.signal });
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const probeConnection = () => {
  if (!inflight) inflight = runProbe().finally(() => { inflight = null; });
  return inflight;
};

/** Resolves once the server answers again; checks every few seconds and on "online". */
export const waitForConnection = (intervalMs = 4000) =>
  new Promise((resolve) => {
    let busy = false;
    let timer = null;
    const check = async () => {
      if (busy) return;
      busy = true;
      const ok = await probeConnection();
      busy = false;
      if (!ok) return;
      clearInterval(timer);
      window.removeEventListener("online", check);
      resolve();
    };
    timer = setInterval(check, intervalMs);
    window.addEventListener("online", check);
  });

export const reportMaybeOffline = () => {
  try { window.dispatchEvent(new Event(MAYBE_OFFLINE_EVENT)); } catch { /* noop */ }
};
