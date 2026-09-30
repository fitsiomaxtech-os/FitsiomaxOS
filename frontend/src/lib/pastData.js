// Past Data's words — the pre-OS Excel sheets, read-only (see backend/routers/v3_past_data.py),
// as Settings > Import/Export and its Add Sheet dialog show them.

export const rs = (n) => `Rs.${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The two kinds of sheet the import reads (backend past_data.py / past_revenue.py).
export const LAYOUT_LABELS = {
  register: "Register",
  revenue: "Revenue sheet",
};

export const layoutLabel = (layout) => LAYOUT_LABELS[layout] || LAYOUT_LABELS.register;
