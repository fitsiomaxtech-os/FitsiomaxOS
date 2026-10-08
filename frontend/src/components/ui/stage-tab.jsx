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
// `phoneLabel` is what the card reads below md, where six full names will not fit across
// one row. The stage keeps its real name from md up, so the desk still reads it exactly as
// CI/CD ROOTS does.
//
// `flush` is a plain card that, below sm, trades its shadow for a 1px slate border (still
// the 5px corner), with the picked card washed sky-100 and its label and figure in sky-600
// rather than ringed. Its figure is 17px there, 85% of the 20px it was, which the user
// found too big. From sm up it is the plain card unchanged. See StageTabBar's phoneFlush.
export const StageTab = ({ label, phoneLabel, count, active, onClick, color, hoverColor, selectedColor, testid, gridded = false, plain = false, flush = false, borderClass = "" }) => {
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
      className={`relative flex flex-col items-center justify-center text-center transition-all sm:min-w-0 sm:flex-1 sm:shrink sm:px-3 sm:py-2.5 ${
        flush ? "sm:hover:shadow-sm" : "hover:shadow-sm"
      } ${
        flush ? "rounded-[5px] border sm:border-0" : plain ? "rounded-[5px]" : "rounded-lg"
      } ${
        flush
          ? "w-full min-w-0 px-0.5 py-2.5"
          : gridded
            ? "w-full min-w-0 px-1 py-2"
            : "min-w-[86px] shrink-0 px-3 py-2.5"
      } ${
        flush
          ? (active
            ? "border-sky-200 bg-sky-100 text-sky-600 sm:text-sky-800 sm:shadow-md sm:ring-2 sm:ring-inset sm:ring-sky-500"
            : "border-slate-200 bg-white text-slate-600 sm:shadow-sm sm:hover:bg-slate-50")
          : plain
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
        flush
          ? "text-[10px] leading-tight max-[374px]:text-[9px]"
          : gridded
            ? "text-[9px] leading-[1.2] [hyphens:auto]"
            : "text-[11px] leading-tight"
      }`}>
        {phoneLabel && phoneLabel !== label ? (
          <>
            <span className="md:hidden">{phoneLabel}</span>
            <span className="hidden md:inline">{label}</span>
          </>
        ) : label}
      </span>
      <span className={`font-bold leading-none sm:mt-0.5 sm:text-lg ${flush ? "mt-1 text-[17px]" : gridded ? "mt-0.5 text-base" : "mt-0.5 text-lg"}`}>{count}</span>
      {/* The corner arrow the finance boards' summary cards carry (see ui/ledger-card), so
          Branch Admin's summary strip and Accountant Manage's own read as the same card.
          Absolutely placed so the centred label and figure underneath are not shifted by it.
          From sm up only: a phone card is the stage and its count, nothing in the corner. */}
      {plain && (
        <ChevronRight
          className={`absolute right-1.5 top-1.5 hidden h-3.5 w-3.5 sm:block sm:h-4 sm:w-4 ${active ? "text-sky-500" : "text-slate-400"}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
};

// `hideAllStages` drops the leading "All Stages" pill (stage pills still toggle
// off on a second click, so the filter can always be cleared).
//
// `phoneLabels` maps a stage's name to the shorter one its card reads below md (see
// StageTab's phoneLabel). Keyed by the name rather than the role, so a stage Super Admin
// renames stops being shortened and reads as its new name instead of a stale abbreviation.
//
// `phoneRow` is Branch Leads on a phone: every card in one row instead of five to a row,
// and the cards drawn at 80%. zoom rather than transform: scale, as on the desk tab strip
// in BranchAdminBoard -- zoom shrinks the cards themselves, so the row still spans the bar
// edge to edge. It sits on the inner row, not the sticky bar, because zoom also scales the
// bar's own `top` and would slide it under the page header.
//
// `phoneFlush` is Branch Leads and Consultation on a phone: below sm the bar loses its tray,
// border and padding, runs the full screen width (-mx-3 over CRMPage's px-3) and is pulled
// up over the page's 16px top padding so it sits straight under the header. What is left is
// the cards themselves, each its own bordered box with the finance boards' 5px corner (see
// ui/ledger-card and StageTab's flush), 4px apart. No zoom on it below sm -- the tray's
// padding the 80% was paying for is gone, so the cards are drawn at full size instead.
// Implies `plain`; from sm up the bar is the plain card strip unchanged.
//
// A flush bar that wraps (Consultation's, more stages than a row) keeps five to a row but
// as a wrapping flex row rather than a grid, so a short last row sits centred under the
// full one instead of hanging off its left end -- a grid has no way to centre a part-filled
// row.
//
// `className` is added to the bar itself. A wrapper div cannot hide it instead: the wrapper
// would become the sticky bar's containing block, and the bar would stop sticking.
export const StageTabBar = ({ stages, stageFilter, setStageFilter, counts, totalCount, testid, hideAllStages = false, plain = false, phoneLabels = {}, phoneRow = false, phoneFlush = false, className = "" }) => (
  <div
    // The offset has to clear the sticky page header, which is two different heights:
    // 61px on a phone (py-3 + a 36px logo + border) and 89px from sm up (py-4 + 56px).
    // A flat 88px left a white band under the header on a phone once scrolled.
    className={`sticky top-[61px] z-10 sm:top-[88px] ${className} ${
      phoneFlush
        ? "-mx-3 -mt-4 bg-slate-50 sm:-mx-1 sm:mt-0 sm:rounded-xl sm:border sm:border-slate-200 sm:bg-slate-100/95 sm:p-1 sm:shadow-sm sm:backdrop-blur sm:supports-[backdrop-filter]:bg-slate-100/80"
        : `-mx-1 rounded-xl border border-slate-200 p-1 shadow-sm backdrop-blur ${
          // A plain card is white and borderless, so it can only read as its own card if
          // what lies between the cards is not also white — hence the grey strip under them.
          plain
            ? "bg-slate-100/95 supports-[backdrop-filter]:bg-slate-100/80"
            : "bg-white/95 supports-[backdrop-filter]:bg-white/80"
        }`
    }`}
    data-testid={testid}
  >
    {/* Five to a row on a phone, so nine stages land as 5 + 4 and the whole bar is
        visible at once — it used to be a horizontal scroll, which hid the later stages
        behind a swipe nobody knew to make. Back to a single flex row from sm up.

        A flush row's columns are equal unless a label cannot fit one: with the 4px gaps
        taken out, a sixth of a 400px phone is short of "Appointment", so that column alone
        widens to its word instead of clipping it. */}
    <div className={`sm:flex sm:flex-nowrap sm:overflow-visible ${
      phoneRow
        ? `grid grid-flow-col ${phoneFlush ? "auto-cols-[minmax(min-content,1fr)] sm:max-md:[zoom:0.8]" : "auto-cols-fr max-md:[zoom:0.8]"}`
        : phoneFlush
          ? "flex flex-wrap max-sm:justify-center max-sm:[&>*]:basis-[calc((100%_-_16px)/5)]"
          : "grid grid-cols-5"
    } ${phoneFlush ? "gap-1 sm:gap-2" : plain ? "gap-2" : "gap-1"}`}>
      {!hideAllStages && (
        <StageTab
          label="All Stages"
          count={totalCount}
          active={stageFilter === null}
          onClick={() => setStageFilter(null)}
          color="#0ea5e9"
          testid={`${testid}-total`}
          gridded
          plain={plain || phoneFlush}
          flush={phoneFlush}
        />
      )}
      {stages.map((s) => (
        <StageTab
          key={s.id}
          label={s.name}
          phoneLabel={phoneLabels[s.name]}
          count={counts?.[s.name] || 0}
          active={stageFilter === s.name}
          onClick={() => setStageFilter(stageFilter === s.name ? null : s.name)}
          color={s.color || "#64748b"}
          hoverColor={s.hover_color}
          selectedColor={s.selected_color}
          testid={`${testid}-${s.name}`}
          gridded
          plain={plain || phoneFlush}
          flush={phoneFlush}
        />
      ))}
    </div>
  </div>
);
