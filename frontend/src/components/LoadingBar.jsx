import { useEffect, useState } from "react";
import { subscribeLoading } from "@/lib/loadingBar";

// A read that answers in under this never shows the bar: a flash on every quick, cached
// reply reads as a slower app than no bar at all.
const SHOW_AFTER_MS = 200;
// Held a moment after the last read ends, so two loads back to back show one sweep
// rather than a bar that blinks off and on between them.
const HIDE_AFTER_MS = 150;

/**
 * The thin blue bar along the bottom edge while the page is loading -- the one Branch
 * Admin had, now on every page. Mounted once in App.js; see lib/loadingBar.js for what
 * counts as loading.
 */
export function LoadingBar() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer = null;
    const unsubscribe = subscribeLoading((busy) => {
      clearTimeout(timer);
      timer = setTimeout(() => setShow(busy), busy ? SHOW_AFTER_MS : HIDE_AFTER_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  if (!show) return null;
  return (
    <div
      role="status"
      aria-label="Loading"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] h-0.5 overflow-hidden bg-blue-100"
      data-testid="loading-bar"
    >
      <div className="loading-bar-sweep h-full w-1/2 bg-blue-600" />
    </div>
  );
}
