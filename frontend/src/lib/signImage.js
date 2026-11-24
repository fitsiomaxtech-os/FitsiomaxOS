// A photo or scan of a sign on paper -> the sign alone: the ink, trimmed, on nothing. It is
// laid over a dotted line on three different papers, so a white box or a grey photo edge
// around it would show.
//
// Done in the browser, in the sign editor (components/ui/sign-editor.jsx): the sign is found,
// cropped and cleaned by itself (autoSign), the person sees what will print and can change it
// by hand, and the server only ever receives a small PNG drawn here (backend/staff_sign.py
// keeps its limits).

const WORK_MAX = 1200; // the long side the crop is read at
const OUT_W = 900;
const OUT_H = 300;
const MAX_BYTES = 400 * 1024; // the server's own limit
const PAD = 6;

const SIGN_FILE_MAX = 15 * 1024 * 1024;
export const SIGN_FILE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Why a picked file cannot be a sign, or "". */
export const signFileProblem = (file) => {
  if (!SIGN_FILE_TYPES.includes(file?.type)) return "Use a JPG, PNG or WEBP picture.";
  return file.size > SIGN_FILE_MAX ? "The picture must be under 15 MB." : "";
};

// How the ink is read and drawn. `strength`: how faint a mark still counts as ink, -50 to 50.
// `thickness`: how much wider the strokes are drawn, 0 to 3. `color`: the pen's own, or one
// of INK_COLORS. `tidy`: leave out small marks the crop cuts through -- for the auto crop,
// which stands clear of the sign itself; one drawn by hand cuts where the hand put it.
export const PLAIN_LOOK = { strength: 0, thickness: 0, color: "photo", tidy: false };
const INK_COLORS = { black: [17, 17, 17], blue: [22, 48, 140] };

/** A sign the server gave, or "" -- nothing else is ever put in an <img> on a paper. */
export const signSrc = (value) => (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(value || "")) ? value : "");

/**
 * How much of each pixel is ink, 0-255. `data` is RGBA, w x h, already on white.
 *
 * The paper's own brightness is read block by block, so a shadow across a phone photo is
 * paper and not ink: each pixel is judged against the paper around it. `darkAt` says by how
 * much, 0 (paper) to 1.
 */
const alphaOf = (data, w, h, strength) => {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];

  // Paper: the 85th percentile of each block, never darker than half the page's own.
  const size = Math.max(24, Math.round(Math.min(w, h) / 10));
  const cols = Math.ceil(w / size);
  const rows = Math.ceil(h / size);
  const paper = new Float32Array(cols * rows);
  const hist = new Uint32Array(256);
  const percentile = (x0, y0, x1, y1, p) => {
    hist.fill(0);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) hist[Math.min(255, lum[y * w + x] | 0)] += 1;
    let left = (x1 - x0) * (y1 - y0) * (1 - p);
    for (let v = 255; v >= 0; v -= 1) { left -= hist[v]; if (left <= 0) return v; }
    return 0;
  };
  const whole = percentile(0, 0, w, h, 0.85);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const p = percentile(c * size, r * size, Math.min(w, (c + 1) * size), Math.min(h, (r + 1) * size), 0.85);
      paper[r * cols + c] = Math.max(p, whole * 0.5, 1);
    }
  }
  const paperAt = (x, y) => {
    const fx = Math.min(cols - 1, Math.max(0, (x + 0.5) / size - 0.5));
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / size - 0.5));
    const c0 = fx | 0; const r0 = fy | 0;
    const c1 = Math.min(cols - 1, c0 + 1); const r1 = Math.min(rows - 1, r0 + 1);
    const tx = fx - c0; const ty = fy - r0;
    const top = paper[r0 * cols + c0] * (1 - tx) + paper[r0 * cols + c1] * tx;
    const low = paper[r1 * cols + c0] * (1 - tx) + paper[r1 * cols + c1] * tx;
    return top * (1 - ty) + low * ty;
  };
  const darkAt = (x, y) => 1 - lum[y * w + x] / paperAt(x, y);

  const alpha = new Uint8ClampedArray(n);
  const turn = Math.max(-50, Math.min(50, strength));
  const least = 0.14 - turn * 0.0016;
  const span = 0.26 - turn * 0.002;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const t = Math.min(1, Math.max(0, (darkAt(x, y) - least) / span));
      alpha[y * w + x] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  return { alpha, darkAt };
};

const CORE = 90; // ink enough to join one pixel to the next

/** Joined-up ink: which piece each pixel is of, and each piece's size, place, and how much of
 *  it lies along the picture's border. Piece 0 is the paper. */
const piecesOf = (alpha, w, h) => {
  const n = w * h;
  const label = new Int32Array(n);
  const pieces = [null];
  const stack = [];
  for (let start = 0; start < n; start += 1) {
    if (label[start] || alpha[start] < CORE) continue;
    const id = pieces.length;
    const p = { id, area: 0, rim: 0, x0: w, y0: h, x1: -1, y1: -1 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w; const y = (i / w) | 0;
      p.area += 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) p.rim += 1;
      if (x < p.x0) p.x0 = x;
      if (x > p.x1) p.x1 = x;
      if (y < p.y0) p.y0 = y;
      if (y > p.y1) p.y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!label[j] && alpha[j] >= CORE) { label[j] = id; stack.push(j); }
        }
      }
    }
    pieces.push(p);
  }
  return { label, pieces };
};

/**
 * The sign in a crop of a picture, or null with none to find. Specks are dropped by their
 * size beside the sign's largest stroke, and with `tidy` so are small marks the crop cuts.
 *
 * Returns { alpha, color: [r, g, b], box: { x, y, w, h } } and what it read: `cover`, how much
 * of the box is ink; `edge`, how much of the border is; `pieces`, how many strokes; `depth`,
 * how dark they are beside the paper, 0-1; and `stroke`, about how wide, in pixels.
 */
export const inkFromPixels = (data, w, h, strength = 0, tidy = false) => {
  const n = w * h;
  const { alpha, darkAt } = alphaOf(data, w, h, strength);
  const { label, pieces } = piecesOf(alpha, w, h);
  const largest = pieces.reduce((m, p) => Math.max(m, p ? p.area : 0), 0);
  if (largest < 40) return null;
  const speck = Math.max(10, largest * 0.004);
  const keep = pieces.map((p) => !!p && p.area >= speck);
  if (tidy) {
    const total = pieces.reduce((sum, p, id) => sum + (keep[id] ? p.area : 0), 0);
    const clear = pieces.map((p, id) => keep[id] && !(p.rim && p.area < total * 0.25));
    if (clear.some(Boolean)) clear.forEach((v, id) => { keep[id] = v; });
  }

  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  let kept = 0; let rim = 0; let count = 0;
  pieces.forEach((p, id) => {
    if (!keep[id]) return;
    count += 1;
    kept += p.area;
    rim += p.rim;
    minX = Math.min(minX, p.x0);
    maxX = Math.max(maxX, p.x1);
    minY = Math.min(minY, p.y0);
    maxY = Math.max(maxY, p.y1);
  });
  if (maxX < 0 || maxX - minX < 20 || maxY - minY < 6) return null;

  const sum = [0, 0, 0];
  let dark = 0; let depth = 0; let outline = 0;
  const isKept = (x, y) => x >= 0 && y >= 0 && x < w && y < h && keep[label[y * w + x]];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const i = y * w + x;
      if (!keep[label[i]]) continue;
      depth += darkAt(x, y);
      if (!(isKept(x - 1, y) && isKept(x + 1, y) && isKept(x, y - 1) && isKept(x, y + 1))) outline += 1;
      if (alpha[i] > 200) {
        for (let k = 0; k < 3; k += 1) sum[k] += data[i * 4 + k];
        dark += 1;
      }
    }
  }

  // Soft edges belong to a stroke that was kept; a faint mark on its own does not.
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i] || keep[label[i]]) continue;
    let near = false;
    if (!label[i]) {
      const x = i % w; const y = (i / w) | 0;
      for (let dy = -2; dy <= 2 && !near; dy += 1) {
        for (let dx = -2; dx <= 2 && !near; dx += 1) near = isKept(x + dx, y + dy);
      }
    }
    if (!near) alpha[i] = 0;
  }

  // One ink, the pen's own colour, held dark enough to print.
  let color = dark ? sum.map((v) => v / dark) : [20, 28, 60];
  const bright = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
  if (bright > 95) color = color.map((v) => (v * 95) / bright);
  color = color.map((v) => Math.round(v));

  const x = Math.max(0, minX - PAD);
  const y = Math.max(0, minY - PAD);
  const box = { x, y, w: Math.min(w, maxX + 1 + PAD) - x, h: Math.min(h, maxY + 1 + PAD) - y };
  return {
    alpha, color, box, cover: kept / (box.w * box.h), edge: rim / (2 * (w + h)),
    pieces: count, depth: depth / kept, stroke: (2 * kept) / Math.max(1, outline),
  };
};

const wide = (p) => p.x1 - p.x0 + 1;
const tall = (p) => p.y1 - p.y0 + 1;

// A ruled or printed line, a fold, the edge of a sheet: long, with hardly any height.
const isLine = (p) => {
  const long = Math.max(wide(p), tall(p));
  return long >= 60 && Math.min(wide(p), tall(p)) <= Math.max(6, long * 0.045);
};

/**
 * The box round the sign in a whole photo, or null: { x, y, w, h, clear }. The sign is the
 * biggest piece of writing -- the desk, a hand and the sheet's edges run along the picture's
 * border -- and what stands beside it: the dots, the initial, the line under it. Not the
 * sign: a ruled line, a box printed round the space to sign in, and words further off.
 * `clear`: it stands clear of the border. A picture cut close to the sign may not leave it so.
 */
export const signBox = (data, w, h, strength = 0) => {
  const { label, pieces } = piecesOf(alphaOf(data, w, h, strength).alpha, w, h);
  // A printed box: its ink lies along its own four sides.
  const isFrame = (p) => {
    if (wide(p) < 40 || tall(p) < 24) return false;
    const band = Math.max(3, Math.round(Math.min(wide(p), tall(p)) * 0.07));
    let sides = 0;
    for (let y = p.y0; y <= p.y1; y += 1) {
      for (let x = p.x0; x <= p.x1; x += 1) {
        if (label[y * w + x] === p.id && Math.min(x - p.x0, p.x1 - x, y - p.y0, p.y1 - y) < band) sides += 1;
      }
    }
    return sides > p.area * 0.75;
  };
  const real = pieces.filter((p) => p && p.area >= 12);
  // Cut close, the sign itself may touch the border; the desk round a sheet lies all along
  // it. A piece that touches it has to be much the bigger to be taken for the sign.
  const weight = (p) => p.area * (wide(p) + tall(p)) * (p.rim ? 0.15 : 1);
  const near = real.filter((p) => p.rim <= 0.06 * 2 * (w + h));
  const seed = near
    .filter((p) => p.area >= 40 && !isLine(p))
    .sort((a, b) => weight(b) - weight(a)).slice(0, 8).find((p) => !isFrame(p));
  if (!seed) return null;

  const reach = 0.6 * Math.max(tall(seed), wide(seed) * 0.3);
  const tallest = 3 * Math.max(tall(seed), wide(seed) * 0.3);
  const box = { x0: seed.x0, y0: seed.y0, x1: seed.x1, y1: seed.y1 };
  // A picture already cut to the sign: marks at its border are the sign's.
  const cutClose = seed.rim > 0 || wide(seed) > 0.6 * w || tall(seed) > 0.6 * h;
  const rest = new Set(near.filter((p) => p !== seed && (cutClose || !p.rim) && p.area >= Math.max(12, seed.area * 0.004)));
  for (let grew = true; grew;) {
    grew = false;
    // eslint-disable-next-line no-loop-func
    rest.forEach((p) => {
      const gapX = Math.max(0, p.x0 - box.x1, box.x0 - p.x1);
      const gapY = Math.max(0, p.y0 - box.y1, box.y0 - p.y1);
      if (gapX > reach || gapY > reach * 0.7) return;
      if (Math.max(box.y1, p.y1) - Math.min(box.y0, p.y0) + 1 > Math.max(tallest, tall(box))) return;
      if (isLine(p) && Math.max(wide(p), tall(p)) > 1.6 * Math.max(wide(box), tall(box))) return;
      if (isFrame(p)) { rest.delete(p); return; }
      box.x0 = Math.min(box.x0, p.x0);
      box.x1 = Math.max(box.x1, p.x1);
      box.y0 = Math.min(box.y0, p.y0);
      box.y1 = Math.max(box.y1, p.y1);
      rest.delete(p);
      grew = true;
    });
  }
  return wide(box) < 20 || tall(box) < 6 ? null : { x: box.x0, y: box.y0, w: wide(box), h: tall(box), clear: !cutClose };
};

/** Strokes drawn wider by `reach` pixels on every side. */
export const thicken = (alpha, w, h, reach) => {
  if (reach < 1) return alpha;
  const across = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let m = 0;
      for (let k = Math.max(0, x - reach); k <= Math.min(w - 1, x + reach); k += 1) m = Math.max(m, alpha[y * w + k]);
      across[y * w + x] = m;
    }
  }
  const out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let m = 0;
      for (let k = Math.max(0, y - reach); k <= Math.min(h - 1, y + reach); k += 1) m = Math.max(m, across[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
};

// ---- the crop ---------------------------------------------------------------------------
// A rectangle in fractions of the turned picture, so it means the same on the screen's
// small copy and on the full-size photo the sign is cut from.

export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
const OPEN_CROP = { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };
const MIN_CROP = 0.06;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));

/** The crop after its `kind` edge, corner ("nw", "e" ...) or the whole of it ("move") is
 *  dragged by a fraction of the picture. Never off the picture, never shut. */
export const dragCrop = (crop, kind, dx, dy) => {
  if (kind === "move") return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.w), y: clamp(crop.y + dy, 0, 1 - crop.h) };
  let { x, y } = crop;
  let right = crop.x + crop.w;
  let foot = crop.y + crop.h;
  if (kind.includes("w")) x = clamp(x + dx, 0, right - MIN_CROP);
  if (kind.includes("e")) right = clamp(right + dx, Math.min(1, x + MIN_CROP), 1);
  if (kind.includes("n")) y = clamp(y + dy, 0, foot - MIN_CROP);
  if (kind.includes("s")) foot = clamp(foot + dy, Math.min(1, y + MIN_CROP), 1);
  return { x, y, w: right - x, h: foot - y };
};

/** A crop drawn from one point to another, either way round. */
export const drawCrop = (x0, y0, x1, y1) => {
  const w = Math.max(MIN_CROP, Math.abs(clamp(x1, 0, 1) - clamp(x0, 0, 1)));
  const h = Math.max(MIN_CROP, Math.abs(clamp(y1, 0, 1) - clamp(y0, 0, 1)));
  return { x: clamp(Math.min(x0, x1), 0, 1 - w), y: clamp(Math.min(y0, y1), 0, 1 - h), w, h };
};

/** The crop over the same part of the picture once it has made a quarter turn. */
export const turnCrop = (c, clockwise) => (clockwise
  ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
  : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });

// ---- the picture ------------------------------------------------------------------------

const canvasOf = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

/** The colour most of a picture is: the paper's, for the corners a straightened one leaves. */
const paperColor = (img) => {
  const c = canvasOf(24, 24);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 24, 24);
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  px.sort((a, b) => a[0] + a[1] + a[2] - b[0] - b[1] - b[2]);
  return `rgb(${px[Math.floor(px.length * 0.7)].join(", ")})`;
};

/** A picked file, opened: { img, url, paper }. Call closeSignPicture when done with it. */
export const openSignPicture = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const fail = () => { URL.revokeObjectURL(url); reject(new Error("This picture could not be opened. Use a JPG or PNG.")); };
  const img = new Image(); // turns a phone photo the right way up, as drawImage draws it
  img.onload = () => {
    if (!img.naturalWidth || !img.naturalHeight) { fail(); return; }
    try { resolve({ img, url, paper: paperColor(img) }); } catch { fail(); }
  };
  img.onerror = fail;
  img.src = url;
});
export const closeSignPicture = (pic) => { if (pic) URL.revokeObjectURL(pic.url); };

const RAD = Math.PI / 180;

/** The picture's size once turned, in its own pixels. */
export const turnedSize = ({ img }, degrees) => {
  const c = Math.abs(Math.cos(degrees * RAD));
  const s = Math.abs(Math.sin(degrees * RAD));
  return { w: img.naturalWidth * c + img.naturalHeight * s, h: img.naturalWidth * s + img.naturalHeight * c };
};

/** The crop kept over the same spot, and the same size, as the picture is straightened. */
export const tiltCrop = (pic, crop, from, to) => {
  const a = turnedSize(pic, from);
  const b = turnedSize(pic, to);
  const c = Math.cos((to - from) * RAD);
  const s = Math.sin((to - from) * RAD);
  const dx = (crop.x + crop.w / 2 - 0.5) * a.w;
  const dy = (crop.y + crop.h / 2 - 0.5) * a.h;
  const w = clamp((crop.w * a.w) / b.w, MIN_CROP, 1);
  const h = clamp((crop.h * a.h) / b.h, MIN_CROP, 1);
  return {
    x: clamp((dx * c - dy * s) / b.w + 0.5 - w / 2, 0, 1 - w),
    y: clamp((dx * s + dy * c) / b.h + 0.5 - h / 2, 0, 1 - h),
    w, h,
  };
};

/** Draws a crop of the turned picture on a canvas, its long side at most `max`. */
export const drawTurned = (canvas, pic, degrees, crop, max) => {
  const { img, paper } = pic;
  const full = turnedSize(pic, degrees);
  const scale = Math.min(1, max / Math.max(crop.w * full.w, crop.h * full.h));
  canvas.width = Math.max(1, Math.round(crop.w * full.w * scale));
  canvas.height = Math.max(1, Math.round(crop.h * full.h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -crop.x * full.w * scale, -crop.y * full.h * scale);
  ctx.translate(full.w / 2, full.h / 2);
  ctx.rotate(degrees * RAD);
  ctx.fillStyle = "#ffffff"; // a picture with no background is a sign on white paper
  ctx.fillRect(-img.naturalWidth / 2, -img.naturalHeight / 2, img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx;
};

const EDGE_MAX = 0.08; // a sign cut close touches the border here and there, no more
const COVER_MAX = 0.6;

const pixelsOf = (ctx) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);

// ---- auto crop and edit -----------------------------------------------------------------

const TRIES = [0, 25, 50, -25]; // ink strengths, the usual first
const PRINT_W = 220; // the room a sign has on a bill, the smallest of the papers
const PRINT_H = 52;

/** The ink settings a crop prints best with, or null where no sign can be read in it.
 *  `data` is the crop's pixels: a faint sign is read stronger, a grainy photo lighter, and
 *  strokes that would print as a hairline are drawn wider. `tidy` is PLAIN_LOOK's. */
export const lookFromPixels = (data, w, h, tidy = true) => {
  const read = (strength) => {
    const ink = inkFromPixels(data, w, h, strength, tidy);
    return ink && ink.edge <= EDGE_MAX && ink.cover <= COVER_MAX ? ink : null;
  };
  let strength = 0;
  let ink = null;
  TRIES.some((v) => { strength = v; ink = read(v); return ink; });
  if (!ink) return null;
  if (ink.depth < 0.34 && strength >= 0 && strength < 50) {
    const more = read(strength + 25);
    if (more) { ink = more; strength += 25; }
  } else if (ink.pieces > 40 && strength > -25) {
    const less = read(-25);
    if (less && less.pieces < ink.pieces * 0.6) { ink = less; strength = -25; }
  }
  const printed = Math.min(1, PRINT_W / ink.box.w, PRINT_H / ink.box.h);
  const step = 2 * Math.max(1, Math.round(Math.max(w, h) / 600));
  let thickness = 0;
  while (thickness < 2 && (ink.stroke + thickness * step) * printed < 0.95) thickness += 1;
  return { ...PLAIN_LOOK, strength, thickness, tidy };
};

/** What the editor opens on: the sign found in the photo, cropped with a little room round it
 *  and set to print well: { crop, look }. With none found, the whole photo, to do by hand. */
export const autoSign = (pic) => {
  const ctx = drawTurned(canvasOf(1, 1), pic, 0, FULL_CROP, 900);
  const { width, height } = ctx.canvas;
  const { data } = pixelsOf(ctx);
  let box = null;
  TRIES.some((strength) => { box = signBox(data, width, height, strength); return box; });
  if (!box) return { crop: OPEN_CROP, look: PLAIN_LOOK };

  const room = Math.max(8, 0.05 * Math.max(box.w, box.h));
  const span = (from, size, whole) => {
    const want = Math.max(MIN_CROP, Math.min(1, (size + 2 * room) / whole));
    return [clamp((from + size / 2) / whole - want / 2, 0, 1 - want), want];
  };
  const [x, w] = span(box.x, box.w, width);
  const [y, h] = span(box.y, box.h, height);
  const crop = { x, y, w, h };
  const close = drawTurned(canvasOf(1, 1), pic, 0, crop, 700);
  return { crop, look: lookFromPixels(pixelsOf(close).data, close.canvas.width, close.canvas.height, box.clear) || PLAIN_LOOK };
};

/** The photo small, with everything outside the crop dimmed. */
export const drawCropped = (canvas, pic, degrees, crop, max) => {
  const ctx = drawTurned(canvas, pic, degrees, FULL_CROP, max);
  const { width, height } = canvas;
  const [x, y, w, h] = [crop.x * width, crop.y * height, crop.w * width, crop.h * height];
  ctx.fillStyle = "rgba(15, 23, 42, 0.6)";
  ctx.fillRect(0, 0, width, y);
  ctx.fillRect(0, y + h, width, height - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, width - x - w, h);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = Math.max(2, Math.max(width, height) / 150);
  ctx.strokeRect(x, y, w, h);
};

const toPng = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This picture could not be read."))), "image/png");
});

/** The sign in a crop, as the PNG that is saved and printed. Throws with what to do about it. */
export const makeSign = async (pic, degrees, crop, look = PLAIN_LOOK) => {
  const work = canvasOf(1, 1);
  const ctx = drawTurned(work, pic, degrees, crop, WORK_MAX);
  const pixels = pixelsOf(ctx);
  const ink = inkFromPixels(pixels.data, work.width, work.height, look.strength, look.tidy);
  if (!ink) throw new Error("No sign found here. Move the crop over the sign, or make the ink stronger.");
  // The desk or a hand around the paper.
  if (ink.edge > EDGE_MAX) throw new Error("The crop takes in more than the paper. Bring it closer around the sign.");
  if (ink.cover > COVER_MAX) throw new Error("Too dark to read a sign. Make the ink lighter, or use dark ink on plain white paper.");

  const reach = look.thickness * Math.max(1, Math.round(Math.max(work.width, work.height) / 600));
  const alpha = thicken(ink.alpha, work.width, work.height, reach);
  const color = INK_COLORS[look.color] || ink.color;
  for (let i = 0; i < alpha.length; i += 1) {
    [pixels.data[i * 4], pixels.data[i * 4 + 1], pixels.data[i * 4 + 2]] = color;
    pixels.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(pixels, 0, 0);

  const x = Math.max(0, ink.box.x - reach);
  const y = Math.max(0, ink.box.y - reach);
  const w = Math.min(work.width, ink.box.x + ink.box.w + reach) - x;
  const h = Math.min(work.height, ink.box.y + ink.box.h + reach) - y;
  let fit = Math.min(1, OUT_W / w, OUT_H / h);
  for (let i = 0; i < 4; i += 1) {
    const out = canvasOf(w * fit, h * fit);
    const o = out.getContext("2d");
    o.imageSmoothingQuality = "high";
    o.drawImage(work, x, y, w, h, 0, 0, out.width, out.height);
    // eslint-disable-next-line no-await-in-loop
    const blob = await toPng(out);
    if (blob.size <= MAX_BYTES) return blob;
    fit *= 0.7;
  }
  throw new Error("This picture could not be made small enough. Crop it closer to the sign.");
};
