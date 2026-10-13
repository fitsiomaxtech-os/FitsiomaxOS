// Phone helpers shared by the boards that offer Call and WhatsApp on a patient.
//
// This logic was copied into four boards before it lived anywhere; new callers import it
// from here instead of growing a fifth. The existing copies are identical and can be
// pointed at this file whenever those components are next touched.

/**
 * A stored phone in E.164 for wa.me and tel:, which take digits only — no +, spaces, or
 * the "p:" prefix some records carry.
 *
 * A bare 10-digit number is assumed Indian, matching every other number in the system;
 * anything already carrying a country code is left alone. Returns "" when there's
 * nothing dialable, so a caller can hide the button rather than offer a dead link.
 */
export const waNumber = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
};

/**
 * A stored phone as the dialer should get it from tel:. Not waNumber's output: the dialer
 * reads "918825587322" (91 with no +) as a 12-digit local number and rings the wrong one.
 *
 * An Indian number — bare 10 digits, 0-prefixed, or carrying 91 / +91 — comes back as its
 * plain 10 digits, which is what the person would type. Anything else keeps its country
 * code behind a +. Returns "" when there's nothing dialable.
 */
export const telNumber = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return `+${digits}`;
};

/**
 * A stored phone as a person should read it on screen: the plain 10 digits of an Indian
 * number, with no "p:" off a Meta export, no +91, no spaces. telNumber's rule, but kept
 * to the numbers it can actually read -- a cell holding two numbers, or anything else
 * that isn't one Indian number, is shown as written (less the "p:") rather than mashed
 * into one long run of digits. Returns "" for nothing, so `displayPhone(x) || "—"` works.
 */
export const displayPhone = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return text.replace(/^p:\s*/i, "");
};
