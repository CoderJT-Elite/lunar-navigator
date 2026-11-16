// The Moon as a sphere, lit by the Sun where JPL Horizons puts it. The surface is NASA's LROC colour map (NASA SVS CGI Moon Kit);
// the day/night line is computed from the real Sun vector, so the terminator moves as the time slider moves.
import { vectorsAt } from "./engine.js";

const N = 720, A = 58 * Math.PI / 180;   // pixel size; the camera sits this far south of the equator, on the Earth-facing meridian
const C = [Math.cos(A), 0, -Math.sin(A)], RIGHT = [0, 1, 0], UP = [Math.sin(A), 0, Math.cos(A)];

export function initMoon({ canvas }) {
  canvas.width = N; canvas.height = N;
  const ctx = canvas.getContext("2d"), off = document.createElement("canvas"), octx = off.getContext("2d");
  let tex = null, t = null, busy = false, fast = false, settle = 0;
  const im = new Image();
  im.onload = () => { const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0); tex = { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data }; schedule(); };
  im.src = "data/moon_2k.jpg";
  function schedule() { if (busy || t === null) return; busy = true; requestAnimationFrame(() => { try { draw(); } finally { busy = false; } }); }
  function draw() {
    if (!tex) return;
    const M = fast ? 260 : 560; if (off.width !== M) { off.width = M; off.height = M; }
    const out = octx.createImageData(M, M);
    const v = vectorsAt(t), m = Math.hypot(v[0], v[1], v[2]), S = [v[0] / m, v[1] / m, v[2] / m], d = out.data, R = M / 2 - 3;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const sx = (i + 0.5 - M / 2) / R, sy = (M / 2 - j - 0.5) / R, r2 = sx * sx + sy * sy, o = (j * M + i) * 4;
      if (r2 >= 1.0) { d[o + 3] = 0; continue; }
      const z = Math.sqrt(1 - r2);
      const nx = RIGHT[0] * sx + UP[0] * sy + C[0] * z, ny = RIGHT[1] * sx + UP[1] * sy + C[1] * z, nz = RIGHT[2] * sx + UP[2] * sy + C[2] * z;
      const lat = Math.asin(nz), lon = Math.atan2(ny, nx);
      const u = Math.min(tex.w - 1, Math.floor((lon / Math.PI * 0.5 + 0.5) * tex.w)), w = Math.min(tex.h - 1, Math.floor((0.5 - lat / Math.PI) * tex.h)), k = (w * tex.w + u) * 4;
      const lam = nx * S[0] + ny * S[1] + nz * S[2], day = lam > 0 ? Math.pow(lam, 0.8) : 0, soft = Math.max(0, Math.min(1, (lam + 0.04) / 0.08));
      const lum = (0.05 + 1.12 * day) * (lam > 0 ? 1 : soft * 0.5), edge = Math.min(1, (1 - Math.sqrt(r2)) * R / 1.5);
      d[o] = Math.min(255, tex.d[k] * lum + 3); d[o + 1] = Math.min(255, tex.d[k + 1] * lum + 4); d[o + 2] = Math.min(255, tex.d[k + 2] * lum + 7); d[o + 3] = 255 * edge;
    }
    octx.putImageData(out, 0, 0); ctx.clearRect(0, 0, N, N); ctx.imageSmoothingQuality = "high"; ctx.drawImage(off, 0, 0, N, N);
    // the south pole, where the lower disc is centred
    const px = N / 2, py = N / 2 + (-(UP[2] * -1)) * R * -1;   // screen position of (0,0,-1): x = 0, y = pole . UP
    const poleY = N / 2 - (-1 * UP[2]) * (N / 2 - 6);
    ctx.strokeStyle = "rgba(240,180,0,0.95)"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(px, poleY, 9, 0, 7); ctx.stroke();
  }
  window.addEventListener("poletime", e => { t = e.detail.t; fast = e.detail.fast; schedule(); clearTimeout(settle); if (fast) settle = setTimeout(() => { fast = false; schedule(); }, 220); });
}
