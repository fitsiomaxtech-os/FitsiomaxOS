import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { THEME_MODES, CUSTOM_FIELDS, CUSTOM_PRESETS, announceTheme, isHex, normalizeCustom, themeSwatches } from "@/lib/theme";

const Swatches = ({ colors }) => (
  <span className="flex shrink-0 overflow-hidden rounded-full border border-slate-200">
    {colors.map((c, i) => <span key={i} className="h-4 w-2.5" style={{ background: c }} />)}
  </span>
);

/** A small mock of a board in the chosen colours, so Multi is judged before it is saved. */
const MultiPreview = ({ c }) => (
  <div className="overflow-hidden rounded-md border" style={{ background: c.background, borderColor: c.border }} data-testid="theme-multi-preview">
    <div className="flex items-center justify-between border-b px-3 py-2" style={{ background: c.surface, borderColor: c.border }}>
      <span className="text-xs font-bold" style={{ color: c.text }}>FitsiomaxOS</span>
      <span className="rounded px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: c.primary }}>Active tab</span>
    </div>
    <div className="p-3">
      <div className="rounded border p-2.5" style={{ background: c.surface, borderColor: c.border }}>
        <p className="text-xs font-semibold" style={{ color: c.text }}>Panel title</p>
        <p className="text-[11px]" style={{ color: c.text, opacity: 0.6 }}>Secondary text on a panel</p>
        <span className="mt-2 inline-block rounded px-2.5 py-1 text-[11px] font-semibold text-white" style={{ background: c.primary }}>Button</span>
        <span className="ml-2 text-[11px] font-semibold" style={{ color: c.primary }}>Link</span>
      </div>
    </div>
  </div>
);

/**
 * Developer Access > Theme Appearance: the app's look (Default / Dark / Multi), the Multi
 * colour editor, and whether users get the header icon to pick their own.
 */
export const ThemeAppearanceCard = ({ password, getSetting, saveSetting, onFailed }) => {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!password) return;
    getSetting(password).then((r) => { setSaved(r); setDraft(r); }).catch((e) => onFailed?.(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  if (!draft) return <p className="px-1 py-3 text-sm text-slate-400">Loading theme…</p>;

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const allValid = Object.values(draft.custom).every(isHex);
  const setColor = (k, v) => setDraft({ ...draft, custom: { ...draft.custom, [k]: v } });

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveSetting(password, draft);
      setSaved(r);
      setDraft(r);
      announceTheme(r);
    } catch (e) {
      onFailed?.(e);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-5" data-testid="theme-appearance">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">App theme</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {THEME_MODES.map((t) => {
            const on = draft.mode === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setDraft({ ...draft, mode: t.key })}
                className={`flex items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition ${on ? "border-sky-600 bg-sky-50 font-semibold text-sky-700 ring-1 ring-sky-600" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                data-testid={`theme-mode-${t.key}`}
              >
                <Swatches colors={themeSwatches(t.key, draft.custom)} />
                <span className="flex-1">{t.label}</span>
                {on && <Check className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-md border border-slate-200 p-3 sm:p-4" data-testid="theme-multi-editor">
        <p className="text-sm font-semibold text-slate-800">Theme Edit — Multi Theme colours</p>
        <p className="mb-3 text-xs text-slate-500">Start from a preset, then change any colour by hand. Used whenever Multi Theme is on.</p>
        <div className="mb-4 flex flex-wrap gap-2">
          {CUSTOM_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setDraft({ ...draft, custom: { ...p.colors } })}
              className="flex items-center gap-2 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              data-testid={`theme-preset-${p.key}`}
            >
              <Swatches colors={[p.colors.background, p.colors.surface, p.colors.primary, p.colors.text]} />
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2.5">
            {CUSTOM_FIELDS.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-3" data-testid={`theme-color-${f.key}`}>
                <span className="text-sm text-slate-700">{f.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <input
                    type="text"
                    value={draft.custom[f.key]}
                    onChange={(e) => setColor(f.key, e.target.value.trim())}
                    maxLength={7}
                    aria-label={`${f.label} hex`}
                    className={`h-8 w-24 rounded border bg-white px-2 font-mono text-xs text-slate-800 ${isHex(draft.custom[f.key]) ? "border-slate-200" : "border-rose-400"}`}
                    data-testid={`theme-color-${f.key}-hex`}
                  />
                  <input
                    type="color"
                    value={isHex(draft.custom[f.key]) ? draft.custom[f.key] : "#000000"}
                    onChange={(e) => setColor(f.key, e.target.value)}
                    aria-label={f.label}
                    className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
                    data-testid={`theme-color-${f.key}-picker`}
                  />
                </span>
              </div>
            ))}
          </div>
          <MultiPreview c={normalizeCustom(draft.custom)} />
        </div>
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-slate-200 px-4 py-3 hover:bg-slate-50" data-testid="theme-allow-users-card">
        <span>
          <span className="block text-sm font-medium text-slate-800">Allow users to change their own theme</span>
          <span className="block text-xs text-slate-500">Adds a palette icon to the header. Each person's pick changes their own screen only.</span>
        </span>
        <Switch
          checked={!!draft.allow_user_choice}
          onCheckedChange={(v) => setDraft({ ...draft, allow_user_choice: v })}
          className="data-[state=checked]:bg-emerald-600"
          data-testid="theme-allow-users-toggle"
        />
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={() => setDraft(saved)} data-testid="theme-reset-btn">Discard</Button>
        <Button size="sm" disabled={!dirty || saving || !allValid} onClick={save} data-testid="theme-save-btn">
          {saving ? "Saving..." : "Save Theme"}
        </Button>
      </div>
    </div>
  );
};
