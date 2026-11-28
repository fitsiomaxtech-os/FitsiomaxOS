import { act } from "react";
import { createRoot } from "react-dom/client";
import { PaymentDetailsStrip } from "./payment-details-strip";

let host, root, strip, choose;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = () => ({ matches: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  choose = jest.fn();
  act(() => root.render(<PaymentDetailsStrip><button onClick={choose}>Allow</button></PaymentDetailsStrip>));
  strip = host.firstChild;
  Object.defineProperties(strip, { scrollWidth: { value: 1400 }, clientWidth: { value: 800 } });
  strip.setPointerCapture = jest.fn();
  strip.hasPointerCapture = () => false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function pointer(type, x, target = strip, pointerType = "mouse") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, pointerId: 1, pointerType, button: 0 });
  act(() => target.dispatchEvent(event));
}

test("wheel reveals both ends, supports line units, and preserves pinch zoom", () => {
  const wheel = (options) => {
    const event = new WheelEvent("wheel", { cancelable: true, ...options });
    strip.dispatchEvent(event);
    return event;
  };
  expect(wheel({ deltaY: 20, deltaMode: 1 }).defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(320);
  wheel({ deltaY: 1000 });
  expect(strip.scrollLeft).toBe(600);
  expect(wheel({ deltaY: 20 }).defaultPrevented).toBe(false);
  wheel({ deltaX: -1000 });
  expect(strip.scrollLeft).toBe(0);
  expect(wheel({ deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
  expect(strip.scrollLeft).toBe(0);
});

test("dragging a payment button scrolls without changing payment permission", () => {
  const button = strip.firstChild;
  pointer("pointerdown", 300, button);
  pointer("pointermove", 100);
  expect(strip.scrollLeft).toBe(200);
  pointer("pointerup", 100);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  expect(choose).not.toHaveBeenCalled();
  pointer("pointerdown", 100, button);
  pointer("pointerup", 100, button);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  expect(choose).toHaveBeenCalledTimes(1);
});

test("touch gestures stay native", () => {
  pointer("pointerdown", 300, strip, "touch");
  pointer("pointermove", 100, strip, "touch");
  expect(strip.setPointerCapture).not.toHaveBeenCalled();
});

test("wheel animates toward the accumulated destination", () => {
  act(() => root.unmount());
  window.matchMedia = () => ({ matches: false });
  const frames = [];
  const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  root = createRoot(host);
  act(() => root.render(<PaymentDetailsStrip>Payment details</PaymentDetailsStrip>));
  strip = host.firstChild;
  Object.defineProperties(strip, { scrollWidth: { value: 1400 }, clientWidth: { value: 800 } });
  strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, cancelable: true }));
  expect(strip.scrollLeft).toBe(0);
  frames.shift()();
  expect(strip.scrollLeft).toBeGreaterThan(0);
  expect(strip.scrollLeft).toBeLessThan(200);
  strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
  for (let i = 0; frames.length && i < 100; i++) frames.shift()();
  expect(strip.scrollLeft).toBe(300);
  expect(frames).toHaveLength(0);
  raf.mockRestore();
});
