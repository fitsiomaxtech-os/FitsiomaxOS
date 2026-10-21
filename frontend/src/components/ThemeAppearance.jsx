import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getAppTheme } from "@/lib/api";
import {
  THEME_MODES, THEME_CHANGED_EVENT, applyTheme, announceTheme, effectiveMode, loadCachedSetting,
  loadUserChoice, saveUserChoice, themeSwatches,
} from "@/lib/theme";

const USER_THEME_EVENT = "fitsiomax:user-theme-changed";

/** The app's theme setting as last heard, kept current by announceTheme. */
const useThemeSetting = () => {
  const [setting, setSetting] = useState(loadCachedSetting);
  useEffect(() => {
    const on = (e) => setSetting(e.detail);
    window.addEventListener(THEME_CHANGED_EVENT, on);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, on);
  }, []);
  return setting;
};

const useUserChoice = (userId) => {
  const [choice, setChoice] = useState(() => loadUserChoice(userId));
  useEffect(() => {
    setChoice(loadUserChoice(userId));
    const on = () => setChoice(loadUserChoice(userId));
    window.addEventListener(USER_THEME_EVENT, on);
    return () => window.removeEventListener(USER_THEME_EVENT, on);
  }, [userId]);
  return choice;
};

/**
 * Mounted once at the top of the app: fetches the setting and keeps the page in the look
 * this person should see. Draws nothing.
 */
export const AppThemeController = ({ userId }) => {
  const setting = useThemeSetting();
  const choice = useUserChoice(userId);

  useEffect(() => {
    getAppTheme().then(announceTheme).catch(() => { /* keep the cached look */ });
  }, [userId]);

  useEffect(() => {
    applyTheme(effectiveMode(setting, choice), setting.custom);
  }, [setting, choice]);

  return null;
};

const Swatches = ({ colors }) => (
  <span className="flex shrink-0 overflow-hidden rounded-full border border-slate-200">
    {colors.map((c, i) => <span key={i} className="h-4 w-2.5" style={{ background: c }} />)}
  </span>
);

/**
 * The palette icon in the header. Only there while Developer Access has "Allow users to
 * change their theme" on; the pick is this person's own and changes their screen only.
 */
export const HeaderThemePicker = ({ userId, className = "" }) => {
  const setting = useThemeSetting();
  const choice = useUserChoice(userId);
  const [open, setOpen] = useState(false);
  if (!setting.allow_user_choice || !userId) return null;
  const current = effectiveMode(setting, choice);

  const pick = (mode) => {
    // Picking the app's own look clears the override, so a later change by the developer
    // reaches this person again.
    saveUserChoice(userId, mode === setting.mode ? null : mode);
    window.dispatchEvent(new Event(USER_THEME_EVENT));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`shrink-0 rounded-md p-2 text-slate-500 transition hover:bg-sky-50 hover:text-sky-600 ${className}`}
          aria-label="Theme"
          title="Theme"
          data-testid="header-theme-button"
        >
          <Palette className="h-4 w-4 sm:h-5 sm:w-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5" data-testid="header-theme-menu">
        <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Theme Appearance</p>
        {THEME_MODES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => pick(t.key)}
            className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition hover:bg-slate-100 ${current === t.key ? "font-semibold text-sky-700" : "text-slate-700"}`}
            data-testid={`header-theme-${t.key}`}
          >
            <Swatches colors={themeSwatches(t.key, setting.custom)} />
            <span className="flex-1">{t.label}</span>
            {current === t.key && <Check className="h-4 w-4" />}
          </button>
        ))}
        <p className="px-2 pb-1 pt-1.5 text-[10px] text-slate-400">Changes your screen only.</p>
      </PopoverContent>
    </Popover>
  );
};
