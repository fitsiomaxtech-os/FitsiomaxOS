/**
 * A lead's activity trail in the order a Timeline reads it: oldest first, from the point
 * the lead came in to where it stands now.
 *
 * The API hands the trail back newest first, and Branch Admin's and Consultations'
 * Timelines already turned it round while Pre-Sales and Client History drew it as it came
 * -- so the same patient's stages read top-down on one board and bottom-up on the next.
 * Every Timeline goes through this, so they cannot disagree again.
 *
 * Returns a new array; the one passed in is left in the order it arrived, since the RNR
 * Record tab reads the same fetch newest first.
 */
export const byOldestFirst = (rows) =>
  [...(rows || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
