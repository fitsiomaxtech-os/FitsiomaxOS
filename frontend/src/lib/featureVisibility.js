import { useSyncExternalStore } from "react";
import { getFeatureVisibility } from "@/lib/api";

// ------------------------------------------------- Hide Features
//
// The features a developer has hidden in the Danger Zone's Hide Features tab. A hidden
// feature's screens and controls come off for everybody; what it already wrote stays.
// Read once per page load, on the first screen that asks, and refreshed by the Hide
// Features switches themselves when they change it — the same shape as the hidden
// Payment Modes store in paymentModes.js.
//
// The keys are the backend's FEATURE_KEYS (feature_visibility.py):
//   treatments — the Treatments catalogue tab in Services and Products, and the
//                Consultant's Treatment Summary tick-list with it.
let hiddenFeatures = [];
let loaded = false;
const listeners = new Set();

export const setHiddenFeatures = (list) => {
  hiddenFeatures = Array.isArray(list) ? [...list] : [];
  loaded = true;
  listeners.forEach((fn) => fn());
};

const subscribe = (fn) => {
  listeners.add(fn);
  if (!loaded) {
    loaded = true;
    getFeatureVisibility().then((r) => setHiddenFeatures(r?.hidden)).catch(() => { loaded = false; });
  }
  return () => listeners.delete(fn);
};

/** The hidden feature keys, re-rendering the caller when they change. */
export const useHiddenFeatures = () => useSyncExternalStore(subscribe, () => hiddenFeatures);

/** Whether one feature is hidden, re-rendering the caller when that changes. */
export const useFeatureHidden = (feature) => useHiddenFeatures().includes(feature);
