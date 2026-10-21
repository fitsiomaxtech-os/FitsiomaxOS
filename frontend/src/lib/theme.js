import twColors from "tailwindcss/colors";

/**
 * Theme Appearance -- the three looks Developer Access offers, drawn by swapping the CSS
 * variables tailwind.config.js reads every colour scale from.
 *
 *   default  the OS as it has always looked; no stylesheet at all.
 *   dark     slate turned over, and every tinted panel sunk into the dark.
 *   custom   "Multi": five colours a developer picks (primary, page, panel, text, border),
 *            with the in-between shades worked out from them.
 *
 * Super Admin's choice is the app's look. When they switch on "Allow users", the header
 * gets a palette icon and each person can pick their own, for their own screen only --
 * kept in this browser under their user id, never sent to the server.
 */

export const THEME_MODES = [
  { key: "default", label: "Default Theme" },
  { key: "dark", label: "Dark Theme" },
  { key: "custom", label: "Multi Theme" },
];

export const CUSTOM_FIELDS = [
  { key: "primary", label: "Primary (buttons, links, active tabs)" },
  { key: "background", label: "Page background" },
  { key: "surface", label: "Panels, cards and header" },
  { key: "text", label: "Text" },
  { key: "border", label: "Borders and lines" },
];

export const DEFAULT_CUSTOM = { primary: "#0284c7", background: "#f8fafc", surface: "#ffffff", text: "#0f172a", border: "#e2e8f0" };

// Starting points for Multi; each fills all five pickers and can then be edited by hand.
export const CUSTOM_PRESETS = [
  { key: "ocean", label: "Ocean", colors: { primary: "#0369a1", background: "#eef6fb", surface: "#ffffff", text: "#0c2a3d", border: "#cfe3ef" } },
  { key: "forest", label: "Forest", colors: { primary: "#15803d", background: "#f1f7f2", surface: "#ffffff", text: "#13291a", border: "#d3e6d8" } },
  { key: "sunset", label: "Sunset", colors: { primary: "#ea580c", background: "#fdf6f0", surface: "#fffdfb", text: "#3b1d0e", border: "#f1dccb" } },
  { key: "lavender", label: "Lavender", colors: { primary: "#7c3aed", background: "#f6f3fd", surface: "#ffffff", text: "#24163f", border: "#e0d7f5" } },
  { key: "rose", label: "Rose", colors: { primary: "#e11d48", background: "#fdf3f5", surface: "#ffffff", text: "#3a1220", border: "#f3d3dc" } },
  { key: "midnight", label: "Midnight", colors: { primary: "#38bdf8", background: "#0b1324", surface: "#131d33", text: "#e6edf7", border: "#26344f" } },
];

export const THEME_CHANGED_EVENT = "fitsiomax:theme-changed";

const SCALES = ["slate", "gray", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan"];
const NEUTRALS = ["slate", "gray"];
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ---- colour arithmetic -------------------------------------------------------------

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `a` moved toward `b` by `t` (0 = a, 1 = b). */
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const triplet = (c) => c.map((v) => Math.round(v)).join(" ");
const hsl = (c) => {
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
};
const luminance = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const tw = (name, shade) => hexToRgb(twColors[name][shade]);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

export const isHex = (v) => HEX_RE.test(String(v || ""));

/** A full custom palette, any missing or malformed colour taken from the default. */
export const normalizeCustom = (custom) => {
  const out = { ...DEFAULT_CUSTOM };
  Object.keys(DEFAULT_CUSTOM).forEach((k) => { if (isHex(custom?.[k])) out[k] = custom[k].toLowerCase(); });
  return out;
};

// ---- the two stylesheets ----------------------------------------------------------

const darkVars = () => {
  const v = {};
  const set = (kind, name, shade, c) => { v[`--${kind}-${name}-${shade}`] = triplet(c); };
  const base = tw("slate", "900");

  NEUTRALS.forEach((n) => {
    const s = (sh) => tw(n, sh);
    // Backgrounds: the pale ones become the dark page and its raised panels; the dark ones
    // stay dark enough for the white text that sits on them.
    const bg = { 50: [10, 16, 32], 100: s(800), 200: s(700), 300: s(600), 400: s(500), 800: s(700), 900: s(600), 950: s(800) };
    Object.entries(bg).forEach(([sh, c]) => set("bg", n, sh, c));
    // Text: the dark shades turn light. 50-400 are already light (they sit on dark chips).
    const tx = { 500: s(400), 600: [170, 182, 199], 700: s(300), 800: s(200), 900: s(100), 950: s(50) };
    Object.entries(tx).forEach(([sh, c]) => set("tx", n, sh, c));
    const bd = { 50: s(800), 100: s(800), 200: s(700), 300: s(600), 400: s(500), 700: s(400), 800: s(300), 900: s(200), 950: s(100) };
    Object.entries(bd).forEach(([sh, c]) => set("bd", n, sh, c));
  });

  SCALES.filter((n) => !NEUTRALS.includes(n)).forEach((n) => {
    const c500 = tw(n, "500");
    [["50", 0.14], ["100", 0.22], ["200", 0.32], ["300", 0.45]].forEach(([sh, t]) => set("bg", n, sh, mix(base, c500, t)));
    [["600", "400"], ["700", "300"], ["800", "200"], ["900", "200"], ["950", "100"]].forEach(([sh, to]) => set("tx", n, sh, tw(n, to)));
    [["50", 0.25], ["100", 0.3], ["200", 0.4], ["300", 0.55]].forEach(([sh, t]) => set("bd", n, sh, mix(base, c500, t)));
  });

  v["--bg-white"] = triplet(base);
  const shad = {
    "--background": hsl([10, 16, 32]), "--foreground": hsl(tw("slate", "100")),
    "--card": hsl(base), "--card-foreground": hsl(tw("slate", "100")),
    "--popover": hsl(base), "--popover-foreground": hsl(tw("slate", "100")),
    "--secondary": hsl(tw("slate", "800")), "--secondary-foreground": hsl(tw("slate", "100")),
    "--muted": hsl(tw("slate", "800")), "--muted-foreground": hsl(tw("slate", "400")),
    "--accent": hsl(tw("slate", "800")), "--accent-foreground": hsl(tw("sky", "300")),
    "--border": hsl(tw("slate", "700")), "--input": hsl(tw("slate", "700")),
  };
  return { ...v, ...shad };
};

const customVars = (custom) => {
  const c = normalizeCustom(custom);
  const p = hexToRgb(c.primary), bgc = hexToRgb(c.background), sf = hexToRgb(c.surface), tx = hexToRgb(c.text), bd = hexToRgb(c.border);
  const v = {};
  const set = (kind, name, shade, col) => { v[`--${kind}-${name}-${shade}`] = triplet(col); };

  // The primary replaces sky, the OS's own accent, at every shade: lighter ones mixed
  // toward the panel colour, darker ones toward the text, so a dark Multi palette works too.
  const light = luminance(sf) > 0.4;
  const toPale = light ? WHITE : sf;
  const toDeep = light ? BLACK : WHITE;
  const scale = {
    50: mix(toPale, p, 0.07), 100: mix(toPale, p, 0.14), 200: mix(toPale, p, 0.28), 300: mix(toPale, p, 0.45),
    400: mix(toPale, p, 0.7), 500: mix(toPale, p, 0.88), 600: p, 700: mix(p, toDeep, 0.18),
    800: mix(p, toDeep, 0.32), 900: mix(p, toDeep, 0.45), 950: mix(p, toDeep, 0.6),
  };
  SHADES.forEach((sh) => ["bg", "tx", "bd"].forEach((k) => set(k, "sky", sh, scale[sh])));

  NEUTRALS.forEach((n) => {
    set("bg", n, "50", bgc);
    set("bg", n, "100", mix(bgc, tx, 0.05));
    set("bg", n, "200", mix(bgc, tx, 0.11));
    set("bg", n, "300", mix(bgc, tx, 0.2));
    [["900", 0], ["800", 0.1], ["700", 0.2], ["600", 0.32], ["500", 0.45], ["400", 0.58]].forEach(([sh, t]) => set("tx", n, sh, mix(tx, sf, t)));
    set("bd", n, "50", mix(bd, sf, 0.6));
    set("bd", n, "100", mix(bd, sf, 0.45));
    set("bd", n, "200", bd);
    set("bd", n, "300", mix(bd, tx, 0.15));
  });
  v["--bg-white"] = triplet(sf);

  const shad = {
    "--background": hsl(bgc), "--foreground": hsl(tx),
    "--card": hsl(sf), "--card-foreground": hsl(tx),
    "--popover": hsl(sf), "--popover-foreground": hsl(tx),
    "--primary": hsl(p), "--ring": hsl(p),
    "--secondary": hsl(mix(bgc, tx, 0.05)), "--secondary-foreground": hsl(tx),
    "--muted": hsl(mix(bgc, tx, 0.05)), "--muted-foreground": hsl(mix(tx, sf, 0.45)),
    "--accent": hsl(scale[100]), "--accent-foreground": hsl(scale[700]),
    "--border": hsl(bd), "--input": hsl(bd),
  };
  return { vars: { ...v, ...shad }, dark: !light };
};

/** The stylesheet for a mode, or "" for Default (no overrides at all). */
export const buildThemeCss = (mode, custom) => {
  if (mode === "dark") {
    const vars = darkVars();
    return `:root{color-scheme:dark;${Object.entries(vars).map(([k, val]) => `${k}:${val}`).join(";")}}`;
  }
  if (mode === "custom") {
    const { vars, dark } = customVars(custom);
    return `:root{color-scheme:${dark ? "dark" : "light"};${Object.entries(vars).map(([k, val]) => `${k}:${val}`).join(";")}}`;
  }
  return "";
};

/** A handful of swatches for a mode, for the picker buttons. */
export const themeSwatches = (mode, custom) => {
  if (mode === "dark") return [twColors.slate[900], twColors.slate[800], twColors.sky[400], twColors.slate[100]];
  if (mode === "custom") {
    const c = normalizeCustom(custom);
    return [c.background, c.surface, c.primary, c.text];
  }
  return ["#f8fafc", "#ffffff", twColors.sky[600], twColors.slate[900]];
};

export const applyTheme = (mode, custom) => {
  if (typeof document === "undefined") return;
  const m = THEME_MODES.some((t) => t.key === mode) ? mode : "default";
  let el = document.getElementById("fitsiomax-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "fitsiomax-theme";
    document.head.appendChild(el);
  }
  el.textContent = buildThemeCss(m, custom);
  document.documentElement.dataset.appTheme = m;
};

// ---- what is stored where ---------------------------------------------------------

const SETTING_CACHE_KEY = "fitsiomax.appTheme";
const userKey = (userId) => `fitsiomax.userTheme.${userId}`;

export const DEFAULT_SETTING = { mode: "default", custom: DEFAULT_CUSTOM, allow_user_choice: false };

export const normalizeSetting = (s) => ({
  mode: THEME_MODES.some((t) => t.key === s?.mode) ? s.mode : "default",
  custom: normalizeCustom(s?.custom),
  allow_user_choice: !!s?.allow_user_choice,
});

/** The last setting the server sent, so the first paint is already the right colours. */
export const loadCachedSetting = () => {
  try {
    return normalizeSetting(JSON.parse(localStorage.getItem(SETTING_CACHE_KEY) || "null"));
  } catch {
    return DEFAULT_SETTING;
  }
};
export const cacheSetting = (s) => {
  try { localStorage.setItem(SETTING_CACHE_KEY, JSON.stringify(normalizeSetting(s))); } catch { /* private mode */ }
};

export const loadUserChoice = (userId) => {
  if (!userId) return null;
  try {
    const v = localStorage.getItem(userKey(userId));
    return THEME_MODES.some((t) => t.key === v) ? v : null;
  } catch {
    return null;
  }
};
export const saveUserChoice = (userId, mode) => {
  if (!userId) return;
  try {
    if (mode) localStorage.setItem(userKey(userId), mode);
    else localStorage.removeItem(userKey(userId));
  } catch { /* private mode */ }
};

/** What this person should be looking at: their own pick when users may choose, else the app's. */
export const effectiveMode = (setting, userChoice) => (setting.allow_user_choice && userChoice ? userChoice : setting.mode);

/** Tells every listener (the header picker, the provider) that the setting changed. */
export const announceTheme = (setting) => {
  cacheSetting(setting);
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: normalizeSetting(setting) }));
};
