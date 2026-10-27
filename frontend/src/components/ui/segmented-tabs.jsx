/**
 * The OS's dashboard tab bar: a recessed grey track with the selected tab raised out of it
 * as a white pill.
 *
 * Selection is carried by elevation — a lifted white pill against a sunken track — rather
 * than by a block of brand colour. A filled tab competes with the figures underneath it,
 * which are the thing the tab exists to show; on a board that is mostly numbers, the
 * navigation should be the quietest part of the screen.
 *
 * Shared so every dashboard's bar is literally the same component. These bars sit one
 * screen apart and drifted before: one was sky-filled, another orange-tinted, a third
 * underlined.
 *
 * `tabs` is [{ key, label, short?, icon? }]. Items share the row equally and truncate
 * before they overflow.
 *
 * `short` is the phone label. A truncated tab is not a tab — "Exec…", "App…", "Trea…" —
 * so anything that won't survive a sixth of a phone's width gets a shorter name rather
 * than an ellipsis. The full label returns from sm up.
 *
 * `phone` narrows one tab to half of itself below sm: "icon" drops the words and keeps the
 * glyph, "text" drops the glyph and keeps the words. For a bar that must stay one row on a
 * phone with more tabs than fit labelled. An icon-only tab keeps its full label in
 * title/aria-label, so it is still named for a long press and a screen reader. From sm up
 * the tab is the ordinary tab again.
 *
 * `mobileCols` fixes the bar to that many columns on a phone. Four is the ceiling: past
 * that a single row leaves each tab too narrow to read even abbreviated, and two rows of
 * three costs less than a bar nobody can use. Desktop is always one row.
 *
 * `collapse` is the other way out of that: the BDE Dashboard's strip on a phone. One
 * bordered white row of icons, the open tab in sky with its name slid out beside its icon
 * (`short` if it has one) and every other tab folded to the glyph alone. From sm up it is
 * the ordinary bar again. Ignores mobileCols, since it is one row by construction.
 */
// Written out rather than built from mobileCols: Tailwind reads the source for class
// names, so `grid-cols-${n}` compiles to nothing and the bar silently falls back to one
// unstyled column.
const MOBILE_LAYOUTS = {
  2: "grid grid-cols-2 sm:flex",
  3: "grid grid-cols-3 sm:flex",
  4: "grid grid-cols-4 sm:flex",
};

// `fit` sizes each tab to its full label from sm up instead of sharing the row equally.
// For a bar that sits in a shrink-to-fit wrapper: flex-1 there has no width to share, and
// min-w-0 lets every label collapse into an ellipsis.
export const SegmentedTabs = ({ tabs, value, onChange, testid = "segmented-tabs", size = "md", mobileCols = 0, fit = false, collapse = false }) => {
  if (collapse) {
    return (
      <div className="flex flex-nowrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:gap-1.5 sm:rounded-xl sm:border-0 sm:bg-slate-100" data-testid={testid}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = value === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              aria-current={active ? "page" : undefined}
              aria-label={t.label}
              title={t.label}
              className={`inline-flex min-w-0 flex-auto items-center justify-center whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-colors duration-150 sm:flex-1 sm:gap-1.5 sm:rounded-lg sm:px-3 sm:font-semibold ${
                active
                  ? "bg-sky-50 text-sky-700 sm:bg-white sm:text-slate-900 sm:shadow-sm"
                  : "text-slate-600 hover:bg-slate-50 sm:text-slate-500 sm:hover:bg-transparent sm:hover:text-slate-800"
              }`}
              data-testid={`${testid}-${t.key}`}
            >
              {Icon && <Icon className={`h-4 w-4 shrink-0 ${active ? "sm:text-sky-600" : ""}`} />}
              {/* Width and opacity rather than display, as on the BDE strip, so the name
                  slides open on the tab you pick and folds away on the one you left.

                  200ms and only those three properties, not BDE's 500ms transition-all: a
                  width animation re-lays the whole row out every frame, and at half a second
                  it was still running when the new tab's render landed on the main thread,
                  so on a phone it stalled midway and read as stuck. */}
              <span className={`overflow-hidden text-ellipsis transition-[max-width,margin,opacity] duration-200 ease-out sm:ml-0 sm:max-w-none sm:opacity-100 ${active ? "ml-2 max-w-[9rem] opacity-100" : "ml-0 max-w-0 opacity-0"}`}>
                {t.short ? (
                  <>
                    <span className="sm:hidden">{t.short}</span>
                    <span className="hidden sm:inline">{t.label}</span>
                  </>
                ) : t.label}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  // Four across a phone is about 80px a tab, and the usual px-2 plus the icon leaves ~46px
  // of text — under what "Pre Sales" needs, so it would arrive as "Pre Sal…". The padding
  // and the icon gap tighten only in that case; two and three columns have room already,
  // and desktop is untouched.
  const tight = mobileCols === 4;
  const pad = size === "sm"
    ? "px-2 py-1.5 text-[11px] sm:text-xs"
    : `${tight ? "px-1" : "px-2"} py-2 text-[11px] sm:px-3 sm:text-sm`;
  const iconGap = tight ? "gap-0.5" : "gap-1";
  const layout = MOBILE_LAYOUTS[mobileCols] || "flex";
  return (
    <div className={`${layout} gap-1 rounded-xl bg-slate-100 p-1 ${size === "sm" ? "" : "sm:gap-1.5"}`} data-testid={testid}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = value === t.key;
        const iconOnPhone = t.phone !== "text";
        const wordsOnPhone = t.phone !== "icon";
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-current={active ? "page" : undefined}
            title={t.phone === "icon" ? t.label : undefined}
            aria-label={t.phone === "icon" ? t.label : undefined}
            className={`flex min-w-0 items-center justify-center ${iconGap} rounded-lg font-semibold transition ${fit ? "sm:shrink-0 sm:whitespace-nowrap" : "sm:flex-1"} sm:gap-1.5 ${mobileCols ? "" : "flex-1"} ${pad} ${
              active
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
            data-testid={`${testid}-${t.key}`}
          >
            {Icon && <Icon className={`h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4 ${iconOnPhone ? "" : "hidden sm:block"} ${active ? "text-sky-600" : ""}`} />}
            {t.phone === "icon" ? (
              <span className="hidden truncate sm:inline">{t.label}</span>
            ) : t.short && wordsOnPhone ? (
              <>
                <span className="truncate sm:hidden">{t.short}</span>
                <span className="hidden truncate sm:inline">{t.label}</span>
              </>
            ) : (
              <span className="truncate">{t.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SegmentedTabs;
