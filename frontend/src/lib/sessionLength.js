// FITSIO STORE's session length, picked the same way everywhere a slot's length is shown —
// the calendar that publishes it, the gear's settings, and Assign Physio's picker that
// books it. The picker used to take the first store item it found, so it could disagree
// with the calendar about the very slots it was offering.

/**
 * FITSIO STORE's length from a list of store items: a physiotherapy item before any other
 * shelf, then the one Super Admin edited last — the same pick the booking popup's server
 * makes (consultation_slot_minutes). null when none has a length.
 */
export const pickStoreMinutes = (items) => {
  const rank = (i) => [["", "physiotherapy"].includes(i.category || "") ? 1 : 0, i.updated_at || i.created_at || ""];
  const best = (items || [])
    .filter((i) => Number(i.duration_minutes) > 0)
    .sort((a, b) => {
      const [pa, ta] = rank(a);
      const [pb, tb] = rank(b);
      return pb - pa || tb.localeCompare(ta);
    })[0];
  return best ? Number(best.duration_minutes) : null;
};
