/**
 * The packages a Physiotherapy consultation is sold as.
 *
 * Read in two places that must agree: Services & Products, where a package is created and
 * its length previewed, and the Consultation Fee desk, where one is picked and its price
 * collected. Kept here rather than in either screen so neither imports the other — and so
 * there is one list to change when another package appears.
 *
 * Mirrors PACKAGES in backend/consultation_packages.py. `minutes` is the default length the
 * create form pre-fills; Super Admin can edit it per item, and the stored duration_minutes
 * is what gets booked. A test (backend/tests/test_consultation_packages.py)
 * reads this file back and fails if the two lists disagree, because a preview promising 65
 * minutes while the server stores 45 would surface as a physio's afternoon running over
 * rather than as anything on screen.
 */
export const CONSULTATION_PACKAGES = [
  {
    key: "only_consultation",
    label: "Only Consultation",
    minutes: 45,
    breakdown: "45 mins",
    durationLabel: "45 mins",
  },
  {
    key: "consultation_plus_physio",
    label: "Consultation + 20 mins Physio",
    minutes: 65,
    // One booking end to end: the physio follows the consultation in the same slot.
    breakdown: "45 mins + 20 mins = 65 mins",
    durationLabel: "65 mins",
  },
  {
    key: "consultation_plus_session",
    label: "Consultation + 1 Session",
    minutes: 45,
    breakdown: "45 mins + 1 Session",
    // Not "45 mins". A row promising a session that reads as 45 minutes looks like the
    // session was forgotten, wherever it is listed.
    durationLabel: "45 mins + 1 Session",
    // Said out loud in the create form, because "45 mins" against a package whose name
    // promises a session reads like a mistake otherwise. A session has no length in this
    // system to add -- a session package carries a count, not a duration -- and it is
    // booked whenever the patient is next free, so holding time for it here would block
    // out a physio's calendar for an appointment nobody has made.
    note: "The session is booked separately. Only the 45-minute consultation is held in the calendar.",
  },
  {
    // A returning patient seen again by the consultant, at its own price (Rs.600 when it
    // was added). Sold from the Consultation Fee desk and from the Pre Book popup.
    key: "reconsultation",
    label: "Reconsultation",
    minutes: 45,
    breakdown: "45 mins",
    durationLabel: "45 mins",
  },
];

/** The package keys in the order they are read on the shelf, and escalate in. */
export const CONSULTATION_PACKAGE_ORDER = CONSULTATION_PACKAGES.map((p) => p.key);

export const consultationPackageByKey = (key) =>
  CONSULTATION_PACKAGES.find((p) => p.key === key) || null;

/**
 * What one consultation item costs, for the mode the appointment is actually in.
 *
 * Online and offline are priced separately on every catalogue row. The server reads this
 * off the stored item itself when the money is taken — this is the same sum, for showing
 * the figure before anyone presses Collect.
 */
export const consultationItemPrice = (item, mode) =>
  (mode === "online" ? item?.price_online : item?.price_offline) ?? null;
