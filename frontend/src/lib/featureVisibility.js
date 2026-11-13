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
//   treatments            — the Treatments catalogue tab in Services and Products, and
//                           the Consultant's Treatment Summary tick-list with it.
//   past_day_appointments — days before today on the Appointment popup's calendar
//                           (Branch Leads and Pre Sales). Shown as Allow / Block; hidden
//                           is Block.
//   progression_mandatory — whether the progression uploads hold up Mark Treatment
//                           Complete and Close Case Sheet. Shown as Mandatory / Optional;
//                           hidden is Optional. The server answers it on /progression too.
let hiddenFeatures = [];
let loaded = false;
// Whether the list has actually come back, as opposed to `loaded`, which is set as soon
// as the read is sent. useFeatureAllowed waits on it.
let resolved = false;
const listeners = new Set();

export const setHiddenFeatures = (list) => {
  hiddenFeatures = Array.isArray(list) ? [...list] : [];
  loaded = true;
  resolved = true;
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

/**
 * Whether one feature is switched on (Allow / Show), for a feature that ships off: false
 * until the list has been read, so a Blocked feature never flashes on while it loads.
 */
export const useFeatureAllowed = (feature) => {
  const hidden = useHiddenFeatures();
  return resolved && !hidden.includes(feature);
};
