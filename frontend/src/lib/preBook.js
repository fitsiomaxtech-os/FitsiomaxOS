/**
 * Pre Book: a client who will come later, and what they paid to hold the visit.
 *
 * Read by Branch Leads (the stage, its move popup and its collect popup) and by the
 * Consultations board (where the money is used on the real fees). Kept here so both read
 * the record the same way. The server side is backend/routers/v3_pre_book.py, and the plan
 * keys mirror PRE_BOOK_PLANS in backend/constants.py.
 */
import { to12h } from "@/lib/time";

// When the client said they would come. The date each works out to is only the starting
// point: the desk may move it, and "On a Date" is a day picked outright.
export const PRE_BOOK_PLANS = [
  { key: "next_week", label: "Next Week", days: 7 },
  { key: "two_weeks", label: "In 2 Weeks", days: 14 },
  { key: "next_month", label: "Next Month", months: 1 },
  { key: "two_months", label: "In 2 Months", months: 2 },
  { key: "three_months", label: "In 3 Months", months: 3 },
  { key: "date", label: "On a Date" },
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Today, as the date input reads it. */
export const todayIso = () => iso(new Date());

/**
 * The day a plan works out to from today. A month on is the same date next month, held to
 * that month's last day -- 31 Jan plus a month is 28 Feb, not 3 Mar, which is what Date
 * makes of it left alone.
 */
export const planDate = (key, from = new Date()) => {
  const plan = PRE_BOOK_PLANS.find((p) => p.key === key);
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (plan?.days) d.setDate(d.getDate() + plan.days);
  if (plan?.months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + plan.months);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return iso(d);
};

/** The lead's Pre Book record, or null for a lead never moved onto the stage. */
export const preBookOf = (lead) => (lead?.pre_book && lead.pre_book.at ? lead.pre_book : null);

const num = (n) => Number(n) || 0;

/** Everything paid at Pre Book. */
export const preBookPaid = (pb) => num(pb?.consultation?.paid) + num(pb?.advance?.amount);

/**
 * What is still owed on a Pre Book consultation: its price, less the discount agreed and what
 * was paid. A discount is never collected; only the rest of a part payment is.
 */
export const preBookConsultOwed = (c) => (
  c ? Math.max(0, Math.round((num(c.price) - num(c.discount) - num(c.paid)) * 100) / 100) : 0
);

/**
 * What this lead paid at Pre Book and has not yet had used on a real fee -- the figure worth
 * putting beside a name, since it is money the desk has to remember.
 *
 * The consultation counts until it is used. An advance for Sessions counts until it is used
 * or the Treatment Fee starts without it (after which it cannot be). An advance for Others
 * is never used by the system -- the desk settles it by hand -- so it counts only until the
 * patient's Consultation Fee is in, rather than marking them for good.
 */
export const preBookUnused = (lead) => {
  const pb = preBookOf(lead);
  if (!pb) return 0;
  const c = pb.consultation;
  const a = pb.advance;
  const consult = c?.paid && !c.applied_at ? num(c.paid) : 0;
  let adv = 0;
  if (a?.amount && !a.applied_at) {
    const open = a.for === "sessions" ? lead.treatment_fee_paid == null : lead.package_paid == null;
    adv = open ? num(a.amount) : 0;
  }
  return consult + adv;
};

export const rupees = (n) => `₹${num(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "12 Nov 2026" for a YYYY-MM-DD, or "" for none. */
export const shortDay = (day) => (day
  ? new Date(`${String(day).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "");

/**
 * The planned visit as a line reads it: "12 Nov 2026 · 10:30 AM", or "12 Nov · 10:30 AM"
 * where room is short. The time is there once one was set -- the Pre Sales desk always sets
 * one; a visit Branch Leads planned before times were asked has only its date.
 */
export const preBookWhen = (pb, { short = false } = {}) => {
  if (!pb?.date) return "";
  const day = short
    ? new Date(`${String(pb.date).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
    : shortDay(pb.date);
  return [day, pb.time ? to12h(pb.time) : ""].filter(Boolean).join(" · ");
};

/** Whether the Pre Sales desk fixed this visit -- Branch Leads then only collects the money. */
export const preBookFixedByPreSales = (pb) => pb?.desk === "pre_sales";

/** What the advance was for, as a line reads it. */
export const advanceForLabel = (adv) => (
  adv ? `${adv.for === "sessions" ? "Sessions" : "Others"}${adv.note ? ` — ${adv.note}` : ""}` : ""
);
