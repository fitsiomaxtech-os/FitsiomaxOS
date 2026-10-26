import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * Where a floating layer sits: one rendered in a portal as position:fixed, so no popup's
 * own clipping can cut it off. `compute(width, height)` is handed the layer's measured size
 * and returns its `{ top, left, ... }` style; it is asked again on resize and on any scroll.
 *
 * Null until the first measure, so the caller renders the layer hidden for that one pass —
 * it runs before paint, so nothing is seen in the wrong place.
 */
export const useFloatingPosition = (open, layerRef, compute) => {
  const [pos, setPos] = useState(null);
  const computeRef = useRef(compute);
  computeRef.current = compute;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const update = () => {
      const el = layerRef.current;
      if (el) setPos(computeRef.current(el.offsetWidth, el.offsetHeight));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, layerRef]);

  return pos;
};

/** Shuts a floating layer on a press anywhere outside the refs given (its trigger, itself). */
export const useDismissOutside = (open, refs, onDismiss) => {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (refsRef.current.some((r) => r.current && r.current.contains(e.target))) return;
      dismissRef.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
};
