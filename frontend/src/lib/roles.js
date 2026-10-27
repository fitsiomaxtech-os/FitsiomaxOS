/**
 * The role vocabulary — what each role slug is called on screen, and the colour it wears.
 *
 * Lifted out of HRBoard.jsx because the Super Admin Dashboard's staff roster names the
 * same people. One list, so HR Admin and the Dashboard can never call the same account
 * two different things — the same reason TeamCard is shared rather than copied.
 */

export const ROLE_META = {
  super_admin: { label: "SUPER ADMIN", classes: "border-purple-300 bg-purple-50 text-purple-700" },
  // Purple's neighbour, the way every family here shifts one hue for its variant.
  super_admin_pro: { label: "SUPER ADMIN PRO", classes: "border-violet-300 bg-violet-50 text-violet-700" },
  hr_admin: { label: "HR ADMIN", classes: "border-rose-300 bg-rose-50 text-rose-700" },
  // Retired wording. HR Admin is a fixed slug now — migrate_designation_roles in
  // backend/seed.py rewrites whatever was typed.
  human_resource: { label: "HR ADMIN", classes: "border-rose-300 bg-rose-50 text-rose-700", retired: true },
  business_dev: { label: "BUSINESS DEVELOPMENT EXECUTIVE", classes: "border-indigo-300 bg-indigo-50 text-indigo-700" },
  pre_sales: { label: "PRE SALES", classes: "border-sky-300 bg-sky-50 text-sky-700" },
  // Sales Head shares Pre-Sales' own sky — it's the same desk's manager, not a role of
  // its own, so it wears the same hue rather than claiming a fresh one.
  sales_head: { label: "SALES HEAD", classes: "border-sky-300 bg-sky-50 text-sky-700" },
  // The Branch Admin family shares emerald, and the online arm shares teal, on purpose:
  // the hue says which kind of role this is and the label says which practice it runs.
  // Handing each its own colour would spend the whole palette on one job and leave the
  // list looking like unrelated roles rather than two groups of one.
  branch_admin: { label: "BRANCH ADMIN", classes: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  online_physio_admin: { label: "ONLINE PHYSIO ADMIN", classes: "border-teal-300 bg-teal-50 text-teal-700" },
  online_fitness_admin: { label: "ONLINE FITNESS ADMIN", classes: "border-teal-300 bg-teal-50 text-teal-700" },
  // Retired, and rendered as the plain Branch Admin they now are. The three named a
  // practice rather than an arm and held identical permissions, so they collapse onto
  // branch_admin — migrate_branch_admin_roles in backend/seed.py rewrites the logins.
  // Kept only so an account the migration has not reached still wears a name rather than
  // a raw slug, exactly as the retired consultation slugs below are.
  branch_admin_physio: { label: "BRANCH ADMIN", classes: "border-emerald-300 bg-emerald-50 text-emerald-700", retired: true },
  branch_admin_fitness: { label: "BRANCH ADMIN", classes: "border-emerald-300 bg-emerald-50 text-emerald-700", retired: true },
  branch_admin_physio_fitness: { label: "BRANCH ADMIN", classes: "border-emerald-300 bg-emerald-50 text-emerald-700", retired: true },
  // The consultation desk. Amber for the room, and — as the Branch Admin family does from
  // emerald to teal — the neighbouring hue for the online arm of it.
  consultant: { label: "CONSULTANT", classes: "border-amber-300 bg-amber-50 text-amber-700" },
  online_consultant: { label: "ONLINE CONSULTANT", classes: "border-yellow-300 bg-yellow-50 text-yellow-700" },
  // Retired slugs, rewritten by migrate_consultant_roles in backend/seed.py. Kept only so
  // an account the migration has not reached still wears a name rather than a raw slug.
  head_physio: { label: "CONSULTANT", classes: "border-amber-300 bg-amber-50 text-amber-700", retired: true },
  online_head_physio: { label: "ONLINE CONSULTANT", classes: "border-yellow-300 bg-yellow-50 text-yellow-700", retired: true },
  // Called what the clinic calls them. "Physio" is the slug's own shorthand and was
  // reaching the screen unchanged, so the role filter said PHYSIO while every list of
  // designations beside it said Physiotherapist.
  physio: { label: "PHYSIOTHERAPIST", classes: "border-cyan-300 bg-cyan-50 text-cyan-700" },
  // Blue against Physio's cyan is the same shift the family above makes from emerald to
  // teal: the base hue says which kind of role this is, and the neighbouring one says it
  // is the online arm of it.
  online_physio: { label: "ONLINE PHYSIOTHERAPIST", classes: "border-blue-300 bg-blue-50 text-blue-700" },
  // Both desks in one person, so it wears both: the Physio's cyan edge on the Consultant's
  // amber. See COMBINED_EXPERT_ROLES in backend/deps.py.
  consultant_physio: { label: "CONSULTANT + PHYSIOTHERAPIST", classes: "border-cyan-400 bg-amber-50 text-amber-700" },
  // Fixed slugs now rather than whatever was typed into Credentials — see DEFAULT_ROLES.
  nutritionist: { label: "NUTRITIONIST", classes: "border-lime-300 bg-lime-50 text-lime-700" },
  zumba: { label: "ZUMBA", classes: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700" },
  // Retired wordings, rewritten by migrate_designation_roles in backend/seed.py.
  nutrition_coach: { label: "NUTRITIONIST", classes: "border-lime-300 bg-lime-50 text-lime-700", retired: true },
  diet_manage: { label: "NUTRITIONIST", classes: "border-lime-300 bg-lime-50 text-lime-700", retired: true },
  marketing_head: { label: "MARKETING HEAD", classes: "border-pink-300 bg-pink-50 text-pink-700" },
  accountant: { label: "ACCOUNTANT", classes: "border-orange-300 bg-orange-50 text-orange-700" },
};
// The hues custom roles already carry in the database. Nothing picks one any more — the
// Create Role form stopped offering a colour, and the backend stores "slate" for a role
// added without one — so this is here to render the roles that were given a colour back
// when it was offered. Written as literal class strings because Tailwind reads the source
// for class names; a template built from the colour key would compile to nothing.
const ROLE_SWATCHES = {
  purple: { classes: "border-purple-300 bg-purple-50 text-purple-700" },
  indigo: { classes: "border-indigo-300 bg-indigo-50 text-indigo-700" },
  sky: { classes: "border-sky-300 bg-sky-50 text-sky-700" },
  emerald: { classes: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  amber: { classes: "border-amber-300 bg-amber-50 text-amber-700" },
  cyan: { classes: "border-cyan-300 bg-cyan-50 text-cyan-700" },
  pink: { classes: "border-pink-300 bg-pink-50 text-pink-700" },
  orange: { classes: "border-orange-300 bg-orange-50 text-orange-700" },
  rose: { classes: "border-rose-300 bg-rose-50 text-rose-700" },
  teal: { classes: "border-teal-300 bg-teal-50 text-teal-700" },
  slate: { classes: "border-slate-300 bg-slate-100 text-slate-700" },
};

// Colours for roles added at runtime. Module-level because roleClasses is called from
// half a dozen places that have no reason to thread meta through, and there is exactly one
// role list per install. Refilled whenever meta loads.
const CUSTOM_ROLE_CLASSES = new Map();
export const setCustomRoleClasses = (customRoles) => {
  CUSTOM_ROLE_CLASSES.clear();
  (customRoles || []).forEach((r) => {
    const swatch = ROLE_SWATCHES[r.color];
    if (r.name && swatch) CUSTOM_ROLE_CLASSES.set(r.name, swatch.classes);
  });
};

// String() rather than the bare slug: HRBoard only ever passed a role it had just read off
// a form, but the Dashboard roster renders whatever /hr/users returns, and one account
// saved without a role would otherwise take the whole board down on `.replace` of
// undefined.
export const roleLabel = (role) => ROLE_META[role]?.label || String(role || "").replace(/_/g, " ").toUpperCase();
export const roleClasses = (role) =>
  ROLE_META[role]?.classes || CUSTOM_ROLE_CLASSES.get(role) || "border-slate-200 bg-white text-slate-600";
