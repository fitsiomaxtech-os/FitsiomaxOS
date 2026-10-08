/**
 * One slot on a phone's slate bottom bar: the glyph in a round chip, its name centred
 * directly under it. The open tab is picked out by the chip (white/20) with the icon and
 * the name both going white; the rest sit in slate-200.
 *
 * The name is 0.55rem — 55% of the page's text size — so a six-slot bar like the
 * Physio's ("Send to Review", "My Profile") keeps every name on one line at phone width.
 * Anything still too long truncates rather than wrapping the bar to two rows; the full
 * name stays on title and aria-label.
 *
 * `icon` is the rendered glyph, not the component, so each bar keeps its own icon size
 * and My Profile can pass its photo (ProfileNavGlyph) in the same slot.
 */
export const BottomNavTab = ({ icon, label, active = false, badge = 0, badgeTestId, className = "", ...props }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-current={active ? "page" : undefined}
    className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 pb-1.5 pt-1 transition-colors ${
      active ? "text-white" : "text-slate-200"
    } ${className}`}
    {...props}
  >
    <span className={`relative flex h-9 w-9 flex-none items-center justify-center rounded-full transition-colors ${active ? "bg-white/20" : ""}`}>
      {icon}
      {badge > 0 && (
        <span
          className="absolute right-0 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white"
          data-testid={badgeTestId}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </span>
    <span className={`w-full truncate text-center text-[0.55rem] leading-tight ${active ? "font-semibold" : "font-medium"}`}>{label}</span>
  </button>
);

export default BottomNavTab;
