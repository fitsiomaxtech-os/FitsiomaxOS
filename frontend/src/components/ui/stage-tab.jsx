import { useState } from "react";
import { ChevronRight } from "lucide-react";

// A stage is called what Super Admin calls it in CI/CD ROOTS, here and everywhere else.
//
// There used to be a rename table on this line -- `{ "Appointment Date & Time":
// "Appointment" }` -- shortening one stage for display while the stored value stayed long.
// It meant the pill on a branch's board and the row in CI/CD ROOTS disagreed about the name
// of the same stage, with no way to tell from either screen which one the pipeline actually
// held: Super Admin read "Appointment Date & Time", the branch read "Appointment", and
// renaming it in CI/CD ROOTS changed the second but could not change the first back.
//
// Shortening a long stage name is now done by renaming the stage.

// Sticky segmented pill tab used to filter a leads list by stage — shared between
// Branch Admin's Branch Leads pipeline and Consultations boards.
//
// `gridded` sizes the pill to fill a grid cell instead of holding a fixed width inside
// a scrolling row. It's opt-in because the fixed width is what makes the scrolling
// variant work — dropping it there would collapse the pills to nothing. Bars that lay
// their own pills out (Physio Review, Branch Review, Pre-Sales) get the scrolling
// sizing untouched.
//
// `plain` drops the per-stage colour: each stage is a white card of its own, separated by
// the grey strip showing through rather than by an outline, with only the selected one
// picked out. Opt-in rather than the default because this bar is shared: Branch Leads
// asked for blank cards, while the Consultations and Pre-Sales bars still read by
// colour, and changing it here would have restyled all three at once.
//
// A blank card also takes the finance boards' corner (ui/ledger-card, 5px) rather than the
// shared rounded-lg, so Branch Admin's summary strip and Accountant Manage's own read as
// the same card. Scoped to `plain`, so the coloured Consultations and Pre-Sales bars keep
// the radius they had.
// `borderClass` outlines the card in a colour of the caller's choosing — a Tailwind
// border utility, passed as a literal class name so the JIT can see it. Only meaningful
// alongside `plain`, whose cards are borderless by design; the coloured variant already
// draws its own border from the stage tint. Empty by default, so every existing bar is
// untouched.
// `hoverColor` and `selectedColor` are a stage's own hover and picked colours, set in CI/CD
// ROOTS (Pre-Sales only for now). Either left unset falls back to `color`, so a bar whose
// stages carry neither draws exactly as it did before they existed.
export const StageTab = ({ label, count, active, onClick, color, hoverColor, selectedColor, testid, gridded = false, plain = false, borderClass = "" }) => {
  const tint = color || "#0ea5e9";
  const picked = selectedColor || tint;
  const [hovered, setHovered] = useState(false);
  // Only a stage that has a hover colour of its own swaps on hover -- the rest keep the
  // plain shadow lift they always had.
  const hoverTint = !active && hovered && hoverColor ? hoverColor : null;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={testid}
      type="button"
      className={`relative flex flex-col items-center justify-center text-center transition-all hover:shadow-sm sm:min-w-0 sm:flex-1 sm:shrink sm:px-3 sm:py-2.5 ${
        plain ? "rounded-[5px]" : "rounded-lg"
      } ${
        gridded
          ? "w-full min-w-0 px-1 py-2"
          : "min-w-[86px] shrink-0 px-3 py-2.5"
      } ${
        plain
          ? (active
            ? "bg-sky-100 text-sky-800 ring-2 ring-inset ring-sky-500 shadow-md"
            : "bg-white text-slate-600 shadow-sm hover:bg-slate-50")
          : ""
      } ${plain ? borderClass : ""}`}
      style={
        plain
          ? undefined
          : active
            ? { background: picked, color: "#ffffff", boxShadow: `0 2px 8px ${picked}40` }
            : hoverTint
              ? { background: `${hoverTint}24`, color: hoverTint, border: `1px solid ${hoverTint}66` }
              : { background: `${tint}14`, color: tint, border: `1px solid ${tint}33` }
      }
    >
      {/* Title case, as the stage is actually named — "Consultation Completed", not
          CONSULTATION COMPLETED. The wide tracking went with the caps; it was there to
          space shouted letters out and only loosens ordinary words.

          In a grid cell the type is tighter still, so a long name wraps inside its
          column rather than widening it. */}
      <span className={`font-semibold sm:text-[11px] sm:leading-tight ${
        gridded
          ? "text-[9px] leading-[1.2] [hyphens:auto]"
          : "text-[11px] leading-tight"
      }`}>{label}</span>
      <span className={`mt-0.5 font-bold leading-none sm:text-lg ${gridded ? "text-base" : "text-lg"}`}>{count}</span>
      {/* The corner arrow the finance boards' summary cards carry (see ui/ledger-card), so
          Branch Admin's summary strip and Accountant Manage's own read as the same card.
          Absolutely placed so the centred label and figure underneath are not shifted by it. */}
      {plain && (
        <ChevronRight
          className={`absolute right-1.5 top-1.5 h-3.5 w-3.5 sm:h-4 sm:w-4 ${active ? "text-sky-500" : "text-slate-400"}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
};

// `hideAllStages` drops the leading "All Stages" pill (stage pills still toggle
// off on a second click, so the filter can always be cleared).
export const StageTabBar = ({ stages, stageFilter, setStageFilter, counts, totalCount, testid, hideAllStages = false, plain = false }) => (
  <div
    // The offset has to clear the sticky page header, which is two different heights:
    // 61px on a phone (py-3 + a 36px logo + border) and 89px from sm up (py-4 + 56px).
    // A flat 88px left a white band under the header on a phone once scrolled.
    className={`sticky top-[61px] z-10 -mx-1 rounded-xl border border-slate-200 p-1 shadow-sm backdrop-blur sm:top-[88px] ${
      // A plain card is white and borderless, so it can only read as its own card if what
      // lies between the cards is not also white — hence the grey strip under them.
      plain
        ? "bg-slate-100/95 supports-[backdrop-filter]:bg-slate-100/80"
        : "bg-white/95 supports-[backdrop-filter]:bg-white/80"
    }`}
    data-testid={testid}
  >
    {/* Five to a row on a phone, so nine stages land as 5 + 4 and the whole bar is
        visible at once — it used to be a horizontal scroll, which hid the later stages
        behind a swipe nobody knew to make. Back to a single flex row from sm up. */}
    <div className={`grid grid-cols-5 sm:flex sm:flex-nowrap sm:overflow-visible ${plain ? "gap-2" : "gap-1"}`}>
      {!hideAllStages && (
        <StageTab
          label="All Stages"
          count={totalCount}
          active={stageFilter === null}
          onClick={() => setStageFilter(null)}
          color="#0ea5e9"
          testid={`${testid}-total`}
          gridded
          plain={plain}
        />
      )}
      {stages.map((s) => (
        <StageTab
          key={s.id}
          label={s.name}
          count={counts?.[s.name] || 0}
          active={stageFilter === s.name}
          onClick={() => setStageFilter(stageFilter === s.name ? null : s.name)}
          color={s.color || "#64748b"}
          hoverColor={s.hover_color}
          selectedColor={s.selected_color}
          testid={`${testid}-${s.name}`}
          gridded
          plain={plain}
        />
      ))}
    </div>
  </div>
);
