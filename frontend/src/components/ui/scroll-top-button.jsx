import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * A round "back to top" arrow for a long list: it stays out of sight until the list has
 * been scrolled down past `threshold` pixels, then fades in at the bottom right at 80%
 * opacity so the row under it still shows through (the user asked for 80%), and one
 * tap brings the list back to the top. The user asked for it so the bottom of a long
 * lead list isn't a long swipe back up -- first on phones, then on desktop as well.
 *
 * It watches the window, which is what scrolls on a phone: CRMPage is a plain
 * min-h-screen page and the lists grow it. On desktop a list can scroll inside a box of
 * its own instead (Branch Leads' table is a 72vh region so its header can stick), so
 * `target` names that box by selector and the arrow answers to either. The listener sits
 * on document in the capture phase because a box's scroll doesn't bubble, and the box
 * is looked up on each scroll, so a box that remounts with a new stage still counts.
 *
 * On a phone it sits above the slate bottom nav; on desktop, where there is no nav,
 * down in the corner. It sits under the nav and the More sheet (z-30 against their
 * z-40 / z-50) so an open sheet covers it. Hidden, it is also out of the tab order and
 * ignores taps.
 */
export const ScrollTopButton = ({ threshold = 400, target, className = "", ...props }) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const check = () => {
      const box = target ? document.querySelector(target) : null;
      setShown(window.scrollY > threshold || (box?.scrollTop ?? 0) > threshold);
    };
    check();
    document.addEventListener("scroll", check, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", check, { capture: true });
  }, [threshold, target]);

  const toTop = () => {
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior = smooth ? "smooth" : "auto";
    window.scrollTo({ top: 0, behavior });
    if (target) document.querySelector(target)?.scrollTo({ top: 0, behavior });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      title="Back to top"
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      className={`fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg shadow-slate-900/20 transition-all duration-200 hover:bg-sky-700 active:bg-sky-700 md:bottom-6 md:right-6 ${
        shown ? "translate-y-0 opacity-80 hover:opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      } ${className}`}
      {...props}
    >
      <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
    </button>
  );
};

export default ScrollTopButton;
