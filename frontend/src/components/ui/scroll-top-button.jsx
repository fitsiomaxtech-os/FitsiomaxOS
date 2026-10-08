import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * A round "back to top" arrow for a long phone list: it stays out of sight until the
 * page has been scrolled down past `threshold` pixels, then fades in at the bottom right,
 * clear of the slate bottom nav, and one tap brings the page back to the top. The user
 * asked for it so the bottom of a long lead list isn't a long swipe back up.
 *
 * It watches the window because that is what scrolls on these screens: CRMPage is a
 * plain min-h-screen page and the lists grow it rather than scrolling inside a box.
 *
 * Phone only by default (`md:hidden`, the same breakpoint as the bottom nav it sits
 * above). It sits under the nav and the More sheet (z-30 against their z-40 / z-50) so
 * an open sheet covers it. Hidden, it is also out of the tab order and ignores taps.
 */
export const ScrollTopButton = ({ threshold = 400, className = "md:hidden", ...props }) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const check = () => setShown(window.scrollY > threshold);
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, [threshold]);

  const toTop = () => {
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      title="Back to top"
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      className={`fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg shadow-slate-900/20 transition-all duration-200 active:bg-sky-700 ${
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      } ${className}`}
      {...props}
    >
      <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
    </button>
  );
};

export default ScrollTopButton;
