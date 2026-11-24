import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, CheckCircle2, Crop, Loader2, RotateCcw, RotateCw, Signature, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Slider } from "@/components/ui/slider";
import { toast } from "@/components/ui/sonner";
import {
  FULL_CROP, PLAIN_LOOK, SIGN_FILE_TYPES,
  autoSign, closeSignPicture, dragCrop, drawCrop, drawCropped, drawTurned, makeSign, openSignPicture, signFileProblem,
  tiltCrop, turnCrop, turnedSize,
} from "@/lib/signImage";

/**
 * How a sign is added, for oneself (My Profile > Sign Upload) and for a branch's people (Admin
 * Setting > Digital Sign):
 *
 *     Upload        a photo or scan is picked; nothing is saved off the picker
 *     Auto          the sign is found, cropped and cleaned by itself (lib/signImage's autoSign)
 *     Manual Edit   only if the auto one is not right: Crop & Rotate, by the crop's corners or
 *                   by drawing a new one over the photo, and Edit, for the ink
 *     Confirm       saves the sign exactly as "How it will print" shows it
 */

const STAGE_H = 240;
const SIDE_ROOM = 84; // a side's handle is left out where it would sit on the corners'
const TABS = [
  { key: "crop", label: "Crop & Rotate", icon: Crop },
  { key: "edit", label: "Edit", icon: SlidersHorizontal },
];
const COLORS = [
  { key: "photo", label: "As in photo" },
  { key: "black", label: "Black" },
  { key: "blue", label: "Blue" },
];
// The crop's corners and sides: a finger-sized target round a small mark.
const HANDLES = [
  { kind: "nw", at: "-left-3.5 -top-3.5 cursor-nwse-resize", mark: "h-3 w-3" },
  { kind: "ne", at: "-right-3.5 -top-3.5 cursor-nesw-resize", mark: "h-3 w-3" },
  { kind: "sw", at: "-bottom-3.5 -left-3.5 cursor-nesw-resize", mark: "h-3 w-3" },
  { kind: "se", at: "-bottom-3.5 -right-3.5 cursor-nwse-resize", mark: "h-3 w-3" },
  { kind: "n", at: "-top-3.5 left-1/2 -translate-x-1/2 cursor-ns-resize", mark: "h-1.5 w-5" },
  { kind: "s", at: "-bottom-3.5 left-1/2 -translate-x-1/2 cursor-ns-resize", mark: "h-1.5 w-5" },
  { kind: "w", at: "-left-3.5 top-1/2 -translate-y-1/2 cursor-ew-resize", mark: "h-5 w-1.5" },
  { kind: "e", at: "-right-3.5 top-1/2 -translate-y-1/2 cursor-ew-resize", mark: "h-5 w-1.5" },
];

/** The photo as it was picked, with what the crop leaves out dimmed. */
const PhotoThumb = ({ pic, degrees, crop }) => {
  const [canvas, setCanvas] = useState(null);
  useEffect(() => {
    if (pic && canvas) drawCropped(canvas, pic, degrees, crop, 600);
  }, [pic, canvas, degrees, crop]);
  return <canvas ref={setCanvas} className="h-full w-full object-contain" data-testid="sign-editor-photo" />;
};

/** A sign on its dotted line, white behind it on every theme, as the paper is. */
export const SignPaper = ({ image, busy = false, children, testid = "sign-paper" }) => (
  <div className="relative flex h-32 flex-col justify-end rounded-[4px] border border-slate-200 bg-[#fff] px-4 pb-3" data-testid={testid}>
    {image ? (
      <div className={`text-center transition-opacity ${busy ? "opacity-40" : ""}`}>
        <img src={image} alt="Sign" className="inline-block max-h-[72px] max-w-full" data-testid={`${testid}-image`} />
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center px-2 text-center text-xs text-[#64748b]">
        {busy ? <Loader2 className="h-5 w-5 animate-spin text-sky-600" /> : children}
      </div>
    )}
    <div className="mx-auto mt-1 w-52 max-w-full border-t-2 border-dotted border-[#525252] pt-1 text-center text-[11px] text-[#525252]">Signature</div>
    {image && busy && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-sky-600" />}
  </div>
);

/** Delete Sign, as a bin alone: asks once, then `onDelete`. `whose`: "Your" or "Asha's". */
export const SignDelete = ({ whose, onDelete, disabled = false, testid = "sign-delete" }) => {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await onDelete();
      toast.success("Sign deleted");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete the sign");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={disabled || busy}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:border-slate-200 disabled:text-slate-300"
        title="Delete Sign"
        aria-label="Delete Sign"
        data-testid={testid}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-[4px] p-5 sm:rounded-[4px]" data-testid={`${testid}-confirm`}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-slate-800">Delete this sign?</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] text-slate-500">
              {whose} sign will come off every bill, form and prescription, old ones too. A new sign can be uploaded at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-end gap-2 sm:space-x-0">
            <AlertDialogCancel className="mt-0 h-9 rounded-[4px]" data-testid={`${testid}-cancel`}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="h-9 rounded-[4px] bg-rose-600 text-white hover:bg-rose-700" data-testid={`${testid}-yes`}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const SliderRow = ({ label, low, high, value, min, max, step, onChange, disabled, testid }) => (
  <div>
    <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600">
      <span>{label}</span>
      <span className="text-[11px] text-slate-400">{low} – {high}</span>
    </div>
    <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} disabled={disabled} data-testid={testid} />
  </div>
);

const toolBtn = "flex h-9 items-center justify-center gap-1.5 rounded-[4px] border border-slate-200 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40";

/** `file`: the picked picture, or null while shut. `onSave` receives the finished PNG. */
export const SignEditor = ({ file, title = "Sign", saving = false, onCancel, onAnother, onSave }) => {
  const [pic, setPic] = useState(null);
  const [failed, setFailed] = useState("");
  const [turn, setTurn] = useState(0); // quarter turns, in degrees
  const [tilt, setTilt] = useState(0); // straightening, in degrees
  const [crop, setCrop] = useState(FULL_CROP);
  const [look, setLook] = useState(PLAIN_LOOK);
  const [auto, setAuto] = useState(null); // { crop, look }: what was done by itself
  const [manual, setManual] = useState(false); // the tools, rather than the auto result
  const [tab, setTab] = useState("crop");
  const [made, setMade] = useState(null); // { blob, url } | { error }
  const [working, setWorking] = useState(true);
  const [frame, setFrame] = useState(null); // the dark area the picture sits in
  const [room, setRoom] = useState(0); // its width, inside its padding
  const [canvas, setCanvas] = useState(null);
  const stage = useRef(null);
  const drag = useRef(null);
  const atOnce = useRef(true); // the first reading of a photo waits for nothing

  useEffect(() => {
    setPic(null);
    setFailed("");
    setMade(null);
    setWorking(true);
    setTurn(0);
    setTilt(0);
    setLook(PLAIN_LOOK);
    setAuto(null);
    setManual(false);
    setTab("crop");
    drag.current = null;
    atOnce.current = true;
    if (!file) return undefined;
    let live = true;
    let opened = null;
    openSignPicture(file)
      .then((p) => {
        if (!live) { closeSignPicture(p); return; }
        opened = p;
        const done = autoSign(p);
        setAuto(done);
        setCrop(done.crop);
        setLook(done.look);
        setPic(p);
      })
      .catch((e) => { if (live) setFailed(e?.message || "This picture could not be opened."); });
    return () => { live = false; closeSignPicture(opened); };
  }, [file]);

  const degrees = turn + tilt;

  useEffect(() => {
    if (pic && canvas) drawTurned(canvas, pic, degrees, FULL_CROP, 1000);
  }, [pic, canvas, degrees]);

  useEffect(() => {
    if (!frame) return undefined;
    const measure = () => {
      const css = window.getComputedStyle(frame);
      setRoom(Math.max(0, frame.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0)));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(frame);
    return () => watch.disconnect();
  }, [frame]);

  // Read once a drag or a slider pauses; what is on screen meanwhile is the last one, dimmed.
  useEffect(() => {
    if (!pic) return undefined;
    let live = true;
    setWorking(true);
    const pause = atOnce.current ? 0 : 250;
    atOnce.current = false;
    const t = setTimeout(async () => {
      let next;
      try {
        const blob = await makeSign(pic, degrees, crop, look);
        next = { blob, url: live ? URL.createObjectURL(blob) : "" };
      } catch (e) {
        next = { error: e?.message || "This picture could not be read." };
      }
      if (!live) { if (next.url) URL.revokeObjectURL(next.url); return; }
      setMade(next);
      setWorking(false);
    }, pause);
    return () => { live = false; clearTimeout(t); };
  }, [pic, degrees, crop, look]);

  const madeUrl = made?.url;
  useEffect(() => (madeUrl ? () => URL.revokeObjectURL(madeUrl) : undefined), [madeUrl]);

  useEffect(() => {
    if (!file) return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, saving, onCancel]);

  if (!file) return null;

  const rotate = (clockwise) => {
    setTurn((d) => d + (clockwise ? 90 : -90));
    setCrop((c) => turnCrop(c, clockwise));
  };
  const straighten = (next) => {
    setCrop((c) => tiltCrop(pic, c, degrees, turn + next));
    setTilt(next);
  };
  // A crop placed by hand keeps everything it is put round.
  const cropByHand = (next) => {
    setCrop(next);
    setLook((l) => (l.tidy ? { ...l, tidy: false } : l));
  };
  const backToAuto = () => {
    setTurn(0);
    setTilt(0);
    setCrop(auto.crop);
    setLook(auto.look);
    setTab("crop");
    setManual(false);
  };

  const grab = (kind) => ({
    onPointerDown: (e) => {
      if (!stage.current || saving) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const r = stage.current.getBoundingClientRect();
      drag.current = { kind, id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width || 1, h: r.height || 1, crop };
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || d.kind !== kind || d.id !== e.pointerId) return;
      e.stopPropagation();
      const dx = (e.clientX - d.x) / d.w;
      const dy = (e.clientY - d.y) / d.h;
      if (kind !== "new") { cropByHand(dragCrop(d.crop, kind, dx, dy)); return; }
      // A tap on the photo is not a crop.
      if (Math.abs(dx) < 0.015 && Math.abs(dy) < 0.015) return;
      const x = (d.x - d.left) / d.w;
      const y = (d.y - d.top) / d.h;
      cropByHand(drawCrop(x, y, x + dx, y + dy));
    },
    onPointerUp: () => { drag.current = null; },
    onPointerCancel: () => { drag.current = null; },
  });

  const full = pic ? turnedSize(pic, degrees) : null;
  const fit = full && room ? Math.min(room / full.w, STAGE_H / full.h) : 0;
  const size = fit ? { width: full.w * fit, height: full.h * fit } : { width: 0, height: 0 };
  const place = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` };
  const handles = HANDLES.filter(({ kind }) => kind.length === 2
    || ("ns".includes(kind) ? crop.w * size.width : crop.h * size.height) >= SIDE_ROOM);
  const locked = !pic || saving;
  const reading = !failed && (!pic || working);
  const unread = !!failed || (!reading && !!made?.error);

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-3" role="dialog" aria-modal="true" aria-label="Check the sign" data-testid="sign-editor">
      <div className="flex max-h-[94vh] w-full max-w-lg flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-700 bg-[#0284C7] px-4 py-3">
          <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">
            <Signature className="h-4 w-4 shrink-0" />
            <span className="truncate">{title}</span>
          </p>
          <button type="button" onClick={onCancel} disabled={saving} className="shrink-0 rounded-[4px] p-1 text-white/90 hover:bg-white/15 hover:text-white" aria-label="Close" data-testid="sign-editor-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!manual ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="sign-editor-auto">
          <p className={`flex items-center gap-1.5 text-sm font-semibold ${unread ? "text-amber-700" : reading ? "text-slate-500" : "text-emerald-700"}`} role="status" data-testid="sign-editor-status">
            {unread ? <AlertCircle className="h-4 w-4 shrink-0" /> : reading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
            {failed || (unread ? "The sign could not be read by itself" : reading ? "Auto crop and edit…" : "Auto crop and edit done")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1.5 text-xs font-medium text-slate-600">Your photo</p>
              <div className="flex h-32 items-center justify-center rounded-[4px] bg-[#0f172a] p-2">
                {pic ? <PhotoThumb pic={pic} degrees={degrees} crop={crop} /> : failed ? null : <Loader2 className="h-5 w-5 animate-spin text-[#94a3b8]" />}
              </div>
            </div>
            <div className="min-w-0">
              <p className="mb-1.5 text-xs font-medium text-slate-600">How it will print</p>
              <SignPaper image={made?.url} busy={reading} testid="sign-editor-preview">
                <span className="text-[#b45309]">{failed ? "Choose another photo." : "Use Manual Edit, or choose another photo."}</span>
              </SignPaper>
            </div>
          </div>
        </div>
        ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="sign-editor-manual">
          <div ref={setFrame} className="flex min-h-[200px] items-center justify-center rounded-[4px] bg-[#0f172a] p-5" data-testid="sign-editor-frame">
            {!pic ? (
              <Loader2 className="h-6 w-6 animate-spin text-[#94a3b8]" />
            ) : (
              <div ref={stage} className="relative cursor-crosshair touch-none select-none" style={size} {...grab("new")} data-testid="sign-editor-stage">
                <canvas ref={setCanvas} className="block h-full w-full" />
                {/* Everything outside the crop is dimmed: the part that will not be kept. */}
                <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div className="absolute shadow-[0_0_0_9999px_rgba(15,23,42,0.6)]" style={place} />
                </div>
                <div className="absolute cursor-move touch-none border-2 border-[#38bdf8]" style={place} {...grab("move")} data-testid="sign-editor-crop">
                  {handles.map(({ kind, at, mark }) => (
                    <span key={kind} className={`absolute flex h-7 w-7 touch-none items-center justify-center ${at}`} {...grab(kind)} data-testid={`sign-editor-handle-${kind}`}>
                      <span className={`block rounded-[2px] border border-[#0284C7] bg-[#fff] ${mark}`} />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-[4px] border border-slate-200 bg-slate-50 p-1" role="tablist" data-testid="sign-editor-tabs">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex h-8 items-center justify-center gap-1.5 rounded-[4px] text-xs font-semibold transition ${tab === key ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-white"}`}
                data-testid={`sign-editor-tab-${key}`}
              >
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>

          {tab === "crop" ? (
            <div className="space-y-3" data-testid="sign-editor-crop-tools">
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => rotate(false)} disabled={locked} className={toolBtn} data-testid="sign-editor-rotate-left"><RotateCcw className="h-3.5 w-3.5" />Rotate left</button>
                <button type="button" onClick={() => rotate(true)} disabled={locked} className={toolBtn} data-testid="sign-editor-rotate-right"><RotateCw className="h-3.5 w-3.5" />Rotate right</button>
              </div>
              <SliderRow label={`Straighten${tilt ? ` ${tilt > 0 ? "+" : ""}${tilt}°` : ""}`} low="Left" high="Right" value={tilt} min={-30} max={30} step={1} onChange={straighten} disabled={locked} testid="sign-editor-straighten" />
            </div>
          ) : (
            <div className="space-y-3" data-testid="sign-editor-edit-tools">
              <SliderRow label="Ink" low="Light" high="Dark" value={look.strength} min={-50} max={50} step={5} onChange={(strength) => setLook((l) => ({ ...l, strength }))} disabled={locked} testid="sign-editor-ink" />
              <SliderRow label="Thickness" low="Thin" high="Bold" value={look.thickness} min={0} max={3} step={1} onChange={(thickness) => setLook((l) => ({ ...l, thickness }))} disabled={locked} testid="sign-editor-thickness" />
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Ink colour">
                {COLORS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLook((l) => ({ ...l, color: key }))}
                    disabled={locked}
                    aria-pressed={look.color === key}
                    className={`${toolBtn} ${look.color === key ? "border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-50" : ""}`}
                    data-testid={`sign-editor-color-${key}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-600">How it will print</p>
            <SignPaper image={made?.url} busy={reading} testid="sign-editor-preview">
              <span className="text-[#b91c1c]">{made?.error}</span>
            </SignPaper>
          </div>
        </div>
        )}

        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap border-t border-slate-100 px-4 py-3 sm:gap-3">
          <button type="button" onClick={onAnother} disabled={saving} className="mr-auto text-xs font-semibold text-sky-700 hover:underline disabled:opacity-40" aria-label="Choose another photo" data-testid="sign-editor-another"><span className="sm:hidden">Change</span><span className="hidden sm:inline">Choose another</span></button>
          {manual ? (
            <button type="button" onClick={backToAuto} disabled={locked} className={`${toolBtn} px-3`} data-testid="sign-editor-back-to-auto"><Sparkles className="h-3.5 w-3.5" />Auto</button>
          ) : (
            <button type="button" onClick={() => setManual(true)} disabled={locked} className={`${toolBtn} px-3 ${unread && pic ? "border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-50" : ""}`} data-testid="sign-editor-manual-edit"><SlidersHorizontal className="h-3.5 w-3.5" />Manual Edit</button>
          )}
          <button
            type="button"
            onClick={() => { if (made?.blob) onSave(made.blob); }}
            disabled={locked || working || !made?.blob}
            className="flex h-9 items-center gap-1.5 rounded-[4px] bg-sky-600 px-4 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50 sm:px-5"
            data-testid="sign-editor-confirm"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{saving ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/**
 * Upload -> auto crop and edit -> (Manual Edit) -> Confirm. `send(blob, target)` saves it; the
 * editor stays open if that fails. Draw `elements` once; `pick(target, title)` opens the file
 * picker.
 */
export const useSignUpload = (send) => {
  const inputRef = useRef(null);
  const next = useRef({ target: null, title: "" });
  const [job, setJob] = useState(null); // { file, target, title }
  const [saving, setSaving] = useState(false);

  const pick = (target = null, title = "Sign") => {
    next.current = { target, title };
    inputRef.current?.click();
  };
  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be picked again
    if (!file) return;
    const problem = signFileProblem(file);
    if (problem) { toast.error(problem); return; }
    setJob({ file, ...next.current });
  };
  const confirm = async (blob) => {
    setSaving(true);
    try {
      await send(blob, job.target);
      setJob(null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the sign");
    } finally {
      setSaving(false);
    }
  };

  return {
    pick,
    elements: (
      <>
        <input ref={inputRef} type="file" accept={SIGN_FILE_TYPES.join(",")} onChange={onFile} className="hidden" data-testid="sign-upload-file" />
        <SignEditor
          file={job?.file || null}
          title={job?.title}
          saving={saving}
          onCancel={() => setJob(null)}
          onAnother={() => pick(job?.target, job?.title)}
          onSave={confirm}
        />
      </>
    ),
  };
};
