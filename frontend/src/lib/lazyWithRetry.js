import { lazy } from "react";

// React.lazy() with a safety net for ChunkLoadError.
//
// The site is served by the webpack dev server, which recompiles on every deploy and
// renames chunks as it does. A tab opened before a deploy (or a flaky connection, or a
// request that lands mid-recompile) asks for a chunk that is momentarily missing, and
// plain lazy() turns that into a full-screen "Uncaught runtime errors" crash.
//
// Here a failed import is retried a couple of times (webpack forgets a failed chunk, so a
// second import() really re-downloads it). If it still fails, the page reloads once to
// pick up the current chunk names. The sessionStorage flag stops a reload loop: if the
// chunk is still missing after a fresh load, the error is thrown as before.
const RELOAD_FLAG = "fx-chunk-reload";
const RETRIES = 2;
const RETRY_DELAY_MS = 800;

const isChunkError = (err) =>
  !!err && (err.name === "ChunkLoadError" || /Loading (CSS )?chunk [\w-]+ failed/i.test(String(err.message || "")));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readFlag = () => {
  try { return window.sessionStorage.getItem(RELOAD_FLAG) === "1"; } catch { return false; }
};
const writeFlag = (on) => {
  try {
    if (on) window.sessionStorage.setItem(RELOAD_FLAG, "1");
    else window.sessionStorage.removeItem(RELOAD_FLAG);
  } catch { /* storage blocked: no loop guard, but no crash either */ }
};

export async function importWithRetry(factory) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const mod = await factory();
      writeFlag(false);
      return mod;
    } catch (err) {
      lastErr = err;
      if (!isChunkError(err)) throw err;
      if (attempt < RETRIES) await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  if (!readFlag()) {
    writeFlag(true);
    window.location.reload();
    // Keep Suspense showing its fallback until the reload takes over.
    return new Promise(() => {});
  }
  throw lastErr;
}

export function lazyWithRetry(factory) {
  return lazy(() => importWithRetry(factory));
}
