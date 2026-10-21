import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef } from "react";

/**
 * The phone's own Back -- the button, or the swipe in from the edge -- on Branch Admin.
 *
 * Left alone it leaves /app: nothing inside the board is a page of its own, so the browser
 * has no step to go back to but the one before the app. Here it goes back to the first
 * stage instead -- the tab's stage cards -- closing whatever is open above them in one go:
 * a stage's list, a sub-panel, a lead's popup, My Profile. One press, not one per layer.
 * From the cards a press leaves the app as it always has.
 *
 * Done with a single extra history entry. The moment anything opens above the cards the
 * board pushes one (same URL, the router's own state kept, so it reads the move as no
 * move); Back pops it and the board resets. Closed the board's own way -- a back bar, a
 * popup's X -- the entry is taken off again, so the next Back is not swallowed by a step
 * that no longer leads anywhere.
 *
 * What is open is told from below: each screen with a deeper layer calls useStageBack with
 * whether that layer is up. Popups inside those layers need not -- the reset remounts the
 * tab, which closes them with everything else.
 */

const PhoneBackContext = createContext(null);
export const PhoneBackProvider = PhoneBackContext.Provider;

// The width the bottom nav and the stage cards are drawn at (Tailwind's md, less a pixel).
const PHONE_QUERY = "(max-width: 767px)";

export function usePhoneBackState({ enabled, onBack }) {
  const openRef = useRef(new Set()); // which callers have a layer up
  const guardRef = useRef(false); // our entry is on top of the history
  const skipRef = useRef(false); // the next popstate is our own history.back()
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const sync = useCallback(() => {
    if (!enabled || skipRef.current) return;
    const deep = openRef.current.size > 0;
    if (deep && !guardRef.current && window.matchMedia(PHONE_QUERY).matches) {
      window.history.pushState({ ...(window.history.state || {}), phoneBack: true }, "");
      guardRef.current = true;
    } else if (!deep && guardRef.current) {
      guardRef.current = false;
      skipRef.current = true;
      window.history.back();
    }
  }, [enabled]);

  const set = useCallback((id, isOpen) => {
    if (isOpen) openRef.current.add(id);
    else openRef.current.delete(id);
    sync();
  }, [sync]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onPop = () => {
      if (skipRef.current) {
        // Our own step back landed. Something may have opened again while it was on its
        // way; if so it needs its entry back.
        skipRef.current = false;
        sync();
        return;
      }
      if (!guardRef.current) return;
      guardRef.current = false;
      onBackRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled, sync]);

  return useMemo(() => ({ set }), [set]);
}

// A screen telling the board it has a layer up over the cards. Outside Branch Admin there
// is no provider and this does nothing.
export function useStageBack(isOpen, ctx) {
  const fromContext = useContext(PhoneBackContext);
  const phoneBack = ctx || fromContext;
  const id = useId();
  useEffect(() => {
    if (!phoneBack) return undefined;
    phoneBack.set(id, !!isOpen);
    return () => phoneBack.set(id, false);
  }, [phoneBack, id, isOpen]);
}
