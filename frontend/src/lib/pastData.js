// Past Data's words — the pre-OS Excel sheets, read-only (see backend/routers/v3_past_data.py),
// as Settings > Import/Export and its Add Sheet dialog show them.

export const rs = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The four kinds of sheet the import reads (backend past_data.py / past_revenue.py / past_os.py /
// past_custom.py). "custom" is any other list of people, read column by column as picked.
export const LAYOUT_LABELS = {
  register: "Register",
  revenue: "Revenue sheet",
  os: "OS Data",
  custom: "Custom sheet",
};

export const layoutLabel = (layout) => LAYOUT_LABELS[layout] || LAYOUT_LABELS.register;

// What a sheet holds, as the Type column's chips and the filter pills above it. An OS Data
// sheet holds up to three at once (its Leads tab; its Physio, Sessions and Reviews tabs; its
// Payments tab); a custom sheet is leads; the register and a revenue sheet are one kind each.
export const TYPE_LABELS = {
  register: "Register",
  lead: "Lead",
  sessions: "Sessions",
  revenue: "Revenue",
};

// Sheets whose Type chips name the kind of data rather than the layout.
export const typedLayout = (layout) => layout === "os" || layout === "custom";

export const sheetTypes = (sheet) => {
  if (typedLayout(sheet?.layout)) return sheet.types?.length ? sheet.types : ["lead"];
  return [sheet?.layout === "revenue" ? "revenue" : "register"];
};

// ---------------------------------------------------------------------------- Auto Scan
//
// POST /past-data/import/scan lists every tab of an upload and every column under its header
// (backend past_scan.py). The dialog keeps what is turned on as "picks":
//   { [tab]: { on, cols: { [index]: { on, field } } } }
// starting from the scan's own defaults, and sends them to Fetch as picksPayload().

// A column the reader of this layout reads at all: every column on a custom sheet.
export const usableColumn = (c) => c.used;

export const initialPicks = (scan) => Object.fromEntries((scan?.tabs || []).map((t) => [
  t.name,
  { on: t.on, cols: Object.fromEntries(t.columns.map((c) => [c.index, { on: c.on, field: c.field || "" }])) },
]));

// What Fetch sends: the tabs left on and, in each, the columns left on with their OS field.
export const picksPayload = (scan, picks) => (scan?.tabs || [])
  .filter((t) => t.used && picks[t.name]?.on)
  .map((t) => ({
    tab: t.name,
    columns: t.columns
      .filter((c) => usableColumn(c) && (c.required || picks[t.name].cols[c.index]?.on))
      .map((c) => ({ index: c.index, field: scan.layout === "custom" ? picks[t.name].cols[c.index]?.field || "" : "" })),
  }));

const IDENTITY = ["name", "phone"];

// Why Fetch cannot run yet, tab by tab ("" for the file as a whole); empty when it can. The
// server says the same (past_scan._checked) — this only says it before the round trip.
export const picksProblems = (scan, picks) => {
  const problems = {};
  const payload = picksPayload(scan, picks);
  if (!payload.length) problems[""] = "Turn on at least one sheet to fetch.";
  if (scan?.layout === "custom") {
    payload.forEach((t) => {
      if (!t.columns.some((c) => IDENTITY.includes(c.field))) problems[t.tab] = "Give one column Name or Phone, or turn this sheet off.";
    });
  }
  return problems;
};

export const onCount = (tab, pick) => tab.columns.filter((c) => usableColumn(c) && (c.required || pick?.cols[c.index]?.on)).length;
