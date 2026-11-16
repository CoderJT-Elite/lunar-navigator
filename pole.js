// The opening object: the Moon's south pole seen from above, lit by the Sun where JPL Horizons says it is.
// Terrain is NASA LRO/LOLA (240 m). Every shadow is cast by marching a ray from each ground point toward the Sun
// through the elevation map, so a ridge shades what is really behind it. Nothing here is a texture or an effect.
import { vectorsAt, skyAt, maskAt, R_MOON } from "./engine.js";

const DEG = Math.PI / 180, R = R_MOON * 1000, BASE = 1737400, HALF = 100000;   // 100 km from the pole to the rim of the disc (the extent of the relief image)
const DAY = 86400000, HOUR = 3600000, SPAN_H = 720;                            // slider: 30 days, hourly (about one lunar day)

const rgbCache = new Map();
function rgb(token) {
  if (!rgbCache.has(token)) {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-" + token).trim(); g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; rgbCache.set(token, [d[0], d[1], d[2]]);
  }
  return rgbCache.get(token);
}
const css = (token, a = 1) => { const c = rgb(token); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

function pAt(x, y) { const q = (x * x + y * y) / (4 * R * R), k = 1 / (R * (q + 1)); return [y * k, x * k, (q - 1) / (q + 1)]; }
const unit = v => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

// Per-pixel ground point, surface normal and height for one grid size; built once, reused for every frame.
const grids = new Map();
let RELIEF = null;   // LRO hillshade image (grey), 200 km square, same orientation as the map
function gridFor(T, G) {
  if (grids.has(G)) return grids.get(G);
  const cell = 2 * HALF / G, n = G * G;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), H = new Float32Array(n), HS = new Float32Array(n), M = new Uint8Array(n), d = cell / 2;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = (i + 0.5 - G / 2) * cell, y = (G / 2 - j - 0.5) * cell, o = j * G + i;
    if (x * x + y * y > HALF * HALF) continue;
    const h = T.heightAtXY(x, y); if (Number.isNaN(h)) continue;
    const gx = (T.heightAtXY(x + d, y) - T.heightAtXY(x - d, y)) / cell || 0, gy = (T.heightAtXY(x, y + d) - T.heightAtXY(x, y - d)) / cell || 0;
    const p = pAt(x, y), a = pAt(x + d, y), b = pAt(x - d, y), c = pAt(x, y + d), e = pAt(x, y - d);
    const tx = unit([a[0] - b[0], a[1] - b[1], a[2] - b[2]]), ty = unit([c[0] - e[0], c[1] - e[1], c[2] - e[2]]);
    const nr = unit([p[0] - gx * tx[0] - gy * ty[0], p[1] - gx * tx[1] - gy * ty[1], p[2] - gx * tx[2] - gy * ty[2]]);
    const r = BASE + h; P[o * 3] = p[0] * r; P[o * 3 + 1] = p[1] * r; P[o * 3 + 2] = p[2] * r;
    N[o * 3] = nr[0]; N[o * 3 + 1] = nr[1]; N[o * 3 + 2] = nr[2]; H[o] = h; M[o] = 1;
    // Surface texture: the same terrain lit from a fixed, higher angle, which is what makes craters read as craters.
    const h0 = [1, 0.35, 0], hd = h0[0] * p[0] + h0[1] * p[1] + h0[2] * p[2], hh = unit([h0[0] - hd * p[0], h0[1] - hd * p[1], h0[2] - hd * p[2]]), se = Math.sin(38 * DEG), ce = Math.cos(38 * DEG);
    const raw = (nr[0] * (p[0] * se + hh[0] * ce) + nr[1] * (p[1] * se + hh[1] * ce) + nr[2] * (p[2] * se + hh[2] * ce)); HS[o] = Math.max(0, Math.min(1, 0.55 + 3.4 * (raw - se)));
    if (RELIEF) { const u = Math.min(RELIEF.w - 1, Math.max(0, Math.floor((x + HALF) / (2 * HALF) * RELIEF.w))), v = Math.min(RELIEF.h - 1, Math.max(0, Math.floor((HALF - y) / (2 * HALF) * RELIEF.h))); HS[o] = RELIEF.d[(v * RELIEF.w + u) * 4] / 255; }
  }
  const g = { G, cell, P, N, H, M, HS }; grids.set(G, g); return g;
}

function shade(T, g, S, out) {
  const { G, P, N, H, M, HS } = g, lit = rgb("lit"), hot = rgb("lit-hot"), dk = rgb("shade"), amb = rgb("shade-2"), bg = rgb("space");
  const sx = S[0], sy = S[1], sz = S[2], d = out.data;
  for (let o = 0; o < G * G; o++) {
    const q = o * 4;
    if (!M[o]) { d[q] = bg[0]; d[q + 1] = bg[1]; d[q + 2] = bg[2]; d[q + 3] = 255; continue; }
    const nd = N[o * 3] * sx + N[o * 3 + 1] * sy + N[o * 3 + 2] * sz;
    let shadowed = nd <= 0;
    if (!shadowed) {
      const px = P[o * 3], py = P[o * 3 + 1], pz = P[o * 3 + 2];
      let s = 420;
      for (;;) {
        const x = px + s * sx, y = py + s * sy, z = pz + s * sz, r = Math.sqrt(x * x + y * y + z * z), alt = r - BASE;
        if (alt > 11000 || s > 420000) break;
        const k = 2 * R / (1 - z / r), hh = T.heightAtXY(k * y / r, k * x / r);
        if (Number.isNaN(hh)) break;
        if (hh > alt) { shadowed = true; break; }
        s += 260 + s * 0.035;
      }
    }
    let r, gg, b;
    const tex = 0.34 + 0.66 * HS[o];                    // regolith brightness from the terrain's own shape
    if (shadowed) {
      const t = Math.max(0, Math.min(1, (H[o] + 6000) / 14000)) * 0.5;  // faint earthshine: the dark side still shows its craters
      const e = 0.3 * tex + t * 0.05;
      r = dk[0] + amb[0] * e * 1.6; gg = dk[1] + amb[1] * e * 1.7; b = dk[2] + amb[2] * e * 2.1;
    } else {
      const v = Math.min(1, nd / 0.07), br = tex * (0.72 + 0.28 * v), hotT = Math.min(1, v * 0.3);
      r = (lit[0] + (hot[0] - lit[0]) * hotT) * br * 0.98; gg = (lit[1] + (hot[1] - lit[1]) * hotT) * br * 0.98; b = (lit[2] + (hot[2] - lit[2]) * hotT) * br * 0.96;
    }
    d[q] = r; d[q + 1] = gg; d[q + 2] = b; d[q + 3] = 255;
  }
}

export function initPole({ canvas, slider, clock, play, read, getTerrain, getSites, onStatus }) {
  const ctx = canvas.getContext("2d"), off = document.createElement("canvas"), offCtx = off.getContext("2d");
  let T = null, base = Date.UTC(2027, 5, 1), hour = SPAN_H / 2, busy = false, queued = false, fast = false, settle = 0, playing = false, last = 0, raf = 0;
  const FONT = "'Albert Sans', system-ui, sans-serif";
  const fmt = t => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
  const timeNow = () => base - SPAN_H / 2 * HOUR + hour * HOUR;

  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), w = Math.max(240, Math.round(r.width * dpr));
    if (canvas.width !== w) { canvas.width = w; canvas.height = w; }
    return { w, scale: w / Math.max(1, r.width) };
  }
  function draw() {
    const { w, scale } = size(), t = timeNow(), v = vectorsAt(t), S = unit([v[0], v[1], v[2]]), E = unit([v[3], v[4], v[5]]);
    ctx.fillStyle = css("space"); ctx.fillRect(0, 0, w, w);
    const cx = w / 2, rad = w * 0.5 - 4 * scale;
    if (T) {
      const G = 300, g = gridFor(T, G);
      if (off.width !== G) { off.width = G; off.height = G; }
      const img = offCtx.createImageData(G, G); shade(T, g, S, img); offCtx.putImageData(img, 0, 0);
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cx, rad, 0, 7); ctx.clip(); ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, cx - rad, cx - rad, rad * 2, rad * 2); ctx.restore();
    } else {
      ctx.fillStyle = css("space-muted"); ctx.font = `${15 * scale}px ${FONT}`; ctx.textAlign = "center"; ctx.fillText("Loading NASA terrain (5 MB)…", cx, cx);
    }
    // rim, scale rings, pole, and where the Sun and Earth stand
    ctx.lineWidth = scale; ctx.strokeStyle = css("space-muted", 0.5); ctx.beginPath(); ctx.arc(cx, cx, rad, 0, 7); ctx.stroke();
    ctx.strokeStyle = css("space-ink", 0.16); ctx.setLineDash([2 * scale, 6 * scale]);
    for (const km of [50]) { ctx.beginPath(); ctx.arc(cx, cx, rad * km / 100, 0, 7); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = css("space-ink", 0.55); ctx.font = `${12 * scale}px ${FONT}`; ctx.textAlign = "left";
    ctx.fillText("50 km", cx + rad / 2 + 5 * scale, cx - 5 * scale); ctx.fillText("100 km", cx + rad - 52 * scale, cx - 5 * scale);
    ctx.strokeStyle = css("space-ink", 0.7); ctx.beginPath(); ctx.moveTo(cx - 6 * scale, cx); ctx.lineTo(cx + 6 * scale, cx); ctx.moveTo(cx, cx - 6 * scale); ctx.lineTo(cx, cx + 6 * scale); ctx.stroke();
    const tick = (dx, dy, color, label) => {   // map direction of a body: horizontal part of its direction (map +x = ME y, +y = ME x)
      const a = Math.hypot(dx, dy) || 1, ux = dx / a, uy = -dy / a;
      ctx.strokeStyle = css(color); ctx.fillStyle = css(color); ctx.lineWidth = 3 * scale; ctx.beginPath();
      ctx.moveTo(cx + ux * (rad - 4 * scale), cx + uy * (rad - 4 * scale)); ctx.lineTo(cx + ux * (rad + 0 * scale + 14 * scale), cx + uy * (rad + 14 * scale)); ctx.stroke();
      ctx.font = `600 ${13 * scale}px ${FONT}`; ctx.textAlign = ux > 0.3 ? "left" : ux < -0.3 ? "right" : "center";
      ctx.fillText(label, cx + ux * (rad - 26 * scale), cx + uy * (rad - 26 * scale) + (uy > 0.5 ? 4 * scale : uy < -0.5 ? 2 * scale : 0));
    };
    tick(S[1], S[0], "accent", "Sun"); tick(E[1], E[0], "earth-light", "Earth");
    // chosen sites that sit inside the disc
    const sites = getSites ? getSites() : [];
    ctx.lineWidth = 1.5 * scale; ctx.font = `600 ${13 * scale}px ${FONT}`;
    const lines = [];
    for (const s of sites) {
      const la = s.lat * DEG, lo = s.lon * DEG, cl = Math.cos(la), pz = Math.sin(la), k = 2 * R / (1 - pz);
      const x = k * cl * Math.sin(lo), y = k * cl * Math.cos(lo);
      const sun = skyAt(t, s.frame), up = sun.sun.el + sun.sunRadius > maskAt(s.mask, sun.sun.az) && sun.sunFraction > 0.001;
      lines.push([s, up]);
      if (x * x + y * y > HALF * HALF * 0.98) continue;
      const px = cx + x / HALF * rad, py = cx - y / HALF * rad;
      ctx.strokeStyle = css(up ? "accent" : "space-ink", up ? 1 : 0.8); ctx.beginPath(); ctx.arc(px, py, 6 * scale, 0, 7); ctx.stroke();
      const right = px < cx + rad * 0.45; ctx.textAlign = right ? "left" : "right"; ctx.fillStyle = css("space-ink");
      ctx.strokeStyle = css("space", 0.8); ctx.lineWidth = 3 * scale; ctx.strokeText(s.name, px + (right ? 11 : -11) * scale, py + 4 * scale); ctx.lineWidth = 1.5 * scale;
      ctx.fillText(s.name, px + (right ? 11 : -11) * scale, py + 4 * scale);
    }
    clock.textContent = fmt(t);
    const el = Math.asin(-S[2]) / DEG;
    const lit = lines.filter(l => l[1]).map(l => l[0].name), dark = lines.filter(l => !l[1]).map(l => l[0].name);
    read.textContent = `Sun ${Math.abs(el).toFixed(1)}° ${el >= 0 ? "above" : "below"} the horizon at the pole. ` + (lines.length ? (lit.length ? "In sunlight: " + lit.join(", ") + ". " : "No chosen site is in sunlight. ") + (dark.length ? "In shadow: " + dark.join(", ") + "." : "") : "");
    canvas.setAttribute("aria-label", `South polar terrain with real shadows, ${fmt(t)}. ${read.textContent}`);
  }
  let visible = true, stale = false;   // the disc is not redrawn while it is off screen (the ledger drag would otherwise pay for it)
  if ("IntersectionObserver" in window) new IntersectionObserver(en => { visible = en.some(e => e.isIntersecting); if (visible && stale) { stale = false; frame(); } }).observe(canvas);
  function frame() {
    if (!visible) { stale = true; return; }
    if (busy) { queued = true; return; }
    busy = true;
    requestAnimationFrame(() => { try { draw(); } finally { busy = false; if (queued) { queued = false; frame(); } } });
  }
  function moved(h, isFast) {
    hour = Math.max(0, Math.min(SPAN_H, h)); slider.value = Math.round(hour); fast = isFast; frame();
    clearTimeout(settle); if (isFast) settle = setTimeout(() => { fast = false; frame(); }, 160);
  }
  slider.max = SPAN_H; slider.value = hour;
  slider.addEventListener("input", () => moved(+slider.value, true));
  // dragging the disc scrubs time too: across the full width is about ten days
  let drag = null;
  canvas.addEventListener("pointerdown", ev => { drag = { x: ev.clientX, h: hour }; canvas.setPointerCapture(ev.pointerId); stop(); });
  canvas.addEventListener("pointermove", ev => { if (drag) moved(drag.h + (ev.clientX - drag.x) / canvas.getBoundingClientRect().width * 240, true); });
  canvas.addEventListener("pointerup", () => { drag = null; }); canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("keydown", ev => { const k = { ArrowRight: 6, ArrowLeft: -6, PageUp: 48, PageDown: -48 }[ev.key]; if (k) { ev.preventDefault(); stop(); moved(hour + k, true); } });
  function stop() { playing = false; cancelAnimationFrame(raf); play.textContent = "Play a lunar day"; }
  function tick(ts) {
    if (!playing) return;
    const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
    let h = hour + dt * 60;                       // 60 simulated hours per second: the Sun circles the horizon in about 12 s
    if (h >= SPAN_H) { moved(SPAN_H, false); return stop(); }
    moved(h, true); raf = requestAnimationFrame(tick);
  }
  play.addEventListener("click", () => {
    if (playing) return stop();
    if (hour >= SPAN_H - 1) hour = 0;
    playing = true; last = performance.now(); play.textContent = "Pause"; raf = requestAnimationFrame(tick);
  });
  new ResizeObserver(() => frame()).observe(canvas);
  const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); RELIEF = { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data }; grids.clear(); frame(); }; im.src = 'data/relief.png';
  frame();
  getTerrain().then(t => { T = t; onStatus && onStatus(""); frame(); }, e => { onStatus && onStatus("Terrain failed to load: " + e.message); });
  return {
    setBase(t) { if (t !== base) { base = t; frame(); } },
    refresh: frame,
  };
}
