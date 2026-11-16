import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Globe, RefreshCw, Wifi } from "lucide-react";
import { MAYBE_OFFLINE_EVENT, probeConnection } from "@/lib/connection";

/**
 * "Check Your Internet Connection" -- the full screen the OS shows when the internet drops,
 * in place of the blank page Chrome used to leave behind.
 *
 * Shows at once on the browser's "offline" event, and also when a request comes back with
 * no answer and our own server cannot be reached (Wi-Fi on, internet gone). Leaves by itself
 * when the line is back, checked every few seconds, so the screen underneath -- with
 * whatever was typed into it -- is still there. Retry Connection checks straight away.
 *
 * Patient-facing pages are left out: they are not "Fitsiomax OS" to the person reading.
 */
const PUBLIC_PREFIXES = ["/portal", "/testimonials", "/consult-form", "/terms", "/privacy"];
const RECHECK_MS = 5000;

// The artwork's shapes are filled with the page colour so the ones in front hide the lines
// behind, as in line art. Read from the theme variable so Dark and Multi themes follow.
const PAPER = { fill: "rgb(var(--bg-slate-50, 248 250 252))" };
// The background bars take a border shade, not a text one: Dark leaves pale text pale (it
// sits on dark chips) but sinks pale borders, so the bars stay quieter than the drawing.
const FAINT = { ...PAPER, stroke: "rgb(var(--bd-slate-300, 203 213 225))" };

/** A megaphone with its line broken: the message cannot get out. Strokes use currentColor. */
const OfflineArt = ({ className = "" }) => (
  <svg
    viewBox="40 40 1180 1100"
    className={className}
    fill="none"
    strokeWidth="10"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    data-testid="offline-screen-art"
  >
    {/* Background: rounded bars and a dot. */}
    <g style={FAINT}>
      <rect x="75" y="75" width="1090" height="200" rx="100" />
      <rect x="75" y="895" width="1090" height="210" rx="105" />
      <rect x="75" y="485" width="420" height="205" rx="102" />
      <rect x="880" y="485" width="335" height="205" rx="102" />
      <rect x="880" y="710" width="250" height="195" rx="97" />
      <circle cx="335" cy="385" r="100" />
    </g>

    <g className="text-slate-500" stroke="currentColor" style={PAPER}>
      {/* Far half of the broken line, running on under the round end and into the strap
          (its right side is the strap's inner curve, so no edge shows between them). */}
      <path d="M644 414 L850 349 L930 470 L958 560 C972 610 1000 690 980 740 L800 760 L766 729 L771 684 L748 636 L768 596 L730 556 L751 516 L714 486 L706 449 L668 430 Z" />
      {/* Strap behind the round end. */}
      <path d="M1062 520 C1088 600 1078 700 1012 765 C992 778 972 762 980 740 C1000 690 972 610 958 560 Z" />
    </g>

    {/* The round end with Wi-Fi crossed out. */}
    <g className="text-sky-500" stroke="currentColor" style={PAPER}>
      <circle cx="952" cy="424" r="132" />
      <circle cx="968" cy="410" r="132" />
      <path d="M906 380 A130 130 0 0 1 1074 380" />
      <path d="M931 410 A92 92 0 0 1 1049 410" />
      <path d="M955 439 A54 54 0 0 1 1025 439" />
    </g>
    <g className="text-red-500" stroke="currentColor" strokeWidth="14">
      <path d="M974 462 L1006 494 M1006 462 L974 494" />
    </g>

    <g className="text-slate-500" stroke="currentColor" style={PAPER}>
      {/* Near half of the broken line. */}
      <path d="M432 508 L628 420 L652 436 L690 455 L698 492 L735 522 L714 562 L752 602 L732 642 L755 690 L750 735 L650 830 L500 850 Z" />
      {/* Megaphone bell, rim and speaker. */}
      <path d="M268 452 C430 455 565 575 565 705 C565 850 470 955 362 962 Z" />
      <ellipse cx="315" cy="707" rx="112" ry="258" transform="rotate(-10.4 315 707)" />
      <path d="M425 612 A78 78 0 0 0 425 768" />
      {/* Grip. */}
      <rect x="600" y="610" width="82" height="230" rx="10" transform="rotate(-22 641 725)" />
      {/* Window panel. */}
      <g transform="rotate(-12 865 890)">
        <rect x="690" y="700" width="350" height="390" rx="24" />
        <rect x="704" y="714" width="322" height="362" rx="16" />
        <rect x="730" y="738" width="128" height="108" rx="12" />
        <rect x="872" y="738" width="128" height="108" rx="12" />
        <rect x="730" y="862" width="128" height="190" rx="12" />
        <rect x="872" y="862" width="128" height="190" rx="12" />
      </g>
    </g>

    {/* Spark and shards where the line snapped. */}
    <g className="text-amber-500" stroke="currentColor" style={PAPER}>
      <path d="M668 125 C720 190 728 250 725 300 C722 370 700 415 665 415 C630 415 608 370 607 300 C605 240 625 185 668 125 Z" />
      <path d="M668 272 C690 300 697 330 696 355 C695 388 683 410 666 410 C649 410 638 388 638 355 C638 325 648 298 668 272 Z" />
      <path d="M458 326 L524 256 L604 376 L588 390 Z" />
      <path d="M828 180 L893 198 L808 308 L795 300 Z" />
    </g>
  </svg>
);

export const OfflineScreen = () => {
  const { pathname } = useLocation();
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const [checking, setChecking] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const goOffline = () => setOffline(true);
    const confirmOffline = async () => {
      if (!(await probeConnection()) && alive) setOffline(true);
    };
    const confirmOnline = async () => {
      if ((await probeConnection()) && alive) {
        setOffline(false);
        setStillOffline(false);
      }
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", confirmOnline);
    window.addEventListener(MAYBE_OFFLINE_EVENT, confirmOffline);
    return () => {
      alive = false;
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", confirmOnline);
      window.removeEventListener(MAYBE_OFFLINE_EVENT, confirmOffline);
    };
  }, []);

  // While it is up, keep checking so it leaves on its own once the line is back.
  useEffect(() => {
    if (!offline) return undefined;
    let alive = true;
    const timer = setInterval(async () => {
      if (navigator.onLine === false) return;
      if ((await probeConnection()) && alive) {
        setOffline(false);
        setStillOffline(false);
      }
    }, RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [offline]);

  if (!offline || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  const retry = async () => {
    setChecking(true);
    setStillOffline(false);
    const ok = await probeConnection();
    setChecking(false);
    if (ok) setOffline(false);
    else setStillOffline(true);
  };

  return (
    // pointer-events-auto: an open Radix dialog sets pointer-events: none on <body>.
    // Stopping pointerdown keeps that dialog from reading a click here as "outside" and closing.
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="offline-screen-title"
      aria-describedby="offline-screen-text"
      className="pointer-events-auto fixed inset-0 z-[9999] overflow-y-auto bg-slate-50"
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="offline-screen"
    >
      <div className="flex min-h-full items-center justify-center px-4 py-8">
        <div className="w-full max-w-md text-center">
          <OfflineArt className="mx-auto h-auto w-52 sm:w-64" />

          <h1 id="offline-screen-title" className="mt-6 font-heading text-2xl font-bold text-slate-900" data-testid="offline-screen-title">
            Check Your Internet Connection
          </h1>
          <p id="offline-screen-text" className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
            Unable to connect to Fitsiomax OS. Please check your internet connection and try again.
          </p>

          <div className="mt-5 rounded-[4px] border border-slate-200 bg-white p-4 text-left shadow-[0_8px_30px_rgb(2,6,23,0.06)]">
            <p className="text-sm font-semibold text-slate-900">Try:</p>
            <ul className="mt-2 space-y-2 text-sm text-slate-600">
              <li className="flex items-start gap-2.5">
                <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                Check your Wi-Fi or mobile data connection.
              </li>
              <li className="flex items-start gap-2.5">
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                Make sure your internet is working properly.
              </li>
              <li className="flex items-start gap-2.5">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                Reconnect and refresh the page.
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs">
              <span className="font-semibold text-slate-700">Error:</span>
              <code className="rounded-[4px] border border-red-200 bg-red-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-red-700" data-testid="offline-screen-error">
                ERR_INTERNET_DISCONNECTED
              </code>
            </div>
          </div>

          <button
            type="button"
            onClick={retry}
            disabled={checking}
            className="mt-5 inline-flex items-center justify-center gap-2 rounded-[4px] bg-sky-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 disabled:opacity-70"
            data-testid="offline-screen-retry"
          >
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking..." : "Retry Connection"}
          </button>
          {stillOffline && (
            <p className="mt-2 text-xs font-medium text-red-600" role="status" data-testid="offline-screen-still">
              Still no connection. Please check and try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
