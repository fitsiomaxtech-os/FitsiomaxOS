import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";

/**
 * The phone's own Back -- the button, or the swipe in from the edge -- on Branch Admin.
 *
 * Left alone it leaves /app: nothing inside the board is a page of its own, so the browser
 * has no step to go back to but the one before the app. Here it goes back to the first
 * stage instead -- the tab's stage cards -- closing whatever is open above them in one go:
 * a stage's list, a sub-panel, a lead's popup, My Profile. One press, not one per layer.
 * From the cards a press asks before the app is closed (PhoneExitConfirm).
 *
 * Done with two extra history entries, both on the same URL with the router's own state
 * kept, so it reads them as no move:
 *  - root: armed on the first tap, and again after Stay. Back popping it is the press from
 *    the cards, and asks.
 *  - deep: pushed the moment anything opens above the cards; Back popping it resets the
 *    board. Closed the board's own way -- a back bar, a popup's X -- it is taken off again,
 *    so the next Back is not swallowed by a step that no longer leads anywhere.
 * Both are pushed from a tap and never from a timer or an effect on load: Chrome skips, on
 * Back, an entry a page pushed without the person touching it.
 *
 * What is open is told from below: each screen with a deeper layer calls useStageBack with
 * whether that layer is up. Popups inside those layers need not -- the reset remounts the
 * tab, which closes them with everything else.
 *
 * The browser's own "Leave site?" guards the rest -- a refresh, an address typed over this
 * one. Not the Home button or the tab switcher: no page is told about those, and the app
 * is still there, as it was, when the person comes back.
 */

const PhoneBackContext = createContext(null);
export const PhoneBackProvider = PhoneBackContext.Provider;

// The width the bottom nav and the stage cards are drawn at (Tailwind's md, less a pixel).
const PHONE_QUERY = "(max-width: 767px)";
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

// A page leaving within this long of a tap was sent away by it -- Call, WhatsApp, a mail --
// and is not asked "Leave site?" about it.
const TAP_LEAVE_MS = 3000;

const push = (kind) => window.history.pushState({ ...(window.history.state || {}), phoneBack: kind }, "");

export function usePhoneBackState({ enabled, onBack }) {
  const openRef = useRef(new Set()); // which callers have a layer up
  const rootRef = useRef(false); // the root entry is in the history
  const deepRef = useRef(false); // the deep entry is on top of it
  const skipRef = useRef(false); // the next popstate is our own history.back()
  const askingRef = useRef(false);
  const leavingRef = useRef(false); // Exit pressed, or the session expired: let the page go
  const lastTapRef = useRef(0);
  const goneRef = useRef(false); // the board is unmounting (a log out): touch nothing
  const [asking, setAsking] = useState(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // A layout cleanup runs before the panels' own effect cleanups, which report their layers
  // closed on the way out -- and must not walk the history back from under the log out.
  useLayoutEffect(() => {
    goneRef.current = false;
    return () => { goneRef.current = true; };
  }, []);

  const sync = useCallback(() => {
    if (!enabled || goneRef.current || skipRef.current || askingRef.current || leavingRef.current) return;
    const deep = openRef.current.size > 0;
    if (deep && !deepRef.current && isPhone()) {
      if (!rootRef.current) {
        push("root");
        rootRef.current = true;
      }
      push("deep");
      deepRef.current = true;
    } else if (!deep && deepRef.current) {
      deepRef.current = false;
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
      if (deepRef.current) {
        deepRef.current = false;
        onBackRef.current();
        return;
      }
      if (rootRef.current) {
        rootRef.current = false;
        askingRef.current = true;
        setAsking(true);
      }
    };
    // Capture, so the root entry is in before the tap's own handler opens anything.
    const onTap = () => {
      lastTapRef.current = Date.now();
      if (!rootRef.current && !skipRef.current && !askingRef.current && !leavingRef.current && isPhone()) {
        push("root");
        rootRef.current = true;
      }
    };
    const onBeforeUnload = (e) => {
      // askingRef: Back pressed again over the Close box is the answer to it, not asked twice.
      if (leavingRef.current || askingRef.current || !isPhone() || Date.now() - lastTapRef.current < TAP_LEAVE_MS) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // api.js reloads the page when the session has expired; that is not the person leaving.
    const onExpired = () => { leavingRef.current = true; };
    // Back into the app from the page Exit went to, restored as it was left: nothing of
    // ours is in the history any more, and the next tap arms it again.
    const onPageShow = (e) => {
      if (!e.persisted) return;
      leavingRef.current = false;
      rootRef.current = false;
      deepRef.current = false;
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onTap, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("auth:expired", onExpired);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onTap, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("auth:expired", onExpired);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, sync]);

  // Stay: the root entry goes back in, from this tap. Also what the box closing reports, Exit
  // included -- by then asking is already off, and nothing is pushed.
  const stay = useCallback(() => {
    if (!askingRef.current) return;
    askingRef.current = false;
    setAsking(false);
    push("root");
    rootRef.current = true;
  }, []);

  // Exit: the step before the app. A tab opened straight onto /app has none, and no page may
  // close a tab it did not open, so there the next Back -- no longer caught -- closes it.
  const exit = useCallback(() => {
    askingRef.current = false;
    setAsking(false);
    leavingRef.current = true;
    window.history.back();
    setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      leavingRef.current = false;
      toast("Press Back once more to close the app");
    }, 700);
  }, []);

  return useMemo(() => ({ set, asking, stay, exit }), [set, asking, stay, exit]);
}

// A screen telling the board it has a layer up over the cards. Outside Branch Admin there
// is no provider and this does nothing.
export function useStageBack(isOpen, ctx) {
  const fromContext = useContext(PhoneBackContext);
  const phoneBack = ctx || fromContext;
  const set = phoneBack?.set;
  const id = useId();
  useEffect(() => {
    if (!set) return undefined;
    set(id, !!isOpen);
    return () => set(id, false);
  }, [set, id, isOpen]);
}

// Back pressed on the stage cards. Drawn as My Profile's Log out? box is, at 80%.
export function PhoneExitConfirm({ phoneBack }) {
  return (
    <AlertDialog open={phoneBack.asking} onOpenChange={(open) => { if (!open) phoneBack.stay(); }}>
      <AlertDialogContent className="w-[calc(80%-1.6rem)] max-w-[19.2rem] gap-0 rounded-[13px] p-0" data-testid="phone-exit-confirm">
        <div className="grid gap-5 p-5" style={{ zoom: 0.8 }}>
          <AlertDialogHeader className="items-center space-y-3 text-center sm:text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600">
              <LogOut className="h-6 w-6" />
            </span>
            <AlertDialogTitle className="text-base text-slate-800">Close Fitsiomax OS?</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] text-slate-500">
              You will stay signed in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:space-x-0">
            <AlertDialogCancel className="mt-0 h-11 rounded-xl" data-testid="phone-exit-stay">Stay</AlertDialogCancel>
            <AlertDialogAction
              onClick={phoneBack.exit}
              className="h-11 rounded-xl bg-sky-600 text-white hover:bg-sky-700"
              data-testid="phone-exit-leave"
            >
              Exit
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
