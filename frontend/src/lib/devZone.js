import { useSyncExternalStore } from "react";

// ------------------------------------------------- Danger Zone (Developer Access) state
//
// The developer password and whether the full-screen Danger Zone view is open, shared
// between the screens that touch it without a context provider: Workflow Roots unlocks it,
// the header's red gear reopens it, and the DeveloperZone view reads and locks it.
//
// The password lives here, in memory, exactly as it used to live in Pipeline Stage
// Management's own state — never in storage, so leaving or refreshing the page locks the
// zone again, and the server checks it on every call regardless.
let state = { password: null, open: false };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

/** A fresh unlock: keeps the password and opens the view at once. */
export const unlockDevZone = (password) => {
  state = { password, open: true };
  emit();
};

/** The header gear: reopen the view with the password already held. */
export const openDevZone = () => {
  if (!state.password || state.open) return;
  state = { ...state, open: true };
  emit();
};

/** The view's Exit: close it but stay unlocked, so the gear stays in the header. */
export const closeDevZone = () => {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
};

/** Lock: forget the password entirely — the gear goes, and the next entry is the
 *  Developer Access password box again. Also what a refused password (changed on the
 *  server, or too many tries) falls back to. */
export const lockDevZone = () => {
  state = { password: null, open: false };
  emit();
};

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** { password, open }, re-rendering the caller when either changes. */
export const useDevZone = () => useSyncExternalStore(subscribe, () => state);
