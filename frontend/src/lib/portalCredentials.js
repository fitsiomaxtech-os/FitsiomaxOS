// How a Client Portal login is written out for the patient — shared by the Patients panel
// (Generate / Reset) and the popup that follows booking a treatment course, so both send
// the same words and a change to the message is made once.

import { displayPhone } from "@/lib/phone";

export const portalUrl = () => `${window.location.origin}/portal`;

/** The ways in, as [label, value] rows. Phone first because every patient has one; email
    only when the login carries one. */
export const credentialLines = (c) => [
  ...(c.phone ? [["Login (phone)", displayPhone(c.phone)]] : []),
  ...(c.email ? [[c.phone ? "Or email" : "Login (email)", c.email]] : []),
  ["Password", c.password],
];

/** The WhatsApp message. Blank lines between each field, *bold* labels (WhatsApp markdown),
    and the auto-linked URL last on its own line — a credential sandwiched right next to
    label text with no visual gap is exactly what gets over-selected on a small touchscreen
    when the patient copies it by hand. */
export const portalWhatsAppText = (name, c) => [
  `Hi ${name}, here is your Fitsiomax Client Portal access:`,
  "",
  ...credentialLines(c).flatMap(([label, value]) => [`*${label}:* ${value}`, ""]),
  `*Login here:* ${portalUrl()}`,
].join("\n");

export const portalCopyText = (c) =>
  [portalUrl(), ...credentialLines(c).map(([label, value]) => `${label}: ${value}`)].join("\n");
