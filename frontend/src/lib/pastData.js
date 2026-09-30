// Past Data's words — the pre-OS Excel sheets, read-only (see backend/routers/v3_past_data.py),
// as Settings > Import/Export and its Add Sheet dialog show them.

export const rs = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The three kinds of sheet the import reads (backend past_data.py / past_revenue.py / past_os.py).
export const LAYOUT_LABELS = {
  register: "Register",
  revenue: "Revenue sheet",
  os: "OS Data",
};

export const layoutLabel = (layout) => LAYOUT_LABELS[layout] || LAYOUT_LABELS.register;

// What a sheet holds, as the Type column's chips and the filter pills above it. An OS Data
// sheet holds up to three at once (its Leads tab; its Physio, Sessions and Reviews tabs; its
// Payments tab); the register and a revenue sheet are one kind each.
export const TYPE_LABELS = {
  register: "Register",
  lead: "Lead",
  sessions: "Sessions",
  revenue: "Revenue",
};

export const sheetTypes = (sheet) => {
  if (sheet?.layout === "os") return sheet.types?.length ? sheet.types : ["lead"];
  return [sheet?.layout === "revenue" ? "revenue" : "register"];
};
