import { useEffect, useRef, useState } from "react";
import {
  Contrast,
  Crop,
  Droplet,
  Loader2,
  Move,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Slider } from "@/components/ui/slider";
import { toast } from "@/components/ui/sonner";

/**
 * Crop, rotate and adjust a photo before it becomes somebody's profile picture.
 *
 * The circle is the avatar: whatever sits inside it is what every board will show, so the
 * person frames their own face rather than finding out afterwards that object-cover cut
 * off their chin. Drag to move, pinch / wheel / slider to zoom, quarter turns for a phone
 * shot that came in sideways, and three sliders for a photo taken under clinic lighting.
 *
 * The preview is CSS (transform + filter) so it follows a finger without redrawing; the
 * saved file is drawn once on a canvas with the same numbers. Adjustments are applied pixel
 * by pixel there rather than with ctx.filter, which older iPhones ignore — the photo saved
 * would have come out unadjusted while the preview showed it adjusted.
 */

// The saved photo: square, so the avatar circle is exactly the crop, and large enough to stay
// sharp at the biggest size an avatar is drawn (88px on a phone, at 3x density).
const OUTPUT = 512;
const MAX_ZOOM = 4;
const NEUTRAL = { brightness: 100, contrast: 100, saturation: 100 };

const TABS = [
  { key: "crop", label: "Crop & Rotate", short: "Crop", icon: Crop },
  { key: "adjust", label: "Adjust", icon: SlidersHorizontal },
];

const ADJUSTMENTS = [
  { key: "brightness", label: "Brightness", icon: Sun },
  { key: "contrast", label: "Contrast", icon: Contrast },
  { key: "saturation", label: "Saturation", icon: Droplet },
];

// Everything below is measured in crop-square units: the square is 1×1, and at zoom 1 the
// image's shorter side exactly fills it. That keeps the preview (whatever width the dialog
// is) and the 512px canvas the same picture.
const geometry = (img, rotation) => {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const side = Math.min(w, h) || 1;
  const turned = rotation % 180 !== 0;
  return { w: w / side, h: h / side, rw: (turned ? h : w) / side, rh: (turned ? w : h) / side };
};

// Never let the photo slide far enough to leave an empty corner inside the square.
const clampOffset = (offset, g, zoom) => {
  const mx = Math.max(0, (g.rw * zoom - 1) / 2);
  const my = Math.max(0, (g.rh * zoom - 1) / 2);
  return { x: Math.min(mx, Math.max(-mx, offset.x)), y: Math.min(my, Math.max(-my, offset.y)) };
};

const cssFilter = (a) => `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`;

// The same three steps as cssFilter, in the same order, so the file matches the preview.
const applyAdjustments = (ctx, a) => {
  if (a.brightness === 100 && a.contrast === 100 && a.saturation === 100) return;
  const image = ctx.getImageData(0, 0, OUTPUT, OUTPUT);
  const d = image.data;
  const b = a.brightness / 100;
  const c = a.contrast / 100;
  const s = a.saturation / 100;
  const lift = 127.5 * (1 - c);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < d.length; i += 4) {
    const r = clamp(clamp(d[i] * b) * c + lift);
    const g = clamp(clamp(d[i + 1] * b) * c + lift);
    const bl = clamp(clamp(d[i + 2] * b) * c + lift);
    d[i] = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * bl;
    d[i + 1] = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * bl;
    d[i + 2] = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * bl;
  }
  ctx.putImageData(image, 0, 0);
};

const renderPhoto = (img, { rotation, zoom, offset, adjust }) => new Promise((resolve, reject) => {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const ctx = canvas.getContext("2d");
  // White under a transparent PNG, which JPEG would otherwise turn black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, OUTPUT, OUTPUT);
  ctx.imageSmoothingQuality = "high";
  const g = geometry(img, rotation);
  ctx.translate(OUTPUT * (0.5 + offset.x), OUTPUT * (0.5 + offset.y));
  ctx.rotate((rotation * Math.PI) / 180);
  const w = g.w * zoom * OUTPUT;
  const h = g.h * zoom * OUTPUT;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyAdjustments(ctx, adjust);
  canvas.toBlob(
    (blob) => (blob ? resolve(new File([blob], "photo.jpg", { type: "image/jpeg" })) : reject(new Error("Could not prepare the photo"))),
    "image/jpeg",
    0.9,
  );
});

const midpoint = (pts) => ({
  x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
  y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
});
const spread = (pts) => (pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0);

const SliderRow = ({ icon: Icon, label, value, min, max, step, onChange, display, testid }) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between text-xs font-medium text-slate-600">
      <span className="flex items-center gap-1.5"><Icon className="h-3.5 w-3.5 text-slate-400" />{label}</span>
      <span className="tabular-nums text-slate-500">{display}</span>
    </div>
    <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} data-testid={testid} />
  </div>
);

/**
 * `source` is an image URL (a blob: URL for a freshly picked file, or the current photo's
 * own path); null keeps the dialog closed. `onSave` receives the finished 512px JPEG.
 */
export const PhotoEditor = ({ source, saving = false, onCancel, onSave, title = "Adjust photo" }) => {
  const [img, setImg] = useState(null);
  const [failed, setFailed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [adjust, setAdjust] = useState(NEUTRAL);
  const [tab, setTab] = useState("crop");
  const [box, setBox] = useState(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const wheel = useRef(null);

  useEffect(() => {
    if (!source) return undefined;
    setImg(null);
    setFailed(false);
    setRotation(0);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setAdjust(NEUTRAL);
    setTab("crop");
    let live = true;
    const el = new Image();
    // The current photo is read back off the server to be edited again; anonymous CORS keeps
    // the canvas readable should that ever be another origin. A picked file is a blob: URL.
    if (!source.startsWith("blob:")) el.crossOrigin = "anonymous";
    el.onload = () => { if (live) setImg(el); };
    el.onerror = () => { if (live) setFailed(true); };
    el.src = source;
    return () => { live = false; };
  }, [source]);

  const setView = (nextZoom, nextOffset, nextRotation = rotation) => {
    if (!img) return;
    const z = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    setZoom(z);
    setOffset(clampOffset(nextOffset, geometry(img, nextRotation), z));
  };

  const rotate = (by) => {
    const next = (rotation + by + 360) % 360;
    setRotation(next);
    setView(zoom, offset, next);
  };

  const reset = () => {
    setRotation(0);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setAdjust(NEUTRAL);
  };

  // ---- drag and pinch ----
  // Pointer events cover mouse, touch and pen alike. Each new finger restarts the gesture
  // from where the picture is now, so lifting one finger of a pinch does not make it jump.
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    gesture.current = pts.length ? { zoom, offset, mid: midpoint(pts), dist: spread(pts) } : null;
  };
  const onPointerDown = (e) => {
    if (!img || saving) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current || !box) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const start = gesture.current;
    const size = box.clientWidth || 1;
    const mid = midpoint(pts);
    const z = pts.length > 1 && start.dist ? start.zoom * (spread(pts) / start.dist) : start.zoom;
    setView(z, { x: start.offset.x + (mid.x - start.mid.x) / size, y: start.offset.y + (mid.y - start.mid.y) / size });
  };
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    startGesture();
  };

  // A wheel listener has to be non-passive to keep the page behind from scrolling, which
  // React's onWheel is not — so it is attached by hand, and reads the latest view off a ref.
  wheel.current = (dy) => setView(zoom * (dy < 0 ? 1.1 : 1 / 1.1), offset);
  useEffect(() => {
    if (!box) return undefined;
    const onWheel = (e) => { e.preventDefault(); wheel.current?.(e.deltaY); };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [box]);

  const save = async () => {
    if (!img || saving) return;
    try {
      onSave(await renderPhoto(img, { rotation, zoom, offset, adjust }));
    } catch {
      toast.error("Could not prepare the photo — try another image");
    }
  };

  const g = img ? geometry(img, rotation) : null;
  const edited = rotation !== 0 || zoom !== 1 || offset.x !== 0 || offset.y !== 0
    || adjust.brightness !== 100 || adjust.contrast !== 100 || adjust.saturation !== 100;

  return (
    <Dialog open={Boolean(source)} onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100%-1.5rem)] max-w-sm gap-3 overflow-y-auto rounded-2xl p-4 sm:p-5"
        data-testid="photo-editor"
      >
        <DialogHeader className="text-left">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 text-xs">
            <Move className="h-3.5 w-3.5 shrink-0" />
            Drag to position, pinch or scroll to zoom. The circle is your profile picture.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={setBox}
          className={`relative mx-auto aspect-square w-full max-w-[280px] touch-none select-none overflow-hidden rounded-xl bg-slate-900 ${img ? "cursor-grab active:cursor-grabbing" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="photo-editor-canvas"
        >
          {img && g ? (
            <img
              src={source}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none select-none"
              style={{
                left: `${(0.5 + offset.x) * 100}%`,
                top: `${(0.5 + offset.y) * 100}%`,
                width: `${g.w * zoom * 100}%`,
                height: `${g.h * zoom * 100}%`,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                filter: cssFilter(adjust),
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-slate-300">
              {failed ? "This image could not be opened. Choose a JPG, PNG or WEBP photo." : <Loader2 className="h-6 w-6 animate-spin text-slate-400" />}
            </div>
          )}
          {/* Everything outside the circle is dimmed — the part that will not be kept. */}
          <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(15,23,42,0.55)] ring-2 ring-white/80" />
        </div>

        <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} testid="photo-editor-tabs" size="sm" />

        {tab === "crop" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView(zoom / 1.2, offset)}
                disabled={!img || saving}
                className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <Slider
                value={[zoom]}
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                onValueChange={([v]) => setView(v, offset)}
                disabled={!img || saving}
                data-testid="photo-editor-zoom"
              />
              <button
                type="button"
                onClick={() => setView(zoom * 1.2, offset)}
                disabled={!img || saving}
                className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => rotate(-90)}
                disabled={!img || saving}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                data-testid="photo-editor-rotate-left"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Rotate left
              </button>
              <button
                type="button"
                onClick={() => rotate(90)}
                disabled={!img || saving}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                data-testid="photo-editor-rotate-right"
              >
                <RotateCw className="h-3.5 w-3.5" /> Rotate right
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {ADJUSTMENTS.map(({ key, label, icon }) => (
              <SliderRow
                key={key}
                icon={icon}
                label={label}
                value={adjust[key]}
                min={50}
                max={150}
                step={1}
                display={`${adjust[key] - 100 > 0 ? "+" : ""}${adjust[key] - 100}`}
                onChange={(v) => setAdjust((a) => ({ ...a, [key]: v }))}
                testid={`photo-editor-${key}`}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={reset}
            disabled={!edited || saving}
            className="mr-auto text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-40"
            data-testid="photo-editor-reset"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            data-testid="photo-editor-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!img || saving}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            data-testid="photo-editor-save"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Save photo"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PhotoEditor;
