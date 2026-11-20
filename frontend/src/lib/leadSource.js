/**
 * A lead's Source and Platform, read the same way on every desk.
 *
 * A lead off a synced Google Sheet is a Meta lead (source_type "meta") and carries the app
 * the patient filled the form in as `platform`: "Instagram" or "Facebook", or none where
 * the sheet left it blank. Those leads read "Meta" / "Meta · Instagram", never the sheet's
 * name -- source_tab is still stored, for the dashboards that count per sheet. Every other
 * lead reads as it always has: source_tab, else source_type.
 */
export const META = "Meta";
export const PLATFORMS = ["Instagram", "Facebook"];

export const isMetaLead = (lead) => String(lead?.source_type || "").trim().toLowerCase() === "meta";

/** The Source alone: "Meta", or the lead's source_tab / source_type. "" when it has none. */
export const leadSource = (lead) =>
  (isMetaLead(lead) ? META : String(lead?.source_tab || lead?.source_type || "").trim());

/** The Platform: "Instagram" / "Facebook" on a Meta lead, else "". */
export const leadPlatform = (lead) => (isMetaLead(lead) ? String(lead?.platform || "").trim() : "");

/** Source and Platform together, for a column or a card: "Meta · Instagram", "Meta", "Manual". */
export const leadSourceLabel = (lead) => [leadSource(lead), leadPlatform(lead)].filter(Boolean).join(" · ");

/** Whether a Platform pick ("" = All) lets this lead through. A Meta lead with no platform
 *  shows only under All. */
export const matchesPlatform = (lead, platform) => !platform || leadPlatform(lead) === platform;
