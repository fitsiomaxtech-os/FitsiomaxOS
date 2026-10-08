// Times are stored and sent as 24-hour "HH:MM" (and slots as "YYYY-MM-DDTHH:MM").
// The OS displays them in 12-hour form everywhere — these helpers are display-only and
// must never be used to build a value that goes back to the API.

/** "09:30" -> "9:30 AM" · "21:30" -> "9:30 PM" */
export const to12h = (time) => {
  if (!time || typeof time !== "string" || !time.includes(":")) return time || "—";
  const [rawH, rawM] = time.split(":");
  const h = parseInt(rawH, 10);
  const m = (rawM || "").slice(0, 2);
  if (Number.isNaN(h)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
};

/** "2026-08-09T09:30" -> "9:30 AM" (accepts a bare "HH:MM" too) */
export const slotTo12h = (slotTime) => {
  if (!slotTime || typeof slotTime !== "string") return "—";
  return to12h(slotTime.includes("T") ? slotTime.split("T")[1] : slotTime);
};

/** "09:30" + 30 -> "10:00 AM" — the end of a slot, for "9:30 AM – 10:00 AM" ranges. */
export const endTime12h = (time, minutes) => {
  if (!time || !time.includes(":")) return time || "—";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const total = h * 60 + m + (minutes || 0);
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return to12h(`${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`);
};

/** "09:30" + 30 -> "9:30 AM to 10:00 AM" — a slot named by both of its ends.
 *
 * A slot tile that showed only where an hour starts made the reader do the arithmetic to
 * find out where it ends, off a session length written somewhere else on the screen. Both
 * ends spelled out is how the hour is said out loud to the patient booking it.
 */
export const slotRange12h = (time, minutes) => `${to12h(time)} to ${endTime12h(time, minutes)}`;

// ---------- Call-attempt stamps — used by the pre-sales RNR stage only ----------
// RNR attempt timestamps are stored in UTC, but the callers all sit in India, so the
// part of the day a call belongs to is always judged in IST — never in whatever
// timezone the viewer's browser happens to be set to.
const CALL_TZ = "Asia/Kolkata";

const toDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Minutes past IST midnight, so the bands below can be plain numeric ranges. */
const istMinutes = (d) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CALL_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return pick("hour") * 60 + pick("minute");
};

/**
 * Which part of the working day a call landed in. The bands are continuous — every
 * minute of the clock gets a word, and Night owns everything from 7 PM round to 7 AM.
 *   Night           7:00 pm – 6:59 am
 *   Morning         7:00 am – 11:59 am
 *   Afternoon      12:00 pm – 2:59 pm
 *   Late Afternoon  3:00 pm – 4:59 pm
 *   Evening         5:00 pm – 6:59 pm
 */
export const callDayPart = (value) => {
  const d = toDate(value);
  if (!d) return "";
  const mins = istMinutes(d);
  if (mins < 7 * 60) return "Night";
  if (mins < 12 * 60) return "Morning";
  if (mins < 15 * 60) return "Afternoon";
  if (mins < 17 * 60) return "Late Afternoon";
  if (mins < 19 * 60) return "Evening";
  return "Night";
};

/** A Date -> "02:25 pm", the minute in IST. */
const istClock = (d) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALL_TZ, hour: "2-digit", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  const hh = pick("hour").padStart(2, "0");
  const mm = pick("minute").padStart(2, "0");
  return `${hh}:${mm} ${pick("dayPeriod").toLowerCase()}`;
};

/** "2026-08-02T08:55:00Z" -> "02:25 pm Afternoon" — the exact minute, then its band. */
export const callTimeStamp = (value) => {
  const d = toDate(value);
  if (!d) return "";
  return `${istClock(d)} ${callDayPart(d)}`;
};

/** "2026-08-02T08:55:00Z" -> "02 Aug 2026" — callDateStamp carrying the year.
 *
 * The call log drops it on purpose: an attempt worth reading is one from this week, and
 * "02 Aug" is how somebody would say it out loud. A lead's own dates are not like that —
 * one can sit in a stage for a season — so a stamp read off the record rather than off
 * the log spells the year out.
 */
export const dateStampFull = (value) => {
  const d = toDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CALL_TZ, day: "2-digit", month: "short", year: "numeric",
  }).format(d);
};

/** "2026-08-02T08:55:00Z" -> "02 Aug 2026, 02:25 pm" — dateStampFull plus the minute.
 *
 * For a column headed "Date & Time", where callTimeStamp's band word ("Afternoon") would
 * only repeat what the clock already says.
 */
export const dateTimeStamp = (value) => {
  const d = toDate(value);
  if (!d) return "";
  return `${dateStampFull(d)}, ${istClock(d)}`;
};

/** "2026-08-02T08:55:00Z" -> "02 Aug" — the day a stamp belongs to, in IST. */
export const callDateStamp = (value) => {
  const d = toDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CALL_TZ, day: "2-digit", month: "short",
  }).format(d);
};
