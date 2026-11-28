import { useEffect, useRef } from "react";

/** Keep the full payment summary reachable without making the picker taller. */
export function PaymentDetailsStrip({ children }) {
  const stripRef = useRef(null);
  const drag = useRef(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const strip = stripRef.current;
    let frame = 0;
    let target = strip.scrollLeft;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      target = strip.scrollLeft;
    };
    const animate = () => {
      const remaining = target - strip.scrollLeft;
      if (Math.abs(remaining) < 2) {
        strip.scrollLeft = target;
        frame = 0;
        return;
      }
      strip.scrollLeft += remaining * 0.25;
      frame = requestAnimationFrame(animate);
    };
    const wheel = (event) => {
      if (event.ctrlKey || drag.current) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 0) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      if (!frame) target = strip.scrollLeft;
      const next = Math.max(0, Math.min(max, target + delta * scale));
      if (next === target) return;
      event.preventDefault();
      target = next;
      if (reducedMotion.matches) strip.scrollLeft = target;
      else if (!frame) frame = requestAnimationFrame(animate);
    };
    strip.addEventListener("wheel", wheel, { passive: false });
    strip.addEventListener("pointerdown", stop);
    strip.addEventListener("keydown", stop);
    return () => {
      stop();
      strip.removeEventListener("wheel", wheel);
      strip.removeEventListener("pointerdown", stop);
      strip.removeEventListener("keydown", stop);
    };
  }, []);

  const endDrag = (event) => {
    drag.current = null;
    event.currentTarget.style.cursor = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={stripRef}
      role="region"
      aria-label="Payment details — swipe, drag or scroll to see all"
      tabIndex={0}
      data-testid="cons-payment-scroll"
      className="flex cursor-grab select-none items-stretch gap-2 overflow-x-auto whitespace-nowrap overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 sm:gap-2.5"
      onPointerDown={(event) => {
        suppressClick.current = false;
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const distance = event.clientX - drag.current.x;
        if (!suppressClick.current && Math.abs(distance) < 5) return;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.style.cursor = "grabbing";
        event.currentTarget.scrollLeft = drag.current.left - distance;
        event.preventDefault();
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerLeave={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) endDrag(event);
      }}
      onClickCapture={(event) => {
        if (suppressClick.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      {children}
    </div>
  );
}
