// A photo or scan of a sign on paper -> the sign alone: the ink, trimmed, on nothing. It is
// laid over a dotted line on three different papers, so a white box or a grey photo edge
// around it would show.
//
// Done in the browser: the person sees what will print before it is saved, and the server
// only ever receives a small PNG drawn here (backend/staff_sign.py keeps its limits).

const WORK_MAX = 1400; // the long side the picture is read at
const OUT_W = 900;
const OUT_H = 300;
const MAX_BYTES = 400 * 1024; // the server's own limit
const PAD = 6;

export const SIGN_FILE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const SIGN_FILE_MAX = 15 * 1024 * 1024;

/** A sign the server gave, or "" -- nothing else is ever put in an <img> on a paper. */
export const signSrc = (value) => (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(value || "")) ? value : "");

/**
 * The ink in a picture. `data` is RGBA, w x h, already on white.
 *
 * The paper's own brightness is read block by block, so a shadow across a phone photo is
 * paper and not ink: each pixel is judged against the paper around it. Specks are dropped
 * by their size beside the sign's largest stroke.
 *
 * Returns { alpha, color: [r, g, b], box: { x, y, w, h }, cover, edge }, or null with no sign
 * to find. `cover` is how much of the box is ink, `edge` how much of the picture's border is.
 */
export const inkFromPixels = (data, w, h) => {
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

  const alpha = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const t = Math.min(1, Math.max(0, (1 - lum[i] / paperAt(x, y) - 0.14) / 0.26));
      alpha[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }

  // Joined-up ink, so a speck is one small piece whatever it is near.
  const CORE = 90;
  const label = new Int32Array(n);
  const areas = [0];
  const stack = [];
  for (let s = 0; s < n; s += 1) {
    if (label[s] || alpha[s] < CORE) continue;
    const id = areas.length;
    let area = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      area += 1;
      const x = i % w; const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!label[j] && alpha[j] >= CORE) { label[j] = id; stack.push(j); }
        }
      }
    }
    areas.push(area);
  }
  const largest = areas.reduce((m, a) => Math.max(m, a), 0);
  if (largest < 40) return null;
  const least = Math.max(10, largest * 0.004);

  let minX = w; let minY = h; let maxX = -1; let maxY = -1; let kept = 0;
  const sum = [0, 0, 0];
  let dark = 0;
  let rim = 0;
  for (let i = 0; i < n; i += 1) {
    if (!label[i] || areas[label[i]] < least) continue;
    kept += 1;
    const x = i % w; const y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) rim += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (alpha[i] > 200) {
      for (let k = 0; k < 3; k += 1) sum[k] += data[i * 4 + k];
      dark += 1;
    }
  }
  if (maxX < 0 || maxX - minX < 20 || maxY - minY < 6) return null;

  // Soft edges belong to a stroke that was kept; a faint mark on its own does not.
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i] || (label[i] && areas[label[i]] >= least)) continue;
    let near = false;
    if (!label[i]) {
      const x = i % w; const y = (i / w) | 0;
      for (let dy = -2; dy <= 2 && !near; dy += 1) {
        for (let dx = -2; dx <= 2 && !near; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const l = label[ny * w + nx];
          near = l > 0 && areas[l] >= least;
        }
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
  return { alpha, color, box, cover: kept / (box.w * box.h), edge: rim / (2 * (w + h)) };
};

const loadFile = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image(); // turns a phone photo the right way up, as drawImage draws it
  img.onload = () => resolve({ img, url });
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This picture could not be opened. Use a JPG or PNG.")); };
  img.src = url;
});

const canvasOf = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

const toPng = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This picture could not be read."))), "image/png");
});

/** The sign in a picked file, as a PNG: { blob, url }. Throws with what to do about it. */
export const signFromFile = async (file) => {
  if (!SIGN_FILE_TYPES.includes(file.type)) throw new Error("Use a JPG, PNG or WEBP picture.");
  if (file.size > SIGN_FILE_MAX) throw new Error("The picture must be under 15 MB.");
  const { img, url } = await loadFile(file);
  try {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) throw new Error("This picture could not be opened. Use a JPG or PNG.");
    const scale = Math.min(1, WORK_MAX / Math.max(iw, ih));
    const work = canvasOf(iw * scale, ih * scale);
    const ctx = work.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff"; // a picture with no background is a sign on white paper
    ctx.fillRect(0, 0, work.width, work.height);
    ctx.drawImage(img, 0, 0, work.width, work.height);
    const pixels = ctx.getImageData(0, 0, work.width, work.height);
    const ink = inkFromPixels(pixels.data, work.width, work.height);
    if (!ink) throw new Error("No sign found in this picture. Use dark ink on plain white paper.");
    // The desk or a hand around the paper: a sign cut close touches the border here and there.
    if (ink.edge > 0.08) throw new Error("The picture shows more than the paper. Crop it to the sign and upload again.");
    if (ink.cover > 0.6) throw new Error("This picture is too dark to read a sign from. Use dark ink on plain white paper.");

    for (let i = 0; i < ink.alpha.length; i += 1) {
      [pixels.data[i * 4], pixels.data[i * 4 + 1], pixels.data[i * 4 + 2]] = ink.color;
      pixels.data[i * 4 + 3] = ink.alpha[i];
    }
    ctx.putImageData(pixels, 0, 0);

    const { box } = ink;
    let fit = Math.min(1, OUT_W / box.w, OUT_H / box.h);
    let blob = null;
    for (let i = 0; i < 4; i += 1) {
      const out = canvasOf(box.w * fit, box.h * fit);
      const o = out.getContext("2d");
      o.imageSmoothingQuality = "high";
      o.drawImage(work, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
      // eslint-disable-next-line no-await-in-loop
      blob = await toPng(out);
      if (blob.size <= MAX_BYTES) break;
      fit *= 0.7;
    }
    if (blob.size > MAX_BYTES) throw new Error("This picture could not be made small enough. Crop it to the sign and try again.");
    return { blob, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
};
